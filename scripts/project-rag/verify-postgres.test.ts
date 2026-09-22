import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  resolveProjectRagPostgresConfigWithLocalDefault: () => ({ database: { url: 'postgres://test' } }),
}));
vi.mock('./embeddings.js', () => ({
  fetchProjectRagPostgresEmbeddings: vi.fn(),
  resolveProjectRagPostgresEmbeddingConfig: () => ({ model: 'test-model' }),
}));
vi.mock('./context.js', () => ({
  resolveProjectRagWorkspaceContext: vi.fn(),
}));
vi.mock('./store.js', () => ({
  closeProjectRagPostgresSql: vi.fn(),
  createProjectRagPostgresSql: vi.fn(),
  findProjectRagPostgresProject: vi.fn(),
  getProjectRagPostgresInvariantReport: vi.fn(),
  getProjectRagPostgresProjectStats: vi.fn(),
  getProjectRagPostgresServingState: vi.fn(),
  searchProjectRagPostgresChunks: vi.fn(),
}));

import { resolveProjectRagWorkspaceContext } from './context.js';
import { fetchProjectRagPostgresEmbeddings } from './embeddings.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
  getProjectRagPostgresInvariantReport,
  getProjectRagPostgresProjectStats,
  getProjectRagPostgresServingState,
  searchProjectRagPostgresChunks,
} from './store.js';
import { parseVerifyProjectRagPostgresArgs, verifyProjectRagPostgres } from './verify-postgres.js';

const mockCreateSql = createProjectRagPostgresSql as ReturnType<typeof vi.fn>;
const mockCloseSql = closeProjectRagPostgresSql as ReturnType<typeof vi.fn>;
const mockFindProject = findProjectRagPostgresProject as ReturnType<typeof vi.fn>;
const mockGetStats = getProjectRagPostgresProjectStats as ReturnType<typeof vi.fn>;
const mockGetInvariantReport = getProjectRagPostgresInvariantReport as ReturnType<typeof vi.fn>;
const mockGetServingState = getProjectRagPostgresServingState as ReturnType<typeof vi.fn>;
const mockSearch = searchProjectRagPostgresChunks as ReturnType<typeof vi.fn>;
const mockFetchEmbeddings = fetchProjectRagPostgresEmbeddings as ReturnType<typeof vi.fn>;
const mockResolveWorkspace = resolveProjectRagWorkspaceContext as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

function configurePublishedProjectMocks(): void {
  mockCreateSql.mockReturnValue({});
  mockFindProject.mockResolvedValue({
    id: 7,
    slug: 'rag-v2',
    name: 'rag-v2',
    rootPath: process.cwd(),
    normalizedRootPath: process.cwd(),
    includeRoots: ['src'],
    ignoreRules: [],
  });
  mockResolveWorkspace.mockResolvedValue({ dirtyDigest: 'dirty', identityDigest: 'identity' });
  mockGetServingState.mockResolvedValue({
    status: 'serving',
    buildId: 88,
    revisionId: 21,
    publishedAt: '2026-07-11T00:00:00.000Z',
    fileCount: 1,
    versionCount: 1,
    dirtyDigest: 'dirty',
    provenance: { identityDigest: 'identity' },
  });
  mockGetStats.mockResolvedValue({
    fileCount: 1,
    indexedFileCount: 1,
    blockedFileCount: 0,
    chunkCount: 1,
    symbolCount: 0,
    edgeCount: 0,
    embedding1024Count: 1,
    syncRunCount: 1,
  });
  mockGetInvariantReport.mockResolvedValue({
    versionReadiness: {
      filesWithVersionMetadata: 1,
      filesWithActiveReadyVersion: 1,
      filesWithNonReadyActiveVersion: 0,
      filesPendingVersionBackfill: 0,
      filesUsingLegacyStatusRead: 0,
    },
    freshness: { status: 'fresh' },
    scopeCoverage: { status: 'covered' },
    embeddingCoverage: { status: 'covered' },
    ownershipCoverage: { status: 'covered' },
    lastSyncAt: '2026-07-11T00:00:00.000Z',
  });
}

