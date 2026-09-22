import { createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  type SnapshotReviewTokenPayload,
  snapshotReviewTokenDigest,
  verifySnapshotReviewToken,
} from './snapshot-review.js';
import {
  assertProjectRagPostgresSnapshotReviewSchemaReady,
  findProjectRagPostgresIngestSnapshotByExternalUuid,
  findProjectRagPostgresIngestSnapshotByUuid,
  findProjectRagPostgresSnapshotReview,
  insertProjectRagPostgresSnapshotReview,
  insertProjectRagPostgresSnapshotReviewDecision,
  type ProjectRagPostgresIngestSnapshot,
  type ProjectRagPostgresSnapshotReview,
  type ProjectRagPostgresSnapshotReviewDecision,
  rejectProjectRagPostgresIngestSnapshotReview,
} from './store.js';

export interface SnapshotReviewApprovalOptions {
  readonly signingKey?: string;
  readonly nowSeconds?: number;
  /** Internal-only verified assertion; raw caller identity is rejected. */
  readonly authenticatedOperator?: unknown;
}

export interface SnapshotReviewAuthenticatedOperator {
  /** Populated only by a trusted authenticated runtime boundary. */
  readonly id: string;
  readonly authentication: 'trusted-runtime';
}

const OPERATOR_RUNTIME_PROTOCOL = 'project-rag-snapshot-operator-v1';
const OPERATOR_ASSERTION_VERSION = 'v1';
const MAX_OPERATOR_RUNTIME_FRAME_BYTES = 16 * 1024;
const MAX_OPERATOR_ASSERTION_TTL_SECONDS = 300;
const OPERATOR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TRUSTED_OPERATOR_RUNTIME_CONFIG = '/etc/rag-v2/project-rag-snapshot-operator-runtime.json';
const DEFAULT_OPERATOR_RUNTIME_TIMEOUT_MS = 5_000;
const verifiedOperatorMarker = Symbol('verifiedOperatorRuntimeAssertion');

interface VerifiedSnapshotReviewOperator extends SnapshotReviewAuthenticatedOperator {
  readonly [verifiedOperatorMarker]: true;
}

export type SnapshotReviewOperatorRuntimeAction =
  | 'approve_snapshot_review'
  | 'defer_snapshot_review'
  | 'reject_snapshot_review';

export interface SnapshotReviewOperatorRuntimeRequest {
  readonly protocol: typeof OPERATOR_RUNTIME_PROTOCOL;
  readonly action: SnapshotReviewOperatorRuntimeAction;
  readonly snapshotUuid: string;
  readonly reviewTokenDigest: string;
}

export interface SnapshotReviewOperatorRuntimeOptions {
  readonly nowSeconds?: number;
  readonly requestAssertion?: (request: SnapshotReviewOperatorRuntimeRequest) => Promise<string>;
}

interface TrustedOperatorRuntimeConfig {
  readonly socketPath: string;
  readonly publicKeyPem: string;
  readonly responseTimeoutMs: number;
}

export class SnapshotReviewOperatorRuntimeError extends Error {
  readonly code = 'SNAPSHOT_REVIEW_OPERATOR_RUNTIME_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'SnapshotReviewOperatorRuntimeError';
  }
}

export class SnapshotReviewAuthenticationError extends Error {
  readonly code = 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Snapshot review mutation requires a trusted authenticated operator identity');
    this.name = 'SnapshotReviewAuthenticationError';
  }
}

