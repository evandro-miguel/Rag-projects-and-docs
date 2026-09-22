#!/usr/bin/env bun
/**
 * @module scripts/eval/project-rag/run-fix-loop.ts
 * @description Iterative fix loop for Project RAG evaluation
 *
 * Runs evaluation, parses failures, applies fixes, and loops until all tests pass.
 *
 * Usage:
 *   bun run scripts/eval/project-rag/run-fix-loop.ts
 *   bun run scripts/eval/project-rag/run-fix-loop.ts --max-iterations 10
 *   bun run scripts/eval/project-rag/run-fix-loop.ts --fixture fixture-ts-service
 */

import { execSync } from 'node:child_process';
import { PROJECT_RAG_FIXTURES } from './fixtures.js';
import { resolveThresholds } from './metrics.js';
import type { ProjectEvalThresholds } from './types.js';

// ============================================================================
// TYPES
// ============================================================================

interface EvalMetrics {
  hitRate: number;
  exactPathRate: number;
  exactSymbolRate: number;
  exactLineRate: number;
  mrr: number;
  ndcgAt10: number;
  avgQualityScore: number;
  contaminationRate: number;
  latencyP95Ms: number;
}

interface FixtureConfig {
  id: string;
  repoRoot: string;
  thresholds: ProjectEvalThresholds;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const FIXTURES: FixtureConfig[] = PROJECT_RAG_FIXTURES.map((fixture) => ({
  id: fixture.id,
  repoRoot: fixture.repoRoot,
  thresholds: resolveThresholds(fixture),
}));

const _REQUIRED_FIXES = [
  'fix-01-use-proper-ingestion',
  'fix-02-extract-symbols-ast',
  'fix-03-extract-line-numbers',
  'fix-04-generate-embeddings',
  'fix-05-fix-branch-drift-paths',
  'fix-06-ensure-search-returns-symbols',
];

// ============================================================================
// UTILITIES
// ============================================================================

function parseArgs(args: string[]) {
  return {
    maxIterations: args.includes('--max-iterations')
      ? parseInt(args[args.indexOf('--max-iterations') + 1], 10)
      : 20,
    fixtureId: args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : undefined,
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose') || args.includes('-v'),
  };
}

function log(msg: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') {
  const colors = {
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    success: '\x1b[32m',
  };
  console.log(`${colors[level]}${msg}\x1b[0m`);
}

function runCommand(
  cmd: string,
  options: { silent?: boolean; cwd?: string } = {}
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      cwd: options.cwd,
      stdio: options.silent ? 'pipe' : 'inherit',
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', code: e.status || 1 };
  }
}

// ============================================================================
// EVALUATION RUNNER
// ============================================================================

function runEvaluation(fixtureId?: string): {
  metrics: Record<string, EvalMetrics>;
  failures: string[];
} {
  log('\n📊 Running evaluation...', 'info');

  const cmd = fixtureId
    ? `bun run scripts/eval/project-rag/run-e2e-eval.ts --fixture ${fixtureId} --json`
    : `bun run scripts/eval/project-rag/run-e2e-eval.ts --json`;

  const result = runCommand(cmd, { silent: true });

  if (result.code !== 0 && !result.stdout.includes('variantReports')) {
    log(`Evaluation failed: ${result.stderr}`, 'error');
    return { metrics: {}, failures: ['Evaluation script failed'] };
  }

  try {
    // Parse JSON from output (might have non-JSON prefix)
    const jsonStart = result.stdout.indexOf('{');
    const jsonStr = result.stdout.slice(jsonStart);
    const report = JSON.parse(jsonStr);

    const metrics: Record<string, EvalMetrics> = {};
    const failures: string[] = [];

    for (const variant of report.variantReports || []) {
      metrics[variant.fixtureId] = variant.metrics;
      if (variant.thresholdFailures?.length > 0) {
        failures.push(`${variant.fixtureId}: ${variant.thresholdFailures.join(', ')}`);
      }
    }

    return { metrics, failures };
  } catch (e) {
    log(`Failed to parse evaluation output: ${e}`, 'error');
    return { metrics: {}, failures: ['Failed to parse evaluation output'] };
  }
}

// ============================================================================
// FIX IMPLEMENTATIONS
// ============================================================================

