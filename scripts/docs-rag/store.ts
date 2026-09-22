import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { acquireProjectRagWriteFence } from '../db-migrations/write-fence.js';
import {
  canonicalizeDocsSourceId,
  DOCS_SOURCE_ARTIFACT_PREFIXES,
  DOCS_SOURCE_REGISTRY,
  type DocsSourceAuthority,
  isDocsSourceArtifactPath,
  lookupDocsSourceByPath,
  normalizeDocsSourceMetadata,
} from '../lib/docs-source-registry.js';
import {
  chunkDocsRagTextWithContext,
  DOCS_RAG_CHUNKER_ID,
  DOCS_RAG_DEFAULT_CHUNK_OVERLAP,
  DOCS_RAG_DEFAULT_CHUNK_SIZE,
  resolveDocsRagChunkConfig,
} from './chunker.js';
import { type DocsRagLabConfig, parsePositiveInteger } from './config.js';
import {
  type DocsRagProcessingProfile,
  docsRagProcessingProfileHash,
  resolveDocsRagProcessingProfile,
} from './processing-profile.js';

const DEFAULT_MAX_FILES = 5_000;
/**
 * Hard bound on the exact text sent to the embedding provider per chunk.
 * The bound is applied when the embedding input is BUILT (never hidden inside
 * the fetch), so the persisted embedding-input text is byte-identical to what
 * the provider received.
 */
export const DOCS_RAG_EMBEDDING_INPUT_MAX_CHARS = 2_000;
/** Marker recorded for rows indexed before processing profiles existed. */
export const DOCS_RAG_LEGACY_PROCESSING_PROFILE_HASH = 'legacy';
/** Explicit provenance classes persisted on every post-migration generation. */
export const DOCS_RAG_PROVENANCE_CLASSES = [
  'revision_bound_external',
  'processed_external_import',
] as const;
export type DocsRagProvenanceClass = (typeof DOCS_RAG_PROVENANCE_CLASSES)[number];
function isDocsRagProvenanceClass(value: unknown): value is DocsRagProvenanceClass {
  return DOCS_RAG_PROVENANCE_CLASSES.some((candidate) => candidate === value);
}
/** Controlled remediation entry point for the provenance schema. */
export const DOCS_RAG_MIGRATION_COMMAND =
  'bun run db:migrations apply --lane docs --execute (check state first with: bun run db:migrations status --lane docs)';

/**
 * Resolve the canonical processing profile shared by every Docs RAG ingestion
 * surface. Embedding/chunking components come from the active config; pipeline
 * components (cleaner/refiner/redaction/normalization) are supplied by the
 * caller so each surface stays truthful about what it actually runs.
 */
export function resolveDocsRagCanonicalProcessingProfile(
  config: Pick<DocsRagLabConfig, 'embedding'>,
  components: {
    readonly cleaner: string;
    readonly refiner: string;
    readonly redaction: string;
    readonly normalization: string;
    readonly sourceRevision?: string | null;
    /**
     * EXACT chunk parameters the canonical chunker will run with. Callers that
     * override CHUNK_SIZE/CHUNK_OVERLAP must pass their effective values here;
     * any difference changes the profile hash and invalidates cached derived
     * data. Defaults are the canonical chunker defaults.
     */
    readonly chunkSize?: number;
    readonly chunkOverlap?: number;
  }
): { readonly profile: DocsRagProcessingProfile; readonly profileHash: string } {
  const profile = resolveDocsRagProcessingProfile({
    ...components,
    chunker: DOCS_RAG_CHUNKER_ID,
    provider: config.embedding.provider,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
    chunkSize: components.chunkSize ?? DOCS_RAG_DEFAULT_CHUNK_SIZE,
    chunkOverlap: components.chunkOverlap ?? DOCS_RAG_DEFAULT_CHUNK_OVERLAP,
    embeddingInputMaxChars: DOCS_RAG_EMBEDDING_INPUT_MAX_CHARS,
  });
  return { profile, profileHash: docsRagProcessingProfileHash(profile) };
}
const SUPPORTED_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.json']);
const REGISTERED_SOURCE_IDS = DOCS_SOURCE_REGISTRY.map((source) => source.sourceId);
const EXTENSION_PRIORITY = new Map([
  ['.md', 4],
  ['.mdx', 3],
  ['.txt', 2],
  ['.rst', 1],
  ['.json', 0],
]);

export interface DocsRagLabDocumentInput {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly sourceAbsolutePath: string;
  readonly title: string;
  readonly category?: string;
  readonly kind?: string;
  readonly language?: string;
  readonly authority?: string;
  /** Revision-bound upstream citation URL, when the source sync supplied one. */
  readonly canonicalUrl: string | null;
  /**
   * Canonical upstream content hash (pure SHA-256 of the raw upstream bytes).
   * Callers must not seed this hash with configuration; processing identity
   * lives exclusively in `processingProfileHash`.
   */
  readonly contentHash: string;
  /** Upstream location relative to its source root, when known. */
  readonly upstreamPath?: string | null;
  /** SHA-256 of the exact upstream bytes, when known. */
  readonly upstreamContentSha256?: string | null;
  /** Processed artifact location (the cache file the content came from). */
  readonly processedPath?: string | null;
  /** SHA-256 of the exact processed body persisted in `content`. */
  readonly processedContentSha256?: string | null;
  /** Deterministic processing profile identity for this derived document. */
  readonly processingProfileHash: string;
  /** Resolved processing profile recorded as data for auditability. */
  readonly processingProfile?: DocsRagProcessingProfile | null;
  readonly searchableText: string;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly legacyKeys: Array<{ readonly sourceId: string; readonly sourcePath: string }>;
  readonly chunks: DocsRagLabChunkInput[];
}

export interface DocsRagLabChunkInput {
  readonly chunkIndex: number;
  readonly heading?: string;
  readonly section?: string;
  readonly content: string;
  readonly searchableText: string;
}

export interface DocsRagLabIngestReport {
  readonly status: 'completed';
  readonly inputPaths: string[];
  readonly scannedFiles: number;
  readonly indexedDocuments: number;
  readonly indexedChunks: number;
  readonly skippedFiles: number;
  readonly failedFiles: Array<{
    readonly path: string;
    readonly message: string;
  }>;
}

export interface DocsRagLabUpsertReport {
  readonly status: 'completed';
  readonly documentId: number;
  readonly indexedChunks: number;
  readonly embeddedChunks: number;
}

/**
 * A document write is valid only inside an explicitly planned source
 * generation. The caller owns scan completeness and publication; a document
 * upsert never creates or switches the serving pointer implicitly.
 */
export interface DocsRagLabUpsertOptions {
  readonly generationId: number;
}

export type DocsRagSourceGenerationScanState = 'pending' | 'complete' | 'incomplete' | 'blocked';

export interface DocsRagSourceGenerationInput {
  readonly sourceId: string;
  readonly provenanceClass: DocsRagProvenanceClass;
  /** Stable retry identity for one upstream/profile snapshot. */
  readonly generationKey: string;
  readonly upstreamRevision?: string | null;
  readonly upstreamPath?: string | null;
  readonly license?: string | null;
  readonly rawManifestSha256?: string | null;
  readonly processingProfileHash: string;
  readonly processingProfile?: DocsRagProcessingProfile | null;
  readonly expectedDocumentCount: number;
  readonly scanState?: DocsRagSourceGenerationScanState;
}

export interface DocsRagSourceGeneration {
  readonly id: number;
  readonly sourceId: string;
  readonly provenanceClass: DocsRagProvenanceClass;
  readonly generationKey: string;
  readonly upstreamRevision: string | null;
  readonly upstreamPath: string | null;
  readonly license: string | null;
  readonly rawManifestSha256: string | null;
  readonly processingProfileHash: string;
  readonly processingProfile: DocsRagProcessingProfile | null;
  readonly scanState: DocsRagSourceGenerationScanState;
  readonly expectedDocumentCount: number;
  readonly indexedDocumentCount: number;
  readonly status: 'staging' | 'published' | 'retired';
  readonly publishedAt: string | null;
}

export interface DocsRagSourceGenerationPublishReport {
  readonly generation: DocsRagSourceGeneration;
  readonly published: boolean;
}

/**
 * Build a stable source-generation identity. The manifest digest captures the
 * complete upstream file inventory while the profile hash captures every
 * processing/embedding choice. Retries of the same snapshot therefore resume
 * one staging generation instead of creating a second partially populated one.
 */
