import type { ProjectRagPostgresProject } from './project-rag/store.js';

// ponytail: list only; add a dedicated Postgres cleanup command when deletion is needed.
const UNSUPPORTED_POSTGRES_FLAGS = [
  '--cleanup-expired',
  '--apply',
  '--cursor',
  '--origin',
  '--owner',
];

function parseFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function printHelp(): void {
  console.log(`List Project RAG Postgres projects.

Usage:
  bun run scripts/list-projects.ts [options]

Options:
  --include-ephemeral  Include ephemeral projects
  --limit <n>          Limit returned projects (default: 100, max: 500)
  --status <status>    Filter by project status
`);
}

function assertSupportedPostgresArgs(args: readonly string[]): void {
  const unsupported = UNSUPPORTED_POSTGRES_FLAGS.filter((flag) => args.includes(flag));
  if (unsupported.length === 0) {
    return;
  }

  throw new Error(
    [
      `Unsupported legacy registry flag(s): ${unsupported.join(', ')}`,
      'This command now reads Project RAG Postgres only.',
      'Use explicit Postgres cleanup tooling when it exists; this command will not delete projects.',
    ].join('\n')
  );
}

function formatProjectLine(project: ProjectRagPostgresProject): string {
  const flags = [
    `status=${project.status}`,
    `ephemeral=${project.ephemeral ? 'yes' : 'no'}`,
    project.includeRoots.length ? `includeRoots=${project.includeRoots.join(',')}` : undefined,
  ].filter(Boolean);

  return `  - ${project.name} (slug: ${project.slug}, id: ${project.id}, root: ${project.rootPath}${flags.length ? `, ${flags.join(', ')}` : ''})`;
}

async function main() {
  const cliArgs = process.argv.slice(2);
  if (parseFlag(cliArgs, '--help') || parseFlag(cliArgs, '-h')) {
    printHelp();
    return;
  }

  assertSupportedPostgresArgs(cliArgs);

  const includeEphemeral = parseFlag(cliArgs, '--include-ephemeral');
  const limitArg = readOption(cliArgs, '--limit');
  const pageSize = parseOptionalNumber(limitArg) ?? 100;
  const status = readOption(cliArgs, '--status');
  const [{ resolveProjectRagPostgresConfigWithLocalDefault }, store] = await Promise.all([
    import('./project-rag/config.js'),
    import('./project-rag/store.js'),
  ]);
  const config = resolveProjectRagPostgresConfigWithLocalDefault();
  const sql = store.createProjectRagPostgresSql(config);
  try {
    const projects = await store.listProjectRagPostgresProjects(sql, {
      includeEphemeral: includeEphemeral || Boolean(status),
      limit: status ? 500 : pageSize,
    });
    const filteredProjects = status
      ? projects.filter((project) => project.status === status).slice(0, pageSize)
      : projects;

    console.log('Projects found:', filteredProjects.length);
    for (const project of filteredProjects) {
      console.log(formatProjectLine(project));
    }
  } finally {
    if (config.database.url) {
      await store.closeProjectRagPostgresSql(config.database.url);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
