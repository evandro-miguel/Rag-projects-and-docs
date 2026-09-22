import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGetProjectFile } from '../../mcp/project-handlers.js';
import { runRagctl } from '../ragctl.js';
import {
  createProjectRagApplicationService,
  type ProjectRagApplicationRuntime,
  setProjectRagApplicationRuntimeForTesting,
} from './application-service.js';
import { resolveProjectRagWorkspaceContext } from './context.js';

const serving = {
  status: 'serving' as const,
  buildId: 42,
  revisionId: 7,
  publishedAt: '2026-08-23T00:00:00.000Z',
  fileCount: 1,
  versionCount: 1,
  dirtyDigest: 'd'.repeat(64),
  provenance: {
    repositoryHash: 'r'.repeat(64),
    workspaceHash: 'w'.repeat(64),
    headOid: 'h'.repeat(40),
    branchName: 'main',
    isDetached: false,
    isUnborn: false,
    headHash: 'a'.repeat(64),
    branchHash: 'b'.repeat(64),
    detachedHash: null,
    contentHash: 'c'.repeat(64),
    contentFingerprint: 'f'.repeat(64),
    statusDigest: 's'.repeat(64),
    identityDigest: 'i'.repeat(64),
  },
};

function makeRuntime(
  overrides: Record<string, unknown> = {},
  projectOverrides: Record<string, unknown> = {},
  activeServing: typeof serving = serving
) {
  const project = {
    id: 7,
    name: 'Example',
    slug: 'example',
    rootPath: process.cwd(),
    normalizedRootPath: process.cwd(),
    status: 'active',
    includeRoots: ['src'],
    ignoreRules: [],
    ephemeral: false,
    blockedFindingAllowlist: [],
    ...projectOverrides,
  };
  const fileResult = {
    buildId: 42,
    versionId: 9,
    file: {
      sourcePath: 'src/main.ts',
      status: 'indexed',
      lang: 'typescript',
      sizeBytes: 12,
      updatedAt: 1_700_000_000_000,
    },
    chunks: [{ chunkIndex: 0, content: 'export const value = 1;', startLine: 1, endLine: 1 }],
    chunkCount: 1,
  };
  const store = {
    createProjectRagPostgresSql: vi.fn(() => ({}) as never),
    findProjectRagPostgresProject: vi.fn(async () => project),
    getProjectRagPostgresProjectStats: vi.fn(),
    getProjectRagPostgresPublishedBuildState: vi.fn(async () => ({
      buildId: 42,
      dirtyDigest: activeServing.dirtyDigest,
    })),
    getProjectRagPostgresServingState: vi.fn(async () => activeServing),
    searchProjectRagPostgresChunks: vi.fn(),
    getProjectRagPostgresFileWithChunks: vi.fn(async () => fileResult),
    getProjectRagPostgresFileOutline: vi.fn(),
    findProjectRagPostgresSymbols: vi.fn(),
    closeProjectRagPostgresSql: vi.fn(),
    ...overrides,
  };
  return {
    config: {
      resolveProjectRagPostgresConfigWithLocalDefault: vi.fn(() => ({
        database: { url: 'postgres://test' },
      })),
      resolveProjectRagPostgresWriteConfig: vi.fn(),
    },
    embeddings: {
      resolveProjectRagPostgresEmbeddingConfig: vi.fn(),
      fetchProjectRagPostgresEmbeddings: vi.fn(),
    },
    store,
    project,
    fileResult,
  } as unknown as ProjectRagApplicationRuntime & {
    store: typeof store;
    project: typeof project;
    fileResult: typeof fileResult;
  };
}

afterEach(() => {
  setProjectRagApplicationRuntimeForTesting(null);
});

describe('Project RAG application service boundary', () => {
  it('binds file reads to one serving build and exposes provenance to both adapters', async () => {
    const workspace = await resolveProjectRagWorkspaceContext(process.cwd(), undefined, {
      includeRoots: ['src'],
      ignoreRules: [],
    });
    const runtime = makeRuntime(
      {},
      { includeRoots: ['src'] },
      {
        ...serving,
        dirtyDigest: workspace.dirtyDigest,
        provenance: { ...serving.provenance, identityDigest: workspace.identityDigest },
      }
    );
    setProjectRagApplicationRuntimeForTesting(runtime);

    const service = createProjectRagApplicationService();
    const domain = await service.getProjectFile({ project: 'example', file: 'src/main.ts' });
    const mcp = await handleGetProjectFile({ projectId: 'example', sourcePath: 'src/main.ts' });
    const cli = await runRagctl([
      'project',
      'file',
      '--project',
      'example',
      '--file',
      'src/main.ts',
      '--full',
    ]);

    expect(runtime.store.getProjectRagPostgresFileWithChunks).toHaveBeenCalledWith(
      expect.anything(),
      7,
      'src/main.ts',
      { limit: 20, buildId: 42 }
    );
    expect((mcp.structuredContent as any).data).toMatchObject({
      buildId: domain.buildId,
      versionId: domain.versionId,
      provenance: domain.provenance,
    });
    expect(JSON.parse(cli.stdout).data).toMatchObject({
      buildId: domain.buildId,
      versionId: domain.versionId,
      provenance: domain.provenance,
    });
  });

  it('returns the same not-found code and message through CLI and MCP', async () => {
    const runtime = makeRuntime({
      findProjectRagPostgresProject: vi.fn(async () => undefined),
    });
    setProjectRagApplicationRuntimeForTesting(runtime);

    const mcp = await handleGetProjectFile({ projectId: 'missing', sourcePath: 'src/main.ts' });
    const cli = await runRagctl([
      'project',
      'file',
      '--project',
      'missing',
      '--file',
      'src/main.ts',
    ]);

    expect((mcp.structuredContent as any).error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Project not found: missing',
    });
    expect(JSON.parse(cli.stdout).error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Project not found: missing',
    });
    expect(cli.exitCode).toBe(4);
  });

  it('returns the same invalid-input code and message for a blank file', async () => {
    const runtime = makeRuntime();
    setProjectRagApplicationRuntimeForTesting(runtime);

    const mcp = await handleGetProjectFile({ projectId: 'example', sourcePath: ' ' });
    const cli = await runRagctl(['project', 'file', '--project', 'example', '--file', ' ']);

    expect((mcp.structuredContent as any).error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'file is required',
    });
    expect(JSON.parse(cli.stdout).error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'file is required',
    });
    expect(cli.exitCode).toBe(2);
  });

  it('fails closed before embeddings or old-build search when provenance drifts', async () => {
    const search = vi.fn(async () => []);
    const fetchEmbeddings = vi.fn(async () => [[0.1]]);
    const runtime = makeRuntime(
      { searchProjectRagPostgresChunks: search },
      { includeRoots: ['src'] }
    );
    runtime.embeddings.resolveProjectRagPostgresEmbeddingConfig = vi.fn(() => ({
      provider: 'test',
      model: 'test-model',
      dimensions: 1024,
      profileHash: 'p'.repeat(64),
      baseUrl: 'http://127.0.0.1:1',
    })) as never;
    runtime.embeddings.fetchProjectRagPostgresEmbeddings = fetchEmbeddings as never;
    setProjectRagApplicationRuntimeForTesting(runtime);

    const service = createProjectRagApplicationService();
    await expect(
      service.searchProject({ project: 'example', query: 'stale query' })
    ).rejects.toMatchObject({ code: 'STALE' });
    expect(fetchEmbeddings).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});
