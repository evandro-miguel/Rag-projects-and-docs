/**
 * @module eval/drift-check
 * @description Daily drift detection job for production monitoring.
 *
 * This script:
 * 1. Fetches query samples from the last 24 hours
 * 2. Computes retrieval metrics on sampled queries
 * 3. Compares against baseline (from T-00 capture-baseline)
 * 4. Alerts if any metric drops > 10%
 *
 * Usage:
 *   bun run scripts/eval/drift-check.ts
 *   bun run scripts/eval/drift-check.ts --alert  # Send alerts if drift detected
 *
 * Environment variables:
 *   DRIFT_ALERT_THRESHOLD - Percentage threshold for alerts (default: 10)
 *   DISCORD_WEBHOOK_URL - Discord webhook for alerts
 *   SLACK_WEBHOOK_URL - Slack webhook for alerts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import type { EvalMetrics } from './types.js';

// Note: Canonical thresholds (DEFAULT_THRESHOLDS, etc.) are not used here because
// drift detection uses relative change thresholds (DRIFT_ALERT_THRESHOLD) rather than
// absolute quality targets. The drift algorithm compares current metrics against a
// captured baseline, not against fixed threshold values.

dotenv.config({ path: '.env.local' });

// =============================================================================
// TYPES
// =============================================================================

interface QuerySample {
  _id: string;
  query: string;
  resultsCount: number;
  topScore?: number;
  retrievedChunkIds?: string[];
  retrievedDocumentIds?: string[];
  latencyMs?: number;
  responseTimeMs: number;
  sampledAt: number;
  evaluated: boolean;
  actualRelevance?: {
    humanRating?: number;
    clickThrough?: boolean;
    dwellTimeMs?: number;
    copyAction?: boolean;
    score?: number;
  };
}

interface DriftResult {
  metricName: string;
  currentValue: number;
  baselineValue: number;
  deltaPercent: number;
  threshold: number;
  alertTriggered: boolean;
}

interface DriftReport {
  timestamp: string;
  windowStart: number;
  windowEnd: number;
  sampleCount: number;
  results: DriftResult[];
  hasAlerts: boolean;
  alertSummary: string[];
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Drift detection threshold (percentage drop that triggers an alert).
 * This is drift-specific and different from canonical quality thresholds.
 * - DRIFT_ALERT_THRESHOLD: Relative change threshold (e.g., 10% drop from baseline)
 * - DEFAULT_THRESHOLDS: Absolute metric targets (e.g., hitRate >= 0.9)
 */
const DRIFT_ALERT_THRESHOLD = Number.parseFloat(process.env.DRIFT_ALERT_THRESHOLD ?? '10');
const WINDOW_HOURS = 24;

// =============================================================================
// BASELINE LOADING
// =============================================================================

