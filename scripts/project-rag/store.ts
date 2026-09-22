import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve as resolvePath } from 'node:path';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import {
  buildProjectIgnoreGlobPatterns,
  buildProjectIncludeGlobPatterns,
} from '../../lib/shared/project-include-roots.js';
import type {
  ProjectEmbeddingInvariantSummary,
  ProjectInvariantCoverageStatus,
  ProjectInvariantFreshnessStatus,
  ProjectOwnershipInvariantSummary,
} from '../../lib/shared/project-invariants.js';
import { calculateProjectContentHash } from '../lib/project-content-hash.js';
import type { ProjectRagPostgresConfig } from './config.js';
import type { ProjectRagIdentityBinding } from './context.js';
import { isEligibleProjectSourcePath } from './eligibility.js';
import {
  PROJECT_RAG_EMBEDDING_PROFILE_LEGACY_UNKNOWN,
  PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
  projectRagPostgresEmbeddingProfileIdentity,
} from './embeddings.js';
import {
  beginProjectRagFencedWrite,
  beginProjectRagWrite,
  type ProjectRagSnapshotFence,
  type ProjectRagTransactionFence,
  type ProjectRagWriteSql,
} from './transaction.js';

export interface ProjectRagPostgresProject {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly rootPath: string;
  readonly normalizedRootPath: string;
  readonly status: string;
  readonly includeRoots: string[];
  readonly ignoreRules: string[];
  readonly ephemeral: boolean;
  readonly blockedFindingAllowlist: readonly BlockedFindingAllowlistEntry[];
}

export interface ProjectRagPostgresProjectStats {
  readonly fileCount: number;
  readonly indexedFileCount: number;
  readonly blockedFileCount: number;
  readonly chunkCount: number;
  readonly symbolCount: number;
  readonly edgeCount: number;
  readonly embedding1024Count: number;
  readonly syncRunCount: number;
}

export interface ProjectRagPostgresIndexBuild {
  readonly id: number;
  readonly projectId: number;
  readonly status: 'building' | 'published' | 'failed' | 'retired' | 'garbage_collected';
  readonly fileCount: number;
}

export interface ProjectRagPostgresPublishedBuildState {
  readonly buildId: number;
  readonly dirtyDigest: string | null;
}

export interface ProjectRagPostgresInvariantReport {
  readonly versionReadiness: {
    readonly filesWithVersionMetadata: number;
    readonly filesWithActiveReadyVersion: number;
    readonly filesWithNonReadyActiveVersion: number;
    readonly filesPendingVersionBackfill: number;
    readonly filesUsingLegacyStatusRead: number;
    readonly pendingVersionCount: number;
    readonly stalePendingVersionCount: number;
  };
  readonly freshness: {
    readonly status: ProjectInvariantFreshnessStatus;
    readonly checkedFiles: number;
    readonly eligibleFiles: number;
    readonly freshFiles: number;
    readonly staleFiles: number;
    readonly missingFiles: number;
    readonly metadataDriftFiles: number;
    readonly unverifiedFiles: number;
    readonly stalePaths: string[];
    readonly checkedAt: string;
    readonly reason: string;
    readonly versionSignals: ProjectRagPostgresInvariantReport['versionReadiness'];
  };
  readonly scopeCoverage: {
    readonly status: ProjectInvariantCoverageStatus;
    readonly checkedAt: string;
    readonly expectedFiles: number;
    readonly trackedFiles: number;
    readonly indexedFiles: number;
    readonly missingExpectedFiles: number;
    readonly blockedExpectedFiles: number;
    readonly extraIndexedFiles: number;
    readonly ignoredExpectedFiles: number;
    readonly ignoredIndexedFiles: number;
    readonly missingExpectedPaths: string[];
    readonly blockedExpectedPaths: string[];
    readonly extraIndexedPaths: string[];
    readonly ignoredExpectedPaths: string[];
    readonly ignoredIndexedPaths: string[];
    readonly reason: string;
  };
  readonly embeddingCoverage: ProjectEmbeddingInvariantSummary;
  readonly ownershipCoverage: ProjectOwnershipInvariantSummary;
  readonly lastSyncAt: string | null;
}

/**
 * An entry in the blocked-finding allowlist.
 *
 * `relativePath` is a project-root-relative path (forward slashes, no
 * leading slash).  `category` is a free-text label matching the category
 * of a blocked finding that should be suppressed (e.g. 'dependency_root',
 * 'cache_dir').  The allowlist is an exact-match lookup — no globs.
 */
export interface BlockedFindingAllowlistEntry {
  readonly relativePath: string;
  readonly category: string;
}

/**
 * A suppressed blocked-finding entry recorded on a snapshot.
 *
 * One entry per suppressed relative path (not aggregated).  Tracks which
 * allowlist entry caused the suppression so audit trails are exact.
 */
export interface SuppressedBlockedFinding {
  readonly relativePath: string;
  readonly category: string;
  readonly matchedAllowlistEntry: {
    readonly relativePath: string;
    readonly category: string;
  };
}

export interface ProjectRagPostgresRepositoryInput {
  readonly name: string;
  readonly slug: string;
  readonly rootPath: string;
  readonly normalizedRootPath: string;
  readonly status?: string;
  readonly syncMode?: string;
  readonly includeRoots?: readonly string[];
  readonly ignoreRules?: readonly string[];
  readonly ephemeral?: boolean;
  readonly metadata?: Record<string, unknown>;
  /** Optional exact blocked-finding allowlist entries. */
  readonly blockedFindingAllowlist?: readonly BlockedFindingAllowlistEntry[];
  /** SHA-256 of the exact root-manifest bytes, or the empty-manifest hash. */
  readonly rootManifestHash?: string;
  /** Hash of the effective include/ignore/allowlist policy. */
  readonly policyHash?: string;
}

export interface ProjectRagWorkspaceContextInput {
  readonly repositoryCommonDir: string;
  readonly worktreeGitDir?: string;
  readonly repositoryHash?: string;
  readonly workspaceHash?: string;
  readonly remoteUrl: string | null;
  readonly workspaceRoot: string;
  readonly headOid: string | null;
  readonly headHash?: string;
  readonly branchName: string | null;
  readonly branchHash?: string;
  readonly isDetached: boolean;
  readonly detachedHash?: string;
  readonly isUnborn?: boolean;
  readonly dirtyDigest: string;
  readonly statusDigest?: string;
  readonly contentFingerprint?: string;
  readonly contentHash?: string;
  readonly identityDigest?: string;
}

export interface ProjectRagWorkspaceContextRecord extends ProjectRagWorkspaceContextInput {
  readonly repositoryId: number;
  readonly workspaceId: number;
  readonly revisionId: number;
}

export interface ProjectRagPostgresFileInput {
  readonly sourcePath: string;
  readonly absolutePath: string;
  readonly contentHash: string;
  readonly fileModifiedAt: number;
  readonly lang?: string;
  readonly ecosystem?: string;
  readonly sizeBytes?: number;
  readonly status?: string;
  readonly metadataQuality?: string;
  readonly skeletonText?: string;
  readonly outlineVersion?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectRagPostgresFileState {
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly status: string;
  readonly latestVersionStatus: string | null;
}

export interface ProjectRagPostgresChunkInput {
  readonly chunkIndex: number;
  readonly content: string;
  readonly searchableText: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly symbolName?: string;
  readonly symbolKind?: string;
  readonly symbolSignature?: string;
  readonly section?: string;
  readonly enabled?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectRagPostgresSymbolInput {
  readonly fileId: number;
  readonly versionId?: number;
  readonly chunkId?: number;
  readonly name: string;
  readonly symbolType: string;
  readonly exportType?: string;
  readonly signature?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly confidence?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectRagPostgresEdgeInput {
  readonly sourceFileId?: number;
  readonly sourceVersionId?: number;
  readonly sourceSymbolId?: number;
  readonly sourceRef?: string;
  readonly targetFileId?: number;
  readonly targetVersionId?: number;
  readonly targetSymbolId?: number;
  readonly targetRef?: string;
  readonly relationType: string;
  readonly confidence?: number;
  readonly extractionMethod?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectRagPostgresChunkEmbeddingCandidate {
  readonly chunkId: number;
  readonly sourceHash: string;
  readonly text: string;
}

/**
 * Input for one insert-only chunk embedding write.
 *
 * `embeddingProfileHash` is the canonical sha256 of the processing profile
 * (schema version + provider + model + dimensions + input format/version)
 * that produced `embedding`. It is part of the storage identity: rows are
 * unique per (project, owner_type, owner_ref, profile hash) and are never
 * updated after insert.
 */
export interface ProjectRagPostgresChunkEmbeddingInput
  extends ProjectRagPostgresChunkEmbeddingCandidate {
  readonly embedding: readonly number[];
  readonly embeddingModel: string;
  readonly embeddingProvider: string;
  readonly dimensions: number;
  readonly embeddingProfileHash: string;
}

export interface ProjectRagPostgresSearchResult {
  readonly sourcePath: string;
  readonly chunkIndex: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly content: string;
  readonly symbolName?: string;
  readonly symbolKind?: string;
  readonly score: number;
  readonly vectorScore: number;
}

export interface ProjectRagPostgresFile {
  readonly id: number;
  readonly sourcePath: string;
  readonly lang?: string;
  readonly status: string;
  readonly lineCount?: number;
  readonly sizeBytes: number;
  readonly metadataQuality: string;
  readonly skeletonText?: string;
  readonly outlineVersion?: string;
  readonly updatedAt?: number;
}

export interface ProjectRagPostgresChunk {
  readonly id: number;
  readonly sourcePath?: string;
  readonly chunkIndex: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly symbolName?: string;
  readonly symbolKind?: string;
  readonly content: string;
}

export interface ProjectRagPostgresSymbol {
  readonly id: number;
  readonly name: string;
  readonly symbolType: string;
  readonly sourcePath: string;
  readonly fileId: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly signature?: string;
  readonly exportType?: string;
  readonly confidence?: number;
}

export interface ProjectRagPostgresReference {
  readonly id: number;
  readonly relationType: string;
  readonly sourcePath?: string;
  readonly targetPath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly sourceFileId?: number;
  readonly sourceRef?: string;
  readonly targetFileId?: number;
  readonly targetRef?: string;
  readonly confidence?: number;
}

export interface ProjectRagPostgresNavigationPath {
  readonly sourcePath: string;
  readonly relationshipType: string;
  readonly strength: number;
  readonly explanation: string;
}

export interface ProjectRagPostgresSemanticCluster {
  readonly clusterId: string;
  readonly topicLabel: string;
  readonly confidence: number;
  readonly files: Array<{ readonly sourcePath: string; readonly similarity: number }>;
  readonly terms: string[];
}

export interface ProjectRagPostgresFeatureHub {
  readonly hubId: string;
  readonly name: string;
  readonly directory: string;
  readonly stats: {
    readonly fileCount: number;
    readonly languageCount: number;
    readonly totalSymbols: number;
    readonly fileTypeDistribution: Record<string, number>;
  };
  readonly files: Array<{ readonly fileName: string; readonly symbols: string[] }>;
}

export interface ProjectRagPostgresTopicGroup {
  readonly topicId: string;
  readonly name: string;
  readonly files: Array<{ readonly sourcePath: string }>;
  readonly keywords: string[];
  readonly cohesion: number;
}

export type ProjectRagSql = Bun.SQL;

/** Durable scheduler states.  The hyphenated values are persisted verbatim. */
export type ProjectRagJobStatus =
  | 'queued'
  | 'running'
  | 'blocked-review'
  | 'retry-wait'
  | 'succeeded'
  | 'failed'
  | 'dead-letter'
  | 'cancelled';

export interface ProjectRagPostgresJob {
  readonly id: number;
  readonly type: string;
  readonly projectId: number | null;
  readonly dedupeKey: string | null;
  readonly status: ProjectRagJobStatus;
  readonly payload: Record<string, unknown>;
  readonly result: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly workerId: string | null;
  readonly fenceToken: number;
  readonly leaseExpiresAt: Date | string | null;
  readonly checkpoint: Record<string, unknown>;
  readonly snapshotUuid: string | null;
  readonly error: string | null;
  readonly availableAt: Date | string | null;
  readonly cancelRequestedAt: Date | string | null;
  readonly blockedAt: Date | string | null;
  readonly deadLetteredAt: Date | string | null;
  readonly statusReason: string | null;
}

export interface ProjectRagJobFence {
  readonly jobId: number;
  readonly fenceToken: number;
}

/** Statuses that close a job's lease without requeueing. */
export type ProjectRagJobTerminalStatus = Extract<
  ProjectRagJobStatus,
  'succeeded' | 'failed' | 'dead-letter' | 'cancelled'
>;

export type ProjectRagJobRetryableStatus = Extract<ProjectRagJobStatus, 'queued' | 'retry-wait'>;

export interface EnqueueProjectRagJobInput {
  readonly type: string;
  readonly projectId?: number;
  readonly dedupeKey?: string;
  readonly payload: Record<string, unknown>;
  readonly maxAttempts?: number;
  readonly snapshotUuid?: string;
  /** Delay before the first claim; useful for an explicit operator resume. */
  readonly availableAt?: Date | string;
}

export interface ProjectRagJobRetryOptions {
  /** Override the bounded retry delay for this failure. */
  readonly retryDelayMs?: number;
  /** Keep an exhausted attempt terminal even if the caller asks to retry. */
  readonly retryable?: boolean;
}

export interface ProjectRagJobCheckpoint {
  readonly phase: string;
  readonly completed?: number;
  readonly total?: number;
  readonly detail?: Record<string, unknown>;
}

export interface ProjectRagJobRecoveryResult {
  readonly recoveredIds: number[];
  readonly deadLetteredIds: number[];
}

export const PROJECT_RAG_JOB_RESULT_MAX_DEPTH = 8;
export const PROJECT_RAG_JOB_RESULT_MAX_ITEMS = 512;
export const PROJECT_RAG_JOB_RESULT_MAX_BYTES = 64 * 1024;

interface JobResultValidationState {
  items: number;
  readonly active: WeakSet<object>;
}

function isPlainJobResultObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJobResultValue(
  value: unknown,
  depth: number,
  state: JobResultValidationState
): void {
  if (depth > PROJECT_RAG_JOB_RESULT_MAX_DEPTH) {
    throw new Error(
      `Project RAG job result exceeds maximum depth of ${PROJECT_RAG_JOB_RESULT_MAX_DEPTH}`
    );
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Project RAG job result contains a non-finite number');
    return;
  }
  if (typeof value !== 'object') {
    throw new Error('Project RAG job result must contain only JSON values');
  }
  if (!Array.isArray(value) && !isPlainJobResultObject(value)) {
    throw new Error('Project RAG job result contains a non-plain object');
  }
  if (state.active.has(value)) throw new Error('Project RAG job result must not be circular');
  state.active.add(value);
  try {
    const entries = Array.isArray(value) ? value : Object.entries(value);
    state.items += entries.length;
    if (state.items > PROJECT_RAG_JOB_RESULT_MAX_ITEMS) {
      throw new Error(
        `Project RAG job result exceeds maximum item count of ${PROJECT_RAG_JOB_RESULT_MAX_ITEMS}`
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) validateJobResultValue(item, depth + 1, state);
    } else {
      for (const [, item] of entries) validateJobResultValue(item, depth + 1, state);
    }
  } finally {
    state.active.delete(value);
  }
}

/** Validate and serialize a durable result before any SQL is issued. */
export function serializeProjectRagJobResult(result: unknown): string {
  validateJobResultValue(result, 0, { items: 1, active: new WeakSet<object>() });
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error('Project RAG job result is not JSON serializable');
  }
  if (typeof serialized !== 'string') {
    throw new Error('Project RAG job result is not JSON serializable');
  }
  if (new TextEncoder().encode(serialized).byteLength > PROJECT_RAG_JOB_RESULT_MAX_BYTES) {
    throw new Error(
      `Project RAG job result exceeds maximum size of ${PROJECT_RAG_JOB_RESULT_MAX_BYTES} bytes`
    );
  }
  return serialized;
}

export type EnqueueProjectRagJobResult = ProjectRagPostgresJob & {
  /** True when this call inserted the row; false when an active duplicate was returned. */
  readonly inserted: boolean;
};
const POSTGRES_INVARIANT_SAMPLE_LIMIT = 10;
// The expected lane must stay in lockstep with embeddings.ts and migration
// 010's deterministic backfill; the hash is derived, never hand-written.
const POSTGRES_EXPECTED_EMBEDDING_IDENTITY = projectRagPostgresEmbeddingProfileIdentity();
const POSTGRES_EXPECTED_EMBEDDING_MODEL = POSTGRES_EXPECTED_EMBEDDING_IDENTITY.model;
const POSTGRES_EXPECTED_EMBEDDING_PROVIDER = POSTGRES_EXPECTED_EMBEDDING_IDENTITY.provider;
const POSTGRES_EXPECTED_EMBEDDING_DIMENSIONS = POSTGRES_EXPECTED_EMBEDDING_IDENTITY.dimensions;
const POSTGRES_EXPECTED_EMBEDDING_PROFILE_HASH = PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH;

/**
 * Controlled schema-migration remediation entry point. Raw `psql -f`
 * instructions are no longer suggested: the db:migrations runner owns exact
 * checksum verification, database-global locking, and explicit verified
 * adoption for pre-ledger databases.
 */
const PROJECT_RAG_MIGRATION_COMMAND =
  'bun run db:migrations apply --lane project --execute (requires RAG_MIGRATION_TARGET=isolated and RAG_MIGRATION_WRITE_ACK=1; check state first with: bun run db:migrations status --lane project)';
const POSTGRES_SQL_IDLE_TIMEOUT_SECONDS = 300;
const POSTGRES_PROJECT_DEFAULT_IGNORE_RULES = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.agents',
  '.cache',
  '.turbo',
  '.next',
  '.data',
  '_generated',
  'archive',
  'generated',
  '/ingest',
  'logs',
  'out',
  'playwright-report',
  'temp',
  'test-results',
  'tmp',
  'vendor',
  '*.egg-info/**',
];

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Parse a JSONB column value that must be a JSON array.
 *
 * Accepts either a pre-parsed array (Bun.SQL native) or a JSON string
 * (some driver modes).  Throws on malformed values rather than silently
 * returning an empty array, preserving evidence of data corruption.
 *
 * Unrelated legacy fields that are already parsed as `[]` are NOT affected
 * unless explicitly migrated to this helper.
 */
function jsonbArrayField(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value as Array<Record<string, unknown>>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed as Array<Record<string, unknown>>;
      }
    } catch {
      // fall through to throw
    }
  }
  throw new Error(`Expected JSONB array, got ${typeof value}: ${String(value).slice(0, 200)}`);
}

function suppressedBlockedFindingsFromRow(value: unknown): readonly SuppressedBlockedFinding[] {
  const raw = jsonbArrayField(value);
  return raw.map((item) => {
    const relPath =
      typeof (item as Record<string, unknown>).relativePath === 'string'
        ? ((item as Record<string, unknown>).relativePath as string)
        : '';
    const cat =
      typeof (item as Record<string, unknown>).category === 'string'
        ? ((item as Record<string, unknown>).category as string)
        : '';
    const maeRaw = (item as Record<string, unknown>).matchedAllowlistEntry;
    const mae =
      maeRaw !== null && typeof maeRaw === 'object' && !Array.isArray(maeRaw)
        ? {
            relativePath:
              typeof (maeRaw as Record<string, unknown>).relativePath === 'string'
                ? ((maeRaw as Record<string, unknown>).relativePath as string)
                : relPath,
            category:
              typeof (maeRaw as Record<string, unknown>).category === 'string'
                ? ((maeRaw as Record<string, unknown>).category as string)
                : cat,
          }
        : { relativePath: relPath, category: cat };
    return {
      relativePath: relPath,
      category: cat,
      matchedAllowlistEntry: mae,
    } satisfies SuppressedBlockedFinding;
  });
}

function blockedFindingAllowlistFromRow(value: unknown): readonly BlockedFindingAllowlistEntry[] {
  const raw = jsonbArrayField(value);
  const entries = raw.map((item) => {
    if (typeof item.relativePath === 'string' && typeof item.category === 'string') {
      return {
        relativePath: item.relativePath,
        category: item.category,
      } as BlockedFindingAllowlistEntry;
    }
    // Malformed entry — throw to surface data corruption
    throw new Error(
      `Malformed blocked_finding_allowlist entry: ${JSON.stringify(item).slice(0, 200)}`
    );
  });
  validateRepositoryAllowlist(entries);
  return entries;
}

function projectFromRow(row: Record<string, unknown>): ProjectRagPostgresProject {
  let allowlist: readonly BlockedFindingAllowlistEntry[] = [];
  if (row.blocked_finding_allowlist !== undefined) {
    allowlist = blockedFindingAllowlistFromRow(row.blocked_finding_allowlist);
  }
  return {
    id: numberField(row.id),
    name: typeof row.name === 'string' ? row.name : '',
    slug: typeof row.slug === 'string' ? row.slug : '',
    rootPath: typeof row.root_path === 'string' ? row.root_path : '',
    normalizedRootPath:
      typeof row.normalized_root_path === 'string' ? row.normalized_root_path : '',
    status: typeof row.status === 'string' ? row.status : 'unknown',
    includeRoots: stringArrayField(row.include_roots),
    ignoreRules: stringArrayField(row.ignore_rules),
    ephemeral: row.ephemeral === true,
    blockedFindingAllowlist: allowlist,
  };
}

function statsFromRow(row: Record<string, unknown>): ProjectRagPostgresProjectStats {
  return {
    fileCount: numberField(row.file_count),
    indexedFileCount: numberField(row.indexed_file_count),
    blockedFileCount: numberField(row.blocked_file_count),
    chunkCount: numberField(row.chunk_count),
    symbolCount: numberField(row.symbol_count),
    edgeCount: numberField(row.edge_count),
    embedding1024Count: numberField(row.embedding_1024_count),
    syncRunCount: numberField(row.sync_run_count),
  };
}

function normalizeSourcePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function shouldIndexPostgresProjectPath(pathValue: string, sizeBytes: number): boolean {
  return isEligibleProjectSourcePath(pathValue, sizeBytes);
}

function isPathIgnored(sourcePath: string, ignoreRules: readonly string[]): boolean {
  const patterns = buildProjectIgnoreGlobPatterns([...ignoreRules]);
  if (patterns.length === 0) {
    return false;
  }
  const normalizedPath = normalizeSourcePath(sourcePath);
  return patterns.some((pattern) => minimatch(normalizedPath, pattern, { dot: true }));
}

function samplePush(sample: string[], value: string): void {
  if (sample.length < POSTGRES_INVARIANT_SAMPLE_LIMIT) {
    sample.push(value);
  }
}

