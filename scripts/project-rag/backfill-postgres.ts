interface BackfillArgs {
  readonly project: string;
  readonly limit: number;
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

export function parseBackfillProjectRagPostgresArgs(argv: readonly string[]): BackfillArgs {
  const project = optionValue(argv, '--project');
  if (!project) {
    throw new Error('Missing --project <slug-or-id>.');
  }

  const parsedLimit = Number.parseInt(optionValue(argv, '--limit') ?? '5000', 10);
  return {
    project,
    limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 5000) : 5000,
    dryRun: argv.includes('--dry-run'),
  };
}

export async function backfillProjectRagPostgresFromConvex(_args: BackfillArgs): Promise<never> {
  throw new Error(
    [
      'scripts/project-rag/backfill-postgres.ts is retired.',
      'Convex-to-Postgres Project RAG backfill is no longer a runtime path.',
      'Use `bun run ingest-project` for current Project RAG ingestion.',
    ].join('\n')
  );
}

if (import.meta.main) {
  console.error(
    [
      'scripts/project-rag/backfill-postgres.ts is retired.',
      'Use `bun run ingest-project` for current Project RAG ingestion.',
      'Use `bun run verify:project-rag:postgres` to verify the Postgres index.',
    ].join('\n')
  );
  process.exitCode = 1;
}
