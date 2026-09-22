/**
 * @module eval/check-thresholds
 * @description CI gate checking for evaluation thresholds.
 *
 * This script:
 * 1. Runs evaluation against current codebase
 * 2. Compares against baseline or threshold config
 * 3. Exits with code 0 (pass) or 1 (fail)
 *
 * Usage:
 *   bun run scripts/eval/check-thresholds.ts              # Compare to target thresholds
 *   bun run scripts/eval/check-thresholds.ts --baseline   # Compare to latest baseline
 *   bun run scripts/eval/check-thresholds.ts --strict     # Use stretch thresholds
 *   bun run scripts/eval/check-thresholds.ts --profile minimum|target|stretch
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEvaluation } from './run-eval.js';
import { STRICT_THRESHOLDS } from './thresholds.js';
import type { EvalMetrics, ThresholdConfig } from './types.js';
import { BLOCK_THRESHOLDS, DEFAULT_THRESHOLDS } from './types.js';

// =============================================================================
// THRESHOLD CHECKING
// =============================================================================

function checkMetric(
  _name: string,
  current: number,
  threshold: number,
  direction: 'min' | 'max' = 'min'
): { pass: boolean; diff: number } {
  const diff = current - threshold;
  const pass = direction === 'min' ? current >= threshold : current <= threshold;
  return { pass, diff };
}

function checkAllThresholds(
  metrics: EvalMetrics,
  thresholds: ThresholdConfig
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];

  const checks = [
    {
      name: 'hitRate',
      value: metrics.hitRate,
      threshold: thresholds.hitRate,
    },
    { name: 'nDCG@10', value: metrics['nDCG@10'], threshold: thresholds.ndcg },
    { name: 'MRR', value: metrics.MRR, threshold: thresholds.mrr },
  ];

  for (const check of checks) {
    if (check.threshold === undefined) continue;

    const result = checkMetric(check.name, check.value, check.threshold);
    if (!result.pass) {
      failures.push(
        `${check.name}: ${check.value.toFixed(3)} < ${check.threshold} (diff: ${result.diff.toFixed(3)})`
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// =============================================================================
// BASELINE LOADING
// =============================================================================

function findLatestBaseline(): string | null {
  const evalDir = join(process.cwd(), '.agents', 'eval');

  // Read directory to find any baseline files
  try {
    const { readdirSync } = require('node:fs');
    const files = readdirSync(evalDir).filter(
      (f: string) => f.startsWith('baseline_') && f.endsWith('.json')
    );

    if (files.length > 0) {
      // Return the most recent one (sorted alphabetically, assuming date format)
      files.sort().reverse();
      return join(evalDir, files[0]);
    }
  } catch {
    // Directory doesn't exist or is empty
  }

  return null;
}

function loadBaseline(path: string): any {
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const useBaseline = args.includes('--baseline');
  const useStrict = args.includes('--strict');
  const useBlock = args.includes('--block');
  const profileArg = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined;
  const verbose = args.includes('--verbose') || args.includes('-v');

  console.log('🎯 RAG Evaluation Threshold Check');
  console.log('====================================\n');

  // Determine thresholds
  let thresholds: ThresholdConfig;

  if (useBlock) {
    console.log('🚫 Using MINIMUM thresholds (blocking gate)');
    thresholds = BLOCK_THRESHOLDS;
  } else if (useBaseline) {
    const baselinePath = findLatestBaseline();
    if (!baselinePath) {
      console.error('❌ No baseline found. Run capture-baseline.ts first.');
      process.exit(1);
    }

    console.log(`📂 Using baseline: ${baselinePath}`);
    const baseline = loadBaseline(baselinePath);
    thresholds = {
      hitRate: baseline.metrics.hitRate,
      ndcg: baseline.metrics['nDCG@10'],
      mrr: baseline.metrics.MRR,
      latency_p95: baseline.metrics.latency_p95,
    };
  } else if (useStrict) {
    console.log('🔒 Using STRETCH thresholds');
    thresholds = STRICT_THRESHOLDS;
  } else if (profileArg) {
    const profiles = {
      minimum: BLOCK_THRESHOLDS,
      target: DEFAULT_THRESHOLDS,
      stretch: STRICT_THRESHOLDS,
    } as const;
    const selected = profiles[profileArg as keyof typeof profiles];
    if (!selected) {
      console.error(`❌ Invalid profile '${profileArg}'. Use minimum, target, or stretch.`);
      process.exit(1);
    }
    console.log(`📐 Using ${profileArg.toUpperCase()} thresholds`);
    thresholds = selected;
  } else {
    console.log('📊 Using TARGET thresholds');
    thresholds = DEFAULT_THRESHOLDS;
  }

  if (verbose) {
    console.log('\n📐 Thresholds:');
    console.log(JSON.stringify(thresholds, null, 2));
    console.log('');
  }

  // Run evaluation
  const result = await runEvaluation(
    process.env.EMBEDDING_MODEL ? { model: process.env.EMBEDDING_MODEL } : {}
  );

  console.log('\n📊 Results vs Thresholds:');
  let allPassed = true;

  const checks = [
    {
      name: 'hitRate',
      value: result.metrics.hitRate,
      threshold: thresholds.hitRate,
    },
    { name: 'nDCG@10', value: result.metrics['nDCG@10'], threshold: thresholds.ndcg },
    { name: 'MRR', value: result.metrics.MRR, threshold: thresholds.mrr },
  ];

  for (const check of checks) {
    if (check.threshold === undefined) continue;

    const pass = check.value >= check.threshold;
    const status = pass ? '✅' : '❌';
    console.log(
      `   ${status} ${check.name}: ${check.value.toFixed(3)} (threshold: ${check.threshold})`
    );

    if (!pass) allPassed = false;
  }

  // Latency check (threshold is maximum, not minimum)
  if (thresholds.latency_p95 !== undefined) {
    const latencyValue = result.metrics.latency_p95 ?? 0;
    const latencyPass = latencyValue <= thresholds.latency_p95;
    const latencyStatus = latencyPass ? '✅' : '❌';
    console.log(
      `   ${latencyStatus} latency_p95: ${latencyValue.toFixed(3)}s (max: ${thresholds.latency_p95}s)`
    );
    if (!latencyPass) allPassed = false;
  }

  console.log('');

  if (allPassed) {
    console.log('✅ ALL CHECKS PASSED');
    process.exit(0);
  } else {
    console.log('❌ THRESHOLD CHECKS FAILED');

    const { failures } = checkAllThresholds(result.metrics, thresholds);
    console.log('\n📝 Failed checks:');
    for (const failure of failures) {
      console.log(`   - ${failure}`);
    }

    process.exit(1);
  }
}

main().catch(console.error);