async function selectEligibleProjectSourcePaths(
  projectRoot: string,
  absolutePaths: Iterable<string>
): Promise<Set<string>> {
  const selected = new Set<string>();

  for (const absolutePath of absolutePaths) {
    try {
      const currentStats = await stat(absolutePath);
      if (!currentStats.isFile()) {
        continue;
      }
      const sourcePath = normalizeSourcePath(relative(projectRoot, absolutePath));
      if (shouldIndexPostgresProjectPath(sourcePath, currentStats.size)) {
        selected.add(sourcePath);
      }
    } catch (error) {
      const sourcePath = normalizeSourcePath(relative(projectRoot, absolutePath));
      throw new Error(
        `scope_file_stat_failed: ${sourcePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return selected;
}

async function scanExpectedProjectSourcePaths(
  projectRoot: string,
  includeRoots: readonly string[],
  ignoreRules: readonly string[]
): Promise<{
  expectedPaths: Set<string>;
  ignoredExpectedPaths: Set<string>;
}> {
  const patterns = buildProjectIncludeGlobPatterns([...includeRoots], '**/*');
  const ignore = buildProjectIgnoreGlobPatterns([
    ...POSTGRES_PROJECT_DEFAULT_IGNORE_RULES,
    ...ignoreRules,
  ]);
  const rawFiles = new Set<string>();
  const scopedFiles = new Set<string>();
  const canonicalRoot = await realpath(projectRoot);

  const addCanonicalMatch = async (matches: readonly string[], target: Set<string>) => {
    for (const match of matches) {
      const absoluteMatch = resolvePath(match);
      let canonicalMatch: string;
      try {
        canonicalMatch = await realpath(absoluteMatch);
      } catch (error) {
        const sourcePath = normalizeSourcePath(relative(canonicalRoot, absoluteMatch));
        throw new Error(
          `scope_file_stat_failed: ${sourcePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      const relativePath = relative(canonicalRoot, canonicalMatch);
      if (
        relativePath === '' ||
        (!relativePath.startsWith('..') && !relativePath.startsWith('/'))
      ) {
        target.add(canonicalMatch);
      }
    }
  };

  for (const pattern of patterns) {
    const [allMatches, scopedMatches] = await Promise.all([
      glob(pattern, {
        cwd: projectRoot,
        absolute: true,
        nodir: true,
      }),
      glob(pattern, {
        cwd: projectRoot,
        absolute: true,
        nodir: true,
        ignore,
      }),
    ]);

    await addCanonicalMatch(allMatches, rawFiles);
    await addCanonicalMatch(scopedMatches, scopedFiles);
  }

  const expectedPaths = await selectEligibleProjectSourcePaths(canonicalRoot, scopedFiles);
  const rawPaths = await selectEligibleProjectSourcePaths(canonicalRoot, rawFiles);
  const ignoredExpectedPaths = new Set(
    [...rawPaths].filter((sourcePath) => !expectedPaths.has(sourcePath))
  );

  return { expectedPaths, ignoredExpectedPaths };
}

import {
  assertProjectRagPostgresReadSchemaReady,
  getPublishedProjectRagPostgresBuildId,
} from './store-read-models.js';
// ---------------------------------------------------------------------------
// Row-utils import (coercion helpers moved to avoid circular imports)
// ---------------------------------------------------------------------------
import { numberField, optionalNumberField, stringField } from './store-row-utils.js';

// ---------------------------------------------------------------------------
// Re-exports for existing importers (read-model functions extracted to
// store-read-models.ts)
// ---------------------------------------------------------------------------
export type { ProjectRagPostgresServingState } from './store-read-models.js';
// ---------------------------------------------------------------------------
// Re-exports for existing importers (read-model functions extracted to
// store-read-models.ts)
// ---------------------------------------------------------------------------
export {
  assertProjectRagPostgresReadSchemaReady,
  findProjectRagPostgresSymbols,
  getProjectRagPostgresFeatureHubs,
  getProjectRagPostgresFileOutline,
  getProjectRagPostgresFileWithChunks,
  getProjectRagPostgresNavigationPaths,
  getProjectRagPostgresSemanticClusters,
  getProjectRagPostgresServingState,
  getProjectRagPostgresTopicGroups,
  getPublishedProjectRagPostgresBuildId,
} from './store-read-models.js';

function textArrayLiteral(values: readonly string[] = []): string {
  const escaped = values.map(
    (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  );
  return `{${escaped.join(',')}}`;
}

function halfvecLiteral(values: readonly number[], expectedDimensions: number): string {
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

/**
 * Module-level cache for Postgres pools, keyed by database URL.
 *
 * Pools are shared across long-lived MCP read handlers so that every
 * request does not open and close a new connection.  Callers that need to
 * close a pool explicitly (tests, shutdown) must use
 * `closeProjectRagPostgresSql(url?)`.
 *
 * When the URL changes the old pool is left open – call
 * `closeProjectRagPostgresSql(oldUrl)` explicitly if shutdown is needed.
 */
const sqlPoolCache = new Map<string, Bun.SQL>();

/**
 * Build a pool-cache key from the database URL and all pool settings so
 * that changing any setting produces a new pool (no silent reuse).
 */
function poolCacheKey(
  url: string,
  pool: { max: number; connectionTimeoutMs: number; maxLifetimeMs: number }
): string {
  return `${url}|max=${pool.max}|ct=${pool.connectionTimeoutMs}|ml=${pool.maxLifetimeMs}`;
}

export function createProjectRagPostgresSql(config: ProjectRagPostgresConfig): Bun.SQL {
  if (!config.database.url) {
    throw new Error('No Postgres URL configured. Set PROJECT_RAG_DATABASE_URL first.');
  }

  const key = poolCacheKey(config.database.url, config.pool);
  const existing = sqlPoolCache.get(key);
  if (existing) {
    return existing;
  }

  const connectionTimeoutSeconds = Math.max(1, Math.ceil(config.pool.connectionTimeoutMs / 1_000));
  const maxLifetimeSeconds =
    config.pool.maxLifetimeMs > 0 ? Math.ceil(config.pool.maxLifetimeMs / 1_000) : 0;

  const sql = new Bun.SQL({
    url: config.database.url,
    max: config.pool.max,
    idleTimeout: POSTGRES_SQL_IDLE_TIMEOUT_SECONDS,
    maxLifetime: maxLifetimeSeconds,
    connectionTimeout: connectionTimeoutSeconds,
    prepare: false,
  });
  sqlPoolCache.set(key, sql);
  return sql;
}

/** Fail before ingestion when an existing database lacks version-aware chunk uniqueness. */
export async function assertProjectRagPostgresSchemaReady(sql: ProjectRagSql): Promise<void> {
  const rows = (await sql`
    select exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('project_chunks')
        and conname = 'project_chunks_file_version_chunk_unique'
        and pg_get_constraintdef(oid) = 'UNIQUE (file_id, version_id, chunk_index)'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (rows[0]?.ready !== true) {
    throw new Error(
      'Project RAG schema migration 002 is required before ingestion ' +
        '(infra/project-rag/sql/002-versioned-chunk-uniqueness.sql). Run: ' +
        PROJECT_RAG_MIGRATION_COMMAND
    );
  }
}

/** Fail closed when immutable build publication has not been migrated. */
export async function assertProjectRagPostgresIndexBuildSchemaReady(
  sql: ProjectRagSql
): Promise<void> {
  const rows = (await sql`
    select exists (
      select 1 from information_schema.tables
      where table_schema = current_schema() and table_name = 'project_index_builds'
    ) and (
      select count(*) = 3
      from pg_constraint
      where conrelid = to_regclass('project_index_build_files')
        and contype = 'f'
        and conname = any (array[
          'project_index_build_files_build_project_fk',
          'project_index_build_files_file_project_fk',
          'project_index_build_files_version_project_fk'
        ])
    ) as ready
  `) as Array<Record<string, unknown>>;
  if (rows[0]?.ready !== true) {
    throw new Error(
      'Project RAG schema migration 007 is required before index publication ' +
        '(infra/project-rag/sql/007-index-build-publication.sql). Run: ' +
        PROJECT_RAG_MIGRATION_COMMAND
    );
  }
}

/** Fail closed before creating ingest sync runs without immutable bindings. */
export async function assertProjectRagPostgresSyncRunBindingSchemaReady(
  sql: ProjectRagSql
): Promise<void> {
  const rows = (await sql`
    select (
      exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'project_sync_runs'
          and column_name = 'snapshot_uuid'
      )
      and exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'project_sync_runs'
          and column_name = 'job_id'
      )
      and exists (
        select 1 from pg_constraint
        where conrelid = to_regclass('project_sync_runs')
          and conname = 'project_sync_runs_snapshot_project_fk'
      )
      and exists (
        select 1 from pg_constraint
        where conrelid = to_regclass('project_sync_runs')
          and conname = 'project_sync_runs_job_project_fk'
      )
      and exists (
        select 1 from pg_trigger
        where tgname = 'project_sync_runs_freeze_binding_fields'
          and tgrelid = to_regclass('project_sync_runs')
          and not tgisinternal
      )
    ) as ready
  `) as Array<Record<string, unknown>>;
  if (rows[0]?.ready !== true) {
    throw new Error(
      'Project RAG sync-run binding schema (migration 009) is missing. Run: ' +
        PROJECT_RAG_MIGRATION_COMMAND
    );
  }
}

function normalizeProjectJobCatalogExpression(expression: string): string {
  return expression.toLowerCase().replace(/\s+/g, '').replace(/[()]/g, '');
}

function projectJobSqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeProjectJobCatalogExpressionSql(expression: string): string {
  return `regexp_replace(regexp_replace(lower(${expression}), '[[:space:]]', '', 'g'), '[()]', '', 'g')`;
}

function projectJobConstraintDefinitionMatches(constraint: string, definition: string): string {
  return (
    `exists (select 1 from pg_constraint where conrelid = to_regclass('project_jobs') ` +
    `and conname = '${constraint}' and contype = 'c' ` +
    `and ${normalizeProjectJobCatalogExpressionSql('pg_get_constraintdef(oid)')} = ` +
    `${projectJobSqlStringLiteral(normalizeProjectJobCatalogExpression(definition))})`
  );
}

function projectJobIndexDefinitionMatches(input: {
  readonly index: string;
  readonly columns: readonly string[];
  readonly predicate: string;
  readonly unique: boolean;
}): string {
  const columnChecks = input.columns
    .map(
      (column, position) =>
        `pg_get_indexdef(i.indexrelid, ${position + 1}, true) = ${projectJobSqlStringLiteral(column)}`
    )
    .join(' and ');
  return (
    `exists (select 1 from pg_index i ` +
    `join pg_class idx on idx.oid = i.indexrelid ` +
    `join pg_class tbl on tbl.oid = i.indrelid ` +
    `join pg_namespace ns on ns.oid = tbl.relnamespace ` +
    `join pg_am am on am.oid = idx.relam ` +
    `where ns.nspname = current_schema() and tbl.relname = 'project_jobs' ` +
    `and idx.relname = '${input.index}' and am.amname = 'btree' ` +
    `and i.indisvalid and i.indisready and i.indisunique = ${input.unique} ` +
    `and i.indnkeyatts = ${input.columns.length} and i.indnatts = ${input.columns.length} ` +
    `and i.indpred is not null and ${columnChecks} ` +
    `and ${normalizeProjectJobCatalogExpressionSql('pg_get_expr(i.indpred, i.indrelid)')} = ` +
    `${projectJobSqlStringLiteral(normalizeProjectJobCatalogExpression(input.predicate))})`
  );
}

/** Fail closed when durable scheduler lifecycle artifacts are unavailable. */
export async function assertProjectRagPostgresJobLifecycleSchemaReady(
  sql: ProjectRagSql
): Promise<void> {
  const columnChecks = [
    'available_at',
    'cancel_requested_at',
    'blocked_at',
    'dead_lettered_at',
    'status_reason',
  ].map(
    (column) =>
      `exists (select 1 from information_schema.columns where table_schema = current_schema() ` +
      `and table_name = 'project_jobs' and column_name = '${column}')`
  );
  const constraintChecks = [
    projectJobConstraintDefinitionMatches(
      'project_jobs_attempts_nonnegative',
      'CHECK ((attempts >= 0))'
    ),
    projectJobConstraintDefinitionMatches(
      'project_jobs_max_attempts_positive',
      'CHECK ((max_attempts > 0))'
    ),
    projectJobConstraintDefinitionMatches(
      'project_jobs_status_check',
      "CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'blocked-review'::text, 'retry-wait'::text, 'succeeded'::text, 'failed'::text, 'dead-letter'::text, 'cancelled'::text])))"
    ),
  ];
  const indexChecks = [
    projectJobIndexDefinitionMatches({
      index: 'project_jobs_active_dedupe_idx',
      columns: ['dedupe_key'],
      unique: true,
      predicate:
        "dedupe_key IS NOT NULL AND status = ANY (ARRAY['queued'::text, 'running'::text, 'blocked-review'::text, 'retry-wait'::text])",
    }),
    projectJobIndexDefinitionMatches({
      index: 'project_jobs_claim_idx',
      columns: ['status', 'available_at', 'created_at', 'id'],
      unique: false,
      predicate: "status = ANY (ARRAY['queued'::text, 'retry-wait'::text, 'running'::text])",
    }),
    projectJobIndexDefinitionMatches({
      index: 'project_jobs_available_claim_idx',
      columns: ['status', 'available_at', 'created_at', 'id'],
      unique: false,
      predicate: "status = ANY (ARRAY['queued'::text, 'retry-wait'::text])",
    }),
    projectJobIndexDefinitionMatches({
      index: 'project_jobs_recovery_idx',
      columns: ['status', 'lease_expires_at', 'id'],
      unique: false,
      predicate: "status = 'running'::text",
    }),
  ];
  const rows = (await sql.unsafe(
    `select (${[...columnChecks, ...constraintChecks, ...indexChecks].join(' and ')}) as ready`
  )) as Array<Record<string, unknown>>;
  if (rows[0]?.ready !== true) {
    throw new Error(
      'Project RAG durable job lifecycle schema (migration 012) is missing. Run: ' +
        PROJECT_RAG_MIGRATION_COMMAND
    );
  }
}

/**
 * Build-and-publish core: snapshot the current active file versions and make
 * that snapshot the only published build.  Runs strictly inside the caller's
 * transaction — a failure rolls back every staged write, leaving the prior
 * published pointer readable.
 */
export async function writePublishedProjectRagIndexBuildInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  revisionId?: number,
  options: { readonly allowEmpty?: boolean } = {}
): Promise<ProjectRagPostgresIndexBuild> {
  const buildRows = (await tx`
    insert into project_index_builds (project_id, revision_id, status)
    values (${projectId}, ${revisionId ?? null}, 'building')
    returning id
  `) as Array<Record<string, unknown>>;
  const buildId = numberField(buildRows[0]?.id);
  if (!buildId) throw new Error('Project RAG index build creation did not return an id');

  await tx`
    insert into project_index_build_files (
      build_id, project_id, file_id, version_id, source_path, absolute_path, lang,
      status, size_bytes, metadata_quality, skeleton_text, outline_version
    )
    select ${buildId}, f.project_id, f.id, f.active_version_id, f.source_path,
      f.absolute_path, f.lang, f.status, f.size_bytes, f.metadata_quality,
      v.skeleton_text, v.outline_version
    from project_files f
    join project_file_versions v
      on v.id = f.active_version_id
      and v.project_id = f.project_id
      and v.file_id = f.id
    where f.project_id = ${projectId}
      and f.status = 'indexed'
      and f.active_version_id is not null
  `;

  const countRows = (await tx`
    select count(*)::int as count from project_index_build_files where build_id = ${buildId}
  `) as Array<Record<string, unknown>>;
  const fileCount = numberField(countRows[0]?.count);
  if (fileCount === 0 && !options.allowEmpty) {
    await tx`update project_index_builds set status = 'failed', failure_reason = 'empty_build' where id = ${buildId}`;
    throw new Error('Project RAG refuses to publish an empty index build');
  }

  await tx`
    update project_index_builds
    set status = 'retired', retired_at = now()
    where project_id = ${projectId} and status = 'published'
  `;
  const publishedRows = (await tx`
    update project_index_builds
    set status = 'published', published_at = now()
    where id = ${buildId} and status = 'building'
    returning id
  `) as Array<Record<string, unknown>>;
  if (!publishedRows[0]) {
    throw new Error(`Project RAG index build ${buildId} was not published`);
  }
  return { id: buildId, projectId, status: 'published' as const, fileCount };
}

/**
 * Snapshot the current active file versions and atomically make that snapshot
 * the only published build.  A failed ingest never calls this function, so the
 * prior pointer remains readable.  Retired data is retained for deferred GC.
 *
 * Standalone wrapper: opens exactly one fenced transaction unit via
 * {@link beginProjectRagFencedWrite}.  The ingest finalizer composes the same
 * core with snapshot consumption, sync-run completion, and job success inside
 * a single unit instead of calling this wrapper.
 */
export async function publishProjectRagPostgresIndexBuild(
  sql: ProjectRagSql,
  projectId: number,
  revisionId?: number,
  jobFence?: ProjectRagTransactionFence
): Promise<ProjectRagPostgresIndexBuild> {
  return beginProjectRagFencedWrite(
    sql,
    jobFence,
    'Project RAG job lease was lost before index publication',
    (tx) => writePublishedProjectRagIndexBuildInTransaction(tx, projectId, revisionId)
  );
}

export async function getProjectRagPostgresPublishedBuildState(
  sql: ProjectRagSql,
  projectId: number
): Promise<ProjectRagPostgresPublishedBuildState> {
  await assertProjectRagPostgresReadSchemaReady(sql);
  const rows = (await sql`
    select b.id as "buildId", r.dirty_digest as "dirtyDigest"
    from project_index_builds b
    left join project_rag_revisions r on r.id = b.revision_id
    where b.project_id = ${projectId} and b.status = 'published'
    order by b.published_at desc, b.id desc limit 1
  `) as Array<Record<string, unknown>>;
  const buildId = numberField(rows[0]?.buildId);
  if (!buildId)
    throw new Error(`Project RAG has no published index build for project ${projectId}`);
  return {
    buildId,
    dirtyDigest: typeof rows[0]?.dirtyDigest === 'string' ? rows[0].dirtyDigest : null,
  };
}

/** Deferred cleanup: never removes the current published build. */
export async function garbageCollectProjectRagPostgresIndexBuilds(
  sql: ProjectRagSql,
  projectId: number,
  args: { readonly retain?: number } = {}
): Promise<number> {
  const retain = Math.min(Math.max(args.retain ?? 1, 1), 20);
  return beginProjectRagWrite(sql, async (tx) => {
    // Lock the selected retired builds before removing their references. A
    // concurrent GC therefore cannot select the same build twice, and a
    // publisher cannot observe a partially collected build.
    const candidateRows = (await tx`
      select id
      from project_index_builds
      where project_id = ${projectId} and status = 'retired'
      order by retired_at desc nulls last, id desc
      offset ${retain}
      for update
    `) as Array<Record<string, unknown>>;
    const buildIds = candidateRows.map((row) => numberField(row.id)).filter(Boolean);
    if (buildIds.length === 0) return 0;

    // Build-file rows are the reachability roots for immutable versions. Once
    // these retired roots are removed, only versions still referenced by the
    // published/retained builds or by a live file pointer remain reachable.
    await tx`
      delete from project_index_build_files
      where project_id = ${projectId}
        and build_id in ${tx(buildIds)}
    `;
    await tx`
      update project_index_builds
      set status = 'garbage_collected'
      where project_id = ${projectId}
        and id in ${tx(buildIds)}
        and status = 'retired'
    `;

    // Deleting a version cascades its chunks, symbols, edges, and embeddings.
    // Never remove a version still serving as a file pointer or referenced by
    // a retained build; failed/latest candidates remain available for safe
    // recovery and diagnostics.
    await tx`
      delete from project_file_versions v
      where v.project_id = ${projectId}
        and v.status in ('replaced', 'failed')
        and not exists (
          select 1
          from project_index_build_files b
          where b.project_id = v.project_id and b.version_id = v.id
        )
        and not exists (
          select 1
          from project_files f
          where f.project_id = v.project_id
            and (f.active_version_id = v.id or f.latest_version_id = v.id)
        )
    `;
    return buildIds.length;
  });
}

/**
 * Close one or all cached Postgres pools and remove them from the cache.
 *
 * - Without arguments: closes every cached pool.
 * - With a URL: closes only the pool for that URL.
 *
 * Used by tests and shutdown paths.  Normal MCP read handlers must NOT
 * call this – pools are shared across requests.
 */
export async function closeProjectRagPostgresSql(url?: string): Promise<void> {
  if (url !== undefined) {
    // Cache keys are `${url}|max=...|ct=...|ml=...`; match all entries for this URL.
    const matches: string[] = [];
    for (const key of sqlPoolCache.keys()) {
      if (key.startsWith(`${url}|`)) {
        matches.push(key);
      }
    }
    for (const key of matches) {
      const pool = sqlPoolCache.get(key);
      if (pool) {
        await pool.close({ timeout: 1 });
        sqlPoolCache.delete(key);
      }
    }
    return;
  }

  for (const [key, pool] of sqlPoolCache) {
    await pool.close({ timeout: 1 });
    sqlPoolCache.delete(key);
  }
}

export async function listProjectRagPostgresProjects(
  sql: ProjectRagSql,
  args: { readonly includeEphemeral?: boolean; readonly limit?: number } = {}
): Promise<ProjectRagPostgresProject[]> {
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const rows = args.includeEphemeral
    ? ((await sql`
        select id, name, slug, root_path, normalized_root_path, status,
          include_roots, ignore_rules, ephemeral, blocked_finding_allowlist
        from project_repositories
        order by updated_at desc, id desc
        limit ${limit}
      `) as Array<Record<string, unknown>>)
    : ((await sql`
        select id, name, slug, root_path, normalized_root_path, status,
          include_roots, ignore_rules, ephemeral, blocked_finding_allowlist
        from project_repositories
        where ephemeral = false
        order by updated_at desc, id desc
        limit ${limit}
      `) as Array<Record<string, unknown>>);

  return rows.map(projectFromRow);
}

/**
 * Count registered projects. Independent of list limit so health/readiness
 * can sample one project while reporting the true catalog size.
 */
export async function countProjectRagPostgresProjects(
  sql: ProjectRagSql,
  args: { readonly includeEphemeral?: boolean } = {}
): Promise<number> {
  const rows = args.includeEphemeral
    ? ((await sql`
        select count(*)::int as count
        from project_repositories
      `) as Array<Record<string, unknown>>)
    : ((await sql`
        select count(*)::int as count
        from project_repositories
        where ephemeral = false
      `) as Array<Record<string, unknown>>);

  return numberField(rows[0]?.count) ?? 0;
}

/**
 * Pick a representative project for health sampling.
 *
 * Prefer the non-ephemeral project with the most indexed files so an empty
 * recently-touched fixture cannot hide the real operational index behind
 * zeroed sampleStats (list-by-updated_at alone is misleading).
 */
export async function findProjectRagPostgresHealthSample(
  sql: ProjectRagSql
): Promise<ProjectRagPostgresProject | undefined> {
  const rows = (await sql`
    select r.id, r.name, r.slug, r.root_path, r.normalized_root_path, r.status,
      r.include_roots, r.ignore_rules, r.ephemeral, r.blocked_finding_allowlist
    from project_repositories r
    left join lateral (
      select count(*)::int as indexed_file_count
      from project_files f
      where f.project_id = r.id
        and f.status = 'indexed'
    ) stats on true
    where r.ephemeral = false
    order by coalesce(stats.indexed_file_count, 0) desc,
      r.updated_at desc,
      r.id desc
    limit 1
  `) as Array<Record<string, unknown>>;

  return rows[0] ? projectFromRow(rows[0]) : undefined;
}

export async function findProjectRagPostgresProject(
  sql: ProjectRagSql,
  projectRef: string
): Promise<ProjectRagPostgresProject | undefined> {
  const normalizedRef = projectRef.toLowerCase();
  const rows = (await sql`
    select id, name, slug, root_path, normalized_root_path, status,
      include_roots, ignore_rules, ephemeral, blocked_finding_allowlist
    from project_repositories
    where id::text = ${projectRef}
      or lower(slug) = ${normalizedRef}
      or lower(name) = ${normalizedRef}
    limit 1
  `) as Array<Record<string, unknown>>;

  return rows[0] ? projectFromRow(rows[0]) : undefined;
}

/**
 * Resolve one project by its canonical registered root path.  Identity must
 * follow the root that was registered, never a slug or basename guess, so an
 * implicit ingest cannot fork a second project when the registration slug
 * differs from the root basename.
 */
export async function findProjectRagPostgresProjectByRootPath(
  sql: ProjectRagSql,
  rootPath: string
): Promise<ProjectRagPostgresProject | undefined> {
  const rows = (await sql`
    select id, name, slug, root_path, normalized_root_path, status,
      include_roots, ignore_rules, ephemeral, blocked_finding_allowlist
    from project_repositories
    where normalized_root_path = ${rootPath}
       or root_path = ${rootPath}
    order by (normalized_root_path = ${rootPath}) desc, id asc
    limit 1
  `) as Array<Record<string, unknown>>;

  return rows[0] ? projectFromRow(rows[0]) : undefined;
}

export async function listProjectRagPostgresFileStates(
  sql: ProjectRagSql,
  projectId: number
): Promise<ProjectRagPostgresFileState[]> {
  const rows = (await sql`
    select f.source_path as "sourcePath", f.content_hash as "contentHash", f.status,
      v.status as "latestVersionStatus"
    from project_files f
    left join project_file_versions v on v.id = f.latest_version_id
    where f.project_id = ${projectId}
      and coalesce(f.status, '') <> 'deleted'
    order by f.source_path
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    sourcePath: stringField(row.sourcePath),
    contentHash: stringField(row.contentHash),
    status: stringField(row.status),
    latestVersionStatus:
      typeof row.latestVersionStatus === 'string' ? row.latestVersionStatus : null,
  }));
}

export async function getProjectRagPostgresProjectStats(
  sql: ProjectRagSql,
  projectId: number,
  args: { readonly buildId?: number } = {}
): Promise<ProjectRagPostgresProjectStats> {
  await assertProjectRagPostgresReadSchemaReady(sql);
  const rows =
    args.buildId === undefined
      ? ((await sql`
          select
            (select count(*) from project_files where project_id = ${projectId})::int
              as file_count,
            (select count(*) from project_files where project_id = ${projectId}
              and status = 'indexed')::int as indexed_file_count,
            (select count(*) from project_files where project_id = ${projectId}
              and status = 'blocked')::int as blocked_file_count,
            (select count(*) from project_chunks where project_id = ${projectId}
              and enabled = true)::int as chunk_count,
            (select count(*) from project_symbols where project_id = ${projectId})::int
              as symbol_count,
            (select count(*) from project_edges where project_id = ${projectId})::int
              as edge_count,
            (select count(*) from project_embeddings_1024 where project_id = ${projectId})::int
              as embedding_1024_count,
            (select count(*) from project_sync_runs where project_id = ${projectId})::int
              as sync_run_count
        `) as Array<Record<string, unknown>>)
      : ((await sql`
          select
            (select count(*) from project_index_build_files
              where project_id = ${projectId} and build_id = ${args.buildId})::int
              as file_count,
            (select count(*) from project_index_build_files
              where project_id = ${projectId} and build_id = ${args.buildId}
                and status = 'indexed')::int as indexed_file_count,
            (select count(*) from project_files where project_id = ${projectId}
              and status = 'blocked')::int as blocked_file_count,
            (select count(*) from project_chunks c
              join project_index_build_files bf on bf.project_id = c.project_id
                and bf.build_id = ${args.buildId}
                and bf.file_id = c.file_id and bf.version_id = c.version_id
              where c.project_id = ${projectId} and c.enabled = true)::int as chunk_count,
            (select count(*) from project_symbols s
              join project_index_build_files bf on bf.project_id = s.project_id
                and bf.build_id = ${args.buildId}
                and bf.file_id = s.file_id and bf.version_id = s.version_id
              where s.project_id = ${projectId})::int as symbol_count,
            (select count(*) from project_edges e
              join project_index_build_files bf on bf.project_id = e.project_id
                and bf.build_id = ${args.buildId}
                and bf.file_id = e.source_file_id and bf.version_id = e.source_version_id
              where e.project_id = ${projectId})::int as edge_count,
            (select count(*) from project_embeddings_1024 e
              join project_index_build_files bf on bf.project_id = e.project_id
                and bf.build_id = ${args.buildId}
                and bf.file_id = e.file_id and bf.version_id = e.version_id
              where e.project_id = ${projectId})::int as embedding_1024_count,
            (select count(*) from project_sync_runs where project_id = ${projectId})::int
              as sync_run_count
        `) as Array<Record<string, unknown>>);

  return statsFromRow(rows[0] ?? {});
}