function findLatestBaseline(): { path: string; metrics: EvalMetrics } | null {
  const evalDir = join(process.cwd(), '.agents', 'eval');

  try {
    const { readdirSync } = require('node:fs');
    const files = readdirSync(evalDir)
      .filter((f: string) => f.startsWith('baseline_') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const baselinePath = join(evalDir, files[0]);
    const content = readFileSync(baselinePath, 'utf-8');
    const baseline = JSON.parse(content);

    return { path: baselinePath, metrics: baseline.metrics };
  } catch {
    return null;
  }
}

// =============================================================================
// METRICS CALCULATION FROM SAMPLES
// =============================================================================

function calculateMetricsFromSamples(samples: QuerySample[]): Partial<EvalMetrics> {
  if (samples.length === 0) {
    return {};
  }

  // Calculate average results count (proxy for recall)
  const _avgResultsCount = samples.reduce((sum, s) => sum + s.resultsCount, 0) / samples.length;

  // Calculate average top score (proxy for precision)
  const samplesWithScore = samples.filter((s) => s.topScore !== undefined);
  const avgTopScore =
    samplesWithScore.length > 0
      ? samplesWithScore.reduce((sum, s) => sum + (s.topScore ?? 0), 0) / samplesWithScore.length
      : 0;

  // Calculate average latency
  const samplesWithLatency = samples.filter((s) => s.latencyMs !== undefined);
  const avgLatencyMs =
    samplesWithLatency.length > 0
      ? samplesWithLatency.reduce((sum, s) => sum + (s.latencyMs ?? 0), 0) /
        samplesWithLatency.length
      : 0;

  // Calculate evaluation rate (how many samples have human feedback)
  const evaluatedSamples = samples.filter((s) => s.evaluated);
  const _evaluationRate = evaluatedSamples.length / samples.length;

  // Calculate relevance from actual feedback (if available)
  const samplesWithRelevance = evaluatedSamples.filter(
    (s) => s.actualRelevance?.score !== undefined
  );
  const _avgRelevanceScore =
    samplesWithRelevance.length > 0
      ? samplesWithRelevance.reduce((sum, s) => sum + (s.actualRelevance?.score ?? 0), 0) /
        samplesWithRelevance.length
      : 0;

  // Map to RAG metrics (simplified approximation)
  // In production, these would be computed from actual retrieval evaluation
  return {
    hitRate: avgTopScore > 0 ? Math.min(1, avgTopScore / 100) : 0.5,
    'nDCG@10': avgTopScore > 0 ? Math.min(1, avgTopScore / 50) : 0.5,
    MRR: avgTopScore > 0 ? Math.min(1, avgTopScore / 30) : 0.5,
    latency_p95: avgLatencyMs / 1000,
  };
}

// =============================================================================
// DRIFT DETECTION
// =============================================================================

function detectDrift(
  current: Partial<EvalMetrics>,
  baseline: EvalMetrics,
  thresholdPercent: number = DRIFT_ALERT_THRESHOLD
): DriftResult[] {
  const results: DriftResult[] = [];
  const _threshold = thresholdPercent / 100;

  const metricConfigs = [
    { name: 'hitRate', baselineKey: 'hitRate' as const },
    { name: 'nDCG@10', baselineKey: 'nDCG@10' as const },
    { name: 'MRR', baselineKey: 'MRR' as const },
  ];

  for (const config of metricConfigs) {
    const currentValue = current[config.baselineKey];
    const baselineValue = baseline[config.baselineKey];

    if (currentValue === undefined || baselineValue === undefined) continue;

    const delta = currentValue - baselineValue;
    const deltaPercent = (delta / baselineValue) * 100;

    // Alert if metric dropped more than threshold
    const alertTriggered = deltaPercent < -thresholdPercent;

    results.push({
      metricName: config.name,
      currentValue,
      baselineValue,
      deltaPercent,
      threshold: thresholdPercent,
      alertTriggered,
    });
  }

  return results;
}

// =============================================================================
// ALERTING
// =============================================================================

interface WebhookPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
    timestamp?: string;
  }>;
  blocks?: any; // Slack blocks format
}

async function sendDiscordAlert(report: DriftReport): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const color = report.hasAlerts ? 0xff0000 : 0x00ff00; // Red if alerts, green otherwise

  const payload: WebhookPayload = {
    username: 'RAG Drift Monitor',
    embeds: [
      {
        title: report.hasAlerts ? '⚠️ Drift Alert Detected' : '✅ Drift Check Passed',
        description: `Evaluated ${report.sampleCount} samples from the last 24 hours.`,
        color,
        fields: report.results.map((r) => ({
          name: r.metricName,
          value: `${r.currentValue.toFixed(3)} (baseline: ${r.baselineValue.toFixed(3)}, Δ: ${r.deltaPercent.toFixed(1)}%) ${r.alertTriggered ? '🚨' : '✓'}`,
          inline: true,
        })),
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to send Discord alert:', error);
    return false;
  }
}

async function sendSlackAlert(report: DriftReport): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const statusEmoji = report.hasAlerts ? ':warning:' : ':white_check_mark:';
  const statusText = report.hasAlerts ? 'Drift Alert Detected' : 'Drift Check Passed';

  const payload: WebhookPayload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${statusEmoji} ${statusText}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Evaluated *${report.sampleCount}* samples from the last 24 hours.`,
        },
      },
      {
        type: 'section',
        fields: report.results.map((r) => ({
          type: 'mrkdwn',
          text: `*${r.metricName}*\n${r.currentValue.toFixed(3)} (Δ: ${r.deltaPercent.toFixed(1)}%) ${r.alertTriggered ? ':rotating_light:' : ':white_check_mark:'}`,
        })),
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to send Slack alert:', error);
    return false;
  }
}

async function sendAlerts(report: DriftReport): Promise<{ discord: boolean; slack: boolean }> {
  const [discord, slack] = await Promise.all([sendDiscordAlert(report), sendSlackAlert(report)]);

  return { discord, slack };
}

// =============================================================================
// REPORT SAVING
// =============================================================================

function saveReport(report: DriftReport): void {
  const evalDir = join(process.cwd(), '.agents', 'eval');
  const filename = `drift_${new Date().toISOString().split('T')[0].replace(/-/g, '')}.json`;
  const outputPath = join(evalDir, filename);

  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report saved to: ${outputPath}`);
}

