/**
 * @module mcp/tests/integration/concurrent-requests.test
 * @description Tests for concurrent MCP request handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetDocument, handleHealthCheck, handleListCategories } from '../../docs-handlers.js';
import {
  mockCheckDocsRagLabDatabaseHealth,
  mockGetDocsRagLabDocumentByPath,
  mockListDocsRagLabCategories,
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
  getDocsRagLabDocumentByPath: vi.fn(),
  listDocsRagLabCategories: vi.fn(),
  searchDocsRagLab: vi.fn(),
}));

type CategoryFixture = {
  readonly name: string;
  readonly displayName: string;
  readonly docCount: number;
  readonly chunkCount: number;
};

type DocumentFixture = {
  readonly title: string;
  readonly sourcePath: string;
  readonly chunks: readonly string[];
};

function useDocsFixture(category: CategoryFixture, document: DocumentFixture) {
  mockListDocsRagLabCategories.mockResolvedValue([category]);
  mockGetDocsRagLabDocumentByPath.mockResolvedValue({
    document: { title: document.title, sourcePath: document.sourcePath },
    chunks: document.chunks.map((content, chunkIndex) => ({ chunkIndex, content })),
  });
}

describe('MCP Concurrent Requests', () => {
  beforeEach(() => {
    resetDocsRagPostgresMocks();
  });

  describe('Parallel Operations', () => {
    it('handles 10+ parallel category requests without errors', async () => {
      useDocsFixture(
        { name: 'concurrent-test', displayName: 'Concurrent Test', docCount: 5, chunkCount: 15 },
        { title: 'Concurrent Doc', sourcePath: 'concurrent/doc.md', chunks: ['Concurrent chunk'] }
      );

      const startTime = Date.now();
      const results = await Promise.all(Array.from({ length: 15 }, () => handleListCategories()));
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(15);
      expect(duration).toBeLessThan(10000);
      for (const result of results) {
        expect(result.content[0].text).toContain('Concurrent Test');
      }
      expect(mockListDocsRagLabCategories).toHaveBeenCalledTimes(15);
    });

    it('keeps consistent mocked Postgres results under concurrent load', async () => {
      useDocsFixture(
        { name: 'consistency-test', displayName: 'Consistency Test', docCount: 3, chunkCount: 9 },
        {
          title: 'Consistency Doc',
          sourcePath: 'consistency/doc-1.md',
          chunks: ['line 1', 'line 2', 'line 3'],
        }
      );

      const results = await Promise.all([
        ...Array.from({ length: 10 }, () => handleListCategories()),
        ...Array.from({ length: 5 }, () => handleHealthCheck()),
        ...Array.from({ length: 5 }, () =>
          handleGetDocument({ sourcePath: 'bun-docs/consistency/doc-1.md' })
        ),
      ]);

      expect(results).toHaveLength(20);
      expect(results.every((result) => result !== undefined)).toBe(true);
      expect(mockListDocsRagLabCategories).toHaveBeenCalledTimes(10);
      expect(mockCheckDocsRagLabDatabaseHealth).toHaveBeenCalledTimes(5);
      expect(mockGetDocsRagLabDocumentByPath).toHaveBeenCalledTimes(5);
    });

    it('handles concurrent requests for the same category query', async () => {
      useDocsFixture(
        { name: 'same-query-test', displayName: 'Same Query Test', docCount: 2, chunkCount: 4 },
        { title: 'Same Query Doc', sourcePath: 'same-query/doc.md', chunks: ['same query'] }
      );

      const results = await Promise.all(Array.from({ length: 20 }, () => handleListCategories()));

      expect(results).toHaveLength(20);
      for (const result of results) {
        expect(result.content[0].text).toContain('Same Query Test');
      }
    });
  });

  describe('Mixed Operation Concurrency', () => {
    it('handles mixed concurrent operations', async () => {
      useDocsFixture(
        { name: 'mixed-test', displayName: 'Mixed Test', docCount: 2, chunkCount: 4 },
        { title: 'Mixed Doc', sourcePath: 'mixed/doc.md', chunks: ['mixed content'] }
      );

      const results = await Promise.all([
        handleListCategories(),
        handleListCategories(),
        handleGetDocument({ sourcePath: 'bun-docs/mixed/doc.md' }),
        handleHealthCheck(),
        handleGetDocument({ sourcePath: 'bun-docs/mixed/doc.md' }),
        handleListCategories(),
        handleHealthCheck(),
        handleHealthCheck(),
      ]);

      expect(results).toHaveLength(8);
      expect(results.every((result) => result !== undefined)).toBe(true);
    });

    it('handles rapid sequential requests', async () => {
      useDocsFixture(
        { name: 'rapid-test', displayName: 'Rapid Test', docCount: 1, chunkCount: 2 },
        { title: 'Rapid Doc', sourcePath: 'rapid/doc.md', chunks: ['rapid content'] }
      );

      const results = [];
      for (let i = 0; i < 50; i++) {
        results.push(await handleListCategories());
      }

      expect(results).toHaveLength(50);
      expect(results.every((result) => result !== undefined)).toBe(true);
      expect(mockListDocsRagLabCategories).toHaveBeenCalledTimes(50);
    });
  });

  describe('Stress Testing', () => {
    it('handles 50+ concurrent health checks', async () => {
      const results = await Promise.all(Array.from({ length: 50 }, () => handleHealthCheck()));

      expect(results).toHaveLength(50);
      expect(results.every((result) => result !== undefined)).toBe(true);
      expect(mockCheckDocsRagLabDatabaseHealth).toHaveBeenCalledTimes(50);
    });

    it('has no shared-state race across concurrent reads', async () => {
      // ponytail: concurrency target is the MCP handler layer; Postgres behavior is covered by store tests.
      useDocsFixture(
        { name: 'race-test', displayName: 'Race Test', docCount: 1, chunkCount: 5 },
        {
          title: 'Race Condition Doc',
          sourcePath: 'race/doc.md',
          chunks: ['chunk 1', 'chunk 2', 'chunk 3', 'chunk 4', 'chunk 5'],
        }
      );

      const results = await Promise.all([
        ...Array.from({ length: 20 }, () => handleListCategories()),
        ...Array.from({ length: 10 }, () =>
          handleGetDocument({ sourcePath: 'bun-docs/race/doc.md' })
        ),
        ...Array.from({ length: 10 }, () => handleHealthCheck()),
      ]);

      expect(results).toHaveLength(40);
      expect(mockListDocsRagLabCategories).toHaveBeenCalledTimes(20);
      expect(mockGetDocsRagLabDocumentByPath).toHaveBeenCalledTimes(10);
      expect(mockCheckDocsRagLabDatabaseHealth).toHaveBeenCalledTimes(10);
      for (const result of results.slice(20, 30)) {
        expect(result.content[0].text).toContain('Race Condition Doc');
      }
    });
  });
});
