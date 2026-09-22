#!/usr/bin/env bun
/**
 * Live Postgres Project RAG search latency and correctness benchmark.
 *
 * Exercises the canonical supported application search route with full
 * context validation, freshness verification, fallback detection, and
 * citation quality gates. Raw-store latency is recorded purely as
 * diagnostic evidence.
 *
 * Readiness mode measures at least 30 samples and fails closed on latency,
 * zero hits, stale context, lexical fallback, self-referential hits, or
 * missing expected paths. Smaller runs require explicit --smoke mode and
 * can never report release-pass status.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROJECT_THRESHOLDS } from '../eval/thresholds.js';
import { createProjectRagApplicationService } from '../project-rag/application-service.js';
import {
  type ProjectRagPostgresConfig,
  resolveProjectRagPostgresConfigWithLocalDefault,
} from '../project-rag/config.js';
import {
  fetchProjectRagPostgresEmbeddings,
  type ProjectRagPostgresEmbeddingConfig,
  resolveProjectRagPostgresEmbeddingConfig,
} from '../project-rag/embeddings.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
  searchProjectRagPostgresChunks,
} from '../project-rag/store.js';

export type ProjectSearchBenchmarkMode = 'readiness' | 'smoke';

export interface BenchmarkQuery {
  readonly name: string;
  readonly query: string;
  readonly expectedPaths?: readonly string[];
  /** Maximum 1-based result rank accepted for an expected path. */
  readonly expectedPathMaxRank?: number;
}

export const MIN_READINESS_SAMPLES = 30;
export const DEFAULT_EXPECTED_PATH_MAX_RANK = 3;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_QUERIES_PATH = resolve(
  REPO_ROOT,
  'tests/fixtures/project-search-benchmark-queries.json'
);

export function loadDefaultBenchmarkQueries(
  path = DEFAULT_QUERIES_PATH
): readonly BenchmarkQuery[] {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item) => ({
          name: String(item.name ?? 'unknown'),
          query: String(item.query ?? ''),
          expectedPaths: Array.isArray(item.expectedPaths)
            ? item.expectedPaths.map(String)
            : undefined,
          expectedPathMaxRank:
            Number.isInteger(item.expectedPathMaxRank) && item.expectedPathMaxRank > 0
              ? item.expectedPathMaxRank
              : Number.isInteger(item.maxRank) && item.maxRank > 0
                ? item.maxRank
                : undefined,
        }));
      }
    }
  } catch {
    // Queries must be loaded from external fixtures
  }
  throw new Error(
    `Failed to load benchmark queries from ${path}. Benchmark queries must be stored in external fixtures.`
  );
}

export const DEFAULT_PROJECT_SEARCH_QUERIES: readonly BenchmarkQuery[] =
  loadDefaultBenchmarkQueries();

const SOURCE_IDENTITY_FILES = [
  'package.json',
  'scripts/project-rag/application-service.ts',
  'scripts/project-rag/embeddings.ts',
  'scripts/project-rag/store.ts',
  'scripts/benchmarks/project-search-latency.ts',
  'scripts/benchmarks/project-search-latency.test.ts',
  'tests/fixtures/project-search-benchmark-queries.json',
] as const;

export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
}

export interface QueryBenchmarkResult extends BenchmarkQuery {
  readonly samples: number;
  readonly minHits: number;
  readonly maxHits: number;
  readonly fallbackUsedCount: number;
  readonly contextInvalidCount: number;
  readonly selfReferentialHitCount: number;
  readonly expectedPathMatched: boolean;
  readonly expectedPathRank?: number | null;
  readonly topPaths: readonly string[];
}

export interface BenchmarkSourceIdentity {
  readonly headCommit: string;
  readonly dirty: boolean;
  readonly contentSha256: string;
  readonly files: readonly string[];
}

