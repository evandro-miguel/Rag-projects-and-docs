/**
 * Opt-in real-Postgres integration proof for the atomic ingest finalizer.
 *
 * Release-completion T-04: proves with a real PostgreSQL server that
 *
 *   1. `completeProjectRagPostgresIngest` is atomic — an injected failure
 *      AFTER every finalizer mutation (build publication, snapshot
 *      consumption, sync-run completion) but BEFORE commit rolls all of them
 *      back, and an external connection still sees the prior published build,
 *      a CONSUMING snapshot, a running sync run, and a running job;
 *   2. the durable-job fence rejects a reclaimed worker without changing any
 *      protected state, while the reclaiming worker finalizes atomically and
 *      all four states (build, snapshot, sync run, job) update together;
 *   3. the unfenced foreground success path publishes and consumes cleanly.
 *
 * Runs only when PROJECT_RAG_REAL_DB_TEST=1. By default the suite owns a
 * fully disposable pgvector container: unique name/volume/database prefixed
 * `rag_v2_migration_t04`, published on 127.0.0.1 only, on a random non-official
 * port, removed again on exit. Project migrations are applied through the T-03
 * checksum runner. An explicit disposable URL may be supplied instead via
 * PROJECT_RAG_T04_DATABASE_URL (same isolation policy enforced).
 *
 * Never prints URLs or credentials. Never targets an official lane.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adaptReservedSql,
  canonicalizeMigrationTarget,
  loadManifest,
  OFFICIAL_DATABASE_PORTS,
  runApply,
} from '../db-migrations/runner.js';
import {
  claimProjectRagJob,
  claimProjectRagPostgresIngestSnapshot,
  completeProjectRagPostgresIngest,
  enqueueProjectRagJob,
  getProjectRagPostgresPublishedBuildState,
  insertProjectRagPostgresIngestSnapshot,
  insertProjectRagPostgresSyncRunInTransaction,
  publishProjectRagPostgresIndexBuild,
  upsertProjectRagPostgresFile,
  upsertProjectRagPostgresRepository,
  withProjectRagJobFence,
} from './store.js';
import { beginProjectRagWrite } from './transaction.js';

const RUN_REAL_DB = process.env.PROJECT_RAG_REAL_DB_TEST === '1';
const describeReal = RUN_REAL_DB ? describe : describe.skip;

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PG_IMAGE = 'pgvector/pgvector:pg16';
const DB_NAME_PREFIX = 'rag_v2_migration_t04';
const RESOURCE_TOKEN = `${Date.now().toString(36)}${process.pid.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
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

/** Reserve an ephemeral TCP port on loopback and release it immediately. */
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
      const { port } = address;
      server.close(() => resolvePromise(port));
    });
  });
}

/**
 * The finalizer suite never mutates anything but its own throwaway server:
 * loopback host, a listener port outside the official set, and a database
 * named under the runner's disposable namespace with the t04 prefix.
 */
function assertDisposableT04Target(rawUrl: string): void {
  const identity = canonicalizeMigrationTarget(rawUrl);
  if (identity.host !== '127.0.0.1' && identity.host !== '::1') {
    throw new Error('finalizer target must bind to loopback');
  }
  if (OFFICIAL_DATABASE_PORTS.includes(identity.port)) {
    throw new Error('finalizer target must not use an official listener port');
  }
  if (identity.database !== DB_NAME && !identity.database.startsWith(`${DB_NAME_PREFIX}_`)) {
    throw new Error('finalizer target must use a rag_v2_migration_t04* database');
  }
}