function isoStringField(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function getProjectRagPostgresInvariantReport(
  sql: ProjectRagSql,
  project: ProjectRagPostgresProject,
  args: { readonly buildId?: number } = {}
): Promise<ProjectRagPostgresInvariantReport> {
  await assertProjectRagPostgresReadSchemaReady(sql);
  const checkedAt = new Date().toISOString();
  const versionRows = (
    args.buildId !== undefined
      ? await sql`
    select
      count(*) filter (where v.id is not null)::int as "filesWithVersionMetadata",
      count(*) filter (where v.status in ('ready', 'replaced'))::int as "filesWithActiveReadyVersion",
      count(*) filter (where v.id is null or v.status not in ('ready', 'replaced'))::int as "filesWithNonReadyActiveVersion",
      count(*) filter (where v.id is null)::int as "filesPendingVersionBackfill",
      count(*) filter (where v.id is null)::int as "filesUsingLegacyStatusRead",
      count(*) filter (where v.status = 'pending')::int as "pendingVersionCount",
      count(*) filter (where v.status = 'pending' and v.created_at < now() - interval '1 hour')::int as "stalePendingVersionCount"
    from project_index_build_files bf
    left join project_file_versions v
      on v.project_id = bf.project_id and v.file_id = bf.file_id and v.id = bf.version_id
    where bf.project_id = ${project.id} and bf.build_id = ${args.buildId}
  `
      : await sql`
    select
      (select count(*) from project_files
        where project_id = ${project.id} and coalesce(status, '') <> 'deleted'
          and active_version_id is not null)::int
        as "filesWithVersionMetadata",
      (select count(*) from project_files f
        join project_file_versions v on v.id = f.active_version_id
        where f.project_id = ${project.id} and coalesce(f.status, '') <> 'deleted'
          and v.status = 'ready')::int
        as "filesWithActiveReadyVersion",
      (select count(*) from project_files f
        join project_file_versions v on v.id = f.active_version_id
        where f.project_id = ${project.id} and coalesce(f.status, '') <> 'deleted'
          and v.status <> 'ready')::int
        as "filesWithNonReadyActiveVersion",
      (select count(*) from project_files
        where project_id = ${project.id} and coalesce(status, '') <> 'deleted'
          and active_version_id is null)::int
        as "filesPendingVersionBackfill",
      (select count(*) from project_files
        where project_id = ${project.id} and coalesce(status, '') <> 'deleted'
          and active_version_id is null)::int
        as "filesUsingLegacyStatusRead",
      (select count(*) from project_files f
        join project_file_versions v on v.id = f.latest_version_id
        where f.project_id = ${project.id}
          and coalesce(f.status, '') <> 'deleted'
          and v.status = 'pending'
          and v.id is distinct from f.active_version_id)::int
        as "pendingVersionCount",
      (select count(*) from project_files f
        join project_file_versions v on v.id = f.latest_version_id
        where f.project_id = ${project.id}
          and coalesce(f.status, '') <> 'deleted'
          and v.status = 'pending'
          and v.id is distinct from f.active_version_id
          and v.created_at < now() - interval '1 hour')::int
        as "stalePendingVersionCount"
  `
  ) as Array<Record<string, unknown>>;
  const versionReadiness = {
    filesWithVersionMetadata: numberField(versionRows[0]?.filesWithVersionMetadata),
    filesWithActiveReadyVersion: numberField(versionRows[0]?.filesWithActiveReadyVersion),
    filesWithNonReadyActiveVersion: numberField(versionRows[0]?.filesWithNonReadyActiveVersion),
    filesPendingVersionBackfill: numberField(versionRows[0]?.filesPendingVersionBackfill),
    filesUsingLegacyStatusRead: numberField(versionRows[0]?.filesUsingLegacyStatusRead),
    pendingVersionCount: numberField(versionRows[0]?.pendingVersionCount),
    stalePendingVersionCount: numberField(versionRows[0]?.stalePendingVersionCount),
  };

  const fileRows =
    args.buildId === undefined
      ? ((await sql`
          select id, source_path as "sourcePath", absolute_path as "absolutePath",
            content_hash as "contentHash", file_modified_at as "fileModifiedAt",
            size_bytes as "sizeBytes", status
          from project_files
          where project_id = ${project.id}
            and coalesce(status, '') <> 'deleted'
          order by source_path asc
        `) as Array<Record<string, unknown>>)
      : ((await sql`
          select coalesce(bf.file_id, f.id) as id,
            coalesce(bf.source_path, f.source_path) as "sourcePath",
            coalesce(bf.absolute_path, f.absolute_path) as "absolutePath",
            coalesce(v.content_hash, f.content_hash, '') as "contentHash",
            coalesce(v.file_modified_at, f.file_modified_at) as "fileModifiedAt",
            coalesce(bf.size_bytes, v.size_bytes, f.size_bytes) as "sizeBytes",
            coalesce(bf.status, f.status) as status, f.status as "workspaceStatus"
          from project_files f
          left join project_index_build_files bf
            on bf.project_id = f.project_id and bf.file_id = f.id
            and bf.build_id = ${args.buildId}
          left join project_file_versions v
            on v.project_id = bf.project_id and v.file_id = bf.file_id
            and v.id = bf.version_id
          where f.project_id = ${project.id}
            and (bf.file_id is not null or f.status = 'blocked')
          order by coalesce(bf.source_path, f.source_path) asc
        `) as Array<Record<string, unknown>>);
  const trackedPaths = new Set<string>();
  const indexedPaths = new Set<string>();
  const blockedPaths = new Set<string>();
  const indexedFileRows: Array<Record<string, unknown>> = [];

  for (const row of fileRows) {
    const sourcePath = normalizeSourcePath(stringField(row.sourcePath));
    if (sourcePath.length === 0) {
      continue;
    }
    trackedPaths.add(sourcePath);
    if (stringField(row.status) === 'blocked' || stringField(row.workspaceStatus) === 'blocked') {
      blockedPaths.add(sourcePath);
    }
    if (stringField(row.status) === 'indexed') {
      indexedPaths.add(sourcePath);
      indexedFileRows.push(row);
    }
  }

  let freshFiles = 0;
  let staleFiles = 0;
  let missingFiles = 0;
  let metadataDriftFiles = 0;
  let unverifiedFiles = 0;
  const stalePaths: string[] = [];

  for (const row of indexedFileRows) {
    const sourcePath = normalizeSourcePath(stringField(row.sourcePath));
    const absolutePath = stringField(row.absolutePath);
    const indexedHash = stringField(row.contentHash);
    const indexedModifiedAt = numberField(row.fileModifiedAt);
    const indexedSize = numberField(row.sizeBytes);

    try {
      const currentStats = await stat(absolutePath);
      const content = await readFile(absolutePath, 'utf8');
      const currentHash = await calculateProjectContentHash(content);
      if (currentHash !== indexedHash) {
        staleFiles += 1;
        samplePush(stalePaths, sourcePath);
        continue;
      }
      const currentModifiedAt = Math.floor(currentStats.mtimeMs);
      if (currentModifiedAt !== indexedModifiedAt || currentStats.size !== indexedSize) {
        metadataDriftFiles += 1;
        samplePush(stalePaths, sourcePath);
        continue;
      }
      freshFiles += 1;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (code === 'ENOENT') {
        missingFiles += 1;
        samplePush(stalePaths, sourcePath);
        continue;
      }
      unverifiedFiles += 1;
      samplePush(
        stalePaths,
        `${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const freshnessStatus: ProjectInvariantFreshnessStatus =
    unverifiedFiles > 0
      ? 'unverified'
      : missingFiles > 0
        ? 'missing'
        : staleFiles > 0
          ? 'stale'
          : metadataDriftFiles > 0
            ? 'fresh_with_metadata_drift'
            : 'fresh';

  let scopeStatus: ProjectInvariantCoverageStatus = 'unverified';
  let scopeReason = 'missing_include_roots';
  let expectedFiles = 0;
  let missingExpectedFiles = 0;
  let blockedExpectedFiles = 0;
  let extraIndexedFiles = 0;
  let ignoredExpectedFiles = 0;
  let ignoredIndexedFiles = 0;
  let missingExpectedPaths: string[] = [];
  let blockedExpectedPaths: string[] = [];
  let extraIndexedPaths: string[] = [];
  let ignoredExpectedPaths: string[] = [];
  let ignoredIndexedPaths: string[] = [];

  if (project.includeRoots.length > 0) {
    try {
      const scope = await scanExpectedProjectSourcePaths(
        project.normalizedRootPath || project.rootPath,
        project.includeRoots,
        project.ignoreRules
      );
      const expectedPathList = [...scope.expectedPaths].sort();
      const ignoredExpectedPathList = [...scope.ignoredExpectedPaths].sort();
      const indexedPathList = [...indexedPaths].sort();
      const missingExpectedPathList = expectedPathList.filter(
        (sourcePath) => !trackedPaths.has(sourcePath)
      );
      const blockedExpectedPathList = expectedPathList.filter((sourcePath) =>
        blockedPaths.has(sourcePath)
      );
      const extraIndexedPathList = indexedPathList.filter(
        (sourcePath) =>
          !scope.expectedPaths.has(sourcePath) && !scope.ignoredExpectedPaths.has(sourcePath)
      );
      const ignoredIndexedPathList = indexedPathList.filter(
        (sourcePath) =>
          scope.ignoredExpectedPaths.has(sourcePath) ||
          isPathIgnored(sourcePath, project.ignoreRules)
      );

      expectedFiles = expectedPathList.length;
      missingExpectedFiles = missingExpectedPathList.length;
      blockedExpectedFiles = blockedExpectedPathList.length;
      extraIndexedFiles = extraIndexedPathList.length;
      ignoredExpectedFiles = ignoredExpectedPathList.length;
      ignoredIndexedFiles = ignoredIndexedPathList.length;
      missingExpectedPaths = missingExpectedPathList.slice(0, POSTGRES_INVARIANT_SAMPLE_LIMIT);
      blockedExpectedPaths = blockedExpectedPathList.slice(0, POSTGRES_INVARIANT_SAMPLE_LIMIT);
      extraIndexedPaths = extraIndexedPathList.slice(0, POSTGRES_INVARIANT_SAMPLE_LIMIT);
      ignoredExpectedPaths = ignoredExpectedPathList.slice(0, POSTGRES_INVARIANT_SAMPLE_LIMIT);
      ignoredIndexedPaths = ignoredIndexedPathList.slice(0, POSTGRES_INVARIANT_SAMPLE_LIMIT);
      scopeStatus =
        missingExpectedFiles > 0 || extraIndexedFiles > 0 || ignoredIndexedFiles > 0
          ? 'drift'
          : 'covered';
      scopeReason =
        'Postgres verification enumerates includeRoots and compares eligible files against project_files.';
    } catch (error) {
      scopeReason = `scope_scan_failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const embeddingRows = (await sql`
    with enabled_chunks as (
      select
        c.id,
        c.version_id,
        case
          when ${args.buildId ?? null}::bigint is null then f.active_version_id
          else c.version_id
        end as active_version_id,
        md5(coalesce(nullif(c.searchable_text, ''), c.content)) as source_hash
      from project_chunks c
      join project_files f on f.id = c.file_id and f.project_id = c.project_id
      where c.project_id = ${project.id}
        and (c.enabled = true or ${args.buildId ?? null}::bigint is not null)
        and (
          exists (
            select 1
            from project_index_build_files bf
            join project_index_builds b
              on b.id = bf.build_id and b.project_id = bf.project_id
            where bf.project_id = c.project_id
              and bf.file_id = c.file_id
              and bf.version_id = c.version_id
              and (${args.buildId ?? null}::bigint is not null or b.status = 'published')
              and (
                ${args.buildId ?? null}::bigint is null
                or bf.build_id = ${args.buildId ?? null}
              )
          )
        )
    ),
    valid_embeddings as (
      select e.chunk_id
      from project_embeddings_1024 e
      join enabled_chunks c on c.id = e.chunk_id
      where e.project_id = ${project.id}
        and e.owner_type = 'chunk'
        and e.embedding_profile_hash = ${POSTGRES_EXPECTED_EMBEDDING_PROFILE_HASH}
        and e.embedding_model = ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
        and e.embedding_provider = ${POSTGRES_EXPECTED_EMBEDDING_PROVIDER}
        and e.dimensions = ${POSTGRES_EXPECTED_EMBEDDING_DIMENSIONS}
        and c.version_id is not null
        and c.version_id = c.active_version_id
        and e.version_id = c.version_id
        and (e.source_hash is null or e.source_hash = c.source_hash)
    )
    select
      (select count(*) from enabled_chunks)::int as "chunkOwners",
      (select count(distinct e.chunk_id) from project_embeddings_1024 e
        join enabled_chunks c on c.id = e.chunk_id
        where e.project_id = ${project.id} and e.owner_type = 'chunk' and e.chunk_id is not null)::int
        as "embeddingOwners",
      (select count(*) from project_embeddings_1024 e
        join enabled_chunks c on c.id = e.chunk_id
        where e.project_id = ${project.id} and e.owner_type = 'chunk')::int
        as "embeddingRecords",
      (select count(distinct chunk_id) from valid_embeddings)::int
        as "ownersWithValidEmbedding",
      (select count(*) from enabled_chunks c
        where not exists (select 1 from valid_embeddings v where v.chunk_id = c.id))::int
        as "missingOwners",
      (select count(distinct c.id) from enabled_chunks c
        join project_embeddings_1024 e on e.chunk_id = c.id
        where e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and e.embedding_model = ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
          and e.embedding_provider = ${POSTGRES_EXPECTED_EMBEDDING_PROVIDER}
          and e.dimensions = ${POSTGRES_EXPECTED_EMBEDDING_DIMENSIONS}
          and e.source_hash is not null
          and e.source_hash <> c.source_hash)::int as "staleOwners",
      (select count(distinct c.id) from enabled_chunks c
        join project_embeddings_1024 e on e.chunk_id = c.id
        where e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and e.embedding_model <> ${POSTGRES_EXPECTED_EMBEDDING_MODEL})::int
        as "modelMismatchOwners",
      (select count(distinct c.id) from enabled_chunks c
        join project_embeddings_1024 e on e.chunk_id = c.id
        where e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and e.embedding_model = ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
          and coalesce(e.embedding_provider, '') <> ${POSTGRES_EXPECTED_EMBEDDING_PROVIDER})::int
        as "providerMismatchOwners",
      (select count(distinct c.id) from enabled_chunks c
        join project_embeddings_1024 e on e.chunk_id = c.id
        where e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and e.embedding_model = ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
          and e.dimensions <> ${POSTGRES_EXPECTED_EMBEDDING_DIMENSIONS})::int
        as "dimensionMismatchOwners",
      (select count(*) from enabled_chunks c
        where c.version_id is null
          or c.active_version_id is null
          or c.version_id <> c.active_version_id)::int
        as "chunkVersionGaps",
      (select count(distinct c.id) from enabled_chunks c
        join project_embeddings_1024 e on e.chunk_id = c.id
        where e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and e.embedding_model = ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
          and e.version_id is null)::int
        as "embeddingVersionGaps",
      (select count(distinct c.id) from enabled_chunks c
        join project_embeddings_1024 e on e.chunk_id = c.id
        where e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and e.embedding_model = ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
          and c.version_id is not null
          and e.version_id is not null
          and e.version_id <> c.version_id)::int
        as "embeddingVersionMismatchOwners",
      (select coalesce(array_agg(c.id::text order by c.id), '{}') from (
        select c.id from enabled_chunks c
        where not exists (select 1 from valid_embeddings v where v.chunk_id = c.id)
        order by c.id
        limit ${POSTGRES_INVARIANT_SAMPLE_LIMIT}
      ) c) as "missingOwnerSample",
      (select coalesce(array_agg(c.id::text order by c.id), '{}') from (
        select distinct c.id
        from enabled_chunks c
        join project_embeddings_1024 e on e.chunk_id = c.id
        where e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and e.embedding_model = ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
          and e.embedding_provider = ${POSTGRES_EXPECTED_EMBEDDING_PROVIDER}
          and e.dimensions = ${POSTGRES_EXPECTED_EMBEDDING_DIMENSIONS}
          and e.source_hash is not null
          and e.source_hash <> c.source_hash
        order by c.id
        limit ${POSTGRES_INVARIANT_SAMPLE_LIMIT}
      ) c) as "staleOwnerSample",
      (select coalesce(array_agg(c.id::text order by c.id), '{}') from (
        select distinct c.id
        from enabled_chunks c
        join project_embeddings_1024 e on e.chunk_id = c.id
        where e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and (
            e.embedding_model <> ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
            or coalesce(e.embedding_provider, '') <> ${POSTGRES_EXPECTED_EMBEDDING_PROVIDER}
            or e.dimensions <> ${POSTGRES_EXPECTED_EMBEDDING_DIMENSIONS}
          )
        order by c.id
        limit ${POSTGRES_INVARIANT_SAMPLE_LIMIT}
      ) c) as "mismatchOwnerSample"
      ,
      (select coalesce(array_agg(c.id::text order by c.id), '{}') from (
        select distinct c.id
        from enabled_chunks c
        left join project_embeddings_1024 e
          on e.chunk_id = c.id
          and e.project_id = ${project.id}
          and e.owner_type = 'chunk'
          and e.embedding_model = ${POSTGRES_EXPECTED_EMBEDDING_MODEL}
        where c.version_id is null
          or c.active_version_id is null
          or c.version_id <> c.active_version_id
          or e.version_id is null
          or e.version_id <> c.version_id
        order by c.id
        limit ${POSTGRES_INVARIANT_SAMPLE_LIMIT}
      ) c) as "versionMismatchOwnerSample"
  `) as Array<Record<string, unknown>>;
  const embeddingRow = embeddingRows[0] ?? {};
  const embeddingCoverage: ProjectEmbeddingInvariantSummary = {
    status:
      numberField(embeddingRow.missingOwners) > 0 ||
      numberField(embeddingRow.staleOwners) > 0 ||
      numberField(embeddingRow.modelMismatchOwners) > 0 ||
      numberField(embeddingRow.providerMismatchOwners) > 0 ||
      numberField(embeddingRow.dimensionMismatchOwners) > 0 ||
      numberField(embeddingRow.chunkVersionGaps) > 0 ||
      numberField(embeddingRow.embeddingVersionGaps) > 0 ||
      numberField(embeddingRow.embeddingVersionMismatchOwners) > 0
        ? 'drift'
        : 'covered',
    expectedModel: POSTGRES_EXPECTED_EMBEDDING_MODEL,
    expectedProvider: POSTGRES_EXPECTED_EMBEDDING_PROVIDER,
    expectedDimensions: POSTGRES_EXPECTED_EMBEDDING_DIMENSIONS,
    chunkOwners: numberField(embeddingRow.chunkOwners),
    embeddingOwners: numberField(embeddingRow.embeddingOwners),
    embeddingRecords: numberField(embeddingRow.embeddingRecords),
    ownersWithValidEmbedding: numberField(embeddingRow.ownersWithValidEmbedding),
    missingOwners: numberField(embeddingRow.missingOwners),
    staleOwners: numberField(embeddingRow.staleOwners),
    modelMismatchOwners: numberField(embeddingRow.modelMismatchOwners),
    providerMismatchOwners: numberField(embeddingRow.providerMismatchOwners),
    dimensionMismatchOwners: numberField(embeddingRow.dimensionMismatchOwners),
    invalidVectorLengthOwners: 0,
    chunkVersionGaps: numberField(embeddingRow.chunkVersionGaps),
    embeddingVersionGaps: numberField(embeddingRow.embeddingVersionGaps),
    embeddingVersionMismatchOwners: numberField(embeddingRow.embeddingVersionMismatchOwners),
    missingOwnerSample: stringArrayField(embeddingRow.missingOwnerSample),
    staleOwnerSample: stringArrayField(embeddingRow.staleOwnerSample),
    mismatchOwnerSample: stringArrayField(embeddingRow.mismatchOwnerSample),
    versionMismatchOwnerSample: stringArrayField(embeddingRow.versionMismatchOwnerSample),
  };

  const ownershipRows = (await sql`
    with build_bound_files as (
      select distinct bf.project_id, bf.file_id, bf.version_id
      from project_index_build_files bf
      join project_index_builds b
        on b.id = bf.build_id and b.project_id = bf.project_id
      where bf.project_id = ${project.id}
        and (${args.buildId ?? null}::bigint is not null or b.status = 'published')
        and (
          ${args.buildId ?? null}::bigint is null
          or bf.build_id = ${args.buildId ?? null}
        )
    )
    select
      (select count(*) from project_chunks c
        join build_bound_files bf on bf.project_id = c.project_id
          and bf.file_id = c.file_id and bf.version_id = c.version_id
        left join project_files f on f.id = c.file_id
        where c.project_id = ${project.id} and f.id is null)::int as "chunkFileOrphans",
      (select count(*) from project_symbols s
        join build_bound_files bf on bf.project_id = s.project_id
          and bf.file_id = s.file_id and bf.version_id = s.version_id
        left join project_files f on f.id = s.file_id
        where s.project_id = ${project.id} and f.id is null)::int as "symbolFileOrphans",
      (select count(*) from project_symbols s
        join build_bound_files bf on bf.project_id = s.project_id
          and bf.file_id = s.file_id and bf.version_id = s.version_id
        left join project_chunks c on c.id = s.chunk_id
        where s.project_id = ${project.id} and s.chunk_id is not null and c.id is null)::int
        as "symbolChunkOrphans",
      (select count(*) from project_edges e
        join build_bound_files bf on bf.project_id = e.project_id
          and bf.file_id = e.source_file_id and bf.version_id = e.source_version_id
        left join project_files f on f.id = e.source_file_id
        where e.project_id = ${project.id} and e.source_file_id is not null and f.id is null)::int
        as "edgeMissingSourceFileRefs",
      (select count(*) from project_edges e
        join build_bound_files bf on bf.project_id = e.project_id
          and bf.file_id = e.target_file_id and bf.version_id = e.target_version_id
        left join project_files f on f.id = e.target_file_id
        where e.project_id = ${project.id} and e.target_file_id is not null and f.id is null)::int
        as "edgeMissingTargetFileRefs",
      (select count(*) from project_edges e
        join build_bound_files bf on bf.project_id = e.project_id
          and bf.file_id = e.source_file_id and bf.version_id = e.source_version_id
        left join project_symbols s on s.id = e.source_symbol_id
        where e.project_id = ${project.id} and e.source_symbol_id is not null and s.id is null)::int
        as "edgeMissingSourceSymbolRefs",
      (select count(*) from project_edges e
        join build_bound_files bf on bf.project_id = e.project_id
          and bf.file_id = e.target_file_id and bf.version_id = e.target_version_id
        left join project_symbols s on s.id = e.target_symbol_id
        where e.project_id = ${project.id} and e.target_symbol_id is not null and s.id is null)::int
        as "edgeMissingTargetSymbolRefs",
      (select count(*) from project_chunks c
        join build_bound_files bf on bf.project_id = c.project_id
          and bf.file_id = c.file_id and bf.version_id = c.version_id
        join project_files f on f.id = c.file_id
        where c.project_id = ${project.id}
          and ${args.buildId ?? null}::bigint is null
          and f.status = 'deleted')::int as "deletedFileChunkRefs",
      (select count(*) from project_symbols s
        join build_bound_files bf on bf.project_id = s.project_id
          and bf.file_id = s.file_id and bf.version_id = s.version_id
        join project_files f on f.id = s.file_id
        where s.project_id = ${project.id}
          and ${args.buildId ?? null}::bigint is null
          and f.status = 'deleted')::int as "deletedFileSymbolRefs",
      (select count(*) from project_edges e
        join build_bound_files bf on bf.project_id = e.project_id
          and bf.file_id = e.source_file_id and bf.version_id = e.source_version_id
        left join project_files sf on sf.id = e.source_file_id
        left join project_files tf on tf.id = e.target_file_id
        where e.project_id = ${project.id}
          and ${args.buildId ?? null}::bigint is null
          and (sf.status = 'deleted' or tf.status = 'deleted'))::int as "deletedFileEdgeRefs"
  `) as Array<Record<string, unknown>>;
  const ownershipRow = ownershipRows[0] ?? {};
  const ownershipCounts = {
    chunkFileOrphans: numberField(ownershipRow.chunkFileOrphans),
    symbolFileOrphans: numberField(ownershipRow.symbolFileOrphans),
    symbolChunkOrphans: numberField(ownershipRow.symbolChunkOrphans),
    edgeMissingSourceFileRefs: numberField(ownershipRow.edgeMissingSourceFileRefs),
    edgeMissingTargetFileRefs: numberField(ownershipRow.edgeMissingTargetFileRefs),
    edgeMissingSourceSymbolRefs: numberField(ownershipRow.edgeMissingSourceSymbolRefs),
    edgeMissingTargetSymbolRefs: numberField(ownershipRow.edgeMissingTargetSymbolRefs),
    deletedFileChunkRefs: numberField(ownershipRow.deletedFileChunkRefs),
    deletedFileSymbolRefs: numberField(ownershipRow.deletedFileSymbolRefs),
    deletedFileEdgeRefs: numberField(ownershipRow.deletedFileEdgeRefs),
  };
  const ownershipDrift = Object.values(ownershipCounts).some((count) => count > 0);
  const ownershipCoverage: ProjectOwnershipInvariantSummary = {
    status: ownershipDrift ? 'drift' : 'covered',
    ...ownershipCounts,
    sampleRefs: [],
  };

  const syncRows = (await sql`
    select completed_at as "completedAt"
    from project_sync_runs
    where project_id = ${project.id}
      and status in ('completed', 'partial')
    order by completed_at desc nulls last, started_at desc
    limit 1
  `) as Array<Record<string, unknown>>;

  return {
    versionReadiness,
    freshness: {
      status: freshnessStatus,
      checkedFiles: indexedFileRows.length,
      eligibleFiles: indexedFileRows.length,
      freshFiles,
      staleFiles,
      missingFiles,
      metadataDriftFiles,
      unverifiedFiles,
      stalePaths,
      checkedAt,
      reason: 'Postgres verification checks indexed files for filesystem freshness.',
      versionSignals: versionReadiness,
    },
    scopeCoverage: {
      status: scopeStatus,
      checkedAt,
      expectedFiles,
      trackedFiles: trackedPaths.size,
      indexedFiles: indexedPaths.size,
      missingExpectedFiles,
      blockedExpectedFiles,
      extraIndexedFiles,
      ignoredExpectedFiles,
      ignoredIndexedFiles,
      missingExpectedPaths,
      blockedExpectedPaths,
      extraIndexedPaths,
      ignoredExpectedPaths,
      ignoredIndexedPaths,
      reason: scopeReason,
    },
    embeddingCoverage,
    ownershipCoverage,
    lastSyncAt: isoStringField(syncRows[0]?.completedAt),
  };
}

export async function upsertProjectRagPostgresRepositoryInTransaction(
  tx: ProjectRagWriteSql,
  input: ProjectRagPostgresRepositoryInput
): Promise<number> {
  const allowlistExplicit = input.blockedFindingAllowlist !== undefined;
  if (allowlistExplicit && input.blockedFindingAllowlist) {
    validateRepositoryAllowlist(
      input.blockedFindingAllowlist as readonly BlockedFindingAllowlistEntry[]
    );
  }
  const allowlistValue = allowlistExplicit ? JSON.stringify(input.blockedFindingAllowlist) : '[]';
  const includeRootsExplicit = input.includeRoots !== undefined;
  const ignoreRulesExplicit = input.ignoreRules !== undefined;
  const includeRootsValue = includeRootsExplicit ? textArrayLiteral(input.includeRoots) : null;
  const ignoreRulesValue = ignoreRulesExplicit ? textArrayLiteral(input.ignoreRules) : null;
  const rows = (await tx`
    insert into project_repositories (
      name, slug, root_path, normalized_root_path, status, sync_mode,
      include_roots, ignore_rules, ephemeral, metadata,
      blocked_finding_allowlist
    )
    values (
      ${input.name}, ${input.slug}, ${input.rootPath}, ${input.normalizedRootPath},
      ${input.status ?? 'active'}, ${input.syncMode ?? 'full'},
       coalesce(${includeRootsValue}::text[], '{}'::text[]),
       coalesce(${ignoreRulesValue}::text[], '{}'::text[]),
      ${input.ephemeral ?? false}, ${JSON.stringify(input.metadata ?? {})}::jsonb,
      ${allowlistValue}::jsonb
    )
    on conflict (slug) do update set
      name = excluded.name,
      root_path = excluded.root_path,
      normalized_root_path = excluded.normalized_root_path,
      status = excluded.status,
      sync_mode = excluded.sync_mode,
       include_roots = case when ${includeRootsExplicit} then excluded.include_roots else project_repositories.include_roots end,
       ignore_rules = case when ${ignoreRulesExplicit} then excluded.ignore_rules else project_repositories.ignore_rules end,
      ephemeral = excluded.ephemeral,
      metadata = excluded.metadata,
      blocked_finding_allowlist = case
        when ${allowlistExplicit} then ${allowlistValue}::jsonb
        else project_repositories.blocked_finding_allowlist
      end,
      updated_at = now()
    returning id
  `) as Array<{ id: number | string }>;

  return numberField(rows[0]?.id);
}

export async function upsertProjectRagPostgresRepository(
  sql: ProjectRagSql,
  input: ProjectRagPostgresRepositoryInput
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    upsertProjectRagPostgresRepositoryInTransaction(tx, input)
  );
}

/** Persist Git repository, worktree, and revision identity independently of legacy datasets. */
export async function upsertProjectRagWorkspaceContextInTransaction(
  tx: ProjectRagWriteSql,
  input: ProjectRagWorkspaceContextInput
): Promise<ProjectRagWorkspaceContextRecord> {
  const repositoryRows = (await tx`
    insert into project_rag_repositories (git_common_dir, remote_url, repository_hash)
    values (${input.repositoryCommonDir}, ${input.remoteUrl}, ${input.repositoryHash ?? null})
    on conflict (git_common_dir) do update set
      remote_url = excluded.remote_url,
      repository_hash = excluded.repository_hash,
      updated_at = now()
    returning id
  `) as Array<Record<string, unknown>>;
  const repositoryId = numberField(repositoryRows[0]?.id);
  if (!repositoryId) throw new Error('Project RAG context repository upsert did not return an id');

  const workspaceRows = (await tx`
    insert into project_rag_workspaces (
      repository_id, canonical_root_path, worktree_git_dir, workspace_hash
    )
    values (
      ${repositoryId}, ${input.workspaceRoot}, ${input.worktreeGitDir ?? null},
      ${input.workspaceHash ?? null}
    )
    on conflict (canonical_root_path) do update set
      repository_id = excluded.repository_id,
      worktree_git_dir = excluded.worktree_git_dir,
      workspace_hash = excluded.workspace_hash,
      updated_at = now()
    returning id
  `) as Array<Record<string, unknown>>;
  const workspaceId = numberField(workspaceRows[0]?.id);
  if (!workspaceId) throw new Error('Project RAG context workspace upsert did not return an id');

  const revisionRows = (await tx`
    insert into project_rag_revisions (
      workspace_id, head_oid, branch_name, is_detached, is_unborn, dirty_digest,
      head_hash, branch_hash, detached_hash, content_hash, status_digest,
      content_fingerprint, identity_digest
    )
    values (
      ${workspaceId}, ${input.headOid}, ${input.branchName}, ${input.isDetached},
      ${input.isUnborn ?? false}, ${input.dirtyDigest}, ${input.headHash ?? null},
      ${input.branchHash ?? null}, ${input.detachedHash ?? null}, ${input.contentHash ?? null},
      ${input.statusDigest ?? null}, ${input.contentFingerprint ?? null},
      ${input.identityDigest ?? null}
    )
    on conflict (workspace_id, (coalesce(head_oid, '')), (coalesce(branch_name, '')), is_detached, dirty_digest)
    do update set
      is_unborn = excluded.is_unborn,
      head_hash = excluded.head_hash,
      branch_hash = excluded.branch_hash,
      detached_hash = excluded.detached_hash,
      content_hash = excluded.content_hash,
      status_digest = excluded.status_digest,
      content_fingerprint = excluded.content_fingerprint,
      identity_digest = excluded.identity_digest,
      captured_at = now()
    returning id
  `) as Array<Record<string, unknown>>;
  const revisionId = numberField(revisionRows[0]?.id);
  if (!revisionId) throw new Error('Project RAG context revision upsert did not return an id');

  return { ...input, repositoryId, workspaceId, revisionId };
}

export async function upsertProjectRagWorkspaceContext(
  sql: ProjectRagSql,
  input: ProjectRagWorkspaceContextInput
): Promise<ProjectRagWorkspaceContextRecord> {
  return beginProjectRagWrite(sql, (tx) =>
    upsertProjectRagWorkspaceContextInTransaction(tx, input)
  );
}

/** Bind a compatibility alias to one explicit worktree; no slug guessing occurs here. */
export async function upsertProjectRagWorkspaceAliasInTransaction(
  tx: ProjectRagWriteSql,
  args: { readonly workspaceId: number; readonly alias: string; readonly legacyProjectId?: number }
): Promise<void> {
  const alias = args.alias.trim();
  if (!alias || alias.length > 255) {
    throw new Error('Project RAG workspace alias must contain 1 to 255 characters');
  }
  await tx`
    insert into project_rag_workspace_aliases (workspace_id, alias, alias_normalized, legacy_project_id)
    values (${args.workspaceId}, ${alias}, ${alias.toLowerCase()}, ${args.legacyProjectId ?? null})
    on conflict (alias_normalized) do update set
      workspace_id = excluded.workspace_id,
      alias = excluded.alias,
      legacy_project_id = excluded.legacy_project_id
  `;
}

export async function upsertProjectRagWorkspaceAlias(
  sql: ProjectRagSql,
  args: { readonly workspaceId: number; readonly alias: string; readonly legacyProjectId?: number }
): Promise<void> {
  return beginProjectRagWrite(sql, (tx) => upsertProjectRagWorkspaceAliasInTransaction(tx, args));
}

/**
 * Upsert one file and its deferred/immediate version inside the caller's
 * transaction.  Multi-statement mutator — callers MUST already be inside a
 * transaction unit opened by the transaction module.
 */
export async function upsertProjectRagPostgresFileInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  input: ProjectRagPostgresFileInput,
  versionStatus: string = 'ready'
): Promise<{ fileId: number; versionId?: number }> {
  const fileStatus = input.status ?? 'indexed';
  const metadataQuality = input.metadataQuality ?? 'minimal';
  const rows = (await tx`
    insert into project_files (
      project_id, source_path, absolute_path, content_hash, file_modified_at,
      lang, ecosystem, size_bytes, status, metadata_quality, skeleton_text,
      outline_version, metadata
    )
    values (
      ${projectId}, ${input.sourcePath}, ${input.absolutePath}, ${input.contentHash},
      ${input.fileModifiedAt}, ${input.lang ?? null}, ${input.ecosystem ?? null},
      ${input.sizeBytes ?? 0}, ${fileStatus}, ${metadataQuality},
      ${input.skeletonText ?? null}, ${input.outlineVersion ?? null},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    on conflict (project_id, source_path) do update set
      absolute_path = excluded.absolute_path,
      content_hash = excluded.content_hash,
      file_modified_at = excluded.file_modified_at,
      lang = excluded.lang,
      ecosystem = excluded.ecosystem,
      size_bytes = excluded.size_bytes,
      status = excluded.status,
      metadata_quality = excluded.metadata_quality,
      skeleton_text = excluded.skeleton_text,
      outline_version = excluded.outline_version,
      metadata = excluded.metadata,
      updated_at = now()
    returning id, active_version_id as "activeVersionId"
  `) as Array<{ id: number | string; activeVersionId?: number | string | null }>;

  const fileId = numberField(rows[0]?.id);
  if (!fileId) {
    return { fileId: 0 };
  }

  const activeVersionId = optionalNumberField(rows[0]?.activeVersionId);
  // Only mark old version as 'replaced' when the NEW version is immediately 'ready'.
  // When versionStatus is deferred (e.g. 'pending'), the old version stays active
  // until promoteProjectRagPostgresFileVersions is called, preserving search integrity
  // during embedding generation.
  const isReady = versionStatus === 'ready';
  if (isReady && activeVersionId) {
    await tx`
      update project_file_versions
      set status = 'replaced',
        replaced_at = now(),
        updated_at = now()
      where id = ${activeVersionId}
        and status = 'ready'
    `;
    // A blocked file is excluded from the next build by its file status, but
    // its prior chunks must remain untouched until that build is published.
    // Otherwise readers of the still-published build would observe a partial
    // state while the candidate is being prepared.
    if (fileStatus !== 'blocked') {
      await tx`
        update project_chunks
        set enabled = false,
          updated_at = now()
        where project_id = ${projectId}
          and file_id = ${fileId}
          and version_id = ${activeVersionId}
          and enabled = true
      `;
    }
  }

  const versionRows = (await tx`
    insert into project_file_versions (
      project_id, file_id, status, content_hash, file_modified_at, size_bytes,
      lang, metadata_quality, skeleton_text, outline_version, compatibility_status,
      ready_at, promoted_at
    )
    values (
      ${projectId}, ${fileId}, ${versionStatus}, ${input.contentHash}, ${input.fileModifiedAt},
      ${input.sizeBytes ?? 0}, ${input.lang ?? null}, ${metadataQuality},
      ${input.skeletonText ?? null}, ${input.outlineVersion ?? null}, ${fileStatus},
      ${isReady ? new Date().toISOString() : null},
      ${isReady ? new Date().toISOString() : null}
    )
    returning id
  `) as Array<{ id: number | string }>;
  const versionId = numberField(versionRows[0]?.id);

  if (isReady) {
    await tx`
      update project_files
      set active_version_id = ${versionId},
        latest_version_id = ${versionId},
        updated_at = now()
      where project_id = ${projectId}
        and id = ${fileId}
    `;
  } else {
    await tx`
      update project_files
      set latest_version_id = ${versionId},
        updated_at = now()
      where project_id = ${projectId}
        and id = ${fileId}
    `;
  }

  return { fileId, versionId };
}

/** Standalone wrapper: opens exactly one write unit around the file upsert. */
export async function upsertProjectRagPostgresFile(
  sql: ProjectRagSql,
  projectId: number,
  input: ProjectRagPostgresFileInput,
  versionStatus: string = 'ready'
): Promise<{ fileId: number; versionId?: number }> {
  return beginProjectRagWrite(sql, (tx) =>
    upsertProjectRagPostgresFileInTransaction(tx, projectId, input, versionStatus)
  );
}

/**
 * Upsert a file and replace its chunks inside the caller's transaction.
 *
 * In-transaction half of {@link upsertProjectRagPostgresFileWithChunks}: the
 * active version pointer and chunk rows stay consistent with whatever unit the
 * caller is composing (e.g. the ingest per-file write group that also replaces
 * symbols and edges).
 */
/**
 * Upsert a file and replace its candidate chunks inside the caller's
 * transaction.
 *
 * In-transaction half of {@link upsertProjectRagPostgresFileWithChunks}: the
 * version is always created as a 'pending' candidate, its chunks are written
 * through the candidate-guarded replace, and when the caller asked for an
 * immediately-ready version the promotion (old-active replacement, pointer
 * swap) happens in the same unit after the derived rows exist.
 */
export async function upsertProjectRagPostgresFileWithChunksInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  fileInput: ProjectRagPostgresFileInput,
  chunks: readonly ProjectRagPostgresChunkInput[],
  versionStatus: string = 'ready'
): Promise<{ fileId: number; versionId?: number }> {
  const { fileId, versionId } = await upsertProjectRagPostgresFileInTransaction(
    tx,
    projectId,
    fileInput,
    'pending'
  );
  if (fileId && versionId) {
    await replaceProjectRagPostgresFileChunksInTransaction(
      tx,
      projectId,
      fileId,
      chunks,
      versionId
    );
    if (versionStatus === 'ready') {
      const activeRows = (await tx`
        select active_version_id as "activeVersionId"
        from project_files
        where project_id = ${projectId} and id = ${fileId}
        limit 1
      `) as Array<Record<string, unknown>>;
      await applyProjectRagFileVersionPromotionInTransaction(
        tx,
        projectId,
        fileId,
        versionId,
        optionalNumberField(activeRows[0]?.activeVersionId) ?? null,
        'pending'
      );
    }
  }
  return { fileId, versionId };
}

/**
 * Atomically upsert a file and replace its chunks within a single database transaction.
 *
 * Combines `upsertProjectRagPostgresFile` and `replaceProjectRagPostgresFileChunks`
 * in one explicit transaction unit so that the active version pointer and
 * chunk rows are never inconsistent.  If the operation fails partway through, the
 * transaction rolls back and the previous active version and its chunks remain intact.
 *
 * When `versionStatus` is 'ready' (default) the new version is promoted immediately as
 * the active version.  When set to a deferred status (e.g. 'pending') the version is
 * created but NOT promoted — call {@link promoteProjectRagPostgresFileVersions} after
 * the embedding pipeline succeeds to finalise the promotion.
 *
 * @param sql           - Bun.SQL pool handle; the unit opens its own transaction.
 * @param projectId     - Project RAG project id
 * @param fileInput     - File metadata (same shape as `upsertProjectRagPostgresFile`)
 * @param chunks        - Chunks to replace (same shape as `replaceProjectRagPostgresFileChunks`)
 * @param versionStatus - Version status; default 'ready' for immediate promotion.
 *                        Use 'pending' to defer promotion until after embeddings.
 * @returns `{ fileId, versionId }`, or `fileId: 0` if the upsert failed to return an id.
 */
export async function upsertProjectRagPostgresFileWithChunks(
  sql: ProjectRagSql,
  projectId: number,
  fileInput: ProjectRagPostgresFileInput,
  chunks: readonly ProjectRagPostgresChunkInput[],
  versionStatus: string = 'ready'
): Promise<{ fileId: number; versionId?: number }> {
  return beginProjectRagWrite(sql, (tx) =>
    upsertProjectRagPostgresFileWithChunksInTransaction(
      tx,
      projectId,
      fileInput,
      chunks,
      versionStatus
    )
  );
}

/**
 * Apply one version promotion inside the caller's transaction: mark the old
 * active version 'replaced' (disabling its chunks), promote the new version to
 * 'ready', and swap the file's active pointer.
 */
async function applyProjectRagFileVersionPromotionInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  fileId: number,
  versionId: number,
  oldActiveId: number | null,
  fromStatus: string
): Promise<void> {
  if (oldActiveId) {
    await tx`
      update project_file_versions
      set status = 'replaced',
        replaced_at = now(),
        updated_at = now()
      where id = ${oldActiveId}
        and status = 'ready'
    `;
    await tx`
      update project_chunks
      set enabled = false,
        updated_at = now()
      where project_id = ${projectId}
        and file_id = ${fileId}
        and version_id = ${oldActiveId}
        and enabled = true
    `;
  }

  await tx`
    update project_file_versions
    set status = 'ready',
      ready_at = now(),
      promoted_at = now(),
      updated_at = now()
    where id = ${versionId}
      and status = ${fromStatus}
  `;

  await tx`
    update project_files
    set active_version_id = ${versionId},
      updated_at = now()
    where project_id = ${projectId}
      and id = ${fileId}
  `;
}

