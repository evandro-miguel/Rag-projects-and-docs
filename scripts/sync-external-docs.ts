/**
 * @module sync-external-docs
 * @description LLM-refined external documentation ingestion pipeline.
 *
 * This script implements an ingestion pipeline for external documentation
 * that uses deterministic post-processing (or optional llama.cpp) to refine
 * and clean documents before ingestion.
 * It clones Git repositories, processes markdown files through refinement,
 * and ingests the cleaned content into Docs RAG Postgres.
 *
 * **Purpose:**
 * - Ingest external documentation with LLM-powered cleaning
 * - Remove boilerplate, navigation, and marketing content
 * - Extract high-density technical knowledge for RAG
 * - Maintain local cache of processed documents
 *
 * **When to run:**
 * - Initial setup of external documentation sources
 * - Periodic refresh of external docs with LLM refinement
 * - When source documentation has significant updates
 *
 * **Dependencies:**
 * - Docs RAG Postgres database running
 * - Git installed and available in PATH
 * - sources.json configuration file
 * - (Optional) LLAMA_CPP_API_KEY for llama.cpp-based LLM refinement
 *
 * **Environment Variables:**
 * - `DOCS_RAG_PG_LAB_DATABASE_URL` - Docs RAG Postgres connection URL
 * - `DOCS_RAG_PG_LAB_ENABLE_MUTATIONS` - Must be true for non-dry-run writes
 * - `LLM_REFINER_PROVIDER` - Refinement provider: `none` (default, deterministic) or `llamacpp` (LLM)
 * - `LLAMA_CPP_API_KEY` - API key for llama.cpp refinement endpoint
 * - `CHUNK_SIZE` - Target chunk size in characters (default: 1000)
 * - `CHUNK_OVERLAP` - Chunk overlap in characters (default: 50)
 * - `EMBEDDING_MODEL` - Embedding model name (default: qwen3-embedding)
 * - `SYNC_EXTERNAL_EMBEDDING_BATCH_SIZE` - Embedding batch size (default: 2)
 * - `SYNC_EXTERNAL_EMBEDDING_MAX_CONCURRENT_BATCHES` - Embedding batch concurrency (default: 1)
 * - `SYNC_EXTERNAL_FILE_CONCURRENCY` - Per-source file processing concurrency (default: 1)
 * - `SYNC_EXTERNAL_MAX_SOURCE_BYTES` - Per-source raw docs byte budget (default: 32 MiB)
 * - `SYNC_EXTERNAL_MAX_ESTIMATED_CHUNKS` - Per-source estimated chunk budget (default: 30000)
 * - `SYNC_EXTERNAL_MAX_RUN_BYTES` - Multi-source raw docs byte budget (default: 32 MiB)
 * - `SYNC_EXTERNAL_MAX_RUN_ESTIMATED_CHUNKS` - Multi-source estimated chunk budget (default: 30000)
 * - `SYNC_EXTERNAL_REPORT_DIR` - Output directory for sync reports
 * - `SYNC_EXTERNAL_MAX_FAILED_DOCS` - Max failed docs before non-zero exit (default: 0)
 * - `SYNC_EXTERNAL_MAX_FAILURE_RATE` - Max failure rate before non-zero exit (default: 0.05)
 *
 * **Directory Structure:**
 * ```
 * ingest/
 * ├── source/external/     # Cloned Git repositories
 * │   └── {source-name}/
 * └── processed/external/  # LLM-refined documents
 *     └── {source-name}/
 * ```
 *
 * **Workflow:**
 * For each source in sources.json:
 * 1. Clone or update Git repository
 * 2. Scan for configured text documentation files in docsPath
 * 3. For each file:
 *    - Compute raw content hash (for change detection)
 *    - Skip if raw content unchanged
 *    - Refine with LLM or deterministic post-processing
 *    - Save processed version locally
 *    - Chunk refined content
 *    - Generate embeddings
 *    - Save to Docs RAG Postgres
 *
 * @example
 * // Run LLM-refined external docs sync
 * bun run sync:external
 *
 * @example
 * // Dry-run without mutating Postgres or local processed files
 * bun run sync:external -- --dry-run
 *
 * @see package.json#scripts.sync - Active external docs sync alias
 * @see ingest-all.ts - Deprecated fail-fast stub for the retired Convex full-ingest path
 * @see llm-refiner.ts - LLM refinement logic used by this script
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { glob } from 'glob';
import pLimit from 'p-limit';
import { chunkDocsRagTextWithContext, resolveDocsRagChunkConfig } from './docs-rag/chunker.js';
import { type DocsRagLabConfig, resolveDocsRagLabConfig } from './docs-rag/config.js';
import { DOCS_RAG_PROCESSING_PROFILE_PIPELINE_REVISION } from './docs-rag/processing-profile.js';
import {
  buildDocsRagSourceGenerationKey,
  createDocsRagSourceGeneration,
  type DocsRagLabDocumentInput,
  deleteStaleDocsRagLabDocuments,
  finalizeDocsRagSourceGeneration,
  gcDocsRagSourceGenerations,
  inspectDocsRagLabDocumentProcessing,
  publishDocsRagSourceGeneration,
  resolveDocsRagCanonicalProcessingProfile,
  upsertDocsRagLabDocument,
} from './docs-rag/store.js';
import {
  canonicalizeDocsSourceId,
  type NormalizedDocsSourceMetadata,
  normalizeDocsSourceMetadata,
} from './lib/docs-source-registry.js';
import {
  classifyExternalDocEntries,
  filterExternalDocEntries,
  removeGeneratedExternalDocArtifacts,
} from './lib/external-doc-inventory.js';
import {
  assessExternalDocContent,
  normalizeExternalDocControlCharacters,
} from './lib/external-doc-quality.js';
import { extractTitle, shouldIgnoreExternalDocPath } from './lib/file-helpers.js';
import {
  getRefinerRuntimeConfig,
  postProcessRefinedContent,
  refineDocument,
} from './lib/llm-refiner.js';

/**
 * Simple token count estimation (~4 chars per token).
 * This is a rough approximation; actual tokenization varies by model.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Pure SHA-256 of a UTF-8 string; never seeded with configuration. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const INGEST_DIR = join(process.cwd(), 'ingest');
const SOURCE_DIR = join(INGEST_DIR, 'source', 'external');
const PROCESSED_DIR = join(INGEST_DIR, 'processed', 'external');
const SOURCES_FILE = join(process.cwd(), 'scripts', 'sources.json');

function resolveExternalDocsSourceMetadata(
  sourcePath: string,
  category: string
): NormalizedDocsSourceMetadata {
  const metadata = normalizeDocsSourceMetadata({ sourcePath, category });
  if (!metadata.sourceId) {
    throw new Error(`Unknown external Docs RAG source prefix: ${sourcePath}`);
  }
  return metadata;
}

function buildDocsRagMetadata(metadata: NormalizedDocsSourceMetadata): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    sourceId: metadata.sourceId,
    category: metadata.category,
    language: metadata.language,
    kind: metadata.kind,
    authority: metadata.authority,
  })) {
    if (value) {
      payload[key] = value;
    }
  }
  if (metadata.tags.length > 0) {
    payload.tags = [...metadata.tags];
  }
  return payload;
}

export interface ExternalDocsProvenance {
  readonly canonicalUrl: string;
  readonly sourceRevision: string;
  readonly syncedAt: string;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

/**
 * Build the revision-bound citation for one upstream file. This is kept
 * independent of Postgres so callers can reject bad provenance before a
 * staging generation is created.
 */
