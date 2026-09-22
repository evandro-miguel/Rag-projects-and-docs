/**
 * @module eval/run-eval
 * @description Runs RAG evaluation queries and computes metrics.
 *
 * This script evaluates the RAG retrieval system by:
 * 1. Running each query against Docs RAG Postgres search
 * 2. Computing relevance scores based on retrieved contexts
 * 3. Calculating RAGAS-style metrics
 * 4. Returning detailed results
 *
 * Usage:
 *   bun run scripts/eval/run-eval.ts
 *   bun run scripts/eval/run-eval.ts --limit 10  # Run subset
 *   bun run scripts/eval/run-eval.ts --category react  # Filter by category
 *   bun run scripts/eval/run-eval.ts --compare-modes keyword,vector,hybrid  # Compare modes
 *   bun run scripts/eval/run-eval.ts --profile target  # Use profile shortcut for limit
 *   bun run scripts/eval/run-eval.ts --rerank  # Enable cross-encoder reranking
 *   bun run scripts/eval/run-eval.ts --compare-rerank  # Run with and without reranking
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DocsRagLabConfig } from '../docs-rag/config.js';
import { resolveDocsRagLabConfigWithLocalDefault } from '../docs-rag/config.js';
import { type DocsRagLabSearchResult, searchDocsRagLab } from '../docs-rag/store.js';
import ADVERSARIAL_QUERIES from './queries/adversarial.json' with { type: 'json' };
import STANDARD_QUERIES from './queries/standard.json' with { type: 'json' };
import type { EvalBaseline, EvalMetrics, EvalQuery, QueryEvalResult } from './types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================
const DEFAULT_LIMIT = 10; // Top K results to retrieve
const NDCG_K = 10;
const DEFAULT_COMPARE_MODES: CompareMode[] = ['keyword', 'vector', 'hybrid'];
const DEFAULT_MODE: CompareMode = 'hybrid';

const PROFILE_LIMITS = {
  minimum: 10,
  target: 20,
  stretch: 50,
} as const;

const SEVERE_HIT_RATE_DROP = 0.3;
const SEVERE_NDCG_DROP = 0.12;
const RERANK_EFFECT_CHANGE_THRESHOLD = 0.12;

export type CompareMode = 'keyword' | 'vector' | 'hybrid';

interface RerankEffectSummary {
  changedResultCount: number;
  unchangedCount: number;
  totalQueries: number;
  changedRate: number;
  ndcgLift: number;
  hitRateLift: number;
  mrrLift: number;
  latencyLiftMs: number;
  likelyIneffective: boolean;
}

interface ModeRunResult {
  mode: CompareMode;
  result: EvalBaseline;
  baseline?: EvalBaseline;
  rerankEffect?: RerankEffectSummary;
}

interface EvalRunOptions {
  limit?: number;
  category?: string;
  model?: string;
  mode?: CompareMode;
  rerank?: boolean;
}

interface RerankComparisonResult {
  baseline: EvalBaseline;
  reranked: EvalBaseline;
  rerankEffect: RerankEffectSummary;
}

type SearchResultItem = {
  document?: {
    sourcePath?: string | undefined;
  } | null;
};

export function parseCompareModes(input?: string): CompareMode[] {
  if (!input) return [...DEFAULT_COMPARE_MODES];

  const parsed = input
    .split(',')
    .map((mode) => mode.trim().toLowerCase())
    .filter(Boolean);

  if (parsed.length === 0) return [...DEFAULT_COMPARE_MODES];

  const unique: CompareMode[] = [];
  for (const mode of parsed) {
    if (!isModeSupported(mode)) {
      throw new Error(`Invalid mode "${mode}". Allowed modes: keyword, vector, hybrid`);
    }
    if (!unique.includes(mode)) unique.push(mode);
  }

  return unique;
}

export function resolveProfileLimit(profileArg?: string): number | undefined {
  if (!profileArg) return undefined;

  return PROFILE_LIMITS[profileArg as keyof typeof PROFILE_LIMITS];
}

function isModeSupported(mode: string): mode is CompareMode {
  return mode === 'keyword' || mode === 'vector' || mode === 'hybrid';
}

function estimateResultSignature(result: QueryEvalResult): string[] {
  return (result.resultSources ?? []).map((path) => (path ?? '').toLowerCase());
}

function signatureMatches(a: QueryEvalResult, b: QueryEvalResult): boolean {
  const aSig = estimateResultSignature(a);
  const bSig = estimateResultSignature(b);

  if (aSig.length !== bSig.length) return false;

  for (let i = 0; i < aSig.length; i++) {
    if (aSig[i] !== bSig[i]) return false;
  }

  return true;
}

export function compareRerankEffectiveness(
  baseline: EvalBaseline,
  reranked: EvalBaseline,
  minimumChangeRate: number = RERANK_EFFECT_CHANGE_THRESHOLD
): RerankEffectSummary {
  const baselineResults = baseline.query_results ?? [];
  const rerankedResults = reranked.query_results ?? [];
  const totalQueries = Math.min(baselineResults.length, rerankedResults.length);

  let changedResultCount = 0;

  for (let i = 0; i < totalQueries; i++) {
    const baseResult = baselineResults[i];
    const rerankResult = rerankedResults[i];
    const sameResult =
      baseResult && rerankResult ? signatureMatches(baseResult, rerankResult) : false;
    if (!sameResult) changedResultCount++;
  }

  const unchangedCount = Math.max(totalQueries - changedResultCount, 0);
  const changedRate = totalQueries === 0 ? 0 : changedResultCount / totalQueries;

  const ndcgLift = (reranked.metrics['nDCG@10'] ?? 0) - (baseline.metrics['nDCG@10'] ?? 0);
  const hitRateLift = (reranked.metrics.hitRate ?? 0) - (baseline.metrics.hitRate ?? 0);
  const mrrLift = (reranked.metrics.MRR ?? 0) - (baseline.metrics.MRR ?? 0);
  const latencyLiftMs =
    ((reranked.metrics.latency_p95 ?? 0) - (baseline.metrics.latency_p95 ?? 0)) * 1000;

  const likelyIneffective =
    changedRate <= minimumChangeRate &&
    Math.abs(ndcgLift) < 0.001 &&
    Math.abs(hitRateLift) < 0.001 &&
    Math.abs(mrrLift) < 0.001;

  return {
    changedResultCount,
    unchangedCount,
    totalQueries,
    changedRate,
    ndcgLift,
    hitRateLift,
    mrrLift,
    latencyLiftMs,
    likelyIneffective,
  };
}

function reportRerankEffectiveness(effect: RerankEffectSummary): void {
  const changedRatePct = (effect.changedRate * 100).toFixed(1);
  const unchangedRatePct = ((1 - effect.changedRate) * 100).toFixed(1);

  console.log('\n📌 RERANK EFFECTIVENESS CHECK:');
  console.log(
    `   Changed result signatures: ${effect.changedResultCount}/${effect.totalQueries} (${changedRatePct}%)`
  );
  console.log(
    `   Stable result signatures: ${effect.unchangedCount}/${effect.totalQueries} (${unchangedRatePct}%)`
  );
  console.log(
    `   nDCG lift: ${(effect.ndcgLift >= 0 ? '+' : '').concat(effect.ndcgLift.toFixed(3))}`
  );
  console.log(
    `   HitRate lift: ${(effect.hitRateLift >= 0 ? '+' : '').concat(effect.hitRateLift.toFixed(3))}`
  );
  console.log(`   MRR lift: ${(effect.mrrLift >= 0 ? '+' : '').concat(effect.mrrLift.toFixed(3))}`);
  console.log(
    `   Latency lift (p95): ${effect.latencyLiftMs >= 0 ? '+' : ''}${effect.latencyLiftMs.toFixed(0)} ms`
  );

  if (effect.likelyIneffective) {
    console.log(
      '\n⚠️  Reranking appears ineffective for this run (result signatures unchanged with rerank disabled).'
    );
    console.log(
      '   This suggests the --rerank flag is not exercising backend reranking for the selected mode.'
    );
  }
}

export function reportModeDivergence(modeResults: ModeRunResult[]): boolean {
  if (modeResults.length <= 1) return false;

  const reference = modeResults.reduce((top, candidate) =>
    candidate.result.metrics.hitRate > top.result.metrics.hitRate ? candidate : top
  );

  console.log('\n\n📈 MODE COMPARISON (control summary)');
  console.log('-----------------------------------');

  let hasSevereDivergence = false;

  for (const current of modeResults) {
    const hitRate = current.result.metrics.hitRate;
    const ndcg = current.result.metrics['nDCG@10'];

    const hitRateDelta = hitRate - reference.result.metrics.hitRate;
    const ndcgDelta = ndcg - reference.result.metrics['nDCG@10'];

    const severeDrop =
      current.mode === reference.mode
        ? false
        : hitRateDelta <= -SEVERE_HIT_RATE_DROP || ndcgDelta <= -SEVERE_NDCG_DROP;

    if (severeDrop) hasSevereDivergence = true;

    const deltaText =
      current.mode === reference.mode
        ? 'baseline'
        : `ΔhitRate ${(hitRateDelta * 100).toFixed(1)}pp, ΔnDCG ${(ndcgDelta >= 0 ? '+' : '').concat(ndcgDelta.toFixed(3))}`;

    const marker = severeDrop ? '⚠️' : '•';

    console.log(
      `${marker} ${current.mode.padEnd(10)} | hitRate=${(hitRate * 100).toFixed(1)}% | nDCG@10=${ndcg.toFixed(3)} | ${deltaText}`
    );
  }

  if (hasSevereDivergence) {
    console.log(
      '\n⚠️  Severe mode divergence detected in subset/profile.\n   Review index/query routing and coverage before green-lighting thresholds.'
    );
  }

  return hasSevereDivergence;
}

// =============================================================================
// METRIC CALCULATIONS
// =============================================================================

/**
 * Calculate nDCG (Normalized Discounted Cumulative Gain) at K.
 *
 * nDCG measures ranking quality considering:
 * - Position of relevant items (higher positions = more gain)
 * - Discounts gain logarithmically by position
 * - Normalizes by ideal DCG
 */
