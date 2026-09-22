import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { validateProjectIncludeRoots } from '../../lib/shared/project-include-roots.js';
import { normalizeProjectRootPath } from '../../lib/shared/project-registry.js';
import { resolveProjectRagPostgresWriteConfig } from './config.js';
import { ingestProjectRagPostgres } from './ingest-postgres.js';
import { validateAllowlistAgainstRoot } from './project-inventory.js';
import {
  assertProjectRagPostgresAllowlistSchemaReady,
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
  findProjectRagPostgresProjectByRootPath,
  upsertProjectRagPostgresRepository,
} from './store.js';

export interface BlockedFindingAllowlistCliEntry {
  readonly relativePath: string;
  readonly category: string;
}

export type PackageProjectRegisterCliArgs =
  | { readonly help: true }
  | {
      readonly help?: false;
      readonly projectSlug?: string;
      readonly name?: string;
      readonly rootPath: string;
      readonly includeRoots: readonly string[];
      readonly sync: boolean;
      readonly force: boolean;
      readonly maxFiles?: number;
      readonly concurrency?: number;
      readonly approvedSnapshotUuid?: string;
      /**
       * When present, replaces the blocked-finding allowlist with the given entries.
       * Pass [] to clear. Absence preserves current DB allowlist.
       */
      readonly replaceBlockedFindingAllowlist?: readonly BlockedFindingAllowlistCliEntry[];
    };

export interface PackageProjectRegistrationResult {
  readonly projectId: number;
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
  readonly includeRoots: readonly string[];
}

export type PackageProjectRegisterResult =
  | ({
      readonly mode: 'register';
    } & PackageProjectRegistrationResult)
  | {
      readonly mode: 'sync';
      readonly registration: PackageProjectRegistrationResult;
      readonly ingestion: Awaited<ReturnType<typeof ingestProjectRagPostgres>>;
    };

type PackageProjectRegisterDeps = {
  readonly resolveProjectRagPostgresWriteConfig: typeof resolveProjectRagPostgresWriteConfig;
  readonly createProjectRagPostgresSql: typeof createProjectRagPostgresSql;
  readonly closeProjectRagPostgresSql: typeof closeProjectRagPostgresSql;
  readonly findProjectRagPostgresProject: typeof findProjectRagPostgresProject;
  readonly findProjectRagPostgresProjectByRootPath: typeof findProjectRagPostgresProjectByRootPath;
  readonly upsertProjectRagPostgresRepository: typeof upsertProjectRagPostgresRepository;
  readonly ingestProjectRagPostgres: typeof ingestProjectRagPostgres;
  readonly assertProjectRagPostgresAllowlistSchemaReady: typeof assertProjectRagPostgresAllowlistSchemaReady;
};

const DEFAULT_DEPS: PackageProjectRegisterDeps = {
  resolveProjectRagPostgresWriteConfig,
  createProjectRagPostgresSql,
  closeProjectRagPostgresSql,
  findProjectRagPostgresProject,
  findProjectRagPostgresProjectByRootPath,
  upsertProjectRagPostgresRepository,
  ingestProjectRagPostgres,
  assertProjectRagPostgresAllowlistSchemaReady,
};

const SUPPORTED_FLAGS = new Set([
  '--name',
  '--project',
  '--root',
  '--include',
  '--sync',
  '--force',
  '--max-files',
  '--concurrency',
  '--approved-snapshot',
  '--help',
  '-h',
  '--replace-blocked-finding-allowlist',
]);

