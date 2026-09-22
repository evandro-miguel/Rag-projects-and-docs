/**
 * @module project-handlers
 * @description MCP tool handler implementations for Project RAG operations.
 *
 * This module implements the business logic for Project RAG MCP tools exposed by
 * the RAG server. Each handler function processes tool arguments, interacts with
 * the Postgres Project RAG backend, and returns formatted responses.
 *
 * Available Handlers:
 * - `handleSearchProjectCode`: Search project code with file/line references
 * - `handleGetProjectFile`: Retrieve file metadata and chunks
 * - `handleGetProjectOutline`: Get symbol/file outline
 * - `handleRegisterProject`: Register a new project
 * - `handleVerifyProjectIndex`: Verify project index health and coverage
 *
 * Handlers use the Project RAG Postgres store and return MCP-formatted
 * responses with text content.
 *
 * @example
 * // Handler response format
 * {
 *   content: [{ type: 'text', text: 'Response message...' }],
 *   isError: false, // true for errors
 * }
 *
 * @see project-tools.ts - For tool schema definitions
 * @see server.ts - For tool registration and routing
 */
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path/posix';
import { logger } from '../lib/logger.js';
import { validateProjectIncludeRoots } from '../lib/shared/project-include-roots.js';
import { evaluateProjectInvariants } from '../lib/shared/project-invariants.js';
import {
  PROJECT_SCOPE_ACK_TOKEN,
  requireProjectScopeAck,
} from '../lib/shared/project-scope-advisory.js';
import type { ProjectSearchPipelineDiagnostics } from '../lib/shared/project-search-types.js';
import {
  createProjectRagApplicationService,
  isProjectApplicationError,
  type ProjectRagApplicationRuntime,
  setProjectRagApplicationRuntimeForTesting,
} from '../scripts/project-rag/application-service.js';
import { deriveProjectRagBuildOverlay } from '../scripts/project-rag/build-overlay.js';
import { resolveProjectRagWorkspaceContext } from '../scripts/project-rag/context.js';
import { prepareProject } from '../scripts/project-rag/prepare.js';
import { validateProjectRootPath } from './lib/path-validator.js';
import { formatFreshnessStatus, type ProjectFileFreshness } from './lib/project-freshness.js';
import { readPositiveIntegerEnv } from './lib/timeout.js';

function normalizeProjectPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\.\//, '');
}

function slugifyProjectName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

interface ProjectSearchResult {
  sourcePath: string;
  score: number;
  startLine?: number;
  endLine?: number;
  content?: string;
  symbolName?: string;
  symbolKind?: string;
}

type ProjectSearchMode = 'vector' | 'hybrid';
type ProjectSearchRequestMode = ProjectSearchMode | 'keyword';
const PROJECT_RAG_EMBEDDING_DIMENSIONS = 1024;
// The store API requires a query vector even when the vector lane is
// intentionally disabled; this inert placeholder is never compared against a
// stored row because the fallback identity below matches nothing.
const PROJECT_RAG_LEXICAL_FALLBACK_EMBEDDING = Object.freeze(
  Array.from({ length: PROJECT_RAG_EMBEDDING_DIMENSIONS }, () => 0)
);
// Lexical fallback identity: deliberately NOT a real embedding profile.
// Every identity predicate fails closed against any stored row (no row may
// carry the sentinel provider/model/hash, and no row can carry dimensions
// -1), so the vector candidate lane is provably empty and retrieval degrades
// to lexical-only scoring without ever matching or impersonating a real
// profile.
const PROJECT_RAG_LEXICAL_FALLBACK_IDENTITY = Object.freeze({
  embeddingModel: '__mcp_lexical_fallback__',
  embeddingProvider: '__mcp_lexical_fallback__',
  embeddingDimensions: -1,
  embeddingProfileHash: '__mcp_lexical_fallback_profile__',
} as const);
const MCP_PROJECT_SEARCH_TOTAL_CHARS_LIMIT = readPositiveIntegerEnv(
  'MCP_PROJECT_SEARCH_TOTAL_CHARS_LIMIT',
  64_000
);
const MCP_PROJECT_FILE_TOTAL_CHARS_LIMIT = readPositiveIntegerEnv(
  'MCP_PROJECT_FILE_TOTAL_CHARS_LIMIT',
  120_000
);
const MCP_PROJECT_CONTENT_PER_ENTRY_CHARS_LIMIT = readPositiveIntegerEnv(
  'MCP_PROJECT_CONTENT_PER_ENTRY_CHARS_LIMIT',
  8_000
);

type ProjectRagPostgresStore = typeof import('../scripts/project-rag/store.js');
type ProjectRagPostgresConfigModule = typeof import('../scripts/project-rag/config.js');
type ProjectRagPostgresEmbeddingsModule = typeof import('../scripts/project-rag/embeddings.js');
type ProjectRagPostgresStoreRuntime = Pick<
  ProjectRagPostgresStore,
  | 'createProjectRagPostgresSql'
  | 'findProjectRagPostgresProject'
  | 'getProjectRagPostgresProjectStats'
  | 'getProjectRagPostgresPublishedBuildState'
  | 'searchProjectRagPostgresChunks'
  | 'getProjectRagPostgresFileWithChunks'
  | 'getProjectRagPostgresFileOutline'
  | 'findProjectRagPostgresSymbols'
  | 'getProjectRagPostgresNavigationPaths'
  | 'getProjectRagPostgresSemanticClusters'
  | 'getProjectRagPostgresFeatureHubs'
  | 'getProjectRagPostgresTopicGroups'
  | 'upsertProjectRagPostgresRepository'
  | 'upsertProjectRagWorkspaceContext'
  | 'upsertProjectRagWorkspaceAlias'
> &
  Partial<
    Pick<
      ProjectRagPostgresStore,
      'getProjectRagPostgresInvariantReport' | 'getProjectRagPostgresServingState'
    >
  >;
type ProjectRagPostgresSql = ReturnType<
  ProjectRagPostgresStoreRuntime['createProjectRagPostgresSql']
>;
type ProjectRagPostgresResolvedConfig = ReturnType<
  ProjectRagPostgresConfigModule['resolveProjectRagPostgresConfigWithLocalDefault']
>;
type ProjectRagPostgresRuntimeModules = {
  readonly config: Pick<
    ProjectRagPostgresConfigModule,
    'resolveProjectRagPostgresConfigWithLocalDefault' | 'resolveProjectRagPostgresWriteConfig'
  >;
  readonly embeddings: Pick<
    ProjectRagPostgresEmbeddingsModule,
    'resolveProjectRagPostgresEmbeddingConfig' | 'fetchProjectRagPostgresEmbeddings'
  >;
  readonly store: ProjectRagPostgresStoreRuntime;
};

let projectRagPostgresRuntimeModulesForTesting: ProjectRagPostgresRuntimeModules | undefined;

export function setProjectRagPostgresRuntimeModulesForTesting(
  modules: ProjectRagPostgresRuntimeModules | null
): void {
  projectRagPostgresRuntimeModulesForTesting = modules ?? undefined;
  setProjectRagApplicationRuntimeForTesting(
    modules as unknown as ProjectRagApplicationRuntime | null
  );
}

const projectApplicationService = createProjectRagApplicationService({ closePool: false });

async function getProjectRagPostgresRuntimeModules(): Promise<ProjectRagPostgresRuntimeModules> {
  return (
    projectRagPostgresRuntimeModulesForTesting ??
    ({
      config: await import('../scripts/project-rag/config.js'),
      embeddings: await import('../scripts/project-rag/embeddings.js'),
      store: await import('../scripts/project-rag/store.js'),
    } satisfies ProjectRagPostgresRuntimeModules)
  );
}

async function withProjectRagPostgresConfig<T>(
  resolveConfig: (
    config: ProjectRagPostgresRuntimeModules['config']
  ) => ReturnType<
    ProjectRagPostgresConfigModule['resolveProjectRagPostgresConfigWithLocalDefault']
  >,
  operation: (
    store: ProjectRagPostgresStoreRuntime,
    sql: ProjectRagPostgresSql,
    embeddings: ProjectRagPostgresRuntimeModules['embeddings'],
    config: ProjectRagPostgresResolvedConfig
  ) => Promise<T>
): Promise<T> {
  const modules = await getProjectRagPostgresRuntimeModules();
  const config = resolveConfig(modules.config);
  const sql = modules.store.createProjectRagPostgresSql(config);
  // Pool is shared across requests – do NOT close it here.
  // Call closeProjectRagPostgresSql() from store.ts explicitly for
  // tests or shutdown.
  return await operation(modules.store, sql, modules.embeddings, config);
}

async function withProjectRagPostgres<T>(
  operation: (
    store: ProjectRagPostgresStoreRuntime,
    sql: ProjectRagPostgresSql,
    embeddings: ProjectRagPostgresRuntimeModules['embeddings'],
    config: ProjectRagPostgresResolvedConfig
  ) => Promise<T>
): Promise<T> {
  return withProjectRagPostgresConfig(
    (config) => config.resolveProjectRagPostgresConfigWithLocalDefault(),
    operation
  );
}

