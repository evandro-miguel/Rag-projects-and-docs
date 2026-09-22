/**
 * @module config
 * @description Centralized configuration for RAG scripts.
 *
 * This module provides a unified configuration object (SCRIPT_CONFIG) that
 * consolidates all environment variables and default settings used across
 * the RAG ingestion and sync scripts.
 *
 * Purpose:
 * - Centralize environment variable access with sensible defaults
 * - Provide type-safe configuration for all scripts
 * - Enable easy override of settings via .env.local
 *
 * When to use: Import SCRIPT_CONFIG in any script that needs configuration
 * values like paths, concurrency limits, or embedding settings.
 *
 * Dependencies:
 * - dotenv package for loading .env.local
 * - Environment variables defined in .env.local or system
 *
 * Environment Variables:
 * - DOCS_SOURCE_PATH - Path to external documentation sources
 * - PROJECT_SOURCE_PATH - Path to project source for ingestion
 * - RAG_MCP_PROJECT_IGNORE_PATTERNS - Comma-separated ignore patterns
 * - RAG_MCP_PROJECT_MAX_FILE_BYTES - Maximum file size for ingestion (default: 5MB)
 * - PROJECT_FILE_GLOB - Glob pattern for project files (default: all code and markdown)
 * - PROJECT_WATCH_DEBOUNCE_MS - Debounce time for project watcher (default: 1500ms)
 * - DOCS_WATCH_DEBOUNCE_MS - Debounce time for external docs watcher (default: 2000ms)
 * - DOCS_FILE_GLOB - Glob pattern for external docs (default: markdown files)
 * - DOCS_IGNORE_PATTERNS - Comma-separated ignore patterns for docs watcher
 * - INGEST_CONCURRENCY - Parallel ingestion limit (default: 10)
 * - CHUNK_SIZE - Target chunk size in characters (default: 1000)
 * - CHUNK_OVERLAP - Chunk overlap in characters (default: 100)
 * - EMBEDDING_PROVIDER - Embedding provider name (default: llamacpp)
 * - EMBEDDING_MODEL - Embedding model name (default: qwen3-embedding-1024)
 * - PROJECT_EMBEDDING_DIMENSIONS - Project RAG embedding dimensions (default: 1024)
 */

import { PROJECT_RAG_POSTGRES_EMBEDDING_MODEL } from '../project-rag/embeddings.js';
import { ensureRepoEnvLoaded } from './runtime-env.js';

// MCP stdio clients require stdout to contain only protocol frames.
ensureRepoEnvLoaded();

export interface ScriptConfig {
  DOCS_SOURCE_PATH: string;
  PROJECT_SOURCE_PATH: string;
  PROJECT_IGNORE_PATTERNS: string;
  MAX_FILE_SIZE_BYTES: number;
  PROJECT_FILE_GLOB: string;
  PROJECT_WATCH_DEBOUNCE_MS: number;
  CONCURRENCY_LIMIT: number;
  CHUNK_SIZE: number;
  CHUNK_OVERLAP: number;
  EMBEDDING_PROVIDER: string;
  EMBEDDING_MODEL: string;
  PROJECT_EMBEDDING_DIMENSIONS: number;
  REDACTION_VERSION: string;
  CHUNKER_VERSION: string;
  DOCS_WATCH_DEBOUNCE_MS: number;
  DOCS_FILE_GLOB: string;
  DOCS_IGNORE_PATTERNS: string;
}

const MAX_FILE_SIZE_BYTES = 5_000_000; // 5MB exactly

function resolveScriptEmbeddingProvider(): string {
  const provider = (process.env.EMBEDDING_PROVIDER || 'llamacpp').trim().toLowerCase();
  if (provider === 'llamacpp' || provider === 'llama.cpp' || provider === 'llama-cpp') {
    return 'llamacpp';
  }
  throw new Error(
    `Unsupported EMBEDDING_PROVIDER "${provider}". This RAG system requires llama.cpp.`
  );
}