export interface BenchmarkQueryResult {
  readonly hits: number;
  readonly topResults?: ReadonlyArray<{
    readonly sourcePath: string;
    readonly score: number;
    readonly startLine?: number;
    readonly endLine?: number;
  }>;
  readonly fallbackUsed?: boolean;
  readonly contextInvalid?: boolean;
  readonly rawStoreLatencyMs?: number;
}

export interface BenchmarkRuntime {
  readonly project: { readonly id: number; readonly slug: string };
  readonly databaseSource: string;
  readonly embedding: {
    readonly provider: string;
    readonly model: string;
    readonly dimensions: number;
    readonly profileHash: string;
  };
  runQuery(entry: BenchmarkQuery): Promise<BenchmarkQueryResult | number>;
  close(): Promise<void>;
}

export interface ProjectSearchBenchmarkReport {
  readonly status: 'passed' | 'smoke' | 'failed';
  readonly releaseEligible: boolean;
  readonly generatedAt: string;
  readonly provenance: {
    readonly project: { readonly id: number; readonly slug: string };
    readonly databaseSource: string;
    readonly embedding: {
      readonly provider: string;
      readonly model: string;
      readonly dimensions: number;
      readonly profileHash: string;
    };
    readonly sourceIdentity: BenchmarkSourceIdentity;
    readonly cachePosture: string;
  };
  readonly mode: ProjectSearchBenchmarkMode;
  readonly querySet: readonly BenchmarkQuery[];
  readonly queryResults: readonly QueryBenchmarkResult[];
  readonly iterations: number;
  readonly warmup: number;
  readonly latency: LatencySummary;
  readonly diagnostics?: {
    readonly rawStoreLatency?: LatencySummary;
  };
  readonly threshold: { readonly p95Ms: number; readonly minSamples: number };
  readonly violations: readonly string[];
  readonly error?: string;
}

export interface ProjectSearchBenchmarkArgs {
  readonly project: string;
  readonly mode: ProjectSearchBenchmarkMode;
  readonly iterations: number;
  readonly warmup: number;
  readonly queries: readonly BenchmarkQuery[];
  readonly thresholdMs: number;
  readonly expectedPathMaxRank?: number;
  readonly queriesFile?: string;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

export function parseProjectSearchBenchmarkArgs(
  argv: readonly string[]
): ProjectSearchBenchmarkArgs {
  const project = optionValue(argv, '--project') ?? process.env.PROJECT_RAG_PROJECT_SLUG;
  if (!project) throw new Error('Missing --project <slug-or-id>.');

  const queriesFile = optionValue(argv, '--queries-file');
  const baseQueries = queriesFile
    ? loadDefaultBenchmarkQueries(queriesFile)
    : DEFAULT_PROJECT_SEARCH_QUERIES;

  const customQueries: BenchmarkQuery[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--query' && !arg.startsWith('--query=')) continue;
    const value = arg.startsWith('--query=') ? arg.slice('--query='.length) : argv[index + 1];
    if (value?.trim()) {
      customQueries.push({ name: `query-${customQueries.length + 1}`, query: value.trim() });
    }
  }

  const mode: ProjectSearchBenchmarkMode = argv.includes('--smoke') ? 'smoke' : 'readiness';
  const queries = customQueries.length > 0 ? customQueries : baseQueries;
  const iterations = positiveInt(optionValue(argv, '--iterations'), 10, 100);
  const measuredSamples = iterations * queries.length;
  if (mode === 'readiness' && measuredSamples < MIN_READINESS_SAMPLES) {
    throw new Error(
      `Readiness benchmark requires at least ${MIN_READINESS_SAMPLES} measured samples; configured ${measuredSamples}. Use --smoke for a non-release run.`
    );
  }

  return {
    project,
    mode,
    iterations,
    warmup: nonNegativeInt(optionValue(argv, '--warmup'), 2, 20),
    queries,
    thresholdMs: positiveInt(
      optionValue(argv, '--p95-threshold-ms'),
      DEFAULT_PROJECT_THRESHOLDS.latencyP95Ms,
      120_000
    ),
    expectedPathMaxRank: positiveInt(
      optionValue(argv, '--expected-path-max-rank') ??
        process.env.PROJECT_SEARCH_EXPECTED_PATH_MAX_RANK,
      DEFAULT_EXPECTED_PATH_MAX_RANK,
      100
    ),
    queriesFile,
  };
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  if (values.length === 0) throw new Error('Benchmark produced no latency samples.');
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    minMs: Math.round(Math.min(...values) * 100) / 100,
    maxMs: Math.round(Math.max(...values) * 100) / 100,
  };
}