async function withProjectRagPostgresWrite<T>(
  operation: (
    store: ProjectRagPostgresStoreRuntime,
    sql: ProjectRagPostgresSql,
    embeddings: ProjectRagPostgresRuntimeModules['embeddings'],
    config: ProjectRagPostgresResolvedConfig
  ) => Promise<T>
): Promise<T> {
  return withProjectRagPostgresConfig(
    (config) => config.resolveProjectRagPostgresWriteConfig(),
    operation
  );
}

type ProjectRagServingSnapshot = {
  readonly status: 'serving' | 'unavailable';
  readonly buildId: number | null;
  readonly dirtyDigest: string | null;
  readonly provenance: { readonly identityDigest: string | null };
  readonly reason?: string;
};

async function resolveProjectRagServingSnapshot(
  store: ProjectRagPostgresStoreRuntime,
  sql: ProjectRagPostgresSql,
  projectId: number
): Promise<ProjectRagServingSnapshot> {
  if (store.getProjectRagPostgresServingState) {
    return store.getProjectRagPostgresServingState(sql, projectId);
  }

  // Keep compatibility with test/legacy runtimes that expose only the older
  // published-build read while still binding every read to that build.
  const published = await store.getProjectRagPostgresPublishedBuildState(sql, projectId);
  return {
    status: 'serving',
    buildId: published.buildId,
    dirtyDigest: published.dirtyDigest,
    provenance: { identityDigest: null },
  };
}

function createPostgresProjectFileFreshness(fileModifiedAt?: number): ProjectFileFreshness {
  return {
    status: 'unverified',
    checkedAt: new Date().toISOString(),
    reason: 'PROJECT_RAG_BACKEND=postgres uses persisted metadata only',
    indexedFileModifiedAt: fileModifiedAt,
  };
}

interface ProjectPayloadTruncation {
  truncated: boolean;
  maxChars: number;
  originalEntries: number;
  returnedEntries: number;
  originalChars: number;
  returnedChars: number;
  droppedEntries: number;
}

type VerifyProjectIndexFailureCode =
  | 'VERIFY_PROJECT_INDEX_TIMEOUT'
  | 'VERIFY_PROJECT_INDEX_NOT_FOUND'
  | 'VERIFY_PROJECT_INDEX_INTERNAL_ERROR';

function classifyVerifyProjectIndexFailure(error: unknown): VerifyProjectIndexFailureCode {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'VERIFY_PROJECT_INDEX_TIMEOUT';
  }
  if (message.includes('not found')) {
    return 'VERIFY_PROJECT_INDEX_NOT_FOUND';
  }
  return 'VERIFY_PROJECT_INDEX_INTERNAL_ERROR';
}

function clampTextByChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 0) {
    return '';
  }
  return text.slice(0, maxChars);
}

function capResultContent<T extends { content?: string }>(params: {
  items: T[];
  maxChars: number;
  perEntryMaxChars: number;
}): {
  items: T[];
  truncation: ProjectPayloadTruncation;
} {
  let remaining = params.maxChars;
  let originalChars = 0;
  let returnedChars = 0;
  const cappedItems: T[] = [];

  for (const item of params.items) {
    const content = item.content ?? '';
    originalChars += content.length;

    if (remaining <= 0) {
      continue;
    }

    const maxForEntry = Math.min(params.perEntryMaxChars, remaining);
    const cappedContent = clampTextByChars(content, maxForEntry);
    returnedChars += cappedContent.length;
    remaining -= cappedContent.length;
    cappedItems.push({
      ...item,
      ...(item.content === undefined ? {} : { content: cappedContent }),
    });
  }

  return {
    items: cappedItems,
    truncation: {
      truncated:
        cappedItems.length !== params.items.length ||
        returnedChars < originalChars ||
        params.items.some(
          (item, index) => (item.content ?? '').length > (cappedItems[index]?.content ?? '').length
        ),
      maxChars: params.maxChars,
      originalEntries: params.items.length,
      returnedEntries: cappedItems.length,
      originalChars,
      returnedChars,
      droppedEntries: Math.max(params.items.length - cappedItems.length, 0),
    },
  };
}

function applyActiveFileBias<T extends ProjectSearchResult>(
  results: T[],
  activeFile?: string
): T[] {
  if (!activeFile) {
    return results;
  }

  const normalizedActiveFile = normalizeProjectPath(activeFile);
  const activeDir = dirname(normalizedActiveFile);

  return [...results]
    .map((result) => {
      const sourcePath = normalizeProjectPath(result.sourcePath);
      let bias = 0;

      if (sourcePath === normalizedActiveFile) {
        bias = 0.2;
      } else if (dirname(sourcePath) === activeDir) {
        bias = 0.1;
      } else if (activeDir !== '.' && sourcePath.startsWith(`${activeDir}/`)) {
        bias = 0.05;
      }

      return {
        ...result,
        score: result.score + bias,
      };
    })
    .sort((left, right) => right.score - left.score);
}

// ============================================================================
// Project Code Search Handler
// ============================================================================

/**
 * Search project code using the canonical Postgres Project RAG path.
 *
 * Results include exact file paths and line references. The Postgres backend
 * currently serves all requests via hybrid vector + lexical search and reports
 * that canonical mode in structured output.
 *
 * T-10: Supports deterministic mode for reproducible, symbol-graph-based results.
 *
 * @param args.projectId - Project registry ID (required)
 * @param args.query - Search query string
 * @param args.limit - Maximum results to return (default: 10)
 * @param args.activeFile - Optional active file context for relevance boosting
 * @param args.mode - Search mode: 'vector' or 'hybrid' (default: 'hybrid')
 * @param args.deterministic - Legacy deterministic intent flag; current Postgres execution reports it as unavailable (default: false)
 *
 * @returns MCP-formatted response with search results including file path and line references
 *
 * @example
 * const result = await handleSearchProjectCode({
 *   projectId: 'project123',
 *   query: 'authentication middleware',
 *   limit: 5,
 *   mode: 'hybrid'
 * });
 */
