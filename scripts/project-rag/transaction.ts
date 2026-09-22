/**
 * Sole owner of top-level Project RAG transactions.
 *
 * Repository mutators never call `sql.begin()` themselves.  They either:
 *  - accept a {@link ProjectRagWriteSql} transaction handle and run strictly
 *    inside a transaction opened by this module (the `*InTransaction`
 *    contract), or
 *  - are thin standalone wrappers that open exactly one unit through
 *    {@link beginProjectRagWrite} / {@link beginProjectRagFencedWrite}.
 *
 * The fenced variant validates the durable-job lease with
 * `lease_expires_at > clock_timestamp()` (real wall clock, not the
 * transaction-start snapshot of `now()`) while holding the job row
 * `FOR UPDATE`, so fence ownership and every protected mutation commit in one
 * atomic unit.  A worker whose job was reclaimed writes nothing: its unit
 * rejects before the first mutation and rolls back anything already staged.
 */

import { acquireProjectRagWriteFence } from '../db-migrations/write-fence.js';

/** A write executor that is always a live Postgres transaction handle. */
export type ProjectRagWriteSql = Bun.TransactionSQL;

/** Durable-job ownership checked at the start of a fenced mutation unit. */
export interface ProjectRagTransactionFence {
  readonly jobId: number;
  readonly fenceToken: number;
}

/** Exact claimed-snapshot ownership checked around one protected mutation. */
export interface ProjectRagSnapshotFence {
  readonly projectId: number;
  readonly snapshotId: number;
  readonly snapshotUuid: string;
  /** A terminal transition intentionally changes the live snapshot status. */
  readonly terminalTransition?: 'FAILED' | 'CONSUMED';
}

/** Raised when a claimed snapshot is no longer live for a protected unit. */
export class ProjectRagSnapshotLeaseLostError extends Error {
  readonly code = 'PROJECT_RAG_SNAPSHOT_LEASE_LOST';

  constructor(snapshotId: number) {
    super(`Project RAG ingest snapshot lease was lost before mutation (id=${snapshotId})`);
    this.name = 'ProjectRagSnapshotLeaseLostError';
  }
}

function assertNotActiveTransaction(sql: Bun.SQL, callerName: string): void {
  if (typeof (sql as unknown as { savepoint?: unknown })?.savepoint === 'function') {
    throw new Error(
      `NESTED_TRANSACTION_FORBIDDEN: ${callerName} cannot be called inside an existing transaction. Use *InTransaction helpers with the current transaction handle.`
    );
  }
}

/**
 * Run one mutation as its own top-level transaction.  This is the only place
 * Project RAG opens a plain write transaction.
 */
export async function beginProjectRagWrite<T>(
  sql: Bun.SQL,
  operation: (tx: ProjectRagWriteSql) => Promise<T>,
  snapshotFence?: ProjectRagSnapshotFence
): Promise<T> {
  assertNotActiveTransaction(sql, 'beginProjectRagWrite');
  return sql.begin(async (tx) => {
    await acquireProjectRagWriteFence(tx);
    await assertLiveProjectRagSnapshot(tx, snapshotFence);
    const result = await operation(tx);
    await assertSnapshotAfterMutation(tx, snapshotFence);
    return result;
  });
}

async function assertLiveProjectRagSnapshot(
  tx: ProjectRagWriteSql,
  snapshotFence: ProjectRagSnapshotFence | undefined
): Promise<void> {
  if (!snapshotFence) return;
  const rows = (await tx`
    select id
    from project_ingest_snapshots
    where id = ${snapshotFence.snapshotId}
      and project_id = ${snapshotFence.projectId}
      and snapshot_uuid = ${snapshotFence.snapshotUuid}::uuid
      and status = 'CONSUMING'
      and lease_expires_at is not null
      and lease_expires_at > clock_timestamp()
    for update
  `) as Array<Record<string, unknown>>;
  if (!rows[0]) {
    throw new ProjectRagSnapshotLeaseLostError(snapshotFence.snapshotId);
  }
}

async function assertSnapshotAfterMutation(
  tx: ProjectRagWriteSql,
  snapshotFence: ProjectRagSnapshotFence | undefined
): Promise<void> {
  if (!snapshotFence) return;
  if (snapshotFence.terminalTransition === undefined) {
    await assertLiveProjectRagSnapshot(tx, snapshotFence);
    return;
  }

  const rows = (await tx`
    select id
    from project_ingest_snapshots
    where id = ${snapshotFence.snapshotId}
      and project_id = ${snapshotFence.projectId}
      and snapshot_uuid = ${snapshotFence.snapshotUuid}::uuid
      and status = ${snapshotFence.terminalTransition}
      and lease_expires_at is not null
      and lease_expires_at > clock_timestamp()
    for update
  `) as Array<Record<string, unknown>>;
  if (!rows[0]) {
    throw new ProjectRagSnapshotLeaseLostError(snapshotFence.snapshotId);
  }
}

/**
 * Run one mutation inside a transaction that first locks and validates the
 * current durable-job fence.  Ownership validation and the operation commit
 * atomically — there is no reclaim window between the check and the writes.
 *
 * When `fence` is undefined (foreground execution) this behaves exactly like
 * {@link beginProjectRagWrite}.
 *
 * @param lostMessage - Error thrown when the fence is no longer live; the
 *                      unit rolls back and nothing is written.
 */
export async function beginProjectRagFencedWrite<T>(
  sql: Bun.SQL,
  fence: ProjectRagTransactionFence | undefined,
  lostMessage: string,
  operation: (tx: ProjectRagWriteSql) => Promise<T>,
  beforeCommit?: (tx: ProjectRagWriteSql, result: T) => Promise<void>,
  snapshotFence?: ProjectRagSnapshotFence
): Promise<T> {
  assertNotActiveTransaction(sql, 'beginProjectRagFencedWrite');
  if (!fence) {
    return beginProjectRagWrite(
      sql,
      async (tx) => {
        const result = await operation(tx);
        await beforeCommit?.(tx, result);
        return result;
      },
      snapshotFence
    );
  }
  return sql.begin(async (tx) => {
    await acquireProjectRagWriteFence(tx);
    const ownership = (await tx`
      select id from project_jobs
      where id = ${fence.jobId} and status = 'running'
        and fence_token = ${fence.fenceToken}
        and lease_expires_at > clock_timestamp()
      for update
    `) as Array<Record<string, unknown>>;
    if (!ownership[0]) {
      throw new Error(lostMessage);
    }
    await assertLiveProjectRagSnapshot(tx, snapshotFence);
    const result = await operation(tx);
    await assertSnapshotAfterMutation(tx, snapshotFence);
    // Re-check wall-clock lease liveness after the protected operation. A
    // transaction-start `now()` snapshot is insufficient here: a long
    // operation must roll back rather than commit after its lease expires.
    const stillOwned = (await tx`
      select id from project_jobs
      where id = ${fence.jobId} and status = 'running'
        and fence_token = ${fence.fenceToken}
        and lease_expires_at > clock_timestamp()
      for update
    `) as Array<Record<string, unknown>>;
    if (!stillOwned[0]) {
      throw new Error(lostMessage);
    }
    // Durable finalizers close the job only after this final liveness check.
    // The terminal update itself repeats the live-fence predicate, so an
    // expiry between the check and that update still rolls back the unit.
    await beforeCommit?.(tx, result);
    await assertSnapshotAfterMutation(tx, snapshotFence);
    return result;
  });
}