describeReal('ingest finalizer real Postgres integration (opt-in)', () => {
  let databaseUrl: string;
  let sql: Bun.SQL;
  let observer: Bun.SQL;
  let ownsContainer = false;

  const token = RESOURCE_TOKEN;

  async function waitForPostgres(targetUrl: string): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError = '';
    while (Date.now() < deadline) {
      const probe = new Bun.SQL({ url: targetUrl, max: 1, connectionTimeout: 2, prepare: false });
      try {
        await probe`select 1`;
        await probe.close({ timeout: 2 }).catch(() => {});
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await probe.close({ timeout: 2 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`disposable postgres did not become ready: ${lastError}`);
  }

  async function startDisposableServer(): Promise<void> {
    let lastStderr = '';
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
        lastStderr = started.stderr.slice(0, 400);
        await docker('rm', '-f', CONTAINER_NAME);
        continue;
      }
      const maintenanceUrl = `postgres://${PG_USER}@127.0.0.1:${port}/postgres`;
      try {
        await waitForPostgres(maintenanceUrl);
      } catch (error) {
        lastStderr = error instanceof Error ? error.message : String(error);
        await docker('rm', '-f', CONTAINER_NAME);
        continue;
      }
      const maint = new Bun.SQL({
        url: maintenanceUrl,
        max: 1,
        connectionTimeout: 5,
        prepare: false,
      });
      try {
        await maint.unsafe(`create database "${DB_NAME}"`);
      } finally {
        await maint.close({ timeout: 5 }).catch(() => {});
      }
      databaseUrl = `postgres://${PG_USER}@127.0.0.1:${port}/${DB_NAME}`;
      ownsContainer = true;
      return;
    }
    throw new Error(`could not start disposable postgres container: ${lastStderr}`);
  }

  async function applyProjectMigrations(): Promise<void> {
    const manifest = await loadManifest(REPO_ROOT, 'project');
    const db = adaptReservedSql(await sql.reserve());
    try {
      const identity = canonicalizeMigrationTarget(databaseUrl);
      const report = await runApply({
        db,
        lane: 'project',
        manifest,
        redactedUrl: identity.redactedUrl,
        targetFingerprint: identity.fingerprint,
        dryRun: false,
      });
      expect(report.state.kind).toBe('up_to_date');
    } finally {
      await db.release().catch(() => {});
    }
  }

  async function removeDisposableResources(): Promise<string[]> {
    const proof: string[] = [];
    if (ownsContainer) {
      const removed = await docker('rm', '-f', CONTAINER_NAME);
      proof.push(`container:${CONTAINER_NAME}=${removed.code === 0 ? 'removed' : 'remove_failed'}`);
      const volume = await docker('volume', 'rm', VOLUME_NAME);
      proof.push(`volume:${VOLUME_NAME}=${volume.code === 0 ? 'removed' : 'remove_failed'}`);
    }
    const lingering = await docker(
      'ps',
      '-a',
      '--filter',
      `name=${CONTAINER_NAME}`,
      '--format',
      '{{.Names}}'
    );
    proof.push(`containers_remaining=${lingering.stdout.trim().length}`);
    return proof;
  }

  // -----------------------------------------------------------------------
  // Fixture builders and raw state readers (all through committed state)
  // -----------------------------------------------------------------------

  async function createEphemeralProject(label: string): Promise<number> {
    const root = `/__ephemeral__/t04-finalizer/${label}-${token}`;
    return upsertProjectRagPostgresRepository(sql, {
      name: `t04-finalizer-${label}`,
      slug: `t04-finalizer-${label}-${token}`,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
      metadata: { purpose: 'finalizer-postgres-integration', token, label },
    });
  }

  async function seedIndexedFile(projectId: number, label: string): Promise<void> {
    await upsertProjectRagPostgresFile(
      sql,
      projectId,
      {
        sourcePath: `src/${label}.ts`,
        absolutePath: `/__ephemeral__/t04-finalizer/${label}-${token}/src/${label}.ts`,
        contentHash: 'c'.repeat(64),
        fileModifiedAt: Date.now(),
        lang: 'typescript',
        sizeBytes: 64,
      },
      'ready'
    );
  }

  interface FinalizerFixture {
    readonly projectId: number;
    readonly priorBuildId: number;
    readonly snapshotId: number;
    readonly snapshotUuid: string;
    readonly syncRunId: number;
    readonly jobId?: number;
    readonly fenceTokenA?: number;
  }

  /**
   * Prior published build + CONSUMING snapshot + running sync run + running
   * fenced job — exactly the pre-finalizer state an executing worker holds.
   */
  async function seedFinalizerState(label: string, withJob: boolean): Promise<FinalizerFixture> {
    const projectId = await createEphemeralProject(label);
    await seedIndexedFile(projectId, label);
    const priorBuildId = (await publishProjectRagPostgresIndexBuild(sql, projectId)).id;

    const snapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId,
      commandScope: 'full',
      addsCount: 1,
      trackedCount: 1,
      inventoryHash: 'a'.repeat(64),
      baselineHash: 'b'.repeat(64),
      ttlSeconds: 600,
    });
    await claimProjectRagPostgresIngestSnapshot(sql, projectId, snapshot.id);

    if (!withJob) {
      const syncRunId = await beginProjectRagWrite(sql, (tx) =>
        insertProjectRagPostgresSyncRunInTransaction(tx, {
          projectId,
          mode: 'full',
          snapshotUuid: snapshot.snapshotUuid,
          jobId: null,
        })
      );
      return {
        projectId,
        priorBuildId,
        snapshotId: snapshot.id,
        snapshotUuid: snapshot.snapshotUuid,
        syncRunId,
      };
    }
    const enqueued = await enqueueProjectRagJob(sql, {
      type: 'project_ingest_full',
      projectId,
      dedupeKey: `t04-finalizer-${label}-${token}`,
      payload: {},
      snapshotUuid: snapshot.snapshotUuid,
    });
    const claimed = await claimProjectRagJob(sql, `worker-a-t04-${label}`, 60);
    if (!claimed || claimed.id !== enqueued.id) {
      throw new Error('fixture could not claim the seeded durable job for worker A');
    }
    const syncRunId = await beginProjectRagWrite(sql, (tx) =>
      insertProjectRagPostgresSyncRunInTransaction(tx, {
        projectId,
        mode: 'full',
        snapshotUuid: snapshot.snapshotUuid,
        jobId: claimed.id,
      })
    );
    return {
      projectId,
      priorBuildId,
      snapshotId: snapshot.id,
      snapshotUuid: snapshot.snapshotUuid,
      syncRunId,
      jobId: claimed.id,
      fenceTokenA: claimed.fenceToken,
    };
  }

  async function buildRows(projectId: number): Promise<Array<{ id: number; status: string }>> {
    const rows = (await observer`
      select id::text as id, status from project_index_builds
      where project_id = ${projectId} order by id
    `) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: Number(row.id), status: String(row.status) }));
  }

  async function snapshotStatus(snapshotId: number): Promise<string> {
    const rows = (await observer`
      select status from project_ingest_snapshots where id = ${snapshotId}
    `) as Array<Record<string, unknown>>;
    return String(rows[0]?.status);
  }

  async function syncStatus(syncRunId: number): Promise<string> {
    const rows = (await observer`
      select status from project_sync_runs where id = ${syncRunId}
    `) as Array<Record<string, unknown>>;
    return String(rows[0]?.status);
  }

  async function jobRow(jobId: number): Promise<Record<string, unknown>> {
    const rows = (await observer`
      select status, worker_id as "workerId", fence_token::text as "fenceToken",
             lease_expires_at as "leaseExpiresAt", result
      from project_jobs where id = ${jobId}
    `) as Array<Record<string, unknown>>;
    const row = rows[0] ?? {};
    return {
      ...row,
      fenceToken: row.fenceToken === undefined ? undefined : Number(row.fenceToken),
    };
  }

  async function expectFinalizerStateUntouched(fixture: FinalizerFixture): Promise<void> {
    expect(await buildRows(fixture.projectId)).toEqual([
      { id: fixture.priorBuildId, status: 'published' },
    ]);
    expect(await snapshotStatus(fixture.snapshotId)).toBe('CONSUMING');
    expect(await syncStatus(fixture.syncRunId)).toBe('running');
    if (fixture.jobId !== undefined) {
      const job = await jobRow(fixture.jobId);
      expect(job.status).toBe('running');
      expect(job.fenceToken).toBe(fixture.fenceTokenA);
    }
  }

  beforeAll(async () => {
    const explicitUrl = process.env.PROJECT_RAG_T04_DATABASE_URL;
    if (explicitUrl) {
      databaseUrl = explicitUrl.trim();
      assertDisposableT04Target(databaseUrl);
    } else {
      await startDisposableServer();
      assertDisposableT04Target(databaseUrl);
    }
    sql = new Bun.SQL({ url: databaseUrl, max: 2, idleTimeout: 30, prepare: false });
    // Strictly external vantage point for post-failure state assertions.
    observer = new Bun.SQL({ url: databaseUrl, max: 1, idleTimeout: 30, prepare: false });
    await applyProjectMigrations();
  }, 240_000);

  afterAll(async () => {
    try {
      await sql?.close({ timeout: 5 }).catch(() => {});
      await observer?.close({ timeout: 5 }).catch(() => {});
    } finally {
      const proof = await removeDisposableResources();
      process.stdout.write(`[t04] disposable resource cleanup: ${proof.join(', ')}\n`);
    }
  }, 60_000);

  it('rolls back every finalizer mutation when failure strikes before commit', async () => {
    const fixture = await seedFinalizerState('rollback', true);
    const { projectId, priorBuildId, snapshotId, snapshotUuid, syncRunId, jobId, fenceTokenA } =
      fixture;

    // Sabotage fires on the LAST mutation of the unit (running -> succeeded),
    // i.e. after build publication, snapshot consumption, and sync completion
    // statements have already executed inside the open transaction.
    await sql.unsafe(`
      create function rag_v2_migration_t04_sabotage() returns trigger
      language plpgsql as $fn$
      begin
        raise exception 'T04_INJECTED_FAILURE_AFTER_ALL_MUTATIONS';
      end;
      $fn$
    `);
    await sql.unsafe(`
      create trigger rag_v2_migration_t04_sabotage_jobs
      before update on project_jobs
      for each row
      when (new.status = 'succeeded' and old.status = 'running')
      execute function rag_v2_migration_t04_sabotage()
    `);

    try {
      await expect(
        completeProjectRagPostgresIngest(sql, {
          projectId,
          snapshotId,
          snapshotUuid,
          syncRunId,
          publishBuild: true,
          execution: {
            kind: 'durable',
            job: {
              jobId: jobId as number,
              fenceToken: fenceTokenA as number,
              result: { sabotageProbe: token },
            },
          },
        })
      ).rejects.toThrow(/T04_INJECTED_FAILURE_AFTER_ALL_MUTATIONS/);
    } finally {
      await sql.unsafe('drop trigger if exists rag_v2_migration_t04_sabotage_jobs on project_jobs');
      await sql.unsafe('drop function if exists rag_v2_migration_t04_sabotage()');
    }

    // External connection: nothing leaked past the aborted unit.
    expect(await buildRows(projectId)).toEqual([{ id: priorBuildId, status: 'published' }]);
    expect(await snapshotStatus(snapshotId)).toBe('CONSUMING');
    expect(await syncStatus(syncRunId)).toBe('running');
    const job = await jobRow(jobId as number);
    expect(job.status).toBe('running');
    expect(job.fenceToken).toBe(fenceTokenA);
    expect(job.workerId).toBe(`worker-a-t04-rollback`);
  }, 60_000);

  it('rolls back every finalizer mutation when cancellation arrives during job completion', async () => {
    const fixture = await seedFinalizerState('cancel', true);
    const { projectId, snapshotId, snapshotUuid, syncRunId, jobId, fenceTokenA } = fixture;
    const abortFunction = 'rag_v2_migration_t04_cancel_slow_job';
    const abortTrigger = 'rag_v2_migration_t04_cancel_slow_job_trigger';

    // Keep the terminal job update in flight after publication, snapshot
    // consumption, and sync completion have already run in this transaction.
    await sql.unsafe(`
      create function ${abortFunction}() returns trigger
      language plpgsql as $fn$
      begin
        perform pg_sleep(0.2);
        return new;
      end;
      $fn$
    `);
    await sql.unsafe(`
      create trigger ${abortTrigger}
      before update on project_jobs
      for each row
      when (new.status = 'succeeded' and old.status = 'running')
      execute function ${abortFunction}()
    `);

    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(new Error('T04_FINALIZER_CANCELLATION')),
      50
    );
    try {
      await expect(
        completeProjectRagPostgresIngest(sql, {
          projectId,
          snapshotId,
          snapshotUuid,
          syncRunId,
          publishBuild: true,
          signal: controller.signal,
          execution: {
            kind: 'durable',
            job: {
              jobId: jobId as number,
              fenceToken: fenceTokenA as number,
              result: { cancellationProbe: token },
            },
          },
        })
      ).rejects.toThrow(/cancelled during finalization/);
    } finally {
      clearTimeout(abortTimer);
      await sql.unsafe(`drop trigger if exists ${abortTrigger} on project_jobs`);
      await sql.unsafe(`drop function if exists ${abortFunction}()`);
    }

    // Read through a separate connection after rollback: no staged mutation
    // from before the terminal job update may become visible.
    await expectFinalizerStateUntouched(fixture);
  }, 60_000);

  it('rejects the reclaimed worker, then lets the new owner finalize atomically', async () => {
    const fixture = await seedFinalizerState('fence', true);
    const { projectId, priorBuildId, snapshotId, snapshotUuid, syncRunId, jobId, fenceTokenA } =
      fixture;

    // Expire worker A's lease and let worker B reclaim the same job.
    await sql`update project_jobs
      set lease_expires_at = now() - interval '1 second'
      where id = ${jobId}`;
    const reclaimedByB = await claimProjectRagJob(sql, `worker-b-t04-fence`, 60);
    expect(reclaimedByB?.id).toBe(jobId);
    const fenceTokenB = reclaimedByB?.fenceToken ?? 0;
    expect(fenceTokenB).toBeGreaterThan(fenceTokenA as number);

    // Worker A's stale fence must reject before any mutation.
    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId,
        snapshotId,
        snapshotUuid,
        syncRunId,
        publishBuild: true,
        execution: {
          kind: 'durable',
          job: {
            jobId: jobId as number,
            fenceToken: fenceTokenA as number,
            result: { staleWorker: 'a' },
          },
        },
      })
    ).rejects.toThrow(/job lease was lost/);

    // Nothing changed for anyone reading concurrently.
    expect(await buildRows(projectId)).toEqual([{ id: priorBuildId, status: 'published' }]);
    expect(await snapshotStatus(snapshotId)).toBe('CONSUMING');
    expect(await syncStatus(syncRunId)).toBe('running');
    const jobAfterRejection = await jobRow(jobId as number);
    expect(jobAfterRejection.status).toBe('running');
    expect(jobAfterRejection.workerId).toBe('worker-b-t04-fence');
    expect(jobAfterRejection.fenceToken).toBe(fenceTokenB);

    // Worker B owns the current fence: one unit updates all four states.
    const finalized = await completeProjectRagPostgresIngest(sql, {
      projectId,
      snapshotId,
      snapshotUuid,
      syncRunId,
      publishBuild: true,
      execution: {
        kind: 'durable',
        job: {
          jobId: jobId as number,
          fenceToken: fenceTokenB,
          result: { finalStatus: 'completed', marker: token },
        },
      },
    });
    expect(finalized.publishedBuildId).toBeDefined();

    const builds = await buildRows(projectId);
    expect(builds).toEqual([
      { id: priorBuildId, status: 'retired' },
      { id: finalized.publishedBuildId, status: 'published' },
    ]);
    const readerState = await getProjectRagPostgresPublishedBuildState(sql, projectId);
    expect(readerState.buildId).toBe(finalized.publishedBuildId);
    expect(await snapshotStatus(snapshotId)).toBe('CONSUMED');
    expect(await syncStatus(syncRunId)).toBe('completed');

    const finalizedJob = await jobRow(jobId as number);
    expect(finalizedJob.status).toBe('succeeded');
    expect(finalizedJob.leaseExpiresAt ?? null).toBeNull();
    expect(JSON.stringify(finalizedJob.result)).toContain(token);
  }, 60_000);

  it('finalizes a foreground ingest without touching any durable job', async () => {
    const fixture = await seedFinalizerState('foreground', false);
    const { projectId, priorBuildId, snapshotId, snapshotUuid, syncRunId } = fixture;

    const finalized = await completeProjectRagPostgresIngest(sql, {
      projectId,
      snapshotId,
      snapshotUuid,
      syncRunId,
      publishBuild: true,
      execution: { kind: 'foreground' },
    });
    expect(finalized.publishedBuildId).toBeDefined();

    expect(await buildRows(projectId)).toEqual([
      { id: priorBuildId, status: 'retired' },
      { id: finalized.publishedBuildId, status: 'published' },
    ]);
    expect(await snapshotStatus(snapshotId)).toBe('CONSUMED');
    expect(await syncStatus(syncRunId)).toBe('completed');
  }, 60_000);

  it('rejects cross-project, cross-snapshot, and cross-sync finalization before publication', async () => {
    const projectA = await seedFinalizerState('identity-a', true);
    const projectB = await seedFinalizerState('identity-b', false);

    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: projectA.projectId,
        snapshotId: projectB.snapshotId,
        snapshotUuid: projectB.snapshotUuid,
        syncRunId: projectA.syncRunId,
        publishBuild: true,
        execution: {
          kind: 'durable',
          job: {
            jobId: projectA.jobId as number,
            fenceToken: projectA.fenceTokenA as number,
            result: { rejected: 'cross-project' },
          },
        },
      })
    ).rejects.toMatchObject({ code: 'PROJECT_RAG_SNAPSHOT_LEASE_LOST' });
    await expectFinalizerStateUntouched(projectA);
    await expectFinalizerStateUntouched(projectB);

    const secondSnapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectA.projectId,
      commandScope: 'identity-cross-snapshot',
      addsCount: 1,
      trackedCount: 1,
      inventoryHash: 'd'.repeat(64),
      baselineHash: 'e'.repeat(64),
      ttlSeconds: 600,
    });
    const sameProjectOtherSyncRun = await beginProjectRagWrite(sql, (tx) =>
      insertProjectRagPostgresSyncRunInTransaction(tx, {
        projectId: projectA.projectId,
        mode: 'full',
        snapshotUuid: secondSnapshot.snapshotUuid,
        jobId: null,
      })
    );
    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: projectA.projectId,
        snapshotId: projectA.snapshotId,
        snapshotUuid: secondSnapshot.snapshotUuid,
        syncRunId: projectA.syncRunId,
        publishBuild: true,
        execution: { kind: 'foreground' },
      })
    ).rejects.toMatchObject({ code: 'PROJECT_RAG_SNAPSHOT_LEASE_LOST' });
    await expectFinalizerStateUntouched(projectA);

    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: projectA.projectId,
        snapshotId: projectA.snapshotId,
        snapshotUuid: projectA.snapshotUuid,
        syncRunId: sameProjectOtherSyncRun,
        publishBuild: true,
        execution: { kind: 'foreground' },
      })
    ).rejects.toThrow(/sync_identity_mismatch/);
    await expectFinalizerStateUntouched(projectA);

    await expect(
      completeProjectRagPostgresIngest(sql, {
        projectId: projectA.projectId,
        snapshotId: projectA.snapshotId,
        snapshotUuid: projectA.snapshotUuid,
        syncRunId: projectB.syncRunId,
        publishBuild: true,
        execution: {
          kind: 'durable',
          job: {
            jobId: projectA.jobId as number,
            fenceToken: projectA.fenceTokenA as number,
            result: { rejected: 'cross-sync' },
          },
        },
      })
    ).rejects.toThrow(/sync_identity_mismatch/);
    await expectFinalizerStateUntouched(projectA);
    expect(await syncStatus(projectB.syncRunId)).toBe('running');

    const exact = await completeProjectRagPostgresIngest(sql, {
      projectId: projectA.projectId,
      snapshotId: projectA.snapshotId,
      snapshotUuid: projectA.snapshotUuid,
      syncRunId: projectA.syncRunId,
      publishBuild: true,
      execution: {
        kind: 'durable',
        job: {
          jobId: projectA.jobId as number,
          fenceToken: projectA.fenceTokenA as number,
          result: { accepted: 'exact-binding' },
        },
      },
    });
    expect(exact.publishedBuildId).toBeDefined();
    expect(await snapshotStatus(projectA.snapshotId)).toBe('CONSUMED');
    expect(await syncStatus(projectA.syncRunId)).toBe('completed');
    await expectFinalizerStateUntouched(projectB);
  }, 60_000);

  it('rolls back all fenced writes when the lease expires during the operation', async () => {
    const fixture = await seedFinalizerState('expiry', true);
    const extraSnapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: fixture.projectId,
      commandScope: 'expiry-probe',
      addsCount: 1,
      trackedCount: 1,
      inventoryHash: 'f'.repeat(64),
      baselineHash: 'g'.repeat(64),
      ttlSeconds: 600,
    });
    const beforeRows = (await observer`
      select count(*)::int as count from project_sync_runs where project_id = ${fixture.projectId}
    `) as Array<{ count: number }>;

    await sql`
      update project_jobs
      set lease_expires_at = clock_timestamp() + interval '200 milliseconds'
      where id = ${fixture.jobId}
        and fence_token = ${fixture.fenceTokenA}
    `;
    await expect(
      withProjectRagJobFence(
        sql,
        { jobId: fixture.jobId as number, fenceToken: fixture.fenceTokenA as number },
        async (tx) => {
          await tx`
            insert into project_sync_runs (project_id, status, mode, snapshot_uuid, job_id)
            values (${fixture.projectId}, 'running', 'file', ${extraSnapshot.snapshotUuid}, null)
          `;
          await tx`select pg_sleep(0.5)`;
        }
      )
    ).rejects.toThrow(/job lease was lost/);

    const afterRows = (await observer`
      select count(*)::int as count from project_sync_runs where project_id = ${fixture.projectId}
    `) as Array<{ count: number }>;
    expect(afterRows[0]?.count).toBe(beforeRows[0]?.count);
    await expectFinalizerStateUntouched(fixture);
  }, 60_000);

  it('skips real DB suite unless PROJECT_RAG_REAL_DB_TEST=1', () => {
    if (!RUN_REAL_DB) {
      expect(process.env.PROJECT_RAG_REAL_DB_TEST).not.toBe('1');
    } else {
      expect(process.env.PROJECT_RAG_REAL_DB_TEST).toBe('1');
    }
  });
});