export async function handleSearchProjectCode(
  args: {
    projectId: string;
    query: string;
    limit?: number;
    activeFile?: string;
    mode?: ProjectSearchRequestMode;
    deterministic?: boolean;
    includeDiagnostics?: boolean;
  },
  signal?: AbortSignal
) {
  const {
    projectId,
    query,
    limit = 10,
    mode = 'hybrid',
    activeFile,
    deterministic,
    includeDiagnostics = false,
  } = args;
  const _validLimit = Math.min(Math.max(limit, 1), 50);

  const requestedMode = mode ?? 'hybrid';
  const isKeyword = requestedMode === 'keyword';
  if (requestedMode !== 'vector' && requestedMode !== 'hybrid' && !isKeyword) {
    const message = `Unsupported Project RAG search mode: ${String(requestedMode)}. Use keyword, vector, or hybrid.`;
    return {
      content: [{ type: 'text', text: message }],
      structuredContent: {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }

  try {
    return await withProjectRagPostgres(async (store, sql, embeddings) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const serving = await resolveProjectRagServingSnapshot(store, sql, project.id);
      if (serving.status !== 'serving' || serving.buildId === null) {
        const message = serving.reason ?? `Project RAG is unavailable for project ${project.id}`;
        return {
          content: [{ type: 'text', text: message }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_READY',
              message,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }
      const servingBuildId = serving.buildId;
      const publishedBuild = {
        buildId: servingBuildId,
        dirtyDigest: serving.dirtyDigest,
      };
      const currentContext = await resolveProjectRagWorkspaceContext(project.rootPath, undefined, {
        includeRoots: project.includeRoots,
        ignoreRules: project.ignoreRules,
      });
      const buildOverlay = deriveProjectRagBuildOverlay({
        publishedDirtyDigest: publishedBuild.dirtyDigest,
        currentDirtyDigest: currentContext.dirtyDigest,
        publishedIdentityDigest: serving.provenance.identityDigest,
        currentIdentityDigest: currentContext.identityDigest,
      });
      const contextInvalid = buildOverlay.status === 'invalid';

      if (contextInvalid) {
        const message = `Project RAG provenance is ${buildOverlay.contextStatus}; prepare the selected project before reading indexed data`;
        const errorOutput = {
          success: false,
          error: {
            code:
              buildOverlay.contextStatus === 'unverified'
                ? 'PROJECT_INDEX_UNVERIFIED'
                : 'PROJECT_INDEX_STALE',
            message,
            action: 'prepare_project',
            project: project.slug,
            projectId: project.id,
            buildId: serving.buildId,
            contextStatus: buildOverlay.contextStatus,
            publishedIdentityDigest: serving.provenance.identityDigest,
            currentIdentityDigest: currentContext.identityDigest,
            dirtyPaths: buildOverlay.dirtyPaths,
            timestamp: new Date().toISOString(),
          },
        };
        return {
          content: [{ type: 'text', text: message }],
          structuredContent: errorOutput,
          isError: true,
        };
      }

      let embeddingConfig:
        | ReturnType<ProjectRagPostgresEmbeddingsModule['resolveProjectRagPostgresEmbeddingConfig']>
        | undefined;
      let embeddingFailure: 'unavailable' | 'invalid_response' | undefined;
      try {
        embeddingConfig = embeddings.resolveProjectRagPostgresEmbeddingConfig();
      } catch {
        embeddingFailure = 'unavailable';
      }

      let queryEmbedding: readonly number[] | undefined;
      if (embeddingConfig && !contextInvalid) {
        try {
          const [candidateEmbedding] = await embeddings.fetchProjectRagPostgresEmbeddings(
            embeddingConfig,
            [
              `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${query}`,
            ],
            signal
          );
          if (
            candidateEmbedding &&
            candidateEmbedding.length === PROJECT_RAG_EMBEDDING_DIMENSIONS &&
            embeddingConfig.dimensions === PROJECT_RAG_EMBEDDING_DIMENSIONS &&
            candidateEmbedding.every((value) => Number.isFinite(value))
          ) {
            queryEmbedding = candidateEmbedding;
          } else {
            embeddingFailure = 'invalid_response';
          }
        } catch {
          embeddingFailure = 'unavailable';
        }
      }

      const embeddingEvidence =
        embeddingConfig && queryEmbedding
          ? {
              provider: embeddingConfig.provider,
              model: embeddingConfig.model,
              baseUrl: embeddingConfig.baseUrl,
              dimensions: embeddingConfig.dimensions,
              profileHash: embeddingConfig.profileHash,
            }
          : undefined;
      let primarySearchAttempted = false;
      let fallbackUsed = false;
      let fallbackReason: 'embedding_unavailable' | 'hybrid_empty' | 'context_invalid' | undefined;
      let rawResults: ProjectSearchResult[];

      interface SearchIdentity {
        readonly embeddingModel: string;
        readonly embeddingProvider: string;
        readonly embeddingDimensions: number;
        readonly embeddingProfileHash: string;
      }

      const executeSearch = async (embedding: readonly number[], identity: SearchIdentity) =>
        (await store.searchProjectRagPostgresChunks(sql, project.id, {
          query,
          queryEmbedding: embedding,
          ...identity,
          buildId: servingBuildId,
          limit: _validLimit,
        })) ?? [];

      const liveIdentity: SearchIdentity | undefined = embeddingConfig
        ? {
            embeddingModel: embeddingConfig.model,
            embeddingProvider: embeddingConfig.provider,
            embeddingDimensions: embeddingConfig.dimensions,
            embeddingProfileHash: embeddingConfig.profileHash,
          }
        : undefined;

      if (queryEmbedding && liveIdentity) {
        primarySearchAttempted = true;
        rawResults = await executeSearch(queryEmbedding, liveIdentity);
      } else {
        // Vector lane deliberately disabled: without a fetched real embedding
        // we never search under a real profile identity; the sentinel identity
        // matches no stored row, so scoring degrades to lexical-only.
        fallbackReason = contextInvalid ? 'context_invalid' : 'embedding_unavailable';
        fallbackUsed = true;
        rawResults = await executeSearch(
          PROJECT_RAG_LEXICAL_FALLBACK_EMBEDDING,
          PROJECT_RAG_LEXICAL_FALLBACK_IDENTITY
        );
      }

      if (rawResults.length === 0 && !fallbackUsed) {
        fallbackReason = 'hybrid_empty';
        fallbackUsed = true;
        rawResults = await executeSearch(
          PROJECT_RAG_LEXICAL_FALLBACK_EMBEDDING,
          PROJECT_RAG_LEXICAL_FALLBACK_IDENTITY
        );
      }

      const actualMode: ProjectSearchMode = 'hybrid';
      const modeWarnings: string[] = [];
      if (isKeyword) {
        modeWarnings.push(
          'Keyword search mode is deprecated and has been mapped to hybrid vector+lexical search.'
        );
      } else if (requestedMode !== 'hybrid') {
        modeWarnings.push(
          `PROJECT_RAG_BACKEND=postgres uses hybrid vector+lexical search for ${requestedMode} requests.`
        );
      }
      const warnings = [...modeWarnings];
      if (contextInvalid) {
        warnings.push(
          `Published build ${publishedBuild.buildId} differs from the current worktree; semantic freshness is invalid and lexical truth results were used.`
        );
      }
      if (deterministic) {
        warnings.push('Deterministic graph search is not available in the Postgres backend yet.');
      }
      if (fallbackUsed) {
        warnings.push(
          embeddingFailure || fallbackReason === 'embedding_unavailable'
            ? 'Embedding retrieval was unavailable; used the embedding-independent lexical fallback.'
            : 'Hybrid retrieval returned no results; used the embedding-independent lexical fallback.'
        );
      }
      const rankedResults = applyActiveFileBias(rawResults, activeFile);
      const cappedResults = capResultContent({
        items: rankedResults.map((result) => ({
          ...result,
          content: result.content ?? '',
        })),
        maxChars: MCP_PROJECT_SEARCH_TOTAL_CHARS_LIMIT,
        perEntryMaxChars: MCP_PROJECT_CONTENT_PER_ENTRY_CHARS_LIMIT,
      });
      const results = cappedResults.items;
      if (cappedResults.truncation.truncated) {
        warnings.push(
          `Project search payload truncated to ${cappedResults.truncation.returnedChars}/${cappedResults.truncation.originalChars} chars across ${cappedResults.truncation.returnedEntries}/${cappedResults.truncation.originalEntries} results (cap=${cappedResults.truncation.maxChars}).`
        );
      }
      const diagnostics: ProjectSearchPipelineDiagnostics | undefined = includeDiagnostics
        ? {
            pipeline: 'postgres_project_rag',
            mode: actualMode,
            deterministic: false,
            fusion: fallbackUsed ? 'postgres_lexical_score' : 'postgres_vector_lexical_score',
            lanes: [
              primarySearchAttempted
                ? {
                    lane: 'postgres_hybrid_search',
                    status: 'executed' as const,
                    candidateCount: fallbackUsed ? 0 : results.length,
                    ...(fallbackUsed && fallbackReason ? { reason: fallbackReason } : {}),
                  }
                : {
                    lane: 'postgres_hybrid_search',
                    status: 'skipped' as const,
                    candidateCount: 0,
                    reason: fallbackReason ?? 'embedding_unavailable',
                  },
              ...(fallbackUsed
                ? [
                    {
                      lane: 'postgres_lexical_fallback',
                      status: 'executed' as const,
                      candidateCount: results.length,
                    },
                  ]
                : []),
            ],
            candidates: {
              text: results.length,
              vector: fallbackUsed ? 0 : results.length,
              merged: results.length,
              returned: results.length,
            },
            totalLatencyMs: 0,
          }
        : undefined;

      if (results.length === 0) {
        const emptyOutput = {
          success: true,
          data: {
            backend: 'postgres',
            results: [],
            query,
            mode: actualMode,
            requestedMode,
            fallbackUsed,
            ...(embeddingEvidence ? { embeddingConfig: embeddingEvidence } : {}),
            warnings,
            truncation: cappedResults.truncation,
            watcher: null,
            context: {
              publishedBuildId: publishedBuild.buildId,
              status: contextInvalid ? 'invalid' : 'published',
              semanticFreshness: contextInvalid ? 'degraded' : 'current',
            },
            ...(includeDiagnostics && diagnostics ? { diagnostics } : {}),
          },
        };
        return {
          content: [
            {
              type: 'text',
              text: `No results found for query "${query}" in project "${projectId}" (${actualMode} mode)`,
            },
          ],
          structuredContent: emptyOutput,
        };
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          results: results.map((result) => ({
            sourcePath: result.sourcePath,
            startLine: result.startLine,
            endLine: result.endLine,
            content: result.content,
            score: result.score,
            symbolName: result.symbolName,
            symbolKind: result.symbolKind,
          })),
          query,
          mode: actualMode,
          requestedMode,
          fallbackUsed,
          ...(embeddingEvidence ? { embeddingConfig: embeddingEvidence } : {}),
          warnings,
          truncation: cappedResults.truncation,
          watcher: null,
          context: {
            publishedBuildId: publishedBuild.buildId,
            status: contextInvalid ? 'invalid' : 'published',
            semanticFreshness: contextInvalid ? 'degraded' : 'current',
          },
          ...(includeDiagnostics && diagnostics ? { diagnostics } : {}),
        },
      };

      const formattedResults = results
        .map((result, index) => {
          return `
## ${index + 1}. ${result.sourcePath}
**Lines:** ${result.startLine ?? '?'}-${result.endLine ?? '?'}
**Score:** ${result.score.toFixed(3)}
${result.symbolName ? `**Symbol:** ${result.symbolName} (${result.symbolKind})` : ''}

\`\`\`
${result.content}
\`\`\`
      `.trim();
        })
        .join('\n\n---\n\n');
      const truncationNotice = cappedResults.truncation.truncated
        ? `\n\nNotice: output truncated (${cappedResults.truncation.returnedChars}/${cappedResults.truncation.originalChars} chars, ${cappedResults.truncation.returnedEntries}/${cappedResults.truncation.originalEntries} results retained).`
        : '';

      return {
        content: [
          {
            type: 'text',
            text: `Found ${results.length} results for: "${query}"${truncationNotice}\n\n${formattedResults}`,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp', projectId }, 'Failed to search project code');

    const errorOutput = {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: msg,
        timestamp: new Date().toISOString(),
      },
    };

    return {
      content: [{ type: 'text', text: `Failed to search project code: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}

// ============================================================================
// Get Project File Handler
// ============================================================================

/**
 * Retrieve file metadata and chunks for a project file.
 *
 * Fetches a project file by its source path and returns metadata plus
 * all associated chunks with line numbers.
 *
 * @param args.projectId - Project registry ID (required)
 * @param args.sourcePath - Relative source path to the file (e.g., "src/components/Button.tsx")
 *
 * @returns MCP-formatted response with file metadata and chunks
 *
 * @example
 * const result = await handleGetProjectFile({
 *   projectId: 'project123',
 *   sourcePath: 'src/components/Button.tsx'
 * });
 */
export async function handleGetProjectFile(args: { projectId: string; sourcePath: string }) {
  const { projectId, sourcePath } = args;

  try {
    const result = (await projectApplicationService.getProjectFile({
      project: projectId,
      file: sourcePath,
    })) as {
      readonly project: { readonly id: number };
      readonly serving?: unknown;
      readonly provenance?: unknown;
      readonly buildId?: number | null;
      readonly versionId?: number;
      readonly file: {
        readonly sourcePath: string;
        readonly status: string;
        readonly lang?: string;
        readonly sizeBytes: number;
        readonly updatedAt?: number;
      };
      readonly chunks: Array<{
        readonly chunkIndex: number;
        readonly content: string;
        readonly startLine?: number;
        readonly endLine?: number;
        readonly symbolName?: string;
        readonly symbolKind?: string;
      }>;
      readonly chunkCount: number;
    };
    const fileModifiedAt = result.file.updatedAt ?? 0;
    const freshness = createPostgresProjectFileFreshness(fileModifiedAt);
    const cappedChunks = capResultContent({
      items: result.chunks,
      maxChars: MCP_PROJECT_FILE_TOTAL_CHARS_LIMIT,
      perEntryMaxChars: MCP_PROJECT_CONTENT_PER_ENTRY_CHARS_LIMIT,
    });
    const structuredOutput = {
      success: true,
      data: {
        backend: 'postgres',
        project: result.project,
        serving: result.serving,
        provenance: result.provenance,
        buildId: result.buildId,
        versionId: result.versionId,
        file: {
          sourcePath: result.file.sourcePath,
          status: result.file.status,
          lang: result.file.lang,
          sizeBytes: result.file.sizeBytes,
          fileModifiedAt,
          freshness,
        },
        chunks: cappedChunks.items.map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbolName: chunk.symbolName,
          symbolKind: chunk.symbolKind,
        })),
        truncation: cappedChunks.truncation,
      },
    };

    const formattedChunks = cappedChunks.items
      .map(
        (chunk) =>
          `### Chunk ${chunk.chunkIndex}${chunk.startLine ? ` (Lines ${chunk.startLine}-${chunk.endLine})` : ''}
${chunk.symbolName ? `**Symbol:** ${chunk.symbolName} (${chunk.symbolKind})\n` : ''}${chunk.content}`
      )
      .join('\n\n');
    const truncationNotice = cappedChunks.truncation.truncated
      ? `\n**Output Truncated:** yes (${cappedChunks.truncation.returnedChars}/${cappedChunks.truncation.originalChars} chars, ${cappedChunks.truncation.returnedEntries}/${cappedChunks.truncation.originalEntries} chunks retained)`
      : '';

    return {
      content: [
        {
          type: 'text',
          text: `# ${sourcePath}
**Project ID:** ${projectId}
**Status:** ${result.file.status}
**Language:** ${result.file.lang || 'unknown'}
**Size:** ${result.file.sizeBytes.toLocaleString()} bytes
**Last Modified:** ${new Date(fileModifiedAt).toISOString()}
**Freshness:** ${formatFreshnessStatus(freshness.status)}${freshness.reason ? ` (${freshness.reason})` : ''}
**Chunks:** ${result.chunkCount}${truncationNotice}

---

${formattedChunks}`,
        },
      ],
      structuredContent: structuredOutput,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp', projectId, sourcePath }, 'Failed to get project file');

    if (isProjectApplicationError(error)) {
      const errorOutput = {
        success: false,
        error: { code: error.code, message: error.message, timestamp: new Date().toISOString() },
      };
      return {
        content: [{ type: 'text', text: error.message }],
        structuredContent: errorOutput,
        ...(error.code === 'NOT_FOUND' && error.message.startsWith('File not found')
          ? {}
          : { isError: true }),
      };
    }

    const errorOutput = {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: msg,
        timestamp: new Date().toISOString(),
      },
    };

    return {
      content: [{ type: 'text', text: `Failed to get project file: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}

// ============================================================================
// Get Project Outline Handler
// ============================================================================

/**
 * Get symbol/file outline for a project file.
 *
 * Retrieves the symbol outline of a file, including function names,
 * class names, and their line ranges.
 *
 * @param args.projectId - Project registry ID (required)
 * @param args.sourcePath - Relative source path to the file
 *
 * @returns MCP-formatted response with symbol outline
 *
 * @example
 * const result = await handleGetProjectOutline({
 *   projectId: 'project123',
 *   sourcePath: 'src/components/Button.tsx'
 * });
 */
export async function handleGetProjectOutline(args: { projectId: string; sourcePath: string }) {
  const { projectId, sourcePath } = args;

  try {
    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const serving = await resolveProjectRagServingSnapshot(store, sql, project.id);
      if (serving.status !== 'serving' || serving.buildId === null) {
        const message = serving.reason ?? `Project RAG is unavailable for project ${project.id}`;
        return {
          content: [{ type: 'text', text: message }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_READY',
              message,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const result = await store.getProjectRagPostgresFileOutline(sql, project.id, sourcePath, {
        buildId: serving.buildId,
      });
      if (!result) {
        const notFoundOutput = {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `File not found: ${sourcePath} in project ${projectId}`,
            timestamp: new Date().toISOString(),
          },
        };
        return {
          content: [
            { type: 'text', text: `File not found: ${sourcePath} in project ${projectId}` },
          ],
          structuredContent: notFoundOutput,
        };
      }

      if (result.symbols.length === 0) {
        const emptyOutput = {
          success: true,
          data: { backend: 'postgres', sourcePath, symbols: [] },
        };
        return {
          content: [
            { type: 'text', text: `# Outline: ${sourcePath}\n\nNo symbols found in this file.` },
          ],
          structuredContent: emptyOutput,
        };
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          sourcePath,
          symbols: result.symbols.map((symbol) => ({
            name: symbol.name,
            kind: symbol.symbolType,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            signature: symbol.signature,
          })),
        },
      };

      const formattedSymbols = result.symbols
        .map(
          (symbol) =>
            `- **${symbol.name}** (${symbol.symbolType})${symbol.startLine ? ` [L${symbol.startLine}${symbol.endLine && symbol.endLine !== symbol.startLine ? `-${symbol.endLine}` : ''}]` : ''}${symbol.signature ? `\n  \`${symbol.signature}\`` : ''}`
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Outline: ${sourcePath}\n\n## Symbols (${result.symbols.length})\n\n${formattedSymbols}`,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(
      { error, operation: 'mcp', projectId, sourcePath },
      'Failed to get project outline'
    );
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
    };
    return {
      content: [{ type: 'text', text: `Failed to get project outline: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}
export async function handleFindSymbolReferences(args: {
  projectId: string;
  symbolName: string;
  limit?: number;
  transitive?: boolean;
  transitiveDepth?: number;
}) {
  const { projectId, symbolName, limit = 20, transitive, transitiveDepth } = args;
  const validLimit = Math.min(Math.max(limit, 1), 50);

  try {
    if (transitive || transitiveDepth) {
      const unsupportedOutput = {
        success: false,
        error: {
          code: 'UNSUPPORTED',
          message:
            'PROJECT_RAG_BACKEND=postgres does not support transitive symbol references yet.',
          timestamp: new Date().toISOString(),
        },
      };
      return {
        content: [
          {
            type: 'text',
            text: 'PROJECT_RAG_BACKEND=postgres does not support transitive symbol references yet.',
          },
        ],
        structuredContent: unsupportedOutput,
        isError: true,
      };
    }

    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const result = await store.findProjectRagPostgresSymbols(sql, project.id, {
        name: symbolName,
        limit: validLimit,
      });

      if (result.definitions.length === 0) {
        const emptyOutput = {
          success: true,
          data: {
            backend: 'postgres',
            definitions: [],
            references: [],
            definitionCount: 0,
            referenceCount: 0,
          },
        };
        return {
          content: [
            {
              type: 'text',
              text: `No symbols found with name "${symbolName}" in project "${projectId}"`,
            },
          ],
          structuredContent: emptyOutput,
        };
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          definitions: result.definitions.map((symbol) => ({
            name: symbol.name,
            symbolType: symbol.symbolType,
            sourcePath: symbol.sourcePath,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            signature: symbol.signature,
          })),
          references: result.references.map((edge) => ({
            sourcePath: edge.sourcePath ?? 'unknown',
            relationType: edge.relationType,
            confidence: edge.confidence,
            sourceRef: edge.sourceRef,
          })),
          definitionCount: result.definitions.length,
          referenceCount: result.references.length,
        },
      };

      const formattedDefinitions = result.definitions
        .map((symbol, index) => {
          const lineInfo = symbol.startLine
            ? `L${symbol.startLine}${symbol.endLine && symbol.endLine !== symbol.startLine ? `-${symbol.endLine}` : ''}`
            : 'unknown location';
          return `## ${index + 1}. ${symbol.name}\n**Type:** ${symbol.symbolType}\n**File:** ${symbol.sourcePath}\n**Location:** ${lineInfo}\n${symbol.signature ? `**Signature:** \`${symbol.signature}\`` : ''}`;
        })
        .join('\n\n---\n\n');

      let formattedReferences = '';
      if (result.references.length > 0) {
        formattedReferences = result.references
          .map((edge, index) => {
            const refInfo = edge.sourceRef ? ` (ref: ${edge.sourceRef})` : '';
            const relationInfo = edge.relationType ? ` [${edge.relationType}]` : '';
            return `## ${index + 1}. Reference${relationInfo}\n**Source File:** ${edge.sourcePath ?? 'unknown'}${refInfo}\n**Confidence:** ${(edge.confidence ?? 0).toFixed(2)}`;
          })
          .join('\n\n---\n\n');
      }

      return {
        content: [
          {
            type: 'text',
            text: `# Symbol References: "${symbolName}"\n\n## Definitions (${result.definitions.length})\n\n${formattedDefinitions}\n\n---\n\n## References (${result.references.length})\n\n${result.references.length > 0 ? formattedReferences : 'No references found for this symbol.'}`,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(
      { error, operation: 'mcp', projectId, symbolName },
      'Failed to find symbol references'
    );
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
    };
    return {
      content: [{ type: 'text', text: `Failed to find symbol references: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}
export async function handleGetProjectSkeleton(args: { projectId: string; sourcePath: string }) {
  const { projectId, sourcePath } = args;

  try {
    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const result = await store.getProjectRagPostgresFileWithChunks(sql, project.id, sourcePath, {
        limit: 1,
      });
      if (!result) {
        const notFoundOutput = {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `File not found or no skeleton available: ${sourcePath} in project ${projectId}`,
            timestamp: new Date().toISOString(),
          },
        };
        return {
          content: [
            {
              type: 'text',
              text: `File not found or no skeleton available: ${sourcePath} in project ${projectId}`,
            },
          ],
          structuredContent: notFoundOutput,
        };
      }

      if (!result.file.skeletonText) {
        const noSkeletonOutput = {
          success: true,
          data: {
            backend: 'postgres',
            sourcePath,
            projectId,
            lang: result.file.lang,
            outlineVersion: result.file.outlineVersion,
            sizeBytes: result.file.sizeBytes,
            skeletonText: '',
            available: false,
          },
        };
        return {
          content: [
            {
              type: 'text',
              text: `# Skeleton: ${sourcePath}\n\nNo skeleton available for this file.`,
            },
          ],
          structuredContent: noSkeletonOutput,
        };
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          sourcePath,
          projectId,
          lang: result.file.lang,
          outlineVersion: result.file.outlineVersion,
          sizeBytes: result.file.sizeBytes,
          skeletonText: result.file.skeletonText,
          available: true,
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: `# Skeleton: ${sourcePath}\n**Project ID:** ${projectId}\n**Language:** ${result.file.lang || 'unknown'}\n**Outline Version:** ${result.file.outlineVersion || 'N/A'}\n**Size:** ${result.file.sizeBytes.toLocaleString()} bytes\n\n---\n\n\`\`\`\n${result.file.skeletonText}\n\`\`\``,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(
      { error, operation: 'mcp', projectId, sourcePath },
      'Failed to get project skeleton'
    );
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
    };
    return {
      content: [{ type: 'text', text: `Failed to get project skeleton: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}
export async function handleRegisterProject(args: {
  name: string;
  rootPath: string;
  includeRoots: string[];
  gitRemote?: string;
  defaultBranch?: string;
  scopeAck?: string;
  blockedFindingAllowlist?: Array<{ relativePath: string; category: string }>;
  replaceBlockedFindingAllowlist?: boolean;
}) {
  const {
    name,
    rootPath,
    includeRoots,
    gitRemote,
    defaultBranch,
    scopeAck,
    blockedFindingAllowlist,
    replaceBlockedFindingAllowlist,
  } = args;

  // Validate blocked-finding allowlist contract rules
  const allowlistExplicitlySupplied = blockedFindingAllowlist !== undefined;
  const replaceRequested = replaceBlockedFindingAllowlist === true;

  if (replaceRequested && !allowlistExplicitlySupplied) {
    const errorOutput = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message:
          'replaceBlockedFindingAllowlist=true requires blockedFindingAllowlist to be present. Pass [] to clear or omit both to preserve.',
        timestamp: new Date().toISOString(),
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
      structuredContent: errorOutput,
      isError: true,
    };
  }

  if (allowlistExplicitlySupplied && !replaceRequested) {
    const errorOutput = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message:
          'blockedFindingAllowlist provided without replaceBlockedFindingAllowlist=true. Pass replaceBlockedFindingAllowlist=true to replace, or omit both to preserve the current allowlist.',
        timestamp: new Date().toISOString(),
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
      structuredContent: errorOutput,
      isError: true,
    };
  }

  // Security: Validate rootPath before proceeding
  const pathValidation = validateProjectRootPath(rootPath);
  if (!pathValidation.valid) {
    logger.warn(
      { operation: 'mcp', name, rootPath, code: pathValidation.code },
      'Project registration rejected: invalid path'
    );

    const errorOutput = {
      success: false,
      error: {
        code: 'INVALID_PATH',
        message: pathValidation.error,
        timestamp: new Date().toISOString(),
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(errorOutput, null, 2),
        },
      ],
      structuredContent: errorOutput,
      isError: true,
    };
  }

  const scopeAckValidation = requireProjectScopeAck(scopeAck, {
    operation: 'register',
    rootPath,
    includeRoots,
    target: name,
  });
  if (!scopeAckValidation.valid) {
    logger.warn(
      {
        operation: 'mcp',
        name,
        rootPath,
        includeRoots,
        ackToken: PROJECT_SCOPE_ACK_TOKEN,
      },
      'Project registration rejected: scope confirmation missing'
    );

    const errorOutput = {
      success: false,
      error: {
        code: 'SCOPE_CONFIRMATION_REQUIRED',
        message: `${scopeAckValidation.error}\n\n${scopeAckValidation.advisory}`,
        timestamp: new Date().toISOString(),
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(errorOutput, null, 2),
        },
      ],
      structuredContent: errorOutput,
      isError: true,
    };
  }

  const includeRootsValidation = validateProjectIncludeRoots(rootPath, includeRoots);
  if (!includeRootsValidation.valid) {
    logger.warn(
      {
        operation: 'mcp',
        name,
        rootPath,
        includeRoots,
        code: includeRootsValidation.code,
      },
      'Project registration rejected: invalid include roots'
    );

    const suggestionText =
      includeRootsValidation.suggestions.length > 0
        ? ` Suggested folders: ${includeRootsValidation.suggestions.join(', ')}`
        : '';

    const errorOutput = {
      success: false,
      error: {
        code: 'INVALID_INCLUDE_ROOTS',
        message: `${includeRootsValidation.error}.${suggestionText}`,
        timestamp: new Date().toISOString(),
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(errorOutput, null, 2),
        },
      ],
      structuredContent: errorOutput,
      isError: true,
    };
  }

  let workspaceContext: Awaited<ReturnType<typeof resolveProjectRagWorkspaceContext>>;
  try {
    workspaceContext = await resolveProjectRagWorkspaceContext(pathValidation.resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorOutput = {
      success: false,
      error: {
        code: 'PROJECT_CONTEXT_UNRESOLVED',
        message: `Project registration requires a resolvable Git workspace: ${message}`,
        timestamp: new Date().toISOString(),
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
      structuredContent: errorOutput,
      isError: true,
    };
  }

  try {
    return await withProjectRagPostgresWrite(async (store, sql, _embeddings, config) => {
      // Migration-004 schema readiness MUST be checked before every upsert
      // because the upsert SQL always references blocked_finding_allowlist.
      const { assertProjectRagPostgresAllowlistSchemaReady } = await import(
        '../scripts/project-rag/store.js'
      );
      try {
        await assertProjectRagPostgresAllowlistSchemaReady(sql);
      } catch (schemaError) {
        const msg = schemaError instanceof Error ? schemaError.message : String(schemaError);
        logger.error({ operation: 'mcp', name, rootPath }, `Allowlist schema not ready: ${msg}`);
        const errorOutput = {
          success: false,
          error: {
            code: 'SCHEMA_NOT_READY',
            message: msg,
            timestamp: new Date().toISOString(),
          },
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
          structuredContent: errorOutput,
          isError: true,
        };
      }

      const normalizedRootPath = pathValidation.resolvedPath;
      const slug = slugifyProjectName(name);

      // Find existing project BEFORE allowlist validation so we know which
      // includeRoots will actually be persisted (preservation semantics).
      const existingProject = await store.findProjectRagPostgresProject(sql, slug);

      // Root identity enforcement — reject if existing project has a different root.
      // This prevents silently moving an existing registration to a new filesystem
      // location or changing the canonical root path.
      if (existingProject) {
        const existingRoot = existingProject.normalizedRootPath || existingProject.rootPath;
        if (existingRoot !== normalizedRootPath) {
          const errorOutput = {
            success: false,
            error: {
              code: 'PROJECT_ROOT_MISMATCH',
              message:
                `Project "${slug}" is already registered at "${existingRoot}". ` +
                `Requested root "${normalizedRootPath}" differs. ` +
                `Re-registering an existing project under a different root path is not allowed.`,
              timestamp: new Date().toISOString(),
            },
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
            structuredContent: errorOutput,
            isError: true,
          };
        }
      }

      // Preserve existing includeRoots/ignoreRules when project already exists.
      // This prevents accidental scope reduction on re-registration.
      const preserveExistingScope = !!existingProject;
      const registeredIncludeRoots =
        preserveExistingScope && existingProject?.includeRoots?.length
          ? existingProject.includeRoots
          : includeRootsValidation.includeRoots;
      const registeredIgnoreRules = preserveExistingScope
        ? existingProject?.ignoreRules
        : undefined;

      // When replacing the allowlist, validate against the includeRoots that
      // WILL be persisted (preserved roots for existing projects, request
      // roots for new projects).
      let resolvedAllowlistAction: 'preserved' | 'replaced' | 'cleared' = 'preserved';
      let effectiveAllowlistRelativePaths: string[] = [];

      if (replaceRequested && allowlistExplicitlySupplied) {
        resolvedAllowlistAction = blockedFindingAllowlist.length === 0 ? 'cleared' : 'replaced';
        effectiveAllowlistRelativePaths = blockedFindingAllowlist.map((e) => e.relativePath);

        const canonicalRoot = realpathSync.native(pathValidation.resolvedPath);
        const { validateAllowlistAgainstRoot } = await import(
          '../scripts/project-rag/project-inventory.js'
        );

        try {
          validateAllowlistAgainstRoot(
            canonicalRoot,
            registeredIncludeRoots,
            blockedFindingAllowlist
          );
        } catch (validationError) {
          const msg =
            validationError instanceof Error ? validationError.message : String(validationError);
          logger.warn({ operation: 'mcp', name, rootPath }, `Allowlist validation failed: ${msg}`);
          const errorOutput = {
            success: false,
            error: {
              code: 'ALLOWLIST_VALIDATION_FAILED',
              message: msg,
              timestamp: new Date().toISOString(),
            },
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
            structuredContent: errorOutput,
            isError: true,
          };
        }
      } else if (existingProject?.blockedFindingAllowlist?.length) {
        // Preserve: return existing nonempty allowlist (relative paths only).
        resolvedAllowlistAction = 'preserved';
        effectiveAllowlistRelativePaths = (
          existingProject.blockedFindingAllowlist as ReadonlyArray<{
            relativePath: string;
          }>
        ).map((e) => e.relativePath);
      }

      // Build the upsert input.
      // When replacing the allowlist, pass it explicitly.
      // When omitting, the ON CONFLICT DO UPDATE CASE expression preserves
      // the current DB value (last-writer semantics; concurrent registration
      // is protected by atomic upsert + DB trigger).
      const upsertInput: Record<string, unknown> = {
        name,
        slug,
        rootPath,
        normalizedRootPath,
        status: 'active',
        syncMode: 'full',
        includeRoots: registeredIncludeRoots,
        metadata: {
          backend: 'postgres',
          gitRemote,
          defaultBranch,
          registeredBy: 'mcp',
        },
      };
      if (registeredIgnoreRules !== undefined) {
        upsertInput.ignoreRules = registeredIgnoreRules;
      }
      if (replaceRequested && allowlistExplicitlySupplied) {
        upsertInput.blockedFindingAllowlist = blockedFindingAllowlist;
      }

      const postgresId = await store.upsertProjectRagPostgresRepository(sql, upsertInput as any);
      const persistedContext = await store.upsertProjectRagWorkspaceContext(sql, workspaceContext);

      if (normalizedRootPath === workspaceContext.workspaceRoot) {
        await store.upsertProjectRagWorkspaceAlias(sql, {
          workspaceId: persistedContext.workspaceId,
          alias: slug,
          legacyProjectId: postgresId,
        });
      }

      const scopePreserved =
        preserveExistingScope &&
        existingProject?.includeRoots?.length > 0 &&
        registeredIncludeRoots === existingProject.includeRoots;

      // Re-read the persisted project to derive response truth under concurrency.
      // This ensures that if a concurrent registration modified the allowlist
      // between our upsert and this read, we report the actual persisted state
      // rather than stale predicted state.
      let persistedAllowlistPaths: string[] = [];
      try {
        const persistedProject = await store.findProjectRagPostgresProject(sql, slug);
        if (persistedProject?.blockedFindingAllowlist?.length) {
          persistedAllowlistPaths = (
            persistedProject.blockedFindingAllowlist as ReadonlyArray<{
              relativePath: string;
            }>
          ).map((e) => e.relativePath);
        }
      } catch {
        // If re-read is unavailable, fall back to predicted effectiveAllowlistRelativePaths
        persistedAllowlistPaths = effectiveAllowlistRelativePaths;
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          projectId: slug,
          postgresId,
          slug,
          status: 'active',
          includeRoots: registeredIncludeRoots,
          scopePreserved,
          allowlistAction: resolvedAllowlistAction,
          effectiveBlockedFindingAllowlist: persistedAllowlistPaths,
          database: {
            source: config.database.source,
            redactedUrl: config.database.redactedUrl,
          },
          created: existingProject === undefined,
          watcher: {
            status: 'skipped',
            rootPath: normalizedRootPath,
            slug,
            reason: 'Postgres registration does not start legacy Convex watchers.',
          },
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(structuredOutput, null, 2),
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp', name, rootPath }, 'Failed to register project');

    // Detect policy-race: a CONSUMING snapshot prevents config mutation.
    // Map to a dedicated, retryable error code with no raw DB/ID leakage.
    const isPolicyLocked = msg.includes('CONSUMING') || msg.includes('consuming ingest snapshot');

    if (isPolicyLocked) {
      const errorOutput = {
        success: false,
        error: {
          code: 'PROJECT_CONFIG_LOCKED',
          message:
            'Project configuration is locked because an active ingest is in progress. Retry after the current ingest completes.',
          retryable: true,
          timestamp: new Date().toISOString(),
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
        structuredContent: errorOutput,
        isError: true,
      };
    }

    // Sanitize DB internal IDs from error messages for generic errors
    const sanitizedMsg = msg
      .replace(/project_repositories\b/g, '<project>')
      .replace(/\b\d{4,}\b/g, '<id>');

    const errorOutput = {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: sanitizedMsg,
        timestamp: new Date().toISOString(),
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(errorOutput, null, 2),
        },
      ],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}

// ============================================================================
// Prepare Project Handler
// ============================================================================

/**
 * Prepare one selected project for retrieval using the shared CLI operation.
 * The handler intentionally does not request a scope acknowledgement: root
 * trust, canonical identity, and registered scope are enforced by prepareProject.
 */
export async function handlePrepareProject(
  args: {
    rootPath: string;
    projectId?: string;
    includeRoots?: string[];
    timeoutMs?: number;
    maxFiles?: number;
    maxBatches?: number;
  },
  signal?: AbortSignal
) {
  try {
    const result = await prepareProject({
      rootPath: args.rootPath,
      ...(args.projectId ? { project: args.projectId } : {}),
      ...(args.includeRoots ? { includeRoots: args.includeRoots } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.maxFiles !== undefined ? { maxFiles: args.maxFiles } : {}),
      ...(args.maxBatches !== undefined ? { maxBatches: args.maxBatches } : {}),
      ...(signal ? { signal } : {}),
    });
    if (result.ready) {
      const structuredOutput = { success: true, data: result };
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredOutput, null, 2) }],
        structuredContent: structuredOutput,
      };
    }

    const retryable = result.status === 'running' || result.status === 'partial';
    const errorOutput = {
      success: false,
      error: {
        code: result.reason?.code ?? 'PROJECT_PREPARATION_INCOMPLETE',
        message: result.reason?.message ?? 'Project preparation did not reach ready state',
        retryable,
        timestamp: new Date().toISOString(),
      },
      data: result,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
      structuredContent: errorOutput,
      isError: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorRecord =
      error && typeof error === 'object' ? (error as { code?: unknown; details?: unknown }) : {};
    const code =
      typeof errorRecord.code === 'string' ? errorRecord.code : 'PROJECT_PREPARATION_FAILED';
    logger.error({ error, operation: 'mcp', rootPath: args.rootPath }, 'Failed to prepare project');
    const errorOutput = {
      success: false,
      error: {
        code,
        message,
        ...(errorRecord.details && typeof errorRecord.details === 'object'
          ? { details: errorRecord.details }
          : {}),
        timestamp: new Date().toISOString(),
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}

// ============================================================================
// Verify Project Index Handler
// ============================================================================

/**
 * Verify project index health, coverage, and freshness.
 *
 * Queries statistics from projectFiles, projectChunks, and projectSyncRuns
 * to provide a comprehensive health summary.
 *
 * @param args.projectId - Project registry ID (required)
 *
 * @returns MCP-formatted response with coverage, freshness, and health summary
 *
 * @example
 * const result = await handleVerifyProjectIndex({
 *   projectId: 'project123'
 * });
 */
export async function handleVerifyProjectIndex(args: { projectId: string }) {
  const { projectId } = args;

  try {
    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        const notFoundOutput = {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Project not found: ${projectId}`,
            timestamp: new Date().toISOString(),
          },
        };
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: notFoundOutput,
          isError: true,
        };
      }

      const stats = await store.getProjectRagPostgresProjectStats(sql, project.id);
      if (!store.getProjectRagPostgresInvariantReport) {
        throw new Error('Postgres invariant verifier unavailable');
      }
      const invariantReport = await store.getProjectRagPostgresInvariantReport(sql, project);
      const {
        versionReadiness,
        freshness,
        scopeCoverage,
        embeddingCoverage,
        ownershipCoverage,
        lastSyncAt,
      } = invariantReport;
      const invariantEvaluation = evaluateProjectInvariants({
        fileCount: stats.indexedFileCount,
        versionReadiness,
        freshnessStatus: freshness.status,
        scopeCoverageStatus: scopeCoverage.status,
        embeddingCoverage,
        ownershipCoverage,
      });
      const coverage = stats.indexedFileCount > 0 ? 'Indexed' : 'Not indexed';
      const gateSignal = invariantEvaluation.gateSignal;
      const structuredOutput = {
        success: gateSignal.ready,
        data: {
          backend: 'postgres',
          projectId,
          fileCount: stats.fileCount,
          chunkCount: stats.chunkCount,
          symbolCount: stats.symbolCount,
          edgeCount: stats.edgeCount,
          lastSyncAt,
          coverage,
          status: project.status,
          versionReadiness,
          freshness,
          scopeCoverage,
          embeddingCoverage,
          ownershipCoverage,
          invariants: {
            summary: invariantEvaluation.summary,
            checks: invariantEvaluation.checks,
          },
          gateSignal,
          watcher: {
            status: 'skipped',
            rootPath: project.normalizedRootPath,
            slug: project.slug,
            reason: 'Postgres verification does not start project watchers.',
          },
        },
      };

      return {
        content: [
          {
            type: 'text',
            text:
              `# Project Index Verification\n\n` +
              `## Project Info\n` +
              `**Name:** ${project.name}\n` +
              `**Slug:** ${project.slug}\n` +
              `**Root Path:** ${project.normalizedRootPath}\n` +
              `**Status:** ${project.status}\n` +
              `**Backend:** postgres\n\n` +
              `## Index Statistics\n` +
              `**File Count:** ${stats.fileCount}\n` +
              `**Indexed Files:** ${stats.indexedFileCount}\n` +
              `**Blocked Files:** ${stats.blockedFileCount}\n` +
              `**Chunk Count:** ${stats.chunkCount}\n` +
              `**Symbol Count:** ${stats.symbolCount}\n` +
              `**Edge Count:** ${stats.edgeCount}\n` +
              `**Embedding 1024 Count:** ${stats.embedding1024Count}\n` +
              `**Coverage:** ${coverage}\n\n` +
              `## Freshness\n` +
              `**Status:** ${formatFreshnessStatus(freshness.status)}\n` +
              `**Reason:** ${freshness.reason}\n\n` +
              `## Embedding Coverage\n` +
              `**Status:** ${embeddingCoverage.status}\n` +
              `**Chunk Owners:** ${embeddingCoverage.chunkOwners}\n` +
              `**Embedding Owners:** ${embeddingCoverage.embeddingOwners}\n` +
              `**Missing Owners:** ${embeddingCoverage.missingOwners}\n\n` +
              `## Gate Signal\n` +
              `**Project Contract Ready:** ${gateSignal.ready ? 'Yes' : 'No'}\n` +
              `**Blocking Failure Code:** ${gateSignal.blockingFailureCode ?? 'none'}`,
          },
        ],
        structuredContent: structuredOutput,
        isError: !gateSignal.ready,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const failureCode = classifyVerifyProjectIndexFailure(error);
    logger.error({ error, operation: 'mcp', projectId }, 'Failed to verify project index');
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
      data: {
        failureCode,
        phase: 'verify_project_index',
      },
    };
    return {
      content: [
        {
          type: 'text',
          text: `Failed to verify project index: ${msg}\n[phase=verify_project_index code=${failureCode}]`,
        },
      ],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}
export async function handleFindProjectSymbol(args: {
  projectId: string;
  symbolName: string;
  symbolType?: string;
  limit?: number;
}) {
  const { projectId, symbolName, symbolType, limit = 10 } = args;
  const validLimit = Math.min(Math.max(limit, 1), 50);

  try {
    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const result = await store.findProjectRagPostgresSymbols(sql, project.id, {
        name: symbolName,
        type: symbolType,
        limit: validLimit,
      });

      if (result.definitions.length === 0) {
        const emptyOutput = {
          success: true,
          data: {
            backend: 'postgres',
            symbols: [],
            count: 0,
          },
        };
        return {
          content: [
            {
              type: 'text',
              text: `No symbols found with name "${symbolName}"${symbolType ? ` (${symbolType})` : ''} in project "${projectId}"`,
            },
          ],
          structuredContent: emptyOutput,
        };
      }

      const seenDefinitions = new Set<string>();
      const definitions = result.definitions.filter((symbol) => {
        const key = [
          symbol.name,
          symbol.symbolType,
          symbol.sourcePath,
          symbol.startLine ?? 'unknown-start',
          symbol.endLine ?? 'unknown-end',
          symbol.signature ?? 'unknown-signature',
        ].join('\0');
        if (seenDefinitions.has(key)) {
          return false;
        }
        seenDefinitions.add(key);
        return true;
      });

      const mappedSymbols = definitions.map((symbol) => ({
        name: symbol.name,
        symbolType: symbol.symbolType,
        sourcePath: symbol.sourcePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        signature: symbol.signature,
      }));
      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          symbols: mappedSymbols,
          count: mappedSymbols.length,
        },
      };

      const formattedSymbols = definitions
        .map((symbol, index) => {
          const lineInfo = symbol.startLine
            ? `L${symbol.startLine}${symbol.endLine && symbol.endLine !== symbol.startLine ? `-${symbol.endLine}` : ''}`
            : 'unknown location';
          return `## ${index + 1}. ${symbol.name}\n**Type:** ${symbol.symbolType}\n**File:** ${symbol.sourcePath}\n**Location:** ${lineInfo}\n${symbol.signature ? `**Signature:** \`${symbol.signature}\`` : ''}`;
        })
        .join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `Found ${definitions.length} symbol(s) matching "${symbolName}"${symbolType ? ` (${symbolType})` : ''}:\n\n${formattedSymbols}`,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(
      { error, operation: 'mcp', projectId, symbolName, symbolType },
      'Failed to find project symbol'
    );
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
    };
    return {
      content: [{ type: 'text', text: `Failed to find project symbol: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}

// ============================================================================
// Semantic Navigation Handlers (P2-05)
// ============================================================================

/**
 * Get semantic clusters for project files.
 *
 * Groups files into clusters of semantically similar content based on embeddings.
 *
 * @param args.projectId - Project registry ID
 * @param args.maxClusters - Maximum number of clusters (default: 10)
 * @param args.minClusterSize - Minimum files per cluster (default: 2)
 *
 * @returns MCP-formatted response with semantic clusters
 */
export async function handleGetSemanticClusters(args: {
  projectId: string;
  maxClusters?: number;
  minClusterSize?: number;
}) {
  const { projectId, maxClusters = 10, minClusterSize = 2 } = args;

  try {
    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const clusters = await store.getProjectRagPostgresSemanticClusters(sql, project.id, {
        maxClusters,
        minClusterSize,
      });

      if (clusters.length === 0) {
        const emptyOutput = {
          success: true,
          data: { backend: 'postgres', clusters: [], count: 0 },
        };
        return {
          content: [
            {
              type: 'text',
              text: `No semantic clusters found for project "${projectId}". Ensure the project has been indexed.`,
            },
          ],
          structuredContent: emptyOutput,
        };
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          clusters: clusters.map((cluster) => ({
            clusterId: cluster.clusterId,
            topicLabel: cluster.topicLabel,
            confidence: cluster.confidence,
            fileCount: cluster.files.length,
            files: cluster.files.slice(0, 10),
            terms: cluster.terms,
          })),
          count: clusters.length,
        },
      };

      const formattedClusters = clusters
        .map((cluster, index) => {
          const fileList = cluster.files
            .slice(0, 5)
            .map(
              (f: { sourcePath: string; similarity: number }) =>
                `  - ${f.sourcePath} (${(f.similarity * 100).toFixed(0)}%)`
            )
            .join('\n');
          const moreFiles =
            cluster.files.length > 5 ? `\n  ... and ${cluster.files.length - 5} more files` : '';

          return `## ${index + 1}. ${cluster.topicLabel} (${(cluster.confidence * 100).toFixed(0)}% confidence)
**Files:** ${cluster.files.length}
**Terms:** ${cluster.terms.join(', ')}

${fileList}${moreFiles}`;
        })
        .join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Semantic Clusters for Project "${projectId}"\n\nFound ${clusters.length} semantic clusters:\n\n${formattedClusters}`,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp', projectId }, 'Failed to get semantic clusters');
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
    };
    return {
      content: [{ type: 'text', text: `Failed to get semantic clusters: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}

/**
 * Get feature hubs for project files.
 *
 * Groups files by directory structure, identifying logical feature areas.
 *
 * @param args.projectId - Project registry ID
 * @param args.minFiles - Minimum files to consider a directory a hub (default: 2)
 *
 * @returns MCP-formatted response with feature hubs
 */
export async function handleGetFeatureHubs(args: { projectId: string; minFiles?: number }) {
  const { projectId, minFiles = 2 } = args;

  try {
    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const hubs = await store.getProjectRagPostgresFeatureHubs(sql, project.id, { minFiles });

      if (hubs.length === 0) {
        const emptyOutput = {
          success: true,
          data: { backend: 'postgres', hubs: [], count: 0 },
        };
        return {
          content: [
            {
              type: 'text',
              text: `No feature hubs found for project "${projectId}". Ensure the project has been indexed.`,
            },
          ],
          structuredContent: emptyOutput,
        };
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          hubs: hubs.map((hub) => ({
            hubId: hub.hubId,
            name: hub.name,
            directory: hub.directory,
            fileCount: hub.stats.fileCount,
            languages: hub.stats.languageCount,
            symbols: hub.stats.totalSymbols,
          })),
          count: hubs.length,
        },
      };

      const formattedHubs = hubs
        .map((hub, index) => {
          const fileList = hub.files
            .slice(0, 5)
            .map(
              (f: { fileName: string; symbols: string[] }) =>
                `  - ${f.fileName}${f.symbols.length > 0 ? ` (${f.symbols.slice(0, 3).join(', ')}${f.symbols.length > 3 ? '...' : ''})` : ''}`
            )
            .join('\n');
          const moreFiles =
            hub.files.length > 5 ? `\n  ... and ${hub.files.length - 5} more files` : '';
          const fileTypes = Object.entries(hub.stats.fileTypeDistribution)
            .map(([ext, count]) => `${ext}: ${count}`)
            .join(', ');

          return `## ${index + 1}. ${hub.name}
**Directory:** ${hub.directory}
**Files:** ${hub.stats.fileCount} | **Languages:** ${hub.stats.languageCount} | **Symbols:** ${hub.stats.totalSymbols}
**File Types:** ${fileTypes}

${fileList}${moreFiles}`;
        })
        .join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Feature Hubs for Project "${projectId}"\n\nFound ${hubs.length} feature hubs:\n\n${formattedHubs}`,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp', projectId }, 'Failed to get feature hubs');
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
    };
    return {
      content: [{ type: 'text', text: `Failed to get feature hubs: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}

/**
 * Get navigation paths from a source file.
 *
 * Finds files that are semantically related through various relationship types.
 *
 * @param args.projectId - Project registry ID
 * @param args.sourcePath - Source file path
 * @param args.limit - Maximum paths to return (default: 10)
 *
 * @returns MCP-formatted response with navigation paths
 */
export async function handleGetNavigationPaths(args: {
  projectId: string;
  sourcePath: string;
  limit?: number;
}) {
  const { projectId, sourcePath, limit = 10 } = args;

  try {
    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const paths = await store.getProjectRagPostgresNavigationPaths(sql, project.id, sourcePath, {
        limit,
      });

      if (!paths) {
        const notFoundOutput = {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `File not found: ${sourcePath} in project ${projectId}`,
            timestamp: new Date().toISOString(),
          },
        };
        return {
          content: [
            { type: 'text', text: `File not found: ${sourcePath} in project ${projectId}` },
          ],
          structuredContent: notFoundOutput,
          isError: true,
        };
      }

      if (paths.length === 0) {
        const emptyOutput = {
          success: true,
          data: { backend: 'postgres', sourcePath, paths: [], count: 0 },
        };
        return {
          content: [
            {
              type: 'text',
              text: `No navigation paths found from "${sourcePath}". This may be an isolated file.`,
            },
          ],
          structuredContent: emptyOutput,
        };
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          sourcePath,
          paths: paths.map((p) => ({
            sourcePath: p.sourcePath,
            relationshipType: p.relationshipType,
            strength: p.strength,
            explanation: p.explanation,
          })),
          count: paths.length,
        },
      };

      const formattedPaths = paths
        .map(
          (path, index) =>
            `➡️ **${index + 1}.** ${path.sourcePath}\n   - Relationship: ${path.relationshipType} (${(path.strength * 100).toFixed(0)}%)\n   - ${path.explanation}`
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Navigation Paths from "${sourcePath}"\n\nFound ${paths.length} related files:\n\n${formattedPaths}`,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(
      { error, operation: 'mcp', projectId, sourcePath },
      'Failed to get navigation paths'
    );
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
    };
    return {
      content: [{ type: 'text', text: `Failed to get navigation paths: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}

/**
 * Get topic groups for project files.
 *
 * Groups files by semantic topics derived from content and symbols.
 *
 * @param args.projectId - Project registry ID
 * @param args.maxTopics - Maximum number of topics (default: 8)
 * @param args.minTopicSize - Minimum files per topic (default: 2)
 *
 * @returns MCP-formatted response with topic groups
 */
export async function handleGetTopicGroups(args: {
  projectId: string;
  maxTopics?: number;
  minTopicSize?: number;
}) {
  const { projectId, maxTopics = 8, minTopicSize = 2 } = args;

  try {
    return await withProjectRagPostgres(async (store, sql) => {
      const project = await store.findProjectRagPostgresProject(sql, projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project not found: ${projectId}` }],
          structuredContent: {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Project not found: ${projectId}`,
              timestamp: new Date().toISOString(),
            },
          },
          isError: true,
        };
      }

      const topics = await store.getProjectRagPostgresTopicGroups(sql, project.id, {
        maxTopics,
        minTopicSize,
      });

      if (topics.length === 0) {
        const emptyOutput = {
          success: true,
          data: { backend: 'postgres', topics: [], count: 0 },
        };
        return {
          content: [
            {
              type: 'text',
              text: `No topic groups found for project "${projectId}". Ensure the project has been indexed.`,
            },
          ],
          structuredContent: emptyOutput,
        };
      }

      const structuredOutput = {
        success: true,
        data: {
          backend: 'postgres',
          topics: topics.map((topic) => ({
            topicId: topic.topicId,
            name: topic.name,
            fileCount: topic.files.length,
            keywords: topic.keywords,
            cohesion: topic.cohesion,
          })),
          count: topics.length,
        },
      };

      const formattedTopics = topics
        .map((topic, index) => {
          const fileList = topic.files
            .slice(0, 5)
            .map((f: { sourcePath: string }) => `  - ${f.sourcePath}`)
            .join('\n');
          const moreFiles =
            topic.files.length > 5 ? `\n  ... and ${topic.files.length - 5} more files` : '';

          return `## ${index + 1}. ${topic.name}
**Files:** ${topic.files.length} | **Cohesion:** ${(topic.cohesion * 100).toFixed(0)}%
**Keywords:** ${topic.keywords.join(', ')}

${fileList}${moreFiles}`;
        })
        .join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Topic Groups for Project "${projectId}"\n\nFound ${topics.length} topic groups:\n\n${formattedTopics}`,
          },
        ],
        structuredContent: structuredOutput,
      };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp', projectId }, 'Failed to get topic groups');
    const errorOutput = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg, timestamp: new Date().toISOString() },
    };
    return {
      content: [{ type: 'text', text: `Failed to get topic groups: ${msg}` }],
      structuredContent: errorOutput,
      isError: true,
    };
  }
}
