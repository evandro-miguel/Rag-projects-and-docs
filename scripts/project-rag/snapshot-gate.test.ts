import { describe, expect, it } from 'vitest';
import {
  ContentHashMismatchError,
  claimSnapshot,
  claimSnapshotByUuid,
  consumeSnapshot,
  deterministicHash,
  deterministicHashJson,
  deterministicHashList,
  estimateDelta,
  failSnapshot,
  getProjectGateStatus,
  hashBlockedFindingAllowlist,
  LeaseLostError,
  prepareSnapshot,
  prepareSnapshotInTransaction,
  refreshRequiresReview,
  revalidateBaseline,
  SnapshotRescanMismatchError,
  validateBlockedFindings,
} from './snapshot-gate.js';
import type { IngestSnapshotStatus, ProjectRagPostgresIngestSnapshot } from './store.js';
import { EMPTY_ALLOWLIST_HASH } from './store.js';
import type { ProjectRagWriteSql } from './transaction.js';

// ==========================================================================
// Deterministic hash helpers (case-sensitive, raw bytes, stable sort)
// ==========================================================================

describe('deterministicHash', () => {
  it('produces a consistent SHA-256 hex string', () => {
    const hash = deterministicHash('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(deterministicHash('hello')).toBe(deterministicHash('hello'));
  });

  it('is CASE-SENSITIVE — Hello differs from hello', () => {
    // Case-sensitive raw bytes: different input = different hash
    expect(deterministicHash('Hello')).not.toBe(deterministicHash('hello'));
  });

  it('preserves case on Linux — "A" differs from "a"', () => {
    // Regression: Linux file paths are case-sensitive
    const hashUpper = deterministicHash('SRC/A.TS');
    const hashLower = deterministicHash('src/a.ts');
    expect(hashUpper).not.toBe(hashLower);
  });

  it('includes whitespace — leading/trailing spaces affect hash', () => {
    expect(deterministicHash('  hello  ')).not.toBe(deterministicHash('hello'));
  });

  it('produces different hashes for different inputs', () => {
    expect(deterministicHash('abc')).not.toBe(deterministicHash('xyz'));
  });
});

describe('deterministicHashList', () => {
  it('hashes an empty list from the empty string', () => {
    const hash = deterministicHashList([]);
    expect(hash).toHaveLength(64);
    expect(deterministicHashList([])).toBe(hash);
  });

  it('sorts by raw UTF-8 byte order (code-point stable)', () => {
    // 'A' (0x41) < 'a' (0x61) in byte order
    const hash1 = deterministicHashList(['a', 'B', 'c']);
    const hash2 = deterministicHashList(['B', 'a', 'c']);
    expect(hash1).toBe(hash2);
  });

  it('distinguishes case in list entries', () => {
    // 'SRC/A.TS' vs 'src/a.ts' — different bytes → different hash
    const hashUpper = deterministicHashList(['SRC/A.TS', 'SRC/B.TS']);
    const hashLower = deterministicHashList(['src/a.ts', 'src/b.ts']);
    expect(hashUpper).not.toBe(hashLower);
  });

  it('is deterministic for the same input list reversed', () => {
    const list = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    expect(deterministicHashList(list)).toBe(deterministicHashList([...list].reverse()));
  });
});

describe('hashBlockedFindingAllowlist', () => {
  it('hashes an empty allowlist to EMPTY_ALLOWLIST_HASH', () => {
    expect(hashBlockedFindingAllowlist([])).toBe(EMPTY_ALLOWLIST_HASH);
    expect(hashBlockedFindingAllowlist([])).toHaveLength(64);
  });

  it('is deterministic regardless of entry order', () => {
    const entries: Array<{ readonly relativePath: string; readonly category: string }> = [
      { relativePath: 'src/secret.ts', category: 'dependency_dir' },
      { relativePath: 'test/fixture', category: 'cache_dir' },
    ];
    const reversed = [...entries].reverse();
    expect(hashBlockedFindingAllowlist(entries)).toBe(hashBlockedFindingAllowlist(reversed));
  });

  it('distinguishes different entry sets', () => {
    const setA: Array<{ readonly relativePath: string; readonly category: string }> = [
      { relativePath: 'src/a.ts', category: 'dependency_dir' },
    ];
    const setB: Array<{ readonly relativePath: string; readonly category: string }> = [
      { relativePath: 'src/a.ts', category: 'cache_dir' },
    ];
    expect(hashBlockedFindingAllowlist(setA)).not.toBe(hashBlockedFindingAllowlist(setB));
  });

  it('canonicalises entry as relativePath:category', () => {
    const hash = hashBlockedFindingAllowlist([
      { relativePath: 'path/to/dir', category: 'build_dir' },
    ]);
    expect(hash).toHaveLength(64);
  });
});

describe('deterministicHashJson', () => {
  it('hashes a simple object deterministically', () => {
    const hash = deterministicHashJson({ a: 1, b: 2 });
    expect(hash).toHaveLength(64);
  });

  it('produces the same hash regardless of key order', () => {
    const hash1 = deterministicHashJson({ a: 1, b: 2, c: 3 });
    const hash2 = deterministicHashJson({ c: 3, a: 1, b: 2 });
    expect(hash1).toBe(hash2);
  });

  it('handles nested objects with key sorting', () => {
    const hash1 = deterministicHashJson({ outer: { z: 1, a: 2 } });
    const hash2 = deterministicHashJson({ outer: { a: 2, z: 1 } });
    expect(hash1).toBe(hash2);
  });

  it('handles arrays consistently', () => {
    const hash1 = deterministicHashJson([3, 1, 2]);
    const hash2 = deterministicHashJson([3, 1, 2]);
    expect(hash1).toBe(hash2);
  });

  it('handles null and primitive values', () => {
    expect(deterministicHashJson(null)).toHaveLength(64);
    expect(deterministicHashJson('string')).toHaveLength(64);
    expect(deterministicHashJson(42)).toHaveLength(64);
  });
});

// ==========================================================================
// Blocked-findings validation
// ==========================================================================

describe('validateBlockedFindings', () => {
  it('accepts valid blocked findings', () => {
    expect(() =>
      validateBlockedFindings([{ category: 'dependency_root', count: 3 }])
    ).not.toThrow();
    expect(() =>
      validateBlockedFindings([{ category: 'cache_dir', count: 1, sample: ['node_modules'] }])
    ).not.toThrow();
  });

  it('accepts an empty array', () => {
    expect(() => validateBlockedFindings([])).not.toThrow();
  });

  it('rejects missing category', () => {
    expect(() => validateBlockedFindings([{ count: 1 } as Record<string, unknown>])).toThrow(
      'category'
    );
  });

  it('rejects negative count', () => {
    expect(() => validateBlockedFindings([{ category: 'test', count: -1 }])).toThrow('count');
  });

  it('rejects sample array exceeding 10 items', () => {
    expect(() =>
      validateBlockedFindings([
        { category: 'test', count: 1, sample: Array.from({ length: 11 }, (_, i) => `p${i}`) },
      ])
    ).toThrow('max length');
  });

  it('rejects sample items longer than 200 chars', () => {
    expect(() =>
      validateBlockedFindings([{ category: 'test', count: 1, sample: ['x'.repeat(201)] }])
    ).toThrow('200');
  });
});

// ==========================================================================
// Threshold helpers
// ==========================================================================

describe('refreshRequiresReview', () => {
  const completeEvidence = 'a'.repeat(64);

  it('does not require review for arbitrarily large additions or updates', () => {
    expect(
      refreshRequiresReview({ addsCount: 10_000, updatesCount: 20_000, deletesCount: 0 })
    ).toBe(false);
  });

  it('allows arbitrarily large deletions only with complete bound evidence', () => {
    expect(
      refreshRequiresReview({
        deletesCount: 10_000,
        completenessStatus: 'complete',
        completenessEvidenceHash: completeEvidence,
        deletionAllowed: true,
      })
    ).toBe(false);
  });

  it.each([
    ['missing evidence', {}],
    ['incomplete scan', { completenessStatus: 'incomplete', deletionAllowed: true }],
    ['blocked scan', { completenessStatus: 'blocked', deletionAllowed: true }],
    [
      'deletion refused',
      {
        completenessStatus: 'complete',
        completenessEvidenceHash: completeEvidence,
        deletionAllowed: false,
      },
    ],
    [
      'invalid evidence hash',
      {
        completenessStatus: 'complete',
        completenessEvidenceHash: 'A'.repeat(64),
        deletionAllowed: true,
      },
    ],
  ] as const)('requires review for deletion without %s', (_label, evidence) => {
    expect(refreshRequiresReview({ deletesCount: 1, ...evidence })).toBe(true);
  });

  it.each([
    ['addsCount', { addsCount: -1 }],
    ['updatesCount', { updatesCount: Number.NaN }],
    ['deletesCount', { deletesCount: 1.5 }],
  ])('rejects malformed %s', (_label, counts) => {
    expect(() => refreshRequiresReview(counts)).toThrow(/non-negative integer/);
  });
});

// ==========================================================================
// Delta estimation
// ==========================================================================

describe('estimateDelta', () => {
  const trackedFiles = [
    { sourcePath: 'src/a.ts', contentHash: 'hash-a' },
    { sourcePath: 'src/b.ts', contentHash: 'hash-b' },
    { sourcePath: 'src/c.ts', contentHash: 'hash-c' },
  ];

  it('reports zero delta when tracked and candidate sets match exactly', () => {
    const delta = estimateDelta({ trackedFiles, candidateFiles: [...trackedFiles] });
    expect(delta.adds).toBe(0);
    expect(delta.updates).toBe(0);
    expect(delta.deletes).toBe(0);
    expect(delta.unchanged).toBe(3);
    expect(delta.totalDelta).toBe(0);
    expect(delta.trackedCount).toBe(3);
  });

  it('detects new files (adds)', () => {
    const delta = estimateDelta({
      trackedFiles,
      candidateFiles: [...trackedFiles, { sourcePath: 'src/d.ts', contentHash: 'hash-d' }],
    });
    expect(delta.adds).toBe(1);
    expect(delta.totalDelta).toBe(1);
  });

  it('detects deleted files', () => {
    const delta = estimateDelta({
      trackedFiles,
      candidateFiles: [trackedFiles[0], trackedFiles[1]],
    });
    expect(delta.deletes).toBe(1);
    expect(delta.totalDelta).toBe(1);
  });

  it('detects updated files (changed hash)', () => {
    const delta = estimateDelta({
      trackedFiles,
      candidateFiles: [
        { sourcePath: 'src/a.ts', contentHash: 'hash-a-new' },
        trackedFiles[1],
        trackedFiles[2],
      ],
    });
    expect(delta.updates).toBe(1);
    expect(delta.totalDelta).toBe(1);
  });

  it('detects adds, updates, and deletes simultaneously', () => {
    const delta = estimateDelta({
      trackedFiles,
      candidateFiles: [
        { sourcePath: 'src/a.ts', contentHash: 'hash-a-new' },
        trackedFiles[2],
        { sourcePath: 'src/d.ts', contentHash: 'hash-d' },
      ],
    });
    expect(delta.adds).toBe(1);
    expect(delta.updates).toBe(1);
    expect(delta.deletes).toBe(1);
    expect(delta.unchanged).toBe(1);
    expect(delta.totalDelta).toBe(3);
    expect(delta.trackedCount).toBe(3);
  });
});

// ==========================================================================
// Mock SQL helpers
// ==========================================================================

interface MockSqlResult {
  sql: Bun.SQL;
  calls: Array<{ text: string; values: unknown[] }>;
  fenceCalls: Array<{ text: string; values: unknown[] }>;
  beginTracker: { called: boolean };
}

function makeFakeSql(rows: Array<Array<Record<string, unknown>>>): MockSqlResult {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fenceCalls: Array<{ text: string; values: unknown[] }> = [];
  const beginTracker = { called: false };
  const rowCopy = rows.map((r) => [...r]);

  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!('raw' in strings)) {
      return { values: strings };
    }
    const text = strings.join('?');
    if (text.includes('pg_try_advisory_xact_lock_shared')) {
      fenceCalls.push({ text, values });
      return [{ locked: true }];
    }
    if (text.includes('select to_regclass(?) as relation')) {
      fenceCalls.push({ text, values });
      return [{ relation: 'public.rag_migration_maintenance' }];
    }
    if (text.includes('from public.rag_migration_maintenance')) {
      fenceCalls.push({ text, values });
      return [];
    }
    calls.push({ text, values });
    return rowCopy.shift() ?? [];
  }) as unknown as Bun.SQL & { begin: Bun.SQL['begin'] };

  (sql as unknown as Record<string, unknown>).begin = async <T>(
    fn: (tx: Bun.SQL) => Promise<T>
  ): Promise<T> => {
    beginTracker.called = true;
    return fn(sql as unknown as Bun.SQL);
  };

  return { sql, calls, fenceCalls, beginTracker };
}