function authenticatedOperatorId(operator: unknown): string {
  if (!operator || typeof operator !== 'object') {
    throw new SnapshotReviewAuthenticationError();
  }
  const candidate = operator as Partial<SnapshotReviewAuthenticatedOperator> & {
    readonly [verifiedOperatorMarker]?: unknown;
  };
  if (
    candidate.authentication !== 'trusted-runtime' ||
    candidate[verifiedOperatorMarker] !== true ||
    typeof candidate.id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate.id)
  ) {
    throw new SnapshotReviewAuthenticationError();
  }
  return candidate.id;
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function parseOperatorRuntimeResponse(response: unknown): string {
  if (typeof response !== 'string') {
    throw new SnapshotReviewOperatorRuntimeError(
      'Operator runtime returned an invalid response envelope'
    );
  }
  if (Buffer.byteLength(response, 'utf8') > MAX_OPERATOR_RUNTIME_FRAME_BYTES) {
    throw new SnapshotReviewOperatorRuntimeError('Operator runtime returned no bounded response');
  }
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    throw new SnapshotReviewOperatorRuntimeError(
      'Operator runtime returned a malformed response envelope'
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotReviewOperatorRuntimeError(
      'Operator runtime returned an invalid response envelope'
    );
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 1 ||
    keys[0] !== 'assertion' ||
    typeof candidate.assertion !== 'string' ||
    candidate.assertion.trim().length === 0
  ) {
    throw new SnapshotReviewOperatorRuntimeError(
      'Operator runtime returned an invalid response envelope'
    );
  }
  return candidate.assertion;
}

function parseOperatorAssertion(
  assertion: string,
  publicKeyPem: string,
  request: SnapshotReviewOperatorRuntimeRequest,
  nowSeconds: number
): VerifiedSnapshotReviewOperator {
  const parts = assertion.split('.');
  if (parts.length !== 3 || parts[0] !== OPERATOR_ASSERTION_VERSION) {
    throw new SnapshotReviewOperatorRuntimeError(
      'Operator runtime returned an invalid signed assertion'
    );
  }
  const unsignedAssertion = `${parts[0]}.${parts[1]}`;
  let payload: unknown;
  let signature: Buffer;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
    signature = decodeBase64Url(parts[2]);
  } catch {
    throw new SnapshotReviewOperatorRuntimeError('Operator runtime returned a malformed assertion');
  }
  try {
    if (
      !verify(
        null,
        Buffer.from(unsignedAssertion, 'utf8'),
        createPublicKey(publicKeyPem),
        signature
      )
    ) {
      throw new SnapshotReviewOperatorRuntimeError(
        'Operator runtime assertion signature is invalid'
      );
    }
  } catch (error) {
    if (error instanceof SnapshotReviewOperatorRuntimeError) {
      throw error;
    }
    throw new SnapshotReviewOperatorRuntimeError(
      'Configured operator runtime public key is invalid'
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SnapshotReviewOperatorRuntimeError('Operator runtime assertion payload is invalid');
  }
  const candidate = payload as Record<string, unknown>;
  const issuedAt = candidate.issuedAt;
  const expiresAt = candidate.expiresAt;
  if (
    typeof issuedAt !== 'number' ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt)
  ) {
    throw new SnapshotReviewOperatorRuntimeError(
      'Operator runtime assertion is invalid, expired, or unbound'
    );
  }
  const expectedKeys = [
    'action',
    'expiresAt',
    'issuedAt',
    'operatorId',
    'reviewTokenDigest',
    'snapshotUuid',
  ];
  if (
    Object.keys(candidate).sort().join(',') !== expectedKeys.join(',') ||
    candidate.action !== request.action ||
    candidate.snapshotUuid !== request.snapshotUuid ||
    candidate.reviewTokenDigest !== request.reviewTokenDigest ||
    typeof candidate.operatorId !== 'string' ||
    !OPERATOR_ID_PATTERN.test(candidate.operatorId) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_OPERATOR_ASSERTION_TTL_SECONDS ||
    expiresAt <= nowSeconds ||
    issuedAt > nowSeconds + 60
  ) {
    throw new SnapshotReviewOperatorRuntimeError(
      'Operator runtime assertion is invalid, expired, or unbound'
    );
  }
  return {
    id: candidate.operatorId,
    authentication: 'trusted-runtime',
    [verifiedOperatorMarker]: true,
  };
}

