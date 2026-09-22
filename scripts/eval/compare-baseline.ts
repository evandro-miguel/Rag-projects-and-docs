/**
 * @module eval/compare-baseline
 * @description Compares two baseline files and shows metric differences.
 *
 * This script:
 * 1. Loads two baseline JSON files
 * 2. Calculates percentage change for each metric
 * 3. Outputs a markdown table with differences
 * 4. Shows improvement/regression indicators
 *
 * Usage:
 *   bun run scripts/eval/compare-baseline.ts --baseline <file1> --compare <file2>
 *   bun run scripts/eval/compare-baseline.ts -b <file1> -c <file2>
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
}

/**
 * Comparison result for a single metric
 */
interface MetricComparison {
  name: string;
  oldValue: number;
  newValue: number;
  change: number;
  changePercent: number;
  direction: 'improved' | 'regressed' | 'unchanged';
}

/**
 * Load baseline from file
 */
function loadBaseline(filePath: string): BaselineData {
  const resolvedPath = resolve(filePath);
  const content = readFileSync(resolvedPath, 'utf-8');
  return JSON.parse(content) as BaselineData;
}

/**
 * Calculate percentage change
 * Formula: (new - old) / old * 100
 */
function calculatePercentChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) {
    return newValue === 0 ? 0 : 100;
  }
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Determine if metric change is improvement or regression
 * For latency: lower is better
 * For all other metrics: higher is better
 */
function getChangeDirection(
  metricName: string,
  changePercent: number
): 'improved' | 'regressed' | 'unchanged' {
  if (Math.abs(changePercent) < 0.01) return 'unchanged';

  const isLatency = metricName.toLowerCase().includes('latency');
  const isPositive = changePercent > 0;

  if (isLatency) {
    return isPositive ? 'regressed' : 'improved';
  }
  return isPositive ? 'improved' : 'regressed';
}

/**
 * Format percentage with sign and color indicator
 */
function formatChange(
  changePercent: number,
  direction: 'improved' | 'regressed' | 'unchanged'
): string {
  const sign = changePercent >= 0 ? '+' : '';
  const formatted = `${sign}${changePercent.toFixed(2)}%`;

  if (direction === 'improved') return `📈 ${formatted}`;
  if (direction === 'regressed') return `📉 ${formatted}`;
  return `➡️  ${formatted}`;
}

/**
 * Compare two baselines
 */
function compareBaselines(
  oldBaseline: BaselineData,
  newBaseline: BaselineData
): MetricComparison[] {
  const comparisons: MetricComparison[] = [];
  const metrics = oldBaseline.metrics;

  for (const [key, oldValue] of Object.entries(metrics)) {
    const newValue = newBaseline.metrics[key as keyof EvalMetrics] ?? 0;
    const change = newValue - oldValue;
    const changePercent = calculatePercentChange(oldValue, newValue);
    const direction = getChangeDirection(key, changePercent);

    comparisons.push({
      name: key,
      oldValue,
      newValue,
      change,
      changePercent,
      direction,
    });
  }

  return comparisons;
}

/**
 * Generate markdown table output
 */
function generateMarkdownTable(
  comparisons: MetricComparison[],
  oldBaseline: BaselineData,
  newBaseline: BaselineData
): string {
  const lines: string[] = [];

  // Header
  lines.push('# Baseline Comparison Report\n');

  // Metadata
  lines.push('## Metadata\n');
  lines.push(`| Property | Old Baseline | New Baseline |`);
  lines.push(`|----------|--------------|--------------|`);
  lines.push(`| Timestamp | ${oldBaseline.captured_at} | ${newBaseline.captured_at} |`);
  lines.push(`| Queries | ${oldBaseline.query_count} | ${newBaseline.query_count} |`);

  if (oldBaseline.environment?.commit_hash && newBaseline.environment?.commit_hash) {
    lines.push(
      `| Commit | \`${oldBaseline.environment.commit_hash}\` | \`${newBaseline.environment.commit_hash}\` |`
    );
  }
  if (oldBaseline.environment?.branch && newBaseline.environment?.branch) {
    lines.push(
      `| Branch | ${oldBaseline.environment.branch} | ${newBaseline.environment.branch} |`
    );
  }
  if (oldBaseline.environment?.mode && newBaseline.environment?.mode) {
    lines.push(`| Mode | ${oldBaseline.environment.mode} | ${newBaseline.environment.mode} |`);
  }

  lines.push('');

  // Metrics comparison table
  lines.push('## Metrics Comparison\n');
  lines.push(`| Metric | Old Value | New Value | Change | Status |`);
  lines.push(`|--------|-----------|-----------|--------|--------|`);

  for (const comp of comparisons) {
    const oldVal = comp.oldValue.toFixed(4);
    const newVal = comp.newValue.toFixed(4);
    const changeStr = formatChange(comp.changePercent, comp.direction);
    const status =
      comp.direction === 'improved'
        ? '✅ Improved'
        : comp.direction === 'regressed'
          ? '❌ Regressed'
          : '➖ Unchanged';
    lines.push(`| ${comp.name} | ${oldVal} | ${newVal} | ${changeStr} | ${status} |`);
  }

  lines.push('');

  // Summary
  const improvedCount = comparisons.filter((c) => c.direction === 'improved').length;
  const regressedCount = comparisons.filter((c) => c.direction === 'regressed').length;
  const unchangedCount = comparisons.filter((c) => c.direction === 'unchanged').length;

  lines.push('## Summary\n');
  lines.push(`- ✅ **Improved**: ${improvedCount} metrics`);
  lines.push(`- ❌ **Regressed**: ${regressedCount} metrics`);
  lines.push(`- ➖ **Unchanged**: ${unchangedCount} metrics`);
  lines.push('');

  // Timestamp
  lines.push(`\n*Report generated: ${new Date().toISOString()}*`);

  return lines.join('\n');
}

