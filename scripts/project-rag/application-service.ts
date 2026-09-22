import { evaluateProjectInvariants } from '../../lib/shared/project-invariants.js';
import { deriveProjectRagBuildOverlay } from './build-overlay.js';
import type { ResolvedProjectRagWorkspaceContext } from './context.js';
import { resolveProjectRagWorkspaceContext } from './context.js';

type ConfigModule = typeof import('./config.js');
type EmbeddingsModule = typeof import('./embeddings.js');
type StoreModule = typeof import('./store.js');
type Sql = ReturnType<StoreModule['createProjectRagPostgresSql']>;
type Project = Awaited<ReturnType<StoreModule['findProjectRagPostgresProject']>>;
type ServingState = StoreModule extends {
  getProjectRagPostgresServingState: (...args: any[]) => infer R;
}
  ? Awaited<R>
  : never;

export type ProjectApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_READY'
  | 'STALE'
  | 'UNVERIFIED'
  | 'INTERNAL_ERROR';

export class ProjectApplicationError extends Error {
  readonly code: ProjectApplicationErrorCode;
  readonly details: unknown;

  constructor(code: ProjectApplicationErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ProjectApplicationError';
    this.code = code;
    this.details = details;
  }
}

export function isProjectApplicationError(error: unknown): error is ProjectApplicationError {
  return error instanceof ProjectApplicationError;
}

type StoreRuntime = Pick<
  StoreModule,
  | 'createProjectRagPostgresSql'
  | 'findProjectRagPostgresProject'
  | 'getProjectRagPostgresProjectStats'
  | 'getProjectRagPostgresPublishedBuildState'
  | 'searchProjectRagPostgresChunks'
  | 'getProjectRagPostgresFileWithChunks'
  | 'getProjectRagPostgresFileOutline'
  | 'findProjectRagPostgresSymbols'
> &
  Partial<
    Pick<
      StoreModule,
      | 'getProjectRagPostgresServingState'
      | 'getProjectRagPostgresInvariantReport'
      | 'closeProjectRagPostgresSql'
    >
  >;

export type ProjectRagApplicationRuntime = {
  readonly config: Pick<
    ConfigModule,
    'resolveProjectRagPostgresConfigWithLocalDefault' | 'resolveProjectRagPostgresWriteConfig'
  >;
  readonly embeddings: Pick<
    EmbeddingsModule,
    'resolveProjectRagPostgresEmbeddingConfig' | 'fetchProjectRagPostgresEmbeddings'
  >;
  readonly store: StoreRuntime;
};

let runtimeForTesting: ProjectRagApplicationRuntime | undefined;

/** Test seam shared by the CLI and MCP adapters. It never changes production runtime selection. */
export function setProjectRagApplicationRuntimeForTesting(
  runtime: ProjectRagApplicationRuntime | null
): void {
  runtimeForTesting = runtime ?? undefined;
}

/** Compatibility name retained for the existing MCP test seam. */
export const setProjectRagPostgresRuntimeModulesForTesting =
  setProjectRagApplicationRuntimeForTesting;

async function loadRuntime(): Promise<ProjectRagApplicationRuntime> {
  if (runtimeForTesting) return runtimeForTesting;
  const [config, embeddings, store] = await Promise.all([
    import('./config.js'),
    import('./embeddings.js'),
    import('./store.js'),
  ]);
  return { config, embeddings, store };
}

export interface CreateProjectRagApplicationServiceOptions {
  /** CLI closes its short-lived pool; MCP keeps the cached pool alive. */
  readonly closePool?: boolean;
  readonly runtime?: ProjectRagApplicationRuntime;
}

export interface ProjectSearchApplicationArgs {
  readonly project: string;
  readonly query: string;
  readonly limit?: number;
  readonly mode?: 'keyword' | 'vector' | 'hybrid';
  readonly activeFile?: string;
  readonly deterministic?: boolean;
  readonly includeDiagnostics?: boolean;
  readonly maxChars?: number;
  readonly perEntryMaxChars?: number;
  readonly signal?: AbortSignal;
}