export function benchmarkViolations(
  latency: LatencySummary,
  queryResults: readonly QueryBenchmarkResult[],
  thresholdMs: number,
  mode: ProjectSearchBenchmarkMode,
  expectedPathMaxRank = DEFAULT_EXPECTED_PATH_MAX_RANK
): readonly string[] {
  const violations: string[] = [];
  if (mode === 'readiness' && latency.count < MIN_READINESS_SAMPLES) {
    violations.push(
      `measured samples ${latency.count} below readiness minimum ${MIN_READINESS_SAMPLES}`
    );
  }
  if (latency.p95Ms > thresholdMs) {
    violations.push(`p95 ${latency.p95Ms}ms exceeds threshold ${thresholdMs}ms`);
  }
  for (const query of queryResults) {
    if (query.samples === 0 || query.minHits === 0) {
      violations.push(`query ${query.name} returned zero hits`);
    }
    if (query.contextInvalidCount > 0) {
      violations.push(
        `query ${query.name} executed with invalid/stale workspace context (${query.contextInvalidCount} samples)`
      );
    }
    if (query.fallbackUsedCount > 0) {
      violations.push(
        `query ${query.name} triggered lexical fallback (${query.fallbackUsedCount} samples)`
      );
    }
    if (query.selfReferentialHitCount > 0) {
      violations.push(
        `query ${query.name} returned self-referential hit matching benchmark files (${query.selfReferentialHitCount} samples)`
      );
    }
    if (query.expectedPaths && query.expectedPaths.length > 0 && !query.expectedPathMatched) {
      const maxRank = query.expectedPathMaxRank ?? expectedPathMaxRank;
      violations.push(
        `query ${query.name} did not match any expected paths within max rank ${maxRank} (observed rank ${query.expectedPathRank ?? 'none'}): [${query.expectedPaths.join(', ')}]. Returned: [${query.topPaths.slice(0, 3).join(', ')}]`
      );
    }
  }
  return violations;
}

function expectedPathRank(
  topPaths: readonly string[],
  expectedPaths: readonly string[] | undefined
): number | null {
  if (!expectedPaths || expectedPaths.length === 0) return null;
  const index = topPaths.findIndex((top) =>
    expectedPaths.some((expected) => top === expected || top.endsWith(expected))
  );
  return index >= 0 ? index + 1 : null;
}

