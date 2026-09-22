import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * @module handlers
 * @description MCP tool handler implementations for the RAG-v1 knowledge base.
 *
 * This module implements the business logic for all MCP tools exposed by the
 * RAG server. Each handler function processes tool arguments, interacts with
 * the active RAG backend, and returns formatted responses.
 *
 * Available Handlers:
 * - `handleSearchDocs`: Hybrid search for documentation chunks
 * - `handleSearchAndAdapt`: Unified search + adaptation for simplified UX
 * - `handleIngestProject`: Full project ingestion
 * - `handleIngestProjectFile`: Single file ingestion
 * - `handleListCategories`: List all categories
 * - `handleGetDocument`: Retrieve full document content
 * - `handleHealthCheck`: Verify server health
 *
 * Project RAG defaults to Postgres for registration, ingestion, and search.
 * Docs RAG reads use the isolated Postgres lab.
 *
 * @example
 * // Handler response format
 * {
 *   content: [{ type: 'text', text: 'Response message...' }],
 *   isError: false, // true for errors
 * }
 *
 * @see tools.ts - For tool schema definitions
 * @see server.ts - For tool registration and routing
 */
import { logger } from '../lib/logger.js';
import {
  PROJECT_SCOPE_ACK_TOKEN,
  requireProjectScopeAck,
} from '../lib/shared/project-scope-advisory.js';
import { SCRIPT_CONFIG } from '../scripts/lib/config.js';
import {
  createSecurityErrorResponse,
  validateBoolean,
  validateNumber,
  validateString,
} from './lib/input-validation.js';
import { validateProjectRootPath } from './lib/path-validator.js';

export {
  handleAdaptDocs,
  handleEnsureReranker,
  handleGetDocument,
  handleHealthCheck,
  handleListCategories,
  handleSearchAndAdapt,
  handleSearchDocs,
} from './docs-handlers.js';

const DEFAULT_INVENTORY_PATH = join(process.cwd(), 'docs/architecture/code_inventory.md');
const INVENTORY_PATH_ENV = 'RAG_CODE_INVENTORY_PATH';
const DEFAULT_PROJECT_INGEST_MAX_FILES = 120;

function resolveProjectIngestMaxFiles(requestedMaxFiles?: number): number {
  const configured = Number(process.env.MCP_FULL_PROJECT_INGEST_MAX_FILES);
  const budget =
    Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_PROJECT_INGEST_MAX_FILES;
  const requested = requestedMaxFiles ?? budget;
  return process.env.MCP_ALLOW_LARGE_PROJECT_INGEST === 'true'
    ? requested
    : Math.min(requested, budget);
}

function getInventoryPath(): string {
  return process.env[INVENTORY_PATH_ENV] || DEFAULT_INVENTORY_PATH;
}

/**
 * Trigger full project ingestion into the RAG index.
 *
 * Initiates Project RAG Postgres ingestion for the configured repository.
 *
 * @param args.force - If true, re-index all files regardless of content hash
 * @param args.rootPath - Optional override for project root (backward-compatible with env config)
 *
 * @returns MCP-formatted response with ingestion summary
 *
 * @example
 * // Trigger full ingestion
 * const result = await handleIngestProject({ force: false });
 * // Returns: { content: [{ type: 'text', text: '✅ Project ingestion complete...' }] }
 *
 */
export type ExecutionMode = 'inline' | 'durable';

function normalizeExecutionMode(value: unknown): ExecutionMode | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'inline') return 'inline';
  if (lower === 'durable') return 'durable';
  return undefined;
}