export interface ProjectReadApplicationArgs {
  readonly project: string;
  readonly file: string;
  readonly limit?: number;
}

export interface ProjectSymbolApplicationArgs {
  readonly project: string;
  readonly name: string;
  readonly type?: string;
  readonly limit?: number;
}

export interface ProjectVerifyApplicationArgs {
  readonly project: string;
  readonly query?: string;
  readonly limit?: number;
  readonly includeSearch?: boolean;
}

interface ProjectContext {
  readonly project: NonNullable<Project>;
  readonly serving: ServingState;
  readonly buildBound: boolean;
  readonly workspace?: ResolvedProjectRagWorkspaceContext;
  readonly overlay: ReturnType<typeof deriveProjectRagBuildOverlay>;
  readonly contextInvalid: boolean;
}

interface ProjectPayloadTruncation {
  readonly truncated: boolean;
  readonly maxChars: number;
  readonly originalEntries: number;
  readonly returnedEntries: number;
  readonly originalChars: number;
  readonly returnedChars: number;
  readonly droppedEntries: number;
}

interface ProjectSearchResult {
  readonly sourcePath: string;
  readonly score: number;
  readonly vectorScore?: number;
  readonly chunkIndex?: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly content?: string;
  readonly symbolName?: string;
  readonly symbolKind?: string;
}

const EMBEDDING_DIMENSIONS = 1024;
const LEXICAL_FALLBACK_EMBEDDING = Object.freeze(
  Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0)
);
const LEXICAL_FALLBACK_IDENTITY = Object.freeze({
  embeddingModel: '__mcp_lexical_fallback__',
  embeddingProvider: '__mcp_lexical_fallback__',
  embeddingDimensions: -1,
  embeddingProfileHash: '__mcp_lexical_fallback_profile__',
});

function throwForInvalidProjectContext(context: ProjectContext): never {
  if (!context.contextInvalid) {
    throw new Error('Project context is current');
  }
  const code = context.overlay.contextStatus === 'unverified' ? 'UNVERIFIED' : 'STALE';
  throw new ProjectApplicationError(
    code,
    `Project RAG provenance is ${context.overlay.contextStatus}; prepare the selected project before reading indexed data`,
    {
      action: 'prepare_project',
      project: context.project.slug,
      projectId: context.project.id,
      buildId: context.serving.buildId,
      contextStatus: context.overlay.contextStatus,
      publishedIdentityDigest: context.serving.provenance.identityDigest,
      currentIdentityDigest: context.workspace?.identityDigest ?? null,
      dirtyPaths: context.overlay.dirtyPaths,
    }
  );
}

function textInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectApplicationError('INVALID_INPUT', `${field} is required`);
  }
  return value.trim();
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new ProjectApplicationError('INVALID_INPUT', 'limit must be a positive integer');
  }
  return Math.min(value, max);
}

function normalizeMode(
  value: ProjectSearchApplicationArgs['mode']
): 'keyword' | 'vector' | 'hybrid' {
  const mode = value ?? 'hybrid';
  if (mode === 'keyword' || mode === 'vector' || mode === 'hybrid') return mode;
  throw new ProjectApplicationError('INVALID_INPUT', 'mode must be keyword, vector, or hybrid');
}

function emptyProvenance() {
  return {
    repositoryHash: null,
    workspaceHash: null,
    headOid: null,
    branchName: null,
    isDetached: null,
    isUnborn: null,
    headHash: null,
    branchHash: null,
    detachedHash: null,
    contentHash: null,
    contentFingerprint: null,
    statusDigest: null,
    identityDigest: null,
  };
}

