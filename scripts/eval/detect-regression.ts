/**
 * @module eval/detect-regression
 * @description Automated regression detection for RAG evaluation baselines.
 *
 * This script:
 * 1. Finds the latest and previous baselines in .data/eval/baselines/
 * 2. Compares key metrics between baselines
 * 3. Flags regressions (>5% drop) and improvements (>5% gain)
 * 4. Generates formatted regression reports
 * 5. Optionally sends Slack notifications
 *
 * Usage:
 *   bun run scripts/eval/detect-regression.ts
 *   bun run scripts/eval/detect-regression.ts --threshold 0.03
 *   bun run scripts/eval/detect-regression.ts --slack https://hooks.slack.com/...
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalMetrics } from './types.js';

// =============================================================================
// Configuration
// =============================================================================

/** Default threshold for regression detection (5% drop) */
const REGRESSION_THRESHOLD = 0.05;

/** Default threshold for improvement detection (5% gain) */
const IMPROVEMENT_THRESHOLD = 0.05;

/** Key metrics to monitor for regression */
const KEY_METRICS: (keyof EvalMetrics)[] = ['hitRate', 'nDCG@10', 'MRR'];

/** Directory paths */
const BASELINES_DIR = join(process.cwd(), '.data', 'eval', 'baselines');
const FALLBACK_DIR = join(process.cwd(), '.data', 'eval');
const REGRESSIONS_DIR = join(process.cwd(), '.data', 'eval', 'regressions');

// =============================================================================
// Types
// =============================================================================

/**
 * Baseline data structure
 */
interface BaselineData {
  captured_at: string;
  metrics: EvalMetrics;
  query_count: number;
  model?: string;
  environment?: {
    commit_hash?: string;
    branch?: string;
    category?: string;
    mode?: string;
  };
}

/**
 * Metric change direction
 */
type ChangeDirection = 'regression' | 'improvement' | 'unchanged';

/**
 * Single metric comparison result
 */
interface MetricComparison {
  name: string;
  previous: number;
  current: number;
  change: number;
  changePercent: number;
  direction: ChangeDirection;
  isRegression: boolean;
  isImprovement: boolean;
}

/**
 * Complete regression detection result
 */
interface RegressionReport {
  generatedAt: string;
  previousBaseline: BaselineData;
  currentBaseline: BaselineData;
  comparisons: MetricComparison[];
  regressions: MetricComparison[];
  improvements: MetricComparison[];
  hasRegression: boolean;
  hasImprovement: boolean;
  summary: {
    totalMetrics: number;
    regressions: number;
    improvements: number;
    unchanged: number;
  };
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Get all baseline files from directory, sorted by date (newest first)
 */
function getBaselineFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(
    (file) => file.startsWith('baseline_') && file.endsWith('.json')
  );

  // Sort by filename (which includes timestamp) - newest first
  return files.sort().reverse();
}

/**
 * Load baseline from file
 */
function loadBaseline(filePath: string): BaselineData {
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as BaselineData;
}

/**
 * Find the latest and previous baselines
 */
function findBaselines(): {
  latest: BaselineData;
  previous: BaselineData;
  latestPath: string;
  previousPath: string;
} | null {
  // Try baselines directory first
  let files = getBaselineFiles(BASELINES_DIR);
  let baseDir = BASELINES_DIR;

  // Fall back to main eval directory if no files found
  if (files.length < 2) {
    files = getBaselineFiles(FALLBACK_DIR);
    baseDir = FALLBACK_DIR;
  }

  if (files.length < 2) {
    return null;
  }

  const latestPath = join(baseDir, files[0]);
  const previousPath = join(baseDir, files[1]);

  return {
    latest: loadBaseline(latestPath),
    previous: loadBaseline(previousPath),
    latestPath,
    previousPath,
  };
}

/**
 * Calculate percentage change
 */
function calculatePercentChange(previous: number, current: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
}