export function buildExternalDocsProvenance(input: {
  readonly sourceUrl: string;
  readonly sourceRevision: string | null | undefined;
  readonly upstreamPath: string | null | undefined;
  readonly syncedAt: string | null | undefined;
}): ExternalDocsProvenance {
  let repository: URL;
  try {
    repository = new URL(input.sourceUrl);
  } catch {
    throw new Error('Invalid Docs RAG provenance: expected an HTTPS GitHub repository URL.');
  }
  if (
    repository.protocol !== 'https:' ||
    repository.hostname.toLowerCase() !== 'github.com' ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash
  ) {
    throw new Error('Invalid Docs RAG provenance: expected an HTTPS GitHub repository URL.');
  }
  const repositoryParts = repository.pathname.replace(/\/+$/u, '').split('/').filter(Boolean);
  const repositoryName = repositoryParts.at(-1)?.replace(/\.git$/u, '');
  if (
    repositoryParts.length !== 2 ||
    !repositoryParts[0] ||
    !repositoryName ||
    !/^[A-Za-z0-9._-]+$/u.test(repositoryParts[0]) ||
    !/^[A-Za-z0-9._-]+$/u.test(repositoryName)
  ) {
    throw new Error('Invalid Docs RAG provenance: expected an HTTPS GitHub repository URL.');
  }

  const sourceRevision = input.sourceRevision?.trim() ?? '';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(sourceRevision)) {
    throw new Error(
      'Invalid Docs RAG provenance: source revision must be 40 or 64 hexadecimal characters.'
    );
  }

  const upstreamPath = input.upstreamPath ?? '';
  const pathParts = upstreamPath.split('/');
  if (
    !upstreamPath ||
    upstreamPath.startsWith('/') ||
    upstreamPath.includes('\\') ||
    pathParts.some(
      (part) => !part || part === '.' || part === '..' || containsControlCharacter(part)
    )
  ) {
    throw new Error('Invalid Docs RAG provenance: upstream path must be a safe POSIX path.');
  }

  const syncedAt = input.syncedAt?.trim() ?? '';
  if (!syncedAt || !Number.isFinite(Date.parse(syncedAt))) {
    throw new Error('Invalid Docs RAG provenance: syncedAt must be a valid timestamp.');
  }

  const encodedPath = pathParts.map((part) => encodeURIComponent(part)).join('/');
  return {
    canonicalUrl: `https://github.com/${repositoryParts[0]}/${repositoryName}/blob/${sourceRevision}/${encodedPath}`,
    sourceRevision,
    syncedAt,
  };
}

function resolveExternalDocsUpstreamPath(source: Source, relativePath: string): string {
  const docsPath = source.docsPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!docsPath) return relativePath;
  return extname(docsPath) && relativePath === basename(docsPath)
    ? docsPath
    : `${docsPath}/${relativePath}`;
}

function buildDocsRagDocumentIdentity(
  processedFilePath: string,
  metadata: NormalizedDocsSourceMetadata,
  rootDir: string
): Pick<DocsRagLabDocumentInput, 'sourceId' | 'sourcePath' | 'legacyKeys'> {
  const displaySourcePath = relative(rootDir, processedFilePath).split('\\').join('/');
  const parts = displaySourcePath.split('/');
  const externalIndex = parts.indexOf('external');
  const sourceIndex = externalIndex >= 0 && parts[externalIndex + 1] ? externalIndex + 1 : 0;
  const rawSourceId = parts[sourceIndex] ?? metadata.sourceId ?? 'unknown';
  const sourceId = metadata.sourceId ?? rawSourceId;
  const canonicalParts = [...parts];
  canonicalParts[sourceIndex] = sourceId;
  const sourcePath = canonicalParts.join('/');
  const legacyKeys =
    rawSourceId === sourceId && displaySourcePath === sourcePath
      ? []
      : [{ sourceId: rawSourceId, sourcePath: displaySourcePath }];
  return { sourceId, sourcePath, legacyKeys };
}

export function buildDocsRagCleanupInput(
  sourceName: string,
  category: string,
  relativePaths: readonly string[],
  rootDir: string,
  allowDeleteAll = false
): { sourceId: string; currentSourcePaths: string[]; allowDeleteAll: boolean } {
  const currentSourcePaths = new Set<string>();
  const sourceMetadata = resolveExternalDocsSourceMetadata(`${sourceName}/`, category);
  let sourceId = sourceMetadata.sourceId ?? canonicalizeDocsSourceId(sourceName);
  for (const relativePath of relativePaths) {
    const sourcePath = join(sourceName, relativePath);
    const metadata = resolveExternalDocsSourceMetadata(sourcePath, category);
    const identity = buildDocsRagDocumentIdentity(
      join(PROCESSED_DIR, sourcePath),
      metadata,
      rootDir
    );
    sourceId = identity.sourceId;
    currentSourcePaths.add(identity.sourcePath);
  }
  return {
    sourceId,
    currentSourcePaths: [...currentSourcePaths].sort(),
    allowDeleteAll,
  };
}

export function shouldRunDocsRagCleanup(input: {
  readonly currentSourcePaths: readonly string[];
  readonly allowDeleteAll: boolean;
}): boolean {
  return input.currentSourcePaths.length > 0 || input.allowDeleteAll;
}

export function shouldAllowDeleteAllForExcludedSource(input: {
  readonly pathFilteredFiles: number;
  readonly eligibleFiles: number;
  readonly contentExcludedFiles: number;
}): boolean {
  return (
    input.pathFilteredFiles > 0 &&
    input.eligibleFiles === 0 &&
    input.contentExcludedFiles === input.pathFilteredFiles
  );
}

export interface SyncModeOptions {
  dryRun: boolean;
  skipLlm: boolean;
  force?: boolean;
  /** Internal source-generation binding; required for non-dry-run writes. */
  generationId?: number;
  /** Upstream revision captured by the sync clone step. */
  sourceRevision?: string | null;
  /** Validated upstream repository URL used to build revision-bound citations. */
  sourceUrl?: string | null;
  /** Safe upstream path relative to the repository root. */
  upstreamPath?: string | null;
  /** Timestamp shared by documents processed in one sync run. */
  syncedAt?: string | null;
}

export interface SyncRuntimeOptions extends SyncModeOptions {
  sourceName: string | null;
  /** Optional source root override for isolated callers and fixtures. */
  sourceRootDir?: string;
  reportDir: string;
  maxFailedDocs: number;
  maxFailureRate: number;
  maxSourceBytes: number;
  maxEstimatedChunks: number;
  maxRunBytes: number;
  maxRunEstimatedChunks: number;
  fileConcurrency: number;
}

export interface SourceSummary {
  source: string;
  totalFiles: number;
  ignoredFiles: number;
  contentExcludedFiles: number;
  attemptedFiles: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  failures: Array<{ file: string; error: string }>;
  exclusions: Array<{ file: string; reasons: string[] }>;
  durationMs: number;
  removedProcessedArtifacts: number;
  deletedDocs: number;
  deletedChunks: number;
}

export interface SyncRunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  skipLlm: boolean;
  thresholds: {
    maxFailedDocs: number;
    maxFailureRate: number;
  };
  totals: {
    sources: number;
    totalFiles: number;
    ignoredFiles: number;
    contentExcludedFiles: number;
    attemptedFiles: number;
    processedFiles: number;
    skippedFiles: number;
    failedFiles: number;
    failureRate: number;
    removedProcessedArtifacts: number;
    deletedDocs: number;
    deletedChunks: number;
  };
  alerts: string[];
  status: 'ok' | 'alert';
  sources: SourceSummary[];
}

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseFloatOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const DEFAULT_SYNC_EXTERNAL_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const DEFAULT_SYNC_EXTERNAL_MAX_ESTIMATED_CHUNKS = 30_000;
const DEFAULT_SYNC_EXTERNAL_MAX_RUN_BYTES = DEFAULT_SYNC_EXTERNAL_MAX_SOURCE_BYTES;
const DEFAULT_SYNC_EXTERNAL_MAX_RUN_ESTIMATED_CHUNKS = DEFAULT_SYNC_EXTERNAL_MAX_ESTIMATED_CHUNKS;
const DEFAULT_SYNC_EXTERNAL_FILE_CONCURRENCY = 1;

export function resolveExternalDocsChunkConfig(env: NodeJS.ProcessEnv = process.env): {
  chunkSize: number;
  chunkOverlap: number;
} {
  return resolveDocsRagChunkConfig(env);
}

export function resolveExternalDocsEmbeddingOptions(env: NodeJS.ProcessEnv = process.env): {
  batchSize: number;
  maxConcurrentBatches: number;
} {
  return {
    batchSize: Math.max(1, parseIntOrDefault(env.SYNC_EXTERNAL_EMBEDDING_BATCH_SIZE, 2)),
    maxConcurrentBatches: Math.max(
      1,
      parseIntOrDefault(env.SYNC_EXTERNAL_EMBEDDING_MAX_CONCURRENT_BATCHES, 1)
    ),
  };
}

/**
 * Resolve the Docs RAG Postgres environment for a sync run.
 *
 * Non-dry-run sync writes into the Postgres corpus, so it must default the
 * embedding gate ON exactly like `resolveDocsRagLabConfigWithLocalDefault`
 * does; a mutation run with embeddings silently disabled produces chunks that
 * fail the docsCorpus health invariant (missingEmbeddingChunkCount > 0).
 * An explicitly disabled gate is rejected for mutation runs. Dry runs pass the
 * environment through untouched.
 */
export function resolveSyncDocsRagLabEnv(
  env: NodeJS.ProcessEnv,
  dryRun: boolean
): NodeJS.ProcessEnv {
  if (dryRun) {
    return env;
  }
  const resolvedEnv = {
    ...env,
    DOCS_RAG_PG_LAB_ENABLE_EMBEDDING: env.DOCS_RAG_PG_LAB_ENABLE_EMBEDDING ?? 'true',
  };
  if (!resolveDocsRagLabConfig(resolvedEnv).gates.embeddingEnabled) {
    throw new Error(
      'DOCS_RAG_PG_LAB_ENABLE_EMBEDDING=true is required for non-dry-run external sync to avoid publishing chunks without embeddings.'
    );
  }
  return resolvedEnv;
}

