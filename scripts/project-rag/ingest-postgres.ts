import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import pLimit from 'p-limit';
import { chunkTextWithContextProfile } from '../../lib/ingest/chunker.js';
import { redactPII } from '../../lib/ingest/pii_redactor.js';
import { validateProjectIncludeRoots } from '../../lib/shared/project-include-roots.js';
import { normalizeProjectRootPath } from '../../lib/shared/project-registry.js';
import { checkFileSecurity, redactSensitiveContent } from '../../lib/shared/project-security.js';
import { type ParsedEdge, type ParsedSymbol, parseAst } from '../lib/ast-parser.js';
import { SCRIPT_CONFIG } from '../lib/config.js';
import { calculateProjectContentHash } from '../lib/project-content-hash.js';
import { generateSkeletonWithVersion } from '../lib/skeleton-generator.js';
import { resolveProjectRagPostgresWriteConfig } from './config.js';
import {
  type ResolvedProjectRagWorkspaceContext,
  resolveProjectRagWorkspaceContext,
} from './context.js';
import { detectLanguage } from './eligibility.js';
import {
  fetchProjectRagPostgresEmbeddings,
  resolveProjectRagPostgresEmbeddingConfig,
} from './embeddings.js';
import { buildPreflightPlan } from './project-inventory.js';
import {
  EMPTY_ROOT_MANIFEST_HASH,
  type ProjectRagScopeOperation,
  readRootManifest,
  resolveProjectRagScope,
} from './root-manifest.js';
import {
  type ProgressCallback,
  prepareSnapshotInTransaction,
  revalidateBaseline,
} from './snapshot-gate.js';
import {
  ContentHashMismatchError,
  hashBlockedFindingAllowlist,
  hashSuppressedBlockedFindings,
  LeaseLostError,
  refreshRequiresReview,
  SnapshotRescanMismatchError,
} from './snapshot-policy.js';
import type {
  ProjectRagSnapshotDeletionContext,
  ProjectRagSyncRunInsertInput,
  SnapshotFailureCode,
} from './store.js';
import {
  abortProjectRagPostgresIngest,
  assertProjectRagPostgresAllowlistSchemaReady,
  assertProjectRagPostgresIndexBuildSchemaReady,
  assertProjectRagPostgresSchemaReady,
  assertProjectRagPostgresSnapshotReviewSchemaReady,
  assertProjectRagPostgresSnapshotSchemaReady,
  assertProjectRagPostgresSyncRunBindingSchemaReady,
  bindProjectRagJobIdentityInTransaction,
  claimProjectRagPostgresIngestSnapshotInTransaction,
  completeProjectRagPostgresIngest,
  createProjectRagPostgresSql,
  deleteProjectRagPostgresFileInTransaction,
  failProjectRagPostgresCandidateVersionInTransaction,
  failProjectRagPostgresIngestPartial,
  failProjectRagPostgresIngestSnapshotInTransaction,
  findProjectRagPostgresIngestSnapshotByUuid,
  findProjectRagPostgresProject,
  findProjectRagPostgresProjectByRootPath,
  findProjectRagPostgresSnapshotReview,
  insertProjectRagPostgresSyncRunInTransaction,
  listProjectRagPostgresChunkEmbeddingCandidates,
  listProjectRagPostgresFileStates,
  renewProjectRagPostgresIngestSnapshotLeaseInTransaction,
  repairProjectRagPostgresFileVersionsInTransaction,
  replaceProjectRagPostgresFileEdgesInTransaction,
  replaceProjectRagPostgresFileSymbolsInTransaction,
  resolveProjectRagPostgresEdgeTargetsInTransaction,
  sweepStaleProjectRagPostgresIngestSnapshotsInTransaction,
  upsertProjectRagPostgresChunkEmbedding1024InTransaction,
  upsertProjectRagPostgresFileInTransaction,
  upsertProjectRagPostgresFileWithChunksInTransaction,
  upsertProjectRagPostgresRepositoryInTransaction,
  upsertProjectRagWorkspaceAliasInTransaction,
  upsertProjectRagWorkspaceContextInTransaction,
  withProjectRagJobFence,
} from './store.js';
import {
  type ProjectRagSnapshotFence,
  ProjectRagSnapshotLeaseLostError,
  type ProjectRagWriteSql,
} from './transaction.js';

export interface ProjectRagPostgresIngestArgs {
  /** Explicit identity supplied by package callers; legacy callers may omit it. */
  readonly projectSlug?: string;
  readonly rootPath: string;
  /** Omission preserves a registered project's scope; new projects use the manifest. */
  readonly includeRoots?: readonly string[];
  /** Optional scope policy; existing scope is immutable unless `replace` is explicit. */
  readonly ignoreRules?: readonly string[];
  readonly scopeOperation?: ProjectRagScopeOperation;
  readonly filePath?: string;
  readonly force?: boolean;
  readonly maxFiles?: number;
  readonly concurrency?: number;
  /** Reuse a live snapshot previously approved by the qualified reviewer. */
  readonly approvedSnapshotUuid?: string;
  /** Cooperative cancellation for bounded preparation owners. */
  readonly signal?: AbortSignal;
  /** Internal durable-job fence checked before ingest mutations and publication. */
  readonly jobLease?: {
    readonly jobId: number;
    readonly fenceToken: number;
    readonly assertOwnership: () => Promise<void>;
  };
}

export interface ProjectRagPostgresIngestResult {
  readonly projectId: string;
  readonly slug: string;
  readonly postgresId: number;
  readonly finalStatus: 'completed' | 'partial';
  readonly continuation?: {
    readonly maxFiles: number;
    readonly totalOperations: number;
    readonly remainingOperations: number;
    readonly remainingStalePaths: number;
    readonly remainingCandidateFiles: number;
  };
  readonly stats: {
    readonly filesScanned: number;
    readonly filesSelected: number;
    readonly filesIndexed: number;
    readonly filesBlocked: number;
    readonly filesDeleted: number;
    readonly chunksCreated: number;
    readonly embeddingsCreated: number;
    readonly errors: Array<{ readonly file: string; readonly error: string }>;
  };
  /** Present only after a complete ingest atomically publishes its immutable build. */
  readonly publishedBuildId?: number;
  /** Durable workers use this to avoid a second terminal job mutation. */
  readonly jobFinalized?: boolean;
  /** Present when the snapshot-gate path was exercised. */
  readonly snapshotGate?: {
    readonly snapshotUuid: string;
    readonly status: string;
    readonly thresholdResult: string;
    readonly preflightSummary: {
      readonly addsCount: number;
      readonly updatesCount: number;
      readonly deletesCount: number;
      readonly eligibleCount: number;
      readonly trackedCount: number;
      readonly totalDelta: number;
      readonly blockedFindingCategories: string;
    };
  };
}

type MutableProjectRagPostgresIngestStats = {
  filesScanned: number;
  filesSelected: number;
  filesIndexed: number;
  filesBlocked: number;
  filesDeleted: number;
  chunksCreated: number;
  embeddingsCreated: number;
  errors: Array<{ file: string; error: string }>;
};

type ProjectRagPostgresIngestCandidate = {
  readonly absolutePath: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly mode: 'ingest' | 'recover-pending';
};

export class ProjectRagIngestionScopeTooLargeError extends Error {
  readonly code = 'MCP_INGESTION_SCOPE_TOO_LARGE';

  constructor(operationCount: number, maxFiles: number) {
    super(
      `Forced ingestion requires ${operationCount} operations, exceeding the bounded limit of ${maxFiles}. ` +
        'Increase maxFiles with MCP_ALLOW_LARGE_PROJECT_INGEST=true or run bounded delta ingestion.'
    );
    this.name = 'ProjectRagIngestionScopeTooLargeError';
  }
}

function slugifyProjectName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

function sourcePathFor(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).replace(/\\/g, '/');
}

async function calculateBlockedFileFingerprint(
  sourcePath: string,
  sizeBytes: number,
  fileModifiedAt: number
): Promise<string> {
  return await calculateProjectContentHash(`blocked:${sourcePath}:${sizeBytes}:${fileModifiedAt}`);
}

/** Bounded per-file failure evidence stored on the failed candidate version. */
function boundedAstFailureDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.length > 320 ? `${raw.slice(0, 320)}...` : raw;
  return `AST_PARSE_FAILED: ${detail}`;
}

function isPathInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(rootPath, absolutePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isSourcePathInsideIncludeRoots(
  sourcePath: string,
  includeRoots: readonly string[]
): boolean {
  return includeRoots.some(
    (includeRoot) => sourcePath === includeRoot || sourcePath.startsWith(`${includeRoot}/`)
  );
}

function assertApprovedSnapshotMatchesPreflight(
  snapshot: {
    readonly projectId: number;
    readonly snapshotUuid: string;
    readonly commandScope: string;
    readonly status: string;
    readonly rootHash: string | null;
    readonly scopeHash: string | null;
    readonly policyHash: string | null;
    readonly inventoryHash: string | null;
    readonly baselineHash: string | null;
    readonly planHash: string | null;
    readonly repositoryHash?: string | null;
    readonly workspaceHash?: string | null;
    readonly headHash?: string | null;
    readonly branchHash?: string | null;
    readonly detachedHash?: string | null;
    readonly contentHash?: string | null;
    readonly identityDigest?: string | null;
    readonly addsCount: number;
    readonly updatesCount: number;
    readonly deletesCount: number;
    readonly eligibleCount: number;
    readonly trackedCount: number;
    readonly blockedFindings: Array<Record<string, unknown>>;
    readonly blockedFindingAllowlistHash: string;
    readonly suppressedBlockedFindings: readonly {
      readonly relativePath: string;
      readonly category: string;
      readonly matchedAllowlistEntry: { readonly relativePath: string; readonly category: string };
    }[];
  },
  preflight: {
    readonly rootHash: string;
    readonly scopeHash: string;
    readonly policyHash: string;
    readonly manifestPolicyHash?: string;
    readonly inventoryHash: string;
    readonly baselineHash: string;
    readonly planHash: string;
    readonly addsCount: number;
    readonly updatesCount: number;
    readonly deletesCount: number;
    readonly eligibleCount: number;
    readonly trackedCount: number;
    readonly blockedFindings: readonly unknown[];
    readonly blockedFindingAllowlistHash: string;
    readonly suppressedBlockedFindings: readonly {
      readonly relativePath: string;
      readonly category: string;
      readonly matchedAllowlistEntry: { readonly relativePath: string; readonly category: string };
    }[];
  },
  expectedProjectId: number,
  expectedCommandScope: string,
  expectedIdentity?: ResolvedProjectRagWorkspaceContext
): void {
  const mismatches: string[] = [];
  if (snapshot.projectId !== expectedProjectId) mismatches.push('project_id');
  if (snapshot.commandScope !== expectedCommandScope) mismatches.push('command_scope');
  const expectedPolicyHash = preflight.manifestPolicyHash ?? preflight.policyHash;
  for (const field of [
    'rootHash',
    'scopeHash',
    'inventoryHash',
    'baselineHash',
    'planHash',
    'addsCount',
    'updatesCount',
    'deletesCount',
    'eligibleCount',
    'trackedCount',
    'blockedFindingAllowlistHash',
  ] as const) {
    if (snapshot[field] !== preflight[field]) mismatches.push(field);
  }
  if (snapshot.policyHash !== expectedPolicyHash) mismatches.push('policyHash');
  if (expectedIdentity) {
    for (const field of [
      'repositoryHash',
      'workspaceHash',
      'contentHash',
      'identityDigest',
    ] as const) {
      const snapshotValue = snapshot[field];
      const expectedValue = expectedIdentity[field];
      if (
        snapshotValue !== undefined &&
        snapshotValue !== null &&
        expectedValue !== undefined &&
        snapshotValue !== expectedValue
      ) {
        mismatches.push(field);
      }
    }
  }
  if (snapshot.status !== 'REVIEW_REQUIRED') mismatches.push('status');
  if (snapshot.blockedFindings.length !== preflight.blockedFindings.length) {
    mismatches.push('blocked_findings');
  }
  if (
    hashSuppressedBlockedFindings(snapshot.suppressedBlockedFindings) !==
    hashSuppressedBlockedFindings(preflight.suppressedBlockedFindings)
  ) {
    mismatches.push('suppressed_blocked_findings');
  }
  if (mismatches.length > 0) {
    throw new Error(
      `approved_snapshot_binding_mismatch: ${mismatches.join(', ')}; no writes were started`
    );
  }
}

type ProjectRagSnapshotIdentityFields = Partial<
  Record<'repositoryHash' | 'workspaceHash' | 'contentHash' | 'identityDigest', string | null>
>;

function assertSnapshotIdentityMatchesWorkspace(
  snapshot: ProjectRagSnapshotIdentityFields,
  context: ResolvedProjectRagWorkspaceContext
): void {
  const mismatches: string[] = [];
  for (const field of [
    'repositoryHash',
    'workspaceHash',
    'contentHash',
    'identityDigest',
  ] as const) {
    const snapshotValue = snapshot[field];
    const expectedValue = context[field];
    if (
      snapshotValue !== undefined &&
      snapshotValue !== null &&
      expectedValue !== undefined &&
      snapshotValue !== expectedValue
    ) {
      mismatches.push(field);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `IDENTITY_MISMATCH: snapshot workspace binding differs (${mismatches.join(', ')})`
    );
  }
}

function deriveSingleFileIncludeRoot(sourcePath: string): string {
  const sourceDir = dirname(sourcePath);
  if (!sourceDir || sourceDir === '.') {
    throw new Error('ingest_project_file requires a file inside an explicit include root folder.');
  }

  const segments = sourceDir.split('/').filter(Boolean);
  const firstBlockedDotSegment = segments.findIndex(
    (segment) => segment.startsWith('.') && segment !== '.github'
  );
  const scopedSegments =
    firstBlockedDotSegment > 0 ? segments.slice(0, firstBlockedDotSegment) : segments;
  const includeRoot = scopedSegments.join('/');
  if (!includeRoot) {
    throw new Error('ingest_project_file requires a file inside an explicit include root folder.');
  }

  return includeRoot;
}

// ==========================================================================
// Internal raw execution — no snapshot gate, no orchestration.
// Called by ingestProjectRagPostgres after the gate passes.
// ==========================================================================

/**
 * Execute the write phase of Project RAG ingestion.
 *
 * This is the **raw** per-file version-safe ingest, extracted from the
 * snapshot-gate wrapper.  It assumes the gate has already:
 *  - Swept stale snapshots
 *  - Built and validated the preflight plan
 *  - Claimed the snapshot atomically
 *  - Re-validated the binding against the current filesystem state
 *
 * @param sql              – open Postgres connection
 * @param postgresId       – project_repositories.id
 * @param rootPath         – canonical project root
 * @param registeredIncludeRoots – resolved include roots
 * @param registeredIgnoreRules  – resolved ignore rules (can be undefined → empty)
 * @param freshCandidates  – candidate files from the POST-claim re-scan
 * @param freshStalePaths  – stale file paths from the POST-claim re-scan
 * @param args             – original ingest args (for force/maxFiles/concurrency)
 * @param embeddingConfig  – resolved embedding config
 * @param existing         – existing project record (nullable, for name)
 * @param slug             – project slug
 *
 * @returns ingest result WITHOUT snapshotGate (caller adds it)
 */
/**
 * Optional progress callback that is invoked during post-claim rescan to
 * renew the lease at regular intervals.
 */
type ProgressHeartbeatFn = (
  kind: 'rescan_file' | 'rescan_dir' | 'embedding_batch' | 'promotion',
  count: number
) => Promise<void>;

async function ingestProjectRagPostgresRaw(
  sql: Bun.SQL,
  postgresId: number,
  rootPath: string,
  freshCandidates: readonly ProjectRagPostgresIngestCandidate[],
  freshStalePaths: readonly string[],
  args: ProjectRagPostgresIngestArgs,
  embeddingConfig: ReturnType<typeof resolveProjectRagPostgresEmbeddingConfig>,
  claimedSnapshot: Pick<ProjectRagSnapshotFence, 'snapshotId' | 'snapshotUuid'>,
  deletionContext: ProjectRagSnapshotDeletionContext,
  heartbeat?: ProgressHeartbeatFn
): Promise<{
  readonly finalStatus: 'completed' | 'partial';
  readonly continuation?: ProjectRagPostgresIngestResult['continuation'];
  readonly stats: MutableProjectRagPostgresIngestStats;
}> {
  const jobFence = args.jobLease
    ? { jobId: args.jobLease.jobId, fenceToken: args.jobLease.fenceToken }
    : undefined;
  const snapshotFence: ProjectRagSnapshotFence = {
    projectId: postgresId,
    snapshotId: claimedSnapshot.snapshotId,
    snapshotUuid: claimedSnapshot.snapshotUuid,
  };
  const withJobFence = <T>(operation: (tx: ProjectRagWriteSql) => Promise<T>): Promise<T> =>
    withProjectRagJobFence(sql, jobFence, operation, snapshotFence);
  const stats: MutableProjectRagPostgresIngestStats = {
    filesScanned: 0,
    filesSelected: 0,
    filesIndexed: 0,
    filesBlocked: 0,
    filesDeleted: 0,
    chunksCreated: 0,
    embeddingsCreated: 0,
    errors: [],
  };

  const operationCount = freshStalePaths.length + freshCandidates.length;
  if (args.force && args.maxFiles !== undefined && operationCount > args.maxFiles) {
    throw new ProjectRagIngestionScopeTooLargeError(operationCount, args.maxFiles);
  }

  const operationLimit = args.maxFiles ?? Number.POSITIVE_INFINITY;
  const stalePathsToDelete = freshStalePaths.slice(0, operationLimit);
  const remainingLimit = Math.max(0, operationLimit - stalePathsToDelete.length);
  const filesToProcess = freshCandidates.slice(0, remainingLimit);
  const remainingStalePaths = freshStalePaths.length - stalePathsToDelete.length;
  const remainingCandidateFiles = freshCandidates.length - filesToProcess.length;
  const remainingOperations = remainingStalePaths + remainingCandidateFiles;
  const continuation =
    args.maxFiles !== undefined && remainingOperations > 0
      ? {
          maxFiles: args.maxFiles,
          totalOperations: operationCount,
          remainingOperations,
          remainingStalePaths,
          remainingCandidateFiles,
        }
      : undefined;
  stats.filesSelected = filesToProcess.length;

  // Helper: renew lease, abort on failure
  const renewOrAbort = async (context: string): Promise<void> => {
    if (args.signal?.aborted) {
      throw new Error(`Project RAG ingest was cancelled before ${context}`);
    }
    await args.jobLease?.assertOwnership();
    const renewed = await withJobFence((tx) =>
      renewProjectRagPostgresIngestSnapshotLeaseInTransaction(
        tx,
        postgresId,
        claimedSnapshot.snapshotId,
        claimedSnapshot.snapshotUuid
      )
    );
    if (!renewed) {
      throw new LeaseLostError(claimedSnapshot.snapshotId, `lease lost before ${context}`);
    }
  };

  // --- Stale cleanup (with lease renewal before each delete) ---
  for (const [staleIndex, stalePath] of stalePathsToDelete.entries()) {
    await renewOrAbort(`delete ${stalePath}`);
    stats.filesDeleted += await withJobFence((tx) =>
      deleteProjectRagPostgresFileInTransaction(tx, postgresId, stalePath, deletionContext)
    );
    if (heartbeat && staleIndex % 20 === 19) {
      await heartbeat('rescan_file', staleIndex + 1);
    }
  }

  const promotionSourcePaths: string[] = [];
  const limit = pLimit(Math.max(1, Math.min(args.concurrency ?? 2, 8)));

  await Promise.all(
    filesToProcess.map((candidate) =>
      limit(async () => {
        const { absolutePath, sourcePath } = candidate;
        if (candidate.mode === 'recover-pending') {
          promotionSourcePaths.push(sourcePath);
          return;
        }
        try {
          const fileStats = statSync(absolutePath);
          const recordBlockedFile = async (security: { reason: string; pattern?: string }) => {
            await withJobFence(async (tx) => {
              await upsertProjectRagPostgresFileInTransaction(tx, postgresId, {
                sourcePath,
                absolutePath,
                contentHash: await calculateBlockedFileFingerprint(
                  sourcePath,
                  fileStats.size,
                  Math.floor(fileStats.mtimeMs)
                ),
                fileModifiedAt: Math.floor(fileStats.mtimeMs),
                lang: detectLanguage(absolutePath),
                sizeBytes: fileStats.size,
                status: 'blocked',
                metadataQuality: 'minimal',
                metadata: {
                  backend: 'postgres',
                  blocked: true,
                  blockReason: security.reason,
                  blockPattern: security.pattern ?? security.reason,
                },
              });
              // Explicit blocked-file contract: no derived rows are ever
              // written through the candidate APIs. The immediate-ready
              // blocked version owns zero chunks, and the store's
              // immediate-ready supersession disables every enabled chunk of
              // any superseded version inside this same unit.
            });
            stats.filesBlocked += 1;
          };
          const pathSecurity = checkFileSecurity(absolutePath, undefined, rootPath);
          if (pathSecurity.blocked) {
            await recordBlockedFile(pathSecurity);
            return;
          }

          // Per-file drift: re-read content and compare hash against
          // the preflight candidate hash BEFORE any write.
          const content = readFileSync(absolutePath, 'utf8');
          const onDiskHash = await calculateProjectContentHash(content);
          if (onDiskHash !== candidate.contentHash) {
            throw new ContentHashMismatchError(sourcePath, candidate.contentHash, onDiskHash);
          }
          const contentHash = onDiskHash;

          // Renew lease before each write
          await renewOrAbort(`write ${sourcePath}`);

          const title = basename(absolutePath);
          // Redact PII before chunking so sensitive data never enters chunk
          // storage or embedding pipelines (SC-05).
          const sensitiveRedaction = redactSensitiveContent(content);
          const cleanContent = redactPII(sensitiveRedaction.content);
          const chunks = await chunkTextWithContextProfile(
            cleanContent,
            { title, sourcePath },
            {
              docType: 'project',
              chunkSize: SCRIPT_CONFIG.CHUNK_SIZE,
              chunkOverlap: SCRIPT_CONFIG.CHUNK_OVERLAP,
              sourcePath: absolutePath,
            }
          );
          const lang = detectLanguage(absolutePath);
          const skeleton =
            lang === 'typescript' || lang === 'javascript'
              ? generateSkeletonWithVersion(cleanContent, lang, sourcePath)
              : undefined;
          const chunkInputs = chunks.map((chunk, index) => ({
            chunkIndex: index,
            content: chunk.content,
            searchableText: chunk.searchableText,
            // Persist line ranges so search consumers can cite locations.
            // Previously dropped here, leaving start_line/end_line null for every chunk.
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            metadata: {
              backend: 'postgres',
              redactionCount: sensitiveRedaction.count,
              redactedPatterns: sensitiveRedaction.patternIds,
            },
          }));
          // Graph rows are written with the file and its pending candidate
          // version in the same short transaction unit below. A parseAst
          // failure marks that candidate failed (bounded evidence), skips the
          // graph replacement and promotion entirely, and yields a partial
          // ingest; a successful parse with zero symbols stays complete.
          const isCodeLang = lang === 'typescript' || lang === 'javascript';
          let astFailureDetail: string | null = null;

          await withJobFence(async (tx) => {
            const result = await upsertProjectRagPostgresFileWithChunksInTransaction(
              tx,
              postgresId,
              {
                sourcePath,
                absolutePath,
                contentHash,
                fileModifiedAt: Math.floor(fileStats.mtimeMs),
                lang,
                sizeBytes: fileStats.size,
                status: 'indexed',
                metadataQuality: 'minimal',
                skeletonText: skeleton?.skeletonText ?? undefined,
                outlineVersion: skeleton?.outlineVersion,
                metadata: {
                  backend: 'postgres',
                  redactionCount: sensitiveRedaction.count,
                  redactedPatterns: sensitiveRedaction.patternIds,
                },
              },
              chunkInputs,
              'pending'
            );
            if (!result.fileId || !result.versionId) {
              throw new Error(`Project RAG file upsert returned no version id: ${sourcePath}`);
            }

            if (isCodeLang) {
              let parsedSymbols: ParsedSymbol[] = [];
              let parsedEdges: ParsedEdge[] = [];
              try {
                const parsed = parseAst(sourcePath, cleanContent);
                parsedSymbols = parsed.symbols;
                parsedEdges = parsed.edges;
              } catch (astErr) {
                astFailureDetail = boundedAstFailureDetail(astErr);
                // Retain the candidate with its failure evidence in this same
                // committed unit. It can never be promoted: repair only scans
                // 'pending' versions, and this one is now 'failed'.
                await failProjectRagPostgresCandidateVersionInTransaction(
                  tx,
                  postgresId,
                  result.fileId,
                  result.versionId,
                  astFailureDetail
                );
                process.stderr.write(
                  `[ingest] symbol_extraction_failed: ${sourcePath}: ${astFailureDetail}\n`
                );
              }
              if (astFailureDetail === null) {
                await replaceProjectRagPostgresFileSymbolsInTransaction(
                  tx,
                  postgresId,
                  result.fileId,
                  parsedSymbols.map((sym) => ({
                    name: sym.name,
                    symbolType: sym.symbolType,
                    exportType: sym.exportType,
                    signature: sym.signature,
                    startLine: sym.startLine,
                    endLine: sym.endLine,
                    metadata: { source: 'project-rag-postgres-ingest' },
                  })),
                  result.versionId
                );

                const callEdges = parsedEdges.filter((edge) => edge.relationType === 'CALLS');
                const importEdges = parsedEdges.filter((edge) => edge.relationType === 'IMPORTS');
                await replaceProjectRagPostgresFileEdgesInTransaction(
                  tx,
                  postgresId,
                  result.fileId,
                  [
                    ...callEdges.map((edge) => ({
                      relationType: 'CALLS' as const,
                      targetRef: edge.targetId,
                      sourceRef: edge.targetId,
                      confidence: 0.7,
                      extractionMethod: 'ast-parser-direct',
                      metadata: { source: 'project-rag-postgres-ingest' },
                    })),
                    ...importEdges.map((edge) => ({
                      relationType: 'IMPORTS' as const,
                      targetRef: edge.targetId,
                      sourceRef: edge.targetId,
                      confidence: 0.6,
                      extractionMethod: 'ast-parser-direct',
                      metadata: { source: 'project-rag-postgres-ingest' },
                    })),
                  ],
                  result.versionId
                );
              }
            }
          });
          if (astFailureDetail !== null) {
            // Failed candidates never reach promotion, so the run is partial
            // and the claimed snapshot will be failed, not consumed.
            stats.errors.push({ file: sourcePath, error: astFailureDetail });
          } else {
            stats.filesIndexed += 1;
            stats.chunksCreated += chunkInputs.length;
            promotionSourcePaths.push(sourcePath);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          // Content hash drift and lease loss are fatal: propagate to
          // outer catch so the snapshot is failed properly, not silently
          // swallowed as a per-file error.
          // Use typed error instanceof checks — never match on message prefix.
          if (
            error instanceof ContentHashMismatchError ||
            error instanceof LeaseLostError ||
            error instanceof ProjectRagSnapshotLeaseLostError
          ) {
            throw error;
          }
          stats.errors.push({
            file: sourcePath,
            error: errMsg,
          });
        }
      })
    )
  );

  const pendingPromotionSourcePaths = [...new Set(promotionSourcePaths)].sort();

  // Resolve edge target file/symbol ids after all per-file edge writes so
  // CALLS/IMPORTS can match definitions written earlier in this batch.
  if (pendingPromotionSourcePaths.length > 0) {
    try {
      await withJobFence((tx) => resolveProjectRagPostgresEdgeTargetsInTransaction(tx, postgresId));
    } catch (resolveErr) {
      process.stderr.write(
        `[ingest] edge_target_resolve_failed: ${
          resolveErr instanceof Error ? resolveErr.message : String(resolveErr)
        }\n`
      );
      throw resolveErr;
    }
  }

  if (pendingPromotionSourcePaths.length > 0) {
    while (true) {
      const candidates = await listProjectRagPostgresChunkEmbeddingCandidates(sql, postgresId, {
        embeddingModel: embeddingConfig.model,
        embeddingProfileHash: embeddingConfig.profileHash,
        sourcePaths: pendingPromotionSourcePaths,
        limit: 1000,
      });
      if (candidates.length === 0) {
        break;
      }

      const embeddingTexts = candidates.map((candidate) => candidate.text);
      // Renew lease before embedding fetch (long provider call)
      await renewOrAbort(`embedding fetch for ${embeddingTexts.length} chunks`);
      if (heartbeat) {
        await heartbeat('embedding_batch', embeddingTexts.length);
      }

      const embeddings = await fetchProjectRagPostgresEmbeddings(
        embeddingConfig,
        embeddingTexts,
        args.signal
      );
      // Renew lease immediately after each embedding fetch (long HTTP call may
      // have consumed significant wall-clock time).
      await renewOrAbort(`after embedding fetch for ${embeddingTexts.length} chunks`);
      for (const [index, candidate] of candidates.entries()) {
        await withJobFence((tx) =>
          upsertProjectRagPostgresChunkEmbedding1024InTransaction(tx, postgresId, {
            ...candidate,
            embedding: embeddings[index] ?? [],
            embeddingModel: embeddingConfig.model,
            embeddingProvider: embeddingConfig.provider,
            dimensions: embeddingConfig.dimensions,
            embeddingProfileHash: embeddingConfig.profileHash,
          })
        );
        // Periodic lease renewal within large batches (every 200 upserts)
        if (index > 0 && index % 200 === 0) {
          await renewOrAbort(`embedding upsert batch at ${index}/${candidates.length}`);
        }
      }
      stats.embeddingsCreated += embeddings.length;
    }
  }

  // Promote only after validating the expected 1024D provider, dimensions,
  // and source hash. A same-model but incompatible embedding must leave the
  // pending version intact rather than becoming searchable as the active one.
  if (pendingPromotionSourcePaths.length > 0) {
    // Renew lease before promotion (not a DB write itself, but long-running)
    await renewOrAbort(`promotion for ${pendingPromotionSourcePaths.length} files`);
    if (heartbeat) {
      await heartbeat('promotion', pendingPromotionSourcePaths.length);
    }

    const repairedPromotions = await withJobFence((tx) =>
      repairProjectRagPostgresFileVersionsInTransaction(
        tx,
        postgresId,
        embeddingConfig.model,
        embeddingConfig.provider,
        embeddingConfig.dimensions,
        false,
        pendingPromotionSourcePaths
      )
    );

    if (repairedPromotions < pendingPromotionSourcePaths.length) {
      stats.errors.push({
        file: pendingPromotionSourcePaths.join(', '),
        error:
          'Pending version failed embedding integrity checks and remains pending for safe recovery.',
      });
    } else if (repairedPromotions > 0) {
      process.stderr.write(`[ingest] version promotion: ${repairedPromotions} verified\n`);
    }
  }

  return {
    finalStatus: stats.errors.length > 0 || continuation ? 'partial' : 'completed',
    continuation,
    stats,
  };
}

// ==========================================================================
// Public API — validates inputs, runs the snapshot gate, then delegates
// to the raw execution.
// ==========================================================================

export async function ingestProjectRagPostgres(
  args: ProjectRagPostgresIngestArgs
): Promise<ProjectRagPostgresIngestResult> {
  if (args.signal?.aborted) {
    throw new Error('Project RAG ingest was cancelled before processing started');
  }
  const rootPath = realpathSync.native(resolve(args.rootPath));
  normalizeProjectRootPath(rootPath);

  const rootManifest = await readRootManifest(rootPath);
  if (rootManifest.present && !rootManifest.ok) {
    throw new Error(`ROOT_MANIFEST_INVALID: ${rootManifest.errors.join('; ')}`);
  }

  if (args.maxFiles !== undefined) {
    if (!Number.isInteger(args.maxFiles) || args.maxFiles <= 0) {
      throw new Error(
        `Invalid maxFiles value: ${args.maxFiles}. maxFiles must be a positive integer.`
      );
    }
  }

  if (
    args.approvedSnapshotUuid !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      args.approvedSnapshotUuid
    )
  ) {
    throw new Error('Invalid approvedSnapshotUuid: expected a UUID');
  }

  const resolvedTargetFilePath = args.filePath ? resolve(rootPath, args.filePath) : undefined;
  if (
    resolvedTargetFilePath &&
    !isPathInsideRoot(
      rootPath,
      existsSync(resolvedTargetFilePath)
        ? realpathSync.native(resolvedTargetFilePath)
        : resolvedTargetFilePath
    )
  ) {
    throw new Error(`File path escapes project root: ${args.filePath}`);
  }
  const targetFilePath =
    resolvedTargetFilePath && existsSync(resolvedTargetFilePath)
      ? realpathSync.native(resolvedTargetFilePath)
      : resolvedTargetFilePath;
  const targetSourcePath = targetFilePath ? sourcePathFor(rootPath, targetFilePath) : undefined;

  const config = resolveProjectRagPostgresWriteConfig();
  const embeddingConfig = resolveProjectRagPostgresEmbeddingConfig();
  const sql = createProjectRagPostgresSql(config);
  const jobFence = args.jobLease
    ? { jobId: args.jobLease.jobId, fenceToken: args.jobLease.fenceToken }
    : undefined;
  let claimedSnapshotFence: ProjectRagSnapshotFence | undefined;
  const withJobFence = <T>(operation: (tx: ProjectRagWriteSql) => Promise<T>): Promise<T> =>
    withProjectRagJobFence(sql, jobFence, operation, claimedSnapshotFence);

  try {
    await args.jobLease?.assertOwnership();
    // === Phase 1: Schema checks & project resolution ===
    // Both migration-002 (versioned chunks) and migration-003 (snapshot gate)
    // must be applied before any preflight, registry, or ingestion write.
    await assertProjectRagPostgresSchemaReady(sql);
    await assertProjectRagPostgresIndexBuildSchemaReady(sql);
    await assertProjectRagPostgresSyncRunBindingSchemaReady(sql);
    await assertProjectRagPostgresSnapshotSchemaReady(sql);
    await assertProjectRagPostgresAllowlistSchemaReady(sql);
    // Identity follows the registered root path, never a basename guess: an
    // explicit slug still wins, but an implicit ingest must reuse the project
    // registered at this root instead of forking a basename-derived duplicate.
    const existingByRoot = await findProjectRagPostgresProjectByRootPath(sql, rootPath);
    if (existingByRoot && args.projectSlug && args.projectSlug !== existingByRoot.slug) {
      throw new Error(
        `PROJECT_IDENTITY_MISMATCH: Root "${rootPath}" is registered as "${existingByRoot.slug}"; ` +
          `requested projectSlug "${args.projectSlug}" does not match the registered identity.`
      );
    }
    const slug = args.projectSlug ?? existingByRoot?.slug ?? slugifyProjectName(basename(rootPath));
    const existing = await findProjectRagPostgresProject(sql, slug);
    // Root identity enforcement — the repository upsert re-roots on slug
    // conflict, so an ingest pointing an explicit slug at a different root
    // must fail loudly instead of silently moving the registration.
    if (existing) {
      const existingRoot = existing.normalizedRootPath || existing.rootPath;
      if (existingRoot !== rootPath) {
        throw new Error(
          `PROJECT_ROOT_MISMATCH: Project "${slug}" is already registered at "${existingRoot}". ` +
            `Requested root "${rootPath}" differs. Ingesting an existing project under a ` +
            `different root path is not allowed.`
        );
      }
    }
    const requestedIncludeRoots =
      args.includeRoots && args.includeRoots.length > 0 ? [...args.includeRoots] : undefined;
    const replaceScope = args.scopeOperation === 'replace';
    const scope = resolveProjectRagScope({
      existingIncludeRoots: existing?.includeRoots,
      existingIgnoreRules: existing?.ignoreRules,
      requestedIncludeRoots:
        existing && targetSourcePath && !replaceScope ? undefined : requestedIncludeRoots,
      requestedIgnoreRules:
        existing && targetSourcePath && !replaceScope ? undefined : args.ignoreRules,
      manifest: rootManifest.present && rootManifest.ok ? rootManifest.manifest : undefined,
      scopeOperation: args.scopeOperation,
    });
    const includeRootsValidation =
      existing && !replaceScope && targetSourcePath
        ? { valid: true as const, includeRoots: [...scope.includeRoots] }
        : validateProjectIncludeRoots(rootPath, scope.includeRoots);
    if (!includeRootsValidation.valid) {
      const suggestionText =
        includeRootsValidation.suggestions.length > 0
          ? ` Suggested folders: ${includeRootsValidation.suggestions.join(', ')}`
          : '';
      throw new Error(`${includeRootsValidation.error}.${suggestionText}`);
    }
    const registeredIncludeRoots = includeRootsValidation.includeRoots;
    const registeredIgnoreRules = scope.ignoreRules;

    if (
      targetSourcePath &&
      existing &&
      !isSourcePathInsideIncludeRoots(targetSourcePath, registeredIncludeRoots)
    ) {
      throw new Error(
        `File path is outside registered Project RAG includeRoots: ${targetSourcePath}`
      );
    }

    // === Phase 2: Preflight (scan + tracked states + plan) ===

    const workspaceContext = await resolveProjectRagWorkspaceContext(rootPath, undefined, {
      includeRoots: registeredIncludeRoots,
      ignoreRules: registeredIgnoreRules,
    });

    // Get the existing project's allowlist (may be empty for new projects)
    const registeredAllowlist = existing?.blockedFindingAllowlist ?? [];

    const trackedStates = existing?.id
      ? await listProjectRagPostgresFileStates(sql, existing.id)
      : [];
    const preflight = await buildPreflightPlan(
      rootPath,
      registeredIncludeRoots,
      registeredIgnoreRules,
      trackedStates,
      targetSourcePath ?? undefined,
      args.force,
      undefined,
      registeredAllowlist,
      undefined,
      { manifest: rootManifest }
    );

    // Validate single-file target (must exist in scan)
    if (targetSourcePath && preflight.candidateFiles.length === 0) {
      if (targetFilePath && !existsSync(targetFilePath)) {
        throw new Error(
          `Target file not found: ${targetSourcePath}. ` +
            `File does not exist at the resolved path. No existing data was deleted.`
        );
      }
      throw new Error(
        `Target file excluded: ${targetSourcePath} is ignored by project rules, ` +
          `not a recognized source file, or exceeds the maximum file size. ` +
          `No existing indexed data was deleted.`
      );
    }

    // === Phase 3: Snapshot gate — prepare ===
    // Upsert the project repository record (SPEC-005 metadata) needed for
    // the snapshot FK.  This is NOT a project_files/chunks index write.
    const postgresId = await withJobFence((tx) =>
      upsertProjectRagPostgresRepositoryInTransaction(tx, {
        name: existing?.name ?? basename(rootPath),
        slug,
        rootPath,
        normalizedRootPath: rootPath,
        status: 'active',
        syncMode: 'full',
        includeRoots: registeredIncludeRoots,
        ignoreRules: registeredIgnoreRules,
        rootManifestHash:
          rootManifest.present && rootManifest.ok ? rootManifest.digest : EMPTY_ROOT_MANIFEST_HASH,
        policyHash: preflight.manifestPolicyHash ?? preflight.policyHash,
        metadata: { backend: 'postgres', registeredBy: 'project-rag-postgres-ingest' },
      })
    );
    const persistedContext = await withJobFence((tx) =>
      upsertProjectRagWorkspaceContextInTransaction(tx, workspaceContext)
    );
    if (workspaceContext.workspaceRoot === rootPath) {
      await withJobFence((tx) =>
        upsertProjectRagWorkspaceAliasInTransaction(tx, {
          workspaceId: persistedContext.workspaceId,
          alias: slug,
          legacyProjectId: postgresId,
        })
      );
    }
    // Sweep only this project's stale snapshots before prepare/claim.
    await withJobFence((tx) =>
      sweepStaleProjectRagPostgresIngestSnapshotsInTransaction(tx, postgresId)
    );
    const renewClaimedSnapshot = (snapshotId: number, snapshotUuid: string) =>
      withJobFence((tx) =>
        renewProjectRagPostgresIngestSnapshotLeaseInTransaction(
          tx,
          postgresId,
          snapshotId,
          snapshotUuid
        )
      );
    const failClaimedSnapshot = (
      snapshotId: number,
      failureCode: SnapshotFailureCode,
      failureDetail: string
    ) => {
      const terminalSnapshotFence = claimedSnapshotFence
        ? { ...claimedSnapshotFence, terminalTransition: 'FAILED' as const }
        : undefined;
      return withProjectRagJobFence(
        sql,
        jobFence,
        (tx) =>
          failProjectRagPostgresIngestSnapshotInTransaction(
            tx,
            postgresId,
            snapshotId,
            failureCode,
            failureDetail
          ),
        terminalSnapshotFence
      );
    };

    const commandScope = targetSourcePath ? 'file' : 'full';
    const approvedSnapshotUuid = args.approvedSnapshotUuid;
    const reviewApproved = approvedSnapshotUuid !== undefined;
    const prepareResult = reviewApproved
      ? await (async () => {
          await assertProjectRagPostgresSnapshotReviewSchemaReady(sql);
          const approvedSnapshot = await findProjectRagPostgresIngestSnapshotByUuid(
            sql,
            postgresId,
            approvedSnapshotUuid
          );
          if (!approvedSnapshot) {
            throw new Error(
              `Approved snapshot not found for project ${postgresId}: ${approvedSnapshotUuid}`
            );
          }
          const review = await findProjectRagPostgresSnapshotReview(
            sql,
            postgresId,
            approvedSnapshotUuid
          );
          if (!review) {
            throw new Error(
              `Approved snapshot ${approvedSnapshotUuid} has no current qualified review`
            );
          }
          assertApprovedSnapshotMatchesPreflight(
            approvedSnapshot,
            {
              ...preflight,
              blockedFindings: preflight.blockedFindings,
            },
            postgresId,
            commandScope,
            workspaceContext
          );
          return {
            snapshot: approvedSnapshot,
            thresholdResult: {
              requiresReview: true,
              reason: `qualified_review:${review.reviewerId}:${review.evidenceId}`,
            },
          };
        })()
      : await withJobFence((tx) =>
          prepareSnapshotInTransaction(tx, {
            projectId: postgresId,
            commandScope,
            rootHash: preflight.rootHash,
            scopeHash: preflight.scopeHash,
            policyHash: preflight.manifestPolicyHash ?? preflight.policyHash,
            inventoryHash: preflight.inventoryHash,
            baselineHash: preflight.baselineHash,
            planHash: preflight.planHash,
            identity: {
              repositoryHash: workspaceContext.repositoryHash,
              workspaceHash: workspaceContext.workspaceHash,
              headHash: workspaceContext.headHash,
              branchHash: workspaceContext.branchHash,
              detachedHash: workspaceContext.detachedHash,
              contentHash: workspaceContext.contentHash,
              identityDigest: workspaceContext.identityDigest,
              headOid: workspaceContext.headOid,
              branchName: workspaceContext.branchName,
              isDetached: workspaceContext.isDetached,
              isUnborn: workspaceContext.isUnborn,
            },
            contentHash: workspaceContext.contentHash,
            rootManifestHash:
              rootManifest.present && rootManifest.ok
                ? rootManifest.digest
                : EMPTY_ROOT_MANIFEST_HASH,
            completenessStatus: preflight.completeness?.status,
            completenessEvidenceHash: preflight.completeness?.evidenceHash,
            deletionAllowed: preflight.deletionEligibility?.decision.allowed,
            addsCount: preflight.addsCount,
            updatesCount: preflight.updatesCount,
            deletesCount: preflight.deletesCount,
            eligibleCount: preflight.eligibleCount,
            trackedCount: preflight.trackedCount,
            blockedFindings: preflight.blockedFindings as ReadonlyArray<Record<string, unknown>>,
            blockedFindingAllowlistHash: preflight.blockedFindingAllowlistHash,
            suppressedBlockedFindings: preflight.suppressedBlockedFindings,
          })
        );

    const buildGateResult = (status: string, reason: string) => ({
      snapshotUuid: prepareResult.snapshot.snapshotUuid,
      status,
      thresholdResult: reason,
      preflightSummary: preflight.summary,
    });

    // Gate refusal: REVIEW_REQUIRED or FAILED — no writes
    if (prepareResult.snapshot.status !== 'PREPARED' && !reviewApproved) {
      return {
        projectId: slug,
        slug,
        postgresId,
        finalStatus: 'partial' as const,
        stats: {
          filesScanned: preflight.candidateFiles.length,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: buildGateResult(
          prepareResult.snapshot.status,
          prepareResult.thresholdResult.reason
        ),
      };
    }

    // === Phase 4: Sweep stale again, then claim snapshot atomically ===
    await withJobFence((tx) =>
      sweepStaleProjectRagPostgresIngestSnapshotsInTransaction(tx, postgresId)
    );
    const claimed = reviewApproved
      ? await withJobFence((tx) =>
          claimProjectRagPostgresIngestSnapshotInTransaction(
            tx,
            postgresId,
            prepareResult.snapshot.id,
            true
          )
        )
      : await withJobFence((tx) =>
          claimProjectRagPostgresIngestSnapshotInTransaction(
            tx,
            postgresId,
            prepareResult.snapshot.id
          )
        );
    if (!claimed) {
      // Claim failed (race / expiry / concurrent consumer) — refuse
      return {
        projectId: slug,
        slug,
        postgresId,
        finalStatus: 'partial' as const,
        stats: {
          filesScanned: preflight.candidateFiles.length,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: buildGateResult('FAILED', 'claim_failed: snapshot could not be claimed'),
      };
    }
    claimedSnapshotFence = {
      projectId: postgresId,
      snapshotId: claimed.id,
      snapshotUuid: claimed.snapshotUuid,
    };
    const claimedJobLease = args.jobLease;
    if (claimedJobLease) {
      await withJobFence((tx) =>
        bindProjectRagJobIdentityInTransaction(tx, {
          jobId: claimedJobLease.jobId,
          fenceToken: claimedJobLease.fenceToken,
          projectId: postgresId,
          snapshotUuid: claimed.snapshotUuid,
        })
      );
    }

    // === Phase 5: TOCTOU revalidation — re-scan, compare scope & evidence ===

    // Renew lease explicitly before the post-claim rescan (may be long).
    const renewed = await renewClaimedSnapshot(claimed.id, claimed.snapshotUuid);
    if (!renewed) {
      const detail = `lease lost before post-claim rescan`;
      await failClaimedSnapshot(claimed.id, 'PRECONDITION_FAILURE', detail);
      throw new LeaseLostError(claimed.id, detail);
    }

    // Build a rescan heartbeat that MUST fail the snapshot and throw
    // LeaseLostError if renew returns undefined.  This is passed to
    // buildPreflightPlan so the lease is kept alive during the
    // potentially long full-inventory scan.
    const rescanHeartbeat: ProgressCallback = async (_kind, _count) => {
      const ok = await renewClaimedSnapshot(claimed.id, claimed.snapshotUuid);
      if (!ok) {
        const detail = `lease lost during rescan (${_kind} ${_count})`;
        await failClaimedSnapshot(claimed.id, 'PRECONDITION_FAILURE', detail);
        throw new LeaseLostError(claimed.id, detail);
      }
    };

    // Reload project from DB after claim to get the current registered state
    // Helper: fail snapshot immediately on unexpected errors and rethrow.
    // Prevents the snapshot from being stuck in CONSUMING for 300s when a
    // rescan/revalidate call throws unexpectedly.
    const claimedSnapshotId = claimed.id;
    async function failClaimedOnError<T>(label: string, fn: () => Promise<T>): Promise<T> {
      try {
        return await fn();
      } catch (err) {
        const detail = `post-claim error in ${label}: ${err instanceof Error ? err.message : String(err)}`;
        const sanitized = detail.length > 200 ? detail.slice(0, 200) : detail;
        // Classify where possible
        let code: SnapshotFailureCode = 'SYSTEM_ERROR';
        if (
          err instanceof LeaseLostError ||
          err instanceof ProjectRagSnapshotLeaseLostError ||
          err instanceof ContentHashMismatchError ||
          err instanceof SnapshotRescanMismatchError
        ) {
          code = 'PRECONDITION_FAILURE';
        }
        await failClaimedSnapshot(claimedSnapshotId, code, sanitized);
        throw err;
      }
    }

    const reloadedProject = await failClaimedOnError('findProjectRagPostgresProject', () =>
      findProjectRagPostgresProject(sql, slug)
    );
    const reloadedIncludeRoots = reloadedProject?.includeRoots.length
      ? reloadedProject.includeRoots
      : registeredIncludeRoots;
    const reloadedIgnoreRules = reloadedProject?.ignoreRules ?? registeredIgnoreRules;
    const reloadedAllowlist = reloadedProject?.blockedFindingAllowlist ?? registeredAllowlist;

    const rescanTracked = await failClaimedOnError('listProjectRagPostgresFileStates', () =>
      listProjectRagPostgresFileStates(sql, postgresId)
    );

    const rescanPreflight = await failClaimedOnError('buildPreflightPlan (rescan)', () =>
      buildPreflightPlan(
        rootPath,
        reloadedIncludeRoots,
        reloadedIgnoreRules,
        rescanTracked,
        targetSourcePath ?? undefined,
        args.force,
        rescanHeartbeat,
        reloadedAllowlist,
        undefined,
        { manifest: rootManifest }
      )
    );

    // Renew lease again after the rescan completes
    const renewedAfter = await renewClaimedSnapshot(claimed.id, claimed.snapshotUuid);
    if (!renewedAfter) {
      const detail = 'lease lost after post-claim rescan';
      await failClaimedSnapshot(claimed.id, 'PRECONDITION_FAILURE', detail);
      throw new LeaseLostError(claimed.id, detail);
    }

    // If rescan reveals blocked findings that the prepare step missed,
    // fail immediately — no writes.
    if (rescanPreflight.blockedFindings.length > 0) {
      const blockedDetail = `blocked_findings_on_rescan: ${rescanPreflight.summary.blockedFindingCategories}`;
      await failClaimedSnapshot(claimed.id, 'BLOCKED_ROOT_FINDINGS', blockedDetail);
      return {
        projectId: slug,
        slug,
        postgresId,
        finalStatus: 'partial' as const,
        stats: {
          filesScanned: rescanPreflight.candidateFiles.length,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: buildGateResult('FAILED', blockedDetail),
      };
    }

    // Re-run the deletion evidence policy on rescan. Additions and updates are
    // always eligible; only a deletion plan without complete immutable
    // snapshot-bound evidence remains review-required.
    const rescanDeletionCount = commandScope === 'file' ? 0 : rescanPreflight.deletesCount;
    if (
      refreshRequiresReview({
        addsCount: rescanPreflight.addsCount,
        updatesCount: rescanPreflight.updatesCount,
        deletesCount: rescanDeletionCount,
        completenessStatus: rescanPreflight.completeness?.status,
        completenessEvidenceHash: rescanPreflight.completeness?.evidenceHash,
        deletionAllowed: rescanPreflight.deletionEligibility?.decision.allowed,
      })
    ) {
      const reviewDetail =
        'rescan_review_required: deletion plan lacks complete snapshot-bound evidence';
      await failClaimedSnapshot(claimed.id, 'RESCAN_MISMATCH', reviewDetail);
      return {
        projectId: slug,
        slug,
        postgresId,
        finalStatus: 'partial' as const,
        stats: {
          filesScanned: rescanPreflight.candidateFiles.length,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: buildGateResult('FAILED', reviewDetail),
      };
    }

    // Also validate that the rescan counts match the original plan counts
    // to catch drift that the hash comparison might not surface.
    const countChanges: string[] = [];
    if (rescanPreflight.addsCount !== preflight.addsCount) {
      countChanges.push(`adds:${preflight.addsCount}->${rescanPreflight.addsCount}`);
    }
    if (rescanPreflight.updatesCount !== preflight.updatesCount) {
      countChanges.push(`updates:${preflight.updatesCount}->${rescanPreflight.updatesCount}`);
    }
    if (rescanPreflight.deletesCount !== preflight.deletesCount) {
      countChanges.push(`deletes:${preflight.deletesCount}->${rescanPreflight.deletesCount}`);
    }
    if (rescanPreflight.eligibleCount !== preflight.eligibleCount) {
      countChanges.push(`eligible:${preflight.eligibleCount}->${rescanPreflight.eligibleCount}`);
    }
    if (countChanges.length > 0) {
      const countDetail = `rescan_count_drift: ${countChanges.join(', ')}`;
      await failClaimedSnapshot(claimed.id, 'RESCAN_MISMATCH', countDetail);
      return {
        projectId: slug,
        slug,
        postgresId,
        finalStatus: 'partial' as const,
        stats: {
          filesScanned: rescanPreflight.candidateFiles.length,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: buildGateResult('FAILED', countDetail),
      };
    }

    // Check allowlist hash/suppressed-set drift between prepare and rescan
    const allowlistDrift: string[] = [];
    if (rescanPreflight.blockedFindingAllowlistHash !== preflight.blockedFindingAllowlistHash) {
      allowlistDrift.push(
        `allowlist_hash:${preflight.blockedFindingAllowlistHash}->${rescanPreflight.blockedFindingAllowlistHash}`
      );
    }
    const preSuppressedHash = hashSuppressedBlockedFindings(preflight.suppressedBlockedFindings);
    const rescanSuppressedHash = hashSuppressedBlockedFindings(
      rescanPreflight.suppressedBlockedFindings
    );
    if (preSuppressedHash !== rescanSuppressedHash) {
      allowlistDrift.push(
        `suppressed_hash:${preSuppressedHash.slice(0, 12)}->${rescanSuppressedHash.slice(0, 12)}` +
          ` (count:${preflight.suppressedBlockedFindings.length}->${rescanPreflight.suppressedBlockedFindings.length})`
      );
    }
    if (allowlistDrift.length > 0) {
      const driftDetail = `rescan_allowlist_drift: ${allowlistDrift.join(', ')}`;
      await failClaimedSnapshot(claimed.id, 'RESCAN_MISMATCH', driftDetail);
      return {
        projectId: slug,
        slug,
        postgresId,
        finalStatus: 'partial' as const,
        stats: {
          filesScanned: rescanPreflight.candidateFiles.length,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: buildGateResult('FAILED', driftDetail),
      };
    }

    const reval = await failClaimedOnError('revalidateBaseline', () =>
      revalidateBaseline(
        sql,
        postgresId,
        claimed.id,
        rescanPreflight.inventoryHash,
        rescanPreflight.baselineHash,
        rescanPreflight.planHash,
        rescanPreflight.scopeHash,
        rescanPreflight.rootHash,
        rescanPreflight.manifestPolicyHash ?? rescanPreflight.policyHash,
        rescanPreflight.blockedFindingAllowlistHash
      )
    );

    if (!reval.matches) {
      const mismatchDetail = `rescan_mismatch: ${reval.mismatchedFields.join(', ')}`;
      await failClaimedSnapshot(claimed.id, 'RESCAN_MISMATCH', mismatchDetail);
      return {
        projectId: slug,
        slug,
        postgresId,
        finalStatus: 'partial' as const,
        stats: {
          filesScanned: rescanPreflight.candidateFiles.length,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: buildGateResult('FAILED', mismatchDetail),
      };
    }

    // Require snapshot exists and is CONSUMING after revalidation
    if (reval.snapshot?.status !== 'CONSUMING') {
      const statusDetail = reval.snapshot
        ? `snapshot status is ${reval.snapshot.status}, expected CONSUMING`
        : 'snapshot not found after revalidate';
      await failClaimedSnapshot(claimed.id, 'PRECONDITION_FAILURE', statusDetail);
      return {
        projectId: slug,
        slug,
        postgresId,
        finalStatus: 'partial' as const,
        stats: {
          filesScanned: rescanPreflight.candidateFiles.length,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: buildGateResult('FAILED', statusDetail),
      };
    }

    try {
      assertSnapshotIdentityMatchesWorkspace(reval.snapshot, workspaceContext);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await failClaimedSnapshot(claimed.id, 'PRECONDITION_FAILURE', detail);
      throw error;
    }

    let syncRunId: number | undefined;
    try {
      const syncRunInput: ProjectRagSyncRunInsertInput = args.jobLease
        ? {
            projectId: postgresId,
            mode: targetSourcePath ? 'file' : 'full',
            snapshotUuid: claimed.snapshotUuid,
            jobId: args.jobLease.jobId,
          }
        : {
            projectId: postgresId,
            mode: targetSourcePath ? 'file' : 'full',
            snapshotUuid: claimed.snapshotUuid,
            jobId: null,
          };
      syncRunId = await withJobFence((tx) =>
        insertProjectRagPostgresSyncRunInTransaction(tx, syncRunInput)
      );
    } catch (error) {
      const detail = `sync_run_start_failed: ${error instanceof Error ? error.message : String(error)}`;
      await abortProjectRagPostgresIngest(sql, {
        projectId: postgresId,
        snapshotId: claimed.id,
        snapshotUuid: claimed.snapshotUuid,
        failureCode: 'SYSTEM_ERROR',
        failureDetail: detail,
        execution: args.jobLease
          ? {
              kind: 'durable' as const,
              job: { jobId: args.jobLease.jobId, fenceToken: args.jobLease.fenceToken },
            }
          : { kind: 'foreground' as const },
      });
      throw error;
    }

    // Build heartbeat callback to renew lease during post-claim operations.
    // Must fail LOUDLY — never swallow renew exceptions or undefined returns.
    // If renew throws (non-unique-violation DB error), the error propagates
    // naturally through the callback.  If renew returns undefined, we throw
    // LeaseLostError immediately rather than waiting for the next explicit
    // renewOrAbort call inside raw execution.
    const heartbeat: ProgressHeartbeatFn = async (_kind, _count) => {
      await args.jobLease?.assertOwnership();
      const ok = await renewClaimedSnapshot(claimed.id, claimed.snapshotUuid);
      if (!ok) {
        throw new LeaseLostError(claimed.id, `lease lost during heartbeat (${_kind} ${_count})`);
      }
    };

    // === Phase 6: Execute raw writes with fresh data ===
    // Rebuild candidate list from fresh scan data (same logic as existing ingest)
    const rescanTrackedByPath = new Map(rescanTracked.map((s) => [s.sourcePath, s]));
    const rescanCandidates = rescanPreflight.candidateFiles;
    const rescanSourcePaths = new Set(rescanCandidates.map((f) => f.sourcePath));
    const deletionAllowed = rescanPreflight.deletionEligibility?.decision.allowed ?? false;
    const freshStalePaths =
      targetSourcePath || !deletionAllowed
        ? []
        : rescanTracked
            .map((s) => s.sourcePath)
            .filter((p) => !rescanSourcePaths.has(p))
            .sort();

    // Build fresh candidate list with mode (ingest / recover-pending).
    // Wrapped so a file vanishing between rescan preflight and this loop
    // fails the claimed snapshot instead of stranding it in CONSUMING.
    const freshCandidates: ProjectRagPostgresIngestCandidate[] = [];
    await failClaimedOnError('build fresh ingest candidates', async () => {
      for (const candidate of rescanCandidates) {
        const tracked = rescanTrackedByPath.get(candidate.sourcePath);
        const absolutePath = resolve(rootPath, candidate.sourcePath);
        const pathSecurity = checkFileSecurity(absolutePath, undefined, rootPath);
        if (pathSecurity.blocked) {
          // Preserve prior skip semantics: only add blocked file when its
          // safe fingerprint changed or there was no baseline.
          const fileStats = statSync(absolutePath);
          const blockedFingerprint = await calculateBlockedFileFingerprint(
            candidate.sourcePath,
            fileStats.size,
            Math.floor(fileStats.mtimeMs)
          );
          if (
            args.force ||
            !tracked ||
            tracked.status !== 'blocked' ||
            tracked.contentHash !== blockedFingerprint
          ) {
            freshCandidates.push({
              absolutePath,
              sourcePath: candidate.sourcePath,
              contentHash: candidate.contentHash,
              mode: 'ingest',
            });
          }
          continue;
        }
        const isPendingRecovery =
          !args.force &&
          tracked?.status === 'indexed' &&
          tracked.contentHash === candidate.contentHash &&
          tracked.latestVersionStatus === 'pending';
        if (
          args.force ||
          !tracked ||
          tracked.status !== 'indexed' ||
          tracked.latestVersionStatus !== 'ready' ||
          tracked.contentHash !== candidate.contentHash
        ) {
          freshCandidates.push({
            absolutePath,
            sourcePath: candidate.sourcePath,
            contentHash: candidate.contentHash,
            mode: isPendingRecovery ? 'recover-pending' : 'ingest',
          });
        }
      }
    });

    let rawResult: {
      finalStatus: 'completed' | 'partial';
      continuation?: ProjectRagPostgresIngestResult['continuation'];
      stats: MutableProjectRagPostgresIngestStats;
    };

    try {
      rawResult = await ingestProjectRagPostgresRaw(
        sql,
        postgresId,
        rootPath,
        freshCandidates,
        freshStalePaths,
        args,
        embeddingConfig,
        {
          snapshotId: claimed.id,
          snapshotUuid: claimed.snapshotUuid,
        },
        {
          snapshotId: claimed.id,
          snapshotUuid: claimed.snapshotUuid,
          completenessEvidenceHash: rescanPreflight.completeness?.evidenceHash ?? '',
        },
        heartbeat
      );
    } catch (err) {
      // Classify error and fail snapshot with the appropriate code.
      // Use typed error codes — never match on message prefix.
      let code: SnapshotFailureCode = 'SYSTEM_ERROR';
      const errDetail = err instanceof Error ? err.message : String(err);
      const sanitized = errDetail.length > 200 ? errDetail.slice(0, 200) : errDetail;

      if (err instanceof LeaseLostError || err instanceof ProjectRagSnapshotLeaseLostError) {
        code = 'PRECONDITION_FAILURE';
      } else if (
        err instanceof ContentHashMismatchError ||
        err instanceof SnapshotRescanMismatchError
      ) {
        code = 'RESCAN_MISMATCH';
      }

      await abortProjectRagPostgresIngest(sql, {
        projectId: postgresId,
        snapshotId: claimed.id,
        snapshotUuid: claimed.snapshotUuid,
        failureCode: code,
        failureDetail: sanitized,
        syncRunId,
        execution: args.jobLease
          ? {
              kind: 'durable' as const,
              job: { jobId: args.jobLease.jobId, fenceToken: args.jobLease.fenceToken },
            }
          : { kind: 'foreground' as const },
      });
      throw err;
    }

    // Defense in depth: re-read project config and verify it hasn't drifted
    // from what was used for the rescan.  This catches concurrent changes
    // to includeRoots/ignoreRules/allowlist that happened during raw writes.
    const finalProject = await findProjectRagPostgresProject(sql, slug);
    if (finalProject) {
      const finalIncludeRoots = finalProject.includeRoots;
      const finalIgnoreRules = finalProject.ignoreRules;
      const finalAllowlist = finalProject.blockedFindingAllowlist;
      let driftDetected = false;
      const driftFields: string[] = [];

      // Compare include roots (sorted)
      const rescanRootsSorted = [...reloadedIncludeRoots].sort();
      const finalRootsSorted = [...finalIncludeRoots].sort();
      if (
        rescanRootsSorted.length !== finalRootsSorted.length ||
        rescanRootsSorted.some((v, i) => v !== finalRootsSorted[i])
      ) {
        driftDetected = true;
        driftFields.push('include_roots');
      }

      // Compare ignore rules (sorted)
      const rescanRulesSorted = [...reloadedIgnoreRules].sort();
      const finalRulesSorted = [...finalIgnoreRules].sort();
      if (
        rescanRulesSorted.length !== finalRulesSorted.length ||
        rescanRulesSorted.some((v, i) => v !== finalRulesSorted[i])
      ) {
        driftDetected = true;
        driftFields.push('ignore_rules');
      }

      // Compare allowlist hash
      const finalAllowlistHash = hashBlockedFindingAllowlist(finalAllowlist);
      if (finalAllowlistHash !== rescanPreflight.blockedFindingAllowlistHash) {
        driftDetected = true;
        driftFields.push('blocked_finding_allowlist');
      }

      if (driftDetected) {
        const driftDetail = `config_drift_before_consume: ${driftFields.join(', ')}`;
        await abortProjectRagPostgresIngest(sql, {
          projectId: postgresId,
          snapshotId: claimed.id,
          snapshotUuid: claimed.snapshotUuid,
          failureCode: 'PRECONDITION_FAILURE',
          failureDetail: driftDetail,
          syncRunId,
          execution: args.jobLease
            ? {
                kind: 'durable' as const,
                job: { jobId: args.jobLease.jobId, fenceToken: args.jobLease.fenceToken },
              }
            : { kind: 'foreground' as const },
        });
        throw new Error(`precondition_failure: ${driftDetail}`);
      }
    }

    // Only a fully applied run may consume the claimed snapshot; a partial run
    // must fail it so the next ingest re-prepares from actual index state.
    const gateReason =
      rawResult.finalStatus === 'completed'
        ? 'delta_safe: write phase completed'
        : `partial_ingest_not_consumed: ${rawResult.stats.errors.length} file error(s)${
            rawResult.continuation
              ? `, ${rawResult.continuation.remainingOperations} operation(s) remaining`
              : ''
          }`;

    let publishedBuildId: number | undefined;
    let jobFinalized = false;
    if (rawResult.finalStatus === 'completed') {
      try {
        await args.jobLease?.assertOwnership();
        if (args.signal?.aborted) {
          throw new Error('Project RAG ingest was cancelled before publication');
        }
        const finalized = await completeProjectRagPostgresIngest(sql, {
          projectId: postgresId,
          revisionId: persistedContext.revisionId,
          snapshotId: claimed.id,
          snapshotUuid: claimed.snapshotUuid,
          syncRunId,
          publishBuild: true,
          signal: args.signal,
          execution: args.jobLease
            ? {
                kind: 'durable' as const,
                job: {
                  jobId: args.jobLease.jobId,
                  fenceToken: args.jobLease.fenceToken,
                  result: {
                    finalStatus: rawResult.finalStatus,
                    snapshotGate: { status: 'CONSUMED' },
                  },
                },
              }
            : { kind: 'foreground' as const },
        });
        publishedBuildId = finalized.publishedBuildId;
        jobFinalized = Boolean(args.jobLease);
      } catch (error) {
        const detail = `ingest_completion_failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        await abortProjectRagPostgresIngest(sql, {
          projectId: postgresId,
          snapshotId: claimed.id,
          snapshotUuid: claimed.snapshotUuid,
          failureCode: 'SYSTEM_ERROR',
          failureDetail: detail,
          syncRunId,
          execution: args.jobLease
            ? {
                kind: 'durable' as const,
                job: { jobId: args.jobLease.jobId, fenceToken: args.jobLease.fenceToken },
              }
            : { kind: 'foreground' as const },
        });
        throw error;
      }
    } else {
      await failProjectRagPostgresIngestPartial(sql, {
        projectId: postgresId,
        snapshotId: claimed.id,
        snapshotUuid: claimed.snapshotUuid,
        failureCode: 'SYSTEM_ERROR',
        failureDetail: gateReason,
        syncRunId,
        filesScanned: rescanPreflight.candidateFiles.length + freshStalePaths.length,
        filesDeleted: rawResult.stats.filesDeleted,
        chunksCreated: rawResult.stats.chunksCreated,
        errors: rawResult.stats.errors,
        execution: args.jobLease
          ? {
              kind: 'durable' as const,
              job: {
                jobId: args.jobLease.jobId,
                fenceToken: args.jobLease.fenceToken,
                error: gateReason,
              },
            }
          : { kind: 'foreground' as const },
      });
      jobFinalized = Boolean(args.jobLease);
    }

    const { stats } = rawResult;

    return {
      projectId: slug,
      slug,
      postgresId,
      finalStatus: rawResult.finalStatus,
      ...(publishedBuildId !== undefined ? { publishedBuildId } : {}),
      ...(jobFinalized ? { jobFinalized: true } : {}),
      continuation: rawResult.continuation,
      stats: {
        filesScanned: rescanPreflight.candidateFiles.length + freshStalePaths.length,
        filesSelected: stats.filesSelected,
        filesIndexed: stats.filesIndexed,
        filesBlocked: stats.filesBlocked,
        filesDeleted: stats.filesDeleted,
        chunksCreated: stats.chunksCreated,
        embeddingsCreated: stats.embeddingsCreated,
        errors: stats.errors,
      },
      snapshotGate: buildGateResult(
        rawResult.finalStatus === 'completed' ? 'CONSUMED' : 'FAILED',
        gateReason
      ),
    };
  } finally {
    // Pool is shared with MCP read handlers — do NOT close it per-operation.
    // Process exit handles cleanup for CLI use; MCP lifecycle handles its own shutdown.
  }
}

export async function ingestProjectRagPostgresFile(args: {
  readonly rootPath: string;
  readonly filePath: string;
  readonly force?: boolean;
}): Promise<ProjectRagPostgresIngestResult> {
  const rootPath = realpathSync.native(resolve(args.rootPath));
  normalizeProjectRootPath(rootPath);
  const resolvedPath = resolve(rootPath, args.filePath);
  const absolutePath = existsSync(resolvedPath) ? realpathSync.native(resolvedPath) : resolvedPath;
  if (!isPathInsideRoot(rootPath, absolutePath)) {
    throw new Error(`File path escapes project root: ${args.filePath}`);
  }
  const sourcePath = sourcePathFor(rootPath, absolutePath);
  const includeRoot = deriveSingleFileIncludeRoot(sourcePath);

  return await ingestProjectRagPostgres({
    rootPath,
    includeRoots: [includeRoot],
    filePath: absolutePath,
    force: args.force,
    maxFiles: 1,
  });
}
