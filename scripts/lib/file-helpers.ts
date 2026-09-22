/**
 * @module file-helpers
 * @description Utility functions for file operations and path manipulation.
 *
 * This module provides helper functions used across ingestion scripts for:
 * - Extracting document titles from content or filenames
 * - Determining category names from file paths
 * - Building consistent source paths for RAG ingestion
 * - Filtering files that should be ignored
 *
 * **When to use:** Import these utilities when processing files for ingestion
 * to ensure consistent title extraction, categorization, and path handling.
 *
 * **Dependencies:** None (uses only Node.js path module)
 *
 * @example
 * // Extract title from markdown content
 * import { extractTitle, extractCategory } from './lib/file-helpers.js';
 *
 * const content = "# API Reference\n\nThis is the API docs...";
 * const title = extractTitle(content, "api-reference.md"); // "API Reference"
 * const category = extractCategory("docs/api/reference.md"); // "api"
 *
 * @example
 * // Build source path for Project RAG
 * import { buildProjectSourcePath } from './lib/file-helpers.js';
 *
 * const sourcePath = buildProjectSourcePath("/project/apps/web", "/project/apps/web/src/components/Button.tsx");
 * // Returns: "web/src/components/Button.tsx"
 */

// scripts/lib/file-helpers.ts
import { basename, relative } from 'node:path';

/**
 * Extract a document title from markdown content or filename.
 *
 * Attempts to extract the title from the first H1 heading (# Title).
 * Falls back to the filename (without extension) if no H1 is found.
 *
 * @param content - The document content to search for H1 heading
 * @param filename - The filename to use as fallback (e.g., "api-reference.md")
 *
 * @returns Extracted title string, either from H1 or derived from filename
 *
 * @example
 * // Extract from H1 heading
 * const content = "# Getting Started\n\nWelcome to the docs...";
 * const title = extractTitle(content, "intro.md"); // "Getting Started"
 *
 * @example
 * // Fallback to filename
 * const content = "Some content without heading...";
 * const title = extractTitle(content, "quick-start-guide.md"); // "quick start guide"
 */
export function extractTitle(content: string, filename: string): string {
  const h1Match = content.match(/^#\s+(.+)$/m);
  const fallback = filename.replace(/\.[^/.]+$/, '').replace(/-/g, ' ');
  return h1Match ? h1Match[1].trim() : fallback;
}

/**
 * Extract category name from a source file path.
 *
 * Traverses path segments and returns the first segment that is not
 * 'docs' or 'reference', providing a meaningful category for organization.
 *
 * @param sourcePath - The source path to analyze (e.g., "react/hooks/README.md")
 *
 * @returns Category name extracted from path, or 'misc' if no suitable category found
 *
 * @example
 * // Extract category from path
 * extractCategory("react/hooks/README.md"); // "react"
 * extractCategory("docs/react/hooks.md"); // "react"
 * extractCategory("reference/tailwind/config.md"); // "tailwind"
 */
export function extractCategory(sourcePath: string): string {
  const parts = sourcePath.split('/');
  for (const part of parts) {
    if (part && part !== 'docs' && part !== 'reference') return part;
  }
  return 'misc';
}

/**
 * Check if a file path should be ignored during ingestion.
 *
 * Currently filters out paths containing '/handling/' or '/rendering/'
 * which are typically UI-specific documentation sections.
 *
 * @param path - The file path to check
 *
 * @returns `true` if the path should be ignored, `false` otherwise
 *
 * @example
 * // Check if path should be ignored
 * shouldIgnorePath("docs/handling/errors.md"); // true
 * shouldIgnorePath("docs/api/reference.md"); // false
 */
export function shouldIgnorePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath.includes('/handling/') || lowerPath.includes('/rendering/');
}

/**
 * Check if an external docs path should be ignored during ingestion.
 *
 * Uses:
 * - Base ignore rules from `shouldIgnorePath`
 * - Generic repository-noise segments (tests, fixtures, coverage)
 * - Source-specific prefix ignores from `sources.json` (`ignorePaths`)
 *
 * @param path - Relative or absolute path to evaluate
 * @param ignorePrefixes - Optional source-specific prefixes (e.g., ['test/', 'packages/'])
 * @returns `true` when path should be skipped
 */
export function shouldIgnoreExternalDocPath(path: string, ignorePrefixes: string[] = []): boolean {
  const normalized = path.toLowerCase().split('\\').join('/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  const noisySegments = new Set(['test', 'tests', '__tests__', 'fixtures', 'coverage', 'vendor']);

  if (shouldIgnorePath(`/${normalized}`)) {
    return true;
  }

  if (segments.some((segment) => noisySegments.has(segment))) {
    return true;
  }

  return ignorePrefixes.some((prefix) => {
    const normalizedPrefix = prefix.toLowerCase().split('\\').join('/').replace(/^\/+/, '');
    return normalized.startsWith(normalizedPrefix);
  });
}

/**
 * Get the category name from a project root directory.
 *
 * Extracts the base name of the project directory for use as a category.
 *
 * @param projectRoot - The absolute path to the project root directory
 *
 * @returns Base name of the project directory
 *
 * @example
 * // Get project category
 * getProjectCategory("/home/user/apps/my-web-app"); // "my-web-app"
 * getProjectCategory("/home/user/projects/rag-skill"); // "rag-skill"
 */
export function getProjectCategory(projectRoot: string): string {
  return basename(projectRoot);
}

/**
 * Build a consistent source path for Project RAG ingestion.
 *
 * Combines the project category with the relative file path to create
 * a unique identifier for the document in the RAG store.
 *
 * @param projectRoot - The absolute path to the project root directory
 * @param filePath - The absolute path to the file being ingested
 *
 * @returns Normalized source path in format: `{projectName}/{relativePath}`
 *
 * @example
 * // Build source path
 * buildProjectSourcePath("/home/user/apps/web", "/home/user/apps/web/src/components/Button.tsx");
 * // Returns: "web/src/components/Button.tsx"
 */
export function buildProjectSourcePath(projectRoot: string, filePath: string): string {
  const projectName = getProjectCategory(projectRoot);
  const relativePath = relative(projectRoot, filePath).split('\\').join('/');
  return `${projectName}/${relativePath}`;
}