function calculateNDCG(relevanceScores: number[], k: number = NDCG_K): number {
  const scores = relevanceScores.slice(0, k);

  // Calculate DCG (Discounted Cumulative Gain)
  // Formula: sum of (rel_i / log2(i + 2)) for positions 1 to k
  const dcg = scores.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2);
  }, 0);

  // Calculate Ideal DCG (sorted descending)
  const sortedDesc = [...scores].sort((a, b) => b - a);
  const idcg = sortedDesc.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2);
  }, 0);

  // Handle edge case
  if (idcg === 0) return 0;

  return dcg / idcg;
}

/**
 * Calculate MRR (Mean Reciprocal Rank).
 *
 * MRR measures the average of the reciprocal ranks of the first relevant
 * document for each query. A perfect system has MRR = 1.
 */
function calculateMRR(firstRelevantRank: number): number {
  return firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;
}

// =============================================================================
// EVALUATION
// =============================================================================

/**
 * Check if expected documents are found in results.
 */
function findExpectedDocs(
  results: Array<SearchResultItem>,
  expectedPaths: string[]
): { found: boolean; firstRank: number } {
  for (let i = 0; i < results.length; i++) {
    const sourcePath = results[i]?.document?.sourcePath?.toLowerCase() ?? '';
    for (const expectedPath of expectedPaths) {
      if (sourcePath.includes(expectedPath.toLowerCase())) {
        return { found: true, firstRank: i + 1 };
      }
    }
  }
  return { found: false, firstRank: 0 };
}

