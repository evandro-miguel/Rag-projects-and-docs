/**
 * Shared Project RAG write fence.
 *
 * Migration runners take the matching session-level exclusive advisory lock
 * and persist a maintenance marker. Project writes take this transaction-
 * scoped shared lock as their first statement and then check the marker before
 * any DML. The marker is independent of the migration connection, so a
 * crashed migration remains closed until an explicitly recovered run removes
 * it after its durable success audit.
 */

/** One fixed database-global lock key shared by migration and Project writes. */
export const MIGRATION_LOCK_KEY = 8675309001;

/** Durable marker relation used to keep writers closed after connection loss. */
export const MIGRATION_MAINTENANCE_TABLE = 'public.rag_migration_maintenance';
export const MIGRATION_MAINTENANCE_MARKER_ID = 1;

export const MIGRATION_LOCK_BUSY = 'MIGRATION_LOCK_BUSY' as const;

/** Bounded, credential-free error returned when the migration fence is held. */
export class ProjectRagMigrationLockBusyError extends Error {
  readonly code = MIGRATION_LOCK_BUSY;

  constructor() {
    super('Project RAG writes are unavailable while database migrations are running');
    this.name = 'ProjectRagMigrationLockBusyError';
  }
}

export function isProjectRagMigrationLockBusyError(
  error: unknown
): error is ProjectRagMigrationLockBusyError {
  return error instanceof ProjectRagMigrationLockBusyError;
}

/**
 * Acquire the transaction-scoped shared migration fence.
 *
 * This must remain the first statement in every Project write transaction.
 * `pg_try_advisory_xact_lock_shared` never waits for an exclusive migration
 * lock; a false result is converted to the bounded domain error above.
 */
export async function acquireProjectRagWriteFence(tx: Bun.TransactionSQL): Promise<void> {
  const rows = (await tx`
    select pg_try_advisory_xact_lock_shared(${MIGRATION_LOCK_KEY}::bigint) as locked
  `) as Array<Record<string, unknown>>;

  if (rows[0]?.locked !== true) {
    throw new ProjectRagMigrationLockBusyError();
  }

  const relationRows = (await tx`
    select to_regclass(${MIGRATION_MAINTENANCE_TABLE}) as relation
  `) as Array<Record<string, unknown>>;
  if (!relationRows[0]?.relation) {
    // Older databases have no marker relation yet. Absence means no active
    // maintenance operation without issuing a query that would abort the
    // current transaction.
    return;
  }

  const markerRows = (await tx`
    select operation_id
    from public.rag_migration_maintenance
    where id = ${MIGRATION_MAINTENANCE_MARKER_ID}
  `) as Array<Record<string, unknown>>;
  if (markerRows.length > 0) {
    throw new ProjectRagMigrationLockBusyError();
  }
}