/**
 * Promote project file versions inside the caller's transaction.
 *
 * In-transaction half of {@link promoteProjectRagPostgresFileVersions}: the
 * old active version is never left replaced while the new version is still
 * pending unless the surrounding unit commits that way.
 */
export async function promoteProjectRagPostgresFileVersionsInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  fromStatus: string = 'pending',
  sourcePaths?: readonly string[]
): Promise<number> {
  const scopedSourcePaths = sourcePaths ? [...new Set(sourcePaths)].sort() : undefined;
  if (scopedSourcePaths?.length === 0) {
    return 0;
  }

  // Find files whose latest version has the deferred status. Bounded
  // reconciliation passes its processed source paths so pending work outside
  // the operation budget is never promoted by this run.
  const rows = scopedSourcePaths
    ? ((await tx`
        select f.id as file_id,
          f.active_version_id as old_active_id,
          v.id as version_id
        from project_files f
        join project_file_versions v on v.id = f.latest_version_id
        where f.project_id = ${projectId}
          and v.status = ${fromStatus}
          and v.id is distinct from f.active_version_id
          and f.source_path in ${tx(scopedSourcePaths)}
      `) as Array<Record<string, unknown>>)
    : ((await tx`
        select f.id as file_id,
          f.active_version_id as old_active_id,
          v.id as version_id
        from project_files f
        join project_file_versions v on v.id = f.latest_version_id
        where f.project_id = ${projectId}
          and v.status = ${fromStatus}
          and v.id is distinct from f.active_version_id
      `) as Array<Record<string, unknown>>);

  let promoted = 0;
  for (const row of rows) {
    const fileId = numberField(row.file_id);
    const versionId = numberField(row.version_id);
    const oldActiveId = optionalNumberField(row.old_active_id);

    if (!versionId || !fileId) {
      continue;
    }

    await applyProjectRagFileVersionPromotionInTransaction(
      tx,
      projectId,
      fileId,
      versionId,
      oldActiveId ?? null,
      fromStatus
    );
    promoted += 1;
  }

  return promoted;
}

/**
 * Promote project file versions from a deferred status (e.g. 'pending') to 'ready'
 * and set them as the active version for their respective files.
 *
 * This is the second half of the two-phase ingestion pattern introduced by
 * `upsertProjectRagPostgresFile` with `versionStatus !== 'ready'`.  The old active
 * version (if any) is marked as 'replaced' after the new version is promoted, so
 * the previous active state remains intact if the promotion is never called.
 *
 * @param sql        - Bun.SQL pool handle; opens exactly one transaction unit.
 * @param projectId  - Project RAG project id
 * @param fromStatus - Source status to promote (default 'pending')
 * @returns The number of promoted files.
 */
export async function promoteProjectRagPostgresFileVersions(
  sql: ProjectRagSql,
  projectId: number,
  fromStatus: string = 'pending',
  sourcePaths?: readonly string[]
): Promise<number> {
  // One unit covers find-promote-activate so the old active version is never
  // left replaced while the new version is still pending, and the file active
  // pointer is never out of sync with the version status.  If the promotion
  // fails partway through, the unit rolls back and the previous active
  // version remains intact.
  return beginProjectRagWrite(sql, (tx) =>
    promoteProjectRagPostgresFileVersionsInTransaction(tx, projectId, fromStatus, sourcePaths)
  );
}

/**
 * Repair pending file versions inside the caller's transaction.
 *
 * In-transaction half of {@link repairProjectRagPostgresFileVersions}: the
 * candidate scan, embedding safety checks, and every promotion share the one
 * surrounding unit, so a failure rolls back to the pre-repair active state.
 *
 * Versions that do NOT meet the safety conditions are left untouched — they
 * remain in 'pending' status and the old active version stays in use for
 * search.
 *
 * @param legacyMode - When true, also accept null source_hash on embeddings
 *                     (legacy data).  Default false (strict matching required).
 * @param sourcePaths - Optional project-relative source paths. When provided,
 *                      only versions for those paths are eligible for repair.
 * @returns The number of promoted files.
 */
export async function repairProjectRagPostgresFileVersionsInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  embeddingModel: string,
  embeddingProvider: string,
  expectedDimensions: number,
  legacyMode: boolean = false,
  sourcePaths?: readonly string[]
): Promise<number> {
  const scopedSourcePaths = sourcePaths ? [...new Set(sourcePaths)].sort() : undefined;
  if (scopedSourcePaths?.length === 0) {
    return 0;
  }

  // Find files where latest version is pending and differs from active version.
  // Bounded reconciliation scopes this to processed paths so valid pending
  // versions outside its operation budget remain untouched for a later run.
  const rows = scopedSourcePaths
    ? ((await tx`
        select f.id as file_id,
          f.active_version_id as old_active_id,
          v.id as version_id
        from project_files f
        join project_file_versions v on v.id = f.latest_version_id
        where f.project_id = ${projectId}
          and v.status = 'pending'
          and v.id is distinct from f.active_version_id
          and f.source_path in ${tx(scopedSourcePaths)}
      `) as Array<Record<string, unknown>>)
    : ((await tx`
        select f.id as file_id,
          f.active_version_id as old_active_id,
          v.id as version_id
        from project_files f
        join project_file_versions v on v.id = f.latest_version_id
        where f.project_id = ${projectId}
          and v.status = 'pending'
          and v.id is distinct from f.active_version_id
      `) as Array<Record<string, unknown>>);

  if (rows.length === 0) {
    return 0;
  }

  let promoted = 0;

  for (const row of rows) {
    const fileId = numberField(row.file_id);
    const versionId = numberField(row.version_id);
    const oldActiveId = optionalNumberField(row.old_active_id);

    if (!versionId || !fileId) {
      continue;
    }

    // Safety check: All chunks for this version must have embeddings
    // with the expected model, provider, dimensions, canonical profile hash,
    // and matching source hash.
    // In strict mode (default, legacyMode=false) the source_hash must be non-null
    // and match the chunk's current content hash.  In legacy mode (legacyMode=true)
    // null source_hash is also accepted (pre-migration data).
    // The `or (e.source_hash is null and ${legacyMode})` condition uses the
    // parameterized boolean to toggle strictness without raw SQL composition.
    const safetyRows = (await tx`
      select
        (select count(*) from project_chunks
          where project_id = ${projectId} and file_id = ${fileId}
            and version_id = ${versionId} and enabled = true)::int as chunk_count,
        (select count(*) from project_chunks c
          join project_embeddings_1024 e on e.chunk_id = c.id
          where c.project_id = ${projectId} and c.file_id = ${fileId}
            and c.version_id = ${versionId} and c.enabled = true
            and e.project_id = ${projectId}
            and e.owner_type = 'chunk'
            and e.embedding_model = ${embeddingModel}
            and e.embedding_provider = ${embeddingProvider}
            and e.dimensions = ${expectedDimensions}
            and e.embedding_profile_hash = ${POSTGRES_EXPECTED_EMBEDDING_PROFILE_HASH}
            and e.version_id = ${versionId}
            and (e.source_hash = md5(coalesce(nullif(c.searchable_text, ''), c.content))
              or (e.source_hash is null and ${legacyMode}))
        )::int as valid_embedding_count
    `) as Array<Record<string, unknown>>;

    const chunkCount = numberField(safetyRows[0]?.chunk_count);
    const validEmbeddingCount = numberField(safetyRows[0]?.valid_embedding_count);

    // Only promote when ALL chunks have valid embeddings.  Unsafe versions are
    // skipped (left pending) rather than failing the whole unit.
    if (chunkCount === 0 || validEmbeddingCount < chunkCount) {
      continue;
    }

    await applyProjectRagFileVersionPromotionInTransaction(
      tx,
      projectId,
      fileId,
      versionId,
      oldActiveId ?? null,
      'pending'
    );

    promoted += 1;
  }

  return promoted;
}

/**
 * Repair project file versions that have active/latest mismatch by promoting the
 * latest version only when all requirements are met:
 *
 * 1. The latest version exists with status 'pending' (was deferred but never promoted)
 * 2. All chunks for the latest version have valid embeddings matching the
 *    expected model, provider, and dimensions with matching source hash
 *
 * In strict mode (default, `legacyMode=false`), the embedding source_hash must
 * be non-null and match the chunk's current source hash.  This prevents
 * promoting versions whose embeddings were computed from stale or unverified
 * chunk content.  When `legacyMode=true`, embeddings with null source_hash are
 * also accepted to handle pre-migration data.
 *
 * This handles the case where a prior ingest completed successfully (chunks +
 * embeddings written) but the promotion step was skipped due to a crash or
 * interruption.  Versions that do NOT meet the safety conditions are left
 * untouched — they remain in 'pending' status and the old active version stays
 * in use for search.
 *
 * @param sql - Bun.SQL pool handle; opens exactly one transaction unit so the
 *              scan, safety checks, and all promotions commit or roll back together.
 * @param legacyMode - When true, also accept null source_hash on embeddings
 *                     (legacy data).  Default false (strict matching required).
 * @param sourcePaths - Optional project-relative source paths. When provided,
 *                      only versions for those paths are eligible for repair.
 * @returns The number of promoted files.
 */
export async function repairProjectRagPostgresFileVersions(
  sql: ProjectRagSql,
  projectId: number,
  embeddingModel: string,
  embeddingProvider: string,
  expectedDimensions: number,
  legacyMode: boolean = false,
  sourcePaths?: readonly string[]
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    repairProjectRagPostgresFileVersionsInTransaction(
      tx,
      projectId,
      embeddingModel,
      embeddingProvider,
      expectedDimensions,
      legacyMode,
      sourcePaths
    )
  );
}

/**
 * Replace chunks for a project file inside an already-active transaction.
 *
 * Callers MUST open their unit through the transaction module — this function
 * does NOT manage transaction boundaries. It reads the file's latest and
 * active version pointers. Immediate-ready writes replace all file chunks.
 * Deferred writes replace only the latest version's chunks so the active
 * version remains searchable until promotion succeeds.
 *
 * @param tx        - Active transaction handle from the transaction module.
 * @param projectId - Project RAG project id.
 * @param fileId    - File id whose chunks to replace.
 * @param chunks    - New chunk rows.
 * @returns The number of chunks written.
 */
/**
 * Validate one explicit derived-data target version before mutation.
 *
 * T-05 contract: chunk/symbol/edge mutations are only legal against a
 * *candidate* file version that
 *
 *   1. exists under exactly this project and file,
 *   2. still has lifecycle status 'pending', and
 *   3. is not a member of any published/index build row.
 *
 * Any violation throws before the caller issues its first delete or insert so
 * ready/published graph data can never be replaced through a candidate API.
 */
export async function assertProjectRagPostgresCandidateVersionInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  fileId: number,
  versionId: number
): Promise<void> {
  const versionRows = (await tx`
    select status from project_file_versions
    where id = ${versionId}
      and project_id = ${projectId}
      and file_id = ${fileId}
    limit 1
  `) as Array<Record<string, unknown>>;
  const status = typeof versionRows[0]?.status === 'string' ? versionRows[0].status : null;
  if (!status) {
    throw new Error(
      `CANDIDATE_VERSION_NOT_FOUND: project ${projectId} has no file ${fileId} version ${versionId}`
    );
  }
  if (status !== 'pending') {
    throw new Error(
      `CANDIDATE_VERSION_IMMUTABLE: version ${versionId} is '${status}', only 'pending' candidates accept derived-data mutation`
    );
  }
  const buildMemberRows = (await tx`
    select 1 from project_index_build_files
    where project_id = ${projectId}
      and file_id = ${fileId}
      and version_id = ${versionId}
    limit 1
  `) as Array<Record<string, unknown>>;
  if (buildMemberRows[0]) {
    throw new Error(
      `CANDIDATE_VERSION_BUILD_MEMBER: version ${versionId} is already bound to an index build`
    );
  }
}

/**
 * Mark one pending candidate version as failed inside the caller's unit.
 *
 * Used when per-file processing cannot produce a complete graph (e.g. AST
 * parse failure). The candidate is retained with its failure evidence, its
 * symbols/edges are never written, and it can never be promoted by the
 * embedding-integrity repair because repair only scans 'pending' versions.
 * Migration 010's lifecycle trigger enforces failed_at + error_message.
 */
export async function failProjectRagPostgresCandidateVersionInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  fileId: number,
  versionId: number,
  errorMessage: string
): Promise<boolean> {
  const rows = (await tx`
    update project_file_versions
    set status = 'failed',
      failed_at = now(),
      error_message = ${errorMessage},
      updated_at = now()
    where id = ${versionId}
      and project_id = ${projectId}
      and file_id = ${fileId}
      and status = 'pending'
    returning id
  `) as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/**
 * Replace the chunks of ONE explicit candidate version inside the caller's
 * transaction.
 *
 * Deletes are filtered by project+file+version, so chunks owned by any other
 * version of the file (including the active/published one) are untouched.
 * The target must pass {@link assertProjectRagPostgresCandidateVersionInTransaction}.
 */
export async function replaceProjectRagPostgresFileChunksInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  fileId: number,
  chunks: readonly ProjectRagPostgresChunkInput[],
  versionId: number
): Promise<number> {
  await assertProjectRagPostgresCandidateVersionInTransaction(tx, projectId, fileId, versionId);

  await tx`
    delete from project_chunks
    where project_id = ${projectId}
      and file_id = ${fileId}
      and version_id = ${versionId}
  `;

  for (const chunk of chunks) {
    await tx`
      insert into project_chunks (
        project_id, file_id, version_id, chunk_index, content, searchable_text, start_line,
        end_line, symbol_name, symbol_kind, symbol_signature, section, enabled, metadata
      )
      values (
        ${projectId}, ${fileId}, ${versionId}, ${chunk.chunkIndex}, ${chunk.content},
        ${chunk.searchableText}, ${chunk.startLine ?? null}, ${chunk.endLine ?? null},
        ${chunk.symbolName ?? null}, ${chunk.symbolKind ?? null}, ${chunk.symbolSignature ?? null},
        ${chunk.section ?? null}, ${chunk.enabled ?? true},
        ${JSON.stringify(chunk.metadata ?? {})}::jsonb
      )
    `;
  }

  return chunks.length;
}

/**
 * Replace all chunks of ONE explicit candidate version.
 *
 * Standalone wrapper: opens exactly one write unit around the candidate-guarded
 * delete + insert.  Deletes are scoped to project+file+version; other versions
 * of the file are never touched.
 *
 * When called from inside an existing transaction unit — e.g. from
 * {@link upsertProjectRagPostgresFileWithChunksInTransaction} — use the
 * `InTransaction` variant directly; nesting units is not supported.
 */
export async function replaceProjectRagPostgresFileChunks(
  sql: ProjectRagSql,
  projectId: number,
  fileId: number,
  chunks: readonly ProjectRagPostgresChunkInput[],
  versionId: number
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    replaceProjectRagPostgresFileChunksInTransaction(tx, projectId, fileId, chunks, versionId)
  );
}

/**
 * Insert one project symbol row inside the caller's transaction.
 */
async function insertProjectRagPostgresSymbolUncheckedInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  input: ProjectRagPostgresSymbolInput
): Promise<number> {
  const rows = (await tx`
    insert into project_symbols (
      project_id, file_id, version_id, chunk_id, name, symbol_type, export_type, signature,
      start_line, end_line, confidence, metadata
    )
    values (
      ${projectId}, ${input.fileId}, ${input.versionId}, ${input.chunkId ?? null}, ${input.name}, ${input.symbolType},
      ${input.exportType ?? 'unknown'}, ${input.signature ?? null},
      ${input.startLine ?? null}, ${input.endLine ?? null}, ${input.confidence ?? null},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    returning id
  `) as Array<{ id: number | string }>;

  return numberField(rows[0]?.id);
}

export async function insertProjectRagPostgresSymbolInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  input: ProjectRagPostgresSymbolInput
): Promise<number> {
  if (input.versionId === undefined) {
    throw new Error('CANDIDATE_VERSION_REQUIRED: symbol inserts require an explicit version id');
  }
  await assertProjectRagPostgresCandidateVersionInTransaction(
    tx,
    projectId,
    input.fileId,
    input.versionId
  );
  return insertProjectRagPostgresSymbolUncheckedInTransaction(tx, projectId, input);
}

export async function insertProjectRagPostgresSymbol(
  sql: ProjectRagSql,
  projectId: number,
  input: ProjectRagPostgresSymbolInput
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    insertProjectRagPostgresSymbolInTransaction(tx, projectId, input)
  );
}

/**
 * Replace all symbols of ONE explicit candidate version inside the caller's
 * transaction.
 *
 * Deletes are filtered by project+file+version, so symbols owned by any other
 * version of the file survive.  Edges referencing deleted candidate symbols
 * cascade within the same unit.  The target must be a validated pending
 * candidate that belongs to no index build.
 */
export async function replaceProjectRagPostgresFileSymbolsInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  fileId: number,
  symbols: readonly Omit<ProjectRagPostgresSymbolInput, 'fileId'>[],
  versionId: number
): Promise<number> {
  await assertProjectRagPostgresCandidateVersionInTransaction(tx, projectId, fileId, versionId);

  await tx`
    delete from project_symbols
    where project_id = ${projectId}
      and file_id = ${fileId}
      and version_id = ${versionId}
  `;

  for (const symbol of symbols) {
    await insertProjectRagPostgresSymbolUncheckedInTransaction(tx, projectId, {
      ...symbol,
      fileId,
      versionId,
    });
  }

  return symbols.length;
}

/**
 * Replace all symbols of one explicit candidate version with a new set.
 *
 * Standalone wrapper opening exactly one transaction unit around the
 * candidate-guarded delete + insert; edges referencing replaced candidate
 * symbols cascade within the same unit.
 *
 * @returns The number of symbols inserted.
 */
export async function replaceProjectRagPostgresFileSymbols(
  sql: ProjectRagSql,
  projectId: number,
  fileId: number,
  symbols: readonly Omit<ProjectRagPostgresSymbolInput, 'fileId'>[],
  versionId: number
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    replaceProjectRagPostgresFileSymbolsInTransaction(tx, projectId, fileId, symbols, versionId)
  );
}

/**
 * Replace all edges sourced by ONE explicit candidate version inside the
 * caller's transaction.
 *
 * Deletes are filtered by project+source file+source version, so edges from
 * other versions or other source files are preserved.  Only edges whose
 * source_file_id matches the given fileId are removed.
 */
export async function replaceProjectRagPostgresFileEdgesInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  fileId: number,
  edges: readonly Omit<ProjectRagPostgresEdgeInput, 'sourceFileId'>[],
  sourceVersionId: number
): Promise<number> {
  await assertProjectRagPostgresCandidateVersionInTransaction(
    tx,
    projectId,
    fileId,
    sourceVersionId
  );

  await tx`
    delete from project_edges
    where project_id = ${projectId}
      and source_file_id = ${fileId}
      and source_version_id = ${sourceVersionId}
  `;

  for (const edge of edges) {
    await insertProjectRagPostgresEdgeUncheckedInTransaction(tx, projectId, {
      ...edge,
      sourceFileId: fileId,
      sourceVersionId,
    });
  }

  return edges.length;
}

/**
 * Replace all edges of one explicit candidate source version with a new set.
 *
 * Standalone wrapper opening exactly one transaction unit around the
 * candidate-guarded delete + insert.
 *
 * @returns The number of edges inserted.
 */
export async function replaceProjectRagPostgresFileEdges(
  sql: ProjectRagSql,
  projectId: number,
  fileId: number,
  edges: readonly Omit<ProjectRagPostgresEdgeInput, 'sourceFileId'>[],
  sourceVersionId: number
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    replaceProjectRagPostgresFileEdgesInTransaction(tx, projectId, fileId, edges, sourceVersionId)
  );
}

async function insertProjectRagPostgresEdgeUncheckedInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  input: ProjectRagPostgresEdgeInput
): Promise<number> {
  const rows = (await tx`
    insert into project_edges (
      project_id, source_file_id, source_version_id, source_symbol_id, source_ref, source_ref_lower,
      target_file_id, target_version_id, target_symbol_id, target_ref, target_ref_lower, relation_type,
      confidence, extraction_method, metadata
    )
    values (
      ${projectId}, ${input.sourceFileId ?? null}, ${input.sourceVersionId ?? null},
      ${input.sourceSymbolId ?? null},
      ${input.sourceRef ?? null}, ${input.sourceRef?.toLowerCase() ?? null},
      ${input.targetFileId ?? null}, ${input.targetVersionId ?? null}, ${input.targetSymbolId ?? null},
      ${input.targetRef ?? null}, ${input.targetRef?.toLowerCase() ?? null},
      ${input.relationType}, ${input.confidence ?? 1},
      ${input.extractionMethod ?? 'project_reference_backfill'},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    returning id
  `) as Array<{ id: number | string }>;

  return numberField(rows[0]?.id);
}

export async function insertProjectRagPostgresEdgeInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  input: ProjectRagPostgresEdgeInput
): Promise<number> {
  if (input.sourceFileId === undefined || input.sourceVersionId === undefined) {
    throw new Error(
      'CANDIDATE_VERSION_REQUIRED: edge inserts require an explicit source file and version'
    );
  }
  await assertProjectRagPostgresCandidateVersionInTransaction(
    tx,
    projectId,
    input.sourceFileId,
    input.sourceVersionId
  );
  if (input.targetVersionId !== undefined || input.targetSymbolId !== undefined) {
    if (input.targetFileId === undefined || input.targetVersionId === undefined) {
      throw new Error(
        'CANDIDATE_VERSION_REQUIRED: edge target ownership requires an explicit target file and version'
      );
    }
    await assertProjectRagPostgresCandidateVersionInTransaction(
      tx,
      projectId,
      input.targetFileId,
      input.targetVersionId
    );
  }
  return insertProjectRagPostgresEdgeUncheckedInTransaction(tx, projectId, input);
}

export async function insertProjectRagPostgresEdge(
  sql: ProjectRagSql,
  projectId: number,
  input: ProjectRagPostgresEdgeInput
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    insertProjectRagPostgresEdgeInTransaction(tx, projectId, input)
  );
}

export interface ProjectRagPostgresEdgeResolveResult {
  readonly callsResolved: number;
  readonly importFilesResolved: number;
}

/**
 * Bulk-resolve edge target IDs after raw edge insertion.
 *
 * For CALLS edges: matches target_ref_lower to project_symbols.name to set
 * target_symbol_id and target_file_id.
 *
 * For IMPORT edges: resolves the import path to an existing project_file by
 * trying relative path resolution with extensions (.ts, .tsx, .js, .jsx, /index variants).
 * Only resolves if the import starts with ./ or ../ (relative to source file).
 */
export async function resolveProjectRagPostgresEdgeTargetsInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number
): Promise<ProjectRagPostgresEdgeResolveResult> {
  // 1. Resolve CALLS edges: set target_file_id from matching symbol's file.
  //    Resolves duplicate target_ref_lower deterministically:
  //    - Prefer symbols in the same file as the edge's source file
  //    - Otherwise use the lowest symbol id as a stable tiebreaker
  //    target_symbol_id is intentionally NOT set because it has a CASCADE DELETE FK
  //    to project_symbols — when symbols are re-created during file re-indexing, edges
  //    with a resolved target_symbol_id would be cascade-deleted, losing the navigation data.
  const callsResult = await tx`
    update project_edges e
    set target_file_id = best.file_id
    from (
      select distinct on (e2.id) e2.id as edge_id, s.file_id
      from project_edges e2
      join project_symbols s
        on s.project_id = e2.project_id
        and lower(s.name) = e2.target_ref_lower
      where e2.project_id = ${projectId}
        and e2.relation_type = 'CALLS'
        and e2.target_file_id is null
        and s.file_id is not null
      order by e2.id,
        case when s.file_id = e2.source_file_id then 0 else 1 end,
        s.id
    ) best
    where e.id = best.edge_id
      and e.project_id = ${projectId}
  `;
  const callsResolved =
    typeof callsResult === 'object' && callsResult !== null
      ? Number((callsResult as Record<string, unknown>)?.count ?? 0)
      : 0;

  // 2. Resolve IMPORT edges: match relative import paths to project files
  const unresolvedImports = (await tx`
    select e.id, e.source_file_id, e.target_ref, f.source_path as src_path
    from project_edges e
    join project_files f on f.id = e.source_file_id
    where e.project_id = ${projectId}
      and e.relation_type = 'IMPORTS'
      and e.target_file_id is null
      and e.target_ref is not null
      and (e.target_ref like './%' or e.target_ref like '../%')
  `) as Array<{ id: number; source_file_id: number; target_ref: string; src_path: string }>;

  let importFilesResolved = 0;

  for (const edge of unresolvedImports) {
    const candidates = resolveImportCandidates(edge.src_path, edge.target_ref);
    if (candidates.length === 0) continue;

    // Try all candidates in a single batch query
    const fileMatch = (await tx`
      select id from project_files
      where project_id = ${projectId}
        and source_path in ${tx(candidates)}
      limit 1
    `) as Array<{ id: number }>;

    if (fileMatch.length > 0) {
      await tx`
        update project_edges
        set target_file_id = ${fileMatch[0].id}
        where id = ${edge.id}
      `;
      importFilesResolved++;
    }
  }

  return { callsResolved, importFilesResolved };
}