/**
 * Assign relevance scores to retrieved contexts.
 * Returns 1.0 if the chunk's document path matches the expected paths, 0.0 otherwise.
 */
function scoreContexts(results: Array<SearchResultItem>, expectedPaths: string[]): number[] {
  return results.map((r) => {
    const sourcePath = r.document?.sourcePath?.toLowerCase() ?? '';
    return expectedPaths.some((p) => sourcePath.includes(p.toLowerCase())) ? 1.0 : 0.0;
  });
}

/**
 * Run a single evaluation query.
 */
async function evaluateQuery(
  config: DocsRagLabConfig,
  query: EvalQuery,
  limit: number = DEFAULT_LIMIT,
  mode: string = 'hybrid',
  rerankEnabled: boolean = false
): Promise<QueryEvalResult & { rerankLatencyMs?: number }> {
  const startTime = performance.now();
  const topMode = isModeSupported(mode) ? mode : 'hybrid';

  const searchConfig =
    topMode === 'keyword'
      ? { ...config, gates: { ...config.gates, embeddingEnabled: false } }
      : config;

  const result = await searchDocsRagLab(searchConfig, query.query, {
    limit,
  });

  const latencyMs = performance.now() - startTime;

  // Docs RAG Postgres does not expose a separate rerank timing in this runner.
  const rerankLatencyMs = rerankEnabled ? 0 : undefined;

  // Extract contexts
  const searchResults = result.results as DocsRagLabSearchResult[];
  const contexts = searchResults.map((r) => r.content);

  const resultSources = searchResults.map((r) => r.sourcePath.toLowerCase());

  // Find expected documents
  const resultsForCheck = searchResults.map((r) => ({
    document: { sourcePath: r.sourcePath },
  }));
  const { found, firstRank } = findExpectedDocs(resultsForCheck, query.expectedDocPaths);

  // Calculate relevance scores based purely on document matches
  const relevanceScores = scoreContexts(resultsForCheck, query.expectedDocPaths);

  // Calculate per-query metrics
  const ndcgScore = calculateNDCG(relevanceScores, NDCG_K);
  const mrrScore = calculateMRR(firstRank);

  return {
    queryId: query.id,
    query: query.query,
    contexts,
    resultSources,
    contextCount: contexts.length,
    foundExpectedDocs: found,
    firstExpectedDocRank: firstRank,
    relevanceScores,
    ndcgScore,
    mrrScore,
    latencyMs,
    rerankLatencyMs,
  };
}