function makeSnapshotRow(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: '1',
    snapshot_uuid: '550e8400-e29b-41d4-a716-446655440000',
    project_id: '7',
    command_scope: 'full',
    root_hash: null,
    scope_hash: null,
    policy_hash: null,
    inventory_hash: null,
    baseline_hash: null,
    plan_hash: null,
    adds_count: '0',
    updates_count: '0',
    deletes_count: '0',
    eligible_count: '0',
    tracked_count: '0',
    blocked_findings: [],
    blocked_finding_allowlist_hash:
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    suppressed_blocked_findings: [],
    status: 'PREPARED',
    failure_code: null,
    failure_detail: null,
    ttl_seconds: '300',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    lease_expires_at: null,
    claimed_at: null,
    consumed_at: null,
    failed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ==========================================================================
// Snapshot gate operations
// ==========================================================================

describe('prepareSnapshot', () => {
  it('prepares inside the caller transaction without opening a nested transaction', async () => {
    const { sql, calls } = makeFakeSql([
      [makeSnapshotRow({ status: 'PREPARED', adds_count: '1', tracked_count: '100' })],
    ]);
    const tx = Object.assign(sql, {
      begin: () => {
        throw new Error('nested transaction ownership is forbidden');
      },
    }) as unknown as ProjectRagWriteSql;

    const result = await prepareSnapshotInTransaction(tx, {
      projectId: 7,
      addsCount: 1,
      trackedCount: 100,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(calls[0]?.text).toContain('insert into project_ingest_snapshots');
  });

  it('creates a PREPARED snapshot for additions regardless of cardinality', async () => {
    const { sql, calls } = makeFakeSql([
      [makeSnapshotRow({ status: 'PREPARED', adds_count: '10', tracked_count: '200' })],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      addsCount: 10,
      trackedCount: 200,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(result.thresholdResult.requiresReview).toBe(false);
    expect(result.thresholdResult.reason).toContain('refresh_safe');
    // Verify no totalDelta in SQL bind values (derived from adds+updates+deletes)
    expect(calls[0]?.text).toContain('insert into project_ingest_snapshots');
  });

  it('creates PREPARED when additions exceed the former percentage threshold', async () => {
    const { sql } = makeFakeSql([
      [makeSnapshotRow({ status: 'PREPARED', adds_count: '113', tracked_count: '449' })],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      addsCount: 113,
      trackedCount: 449,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(result.thresholdResult.requiresReview).toBe(false);
    expect(result.thresholdResult.reason).toContain('refresh_safe');
  });

  it('creates PREPARED when additions exceed the former absolute threshold', async () => {
    const { sql } = makeFakeSql([
      [makeSnapshotRow({ status: 'PREPARED', adds_count: '500', tracked_count: '5000' })],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      addsCount: 500,
      trackedCount: 5000,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(result.thresholdResult.requiresReview).toBe(false);
    expect(result.thresholdResult.reason).toContain('refresh_safe');
  });

  it('creates PREPARED when trackedCount is 0 with delta < 500', async () => {
    const { sql } = makeFakeSql([
      [makeSnapshotRow({ status: 'PREPARED', adds_count: '10', tracked_count: '0' })],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      addsCount: 10,
      trackedCount: 0,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(result.thresholdResult.requiresReview).toBe(false);
    expect(result.thresholdResult.reason).toContain('refresh_safe');
  });

  it('creates PREPARED for a large first addition set', async () => {
    const { sql } = makeFakeSql([
      [makeSnapshotRow({ status: 'PREPARED', adds_count: '500', tracked_count: '0' })],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      addsCount: 500,
      trackedCount: 0,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(result.thresholdResult.requiresReview).toBe(false);
    expect(result.thresholdResult.reason).toContain('refresh_safe');
  });

  it('prepares a large cleanup only with complete evidence', async () => {
    const { sql } = makeFakeSql([
      [
        makeSnapshotRow({
          status: 'PREPARED',
          adds_count: '5',
          updates_count: '3',
          deletes_count: '500',
          tracked_count: '200',
        }),
      ],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      addsCount: 5,
      updatesCount: 3,
      deletesCount: 500,
      trackedCount: 200,
      completenessStatus: 'complete',
      completenessEvidenceHash: 'a'.repeat(64),
      deletionAllowed: true,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(result.thresholdResult.requiresReview).toBe(false);
    expect(result.thresholdResult.reason).toContain('deletion_evidence_bound');
  });

  it('prepares a targeted update while retaining unrelated deletion counts', async () => {
    const { sql } = makeFakeSql([
      [
        makeSnapshotRow({
          command_scope: 'file',
          status: 'PREPARED',
          adds_count: '0',
          updates_count: '1',
          deletes_count: '1',
          tracked_count: '2',
        }),
      ],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      commandScope: 'file',
      addsCount: 0,
      updatesCount: 1,
      deletesCount: 1,
      trackedCount: 2,
      completenessStatus: 'incomplete',
      completenessEvidenceHash: 'b'.repeat(64),
      deletionAllowed: false,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(result.thresholdResult.requiresReview).toBe(false);
    expect(result.thresholdResult.reason).toContain('refresh_safe');
  });

  it('requires review for deletions without complete evidence', async () => {
    const { sql } = makeFakeSql([
      [makeSnapshotRow({ status: 'REVIEW_REQUIRED', deletes_count: '1', tracked_count: '200' })],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      deletesCount: 1,
      trackedCount: 200,
    });

    expect(result.snapshot.status).toBe('REVIEW_REQUIRED');
    expect(result.thresholdResult.requiresReview).toBe(true);
    expect(result.thresholdResult.reason).toContain('deletion_evidence_required');
  });

  it('creates FAILED when blocked findings are present', async () => {
    const { sql, calls } = makeFakeSql([
      [
        makeSnapshotRow({
          status: 'FAILED',
          failure_code: 'BLOCKED_ROOT_FINDINGS',
          adds_count: '0',
          tracked_count: '200',
        }),
      ],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      addsCount: 0,
      trackedCount: 200,
      blockedFindings: [{ category: 'dependency_root', count: 3 }],
    });

    expect(result.snapshot.status).toBe('FAILED');
    expect(result.snapshot.failureCode).toBe('BLOCKED_ROOT_FINDINGS');
    expect(result.thresholdResult.reason).toContain('blocked_findings');
    // Verify failure_code in insert bind values
    expect(calls[0]?.values).toContain('BLOCKED_ROOT_FINDINGS');
  });

  it('throws when blocked findings have invalid format', async () => {
    const { sql } = makeFakeSql([[]]);

    await expect(
      prepareSnapshot(sql, {
        projectId: 7,
        blockedFindings: [{ count: 1 } as Record<string, unknown>],
      })
    ).rejects.toThrow('category');
  });

  it('forwards non-empty blockedFindingAllowlistHash and suppressedBlockedFindings', async () => {
    const allowlistHash = 'a1'.repeat(32);
    const suppressed = [
      {
        relativePath: 'scripts/eval/fixture/dist',
        category: 'build_dir',
        matchedAllowlistEntry: {
          relativePath: 'scripts/eval/fixture/dist',
          category: 'build_dir',
        },
      },
    ];
    const { sql, calls } = makeFakeSql([
      [
        makeSnapshotRow({
          status: 'PREPARED',
          blocked_finding_allowlist_hash: allowlistHash,
          suppressed_blocked_findings: suppressed,
          adds_count: '1',
          tracked_count: '100',
        }),
      ],
    ]);

    const result = await prepareSnapshot(sql, {
      projectId: 7,
      addsCount: 1,
      trackedCount: 100,
      blockedFindingAllowlistHash: allowlistHash,
      suppressedBlockedFindings: suppressed,
    });

    expect(result.snapshot.status).toBe('PREPARED');
    expect(result.snapshot.blockedFindingAllowlistHash).toBe(allowlistHash);
    expect(result.snapshot.suppressedBlockedFindings).toEqual(suppressed);
    expect(allowlistHash).not.toBe(EMPTY_ALLOWLIST_HASH);
    expect(calls[0]?.values).toContain(allowlistHash);
    const suppressedBind = calls[0]?.values.find(
      (v) => typeof v === 'string' && v.includes('scripts/eval/fixture/dist')
    );
    expect(suppressedBind).toBeDefined();
  });
});

describe('claimSnapshot', () => {
  it('claims a PREPARED unexpired snapshot by id', async () => {
    const { sql, calls } = makeFakeSql([[makeSnapshotRow({ status: 'CONSUMING' })]]);

    const snapshot = await claimSnapshot(sql, 7, 1);

    expect(snapshot?.status).toBe('CONSUMING');
    expect(calls[0]?.text).toContain('set status');
    expect(calls[0]?.text).toContain("'CONSUMING'");
    expect(calls[0]?.text).toContain('lease_expires_at');
    expect(calls[0]?.values).toContain(1);
    expect(calls[0]?.values).toContain(7);
  });

  it('claims by snapshot UUID', async () => {
    const { sql, calls } = makeFakeSql([[makeSnapshotRow({ status: 'CONSUMING' })]]);

    const snapshot = await claimSnapshotByUuid(sql, 7, '550e8400-e29b-41d4-a716-446655440000');

    expect(snapshot?.status).toBe('CONSUMING');
    expect(calls[0]?.text).toContain('snapshot_uuid');
    expect(calls[0]?.values).toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns undefined when claim fails (no matching row)', async () => {
    const { sql } = makeFakeSql([[]]);

    const snapshot = await claimSnapshot(sql, 7, 1);
    expect(snapshot).toBeUndefined();
  });

  it('returns undefined on cross-project mismatch', async () => {
    // Different project_id → no row matched
    const { sql } = makeFakeSql([[]]);
    const snapshot = await claimSnapshot(sql, 8, 1);
    expect(snapshot).toBeUndefined();
  });

  it('returns undefined on same-snapshot replay (already CONSUMING)', async () => {
    // Already consumed — no row matched by WHERE status='PREPARED'
    const { sql } = makeFakeSql([[]]);
    const snapshot = await claimSnapshot(sql, 7, 1);
    expect(snapshot).toBeUndefined();
  });

  it('returns undefined on SQLSTATE 23505 contention (simulated)', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
      if (!('raw' in strings)) {
        return { values: strings };
      }
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('pg_try_advisory_xact_lock_shared')) {
        return [{ locked: true }];
      }
      if (text.includes('select to_regclass(?) as relation')) {
        return [{ relation: 'public.rag_migration_maintenance' }];
      }
      if (text.includes('from public.rag_migration_maintenance')) {
        return [];
      }
      const err = new Error('duplicate key') as Error & { code?: string };
      err.code = '23505';
      throw err;
    }) as unknown as Bun.SQL;
    (
      sql as unknown as {
        begin: (fn: (tx: Bun.TransactionSQL) => Promise<unknown>) => Promise<unknown>;
      }
    ).begin = (fn) => fn(sql as unknown as Bun.TransactionSQL);

    (sql as unknown as Record<string, unknown>).begin = async <T>(
      fn: (tx: Bun.SQL) => Promise<T>
    ): Promise<T> => fn(sql);

    const snapshot = await claimSnapshot(sql, 7, 1);
    expect(snapshot).toBeUndefined();
  });
});

describe('consumeSnapshot', () => {
  it('completes a CONSUMING snapshot', async () => {
    const { sql, calls } = makeFakeSql([
      [makeSnapshotRow({ status: 'CONSUMED', consumed_at: new Date().toISOString() })],
    ]);

    const snapshot = await consumeSnapshot(sql, 7, 1, '550e8400-e29b-41d4-a716-446655440000');

    expect(snapshot?.status).toBe('CONSUMED');
    expect(snapshot?.consumedAt).toBeTruthy();
    expect(calls[0]?.text).toContain("set status = 'CONSUMED'");
    expect(calls[0]?.text).toContain("status = 'CONSUMING'");
    expect(calls[0]?.values).toContain(1);
    expect(calls[0]?.values).toContain(7);
  });

  it('returns undefined when snapshot is not CONSUMING', async () => {
    const { sql } = makeFakeSql([[]]);
    const snapshot = await consumeSnapshot(sql, 7, 1, '550e8400-e29b-41d4-a716-446655440000');
    expect(snapshot).toBeUndefined();
  });
});

describe('failSnapshot', () => {
  it('fails a CONSUMING snapshot with a code and detail', async () => {
    const { sql, calls } = makeFakeSql([
      [makeSnapshotRow({ status: 'FAILED', failure_code: 'RESCAN_MISMATCH' })],
    ]);

    const snapshot = await failSnapshot(sql, 7, 1, 'RESCAN_MISMATCH');

    expect(snapshot?.status).toBe('FAILED');
    expect(snapshot?.failureCode).toBe('RESCAN_MISMATCH');
    // Verify SQL shape
    expect(calls[0]?.text).toContain("set status = 'FAILED'");
    expect(calls[0]?.values).toContain('RESCAN_MISMATCH');
    expect(calls[0]?.values).toContain(1);
    expect(calls[0]?.values).toContain(7);
  });
});

describe('revalidateBaseline', () => {
  it('returns match when BOTH inventoryHash and baselineHash match', async () => {
    const { sql } = makeFakeSql([
      [
        makeSnapshotRow({
          inventory_hash: 'inv-abc',
          baseline_hash: 'base-abc',
          root_hash: 'root-abc',
          scope_hash: 'scope-abc',
          policy_hash: 'policy-abc',
          plan_hash: 'plan-abc',
        }),
      ],
    ]);

    const result = await revalidateBaseline(
      sql,
      7,
      1,
      'inv-abc',
      'base-abc',
      'plan-abc',
      'scope-abc',
      'root-abc',
      'policy-abc',
      EMPTY_ALLOWLIST_HASH
    );
    expect(result.matches).toBe(true);
    expect(result.mismatchedFields).toEqual([]);
    expect(result.snapshot).toBeDefined();
  });

  it('returns mismatch when inventoryHash differs', async () => {
    const { sql } = makeFakeSql([
      [
        makeSnapshotRow({
          inventory_hash: 'inv-abc',
          baseline_hash: 'base-abc',
          root_hash: 'root-abc',
          scope_hash: 'scope-abc',
          policy_hash: 'policy-abc',
          plan_hash: 'plan-abc',
        }),
      ],
    ]);

    const result = await revalidateBaseline(
      sql,
      7,
      1,
      'inv-xyz',
      'base-abc',
      'plan-abc',
      'scope-abc',
      'root-abc',
      'policy-abc',
      EMPTY_ALLOWLIST_HASH
    );
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain('inventory_hash');
    expect(result.mismatchedFields).not.toContain('baseline_hash');
  });

  it('returns mismatch when baselineHash differs', async () => {
    const { sql } = makeFakeSql([
      [
        makeSnapshotRow({
          inventory_hash: 'inv-abc',
          baseline_hash: 'base-abc',
          root_hash: 'root-abc',
          scope_hash: 'scope-abc',
          policy_hash: 'policy-abc',
          plan_hash: 'plan-abc',
        }),
      ],
    ]);

    const result = await revalidateBaseline(
      sql,
      7,
      1,
      'inv-abc',
      'base-xyz',
      'plan-abc',
      'scope-abc',
      'root-abc',
      'policy-abc',
      EMPTY_ALLOWLIST_HASH
    );
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain('baseline_hash');
  });

  it('returns mismatch when both hashes differ', async () => {
    const { sql } = makeFakeSql([
      [
        makeSnapshotRow({
          inventory_hash: 'inv-abc',
          baseline_hash: 'base-abc',
          root_hash: 'root-abc',
          scope_hash: 'scope-abc',
          policy_hash: 'policy-abc',
          plan_hash: 'plan-abc',
        }),
      ],
    ]);

    const result = await revalidateBaseline(
      sql,
      7,
      1,
      'inv-xyz',
      'base-xyz',
      'plan-abc',
      'scope-abc',
      'root-abc',
      'policy-abc',
      EMPTY_ALLOWLIST_HASH
    );
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain('inventory_hash');
    expect(result.mismatchedFields).toContain('baseline_hash');
  });

  it('validates planHash and scopeHash', async () => {
    const row = makeSnapshotRow({
      inventory_hash: 'inv-a',
      baseline_hash: 'base-a',
      plan_hash: 'plan-a',
      scope_hash: 'scope-a',
      root_hash: 'root-a',
      policy_hash: 'policy-a',
    });

    // First call: match
    const { sql: sql1 } = makeFakeSql([[{ ...row }]]);
    const result = await revalidateBaseline(
      sql1,
      7,
      1,
      'inv-a',
      'base-a',
      'plan-a',
      'scope-a',
      'root-a',
      'policy-a',
      EMPTY_ALLOWLIST_HASH
    );
    expect(result.matches).toBe(true);

    // Second call: wrong plan
    const { sql: sql2 } = makeFakeSql([[{ ...row }]]);
    const result2 = await revalidateBaseline(
      sql2,
      7,
      1,
      'inv-a',
      'base-a',
      'plan-wrong',
      'scope-a',
      'root-a',
      'policy-a',
      EMPTY_ALLOWLIST_HASH
    );
    expect(result2.matches).toBe(false);
    expect(result2.mismatchedFields).toContain('plan_hash');
  });

  it('detects root_hash mismatch', async () => {
    const row = makeSnapshotRow({
      root_hash: 'root-abc',
      inventory_hash: 'inv-a',
      baseline_hash: 'base-a',
      plan_hash: 'plan-a',
      scope_hash: 'scope-a',
      policy_hash: 'policy-a',
    });
    const { sql } = makeFakeSql([[{ ...row }]]);
    const result = await revalidateBaseline(
      sql,
      7,
      1,
      'inv-a',
      'base-a',
      'plan-a',
      'scope-a',
      'root-xyz', // different root hash
      'policy-a',
      EMPTY_ALLOWLIST_HASH
    );
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain('root_hash');
  });

  it('detects policy_hash mismatch', async () => {
    const row = makeSnapshotRow({
      policy_hash: 'policy-abc',
      inventory_hash: 'inv-a',
      baseline_hash: 'base-a',
      plan_hash: 'plan-a',
      scope_hash: 'scope-a',
      root_hash: 'root-a',
    });
    const { sql } = makeFakeSql([[{ ...row }]]);
    const result = await revalidateBaseline(
      sql,
      7,
      1,
      'inv-a',
      'base-a',
      'plan-a',
      'scope-a',
      'root-a',
      'policy-xyz', // different policy hash
      EMPTY_ALLOWLIST_HASH
    );
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain('policy_hash');
  });

  it('detects blocked_finding_allowlist_hash mismatch', async () => {
    const row = makeSnapshotRow({
      blocked_finding_allowlist_hash: 'abc123',
      inventory_hash: 'inv-a',
      baseline_hash: 'base-a',
      plan_hash: 'plan-a',
      scope_hash: 'scope-a',
      root_hash: 'root-a',
      policy_hash: 'policy-a',
    });
    const { sql } = makeFakeSql([[{ ...row }]]);
    const result = await revalidateBaseline(
      sql,
      7,
      1,
      'inv-a',
      'base-a',
      'plan-a',
      'scope-a',
      'root-a',
      'policy-a',
      'different-hash' // different allowlist hash
    );
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain('blocked_finding_allowlist_hash');
  });

  it('returns undefined snapshot when not found', async () => {
    const { sql } = makeFakeSql([[]]);
    const result = await revalidateBaseline(
      sql,
      7,
      999,
      'a',
      'b',
      'p',
      's',
      'r',
      'po',
      EMPTY_ALLOWLIST_HASH
    );
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toEqual(['snapshot_not_found']);
    expect(result.snapshot).toBeUndefined();
  });
});

// ==========================================================================
// Typed error classes (no string-prefix classification)
// ==========================================================================

describe('LeaseLostError', () => {
  it('has stable error code SNAPSHOT_LEASE_LOST', () => {
    const err = new LeaseLostError(42, 'test detail');
    expect(err.code).toBe('SNAPSHOT_LEASE_LOST');
    expect(err.name).toBe('LeaseLostError');
    expect(err.message).toContain('id=42');
    expect(err.message).toContain('test detail');
  });

  it('is instanceof Error', () => {
    expect(new LeaseLostError(1, 'x')).toBeInstanceOf(Error);
  });
});

describe('SnapshotRescanMismatchError', () => {
  it('has stable error code SNAPSHOT_RESCAN_MISMATCH', () => {
    const err = new SnapshotRescanMismatchError(['inventory_hash'], false, 'detail');
    expect(err.code).toBe('SNAPSHOT_RESCAN_MISMATCH');
    expect(err.name).toBe('SnapshotRescanMismatchError');
    expect(err.mismatchedFields).toEqual(['inventory_hash']);
    expect(err.statusChanged).toBe(false);
    expect(err.message).toContain('detail');
  });

  it('carries statusChanged flag', () => {
    const err = new SnapshotRescanMismatchError(['plan_hash'], true, 'threshold changed');
    expect(err.statusChanged).toBe(true);
  });

  it('is instanceof Error', () => {
    expect(new SnapshotRescanMismatchError([], false, 'x')).toBeInstanceOf(Error);
  });
});

describe('ContentHashMismatchError', () => {
  it('has stable error code CONTENT_HASH_MISMATCH', () => {
    const err = new ContentHashMismatchError(
      'src/mod.ts',
      'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      'deadbeef7890abcdef1234567890abcdef1234567890abcdef1234567890abcd'
    );
    expect(err.code).toBe('CONTENT_HASH_MISMATCH');
    expect(err.name).toBe('ContentHashMismatchError');
    expect(err.sourcePath).toBe('src/mod.ts');
    expect(err.expectedHash).toContain('abcdef');
    expect(err.actualHash).toContain('deadbeef');
    expect(err.message).toContain("Content hash mismatch for 'src/mod.ts'");
  });

  it('is instanceof Error and not confused with other error types', () => {
    const err = new ContentHashMismatchError('x.ts', 'a', 'b');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ContentHashMismatchError);
    // Must NOT be instanceof SnapshotRescanMismatchError or LeaseLostError
    expect(err).not.toBeInstanceOf(SnapshotRescanMismatchError);
    expect(err).not.toBeInstanceOf(LeaseLostError);
  });

  it('altered message does not contain the old prefix string', () => {
    const err = new ContentHashMismatchError('src/x.ts', 'aaa', 'bbb');
    // Old code matched on 'content_hash_mismatch:' prefix — the new class
    // message starts with 'Content hash mismatch for' (capital C, no colon)
    expect(err.message).not.toMatch(/^content_hash_mismatch:/);
    expect(err.message).toMatch(/^Content hash mismatch for/);
    // A naive message-startsWith('content_hash_mismatch:') would NOT match
    expect(err.message.startsWith('content_hash_mismatch:')).toBe(false);
  });
});

describe('getProjectGateStatus', () => {
  function snapshot(status: IngestSnapshotStatus): ProjectRagPostgresIngestSnapshot {
    return {
      id: 1,
      snapshotUuid: '550e8400-e29b-41d4-a716-446655440000',
      projectId: 7,
      commandScope: 'full',
      rootHash: null,
      scopeHash: null,
      policyHash: null,
      inventoryHash: null,
      baselineHash: null,
      planHash: null,
      repositoryHash: null,
      workspaceHash: null,
      headHash: null,
      branchHash: null,
      detachedHash: null,
      contentHash: null,
      indexProfileHash: null,
      rootManifestHash: null,
      completenessStatus: null,
      completenessEvidenceHash: null,
      deletionAllowed: null,
      addsCount: 0,
      updatesCount: 0,
      deletesCount: 0,
      eligibleCount: 0,
      trackedCount: 0,
      blockedFindings: [],
      blockedFindingAllowlistHash:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      suppressedBlockedFindings: [],
      status,
      failureCode: null,
      failureDetail: null,
      ttlSeconds: 300,
      expiresAt: new Date().toISOString(),
      leaseExpiresAt: null,
      claimedAt: null,
      consumedAt: null,
      failedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it('returns idle when no snapshots exist', () => {
    expect(getProjectGateStatus([])).toBe('idle');
  });

  it('returns consuming when a CONSUMING snapshot is present', () => {
    expect(getProjectGateStatus([snapshot('CONSUMING')])).toBe('consuming');
  });

  it('returns prepared when a PREPARED snapshot exists', () => {
    expect(getProjectGateStatus([snapshot('PREPARED')])).toBe('prepared');
  });

  it('returns review_required when REVIEW_REQUIRED is present', () => {
    expect(getProjectGateStatus([snapshot('REVIEW_REQUIRED')])).toBe('review_required');
  });

  it('returns prepared even when older terminal snapshots exist', () => {
    expect(
      getProjectGateStatus([snapshot('PREPARED'), snapshot('CONSUMED'), snapshot('FAILED')])
    ).toBe('prepared');
  });

  it('returns consuming when CONSUMING exists alongside PREPARED', () => {
    expect(getProjectGateStatus([snapshot('CONSUMING'), snapshot('PREPARED')])).toBe('consuming');
  });

  it('returns blocked when only FAILED or EXPIRED snapshots exist', () => {
    expect(getProjectGateStatus([snapshot('FAILED')])).toBe('blocked');
    expect(getProjectGateStatus([snapshot('EXPIRED')])).toBe('blocked');
  });
});
