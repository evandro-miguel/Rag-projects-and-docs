import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ADVERSARIAL_QUERIES from './queries/adversarial.json' with { type: 'json' };
import STANDARD_QUERIES from './queries/standard.json' with { type: 'json' };
import type { EvalBaseline, EvalQuery, QueryEvalResult } from './types.js';

type AgentMcpQueryResponse = {
  id: string;
  sourcePaths: string[];
  error?: string | null;
};

type AgentMcpBatchResponse = {
  results: AgentMcpQueryResponse[];
};

type AgentMcpQueryEvalResult = QueryEvalResult & {
  sourcePaths: string[];
  error?: string;
};

const DEFAULT_LIMIT = 10;
const NDCG_K = 10;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_TIMEOUT_MS = 300000;

function parseArgs(args: string[]) {
  const readNumber = (flag: string, fallback: number) => {
    const index = args.indexOf(flag);
    if (index === -1) {
      return fallback;
    }

    const value = Number.parseInt(args[index + 1] ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  const readString = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  return {
    json: args.includes('--json'),
    cwd: readString('--cwd') ?? process.cwd(),
    model: readString('--model') ?? process.env.AGENT_MCP_EVAL_MODEL ?? 'gpt-5.1-codex-mini',
    reasoningEffort:
      readString('--reasoning-effort') ?? process.env.AGENT_MCP_EVAL_REASONING_EFFORT ?? 'low',
    limit: readNumber('--limit', 0),
    batchSize: readNumber('--batch-size', DEFAULT_BATCH_SIZE),
    searchLimit: readNumber('--search-limit', DEFAULT_LIMIT),
    timeoutMs: readNumber('--timeout-ms', DEFAULT_TIMEOUT_MS),
    category: readString('--category'),
    outPath: readString('--out'),
  };
}

function batchArray<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

function calculateNDCG(relevanceScores: number[], k: number = NDCG_K): number {
  const scores = relevanceScores.slice(0, k);
  const dcg = scores.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
  const sortedDesc = [...scores].sort((a, b) => b - a);
  const idcg = sortedDesc.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

function calculateMRR(firstRelevantRank: number): number {
  return firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;
}

function findExpectedDocs(
  sourcePaths: string[],
  expectedPaths: string[]
): { found: boolean; firstRank: number } {
  for (let i = 0; i < sourcePaths.length; i++) {
    const sourcePath = sourcePaths[i]?.toLowerCase() ?? '';
    for (const expectedPath of expectedPaths) {
      if (sourcePath.includes(expectedPath.toLowerCase())) {
        return { found: true, firstRank: i + 1 };
      }
    }
  }
  return { found: false, firstRank: 0 };
}

function scoreContexts(sourcePaths: string[], expectedPaths: string[]): number[] {
  return sourcePaths.map((sourcePath) =>
    expectedPaths.some((expectedPath) =>
      sourcePath.toLowerCase().includes(expectedPath.toLowerCase())
    )
      ? 1
      : 0
  );
}

function buildPrompt(batch: EvalQuery[], searchLimit: number): string {
  const lines = batch.map((query) => `- ${query.id}: ${query.query}`);
  return [
    'Use the rag-docs MCP tool search_docs from this Codex instance.',
    `For each query below, run search_docs with limit ${searchLimit}.`,
    'Return only the ordered sourcePath values from the MCP response.',
    'If a query fails, return an empty sourcePaths array and set error to a short string.',
    'Reply with strict JSON only in this exact shape:',
    '{"results":[{"id":"string","sourcePaths":["string"],"error":null}]}',
    'Queries:',
    ...lines,
  ].join('\n');
}

function parseBatchResponse(raw: string): AgentMcpBatchResponse {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Codex returned an empty final message');
  }

  const parsed = JSON.parse(trimmed) as AgentMcpBatchResponse;
  if (!Array.isArray(parsed.results)) {
    throw new Error('Codex response missing results array');
  }

  return parsed;
}

function formatFailure(result: ReturnType<typeof spawnSync>) {
  const stdout =
    typeof result.stdout === 'string'
      ? result.stdout
      : result.stdout
        ? Buffer.from(result.stdout).toString('utf8')
        : '';
  const stderr =
    typeof result.stderr === 'string'
      ? result.stderr
      : result.stderr
        ? Buffer.from(result.stderr).toString('utf8')
        : '';

  return [
    `codex exec exited with status ${result.status ?? 'null'}`,
    result.error ? `error: ${result.error.message}` : '',
    stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
    stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildCodexExecArgs(args: {
  model: string;
  reasoningEffort: string;
  cwd: string;
  outputPath: string;
  prompt: string;
}) {
  return [
    'exec',
    '--ephemeral',
    '-m',
    args.model,
    '-c',
    `model_reasoning_effort="${args.reasoningEffort}"`,
    '-C',
    args.cwd,
    '-o',
    args.outputPath,
    args.prompt,
  ];
}

function getAllQueries(category?: string, limit?: number): EvalQuery[] {
  const allQueries = [
    ...(STANDARD_QUERIES as EvalQuery[]),
    ...(ADVERSARIAL_QUERIES as EvalQuery[]),
  ];
  const filtered = category
    ? allQueries.filter((query) => query.category === category)
    : allQueries;
  return limit && limit > 0 ? filtered.slice(0, limit) : filtered;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.cwd;
  const queries = getAllQueries(args.category, args.limit);
  const batches = batchArray(queries, args.batchSize);
  const queryResults: AgentMcpQueryEvalResult[] = [];

  console.log('Agent MCP Evaluation');
  console.log('====================');
  console.log(`Model: ${args.model} (${args.reasoningEffort})`);
  console.log(`Workspace: ${repoRoot}`);
  console.log(`Queries: ${queries.length}`);
  console.log(`Batch size: ${args.batchSize}`);
  console.log(`Search limit: ${args.searchLimit}`);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const tempDir = mkdtempSync(join(tmpdir(), 'agent-mcp-eval-'));
    const outputPath = join(tempDir, 'last-message.json');
    const startedAt = performance.now();

    try {
      const result = spawnSync(
        'codex',
        buildCodexExecArgs({
          model: args.model,
          reasoningEffort: args.reasoningEffort,
          cwd: repoRoot,
          outputPath,
          prompt: buildPrompt(batch, args.searchLimit),
        }),
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: process.env as Record<string, string>,
          timeout: args.timeoutMs,
        }
      );

      if (result.error || result.status !== 0) {
        throw new Error(formatFailure(result));
      }

      const elapsedMs = performance.now() - startedAt;
      const perQueryLatencyMs = batch.length > 0 ? elapsedMs / batch.length : elapsedMs;
      const batchResponse = parseBatchResponse(readFileSync(outputPath, 'utf8'));
      const responseById = new Map(batchResponse.results.map((item) => [item.id, item]));

      console.log(`Batch ${batchIndex + 1}/${batches.length}: ${elapsedMs.toFixed(0)} ms`);

      for (const query of batch) {
        const response = responseById.get(query.id);
        if (!response) {
          queryResults.push({
            queryId: query.id,
            query: query.query,
            contexts: [],
            contextCount: 0,
            foundExpectedDocs: false,
            firstExpectedDocRank: 0,
            relevanceScores: [],
            ndcgScore: 0,
            mrrScore: 0,
            latencyMs: perQueryLatencyMs,
            resultSources: [],
            sourcePaths: [],
            error: 'missing query result in codex response',
          });
          continue;
        }

        const sourcePaths = Array.isArray(response.sourcePaths) ? response.sourcePaths : [];
        const { found, firstRank } = findExpectedDocs(sourcePaths, query.expectedDocPaths);
        const relevanceScores = scoreContexts(sourcePaths, query.expectedDocPaths);

        queryResults.push({
          queryId: query.id,
          query: query.query,
          contexts: sourcePaths,
          contextCount: sourcePaths.length,
          foundExpectedDocs: found,
          firstExpectedDocRank: firstRank,
          relevanceScores,
          ndcgScore: calculateNDCG(relevanceScores, NDCG_K),
          mrrScore: calculateMRR(firstRank),
          latencyMs: perQueryLatencyMs,
          resultSources: sourcePaths.map((path) => path.toLowerCase()),
          sourcePaths,
          error: response.error ?? undefined,
        });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const latencies = queryResults.map((result) => result.latencyMs).sort((a, b) => a - b);
  const p95Index = latencies.length > 0 ? Math.floor(latencies.length * 0.95) : 0;
  const latencyP95Seconds = latencies.length > 0 ? latencies[p95Index] / 1000 : 0;

  let passed = 0;
  let failed = 0;
  let errorCount = 0;

  for (const query of queries) {
    const result = queryResults.find((item) => item.queryId === query.id);
    if (!result) {
      failed++;
      errorCount++;
      continue;
    }

    if (result.error) {
      errorCount++;
    }

    const shouldNotMatch = query.expectedDocPaths.includes('__should_not_match__');
    const success = shouldNotMatch ? !result.foundExpectedDocs : result.foundExpectedDocs;
    if (success) {
      passed++;
    } else {
      failed++;
    }
  }

  const baseline: EvalBaseline = {
    captured_at: new Date().toISOString(),
    model: `${args.model} + rag-docs MCP`,
    query_count: queries.length,
    failed_query_count: failed,
    error_query_count: errorCount,
    metrics: {
      hitRate: queries.length > 0 ? passed / queries.length : 0,
      'nDCG@10':
        queryResults.length > 0
          ? queryResults.reduce((sum, result) => sum + result.ndcgScore, 0) / queryResults.length
          : 0,
      MRR:
        queryResults.length > 0
          ? queryResults.reduce((sum, result) => sum + result.mrrScore, 0) / queryResults.length
          : 0,
      latency_p95: latencyP95Seconds,
    },
    query_results: queryResults,
  };

  const json = JSON.stringify(baseline, null, 2);
  if (args.outPath) {
    mkdirSync(dirname(args.outPath), { recursive: true });
    writeFileSync(args.outPath, json, 'utf8');
  }

  if (args.json) {
    console.log(json);
    return;
  }

  console.log('\nMetrics');
  console.log('-------');
  console.log(`Hit Rate: ${(baseline.metrics.hitRate * 100).toFixed(1)}%`);
  console.log(`nDCG@10: ${baseline.metrics['nDCG@10'].toFixed(3)}`);
  console.log(`MRR: ${baseline.metrics.MRR.toFixed(3)}`);
  console.log(`Latency p95: ${(baseline.metrics.latency_p95 ?? 0).toFixed(3)}s`);
  console.log(`Passed: ${passed}/${queries.length}`);
  console.log(`Errors: ${errorCount}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