/**
 * Determine change direction
 */
function getChangeDirection(
  metricName: string,
  changePercent: number,
  regressionThreshold: number,
  improvementThreshold: number
): ChangeDirection {
  // For latency metrics, lower is better
  const isLatency = metricName.toLowerCase().includes('latency');

  if (isLatency) {
    if (changePercent > regressionThreshold * 100) return 'regression';
    if (changePercent < -improvementThreshold * 100) return 'improvement';
  } else {
    if (changePercent < -regressionThreshold * 100) return 'regression';
    if (changePercent > improvementThreshold * 100) return 'improvement';
  }

  return 'unchanged';
}

/**
 * Compare two baselines and detect regressions
 */
function detectRegressions(
  previous: BaselineData,
  current: BaselineData,
  options: { regressionThreshold: number; improvementThreshold: number }
): RegressionReport {
  const comparisons: MetricComparison[] = [];
  const regressions: MetricComparison[] = [];
  const improvements: MetricComparison[] = [];

  // Compare key metrics
  for (const metricName of KEY_METRICS) {
    const previousValue = previous.metrics[metricName] ?? 0;
    const currentValue = current.metrics[metricName] ?? 0;
    const change = currentValue - previousValue;
    const changePercent = calculatePercentChange(previousValue, currentValue);
    const direction = getChangeDirection(
      metricName,
      changePercent,
      options.regressionThreshold,
      options.improvementThreshold
    );

    const comparison: MetricComparison = {
      name: metricName,
      previous: previousValue,
      current: currentValue,
      change,
      changePercent,
      direction,
      isRegression: direction === 'regression',
      isImprovement: direction === 'improvement',
    };

    comparisons.push(comparison);

    if (comparison.isRegression) {
      regressions.push(comparison);
    } else if (comparison.isImprovement) {
      improvements.push(comparison);
    }
  }

  const unchangedCount = comparisons.length - regressions.length - improvements.length;

  return {
    generatedAt: new Date().toISOString(),
    previousBaseline: previous,
    currentBaseline: current,
    comparisons,
    regressions,
    improvements,
    hasRegression: regressions.length > 0,
    hasImprovement: improvements.length > 0,
    summary: {
      totalMetrics: comparisons.length,
      regressions: regressions.length,
      improvements: improvements.length,
      unchanged: unchangedCount,
    },
  };
}

// =============================================================================
// Report Generation
// =============================================================================

/**
 * Format percentage change with sign
 */
function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/**
 * Generate formatted console output
 */
