/**
 * @module eval/trend-report
 * @description Generates trend report from baseline history.
 *
 * This script:
 * 1. Reads all baseline files from .data/eval/baselines/
 * 2. Parses and sorts them by timestamp
 * 3. Generates sparklines for each metric
 * 4. Creates trends.md with history and indicators
 *
 * Usage:
 *   bun run scripts/eval/trend-report.ts
 *   bun run scripts/eval/trend-report.ts --output custom-trends.md
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvalMetrics } from './types.js';

/**
 * Baseline data structure
 */
interface BaselineData {
  captured_at: string;
  metrics: EvalMetrics;
  query_count: number;
  environment?: {
    commit_hash?: string;
    branch?: string;
    model?: string;
    category?: string;
    mode?: string;
  };
  saved_path?: string;
}

/**
 * Parsed baseline with additional metadata
 */
interface ParsedBaseline extends BaselineData {
  filename: string;
  timestamp: Date;
}

/**
 * Sparkline characters (using Unicode block elements)
 */
const SPARKLINE_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Load all baselines from the baselines directory
 */
function loadAllBaselines(baselinesDir: string): ParsedBaseline[] {
  if (!existsSync(baselinesDir)) {
    return [];
  }

  const files = readdirSync(baselinesDir)
    .filter((f) => f.startsWith('baseline_') && f.endsWith('.json'))
    .map((f) => {
      const filePath = join(baselinesDir, f);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content) as BaselineData;
        return {
          ...data,
          filename: f,
          timestamp: new Date(data.captured_at),
        };
      } catch (error) {
        console.warn(
          `⚠️  Warning: Failed to parse ${f}: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
    })
    .filter((b): b is ParsedBaseline => b !== null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return files;
}

/**
 * Generate sparkline from array of values
 */
function generateSparkline(values: number[]): string {
  if (values.length === 0) return '─';
  if (values.length === 1) return '●';

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  if (range === 0) {
    return '─'.repeat(values.length);
  }

  return values
    .map((v) => {
      const normalized = (v - min) / range;
      const index = Math.floor(normalized * (SPARKLINE_CHARS.length - 1));
      return SPARKLINE_CHARS[Math.min(index, SPARKLINE_CHARS.length - 1)];
    })
    .join('');
}

/**
 * Calculate trend indicator
 */
function getTrendIndicator(values: number[]): string {
  if (values.length < 2) return '➖';

  const first = values[0];
  const last = values[values.length - 1];
  const change = ((last - first) / first) * 100;

  if (Math.abs(change) < 1) return '➖';
  if (change > 0) return '📈';
  return '📉';
}

/**
 * Format metric value based on metric type
 */
function formatMetricValue(name: string, value: number): string {
  // Latency in seconds or ms
  if (name.toLowerCase().includes('latency')) {
    return `${value.toFixed(3)}s`;
  }
  // Percentages/rates
  if (name.toLowerCase().includes('rate') || value <= 1) {
    return `${(value * 100).toFixed(1)}%`;
  }
  return value.toFixed(3);
}

/**
 * Get significant changes between consecutive baselines
 */
function getSignificantChanges(baselines: ParsedBaseline[]): string[] {
  if (baselines.length < 2) return [];

  const changes: string[] = [];
  const latest = baselines[baselines.length - 1];
  const previous = baselines[baselines.length - 2];

  const significantThreshold = 5; // 5% change is significant

  for (const [metric, latestValue] of Object.entries(latest.metrics)) {
    const prevValue = previous.metrics[metric as keyof EvalMetrics] ?? 0;
    if (prevValue === 0) continue;

    const change = ((latestValue - prevValue) / prevValue) * 100;

    if (Math.abs(change) >= significantThreshold) {
      const direction = change > 0 ? 'increased' : 'decreased';
      const indicator = metric.toLowerCase().includes('latency')
        ? change > 0
          ? '⚠️'
          : '✅'
        : change > 0
          ? '✅'
          : '⚠️';
      changes.push(`${indicator} **${metric}** ${direction} by ${Math.abs(change).toFixed(1)}%`);
    }
  }

  return changes;
}

/**
 * Generate trends markdown report
 */
function generateTrendsMarkdown(baselines: ParsedBaseline[]): string {
  if (baselines.length === 0) {
    return '# RAG Evaluation Trends\n\nNo baseline data found. Run `bun run scripts/eval/capture-baseline.ts` to create a baseline.\n';
  }

  const lines: string[] = [];

  // Header
  lines.push('# RAG Evaluation Trends\n');
  lines.push(`*Last updated: ${new Date().toISOString()}*\n`);

  // Overview
  lines.push('## Overview\n');
  lines.push(`- **Total Baselines**: ${baselines.length}`);
  lines.push(
    `- **Date Range**: ${baselines[0].timestamp.toISOString().split('T')[0]} to ${baselines[baselines.length - 1].timestamp.toISOString().split('T')[0]}`
  );
  lines.push(
    `- **Latest Commit**: \`${baselines[baselines.length - 1].environment?.commit_hash ?? 'unknown'}\``
  );
  lines.push('');

  // Recent Changes
  const significantChanges = getSignificantChanges(baselines);
  if (significantChanges.length > 0) {
    lines.push('## Recent Significant Changes (Latest vs Previous)\n');
    for (const change of significantChanges) {
      lines.push(`- ${change}`);
    }
    lines.push('');
  }

  // Metrics Trends
  lines.push('## Metric Trends\n');
  lines.push('| Metric | Latest | Min | Max | Trend | Sparkline |');
  lines.push('|--------|--------|-----|-----|-------|-----------|');

  // Get all metric names from first baseline
  const metricNames = Object.keys(baselines[0].metrics);

  for (const metricName of metricNames) {
    const values = baselines.map((b) => b.metrics[metricName as keyof EvalMetrics] ?? 0);
    const latest = values[values.length - 1];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const sparkline = generateSparkline(values);
    const trend = getTrendIndicator(values);

    lines.push(
      `| ${metricName} | ${formatMetricValue(metricName, latest)} | ${formatMetricValue(metricName, min)} | ${formatMetricValue(metricName, max)} | ${trend} | ${sparkline} |`
    );
  }

  lines.push('');

  // Baseline History Table
  lines.push('## Baseline History\n');
  lines.push('| Date | Commit | Queries | Mode | hitRate | nDCG@10 | MRR | Latency p95 |');
  lines.push('|------|--------|---------|------|---------|---------|-----|-------------|');

  // Show last 10 baselines (or all if less than 10)
  const recentBaselines = baselines.slice(-10);

  for (const baseline of recentBaselines) {
    const date = baseline.timestamp.toISOString().replace('T', ' ').slice(0, 19);
    const commit = baseline.environment?.commit_hash ?? 'unknown';
    const queries = baseline.query_count;
    const mode = baseline.environment?.mode ?? '-';
    const hitRate = formatMetricValue('hitRate', baseline.metrics.hitRate);
    const ndcg = formatMetricValue('nDCG@10', baseline.metrics['nDCG@10']);
    const mrr = formatMetricValue('MRR', baseline.metrics.MRR);
    const latency = baseline.metrics.latency_p95
      ? formatMetricValue('latency', baseline.metrics.latency_p95)
      : '-';

    lines.push(
      `| ${date} | \`${commit}\` | ${queries} | ${mode} | ${hitRate} | ${ndcg} | ${mrr} | ${latency} |`
    );
  }

  lines.push('');

  // All Baselines List
  lines.push('## All Baselines\n');
  lines.push('<details>');
  lines.push('<summary>Click to expand full list</summary>\n');

  for (const baseline of baselines) {
    const date = baseline.timestamp.toISOString().replace('T', ' ').slice(0, 19);
    const filename = baseline.filename;
    lines.push(`- **${date}** - \`${filename}\``);
  }

  lines.push('</details>');
  lines.push('');

  // Footer
  lines.push('---\n');
  lines.push('*Generated by `bun run scripts/eval/trend-report.ts`*');

  return lines.join('\n');
}

/**
 * Generate and save trend report
 */
export function generateTrendReport(
  options: { baselinesDir?: string; outputPath?: string; silent?: boolean } = {}
): { markdown: string; outputPath: string; baselineCount: number } {
  const baselinesDir = options.baselinesDir ?? join(process.cwd(), '.data', 'eval', 'baselines');
  const outputPath = options.outputPath ?? join(process.cwd(), '.data', 'eval', 'trends.md');

  if (!options.silent) {
    console.log('📈 Generating Trend Report');
    console.log('========================\n');
  }

  // Load all baselines
  const baselines = loadAllBaselines(baselinesDir);

  if (!options.silent) {
    console.log(`📊 Loaded ${baselines.length} baseline(s)`);
  }

  // Generate markdown
  const markdown = generateTrendsMarkdown(baselines);

  // Write to file
  writeFileSync(outputPath, markdown);

  if (!options.silent) {
    console.log(`\n✅ Report saved to: ${outputPath}`);
    console.log(`   Baselines included: ${baselines.length}`);
  }

  return { markdown, outputPath, baselineCount: baselines.length };
}

// =============================================================================
// CLI
// =============================================================================

function main(): void {
  const args = process.argv.slice(2);

  // Parse arguments
  const outputIdx = args.findIndex((arg) => arg === '--output' || arg === '-o');
  const baselinesDirIdx = args.findIndex((arg) => arg === '--baselines-dir' || arg === '-d');

  const options: { outputPath?: string; baselinesDir?: string } = {};

  if (outputIdx !== -1 && args[outputIdx + 1]) {
    options.outputPath = resolve(args[outputIdx + 1]);
  }

  if (baselinesDirIdx !== -1 && args[baselinesDirIdx + 1]) {
    options.baselinesDir = resolve(args[baselinesDirIdx + 1]);
  }

  try {
    generateTrendReport(options);
  } catch (error) {
    console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Only run main if this file is executed directly
if (require.main === module) {
  main();
}
