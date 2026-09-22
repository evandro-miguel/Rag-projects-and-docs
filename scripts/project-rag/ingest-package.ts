import { redactCredentialText } from '../../lib/shared/credential-redact.js';
import { ingestProjectRagPostgres } from './ingest-postgres.js';

export type PackageProjectIngestCliArgs =
  | { readonly help: true }
  | {
      readonly help?: false;
      readonly projectSlug: string;
      readonly rootPath: string;
      readonly includeRoots: readonly string[];
      readonly force: boolean;
      readonly maxFiles?: number;
      readonly concurrency?: number;
      readonly approvedSnapshotUuid?: string;
    };

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) {
    return argv[index + 1];
  }

  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parsePositiveInteger(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }

  return parsed;
}

function parseIncludeRoots(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactCredentialText(value);
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 1)}…`;
}

function formatIngestErrors(
  errors: readonly { readonly file: string; readonly error: string }[]
): string {
  if (errors.length === 0) return '';
  const shown = errors
    .slice(0, 3)
    .map(({ file, error }) => `${boundedText(file, 160)}: ${boundedText(error, 240)}`)
    .join('; ');
  const omitted = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
  return ` File errors: ${shown}${omitted}.`;
}

export function parsePackageProjectIngestArgs(
  argv: readonly string[]
): PackageProjectIngestCliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  const projectSlug = optionValue(argv, '--project');
  if (!projectSlug) {
    throw new Error('Missing project identity. Pass --project <slug>.');
  }

  if (argv.includes('--dry-run')) {
    throw new Error(
      'Postgres package ingest does not implement --dry-run yet. Use a real ingest with --root <path> and --include <dir,dir>.'
    );
  }

  const rootPath = optionValue(argv, '--root');
  if (!rootPath) {
    throw new Error('Missing project root. Pass --root <path>.');
  }

  const includeRoots = parseIncludeRoots(optionValue(argv, '--include'));
  if (includeRoots.length === 0) {
    throw new Error(
      'Missing --include <dir,dir>. Postgres package ingest requires explicit include roots.'
    );
  }

  return {
    projectSlug,
    rootPath,
    includeRoots,
    force: argv.includes('--force'),
    maxFiles: parsePositiveInteger('--max-files', optionValue(argv, '--max-files')),
    concurrency: parsePositiveInteger('--concurrency', optionValue(argv, '--concurrency')),
    approvedSnapshotUuid: optionValue(argv, '--approved-snapshot'),
  };
}

export function getPackageProjectIngestUsage(): string {
  return `Usage: bun run ingest-project [options]

Options:
  --project <slug>        Explicit project identity to ingest
  --root <path>           Project root path
  --include <a,b,c>       Relative folders to ingest
  --force                 Force reprocessing of all files
  --max-files <n>         Limit processed files for a bounded run
  --concurrency <n>       Parallel ingestion limit
  --approved-snapshot <uuid>
                           Reuse a current snapshot after qualified review
  --help, -h              Show this help

Unsupported on package aliases:
  --dry-run               Not implemented for Postgres package ingest

Examples:
  bun run ingest-project --project my-project --root /path/to/project --include src,docs
  bun run ingest-project --project my-project --root /path/to/project --include src,docs --force --max-files 50
`;
}

export async function runPackageProjectIngestCli(
  argv: readonly string[] = process.argv.slice(2)
): Promise<void> {
  const args = parsePackageProjectIngestArgs(argv);
  if (args.help) {
    console.log(getPackageProjectIngestUsage());
    return;
  }

  const result = await ingestProjectRagPostgres({
    projectSlug: args.projectSlug,
    rootPath: args.rootPath,
    includeRoots: args.includeRoots,
    force: args.force,
    maxFiles: args.maxFiles,
    concurrency: args.concurrency,
    ...(args.approvedSnapshotUuid ? { approvedSnapshotUuid: args.approvedSnapshotUuid } : {}),
  });

  // Snapshot gate check — refuse if gate is missing or not CONSUMED
  const gate = result.snapshotGate;
  if (gate?.status !== 'CONSUMED') {
    if (!gate) {
      throw new Error(
        'Package ingest refused: snapshot gate is missing from ingestion result. Ingestion pipeline did not produce a gate result.'
      );
    }

    const summary = gate.preflightSummary
      ? `${gate.preflightSummary.addsCount} adds, ${gate.preflightSummary.updatesCount} updates, ${gate.preflightSummary.deletesCount} deletes`
      : 'unknown';
    const msg =
      gate.status === 'REVIEW_REQUIRED'
        ? `Package ingest refused: snapshot gate status is REVIEW_REQUIRED (UUID: ${gate.snapshotUuid}). Preflight: ${summary}. Obtain a signed qualified-review token, run review-project-rag-snapshot, then rerun with --approved-snapshot ${gate.snapshotUuid}.`
        : `Package ingest refused: snapshot gate status is ${gate.status} (UUID: ${gate.snapshotUuid}, reason: ${gate.thresholdResult}). Preflight: ${summary}.`;
    throw new Error(`${msg}${formatIngestErrors(result.stats.errors)}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  runPackageProjectIngestCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