export function estimateExternalDocsBudget(
  files: Array<{ rawFile: string }>,
  chunkSize: number,
  chunkOverlap = 0
): { totalBytes: number; estimatedChunks: number } {
  const safeChunkSize = Math.max(1, chunkSize - Math.max(0, chunkOverlap));
  return files.reduce(
    (acc, file) => {
      const size = statSync(file.rawFile).size;
      acc.totalBytes += size;
      acc.estimatedChunks += Math.max(1, Math.ceil(size / safeChunkSize));
      return acc;
    },
    { totalBytes: 0, estimatedChunks: 0 }
  );
}

export function accumulateExternalDocsBudget(
  current: { totalBytes: number; estimatedChunks: number },
  next: { totalBytes: number; estimatedChunks: number }
): { totalBytes: number; estimatedChunks: number } {
  return {
    totalBytes: current.totalBytes + next.totalBytes,
    estimatedChunks: current.estimatedChunks + next.estimatedChunks,
  };
}

export function assertExternalDocsBudget(
  sourceName: string,
  budget: { totalBytes: number; estimatedChunks: number },
  limits: { maxSourceBytes: number; maxEstimatedChunks: number }
): void {
  const violations = [];
  if (budget.totalBytes > limits.maxSourceBytes) {
    violations.push(
      `source bytes ${budget.totalBytes} exceeds maxSourceBytes ${limits.maxSourceBytes}`
    );
  }
  if (budget.estimatedChunks > limits.maxEstimatedChunks) {
    violations.push(
      `estimated chunks ${budget.estimatedChunks} exceeds maxEstimatedChunks ${limits.maxEstimatedChunks}`
    );
  }
  if (violations.length > 0) {
    throw new Error(
      `[${sourceName}] External docs sync budget exceeded before mutations: ${violations.join('; ')}`
    );
  }
}

export function assertExternalDocsRunBudget(
  sourceName: string,
  budget: { totalBytes: number; estimatedChunks: number },
  limits: { maxRunBytes: number; maxRunEstimatedChunks: number }
): void {
  const violations = [];
  if (budget.totalBytes > limits.maxRunBytes) {
    violations.push(`run bytes ${budget.totalBytes} exceeds maxRunBytes ${limits.maxRunBytes}`);
  }
  if (budget.estimatedChunks > limits.maxRunEstimatedChunks) {
    violations.push(
      `run estimated chunks ${budget.estimatedChunks} exceeds maxRunEstimatedChunks ${limits.maxRunEstimatedChunks}`
    );
  }
  if (violations.length > 0) {
    throw new Error(
      `[${sourceName}] External docs sync run budget exceeded before source mutations: ${violations.join('; ')}`
    );
  }
}

function parseStringFlag(argv: string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === flag) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        return undefined;
      }
      return next;
    }
    if (arg.startsWith(`${flag}=`)) {
      const [, value] = arg.split('=', 2);
      return value || undefined;
    }
  }
  return undefined;
}

export interface GarbageCollectionDecisionInput {
  dryRun: boolean;
  skipLlm: boolean;
  skipped: number;
  failed: number;
}

export function shouldRunGarbageCollection(input: GarbageCollectionDecisionInput): boolean {
  return !input.dryRun && input.failed === 0;
}

export function parseSyncRuntimeOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): SyncRuntimeOptions {
  const argSet = new Set(argv);
  const dryRun = argSet.has('--dry-run');
  const sourceName = parseStringFlag(argv, '--source')?.trim() || null;
  const sourceFlagPresent = argv.some((arg) => arg === '--source' || arg.startsWith('--source='));
  const force = argSet.has('--force');

  if (sourceFlagPresent && !sourceName) {
    throw new Error('Flag --source requires a non-empty value (e.g. --source bun-docs).');
  }

  if (force && !sourceName) {
    throw new Error(
      'Flag --force requires --source <name> to avoid broad accidental reprocessing.'
    );
  }

  return {
    dryRun,
    skipLlm: dryRun || argSet.has('--skip-llm'),
    force,
    sourceName,
    reportDir:
      env.SYNC_EXTERNAL_REPORT_DIR || join(process.cwd(), '.data', 'reports', 'sync-external-docs'),
    maxFailedDocs: parseIntOrDefault(env.SYNC_EXTERNAL_MAX_FAILED_DOCS, 0),
    maxFailureRate: parseFloatOrDefault(env.SYNC_EXTERNAL_MAX_FAILURE_RATE, 0.05),
    maxSourceBytes: parseIntOrDefault(
      env.SYNC_EXTERNAL_MAX_SOURCE_BYTES,
      DEFAULT_SYNC_EXTERNAL_MAX_SOURCE_BYTES
    ),
    maxEstimatedChunks: parseIntOrDefault(
      env.SYNC_EXTERNAL_MAX_ESTIMATED_CHUNKS,
      DEFAULT_SYNC_EXTERNAL_MAX_ESTIMATED_CHUNKS
    ),
    maxRunBytes: parseIntOrDefault(
      env.SYNC_EXTERNAL_MAX_RUN_BYTES,
      DEFAULT_SYNC_EXTERNAL_MAX_RUN_BYTES
    ),
    maxRunEstimatedChunks: parseIntOrDefault(
      env.SYNC_EXTERNAL_MAX_RUN_ESTIMATED_CHUNKS,
      DEFAULT_SYNC_EXTERNAL_MAX_RUN_ESTIMATED_CHUNKS
    ),
    fileConcurrency: Math.max(
      1,
      parseIntOrDefault(env.SYNC_EXTERNAL_FILE_CONCURRENCY, DEFAULT_SYNC_EXTERNAL_FILE_CONCURRENCY)
    ),
  };
}

export function evaluateSyncThresholds(report: SyncRunReport): string[] {
  const alerts: string[] = [];

  const emptySources = report.sources
    .filter(
      (source) =>
        source.totalFiles === 0 &&
        source.attemptedFiles === 0 &&
        source.processedFiles === 0 &&
        source.skippedFiles === 0 &&
        source.failedFiles === 0
    )
    .map((source) => source.source);
  if (emptySources.length > 0) {
    alerts.push(`sources with no discovered docs: ${emptySources.join(', ')}`);
  }

  const noEligibleSources = report.sources
    .filter(
      (source) =>
        source.totalFiles > 0 &&
        source.attemptedFiles === 0 &&
        source.processedFiles === 0 &&
        source.skippedFiles === 0
    )
    .map((source) => source.source);
  if (noEligibleSources.length > 0) {
    alerts.push(`sources with no eligible retrievable docs: ${noEligibleSources.join(', ')}`);
  }

  if (report.totals.failedFiles > report.thresholds.maxFailedDocs) {
    alerts.push(
      `failedFiles ${report.totals.failedFiles} exceeds maxFailedDocs ${report.thresholds.maxFailedDocs}`
    );
  }

  if (report.totals.failureRate > report.thresholds.maxFailureRate) {
    alerts.push(
      `failureRate ${(report.totals.failureRate * 100).toFixed(2)}% exceeds maxFailureRate ${(report.thresholds.maxFailureRate * 100).toFixed(2)}%`
    );
  }

  return alerts;
}

export function buildSyncRunReport(input: {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  skipLlm: boolean;
  maxFailedDocs: number;
  maxFailureRate: number;
  sources: readonly SourceSummary[];
}): SyncRunReport {
  const totals = input.sources.reduce(
    (acc, source) => {
      acc.totalFiles += source.totalFiles;
      acc.ignoredFiles += source.ignoredFiles;
      acc.contentExcludedFiles += source.contentExcludedFiles;
      acc.attemptedFiles += source.attemptedFiles;
      acc.processedFiles += source.processedFiles;
      acc.skippedFiles += source.skippedFiles;
      acc.failedFiles += source.failedFiles;
      acc.removedProcessedArtifacts += source.removedProcessedArtifacts;
      acc.deletedDocs += source.deletedDocs;
      acc.deletedChunks += source.deletedChunks;
      return acc;
    },
    {
      totalFiles: 0,
      ignoredFiles: 0,
      contentExcludedFiles: 0,
      attemptedFiles: 0,
      processedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      removedProcessedArtifacts: 0,
      deletedDocs: 0,
      deletedChunks: 0,
    }
  );
  const report: SyncRunReport = {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    dryRun: input.dryRun,
    skipLlm: input.skipLlm,
    thresholds: {
      maxFailedDocs: input.maxFailedDocs,
      maxFailureRate: input.maxFailureRate,
    },
    totals: {
      sources: input.sources.length,
      ...totals,
      failureRate: totals.attemptedFiles > 0 ? totals.failedFiles / totals.attemptedFiles : 0,
    },
    alerts: [],
    status: 'ok',
    sources: [...input.sources],
  };

  report.alerts = evaluateSyncThresholds(report);
  report.status = report.alerts.length > 0 ? 'alert' : 'ok';
  return report;
}

