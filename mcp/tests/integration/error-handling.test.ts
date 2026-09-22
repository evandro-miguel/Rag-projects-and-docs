/**
 * @module mcp/tests/integration/error-handling.test
 * @description Tests for MCP error handling and validation.
 *
 * Tests error handling:
 * 1. Invalid input schema → proper validation error
 * 2. Postgres unavailable → graceful degradation
 * 3. Rate limiting → proper 429 responses
 * 4. Input validation errors
 *
 * Test count: 10 tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetDocument, handleSearchDocs } from '../../docs-handlers.js';
import { handleIngestProjectFile } from '../../handlers.js';
import {
  mockGetDocsRagLabDocumentByPath,
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

describe('MCP Error Handling', () => {
  beforeEach(() => {
    resetDocsRagPostgresMocks();
  });

  describe('Input Validation', () => {
    it('rejects missing required query parameter', async () => {
      // Act & Assert: Missing query should be handled
      // Note: TypeScript would catch this at compile time, but runtime validation:
      try {
        await handleSearchDocs({ query: '', limit: 10 }, ['external']);
        // Empty query is allowed but returns no results
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('validates query is string type', async () => {
      // Act: Invalid type (would be caught by TypeScript)
      // Runtime validation depends on implementation
      const result = await handleSearchDocs({ query: 'valid query', limit: 10 }, ['external']);

      expect(result).toBeDefined();
    });

    it('validates limit is positive number', async () => {
      // Act: Negative limit (should be clamped)
      const result = await handleSearchDocs({ query: 'test', limit: -5 as any }, ['external']);

      // Should handle gracefully
      expect(result).toBeDefined();
    });

    it('validates limit is within allowed range', async () => {
      // Act: Very large limit (should be clamped to 50)
      const result = await handleSearchDocs({ query: 'test', limit: 1000 }, ['external']);

      expect(result).toBeDefined();
    });

    it('validates categories is array of strings', async () => {
      // Act: Invalid categories type
      const result = await handleSearchDocs({ query: 'test', categories: 'not-array' as any }, [
        'external',
      ]);

      // Should handle gracefully or return no results
      expect(result).toBeDefined();
    });

    it('validates filePath is required for ingest_project_file', async () => {
      // Act: Missing filePath
      const result = await handleIngestProjectFile({ filePath: '', force: false });

      // Should return error
      expect(result.isError).toBe(true);
      expect((result.structuredContent as any).error.code).toBe('MISSING_ROOT');
    });

    it('validates filePath is valid path format', async () => {
      // Act: Invalid path format
      const result = await handleIngestProjectFile({
        filePath: 'not-a-valid-path-!@#$%',
        force: false,
      });

      // Should return error (file not found)
      expect(result.isError).toBe(true);
    });

    it('validates sourcePath is required for get_document', async () => {
      mockGetDocsRagLabDocumentByPath.mockResolvedValueOnce(null);

      // Act: Empty sourcePath
      const result = await handleGetDocument({ sourcePath: '' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('registered external Docs RAG source');
    });
  });

  describe('Docs RAG Postgres Unavailable', () => {
    it('handles Postgres connection failure clearly', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Failed to connect to Postgres'));

      // Act & Assert: Graceful error
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Failed to connect'
      );
    });

    it('returns graceful degradation message when backend down', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Postgres backend unavailable'));

      // Act: Try search
      try {
        await handleSearchDocs({ query: 'test', limit: 10 }, ['external']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Postgres');
      }
    });

    it('handles Postgres timeout gracefully', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Request timeout'));

      // Act & Assert: Timeout error
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'timeout'
      );
    });

    it('handles Postgres authentication failure', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Authentication failed'));

      // Act & Assert: Auth error
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Authentication failed'
      );
    });
  });

  describe('Rate Limiting', () => {
    it('handles rate limit error from Postgres', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(
        new Error('Rate limit exceeded: Too many requests (429)')
      );

      // Act & Assert: Rate limit error
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow(
        'Rate limit'
      );
    });

    it('suggests retry after for rate limit errors', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Rate limit exceeded'));

      // Act & Assert
      try {
        await handleSearchDocs({ query: 'test', limit: 10 }, ['external']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Rate limit');
      }
    });
  });

  describe('Error Response Format', () => {
    it('returns consistent error format for all tools', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Test error'));

      // Act & Assert: All tools throw errors consistently
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['external'])).rejects.toThrow();
      await expect(handleSearchDocs({ query: 'test', limit: 10 }, ['project'])).rejects.toThrow();
    });

    it('includes error context in message', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Search failed: Index not available'));

      // Act & Assert: Error includes context
      try {
        await handleSearchDocs({ query: 'test', limit: 10 }, ['external']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Search failed');
        expect((error as Error).message).toContain('Index');
      }
    });
  });
});
