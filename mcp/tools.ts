/**
 * @module tools
 * @description MCP tool definitions for the RAG-v1 knowledge base server.
 *
 * This module defines the schema and metadata for all MCP tools exposed by
 * the RAG server. Each tool includes a name, description, and JSON Schema
 * for input validation.
 *
 * Available Tools:
 * - `search_docs`: Search external documentation using semantic search
 * - `search_project_docs`: Search project-specific documentation
 * - `ingest_project`: Trigger full project ingestion
 * - `ingest_project_file`: Ingest a single file
 * - `list_categories`: List all documentation categories
 * - `health_check`: Check server and backend health
 * - `get_document`: Retrieve full document content by path
 *
 * Tool schemas follow the MCP specification and are used by clients to:
 * - Discover available functionality
 * - Validate user input before sending requests
 * - Generate UI forms and autocomplete suggestions
 *
 * @example
 * // Tool definition structure
 * {
 *   name: 'search_docs',
 *   description: 'Search for external stack documentation...',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       query: { type: 'string', description: 'Search query...' },
 *       limit: { type: 'number', description: 'Maximum results...' },
 *     },
 *     required: ['query'],
 *   },
 * }
 *
 * @see server.ts - For tool registration and handling
 * @see handlers.ts - For tool implementation logic
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DocsVaultSearchMetadata } from '../lib/docs-vault-types.js';
import { PROJECT_SCOPE_ACK_TOKEN } from '../lib/shared/project-scope-advisory.js';
import { searchProjectCodeOutputSchema } from './project-tools.js';

// ============================================================================
// Tool Schemas
// ============================================================================

const DOCS_SEARCH_CANONICAL_RESULT_FIELDS = [
  'sourceId',
  'sourcePath',
  'canonicalUrl',
  'title',
  'heading',
  'section',
  'chunkIndex',
  'sourceRevision',
  'syncedAt',
  'authority',
  'score',
  'content',
  'provenanceStatus',
  'missingFields',
] as const;

const nullableStringOutputSchema = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
};

const nullableAuthorityOutputSchema = {
  oneOf: [
    { type: 'string', enum: ['official', 'publisher', 'community-vetted'] },
    { type: 'null' },
  ],
};

const docsSearchResultOutputSchema = {
  type: 'object',
  properties: {
    sourceId: nullableStringOutputSchema,
    sourcePath: { type: 'string' },
    canonicalUrl: nullableStringOutputSchema,
    title: { type: 'string' },
    heading: nullableStringOutputSchema,
    section: nullableStringOutputSchema,
    chunkIndex: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    sourceRevision: nullableStringOutputSchema,
    syncedAt: nullableStringOutputSchema,
    authority: nullableAuthorityOutputSchema,
    score: { type: 'number' },
    content: { type: 'string' },
    provenanceStatus: { type: 'string', enum: ['complete', 'degraded'] },
    missingFields: {
      type: 'array',
      items: { type: 'string', enum: ['canonicalUrl', 'sourceRevision', 'syncedAt', 'authority'] },
    },
  },
  required: [...DOCS_SEARCH_CANONICAL_RESULT_FIELDS],
};

export const searchDocsOutputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    retrievalMode: { type: 'string', enum: ['hybrid', 'local_first'] },
    resultCount: { type: 'integer' },
    localFirstConfigured: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
    results: { type: 'array', items: docsSearchResultOutputSchema },
  },
  required: [
    'query',
    'retrievalMode',
    'resultCount',
    'localFirstConfigured',
    'warnings',
    'results',
  ],
} satisfies NonNullable<Tool['outputSchema']>;

/**
 * search_docs tool schema for searching external documentation.
 *
 * Enables semantic search across external stack documentation (Bun, React,
 * Tailwind, etc.) using the hybrid search functionality.
 */
