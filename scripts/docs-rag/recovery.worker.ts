/**
 * Test-only worker for the T-04 W3 cross-process recovery trial.
 *
 * The parent test supplies every path and endpoint explicitly. Each phase is
 * launched in a fresh Bun process so module state cannot mask restart bugs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  canonicalizeMigrationTarget,
  OFFICIAL_DATABASE_NAMES,
  OFFICIAL_DATABASE_PORTS,
} from '../db-migrations/runner.js';
import { acquireProjectRagWriteFence } from '../db-migrations/write-fence.js';
import { processFile, resolveExternalDocsProcessingProfile } from '../sync-external-docs.js';
import { type DocsRagLabConfig, redactPostgresUrl } from './config.js';
import { buildDocsRagSourceGenerationKey, createDocsRagSourceGeneration } from './store.js';

const SOURCE_ID = 'bun-docs';
const EMBEDDING_MODEL = 't04-w3-fake-embedder-1024';
const DIMENSIONS = 1024;
const RESULT_PREFIX = 'T04W3_WORKER_RESULT ';
const ERROR_PREFIX = 'T04W3_WORKER_ERROR ';
const T04_DATABASE_NAME_PATTERN = /^rag_v2_t04(?:_[a-z0-9][a-z0-9_-]*)?$/;
const COMMON_DATABASE_NAMES = new Set([
  'postgres',
  'template0',
  'template1',
  'rag_v2',
  ...OFFICIAL_DATABASE_NAMES,
]);

interface WorkerInput {
  readonly databaseUrl: string;
  readonly providerUrl: string;
  readonly rootDir: string;
  readonly rawPath: string;
  readonly processedPath: string;
  readonly sourcePath: string;
  readonly revision: string;
}

interface WorkerReport {
  readonly phase: 'prepare' | 'recover';
  readonly generationId: number;
  readonly generationKey: string;
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  readonly canonicalExists: boolean;
  readonly tempStageCount: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function assertDisposableTarget(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('worker requires a valid disposable T-04 W3 Postgres URL');
  }
  if (parsed.protocol !== 'postgres:') {
    throw new Error('worker requires the postgres protocol');
  }
  if (parsed.username !== 'postgres' || parsed.password) {
    throw new Error('worker requires the postgres user without a password');
  }
  if (!parsed.port || !/^\d+$/.test(parsed.port)) {
    throw new Error('worker requires an explicit numeric listener port');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('worker URLs may not contain query or fragment overrides');
  }

  let identity: ReturnType<typeof canonicalizeMigrationTarget>;
  try {
    identity = canonicalizeMigrationTarget(rawUrl);
  } catch {
    throw new Error('worker requires a valid disposable T-04 W3 Postgres URL');
  }
  if (identity.host !== '127.0.0.1' && identity.host !== '::1') {
    throw new Error('worker requires a loopback host');
  }
  if (OFFICIAL_DATABASE_PORTS.includes(identity.port)) {
    throw new Error('worker requires a non-ops listener port');
  }
  const databaseName = identity.database.toLowerCase();
  if (
    COMMON_DATABASE_NAMES.has(databaseName) ||
    !T04_DATABASE_NAME_PATTERN.test(identity.database)
  ) {
    throw new Error('worker requires a rag_v2_t04-prefixed database');
  }
}

function readInput(): WorkerInput {
  const databaseUrl = requiredEnv('T04_W3_DATABASE_URL');
  assertDisposableTarget(databaseUrl);
  return {
    databaseUrl,
    providerUrl: requiredEnv('T04_W3_PROVIDER_URL'),
    rootDir: requiredEnv('T04_W3_ROOT_DIR'),
    rawPath: requiredEnv('T04_W3_RAW_PATH'),
    processedPath: requiredEnv('T04_W3_PROCESSED_PATH'),
    sourcePath: requiredEnv('T04_W3_SOURCE_PATH'),
    revision: requiredEnv('T04_W3_SOURCE_REVISION'),
  };
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildConfig(input: WorkerInput): DocsRagLabConfig {
  return {
    tool: 'docs-rag-pg-lab',
    rootDir: input.rootDir,
    defaultEvalFixturePath: join(input.rootDir, 'eval-fixture.json'),
    evalTopK: 10,
    healthTimeoutMs: 5_000,
    embedding: {
      provider: 'llamacpp',
      model: EMBEDDING_MODEL,
      baseUrl: input.providerUrl,
      dimensions: DIMENSIONS,
      timeoutMs: 2_000,
      batchSize: 8,
      maxConcurrentBatches: 1,
    },
    database: {
      url: input.databaseUrl,
      redactedUrl: redactPostgresUrl(input.databaseUrl),
      source: 'test',
    },
    pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
    gates: { liveSearchEnabled: true, embeddingEnabled: true, mutationEnabled: true },
  };
}

async function ensureGeneration(config: DocsRagLabConfig, input: WorkerInput) {
  const rawBytes = readFileSync(input.rawPath);
  const { profile, profileHash } = resolveExternalDocsProcessingProfile(
    config,
    { skipLlm: true },
    input.revision
  );
  const rawManifestSha256 = sha256Hex(rawBytes);
  const generationKey = buildDocsRagSourceGenerationKey({
    sourceId: SOURCE_ID,
    upstreamRevision: input.revision,
    rawManifestSha256,
    processingProfileHash: profileHash,
  });
  return await createDocsRagSourceGeneration(config, {
    sourceId: SOURCE_ID,
    provenanceClass: 'revision_bound_external',
    generationKey,
    upstreamRevision: input.revision,
    upstreamPath: input.sourcePath,
    license: 'MIT',
    rawManifestSha256,
    processingProfileHash: profileHash,
    processingProfile: profile,
    expectedDocumentCount: 1,
    scanState: 'pending',
  });
}

async function countsForGeneration(
  config: DocsRagLabConfig,
  generationId: number
): Promise<Pick<WorkerReport, 'documents' | 'chunks' | 'embeddings'>> {
  const sql = new Bun.SQL({
    url: config.database.url,
    max: 1,
    connectionTimeout: 10,
    prepare: false,
  });
  try {
    const rows = await sql.begin(async (tx) => {
      await acquireProjectRagWriteFence(tx);
      return (await tx.unsafe(
        `select
           (select count(*) from docs_documents where generation_id = $1)::text as documents,
           (select count(*) from docs_chunks c join docs_documents d on d.id = c.document_id where d.generation_id = $1)::text as chunks,
           (select count(*) from docs_embeddings e join docs_chunks c on c.id = e.chunk_id join docs_documents d on d.id = c.document_id where d.generation_id = $1)::text as embeddings`,
        [generationId]
      )) as Array<{
        readonly documents: string;
        readonly chunks: string;
        readonly embeddings: string;
      }>;
    });
    const row = rows[0];
    if (!row) throw new Error(`no counts for generation ${generationId}`);
    return {
      documents: Number(row.documents),
      chunks: Number(row.chunks),
      embeddings: Number(row.embeddings),
    };
  } finally {
    await sql.close({ timeout: 5 });
  }
}

function tempStageCount(processedPath: string): number {
  const directory = dirname(processedPath);
  if (!existsSync(directory)) return 0;
  const stagePrefix = `${basename(processedPath)}.tmp-`;
  return readdirSync(directory).filter((name) => name.startsWith(stagePrefix)).length;
}

async function runPhase(phase: WorkerReport['phase'], input: WorkerInput): Promise<WorkerReport> {
  const config = buildConfig(input);
  const generation = await ensureGeneration(config, input);
  const mode = {
    dryRun: false,
    skipLlm: true,
    generationId: generation.id,
    sourceUrl: 'https://github.com/example/docs',
    sourceRevision: input.revision,
    upstreamPath: input.sourcePath,
    syncedAt: '2026-08-30T00:00:00.000Z',
  };
  const result = await processFile(
    input.rawPath,
    input.processedPath,
    input.sourcePath,
    'bun',
    config,
    mode,
    phase === 'prepare' ? { renameStage: () => {} } : undefined
  );
  if (!result.success) {
    throw new Error(result.error ?? `processFile failed for ${input.sourcePath}`);
  }
  return {
    phase,
    generationId: generation.id,
    generationKey: generation.generationKey,
    ...(await countsForGeneration(config, generation.id)),
    canonicalExists: existsSync(input.processedPath),
    tempStageCount: tempStageCount(input.processedPath),
  };
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  if (phase !== 'prepare' && phase !== 'recover') {
    throw new Error(`unknown phase ${String(phase)}`);
  }

  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const report = await runPhase(phase, readInput());
    console.log = originalLog;
    console.error = originalError;
    originalLog(`${RESULT_PREFIX}${JSON.stringify(report)}`);
  } catch (error) {
    console.log = originalLog;
    console.error = originalError;
    originalError(
      `${ERROR_PREFIX}${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}`
    );
    process.exitCode = 1;
  }
}

void main();
