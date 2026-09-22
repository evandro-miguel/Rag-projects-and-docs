import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshotReviewToken,
  QUALIFIED_REVIEWER_CAPABILITY,
  type SnapshotReviewTokenPayload,
} from './snapshot-review.js';

const mockAssertSchemaReady = vi.fn();
const mockFindSnapshot = vi.fn();
const mockInsertReview = vi.fn();
const mockFindSnapshotByExternalUuid = vi.fn();
const mockFindSnapshotReview = vi.fn();
const mockInsertDecision = vi.fn();
const mockRejectSnapshot = vi.fn();
const mockRuntimeLstat = vi.fn();
const mockRuntimeReadFile = vi.fn();
const mockRuntimeOpen = vi.fn();

vi.mock('node:fs/promises', () => ({ lstat: mockRuntimeLstat, open: mockRuntimeOpen }));

vi.mock('./store.js', () => ({
  assertProjectRagPostgresSnapshotReviewSchemaReady: mockAssertSchemaReady,
  findProjectRagPostgresIngestSnapshotByExternalUuid: mockFindSnapshotByExternalUuid,
  findProjectRagPostgresIngestSnapshotByUuid: mockFindSnapshot,
  findProjectRagPostgresSnapshotReview: mockFindSnapshotReview,
  insertProjectRagPostgresSnapshotReviewDecision: mockInsertDecision,
  insertProjectRagPostgresSnapshotReview: mockInsertReview,
  rejectProjectRagPostgresIngestSnapshotReview: mockRejectSnapshot,
}));

const {
  approveProjectRagIngestSnapshot,
  approveProjectRagIngestSnapshotFromOperatorRuntime,
  deferProjectRagIngestSnapshotReview,
  deferProjectRagIngestSnapshotReviewFromOperatorRuntime,
  auditProjectRagIngestSnapshot,
  inspectProjectRagIngestSnapshot,
  rejectProjectRagIngestSnapshotReview,
  rejectProjectRagIngestSnapshotReviewFromOperatorRuntime,
  resumeProjectRagIngestSnapshot,
} = await import('./snapshot-review-service.js');
type SnapshotReviewOperatorRuntimeRequest =
  import('./snapshot-review-service.js').SnapshotReviewOperatorRuntimeRequest;

const SIGNING_KEY = 'snapshot-review-service-test-key-with-32-bytes';
const SNAPSHOT_UUID = 'e4353cc3-d12d-4a57-af28-75ec3392fd92';
const operator = { id: 'trusted-operator-fixture', authentication: 'trusted-runtime' } as const;
const operatorKeyPair = generateKeyPairSync('ed25519');
const operatorPublicKey = operatorKeyPair.publicKey
  .export({ format: 'pem', type: 'spki' })
  .toString();

function signedOperatorAssertion(
  request: {
    readonly action: SnapshotReviewOperatorRuntimeRequest['action'];
    readonly snapshotUuid: string;
    readonly reviewTokenDigest: string;
  },
  operatorId: string = operator.id
): string {
  return JSON.stringify({ assertion: signedOperatorAssertionToken(request, operatorId) });
}