export const searchDocsTool: Tool = {
  name: 'search_docs',
  description:
    'Search for external stack documentation chunks using semantic search. Returns matching content from the indexed documentation with relevance scores. Supports optional category, source, language, authority, and tag-based filtering.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query - use natural language to describe what you are looking for',
      },
      categories: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          'Optional: Filter search to specific categories (e.g., ["react", "tailwind", "go"])',
      },
      sourceId: {
        type: 'string',
        description:
          'Optional: Filter to one registered Docs RAG source (e.g., "go-books", "python-docs").',
      },
      sourceIds: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          'Optional: Filter to registered Docs RAG sources (e.g., ["go-docs", "go-books"]).',
      },
      language: {
        type: 'string',
        description:
          'Optional: Filter by normalized Docs RAG language/source family (e.g., "go", "python", "typescript", "bun").',
      },
      kind: {
        type: 'string',
        enum: ['official-docs', 'book', 'package-docs', 'repository-docs'],
        description: 'Optional: Filter by source kind.',
      },
      authority: {
        type: 'string',
        enum: ['official', 'publisher', 'community-vetted'],
        description: 'Optional: Filter by source authority.',
      },
      sourceTags: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          'Optional: Filter by normalized source metadata tags. This is separate from backend content tags.',
      },
      retrievalMode: {
        type: 'string',
        enum: ['hybrid', 'local_first'],
        description:
          'Optional: Retrieval orchestration mode. "hybrid" preserves the current backend search path; "local_first" tries exact Docs Vault alias/path/title hits first when local Docs Vault roots are configured.',
      },
      includePageRefs: {
        type: 'boolean',
        description:
          'Optional: Include Docs Vault page-reference metadata such as canonical URL, wiki reference, and page ID in structured content when available.',
      },
      includeTrust: {
        type: 'boolean',
        description:
          'Optional: Include source trust metadata in structured content when available.',
      },
      tags: {
        type: 'object',
        description: 'Optional: Filter search by tag slugs',
        properties: {
          include: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tag slugs to include in results',
          },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tag slugs to exclude from results',
          },
          operator: {
            type: 'string',
            enum: ['AND', 'OR'],
            description:
              'How to combine multiple include tags: AND (all required) or OR (any match)',
            default: 'OR',
          },
        },
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10, max: 50)',
        minimum: 1,
        maximum: 50,
      },
    },
    required: ['query'],
  },
  outputSchema: searchDocsOutputSchema,
};

/**
 * Deprecated compatibility alias for project code search.
 *
 * MIGRATION PATH:
 *   Old: search_project_docs({ projectId, query, ... })
 *   New: search_project_code({ projectId, query, ... })
 *
 * Note: active_file parameter was renamed to activeFile in the new tool.
 *
 * @deprecated Since v1.5.0. Use `search_project_code` instead.
 *   This alias will be removed in v2.0.0.
 *   Migration: Replace tool name, update active_file -> activeFile parameter.

 */
export const searchProjectDocsTool: Tool = {
  name: 'search_project_docs',
  description:
    'Deprecated: Use search_project_code instead. This alias will be removed in v2.0.0. Search indexed project code within an explicitly selected project.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Project registry ID (required).',
      },
      query: {
        type: 'string',
        description: 'Search query - use natural language or code snippets to describe the target',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10, max: 50)',
        minimum: 1,
        maximum: 50,
      },
      active_file: {
        type: 'string',
        description:
          'Optional: Path of the active file the user is currently editing, used for local relevance bias.',
      },
      mode: {
        type: 'string',
        enum: ['keyword', 'vector', 'hybrid'],
        description:
          'Optional search mode. keyword is deprecated, maps to hybrid, and emits a warning; the alias routes to the same Postgres handler.',
      },
    },
    required: ['projectId', 'query'],
  },
  outputSchema: searchProjectCodeOutputSchema,
};

/**
 * ingest_project tool schema for bounded project reconciliation.
 *
 * By default this runs a delta sync suitable for MCP stdio. Forced calls are
 * full rebuilds and remain guarded by the MCP safety budget.
 */
export const ingestProjectTool: Tool = {
  name: 'ingest_project',
  description:
    'Ingest and reconcile a project repository into the RAG index. By default this performs a bounded delta sync: add missing files, update changed files, and delete indexed files removed from scope. Critical scope warning applies: confirm the intended scope and pass scopeAck=I_UNDERSTAND_PROJECT_RAG_SCOPE_V1 before ingestion. For first-time root ingestion, provide includeRoots explicitly. Forced full rebuilds still obey the MCP safety budget. executionMode=durable queues a fenced job for a separately operated worker.',
  inputSchema: {
    type: 'object',
    properties: {
      rootPath: {
        type: 'string',
        description:
          'Optional explicit project root path (absolute path). Falls back to PROJECT_SOURCE_PATH.',
      },
      includeRoots: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'Optional explicit relative folders for first-time root ingestion or scope updates (e.g., ["src", "docs"]).',
      },
      force: {
        type: 'boolean',
        description: 'If true, re-index all files even if content hash matches.',
        default: false,
      },
      maxFiles: {
        type: 'integer',
        description:
          'Maximum delta operations to process in this MCP request. Defaults to MCP_FULL_PROJECT_INGEST_MAX_FILES and is capped unless MCP_ALLOW_LARGE_PROJECT_INGEST=true.',
        minimum: 1,
      },
      scopeAck: {
        type: 'string',
        enum: [PROJECT_SCOPE_ACK_TOKEN],
        description:
          'Optional confirmation token for the second call. Omit it on the first attempt to receive the mandatory scope warning, then re-run with this exact token.',
      },
      executionMode: {
        type: 'string',
        enum: ['inline', 'durable'],
        description:
          'Execution mode. inline (default) runs bounded ingestion in the current call. durable queues a deduplicated fenced job; a separately operated worker executes it.',
        default: 'inline',
      },
    },
  },
};

