import { resolveProjectRagPostgresConfigWithLocalDefault } from './config.js';
import {
  fetchProjectRagPostgresEmbeddings,
  resolveProjectRagPostgresEmbeddingConfig,
} from './embeddings.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
  getProjectRagPostgresServingState,
  searchProjectRagPostgresChunks,
} from './store.js';

interface SearchArgs {
  readonly project: string;
  readonly query: string;
  readonly limit: number;
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

export function parseSearchProjectRagPostgresArgs(argv: readonly string[]): SearchArgs {
  const project = optionValue(argv, '--project');
  if (!project) {
    throw new Error('Missing --project <slug-or-id>.');
  }

  const positional = argv.filter((arg, index) => {
    if (arg.startsWith('--')) {
      return false;
    }
    const previous = argv[index - 1];
    return previous !== '--project' && previous !== '--limit';
  });
  const query = positional.join(' ').trim();
  if (!query) {
    throw new Error('Missing search query.');
  }

  return {
    project,
    query,
    limit: Math.min(parsePositiveInteger(optionValue(argv, '--limit'), 5), 50),
  };
}

export async function searchProjectRagPostgres(args: SearchArgs) {
  const config = resolveProjectRagPostgresConfigWithLocalDefault();
  const embeddingConfig = resolveProjectRagPostgresEmbeddingConfig();
  const sql = createProjectRagPostgresSql(config);
  try {
    const project = await findProjectRagPostgresProject(sql, args.project);
    if (!project) {
      throw new Error(`Project not found in Postgres: ${args.project}`);
    }
    const serving = await getProjectRagPostgresServingState(sql, project.id);
    if (serving.status !== 'serving') {
      throw new Error(serving.reason ?? `Project RAG is unavailable for project ${project.id}`);
    }

    const [queryEmbedding] = await fetchProjectRagPostgresEmbeddings(embeddingConfig, [
      `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${args.query}`,
    ]);
    const results = await searchProjectRagPostgresChunks(sql, project.id, {
      query: args.query,
      queryEmbedding,
      buildId: serving.buildId ?? undefined,
      embeddingModel: embeddingConfig.model,
      embeddingProvider: embeddingConfig.provider,
      embeddingDimensions: embeddingConfig.dimensions,
      embeddingProfileHash: embeddingConfig.profileHash,
      limit: args.limit,
    });

    return {
      project: { id: project.id, slug: project.slug },
      serving,
      query: args.query,
      limit: args.limit,
      count: results.length,
      results,
    };
  } finally {
    if (config.database.url) {
      await closeProjectRagPostgresSql(config.database.url);
    }
  }
}

async function main() {
  const report = await searchProjectRagPostgres(
    parseSearchProjectRagPostgresArgs(process.argv.slice(2))
  );
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
