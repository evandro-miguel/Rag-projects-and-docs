/**
 * Tests for lib/schemas - Zod validation schemas
 */

import { describe, expect, it } from 'vitest';
import {
  CategoriesRequestSchema,
  FileChangeSchema,
  SearchRequestSchema,
  SyncRequestSchema,
} from './schemas.js';

describe('lib/schemas', () => {
  describe('SearchRequestSchema', () => {
    it('validates valid search request', () => {
      const validRequest = {
        query: 'test query',
        limit: 10,
        categoryNames: ['react', 'go'],
        docTypes: ['project', 'external'],
      };
      const result = SearchRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('validates minimal search request with only query', () => {
      const minimalRequest = { query: 'test' };
      const result = SearchRequestSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(10); // Default value
      }
    });

    it('rejects empty query', () => {
      const invalidRequest = { query: '' };
      const result = SearchRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('rejects missing query', () => {
      const invalidRequest = {};
      const result = SearchRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('rejects query that is not a string', () => {
      const invalidRequest = { query: 123 };
      const result = SearchRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('rejects limit less than 1', () => {
      const invalidRequest = { query: 'test', limit: 0 };
      const result = SearchRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('rejects limit greater than 100', () => {
      const invalidRequest = { query: 'test', limit: 101 };
      const result = SearchRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('rejects non-integer limit', () => {
      const invalidRequest = { query: 'test', limit: 5.5 };
      const result = SearchRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('accepts valid limit values', () => {
      expect(SearchRequestSchema.safeParse({ query: 'test', limit: 1 }).success).toBe(true);
      expect(SearchRequestSchema.safeParse({ query: 'test', limit: 50 }).success).toBe(true);
      expect(SearchRequestSchema.safeParse({ query: 'test', limit: 100 }).success).toBe(true);
    });

    it('accepts undefined optional fields', () => {
      const request = {
        query: 'test',
        categoryNames: undefined,
        docTypes: undefined,
      };
      const result = SearchRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('rejects empty category names', () => {
      const invalidRequest = {
        query: 'test',
        categoryNames: [''],
      };
      const result = SearchRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('accepts valid docTypes', () => {
      const request = {
        query: 'test',
        docTypes: ['project'],
      };
      const result = SearchRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('accepts valid docTypes with external', () => {
      const request = {
        query: 'test',
        docTypes: ['external'],
      };
      const result = SearchRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('rejects invalid docTypes', () => {
      const invalidRequest = {
        query: 'test',
        docTypes: ['invalid'],
      };
      const result = SearchRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('FileChangeSchema', () => {
    it('validates valid file change', () => {
      const validChange = {
        title: 'Test Document',
        sourcePath: 'docs/test.md',
        sourceAbsolutePath: '/home/user/docs/test.md',
        categoryName: 'react',
        content: 'Test content here',
        metadata: {
          headings: ['Introduction', 'Getting Started'],
          codeBlocks: 3,
          wordCount: 100,
        },
      };
      const result = FileChangeSchema.safeParse(validChange);
      expect(result.success).toBe(true);
    });

    it('validates file change without optional metadata', () => {
      const minimalChange = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
      };
      const result = FileChangeSchema.safeParse(minimalChange);
      expect(result.success).toBe(true);
    });

    it('rejects empty title', () => {
      const invalidChange = {
        title: '',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
      };
      const result = FileChangeSchema.safeParse(invalidChange);
      expect(result.success).toBe(false);
    });

    it('rejects empty sourcePath', () => {
      const invalidChange = {
        title: 'Test',
        sourcePath: '',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
      };
      const result = FileChangeSchema.safeParse(invalidChange);
      expect(result.success).toBe(false);
    });

    it('rejects empty sourceAbsolutePath', () => {
      const invalidChange = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '',
        categoryName: 'test',
        content: 'Content',
      };
      const result = FileChangeSchema.safeParse(invalidChange);
      expect(result.success).toBe(false);
    });

    it('rejects empty categoryName', () => {
      const invalidChange = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: '',
        content: 'Content',
      };
      const result = FileChangeSchema.safeParse(invalidChange);
      expect(result.success).toBe(false);
    });

    it('rejects empty content', () => {
      const invalidChange = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: '',
      };
      const result = FileChangeSchema.safeParse(invalidChange);
      expect(result.success).toBe(false);
    });

    it('accepts valid metadata with only headings', () => {
      const change = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
        metadata: {
          headings: ['Section 1', 'Section 2'],
        },
      };
      const result = FileChangeSchema.safeParse(change);
      expect(result.success).toBe(true);
    });

    it('accepts valid metadata with only codeBlocks', () => {
      const change = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
        metadata: {
          codeBlocks: 5,
        },
      };
      const result = FileChangeSchema.safeParse(change);
      expect(result.success).toBe(true);
    });

    it('accepts valid metadata with only wordCount', () => {
      const change = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
        metadata: {
          wordCount: 500,
        },
      };
      const result = FileChangeSchema.safeParse(change);
      expect(result.success).toBe(true);
    });

    it('rejects negative codeBlocks', () => {
      const invalidChange = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
        metadata: {
          codeBlocks: -1,
        },
      };
      const result = FileChangeSchema.safeParse(invalidChange);
      expect(result.success).toBe(false);
    });

    it('rejects negative wordCount', () => {
      const invalidChange = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
        metadata: {
          wordCount: -10,
        },
      };
      const result = FileChangeSchema.safeParse(invalidChange);
      expect(result.success).toBe(false);
    });

    it('rejects non-integer codeBlocks', () => {
      const invalidChange = {
        title: 'Test',
        sourcePath: 'test.md',
        sourceAbsolutePath: '/test.md',
        categoryName: 'test',
        content: 'Content',
        metadata: {
          codeBlocks: 3.5,
        },
      };
      const result = FileChangeSchema.safeParse(invalidChange);
      expect(result.success).toBe(false);
    });
  });

  describe('SyncRequestSchema', () => {
    it('validates valid sync request', () => {
      const validRequest = {
        files: [
          {
            title: 'File 1',
            sourcePath: 'file1.md',
            sourceAbsolutePath: '/file1.md',
            categoryName: 'test',
            content: 'Content 1',
          },
          {
            title: 'File 2',
            sourcePath: 'file2.md',
            sourceAbsolutePath: '/file2.md',
            categoryName: 'test',
            content: 'Content 2',
          },
        ],
      };
      const result = SyncRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('rejects empty files array', () => {
      const invalidRequest = {
        files: [],
      };
      const result = SyncRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('rejects missing files', () => {
      const invalidRequest = {};
      const result = SyncRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('rejects non-array files', () => {
      const invalidRequest = {
        files: 'not an array',
      };
      const result = SyncRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('accepts single file in array', () => {
      const request = {
        files: [
          {
            title: 'Single File',
            sourcePath: 'single.md',
            sourceAbsolutePath: '/single.md',
            categoryName: 'test',
            content: 'Content',
          },
        ],
      };
      const result = SyncRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('rejects if any file in array is invalid', () => {
      const invalidRequest = {
        files: [
          {
            title: 'Valid File',
            sourcePath: 'valid.md',
            sourceAbsolutePath: '/valid.md',
            categoryName: 'test',
            content: 'Content',
          },
          {
            title: '', // Invalid - empty title
            sourcePath: 'invalid.md',
            sourceAbsolutePath: '/invalid.md',
            categoryName: 'test',
            content: 'Content',
          },
        ],
      };
      const result = SyncRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('CategoriesRequestSchema', () => {
    it('validates empty object', () => {
      const result = CategoriesRequestSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('validates with extra properties', () => {
      // Schema should strip extra properties
      const result = CategoriesRequestSchema.safeParse({ extra: 'value' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });
  });
});
