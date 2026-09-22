#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

type Mode = 'light' | 'standard' | 'deep' | 'diagnostic';
type Dtype = 'q8' | 'fp32';

interface Fixture {
  id: string;
  query: string;
  documents: string[];
  expectedTopIndex: number;
}

interface RerankResponse {
  scores: number[];
  processingTimeMs: number;
  model: string;
}

interface Sample {
  fixtureId: string;
  clientLatencyMs: number;
  serverLatencyMs: number;
  scores: number[];
}

interface ArmResult {
  dtype: Dtype;
  setupDurationMs: number;
  requestLatencyMs: number[];
  serverLatencyMs: number[];
  rssPeakMb: number;
  top1Accuracy: number;
  samples: Sample[];
  finalScoresByFixture: Record<string, number[]>;
  logs: { stdout: string; stderr: string };
}

const MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const MODES: Record<Mode, { repetitions: number; warmups: number }> = {
  light: { repetitions: 1, warmups: 1 },
  standard: { repetitions: 3, warmups: 1 },
  deep: { repetitions: 5, warmups: 1 },
  diagnostic: { repetitions: 1, warmups: 0 },
};

const fixtures: Fixture[] = [
  {
    id: 'password-reset',
    query: 'How do I reset a forgotten password?',
    expectedTopIndex: 0,
    documents: [
      'To reset a forgotten password, open the sign-in page, select Forgot password, and follow the email recovery link.',
      'Administrators can export monthly billing invoices from the finance settings page.',
      'The application uses PostgreSQL for relational data and transaction storage.',
      'Dark mode follows the operating system theme unless the user selects another preference.',
      'Upload limits depend on the subscription tier and the selected storage region.',
      'The dashboard supports sorting tables by clicking a column header.',
    ],
  },
  {
    id: 'typescript-error',
    query: 'How can I find the cause of a TypeScript type error?',
    expectedTopIndex: 0,
    documents: [
      'Run the TypeScript compiler with no emit, inspect the first diagnostic, and trace the incompatible value to its declared type.',
      'Database backups run every night and remain encrypted at rest.',
      'The image pipeline creates thumbnails in three responsive sizes.',
      'Users can invite team members from the organization settings screen.',
      'HTTP caching reduces repeated downloads of static browser assets.',
      'Invoices can be paid using a supported credit card or bank transfer.',
    ],
  },
  {
    id: 'docker-health',
    query: 'How do I check whether a Docker container is healthy?',
    expectedTopIndex: 0,
    documents: [
      'Use docker inspect to read the container health status, and review the configured healthcheck command when the status is unhealthy.',
      'The editor saves drafts automatically every thirty seconds.',
      'Password policies require at least twelve characters for administrator accounts.',
      'Search results can be filtered by creation date and content owner.',
      'The reporting API returns JSON and supports cursor pagination.',
      'Keyboard shortcuts can be customized in the accessibility preferences.',
    ],
  },
  {
    id: 'postgres-index',
    query: 'How can I improve a slow PostgreSQL query?',
    expectedTopIndex: 0,
    documents: [
      'Use EXPLAIN ANALYZE to inspect the query plan, then add or adjust selective indexes only after identifying the expensive scan.',
      'The mobile application can send optional push notifications.',
      'A design token defines the standard border radius for form controls.',
      'Release notes are generated from merged pull requests each week.',
      'The support team answers account questions during business hours.',
      'CSV exports use UTF-8 encoding and include a header row.',
    ],
  },
];

function parseArgs(): { mode: Mode; output: string } {
  const args = process.argv.slice(2);
  const modeIndex = args.indexOf('--mode');
  const outputIndex = args.indexOf('--output');
  const mode = (modeIndex >= 0 ? args[modeIndex + 1] : 'standard') as Mode;
  if (!(mode in MODES)) throw new Error(`Unsupported mode: ${mode}`);
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const output =
    outputIndex >= 0 ? args[outputIndex + 1] : `.data/tmp/reranker-dtype-benchmark/${timestamp}`;
  if (!output) throw new Error('--output requires a path');
  return { mode, output: resolve(output) };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function rank(values: number[]): number[] {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value);
  const ranks = new Array<number>(values.length);
  ordered.forEach((entry, index) => {
    ranks[entry.index] = index + 1;
  });
  return ranks;
}

