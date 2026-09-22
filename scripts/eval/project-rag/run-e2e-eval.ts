/**
 * @module scripts/eval/project-rag/run-e2e-eval.ts
 * @description End-to-end Project RAG evaluation runner
 *
 * == SNAPSHOT GATE EXEMPTION ==
 * This eval runner writes directly to Project RAG Postgres tables via store.ts
 * functions, bypassing the snapshot gate (SPEC-007 §8).  This is intentional:
 * the runner operates on isolated ephemeral project registrations
 * (ephemeral: true, owner: "project-rag-eval:*") for benchmark/eval purposes
 * only.  It is NOT a production mutation path and MUST NOT be used for
 * production ingestion.  Production writers must route through the gated
 * ingest in ingest-postgres.ts / MCP handlers.
 *
 * Usage:
 *   bun run scripts/eval/project-rag/run-e2e-eval.ts
 *   bun run scripts/eval/project-rag/run-e2e-eval.ts --fixture fixture-ts-service
 *   bun run scripts/eval/project-rag/run-e2e-eval.ts --write-capture /tmp/project-capture.json
 */

import '../../lib/runtime-env.js';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { chunkTextWithContextProfile } from '../../../lib/ingest/chunker.js';
import { suggestProjectIncludeRoots } from '../../../lib/shared/project-include-roots.js';
import { canUseHybridKeywordFastPath } from '../../../lib/shared/project-search-query-heuristics.js';
import { chunkAST } from '../../ingest/parse-symbols.js';
import { resolveProjectRagPostgresWriteConfig } from '../../project-rag/config.js';
import {
  fetchProjectRagPostgresEmbeddings,
  resolveProjectRagPostgresEmbeddingConfig,
} from '../../project-rag/embeddings.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  deleteStaleProjectRagPostgresFiles,
  listProjectRagPostgresChunkEmbeddingCandidates,
  publishProjectRagPostgresIndexBuild,
  repairProjectRagPostgresFileVersions,
  searchProjectRagPostgresChunks,
  upsertProjectRagPostgresChunkEmbedding1024,
  upsertProjectRagPostgresFileWithChunks,
  upsertProjectRagPostgresRepository,
} from '../../project-rag/store.js';
import { buildProjectEvalIsolationRegistrationArgs, PROJECT_RAG_FIXTURES } from './fixtures.js';
import { buildProjectEvalReport } from './run-project-rag-eval.js';
import type {
  ProjectEvalCapturedRun,
  ProjectEvalForbiddenTarget,
  ProjectEvalRetrievedResult,
  ProjectEvalScenario,
  ProjectEvalTarget,
} from './types.js';

type ProjectRagEvalSql = ReturnType<typeof createProjectRagPostgresSql>;
type ProjectRagEvalEmbeddingConfig = ReturnType<typeof resolveProjectRagPostgresEmbeddingConfig>;

async function cleanupProjectStage(
  sql: ProjectRagEvalSql,
  projectId: number,
  sourcePathsToKeep: string[]
) {
  const deletedCount = await deleteStaleProjectRagPostgresFiles(sql, projectId, sourcePathsToKeep);
  return { deletedCount };
}

async function cleanupProjectRegistryArtifacts(sql: ProjectRagEvalSql, projectId: number) {
  // Build files retain RESTRICT references to their file/version rows. Remove
  // the isolated eval publication surface before deleting derived rows and
  // the ephemeral registry entry; otherwise a failed eval can leave its
  // project undeletable and leak fixture data into later runs.
  await sql`delete from project_index_build_files where project_id = ${projectId}`;
  await sql`delete from project_index_builds where project_id = ${projectId}`;
  await sql`delete from project_embeddings_1024 where project_id = ${projectId}`;
  await sql`delete from project_edges where project_id = ${projectId}`;
  await sql`delete from project_symbols where project_id = ${projectId}`;
  await sql`delete from project_chunks where project_id = ${projectId}`;
  await sql`delete from project_sync_runs where project_id = ${projectId}`;
  await sql`delete from project_files where project_id = ${projectId}`;
  await sql`delete from project_repositories where id = ${projectId}`;
}

interface EvalResult {
  fixtureId: string;
  passed: boolean;
  metrics: {
    hitRate: number;
    exactPathRate: number;
    exactSymbolRate: number;
    avgQualityScore: number;
    contaminationRate: number;
    latencyP95Ms: number;
    endToEndLatencyP95Ms?: number;
    embeddingLatencyP95Ms?: number;
  };
  thresholdFailures: string[];
}

export function parseArgs(args: string[]) {
  return {
    fixtureId: args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : undefined,
    variant: args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 'project-hybrid',
    json: args.includes('--json'),
    writePath: args.includes('--write') ? args[args.indexOf('--write') + 1] : undefined,
    captureWritePath: args.includes('--write-capture')
      ? args[args.indexOf('--write-capture') + 1]
      : undefined,
    verbose: args.includes('--verbose') || args.includes('-v'),
    repoSubdir: args.includes('--repo-subdir')
      ? args[args.indexOf('--repo-subdir') + 1]
      : undefined,
  };
}