async function requestOperatorRuntimeAssertion(
  socketPath: string,
  request: SnapshotReviewOperatorRuntimeRequest,
  responseTimeoutMs: number
): Promise<string> {
  if (!isAbsolute(socketPath)) {
    throw new SnapshotReviewOperatorRuntimeError('Operator runtime socket path must be absolute');
  }
  return new Promise((resolve, reject) => {
    let response = '';
    let settled = false;
    let connection: { end(): void } | undefined;
    const timer = setTimeout(() => {
      settle(new SnapshotReviewOperatorRuntimeError('Operator runtime response timed out'));
      connection?.end();
    }, responseTimeoutMs);
    const settle = (result: string | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(result);
      }
    };
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          connection = socket;
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(socket, data) {
          response += Buffer.from(data).toString('utf8');
          const newline = response.indexOf('\n');
          const responseBytes = Buffer.byteLength(response, 'utf8');
          if (responseBytes > MAX_OPERATOR_RUNTIME_FRAME_BYTES || newline < 0) {
            if (responseBytes > MAX_OPERATOR_RUNTIME_FRAME_BYTES) {
              settle(
                new SnapshotReviewOperatorRuntimeError(
                  'Operator runtime returned no bounded response'
                )
              );
              socket.end();
            }
            return;
          }
          settle(response.slice(0, newline));
          socket.end();
        },
        error(_socket, error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        },
        close() {
          if (!settled) {
            settle(
              new SnapshotReviewOperatorRuntimeError('Configured operator runtime is unavailable')
            );
          }
        },
      },
    }).catch(() =>
      settle(new SnapshotReviewOperatorRuntimeError('Configured operator runtime is unavailable'))
    );
  });
}

async function loadTrustedOperatorRuntimeConfig(): Promise<TrustedOperatorRuntimeConfig> {
  const parents: string[] = [];
  for (let current = dirname(TRUSTED_OPERATOR_RUNTIME_CONFIG); ; current = dirname(current)) {
    parents.push(current);
    if (current === '/') break;
  }
  try {
    for (const parent of parents) {
      const stat = await lstat(parent);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0
      ) {
        throw new SnapshotReviewOperatorRuntimeError(
          'Trusted operator runtime config has an unsafe parent directory'
        );
      }
    }
  } catch (error) {
    if (error instanceof SnapshotReviewOperatorRuntimeError) throw error;
    throw new SnapshotReviewOperatorRuntimeError(
      'Trusted operator runtime config has an unsafe parent directory'
    );
  }
  let stat: Awaited<ReturnType<typeof lstat>>;
  let raw: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(TRUSTED_OPERATOR_RUNTIME_CONFIG, constants.O_RDONLY | constants.O_NOFOLLOW);
    [stat, raw] = await Promise.all([handle.stat(), handle.readFile({ encoding: 'utf8' })]);
  } catch {
    throw new SnapshotReviewOperatorRuntimeError(
      `Trusted operator runtime config is unavailable at ${TRUSTED_OPERATOR_RUNTIME_CONFIG}`
    );
  } finally {
    await handle?.close();
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new SnapshotReviewOperatorRuntimeError(
      'Trusted operator runtime config must be root-owned and not group/other writable'
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SnapshotReviewOperatorRuntimeError('Trusted operator runtime config is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotReviewOperatorRuntimeError('Trusted operator runtime config is invalid');
  }
  const config = value as Record<string, unknown>;
  const timeout = config.responseTimeoutMs ?? DEFAULT_OPERATOR_RUNTIME_TIMEOUT_MS;
  if (
    Object.keys(config).sort().join(',') !== 'publicKeyPem,responseTimeoutMs,socketPath' ||
    typeof config.socketPath !== 'string' ||
    !isAbsolute(config.socketPath) ||
    typeof config.publicKeyPem !== 'string' ||
    config.publicKeyPem.length === 0 ||
    typeof timeout !== 'number' ||
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    timeout > 30_000
  )
    throw new SnapshotReviewOperatorRuntimeError('Trusted operator runtime config is invalid');
  return {
    socketPath: config.socketPath,
    publicKeyPem: config.publicKeyPem,
    responseTimeoutMs: timeout,
  };
}

async function authenticatedOperatorFromRuntime(
  request: SnapshotReviewOperatorRuntimeRequest,
  options: SnapshotReviewOperatorRuntimeOptions
): Promise<SnapshotReviewAuthenticatedOperator> {
  const config = await loadTrustedOperatorRuntimeConfig();
  const requestAssertion =
    options.requestAssertion ??
    ((value: SnapshotReviewOperatorRuntimeRequest) =>
      requestOperatorRuntimeAssertion(config.socketPath, value, config.responseTimeoutMs));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      requestAssertion(request),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () =>
            reject(new SnapshotReviewOperatorRuntimeError('Operator runtime response timed out')),
          config.responseTimeoutMs
        );
      }),
    ]);
    const assertion = parseOperatorRuntimeResponse(response);
    return parseOperatorAssertion(
      assertion,
      config.publicKeyPem,
      request,
      options.nowSeconds ?? Math.floor(Date.now() / 1000)
    );
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