function generateConsoleOutput(report: RegressionReport): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push('╔════════════════════════════════════════════════════════════════╗');
  lines.push('║         RAG Evaluation Regression Detection Report             ║');
  lines.push('╚════════════════════════════════════════════════════════════════╝');
  lines.push('');

  // Baseline info
  lines.push(
    `📅 Previous Baseline: ${new Date(report.previousBaseline.captured_at).toLocaleString()}`
  );
  lines.push(
    `📅 Current Baseline:  ${new Date(report.currentBaseline.captured_at).toLocaleString()}`
  );
  lines.push(`🔢 Previous Queries:  ${report.previousBaseline.query_count}`);
  lines.push(`🔢 Current Queries:   ${report.currentBaseline.query_count}`);
  lines.push('');

  // Regressions section
  if (report.hasRegression) {
    lines.push('📉 REGRESSIONS DETECTED');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const reg of report.regressions) {
      lines.push('');
      lines.push(`  Metric:    ${reg.name}`);
      lines.push(`  Previous:  ${reg.previous.toFixed(4)}`);
      lines.push(`  Current:   ${reg.current.toFixed(4)}`);
      lines.push(`  Change:    ${formatPercent(reg.changePercent)}`);
      lines.push(`  Threshold: -${(REGRESSION_THRESHOLD * 100).toFixed(0)}%`);
    }
    lines.push('');
  }

  // Improvements section
  if (report.hasImprovement) {
    lines.push('📈 IMPROVEMENTS DETECTED');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const imp of report.improvements) {
      lines.push('');
      lines.push(`  Metric:    ${imp.name}`);
      lines.push(`  Previous:  ${imp.previous.toFixed(4)}`);
      lines.push(`  Current:   ${imp.current.toFixed(4)}`);
      lines.push(`  Change:    ${formatPercent(imp.changePercent)}`);
      lines.push(`  Threshold: +${(IMPROVEMENT_THRESHOLD * 100).toFixed(0)}%`);
    }
    lines.push('');
  }

  // All metrics comparison table
  lines.push('📊 ALL METRICS COMPARISON');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('  Metric    │ Previous │ Current  │ Change   │ Status     ');
  lines.push('  ──────────┼──────────┼──────────┼──────────┼────────────');

  for (const comp of report.comparisons) {
    const name = comp.name.padEnd(9);
    const prev = comp.previous.toFixed(4).padStart(8);
    const curr = comp.current.toFixed(4).padStart(8);
    const change = formatPercent(comp.changePercent).padStart(8);
    const status = comp.isRegression
      ? '❌ REGRESSION'
      : comp.isImprovement
        ? '✅ IMPROVED'
        : '➖ unchanged';
    lines.push(`  ${name} │ ${prev} │ ${curr} │ ${change} │ ${status}`);
  }

  lines.push('');

  // Summary
  lines.push('📋 SUMMARY');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`  Total Metrics:  ${report.summary.totalMetrics}`);
  lines.push(`  Regressions:    ${report.summary.regressions}`);
  lines.push(`  Improvements:   ${report.summary.improvements}`);
  lines.push(`  Unchanged:      ${report.summary.unchanged}`);
  lines.push('');

  // Overall status
  if (report.hasRegression) {
    lines.push('⚠️  STATUS: REGRESSION DETECTED - Review required');
  } else if (report.hasImprovement) {
    lines.push('✅ STATUS: All metrics stable or improved');
  } else {
    lines.push('✅ STATUS: No significant changes detected');
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Generate Slack-compatible message
 */
function generateSlackMessage(report: RegressionReport): object {
  const blocks: object[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: report.hasRegression ? '📉 RAG Regression Detected' : '📊 RAG Evaluation Report',
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Previous:*\n${new Date(report.previousBaseline.captured_at).toLocaleDateString()}`,
        },
        {
          type: 'mrkdwn',
          text: `*Current:*\n${new Date(report.currentBaseline.captured_at).toLocaleDateString()}`,
        },
      ],
    },
  ];

  // Add regressions
  if (report.regressions.length > 0) {
    const regressionText = report.regressions
      .map(
        (r) =>
          `• *${r.name}*: ${r.previous.toFixed(2)} → ${r.current.toFixed(2)} (${formatPercent(r.changePercent)})`
      )
      .join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📉 Regressions:*\n${regressionText}`,
      },
    });
  }

  // Add improvements
  if (report.improvements.length > 0) {
    const improvementText = report.improvements
      .map(
        (i) =>
          `• *${i.name}*: ${i.previous.toFixed(2)} → ${i.current.toFixed(2)} (${formatPercent(i.changePercent)})`
      )
      .join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📈 Improvements:*\n${improvementText}`,
      },
    });
  }

  // Add footer
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Threshold: ±${(REGRESSION_THRESHOLD * 100).toFixed(0)}% | Generated: ${new Date().toLocaleString()}`,
      },
    ],
  });

  return { blocks };
}

/**
 * Send Slack notification
 */
