/**
 * @module mcp/tests/integration/full-flow.test
 * @description Full integration tests for MCP tools with Postgres-backed handlers.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../../lib/shared/project-scope-advisory.js';
import { ingestProjectRagPostgresFile } from '../../../scripts/project-rag/ingest-postgres.js';
import {
  handleGetDocument,
  handleHealthCheck,
  handleListCategories,
  handleSearchDocs,
} from '../../docs-handlers.js';
import { handleIngestProjectFile } from '../../handlers.js';
import {
  mockCheckDocsRagLabDatabaseHealth,
  mockGetDocsRagLabDocumentByPath,
  mockListDocsRagLabCategories,
  mockSearchDocsRagLab,
  postgresSearchReport,
  resetDocsRagPostgresMocks,
} from '../helpers/docs-rag-postgres.js';

vi.mock('../../../scripts/docs-rag/db.js', () => ({
  checkDocsRagLabDatabaseHealth: vi.fn(),
  checkDocsRagLabCorpusHealth: vi.fn(async () => ({
    status: 'healthy',
    documents: 1,
    unexpectedSourceIds: [],
    invalidPathCount: 0,
    sourcePathMismatchCount: 0,
    missingMetadataCount: 0,
    message: 'Corpus inventory is clean.',
  })),
}));
vi.mock('../../../scripts/docs-rag/store.js', () => ({
  DOCS_RAG_REQUIRED_PROVENANCE_FIELDS: ['canonicalUrl', 'sourceRevision', 'syncedAt', 'authority'],
  getDocsRagLabDocumentByPath: vi.fn(),
  listDocsRagLabCategories: vi.fn(),
  searchDocsRagLab: vi.fn(),
}));
vi.mock('../../../scripts/project-rag/ingest-postgres.js', () => ({
  ingestProjectRagPostgresFile: vi.fn(),
}));

const mockIngestProjectRagPostgresFile = ingestProjectRagPostgresFile as ReturnType<typeof vi.fn>;

// Shared CONSUMED snapshot gate fixture matching production buildGateResult.
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

describe('MCP Full Integration Flow', () => {
  beforeEach(() => {
    resetDocsRagPostgresMocks();
    mockIngestProjectRagPostgresFile.mockReset();
  });

  describe('handleSearchDocs', () => {
    it('search_docs returns results from Postgres', async () => {
      const result = await handleSearchDocs({ query: 'TypeScript interfaces', limit: 10 });

      expect(result.content[0].text).toContain('Found 1 results');
      expect(result.content[0].text).toContain('Getting Started');
    });

    it('search_docs returns no results message when nothing found', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(postgresSearchReport([]));

      const result = await handleSearchDocs({ query: 'nonexistent topic xyz', limit: 10 }, [
        'external',
      ]);

      expect(result.content[0].text).toContain('No results found');
    });
  });

  describe('handleListCategories', () => {
    it('list_categories returns all categories', async () => {
      const result = await handleListCategories();

      expect(result.content[0].text).toContain('React 19');
      expect(result.content[0].text).toContain('Bun');
      expect(result.content[0].text).toContain('10');
      expect(result.content[0].text).toContain('50');
    });

    it('list_categories returns empty message when no categories', async () => {
      mockListDocsRagLabCategories.mockResolvedValueOnce([]);

      const result = await handleListCategories();

      expect(result.content[0].text).toContain('No categories found');
    });
  });

  describe('handleGetDocument', () => {
    it('get_document retrieves full document content', async () => {
      const result = await handleGetDocument({ sourcePath: 'bun-docs/full/doc.md' });

      expect(result.content[0].text).toContain('# Full Document');
      expect(result.content[0].text).toContain('Introduction');
      expect(result.content[0].text).toContain('Main Content');
    });

    it('get_document returns not found for missing document', async () => {
      mockGetDocsRagLabDocumentByPath.mockResolvedValueOnce(null);

      const result = await handleGetDocument({ sourcePath: 'bun-docs/nonexistent/doc.md' });

      expect(result.content[0].text).toContain('Document not found');
    });
  });

  describe('handleHealthCheck', () => {
    it('health_check returns OK status', async () => {
      const result = await handleHealthCheck();

      expect(result.content[0].text).toContain('MCP Server: OK');
      expect(result.content[0].text).toContain('Docs RAG Postgres: OK');
      expect(result.content[0].text).toMatch(/\(\d+ms\)/);
    });

    it('health_check handles backend failure', async () => {
      mockCheckDocsRagLabDatabaseHealth.mockResolvedValueOnce({
        status: 'unhealthy',
        method: 'bun-sql',
        target: 'postgres://redacted',
        latencyMs: 1,
        message: 'Connection failed',
        warnings: [],
      });

      const result = await handleHealthCheck();

      expect(result.content[0].text).toContain('MCP Server: OK');
      expect(result.content[0].text).toContain('Docs RAG Postgres: ERROR');
      expect(result.isError).toBe(true);
    });
  });

  describe('handleIngestProjectFile', () => {
    it('ingest_project_file indexes new file', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'rag-v1-ingest-project-'));
      const docsDir = join(projectRoot, 'docs');
      const testFilePath = join(docsDir, 'test-ingest-file.md');

      await mkdir(docsDir, { recursive: true });
      await writeFile(testFilePath, '# Test File\n\nContent for ingestion test.\n\n');

      mockIngestProjectRagPostgresFile.mockResolvedValueOnce({
        projectId: 'integration-project',
        slug: 'integration-project',
        postgresId: 1,
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
      });

      try {
        const result = await handleIngestProjectFile({
          filePath: testFilePath,
          force: false,
          rootPath: projectRoot,
          scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        });

        expect(result.isError).not.toBe(true);
        expect(result.content[0].text).toContain('Successfully indexed');
        expect(mockIngestProjectRagPostgresFile).toHaveBeenCalledWith({
          rootPath: projectRoot,
          filePath: testFilePath,
          force: false,
        });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('ingest_project_file returns error for nonexistent file', async () => {
      mockIngestProjectRagPostgresFile.mockRejectedValueOnce(new Error('File not found'));

      const result = await handleIngestProjectFile({
        filePath: `${process.cwd()}/nonexistent-file-that-does-not-exist.md`,
        force: false,
        rootPath: process.cwd(),
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.content[0].text).toContain('Failed to ingest project file into Postgres');
      expect(result.content[0].text).toContain('File not found');
      expect(result.isError).toBe(true);
    });
  });

  describe('Cross-Tool Integration', () => {
    it('full flow: list -> search -> get -> health', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(
        postgresSearchReport([
          {
            sourceId: 'integration',
            sourcePath: 'integration/doc.md',
            title: 'Integration Doc',
            content: 'Full flow integration test content.',
            section: 'Overview',
          },
        ])
      );
      mockGetDocsRagLabDocumentByPath.mockResolvedValueOnce({
        document: { title: 'Integration Doc', sourcePath: 'integration/doc.md' },
        chunks: [{ chunkIndex: 0, content: '# Integration\n\nFull flow test.\n\n' }],
      });

      const initialCategories = await handleListCategories();
      expect(initialCategories.content[0].text).toContain('Available Categories');

      const searchResult = await handleSearchDocs({ query: 'integration test', limit: 10 });
      expect(searchResult.content[0].text).toContain('Integration Doc');

      const getDocResult = await handleGetDocument({ sourcePath: 'bun-docs/integration/doc.md' });
      expect(getDocResult.content[0].text).toContain('# Integration');

      const healthResult = await handleHealthCheck();
      expect(healthResult.content[0].text).toContain('OK');
    });
  });
});
