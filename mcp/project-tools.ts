/**
 * @module project-tools
 * @description MCP tool definitions for Project RAG operations.
 *
 * This module defines the schema and metadata for Project RAG MCP tools exposed by
 * the RAG server. Each tool includes a name, description, input schema, and
 * output schema for structured responses.
 *
 * Available Tools:
 * - `search_project_code`: Search project code with vector/hybrid modes
 * - `get_project_file`: Retrieve file metadata and chunks
 * - `get_project_outline`: Get symbol/file outline
 * - `register_project`: Register a new project
 * - `prepare_project`: Prepare one selected project for retrieval
 * - `verify_project_index`: Verify project index health and coverage
 *
 * Tool schemas follow the MCP specification and are used by clients to:
 * - Discover available functionality
 * - Validate user input before sending requests
 * - Generate UI forms and autocomplete suggestions
 * - Validate structured tool outputs
 *
 * @example
 * // Tool definition structure
 * {
 *   name: 'search_project_code',
 *   description: 'Search project code...',
 *   inputSchema: { ... },
 *   outputSchema: { ... },
 * }
 *
 * @see server.ts - For tool registration and handling
 * @see project-handlers.ts - For tool implementation logic
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { PROJECT_SCOPE_ACK_TOKEN } from '../lib/shared/project-scope-advisory.js';

// ============================================================================
// Tool Schemas
// ============================================================================

/**
 * search_project_code tool schema for searching project code.
 *
 * Enables vector or hybrid search across project code with exact file path
 * and line number references in results. The deprecated keyword request alias
 * maps to hybrid execution.
 */