/**
 * Run complete evaluation on all queries.
 */
export async function runEvaluation(options: EvalRunOptions): Promise<EvalBaseline> {
  const config = resolveDocsRagLabConfigWithLocalDefault(process.env, {
    evalTopK: options.limit ?? DEFAULT_LIMIT,
  });
  console.log(`📡 Using Docs RAG Postgres at ${config.database.redactedUrl ?? 'unconfigured'}...`);

  // Filter queries
  const allQueries = [
    ...(STANDARD_QUERIES as EvalQuery[]),
    ...(ADVERSARIAL_QUERIES as EvalQuery[]),
  ];
  let queries = allQueries;
  if (options.category) {
    queries = allQueries.filter((q) => q.category === options.category);
  }
  if (options.limit) {
    queries = queries.slice(0, options.limit);
  }

  const mode = options.mode ?? 'hybrid';
  const queryLimit = options.limit ?? DEFAULT_LIMIT;
  const rerankStatus = options.rerank ? 'enabled' : 'disabled';
  console.log(
    `🧪 Running evaluation on ${queries.length} queries in '${mode}' mode (limit: ${queryLimit}, rerank: ${rerankStatus})...\n`
  );

  const queryResults: QueryEvalResult[] = [];
  const rerankLatencies: number[] = [];
  let passed = 0;
  let failed = 0;
  let errorCount = 0;

  for (const query of queries) {
    try {
      console.log(`🔍 [${query.id}] ${query.query}`);
      const result = await evaluateQuery(config, query, queryLimit, mode, options.rerank ?? false);
      queryResults.push(result);

      // Track reranking latency if available
      if (result.rerankLatencyMs) {
        rerankLatencies.push(result.rerankLatencyMs);
      }

      // Check if this is an adversarial query that should NOT match
      const shouldNotMatch = query.expectedDocPaths.includes('__should_not_match__');

      if (shouldNotMatch) {
        // For adversarial queries, success means NOT finding documents
        if (!result.foundExpectedDocs) {
          console.log(
            `   ✅ Correctly returned no matching docs (${result.latencyMs.toFixed(0)} ms)`
          );
          passed++;
        } else {
          console.log(
            `   ❌ Should not have matched but found docs at rank ${result.firstExpectedDocRank} (${result.latencyMs.toFixed(0)} ms)`
          );
          failed++;
        }
      } else {
        // Normal queries: success means finding documents
        if (result.foundExpectedDocs) {
          console.log(
            `   ✅ Found expected docs at rank ${result.firstExpectedDocRank} (${result.latencyMs.toFixed(0)} ms)`
          );
          passed++;
        } else {
          console.log(
            `   ❌ Expected docs not in top ${queryLimit} (${result.latencyMs.toFixed(0)} ms)`
          );
          failed++;
        }
      }
    } catch (e: any) {
      console.error(`   💥 Error: ${e.message}`);
      failed++;
      errorCount++;
    }
  }

  // Calculate p95 latency
  const latencies = queryResults.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p95Index = Math.floor(latencies.length * 0.95);
  const latency_p95_ms = latencies.length > 0 ? latencies[p95Index] : 0;

  // Calculate reranking p95 latency if available
  let rerankLatency_p95_ms: number | undefined;
  if (rerankLatencies.length > 0) {
    rerankLatencies.sort((a, b) => a - b);
    const rerankP95Index = Math.floor(rerankLatencies.length * 0.95);
    rerankLatency_p95_ms = rerankLatencies[rerankP95Index];
  }

  // Aggregate metrics
  const metrics: EvalMetrics = {
    hitRate: queries.length > 0 ? passed / queries.length : 0,
    'nDCG@10':
      queryResults.length > 0
        ? queryResults.reduce((sum, r) => sum + r.ndcgScore, 0) / queryResults.length
        : 0,
    MRR:
      queryResults.length > 0
        ? queryResults.reduce((sum, r) => sum + r.mrrScore, 0) / queryResults.length
        : 0,
    latency_p95: latency_p95_ms / 1000, // convert back to seconds
  };

  console.log('\n📊 AGGREGATE METRICS:');
  console.log(`   Mode:               ${mode}`);
  console.log(`   Reranking:          ${options.rerank ? 'enabled' : 'disabled'}`);
  console.log(`   Hit Rate:           ${(metrics.hitRate * 100).toFixed(1)}%`);
  console.log(`   nDCG@10:            ${metrics['nDCG@10'].toFixed(3)}`);
  console.log(`   MRR:                ${metrics.MRR.toFixed(3)}`);
  console.log(`   Latency p95:        ${latency_p95_ms.toFixed(0)} ms`);
  if (rerankLatency_p95_ms !== undefined) {
    console.log(`   Rerank Latency p95: ${rerankLatency_p95_ms.toFixed(0)} ms`);
  }
  console.log(`\n   Passed: ${passed}/${queries.length}`);

  return {
    captured_at: new Date().toISOString(),
    metrics,
    query_count: queries.length,
    model: options.model ?? config.embedding.model,
    failed_query_count: failed,
    error_query_count: errorCount,
    query_results: queryResults,
  };
}