export async function resolveProjectRagPostgresEdgeTargets(
  sql: ProjectRagSql,
  projectId: number
): Promise<ProjectRagPostgresEdgeResolveResult> {
  return beginProjectRagWrite(sql, (tx) =>
    resolveProjectRagPostgresEdgeTargetsInTransaction(tx, projectId)
  );
}

/**
 * Build candidate file paths for a relative import path.
 * Tries extensions: .ts, .tsx, .js, .jsx, /index.ts, /index.tsx, /index.js, /index.jsx
 * Returns at most one candidate per path (deduplicated, first match wins order).
 */
function resolveImportCandidates(sourcePath: string, importPath: string): string[] {
  if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
    return []; // Not a relative import — skip bare specifiers (node_modules etc.)
  }

  const dir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
  const resolved = dir ? joinPath(dir, importPath) : importPath;

  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  const indexVariants = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

  const seen = new Set<string>();
  const candidates: string[] = [];

  function add(path: string) {
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push(path);
    }
  }

  add(resolved); // as-is (may already have extension)
  for (const ext of extensions) add(resolved + ext);
  for (const idx of indexVariants) add(resolved + idx);

  // Also try without the existing extension + index
  const base = resolved.replace(/\.\w+$/, '');
  if (base !== resolved) {
    for (const idx of indexVariants) add(base + idx);
  }

  return candidates;
}

function joinPath(dir: string, relative: string): string {
  const parts = relative.split('/');
  const dirParts = dir ? dir.split('/') : [];

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (dirParts.length > 0) dirParts.pop();
    } else {
      dirParts.push(part);
    }
  }

  return dirParts.join('/');
}

/**
 * List enabled chunks that still need an embedding for the EXACT profile
 * identified by `embeddingProfileHash`.
 *
 * The exclusion predicate is profile-hash-exact: a chunk that already owns a
 * row from another provider/model/dimensions/input-format (or the
 * `legacy_unknown` sentinel) stays a candidate so it can gain a proper
 * canonical-profile row without ever mutating the existing one.
 */
export async function listProjectRagPostgresChunkEmbeddingCandidates(
  sql: ProjectRagSql,
  projectId: number,
  args: {
    readonly embeddingModel: string;
    readonly embeddingProfileHash: string;
    readonly limit?: number;
    readonly sourcePaths?: readonly string[];
  }
): Promise<ProjectRagPostgresChunkEmbeddingCandidate[]> {
  const limit = Math.min(Math.max(args.limit ?? 1000, 1), 10_000);
  const uniqueSourcePaths = [...new Set(args.sourcePaths ?? [])].sort();
  const rows =
    uniqueSourcePaths.length > 0
      ? ((await sql`
           select c.id, c.content, c.searchable_text,
             md5(coalesce(nullif(c.searchable_text, ''), c.content)) as source_hash
           from project_chunks c
           join project_files f on f.id = c.file_id and f.project_id = c.project_id
           join project_file_versions v
             on v.id = c.version_id
             and v.file_id = c.file_id
             and v.project_id = c.project_id
           where c.project_id = ${projectId}
             and c.enabled = true
             and v.status = 'pending'
             and f.source_path in ${sql(uniqueSourcePaths)}
             and not exists (
               select 1
               from project_index_build_files b
               where b.project_id = c.project_id
                 and b.file_id = c.file_id
                 and b.version_id = c.version_id
             )
             and not exists (
               select 1
               from project_embeddings_1024 e
              where e.project_id = c.project_id
                and e.owner_type = 'chunk'
                and e.chunk_id = c.id
                and e.embedding_profile_hash = ${args.embeddingProfileHash}
            )
          order by c.id
          limit ${limit}
        `) as Array<Record<string, unknown>>)
      : ((await sql`
           select c.id, c.content, c.searchable_text,
             md5(coalesce(nullif(c.searchable_text, ''), c.content)) as source_hash
           from project_chunks c
           join project_file_versions v
             on v.id = c.version_id
             and v.file_id = c.file_id
             and v.project_id = c.project_id
           where c.project_id = ${projectId}
             and c.enabled = true
             and v.status = 'pending'
             and not exists (
               select 1
               from project_index_build_files b
               where b.project_id = c.project_id
                 and b.file_id = c.file_id
                 and b.version_id = c.version_id
             )
             and not exists (
               select 1
               from project_embeddings_1024 e
              where e.project_id = c.project_id
                and e.owner_type = 'chunk'
                and e.chunk_id = c.id
                and e.embedding_profile_hash = ${args.embeddingProfileHash}
            )
          order by c.id
          limit ${limit}
        `) as Array<Record<string, unknown>>);

  return rows.map((row) => ({
    chunkId: numberField(row.id),
    sourceHash: typeof row.source_hash === 'string' ? row.source_hash : '',
    text:
      typeof row.searchable_text === 'string' && row.searchable_text
        ? row.searchable_text
        : typeof row.content === 'string'
          ? row.content
          : '',
  }));
}

/**
 * Canonical text form of an embedding owner reference.
 *
 * Owner refs are the decimal string of the owner row id (chunk/symbol/file).
 * Canonicalization rejects anything that is not already a plain positive
 * decimal integer so `007`, ` 7 `, or `7.0` can never fork the identity.
 */
function canonicalProjectRagEmbeddingOwnerRef(ownerType: string, ref: number | string): string {
  const text = String(ref);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new Error(
      `EMBEDDING_OWNER_REF_INVALID: ${ownerType} owner_ref ${JSON.stringify(text)} is not a canonical positive integer`
    );
  }
  return text;
}

async function assertProjectRagPostgresChunkEmbeddingCandidateInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  chunkId: number
): Promise<{ readonly fileId: number; readonly versionId: number }> {
  const ownerRows = (await tx`
    select c.file_id, c.version_id, c.enabled, v.status
    from project_chunks c
    left join project_file_versions v
      on v.id = c.version_id
      and v.file_id = c.file_id
      and v.project_id = c.project_id
    where c.project_id = ${projectId}
      and c.id = ${chunkId}
    limit 1
  `) as Array<Record<string, unknown>>;
  const owner = ownerRows[0];
  if (!owner) {
    throw new Error(
      `EMBEDDING_OWNER_NOT_FOUND: chunk ${chunkId} is not owned by project ${projectId}`
    );
  }

  const versionId = numberField(owner.version_id);
  const fileId = numberField(owner.file_id);
  if (!versionId || !fileId) {
    throw new Error(
      `CANDIDATE_VERSION_REQUIRED: chunk ${chunkId} embedding writes require an exact file version`
    );
  }
  const status = typeof owner.status === 'string' ? owner.status : null;
  if (status === null) {
    throw new Error(
      `CANDIDATE_VERSION_NOT_FOUND: chunk ${chunkId} version ${versionId} is not owned by project ${projectId} and file ${fileId}`
    );
  }
  if (status !== 'pending') {
    throw new Error(
      `CANDIDATE_VERSION_IMMUTABLE: version ${versionId} is '${status}', only 'pending' candidates accept embedding inserts`
    );
  }
  if (owner.enabled !== true) {
    throw new Error(`EMBEDDING_CHUNK_DISABLED: chunk ${chunkId} is not an enabled candidate`);
  }

  const buildMemberRows = (await tx`
    select 1
    from project_index_build_files
    where project_id = ${projectId}
      and file_id = ${fileId}
      and version_id = ${versionId}
    limit 1
  `) as Array<Record<string, unknown>>;
  if (buildMemberRows[0]) {
    throw new Error(
      `CANDIDATE_VERSION_BUILD_MEMBER: version ${versionId} is already bound to an index build`
    );
  }

  return { fileId, versionId };
}

/**
 * Insert ONE chunk embedding row under exact profile+version identity.
 *
 * Despite the historical name this writer is INSERT-ONLY:
 * - The conflict target is the migration-010 identity key
 *   (project_id, owner_type, owner_ref, embedding_profile_hash); a duplicate
 *   insert for the same owner + same profile is skipped via DO NOTHING and
 *   returns 0 instead of mutating the stored vector.
 * - version_id is bound to the chunk's live version inside this statement
 *   (same-version ownership) and refuses owners without a bound version.
 * - Rows whose owning version was promoted (ready/published) are therefore
 *   immutable in practice: no code path updates embedding payloads anymore.
 * - Writing under the `legacy_unknown` sentinel is rejected: only rows whose
 *   full processing profile is proven may enter the table.
 *
 * @returns The new row id, or 0 when the insert was skipped because an equal
 *          identity row already exists.
 */
export async function upsertProjectRagPostgresChunkEmbedding1024InTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  input: ProjectRagPostgresChunkEmbeddingInput
): Promise<number> {
  if (!input.embeddingProfileHash || typeof input.embeddingProfileHash !== 'string') {
    throw new Error('EMBEDDING_PROFILE_HASH_REQUIRED: chunk embedding writes need a profile hash');
  }
  if (input.embeddingProfileHash === PROJECT_RAG_EMBEDDING_PROFILE_LEGACY_UNKNOWN) {
    throw new Error(
      'EMBEDDING_PROFILE_HASH_LEGACY_UNKNOWN_REFUSED: embeddings must carry their exact canonical profile hash'
    );
  }
  const ownerRef = canonicalProjectRagEmbeddingOwnerRef('chunk', input.chunkId);
  await assertProjectRagPostgresChunkEmbeddingCandidateInTransaction(tx, projectId, input.chunkId);
  const rows = (await tx`
    with owner as (
      select c.version_id, c.file_id
      from project_chunks c
      join project_file_versions v
        on v.id = c.version_id
        and v.file_id = c.file_id
        and v.project_id = c.project_id
      where c.project_id = ${projectId}
        and c.id = ${input.chunkId}
        and c.enabled = true
        and v.status = 'pending'
        and not exists (
          select 1
          from project_index_build_files b
          where b.project_id = c.project_id
            and b.file_id = c.file_id
            and b.version_id = c.version_id
        )
    )
    insert into project_embeddings_1024 (
       project_id, owner_type, owner_ref, file_id, chunk_id, embedding_model,
      embedding_provider, dimensions, embedding, source_hash, version_id,
      embedding_profile_hash, metadata
    )
    select ${projectId}, 'chunk', ${ownerRef}, owner.file_id, ${input.chunkId},
      ${input.embeddingModel}, ${input.embeddingProvider}, ${input.dimensions},
      ${halfvecLiteral(input.embedding, input.dimensions)}::halfvec,
      ${input.sourceHash}, owner.version_id,
      ${input.embeddingProfileHash}, '{}'::jsonb
    from owner
    on conflict (project_id, owner_type, owner_ref, embedding_profile_hash) do nothing
    returning id
  `) as Array<{ id: number | string }>;

  return numberField(rows[0]?.id);
}

export async function upsertProjectRagPostgresChunkEmbedding1024(
  sql: ProjectRagSql,
  projectId: number,
  input: ProjectRagPostgresChunkEmbeddingInput
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    upsertProjectRagPostgresChunkEmbedding1024InTransaction(tx, projectId, input)
  );
}

/**
 * Hybrid vector+lexical search over published build chunks.
 *
 * The vector lane matches ONLY embeddings produced by the exact configured
 * processing profile (provider, model, dimensions, canonical profile hash)
 * that also belong to the chunk's currently bound version inside the
 * published build. Rows with a foreign profile or the `legacy_unknown`
 * sentinel can never contribute vector scores — the mismatch fails closed to
 * lexical-only retrieval instead of silently mixing embedding spaces.
 */