const FIXES: Record<string, () => { applied: boolean; message: string }> = {
  'fix-01-use-proper-ingestion': () => {
    log('  Inspecting Project RAG ingestion path...', 'info');
    return {
      applied: false,
      message: 'Review the current eval ingestion path and fixture expectations before changing it',
    };
  },

  'fix-02-extract-symbols-ast': () => {
    log('  Inspecting AST symbol extraction...', 'info');
    return {
      applied: false,
      message: 'Symbol extraction is already AST-based; inspect chunking and fixture expectations',
    };
  },

  'fix-03-extract-line-numbers': () => {
    log('  Inspecting line number extraction...', 'info');
    return {
      applied: false,
      message: 'Line numbers should come from AST and chunk offsets; verify fixture expectations',
    };
  },

  'fix-04-generate-embeddings': () => {
    log('  Applying: Generate embeddings via local provider...', 'info');
    return {
      applied: false,
      message:
        'Embeddings require the configured local provider - start the llama.cpp GPU lane; Ollama is unsupported/deprecated and not an alternate path',
    };
  },

  'fix-05-fix-branch-drift-paths': () => {
    log('  Applying: Fix branch-drift snapshot paths...', 'info');
    // Branch drift has snapshots/v1 and snapshots/v2 structure
    return { applied: false, message: 'Need to handle snapshot paths in ingestion' };
  },

  'fix-06-ensure-search-returns-symbols': () => {
    log('  Applying: Ensure search returns symbol data...', 'info');
    // Search should return symbolName, symbolKind, startLine, endLine
    return {
      applied: false,
      message: 'Search already returns symbol data - need proper ingestion',
    };
  },
};

function _applyFix(fixId: string): { applied: boolean; message: string } {
  const fix = FIXES[fixId];
  if (!fix) {
    return { applied: false, message: `Unknown fix: ${fixId}` };
  }
  return fix();
}

// ============================================================================
// METRICS CHECKER
// ============================================================================

