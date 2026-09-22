import {
  DEFAULT_PROJECT_EMBEDDING_MODEL,
  DEFAULT_PROJECT_EMBEDDING_PROVIDER,
  PROJECT_EMBEDDING_DIMENSIONS,
} from './project-embedding-profiles.js';

export type ProjectInvariantCoverageStatus = 'covered' | 'drift' | 'unverified';

export type ProjectInvariantFreshnessStatus =
  | 'fresh'
  | 'fresh_with_metadata_drift'
  | 'stale'
  | 'missing'
  | 'unverified';

export type ProjectIndexGateFailureCode =
  | 'PROJECT_INDEX_EMPTY'
  | 'PROJECT_INDEX_STALE'
  | 'PROJECT_INDEX_UNVERIFIED'
  | 'PROJECT_INDEX_SCOPE_DRIFT'
  | 'PROJECT_INDEX_EMBEDDING_GAP';

export interface ProjectEmbeddingInvariantSummary {
  status: ProjectInvariantCoverageStatus;
  expectedModel: string;
  expectedProvider: string;
  expectedDimensions: number;
  chunkOwners: number;
  embeddingOwners: number;
  embeddingRecords: number;
  ownersWithValidEmbedding: number;
  missingOwners: number;
  staleOwners: number;
  modelMismatchOwners: number;
  providerMismatchOwners: number;
  dimensionMismatchOwners: number;
  invalidVectorLengthOwners: number;
  chunkVersionGaps: number;
  embeddingVersionGaps: number;
  embeddingVersionMismatchOwners: number;
  missingOwnerSample: string[];
  staleOwnerSample: string[];
  mismatchOwnerSample: string[];
  versionMismatchOwnerSample: string[];
  reason?: string;
}

export interface ProjectOwnershipInvariantSummary {
  status: ProjectInvariantCoverageStatus;
  chunkFileOrphans: number;
  symbolFileOrphans: number;
  symbolChunkOrphans: number;
  edgeMissingSourceFileRefs: number;
  edgeMissingTargetFileRefs: number;
  edgeMissingSourceSymbolRefs: number;
  edgeMissingTargetSymbolRefs: number;
  deletedFileChunkRefs: number;
  deletedFileSymbolRefs: number;
  deletedFileEdgeRefs: number;
  sampleRefs: string[];
  reason?: string;
}

export interface ProjectVersionReadinessInvariantSummary {
  filesWithVersionMetadata: number;
  filesWithActiveReadyVersion: number;
  filesWithNonReadyActiveVersion: number;
  filesPendingVersionBackfill: number;
  filesUsingLegacyStatusRead: number;
}

export interface ProjectInvariantEvaluationInput {
  fileCount: number;
  versionReadiness: ProjectVersionReadinessInvariantSummary;
  freshnessStatus: ProjectInvariantFreshnessStatus;
  /** Provenance between the current workspace and the serving index build. */
  contextStatus?: ProjectInvariantCoverageStatus;
  scopeCoverageStatus: ProjectInvariantCoverageStatus;
  embeddingCoverage: ProjectEmbeddingInvariantSummary;
  ownershipCoverage: ProjectOwnershipInvariantSummary;
}

export interface ProjectInvariantCheckResult {
  key: string;
  status: ProjectInvariantCoverageStatus;
  detail: string;
}

export interface ProjectInvariantEvaluationResult {
  gateSignal: {
    ready: boolean;
    blockingFailureCode: ProjectIndexGateFailureCode | null;
  };
  checks: ProjectInvariantCheckResult[];
  summary: {
    status: ProjectInvariantCoverageStatus;
    driftedChecks: number;
    unverifiedChecks: number;
  };
}