type EvalSearchMode = ReturnType<typeof resolveEvalSearchMode>;

/**
 * Resolve private evaluation variants. `keyword` intentionally selects the
 * direct lexical SQL baseline; it is not a public Project RAG search mode.
 */
export function resolveEvalSearchMode(variant: string): 'keyword' | 'hybrid' | 'vector' {
  if (variant.includes('keyword')) {
    return 'keyword';
  }

  if (variant.includes('vector')) {
    return 'vector';
  }

  return 'hybrid';
}

function sanitizeEvalProjectSlugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function buildEvalProjectSlug(baseRepoRoot: string, fixtureId: string, variant: string): string {
  const baseSlug = sanitizeEvalProjectSlugSegment(basename(baseRepoRoot)) || 'project';
  const fixtureSlug = sanitizeEvalProjectSlugSegment(fixtureId) || 'fixture';
  const variantSlug = sanitizeEvalProjectSlugSegment(variant) || 'variant';
  const runSuffix = `${process.pid}-${Date.now().toString(36)}`;
  return `${baseSlug}-${fixtureSlug}-${variantSlug}-${runSuffix}`;
}

function buildEvalProjectNormalizedRootPath(baseRepoRoot: string, projectSlug: string): string {
  // ponytail: synthetic normalized roots avoid same-fixture eval collisions; reads stay on baseRepoRoot.
  return `${baseRepoRoot}#eval-${projectSlug}`;
}

async function getAllFiles(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getAllFiles(fullPath, baseDir)));
    } else if (entry.isFile()) {
      files.push(relative(baseDir, fullPath));
    }
  }

  return files;
}

function normalizeEvalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function evalPathsMatch(resultPath: string, expectedPath: string): boolean {
  const normalizedResult = normalizeEvalPath(resultPath);
  const normalizedExpected = normalizeEvalPath(expectedPath);
  return (
    normalizedResult === normalizedExpected || normalizedResult.endsWith(`/${normalizedExpected}`)
  );
}

function readinessTargetMatches(
  result: ProjectEvalRetrievedResult,
  target: ProjectEvalTarget
): boolean {
  if (!evalPathsMatch(result.path, target.path)) return false;
  if (target.symbolName && result.symbolName !== target.symbolName) return false;
  if (target.symbolKind && result.symbolKind !== target.symbolKind) return false;
  return true;
}

function readinessForbiddenMatches(
  result: ProjectEvalRetrievedResult,
  target: ProjectEvalForbiddenTarget
): boolean {
  if (!evalPathsMatch(result.path, target.path)) return false;
  if (target.symbolName && result.symbolName !== target.symbolName) return false;
  return true;
}

function mapRetrievedResults(searchResults: any[]): ProjectEvalRetrievedResult[] {
  return searchResults.map((r: any) => ({
    path: r.sourcePath,
    symbolName: r.symbolName,
    symbolKind: r.symbolKind,
    startLine: r.startLine,
    endLine: r.endLine,
  }));
}

function mapPostgresSearchRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => ({
    sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : '',
    chunkIndex: typeof row.chunkIndex === 'number' ? row.chunkIndex : Number(row.chunkIndex ?? 0),
    startLine:
      typeof row.startLine === 'number'
        ? row.startLine
        : row.startLine === null || row.startLine === undefined
          ? undefined
          : Number(row.startLine),
    endLine:
      typeof row.endLine === 'number'
        ? row.endLine
        : row.endLine === null || row.endLine === undefined
          ? undefined
          : Number(row.endLine),
    content: typeof row.content === 'string' ? row.content : '',
    symbolName: typeof row.symbolName === 'string' ? row.symbolName : undefined,
    symbolKind: typeof row.symbolKind === 'string' ? row.symbolKind : undefined,
    score: typeof row.score === 'number' ? row.score : Number(row.score ?? 0),
    vectorScore:
      typeof row.vectorScore === 'number' ? row.vectorScore : Number(row.vectorScore ?? 0),
  }));
}