/**
 * ingest_project_file tool schema for single file ingestion.
 *
 * Triggers ingestion of a specific file from the project repository.
 * Useful for updating individual files without re-indexing everything.
 */
export const ingestProjectFileTool: Tool = {
  name: 'ingest_project_file',
  description:
    'Ingest a single file from the project repository into the RAG index. Critical scope warning applies: confirm the file scope and pass scopeAck=I_UNDERSTAND_PROJECT_RAG_SCOPE_V1 before ingestion.',
  inputSchema: {
    type: 'object',
    properties: {
      rootPath: {
        type: 'string',
        description:
          'Optional override for project root path. Absolute path to allow safe file path validation.',
      },
      filePath: {
        type: 'string',
        description: 'Absolute path to the file inside the project directory.',
      },
      force: {
        type: 'boolean',
        description: 'If true, re-index the file even if content hash matches.',
        default: false,
      },
      scopeAck: {
        type: 'string',
        enum: [PROJECT_SCOPE_ACK_TOKEN],
        description:
          'Optional confirmation token for the second call. Omit it on the first attempt to receive the mandatory scope warning, then re-run with this exact token.',
      },
    },
    required: ['filePath'],
  },
};

/**
 * list_categories tool schema for listing documentation categories.
 *
 * Returns all available categories with their statistics including
 * document count and chunk count.
 */
export const listCategoriesTool: Tool = {
  name: 'list_categories',
  description:
    'List all available documentation categories with their statistics (document count, chunk count, etc.)',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        description: 'Whether the category lookup succeeded',
      },
      data: {
        type: 'object',
        description: 'Available documentation categories and their statistics',
        properties: {
          categories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                displayName: { type: 'string' },
                docCount: { type: 'number' },
                chunkCount: { type: 'number' },
              },
              required: ['name', 'displayName', 'docCount', 'chunkCount'],
            },
          },
        },
        required: ['categories'],
      },
      error: {
        type: 'object',
        description: 'Error details (only present when success=false)',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          timestamp: { type: 'string' },
        },
        required: ['code', 'message', 'timestamp'],
      },
    },
    required: ['success'],
  },
};

/**
 * health_check tool schema for server health verification.
 *
 * Verifies connectivity to the MCP server and Docs RAG Postgres,
 * returning latency information.
 */
export const healthCheckTool: Tool = {
  name: 'health_check',
  description: 'Check MCP server and Docs RAG Postgres health status',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        description: 'Whether every health component is healthy',
      },
      data: {
        type: 'object',
        properties: {
          components: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                component: { type: 'string' },
                status: { type: 'string' },
                latencyMs: { type: 'number' },
                details: { type: 'string' },
              },
              required: ['component', 'status'],
            },
          },
        },
        required: ['components'],
      },
    },
    required: ['success', 'data'],
  },
};

/**
 * get_document tool schema for retrieving full document content.
 *
 * Retrieves the complete content of a document by its source path,
 * including all chunks and metadata.
 */
export const getDocumentTool: Tool = {
  name: 'get_document',
  description: 'Retrieve full document status and content summary by source path',
  inputSchema: {
    type: 'object',
    properties: {
      sourcePath: {
        type: 'string',
        description:
          'The relative path of the document (e.g., "react-docs/reference/react/useEffect.md")',
      },
    },
    required: ['sourcePath'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          sourcePath: { type: 'string' },
          found: { type: 'boolean' },
          title: { type: 'string' },
          content: { type: 'string' },
          chunkCount: { type: 'number' },
        },
        required: ['sourcePath', 'found'],
      },
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          timestamp: { type: 'string' },
        },
        required: ['code', 'message', 'timestamp'],
      },
    },
    required: ['success'],
  },
};