export function createUnverifiedEmbeddingInvariantSummary(
  reason: string
): ProjectEmbeddingInvariantSummary {
  return {
    status: 'unverified',
    expectedModel: DEFAULT_PROJECT_EMBEDDING_MODEL,
    expectedProvider: DEFAULT_PROJECT_EMBEDDING_PROVIDER,
    expectedDimensions: PROJECT_EMBEDDING_DIMENSIONS,
    chunkOwners: 0,
    embeddingOwners: 0,
    embeddingRecords: 0,
    ownersWithValidEmbedding: 0,
    missingOwners: 0,
    staleOwners: 0,
    modelMismatchOwners: 0,
    providerMismatchOwners: 0,
    dimensionMismatchOwners: 0,
    invalidVectorLengthOwners: 0,
    chunkVersionGaps: 0,
    embeddingVersionGaps: 0,
    embeddingVersionMismatchOwners: 0,
    missingOwnerSample: [],
    staleOwnerSample: [],
    mismatchOwnerSample: [],
    versionMismatchOwnerSample: [],
    reason,
  };
}

export function createUnverifiedOwnershipInvariantSummary(
  reason: string
): ProjectOwnershipInvariantSummary {
  return {
    status: 'unverified',
    chunkFileOrphans: 0,
    symbolFileOrphans: 0,
    symbolChunkOrphans: 0,
    edgeMissingSourceFileRefs: 0,
    edgeMissingTargetFileRefs: 0,
    edgeMissingSourceSymbolRefs: 0,
    edgeMissingTargetSymbolRefs: 0,
    deletedFileChunkRefs: 0,
    deletedFileSymbolRefs: 0,
    deletedFileEdgeRefs: 0,
    sampleRefs: [],
    reason,
  };
}

export function deriveProjectGateSignal(params: {
  fileCount: number;
  chunkOwners: number;
  freshnessStatus: ProjectInvariantFreshnessStatus;
  contextStatus?: ProjectInvariantCoverageStatus;
  scopeCoverageStatus: ProjectInvariantCoverageStatus;
  embeddingCoverageStatus: ProjectInvariantCoverageStatus;
  ownershipCoverageStatus: ProjectInvariantCoverageStatus;
  versionReadinessStatus: ProjectInvariantCoverageStatus;
}): {
  ready: boolean;
  blockingFailureCode: ProjectIndexGateFailureCode | null;
} {
  if (params.fileCount <= 0 || params.chunkOwners <= 0) {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_EMPTY' };
  }
  if (params.freshnessStatus === 'stale' || params.freshnessStatus === 'missing') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_STALE' };
  }
  if (params.freshnessStatus === 'unverified') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_UNVERIFIED' };
  }
  if (params.contextStatus === 'drift') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_STALE' };
  }
  if (params.contextStatus === 'unverified') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_UNVERIFIED' };
  }
  if (params.scopeCoverageStatus === 'drift') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_SCOPE_DRIFT' };
  }
  if (params.scopeCoverageStatus === 'unverified') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_UNVERIFIED' };
  }
  if (params.embeddingCoverageStatus === 'drift') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_EMBEDDING_GAP' };
  }
  if (params.embeddingCoverageStatus === 'unverified') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_UNVERIFIED' };
  }
  if (params.ownershipCoverageStatus === 'drift') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_SCOPE_DRIFT' };
  }
  if (params.ownershipCoverageStatus === 'unverified') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_UNVERIFIED' };
  }
  if (params.versionReadinessStatus === 'drift' || params.versionReadinessStatus === 'unverified') {
    return { ready: false, blockingFailureCode: 'PROJECT_INDEX_UNVERIFIED' };
  }
  return { ready: true, blockingFailureCode: null };
}

function getVersionReadinessStatus(
  versionReadiness: ProjectVersionReadinessInvariantSummary
): ProjectInvariantCoverageStatus {
  return versionReadiness.filesWithNonReadyActiveVersion > 0 ||
    versionReadiness.filesPendingVersionBackfill > 0 ||
    versionReadiness.filesUsingLegacyStatusRead > 0
    ? 'unverified'
    : 'covered';
}