export function saveSyncRunReport(
  report: SyncRunReport,
  reportDir: string
): { latestPath: string | null; timestampedPath: string } {
  mkdirSync(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const timestampedPath = join(reportDir, `sync-report-${timestamp}.json`);
  const latestPath = join(reportDir, 'latest.json');

  writeFileSync(timestampedPath, JSON.stringify(report, null, 2), 'utf-8');
  if (!report.dryRun) {
    writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf-8');
  }

  return { latestPath: report.dryRun ? null : latestPath, timestampedPath };
}

/**
 * Configuration for an external documentation source.
 */
export interface Source {
  /** Source identifier */
  name: string;
  /** Git repository URL */
  url: string;
  /** Git branch to sync */
  branch: string;
  /** Path within repository containing documentation */
  docsPath: string;
  /** Category name for organization in Docs RAG */
  category: string;
  /** SPDX or source-declared license when the catalog provides one. */
  license?: string;
  /** File extensions to scan within docsPath */
  fileExtensions: string[];
  /** Optional relative prefixes to ignore for this source */
  ignorePaths?: string[];
}

const DEFAULT_SOURCE_FILE_EXTENSIONS = ['md', 'mdx'] as const;

export function normalizeSourceFileExtensions(value: unknown): string[] {
  const rawExtensions = Array.isArray(value) ? value : DEFAULT_SOURCE_FILE_EXTENSIONS;
  const extensions = rawExtensions
    .map((extension) => String(extension).trim().toLowerCase().replace(/^\./u, ''))
    .filter((extension) => /^[a-z0-9]+$/u.test(extension));

  return extensions.length > 0
    ? Array.from(new Set(extensions))
    : [...DEFAULT_SOURCE_FILE_EXTENSIONS];
}

export function buildSourceGlob(fileExtensions: readonly string[]): string {
  if (fileExtensions.length === 1) {
    return `**/*.${fileExtensions[0]}`;
  }
  return `**/*.{${fileExtensions.join(',')}}`;
}

/**
 * Hash the complete discovered source inventory without embedding config in
 * the content identity. Paths and raw bytes are sorted/canonicalized so the
 * digest is stable across filesystem traversal order and can bind retries to
 * one upstream snapshot even when a sparse clone has no `.git` directory.
 */
export function buildDocsRagSourceManifestHash(
  entries: readonly { readonly rawFile: string; readonly relativePath: string }[]
): string {
  const digest = createHash('sha256');
  for (const entry of [...entries].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )) {
    digest.update(entry.relativePath.replace(/\\/g, '/'), 'utf8');
    digest.update('\0', 'utf8');
    digest.update(readFileSync(entry.rawFile));
    digest.update('\0', 'utf8');
  }
  return digest.digest('hex');
}

/**
 * Load and parse sources.json configuration.
 *
 * @returns Array of source configurations
 *
 * @throws {Error} If sources.json file is not found
 *
 * @example
 * // Get configured sources
 * const sources = getSources();
 * for (const source of sources) {
 *   console.log(`Processing: ${source.name}`);
 * }
 */
function getSources(): Source[] {
  if (!existsSync(SOURCES_FILE)) {
    throw new Error(`Sources file not found at ${SOURCES_FILE}`);
  }
  const raw = JSON.parse(readFileSync(SOURCES_FILE, 'utf-8'));
  const sources = raw.sources || raw;
  return sources.map((s: Record<string, any>) => ({
    name: s.id || s.name,
    url: s.url,
    branch: s.branch || 'main',
    docsPath: s.docsPath || s.path || '',
    category: s.category,
    license: typeof s.license === 'string' ? s.license : undefined,
    fileExtensions: normalizeSourceFileExtensions(s.fileExtensions),
    ignorePaths: Array.isArray(s.ignorePaths) ? s.ignorePaths : [],
  }));
}

type GitCommandRunner = (args: readonly string[], options: { cwd: string }) => unknown;