const UNSUPPORTED_FLAG_MESSAGES: Record<string, string> = {
  '--add-include':
    'Postgres package register does not support incremental scope mutation flags. Re-run with --include <dir,dir> to declare the full Postgres scope.',
  '--remove-include':
    'Postgres package register does not support incremental scope mutation flags. Re-run with --include <dir,dir> to declare the full Postgres scope.',
  '--set-include':
    'Postgres package register does not support incremental scope mutation flags. Re-run with --include <dir,dir> to declare the full Postgres scope.',
  '--git-remote': 'Postgres package register does not support legacy registry metadata flags.',
  '--default-branch': 'Postgres package register does not support legacy registry metadata flags.',
  '--active-branch': 'Postgres package register does not support legacy registry metadata flags.',
  '--worktree': 'Postgres package register does not support legacy registry metadata flags.',
  '--ignore':
    'Postgres package register does not support --ignore. Use --replace-blocked-finding-allowlist to manage blocked-finding suppression.',
  '--scope-ack':
    'Postgres package register does not support legacy scope-ack flags. Use explicit --include <dir,dir> instead.',
  '--scope-reason': 'Postgres package register does not support legacy scope-reason flags.',
  '--dry-run':
    'Postgres package register does not implement --dry-run. Use the real Postgres register path or omit --sync for registry-only upsert.',
};

function hasOption(argv: readonly string[], name: string): boolean {
  const prefix = `${name}=`;
  return argv.some((arg) => arg === name || arg.startsWith(prefix));
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) {
    const next = argv[index + 1];
    return next && !next.startsWith('-') ? next : undefined;
  }

  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function requiredOptionValue(argv: readonly string[], name: string): string | undefined {
  const value = optionValue(argv, name);
  if (hasOption(argv, name) && !value) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
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

function slugifyProjectName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

function rejectUnsupportedFlags(argv: readonly string[]): void {
  for (const token of argv) {
    if (!token.startsWith('-')) {
      continue;
    }

    const normalized = token.split('=')[0] ?? token;
    if (SUPPORTED_FLAGS.has(normalized)) {
      continue;
    }

    const unsupportedMessage = UNSUPPORTED_FLAG_MESSAGES[normalized];
    if (unsupportedMessage) {
      throw new Error(unsupportedMessage);
    }

    if (normalized.startsWith('--')) {
      throw new Error(`Unknown option: ${normalized}`);
    }
  }
}

function formatIncludeRootsError(rootPath: string, includeRoots: readonly string[]): string[] {
  const validation = validateProjectIncludeRoots(rootPath, [...includeRoots]);
  if (validation.valid) {
    return validation.includeRoots;
  }

  const suggestionText =
    validation.suggestions.length > 0
      ? ` Suggested folders: ${validation.suggestions.join(', ')}`
      : '';
  throw new Error(`${validation.error}.${suggestionText}`);
}

export function parsePackageProjectRegisterArgs(
  argv: readonly string[]
): PackageProjectRegisterCliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  rejectUnsupportedFlags(argv);

  const sync = argv.includes('--sync');
  const force = argv.includes('--force');
  const maxFiles = parsePositiveInteger('--max-files', requiredOptionValue(argv, '--max-files'));
  const concurrency = parsePositiveInteger(
    '--concurrency',
    requiredOptionValue(argv, '--concurrency')
  );
  const approvedSnapshotUuid = requiredOptionValue(argv, '--approved-snapshot');

  if (
    !sync &&
    (force || maxFiles !== undefined || concurrency !== undefined || approvedSnapshotUuid)
  ) {
    throw new Error(
      'The flags --force, --max-files, --concurrency, and --approved-snapshot require --sync.'
    );
  }

  const rootPath = requiredOptionValue(argv, '--root');
  if (!rootPath) {
    throw new Error('Missing project root. Pass --root <path>.');
  }

  const includeRoots = parseIncludeRoots(requiredOptionValue(argv, '--include'));
  if (includeRoots.length === 0) {
    throw new Error(
      'Missing --include <dir,dir>. Postgres package register requires explicit include roots.'
    );
  }

  // Parse optional blocked-finding allowlist replacement
  let replaceBlockedFindingAllowlist: readonly BlockedFindingAllowlistCliEntry[] | undefined;
  const allowlistRaw = optionValue(argv, '--replace-blocked-finding-allowlist');
  if (hasOption(argv, '--replace-blocked-finding-allowlist')) {
    if (allowlistRaw === undefined) {
      throw new Error(
        '--replace-blocked-finding-allowlist requires a JSON array value. ' +
          'Example: --replace-blocked-finding-allowlist \'[{"relativePath":"vendor/dep1","category":"dependency_dir"}]\''
      );
    }
    try {
      const parsed = JSON.parse(allowlistRaw);
      if (!Array.isArray(parsed)) {
        throw new Error(
          '--replace-blocked-finding-allowlist value must be a JSON array. Got non-array.'
        );
      }
      // Reject oversize before entry-level validation
      if (parsed.length > 32) {
        throw new Error(
          `--replace-blocked-finding-allowlist has ${parsed.length} entries, max 32.`
        );
      }
      // Validate each entry shape
      for (let i = 0; i < parsed.length; i++) {
        const entry = parsed[i];
        if (typeof entry !== 'object' || entry === null) {
          throw new Error(
            `--replace-blocked-finding-allowlist entry ${i} must be an object with relativePath (string) and category (string).`
          );
        }
        const keys = Object.keys(entry).sort();
        if (keys.length !== 2 || keys[0] !== 'category' || keys[1] !== 'relativePath') {
          throw new Error(
            `--replace-blocked-finding-allowlist entry ${i} has unexpected keys. Only relativePath and category are allowed.`
          );
        }
        if (typeof entry.relativePath !== 'string' || typeof entry.category !== 'string') {
          throw new Error(
            `--replace-blocked-finding-allowlist entry ${i} must be an object with relativePath (string) and category (string).`
          );
        }
      }
      replaceBlockedFindingAllowlist = parsed as BlockedFindingAllowlistCliEntry[];
    } catch (parseError) {
      if (parseError instanceof SyntaxError) {
        throw new Error(
          `--replace-blocked-finding-allowlist value is not valid JSON: ${parseError.message}`
        );
      }
      throw parseError;
    }
  }

  const projectSlug = requiredOptionValue(argv, '--project');
  if (!projectSlug) {
    throw new Error('Missing project identity. Pass --project <slug>.');
  }

  return {
    projectSlug: slugifyProjectName(projectSlug),
    name: requiredOptionValue(argv, '--name'),
    rootPath: resolve(rootPath),
    includeRoots,
    sync,
    force,
    maxFiles,
    concurrency,
    approvedSnapshotUuid,
    replaceBlockedFindingAllowlist,
  };
}

