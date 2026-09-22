import { describe, expect, it, vi } from 'vitest';
import {
  beginProjectRagFencedWrite,
  beginProjectRagWrite,
  type ProjectRagWriteSql,
} from './transaction.js';

interface FakeTransactionOptions {
  readonly lockResult?: boolean;
  readonly ownershipResults?: number[];
  readonly snapshotResults?: Array<number | undefined>;
}

function fakeSql(options: FakeTransactionOptions = {}) {
  const statements: string[] = [];
  const ownershipResults = [...(options.ownershipResults ?? [1, 1])];
  const snapshotResults = [...(options.snapshotResults ?? [])];

  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push(text);
    if (text.includes('pg_try_advisory_xact_lock_shared')) {
      return [{ locked: options.lockResult ?? true }];
    }
    if (text.includes('to_regclass')) {
      return [{ relation: 'public.rag_migration_maintenance' }];
    }
    if (text.includes('from project_jobs') && text.includes('for update')) {
      const id = ownershipResults.shift();
      return id === undefined ? [] : [{ id }];
    }
    if (text.includes('from project_ingest_snapshots') && text.includes('for update')) {
      const id = snapshotResults.shift();
      return id === undefined ? [] : [{ id }];
    }
    void values;
    return [];
  }) as unknown as ProjectRagWriteSql;

  const sql = {
    begin: async <T>(operation: (transaction: ProjectRagWriteSql) => Promise<T>): Promise<T> => {
      try {
        return await operation(tx);
      } catch (error) {
        statements.push('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Bun.SQL;

  return { sql, statements };
}

describe('Project RAG write transaction fence', () => {
  it('acquires the migration fence before operation SQL', async () => {
    const { sql, statements } = fakeSql();
    const operation = vi.fn(async (tx: ProjectRagWriteSql) => {
      await tx`insert into project_files (project_id) values (${7})`;
      return 'ok';
    });

    await expect(beginProjectRagWrite(sql, operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledOnce();
    expect(statements[0]).toContain('pg_try_advisory_xact_lock_shared');
    expect(statements[1]).toContain('to_regclass');
    expect(statements[2]).toContain('from public.rag_migration_maintenance');
    expect(statements[3]).toContain('insert into project_files');
  });

  it('fails closed with a bounded migration-lock error before DML', async () => {
    const { sql, statements } = fakeSql({ lockResult: false });
    const operation = vi.fn(async () => 'written');

    await expect(beginProjectRagWrite(sql, operation)).rejects.toMatchObject({
      code: 'MIGRATION_LOCK_BUSY',
      message: 'Project RAG writes are unavailable while database migrations are running',
    });
    expect(operation).not.toHaveBeenCalled();
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('pg_try_advisory_xact_lock_shared');
    expect(statements[1]).toBe('ROLLBACK');
  });

  it('keeps the shared fence ahead of durable-job ownership and revalidation', async () => {
    const { sql, statements } = fakeSql();

    await beginProjectRagFencedWrite(
      sql,
      { jobId: 17, fenceToken: 4 },
      'lease lost',
      async (tx) => {
        await tx`update project_files set status = 'indexed' where id = ${9}`;
      }
    );

    expect(statements[0]).toContain('pg_try_advisory_xact_lock_shared');
    expect(statements[1]).toContain('to_regclass');
    expect(statements[2]).toContain('from public.rag_migration_maintenance');
    expect(statements[3]).toContain('from project_jobs');
    expect(statements[4]).toContain('update project_files');
    expect(statements[5]).toContain('from project_jobs');
  });

  it('rolls back the fenced unit when a protected mutation fails', async () => {
    const { sql, statements } = fakeSql();

    await expect(
      beginProjectRagFencedWrite(sql, { jobId: 17, fenceToken: 4 }, 'lease lost', async (tx) => {
        await tx`insert into project_files (project_id) values (${7})`;
        throw new Error('injected failure');
      })
    ).rejects.toThrow('injected failure');

    expect(statements[0]).toContain('pg_try_advisory_xact_lock_shared');
    expect(statements[1]).toContain('to_regclass');
    expect(statements[2]).toContain('from public.rag_migration_maintenance');
    expect(statements[3]).toContain('from project_jobs');
    expect(statements[4]).toContain('insert into project_files');
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('checks exact claimed snapshot identity before and after a short mutation', async () => {
    const { sql, statements } = fakeSql({ snapshotResults: [42, 42] });
    const operation = vi.fn(async (tx: ProjectRagWriteSql) => {
      await tx`update project_files set status = 'indexed' where id = ${9}`;
      return 'written';
    });

    await expect(
      beginProjectRagFencedWrite(sql, undefined, 'snapshot lease lost', operation, undefined, {
        projectId: 7,
        snapshotId: 42,
        snapshotUuid: '11111111-1111-4111-8111-111111111111',
      })
    ).resolves.toBe('written');

    const snapshotStatements = statements.filter((statement) =>
      statement.includes('from project_ingest_snapshots')
    );
    expect(snapshotStatements).toHaveLength(2);
    expect(snapshotStatements[0]).toContain('project_id = ?');
    expect(snapshotStatements[0]).toContain('snapshot_uuid = ?::uuid');
    expect(snapshotStatements[0]).toContain("status = 'CONSUMING'");
    expect(snapshotStatements[0]).toContain('lease_expires_at > clock_timestamp()');
    expect(snapshotStatements[0]).toContain('for update');
    expect(statements.at(-1)).toContain('from project_ingest_snapshots');
  });

  it('verifies an explicit terminal failure transition and live lease after the mutation', async () => {
    const { sql, statements } = fakeSql({ snapshotResults: [42, 42] });

    await expect(
      beginProjectRagFencedWrite(
        sql,
        undefined,
        'snapshot lease lost',
        async (tx) => {
          await tx`update project_ingest_snapshots set status = 'FAILED' where id = ${42}`;
        },
        undefined,
        {
          projectId: 7,
          snapshotId: 42,
          snapshotUuid: '11111111-1111-4111-8111-111111111111',
          terminalTransition: 'FAILED',
        }
      )
    ).resolves.toBeUndefined();

    const snapshotStatements = statements.filter((statement) =>
      statement.includes('from project_ingest_snapshots')
    );
    expect(snapshotStatements).toHaveLength(2);
    expect(snapshotStatements[1]).toContain('status = ?');
    expect(snapshotStatements[1]).toContain('lease_expires_at > clock_timestamp()');
  });

  it('rejects a terminal transition when the exact terminal row is not returned', async () => {
    const { sql, statements } = fakeSql({ snapshotResults: [42, undefined] });

    await expect(
      beginProjectRagFencedWrite(
        sql,
        undefined,
        'snapshot lease lost',
        async (tx) => {
          await tx`update project_ingest_snapshots set status = 'CONSUMED' where id = ${42}`;
        },
        undefined,
        {
          projectId: 7,
          snapshotId: 42,
          snapshotUuid: '11111111-1111-4111-8111-111111111111',
          terminalTransition: 'CONSUMED',
        }
      )
    ).rejects.toThrow('Project RAG ingest snapshot lease was lost');

    const snapshotStatements = statements.filter((statement) =>
      statement.includes('from project_ingest_snapshots')
    );
    expect(snapshotStatements[1]).toContain('status = ?');
    expect(snapshotStatements[1]).toContain('lease_expires_at is not null');
  });
});