function signedOperatorAssertionToken(
  request: {
    readonly action: SnapshotReviewOperatorRuntimeRequest['action'];
    readonly snapshotUuid: string;
    readonly reviewTokenDigest: string;
  },
  operatorId: string = operator.id
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    operatorId,
    action: request.action,
    snapshotUuid: request.snapshotUuid,
    reviewTokenDigest: request.reviewTokenDigest,
    issuedAt: now - 1,
    expiresAt: now + 60,
  };
  const unsigned = `v1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  return `${unsigned}.${sign(null, Buffer.from(unsigned, 'utf8'), operatorKeyPair.privateKey).toString('base64url')}`;
}

function makeAuditSql(rows: {
  review?: Record<string, unknown>;
  decisions?: Array<Record<string, unknown>>;
}): Bun.SQL {
  return ((strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('project_ingest_snapshot_reviews')) {
      return rows.review ? [rows.review] : [];
    }
    return rows.decisions ?? [];
  }) as unknown as Bun.SQL;
}

function makePayload(overrides: Partial<SnapshotReviewTokenPayload> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    snapshotUuid: SNAPSHOT_UUID,
    projectId: 2329,
    commandScope: 'full',
    reviewerId: 'qualified-reviewer-fixture',
    capability: QUALIFIED_REVIEWER_CAPABILITY,
    evidenceId: 'E-review-service-01',
    reason: 'Reviewed exact inventory binding.',
    issuedAt: now - 1,
    expiresAt: now + 300,
    ...overrides,
  } satisfies SnapshotReviewTokenPayload;
}

describe('snapshot review service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntimeLstat.mockResolvedValue({
      isDirectory: () => true,
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o100644,
    });
    mockRuntimeReadFile.mockResolvedValue(
      JSON.stringify({
        socketPath: '/run/rag-review.sock',
        publicKeyPem: operatorPublicKey,
        responseTimeoutMs: 100,
      })
    );
    mockRuntimeOpen.mockResolvedValue({
      stat: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        mode: 0o100644,
      }),
      readFile: async () => mockRuntimeReadFile(),
      close: async () => {},
    });
  });

  it('rejects caller-built trusted identities before any review write', async () => {
    const payload = makePayload();
    const token = createSnapshotReviewToken(payload, SIGNING_KEY);
    mockAssertSchemaReady.mockResolvedValue(undefined);
    mockFindSnapshot.mockResolvedValue({
      snapshotUuid: SNAPSHOT_UUID,
      projectId: 2329,
      commandScope: 'full',
      status: 'REVIEW_REQUIRED',
      expiresAt: new Date((payload.expiresAt + 10) * 1000),
    });
    mockInsertReview.mockResolvedValue({
      snapshotUuid: SNAPSHOT_UUID,
      projectId: 2329,
      reviewerId: payload.reviewerId,
      reviewerCapability: payload.capability,
      evidenceId: payload.evidenceId,
      commandScope: payload.commandScope,
      expiresAt: new Date(payload.expiresAt * 1000),
    });

    await expect(
      approveProjectRagIngestSnapshot({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
        authenticatedOperator: operator,
      })
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });
    expect(mockInsertReview).not.toHaveBeenCalled();
  });

  it('rejects a token presented for another UUID before insertion', async () => {
    const token = createSnapshotReviewToken(makePayload(), SIGNING_KEY);
    await expect(
      approveProjectRagIngestSnapshot(
        {} as Bun.SQL,
        '540a3018-f9ff-48c7-9e41-3ac8aa15da84',
        token,
        { signingKey: SIGNING_KEY, authenticatedOperator: operator }
      )
    ).rejects.toThrow('does not match the requested snapshot');
    expect(mockInsertReview).not.toHaveBeenCalled();
  });

  it('rejects non-REVIEW_REQUIRED snapshots and does not insert', async () => {
    const payload = makePayload();
    const token = createSnapshotReviewToken(payload, SIGNING_KEY);
    mockFindSnapshot.mockResolvedValue({
      snapshotUuid: SNAPSHOT_UUID,
      projectId: 2329,
      commandScope: 'full',
      status: 'PREPARED',
      expiresAt: new Date((payload.expiresAt + 10) * 1000),
    });
    await expect(
      approveProjectRagIngestSnapshot({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
        authenticatedOperator: operator,
      })
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });
    expect(mockInsertReview).not.toHaveBeenCalled();
  });

  it('refuses approval with no authenticated operator or a reviewer as operator', async () => {
    const payload = makePayload();
    const token = createSnapshotReviewToken(payload, SIGNING_KEY);
    await expect(
      approveProjectRagIngestSnapshot({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
      })
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });
    await expect(
      approveProjectRagIngestSnapshot({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
        authenticatedOperator: { id: payload.reviewerId, authentication: 'trusted-runtime' },
      })
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });
  });

  it('approves only with a runtime-signed, token-digest-bound operator assertion', async () => {
    const payload = makePayload();
    const token = createSnapshotReviewToken(payload, SIGNING_KEY);
    mockAssertSchemaReady.mockResolvedValue(undefined);
    mockFindSnapshot.mockResolvedValue({
      snapshotUuid: SNAPSHOT_UUID,
      projectId: 2329,
      commandScope: 'full',
      status: 'REVIEW_REQUIRED',
      expiresAt: new Date((payload.expiresAt + 10) * 1000),
    });
    mockInsertReview.mockResolvedValue({ snapshotUuid: SNAPSHOT_UUID });

    await expect(
      approveProjectRagIngestSnapshotFromOperatorRuntime({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
        requestAssertion: async (request) => signedOperatorAssertion(request),
      })
    ).resolves.toMatchObject({ snapshotUuid: SNAPSHOT_UUID });
    expect(mockInsertReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operatorId: operator.id })
    );
  });

  it('settles a complete socket response before a synchronous close event', async () => {
    const payload = makePayload();
    const token = createSnapshotReviewToken(payload, SIGNING_KEY);
    mockAssertSchemaReady.mockResolvedValue(undefined);
    mockFindSnapshot.mockResolvedValue({
      snapshotUuid: SNAPSHOT_UUID,
      projectId: 2329,
      commandScope: 'full',
      status: 'REVIEW_REQUIRED',
      expiresAt: new Date((payload.expiresAt + 10) * 1000),
    });
    mockInsertReview.mockResolvedValue({ snapshotUuid: SNAPSHOT_UUID });

    const connect = vi.fn((options: any) => {
      const socket = {
        write(frame: string) {
          const request = JSON.parse(frame.trim()) as SnapshotReviewOperatorRuntimeRequest;
          options.socket.data(socket, Buffer.from(`${signedOperatorAssertion(request)}\n`));
        },
        end() {
          options.socket.close(socket);
        },
      };
      options.socket.open(socket);
      return Promise.resolve(socket);
    });
    vi.stubGlobal('Bun', { connect });

    try {
      await expect(
        approveProjectRagIngestSnapshotFromOperatorRuntime({} as Bun.SQL, SNAPSHOT_UUID, token, {
          signingKey: SIGNING_KEY,
        })
      ).resolves.toMatchObject({ snapshotUuid: SNAPSHOT_UUID });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects runtime responses that are not the exact bounded assertion envelope', async () => {
    const token = createSnapshotReviewToken(makePayload(), SIGNING_KEY);
    const responses: Array<(request: SnapshotReviewOperatorRuntimeRequest) => string> = [
      (request) => signedOperatorAssertionToken(request),
      () => '{"assertion":',
      (request) =>
        JSON.stringify({ assertion: signedOperatorAssertionToken(request), extra: true }),
      () => JSON.stringify({ assertion: '' }),
      () => JSON.stringify({ assertion: 'x'.repeat(16 * 1024) }),
    ];

    for (const makeResponse of responses) {
      await expect(
        approveProjectRagIngestSnapshotFromOperatorRuntime({} as Bun.SQL, SNAPSHOT_UUID, token, {
          signingKey: SIGNING_KEY,
          requestAssertion: async (request) => makeResponse(request),
        })
      ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_OPERATOR_RUNTIME_UNAVAILABLE' });
    }
    expect(mockInsertReview).not.toHaveBeenCalled();
  });

  it('refuses an absent runtime or a runtime assertion from the token reviewer', async () => {
    const payload = makePayload();
    const token = createSnapshotReviewToken(payload, SIGNING_KEY);
    mockRuntimeReadFile.mockRejectedValueOnce(new Error('missing'));
    await expect(
      approveProjectRagIngestSnapshotFromOperatorRuntime({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
      })
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_OPERATOR_RUNTIME_UNAVAILABLE' });
    await expect(
      approveProjectRagIngestSnapshotFromOperatorRuntime({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
        requestAssertion: async (request) => signedOperatorAssertion(request, payload.reviewerId),
      })
    ).rejects.toThrow('self-approval is forbidden');
    await expect(
      approveProjectRagIngestSnapshotFromOperatorRuntime({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
        requestAssertion: async (request) =>
          signedOperatorAssertion({ ...request, reviewTokenDigest: '0'.repeat(64) }),
      })
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_OPERATOR_RUNTIME_UNAVAILABLE' });
    expect(mockInsertReview).not.toHaveBeenCalled();
  });

  it('bounds a nonresponsive operator runtime before any approval write', async () => {
    const token = createSnapshotReviewToken(makePayload(), SIGNING_KEY);
    mockRuntimeReadFile.mockResolvedValueOnce(
      JSON.stringify({
        socketPath: '/run/rag-review.sock',
        publicKeyPem: operatorPublicKey,
        responseTimeoutMs: 100,
      })
    );
    await expect(
      approveProjectRagIngestSnapshotFromOperatorRuntime({} as Bun.SQL, SNAPSHOT_UUID, token, {
        signingKey: SIGNING_KEY,
        requestAssertion: async () => new Promise<string>(() => {}),
      })
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_OPERATOR_RUNTIME_UNAVAILABLE' });
    expect(mockInsertReview).not.toHaveBeenCalled();
  });

  it('inspects without identity and refuses self-asserted defer or reject', async () => {
    mockFindSnapshotByExternalUuid.mockResolvedValue({ snapshotUuid: SNAPSHOT_UUID });
    await expect(
      inspectProjectRagIngestSnapshot({} as Bun.SQL, SNAPSHOT_UUID)
    ).resolves.toMatchObject({
      snapshotUuid: SNAPSHOT_UUID,
    });
    await expect(
      deferProjectRagIngestSnapshotReview({} as Bun.SQL, SNAPSHOT_UUID, 'wait', undefined)
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });
    await expect(
      rejectProjectRagIngestSnapshotReview({} as Bun.SQL, SNAPSHOT_UUID, 'reject', undefined)
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });
    expect(mockInsertDecision).not.toHaveBeenCalled();
    expect(mockRejectSnapshot).not.toHaveBeenCalled();
  });

  it('rejects caller-built identities for defer and reject audit paths', async () => {
    mockInsertDecision.mockResolvedValue({ decision: 'DEFERRED' });
    mockRejectSnapshot.mockResolvedValue({ status: 'FAILED', failureCode: 'REVIEW_REJECTED' });
    await expect(
      deferProjectRagIngestSnapshotReview({} as Bun.SQL, SNAPSHOT_UUID, 'wait', operator)
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });
    await expect(
      rejectProjectRagIngestSnapshotReview({} as Bun.SQL, SNAPSHOT_UUID, 'reject', operator)
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });
    expect(mockInsertDecision).not.toHaveBeenCalled();
    expect(mockRejectSnapshot).not.toHaveBeenCalled();
  });

  it('defers and rejects only through a runtime-bound operator assertion', async () => {
    mockAssertSchemaReady.mockResolvedValue(undefined);
    mockInsertDecision.mockResolvedValue({
      snapshotUuid: SNAPSHOT_UUID,
      decision: 'DEFERRED',
      operatorId: operator.id,
    });
    mockRejectSnapshot.mockResolvedValue({
      snapshotUuid: SNAPSHOT_UUID,
      status: 'FAILED',
      failureCode: 'REVIEW_REJECTED',
    });

    await expect(
      deferProjectRagIngestSnapshotReviewFromOperatorRuntime(
        {} as Bun.SQL,
        SNAPSHOT_UUID,
        'Wait for a fresh preflight.',
        { requestAssertion: async (request) => signedOperatorAssertion(request) }
      )
    ).resolves.toMatchObject({ decision: 'DEFERRED', operatorId: operator.id });
    await expect(
      rejectProjectRagIngestSnapshotReviewFromOperatorRuntime(
        {} as Bun.SQL,
        SNAPSHOT_UUID,
        'Reject stale inventory.',
        { requestAssertion: async (request) => signedOperatorAssertion(request) }
      )
    ).resolves.toMatchObject({ status: 'FAILED', failureCode: 'REVIEW_REJECTED' });
    expect(mockInsertDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operatorId: operator.id, reason: 'Wait for a fresh preflight.' })
    );
    expect(mockRejectSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operatorId: operator.id, reason: 'Reject stale inventory.' })
    );
  });

  it('audits immutable review history without exposing the token digest', async () => {
    mockAssertSchemaReady.mockResolvedValue(undefined);
    mockFindSnapshotByExternalUuid.mockResolvedValue({
      id: 41,
      snapshotUuid: SNAPSHOT_UUID,
      projectId: 2329,
      status: 'FAILED',
    });
    const audited = await auditProjectRagIngestSnapshot(
      makeAuditSql({
        review: {
          id: '7',
          snapshot_id: '41',
          snapshot_uuid: SNAPSHOT_UUID,
          project_id: '2329',
          reviewer_id: 'qualified-reviewer-fixture',
          operator_id: operator.id,
          reviewer_capability: QUALIFIED_REVIEWER_CAPABILITY,
          evidence_id: 'E-review-service-01',
          reason: 'Approved exact inventory.',
          command_scope: 'full',
          approved_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          created_at: new Date().toISOString(),
        },
        decisions: [
          {
            id: '8',
            snapshot_id: '41',
            snapshot_uuid: SNAPSHOT_UUID,
            project_id: '2329',
            decision: 'DEFERRED',
            operator_id: operator.id,
            reason: 'Re-preflight first.',
            decided_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      }),
      SNAPSHOT_UUID
    );
    expect(audited).toMatchObject({
      snapshot: { snapshotUuid: SNAPSHOT_UUID },
      review: { snapshotUuid: SNAPSHOT_UUID, operatorId: operator.id },
      decisions: [{ decision: 'DEFERRED', operatorId: operator.id }],
    });
    expect(audited?.review).not.toHaveProperty('tokenDigest');
  });

  it('reports resume readiness only for a live approved review and requires fresh preflight', async () => {
    mockAssertSchemaReady.mockResolvedValue(undefined);
    mockFindSnapshotByExternalUuid.mockResolvedValue({
      id: 41,
      snapshotUuid: SNAPSHOT_UUID,
      projectId: 2329,
      status: 'REVIEW_REQUIRED',
    });
    mockFindSnapshotReview.mockResolvedValue({
      snapshotUuid: SNAPSHOT_UUID,
      projectId: 2329,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(
      resumeProjectRagIngestSnapshot({} as Bun.SQL, SNAPSHOT_UUID)
    ).resolves.toMatchObject({
      requiresFreshPreflight: true,
      review: { snapshotUuid: SNAPSHOT_UUID },
    });

    mockFindSnapshotReview.mockResolvedValue(undefined);
    await expect(resumeProjectRagIngestSnapshot({} as Bun.SQL, SNAPSHOT_UUID)).rejects.toThrow(
      'no current qualified review'
    );
  });
});
