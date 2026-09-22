#!/usr/bin/env bun
/**
 * @module generate-batches
 * @description Generates batch assignments from missing files list.
 *
 * This script reads the .missing-files.json and generates batched
 * assignments for parallel processing by agents.
 *
 * **Usage:**
 *   bun run scripts/generate-batches.ts
 *   bun run scripts/generate-batches.ts --batch-size 5
 *   bun run scripts/generate-batches.ts --output ./batches.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Batch {
  id: number;
  files: string[];
  count: number;
  theme: string;
}

const DEFAULT_BATCH_SIZE = 7;

/**
 * Infer theme from file paths
 */
function _inferTheme(files: string[]): string {
  const dirs = files.map((f) => dirname(f).split('/')[0]).filter(Boolean);
  const uniqueDirs = [...new Set(dirs)];

  if (uniqueDirs.length === 1) {
    return uniqueDirs[0] || 'misc';
  }

  // Group by top-level directory
  const counts: Record<string, number> = {};
  for (const dir of dirs) {
    counts[dir] = (counts[dir] || 0) + 1;
  }

  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return dominant ? dominant[0] : 'misc';
}

/**
 * Generate batches from missing files
 */
function generateBatches(files: string[], batchSize: number): Batch[] {
  const batches: Batch[] = [];

  // Group by top-level directory first
  const grouped: Record<string, string[]> = {};

  for (const file of files) {
    const topDir = file.split('/')[0] || 'root';
    if (!grouped[topDir]) {
      grouped[topDir] = [];
    }
    grouped[topDir].push(file);
  }

  // Create batches within each group
  let batchId = 1;
  for (const [dir, dirFiles] of Object.entries(grouped).sort()) {
    for (let i = 0; i < dirFiles.length; i += batchSize) {
      const batchFiles = dirFiles.slice(i, i + batchSize);
      batches.push({
        id: batchId++,
        files: batchFiles,
        count: batchFiles.length,
        theme: dir,
      });
    }
  }

  return batches;
}

/**
 * Format as JSON
 */
function formatJson(batches: Batch[]): string {
  return JSON.stringify(batches, null, 2);
}

/**
 * Format as Markdown
 */
function formatMarkdown(batches: Batch[]): string {
  let md = '# Batch Assignments\n\n';
  md += `Total batches: ${batches.length}\n`;
  md += `Total files: ${batches.reduce((sum, b) => sum + b.count, 0)}\n\n`;

  for (const batch of batches) {
    md += `## Batch ${batch.id}: ${batch.theme} (${batch.count} files)\n\n`;
    for (const file of batch.files) {
      md += `- ${file}\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * Format as agent prompts
 */
function formatPrompts(batches: Batch[], sourceDir: string, destDir: string): string {
  let output = '';

  for (const batch of batches) {
    output += `---\n## Batch ${batch.id}: ${batch.theme}\n\n`;
    output += '```\n';
    output += `You are a documentation processor for a RAG system. Process these ${batch.count} files:\n\n`;
    output += `SOURCE_DIR: ${sourceDir}\n`;
    output += `DEST_DIR: ${destDir}\n\n`;
    output += 'Files:\n';
    for (const file of batch.files) {
      output += `${file}\n`;
    }
    output += '\nApply batch-refine rules. Report completion with line counts.\n';
    output += '```\n\n';
  }

  return output;
}

/**
 * Main
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let missingFile = './ingest/processed/external/bun-docs/.missing-files.json';
  let batchSize = DEFAULT_BATCH_SIZE;
  let outputFile = '';
  let format: 'json' | 'markdown' | 'prompt' = 'markdown';
  let sourceDir = './ingest/source/external/bun-docs';
  let destDir = './ingest/processed/external/bun-docs';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--missing':
        missingFile = args[++i];
        break;
      case '--batch-size':
        batchSize = parseInt(args[++i], 10);
        break;
      case '--output':
        outputFile = args[++i];
        break;
      case '--format':
        format = args[++i] as 'json' | 'markdown' | 'prompt';
        break;
      case '--source':
        sourceDir = args[++i];
        break;
      case '--dest':
        destDir = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: bun run scripts/generate-batches.ts [options]

Options:
  --missing <file>    Missing files JSON (default: ./.missing-files.json)
  --batch-size <n>    Files per batch (default: 7)
  --output <file>     Output file (default: stdout)
  --format <fmt>      Output format: json, markdown, prompt (default: markdown)
  --source <dir>      Source directory for prompts
  --dest <dir>        Destination directory for prompts

Examples:
  bun run scripts/generate-batches.ts
  bun run scripts/generate-batches.ts --batch-size 5 --format prompt
`);
        process.exit(0);
    }
  }

  if (!existsSync(missingFile)) {
    console.error(`❌ Missing file not found: ${missingFile}`);
    console.error('   Run `make verify-ingestion` first to generate the missing files list.');
    process.exit(1);
  }

  const missingFiles: string[] = JSON.parse(readFileSync(missingFile, 'utf-8'));

  if (missingFiles.length === 0) {
    console.log('✅ No missing files to process.');
    process.exit(0);
  }

  console.log(`📊 Generating batches for ${missingFiles.length} missing files...`);

  const batches = generateBatches(missingFiles, batchSize);

  console.log(`📦 Created ${batches.length} batches (avg ${batchSize} files each)\n`);

  let output: string;
  switch (format) {
    case 'json':
      output = formatJson(batches);
      break;
    case 'prompt':
      output = formatPrompts(batches, sourceDir, destDir);
      break;
    default:
      output = formatMarkdown(batches);
  }

  if (outputFile) {
    writeFileSync(outputFile, output);
    console.log(`✅ Batches written to: ${outputFile}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
