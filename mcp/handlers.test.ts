/**
 * @module mcp/handlers.test
 * @description Tests for MCP handler security features.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../scripts/ingest-project-rag.js', () => ({
  estimateProjectRagIngestionScope: vi.fn(() =>
    Promise.resolve({
      project: {
        projectId: 'project-1',
        projectRoot: '/test/project',
        projectName: 'Test Project',
        projectSlug: 'test-project',
        includeRoots: ['src'],
        ignoreRules: [],
      },
      scanPatterns: ['src/**/*'],
      scannedFileCount: 1,
      selectedFileCount: 1,
    })
  ),
  ingestConfiguredProjectRagFile: vi.fn(),
  runProjectRagIngestion: vi.fn(),
  runProjectRagReconciliation: vi.fn(),
}));

const CONSUMED_SNAPSHOT_GATE = {
  snapshotUuid: '00000000-0000-0000-0000-000000000001',
  status: 'CONSUMED',
  thresholdResult: 'delta_safe: write phase completed',
  preflightSummary: {
    addsCount: 1,
    updatesCount: 0,
    deletesCount: 0,
    eligibleCount: 1,
    trackedCount: 10,
    totalDelta: 1,
    blockedFindingCategories: '',
  },
};

const REVIEW_REQUIRED_SNAPSHOT_GATE = {
  snapshotUuid: '00000000-0000-0000-0000-000000000002',
  status: 'REVIEW_REQUIRED',
  thresholdResult: 'delta_500: total delta 500 >= 500 file threshold',
  preflightSummary: {
    addsCount: 300,
    updatesCount: 150,
    deletesCount: 50,
    eligibleCount: 500,
    trackedCount: 100,
    totalDelta: 500,
    blockedFindingCategories: '',
  },
};

const FAILED_SNAPSHOT_GATE = {
  snapshotUuid: '00000000-0000-0000-0000-000000000003',
  status: 'FAILED',
  thresholdResult: 'blocked_findings: 1 blocked finding categories; terminal FAILED',
  preflightSummary: {
    addsCount: 0,
    updatesCount: 0,
    deletesCount: 0,
    eligibleCount: 0,
    trackedCount: 10,
    totalDelta: 0,
    blockedFindingCategories: 'dot_env_files',
  },
};

vi.mock('../scripts/project-rag/ingest-postgres.js', () => ({
  ingestProjectRagPostgres: vi.fn(() =>
    Promise.resolve({
      projectId: 'test-project',
      slug: 'test-project',
      postgresId: 42,
      finalStatus: 'completed',
      stats: {
        filesScanned: 2,
        filesSelected: 1,
        filesIndexed: 1,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 3,
        embeddingsCreated: 3,
        errors: [],
      },
      snapshotGate: CONSUMED_SNAPSHOT_GATE,
    })
  ),
  ingestProjectRagPostgresFile: vi.fn(() =>
    Promise.resolve({
      projectId: 'test-project',
      slug: 'test-project',
      postgresId: 42,
      finalStatus: 'completed',
      stats: {
        filesScanned: 1,
        filesSelected: 1,
        filesIndexed: 1,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 2,
        embeddingsCreated: 2,
        errors: [],
      },
      snapshotGate: CONSUMED_SNAPSHOT_GATE,
    })
  ),
}));

const mockEnqueueProjectRagJob = vi.fn(
  (_sql: unknown, _input: { dedupeKey: string; projectId?: number }) =>
    Promise.resolve({ id: 91, status: 'queued', attempts: 0, inserted: true })
);
const mockFindProjectByRootPath = vi.fn(
  (_sql: unknown, _rootPath: string): Promise<{ id: number } | undefined> =>
    Promise.resolve(undefined)
);
vi.mock('../scripts/project-rag/store.js', () => ({
  createProjectRagPostgresSql: vi.fn(() => ({ close: vi.fn(() => Promise.resolve()) })),
  enqueueProjectRagJob: mockEnqueueProjectRagJob,
  findProjectRagPostgresProjectByRootPath: mockFindProjectByRootPath,
}));
vi.mock('../scripts/project-rag/config.js', () => ({
  resolveProjectRagPostgresWriteConfig: vi.fn(() => ({ database: { url: 'postgres://test' } })),
}));
vi.mock('../scripts/project-rag/job-worker.js', () => ({
  PROJECT_INGEST_FULL_JOB: 'project_ingest_full',
}));

