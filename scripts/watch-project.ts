import { isAbsolute, relative, resolve } from 'node:path';

export interface WatchProjectCliArgs {
  path?: string;
  status?: boolean;
  help?: boolean;
}

const WATCH_PROJECT_REMOVAL_REASON = 'watcher_removed';

export function parseWatchProjectArgs(argv: string[]): WatchProjectCliArgs {
  const parsed: WatchProjectCliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    switch (token) {
      case '--path':
        parsed.path = next;
        i += 1;
        break;
      case '--status':
        parsed.status = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        break;
    }
  }

  return parsed;
}

export function resolveWatchProjectRootPath(args: WatchProjectCliArgs): string {
  const requestedRoot = args.path ?? process.env.PROJECT_SOURCE_PATH;
  if (!requestedRoot) {
    throw new Error('PROJECT_SOURCE_PATH is required for project watcher (or pass --path <path>)');
  }

  if (!isAbsolute(requestedRoot)) {
    throw new Error('PROJECT_SOURCE_PATH must be an absolute path');
  }

  return resolve(requestedRoot);
}

export function buildWatcherDeleteSourcePath(projectRoot: string, filePath: string): string {
  return relative(resolve(projectRoot), resolve(filePath)).replace(/\\/g, '/');
}

function printHelp(): void {
  console.log(`Usage: bun run scripts/watch-project.ts [options]

Deprecated stub. Live Project RAG watch mode was removed.

Options:
  --path <path>   Absolute project root used for status output
  --status        Print JSON status and exit 0
  -h, --help      Show this message

Use bun run ingest-project --root <path> --include <dir,dir> for reingest.`);
}

function printStatus(rootPath: string): void {
  console.log(
    JSON.stringify(
      {
        status: 'skipped',
        rootPath,
        reason: WATCH_PROJECT_REMOVAL_REASON,
      },
      null,
      2
    )
  );
}

export async function runWatchProjectCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseWatchProjectArgs(argv);

  if (args.help) {
    printHelp();
    return;
  }

  const rootPath = resolveWatchProjectRootPath(args);
  if (args.status) {
    printStatus(rootPath);
    return;
  }

  console.log(
    `Project watcher removed for ${rootPath}. Re-run ingest with bun run ingest-project --root ${rootPath} --include <dir,dir>.`
  );
}

if (import.meta.main) {
  runWatchProjectCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