async function resolveServing(
  runtime: ProjectRagApplicationRuntime,
  sql: Sql,
  projectId: number
): Promise<{ readonly serving: ServingState; readonly buildBound: boolean }> {
  if (runtime.store.getProjectRagPostgresServingState) {
    return {
      serving: await runtime.store.getProjectRagPostgresServingState(sql, projectId),
      buildBound: true,
    };
  }

  const published = await runtime.store.getProjectRagPostgresPublishedBuildState(sql, projectId);
  return {
    serving: {
      status: 'serving',
      buildId: published.buildId,
      revisionId: null,
      publishedAt: null,
      fileCount: 0,
      versionCount: 0,
      dirtyDigest: published.dirtyDigest,
      provenance: emptyProvenance(),
    } as ServingState,
    buildBound: false,
  };
}

async function resolveContext(
  runtime: ProjectRagApplicationRuntime,
  sql: Sql,
  projectRef: string,
  requireServing: boolean
): Promise<ProjectContext> {
  const normalizedRef = textInput(projectRef, 'project');
  const project = await runtime.store.findProjectRagPostgresProject(sql, normalizedRef);
  if (!project) {
    throw new ProjectApplicationError('NOT_FOUND', `Project not found: ${normalizedRef}`, {
      project: normalizedRef,
    });
  }

  const { serving, buildBound } = await resolveServing(runtime, sql, project.id);
  if (requireServing && serving.status !== 'serving') {
    throw new ProjectApplicationError(
      'NOT_READY',
      serving.reason ?? `Project RAG is unavailable for project ${project.id}`,
      { project: project.id, serving }
    );
  }

  let workspace: ResolvedProjectRagWorkspaceContext | undefined;
  if (typeof project.rootPath === 'string' && project.rootPath.length > 0) {
    workspace = await resolveProjectRagWorkspaceContext(project.rootPath, undefined, {
      includeRoots: project.includeRoots,
      ignoreRules: project.ignoreRules,
    });
  }
  const overlay = deriveProjectRagBuildOverlay({
    publishedDirtyDigest: serving.dirtyDigest,
    currentDirtyDigest: workspace?.dirtyDigest ?? '',
    publishedIdentityDigest: serving.provenance.identityDigest,
    currentIdentityDigest: workspace?.identityDigest ?? null,
  });

  return {
    project,
    serving,
    buildBound,
    workspace,
    overlay,
    contextInvalid: overlay.status === 'invalid',
  };
}

async function withReadSql<T>(
  options: CreateProjectRagApplicationServiceOptions,
  operation: (
    runtime: ProjectRagApplicationRuntime,
    sql: Sql,
    config: ReturnType<ConfigModule['resolveProjectRagPostgresConfigWithLocalDefault']>
  ) => Promise<T>
): Promise<T> {
  const runtime = options.runtime ?? runtimeForTesting ?? (await loadRuntime());
  const config = runtime.config.resolveProjectRagPostgresConfigWithLocalDefault();
  const sql = runtime.store.createProjectRagPostgresSql(config);
  try {
    return await operation(runtime, sql, config);
  } finally {
    if (options.closePool && config.database.url && runtime.store.closeProjectRagPostgresSql) {
      await runtime.store.closeProjectRagPostgresSql(config.database.url);
    }
  }
}