async function sendSlackNotification(webhookUrl: string, report: RegressionReport): Promise<void> {
  const message = generateSlackMessage(report);

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack notification failed: ${response.status} ${response.statusText}`);
  }

  console.log('✅ Slack notification sent successfully');
}

// =============================================================================
// Main
// =============================================================================

interface Options {
  regressionThreshold: number;
  improvementThreshold: number;
  slackWebhook?: string;
  silent?: boolean;
  saveReport?: boolean;
}

/**
 * Main regression detection function
 */
export async function detectRegression(
  options: Options = {
    regressionThreshold: REGRESSION_THRESHOLD,
    improvementThreshold: IMPROVEMENT_THRESHOLD,
  }
): Promise<RegressionReport | null> {
  // Find baselines
  const baselines = findBaselines();

  if (!baselines) {
    if (!options.silent) {
      console.error('❌ Error: Need at least 2 baselines to compare');
      console.error(`   Checked directories:`);
      console.error(`   - ${BASELINES_DIR}`);
      console.error(`   - ${FALLBACK_DIR}`);
      console.error(`\n   Run 'bun run scripts/eval/capture-baseline.ts' to create baselines.`);
    }
    return null;
  }

  // Detect regressions
  const report = detectRegressions(baselines.previous, baselines.latest, {
    regressionThreshold: options.regressionThreshold,
    improvementThreshold: options.improvementThreshold,
  });

  // Output to console
  if (!options.silent) {
    console.log(generateConsoleOutput(report));
  }

  // Save report
  if (options.saveReport !== false) {
    if (!existsSync(REGRESSIONS_DIR)) {
      mkdirSync(REGRESSIONS_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = join(REGRESSIONS_DIR, `regression_${timestamp}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    if (!options.silent) {
      console.log(`📄 Report saved to: ${reportPath}`);
    }
  }

  // Send Slack notification
  if (options.slackWebhook) {
    try {
      await sendSlackNotification(options.slackWebhook, report);
    } catch (error) {
      console.error(
        `❌ Failed to send Slack notification: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return report;
}

/**
 * CLI main function
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  const thresholdIdx = args.findIndex((arg) => arg === '--threshold' || arg === '-t');
  const slackIdx = args.findIndex((arg) => arg === '--slack' || arg === '-s');
  const silentFlag = args.includes('--silent');
  const noSaveFlag = args.includes('--no-save');

  // Show help
  if (args.includes('--help') || args.includes('-h')) {
    console.log('RAG Regression Detection');
    console.log('========================\n');
    console.log(
      'Detects quality regressions by comparing the latest baseline with the previous one.\n'
    );
    console.log('Usage:');
    console.log('  bun run scripts/eval/detect-regression.ts [options]\n');
    console.log('Options:');
    console.log('  -t, --threshold <n>   Regression threshold (default: 0.05 = 5%)');
    console.log('  -s, --slack <url>     Slack webhook URL for notifications');
    console.log('  --silent              Suppress console output');
    console.log("  --no-save             Don't save report to file");
    console.log('  -h, --help            Show this help\n');
    console.log('Examples:');
    console.log('  bun run scripts/eval/detect-regression.ts');
    console.log('  bun run scripts/eval/detect-regression.ts --threshold 0.03');
    console.log('  bun run scripts/eval/detect-regression.ts --slack $SLACK_WEBHOOK_URL');
    process.exit(0);
  }

  const threshold = thresholdIdx !== -1 ? parseFloat(args[thresholdIdx + 1]) : REGRESSION_THRESHOLD;
  const slackWebhook = slackIdx !== -1 ? args[slackIdx + 1] : undefined;

  if (thresholdIdx !== -1 && Number.isNaN(threshold)) {
    console.error('❌ Error: --threshold requires a valid number');
    process.exit(1);
  }

  const report = await detectRegression({
    regressionThreshold: threshold,
    improvementThreshold: threshold,
    slackWebhook,
    silent: silentFlag,
    saveReport: !noSaveFlag,
  });

  if (!report) {
    process.exit(1);
  }

  // Exit with error code if regressions detected
  if (report.hasRegression) {
    process.exit(2);
  }

  process.exit(0);
}

// Only run main if this file is executed directly
if (require.main === module) {
  main();
}