/**
 * Run comparison evaluation with and without reranking.
 */
async function runRerankComparison(options: EvalRunOptions): Promise<RerankComparisonResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log('RUNNING BASELINE (no reranking)');
  console.log(`${'='.repeat(60)}\n`);

  const baseline = await runEvaluation({ ...options, rerank: false });

  console.log(`\n${'='.repeat(60)}`);
  console.log('RUNNING WITH RERANKING');
  console.log(`${'='.repeat(60)}\n`);

  const reranked = await runEvaluation({ ...options, rerank: true });

  // Print comparison
  console.log(`\n${'='.repeat(60)}`);
  console.log('COMPARISON RESULTS');
  console.log(`${'='.repeat(60)}`);

  const baselineNDCG = baseline.metrics['nDCG@10'];
  const rerankedNDCG = reranked.metrics['nDCG@10'];
  const nDCGLift = ((rerankedNDCG - baselineNDCG) / baselineNDCG) * 100;

  const baselineLatency = (baseline.metrics.latency_p95 ?? 0) * 1000;
  const rerankedLatency = (reranked.metrics.latency_p95 ?? 0) * 1000;
  const latencyIncrease = rerankedLatency - baselineLatency;

  console.log(`\nnDCG@10:`);
  console.log(`   Baseline:  ${baselineNDCG.toFixed(3)}`);
  console.log(`   Reranked:  ${rerankedNDCG.toFixed(3)}`);
  console.log(`   Lift:      ${nDCGLift >= 0 ? '+' : ''}${nDCGLift.toFixed(1)}%`);

  console.log(`\nLatency (p95):`);
  console.log(`   Baseline:  ${baselineLatency.toFixed(0)} ms`);
  console.log(`   Reranked:  ${rerankedLatency.toFixed(0)} ms`);
  console.log(`   Increase:  +${latencyIncrease.toFixed(0)} ms`);

  console.log(`\nHit Rate:`);
  console.log(`   Baseline:  ${(baseline.metrics.hitRate * 100).toFixed(1)}%`);
  console.log(`   Reranked:  ${(reranked.metrics.hitRate * 100).toFixed(1)}%`);

  console.log(`\nMRR:`);
  console.log(`   Baseline:  ${baseline.metrics.MRR.toFixed(3)}`);
  console.log(`   Reranked:  ${reranked.metrics.MRR.toFixed(3)}`);

  return {
    baseline,
    reranked,
    rerankEffect: compareRerankEffectiveness(baseline, reranked),
  };
}