/**
 * adapt_docs tool schema for context-specific documentation adaptation.
 *
 * Transforms RAG search results for specific developer contexts:
 * - code-focused: Emphasizes code examples and implementation details
 * - architecture: Focuses on system design and component relationships
 * - beginner: Simplifies with more context and examples
 * - senior: Concise, assumes familiarity with common patterns
 * - quick-ref: Bullet points and tables for rapid lookup
 */
export const adaptDocsTool: Tool = {
  name: 'adapt_docs',
  description:
    '[DEPRECATED] Adapt RAG search results for specific contexts. Gemini-powered adaptation is retired. This tool now performs deterministic local-only reorganization. Use subagent-based processing for production needs.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Raw content from RAG search results to adapt',
      },
      context: {
        type: 'string',
        enum: ['code-focused', 'architecture', 'beginner', 'senior', 'quick-ref'],
        description:
          'Target adaptation context: code-focused (code examples), architecture (system design), beginner (learning-oriented), senior (concise), quick-ref (scannable)',
      },
      maxLength: {
        type: 'number',
        description: 'Maximum output length in characters (default: 2000)',
        default: 2000,
      },
      preserveCode: {
        type: 'boolean',
        description: 'Whether to preserve code blocks unchanged (default: true)',
        default: true,
      },
    },
    required: ['content', 'context'],
  },
};

/**
 * search_and_adapt tool schema for unified search + adaptation.
 *
 * Combines search and adaptation into a single call for simplified UX.
 * Searches external documentation and immediately adapts results to the
 * requested context (code-focused, architecture, beginner, senior, quick-ref).
 */
export const searchAndAdaptTool: Tool = {
  name: 'search_and_adapt',
  description:
    '[DEPRECATED] Search external documentation and adapt results to a specific context in one call. Gemini-powered adaptation is retired. Uses deterministic local-only reorganization. Use subagent-based processing for production needs.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query - use natural language to describe what you are looking for',
      },
      context: {
        type: 'string',
        enum: ['code-focused', 'architecture', 'beginner', 'senior', 'quick-ref'],
        description:
          'Target adaptation context: code-focused (emphasizes code examples), architecture (system design focus), beginner (learning-oriented with explanations), senior (concise, assumes expertise), quick-ref (scannable bullet points)',
      },
      categories: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Optional: Filter search to specific categories (e.g., ["react", "go"])',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of search results to process (default: 5, max: 20)',
        default: 5,
        minimum: 1,
        maximum: 20,
      },
      maxLength: {
        type: 'number',
        description: 'Maximum adapted output length in characters (default: 2000)',
        default: 2000,
      },
      preserveCode: {
        type: 'boolean',
        description: 'Whether to preserve code blocks unchanged in adaptation (default: true)',
        default: true,
      },
    },
    required: ['query', 'context'],
  },
};

/**
 * get_code_metrics tool schema for retrieving code inventory metrics.
 *
 * Returns aggregate metrics from the code inventory including:
 * - Total files, lines, functions, exports
 * - Breakdown by category (Shared, Docs, etc.)
 */
export const getCodeMetricsTool: Tool = {
  name: 'get_code_metrics',
  description:
    'Retrieve code inventory metrics summary including total files, lines, functions, exports, and breakdown by category. Optionally filter by category name.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional: Filter metrics to a specific category (e.g., "Shared", "Docs")',
      },
    },
  },
};

/**
 * search_inventory tool schema for querying code inventory.
 *
 * Searches the code inventory for files matching a pattern in their filepath.
 * Returns matching files with their status, metrics, and metadata.
 */
export const searchInventoryTool: Tool = {
  name: 'search_inventory',
  description:
    'Query the code inventory by filepath pattern. Returns matching files with their status, lines, functions, exports, and descriptions.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Search pattern - matches against filepath (supports partial matches)',
      },
      category: {
        type: 'string',
        description: 'Optional: Filter results to a specific category',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 20, max: 100)',
        minimum: 1,
        maximum: 100,
        default: 20,
      },
    },
    required: ['pattern'],
  },
};

/**
 * get_dead_code_report tool schema for orphan file detection.
 *
 * Lists files flagged as potential orphans with reasons:
 * - Zero exports (potential dead code)
 * - Test files without corresponding source
 * - Files with [ ] status (not yet reviewed)
 */
export const getDeadCodeReportTool: Tool = {
  name: 'get_dead_code_report',
  description:
    'List files flagged as potential orphans or dead code. Returns files with zero exports, unreviewed status, or other indicators of potential dead code.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional: Filter report to a specific category',
      },
      includeUnreviewed: {
        type: 'boolean',
        description: 'Include files with unreviewed status (default: true)',
        default: true,
      },
      minLines: {
        type: 'number',
        description: 'Minimum lines threshold for reporting (default: 0)',
        default: 0,
      },
    },
  },
};

