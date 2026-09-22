/**
 * @module eval/project-rag/check-rollout-gate
 * @description Production rollout gate for Project RAG.
 *
 * This script checks if the latest Project RAG evaluation results meet
target thresholds before allowing production deployment.
 *
 * Target Thresholds:
 * - hitRate >= 0.88
 * - exactPathRate >= 0.85
 * - exactSymbolRate >= 0.75
 * - exactLineRate >= 0.65
 * - avgQualityScore >= 0.80
 * - maxContaminationRate <= 0.02
 * - latencyP95Ms <= 1550
 *
 * Usage:
 *   bun run scripts/eval/project-rag/check-rollout-gate.ts              # Check latest results
 *   bun run scripts/eval/project-rag/check-rollout-gate.ts --variant project-hybrid  # Check specific variant
 *   bun run scripts/eval/project-rag/check-rollout-gate.ts --override "HOTFIX-123: emergency security patch"
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_PROJECT_THRESHOLDS } from '../thresholds.js';
import type { ProjectEvalReport, ProjectVariantReport } from './types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const WEEKLY_EVAL_DIR = join(process.cwd(), '.afol', 'data', 'eval', 'weekly');

interface RolloutThreshold {
  name: string;
  value: number;
  threshold: number;
  direction: 'min' | 'max';
  format: (v: number) => string;
}

// =============================================================================
// RESULT LOADING
// =============================================================================

function findLatestProjectEvalFile(): string | null {
  if (!existsSync(WEEKLY_EVAL_DIR)) {
    return null;
  }

  try {
    const files = readdirSync(WEEKLY_EVAL_DIR)
      .filter((f) => f.startsWith('project_') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length > 0) {
      return join(WEEKLY_EVAL_DIR, files[0]);
    }
  } catch {
    // Directory empty or unreadable
  }

  return null;
}

function loadEvalReport(path: string): ProjectEvalReport {
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content) as ProjectEvalReport;
}

function findVariantReport(
  report: ProjectEvalReport,
  variantId: string
): ProjectVariantReport | null {
  return report.variantReports.find((v) => v.variantId === variantId) ?? null;
}

// =============================================================================
// THRESHOLD CHECKING
// =============================================================================

function buildThresholdChecks(metrics: ProjectVariantReport['metrics']): RolloutThreshold[] {
  return [
    {
      name: 'hitRate',
      value: metrics.hitRate,
      threshold: DEFAULT_PROJECT_THRESHOLDS.hitRate,
      direction: 'min',
      format: (v) => v.toFixed(2),
    },
    {
      name: 'exactPathRate',
      value: metrics.exactPathRate,
      threshold: DEFAULT_PROJECT_THRESHOLDS.exactPathRate,
      direction: 'min',
      format: (v) => v.toFixed(2),
    },
    {
      name: 'exactSymbolRate',
      value: metrics.exactSymbolRate,
      threshold: DEFAULT_PROJECT_THRESHOLDS.exactSymbolRate,
      direction: 'min',
      format: (v) => v.toFixed(2),
    },
    {
      name: 'exactLineRate',
      value: metrics.exactLineRate,
      threshold: DEFAULT_PROJECT_THRESHOLDS.exactLineRate,
      direction: 'min',
      format: (v) => v.toFixed(2),
    },
    {
      name: 'avgQualityScore',
      value: metrics.avgQualityScore,
      threshold: DEFAULT_PROJECT_THRESHOLDS.avgQualityScore,
      direction: 'min',
      format: (v) => v.toFixed(2),
    },
    {
      name: 'maxContaminationRate',
      value: metrics.contaminationRate,
      threshold: DEFAULT_PROJECT_THRESHOLDS.maxContaminationRate,
      direction: 'max',
      format: (v) => v.toFixed(2),
    },
    {
      name: 'latencyP95Ms',
      value: metrics.latencyP95Ms,
      threshold: DEFAULT_PROJECT_THRESHOLDS.latencyP95Ms,
      direction: 'max',
      format: (v) => Math.round(v).toString(),
    },
  ];
}

function checkThreshold(check: RolloutThreshold): {
  pass: boolean;
  diff: number;
  formattedDiff: string;
} {
  const diff =
    check.direction === 'min' ? check.value - check.threshold : check.threshold - check.value;
  const pass =
    check.direction === 'min' ? check.value >= check.threshold : check.value <= check.threshold;

  return {
    pass,
    diff,
    formattedDiff: `${diff >= 0 ? '+' : ''}${check.direction === 'min' ? diff.toFixed(3) : diff.toFixed(0)}`,
  };
}

// =============================================================================
// OUTPUT FORMATTING
// =============================================================================

function formatResultLine(check: RolloutThreshold, pass: boolean): string {
  const symbol = pass ? '✅' : '❌';
  const operator = check.direction === 'min' ? '>=' : '<=';
  const formattedValue = check.format(check.value);
  const formattedThreshold =
    check.direction === 'min'
      ? check.threshold.toFixed(2)
      : check.name === 'latencyP95Ms'
        ? Math.round(check.threshold).toString()
        : check.threshold.toFixed(2);

  return `${symbol} ${check.name}: ${formattedValue} ${operator} ${formattedThreshold}`;
}

function printRolloutGateResults(
  checks: RolloutThreshold[],
  results: Map<string, { pass: boolean; diff: number; formattedDiff: string }>,
  variantId: string,
  evalFile: string,
  overrideJustification?: string
): { allPassed: boolean; failureCount: number } {
  console.log('🎯 Project RAG Rollout Gate');
  console.log('=============================');
  console.log(`
Variant: ${variantId}`);
  console.log(`Source:  ${evalFile}`);
  console.log('');

  let failureCount = 0;

  for (const check of checks) {
    const result = results.get(check.name);
    if (!result) {
      console.error(`❌ Internal error: No result for threshold ${check.name}`);
      process.exit(1);
    }
    console.log(formatResultLine(check, result.pass));
    if (!result.pass) {
      failureCount++;
    }
  }

  console.log('');

  const allPassed = failureCount === 0;

  if (allPassed) {
    console.log('✅ ALL THRESHOLDS PASSED - Rollout approved');
  } else {
    console.log(
      `❌ ROLLOUT BLOCKED: ${failureCount} threshold${failureCount === 1 ? '' : 's'} not met`
    );

    if (overrideJustification) {
      console.log('');
      console.log('⚠️  OVERRIDE APPLIED');
      console.log(`Justification: ${overrideJustification}`);
      console.log('');
      console.log('🟡 Rollout proceeding with override (exit code 0)');
    } else {
      console.log('');
      console.log('To override (requires justification):');
      console.log(
        '  bun run scripts/eval/project-rag/check-rollout-gate.ts --variant <variant> --override "<justification>"'
      );
    }
  }

  return { allPassed, failureCount };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const variantId = args.includes('--variant')
    ? args[args.indexOf('--variant') + 1]
    : 'project-hybrid';
  const overrideFlag = args.includes('--override');
  const overrideJustification = overrideFlag ? args[args.indexOf('--override') + 1] : undefined;
  const customEvalPath = args.includes('--eval-path')
    ? args[args.indexOf('--eval-path') + 1]
    : undefined;

  // Validate override justification
  if (overrideFlag && !overrideJustification) {
    console.error('❌ Error: --override requires a justification string');
    console.error('Example: --override "HOTFIX-123: emergency security patch"');
    process.exit(1);
  }

  console.log('🔍 Checking Project RAG rollout gates...\n');

  // Find and load evaluation results
  const evalFile = customEvalPath ? resolve(customEvalPath) : findLatestProjectEvalFile();

  if (!evalFile) {
    console.error('❌ Error: No Project RAG evaluation results found');
    console.error(`Expected in: ${WEEKLY_EVAL_DIR}/project_YYYYMMDD.json`);
    console.error('');
    console.error('Run capture + report first:');
    console.error('  bun run eval:project-rag -- --write-capture /tmp/project-capture.json');
    console.error(
      '  bun run eval:project-rag:report -- --capture /tmp/project-capture.json --write .data/eval/weekly/project_$(date +%Y%m%d).json'
    );
    process.exit(1);
  }

  let report: ProjectEvalReport;
  try {
    report = loadEvalReport(evalFile);
  } catch (error) {
    console.error(`❌ Error: Failed to load evaluation results from ${evalFile}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // Find variant report
  const variantReport = findVariantReport(report, variantId);
  if (!variantReport) {
    console.error(`❌ Error: Variant '${variantId}' not found in evaluation results`);
    console.error('');
    console.error('Available variants:');
    for (const v of report.variantReports) {
      console.error(`  - ${v.variantId} (${v.fixtureId})`);
    }
    process.exit(1);
  }

  // Build and check thresholds
  const checks = buildThresholdChecks(variantReport.metrics);
  const results = new Map<string, { pass: boolean; diff: number; formattedDiff: string }>();

  for (const check of checks) {
    results.set(check.name, checkThreshold(check));
  }

  // Print results and determine exit code
  const { allPassed } = printRolloutGateResults(
    checks,
    results,
    variantId,
    evalFile,
    overrideJustification
  );

  // Exit with appropriate code
  // Override allows passing even with failures
  if (allPassed || overrideJustification) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