function applyActiveFileBias(
  results: ProjectSearchResult[],
  activeFile?: string
): ProjectSearchResult[] {
  if (!activeFile) return results;
  const normalized = activeFile.replace(/\\/g, '/').replace(/^\.\//, '');
  const activeDir = normalized.includes('/')
    ? normalized.slice(0, normalized.lastIndexOf('/'))
    : '.';
  return [...results]
    .map((result) => {
      const source = result.sourcePath.replace(/\\/g, '/').replace(/^\.\//, '');
      const sourceDir = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '.';
      const bias =
        source === normalized
          ? 0.2
          : sourceDir === activeDir
            ? 0.1
            : activeDir !== '.' && source.startsWith(`${activeDir}/`)
              ? 0.05
              : 0;
      return { ...result, score: result.score + bias };
    })
    .sort((left, right) => right.score - left.score);
}

function capResultContent<T extends { readonly content?: string }>(
  items: readonly T[],
  maxChars: number | undefined,
  perEntryMaxChars: number | undefined
): { readonly items: T[]; readonly truncation?: ProjectPayloadTruncation } {
  if (maxChars === undefined || perEntryMaxChars === undefined) return { items: [...items] };
  let remaining = Math.max(maxChars, 0);
  let originalChars = 0;
  let returnedChars = 0;
  const capped: T[] = [];
  for (const item of items) {
    const content = item.content ?? '';
    originalChars += content.length;
    if (remaining <= 0) continue;
    const value = content.slice(0, Math.min(remaining, Math.max(perEntryMaxChars, 0)));
    remaining -= value.length;
    returnedChars += value.length;
    capped.push({ ...item, ...(item.content === undefined ? {} : { content: value }) });
  }
  return {
    items: capped,
    truncation: {
      truncated: capped.length !== items.length || returnedChars < originalChars,
      maxChars,
      originalEntries: items.length,
      returnedEntries: capped.length,
      originalChars,
      returnedChars,
      droppedEntries: Math.max(items.length - capped.length, 0),
    },
  };
}

function searchIdentity(
  config: ReturnType<EmbeddingsModule['resolveProjectRagPostgresEmbeddingConfig']>
) {
  return {
    embeddingModel: config.model,
    embeddingProvider: config.provider,
    embeddingDimensions: config.dimensions,
    embeddingProfileHash: config.profileHash,
  };
}

export interface ProjectRagApplicationService {
  searchProject(args: ProjectSearchApplicationArgs): Promise<Record<string, unknown>>;
  getProjectFile(args: ProjectReadApplicationArgs): Promise<Record<string, unknown>>;
  getProjectOutline(args: ProjectReadApplicationArgs): Promise<Record<string, unknown>>;
  findProjectSymbol(args: ProjectSymbolApplicationArgs): Promise<Record<string, unknown>>;
  verifyProject(args: ProjectVerifyApplicationArgs): Promise<Record<string, unknown>>;
}

export function createProjectRagApplicationService(
  options: CreateProjectRagApplicationServiceOptions = {}
): ProjectRagApplicationService {
  const searchProject = async (args: ProjectSearchApplicationArgs) =>
    withReadSql(options, async (runtime, sql) => {
      const query = textInput(args.query, 'query');
      const projectRef = textInput(args.project, 'project');
      const limit = boundedLimit(args.limit, 10, 50);
      const requestedMode = normalizeMode(args.mode);
      const context = await resolveContext(runtime, sql, projectRef, true);
      if (context.contextInvalid) {
        throwForInvalidProjectContext(context);
      }
      let embeddingConfig:
        | ReturnType<EmbeddingsModule['resolveProjectRagPostgresEmbeddingConfig']>
        | undefined;
      let embeddingFailure: 'unavailable' | 'invalid_response' | undefined;
      try {
        embeddingConfig = runtime.embeddings.resolveProjectRagPostgresEmbeddingConfig();
      } catch {
        embeddingFailure = 'unavailable';
      }

      let queryEmbedding: readonly number[] | undefined;
      if (embeddingConfig && !context.contextInvalid) {
        try {
          const [candidate] = await runtime.embeddings.fetchProjectRagPostgresEmbeddings(
            embeddingConfig,
            [
              `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${query}`,
            ],
            args.signal
          );
          if (
            candidate &&
            candidate.length === EMBEDDING_DIMENSIONS &&
            embeddingConfig.dimensions === EMBEDDING_DIMENSIONS &&
            candidate.every((value) => Number.isFinite(value))
          ) {
            queryEmbedding = candidate;
          } else {
            embeddingFailure = 'invalid_response';
          }
        } catch {
          embeddingFailure = 'unavailable';
        }
      }

      const primaryIdentity = embeddingConfig ? searchIdentity(embeddingConfig) : undefined;
      const executeSearch = async (
        queryVector: readonly number[],
        identity: ReturnType<typeof searchIdentity> | typeof LEXICAL_FALLBACK_IDENTITY
      ) =>
        (await runtime.store.searchProjectRagPostgresChunks(sql, context.project.id, {
          query,
          queryEmbedding: queryVector,
          ...(context.buildBound ? { buildId: context.serving.buildId ?? undefined } : {}),
          ...identity,
          limit,
        })) as ProjectSearchResult[];

      let primarySearchAttempted = false;
      let fallbackUsed = false;
      let fallbackReason: 'embedding_unavailable' | 'hybrid_empty' | undefined;
      let rawResults: ProjectSearchResult[];
      if (queryEmbedding && primaryIdentity) {
        primarySearchAttempted = true;
        rawResults = await executeSearch(queryEmbedding, primaryIdentity);
      } else {
        fallbackUsed = true;
        fallbackReason = 'embedding_unavailable';
        rawResults = await executeSearch(LEXICAL_FALLBACK_EMBEDDING, LEXICAL_FALLBACK_IDENTITY);
      }
      if (rawResults.length === 0 && !fallbackUsed) {
        fallbackUsed = true;
        fallbackReason = 'hybrid_empty';
        rawResults = await executeSearch(LEXICAL_FALLBACK_EMBEDDING, LEXICAL_FALLBACK_IDENTITY);
      }

      const warnings: string[] = [];
      if (requestedMode === 'keyword') {
        warnings.push(
          'Keyword search mode is deprecated and has been mapped to hybrid vector+lexical search.'
        );
      } else if (requestedMode !== 'hybrid') {
        warnings.push(
          `PROJECT_RAG_BACKEND=postgres uses hybrid vector+lexical search for ${requestedMode} requests.`
        );
      }
      if (args.deterministic) {
        warnings.push('Deterministic graph search is not available in the Postgres backend yet.');
      }
      if (fallbackUsed) {
        warnings.push(
          embeddingFailure || fallbackReason === 'embedding_unavailable'
            ? 'Embedding retrieval was unavailable; used the embedding-independent lexical fallback.'
            : 'Hybrid retrieval returned no results; used the embedding-independent lexical fallback.'
        );
      }

      const ranked = applyActiveFileBias(rawResults, args.activeFile);
      const capped = capResultContent(ranked, args.maxChars, args.perEntryMaxChars);
      const results = capped.items;
      const diagnostics = args.includeDiagnostics
        ? {
            pipeline: 'postgres_project_rag',
            mode: 'hybrid',
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

      return {
        backend: 'postgres',
        project: context.project,
        serving: context.serving,
        provenance: context.serving.provenance,
        buildId: context.serving.buildId,
        query,
        mode: 'hybrid',
        requestedMode,
        results,
        count: results.length,
        warnings,
        fallbackUsed,
        ...(fallbackReason ? { fallbackReason } : {}),
        ...(embeddingConfig
          ? {
              embeddingConfig: {
                provider: embeddingConfig.provider,
                model: embeddingConfig.model,
                baseUrl: embeddingConfig.baseUrl,
                dimensions: embeddingConfig.dimensions,
                profileHash: embeddingConfig.profileHash,
              },
            }
          : {}),
        ...(diagnostics ? { diagnostics } : {}),
        ...(capped.truncation ? { truncation: capped.truncation } : {}),
      };
    });

  const getProjectFile = async (args: ProjectReadApplicationArgs) =>
    withReadSql(options, async (runtime, sql) => {
      const projectRef = textInput(args.project, 'project');
      const sourcePath = textInput(args.file, 'file');
      const context = await resolveContext(runtime, sql, projectRef, true);
      if (context.contextInvalid) {
        throwForInvalidProjectContext(context);
      }
      const result = await runtime.store.getProjectRagPostgresFileWithChunks(
        sql,
        context.project.id,
        sourcePath,
        {
          limit: boundedLimit(args.limit, 20, 500),
          ...(context.buildBound ? { buildId: context.serving.buildId ?? undefined } : {}),
        }
      );
      if (!result) throw new ProjectApplicationError('NOT_FOUND', `File not found: ${sourcePath}`);
      return {
        backend: 'postgres',
        project: context.project,
        serving: context.serving,
        provenance: context.serving.provenance,
        buildId: result.buildId ?? context.serving.buildId,
        versionId: result.versionId,
        file: result.file,
        chunks: result.chunks,
        chunkCount: result.chunkCount,
      };
    });

  const getProjectOutline = async (args: ProjectReadApplicationArgs) =>
    withReadSql(options, async (runtime, sql) => {
      const projectRef = textInput(args.project, 'project');
      const sourcePath = textInput(args.file, 'file');
      const context = await resolveContext(runtime, sql, projectRef, true);
      if (context.contextInvalid) {
        throwForInvalidProjectContext(context);
      }
      const result = await runtime.store.getProjectRagPostgresFileOutline(
        sql,
        context.project.id,
        sourcePath,
        {
          limit: boundedLimit(args.limit, 100, 500),
          ...(context.buildBound ? { buildId: context.serving.buildId ?? undefined } : {}),
        }
      );
      if (!result) throw new ProjectApplicationError('NOT_FOUND', `File not found: ${sourcePath}`);
      return {
        backend: 'postgres',
        project: context.project,
        serving: context.serving,
        provenance: context.serving.provenance,
        buildId: result.buildId ?? context.serving.buildId,
        versionId: result.versionId,
        sourcePath: result.sourcePath,
        skeleton: result.skeleton,
        symbols: result.symbols,
        symbolCount: result.symbolCount,
      };
    });

  const findProjectSymbol = async (args: ProjectSymbolApplicationArgs) =>
    withReadSql(options, async (runtime, sql) => {
      const projectRef = textInput(args.project, 'project');
      const name = textInput(args.name, 'name');
      const context = await resolveContext(runtime, sql, projectRef, true);
      if (context.contextInvalid) {
        throwForInvalidProjectContext(context);
      }
      const result = await runtime.store.findProjectRagPostgresSymbols(sql, context.project.id, {
        name,
        type: args.type,
        limit: boundedLimit(args.limit, 10, 100),
        ...(context.buildBound ? { buildId: context.serving.buildId ?? undefined } : {}),
      });
      return {
        backend: 'postgres',
        project: context.project,
        serving: context.serving,
        provenance: context.serving.provenance,
        buildId: result.buildId ?? context.serving.buildId,
        name,
        definitions: result.definitions,
        references: result.references,
        definitionCount: result.definitions.length,
        referenceCount: result.references.length,
      };
    });

  const verifyProject = async (args: ProjectVerifyApplicationArgs) =>
    withReadSql(options, async (runtime, sql) => {
      const projectRef = textInput(args.project, 'project');
      const context = await resolveContext(runtime, sql, projectRef, false);
      if (context.contextInvalid) {
        throwForInvalidProjectContext(context);
      }
      const stats =
        context.serving.buildId === null
          ? {
              fileCount: 0,
              indexedFileCount: 0,
              blockedFileCount: 0,
              chunkCount: 0,
              symbolCount: 0,
              edgeCount: 0,
              embedding1024Count: 0,
              syncRunCount: 0,
            }
          : await runtime.store.getProjectRagPostgresProjectStats(
              sql,
              context.project.id,
              context.buildBound ? { buildId: context.serving.buildId } : undefined
            );
      if (!runtime.store.getProjectRagPostgresInvariantReport) {
        throw new ProjectApplicationError(
          'INTERNAL_ERROR',
          'Postgres invariant verifier unavailable'
        );
      }
      const invariantReport = await runtime.store.getProjectRagPostgresInvariantReport(
        sql,
        context.project,
        context.buildBound && context.serving.buildId !== null
          ? { buildId: context.serving.buildId }
          : undefined
      );
      const invariantEvaluation = evaluateProjectInvariants({
        fileCount: stats.indexedFileCount,
        versionReadiness: invariantReport.versionReadiness,
        freshnessStatus: invariantReport.freshness.status,
        scopeCoverageStatus: invariantReport.scopeCoverage.status,
        embeddingCoverage: invariantReport.embeddingCoverage,
        ownershipCoverage: invariantReport.ownershipCoverage,
      });
      let results: ProjectSearchResult[] = [];
      const query = args.query ?? 'project rag postgres search';
      if (args.includeSearch && context.serving.status === 'serving') {
        const embeddingConfig = runtime.embeddings.resolveProjectRagPostgresEmbeddingConfig();
        const [queryEmbedding] = await runtime.embeddings.fetchProjectRagPostgresEmbeddings(
          embeddingConfig,
          [
            `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${query}`,
          ]
        );
        results = (await runtime.store.searchProjectRagPostgresChunks(sql, context.project.id, {
          query,
          queryEmbedding,
          ...(context.buildBound ? { buildId: context.serving.buildId ?? undefined } : {}),
          ...searchIdentity(embeddingConfig),
          limit: boundedLimit(args.limit, 3, 10),
        })) as ProjectSearchResult[];
      }
      const issues: string[] = [];
      if (stats.fileCount === 0) issues.push('no_project_files');
      if (stats.chunkCount === 0) issues.push('no_project_chunks');
      if (stats.embedding1024Count < stats.chunkCount) issues.push('missing_chunk_embeddings_1024');
      if (args.includeSearch && results.length === 0 && context.serving.status === 'serving') {
        issues.push('search_returned_zero_results');
      }
      if (context.serving.status !== 'serving') issues.push('no_published_build');
      if (!invariantEvaluation.gateSignal.ready) {
        issues.push(invariantEvaluation.gateSignal.blockingFailureCode ?? 'project_index_degraded');
      }
      return {
        ok:
          issues.length === 0 &&
          context.serving.status === 'serving' &&
          invariantEvaluation.gateSignal.ready,
        backend: 'postgres',
        project: context.project,
        projectId: projectRef,
        serving: context.serving,
        provenance: context.serving.provenance,
        stats,
        versionReadiness: invariantReport.versionReadiness,
        freshness: invariantReport.freshness,
        scopeCoverage: invariantReport.scopeCoverage,
        embeddingCoverage: invariantReport.embeddingCoverage,
        ownershipCoverage: invariantReport.ownershipCoverage,
        blockedCoverage: {
          status:
            stats.blockedFileCount > 0 || invariantReport.scopeCoverage.blockedExpectedFiles > 0
              ? 'blocked'
              : 'covered',
          blockedFileCount: stats.blockedFileCount,
          blockedExpectedFiles: invariantReport.scopeCoverage.blockedExpectedFiles,
          blockedExpectedPaths: invariantReport.scopeCoverage.blockedExpectedPaths,
        },
        invariants: invariantEvaluation,
        gateSignal: invariantEvaluation.gateSignal,
        workspace: {
          freshness: invariantReport.freshness,
          scopeCoverage: invariantReport.scopeCoverage,
          readiness: invariantEvaluation.gateSignal,
        },
        lastSyncAt: invariantReport.lastSyncAt,
        query,
        resultCount: results.length,
        topResult: results[0]
          ? {
              sourcePath: results[0].sourcePath,
              symbolName: results[0].symbolName,
              score: results[0].score,
              vectorScore: results[0].vectorScore,
            }
          : null,
        issues,
        status: issues.length === 0 ? 'ok' : 'degraded',
      };
    });

  return { searchProject, getProjectFile, getProjectOutline, findProjectSymbol, verifyProject };
}
