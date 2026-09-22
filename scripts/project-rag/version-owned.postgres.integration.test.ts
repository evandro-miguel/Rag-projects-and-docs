/**
 * Opt-in real-Postgres integration proof for release-completion T-05.
 *
 * The fixture owns a disposable loopback pgvector server (or accepts an
 * explicitly supplied disposable URL) and cleans its project/build rows in a
 * finally block. It proves the candidate version boundary without exercising
 * the not-yet-adopted embedding profile writer/search contract.
 *
 * Run with PROJECT_RAG_REAL_DB_TEST=1. The default container is deliberately
 * separate from the official Project RAG lane.
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
import { parseAst } from '../lib/ast-parser.js';
import {
  PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
  PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
  PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
} from './embeddings.js';
import {
  failProjectRagPostgresCandidateVersionInTransaction,
  findProjectRagPostgresSymbols,
  getProjectRagPostgresFeatureHubs,
  getProjectRagPostgresFileOutline,
  getProjectRagPostgresFileWithChunks,
  insertProjectRagPostgresEdge,
  insertProjectRagPostgresSymbol,
  listProjectRagPostgresChunkEmbeddingCandidates,
  promoteProjectRagPostgresFileVersions,
  publishProjectRagPostgresIndexBuild,
  replaceProjectRagPostgresFileChunks,
  replaceProjectRagPostgresFileEdges,
  replaceProjectRagPostgresFileSymbols,
  searchProjectRagPostgresChunks,
  upsertProjectRagPostgresChunkEmbedding1024,
  upsertProjectRagPostgresFile,
  upsertProjectRagPostgresRepository,
} from './store.js';
import { getProjectRagPostgresNavigationPaths } from './store-read-models.js';
import { beginProjectRagWrite } from './transaction.js';

const RUN_REAL_DB = process.env.PROJECT_RAG_REAL_DB_TEST === '1';
const describeReal = RUN_REAL_DB ? describe : describe.skip;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PG_IMAGE = 'pgvector/pgvector:pg16';
const DB_NAME_PREFIX = 'rag_v2_migration_t05';
const RESOURCE_TOKEN = `${Date.now().toString(36)}${process.pid.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const CONTAINER_NAME = `${DB_NAME_PREFIX}_${RESOURCE_TOKEN}`;
const VOLUME_NAME = `${DB_NAME_PREFIX}_${RESOURCE_TOKEN}`;
const DB_NAME = `${DB_NAME_PREFIX}_${RESOURCE_TOKEN}`;
const PG_USER = 'postgres';
const STARTUP_TIMEOUT_MS = 120_000;
const TEST_EMBEDDING = Object.freeze(
  Array.from({ length: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS }, () => 0.1)
);
const FOREIGN_EMBEDDING = Object.freeze(
  Array.from({ length: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS }, () => 0.9)
);
const TEST_VECTOR_LITERAL = `[${TEST_EMBEDDING.join(',')}]`;
const FOREIGN_PROFILE_HASH = 'foreign-profile-t05';

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

function assertDisposableTarget(rawUrl: string): void {
  const identity = canonicalizeMigrationTarget(rawUrl);
  if (identity.host !== '127.0.0.1' && identity.host !== '::1') {
    throw new Error('T-05 target must bind to loopback');
  }
  if (OFFICIAL_DATABASE_PORTS.includes(identity.port)) {
    throw new Error('T-05 target must not use an official listener port');
  }
  if (identity.database !== DB_NAME && !identity.database.startsWith(`${DB_NAME_PREFIX}_`)) {
    throw new Error('T-05 target must use a rag_v2_migration_t05* database');
  }
}

/** True when docker reports the container/volume is already gone. */
function isAlreadyGone(result: RunResult): boolean {
  return /no such (container|volume)/i.test(result.stderr);
}