async function searchProjectRagPostgresKeywordChunks(
  sql: ProjectRagEvalSql,
  projectId: number,
  query: string,
  limit: number
) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error('Search query is required.');
  }

  const rows = (await sql`
    with query as (
      select
        websearch_to_tsquery('simple', ${normalizedQuery}) as tsq,
        lower(unaccent(${normalizedQuery})) as textq,
        regexp_split_to_array(lower(unaccent(${normalizedQuery})), '[^a-z0-9_./-]+') as terms
    )
    select
      bf.source_path as "sourcePath",
      c.chunk_index as "chunkIndex",
      c.start_line as "startLine",
      c.end_line as "endLine",
      c.content,
      c.symbol_name as "symbolName",
      c.symbol_kind as "symbolKind",
      0::float8 as "vectorScore",
      (
        ts_rank_cd(c.search_vector, query.tsq) * 10
        + similarity(c.search_text_normalized, query.textq)
        + similarity(lower(unaccent(bf.source_path)), query.textq)
        + match_stats.term_hits::float8 * 0.25
      )::float8 as score
    from project_chunks c
    join project_index_builds b
      on b.project_id = c.project_id and b.status = 'published'
    join project_index_build_files bf
      on bf.build_id = b.id
      and bf.project_id = c.project_id
      and bf.file_id = c.file_id
      and bf.version_id = c.version_id
    cross join query
    cross join lateral (
      select count(*) as term_hits
      from unnest(query.terms) term
      where length(term) >= 3
        and (
          c.search_text_normalized like ('%' || term || '%')
          or lower(unaccent(bf.source_path)) like ('%' || term || '%')
        )
    ) match_stats
    where c.project_id = ${projectId}
      and c.enabled = true
      and (
        ts_rank_cd(c.search_vector, query.tsq) > 0
        or match_stats.term_hits > 0
        or similarity(c.search_text_normalized, query.textq) > 0
        or similarity(lower(unaccent(bf.source_path)), query.textq) > 0
      )
    order by score desc, bf.source_path asc, c.chunk_index asc
    limit ${Math.min(Math.max(limit, 1), 50)}
  `) as Array<Record<string, unknown>>;

  return mapPostgresSearchRows(rows);
}

async function waitForScenarioReadiness(
  sql: ProjectRagEvalSql,
  embeddingConfig: ProjectRagEvalEmbeddingConfig,
  projectId: number,
  scenario: ProjectEvalScenario,
  searchMode: EvalSearchMode,
  verbose: boolean
): Promise<string[]> {
  if (scenario.expectedTargets.length === 0) {
    return [];
  }

  const warnings: string[] = [];
  const backoffMs = [0, 150, 250, 400, 600, 900];
  const readinessMode =
    searchMode === 'hybrid' && canUseHybridKeywordFastPath(scenario.query) ? 'keyword' : searchMode;

  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (attempt > 0) {
      await Bun.sleep(backoffMs[attempt]);
    }

    const searchResults =
      readinessMode === 'keyword'
        ? await searchProjectRagPostgresKeywordChunks(sql, projectId, scenario.query, 10)
        : await (async () => {
            const [queryEmbedding] = await fetchProjectRagPostgresEmbeddings(embeddingConfig, [
              `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${scenario.query}`,
            ]);
            return await searchProjectRagPostgresChunks(sql, projectId, {
              query: scenario.query,
              queryEmbedding,
              embeddingModel: embeddingConfig.model,
              embeddingProvider: embeddingConfig.provider,
              embeddingDimensions: embeddingConfig.dimensions,
              embeddingProfileHash: embeddingConfig.profileHash,
              limit: 10,
            });
          })();

    const results = mapRetrievedResults(searchResults);
    const hasExpected = scenario.expectedTargets.some((target) =>
      results.some((result) => readinessTargetMatches(result, target))
    );
    const hasForbidden = (scenario.forbiddenTargets ?? []).some((target) =>
      results.some((result) => readinessForbiddenMatches(result, target))
    );

    if (hasExpected && !hasForbidden) {
      if (verbose && attempt > 0) {
        console.log(`        Readiness converged for ${scenario.id} after ${attempt + 1} attempts`);
      }
      return warnings;
    }
  }

  warnings.push(
    `Readiness probe timed out for ${scenario.id}; measured search may still include post-ingest contention`
  );
  if (verbose) {
    console.log(`        Warning: ${warnings[0]}`);
  }
  return warnings;
}