/**
 * Centralized configuration for RAG scripts.
 *
 * This module provides a unified configuration object (SCRIPT_CONFIG) that
 * consolidates all environment variables and default settings used across
 * the RAG ingestion and sync scripts.
 *
 * Purpose:
 * - Centralize environment variable access with sensible defaults
 * - Provide type-safe configuration for all scripts
 * - Enable easy override of settings via .env.local
 *
 * When to use: Import SCRIPT_CONFIG in any script that needs configuration
 * values like paths, concurrency limits, or embedding settings.
 *
 * Dependencies:
 * - dotenv package for loading .env.local
 * - Environment variables defined in .env.local or system
 *
 * Environment Variables:
 * - DOCS_SOURCE_PATH - Path to external documentation sources
 * - PROJECT_SOURCE_PATH - Path to project source for ingestion
 * - RAG_MCP_PROJECT_IGNORE_PATTERNS - Comma-separated ignore patterns
 * - RAG_MCP_PROJECT_MAX_FILE_BYTES - Maximum file size for ingestion (default: 5MB)
 * - PROJECT_FILE_GLOB - Glob pattern for project files (default: all code and markdown)
 * - PROJECT_WATCH_DEBOUNCE_MS - Debounce time for project watcher (default: 1500ms)
 * - DOCS_WATCH_DEBOUNCE_MS - Debounce time for external docs watcher (default: 2000ms)
 * - DOCS_FILE_GLOB - Glob pattern for external docs (default: markdown files)
 * - DOCS_IGNORE_PATTERNS - Comma-separated ignore patterns for docs watcher
 * - INGEST_CONCURRENCY - Parallel ingestion limit (default: 10)
 * - CHUNK_SIZE - Target chunk size in characters (default: 1000)
 * - CHUNK_OVERLAP - Chunk overlap in characters (default: 100)
 * - EMBEDDING_PROVIDER - Embedding provider name (default: llamacpp)
 * - EMBEDDING_MODEL - Embedding model name (default: qwen3-embedding-1024)
 * - PROJECT_EMBEDDING_DIMENSIONS - Project RAG embedding dimensions (default: 1024)
 */
export const SCRIPT_CONFIG: ScriptConfig = {
  // Source paths
  DOCS_SOURCE_PATH: process.env.DOCS_SOURCE_PATH || '',
  PROJECT_SOURCE_PATH: process.env.PROJECT_SOURCE_PATH || '',

  // Ignore patterns
  PROJECT_IGNORE_PATTERNS: process.env.RAG_MCP_PROJECT_IGNORE_PATTERNS || '',
  DOCS_IGNORE_PATTERNS: process.env.DOCS_IGNORE_PATTERNS || '',

  // File size limits
  MAX_FILE_SIZE_BYTES:
    parseInt(process.env.RAG_MCP_PROJECT_MAX_FILE_BYTES || '', 10) || MAX_FILE_SIZE_BYTES,

  // Project watcher configuration
  PROJECT_FILE_GLOB: process.env.PROJECT_FILE_GLOB || '**/*.{md,mdx,ts,tsx,js,jsx,json,yml,yaml}',
  PROJECT_WATCH_DEBOUNCE_MS: parseInt(process.env.PROJECT_WATCH_DEBOUNCE_MS || '', 10) || 1500,

  // External docs watcher configuration
  DOCS_FILE_GLOB: process.env.DOCS_FILE_GLOB || '**/*.md',
  DOCS_WATCH_DEBOUNCE_MS: parseInt(process.env.DOCS_WATCH_DEBOUNCE_MS || '', 10) || 2000,

  // Concurrency
  CONCURRENCY_LIMIT: parseInt(process.env.INGEST_CONCURRENCY || '', 10) || 10,

  // Chunking
  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE || '', 10) || 1000,
  CHUNK_OVERLAP: parseInt(process.env.CHUNK_OVERLAP || '', 10) || 100,

  // Embeddings
  EMBEDDING_PROVIDER: resolveScriptEmbeddingProvider(),
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
  PROJECT_EMBEDDING_DIMENSIONS:
    parseInt(process.env.PROJECT_EMBEDDING_DIMENSIONS || '', 10) || 1024,
  REDACTION_VERSION: process.env.EMBEDDING_REDACTION_VERSION || 'pii-redactor-v1',
  CHUNKER_VERSION: process.env.PROJECT_CHUNKER_VERSION || 'project-chunker-v1',
};

// Do not warn at module load when optional ingest paths are unset.
// Read-only CLI/MCP paths import this config, and missing DOCS_SOURCE_PATH /
// PROJECT_SOURCE_PATH only matter for mutation/ingest flows that already fail
// loudly when a root is required.
