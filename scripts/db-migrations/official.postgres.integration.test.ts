/**
 * Opt-in real-Postgres proof for the official migration write fence.
 *
 * The suite owns a disposable pgvector/Postgres target by default. An
 * explicitly supplied target is accepted only when it is loopback-bound,
 * non-official, and named with the suite's disposable prefix. Nothing in this
 * file points at the official RAG databases or containers.
 *
 * Run with `RAG_OFFICIAL_POSTGRES_INTEGRATION=1 bun --bun x vitest run
 * scripts/db-migrations/official.postgres.integration.test.ts`. Set
 * RAG_OFFICIAL_POSTGRES_DATABASE_URL only to provide an already-running
 * disposable target; otherwise the suite starts and removes its own one.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocsRagLabConfig } from '../docs-rag/config.js';
import {
  buildDocsRagSourceGenerationKey,
  createDocsRagSourceGeneration,
} from '../docs-rag/store.js';
import { beginProjectRagWrite } from '../project-rag/transaction.js';
import { readDrainObservation } from './official.js';
import {
  acquireMigrationLock,
  adaptReservedSql,
  assertDisposableMigrationTarget,
  canonicalizeMigrationTarget,
  type LoadedMigration,
  loadManifest,
  releaseMigrationLock,
  runAdopt,
  runApply,
  runStatus,
} from './runner.js';
import { MIGRATION_LOCK_BUSY, MIGRATION_MAINTENANCE_TABLE } from './write-fence.js';

const RUN_REAL_DB = process.env.RAG_OFFICIAL_POSTGRES_INTEGRATION === '1';
const describeReal = RUN_REAL_DB ? describe : describe.skip;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PG_IMAGE = 'pgvector/pgvector:pg16';
const DB_NAME_PREFIX = 'rag_v2_migration_official_lock';
const RESOURCE_TOKEN = `${Date.now().toString(36)}${process.pid.toString(36)}${Math.floor(
  Math.random() * 1296
).toString(36)}`;
const CONTAINER_NAME = `${DB_NAME_PREFIX}_${RESOURCE_TOKEN}`;
const VOLUME_NAME = `${DB_NAME_PREFIX}_${RESOURCE_TOKEN}`;
const DB_NAME = `${DB_NAME_PREFIX}_${RESOURCE_TOKEN}`;
const PG_USER = 'postgres';
const STARTUP_TIMEOUT_MS = 120_000;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function docker(...args: readonly string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      stderr += String(error);
      resolvePromise({ code: 127, stdout, stderr });
    });
    child.on('close', (code: number | null) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => rejectPromise(new Error('could not obtain a loopback port')));
        return;
      }
      server.close(() => resolvePromise(address.port));
    });
  });
}

function createSql(url: string): Bun.SQL {
  return new Bun.SQL({
    url,
    max: 1,
    idleTimeout: 30,
    connectionTimeout: 10,
    prepare: false,
  });
}

function isAlreadyGone(result: RunResult): boolean {
  return /no such (container|volume)/i.test(result.stderr);
}

function boundedDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const redacted = text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]');
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown failure';
}

function assertDisposableTarget(rawUrl: string): void {
  const identity = canonicalizeMigrationTarget(rawUrl);
  assertDisposableMigrationTarget(rawUrl, identity);
  if (!identity.database.startsWith(`${DB_NAME_PREFIX}_`)) {
    throw new Error('official fence integration requires its disposable database prefix');
  }
}

async function waitForPostgres(targetUrl: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastFailure = 'no connection attempt completed';
  while (Date.now() < deadline) {
    const probe = createSql(targetUrl);
    try {
      await probe`select 1`;
      await probe.close({ timeout: 2 }).catch(() => {});
      return;
    } catch (error) {
      lastFailure = boundedDiagnostic(error);
      await probe.close({ timeout: 2 }).catch(() => {});
      await Bun.sleep(500);
    }
  }
  throw new Error(`disposable postgres did not become ready: ${lastFailure}`);
}

async function startDisposableServer(): Promise<string> {
  let lastFailure = 'no startup attempt completed';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freeLoopbackPort();
    const started = await docker(
      'run',
      '-d',
      '--name',
      CONTAINER_NAME,
      '-p',
      `127.0.0.1:${port}:5432`,
      '-e',
      `POSTGRES_USER=${PG_USER}`,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=postgres',
      '-v',
      `${VOLUME_NAME}:/var/lib/postgresql/data`,
      PG_IMAGE
    );
    if (started.code !== 0) {
      lastFailure = `docker run exited ${started.code}: ${boundedDiagnostic(started.stderr)}`;
      await docker('rm', '-f', CONTAINER_NAME);
      await docker('volume', 'rm', VOLUME_NAME);
      continue;
    }

    const maintenanceUrl = `postgres://${PG_USER}@127.0.0.1:${port}/postgres`;
    try {
      await waitForPostgres(maintenanceUrl);
      const maint = createSql(maintenanceUrl);
      try {
        await maint.unsafe(`create database "${DB_NAME}"`);
      } finally {
        await maint.close({ timeout: 5 }).catch(() => {});
      }
      return `postgres://${PG_USER}@127.0.0.1:${port}/${DB_NAME}`;
    } catch (error) {
      lastFailure = boundedDiagnostic(error);
      await docker('rm', '-f', CONTAINER_NAME);
      await docker('volume', 'rm', VOLUME_NAME);
    }
  }
  throw new Error(`could not start disposable postgres container: ${lastFailure}`);
}

async function waitForContainerRemoval(): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const listing = await docker('ps', '-a', '-q', '--filter', `name=${CONTAINER_NAME}`);
    if (listing.code === 0 && listing.stdout.trim() === '') return true;
    await Bun.sleep(250);
  }
  return false;
}

async function removeDisposableResources(): Promise<void> {
  const removed = await docker('rm', '-f', CONTAINER_NAME);
  if (removed.code !== 0 && !isAlreadyGone(removed)) {
    throw new Error('could not remove disposable postgres container');
  }
  if (!(await waitForContainerRemoval())) {
    throw new Error('disposable postgres container survived removal');
  }
  const volume = await docker('volume', 'rm', VOLUME_NAME);
  if (volume.code !== 0 && !isAlreadyGone(volume)) {
    throw new Error('could not remove disposable postgres volume');
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describeReal('official migration write fence real Postgres integration (opt-in)', () => {
  let databaseUrl = '';
  let migrationSql: Bun.SQL | undefined;
  let projectWriterSql: Bun.SQL | undefined;
  let ownsContainer = false;
  let projectManifest: readonly LoadedMigration[];
  let docsManifest: readonly LoadedMigration[];

  function migrationDb(): Bun.SQL {
    if (!migrationSql) throw new Error('migration SQL is not initialized');
    return migrationSql;
  }

  function projectWriterDb(): Bun.SQL {
    if (!projectWriterSql) throw new Error('project writer SQL is not initialized');
    return projectWriterSql;
  }

  function targetIdentity() {
    if (!databaseUrl) throw new Error('database URL is not initialized');
    return canonicalizeMigrationTarget(databaseUrl);
  }

  const docsConfig = (): DocsRagLabConfig => ({
    tool: 'docs-rag-pg-lab',
    rootDir: REPO_ROOT,
    defaultEvalFixturePath: 'scripts/docs-rag/fixtures/eval-external-sources.json',
    evalTopK: 5,
    healthTimeoutMs: 1_000,
    embedding: {
      provider: 'llamacpp',
      model: 'official-fence-test-embedder',
      baseUrl: 'http://127.0.0.1:1',
      dimensions: 1024,
      timeoutMs: 1_000,
      batchSize: 1,
      maxConcurrentBatches: 1,
    },
    database: { url: databaseUrl },
    pool: { max: 1, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
    gates: { liveSearchEnabled: false, embeddingEnabled: false, mutationEnabled: true },
  });

  const docsInput = {
    sourceId: 'bun-docs' as const,
    provenanceClass: 'processed_external_import' as const,
    generationKey: buildDocsRagSourceGenerationKey({
      sourceId: 'bun-docs',
      rawManifestSha256: 'a'.repeat(64),
      processingProfileHash: 'b'.repeat(64),
    }),
    rawManifestSha256: 'a'.repeat(64),
    processingProfileHash: 'b'.repeat(64),
    expectedDocumentCount: 0,
    scanState: 'pending' as const,
  };

  async function countRows(table: 'project_repositories' | 'docs_source_generations') {
    const rows = await migrationDb().unsafe(`select count(*)::integer as count from ${table}`);
    return Number(rows[0]?.count ?? 0);
  }

  async function resetDatabase(): Promise<void> {
    await migrationDb().unsafe('drop schema if exists public cascade');
    await migrationDb().unsafe('create schema public');
  }

  async function applyFreshManifests(): Promise<void> {
    const identity = targetIdentity();
    const setupSql = createSql(databaseUrl);
    const setupDb = adaptReservedSql(await setupSql.reserve());
    try {
      for (const [lane, manifest] of [
        ['project', projectManifest],
        ['docs', docsManifest],
      ] as const) {
        const report = await runApply({
          db: setupDb,
          lane,
          manifest,
          redactedUrl: identity.redactedUrl,
          targetFingerprint: identity.fingerprint,
          dryRun: false,
        });
        expect(report.state.kind).toBe('up_to_date');
      }
    } finally {
      await setupDb.release().catch(() => {});
      await setupSql.close({ timeout: 5 }).catch(() => {});
    }
  }

  async function applyLegacyManifests(): Promise<void> {
    for (const item of projectManifest) await migrationDb().unsafe(item.sqlText);
    for (const item of docsManifest) await migrationDb().unsafe(item.sqlText);
  }

  beforeAll(async () => {
    if (typeof Bun === 'undefined') {
      throw new Error('this integration suite requires Bun.SQL; run it with bun --bun x vitest');
    }
    projectManifest = await loadManifest(REPO_ROOT, 'project');
    docsManifest = await loadManifest(REPO_ROOT, 'docs');
    const supplied = process.env.RAG_OFFICIAL_POSTGRES_DATABASE_URL;
    if (supplied) {
      databaseUrl = supplied;
    } else {
      databaseUrl = await startDisposableServer();
      ownsContainer = true;
    }
    assertDisposableTarget(databaseUrl);
    await waitForPostgres(databaseUrl);
    migrationSql = createSql(databaseUrl);
    projectWriterSql = createSql(databaseUrl);
    await resetDatabase();
    await applyFreshManifests();
  }, 300_000);

  afterAll(async () => {
    await projectWriterSql?.close({ timeout: 5 }).catch(() => {});
    await migrationSql?.close({ timeout: 5 }).catch(() => {});
    if (ownsContainer) {
      await removeDisposableResources();
    } else if (databaseUrl) {
      const cleanup = createSql(databaseUrl);
      try {
        await cleanup.unsafe('drop schema if exists public cascade');
      } finally {
        await cleanup.close({ timeout: 5 }).catch(() => {});
      }
    }
  }, 120_000);

  it('ignores PostgreSQL background workers when observing an idle drain', async () => {
    const observation = await readDrainObservation(migrationDb());
    expect(observation).toMatchObject({
      activeSessions: 0,
      activeTransactions: 0,
      bypassRoleDetected: false,
      drained: true,
    });
  });

  it('ignores maintenance grant churn but detects application grant churn', async () => {
    await resetDatabase();
    const db = migrationDb();
    const probeRole = 'drain_grants_probe';
    await db.unsafe(`create table ${MIGRATION_MAINTENANCE_TABLE} (id integer primary key)`);
    await db.unsafe('create table public.drain_application_grants_probe (id integer primary key)');
    await db.unsafe(`create role ${probeRole}`);
    try {
      await db.unsafe(`grant select on ${MIGRATION_MAINTENANCE_TABLE} to ${probeRole}`);
      const baseline = await readDrainObservation(db);
      await db.unsafe(`grant insert on ${MIGRATION_MAINTENANCE_TABLE} to ${probeRole}`);
      const maintenanceChanged = await readDrainObservation(db);
      await db.unsafe(`grant select on public.drain_application_grants_probe to ${probeRole}`);
      const applicationChanged = await readDrainObservation(db);

      expect(maintenanceChanged.grantsDigest).toBe(baseline.grantsDigest);
      expect(applicationChanged.grantsDigest).not.toBe(baseline.grantsDigest);
    } finally {
      await db.unsafe(`drop owned by ${probeRole}`);
      await db.unsafe(`drop role ${probeRole}`);
    }
  });

  it('blocks exclusive migration behind a Project writer shared lock', async () => {
    await resetDatabase();
    await applyFreshManifests();

    const ready = deferred<void>();
    const release = deferred<void>();
    const sharedWrite = beginProjectRagWrite(projectWriterDb(), async () => {
      ready.resolve();
      await release.promise;
    });

    await ready.promise;
    try {
      await expect(acquireMigrationLock(migrationDb())).rejects.toMatchObject({
        code: MIGRATION_LOCK_BUSY,
      });
    } finally {
      release.resolve();
      try {
        await sharedWrite;
      } finally {
        await releaseMigrationLock(migrationDb());
      }
    }
  });

  it('blocks Project and Docs writers before DML, then restores writes on release', async () => {
    await resetDatabase();
    await applyFreshManifests();

    await acquireMigrationLock(migrationDb());
    try {
      let projectDmlAttempts = 0;
      await expect(
        beginProjectRagWrite(projectWriterDb(), async (tx) => {
          projectDmlAttempts += 1;
          await tx`
            insert into project_repositories
              (name, slug, root_path, normalized_root_path)
            values
              (${'blocked-project'}, ${'blocked-project'}, ${'/disposable/blocked-project'}, ${'/disposable/blocked-project'})
          `;
        })
      ).rejects.toMatchObject({ code: MIGRATION_LOCK_BUSY });
      expect(projectDmlAttempts).toBe(0);
      await expect(countRows('project_repositories')).resolves.toBe(0);

      await expect(createDocsRagSourceGeneration(docsConfig(), docsInput)).rejects.toMatchObject({
        code: MIGRATION_LOCK_BUSY,
      });
      await expect(countRows('docs_source_generations')).resolves.toBe(0);
    } finally {
      await releaseMigrationLock(migrationDb());
    }

    let releasedProjectDmlAttempts = 0;
    await beginProjectRagWrite(projectWriterDb(), async (tx) => {
      releasedProjectDmlAttempts += 1;
      await tx`
        insert into project_repositories
          (name, slug, root_path, normalized_root_path)
        values
          (${'released-project'}, ${'released-project'}, ${'/disposable/released-project'}, ${'/disposable/released-project'})
      `;
    });
    expect(releasedProjectDmlAttempts).toBe(1);

    const generation = await createDocsRagSourceGeneration(docsConfig(), docsInput);
    expect(generation.status).toBe('staging');
    await expect(countRows('project_repositories')).resolves.toBe(1);
    await expect(countRows('docs_source_generations')).resolves.toBe(1);
  });

  it('adopts a legacy schema clone and reruns both lanes as no-ops', async () => {
    await resetDatabase();
    await applyLegacyManifests();
    const identity = targetIdentity();
    const common = {
      redactedUrl: identity.redactedUrl,
      targetFingerprint: identity.fingerprint,
      dryRun: false,
    } as const;

    const projectStatus = await runStatus({
      db: migrationDb(),
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: common.redactedUrl,
      targetFingerprint: common.targetFingerprint,
    });
    expect(projectStatus.state.kind).toBe('adoption_required');
    if (!projectStatus.adoptionChallenge) {
      throw new Error('expected a Project adoption challenge');
    }
    const projectAdopted = await runAdopt({
      db: migrationDb(),
      lane: 'project',
      manifest: projectManifest,
      ...common,
      challengeDigest: projectStatus.adoptionChallenge.proofDigest,
    });
    expect(projectAdopted.adopted).toHaveLength(projectManifest.length);
    await expect(
      runApply({
        db: migrationDb(),
        lane: 'project',
        manifest: projectManifest,
        ...common,
      })
    ).resolves.toMatchObject({ executed: [] });

    const docsStatus = await runStatus({
      db: migrationDb(),
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: common.redactedUrl,
      targetFingerprint: common.targetFingerprint,
    });
    expect(docsStatus.state.kind).toBe('adoption_required');
    if (!docsStatus.adoptionChallenge) {
      throw new Error('expected a Docs adoption challenge');
    }
    const docsAdopted = await runAdopt({
      db: migrationDb(),
      lane: 'docs',
      manifest: docsManifest,
      ...common,
      challengeDigest: docsStatus.adoptionChallenge.proofDigest,
    });
    expect(docsAdopted.adopted).toHaveLength(docsManifest.length);
    await expect(
      runApply({
        db: migrationDb(),
        lane: 'docs',
        manifest: docsManifest,
        ...common,
      })
    ).resolves.toMatchObject({ executed: [] });
  });
});