// =============================================================================
// POSTGRES SAMPLING HELPERS
// =============================================================================

async function fetchSamples(_windowStart: number, _windowEnd: number): Promise<QuerySample[]> {
  console.warn('Postgres query-sampling storage is not implemented yet; no samples fetched.');
  return [];
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const shouldAlert = args.includes('--alert');
  const verbose = args.includes('--verbose') || args.includes('-v');

  console.log('🔍 RAG Drift Detection');
  console.log('========================\n');

  // Calculate time window (last 24 hours)
  const windowEnd = Date.now();
  const windowStart = windowEnd - WINDOW_HOURS * 60 * 60 * 1000;

  console.log(
    `📅 Evaluation window: ${new Date(windowStart).toISOString()} to ${new Date(windowEnd).toISOString()}`
  );

  // Load baseline
  const baseline = findLatestBaseline();
  if (!baseline) {
    console.error('❌ No baseline found. Run capture-baseline.ts first.');
    process.exit(1);
  }
  console.log(`📂 Using baseline: ${baseline.path}`);

  // Fetch samples
  console.log('\n📊 Fetching query samples...');
  const samples = await fetchSamples(windowStart, windowEnd);
  console.log(`   Found ${samples.length} samples`);

  if (samples.length === 0) {
    console.log('\n⚠️ No samples found in the evaluation window.');
    console.log('   Tip: Ensure sampling is enabled and queries are being captured.');
    process.exit(0);
  }

  // Calculate metrics from samples
  console.log('\n📈 Calculating metrics from samples...');
  const currentMetrics = calculateMetricsFromSamples(samples);

  if (verbose) {
    console.log('\n   Current metrics:');
    for (const [key, value] of Object.entries(currentMetrics)) {
      console.log(`   - ${key}: ${value?.toFixed(3)}`);
    }
  }

  // Detect drift
  console.log('\n🔬 Detecting drift...');
  const driftResults = detectDrift(currentMetrics, baseline.metrics);

  // Build report
  const alertSummary: string[] = [];
  for (const result of driftResults) {
    const status = result.alertTriggered ? '🚨' : '✅';
    const delta =
      result.deltaPercent >= 0
        ? `+${result.deltaPercent.toFixed(1)}%`
        : `${result.deltaPercent.toFixed(1)}%`;
    console.log(
      `   ${status} ${result.metricName}: ${result.currentValue.toFixed(3)} vs ${result.baselineValue.toFixed(3)} (Δ: ${delta})`
    );

    if (result.alertTriggered) {
      alertSummary.push(
        `${result.metricName}: ${result.currentValue.toFixed(3)} (baseline: ${result.baselineValue.toFixed(3)}, Δ: ${delta})`
      );
    }
  }

  const hasAlerts = driftResults.some((r) => r.alertTriggered);
  const report: DriftReport = {
    timestamp: new Date().toISOString(),
    windowStart,
    windowEnd,
    sampleCount: samples.length,
    results: driftResults,
    hasAlerts,
    alertSummary,
  };

  // Save report
  saveReport(report);

  // Send alerts if requested
  if (shouldAlert && hasAlerts) {
    console.log('\n📤 Sending alerts...');
    const alertResults = await sendAlerts(report);
    console.log(`   Discord: ${alertResults.discord ? '✅' : '❌'}`);
    console.log(`   Slack: ${alertResults.slack ? '✅' : '❌'}`);
  }

  // Exit with appropriate code
  if (hasAlerts) {
    console.log('\n🚨 DRIFT DETECTED - Action required!');
    process.exit(1);
  } else {
    console.log('\n✅ No drift detected - All metrics within threshold.');
    process.exit(0);
  }
}

main().catch(console.error);