function epochSeconds(value: Date | string): number {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error('Snapshot review refused: snapshot expiry is invalid');
  }
  return Math.floor(milliseconds / 1000);
}

function assertTokenMatchesSnapshot(
  payload: SnapshotReviewTokenPayload,
  snapshot: {
    readonly snapshotUuid: string;
    readonly projectId: number;
    readonly commandScope: string;
    readonly status: string;
    readonly expiresAt: Date | string;
  }
): void {
  if (snapshot.snapshotUuid !== payload.snapshotUuid || snapshot.projectId !== payload.projectId) {
    throw new Error('Snapshot review refused: token is bound to a different project or snapshot');
  }
  if (snapshot.status !== 'REVIEW_REQUIRED') {
    throw new Error(
      `Snapshot review refused: snapshot status is ${snapshot.status}, expected REVIEW_REQUIRED`
    );
  }
  if (snapshot.commandScope !== payload.commandScope) {
    throw new Error('Snapshot review refused: token command scope does not match the snapshot');
  }
  if (payload.expiresAt > epochSeconds(snapshot.expiresAt)) {
    throw new Error('Snapshot review refused: token outlives the snapshot TTL');
  }
}

const SNAPSHOT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_REVIEW_REASON_MAX_LENGTH = 1024;
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`
);

function assertSnapshotUuid(snapshotUuid: string): void {
  if (typeof snapshotUuid !== 'string' || !SNAPSHOT_UUID_PATTERN.test(snapshotUuid)) {
    throw new Error('Snapshot review refused: snapshot UUID is invalid');
  }
}

function normalizeDecisionReason(reason: string): string {
  if (typeof reason !== 'string') {
    throw new Error('Snapshot review decision refused: reason is required');
  }
  const normalized = reason.trim();
  if (normalized.length === 0 || normalized.length > SNAPSHOT_REVIEW_REASON_MAX_LENGTH) {
    throw new Error(
      `Snapshot review decision refused: reason must be 1-${SNAPSHOT_REVIEW_REASON_MAX_LENGTH} characters`
    );
  }
  if (CONTROL_CHAR_PATTERN.test(normalized)) {
    throw new Error('Snapshot review decision refused: reason contains control characters');
  }
  return normalized;
}

export type SnapshotReviewAuditRecord = Omit<ProjectRagPostgresSnapshotReview, 'tokenDigest'>;

export interface SnapshotReviewAudit {
  readonly snapshot: ProjectRagPostgresIngestSnapshot;
  readonly review?: SnapshotReviewAuditRecord;
  readonly decisions: readonly ProjectRagPostgresSnapshotReviewDecision[];
}

export interface SnapshotReviewResumeReadiness {
  readonly snapshot: ProjectRagPostgresIngestSnapshot;
  readonly review: ProjectRagPostgresSnapshotReview;
  /** Resuming always requires a new preflight/revalidation before claim. */
  readonly requiresFreshPreflight: true;
}

function numericAuditField(row: Record<string, unknown>, field: string): number {
  const value = typeof row[field] === 'number' ? row[field] : Number(row[field]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Snapshot review audit refused: invalid ${field}`);
  }
  return value;
}