export function evaluateProjectInvariants(
  input: ProjectInvariantEvaluationInput
): ProjectInvariantEvaluationResult {
  const versionReadinessStatus = getVersionReadinessStatus(input.versionReadiness);
  const checks: ProjectInvariantCheckResult[] = [
    {
      key: 'context_provenance',
      status: input.contextStatus ?? 'covered',
      detail:
        input.contextStatus === 'drift'
          ? 'The serving index identity differs from the current scoped workspace.'
          : input.contextStatus === 'unverified'
            ? 'The current scoped workspace identity could not be verified against the serving index.'
            : 'The serving index identity covers the current scoped workspace.',
    },
    {
      key: 'version_readiness',
      status: versionReadinessStatus,
      detail:
        versionReadinessStatus === 'covered'
          ? 'Indexed files have active ready version metadata.'
          : `nonReadyActive=${input.versionReadiness.filesWithNonReadyActiveVersion}, pendingBackfill=${input.versionReadiness.filesPendingVersionBackfill}, legacyStatusReads=${input.versionReadiness.filesUsingLegacyStatusRead}`,
    },
    {
      key: 'scope_coverage',
      status: input.scopeCoverageStatus,
      detail: 'Scope coverage compares includeRoots/ignore rules against indexed project files.',
    },
    {
      key: 'embedding_ownership',
      status: input.embeddingCoverage.status,
      detail:
        input.embeddingCoverage.status === 'covered'
          ? 'Chunk owners have matching embeddings with expected model/provider/dimensions.'
          : `missing=${input.embeddingCoverage.missingOwners}, stale=${input.embeddingCoverage.staleOwners}, modelMismatch=${input.embeddingCoverage.modelMismatchOwners}, providerMismatch=${input.embeddingCoverage.providerMismatchOwners}, dimensionMismatch=${input.embeddingCoverage.dimensionMismatchOwners}, invalidVectorLength=${input.embeddingCoverage.invalidVectorLengthOwners}, chunkVersionGaps=${input.embeddingCoverage.chunkVersionGaps}, embeddingVersionGaps=${input.embeddingCoverage.embeddingVersionGaps}, embeddingVersionMismatch=${input.embeddingCoverage.embeddingVersionMismatchOwners}`,
    },
    {
      key: 'graph_and_deleted_refs',
      status: input.ownershipCoverage.status,
      detail:
        input.ownershipCoverage.status === 'covered'
          ? 'Chunk/symbol/edge references are consistent and deleted-file leakage was not detected.'
          : `chunkFileOrphans=${input.ownershipCoverage.chunkFileOrphans}, symbolFileOrphans=${input.ownershipCoverage.symbolFileOrphans}, symbolChunkOrphans=${input.ownershipCoverage.symbolChunkOrphans}, missingEdgeFileRefs=${input.ownershipCoverage.edgeMissingSourceFileRefs + input.ownershipCoverage.edgeMissingTargetFileRefs}, missingEdgeSymbolRefs=${input.ownershipCoverage.edgeMissingSourceSymbolRefs + input.ownershipCoverage.edgeMissingTargetSymbolRefs}, deletedFileRefs=${input.ownershipCoverage.deletedFileChunkRefs + input.ownershipCoverage.deletedFileSymbolRefs + input.ownershipCoverage.deletedFileEdgeRefs}`,
    },
  ];

  const driftedChecks = checks.filter((check) => check.status === 'drift').length;
  const unverifiedChecks = checks.filter((check) => check.status === 'unverified').length;
  const summaryStatus: ProjectInvariantCoverageStatus =
    unverifiedChecks > 0 ? 'unverified' : driftedChecks > 0 ? 'drift' : 'covered';

  const gateSignal = deriveProjectGateSignal({
    fileCount: input.fileCount,
    chunkOwners: input.embeddingCoverage.chunkOwners,
    freshnessStatus: input.freshnessStatus,
    contextStatus: input.contextStatus,
    scopeCoverageStatus: input.scopeCoverageStatus,
    embeddingCoverageStatus: input.embeddingCoverage.status,
    ownershipCoverageStatus: input.ownershipCoverage.status,
    versionReadinessStatus,
  });

  return {
    gateSignal,
    checks,
    summary: {
      status: summaryStatus,
      driftedChecks,
      unverifiedChecks,
    },
  };
}
