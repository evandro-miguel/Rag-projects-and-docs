import { spawnSync } from 'node:child_process';

type ObservedMcpCall = {
  server: string;
  tool: string;
  status: string;
  error: string | null;
};

type SmokeRun = {
  ok: boolean;
  model: string;
  reasoning_effort: string;
  strict_codex: boolean;
  used_direct_fallback: boolean;
  elapsed_ms: number;
  observed_mcp_calls: ObservedMcpCall[];
  startup_failures: unknown[];
  failures: string[];
};

type BenchmarkRun = {
  iteration: number;
  ok: boolean;
  elapsed_ms: number;
  used_direct_fallback: boolean;
  startup_failures_count: number;
  observed_mcp_calls_count: number;
  failed_mcp_calls_count: number;
  failures: string[];
};

function readArg(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readNumberArg(args: string[], flag: string, fallback: number) {
  const raw = readArg(args, flag);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(args: string[]) {
  return {
    iterations: readNumberArg(args, '--iterations', 3),
    minPassRate: Number.parseFloat(readArg(args, '--min-pass-rate') ?? '1'),
    cwd: readArg(args, '--cwd') ?? process.cwd(),
    projectRoot: readArg(args, '--project-root'),
    includeRoots: readArg(args, '--include-roots'),
    projectQuery: readArg(args, '--project-query'),
    model: readArg(args, '--model') ?? process.env.CODEX_MCP_SMOKE_MODEL ?? 'gpt-5.4-mini',
    reasoningEffort:
      readArg(args, '--reasoning-effort') ?? process.env.CODEX_MCP_SMOKE_REASONING_EFFORT ?? 'low',
    timeoutMs: readNumberArg(args, '--timeout-ms', 300000),
    docsOnly: args.includes('--docs-only'),
    json: args.includes('--json'),
  };
}

function extractJson(stdout: string): SmokeRun {
  for (let index = stdout.indexOf('{'); index !== -1; index = stdout.indexOf('{', index + 1)) {
    try {
      return JSON.parse(stdout.slice(index)) as SmokeRun;
    } catch {
      // Keep scanning in case Bun or Codex printed a prefix before JSON output.
    }
  }

  throw new Error(`Unable to parse smoke JSON output: ${stdout.slice(0, 500)}`);
}

function percentile(values: number[], percentileRank: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function buildSmokeArgs(args: ReturnType<typeof parseArgs>) {
  const smokeArgs = [
    'run',
    'scripts/eval/codex-mcp-smoke.ts',
    '--strict-codex',
    '--json',
    '--model',
    args.model,
    '--reasoning-effort',
    args.reasoningEffort,
    '--timeout-ms',
    String(args.timeoutMs),
  ];

  if (args.docsOnly) {
    smokeArgs.push('--docs-only');
  }
  if (args.projectRoot) {
    smokeArgs.push('--project-root', args.projectRoot);
  }
  if (args.includeRoots) {
    smokeArgs.push('--include-roots', args.includeRoots);
  }
  if (args.projectQuery) {
    smokeArgs.push('--project-query', args.projectQuery);
  }

  return smokeArgs;
}

function summarize(runs: BenchmarkRun[], minPassRate: number) {
  const passCount = runs.filter((run) => run.ok).length;
  const directFallbackCount = runs.filter((run) => run.used_direct_fallback).length;
  const startupFailureCount = runs.filter((run) => run.startup_failures_count > 0).length;
  const failedMcpCallCount = runs.filter((run) => run.failed_mcp_calls_count > 0).length;
  const passRate = runs.length === 0 ? 0 : passCount / runs.length;

  return {
    ok: passRate >= minPassRate && directFallbackCount === 0 && failedMcpCallCount === 0,
    iterations: runs.length,
    min_pass_rate: minPassRate,
    pass_rate: passRate,
    used_direct_fallback_rate: runs.length === 0 ? 0 : directFallbackCount / runs.length,
    startup_failures_rate: runs.length === 0 ? 0 : startupFailureCount / runs.length,
    failed_mcp_calls_rate: runs.length === 0 ? 0 : failedMcpCallCount / runs.length,
    elapsed_ms_p50: percentile(
      runs.map((run) => run.elapsed_ms),
      50
    ),
    elapsed_ms_p95: percentile(
      runs.map((run) => run.elapsed_ms),
      95
    ),
    runs,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs: BenchmarkRun[] = [];

  for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
    const result = spawnSync('bun', buildSmokeArgs(args), {
      cwd: args.cwd,
      encoding: 'utf8',
      env: process.env as Record<string, string>,
      timeout: args.timeoutMs + 30000,
    });

    if (result.error || result.status !== 0) {
      runs.push({
        iteration,
        ok: false,
        elapsed_ms: args.timeoutMs,
        used_direct_fallback: false,
        startup_failures_count: 0,
        observed_mcp_calls_count: 0,
        failed_mcp_calls_count: 0,
        failures: [
          result.error?.message ??
            `codex smoke exited with status ${result.status ?? 'null'}: ${result.stderr}`,
        ],
      });
      continue;
    }

    const smoke = extractJson(result.stdout ?? '');
    runs.push({
      iteration,
      ok: smoke.ok,
      elapsed_ms: smoke.elapsed_ms,
      used_direct_fallback: smoke.used_direct_fallback,
      startup_failures_count: smoke.startup_failures.length,
      observed_mcp_calls_count: smoke.observed_mcp_calls.length,
      failed_mcp_calls_count: smoke.observed_mcp_calls.filter(
        (call) => call.status !== 'completed' || call.error
      ).length,
      failures: smoke.failures,
    });
  }

  const report = summarize(runs, args.minPassRate);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Codex MCP reliability benchmark');
    console.log('==============================');
    console.log(`Iterations: ${report.iterations}`);
    console.log(`Pass rate: ${(report.pass_rate * 100).toFixed(1)}%`);
    console.log(`Direct fallback rate: ${(report.used_direct_fallback_rate * 100).toFixed(1)}%`);
    console.log(`Startup failure rate: ${(report.startup_failures_rate * 100).toFixed(1)}%`);
    console.log(`Failed MCP call rate: ${(report.failed_mcp_calls_rate * 100).toFixed(1)}%`);
    console.log(`Elapsed p50/p95: ${report.elapsed_ms_p50}ms / ${report.elapsed_ms_p95}ms`);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