export const searchProjectCodeTool: Tool = {
  name: 'search_project_code',
  description:
    'Search project code with vector or hybrid search. Deprecated keyword requests map to hybrid and emit a warning. The current Postgres backend executes hybrid vector+lexical retrieval for all supported modes and reports vector-mode degradation explicitly. Returns results with exact file paths and line references. Use this when looking for specific code patterns, functions, or implementations within a registered project.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Project registry ID (required) - identifies which project to search',
      },
      query: {
        type: 'string',
        description:
          'Search query - use natural language or code snippets to describe what you are looking for',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10, max: 50)',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      activeFile: {
        type: 'string',
        description:
          'Optional: Path of the active file the user is currently editing, to boost relevance of related results',
      },
      mode: {
        type: 'string',
        enum: ['keyword', 'vector', 'hybrid'],
        description:
          'Search mode: vector (semantic intent) or hybrid (combined, default). keyword is deprecated, maps to hybrid, and emits a warning. The Postgres backend executes hybrid vector+lexical retrieval for all supported modes and reports vector-mode degradation explicitly.',
        default: 'hybrid',
      },
      includeDiagnostics: {
        type: 'boolean',
        description:
          'When true, include retrieval pipeline diagnostics (lanes, candidate counts, fusion, and available latencies). Default: false',
        default: false,
      },
    },
    required: ['projectId', 'query'],
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
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourcePath: {
                  type: 'string',
                  description: 'Relative file path where the match was found',
                },
                startLine: {
                  type: 'number',
                  description: 'Starting line number of the match',
                },
                endLine: {
                  type: 'number',
                  description: 'Ending line number of the match',
                },
                content: {
                  type: 'string',
                  description: 'Content of the matching code chunk',
                },
                score: {
                  type: 'number',
                  description: 'Relevance score (higher = more relevant)',
                },
                symbolName: {
                  type: 'string',
                  description: 'Name of the symbol if applicable',
                },
                symbolKind: {
                  type: 'string',
                  description: 'Type of symbol (function, class, interface, etc.)',
                },
              },
              required: ['sourcePath', 'content', 'score'],
            },
          },
          query: {
            type: 'string',
            description: 'The original search query',
          },
          mode: {
            type: 'string',
            enum: ['hybrid'],
            description: 'Actual search mode used by the current backend',
          },
          requestedMode: {
            type: 'string',
            enum: ['keyword', 'vector', 'hybrid'],
            description:
              'Requested public search mode; keyword is a deprecated compatibility alias.',
          },
          fallbackUsed: {
            type: 'boolean',
            description: 'Whether the handler used a fallback path',
          },
          warnings: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: 'Warnings emitted while handling the search request',
          },
          truncation: {
            type: 'object',
            description: 'Output payload truncation metadata for bounded MCP responses',
            properties: {
              truncated: { type: 'boolean' },
              maxChars: { type: 'number' },
              originalEntries: { type: 'number' },
              returnedEntries: { type: 'number' },
              originalChars: { type: 'number' },
              returnedChars: { type: 'number' },
              droppedEntries: { type: 'number' },
            },
            required: [
              'truncated',
              'maxChars',
              'originalEntries',
              'returnedEntries',
              'originalChars',
              'returnedChars',
              'droppedEntries',
            ],
          },
          diagnostics: {
            type: 'object',
            description: 'Optional retrieval diagnostics when includeDiagnostics=true',
            properties: {
              pipeline: { type: 'string' },
              mode: { type: 'string', enum: ['vector', 'hybrid'] },
              deterministic: {
                type: 'boolean',
                description:
                  'Whether deterministic execution was used (false for the current backend)',
              },
              fusion: { type: 'string' },
              lanes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    lane: { type: 'string' },
                    status: { type: 'string', enum: ['executed', 'skipped'] },
                    candidateCount: { type: 'number' },
                    reason: { type: 'string' },
                    latencyMs: { type: 'number' },
                  },
                  required: ['lane', 'status', 'candidateCount'],
                },
              },
              candidates: {
                type: 'object',
                properties: {
                  text: { type: 'number' },
                  vector: { type: 'number' },
                  merged: { type: 'number' },
                  returned: { type: 'number' },
                },
                required: ['text', 'vector', 'merged', 'returned'],
              },
              totalLatencyMs: { type: 'number' },
            },
            required: ['pipeline', 'mode', 'deterministic', 'fusion', 'lanes', 'candidates'],
          },
        },
        required: ['results', 'query', 'mode', 'requestedMode'],
      },
      error: {
        type: 'object',
        description: 'Error details (only present when success=false)',
        properties: {
          code: {
            type: 'string',
            description: 'Error code (VALIDATION_ERROR, NOT_FOUND, INTERNAL_ERROR, RATE_LIMITED)',
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

export const searchProjectCodeOutputSchema = searchProjectCodeTool.outputSchema;

/**
 * get_project_file tool schema for retrieving file metadata and chunks.
 *
 * Retrieves a project file by its source path, returning metadata
 * and all associated chunks with line numbers.
 */
export const getProjectFileTool: Tool = {
  name: 'get_project_file',
  description:
    'Retrieve file metadata and all chunks for a specific file in a project. Use this when you need to see the complete content of a file with line-by-line breakdown.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description:
          'Project registry ID (required) - identifies which project the file belongs to',
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
          file: {
            type: 'object',
            properties: {
              sourcePath: {
                type: 'string',
                description: 'Relative file path',
              },
              status: {
                type: 'string',
                description: 'Indexing status (indexed, pending, error, etc.)',
              },
              lang: {
                type: 'string',
                description: 'Detected programming language',
              },
              sizeBytes: {
                type: 'number',
                description: 'File size in bytes',
              },
              fileModifiedAt: {
                type: 'number',
                description: 'Last modification timestamp',
              },
              freshness: {
                type: 'object',
                description: 'Filesystem freshness check for this indexed file',
                properties: {
                  status: {
                    type: 'string',
                    description: 'fresh, fresh_with_metadata_drift, stale, missing, or unverified',
                  },
                  checkedAt: {
                    type: 'string',
                    description: 'ISO 8601 timestamp when freshness was checked',
                  },
                  reason: {
                    type: 'string',
                    description: 'Additional reason when freshness is not fully clean',
                  },
                  indexedFileModifiedAt: {
                    type: 'number',
                    description: 'Indexed fileModifiedAt timestamp',
                  },
                  currentFileModifiedAt: {
                    type: 'number',
                    description: 'Current filesystem mtime if available',
                  },
                  indexedContentHash: {
                    type: 'string',
                    description: 'Indexed content hash',
                  },
                  currentContentHash: {
                    type: 'string',
                    description: 'Current filesystem content hash when checked',
                  },
                },
                required: ['status', 'checkedAt'],
              },
            },
            required: ['sourcePath', 'status', 'sizeBytes', 'freshness'],
          },
          chunks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chunkIndex: {
                  type: 'number',
                  description: 'Sequential index of the chunk',
                },
                content: {
                  type: 'string',
                  description: 'Content of the chunk',
                },
                startLine: {
                  type: 'number',
                  description: 'Starting line number',
                },
                endLine: {
                  type: 'number',
                  description: 'Ending line number',
                },
                symbolName: {
                  type: 'string',
                  description: 'Symbol name if chunk represents a symbol',
                },
                symbolKind: {
                  type: 'string',
                  description: 'Symbol type if applicable',
                },
              },
              required: ['chunkIndex', 'content'],
            },
          },
          truncation: {
            type: 'object',
            description: 'Output payload truncation metadata for bounded MCP responses',
            properties: {
              truncated: { type: 'boolean' },
              maxChars: { type: 'number' },
              originalEntries: { type: 'number' },
              returnedEntries: { type: 'number' },
              originalChars: { type: 'number' },
              returnedChars: { type: 'number' },
              droppedEntries: { type: 'number' },
            },
            required: [
              'truncated',
              'maxChars',
              'originalEntries',
              'returnedEntries',
              'originalChars',
              'returnedChars',
              'droppedEntries',
            ],
          },
        },
        required: ['file', 'chunks'],
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
 * get_project_outline tool schema for retrieving symbol/file outline.
 *
 * Returns the symbol outline of a file, including function names,
 * class names, interfaces, and their line ranges.
 */