/**
 * find_project_symbol tool schema for searching symbols by name.
 *
 * Searches for symbols (functions, classes, interfaces, etc.) by name within a project.
 * Returns matching symbols with their file path, line range, type, and signature.
 */
export const findProjectSymbolTool: Tool = {
  name: 'find_project_symbol',
  description:
    'Find symbols by name within a project. Searches for functions, classes, interfaces, and other symbols by exact name match. Returns matching symbols with their file path, line range, type, and signature.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project registry ID to search within',
      },
      symbolName: {
        type: 'string',
        description:
          'The exact name of the symbol to search for (e.g., "handleSearchProjectCode", "MyClass")',
      },
      symbolType: {
        type: 'string',
        description:
          'Optional: Filter by symbol type (e.g., "function", "class", "interface", "type")',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10, max: 50)',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
    required: ['projectId', 'symbolName'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        description: 'Whether the operation was successful',
      },
      data: {
        type: 'object',
        description: 'Response data (only present when success=true)',
        properties: {
          symbols: {
            type: 'array',
            description: 'Array of matching symbols',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Symbol name',
                },
                symbolType: {
                  type: 'string',
                  description: 'Symbol type (function, class, interface, type, variable, etc.)',
                },
                sourcePath: {
                  type: 'string',
                  description: 'Relative file path where the symbol is defined',
                },
                startLine: {
                  type: 'number',
                  description: 'Starting line number of the symbol definition',
                },
                endLine: {
                  type: 'number',
                  description: 'Ending line number of the symbol definition',
                },
                signature: {
                  type: 'string',
                  description: 'Symbol signature if available',
                },
                exportType: {
                  type: 'string',
                  description: 'Export type (e.g., export, default, named)',
                },
              },
              required: ['name', 'symbolType', 'sourcePath'],
            },
          },
          count: {
            type: 'number',
            description: 'Total number of symbols found',
          },
        },
        required: ['symbols', 'count'],
      },
      error: {
        type: 'object',
        description: 'Error details (only present when success=false)',
        properties: {
          code: {
            type: 'string',
            description: 'Error code (VALIDATION_ERROR, NOT_FOUND, INTERNAL_ERROR)',
          },
          message: {
            type: 'string',
            description: 'Human-readable error message',
          },
          timestamp: {
            type: 'string',
            description: 'ISO 8601 timestamp when the error occurred',
          },
        },
        required: ['code', 'message', 'timestamp'],
      },
    },
    required: ['success'],
  },
};

/**
 * find_symbol_references tool schema for finding symbol references.
 *
 * Finds all references to a symbol within a project. Returns both the symbol
 * definitions and all edges (references) where the symbol is the target.
 * Useful for impact analysis and understanding code dependencies.
 */
export const findSymbolReferencesTool: Tool = {
  name: 'find_symbol_references',
  description:
    'Find all references to a symbol within a project. Returns symbol definitions and their references (call sites, imports, etc.) for impact analysis.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project registry ID to search within',
      },
      symbolName: {
        type: 'string',
        description:
          'The exact name of the symbol to find references for (e.g., "handleSearchProjectCode", "MyClass")',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of definitions to return (default: 20, max: 50)',
        minimum: 1,
        maximum: 50,
        default: 20,
      },
    },
    required: ['projectId', 'symbolName'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        description: 'Whether the operation was successful',
      },
      data: {
        type: 'object',
        description: 'Response data (only present when success=true)',
        properties: {
          definitions: {
            type: 'array',
            description: 'Array of symbol definitions',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Symbol name',
                },
                symbolType: {
                  type: 'string',
                  description: 'Symbol type (function, class, interface, type, variable, etc.)',
                },
                sourcePath: {
                  type: 'string',
                  description: 'Relative file path where the symbol is defined',
                },
                startLine: {
                  type: 'number',
                  description: 'Starting line number of the symbol definition',
                },
                endLine: {
                  type: 'number',
                  description: 'Ending line number of the symbol definition',
                },
                signature: {
                  type: 'string',
                  description: 'Symbol signature if available',
                },
              },
              required: ['name', 'symbolType', 'sourcePath'],
            },
          },
          references: {
            type: 'array',
            description: 'Array of references to the symbol',
            items: {
              type: 'object',
              properties: {
                sourcePath: {
                  type: 'string',
                  description: 'File path where the reference is located',
                },
                relationType: {
                  type: 'string',
                  description: 'Type of reference (e.g., import, call, extends, implements)',
                },
                confidence: {
                  type: 'number',
                  description: 'Confidence score of the reference (0-1)',
                },
                sourceRef: {
                  type: 'string',
                  description: 'Optional reference detail (e.g., import path, call site info)',
                },
              },
              required: ['sourcePath', 'relationType', 'confidence'],
            },
          },
          definitionCount: {
            type: 'number',
            description: 'Number of symbol definitions found',
          },
          referenceCount: {
            type: 'number',
            description: 'Number of references found',
          },
        },
        required: ['definitions', 'references', 'definitionCount', 'referenceCount'],
      },
      error: {
        type: 'object',
        description: 'Error details (only present when success=false)',
        properties: {
          code: {
            type: 'string',
            description: 'Error code (VALIDATION_ERROR, NOT_FOUND, INTERNAL_ERROR)',
          },
          message: {
            type: 'string',
            description: 'Human-readable error message',
          },
          timestamp: {
            type: 'string',
            description: 'ISO 8601 timestamp when the error occurred',
          },
        },
        required: ['code', 'message', 'timestamp'],
      },
    },
    required: ['success'],
  },
};

