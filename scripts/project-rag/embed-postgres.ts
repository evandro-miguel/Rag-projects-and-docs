import { resolveProjectRagPostgresWriteConfig } from './config.js';
import {
  fetchProjectRagPostgresEmbeddings,
  resolveProjectRagPostgresEmbeddingConfig,
} from './embeddings.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
  listProjectRagPostgresChunkEmbeddingCandidates,
  upsertProjectRagPostgresChunkEmbedding1024,
} from './store.js';

interface EmbedArgs {
  readonly project: string;
  readonly limit: number;
  readonly batchSize: number;
  readonly dryRun: boolean;
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

export function parseEmbedProjectRagPostgresArgs(argv: readonly string[]): EmbedArgs {
  const project = optionValue(argv, '--project');
  if (!project) {
    throw new Error('Missing --project <slug-or-id>.');
  }

  return {
    project,
    limit: Math.min(parsePositiveInteger(optionValue(argv, '--limit'), 1000), 10_000),
    batchSize: Math.min(parsePositiveInteger(optionValue(argv, '--batch-size'), 8), 32),
    dryRun: argv.includes('--dry-run'),
  };
}

/**
 * Guard: refuse non-dry-run writes that bypass the snapshot gate.
 * Standalone maintenance writers must route through gated ingest.
 */
function requireSnapshotGateOrDryRun(args: { dryRun: boolean }): void {
  if (args.dryRun) return;
  throw new Error(
    'UNGUARDED_INDEX_MUTATION_REFUSED: ' +
      'embed-postgres writes embeddings directly, bypassing the Project RAG snapshot gate. ' +
      'Use gated ingest (ingest_project / ingest_project_file) instead. ' +
      'For dry-run inspection, pass --dry-run.'
  );
}

export async function embedProjectRagPostgresChunks(args: EmbedArgs) {
  requireSnapshotGateOrDryRun(args);
  const config = resolveProjectRagPostgresWriteConfig();
  const embeddingConfig = resolveProjectRagPostgresEmbeddingConfig();
  const sql = createProjectRagPostgresSql(config);
  try {
    const project = await findProjectRagPostgresProject(sql, args.project);
    if (!project) {
      throw new Error(`Project not found in Postgres: ${args.project}`);
    }

    const candidates = await listProjectRagPostgresChunkEmbeddingCandidates(sql, project.id, {
      embeddingModel: embeddingConfig.model,
      embeddingProfileHash: embeddingConfig.profileHash,
      limit: args.limit,
    });

    if (args.dryRun) {
      return {
        status: 'dry-run' as const,
        project: { id: project.id, slug: project.slug },
        candidates: candidates.length,
        embeddingsWritten: 0,
        embedding: embeddingConfig,
      };
    }

    let embeddingsWritten = 0;
    for (let offset = 0; offset < candidates.length; offset += args.batchSize) {
      const batch = candidates.slice(offset, offset + args.batchSize);
      const embeddings = await fetchProjectRagPostgresEmbeddings(
        embeddingConfig,
        batch.map((candidate) => candidate.text)
      );
      for (const [index, candidate] of batch.entries()) {
        await upsertProjectRagPostgresChunkEmbedding1024(sql, project.id, {
          ...candidate,
          embedding: embeddings[index],
          embeddingModel: embeddingConfig.model,
          embeddingProvider: embeddingConfig.provider,
          dimensions: embeddingConfig.dimensions,
          embeddingProfileHash: embeddingConfig.profileHash,
        });
        embeddingsWritten += 1;
      }
    }

    return {
      status: 'completed' as const,
      project: { id: project.id, slug: project.slug },
      candidates: candidates.length,
      embeddingsWritten,
      embedding: embeddingConfig,
    };
  } finally {
    if (config.database.url) {
      await closeProjectRagPostgresSql(config.database.url);
    }
  }
}

async function main() {
  const report = await embedProjectRagPostgresChunks(
    parseEmbedProjectRagPostgresArgs(process.argv.slice(2))
  );
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
