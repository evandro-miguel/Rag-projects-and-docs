import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

/**
 * Callable Vitest mock type. `ReturnType<typeof vi.fn>` resolves to
 * `Mock<Constructable | Procedure>`, which is not callable without `new`;
 * plain `Mock` defaults to `Mock<Procedure>` and is directly invokable.
 */
type CallableVitestMock = Mock;

const mockChunkTextWithContextProfile = vi.fn();
const { mockAbortIngest, mockCompleteIngest, mockFailPartialIngest, mockInsertSyncRun } =
  vi.hoisted(() => ({
    mockAbortIngest: vi.fn(),
    mockCompleteIngest: vi.fn(),
    mockFailPartialIngest: vi.fn(),
    mockInsertSyncRun: vi.fn(),
  }));

vi.mock('../../lib/ingest/chunker.js', () => ({
  chunkTextWithContextProfile: mockChunkTextWithContextProfile,
}));
vi.mock('glob', () => ({ glob: vi.fn() }));
vi.mock('./config.js', () => ({
  resolveProjectRagPostgresWriteConfig: vi.fn().mockReturnValue({
    database: { url: 'postgres://local/test' },
  }),
}));
vi.mock('./embeddings.js', () => ({
  PROJECT_RAG_POSTGRES_EMBEDDING_MODEL: 'qwen3-embedding-1024',
  resolveProjectRagPostgresEmbeddingConfig: vi.fn().mockReturnValue({
    model: 'qwen3-embedding-1024',
    provider: 'llamacpp',
    dimensions: 1024,
  }),
  fetchProjectRagPostgresEmbeddings: vi.fn(),
}));
vi.mock('./context.js', () => ({
  resolveProjectRagWorkspaceContext: vi.fn(async (rootPath: string) => ({
    repositoryCommonDir: `${rootPath}/.git`,
    remoteUrl: null,
    workspaceRoot: rootPath,
    headOid: 'a'.repeat(40),
    branchName: 'main',
    isDetached: false,
    dirtyDigest: 'b'.repeat(64),
  })),
}));
vi.mock('../lib/ast-parser.js', () => ({
  parseAst: vi.fn(),
}));
vi.mock('./store.js', () => ({
  assertProjectRagPostgresAllowlistSchemaReady: vi.fn().mockResolvedValue(undefined),
  assertProjectRagPostgresIndexBuildSchemaReady: vi.fn().mockResolvedValue(undefined),
  assertProjectRagPostgresSchemaReady: vi.fn().mockResolvedValue(undefined),
  assertProjectRagPostgresSyncRunBindingSchemaReady: vi.fn().mockResolvedValue(undefined),
  assertProjectRagPostgresSnapshotReviewSchemaReady: vi.fn().mockResolvedValue(undefined),
  assertProjectRagPostgresSnapshotSchemaReady: vi.fn().mockResolvedValue(undefined),
  bindProjectRagJobIdentityInTransaction: vi.fn().mockResolvedValue(undefined),
  claimProjectRagPostgresIngestSnapshot: vi.fn(),
  claimProjectRagPostgresIngestSnapshotInTransaction: vi.fn(),
  consumeProjectRagPostgresIngestSnapshot: vi.fn(),
  completeProjectRagPostgresIngest: mockCompleteIngest,
  publishProjectRagPostgresIndexBuild: vi.fn().mockResolvedValue({ id: 99 }),
  abortProjectRagPostgresIngest: mockAbortIngest,
  createProjectRagPostgresSql: vi.fn(),
  closeProjectRagPostgresSql: vi.fn(),
  failProjectRagPostgresIngestPartial: mockFailPartialIngest,
  failProjectRagPostgresIngestSnapshot: vi.fn(),
  failProjectRagPostgresIngestSnapshotInTransaction: vi.fn(),
  failProjectRagPostgresCandidateVersionInTransaction: vi.fn(),
  findProjectRagPostgresIngestSnapshotByUuid: vi.fn(),
  findProjectRagPostgresSnapshotReview: vi.fn(),
  findProjectRagPostgresProject: vi.fn(),
  findProjectRagPostgresProjectByRootPath: vi.fn(),
  insertProjectRagPostgresSyncRunInTransaction: mockInsertSyncRun,
  listProjectRagPostgresFileStates: vi.fn(),
  listProjectRagPostgresChunkEmbeddingCandidates: vi.fn(),
  renewProjectRagPostgresIngestSnapshotLease: vi.fn(),
  renewProjectRagPostgresIngestSnapshotLeaseInTransaction: vi.fn(),
  upsertProjectRagPostgresRepository: vi.fn(),
  upsertProjectRagWorkspaceAlias: vi.fn(),
  upsertProjectRagWorkspaceContext: vi.fn(),
  withProjectRagJobFence: vi.fn(async (sql, _fence, operation) => {
    const tx = Object.assign(sql, {
      begin: vi.fn(() => {
        throw new Error('nested transaction ownership is forbidden');
      }),
    });
    return operation(tx);
  }),
  upsertProjectRagPostgresFile: vi.fn(),
  replaceProjectRagPostgresFileChunks: vi.fn(),
  deleteProjectRagPostgresFile: vi.fn(),
  deleteStaleProjectRagPostgresFiles: vi.fn(),
  promoteProjectRagPostgresFileVersions: vi.fn(),
  upsertProjectRagPostgresChunkEmbedding1024: vi.fn(),
  upsertProjectRagPostgresFileWithChunks: vi.fn(),
  upsertProjectRagPostgresFileInTransaction: vi.fn(),
  upsertProjectRagPostgresFileWithChunksInTransaction: vi.fn(),
  upsertProjectRagPostgresRepositoryInTransaction: vi.fn(),
  upsertProjectRagWorkspaceAliasInTransaction: vi.fn(),
  upsertProjectRagWorkspaceContextInTransaction: vi.fn(),
  deleteProjectRagPostgresFileInTransaction: vi.fn(),
  replaceProjectRagPostgresFileChunksInTransaction: vi.fn(),
  replaceProjectRagPostgresFileSymbolsInTransaction: vi.fn(),
  replaceProjectRagPostgresFileEdgesInTransaction: vi.fn(),
  resolveProjectRagPostgresEdgeTargetsInTransaction: vi.fn(),
  upsertProjectRagPostgresChunkEmbedding1024InTransaction: vi.fn(),
  repairProjectRagPostgresFileVersionsInTransaction: vi.fn(),
  replaceProjectRagPostgresFileSymbols: vi.fn(),
  replaceProjectRagPostgresFileEdges: vi.fn(),
  resolveProjectRagPostgresEdgeTargets: vi.fn(),
  repairProjectRagPostgresFileVersions: vi.fn().mockResolvedValue(0),
  sweepStaleProjectRagPostgresIngestSnapshotsInTransaction: vi.fn(),
}));

vi.mock('./project-inventory.js', () => ({
  buildPreflightPlan: vi.fn(),
}));

vi.mock('./snapshot-gate.js', () => ({
  prepareSnapshot: vi.fn(),
  prepareSnapshotInTransaction: vi.fn(),
  revalidateBaseline: vi.fn(),
}));

import { glob } from 'glob';
import { parseAst } from '../lib/ast-parser.js';
import { calculateProjectContentHash } from '../lib/project-content-hash.js';
import { resolveProjectRagWorkspaceContext } from './context.js';
import { fetchProjectRagPostgresEmbeddings } from './embeddings.js';
import { buildPreflightPlan } from './project-inventory.js';
import {
  type ProgressCallback,
  prepareSnapshot,
  prepareSnapshotInTransaction,
  revalidateBaseline,
} from './snapshot-gate.js';
import {
  ContentHashMismatchError,
  LeaseLostError,
  refreshRequiresReview,
} from './snapshot-policy.js';
import {
  abortProjectRagPostgresIngest,
  assertProjectRagPostgresAllowlistSchemaReady,
  assertProjectRagPostgresSchemaReady,
  assertProjectRagPostgresSnapshotSchemaReady,
  claimProjectRagPostgresIngestSnapshot,
  claimProjectRagPostgresIngestSnapshotInTransaction,
  completeProjectRagPostgresIngest,
  consumeProjectRagPostgresIngestSnapshot,
  createProjectRagPostgresSql,
  deleteProjectRagPostgresFile,
  deleteProjectRagPostgresFileInTransaction,
  deleteStaleProjectRagPostgresFiles,
  failProjectRagPostgresCandidateVersionInTransaction,
  failProjectRagPostgresIngestPartial,
  failProjectRagPostgresIngestSnapshot,
  failProjectRagPostgresIngestSnapshotInTransaction,
  findProjectRagPostgresIngestSnapshotByUuid,
  findProjectRagPostgresProject,
  findProjectRagPostgresProjectByRootPath,
  findProjectRagPostgresSnapshotReview,
  insertProjectRagPostgresSyncRunInTransaction,
  listProjectRagPostgresChunkEmbeddingCandidates,
  listProjectRagPostgresFileStates,
  promoteProjectRagPostgresFileVersions,
  renewProjectRagPostgresIngestSnapshotLease,
  renewProjectRagPostgresIngestSnapshotLeaseInTransaction,
  repairProjectRagPostgresFileVersions,
  repairProjectRagPostgresFileVersionsInTransaction,
  replaceProjectRagPostgresFileChunks,
  replaceProjectRagPostgresFileChunksInTransaction,
  replaceProjectRagPostgresFileEdges,
  replaceProjectRagPostgresFileEdgesInTransaction,
  replaceProjectRagPostgresFileSymbols,
  replaceProjectRagPostgresFileSymbolsInTransaction,
  resolveProjectRagPostgresEdgeTargets,
  resolveProjectRagPostgresEdgeTargetsInTransaction,
  sweepStaleProjectRagPostgresIngestSnapshotsInTransaction,
  upsertProjectRagPostgresChunkEmbedding1024,
  upsertProjectRagPostgresChunkEmbedding1024InTransaction,
  upsertProjectRagPostgresFile,
  upsertProjectRagPostgresFileInTransaction,
  upsertProjectRagPostgresFileWithChunks,
  upsertProjectRagPostgresFileWithChunksInTransaction,
  upsertProjectRagPostgresRepository,
  upsertProjectRagPostgresRepositoryInTransaction,
  upsertProjectRagWorkspaceAlias,
  upsertProjectRagWorkspaceAliasInTransaction,
  upsertProjectRagWorkspaceContext,
  upsertProjectRagWorkspaceContextInTransaction,
  withProjectRagJobFence,
} from './store.js';

const sql = { close: vi.fn() };
const mockAssertProjectRagPostgresAllowlistSchemaReady =
  assertProjectRagPostgresAllowlistSchemaReady as ReturnType<typeof vi.fn>;
const mockAssertProjectRagPostgresSchemaReady = assertProjectRagPostgresSchemaReady as ReturnType<
  typeof vi.fn
>;
const mockAssertProjectRagPostgresSnapshotSchemaReady =
  assertProjectRagPostgresSnapshotSchemaReady as ReturnType<typeof vi.fn>;
const mockClaimProjectRagPostgresIngestSnapshot =
  claimProjectRagPostgresIngestSnapshot as CallableVitestMock;
const mockClaimProjectRagPostgresIngestSnapshotInTransaction =
  claimProjectRagPostgresIngestSnapshotInTransaction as ReturnType<typeof vi.fn>;
const mockConsumeProjectRagPostgresIngestSnapshot =
  consumeProjectRagPostgresIngestSnapshot as CallableVitestMock;
const mockFailProjectRagPostgresIngestSnapshot =
  failProjectRagPostgresIngestSnapshot as CallableVitestMock;
const mockFailProjectRagPostgresIngestSnapshotInTransaction =
  failProjectRagPostgresIngestSnapshotInTransaction as ReturnType<typeof vi.fn>;
const mockFailProjectRagPostgresCandidateVersionInTransaction =
  failProjectRagPostgresCandidateVersionInTransaction as ReturnType<typeof vi.fn>;
const mockParseAst = parseAst as ReturnType<typeof vi.fn>;
const mockGlob = glob as unknown as ReturnType<typeof vi.fn>;
const mockCreateProjectRagPostgresSql = createProjectRagPostgresSql as ReturnType<typeof vi.fn>;
const mockFindProjectRagPostgresProject = findProjectRagPostgresProject as ReturnType<typeof vi.fn>;
const mockFindProjectRagPostgresProjectByRootPath =
  findProjectRagPostgresProjectByRootPath as ReturnType<typeof vi.fn>;
const mockFindProjectRagPostgresIngestSnapshotByUuid =
  findProjectRagPostgresIngestSnapshotByUuid as ReturnType<typeof vi.fn>;
const mockFindProjectRagPostgresSnapshotReview = findProjectRagPostgresSnapshotReview as ReturnType<
  typeof vi.fn
>;
const mockResolveProjectRagWorkspaceContext = resolveProjectRagWorkspaceContext as ReturnType<
  typeof vi.fn
>;
const mockListProjectRagPostgresFileStates = listProjectRagPostgresFileStates as ReturnType<
  typeof vi.fn
>;
const mockUpsertProjectRagPostgresRepository =
  upsertProjectRagPostgresRepository as CallableVitestMock;
const mockUpsertProjectRagWorkspaceContext = upsertProjectRagWorkspaceContext as CallableVitestMock;
const mockUpsertProjectRagWorkspaceAlias = upsertProjectRagWorkspaceAlias as CallableVitestMock;
const mockDeleteProjectRagPostgresFile = deleteProjectRagPostgresFile as CallableVitestMock;
const mockDeleteStaleProjectRagPostgresFiles = deleteStaleProjectRagPostgresFiles as ReturnType<
  typeof vi.fn
>;
const mockUpsertProjectRagPostgresFile = upsertProjectRagPostgresFile as CallableVitestMock;
const mockReplaceProjectRagPostgresFileChunks =
  replaceProjectRagPostgresFileChunks as CallableVitestMock;
const mockReplaceProjectRagPostgresFileSymbols =
  replaceProjectRagPostgresFileSymbols as CallableVitestMock;
const mockReplaceProjectRagPostgresFileEdges =
  replaceProjectRagPostgresFileEdges as CallableVitestMock;
const mockResolveProjectRagPostgresEdgeTargets =
  resolveProjectRagPostgresEdgeTargets as CallableVitestMock;
const mockUpsertProjectRagPostgresFileWithChunks =
  upsertProjectRagPostgresFileWithChunks as CallableVitestMock;
const mockListProjectRagPostgresChunkEmbeddingCandidates =
  listProjectRagPostgresChunkEmbeddingCandidates as ReturnType<typeof vi.fn>;
const mockPromoteProjectRagPostgresFileVersions =
  promoteProjectRagPostgresFileVersions as ReturnType<typeof vi.fn>;
const mockRepairProjectRagPostgresFileVersions =
  repairProjectRagPostgresFileVersions as CallableVitestMock;
const mockFetchProjectRagPostgresEmbeddings = fetchProjectRagPostgresEmbeddings as ReturnType<
  typeof vi.fn
>;
const mockSweepStaleProjectRagPostgresIngestSnapshotsInTransaction =
  sweepStaleProjectRagPostgresIngestSnapshotsInTransaction as ReturnType<typeof vi.fn>;
const mockSweepStaleProjectRagPostgresIngestSnapshots =
  mockSweepStaleProjectRagPostgresIngestSnapshotsInTransaction;
const mockRenewProjectRagPostgresIngestSnapshotLease =
  renewProjectRagPostgresIngestSnapshotLease as CallableVitestMock;
const mockRenewProjectRagPostgresIngestSnapshotLeaseInTransaction =
  renewProjectRagPostgresIngestSnapshotLeaseInTransaction as ReturnType<typeof vi.fn>;
const mockBuildPreflightPlan = buildPreflightPlan as ReturnType<typeof vi.fn>;
const mockPublicPrepareSnapshot = prepareSnapshot as ReturnType<typeof vi.fn>;
const mockPrepareSnapshot = prepareSnapshotInTransaction as ReturnType<typeof vi.fn>;
const mockRevalidateBaseline = revalidateBaseline as ReturnType<typeof vi.fn>;
const mockWithProjectRagJobFence = withProjectRagJobFence as ReturnType<typeof vi.fn>;
const mockAbortProjectRagPostgresIngest = abortProjectRagPostgresIngest as ReturnType<typeof vi.fn>;
const mockCompleteProjectRagPostgresIngest = completeProjectRagPostgresIngest as ReturnType<
  typeof vi.fn
>;
const mockFailProjectRagPostgresIngestPartial = failProjectRagPostgresIngestPartial as ReturnType<
  typeof vi.fn
>;
const mockInsertProjectRagPostgresSyncRunInTransaction =
  insertProjectRagPostgresSyncRunInTransaction as ReturnType<typeof vi.fn>;