/**
 * get_project_skeleton tool schema for retrieving file skeleton.
 *
 * Returns the skeleton text (structural outline) for a file if available.
 * Skeletons contain imports, exports, and signatures without implementation bodies.
 */
export const getProjectSkeletonTool: Tool = {
  name: 'get_project_skeleton',
  description:
    'Retrieve the skeleton/outline representation of a project file. Returns structural information including imports, exports, class and function signatures without full implementation bodies. Useful for understanding file structure at a glance.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project registry ID',
      },
      sourcePath: {
        type: 'string',
        description: 'Relative source path to the file (e.g., "src/components/Button.tsx")',
      },
    },
    required: ['projectId', 'sourcePath'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        description: 'Whether the operation was successful',
      },
      data: {
        type: 'object',
        description: 'Response data (only present when success=true)',
        properties: {
          sourcePath: {
            type: 'string',
            description: 'Relative file path',
          },
          skeletonText: {
            type: 'string',
            description: 'The skeleton/outline text containing structural information',
          },
          outlineVersion: {
            type: 'string',
            description: 'Version of the outline format',
          },
          lang: {
            type: 'string',
            description: 'Detected programming language of the file',
          },
          sizeBytes: {
            type: 'number',
            description: 'Original file size in bytes',
          },
          available: {
            type: 'boolean',
            description: 'Whether skeleton data is available for this file',
          },
        },
        required: ['sourcePath', 'sizeBytes', 'available'],
      },
      error: {
        type: 'object',
        description: 'Error details (only present when success=false)',
        properties: {
          code: {
            type: 'string',
            description: 'Error code (VALIDATION_ERROR, NOT_FOUND, INTERNAL_ERROR)',
          },
          message: {
            type: 'string',
            description: 'Human-readable error message',
          },
          timestamp: {
            type: 'string',
            description: 'ISO 8601 timestamp when the error occurred',
          },
        },
        required: ['code', 'message', 'timestamp'],
      },
    },
    required: ['success'],
  },
};

// ============================================================================
// Service Management Tools
// ============================================================================

/**
 * ensure_reranker tool schema for starting the reranking service.
 *
 * This tool allows agents to start the cross-encoder reranking service
 * if it's not already running. Useful for ensuring optimal search quality.
 */
export const ensureRerankerTool: Tool = {
  name: 'ensure_reranker',
  description:
    'Ensure the reranking service is running. Starts the service if not already active. Use this when reranking is needed for search quality.',
  inputSchema: {
    type: 'object',
    properties: {
      timeout: {
        type: 'number',
        description: 'Maximum seconds to wait for service startup (default: 30)',
        default: 30,
        minimum: 5,
        maximum: 120,
      },
    },
  },
};

// ============================================================================
// Semantic Navigation Tools (P2-05)
// ============================================================================

/**
 * get_semantic_clusters tool schema for file clustering.
 *
 * Groups project files into clusters of semantically similar content
 * based on embeddings. Useful for understanding codebase structure
 * and identifying related files across directories.
 */
