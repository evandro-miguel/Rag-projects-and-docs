/**
 * Opt-in real-Postgres regression for native preparation environment
 * isolation. The suite only reads the two supplied disposable databases.
 *
 * Set PROJECT_RAG_PREPARE_ENV_ISOLATION_TEST=1 together with
 * PROJECT_RAG_PREPARE_DATABASE_A_URL and PROJECT_RAG_PREPARE_DATABASE_B_URL.
 * The process-owned PROJECT_RAG_DATABASE_URL must point at database B; the
 * request then attempts to select database A and must be rejected before any
 * native runtime, registration, durable job, or ingest action runs.
 */

import { describe, expect, it } from 'vitest';
import { resolveProjectRagPostgresConfig } from './config.js';
import { prepareProject } from './prepare.js';
import { closeProjectRagPostgresSql, createProjectRagPostgresSql } from './store.js';

const RUN_REAL_ENV_ISOLATION = process.env.PROJECT_RAG_PREPARE_ENV_ISOLATION_TEST === '1';
const describeReal = RUN_REAL_ENV_ISOLATION ? describe : describe.skip;

function assertDisposableDatabaseUrl(raw: string, label: string): void {
  const parsed = new URL(raw);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must use a loopback host`);
  }
  if (!database.startsWith('rag_v2_migration_')) {
    throw new Error(`${label} must use a disposable migration database`);
  }
}

async function readScopedCounts(databaseUrl: string, rootPath: string) {
  const sql = createProjectRagPostgresSql(
    resolveProjectRagPostgresConfig({ PROJECT_RAG_DATABASE_URL: databaseUrl })
  );
  try {
    const [row] = (await sql`
      with repositories as (
        select id
        from project_repositories
        where normalized_root_path = ${rootPath} or root_path = ${rootPath}
      )
      select
        (select count(*) from repositories) as repositories,
        (select count(*) from project_jobs j
          where j.project_id in (select id from repositories)
             or j.payload->>'rootPath' = ${rootPath}) as jobs,
        (select count(*) from project_index_builds b
          where b.project_id in (select id from repositories)) as builds,
        (select count(*) from project_files f
          where f.project_id in (select id from repositories)) as files,
        (select count(*) from project_chunks c
          where c.project_id in (select id from repositories)) as chunks,
        (select count(*) from project_embeddings_1024 e
          where e.project_id in (select id from repositories)) as embeddings
    `) as Array<Record<string, unknown>>;
    return {
      repositories: Number(row?.repositories ?? 0),
      jobs: Number(row?.jobs ?? 0),
      builds: Number(row?.builds ?? 0),
      files: Number(row?.files ?? 0),
      chunks: Number(row?.chunks ?? 0),
      embeddings: Number(row?.embeddings ?? 0),
    };
  } finally {
    await closeProjectRagPostgresSql(databaseUrl);
  }
}

describeReal('Project RAG preparation environment isolation (real Postgres)', () => {
  it('rejects DB A against process-owned DB B before either lane receives writes', async () => {
    const databaseA = process.env.PROJECT_RAG_PREPARE_DATABASE_A_URL;
    const databaseB = process.env.PROJECT_RAG_PREPARE_DATABASE_B_URL;
    if (!databaseA || !databaseB) {
      throw new Error(
        'PROJECT_RAG_PREPARE_DATABASE_A_URL and PROJECT_RAG_PREPARE_DATABASE_B_URL are required'
      );
    }
    assertDisposableDatabaseUrl(databaseA, 'database A');
    assertDisposableDatabaseUrl(databaseB, 'database B');
    const processDatabase =
      process.env.PROJECT_RAG_DATABASE_URL ??
      process.env.PROJECT_RAG_POSTGRES_URL ??
      process.env.POSTGRES_URL ??
      process.env.DATABASE_URL;
    expect(processDatabase).toBe(databaseB);

    const rootPath = process.cwd();
    const beforeA = await readScopedCounts(databaseA, rootPath);
    const beforeB = await readScopedCounts(databaseB, rootPath);
    const requestEnv = {
      ...process.env,
      PROJECT_RAG_TRUSTED_ROOTS: rootPath,
      PROJECT_RAG_DATABASE_URL: databaseA,
    };

    await expect(
      prepareProject({
        rootPath,
        project: `prepare-env-isolation-${process.pid}`,
        runtime: { env: requestEnv },
      })
    ).rejects.toMatchObject({ code: 'RUNTIME_OWNERSHIP_CONFLICT' });

    await expect(readScopedCounts(databaseA, rootPath)).resolves.toEqual(beforeA);
    await expect(readScopedCounts(databaseB, rootPath)).resolves.toEqual(beforeB);
  });
});