async function executeMeasuredScenarioSearch(args: {
  sql: ProjectRagEvalSql;
  embeddingConfig: ProjectRagEvalEmbeddingConfig;
  projectId: number;
  scenario: ProjectEvalScenario;
  searchMode: EvalSearchMode;
}): Promise<{
  searchResults: any[];
  latencyMs: number;
  embeddingLatencyMs: number;
  warnings: string[];
}> {
  const { sql, embeddingConfig, projectId, scenario, searchMode } = args;

  if (searchMode === 'keyword') {
    const searchStartTime = Date.now();
    const searchResults = await searchProjectRagPostgresKeywordChunks(
      sql,
      projectId,
      scenario.query,
      10
    );
    return {
      searchResults,
      latencyMs: Date.now() - searchStartTime,
      embeddingLatencyMs: 0,
      warnings: [],
    };
  }

  if (searchMode === 'hybrid' && canUseHybridKeywordFastPath(scenario.query)) {
    let latencyMs = 0;
    const keywordStartTime = Date.now();
    const keywordResults = await searchProjectRagPostgresKeywordChunks(
      sql,
      projectId,
      scenario.query,
      10
    );
    latencyMs += Date.now() - keywordStartTime;

    if (keywordResults.length > 0) {
      return {
        searchResults: keywordResults,
        latencyMs,
        embeddingLatencyMs: 0,
        warnings: [],
      };
    }

    const warnings = [
      `Hybrid keyword fast path returned no results for ${scenario.id}; retried with semantic lane`,
    ];
    const embeddingStartTime = Date.now();
    const [embedding] = await fetchProjectRagPostgresEmbeddings(embeddingConfig, [
      `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${scenario.query}`,
    ]);
    const embeddingLatencyMs = Date.now() - embeddingStartTime;
    const searchStartTime = Date.now();
    const searchResults = await searchProjectRagPostgresChunks(sql, projectId, {
      query: scenario.query,
      queryEmbedding: embedding,
      embeddingModel: embeddingConfig.model,
      embeddingProvider: embeddingConfig.provider,
      embeddingDimensions: embeddingConfig.dimensions,
      embeddingProfileHash: embeddingConfig.profileHash,
      limit: 10,
    });
    latencyMs += Date.now() - searchStartTime;

    return {
      searchResults,
      latencyMs,
      embeddingLatencyMs,
      warnings,
    };
  }

  const warnings =
    searchMode === 'vector'
      ? ['PROJECT_RAG_BACKEND=postgres uses hybrid vector+lexical search for vector requests.']
      : [];
  const embeddingStartTime = Date.now();
  const [embedding] = await fetchProjectRagPostgresEmbeddings(embeddingConfig, [
    `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${scenario.query}`,
  ]);
  const embeddingLatencyMs = Date.now() - embeddingStartTime;
  const searchStartTime = Date.now();
  const searchResults = await searchProjectRagPostgresChunks(sql, projectId, {
    query: scenario.query,
    queryEmbedding: embedding,
    embeddingModel: embeddingConfig.model,
    embeddingProvider: embeddingConfig.provider,
    embeddingDimensions: embeddingConfig.dimensions,
    embeddingProfileHash: embeddingConfig.profileHash,
    limit: 10,
  });

  return {
    searchResults,
    latencyMs: Date.now() - searchStartTime,
    embeddingLatencyMs,
    warnings,
  };
}