/**
 * Print console output (non-markdown)
 */
function printConsoleOutput(comparisons: MetricComparison[]): void {
  console.log('\n📊 Baseline Comparison');
  console.log('=====================\n');

  console.log('Metric              | Old Value | New Value | Change       | Status');
  console.log('--------------------|-----------|-----------|--------------|----------');

  for (const comp of comparisons) {
    const name = comp.name.padEnd(19);
    const oldVal = comp.oldValue.toFixed(4).padStart(9);
    const newVal = comp.newValue.toFixed(4).padStart(9);
    const change = formatChange(comp.changePercent, comp.direction).padStart(12);
    const status =
      comp.direction === 'improved' ? '✅' : comp.direction === 'regressed' ? '❌' : '➖';
    console.log(`${name}| ${oldVal} | ${newVal} | ${change} | ${status}`);
  }

  const improvedCount = comparisons.filter((c) => c.direction === 'improved').length;
  const regressedCount = comparisons.filter((c) => c.direction === 'regressed').length;

  console.log('\n---');
  console.log(
    `Summary: ${improvedCount} improved, ${regressedCount} regressed, ${comparisons.length - improvedCount - regressedCount} unchanged`
  );
}

/**
 * Main comparison function
 */
export function compareBaselinesFromFiles(
  baselinePath: string,
  comparePath: string,
  options: { markdown?: boolean; output?: string; silent?: boolean } = {}
): { markdown: string; comparisons: MetricComparison[] } {
  // Load baselines
  const oldBaseline = loadBaseline(baselinePath);
  const newBaseline = loadBaseline(comparePath);

  // Compare
  const comparisons = compareBaselines(oldBaseline, newBaseline);

  // Generate markdown
  const markdown = generateMarkdownTable(comparisons, oldBaseline, newBaseline);

  // Output (unless silent mode)
  if (!options.silent) {
    if (options.markdown) {
      console.log(markdown);
    } else {
      printConsoleOutput(comparisons);
    }
  }

  // Save to file if requested
  if (options.output) {
    const fs = require('node:fs');
    fs.writeFileSync(options.output, markdown);
    console.log(`\n📄 Report saved to: ${options.output}`);
  }

  return { markdown, comparisons };
}

// =============================================================================
// CLI
// =============================================================================

function main(): void {
  const args = process.argv.slice(2);

  // Parse arguments
  const baselineIdx = args.findIndex((arg) => arg === '--baseline' || arg === '-b');
  const compareIdx = args.findIndex((arg) => arg === '--compare' || arg === '-c');
  const markdownFlag = args.includes('--markdown') || args.includes('-m');
  const outputIdx = args.findIndex((arg) => arg === '--output' || arg === '-o');

  if (baselineIdx === -1 || compareIdx === -1) {
    console.error('❌ Error: --baseline and --compare are required');
    console.error('\nUsage:');
    console.error(
      '  bun run scripts/eval/compare-baseline.ts --baseline <file1> --compare <file2>'
    );
    console.error(
      '  bun run scripts/eval/compare-baseline.ts -b <file1> -c <file2> -m -o report.md'
    );
    console.error('\nOptions:');
    console.error('  -b, --baseline <file>  Path to baseline file (old)');
    console.error('  -c, --compare <file>   Path to comparison file (new)');
    console.error('  -m, --markdown         Output in markdown format');
    console.error('  -o, --output <file>    Save report to file');
    process.exit(1);
  }

  const baselinePath = args[baselineIdx + 1];
  const comparePath = args[compareIdx + 1];
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

  if (!baselinePath || !comparePath) {
    console.error('❌ Error: Both --baseline and --compare require file paths');
    process.exit(1);
  }

  try {
    compareBaselinesFromFiles(baselinePath, comparePath, {
      markdown: markdownFlag,
      output: outputPath,
    });
  } catch (error) {
    console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Only run main if this file is executed directly
if (require.main === module) {
  main();
}