function checkThresholds(
  _fixtureId: string,
  metrics: EvalMetrics,
  thresholds: ProjectEvalThresholds
): string[] {
  const failures: string[] = [];

  if (metrics.hitRate < thresholds.hitRate) {
    failures.push(`hitRate ${(metrics.hitRate * 100).toFixed(1)}% < ${thresholds.hitRate * 100}%`);
  }
  if (metrics.exactPathRate < thresholds.exactPathRate) {
    failures.push(
      `exactPathRate ${(metrics.exactPathRate * 100).toFixed(1)}% < ${thresholds.exactPathRate * 100}%`
    );
  }
  if (metrics.exactSymbolRate < thresholds.exactSymbolRate) {
    failures.push(
      `exactSymbolRate ${(metrics.exactSymbolRate * 100).toFixed(1)}% < ${thresholds.exactSymbolRate * 100}%`
    );
  }
  if (metrics.exactLineRate < thresholds.exactLineRate) {
    failures.push(
      `exactLineRate ${(metrics.exactLineRate * 100).toFixed(1)}% < ${thresholds.exactLineRate * 100}%`
    );
  }
  if (metrics.mrr < thresholds.mrr) {
    failures.push(`mrr ${(metrics.mrr * 100).toFixed(1)}% < ${thresholds.mrr * 100}%`);
  }
  if (metrics.ndcgAt10 < thresholds.ndcgAt10) {
    failures.push(
      `ndcgAt10 ${(metrics.ndcgAt10 * 100).toFixed(1)}% < ${thresholds.ndcgAt10 * 100}%`
    );
  }
  if (metrics.avgQualityScore < thresholds.avgQualityScore) {
    failures.push(
      `avgQualityScore ${(metrics.avgQualityScore * 100).toFixed(1)}% < ${thresholds.avgQualityScore * 100}%`
    );
  }
  if (
    thresholds.maxContaminationRate !== undefined &&
    metrics.contaminationRate > thresholds.maxContaminationRate
  ) {
    failures.push(
      `contaminationRate ${(metrics.contaminationRate * 100).toFixed(1)}% > ${thresholds.maxContaminationRate * 100}%`
    );
  }
  if (metrics.latencyP95Ms > thresholds.latencyP95Ms) {
    failures.push(
      `latencyP95Ms ${metrics.latencyP95Ms.toFixed(0)}ms > ${thresholds.latencyP95Ms.toFixed(0)}ms`
    );
  }

  return failures;
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));

  log('╔════════════════════════════════════════════════════════════╗', 'info');
  log('║       RAG Evaluation Fix Loop                              ║', 'info');
  log('╚════════════════════════════════════════════════════════════╝', 'info');

  let iteration = 0;
  let allPassed = false;

  while (!allPassed && iteration < args.maxIterations) {
    iteration++;

    log(`\n${'═'.repeat(60)}`, 'info');
    log(`ITERATION ${iteration}/${args.maxIterations}`, 'info');
    log('═'.repeat(60), 'info');

    // Run evaluation
    const { metrics } = runEvaluation(args.fixtureId);

    if (Object.keys(metrics).length === 0) {
      log('No metrics returned - evaluation may have failed', 'error');
      break;
    }

    // Check each fixture against thresholds
    const allFailures: string[] = [];
    const fixturesToCheck = args.fixtureId
      ? FIXTURES.filter((f) => f.id === args.fixtureId)
      : FIXTURES;

    log('\n📋 Threshold Check:', 'info');

    for (const fixture of fixturesToCheck) {
      const m = metrics[fixture.id];
      if (!m) {
        log(`  ${fixture.id}: ⚠️  No metrics`, 'warn');
        continue;
      }

      const fixtureFailures = checkThresholds(fixture.id, m, fixture.thresholds);

      if (fixtureFailures.length === 0) {
        log(`  ${fixture.id}: ✅ PASS`, 'success');
      } else {
        log(`  ${fixture.id}: ❌ FAIL - ${fixtureFailures.join('; ')}`, 'error');
        allFailures.push(`${fixture.id}: ${fixtureFailures.join(', ')}`);
      }
    }

    // If all passed, we're done
    if (allFailures.length === 0) {
      allPassed = true;
      log('\n🎉 ALL TESTS PASSED!', 'success');
      break;
    }

    // Identify root cause and apply fix
    log('\n🔧 Analyzing failures and applying fixes...', 'info');

    // Determine which fix to apply based on failure pattern
    const _fixApplied = false;

    // Check for symbol extraction issues (exactSymbolRate = 0%)
    const symbolIssues = fixturesToCheck.filter((f) => metrics[f.id]?.exactSymbolRate < 0.1);
    if (symbolIssues.length > 0) {
      log(
        `\n  Issue detected: Symbol extraction failing for ${symbolIssues.length} fixtures`,
        'warn'
      );
      log(`  Root cause: inspect current ingestion output and fixture expectations`, 'warn');
      log(`  Fix: verify AST chunking, symbol persistence, and search payload shape`, 'info');
    }

    // Check for line extraction issues (exactLineRate = 0%)
    const lineIssues = fixturesToCheck.filter((f) => metrics[f.id]?.exactLineRate < 0.1);
    if (lineIssues.length > 0) {
      log(`\n  Issue detected: Line extraction failing for ${lineIssues.length} fixtures`, 'warn');
      log(`  Root cause: Line numbers not extracted from AST`, 'warn');
    }

    // Check for hit rate issues
    const hitRateIssues = fixturesToCheck.filter(
      (f) => metrics[f.id]?.hitRate < f.thresholds.hitRate
    );
    if (hitRateIssues.length > 0) {
      log(
        `\n  Issue detected: Hit rate below threshold for ${hitRateIssues.length} fixtures`,
        'warn'
      );
    }

    // Print actionable recommendations
    log('\n📝 Action Required:', 'info');
    log('  The evaluation path is now end-to-end, so failures should be treated as', 'info');
    log('  actual ingestion/search regressions or stale fixture expectations.', 'info');
    log('  ', 'info');
    log('  To fix this, you need to:', 'info');
    log('  1. Inspect AST chunking and symbol persistence for the failing fixture', 'info');
    log('  2. Ensure the configured local embedding provider is running', 'info');
    log('  3. Re-check fixture expectations and project search payload shape', 'info');

    // Break the loop since we can't auto-fix without user intervention
    log('\n⚠️  Cannot auto-fix - requires manual code changes', 'warn');
    break;
  }

  // Final summary
  log(`\n${'═'.repeat(60)}`, 'info');
  log('SUMMARY', 'info');
  log('═'.repeat(60), 'info');

  if (allPassed) {
    log('✅ All fixtures passed all thresholds!', 'success');
    process.exit(0);
  } else {
    log(`❌ Evaluation did not pass after ${iteration} iterations`, 'error');
    log('See above for actionable fixes', 'info');
    process.exit(1);
  }
}

main().catch(console.error);