const DEFAULT_GIT_COMMAND_RUNNER: GitCommandRunner = (args, options) => {
  if (args[0] === 'rev-parse') {
    return execFileSync('git', [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  execFileSync('git', [...args], {
    cwd: options.cwd,
    stdio: 'inherit',
  });
};

interface CloneRepoDeps {
  runGit?: GitCommandRunner;
  tempRootDir?: string;
  now?: () => number;
  sourceRootDir?: string;
}

export async function cloneRepo(
  source: Source,
  deps: CloneRepoDeps = {}
): Promise<{ readonly sourceRevision: string | null }> {
  const sourceRootDir = deps.sourceRootDir ?? SOURCE_DIR;
  const repoDir = join(sourceRootDir, source.name);
  const branch = source.branch || 'main';
  const runGit = deps.runGit ?? DEFAULT_GIT_COMMAND_RUNNER;

  if (source.docsPath) {
    // For monorepos: clone into a temp dir and copy only docsPath into repoDir.
    // This keeps our source folder clean with ONLY the docs content.
    const tempRootDir = deps.tempRootDir ?? '/tmp';
    const now = deps.now ?? Date.now;
    const tmpDir = join(tempRootDir, `rag-sync-${source.name}-${now()}`);
    try {
      console.log(`[Sync] Fetching ${source.name} (${source.docsPath}) from ${branch}...`);
      mkdirSync(tmpDir, { recursive: true });
      runGit(['init'], { cwd: tmpDir });
      runGit(['remote', 'add', 'origin', source.url], { cwd: tmpDir });
      runGit(['sparse-checkout', 'init', '--cone'], { cwd: tmpDir });
      runGit(['sparse-checkout', 'set', source.docsPath], { cwd: tmpDir });
      // Blobless depth-1 fetch: downloads commits+trees, then checkout lazily
      // retrieves ONLY the blobs inside docsPath. Without the filter this
      // fetch pulls every blob in the repo (e.g. ~250MB for cpython just to
      // read Doc/*.rst).
      runGit(['fetch', '--depth', '1', '--filter=blob:none', 'origin', branch], {
        cwd: tmpDir,
      });
      runGit(['checkout', 'FETCH_HEAD'], { cwd: tmpDir });
      const sourceRevision = runGit(['rev-parse', 'FETCH_HEAD'], { cwd: tmpDir });

      // Copy only the docsPath contents into repoDir
      const docsSource = join(tmpDir, source.docsPath);
      if (!existsSync(docsSource)) {
        throw new Error(`docsPath not found after clone: ${docsSource}`);
      }
      if (existsSync(repoDir)) {
        rmSync(repoDir, { recursive: true, force: true });
      }
      if (statSync(docsSource).isDirectory()) {
        cpSync(docsSource, repoDir, { recursive: true });
      } else {
        mkdirSync(repoDir, { recursive: true });
        cpSync(docsSource, join(repoDir, basename(source.docsPath)));
      }
      console.log(`[Sync] ${source.name} docs extracted to ${repoDir}`);
      return { sourceRevision: typeof sourceRevision === 'string' ? sourceRevision : null };
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  } else {
    if (existsSync(join(repoDir, '.git'))) {
      console.log(`[Sync] Updating ${source.name}...`);
      runGit(['pull', 'origin', branch], { cwd: repoDir });
      const sourceRevision = runGit(['rev-parse', 'HEAD'], { cwd: repoDir });
      return { sourceRevision: typeof sourceRevision === 'string' ? sourceRevision : null };
    }
    console.log(`[Sync] Cloning ${source.name}...`);
    mkdirSync(repoDir, { recursive: true });
    runGit(['clone', '--depth', '1', '--branch', branch, source.url, '.'], { cwd: repoDir });
    const sourceRevision = runGit(['rev-parse', 'HEAD'], { cwd: repoDir });
    return { sourceRevision: typeof sourceRevision === 'string' ? sourceRevision : null };
  }
}

export interface ProcessFileDeps {
  /** Optional override; falls back to the canonical Docs RAG chunker. */
  chunker?: typeof chunkDocsRagTextWithContext;
  /** Optional override; falls back to the production refiner. */
  refiner?: typeof refineDocument;
  stageFile?: (path: string, content: string) => void;
  renameStage?: (source: string, destination: string) => void;
  removeStage?: (path: string) => void;
}

const DEFAULT_PROCESS_FILE_DEPS: ProcessFileDeps = {
  chunker: chunkDocsRagTextWithContext,
  refiner: refineDocument,
  stageFile: (path, content) => writeFileSync(path, content, 'utf-8'),
  renameStage: renameSync,
  removeStage: (path) => rmSync(path, { force: true }),
};

/**
 * Truthful processing-profile component identities for the external sync
 * pipeline. Bump the version suffix whenever the corresponding pipeline step
 * changes its output so stored derived data is invalidated and regenerated.
 */
const DOCS_RAG_EXTERNAL_CLEANER_ID = 'external-sync-cleaner';
const DOCS_RAG_EXTERNAL_REDACTION_ID = 'external-secret-redactions';
const DOCS_RAG_EXTERNAL_NORMALIZATION_ID = 'external-control-normalize';
/** Refiner identity used when --skip-llm bypasses model refinement. */
const DOCS_RAG_EXTERNAL_REFINER_BYPASS_ID = 'refiner:bypass-deterministic';

const DOCS_RAG_EXTERNAL_PROVENANCE_COMPONENT_SUFFIX = `v${DOCS_RAG_PROCESSING_PROFILE_PIPELINE_REVISION}`;

export function resolveExternalDocsProcessingProfile(
  docsRagConfig: DocsRagLabConfig,
  mode: Pick<SyncModeOptions, 'skipLlm'>,
  sourceRevision?: string | null
): ReturnType<typeof resolveDocsRagCanonicalProcessingProfile> {
  const refinerRuntime = getRefinerRuntimeConfig();
  const chunkConfig = resolveExternalDocsChunkConfig();
  const componentSuffix = sourceRevision ? DOCS_RAG_EXTERNAL_PROVENANCE_COMPONENT_SUFFIX : 'v1';
  const componentId = (base: string): string => `${base}-${componentSuffix}`;
  return resolveDocsRagCanonicalProcessingProfile(docsRagConfig, {
    cleaner: componentId(DOCS_RAG_EXTERNAL_CLEANER_ID),
    refiner: mode.skipLlm
      ? componentId(DOCS_RAG_EXTERNAL_REFINER_BYPASS_ID)
      : `refiner:${refinerRuntime.provider}:${refinerRuntime.model}${sourceRevision ? `:${componentSuffix}` : ''}`,
    redaction: componentId(DOCS_RAG_EXTERNAL_REDACTION_ID),
    normalization: componentId(DOCS_RAG_EXTERNAL_NORMALIZATION_ID),
    chunkSize: chunkConfig.chunkSize,
    chunkOverlap: chunkConfig.chunkOverlap,
    sourceRevision: sourceRevision ?? null,
  });
}

interface StagedProcessedArtifact {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

function findStagedProcessedArtifacts(processedFilePath: string): StagedProcessedArtifact[] {
  const parent = dirname(processedFilePath);
  if (!existsSync(parent)) {
    return [];
  }
  const prefix = `${basename(processedFilePath)}.tmp-`;
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => {
      const path = join(parent, entry.name);
      const content = readFileSync(path, 'utf-8');
      return { path, content, sha256: sha256Hex(content) };
    });
}

const EXTERNAL_DOC_SECRET_REDACTIONS = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    pattern:
      /\b(?:ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replacement: '[REDACTED_SECRET_EXAMPLE]',
  },
  {
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/)([^/\s:@]+):([^@\s]+)@/gi,
    replacement: '$1[REDACTED_CREDENTIALS]@',
  },
] as const;

export function sanitizeExternalDocsContent(content: string): string {
  const redacted = EXTERNAL_DOC_SECRET_REDACTIONS.reduce(
    (sanitized, redaction) => sanitized.replace(redaction.pattern, redaction.replacement),
    content
  );
  return normalizeExternalDocControlCharacters(redacted);
}

export function prepareDeterministicExternalDocContent(
  content: string,
  sourcePath: string
): string {
  if (extname(sourcePath).toLowerCase() === '.rst') {
    return sanitizeExternalDocsContent(content);
  }

  return sanitizeExternalDocsContent(
    postProcessRefinedContent(content, {
      sourcePath,
      originalContent: content,
    })
  );
}

export async function processFile(
  rawFilePath: string,
  processedFilePath: string,
  sourcePath: string,
  category: string,
  docsRagConfig: DocsRagLabConfig | null,
  mode: SyncModeOptions,
  deps: ProcessFileDeps = DEFAULT_PROCESS_FILE_DEPS
): Promise<{ success: boolean; file: string; skipped?: boolean; error?: string }> {
  // Staged artifact lifecycle: refined bytes are written to a `.tmp-` staging
  // file, adopted as provenance by the Postgres commit, and only renamed into
  // the cache after that commit succeeds. Any failure removes the staged file
  // so neither staged nor cache bytes can become authoritative early.
  let stagedProcessedFile: string | null = null;
  let databaseCommitCompleted = false;
  // Effective chunk parameters for this run: used by BOTH the canonical
  // chunker and the processing profile, so an override changes boundaries AND
  // the profile hash (invalidating cached derived data) together.
  const chunkConfig = resolveExternalDocsChunkConfig();
  try {
    const rawBytes = readFileSync(rawFilePath);
    const rawContent = rawBytes.toString('utf-8');
    const sourceMetadata = resolveExternalDocsSourceMetadata(sourcePath, category);
    const categoryName = sourceMetadata.category ?? category;
    const embeddingModel =
      docsRagConfig?.embedding.model ?? resolveDocsRagLabConfig().embedding.model;

    // 1. Truthful upstream identity: pure SHA-256 of the exact raw bytes.
    // Configuration never seeds this hash; processing identity lives in the
    // deterministic processing profile resolved below.
    const rawContentSha256 = createHash('sha256').update(rawBytes).digest('hex');

    const generationId = mode.generationId;

    if (mode.dryRun) {
      const hasProcessedVersion = existsSync(processedFilePath);
      const previewContent = hasProcessedVersion
        ? readFileSync(processedFilePath, 'utf-8')
        : rawContent;
      const previewChunks = await (deps.chunker ?? chunkDocsRagTextWithContext)(
        previewContent,
        { title: extractTitle(previewContent, basename(rawFilePath)), sourcePath },
        {
          docType: 'external',
          ...chunkConfig,
          sourcePath: rawFilePath,
        }
      );
      console.log(
        `🧪 [DRY-RUN] ${hasProcessedVersion ? 'Would check/update' : 'Would process'}: ${sourcePath} (${previewChunks.length} chunks)`
      );
      console.log(
        `🧪 [DRY-RUN] Would embed with model '${embeddingModel}' and upsert in category '${categoryName}'`
      );
      return { success: true, file: sourcePath, skipped: hasProcessedVersion };
    }

    if (
      typeof generationId !== 'number' ||
      !Number.isSafeInteger(generationId) ||
      generationId < 1
    ) {
      throw new Error('Docs RAG source generation is required for non-dry-run sync.');
    }

    if (!docsRagConfig) {
      throw new Error('Docs RAG Postgres config is required when not running --dry-run');
    }

    const provenanceInputs = [
      mode.sourceUrl,
      mode.sourceRevision,
      mode.upstreamPath,
      mode.syncedAt,
    ];
    const provenance = provenanceInputs.some((value) => value !== undefined)
      ? buildExternalDocsProvenance({
          sourceUrl: mode.sourceUrl ?? '',
          sourceRevision: mode.sourceRevision,
          upstreamPath: mode.upstreamPath,
          syncedAt: mode.syncedAt,
        })
      : undefined;

    // Deterministic processing identity for this run: everything that can
    // change derived output (cleaner, refiner strategy, redaction,
    // normalization) plus the canonical chunker/embedding parameters from the
    // active config — including the exact effective CHUNK_SIZE/CHUNK_OVERLAP
    // this run will chunk with, so overrides change the hash. A component
    // change yields a different profile hash and invalidates cached data.
    const { profile: processingProfile, profileHash: processingProfileHash } =
      resolveExternalDocsProcessingProfile(docsRagConfig, mode, mode.sourceRevision);

    const documentIdentity = buildDocsRagDocumentIdentity(
      processedFilePath,
      sourceMetadata,
      docsRagConfig.rootDir
    );
    let existingProcessedContent = existsSync(processedFilePath)
      ? readFileSync(processedFilePath, 'utf-8')
      : null;
    let existingProcessedQuality =
      existingProcessedContent === null ? null : assessExternalDocContent(existingProcessedContent);
    const rawQuality = assessExternalDocContent(
      prepareDeterministicExternalDocContent(rawContent, sourcePath)
    );

    // DB/cache hash parity: a cached artifact may only be trusted (skip or
    // reuse) when its exact bytes match the processed body recorded in
    // Postgres. Unknown stored hashes cannot prove parity either way.
    const processingDecision = await inspectDocsRagLabDocumentProcessing(docsRagConfig, {
      sourceId: documentIdentity.sourceId,
      sourcePath: documentIdentity.sourcePath,
      contentHash: rawContentSha256,
      processingProfileHash,
      generationId: mode.generationId,
    });
    const storedProcessedSha256 = processingDecision.processedContentSha256 ?? null;
    const stagedArtifacts = findStagedProcessedArtifacts(processedFilePath);
    const canAdoptStagedArtifact =
      !mode.force && !processingDecision.contentChanged && storedProcessedSha256 !== null;
    const matchingStagedArtifact = canAdoptStagedArtifact
      ? stagedArtifacts.find((artifact) => artifact.sha256 === storedProcessedSha256)
      : undefined;

    if (matchingStagedArtifact) {
      (deps.renameStage ?? renameSync)(matchingStagedArtifact.path, processedFilePath);
      existingProcessedContent = matchingStagedArtifact.content;
      existingProcessedQuality = assessExternalDocContent(existingProcessedContent);
    }
    for (const artifact of stagedArtifacts) {
      if (artifact.path !== matchingStagedArtifact?.path) {
        (deps.removeStage ?? ((path: string) => rmSync(path, { force: true })))(artifact.path);
      }
    }

    const cachedProcessedSha256 =
      existingProcessedContent === null ? null : sha256Hex(existingProcessedContent);
    const cacheMatchesDb =
      storedProcessedSha256 !== null && cachedProcessedSha256 === storedProcessedSha256;
    const cacheParityProven = cacheMatchesDb && existingProcessedContent !== null;
    const needsProc = processingDecision.needsProcessing || !cacheParityProven;

    if (!mode.force && !needsProc && existingProcessedQuality?.valid) {
      console.log(`⏩ Skipping (No raw changes): ${sourcePath}`);
      return { success: true, file: sourcePath, skipped: true };
    }
    if (!mode.force && !needsProc && existingProcessedQuality && !existingProcessedQuality.valid) {
      console.log(
        `♻️ Reprocessing invalid cached artifact (${existingProcessedQuality.reasons.join(', ')}): ${sourcePath}`
      );
    }
    if (mode.force && !needsProc && existingProcessedContent !== null) {
      console.log(`🔁 Forcing reprocess despite unchanged hash: ${sourcePath}`);
    }

    // 2. Refine using LLM (or bypass if --skip-llm is provided)
    let refinedContent: string;
    let shouldWriteProcessedFile = true;
    const reuseCachedArtifactForIndexRepair =
      !mode.force &&
      processingDecision.indexRepairNeeded &&
      cacheParityProven &&
      existingProcessedQuality?.valid &&
      existingProcessedContent !== null;
    const reuseCachedArtifactForExcludedRaw =
      !mode.force &&
      !rawQuality.valid &&
      cacheParityProven &&
      existingProcessedQuality?.valid &&
      existingProcessedContent !== null;

    if (reuseCachedArtifactForIndexRepair && existingProcessedContent !== null) {
      console.log(`♻️ Reusing valid cached artifact for index repair: ${sourcePath}`);
      refinedContent = existingProcessedContent;
      shouldWriteProcessedFile = false;
    } else if (reuseCachedArtifactForExcludedRaw && existingProcessedContent !== null) {
      console.log(`♻️ Reusing valid cached artifact for excluded raw source: ${sourcePath}`);
      refinedContent = existingProcessedContent;
      shouldWriteProcessedFile = false;
    } else if (mode.skipLlm) {
      if (
        cacheParityProven &&
        existingProcessedQuality?.valid &&
        existingProcessedContent !== null
      ) {
        console.log(`⏭️  Bypassing LLM (using manually processed file): ${sourcePath}`);
        refinedContent = prepareDeterministicExternalDocContent(
          existingProcessedContent,
          sourcePath
        );
      } else {
        console.log(`⏭️  Bypassing LLM (deterministic cleanup of raw source): ${sourcePath}`);
        refinedContent = prepareDeterministicExternalDocContent(rawContent, sourcePath);
      }
    } else {
      console.log(`🤖 Refining with LLM: ${sourcePath}`);
      refinedContent = sanitizeExternalDocsContent(
        await (deps.refiner ?? refineDocument)(rawContent, { sourcePath })
      );
    }

    const quality = assessExternalDocContent(refinedContent);
    if (!quality.valid) {
      throw new Error(
        `Processed external document is not retrievable (${quality.reasons.join(', ')}): ${sourcePath}`
      );
    }

    // Log token reduction metrics
    const rawTokens = estimateTokens(rawContent);
    const refinedTokens = estimateTokens(refinedContent);
    const reductionPct = rawTokens > 0 ? Math.round((1 - refinedTokens / rawTokens) * 100) : 0;
    console.log(
      `📊 Token reduction: ${rawTokens} → ${refinedTokens} tokens (${reductionPct}% reduction)`
    );

    // 3. Chunking the REFINED content
    console.log(`✂️  Chunking: ${sourcePath}`);
    const chunks = await (deps.chunker ?? chunkDocsRagTextWithContext)(
      refinedContent,
      { title: extractTitle(refinedContent, basename(rawFilePath)), sourcePath },
      {
        docType: 'external',
        ...chunkConfig,
        sourcePath: rawFilePath,
      }
    );
    if (chunks.length === 0) {
      throw new Error(`Processed external document produced zero chunks: ${sourcePath}`);
    }
    if (chunks.some((chunk) => !chunk.content.trim())) {
      throw new Error(`Processed external document produced an empty chunk: ${sourcePath}`);
    }
    if (shouldWriteProcessedFile) {
      mkdirSync(dirname(processedFilePath), { recursive: true });
      stagedProcessedFile = `${processedFilePath}.tmp-${process.pid}-${Date.now()}`;
      (
        deps.stageFile ?? ((path: string, content: string) => writeFileSync(path, content, 'utf-8'))
      )(stagedProcessedFile, refinedContent);
    }

    console.log(`💾 Saving to Docs RAG Postgres: ${sourcePath}`);
    const title = extractTitle(refinedContent, basename(rawFilePath));
    const processedContentSha256 = sha256Hex(refinedContent);
    const upsertReport = await upsertDocsRagLabDocument(
      docsRagConfig,
      {
        ...documentIdentity,
        sourceAbsolutePath: processedFilePath,
        title,
        category: categoryName,
        kind: sourceMetadata.kind,
        language: sourceMetadata.language,
        authority: sourceMetadata.authority,
        canonicalUrl: provenance?.canonicalUrl ?? null,
        contentHash: rawContentSha256,
        upstreamPath: sourcePath,
        upstreamContentSha256: rawContentSha256,
        processedPath: documentIdentity.sourcePath,
        processedContentSha256,
        processingProfileHash,
        processingProfile,
        searchableText: [title, documentIdentity.sourcePath, refinedContent.slice(0, 2_000)].join(
          '\n\n'
        ),
        content: refinedContent,
        metadata: {
          ...buildDocsRagMetadata(sourceMetadata),
          rawSourcePath: sourcePath,
          rawSourceSha256: rawContentSha256,
          ...(provenance ?? {}),
        },
        chunks: chunks.map((chunk, index) => ({
          chunkIndex: index,
          heading: chunk.heading,
          section: chunk.section,
          content: chunk.content,
          searchableText: chunk.searchableText,
        })),
      },
      { generationId }
    );
    databaseCommitCompleted = true;
    if (stagedProcessedFile) {
      (deps.renameStage ?? renameSync)(stagedProcessedFile, processedFilePath);
      stagedProcessedFile = null;
    }
    console.log(`✅ Success: ${sourcePath} (${chunks.length} chunks)`);
    if (upsertReport.embeddedChunks > 0) {
      console.log(`🧠 Embedded ${upsertReport.embeddedChunks} chunks in Postgres`);
    }
    return { success: true, file: sourcePath };
  } catch (error) {
    if (stagedProcessedFile && !databaseCommitCompleted) {
      (deps.removeStage ?? ((path: string) => rmSync(path, { force: true })))(stagedProcessedFile);
      stagedProcessedFile = null;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed: ${rawFilePath} - ${message}`);
    return { success: false, file: rawFilePath, error: message };
  }
}

export async function main(
  options: SyncRuntimeOptions = parseSyncRuntimeOptions()
): Promise<number> {
  const sourceRootDir = options.sourceRootDir ?? SOURCE_DIR;
  const refinerRuntime = getRefinerRuntimeConfig();
  console.log(
    `🚀 Starting LLM-Refined External Docs Ingestion Pipeline${options.dryRun ? ' [DRY-RUN]' : ''}${options.skipLlm && !options.dryRun ? ' [SKIP-LLM]' : ''}${options.force && !options.dryRun ? ' [FORCE]' : ''}${options.sourceName ? ` [SOURCE:${options.sourceName}]` : ''}...`
  );
  if (!options.skipLlm) {
    const endpointSuffix =
      refinerRuntime.provider === 'llamacpp' && refinerRuntime.endpoint
        ? ` endpoint=${refinerRuntime.endpoint}`
        : '';
    console.log(
      `🤖 Refiner provider=${refinerRuntime.provider} model=${refinerRuntime.model}${endpointSuffix}`
    );
  }
  const docsRagConfig = resolveDocsRagLabConfig(
    resolveSyncDocsRagLabEnv(process.env, options.dryRun)
  );
  if (!options.dryRun) {
    if (!docsRagConfig.database.url) {
      throw new Error('DOCS_RAG_PG_LAB_DATABASE_URL is required for non-dry-run sync.');
    }
    if (!docsRagConfig.gates.mutationEnabled) {
      throw new Error('DOCS_RAG_PG_LAB_ENABLE_MUTATIONS=true is required for non-dry-run sync.');
    }
    console.log(`🔌 Docs RAG Postgres: ${docsRagConfig.database.redactedUrl}`);
  }

  // Portability validation (T-16)
  if (options.dryRun) {
    console.log('\n🔍 Portability Validation (dry-run mode):');
    console.log(`   Working directory: ${process.cwd()}`);
    console.log(`   INGEST_DIR: ${INGEST_DIR}`);
    console.log(`   SOURCE_DIR: ${sourceRootDir}`);
    console.log(`   PROCESSED_DIR: ${PROCESSED_DIR}`);
    console.log(`   SOURCES_FILE: ${SOURCES_FILE}`);

    // Check if paths are valid
    const pathChecks = [
      { name: 'INGEST_DIR', path: INGEST_DIR, mustExist: false },
      { name: 'SOURCES_FILE', path: SOURCES_FILE, mustExist: true },
    ];

    let portabilityIssues = 0;
    for (const check of pathChecks) {
      if (check.mustExist && !existsSync(check.path)) {
        console.warn(`   ⚠️  ${check.name} does not exist: ${check.path}`);
        portabilityIssues++;
      } else {
        console.log(
          `   ✅ ${check.name} is ${existsSync(check.path) ? 'valid' : 'will be created'}`
        );
      }
    }

    if (portabilityIssues > 0) {
      console.warn(`\n⚠️  Portability validation found ${portabilityIssues} issue(s)`);
    } else {
      console.log(`\n✅ All portability checks passed`);
    }
    console.log('');
  }

  const startTimeMs = Date.now();
  const startedAt = new Date(startTimeMs).toISOString();

  const allSources = getSources();
  const sources = options.sourceName
    ? allSources.filter((source) => source.name === options.sourceName)
    : allSources;
  if (options.sourceName && sources.length === 0) {
    throw new Error(
      `Source '${options.sourceName}' not found in scripts/sources.json. Available sources: ${allSources.map((source) => source.name).join(', ')}`
    );
  }
  const sourceSummaries: SourceSummary[] = [];
  const runBudget = { totalBytes: 0, estimatedChunks: 0 };
  const preReadRunBudget = { totalBytes: 0, estimatedChunks: 0 };

  for (const source of sources) {
    const sourceStartMs = Date.now();

    let sourceRevision: string | null = null;
    if (!options.dryRun) {
      sourceRevision = (await cloneRepo(source, { sourceRootDir })).sourceRevision;
    } else {
      console.log(`[Sync][DRY-RUN] Skipping clone/update for ${source.name}`);
    }

    // When docsPath is configured, cloneRepo extracts ONLY the docs into repoDir.
    // So the effective docs directory IS repoDir itself (not repoDir+docsPath).
    const repoDocsDir = source.docsPath
      ? join(sourceRootDir, source.name)
      : join(sourceRootDir, source.name, source.docsPath);

    if (!existsSync(repoDocsDir)) {
      if (options.dryRun) {
        console.warn(`[${source.name}] [DRY-RUN] Docs directory missing locally: ${repoDocsDir}`);
        sourceSummaries.push({
          source: source.name,
          totalFiles: 0,
          ignoredFiles: 0,
          contentExcludedFiles: 0,
          attemptedFiles: 0,
          processedFiles: 0,
          skippedFiles: 1,
          failedFiles: 0,
          failures: [],
          exclusions: [],
          durationMs: Date.now() - sourceStartMs,
          removedProcessedArtifacts: 0,
          deletedDocs: 0,
          deletedChunks: 0,
        });
        continue;
      }
      throw new Error(
        `[${source.name}] Docs directory not found: ${repoDocsDir}\n` +
          `  → Check 'docsPath' in sources.json for source '${source.name}'.\n` +
          `  → Expected content from: ${source.url}`
      );
    }

    const files = await glob(buildSourceGlob(source.fileExtensions), {
      cwd: repoDocsDir,
      absolute: true,
      ignore: ['node_modules/**', '.git/**'],
    });

    const fileEntries = files.map((rawFile) => ({
      rawFile,
      relativePath: relative(repoDocsDir, rawFile).split('\\').join('/'),
    }));
    const pathFilteredEntries = fileEntries.filter(
      ({ relativePath }) => !shouldIgnoreExternalDocPath(relativePath, source.ignorePaths ?? [])
    );
    const ignoredFiles = fileEntries.length - pathFilteredEntries.length;
    const readableEntries = filterExternalDocEntries(pathFilteredEntries);
    if (readableEntries.length !== pathFilteredEntries.length) {
      throw new Error(
        `[${source.name}] Docs scan is incomplete: ${pathFilteredEntries.length - readableEntries.length} discovered file(s) are unreadable.`
      );
    }

    // Enforce the source and cumulative run budgets from metadata before
    // classifyExternalDocEntries reads any file contents into memory. The
    // post-classification estimate below remains the exact ingestion budget.
    const chunkConfig = resolveExternalDocsChunkConfig();
    const preReadBudget = estimateExternalDocsBudget(
      readableEntries,
      chunkConfig.chunkSize,
      chunkConfig.chunkOverlap
    );
    assertExternalDocsBudget(source.name, preReadBudget, {
      maxSourceBytes: options.maxSourceBytes,
      maxEstimatedChunks: options.maxEstimatedChunks,
    });
    const nextPreReadRunBudget = accumulateExternalDocsBudget(preReadRunBudget, preReadBudget);
    assertExternalDocsRunBudget(source.name, nextPreReadRunBudget, {
      maxRunBytes: options.maxRunBytes,
      maxRunEstimatedChunks: options.maxRunEstimatedChunks,
    });
    preReadRunBudget.totalBytes = nextPreReadRunBudget.totalBytes;
    preReadRunBudget.estimatedChunks = nextPreReadRunBudget.estimatedChunks;

    const { eligible: filteredEntries, excluded: contentExcludedEntries } =
      classifyExternalDocEntries(
        readableEntries,
        source.name,
        prepareDeterministicExternalDocContent
      );

    if (!options.dryRun) {
      const citationPaths =
        filteredEntries.length > 0
          ? filteredEntries.map(({ relativePath }) => relativePath)
          : [source.docsPath || 'index.md'];
      for (const relativePath of citationPaths) {
        buildExternalDocsProvenance({
          sourceUrl: source.url,
          sourceRevision,
          upstreamPath: resolveExternalDocsUpstreamPath(source, relativePath),
          syncedAt: startedAt,
        });
      }
    }

    console.log(`📄 Found ${filteredEntries.length}/${fileEntries.length} files in ${source.name}
`);
    if (ignoredFiles > 0) {
      console.log(`🧹 Ignored ${ignoredFiles} noisy files by path filters for ${source.name}`);
    }
    if (contentExcludedEntries.length > 0) {
      console.log(
        `🧹 Excluded ${contentExcludedEntries.length} non-retrievable file(s) by content for ${source.name}`
      );
    }

    const budget = estimateExternalDocsBudget(
      filteredEntries,
      chunkConfig.chunkSize,
      chunkConfig.chunkOverlap
    );
    assertExternalDocsBudget(source.name, budget, {
      maxSourceBytes: options.maxSourceBytes,
      maxEstimatedChunks: options.maxEstimatedChunks,
    });
    const nextRunBudget = accumulateExternalDocsBudget(runBudget, budget);
    assertExternalDocsRunBudget(source.name, nextRunBudget, {
      maxRunBytes: options.maxRunBytes,
      maxRunEstimatedChunks: options.maxRunEstimatedChunks,
    });
    runBudget.totalBytes = nextRunBudget.totalBytes;
    runBudget.estimatedChunks = nextRunBudget.estimatedChunks;
    console.log(
      `🧮 Budget check: ${source.name} has ${budget.totalBytes} bytes, estimated ${budget.estimatedChunks} chunks (run total ${runBudget.totalBytes} bytes, estimated ${runBudget.estimatedChunks} chunks)`
    );

    let sourceGenerationId: number | undefined;
    let sourceGenerationPublished = false;
    if (!options.dryRun) {
      if (!docsRagConfig) {
        throw new Error('Docs RAG Postgres config is required for source-generation publication.');
      }
      const sourceMetadata = resolveExternalDocsSourceMetadata(`${source.name}/`, source.category);
      const { profile, profileHash } = resolveExternalDocsProcessingProfile(
        docsRagConfig,
        options,
        sourceRevision
      );
      const rawManifestSha256 = buildDocsRagSourceManifestHash(pathFilteredEntries);
      const generation = await createDocsRagSourceGeneration(docsRagConfig, {
        sourceId: sourceMetadata.sourceId ?? canonicalizeDocsSourceId(source.name),
        provenanceClass: 'revision_bound_external',
        generationKey: buildDocsRagSourceGenerationKey({
          sourceId: sourceMetadata.sourceId ?? canonicalizeDocsSourceId(source.name),
          upstreamRevision: sourceRevision,
          rawManifestSha256,
          processingProfileHash: profileHash,
        }),
        upstreamRevision: sourceRevision,
        upstreamPath: source.docsPath || '.',
        license: source.license ?? null,
        rawManifestSha256,
        processingProfileHash: profileHash,
        processingProfile: profile,
        expectedDocumentCount: filteredEntries.length,
        scanState: 'pending',
      });
      sourceGenerationId = generation.id;
      sourceGenerationPublished = generation.status === 'published';
    }

    if (options.fileConcurrency > 1) {
      console.log(`⚙️  File concurrency for ${source.name}: ${options.fileConcurrency}`);
    }
    const limitFileProcessing = pLimit(options.fileConcurrency);
    const results = sourceGenerationPublished
      ? filteredEntries.map(({ relativePath }) => ({
          success: true as const,
          file: join(source.name, relativePath),
          skipped: true as const,
        }))
      : await Promise.all(
          filteredEntries.map(({ rawFile, relativePath }) =>
            limitFileProcessing(() => {
              const sourcePath = join(source.name, relativePath);
              const processedFile = join(PROCESSED_DIR, sourcePath);
              return processFile(
                rawFile,
                processedFile,
                sourcePath,
                source.category,
                docsRagConfig,
                {
                  ...options,
                  generationId: sourceGenerationId,
                  sourceRevision,
                  sourceUrl: source.url,
                  upstreamPath: resolveExternalDocsUpstreamPath(source, relativePath),
                  syncedAt: startedAt,
                }
              );
            })
          )
        );

    const failed = results.filter((r) => !r.success).length;
    const success = results.filter((r) => r.success).length;
    const skipped = results.filter((r) => r.skipped).length;
    const processed = success - skipped;
    const failures = results
      .filter(
        (result): result is { success: false; file: string; error: string } => !result.success
      )
      .map((result) => ({ file: result.file, error: result.error ?? 'Unknown error' }));

    console.log(`
📊 Done processing ${source.name}.`);
    console.log(`   - Success: ${processed}`);
    console.log(`   - Skipped: ${skipped}`);
    console.log(`   - Failed:  ${failed}`);

    if (!options.dryRun && sourceGenerationId !== undefined) {
      if (failed > 0) {
        await finalizeDocsRagSourceGeneration(docsRagConfig as DocsRagLabConfig, {
          generationId: sourceGenerationId,
          scanState: 'incomplete',
        });
        console.log(
          `🛑 Docs RAG source generation ${sourceGenerationId} remains non-serving because ${failed} file(s) failed.`
        );
      } else {
        await finalizeDocsRagSourceGeneration(docsRagConfig as DocsRagLabConfig, {
          generationId: sourceGenerationId,
          scanState: 'complete',
        });
        await publishDocsRagSourceGeneration(docsRagConfig as DocsRagLabConfig, {
          generationId: sourceGenerationId,
        });
        const generationGc = await gcDocsRagSourceGenerations(docsRagConfig as DocsRagLabConfig, {
          sourceId: canonicalizeDocsSourceId(source.name),
        });
        if (generationGc.deletedGenerations > 0) {
          console.log(
            `🧹 Retired ${generationGc.deletedGenerations} superseded Docs RAG generation(s) for ${source.name}.`
          );
        }
        console.log(`📚 Published complete Docs RAG source generation ${sourceGenerationId}.`);
      }
    }

    let deletedDocs = 0;
    let deletedChunks = 0;
    let removedProcessedArtifacts = 0;

    if (
      shouldRunGarbageCollection({
        dryRun: options.dryRun,
        skipLlm: options.skipLlm,
        skipped,
        failed,
      })
    ) {
      if (!docsRagConfig) {
        throw new Error('Docs RAG Postgres config is required for stale-doc cleanup.');
      }
      const cleanupInput = buildDocsRagCleanupInput(
        source.name,
        source.category,
        filteredEntries.map(({ relativePath }) => relativePath),
        docsRagConfig.rootDir,
        shouldAllowDeleteAllForExcludedSource({
          pathFilteredFiles: pathFilteredEntries.length,
          eligibleFiles: filteredEntries.length,
          contentExcludedFiles: contentExcludedEntries.length,
        })
      );
      if (shouldRunDocsRagCleanup(cleanupInput)) {
        const cleanupReport = await deleteStaleDocsRagLabDocuments(docsRagConfig, cleanupInput);
        deletedDocs = cleanupReport.deletedDocs;
        deletedChunks = cleanupReport.deletedChunks;
        console.log(
          `🧹 Deleted ${deletedDocs} stale Docs RAG Postgres document(s) and ${deletedChunks} chunk(s) for ${source.name}.`
        );
      } else {
        console.warn(`🧹 Skipping stale-doc cleanup for ${source.name}: no current docs seen.`);
      }
    } else if (!options.dryRun && failed > 0) {
      console.log(
        `🧹 Skipping Garbage Collection for ${source.name} because ${failed} file(s) failed.`
      );
    } else {
      console.log(`🧪 [DRY-RUN] Would run stale-doc cleanup for ${source.name}.`);
    }

    if (!options.dryRun && failed === 0) {
      removedProcessedArtifacts = removeGeneratedExternalDocArtifacts(
        PROCESSED_DIR,
        source.name,
        contentExcludedEntries.map(({ relativePath }) => relativePath)
      ).length;
      if (removedProcessedArtifacts > 0) {
        console.log(
          `🧹 Removed ${removedProcessedArtifacts} generated non-retrievable artifact(s) for ${source.name}; raw sources remain recoverable.`
        );
      }
    }

    sourceSummaries.push({
      source: source.name,
      totalFiles: fileEntries.length,
      ignoredFiles,
      contentExcludedFiles: contentExcludedEntries.length,
      attemptedFiles: filteredEntries.length,
      processedFiles: processed,
      skippedFiles: skipped,
      failedFiles: failed,
      failures,
      exclusions: contentExcludedEntries.slice(0, 20).map(({ relativePath, quality }) => ({
        file: relativePath,
        reasons: quality.reasons,
      })),
      durationMs: Date.now() - sourceStartMs,
      removedProcessedArtifacts,
      deletedDocs,
      deletedChunks,
    });

    if (!options.dryRun && sourceSummaries.length < sources.length) {
      const checkpointReport = buildSyncRunReport({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTimeMs,
        dryRun: false,
        skipLlm: options.skipLlm,
        maxFailedDocs: options.maxFailedDocs,
        maxFailureRate: options.maxFailureRate,
        sources: sourceSummaries,
      });
      const checkpointPaths = saveSyncRunReport(checkpointReport, options.reportDir);
      console.log(
        `📝 Sync checkpoint saved after ${source.name}: ${checkpointPaths.timestampedPath}`
      );
    }
  }

  const report = buildSyncRunReport({
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startTimeMs,
    dryRun: options.dryRun,
    skipLlm: options.skipLlm,
    maxFailedDocs: options.maxFailedDocs,
    maxFailureRate: options.maxFailureRate,
    sources: sourceSummaries,
  });

  const reportPaths = saveSyncRunReport(report, options.reportDir);
  console.log(`📝 Sync report saved: ${reportPaths.timestampedPath}`);
  if (reportPaths.latestPath) {
    console.log(`📝 Latest report: ${reportPaths.latestPath}`);
  } else {
    console.log('📝 Latest report unchanged for dry-run.');
  }

  if (report.alerts.length > 0) {
    console.error('🚨 Sync threshold alerts:');
    for (const alert of report.alerts) {
      console.error(`   - ${alert}`);
    }
    return 1;
  }

  console.log('✅ Sync completed within configured thresholds.');
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
