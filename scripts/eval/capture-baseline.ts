/**
 * @module eval/capture-baseline
 * @description Captures and saves baseline evaluation metrics.
 *
 * This script:
 * 1. Runs full evaluation on all queries
 * 2. Saves results to .data/eval/baselines/baseline_YYYYMMDD_HHMMSS.json
 * 3. Includes environment info and all metrics
 * 4. Provides baseline for comparing future improvements
 *
 * Usage:
 *   bun run scripts/eval/capture-baseline.ts
 *   bun run scripts/eval/capture-baseline.ts --category react --mode hybrid
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompareMode } from './run-eval.js';
import { runEvaluation } from './run-eval.js';
import type { EvalMetrics } from './types.js';

const COMPARE_MODES = ['keyword', 'vector', 'hybrid'] as const satisfies readonly CompareMode[];

/**
 * Environment information for baseline context
 */
interface EnvironmentInfo {
  /** Git commit hash (short) */
  commit_hash: string;
  /** Git branch name */
  branch: string;
  /** Node.js version */
  node_version: string;
  /** Platform (OS) */
  platform: string;
  /** Embedding model used */
  model: string;
  /** Category filter if applied */
  category?: string;
  /** Search mode used */
  mode?: CompareMode;
}

/**
 * Complete baseline data structure
 */
interface BaselineData {
  /** ISO timestamp when captured */
  captured_at: string;
  /** Evaluation metrics */
  metrics: EvalMetrics;
  /** Number of queries evaluated */
  query_count: number;
  /** Environment information */
  environment: EnvironmentInfo;
  /** Path where baseline was saved */
  saved_path?: string;
}

/**
 * Get current git commit hash (short)
 */
function getGitCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', cwd: process.cwd() }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Get current git branch
 */
function getGitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: process.cwd(),
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Format timestamp for filename: YYYYMMDD_HHMMSS
 */
function formatTimestampForFilename(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * Capture and save baseline evaluation
 */
export async function captureBaseline(options: {
  category?: string;
  mode?: CompareMode;
  model?: string;
  silent?: boolean;
}): Promise<{ data: BaselineData; path: string }> {
  const { category, mode, model, silent = false } = options;

  if (!silent) {
    console.log('🎯 RAG Baseline Capture');
    console.log('========================\n');
  }

  const selectedModel = model ?? process.env.EMBEDDING_MODEL;
  const evaluationOptions: Parameters<typeof runEvaluation>[0] = {};
  if (category) {
    evaluationOptions.category = category;
  }
  if (mode) {
    evaluationOptions.mode = mode;
  }
  if (selectedModel) {
    evaluationOptions.model = selectedModel;
  }

  // Run full evaluation
  const baseline = await runEvaluation(evaluationOptions);

  // Get environment info
  const environment: EnvironmentInfo = {
    commit_hash: getGitCommitHash(),
    branch: getGitBranch(),
    node_version: process.version,
    platform: `${process.platform} (${process.arch})`,
    model: baseline.model,
    category,
    mode,
  };

  // Build baseline data
  const baselineData: BaselineData = {
    captured_at: baseline.captured_at,
    metrics: baseline.metrics,
    query_count: baseline.query_count,
    environment,
  };

  // Ensure baselines directory exists
  const baselinesDir = join(process.cwd(), '.data', 'eval', 'baselines');
  if (!existsSync(baselinesDir)) {
    mkdirSync(baselinesDir, { recursive: true });
  }

  // Build filename with timestamp
  const timestamp = formatTimestampForFilename(new Date(baseline.captured_at));
  let label = '';
  if (category) label += `_${category}`;
  if (mode) label += `_${mode}`;
  const filename = `baseline_${timestamp}${label}.json`;

  // Save to baselines directory
  const outputPath = join(baselinesDir, filename);
  baselineData.saved_path = outputPath;
  writeFileSync(outputPath, JSON.stringify(baselineData, null, 2));

  if (!silent) {
    console.log(`\n✅ Baseline saved to: ${outputPath}`);
    console.log('\n📋 Baseline Metrics:');
    console.log(JSON.stringify(baselineData, null, 2));
  }

  return { data: baselineData, path: outputPath };
}

function parseModeArg(mode: string | undefined): CompareMode | undefined {
  if (!mode) return undefined;
  if (COMPARE_MODES.includes(mode as CompareMode)) return mode as CompareMode;
  throw new Error(`Invalid mode "${mode}". Expected one of: ${COMPARE_MODES.join(', ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const categoryArg = args.includes('--category')
    ? args[args.indexOf('--category') + 1]
    : undefined;
  const modeArg = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : undefined;

  await captureBaseline({
    category: categoryArg,
    mode: parseModeArg(modeArg),
  });
}

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}