export const getProjectOutlineTool: Tool = {
  name: 'get_project_outline',
  description:
    'Get the symbol outline (functions, classes, interfaces, etc.) for a specific file. Use this to understand the structure of a file before examining its full content.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description:
          'Project registry ID (required) - identifies which project the file belongs to',
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
          symbols: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Symbol name',
                },
                kind: {
                  type: 'string',
                  description: 'Symbol type (function, class, interface, type, variable, etc.)',
                },
                startLine: {
                  type: 'number',
                  description: 'Starting line number',
                },
                endLine: {
                  type: 'number',
                  description: 'Ending line number',
                },
                signature: {
                  type: 'string',
                  description: 'Symbol signature if available',
                },
              },
              required: ['name', 'kind'],
            },
          },
        },
        required: ['sourcePath', 'symbols'],
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
 * register_project tool schema for registering a new project.
 *
 * Registers a project with its root path, explicit ingest folders, and optional metadata.
 * Returns project ID, slug, and status.
 */
export const registerProjectTool: Tool = {
  name: 'register_project',
  description:
    'Register a new project in the RAG system. Critical scope warning applies: confirm the intended project roots and pass scopeAck=I_UNDERSTAND_PROJECT_RAG_SCOPE_V1 before registration. Returns project ID, slug, and registration status. Supports optional blocked-finding allowlist replacement.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Project name (required) - human-readable name for the project',
      },
      rootPath: {
        type: 'string',
        description: 'Absolute root path to the project directory (required)',
      },
      includeRoots: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          'Explicit relative folders to ingest inside the project root (required). Example: ["src", "packages/app", "docs"].',
        minItems: 1,
      },
      scopeAck: {
        type: 'string',
        enum: [PROJECT_SCOPE_ACK_TOKEN],
        description:
          'Optional confirmation token for the second call. Omit it on the first attempt to receive the mandatory scope warning, then re-run with this exact token.',
      },
      gitRemote: {
        type: 'string',
        description: 'Optional: Git remote URL (e.g., https://github.com/user/repo.git)',
      },
      defaultBranch: {
        type: 'string',
        description: 'Optional: Default branch name (e.g., main, master)',
      },
      blockedFindingAllowlist: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            relativePath: {
              type: 'string',
              description: 'Project-relative path to a blocked directory',
            },
            category: {
              type: 'string',
              description: 'Blocked-finding category (e.g. dependency_dir, cache_dir)',
            },
          },
          required: ['relativePath', 'category'],
        },
        maxItems: 32,
        description:
          'Blocked-finding allowlist entries. Each has a project-relative path and a category. Requires replaceBlockedFindingAllowlist=true when present.',
      },
      replaceBlockedFindingAllowlist: {
        type: 'boolean',
        description:
          'When true, replaces the stored blocked-finding allowlist with blockedFindingAllowlist. Requires blockedFindingAllowlist to be present ([] to clear). When omitted, preserves current DB allowlist.',
      },
    },
    required: ['name', 'rootPath', 'includeRoots'],
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
          projectId: {
            type: 'string',
            description: 'Unique project registry ID',
          },
          slug: {
            type: 'string',
            description: 'URL-friendly project slug',
          },
          status: {
            type: 'string',
            description: 'Project status (active, paused, blocked, archived)',
          },
          includeRoots: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: 'Normalized relative folders that will be ingested for this project',
          },
          created: {
            type: 'boolean',
            description: 'True if this was a new registration, false if existing was updated',
          },
          allowlistAction: {
            type: 'string',
            enum: ['preserved', 'replaced', 'cleared'],
            description:
              'What happened to the blocked-finding allowlist: preserved (unchanged), replaced (replaced with new list), or cleared (set to empty)',
          },
          effectiveBlockedFindingAllowlist: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Effective blocked-finding allowlist (relative paths only) after the registration',
          },
        },
        required: [
          'projectId',
          'slug',
          'status',
          'includeRoots',
          'created',
          'allowlistAction',
          'effectiveBlockedFindingAllowlist',
        ],
      },
      error: {
        type: 'object',
        description: 'Error details (only present when success=false)',
        properties: {
          code: {
            type: 'string',
            description: 'Error code (VALIDATION_ERROR, CONFLICT, INTERNAL_ERROR)',
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
 * prepare_project tool schema for bounded, on-demand project preparation.
 *
 * Preparation resolves one canonical trusted root, ensures the selected
 * Project RAG runtime, resumes bounded non-forced ingest, and verifies the
 * index before reporting ready. It does not require a scope prompt because
 * the operation applies the same trusted-root and ABAC checks as the CLI.
 */
export const prepareProjectTool: Tool = {
  name: 'prepare_project',
  description:
    'Prepare one selected Project RAG root for retrieval. Ensures only the selected Postgres and embedding dependencies, resumes bounded non-forced ingestion, and verifies the index before ready=true. Existing registration identity and include roots are preserved; new projects infer ordinary source roots safely. Returns progress and a retry action when bounded work remains.',
  inputSchema: {
    type: 'object',
    properties: {
      rootPath: {
        type: 'string',
        description: 'Absolute project root to prepare (required).',
      },
      projectId: {
        type: 'string',
        description:
          'Optional registered project ID or slug. It must match rootPath when supplied.',
      },
      includeRoots: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'Optional relative source roots for a new project; registered scope is preserved.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1,
        maximum: 3600000,
        description: 'Total preparation deadline in milliseconds (default: 120000).',
      },
      maxFiles: {
        type: 'number',
        minimum: 1,
        maximum: 2000,
        description: 'Maximum files handled per bounded ingest step (default: 120).',
      },
      maxBatches: {
        type: 'number',
        minimum: 1,
        maximum: 128,
        description: 'Maximum resumable ingest batches (default: 32).',
      },
    },
    required: ['rootPath'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ready', 'running', 'partial', 'blocked', 'failed'] },
          ready: { type: 'boolean' },
          stage: { type: 'string', enum: ['resolve', 'runtime', 'verify', 'ingest', 'ready'] },
          operation: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              deduplicated: { type: 'boolean' },
            },
            required: ['id', 'deduplicated'],
          },
          project: { type: 'object' },
          runtime: { type: 'object' },
          progress: { type: 'object' },
          verification: { type: 'object' },
          reason: { type: 'object' },
          nextAction: { type: 'string' },
        },
        required: ['status', 'ready', 'stage', 'operation', 'project', 'progress'],
      },
      error: { type: 'object' },
    },
    required: ['success'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/**
 * verify_project_index tool schema for verifying project index health and freshness.
 *
 * Queries statistics from projectFiles, projectChunks, and projectSyncRuns
 * to provide a comprehensive health summary.
 */
export const verifyProjectIndexTool: Tool = {
  name: 'verify_project_index',
  description:
    'Verify the health, coverage, and filesystem freshness of a project index. Returns statistics including file count, chunk count, symbol count, last sync timestamp, and freshness summary.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Project registry ID (required) - identifies which project to verify',
      },
    },
    required: ['projectId'],
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
          projectId: {
            type: 'string',
            description: 'Project registry ID',
          },
          fileCount: {
            type: 'number',
            description: 'Number of indexed files',
          },
          chunkCount: {
            type: 'number',
            description: 'Number of chunks',
          },
          symbolCount: {
            type: 'number',
            description: 'Number of extracted symbols',
          },
          lastSyncAt: {
            description:
              'ISO 8601 timestamp of last sync, or null when the backend has no persisted sync timestamp',
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          coverage: {
            type: 'string',
            description: 'Coverage status summary',
          },
          status: {
            type: 'string',
            description: 'Project status',
          },
          freshness: {
            type: 'object',
            description: 'Filesystem freshness summary for indexed project files',
            properties: {
              status: {
                type: 'string',
                description: 'fresh, fresh_with_metadata_drift, stale, missing, or unverified',
              },
              checkedFiles: {
                type: 'number',
                description: 'Number of files checked against the filesystem',
              },
              eligibleFiles: {
                type: 'number',
                description: 'Number of indexed/skipped files eligible for freshness checks',
              },
              freshFiles: {
                type: 'number',
                description: 'Files whose indexed content matches the filesystem',
              },
              staleFiles: {
                type: 'number',
                description: 'Files whose indexed content differs from the filesystem',
              },
              missingFiles: {
                type: 'number',
                description: 'Indexed files missing on disk',
              },
              metadataDriftFiles: {
                type: 'number',
                description: 'Files whose mtime changed while content hash still matches',
              },
              unverifiedFiles: {
                type: 'number',
                description: 'Files that could not be verified',
              },
              stalePaths: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Sample list of stale or missing file paths',
              },
              checkedAt: {
                type: 'string',
                description: 'ISO 8601 timestamp when freshness was checked',
              },
              versionSignals: {
                type: 'object',
                description:
                  'Version-readiness compatibility counters used during migration from status-only rows',
                properties: {
                  filesWithVersionMetadata: { type: 'number' },
                  filesWithActiveReadyVersion: { type: 'number' },
                  filesWithNonReadyActiveVersion: { type: 'number' },
                  filesPendingVersionBackfill: { type: 'number' },
                  filesUsingLegacyStatusRead: { type: 'number' },
                },
              },
            },
            required: [
              'status',
              'checkedFiles',
              'eligibleFiles',
              'freshFiles',
              'staleFiles',
              'missingFiles',
              'metadataDriftFiles',
              'unverifiedFiles',
              'stalePaths',
              'checkedAt',
              'versionSignals',
            ],
          },
          versionReadiness: {
            type: 'object',
            description:
              'Project-wide counters for active-ready reads and migration/backfill compatibility state',
            properties: {
              filesWithVersionMetadata: { type: 'number' },
              filesWithActiveReadyVersion: { type: 'number' },
              filesWithNonReadyActiveVersion: { type: 'number' },
              filesPendingVersionBackfill: { type: 'number' },
              filesUsingLegacyStatusRead: { type: 'number' },
            },
          },
          ownershipCoverage: {
            type: 'object',
            description:
              'Ownership/graph integrity summary over chunk->file, symbol->file/chunk, edge references, and deleted-file leakage signals',
            properties: {
              status: {
                type: 'string',
                description: 'covered, drift, or unverified',
              },
              chunkFileOrphans: { type: 'number' },
              symbolFileOrphans: { type: 'number' },
              symbolChunkOrphans: { type: 'number' },
              edgeMissingSourceFileRefs: { type: 'number' },
              edgeMissingTargetFileRefs: { type: 'number' },
              edgeMissingSourceSymbolRefs: { type: 'number' },
              edgeMissingTargetSymbolRefs: { type: 'number' },
              deletedFileChunkRefs: { type: 'number' },
              deletedFileSymbolRefs: { type: 'number' },
              deletedFileEdgeRefs: { type: 'number' },
              sampleRefs: {
                type: 'array',
                items: { type: 'string' },
              },
              reason: { type: 'string' },
            },
            required: [
              'status',
              'chunkFileOrphans',
              'symbolFileOrphans',
              'symbolChunkOrphans',
              'edgeMissingSourceFileRefs',
              'edgeMissingTargetFileRefs',
              'edgeMissingSourceSymbolRefs',
              'edgeMissingTargetSymbolRefs',
              'deletedFileChunkRefs',
              'deletedFileSymbolRefs',
              'deletedFileEdgeRefs',
              'sampleRefs',
            ],
          },
          invariants: {
            type: 'object',
            description: 'Central invariant contract summary and check-level status details',
            properties: {
              summary: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    description: 'covered, drift, or unverified',
                  },
                  driftedChecks: { type: 'number' },
                  unverifiedChecks: { type: 'number' },
                },
                required: ['status', 'driftedChecks', 'unverifiedChecks'],
              },
              checks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    status: { type: 'string' },
                    detail: { type: 'string' },
                  },
                  required: ['key', 'status', 'detail'],
                },
              },
            },
            required: ['summary', 'checks'],
          },
          gateSignal: {
            type: 'object',
            description:
              'Semantic readiness gate. success=true only confirms transport/tool execution, while gateSignal.ready confirms contract readiness.',
            properties: {
              ready: {
                type: 'boolean',
                description: 'Whether the project index is semantically ready for contract checks',
              },
              blockingFailureCode: {
                description:
                  'Blocking readiness failure code. null means there is no semantic blocker.',
                oneOf: [
                  {
                    type: 'string',
                    enum: [
                      'PROJECT_INDEX_EMPTY',
                      'PROJECT_INDEX_STALE',
                      'PROJECT_INDEX_UNVERIFIED',
                      'PROJECT_INDEX_SCOPE_DRIFT',
                      'PROJECT_INDEX_EMBEDDING_GAP',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
            required: ['ready', 'blockingFailureCode'],
          },
          watcher: {
            type: 'object',
            description:
              'Watcher lifecycle status for this project root at verification time. This is operational state, not semantic readiness.',
            properties: {
              status: {
                type: 'string',
                enum: ['started', 'already_running', 'failed', 'skipped'],
                description: 'Watcher startup status',
              },
              pid: {
                type: 'number',
                description: 'Watcher process id when available',
              },
              rootPath: {
                type: 'string',
                description: 'Absolute root path associated with the watcher operation',
              },
              slug: {
                type: 'string',
                description: 'Project slug associated with the watcher operation',
              },
              logPath: {
                type: 'string',
                description: 'Watcher log path when available',
              },
              metadataPath: {
                type: 'string',
                description: 'Watcher metadata path when available',
              },
              reason: {
                type: 'string',
                description: 'Additional reason, especially when watcher status is skipped/failed',
              },
            },
            required: ['status', 'rootPath'],
          },
        },
        required: [
          'projectId',
          'fileCount',
          'chunkCount',
          'symbolCount',
          'coverage',
          'freshness',
          'versionReadiness',
          'gateSignal',
          'watcher',
        ],
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
// Type Definitions
// ============================================================================

/**
 * Search project code request parameters.
 */
export interface SearchProjectCodeArgs {
  /** Project registry ID */
  projectId: string;
  /** Search query string */
  query: string;
  /** Maximum results to return (default: 10) */
  limit?: number;
  /** Optional active file context */
  activeFile?: string;
  /** Search mode: vector or hybrid (default: hybrid); keyword is deprecated. */
  mode?: 'keyword' | 'vector' | 'hybrid';
  /** Include retrieval pipeline diagnostics in response data */
  includeDiagnostics?: boolean;
}

export interface ProjectSearchLaneDiagnostics {
  lane: string;
  status: 'executed' | 'skipped';
  candidateCount: number;
  reason?: string;
  latencyMs?: number;
}

export interface ProjectSearchDiagnostics {
  pipeline: string;
  mode: 'vector' | 'hybrid';
  deterministic: boolean;
  fusion: string;
  lanes: ProjectSearchLaneDiagnostics[];
  candidates: {
    text: number;
    vector: number;
    merged: number;
    returned: number;
  };
  totalLatencyMs?: number;
}

/**
 * Project code search result.
 *
 * Note: startLine and endLine are optional because not all chunks
 * have line number information (e.g., binary files, generated content).
 */
export interface ProjectCodeSearchResult {
  /** Relative file path */
  sourcePath: string;
  /** Starting line number (optional - may be undefined for some chunks) */
  startLine?: number;
  /** Ending line number (optional - may be undefined for some chunks) */
  endLine?: number;
  /** Content of the matching chunk */
  content: string;
  /** Relevance score (higher = more relevant) */
  score: number;
  /** Symbol name if applicable */
  symbolName?: string;
  /** Symbol type if applicable */
  symbolKind?: string;
}

/**
 * Get project file request parameters.
 */
export interface GetProjectFileArgs {
  /** Project registry ID */
  projectId: string;
  /** Relative source path to the file */
  sourcePath: string;
}

/**
 * Project file chunk.
 */
export interface ProjectFileChunk {
  /** Sequential chunk index */
  chunkIndex: number;
  /** Chunk content */
  content: string;
  /** Starting line number */
  startLine?: number;
  /** Ending line number */
  endLine?: number;
  /** Symbol name if applicable */
  symbolName?: string;
  /** Symbol type if applicable */
  symbolKind?: string;
}

export interface ProjectFileFreshnessInfo {
  /** Freshness status for the indexed file */
  status: 'fresh' | 'fresh_with_metadata_drift' | 'stale' | 'missing' | 'unverified';
  /** ISO 8601 timestamp when freshness was checked */
  checkedAt: string;
  /** Optional explanation when freshness is degraded */
  reason?: string;
  /** Indexed mtime */
  indexedFileModifiedAt?: number;
  /** Current filesystem mtime */
  currentFileModifiedAt?: number;
  /** Indexed content hash */
  indexedContentHash?: string;
  /** Current filesystem hash */
  currentContentHash?: string;
}

/**
 * Get project outline request parameters.
 */
export interface GetProjectOutlineArgs {
  /** Project registry ID */
  projectId: string;
  /** Relative source path to the file */
  sourcePath: string;
}

/**
 * Project outline symbol.
 */
export interface ProjectOutlineSymbol {
  /** Symbol name */
  name: string;
  /** Symbol type (function, class, interface, etc.) */
  kind: string;
  /** Starting line number */
  startLine?: number;
  /** Ending line number */
  endLine?: number;
  /** Symbol signature if available */
  signature?: string;
}

/**
 * A blocked-finding allowlist entry.
 */
export interface BlockedFindingAllowlistInput {
  readonly relativePath: string;
  readonly category: string;
}

/**
 * Register project request parameters.
 */
export interface RegisterProjectArgs {
  /** Project name */
  name: string;
  /** Absolute root path to the project */
  rootPath: string;
  /** Explicit relative folders to ingest inside the project root */
  includeRoots: string[];
  /** Optional Git remote URL */
  gitRemote?: string;
  /** Optional default branch name */
  defaultBranch?: string;
  /**
   * Optional blocked-finding allowlist entries.
   * Each entry: { relativePath: string, category: string }.
   * Max 32 entries.
   */
  blockedFindingAllowlist?: BlockedFindingAllowlistInput[];
  /**
   * When true, REQUIRES blockedFindingAllowlist to be present.
   * Replaces (or clears with []) the stored allowlist.
   * Omission of both fields preserves the current DB allowlist.
   */
  replaceBlockedFindingAllowlist?: boolean;
}

/**
 * Allowlist action for the registration result.
 */
export type AllowlistAction = 'preserved' | 'replaced' | 'cleared';

/**
 * Project registration result.
 */
export interface ProjectRegistrationResult {
  /** Unique project registry ID */
  projectId: string;
  /** URL-friendly project slug */
  slug: string;
  /** Project status */
  status: string;
  /** Normalized relative folders that will be ingested */
  includeRoots: string[];
  /** True if newly created, false if updated */
  created: boolean;
  /** What happened to the blocked-finding allowlist */
  allowlistAction: AllowlistAction;
  /** Effective blocked-finding allowlist (relative paths only) */
  effectiveBlockedFindingAllowlist: string[];
}

/**
 * Verify project index request parameters.
 */
export interface VerifyProjectIndexArgs {
  /** Project registry ID */
  projectId: string;
}

/**
 * Project index verification result.
 */
export interface ProjectIndexVerificationResult {
  /** Project registry ID */
  projectId: string;
  /** Number of indexed files */
  fileCount: number;
  /** Number of chunks */
  chunkCount: number;
  /** Number of extracted symbols */
  symbolCount: number;
  /** ISO 8601 timestamp of last sync, or null when unavailable */
  lastSyncAt?: string | null;
  /** Coverage status summary */
  coverage: string;
  /** Project status */
  status?: string;
  /** Optional freshness summary */
  freshness?: {
    status: 'fresh' | 'fresh_with_metadata_drift' | 'stale' | 'missing' | 'unverified';
    checkedFiles: number;
    eligibleFiles: number;
    freshFiles: number;
    staleFiles: number;
    missingFiles: number;
    metadataDriftFiles: number;
    unverifiedFiles: number;
    stalePaths: string[];
    checkedAt: string;
  };
  /** Optional ownership/graph integrity summary */
  ownershipCoverage?: {
    status: 'covered' | 'drift' | 'unverified';
    chunkFileOrphans: number;
    symbolFileOrphans: number;
    symbolChunkOrphans: number;
    edgeMissingSourceFileRefs: number;
    edgeMissingTargetFileRefs: number;
    edgeMissingSourceSymbolRefs: number;
    edgeMissingTargetSymbolRefs: number;
    deletedFileChunkRefs: number;
    deletedFileSymbolRefs: number;
    deletedFileEdgeRefs: number;
    sampleRefs: string[];
    reason?: string;
  };
  /** Optional invariant contract summary */
  invariants?: {
    summary: {
      status: 'covered' | 'drift' | 'unverified';
      driftedChecks: number;
      unverifiedChecks: number;
    };
    checks: Array<{
      key: string;
      status: 'covered' | 'drift' | 'unverified';
      detail: string;
    }>;
  };
  /** Semantic contract readiness gate */
  gateSignal: {
    ready: boolean;
    blockingFailureCode:
      | 'PROJECT_INDEX_EMPTY'
      | 'PROJECT_INDEX_STALE'
      | 'PROJECT_INDEX_UNVERIFIED'
      | 'PROJECT_INDEX_SCOPE_DRIFT'
      | 'PROJECT_INDEX_EMBEDDING_GAP'
      | null;
  };
  /** Project watcher lifecycle status at verification time */
  watcher: {
    status: 'started' | 'already_running' | 'failed' | 'skipped';
    pid?: number;
    rootPath: string;
    slug?: string;
    logPath?: string;
    metadataPath?: string;
    reason?: string;
  };
}

/**
 * Canonical Project RAG MCP tools exposed by the live stdio server.
 *
 * Compatibility aliases remain available separately, but these tool
 * definitions are the primary public interface for project workflows.
 */
export const publicProjectTools: Tool[] = [
  searchProjectCodeTool,
  getProjectFileTool,
  getProjectOutlineTool,
  registerProjectTool,
  prepareProjectTool,
  verifyProjectIndexTool,
];