async function runE2EEvaluation(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveProjectRagPostgresWriteConfig();
  const embeddingConfig = resolveProjectRagPostgresEmbeddingConfig();
  const sql = createProjectRagPostgresSql(config);

  const fixtures = args.fixtureId
    ? PROJECT_RAG_FIXTURES.filter((f) => f.id === args.fixtureId)
    : PROJECT_RAG_FIXTURES;

  if (fixtures.length === 0) {
    console.error(`No fixtures found for: ${args.fixtureId}`);
    process.exitCode = 1;
    return;
  }

  console.log('Project RAG E2E Evaluation');
  console.log('==========================\n');

  const allCaptures: ProjectEvalCapturedRun[] = [];
  const _results: EvalResult[] = [];
  const fixtureFailures: string[] = [];

  try {
    for (const fixture of fixtures) {
      console.log(`\nFixture: ${fixture.id}`);
      console.log(`  Repo: ${fixture.repoRoot}`);

      // P2-T06: Support repoSubdir for branch-drift style fixtures
      // Note: branch-drift fixture uses repoType: 'branch_drift' which handles snapshots differently
      // The fixture config already knows which snapshot (v1 or v2) to use for expected targets
      // We only need to support explicit --repo-subdir for manual testing
      const baseRepoRoot = resolve(fixture.repoRoot);
      const repoSubdirs = args.repoSubdir
        ? [args.repoSubdir]
        : fixture.repoType === 'branch_drift'
          ? Array.from(
              new Set(
                fixture.dbActions
                  .map((action) => action.repoSubdir)
                  .filter((repoSubdir): repoSubdir is string => Boolean(repoSubdir))
              )
            )
          : [undefined];
      if (args.repoSubdir) {
        console.log(`  Subdir: ${args.repoSubdir}`);
      }

      // Step 1: Register project
      console.log('  [1/4] Registering project...');
      let projectId: number;
      try {
        const projectSlug = buildEvalProjectSlug(baseRepoRoot, fixture.id, args.variant);
        const normalizedRootPath = buildEvalProjectNormalizedRootPath(baseRepoRoot, projectSlug);
        const includeRoots = suggestProjectIncludeRoots(baseRepoRoot);
        const registration = buildProjectEvalIsolationRegistrationArgs({
          name: fixture.title,
          rootPath: baseRepoRoot,
          includeRoots: includeRoots.length > 0 ? includeRoots : ['src'],
          origin: 'benchmark',
          owner: `project-rag-eval:${fixture.id}:${args.variant}:${process.pid}`,
        });
        projectId = await upsertProjectRagPostgresRepository(sql, {
          name: registration.name,
          slug: projectSlug,
          rootPath: registration.rootPath,
          normalizedRootPath,
          status: 'active',
          syncMode: registration.syncMode ?? 'full',
          includeRoots: registration.includeRoots,
          ephemeral: registration.ephemeral,
          metadata: {
            backend: 'postgres',
            origin: registration.origin,
            owner: registration.owner,
            expiresAt: registration.expiresAt,
            lastUsedAt: registration.lastUsedAt,
            evalProjectSlug: projectSlug,
          },
        });
        console.log(`        Registered: ${projectId} (${projectSlug})`);
      } catch (e) {
        console.error(`        Failed to register: ${e}`);
        fixtureFailures.push(`${fixture.id}: registration failed`);
        continue;
      }

      // Step 2: Ingest files with proper AST parsing
      console.log('  [2/4] Ingesting files with AST parsing...');
      try {
        let ingested = 0;
        let skipped = 0;
        let symbolsExtracted = 0;
        const sourcePathsToKeep: string[] = [];
        let finalStageSourcePathsToKeep: string[] = [];
        const ingestErrors: string[] = [];

        for (const repoSubdir of repoSubdirs) {
          const activeRepoRoot = repoSubdir
            ? resolve(join(fixture.repoRoot, repoSubdir))
            : baseRepoRoot;
          const files = await getAllFiles(activeRepoRoot, baseRepoRoot);
          const stageSourcePathsToKeep: string[] = [];

          if (repoSubdir && repoSubdirs.length > 1) {
            console.log(`        Stage: ${repoSubdir}`);
          }

          for (const file of files) {
            const fullPath = join(baseRepoRoot, file);
            const content = readFileSync(fullPath, 'utf-8');
            const stats = statSync(fullPath);
            const title = basename(file);

            // Skip blocked files based on fixture's inventory blockedPaths
            // This mirrors production blocking for .env, keys, generated files
            const blockedPaths = fixture.inventory?.blockedPaths ?? [];
            const isBlocked =
              file.startsWith('.env') ||
              file.startsWith('keys/') ||
              file.startsWith('dist/') ||
              file.includes('.min.') ||
              blockedPaths.some((blocked) => file === blocked || file.endsWith(blocked));

            if (isBlocked) {
              skipped++;
              if (args.verbose) {
                console.log(`        Blocked: ${file}`);
              }
              continue;
            }

            try {
              // Build chunks with proper AST parsing for code files
              let chunks: Array<{
                content: string;
                searchableText: string;
                startLine?: number;
                endLine?: number;
                symbolName?: string;
                symbolKind?: string;
              }>;

              // Use AST-based chunking for TypeScript/JavaScript files
              if (file.match(/\.(ts|tsx|js|jsx)$/)) {
                const ext = file.substring(file.lastIndexOf('.'));
                const astChunks = await chunkAST(content, ext, 500, 50);

                chunks = astChunks.map((c) => {
                  const chunkContent = c.symbol
                    ? `[${c.symbol.kind}: ${c.symbol.name}]\n${c.content}`
                    : c.content;
                  if (c.symbol) symbolsExtracted++;
                  // Build searchable text with path and key terms
                  const parts = [title, file];
                  if (c.symbol) {
                    parts.push(c.symbol.kind, c.symbol.name);
                    // Add extracted identifier words from symbol name (split CamelCase)
                    const symbolWords = c.symbol.name
                      .replace(/([^A-Z])([A-Z])/g, '$1 $2') // split CamelCase
                      .toLowerCase()
                      .split(/\s+/)
                      .filter((w) => w.length > 1);
                    parts.push(...symbolWords);
                  }
                  // Also add key content words (filter out very common words)
                  const contentWords = chunkContent
                    .toLowerCase()
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .split(/\s+/)
                    .filter(
                      (w) =>
                        w.length > 3 &&
                        ![
                          'this',
                          'that',
                          'with',
                          'from',
                          'have',
                          'been',
                          'were',
                          'they',
                          'their',
                        ].includes(w)
                    );
                  parts.push(...contentWords.slice(0, 20)); // Limit to 20 words to avoid noise

                  const searchableText = parts.join(' ');
                  return {
                    content: chunkContent,
                    searchableText,
                    startLine: c.symbol?.startLine,
                    endLine: c.symbol?.endLine,
                    symbolName: c.symbol?.name,
                    symbolKind: c.symbol?.kind,
                  };
                });
              } else {
                // Use semantic chunking for other files (markdown, Python, Go, etc.)
                // Track line ranges properly for each chunk
                const lines = content.split('\n');
                const textChunks = await chunkTextWithContextProfile(
                  content,
                  { title, sourcePath: file },
                  { chunkSize: 500, chunkOverlap: 50 }
                );

                // Calculate cumulative character offsets to determine line ranges
                let currentOffset = 0;
                chunks = textChunks.map((c) => {
                  const chunkStartOffset = content.indexOf(c.content, currentOffset);
                  const chunkEndOffset = chunkStartOffset + c.content.length;

                  // Find start line (1-indexed)
                  let startLine = 1;
                  let charCount = 0;
                  for (let i = 0; i < lines.length; i++) {
                    charCount += lines[i].length + 1; // +1 for newline
                    if (charCount > chunkStartOffset) {
                      startLine = i + 1;
                      break;
                    }
                  }

                  // Find end line
                  let endLine = lines.length;
                  charCount = 0;
                  for (let i = 0; i < lines.length; i++) {
                    charCount += lines[i].length + 1;
                    if (charCount >= chunkEndOffset) {
                      endLine = i + 1;
                      break;
                    }
                  }

                  currentOffset = chunkStartOffset + c.content.length;

                  return {
                    content: c.content,
                    searchableText: c.searchableText,
                    startLine,
                    endLine,
                  };
                });
              }

              // Version-owned write path: keep the candidate pending until its
              // embeddings pass the same integrity checks as production.
              const { fileId, versionId: candidateVersionId } =
                await upsertProjectRagPostgresFileWithChunks(
                  sql,
                  projectId,
                  {
                    sourcePath: file,
                    absolutePath: fullPath,
                    contentHash: `${stats.size}-${stats.mtimeMs}`,
                    fileModifiedAt: Math.floor(stats.mtimeMs),
                    lang: file.endsWith('.ts')
                      ? 'ts'
                      : file.endsWith('.tsx')
                        ? 'tsx'
                        : file.endsWith('.md')
                          ? 'md'
                          : undefined,
                    sizeBytes: stats.size,
                    status: 'indexed',
                    metadataQuality: 'minimal',
                    metadata: { backend: 'postgres' },
                  },
                  chunks.map((chunk, index) => ({
                    chunkIndex: index,
                    content: chunk.content,
                    searchableText: chunk.searchableText,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    symbolName: chunk.symbolName,
                    symbolKind: chunk.symbolKind,
                    metadata: { backend: 'postgres' },
                  })),
                  'pending'
                );
              if (!fileId)
                throw new Error(`Project RAG fixture upsert returned no file id: ${file}`);
              if (!candidateVersionId)
                throw new Error(`Project RAG fixture upsert returned no version id: ${file}`);
              ingested++;
              sourcePathsToKeep.push(file);
              stageSourcePathsToKeep.push(file);

              if (args.verbose) {
                console.log(
                  `        Ingested: ${file} (${chunks.length} chunks, ${chunks.filter((c) => c.symbolName).length} symbols)`
                );
              }
            } catch (e: any) {
              if (e.message?.includes('blocked')) {
                skipped++;
                if (args.verbose) {
                  console.log(`        Blocked: ${file}`);
                }
              } else {
                const message = e instanceof Error ? e.message : String(e);
                ingestErrors.push(`${file}: ${message}`);
                console.error(`        Error ingesting ${file}: ${message}`);
              }
            }
          }

          if (fixture.repoType === 'branch_drift') {
            const { deletedCount } = await cleanupProjectStage(
              sql,
              projectId,
              stageSourcePathsToKeep
            );
            if (deletedCount > 0) {
              console.log(
                `        Deleted ${deletedCount} stale files after ${repoSubdir ?? 'stage'}`
              );
            }
          }
          finalStageSourcePathsToKeep = stageSourcePathsToKeep;
        }

        if (ingestErrors.length > 0) {
          throw new Error(`file ingestion errors: ${ingestErrors.join('; ')}`);
        }

        const promotionSourcePaths =
          fixture.repoType === 'branch_drift' ? finalStageSourcePathsToKeep : sourcePathsToKeep;
        const embeddingCandidates = await listProjectRagPostgresChunkEmbeddingCandidates(
          sql,
          projectId,
          {
            embeddingModel: embeddingConfig.model,
            embeddingProfileHash: embeddingConfig.profileHash,
            sourcePaths: promotionSourcePaths,
            limit: 1000,
          }
        );
        if (embeddingCandidates.length > 0) {
          const embeddings = await fetchProjectRagPostgresEmbeddings(
            embeddingConfig,
            embeddingCandidates.map((candidate) => candidate.text)
          );
          for (const [index, candidate] of embeddingCandidates.entries()) {
            await upsertProjectRagPostgresChunkEmbedding1024(sql, projectId, {
              ...candidate,
              embedding: embeddings[index] ?? [],
              embeddingModel: embeddingConfig.model,
              embeddingProvider: embeddingConfig.provider,
              dimensions: embeddingConfig.dimensions,
              embeddingProfileHash: embeddingConfig.profileHash,
            });
          }
        }

        const promotedVersions = await repairProjectRagPostgresFileVersions(
          sql,
          projectId,
          embeddingConfig.model,
          embeddingConfig.provider,
          embeddingConfig.dimensions,
          false,
          promotionSourcePaths
        );
        if (promotedVersions !== promotionSourcePaths.length) {
          throw new Error(
            `embedding integrity promoted ${promotedVersions}/${promotionSourcePaths.length} fixture versions`
          );
        }

        console.log('  [2.5/4] Cleaning up stale files...');
        try {
          if (fixture.repoType === 'branch_drift') {
            console.log('        Branch drift cleanup handled during staged ingestion');
          } else {
            const { deletedCount } = await cleanupProjectStage(sql, projectId, sourcePathsToKeep);
            if (deletedCount > 0) {
              console.log(`        Deleted ${deletedCount} stale files`);
            } else {
              console.log(`        No stale files to delete`);
            }
          }
        } catch (e: any) {
          console.error(`        Failed to cleanup stale files: ${e.message}`);
          fixtureFailures.push(`${fixture.id}: stale-file cleanup failed`);
        }

        // Readers require a published build. Publish only after every stage,
        // stale-file cleanup, and embedding write has completed so the build
        // captures one coherent active-version snapshot.
        const publishedBuild = await publishProjectRagPostgresIndexBuild(sql, projectId);
        console.log(`        Published build ${publishedBuild.id}`);

        console.log(
          `        Ingested: ${ingested} files, Blocked: ${skipped} files, Symbols: ${symbolsExtracted}`
        );
      } catch (e) {
        console.error(`        Ingestion failed: ${e}`);
        fixtureFailures.push(`${fixture.id}: ingestion failed`);
        try {
          await cleanupProjectRegistryArtifacts(sql, projectId);
          console.log(`  [cleanup] Removed ephemeral project ${projectId} after failed ingestion`);
        } catch (cleanupError) {
          console.error(`  [cleanup] Failed to remove project ${projectId}: ${cleanupError}`);
          fixtureFailures.push(`${fixture.id}: cleanup failed`);
        }
        continue;
      }

      // Step 3: Run queries with the variant-appropriate search mode
      console.log('  [3/4] Running queries...');
      const responses: ProjectEvalCapturedRun['responses'] = [];
      const searchMode = resolveEvalSearchMode(args.variant);

      for (const scenario of fixture.scenarios) {
        try {
          let readinessWarnings: string[] = [];
          try {
            readinessWarnings = await waitForScenarioReadiness(
              sql,
              embeddingConfig,
              projectId,
              scenario,
              searchMode,
              args.verbose
            );
          } catch (readinessError) {
            const message =
              readinessError instanceof Error ? readinessError.message : String(readinessError);
            readinessWarnings = [`Readiness probe failed for ${scenario.id}: ${message}`];
            if (args.verbose) {
              console.log(`        Warning: ${readinessWarnings[0]}`);
            }
          }

          const endToEndStartTime = Date.now();
          const measuredSearch = await executeMeasuredScenarioSearch({
            sql,
            embeddingConfig,
            projectId,
            scenario,
            searchMode,
          });
          const { searchResults, latencyMs, embeddingLatencyMs } = measuredSearch;
          const endToEndLatencyMs = Date.now() - endToEndStartTime;

          const results = mapRetrievedResults(searchResults);

          responses.push({
            scenarioId: scenario.id,
            latencyMs,
            endToEndLatencyMs,
            embeddingLatencyMs,
            results,
            warnings:
              readinessWarnings.length > 0 || measuredSearch.warnings.length > 0
                ? [...readinessWarnings, ...measuredSearch.warnings]
                : undefined,
          });

          if (args.verbose) {
            const querySummary =
              `        Query: "${scenario.query}" -> ${results.length} results ` +
              `(search=${latencyMs}ms, embedding=${embeddingLatencyMs}ms, ` +
              `end-to-end=${endToEndLatencyMs}ms)`;
            console.log(querySummary);
          }
        } catch (e) {
          console.error(`        Query failed: ${scenario.query} - ${e}`);
          responses.push({
            scenarioId: scenario.id,
            latencyMs: 0,
            endToEndLatencyMs: 0,
            embeddingLatencyMs: 0,
            results: [],
          });
        }
      }

      if (
        responses.length !== fixture.scenarios.length ||
        responses.every((response) => response.results.length === 0)
      ) {
        fixtureFailures.push(`${fixture.id}: capture incomplete or returned no results`);
      }

      // Step 4: Capture results
      const capture: ProjectEvalCapturedRun = {
        fixtureId: fixture.id,
        variantId: args.variant,
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses,
      };

      allCaptures.push(capture);
      console.log(`  [4/4] Captured ${responses.length} query results`);

      try {
        await cleanupProjectRegistryArtifacts(sql, projectId);
        console.log(`  [cleanup] Removed ephemeral project ${projectId}`);
      } catch (cleanupError) {
        console.error(`  [cleanup] Failed to remove project ${projectId}: ${cleanupError}`);
        fixtureFailures.push(`${fixture.id}: cleanup failed`);
      }
    }

    if (args.captureWritePath) {
      const absoluteCapturePath = resolve(args.captureWritePath);
      mkdirSync(dirname(absoluteCapturePath), { recursive: true });
      writeFileSync(absoluteCapturePath, JSON.stringify(allCaptures, null, 2));
      console.log(`\nCapture written to: ${absoluteCapturePath}`);
    }

    // Build report
    console.log('\n\nGenerating Evaluation Report...');
    const report = buildProjectEvalReport(allCaptures, args.fixtureId);
    if (args.writePath) {
      const absoluteOutputPath = resolve(args.writePath);
      mkdirSync(dirname(absoluteOutputPath), { recursive: true });
      writeFileSync(absoluteOutputPath, JSON.stringify(report, null, 2));
      console.log(`Report written to: ${absoluteOutputPath}`);
    }

    // Print summary
    console.log('\n========================================');
    console.log('EVALUATION RESULTS');
    console.log('========================================\n');

    for (const variantReport of report.variantReports) {
      console.log(`\n${variantReport.fixtureId} / ${variantReport.variantId}`);
      console.log('  Metrics:');
      console.log(`    hitRate:        ${(variantReport.metrics.hitRate * 100).toFixed(1)}%`);
      console.log(`    exactPathRate:  ${(variantReport.metrics.exactPathRate * 100).toFixed(1)}%`);
      console.log(
        `    exactSymbolRate: ${(variantReport.metrics.exactSymbolRate * 100).toFixed(1)}%`
      );
      console.log(`    exactLineRate:  ${(variantReport.metrics.exactLineRate * 100).toFixed(1)}%`);
      console.log(
        `    avgQualityScore: ${(variantReport.metrics.avgQualityScore * 100).toFixed(1)}%`
      );
      console.log(
        `    contamination:  ${(variantReport.metrics.contaminationRate * 100).toFixed(1)}%`
      );
      console.log(`    latencyP95:     ${variantReport.metrics.latencyP95Ms.toFixed(0)}ms`);
      if (variantReport.metrics.embeddingLatencyP95Ms !== undefined) {
        console.log(
          `    embeddingP95:   ${variantReport.metrics.embeddingLatencyP95Ms.toFixed(0)}ms`
        );
      }
      if (variantReport.metrics.endToEndLatencyP95Ms !== undefined) {
        console.log(
          `    endToEndP95:    ${variantReport.metrics.endToEndLatencyP95Ms.toFixed(0)}ms`
        );
      }

      if (variantReport.thresholdFailures.length > 0) {
        console.log('  ⚠️  Threshold Failures:');
        for (const failure of variantReport.thresholdFailures) {
          console.log(`    - ${failure}`);
        }
      } else {
        console.log('  ✅ All thresholds passed');
      }
    }

    // Print experiment comparisons
    if (report.experimentReports.length > 0) {
      console.log('\n----------------------------------------');
      console.log('EXPERIMENT RESULTS');
      console.log('----------------------------------------\n');

      for (const exp of report.experimentReports) {
        const status = exp.passed ? '✅ PASS' : '❌ FAIL';
        console.log(`${exp.experimentId}: ${status}`);
        console.log(
          `  hitRateΔ:      ${exp.deltas.hitRate >= 0 ? '+' : ''}${(exp.deltas.hitRate * 100).toFixed(1)}%`
        );
        console.log(
          `  exactPathΔ:    ${exp.deltas.exactPathRate >= 0 ? '+' : ''}${(exp.deltas.exactPathRate * 100).toFixed(1)}%`
        );
        console.log(
          `  exactSymbolΔ:  ${exp.deltas.exactSymbolRate >= 0 ? '+' : ''}${(exp.deltas.exactSymbolRate * 100).toFixed(1)}%`
        );
        console.log(
          `  qualityΔ:      ${exp.deltas.avgQualityScore >= 0 ? '+' : ''}${(exp.deltas.avgQualityScore * 100).toFixed(1)}%`
        );
        console.log(
          `  latencyΔ:      ${exp.deltas.latencyP95Ms >= 0 ? '+' : ''}${exp.deltas.latencyP95Ms.toFixed(0)}ms`
        );

        if (exp.failures.length > 0) {
          console.log('  Failures:');
          for (const f of exp.failures) {
            console.log(`    - ${f}`);
          }
        }
      }
    }

    // Overall summary
    const passedCount = report.variantReports.filter(
      (r) => r.thresholdFailures.length === 0
    ).length;
    const totalCount = report.variantReports.length;

    console.log('\n========================================');
    console.log(`SUMMARY: ${passedCount}/${totalCount} variants passed all thresholds`);
    console.log('========================================\n');

    if (fixtureFailures.length > 0) {
      console.log('Fixture failures:');
      for (const failure of fixtureFailures) {
        console.log(`  - ${failure}`);
      }
      console.log('');
    }

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    }

    process.exitCode = passedCount === totalCount && fixtureFailures.length === 0 ? 0 : 1;
  } finally {
    if (config.database.url) {
      await closeProjectRagPostgresSql(config.database.url);
    }
  }
}

if (import.meta.main) {
  runE2EEvaluation().catch((error) => {
    console.error('Evaluation failed:', error);
    process.exit(1);
  });
}
