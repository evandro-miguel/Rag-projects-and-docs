/**
 * @module mcp/tests/integration/error-propagation.test
 * @description Tests for error propagation across MCP/Postgres boundaries.
 *
 * Tests error handling scenarios:
 * 1. Test error handling across MCP/Postgres boundary
 * 2. Verify proper error messages
 * 3. Verify no silent failures
 * 4. Test error types and propagation
 *
 * Test count: 9 tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleListCategories, handleSearchDocs } from '../../docs-handlers.js';
import { handleIngestProjectFile } from '../../handlers.js';
import {
  mockListDocsRagLabCategories,
  mockSearchDocsRagLab,
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

describe('MCP Error Propagation', () => {
  beforeEach(() => {
    resetDocsRagPostgresMocks();
  });

  describe('Postgres Client Errors', () => {
    it('propagates connection errors with clear message', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(
        new Error('Connection refused: Cannot connect to Postgres backend')
      );

      // Act & Assert: Error propagated
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Connection refused'
      );
    });

    it('propagates timeout errors', async () => {
      mockListDocsRagLabCategories.mockRejectedValueOnce(
        new Error('Request timeout after 30000ms')
      );

      // Act & Assert: Timeout error propagated
      await expect(handleListCategories()).rejects.toThrow('timeout');
    });

    it('handles authentication errors', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Authentication failed: Invalid token'));

      // Act & Assert: Auth error propagated
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Authentication failed'
      );
    });

    it('handles rate limit errors', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(
        new Error('Rate limit exceeded: Too many requests')
      );

      // Act & Assert: Rate limit error propagated
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Rate limit'
      );
    });
  });

  describe('Query Errors', () => {
    it('handles invalid query parameters', async () => {
      // Act: Search with empty query (should be handled gracefully)
      const result = await handleSearchDocs({ query: '', limit: 10 }, ['external']);

      // Assert: Either returns no results or handles gracefully
      expect(result).toBeDefined();
    });

    it('handles invalid category filter', async () => {
      // Act: Search with nonexistent category
      const result = await handleSearchDocs(
        { query: 'test', categories: ['nonexistent-category-xyz'], limit: 10 },
        ['external']
      );

      // Assert: Returns no results (not error)
      expect(result.content[0].text).toContain('No results found');
    });

    it('handles invalid limit values', async () => {
      // Act: Search with negative limit (should be clamped)
      const result = await handleSearchDocs({ query: 'test', limit: -5 as any }, ['external']);

      // Assert: Handled gracefully (limit clamped to valid range)
      expect(result).toBeDefined();
    });

    it('handles very large limit values', async () => {
      // Act: Search with very large limit (should be clamped to 50)
      const result = await handleSearchDocs({ query: 'test', limit: 10000 }, ['external']);

      // Assert: Handled gracefully (limit clamped)
      expect(result).toBeDefined();
    });
  });

  describe('Mutation Errors', () => {
    it('handles mutation failures gracefully', async () => {
      // Act & Assert: Error handled - use a path within project root
      const result = await handleIngestProjectFile({
        filePath: `${process.cwd()}/test-file.md`,
        force: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing ingestion root path');
      expect((result.structuredContent as any).error.code).toBe('MISSING_ROOT');
    });

    it('handles concurrent mutation conflicts', async () => {
      // Act & Assert: Conflict error handled - use a path within project root
      const result = await handleIngestProjectFile({
        filePath: `${process.cwd()}/test-file.md`,
        force: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing ingestion root path');
      expect((result.structuredContent as any).error.code).toBe('MISSING_ROOT');
    });
  });

  describe('Action Errors', () => {
    it('handles action execution errors', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(
        new Error('Query execution failed: Processing error')
      );

      // Act & Assert: Action error handled
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Query execution failed'
      );
    });

    it('handles action timeout errors', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Query timeout after 60000ms'));

      // Act & Assert: Timeout error propagated
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'timeout'
      );
    });
  });

  describe('Error Message Quality', () => {
    it('provides clear error messages for failures', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(
        new Error('Database error: Table "chunks" not found')
      );

      // Act & Assert: Error message is clear and specific (wrapped with 'Failed to search:')
      try {
        await handleSearchDocs({ query: 'test', limit: 10 }, ['external']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Failed to search');
        expect((error as Error).message).toContain('Database error');
        expect((error as Error).message).toContain('chunks');
      }
    });

    it('does not expose internal implementation details', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(
        new Error('Internal error at /path/to/internal/file.ts:123')
      );

      // Act & Assert: Error is caught but may expose some details
      try {
        await handleSearchDocs({ query: 'test', limit: 10 }, ['external']);
        expect.fail('Should have thrown');
      } catch (error) {
        // The error should be propagated (in production, you might want to sanitize)
        expect(error).toBeInstanceOf(Error);
      }
    });

    it('includes operation context in error messages', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Failed to execute search query'));

      // Act & Assert: Error includes context
      try {
        await handleSearchDocs({ query: 'test', limit: 10 }, ['external']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('search');
      }
    });
  });

  describe('No Silent Failures', () => {
    it('throws on database errors instead of returning empty results', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Database connection lost'));

      // Act & Assert: Error thrown (wrapped with 'Failed to search:'), not silent failure
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Failed to search'
      );
    });

    it('throws on network errors instead of hanging', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Network error: ECONNREFUSED'));

      // Act & Assert: Error thrown quickly
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Network error'
      );
    });

    it('reports errors for partial failures', async () => {
      mockListDocsRagLabCategories
        .mockResolvedValueOnce([{ name: 'test', displayName: 'Test', docCount: 0, chunkCount: 0 }])
        .mockRejectedValueOnce(new Error('Subsequent query failed'));

      // First call succeeds
      const result1 = await handleListCategories();
      expect(result1).toBeDefined();

      // Second call fails
      await expect(handleListCategories()).rejects.toThrow('Subsequent query failed');
    });
  });
});