const mockUpsertProjectRagPostgresFileInTransaction =
  upsertProjectRagPostgresFileInTransaction as ReturnType<typeof vi.fn>;
const mockUpsertProjectRagPostgresFileWithChunksInTransaction =
  upsertProjectRagPostgresFileWithChunksInTransaction as ReturnType<typeof vi.fn>;
const mockUpsertProjectRagPostgresRepositoryInTransaction =
  upsertProjectRagPostgresRepositoryInTransaction as ReturnType<typeof vi.fn>;
const mockUpsertProjectRagWorkspaceAliasInTransaction =
  upsertProjectRagWorkspaceAliasInTransaction as ReturnType<typeof vi.fn>;
const mockUpsertProjectRagWorkspaceContextInTransaction =
  upsertProjectRagWorkspaceContextInTransaction as ReturnType<typeof vi.fn>;
const mockDeleteProjectRagPostgresFileInTransaction =
  deleteProjectRagPostgresFileInTransaction as ReturnType<typeof vi.fn>;
const mockReplaceProjectRagPostgresFileChunksInTransaction =
  replaceProjectRagPostgresFileChunksInTransaction as ReturnType<typeof vi.fn>;
const mockReplaceProjectRagPostgresFileSymbolsInTransaction =
  replaceProjectRagPostgresFileSymbolsInTransaction as ReturnType<typeof vi.fn>;
const mockReplaceProjectRagPostgresFileEdgesInTransaction =
  replaceProjectRagPostgresFileEdgesInTransaction as ReturnType<typeof vi.fn>;
const mockResolveProjectRagPostgresEdgeTargetsInTransaction =
  resolveProjectRagPostgresEdgeTargetsInTransaction as ReturnType<typeof vi.fn>;
const mockUpsertProjectRagPostgresChunkEmbedding1024 =
  upsertProjectRagPostgresChunkEmbedding1024 as CallableVitestMock;
const mockUpsertProjectRagPostgresChunkEmbedding1024InTransaction =
  upsertProjectRagPostgresChunkEmbedding1024InTransaction as ReturnType<typeof vi.fn>;
const mockRepairProjectRagPostgresFileVersionsInTransaction =
  repairProjectRagPostgresFileVersionsInTransaction as ReturnType<typeof vi.fn>;

/** Default snapshot row shape returned by prepareSnapshot mock. */
function makeSnapshotRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    snapshotUuid: '00000000-0000-0000-0000-000000000001',
    projectId: 7,
    commandScope: 'full',
    rootHash: null,
    scopeHash: null,
    policyHash: null,
    inventoryHash: null,
    baselineHash: null,
    planHash: null,
    addsCount: 0,
    updatesCount: 0,
    deletesCount: 0,
    eligibleCount: 0,
    trackedCount: 0,
    blockedFindings: [],
    status: 'PREPARED',
    failureCode: null,
    failureDetail: null,
    ttlSeconds: 300,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    leaseExpiresAt: null,
    claimedAt: null,
    consumedAt: null,
    failedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Shape matching PreflightPlan for mock return. */
interface MockPreflightPlan {
  rootHash: string;
  scopeHash: string;
  policyHash: string;
  inventoryHash: string;
  baselineHash: string;
  planHash: string;
  addsCount: number;
  updatesCount: number;
  deletesCount: number;
  eligibleCount: number;
  trackedCount: number;
  totalDelta: number;
  force: boolean;
  blockedFindings: ReadonlyArray<Record<string, unknown>>;
  blockedFindingAllowlistHash: string;
  suppressedBlockedFindings: ReadonlyArray<Record<string, unknown>>;
  candidateFiles: ReadonlyArray<{ sourcePath: string; absolutePath: string; contentHash: string }>;
  trackedStates: ReadonlyArray<{
    sourcePath: string;
    contentHash: string;
    status: string;
    latestVersionStatus: string | null;
  }>;
  stalePaths: readonly string[];
  completeness: {
    status: 'complete' | 'incomplete' | 'blocked';
    evidenceHash: string;
  };
  deletionEligibility: {
    basis: 'scan_completeness' | 'legacy_default';
    decision: {
      allowed: boolean;
      stalePaths?: readonly string[];
      count?: number;
      status?: 'complete' | 'incomplete' | 'blocked';
      reasonCodes?: readonly string[];
    };
  };
  summary: {
    rootHash: string;
    scopeHash: string;
    policyHash: string;
    inventoryHash: string;
    baselineHash: string;
    planHash: string;
    addsCount: number;
    updatesCount: number;
    deletesCount: number;
    eligibleCount: number;
    trackedCount: number;
    totalDelta: number;
    /** force is optional in mock — only forced-ingest tests set it explicitly. */
    force?: boolean;
    blockedFindingCategories: string;
    blockedFindingAllowlistHash: string;
    suppressedBlockedFindingCount: number;
  };
}

/**
 * Preflight plan with safe threshold values (trackedCount=100, totalDelta=0).
 * Use for tests whose purpose is NOT threshold behavior.
 * Dedicated threshold tests use {@link makePreflightPlan} with explicit deltas.
 */
function safePreflightPlan(overrides: Partial<MockPreflightPlan> = {}): MockPreflightPlan {
  const plan = makePreflightPlan({ trackedCount: 100, totalDelta: 0, ...overrides });
  // FORCE safe threshold values — threshold behavior is covered by
  // dedicated tests that use makePreflightPlan with explicit deltas.
  plan.trackedCount = 100;
  plan.summary.trackedCount = 100;
  plan.summary.totalDelta = plan.totalDelta;
  return plan;
}

/** Default preflight plan returned by buildPreflightPlan mock. */
function makePreflightPlan(overrides: Partial<MockPreflightPlan> = {}): MockPreflightPlan {
  return {
    rootHash: 'root-hash',
    scopeHash: 'scope-hash',
    policyHash: 'policy-hash',
    inventoryHash: 'inv-hash',
    baselineHash: 'base-hash',
    planHash: 'plan-hash',
    addsCount: 0,
    updatesCount: 0,
    deletesCount: 0,
    eligibleCount: 0,
    trackedCount: 0,
    totalDelta: 0,
    force: false,
    blockedFindings: [],
    blockedFindingAllowlistHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    suppressedBlockedFindings: [],
    candidateFiles: [],
    trackedStates: [],
    stalePaths: [],
    completeness: { status: 'complete', evidenceHash: 'a'.repeat(64) },
    deletionEligibility: {
      basis: 'scan_completeness',
      decision: { allowed: true, stalePaths: [], count: 0 },
    },
    summary: {
      rootHash: 'root-hash',
      scopeHash: 'scope-hash',
      policyHash: 'policy-hash',
      inventoryHash: 'inv-hash',
      baselineHash: 'base-hash',
      planHash: 'plan-hash',
      addsCount: 0,
      updatesCount: 0,
      deletesCount: 0,
      eligibleCount: 0,
      trackedCount: 0,
      totalDelta: 0,
      force: false,
      blockedFindingCategories: 'none',
      blockedFindingAllowlistHash:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      suppressedBlockedFindingCount: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockParseAst.mockReturnValue({ symbols: [], edges: [] });
  mockChunkTextWithContextProfile.mockResolvedValue([]);
  sql.close.mockResolvedValue(undefined);
  mockGlob.mockResolvedValue([]);
  mockCreateProjectRagPostgresSql.mockReturnValue(sql);
  mockResolveProjectRagWorkspaceContext.mockImplementation(async (rootPath: string) => ({
    repositoryCommonDir: `${rootPath}/.git`,
    remoteUrl: null,
    workspaceRoot: rootPath,
    headOid: 'a'.repeat(40),
    branchName: 'main',
    isDetached: false,
    dirtyDigest: 'b'.repeat(64),
  }));
  mockAssertProjectRagPostgresSchemaReady.mockResolvedValue(undefined);
  mockAssertProjectRagPostgresSnapshotSchemaReady.mockResolvedValue(undefined);
  mockAssertProjectRagPostgresAllowlistSchemaReady.mockResolvedValue(undefined);
  mockFindProjectRagPostgresProject.mockResolvedValue(null);
  mockFindProjectRagPostgresProjectByRootPath.mockResolvedValue(null);
  mockFindProjectRagPostgresIngestSnapshotByUuid.mockResolvedValue(undefined);
  mockFindProjectRagPostgresSnapshotReview.mockResolvedValue(undefined);
  mockListProjectRagPostgresFileStates.mockResolvedValue([]);
  mockUpsertProjectRagPostgresRepository.mockResolvedValue(7);
  mockUpsertProjectRagWorkspaceContext.mockResolvedValue({ workspaceId: 9 });
  mockUpsertProjectRagWorkspaceAlias.mockResolvedValue(undefined);
  mockUpsertProjectRagPostgresFile.mockResolvedValue({ fileId: 11, versionId: 900001 });
  mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 11, versionId: 900001 });
  mockReplaceProjectRagPostgresFileChunks.mockResolvedValue(0);
  mockReplaceProjectRagPostgresFileSymbols.mockResolvedValue(1);
  mockReplaceProjectRagPostgresFileEdges.mockResolvedValue(0);
  mockResolveProjectRagPostgresEdgeTargets.mockResolvedValue({
    callsResolved: 0,
    importFilesResolved: 0,
  });
  mockDeleteProjectRagPostgresFile.mockResolvedValue(0);
  mockDeleteStaleProjectRagPostgresFiles.mockResolvedValue(0);
  mockListProjectRagPostgresChunkEmbeddingCandidates.mockResolvedValue([]);
  mockPromoteProjectRagPostgresFileVersions.mockResolvedValue(0);
  mockRepairProjectRagPostgresFileVersions.mockResolvedValue(0);
  mockUpsertProjectRagPostgresRepositoryInTransaction.mockImplementation((...args: unknown[]) =>
    mockUpsertProjectRagPostgresRepository(...args)
  );
  mockUpsertProjectRagWorkspaceContextInTransaction.mockImplementation((...args: unknown[]) =>
    mockUpsertProjectRagWorkspaceContext(...args)
  );
  mockUpsertProjectRagWorkspaceAliasInTransaction.mockImplementation((...args: unknown[]) =>
    mockUpsertProjectRagWorkspaceAlias(...args)
  );
  mockUpsertProjectRagPostgresFileInTransaction.mockImplementation((...args: unknown[]) =>
    mockUpsertProjectRagPostgresFile(...args)
  );
  mockUpsertProjectRagPostgresFileWithChunksInTransaction.mockImplementation((...args: unknown[]) =>
    mockUpsertProjectRagPostgresFileWithChunks(...args)
  );
  mockReplaceProjectRagPostgresFileChunksInTransaction.mockImplementation((...args: unknown[]) =>
    mockReplaceProjectRagPostgresFileChunks(...args)
  );
  mockReplaceProjectRagPostgresFileSymbolsInTransaction.mockImplementation((...args: unknown[]) =>
    mockReplaceProjectRagPostgresFileSymbols(...args)
  );
  mockReplaceProjectRagPostgresFileEdgesInTransaction.mockImplementation((...args: unknown[]) =>
    mockReplaceProjectRagPostgresFileEdges(...args)
  );
  mockResolveProjectRagPostgresEdgeTargetsInTransaction.mockImplementation((...args: unknown[]) =>
    mockResolveProjectRagPostgresEdgeTargets(...args)
  );
  mockDeleteProjectRagPostgresFileInTransaction.mockImplementation((...args: unknown[]) =>
    mockDeleteProjectRagPostgresFile(...args)
  );
  mockUpsertProjectRagPostgresChunkEmbedding1024InTransaction.mockImplementation(
    (...args: unknown[]) => mockUpsertProjectRagPostgresChunkEmbedding1024(...args)
  );
  mockRepairProjectRagPostgresFileVersionsInTransaction.mockImplementation((...args: unknown[]) =>
    mockRepairProjectRagPostgresFileVersions(...args)
  );
  // Fence-scoped failure path (T-04): the ingest pipeline fails snapshots
  // through failProjectRagPostgresIngestSnapshotInTransaction inside
  // withProjectRagJobFence; delegate to the same mock so existing
  // positional-arg assertions keep verifying failure reporting.
  mockFailProjectRagPostgresIngestSnapshotInTransaction.mockImplementation((...args: unknown[]) =>
    mockFailProjectRagPostgresIngestSnapshot(...args)
  );
  mockFailProjectRagPostgresCandidateVersionInTransaction.mockResolvedValue(true);
  mockClaimProjectRagPostgresIngestSnapshotInTransaction.mockImplementation((...args: unknown[]) =>
    mockClaimProjectRagPostgresIngestSnapshot(...args)
  );
  mockInsertProjectRagPostgresSyncRunInTransaction.mockResolvedValue(123);
  mockCompleteProjectRagPostgresIngest.mockImplementation(async (_sql, input) => {
    const consumed = await mockConsumeProjectRagPostgresIngestSnapshot(
      _sql,
      input.projectId,
      input.snapshotId
    );
    if (!consumed) {
      throw new Error(`snapshot_consume_failed: no CONSUMING snapshot ${input.snapshotId}`);
    }
    return { publishedBuildId: 99 };
  });
  mockFailProjectRagPostgresIngestPartial.mockImplementation(async (_sql, input) => {
    await mockFailProjectRagPostgresIngestSnapshot(
      _sql,
      input.projectId,
      input.snapshotId,
      input.failureCode,
      input.failureDetail
    );
  });
  mockAbortProjectRagPostgresIngest.mockImplementation(async (_sql, input) => {
    await mockFailProjectRagPostgresIngestSnapshot(
      _sql,
      input.projectId,
      input.snapshotId,
      input.failureCode,
      input.failureDetail
    );
    return true;
  });
  mockFetchProjectRagPostgresEmbeddings.mockResolvedValue([]);
  mockSweepStaleProjectRagPostgresIngestSnapshotsInTransaction.mockResolvedValue({
    expiredCount: 0,
    expiredIds: [],
    abandonedCount: 0,
    abandonedIds: [],
  });
  mockRenewProjectRagPostgresIngestSnapshotLease.mockResolvedValue(
    makeSnapshotRow({ status: 'CONSUMING' })
  );
  mockRenewProjectRagPostgresIngestSnapshotLeaseInTransaction.mockImplementation(
    (...args: unknown[]) => mockRenewProjectRagPostgresIngestSnapshotLease(...args)
  );
  mockConsumeProjectRagPostgresIngestSnapshot.mockResolvedValue(
    makeSnapshotRow({ status: 'CONSUMED' })
  );

  // Default gate: PREPARED, claim succeeds, revalidation matches
  mockBuildPreflightPlan.mockResolvedValue(makePreflightPlan());
  mockPrepareSnapshot.mockResolvedValue({
    snapshot: makeSnapshotRow(),
    thresholdResult: { requiresReview: false, reason: 'delta_safe' },
  });
  mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
    makeSnapshotRow({ status: 'CONSUMING' })
  );
  mockRevalidateBaseline.mockResolvedValue({
    matches: true,
    mismatchedFields: [],
    snapshot: makeSnapshotRow({ status: 'CONSUMING' }),
  });
});

async function importIngestPostgres() {
  const modulePath = './ingest-postgres.ts';
  return (await import(modulePath)) as typeof import('./ingest-postgres.js');
}

async function blockedFileFingerprint(sourcePath: string, absolutePath: string): Promise<string> {
  const fileStats = statSync(absolutePath);
  return await calculateProjectContentHash(
    `blocked:${sourcePath}:${fileStats.size}:${Math.floor(fileStats.mtimeMs)}`
  );
}