export const getSemanticClustersTool: Tool = {
  name: 'get_semantic_clusters',
  description:
    'Get semantic clusters of files based on embedding similarity. Groups project files into clusters of semantically similar content, helping you understand the codebase structure and identify related files across directory boundaries.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project registry ID',
      },
      maxClusters: {
        type: 'number',
        description: 'Maximum number of clusters to return (default: 10)',
        minimum: 1,
        maximum: 20,
        default: 10,
      },
      minClusterSize: {
        type: 'number',
        description: 'Minimum files per cluster (default: 2)',
        minimum: 2,
        maximum: 10,
        default: 2,
      },
    },
    required: ['projectId'],
  },
};

/**
 * Compatibility schema for directory-based grouping. The public MCP name is
 * `get_directory_groups`; `get_feature_hubs` remains a deprecated alias.
 *
 * Groups files by directory structure, identifying logical feature
 * areas within the codebase.
 */
export const getFeatureHubsTool: Tool = {
  name: 'get_feature_hubs',
  description:
    'Get directory groups of related files. Identifies logical areas within the codebase by analyzing directory structure and file relationships.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project registry ID',
      },
      minFiles: {
        type: 'number',
        description: 'Minimum files to consider a directory a hub (default: 2)',
        minimum: 1,
        maximum: 10,
        default: 2,
      },
    },
    required: ['projectId'],
  },
};

/**
 * get_navigation_paths tool schema for finding related files.
 *
 * Finds files that are semantically related to a given source file
 * through various relationship types (semantic similarity, imports,
 * directory proximity, symbol usage).
 */
export const getNavigationPathsTool: Tool = {
  name: 'get_navigation_paths',
  description:
    'Get navigation paths from a source file to related files. Finds files that are semantically related through various relationship types including semantic similarity, imports, directory proximity, and symbol usage.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project registry ID',
      },
      sourcePath: {
        type: 'string',
        description: 'Source file path to navigate from (e.g., "src/auth/login.ts")',
      },
      limit: {
        type: 'number',
        description: 'Maximum navigation paths to return (default: 10)',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
    required: ['projectId', 'sourcePath'],
  },
};

/**
 * get_topic_groups tool schema for semantic topic grouping.
 *
 * Groups files by semantic topics derived from content and symbols.
 * More content-focused than feature hubs, topic groups cross
 * directory boundaries.
 */
export const getTopicGroupsTool: Tool = {
  name: 'get_topic_groups',
  description:
    'Get topic-based groupings of files. Groups files by semantic topics derived from content and symbols. More content-focused than feature hubs, topic groups cross directory boundaries to identify conceptual themes across the codebase.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project registry ID',
      },
      maxTopics: {
        type: 'number',
        description: 'Maximum number of topics (default: 8)',
        minimum: 1,
        maximum: 20,
        default: 8,
      },
      minTopicSize: {
        type: 'number',
        description: 'Minimum files per topic (default: 2)',
        minimum: 2,
        maximum: 10,
        default: 2,
      },
    },
    required: ['projectId'],
  },
};

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Search request parameters for search_docs and search_project_docs tools.
 */
export interface SearchDocsArgs {
  /** Search query string */
  query: string;
  /** Optional category filters */
  categories?: string[];
  /** Optional single registered Docs RAG source filter */
  sourceId?: string;
  /** Optional registered Docs RAG source filters */
  sourceIds?: string[];
  /** Optional normalized Docs RAG language/source family */
  language?: string;
  /** Optional source kind filter */
  kind?: 'official-docs' | 'book' | 'package-docs' | 'repository-docs';
  /** Optional source authority filter */
  authority?: 'official' | 'publisher' | 'community-vetted';
  /** Optional source metadata tag filters */
  sourceTags?: string[];
  /** Optional retrieval orchestration mode */
  retrievalMode?: 'hybrid' | 'local_first';
  /** Include Docs Vault page reference metadata in structured content */
  includePageRefs?: boolean;
  /** Include source trust metadata in structured content */
  includeTrust?: boolean;
  /** Maximum results to return (default: 10) */
  limit?: number;
  /** Optional document type filters (external, project) */
  docTypes?: string[];
  /** Optional active file to infer language/ecosystem */
  active_file?: string;
}

/**
 * Category information returned by list_categories tool.
 */
export interface Category {
  /** Unique category ID */
  _id: string;
  /** Category name (e.g., "react", "go") */
  name: string;
  /** Human-readable display name (e.g., "Bun", "React 19") */
  displayName: string;
  /** Optional category description */
  description?: string;
  /** Number of documents in this category */
  docCount: number;
  /** Number of chunks across all documents */
  chunkCount: number;
  /** Timestamp of last synchronization */
  lastSyncAt: number;
}

/**
 * Search result chunk with content and position information.
 */