describeReal('version-owned derived data real Postgres integration (opt-in)', () => {
  let databaseUrl = '';
  let sql: Bun.SQL | undefined;
  let observer: Bun.SQL | undefined;
  let ownsContainer = false;
  const projectIds = new Set<number>();

  function projectSql(): Bun.SQL {
    if (!sql) throw new Error('Project RAG SQL is not initialized');
    return sql;
  }

  function projectObserver(): Bun.SQL {
    if (!observer) throw new Error('Project RAG observer SQL is not initialized');
    return observer;
  }

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
        await Bun.sleep(500);
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
        // Best-effort attempt teardown; the primary failure is reported via
        // lastStderr and the final throw below.
        await docker('rm', '-f', CONTAINER_NAME);
        await docker('volume', 'rm', VOLUME_NAME);
        continue;
      }

      const maintenanceUrl = `postgres://${PG_USER}@127.0.0.1:${port}/postgres`;
      try {
        await waitForPostgres(maintenanceUrl);
      } catch (error) {
        lastStderr = error instanceof Error ? error.message : String(error);
        await docker('rm', '-f', CONTAINER_NAME);
        await docker('volume', 'rm', VOLUME_NAME);
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
    const reserved = await projectSql().reserve();
    const db = adaptReservedSql(reserved);
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

  async function cleanupProject(projectId: number): Promise<void> {
    if (!sql) return;
    await sql`delete from project_index_build_files where project_id = ${projectId}`;
    await sql`delete from project_index_builds where project_id = ${projectId}`;
    await sql`delete from project_repositories where id = ${projectId}`;
    projectIds.delete(projectId);
  }

  async function waitForContainerRemoval(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listing = await docker('ps', '-a', '-q', '--filter', `name=${CONTAINER_NAME}`);
      if (listing.code === 0 && listing.stdout.trim() === '') return true;
      await Bun.sleep(250);
    }
    const finalListing = await docker('ps', '-a', '-q', '--filter', `name=${CONTAINER_NAME}`);
    return finalListing.code === 0 && finalListing.stdout.trim() === '';
  }

  /**
   * Force-remove the disposable container and its named volume.
   *
   * The engine releases a container's rootfs volume asynchronously after
   * `rm -f`, so an immediate `volume rm` can fail with "in use" and silently
   * leak the volume. Wait for the container to disappear, retry the volume
   * removal, and fail loudly if either resource survives.
   */
  async function discardDisposableResources(): Promise<void> {
    const removed = await docker('rm', '-f', CONTAINER_NAME);
    if (removed.code !== 0 && !isAlreadyGone(removed)) {
      throw new Error(
        `could not force-remove disposable postgres container ${CONTAINER_NAME}: ${removed.stderr.slice(0, 400)}`
      );
    }
    if (!(await waitForContainerRemoval())) {
      throw new Error(`disposable postgres container ${CONTAINER_NAME} survived forced removal`);
    }
    let lastVolumeError = '';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const volRemoved = await docker('volume', 'rm', VOLUME_NAME);
      if (volRemoved.code === 0 || isAlreadyGone(volRemoved)) {
        return;
      }
      lastVolumeError = volRemoved.stderr.trim().slice(0, 400);
      await Bun.sleep(500);
    }
    throw new Error(
      `disposable postgres volume ${VOLUME_NAME} could not be removed: ${lastVolumeError}`
    );
  }

  async function removeDisposableResources(): Promise<void> {
    if (!ownsContainer) return;
    await discardDisposableResources();
    ownsContainer = false;
  }

  async function createProject(): Promise<number> {
    const root = `/__ephemeral__/t05-derived/${RESOURCE_TOKEN}`;
    const projectId = await upsertProjectRagPostgresRepository(projectSql(), {
      name: `t05-derived-${RESOURCE_TOKEN}`,
      slug: `t05-derived-${RESOURCE_TOKEN}`,
      rootPath: root,
      normalizedRootPath: root,
      includeRoots: ['src'],
      ephemeral: true,
      metadata: { purpose: 'version-owned-derived-data', token: RESOURCE_TOKEN },
    });
    projectIds.add(projectId);
    return projectId;
  }

  async function createCandidate(
    projectId: number,
    contentHash: string,
    content: string,
    sourcePath = 'src/app.ts'
  ): Promise<{ readonly fileId: number; readonly versionId: number }> {
    const result = await upsertProjectRagPostgresFile(
      projectSql(),
      projectId,
      {
        sourcePath,
        absolutePath: `/__ephemeral__/t05-derived/${RESOURCE_TOKEN}/${sourcePath}`,
        contentHash,
        fileModifiedAt: Date.now(),
        lang: 'typescript',
        sizeBytes: content.length,
        status: 'indexed',
        metadataQuality: 'full',
      },
      'pending'
    );
    if (!result.fileId || !result.versionId) {
      throw new Error('candidate fixture did not return file/version ids');
    }
    return { fileId: result.fileId, versionId: result.versionId };
  }

  async function symbolIds(projectId: number, versionId: number): Promise<number[]> {
    const rows = (await projectObserver()`
      select id from project_symbols
      where project_id = ${projectId} and version_id = ${versionId}
      order by id
    `) as Array<Record<string, unknown>>;
    return rows.map((row) => Number(row.id));
  }

  async function embeddingCandidate(
    projectId: number,
    embeddingProfileHash: string
  ): Promise<{
    readonly chunkId: number;
    readonly sourceHash: string;
    readonly text: string;
  }> {
    const candidates = await listProjectRagPostgresChunkEmbeddingCandidates(
      projectSql(),
      projectId,
      { embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL, embeddingProfileHash }
    );
    const candidate = candidates[0];
    if (!candidate) throw new Error('embedding fixture did not return a chunk candidate');
    return candidate;
  }

  async function embeddingSnapshot(projectId: number, embeddingId: number): Promise<unknown> {
    const rows = (await projectObserver()`
      select embedding::text as "vector",
        source_hash as "sourceHash",
        xmin::text as "xmin",
        updated_at::text as "updatedAt"
      from project_embeddings_1024
      where project_id = ${projectId} and id = ${embeddingId}
    `) as Array<Record<string, unknown>>;
    return rows[0];
  }

  async function derivedSnapshot(
    table: 'project_chunks' | 'project_symbols' | 'project_edges',
    projectId: number,
    versionId: number
  ): Promise<string> {
    const rows =
      table === 'project_chunks'
        ? ((await projectObserver()`
            select coalesce(jsonb_agg(to_jsonb(snapshot_rows) order by snapshot_rows.id), '[]'::jsonb)::text as snapshot
            from (
              select * from project_chunks
              where project_id = ${projectId} and version_id = ${versionId}
            ) snapshot_rows
          `) as Array<Record<string, unknown>>)
        : table === 'project_symbols'
          ? ((await projectObserver()`
              select coalesce(jsonb_agg(to_jsonb(snapshot_rows) order by snapshot_rows.id), '[]'::jsonb)::text as snapshot
              from (
                select * from project_symbols
                where project_id = ${projectId} and version_id = ${versionId}
              ) snapshot_rows
            `) as Array<Record<string, unknown>>)
          : ((await projectObserver()`
              select coalesce(jsonb_agg(to_jsonb(snapshot_rows) order by snapshot_rows.id), '[]'::jsonb)::text as snapshot
              from (
                select * from project_edges
                where project_id = ${projectId} and source_version_id = ${versionId}
              ) snapshot_rows
            `) as Array<Record<string, unknown>>);
    return typeof rows[0]?.snapshot === 'string' ? rows[0].snapshot : '[]';
  }

  async function seedDerivedRows(
    projectId: number,
    candidate: { readonly fileId: number; readonly versionId: number },
    prefix: string,
    withSymbols: boolean
  ): Promise<void> {
    await replaceProjectRagPostgresFileChunks(
      projectSql(),
      projectId,
      candidate.fileId,
      [
        {
          chunkIndex: 0,
          content: `${prefix} chunk`,
          searchableText: `${prefix} searchable`,
          startLine: 1,
          endLine: 2,
          symbolName: withSymbols ? `${prefix}Symbol` : undefined,
          symbolKind: withSymbols ? 'function' : undefined,
          metadata: { fixture: prefix },
        },
      ],
      candidate.versionId
    );
    await replaceProjectRagPostgresFileSymbols(
      projectSql(),
      projectId,
      candidate.fileId,
      withSymbols
        ? [
            {
              name: `${prefix}Symbol`,
              symbolType: 'function',
              exportType: 'named',
              signature: `function ${prefix}Symbol()`,
              startLine: 1,
              endLine: 2,
              metadata: { fixture: prefix },
            },
          ]
        : [],
      candidate.versionId
    );
    const ids = await symbolIds(projectId, candidate.versionId);
    await replaceProjectRagPostgresFileEdges(
      projectSql(),
      projectId,
      candidate.fileId,
      withSymbols
        ? [
            {
              sourceVersionId: candidate.versionId,
              sourceSymbolId: ids[0],
              sourceRef: `${prefix}Symbol`,
              targetFileId: candidate.fileId,
              targetVersionId: candidate.versionId,
              targetSymbolId: ids[0],
              targetRef: `${prefix}Symbol`,
              relationType: 'CALLS',
              extractionMethod: 't05-fixture',
            },
          ]
        : [],
      candidate.versionId
    );
  }

  async function firstChunkId(projectId: number, versionId: number): Promise<number> {
    const rows = (await projectObserver()`select id from project_chunks
       where project_id = ${projectId} and version_id = ${versionId}
       order by id limit 1`) as Array<Record<string, unknown>>;
    const chunkId = Number(rows[0]?.id);
    if (!chunkId) throw new Error(`missing T-05 guard chunk for version ${versionId}`);
    return chunkId;
  }

  async function bindPendingVersionToBuild(
    projectId: number,
    candidate: { readonly fileId: number; readonly versionId: number }
  ): Promise<void> {
    const buildRows = (await projectSql()`
      insert into project_index_builds (project_id, status)
      values (${projectId}, 'building')
      returning id
    `) as Array<Record<string, unknown>>;
    const buildId = Number(buildRows[0]?.id);
    if (!buildId) throw new Error('T-05 guard build fixture did not return an id');

    await projectSql()`
      insert into project_index_build_files (
        build_id, project_id, file_id, version_id, source_path, absolute_path, lang,
        status, size_bytes, metadata_quality
      ) values (
        ${buildId}, ${projectId}, ${candidate.fileId}, ${candidate.versionId},
        ${`src/build-member-${candidate.versionId}.ts`},
        ${`/__ephemeral__/t05-derived/${RESOURCE_TOKEN}/src/build-member-${candidate.versionId}.ts`},
        'typescript', 'indexed', 1, 'full'
      )
    `;
  }

  async function assertChunkAndEmbeddingInsertsRejected(
    projectId: number,
    candidate: { readonly fileId: number; readonly versionId: number },
    chunkId: number
  ): Promise<void> {
    await expect(
      projectSql()`
        insert into project_chunks (
          project_id, file_id, version_id, chunk_index, content, searchable_text, enabled
        ) values (
          ${projectId}, ${candidate.fileId}, ${candidate.versionId}, 99,
          'raw blocked chunk', 'raw blocked chunk', true
        )
      `
    ).rejects.toThrow(/CANDIDATE_VERSION_IMMUTABLE|CANDIDATE_VERSION_BUILD_MEMBER/iu);

    await expect(
      replaceProjectRagPostgresFileChunks(
        projectSql(),
        projectId,
        candidate.fileId,
        [
          {
            chunkIndex: 98,
            content: 'store blocked chunk',
            searchableText: 'store blocked chunk',
          },
        ],
        candidate.versionId
      )
    ).rejects.toThrow(/CANDIDATE_VERSION_IMMUTABLE|CANDIDATE_VERSION_BUILD_MEMBER/iu);

    await expect(
      projectSql()`
        insert into project_embeddings_1024 (
          project_id, owner_type, owner_ref, file_id, chunk_id, version_id,
          embedding_model, embedding_provider, dimensions, embedding,
          source_hash, embedding_profile_hash
        ) values (
          ${projectId}, 'chunk', ${String(chunkId)}, ${candidate.fileId}, ${chunkId},
          ${candidate.versionId}, ${PROJECT_RAG_POSTGRES_EMBEDDING_MODEL}, 'llamacpp',
          ${PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS}, ${TEST_VECTOR_LITERAL}::halfvec,
          'raw-guard', ${`raw-guard-${candidate.versionId}`}
        )
      `
    ).rejects.toThrow(/CANDIDATE_VERSION_IMMUTABLE|CANDIDATE_VERSION_BUILD_MEMBER/iu);

    await expect(
      upsertProjectRagPostgresChunkEmbedding1024(projectSql(), projectId, {
        chunkId,
        sourceHash: 'store-guard',
        text: 'store blocked',
        embedding: TEST_EMBEDDING,
        embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
        embeddingProvider: 'llamacpp',
        dimensions: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
        embeddingProfileHash: `store-guard-${candidate.versionId}`,
      })
    ).rejects.toThrow(/CANDIDATE_VERSION_IMMUTABLE|CANDIDATE_VERSION_BUILD_MEMBER/iu);

    const candidates = await listProjectRagPostgresChunkEmbeddingCandidates(
      projectSql(),
      projectId,
      {
        embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
        embeddingProfileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
      }
    );
    expect(candidates.map((candidateRow) => candidateRow.chunkId)).not.toContain(chunkId);
  }

  beforeAll(async () => {
    const explicitUrl = process.env.PROJECT_RAG_T05_DATABASE_URL;
    try {
      if (explicitUrl) {
        databaseUrl = explicitUrl.trim();
        assertDisposableTarget(databaseUrl);
      } else {
        await startDisposableServer();
        assertDisposableTarget(databaseUrl);
      }
      sql = new Bun.SQL({ url: databaseUrl, max: 2, idleTimeout: 30, prepare: false });
      observer = new Bun.SQL({ url: databaseUrl, max: 1, idleTimeout: 30, prepare: false });
      await applyProjectMigrations();
    } catch (error) {
      // Vitest does not run afterAll when beforeAll throws; drop any
      // partially provisioned disposable server so startup regressions
      // cannot leak containers or volumes.
      try {
        await removeDisposableResources();
      } catch (cleanupError) {
        console.warn('t05 fixture best-effort cleanup failed:', cleanupError);
      }
      throw error;
    }
  }, 240_000);

  afterAll(async () => {
    try {
      for (const projectId of [...projectIds]) {
        await cleanupProject(projectId);
      }
    } finally {
      await sql?.close({ timeout: 5 }).catch(() => {});
      await observer?.close({ timeout: 5 }).catch(() => {});
      await removeDisposableResources();
    }
  }, 60_000);

  it('rejects nested top-level transactions on a real transaction handle', async () => {
    await expect(
      projectSql().begin(async (tx) => {
        await beginProjectRagWrite(tx as unknown as Bun.SQL, async () => {});
      })
    ).rejects.toThrow('NESTED_TRANSACTION_FORBIDDEN');
  });

  it('publishes parsed symbols and deduplicates navigation using its own fixture', async () => {
    const projectId = await createProject();
    try {
      const content =
        'export function first() { return helper(); }\nexport const second = () => helper();\n';
      const parsed = parseAst('src/app.ts', content);
      expect(parsed.symbols).toHaveLength(2);
      const source = await createCandidate(projectId, 'navigation-source', content);
      const target = await createCandidate(
        projectId,
        'navigation-target',
        'export function helper() {}',
        'src/helper.ts'
      );
      await seedDerivedRows(projectId, source, 'source', true);
      await seedDerivedRows(projectId, target, 'target', true);
      await replaceProjectRagPostgresFileSymbols(
        projectSql(),
        projectId,
        source.fileId,
        parsed.symbols.map((symbol) => ({
          name: symbol.name,
          symbolType: symbol.symbolType,
          exportType: symbol.exportType,
          signature: symbol.signature,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
        })),
        source.versionId
      );
      const sourceSymbols = await symbolIds(projectId, source.versionId);
      await replaceProjectRagPostgresFileEdges(
        projectSql(),
        projectId,
        source.fileId,
        sourceSymbols.map((sourceSymbolId, index) => ({
          sourceSymbolId,
          sourceRef: `caller-${index}`,
          targetFileId: target.fileId,
          targetVersionId: target.versionId,
          targetRef: 'helper',
          relationType: 'CALLS' as const,
        })),
        source.versionId
      );
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(2);
      await publishProjectRagPostgresIndexBuild(projectSql(), projectId);
      const outline = await getProjectRagPostgresFileOutline(projectSql(), projectId, 'src/app.ts');
      expect(outline?.symbolCount).toBe(parsed.symbols.length);
      expect(outline?.symbols.map((symbol) => symbol.name).sort()).toEqual(['first', 'second']);
      for (const symbol of outline?.symbols ?? []) {
        expect(symbol.startLine).toBeGreaterThanOrEqual(1);
        expect(symbol.endLine).toBeLessThanOrEqual(2);
      }
      const definitions = await findProjectRagPostgresSymbols(projectSql(), projectId, {
        name: 'first',
      });
      expect(definitions.definitions).toHaveLength(1);
      expect(definitions.definitions[0]?.sourcePath).toBe('src/app.ts');
      const paths = await getProjectRagPostgresNavigationPaths(
        projectSql(),
        projectId,
        'src/app.ts'
      );
      expect(paths).toHaveLength(1);
      expect(paths?.[0]).toMatchObject({ sourcePath: 'src/helper.ts', relationshipType: 'CALLS' });
    } finally {
      await cleanupProject(projectId);
    }
  });

  it('keeps published A isolated, rejects terminal mutation, and hides candidates from readers', async () => {
    const projectId = await createProject();
    try {
      const versionA = await createCandidate(projectId, 'hash-a', 'published A');
      await seedDerivedRows(projectId, versionA, 'publishedA', true);
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(1);
      const buildA = await publishProjectRagPostgresIndexBuild(projectSql(), projectId);

      const aChunks = await derivedSnapshot('project_chunks', projectId, versionA.versionId);
      const aSymbols = await derivedSnapshot('project_symbols', projectId, versionA.versionId);
      const aEdges = await derivedSnapshot('project_edges', projectId, versionA.versionId);

      await expect(
        replaceProjectRagPostgresFileChunks(
          projectSql(),
          projectId,
          versionA.fileId,
          [],
          versionA.versionId
        )
      ).rejects.toThrow('CANDIDATE_VERSION_IMMUTABLE');

      const aChunkRows = (await projectObserver()`
        select id from project_chunks where project_id = ${projectId} and version_id = ${versionA.versionId}
        order by id limit 1
      `) as Array<Record<string, unknown>>;
      const aSymbolRows = (await projectObserver()`
        select id from project_symbols where project_id = ${projectId} and version_id = ${versionA.versionId}
        order by id limit 1
      `) as Array<Record<string, unknown>>;
      const aEdgeRows = (await projectObserver()`
        select id from project_edges where project_id = ${projectId} and source_version_id = ${versionA.versionId}
        order by id limit 1
      `) as Array<Record<string, unknown>>;
      await expect(
        projectSql()`update project_chunks set content = content || 'mutated' where id = ${Number(aChunkRows[0]?.id)}`
      ).rejects.toThrow(/immutable/);
      await expect(
        projectSql()`update project_symbols set name = name || '_mutated' where id = ${Number(aSymbolRows[0]?.id)}`
      ).rejects.toThrow(/immutable/);
      await expect(
        projectSql()`update project_edges set relation_type = 'IMPORTS' where id = ${Number(aEdgeRows[0]?.id)}`
      ).rejects.toThrow(/immutable/);

      const versionB = await createCandidate(projectId, 'hash-b', 'candidate B');
      await seedDerivedRows(projectId, versionB, 'candidateBInitial', true);
      await seedDerivedRows(projectId, versionB, 'candidateBFinal', true);
      expect(await derivedSnapshot('project_chunks', projectId, versionA.versionId)).toBe(aChunks);
      expect(await derivedSnapshot('project_symbols', projectId, versionA.versionId)).toBe(
        aSymbols
      );
      expect(await derivedSnapshot('project_edges', projectId, versionA.versionId)).toBe(aEdges);

      const candidateRead = await getProjectRagPostgresFileWithChunks(
        projectSql(),
        projectId,
        'src/app.ts'
      );
      expect(candidateRead?.chunks.map((chunk) => chunk.content)).toEqual(['publishedA chunk']);
      const candidateOutline = await getProjectRagPostgresFileOutline(
        projectSql(),
        projectId,
        'src/app.ts'
      );
      expect(candidateOutline?.symbols.map((symbol) => symbol.name)).toEqual(['publishedASymbol']);
      const hiddenCandidateSymbol = await findProjectRagPostgresSymbols(projectSql(), projectId, {
        name: 'candidateBFinalSymbol',
      });
      expect(hiddenCandidateSymbol.definitions).toEqual([]);
      const hubs = await getProjectRagPostgresFeatureHubs(projectSql(), projectId, { minFiles: 1 });
      expect(hubs.flatMap((hub) => hub.files.flatMap((file) => file.symbols))).not.toContain(
        'candidateBFinalSymbol'
      );

      await beginProjectRagWrite(projectSql(), (tx) =>
        failProjectRagPostgresCandidateVersionInTransaction(
          tx,
          projectId,
          versionB.fileId,
          versionB.versionId,
          'AST_PARSE_FAILED: t05 fixture parse failure'
        )
      );
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(0);
      const activeAfterFailure = (await projectObserver()`
        select active_version_id as "activeVersionId" from project_files where id = ${versionB.fileId}
      `) as Array<Record<string, unknown>>;
      expect(Number(activeAfterFailure[0]?.activeVersionId)).toBe(versionA.versionId);
      expect(
        (await getProjectRagPostgresFileWithChunks(projectSql(), projectId, 'src/app.ts'))
          ?.chunks[0]?.content
      ).toBe('publishedA chunk');

      const versionC = await createCandidate(projectId, 'hash-c', 'valid zero-symbol B');
      await seedDerivedRows(projectId, versionC, 'zeroSymbolC', false);
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(1);
      const buildC = await publishProjectRagPostgresIndexBuild(projectSql(), projectId);
      expect(buildC.id).not.toBe(buildA.id);
      const currentRead = await getProjectRagPostgresFileWithChunks(
        projectSql(),
        projectId,
        'src/app.ts'
      );
      expect(currentRead?.chunks.map((chunk) => chunk.content)).toEqual(['zeroSymbolC chunk']);
      const currentOutline = await getProjectRagPostgresFileOutline(
        projectSql(),
        projectId,
        'src/app.ts'
      );
      expect(currentOutline?.symbols).toEqual([]);
      expect(
        (
          await findProjectRagPostgresSymbols(projectSql(), projectId, {
            name: 'candidateBFinalSymbol',
          })
        ).definitions
      ).toEqual([]);
    } finally {
      await cleanupProject(projectId);
    }
  }, 90_000);

  it('proves profile-owned insert identity, immutable ready rows, and exact read predicates', async () => {
    const projectId = await createProject();
    try {
      const versionA = await createCandidate(
        projectId,
        'embedding-hash-a',
        'embedding A',
        'src/a.ts'
      );
      await seedDerivedRows(projectId, versionA, 'embeddingA', false);
      const candidateA = await embeddingCandidate(
        projectId,
        PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH
      );

      const canonicalA = await upsertProjectRagPostgresChunkEmbedding1024(projectSql(), projectId, {
        ...candidateA,
        embedding: TEST_EMBEDDING,
        embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
        embeddingProvider: 'llamacpp',
        dimensions: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
        embeddingProfileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
      });
      expect(canonicalA).toBeGreaterThan(0);
      const beforeDuplicate = await embeddingSnapshot(projectId, canonicalA);

      const duplicate = await upsertProjectRagPostgresChunkEmbedding1024(projectSql(), projectId, {
        ...candidateA,
        embedding: FOREIGN_EMBEDDING,
        embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
        embeddingProvider: 'llamacpp',
        dimensions: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
        embeddingProfileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
        sourceHash: 'must-not-replace',
      });
      expect(duplicate).toBe(0);
      expect(await embeddingSnapshot(projectId, canonicalA)).toEqual(beforeDuplicate);

      // The old owner/model constraint would reject this same-owner row. The
      // profile-owned key must allow a foreign provider/profile to coexist.
      const foreignA = await upsertProjectRagPostgresChunkEmbedding1024(projectSql(), projectId, {
        ...candidateA,
        embedding: FOREIGN_EMBEDDING,
        embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
        embeddingProvider: 'foreign-provider',
        dimensions: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
        embeddingProfileHash: FOREIGN_PROFILE_HASH,
      });
      expect(foreignA).toBeGreaterThan(0);
      expect(foreignA).not.toBe(canonicalA);

      const versionB = await createCandidate(
        projectId,
        'embedding-hash-b',
        'embedding B',
        'src/b.ts'
      );
      await seedDerivedRows(projectId, versionB, 'foreignOnlyB', false);
      const candidateB = await embeddingCandidate(
        projectId,
        PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH
      );
      expect(candidateB.chunkId).not.toBe(candidateA.chunkId);
      const foreignB = await upsertProjectRagPostgresChunkEmbedding1024(projectSql(), projectId, {
        ...candidateB,
        embedding: FOREIGN_EMBEDDING,
        embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
        embeddingProvider: 'foreign-provider',
        dimensions: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
        embeddingProfileHash: FOREIGN_PROFILE_HASH,
      });
      expect(foreignB).toBeGreaterThan(0);

      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(2);
      await publishProjectRagPostgresIndexBuild(projectSql(), projectId);

      await expect(
        projectSql()`update project_embeddings_1024 set source_hash = 'mutated' where id = ${canonicalA}`
      ).rejects.toThrow(/immutable/);

      const searchResults = await searchProjectRagPostgresChunks(projectSql(), projectId, {
        query: 'foreignOnlyB',
        queryEmbedding: FOREIGN_EMBEDDING,
        embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
        embeddingProvider: 'llamacpp',
        embeddingDimensions: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
        embeddingProfileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
        limit: 5,
      });
      const foreignOnlyResult = searchResults.find((result) => result.sourcePath === 'src/b.ts');
      expect(foreignOnlyResult).toMatchObject({ sourcePath: 'src/b.ts', vectorScore: 0 });

      await expect(
        upsertProjectRagPostgresChunkEmbedding1024(projectSql(), projectId, {
          ...candidateB,
          embedding: TEST_EMBEDDING,
          embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
          embeddingProvider: 'llamacpp',
          dimensions: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
          embeddingProfileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
        })
      ).rejects.toThrow('CANDIDATE_VERSION_IMMUTABLE');

      expect(
        (
          await listProjectRagPostgresChunkEmbeddingCandidates(projectSql(), projectId, {
            embeddingModel: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
            embeddingProfileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
          })
        ).map((candidate) => candidate.chunkId)
      ).not.toContain(candidateB.chunkId);
    } finally {
      await cleanupProject(projectId);
    }
  }, 90_000);

  it('preserves non-null symbol project ownership when candidate chunks are deleted and rejects cross-version owners', async () => {
    const projectId = await createProject();
    try {
      const versionA = await createCandidate(projectId, 'ownership-hash-a', 'ownership A');
      await replaceProjectRagPostgresFileChunks(
        projectSql(),
        projectId,
        versionA.fileId,
        [
          {
            chunkIndex: 0,
            content: 'ownership A chunk',
            searchableText: 'ownership A chunk',
          },
        ],
        versionA.versionId
      );
      const chunkARows = (await projectObserver()`
        select id from project_chunks
        where project_id = ${projectId} and file_id = ${versionA.fileId} and version_id = ${versionA.versionId}
      `) as Array<Record<string, unknown>>;
      const chunkA = Number(chunkARows[0]?.id);

      const versionB = await createCandidate(projectId, 'ownership-hash-b', 'ownership B');
      await replaceProjectRagPostgresFileChunks(
        projectSql(),
        projectId,
        versionB.fileId,
        [
          {
            chunkIndex: 0,
            content: 'ownership B chunk',
            searchableText: 'ownership B chunk',
          },
        ],
        versionB.versionId
      );
      const chunkBRows = (await projectObserver()`
        select id from project_chunks
        where project_id = ${projectId} and file_id = ${versionB.fileId} and version_id = ${versionB.versionId}
      `) as Array<Record<string, unknown>>;
      const chunkB = Number(chunkBRows[0]?.id);

      const symbolA = await insertProjectRagPostgresSymbol(projectSql(), projectId, {
        fileId: versionA.fileId,
        versionId: versionA.versionId,
        chunkId: chunkA,
        name: 'ownershipA',
        symbolType: 'function',
      });
      const symbolB = await insertProjectRagPostgresSymbol(projectSql(), projectId, {
        fileId: versionB.fileId,
        versionId: versionB.versionId,
        chunkId: chunkB,
        name: 'ownershipB',
        symbolType: 'function',
      });

      await expect(
        projectSql()`
          insert into project_symbols (
            project_id, file_id, version_id, chunk_id, name, symbol_type
          ) values (
            ${projectId}, ${versionA.fileId}, ${versionA.versionId}, ${chunkB}, 'crossVersion', 'function'
          )
        `
      ).rejects.toThrow(/SYMBOL_CHUNK_OWNERSHIP_MISMATCH|project_symbols_chunk_project_fk/iu);

      await expect(
        projectSql()`
          insert into project_embeddings_1024 (
            project_id, owner_type, owner_ref, file_id, chunk_id, version_id,
            embedding_model, embedding_provider, dimensions, embedding,
            source_hash, embedding_profile_hash
          ) values (
            ${projectId}, 'chunk', ${String(chunkB)}, ${versionB.fileId}, ${chunkB}, ${versionA.versionId},
            ${PROJECT_RAG_POSTGRES_EMBEDDING_MODEL}, 'llamacpp', ${PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS},
            ${TEST_VECTOR_LITERAL}::halfvec, 'cross-version-chunk', 'ownership-chunk-profile'
          )
        `
      ).rejects.toThrow(/project_embeddings_1024_chunk_version_project_fk|foreign key/iu);

      await expect(
        projectSql()`
          insert into project_embeddings_1024 (
            project_id, owner_type, owner_ref, file_id, symbol_id, version_id,
            embedding_model, embedding_provider, dimensions, embedding,
            source_hash, embedding_profile_hash
          ) values (
            ${projectId}, 'symbol', ${String(symbolB)}, ${versionB.fileId}, ${symbolB}, ${versionA.versionId},
            ${PROJECT_RAG_POSTGRES_EMBEDDING_MODEL}, 'llamacpp', ${PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS},
            ${TEST_VECTOR_LITERAL}::halfvec, 'cross-version-symbol', 'ownership-symbol-profile'
          )
        `
      ).rejects.toThrow(/project_embeddings_1024_symbol_version_project_fk|foreign key/iu);

      const otherFile = await createCandidate(
        projectId,
        'ownership-hash-other',
        'ownership other',
        'src/other.ts'
      );
      await expect(
        projectSql()`
          insert into project_embeddings_1024 (
            project_id, owner_type, owner_ref, file_id, version_id,
            embedding_model, embedding_provider, dimensions, embedding,
            source_hash, embedding_profile_hash
          ) values (
            ${projectId}, 'file', ${String(otherFile.fileId)}, ${otherFile.fileId}, ${versionA.versionId},
            ${PROJECT_RAG_POSTGRES_EMBEDDING_MODEL}, 'llamacpp', ${PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS},
            ${TEST_VECTOR_LITERAL}::halfvec, 'cross-version-file', 'ownership-file-profile'
          )
        `
      ).rejects.toThrow(
        /CANDIDATE_VERSION_NOT_FOUND|project_embeddings_1024_file_project_fk|foreign key/iu
      );

      await replaceProjectRagPostgresFileChunks(
        projectSql(),
        projectId,
        versionA.fileId,
        [],
        versionA.versionId
      );
      const detachedSymbol = (await projectObserver()`
        select project_id as "projectId", chunk_id as "chunkId"
        from project_symbols where id = ${symbolA}
      `) as Array<Record<string, unknown>>;
      expect(Number(detachedSymbol[0]?.projectId)).toBe(projectId);
      expect(detachedSymbol[0]?.chunkId).toBeNull();
    } finally {
      await cleanupProject(projectId);
    }
  }, 90_000);

  it('rejects raw and supported graph inserts for ready, failed, replaced, and published versions', async () => {
    const projectId = await createProject();
    try {
      const ready = await createCandidate(projectId, 'guard-ready', 'guard ready');
      const pendingSymbol = await insertProjectRagPostgresSymbol(projectSql(), projectId, {
        fileId: ready.fileId,
        versionId: ready.versionId,
        name: 'pendingGuard',
        symbolType: 'function',
      });
      expect(pendingSymbol).toBeGreaterThan(0);
      expect(
        await insertProjectRagPostgresEdge(projectSql(), projectId, {
          sourceFileId: ready.fileId,
          sourceVersionId: ready.versionId,
          sourceSymbolId: pendingSymbol,
          targetFileId: ready.fileId,
          targetVersionId: ready.versionId,
          targetSymbolId: pendingSymbol,
          relationType: 'CALLS',
        })
      ).toBeGreaterThan(0);

      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(1);
      await publishProjectRagPostgresIndexBuild(projectSql(), projectId);

      const assertRejected = async (version: { fileId: number; versionId: number }) => {
        await expect(
          projectSql()`
            insert into project_symbols (project_id, file_id, version_id, name, symbol_type)
            values (${projectId}, ${version.fileId}, ${version.versionId}, 'rawBlocked', 'function')
          `
        ).rejects.toThrow(/CANDIDATE_VERSION_IMMUTABLE|CANDIDATE_VERSION_BUILD_MEMBER/iu);
        await expect(
          insertProjectRagPostgresSymbol(projectSql(), projectId, {
            fileId: version.fileId,
            versionId: version.versionId,
            name: 'storeBlocked',
            symbolType: 'function',
          })
        ).rejects.toThrow(/CANDIDATE_VERSION_IMMUTABLE|CANDIDATE_VERSION_BUILD_MEMBER/iu);
        await expect(
          projectSql()`
            insert into project_edges (
              project_id, source_file_id, source_version_id, relation_type
            ) values (${projectId}, ${version.fileId}, ${version.versionId}, 'CALLS')
          `
        ).rejects.toThrow(/CANDIDATE_VERSION_IMMUTABLE|CANDIDATE_VERSION_BUILD_MEMBER/iu);
        await expect(
          insertProjectRagPostgresEdge(projectSql(), projectId, {
            sourceFileId: version.fileId,
            sourceVersionId: version.versionId,
            relationType: 'CALLS',
          })
        ).rejects.toThrow(/CANDIDATE_VERSION_IMMUTABLE|CANDIDATE_VERSION_BUILD_MEMBER/iu);
      };

      // The ready version is also a published-build member, so this covers
      // both immutable lifecycle states without weakening the build boundary.
      await assertRejected(ready);

      const failed = await createCandidate(projectId, 'guard-failed', 'guard failed');
      await beginProjectRagWrite(projectSql(), (tx) =>
        failProjectRagPostgresCandidateVersionInTransaction(
          tx,
          projectId,
          failed.fileId,
          failed.versionId,
          'T05 fixture failure'
        )
      );
      await assertRejected(failed);

      const replaced = await createCandidate(projectId, 'guard-replaced', 'guard replaced');
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(1);
      const successor = await createCandidate(projectId, 'guard-successor', 'guard successor');
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(1);
      const replacedState = (await projectObserver()`
        select status from project_file_versions where id = ${replaced.versionId}
      `) as Array<Record<string, unknown>>;
      expect(replacedState[0]?.status).toBe('replaced');
      await assertRejected(replaced);
      expect(successor.versionId).toBeGreaterThan(replaced.versionId);
    } finally {
      await cleanupProject(projectId);
    }
  }, 90_000);

  it('rejects raw and store chunk/embedding inserts outside pending unbuilt candidates', async () => {
    const projectId = await createProject();
    try {
      const ready = await createCandidate(
        projectId,
        'chunk-guard-ready',
        'chunk guard ready',
        'src/guard-ready.ts'
      );
      await seedDerivedRows(projectId, ready, 'chunkGuardReady', false);
      const readyChunkId = await firstChunkId(projectId, ready.versionId);
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(1);
      await publishProjectRagPostgresIndexBuild(projectSql(), projectId);
      await assertChunkAndEmbeddingInsertsRejected(projectId, ready, readyChunkId);

      const failed = await createCandidate(
        projectId,
        'chunk-guard-failed',
        'chunk guard failed',
        'src/guard-failed.ts'
      );
      await seedDerivedRows(projectId, failed, 'chunkGuardFailed', false);
      const failedChunkId = await firstChunkId(projectId, failed.versionId);
      await beginProjectRagWrite(projectSql(), (tx) =>
        failProjectRagPostgresCandidateVersionInTransaction(
          tx,
          projectId,
          failed.fileId,
          failed.versionId,
          'T05 chunk guard fixture failure'
        )
      );
      await assertChunkAndEmbeddingInsertsRejected(projectId, failed, failedChunkId);

      const replaced = await createCandidate(
        projectId,
        'chunk-guard-replaced',
        'chunk guard replaced',
        'src/guard-replaced.ts'
      );
      await seedDerivedRows(projectId, replaced, 'chunkGuardReplaced', false);
      const replacedChunkId = await firstChunkId(projectId, replaced.versionId);
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(1);
      const successor = await createCandidate(
        projectId,
        'chunk-guard-successor',
        'chunk guard successor',
        'src/guard-replaced.ts'
      );
      expect(await promoteProjectRagPostgresFileVersions(projectSql(), projectId)).toBe(1);
      const replacedState = (await projectObserver()`
        select status from project_file_versions where id = ${replaced.versionId}
      `) as Array<Record<string, unknown>>;
      expect(replacedState[0]?.status).toBe('replaced');
      await assertChunkAndEmbeddingInsertsRejected(projectId, replaced, replacedChunkId);
      expect(successor.versionId).toBeGreaterThan(replaced.versionId);

      const buildMember = await createCandidate(
        projectId,
        'chunk-guard-build-member',
        'chunk guard build member',
        'src/guard-build-member.ts'
      );
      await seedDerivedRows(projectId, buildMember, 'chunkGuardBuildMember', false);
      const buildMemberChunkId = await firstChunkId(projectId, buildMember.versionId);
      await bindPendingVersionToBuild(projectId, buildMember);
      await assertChunkAndEmbeddingInsertsRejected(projectId, buildMember, buildMemberChunkId);
    } finally {
      await cleanupProject(projectId);
    }
  }, 120_000);

  it('is skipped unless the real database gate is explicitly enabled', () => {
    if (!RUN_REAL_DB) {
      expect(process.env.PROJECT_RAG_REAL_DB_TEST).not.toBe('1');
    } else {
      expect(process.env.PROJECT_RAG_REAL_DB_TEST).toBe('1');
    }
  });
});