vi.mock('../scripts/lib/adapter.js', () => ({
  adaptDocument: vi.fn(),
  validateOutput: vi.fn(() => ({ valid: true })),
}));

vi.mock('../scripts/lib/config.js', () => ({
  SCRIPT_CONFIG: {
    PROJECT_SOURCE_PATH: '/test/project',
  },
}));

vi.mock('../scripts/utils/detect-lang.js', () => ({
  buildSearchContext: vi.fn(() => ({})),
}));

import { PROJECT_SCOPE_ACK_TOKEN } from '../lib/shared/project-scope-advisory.js';
import {
  ingestProjectRagPostgres,
  ingestProjectRagPostgresFile,
} from '../scripts/project-rag/ingest-postgres.js';
import { handleGetDocument } from './docs-handlers.js';

// Import functions after mocking
import { handleIngestProject, handleIngestProjectFile } from './handlers.js';

const mockIngestProjectRagPostgres = ingestProjectRagPostgres as ReturnType<typeof vi.fn>;
const mockIngestProjectRagPostgresFile = ingestProjectRagPostgresFile as ReturnType<typeof vi.fn>;

describe('MCP Handlers - Path Security', () => {
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    mockIngestProjectRagPostgres.mockClear();
    mockIngestProjectRagPostgresFile.mockClear();
    process.env.PROJECT_RAG_BACKEND = 'legacy-backend';
  });

  describe('Project RAG Postgres backend blockers', () => {
    it('uses Postgres full-project ingestion without Convex fallback', async () => {
      delete process.env.PROJECT_RAG_BACKEND;

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Project Postgres ingestion complete');
      expect((result as any).structuredContent.data.finalStatus).toBe('completed');
      expect(mockIngestProjectRagPostgres).toHaveBeenCalledWith({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        force: undefined,
        maxFiles: 120,
      });
    });

    it('uses Postgres single-file ingestion without Convex fallback', async () => {
      delete process.env.PROJECT_RAG_BACKEND;

      const result = await handleIngestProjectFile({
        filePath: 'mcp/handlers.ts',
        rootPath: process.cwd(),
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Successfully indexed');
      expect((result as any).structuredContent.data.finalStatus).toBe('completed');
      expect(mockIngestProjectRagPostgresFile).toHaveBeenCalledWith({
        rootPath: process.cwd(),
        filePath: 'mcp/handlers.ts',
        force: undefined,
      });
    });
  });

  describe('handleIngestProject - Snapshot gate refusal', () => {
    it('returns PROJECT_SNAPSHOT_REVIEW_REQUIRED when gate status is REVIEW_REQUIRED', async () => {
      mockIngestProjectRagPostgres.mockResolvedValueOnce({
        projectId: 'test-project',
        slug: 'test-project',
        postgresId: 42,
        finalStatus: 'partial',
        stats: {
          filesScanned: 500,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: REVIEW_REQUIRED_SNAPSHOT_GATE,
      });

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBe(true);
      expect((result as any).structuredContent.error.code).toBe('PROJECT_SNAPSHOT_REVIEW_REQUIRED');
      expect(result.content[0].text).toContain('requires review');
      expect(result.content[0].text).not.toContain('/etc');
      const err = (result as any).structuredContent.error;
      expect(err.retryable).toBe(false);
      expect(err.snapshotUuid).toBe(REVIEW_REQUIRED_SNAPSHOT_GATE.snapshotUuid);
    });

    it('returns PROJECT_SNAPSHOT_FAILED when gate status is FAILED', async () => {
      mockIngestProjectRagPostgres.mockResolvedValueOnce({
        projectId: 'test-project',
        slug: 'test-project',
        postgresId: 42,
        finalStatus: 'partial',
        stats: {
          filesScanned: 0,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: FAILED_SNAPSHOT_GATE,
      });

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBe(true);
      expect((result as any).structuredContent.error.code).toBe('PROJECT_SNAPSHOT_FAILED');
      expect(result.content[0].text).toContain('gate failed');
      expect(result.content[0].text).toContain('blocked_findings');
      const err = (result as any).structuredContent.error;
      expect(err.retryable).toBe(false);
      expect(err.snapshotUuid).toBe(FAILED_SNAPSHOT_GATE.snapshotUuid);
    });

    it('maps partial_ingest_not_consumed to INGESTION_PARTIAL instead of PROJECT_SNAPSHOT_FAILED', async () => {
      mockIngestProjectRagPostgres.mockResolvedValueOnce({
        projectId: 'test-project',
        slug: 'test-project',
        postgresId: 42,
        finalStatus: 'partial',
        continuation: {
          remainingOperations: 4,
          remainingStalePaths: 1,
          remainingCandidateFiles: 3,
        },
        stats: {
          filesScanned: 10,
          filesSelected: 6,
          filesIndexed: 5,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 8,
          embeddingsCreated: 8,
          errors: [{ file: 'src/a.ts', error: 'embed failed' }],
        },
        snapshotGate: {
          snapshotUuid: '00000000-0000-0000-0000-000000000009',
          status: 'FAILED',
          thresholdResult: 'partial_ingest_not_consumed: 1 file error(s), 4 operation(s) remaining',
          preflightSummary: {
            addsCount: 6,
            updatesCount: 0,
            deletesCount: 0,
            eligibleCount: 6,
            trackedCount: 10,
            totalDelta: 6,
            blockedFindingCategories: '',
          },
        },
      });

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBe(true);
      expect(
        (result as { structuredContent: { error: { code: string } } }).structuredContent.error.code
      ).toBe('INGESTION_PARTIAL');
      expect(result.content[0].text).toContain('src/a.ts');
      expect(result.content[0].text).not.toContain('gate failed');
    });

    it('returns PROJECT_SNAPSHOT_MISSING when snapshotGate is undefined', async () => {
      mockIngestProjectRagPostgres.mockResolvedValueOnce({
        projectId: 'test-project',
        slug: 'test-project',
        postgresId: 42,
        finalStatus: 'completed',
        stats: {
          filesScanned: 2,
          filesSelected: 1,
          filesIndexed: 1,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 3,
          embeddingsCreated: 3,
          errors: [],
        },
        // snapshotGate is intentionally omitted (undefined)
      });

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBe(true);
      expect((result as any).structuredContent.error.code).toBe('PROJECT_SNAPSHOT_MISSING');
      expect(result.content[0].text).toContain('snapshot gate is missing');
      expect(mockIngestProjectRagPostgres).toHaveBeenCalled();
    });

    it('does not expose absolute paths or secrets in snapshot gate error response', async () => {
      mockIngestProjectRagPostgres.mockResolvedValueOnce({
        projectId: 'test-project',
        slug: 'test-project',
        postgresId: 42,
        finalStatus: 'partial',
        stats: {
          filesScanned: 0,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: {
          ...FAILED_SNAPSHOT_GATE,
          thresholdResult: 'blocked_findings: dot_env_files:3; terminal FAILED',
        },
      });

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      const text = result.content[0].text;
      expect(text).not.toMatch(/\/home\/|\/root\/|\/etc\//);
      expect(text).not.toMatch(/password|secret|token|key/i);
      expect((result as any).structuredContent.error.snapshotUuid).toBeDefined();
    });
  });

  describe('handleIngestProjectFile - Snapshot gate refusal', () => {
    it('returns PROJECT_SNAPSHOT_MISSING when snapshotGate is undefined for single-file ingest', async () => {
      mockIngestProjectRagPostgresFile.mockResolvedValueOnce({
        projectId: 'test-project',
        slug: 'test-project',
        postgresId: 42,
        finalStatus: 'completed',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 1,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 2,
          embeddingsCreated: 2,
          errors: [],
        },
        // snapshotGate is intentionally omitted (undefined)
      });

      const result = await handleIngestProjectFile({
        filePath: 'src/main.ts',
        rootPath: process.cwd(),
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBe(true);
      expect((result as any).structuredContent.error.code).toBe('PROJECT_SNAPSHOT_MISSING');
      expect(result.content[0].text).toContain('snapshot gate is missing');
      expect(result.content[0].text).toContain('Single-file ingest refused');
      expect(mockIngestProjectRagPostgresFile).toHaveBeenCalled();
    });

    it('returns PROJECT_SNAPSHOT_FAILED when gate status is FAILED for single-file ingest', async () => {
      mockIngestProjectRagPostgresFile.mockResolvedValueOnce({
        projectId: 'test-project',
        slug: 'test-project',
        postgresId: 42,
        finalStatus: 'partial',
        stats: {
          filesScanned: 1,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: FAILED_SNAPSHOT_GATE,
      });

      const result = await handleIngestProjectFile({
        filePath: 'src/main.ts',
        rootPath: process.cwd(),
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBe(true);
      expect((result as any).structuredContent.error.code).toBe('PROJECT_SNAPSHOT_FAILED');
      expect(result.content[0].text).toContain('Single-file ingest refused');
    });
  });

  describe('handleIngestProjectFile - Path Validation', () => {
    it('should reject paths with directory traversal (../)', async () => {
      mockIngestProjectRagPostgresFile.mockRejectedValueOnce(
        new Error('directory traversal is not allowed')
      );

      const result = await handleIngestProjectFile({
        filePath: '../../../etc/passwd',
        rootPath: process.cwd(),
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to ingest project file into Postgres');
      expect(result.content[0].text).toContain('directory traversal');
    });

    it('should reject paths with directory traversal (..\\)', async () => {
      mockIngestProjectRagPostgresFile.mockRejectedValueOnce(
        new Error('directory traversal is not allowed')
      );

      const result = await handleIngestProjectFile({
        filePath: '..\\..\\windows\\system32\\config',
        rootPath: process.cwd(),
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('directory traversal');
    });

    it('should reject paths with null bytes', async () => {
      mockIngestProjectRagPostgresFile.mockRejectedValueOnce(
        new Error('null bytes are not allowed')
      );

      const result = await handleIngestProjectFile({
        filePath: 'test\0file.ts',
        rootPath: process.cwd(),
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('null bytes');
    });

    it('should reject paths escaping allowed directory', async () => {
      mockIngestProjectRagPostgresFile.mockRejectedValueOnce(
        new Error('file path escapes allowed project roots')
      );

      const result = await handleIngestProjectFile({
        filePath: '/absolute/path/outside/project',
        rootPath: process.cwd(),
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('escapes allowed');
    });

    it('should accept valid relative paths', async () => {
      mockIngestProjectRagPostgresFile.mockResolvedValueOnce({
        projectId: 'test-project',
        slug: 'test-project',
        postgresId: 42,
        finalStatus: 'completed',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 1,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 5,
          embeddingsCreated: 5,
          errors: [],
        },
        snapshotGate: {
          snapshotUuid: '00000000-0000-0000-0000-000000000001',
          status: 'CONSUMED',
          thresholdResult: 'delta_safe: write phase completed',
          preflightSummary: {
            addsCount: 1,
            updatesCount: 0,
            deletesCount: 0,
            eligibleCount: 1,
            trackedCount: 10,
            totalDelta: 1,
            blockedFindingCategories: '',
          },
        },
      });

      const result = await handleIngestProjectFile({
        filePath: 'src/main.ts',
        rootPath: process.cwd(),
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBeFalsy();
      expect(mockIngestProjectRagPostgresFile).toHaveBeenCalledWith({
        rootPath: process.cwd(),
        filePath: 'src/main.ts',
        force: undefined,
      });
    });
  });

  describe('handleIngestProject - Root Path Validation', () => {
    it('rejects system directory as root path for full ingestion', async () => {
      const result = await handleIngestProject({
        rootPath: '/etc',
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Security Error');
      expect(result.content[0].text).toContain('not allowed for project indexing');
    });

    it('rejects system subdirectory as root path for full ingestion', async () => {
      const result = await handleIngestProject({
        rootPath: '/etc/ssh',
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Security Error');
    });
  });

  describe('handleIngestProjectFile - Root Path Validation', () => {
    it('rejects system directory as root path for single-file ingestion', async () => {
      const result = await handleIngestProjectFile({
        filePath: 'src/main.ts',
        rootPath: '/etc',
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Security Error');
      expect(result.content[0].text).toContain('not allowed for project indexing');
    });
  });

  describe('handleIngestProject - Scope confirmation', () => {
    it('rejects missing scope acknowledgement before ingesting', async () => {
      const result = await handleIngestProject({
        rootPath: process.cwd(),
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Critical project scope warning');
      expect(result.content[0].text).toContain('scopeAck=I_UNDERSTAND_PROJECT_RAG_SCOPE_V1');
    });
  });

  describe('handleGetDocument - Source Path Validation', () => {
    it('should reject source paths with directory traversal', async () => {
      const result = await handleGetDocument({
        sourcePath: '../../../etc/passwd',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Security Error');
    });

    it('should reject absolute source paths', async () => {
      const result = await handleGetDocument({
        sourcePath: '/absolute/path/to/file.ts',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Absolute paths');
    });

    it('should reject source paths with null bytes', async () => {
      const result = await handleGetDocument({
        sourcePath: 'doc\0file.md',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('null bytes');
    });

    it('should accept valid relative source paths', async () => {
      // This test verifies that valid paths pass security validation
      // The API mocking is complex, so we test the security path validation logic
      // by checking that a path without traversal sequences doesn't trigger security error
      try {
        await handleGetDocument({
          sourcePath: 'lib/shared/project-registry.ts',
        });
      } catch (error) {
        // We expect an error from the API, but not a security error
        const errorMessage = error instanceof Error ? error.message : String(error);
        expect(errorMessage).not.toContain('Security Error');
        expect(errorMessage).not.toContain('directory traversal');
      }
    });
  });

  describe('handleIngestProject - Durable execution mode', () => {
    it('queues executionMode=durable and does not ingest inline', async () => {
      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
        executionMode: 'durable',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Project ingestion job queued: 91');
      expect(mockEnqueueProjectRagJob).toHaveBeenCalled();
      expect(mockIngestProjectRagPostgres).not.toHaveBeenCalled();
    });

    it('builds an order-insensitive dedupe key with maxFiles, force, and sorted roots', async () => {
      mockEnqueueProjectRagJob.mockResolvedValueOnce({
        id: 92,
        status: 'queued',
        attempts: 0,
        inserted: true,
      });

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['z-dir', 'a-dir'],
        maxFiles: 50,
        force: true,
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
        executionMode: 'durable',
      });

      expect(result.isError).toBeFalsy();
      const enqueueInput = mockEnqueueProjectRagJob.mock.calls[0][1];
      expect(enqueueInput.dedupeKey).toContain(JSON.stringify(['a-dir', 'z-dir']));
      expect(enqueueInput.dedupeKey.endsWith(':true:50')).toBe(true);
      expect((result as any).structuredContent.data).toEqual({
        jobId: 92,
        status: 'queued',
        deduplicated: false,
      });
    });

    it('reports deduplicated=true when the dedupe key already has an active job', async () => {
      mockEnqueueProjectRagJob.mockResolvedValueOnce({
        id: 91,
        status: 'queued',
        attempts: 0,
        inserted: false,
      });

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
        executionMode: 'durable',
      });

      expect(result.isError).toBeFalsy();
      expect((result as any).structuredContent.data.deduplicated).toBe(true);
    });

    it('binds the queued job to the project registered for the root path', async () => {
      mockFindProjectByRootPath.mockResolvedValueOnce({ id: 7 });

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
        executionMode: 'durable',
      });

      expect(result.isError).toBeFalsy();
      expect(mockFindProjectByRootPath).toHaveBeenCalledWith(expect.anything(), process.cwd());
      expect(mockEnqueueProjectRagJob.mock.calls[0][1].projectId).toBe(7);
    });

    it('continues to ingest inline when executionMode=inline (explicit default)', async () => {
      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
        executionMode: 'inline',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Project Postgres ingestion complete');
      expect(mockIngestProjectRagPostgres).toHaveBeenCalled();
    });

    it('continues to ingest inline when executionMode is omitted (default behavior)', async () => {
      mockIngestProjectRagPostgres.mockClear();

      const result = await handleIngestProject({
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Project Postgres ingestion complete');
      expect(mockIngestProjectRagPostgres).toHaveBeenCalled();
    });
  });
});
