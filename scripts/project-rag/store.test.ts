import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { calculateProjectContentHash } from '../lib/project-content-hash.js';
import {
  assertProjectRagPostgresAllowlistSchemaReady,
  assertProjectRagPostgresIndexBuildSchemaReady,
  assertProjectRagPostgresJobLifecycleSchemaReady,
  assertProjectRagPostgresReadSchemaReady,
  assertProjectRagPostgresSchemaReady,
  assertProjectRagPostgresSnapshotSchemaReady,
  assertProjectRagPostgresSyncRunBindingSchemaReady,
  type BlockedFindingAllowlistEntry,
  blockProjectRagJobForReview,
  cancelProjectRagJob,
  checkpointProjectRagJob,
  claimProjectRagJob,
  claimProjectRagPostgresIngestSnapshot,
  claimProjectRagPostgresIngestSnapshotByUuid,
  closeProjectRagPostgresSql,
  completeProjectRagPostgresIngest,
  consumeProjectRagPostgresIngestSnapshot,
  countProjectRagPostgresProjects,
  createProjectRagPostgresSql,
  deleteProjectRagPostgresFile,
  deleteStaleProjectRagPostgresFiles,
  enqueueProjectRagJob,
  failProjectRagJob,
  failProjectRagPostgresIngestSnapshot,
  findProjectRagPostgresHealthSample,
  findProjectRagPostgresIngestSnapshot,
  findProjectRagPostgresIngestSnapshotByUuid,
  findProjectRagPostgresProject,
  findProjectRagPostgresSymbols,
  finishProjectRagJob,
  garbageCollectProjectRagPostgresIndexBuilds,
  getProjectRagPostgresFeatureHubs,
  getProjectRagPostgresFileOutline,
  getProjectRagPostgresFileWithChunks,
  getProjectRagPostgresInvariantReport,
  getProjectRagPostgresNavigationPaths,
  getProjectRagPostgresProjectStats,
  getProjectRagPostgresSemanticClusters,
  getProjectRagPostgresServingState,
  getProjectRagPostgresTopicGroups,
  insertProjectRagPostgresEdge,
  insertProjectRagPostgresIngestSnapshot,
  insertProjectRagPostgresSymbol,
  insertProjectRagPostgresSyncRunInTransaction,
  listProjectRagPostgresChunkEmbeddingCandidates,
  listProjectRagPostgresFileStates,
  listProjectRagPostgresIngestSnapshots,
  listProjectRagPostgresProjects,
  PROJECT_RAG_JOB_RESULT_MAX_BYTES,
  PROJECT_RAG_JOB_RESULT_MAX_DEPTH,
  PROJECT_RAG_JOB_RESULT_MAX_ITEMS,
  promoteProjectRagPostgresFileVersions,
  publishProjectRagPostgresIndexBuild,
  recoverStaleProjectRagJobs,
  renewProjectRagJobLease,
  renewProjectRagPostgresIngestSnapshotLease,
  repairProjectRagPostgresFileVersions,
  replaceProjectRagPostgresFileChunks,
  replaceProjectRagPostgresFileChunksInTransaction,
  replaceProjectRagPostgresFileEdges,
  replaceProjectRagPostgresFileSymbols,
  resolveProjectRagPostgresEdgeTargets,
  resumeProjectRagJob,
  SNAPSHOT_SCHEMA_COLUMNS,
  searchProjectRagPostgresChunks,
  sweepStaleProjectRagPostgresIngestSnapshots,
  sweepStaleProjectRagPostgresIngestSnapshotsInTransaction,
  upsertProjectRagPostgresChunkEmbedding1024,
  upsertProjectRagPostgresFile,
  upsertProjectRagPostgresFileWithChunks,
  upsertProjectRagPostgresRepository,
  validateRepositoryAllowlist,
  validateSuppressedBlockedFindings,
  withProjectRagJobFence,
  writePublishedProjectRagIndexBuildInTransaction,
} from './store.js';

function fakeSql(
  rows: Array<Array<Record<string, unknown>>>,
  readSchemaRows: Array<Record<string, unknown>> = [
    { migration010Ready: true, migration011Ready: true },
  ],
  jobSchemaRows: Array<Record<string, unknown>> = [{ ready: true }]
) {
  const calls: Array<{ readonly text: string; readonly values: unknown[] }> = [];
  const fenceCalls: Array<{ readonly text: string; readonly values: unknown[] }> = [];
  const schemaCalls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
  const executionOrder: string[] = [];
  const beginTracker = { called: false };

  const sql = (async (strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
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
    if (text.includes('migration010Ready')) {
      return readSchemaRows;
    }
    if (text.includes('project_jobs_status_check')) {
      return jobSchemaRows;
    }
    executionOrder.push('recovery');
    calls.push({ text, values });
    return rows.shift() ?? [];
  }) as unknown as Bun.TransactionSQL & { begin: Bun.SQL['begin'] };

  (
    sql as unknown as {
      unsafe: (
        text: string,
        values?: readonly unknown[]
      ) => Promise<Array<Record<string, unknown>>>;
    }
  ).unsafe = async (text, values = []) => {
    if (text.includes('project_jobs_status_check')) {
      executionOrder.push('readiness');
      schemaCalls.push({ text, values });
      return jobSchemaRows;
    }
    executionOrder.push('sql');
    calls.push({ text, values: [...values] });
    return rows.shift() ?? [];
  };

  (sql as unknown as Record<string, unknown>).begin = async <T>(
    fn: (tx: Bun.TransactionSQL) => Promise<T>
  ): Promise<T> => {
    beginTracker.called = true;
    return fn(sql);
  };

  return { sql, calls, fenceCalls, schemaCalls, executionOrder, beginTracker };
}