export async function searchProjectRagPostgresChunks(
  sql: ProjectRagSql,
  projectId: number,
  args: {
    readonly query: string;
    readonly queryEmbedding: readonly number[];
    readonly buildId?: number;
    readonly embeddingModel: string;
    readonly embeddingProvider: string;
    readonly embeddingDimensions: number;
    readonly embeddingProfileHash: string;
    readonly limit?: number;
  }
): Promise<ProjectRagPostgresSearchResult[]> {
  const normalizedQuery = args.query.trim();
  if (!normalizedQuery) {
    throw new Error('Search query is required.');
  }
  await assertProjectRagPostgresReadSchemaReady(sql);

  const limit = Math.min(Math.max(args.limit ?? 5, 1), 50);
  const candidateLimit = Math.max(200, limit * 50);
  const buildId = args.buildId ?? (await getPublishedProjectRagPostgresBuildId(sql, projectId));
  const queryEmbedding = halfvecLiteral(
    args.queryEmbedding,
    POSTGRES_EXPECTED_EMBEDDING_DIMENSIONS
  );
  const rows = (await sql`
    with query as (
      select
        websearch_to_tsquery('simple', ${normalizedQuery}) as tsq,
        lower(unaccent(${normalizedQuery})) as textq,
        regexp_split_to_array(lower(unaccent(${normalizedQuery})), '[^a-z0-9_./-]+') as terms,
        ${queryEmbedding}::halfvec as query_embedding
    ),
    vector_candidates as (
      select
        e.chunk_id,
        greatest(1 - (e.embedding <=> query.query_embedding), 0)::float8 as vector_score
      from project_embeddings_1024 e
      join project_chunks c
        on c.id = e.chunk_id
        and c.project_id = e.project_id
        and c.version_id = e.version_id
      join project_index_build_files bf
        on bf.project_id = c.project_id
        and bf.file_id = c.file_id and bf.version_id = c.version_id
        and bf.build_id = ${buildId}
      cross join query
      where e.project_id = ${projectId}
        and e.owner_type = 'chunk'
        and e.embedding_provider = ${args.embeddingProvider}
        and e.embedding_model = ${args.embeddingModel}
        and e.dimensions = ${args.embeddingDimensions}
        and e.embedding_profile_hash = ${args.embeddingProfileHash}
      order by e.embedding <=> query.query_embedding
      limit ${candidateLimit}
    ),
    lexical_candidates as (
      select c.id as chunk_id
      from project_chunks c
      join project_index_build_files bf
        on bf.project_id = c.project_id
        and bf.file_id = c.file_id and bf.version_id = c.version_id
        and bf.build_id = ${buildId}
      cross join query
      where c.project_id = ${projectId}
        and c.search_vector @@ query.tsq
      order by ts_rank_cd(c.search_vector, query.tsq) desc
      limit ${candidateLimit}
    ),
    candidate_chunks as (
      select chunk_id, max(vector_score) as vector_score
      from (
        select chunk_id, vector_score from vector_candidates
        union all
        select chunk_id, 0::float8 as vector_score from lexical_candidates
      ) candidates
      group by chunk_id
    )
    select
      f.source_path as "sourcePath",
      c.chunk_index as "chunkIndex",
      c.start_line as "startLine",
      c.end_line as "endLine",
      c.content,
      c.symbol_name as "symbolName",
      c.symbol_kind as "symbolKind",
      coalesce(cc.vector_score, 0)::float8 as "vectorScore",
      (
        ts_rank_cd(c.search_vector, query.tsq) * 10
        + similarity(c.search_text_normalized, query.textq)
        + similarity(lower(unaccent(f.source_path)), query.textq)
        + match_stats.term_hits::float8 * 0.25
        + coalesce(cc.vector_score, 0) * 12
      )::float8 as score
    from candidate_chunks cc
    join project_chunks c
      on c.id = cc.chunk_id
      and c.project_id = ${projectId}
    join project_index_build_files f
      on f.project_id = c.project_id
      and f.file_id = c.file_id and f.version_id = c.version_id
      and f.build_id = ${buildId}
    cross join query
    cross join lateral (
      select count(*) as term_hits
      from unnest(query.terms) term
      where length(term) >= 3
        and (
          c.search_text_normalized like ('%' || term || '%')
          or lower(unaccent(f.source_path)) like ('%' || term || '%')
        )
    ) match_stats
    where c.project_id = ${projectId}
    order by score desc, f.source_path asc, c.chunk_index asc
    limit ${limit}
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : '',
    chunkIndex: numberField(row.chunkIndex),
    startLine: optionalNumberField(row.startLine),
    endLine: optionalNumberField(row.endLine),
    content: typeof row.content === 'string' ? row.content : '',
    symbolName: typeof row.symbolName === 'string' ? row.symbolName : undefined,
    symbolKind: typeof row.symbolKind === 'string' ? row.symbolKind : undefined,
    score: typeof row.score === 'number' ? row.score : Number(row.score ?? 0),
    vectorScore:
      typeof row.vectorScore === 'number' ? row.vectorScore : Number(row.vectorScore ?? 0),
  }));
}

export async function deleteStaleProjectRagPostgresFilesInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  currentSourcePaths: readonly string[]
): Promise<number> {
  // Tombstone rather than delete: older published builds still retain a
  // foreign-key-safe immutable view until deferred build GC reclaims them.
  const rows = (await tx`
    update project_files
    set status = 'deleted', updated_at = now()
    where project_id = ${projectId}
      and source_path not in ${tx(currentSourcePaths)}
    returning id
  `) as Array<{ id: number | string }>;

  return rows.length;
}

export async function deleteStaleProjectRagPostgresFiles(
  sql: ProjectRagSql,
  projectId: number,
  currentSourcePaths: readonly string[]
): Promise<number> {
  const uniqueSourcePaths = [...new Set(currentSourcePaths)].sort();
  if (uniqueSourcePaths.length === 0) return 0;
  return beginProjectRagWrite(sql, (tx) =>
    deleteStaleProjectRagPostgresFilesInTransaction(tx, projectId, uniqueSourcePaths)
  );
}

export interface ProjectRagSnapshotDeletionContext {
  readonly snapshotId: number;
  readonly snapshotUuid: string;
  readonly completenessEvidenceHash: string;
}

export async function deleteProjectRagPostgresFileInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  sourcePath: string,
  snapshot: ProjectRagSnapshotDeletionContext
): Promise<number> {
  if (
    !snapshot ||
    !Number.isSafeInteger(snapshot.snapshotId) ||
    snapshot.snapshotId <= 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      snapshot.snapshotUuid
    ) ||
    !/^[0-9a-f]{64}$/.test(snapshot.completenessEvidenceHash)
  ) {
    throw new Error('SNAPSHOT_DELETION_EVIDENCE_REQUIRED: invalid snapshot deletion evidence');
  }

  const snapshots = (await tx`
    select id
    from project_ingest_snapshots
    where id = ${snapshot.snapshotId}
      and project_id = ${projectId}
      and snapshot_uuid = ${snapshot.snapshotUuid}::uuid
      and completeness_evidence_hash = ${snapshot.completenessEvidenceHash}
      and status = 'CONSUMING'
      and completeness_status = 'complete'
      and deletion_allowed = true
      and lease_expires_at > clock_timestamp()
      and jsonb_array_length(blocked_findings) = 0
    for update
  `) as Array<{ id: number | string }>;
  if (!snapshots[0]) {
    throw new Error('SNAPSHOT_DELETION_EVIDENCE_REQUIRED: no matching live deletion snapshot');
  }

  const rows = (await tx`
    update project_files
    set status = 'deleted', updated_at = now()
    where project_id = ${projectId}
      and source_path = ${sourcePath}
    returning id
  `) as Array<{ id: number | string }>;

  return rows.length;
}

export async function deleteProjectRagPostgresFile(
  sql: ProjectRagSql,
  projectId: number,
  sourcePath: string,
  snapshot: ProjectRagSnapshotDeletionContext
): Promise<number> {
  return beginProjectRagWrite(sql, (tx) =>
    deleteProjectRagPostgresFileInTransaction(tx, projectId, sourcePath, snapshot)
  );
}

// ==========================================================================
// Ingest-snapshot gate helpers (SPEC-007 §8 / RULE-013)
//
// These helpers create, read, claim, consume, fail, and expire immutable
// snapshot rows for the prepare/consume gate.  The higher-level state
// machine logic (threshold, hashing, orchestration) lives in snapshot-gate.ts.
//
// snapshot_uuid is the external immutable identifier.  The numeric `id`
// is internal only and must not be exposed as a public reference.
// ==========================================================================

/** Typed status union matching the DB CHECK constraint. */
export type IngestSnapshotStatus =
  | 'PREPARED'
  | 'REVIEW_REQUIRED'
  | 'CONSUMING'
  | 'CONSUMED'
  | 'FAILED'
  | 'EXPIRED';

/**
 * Valid initial statuses for a new snapshot.
 * FAILED is only allowed when a failureCode is provided.
 */
export type SnapshotInitialStatus = 'PREPARED' | 'REVIEW_REQUIRED' | 'FAILED';

/** Allowed failure codes matching the DB CHECK constraint. */
export type SnapshotFailureCode =
  | 'BLOCKED_ROOT_FINDINGS'
  | 'RESCAN_MISMATCH'
  | 'PRECONDITION_FAILURE'
  | 'CLAIM_LEASE_ABANDONED'
  | 'REVIEW_REJECTED'
  | 'SYSTEM_ERROR';

/** Max length for failure_detail text. */
export const FAILURE_DETAIL_MAX_LENGTH = 1024;

/** Max blocked-finding entries. */
export const BLOCKED_FINDINGS_MAX = 32;

/** Max sample paths per blocked finding. */
export const BLOCKED_FINDING_SAMPLE_MAX = 10;

/** Max length per sample path. */
export const BLOCKED_FINDING_SAMPLE_PATH_MAX = 200;

/** SHA-256 digest of the empty string — default hash for empty allowlists. */
export const EMPTY_ALLOWLIST_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Max entries in a blocked_finding_allowlist or suppressed_blocked_findings array. */
export const ALLOWLIST_ARRAY_MAX = 32;

/**
 * Safe suppressible blocked-finding categories.
 *
 * Excludes `nested_repo_marker` (structural boundary, never suppressible)
 * and `scan_bound_exceeded` (scan integrity, never suppressible).
 * Matches the category values used in project-inventory.ts.
 */
export const SUPPRESSIBLE_CATEGORIES: readonly string[] = [
  'dependency_dir',
  'cache_dir',
  'temp_dir',
  'build_dir',
  'generated_dir',
  'runtime_dir',
];

/** Regex for a safe category token: alphanumeric, underscore, dash, dot, colon, forward-slash. */
const SAFE_ALLOWLIST_CATEGORY_RE = /^[a-zA-Z0-9_\-.:/]+$/;

/** Regex for characters that look like absolute paths or parent-dir traversal. */
const ABSOLUTE_OR_TRAVERSAL_RE = /^\/|[\\]|[.][.]\/|^[A-Za-z]:\\/;

/** Regex for glob characters in paths. */
const GLOB_CHAR_RE = /[*?[\]{}]/;

/** Regex for control characters (ASCII < 0x20 except \t \n). */
const ALLOWLIST_CONTROL_CHAR_RE = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}` +
    `${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}` +
    `${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}]`
);

/** Regex for basename-only paths (no `/` separator). */
const BASENAME_ONLY_RE = /^[^/]+$/;

/** Regex for repeated slashes. */
const REPEATED_SLASH_RE = /\/{2,}/;

/** Regex for `.` or `..` path segments. */
const DOT_SEGMENT_RE = /(^|\/)\.{1,2}(\/|$)/;

/**
 * Run allowlist path validation rules shared by allowlist entries and
 * suppressed-blocked-finding entries.
 *
 * Rejects: empty, leading/trailing slash, `.`/`..` segments, repeated
 * slashes, >200 chars, backslash, control chars, globs, basename-only.
 *
 * @throws {Error} On first validation failure.
 */
export function runAllowlistPathValidation(index: number, relativePath: string): void {
  if (relativePath.length === 0) {
    throw new Error(`Entry ${index} relativePath must not be empty`);
  }
  if (relativePath.length > 200) {
    throw new Error(
      `Entry ${index} relativePath exceeds 200 characters (got ${relativePath.length})`
    );
  }
  if (ABSOLUTE_OR_TRAVERSAL_RE.test(relativePath)) {
    throw new Error(
      `Entry ${index} relativePath '${relativePath}' must be relative (no leading /, no .., no backslash)`
    );
  }
  if (relativePath.endsWith('/')) {
    throw new Error(`Entry ${index} relativePath '${relativePath}' must not have a trailing slash`);
  }
  if (DOT_SEGMENT_RE.test(relativePath)) {
    throw new Error(
      `Entry ${index} relativePath '${relativePath}' must not contain '.' or '..' segments`
    );
  }
  if (REPEATED_SLASH_RE.test(relativePath)) {
    throw new Error(
      `Entry ${index} relativePath '${relativePath}' must not contain repeated slashes`
    );
  }
  if (ALLOWLIST_CONTROL_CHAR_RE.test(relativePath)) {
    throw new Error(`Entry ${index} relativePath contains control characters`);
  }
  if (GLOB_CHAR_RE.test(relativePath)) {
    throw new Error(`Entry ${index} relativePath '${relativePath}' contains glob characters`);
  }
  if (BASENAME_ONLY_RE.test(relativePath)) {
    throw new Error(
      `Entry ${index} relativePath '${relativePath}' is basename-only (must contain at least one '/')`
    );
  }
}

/**
 * Validate a repository allowlist (blocked-finding allowlist entries).
 *
 * @throws {Error} On first validation failure with a descriptive message.
 */
export function validateRepositoryAllowlist(
  entries: readonly BlockedFindingAllowlistEntry[]
): void {
  if (!Array.isArray(entries)) {
    throw new Error('Repository allowlist must be an array');
  }
  if (entries.length > ALLOWLIST_ARRAY_MAX) {
    throw new Error(
      `Repository allowlist has ${entries.length} entries, exceeds max ${ALLOWLIST_ARRAY_MAX}`
    );
  }

  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Must be a plain object with exactly relativePath and category
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Repository allowlist entry ${i} must be a plain object`);
    }

    const keys = Object.keys(entry as Record<string, unknown>);
    if (keys.length !== 2) {
      throw new Error(
        `Repository allowlist entry ${i} has ${keys.length} keys, expected 2 (relativePath, category)`
      );
    }

    if (typeof (entry as Record<string, unknown>).relativePath !== 'string') {
      throw new Error(`Repository allowlist entry ${i} 'relativePath' must be a string`);
    }
    if (typeof (entry as Record<string, unknown>).category !== 'string') {
      throw new Error(`Repository allowlist entry ${i} 'category' must be a string`);
    }

    const { relativePath, category } = entry as BlockedFindingAllowlistEntry;

    // Validate relativePath (reusable shared validation)
    runAllowlistPathValidation(i, relativePath);

    // Validate category
    if (!SAFE_ALLOWLIST_CATEGORY_RE.test(category)) {
      throw new Error(`Allowlist entry ${i} category '${category}' contains unsafe characters`);
    }
    if (!(SUPPRESSIBLE_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(
        `Allowlist entry ${i} category '${category}' is not a suppressible blocked-finding category. ` +
          `Allowed: ${SUPPRESSIBLE_CATEGORIES.join(', ')}`
      );
    }

    // Reject duplicates
    const key = `${relativePath}:${category}`;
    if (seen.has(key)) {
      throw new Error(`Allowlist entry ${i} is a duplicate: '${relativePath}' + '${category}'`);
    }
    seen.add(key);
  }
}

/**
 * Validate a suppressed-blocked-findings array.
 *
 * Each entry must have the exact shape of SuppressedBlockedFinding:
 * { relativePath, category, matchedAllowlistEntry: { relativePath, category } }.
 * Max 32 entries, no duplicates. Reuses path/category validation.
 *
 * @throws {Error} On first validation failure with a descriptive message.
 */
export function validateSuppressedBlockedFindings(findings: unknown): void {
  if (!Array.isArray(findings)) {
    throw new Error('Suppressed blocked findings must be an array');
  }
  if (findings.length > ALLOWLIST_ARRAY_MAX) {
    throw new Error(
      `Suppressed blocked findings count ${findings.length} exceeds max ${ALLOWLIST_ARRAY_MAX}`
    );
  }

  const seen = new Set<string>();
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];

    if (typeof f !== 'object' || f === null || Array.isArray(f)) {
      throw new Error(`Suppressed finding ${i} must be a plain object`);
    }

    // Must have exactly 2 top-level keys (relativePath, category)
    const topKeys = Object.keys(f as Record<string, unknown>).filter(
      (k) => k !== 'matchedAllowlistEntry'
    );
    if (topKeys.length !== 2 || !('relativePath' in f) || !('category' in f)) {
      throw new Error(
        `Suppressed finding ${i} must have exactly 'relativePath' and 'category', got keys: ${Object.keys(f as Record<string, unknown>).join(',')}`
      );
    }

    // Validate relativePath using the same rules as allowlist entries
    if (typeof (f as Record<string, unknown>).relativePath !== 'string') {
      throw new Error(`Suppressed finding ${i} 'relativePath' must be a string`);
    }
    const relPath = (f as Record<string, unknown>).relativePath as string;
    runAllowlistPathValidation(i, relPath);

    // Validate category
    if (typeof (f as Record<string, unknown>).category !== 'string') {
      throw new Error(`Suppressed finding ${i} 'category' must be a string`);
    }
    const cat = (f as Record<string, unknown>).category as string;
    if (!SAFE_ALLOWLIST_CATEGORY_RE.test(cat)) {
      throw new Error(`Suppressed finding ${i} category '${cat}' contains unsafe characters`);
    }
    if (!(SUPPRESSIBLE_CATEGORIES as readonly string[]).includes(cat)) {
      throw new Error(
        `Suppressed finding ${i} category '${cat}' is not a suppressible blocked-finding category. ` +
          `Allowed: ${SUPPRESSIBLE_CATEGORIES.join(', ')}`
      );
    }

    // Validate matchedAllowlistEntry
    const mae = (f as Record<string, unknown>).matchedAllowlistEntry;
    if (!mae || typeof mae !== 'object' || Array.isArray(mae)) {
      throw new Error(`Suppressed finding ${i} 'matchedAllowlistEntry' must be a plain object`);
    }
    const maeKeys = Object.keys(mae as Record<string, unknown>);
    if (maeKeys.length !== 2 || !('relativePath' in mae) || !('category' in mae)) {
      throw new Error(
        `Suppressed finding ${i} 'matchedAllowlistEntry' must have exactly 'relativePath' and 'category', got keys: ${maeKeys.join(',')}`
      );
    }
    if (typeof (mae as Record<string, unknown>).relativePath !== 'string') {
      throw new Error(
        `Suppressed finding ${i} 'matchedAllowlistEntry.relativePath' must be a string`
      );
    }
    if (typeof (mae as Record<string, unknown>).category !== 'string') {
      throw new Error(`Suppressed finding ${i} 'matchedAllowlistEntry.category' must be a string`);
    }

    // matchedAllowlistEntry must match the parent relativePath and category
    const maeRelPath = (mae as Record<string, unknown>).relativePath as string;
    const maeCat = (mae as Record<string, unknown>).category as string;
    if (maeRelPath !== relPath) {
      throw new Error(
        `Suppressed finding ${i} 'matchedAllowlistEntry.relativePath' '${maeRelPath}' does not match parent relativePath '${relPath}'`
      );
    }
    if (maeCat !== cat) {
      throw new Error(
        `Suppressed finding ${i} 'matchedAllowlistEntry.category' '${maeCat}' does not match parent category '${cat}'`
      );
    }

    // Reject duplicates (same relativePath+category)
    const dupKey = `${relPath}:${cat}`;
    if (seen.has(dupKey)) {
      throw new Error(`Suppressed finding ${i} duplicate entry: '${relPath}' + '${cat}'`);
    }
    seen.add(dupKey);
  }
}

/**
 * Allowed failure-code values for runtime validation.
 * Must match the DB CHECK constraint above.
 */
const ALLOWED_FAILURE_CODES: readonly string[] = [
  'BLOCKED_ROOT_FINDINGS',
  'RESCAN_MISMATCH',
  'PRECONDITION_FAILURE',
  'CLAIM_LEASE_ABANDONED',
  'SYSTEM_ERROR',
];

/**
 * Sanitize a failure-detail string.
 *
 *  - Removes any characters that look like absolute paths
 *    (sequences starting with `/` or `[A-Za-z]:\`)
 *  - Removes control characters (ASCII < 0x20 except \t, \n)
 *  - Truncates to FAILURE_DETAIL_MAX_LENGTH
 *  - Returns null when input is null/undefined/empty after sanitize
 */
export function sanitizeFailureDetail(detail: string | null | undefined): string | null {
  if (!detail) {
    return null;
  }

  // Remove absolute paths: /foo/bar or C:\foo
  let sanitized = detail
    .replace(/\/(?:[^\s/]+\/?)+/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s]*/g, '<path>');

  // Remove control characters except \t (0x09), \n (0x0A)
  // Built from char codes to avoid lint control-char-in-regex warnings.
  const ctrlRe = new RegExp(
    `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}` +
      `${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}` +
      `${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}]`,
    'g'
  );
  sanitized = sanitized.replace(ctrlRe, '');

  // Truncate
  if (sanitized.length > FAILURE_DETAIL_MAX_LENGTH) {
    sanitized = sanitized.slice(0, FAILURE_DETAIL_MAX_LENGTH);
  }

  return sanitized.length > 0 ? sanitized : null;
}

export interface ProjectRagPostgresIngestSnapshot {
  readonly id: number;
  readonly snapshotUuid: string;
  readonly projectId: number;
  readonly commandScope: string;
  readonly rootHash: string | null;
  readonly scopeHash: string | null;
  readonly policyHash: string | null;
  readonly inventoryHash: string | null;
  readonly baselineHash: string | null;
  readonly planHash: string | null;
  readonly repositoryHash: string | null;
  readonly workspaceHash: string | null;
  readonly headHash: string | null;
  readonly branchHash: string | null;
  readonly detachedHash: string | null;
  readonly contentHash: string | null;
  readonly indexProfileHash: string | null;
  readonly rootManifestHash: string | null;
  readonly completenessStatus: 'complete' | 'incomplete' | 'blocked' | null;
  readonly completenessEvidenceHash: string | null;
  readonly deletionAllowed: boolean | null;
  readonly addsCount: number;
  readonly updatesCount: number;
  readonly deletesCount: number;
  readonly eligibleCount: number;
  readonly trackedCount: number;
  readonly blockedFindings: Array<Record<string, unknown>>;
  readonly blockedFindingAllowlistHash: string;
  readonly suppressedBlockedFindings: readonly SuppressedBlockedFinding[];
  readonly status: IngestSnapshotStatus;
  readonly failureCode: string | null;
  readonly failureDetail: string | null;
  readonly ttlSeconds: number;
  readonly expiresAt: Date | string;
  readonly leaseExpiresAt: Date | string | null;
  readonly claimedAt: Date | string | null;
  readonly consumedAt: Date | string | null;
  readonly failedAt: Date | string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

export interface ProjectRagPostgresIngestSnapshotInput {
  readonly projectId: number;
  readonly commandScope?: string;
  readonly rootHash?: string | null;
  readonly scopeHash?: string | null;
  readonly policyHash?: string | null;
  readonly inventoryHash?: string | null;
  readonly baselineHash?: string | null;
  readonly planHash?: string | null;
  readonly identity?: ProjectRagIdentityBinding;
  readonly contentHash?: string | null;
  readonly indexProfileHash?: string | null;
  readonly rootManifestHash?: string | null;
  readonly completenessStatus?: 'complete' | 'incomplete' | 'blocked' | null;
  readonly completenessEvidenceHash?: string | null;
  readonly deletionAllowed?: boolean | null;
  readonly addsCount?: number;
  readonly updatesCount?: number;
  readonly deletesCount?: number;
  readonly eligibleCount?: number;
  readonly trackedCount?: number;
  readonly blockedFindings?: ReadonlyArray<Record<string, unknown>>;
  readonly blockedFindingAllowlistHash?: string;
  readonly suppressedBlockedFindings?: readonly SuppressedBlockedFinding[];
  readonly ttlSeconds?: number;
  readonly status?: IngestSnapshotStatus;
  /** Required when status is 'FAILED'. */
  readonly failureCode?: string;
  readonly failureDetail?: string;
}

export interface ProjectRagPostgresSnapshotReview {
  readonly id: number;
  readonly snapshotId: number;
  readonly snapshotUuid: string;
  readonly projectId: number;
  readonly reviewerId: string;
  readonly operatorId: string;
  readonly reviewerCapability: string;
  readonly evidenceId: string;
  readonly reason: string;
  readonly commandScope: string;
  readonly tokenDigest: string;
  readonly approvedAt: Date | string;
  readonly expiresAt: Date | string;
  readonly createdAt: Date | string;
}

export interface ProjectRagPostgresSnapshotReviewInput {
  readonly snapshotUuid: string;
  readonly projectId: number;
  readonly reviewerId: string;
  readonly operatorId: string;
  readonly reviewerCapability: string;
  readonly evidenceId: string;
  readonly reason: string;
  readonly commandScope: string;
  readonly tokenDigest: string;
  readonly expiresAt: Date | string;
}

export type ProjectRagSnapshotReviewDecision = 'REJECTED' | 'DEFERRED';

export interface ProjectRagPostgresSnapshotReviewDecision {
  readonly id: number;
  readonly snapshotId: number;
  readonly snapshotUuid: string;
  readonly projectId: number;
  readonly decision: ProjectRagSnapshotReviewDecision;
  readonly operatorId: string;
  readonly reason: string;
  readonly decidedAt: Date | string;
  readonly createdAt: Date | string;
}

function ingestSnapshotFromRow(row: Record<string, unknown>): ProjectRagPostgresIngestSnapshot {
  return {
    id: numberField(row.id),
    snapshotUuid: stringField(row.snapshot_uuid),
    projectId: numberField(row.project_id),
    commandScope: stringField(row.command_scope),
    rootHash: (typeof row.root_hash === 'string' ? row.root_hash : null) as string | null,
    scopeHash: (typeof row.scope_hash === 'string' ? row.scope_hash : null) as string | null,
    policyHash: (typeof row.policy_hash === 'string' ? row.policy_hash : null) as string | null,
    inventoryHash: (typeof row.inventory_hash === 'string' ? row.inventory_hash : null) as
      | string
      | null,
    baselineHash: (typeof row.baseline_hash === 'string' ? row.baseline_hash : null) as
      | string
      | null,
    planHash: (typeof row.plan_hash === 'string' ? row.plan_hash : null) as string | null,
    repositoryHash: (typeof row.repository_hash === 'string' ? row.repository_hash : null) as
      | string
      | null,
    workspaceHash: (typeof row.workspace_hash === 'string' ? row.workspace_hash : null) as
      | string
      | null,
    headHash: (typeof row.head_hash === 'string' ? row.head_hash : null) as string | null,
    branchHash: (typeof row.branch_hash === 'string' ? row.branch_hash : null) as string | null,
    detachedHash: (typeof row.detached_hash === 'string' ? row.detached_hash : null) as
      | string
      | null,
    contentHash: (typeof row.content_hash === 'string' ? row.content_hash : null) as string | null,
    indexProfileHash: (typeof row.index_profile_hash === 'string'
      ? row.index_profile_hash
      : null) as string | null,
    rootManifestHash: (typeof row.root_manifest_hash === 'string'
      ? row.root_manifest_hash
      : null) as string | null,
    completenessStatus: (typeof row.completeness_status === 'string'
      ? row.completeness_status
      : null) as 'complete' | 'incomplete' | 'blocked' | null,
    completenessEvidenceHash: (typeof row.completeness_evidence_hash === 'string'
      ? row.completeness_evidence_hash
      : null) as string | null,
    deletionAllowed: typeof row.deletion_allowed === 'boolean' ? row.deletion_allowed : null,
    addsCount: numberField(row.adds_count),
    updatesCount: numberField(row.updates_count),
    deletesCount: numberField(row.deletes_count),
    eligibleCount: numberField(row.eligible_count),
    trackedCount: numberField(row.tracked_count),
    blockedFindings: Array.isArray(row.blocked_findings)
      ? (row.blocked_findings as Array<Record<string, unknown>>)
      : [],
    blockedFindingAllowlistHash: stringField(row.blocked_finding_allowlist_hash),
    suppressedBlockedFindings: suppressedBlockedFindingsFromRow(row.suppressed_blocked_findings),
    status: stringField(row.status) as IngestSnapshotStatus,
    failureCode: (typeof row.failure_code === 'string' ? row.failure_code : null) as string | null,
    failureDetail: (typeof row.failure_detail === 'string' ? row.failure_detail : null) as
      | string
      | null,
    ttlSeconds: numberField(row.ttl_seconds),
    expiresAt: row.expires_at instanceof Date ? row.expires_at : stringField(row.expires_at),
    leaseExpiresAt:
      row.lease_expires_at instanceof Date
        ? row.lease_expires_at
        : typeof row.lease_expires_at === 'string'
          ? row.lease_expires_at
          : null,
    claimedAt:
      row.claimed_at instanceof Date
        ? row.claimed_at
        : typeof row.claimed_at === 'string'
          ? row.claimed_at
          : null,
    consumedAt:
      row.consumed_at instanceof Date
        ? row.consumed_at
        : typeof row.consumed_at === 'string'
          ? row.consumed_at
          : null,
    failedAt:
      row.failed_at instanceof Date
        ? row.failed_at
        : typeof row.failed_at === 'string'
          ? row.failed_at
          : null,
    createdAt: row.created_at instanceof Date ? row.created_at : stringField(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : stringField(row.updated_at),
  };
}

function snapshotReviewFromRow(row: Record<string, unknown>): ProjectRagPostgresSnapshotReview {
  return {
    id: numberField(row.id),
    snapshotId: numberField(row.snapshot_id),
    snapshotUuid: stringField(row.snapshot_uuid),
    projectId: numberField(row.project_id),
    reviewerId: stringField(row.reviewer_id),
    operatorId: stringField(row.operator_id),
    reviewerCapability: stringField(row.reviewer_capability),
    evidenceId: stringField(row.evidence_id),
    reason: stringField(row.reason),
    commandScope: stringField(row.command_scope),
    tokenDigest: stringField(row.token_digest),
    approvedAt: row.approved_at instanceof Date ? row.approved_at : stringField(row.approved_at),
    expiresAt: row.expires_at instanceof Date ? row.expires_at : stringField(row.expires_at),
    createdAt: row.created_at instanceof Date ? row.created_at : stringField(row.created_at),
  };
}

function snapshotReviewDecisionFromRow(
  row: Record<string, unknown>
): ProjectRagPostgresSnapshotReviewDecision {
  return {
    id: numberField(row.id),
    snapshotId: numberField(row.snapshot_id),
    snapshotUuid: stringField(row.snapshot_uuid),
    projectId: numberField(row.project_id),
    decision: stringField(row.decision) as ProjectRagSnapshotReviewDecision,
    operatorId: stringField(row.operator_id),
    reason: stringField(row.reason),
    decidedAt: row.decided_at instanceof Date ? row.decided_at : stringField(row.decided_at),
    createdAt: row.created_at instanceof Date ? row.created_at : stringField(row.created_at),
  };
}

// -------------------------------------------------------------------------
// Schema readiness
// -------------------------------------------------------------------------

/** Required columns in project_ingest_snapshots for schema readiness check. */
export const SNAPSHOT_SCHEMA_COLUMNS = [
  'id',
  'snapshot_uuid',
  'project_id',
  'command_scope',
  'root_hash',
  'scope_hash',
  'policy_hash',
  'inventory_hash',
  'baseline_hash',
  'plan_hash',
  'adds_count',
  'updates_count',
  'deletes_count',
  'eligible_count',
  'tracked_count',
  'blocked_findings',
  'status',
  'failure_code',
  'failure_detail',
  'ttl_seconds',
  'expires_at',
  'lease_expires_at',
  'claimed_at',
  'consumed_at',
  'failed_at',
  'created_at',
  'updated_at',
] as const;

/** Columns added by migration 004 (blocked-finding allowlist). */
export const ALLOWLIST_SCHEMA_COLUMNS = [
  'blocked_finding_allowlist_hash',
  'suppressed_blocked_findings',
] as const;

/**
 * Assert that the ingest-snapshot schema exists and has all required
 * objects, failing closed with the first missing name.
 */
export async function assertProjectRagPostgresSnapshotSchemaReady(
  sql: ProjectRagSql
): Promise<void> {
  // Check table existence first
  const tableRows = (await sql`
    select exists (
      select 1 from pg_tables where tablename = 'project_ingest_snapshots'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (tableRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG ingest-snapshot table (migration 003) is missing. ' +
        `Run migration 003: ${PROJECT_RAG_MIGRATION_COMMAND}`
    );
  }

  // Check required columns
  for (const col of SNAPSHOT_SCHEMA_COLUMNS) {
    const colRows = (await sql`
      select exists (
        select 1
        from information_schema.columns
        where table_name = 'project_ingest_snapshots'
          and column_name = ${col}
      ) as ready
    `) as Array<Record<string, unknown>>;

    if (colRows[0]?.ready !== true) {
      throw new Error(
        `Project RAG ingest-snapshot schema is missing required column '${col}'. ` +
          `Run migration 003: ${PROJECT_RAG_MIGRATION_COMMAND}`
      );
    }
  }

  // Check triggers
  const triggerNames = [
    'project_ingest_snapshot_freeze_binding_fields',
    'project_ingest_snapshots_touch_updated_at',
  ];
  for (const tg of triggerNames) {
    const tgRows = (await sql`
      select exists (
        select 1
        from pg_trigger
        where tgname = ${tg}
          and tgrelid = to_regclass('project_ingest_snapshots')
          and not tgisinternal
      ) as ready
    `) as Array<Record<string, unknown>>;

    if (tgRows[0]?.ready !== true) {
      throw new Error(
        `Project RAG ingest-snapshot schema is missing required trigger '${tg}'. ` +
          'Run migration 003.'
      );
    }
  }

  // Check the partial unique index
  const idxRows = (await sql`
    select exists (
      select 1
      from pg_indexes
      where tablename = 'project_ingest_snapshots'
        and indexname = 'project_ingest_snapshots_one_consuming_idx'
        and indexdef like '%WHERE%status%CONSUMING%'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (idxRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG ingest-snapshot schema is missing the partial unique index ' +
        "'project_ingest_snapshots_one_consuming_idx'. Run migration 003."
    );
  }

  // Check the UNIQUE constraint on snapshot_uuid
  const uuidUniqueRows = (await sql`
    select exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('project_ingest_snapshots')
        and conname = 'project_ingest_snapshots_snapshot_uuid_unique'
        and contype = 'u'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (uuidUniqueRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG ingest-snapshot schema is missing UNIQUE constraint on snapshot_uuid. ' +
        'Run migration 003.'
    );
  }

  // Check the fail-requires-code constraint
  const failCodeRows = (await sql`
    select exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('project_ingest_snapshots')
        and conname = 'project_ingest_snapshots_fail_requires_code'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (failCodeRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG ingest-snapshot schema is missing CHECK constraint ' +
        "'project_ingest_snapshots_fail_requires_code'. Run migration 003."
    );
  }
}

/**
 * Assert that the blocked-finding allowlist schema (migration 004) exists,
 * failing closed when columns or constraints are missing.
 *
 * Separate from the 003 check so that callers in the ingestion pipeline
 * can enforce allowlist readiness without re-running the full 003 check.
 */
export async function assertProjectRagPostgresAllowlistSchemaReady(
  sql: ProjectRagSql
): Promise<void> {
  // Check required columns
  for (const col of ALLOWLIST_SCHEMA_COLUMNS) {
    const colRows = (await sql`
      select exists (
        select 1
        from information_schema.columns
        where table_name = 'project_ingest_snapshots'
          and column_name = ${col}
      ) as ready
    `) as Array<Record<string, unknown>>;

    if (colRows[0]?.ready !== true) {
      throw new Error(
        `Project RAG snapshot schema is missing migration-004 column '${col}'. ` +
          `Run: ${PROJECT_RAG_MIGRATION_COMMAND}`
      );
    }
  }

  // Check project_repositories has blocked_finding_allowlist
  const repoColRows = (await sql`
    select exists (
      select 1
      from information_schema.columns
      where table_name = 'project_repositories'
        and column_name = 'blocked_finding_allowlist'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (repoColRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG repository schema is missing migration-004 column ' +
        "'blocked_finding_allowlist'. " +
        `Run: ${PROJECT_RAG_MIGRATION_COMMAND}`
    );
  }

  // Check the freeze trigger function has BOTH 004 binding guards by
  // verifying that the function body references both new column names
  // and is in the current schema.
  const funcRows = (await sql`
    select exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'project_rag_ingest_snapshot_freeze_binding_fields'
        and n.nspname = current_schema()
        and pg_get_functiondef(p.oid) like '%blocked_finding_allowlist_hash%'
        and pg_get_functiondef(p.oid) like '%suppressed_blocked_findings%'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (funcRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG snapshot freeze trigger function does not include migration-004 ' +
        'binding-field guards (requires BOTH blocked_finding_allowlist_hash AND suppressed_blocked_findings). ' +
        `Run: ${PROJECT_RAG_MIGRATION_COMMAND}`
    );
  }

  // Check migration-004 CHECK constraints
  const allowlistCheckConstraints: ReadonlyArray<{
    readonly conname: string;
    readonly tablename: string;
  }> = [
    {
      conname: 'project_repositories_blocked_finding_allowlist_is_array',
      tablename: 'project_repositories',
    },
    {
      conname: 'project_repositories_blocked_finding_allowlist_max_length',
      tablename: 'project_repositories',
    },
    {
      conname: 'project_ingest_snapshots_suppressed_blocked_findings_is_array',
      tablename: 'project_ingest_snapshots',
    },
    {
      conname: 'project_ingest_snapshots_suppressed_blocked_findings_max_length',
      tablename: 'project_ingest_snapshots',
    },
  ];
  for (const { conname, tablename } of allowlistCheckConstraints) {
    const chkRows = (await sql`
      select exists (
        select 1
        from pg_constraint
        where conname = ${conname}
          and conrelid = to_regclass(${tablename})
      ) as ready
    `) as Array<Record<string, unknown>>;

    if (chkRows[0]?.ready !== true) {
      throw new Error(
        `Project RAG migration-004 CHECK constraint '${conname}' is missing. ` +
          `Run: ${PROJECT_RAG_MIGRATION_COMMAND}`
      );
    }
  }

  // Check migration-004 policy-race trigger on project_repositories:
  // BEFORE UPDATE trigger that rejects changes to include_roots, ignore_rules,
  // or blocked_finding_allowlist while that project has a CONSUMING snapshot.
  const policyRaceTriggerName = 'project_repositories_block_config_during_consuming';
  const triggerFuncRows = (await sql`
    select exists (
      select 1
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      where t.tgname = ${policyRaceTriggerName}
        and t.tgrelid = to_regclass('project_repositories')
        and not t.tgisinternal
        and p.proname = 'project_rag_repo_block_config_during_consuming'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (triggerFuncRows[0]?.ready !== true) {
    throw new Error(
      `Project RAG migration-004 policy-race trigger '${policyRaceTriggerName}' is missing. ` +
        `Run: ${PROJECT_RAG_MIGRATION_COMMAND}`
    );
  }
}

/**
 * Assert that the single-use snapshot-review table from migration 005 is
 * available. This check is intentionally separate from the normal ingest
 * readiness path: unapproved ingest remains fail-closed without requiring
 * the optional approval table, while approval/resume paths must prove it.
 */
export async function assertProjectRagPostgresSnapshotReviewSchemaReady(
  sql: ProjectRagSql
): Promise<void> {
  const tableRows = (await sql`
    select exists (
      select 1 from pg_tables where tablename = 'project_ingest_snapshot_reviews'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (tableRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG snapshot-review table (migration 005) is missing. ' +
        `Run migration 005: ${PROJECT_RAG_MIGRATION_COMMAND}`
    );
  }

  const requiredColumns = [
    'snapshot_id',
    'snapshot_uuid',
    'project_id',
    'reviewer_id',
    'operator_id',
    'reviewer_capability',
    'evidence_id',
    'reason',
    'command_scope',
    'token_digest',
    'approved_at',
    'expires_at',
    'created_at',
  ] as const;
  for (const col of requiredColumns) {
    const colRows = (await sql`
      select exists (
        select 1
        from information_schema.columns
        where table_name = 'project_ingest_snapshot_reviews'
          and column_name = ${col}
      ) as ready
    `) as Array<Record<string, unknown>>;

    if (colRows[0]?.ready !== true) {
      throw new Error(
        `Project RAG snapshot-review schema is missing required column '${col}'. ` +
          `Run migration 005: ${PROJECT_RAG_MIGRATION_COMMAND}`
      );
    }
  }

  const uniqueRows = (await sql`
    select exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('project_ingest_snapshot_reviews')
        and conname = 'project_ingest_snapshot_reviews_one_per_snapshot'
        and contype = 'u'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (uniqueRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG snapshot-review schema is missing its single-use UNIQUE constraint. ' +
        'Run migration 005.'
    );
  }

  const decisionTableRows = (await sql`
    select exists (
      select 1 from pg_tables where tablename = 'project_ingest_snapshot_review_decisions'
    ) as ready
  `) as Array<Record<string, unknown>>;

  if (decisionTableRows[0]?.ready !== true) {
    throw new Error(
      'Project RAG snapshot-review decision table (migration 005) is missing. ' +
        'Run migration 005.'
    );
  }
}

// -------------------------------------------------------------------------
// Insert
// -------------------------------------------------------------------------

/**
 * Insert a new ingest snapshot row.
 *
 * Initial status must be PREPARED, REVIEW_REQUIRED, or FAILED
 * (FAILED requires a failureCode).  Throws when RETURNING yields no row.
 */
/**
 * Validate that a status is one of the three allowed initial states.
 * FAILED requires a failureCode (enforced by DB constraint but checked
 * early for a better error message).
 */
function assertValidInitialStatus(status: string, failureCode?: string | null): void {
  const valid: SnapshotInitialStatus[] = ['PREPARED', 'REVIEW_REQUIRED', 'FAILED'];
  if (!(valid as readonly string[]).includes(status)) {
    throw new Error(
      `Invalid initial snapshot status '${status}'. Must be one of: ${valid.join(', ')}`
    );
  }
  if (status === 'FAILED' && !failureCode) {
    throw new Error('FAILED status requires a non-empty failureCode');
  }
}

export async function insertProjectRagPostgresIngestSnapshotInTransaction(
  tx: ProjectRagWriteSql,
  input: ProjectRagPostgresIngestSnapshotInput
): Promise<ProjectRagPostgresIngestSnapshot> {
  const status = input.status ?? 'PREPARED';
  assertValidInitialStatus(status, input.failureCode);

  // Validate blocked findings >32 throws (no capping)
  const rawFindings = input.blockedFindings ?? [];
  if (rawFindings.length > BLOCKED_FINDINGS_MAX) {
    throw new Error(
      `Blocked findings count ${rawFindings.length} exceeds max ${BLOCKED_FINDINGS_MAX}`
    );
  }
  const blockedFindings = JSON.stringify(rawFindings);

  const ttlSeconds = input.ttlSeconds ?? 300;
  const allowlistHash = input.blockedFindingAllowlistHash ?? EMPTY_ALLOWLIST_HASH;

  // Validate suppressed findings — throws on >32 or malformed (no capping)
  const suppressedFindings = input.suppressedBlockedFindings ?? [];
  if (suppressedFindings.length > 0) {
    validateSuppressedBlockedFindings(suppressedFindings);
  }
  const suppressedJson = JSON.stringify(suppressedFindings);

  const rows = (await tx`
    insert into project_ingest_snapshots (
      project_id, command_scope,
      root_hash, scope_hash, policy_hash,
      inventory_hash, baseline_hash, plan_hash,
      repository_hash, workspace_hash, head_hash, branch_hash, detached_hash,
      content_hash, index_profile_hash, root_manifest_hash,
      completeness_status, completeness_evidence_hash, deletion_allowed,
      adds_count, updates_count, deletes_count,
      eligible_count, tracked_count,
      blocked_findings,
      blocked_finding_allowlist_hash,
      suppressed_blocked_findings,
      ttl_seconds, expires_at,
      status, failure_code, failure_detail
    )
    values (
      ${input.projectId}, ${input.commandScope ?? 'full'},
      ${input.rootHash ?? null}, ${input.scopeHash ?? null}, ${input.policyHash ?? null},
      ${input.inventoryHash ?? null}, ${input.baselineHash ?? null}, ${input.planHash ?? null},
      ${input.identity?.repositoryHash ?? null}, ${input.identity?.workspaceHash ?? null},
      ${input.identity?.headHash ?? null}, ${input.identity?.branchHash ?? null},
      ${input.identity?.detachedHash ?? null}, ${input.contentHash ?? null},
      ${input.indexProfileHash ?? null}, ${input.rootManifestHash ?? null},
      ${input.completenessStatus ?? null}, ${input.completenessEvidenceHash ?? null},
      ${input.deletionAllowed ?? null},
      ${input.addsCount ?? 0}, ${input.updatesCount ?? 0}, ${input.deletesCount ?? 0},
      ${input.eligibleCount ?? 0}, ${input.trackedCount ?? 0},
      ${blockedFindings}::jsonb,
      ${allowlistHash},
      ${suppressedJson}::jsonb,
      ${ttlSeconds}, now() + make_interval(secs => ${ttlSeconds}),
      ${status}, ${input.failureCode ?? null}, ${input.failureDetail ?? null}
    )
    returning *
  `) as Array<Record<string, unknown>>;

  if (!rows[0]) {
    throw new Error('insertProjectRagPostgresIngestSnapshot returned no row');
  }

  return ingestSnapshotFromRow(rows[0]);
}

export async function insertProjectRagPostgresIngestSnapshot(
  sql: ProjectRagSql,
  input: ProjectRagPostgresIngestSnapshotInput
): Promise<ProjectRagPostgresIngestSnapshot> {
  return beginProjectRagWrite(sql, (tx) =>
    insertProjectRagPostgresIngestSnapshotInTransaction(tx, input)
  );
}

// -------------------------------------------------------------------------
// Find
// -------------------------------------------------------------------------

/**
 * Find a snapshot by numeric id (scoped to projectId for safety).
 *
 * Prefer findProjectRagPostgresIngestSnapshotByUuid for external callers.
 */
export async function findProjectRagPostgresIngestSnapshot(
  sql: ProjectRagSql,
  projectId: number,
  snapshotId: number
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  const rows = (await sql`
    select *
    from project_ingest_snapshots
    where id = ${snapshotId}
      and project_id = ${projectId}
    limit 1
  `) as Array<Record<string, unknown>>;

  return rows[0] ? ingestSnapshotFromRow(rows[0]) : undefined;
}

/**
 * Find a snapshot by its external UUID identifier.
 */
export async function findProjectRagPostgresIngestSnapshotByUuid(
  sql: ProjectRagSql,
  projectId: number,
  snapshotUuid: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  const rows = (await sql`
    select *
    from project_ingest_snapshots
    where snapshot_uuid = ${snapshotUuid}::uuid
      and project_id = ${projectId}
    limit 1
  `) as Array<Record<string, unknown>>;

  return rows[0] ? ingestSnapshotFromRow(rows[0]) : undefined;
}

/** Find one globally unique external snapshot UUID for operator inspection. */
export async function findProjectRagPostgresIngestSnapshotByExternalUuid(
  sql: ProjectRagSql,
  snapshotUuid: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  const rows = (await sql`
    select *
    from project_ingest_snapshots
    where snapshot_uuid = ${snapshotUuid}::uuid
    limit 1
  `) as Array<Record<string, unknown>>;

  return rows[0] ? ingestSnapshotFromRow(rows[0]) : undefined;
}

// -------------------------------------------------------------------------
// List
// -------------------------------------------------------------------------

/**
 * List ingest snapshots for a project, most recent first.
 */
export async function listProjectRagPostgresIngestSnapshots(
  sql: ProjectRagSql,
  projectId: number,
  args: { readonly limit?: number; readonly status?: IngestSnapshotStatus } = {}
): Promise<ProjectRagPostgresIngestSnapshot[]> {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
  const rows = args.status
    ? ((await sql`
        select *
        from project_ingest_snapshots
        where project_id = ${projectId}
          and status = ${args.status}
        order by created_at desc
        limit ${limit}
      `) as Array<Record<string, unknown>>)
    : ((await sql`
        select *
        from project_ingest_snapshots
        where project_id = ${projectId}
        order by created_at desc
        limit ${limit}
      `) as Array<Record<string, unknown>>);

  return rows.map(ingestSnapshotFromRow);
}

// -------------------------------------------------------------------------
// Snapshot review (single-use REVIEW_REQUIRED approval)
// -------------------------------------------------------------------------

/** Find the current, unexpired review for one project snapshot. */
export async function findProjectRagPostgresSnapshotReview(
  sql: ProjectRagSql,
  projectId: number,
  snapshotUuid: string
): Promise<ProjectRagPostgresSnapshotReview | undefined> {
  const rows = (await sql`
    select r.*
    from project_ingest_snapshot_reviews r
    join project_ingest_snapshots s on s.id = r.snapshot_id
    where r.project_id = ${projectId}
      and r.snapshot_uuid = ${snapshotUuid}::uuid
      and r.expires_at > now()
      and s.project_id = r.project_id
      and s.snapshot_uuid = r.snapshot_uuid
      and s.status in ('REVIEW_REQUIRED', 'CONSUMING')
    order by r.approved_at desc
    limit 1
  `) as Array<Record<string, unknown>>;

  return rows[0] ? snapshotReviewFromRow(rows[0]) : undefined;
}

/** Insert a review only when the exact live REVIEW_REQUIRED snapshot matches. */
export async function insertProjectRagPostgresSnapshotReviewInTransaction(
  tx: ProjectRagWriteSql,
  input: ProjectRagPostgresSnapshotReviewInput
): Promise<ProjectRagPostgresSnapshotReview> {
  const rows = (await tx`
    insert into project_ingest_snapshot_reviews (
      snapshot_id, snapshot_uuid, project_id,
      reviewer_id, operator_id, reviewer_capability, evidence_id,
      reason, command_scope, token_digest, expires_at
    )
    select
      s.id, s.snapshot_uuid, s.project_id,
      ${input.reviewerId}, ${input.operatorId}, ${input.reviewerCapability}, ${input.evidenceId},
      ${input.reason}, ${input.commandScope}, ${input.tokenDigest}, ${input.expiresAt}
    from project_ingest_snapshots s
    where s.snapshot_uuid = ${input.snapshotUuid}::uuid
      and s.project_id = ${input.projectId}
      and s.status = 'REVIEW_REQUIRED'
      and s.expires_at > now()
      and s.command_scope = ${input.commandScope}
      and s.expires_at >= ${input.expiresAt}
      and pg_try_advisory_xact_lock(hashtextextended(s.snapshot_uuid::text, 0))
      and not exists (
        select 1
        from project_ingest_snapshot_reviews existing
        where existing.snapshot_id = s.id
      )
      and not exists (
        select 1
        from project_ingest_snapshot_review_decisions decision
        where decision.snapshot_id = s.id
      )
    returning *
  `) as Array<Record<string, unknown>>;

  if (!rows[0]) {
    throw new Error(
      'Snapshot review refused: the exact snapshot is missing, expired, not REVIEW_REQUIRED, ' +
        'scope-mismatched, or already reviewed'
    );
  }

  return snapshotReviewFromRow(rows[0]);
}

export async function insertProjectRagPostgresSnapshotReview(
  sql: ProjectRagSql,
  input: ProjectRagPostgresSnapshotReviewInput
): Promise<ProjectRagPostgresSnapshotReview> {
  return beginProjectRagWrite(sql, (tx) =>
    insertProjectRagPostgresSnapshotReviewInTransaction(tx, input)
  );
}

/** Persist one immutable operator decision for a current REVIEW_REQUIRED snapshot. */
export async function insertProjectRagPostgresSnapshotReviewDecisionInTransaction(
  tx: ProjectRagWriteSql,
  input: {
    readonly snapshotUuid: string;
    readonly decision: ProjectRagSnapshotReviewDecision;
    readonly operatorId: string;
    readonly reason: string;
  }
): Promise<ProjectRagPostgresSnapshotReviewDecision> {
  const rows = (await tx`
    insert into project_ingest_snapshot_review_decisions (
      snapshot_id, snapshot_uuid, project_id, decision, operator_id, reason
    )
    select s.id, s.snapshot_uuid, s.project_id,
      ${input.decision}, ${input.operatorId}, ${input.reason}
    from project_ingest_snapshots s
    where s.snapshot_uuid = ${input.snapshotUuid}::uuid
      and s.status = 'REVIEW_REQUIRED'
      and s.expires_at > now()
      and pg_try_advisory_xact_lock(hashtextextended(s.snapshot_uuid::text, 0))
      and not exists (
        select 1 from project_ingest_snapshot_reviews review where review.snapshot_id = s.id
      )
      and not exists (
        select 1 from project_ingest_snapshot_review_decisions existing where existing.snapshot_id = s.id
      )
    returning *
  `) as Array<Record<string, unknown>>;

  if (!rows[0]) {
    throw new Error(
      'Snapshot review decision refused: the exact snapshot is missing, expired, not REVIEW_REQUIRED, or already decided'
    );
  }

  return snapshotReviewDecisionFromRow(rows[0]);
}

export async function insertProjectRagPostgresSnapshotReviewDecision(
  sql: ProjectRagSql,
  input: {
    readonly snapshotUuid: string;
    readonly decision: ProjectRagSnapshotReviewDecision;
    readonly operatorId: string;
    readonly reason: string;
  }
): Promise<ProjectRagPostgresSnapshotReviewDecision> {
  return beginProjectRagWrite(sql, (tx) =>
    insertProjectRagPostgresSnapshotReviewDecisionInTransaction(tx, input)
  );
}

/** Reject a reviewed snapshot after first recording its immutable operator audit row. */
export async function rejectProjectRagPostgresIngestSnapshotReviewInTransaction(
  tx: ProjectRagWriteSql,
  input: {
    readonly snapshotUuid: string;
    readonly operatorId: string;
    readonly reason: string;
  }
): Promise<ProjectRagPostgresIngestSnapshot> {
  const rows = (await tx`
    with decision as (
      insert into project_ingest_snapshot_review_decisions (
        snapshot_id, snapshot_uuid, project_id, decision, operator_id, reason
      )
      select s.id, s.snapshot_uuid, s.project_id, 'REJECTED', ${input.operatorId}, ${input.reason}
      from project_ingest_snapshots s
      where s.snapshot_uuid = ${input.snapshotUuid}::uuid
        and s.status = 'REVIEW_REQUIRED'
        and s.expires_at > now()
        and pg_try_advisory_xact_lock(hashtextextended(s.snapshot_uuid::text, 0))
        and not exists (
          select 1 from project_ingest_snapshot_reviews review where review.snapshot_id = s.id
        )
        and not exists (
          select 1 from project_ingest_snapshot_review_decisions existing where existing.snapshot_id = s.id
        )
      returning snapshot_id
    )
    update project_ingest_snapshots s
    set status = 'FAILED',
        failure_code = 'REVIEW_REJECTED',
        failure_detail = ${input.reason},
        failed_at = now(),
        updated_at = now()
    from decision
    where s.id = decision.snapshot_id
    returning s.*
  `) as Array<Record<string, unknown>>;

  if (!rows[0]) {
    throw new Error(
      'Snapshot review rejection refused: the exact snapshot is missing, expired, not REVIEW_REQUIRED, or already decided'
    );
  }

  return ingestSnapshotFromRow(rows[0]);
}

export async function rejectProjectRagPostgresIngestSnapshotReview(
  sql: ProjectRagSql,
  input: {
    readonly snapshotUuid: string;
    readonly operatorId: string;
    readonly reason: string;
  }
): Promise<ProjectRagPostgresIngestSnapshot> {
  return beginProjectRagWrite(sql, (tx) =>
    rejectProjectRagPostgresIngestSnapshotReviewInTransaction(tx, input)
  );
}

// -------------------------------------------------------------------------
// Claim (atomic PREPARED -> CONSUMING)
// -------------------------------------------------------------------------

/**
 * Detect Postgres unique_violation (SQLSTATE 23505).
 *
 * Bun.SQL surfaces SQLSTATE on `errno` (number or string) and sets
 * `code` to a driver string such as `ERR_POSTGRES_SERVER_ERROR`.
 * Some mocks/drivers put SQLSTATE on `code` instead. Accept either.
 */
export function isPostgresUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as { code?: unknown; errno?: unknown };
  return candidate.code === '23505' || candidate.errno === 23505 || candidate.errno === '23505';
}

/**
 * Atomic claim by numeric id.
 *
 * Only succeeds when:
 *  - status = 'PREPARED'
 *  - expires_at > now() (not expired)
 *  - no other CONSUMING snapshot exists for this project
 *    (enforced by the partial unique index)
 *
 * Catches SQLSTATE 23505 (unique violation from concurrent claim of the
 * same project) and returns undefined, matching the documented contract.
 */
export async function claimProjectRagPostgresIngestSnapshotInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  snapshotId: number,
  allowApprovedReview = false
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  try {
    const rows = allowApprovedReview
      ? ((await tx`
          update project_ingest_snapshots s
          set status = 'CONSUMING',
            claimed_at = now(),
            lease_expires_at = now() + make_interval(secs => ttl_seconds),
            updated_at = now()
          where s.id = ${snapshotId}
            and s.project_id = ${projectId}
            and s.expires_at > now()
            and (
              s.status = 'PREPARED'
              or (
                s.status = 'REVIEW_REQUIRED'
                and exists (
                  select 1
                  from project_ingest_snapshot_reviews r
                  where r.snapshot_id = s.id
                    and r.snapshot_uuid = s.snapshot_uuid
                    and r.project_id = s.project_id
                    and r.command_scope = s.command_scope
                    and r.expires_at > now()
                )
              )
            )
          returning s.*
        `) as Array<Record<string, unknown>>)
      : ((await tx`
          update project_ingest_snapshots
          set status = 'CONSUMING',
            claimed_at = now(),
            lease_expires_at = now() + make_interval(secs => ttl_seconds),
            updated_at = now()
          where id = ${snapshotId}
            and project_id = ${projectId}
            and status = 'PREPARED'
            and expires_at > now()
          returning *
        `) as Array<Record<string, unknown>>);

    return rows[0] ? ingestSnapshotFromRow(rows[0]) : undefined;
  } catch (err: unknown) {
    // SQLSTATE 23505 — unique violation on one_consuming_idx
    if (isPostgresUniqueViolation(err)) {
      return undefined;
    }
    throw err;
  }
}