function stringAuditField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Snapshot review audit refused: invalid ${field}`);
  }
  return value;
}

function dateAuditField(row: Record<string, unknown>, field: string): Date | string {
  const value = row[field];
  if (value instanceof Date) return value;
  if (typeof value === 'string' && Number.isFinite(new Date(value).getTime())) return value;
  throw new Error(`Snapshot review audit refused: invalid ${field}`);
}

function auditReviewFromRow(row: Record<string, unknown>): SnapshotReviewAuditRecord {
  return {
    id: numericAuditField(row, 'id'),
    snapshotId: numericAuditField(row, 'snapshot_id'),
    snapshotUuid: stringAuditField(row, 'snapshot_uuid'),
    projectId: numericAuditField(row, 'project_id'),
    reviewerId: stringAuditField(row, 'reviewer_id'),
    operatorId: stringAuditField(row, 'operator_id'),
    reviewerCapability: stringAuditField(row, 'reviewer_capability'),
    evidenceId: stringAuditField(row, 'evidence_id'),
    reason: stringAuditField(row, 'reason'),
    commandScope: stringAuditField(row, 'command_scope'),
    approvedAt: dateAuditField(row, 'approved_at'),
    expiresAt: dateAuditField(row, 'expires_at'),
    createdAt: dateAuditField(row, 'created_at'),
  };
}

function auditDecisionFromRow(
  row: Record<string, unknown>
): ProjectRagPostgresSnapshotReviewDecision {
  const decision = stringAuditField(row, 'decision');
  if (decision !== 'REJECTED' && decision !== 'DEFERRED') {
    throw new Error('Snapshot review audit refused: invalid decision');
  }
  return {
    id: numericAuditField(row, 'id'),
    snapshotId: numericAuditField(row, 'snapshot_id'),
    snapshotUuid: stringAuditField(row, 'snapshot_uuid'),
    projectId: numericAuditField(row, 'project_id'),
    decision,
    operatorId: stringAuditField(row, 'operator_id'),
    reason: stringAuditField(row, 'reason'),
    decidedAt: dateAuditField(row, 'decided_at'),
    createdAt: dateAuditField(row, 'created_at'),
  };
}

/**
 * Persist one qualified, signed approval for a live REVIEW_REQUIRED snapshot.
 * The token is verified before the database mutation and only its digest is
 * retained in the audit row.
 */
export async function approveProjectRagIngestSnapshot(
  sql: Bun.SQL,
  snapshotUuid: string,
  token: string,
  options: SnapshotReviewApprovalOptions = {}
): Promise<ProjectRagPostgresSnapshotReview> {
  assertSnapshotUuid(snapshotUuid);
  await assertProjectRagPostgresSnapshotReviewSchemaReady(sql);
  const payload = verifySnapshotReviewToken(
    token,
    options.signingKey ?? process.env.PROJECT_RAG_SNAPSHOT_REVIEW_SIGNING_KEY,
    options.nowSeconds
  );
  if (payload.snapshotUuid !== snapshotUuid) {
    throw new Error('Snapshot review refused: token UUID does not match the requested snapshot');
  }
  const operatorId = authenticatedOperatorId(options.authenticatedOperator);
  if (operatorId === payload.reviewerId) {
    const error = new Error('Snapshot review self-approval is forbidden');
    error.name = 'SnapshotReviewSelfApprovalError';
    throw error;
  }

  const snapshot = await findProjectRagPostgresIngestSnapshotByUuid(
    sql,
    payload.projectId,
    payload.snapshotUuid
  );
  if (!snapshot) {
    throw new Error('Snapshot review refused: snapshot was not found for the token project');
  }
  assertTokenMatchesSnapshot(payload, snapshot);

  return insertProjectRagPostgresSnapshotReview(sql, {
    snapshotUuid: payload.snapshotUuid,
    projectId: payload.projectId,
    reviewerId: payload.reviewerId,
    operatorId,
    reviewerCapability: payload.capability,
    evidenceId: payload.evidenceId,
    reason: payload.reason,
    commandScope: payload.commandScope,
    tokenDigest: snapshotReviewTokenDigest(token),
    expiresAt: new Date(payload.expiresAt * 1000).toISOString(),
  });
}

/**
 * Approve through a separately configured authenticated operator runtime.
 * The CLI never accepts an operator id: the runtime signs a short-lived,
 * token-digest-bound assertion which is verified with its public key.
 */
export async function approveProjectRagIngestSnapshotFromOperatorRuntime(
  sql: Bun.SQL,
  snapshotUuid: string,
  token: string,
  options: SnapshotReviewApprovalOptions & SnapshotReviewOperatorRuntimeOptions = {}
): Promise<ProjectRagPostgresSnapshotReview> {
  assertSnapshotUuid(snapshotUuid);
  const reviewToken = verifySnapshotReviewToken(
    token,
    options.signingKey ?? process.env.PROJECT_RAG_SNAPSHOT_REVIEW_SIGNING_KEY,
    options.nowSeconds
  );
  if (reviewToken.snapshotUuid !== snapshotUuid) {
    throw new Error('Snapshot review refused: token UUID does not match the requested snapshot');
  }
  const authenticatedOperator = await authenticatedOperatorFromRuntime(
    {
      protocol: OPERATOR_RUNTIME_PROTOCOL,
      action: 'approve_snapshot_review',
      snapshotUuid,
      reviewTokenDigest: snapshotReviewTokenDigest(token),
    },
    options
  );
  return approveProjectRagIngestSnapshot(sql, snapshotUuid, token, {
    signingKey: options.signingKey,
    nowSeconds: options.nowSeconds,
    authenticatedOperator,
  });
}

/** Read-only operator inspection; no caller identity is needed. */
export async function inspectProjectRagIngestSnapshot(
  sql: Bun.SQL,
  snapshotUuid: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  assertSnapshotUuid(snapshotUuid);
  await assertProjectRagPostgresSnapshotReviewSchemaReady(sql);
  return findProjectRagPostgresIngestSnapshotByExternalUuid(sql, snapshotUuid);
}

/** Keep the immutable snapshot blocked and record why it was deferred. */
export async function deferProjectRagIngestSnapshotReview(
  sql: Bun.SQL,
  snapshotUuid: string,
  reason: string,
  operator: SnapshotReviewAuthenticatedOperator | undefined
): Promise<ProjectRagPostgresSnapshotReviewDecision> {
  assertSnapshotUuid(snapshotUuid);
  const normalizedReason = normalizeDecisionReason(reason);
  const operatorId = authenticatedOperatorId(operator);
  await assertProjectRagPostgresSnapshotReviewSchemaReady(sql);
  return insertProjectRagPostgresSnapshotReviewDecision(sql, {
    snapshotUuid,
    decision: 'DEFERRED',
    operatorId,
    reason: normalizedReason,
  });
}

/** Terminally reject the exact snapshot and record the authenticated operator. */
export async function rejectProjectRagIngestSnapshotReview(
  sql: Bun.SQL,
  snapshotUuid: string,
  reason: string,
  operator: SnapshotReviewAuthenticatedOperator | undefined
): Promise<ProjectRagPostgresIngestSnapshot> {
  assertSnapshotUuid(snapshotUuid);
  const normalizedReason = normalizeDecisionReason(reason);
  const operatorId = authenticatedOperatorId(operator);
  await assertProjectRagPostgresSnapshotReviewSchemaReady(sql);
  return rejectProjectRagPostgresIngestSnapshotReview(sql, {
    snapshotUuid,
    operatorId,
    reason: normalizedReason,
  });
}

/** Defer through the protected operator runtime; no caller-supplied identity is accepted. */
export async function deferProjectRagIngestSnapshotReviewFromOperatorRuntime(
  sql: Bun.SQL,
  snapshotUuid: string,
  reason: string,
  options: SnapshotReviewOperatorRuntimeOptions = {}
): Promise<ProjectRagPostgresSnapshotReviewDecision> {
  assertSnapshotUuid(snapshotUuid);
  const authenticatedOperator = await authenticatedOperatorFromRuntime(
    {
      protocol: OPERATOR_RUNTIME_PROTOCOL,
      action: 'defer_snapshot_review',
      snapshotUuid,
      reviewTokenDigest: '',
    },
    options
  );
  return deferProjectRagIngestSnapshotReview(sql, snapshotUuid, reason, authenticatedOperator);
}

/** Reject through the protected operator runtime; no caller-supplied identity is accepted. */
export async function rejectProjectRagIngestSnapshotReviewFromOperatorRuntime(
  sql: Bun.SQL,
  snapshotUuid: string,
  reason: string,
  options: SnapshotReviewOperatorRuntimeOptions = {}
): Promise<ProjectRagPostgresIngestSnapshot> {
  assertSnapshotUuid(snapshotUuid);
  const authenticatedOperator = await authenticatedOperatorFromRuntime(
    {
      protocol: OPERATOR_RUNTIME_PROTOCOL,
      action: 'reject_snapshot_review',
      snapshotUuid,
      reviewTokenDigest: '',
    },
    options
  );
  return rejectProjectRagIngestSnapshotReview(sql, snapshotUuid, reason, authenticatedOperator);
}

/**
 * Read the complete immutable review history for one snapshot. Token material
 * is intentionally excluded from the returned approval record.
 */
export async function auditProjectRagIngestSnapshot(
  sql: Bun.SQL,
  snapshotUuid: string
): Promise<SnapshotReviewAudit | undefined> {
  assertSnapshotUuid(snapshotUuid);
  await assertProjectRagPostgresSnapshotReviewSchemaReady(sql);
  const snapshot = await findProjectRagPostgresIngestSnapshotByExternalUuid(sql, snapshotUuid);
  if (!snapshot) return undefined;

  const reviewRows = (await sql`
    select r.id, r.snapshot_id, r.snapshot_uuid, r.project_id,
      r.reviewer_id, r.operator_id, r.reviewer_capability, r.evidence_id,
      r.reason, r.command_scope, r.approved_at, r.expires_at, r.created_at
    from project_ingest_snapshot_reviews r
    where r.snapshot_id = ${snapshot.id}
      and r.snapshot_uuid = ${snapshot.snapshotUuid}::uuid
      and r.project_id = ${snapshot.projectId}
    order by r.approved_at desc, r.id desc
    limit 1
  `) as Array<Record<string, unknown>>;
  const decisionRows = (await sql`
    select d.id, d.snapshot_id, d.snapshot_uuid, d.project_id,
      d.decision, d.operator_id, d.reason, d.decided_at, d.created_at
    from project_ingest_snapshot_review_decisions d
    where d.snapshot_id = ${snapshot.id}
      and d.snapshot_uuid = ${snapshot.snapshotUuid}::uuid
      and d.project_id = ${snapshot.projectId}
    order by d.decided_at asc, d.id asc
  `) as Array<Record<string, unknown>>;

  return {
    snapshot,
    review: reviewRows[0] ? auditReviewFromRow(reviewRows[0]) : undefined,
    decisions: decisionRows.map(auditDecisionFromRow),
  };
}

/**
 * Validate that an approved snapshot may be continued. This is deliberately
 * read-only: the caller must run a fresh preflight and then use the atomic
 * claim/revalidate path before any mutation begins.
 */
export async function resumeProjectRagIngestSnapshot(
  sql: Bun.SQL,
  snapshotUuid: string
): Promise<SnapshotReviewResumeReadiness | undefined> {
  assertSnapshotUuid(snapshotUuid);
  await assertProjectRagPostgresSnapshotReviewSchemaReady(sql);
  const snapshot = await findProjectRagPostgresIngestSnapshotByExternalUuid(sql, snapshotUuid);
  if (!snapshot) return undefined;
  if (snapshot.status !== 'REVIEW_REQUIRED') {
    throw new Error(
      `Snapshot resume refused: snapshot status is ${snapshot.status}, expected REVIEW_REQUIRED`
    );
  }
  const review = await findProjectRagPostgresSnapshotReview(
    sql,
    snapshot.projectId,
    snapshot.snapshotUuid
  );
  if (!review) {
    throw new Error(
      'Snapshot resume refused: no current qualified review exists; create a fresh snapshot'
    );
  }
  return { snapshot, review, requiresFreshPreflight: true };
}