function spearman(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 2)
    throw new Error('Cannot compare score vectors');
  const leftRanks = rank(left);
  const rightRanks = rank(right);
  const squaredDistance = leftRanks.reduce((sum, value, index) => {
    const delta = value - (rightRanks[index] ?? 0);
    return sum + delta * delta;
  }, 0);
  const n = left.length;
  return 1 - (6 * squaredDistance) / (n * (n * n - 1));
}

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The process may still be binding the loopback port.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Reranker did not become healthy at ${url}`);
}

async function readRssMb(pid: number): Promise<number> {
  const status = await Bun.file(`/proc/${pid}/status`).text();
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) / 1024 : 0;
}

function validateScores(scores: number[], expectedLength: number, dtype: Dtype): void {
  if (scores.length !== expectedLength || scores.some((score) => !Number.isFinite(score))) {
    throw new Error(`${dtype} returned invalid scores`);
  }
  if (new Set(scores.map((score) => score.toFixed(12))).size === 1) {
    throw new Error(`${dtype} returned uniform scores, which indicates degraded fallback output`);
  }
}

async function requestFixture(baseUrl: string, fixture: Fixture, dtype: Dtype): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/rerank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: fixture.query,
      documents: fixture.documents,
      model: MODEL,
      quantized: dtype === 'q8',
    }),
  });
  const clientLatencyMs = performance.now() - started;
  if (!response.ok)
    throw new Error(
      `${dtype} request failed with HTTP ${response.status}: ${await response.text()}`
    );
  const payload = (await response.json()) as RerankResponse;
  validateScores(payload.scores, fixture.documents.length, dtype);
  return {
    fixtureId: fixture.id,
    clientLatencyMs,
    serverLatencyMs: payload.processingTimeMs,
    scores: payload.scores,
  };
}

async function runArm(
  dtype: Dtype,
  port: number,
  repetitions: number,
  warmups: number
): Promise<ArmResult> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(['bun', 'run', 'scripts/reranking-service.ts'], {
    cwd: process.cwd(),
    env: { ...Bun.env, RERANKING_SERVICE_PORT: String(port), RERANKING_SERVICE_HOST: '127.0.0.1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const started = performance.now();
  const samples: Sample[] = [];
  let setupDurationMs = 0;
  let rssPeakMb = 0;

  try {
    await waitForHealth(baseUrl);
    for (let warmup = 0; warmup < warmups; warmup++) {
      for (const fixture of fixtures) await requestFixture(baseUrl, fixture, dtype);
    }
    setupDurationMs = performance.now() - started;
    rssPeakMb = Math.max(rssPeakMb, await readRssMb(child.pid));

    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const fixture of fixtures) {
        samples.push(await requestFixture(baseUrl, fixture, dtype));
        rssPeakMb = Math.max(rssPeakMb, await readRssMb(child.pid));
      }
    }
  } finally {
    child.kill('SIGTERM');
    await child.exited;
  }

  const logs = { stdout: await stdoutPromise, stderr: await stderrPromise };
  const finalScoresByFixture = Object.fromEntries(
    fixtures.map((fixture) => {
      const sample = [...samples].reverse().find((entry) => entry.fixtureId === fixture.id);
      if (!sample) throw new Error(`${dtype} has no measured sample for ${fixture.id}`);
      return [fixture.id, sample.scores];
    })
  );
  const correct = fixtures.filter((fixture) => {
    const scores = finalScoresByFixture[fixture.id] ?? [];
    const topIndex = scores.indexOf(Math.max(...scores));
    return topIndex === fixture.expectedTopIndex;
  }).length;

  return {
    dtype,
    setupDurationMs,
    requestLatencyMs: samples.map((sample) => sample.clientLatencyMs),
    serverLatencyMs: samples.map((sample) => sample.serverLatencyMs),
    rssPeakMb,
    top1Accuracy: correct / fixtures.length,
    samples,
    finalScoresByFixture,
    logs,
  };
}

function summarizeArm(arm: ArmResult) {
  return {
    dtype: arm.dtype,
    setup_duration_ms: arm.setupDurationMs,
    request_count: arm.requestLatencyMs.length,
    request_latency_mean_ms: mean(arm.requestLatencyMs),
    request_latency_p50_ms: percentile(arm.requestLatencyMs, 0.5),
    request_latency_p95_ms: percentile(arm.requestLatencyMs, 0.95),
    server_latency_mean_ms: mean(arm.serverLatencyMs),
    server_latency_p50_ms: percentile(arm.serverLatencyMs, 0.5),
    server_latency_p95_ms: percentile(arm.serverLatencyMs, 0.95),
    rss_peak_mb: arm.rssPeakMb,
    top1_accuracy: arm.top1Accuracy,
  };
}

async function main(): Promise<void> {
  const { mode, output } = parseArgs();
  const config = MODES[mode];
  await mkdir(resolve(output, 'raw'), { recursive: true });

  const q8 = await runArm('q8', 3461, config.repetitions, config.warmups);
  const fp32 = await runArm('fp32', 3462, config.repetitions, config.warmups);
  const absoluteDeltas: number[] = [];
  const correlations: number[] = [];
  for (const fixture of fixtures) {
    const q8Scores = q8.finalScoresByFixture[fixture.id] ?? [];
    const fp32Scores = fp32.finalScoresByFixture[fixture.id] ?? [];
    correlations.push(spearman(q8Scores, fp32Scores));
    q8Scores.forEach((score, index) => {
      absoluteDeltas.push(Math.abs(score - (fp32Scores[index] ?? 0)));
    });
  }

  const q8Summary = summarizeArm(q8);
  const fp32Summary = summarizeArm(fp32);
  const comparison = {
    score_mae: mean(absoluteDeltas),
    score_max_abs_delta: Math.max(...absoluteDeltas),
    ranking_spearman_mean: mean(correlations),
    request_latency_p50_delta_percent:
      ((fp32Summary.request_latency_p50_ms - q8Summary.request_latency_p50_ms) /
        q8Summary.request_latency_p50_ms) *
      100,
    rss_peak_delta_mb: fp32Summary.rss_peak_mb - q8Summary.rss_peak_mb,
    rss_peak_delta_percent:
      ((fp32Summary.rss_peak_mb - q8Summary.rss_peak_mb) / q8Summary.rss_peak_mb) * 100,
  };
  const status =
    q8.top1Accuracy === 1 && fp32.top1Accuracy === 1 && comparison.ranking_spearman_mean >= 0.95
      ? 'pass'
      : 'fail';
  const run = {
    schema_version: '1.0.0',
    scenario_id: 'reranker-dtype-comparison',
    timestamp: new Date().toISOString(),
    status,
    mode,
    model: MODEL,
    environment: {
      platform: `${process.platform}-${process.arch}`,
      bun_version: Bun.version,
      cpu: process.env.PROCESSOR_IDENTIFIER ?? 'see /proc/cpuinfo',
    },
    execution: {
      repetitions: config.repetitions,
      warmup_runs: config.warmups,
      fixtures_per_repetition: fixtures.length,
      service: 'scripts/reranking-service.ts',
    },
    arms: { q8: q8Summary, fp32: fp32Summary },
    comparison,
    scores: { q8: q8.finalScoresByFixture, fp32: fp32.finalScoresByFixture },
  };

  await Bun.write(resolve(output, 'raw/q8.stdout.log'), q8.logs.stdout);
  await Bun.write(resolve(output, 'raw/q8.stderr.log'), q8.logs.stderr);
  await Bun.write(resolve(output, 'raw/fp32.stdout.log'), fp32.logs.stdout);
  await Bun.write(resolve(output, 'raw/fp32.stderr.log'), fp32.logs.stderr);
  await Bun.write(resolve(output, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  const report = `<!-- markdownlint-disable MD013 -->\n\n# Reranker dtype benchmark\n\nRun status: **${status}**\n\nMode: \`${mode}\`\n\nModel: \`${MODEL}\`\n\n| Metric | q8 | fp32 |\n| --- | ---: | ---: |\n| Warm request p50 | ${q8Summary.request_latency_p50_ms.toFixed(1)} ms | ${fp32Summary.request_latency_p50_ms.toFixed(1)} ms |\n| Warm request p95 | ${q8Summary.request_latency_p95_ms.toFixed(1)} ms | ${fp32Summary.request_latency_p95_ms.toFixed(1)} ms |\n| Server p50 | ${q8Summary.server_latency_p50_ms.toFixed(1)} ms | ${fp32Summary.server_latency_p50_ms.toFixed(1)} ms |\n| Peak RSS | ${q8Summary.rss_peak_mb.toFixed(1)} MiB | ${fp32Summary.rss_peak_mb.toFixed(1)} MiB |\n| Top-1 accuracy | ${(q8Summary.top1_accuracy * 100).toFixed(0)}% | ${(fp32Summary.top1_accuracy * 100).toFixed(0)}% |\n| Setup duration | ${q8Summary.setup_duration_ms.toFixed(1)} ms | ${fp32Summary.setup_duration_ms.toFixed(1)} ms |\n\n## Comparison\n\n- Score MAE: ${comparison.score_mae.toFixed(8)}.\n- Maximum absolute score delta: ${comparison.score_max_abs_delta.toFixed(8)}.\n- Mean Spearman ranking correlation: ${comparison.ranking_spearman_mean.toFixed(6)}.\n- fp32 p50 latency delta versus q8: ${comparison.request_latency_p50_delta_percent.toFixed(1)}%.\n- fp32 peak RSS delta versus q8: ${comparison.rss_peak_delta_mb.toFixed(1)} MiB (${comparison.rss_peak_delta_percent.toFixed(1)}%).\n\nSetup duration includes model initialization and may be affected by the local Hugging Face cache. Warm request latency is the primary performance comparison.\n`;
  await Bun.write(resolve(output, 'report.md'), report);
  console.log(JSON.stringify({ output, ...run }, null, 2));
  if (status !== 'pass') process.exitCode = 1;
}

await main();