export async function claimProjectRagPostgresIngestSnapshot(
  sql: ProjectRagSql,
  projectId: number,
  snapshotId: number,
  allowApprovedReview = false
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    claimProjectRagPostgresIngestSnapshotInTransaction(
      tx,
      projectId,
      snapshotId,
      allowApprovedReview
    )
  );
}

/**
 * Atomic claim by snapshot UUID.
 */
export async function claimProjectRagPostgresIngestSnapshotByUuidInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  snapshotUuid: string,
  allowApprovedReview = false
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  try {
    const rows = allowApprovedReview
      ? ((await tx`
          update project_ingest_snapshots s
          set status = 'CONSUMING',
            claimed_at = now(),
            lease_expires_at = now() + make_interval(secs => ttl_seconds),
            updated_at = now()
          where s.snapshot_uuid = ${snapshotUuid}::uuid
            and s.project_id = ${projectId}
            and s.expires_at > now()
            and (
              s.status = 'PREPARED'
              or (
                s.status = 'REVIEW_REQUIRED'
                and exists (
                  select 1
                  from project_ingest_snapshot_reviews r
                  where r.snapshot_id = s.id
                    and r.snapshot_uuid = s.snapshot_uuid
                    and r.project_id = s.project_id
                    and r.command_scope = s.command_scope
                    and r.expires_at > now()
                )
              )
            )
          returning s.*
        `) as Array<Record<string, unknown>>)
      : ((await tx`
          update project_ingest_snapshots
          set status = 'CONSUMING',
            claimed_at = now(),
            lease_expires_at = now() + make_interval(secs => ttl_seconds),
            updated_at = now()
          where snapshot_uuid = ${snapshotUuid}::uuid
            and project_id = ${projectId}
            and status = 'PREPARED'
            and expires_at > now()
          returning *
        `) as Array<Record<string, unknown>>);

    return rows[0] ? ingestSnapshotFromRow(rows[0]) : undefined;
  } catch (err: unknown) {
    if (isPostgresUniqueViolation(err)) {
      return undefined;
    }
    throw err;
  }
}

export async function claimProjectRagPostgresIngestSnapshotByUuid(
  sql: ProjectRagSql,
  projectId: number,
  snapshotUuid: string,
  allowApprovedReview = false
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    claimProjectRagPostgresIngestSnapshotByUuidInTransaction(
      tx,
      projectId,
      snapshotUuid,
      allowApprovedReview
    )
  );
}

// -------------------------------------------------------------------------
// Consume (CONSUMING -> CONSUMED)
// -------------------------------------------------------------------------

/**
 * Transition a CONSUMING snapshot to CONSUMED (success).
 *
 * Requires a live (non-null, non-expired) lease so that a dead/abandoned
 * snapshot cannot be consumed.  This prevents accidental double-consume
 * when a stale unswept CONSUMING row has an expired lease.
 */
export async function consumeProjectRagPostgresIngestSnapshotInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  snapshotId: number,
  snapshotUuid: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  const rows = (await tx`
    update project_ingest_snapshots
    set status = 'CONSUMED',
      consumed_at = now(),
      updated_at = now()
    where id = ${snapshotId}
      and project_id = ${projectId}
      and snapshot_uuid = ${snapshotUuid}::uuid
      and status = 'CONSUMING'
      and lease_expires_at is not null
      and lease_expires_at > clock_timestamp()
    returning *
  `) as Array<Record<string, unknown>>;

  return rows[0] ? ingestSnapshotFromRow(rows[0]) : undefined;
}

export async function consumeProjectRagPostgresIngestSnapshot(
  sql: ProjectRagSql,
  projectId: number,
  snapshotId: number,
  snapshotUuid: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    consumeProjectRagPostgresIngestSnapshotInTransaction(tx, projectId, snapshotId, snapshotUuid)
  );
}

// -------------------------------------------------------------------------
// Lease renewal (extend lease_expires_at for a CONSUMING snapshot)
// -------------------------------------------------------------------------

/**
 * Renew the lease on a CONSUMING ingest snapshot.
 *
 * Extends `lease_expires_at` by `ttl_seconds` from now.  Only succeeds
 * when:
 *  - status = 'CONSUMING'
 *  - project_id matches
 *  - lease_expires_at > now() (dead lease cannot resurrect)
 *
 * Returns the updated snapshot, or undefined when the snapshot is no
 * longer CONSUMING (lease lost / consumed / failed / expired).
 *
 * The `lease_expires_at > now()` requirement prevents a dead lease from
 * being resurrected after the sweep has marked the snapshot FAILED/EXPIRED.
 */
export async function renewProjectRagPostgresIngestSnapshotLeaseInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  snapshotId: number,
  snapshotUuid: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  try {
    const rows = (await tx`
      update project_ingest_snapshots
      set lease_expires_at = now() + make_interval(secs => ttl_seconds),
        updated_at = now()
      where id = ${snapshotId}
        and project_id = ${projectId}
        and snapshot_uuid = ${snapshotUuid}::uuid
        and status = 'CONSUMING'
        and lease_expires_at > now()
      returning *
    `) as Array<Record<string, unknown>>;

    return rows[0] ? ingestSnapshotFromRow(rows[0]) : undefined;
  } catch (err: unknown) {
    // SQLSTATE 23505 — unique violation (should not happen on renewal
    // since status doesn't change, but handle gracefully)
    if (isPostgresUniqueViolation(err)) {
      return undefined;
    }
    throw err;
  }
}

export async function renewProjectRagPostgresIngestSnapshotLease(
  sql: ProjectRagSql,
  projectId: number,
  snapshotId: number,
  snapshotUuid: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    renewProjectRagPostgresIngestSnapshotLeaseInTransaction(tx, projectId, snapshotId, snapshotUuid)
  );
}

// -------------------------------------------------------------------------
// Fail (any non-terminal -> FAILED)
// -------------------------------------------------------------------------

/**
 * Transition any active (non-terminal) snapshot to FAILED.
 *
 * Enforces allowed failure codes.  Sanitizes failure_detail (removes
 * absolute paths, control chars, truncates to 1024).
 */
export async function failProjectRagPostgresIngestSnapshotInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number,
  snapshotId: number,
  failureCode: SnapshotFailureCode,
  failureDetail?: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  if (!(ALLOWED_FAILURE_CODES as readonly string[]).includes(failureCode)) {
    throw new Error(
      `Invalid failure code '${failureCode}'. Allowed: ${ALLOWED_FAILURE_CODES.join(', ')}`
    );
  }

  const sanitized = sanitizeFailureDetail(failureDetail);

  const rows = (await tx`
    update project_ingest_snapshots
    set status = 'FAILED',
      failure_code = ${failureCode},
      failure_detail = ${sanitized},
      failed_at = now(),
      updated_at = now()
    where id = ${snapshotId}
      and project_id = ${projectId}
      and status NOT IN ('CONSUMED', 'FAILED', 'EXPIRED')
    returning *
  `) as Array<Record<string, unknown>>;

  return rows[0] ? ingestSnapshotFromRow(rows[0]) : undefined;
}

export async function failProjectRagPostgresIngestSnapshot(
  sql: ProjectRagSql,
  projectId: number,
  snapshotId: number,
  failureCode: SnapshotFailureCode,
  failureDetail?: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    failProjectRagPostgresIngestSnapshotInTransaction(
      tx,
      projectId,
      snapshotId,
      failureCode,
      failureDetail
    )
  );
}

// -------------------------------------------------------------------------
// Sweep — bulk expiry for stale snapshots
// -------------------------------------------------------------------------

/**
 * Sweep stale snapshots for exactly one project inside a caller-owned
 * transaction. This function never opens a nested transaction.
 *
 * Two passes:
 *  1. PREPARED / REVIEW_REQUIRED past expires_at → EXPIRED (TTL elapsed)
 *  2. CONSUMING past lease_expires_at → FAILED / CLAIM_LEASE_ABANDONED
 *
 * Uses RETURNING to return the ids of affected snapshots.
 */
export async function sweepStaleProjectRagPostgresIngestSnapshotsInTransaction(
  tx: ProjectRagWriteSql,
  projectId: number
): Promise<{
  readonly expiredCount: number;
  readonly expiredIds: number[];
  readonly abandonedCount: number;
  readonly abandonedIds: number[];
}> {
  // Pass 1: TTL expiry — PREPARED or REVIEW_REQUIRED past expires_at.
  const expiredRows = (await tx`
    update project_ingest_snapshots
    set status = 'EXPIRED',
      updated_at = now()
    where project_id = ${projectId}
      and status IN ('PREPARED', 'REVIEW_REQUIRED')
      and expires_at <= now()
    returning id
  `) as Array<{ id: number | string }>;

  const expiredIds = expiredRows.map((r) => numberField(r.id)).filter(Boolean);

  // Pass 2: Lease abandonment — CONSUMING past lease_expires_at.
  const abandonedRows = (await tx`
    update project_ingest_snapshots
    set status = 'FAILED',
      failure_code = 'CLAIM_LEASE_ABANDONED',
      failure_detail = 'Consumer did not complete within lease TTL',
      failed_at = now(),
      updated_at = now()
    where project_id = ${projectId}
      and status = 'CONSUMING'
      and lease_expires_at is not null
      and lease_expires_at <= now()
    returning id
  `) as Array<{ id: number | string }>;

  const abandonedIds = abandonedRows.map((r) => numberField(r.id)).filter(Boolean);

  return {
    expiredCount: expiredIds.length,
    expiredIds,
    abandonedCount: abandonedIds.length,
    abandonedIds,
  };
}

/** Standalone pool wrapper for an explicitly selected project. */
export async function sweepStaleProjectRagPostgresIngestSnapshots(
  sql: ProjectRagSql,
  projectId: number
): Promise<{
  readonly expiredCount: number;
  readonly expiredIds: number[];
  readonly abandonedCount: number;
  readonly abandonedIds: number[];
}> {
  return beginProjectRagWrite(sql, (tx) =>
    sweepStaleProjectRagPostgresIngestSnapshotsInTransaction(tx, projectId)
  );
}

function projectRagJobFromRow(row: Record<string, unknown>): ProjectRagPostgresJob {
  const timestampField = (value: unknown): Date | string | null =>
    value instanceof Date || typeof value === 'string' ? value : null;
  return {
    id: numberField(row.id),
    type: stringField(row.type),
    projectId: row.project_id === null ? null : numberField(row.project_id),
    dedupeKey: typeof row.dedupe_key === 'string' ? row.dedupe_key : null,
    status: stringField(row.status) as ProjectRagJobStatus,
    payload: (row.payload as Record<string, unknown>) ?? {},
    result: row.result ?? null,
    attempts: numberField(row.attempts),
    maxAttempts: numberField(row.max_attempts),
    workerId: typeof row.worker_id === 'string' ? row.worker_id : null,
    fenceToken: numberField(row.fence_token),
    leaseExpiresAt: timestampField(row.lease_expires_at),
    checkpoint: (row.checkpoint as Record<string, unknown>) ?? {},
    snapshotUuid: typeof row.snapshot_uuid === 'string' ? row.snapshot_uuid : null,
    error: typeof row.error === 'string' ? row.error : null,
    availableAt: timestampField(row.available_at),
    cancelRequestedAt: timestampField(row.cancel_requested_at),
    blockedAt: timestampField(row.blocked_at),
    deadLetteredAt: timestampField(row.dead_lettered_at),
    statusReason: typeof row.status_reason === 'string' ? row.status_reason : null,
  };
}

export const PROJECT_RAG_JOB_DEFAULT_RETRY_DELAY_MS = 1_000;
export const PROJECT_RAG_JOB_MAX_RETRY_DELAY_MS = 5 * 60_000;
export const PROJECT_RAG_JOB_MAX_ERROR_BYTES = 8 * 1024;

function normalizeJobMaxAttempts(value: number | undefined): number {
  const maxAttempts = value ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error('Project RAG job maxAttempts must be an integer between 1 and 100');
  }
  return maxAttempts;
}

function boundedRetryDelayMs(value: number | undefined, attempts: number): number {
  const exponential = PROJECT_RAG_JOB_DEFAULT_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  const requested = value ?? exponential;
  if (!Number.isFinite(requested) || requested < 0) {
    throw new Error('Project RAG job retryDelayMs must be a finite non-negative number');
  }
  return Math.min(Math.floor(requested), PROJECT_RAG_JOB_MAX_RETRY_DELAY_MS);
}

function boundedJobError(error: string): string {
  return error.slice(0, PROJECT_RAG_JOB_MAX_ERROR_BYTES);
}

/** Insert once per active dedupe key.  A duplicate returns the extant job. */
export async function enqueueProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  input: EnqueueProjectRagJobInput
): Promise<EnqueueProjectRagJobResult> {
  const maxAttempts = normalizeJobMaxAttempts(input.maxAttempts);
  const rows = (await tx`
    insert into project_jobs (
      type, project_id, dedupe_key, payload, max_attempts, snapshot_uuid, available_at
    )
    values (
      ${input.type}, ${input.projectId ?? null}, ${input.dedupeKey ?? null},
      ${JSON.stringify(input.payload)}::jsonb, ${maxAttempts}, ${input.snapshotUuid ?? null}::uuid,
      coalesce(${input.availableAt ?? null}, now())
    )
    on conflict (dedupe_key)
      where dedupe_key is not null
        and status in ('queued', 'running', 'blocked-review', 'retry-wait')
    do update set updated_at = project_jobs.updated_at
    returning *, (xmax = 0) as inserted
  `) as Array<Record<string, unknown>>;
  if (!rows[0]) throw new Error('Project RAG job enqueue returned no row');
  // xmax is 0 only for a row created by this statement; a conflict-update row
  // carries the current statement's xid instead.
  return { ...projectRagJobFromRow(rows[0]), inserted: rows[0].inserted === true };
}

export async function enqueueProjectRagJob(
  sql: ProjectRagSql,
  input: EnqueueProjectRagJobInput
): Promise<EnqueueProjectRagJobResult> {
  await assertProjectRagPostgresJobLifecycleSchemaReady(sql);
  return beginProjectRagWrite(sql, (tx) => enqueueProjectRagJobInTransaction(tx, input));
}

/**
 * Claim one available job or recover one expired lease.
 *
 * `FOR UPDATE SKIP LOCKED` gives each concurrent worker a distinct row.  A
 * reclaimed row receives a new fence token before it becomes visible to the
 * caller, so the previous worker cannot renew, checkpoint, or publish.
 */
export async function claimProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  workerId: string,
  leaseSeconds = 60
): Promise<ProjectRagPostgresJob | undefined> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) {
    throw new Error('Project RAG job leaseSeconds must be an integer between 1 and 86400');
  }
  const rows = (await tx`
    with candidate as (
      select id from project_jobs
      where (
          (status in ('queued', 'retry-wait') and available_at <= clock_timestamp())
          or (status = 'running' and lease_expires_at <= clock_timestamp())
        )
        and attempts < max_attempts
        and cancel_requested_at is null
      order by created_at, id
      for update skip locked limit 1
    )
    update project_jobs j set status = 'running', worker_id = ${workerId},
      attempts = j.attempts + 1, last_attempt_at = now(), heartbeat_at = now(),
      lease_expires_at = clock_timestamp() + make_interval(secs => ${leaseSeconds}),
      available_at = clock_timestamp(), cancel_requested_at = null,
      status_reason = null, fence_token = j.fence_token + 1,
      started_at = coalesce(j.started_at, now()), updated_at = now()
    from candidate where j.id = candidate.id returning j.*
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function claimProjectRagJob(
  sql: ProjectRagSql,
  workerId: string,
  leaseSeconds = 60
): Promise<ProjectRagPostgresJob | undefined> {
  await assertProjectRagPostgresJobLifecycleSchemaReady(sql);
  return beginProjectRagWrite(sql, (tx) =>
    claimProjectRagJobInTransaction(tx, workerId, leaseSeconds)
  );
}

/** Recover expired leases in one atomic update; safe to call on every restart. */
export async function recoverStaleProjectRagJobsInTransaction(
  tx: ProjectRagWriteSql,
  limit = 100,
  retryDelayMs?: number
): Promise<ProjectRagJobRecoveryResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Project RAG job recovery limit must be an integer between 1 and 1000');
  }
  const delay = boundedRetryDelayMs(retryDelayMs, 1);
  const rows = (await tx`
    with stale as (
      select id, attempts, max_attempts
      from project_jobs
      where status = 'running'
        and lease_expires_at is not null
        and lease_expires_at <= clock_timestamp()
      order by lease_expires_at, id
      for update skip locked
      limit ${limit}
    )
    update project_jobs j
    set status = case
        when j.cancel_requested_at is not null then 'cancelled'
        when j.attempts >= j.max_attempts then 'dead-letter'
        else 'retry-wait'
      end,
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      available_at = case
        when j.cancel_requested_at is not null or j.attempts >= j.max_attempts then clock_timestamp()
        else clock_timestamp() + make_interval(secs => ${delay / 1000})
      end,
      dead_lettered_at = case
        when j.cancel_requested_at is null and j.attempts >= j.max_attempts then clock_timestamp()
        else null
      end,
      completed_at = case when j.cancel_requested_at is not null then clock_timestamp() else null end,
      cancel_requested_at = null,
      status_reason = case
        when j.cancel_requested_at is not null then 'cancelled during lease recovery'
        else 'worker lease expired; recovered after restart'
      end,
      updated_at = now()
    from stale
    where j.id = stale.id
    returning j.id, j.status
  `) as Array<Record<string, unknown>>;
  const recoveredIds: number[] = [];
  const deadLetteredIds: number[] = [];
  for (const row of rows) {
    const id = numberField(row.id);
    if (!id) continue;
    if (row.status === 'dead-letter') deadLetteredIds.push(id);
    else recoveredIds.push(id);
  }
  return { recoveredIds, deadLetteredIds };
}

export async function recoverStaleProjectRagJobs(
  sql: ProjectRagSql,
  limit = 100,
  retryDelayMs?: number
): Promise<ProjectRagJobRecoveryResult> {
  await assertProjectRagPostgresJobLifecycleSchemaReady(sql);
  return beginProjectRagWrite(sql, (tx) =>
    recoverStaleProjectRagJobsInTransaction(tx, limit, retryDelayMs)
  );
}

/** Compatibility name for operators and restart probes. */
export const recoverProjectRagJobs = recoverStaleProjectRagJobs;

/** Bind a running durable ingest job to its exact project and snapshot. */
export async function bindProjectRagJobIdentityInTransaction(
  tx: ProjectRagWriteSql,
  input: {
    readonly jobId: number;
    readonly fenceToken: number;
    readonly projectId: number;
    readonly snapshotUuid: string;
  }
): Promise<void> {
  const rows = (await tx`
    update project_jobs
    set project_id = ${input.projectId},
      snapshot_uuid = ${input.snapshotUuid}::uuid,
      updated_at = now()
    where id = ${input.jobId}
      and status = 'running'
      and fence_token = ${input.fenceToken}
      and lease_expires_at > clock_timestamp()
      and cancel_requested_at is null
      and (project_id is null or project_id = ${input.projectId})
      and (snapshot_uuid is null or snapshot_uuid = ${input.snapshotUuid}::uuid)
    returning id
  `) as Array<Record<string, unknown>>;
  if (!rows[0]) {
    throw new Error('Project RAG durable job identity did not match its project or snapshot');
  }
}

/** Renew a running job only while this worker still owns its current fence. */
export async function renewProjectRagJobLeaseInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  fenceToken: number,
  leaseSeconds = 60
): Promise<ProjectRagPostgresJob | undefined> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) {
    throw new Error('Project RAG job leaseSeconds must be an integer between 1 and 86400');
  }
  const rows = (await tx`
    update project_jobs
    set heartbeat_at = now(), lease_expires_at = clock_timestamp() + make_interval(secs => ${leaseSeconds}),
      updated_at = now()
    where id = ${jobId} and status = 'running' and fence_token = ${fenceToken}
      and lease_expires_at > clock_timestamp()
    returning *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function renewProjectRagJobLease(
  sql: ProjectRagSql,
  jobId: number,
  fenceToken: number,
  leaseSeconds = 60
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    renewProjectRagJobLeaseInTransaction(tx, jobId, fenceToken, leaseSeconds)
  );
}