export function getPackageProjectRegisterUsage(): string {
  return `Usage: bun run register-project [options]

Without --sync, this only upserts project_repositories in Postgres.
With --sync, it registers first and then runs Postgres ingestion for the same scope.

Options:
  --project <slug>                           Explicit project identity to register
  --root <path>                              Project root path
  --include <a,b,c>                          Relative folders to register
  --name <value>                             Optional display name to persist on the repository row
  --sync                                     Register and ingest through the Postgres path
  --force                                    Requires --sync; force reprocessing of all files
  --max-files <n>                            Requires --sync; limit processed files for a bounded run
  --concurrency <n>                          Requires --sync; parallel ingestion limit
  --approved-snapshot <uuid>                 Requires --sync; reuse a qualified-reviewed snapshot
  --replace-blocked-finding-allowlist <json> Replace blocked-finding allowlist with JSON array.
                                             Use '[]' to clear. Rejects invalid JSON/non-array.
                                             Example: '[{"relativePath":"vendor/dep1","category":"dependency_dir"}]'
  --help, -h                                 Show this help

Unsupported on this package alias:
  --add-include           Incremental scope mutation flags are not supported
  --remove-include        Incremental scope mutation flags are not supported
  --set-include           Incremental scope mutation flags are not supported
  --git-remote            Legacy registry metadata flags are not supported
  --default-branch        Legacy registry metadata flags are not supported
  --active-branch         Legacy registry metadata flags are not supported
  --worktree              Legacy registry metadata flags are not supported
  --ignore                Use --replace-blocked-finding-allowlist instead
  --scope-ack             Legacy scope ack flags are not supported
  --scope-reason          Legacy scope reason flags are not supported
  --dry-run               Not implemented

Examples:
  bun run register-project --project my-project --root /path/to/project --include src,docs
  bun run register-project --project my-project --root /path/to/project --include src,docs --sync
  bun run register-project --project my-project --root /path/to/project --include src --name "My Project" --sync --max-files 25
  bun run register-project --project my-project --root /path/to/project --include src \\
    --replace-blocked-finding-allowlist '[{"relativePath":"vendor/dep1","category":"dependency_dir"}]'
`;
}