async function runModeComparison(
  options: Omit<EvalRunOptions, 'mode'>,
  modes: CompareMode[]
): Promise<ModeRunResult[]> {
  const modeResults: ModeRunResult[] = [];

  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index];
    if (!mode) continue;

    const label = `${index + 1}/${modes.length}`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`RUNNING MODE COMPARISON ${label}: ${mode}`);
    console.log(`${'='.repeat(60)}\n`);

    const result = await runEvaluation({ ...options, mode });
    modeResults.push({ mode, result });
  }

  if (modeResults.length > 1) {
    reportModeDivergence(modeResults);
  }

  return modeResults;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const outputPath = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
  const compareModesArg = args.includes('--compare-modes')
    ? args[args.indexOf('--compare-modes') + 1]
    : undefined;
  const profileArg = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined;
  const compareRerank = args.includes('--compare-rerank');
  const rerank = args.includes('--rerank') || compareRerank;
  const compareModeRequested = args.includes('--compare-modes');
  const modeArg = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : undefined;
  if (compareModeRequested || rerank) {
    console.error(
      '❌ --compare-modes, --rerank, and --compare-rerank are not supported by the current Postgres Docs RAG eval path.'
    );
    console.error(
      'Use bun run verify:docs-rag-live or wire a real Postgres mode/rerank evaluator before enabling these flags.'
    );
    process.exit(2);
  }
  const cliLimit =
    args.includes('--limit') && Number.parseInt(args[args.indexOf('--limit') + 1], 10) > 0
      ? Number.parseInt(args[args.indexOf('--limit') + 1], 10)
      : undefined;
  const profileLimit = resolveProfileLimit(profileArg);
  const compareModes = compareModeRequested ? parseCompareModes(compareModesArg) : undefined;
  const effectiveLimit =
    cliLimit ?? profileLimit ?? (compareModeRequested ? PROFILE_LIMITS.target : undefined);
  const defaultMode = modeArg ? (modeArg.toLowerCase() as CompareMode) : DEFAULT_MODE;
  if (defaultMode && !isModeSupported(defaultMode)) {
    throw new Error(`Invalid mode "${defaultMode}". Allowed modes: keyword, vector, hybrid`);
  }

  if (profileArg && !profileLimit) {
    console.error(`❌ Invalid profile '${profileArg}'. Use minimum, target, or stretch.`);
    process.exit(1);
  }

  if (compareModeRequested && compareModes && compareModes.length < 1) {
    console.error('❌ --compare-modes provided but resolved to no valid mode.');
    process.exit(1);
  }

  if (compareModeRequested && profileArg) {
    console.log(`🧭 profile: ${profileArg} (${effectiveLimit} queries)`);
  }
  if (!cliLimit && profileLimit) {
    console.log(`🧭 profile limit applied: ${profileLimit}`);
  }

  const options: EvalRunOptions = {
    mode: defaultMode,
    rerank,
  };
  if (effectiveLimit !== undefined) {
    options.limit = effectiveLimit;
  }
  const categoryArg = args.includes('--category')
    ? args[args.indexOf('--category') + 1]
    : undefined;
  if (categoryArg) {
    options.category = categoryArg;
  }
  if (process.env.EMBEDDING_MODEL) {
    options.model = process.env.EMBEDDING_MODEL;
  }

  type OutputPayload =
    | EvalBaseline
    | RerankComparisonResult
    | {
        mode_results: ModeRunResult[];
        rerank_comparison?: RerankComparisonResult;
      };

  let result: OutputPayload;
  let hasFailures = false;
  let rerankResult: RerankComparisonResult | undefined;

  if (compareModeRequested && compareModes) {
    const modeResults = await runModeComparison(options, compareModes);
    result = { mode_results: modeResults };
    hasFailures = modeResults.some((modeRun) => {
      const baseline = modeRun.result;
      return (
        (baseline.failed_query_count ?? 0) > 0 ||
        (baseline.error_query_count ?? 0) > 0 ||
        baseline.query_count === 0
      );
    });

    if (rerank) {
      const rerankMode = compareModes[0] ?? defaultMode;
      rerankResult = await runRerankComparison({ ...options, mode: rerankMode });
      reportRerankEffectiveness(rerankResult.rerankEffect);

      const modeResultFailures =
        rerankResult.baseline.failed_query_count ||
        rerankResult.baseline.error_query_count ||
        rerankResult.reranked.failed_query_count ||
        rerankResult.reranked.error_query_count;
      hasFailures = hasFailures || Boolean(modeResultFailures);
      result = {
        mode_results: modeResults,
        rerank_comparison: rerankResult,
      };
    }
  } else if (rerank) {
    rerankResult = await runRerankComparison(options);
    const { baseline, reranked } = rerankResult;
    reportRerankEffectiveness(rerankResult.rerankEffect);
    result = rerankResult;
    hasFailures = Boolean(
      baseline.failed_query_count ||
        baseline.error_query_count ||
        reranked.failed_query_count ||
        reranked.error_query_count
    );
  } else {
    result = await runEvaluation(options);
    hasFailures = Boolean(
      'query_count' in result &&
        (result.failed_query_count || result.error_query_count || result.query_count === 0)
    );
  }

  // Write to file if output path specified
  if (outputPath) {
    const absolutePath = resolve(outputPath);
    mkdirSync(dirname(absolutePath), { recursive: true });

    // Get git commit hash if available
    let commitHash: string | undefined;
    try {
      const { execSync } = await import('node:child_process');
      commitHash = execSync('git rev-parse HEAD').toString().trim();
    } catch {
      commitHash = undefined;
    }

    const output = {
      result,
      commit_hash: commitHash,
      rerank_enabled: rerank,
      compare_modes: compareModes ?? undefined,
      compare_profile: profileArg ?? null,
      rerank_comparison: rerankResult ?? null,
    };

    writeFileSync(absolutePath, JSON.stringify(output, null, 2));
    console.log(`\n📄 Results written to: ${absolutePath}`);
  }

  process.exit(hasFailures ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