/** Persist bounded progress under the same fence used for publication. */
export async function checkpointProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  fenceToken: number,
  checkpoint: ProjectRagJobCheckpoint | Record<string, unknown>
): Promise<ProjectRagPostgresJob | undefined> {
  const serializedCheckpoint = serializeProjectRagJobResult(checkpoint);
  const rows = (await tx`
    update project_jobs
    set checkpoint = ${serializedCheckpoint}::jsonb,
      heartbeat_at = now(), updated_at = now()
    where id = ${jobId}
      and status = 'running'
      and fence_token = ${fenceToken}
      and lease_expires_at > clock_timestamp()
      and cancel_requested_at is null
    returning *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function checkpointProjectRagJob(
  sql: ProjectRagSql,
  jobId: number,
  fenceToken: number,
  checkpoint: ProjectRagJobCheckpoint | Record<string, unknown>
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    checkpointProjectRagJobInTransaction(tx, jobId, fenceToken, checkpoint)
  );
}

/** Explicit alias used by worker integrations that call progress updates. */
export const updateProjectRagJobCheckpoint = checkpointProjectRagJob;

/** Move a leased job to the operator-review queue without reporting success. */
export async function blockProjectRagJobForReviewInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  fenceToken: number,
  result: unknown,
  reason = 'Project RAG ingest requires snapshot review'
): Promise<ProjectRagPostgresJob | undefined> {
  const serializedResult = serializeProjectRagJobResult(result);
  const rows = (await tx`
    update project_jobs
    set status = 'blocked-review', result = ${serializedResult}::jsonb,
      worker_id = null, lease_expires_at = null, heartbeat_at = null,
      blocked_at = clock_timestamp(), status_reason = ${boundedJobError(reason)},
      updated_at = now()
    where id = ${jobId}
      and status = 'running'
      and fence_token = ${fenceToken}
      and lease_expires_at > clock_timestamp()
      and cancel_requested_at is null
    returning *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function blockProjectRagJobForReview(
  sql: ProjectRagSql,
  jobId: number,
  fenceToken: number,
  result: unknown,
  reason = 'Project RAG ingest requires snapshot review'
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    blockProjectRagJobForReviewInTransaction(tx, jobId, fenceToken, result, reason)
  );
}

export interface CancelProjectRagJobOptions {
  readonly fenceToken?: number;
  readonly reason?: string;
}

/**
 * Cancel a queued/retry/review job, or a running job when its live fence is
 * supplied.  A caller without the current fence cannot cancel a running job.
 */
export async function cancelProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  options: CancelProjectRagJobOptions | number = {}
): Promise<ProjectRagPostgresJob | undefined> {
  const normalized = typeof options === 'number' ? { fenceToken: options } : options;
  const reason = boundedJobError(normalized.reason ?? 'cancelled by operator');
  const rows =
    normalized.fenceToken === undefined
      ? ((await tx`
          update project_jobs
          set status = 'cancelled', worker_id = null, lease_expires_at = null,
            cancel_requested_at = null, completed_at = now(), status_reason = ${reason},
            updated_at = now()
          where id = ${jobId}
            and status in ('queued', 'retry-wait', 'blocked-review')
          returning *
        `) as Array<Record<string, unknown>>)
      : ((await tx`
          update project_jobs
          set status = 'cancelled', worker_id = null, lease_expires_at = null,
            cancel_requested_at = null, completed_at = now(), status_reason = ${reason},
            updated_at = now()
          where id = ${jobId}
            and status = 'running'
            and fence_token = ${normalized.fenceToken}
            and lease_expires_at > clock_timestamp()
          returning *
        `) as Array<Record<string, unknown>>);
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function cancelProjectRagJob(
  sql: ProjectRagSql,
  jobId: number,
  options: CancelProjectRagJobOptions | number = {}
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) => cancelProjectRagJobInTransaction(tx, jobId, options));
}

/** Ask a running worker to stop at its next heartbeat/checkpoint boundary. */
export async function requestCancelProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  reason = 'cancellation requested by operator'
): Promise<ProjectRagPostgresJob | undefined> {
  const rows = (await tx`
    update project_jobs
    set cancel_requested_at = clock_timestamp(), status_reason = ${boundedJobError(reason)},
      updated_at = now()
    where id = ${jobId} and status = 'running' and lease_expires_at > clock_timestamp()
    returning *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function requestCancelProjectRagJob(
  sql: ProjectRagSql,
  jobId: number,
  reason = 'cancellation requested by operator'
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    requestCancelProjectRagJobInTransaction(tx, jobId, reason)
  );
}

/** Resume a review-blocked or retry-wait job with a fresh availability time. */
export async function resumeProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  reason = 'resumed by operator'
): Promise<ProjectRagPostgresJob | undefined> {
  const rows = (await tx`
    update project_jobs
    set status = 'queued', available_at = clock_timestamp(), blocked_at = null,
      cancel_requested_at = null, status_reason = ${boundedJobError(reason)}, updated_at = now()
    where id = ${jobId} and status in ('blocked-review', 'retry-wait')
    returning *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function resumeProjectRagJob(
  sql: ProjectRagSql,
  jobId: number,
  reason = 'resumed by operator'
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) => resumeProjectRagJobInTransaction(tx, jobId, reason));
}

export const retryProjectRagJob = resumeProjectRagJob;

/** Read one job without changing its lease or pool state. */
export async function getProjectRagJob(
  sql: ProjectRagSql,
  jobId: number
): Promise<ProjectRagPostgresJob | undefined> {
  const rows = (await sql`
    select * from project_jobs where id = ${jobId}
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export interface ListProjectRagJobsOptions {
  readonly projectId?: number;
  readonly status?: ProjectRagJobStatus;
  readonly limit?: number;
}

/** Bounded operator/status view; no payload expansion or mutation occurs. */
export async function listProjectRagJobs(
  sql: ProjectRagSql,
  options: ListProjectRagJobsOptions = {}
): Promise<ProjectRagPostgresJob[]> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Project RAG job list limit must be an integer between 1 and 1000');
  }
  const rows = (await sql`
    select * from project_jobs
    where (${options.projectId ?? null}::bigint is null or project_id = ${options.projectId ?? null})
      and (${options.status ?? null}::text is null or status = ${options.status ?? null})
    order by created_at desc, id desc
    limit ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(projectRagJobFromRow);
}

export const findProjectRagJob = getProjectRagJob;

/**
 * Run one mutation under a short transaction that locks and validates the
 * current durable-job fence. The operation and ownership check therefore have
 * no reclaim window between them.
 *
 * Delegates to the transaction module — the sole top-level begin owner.
 */
export async function withProjectRagJobFence<T>(
  sql: ProjectRagSql,
  fence: ProjectRagJobFence | undefined,
  operation: (tx: ProjectRagWriteSql) => Promise<T>,
  snapshotFence?: ProjectRagSnapshotFence
): Promise<T> {
  return beginProjectRagFencedWrite(
    sql,
    fence,
    'Project RAG job lease was lost before mutation',
    operation,
    undefined,
    snapshotFence
  );
}

/** Fenced terminal update: a reclaimed worker cannot overwrite its successor. */
export async function finishProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  fenceToken: number,
  result: unknown,
  status: ProjectRagJobTerminalStatus = 'succeeded'
): Promise<ProjectRagPostgresJob | undefined> {
  const serializedResult = serializeProjectRagJobResult(result);
  const rows = (await tx`
    update project_jobs set status = ${status}, result = ${serializedResult}::jsonb,
      completed_at = clock_timestamp(), lease_expires_at = null, worker_id = null,
      heartbeat_at = null, cancel_requested_at = null,
      dead_lettered_at = case when ${status} = 'dead-letter' then clock_timestamp() else dead_lettered_at end,
      updated_at = now()
    where id = ${jobId} and status = 'running' and fence_token = ${fenceToken}
      and lease_expires_at > clock_timestamp()
      and cancel_requested_at is null
    returning *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function finishProjectRagJob(
  sql: ProjectRagSql,
  jobId: number,
  fenceToken: number,
  result: unknown,
  status: ProjectRagJobTerminalStatus = 'succeeded'
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    finishProjectRagJobInTransaction(tx, jobId, fenceToken, result, status)
  );
}

export async function failProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  fenceToken: number,
  error: string,
  options: ProjectRagJobRetryOptions = {}
): Promise<ProjectRagPostgresJob | undefined> {
  const retryDelay = boundedRetryDelayMs(options.retryDelayMs, 1);
  const errorText = boundedJobError(error);
  const rows = (await tx`
    update project_jobs set
      status = case
        when cancel_requested_at is not null then 'cancelled'
        when attempts >= max_attempts or ${options.retryable === false} then 'dead-letter'
        else 'retry-wait'
      end,
      error = ${errorText}, worker_id = null, lease_expires_at = null,
      heartbeat_at = null, cancel_requested_at = null,
      available_at = case
        when cancel_requested_at is not null
          or attempts >= max_attempts or ${options.retryable === false} then clock_timestamp()
        else clock_timestamp() + make_interval(secs => ${retryDelay / 1000})
      end,
      dead_lettered_at = case
        when cancel_requested_at is null
          and (attempts >= max_attempts or ${options.retryable === false}) then clock_timestamp()
        else null
      end,
      completed_at = case
        when cancel_requested_at is not null
          or attempts >= max_attempts or ${options.retryable === false} then clock_timestamp()
        else null
      end,
      status_reason = case
        when cancel_requested_at is not null then 'cancelled during worker failure'
        when attempts >= max_attempts or ${options.retryable === false} then 'retry budget exhausted'
        else 'retry scheduled after worker failure'
      end,
      updated_at = now()
    where id = ${jobId} and status = 'running' and fence_token = ${fenceToken}
      and lease_expires_at > clock_timestamp()
    returning *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function failProjectRagJob(
  sql: ProjectRagSql,
  jobId: number,
  fenceToken: number,
  error: string,
  options: ProjectRagJobRetryOptions = {}
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    failProjectRagJobInTransaction(tx, jobId, fenceToken, error, options)
  );
}

/** Terminally quarantine a job that cannot make progress. */
export async function deadLetterProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  reason: string,
  fenceToken?: number
): Promise<ProjectRagPostgresJob | undefined> {
  const errorText = boundedJobError(reason);
  const rows =
    fenceToken === undefined
      ? ((await tx`
          update project_jobs
          set status = 'dead-letter', error = ${errorText}, status_reason = ${errorText},
            worker_id = null, lease_expires_at = null, heartbeat_at = null,
            dead_lettered_at = clock_timestamp(), completed_at = clock_timestamp(),
            updated_at = now()
          where id = ${jobId} and status in ('queued', 'retry-wait', 'blocked-review')
          returning *
        `) as Array<Record<string, unknown>>)
      : ((await tx`
          update project_jobs
          set status = 'dead-letter', error = ${errorText}, status_reason = ${errorText},
            worker_id = null, lease_expires_at = null, heartbeat_at = null,
            dead_lettered_at = clock_timestamp(), completed_at = clock_timestamp(),
            updated_at = now()
          where id = ${jobId} and status = 'running'
            and fence_token = ${fenceToken} and lease_expires_at > clock_timestamp()
          returning *
        `) as Array<Record<string, unknown>>);
  return rows[0] ? projectRagJobFromRow(rows[0]) : undefined;
}

export async function deadLetterProjectRagJob(
  sql: ProjectRagSql,
  jobId: number,
  reason: string,
  fenceToken?: number
): Promise<ProjectRagPostgresJob | undefined> {
  return beginProjectRagWrite(sql, (tx) =>
    deadLetterProjectRagJobInTransaction(tx, jobId, reason, fenceToken)
  );
}

// -------------------------------------------------------------------------
// Sync runs — per-ingest execution records closed by the atomic finalizer
// -------------------------------------------------------------------------

export type ProjectRagSyncRunInsertInput =
  | {
      readonly projectId: number;
      readonly mode: 'full' | 'file';
      readonly snapshotUuid: string;
      readonly jobId: null;
    }
  | {
      readonly projectId: number;
      readonly mode: 'full' | 'file';
      readonly snapshotUuid: string;
      readonly jobId: number;
    };

/** Open one running sync-run row inside the caller's transaction unit. */
export async function insertProjectRagPostgresSyncRunInTransaction(
  tx: ProjectRagWriteSql,
  input: ProjectRagSyncRunInsertInput
): Promise<number> {
  const jobId = 'jobId' in input ? input.jobId : null;
  const rows = (await tx`
    insert into project_sync_runs (project_id, status, mode, snapshot_uuid, job_id)
    select ${input.projectId}, 'running', ${input.mode}, ${input.snapshotUuid}::uuid, ${jobId}::bigint
    where exists (
      select 1 from project_ingest_snapshots
      where snapshot_uuid = ${input.snapshotUuid}::uuid
        and project_id = ${input.projectId}
    )
      and (
        ${jobId}::bigint is null
        or exists (
          select 1 from project_jobs
          where id = ${jobId}::bigint
            and project_id = ${input.projectId}
            and snapshot_uuid = ${input.snapshotUuid}::uuid
        )
      )
    returning id
  `) as Array<Record<string, unknown>>;
  const syncRunId = numberField(rows[0]?.id);
  if (!syncRunId) {
    throw new Error(
      'Project RAG sync run binding did not match its project, snapshot, or durable job'
    );
  }
  return syncRunId;
}

export interface ProjectRagSyncRunStats {
  readonly filesScanned?: number;
  readonly filesDeleted?: number;
  readonly chunksCreated?: number;
  readonly errors?: ReadonlyArray<{ readonly file: string; readonly error: string }>;
}

/**
 * Close a sync-run row inside the caller's transaction unit.  Only a row still
 * in 'running' state is transitioned; the surrounding unit owns visibility.
 */
export async function completeProjectRagPostgresSyncRunInTransaction(
  tx: ProjectRagWriteSql,
  syncRunId: number,
  projectId: number,
  status: 'completed' | 'partial' | 'failed',
  stats: ProjectRagSyncRunStats = {}
): Promise<void> {
  const rows = (await tx`
    update project_sync_runs set
      status = ${status},
      files_scanned = coalesce(${stats.filesScanned ?? null}, files_scanned),
      files_deleted = coalesce(${stats.filesDeleted ?? null}, files_deleted),
      chunks_created = coalesce(${stats.chunksCreated ?? null}, chunks_created),
      errors = ${JSON.stringify(stats.errors ?? [])}::jsonb,
      completed_at = now(),
      updated_at = now()
    where id = ${syncRunId}
      and project_id = ${projectId}
      and status = 'running'
    returning id
  `) as Array<Record<string, unknown>>;
  if (!rows[0]) {
    throw new Error(`Project RAG sync run ${syncRunId} was not running`);
  }
}

// -------------------------------------------------------------------------
// Atomic ingest finalization
//
// Publication, snapshot consumption, sync-run completion, and job outcome are
// one fenced transaction unit.  A stale or reclaimed worker rolls back every
// staged write and publishes nothing.
// -------------------------------------------------------------------------

export interface ProjectRagForegroundFinalization {
  readonly kind: 'foreground';
}

export interface ProjectRagDurableFinalization {
  readonly kind: 'durable';
  readonly job: {
    readonly jobId: number;
    readonly fenceToken: number;
    readonly result: unknown;
  };
}

export type ProjectRagIngestFinalization =
  | ProjectRagForegroundFinalization
  | ProjectRagDurableFinalization;

export interface ProjectRagIngestCompletionInput {
  readonly projectId: number;
  readonly revisionId?: number;
  readonly snapshotId: number;
  readonly snapshotUuid: string;
  readonly syncRunId: number;
  /** Publish a fresh build over the prior pointer as part of the unit. */
  readonly publishBuild: boolean;
  /** Cooperative cancellation checked inside the fenced publication unit. */
  readonly signal?: AbortSignal;
  /** Explicitly selects foreground or durable finalization. */
  readonly execution: ProjectRagIngestFinalization;
}

export interface ProjectRagIngestCompletionResult {
  readonly publishedBuildId?: number;
}

async function succeedProjectRagJobInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  fenceToken: number,
  serializedResult: string
): Promise<void> {
  const rows = (await tx`
    update project_jobs set status = 'succeeded',
      result = ${serializedResult}::jsonb,
      completed_at = now(), lease_expires_at = null, updated_at = now()
    where id = ${jobId} and status = 'running'
      and fence_token = ${fenceToken} and lease_expires_at > clock_timestamp()
      and cancel_requested_at is null
      and project_id is not null and snapshot_uuid is not null
    returning id
  `) as Array<Record<string, unknown>>;
  if (!rows[0]) {
    throw new Error('Project RAG job lease was lost before ingest completion');
  }
}

async function assertProjectRagFinalizationIdentityInTransaction(
  tx: ProjectRagWriteSql,
  input: {
    readonly projectId: number;
    readonly snapshotId: number;
    readonly snapshotUuid: string;
    readonly syncRunId?: number;
    readonly execution:
      | { readonly kind: 'foreground' }
      | {
          readonly kind: 'durable';
          readonly job: { readonly jobId: number; readonly fenceToken: number };
        };
  }
): Promise<{ readonly allowEmptyBuild: boolean }> {
  if (input.execution.kind === 'durable') {
    const jobRows = (await tx`
      select id
      from project_jobs
      where id = ${input.execution.job.jobId}
        and status = 'running'
        and fence_token = ${input.execution.job.fenceToken}
        and project_id = ${input.projectId}
        and snapshot_uuid = ${input.snapshotUuid}::uuid
        and lease_expires_at > clock_timestamp()
      for update
    `) as Array<Record<string, unknown>>;
    if (!jobRows[0]) {
      throw new Error(
        'Project RAG durable finalization identity mismatch: job, project, or snapshot does not match'
      );
    }
  }

  const snapshotRows = (await tx`
    select id, completeness_status, completeness_evidence_hash,
      eligible_count, deletion_allowed
    from project_ingest_snapshots
    where id = ${input.snapshotId}
      and project_id = ${input.projectId}
      and snapshot_uuid = ${input.snapshotUuid}::uuid
      and status = 'CONSUMING'
      and lease_expires_at is not null
      and lease_expires_at > clock_timestamp()
    for update
  `) as Array<Record<string, unknown>>;
  if (!snapshotRows[0]) {
    throw new Error(
      `snapshot_identity_mismatch: snapshot ${input.snapshotId} does not match project ${input.projectId} and UUID`
    );
  }

  // Empty publication is safe only when this exact claimed snapshot proves
  // that the complete scan observed zero eligible files and authorized the
  // corresponding deletion plan. Legacy snapshots without evidence remain
  // fail-closed and cannot replace a published non-empty build with empty.
  const allowEmptyBuild =
    snapshotRows[0].completeness_status === 'complete' &&
    typeof snapshotRows[0].completeness_evidence_hash === 'string' &&
    snapshotRows[0].completeness_evidence_hash.length > 0 &&
    numberField(snapshotRows[0].eligible_count) === 0 &&
    snapshotRows[0].deletion_allowed === true;

  if (input.syncRunId !== undefined) {
    const syncRows =
      input.execution.kind === 'durable'
        ? ((await tx`
            select id
            from project_sync_runs
            where id = ${input.syncRunId}
              and project_id = ${input.projectId}
              and snapshot_uuid = ${input.snapshotUuid}::uuid
              and job_id = ${input.execution.job.jobId}
              and status = 'running'
            for update
          `) as Array<Record<string, unknown>>)
        : ((await tx`
            select id
            from project_sync_runs
            where id = ${input.syncRunId}
              and project_id = ${input.projectId}
              and snapshot_uuid = ${input.snapshotUuid}::uuid
              and job_id is null
              and status = 'running'
            for update
          `) as Array<Record<string, unknown>>);
    if (!syncRows[0]) {
      throw new Error(
        `sync_identity_mismatch: sync run ${input.syncRunId} does not match the project, snapshot, and execution job`
      );
    }
  }

  return { allowEmptyBuild };
}

function assertProjectRagFinalizationExecution(execution: { readonly kind: string }): void {
  if (execution.kind === 'foreground' && 'job' in execution) {
    throw new Error('Foreground Project RAG finalization cannot accept a durable job payload');
  }
  if (execution.kind !== 'foreground' && execution.kind !== 'durable') {
    throw new Error('Project RAG finalization execution kind is invalid');
  }
}

/**
 * Atomically finalize a completed ingest.
 *
 * One fenced transaction unit: validate the durable-job fence (FOR UPDATE,
 * clock_timestamp), publish the candidate build, consume the exact claimed
 * snapshot, close the sync run as completed, and mark the job succeeded.  Any
 * failure — including a snapshot that is no longer CONSUMING — rolls back the
 * whole unit so readers keep the prior published state untouched.
 */
export async function completeProjectRagPostgresIngest(
  sql: ProjectRagSql,
  input: ProjectRagIngestCompletionInput
): Promise<ProjectRagIngestCompletionResult> {
  assertProjectRagFinalizationExecution(input.execution);
  const assertCompletionActive = (): void => {
    if (input.signal?.aborted) {
      throw new Error('Project RAG ingest was cancelled during finalization');
    }
  };
  const durableExecution = input.execution.kind === 'durable' ? input.execution : undefined;
  const serializedResult = durableExecution
    ? serializeProjectRagJobResult(durableExecution.job.result)
    : '';
  return beginProjectRagFencedWrite(
    sql,
    durableExecution
      ? {
          jobId: durableExecution.job.jobId,
          fenceToken: durableExecution.job.fenceToken,
        }
      : undefined,
    'Project RAG job lease was lost before ingest completion',
    async (tx) => {
      const identity = await assertProjectRagFinalizationIdentityInTransaction(tx, input);
      assertCompletionActive();
      const published = input.publishBuild
        ? await writePublishedProjectRagIndexBuildInTransaction(
            tx,
            input.projectId,
            input.revisionId,
            { allowEmpty: identity.allowEmptyBuild }
          )
        : undefined;
      assertCompletionActive();

      // Exact-snapshot consumption: a concurrent actor consuming/failing the
      // snapshot first makes this unit throw and roll back the publication.
      const consumed = await consumeProjectRagPostgresIngestSnapshotInTransaction(
        tx,
        input.projectId,
        input.snapshotId,
        input.snapshotUuid
      );
      if (!consumed) {
        throw new Error(
          `snapshot_consume_failed: no CONSUMING snapshot ${input.snapshotId} for project ${input.projectId}`
        );
      }

      await completeProjectRagPostgresSyncRunInTransaction(
        tx,
        input.syncRunId,
        input.projectId,
        'completed'
      );
      assertCompletionActive();

      return published ? { publishedBuildId: published.id } : {};
    },
    async (tx) => {
      assertCompletionActive();
      if (durableExecution) {
        await succeedProjectRagJobInTransaction(
          tx,
          durableExecution.job.jobId,
          durableExecution.job.fenceToken,
          serializedResult
        );
        assertCompletionActive();
      }
    },
    {
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotUuid: input.snapshotUuid,
      terminalTransition: 'CONSUMED',
    }
  );
}

export interface ProjectRagIngestPartialFailureInput {
  readonly projectId: number;
  readonly snapshotId: number;
  readonly snapshotUuid: string;
  readonly failureCode: SnapshotFailureCode;
  readonly failureDetail: string;
  readonly syncRunId?: number;
  readonly filesScanned?: number;
  readonly filesDeleted?: number;
  readonly chunksCreated?: number;
  readonly errors?: ReadonlyArray<{ readonly file: string; readonly error: string }>;
  readonly execution:
    | { readonly kind: 'foreground' }
    | {
        readonly kind: 'durable';
        readonly job: {
          readonly jobId: number;
          readonly fenceToken: number;
          readonly error: string;
        };
      };
}

/**
 * Fenced partial-ingest closure: fail the claimed snapshot, close the sync run
 * as 'partial', and (for durable jobs) terminate the job as failed — one unit.
 * A stale fence writes nothing.
 */
export async function failProjectRagPostgresIngestPartial(
  sql: ProjectRagSql,
  input: ProjectRagIngestPartialFailureInput
): Promise<void> {
  assertProjectRagFinalizationExecution(input.execution);
  const durableExecution = input.execution.kind === 'durable' ? input.execution : undefined;
  await beginProjectRagFencedWrite(
    sql,
    durableExecution
      ? { jobId: durableExecution.job.jobId, fenceToken: durableExecution.job.fenceToken }
      : undefined,
    'Project RAG job lease was lost before partial-ingest closure',
    async (tx) => {
      await assertProjectRagFinalizationIdentityInTransaction(tx, input);
      const failedSnapshot = await failProjectRagPostgresIngestSnapshotInTransaction(
        tx,
        input.projectId,
        input.snapshotId,
        input.failureCode,
        input.failureDetail
      );
      if (!failedSnapshot) {
        throw new Error(
          `snapshot_failure_failed: no active snapshot ${input.snapshotId} for project ${input.projectId}`
        );
      }
      if (input.syncRunId !== undefined) {
        await completeProjectRagPostgresSyncRunInTransaction(
          tx,
          input.syncRunId,
          input.projectId,
          'partial',
          {
            filesScanned: input.filesScanned,
            filesDeleted: input.filesDeleted,
            chunksCreated: input.chunksCreated,
            errors: input.errors,
          }
        );
      }
    },
    durableExecution
      ? (tx) =>
          failProjectRagJobForFinalizationInTransaction(
            tx,
            durableExecution.job.jobId,
            durableExecution.job.fenceToken,
            durableExecution.job.error
          )
      : undefined,
    {
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      snapshotUuid: input.snapshotUuid,
      terminalTransition: 'FAILED',
    }
  );
}

async function failProjectRagJobForFinalizationInTransaction(
  tx: ProjectRagWriteSql,
  jobId: number,
  fenceToken: number,
  error: string
): Promise<void> {
  const rows = (await tx`
    update project_jobs set status = 'failed',
      error = ${error.slice(0, 2000)},
      completed_at = now(), lease_expires_at = null, updated_at = now()
    where id = ${jobId} and status = 'running'
      and fence_token = ${fenceToken}
      and lease_expires_at > clock_timestamp()
      and project_id is not null
      and snapshot_uuid is not null
    returning id
  `) as Array<Record<string, unknown>>;
  if (!rows[0]) {
    throw new Error('Project RAG job lease was lost before partial-ingest closure');
  }
}

export interface ProjectRagIngestAbortInput {
  readonly projectId: number;
  readonly snapshotId: number;
  readonly snapshotUuid: string;
  readonly failureCode: SnapshotFailureCode;
  readonly failureDetail: string;
  readonly syncRunId?: number;
  readonly execution:
    | { readonly kind: 'foreground' }
    | {
        readonly kind: 'durable';
        readonly job: { readonly jobId: number; readonly fenceToken: number };
      };
}

/**
 * Abort an errored ingest: fail the claimed snapshot and close the sync run as
 * 'failed' inside one fenced unit.  Never throws — a lost fence means the
 * reclaiming worker now owns the snapshot outcome, so this writes nothing and
 * reports `false` instead of masking the original ingest error.  The job row
 * itself is left to the worker's own fenced failure path.
 */
export async function abortProjectRagPostgresIngest(
  sql: ProjectRagSql,
  input: ProjectRagIngestAbortInput
): Promise<boolean> {
  assertProjectRagFinalizationExecution(input.execution);
  const durableExecution = input.execution.kind === 'durable' ? input.execution : undefined;
  try {
    await beginProjectRagFencedWrite(
      sql,
      durableExecution
        ? { jobId: durableExecution.job.jobId, fenceToken: durableExecution.job.fenceToken }
        : undefined,
      'Project RAG job lease was lost before ingest abort',
      async (tx) => {
        await assertProjectRagFinalizationIdentityInTransaction(tx, input);
        const failedSnapshot = await failProjectRagPostgresIngestSnapshotInTransaction(
          tx,
          input.projectId,
          input.snapshotId,
          input.failureCode,
          input.failureDetail
        );
        if (!failedSnapshot) {
          throw new Error(
            `snapshot_failure_failed: no active snapshot ${input.snapshotId} for project ${input.projectId}`
          );
        }
        if (input.syncRunId !== undefined) {
          await completeProjectRagPostgresSyncRunInTransaction(
            tx,
            input.syncRunId,
            input.projectId,
            'failed'
          );
        }
      },
      undefined,
      {
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        snapshotUuid: input.snapshotUuid,
        terminalTransition: 'FAILED',
      }
    );
    return true;
  } catch {
    // Abort cleanup is best effort; database/provider errors may contain
    // connection details or payload data and must not reach operator logs.
    process.stderr.write('[ingest] abort_finalization_skipped\n');
    return false;
  }
}