export async function handleIngestProject(args?: {
  force?: boolean;
  rootPath?: string;
  includeRoots?: string[];
  scopeAck?: string;
  maxFiles?: number;
  executionMode?: ExecutionMode;
}) {
  // Normalize execution mode (case-insensitive) and reject unknown values
  const normalizedMode = normalizeExecutionMode(args?.executionMode);
  if (args?.executionMode !== undefined && normalizedMode === undefined) {
    return {
      content: [
        {
          type: 'text',
          text: `🚫 Invalid executionMode "${String(args.executionMode)}". Use "inline" (default) or "durable".`,
        },
      ],
      structuredContent: {
        success: false,
        error: {
          code: 'INVALID_EXECUTION_MODE',
          message: `executionMode must be "inline" or "durable", got "${String(args.executionMode)}".`,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }

  const rootPath = args?.rootPath || SCRIPT_CONFIG.PROJECT_SOURCE_PATH;
  if (!rootPath) {
    return {
      content: [
        {
          type: 'text',
          text: '🚫 Missing ingestion root path. Provide rootPath or set PROJECT_SOURCE_PATH.',
        },
      ],
      structuredContent: {
        success: false,
        error: {
          code: 'MISSING_ROOT',
          message: 'Missing ingestion root path. Provide rootPath or set PROJECT_SOURCE_PATH.',
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }

  const pathValidation = validateProjectRootPath(rootPath);
  if (!pathValidation.valid) {
    return createSecurityErrorResponse(pathValidation.error);
  }

  const scopeAckValidation = requireProjectScopeAck(args?.scopeAck, {
    operation: 'ingest',
    rootPath,
    includeRoots: args?.includeRoots,
    target: 'project-rag-postgres',
  });
  if (!scopeAckValidation.valid) {
    const message = `${scopeAckValidation.error}\n\n${scopeAckValidation.advisory}\n\nPass scopeAck=${PROJECT_SCOPE_ACK_TOKEN} to continue.`;
    return {
      content: [{ type: 'text', text: message }],
      structuredContent: {
        success: false,
        error: {
          code: 'SCOPE_CONFIRMATION_REQUIRED',
          message,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }

  if (normalizedMode === 'durable') {
    try {
      const [
        {
          createProjectRagPostgresSql,
          enqueueProjectRagJob,
          findProjectRagPostgresProjectByRootPath,
        },
        { resolveProjectRagPostgresWriteConfig },
        { PROJECT_INGEST_FULL_JOB },
      ] = await Promise.all([
        import('../scripts/project-rag/store.js'),
        import('../scripts/project-rag/config.js'),
        import('../scripts/project-rag/job-worker.js'),
      ]);
      const sql = createProjectRagPostgresSql(resolveProjectRagPostgresWriteConfig());
      try {
        const payload = {
          rootPath,
          includeRoots: args?.includeRoots ?? [],
          force: args?.force,
          maxFiles: resolveProjectIngestMaxFiles(args?.maxFiles),
        };
        // Same scope must collide regardless of includeRoots order, so the
        // key is normalized and includes every scope-affecting option.
        const dedupeKey = `${PROJECT_INGEST_FULL_JOB}:${rootPath}:${JSON.stringify([...payload.includeRoots].sort())}:${Boolean(payload.force)}:${payload.maxFiles}`;
        // Bind the job to the registered project for this root, when known.
        const project = await findProjectRagPostgresProjectByRootPath(sql, rootPath);
        const job = await enqueueProjectRagJob(sql, {
          type: PROJECT_INGEST_FULL_JOB,
          projectId: project?.id,
          dedupeKey,
          payload,
        });
        return {
          content: [{ type: 'text', text: `Project ingestion job queued: ${job.id}` }],
          structuredContent: {
            success: true,
            data: { jobId: job.id, status: job.status, deduplicated: !job.inserted },
          },
        };
      } finally {
        await sql.close({ timeout: 5 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to queue Project RAG ingestion: ${message}` }],
        structuredContent: {
          success: false,
          error: { code: 'JOB_QUEUE_FAILED', message, timestamp: new Date().toISOString() },
        },
        isError: true,
      };
    }
  }

  try {
    const { ingestProjectRagPostgres } = await import('../scripts/project-rag/ingest-postgres.js');
    const result = await ingestProjectRagPostgres({
      rootPath,
      includeRoots: args?.includeRoots ?? [],
      force: args?.force,
      maxFiles: resolveProjectIngestMaxFiles(args?.maxFiles),
    });

    // Snapshot gate check — refuse if gate is missing or not CONSUMED.
    // Partial writes now fail the snapshot with thresholdResult
    // `partial_ingest_not_consumed:*` so the next run can re-prepare. That is
    // not a pre-write gate refusal; map it to INGESTION_PARTIAL below.
    const gate = result.snapshotGate;
    const isPartialIngestNotConsumed =
      gate?.status === 'FAILED' &&
      String(gate.thresholdResult ?? '').startsWith('partial_ingest_not_consumed');
    if (gate?.status !== 'CONSUMED' && !isPartialIngestNotConsumed) {
      if (!gate) {
        return {
          content: [
            {
              type: 'text',
              text: '🚫 Project snapshot gate is missing from ingestion result. Ingestion refused.',
            },
          ],
          structuredContent: {
            success: false,
            error: {
              code: 'PROJECT_SNAPSHOT_MISSING',
              message:
                'Snapshot gate is missing from ingestion result. The ingestion pipeline did not produce a gate result. Ingestion refused.',
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const isReviewRequired = gate.status === 'REVIEW_REQUIRED';
      const errorCode = isReviewRequired
        ? 'PROJECT_SNAPSHOT_REVIEW_REQUIRED'
        : 'PROJECT_SNAPSHOT_FAILED';
      const summary = gate.preflightSummary
        ? `${gate.preflightSummary.addsCount} adds, ${gate.preflightSummary.updatesCount} updates, ${gate.preflightSummary.deletesCount} deletes`
        : 'unknown';
      return {
        content: [
          {
            type: 'text',
            text: isReviewRequired
              ? `Project snapshot requires review (UUID: ${gate.snapshotUuid}). Preflight: ${summary}. Use the snapshot review workflow before ingesting.`
              : `Project snapshot gate failed (UUID: ${gate.snapshotUuid}, reason: ${gate.thresholdResult}). Preflight: ${summary}. Ingestion refused.`,
          },
        ],
        structuredContent: {
          success: false,
          error: {
            code: errorCode,
            message: isReviewRequired
              ? `Snapshot gate status is REVIEW_REQUIRED. Snapshot ${gate.snapshotUuid} must be reviewed before ingest proceeds. Preflight delta: ${summary}.`
              : `Snapshot gate status is ${gate.status}. Snapshot ${gate.snapshotUuid} cannot proceed to ingestion. Reason: ${gate.thresholdResult}. Preflight delta: ${summary}.`,
            timestamp: new Date().toISOString(),
            snapshotUuid: gate.snapshotUuid,
            retryable: false,
          },
        },
        isError: true,
      };
    }

    const hasRemainingWork = (result.continuation?.remainingOperations ?? 0) > 0;
    if (result.finalStatus !== 'completed' || result.stats.errors.length > 0 || hasRemainingWork) {
      const firstError = result.stats.errors[0];
      const message = firstError
        ? `Project Postgres ingestion incomplete: ${firstError.file}: ${firstError.error}`
        : result.continuation
          ? `Project Postgres ingestion incomplete: ${result.continuation.remainingOperations} operations remain ` +
            `(${result.continuation.remainingStalePaths} stale deletes, ` +
            `${result.continuation.remainingCandidateFiles} candidate files). Re-run ingestion to continue.`
          : `Project Postgres ingestion incomplete (${result.finalStatus})`;
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: {
          success: false,
          error: {
            code: 'INGESTION_PARTIAL',
            message,
            timestamp: new Date().toISOString(),
          },
          data: result,
        },
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `✅ Project Postgres ingestion complete (${result.finalStatus})\n` +
            `- Project: ${result.slug} (${result.projectId})\n` +
            `- Scanned: ${result.stats.filesScanned}\n` +
            `- Selected: ${result.stats.filesSelected}\n` +
            `- Indexed: ${result.stats.filesIndexed}\n` +
            `- Blocked: ${result.stats.filesBlocked}\n` +
            `- Deleted: ${result.stats.filesDeleted}\n` +
            `- Chunks: ${result.stats.chunksCreated}\n` +
            `- Embeddings: ${result.stats.embeddingsCreated}\n` +
            `- Errors: ${result.stats.errors.length}`,
        },
      ],
      structuredContent: {
        success: true,
        data: result,
      },
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // Sanitize: remove absolute paths and internal numeric IDs to prevent
    // sensitive path / id leaks in MCP responses.
    const sanitized = rawMessage
      .replace(/\/(?:[^\s/]+\/?)+/g, '<path>')
      .replace(/[A-Za-z]:\\[^\s]*/g, '<path>')
      .replace(/id=\d+/g, 'id=<sn>')
      .replace(/snapshot_id[:=]\s*\d+/gi, 'snapshot_id=<sn>')
      .replace(/project_id[:=]\s*\d+/gi, 'project_id=<sn>')
      .replace(/postgres[Ii]d[:=]\s*\d+/gi, 'postgresId=<sn>');
    const errorCode: string =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as Record<string, unknown>).code === 'string'
        ? ((error as Record<string, unknown>).code as string)
        : 'INTERNAL_ERROR';
    logger.error({ error, operation: 'mcp' }, 'Failed to ingest project into Postgres');
    return {
      content: [{ type: 'text', text: `Failed to ingest project into Postgres: ${sanitized}` }],
      structuredContent: {
        success: false,
        error: {
          code: errorCode,
          message: sanitized,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }
}

/**
 * Trigger ingestion for a single project file.
 *
 * Processes a specific file from the project repository, computing its
 * content hash to determine if re-indexing is necessary (unless force=true).
 *
 * @param args.filePath - Absolute path to the file to ingest
 * @param args.force - If true, re-index even if content hash matches
 * @param args.rootPath - Optional override for project root (backward-compatible with env config)
 *
 * @returns MCP-formatted response indicating success, skip (no changes), or failure
 *
 * @example
 * // Ingest a single file
 * const result = await handleIngestProjectFile({
 *   filePath: "/home/user/project/mcp/handlers.ts",
 *   force: false,
 * });
 *
 * @see ingestProjectFile - Core file ingestion logic
 */
export async function handleIngestProjectFile(args: {
  filePath: string;
  force?: boolean;
  rootPath?: string;
  scopeAck?: string;
}) {
  const rootPath = args.rootPath || SCRIPT_CONFIG.PROJECT_SOURCE_PATH;
  if (!rootPath) {
    return {
      content: [
        {
          type: 'text',
          text: '🚫 Missing ingestion root path. Provide rootPath or set PROJECT_SOURCE_PATH.',
        },
      ],
      structuredContent: {
        success: false,
        error: {
          code: 'MISSING_ROOT',
          message: 'Missing ingestion root path. Provide rootPath or set PROJECT_SOURCE_PATH.',
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }

  const pathValidation = validateProjectRootPath(rootPath);
  if (!pathValidation.valid) {
    return createSecurityErrorResponse(pathValidation.error);
  }

  const scopeAckValidation = requireProjectScopeAck(args.scopeAck, {
    operation: 'ingest',
    rootPath,
    includeRoots: [args.filePath],
    target: 'project-rag-postgres',
  });
  if (!scopeAckValidation.valid) {
    const message = `${scopeAckValidation.error}\n\n${scopeAckValidation.advisory}\n\nPass scopeAck=${PROJECT_SCOPE_ACK_TOKEN} to continue.`;
    return {
      content: [{ type: 'text', text: message }],
      structuredContent: {
        success: false,
        error: {
          code: 'SCOPE_CONFIRMATION_REQUIRED',
          message,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }

  try {
    const { ingestProjectRagPostgresFile } = await import(
      '../scripts/project-rag/ingest-postgres.js'
    );
    const result = await ingestProjectRagPostgresFile({
      rootPath,
      filePath: args.filePath,
      force: args.force,
    });

    // Snapshot gate check — refuse if gate is missing or not CONSUMED.
    // Partial writes fail the snapshot with `partial_ingest_not_consumed:*`
    // and must surface as INGESTION_PARTIAL, not PROJECT_SNAPSHOT_FAILED.
    const gate = result.snapshotGate;
    const isPartialIngestNotConsumed =
      gate?.status === 'FAILED' &&
      String(gate.thresholdResult ?? '').startsWith('partial_ingest_not_consumed');
    if (gate?.status !== 'CONSUMED' && !isPartialIngestNotConsumed) {
      if (!gate) {
        return {
          content: [
            {
              type: 'text',
              text: '🚫 Project snapshot gate is missing from ingestion result. Single-file ingest refused.',
            },
          ],
          structuredContent: {
            success: false,
            error: {
              code: 'PROJECT_SNAPSHOT_MISSING',
              message:
                'Snapshot gate is missing from ingestion result. The ingestion pipeline did not produce a gate result. Single-file ingest refused.',
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const isReviewRequired = gate.status === 'REVIEW_REQUIRED';
      const errorCode = isReviewRequired
        ? 'PROJECT_SNAPSHOT_REVIEW_REQUIRED'
        : 'PROJECT_SNAPSHOT_FAILED';
      const summary = gate.preflightSummary
        ? `${gate.preflightSummary.addsCount} adds, ${gate.preflightSummary.updatesCount} updates, ${gate.preflightSummary.deletesCount} deletes`
        : 'unknown';
      return {
        content: [
          {
            type: 'text',
            text: isReviewRequired
              ? `Project snapshot requires review (UUID: ${gate.snapshotUuid}). Preflight: ${summary}. Single-file ingest refused.`
              : `Project snapshot gate failed (UUID: ${gate.snapshotUuid}, reason: ${gate.thresholdResult}). Preflight: ${summary}. Single-file ingest refused.`,
          },
        ],
        structuredContent: {
          success: false,
          error: {
            code: errorCode,
            message: isReviewRequired
              ? `Snapshot gate status is REVIEW_REQUIRED. Snapshot ${gate.snapshotUuid} must be reviewed before ingest proceeds. Preflight delta: ${summary}.`
              : `Snapshot gate status is ${gate.status}. Snapshot ${gate.snapshotUuid} cannot proceed to ingestion. Reason: ${gate.thresholdResult}. Preflight delta: ${summary}.`,
            timestamp: new Date().toISOString(),
            snapshotUuid: gate.snapshotUuid,
            retryable: false,
          },
        },
        isError: true,
      };
    }

    if (result.finalStatus !== 'completed' || result.stats.errors.length > 0) {
      const firstError = result.stats.errors[0];
      const message = firstError
        ? `Failed to ingest project file into Postgres: ${firstError.file}: ${firstError.error}`
        : `Failed to ingest project file into Postgres: ${result.finalStatus}`;
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: {
          success: false,
          error: {
            code: 'INGESTION_FAILED',
            message,
            timestamp: new Date().toISOString(),
          },
          data: result,
        },
        isError: true,
      };
    }
    const indexed = result.stats.filesIndexed > 0;

    return {
      content: [
        {
          type: 'text',
          text: indexed
            ? `✅ Successfully indexed ${args.filePath} (${result.stats.chunksCreated} chunks)`
            : `⏩ No eligible file indexed: ${args.filePath}`,
        },
      ],
      structuredContent: {
        success: true,
        data: {
          ...result,
          result: {
            status: indexed ? 'indexed' : 'skipped',
          },
        },
      },
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // Sanitize: remove absolute paths and internal numeric IDs
    const sanitized = rawMessage
      .replace(/\/(?:[^\s/]+\/?)+/g, '<path>')
      .replace(/[A-Za-z]:\\[^\s]*/g, '<path>')
      .replace(/id=\d+/g, 'id=<sn>');
    logger.error({ error, operation: 'mcp' }, 'Failed to ingest project file into Postgres');
    return {
      content: [
        { type: 'text', text: `Failed to ingest project file into Postgres: ${sanitized}` },
      ],
      structuredContent: {
        success: false,
        error: {
          code: 'INGESTION_FAILED',
          message: sanitized,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }
}

// ============================================================================
// Inventory Parsing Utilities
// ============================================================================

/**
 * Inventory file entry parsed from markdown table.
 */
interface InventoryEntry {
  id: string;
  status: boolean;
  lines: number | null;
  functions: number;
  exports: number;
  filepath: string;
  description: string;
  category: string;
}

/**
 * Parse the code inventory markdown file.
 *
 * Extracts the last updated timestamp and all file entries from the
 * markdown tables, grouping them by category.
 *
 * @returns Parsed inventory data with timestamp, entries, and categories
 *
 * @throws {Error} When inventory file cannot be read or parsed
 */
function parseInventory(): {
  lastUpdated: string;
  entries: InventoryEntry[];
  categories: string[];
} {
  const inventoryPath = getInventoryPath();
  if (!existsSync(inventoryPath)) {
    throw new Error(`Inventory file not found: ${inventoryPath}`);
  }

  const content = readFileSync(inventoryPath, 'utf-8');

  // Extract last updated timestamp
  const lastUpdatedMatch = content.match(/> Last updated: ([^\n]+)/);
  const lastUpdated = lastUpdatedMatch ? lastUpdatedMatch[1].trim() : 'Unknown';

  // Parse entries from markdown tables
  const entries: InventoryEntry[] = [];
  const categories: string[] = [];

  // Match category headers (### CategoryName) and their tables
  const categoryRegex = /### (\w+)\n\n([\s\S]*?)(?=\n### |\n## |$)/g;
  let categoryMatch = categoryRegex.exec(content);

  while (categoryMatch !== null) {
    const categoryName = categoryMatch[1];
    categories.push(categoryName);

    const tableContent = categoryMatch[2];
    const rowRegex =
      /\| (\d+) \| \[([ x])\] \| ([\d-]+) \| (\d+) \| (\d+) \| `([^`]+)` \| ([^|]*) \|/g;
    let rowMatch = rowRegex.exec(tableContent);

    while (rowMatch !== null) {
      const linesValue = rowMatch[3];
      entries.push({
        id: rowMatch[1],
        status: rowMatch[2] === 'x',
        lines: linesValue === '-' ? null : Number.parseInt(linesValue, 10),
        functions: Number.parseInt(rowMatch[4], 10),
        exports: Number.parseInt(rowMatch[5], 10),
        filepath: rowMatch[6],
        description: rowMatch[7].trim(),
        category: categoryName,
      });
      rowMatch = rowRegex.exec(tableContent);
    }

    categoryMatch = categoryRegex.exec(content);
  }

  return { lastUpdated, entries, categories };
}

// ============================================================================
// Inventory Tool Handlers
// ============================================================================

/**
 * Handle get_code_metrics tool request.
 *
 * Retrieves aggregate metrics from the code inventory, optionally filtered
 * by category. Returns total files, lines, functions, exports, and breakdown
 * by category.
 *
 * @param args.category - Optional category filter
 *
 * @returns MCP-formatted response with metrics summary
 *
 * @example
 * const result = await handleGetCodeMetrics({ category: 'Shared' });
 * // Returns metrics for Shared category only
 */
export async function handleGetCodeMetrics(args?: { category?: string }) {
  try {
    // Security: Validate category if provided
    if (args?.category !== undefined) {
      const catValidation = validateString(args.category, 'category', { maxLength: 100 });
      if (!catValidation.valid) {
        return createSecurityErrorResponse(catValidation.error);
      }
    }

    const { lastUpdated, entries } = parseInventory();

    // Filter by category if provided
    const categoryFilter = args?.category?.toLowerCase();
    const filteredEntries = categoryFilter
      ? entries.filter((e) => e.category.toLowerCase() === categoryFilter)
      : entries;

    // Calculate aggregate metrics
    const totalFiles = filteredEntries.length;
    const totalLines = filteredEntries.reduce((sum, e) => sum + (e.lines ?? 0), 0);
    const totalFunctions = filteredEntries.reduce((sum, e) => sum + e.functions, 0);
    const totalExports = filteredEntries.reduce((sum, e) => sum + e.exports, 0);

    // Calculate breakdown by category
    const byCategory: Record<
      string,
      { files: number; lines: number; functions: number; exports: number }
    > = {};

    for (const entry of filteredEntries) {
      if (!byCategory[entry.category]) {
        byCategory[entry.category] = { files: 0, lines: 0, functions: 0, exports: 0 };
      }
      byCategory[entry.category].files++;
      byCategory[entry.category].lines += entry.lines ?? 0;
      byCategory[entry.category].functions += entry.functions;
      byCategory[entry.category].exports += entry.exports;
    }

    const _metrics = {
      totalFiles,
      totalLines,
      totalFunctions,
      totalExports,
      byCategory,
      lastUpdated,
    };

    // Format output
    const categoryBreakdown = Object.entries(byCategory)
      .map(
        ([cat, data]) =>
          `### ${cat}\n- Files: ${data.files}\n- Lines: ${data.lines.toLocaleString()}\n- Functions: ${data.functions}\n- Exports: ${data.exports}`
      )
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Code Inventory Metrics

**Last Updated:** ${lastUpdated}

## Summary
- **Total Files:** ${totalFiles.toLocaleString()}
- **Total Lines:** ${totalLines.toLocaleString()}
- **Total Functions:** ${totalFunctions.toLocaleString()}
- **Total Exports:** ${totalExports.toLocaleString()}

## By Category
${categoryBreakdown}`,
        },
      ],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp' }, 'Failed to get code metrics');
    return {
      content: [{ type: 'text', text: `Failed to get code metrics: ${msg}` }],
      isError: true,
    };
  }
}

/**
 * Handle search_inventory tool request.
 *
 * Searches the code inventory for files matching a filepath pattern.
 * Supports partial matches and optional category filtering.
 *
 * @param args.pattern - Search pattern for filepath matching
 * @param args.category - Optional category filter
 * @param args.limit - Maximum results (default: 20)
 *
 * @returns MCP-formatted response with matching files
 *
 * @example
 * const result = await handleSearchInventory({
 *   pattern: 'lib/search',
 *   category: 'Shared',
 *   limit: 10
 * });
 */
export async function handleSearchInventory(args: {
  pattern: string;
  category?: string;
  limit?: number;
}) {
  // Security: Validate pattern
  const patternValidation = validateString(args.pattern, 'pattern', { maxLength: 500 });
  if (!patternValidation.valid) {
    return createSecurityErrorResponse(patternValidation.error);
  }

  // Security: Validate category if provided
  if (args.category !== undefined) {
    const catValidation = validateString(args.category, 'category', { maxLength: 100 });
    if (!catValidation.valid) {
      return createSecurityErrorResponse(catValidation.error);
    }
  }

  // Security: Validate limit
  const limitValidation = validateNumber(args.limit, 'limit', {
    min: 1,
    max: 100,
    defaultValue: 20,
  });
  if (!limitValidation.valid) {
    return createSecurityErrorResponse(limitValidation.error);
  }

  try {
    const { lastUpdated, entries } = parseInventory();
    const { pattern, category, limit = 20 } = args;

    // Filter entries
    const matchingEntries = entries.filter((entry) => {
      const matchesPattern = entry.filepath.toLowerCase().includes(pattern.toLowerCase());
      const matchesCategory = !category || entry.category.toLowerCase() === category.toLowerCase();
      return matchesPattern && matchesCategory;
    });

    // Sort by relevance (exact match first, then by lines)
    matchingEntries.sort((a, b) => {
      const aExact = a.filepath.toLowerCase() === pattern.toLowerCase() ? 0 : 1;
      const bExact = b.filepath.toLowerCase() === pattern.toLowerCase() ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return (b.lines ?? 0) - (a.lines ?? 0);
    });

    // Apply limit
    const limitedEntries = matchingEntries.slice(0, Math.min(limit, 100));

    if (limitedEntries.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No files found matching pattern: "${pattern}"${category ? ` in category: ${category}` : ''}`,
          },
        ],
      };
    }

    // Format output
    const formatted = limitedEntries
      .map(
        (entry) => `### ${entry.filepath}
**Category:** ${entry.category}
**Status:** ${entry.status ? 'Reviewed' : 'Not Reviewed'}
**Lines:** ${entry.lines ?? '-'} | **Functions:** ${entry.functions} | **Exports:** ${entry.exports}
${entry.description ? `**Description:** ${entry.description}` : ''}`
      )
      .join('\n\n---\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Search Results for "${pattern}"

Found ${matchingEntries.length} files${args.limit && matchingEntries.length > limit ? ` (showing first ${limit})` : ''}.

**Last Updated:** ${lastUpdated}

---

${formatted}`,
        },
      ],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp' }, 'Failed to search inventory');
    return {
      content: [{ type: 'text', text: `Failed to search inventory: ${msg}` }],
      isError: true,
    };
  }
}

/**
 * Handle get_dead_code_report tool request.
 *
 * Lists files flagged as potential orphans or dead code based on:
 * - Zero exports (potential dead code)
 * - Unreviewed status (if includeUnreviewed=true)
 * - Minimum line threshold for filtering
 *
 * @param args.category - Optional category filter
 * @param args.includeUnreviewed - Include unreviewed files (default: true)
 * @param args.minLines - Minimum lines threshold (default: 0)
 *
 * @returns MCP-formatted response with dead code report
 *
 * @example
 * const result = await handleGetDeadCodeReport({
 *   includeUnreviewed: false,
 *   minLines: 100
 * });
 */
export async function handleGetDeadCodeReport(args?: {
  category?: string;
  includeUnreviewed?: boolean;
  minLines?: number;
}) {
  // Security: Validate category if provided
  if (args?.category !== undefined) {
    const catValidation = validateString(args.category, 'category', { maxLength: 100 });
    if (!catValidation.valid) {
      return createSecurityErrorResponse(catValidation.error);
    }
  }

  // Security: Validate includeUnreviewed
  const includeUnreviewedValidation = validateBoolean(
    args?.includeUnreviewed,
    'includeUnreviewed',
    true
  );
  if (!includeUnreviewedValidation.valid) {
    return createSecurityErrorResponse(includeUnreviewedValidation.error);
  }

  // Security: Validate minLines
  const minLinesValidation = validateNumber(args?.minLines, 'minLines', {
    min: 0,
    max: 100000,
    defaultValue: 0,
  });
  if (!minLinesValidation.valid) {
    return createSecurityErrorResponse(minLinesValidation.error);
  }

  try {
    const { lastUpdated, entries } = parseInventory();
    const { category, includeUnreviewed = true, minLines = 0 } = args ?? {};

    // Find potential dead code
    const deadCodeEntries: Array<{
      filepath: string;
      category: string;
      reason: string;
      lines: number | null;
      exports: number;
      reviewed: boolean;
    }> = [];

    for (const entry of entries) {
      // Apply category filter
      if (category && entry.category.toLowerCase() !== category.toLowerCase()) {
        continue;
      }

      // Apply min lines filter
      if ((entry.lines ?? 0) < minLines) {
        continue;
      }

      const reasons: string[] = [];

      // Check for zero exports (excluding test files)
      if (
        entry.exports === 0 &&
        !entry.filepath.includes('.test.') &&
        !entry.filepath.includes('/tests/')
      ) {
        reasons.push('Zero exports - potential dead code');
      }

      // Check for unreviewed status
      if (!entry.status && includeUnreviewed) {
        reasons.push('Not yet reviewed');
      }

      // Check for test files without corresponding source (simplified check)
      if (entry.filepath.includes('.test.') && entry.functions === 0) {
        reasons.push('Test file with no functions - may be empty or incomplete');
      }

      if (reasons.length > 0) {
        deadCodeEntries.push({
          filepath: entry.filepath,
          category: entry.category,
          reason: reasons.join('; '),
          lines: entry.lines,
          exports: entry.exports,
          reviewed: entry.status,
        });
      }
    }

    // Sort by lines (largest first)
    deadCodeEntries.sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0));

    if (deadCodeEntries.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No potential dead code found${category ? ` in category: ${category}` : ''}.

**Filters applied:**
- Min lines: ${minLines}
- Include unreviewed: ${includeUnreviewed}`,
          },
        ],
      };
    }

    // Format output
    const formatted = deadCodeEntries
      .map(
        (entry) => `### ${entry.filepath}
**Category:** ${entry.category}
**Reason:** ${entry.reason}
**Lines:** ${entry.lines ?? '-'} | **Exports:** ${entry.exports} | **Reviewed:** ${entry.reviewed ? 'Yes' : 'No'}`
      )
      .join('\n\n---\n\n');

    // Group by reason for summary
    const byReason: Record<string, number> = {};
    for (const entry of deadCodeEntries) {
      const primaryReason = entry.reason.split(';')[0].trim();
      byReason[primaryReason] = (byReason[primaryReason] ?? 0) + 1;
    }

    const summary = Object.entries(byReason)
      .map(([reason, count]) => `- **${reason}:** ${count} files`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Dead Code Report

**Last Updated:** ${lastUpdated}

## Summary
Found **${deadCodeEntries.length}** files flagged for review.

### By Reason
${summary}

### Filters Applied
- Min lines: ${minLines}
- Include unreviewed: ${includeUnreviewed}

---

## Flagged Files

${formatted}`,
        },
      ],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp' }, 'Failed to generate dead code report');
    return {
      content: [{ type: 'text', text: `Failed to generate dead code report: ${msg}` }],
      isError: true,
    };
  }
}
