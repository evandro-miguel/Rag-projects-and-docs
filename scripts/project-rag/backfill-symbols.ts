/**
 * Symbol-only dry-run inspector for Project RAG Postgres.
 *
 * Reads TypeScript/JavaScript source files that are already indexed in
 * project_files, parses their AST with parseAst(), and reports how many
 * per-symbol rows WOULD be written to project_symbols — without re-chunking,
 * re-embedding, or updating content hashes.
 *
 * Fail-closed by design: any non-dry-run invocation is refused because a
 * standalone symbol writer would bypass the snapshot gate and violate
 * version-owned derived-data immutability. Gated ingest
 * (ingest_project / ingest_project_file) is the only supported writer of
 * project_symbols; this script is inspection-only.
 *
 * Usage:
 *   bun run scripts/project-rag/backfill-symbols.ts --project rag-v2-dev [--limit 100] [--offset 0] --dry-run
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkFileSecurity, redactSensitiveContent } from '../../lib/shared/project-security.js';
import { parseAst } from '../lib/ast-parser.js';
import { resolveProjectRagPostgresConfigWithLocalDefault } from './config.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
} from './store.js';

interface BackfillSymbolsArgs {
  readonly project: string;
  readonly limit: number;
  readonly offset: number;
  readonly dryRun: boolean;
}

interface BackfillSecurityBlock {
  sourcePath: string;
  reason: 'filename' | 'content' | 'path';
  pattern: string | undefined;
  details: string | undefined;
}

interface BackfillStats {
  totalIdbFiles: number;
  tsJsFiles: number;
  filesProcessed: number;
  symbolsInserted: number;
  filesSkippedBlocked: number;
  filesSkippedMissing: number;
  filesSkippedParseError: number;
  filesWithZeroSymbols: number;
  securityBlocks: Array<BackfillSecurityBlock>;
  errors: Array<{ file: string; error: string }>;
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
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseBackfillSymbolsArgs(argv: readonly string[]): BackfillSymbolsArgs {
  const project = optionValue(argv, '--project');
  if (!project) {
    throw new Error('Missing --project <slug-or-id>.');
  }
  return {
    project,
    limit: Math.min(parsePositiveInteger(optionValue(argv, '--limit'), 5000), 10000),
    offset: parsePositiveInteger(optionValue(argv, '--offset'), 0),
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
      'backfill-symbols writes to project_symbols directly, bypassing the Project RAG snapshot gate. ' +
      'Use gated ingest (ingest_project / ingest_project_file) instead. ' +
      'For dry-run inspection, pass --dry-run.'
  );
}

export async function backfillProjectRagPostgresSymbols(
  args: BackfillSymbolsArgs
): Promise<{ ok: boolean; project: { id: number; slug: string }; stats: BackfillStats }> {
  requireSnapshotGateOrDryRun(args);
  const config = resolveProjectRagPostgresConfigWithLocalDefault();
  const sql = createProjectRagPostgresSql(config);

  try {
    const project = await findProjectRagPostgresProject(sql, args.project);
    if (!project) {
      throw new Error(`Project not found in Postgres: ${args.project}`);
    }

    // Query indexed TypeScript/JavaScript files
    const langFilter = ['typescript', 'javascript'];
    const allRows = (await sql`
      select id, source_path as "sourcePath", absolute_path as "absolutePath",
        status, lang
      from project_files
      where project_id = ${project.id}
        and status = 'indexed'
        and lang in ${sql(langFilter)}
      order by source_path asc
      offset ${args.offset}
      limit ${args.limit}
    `) as Array<{
      id: number;
      sourcePath: string;
      absolutePath: string;
      status: string;
      lang: string;
    }>;

    // Also count total indexed files for reporting
    const countRows = (await sql`
      select count(*)::int as total
      from project_files
      where project_id = ${project.id}
        and status = 'indexed'
    `) as Array<{ total: number }>;

    const totalIdbFiles = countRows[0]?.total ?? 0;

    const stats: BackfillStats = {
      totalIdbFiles,
      tsJsFiles: allRows.length,
      filesProcessed: 0,
      symbolsInserted: 0,
      filesSkippedBlocked: 0,
      filesSkippedMissing: 0,
      filesSkippedParseError: 0,
      filesWithZeroSymbols: 0,
      securityBlocks: [],
      errors: [],
    };

    for (const row of allRows) {
      const sourcePath = row.sourcePath ?? '';
      const absolutePath = row.absolutePath ?? '';

      // Skip files that no longer exist on disk
      if (!absolutePath || !existsSync(absolutePath)) {
        stats.filesSkippedMissing += 1;
        continue;
      }

      // Check path-based security (file path pattern checks)
      const pathSecurity = checkFileSecurity(absolutePath, undefined, resolve(absolutePath, '..'));
      if (pathSecurity.blocked) {
        stats.filesSkippedBlocked += 1;
        stats.securityBlocks.push({
          sourcePath,
          reason: pathSecurity.reason,
          pattern: pathSecurity.pattern,
          details: pathSecurity.details,
        });
        continue;
      }

      try {
        const content = redactSensitiveContent(readFileSync(absolutePath, 'utf8')).content;
        const { symbols: parsedSymbols } = parseAst(sourcePath, content);

        if (parsedSymbols.length === 0) {
          stats.filesWithZeroSymbols += 1;
        }

        // Dry-run accounting only: the guarded entry point above guarantees
        // this function never reaches a write against project_symbols.
        stats.symbolsInserted += parsedSymbols.length;
        stats.filesProcessed += 1;
      } catch (error) {
        stats.filesSkippedParseError += 1;
        stats.errors.push({
          file: sourcePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      ok:
        stats.filesSkippedBlocked === 0 &&
        (stats.errors.length === 0 || stats.errors.length < allRows.length),
      project: { id: project.id, slug: project.slug },
      stats,
    };
  } finally {
    if (config.database.url) {
      await closeProjectRagPostgresSql(config.database.url);
    }
  }
}

async function main(): Promise<void> {
  const args = parseBackfillSymbolsArgs(process.argv.slice(2));
  const result = await backfillProjectRagPostgresSymbols(args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