export interface SearchChunk {
  /** Text content of the chunk */
  content: string;
  /** Section/heading this chunk belongs to (if any) */
  section?: string;
  /** Index of this chunk within its document */
  chunkIndex: number;
  /** Starting line number in source file */
  startLine?: number;
  /** Ending line number in source file */
  endLine?: number;
  /** Optional Docs Vault metadata */
  metadata?: DocsVaultSearchMetadata;
}

/**
 * Search result document metadata.
 */
export interface SearchDocument {
  /** Unique document ID */
  _id: string;
  /** Document title */
  title: string;
  /** Relative path to source file */
  sourcePath: string;
  /** Optional Docs Vault metadata */
  metadata?: DocsVaultSearchMetadata;
}

/**
 * Score breakdown for confidence metadata.
 */
export interface ResultScores {
  /** Base score from RRF fusion (0-100 scale) */
  baseScore: number;
  /** Reranker score from cross-encoder (0-1 scale, if reranking enabled) */
  rerankScore?: number;
  /** Combined final score after all processing */
  combined: number;
  /** Component scores for transparency */
  components?: {
    /** Vector similarity score (0-1) */
    vectorScore?: number;
    /** Text/BM25 score (0-1) */
    textScore?: number;
    /** Recency boost (0-1) */
    recencyScore?: number;
    /** Heat/popularity boost (0-1) */
    heatScore?: number;
    /** Knowledge graph boost (0-1) */
    kgScore?: number;
  };
}

/**
 * Confidence metadata for search results.
 */
export interface ConfidenceMetadata {
  /** Which retrieval stage produced this result (vector, bm25, reranked, fallback, fused) */
  stage: 'vector' | 'bm25' | 'reranked' | 'fallback' | 'fused';
  /** Model used for reranking (if applicable) */
  rerankModel?: string;
  /** All relevant scores used in ranking */
  scores: ResultScores;
  /** Whether fallback scoring was used for explicit lexical diagnostics */
  fallbackUsed: boolean;
  /** Timestamp when result was generated */
  generatedAt?: number;
}

/**
 * Single search result combining chunk, document, and score.
 */
export interface SearchResult {
  /** The matching chunk with content */
  chunk: SearchChunk;
  /** Relevance score (higher = more relevant) */
  score: number;
  /** Parent document metadata */
  document: SearchDocument;
  /**
   * Confidence metadata for this result.
   * Provides transparency into ranking and retrieval stages.
   */
  confidence?: ConfidenceMetadata;
}

/**
 * Search API response structure.
 */
export interface SearchResponse {
  /** Array of search results sorted by relevance */
  results: SearchResult[];
}

/**
 * Categories API response structure.
 */
export interface CategoriesResponse {
  /** Array of all categories */
  categories: Category[];
}

/**
 * Adapt docs request parameters for adapt_docs tool.
 */
export interface AdaptDocsArgs {
  /** Content to adapt */
  content: string;
  /** Target adaptation context */
  context: 'code-focused' | 'architecture' | 'beginner' | 'senior' | 'quick-ref';
  /** Maximum output length (default: 2000) */
  maxLength?: number;
  /** Whether to preserve code blocks (default: true) */
  preserveCode?: boolean;
}

/**
 * Inventory file entry from the code inventory.
 */
export interface InventoryFile {
  /** Unique ID in inventory */
  id: string;
  /** Review status: true = reviewed, false = not yet reviewed */
  status: boolean;
  /** Number of lines in file */
  lines: number | null;
  /** Number of functions in file */
  functions: number;
  /** Number of exports in file */
  exports: number;
  /** File path relative to project root */
  filepath: string;
  /** Optional description */
  description: string;
  /** Category name (Shared, Docs, etc.) */
  category: string;
}

/**
 * Code metrics summary returned by get_code_metrics tool.
 */
export interface CodeMetrics {
  /** Total number of files */
  totalFiles: number;
  /** Total lines of code */
  totalLines: number;
  /** Total functions */
  totalFunctions: number;
  /** Total exports */
  totalExports: number;
  /** Breakdown by category */
  byCategory: Record<
    string,
    {
      files: number;
      lines: number;
      functions: number;
      exports: number;
    }
  >;
  /** Timestamp of inventory */
  lastUpdated: string;
}

/**
 * Dead code report entry.
 */
export interface DeadCodeEntry {
  /** File path */
  filepath: string;
  /** Category */
  category: string;
  /** Reason for flagging */
  reason: string;
  /** Number of lines */
  lines: number | null;
  /** Number of exports */
  exports: number;
  /** Review status */
  reviewed: boolean;
}
