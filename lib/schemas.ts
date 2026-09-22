/**
 * Shared Zod Schemas for RAG-v1
 *
 * Centralized validation schemas for HTTP endpoints and MCP layer.
 * Provides consistent validation with detailed error messages.
 */

import { z } from 'zod';

// ============================================================================
// SEARCH ENDPOINT SCHEMAS
// ============================================================================

/**
 * Schema for search request body.
 *
 * @property query - Required search string (non-empty)
 * @property limit - Optional max results (1-100, default: 10)
 * @property categoryNames - Optional array of category names to filter
 * @property docTypes - Optional array of document types ('project' | 'external')
 */
export const SearchRequestSchema = z.object({
  query: z.string().min(1, 'query is required and must be a non-empty string'),
  limit: z
    .number()
    .int('limit must be an integer')
    .min(1, 'limit must be at least 1')
    .max(100, 'limit must be at most 100')
    .optional()
    .default(10),
  categoryNames: z.array(z.string().min(1, 'category name must be non-empty')).optional(),
  docTypes: z.array(z.enum(['project', 'external'])).optional(),
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

// ============================================================================
// SYNC ENDPOINT SCHEMAS
// ============================================================================

/**
 * Metadata schema for document processing
 */
const MetadataSchema = z
  .object({
    headings: z.array(z.string()).optional(),
    codeBlocks: z.number().int().nonnegative().optional(),
    wordCount: z.number().int().nonnegative().optional(),
  })
  .optional();

/**
 * Schema for a single file change in sync request.
 *
 * @property title - Document title
 * @property sourcePath - Relative path within the documentation
 * @property sourceAbsolutePath - Absolute path on the file system
 * @property categoryName - Category to assign the document to
 * @property content - Document content (text/markdown)
 * @property metadata - Optional document metadata
 */
export const FileChangeSchema = z.object({
  title: z.string().min(1, 'title is required'),
  sourcePath: z.string().min(1, 'sourcePath is required'),
  sourceAbsolutePath: z.string().min(1, 'sourceAbsolutePath is required'),
  categoryName: z.string().min(1, 'categoryName is required'),
  content: z.string().min(1, 'content is required'),
  metadata: MetadataSchema,
});

/**
 * Schema for sync request body.
 *
 * @property files - Required array of file changes to sync (at least one)
 */
export const SyncRequestSchema = z.object({
  files: z.array(FileChangeSchema).min(1, 'files array must contain at least one file'),
});

export type FileChange = z.infer<typeof FileChangeSchema>;
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

// ============================================================================
// CATEGORIES ENDPOINT SCHEMAS
// ============================================================================

/**
 * Schema for categories request.
 * Categories endpoint uses GET with no body, only requires auth.
 * This schema is empty but provided for consistency.
 */
export const CategoriesRequestSchema = z.object({});

export type CategoriesRequest = z.infer<typeof CategoriesRequestSchema>;