export function buildDocsRagSourceGenerationKey(input: {
  readonly sourceId: string;
  readonly upstreamRevision?: string | null;
  readonly rawManifestSha256?: string | null;
  readonly processingProfileHash: string;
}): string {
  const canonical = JSON.stringify({
    processingProfileHash: input.processingProfileHash,
    rawManifestSha256: input.rawManifestSha256 ?? null,
    sourceId: input.sourceId,
    upstreamRevision: input.upstreamRevision ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface DocsRagLabStaleDeleteReport {
  readonly deletedDocs: number;
  readonly deletedChunks: number;
}

/**
 * Bounded cleanup for superseded immutable generations. The active pointer is
 * always excluded; retired rows are deleted only after the database has
 * verified they are no longer serving.
 */
export interface DocsRagSourceGenerationGcReport {
  readonly sourceId: string | null;
  readonly keepSupersededPerSource: number;
  readonly deletedGenerations: number;
  readonly deletedDocuments: number;
  readonly deletedChunks: number;
}

const DEFAULT_KEEP_SUPERSEDED_GENERATIONS = 2;
const MAX_KEEP_SUPERSEDED_GENERATIONS = 100;

export const DOCS_RAG_REQUIRED_PROVENANCE_FIELDS = [
  'canonicalUrl',
  'sourceRevision',
  'syncedAt',
  'authority',
] as const;

export type DocsRagProvenanceField = (typeof DOCS_RAG_REQUIRED_PROVENANCE_FIELDS)[number];
export type DocsRagProvenanceStatus = 'complete' | 'degraded';
type DocsRagSqlTimestamp = string | Date | null;

export interface DocsRagLabSearchResultRow {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly heading?: string | null;
  readonly section?: string | null;
  readonly content: string;
  readonly chunkIndex: number;
  readonly score: number;
  readonly metadata?: unknown;
  readonly canonicalUrl?: string | null;
  readonly authority?: DocsSourceAuthority | null;
  readonly sourceRevision?: string | null;
  readonly syncedAt?: DocsRagSqlTimestamp;
  readonly generationKey?: string | null;
  readonly publishedAt?: DocsRagSqlTimestamp;
}

export interface DocsRagLabSearchResult {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly heading: string | null;
  readonly section: string | null;
  readonly content: string;
  readonly chunkIndex: number;
  readonly score: number;
  readonly canonicalUrl: string | null;
  readonly sourceRevision: string | null;
  readonly syncedAt: string | null;
  readonly authority: DocsSourceAuthority | null;
  readonly provenanceStatus: DocsRagProvenanceStatus;
  readonly missingFields: readonly DocsRagProvenanceField[];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  const candidate = nonEmptyString(value);
  return candidate !== null && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function legacySourceGenerationKey(sourceId: string): string {
  return `legacy-${createHash('md5').update(sourceId, 'utf8').digest('hex')}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalize a SQL row into the one citation/provenance shape shared by CLI
 * and MCP. Legacy rows remain readable, but expose missing provenance instead
 * of silently pretending that their citations are revision-bound.
 */
export function normalizeDocsRagLabSearchResult(
  row: DocsRagLabSearchResultRow
): DocsRagLabSearchResult {
  const metadata = recordValue(row.metadata);
  const canonicalUrl = nonEmptyString(row.canonicalUrl) ?? nonEmptyString(metadata.canonicalUrl);
  const generationRevision = nonEmptyString(row.sourceRevision);
  const sourceRevision = generationRevision ?? nonEmptyString(metadata.sourceRevision);
  const metadataSyncedAt = validTimestamp(metadata.syncedAt);
  const generationKey = nonEmptyString(row.generationKey);
  const syncedAt =
    metadataSyncedAt ??
    validTimestamp(row.syncedAt) ??
    (generationRevision !== null &&
    generationKey !== null &&
    generationKey !== legacySourceGenerationKey(row.sourceId)
      ? validTimestamp(row.publishedAt)
      : null);
  const normalizedSource = normalizeDocsSourceMetadata({
    sourceId: row.sourceId,
    sourcePath: row.sourcePath,
  });
  const authority = row.authority ?? normalizedSource.authority ?? null;
  const missingFields = DOCS_RAG_REQUIRED_PROVENANCE_FIELDS.filter((field) => {
    if (field === 'canonicalUrl') return canonicalUrl === null;
    if (field === 'sourceRevision') return sourceRevision === null;
    if (field === 'syncedAt') return syncedAt === null;
    return authority === null;
  });

  return {
    sourceId: row.sourceId,
    sourcePath: row.sourcePath,
    canonicalUrl,
    title: row.title,
    heading: row.heading ?? null,
    section: row.section ?? null,
    chunkIndex: row.chunkIndex,
    sourceRevision,
    syncedAt,
    authority,
    score: finiteNumber(row.score) ?? 0,
    content: row.content,
    provenanceStatus: missingFields.length === 0 ? 'complete' : 'degraded',
    missingFields,
  };
}

export interface DocsRagLabSearchReport {
  readonly query: string;
  readonly limit: number;
  readonly mode: DocsRagSearchMode;
  readonly results: DocsRagLabSearchResult[];
}

interface DocsRagVectorCandidateRow {
  readonly chunkId: number | string;
  readonly vectorScore: number | string;
}

interface DocsRagExactDocumentCandidateRow {
  readonly documentId: number | string;
  readonly identifierLength: number | string;
}

interface DocsRagExactChunkCandidateRow {
  readonly chunkId: number | string;
}

export type DocsRagSearchMode = 'keyword' | 'vector' | 'hybrid';

export function resolveDocsRagSearchPlan(
  embeddingEnabled: boolean,
  mode?: DocsRagSearchMode
): { readonly useEmbedding: boolean; readonly includeLexicalCandidates: boolean } {
  const resolvedMode = mode ?? (embeddingEnabled ? 'hybrid' : 'keyword');
  if (resolvedMode !== 'keyword' && !embeddingEnabled) {
    throw new Error(`Docs RAG ${resolvedMode} search requires embeddings to be enabled`);
  }
  return {
    useEmbedding: resolvedMode !== 'keyword',
    includeLexicalCandidates: resolvedMode !== 'vector',
  };
}

export function resolveDocsRagCandidateLimit(limit: number, useEmbedding: boolean): number {
  return useEmbedding ? Math.max(50, limit * 10) : Math.max(200, limit * 50);
}

export function resolveDocsRagGlobalVectorCandidateLimit(limit: number): number {
  return Math.max(20, limit * 4);
}

export const DOCS_RAG_MAX_DUPLICATE_PATH_SHARE = 0.3;
export const DOCS_RAG_VECTOR_SCORE_WEIGHT = 12;
export const DOCS_RAG_TERM_HIT_WEIGHT = 0.25;
export const DOCS_RAG_EXACT_IDENTIFIER_WEIGHT = 4;
export const DOCS_RAG_EXACT_PATH_WEIGHT = 16;
export const DOCS_RAG_EXACT_TITLE_WEIGHT = 6;

export function resolveDocsRagResultCandidateLimit(limit: number): number {
  return Math.min(200, Math.max(limit, limit * 4));
}

const DOCS_RAG_IDENTIFIER_SPLIT_PATTERN = /[^\p{L}\p{N}_./-]+/u;
const DOCS_RAG_IDENTIFIER_STRUCTURE_PATTERN = /[a-z][A-Z]|[_./]/u;
const DOCS_RAG_IDENTIFIER_NORMALIZE_PATTERN = /[^a-z0-9]+/g;

function stripDocsRagDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '');
}

function extractDocsRagExactIdentifierTerms(query: string): string[] {
  const terms = query
    .split(DOCS_RAG_IDENTIFIER_SPLIT_PATTERN)
    .map(stripDocsRagDiacritics)
    .filter((term) => DOCS_RAG_IDENTIFIER_STRUCTURE_PATTERN.test(term))
    .map((term) => term.toLowerCase().replace(DOCS_RAG_IDENTIFIER_NORMALIZE_PATTERN, ''))
    .filter((term) => term.length >= 3);
  return [...new Set(terms)];
}

export function selectDocsRagDiverseResults<
  T extends { readonly sourceId: string; readonly sourcePath: string },
>(
  candidates: readonly T[],
  limit: number,
  maxDuplicatePathShare = DOCS_RAG_MAX_DUPLICATE_PATH_SHARE
): T[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const boundedShare = Math.max(0, Math.min(maxDuplicatePathShare, 1));
  const pending = [...candidates];
  const selected: T[] = [];
  const seenPaths = new Set<string>();
  let duplicatePathSlots = 0;

  while (pending.length > 0 && selected.length < boundedLimit) {
    const prospectiveRank = selected.length + 1;
    const first = pending[0];
    if (!first) {
      break;
    }
    const firstKey = `${first.sourceId}\u0000${first.sourcePath}`;
    const duplicateBudget = Math.floor(boundedShare * prospectiveRank);
    let selectedIndex = 0;

    if (seenPaths.has(firstKey) && duplicatePathSlots >= duplicateBudget) {
      selectedIndex = pending.findIndex(
        (candidate) => !seenPaths.has(`${candidate.sourceId}\u0000${candidate.sourcePath}`)
      );
      if (selectedIndex < 0) {
        break;
      }
    }

    const [candidate] = pending.splice(selectedIndex, 1);
    if (!candidate) {
      break;
    }
    const candidateKey = `${candidate.sourceId}\u0000${candidate.sourcePath}`;
    if (seenPaths.has(candidateKey)) {
      duplicatePathSlots += 1;
    } else {
      seenPaths.add(candidateKey);
    }
    selected.push(candidate);
  }

  return selected;
}

export interface DocsRagLabCategory {
  readonly name: string;
  readonly displayName: string;
  readonly docCount: number;
  readonly chunkCount: number;
}

export interface DocsRagLabDocument {
  readonly document: {
    readonly title: string;
    readonly sourcePath: string;
  };
  readonly chunks: Array<{
    readonly chunkIndex: number;
    readonly content: string;
  }>;
}

export function normalizeDocsRagStoredSourcePath(sourcePath: string): string {
  const normalizedPath = sourcePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//u, '');
  const normalizedLower = normalizedPath.toLowerCase();
  const artifactPrefix = DOCS_SOURCE_ARTIFACT_PREFIXES.find((prefix) =>
    normalizedLower.startsWith(prefix)
  );
  const relativePath = artifactPrefix
    ? normalizedPath.slice(artifactPrefix.length)
    : normalizedPath;
  const source = lookupDocsSourceByPath(relativePath);
  if (!source) {
    throw new Error(`Refusing unregistered Docs RAG source path: ${sourcePath}`);
  }
  const relativeLower = relativePath.toLowerCase();
  const matchedPrefix = source.pathPrefixes.find((prefix) => relativeLower.startsWith(prefix));
  if (!matchedPrefix) {
    throw new Error(`Refusing unregistered Docs RAG source path: ${sourcePath}`);
  }

  return `ingest/processed/external/${source.sourceId}/${relativePath.slice(matchedPrefix.length)}`;
}

interface DocsRagLabEmbeddingInput {
  readonly chunkId: number;
  /**
   * EXACT text sent to the embedding provider for this chunk. The bound is
   * applied here, once, at build time — never again inside the HTTP layer —
   * so this value is byte-identical to the provider input and is what gets
   * persisted alongside the vector.
   */
  readonly text: string;
  /** SHA-256 of `text` as persisted for verifiable parity. */
  readonly inputSha256: string;
  readonly sourceHash: string;
}

/**
 * Build the exact bounded embedding input for one chunk and its SHA-256.
 * Single source of truth for the bound: the returned text is both embedded
 * and persisted, so stored embeddings stay verifiable against their inputs.
 */
export function buildDocsRagEmbeddingInputForChunk(chunk: {
  readonly searchableText?: string | null;
  readonly content: string;
}): { readonly text: string; readonly sha256: string } {
  const raw = chunk.searchableText || chunk.content;
  const text =
    raw.length > DOCS_RAG_EMBEDDING_INPUT_MAX_CHARS
      ? raw.slice(0, DOCS_RAG_EMBEDDING_INPUT_MAX_CHARS)
      : raw;
  return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

function normalizeDisplayPath(path: string): string {
  return path.split('\\').join('/');
}

function collectFiles(path: string, files: string[], maxFiles: number): void {
  if (files.length >= maxFiles || !existsSync(path)) {
    return;
  }

  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    return;
  }
  if (stats.isFile()) {
    if (isSupportedDocsRagFile(path)) {
      files.push(path);
    }
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    collectFiles(resolve(path, entry.name), files, maxFiles);
    if (files.length >= maxFiles) {
      return;
    }
  }
}

function isSupportedDocsRagFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return false;
  }

  const name = basename(path).toLowerCase();
  if (name.startsWith('.')) {
    return false;
  }
  if (
    extension === '.json' &&
    /(?:missing-files|manifest|metadata|config|package|tsconfig)/u.test(name)
  ) {
    return false;
  }
  return true;
}

function canonicalFileKey(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.md' || extension === '.mdx') {
    return path.slice(0, -extension.length);
  }
  return path;
}

function dedupeDocsRagFiles(files: readonly string[]): string[] {
  const selected = new Map<string, string>();

  for (const file of files) {
    const key = canonicalFileKey(file);
    const current = selected.get(key);
    if (!current) {
      selected.set(key, file);
      continue;
    }

    const currentPriority = EXTENSION_PRIORITY.get(extname(current).toLowerCase()) ?? 0;
    const filePriority = EXTENSION_PRIORITY.get(extname(file).toLowerCase()) ?? 0;
    if (filePriority > currentPriority || (filePriority === currentPriority && file < current)) {
      selected.set(key, file);
    }
  }

  return [...selected.values()].sort();
}

export function collectDocsRagLabFiles(
  inputPaths: readonly string[],
  options: { readonly cwd?: string; readonly maxFiles?: number } = {}
): string[] {
  const cwd = options.cwd ?? process.cwd();
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files: string[] = [];
  for (const inputPath of inputPaths) {
    collectFiles(resolve(cwd, inputPath), files, maxFiles);
  }
  return dedupeDocsRagFiles(files);
}

function resolveDocsRagLabSource(sourcePath: string): {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly legacyKeys: Array<{ readonly sourceId: string; readonly sourcePath: string }>;
  readonly category?: string;
  readonly language?: string;
  readonly kind?: string;
  readonly authority?: string;
  readonly metadata: Record<string, unknown>;
} {
  const normalizedSourcePath = sourcePath.replace(/\\/g, '/').replace(/^\.\//u, '');
  if (
    !normalizedSourcePath.toLowerCase().startsWith('ingest/processed/external/') ||
    !isDocsSourceArtifactPath(normalizedSourcePath)
  ) {
    throw new Error(
      `Docs RAG accepts only external source artifacts under ingest/processed/external: ${sourcePath}`
    );
  }
  const registeredSource = lookupDocsSourceByPath(normalizedSourcePath);
  if (!registeredSource) {
    throw new Error(`Docs RAG source is not registered: ${sourcePath}`);
  }
  const parts = normalizedSourcePath.split('/');
  const externalIndex = parts.indexOf('external');
  const sourceIndex = externalIndex >= 0 && parts[externalIndex + 1] ? externalIndex + 1 : 0;
  const rawSourceId = parts[sourceIndex] ?? parts[0] ?? 'unknown';
  const metadata = normalizeDocsSourceMetadata({ sourceId: rawSourceId, sourcePath });
  const sourceId = metadata.sourceId ?? rawSourceId;
  const canonicalParts = [...parts];
  canonicalParts[sourceIndex] = sourceId;
  const canonicalSourcePath = canonicalParts.join('/');
  const legacyKeys =
    rawSourceId === sourceId && normalizedSourcePath === canonicalSourcePath
      ? []
      : [{ sourceId: rawSourceId, sourcePath: normalizedSourcePath }];

  return {
    sourceId,
    sourcePath: canonicalSourcePath,
    legacyKeys,
    category: metadata.category,
    language: metadata.language,
    kind: metadata.kind,
    authority: metadata.authority,
    metadata: {
      sourceId,
      category: metadata.category,
      language: metadata.language,
      kind: metadata.kind,
      authority: metadata.authority,
      tags: metadata.tags,
      lang: metadata.lang,
      ecosystem: metadata.ecosystem,
      lib: metadata.lib,
    },
  };
}

function parseFrontmatter(content: string): { body: string; metadata: Record<string, string> } {
  if (!content.startsWith('---\n')) {
    return { body: content, metadata: {} };
  }

  const end = content.indexOf('\n---', 4);
  if (end < 0) {
    return { body: content, metadata: {} };
  }

  const metadata: Record<string, string> = {};
  for (const line of content.slice(4, end).split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (match) {
      metadata[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }

  return { body: content.slice(end + 4).replace(/^\r?\n/u, ''), metadata };
}

/**
 * Frontmatter keys that may influence document fields at all. Everything
 * parsed from processed external content is UNTRUSTED data: only the display
 * title is allowed through, and even it never reaches governance identity.
 */
const TRUSTED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(['title']);

/**
 * Governance identity (sourceId/category/kind/language/authority/tags and the
 * rest of the registry payload) is derived exclusively from the registered
 * source registry. Frontmatter found inside retrieved content is untrusted:
 * injected keys such as `category: evil`, `authority: system`, or
 * instruction-like fields are dropped instead of merged into indexed metadata.
 */
export function mergeDocsRagUntrustedFrontmatterMetadata(
  registryMetadata: Record<string, unknown>,
  untrustedFrontmatter: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...registryMetadata };
  for (const [key, value] of Object.entries(untrustedFrontmatter)) {
    if (!TRUSTED_FRONTMATTER_KEYS.has(key)) {
      continue;
    }
    if (!(key in merged) || typeof merged[key] !== 'string' || merged[key] === '') {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Resolve a display-only title from untrusted content. Titles never influence
 * governance identity; control characters are collapsed so injected markup
 * cannot smuggle directives into indexed metadata.
 */
function resolveUntrustedDisplayTitle(
  frontmatterTitle: string | undefined,
  bodyHeading: string | undefined,
  fallback: string
): string {
  const candidate = frontmatterTitle?.trim() || bodyHeading?.trim() || fallback;
  // Collapse control-character runs so injected markup cannot smuggle
  // directives into indexed metadata.
  let collapsed = '';
  for (const char of candidate) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) {
      collapsed += char;
      continue;
    }
    if (!collapsed.endsWith(' ')) {
      collapsed += ' ';
    }
  }
  return collapsed.trim() || fallback;
}

function firstHeading(content: string): string | undefined {
  return /^#\s+(.+)$/mu.exec(content)?.[1]?.trim();
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseDocsRagEmbeddingResponse(data: unknown): number[][] {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Embedding provider response was not an object');
  }

  if ('embeddings' in data && Array.isArray(data.embeddings)) {
    return data.embeddings as number[][];
  }

  if ('data' in data && Array.isArray(data.data)) {
    return data.data.map((row) =>
      typeof row === 'object' && row !== null && 'embedding' in row
        ? ((row as { embedding?: unknown }).embedding as number[])
        : []
    );
  }

  if ('embedding' in data && Array.isArray(data.embedding)) {
    return [data.embedding as number[]];
  }

  throw new Error('Embedding provider response did not contain embeddings');
}

function formatDocsRagHalfvecLiteral(values: readonly number[], expectedDimensions = 1024): string {
  if (values.length !== expectedDimensions) {
    throw new Error(`Embedding has ${values.length} dimensions; expected ${expectedDimensions}`);
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error('Embedding contains a non-finite value');
    }
  }
  return `[${values.join(',')}]`;
}

function buildDocsRagQueryEmbeddingText(query: string): string {
  return [
    'Instruct: Given a developer documentation question, retrieve the most relevant',
    'Markdown sections, API references, configuration notes, file paths, symbols,',
    'and implementation details needed to answer accurately.',
    `Query: ${query}`,
  ].join('\n');
}

async function fetchDocsRagEmbeddings(
  config: DocsRagLabConfig,
  texts: readonly string[],
  signal?: AbortSignal
): Promise<number[][]> {
  const providerTimeout = AbortSignal.timeout(config.embedding.timeoutMs);
  const composedSignal = signal
    ? (await import('../../lib/shared/abort-utils.js')).composeAbortSignals(providerTimeout, signal)
    : providerTimeout;

  const response = await fetch(`${config.embedding.baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // texts arrive pre-bounded by buildDocsRagEmbeddingInputForChunk. No
    // truncation may happen here: the provider input must stay byte-identical
    // to the persisted embedding_input_text.
    body: JSON.stringify({
      model: config.embedding.model,
      input: [...texts],
    }),
    signal: composedSignal,
  });

  if (!response.ok) {
    throw new Error(`Embedding provider API error ${response.status}: ${await response.text()}`);
  }

  const embeddings = parseDocsRagEmbeddingResponse(await response.json());
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embedding provider returned ${embeddings.length} embeddings for ${texts.length} inputs`
    );
  }

  for (const embedding of embeddings) {
    formatDocsRagHalfvecLiteral(embedding, config.embedding.dimensions);
  }

  return embeddings;
}

async function fetchDocsRagEmbeddingsInBatches(
  config: DocsRagLabConfig,
  texts: readonly string[]
): Promise<number[][]> {
  const batchSize = Math.max(1, config.embedding.batchSize);
  const batches: Array<{ start: number; texts: readonly string[] }> = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    batches.push({ start, texts: texts.slice(start, start + batchSize) });
  }

  const results = new Array<number[]>(texts.length);
  let nextBatch = 0;
  const workerCount = Math.min(Math.max(1, config.embedding.maxConcurrentBatches), batches.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++];
        const embeddings = await fetchDocsRagEmbeddings(config, batch.texts);
        embeddings.forEach((embedding, index) => {
          results[batch.start + index] = embedding;
        });
      }
    })
  );
  return results;
}

async function insertDocsRagChunkEmbeddings(
  sql: Bun.SQL,
  config: DocsRagLabConfig,
  inputs: readonly DocsRagLabEmbeddingInput[],
  embeddings: readonly number[][]
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }

  // New chunk-kind embeddings always carry their EXACT provider input; an
  // unknown/empty provenance is a bug, not something to persist silently.
  for (const input of inputs) {
    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new Error('Refusing to store a Docs RAG chunk embedding without its exact input text');
    }
    if (typeof input.inputSha256 !== 'string' || input.inputSha256.length === 0) {
      throw new Error('Refusing to store a Docs RAG chunk embedding without its exact input hash');
    }
  }

  for (const [index, input] of inputs.entries()) {
    await sql`
      insert into docs_embeddings (
        chunk_id, embedding_kind, embedding_model, embedding_provider,
        embedding_dimensions, embedding, source_hash,
        embedding_input_text, embedding_input_sha256
      )
      values (
        ${input.chunkId}, 'chunk', ${config.embedding.model}, ${config.embedding.provider},
        ${config.embedding.dimensions}, ${formatDocsRagHalfvecLiteral(embeddings[index], config.embedding.dimensions)}::halfvec,
        ${input.sourceHash},
        ${input.text}, ${input.inputSha256}
      )
      on conflict (chunk_id, embedding_model) do update set
        embedding_provider = excluded.embedding_provider,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding = excluded.embedding,
        source_hash = excluded.source_hash,
        embedding_input_text = excluded.embedding_input_text,
        embedding_input_sha256 = excluded.embedding_input_sha256,
        updated_at = now()
    `;
  }
}

export async function buildDocsRagLabDocument(
  filePath: string,
  options: {
    readonly rootDir?: string;
    /** Canonical processing identity to stamp; defaults to the legacy marker. */
    readonly processingProfileHash?: string;
    readonly processingProfile?: DocsRagProcessingProfile | null;
  } = {}
): Promise<DocsRagLabDocumentInput> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const absolutePath = resolve(filePath);
  const physicalRootDir = realpathSync(rootDir);
  const physicalSourcePath = realpathSync(absolutePath);
  const displaySourcePath = normalizeDisplayPath(relative(physicalRootDir, physicalSourcePath));
  const source = resolveDocsRagLabSource(displaySourcePath);
  const raw = readFileSync(physicalSourcePath, 'utf8');
  const { body, metadata: untrustedFrontmatter } = parseFrontmatter(raw);
  const title = resolveUntrustedDisplayTitle(
    untrustedFrontmatter.title,
    firstHeading(body),
    basename(filePath)
  );
  // One canonical chunker for every Docs RAG ingestion surface. Chunk
  // boundaries depend only on text + explicit options; content is untrusted
  // data and never interpreted beyond producing chunk strings. When a
  // processing profile is supplied, its stamped size/overlap must be the
  // exact parameters the chunker runs with.
  const chunkConfig = options.processingProfile
    ? {
        chunkSize: options.processingProfile.chunkSize,
        chunkOverlap: options.processingProfile.chunkOverlap,
      }
    : resolveDocsRagChunkConfig();
  const canonicalChunks = await chunkDocsRagTextWithContext(
    body,
    {
      title,
      sourcePath: source.sourcePath,
    },
    {
      chunkSize: chunkConfig.chunkSize,
      chunkOverlap: chunkConfig.chunkOverlap,
      sourcePath: source.sourcePath,
    }
  );
  const chunks: DocsRagLabChunkInput[] = canonicalChunks.map((chunk, index) => ({
    chunkIndex: index,
    heading: chunk.heading,
    section: chunk.section,
    content: chunk.content,
    searchableText: chunk.searchableText,
  }));

  return {
    sourceId: source.sourceId,
    sourcePath: source.sourcePath,
    sourceAbsolutePath: physicalSourcePath,
    title,
    category: source.category ?? source.sourceId,
    kind: source.kind ?? (extname(filePath).replace(/^\./, '') || 'text'),
    language: source.language,
    authority: source.authority,
    canonicalUrl: null,
    contentHash: await sha256Hex(raw),
    upstreamPath: null,
    upstreamContentSha256: null,
    processedPath: displaySourcePath,
    processedContentSha256: await sha256Hex(body),
    processingProfileHash: options.processingProfileHash ?? DOCS_RAG_LEGACY_PROCESSING_PROFILE_HASH,
    processingProfile: options.processingProfile ?? null,
    searchableText: [title, source.sourcePath, body.slice(0, 2_000)].join('\n\n'),
    content: body,
    metadata: mergeDocsRagUntrustedFrontmatterMetadata(source.metadata, untrustedFrontmatter),
    legacyKeys: source.legacyKeys,
    chunks,
  };
}

/**
 * Canonicalize a document's absolute source path without requiring the final
 * entry to exist yet. The external-sync staging lifecycle commits to Postgres
 * BEFORE renaming the staged artifact into its canonical cache path, so a
 * first-time document legitimately has a missing final component. Symlink
 * strictness is preserved: existing targets resolve through realpath, and a
 * pending rename target must live inside a real (non-symlink) parent dir.
 */
function resolveCanonicalSourcePath(targetPath: string): string {
  const resolved = resolve(targetPath);
  if (existsSync(resolved)) {
    return realpathSync(resolved);
  }
  return join(realpathSync(dirname(resolved)), basename(resolved));
}

async function createSql(config: DocsRagLabConfig): Promise<Bun.SQL> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const connectionTimeoutSeconds = Math.max(1, Math.ceil(config.pool.connectionTimeoutMs / 1_000));
  const maxLifetimeSeconds =
    config.pool.maxLifetimeMs > 0 ? Math.ceil(config.pool.maxLifetimeMs / 1_000) : 0;
  return new Bun.SQL({
    url: config.database.url,
    max: config.pool.max,
    idleTimeout: 30,
    maxLifetime: maxLifetimeSeconds,
    connectionTimeout: connectionTimeoutSeconds,
    prepare: false,
  });
}

/**
 * Fail before embedding or writing when the provenance migration is absent or
 * incomplete. The query deliberately checks the migration-003 constraint as
 * well as its columns, so hand-added partial schemas cannot become implicit
 * authorities for new chunk embeddings.
 */
export async function assertDocsRagProcessingSchemaReady(sql: Bun.SQL): Promise<void> {
  const rows = (await sql`
    select (
      (
        select count(*) = 8
        from information_schema.columns
        where table_schema = current_schema()
          and (
            (table_name = 'docs_documents' and column_name in (
              'upstream_path', 'upstream_content_sha256', 'processed_path',
              'processed_content_sha256', 'processing_profile_hash', 'processing_profile'
            ))
            or (table_name = 'docs_embeddings' and column_name in (
              'embedding_input_text', 'embedding_input_sha256'
            ))
          )
      )
      and exists (
        select 1
        from pg_constraint
        where conrelid = to_regclass('docs_embeddings')
          and conname = 'docs_embeddings_chunk_input_provenance_check'
      )
    ) as ready
  `) as Array<{ readonly ready?: boolean }>;

  if (rows[0]?.ready !== true) {
    throw new Error(
      'Docs RAG processing provenance schema migration 003 is required before indexing. ' +
        `Run: ${DOCS_RAG_MIGRATION_COMMAND}`
    );
  }
}

/**
 * Generation publication is deliberately fail-closed. A database that has
 * only the pre-T12 document tables must not be treated as if its mutable rows
 * were a complete immutable source snapshot.
 */
export async function assertDocsRagGenerationSchemaReady(sql: Bun.SQL): Promise<void> {
  const rows = (await sql`
    select (
      exists (
        select 1 from information_schema.tables
        where table_schema = current_schema()
          and table_name = 'docs_source_generations'
      )
      and exists (
        select 1 from information_schema.tables
        where table_schema = current_schema()
          and table_name = 'docs_source_generation_pointers'
      )
      and exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'docs_documents'
          and column_name = 'generation_id'
      )
      and exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'docs_source_generations'
          and column_name = 'provenance_class'
      )
      and exists (
        select 1
        from pg_proc
        where pronamespace = to_regnamespace(current_schema())
          and proname = 'docs_rag_assert_generation_publishable'
      )
      and exists (
        select 1
        from pg_trigger
        where tgrelid = to_regclass('docs_source_generations')
          and tgname = 'docs_source_generations_publish_invariants'
      )
      and exists (
        select 1
        from pg_trigger
        where tgrelid = to_regclass('docs_source_generation_pointers')
          and tgname = 'docs_source_generation_pointers_validate_target'
      )
      and exists (
        select 1
        from pg_trigger
        where tgrelid = to_regclass('docs_documents')
          and tgname = 'docs_documents_validate_generation_source'
      )
    ) as ready
  `) as Array<{ readonly ready?: boolean }>;

  if (rows[0]?.ready !== true) {
    throw new Error(
      'Docs RAG immutable source-generation migrations 004 and 005 are required before indexing or reading.'
    );
  }
}

function mapDocsRagSourceGeneration(row: {
  readonly id: number | string;
  readonly sourceId: string;
  readonly provenanceClass: string | null;
  readonly generationKey: string;
  readonly upstreamRevision?: string | null;
  readonly upstreamPath?: string | null;
  readonly license?: string | null;
  readonly rawManifestSha256?: string | null;
  readonly processingProfileHash: string;
  readonly processingProfile?: DocsRagProcessingProfile | Record<string, unknown> | null;
  readonly scanState: DocsRagSourceGenerationScanState;
  readonly expectedDocumentCount: number | string;
  readonly indexedDocumentCount: number | string;
  readonly status: 'staging' | 'published' | 'retired';
  readonly publishedAt?: string | null;
}): DocsRagSourceGeneration {
  if (!isDocsRagProvenanceClass(row.provenanceClass)) {
    throw new Error(`Unknown Docs RAG provenance class: ${row.provenanceClass ?? '<null>'}`);
  }
  return {
    id: Number(row.id),
    sourceId: row.sourceId,
    provenanceClass: row.provenanceClass,
    generationKey: row.generationKey,
    upstreamRevision: row.upstreamRevision ?? null,
    upstreamPath: row.upstreamPath ?? null,
    license: row.license ?? null,
    rawManifestSha256: row.rawManifestSha256 ?? null,
    processingProfileHash: row.processingProfileHash,
    processingProfile:
      row.processingProfile && Object.keys(row.processingProfile).length > 0
        ? (row.processingProfile as DocsRagProcessingProfile)
        : null,
    scanState: row.scanState,
    expectedDocumentCount: Number(row.expectedDocumentCount),
    indexedDocumentCount: Number(row.indexedDocumentCount),
    status: row.status,
    publishedAt: row.publishedAt ?? null,
  };
}

type DocsRagSourceGenerationRow = Parameters<typeof mapDocsRagSourceGeneration>[0];

async function getDocsRagSourceGenerationWithSql(
  sql: Bun.SQL,
  generationId: number
): Promise<DocsRagSourceGeneration | null> {
  const rows = (await sql`
    select
      id,
      source_id as "sourceId",
      provenance_class as "provenanceClass",
      generation_key as "generationKey",
      upstream_revision as "upstreamRevision",
      upstream_path as "upstreamPath",
      license,
      raw_manifest_sha256 as "rawManifestSha256",
      processing_profile_hash as "processingProfileHash",
      processing_profile as "processingProfile",
      scan_state as "scanState",
      expected_document_count as "expectedDocumentCount",
      indexed_document_count as "indexedDocumentCount",
      status,
      published_at as "publishedAt"
    from docs_source_generations
    where id = ${generationId}
    limit 1
    for update
  `) as DocsRagSourceGenerationRow[];
  return rows[0] ? mapDocsRagSourceGeneration(rows[0]) : null;
}

async function ensureDocsRagSourceGenerationWithSql(
  sql: Bun.SQL,
  input: DocsRagSourceGenerationInput
): Promise<DocsRagSourceGeneration> {
  const sourceId = canonicalizeDocsSourceId(input.sourceId);
  if (!REGISTERED_SOURCE_IDS.includes(sourceId)) {
    throw new Error(`Refusing unregistered Docs RAG source generation: ${input.sourceId}`);
  }
  if (!input.generationKey.trim()) {
    throw new Error('Docs RAG source generation key is required');
  }
  if (!DOCS_RAG_PROVENANCE_CLASSES.includes(input.provenanceClass)) {
    throw new Error(`Unknown Docs RAG provenance class: ${input.provenanceClass}`);
  }
  if (!Number.isSafeInteger(input.expectedDocumentCount) || input.expectedDocumentCount < 0) {
    throw new Error(
      'Docs RAG source generation expectedDocumentCount must be a non-negative integer'
    );
  }
  const license = input.license?.trim() || 'NOASSERTION';

  return await sql.begin(async (tx) => {
    const txSql = tx as Bun.SQL;
    await acquireProjectRagWriteFence(tx);
    const existing = (await txSql`
      select
        id,
        source_id as "sourceId",
        provenance_class as "provenanceClass",
        generation_key as "generationKey",
        upstream_revision as "upstreamRevision",
        upstream_path as "upstreamPath",
        license,
        raw_manifest_sha256 as "rawManifestSha256",
        processing_profile_hash as "processingProfileHash",
        processing_profile as "processingProfile",
        scan_state as "scanState",
        expected_document_count as "expectedDocumentCount",
        indexed_document_count as "indexedDocumentCount",
        status,
        published_at as "publishedAt"
      from docs_source_generations
      where source_id = ${sourceId}
        and generation_key = ${input.generationKey}
      limit 1
      for update
    `) as DocsRagSourceGenerationRow[];
    const current = existing[0];
    if (current) {
      const generation = mapDocsRagSourceGeneration(current);
      if (generation.status === 'published') {
        return generation;
      }
      if (generation.status === 'retired') {
        throw new Error(
          `Docs RAG source generation ${generation.id} is retired and cannot be retried`
        );
      }
      if (generation.provenanceClass !== input.provenanceClass) {
        throw new Error(
          `Docs RAG source generation ${generation.id} provenance class cannot change on retry`
        );
      }
      await txSql`
        update docs_source_generations
        set provenance_class = ${input.provenanceClass},
            upstream_revision = ${input.upstreamRevision ?? null},
            upstream_path = ${input.upstreamPath ?? null},
            license = ${license},
            raw_manifest_sha256 = ${input.rawManifestSha256 ?? null},
            processing_profile_hash = ${input.processingProfileHash},
            processing_profile = ${input.processingProfile ? JSON.stringify(input.processingProfile) : '{}'}::jsonb,
            scan_state = ${input.scanState ?? 'pending'},
            expected_document_count = ${input.expectedDocumentCount},
            updated_at = now()
        where id = ${generation.id}
      `;
      const updated = await getDocsRagSourceGenerationWithSql(txSql, generation.id);
      if (!updated) {
        throw new Error(`Docs RAG source generation ${generation.id} disappeared during retry`);
      }
      return updated;
    }

    const rows = (await txSql`
      insert into docs_source_generations (
        source_id, provenance_class, generation_key, upstream_revision, upstream_path, license,
        raw_manifest_sha256, processing_profile_hash, processing_profile,
        scan_state, expected_document_count, indexed_document_count, status
      )
      values (
        ${sourceId}, ${input.provenanceClass}, ${input.generationKey}, ${input.upstreamRevision ?? null},
        ${input.upstreamPath ?? null}, ${license},
        ${input.rawManifestSha256 ?? null}, ${input.processingProfileHash},
        ${input.processingProfile ? JSON.stringify(input.processingProfile) : '{}'}::jsonb,
        ${input.scanState ?? 'pending'}, ${input.expectedDocumentCount}, 0, 'staging'
      )
      returning
        id,
        source_id as "sourceId",
        provenance_class as "provenanceClass",
        generation_key as "generationKey",
        upstream_revision as "upstreamRevision",
        upstream_path as "upstreamPath",
        license,
        raw_manifest_sha256 as "rawManifestSha256",
        processing_profile_hash as "processingProfileHash",
        processing_profile as "processingProfile",
        scan_state as "scanState",
        expected_document_count as "expectedDocumentCount",
        indexed_document_count as "indexedDocumentCount",
        status,
        published_at as "publishedAt"
    `) as DocsRagSourceGenerationRow[];
    const inserted = rows[0];
    if (!inserted) {
      throw new Error('Docs RAG source generation insert returned no row');
    }
    return mapDocsRagSourceGeneration(inserted);
  });
}

export async function createDocsRagSourceGeneration(
  config: DocsRagLabConfig,
  input: DocsRagSourceGenerationInput
): Promise<DocsRagSourceGeneration> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    return await ensureDocsRagSourceGenerationWithSql(sql, input);
  } finally {
    await sql.close({ timeout: 5 });
  }
}

async function setDocsRagSourceGenerationScanStateWithSql(
  sql: Bun.SQL,
  input: {
    readonly generationId: number;
    readonly scanState: DocsRagSourceGenerationScanState;
  }
): Promise<DocsRagSourceGeneration> {
  return await sql.begin(async (tx) => {
    const txSql = tx as Bun.SQL;
    await acquireProjectRagWriteFence(tx);
    const generation = await getDocsRagSourceGenerationWithSql(txSql, input.generationId);
    if (!generation) {
      throw new Error(`Docs RAG source generation ${input.generationId} was not found`);
    }
    if (generation.status === 'published') {
      if (input.scanState !== 'complete') {
        throw new Error(`Published Docs RAG source generation ${input.generationId} is immutable`);
      }
      return generation;
    }
    if (generation.status === 'retired') {
      throw new Error(`Retired Docs RAG source generation ${input.generationId} is immutable`);
    }
    await txSql`
      update docs_source_generations
      set scan_state = ${input.scanState},
          indexed_document_count = (
            select count(*)::integer
            from docs_documents
            where generation_id = ${input.generationId}
              and status = 'indexed'
          ),
          updated_at = now()
      where id = ${input.generationId}
        and status = 'staging'
    `;
    const updated = await getDocsRagSourceGenerationWithSql(txSql, input.generationId);
    if (!updated) {
      throw new Error(
        `Docs RAG source generation ${input.generationId} disappeared after scan finalization`
      );
    }
    return updated;
  });
}

export async function finalizeDocsRagSourceGeneration(
  config: DocsRagLabConfig,
  input: { readonly generationId: number; readonly scanState: DocsRagSourceGenerationScanState }
): Promise<DocsRagSourceGeneration> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    return await setDocsRagSourceGenerationScanStateWithSql(sql, input);
  } finally {
    await sql.close({ timeout: 5 });
  }
}

async function publishDocsRagSourceGenerationWithSql(
  sql: Bun.SQL,
  generationId: number
): Promise<DocsRagSourceGenerationPublishReport> {
  return await sql.begin(async (tx) => {
    const txSql = tx as Bun.SQL;
    await acquireProjectRagWriteFence(tx);
    const generation = await getDocsRagSourceGenerationWithSql(txSql, generationId);
    if (!generation) {
      throw new Error(`Docs RAG source generation ${generationId} was not found`);
    }
    if (generation.status === 'published') {
      return { generation, published: false };
    }
    if (generation.status !== 'staging') {
      throw new Error(`Docs RAG source generation ${generationId} is immutable`);
    }
    if (generation.scanState !== 'complete') {
      throw new Error(
        `Docs RAG source generation ${generationId} cannot publish with scan state '${generation.scanState}'`
      );
    }
    const rows = (await txSql`
      select count(*)::integer as count
      from docs_documents
      where generation_id = ${generationId}
        and status = 'indexed'
    `) as Array<{ readonly count: number | string }>;
    const indexedDocumentCount = Number(rows[0]?.count ?? 0);
    if (indexedDocumentCount !== generation.expectedDocumentCount) {
      throw new Error(
        `Docs RAG source generation ${generationId} expected ${generation.expectedDocumentCount} documents but staged ${indexedDocumentCount}`
      );
    }
    // Serialize publication and retention for one source. This keeps a
    // superseded generation from being retired while its pointer is moving.
    await txSql`
      select pg_advisory_xact_lock(hashtextextended(${generation.sourceId}, 0::bigint))
    `;
    await txSql`
      update docs_source_generations
      set indexed_document_count = ${indexedDocumentCount},
          published_at = now(),
          updated_at = now(),
          status = 'published'
      where id = ${generationId}
        and status = 'staging'
    `;
    await txSql`
      insert into docs_source_generation_pointers (source_id, generation_id, updated_at)
      values (${generation.sourceId}, ${generationId}, now())
      on conflict (source_id) do update set
        generation_id = excluded.generation_id,
        updated_at = now()
    `;
    const published = await getDocsRagSourceGenerationWithSql(txSql, generationId);
    if (!published) {
      throw new Error(`Docs RAG source generation ${generationId} disappeared after publication`);
    }
    return { generation: published, published: true };
  });
}

export async function publishDocsRagSourceGeneration(
  config: DocsRagLabConfig,
  input: { readonly generationId: number }
): Promise<DocsRagSourceGenerationPublishReport> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    return await publishDocsRagSourceGenerationWithSql(sql, input.generationId);
  } finally {
    await sql.close({ timeout: 5 });
  }
}

async function upsertDocsRagLabDocumentWithSql(
  sql: Bun.SQL,
  config: DocsRagLabConfig,
  document: DocsRagLabDocumentInput,
  options: { readonly generationId: number }
): Promise<DocsRagLabUpsertReport> {
  let documentId = 0;
  let embeddedChunks = 0;
  await assertDocsRagProcessingSchemaReady(sql);
  await assertDocsRagGenerationSchemaReady(sql);
  const generation = await getDocsRagSourceGenerationWithSql(sql, options.generationId);
  if (!generation) {
    throw new Error(`Docs RAG source generation ${options.generationId} was not found`);
  }
  if (generation.status !== 'staging') {
    throw new Error(`Docs RAG source generation ${options.generationId} is immutable`);
  }
  if (generation.sourceId !== document.sourceId) {
    throw new Error(
      `Docs RAG document source '${document.sourceId}' does not match generation source '${generation.sourceId}'`
    );
  }
  // The exact bounded embedding inputs are built ONCE, before any fetch, and
  // are the only texts sent to the provider; the same values (text + sha256)
  // are persisted with each vector for verifiable parity.
  const preparedInputs = config.gates.embeddingEnabled
    ? document.chunks.map((chunk) => {
        const { text, sha256 } = buildDocsRagEmbeddingInputForChunk(chunk);
        return { chunk, text, sha256 };
      })
    : [];
  const preparedEmbeddings = config.gates.embeddingEnabled
    ? await fetchDocsRagEmbeddingsInBatches(
        config,
        preparedInputs.map((input) => input.text)
      )
    : [];
  await sql.begin(async (tx) => {
    const txSql = tx as Bun.SQL;
    await acquireProjectRagWriteFence(tx);
    const currentGeneration = await getDocsRagSourceGenerationWithSql(txSql, options.generationId);
    if (!currentGeneration) {
      throw new Error(`Docs RAG source generation ${options.generationId} was not found`);
    }
    if (currentGeneration.status !== 'staging') {
      throw new Error(`Docs RAG source generation ${options.generationId} is immutable`);
    }
    if (currentGeneration.sourceId !== document.sourceId) {
      throw new Error(
        `Docs RAG document source '${document.sourceId}' does not match generation source '${currentGeneration.sourceId}'`
      );
    }
    for (const legacyKey of document.legacyKeys) {
      await txSql`
        delete from docs_documents
        where source_id = ${legacyKey.sourceId}
          and source_path = ${legacyKey.sourcePath}
          and generation_id is null
      `;
    }
    // A canonical path can also have been written by a pre-generation writer.
    // Retire only that legacy row; generation-bound documents (including the
    // current staged row on retries) remain untouched. The delete is inside
    // this transaction so any later embedding failure restores the legacy
    // document and its cascaded chunks/embeddings on rollback.
    await txSql`
      delete from docs_documents
      where source_id = ${document.sourceId}
        and source_path = ${document.sourcePath}
        and generation_id is null
    `;
    const rows = (await txSql`
      insert into docs_documents (
        source_id, source_path, source_absolute_path, title, category, kind,
        language, authority, canonical_url, content_hash, searchable_text, content, metadata, status,
        upstream_path, upstream_content_sha256, processed_path, processed_content_sha256,
        processing_profile_hash, processing_profile, generation_id
      )
      values (
        ${document.sourceId}, ${document.sourcePath}, ${document.sourceAbsolutePath},
        ${document.title}, ${document.category ?? null}, ${document.kind ?? null},
        ${document.language ?? null}, ${document.authority ?? null}, ${document.canonicalUrl},
        ${document.contentHash},
        ${document.searchableText}, ${document.content}, ${JSON.stringify(document.metadata)}::jsonb,
        'indexed',
        ${document.upstreamPath ?? null},
        ${document.upstreamContentSha256 ?? null},
        ${document.processedPath ?? null},
        ${document.processedContentSha256 ?? null},
        ${document.processingProfileHash || DOCS_RAG_LEGACY_PROCESSING_PROFILE_HASH},
        ${document.processingProfile ? JSON.stringify(document.processingProfile) : '{}'}::jsonb,
        ${options.generationId}
      )
      on conflict (generation_id, source_id, source_path) do update set
        source_absolute_path = excluded.source_absolute_path,
        title = excluded.title,
        category = excluded.category,
        kind = excluded.kind,
        language = excluded.language,
        authority = excluded.authority,
        canonical_url = excluded.canonical_url,
        content_hash = excluded.content_hash,
        searchable_text = excluded.searchable_text,
        content = excluded.content,
        metadata = excluded.metadata,
        status = 'indexed',
        upstream_path = excluded.upstream_path,
        upstream_content_sha256 = excluded.upstream_content_sha256,
        processed_path = excluded.processed_path,
        processed_content_sha256 = excluded.processed_content_sha256,
        processing_profile_hash = excluded.processing_profile_hash,
        processing_profile = excluded.processing_profile,
        updated_at = now()
      returning id
    `) as Array<{ id: number | string }>;
    documentId = Number(rows[0]?.id);
    await txSql`delete from docs_chunks where document_id = ${documentId}`;
    const embeddingInputs: DocsRagLabEmbeddingInput[] = [];
    for (const chunk of document.chunks) {
      const chunkRows = (await txSql`
        insert into docs_chunks (
          document_id, chunk_index, heading, section, content, searchable_text, enabled
        )
        values (
          ${documentId}, ${chunk.chunkIndex}, ${chunk.heading ?? null}, ${chunk.section ?? null},
          ${chunk.content}, ${chunk.searchableText}, true
        )
        returning id
      `) as Array<{ id: number | string }>;

      if (config.gates.embeddingEnabled) {
        const prepared = preparedInputs[embeddingInputs.length];
        if (!prepared || prepared.chunk !== chunk) {
          throw new Error(
            `Docs RAG embedding inputs desynchronized for chunk ${chunk.chunkIndex} of ${document.sourcePath}`
          );
        }
        embeddingInputs.push({
          chunkId: Number(chunkRows[0]?.id),
          text: prepared.text,
          inputSha256: prepared.sha256,
          sourceHash: await sha256Hex(
            `${document.contentHash}:${chunk.chunkIndex}:${chunk.content}`
          ),
        });
      }
    }
    if (config.gates.embeddingEnabled) {
      await insertDocsRagChunkEmbeddings(txSql, config, embeddingInputs, preparedEmbeddings);
      embeddedChunks = embeddingInputs.length;
    }
  });

  return {
    status: 'completed',
    documentId,
    indexedChunks: document.chunks.length,
    embeddedChunks,
  };
}

export async function upsertDocsRagLabDocument(
  config: DocsRagLabConfig,
  document: DocsRagLabDocumentInput,
  options: DocsRagLabUpsertOptions
): Promise<DocsRagLabUpsertReport> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const relativeAbsolutePath = normalizeDisplayPath(
    relative(
      realpathSync(resolve(config.rootDir)),
      resolveCanonicalSourcePath(document.sourceAbsolutePath)
    )
  );
  const storedSource = lookupDocsSourceByPath(document.sourcePath);
  const absoluteSource = lookupDocsSourceByPath(relativeAbsolutePath);
  const canonicalSourceId = canonicalizeDocsSourceId(document.sourceId);
  if (
    !document.sourcePath.toLowerCase().startsWith('ingest/processed/external/') ||
    !relativeAbsolutePath.toLowerCase().startsWith('ingest/processed/external/') ||
    !isDocsSourceArtifactPath(document.sourcePath) ||
    !isDocsSourceArtifactPath(relativeAbsolutePath) ||
    document.sourceId !== canonicalSourceId ||
    storedSource?.sourceId !== canonicalSourceId ||
    absoluteSource?.sourceId !== canonicalSourceId ||
    !REGISTERED_SOURCE_IDS.includes(canonicalSourceId)
  ) {
    throw new Error(`Refusing invalid Docs RAG document source: ${document.sourcePath}`);
  }
  if (!options || !Number.isSafeInteger(options.generationId) || options.generationId < 1) {
    throw new Error('Docs RAG document upsert requires a valid staging generationId');
  }
  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    return await upsertDocsRagLabDocumentWithSql(sql, config, document, options);
  } finally {
    await sql.close({ timeout: 5 });
  }
}

export async function inspectDocsRagLabDocumentProcessing(
  config: DocsRagLabConfig,
  input: {
    readonly sourceId: string;
    readonly sourcePath: string;
    readonly contentHash: string;
    /** Current processing identity; mismatch with stored rows forces reprocessing. */
    readonly processingProfileHash?: string | null;
    /** Optional staging generation used by immutable source publication. */
    readonly generationId?: number;
  }
): Promise<DocsRagLabDocumentProcessingDecision> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const sql = await createSql(config);
  try {
    await assertDocsRagProcessingSchemaReady(sql);
    await assertDocsRagGenerationSchemaReady(sql);
    const rows = (await sql`
      select
        d.content_hash as "contentHash",
        d.processing_profile_hash as "processingProfileHash",
        d.processed_content_sha256 as "processedContentSha256",
        count(distinct c.id) filter (where c.enabled)::int as "enabledChunkCount",
        count(distinct e.id) filter (
          where c.enabled
            and e.embedding_kind = 'chunk'
            and e.embedding_model = ${config.embedding.model}
            and e.embedding_dimensions = ${config.embedding.dimensions}
        )::int as "currentEmbeddingCount"
      from docs_documents d
      left join docs_chunks c on c.document_id = d.id
      left join docs_embeddings e on e.chunk_id = c.id
      left join docs_source_generation_pointers current_generation
        on current_generation.source_id = d.source_id
      where d.source_id = ${input.sourceId}
        and d.source_path = ${input.sourcePath}
        and (
          (${input.generationId !== undefined}::boolean and d.generation_id = ${input.generationId ?? null})
          or (
            ${input.generationId === undefined}::boolean
            and (
              d.generation_id = current_generation.generation_id
              or d.generation_id is null
            )
          )
        )
      group by d.id, d.content_hash, d.processing_profile_hash, d.processed_content_sha256,
        current_generation.generation_id
      order by
        (d.generation_id = current_generation.generation_id) desc nulls last,
        d.generation_id desc nulls last,
        d.id desc
      limit 1
    `) as DocsRagLabDocumentProcessingState[];
    return docsRagLabDocumentProcessingDecision(rows[0], input.contentHash, {
      embeddingEnabled: config.gates.embeddingEnabled,
      processingProfileHash: input.processingProfileHash ?? null,
    });
  } finally {
    await sql.close({ timeout: 5 });
  }
}

export async function docsRagLabDocumentNeedsProcessing(
  config: DocsRagLabConfig,
  input: {
    readonly sourceId: string;
    readonly sourcePath: string;
    readonly contentHash: string;
    readonly processingProfileHash?: string | null;
    readonly generationId?: number;
  }
): Promise<boolean> {
  return (await inspectDocsRagLabDocumentProcessing(config, input)).needsProcessing;
}

export interface DocsRagLabDocumentProcessingState {
  readonly contentHash?: string | null;
  /** Stored processing identity; legacy rows report the legacy marker. */
  readonly processingProfileHash?: string | null;
  /** SHA-256 of the processed body this row was built from, when known. */
  readonly processedContentSha256?: string | null;
  readonly enabledChunkCount: number;
  readonly currentEmbeddingCount: number;
}

export interface DocsRagLabDocumentProcessingDecision {
  readonly needsProcessing: boolean;
  readonly contentChanged: boolean;
  readonly indexRepairNeeded: boolean;
  /**
   * Stored SHA-256 of the processed body this document was indexed from.
   * Null when the row (or its absence) cannot prove one; callers use it for
   * DB/cache hash parity before trusting a cached artifact.
   */
  readonly processedContentSha256: string | null;
}

export function docsRagLabDocumentProcessingDecision(
  state: DocsRagLabDocumentProcessingState | undefined,
  contentHash: string,
  options: {
    readonly embeddingEnabled: boolean;
    /** Expected current processing identity; absent disables profile comparison. */
    readonly processingProfileHash?: string | null;
  }
): DocsRagLabDocumentProcessingDecision {
  const expectedProfileHash = options.processingProfileHash ?? null;
  const profileChanged =
    expectedProfileHash !== null &&
    (!state ||
      (state.processingProfileHash ?? DOCS_RAG_LEGACY_PROCESSING_PROFILE_HASH) !==
        expectedProfileHash);
  const contentChanged = !state || state.contentHash !== contentHash || profileChanged;
  const missingChunks = !state || state.enabledChunkCount < 1;
  const missingCurrentEmbeddings =
    options.embeddingEnabled &&
    state !== undefined &&
    state.currentEmbeddingCount < state.enabledChunkCount;
  const indexRepairNeeded = !contentChanged && (missingChunks || missingCurrentEmbeddings);
  return {
    needsProcessing: contentChanged || indexRepairNeeded,
    contentChanged,
    indexRepairNeeded,
    processedContentSha256: state?.processedContentSha256 ?? null,
  };
}

export function docsRagLabDocumentStateNeedsProcessing(
  state: DocsRagLabDocumentProcessingState | undefined,
  contentHash: string,
  options: { readonly embeddingEnabled: boolean; readonly processingProfileHash?: string | null }
): boolean {
  return docsRagLabDocumentProcessingDecision(state, contentHash, options).needsProcessing;
}

export async function deleteStaleDocsRagLabDocuments(
  config: DocsRagLabConfig,
  input: {
    readonly sourceId: string;
    readonly currentSourcePaths: readonly string[];
    readonly allowDeleteAll?: boolean;
  }
): Promise<DocsRagLabStaleDeleteReport> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const currentSourcePaths = [...new Set(input.currentSourcePaths)].sort();
  if (currentSourcePaths.length === 0 && !input.allowDeleteAll) {
    throw new Error('Refusing full source cleanup without allowDeleteAll=true');
  }
  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    return await sql.begin(async (tx) => {
      const txSql = tx as Bun.SQL;
      await acquireProjectRagWriteFence(tx);
      const docs =
        currentSourcePaths.length === 0
          ? ((await txSql`
            select id
            from docs_documents
            where source_id = ${input.sourceId}
              and generation_id is null
          `) as Array<{ id: number | string }>)
          : ((await txSql`
            select id
            from docs_documents
            where source_id = ${input.sourceId}
              and generation_id is null
              and source_path not in ${txSql(currentSourcePaths)}
          `) as Array<{ id: number | string }>);
      if (docs.length === 0) {
        return { deletedDocs: 0, deletedChunks: 0 };
      }
      const documentIds = docs.map((doc) => Number(doc.id));
      const chunkRows = (await txSql`
        select count(*)::int as count
        from docs_chunks
        where document_id in ${txSql(documentIds)}
      `) as Array<{ count: number | string }>;
      await txSql`
        delete from docs_documents
        where id in ${txSql(documentIds)}
      `;
      return {
        deletedDocs: documentIds.length,
        deletedChunks: Number(chunkRows[0]?.count ?? 0),
      };
    });
  } finally {
    await sql.close({ timeout: 5 });
  }
}

/**
 * Retain a bounded number of superseded published generations per source and
 * garbage-collect older snapshots. Active pointers and sealed legacy upgrade
 * exemptions are excluded; protected history does not consume the retention quota.
 */
export async function gcDocsRagSourceGenerations(
  config: DocsRagLabConfig,
  input: {
    readonly sourceId?: string | null;
    readonly keepSupersededPerSource?: number;
  } = {}
): Promise<DocsRagSourceGenerationGcReport> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const sourceId =
    input.sourceId === undefined || input.sourceId === null
      ? null
      : canonicalizeDocsSourceId(input.sourceId);
  if (sourceId !== null && !REGISTERED_SOURCE_IDS.includes(sourceId)) {
    throw new Error(`Refusing unregistered Docs RAG source generation cleanup: ${input.sourceId}`);
  }
  const keepSupersededPerSource =
    input.keepSupersededPerSource ?? DEFAULT_KEEP_SUPERSEDED_GENERATIONS;
  if (
    !Number.isSafeInteger(keepSupersededPerSource) ||
    keepSupersededPerSource < 0 ||
    keepSupersededPerSource > MAX_KEEP_SUPERSEDED_GENERATIONS
  ) {
    throw new Error(
      `keepSupersededPerSource must be an integer from 0 to ${MAX_KEEP_SUPERSEDED_GENERATIONS}`
    );
  }

  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    return await sql.begin(async (tx) => {
      const txSql = tx as Bun.SQL;
      await acquireProjectRagWriteFence(tx);
      const sourceRows = sourceId
        ? [{ sourceId }]
        : ((await txSql`
            select distinct source_id as "sourceId"
            from docs_source_generations
            where status = 'published'
            order by source_id
          `) as Array<{ readonly sourceId: string }>);
      for (const source of sourceRows) {
        await txSql`
          select pg_advisory_xact_lock(hashtextextended(${source.sourceId}, 0::bigint))
        `;
      }

      const candidates = sourceId
        ? ((await txSql`
            with ranked as (
              select
                g.id,
                g.source_id as "sourceId",
                row_number() over (
                  partition by g.source_id
                  order by g.published_at desc nulls last, g.id desc
                ) - 1 as superseded_rank
              from docs_source_generations g
              where g.source_id = ${sourceId}
                and g.status = 'published'
                and not exists (
                  select 1 from docs_rag_legacy_generation_exemptions e
                  where e.generation_id = g.id
                )
                and not exists (
                  select 1
                  from docs_source_generation_pointers p
                  where p.source_id = g.source_id
                    and p.generation_id = g.id
                )
            )
            select id, "sourceId"
            from ranked
            where superseded_rank >= ${keepSupersededPerSource}
          `) as Array<{ readonly id: number | string; readonly sourceId: string }>)
        : ((await txSql`
            with ranked as (
              select
                g.id,
                g.source_id as "sourceId",
                row_number() over (
                  partition by g.source_id
                  order by g.published_at desc nulls last, g.id desc
                ) - 1 as superseded_rank
              from docs_source_generations g
              where g.status = 'published'
                and not exists (
                  select 1 from docs_rag_legacy_generation_exemptions e
                  where e.generation_id = g.id
                )
                and not exists (
                  select 1
                  from docs_source_generation_pointers p
                  where p.source_id = g.source_id
                    and p.generation_id = g.id
                )
            )
            select id, "sourceId"
            from ranked
            where superseded_rank >= ${keepSupersededPerSource}
          `) as Array<{ readonly id: number | string; readonly sourceId: string }>);
      const candidateIds = candidates.map((candidate) => Number(candidate.id));
      if (candidateIds.length === 0) {
        return {
          sourceId,
          keepSupersededPerSource,
          deletedGenerations: 0,
          deletedDocuments: 0,
          deletedChunks: 0,
        };
      }

      const retiredRows = (await txSql`
        update docs_source_generations g
        set status = 'retired', updated_at = now()
        where g.id in ${txSql(candidateIds)}
          and g.status = 'published'
          and not exists (
            select 1 from docs_rag_legacy_generation_exemptions e
            where e.generation_id = g.id
          )
          and not exists (
            select 1
            from docs_source_generation_pointers p
            where p.source_id = g.source_id
              and p.generation_id = g.id
          )
        returning g.id
      `) as Array<{ readonly id: number | string }>;
      const retiredIds = retiredRows.map((row) => Number(row.id));
      if (retiredIds.length === 0) {
        return {
          sourceId,
          keepSupersededPerSource,
          deletedGenerations: 0,
          deletedDocuments: 0,
          deletedChunks: 0,
        };
      }

      const counts = (await txSql`
        select
          count(distinct d.id)::integer as "documentCount",
          count(c.id)::integer as "chunkCount"
        from docs_documents d
        left join docs_chunks c on c.document_id = d.id
        where d.generation_id in ${txSql(retiredIds)}
      `) as Array<{
        readonly documentCount: number | string;
        readonly chunkCount: number | string;
      }>;
      const deletedRows = (await txSql`
        delete from docs_source_generations g
        where g.id in ${txSql(retiredIds)}
          and g.status = 'retired'
          and not exists (
            select 1 from docs_rag_legacy_generation_exemptions e
            where e.generation_id = g.id
          )
          and not exists (
            select 1
            from docs_source_generation_pointers p
            where p.source_id = g.source_id
              and p.generation_id = g.id
          )
        returning g.id
      `) as Array<{ readonly id: number | string }>;
      return {
        sourceId,
        keepSupersededPerSource,
        deletedGenerations: deletedRows.length,
        deletedDocuments: Number(counts[0]?.documentCount ?? 0),
        deletedChunks: Number(counts[0]?.chunkCount ?? 0),
      };
    });
  } finally {
    await sql.close({ timeout: 5 });
  }
}

export async function ingestDocsRagLabCorpus(
  config: DocsRagLabConfig,
  inputPaths: readonly string[],
  options: { readonly maxFiles?: number; readonly batchSize?: number } = {}
): Promise<DocsRagLabIngestReport> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }

  const paths = inputPaths.length > 0 ? inputPaths : ['ingest/processed/external'];
  const files = collectDocsRagLabFiles(paths, {
    cwd: config.rootDir,
    maxFiles: options.maxFiles,
  });
  // Direct corpus ingest reads already-processed artifacts as-is; its truthful
  // pipeline components are all 'none' while embedding/chunking identity stays
  // canonical so profile invalidation works across surfaces. Chunk parameters
  // must match external sync, including CHUNK_SIZE/CHUNK_OVERLAP overrides.
  const chunkConfig = resolveDocsRagChunkConfig();
  const { profile, profileHash } = resolveDocsRagCanonicalProcessingProfile(config, {
    cleaner: 'none',
    refiner: 'none',
    redaction: 'none',
    normalization: 'none',
    chunkSize: chunkConfig.chunkSize,
    chunkOverlap: chunkConfig.chunkOverlap,
  });
  let indexedDocuments = 0;
  let indexedChunks = 0;
  let skippedFiles = 0;
  const failedFiles: DocsRagLabIngestReport['failedFiles'] = [];

  const documentsBySource = new Map<string, DocsRagLabDocumentInput[]>();
  const failedSources = new Set<string>();
  for (const file of files) {
    const relativePath = normalizeDisplayPath(relative(config.rootDir, file));
    const sourceSegment = relativePath.split('/')[3] ?? relativePath.split('/')[0] ?? '';
    const sourceId = canonicalizeDocsSourceId(sourceSegment);
    try {
      const document = await buildDocsRagLabDocument(file, {
        rootDir: config.rootDir,
        processingProfileHash: profileHash,
        processingProfile: profile,
      });
      if (document.chunks.length === 0) {
        skippedFiles += 1;
        failedSources.add(document.sourceId);
        continue;
      }
      const documents = documentsBySource.get(document.sourceId) ?? [];
      documents.push(document);
      documentsBySource.set(document.sourceId, documents);
    } catch (error) {
      failedSources.add(sourceId);
      failedFiles.push({
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [sourceId, documents] of documentsBySource) {
    if (failedSources.has(sourceId)) {
      continue;
    }
    const manifest = createHash('sha256');
    for (const document of [...documents].sort((left, right) =>
      left.sourcePath < right.sourcePath ? -1 : left.sourcePath > right.sourcePath ? 1 : 0
    )) {
      manifest.update(`${document.sourcePath}\0${document.contentHash}\0`, 'utf8');
    }
    const rawManifestSha256 = manifest.digest('hex');
    const generation = await createDocsRagSourceGeneration(config, {
      sourceId,
      provenanceClass: 'processed_external_import',
      generationKey: buildDocsRagSourceGenerationKey({
        sourceId,
        rawManifestSha256,
        processingProfileHash: profileHash,
      }),
      rawManifestSha256,
      processingProfileHash: profileHash,
      processingProfile: profile,
      expectedDocumentCount: documents.length,
      scanState: 'pending',
    });
    if (generation.status === 'published') {
      indexedDocuments += documents.length;
      indexedChunks += documents.reduce((total, document) => total + document.chunks.length, 0);
      await gcDocsRagSourceGenerations(config, { sourceId });
      continue;
    }
    let sourceFailed = false;
    for (const document of documents) {
      try {
        const report = await upsertDocsRagLabDocument(config, document, {
          generationId: generation.id,
        });
        indexedDocuments += 1;
        indexedChunks += report.indexedChunks;
      } catch (error) {
        sourceFailed = true;
        failedFiles.push({
          path: document.sourcePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (sourceFailed) {
      await finalizeDocsRagSourceGeneration(config, {
        generationId: generation.id,
        scanState: 'incomplete',
      });
      continue;
    }
    await finalizeDocsRagSourceGeneration(config, {
      generationId: generation.id,
      scanState: 'complete',
    });
    await publishDocsRagSourceGeneration(config, { generationId: generation.id });
    await gcDocsRagSourceGenerations(config, { sourceId });
  }

  return {
    status: 'completed',
    inputPaths: [...paths],
    scannedFiles: files.length,
    indexedDocuments,
    indexedChunks,
    skippedFiles: skippedFiles + failedFiles.length,
    failedFiles,
  };
}

export async function searchDocsRagLab(
  config: DocsRagLabConfig,
  query: string,
  options: {
    readonly limit?: number;
    readonly sourceId?: string;
    readonly sourceIds?: readonly string[];
    readonly mode?: DocsRagSearchMode;
    readonly signal?: AbortSignal;
    readonly statementTimeoutMs?: number;
  } = {}
): Promise<DocsRagLabSearchReport> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error('Search query is required.');
  }

  const limit = Math.max(1, Math.min(options.limit ?? config.evalTopK, 50));
  const requestedSourceIds = options.sourceIds ?? (options.sourceId ? [options.sourceId] : []);
  const sourceIds = [...new Set(requestedSourceIds.map(canonicalizeDocsSourceId))];
  const sqlSourceIds = sourceIds.length > 0 ? sourceIds : REGISTERED_SOURCE_IDS;
  const allRegisteredSources = sourceIds.length === 0;
  const mode = options.mode ?? (config.gates.embeddingEnabled ? 'hybrid' : 'keyword');
  const searchPlan = resolveDocsRagSearchPlan(config.gates.embeddingEnabled, mode);
  const candidateLimit = resolveDocsRagCandidateLimit(limit, searchPlan.useEmbedding);
  const globalVectorCandidateLimit = resolveDocsRagGlobalVectorCandidateLimit(limit);
  const resultCandidateLimit = resolveDocsRagResultCandidateLimit(limit);
  const exactIdentifierTerms = extractDocsRagExactIdentifierTerms(normalizedQuery);
  const serializedExactIdentifierTerms = JSON.stringify(exactIdentifierTerms);
  const statementTimeoutMs =
    options.statementTimeoutMs ??
    parsePositiveInteger(process.env.DOCS_RAG_PG_LAB_STATEMENT_TIMEOUT_MS, 15_000);
  let queryEmbeddingLiteral: string | undefined;
  if (searchPlan.useEmbedding) {
    const [queryEmbedding] = await fetchDocsRagEmbeddings(
      config,
      [buildDocsRagQueryEmbeddingText(normalizedQuery)],
      options.signal
    );
    queryEmbeddingLiteral = formatDocsRagHalfvecLiteral(
      queryEmbedding,
      config.embedding.dimensions
    );
  }
  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    await sql`select set_config('statement_timeout', ${statementTimeoutMs}::text, false)`;
    if (queryEmbeddingLiteral) {
      await sql`set hnsw.ef_search = 10`;
    }
    // HNSW applies non-vector filters after visiting index candidates. Without
    // iterative scans, a selective source filter can return no rows even when
    // that source has fully embedded chunks.
    if (queryEmbeddingLiteral && !allRegisteredSources) {
      await sql`set hnsw.iterative_scan = strict_order`;
    }
    const vectorCandidates = queryEmbeddingLiteral
      ? allRegisteredSources
        ? ((await sql`
            with query as (
              select ${queryEmbeddingLiteral}::halfvec as query_embedding
            ),
            vector_neighbors as materialized (
              select
                e.chunk_id,
                greatest(1 - (e.embedding <=> query.query_embedding), 0)::float8 as vector_score,
                (e.embedding <=> query.query_embedding)::float8 as distance
              from docs_embeddings e
              cross join query
              where e.embedding_kind = 'chunk'
                and e.embedding_model = ${config.embedding.model}
                and e.embedding_dimensions = ${config.embedding.dimensions}
              order by e.embedding <=> query.query_embedding
              limit ${globalVectorCandidateLimit}
            )
            select
              neighbor.chunk_id as "chunkId",
              neighbor.vector_score as "vectorScore"
            from vector_neighbors neighbor
            join docs_chunks c on c.id = neighbor.chunk_id
            join docs_documents d on d.id = c.document_id
            join docs_source_generation_pointers serving_generation
              on serving_generation.source_id = d.source_id
             and serving_generation.generation_id = d.generation_id
            where d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
              and d.source_path like 'ingest/processed/external/%'
            order by neighbor.distance
            limit ${candidateLimit}
          `) as DocsRagVectorCandidateRow[])
        : ((await sql`
            with query as (
              select ${queryEmbeddingLiteral}::halfvec as query_embedding
            )
            select
              e.chunk_id as "chunkId",
              greatest(1 - (e.embedding <=> query.query_embedding), 0)::float8 as "vectorScore"
            from docs_embeddings e
            join docs_chunks c on c.id = e.chunk_id
            join docs_documents d on d.id = c.document_id
            join docs_source_generation_pointers serving_generation
              on serving_generation.source_id = d.source_id
             and serving_generation.generation_id = d.generation_id
            cross join query
            where e.embedding_kind = 'chunk'
              and d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
              and d.source_path like 'ingest/processed/external/%'
              and e.embedding_model = ${config.embedding.model}
              and e.embedding_dimensions = ${config.embedding.dimensions}
              and d.source_id in ${sql(sqlSourceIds)}
            order by e.embedding <=> query.query_embedding
            limit ${candidateLimit}
          `) as DocsRagVectorCandidateRow[])
      : [];
    const exactDocumentCandidates =
      searchPlan.includeLexicalCandidates && exactIdentifierTerms.length > 0
        ? ((await sql`
          with query as (
            select array(
              select identifier
              from jsonb_array_elements_text(${serializedExactIdentifierTerms}::jsonb)
                identifier
          ) as exact_identifier_terms
          )
          select
            d.id as "documentId",
            exact_match.identifier_length as "identifierLength"
          from docs_documents d
          join docs_source_generation_pointers serving_generation
            on serving_generation.source_id = d.source_id
           and serving_generation.generation_id = d.generation_id
          cross join query
          cross join lateral (
            select max(length(identifier)) as identifier_length
            from unnest(query.exact_identifier_terms) identifier
            where position(identifier in d.source_path_normalized) > 0
              or position(identifier in d.title_normalized) > 0
          ) exact_match
          where d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
            and d.source_path like 'ingest/processed/external/%'
            and (${allRegisteredSources}::boolean or d.source_id in ${sql(sqlSourceIds)})
            and exact_match.identifier_length is not null
          order by exact_match.identifier_length desc, d.source_path asc, d.id asc
          limit ${candidateLimit}
          `) as DocsRagExactDocumentCandidateRow[])
        : [];
    const serializedExactDocumentCandidates = JSON.stringify(
      exactDocumentCandidates.map((candidate) => ({
        document_id: String(candidate.documentId),
        identifier_length: Number(candidate.identifierLength),
      }))
    );
    const exactChunkCandidates =
      searchPlan.includeLexicalCandidates && exactDocumentCandidates.length > 0
        ? ((await sql`
          select c.id as "chunkId"
          from jsonb_to_recordset(${serializedExactDocumentCandidates}::jsonb)
            as candidate(document_id bigint, identifier_length int)
          join docs_chunks c on c.document_id = candidate.document_id
          where c.enabled
          order by candidate.identifier_length desc, c.chunk_index asc, c.id asc
          limit ${candidateLimit}
        `) as DocsRagExactChunkCandidateRow[])
        : [];
    const serializedVectorCandidates = JSON.stringify(
      vectorCandidates.map((candidate) => ({
        chunk_id: String(candidate.chunkId),
        vector_score: Number(candidate.vectorScore),
      }))
    );
    const serializedExactChunkCandidates = JSON.stringify(
      exactChunkCandidates.map((candidate) => ({
        chunk_id: String(candidate.chunkId),
      }))
    );
    const rows = queryEmbeddingLiteral
      ? ((await sql`
          with query as (
            select
              websearch_to_tsquery('simple', ${normalizedQuery}) as tsq,
              lower(unaccent(${normalizedQuery})) as textq,
              regexp_split_to_array(
                lower(
                  regexp_replace(
                    unaccent(${normalizedQuery}),
                    '([a-z0-9])([A-Z])',
                    '\\1 \\2',
                    'g'
                  )
                ),
                '[^a-z0-9_./-]+'
              ) as terms,
              array(
                select identifier
                from jsonb_array_elements_text(${serializedExactIdentifierTerms}::jsonb)
                  identifier
              ) as exact_identifier_terms
          ),
          vector_candidates as (
            select candidate.chunk_id, candidate.vector_score
            from jsonb_to_recordset(${serializedVectorCandidates}::jsonb)
              as candidate(chunk_id bigint, vector_score float8)
          ),
          exact_candidates as (
            select candidate.chunk_id
            from jsonb_to_recordset(${serializedExactChunkCandidates}::jsonb)
              as candidate(chunk_id bigint)
          ),
          lexical_candidates as (
            select c.id as chunk_id
            from docs_chunks c
            join docs_documents d on d.id = c.document_id
            join docs_source_generation_pointers serving_generation
              on serving_generation.source_id = d.source_id
             and serving_generation.generation_id = d.generation_id
            cross join query
            where c.enabled
              and d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
              and d.source_path like 'ingest/processed/external/%'
              and ${searchPlan.includeLexicalCandidates}::boolean
              and (${allRegisteredSources}::boolean or d.source_id in ${sql(sqlSourceIds)})
              and c.search_vector @@ query.tsq
            order by ts_rank_cd(c.search_vector, query.tsq) desc
            limit ${candidateLimit}
          ),
          candidate_chunks as materialized (
            select chunk_id, max(vector_score) as vector_score
            from (
              select chunk_id, vector_score from vector_candidates
              union all
              select chunk_id, 0::float8 as vector_score from lexical_candidates
              union all
              select chunk_id, 0::float8 as vector_score from exact_candidates
            ) candidates
            group by chunk_id
          )
          select
            d.source_id as "sourceId",
            d.source_path as "sourcePath",
            d.title,
            d.metadata as metadata,
            d.canonical_url as "canonicalUrl",
            d.authority,
            generation.upstream_revision as "sourceRevision",
            generation.generation_key as "generationKey",
            generation.published_at as "publishedAt",
            c.heading,
            c.section,
            c.content,
            c.chunk_index as "chunkIndex",
            (
              case when ${searchPlan.includeLexicalCandidates}::boolean then
                ts_rank_cd(d.search_vector, query.tsq) * 5
                + ts_rank_cd(c.search_vector, query.tsq) * 10
                + similarity(c.search_text_normalized, query.textq)
                + similarity(d.source_path_normalized, query.textq)
                + (match_stats.term_hits::float8 * ${DOCS_RAG_TERM_HIT_WEIGHT})
                + (
                  exact_matches.content_identifier_hits::float8
                  * ${DOCS_RAG_EXACT_IDENTIFIER_WEIGHT}
                )
                + (
                  exact_matches.path_identifier_hits::float8
                  * ${DOCS_RAG_EXACT_PATH_WEIGHT}
                )
                + (
                  exact_matches.title_identifier_hits::float8
                  * ${DOCS_RAG_EXACT_TITLE_WEIGHT}
                )
              else 0 end
              + coalesce(cc.vector_score, 0) * ${DOCS_RAG_VECTOR_SCORE_WEIGHT}
            )::float8 as score
          from candidate_chunks cc
          join docs_chunks c on c.id = cc.chunk_id
          join docs_documents d on d.id = c.document_id
          join docs_source_generation_pointers serving_generation
            on serving_generation.source_id = d.source_id
           and serving_generation.generation_id = d.generation_id
          join docs_source_generations generation
            on generation.id = serving_generation.generation_id
          cross join query
          cross join lateral (
            select count(*) as term_hits
            from unnest(query.terms) term
            where length(term) >= 3
              and (
                c.search_text_normalized like ('%' || term || '%')
                or d.source_path_normalized like ('%' || term || '%')
              )
          ) match_stats
          cross join lateral (
            select
              count(*) filter (
                where position(identifier.value in c.search_text_normalized) > 0
              ) as content_identifier_hits,
              count(*) filter (
                where position(identifier.value in d.source_path_normalized) > 0
              ) as path_identifier_hits,
              count(*) filter (
                where position(identifier.value in d.title_normalized) > 0
              ) as title_identifier_hits
            from (
              select distinct identifier as value
              from unnest(query.exact_identifier_terms) identifier
              where length(identifier) >= 3
            ) identifier
          ) exact_matches
          where c.enabled
            and d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
            and d.source_path like 'ingest/processed/external/%'
            and (${allRegisteredSources}::boolean or d.source_id in ${sql(sqlSourceIds)})
          order by score desc, d.source_path asc, c.chunk_index asc, d.source_id asc
          limit ${resultCandidateLimit}
        `) as DocsRagLabSearchResultRow[])
      : ((await sql`
      with query as (
        select
          websearch_to_tsquery('simple', ${normalizedQuery}) as tsq,
          lower(unaccent(${normalizedQuery})) as textq,
          regexp_split_to_array(
            lower(
              regexp_replace(
                unaccent(${normalizedQuery}),
                '([a-z0-9])([A-Z])',
                '\\1 \\2',
                'g'
              )
            ),
            '[^a-z0-9_./-]+'
          ) as terms,
          array(
            select identifier
            from jsonb_array_elements_text(${serializedExactIdentifierTerms}::jsonb)
              identifier
          ) as exact_identifier_terms
      ),
      exact_candidates as (
        select candidate.chunk_id
        from jsonb_to_recordset(${serializedExactChunkCandidates}::jsonb)
          as candidate(chunk_id bigint)
      ),
      lexical_candidates as (
        (
          select c.id as chunk_id
          from docs_chunks c
          join docs_documents d on d.id = c.document_id
          join docs_source_generation_pointers serving_generation
            on serving_generation.source_id = d.source_id
           and serving_generation.generation_id = d.generation_id
          cross join query
          where c.enabled
            and d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
            and d.source_path like 'ingest/processed/external/%'
            and (${allRegisteredSources}::boolean or d.source_id in ${sql(sqlSourceIds)})
            and c.search_vector @@ query.tsq
          order by ts_rank_cd(c.search_vector, query.tsq) desc
          limit ${candidateLimit}
        )
        union
        select chunk_id from exact_candidates
      )
      select
        d.source_id as "sourceId",
        d.source_path as "sourcePath",
        d.title,
        d.metadata as metadata,
        d.canonical_url as "canonicalUrl",
        d.authority,
        generation.upstream_revision as "sourceRevision",
        generation.generation_key as "generationKey",
        generation.published_at as "publishedAt",
        c.heading,
        c.section,
        c.content,
        c.chunk_index as "chunkIndex",
        (
          ts_rank_cd(d.search_vector, query.tsq) * 5
          + ts_rank_cd(c.search_vector, query.tsq) * 10
          + similarity(c.search_text_normalized, query.textq)
          + similarity(d.source_path_normalized, query.textq)
          + (match_stats.term_hits::float8 * ${DOCS_RAG_TERM_HIT_WEIGHT})
          + (
            exact_matches.content_identifier_hits::float8
            * ${DOCS_RAG_EXACT_IDENTIFIER_WEIGHT}
          )
          + (
            exact_matches.path_identifier_hits::float8
            * ${DOCS_RAG_EXACT_PATH_WEIGHT}
          )
          + (
            exact_matches.title_identifier_hits::float8
            * ${DOCS_RAG_EXACT_TITLE_WEIGHT}
          )
        )::float8 as score
      from lexical_candidates lc
      join docs_chunks c on c.id = lc.chunk_id
      join docs_documents d on d.id = c.document_id
      join docs_source_generation_pointers serving_generation
        on serving_generation.source_id = d.source_id
       and serving_generation.generation_id = d.generation_id
      join docs_source_generations generation
        on generation.id = serving_generation.generation_id
      cross join query
      cross join lateral (
        select count(*) as term_hits
        from unnest(query.terms) term
        where length(term) >= 3
          and (
            c.search_text_normalized like ('%' || term || '%')
            or d.source_path_normalized like ('%' || term || '%')
          )
      ) match_stats
      cross join lateral (
        select
          count(*) filter (
            where position(identifier.value in c.search_text_normalized) > 0
          ) as content_identifier_hits,
          count(*) filter (
            where position(identifier.value in d.source_path_normalized) > 0
          ) as path_identifier_hits,
          count(*) filter (
            where position(identifier.value in d.title_normalized) > 0
          ) as title_identifier_hits
        from (
          select distinct identifier as value
          from unnest(query.exact_identifier_terms) identifier
          where length(identifier) >= 3
        ) identifier
      ) exact_matches
      where c.enabled
        and d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
        and d.source_path like 'ingest/processed/external/%'
        and (${allRegisteredSources}::boolean or d.source_id in ${sql(sqlSourceIds)})
      order by score desc, d.source_path asc, c.chunk_index asc, d.source_id asc
      limit ${resultCandidateLimit}
    `) as DocsRagLabSearchResultRow[]);

    const normalizedResults = rows.map((row) =>
      normalizeDocsRagLabSearchResult({
        ...row,
        score: Number(row.score),
      })
    );

    return {
      query: normalizedQuery,
      limit,
      mode,
      results: selectDocsRagDiverseResults(normalizedResults, limit),
    };
  } finally {
    if (queryEmbeddingLiteral && !allRegisteredSources) {
      await sql`reset hnsw.iterative_scan`;
    }
    await sql.close({ timeout: 5 });
  }
}

export async function listDocsRagLabCategories(
  config: DocsRagLabConfig
): Promise<DocsRagLabCategory[]> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }

  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    const rows = (await sql`
      select
        coalesce(d.category, d.source_id, 'docs') as name,
        count(distinct d.id)::int as "docCount",
        count(c.id)::int as "chunkCount"
      from docs_documents d
      join docs_source_generation_pointers serving_generation
        on serving_generation.source_id = d.source_id
       and serving_generation.generation_id = d.generation_id
      left join docs_chunks c on c.document_id = d.id and c.enabled
      where d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
        and d.source_path like 'ingest/processed/external/%'
      group by coalesce(d.category, d.source_id, 'docs')
      order by name asc
    `) as Array<{
      readonly name: string;
      readonly docCount: number;
      readonly chunkCount: number;
    }>;

    return rows.map((row) => ({
      name: row.name,
      displayName: row.name,
      docCount: Number(row.docCount),
      chunkCount: Number(row.chunkCount),
    }));
  } finally {
    await sql.close({ timeout: 5 });
  }
}

export async function getDocsRagLabDocumentByPath(
  config: DocsRagLabConfig,
  sourcePath: string
): Promise<DocsRagLabDocument | null> {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.');
  }
  const storedSourcePath = normalizeDocsRagStoredSourcePath(sourcePath);

  const sql = await createSql(config);
  try {
    await assertDocsRagGenerationSchemaReady(sql);
    const rows = (await sql`
      select
        d.title,
        d.source_path as "sourcePath",
        c.chunk_index as "chunkIndex",
        c.content
      from docs_documents d
      join docs_source_generation_pointers serving_generation
        on serving_generation.source_id = d.source_id
       and serving_generation.generation_id = d.generation_id
      left join docs_chunks c on c.document_id = d.id and c.enabled
      where d.source_path = ${storedSourcePath}
        and d.source_id in ${sql(REGISTERED_SOURCE_IDS)}
        and d.source_path like 'ingest/processed/external/%'
      order by c.chunk_index asc
    `) as Array<{
      readonly title: string;
      readonly sourcePath: string;
      readonly chunkIndex: number | null;
      readonly content: string | null;
    }>;

    const first = rows[0];
    if (!first) {
      return null;
    }

    return {
      document: {
        title: first.title,
        sourcePath: first.sourcePath,
      },
      chunks: rows
        .filter((row) => typeof row.chunkIndex === 'number' && typeof row.content === 'string')
        .map((row) => ({
          chunkIndex: Number(row.chunkIndex),
          content: String(row.content),
        })),
    };
  } finally {
    await sql.close({ timeout: 5 });
  }
}
