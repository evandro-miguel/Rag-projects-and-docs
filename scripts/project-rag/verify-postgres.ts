import { evaluateProjectInvariants } from '../../lib/shared/project-invariants.js';
import {
  createProjectSlug,
  inferProjectNameFromRootPath,
} from '../../lib/shared/project-registry.js';
import { deriveProjectRagBuildOverlay } from './build-overlay.js';
import { resolveProjectRagPostgresConfigWithLocalDefault } from './config.js';
import { resolveProjectRagWorkspaceContext } from './context.js';
import {
  fetchProjectRagPostgresEmbeddings,
  resolveProjectRagPostgresEmbeddingConfig,
} from './embeddings.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
  getProjectRagPostgresInvariantReport,
  getProjectRagPostgresProjectStats,
  getProjectRagPostgresServingState,
  searchProjectRagPostgresChunks,
} from './store.js';

export interface VerifyArgs {
  readonly project: string;
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) {
    return argv[index + 1];
  }

  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function throwIfVerificationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('The verification operation was aborted', 'AbortError');
}

export function parseVerifyProjectRagPostgresArgs(argv: readonly string[]): VerifyArgs {
  const project =
    optionValue(argv, '--project') ??
    process.env.PROJECT_RAG_PROJECT_SLUG ??
    createProjectSlug(inferProjectNameFromRootPath(process.cwd()));

  return {
    project,
    query: optionValue(argv, '--query') ?? 'project rag postgres search',
    limit: Math.min(parsePositiveInteger(optionValue(argv, '--limit'), 3), 10),
  };
}

export async function verifyProjectRagPostgres(args: VerifyArgs) {
  throwIfVerificationAborted(args.signal);
  const config = resolveProjectRagPostgresConfigWithLocalDefault();
  const embeddingConfig = resolveProjectRagPostgresEmbeddingConfig();
  const sql = createProjectRagPostgresSql(config);
  throwIfVerificationAborted(args.signal);
  const project = await findProjectRagPostgresProject(sql, args.project);
  throwIfVerificationAborted(args.signal);
  if (!project) {
    throw new Error(`Project not found in Postgres: ${args.project}`);
  }

  const serving = await getProjectRagPostgresServingState(sql, project.id);
  throwIfVerificationAborted(args.signal);
  const workspace = await resolveProjectRagWorkspaceContext(
    project.normalizedRootPath || project.rootPath,
    undefined,
    {
      includeRoots: project.includeRoots,
      ignoreRules: project.ignoreRules,
    }
  );
  throwIfVerificationAborted(args.signal);
  const overlay = deriveProjectRagBuildOverlay({
    publishedDirtyDigest: serving.dirtyDigest,
    currentDirtyDigest: workspace.dirtyDigest,
    publishedIdentityDigest: serving.provenance.identityDigest,
    currentIdentityDigest: workspace.identityDigest,
  });
  const stats =
    serving.buildId === null
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
      : await getProjectRagPostgresProjectStats(sql, project.id, {
          buildId: serving.buildId,
        });
  throwIfVerificationAborted(args.signal);
  const invariantReport = await getProjectRagPostgresInvariantReport(sql, project, {
    ...(serving.buildId !== null ? { buildId: serving.buildId } : {}),
  });
  throwIfVerificationAborted(args.signal);
  const invariantEvaluation = evaluateProjectInvariants({
    contextStatus: overlay.contextStatus,
    fileCount: stats.indexedFileCount,
    versionReadiness: invariantReport.versionReadiness,
    freshnessStatus: invariantReport.freshness.status,
    scopeCoverageStatus: invariantReport.scopeCoverage.status,
    embeddingCoverage: invariantReport.embeddingCoverage,
    ownershipCoverage: invariantReport.ownershipCoverage,
  });
  let results: Awaited<ReturnType<typeof searchProjectRagPostgresChunks>> = [];
  if (serving.status === 'serving' && overlay.status === 'published') {
    throwIfVerificationAborted(args.signal);
    const [queryEmbedding] = await fetchProjectRagPostgresEmbeddings(
      embeddingConfig,
      [
        `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${args.query}`,
      ],
      args.signal
    );
    throwIfVerificationAborted(args.signal);
    results = await searchProjectRagPostgresChunks(sql, project.id, {
      query: args.query,
      queryEmbedding,
      buildId: serving.buildId ?? undefined,
      embeddingModel: embeddingConfig.model,
      embeddingProvider: embeddingConfig.provider,
      embeddingDimensions: embeddingConfig.dimensions,
      embeddingProfileHash: embeddingConfig.profileHash,
      limit: args.limit,
    });
    throwIfVerificationAborted(args.signal);
  }

  const issues: string[] = [];
  if (stats.fileCount === 0) {
    issues.push('no_project_files');
  }
  if (stats.chunkCount === 0) {
    issues.push('no_project_chunks');
  }
  if (stats.embedding1024Count < stats.chunkCount) {
    issues.push('missing_chunk_embeddings_1024');
  }
  if (results.length === 0) {
    if (serving.status === 'serving' && overlay.status === 'published') {
      issues.push('search_returned_zero_results');
    }
  }
  if (serving.status !== 'serving') {
    issues.push('no_published_build');
  }
  if (!invariantEvaluation.gateSignal.ready) {
    issues.push(invariantEvaluation.gateSignal.blockingFailureCode ?? 'project_index_degraded');
  }

  return {
    ok: issues.length === 0 && serving.status === 'serving' && invariantEvaluation.gateSignal.ready,
    project: { id: project.id, slug: project.slug },
    serving,
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
      context: overlay,
      freshness: invariantReport.freshness,
      scopeCoverage: invariantReport.scopeCoverage,
      readiness: invariantEvaluation.gateSignal,
    },
    lastSyncAt: invariantReport.lastSyncAt,
    query: args.query,
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
  };
}

async function main() {
  const config = resolveProjectRagPostgresConfigWithLocalDefault();
  try {
    const report = await verifyProjectRagPostgres(
      parseVerifyProjectRagPostgresArgs(process.argv.slice(2))
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (config.database.url) {
      await closeProjectRagPostgresSql(config.database.url);
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