describe('project-rag postgres verify cli', () => {
  it('parses project, query, and bounded limit', () => {
    const args = parseVerifyProjectRagPostgresArgs([
      '--project',
      'rag-v2',
      '--query=postgres search',
      '--limit=100',
    ]);

    expect(args).toEqual({
      project: 'rag-v2',
      query: 'postgres search',
      limit: 10,
    });
  });

  it('defaults to a slug derived from the current project root', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/example-project');

    try {
      expect(parseVerifyProjectRagPostgresArgs([]).project).toBe('example-project');
    } finally {
      cwd.mockRestore();
    }
  });

  it('rejects a pre-aborted signal before opening the shared pool or reading context', async () => {
    const controller = new AbortController();
    controller.abort(new Error('verification cancelled'));

    await expect(
      verifyProjectRagPostgres({
        project: 'rag-v2',
        query: 'project rag postgres search',
        limit: 3,
        signal: controller.signal,
      })
    ).rejects.toThrow('verification cancelled');

    expect(mockCreateSql).not.toHaveBeenCalled();
    expect(mockFindProject).not.toHaveBeenCalled();
    expect(mockResolveWorkspace).not.toHaveBeenCalled();
  });

  it('passes cancellation to embeddings and never queries after the signal aborts', async () => {
    configurePublishedProjectMocks();
    const controller = new AbortController();
    let embeddingSignal: AbortSignal | undefined;
    mockFetchEmbeddings.mockImplementation(
      (_config: unknown, _texts: readonly string[], signal?: AbortSignal) => {
        embeddingSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('embedding request aborted'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason ?? new Error('embedding request aborted')),
            { once: true }
          );
        });
      }
    );

    const verification = verifyProjectRagPostgres({
      project: 'rag-v2',
      query: 'project rag postgres search',
      limit: 3,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(mockFetchEmbeddings).toHaveBeenCalledTimes(1));
    expect(embeddingSignal).toBe(controller.signal);
    controller.abort(new Error('verification cancelled'));

    await expect(verification).rejects.toThrow('verification cancelled');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('returns degraded status and invariant coverage when the report is not ready', async () => {
    mockCreateSql.mockReturnValue({});
    mockFindProject.mockResolvedValue({
      id: 7,
      slug: 'rag-v2',
      name: 'rag-v2',
      rootPath: process.cwd(),
      normalizedRootPath: process.cwd(),
      includeRoots: ['src'],
      ignoreRules: [],
    });
    mockResolveWorkspace.mockResolvedValue({ dirtyDigest: 'dirty', identityDigest: 'identity' });
    mockGetStats.mockResolvedValue({
      fileCount: 2,
      indexedFileCount: 2,
      blockedFileCount: 1,
      chunkCount: 2,
      symbolCount: 0,
      edgeCount: 0,
      embedding1024Count: 1,
      syncRunCount: 1,
    });
    mockGetServingState.mockResolvedValue({
      status: 'serving',
      buildId: 88,
      revisionId: 21,
      publishedAt: '2026-07-11T00:00:00.000Z',
      fileCount: 2,
      versionCount: 2,
      dirtyDigest: 'dirty',
      provenance: { identityDigest: 'identity' },
    });
    mockGetInvariantReport.mockResolvedValue({
      versionReadiness: {
        filesWithVersionMetadata: 2,
        filesWithActiveReadyVersion: 2,
        filesWithNonReadyActiveVersion: 0,
        filesPendingVersionBackfill: 0,
        filesUsingLegacyStatusRead: 0,
      },
      freshness: { status: 'fresh' },
      scopeCoverage: {
        status: 'covered',
        blockedExpectedFiles: 1,
        blockedExpectedPaths: ['src/blocked.ts'],
      },
      embeddingCoverage: {
        status: 'drift',
        chunkOwners: 2,
        missingOwners: 1,
        staleOwners: 0,
        modelMismatchOwners: 0,
        providerMismatchOwners: 0,
        dimensionMismatchOwners: 0,
        invalidVectorLengthOwners: 0,
        chunkVersionGaps: 0,
        embeddingVersionGaps: 0,
        embeddingVersionMismatchOwners: 0,
      },
      ownershipCoverage: { status: 'covered' },
      lastSyncAt: '2026-07-11T00:00:00.000Z',
    });
    mockFetchEmbeddings.mockResolvedValue([[0.1, 0.2]]);
    mockSearch.mockResolvedValue([]);

    const report = await verifyProjectRagPostgres({
      project: 'rag-v2',
      query: 'project rag postgres search',
      limit: 3,
    });

    expect(report.ok).toBe(false);
    expect(report.gateSignal).toEqual({
      ready: false,
      blockingFailureCode: 'PROJECT_INDEX_EMBEDDING_GAP',
    });
    expect(report.embeddingCoverage).toMatchObject({ status: 'drift', missingOwners: 1 });
    expect(report.ownershipCoverage).toMatchObject({ status: 'covered' });
    expect(report.blockedCoverage).toEqual({
      status: 'blocked',
      blockedFileCount: 1,
      blockedExpectedFiles: 1,
      blockedExpectedPaths: ['src/blocked.ts'],
    });
    expect(report.freshness).toMatchObject({ status: 'fresh' });
    expect(report.scopeCoverage).toMatchObject({ status: 'covered' });
    // The exported verifier borrows the cached pool and leaves lifecycle
    // ownership to its standalone CLI entrypoint.
    expect(mockCloseSql).not.toHaveBeenCalled();
  });

  it('reports unavailable serving without probing embeddings or search', async () => {
    mockCreateSql.mockReturnValue({});
    mockFindProject.mockResolvedValue({
      id: 7,
      slug: 'rag-v2',
      name: 'rag-v2',
      rootPath: process.cwd(),
      normalizedRootPath: process.cwd(),
      includeRoots: ['src'],
      ignoreRules: [],
    });
    mockResolveWorkspace.mockResolvedValue({ dirtyDigest: 'dirty', identityDigest: 'identity' });
    mockGetServingState.mockResolvedValue({
      status: 'unavailable',
      buildId: null,
      revisionId: null,
      publishedAt: null,
      fileCount: 0,
      versionCount: 0,
      dirtyDigest: null,
      provenance: {},
      reason: 'Project RAG has no published index build for project 7',
    });
    mockGetStats.mockResolvedValue({
      fileCount: 0,
      indexedFileCount: 0,
      blockedFileCount: 0,
      chunkCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      embedding1024Count: 0,
      syncRunCount: 0,
    });
    mockGetInvariantReport.mockResolvedValue({
      versionReadiness: {
        filesWithVersionMetadata: 0,
        filesWithActiveReadyVersion: 0,
        filesWithNonReadyActiveVersion: 0,
        filesPendingVersionBackfill: 0,
        filesUsingLegacyStatusRead: 0,
      },
      freshness: { status: 'unverified' },
      scopeCoverage: { status: 'unverified', blockedExpectedFiles: 0, blockedExpectedPaths: [] },
      embeddingCoverage: {
        status: 'covered',
        chunkOwners: 0,
        missingOwners: 0,
        staleOwners: 0,
        modelMismatchOwners: 0,
        providerMismatchOwners: 0,
        dimensionMismatchOwners: 0,
        invalidVectorLengthOwners: 0,
        chunkVersionGaps: 0,
        embeddingVersionGaps: 0,
        embeddingVersionMismatchOwners: 0,
      },
      ownershipCoverage: { status: 'covered' },
      lastSyncAt: null,
    });
    mockFetchEmbeddings.mockClear();
    mockSearch.mockClear();

    const report = await verifyProjectRagPostgres({
      project: 'rag-v2',
      query: 'project rag postgres search',
      limit: 3,
    });

    expect(report.ok).toBe(false);
    expect(report.serving.status).toBe('unavailable');
    expect(report.issues).toContain('no_published_build');
    expect(mockFetchEmbeddings).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