describe('project-rag postgres store', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('renews a job only for its live fence token', async () => {
    const { sql, calls } = fakeSql([[{ id: 17, status: 'running', fence_token: 4 }]]);
    await renewProjectRagJobLease(sql, 17, 4, 60);
    expect(calls[0]?.text).toContain('heartbeat_at = now()');
    expect(calls[0]?.text).toContain('fence_token = ?');
    expect(calls[0]?.text).toContain('lease_expires_at > clock_timestamp()');
  });

  it('claims queued, retry-wait, and expired-running jobs with a live fence', async () => {
    const { sql, calls } = fakeSql([[{ id: 17, status: 'running', fence_token: 5 }]]);
    await expect(claimProjectRagJob(sql, 'worker-b', 30)).resolves.toMatchObject({
      id: 17,
      fenceToken: 5,
    });
    expect(calls[0]?.text).toContain("status in ('queued', 'retry-wait')");
    expect(calls[0]?.text).toContain(
      "status = 'running' and lease_expires_at <= clock_timestamp()"
    );
    expect(calls[0]?.text).toContain('for update skip locked');
    expect(calls[0]?.text).toContain('cancel_requested_at is null');
  });

  it('routes bare snapshot and job mutators through the fenced transaction owner', async () => {
    const snapshot = fakeSql([[]]);
    await expect(
      claimProjectRagPostgresIngestSnapshot(snapshot.sql, 7, 12)
    ).resolves.toBeUndefined();
    expect(snapshot.beginTracker.called).toBe(true);
    expect(snapshot.fenceCalls).toHaveLength(3);
    expect(snapshot.fenceCalls[0]?.text).toContain('pg_try_advisory_xact_lock_shared');
    expect(snapshot.fenceCalls[1]?.text).toContain('to_regclass');
    expect(snapshot.fenceCalls[2]?.text).toContain('from public.rag_migration_maintenance');

    const job = fakeSql([[]]);
    await expect(
      checkpointProjectRagJob(job.sql, 17, 4, { phase: 'chunks' })
    ).resolves.toBeUndefined();
    expect(job.beginTracker.called).toBe(true);
    expect(job.fenceCalls).toHaveLength(3);
    expect(job.fenceCalls[0]?.text).toContain('pg_try_advisory_xact_lock_shared');
    expect(job.fenceCalls[1]?.text).toContain('to_regclass');
    expect(job.fenceCalls[2]?.text).toContain('from public.rag_migration_maintenance');
  });

  it('fails closed with the migration-012 domain error before enqueue SQL', async () => {
    const { sql, calls } = fakeSql(
      [],
      [{ migration010Ready: true, migration011Ready: true }],
      [{ ready: false }]
    );

    await expect(
      enqueueProjectRagJob(sql, {
        type: 'project_ingest_full',
        payload: { rootPath: '/fixture' },
      })
    ).rejects.toThrow('Project RAG durable job lifecycle schema (migration 012) is missing');
    expect(calls).toHaveLength(0);
  });

  it('fails closed with the migration-012 domain error before claim SQL', async () => {
    const { sql, calls } = fakeSql(
      [],
      [{ migration010Ready: true, migration011Ready: true }],
      [{ ready: false }]
    );

    await expect(claimProjectRagJob(sql, 'worker-a')).rejects.toThrow(
      'Project RAG durable job lifecycle schema (migration 012) is missing'
    );
    expect(calls).toHaveLength(0);
  });

  it('checks all durable job lifecycle artifacts before queue access', async () => {
    const { sql, schemaCalls } = fakeSql(
      [],
      [{ migration010Ready: true, migration011Ready: true }],
      [{ ready: true }]
    );

    await expect(assertProjectRagPostgresJobLifecycleSchemaReady(sql)).resolves.toBeUndefined();
    const readinessSql = schemaCalls[0]?.text ?? '';
    for (const artifact of [
      'project_jobs_attempts_nonnegative',
      'project_jobs_max_attempts_positive',
      'project_jobs_status_check',
      'project_jobs_active_dedupe_idx',
      'project_jobs_claim_idx',
      'project_jobs_available_claim_idx',
      'project_jobs_recovery_idx',
    ]) {
      expect(readinessSql).toContain(artifact);
    }
  });

  const migration012ReadinessArtifacts = [
    ['attempts nonnegative constraint', 'project_jobs_attempts_nonnegative'],
    ['max attempts positive constraint', 'project_jobs_max_attempts_positive'],
    ['status lifecycle constraint', 'project_jobs_status_check'],
    ['active dedupe index', 'project_jobs_active_dedupe_idx'],
    ['claim index', 'project_jobs_claim_idx'],
    ['available claim index', 'project_jobs_available_claim_idx'],
    ['recovery index', 'project_jobs_recovery_idx'],
  ] as const;

  it.each(
    migration012ReadinessArtifacts
  )('fails closed when the migration-012 %s is missing or stale', async (_label, expectedArtifact) => {
    const { sql, schemaCalls } = fakeSql(
      [],
      [{ migration010Ready: true, migration011Ready: true }],
      [{ ready: false }]
    );

    await expect(assertProjectRagPostgresJobLifecycleSchemaReady(sql)).rejects.toThrow(
      'Project RAG durable job lifecycle schema (migration 012) is missing'
    );
    expect(schemaCalls).toHaveLength(1);
    expect(schemaCalls[0]?.text).toContain(expectedArtifact);
  });

  it('checks canonical migration-012 status states and functional index predicates', async () => {
    const { sql, schemaCalls } = fakeSql(
      [],
      [{ migration010Ready: true, migration011Ready: true }],
      [{ ready: true }]
    );

    await expect(assertProjectRagPostgresJobLifecycleSchemaReady(sql)).resolves.toBeUndefined();
    const readinessSql = schemaCalls[0]?.text ?? '';
    expect(readinessSql).toContain('checkstatus=anyarray');
    expect(readinessSql).toContain("''blocked-review''::text");
    expect(readinessSql).toContain("''dead-letter''::text");
    expect(readinessSql).not.toContain("array['queued'::text");
    expect(readinessSql).toContain('i.indisunique = true');
    expect(readinessSql).toContain("'dedupe_key'");
    expect(readinessSql).toContain("'available_at'");
    expect(readinessSql).toContain("'lease_expires_at'");
    expect(readinessSql).toContain("status=anyarray[''queued''::text,''retry-wait''::text]");
    expect(readinessSql).toContain("status=''running''::text");
  });

  it('persists fenced checkpoints and refuses a stale checkpoint', async () => {
    const saved = fakeSql([[{ id: 17, status: 'running', fence_token: 4 }]]);
    await expect(
      checkpointProjectRagJob(saved.sql, 17, 4, { phase: 'chunks' })
    ).resolves.toMatchObject({
      id: 17,
    });
    expect(saved.calls[0]?.text).toContain('checkpoint = ?::jsonb');
    expect(saved.calls[0]?.text).toContain('lease_expires_at > clock_timestamp()');

    const stale = fakeSql([[]]);
    await expect(
      checkpointProjectRagJob(stale.sql, 17, 3, { phase: 'chunks' })
    ).resolves.toBeUndefined();
  });

  it('moves worker failures to bounded retry-wait and exhausted attempts to dead-letter', async () => {
    const retry = fakeSql([[{ id: 17, status: 'retry-wait', fence_token: 4 }]]);
    await expect(
      failProjectRagJob(retry.sql, 17, 4, 'provider unavailable')
    ).resolves.toMatchObject({
      id: 17,
    });
    expect(retry.calls[0]?.text).toContain("'retry-wait'");
    expect(retry.calls[0]?.text).toContain("'dead-letter'");
    expect(retry.calls[0]?.text).toContain('make_interval(secs => ?)');

    const permanent = fakeSql([[{ id: 17, status: 'dead-letter', fence_token: 4 }]]);
    await expect(
      failProjectRagJob(permanent.sql, 17, 4, 'unsupported', { retryable: false })
    ).resolves.toMatchObject({ status: 'dead-letter' });
    expect(permanent.calls[0]?.text).toContain('retry budget exhausted');
  });

  it('recovers expired leases and fences dead-letter exhaustion', async () => {
    const { sql, calls, schemaCalls, executionOrder } = fakeSql([
      [
        { id: 17, status: 'retry-wait' },
        { id: 18, status: 'dead-letter' },
      ],
    ]);
    await expect(recoverStaleProjectRagJobs(sql, 10, 2_000)).resolves.toEqual({
      recoveredIds: [17],
      deadLetteredIds: [18],
    });
    expect(calls[0]?.text).toContain("status = 'running'");
    expect(calls[0]?.text).toContain("then 'dead-letter'");
    expect(calls[0]?.text).toContain('for update skip locked');
    expect(schemaCalls).toHaveLength(1);
    expect(executionOrder).toEqual(['readiness', 'recovery']);
  });

  it('fails closed before recovery SQL when migration 012 is incomplete', async () => {
    const { sql, calls, schemaCalls, executionOrder } = fakeSql(
      [],
      [{ migration010Ready: true, migration011Ready: true }],
      [{ ready: false }]
    );

    await expect(recoverStaleProjectRagJobs(sql)).rejects.toThrow(
      'Project RAG durable job lifecycle schema (migration 012) is missing'
    );
    expect(schemaCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(executionOrder).toEqual(['readiness']);
  });

  it('blocks review and only cancels running jobs with their live fence', async () => {
    const blocked = fakeSql([[{ id: 17, status: 'blocked-review', fence_token: 4 }]]);
    await expect(
      blockProjectRagJobForReview(blocked.sql, 17, 4, { finalStatus: 'partial' })
    ).resolves.toMatchObject({ status: 'blocked-review' });
    expect(blocked.calls[0]?.text).toContain("status = 'blocked-review'");
    expect(blocked.calls[0]?.text).toContain('lease_expires_at > clock_timestamp()');

    const queued = fakeSql([[{ id: 17, status: 'cancelled' }]]);
    await expect(cancelProjectRagJob(queued.sql, 17)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(queued.calls[0]?.text).toContain("status in ('queued', 'retry-wait', 'blocked-review')");

    const running = fakeSql([[{ id: 17, status: 'cancelled', fence_token: 4 }]]);
    await expect(cancelProjectRagJob(running.sql, 17, 4)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(running.calls[0]?.text).toContain("status = 'running'");
    expect(running.calls[0]?.text).toContain('fence_token = ?');
  });

  it('resumes only review-blocked or retry-wait jobs', async () => {
    const resumed = fakeSql([[{ id: 17, status: 'queued' }]]);
    await expect(resumeProjectRagJob(resumed.sql, 17)).resolves.toMatchObject({ status: 'queued' });
    expect(resumed.calls[0]?.text).toContain("status in ('blocked-review', 'retry-wait')");
    expect(resumed.calls[0]?.text).toContain('available_at = clock_timestamp()');
  });

  it('refuses publication when the durable-job fence is no longer live', async () => {
    const { sql, calls } = fakeSql([[]]);
    await expect(
      publishProjectRagPostgresIndexBuild(sql, 3, 9, { jobId: 17, fenceToken: 4 })
    ).rejects.toThrow('job lease was lost before index publication');
    expect(calls[0]?.text).toContain('fence_token = ?');
    // Fence liveness uses wall-clock time inside the ownership transaction.
    expect(calls[0]?.text).toContain('lease_expires_at > clock_timestamp()');
  });

  it('publishes a verified empty build inside the caller transaction', async () => {
    const { sql, beginTracker } = fakeSql([[{ id: 44 }], [], [{ count: 0 }], [], [{ id: 44 }]]);

    await expect(
      writePublishedProjectRagIndexBuildInTransaction(sql, 3, undefined, { allowEmpty: true })
    ).resolves.toEqual({ id: 44, projectId: 3, status: 'published', fileCount: 0 });
    expect(beginTracker.called).toBe(false);
  });

  it('garbage-collects retired build roots and unreachable terminal versions atomically', async () => {
    const { sql, calls, beginTracker } = fakeSql([[{ id: 12 }], [], [], []]);

    await expect(garbageCollectProjectRagPostgresIndexBuilds(sql, 3)).resolves.toBe(1);
    expect(beginTracker.called).toBe(true);
    expect(calls[0]?.text).toContain("status = 'retired'");
    expect(calls[0]?.text).toContain('for update');
    expect(calls[1]?.text).toContain('delete from project_index_build_files');
    expect(calls[2]?.text).toContain("status = 'garbage_collected'");
    expect(calls[3]?.text).toContain('delete from project_file_versions');
  });

  it('does not invoke a mutation after a forced reclaim invalidates its fence', async () => {
    const { sql, calls } = fakeSql([[]]);
    const mutation = vi.fn();
    await expect(
      withProjectRagJobFence(sql, { jobId: 17, fenceToken: 4 }, mutation)
    ).rejects.toThrow('job lease was lost before mutation');
    expect(mutation).not.toHaveBeenCalled();
    expect(calls[0]?.text).toContain('for update');
  });

  it('revalidates the live fence after the mutation before commit', async () => {
    const { sql, calls } = fakeSql([[{ id: 17 }], []]);
    const mutation = vi.fn(async () => undefined);

    await expect(
      withProjectRagJobFence(sql, { jobId: 17, fenceToken: 4 }, mutation)
    ).rejects.toThrow('job lease was lost before mutation');
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).toContain('lease_expires_at > clock_timestamp()');
  });

  it('rejects circular durable results before issuing SQL', async () => {
    const { sql, calls } = fakeSql([[{ id: 17 }]]);
    const result: Record<string, unknown> = {};
    result.self = result;

    await expect(finishProjectRagJob(sql, 17, 4, result)).rejects.toThrow(/circular/);
    expect(calls).toHaveLength(0);
  });

  it('rejects durable results over depth and item caps before issuing SQL', async () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index <= PROJECT_RAG_JOB_RESULT_MAX_DEPTH; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    const depthSql = fakeSql([[{ id: 17 }]]);
    await expect(finishProjectRagJob(depthSql.sql, 17, 4, deep)).rejects.toThrow(/depth/);
    expect(depthSql.calls).toHaveLength(0);

    const itemSql = fakeSql([[{ id: 17 }]]);
    await expect(
      finishProjectRagJob(
        itemSql.sql,
        17,
        4,
        Array.from({ length: PROJECT_RAG_JOB_RESULT_MAX_ITEMS }, () => 1)
      )
    ).rejects.toThrow(/item count/);
    expect(itemSql.calls).toHaveLength(0);
  });

  it('rejects durable results over the byte cap before issuing SQL', async () => {
    const { sql, calls } = fakeSql([[{ id: 17 }]]);
    await expect(
      finishProjectRagJob(sql, 17, 4, { value: 'x'.repeat(PROJECT_RAG_JOB_RESULT_MAX_BYTES) })
    ).rejects.toThrow(/size/);
    expect(calls).toHaveLength(0);
  });

  it('validates durable job identity before any publication SQL', async () => {
    const { sql, calls } = fakeSql([[{ id: 17 }], [{ id: 9 }], []]);
    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: 3,
        snapshotId: 9,
        snapshotUuid: '550e8400-e29b-41d4-a716-446655440000',
        syncRunId: 12,
        publishBuild: true,
        execution: {
          kind: 'durable',
          job: { jobId: 17, fenceToken: 4, result: { ok: true } },
        },
      })
    ).rejects.toThrow(/identity mismatch/);
    expect(calls.some((call) => call.text.includes('insert into project_index_builds'))).toBe(
      false
    );
  });

  it('aborts finalization after identity validation without publishing an expired run', async () => {
    const controller = new AbortController();
    controller.abort();
    const snapshotUuid = '550e8400-e29b-41d4-a716-446655440000';
    const { sql, calls } = fakeSql([
      [{ id: 17 }],
      [{ id: 9 }],
      [{ id: 17 }],
      [
        {
          id: 9,
          snapshot_uuid: snapshotUuid,
          project_id: 3,
          completeness_status: 'complete',
          completeness_evidence_hash: 'a'.repeat(64),
          eligible_count: 1,
          deletion_allowed: false,
          lease_expires_at: '2099-01-01T00:00:00.000Z',
        },
      ],
      [{ id: 12 }],
    ]);

    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: 3,
        snapshotId: 9,
        snapshotUuid,
        syncRunId: 12,
        publishBuild: true,
        signal: controller.signal,
        execution: {
          kind: 'durable',
          job: { jobId: 17, fenceToken: 4, result: { expired: true } },
        },
      })
    ).rejects.toThrow('cancelled during finalization');
    expect(calls.some((call) => call.text.includes('insert into project_index_builds'))).toBe(
      false
    );
  });

  it('validates foreground sync identity without accepting a durable payload', async () => {
    const { sql, calls } = fakeSql([[{ id: 9 }], [{ id: 9 }], []]);
    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: 3,
        snapshotId: 9,
        snapshotUuid: '550e8400-e29b-41d4-a716-446655440000',
        syncRunId: 12,
        publishBuild: true,
        execution: { kind: 'foreground' },
      })
    ).rejects.toThrow(/sync_identity_mismatch/);
    expect(calls.some((call) => call.text.includes('insert into project_index_builds'))).toBe(
      false
    );

    const invalidExecution = { kind: 'foreground', job: { jobId: 17, fenceToken: 4 } };
    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: 3,
        snapshotId: 9,
        snapshotUuid: '550e8400-e29b-41d4-a716-446655440000',
        syncRunId: 12,
        publishBuild: false,
        execution: invalidExecution as never,
      })
    ).rejects.toThrow(/cannot accept/);
  });

  it('requires the foreground sync run to match its exact snapshot and null job binding', async () => {
    const { sql, calls } = fakeSql([[{ id: 9 }], [{ id: 9 }], []]);
    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: 3,
        snapshotId: 9,
        snapshotUuid: '550e8400-e29b-41d4-a716-446655440000',
        syncRunId: 12,
        publishBuild: true,
        execution: { kind: 'foreground' },
      })
    ).rejects.toThrow(/sync_identity_mismatch/);
    expect(calls.some((call) => call.text.includes('snapshot_uuid = ?::uuid'))).toBe(true);
    expect(calls.some((call) => call.text.includes('job_id is null'))).toBe(true);
  });

  it('creates a foreground sync run with an explicit null durable-job binding', async () => {
    const { sql, calls } = fakeSql([[{ id: 12 }]]);

    await expect(
      insertProjectRagPostgresSyncRunInTransaction(sql, {
        projectId: 3,
        mode: 'full',
        snapshotUuid: '550e8400-e29b-41d4-a716-446655440000',
        jobId: null,
      })
    ).resolves.toBe(12);
    expect(calls[0]?.text).toContain('snapshot_uuid');
    expect(calls[0]?.text).toContain('job_id');
    expect(calls[0]?.values).toContain(null);
  });

  it('finalizes a durable sync only for its exact project, snapshot, and job binding', async () => {
    const snapshotUuid = '550e8400-e29b-41d4-a716-446655440000';
    const { sql, calls } = fakeSql([
      [{ id: 17 }],
      [{ id: 17 }],
      [{ id: 9 }],
      [
        {
          id: 9,
          snapshot_uuid: snapshotUuid,
          project_id: 3,
          completeness_status: 'complete',
          completeness_evidence_hash: 'a'.repeat(64),
          deletion_allowed: false,
          eligible_count: 1,
          tracked_count: 1,
          blocked_findings: [],
          suppressed_blocked_findings: [],
          status: 'CONSUMING',
          lease_expires_at: '2099-01-01T00:00:00.000Z',
        },
      ],
      [{ id: 12 }],
      [
        {
          id: 9,
          snapshot_uuid: snapshotUuid,
          project_id: 3,
          completeness_status: 'complete',
          completeness_evidence_hash: 'a'.repeat(64),
          deletion_allowed: false,
          eligible_count: 1,
          tracked_count: 1,
          blocked_findings: [],
          suppressed_blocked_findings: [],
          status: 'CONSUMED',
          lease_expires_at: '2099-01-01T00:00:00.000Z',
        },
      ],
      [{ id: 12 }],
      [{ id: 17 }],
      [{ id: 17 }],
      [{ id: 17 }],
      [{ id: 17 }],
    ]);

    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: 3,
        snapshotId: 9,
        snapshotUuid,
        syncRunId: 12,
        publishBuild: false,
        execution: {
          kind: 'durable',
          job: { jobId: 17, fenceToken: 4, result: { exact: true } },
        },
      })
    ).resolves.toEqual({});
    expect(calls[2]?.text).toContain('project_id = ?');
    expect(calls[2]?.text).toContain('snapshot_uuid = ?::uuid');
    expect(calls[3]?.text).toContain('snapshot_uuid = ?::uuid');
    expect(calls[4]?.text).toContain('snapshot_uuid = ?::uuid');
    expect(calls[4]?.text).toContain('job_id = ?');
    expect(calls[9]?.text).toContain("status = 'succeeded'");
  });

  it('accepts the version-aware chunk uniqueness constraint', async () => {
    const { sql, calls } = fakeSql([[{ ready: true }]]);

    await expect(assertProjectRagPostgresSchemaReady(sql)).resolves.toBeUndefined();
    expect(calls[0]?.text).toContain('project_chunks_file_version_chunk_unique');
    expect(calls[0]?.text).toContain('UNIQUE (file_id, version_id, chunk_index)');
  });

  it('requires migration 002 when version-aware chunk uniqueness is missing', async () => {
    const { sql } = fakeSql([[{ ready: false }]]);

    await expect(assertProjectRagPostgresSchemaReady(sql)).rejects.toThrow(
      'infra/project-rag/sql/002-versioned-chunk-uniqueness.sql'
    );
  });

  it('requires migration 007 composite project ownership FKs before publication', async () => {
    const { sql, calls } = fakeSql([[{ ready: true }]]);

    await expect(assertProjectRagPostgresIndexBuildSchemaReady(sql)).resolves.toBeUndefined();
    expect(calls[0]?.text).toContain('project_index_build_files_build_project_fk');
    expect(calls[0]?.text).toContain('project_index_build_files_file_project_fk');
    expect(calls[0]?.text).toContain('project_index_build_files_version_project_fk');
  });

  it('requires migration 009 sync-run binding schema before ingest creation', async () => {
    const { sql, calls } = fakeSql([[{ ready: true }]]);

    await expect(assertProjectRagPostgresSyncRunBindingSchemaReady(sql)).resolves.toBeUndefined();
    expect(calls[0]?.text).toContain('project_sync_runs_snapshot_project_fk');
    expect(calls[0]?.text).toContain('project_sync_runs_job_project_fk');
    expect(calls[0]?.text).toContain('project_sync_runs_freeze_binding_fields');
  });

  it('refuses sync-run creation without an exact snapshot and durable job binding', async () => {
    const { sql, calls } = fakeSql([[]]);
    await expect(
      insertProjectRagPostgresSyncRunInTransaction(sql, {
        projectId: 3,
        mode: 'full',
        snapshotUuid: '550e8400-e29b-41d4-a716-446655440000',
        jobId: 17,
      })
    ).rejects.toThrow(/binding did not match/);
    expect(calls[0]?.text).toContain('project_ingest_snapshots');
    expect(calls[0]?.text).toContain('project_jobs');
  });

  async function createIndexedFixture(sourcePath = 'src/index.ts') {
    const root = await mkdtemp(join(tmpdir(), 'project-rag-store-'));
    tempDirs.push(root);
    const absolutePath = join(root, sourcePath);
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, 'export const value = 1;\n');
    const fileStats = await stat(absolutePath);
    return {
      root,
      sourcePath,
      absolutePath,
      contentHash: await calculateProjectContentHash(await readFile(absolutePath, 'utf8')),
      fileModifiedAt: Math.floor(fileStats.mtimeMs),
      sizeBytes: fileStats.size,
    };
  }

  function invariantSqlRows(file: Awaited<ReturnType<typeof createIndexedFixture>>, args = {}) {
    const options = args as {
      readonly fileCount?: number;
      readonly indexedFileCount?: number;
      readonly chunkCount?: number;
      readonly embeddingMissing?: number;
      readonly chunkVersionGaps?: number;
      readonly embeddingVersionGaps?: number;
      readonly embeddingVersionMismatchOwners?: number;
      readonly contentHash?: string;
      readonly sourcePath?: string;
      readonly ownershipDrift?: boolean;
    };
    const fileCount = options.fileCount ?? 1;
    const indexedFileCount = options.indexedFileCount ?? 1;
    const chunkCount = options.chunkCount ?? 1;
    const missingOwners = options.embeddingMissing ?? 0;
    return [
      [
        {
          filesWithVersionMetadata: 0,
          filesWithActiveReadyVersion: 0,
          filesWithNonReadyActiveVersion: 0,
          filesPendingVersionBackfill: fileCount,
          filesUsingLegacyStatusRead: fileCount,
          pendingVersionCount: 0,
          stalePendingVersionCount: 0,
        },
      ],
      indexedFileCount > 0
        ? [
            {
              sourcePath: options.sourcePath ?? file.sourcePath,
              absolutePath: file.absolutePath,
              contentHash: options.contentHash ?? file.contentHash,
              fileModifiedAt: file.fileModifiedAt,
              sizeBytes: file.sizeBytes,
              status: 'indexed',
            },
          ]
        : [],
      [
        {
          chunkOwners: chunkCount,
          embeddingOwners: chunkCount - missingOwners,
          embeddingRecords: chunkCount - missingOwners,
          ownersWithValidEmbedding: chunkCount - missingOwners,
          missingOwners,
          staleOwners: 0,
          modelMismatchOwners: 0,
          providerMismatchOwners: 0,
          dimensionMismatchOwners: 0,
          chunkVersionGaps: options.chunkVersionGaps ?? 0,
          embeddingVersionGaps: options.embeddingVersionGaps ?? 0,
          embeddingVersionMismatchOwners: options.embeddingVersionMismatchOwners ?? 0,
          missingOwnerSample: missingOwners > 0 ? ['1'] : [],
          staleOwnerSample: [],
          mismatchOwnerSample: [],
          versionMismatchOwnerSample:
            (options.chunkVersionGaps ?? 0) > 0 ||
            (options.embeddingVersionGaps ?? 0) > 0 ||
            (options.embeddingVersionMismatchOwners ?? 0) > 0
              ? ['1']
              : [],
        },
      ],
      [
        {
          chunkFileOrphans: options.ownershipDrift ? 1 : 0,
          symbolFileOrphans: 0,
          symbolChunkOrphans: 0,
          edgeMissingSourceFileRefs: 0,
          edgeMissingTargetFileRefs: 0,
          edgeMissingSourceSymbolRefs: 0,
          edgeMissingTargetSymbolRefs: 0,
          deletedFileChunkRefs: 0,
          deletedFileSymbolRefs: 0,
          deletedFileEdgeRefs: 0,
        },
      ],
      [{ completedAt: '2026-03-24T09:00:00.000Z' }],
    ];
  }

  function invariantProject(root: string, includeRoots = ['src'], ignoreRules: string[] = []) {
    return {
      id: 42,
      name: 'Fixture',
      slug: 'fixture',
      rootPath: root,
      normalizedRootPath: root,
      status: 'active',
      includeRoots,
      ignoreRules,
      ephemeral: true,
      blockedFindingAllowlist: [],
    };
  }

  it('lists non-ephemeral projects by default', async () => {
    const { sql, calls } = fakeSql([
      [
        {
          id: '7',
          name: 'RAG V2',
          slug: 'rag-v2',
          root_path: '/repo',
          normalized_root_path: '/repo',
          status: 'active',
          include_roots: ['scripts', 'mcp'],
          ignore_rules: ['node_modules'],
          ephemeral: false,
        },
      ],
    ]);

    const projects = await listProjectRagPostgresProjects(sql, { limit: 10 });

    expect(projects).toEqual([
      {
        id: 7,
        name: 'RAG V2',
        slug: 'rag-v2',
        rootPath: '/repo',
        normalizedRootPath: '/repo',
        status: 'active',
        includeRoots: ['scripts', 'mcp'],
        ignoreRules: ['node_modules'],
        ephemeral: false,
        blockedFindingAllowlist: [],
      },
    ]);
    expect(calls[0]?.text).toContain('where ephemeral = false');
    expect(calls[0]?.values).toEqual([10]);
  });

  it('counts non-ephemeral projects without applying list limits', async () => {
    const { sql, calls } = fakeSql([[{ count: '5' }]]);

    const count = await countProjectRagPostgresProjects(sql, { includeEphemeral: false });

    expect(count).toBe(5);
    expect(calls[0]?.text).toContain('count(*)');
    expect(calls[0]?.text).toContain('where ephemeral = false');
    expect(calls[0]?.text).not.toContain('limit');
  });

  it('samples health project by indexed file volume, not recency alone', async () => {
    const { sql, calls } = fakeSql([
      [
        {
          id: '3',
          name: 'rag-v2.dev',
          slug: 'rag-v2-dev',
          root_path: '/repo',
          normalized_root_path: '/repo',
          status: 'active',
          include_roots: ['mcp'],
          ignore_rules: [],
          ephemeral: false,
        },
      ],
    ]);

    const sample = await findProjectRagPostgresHealthSample(sql);

    expect(sample?.slug).toBe('rag-v2-dev');
    expect(calls[0]?.text).toContain('indexed_file_count');
    expect(calls[0]?.text).toContain('order by coalesce(stats.indexed_file_count, 0) desc');
    expect(calls[0]?.text).toContain('ephemeral = false');
  });

  it('finds a project by id, slug, or name', async () => {
    const { sql, calls } = fakeSql([
      [
        {
          id: 3,
          name: 'Fixture Service',
          slug: 'fixture-service',
          root_path: '/fixture',
          normalized_root_path: '/fixture',
          status: 'active',
          include_roots: [],
          ignore_rules: [],
          ephemeral: true,
        },
      ],
    ]);

    const project = await findProjectRagPostgresProject(sql, 'Fixture-Service');

    expect(project?.id).toBe(3);
    expect(project?.slug).toBe('fixture-service');
    expect(project?.ephemeral).toBe(true);
    expect(project?.blockedFindingAllowlist).toEqual([]);
    expect(calls[0]?.values).toEqual(['Fixture-Service', 'fixture-service', 'fixture-service']);
    expect(calls[0]?.text).not.toContain('convexId');
  });

  it('lists tracked file hashes, statuses, and latest-version readiness for delta planning', async () => {
    const { sql, calls } = fakeSql([
      [
        {
          sourcePath: 'src/a.ts',
          contentHash: 'hash-a',
          status: 'indexed',
          latestVersionStatus: 'pending',
        },
      ],
    ]);

    await expect(listProjectRagPostgresFileStates(sql, 7)).resolves.toEqual([
      {
        sourcePath: 'src/a.ts',
        contentHash: 'hash-a',
        status: 'indexed',
        latestVersionStatus: 'pending',
      },
    ]);
    expect(calls[0]?.values).toEqual([7]);
    expect(calls[0]?.text).toContain('from project_files');
    expect(calls[0]?.text).toContain('project_file_versions');
  });

  it('returns compact project stats from count row', async () => {
    const { sql, calls } = fakeSql([
      [
        {
          file_count: '11',
          indexed_file_count: 9,
          blocked_file_count: '2',
          chunk_count: '30',
          symbol_count: '8',
          edge_count: '4',
          embedding_1024_count: '30',
          sync_run_count: '1',
        },
      ],
    ]);

    const stats = await getProjectRagPostgresProjectStats(sql, 42);

    expect(stats).toEqual({
      fileCount: 11,
      indexedFileCount: 9,
      blockedFileCount: 2,
      chunkCount: 30,
      symbolCount: 8,
      edgeCount: 4,
      embedding1024Count: 30,
      syncRunCount: 1,
    });
    expect(calls[0]?.values).toEqual([42, 42, 42, 42, 42, 42, 42, 42]);
  });

  it('returns covered invariant report for fresh indexed Postgres files', async () => {
    const file = await createIndexedFixture();
    const { sql } = fakeSql(invariantSqlRows(file));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.freshness.status).toBe('fresh');
    expect(report.scopeCoverage.status).toBe('covered');
    expect(report.embeddingCoverage.status).toBe('covered');
    expect(report.ownershipCoverage.status).toBe('covered');
    expect(report.lastSyncAt).toBe('2026-03-24T09:00:00.000Z');
  });

  it('reports stale invariant freshness when indexed hash differs from disk', async () => {
    const file = await createIndexedFixture();
    const { sql } = fakeSql(invariantSqlRows(file, { contentHash: 'stale-hash' }));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.freshness.status).toBe('stale');
    expect(report.freshness.staleFiles).toBe(1);
    expect(report.freshness.stalePaths).toEqual(['src/index.ts']);
  });

  it('reports scope drift when indexed files are outside includeRoots', async () => {
    const file = await createIndexedFixture();
    const { sql } = fakeSql(invariantSqlRows(file, { sourcePath: 'test/outside.ts' }));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.scopeCoverage.status).toBe('drift');
    expect(report.scopeCoverage.extraIndexedFiles).toBe(1);
    expect(report.scopeCoverage.extraIndexedPaths).toEqual(['test/outside.ts']);
  });

  it('reports scope drift when an eligible includeRoot file is not tracked', async () => {
    const file = await createIndexedFixture();
    await writeFile(join(file.root, 'src/untracked.ts'), 'export const untracked = true;\n');
    const { sql } = fakeSql(invariantSqlRows(file));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.scopeCoverage.status).toBe('drift');
    expect(report.scopeCoverage.expectedFiles).toBe(2);
    expect(report.scopeCoverage.missingExpectedFiles).toBe(1);
    expect(report.scopeCoverage.missingExpectedPaths).toEqual(['src/untracked.ts']);
  });

  it('deduplicates internal symlink aliases using the same canonical path as ingestion', async () => {
    const file = await createIndexedFixture();
    await symlink('index.ts', join(file.root, 'src/index-alias.ts'));
    const { sql } = fakeSql(invariantSqlRows(file));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.scopeCoverage.status).toBe('covered');
    expect(report.scopeCoverage.expectedFiles).toBe(1);
    expect(report.scopeCoverage.missingExpectedFiles).toBe(0);
  });

  it('exposes blocked expected files without treating intentional blocks as scope drift', async () => {
    const file = await createIndexedFixture();
    const blockedPath = join(file.root, 'src/blocked.ts');
    await writeFile(blockedPath, 'const blocked = true;\n');
    const blockedStats = await stat(blockedPath);
    const rows = invariantSqlRows(file) as Array<Array<Record<string, unknown>>>;
    rows[1].push({
      sourcePath: 'src/blocked.ts',
      absolutePath: blockedPath,
      contentHash: await calculateProjectContentHash(await readFile(blockedPath, 'utf8')),
      fileModifiedAt: Math.floor(blockedStats.mtimeMs),
      sizeBytes: blockedStats.size,
      status: 'blocked',
    });
    const { sql } = fakeSql(rows);

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.scopeCoverage.status).toBe('covered');
    expect(report.scopeCoverage.blockedExpectedFiles).toBe(1);
    expect(report.scopeCoverage.blockedExpectedPaths).toEqual(['src/blocked.ts']);
  });

  it('marks scope unverified when expected-file enumeration cannot stat a match', async () => {
    const file = await createIndexedFixture();
    await symlink('missing.ts', join(file.root, 'src/broken.ts'));
    const { sql } = fakeSql(invariantSqlRows(file));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.scopeCoverage.status).toBe('unverified');
    expect(report.scopeCoverage.reason).toContain('scope_file_stat_failed: src/broken.ts');
  });

  it('reports missing freshness when an indexed file no longer exists on disk', async () => {
    const file = await createIndexedFixture();
    await rm(file.absolutePath);
    const { sql } = fakeSql(invariantSqlRows(file));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.freshness.status).toBe('missing');
    expect(report.freshness.missingFiles).toBe(1);
    expect(report.freshness.stalePaths).toEqual(['src/index.ts']);
  });

  it('reports embedding drift when enabled chunks lack valid 1024 embeddings', async () => {
    const file = await createIndexedFixture();
    const { sql } = fakeSql(invariantSqlRows(file, { chunkCount: 2, embeddingMissing: 1 }));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.embeddingCoverage.status).toBe('drift');
    expect(report.embeddingCoverage.missingOwners).toBe(1);
    expect(report.embeddingCoverage.missingOwnerSample).toEqual(['1']);
  });

  it('reports embedding drift when chunk and embedding versions are not aligned', async () => {
    const file = await createIndexedFixture();
    const { sql, calls } = fakeSql(
      invariantSqlRows(file, {
        chunkVersionGaps: 1,
        embeddingVersionGaps: 1,
        embeddingVersionMismatchOwners: 1,
      })
    );

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.embeddingCoverage.status).toBe('drift');
    expect(report.embeddingCoverage.chunkVersionGaps).toBe(1);
    expect(report.embeddingCoverage.embeddingVersionGaps).toBe(1);
    expect(report.embeddingCoverage.embeddingVersionMismatchOwners).toBe(1);
    expect(report.embeddingCoverage.versionMismatchOwnerSample).toEqual(['1']);
    expect(calls[2]?.text).toContain('c.version_id = c.active_version_id');
    expect(calls[2]?.text).toContain('e.version_id = c.version_id');
  });

  it('reports zero pending version counts when versionReadiness is clean', async () => {
    const file = await createIndexedFixture();
    const { sql, calls } = fakeSql(invariantSqlRows(file));

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.versionReadiness.pendingVersionCount).toBe(0);
    expect(report.versionReadiness.stalePendingVersionCount).toBe(0);
    expect(calls[0]?.text).toContain("coalesce(status, '') <> 'deleted'");
    expect(calls[0]?.text).toContain("coalesce(f.status, '') <> 'deleted'");
  });

  it('reports non-zero pending version counts when versions are deferred', async () => {
    const file = await createIndexedFixture();
    const rows = invariantSqlRows(file) as Array<Array<Record<string, unknown>>>;
    // Override versionRows[0] to set pending counts
    rows[0] = [
      {
        ...(rows[0][0] as Record<string, unknown>),
        pendingVersionCount: 3,
        stalePendingVersionCount: 1,
      },
    ];
    const { sql } = fakeSql(rows);

    const report = await getProjectRagPostgresInvariantReport(sql, invariantProject(file.root));

    expect(report.versionReadiness.pendingVersionCount).toBe(3);
    expect(report.versionReadiness.stalePendingVersionCount).toBe(1);
  });

  it('fails closed when the build-bound read schema is incomplete', async () => {
    const migration010 = fakeSql([], [{ migration010Ready: false, migration011Ready: true }]);
    await expect(assertProjectRagPostgresReadSchemaReady(migration010.sql)).rejects.toThrow(
      'migration 010'
    );

    const migration011 = fakeSql([], [{ migration010Ready: true, migration011Ready: false }]);
    await expect(assertProjectRagPostgresReadSchemaReady(migration011.sql)).rejects.toThrow(
      'migration 011'
    );
  });

  it('reports the published serving build and immutable workspace provenance', async () => {
    const { sql, calls } = fakeSql([
      [
        {
          buildId: '88',
          revisionId: '21',
          publishedAt: '2026-08-23T12:00:00.000Z',
          dirtyDigest: 'dirty',
          repositoryHash: 'repo',
          workspaceHash: 'workspace',
          headOid: 'abc',
          branchName: 'main_dev',
          isDetached: false,
          isUnborn: false,
          headHash: 'head',
          branchHash: 'branch',
          detachedHash: null,
          contentHash: 'content',
          contentFingerprint: 'fingerprint',
          statusDigest: 'status',
          identityDigest: 'identity',
          fileCount: '3',
          versionCount: '3',
        },
      ],
    ]);

    const state = await getProjectRagPostgresServingState(sql, 5);

    expect(state).toMatchObject({
      status: 'serving',
      buildId: 88,
      revisionId: 21,
      fileCount: 3,
      versionCount: 3,
      provenance: { repositoryHash: 'repo', workspaceHash: 'workspace' },
    });
    expect(calls[0]?.text).toContain("b.status = 'published'");
    expect(calls[0]?.text).toContain('project_rag_workspaces');
    expect(calls[0]?.text).toContain('project_rag_repositories');
  });

  it('returns one file with bounded chunks', async () => {
    const { sql, calls } = fakeSql([
      [{ id: '88' }],
      [
        {
          id: '9',
          versionId: '12',
          sourcePath: 'scripts/ragctl.ts',
          lang: 'typescript',
          status: 'indexed',
          sizeBytes: '100',
          metadataQuality: 'full',
          lineCount: '20',
        },
      ],
      [
        {
          id: '11',
          chunkIndex: '0',
          startLine: '1',
          endLine: '20',
          symbolName: 'runRagctl',
          symbolKind: 'function',
          content: 'export async function runRagctl() {}',
          chunkCount: '1',
        },
      ],
    ]);

    const result = await getProjectRagPostgresFileWithChunks(sql, 5, 'scripts/ragctl.ts', {
      limit: 3,
    });

    expect(result?.file.sourcePath).toBe('scripts/ragctl.ts');
    expect(result?.chunks[0]?.symbolName).toBe('runRagctl');
    expect(result?.chunkCount).toBe(1);
    expect(calls[1]?.text).toContain('from project_index_build_files');
    expect(calls[2]?.text).toContain('from project_chunks');
  });

  it('uses build-selected file versions for lineCount and chunk lookup', async () => {
    const oldBuild = fakeSql([
      [
        {
          id: '9',
          versionId: '12',
          sourcePath: 'scripts/ragctl.ts',
          lang: 'typescript',
          status: 'indexed',
          sizeBytes: '100',
          metadataQuality: 'full',
          lineCount: '80',
        },
      ],
      [
        {
          id: '11',
          chunkIndex: '0',
          startLine: '1',
          endLine: '80',
          content: 'old build chunk',
          chunkCount: '1',
        },
      ],
    ]);
    const newBuild = fakeSql([
      [
        {
          id: '9',
          versionId: '21',
          sourcePath: 'scripts/ragctl.ts',
          lang: 'typescript',
          status: 'indexed',
          sizeBytes: '100',
          metadataQuality: 'full',
          lineCount: '120',
        },
      ],
      [
        {
          id: '22',
          chunkIndex: '0',
          startLine: '1',
          endLine: '120',
          content: 'new build chunk',
          chunkCount: '1',
        },
      ],
    ]);

    const oldVersion = await getProjectRagPostgresFileWithChunks(
      oldBuild.sql,
      5,
      'scripts/ragctl.ts',
      { buildId: 88 }
    );
    const newVersion = await getProjectRagPostgresFileWithChunks(
      newBuild.sql,
      5,
      'scripts/ragctl.ts',
      { buildId: 89 }
    );

    expect(oldVersion?.file.lineCount).toBe(80);
    expect(newVersion?.file.lineCount).toBe(120);
    expect(oldBuild.calls[0]?.values).toMatchObject([5, 88, 'scripts/ragctl.ts']);
    expect(newBuild.calls[0]?.values).toMatchObject([5, 89, 'scripts/ragctl.ts']);
    expect(oldBuild.calls[1]?.text).toContain('build_id = ?');
    expect(newBuild.calls[1]?.text).toContain('build_id = ?');
    expect(oldBuild.calls[1]?.text).toContain(
      'c.version_id = (select version_id from project_index_build_files'
    );
    expect(newBuild.calls[1]?.text).toContain(
      'c.version_id = (select version_id from project_index_build_files'
    );
  });

  it('returns a file outline from symbols', async () => {
    const { sql, calls } = fakeSql([
      [{ id: '88' }],
      [
        {
          id: '9',
          versionId: '12',
          sourcePath: 'scripts/ragctl.ts',
          status: 'indexed',
          sizeBytes: '100',
        },
      ],
      [],
      [
        {
          id: '13',
          name: 'runRagctl',
          symbolType: 'function',
          fileId: '9',
          sourcePath: 'scripts/ragctl.ts',
          symbolCount: '1',
        },
      ],
    ]);

    const result = await getProjectRagPostgresFileOutline(sql, 5, 'scripts/ragctl.ts', {
      limit: 10,
    });

    expect(result?.sourcePath).toBe('scripts/ragctl.ts');
    expect(result?.symbols[0]?.name).toBe('runRagctl');
    expect(result?.symbolCount).toBe(1);
    expect(calls[3]?.text).toContain('from project_symbols');
  });

  it('finds symbols and incoming references', async () => {
    const { sql, calls } = fakeSql([
      [{ id: '88' }],
      [
        {
          id: '13',
          name: 'runRagctl',
          symbolType: 'function',
          fileId: '9',
          sourcePath: 'scripts/ragctl.ts',
        },
      ],
      [
        {
          id: '21',
          relationType: 'REFERENCES',
          sourcePath: 'scripts/ragctl.test.ts',
          targetPath: 'scripts/ragctl.ts',
          sourceFileId: '10',
          targetFileId: '9',
          sourceRef: 'test',
          targetRef: 'runRagctl',
        },
      ],
    ]);

    const result = await findProjectRagPostgresSymbols(sql, 5, {
      name: 'runRagctl',
      type: 'function',
      limit: 5,
    });

    expect(result.definitions[0]?.sourcePath).toBe('scripts/ragctl.ts');
    expect(result.references[0]?.sourcePath).toBe('scripts/ragctl.test.ts');
    expect(calls[1]?.text).toContain('from project_symbols');
    expect(calls[2]?.text).toContain('from project_edges');
  });

  it('resolves navigation paths through target symbols', async () => {
    const { sql, calls } = fakeSql([
      [{ id: '88' }],
      [{ id: '9', versionId: '12' }],
      [
        {
          sourcePath: 'scripts/related.ts',
          relationshipType: 'IMPORTS',
          strength: 0.8,
        },
      ],
    ]);

    const paths = await getProjectRagPostgresNavigationPaths(sql, 5, 'scripts/ragctl.ts', {
      limit: 3,
    });

    expect(paths?.[0]).toEqual({
      sourcePath: 'scripts/related.ts',
      relationshipType: 'IMPORTS',
      strength: 0.8,
      explanation: 'Related through IMPORTS graph edge',
    });
    expect(calls[1]?.text).toContain('from project_index_build_files');
    // Lateral join replaces the old OR-based symbol match to avoid cartesian
    // products when symbols share a name.
    expect(calls[2]?.text).toContain('left join lateral');
    expect(calls[2]?.text).toContain('e.target_ref_lower');
  });

  it('resolves duplicate CALLS targets deterministically via DISTINCT ON', async () => {
    // The resolver uses DISTINCT ON with same-file preference to avoid
    // non-deterministic target_file_id when duplicate symbol names exist.
    // Note: the fake SQL cannot simulate Bun.SQL UPDATE result objects (which
    // return { count } instead of an array), so we verify the SQL pattern only.
    const { sql, calls } = fakeSql([
      [], // CALLS UPDATE — fake returns [], count defaults to 0
      [], // IMPORT SELECT (no unresolved imports)
    ]);

    const result = await resolveProjectRagPostgresEdgeTargets(sql, 5);

    // The CALLS UPDATE must use DISTINCT ON for deterministic resolution.
    expect(calls[0]?.text).toContain('distinct on');
    expect(calls[0]?.text).toContain('case when s.file_id = e2.source_file_id then 0 else 1 end');
    expect(calls[0]?.text).toContain('target_ref_lower');
    // IMPORT resolution: no unresolved imports → nothing resolved
    expect(result.importFilesResolved).toBe(0);
  });

  it('resolves navigation paths deduplicated via lateral join', async () => {
    // The navigation query must use a lateral join to avoid cartesian
    // products from duplicate symbol name matches.
    const { sql, calls } = fakeSql([
      [{ id: '88' }],
      [{ id: '9', versionId: '12' }],
      [
        {
          sourcePath: 'scripts/related.ts',
          relationshipType: 'IMPORTS',
          strength: 0.8,
        },
      ],
    ]);

    const paths = await getProjectRagPostgresNavigationPaths(sql, 5, 'scripts/ragctl.ts', {
      limit: 3,
    });

    expect(paths).toHaveLength(1);
    expect(paths?.[0]?.sourcePath).toBe('scripts/related.ts');
    // Lateral join replaces old OR-based pattern that caused cartesian product
    expect(calls[2]?.text).toContain('left join lateral');
    expect(calls[2]?.text).not.toContain(
      'e.target_symbol_id is null and e.target_ref_lower is not null'
    );
    expect(calls[2]?.text).toContain('limit 1');
  });

  it('returns empty navigation paths when file is not found', async () => {
    const { sql } = fakeSql([[{ id: '88' }], []]);

    const paths = await getProjectRagPostgresNavigationPaths(sql, 5, 'nonexistent.ts');

    expect(paths).toBeUndefined();
  });

  it('groups graph files into Postgres hubs, clusters, and topics', async () => {
    const graphRows = [
      {
        id: '1',
        sourcePath: 'mcp/server.ts',
        lang: 'typescript',
        symbolName: 'runMcpServer',
      },
      {
        id: '2',
        sourcePath: 'mcp/tools.ts',
        lang: 'typescript',
        symbolName: 'projectTools',
      },
      {
        id: '3',
        sourcePath: 'scripts/ragctl.ts',
        lang: 'typescript',
        symbolName: 'runRagctl',
      },
    ];
    const { sql, calls } = fakeSql([
      [{ id: '88' }],
      [...graphRows],
      [{ id: '88' }],
      [...graphRows],
      [{ id: '88' }],
      [...graphRows],
    ]);

    const hubs = await getProjectRagPostgresFeatureHubs(sql, 5, { minFiles: 2 });
    const clusters = await getProjectRagPostgresSemanticClusters(sql, 5, {
      maxClusters: 2,
      minClusterSize: 2,
    });
    const topics = await getProjectRagPostgresTopicGroups(sql, 5, {
      maxTopics: 2,
      minTopicSize: 2,
    });

    expect(hubs[0]?.directory).toBe('mcp');
    expect(hubs[0]?.stats.fileCount).toBe(2);
    expect(clusters[0]?.topicLabel).toBe('Mcp');
    expect(topics[0]?.keywords).toEqual(['mcp']);
    expect(calls).toHaveLength(6);
    expect(calls[1]?.text).toContain('from project_index_build_files');
  });

  it('upserts repository with blocked_finding_allowlist (explicit replace)', async () => {
    const { sql, calls } = fakeSql([[{ id: '10' }]]);

    const projectId = await upsertProjectRagPostgresRepository(sql, {
      name: 'Allowlist Test',
      slug: 'allowlist-test',
      rootPath: '/test',
      normalizedRootPath: '/test',
      blockedFindingAllowlist: [
        { relativePath: 'src/secret.ts', category: 'dependency_dir' },
        { relativePath: 'test/fixture', category: 'cache_dir' },
      ],
    });

    expect(projectId).toBe(10);
    expect(calls[0]?.text).toContain('blocked_finding_allowlist');
    // ON CONFLICT uses case when true (explicit) to replace
    expect(calls[0]?.text).toContain('case');
    expect(calls[0]?.text).toContain('when');
    // The values array includes the JSON-serialised allowlist
    const allowlistBind = calls[0]?.values.find(
      (v) => typeof v === 'string' && v.includes('relativePath')
    );
    expect(allowlistBind).toContain('dependency_dir');
    expect(allowlistBind).toContain('cache_dir');
    // allowlistExplicit is true (explicitly provided)
    expect(calls[0]?.values).toContain(true);
  });

  it('upserts repository without allowlist (undefined preserves existing on conflict)', async () => {
    const { sql, calls } = fakeSql([[{ id: '11' }]]);

    const projectId = await upsertProjectRagPostgresRepository(sql, {
      name: 'No Allowlist',
      slug: 'no-allowlist',
      rootPath: '/test',
      normalizedRootPath: '/test',
    });

    expect(projectId).toBe(11);
    expect(calls[0]?.text).toContain('blocked_finding_allowlist');
    // When allowlist is not supplied, INSERT uses '[]' and ON CONFLICT preserves existing
    const allowlistBind = calls[0]?.values.find((v) => v === '[]');
    expect(allowlistBind).toBe('[]');
    // allowlistExplicit is false — ON CONFLICT uses project_repositories.blocked_finding_allowlist
    expect(calls[0]?.values).toContain(false);
    // CASE expression in ON CONFLICT
    expect(calls[0]?.text).toContain('case');
  });

  it('upserts repository with explicit empty allowlist (clears existing on conflict)', async () => {
    const { sql, calls } = fakeSql([[{ id: '12' }]]);

    const projectId = await upsertProjectRagPostgresRepository(sql, {
      name: 'Clear Allowlist',
      slug: 'clear-allowlist',
      rootPath: '/test',
      normalizedRootPath: '/test',
      blockedFindingAllowlist: [],
    });

    expect(projectId).toBe(12);
    expect(calls[0]?.values).toContain(true); // explicit
    expect(calls[0]?.values).toContain('[]'); // empty array value
    expect(calls[0]?.text).toContain('case');
  });

  describe('validateRepositoryAllowlist', () => {
    it('accepts valid allowlist entries', () => {
      const entries: BlockedFindingAllowlistEntry[] = [
        { relativePath: 'src/secret.ts', category: 'dependency_dir' },
        { relativePath: 'test/fixtures/data', category: 'cache_dir' },
      ];
      expect(() => validateRepositoryAllowlist(entries)).not.toThrow();
    });

    it('accepts up to 32 entries', () => {
      const entries: BlockedFindingAllowlistEntry[] = Array.from({ length: 32 }, (_, i) => ({
        relativePath: `path/to/dir${i}`,
        category: 'build_dir',
      }));
      expect(() => validateRepositoryAllowlist(entries)).not.toThrow();
    });

    it('rejects non-array input', () => {
      expect(() => validateRepositoryAllowlist(null as unknown as [])).toThrow('must be an array');
      expect(() => validateRepositoryAllowlist(undefined as unknown as [])).toThrow(
        'must be an array'
      );
      expect(() => validateRepositoryAllowlist('not-array' as unknown as [])).toThrow(
        'must be an array'
      );
    });

    it('rejects 33 entries', () => {
      const entries: BlockedFindingAllowlistEntry[] = Array.from({ length: 33 }, (_, i) => ({
        relativePath: `path/to/dir${i}`,
        category: 'build_dir',
      }));
      expect(() => validateRepositoryAllowlist(entries)).toThrow('exceeds max');
    });

    it('rejects entry with extra keys', () => {
      expect(() =>
        validateRepositoryAllowlist([
          {
            relativePath: 'src/x.ts',
            category: 'cache_dir',
            extra: true,
          } as unknown as BlockedFindingAllowlistEntry,
        ])
      ).toThrow('has 3 keys');
    });

    it('rejects entry with missing relativePath', () => {
      expect(() =>
        validateRepositoryAllowlist([
          { category: 'cache_dir' } as unknown as BlockedFindingAllowlistEntry,
        ])
      ).toThrow('relativePath');
    });

    it('rejects entry with wrong-type relativePath', () => {
      expect(() =>
        validateRepositoryAllowlist([
          { relativePath: 42, category: 'cache_dir' } as unknown as BlockedFindingAllowlistEntry,
        ])
      ).toThrow('relativePath');
    });

    it('rejects absolute path (leading /)', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: '/etc/passwd', category: 'dependency_dir' }])
      ).toThrow('must be relative');
    });

    it('rejects traversal path (../)', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: '../src/x.ts', category: 'dependency_dir' }])
      ).toThrow('must be relative');
    });

    it('rejects backslash in path', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src\\x.ts', category: 'dependency_dir' }])
      ).toThrow('must be relative');
    });

    it('rejects glob characters in path', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src/**/*.ts', category: 'dependency_dir' }])
      ).toThrow('glob');
    });

    it('rejects basename-only path (no slash)', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'node_modules', category: 'dependency_dir' }])
      ).toThrow('basename-only');
    });

    it('rejects unknown category', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src/x.ts', category: 'nested_repo_marker' }])
      ).toThrow('not a suppressible blocked-finding category');
    });

    it('rejects nested_repo_marker category', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src/x.ts', category: 'nested_repo_marker' }])
      ).toThrow('not a suppressible');
    });

    it('rejects scan_bound_exceeded category', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src/x.ts', category: 'scan_bound_exceeded' }])
      ).toThrow('not a suppressible');
    });

    it('rejects duplicate entries', () => {
      expect(() =>
        validateRepositoryAllowlist([
          { relativePath: 'src/secret.ts', category: 'dependency_dir' },
          { relativePath: 'src/secret.ts', category: 'dependency_dir' },
        ])
      ).toThrow('duplicate');
    });

    it('rejects empty path', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: '', category: 'dependency_dir' }])
      ).toThrow('must not be empty');
    });

    it('rejects trailing slash', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src/dir/', category: 'dependency_dir' }])
      ).toThrow('trailing slash');
    });

    it('rejects dot segments', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src/./x.ts', category: 'dependency_dir' }])
      ).toThrow("'.' or '..'");
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src/x/..', category: 'dependency_dir' }])
      ).toThrow("'.' or '..'");
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: './foo/bar.ts', category: 'dependency_dir' }])
      ).toThrow("'.' or '..'");
    });

    it('rejects repeated slashes', () => {
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: 'src//x.ts', category: 'dependency_dir' }])
      ).toThrow('repeated slashes');
    });

    it('rejects path exceeding 200 characters', () => {
      const longPath = `${'a'.repeat(199)}/x`;
      expect(longPath.length).toBeGreaterThan(200);
      expect(() =>
        validateRepositoryAllowlist([{ relativePath: longPath, category: 'dependency_dir' }])
      ).toThrow('200');
    });
  });

  describe('validateSuppressedBlockedFindings', () => {
    const validEntry = () => ({
      relativePath: 'src/secret.ts',
      category: 'dependency_dir',
      matchedAllowlistEntry: { relativePath: 'src/secret.ts', category: 'dependency_dir' },
    });

    it('accepts valid suppressed findings', () => {
      expect(() => validateSuppressedBlockedFindings([validEntry()])).not.toThrow();
    });

    it('accepts up to 32 entries', () => {
      const entries = Array.from({ length: 32 }, (_, i) => ({
        relativePath: `path/to/f${i}.ts`,
        category: 'build_dir',
        matchedAllowlistEntry: { relativePath: `path/to/f${i}.ts`, category: 'build_dir' },
      }));
      expect(() => validateSuppressedBlockedFindings(entries)).not.toThrow();
    });

    it('accepts empty array', () => {
      expect(() => validateSuppressedBlockedFindings([])).not.toThrow();
    });

    it('rejects non-array', () => {
      expect(() => validateSuppressedBlockedFindings(null as unknown as [])).toThrow(
        'must be an array'
      );
      expect(() => validateSuppressedBlockedFindings(undefined as unknown as [])).toThrow(
        'must be an array'
      );
      expect(() => validateSuppressedBlockedFindings('not-array' as unknown as [])).toThrow(
        'must be an array'
      );
    });

    it('rejects 33 entries', () => {
      const entries = Array.from({ length: 33 }, (_, i) => ({
        relativePath: `path/to/f${i}.ts`,
        category: 'build_dir',
        matchedAllowlistEntry: { relativePath: `path/to/f${i}.ts`, category: 'build_dir' },
      }));
      expect(() => validateSuppressedBlockedFindings(entries)).toThrow('exceeds max');
    });

    it('rejects missing relativePath', () => {
      expect(() =>
        validateSuppressedBlockedFindings([
          {
            category: 'dependency_dir',
            matchedAllowlistEntry: { relativePath: 'a/b', category: 'dependency_dir' },
          } as unknown as Record<string, unknown>,
        ])
      ).toThrow('relativePath');
    });

    it('rejects non-suppressible category', () => {
      expect(() =>
        validateSuppressedBlockedFindings([
          {
            relativePath: 'src/x.ts',
            category: 'nested_repo_marker',
            matchedAllowlistEntry: { relativePath: 'src/x.ts', category: 'nested_repo_marker' },
          },
        ])
      ).toThrow('suppressible');
    });

    it('rejects missing matchedAllowlistEntry', () => {
      expect(() =>
        validateSuppressedBlockedFindings([
          { relativePath: 'src/x.ts', category: 'dependency_dir' } as unknown as Record<
            string,
            unknown
          >,
        ])
      ).toThrow('matchedAllowlistEntry');
    });

    it('rejects matchedAllowlistEntry.relativePath not matching parent relativePath', () => {
      expect(() =>
        validateSuppressedBlockedFindings([
          {
            relativePath: 'src/x.ts',
            category: 'dependency_dir',
            matchedAllowlistEntry: { relativePath: 'different/path', category: 'dependency_dir' },
          },
        ])
      ).toThrow('does not match parent relativePath');
    });

    it('rejects matchedAllowlistEntry.category not matching parent category', () => {
      expect(() =>
        validateSuppressedBlockedFindings([
          {
            relativePath: 'src/x.ts',
            category: 'dependency_dir',
            matchedAllowlistEntry: { relativePath: 'src/x.ts', category: 'build_dir' },
          },
        ])
      ).toThrow('does not match parent category');
    });
  });

  it('upserts repository and file rows with metadata', async () => {
    const { sql, calls } = fakeSql([[{ id: '5' }], [{ id: '9' }], [{ id: '21' }], []]);

    const projectId = await upsertProjectRagPostgresRepository(sql, {
      name: 'RAG V2',
      slug: 'rag-v2',
      rootPath: '/repo',
      normalizedRootPath: '/repo',
      includeRoots: ['scripts'],
      ignoreRules: ['node_modules'],
      metadata: { source: 'project-rag-postgres-test' },
    });
    const fileId = await upsertProjectRagPostgresFile(sql, projectId, {
      sourcePath: 'scripts/ragctl.ts',
      absolutePath: '/repo/scripts/ragctl.ts',
      contentHash: 'abc',
      fileModifiedAt: 123,
      metadata: { source: 'project-rag-postgres-test' },
    });

    expect(projectId).toBe(5);
    expect(fileId.fileId).toBe(9);
    expect(calls[0]?.text).toContain('insert into project_repositories');
    expect(calls[0]?.values).toContain('{"scripts"}');
    expect(calls[1]?.text).toContain('insert into project_files');
    expect(calls[2]?.text).toContain('insert into project_file_versions');
    expect(calls[3]?.text).toContain('active_version_id');
  });

  it('promotes a ready file version and replaces the previous active version', async () => {
    const { sql, calls } = fakeSql([
      [{ id: '9', activeVersionId: '20' }],
      [], // mark old version replaced
      [], // disable old active chunks
      [{ id: '21' }],
      [],
    ]);

    const fileId = await upsertProjectRagPostgresFile(sql, 5, {
      sourcePath: 'scripts/ragctl.ts',
      absolutePath: '/repo/scripts/ragctl.ts',
      contentHash: 'new-hash',
      fileModifiedAt: 456,
      lang: 'typescript',
      sizeBytes: 1234,
      status: 'indexed',
      metadataQuality: 'full',
      skeletonText: 'export function run()',
      outlineVersion: 'skeleton-v1',
    });

    expect(fileId.fileId).toBe(9);
    expect(calls[1]?.text).toContain("set status = 'replaced'");
    expect(calls[1]?.values).toEqual([20]);
    expect(calls[2]?.text).toContain('update project_chunks');
    expect(calls[2]?.text).toContain('enabled = false');
    expect(calls[3]?.text).toContain('insert into project_file_versions');
    expect(calls[3]?.text).toContain('compatibility_status');
    expect(calls[4]?.text).toContain('latest_version_id');
    expect(calls[0]?.values).toEqual([
      5,
      'scripts/ragctl.ts',
      '/repo/scripts/ragctl.ts',
      'new-hash',
      456,
      'typescript',
      null,
      1234,
      'indexed',
      'full',
      'export function run()',
      'skeleton-v1',
      '{}',
    ]);
    expect(calls[3]?.values).toEqual([
      5,
      9,
      'ready', // versionStatus (now an explicit parameter before content_hash)
      'new-hash',
      456,
      1234,
      'typescript',
      'full',
      'export function run()',
      'skeleton-v1',
      'indexed',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/), // ready_at
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/), // promoted_at
    ]);
  });

  it('preserves active-version chunks while replacing a pending version', async () => {
    const { sql, calls } = fakeSql([[{ status: 'pending' }], [], [], []]);

    const count = await replaceProjectRagPostgresFileChunks(
      sql,
      5,
      9,
      [
        {
          chunkIndex: 0,
          content: 'content',
          searchableText: 'search content',
          startLine: 1,
          endLine: 2,
          metadata: { source: 'project-rag-postgres-test' },
        },
      ],
      21
    );

    expect(count).toBe(1);
    expect(calls[0]?.text).toContain('from project_file_versions');
    expect(calls[1]?.text).toContain('from project_index_build_files');
    expect(calls[2]?.text).toContain('delete from project_chunks');
    expect(calls[2]?.text).toMatch(/version_id\s*=\s*\?/);
    expect(calls[2]?.values).toEqual([5, 9, 21]);
    expect(calls[3]?.text).toContain('insert into project_chunks');
    expect(calls[3]?.text).toContain('version_id');
    expect(calls[3]?.values).toContain(21);
  });

  it('replaceProjectRagPostgresFileChunksInTransaction works without sql.begin() wrapper', async () => {
    // This is the internal helper that assumes the caller already manages
    // the transaction.  It must not call begin() itself — the mock begin
    // tracker proves only the caller (test) controls transaction boundaries.
    const { sql, calls, beginTracker } = fakeSql([
      [{ status: 'pending' }], // candidate version
      [], // candidate is not in a build
      [], // delete candidate chunks
      [], // insert new chunk
    ]);

    const count = await replaceProjectRagPostgresFileChunksInTransaction(
      sql,
      5,
      9,
      [
        {
          chunkIndex: 0,
          content: 'content',
          searchableText: 'search content',
          startLine: 1,
          endLine: 2,
          metadata: { source: 'project-rag-postgres-test' },
        },
      ],
      21
    );

    expect(count).toBe(1);
    // No begin() was called (caller manages the transaction)
    expect(beginTracker.called).toBe(false);
    // Same query pattern as the wrapper variant
    expect(calls[0]?.text).toContain('from project_file_versions');
    expect(calls[1]?.text).toContain('from project_index_build_files');
    expect(calls[2]?.text).toContain('delete from project_chunks');
    expect(calls[2]?.text).toMatch(/version_id\s*=\s*\?/);
    expect(calls[2]?.values).toEqual([5, 9, 21]);
    expect(calls[3]?.text).toContain('insert into project_chunks');
    expect(calls[3]?.values).toContain(21);
  });

  it('inserts graph rows with explicit version identities', async () => {
    const { sql, calls } = fakeSql([
      [{ status: 'pending' }], // symbol candidate version
      [], // symbol candidate is not in a build
      [{ id: '13' }],
      [{ status: 'pending' }], // edge source candidate version
      [], // edge source candidate is not in a build
      [{ status: 'pending' }], // edge target candidate version
      [], // edge target candidate is not in a build
      [{ id: '21' }],
    ]);

    const symbolId = await insertProjectRagPostgresSymbol(sql, 5, {
      fileId: 9,
      versionId: 21,
      name: 'run',
      symbolType: 'function',
      exportType: 'named',
      metadata: { source: 'project-rag-postgres-test' },
    });
    const edgeId = await insertProjectRagPostgresEdge(sql, 5, {
      sourceFileId: 9,
      sourceVersionId: 21,
      sourceSymbolId: symbolId,
      sourceRef: 'caller',
      targetFileId: 9,
      targetSymbolId: symbolId,
      targetVersionId: 21,
      targetRef: 'run',
      relationType: 'CALLS',
      metadata: { source: 'project-rag-postgres-test' },
    });

    expect(symbolId).toBe(13);
    expect(edgeId).toBe(21);
    expect(calls[2]?.text).toContain('insert into project_symbols');
    expect(calls[2]?.values).toContain(21);
    expect(calls[7]?.values).toContain(21);
    expect(calls[7]?.values).toContain('project_reference_backfill');
    expect(calls[7]?.text).toContain('insert into project_edges');
  });

  it('replaces symbols for one project file', async () => {
    const { sql, calls } = fakeSql([
      [{ status: 'pending' }],
      [],
      [],
      [{ id: '10' }],
      [{ id: '11' }],
    ]);

    const count = await replaceProjectRagPostgresFileSymbols(
      sql,
      5,
      9,
      [
        {
          name: 'run',
          symbolType: 'function',
          exportType: 'named',
          signature: '(x: number) => void',
          startLine: 10,
          endLine: 20,
          metadata: { source: 'project-rag-postgres-test' },
        },
        {
          name: 'Config',
          symbolType: 'interface',
          exportType: 'named',
          signature: '{ name: string }',
          startLine: 1,
          endLine: 3,
        },
      ],
      21
    );

    expect(count).toBe(2);
    expect(calls[0]?.text).toContain('from project_file_versions');
    expect(calls[1]?.text).toContain('from project_index_build_files');
    expect(calls[2]?.text).toContain('delete from project_symbols');
    expect(calls[2]?.values).toEqual([5, 9, 21]);
    expect(calls[3]?.text).toContain('insert into project_symbols');
    expect(calls[3]?.values).toContain('run');
    expect(calls[4]?.text).toContain('insert into project_symbols');
    expect(calls[4]?.values).toContain('Config');
  });

  it('replaces symbols with empty array (delete only, no inserts)', async () => {
    const { sql, calls } = fakeSql([[{ status: 'pending' }], [], []]);

    const count = await replaceProjectRagPostgresFileSymbols(sql, 5, 9, [], 21);

    expect(count).toBe(0);
    expect(calls[2]?.text).toContain('delete from project_symbols');
    expect(calls[2]?.values).toEqual([5, 9, 21]);
  });

  it('replaces edges for one project file atomically', async () => {
    const { sql, calls } = fakeSql([
      [{ status: 'pending' }],
      [],
      [],
      [{ id: '30' }],
      [{ id: '31' }],
    ]);

    const count = await replaceProjectRagPostgresFileEdges(
      sql,
      5,
      9,
      [
        {
          relationType: 'CALLS',
          targetRef: 'parseAst',
          sourceRef: 'parseAst',
          confidence: 0.7,
          extractionMethod: 'ast-parser-direct',
        },
        {
          relationType: 'IMPORTS',
          targetRef: './parser',
          sourceRef: './parser',
          confidence: 0.6,
          extractionMethod: 'ast-parser-direct',
        },
      ],
      21
    );

    expect(count).toBe(2);
    expect(calls[0]?.text).toContain('from project_file_versions');
    expect(calls[1]?.text).toContain('from project_index_build_files');
    expect(calls[2]?.text).toContain('delete from project_edges');
    expect(calls[2]?.values).toEqual([5, 9, 21]);
    expect(calls[3]?.text).toContain('insert into project_edges');
    expect(calls[3]?.values).toContain('CALLS');
    expect(calls[3]?.values).toContain('parseAst');
    expect(calls[4]?.text).toContain('insert into project_edges');
    expect(calls[4]?.values).toContain('IMPORTS');
    expect(calls[4]?.values).toContain('./parser');
  });

  it('replaces edges with empty array (delete only, no inserts)', async () => {
    const { sql, calls } = fakeSql([[{ status: 'pending' }], [], []]);

    const count = await replaceProjectRagPostgresFileEdges(sql, 5, 9, [], 21);

    expect(count).toBe(0);
    expect(calls[2]?.text).toContain('delete from project_edges');
    expect(calls[2]?.values).toEqual([5, 9, 21]);
  });

  it('rejects ready candidate replacement before issuing a delete', async () => {
    const { sql, calls } = fakeSql([[{ status: 'ready' }]]);

    await expect(replaceProjectRagPostgresFileChunks(sql, 5, 9, [], 20)).rejects.toThrow(
      'CANDIDATE_VERSION_IMMUTABLE'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).not.toContain('delete from project_chunks');
  });

  it('rejects a candidate already bound to an index build before mutation', async () => {
    const { sql, calls } = fakeSql([[{ status: 'pending' }], [{ one: 1 }]]);

    await expect(replaceProjectRagPostgresFileSymbols(sql, 5, 9, [], 21)).rejects.toThrow(
      'CANDIDATE_VERSION_BUILD_MEMBER'
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).not.toContain('delete from project_symbols');
  });

  it.each([
    'ready',
    'failed',
    'replaced',
  ] as const)('rejects chunk replacement for %s versions before DELETE/INSERT', async (status) => {
    const { sql, calls } = fakeSql([[{ status }]]);

    await expect(
      replaceProjectRagPostgresFileChunks(
        sql,
        5,
        9,
        [
          {
            chunkIndex: 0,
            content: 'blocked',
            searchableText: 'blocked',
          },
        ],
        21
      )
    ).rejects.toThrow('CANDIDATE_VERSION_IMMUTABLE');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).not.toContain('delete from project_chunks');
    expect(calls[0]?.text).not.toContain('insert into project_chunks');
  });

  it('rejects chunk replacement for pending versions already bound to a build', async () => {
    const { sql, calls } = fakeSql([[{ status: 'pending' }], [{ one: 1 }]]);

    await expect(
      replaceProjectRagPostgresFileChunks(
        sql,
        5,
        9,
        [
          {
            chunkIndex: 0,
            content: 'blocked',
            searchableText: 'blocked',
          },
        ],
        21
      )
    ).rejects.toThrow('CANDIDATE_VERSION_BUILD_MEMBER');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).not.toContain('delete from project_chunks');
    expect(calls[1]?.text).not.toContain('insert into project_chunks');
  });

  it.each([
    'ready',
    'failed',
    'replaced',
  ] as const)('rejects direct symbol and edge inserts for %s versions before INSERT', async (status) => {
    const symbolSql = fakeSql([[{ status }]]);
    await expect(
      insertProjectRagPostgresSymbol(symbolSql.sql, 5, {
        fileId: 9,
        versionId: 21,
        name: 'blocked',
        symbolType: 'function',
      })
    ).rejects.toThrow('CANDIDATE_VERSION_IMMUTABLE');
    expect(symbolSql.calls).toHaveLength(1);
    expect(symbolSql.calls[0]?.text).not.toContain('insert into project_symbols');

    const edgeSql = fakeSql([[{ status }]]);
    await expect(
      insertProjectRagPostgresEdge(edgeSql.sql, 5, {
        sourceFileId: 9,
        sourceVersionId: 21,
        relationType: 'CALLS',
        targetRef: 'blocked',
      })
    ).rejects.toThrow('CANDIDATE_VERSION_IMMUTABLE');
    expect(edgeSql.calls).toHaveLength(1);
    expect(edgeSql.calls[0]?.text).not.toContain('insert into project_edges');
  });

  it('rejects direct graph inserts for pending versions already in a published build', async () => {
    const symbolSql = fakeSql([[{ status: 'pending' }], [{ one: 1 }]]);
    await expect(
      insertProjectRagPostgresSymbol(symbolSql.sql, 5, {
        fileId: 9,
        versionId: 21,
        name: 'published',
        symbolType: 'function',
      })
    ).rejects.toThrow('CANDIDATE_VERSION_BUILD_MEMBER');
    expect(symbolSql.calls).toHaveLength(2);
    expect(symbolSql.calls[1]?.text).not.toContain('insert into project_symbols');

    const edgeSql = fakeSql([[{ status: 'pending' }], [{ one: 1 }]]);
    await expect(
      insertProjectRagPostgresEdge(edgeSql.sql, 5, {
        sourceFileId: 9,
        sourceVersionId: 21,
        relationType: 'CALLS',
        targetRef: 'published',
      })
    ).rejects.toThrow('CANDIDATE_VERSION_BUILD_MEMBER');
    expect(edgeSql.calls).toHaveLength(2);
    expect(edgeSql.calls[1]?.text).not.toContain('insert into project_edges');
  });

  it('lists and upserts chunk embeddings', async () => {
    const embedding = Array.from({ length: 1024 }, () => 0.1);
    const { sql, calls } = fakeSql([
      [{ id: '17', source_hash: 'hash', searchable_text: 'search', content: 'content' }],
      [{ file_id: '9', version_id: '21', enabled: true, status: 'pending' }],
      [],
      [{ id: '23' }],
    ]);

    const candidates = await listProjectRagPostgresChunkEmbeddingCandidates(sql, 5, {
      embeddingModel: 'qwen3-embedding-1024',
      embeddingProfileHash: 'profile-a',
      limit: 50,
    });
    const embeddingId = await upsertProjectRagPostgresChunkEmbedding1024(sql, 5, {
      ...candidates[0],
      embedding,
      embeddingModel: 'qwen3-embedding-1024',
      embeddingProvider: 'llamacpp',
      dimensions: 1024,
      embeddingProfileHash: 'profile-a',
    });

    expect(candidates).toEqual([{ chunkId: 17, sourceHash: 'hash', text: 'search' }]);
    expect(embeddingId).toBe(23);
    expect(calls[0]?.text).toContain('from project_chunks');
    expect(calls[0]?.text).toContain("v.status = 'pending'");
    expect(calls[0]?.text).toContain('project_index_build_files');
    expect(calls[1]?.text).toContain('from project_chunks');
    expect(calls[2]?.text).toContain('from project_index_build_files');
    expect(calls[3]?.text).toContain('insert into project_embeddings_1024');
    expect(calls[3]?.text).toContain('owner.version_id');
  });

  it.each([
    'ready',
    'failed',
    'replaced',
  ] as const)('rejects embedding inserts for %s versions before INSERT', async (status) => {
    const { sql, calls } = fakeSql([[{ file_id: '9', version_id: '21', enabled: true, status }]]);

    await expect(
      upsertProjectRagPostgresChunkEmbedding1024(sql, 5, {
        chunkId: 17,
        sourceHash: 'hash',
        text: 'search',
        embedding: Array.from({ length: 1024 }, () => 0.1),
        embeddingModel: 'qwen3-embedding-1024',
        embeddingProvider: 'llamacpp',
        dimensions: 1024,
        embeddingProfileHash: 'profile-a',
      })
    ).rejects.toThrow('CANDIDATE_VERSION_IMMUTABLE');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).not.toContain('insert into project_embeddings_1024');
  });

  it('rejects embedding inserts for pending versions already bound to a build', async () => {
    const { sql, calls } = fakeSql([
      [{ file_id: '9', version_id: '21', enabled: true, status: 'pending' }],
      [{ one: 1 }],
    ]);

    await expect(
      upsertProjectRagPostgresChunkEmbedding1024(sql, 5, {
        chunkId: 17,
        sourceHash: 'hash',
        text: 'search',
        embedding: Array.from({ length: 1024 }, () => 0.1),
        embeddingModel: 'qwen3-embedding-1024',
        embeddingProvider: 'llamacpp',
        dimensions: 1024,
        embeddingProfileHash: 'profile-a',
      })
    ).rejects.toThrow('CANDIDATE_VERSION_BUILD_MEMBER');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).not.toContain('insert into project_embeddings_1024');
  });

  it('searches project chunks with vector and lexical candidates', async () => {
    const { sql, calls } = fakeSql([
      [{ id: '88' }],
      [
        {
          sourcePath: 'scripts/project-rag/store.ts',
          chunkIndex: 2,
          startLine: '10',
          endLine: '20',
          content: 'searchProjectRagPostgresChunks',
          symbolName: 'searchProjectRagPostgresChunks',
          symbolKind: 'function',
          score: '12.5',
          vectorScore: '0.9',
        },
      ],
    ]);

    const results = await searchProjectRagPostgresChunks(sql, 5, {
      query: 'postgres vector search',
      queryEmbedding: Array.from({ length: 1024 }, () => 0.1),
      embeddingModel: 'qwen3-embedding-1024',
      embeddingProvider: 'llamacpp',
      embeddingDimensions: 1024,
      embeddingProfileHash: 'profile-a',
      limit: 3,
    });

    expect(results).toEqual([
      {
        sourcePath: 'scripts/project-rag/store.ts',
        chunkIndex: 2,
        startLine: 10,
        endLine: 20,
        content: 'searchProjectRagPostgresChunks',
        symbolName: 'searchProjectRagPostgresChunks',
        symbolKind: 'function',
        score: 12.5,
        vectorScore: 0.9,
      },
    ]);
    expect(calls[1]?.text).toContain('vector_candidates');
    expect(calls[1]?.text).toContain('lexical_candidates');
    const searchSql = calls[1]?.text ?? '';
    const vectorCandidatesSql =
      searchSql.match(/vector_candidates\s+as\s*\(([\s\S]*?)\),\s*lexical_candidates/)?.[1] ?? '';
    const lexicalCandidatesSql =
      searchSql.match(/lexical_candidates\s+as\s*\(([\s\S]*?)\),\s*candidate_chunks/)?.[1] ?? '';
    const activeChunkPattern = /bf\.version_id\s*=\s*c\.version_id/;
    const activeEmbeddingPattern =
      /(?:c\.version_id\s*=\s*e\.version_id|e\.version_id\s*=\s*c\.version_id)/;
    expect(vectorCandidatesSql).toMatch(activeChunkPattern);
    expect(vectorCandidatesSql).toMatch(activeEmbeddingPattern);
    expect(lexicalCandidatesSql).toMatch(activeChunkPattern);
  });

  it('tombstones files missing from the latest source path set', async () => {
    const { sql, calls } = fakeSql([[{ id: 1 }, { id: 2 }]]);

    const deleted = await deleteStaleProjectRagPostgresFiles(sql, 5, ['b.ts', 'a.ts', 'a.ts']);

    expect(deleted).toBe(2);
    expect(calls[0]?.text).toContain('update project_files');
    expect(calls[0]?.text).toContain("status = 'deleted'");
    expect(calls[0]?.values[0]).toBe(5);
  });

  it('deletes one project file by source path', async () => {
    const snapshotUuid = '550e8400-e29b-41d4-a716-446655440000';
    const { sql, calls } = fakeSql([[{ id: 9 }], [{ id: 9 }]]);

    const deleted = await deleteProjectRagPostgresFile(sql, 5, 'mcp/README.md', {
      snapshotId: 9,
      snapshotUuid,
      completenessEvidenceHash: 'a'.repeat(64),
    });

    expect(deleted).toBe(1);
    expect(calls[1]?.text).toContain('update project_files');
    expect(calls[1]?.text).toContain("status = 'deleted'");
    expect(calls[1]?.text).toContain('source_path = ?');
    expect(calls[1]?.values).toEqual([5, 'mcp/README.md']);
  });

  it('can limit embedding candidates to a processed source path set', async () => {
    const { sql, calls } = fakeSql([
      [
        {
          id: '11',
          content: 'chunk',
          searchable_text: 'searchable chunk',
          source_hash: 'abc',
        },
      ],
    ]);

    const candidates = await listProjectRagPostgresChunkEmbeddingCandidates(sql, 5, {
      embeddingModel: 'qwen3-embedding-1024',
      embeddingProfileHash: 'profile-a',
      sourcePaths: ['b.ts', 'a.ts', 'a.ts'],
    });

    expect(candidates).toEqual([{ chunkId: 11, sourceHash: 'abc', text: 'searchable chunk' }]);
    expect(calls[0]?.text).toContain('join project_files');
    expect(calls[0]?.text).toContain('f.source_path in');
    expect(calls[0]?.values).toContain('profile-a');
  });

  it('atomically upserts file and replaces chunks via sql.begin()', async () => {
    // The wrapper uses sql.begin(); BEGIN/COMMIT are handled internally.
    // Rows are consumed by the pending candidate upsert, candidate guard,
    // version-scoped chunk replacement, and immediate promotion.
    const { sql, calls, beginTracker } = fakeSql([
      [{ id: 9, activeVersionId: 20 }], // 1. upsert file returns row
      [{ id: 21 }], // 2. insert pending candidate version
      [], // 3. update latest_version_id
      [{ status: 'pending' }], // 4. candidate guard
      [], // 5. candidate is not in a build
      [], // 6. delete candidate chunks
      [], // 7. insert new chunk
      [{ activeVersionId: 20 }], // 8. read active version for promotion
      [], // 9. mark old version replaced
      [], // 10. disable old active chunks
      [], // 11. promote candidate to ready
      [], // 12. set active_version_id
    ]);

    const fileId = await upsertProjectRagPostgresFileWithChunks(
      sql,
      5,
      {
        sourcePath: 'scripts/app.ts',
        absolutePath: '/repo/scripts/app.ts',
        contentHash: 'abc123',
        fileModifiedAt: 100,
        status: 'indexed',
      },
      [
        {
          chunkIndex: 0,
          content: 'export function app() {}',
          searchableText: 'export function app',
        },
      ]
    );

    expect(fileId.fileId).toBe(9);
    expect(beginTracker.called).toBe(true);
    // Transaction was executed (business queries recorded)
    expect(calls.length).toBe(12);
    // No raw BEGIN/COMMIT in calls (sql.begin() handles them)
    expect(calls.some((c) => c.text === 'BEGIN')).toBe(false);
    expect(calls.some((c) => c.text === 'COMMIT')).toBe(false);
    expect(calls.some((c) => c.text === 'ROLLBACK')).toBe(false);
  });

  it('wraps calls in sql.begin() when upserting a file with zero chunks', async () => {
    // New file (activeVersionId = null) path: the candidate is guarded and
    // promoted even when it owns zero chunks.
    const { sql, calls, beginTracker } = fakeSql([
      [{ id: 9, activeVersionId: null }], // 1. upsert file – new file
      [{ id: 10 }], // 2. insert new version
      [], // 3. update latest_version_id
      [{ status: 'pending' }], // 4. candidate guard
      [], // 5. candidate is not in a build
      [], // 6. delete candidate chunks (zero rows)
      [{ activeVersionId: null }], // 7. read active version for promotion
      [], // 8. promote candidate to ready
      [], // 9. set active_version_id
    ]);

    const fileId = await upsertProjectRagPostgresFileWithChunks(
      sql,
      5,
      {
        sourcePath: 'scripts/app.ts',
        absolutePath: '/repo/scripts/app.ts',
        contentHash: 'abc123',
        fileModifiedAt: 100,
      },
      [] // no chunks
    );

    expect(fileId.fileId).toBe(9);
    expect(beginTracker.called).toBe(true);
    // Business queries were recorded during the transaction
    expect(calls.length).toBe(9);
    expect(calls.some((c) => c.text === 'BEGIN')).toBe(false);
    expect(calls.some((c) => c.text === 'COMMIT')).toBe(false);
  });

  it('defers active version promotion when versionStatus is not "ready"', async () => {
    // Existing file with active version 20.  With versionStatus='pending':
    //   - Old version is NOT marked 'replaced'
    //   - New version gets status 'pending' (ready_at/promoted_at = null)
    //   - Only latest_version_id is updated; active_version_id stays at 20
    const { sql, calls } = fakeSql([
      // upsertProjectRagPostgresFile
      [{ id: 9, activeVersionId: 20 }], // upsert file returns old active
      // NO "mark old replaced" call (versionStatus !== 'ready')
      [{ id: 21 }], // insert new 'pending' version
      [], // update only latest_version_id (not active)
    ]);

    const fileId = await upsertProjectRagPostgresFile(
      sql,
      5,
      {
        sourcePath: 'scripts/app.ts',
        absolutePath: '/repo/scripts/app.ts',
        contentHash: 'new-hash',
        fileModifiedAt: 200,
        lang: 'typescript',
        sizeBytes: 2000,
        status: 'indexed',
        metadataQuality: 'full',
        skeletonText: 'export function app()',
        outlineVersion: 'skeleton-v1',
      },
      'pending'
    );

    expect(fileId.fileId).toBe(9);
    // Old version should NOT be marked 'replaced'
    const replacedCall = calls.find((c) => c.text.includes("set status = 'replaced'"));
    expect(replacedCall).toBeUndefined();
    // New version should have status 'pending'
    const versionInsertCall = calls.find((c) =>
      c.text.includes('insert into project_file_versions')
    );
    expect(versionInsertCall?.values).toContain('pending');
    // Only latest_version_id update – no active_version_id set
    const updateCall = calls.find((c) => c.text.includes('update project_files'));
    expect(updateCall?.text).toContain('set latest_version_id');
    expect(updateCall?.text).not.toContain('set active_version_id');
  });

  it('promotes deferred versions to active and replaces the old active version', async () => {
    // Simulate state after a 'pending' ingest:
    //   - File 9 has active_version_id 20 (old ready version)
    //   - File 9 has latest_version_id 21 (indexing version)
    //   - Two files to promote: file 9 (with existing active) and file 10 (new file, no active)
    const { sql, calls, beginTracker } = fakeSql([
      // promoteProjectRagPostgresFileVersions: find files to promote
      [
        { file_id: 9, old_active_id: 20, version_id: 21 },
        { file_id: 10, old_active_id: null, version_id: 22 },
      ],
      // file 9: mark old active as replaced
      [],
      // file 9: disable old active chunks
      [],
      // file 9: promote to 'ready'
      [],
      // file 9: set active_version_id
      [],
      // file 10: no old active to replace (skip)
      // file 10: promote to 'ready'
      [],
      // file 10: set active_version_id
      [],
    ]);

    const promoted = await promoteProjectRagPostgresFileVersions(sql, 5, 'pending');

    expect(promoted).toBe(2);
    expect(beginTracker.called).toBe(true);
    // File 9: old version (20) marked replaced
    const replacedCall = calls.find(
      (c) => c.text.includes('set status') && c.text.includes('replaced')
    );
    expect(replacedCall).toBeDefined();
    expect(replacedCall?.values).toContain(20);
    const disabledChunkCall = calls.find(
      (c) => c.text.includes('update project_chunks') && c.text.includes('enabled = false')
    );
    expect(disabledChunkCall?.values).toContain(20);
    // Both versions promoted to 'ready'
    const promoteCalls = calls.filter(
      (c) =>
        c.text.includes('set status') && c.text.includes('ready') && !c.text.includes('replaced')
    );
    expect(promoteCalls).toHaveLength(2);
    // Both files get active_version_id set (only UPDATE statements, not the initial SELECT)
    const activeUpdateCalls = calls.filter(
      (c) => c.text.includes('update project_files') && c.text.includes('active_version_id')
    );
    expect(activeUpdateCalls).toHaveLength(2);
  });

  it('returns 0 from promoteProjectRagPostgresFileVersions when nothing to promote', async () => {
    const { sql, beginTracker } = fakeSql([[]]);

    const promoted = await promoteProjectRagPostgresFileVersions(sql, 5, 'pending');

    expect(promoted).toBe(0);
    expect(beginTracker.called).toBe(true);
  });

  it('limits normal promotion to requested source paths', async () => {
    const { sql, calls } = fakeSql([
      [{ file_id: 9, old_active_id: 20, version_id: 21 }],
      [],
      [],
      [],
    ]);

    const promoted = await promoteProjectRagPostgresFileVersions(sql, 5, 'pending', ['src/a.ts']);

    expect(promoted).toBe(1);
    expect(calls[0]?.text).toContain('f.source_path in');
  });

  it('promotes versions atomically via sql.begin() without raw BEGIN/COMMIT in query log', async () => {
    // The sql.begin() wrapper handles transaction boundaries internally.
    // Rows are consumed by: find-eligible query + per-file updates.
    const { sql, calls, beginTracker } = fakeSql([
      // find files to promote
      [
        { file_id: 9, old_active_id: 20, version_id: 21 },
        { file_id: 10, old_active_id: null, version_id: 22 },
      ],
      // file 9: mark old active as replaced
      [],
      // file 9: promote to 'ready'
      [],
      // file 9: set active_version_id
      [],
      // file 10: no old active to replace (skip)
      // file 10: promote to 'ready'
      [],
      // file 10: set active_version_id
      [],
    ]);

    const promoted = await promoteProjectRagPostgresFileVersions(sql, 5, 'pending');

    expect(promoted).toBe(2);
    expect(beginTracker.called).toBe(true);
    // No raw BEGIN/COMMIT/ROLLBACK in calls — sql.begin() handles them
    expect(calls.some((c) => c.text === 'BEGIN')).toBe(false);
    expect(calls.some((c) => c.text === 'COMMIT')).toBe(false);
    expect(calls.some((c) => c.text === 'ROLLBACK')).toBe(false);
  });

  it('does not mark old active as replaced when its status is not ready', async () => {
    // File 9: active=20 (status='failed'), latest=21 (pending).
    // The promote should NOT mark version 20 as 'replaced' because
    // its status is 'failed', not 'ready'.  The new version should still
    // be promoted and set as active.
    const { sql, calls } = fakeSql([
      [{ file_id: 9, old_active_id: 20, version_id: 21 }],
      // skip replacing old (status='failed' does not match 'ready')
      // promote version 21 to ready
      [],
      // set active_version_id
      [],
    ]);

    const promoted = await promoteProjectRagPostgresFileVersions(sql, 5, 'pending');

    expect(promoted).toBe(1);
    // The update query IS sent to the database, but the WHERE clause
    // includes `and status = 'ready'` so it is a safe no-op when the
    // old active version has a non-'ready' status (e.g. 'failed').
    const replacedCall = calls.find(
      (c) => c.text.includes('set status') && c.text.includes('replaced')
    );
    expect(replacedCall).toBeDefined();
    expect(replacedCall?.text).toContain("status = 'ready'");
    // New version was promoted to ready
    const promoteCall = calls.find(
      (c) =>
        c.text.includes('set status') && c.text.includes('ready') && !c.text.includes('replaced')
    );
    expect(promoteCall).toBeDefined();
    // active_version_id was updated
    const activeUpdateCall = calls.find(
      (c) => c.text.includes('update project_files') && c.text.includes('active_version_id')
    );
    expect(activeUpdateCall).toBeDefined();
    expect(activeUpdateCall?.values).toContain(21);
  });

  it('atomically upserts file and chunks with deferred versionStatus via sql.begin()', async () => {
    // With versionStatus='pending':
    //   sql.begin() handles BEGIN/COMMIT; upsertFile (no old-replaced), insert version,
    //   update only latest, replaceChunks
    const { sql, calls, beginTracker } = fakeSql([
      [{ id: 9, activeVersionId: 20 }], // 1. upsert file returns old active
      [{ id: 21 }], // 2. insert new 'pending' version
      [], // 3. update latest_version_id only
      [{ status: 'pending' }], // 4. candidate guard
      [], // 5. candidate is not in a build
      [], // 6. delete candidate chunks
      [], // 7. insert new chunk
    ]);

    const fileId = await upsertProjectRagPostgresFileWithChunks(
      sql,
      5,
      {
        sourcePath: 'scripts/app.ts',
        absolutePath: '/repo/scripts/app.ts',
        contentHash: 'abc123',
        fileModifiedAt: 100,
        status: 'indexed',
      },
      [
        {
          chunkIndex: 0,
          content: 'export function app() {}',
          searchableText: 'export function app',
        },
      ],
      'pending'
    );

    expect(fileId.fileId).toBe(9);
    expect(beginTracker.called).toBe(true);
    // No raw BEGIN/COMMIT in calls (sql.begin() handles them)
    expect(calls.some((c) => c.text === 'BEGIN')).toBe(false);
    expect(calls.some((c) => c.text === 'COMMIT')).toBe(false);
    // No "mark old replaced" call for deferred versionStatus
    const replacedCall = calls.find((c) => c.text.includes("set status = 'replaced'"));
    expect(replacedCall).toBeUndefined();
  });

  describe('repairProjectRagPostgresFileVersions', () => {
    it('returns 0 when there are no pending versions to repair', async () => {
      // No rows returned from the find-eligible query
      const { sql } = fakeSql([[]]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024
      );

      expect(repaired).toBe(0);
    });

    it('limits repair promotion to requested source paths', async () => {
      const { sql, calls } = fakeSql([
        [{ file_id: 9, old_active_id: 20, version_id: 21 }],
        [{ chunk_count: 1, valid_embedding_count: 1 }],
        [],
        [],
        [],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024,
        false,
        ['src/a.ts']
      );

      expect(repaired).toBe(1);
      expect(calls[0]?.text).toContain('f.source_path in');
    });

    it('skips promotion when chunks are missing for the version', async () => {
      // File 9: active=20, latest=21 (pending), but no chunks yet for version 21
      const { sql, calls } = fakeSql([
        // find-eligible query
        [{ file_id: 9, old_active_id: 20, version_id: 21 }],
        // safety check: chunk_count=0, valid_embedding_count=0 => skip
        [{ chunk_count: 0, valid_embedding_count: 0 }],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024
      );

      expect(repaired).toBe(0);
      // No promote or replace calls
      const promoteCall = calls.find((c) => c.text.includes("set status = 'ready'"));
      expect(promoteCall).toBeUndefined();
    });

    it('skips promotion when embeddings are incomplete for the version', async () => {
      // File 9: active=20, latest=21 (pending), 3 chunks exist but only 2 have valid embeddings
      const { sql, calls } = fakeSql([
        [{ file_id: 9, old_active_id: 20, version_id: 21 }],
        [{ chunk_count: 3, valid_embedding_count: 2 }],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024
      );

      expect(repaired).toBe(0);
      const promoteCall = calls.find((c) => c.text.includes("set status = 'ready'"));
      expect(promoteCall).toBeUndefined();
    });

    it('promotes a pending version when all chunks have valid embeddings', async () => {
      // File 9: active=20, latest=21 (pending), 2 chunks, 2 valid embeddings
      const { sql, calls } = fakeSql([
        // find-eligible query
        [{ file_id: 9, old_active_id: 20, version_id: 21 }],
        // safety check: all chunks have valid embeddings
        [{ chunk_count: 2, valid_embedding_count: 2 }],
        // mark old active as replaced
        [],
        // disable old active chunks
        [],
        // promote version to ready
        [],
        // set active_version_id
        [],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024
      );

      expect(repaired).toBe(1);
      // Old version marked replaced
      const replacedCall = calls.find(
        (c) => c.text.includes('set status') && c.text.includes('replaced')
      );
      expect(replacedCall).toBeDefined();
      expect(replacedCall?.values).toContain(20);
      const disabledChunkCall = calls.find(
        (c) => c.text.includes('update project_chunks') && c.text.includes('enabled = false')
      );
      expect(disabledChunkCall?.values).toContain(20);
      // Version promoted to ready
      const promoteCall = calls.find(
        (c) =>
          c.text.includes('set status') && c.text.includes('ready') && !c.text.includes('replaced')
      );
      expect(promoteCall).toBeDefined();
      // fromStatus is parameterized; values carry 'pending' and the version id
      expect(promoteCall?.values).toContain('pending');
      expect(promoteCall?.values).toContain(21);
      // File active_version_id updated
      const activeUpdateCall = calls.find(
        (c) => c.text.includes('update project_files') && c.text.includes('active_version_id')
      );
      expect(activeUpdateCall).toBeDefined();
      expect(activeUpdateCall?.values).toContain(21);
    });

    it('promotes a new file (no active version) with valid embeddings', async () => {
      // File 10: active=null (new file), latest=22 (pending), all chunks have embeddings
      const { sql, calls } = fakeSql([
        [{ file_id: 10, old_active_id: null, version_id: 22 }],
        [{ chunk_count: 1, valid_embedding_count: 1 }],
        // no old active to replace (skip)
        // promote version to ready
        [],
        // set active_version_id
        [],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024
      );

      expect(repaired).toBe(1);
      // No "mark replaced" for null old_active
      const replacedCall = calls.find(
        (c) => c.text.includes('set status') && c.text.includes('replaced')
      );
      expect(replacedCall).toBeUndefined();
      // Promoted to ready (status='pending' is in the SQL text)
      const promoteCall = calls.find(
        (c) => c.text.includes('set status') && c.text.includes('ready')
      );
      expect(promoteCall).toBeDefined();
      // fromStatus is parameterized; values carry 'pending' and the version id
      expect(promoteCall?.values).toContain('pending');
      expect(promoteCall?.values).toContain(22);
    });

    it('promotes multiple files with complete embeddings', async () => {
      // File 9: active=20, latest=21 (pending), 2 chunks, 2 valid embeddings
      // File 11: active=30, latest=31 (pending), 1 chunk, 1 valid embedding
      const { sql, calls } = fakeSql([
        [
          { file_id: 9, old_active_id: 20, version_id: 21 },
          { file_id: 11, old_active_id: 30, version_id: 31 },
        ],
        // safety check for file 9
        [{ chunk_count: 2, valid_embedding_count: 2 }],
        // file 9: replace old
        [],
        // file 9: disable old chunks
        [],
        // file 9: promote to ready
        [],
        // file 9: set active
        [],
        // safety check for file 11
        [{ chunk_count: 1, valid_embedding_count: 1 }],
        // file 11: replace old
        [],
        // file 11: disable old chunks
        [],
        // file 11: promote to ready
        [],
        // file 11: set active
        [],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024
      );

      expect(repaired).toBe(2);
      // Both files got promoted
      const promoteCalls = calls.filter(
        (c) =>
          c.text.includes('set status') && c.text.includes('ready') && !c.text.includes('replaced')
      );
      expect(promoteCalls).toHaveLength(2);
      // Both files got active updated
      const activeCalls = calls.filter(
        (c) => c.text.includes('update project_files') && c.text.includes('active_version_id')
      );
      expect(activeCalls).toHaveLength(2);
    });

    it('rejects promotion in strict mode when embeddings have null source_hash', async () => {
      // File 9: active=20, latest=21 (pending), 1 chunk with 1 embedding
      // but the embedding has null source_hash.  In strict mode (default,
      // legacyMode=false) this should NOT be counted as valid.
      const { sql, calls } = fakeSql([
        [{ file_id: 9, old_active_id: 20, version_id: 21 }],
        // safety check: chunk_count=1, valid_embedding_count=0 (null source_hash rejected)
        [{ chunk_count: 1, valid_embedding_count: 0 }],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024
        // legacyMode defaults to false
      );

      expect(repaired).toBe(0);
      const promoteCall = calls.find((c) => c.text.includes("set status = 'ready'"));
      expect(promoteCall).toBeUndefined();
    });

    it('accepts promotion in legacy mode when embeddings have null source_hash', async () => {
      // Same scenario as above but with legacyMode=true: null source_hash
      // should be accepted.
      const { sql, calls } = fakeSql([
        [{ file_id: 9, old_active_id: 20, version_id: 21 }],
        // safety check: chunk_count=1, valid_embedding_count=1 (null accepted)
        [{ chunk_count: 1, valid_embedding_count: 1 }],
        // mark old active as replaced
        [],
        // promote version to ready
        [],
        // set active_version_id
        [],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024,
        true // legacyMode = true
      );

      expect(repaired).toBe(1);
      const promoteCall = calls.find(
        (c) =>
          c.text.includes('set status') && c.text.includes('ready') && !c.text.includes('replaced')
      );
      expect(promoteCall).toBeDefined();
    });

    it('rejects promotion in strict mode when chunk has embedding with non-matching source_hash', async () => {
      // File 9: active=20, latest=21 (pending), 1 chunk with 1 embedding
      // where source_hash does NOT match the chunk content hash.
      // This should be rejected even in strict mode.
      const { sql, calls } = fakeSql([
        [{ file_id: 9, old_active_id: 20, version_id: 21 }],
        [{ chunk_count: 1, valid_embedding_count: 0 }],
      ]);

      const repaired = await repairProjectRagPostgresFileVersions(
        sql,
        5,
        'qwen3-embedding-1024',
        'llamacpp',
        1024
      );

      expect(repaired).toBe(0);
      const promoteCall = calls.find((c) => c.text.includes("set status = 'ready'"));
      expect(promoteCall).toBeUndefined();
    });
  });
});

const DEFAULT_POOL = { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 };

describe('createProjectRagPostgresSql / closeProjectRagPostgresSql', () => {
  let originalBunDescriptor: PropertyDescriptor | undefined;
  let originalSqlDescriptor: PropertyDescriptor | undefined;

  function setBunSql(SQL: unknown): void {
    const bunDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Bun');
    const bunValue = bunDescriptor?.value as { SQL?: unknown } | undefined;
    if (bunValue) {
      bunValue.SQL = SQL;
      return;
    }
    Object.defineProperty(globalThis, 'Bun', {
      configurable: true,
      writable: true,
      value: { SQL },
    });
  }

  function restoreBunGlobal(): void {
    if (!originalBunDescriptor) {
      Reflect.deleteProperty(globalThis, 'Bun');
      return;
    }

    if (!originalBunDescriptor.configurable) {
      const bunValue = originalBunDescriptor.value as { SQL?: unknown };
      if (originalSqlDescriptor) {
        Object.defineProperty(bunValue, 'SQL', originalSqlDescriptor);
      }
      return;
    }

    Object.defineProperty(globalThis, 'Bun', originalBunDescriptor);
  }

  beforeAll(() => {
    originalBunDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Bun');
    originalSqlDescriptor = originalBunDescriptor?.value
      ? Object.getOwnPropertyDescriptor(originalBunDescriptor.value, 'SQL')
      : undefined;
  });

  afterEach(async () => {
    await closeProjectRagPostgresSql();
    restoreBunGlobal();
  });

  afterAll(() => {
    restoreBunGlobal();
  });

  it('throws when database.url is missing', () => {
    const config = {
      tool: 'project-rag-postgres',
      healthTimeoutMs: 5000,
      database: {},
      pool: DEFAULT_POOL,
    } as any;
    expect(() => createProjectRagPostgresSql(config)).toThrow('No Postgres URL configured');
  });

  it('caches and reuses the pool for the same URL and same pool settings', () => {
    let constructorOptions: unknown = null;
    const constructorCalls: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorCalls.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
      constructorOptions = options;
    }
    setBunSql(MockSQL);

    const config = { database: { url: 'postgres://test' }, pool: DEFAULT_POOL } as any;

    const pool1 = createProjectRagPostgresSql(config);
    const pool2 = createProjectRagPostgresSql(config);

    expect(pool1).toBe(pool2);
    expect(constructorCalls).toHaveLength(1);
    expect(constructorOptions).toMatchObject({ url: 'postgres://test', max: 2 });
  });

  it('creates a new pool when the URL changes (old pool stays open)', () => {
    const constructorCalls: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorCalls.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    setBunSql(MockSQL);

    const configA = { database: { url: 'postgres://a' }, pool: DEFAULT_POOL } as any;
    const configB = { database: { url: 'postgres://b' }, pool: DEFAULT_POOL } as any;

    const poolA = createProjectRagPostgresSql(configA);
    const poolB = createProjectRagPostgresSql(configB);

    expect(poolA).not.toBe(poolB);
    expect(constructorCalls).toHaveLength(2);
  });

  it('creates a new pool when pool settings differ (same URL)', () => {
    const constructorCalls: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorCalls.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    setBunSql(MockSQL);

    const configDefault = { database: { url: 'postgres://same' }, pool: DEFAULT_POOL } as any;
    const configCustom = {
      database: { url: 'postgres://same' },
      pool: { max: 5, connectionTimeoutMs: 10_000, maxLifetimeMs: 3_600_000 },
    } as any;

    const poolDefault = createProjectRagPostgresSql(configDefault);
    const poolCustom = createProjectRagPostgresSql(configCustom);

    expect(poolDefault).not.toBe(poolCustom);
    expect(constructorCalls).toHaveLength(2);
  });

  it('reuses a cached pool when settings match despite separate config objects', () => {
    const constructorCalls: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorCalls.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    setBunSql(MockSQL);

    const configA = { database: { url: 'postgres://same' }, pool: DEFAULT_POOL } as any;
    const configB = { database: { url: 'postgres://same' }, pool: DEFAULT_POOL } as any;

    const poolA = createProjectRagPostgresSql(configA);
    const poolB = createProjectRagPostgresSql(configB);

    expect(poolA).toBe(poolB);
    expect(constructorCalls).toHaveLength(1);
  });

  it('passes pool settings and connectionTimeout to Bun.SQL constructor', () => {
    const constructorOptionsArray: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorOptionsArray.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    setBunSql(MockSQL);

    const config = {
      database: { url: 'postgres://custom' },
      pool: { max: 4, connectionTimeoutMs: 15_000, maxLifetimeMs: 300_000 },
    } as any;
    createProjectRagPostgresSql(config);

    expect(constructorOptionsArray).toHaveLength(1);
    const opts = constructorOptionsArray[0] as Record<string, unknown>;
    expect(opts.max).toBe(4);
    expect(opts.connectionTimeout).toBe(15); // 15_000 ms → 15 seconds
    expect(opts.maxLifetime).toBe(300); // 300_000 ms → 300 seconds
    expect(opts.idleTimeout).toBe(300);
    expect(opts.prepare).toBe(false);
  });

  it('handles zero maxLifetimeMs (unlimited) correctly', () => {
    const constructorOptionsArray: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorOptionsArray.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    setBunSql(MockSQL);

    const config = {
      database: { url: 'postgres://nolimit' },
      pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
    } as any;
    createProjectRagPostgresSql(config);

    const opts = constructorOptionsArray[0] as Record<string, unknown>;
    expect(opts.maxLifetime).toBe(0);
  });

  it('closeProjectRagPostgresSql with URL avoids prefix ambiguity (postgres://a vs postgres://ab)', async () => {
    const constructorCalls: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorCalls.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    setBunSql(MockSQL);

    const configA = { database: { url: 'postgres://a' }, pool: DEFAULT_POOL } as any;
    const configAB = { database: { url: 'postgres://ab' }, pool: DEFAULT_POOL } as any;

    const poolA = createProjectRagPostgresSql(configA);
    const poolAB = createProjectRagPostgresSql(configAB);

    const closeSpyA = (poolA as unknown as { close: ReturnType<typeof vi.fn> }).close;
    const closeSpyAB = (poolAB as unknown as { close: ReturnType<typeof vi.fn> }).close;

    // Closing 'postgres://a' must NOT close 'postgres://ab'
    await closeProjectRagPostgresSql('postgres://a');

    expect(closeSpyA).toHaveBeenCalledWith({ timeout: 1 });
    expect(closeSpyAB).not.toHaveBeenCalled();
    expect(constructorCalls).toHaveLength(2);
  });

  it('closeProjectRagPostgresSql without args closes all cached pools', async () => {
    const constructorCalls: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorCalls.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    setBunSql(MockSQL);

    const configA = { database: { url: 'postgres://a' }, pool: DEFAULT_POOL } as any;
    const configB = { database: { url: 'postgres://b' }, pool: DEFAULT_POOL } as any;

    const poolA = createProjectRagPostgresSql(configA);
    const poolB = createProjectRagPostgresSql(configB);

    const closeSpyA = (poolA as unknown as { close: ReturnType<typeof vi.fn> }).close;
    const closeSpyB = (poolB as unknown as { close: ReturnType<typeof vi.fn> }).close;

    await closeProjectRagPostgresSql();

    expect(closeSpyA).toHaveBeenCalledWith({ timeout: 1 });
    expect(closeSpyB).toHaveBeenCalledWith({ timeout: 1 });
    expect(constructorCalls).toHaveLength(2);
  });

  it('closeProjectRagPostgresSql with URL closes only that pool', async () => {
    const constructorCalls: unknown[] = [];
    function MockSQL(this: { close: ReturnType<typeof vi.fn> }, options: unknown) {
      constructorCalls.push(options);
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    setBunSql(MockSQL);

    const configA = { database: { url: 'postgres://a' }, pool: DEFAULT_POOL } as any;
    const configB = { database: { url: 'postgres://b' }, pool: DEFAULT_POOL } as any;

    const poolA = createProjectRagPostgresSql(configA);
    const poolB = createProjectRagPostgresSql(configB);

    const closeSpyA = (poolA as unknown as { close: ReturnType<typeof vi.fn> }).close;
    const closeSpyB = (poolB as unknown as { close: ReturnType<typeof vi.fn> }).close;

    await closeProjectRagPostgresSql('postgres://a');

    expect(closeSpyA).toHaveBeenCalledWith({ timeout: 1 });
    expect(closeSpyB).not.toHaveBeenCalled();
    expect(constructorCalls).toHaveLength(2);

    // Pool A should be gone from cache; creating it again makes a new instance
    const poolA2 = createProjectRagPostgresSql(configA);
    expect(poolA2).not.toBe(poolA);
    expect(constructorCalls).toHaveLength(3);
  });

  describe('ingest snapshot store helpers', () => {
    // -----------------------------------------------------------------------
    // Schema readiness
    // -----------------------------------------------------------------------
    it('assertProjectRagPostgresSnapshotSchemaReady accepts existing table and all objects', async () => {
      const columnCount = SNAPSHOT_SCHEMA_COLUMNS.length;
      expect(columnCount).toBeGreaterThan(0);
      const { sql, calls } = fakeSql([
        // 1. table exists
        [{ ready: true }],
        // 2. columns (derived from SNAPSHOT_SCHEMA_COLUMNS)
        ...Array.from({ length: columnCount }, () => [{ ready: true }]),
        // 3. freeze trigger
        [{ ready: true }],
        // 4. touch trigger
        [{ ready: true }],
        // 5. partial unique index
        [{ ready: true }],
        // 6. snapshot_uuid unique constraint
        [{ ready: true }],
        // 7. fail_requires_code constraint
        [{ ready: true }],
      ]);

      await expect(assertProjectRagPostgresSnapshotSchemaReady(sql)).resolves.toBeUndefined();
      expect(calls[0]?.text).toContain('project_ingest_snapshots');
    });

    it('assertSchemaReady fails on missing table', async () => {
      const { sql } = fakeSql([[{ ready: false }]]);

      await expect(assertProjectRagPostgresSnapshotSchemaReady(sql)).rejects.toThrow(
        'migration 003'
      );
    });

    it('assertSchemaReady fails on missing column', async () => {
      const { sql } = fakeSql([
        [{ ready: true }], // table exists
        [{ ready: false }], // first column 'id' missing
      ]);

      await expect(assertProjectRagPostgresSnapshotSchemaReady(sql)).rejects.toThrow(
        "missing required column 'id'"
      );
    });

    it('assertSchemaReady fails on missing trigger', async () => {
      const { sql } = fakeSql([
        [{ ready: true }], // table exists
        ...Array.from({ length: SNAPSHOT_SCHEMA_COLUMNS.length }, () => [{ ready: true }]), // all columns
        [{ ready: false }], // freeze trigger missing
      ]);

      await expect(assertProjectRagPostgresSnapshotSchemaReady(sql)).rejects.toThrow(
        'freeze_binding_fields'
      );
    });

    it('assertSchemaReady fails on missing partial unique index', async () => {
      const { sql } = fakeSql([
        [{ ready: true }], // table
        ...Array.from({ length: SNAPSHOT_SCHEMA_COLUMNS.length }, () => [{ ready: true }]), // columns
        [{ ready: true }], // freeze trigger
        [{ ready: true }], // touch trigger
        [{ ready: false }], // index missing
      ]);

      await expect(assertProjectRagPostgresSnapshotSchemaReady(sql)).rejects.toThrow(
        'one_consuming_idx'
      );
    });

    it('assertSchemaReady fails on missing snapshot_uuid UNIQUE constraint', async () => {
      const { sql } = fakeSql([
        [{ ready: true }], // table
        ...Array.from({ length: SNAPSHOT_SCHEMA_COLUMNS.length }, () => [{ ready: true }]), // columns
        [{ ready: true }], // freeze trigger
        [{ ready: true }], // touch trigger
        [{ ready: true }], // index
        [{ ready: false }], // uuid unique constraint missing
      ]);

      await expect(assertProjectRagPostgresSnapshotSchemaReady(sql)).rejects.toThrow(
        'UNIQUE constraint on snapshot_uuid'
      );
    });

    it('assertSchemaReady fails on missing fail_requires_code constraint', async () => {
      const { sql } = fakeSql([
        [{ ready: true }], // table
        ...Array.from({ length: SNAPSHOT_SCHEMA_COLUMNS.length }, () => [{ ready: true }]), // columns
        [{ ready: true }], // freeze trigger
        [{ ready: true }], // touch trigger
        [{ ready: true }], // index
        [{ ready: true }], // uuid unique
        [{ ready: false }], // fail_requires_code missing
      ]);

      await expect(assertProjectRagPostgresSnapshotSchemaReady(sql)).rejects.toThrow(
        'fail_requires_code'
      );
    });

    // -----------------------------------------------------------------------
    // Allowlist schema readiness (migration 004)
    // -----------------------------------------------------------------------
    it('assertProjectRagPostgresAllowlistSchemaReady accepts existing columns, freeze, and CHECK constraints', async () => {
      const { sql, calls } = fakeSql([
        // 1. snapshot column: blocked_finding_allowlist_hash
        [{ ready: true }],
        // 2. snapshot column: suppressed_blocked_findings
        [{ ready: true }],
        // 3. repo column: blocked_finding_allowlist
        [{ ready: true }],
        // 4. freeze function has allowlist_hash guard
        [{ ready: true }],
        // 5-8. four CHECK constraints
        [{ ready: true }],
        [{ ready: true }],
        [{ ready: true }],
        [{ ready: true }],
        // 9. policy-race trigger on project_repositories
        [{ ready: true }],
      ]);

      await expect(assertProjectRagPostgresAllowlistSchemaReady(sql)).resolves.toBeUndefined();
      // First call is a column existence check; column name is a bind value, not in SQL text
      expect(calls[0]?.values).toContain('blocked_finding_allowlist_hash');
    });

    it('assertAllowlistSchemaReady fails on missing snapshot column', async () => {
      const { sql } = fakeSql([
        [{ ready: false }], // first column missing
      ]);

      await expect(assertProjectRagPostgresAllowlistSchemaReady(sql)).rejects.toThrow(
        'migration-004'
      );
    });

    it('assertAllowlistSchemaReady fails on missing repo column', async () => {
      const { sql } = fakeSql([
        [{ ready: true }], // snapshot column 1 ok
        [{ ready: true }], // snapshot column 2 ok
        [{ ready: false }], // repo column missing
      ]);

      await expect(assertProjectRagPostgresAllowlistSchemaReady(sql)).rejects.toThrow(
        'blocked_finding_allowlist'
      );
    });

    it('assertAllowlistSchemaReady fails on outdated freeze function', async () => {
      const { sql } = fakeSql([
        [{ ready: true }], // snapshot column 1
        [{ ready: true }], // snapshot column 2
        [{ ready: true }], // repo column
        [{ ready: false }], // freeze function lacks allowlist_hash guard
      ]);

      await expect(assertProjectRagPostgresAllowlistSchemaReady(sql)).rejects.toThrow(
        'freeze trigger function'
      );
    });

    it('assertAllowlistSchemaReady fails on missing CHECK constraint', async () => {
      const { sql } = fakeSql([
        [{ ready: true }], // snapshot column 1
        [{ ready: true }], // snapshot column 2
        [{ ready: true }], // repo column
        [{ ready: true }], // freeze function
        [{ ready: false }], // first CHECK constraint missing
      ]);

      await expect(assertProjectRagPostgresAllowlistSchemaReady(sql)).rejects.toThrow(
        'CHECK constraint'
      );
    });

    // -----------------------------------------------------------------------
    // Insert
    // -----------------------------------------------------------------------
    it('inserts a snapshot with snapshot_uuid and default PREPARED status', async () => {
      const { sql, calls } = fakeSql([
        [
          {
            id: '1',
            snapshot_uuid: '550e8400-e29b-41d4-a716-446655440000',
            project_id: '7',
            command_scope: 'full',
            root_hash: 'abc',
            scope_hash: null,
            policy_hash: null,
            inventory_hash: 'ghi',
            baseline_hash: null,
            plan_hash: null,
            adds_count: '5',
            updates_count: '3',
            deletes_count: '1',
            eligible_count: '20',
            tracked_count: '50',
            blocked_findings: [],
            blocked_finding_allowlist_hash:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            suppressed_blocked_findings: [],
            status: 'PREPARED',
            failure_code: null,
            failure_detail: null,
            ttl_seconds: '300',
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: null,
            claimed_at: null,
            consumed_at: null,
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:55:00Z',
          },
        ],
      ]);

      const snapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
        projectId: 7,
        addsCount: 5,
        updatesCount: 3,
        deletesCount: 1,
        eligibleCount: 20,
        trackedCount: 50,
        rootHash: 'abc',
        inventoryHash: 'ghi',
      });

      expect(snapshot.id).toBe(1);
      expect(snapshot.snapshotUuid).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(snapshot.projectId).toBe(7);
      expect(snapshot.status).toBe('PREPARED');
      expect(snapshot.addsCount).toBe(5);
      expect(snapshot.blockedFindingAllowlistHash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
      expect(snapshot.suppressedBlockedFindings).toEqual([]);
      expect(snapshot.leaseExpiresAt).toBeNull();
      expect(calls[0]?.text).toContain('insert into project_ingest_snapshots');
      // Verify bind: failure_code and failure_detail are null for PREPARED
      expect(calls[0]?.values).toContain('PREPARED');
    });

    it('inserts a snapshot with explicit blockedFindingAllowlistHash and suppressedBlockedFindings', async () => {
      const customHash = 'a'.repeat(64);
      const suppressedPayload = [
        {
          relativePath: 'src/secret.ts',
          category: 'dependency_dir',
          matchedAllowlistEntry: { relativePath: 'src/secret.ts', category: 'dependency_dir' },
        },
      ];
      const { sql, calls } = fakeSql([
        [
          {
            id: '5',
            snapshot_uuid: '00000000-0000-0000-0000-000000000005',
            project_id: '8',
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
            blocked_finding_allowlist_hash: customHash,
            suppressed_blocked_findings: suppressedPayload,
            status: 'PREPARED',
            failure_code: null,
            failure_detail: null,
            ttl_seconds: '300',
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: null,
            claimed_at: null,
            consumed_at: null,
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:55:00Z',
          },
        ],
      ]);

      const snapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
        projectId: 8,
        blockedFindingAllowlistHash: customHash,
        suppressedBlockedFindings: suppressedPayload,
      });

      expect(snapshot.id).toBe(5);
      expect(snapshot.blockedFindingAllowlistHash).toBe(customHash);
      expect(snapshot.suppressedBlockedFindings).toEqual(suppressedPayload);
      // Verify both new fields appear in the INSERT bind values
      expect(calls[0]?.values).toContain(customHash);
      const suppressedBind = calls[0]?.values.find(
        (v) => typeof v === 'string' && v.includes('dependency_dir')
      );
      expect(suppressedBind).toBeDefined();
    });

    it('insert throws when RETURNING yields no row', async () => {
      const { sql } = fakeSql([[]]);

      await expect(insertProjectRagPostgresIngestSnapshot(sql, { projectId: 7 })).rejects.toThrow(
        'returned no row'
      );
    });

    // -----------------------------------------------------------------------
    // Find
    // -----------------------------------------------------------------------
    it('finds a snapshot by id and projectId', async () => {
      const { sql, calls } = fakeSql([
        [
          {
            id: '3',
            snapshot_uuid: '00000000-0000-0000-0000-000000000001',
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
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: null,
            claimed_at: null,
            consumed_at: null,
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:55:00Z',
          },
        ],
      ]);

      const snapshot = await findProjectRagPostgresIngestSnapshot(sql, 7, 3);

      expect(snapshot?.id).toBe(3);
      expect(snapshot?.projectId).toBe(7);
      expect(snapshot?.snapshotUuid).toBe('00000000-0000-0000-0000-000000000001');
      expect(snapshot?.blockedFindingAllowlistHash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
      expect(snapshot?.suppressedBlockedFindings).toEqual([]);
      expect(calls[0]?.text).toContain('where id = ?');
      expect(calls[0]?.text).toContain('project_id = ?');
      expect(calls[0]?.values).toEqual([3, 7]);
    });

    it('finds a snapshot by UUID', async () => {
      const { sql, calls } = fakeSql([
        [
          {
            id: '3',
            snapshot_uuid: '00000000-0000-0000-0000-000000000001',
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
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: null,
            claimed_at: null,
            consumed_at: null,
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:55:00Z',
          },
        ],
      ]);

      const snapshot = await findProjectRagPostgresIngestSnapshotByUuid(
        sql,
        7,
        '00000000-0000-0000-0000-000000000001'
      );

      expect(snapshot?.id).toBe(3);
      expect(snapshot?.blockedFindingAllowlistHash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
      expect(calls[0]?.text).toContain('snapshot_uuid');
      expect(calls[0]?.values).toContain('00000000-0000-0000-0000-000000000001');
    });

    it('find returns undefined when snapshot is not found', async () => {
      const { sql } = fakeSql([[]]);
      const snapshot = await findProjectRagPostgresIngestSnapshot(sql, 7, 999);
      expect(snapshot).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // List
    // -----------------------------------------------------------------------
    it('lists snapshots for a project in descending order', async () => {
      const { sql, calls } = fakeSql([
        [
          {
            id: '2',
            snapshot_uuid: '00000000-0000-0000-0000-000000000002',
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
            status: 'CONSUMED',
            failure_code: null,
            failure_detail: null,
            ttl_seconds: '300',
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: null,
            claimed_at: '2026-07-15T13:56:00Z',
            consumed_at: '2026-07-15T13:57:00Z',
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:57:00Z',
          },
        ],
      ]);

      const snapshots = await listProjectRagPostgresIngestSnapshots(sql, 7, { limit: 5 });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.id).toBe(2);
      expect(snapshots[0]?.status).toBe('CONSUMED');
      expect(snapshots[0]?.consumedAt).toBeTruthy();
      expect(snapshots[0]?.blockedFindingAllowlistHash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
      expect(snapshots[0]?.suppressedBlockedFindings).toEqual([]);
      expect(calls[0]?.text).toContain('order by created_at desc');
    });

    it('lists snapshots filtered by status', async () => {
      const { sql, calls } = fakeSql([[]]);

      const snapshots = await listProjectRagPostgresIngestSnapshots(sql, 7, {
        status: 'PREPARED',
        limit: 5,
      });

      expect(snapshots).toEqual([]);
      expect(calls[0]?.text).toContain('status = ?');
      expect(calls[0]?.values).toContain('PREPARED');
    });

    // -----------------------------------------------------------------------
    // Claim
    // -----------------------------------------------------------------------
    it('claims a PREPARED unexpired snapshot and sets lease_expires_at', async () => {
      const { sql, calls } = fakeSql([
        [
          {
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
            status: 'CONSUMING',
            failure_code: null,
            failure_detail: null,
            ttl_seconds: '300',
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: '2026-07-15T14:05:00Z',
            claimed_at: '2026-07-15T13:56:00Z',
            consumed_at: null,
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:56:00Z',
          },
        ],
      ]);

      const snapshot = await claimProjectRagPostgresIngestSnapshot(sql, 7, 1);

      expect(snapshot?.status).toBe('CONSUMING');
      expect(snapshot?.claimedAt).toBeTruthy();
      expect(snapshot?.leaseExpiresAt).toBeTruthy();
      expect(calls[0]?.text).toContain("set status = 'CONSUMING'");
      expect(calls[0]?.text).toContain("status = 'PREPARED'");
      expect(calls[0]?.text).toContain('expires_at > now()');
      expect(calls[0]?.text).toContain('lease_expires_at');
      expect(calls[0]?.values).toContain(1);
      expect(calls[0]?.values).toContain(7);
    });

    it('claims by snapshot UUID', async () => {
      const { sql, calls } = fakeSql([
        [
          {
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
            status: 'CONSUMING',
            failure_code: null,
            failure_detail: null,
            ttl_seconds: '300',
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: '2026-07-15T14:05:00Z',
            claimed_at: '2026-07-15T13:56:00Z',
            consumed_at: null,
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:56:00Z',
          },
        ],
      ]);

      const snapshot = await claimProjectRagPostgresIngestSnapshotByUuid(
        sql,
        7,
        '550e8400-e29b-41d4-a716-446655440000'
      );

      expect(snapshot?.status).toBe('CONSUMING');
      expect(calls[0]?.text).toContain('snapshot_uuid');
      expect(calls[0]?.values).toContain('550e8400-e29b-41d4-a716-446655440000');
    });

    it('claim returns undefined when no row matches', async () => {
      const { sql } = fakeSql([[]]);
      const snapshot = await claimProjectRagPostgresIngestSnapshot(sql, 7, 1);
      expect(snapshot).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Consume
    // -----------------------------------------------------------------------
    it('completes a CONSUMING snapshot to CONSUMED', async () => {
      const { sql, calls } = fakeSql([
        [
          {
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
            status: 'CONSUMED',
            failure_code: null,
            failure_detail: null,
            ttl_seconds: '300',
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: null,
            claimed_at: '2026-07-15T13:56:00Z',
            consumed_at: '2026-07-15T13:57:00Z',
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:57:00Z',
          },
        ],
      ]);

      const snapshot = await consumeProjectRagPostgresIngestSnapshot(
        sql,
        7,
        1,
        '550e8400-e29b-41d4-a716-446655440000'
      );

      expect(snapshot?.status).toBe('CONSUMED');
      expect(snapshot?.consumedAt).toBeTruthy();
      expect(calls[0]?.text).toContain("set status = 'CONSUMED'");
      expect(calls[0]?.text).toContain("status = 'CONSUMING'");
      // Must require a live lease (wall-clock inside the ownership transaction)
      expect(calls[0]?.text).toContain('lease_expires_at is not null');
      expect(calls[0]?.text).toContain('lease_expires_at > clock_timestamp()');
    });

    it('returns undefined when update returns no row', async () => {
      const { sql } = fakeSql([[]]);
      const snapshot = await consumeProjectRagPostgresIngestSnapshot(
        sql,
        7,
        1,
        '550e8400-e29b-41d4-a716-446655440000'
      );
      expect(snapshot).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Fail
    // -----------------------------------------------------------------------
    it('fails a CONSUMING snapshot with failure code', async () => {
      const { sql, calls } = fakeSql([
        [
          {
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
            status: 'FAILED',
            failure_code: 'RESCAN_MISMATCH',
            failure_detail: 'baseline hash changed after claim',
            ttl_seconds: '300',
            expires_at: '2026-07-15T14:00:00Z',
            lease_expires_at: null,
            claimed_at: '2026-07-15T13:56:00Z',
            consumed_at: null,
            failed_at: '2026-07-15T13:58:00Z',
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:58:00Z',
          },
        ],
      ]);

      const snapshot = await failProjectRagPostgresIngestSnapshot(
        sql,
        7,
        1,
        'RESCAN_MISMATCH',
        'baseline hash changed after claim'
      );

      expect(snapshot?.status).toBe('FAILED');
      expect(snapshot?.failureCode).toBe('RESCAN_MISMATCH');
      expect(snapshot?.failureDetail).toBe('baseline hash changed after claim');
      expect(calls[0]?.text).toContain("set status = 'FAILED'");
      expect(calls[0]?.text).toContain('failure_code = ?');
      expect(calls[0]?.values).toContain('RESCAN_MISMATCH');
    });

    it('returns undefined when fail update matches no row', async () => {
      const { sql } = fakeSql([[]]);
      const snapshot = await failProjectRagPostgresIngestSnapshot(
        sql,
        7,
        1,
        'PRECONDITION_FAILURE'
      );
      expect(snapshot).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Lease renewal
    // -----------------------------------------------------------------------
    it('renew requires status CONSUMING and lease_expires_at > now()', async () => {
      const { sql, calls } = fakeSql([
        [
          {
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
            status: 'CONSUMING',
            failure_code: null,
            failure_detail: null,
            lease_expires_at: '2026-07-15T14:05:00Z',
            ttl_seconds: '300',
            expires_at: '2026-07-15T14:00:00Z',
            claimed_at: '2026-07-15T13:56:00Z',
            consumed_at: null,
            failed_at: null,
            created_at: '2026-07-15T13:55:00Z',
            updated_at: '2026-07-15T13:56:00Z',
          },
        ],
      ]);

      const snapshot = await renewProjectRagPostgresIngestSnapshotLease(
        sql,
        7,
        1,
        '550e8400-e29b-41d4-a716-446655440000'
      );

      expect(snapshot?.status).toBe('CONSUMING');
      expect(calls[0]?.text).toContain('snapshot_uuid = ?::uuid');
      expect(calls[0]?.text).toContain("status = 'CONSUMING'");
      expect(calls[0]?.text).toContain('lease_expires_at > now()');
      expect(calls[0]?.values).toContain(1);
      expect(calls[0]?.values).toContain(7);
    });

    it('renew returns undefined when no row matches', async () => {
      const { sql } = fakeSql([[]]);
      const snapshot = await renewProjectRagPostgresIngestSnapshotLease(
        sql,
        7,
        1,
        '550e8400-e29b-41d4-a716-446655440000'
      );
      expect(snapshot).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Sweep
    // -----------------------------------------------------------------------
    it('sweep returns expired and abandoned snapshots with ids', async () => {
      const { sql, calls } = fakeSql([
        // Pass 1: expired PREPARED/REVIEW_REQUIRED
        [{ id: '1' }, { id: '2' }],
        // Pass 2: abandoned CONSUMING
        [{ id: '3' }],
      ]);

      const result = await sweepStaleProjectRagPostgresIngestSnapshots(sql, 7);

      expect(result.expiredCount).toBe(2);
      expect(result.expiredIds).toEqual([1, 2]);
      expect(result.abandonedCount).toBe(1);
      expect(result.abandonedIds).toEqual([3]);

      // Pass 1 SQL shape
      expect(calls[0]?.text).toContain("set status = 'EXPIRED'");
      expect(calls[0]?.text).toContain("status IN ('PREPARED', 'REVIEW_REQUIRED')");
      expect(calls[0]?.text).toContain('expires_at <= now()');
      // Pass 2 SQL shape
      expect(calls[1]?.text).toContain("set status = 'FAILED'");
      expect(calls[1]?.text).toContain("failure_code = 'CLAIM_LEASE_ABANDONED'");
      expect(calls[1]?.text).toContain("status = 'CONSUMING'");
      expect(calls[1]?.text).toContain('lease_expires_at is not null');
      expect(calls[1]?.text).toContain('lease_expires_at <= now()');
    });

    it('sweep returns zero counts when nothing is stale', async () => {
      const { sql } = fakeSql([[], []]);

      const result = await sweepStaleProjectRagPostgresIngestSnapshots(sql, 7);

      expect(result.expiredCount).toBe(0);
      expect(result.expiredIds).toEqual([]);
      expect(result.abandonedCount).toBe(0);
      expect(result.abandonedIds).toEqual([]);
    });

    it('sweep only returns ids from abandoned pass when only CONSUMING is stale', async () => {
      const { sql } = fakeSql([
        [], // pass 1: no expired PREPARED/REVIEW_REQUIRED
        [{ id: '5' }], // pass 2: one abandoned CONSUMING
      ]);

      const result = await sweepStaleProjectRagPostgresIngestSnapshots(sql, 7);

      expect(result.expiredCount).toBe(0);
      expect(result.abandonedCount).toBe(1);
      expect(result.abandonedIds).toEqual([5]);
    });

    it('runs the project-scoped sweep on a transaction handle without begin ownership', async () => {
      const { sql, calls } = fakeSql([[{ id: '5' }], []]);
      const transaction = sql as unknown as Record<string, unknown>;
      const originalBegin = transaction.begin;
      transaction.begin = () => {
        throw new Error('nested transaction ownership is forbidden');
      };
      try {
        await sweepStaleProjectRagPostgresIngestSnapshotsInTransaction(
          sql as Bun.TransactionSQL,
          7
        );
      } finally {
        transaction.begin = originalBegin;
      }
      expect(calls).toHaveLength(2);
      expect(calls[0]?.text).toContain('project_id = ?');
      expect(calls[1]?.text).toContain('project_id = ?');
      expect(calls[0]?.values).toContain(7);
      expect(calls[1]?.values).toContain(7);
    });
  });
});
