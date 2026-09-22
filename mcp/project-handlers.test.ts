/**
 * @module mcp/project-handlers.test
 * @description Unit tests for Project RAG MCP handler functions.
 *
 * Test coverage:
 * - handleSearchProjectCode: search_project_code tool
 * - handleGetProjectFile: get_project_file tool
 * - handleGetProjectOutline: get_project_outline tool
 * - handleRegisterProject: register_project tool
 * - handleVerifyProjectIndex: verify_project_index tool
 * - handleFindProjectSymbol: find_project_symbol tool
 * - handleFindSymbolReferences: find_symbol_references tool
 * - handleGetProjectSkeleton: get_project_skeleton tool
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SCOPE_ACK_TOKEN } from '../lib/shared/project-scope-advisory.js';
import { PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH } from '../scripts/project-rag/embeddings.js';

// Mock the logger
vi.mock('../lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock the path validator - always return valid for tests
vi.mock('./lib/path-validator.js', () => ({
  validateProjectRootPath: vi.fn((path: string) => ({
    valid: true,
    resolvedPath: path,
  })),
}));

vi.mock('../lib/shared/project-include-roots.js', () => ({
  validateProjectIncludeRoots: vi.fn((_: string, includeRoots: string[]) => ({
    valid: true,
    includeRoots,
  })),
  buildProjectIncludeGlobPatterns: vi.fn((includeRoots: string[], fileGlob: string) =>
    includeRoots.map((includeRoot) => `${includeRoot}/${fileGlob}`)
  ),
  buildProjectIgnoreGlobPatterns: vi.fn((ignoreRules?: string[]) => ignoreRules ?? []),
}));

vi.mock('../scripts/project-rag/store.js', () => ({
  assertProjectRagPostgresAllowlistSchemaReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../scripts/project-rag/project-inventory.js', () => ({
  validateAllowlistAgainstRoot: vi.fn(),
}));

vi.mock('../scripts/project-rag/context.js', () => ({
  resolveProjectRagWorkspaceContext: vi.fn(async (rootPath: string) => ({
    repositoryCommonDir: `${rootPath}/.git`,
    worktreeGitDir: `${rootPath}/.git`,
    repositoryHash: 'a'.repeat(64),
    workspaceHash: 'b'.repeat(64),
    scopePath: '',
    remoteUrl: null,
    workspaceRoot: rootPath,
    headOid: 'a'.repeat(40),
    headHash: 'c'.repeat(64),
    branchName: 'main',
    branchHash: 'd'.repeat(64),
    isDetached: false,
    detachedHash: 'e'.repeat(64),
    statusDigest: 'f'.repeat(64),
    contentFingerprint: '1'.repeat(64),
    contentHash: '1'.repeat(64),
    dirtyDigest: 'b'.repeat(64),
    identityDigest: '2'.repeat(64),
    isUnborn: false,
  })),
}));

const postgresStoreMocks = {
  sql: { close: vi.fn().mockResolvedValue(undefined) },
  resolveConfig: vi.fn(() => ({
    tool: 'project-rag-postgres' as const,
    healthTimeoutMs: 5_000,
    database: { url: 'postgres://test' },
    pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
  })),
  resolveWriteConfig: vi.fn(() => ({
    tool: 'project-rag-postgres' as const,
    healthTimeoutMs: 5_000,
    database: {
      url: 'postgres://postgres:secret@127.0.0.1:5440/rag_engine',
      redactedUrl: 'postgres://postgres:***@127.0.0.1:5440/rag_engine',
      source: 'PROJECT_RAG_DATABASE_URL',
    },
    pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
  })),
  createSql: vi.fn(),
  resolveEmbeddingConfig: vi.fn(() => ({
    provider: 'llamacpp' as const,
    model: 'qwen3-embedding-1024',
    baseUrl: 'http://127.0.0.1:8082',
    dimensions: 1024 as const,
    timeoutMs: 60_000,
    profileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
  })),
  fetchEmbeddings: vi.fn().mockResolvedValue([Array.from({ length: 1024 }, () => 0.1)]),
  findProject: vi.fn(),
  getStats: vi.fn(),
  getPublishedBuildState: vi.fn().mockResolvedValue({ buildId: 1, dirtyDigest: 'b'.repeat(64) }),
  getServingState: vi.fn().mockResolvedValue({
    status: 'serving',
    buildId: 1,
    revisionId: null,
    publishedAt: null,
    fileCount: 1,
    versionCount: 1,
    dirtyDigest: 'b'.repeat(64),
    provenance: {},
  }),
  getInvariantReport: vi.fn(),
  searchChunks: vi.fn(),
  getFileWithChunks: vi.fn(),
  getFileOutline: vi.fn(),
  findSymbols: vi.fn(),
  getNavigationPaths: vi.fn(),
  getSemanticClusters: vi.fn(),
  getFeatureHubs: vi.fn(),
  getTopicGroups: vi.fn(),
  upsertRepository: vi.fn(),
  upsertWorkspaceContext: vi.fn(),
  upsertWorkspaceAlias: vi.fn(),
};

const prepareProjectMock = vi.hoisted(() => vi.fn());
vi.mock('../scripts/project-rag/prepare.js', () => ({
  prepareProject: prepareProjectMock,
}));

import { validateProjectIncludeRoots } from '../lib/shared/project-include-roots.js';
// Import the mock for resetting in tests
import { validateProjectRootPath } from './lib/path-validator.js';
// Import after mocks are set up
import {
  handleFindProjectSymbol,
  handleFindSymbolReferences,
  handleGetFeatureHubs,
  handleGetNavigationPaths,
  handleGetProjectFile,
  handleGetProjectOutline,
  handleGetProjectSkeleton,
  handleGetSemanticClusters,
  handleGetTopicGroups,
  handlePrepareProject,
  handleRegisterProject,
  handleSearchProjectCode,
  handleVerifyProjectIndex,
  setProjectRagPostgresRuntimeModulesForTesting,
} from './project-handlers.js';

type MockLikeFunction = ((...args: any[]) => any) & {
  mockClear: () => any;
  mockReset: () => any;
  mockReturnValueOnce: (value: any) => any;
  mockRejectedValueOnce: (reason: unknown) => any;
  mockResolvedValueOnce: (value: unknown) => any;
  mockImplementation: (implementation: (...args: any[]) => any) => any;
  mockImplementationOnce: (implementation: (...args: any[]) => any) => any;
};

type TestDoc<Table extends string> = {
  _id?: `${Table}_${string}` | string;
  _creationTime?: number;
} & Record<string, unknown>;

const toMock = <T extends (...args: any[]) => any>(fn: T): MockLikeFunction =>
  fn as unknown as MockLikeFunction;

const mockedValidateProjectRootPath = toMock(validateProjectRootPath);
const mockedValidateProjectIncludeRoots = toMock(validateProjectIncludeRoots);

describe('Project Handlers', () => {
  beforeAll(() => {
    setProjectRagPostgresRuntimeModulesForTesting({
      config: {
        resolveProjectRagPostgresConfigWithLocalDefault: postgresStoreMocks.resolveConfig,
        resolveProjectRagPostgresWriteConfig: postgresStoreMocks.resolveWriteConfig,
      },
      embeddings: {
        resolveProjectRagPostgresEmbeddingConfig: postgresStoreMocks.resolveEmbeddingConfig,
        fetchProjectRagPostgresEmbeddings: postgresStoreMocks.fetchEmbeddings,
      },
      store: {
        createProjectRagPostgresSql: postgresStoreMocks.createSql,
        findProjectRagPostgresProject: postgresStoreMocks.findProject,
        getProjectRagPostgresProjectStats: postgresStoreMocks.getStats,
        getProjectRagPostgresPublishedBuildState: postgresStoreMocks.getPublishedBuildState,
        getProjectRagPostgresServingState: postgresStoreMocks.getServingState,
        getProjectRagPostgresInvariantReport: postgresStoreMocks.getInvariantReport,
        searchProjectRagPostgresChunks: postgresStoreMocks.searchChunks,
        getProjectRagPostgresFileWithChunks: postgresStoreMocks.getFileWithChunks,
        getProjectRagPostgresFileOutline: postgresStoreMocks.getFileOutline,
        findProjectRagPostgresSymbols: postgresStoreMocks.findSymbols,
        getProjectRagPostgresNavigationPaths: postgresStoreMocks.getNavigationPaths,
        getProjectRagPostgresSemanticClusters: postgresStoreMocks.getSemanticClusters,
        getProjectRagPostgresFeatureHubs: postgresStoreMocks.getFeatureHubs,
        getProjectRagPostgresTopicGroups: postgresStoreMocks.getTopicGroups,
        upsertProjectRagPostgresRepository: postgresStoreMocks.upsertRepository,
        upsertProjectRagWorkspaceContext: postgresStoreMocks.upsertWorkspaceContext,
        upsertProjectRagWorkspaceAlias: postgresStoreMocks.upsertWorkspaceAlias,
      },
    });
  });

  afterAll(() => {
    setProjectRagPostgresRuntimeModulesForTesting(null);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prepareProjectMock.mockResolvedValue({
      status: 'ready',
      ready: true,
      operation: { id: 'prepare-1', deduplicated: false },
      stage: 'ready',
      project: {
        slug: 'fixture-project',
        name: 'Fixture Project',
        rootPath: '/workspace/fixture-project',
        includeRoots: ['src'],
        existing: true,
      },
      progress: {
        batch: 0,
        maxBatches: 32,
        indexed: 0,
        selected: 0,
        scanned: 0,
        deleted: 0,
        embeddings: 0,
        errors: 0,
        remaining: 0,
        elapsedMs: 1,
      },
    });
    postgresStoreMocks.resolveConfig.mockReturnValue({
      tool: 'project-rag-postgres',
      healthTimeoutMs: 5_000,
      database: { url: 'postgres://test' },
      pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
    });
    postgresStoreMocks.resolveWriteConfig.mockReturnValue({
      tool: 'project-rag-postgres',
      healthTimeoutMs: 5_000,
      database: {
        url: 'postgres://postgres:secret@127.0.0.1:5440/rag_engine',
        redactedUrl: 'postgres://postgres:***@127.0.0.1:5440/rag_engine',
        source: 'PROJECT_RAG_DATABASE_URL',
      },
      pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
    });
    postgresStoreMocks.createSql.mockReturnValue(postgresStoreMocks.sql);
    postgresStoreMocks.resolveEmbeddingConfig.mockReturnValue({
      provider: 'llamacpp',
      model: 'qwen3-embedding-1024',
      baseUrl: 'http://127.0.0.1:8082',
      dimensions: 1024,
      timeoutMs: 60_000,
      profileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
    });
    postgresStoreMocks.fetchEmbeddings.mockReset();
    postgresStoreMocks.fetchEmbeddings.mockResolvedValue([Array.from({ length: 1024 }, () => 0.1)]);
    postgresStoreMocks.findProject.mockReset();
    postgresStoreMocks.getStats.mockReset();
    postgresStoreMocks.getServingState.mockReset();
    postgresStoreMocks.getServingState.mockResolvedValue({
      status: 'serving',
      buildId: 1,
      revisionId: null,
      publishedAt: null,
      fileCount: 1,
      versionCount: 1,
      dirtyDigest: 'b'.repeat(64),
      provenance: { identityDigest: '2'.repeat(64) },
    });
    postgresStoreMocks.getInvariantReport.mockReset();
    postgresStoreMocks.searchChunks.mockReset();
    postgresStoreMocks.getFileWithChunks.mockReset();
    postgresStoreMocks.getFileOutline.mockReset();
    postgresStoreMocks.findSymbols.mockReset();
    postgresStoreMocks.upsertRepository.mockReset();
    postgresStoreMocks.upsertRepository.mockResolvedValue(42);
    postgresStoreMocks.upsertWorkspaceContext.mockReset();
    postgresStoreMocks.upsertWorkspaceContext.mockResolvedValue({ workspaceId: 9 });
    postgresStoreMocks.upsertWorkspaceAlias.mockReset();
    postgresStoreMocks.upsertWorkspaceAlias.mockResolvedValue(undefined);
    postgresStoreMocks.sql.close.mockReset();
    postgresStoreMocks.sql.close.mockResolvedValue(undefined);
    process.env.PROJECT_RAG_BACKEND = 'legacy-backend';
  });

  describe('handleSearchProjectCode', () => {
    const mockProject = { id: 7 };
    const mockSearchResults = [
      {
        sourcePath: 'src/auth.ts',
        startLine: 10,
        endLine: 15,
        content: 'function authenticateUser() { }',
        score: 0.95,
        symbolName: 'authenticateUser',
        symbolKind: 'function',
      },
      {
        sourcePath: 'src/middleware.ts',
        startLine: 25,
        endLine: 30,
        content: 'export function authMiddleware() { }',
        score: 0.87,
        symbolName: 'authMiddleware',
        symbolKind: 'function',
      },
    ];

    it('returns formatted search results', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce(mockSearchResults);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'authentication',
        limit: 10,
      });

      expect(result.content[0].text).toContain('Found 2 results');
      expect(result.content[0].text).toContain('src/auth.ts');
      expect(result.content[0].text).toContain('**Score:** 0.950');
    });

    it('uses Postgres hybrid search even when backend env is legacy', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce([
        {
          sourcePath: 'mcp/project-handlers.ts',
          startLine: 10,
          endLine: 20,
          content: 'handleSearchProjectCode',
          score: 9.5,
          vectorScore: 0.8,
          symbolName: 'handleSearchProjectCode',
          symbolKind: 'function',
        },
      ]);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'postgres mcp search',
        limit: 3,
        includeDiagnostics: true,
      });

      expect(postgresStoreMocks.fetchEmbeddings).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'qwen3-embedding-1024' }),
        [
          'Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: postgres mcp search',
        ],
        undefined
      );
      expect(postgresStoreMocks.searchChunks).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        7,
        expect.objectContaining({
          query: 'postgres mcp search',
          embeddingModel: 'qwen3-embedding-1024',
          embeddingProvider: 'llamacpp',
          embeddingDimensions: 1024,
          embeddingProfileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
          limit: 3,
        })
      );
      expect(result.content[0].text).toContain('Found 1 results');
      expect(result.content[0].text).toContain('mcp/project-handlers.ts');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
      expect((result.structuredContent as any).data.mode).toBe('hybrid');
      expect((result.structuredContent as any).data.requestedMode).toBe('hybrid');
      expect((result.structuredContent as any).data.results[0].startLine).toBe(10);
      expect((result.structuredContent as any).data.embeddingConfig).toEqual({
        provider: 'llamacpp',
        model: 'qwen3-embedding-1024',
        baseUrl: 'http://127.0.0.1:8082',
        dimensions: 1024,
        profileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
      });
      expect((result.structuredContent as any).data.diagnostics.pipeline).toBe(
        'postgres_project_rag'
      );
    });

    it('binds search results to the serving build and excludes stale rows', async () => {
      const servingBuildId = 42;
      const currentResult = { ...mockSearchResults[0], sourcePath: 'src/current.ts' };
      const staleResult = { ...mockSearchResults[1], sourcePath: 'src/stale.ts' };
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getServingState.mockResolvedValueOnce({
        status: 'serving',
        buildId: servingBuildId,
        dirtyDigest: 'b'.repeat(64),
        provenance: { identityDigest: '2'.repeat(64) },
      });
      postgresStoreMocks.searchChunks.mockImplementation(async (_sql, _projectId, args) =>
        args.buildId === servingBuildId ? [currentResult] : [staleResult]
      );

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'authentication',
        limit: 1,
      });

      expect(postgresStoreMocks.searchChunks).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        7,
        expect.objectContaining({ buildId: servingBuildId, limit: 1 })
      );
      expect((result.structuredContent as any).data.results).toEqual([
        expect.objectContaining({ sourcePath: 'src/current.ts' }),
      ]);
    });

    it('returns a stale provenance error without embedding or querying old rows', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getServingState.mockResolvedValueOnce({
        status: 'serving',
        buildId: 42,
        dirtyDigest: 'c'.repeat(64),
        provenance: { identityDigest: '2'.repeat(64) },
      });

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'authentication',
      });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as any).error).toMatchObject({
        code: 'PROJECT_INDEX_STALE',
        action: 'prepare_project',
      });
      expect(postgresStoreMocks.fetchEmbeddings).not.toHaveBeenCalled();
      expect(postgresStoreMocks.searchChunks).not.toHaveBeenCalled();
    });

    it('does not search when no published build is serving', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getServingState.mockResolvedValueOnce({
        status: 'unavailable',
        buildId: null,
        dirtyDigest: null,
        reason: 'Project RAG has no published index build for project 7',
        provenance: {},
      });

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'authentication',
      });

      expect(postgresStoreMocks.searchChunks).not.toHaveBeenCalled();
      expect((result.structuredContent as any).error).toMatchObject({
        code: 'NOT_READY',
        message: 'Project RAG has no published index build for project 7',
      });
      expect(result.isError).toBe(true);
    });

    it('reports hybrid actual mode for a vector request', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce(mockSearchResults);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'semantic authentication flow',
        mode: 'vector',
      });

      expect((result.structuredContent as any).data.mode).toBe('hybrid');
      expect((result.structuredContent as any).data.requestedMode).toBe('vector');
      expect((result.structuredContent as any).data.warnings).toContain(
        'PROJECT_RAG_BACKEND=postgres uses hybrid vector+lexical search for vector requests.'
      );
    });

    it('handles empty results', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce([]);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'who calls nonexistent',
        limit: 10,
      });

      expect(result.content[0].text).toContain('No results found');
      expect((result.structuredContent as any).data.embeddingConfig).toMatchObject({
        provider: 'llamacpp',
        model: 'qwen3-embedding-1024',
        baseUrl: 'http://127.0.0.1:8082',
        dimensions: 1024,
      });
      expect((result.structuredContent as any).data.fallbackUsed).toBe(true);
      expect(postgresStoreMocks.searchChunks).toHaveBeenCalledTimes(2);
    });

    it('falls back to embedding-independent lexical search when embeddings are unavailable', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.fetchEmbeddings.mockRejectedValueOnce(
        new Error('embedding provider down')
      );
      postgresStoreMocks.searchChunks.mockResolvedValueOnce([mockSearchResults[0]]);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'authentication',
        includeDiagnostics: true,
      });

      expect(result.content[0].text).toContain('Found 1 results');
      expect((result.structuredContent as any).data.fallbackUsed).toBe(true);
      expect((result.structuredContent as any).data.embeddingConfig).toBeUndefined();
      expect((result.structuredContent as any).data.warnings).toContain(
        'Embedding retrieval was unavailable; used the embedding-independent lexical fallback.'
      );
      expect((result.structuredContent as any).data.diagnostics.lanes).toEqual([
        {
          lane: 'postgres_hybrid_search',
          status: 'skipped',
          candidateCount: 0,
          reason: 'embedding_unavailable',
        },
        {
          lane: 'postgres_lexical_fallback',
          status: 'executed',
          candidateCount: 1,
        },
      ]);
      expect(postgresStoreMocks.searchChunks).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        7,
        expect.objectContaining({
          queryEmbedding: Array.from({ length: 1024 }, () => 0),
          embeddingModel: '__mcp_lexical_fallback__',
          embeddingProvider: '__mcp_lexical_fallback__',
          embeddingDimensions: -1,
          embeddingProfileHash: '__mcp_lexical_fallback_profile__',
        })
      );
    });

    it('tries lexical fallback before returning an honest empty response', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([mockSearchResults[1]]);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'middleware',
        includeDiagnostics: true,
      });

      expect(result.content[0].text).toContain('Found 1 results');
      expect((result.structuredContent as any).data.results[0].sourcePath).toBe(
        'src/middleware.ts'
      );
      expect((result.structuredContent as any).data.fallbackUsed).toBe(true);
      expect((result.structuredContent as any).data.diagnostics.lanes).toEqual([
        {
          lane: 'postgres_hybrid_search',
          status: 'executed',
          candidateCount: 0,
          reason: 'hybrid_empty',
        },
        {
          lane: 'postgres_lexical_fallback',
          status: 'executed',
          candidateCount: 1,
        },
      ]);
      expect(postgresStoreMocks.searchChunks).toHaveBeenCalledTimes(2);
    });

    it('clamps limit to valid range', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce(mockSearchResults);

      await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'test',
        limit: 100,
      });

      expect(postgresStoreMocks.searchChunks).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        7,
        expect.objectContaining({ limit: 50 })
      );
    });

    it('accepts deprecated keyword mode with a warning and maps to hybrid', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce(mockSearchResults);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'test',
        mode: 'keyword',
      });

      expect((result as any).isError).toBeUndefined();
      expect((result as any).structuredContent).toMatchObject({
        success: true,
        data: {
          mode: 'hybrid',
          requestedMode: 'keyword',
        },
      });
      expect((result as any).structuredContent.data.warnings).toContain(
        'Keyword search mode is deprecated and has been mapped to hybrid vector+lexical search.'
      );
      expect(postgresStoreMocks.findProject).toHaveBeenCalled();
      expect(postgresStoreMocks.fetchEmbeddings).toHaveBeenCalled();
      expect(postgresStoreMocks.searchChunks).toHaveBeenCalled();
    });

    it('adds the deterministic warning without changing the backend path', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce(mockSearchResults);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'auth',
        deterministic: true,
        mode: 'hybrid',
      });

      expect((result.structuredContent as any).data.mode).toBe('hybrid');
      expect((result.structuredContent as any).data.fallbackUsed).toBe(false);
      expect((result.structuredContent as any).data.warnings).toContain(
        'Deterministic graph search is not available in the Postgres backend yet.'
      );
    });

    it('returns project not found when the Postgres project lookup misses', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);

      const result = await handleSearchProjectCode({
        projectId: 'missing-project',
        query: 'auth',
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('Project not found: missing-project');
    });

    it('returns an error when the Postgres search fails', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockRejectedValueOnce(new Error('Search failed'));

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'test',
        mode: 'hybrid',
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to search project code');
    });

    it('handles string errors', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockRejectedValueOnce('error string');

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'test',
        mode: 'hybrid',
      });

      expect((result as any).isError).toBe(true);
    });

    it('includes symbol info in results', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce(mockSearchResults);

      const result = await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'auth',
      });

      expect(result.content[0].text).toContain('**Symbol:** authenticateUser (function)');
    });

    it('does not close the SQL pool after a read operation', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks.mockResolvedValueOnce(mockSearchResults);

      await handleSearchProjectCode({
        projectId: 'project-123',
        query: 'auth',
      });

      // createSql was called exactly once (by withProjectRagPostgresConfig)
      expect(postgresStoreMocks.createSql).toHaveBeenCalledTimes(1);
      // sql.close must NOT be called – pool is shared across requests
      expect(postgresStoreMocks.sql.close).not.toHaveBeenCalled();
    });

    it('reuses the same SQL pool across two consecutive search calls', async () => {
      postgresStoreMocks.findProject
        .mockResolvedValueOnce(mockProject)
        .mockResolvedValueOnce(mockProject);
      postgresStoreMocks.searchChunks
        .mockResolvedValueOnce(mockSearchResults)
        .mockResolvedValueOnce(mockSearchResults.slice(0, 1));

      await handleSearchProjectCode({ projectId: 'project-123', query: 'auth' });
      await handleSearchProjectCode({ projectId: 'project-123', query: 'auth' });

      // createSql is called each time (once per withProjectRagPostgres call)
      // With the real createProjectRagPostgresSql this would return the same
      // cached pool; the key contract is that close is never called.
      expect(postgresStoreMocks.createSql).toHaveBeenCalledTimes(2);
      expect(postgresStoreMocks.sql.close).not.toHaveBeenCalled();
    });
  });

  describe('handleGetProjectFile', () => {
    const mockProject = {
      id: 7,
      rootPath: '/workspace/fixture-project',
      includeRoots: ['src'],
      ignoreRules: [],
    };
    const mockFile = {
      sourcePath: 'src/utils/helper.ts',
      status: 'indexed',
      lang: 'typescript',
      sizeBytes: 1024,
      updatedAt: 1710000000000,
    };

    const mockChunks = [
      {
        chunkIndex: 0,
        startLine: 1,
        endLine: 10,
        content: 'export function helper() { }',
        symbolName: 'helper',
        symbolKind: 'function',
      },
      {
        chunkIndex: 1,
        startLine: 12,
        endLine: 20,
        content: 'export const value = 42;',
        symbolName: 'value',
        symbolKind: 'const',
      },
    ] as TestDoc<'projectChunks'>[];

    it('returns file with chunks', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getFileWithChunks.mockResolvedValueOnce({
        file: mockFile,
        chunks: mockChunks,
        chunkCount: mockChunks.length,
      });

      const result = await handleGetProjectFile({
        projectId: 'project-123',
        sourcePath: 'src/utils/helper.ts',
      });

      expect(result.content[0].text).toContain('# src/utils/helper.ts');
      expect(result.content[0].text).toContain('**Status:** indexed');
      expect(result.content[0].text).toContain('### Chunk 0');
      expect(result.content[0].text).toContain('### Chunk 1');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
    });

    it('returns not found for missing file', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getFileWithChunks.mockResolvedValueOnce(null);

      const result = await handleGetProjectFile({
        projectId: 'project-123',
        sourcePath: 'nonexistent.ts',
      });

      expect(result.content[0].text).toContain('File not found');
    });

    it('returns project not found when registry lookup fails', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);

      const result = await handleGetProjectFile({
        projectId: 'project-123',
        sourcePath: 'src/utils/helper.ts',
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('Project not found');
    });

    it('handles query error', async () => {
      postgresStoreMocks.findProject.mockRejectedValueOnce(new Error('Query failed'));

      const result = await handleGetProjectFile({
        projectId: 'project-123',
        sourcePath: 'test.ts',
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to get project file');
    });

    it('handles string errors', async () => {
      postgresStoreMocks.findProject.mockRejectedValueOnce('error string');

      const result = await handleGetProjectFile({
        projectId: 'project-123',
        sourcePath: 'test.ts',
      });

      expect((result as any).isError).toBe(true);
    });

    it('uses Postgres store even when backend env is legacy', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getFileWithChunks.mockResolvedValueOnce({
        file: mockFile,
        chunks: [
          {
            chunkIndex: 0,
            startLine: 1,
            endLine: 10,
            content: 'export function helper() {}',
            symbolName: 'helper',
            symbolKind: 'function',
          },
        ],
        chunkCount: 1,
      });

      const result = await handleGetProjectFile({
        projectId: 'project-123',
        sourcePath: 'src/utils/helper.ts',
      });

      expect(result.content[0].text).toContain('# src/utils/helper.ts');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
      expect(postgresStoreMocks.findProject).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        'project-123'
      );
      // Pool is shared across requests – close is NOT called per request
      expect(postgresStoreMocks.sql.close).not.toHaveBeenCalled();
    });
  });

  describe('handleGetProjectOutline', () => {
    const mockProject = { id: 7 };
    const mockOutlineSymbols = [
      {
        name: 'Button',
        symbolType: 'class',
        startLine: 5,
        endLine: 50,
        signature: 'class Button extends React.Component',
      },
      {
        name: 'handleClick',
        symbolType: 'method',
        startLine: 10,
        endLine: 15,
        signature: 'handleClick()',
      },
    ];

    it('returns formatted symbols', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getFileOutline.mockResolvedValueOnce({
        sourcePath: 'src/components/Button.tsx',
        symbols: mockOutlineSymbols,
        symbolCount: mockOutlineSymbols.length,
      });

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'src/components/Button.tsx',
      });

      expect(result.content[0].text).toContain('# Outline: src/components/Button.tsx');
      expect(result.content[0].text).toContain('**Button** (class)');
      expect(result.content[0].text).toContain('**handleClick** (method)');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
    });

    it('binds the outline read to the serving build', async () => {
      const servingBuildId = 42;
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getServingState.mockResolvedValueOnce({
        status: 'serving',
        buildId: servingBuildId,
        dirtyDigest: 'c'.repeat(64),
        provenance: {},
      });
      postgresStoreMocks.getFileOutline.mockImplementation(async (_sql, _projectId, _path, args) =>
        args.buildId === servingBuildId
          ? {
              sourcePath: 'src/components/Button.tsx',
              symbols: mockOutlineSymbols,
              symbolCount: mockOutlineSymbols.length,
            }
          : null
      );

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'src/components/Button.tsx',
      });

      expect(postgresStoreMocks.getFileOutline).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        7,
        'src/components/Button.tsx',
        { buildId: servingBuildId }
      );
      expect(result.content[0].text).toContain('**Button** (class)');
    });

    it('does not read an outline when no published build is serving', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getServingState.mockResolvedValueOnce({
        status: 'unavailable',
        buildId: null,
        dirtyDigest: null,
        reason: 'Project RAG has no published index build for project 7',
        provenance: {},
      });

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'src/components/Button.tsx',
      });

      expect(postgresStoreMocks.getFileOutline).not.toHaveBeenCalled();
      expect((result.structuredContent as any).error).toMatchObject({
        code: 'NOT_READY',
        message: 'Project RAG has no published index build for project 7',
      });
      expect(result.isError).toBe(true);
    });

    it('preserves the Postgres outline symbol count', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getFileOutline.mockResolvedValueOnce({
        sourcePath: 'src/components/Button.tsx',
        symbols: [mockOutlineSymbols[0], mockOutlineSymbols[0], mockOutlineSymbols[1]],
        symbolCount: 3,
      });

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'src/components/Button.tsx',
      });

      expect(result.content[0].text).toContain('## Symbols (3)');
      expect((result.structuredContent as any).data.symbols).toHaveLength(3);
    });

    it('returns empty message when no symbols', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getFileOutline.mockResolvedValueOnce({
        sourcePath: 'empty.ts',
        symbols: [],
        symbolCount: 0,
      });

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'empty.ts',
      });

      expect(result.content[0].text).toContain('No symbols found');
    });

    it('returns not found for missing file', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getFileOutline.mockResolvedValueOnce(null);

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'nonexistent.ts',
      });

      expect(result.content[0].text).toContain('File not found');
    });

    it('returns project not found when the Postgres project lookup misses', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'test.ts',
      });

      expect(result.content[0].text).toContain('Project not found');
      expect((result as any).isError).toBe(true);
    });

    it('throws on store error', async () => {
      postgresStoreMocks.findProject.mockRejectedValueOnce(new Error('Query failed'));

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'test.ts',
      });

      expect((result as any).isError).toBe(true);
    });

    it('uses Postgres outline even when backend env is legacy', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getFileOutline.mockResolvedValueOnce({
        sourcePath: 'src/components/Button.tsx',
        symbols: [
          {
            name: 'Button',
            symbolType: 'function',
            startLine: 5,
            endLine: 12,
            signature: 'function Button()',
          },
        ],
        symbolCount: 1,
      });

      const result = await handleGetProjectOutline({
        projectId: 'project-123',
        sourcePath: 'src/components/Button.tsx',
      });

      expect(result.content[0].text).toContain('# Outline: src/components/Button.tsx');
      expect(result.content[0].text).toContain('**Button** (function)');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
    });
  });

  describe('handleRegisterProject', () => {
    it('returns success for new registration', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'New Project',
        rootPath: '/home/user/projects/new-project',
        includeRoots: ['src', 'packages/app'],
        gitRemote: 'https://github.com/user/new-project.git',
        defaultBranch: 'main',
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.content[0].text).toContain('"backend": "postgres"');
      expect(result.content[0].text).toContain('"projectId": "new-project"');
      expect(result.content[0].text).toContain('"slug": "new-project"');
      expect(result.content[0].text).toContain('"created": true');
      expect(result.content[0].text).toContain('"scopePreserved": false');
      expect((result.structuredContent as any).data.postgresId).toBe(42);
      expect(postgresStoreMocks.upsertWorkspaceContext).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.objectContaining({ workspaceRoot: '/home/user/projects/new-project' })
      );
      expect(postgresStoreMocks.upsertWorkspaceAlias).toHaveBeenCalledWith(postgresStoreMocks.sql, {
        workspaceId: 9,
        alias: 'new-project',
        legacyProjectId: 42,
      });
    });

    it('returns updated for existing project', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        rootPath: '/home/user/projects/existing',
        normalizedRootPath: '/home/user/projects/existing',
      });
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Existing Project',
        rootPath: '/home/user/projects/existing',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.content[0].text).toContain('"created": false');
      expect(result.content[0].text).toContain('"projectId": "existing-project"');
      // scopePreserved is false because the mock existing project has no includeRoots
      expect(result.content[0].text).toContain('"scopePreserved": false');
    });

    it('preserves existing includeRoots when project already exists', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        rootPath: '/home/user/projects/existing',
        normalizedRootPath: '/home/user/projects/existing',
        includeRoots: ['mcp', 'scripts', 'docs'],
        ignoreRules: ['*.generated.*'],
      });
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Existing Project',
        rootPath: '/home/user/projects/existing',
        includeRoots: ['src'], // caller passes narrower scope
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.content[0].text).toContain('"created": false');
      expect((result.structuredContent as any).data.scopePreserved).toBe(true);
      // Upsert must use preserved roots, NOT the caller-provided narrower scope
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.objectContaining({
          includeRoots: ['mcp', 'scripts', 'docs'],
          ignoreRules: ['*.generated.*'],
        })
      );
    });

    it('preserves existing ignoreRules alongside includeRoots', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 15,
        rootPath: '/project/with-rules',
        normalizedRootPath: '/project/with-rules',
        includeRoots: ['src', 'lib'],
        ignoreRules: ['node_modules', 'dist'],
      });
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      await handleRegisterProject({
        name: 'Project With Rules',
        rootPath: '/project/with-rules',
        includeRoots: ['new-src-only'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      // Both includeRoots AND ignoreRules must be preserved
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.objectContaining({
          includeRoots: ['src', 'lib'],
          ignoreRules: ['node_modules', 'dist'],
        })
      );
    });

    it('falls back to caller-provided roots when existing project has empty includeRoots', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        rootPath: '/project/empty-roots',
        normalizedRootPath: '/project/empty-roots',
        includeRoots: [],
        ignoreRules: [],
      });
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      await handleRegisterProject({
        name: 'Empty Roots Project',
        rootPath: '/project/empty-roots',
        includeRoots: ['src', 'lib'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      // Empty existing roots → use caller-provided roots
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.objectContaining({
          includeRoots: ['src', 'lib'],
        })
      );
    });

    it('reports scopePreserved=false when existing project has no includeRoots', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        rootPath: '/project/no-roots',
        normalizedRootPath: '/project/no-roots',
      });
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'No Existing Roots',
        rootPath: '/project/no-roots',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result.structuredContent as any).data.scopePreserved).toBe(false);
      expect((result.structuredContent as any).data.includeRoots).toEqual(['src']);
    });

    it('returns an error when Postgres registration fails', async () => {
      postgresStoreMocks.upsertRepository.mockRejectedValueOnce(new Error('Registration failed'));

      const result = await handleRegisterProject({
        name: 'Test Project',
        rootPath: '/test/path',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('Registration failed');
    });

    it('handles string errors', async () => {
      postgresStoreMocks.upsertRepository.mockRejectedValueOnce('error string');

      const result = await handleRegisterProject({
        name: 'Test Project',
        rootPath: '/test/path',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
    });

    it('registers projects in Postgres', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Test Project',
        rootPath: '/test/path',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBeUndefined();
      expect(result.content[0].text).toContain('"backend": "postgres"');
      expect(result.content[0].text).toContain('"projectId": "test-project"');
      expect((result.structuredContent as any).data.postgresId).toBe(42);
      expect((result.structuredContent as any).data.database).toEqual({
        source: 'PROJECT_RAG_DATABASE_URL',
        redactedUrl: 'postgres://postgres:***@127.0.0.1:5440/rag_engine',
      });
      expect((result.structuredContent as any).data.created).toBe(true);
      expect((result.structuredContent as any).data.scopePreserved).toBe(false);
      expect((result.structuredContent as any).data.watcher.status).toBe('skipped');
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(postgresStoreMocks.sql, {
        name: 'Test Project',
        slug: 'test-project',
        rootPath: '/test/path',
        normalizedRootPath: '/test/path',
        status: 'active',
        syncMode: 'full',
        includeRoots: ['src'],
        metadata: {
          backend: 'postgres',
          gitRemote: undefined,
          defaultBranch: undefined,
          registeredBy: 'mcp',
        },
      });
    });

    it('rejects registration when no explicit Postgres write URL is configured', async () => {
      postgresStoreMocks.resolveWriteConfig.mockImplementationOnce(() => {
        throw new Error(
          'Project RAG write operations require an explicit Postgres URL. Set PROJECT_RAG_DATABASE_URL first.'
        );
      });

      const result = await handleRegisterProject({
        name: 'Test Project',
        rootPath: '/test/path',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain(
        'Project RAG write operations require an explicit Postgres URL'
      );
      expect(postgresStoreMocks.createSql).not.toHaveBeenCalled();
      expect(postgresStoreMocks.findProject).not.toHaveBeenCalled();
      expect(postgresStoreMocks.upsertRepository).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Blocked-finding allowlist replacement tests
    // -----------------------------------------------------------------------

    it('rejects replaceBlockedFindingAllowlist=true without blockedFindingAllowlist', async () => {
      const result = await handleRegisterProject({
        name: 'Allowlist Test',
        rootPath: '/home/user/projects/test',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        replaceBlockedFindingAllowlist: true,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('VALIDATION_ERROR');
      expect(result.content[0].text).toContain(
        'replaceBlockedFindingAllowlist=true requires blockedFindingAllowlist'
      );
    });

    it('rejects blockedFindingAllowlist without replaceBlockedFindingAllowlist=true', async () => {
      const result = await handleRegisterProject({
        name: 'Allowlist Test',
        rootPath: '/home/user/projects/test',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        blockedFindingAllowlist: [{ relativePath: 'vendor/dep1', category: 'dependency_dir' }],
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('VALIDATION_ERROR');
      expect(result.content[0].text).toContain(
        'blockedFindingAllowlist provided without replaceBlockedFindingAllowlist=true'
      );
    });

    it('rejects replaceBlockedFindingAllowlist=false with list', async () => {
      const result = await handleRegisterProject({
        name: 'Allowlist Test',
        rootPath: '/home/user/projects/test',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        blockedFindingAllowlist: [{ relativePath: 'vendor/dep1', category: 'dependency_dir' }],
        replaceBlockedFindingAllowlist: false,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('VALIDATION_ERROR');
    });

    it('omitting BOTH blockedFindingAllowlist and replaceBlockedFindingAllowlist preserves current DB allowlist', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'No Allowlist Args',
        rootPath: '/home/user/projects/test',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBeUndefined();
      expect((result.structuredContent as any).data.allowlistAction).toBe('preserved');
      expect((result.structuredContent as any).data.effectiveBlockedFindingAllowlist).toEqual([]);
      // Must NOT pass blockedFindingAllowlist to upsert
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.not.objectContaining({ blockedFindingAllowlist: expect.anything() })
      );
    });

    it('include allowlistAction and effectiveBlockedFindingAllowlist in output', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Output Test',
        rootPath: '/home/user/projects/test',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      const data = (result.structuredContent as any).data;
      expect(data.allowlistAction).toBeDefined();
      expect(['preserved', 'replaced', 'cleared']).toContain(data.allowlistAction);
      expect(Array.isArray(data.effectiveBlockedFindingAllowlist)).toBe(true);
    });

    it('empty blockedFindingAllowlist with replace=true reaches upsert with [] and returns allowlistAction=cleared', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Clear Allowlist',
        rootPath: '/tmp',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        blockedFindingAllowlist: [],
        replaceBlockedFindingAllowlist: true,
      });

      expect((result as any).isError).toBeUndefined();
      const data = (result.structuredContent as any).data;
      expect(data.allowlistAction).toBe('cleared');
      expect(data.effectiveBlockedFindingAllowlist).toEqual([]);
      // Explicit [] MUST be passed to upsert
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.objectContaining({ blockedFindingAllowlist: [] })
      );
    });

    it('preserves existing nonempty allowlist and returns it as effectiveBlockedFindingAllowlist', async () => {
      const existingProject = {
        id: 7,
        rootPath: '/home/user/projects/existing',
        normalizedRootPath: '/home/user/projects/existing',
        includeRoots: ['src', 'lib'],
        blockedFindingAllowlist: [
          { relativePath: 'vendor/dep1', category: 'dependency_dir' },
          { relativePath: '.cache/stale', category: 'cache_dir' },
        ],
      };
      // First call: lookup existing; second call: re-read after upsert
      postgresStoreMocks.findProject
        .mockResolvedValueOnce(existingProject)
        .mockResolvedValueOnce(existingProject);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Preserve Allowlist',
        rootPath: '/home/user/projects/existing',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBeUndefined();
      const data = (result.structuredContent as any).data;
      expect(data.allowlistAction).toBe('preserved');
      expect(data.effectiveBlockedFindingAllowlist).toEqual(['vendor/dep1', '.cache/stale']);
      // Must NOT pass blockedFindingAllowlist to upsert (omission preserves)
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.not.objectContaining({ blockedFindingAllowlist: expect.anything() })
      );
    });

    it('validates allowlist replacement against persisted includeRoots (not request roots)', async () => {
      // Existing project has includeRoots ['mcp', 'scripts', 'docs'].
      // Request passes narrower roots ['src'].
      // Allowlist entries should be validated against ['mcp', 'scripts', 'docs'].
      const existingProject = {
        id: 7,
        rootPath: '/tmp',
        normalizedRootPath: '/tmp',
        includeRoots: ['mcp', 'scripts', 'docs'],
        ignoreRules: [],
        blockedFindingAllowlist: [],
      };
      const persistedAfterReplace = {
        ...existingProject,
        blockedFindingAllowlist: [{ relativePath: 'mcp/tests', category: 'test_fixture' }],
      };
      // First call: lookup existing; second call: re-read after upsert
      postgresStoreMocks.findProject
        .mockResolvedValueOnce(existingProject)
        .mockResolvedValueOnce(persistedAfterReplace);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Validate With Persisted',
        rootPath: '/tmp',
        includeRoots: ['src'], // narrower than persisted
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        blockedFindingAllowlist: [{ relativePath: 'mcp/tests', category: 'test_fixture' }],
        replaceBlockedFindingAllowlist: true,
      });

      // The allowlist entry 'mcp/tests' is valid against ['mcp', 'scripts', 'docs']
      // but would be invalid against ['src']. Validation should pass because
      // it uses persisted roots.
      expect((result as any).isError).toBeUndefined();
      const data = (result.structuredContent as any).data;
      expect(data.allowlistAction).toBe('replaced');
      expect(data.effectiveBlockedFindingAllowlist).toEqual(['mcp/tests']);
      // Upsert must use preserved roots, not request roots
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.objectContaining({
          includeRoots: ['mcp', 'scripts', 'docs'],
          blockedFindingAllowlist: [{ relativePath: 'mcp/tests', category: 'test_fixture' }],
        })
      );
    });

    it('rejects allowlist entry invalid against persisted roots', async () => {
      // Existing project has includeRoots ['src', 'lib'].
      // Request tries to add an entry for 'vendor/dep1' which is a child
      // of a persisted root 'src'. Wait, 'vendor' is NOT in ['src', 'lib'],
      // so validateAllowlistAgainstRoot would reject it.
      // We need to actually test rejection.
      // But the mock for validateAllowlistAgainstRoot is a no-op.
      // We need to make it throw. Let's import and control it.
      const { validateAllowlistAgainstRoot } = await import(
        '../scripts/project-rag/project-inventory.js'
      );
      const mockedValidate = vi.mocked(validateAllowlistAgainstRoot);
      mockedValidate.mockImplementationOnce(() => {
        throw new Error('Allowlist path "vendor/dep1" is not inside any include root');
      });

      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        rootPath: '/tmp',
        normalizedRootPath: '/tmp',
        includeRoots: ['mcp', 'scripts'],
        ignoreRules: [],
      });

      const result = await handleRegisterProject({
        name: 'Invalid Entry',
        rootPath: '/tmp',
        includeRoots: ['src', 'vendor'], // request includes vendor
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        blockedFindingAllowlist: [{ relativePath: 'vendor/dep1', category: 'dependency_dir' }],
        replaceBlockedFindingAllowlist: true,
      });

      expect((result as any).isError).toBe(true);
      expect((result.structuredContent as any).error.code).toBe('ALLOWLIST_VALIDATION_FAILED');
      expect((result.structuredContent as any).error.message).toContain('vendor/dep1');
    });

    it('maps policy-race DB error to PROJECT_CONFIG_LOCKED with retryable=true', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        rootPath: '/tmp',
        normalizedRootPath: '/tmp',
        includeRoots: ['src'],
      });
      // Simulate the DB trigger rejecting config mutation during CONSUMING
      postgresStoreMocks.upsertRepository.mockRejectedValueOnce(
        new Error(
          'cannot modify include_roots, ignore_rules, or blocked_finding_allowlist while a CONSUMING ingest snapshot exists'
        )
      );

      const result = await handleRegisterProject({
        name: 'Locked Project',
        rootPath: '/tmp',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      const err = (result.structuredContent as any).error;
      expect(err.code).toBe('PROJECT_CONFIG_LOCKED');
      expect(err.retryable).toBe(true);
      // Must NOT leak raw DB/table names
      expect(err.message).not.toContain('project_repositories');
      expect(err.message).not.toContain('CONSUMING');
      expect(err.message).not.toMatch(/\d{4,}/);
    });

    it('returns allowlistAction=preserved and empty allowlist for fresh project with no replacement', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Fresh Project',
        rootPath: '/home/user/projects/new',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      const data = (result.structuredContent as any).data;
      expect(data.created).toBe(true);
      expect(data.allowlistAction).toBe('preserved');
      expect(data.effectiveBlockedFindingAllowlist).toEqual([]);
      expect(data.scopePreserved).toBe(false);
    });

    // -----------------------------------------------------------------------
    // T-04 slice3: Root identity, concurrency, existing-nonempty clear
    // -----------------------------------------------------------------------

    it('rejects PROJECT_ROOT_MISMATCH when existing project has different rootPath', async () => {
      // Existing project has rootPath=/different/root
      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        name: 'Existing',
        slug: 'existing-project',
        rootPath: '/different/root',
        normalizedRootPath: '/different/root',
        includeRoots: ['src'],
      });
      // Upsert mock is set but should NOT be called since we reject before it
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Existing Project',
        rootPath: '/requested/path', // different from existing
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      const err = (result.structuredContent as any).error;
      expect(err.code).toBe('PROJECT_ROOT_MISMATCH');
      expect(err.message).toContain('/different/root');
      expect(err.message).toContain('/requested/path');
      // Upsert must NOT have been called — we reject before upsert
      expect(postgresStoreMocks.upsertRepository).not.toHaveBeenCalled();
    });

    it('re-reports persisted allowlist (concurrency re-read) after upsert', async () => {
      // First findProject returns existing with empty allowlist
      postgresStoreMocks.findProject
        .mockResolvedValueOnce({
          id: 7,
          rootPath: '/tmp',
          normalizedRootPath: '/tmp',
          includeRoots: ['mcp', 'scripts'],
          blockedFindingAllowlist: [], // first read: empty
        })
        .mockResolvedValueOnce({
          // second read (after upsert): concurrent nonempty allowlist
          id: 7,
          rootPath: '/tmp',
          normalizedRootPath: '/tmp',
          includeRoots: ['mcp', 'scripts'],
          blockedFindingAllowlist: [
            { relativePath: 'vendor/concurrent', category: 'dependency_dir' },
          ],
        });
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Concurrency Project',
        rootPath: '/tmp',
        includeRoots: ['mcp'], // narrower — preserved roots will be used
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBeUndefined();
      const data = (result.structuredContent as any).data;
      // Response must report the concurrent persisted state, not stale predicted
      expect(data.effectiveBlockedFindingAllowlist).toEqual(['vendor/concurrent']);
      // Allowlist action is 'preserved' because we didn't pass replace=true
      expect(data.allowlistAction).toBe('preserved');
    });

    it('clears existing nonempty allowlist with replaceBlockedFindingAllowlist=true and []', async () => {
      // Existing project has nonempty allowlist
      postgresStoreMocks.findProject
        .mockResolvedValueOnce({
          id: 7,
          rootPath: '/tmp',
          normalizedRootPath: '/tmp',
          includeRoots: ['src', 'lib'],
          blockedFindingAllowlist: [{ relativePath: 'vendor/dep1', category: 'dependency_dir' }],
        })
        .mockResolvedValueOnce({
          // Re-read after upsert returns empty
          id: 7,
          rootPath: '/tmp',
          normalizedRootPath: '/tmp',
          includeRoots: ['src', 'lib'],
          blockedFindingAllowlist: [],
        });
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Clear Allowlist',
        rootPath: '/tmp',
        includeRoots: ['src'], // narrower — but we're clearing
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        blockedFindingAllowlist: [],
        replaceBlockedFindingAllowlist: true,
      });

      expect((result as any).isError).toBeUndefined();
      const data = (result.structuredContent as any).data;
      expect(data.allowlistAction).toBe('cleared');
      expect(data.effectiveBlockedFindingAllowlist).toEqual([]);
      // Upsert must be called with [] for the allowlist
      expect(postgresStoreMocks.upsertRepository).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        expect.objectContaining({
          blockedFindingAllowlist: [],
          includeRoots: ['src', 'lib'], // preserved roots
        })
      );
    });

    it('returns SCHEMA_NOT_READY when assertProjectRagPostgresAllowlistSchemaReady throws', async () => {
      // Mock the schema check failure
      const { assertProjectRagPostgresAllowlistSchemaReady } = await import(
        '../scripts/project-rag/store.js'
      );
      const mockedAssert = vi.mocked(assertProjectRagPostgresAllowlistSchemaReady);
      mockedAssert.mockRejectedValueOnce(
        new Error('Project RAG schema is missing migration-004 column')
      );

      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);

      const result = await handleRegisterProject({
        name: 'Schema Not Ready',
        rootPath: '/tmp',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      const err = (result.structuredContent as any).error;
      expect(err.code).toBe('SCHEMA_NOT_READY');
      expect(err.message).toContain('migration-004');
      expect(postgresStoreMocks.upsertRepository).not.toHaveBeenCalled();
    });

    it('passes preserved includeRoots to validateAllowlistAgainstRoot (validator gets persisted roots)', async () => {
      // Existing project has includeRoots ['mcp', 'scripts', 'docs'].
      // Request passes narrower roots ['src'].
      // The validator should receive ['mcp', 'scripts', 'docs'], not ['src'].
      const { validateAllowlistAgainstRoot } = await import(
        '../scripts/project-rag/project-inventory.js'
      );
      // Keep the mock as a no-op (default behavior)
      const mockedValidate = vi.mocked(validateAllowlistAgainstRoot);
      mockedValidate.mockClear();

      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        rootPath: '/tmp',
        normalizedRootPath: '/tmp',
        includeRoots: ['mcp', 'scripts', 'docs'],
        ignoreRules: [],
      });
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      await handleRegisterProject({
        name: 'Validator Roots Test',
        rootPath: '/tmp',
        includeRoots: ['src'], // narrower, should not reach validator
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        replaceBlockedFindingAllowlist: true,
        blockedFindingAllowlist: [{ relativePath: 'mcp/tests', category: 'test_fixture' }],
      });

      // The validateAllowlistAgainstRoot should have been called with the
      // persisted include roots, not the request roots
      expect(mockedValidate).toHaveBeenCalledWith(
        expect.any(String),
        ['mcp', 'scripts', 'docs'], // persisted roots
        expect.any(Array)
      );
    });
  });

  describe('Postgres unsupported Project RAG routes', () => {
    beforeEach(() => {
      delete process.env.PROJECT_RAG_BACKEND;
    });

    it('uses Postgres semantic navigation helpers when backend is selected', async () => {
      postgresStoreMocks.findProject
        .mockResolvedValueOnce({ id: 7 })
        .mockResolvedValueOnce({ id: 7 })
        .mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.getSemanticClusters.mockResolvedValueOnce([
        {
          clusterId: 'cluster-mcp',
          topicLabel: 'Mcp',
          confidence: 0.8,
          files: [{ sourcePath: 'mcp/server.ts', similarity: 0.75 }],
          terms: ['mcp'],
        },
      ]);
      postgresStoreMocks.getFeatureHubs.mockResolvedValueOnce([
        {
          hubId: 'hub-mcp',
          name: 'Mcp',
          directory: 'mcp',
          stats: {
            fileCount: 2,
            languageCount: 1,
            totalSymbols: 4,
            fileTypeDistribution: { ts: 2 },
          },
          files: [{ fileName: 'server.ts', symbols: ['runServer'] }],
        },
      ]);
      postgresStoreMocks.getTopicGroups.mockResolvedValueOnce([
        {
          topicId: 'topic-1',
          name: 'Mcp',
          files: [{ sourcePath: 'mcp/server.ts' }],
          keywords: ['mcp'],
          cohesion: 0.6,
        },
      ]);

      const results = await Promise.all([
        handleGetSemanticClusters({ projectId: 'project-123' }),
        handleGetFeatureHubs({ projectId: 'project-123' }),
        handleGetTopicGroups({ projectId: 'project-123' }),
      ]);

      for (const result of results) {
        expect((result as any).isError).not.toBe(true);
        expect((result.structuredContent as any).data.backend).toBe('postgres');
        expect((result.structuredContent as any).data.count).toBe(1);
      }
    });

    it('uses Postgres navigation paths when backend is selected', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.getNavigationPaths.mockResolvedValueOnce([
        {
          sourcePath: 'src/related.ts',
          relationshipType: 'imports',
          strength: 0.92,
          explanation: 'Related through imports graph edge',
        },
      ]);

      const result = await handleGetNavigationPaths({
        projectId: 'project-123',
        sourcePath: 'src/index.ts',
      });

      expect(result.content[0].text).toContain('src/related.ts');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
      expect((result.structuredContent as any).data.count).toBe(1);
    });
  });

  describe('handleRegisterProject security validation', () => {
    // These tests verify that the path validation is properly integrated
    // into the handler. The path-validator.test.ts file tests the validation
    // logic itself.

    beforeEach(() => {
      // Reset the mock before each test
      mockedValidateProjectRootPath.mockClear();
      mockedValidateProjectIncludeRoots.mockClear();
    });

    it('rejects system directory paths', async () => {
      mockedValidateProjectRootPath.mockReturnValueOnce({
        valid: false,
        error: 'System directory "/etc" is not allowed for project indexing.',
        code: 'PATH_IS_SYSTEM_DIRECTORY',
      });

      const result = await handleRegisterProject({
        name: 'Malicious Project',
        rootPath: '/etc',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_PATH');
      expect(result.content[0].text).toContain('System directory');
    });

    it('rejects relative paths', async () => {
      mockedValidateProjectRootPath.mockReturnValueOnce({
        valid: false,
        error: 'Path must be absolute. Received relative path: "./my-project".',
        code: 'PATH_NOT_ABSOLUTE',
      });

      const result = await handleRegisterProject({
        name: 'Relative Path Project',
        rootPath: './my-project',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_PATH');
      expect(result.content[0].text).toContain('absolute');
    });

    it('rejects non-existent paths', async () => {
      mockedValidateProjectRootPath.mockReturnValueOnce({
        valid: false,
        error: 'Path does not exist: "/nonexistent/path".',
        code: 'PATH_DOES_NOT_EXIST',
      });

      const result = await handleRegisterProject({
        name: 'Nonexistent Project',
        rootPath: '/nonexistent/path',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_PATH');
      expect(result.content[0].text).toContain('does not exist');
    });

    it('rejects file paths (not directories)', async () => {
      mockedValidateProjectRootPath.mockReturnValueOnce({
        valid: false,
        error: 'Path is not a directory: "/path/to/file.txt".',
        code: 'PATH_IS_NOT_DIRECTORY',
      });

      const result = await handleRegisterProject({
        name: 'File Not Dir',
        rootPath: '/path/to/file.txt',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_PATH');
      expect(result.content[0].text).toContain('not a directory');
    });

    it('proceeds with valid paths', async () => {
      mockedValidateProjectRootPath.mockReturnValueOnce({
        valid: true,
        resolvedPath: '/home/user/projects/my-app',
      });
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);
      postgresStoreMocks.upsertRepository.mockResolvedValueOnce(42);

      const result = await handleRegisterProject({
        name: 'Valid Project',
        rootPath: '/home/user/projects/my-app',
        includeRoots: ['src'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBeUndefined();
      expect(result.content[0].text).toContain('"backend": "postgres"');
      expect(result.content[0].text).toContain('"projectId": "valid-project"');
    });

    it('rejects missing include roots', async () => {
      mockedValidateProjectIncludeRoots.mockReturnValueOnce({
        valid: false,
        code: 'INCLUDE_ROOTS_REQUIRED',
        error: 'Project includeRoots are required. Provide at least one relative folder to ingest.',
        suggestions: ['src'],
      });

      const result = await handleRegisterProject({
        name: 'No Scope Project',
        rootPath: '/home/user/projects/my-app',
        includeRoots: [],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_INCLUDE_ROOTS');
    });

    it('rejects missing scope acknowledgement', async () => {
      const result = await handleRegisterProject({
        name: 'No Ack Project',
        rootPath: '/home/user/projects/my-app',
        includeRoots: ['src'],
        scopeAck: '' as string,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('SCOPE_CONFIRMATION_REQUIRED');
      expect(result.content[0].text).toContain('Critical project scope warning');
    });
  });

  describe('handlePrepareProject', () => {
    it('uses the shared operation without requiring a scope acknowledgement', async () => {
      const signal = new AbortController().signal;
      const result = await handlePrepareProject(
        {
          rootPath: '/workspace/fixture-project',
          projectId: 'project-1',
          includeRoots: ['src'],
          timeoutMs: 2_000,
          maxFiles: 10,
          maxBatches: 2,
        },
        signal
      );

      expect(prepareProjectMock).toHaveBeenCalledWith({
        rootPath: '/workspace/fixture-project',
        project: 'project-1',
        includeRoots: ['src'],
        timeoutMs: 2_000,
        maxFiles: 10,
        maxBatches: 2,
        signal,
      });
      expect(result.structuredContent).toMatchObject({ success: true, data: { ready: true } });
      expect(result.isError).toBeUndefined();
    });

    it('returns progress and a retryable error for a bounded partial result', async () => {
      prepareProjectMock.mockResolvedValueOnce({
        status: 'partial',
        ready: false,
        operation: { id: 'prepare-1', deduplicated: false },
        stage: 'ingest',
        project: { slug: 'fixture-project' },
        progress: { batch: 1, remaining: 1 },
        reason: { code: 'PREPARATION_DEADLINE_EXCEEDED', message: 'retry' },
      });

      const result = await handlePrepareProject({
        rootPath: '/workspace/fixture-project',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        success: false,
        error: { code: 'PREPARATION_DEADLINE_EXCEEDED', retryable: true },
        data: { status: 'partial', ready: false },
      });
    });

    it('preserves structured preparation blockers thrown before orchestration starts', async () => {
      prepareProjectMock.mockRejectedValueOnce({
        code: 'UNTRUSTED_ROOT',
        message: 'Project root is outside the configured trusted roots',
        details: { trustedRootCount: 0 },
      });

      const result = await handlePrepareProject({
        rootPath: '/tmp/untrusted-project',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        success: false,
        error: {
          code: 'UNTRUSTED_ROOT',
          details: { trustedRootCount: 0 },
        },
      });
    });
  });

  describe('handleVerifyProjectIndex', () => {
    const mockProject = {
      id: 7,
      name: 'Test Project',
      slug: 'test-project',
      rootPath: '/tmp',
      normalizedRootPath: '/tmp',
      includeRoots: ['src'],
      ignoreRules: [],
      status: 'active',
      updatedAt: Date.parse('2026-03-24T09:00:00.000Z'),
    };

    const invariantReport = (
      overrides: Partial<{
        fileCount: number;
        indexedFileCount: number;
        chunkCount: number;
        freshnessStatus: 'fresh' | 'stale' | 'missing' | 'fresh_with_metadata_drift';
        scopeStatus: 'covered' | 'drift';
        embeddingStatus: 'covered' | 'drift';
        ownershipStatus: 'covered' | 'drift' | 'unverified';
        missingOwners: number;
        chunkVersionGaps: number;
        embeddingVersionGaps: number;
        embeddingVersionMismatchOwners: number;
        extraIndexedFiles: number;
        ignoredIndexedFiles: number;
        filesWithNonReadyActiveVersion: number;
        filesPendingVersionBackfill: number;
        filesUsingLegacyStatusRead: number;
        lastSyncAt: string | null;
      }> = {}
    ) => {
      const fileCount = overrides.fileCount ?? 10;
      const indexedFileCount = overrides.indexedFileCount ?? fileCount;
      const chunkCount = overrides.chunkCount ?? 100;
      const versionReadiness = {
        filesWithVersionMetadata: 0,
        filesWithActiveReadyVersion: 0,
        filesWithNonReadyActiveVersion: overrides.filesWithNonReadyActiveVersion ?? 0,
        filesPendingVersionBackfill: overrides.filesPendingVersionBackfill ?? 0,
        filesUsingLegacyStatusRead: overrides.filesUsingLegacyStatusRead ?? 0,
      };
      return {
        versionReadiness,
        freshness: {
          status: overrides.freshnessStatus ?? 'fresh',
          checkedFiles: indexedFileCount,
          eligibleFiles: indexedFileCount,
          freshFiles:
            overrides.freshnessStatus === 'stale' ? indexedFileCount - 1 : indexedFileCount,
          staleFiles: overrides.freshnessStatus === 'stale' ? 1 : 0,
          missingFiles: overrides.freshnessStatus === 'missing' ? 1 : 0,
          metadataDriftFiles: overrides.freshnessStatus === 'fresh_with_metadata_drift' ? 1 : 0,
          unverifiedFiles: 0,
          stalePaths:
            overrides.freshnessStatus === 'stale'
              ? ['src/stale.ts']
              : overrides.freshnessStatus === 'missing'
                ? ['src/missing.ts']
                : [],
          checkedAt: '2026-03-24T09:00:00.000Z',
          reason:
            'Postgres verification checks indexed files for filesystem freshness; full expected-file enumeration is not included.',
          versionSignals: versionReadiness,
        },
        scopeCoverage: {
          status: overrides.scopeStatus ?? 'covered',
          checkedAt: '2026-03-24T09:00:00.000Z',
          expectedFiles: 0,
          trackedFiles: fileCount,
          indexedFiles: indexedFileCount,
          missingExpectedFiles: 0,
          extraIndexedFiles: overrides.extraIndexedFiles ?? 0,
          ignoredExpectedFiles: 0,
          ignoredIndexedFiles: overrides.ignoredIndexedFiles ?? 0,
          missingExpectedPaths: [],
          extraIndexedPaths: overrides.scopeStatus === 'drift' ? ['test/outside.ts'] : [],
          ignoredExpectedPaths: [],
          ignoredIndexedPaths: [],
          reason:
            'Postgres verification checks indexed files against includeRoots/ignoreRules; full expected-file enumeration is deferred.',
        },
        embeddingCoverage: {
          status: overrides.embeddingStatus ?? 'covered',
          expectedModel: 'qwen3-embedding-1024',
          expectedProvider: 'llamacpp',
          expectedDimensions: 1024,
          chunkOwners: chunkCount,
          embeddingOwners: chunkCount - (overrides.missingOwners ?? 0),
          embeddingRecords: chunkCount - (overrides.missingOwners ?? 0),
          ownersWithValidEmbedding: chunkCount - (overrides.missingOwners ?? 0),
          missingOwners: overrides.missingOwners ?? 0,
          staleOwners: 0,
          modelMismatchOwners: 0,
          providerMismatchOwners: 0,
          dimensionMismatchOwners: 0,
          invalidVectorLengthOwners: 0,
          chunkVersionGaps: overrides.chunkVersionGaps ?? 0,
          embeddingVersionGaps: overrides.embeddingVersionGaps ?? 0,
          embeddingVersionMismatchOwners: overrides.embeddingVersionMismatchOwners ?? 0,
          missingOwnerSample: [],
          staleOwnerSample: [],
          mismatchOwnerSample: [],
          versionMismatchOwnerSample: [],
        },
        ownershipCoverage: {
          status: overrides.ownershipStatus ?? 'covered',
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
        },
        lastSyncAt: 'lastSyncAt' in overrides ? overrides.lastSyncAt : '2026-03-24T09:00:00.000Z',
      };
    };

    it('returns verification summary', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 10,
        blockedFileCount: 0,
        chunkCount: 100,
        symbolCount: 50,
        edgeCount: 12,
        embedding1024Count: 100,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(invariantReport());

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect(result.content[0].text).toContain('# Project Index Verification');
      expect(result.content[0].text).toContain('**Backend:** postgres');
      expect(result.content[0].text).toContain('**File Count:** 10');
      expect(result.content[0].text).toContain('**Indexed Files:** 10');
      expect(result.content[0].text).toContain('**Chunk Count:** 100');
      expect(result.content[0].text).toContain('**Embedding 1024 Count:** 100');
      expect(result.content[0].text).toContain('**Coverage:** Indexed');
      expect(result.content[0].text).toContain('## Freshness');
      expect(result.content[0].text).toContain('**Status:** Fresh');
      expect(result.content[0].text).toContain('## Embedding Coverage');
      expect(result.content[0].text).toContain('**Blocking Failure Code:** none');
      expect(result.structuredContent).toMatchObject({
        success: true,
        data: {
          backend: 'postgres',
          projectId: 'project-123',
          fileCount: 10,
          chunkCount: 100,
          symbolCount: 50,
          edgeCount: 12,
          lastSyncAt: '2026-03-24T09:00:00.000Z',
          coverage: 'Indexed',
          status: 'active',
          versionReadiness: {
            filesWithVersionMetadata: 0,
            filesWithActiveReadyVersion: 0,
            filesWithNonReadyActiveVersion: 0,
            filesPendingVersionBackfill: 0,
            filesUsingLegacyStatusRead: 0,
          },
          freshness: {
            status: 'fresh',
            checkedFiles: 10,
            eligibleFiles: 10,
            freshFiles: 10,
            staleFiles: 0,
            missingFiles: 0,
            metadataDriftFiles: 0,
            unverifiedFiles: 0,
            stalePaths: [],
            checkedAt: expect.any(String),
            reason: expect.stringContaining('indexed files for filesystem freshness'),
            versionSignals: {
              filesWithVersionMetadata: 0,
              filesWithActiveReadyVersion: 0,
              filesWithNonReadyActiveVersion: 0,
              filesPendingVersionBackfill: 0,
              filesUsingLegacyStatusRead: 0,
            },
          },
          scopeCoverage: {
            status: 'covered',
            checkedAt: expect.any(String),
            expectedFiles: 0,
            trackedFiles: 10,
            indexedFiles: 10,
            missingExpectedFiles: 0,
            extraIndexedFiles: 0,
            ignoredExpectedFiles: 0,
            ignoredIndexedFiles: 0,
            missingExpectedPaths: [],
            extraIndexedPaths: [],
            ignoredExpectedPaths: [],
            ignoredIndexedPaths: [],
            reason: expect.stringContaining('full expected-file enumeration is deferred'),
          },
          embeddingCoverage: {
            status: 'covered',
            expectedModel: 'qwen3-embedding-1024',
            expectedProvider: 'llamacpp',
            expectedDimensions: 1024,
            chunkOwners: 100,
            embeddingOwners: 100,
            embeddingRecords: 100,
            ownersWithValidEmbedding: 100,
            missingOwners: 0,
            staleOwners: 0,
            modelMismatchOwners: 0,
            providerMismatchOwners: 0,
            dimensionMismatchOwners: 0,
            invalidVectorLengthOwners: 0,
            missingOwnerSample: [],
            staleOwnerSample: [],
            mismatchOwnerSample: [],
          },
          ownershipCoverage: {
            status: 'covered',
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
          },
          invariants: {
            summary: {
              status: 'covered',
              driftedChecks: 0,
              unverifiedChecks: 0,
            },
            checks: expect.any(Array),
          },
          gateSignal: { ready: true, blockingFailureCode: null },
          watcher: {
            status: 'skipped',
            rootPath: '/tmp',
            slug: 'test-project',
            reason: 'Postgres verification does not start project watchers.',
          },
        },
      });
    });

    it('uses Postgres project stats when backend is selected', async () => {
      process.env.PROJECT_RAG_BACKEND = 'postgres';
      postgresStoreMocks.findProject.mockResolvedValueOnce({
        id: 7,
        name: 'Test Project',
        slug: 'test-project',
        normalizedRootPath: '/tmp',
        status: 'active',
      });
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 8,
        blockedFileCount: 2,
        chunkCount: 100,
        symbolCount: 50,
        edgeCount: 12,
        embedding1024Count: 100,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({ indexedFileCount: 8 })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect(result.content[0].text).toContain('**Backend:** postgres');
      expect(result.content[0].text).toContain('**File Count:** 10');
      expect(result.content[0].text).toContain('**Embedding 1024 Count:** 100');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
      expect((result.structuredContent as any).data.fileCount).toBe(10);
      expect((result.structuredContent as any).data.freshness.status).toBe('fresh');
      expect((result.structuredContent as any).data.embeddingCoverage.expectedDimensions).toBe(
        1024
      );
      expect((result.structuredContent as any).data.watcher).toMatchObject({
        status: 'skipped',
        rootPath: '/tmp',
        slug: 'test-project',
      });
    });

    it('returns empty Postgres stats without a synthetic lastSyncAt fallback', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 0,
        indexedFileCount: 0,
        blockedFileCount: 0,
        chunkCount: 0,
        symbolCount: 0,
        edgeCount: 0,
        embedding1024Count: 0,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({ fileCount: 0, indexedFileCount: 0, chunkCount: 0, lastSyncAt: null })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect(result.content[0].text).toContain('**Coverage:** Not indexed');
      expect(result.content[0].text).toContain('**Status:** Fresh');
      expect(result.structuredContent).toMatchObject({
        success: false,
        data: {
          backend: 'postgres',
          projectId: 'project-123',
          fileCount: 0,
          chunkCount: 0,
          symbolCount: 0,
          edgeCount: 0,
          lastSyncAt: null,
          coverage: 'Not indexed',
          status: 'active',
          freshness: {
            status: 'fresh',
            checkedFiles: 0,
            eligibleFiles: 0,
            freshFiles: 0,
            staleFiles: 0,
            missingFiles: 0,
            metadataDriftFiles: 0,
            unverifiedFiles: 0,
            stalePaths: [],
            checkedAt: expect.any(String),
            reason: expect.stringContaining('indexed files for filesystem freshness'),
            versionSignals: expect.any(Object),
          },
          scopeCoverage: {
            status: 'covered',
            checkedAt: expect.any(String),
            expectedFiles: 0,
            trackedFiles: 0,
            indexedFiles: 0,
            missingExpectedFiles: 0,
            extraIndexedFiles: 0,
            ignoredExpectedFiles: 0,
            ignoredIndexedFiles: 0,
            missingExpectedPaths: [],
            extraIndexedPaths: [],
            ignoredExpectedPaths: [],
            ignoredIndexedPaths: [],
            reason: expect.stringContaining('full expected-file enumeration is deferred'),
          },
          embeddingCoverage: {
            status: 'covered',
            expectedModel: 'qwen3-embedding-1024',
            expectedProvider: 'llamacpp',
            expectedDimensions: 1024,
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
            missingOwnerSample: [],
            staleOwnerSample: [],
            mismatchOwnerSample: [],
          },
          gateSignal: {
            ready: false,
            blockingFailureCode: 'PROJECT_INDEX_EMPTY',
          },
          watcher: {
            status: 'skipped',
            rootPath: '/tmp',
            slug: 'test-project',
            reason: 'Postgres verification does not start project watchers.',
          },
        },
      });
    });

    it('blocks registered Postgres projects with no indexed files', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 0,
        blockedFileCount: 10,
        chunkCount: 0,
        symbolCount: 0,
        edgeCount: 0,
        embedding1024Count: 0,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({ fileCount: 10, indexedFileCount: 0, chunkCount: 0 })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect(result.content[0].text).toContain('**Coverage:** Not indexed');
      expect(result.content[0].text).toContain('**Blocking Failure Code:** PROJECT_INDEX_EMPTY');
      expect((result.structuredContent as any).data.gateSignal).toEqual({
        ready: false,
        blockingFailureCode: 'PROJECT_INDEX_EMPTY',
      });
    });

    it('blocks indexed Postgres projects with no enabled chunk owners', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 10,
        blockedFileCount: 0,
        chunkCount: 0,
        symbolCount: 0,
        edgeCount: 0,
        embedding1024Count: 0,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({ chunkCount: 0 })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect(result.content[0].text).toContain('**Blocking Failure Code:** PROJECT_INDEX_EMPTY');
      expect((result.structuredContent as any).data.embeddingCoverage.chunkOwners).toBe(0);
      expect((result.structuredContent as any).data.gateSignal).toEqual({
        ready: false,
        blockingFailureCode: 'PROJECT_INDEX_EMPTY',
      });
    });

    it('blocks Postgres ownership drift', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 10,
        blockedFileCount: 0,
        chunkCount: 10,
        symbolCount: 5,
        edgeCount: 2,
        embedding1024Count: 10,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({ chunkCount: 10, ownershipStatus: 'drift' })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect((result.structuredContent as any).data.ownershipCoverage.status).toBe('drift');
      expect((result.structuredContent as any).data.gateSignal).toEqual({
        ready: false,
        blockingFailureCode: 'PROJECT_INDEX_SCOPE_DRIFT',
      });
    });

    it('blocks Postgres version readiness gaps', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 10,
        blockedFileCount: 0,
        chunkCount: 10,
        symbolCount: 5,
        edgeCount: 2,
        embedding1024Count: 10,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({
          chunkCount: 10,
          filesWithNonReadyActiveVersion: 1,
          filesPendingVersionBackfill: 1,
          filesUsingLegacyStatusRead: 1,
        })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect((result.structuredContent as any).data.invariants.checks).toContainEqual({
        key: 'version_readiness',
        status: 'unverified',
        detail: 'nonReadyActive=1, pendingBackfill=1, legacyStatusReads=1',
      });
      expect((result.structuredContent as any).data.gateSignal).toEqual({
        ready: false,
        blockingFailureCode: 'PROJECT_INDEX_UNVERIFIED',
      });
    });

    it('reports stale Postgres files as PROJECT_INDEX_STALE', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 10,
        blockedFileCount: 0,
        chunkCount: 10,
        symbolCount: 50,
        edgeCount: 12,
        embedding1024Count: 10,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({ chunkCount: 10, freshnessStatus: 'stale' })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect((result.structuredContent as any).data.gateSignal).toEqual({
        ready: false,
        blockingFailureCode: 'PROJECT_INDEX_STALE',
      });
      expect((result.structuredContent as any).data.freshness.status).toBe('stale');
    });

    it('reports missing Postgres files as PROJECT_INDEX_STALE', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 10,
        blockedFileCount: 0,
        chunkCount: 10,
        symbolCount: 50,
        edgeCount: 12,
        embedding1024Count: 10,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({ chunkCount: 10, freshnessStatus: 'missing' })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect((result.structuredContent as any).data.gateSignal).toEqual({
        ready: false,
        blockingFailureCode: 'PROJECT_INDEX_STALE',
      });
      expect((result.structuredContent as any).data.freshness.status).toBe('missing');
      expect((result.structuredContent as any).data.freshness.missingFiles).toBe(1);
    });

    it('reports Postgres scope drift as PROJECT_INDEX_SCOPE_DRIFT', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 10,
        blockedFileCount: 0,
        chunkCount: 10,
        symbolCount: 50,
        edgeCount: 12,
        embedding1024Count: 10,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({
          chunkCount: 10,
          scopeStatus: 'drift',
          extraIndexedFiles: 1,
        })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect((result.structuredContent as any).data.gateSignal).toEqual({
        ready: false,
        blockingFailureCode: 'PROJECT_INDEX_SCOPE_DRIFT',
      });
      expect((result.structuredContent as any).data.scopeCoverage.status).toBe('drift');
    });

    it('reports missing Postgres embeddings as PROJECT_INDEX_EMBEDDING_GAP', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockResolvedValueOnce({
        fileCount: 10,
        indexedFileCount: 10,
        blockedFileCount: 0,
        chunkCount: 10,
        symbolCount: 50,
        edgeCount: 12,
        embedding1024Count: 8,
        syncRunCount: 0,
      });
      postgresStoreMocks.getInvariantReport.mockResolvedValueOnce(
        invariantReport({
          chunkCount: 10,
          embeddingStatus: 'drift',
          missingOwners: 2,
        })
      );

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect(result.content[0].text).toContain(
        '**Blocking Failure Code:** PROJECT_INDEX_EMBEDDING_GAP'
      );
      expect((result.structuredContent as any).success).toBe(false);
      expect(result.isError).toBe(true);
      expect((result.structuredContent as any).data.gateSignal).toEqual({
        ready: false,
        blockingFailureCode: 'PROJECT_INDEX_EMBEDDING_GAP',
      });
      expect((result.structuredContent as any).data.embeddingCoverage.status).toBe('drift');
      expect((result.structuredContent as any).data.embeddingCoverage.missingOwners).toBe(2);
    });

    it('returns not found for missing project', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);

      const result = await handleVerifyProjectIndex({
        projectId: 'nonexistent',
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('Project not found');
    });

    it('handles query error', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(mockProject);
      postgresStoreMocks.getStats.mockRejectedValueOnce(new Error('Query failed'));

      const result = await handleVerifyProjectIndex({
        projectId: 'project-123',
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('[phase=verify_project_index');
    });
  });

  describe('handleFindProjectSymbol', () => {
    it('returns matching symbols', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.findSymbols.mockResolvedValueOnce({
        definitions: [
          {
            name: 'handleSearch',
            symbolType: 'function',
            sourcePath: 'src/search.ts',
            startLine: 10,
            endLine: 20,
            signature: 'function handleSearch()',
          },
        ],
        references: [],
      });

      const result = await handleFindProjectSymbol({
        projectId: 'project-123',
        symbolName: 'handleSearch',
      });

      expect(result.content[0].text).toContain('Found 1 symbol(s) matching "handleSearch"');
      expect(result.content[0].text).toContain('handleSearch');
    });

    it('deduplicates repeated symbol matches', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.findSymbols.mockResolvedValueOnce({
        definitions: [
          {
            name: 'handleSearch',
            symbolType: 'function',
            sourcePath: 'src/search.ts',
            startLine: 10,
            endLine: 20,
            signature: 'function handleSearch()',
          },
          {
            name: 'handleSearch',
            symbolType: 'function',
            sourcePath: 'src/search.ts',
            startLine: 10,
            endLine: 20,
            signature: 'function handleSearch()',
          },
        ],
        references: [],
      });

      const result = await handleFindProjectSymbol({
        projectId: 'project-123',
        symbolName: 'handleSearch',
      });

      expect(result.content[0].text).toContain('Found 1 symbol(s) matching "handleSearch"');
    });

    it('returns empty for no matches', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.findSymbols.mockResolvedValueOnce({
        definitions: [],
        references: [],
      });

      const result = await handleFindProjectSymbol({
        projectId: 'project-123',
        symbolName: 'nonexistent',
      });

      expect(result.content[0].text).toContain('No symbols found');
    });

    it('throws on query error', async () => {
      postgresStoreMocks.findProject.mockRejectedValueOnce(new Error('Query failed'));

      const result = await handleFindProjectSymbol({
        projectId: 'project-123',
        symbolName: 'test',
      });

      expect((result as any).isError).toBe(true);
    });

    it('handles string errors', async () => {
      postgresStoreMocks.findProject.mockRejectedValueOnce('error');

      const result = await handleFindProjectSymbol({
        projectId: 'project-123',
        symbolName: 'test',
      });

      expect((result as any).isError).toBe(true);
    });

    it('uses Postgres symbol definitions even when backend env is legacy', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.findSymbols.mockResolvedValueOnce({
        definitions: [
          {
            name: 'handleSearch',
            symbolType: 'function',
            sourcePath: 'src/search.ts',
            startLine: 10,
            endLine: 20,
            signature: 'function handleSearch()',
          },
        ],
        references: [],
      });

      const result = await handleFindProjectSymbol({
        projectId: 'project-123',
        symbolName: 'handleSearch',
      });

      expect(result.content[0].text).toContain('Found 1 symbol(s) matching "handleSearch"');
      expect(result.content[0].text).toContain('src/search.ts');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
    });
  });

  describe('handleFindSymbolReferences', () => {
    const mockDefinitions = [
      {
        name: 'myFunction',
        symbolType: 'function',
        sourcePath: 'src/def.ts',
        startLine: 5,
        endLine: 10,
        signature: 'function myFunction()',
      },
    ];

    const mockReferences = [
      {
        sourcePath: 'src/call.ts',
        sourceRef: 'line 15',
        relationType: 'calls',
        confidence: 0.95,
      },
    ];

    it('uses Postgres symbol references even when backend env is legacy', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.findSymbols.mockResolvedValueOnce({
        definitions: mockDefinitions,
        references: mockReferences,
      });

      const result = await handleFindSymbolReferences({
        projectId: 'project-123',
        symbolName: 'myFunction',
      });

      expect(postgresStoreMocks.findSymbols).toHaveBeenCalledWith(postgresStoreMocks.sql, 7, {
        name: 'myFunction',
        limit: 20,
      });
      expect(result.content[0].text).toContain('# Symbol References: "myFunction"');
      expect(result.content[0].text).toContain('## Definitions (1)');
      expect(result.content[0].text).toContain('## References (1)');
      expect(result.content[0].text).toContain('src/call.ts');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
      expect((result.structuredContent as any).data.referenceCount).toBe(1);
    });

    it('does not fake transitive references in Postgres mode', async () => {
      const result = await handleFindSymbolReferences({
        projectId: 'project-123',
        symbolName: 'myFunction',
        transitive: true,
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('does not support transitive symbol references');
    });

    it('returns empty references when none found', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.findSymbols.mockResolvedValueOnce({
        definitions: mockDefinitions,
        references: [],
      });

      const result = await handleFindSymbolReferences({
        projectId: 'project-123',
        symbolName: 'unusedFunction',
      });

      expect(result.content[0].text).toContain('No references found for this symbol');
      expect((result.structuredContent as any).data.referenceCount).toBe(0);
    });

    it('returns empty for no definitions', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.findSymbols.mockResolvedValueOnce({
        definitions: [],
        references: [],
      });

      const result = await handleFindSymbolReferences({
        projectId: 'project-123',
        symbolName: 'nonexistent',
      });

      expect(result.content[0].text).toContain('No symbols found with name "nonexistent"');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
    });

    it('throws on query error', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.findSymbols.mockRejectedValueOnce(new Error('Query failed'));

      const result = await handleFindSymbolReferences({
        projectId: 'project-123',
        symbolName: 'test',
      });

      expect((result as any).isError).toBe(true);
    });
  });

  describe('handleGetProjectSkeleton', () => {
    it('uses Postgres file skeleton even when backend env is legacy', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.getFileWithChunks.mockResolvedValueOnce({
        file: {
          sourcePath: 'src/myfile.ts',
          status: 'indexed',
          lang: 'typescript',
          sizeBytes: 500,
          skeletonText: 'export class MyClass { }\nexport function myFunc() { }',
          outlineVersion: '1.0',
        },
        chunks: [],
        chunkCount: 0,
      });

      const result = await handleGetProjectSkeleton({
        projectId: 'project-123',
        sourcePath: 'src/myfile.ts',
      });

      expect(result.content[0].text).toContain('# Skeleton: src/myfile.ts');
      expect(result.content[0].text).toContain('**Language:** typescript');
      expect(postgresStoreMocks.getFileWithChunks).toHaveBeenCalledWith(
        postgresStoreMocks.sql,
        7,
        'src/myfile.ts',
        { limit: 1 }
      );
      expect(result.content[0].text).toContain('# Skeleton: src/myfile.ts');
      expect(result.content[0].text).toContain('export class MyClass');
      expect((result.structuredContent as any).data.backend).toBe('postgres');
      expect((result.structuredContent as any).data.available).toBe(true);
    });

    it('returns project not found when registry lookup fails', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce(undefined);

      const result = await handleGetProjectSkeleton({
        projectId: 'project-123',
        sourcePath: 'src/myfile.ts',
      });

      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toContain('Project not found: project-123');
    });

    it('returns not found for missing skeleton', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.getFileWithChunks.mockResolvedValueOnce(null);

      const result = await handleGetProjectSkeleton({
        projectId: 'project-123',
        sourcePath: 'nonexistent.ts',
      });

      expect(result.content[0].text).toContain('File not found or no skeleton available');
    });

    it('returns no skeleton message when text is null', async () => {
      postgresStoreMocks.findProject.mockResolvedValueOnce({ id: 7 });
      postgresStoreMocks.getFileWithChunks.mockResolvedValueOnce({
        file: {
          sourcePath: 'unsupported.txt',
          status: 'indexed',
          lang: 'typescript',
          sizeBytes: 500,
          skeletonText: null,
          outlineVersion: '1.0',
        },
        chunks: [],
        chunkCount: 0,
      });

      const result = await handleGetProjectSkeleton({
        projectId: 'project-123',
        sourcePath: 'unsupported.txt',
      });

      expect(result.content[0].text).toContain('No skeleton available for this file');
      expect(result.structuredContent).toEqual({
        success: true,
        data: {
          backend: 'postgres',
          sourcePath: 'unsupported.txt',
          projectId: 'project-123',
          lang: 'typescript',
          outlineVersion: '1.0',
          sizeBytes: 500,
          skeletonText: '',
          available: false,
        },
      });
    });

    it('throws on query error', async () => {
      postgresStoreMocks.findProject.mockRejectedValueOnce(new Error('Query failed'));

      const result = await handleGetProjectSkeleton({
        projectId: 'project-123',
        sourcePath: 'test.ts',
      });

      expect((result as any).isError).toBe(true);
    });

    it('handles string errors', async () => {
      postgresStoreMocks.findProject.mockRejectedValueOnce('error string');

      const result = await handleGetProjectSkeleton({
        projectId: 'project-123',
        sourcePath: 'test.ts',
      });

      expect((result as any).isError).toBe(true);
    });
  });
});