export async function registerPackageProject(
  args: Exclude<PackageProjectRegisterCliArgs, { readonly help: true }>,
  deps: PackageProjectRegisterDeps = DEFAULT_DEPS
): Promise<PackageProjectRegisterResult> {
  const rootPath = realpathSync.native(resolve(args.rootPath));
  normalizeProjectRootPath(rootPath);
  const includeRoots = formatIncludeRootsError(rootPath, args.includeRoots);
  const config = deps.resolveProjectRagPostgresWriteConfig();
  const sql = deps.createProjectRagPostgresSql(config);
  try {
    // Identity follows the registered root path, never a basename guess: an
    // explicit --project slug still wins, but an implicit registration must
    // reuse the project already registered at this root instead of forking a
    // basename-derived duplicate.
    const existingByRoot = await deps.findProjectRagPostgresProjectByRootPath(sql, rootPath);
    const slug = args.projectSlug ?? existingByRoot?.slug ?? slugifyProjectName(basename(rootPath));
    const existing = await deps.findProjectRagPostgresProject(sql, slug);
    const name = args.name?.trim() || existing?.name || basename(rootPath);

    // Migration-004 schema readiness MUST be checked before every upsert
    // because the upsert SQL always references blocked_finding_allowlist.
    try {
      await deps.assertProjectRagPostgresAllowlistSchemaReady(sql);
    } catch (schemaError) {
      const msg = schemaError instanceof Error ? schemaError.message : String(schemaError);
      throw new Error(
        `Project RAG schema is not ready for blocked-finding allowlist (migration 004). ${msg}`
      );
    }

    // Root identity enforcement — reject if existing project has a different root.
    // This prevents silently moving an existing registration to a new filesystem
    // location or changing the canonical root path.
    if (existing) {
      const existingRoot = existing.normalizedRootPath || existing.rootPath;
      if (existingRoot !== rootPath) {
        throw new Error(
          `PROJECT_ROOT_MISMATCH: Project "${slug}" is already registered at "${existingRoot}". ` +
            `Requested root "${rootPath}" differs. Re-registering an existing project under a ` +
            `different root path is not allowed.`
        );
      }
    }

    // Preserve existing includeRoots/ignoreRules when project already exists.
    // This prevents accidental scope reduction on re-registration and matches
    // the MCP handler's preserve-scope semantics.
    const preserveExistingScope = !!existing;
    const registeredIncludeRoots =
      preserveExistingScope && existing?.includeRoots?.length
        ? existing.includeRoots
        : includeRoots;
    const registeredIgnoreRules = preserveExistingScope ? existing?.ignoreRules : undefined;

    // Handle blocked-finding allowlist replacement.
    // When replacing, validate against the includeRoots that WILL be persisted
    // (preserved roots for existing projects, request roots for new).
    const allowlistExplicitlySupplied = args.replaceBlockedFindingAllowlist !== undefined;
    let upsertAllowlist:
      | readonly { readonly relativePath: string; readonly category: string }[]
      | undefined;
    const allowlistEntries = args.replaceBlockedFindingAllowlist;
    if (allowlistExplicitlySupplied) {
      validateAllowlistAgainstRoot(
        rootPath,
        registeredIncludeRoots,
        (allowlistEntries ?? []) as readonly {
          relativePath: string;
          category: string;
        }[]
      );

      upsertAllowlist = (allowlistEntries ?? []) as readonly {
        readonly relativePath: string;
        readonly category: string;
      }[];
    }

    // Atomic upsert with last-writer semantics.
    // Concurrent registration is protected by the DB trigger blocking
    // config mutations while a CONSUMING snapshot exists.
    let projectId: number;
    try {
      projectId = await deps.upsertProjectRagPostgresRepository(sql, {
        name,
        slug,
        rootPath,
        normalizedRootPath: rootPath,
        status: 'active',
        syncMode: 'full',
        includeRoots: registeredIncludeRoots,
        ...(registeredIgnoreRules !== undefined ? { ignoreRules: registeredIgnoreRules } : {}),
        ...(upsertAllowlist !== undefined ? { blockedFindingAllowlist: upsertAllowlist } : {}),
        metadata: {
          backend: 'postgres',
          registeredBy: 'project-rag-postgres-register',
        },
      });
    } catch (upsertError) {
      const msg = upsertError instanceof Error ? upsertError.message : String(upsertError);
      if (msg.includes('CONSUMING') || msg.includes('consuming ingest snapshot')) {
        throw new Error(
          'Project configuration is locked because an active ingest is in progress. ' +
            'Retry after the current ingest completes.'
        );
      }
      throw upsertError;
    }

    const registration: PackageProjectRegistrationResult = {
      projectId,
      slug,
      name,
      rootPath,
      includeRoots: registeredIncludeRoots,
    };

    if (!args.sync) {
      return {
        mode: 'register',
        ...registration,
      };
    }

    const ingestion = await deps.ingestProjectRagPostgres({
      projectSlug: slug,
      rootPath,
      includeRoots: registeredIncludeRoots,
      force: args.force,
      maxFiles: args.maxFiles,
      concurrency: args.concurrency,
      ...(args.approvedSnapshotUuid ? { approvedSnapshotUuid: args.approvedSnapshotUuid } : {}),
    });

    // Snapshot gate check — refuse if gate is missing or not CONSUMED
    const gate = ingestion.snapshotGate;
    if (gate?.status !== 'CONSUMED') {
      if (!gate) {
        throw new Error(
          'Package register --sync refused: snapshot gate is missing from ingestion result. Ingestion pipeline did not produce a gate result.'
        );
      }

      const summary = gate.preflightSummary
        ? `${gate.preflightSummary.addsCount} adds, ${gate.preflightSummary.updatesCount} updates, ${gate.preflightSummary.deletesCount} deletes`
        : 'unknown';
      const msg =
        gate.status === 'REVIEW_REQUIRED'
          ? `Package register --sync refused: snapshot gate status is REVIEW_REQUIRED (UUID: ${gate.snapshotUuid}). Preflight: ${summary}. Obtain a signed qualified-review token, run review-project-rag-snapshot, then rerun sync with --approved-snapshot ${gate.snapshotUuid}.`
          : `Package register --sync refused: snapshot gate status is ${gate.status} (UUID: ${gate.snapshotUuid}, reason: ${gate.thresholdResult}). Preflight: ${summary}.`;
      throw new Error(msg);
    }

    return {
      mode: 'sync',
      registration,
      ingestion,
    };
  } finally {
    if (config.database.url) {
      await deps.closeProjectRagPostgresSql(config.database.url);
    }
  }
}

export async function runPackageProjectRegisterCli(
  argv: readonly string[] = process.argv.slice(2)
): Promise<void> {
  const args = parsePackageProjectRegisterArgs(argv);
  if (args.help) {
    console.log(getPackageProjectRegisterUsage());
    return;
  }

  const result = await registerPackageProject(args);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  runPackageProjectRegisterCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
