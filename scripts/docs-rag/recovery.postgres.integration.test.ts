/**
 * Opt-in real-Postgres recovery trials for Docs RAG source generations.
 *
 * The suite targets only the disposable T-04 W3 database and uses an
 * in-process deterministic embedding provider. It intentionally does not
 * start/stop Postgres or touch the official Docs RAG runtime.
 *
 * Run with DOCS_RAG_T04_W3_REAL_DB_TEST=1. The default target is
 * postgres://postgres@127.0.0.1:64555/rag_v2_t04_final. An explicit URL may be
 * supplied through DOCS_RAG_T04_W3_DATABASE_URL when it passes the same
 * fail-closed disposable-target policy.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adaptReservedSql,
  canonicalizeMigrationTarget,
  loadManifest,
  OFFICIAL_DATABASE_NAMES,
  OFFICIAL_DATABASE_PORTS,
  runApply,
} from '../db-migrations/runner.js';
import { processFile, resolveExternalDocsProcessingProfile } from '../sync-external-docs.js';
import { type DocsRagLabConfig, redactPostgresUrl } from './config.js';
import {
  buildDocsRagSourceGenerationKey,
  createDocsRagSourceGeneration,
  finalizeDocsRagSourceGeneration,
  publishDocsRagSourceGeneration,
  searchDocsRagLab,
} from './store.js';

const RUN_REAL_DB = process.env.DOCS_RAG_T04_W3_REAL_DB_TEST === '1';
const describeReal = RUN_REAL_DB ? describe : describe.skip;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RECOVERY_WORKER_PATH = fileURLToPath(new URL('./recovery.worker.ts', import.meta.url));
const DATABASE_URL =
  process.env.DOCS_RAG_T04_W3_DATABASE_URL ??
  'postgres://postgres@127.0.0.1:64555/rag_v2_t04_final';
const SOURCE_ID = 'bun-docs';
const EMBEDDING_MODEL = 't04-w3-fake-embedder-1024';
const DIMENSIONS = 1024;
const T04_DATABASE_NAME_PATTERN = /^rag_v2_t04(?:_[a-z0-9][a-z0-9_-]*)?$/;
const COMMON_DATABASE_NAMES = new Set([
  'postgres',
  'template0',
  'template1',
  'rag_v2',
  ...OFFICIAL_DATABASE_NAMES,
]);
const RUN_TOKEN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

interface ProviderState {
  readonly requests: string[];
}

interface Fixture {
  readonly rawAbsolutePath: string;
  readonly processedAbsolutePath: string;
  readonly sourcePath: string;
  readonly rawContent: string;
  readonly marker: string;
}

interface ProviderHandle {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly state: ProviderState;
  readonly config: DocsRagLabConfig;
}

interface RecoveryWorkerReport {
  readonly phase: 'prepare' | 'recover';
  readonly generationId: number;
  readonly generationKey: string;
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  readonly canonicalExists: boolean;
  readonly tempStageCount: number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deterministicVector(text: string): number[] {
  const vector: number[] = [];
  for (let counter = 0; vector.length < DIMENSIONS; counter += 1) {
    const digest = createHash('sha256').update(`${text}:${counter}`, 'utf8').digest();
    for (const byte of digest) {
      if (vector.length >= DIMENSIONS) break;
      vector.push(((byte % 2000) - 1000) / 1000);
    }
  }
  return vector;
}

function assertDisposableTarget(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('T-04 W3 recovery trials require a valid disposable Postgres URL');
  }
  if (parsed.protocol !== 'postgres:') {
    throw new Error('T-04 W3 recovery trials require the postgres protocol');
  }
  if (parsed.username !== 'postgres' || parsed.password) {
    throw new Error('T-04 W3 recovery trials require the postgres user without a password');
  }
  if (!parsed.port || !/^\d+$/.test(parsed.port)) {
    throw new Error('T-04 W3 recovery trials require an explicit numeric listener port');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('T-04 W3 recovery trial URLs may not contain query or fragment overrides');
  }

  let identity: ReturnType<typeof canonicalizeMigrationTarget>;
  try {
    identity = canonicalizeMigrationTarget(rawUrl);
  } catch {
    throw new Error('T-04 W3 recovery trials require a valid disposable Postgres URL');
  }
  if (identity.host !== '127.0.0.1' && identity.host !== '::1') {
    throw new Error('T-04 W3 recovery trials require a loopback host');
  }
  if (OFFICIAL_DATABASE_PORTS.includes(identity.port)) {
    throw new Error('T-04 W3 recovery trials require a non-ops listener port');
  }
  const databaseName = identity.database.toLowerCase();
  if (
    COMMON_DATABASE_NAMES.has(databaseName) ||
    !T04_DATABASE_NAME_PATTERN.test(identity.database)
  ) {
    throw new Error('T-04 W3 recovery trials require a rag_v2_t04-prefixed database');
  }
}

describe('T-04 W3 disposable target guard', () => {
  it('accepts the current disposable recovery target', () => {
    for (const url of [
      'postgres://postgres@127.0.0.1:64555/rag_v2_t04_final',
      'postgres://postgres@127.0.0.1:59564/rag_v2_t04_w3',
    ]) {
      expect(() => assertDisposableTarget(url)).not.toThrow();
    }
  });

  it('rejects official and common database names', () => {
    for (const name of ['postgres', 'template1', 'docs_rag_lab', 'rag_v2', 'rag_dev']) {
      expect(() => assertDisposableTarget(`postgres://postgres@127.0.0.1:64555/${name}`)).toThrow();
    }
  });

  it('rejects non-loopback hosts and protocol aliases', () => {
    for (const url of [
      'postgres://postgres@localhost:64555/rag_v2_t04_final',
      'postgres://postgres@10.0.0.2:64555/rag_v2_t04_final',
      'postgres://postgres@[::ffff:127.0.0.1]:64555/rag_v2_t04_final',
      'postgresql://postgres@127.0.0.1:64555/rag_v2_t04_final',
    ]) {
      expect(() => assertDisposableTarget(url)).toThrow();
    }
  });

  it('rejects official ports, implicit ports, and credentials', () => {
    expect(() =>
      assertDisposableTarget('postgres://postgres@127.0.0.1:5432/rag_v2_t04_final')
    ).toThrow();
    expect(() =>
      assertDisposableTarget('postgres://postgres@127.0.0.1/rag_v2_t04_final')
    ).toThrow();
    expect(() =>
      assertDisposableTarget('postgres://postgres:secret@127.0.0.1:64555/rag_v2_t04_final')
    ).toThrow();
  });
});

function buildConfig(rootDir: string, baseUrl: string): DocsRagLabConfig {
  return {
    tool: 'docs-rag-pg-lab',
    rootDir,
    defaultEvalFixturePath: join(rootDir, 'eval-fixture.json'),
    evalTopK: 10,
    healthTimeoutMs: 5_000,
    embedding: {
      provider: 'llamacpp',
      model: EMBEDDING_MODEL,
      baseUrl,
      dimensions: DIMENSIONS,
      timeoutMs: 2_000,
      batchSize: 8,
      maxConcurrentBatches: 1,
    },
    database: { url: DATABASE_URL, redactedUrl: redactPostgresUrl(DATABASE_URL), source: 'test' },
    pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
    gates: { liveSearchEnabled: true, embeddingEnabled: true, mutationEnabled: true },
  };
}

function startEmbeddingProvider(rootDir: string): ProviderHandle {
  const state: ProviderState = { requests: [] };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/v1/embeddings') {
        return new Response('not found', { status: 404 });
      }
      const body = (await request.json()) as { model?: unknown; input?: unknown };
      if (
        typeof body.model !== 'string' ||
        !Array.isArray(body.input) ||
        body.input.some((text) => typeof text !== 'string')
      ) {
        return Response.json({ error: { message: 'invalid embedding request' } }, { status: 400 });
      }
      const texts = body.input as string[];
      state.requests.push(...texts);
      return Response.json({
        model: body.model,
        data: texts.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: deterministicVector(text),
        })),
      });
    },
  });
  return { server, state, config: buildConfig(rootDir, `http://127.0.0.1:${server.port}`) };
}

function sanitizeWorkerOutput(value: string, rootDir: string, providerUrl: string): string {
  return value
    .replaceAll(rootDir, '<fixture-root>')
    .replaceAll(DATABASE_URL, '<db>')
    .replaceAll(providerUrl, '<provider>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

function runRecoveryWorker(
  phase: RecoveryWorkerReport['phase'],
  config: DocsRagLabConfig,
  fixture: Fixture,
  revision: string,
  rootDir: string
): Promise<RecoveryWorkerReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RECOVERY_WORKER_PATH, phase], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        T04_W3_DATABASE_URL: DATABASE_URL,
        T04_W3_PROVIDER_URL: config.embedding.baseUrl,
        T04_W3_ROOT_DIR: rootDir,
        T04_W3_RAW_PATH: fixture.rawAbsolutePath,
        T04_W3_PROCESSED_PATH: fixture.processedAbsolutePath,
        T04_W3_SOURCE_PATH: fixture.sourcePath,
        T04_W3_SOURCE_REVISION: revision,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (stdout.length < 8_000) stdout += String(chunk).slice(0, 8_000 - stdout.length);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 8_000) stderr += String(chunk).slice(0, 8_000 - stderr.length);
    });
    child.once('error', (error) => {
      reject(new Error(`recovery worker ${phase} could not start: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      const resultLine = stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('T04W3_WORKER_RESULT '));
      if (code !== 0 || !resultLine) {
        const details = sanitizeWorkerOutput(
          `${stdout}\n${stderr}`,
          rootDir,
          config.embedding.baseUrl
        );
        reject(
          new Error(
            `recovery worker ${phase} failed (exit=${code ?? 'null'} signal=${signal ?? 'null'}): ${details}`
          )
        );
        return;
      }
      try {
        const report = JSON.parse(
          resultLine.slice('T04W3_WORKER_RESULT '.length)
        ) as RecoveryWorkerReport;
        if (report.phase !== phase) {
          reject(new Error(`recovery worker reported phase ${report.phase}, expected ${phase}`));
          return;
        }
        resolve(report);
      } catch (error) {
        reject(
          new Error(
            `recovery worker ${phase} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  });
}

describeReal('Docs RAG T-04 W3 recovery trials (real disposable Postgres)', () => {
  let sql: Bun.SQL;
  let observer: Bun.SQL;
  let rootDir: string;
  let fixtureCounter = 0;

  async function query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = (await observer.unsafe(text, [...params])) as T[];
    // Bun.SQL may retain the driver-backed result array while a pooled
    // connection is reused. Copy rows before assertions so later calls cannot
    // mutate the evidence captured by this query.
    return result.map((row) => ({ ...row }));
  }

  async function applyDocsMigrations(): Promise<void> {
    const manifest = await loadManifest(REPO_ROOT, 'docs');
    const reserved = adaptReservedSql(await sql.reserve());
    try {
      const identity = canonicalizeMigrationTarget(DATABASE_URL);
      await runApply({
        db: reserved,
        lane: 'docs',
        manifest,
        redactedUrl: identity.redactedUrl,
        targetFingerprint: identity.fingerprint,
        dryRun: false,
      });
    } finally {
      await reserved.release().catch(() => {});
    }
  }

  function makeFixture(label: string, marker: string): Fixture {
    fixtureCounter += 1;
    const filename = `recovery-${label}-${RUN_TOKEN}-${fixtureCounter}.md`;
    const sourcePath = `${SOURCE_ID}/${filename}`;
    const rawContent = `# ${label}\n\n${marker} remains searchable after recovery.\n`;
    const rawAbsolutePath = join(rootDir, 'raw-sync', filename);
    const processedAbsolutePath = join(rootDir, 'ingest/processed/external', sourcePath);
    mkdirSync(dirname(rawAbsolutePath), { recursive: true });
    writeFileSync(rawAbsolutePath, rawContent, 'utf8');
    return { rawAbsolutePath, processedAbsolutePath, sourcePath, rawContent, marker };
  }

  function validMode(generationId: number, fixture: Fixture, revision: string) {
    return {
      dryRun: false,
      skipLlm: true,
      generationId,
      sourceUrl: 'https://github.com/example/docs',
      sourceRevision: revision,
      upstreamPath: fixture.sourcePath,
      syncedAt: '2026-08-30T00:00:00.000Z',
    };
  }

  async function createGeneration(
    config: DocsRagLabConfig,
    fixture: Fixture,
    options: { readonly revision?: string; readonly validProvenance?: boolean } = {}
  ) {
    const revision = options.revision ?? 'a'.repeat(40);
    const profileInput = options.validProvenance
      ? { dryRun: false, skipLlm: true, sourceRevision: revision }
      : { dryRun: false, skipLlm: true };
    const { profile, profileHash } = resolveExternalDocsProcessingProfile(
      config,
      profileInput,
      options.validProvenance ? revision : undefined
    );
    const rawManifestSha256 = sha256Hex(fixture.rawContent);
    const generationKey = buildDocsRagSourceGenerationKey({
      sourceId: SOURCE_ID,
      upstreamRevision: options.validProvenance ? revision : null,
      rawManifestSha256,
      processingProfileHash: profileHash,
    });
    return await createDocsRagSourceGeneration(config, {
      sourceId: SOURCE_ID,
      provenanceClass: 'revision_bound_external',
      generationKey,
      upstreamRevision: options.validProvenance ? revision : null,
      upstreamPath: fixture.sourcePath,
      license: 'MIT',
      rawManifestSha256,
      processingProfileHash: profileHash,
      processingProfile: profile,
      expectedDocumentCount: 1,
      scanState: 'pending',
    });
  }

  async function processFixture(
    config: DocsRagLabConfig,
    generationId: number,
    fixture: Fixture,
    revision: string,
    deps?: Parameters<typeof processFile>[6]
  ) {
    return await processFile(
      fixture.rawAbsolutePath,
      fixture.processedAbsolutePath,
      fixture.sourcePath,
      'bun',
      config,
      validMode(generationId, fixture, revision),
      deps
    );
  }

  async function publishFixture(
    config: DocsRagLabConfig,
    fixture: Fixture,
    revision = 'a'.repeat(40)
  ) {
    const generation = await createGeneration(config, fixture, {
      revision,
      validProvenance: true,
    });
    const result = await processFixture(config, generation.id, fixture, revision);
    expect(result).toMatchObject({ success: true });
    await finalizeDocsRagSourceGeneration(config, {
      generationId: generation.id,
      scanState: 'complete',
    });
    const published = await publishDocsRagSourceGeneration(config, {
      generationId: generation.id,
    });
    expect(published.published).toBe(true);
    return generation.id;
  }

  async function pointerGenerationId(): Promise<number | null> {
    const rows = await query<{ readonly generationId: number | string }>(
      `select generation_id as "generationId"
       from docs_source_generation_pointers
       where source_id = $1`,
      [SOURCE_ID]
    );
    return rows[0] ? Number(rows[0].generationId) : null;
  }

  async function searchSnapshot(config: DocsRagLabConfig, marker: string) {
    const report = await searchDocsRagLab(config, marker, {
      mode: 'keyword',
      sourceId: SOURCE_ID,
      limit: 10,
    });
    return report.results.map((result) => ({
      sourcePath: result.sourcePath,
      chunkIndex: result.chunkIndex,
      content: result.content,
    }));
  }

  beforeAll(async () => {
    assertDisposableTarget(DATABASE_URL);
    sql = new Bun.SQL({ url: DATABASE_URL, max: 2, connectionTimeout: 10, prepare: false });
    rootDir = mkdtempSync(join(tmpdir(), 'rag-v2-t04-w3-recovery-'));
    await applyDocsMigrations();
    observer = new Bun.SQL({ url: DATABASE_URL, max: 1, connectionTimeout: 10, prepare: false });
  }, 120_000);

  afterAll(async () => {
    await observer?.close({ timeout: 5 }).catch(() => {});
    await sql?.close({ timeout: 5 }).catch(() => {});
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  }, 30_000);

  it('keeps the prior pointer and result set when prepublish validation rejects staging', async () => {
    const provider = startEmbeddingProvider(rootDir);
    try {
      const oldFixture = makeFixture('validator-old', `validatorold${RUN_TOKEN}`);
      const oldGenerationId = await publishFixture(provider.config, oldFixture);
      const beforePointer = await pointerGenerationId();
      const beforeResults = await searchSnapshot(provider.config, oldFixture.marker);
      expect(beforePointer).toBe(oldGenerationId);
      expect(beforeResults).toHaveLength(1);

      // This generation intentionally omits revision-bound provenance. The
      // write is allowed to remain staged; publication must fail closed.
      const invalidFixture = makeFixture('validator-invalid', `validatorinvalid${RUN_TOKEN}`);
      const invalidGeneration = await createGeneration(provider.config, invalidFixture);
      const invalidResult = await processFile(
        invalidFixture.rawAbsolutePath,
        invalidFixture.processedAbsolutePath,
        invalidFixture.sourcePath,
        'bun',
        provider.config,
        { dryRun: false, skipLlm: true, generationId: invalidGeneration.id }
      );
      expect(invalidResult).toMatchObject({ success: true });
      await finalizeDocsRagSourceGeneration(provider.config, {
        generationId: invalidGeneration.id,
        scanState: 'complete',
      });
      await expect(
        publishDocsRagSourceGeneration(provider.config, { generationId: invalidGeneration.id })
      ).rejects.toThrow(/DOCUMENT_INVALID|publication|provenance|invalid/i);

      expect(await pointerGenerationId()).toBe(beforePointer);
      expect(await searchSnapshot(provider.config, oldFixture.marker)).toEqual(beforeResults);
      const state = await query<{
        readonly status: string;
        readonly scanState: string;
      }>(
        `select status, scan_state as "scanState"
         from docs_source_generations where id = $1`,
        [invalidGeneration.id]
      );
      expect(state).toEqual([{ status: 'staging', scanState: 'complete' }]);
      expect(await searchSnapshot(provider.config, invalidFixture.marker)).toEqual([]);
    } finally {
      provider.server.stop(true);
    }
  }, 120_000);

  it('retries transport loss under one generation key without duplicate serving rows', async () => {
    const firstProvider = startEmbeddingProvider(rootDir);
    const fixture = makeFixture('transport-retry', `transportretry${RUN_TOKEN}`);
    const revision = 'b'.repeat(40);
    try {
      const generation = await createGeneration(firstProvider.config, fixture, {
        revision,
        validProvenance: true,
      });
      firstProvider.server.stop(true);

      const failed = await processFixture(firstProvider.config, generation.id, fixture, revision);
      expect(failed.success).toBe(false);
      expect(failed.error).toMatch(/fetch|connect|network|failed/i);
      const afterFailure = await query<{
        readonly documents: string;
        readonly chunks: string;
        readonly embeddings: string;
      }>(
        `select
           (select count(*) from docs_documents where generation_id = $1)::text as documents,
           (select count(*) from docs_chunks c join docs_documents d on d.id = c.document_id where d.generation_id = $1)::text as chunks,
           (select count(*) from docs_embeddings e join docs_chunks c on c.id = e.chunk_id join docs_documents d on d.id = c.document_id where d.generation_id = $1)::text as embeddings`,
        [generation.id]
      );
      expect(afterFailure).toEqual([{ documents: '0', chunks: '0', embeddings: '0' }]);

      const retryProvider = startEmbeddingProvider(rootDir);
      try {
        const retriedGeneration = await createGeneration(retryProvider.config, fixture, {
          revision,
          validProvenance: true,
        });
        expect(retriedGeneration.id).toBe(generation.id);
        expect(retriedGeneration.status).toBe('staging');

        const succeeded = await processFixture(
          retryProvider.config,
          retriedGeneration.id,
          fixture,
          revision
        );
        expect(succeeded).toMatchObject({ success: true });
        await finalizeDocsRagSourceGeneration(retryProvider.config, {
          generationId: retriedGeneration.id,
          scanState: 'complete',
        });
        await publishDocsRagSourceGeneration(retryProvider.config, {
          generationId: retriedGeneration.id,
        });

        const rows = await query<{
          readonly generations: string;
          readonly documents: string;
          readonly chunks: string;
          readonly embeddings: string;
        }>(
          `select
             (select count(*) from docs_source_generations where source_id = $1 and generation_key = $2)::text as generations,
             (select count(*) from docs_documents where generation_id = $3)::text as documents,
             (select count(*) from docs_chunks c join docs_documents d on d.id = c.document_id where d.generation_id = $3)::text as chunks,
             (select count(*) from docs_embeddings e join docs_chunks c on c.id = e.chunk_id join docs_documents d on d.id = c.document_id where d.generation_id = $3)::text as embeddings`,
          [SOURCE_ID, generation.generationKey, generation.id]
        );
        expect(rows).toEqual([{ generations: '1', documents: '1', chunks: '1', embeddings: '1' }]);
        expect(await pointerGenerationId()).toBe(generation.id);
        expect(await searchSnapshot(retryProvider.config, fixture.marker)).toHaveLength(1);
      } finally {
        retryProvider.server.stop(true);
      }
    } finally {
      firstProvider.server.stop(true);
    }
  }, 120_000);

  it('reuses committed and staged state across process restart without provider work', async () => {
    const provider = startEmbeddingProvider(rootDir);
    try {
      const fixture = makeFixture('restart-adoption', `restartadoption${RUN_TOKEN}`);
      const revision = 'c'.repeat(40);
      const requestsBeforePrepare = provider.state.requests.length;
      const prepared = await runRecoveryWorker(
        'prepare',
        provider.config,
        fixture,
        revision,
        rootDir
      );
      expect(provider.state.requests.length).toBeGreaterThan(requestsBeforePrepare);
      expect(prepared).toMatchObject({
        phase: 'prepare',
        documents: 1,
        chunks: 1,
        embeddings: 1,
        canonicalExists: false,
        tempStageCount: 1,
      });
      expect(prepared.generationId).toBeGreaterThan(0);
      expect(prepared.generationKey).toMatch(/^[0-9a-f]{64}$/);

      const providerRequestsAfterPrepare = provider.state.requests.length;
      const recovered = await runRecoveryWorker(
        'recover',
        provider.config,
        fixture,
        revision,
        rootDir
      );
      expect(provider.state.requests.length).toBe(providerRequestsAfterPrepare);
      expect(recovered).toMatchObject({
        phase: 'recover',
        generationId: prepared.generationId,
        generationKey: prepared.generationKey,
        documents: 1,
        chunks: 1,
        embeddings: 1,
        canonicalExists: true,
        tempStageCount: 0,
      });
      expect(recovered.generationId).toBe(prepared.generationId);
      expect(recovered.generationKey).toBe(prepared.generationKey);
      expect(readFileSync(fixture.processedAbsolutePath, 'utf8')).toContain('restartadoption');
    } finally {
      provider.server.stop(true);
    }
  }, 120_000);

  it('keeps a newer staging generation invisible while the old publication serves', async () => {
    const provider = startEmbeddingProvider(rootDir);
    try {
      const oldFixture = makeFixture('staging-old', `stagingold${RUN_TOKEN}`);
      const oldRevision = 'd'.repeat(40);
      const oldGenerationId = await publishFixture(provider.config, oldFixture, oldRevision);
      const oldPointer = await pointerGenerationId();
      const oldResults = await searchSnapshot(provider.config, oldFixture.marker);
      expect(oldPointer).toBe(oldGenerationId);

      const newerFixture = makeFixture('staging-new', `stagingnew${RUN_TOKEN}`);
      const newerRevision = 'e'.repeat(40);
      const newerGeneration = await createGeneration(provider.config, newerFixture, {
        revision: newerRevision,
        validProvenance: true,
      });
      const staged = await processFixture(
        provider.config,
        newerGeneration.id,
        newerFixture,
        newerRevision
      );
      expect(staged).toMatchObject({ success: true });

      expect(await pointerGenerationId()).toBe(oldPointer);
      expect(await searchSnapshot(provider.config, oldFixture.marker)).toEqual(oldResults);
      expect(await searchSnapshot(provider.config, newerFixture.marker)).toEqual([]);

      await finalizeDocsRagSourceGeneration(provider.config, {
        generationId: newerGeneration.id,
        scanState: 'complete',
      });
      await publishDocsRagSourceGeneration(provider.config, {
        generationId: newerGeneration.id,
      });
      expect(await pointerGenerationId()).toBe(newerGeneration.id);
      expect(await searchSnapshot(provider.config, newerFixture.marker)).toHaveLength(1);
      expect(await searchSnapshot(provider.config, oldFixture.marker)).toEqual([]);
    } finally {
      provider.server.stop(true);
    }
  }, 120_000);
});