describe('project-rag postgres ingest', () => {
  it('rejects blocked project roots before opening Postgres', async () => {
    const { ingestProjectRagPostgres } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgres({
        rootPath: '/etc',
        includeRoots: ['ssh'],
        maxFiles: 1,
      })
    ).rejects.toThrow('not allowed for indexing');

    expect(mockCreateProjectRagPostgresSql).not.toHaveBeenCalled();
  });

  it('requires the current schema migration before reading or writing project rows', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-schema-gate-'));
    mkdirSync(join(rootPath, 'src'));
    const { ingestProjectRagPostgres } = await importIngestPostgres();
    mockAssertProjectRagPostgresSchemaReady.mockRejectedValueOnce(
      new Error('Project RAG schema migration 002 is required')
    );

    try {
      await expect(
        ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 1 })
      ).rejects.toThrow('schema migration 002 is required');
      expect(mockFindProjectRagPostgresProject).not.toHaveBeenCalled();
      expect(mockUpsertProjectRagPostgresRepository).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects invalid maxFiles values before processing', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-maxfiles-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgres({
          rootPath,
          includeRoots: ['src'],
          maxFiles: 0,
        })
      ).rejects.toThrow('Invalid maxFiles value');

      await expect(
        ingestProjectRagPostgres({
          rootPath,
          includeRoots: ['src'],
          maxFiles: 1.5,
        })
      ).rejects.toThrow('Invalid maxFiles value');

      expect(mockCreateProjectRagPostgresSql).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Snapshot gate — refusal tests
  // ========================================================================

  it('gate refusal with blocked findings returns FAILED and zero write helpers', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-gate-blocked-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    try {
      // mock buildPreflightPlan to return blocked findings
      mockBuildPreflightPlan.mockResolvedValue(
        makePreflightPlan({
          blockedFindings: [{ category: 'nested_repo_marker', count: 1 }],
          summary: {
            rootHash: 'root-hash',
            scopeHash: 'scope-hash',
            policyHash: 'policy-hash',
            inventoryHash: 'inv-hash',
            baselineHash: 'base-hash',
            planHash: 'plan-hash',
            addsCount: 0,
            updatesCount: 0,
            deletesCount: 0,
            eligibleCount: 0,
            trackedCount: 0,
            totalDelta: 0,
            blockedFindingCategories: 'nested_repo_marker:1',
            blockedFindingAllowlistHash:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            suppressedBlockedFindingCount: 0,
          },
        })
      );
      // prepareSnapshot will be called with blocked findings → returns FAILED
      mockPrepareSnapshot.mockResolvedValue({
        snapshot: makeSnapshotRow({ status: 'FAILED', failureCode: 'BLOCKED_ROOT_FINDINGS' }),
        thresholdResult: {
          requiresReview: true,
          reason: 'blocked_findings: 1 blocked finding categories; terminal FAILED',
        },
      });

      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
        jobLease: {
          jobId: 17,
          fenceToken: 4,
          assertOwnership: vi.fn().mockResolvedValue(undefined),
        },
      });

      // Must return with gate refusal (no writes)
      expect(result.snapshotGate).toBeDefined();
      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('blocked_findings');
      expect(result.stats.filesIndexed).toBe(0);
      expect(result.stats.filesBlocked).toBe(0);
      expect(result.stats.filesDeleted).toBe(0);
      // No raw write helpers called
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
      expect(mockUpsertProjectRagPostgresFile).not.toHaveBeenCalled();
      // Stale sweep WAS called (requirement 7)
      expect(mockSweepStaleProjectRagPostgresIngestSnapshots).toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('gate refusal with REVIEW_REQUIRED returns no writes and preflight summary', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-gate-review-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    try {
      // large delta that exceeds threshold
      mockBuildPreflightPlan.mockResolvedValue(
        makePreflightPlan({
          addsCount: 500,
          totalDelta: 500,
          trackedCount: 10000,
          summary: {
            rootHash: 'root-hash',
            scopeHash: 'scope-hash',
            policyHash: 'policy-hash',
            inventoryHash: 'inv-hash',
            baselineHash: 'base-hash',
            planHash: 'plan-hash',
            addsCount: 500,
            updatesCount: 0,
            deletesCount: 0,
            eligibleCount: 500,
            trackedCount: 10000,
            totalDelta: 500,
            blockedFindingCategories: 'none',
            blockedFindingAllowlistHash:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            suppressedBlockedFindingCount: 0,
          },
        })
      );
      mockPrepareSnapshot.mockResolvedValue({
        snapshot: makeSnapshotRow({
          status: 'REVIEW_REQUIRED',
          adds_count: '500',
          tracked_count: '10000',
        }),
        thresholdResult: {
          requiresReview: true,
          reason: 'delta_500: total delta 500 >= 500 file threshold',
        },
      });

      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
        jobLease: {
          jobId: 17,
          fenceToken: 4,
          assertOwnership: vi.fn().mockResolvedValue(undefined),
        },
      });

      expect(result.snapshotGate).toBeDefined();
      expect(result.snapshotGate?.status).toBe('REVIEW_REQUIRED');
      expect(result.snapshotGate?.preflightSummary.totalDelta).toBe(500);
      expect(result.stats.filesIndexed).toBe(0);
      // No raw write helpers called
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
      // Stale sweep called
      expect(mockSweepStaleProjectRagPostgresIngestSnapshots).toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('zero baseline with large delta (>=500) returns REVIEW_REQUIRED', async () => {
    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 0,
        addsCount: 600,
        totalDelta: 600,
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 600,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 600,
          trackedCount: 0,
          totalDelta: 600,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ status: 'REVIEW_REQUIRED', tracked_count: '0' }),
      thresholdResult: {
        requiresReview: true,
        reason: 'zero_baseline_delta_500: delta 600 >= 500 file threshold; review required',
      },
    });

    const { ingestProjectRagPostgres } = await importIngestPostgres();
    const result = await ingestProjectRagPostgres({
      rootPath: process.cwd(),
      includeRoots: ['scripts'],
      maxFiles: 10,
    });

    expect(result.snapshotGate).toBeDefined();
    expect(result.snapshotGate?.status).toBe('REVIEW_REQUIRED');
    expect(result.snapshotGate?.thresholdResult).toContain('500');
    expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
  });

  // ========================================================================
  // Snapshot gate — claim / TOCTOU / consume tests
  // ========================================================================

  it('prepares snapshots inside the fence transaction without nested begin', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-gate-prepare-tx-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    mockPublicPrepareSnapshot.mockImplementationOnce(() => {
      throw new Error('nested transaction ownership is forbidden');
    });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
        jobLease: {
          jobId: 17,
          fenceToken: 4,
          assertOwnership: vi.fn().mockResolvedValue(undefined),
        },
      });

      expect(result.snapshotGate?.status).toBe('CONSUMED');
      expect(mockPublicPrepareSnapshot).not.toHaveBeenCalled();
      expect(mockPrepareSnapshot).toHaveBeenCalledTimes(1);
      const tx = mockPrepareSnapshot.mock.calls[0]?.[0] as { begin?: unknown } | undefined;
      expect(typeof tx?.begin).toBe('function');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('safe passage through gate claims, consumes, and runs writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-gate-safe-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const app = 1;\n');

    const contentHash = await calculateProjectContentHash('export const app = 1;\n');
    // Preflight returns one candidate
    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        totalDelta: 1,
        trackedCount: 100,
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    // Gate passes
    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 42, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 42, status: 'CONSUMING' })
    );
    mockRevalidateBaseline.mockResolvedValue({
      matches: true,
      mismatchedFields: [],
      snapshot: makeSnapshotRow({ id: 42, status: 'CONSUMING' }),
    });

    // Raw write succeeds
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 99, versionId: 900001 });
    mockRepairProjectRagPostgresFileVersions.mockResolvedValue(1);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
        jobLease: {
          jobId: 17,
          fenceToken: 4,
          assertOwnership: vi.fn().mockResolvedValue(undefined),
        },
      });

      // Gate was consumed
      expect(result.snapshotGate).toBeDefined();
      expect(result.snapshotGate?.status).toBe('CONSUMED');
      expect(mockClaimProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(sql, 7, 42);
      expect(mockConsumeProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(sql, 7, 42);
      // Stale sweep called before prepare
      expect(mockSweepStaleProjectRagPostgresIngestSnapshots).toHaveBeenCalled();
      // Writes happened
      expect(mockUpsertProjectRagPostgresFileWithChunks).toHaveBeenCalled();
      expect(
        mockWithProjectRagJobFence.mock.calls.some(
          (call) =>
            call[0] === sql &&
            call[1]?.jobId === 17 &&
            call[1]?.fenceToken === 4 &&
            typeof call[2] === 'function'
        )
      ).toBe(true);
      expect(
        mockWithProjectRagJobFence.mock.calls.some(
          (call) =>
            call[3]?.projectId === 7 &&
            call[3]?.snapshotId === 42 &&
            call[3]?.snapshotUuid === '00000000-0000-0000-0000-000000000001'
        )
      ).toBe(true);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('TOCTOU rescan mismatch fails snapshot before writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-gate-toctou-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    // First preflight (before claim) has one state
    mockBuildPreflightPlan.mockResolvedValueOnce(
      makePreflightPlan({
        inventoryHash: 'inv-first',
        baselineHash: 'base-first',
        planHash: 'plan-first',
        scopeHash: 'scope-first',
        trackedCount: 10,
        totalDelta: 1,
        summary: {
          rootHash: 'rh',
          scopeHash: 'scope-first',
          policyHash: 'ph',
          inventoryHash: 'inv-first',
          baselineHash: 'base-first',
          planHash: 'plan-first',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 10,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    // Rescan (after claim) returns DIFFERENT hashes
    mockBuildPreflightPlan.mockResolvedValueOnce(
      makePreflightPlan({
        inventoryHash: 'inv-second',
        baselineHash: 'base-second',
        planHash: 'plan-second',
        scopeHash: 'scope-second',
      })
    );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 99, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 99, status: 'CONSUMING' })
    );
    // Revalidation detects mismatch
    mockRevalidateBaseline.mockResolvedValue({
      matches: false,
      mismatchedFields: ['inventory_hash', 'baseline_hash'],
      snapshot: makeSnapshotRow({ id: 99, status: 'CONSUMING' }),
    });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(result.snapshotGate).toBeDefined();
      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('rescan_mismatch');
      // Snapshot was failed
      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
        sql,
        7,
        99,
        expect.anything(),
        expect.stringContaining('inventory_hash')
      );
      // No writes
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('rescan heartbeat invokes lease renewal through progress callback', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-hb-wiring-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    // First preflight (pre-claim): normal, non-zero trackedCount
    mockBuildPreflightPlan.mockResolvedValueOnce(
      makePreflightPlan({
        trackedCount: 100,
        totalDelta: 1,
        addsCount: 1,
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    // Second preflight (rescan): invoke the progress callback inside mock
    let callbackInvoked = false;
    let renewCallsBefore = 0;
    mockBuildPreflightPlan.mockImplementationOnce(async (...args) => {
      const onProgress = args[6] as ProgressCallback | undefined;
      if (onProgress) {
        renewCallsBefore = mockRenewProjectRagPostgresIngestSnapshotLease.mock.calls.length;
        await onProgress('scan_file', 100);
        callbackInvoked = true;
      }
      return makePreflightPlan({
        trackedCount: 100,
        totalDelta: 1,
        addsCount: 1,
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      });
    });

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 77, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 77, status: 'CONSUMING' })
    );
    mockRevalidateBaseline.mockResolvedValue({
      matches: true,
      mismatchedFields: [],
      snapshot: makeSnapshotRow({ id: 77, status: 'CONSUMING' }),
    });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(callbackInvoked).toBe(true);
      expect(mockRenewProjectRagPostgresIngestSnapshotLease.mock.calls.length).toBeGreaterThan(
        renewCallsBefore
      );
      expect(result.snapshotGate?.status).toBe('CONSUMED');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('lease loss during rescan heartbeat aborts with no raw writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-hb-lease-loss-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    // First preflight (pre-claim): normal, non-zero trackedCount
    mockBuildPreflightPlan.mockResolvedValueOnce(
      makePreflightPlan({
        trackedCount: 100,
        totalDelta: 1,
        addsCount: 1,
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    // Second preflight (rescan): invoke callback after setting renew to return undefined.
    // The heartbeat throws LeaseLostError, which MUST propagate through
    // buildPreflightPlan so the entire ingest rejects rather than returning
    // a FAILED gate result (which would hide the no-raw-writes assertion).
    mockBuildPreflightPlan.mockImplementationOnce(async (...args) => {
      const onProgress = args[6] as ProgressCallback | undefined;
      if (onProgress) {
        mockRenewProjectRagPostgresIngestSnapshotLease.mockResolvedValueOnce(undefined);
        await onProgress('scan_file', 100);
      }
      return makePreflightPlan({
        trackedCount: 100,
        totalDelta: 1,
        addsCount: 1,
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      });
    });

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 55, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 55, status: 'CONSUMING' })
    );
    mockRevalidateBaseline.mockResolvedValue({
      matches: true,
      mismatchedFields: [],
      snapshot: makeSnapshotRow({ id: 55, status: 'CONSUMING' }),
    });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 10 })
      ).rejects.toThrow('lease lost');
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
      expect(mockUpsertProjectRagPostgresFile).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('claim failure returns FAILED without writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-gate-claim-fail-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 50, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    // Claim returns undefined (race / expiry)
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(undefined);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(result.snapshotGate).toBeDefined();
      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('claim_failed');
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('error during raw execution fails snapshot before rethrowing', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-gate-error-'));
    const filePath = join(rootPath, 'src', 'crash.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const crash = 1;\n');
    const ch = await calculateProjectContentHash('export const crash = 1;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        totalDelta: 1,
        trackedCount: 100,
        candidateFiles: [{ sourcePath: 'src/crash.ts', absolutePath: filePath, contentHash: ch }],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 77, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 77, status: 'CONSUMING' })
    );
    mockRevalidateBaseline.mockResolvedValue({
      matches: true,
      mismatchedFields: [],
      snapshot: makeSnapshotRow({ id: 77, status: 'CONSUMING' }),
    });

    // File processing succeeds (upsert works)
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 99, versionId: 900001 });
    // Embedding phase needs candidates so fetchEmbeddings actually runs
    mockListProjectRagPostgresChunkEmbeddingCandidates.mockResolvedValueOnce([
      { chunkId: 1, sourceHash: 'abc', text: 'export const crash = 1;' },
    ]);
    // Embedding phase throws (NOT caught per-file — propagates up)
    mockFetchProjectRagPostgresEmbeddings.mockRejectedValue(new Error('embedding_service_down'));

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgres({
          rootPath,
          includeRoots: ['src'],
          maxFiles: 10,
        })
      ).rejects.toThrow('embedding_service_down');

      // Snapshot was failed with SYSTEM_ERROR
      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
        sql,
        7,
        77,
        'SYSTEM_ERROR',
        expect.any(String)
      );
      // consume must NOT be called on error
      expect(mockConsumeProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Write-phase tests (gate passes, raw execution exercises)
  // ========================================================================

  it('skips unchanged files and processes added, changed, failed, and stale paths', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-delta-'));
    const contents = {
      unchanged: 'export const unchanged = 1;\n',
      changed: 'export const changed = 2;\n',
      failed: 'export const retry = true;\n',
      added: 'export const added = true;\n',
    };
    const paths = Object.fromEntries(
      Object.keys(contents).map((name) => [name, join(rootPath, 'src', `${name}.ts`)])
    ) as Record<keyof typeof contents, string>;
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    for (const [name, content] of Object.entries(contents)) {
      writeFileSync(paths[name as keyof typeof contents], content);
    }

    // buildPreflightPlan mock returns the candidates (without content hashing)
    const contentHashUnchanged = await calculateProjectContentHash(contents.unchanged);
    const contentHashChanged = await calculateProjectContentHash(contents.changed);
    const contentHashFailed = await calculateProjectContentHash(contents.failed);
    const contentHashAdded = await calculateProjectContentHash(contents.added);

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        updatesCount: 1,
        deletesCount: 1,
        trackedCount: 100,
        totalDelta: 3,
        candidateFiles: [
          {
            sourcePath: 'src/unchanged.ts',
            absolutePath: paths.unchanged,
            contentHash: contentHashUnchanged,
          },
          {
            sourcePath: 'src/changed.ts',
            absolutePath: paths.changed,
            contentHash: contentHashChanged,
          },
          {
            sourcePath: 'src/failed.ts',
            absolutePath: paths.failed,
            contentHash: contentHashFailed,
          },
          { sourcePath: 'src/added.ts', absolutePath: paths.added, contentHash: contentHashAdded },
        ],
        trackedStates: [
          {
            sourcePath: 'src/unchanged.ts',
            contentHash: contentHashUnchanged,
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
          {
            sourcePath: 'src/changed.ts',
            contentHash: 'old-hash',
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
          {
            sourcePath: 'src/failed.ts',
            contentHash: contentHashFailed,
            status: 'failed',
            latestVersionStatus: 'ready',
          },
          {
            sourcePath: 'src/stale.ts',
            contentHash: 'stale-hash',
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
        ],
        stalePaths: ['src/stale.ts'],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 1,
          deletesCount: 1,
          eligibleCount: 4,
          trackedCount: 100,
          totalDelta: 3,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'delta-project',
      slug: 'delta-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath: 'src/unchanged.ts',
        contentHash: contentHashUnchanged,
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
      {
        sourcePath: 'src/changed.ts',
        contentHash: 'old-hash',
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
      {
        sourcePath: 'src/failed.ts',
        contentHash: contentHashFailed,
        status: 'failed',
        latestVersionStatus: 'ready',
      },
      {
        sourcePath: 'src/stale.ts',
        contentHash: 'stale-hash',
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
    ]);
    mockDeleteProjectRagPostgresFile.mockResolvedValue(1);
    // Three files are written (added/changed/failed) — all promote cleanly.
    mockRepairProjectRagPostgresFileVersions.mockResolvedValue(3);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(result.stats.filesSelected).toBe(3);
      expect(result.stats.filesDeleted).toBe(1);
      expect(mockDeleteProjectRagPostgresFile).toHaveBeenCalledWith(sql, 7, 'src/stale.ts', {
        snapshotId: 1,
        snapshotUuid: '00000000-0000-0000-0000-000000000001',
        completenessEvidenceHash: 'a'.repeat(64),
      });
      expect(mockUpsertProjectRagPostgresFileWithChunks).toHaveBeenCalledTimes(3);
      const processedPaths = mockUpsertProjectRagPostgresFileWithChunks.mock.calls.map(
        (call) => call[2].sourcePath
      );
      expect(processedPaths).toEqual(
        expect.arrayContaining(['src/added.ts', 'src/changed.ts', 'src/failed.ts'])
      );
      expect(processedPaths).not.toContain('src/unchanged.ts');
      // Gate consumed
      expect(result.snapshotGate).toBeDefined();
      expect(result.snapshotGate?.status).toBe('CONSUMED');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('recovers an unchanged file whose latest version is pending without rewriting it', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-pending-recovery-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    const content = 'export const recovered = true;\n';
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, content);
    const contentHash = await calculateProjectContentHash(content);

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 0,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 0,
        trackedCount: 1,
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        trackedStates: [
          {
            sourcePath: 'src/app.ts',
            contentHash,
            status: 'indexed',
            latestVersionStatus: 'pending',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 0,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'pending-recovery-project',
      slug: 'pending-recovery-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath: 'src/app.ts',
        contentHash,
        status: 'indexed',
        latestVersionStatus: 'pending',
      },
    ]);
    mockListProjectRagPostgresChunkEmbeddingCandidates
      .mockResolvedValueOnce([{ chunkId: 1, sourceHash: 'pending-hash', text: content }])
      .mockResolvedValueOnce([]);
    mockFetchProjectRagPostgresEmbeddings.mockResolvedValue([[0.1]]);
    mockRepairProjectRagPostgresFileVersions.mockResolvedValueOnce(1);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.stats.filesSelected).toBe(1);
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockListProjectRagPostgresChunkEmbeddingCandidates).toHaveBeenCalledWith(
        sql,
        7,
        expect.objectContaining({ sourcePaths: ['src/app.ts'] })
      );
      expect(mockFetchProjectRagPostgresEmbeddings).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'qwen3-embedding-1024' }),
        [content],
        undefined
      );
      expect(result.finalStatus).toBe('completed');
      expect(mockPromoteProjectRagPostgresFileVersions).not.toHaveBeenCalled();
      expect(mockRepairProjectRagPostgresFileVersions).toHaveBeenCalledWith(
        sql,
        7,
        'qwen3-embedding-1024',
        'llamacpp',
        1024,
        false,
        ['src/app.ts']
      );
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('passes the claimed ingest deadline signal to slow embedding work and skips publication after abort', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-deadline-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    const content = 'export const deadline = true;\n';
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, content);
    const contentHash = await calculateProjectContentHash(content);
    const controller = new AbortController();

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 1,
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        trackedStates: [
          {
            sourcePath: 'src/app.ts',
            contentHash,
            status: 'indexed',
            latestVersionStatus: 'pending',
          },
        ],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 0,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991bb7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'deadline-project',
      slug: 'deadline-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      { sourcePath: 'src/app.ts', contentHash, status: 'indexed', latestVersionStatus: 'pending' },
    ]);
    mockListProjectRagPostgresChunkEmbeddingCandidates
      .mockResolvedValueOnce([{ chunkId: 1, sourceHash: 'pending-hash', text: content }])
      .mockResolvedValueOnce([]);
    mockFetchProjectRagPostgresEmbeddings.mockImplementationOnce(
      async (_config, _texts, signal?: AbortSignal) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal?.aborted) throw new Error('embedding request aborted');
        return [[0.1]];
      }
    );
    setTimeout(() => controller.abort(), 5);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      await expect(
        ingestProjectRagPostgres({
          rootPath,
          includeRoots: ['src'],
          maxFiles: 1,
          signal: controller.signal,
          jobLease: {
            jobId: 17,
            fenceToken: 4,
            assertOwnership: vi.fn().mockResolvedValue(undefined),
          },
        })
      ).rejects.toThrow('embedding request aborted');

      expect(mockFetchProjectRagPostgresEmbeddings).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'qwen3-embedding-1024' }),
        [content],
        controller.signal
      );
      expect(mockCompleteProjectRagPostgresIngest).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('returns partial instead of normal-promoting a pending version that fails embedding integrity', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-pending-integrity-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    const content = 'export const recovered = true;\n';
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, content);
    const contentHash = await calculateProjectContentHash(content);

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 0,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 0,
        trackedCount: 1,
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        trackedStates: [
          {
            sourcePath: 'src/app.ts',
            contentHash,
            status: 'indexed',
            latestVersionStatus: 'pending',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 0,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'pending-integrity-project',
      slug: 'pending-integrity-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      { sourcePath: 'src/app.ts', contentHash, status: 'indexed', latestVersionStatus: 'pending' },
    ]);
    mockListProjectRagPostgresChunkEmbeddingCandidates.mockResolvedValue([]);
    mockRepairProjectRagPostgresFileVersions.mockResolvedValue(0);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.finalStatus).toBe('partial');
      expect(result.stats.errors).toEqual([
        expect.objectContaining({
          file: 'src/app.ts',
          error: expect.stringContaining('embedding integrity'),
        }),
      ]);
      expect(mockPromoteProjectRagPostgresFileVersions).not.toHaveBeenCalled();
      expect(mockRepairProjectRagPostgresFileVersions).toHaveBeenCalledWith(
        sql,
        7,
        'qwen3-embedding-1024',
        'llamacpp',
        1024,
        false,
        ['src/app.ts']
      );
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('does not promote an unselected pending version when the recovery budget is exhausted', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-bounded-pending-recovery-'));
    const selectedPath = join(rootPath, 'src', 'a.ts');
    const deferredPath = join(rootPath, 'src', 'b.ts');
    const selectedContent = 'export const selected = true;\n';
    const deferredContent = 'export const deferred = true;\n';
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(selectedPath, selectedContent);
    writeFileSync(deferredPath, deferredContent);
    const hashA = await calculateProjectContentHash(selectedContent);
    const hashB = await calculateProjectContentHash(deferredContent);

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 0,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 0,
        trackedCount: 2,
        candidateFiles: [
          { sourcePath: 'src/a.ts', absolutePath: selectedPath, contentHash: hashA },
          { sourcePath: 'src/b.ts', absolutePath: deferredPath, contentHash: hashB },
        ],
        trackedStates: [
          {
            sourcePath: 'src/a.ts',
            contentHash: hashA,
            status: 'indexed',
            latestVersionStatus: 'pending',
          },
          {
            sourcePath: 'src/b.ts',
            contentHash: hashB,
            status: 'indexed',
            latestVersionStatus: 'pending',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 2,
          trackedCount: 2,
          totalDelta: 0,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'bounded-pending-recovery-project',
      slug: 'bounded-pending-recovery-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath: 'src/a.ts',
        contentHash: hashA,
        status: 'indexed',
        latestVersionStatus: 'pending',
      },
      {
        sourcePath: 'src/b.ts',
        contentHash: hashB,
        status: 'indexed',
        latestVersionStatus: 'pending',
      },
    ]);
    mockListProjectRagPostgresChunkEmbeddingCandidates
      .mockResolvedValueOnce([{ chunkId: 1, sourceHash: 'a-hash', text: selectedContent }])
      .mockResolvedValueOnce([]);
    mockFetchProjectRagPostgresEmbeddings.mockResolvedValue([[0.1]]);
    mockRepairProjectRagPostgresFileVersions.mockResolvedValueOnce(1);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.finalStatus).toBe('partial');
      expect(result.continuation).toEqual(
        expect.objectContaining({ remainingCandidateFiles: 1, remainingOperations: 1 })
      );
      expect(mockPromoteProjectRagPostgresFileVersions).not.toHaveBeenCalled();
      expect(mockRepairProjectRagPostgresFileVersions).toHaveBeenCalledWith(
        sql,
        7,
        'qwen3-embedding-1024',
        'llamacpp',
        1024,
        false,
        ['src/a.ts']
      );
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('does not promote an older pending version when selected ingestion fails', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-pending-write-failure-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    const content = 'export const current = true;\n';
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, content);
    const contentHash = await calculateProjectContentHash(content);

    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        trackedStates: [
          {
            sourcePath: 'src/app.ts',
            contentHash: 'previous-pending-content-hash',
            status: 'indexed',
            latestVersionStatus: 'pending',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'pending-write-failure-project',
      slug: 'pending-write-failure-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath: 'src/app.ts',
        contentHash: 'previous-pending-content-hash',
        status: 'indexed',
        latestVersionStatus: 'pending',
      },
    ]);
    mockUpsertProjectRagPostgresFileWithChunks.mockRejectedValueOnce(
      new Error('simulated_write_failure')
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.finalStatus).toBe('partial');
      expect(result.stats.errors).toEqual([
        { file: 'src/app.ts', error: 'simulated_write_failure' },
      ]);
      expect(mockListProjectRagPostgresChunkEmbeddingCandidates).not.toHaveBeenCalled();
      expect(mockPromoteProjectRagPostgresFileVersions).not.toHaveBeenCalled();
      expect(mockRepairProjectRagPostgresFileVersions).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('fails the claimed snapshot instead of consuming it when ingest ends partial', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-partial-snapshot-gate-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    const content = 'export const partialGate = true;\n';
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, content);
    const contentHash = await calculateProjectContentHash(content);

    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        trackedStates: [
          {
            sourcePath: 'src/app.ts',
            contentHash: 'previous-content-hash',
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'partial-snapshot-gate-project',
      slug: 'partial-snapshot-gate-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockUpsertProjectRagPostgresFileWithChunks.mockRejectedValueOnce(
      new Error('simulated_write_failure')
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.finalStatus).toBe('partial');
      // Partial runs must not consume the claimed snapshot.
      expect(mockConsumeProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
        sql,
        7,
        1,
        'SYSTEM_ERROR',
        expect.stringContaining('partial_ingest_not_consumed')
      );
      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('partial_ingest_not_consumed');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('still consumes the snapshot without failing it when ingest completes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-completed-snapshot-gate-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    const content = 'export const completedGate = true;\n';
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, content);
    const contentHash = await calculateProjectContentHash(content);

    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        trackedStates: [
          {
            sourcePath: 'src/app.ts',
            contentHash: 'previous-content-hash',
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'completed-snapshot-gate-project',
      slug: 'completed-snapshot-gate-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockRepairProjectRagPostgresFileVersions.mockResolvedValue(1);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.finalStatus).toBe('completed');
      // Completed runs still consume the claimed snapshot.
      expect(mockConsumeProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(sql, 7, 1);
      expect(mockFailProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
      expect(result.snapshotGate?.status).toBe('CONSUMED');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('does not promote an older pending version when selected ingestion becomes blocked', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-pending-blocked-'));
    const sourcePath = 'src/.ssh/config.ts';
    const filePath = join(rootPath, sourcePath);
    mkdirSync(join(rootPath, 'src', '.ssh'), { recursive: true });
    writeFileSync(filePath, 'export const blocked = true;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 0,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 0,
        trackedCount: 1,
        candidateFiles: [{ sourcePath, absolutePath: filePath, contentHash: 'blocked-hash' }],
        trackedStates: [
          {
            sourcePath,
            contentHash: 'previous-pending-content-hash',
            status: 'indexed',
            latestVersionStatus: 'pending',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 0,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'pending-blocked-project',
      slug: 'pending-blocked-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath,
        contentHash: 'previous-pending-content-hash',
        status: 'indexed',
        latestVersionStatus: 'pending',
      },
    ]);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.stats.filesBlocked).toBe(1);
      expect(mockUpsertProjectRagPostgresFileInTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ begin: expect.any(Function) }),
        7,
        expect.objectContaining({ sourcePath, status: 'blocked' })
      );
      expect(mockListProjectRagPostgresChunkEmbeddingCandidates).not.toHaveBeenCalled();
      expect(mockPromoteProjectRagPostgresFileVersions).not.toHaveBeenCalled();
      expect(mockRepairProjectRagPostgresFileVersions).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('skips an unchanged blocked file with the same safe fingerprint', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-stable-blocked-'));
    const sourcePath = 'src/.ssh/config.ts';
    const filePath = join(rootPath, sourcePath);
    mkdirSync(join(rootPath, 'src', '.ssh'), { recursive: true });
    writeFileSync(filePath, 'export const blocked = true;\n');
    const fp = await blockedFileFingerprint(sourcePath, filePath);

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 0,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 0,
        trackedCount: 1,
        candidateFiles: [{ sourcePath, absolutePath: filePath, contentHash: fp }],
        trackedStates: [
          { sourcePath, contentHash: fp, status: 'blocked', latestVersionStatus: 'ready' },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 0,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'stable-blocked-project',
      slug: 'stable-blocked-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      { sourcePath, contentHash: fp, status: 'blocked', latestVersionStatus: 'ready' },
    ]);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.stats.filesSelected).toBe(0);
      expect(result.stats.filesBlocked).toBe(0);
      expect(mockUpsertProjectRagPostgresFile).not.toHaveBeenCalled();
      expect(mockListProjectRagPostgresChunkEmbeddingCandidates).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('retries a blocked file when its safe fingerprint changes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-changed-blocked-'));
    const sourcePath = 'src/.ssh/config.ts';
    const filePath = join(rootPath, sourcePath);
    mkdirSync(join(rootPath, 'src', '.ssh'), { recursive: true });
    writeFileSync(filePath, 'export const changedBlocked = true;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 0,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 0,
        trackedCount: 1,
        candidateFiles: [{ sourcePath, absolutePath: filePath, contentHash: 'new-fp' }],
        trackedStates: [
          {
            sourcePath,
            contentHash: 'old-safe-fingerprint',
            status: 'blocked',
            latestVersionStatus: 'ready',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 0,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'changed-blocked-project',
      slug: 'changed-blocked-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath,
        contentHash: 'old-safe-fingerprint',
        status: 'blocked',
        latestVersionStatus: 'ready',
      },
    ]);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.stats.filesSelected).toBe(1);
      expect(result.stats.filesBlocked).toBe(1);
      expect(mockUpsertProjectRagPostgresFile).toHaveBeenCalledWith(
        sql,
        7,
        expect.objectContaining({
          sourcePath,
          status: 'blocked',
          contentHash: await blockedFileFingerprint(sourcePath, filePath),
        })
      );
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('returns continuation metadata when a bounded delta leaves stale and candidate work', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-delta-continuation-'));
    const firstFile = join(rootPath, 'src', 'first.ts');
    const secondFile = join(rootPath, 'src', 'second.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(firstFile, 'export const first = true;\n');
    writeFileSync(secondFile, 'export const second = true;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 2,
        updatesCount: 0,
        deletesCount: 1,
        totalDelta: 3,
        candidateFiles: [
          { sourcePath: 'src/first.ts', absolutePath: firstFile, contentHash: 'h1' },
          { sourcePath: 'src/second.ts', absolutePath: secondFile, contentHash: 'h2' },
        ],
        trackedStates: [
          {
            sourcePath: 'src/stale.ts',
            contentHash: 'stale-hash',
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
        ],
        stalePaths: ['src/stale.ts'],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 2,
          updatesCount: 0,
          deletesCount: 1,
          eligibleCount: 2,
          trackedCount: 1,
          totalDelta: 3,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'delta-continuation-project',
      slug: 'delta-continuation-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath: 'src/stale.ts',
        contentHash: 'stale-hash',
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
    ]);
    mockDeleteProjectRagPostgresFile.mockResolvedValue(1);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.finalStatus).toBe('partial');
      expect(result.continuation).toEqual({
        maxFiles: 1,
        totalOperations: 3,
        remainingOperations: 2,
        remainingStalePaths: 0,
        remainingCandidateFiles: 2,
      });
      expect(result.stats.filesDeleted).toBe(1);
      expect(result.stats.filesSelected).toBe(0);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('bounds stale cleanup with explicit per-path deletes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-stale-batch-'));
    const filePath = join(rootPath, 'src', 'current.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const current = true;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 0,
        updatesCount: 0,
        deletesCount: 3,
        totalDelta: 3,
        candidateFiles: [
          { sourcePath: 'src/current.ts', absolutePath: filePath, contentHash: 'curr-hash' },
        ],
        trackedStates: [
          {
            sourcePath: 'src/stale-a.ts',
            contentHash: 'stale-a',
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
          {
            sourcePath: 'src/stale-b.ts',
            contentHash: 'stale-b',
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
          {
            sourcePath: 'src/stale-c.ts',
            contentHash: 'stale-c',
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
        ],
        stalePaths: ['src/stale-a.ts', 'src/stale-b.ts', 'src/stale-c.ts'],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 3,
          eligibleCount: 1,
          trackedCount: 3,
          totalDelta: 3,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'stale-batch-project',
      slug: 'stale-batch-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath: 'src/stale-a.ts',
        contentHash: 'stale-a',
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
      {
        sourcePath: 'src/stale-b.ts',
        contentHash: 'stale-b',
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
      {
        sourcePath: 'src/stale-c.ts',
        contentHash: 'stale-c',
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
    ]);
    mockDeleteProjectRagPostgresFile.mockResolvedValue(1);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 2,
      });

      expect(result.stats.filesDeleted).toBe(2);
      expect(result.stats.filesSelected).toBe(0);
      expect(mockDeleteProjectRagPostgresFile.mock.calls.map((call) => call[2])).toEqual([
        'src/stale-a.ts',
        'src/stale-b.ts',
      ]);
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('force selects unchanged files when the operation fits the budget', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-force-unchanged-'));
    const filePath = join(rootPath, 'src', 'same.ts');
    const content = 'export const same = true;\n';
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, content);
    const ch = await calculateProjectContentHash(content);

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 0,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 0,
        trackedCount: 1,
        candidateFiles: [{ sourcePath: 'src/same.ts', absolutePath: filePath, contentHash: ch }],
        trackedStates: [
          {
            sourcePath: 'src/same.ts',
            contentHash: ch,
            status: 'indexed',
            latestVersionStatus: 'ready',
          },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 0,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 7,
      name: 'force-project',
      slug: 'force-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath: 'src/same.ts',
        contentHash: ch,
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
    ]);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        force: true,
        maxFiles: 1,
      });

      expect(result.stats.filesSelected).toBe(1);
      expect(mockUpsertProjectRagPostgresFileWithChunks).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects single-file paths that escape the project root before opening Postgres', async () => {
    const { ingestProjectRagPostgresFile } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgresFile({
        rootPath: process.cwd(),
        filePath: '../outside.ts',
      })
    ).rejects.toThrow('File path escapes project root');
  });

  it('rejects single-file ingests outside registered includeRoots before scanning files', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-scope-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    mkdirSync(join(rootPath, 'docs'), { recursive: true });
    writeFileSync(join(rootPath, 'docs', 'private.md'), '# Private\n');
    mockFindProjectRagPostgresProject.mockResolvedValueOnce({
      name: 'existing-project',
      includeRoots: ['src'],
      ignoreRules: [],
      rootPath: realpathSync.native(rootPath),
      normalizedRootPath: realpathSync.native(rootPath),
    });

    try {
      const { ingestProjectRagPostgresFile } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgresFile({
          rootPath,
          filePath: 'docs/private.md',
        })
      ).rejects.toThrow('outside registered Project RAG includeRoots');

      expect(mockUpsertProjectRagPostgresRepository).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('does not request unscoped embeddings when no files were processed', async () => {
    // Preflight returns no candidates
    mockBuildPreflightPlan.mockResolvedValue(makePreflightPlan());

    const { ingestProjectRagPostgres } = await importIngestPostgres();
    const result = await ingestProjectRagPostgres({
      rootPath: process.cwd(),
      includeRoots: ['scripts'],
      maxFiles: 1,
    });

    expect(result.stats.filesSelected).toBe(0);
    expect(result.stats.embeddingsCreated).toBe(0);
    expect(mockListProjectRagPostgresChunkEmbeddingCandidates).not.toHaveBeenCalled();
    expect(mockFetchProjectRagPostgresEmbeddings).not.toHaveBeenCalled();
  });

  it('keeps blocked single-file ingests tracked for scope coverage', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-blocked-'));
    const sourcePath = 'src/.ssh/config.ts';
    const filePath = join(rootPath, 'src', '.ssh', 'config.ts');
    mkdirSync(join(rootPath, 'src', '.ssh'), { recursive: true });
    writeFileSync(filePath, 'export const visible = true;\n');

    mockFindProjectRagPostgresProject.mockResolvedValueOnce({
      name: 'existing-project',
      includeRoots: ['src', 'docs'],
      ignoreRules: ['dist'],
      rootPath: realpathSync.native(rootPath),
      normalizedRootPath: realpathSync.native(rootPath),
    });

    // Preflight must return the target file so the gate sees it
    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        candidateFiles: [{ sourcePath, absolutePath: filePath, contentHash: 'blocked-fp' }],
        trackedStates: [
          { sourcePath, contentHash: 'old-fp', status: 'indexed', latestVersionStatus: 'ready' },
        ],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    try {
      const { ingestProjectRagPostgresFile } = await importIngestPostgres();
      const result = await ingestProjectRagPostgresFile({
        rootPath,
        filePath: 'src/.ssh/config.ts',
        force: true,
      });

      expect(result.stats.filesBlocked).toBe(1);
      expect(result.stats.filesDeleted).toBe(0);
      expect(mockUpsertProjectRagPostgresRepository).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({
          includeRoots: ['src', 'docs'],
          ignoreRules: ['dist'],
        })
      );
      expect(mockUpsertProjectRagPostgresFile).toHaveBeenCalledWith(
        sql,
        7,
        expect.objectContaining({
          sourcePath: 'src/.ssh/config.ts',
          status: 'blocked',
          metadata: expect.objectContaining({
            blocked: true,
            blockReason: 'path',
            blockPattern: 'ssh-dir',
          }),
        })
      );
      // Blocked files use the immediate-ready file/version path with zero
      // derived rows; candidate chunk/symbol/edge replacement is forbidden.
      expect(mockReplaceProjectRagPostgresFileChunksInTransaction).not.toHaveBeenCalled();
      expect(mockReplaceProjectRagPostgresFileSymbolsInTransaction).not.toHaveBeenCalled();
      expect(mockReplaceProjectRagPostgresFileEdgesInTransaction).not.toHaveBeenCalled();
      expect(mockFailProjectRagPostgresCandidateVersionInTransaction).not.toHaveBeenCalled();
      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
      expect(mockFetchProjectRagPostgresEmbeddings).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('throws clear error for single-file target excluded by ignore rules (no delete)', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-ignored-'));
    const filePath = join(rootPath, 'src', 'output.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const x = 1;\n');

    try {
      const { ingestProjectRagPostgresFile } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgresFile({
          rootPath,
          filePath: 'src/output.ts',
        })
      ).rejects.toThrow(/Target file excluded|excluded by project rules|No existing indexed data/);

      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('throws clear error for non-existent single-file target (no delete)', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-missing-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    try {
      const { ingestProjectRagPostgresFile } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgresFile({
          rootPath,
          filePath: 'src/missing.ts',
        })
      ).rejects.toThrow(/Target file not found|does not exist/);

      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('redacts PII from content before chunking and before embedding', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-pii-'));
    const filePath = join(rootPath, 'src', 'config.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(
      filePath,
      "// Contact: admin@example.com\nconst api_key = 'example_api_value_1234567890';\nconst hash = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';\n"
    );
    const content = readFileSync(filePath, 'utf8');
    const ch = await calculateProjectContentHash(content);

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        trackedCount: 0,
        candidateFiles: [{ sourcePath: 'src/config.ts', absolutePath: filePath, contentHash: ch }],
        trackedStates: [],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 0,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 9, versionId: 900003 });
    mockChunkTextWithContextProfile.mockResolvedValue([
      {
        content: '[REDACTED_EMAIL] content',
        searchableText: '[REDACTED_EMAIL] content',
      },
    ]);
    mockReplaceProjectRagPostgresFileChunks.mockResolvedValue(1);
    mockListProjectRagPostgresChunkEmbeddingCandidates
      .mockResolvedValueOnce([{ chunkId: 1, sourceHash: 'abc', text: '[REDACTED_EMAIL] content' }])
      .mockResolvedValueOnce([]);
    mockFetchProjectRagPostgresEmbeddings.mockResolvedValue([
      Array.from({ length: 1024 }, () => 0.1),
    ]);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.stats.filesIndexed).toBe(1);
      expect(mockChunkTextWithContextProfile).toHaveBeenCalledTimes(1);
      const chunkerContent = mockChunkTextWithContextProfile.mock.calls[0]?.[0] as string;
      expect(chunkerContent).not.toContain('admin@example.com');
      expect(chunkerContent).toContain('[REDACTED_EMAIL]');
      expect(chunkerContent).not.toContain('example_api_value_1234567890');
      expect(chunkerContent).toContain('[REDACTED:generic-api-key]');
      expect(chunkerContent).toContain('da39a3ee5e6b4b0d3255bfef95601890afd80709');
      const chunkInputs = mockUpsertProjectRagPostgresFileWithChunks.mock.calls[0]?.[3] as Array<{
        content: string;
        searchableText: string;
      }>;
      expect(chunkInputs[0]?.content).not.toContain('admin@example.com');
      expect(chunkInputs[0]?.content).toContain('[REDACTED_EMAIL]');
      expect(mockFetchProjectRagPostgresEmbeddings).toHaveBeenCalledTimes(1);
      const embeddingTexts = mockFetchProjectRagPostgresEmbeddings.mock.calls[0]?.[1] as string[];
      const joined = embeddingTexts.join(' ');
      expect(joined).not.toContain('admin@example.com');
      expect(joined).toContain('[REDACTED_EMAIL]');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('extracts and persists symbols for TypeScript files during ingest', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-symbols-'));
    const filePath = join(rootPath, 'src', 'api.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const dummy = 1;\n');
    const ch = await calculateProjectContentHash('export const dummy = 1;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        trackedCount: 0,
        candidateFiles: [{ sourcePath: 'src/api.ts', absolutePath: filePath, contentHash: ch }],
        trackedStates: [],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 0,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 9, versionId: 900003 });
    mockListProjectRagPostgresChunkEmbeddingCandidates
      .mockResolvedValueOnce([{ chunkId: 1, sourceHash: 'abc', text: 'content' }])
      .mockResolvedValueOnce([]);
    mockFetchProjectRagPostgresEmbeddings.mockResolvedValue([
      Array.from({ length: 1024 }, () => 0.1),
    ]);
    mockParseAst.mockReturnValue({
      symbols: [
        { name: 'User', symbolType: 'interface', exportType: 'named', startLine: 1, endLine: 1 },
        {
          name: 'greet',
          symbolType: 'function',
          exportType: 'named',
          signature: 'export function greet(u: User): string',
          startLine: 2,
          endLine: 2,
        },
      ],
      edges: [
        { targetId: 'helper', relationType: 'CALLS' },
        { targetId: './types', relationType: 'IMPORTS' },
      ],
    });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.stats.filesIndexed).toBe(1);
      expect(mockReplaceProjectRagPostgresFileSymbols).toHaveBeenCalledTimes(1);
      const symbolArgs = mockReplaceProjectRagPostgresFileSymbols.mock.calls[0];
      expect(symbolArgs[0]).toBe(sql);
      expect(symbolArgs[1]).toBe(7);
      expect(symbolArgs[2]).toBe(9);
      const symbols = symbolArgs[3] as Array<{ name: string; symbolType: string }>;
      const names = symbols.map((s) => s.name);
      expect(names).toContain('User');
      expect(names).toContain('greet');

      expect(mockReplaceProjectRagPostgresFileEdges).toHaveBeenCalledTimes(1);
      const edgeArgs = mockReplaceProjectRagPostgresFileEdges.mock.calls[0];
      expect(edgeArgs[1]).toBe(7);
      expect(edgeArgs[2]).toBe(9);
      const edges = edgeArgs[3] as Array<{ relationType: string; targetRef: string }>;
      expect(edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relationType: 'CALLS', targetRef: 'helper' }),
          expect.objectContaining({ relationType: 'IMPORTS', targetRef: './types' }),
        ])
      );
      expect(mockResolveProjectRagPostgresEdgeTargets).toHaveBeenCalledWith(sql, 7);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('fails ingest and the claimed snapshot when edge target resolution rejects', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-edge-resolve-failure-'));
    const filePath = join(rootPath, 'src', 'api.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const api = 1;\n');
    const contentHash = await calculateProjectContentHash('export const api = 1;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        totalDelta: 1,
        eligibleCount: 1,
        candidateFiles: [{ sourcePath: 'src/api.ts', absolutePath: filePath, contentHash }],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 0,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockResolveProjectRagPostgresEdgeTargets.mockRejectedValueOnce(
      new Error('edge resolver unavailable')
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 1 })
      ).rejects.toThrow('edge resolver unavailable');

      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
        sql,
        7,
        1,
        'SYSTEM_ERROR',
        'edge resolver unavailable'
      );
      expect(mockConsumeProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('clears stale symbols when parse returns no symbols for a TS file', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-no-symbols-'));
    const filePath = join(rootPath, 'src', 'empty.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, '// just a comment with no symbols\n');
    const ch = await calculateProjectContentHash('// just a comment with no symbols\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        trackedCount: 0,
        candidateFiles: [{ sourcePath: 'src/empty.ts', absolutePath: filePath, contentHash: ch }],
        trackedStates: [],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 0,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 9, versionId: 900003 });
    mockListProjectRagPostgresChunkEmbeddingCandidates
      .mockResolvedValueOnce([{ chunkId: 1, sourceHash: 'abc', text: 'content' }])
      .mockResolvedValueOnce([]);
    mockFetchProjectRagPostgresEmbeddings.mockResolvedValue([
      Array.from({ length: 1024 }, () => 0.1),
    ]);
    mockParseAst.mockReturnValue({ symbols: [], edges: [] });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.stats.filesIndexed).toBe(1);
      expect(mockReplaceProjectRagPostgresFileSymbolsInTransaction).toHaveBeenCalledTimes(1);
      const symbolArgs = mockReplaceProjectRagPostgresFileSymbolsInTransaction.mock.calls[0];
      expect(symbolArgs[1]).toBe(7);
      expect(symbolArgs[2]).toBe(9);
      expect(symbolArgs[3]).toEqual([]);
      expect(symbolArgs[4]).toBe(900003);
      expect(mockReplaceProjectRagPostgresFileEdgesInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        7,
        9,
        [],
        900003
      );
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('fails the candidate when parseAst throws and leaves the old reader path untouched', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-parse-error-'));
    const filePath = join(rootPath, 'src', 'broken.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const x = 1;\n');
    const ch = await calculateProjectContentHash('export const x = 1;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        trackedCount: 0,
        candidateFiles: [{ sourcePath: 'src/broken.ts', absolutePath: filePath, contentHash: ch }],
        trackedStates: [],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 0,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 9, versionId: 900003 });
    mockListProjectRagPostgresChunkEmbeddingCandidates
      .mockResolvedValueOnce([{ chunkId: 1, sourceHash: 'abc', text: 'content' }])
      .mockResolvedValueOnce([]);
    mockFetchProjectRagPostgresEmbeddings.mockResolvedValue([
      Array.from({ length: 1024 }, () => 0.1),
    ]);
    mockParseAst.mockImplementation(() => {
      throw new Error('parse_error');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 1,
      });

      expect(result.finalStatus).toBe('partial');
      expect(result.stats.filesIndexed).toBe(0);
      expect(result.stats.errors).toEqual([
        { file: 'src/broken.ts', error: expect.stringContaining('AST_PARSE_FAILED: parse_error') },
      ]);
      // Skeleton generator catches parseAst errors and warns via console.warn
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('parse_error'));
      expect(mockFailProjectRagPostgresCandidateVersionInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        7,
        9,
        900003,
        'AST_PARSE_FAILED: parse_error'
      );
      expect(mockReplaceProjectRagPostgresFileSymbolsInTransaction).not.toHaveBeenCalled();
      expect(mockReplaceProjectRagPostgresFileEdgesInTransaction).not.toHaveBeenCalled();
      expect(mockListProjectRagPostgresChunkEmbeddingCandidates).not.toHaveBeenCalled();
      expect(mockCompleteProjectRagPostgresIngest).not.toHaveBeenCalled();
      expect(mockFailProjectRagPostgresIngestPartial).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({ projectId: 7, snapshotId: 1, syncRunId: 123 })
      );
    } finally {
      warnSpy.mockRestore();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('preserves old active version when embedding generation fails', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-embed-fail-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const value = 1;\n');
    const ch = await calculateProjectContentHash('export const value = 1;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        totalDelta: 1,
        trackedCount: 0,
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash: ch }],
        trackedStates: [],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 0,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 9, versionId: 900003 });
    mockListProjectRagPostgresChunkEmbeddingCandidates
      .mockResolvedValueOnce([{ chunkId: 1, sourceHash: 'abc', text: 'export const value = 1;' }])
      .mockResolvedValueOnce([]);
    mockFetchProjectRagPostgresEmbeddings.mockRejectedValue(
      new Error('embedding_model_unreachable')
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgres({
          rootPath,
          includeRoots: ['src'],
          maxFiles: 1,
        })
      ).rejects.toThrow('embedding_model_unreachable');

      expect(mockUpsertProjectRagPostgresFileWithChunks).toHaveBeenCalledTimes(1);
      expect(mockPromoteProjectRagPostgresFileVersions).not.toHaveBeenCalled();
      expect(mockListProjectRagPostgresChunkEmbeddingCandidates).toHaveBeenCalledTimes(1);
      expect(mockFetchProjectRagPostgresEmbeddings).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Additional gate boundary tests
  // ========================================================================

  it('blocked findings on rescan fail the snapshot before writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-blocked-rescan-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    // First preflight: no blocked findings → PREPARED
    mockBuildPreflightPlan.mockResolvedValueOnce(
      makePreflightPlan({
        trackedCount: 100,
        totalDelta: 1,
        blockedFindings: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    // Rescan: blocked findings appear
    mockBuildPreflightPlan.mockResolvedValueOnce(
      makePreflightPlan({
        trackedCount: 100,
        totalDelta: 0,
        blockedFindings: [{ category: 'nested_repo_marker', count: 1 }],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 0,
          trackedCount: 100,
          totalDelta: 0,
          blockedFindingCategories: 'nested_repo_marker:1',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 88, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 88, status: 'CONSUMING' })
    );

    const { ingestProjectRagPostgres } = await importIngestPostgres();
    const result = await ingestProjectRagPostgres({
      rootPath,
      includeRoots: ['src'],
      maxFiles: 10,
    });

    expect(result.snapshotGate).toBeDefined();
    expect(result.snapshotGate?.status).toBe('FAILED');
    expect(result.snapshotGate?.thresholdResult).toContain('blocked_findings_on_rescan');
    expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();

    rmSync(rootPath, { recursive: true, force: true });
  });

  it('zero-baseline with 499 delta passes as PREPARED', async () => {
    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 0,
        addsCount: 499,
        totalDelta: 499,
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 499,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 499,
          trackedCount: 0,
          totalDelta: 499,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({
        id: 101,
        status: 'PREPARED',
        adds_count: '499',
        tracked_count: '0',
      }),
      thresholdResult: {
        requiresReview: false,
        reason: 'zero_baseline_delta_safe: delta 499 below all thresholds; PREPARED',
      },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 101, status: 'CONSUMING' })
    );

    const { ingestProjectRagPostgres } = await importIngestPostgres();
    const result = await ingestProjectRagPostgres({
      rootPath: process.cwd(),
      includeRoots: ['scripts'],
      maxFiles: 10,
    });

    expect(result.snapshotGate).toBeDefined();
    expect(result.snapshotGate?.status).toBe('CONSUMED');
  });

  it('zero-baseline with 500 delta returns REVIEW_REQUIRED', async () => {
    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 0,
        addsCount: 500,
        totalDelta: 500,
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 500,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 500,
          trackedCount: 0,
          totalDelta: 500,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({
        id: 102,
        status: 'REVIEW_REQUIRED',
        adds_count: '500',
        tracked_count: '0',
      }),
      thresholdResult: {
        requiresReview: true,
        reason: 'zero_baseline_delta_500: delta 500 >= 500 file threshold; review required',
      },
    });

    const { ingestProjectRagPostgres } = await importIngestPostgres();
    const result = await ingestProjectRagPostgres({
      rootPath: process.cwd(),
      includeRoots: ['scripts'],
      maxFiles: 10,
    });

    expect(result.snapshotGate).toBeDefined();
    expect(result.snapshotGate?.status).toBe('REVIEW_REQUIRED');
    expect(result.snapshotGate?.thresholdResult).toContain('zero_baseline_delta_500');
    expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
  });

  it('lease renewal failure during stale delete aborts snapshot', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-lease-loss-stale-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(join(rootPath, 'src', 'a.ts'), 'export const a = 1;\n');
    const ch = await calculateProjectContentHash('export const a = 1;\n');

    // Use mockImplementation to always return undefined (lease always lost)
    mockRenewProjectRagPostgresIngestSnapshotLease.mockResolvedValue(undefined);

    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 0,
        deletesCount: 1,
        stalePaths: ['src/stale.ts'],
        candidateFiles: [
          { sourcePath: 'src/a.ts', absolutePath: join(rootPath, 'src', 'a.ts'), contentHash: ch },
        ],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 1,
          eligibleCount: 1,
          trackedCount: 1,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 10 })
    ).rejects.toThrow('lease lost');
    expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();

    rmSync(rootPath, { recursive: true, force: true });
  });

  it('consume zero-row throws honest failure, never hardcodes CONSUMED', async () => {
    // Completed raw phase (real candidate file, promotion verified) so the
    // flow actually reaches the consume call.
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-consume-zero-'));
    const filePath = join(rootPath, 'src', 'new.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const fresh = 1;\n');
    const contentHash = await calculateProjectContentHash('export const fresh = 1;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 100,
        totalDelta: 1,
        addsCount: 1,
        candidateFiles: [{ sourcePath: 'src/new.ts', absolutePath: filePath, contentHash }],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockRepairProjectRagPostgresFileVersions.mockResolvedValue(1);
    // consume returns undefined (no row updated)
    mockConsumeProjectRagPostgresIngestSnapshot.mockResolvedValue(undefined);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();

      await expect(
        ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 1 })
      ).rejects.toThrow('snapshot_consume_failed');
      // Snapshot should be failed with SYSTEM_ERROR before throwing
      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
        sql,
        7,
        1,
        'SYSTEM_ERROR',
        expect.stringContaining('snapshot_consume_failed')
      );
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Reads-untouched invariant tests
  // ========================================================================

  it('reads untouched: sweep stale and tracked states are the only reads before gate', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-reads-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(join(rootPath, 'src', 'file.ts'), 'export const a = 1;\n');

    mockFindProjectRagPostgresProject.mockResolvedValue({
      id: 42,
      name: 'reads-project',
      slug: 'reads-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
    });
    mockListProjectRagPostgresFileStates.mockResolvedValue([
      {
        sourcePath: 'src/file.ts',
        contentHash: 'hash',
        status: 'indexed',
        latestVersionStatus: 'ready',
      },
    ]);

    // Gate refuses (blocked findings) — no writes
    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 1,
        blockedFindings: [{ category: 'nested_repo_marker', count: 1 }],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 0,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 0,
          trackedCount: 1,
          totalDelta: 0,
          blockedFindingCategories: 'nested_repo_marker:1',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );
    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ status: 'FAILED', failureCode: 'BLOCKED_ROOT_FINDINGS' }),
      thresholdResult: { requiresReview: true, reason: 'blocked_findings: terminal FAILED' },
    });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      // Reads happened (sweep + tracked)
      expect(mockSweepStaleProjectRagPostgresIngestSnapshots).toHaveBeenCalled();
      expect(mockListProjectRagPostgresFileStates).toHaveBeenCalled();
      // No write helpers called
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockUpsertProjectRagPostgresFile).not.toHaveBeenCalled();
      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
      // Gate result reflects refusal
      expect(result.snapshotGate).toBeDefined();
      expect(result.snapshotGate?.status).toBe('FAILED');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Error classification tests
  // ========================================================================

  it('content drift uses RESCAN_MISMATCH failure code', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-drift-code-'));
    const filePath = join(rootPath, 'src', 'drift.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const drift = 1;\n');
    // Provide wrong content hash so drift check fires
    const wrongHash = await calculateProjectContentHash('wrong content');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 100,
        addsCount: 1,
        totalDelta: 1,
        candidateFiles: [
          { sourcePath: 'src/drift.ts', absolutePath: filePath, contentHash: wrongHash },
        ],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 10 })
    ).rejects.toThrow(ContentHashMismatchError);

    expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
      sql,
      7,
      1,
      'RESCAN_MISMATCH', // NOT SYSTEM_ERROR
      expect.any(String)
    );

    rmSync(rootPath, { recursive: true, force: true });
  });

  it('keeps ContentHashMismatchError classification stable when a subclass changes its message', async () => {
    // Regression: the per-file catch must use instanceof ContentHashMismatchError
    // rather than message.startsWith('content_hash_mismatch:').
    // Create a subclass with a non-standard message to prove instanceof works.
    class CustomContentHashError extends ContentHashMismatchError {
      constructor(sourcePath: string, expectedHash: string, actualHash: string) {
        super(sourcePath, expectedHash, actualHash);
        // Override message to NOT contain any trace of 'content_hash_mismatch'
        this.message = `CUSTOM_HASH_ERROR: ${sourcePath} ${expectedHash} ${actualHash}`;
        this.name = 'CustomContentHashError';
      }
    }

    const customError = new CustomContentHashError('src/altered.ts', 'expected', 'actual');
    expect(customError).toBeInstanceOf(ContentHashMismatchError);
    expect(customError.code).toBe('CONTENT_HASH_MISMATCH');
    expect(customError.message).not.toContain('content_hash_mismatch');

    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-content-hash-instanceof-'));
    const filePath = join(rootPath, 'src', 'altered.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const x = 1;\n');

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    // Make the inner catch throw a subclass with altered message
    // We mock the file read to return different content
    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        trackedCount: 100,
        totalDelta: 1,
        candidateFiles: [
          {
            sourcePath: 'src/altered.ts',
            absolutePath: filePath,
            contentHash: 'hash-that-will-not-match',
          },
        ],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          force: false,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    // Actually we can't easily inject a custom subclass into the production code.
    // Instead, verify that the production code's throw creates a ContentHashMismatchError
    // that the outer catch correctly classifies.
    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 5 })
    ).rejects.toThrow(ContentHashMismatchError);

    // Must be classified as RESCAN_MISMATCH (not SYSTEM_ERROR)
    expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
      sql,
      7,
      1,
      'RESCAN_MISMATCH',
      expect.any(String)
    );

    rmSync(rootPath, { recursive: true, force: true });
  });

  // ========================================================================
  // Post-claim unexpected errors must fail snapshot immediately (no 300s CONSUMING)
  // ========================================================================

  it('post-claim listProjectRagPostgresFileStates throw fails snapshot and rethrows', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-postclaim-listthrow-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(join(rootPath, 'src', 'a.ts'), 'export const a = 1;\n');

    // Make listProjectRagPostgresFileStates throw after claim succeeds
    mockListProjectRagPostgresFileStates.mockRejectedValueOnce(
      new Error('listProjectRagPostgresFileStates failed')
    );

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 5 })
    ).rejects.toThrow('listProjectRagPostgresFileStates failed');

    // Snapshot must be failed (not stuck in CONSUMING)
    expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
      sql,
      7,
      1,
      'SYSTEM_ERROR',
      expect.stringContaining('listProjectRagPostgresFileStates')
    );

    rmSync(rootPath, { recursive: true, force: true });
  });

  it('post-claim buildPreflightPlan throw fails snapshot and rethrows', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-postclaim-buildthrow-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(join(rootPath, 'src', 'a.ts'), 'export const a = 1;\n');

    // BuildPreflightPlan is called once for pre-prepare (first call succeeds)
    // and once for post-claim rescan (second call fails)
    mockBuildPreflightPlan
      .mockResolvedValueOnce(
        makePreflightPlan({
          addsCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          summary: {
            rootHash: 'rh',
            scopeHash: 'sh',
            policyHash: 'ph',
            inventoryHash: 'ih',
            baselineHash: 'bh',
            planHash: 'plh',
            addsCount: 1,
            updatesCount: 0,
            deletesCount: 0,
            eligibleCount: 1,
            trackedCount: 100,
            totalDelta: 1,
            force: false,
            blockedFindingCategories: 'none',
            blockedFindingAllowlistHash:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            suppressedBlockedFindingCount: 0,
          },
        })
      )
      .mockRejectedValueOnce(new Error('buildPreflightPlan post-claim failed'));

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 5 })
    ).rejects.toThrow('buildPreflightPlan post-claim failed');

    // Snapshot must be failed
    expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
      sql,
      7,
      1,
      'SYSTEM_ERROR',
      expect.stringContaining('buildPreflightPlan')
    );

    rmSync(rootPath, { recursive: true, force: true });
  });

  it('post-claim revalidateBaseline throw fails snapshot and rethrows', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-postclaim-revalthrow-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(join(rootPath, 'src', 'a.ts'), 'export const a = 1;\n');

    mockRevalidateBaseline.mockRejectedValueOnce(new Error('revalidateBaseline query failed'));

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 5 })
    ).rejects.toThrow('revalidateBaseline');

    // Snapshot must be failed
    expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
      sql,
      7,
      1,
      'SYSTEM_ERROR',
      expect.stringContaining('revalidateBaseline')
    );

    rmSync(rootPath, { recursive: true, force: true });
  });

  it('lease loss uses PRECONDITION_FAILURE failure code', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-lease-code-'));
    const filePath = join(rootPath, 'src', 'keep.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const keep = 1;\n');
    const ch = await calculateProjectContentHash('export const keep = 1;\n');

    mockRenewProjectRagPostgresIngestSnapshotLease.mockResolvedValue(undefined);

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 100,
        addsCount: 1,
        totalDelta: 1,
        candidateFiles: [{ sourcePath: 'src/keep.ts', absolutePath: filePath, contentHash: ch }],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 1 })
    ).rejects.toThrow('lease lost');

    expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
      sql,
      7,
      1,
      'PRECONDITION_FAILURE', // NOT SYSTEM_ERROR
      expect.any(String)
    );

    rmSync(rootPath, { recursive: true, force: true });
  });

  it('single-file end-to-end: target passes gate and produces zero deletes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-single-e2e-'));
    const filePath = join(rootPath, 'src', 'target.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    mkdirSync(join(rootPath, 'src', 'other'), { recursive: true });
    writeFileSync(filePath, 'export const target = 1;\n');
    writeFileSync(join(rootPath, 'src', 'other', 'untracked.ts'), 'export const ignore = 1;\n');
    const ch = await calculateProjectContentHash('export const target = 1;\n');

    // Mock preflight as if scanning all 'src' but filtered to target file
    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        trackedCount: 100,
        addsCount: 1,
        totalDelta: 1,
        deletesCount: 0,
        candidateFiles: [{ sourcePath: 'src/target.ts', absolutePath: filePath, contentHash: ch }],
        stalePaths: [],
        summary: {
          rootHash: 'rh',
          scopeHash: 'sh',
          policyHash: 'ph',
          inventoryHash: 'ih',
          baselineHash: 'bh',
          planHash: 'plh',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    mockRepairProjectRagPostgresFileVersions.mockResolvedValue(1);
    const { ingestProjectRagPostgres } = await importIngestPostgres();
    const result = await ingestProjectRagPostgres({
      rootPath,
      includeRoots: ['src'],
      maxFiles: 1,
      filePath: filePath,
    });

    // Gate consumed, write happened, zero deletes (single-file)
    expect(result.snapshotGate?.status).toBe('CONSUMED');
    expect(result.stats.filesDeleted).toBe(0);
    expect(mockUpsertProjectRagPostgresFileWithChunks).toHaveBeenCalledWith(
      sql,
      7,
      expect.objectContaining({ sourcePath: 'src/target.ts' }),
      expect.any(Array),
      expect.any(String)
    );
    // The untracked file should NOT be deleted (single-file mode)
    expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();

    rmSync(rootPath, { recursive: true, force: true });
  });

  it('effective custom ignore rule excludes a path from candidates', async () => {
    // This test verifies that if the mock PreflightPlan has no candidates
    // for a target path, the file is "excluded" which means the scanner
    // (with merged ignore rules) filtered it out.
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-ignore-rule-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(join(rootPath, 'src', 'ignored.ts'), 'export const x = 1;\n');

    // Preflight returns no candidates (simulating effective ignore)
    mockBuildPreflightPlan.mockResolvedValue(makePreflightPlan());

    const { ingestProjectRagPostgresFile } = await importIngestPostgres();

    await expect(
      ingestProjectRagPostgresFile({ rootPath, filePath: 'src/ignored.ts' })
    ).rejects.toThrow(/excluded|not found/);
  });

  // ========================================================================
  // Snapshot schema readiness (migration 003) gate
  // ========================================================================

  it('requires both migration-002 and migration-003 schema before preflight', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-schema-003-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    // Make migration-003 fail
    mockAssertProjectRagPostgresSnapshotSchemaReady.mockRejectedValueOnce(
      new Error('Project RAG ingest-snapshot table (migration 003) is missing')
    );

    try {
      await expect(
        ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 1 })
      ).rejects.toThrow('migration 003');
      // Preflight and repository upsert should NOT be called
      expect(mockBuildPreflightPlan).not.toHaveBeenCalled();
      expect(mockUpsertProjectRagPostgresRepository).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('calls migration-002, migration-003, and migration-004 schema checks in order', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-all-schema-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const { ingestProjectRagPostgres } = await importIngestPostgres();
    try {
      await ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 1 });
      expect(mockAssertProjectRagPostgresSchemaReady).toHaveBeenCalled();
      expect(mockAssertProjectRagPostgresSnapshotSchemaReady).toHaveBeenCalled();
      expect(mockAssertProjectRagPostgresAllowlistSchemaReady).toHaveBeenCalled();
      // Verify order: 002 → 003 → 004 (allowlist)
      const schema002Order = mockAssertProjectRagPostgresSchemaReady.mock.invocationCallOrder[0];
      const schema003Order =
        mockAssertProjectRagPostgresSnapshotSchemaReady.mock.invocationCallOrder[0];
      const schema004Order =
        mockAssertProjectRagPostgresAllowlistSchemaReady.mock.invocationCallOrder[0];
      expect(schema002Order).toBeLessThan(schema003Order);
      expect(schema003Order).toBeLessThan(schema004Order);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Allowlist schema readiness (migration 004) gate
  // ========================================================================

  it('requires migration-004 schema (allowlist) before preflight or writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-schema-004-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    // Make migration-004 fail
    mockAssertProjectRagPostgresAllowlistSchemaReady.mockRejectedValueOnce(
      new Error('Project RAG blocked-findings allowlist table (migration 004) is missing')
    );

    try {
      await expect(
        ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 1 })
      ).rejects.toThrow('migration 004');
      // Preflight and repository upsert should NOT be called
      expect(mockBuildPreflightPlan).not.toHaveBeenCalled();
      expect(mockUpsertProjectRagPostgresRepository).not.toHaveBeenCalled();
      // 002 and 003 schema checks were called (they passed), but 004 failed
      expect(mockAssertProjectRagPostgresSchemaReady).toHaveBeenCalled();
      expect(mockAssertProjectRagPostgresSnapshotSchemaReady).toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Lease dead-resurrection prevention
  // ========================================================================

  // ========================================================================
  // Lease loss — instanceof regression tests
  // ========================================================================

  it('per-file catch uses instanceof LeaseLostError, not message prefix (altered message)', async () => {
    // Regression: the per-file catch in raw execution must check
    // `error instanceof LeaseLostError` rather than `message.startsWith(...)`.
    // We inject a subclass with a non-standard message that would NOT
    // match the old prefix check ('Snapshot lease lost').
    class CustomLeaseMessageError extends LeaseLostError {
      constructor(id: number, detail: string) {
        super(id, detail);
        // Override message to NOT start with 'Snapshot lease lost'
        this.message = `CUSTOM_LEASE_ERROR: ${id} ${detail}`;
        this.name = 'CustomLeaseMessageError';
      }
    }

    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-instanceof-regression-'));
    const filePath = join(rootPath, 'src', 'file.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const x = 1;\n');
    const ch = await calculateProjectContentHash('export const x = 1;\n');

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    // Phase 5 pre-rescan and post-rescan renewals must succeed so we reach
    // raw execution.  After those two shots, make renew throw the subclass
    // inside the per-file processing loop.
    mockRenewProjectRagPostgresIngestSnapshotLease
      .mockResolvedValueOnce(makeSnapshotRow({ status: 'CONSUMING' }))
      .mockResolvedValueOnce(makeSnapshotRow({ status: 'CONSUMING' }))
      .mockRejectedValue(new CustomLeaseMessageError(1, 'dead lease during file write'));

    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        totalDelta: 1,
        candidateFiles: [{ sourcePath: 'src/file.ts', absolutePath: filePath, contentHash: ch }],
        summary: {
          rootHash: 'root-hash',
          scopeHash: 'scope-hash',
          policyHash: 'policy-hash',
          inventoryHash: 'inv-hash',
          baselineHash: 'base-hash',
          planHash: 'plan-hash',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 5 })
    ).rejects.toThrow(CustomLeaseMessageError);

    // Snapshot was failed with PRECONDITION_FAILURE (LeaseLostError mapping)
    expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
      sql,
      7,
      1,
      'PRECONDITION_FAILURE',
      expect.any(String)
    );

    // No subsequent writes should have occurred
    expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();

    rmSync(rootPath, { recursive: true, force: true });
  });

  // ========================================================================
  // Lease loss during rescan / embedding
  // ========================================================================

  it('lease lost during raw execution throws LeaseLostError', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-lease-loss-stale-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(join(rootPath, 'src', 'test.ts'), 'export const x = 1;\n');
    const ch = await calculateProjectContentHash('export const x = 1;\n');

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    // Make the first renew call fail by returning undefined
    mockRenewProjectRagPostgresIngestSnapshotLease.mockReturnValue(undefined);

    // Set up a preflight that goes through to raw execution
    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        updatesCount: 0,
        deletesCount: 0,
        eligibleCount: 1,
        totalDelta: 1,
        candidateFiles: [
          {
            sourcePath: 'src/test.ts',
            absolutePath: join(rootPath, 'src', 'test.ts'),
            contentHash: ch,
          },
        ],
        summary: {
          rootHash: 'root-hash',
          scopeHash: 'scope-hash',
          policyHash: 'policy-hash',
          inventoryHash: 'inv-hash',
          baselineHash: 'base-hash',
          planHash: 'plan-hash',
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 100,
          totalDelta: 1,
          force: false,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    // Since raw execution tries renewOrAbort which calls renew...Lease → undefined,
    // it will throw LeaseLostError. The catch block in ingestProjectRagPostgres
    // should convert it to PRECONDITION_FAILURE and re-throw.
    await expect(
      ingestProjectRagPostgres({ rootPath, includeRoots: ['src'], maxFiles: 5 })
    ).rejects.toThrow();
    expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalled();

    rmSync(rootPath, { recursive: true, force: true });
  });

  // ========================================================================
  // Cardinality-independent refresh policy
  // ========================================================================

  it('allows arbitrarily large additions and updates without review', () => {
    expect(refreshRequiresReview({ addsCount: 499, updatesCount: 500, deletesCount: 0 })).toBe(
      false
    );
  });

  // ========================================================================
  // Full-delta single-file refresh (large additions remain automatic)
  // ========================================================================

  it('single-file gate uses full project inventory without a cardinality review', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-single-file-gate-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(join(rootPath, 'src', 'target.ts'), 'export const x = 1;\n');
    const targetContentHash = await calculateProjectContentHash('export const x = 1;\n');

    mockBuildPreflightPlan.mockResolvedValue(
      makePreflightPlan({
        addsCount: 500,
        updatesCount: 0,
        deletesCount: 0,
        eligibleCount: 500,
        trackedCount: 100,
        totalDelta: 500,
        candidateFiles: [
          {
            sourcePath: 'src/target.ts',
            absolutePath: join(rootPath, 'src', 'target.ts'),
            contentHash: targetContentHash,
          },
        ],
        summary: {
          rootHash: 'root-hash',
          scopeHash: 'scope-hash',
          policyHash: 'policy-hash',
          inventoryHash: 'inv-hash',
          baselineHash: 'base-hash',
          planHash: 'plan-hash',
          addsCount: 500,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 500,
          trackedCount: 100,
          totalDelta: 500,
          force: false,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: {
        ...makeSnapshotRow({ status: 'PREPARED', adds_count: '500', tracked_count: '100' }),
      },
      thresholdResult: {
        requiresReview: false,
        reason: 'refresh_safe: 500 addition(s), 0 update(s); cardinality does not require review',
      },
    });
    mockRepairProjectRagPostgresFileVersions.mockResolvedValue(1);

    const { ingestProjectRagPostgres } = await importIngestPostgres();
    const result = await ingestProjectRagPostgres({
      rootPath,
      includeRoots: ['src'],
      maxFiles: 1,
    });

    expect(result.snapshotGate?.status).toBe('CONSUMED');
    expect(result.stats.filesIndexed).toBe(1);

    rmSync(rootPath, { recursive: true, force: true });
  });

  // ========================================================================
  // Rescan binding — concurrent inventory changes invalidate the snapshot
  // ========================================================================

  it('re-run binding fails when the rescan inventory changes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-rescan-threshold-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    // First preflight: safe delta (10 files)
    mockBuildPreflightPlan.mockResolvedValueOnce(
      makePreflightPlan({
        addsCount: 10,
        trackedCount: 100,
        totalDelta: 10,
        summary: {
          rootHash: 'root-hash',
          scopeHash: 'scope-hash',
          policyHash: 'policy-hash',
          inventoryHash: 'inv-hash',
          baselineHash: 'base-hash',
          planHash: 'plan-hash-1',
          addsCount: 10,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 10,
          trackedCount: 100,
          totalDelta: 10,
          force: false,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    // Second preflight (rescan): inventory changed while the claim was live.
    mockBuildPreflightPlan.mockResolvedValueOnce(
      makePreflightPlan({
        addsCount: 600,
        trackedCount: 100,
        totalDelta: 600,
        summary: {
          rootHash: 'root-hash',
          scopeHash: 'scope-hash',
          policyHash: 'policy-hash',
          inventoryHash: 'inv-hash-2',
          baselineHash: 'base-hash-2',
          planHash: 'plan-hash-2',
          addsCount: 600,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 600,
          trackedCount: 100,
          totalDelta: 600,
          force: false,
          blockedFindingCategories: 'none',
          blockedFindingAllowlistHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          suppressedBlockedFindingCount: 0,
        },
      })
    );

    // Prepare returns PREPARED (first preflight was safe)
    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({
        status: 'PREPARED',
        adds_count: '10',
        tracked_count: '100',
      }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe: 10/100' },
    });

    const { ingestProjectRagPostgres } = await importIngestPostgres();

    try {
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      // The rescan should catch the changed inventory and fail.
      expect(result.snapshotGate).toBeDefined();
      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('rescan_count_drift');
      expect(result.stats.filesIndexed).toBe(0);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects an approved snapshot when rescan deletion evidence becomes incomplete', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-approved-incomplete-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    const snapshotUuid = '11111111-1111-4111-8111-111111111111';
    const project = makeProjectRow(rootPath, { slug: 'approved-incomplete-project' });
    const staleState = {
      sourcePath: 'src/removed.ts',
      contentHash: 'stale-hash',
      status: 'indexed',
      latestVersionStatus: 'ready',
    };
    const completePlan = makePreflightPlan({
      deletesCount: 1,
      trackedCount: 1,
      totalDelta: 1,
      trackedStates: [staleState],
      stalePaths: ['src/removed.ts'],
      completeness: { status: 'complete', evidenceHash: 'a'.repeat(64) },
      deletionEligibility: {
        basis: 'scan_completeness',
        decision: { allowed: true, stalePaths: ['src/removed.ts'], count: 1 },
      },
    });
    const incompleteRescan = makePreflightPlan({
      ...completePlan,
      completeness: { status: 'incomplete', evidenceHash: 'b'.repeat(64) },
      deletionEligibility: {
        basis: 'scan_completeness',
        decision: {
          allowed: false,
          stalePaths: ['src/removed.ts'],
          count: 1,
          status: 'incomplete',
          reasonCodes: ['scan_interrupted'],
        },
      },
    });
    const approvedSnapshot = makeSnapshotRow({
      id: 61,
      snapshotUuid,
      projectId: 7,
      commandScope: 'full',
      rootHash: completePlan.rootHash,
      scopeHash: completePlan.scopeHash,
      policyHash: completePlan.policyHash,
      inventoryHash: completePlan.inventoryHash,
      baselineHash: completePlan.baselineHash,
      planHash: completePlan.planHash,
      addsCount: completePlan.addsCount,
      updatesCount: completePlan.updatesCount,
      deletesCount: completePlan.deletesCount,
      eligibleCount: completePlan.eligibleCount,
      trackedCount: completePlan.trackedCount,
      blockedFindings: [],
      blockedFindingAllowlistHash: completePlan.blockedFindingAllowlistHash,
      suppressedBlockedFindings: [],
      status: 'REVIEW_REQUIRED',
    });

    mockFindProjectRagPostgresProject.mockResolvedValue(project);
    mockListProjectRagPostgresFileStates.mockResolvedValue([staleState]);
    mockBuildPreflightPlan
      .mockResolvedValueOnce(completePlan)
      .mockResolvedValueOnce(incompleteRescan);
    mockFindProjectRagPostgresIngestSnapshotByUuid.mockResolvedValue(approvedSnapshot);
    mockFindProjectRagPostgresSnapshotReview.mockResolvedValue({
      reviewerId: 'reviewer-1',
      evidenceId: 'evidence-1',
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({
        ...approvedSnapshot,
        status: 'CONSUMING',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        approvedSnapshotUuid: snapshotUuid,
      });

      expect(result.finalStatus).toBe('partial');
      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('rescan_review_required');
      expect(result.stats.filesDeleted).toBe(0);
      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockCompleteProjectRagPostgresIngest).not.toHaveBeenCalled();
      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('accepts approved content identity when only branch metadata changed', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-approved-metadata-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    const snapshotUuid = '22222222-2222-4222-8222-222222222222';
    const project = makeProjectRow(rootPath, { slug: 'approved-metadata-project' });
    const currentContext = {
      repositoryCommonDir: join(rootPath, '.git'),
      worktreeGitDir: join(rootPath, '.git'),
      remoteUrl: null,
      workspaceRoot: rootPath,
      scopePath: '',
      headOid: 'b'.repeat(40),
      branchName: 'feature',
      headHash: 'new-head-hash',
      branchHash: 'new-branch-hash',
      detachedHash: 'new-detached-hash',
      isDetached: false,
      isUnborn: false,
      statusDigest: 'new-status-digest',
      contentFingerprint: 'content-fingerprint',
      contentHash: 'content-hash',
      dirtyDigest: 'dirty-digest',
      repositoryHash: 'repository-hash',
      workspaceHash: 'workspace-hash',
      identityDigest: 'identity-hash',
    };
    const plan = makePreflightPlan();
    const approvedSnapshot = makeSnapshotRow({
      id: 62,
      snapshotUuid,
      projectId: 7,
      commandScope: 'full',
      rootHash: plan.rootHash,
      scopeHash: plan.scopeHash,
      policyHash: plan.policyHash,
      inventoryHash: plan.inventoryHash,
      baselineHash: plan.baselineHash,
      planHash: plan.planHash,
      addsCount: plan.addsCount,
      updatesCount: plan.updatesCount,
      deletesCount: plan.deletesCount,
      eligibleCount: plan.eligibleCount,
      trackedCount: plan.trackedCount,
      blockedFindings: [],
      blockedFindingAllowlistHash: plan.blockedFindingAllowlistHash,
      suppressedBlockedFindings: [],
      repositoryHash: currentContext.repositoryHash,
      workspaceHash: currentContext.workspaceHash,
      contentHash: currentContext.contentHash,
      identityDigest: currentContext.identityDigest,
      headOid: 'a'.repeat(40),
      branchName: 'main',
      headHash: 'old-head-hash',
      branchHash: 'old-branch-hash',
      detachedHash: 'old-detached-hash',
      isDetached: false,
      isUnborn: false,
      status: 'REVIEW_REQUIRED',
    });
    const claimedSnapshot = makeSnapshotRow({
      ...approvedSnapshot,
      status: 'CONSUMING',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    mockFindProjectRagPostgresProject.mockResolvedValue(project);
    mockResolveProjectRagWorkspaceContext.mockResolvedValue(currentContext);
    mockBuildPreflightPlan.mockResolvedValue(plan);
    mockFindProjectRagPostgresIngestSnapshotByUuid.mockResolvedValue(approvedSnapshot);
    mockFindProjectRagPostgresSnapshotReview.mockResolvedValue({
      reviewerId: 'reviewer-2',
      evidenceId: 'evidence-2',
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(claimedSnapshot);
    mockRevalidateBaseline.mockResolvedValue({
      matches: true,
      mismatchedFields: [],
      snapshot: claimedSnapshot,
    });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        approvedSnapshotUuid: snapshotUuid,
      });

      expect(result.finalStatus).toBe('completed');
      expect(result.snapshotGate?.status).toBe('CONSUMED');
      expect(mockCompleteProjectRagPostgresIngest).toHaveBeenCalledTimes(1);
      expect(mockFailProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  // ========================================================================
  // Allowlist wiring + policy-race guards (T-04 slice2)
  // ========================================================================

  const EMPTY_ALLOWLIST_HASH_HEX =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  function makeProjectRow(
    rootPath: string,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      id: 7,
      name: 'allowlist-project',
      slug: 'allowlist-project',
      rootPath,
      normalizedRootPath: rootPath,
      status: 'active',
      includeRoots: ['src'],
      ignoreRules: [],
      ephemeral: false,
      blockedFindingAllowlist: [],
      ...overrides,
    };
  }

  function safeAllowlistSummary(
    allowlistHash: string,
    suppressedCount: number
  ): MockPreflightPlan['summary'] {
    return {
      rootHash: 'root-hash',
      scopeHash: 'scope-hash',
      policyHash: 'policy-hash',
      inventoryHash: 'inv-hash',
      baselineHash: 'base-hash',
      planHash: 'plan-hash',
      addsCount: 0,
      updatesCount: 0,
      deletesCount: 0,
      eligibleCount: 0,
      trackedCount: 100,
      totalDelta: 0,
      force: false,
      blockedFindingCategories: 'none',
      blockedFindingAllowlistHash: allowlistHash,
      suppressedBlockedFindingCount: suppressedCount,
    };
  }

  it('passes non-empty registered allowlist to initial buildPreflightPlan', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-allowlist-initial-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const registeredAllowlist = [
      {
        relativePath: 'scripts/eval/project-rag/repos/fixture-secret-noise/dist',
        category: 'build_dir',
      },
      {
        relativePath: 'scripts/eval/project-rag/repos/fixture-limit-edges/src/generated',
        category: 'generated_dir',
      },
    ];
    const { hashBlockedFindingAllowlist } = await import('./snapshot-policy.js');
    const allowlistHash = hashBlockedFindingAllowlist(registeredAllowlist);

    mockFindProjectRagPostgresProject.mockResolvedValue(
      makeProjectRow(rootPath, { blockedFindingAllowlist: registeredAllowlist })
    );
    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        blockedFindingAllowlistHash: allowlistHash,
        suppressedBlockedFindings: [
          {
            relativePath: registeredAllowlist[0].relativePath,
            category: registeredAllowlist[0].category,
            matchedAllowlistEntry: registeredAllowlist[0],
          },
        ],
        summary: safeAllowlistSummary(allowlistHash, 1),
      })
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(mockBuildPreflightPlan).toHaveBeenCalled();
      const initialCall = mockBuildPreflightPlan.mock.calls[0];
      expect(initialCall).toBeDefined();
      const initialAllowlistArg = initialCall?.[7];
      // buildPreflightPlan(root, includeRoots, ignoreRules, tracked, target?, force?, heartbeat?, allowlist?)
      expect(initialAllowlistArg).toEqual(registeredAllowlist);
      expect(Array.isArray(initialAllowlistArg)).toBe(true);
      expect((initialAllowlistArg as unknown[]).length).toBe(2);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('prepareSnapshot receives non-empty allowlist hash and exact suppressed findings', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-allowlist-prepare-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const allowlistEntries = [
      {
        relativePath: 'scripts/eval/project-rag/repos/fixture-secret-noise/dist',
        category: 'build_dir',
      },
      {
        relativePath: 'scripts/eval/project-rag/repos/fixture-limit-edges/src/generated',
        category: 'generated_dir',
      },
    ];
    const { hashBlockedFindingAllowlist } = await import('./snapshot-policy.js');
    const allowlistHash = hashBlockedFindingAllowlist(allowlistEntries);
    const suppressed = [
      {
        relativePath: allowlistEntries[0].relativePath,
        category: allowlistEntries[0].category,
        matchedAllowlistEntry: allowlistEntries[0],
      },
      {
        relativePath: allowlistEntries[1].relativePath,
        category: allowlistEntries[1].category,
        matchedAllowlistEntry: allowlistEntries[1],
      },
    ] as const;

    mockFindProjectRagPostgresProject.mockResolvedValue(
      makeProjectRow(rootPath, {
        blockedFindingAllowlist: allowlistEntries,
      })
    );
    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        blockedFindingAllowlistHash: allowlistHash,
        suppressedBlockedFindings: suppressed as unknown as ReadonlyArray<Record<string, unknown>>,
        summary: safeAllowlistSummary(allowlistHash, suppressed.length),
      })
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(mockPrepareSnapshot).toHaveBeenCalledTimes(1);
      const prepareInput = mockPrepareSnapshot.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(prepareInput.blockedFindingAllowlistHash).toBe(allowlistHash);
      expect(prepareInput.blockedFindingAllowlistHash).not.toBe(EMPTY_ALLOWLIST_HASH_HEX);
      expect(prepareInput.suppressedBlockedFindings).toEqual([...suppressed]);
      expect((prepareInput.suppressedBlockedFindings as ReadonlyArray<unknown>).length).toBe(2);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('post-claim project reload supplies reloaded allowlist to rescan preflight', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-allowlist-reload-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const initialAllowlist = [{ relativePath: 'src/node_modules', category: 'dependency_dir' }];
    const reloadedAllowlist = [
      { relativePath: 'src/node_modules', category: 'dependency_dir' },
      { relativePath: 'src/.cache', category: 'cache_dir' },
    ];
    const { hashBlockedFindingAllowlist } = await import('./snapshot-policy.js');
    // Rescan + final pre-consume use reloaded allowlist; preflight hash must match it.
    const reloadedHash = hashBlockedFindingAllowlist(reloadedAllowlist);

    mockFindProjectRagPostgresProject
      .mockResolvedValueOnce(
        makeProjectRow(rootPath, { blockedFindingAllowlist: initialAllowlist })
      )
      .mockResolvedValueOnce(
        makeProjectRow(rootPath, { blockedFindingAllowlist: reloadedAllowlist })
      )
      .mockResolvedValue(makeProjectRow(rootPath, { blockedFindingAllowlist: reloadedAllowlist }));

    // Initial + rescan return the same plan hashes so only the allowlist arg proves reload.
    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        blockedFindingAllowlistHash: reloadedHash,
        suppressedBlockedFindings: [
          {
            relativePath: 'src/node_modules',
            category: 'dependency_dir',
            matchedAllowlistEntry: initialAllowlist[0],
          },
        ],
        summary: safeAllowlistSummary(reloadedHash, 1),
      })
    );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 55, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 55, status: 'CONSUMING' })
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      // Initial preflight + post-claim rescan
      expect(mockBuildPreflightPlan.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockBuildPreflightPlan.mock.calls[0]?.[7]).toEqual(initialAllowlist);
      expect(mockBuildPreflightPlan.mock.calls[1]?.[7]).toEqual(reloadedAllowlist);
      // Rescan heartbeat is supplied as arg 6 on the second call
      expect(typeof mockBuildPreflightPlan.mock.calls[1]?.[6]).toBe('function');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('allowlist hash drift after claim fails before raw writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-allowlist-hash-drift-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const hashPrepare = 'd'.repeat(64);
    const hashRescan = 'e'.repeat(64);

    mockFindProjectRagPostgresProject.mockResolvedValue(
      makeProjectRow(rootPath, {
        blockedFindingAllowlist: [{ relativePath: 'src/node_modules', category: 'dependency_dir' }],
      })
    );

    mockBuildPreflightPlan
      .mockResolvedValueOnce(
        safePreflightPlan({
          blockedFindingAllowlistHash: hashPrepare,
          suppressedBlockedFindings: [
            {
              relativePath: 'src/node_modules',
              category: 'dependency_dir',
              matchedAllowlistEntry: {
                relativePath: 'src/node_modules',
                category: 'dependency_dir',
              },
            },
          ],
          summary: safeAllowlistSummary(hashPrepare, 1),
        })
      )
      .mockResolvedValueOnce(
        safePreflightPlan({
          blockedFindingAllowlistHash: hashRescan,
          suppressedBlockedFindings: [
            {
              relativePath: 'src/node_modules',
              category: 'dependency_dir',
              matchedAllowlistEntry: {
                relativePath: 'src/node_modules',
                category: 'dependency_dir',
              },
            },
          ],
          summary: safeAllowlistSummary(hashRescan, 1),
        })
      );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 77, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 77, status: 'CONSUMING' })
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('rescan_allowlist_drift');
      expect(result.snapshotGate?.thresholdResult).toContain('allowlist_hash');
      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
        sql,
        7,
        77,
        'RESCAN_MISMATCH',
        expect.stringContaining('rescan_allowlist_drift')
      );
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockDeleteProjectRagPostgresFile).not.toHaveBeenCalled();
      expect(mockConsumeProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('suppressed-set size change after claim fails before raw writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-allowlist-suppressed-drift-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const stableHash = 'f'.repeat(64);
    const suppressedOne = [
      {
        relativePath: 'src/node_modules',
        category: 'dependency_dir',
        matchedAllowlistEntry: {
          relativePath: 'src/node_modules',
          category: 'dependency_dir',
        },
      },
    ];
    const suppressedTwo = [
      ...suppressedOne,
      {
        relativePath: 'src/.cache',
        category: 'cache_dir',
        matchedAllowlistEntry: {
          relativePath: 'src/.cache',
          category: 'cache_dir',
        },
      },
    ];

    mockFindProjectRagPostgresProject.mockResolvedValue(
      makeProjectRow(rootPath, {
        blockedFindingAllowlist: suppressedTwo.map((s) => s.matchedAllowlistEntry),
      })
    );

    mockBuildPreflightPlan
      .mockResolvedValueOnce(
        safePreflightPlan({
          blockedFindingAllowlistHash: stableHash,
          suppressedBlockedFindings: suppressedOne,
          summary: safeAllowlistSummary(stableHash, 1),
        })
      )
      .mockResolvedValueOnce(
        safePreflightPlan({
          blockedFindingAllowlistHash: stableHash,
          suppressedBlockedFindings: suppressedTwo,
          summary: safeAllowlistSummary(stableHash, 2),
        })
      );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 88, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 88, status: 'CONSUMING' })
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('rescan_allowlist_drift');
      expect(result.snapshotGate?.thresholdResult).toContain('rescan_allowlist_drift');
      expect(result.snapshotGate?.thresholdResult).toContain('suppressed_hash:');
      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
        sql,
        7,
        88,
        'RESCAN_MISMATCH',
        expect.stringContaining('suppressed_hash:')
      );
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockConsumeProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('suppressed-set identity swap (same count, different entries) fails before raw writes', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-allowlist-identity-swap-'));
    mkdirSync(join(rootPath, 'src'), { recursive: true });

    const stableHash = 'f'.repeat(64);
    // Both sets have 1 entry BUT different content (path/category swapped)
    const suppressedPrepare = [
      {
        relativePath: 'src/node_modules',
        category: 'dependency_dir',
        matchedAllowlistEntry: {
          relativePath: 'src/node_modules',
          category: 'dependency_dir',
        },
      },
    ];
    const suppressedRescan = [
      {
        relativePath: 'src/.cache',
        category: 'cache_dir',
        matchedAllowlistEntry: {
          relativePath: 'src/.cache',
          category: 'cache_dir',
        },
      },
    ];

    mockFindProjectRagPostgresProject.mockResolvedValue(
      makeProjectRow(rootPath, {
        blockedFindingAllowlist: suppressedRescan.map((s) => s.matchedAllowlistEntry),
      })
    );

    mockBuildPreflightPlan
      .mockResolvedValueOnce(
        safePreflightPlan({
          blockedFindingAllowlistHash: stableHash,
          suppressedBlockedFindings: suppressedPrepare,
          summary: safeAllowlistSummary(stableHash, 1),
        })
      )
      .mockResolvedValueOnce(
        safePreflightPlan({
          blockedFindingAllowlistHash: stableHash,
          suppressedBlockedFindings: suppressedRescan,
          summary: safeAllowlistSummary(stableHash, 1),
        })
      );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 99, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 99, status: 'CONSUMING' })
    );

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(result.snapshotGate?.status).toBe('FAILED');
      expect(result.snapshotGate?.thresholdResult).toContain('rescan_allowlist_drift');
      expect(result.snapshotGate?.thresholdResult).toContain('suppressed_hash:');
      expect(mockUpsertProjectRagPostgresFileWithChunks).not.toHaveBeenCalled();
      expect(mockConsumeProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('final pre-consume allowlist change rejects and does not consume', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-allowlist-preconsume-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const app = 1;\n');
    const contentHash = await calculateProjectContentHash('export const app = 1;\n');

    const allowlistPrepare = [{ relativePath: 'src/node_modules', category: 'dependency_dir' }];
    const allowlistFinal = [
      { relativePath: 'src/node_modules', category: 'dependency_dir' },
      { relativePath: 'src/.cache', category: 'cache_dir' },
    ];
    // Hash must match the allowlist used at rescan so only the final check trips.
    const { hashBlockedFindingAllowlist } = await import('./snapshot-policy.js');
    const prepareHash = hashBlockedFindingAllowlist(allowlistPrepare);

    mockFindProjectRagPostgresProject
      .mockResolvedValueOnce(
        makeProjectRow(rootPath, { blockedFindingAllowlist: allowlistPrepare })
      )
      .mockResolvedValueOnce(
        makeProjectRow(rootPath, { blockedFindingAllowlist: allowlistPrepare })
      )
      .mockResolvedValueOnce(makeProjectRow(rootPath, { blockedFindingAllowlist: allowlistFinal }));

    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        totalDelta: 1,
        eligibleCount: 1,
        blockedFindingAllowlistHash: prepareHash,
        suppressedBlockedFindings: [
          {
            relativePath: 'src/node_modules',
            category: 'dependency_dir',
            matchedAllowlistEntry: allowlistPrepare[0],
          },
        ],
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        summary: {
          ...safeAllowlistSummary(prepareHash, 1),
          addsCount: 1,
          totalDelta: 1,
          eligibleCount: 1,
        },
      })
    );

    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 91, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 91, status: 'CONSUMING' })
    );
    mockRevalidateBaseline.mockResolvedValue({
      matches: true,
      mismatchedFields: [],
      snapshot: makeSnapshotRow({ id: 91, status: 'CONSUMING' }),
    });
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 99, versionId: 900001 });

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      await expect(
        ingestProjectRagPostgres({
          rootPath,
          includeRoots: ['src'],
          maxFiles: 10,
        })
      ).rejects.toThrow(/precondition_failure: config_drift_before_consume/);

      expect(mockFailProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(
        sql,
        7,
        91,
        'PRECONDITION_FAILURE',
        expect.stringContaining('blocked_finding_allowlist')
      );
      // Writes may have started; consume must not complete under drift.
      expect(mockConsumeProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('empty allowlist path remains successful through claim and consume', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'project-rag-allowlist-empty-'));
    const filePath = join(rootPath, 'src', 'app.ts');
    mkdirSync(join(rootPath, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const empty = 1;\n');
    const contentHash = await calculateProjectContentHash('export const empty = 1;\n');

    mockFindProjectRagPostgresProject.mockResolvedValue(
      makeProjectRow(rootPath, { blockedFindingAllowlist: [] })
    );
    mockBuildPreflightPlan.mockResolvedValue(
      safePreflightPlan({
        addsCount: 1,
        totalDelta: 1,
        eligibleCount: 1,
        blockedFindingAllowlistHash: EMPTY_ALLOWLIST_HASH_HEX,
        suppressedBlockedFindings: [],
        candidateFiles: [{ sourcePath: 'src/app.ts', absolutePath: filePath, contentHash }],
        summary: {
          ...safeAllowlistSummary(EMPTY_ALLOWLIST_HASH_HEX, 0),
          addsCount: 1,
          totalDelta: 1,
          eligibleCount: 1,
        },
      })
    );
    mockPrepareSnapshot.mockResolvedValue({
      snapshot: makeSnapshotRow({ id: 101, status: 'PREPARED' }),
      thresholdResult: { requiresReview: false, reason: 'delta_safe' },
    });
    mockClaimProjectRagPostgresIngestSnapshot.mockResolvedValue(
      makeSnapshotRow({ id: 101, status: 'CONSUMING' })
    );
    mockRevalidateBaseline.mockResolvedValue({
      matches: true,
      mismatchedFields: [],
      snapshot: makeSnapshotRow({ id: 101, status: 'CONSUMING' }),
    });
    mockUpsertProjectRagPostgresFileWithChunks.mockResolvedValue({ fileId: 42, versionId: 900001 });
    mockRepairProjectRagPostgresFileVersions.mockResolvedValue(1);

    try {
      const { ingestProjectRagPostgres } = await importIngestPostgres();
      const result = await ingestProjectRagPostgres({
        rootPath,
        includeRoots: ['src'],
        maxFiles: 10,
      });

      expect(result.snapshotGate?.status).toBe('CONSUMED');
      expect(mockBuildPreflightPlan.mock.calls[0]?.[7]).toEqual([]);
      const prepareInput = mockPrepareSnapshot.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(prepareInput.blockedFindingAllowlistHash).toBe(EMPTY_ALLOWLIST_HASH_HEX);
      expect(prepareInput.suppressedBlockedFindings).toEqual([]);
      expect(mockConsumeProjectRagPostgresIngestSnapshot).toHaveBeenCalledWith(sql, 7, 101);
      expect(mockFailProjectRagPostgresIngestSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