function gitValue(args: readonly string[], fallback: string): string {
  try {
    return (
      execFileSync('git', ['-C', REPO_ROOT, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || fallback
    );
  } catch {
    return fallback;
  }
}

export function resolveBenchmarkSourceIdentity(): BenchmarkSourceIdentity {
  const hash = createHash('sha256');
  for (const path of SOURCE_IDENTITY_FILES) {
    hash.update(path);
    hash.update('\0');
    try {
      hash.update(readFileSync(resolve(REPO_ROOT, path)));
    } catch {
      hash.update('');
    }
    hash.update('\0');
  }
  return {
    headCommit: gitValue(['rev-parse', 'HEAD'], 'unknown'),
    dirty: gitValue(['status', '--porcelain'], '').length > 0,
    contentSha256: hash.digest('hex'),
    files: SOURCE_IDENTITY_FILES,
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:postgres(?:ql)?|https?):\/\/\S+/giu, '[redacted-url]');
}

async function createLiveRuntime(
  projectRef: string,
  config: ProjectRagPostgresConfig,
  embedding: ProjectRagPostgresEmbeddingConfig
): Promise<BenchmarkRuntime> {
  const sql = createProjectRagPostgresSql(config);
  try {
    const project = await findProjectRagPostgresProject(sql, projectRef);
    if (!project) throw new Error(`Project not found in Postgres: ${projectRef}`);

    const service = createProjectRagApplicationService({ closePool: false });

    return {
      project: { id: project.id, slug: project.slug },
      databaseSource: config.database.source ?? 'unconfigured',
      embedding: {
        provider: embedding.provider,
        model: embedding.model,
        dimensions: embedding.dimensions,
        profileHash: embedding.profileHash,
      },
      async runQuery(entry: BenchmarkQuery): Promise<BenchmarkQueryResult> {
        // Exercise the supported application service route
        const response = await service.searchProject({
          project: projectRef,
          query: entry.query,
          limit: 10,
          includeDiagnostics: true,
        });

        const results =
          (response.results as Array<{
            sourcePath: string;
            score: number;
            startLine?: number;
            endLine?: number;
          }>) ?? [];

        const diagnostics = response.diagnostics as
          | {
              fusion?: string;
              lanes?: Array<{ lane: string; status: string; reason?: string }>;
            }
          | undefined;

        const warnings = (response.warnings as string[]) ?? [];
        const fallbackUsed =
          diagnostics?.fusion === 'postgres_lexical_score' ||
          diagnostics?.lanes?.some((l) => l.lane === 'postgres_lexical_fallback') ||
          warnings.some((w) => w.toLowerCase().includes('lexical fallback')) ||
          false;

        const contextInvalid = warnings.some(
          (w) =>
            w.toLowerCase().includes('differs from the current worktree') ||
            w.toLowerCase().includes('context invalid')
        );

        // Optional diagnostic-only measurement of raw-store search
        let rawStoreLatencyMs: number | undefined;
        try {
          const [queryEmbedding] = await fetchProjectRagPostgresEmbeddings(embedding, [
            `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${entry.query}`,
          ]);
          const rawStart = performance.now();
          await searchProjectRagPostgresChunks(sql, project.id, {
            query: entry.query,
            queryEmbedding,
            embeddingModel: embedding.model,
            embeddingProvider: embedding.provider,
            embeddingDimensions: embedding.dimensions,
            embeddingProfileHash: embedding.profileHash,
            limit: 10,
          });
          rawStoreLatencyMs = performance.now() - rawStart;
        } catch {
          // Diagnostic only; do not throw
        }

        return {
          hits: results.length,
          topResults: results.map((r) => ({
            sourcePath: r.sourcePath,
            score: r.score,
            startLine: r.startLine,
            endLine: r.endLine,
          })),
          fallbackUsed,
          contextInvalid,
          rawStoreLatencyMs,
        };
      },
      async close() {
        if (config.database.url) await closeProjectRagPostgresSql(config.database.url);
      },
    };
  } catch (error) {
    if (config.database.url) await closeProjectRagPostgresSql(config.database.url);
    throw error;
  }
}

function emptyLatency(): LatencySummary {
  return { count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, minMs: 0, maxMs: 0 };
}

export async function runProjectSearchBenchmark(
  args: ProjectSearchBenchmarkArgs,
  deps: {
    readonly runtime?: BenchmarkRuntime;
    readonly sourceIdentity?: BenchmarkSourceIdentity;
  } = {}
): Promise<ProjectSearchBenchmarkReport> {
  const generatedAt = new Date().toISOString();
  const sourceIdentity = deps.sourceIdentity ?? resolveBenchmarkSourceIdentity();
  let runtime: BenchmarkRuntime | undefined;
  try {
    runtime =
      deps.runtime ??
      (await createLiveRuntime(
        args.project,
        resolveProjectRagPostgresConfigWithLocalDefault(),
        resolveProjectRagPostgresEmbeddingConfig()
      ));

    const samples: number[] = [];
    const rawStoreSamples: number[] = [];
    const hitCounts = new Map<string, number[]>();
    const fallbackCounts = new Map<string, number>();
    const contextInvalidCounts = new Map<string, number>();
    const selfReferentialCounts = new Map<string, number>();
    const topPathSets = new Map<string, string[]>();
    const expectedPathRanks = new Map<string, Array<number | null>>();

    for (const query of args.queries) {
      hitCounts.set(query.name, []);
      fallbackCounts.set(query.name, 0);
      contextInvalidCounts.set(query.name, 0);
      selfReferentialCounts.set(query.name, 0);
      topPathSets.set(query.name, []);
      expectedPathRanks.set(query.name, []);
    }

    for (let iteration = 0; iteration < args.warmup; iteration += 1) {
      for (const query of args.queries) await runtime.runQuery(query);
    }

    for (let iteration = 0; iteration < args.iterations; iteration += 1) {
      for (const query of args.queries) {
        const started = performance.now();
        const result = await runtime.runQuery(query);
        const elapsed = performance.now() - started;
        samples.push(elapsed);

        const hits = typeof result === 'number' ? result : result.hits;
        hitCounts.get(query.name)?.push(hits);

        if (typeof result !== 'number') {
          if (result.rawStoreLatencyMs !== undefined) {
            rawStoreSamples.push(result.rawStoreLatencyMs);
          }
          if (result.fallbackUsed) {
            fallbackCounts.set(query.name, (fallbackCounts.get(query.name) ?? 0) + 1);
          }
          if (result.contextInvalid) {
            contextInvalidCounts.set(query.name, (contextInvalidCounts.get(query.name) ?? 0) + 1);
          }
          if (result.topResults) {
            const returnedPaths = result.topResults.map((r) => r.sourcePath);
            topPathSets.set(query.name, returnedPaths);
            expectedPathRanks
              .get(query.name)
              ?.push(expectedPathRank(returnedPaths, query.expectedPaths));
            const selfHits = returnedPaths.filter(
              (p) => p.startsWith('scripts/benchmarks/') || p.includes('project-search-latency')
            );
            if (selfHits.length > 0) {
              selfReferentialCounts.set(
                query.name,
                (selfReferentialCounts.get(query.name) ?? 0) + 1
              );
            }
          } else if (query.expectedPaths && query.expectedPaths.length > 0) {
            expectedPathRanks.get(query.name)?.push(null);
          }
        } else if (query.expectedPaths && query.expectedPaths.length > 0) {
          expectedPathRanks.get(query.name)?.push(null);
        }
      }
    }

    const queryResults = args.queries.map((query): QueryBenchmarkResult => {
      const counts = hitCounts.get(query.name) ?? [];
      const topPaths = topPathSets.get(query.name) ?? [];
      const ranks = expectedPathRanks.get(query.name) ?? [];
      const configuredMaxRank = args.expectedPathMaxRank ?? DEFAULT_EXPECTED_PATH_MAX_RANK;
      const maxRank = query.expectedPathMaxRank ?? configuredMaxRank;
      const hasExpectedPaths = Boolean(query.expectedPaths && query.expectedPaths.length > 0);
      const expectedPathMatched = hasExpectedPaths
        ? counts.length > 0 &&
          ranks.length === counts.length &&
          ranks.every((rank) => rank !== null && rank <= maxRank)
        : counts.length > 0 && Math.min(...counts) > 0;
      const expectedPathRank = hasExpectedPaths
        ? ranks.length > 0 && ranks.every((rank): rank is number => rank !== null)
          ? Math.max(...ranks)
          : null
        : null;

      return {
        ...query,
        samples: counts.length,
        minHits: counts.length > 0 ? Math.min(...counts) : 0,
        maxHits: counts.length > 0 ? Math.max(...counts) : 0,
        fallbackUsedCount: fallbackCounts.get(query.name) ?? 0,
        contextInvalidCount: contextInvalidCounts.get(query.name) ?? 0,
        selfReferentialHitCount: selfReferentialCounts.get(query.name) ?? 0,
        expectedPathMatched,
        expectedPathRank,
        expectedPathMaxRank: maxRank,
        topPaths,
      };
    });

    const latency = summarizeLatencies(samples);
    const diagnostics =
      rawStoreSamples.length > 0
        ? { rawStoreLatency: summarizeLatencies(rawStoreSamples) }
        : undefined;

    const violations = benchmarkViolations(
      latency,
      queryResults,
      args.thresholdMs,
      args.mode,
      args.expectedPathMaxRank ?? DEFAULT_EXPECTED_PATH_MAX_RANK
    );
    const status = violations.length > 0 ? 'failed' : args.mode === 'smoke' ? 'smoke' : 'passed';
    const report: ProjectSearchBenchmarkReport = {
      status,
      releaseEligible: status === 'passed',
      generatedAt,
      provenance: {
        project: runtime.project,
        databaseSource: runtime.databaseSource,
        embedding: runtime.embedding,
        sourceIdentity,
        cachePosture: process.env.RAG_BENCHMARK_CACHE_POSTURE?.trim() || 'unspecified',
      },
      mode: args.mode,
      querySet: args.queries,
      queryResults,
      iterations: args.iterations,
      warmup: args.warmup,
      latency,
      ...(diagnostics ? { diagnostics } : {}),
      threshold: { p95Ms: args.thresholdMs, minSamples: MIN_READINESS_SAMPLES },
      violations,
    };

    const closingRuntime = runtime;
    runtime = undefined;
    try {
      await closingRuntime.close();
      return report;
    } catch (error) {
      return {
        ...report,
        status: 'failed',
        releaseEligible: false,
        error: safeError(error),
      };
    }
  } catch (error) {
    return {
      status: 'failed',
      releaseEligible: false,
      generatedAt,
      provenance: {
        project: runtime?.project ?? { id: 0, slug: args.project },
        databaseSource: runtime?.databaseSource ?? 'unavailable',
        embedding: runtime?.embedding ?? {
          provider: 'unavailable',
          model: 'unavailable',
          dimensions: 0,
          profileHash: 'unavailable',
        },
        sourceIdentity,
        cachePosture: process.env.RAG_BENCHMARK_CACHE_POSTURE?.trim() || 'unspecified',
      },
      mode: args.mode,
      querySet: args.queries,
      queryResults: [],
      iterations: args.iterations,
      warmup: args.warmup,
      latency: emptyLatency(),
      threshold: { p95Ms: args.thresholdMs, minSamples: MIN_READINESS_SAMPLES },
      violations: [],
      error: safeError(error),
    };
  } finally {
    if (runtime) {
      try {
        await runtime.close();
      } catch {
        // Safe close error absorption
      }
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: bun run bench:project-search --project <slug-or-id> [--iterations 10] [--warmup 2] [--query <text>] [--queries-file <path>] [--smoke] [--json]'
    );
    return;
  }
  const report = await runProjectSearchBenchmark(parseProjectSearchBenchmarkArgs(argv));
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `Project search benchmark: ${report.status} (samples=${report.latency.count} p50=${report.latency.p50Ms}ms p95=${report.latency.p95Ms}ms p99=${report.latency.p99Ms}ms releaseEligible=${report.releaseEligible})`
    );
    if (report.violations.length > 0) {
      console.log('Violations:');
      for (const v of report.violations) {
        console.log(`  - ${v}`);
      }
    }
  }
  if (report.status === 'failed') process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
