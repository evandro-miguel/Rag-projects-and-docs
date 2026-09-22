#!/usr/bin/env bun
/**
 * @module verify-ingestion-coverage
 * @description Verifies that all source files have been processed.
 *
 * This script compares source and processed directories to ensure
 * complete ingestion coverage. Use as a gate before considering
 * ingestion complete.
 *
 * **Purpose:**
 * - Detect missing files (not processed)
 * - Detect stale files (source newer than processed)
 * - Detect orphan files (processed but source deleted)
 * - Ensure 100% coverage before marking ingestion done
 *
 * **Usage:**
 *   bun run scripts/verify-ingestion-coverage.ts
 *   bun run scripts/verify-ingestion-coverage.ts --source ./ingest/source/external/bun-docs --processed ./ingest/processed/external/bun-docs
 *   bun run scripts/verify-ingestion-coverage.ts --strict  # Exit 1 on any issue
 *
 * **Exit Codes:**
 *   0 - All files processed and up-to-date
 *   1 - Missing files or issues found (with --strict)
 *   2 - Configuration error
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

interface CoverageReport {
  sourceDir: string;
  processedDir: string;
  sourceFiles: string[];
  processedFiles: string[];
  skippedSource: string[]; // Skipped component files
  missing: string[]; // In source but not processed
  orphaned: string[]; // In processed but not in source
  stale: string[]; // Processed older than source
  coverage: number; // Percentage
  passed: boolean;
}

interface VerifyOptions {
  sourceDir: string;
  processedDir: string;
  extensions: string[];
  strict: boolean;
  verbose: boolean;
}

const DEFAULT_EXTENSIONS = ['.md', '.mdx'];

// Files to skip (React components, not documentation)
const SKIP_PATTERNS = [
  /^_.*\.mdx?$/, // Files starting with _ (e.g., _betaAdmonition.mdx)
  /^_.*\/.*\.mdx?$/, // Files in directories starting with _
];

/**
 * Check if a file should be skipped (e.g., React components)
 */
function shouldSkipFile(relPath: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(relPath));
}

/**
 * Recursively get all files with given extensions
 */
function getAllFiles(dir: string, extensions: string[]): { files: string[]; skipped: string[] } {
  if (!existsSync(dir)) {
    return { files: [], skipped: [] };
  }

  const files: string[] = [];
  const skipped: string[] = [];

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip common ignore patterns
        if (['node_modules', '.git', '__pycache__', '.venv'].includes(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (extensions.includes(ext)) {
          // Skip React component files
          const relPath = relative(dir, fullPath);
          if (!shouldSkipFile(relPath)) {
            files.push(fullPath);
          } else {
            skipped.push(fullPath);
          }
        }
      }
    }
  }

  walk(dir);
  return { files: files.sort(), skipped: skipped.sort() };
}

/**
 * Get relative path from absolute path
 */
function getRelativePath(absolutePath: string, baseDir: string): string {
  return relative(baseDir, absolutePath);
}

/**
 * Check if a source file has a corresponding processed file
 */
function findProcessedFile(
  sourceRelPath: string,
  processedFiles: string[],
  processedDir: string
): string | null {
  // Direct match
  const directMatch = processedFiles.find(
    (f) => getRelativePath(f, processedDir) === sourceRelPath
  );
  if (directMatch) return directMatch;

  // .mdx -> .md conversion
  if (sourceRelPath.endsWith('.mdx')) {
    const mdVersion = sourceRelPath.replace(/\.mdx$/, '.md');
    const mdMatch = processedFiles.find((f) => getRelativePath(f, processedDir) === mdVersion);
    if (mdMatch) return mdMatch;
  }

  return null;
}

/**
 * Check if processed file is older than source
 */
function isStale(sourcePath: string, processedPath: string): boolean {
  try {
    const sourceStat = statSync(sourcePath);
    const processedStat = statSync(processedPath);
    return processedStat.mtimeMs < sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Main verification function
 */
function verifyCoverage(options: VerifyOptions): CoverageReport {
  const { sourceDir, processedDir, extensions } = options;

  console.log('🔍 Verifying Ingestion Coverage...\n');
  console.log(`📁 Source:     ${sourceDir}`);
  console.log(`📁 Processed:  ${processedDir}`);
  console.log(`📄 Extensions: ${extensions.join(', ')}\n`);

  // Get all files
  const { files: sourceFiles, skipped: skippedSource } = getAllFiles(sourceDir, extensions);
  const { files: processedFiles } = getAllFiles(processedDir, extensions);

  console.log(`📊 Source files:     ${sourceFiles.length}`);
  if (skippedSource.length > 0) {
    console.log(`📊 Skipped (components): ${skippedSource.length}`);
  }
  console.log(`📊 Processed files:  ${processedFiles.length}\n`);

  const missing: string[] = [];
  const stale: string[] = [];
  const _processedSet = new Set(processedFiles.map((f) => getRelativePath(f, processedDir)));

  // Check each source file
  for (const sourceFile of sourceFiles) {
    const relPath = getRelativePath(sourceFile, sourceDir);
    const processedFile = findProcessedFile(relPath, processedFiles, processedDir);

    if (!processedFile) {
      missing.push(relPath);
    } else if (isStale(sourceFile, processedFile)) {
      stale.push(relPath);
    }
  }

  // Check for orphaned files (in processed but not in source)
  const orphaned: string[] = [];
  for (const processedFile of processedFiles) {
    const relPath = getRelativePath(processedFile, processedDir);

    // Check direct match
    const sourcePath = join(sourceDir, relPath);
    const sourceMdxPath = sourcePath.replace(/\.md$/, '.mdx');

    if (!existsSync(sourcePath) && !existsSync(sourceMdxPath)) {
      // Check if it's an _index.md file (generated, not from source)
      if (!relPath.endsWith('_index.md')) {
        orphaned.push(relPath);
      }
    }
  }

  // Calculate coverage
  const coverage =
    sourceFiles.length > 0 ? ((sourceFiles.length - missing.length) / sourceFiles.length) * 100 : 0;

  const passed = missing.length === 0 && stale.length === 0;

  return {
    sourceDir,
    processedDir,
    sourceFiles,
    processedFiles,
    skippedSource,
    missing,
    orphaned,
    stale,
    coverage,
    passed,
  };
}

/**
 * Print detailed report
 */
function printReport(report: CoverageReport, verbose: boolean): void {
  const { missing, orphaned, stale, coverage, skippedSource } = report;

  console.log('━'.repeat(60));
  console.log('📋 COVERAGE REPORT');
  console.log('━'.repeat(60));

  // Coverage
  const coverageColor = coverage === 100 ? '✅' : coverage >= 80 ? '⚠️' : '❌';
  console.log(`\n${coverageColor} Coverage: ${coverage.toFixed(1)}%`);

  // Skipped files
  if (skippedSource.length > 0) {
    console.log(`\n⏭️  Skipped files (components): ${skippedSource.length}`);
    if (verbose) {
      skippedSource.slice(0, 5).forEach((f) => {
        console.log(`   - ${f}`);
      });
      if (skippedSource.length > 5) {
        console.log(`   ... and ${skippedSource.length - 5} more`);
      }
    }
  }

  // Missing files
  if (missing.length > 0) {
    console.log(`\n❌ MISSING FILES (${missing.length}):`);
    if (verbose) {
      missing.slice(0, 20).forEach((f) => {
        console.log(`   - ${f}`);
      });
      if (missing.length > 20) {
        console.log(`   ... and ${missing.length - 20} more`);
      }
    } else {
      console.log(`   Run with --verbose to see full list`);
    }
  }

  // Orphaned files
  if (orphaned.length > 0) {
    console.log(`\n⚠️  ORPHANED FILES (${orphaned.length}):`);
    if (verbose) {
      orphaned.slice(0, 10).forEach((f) => {
        console.log(`   - ${f}`);
      });
      if (orphaned.length > 10) {
        console.log(`   ... and ${orphaned.length - 10} more`);
      }
    }
  }

  // Stale files
  if (stale.length > 0) {
    console.log(`\n⏰ STALE FILES (${stale.length}):`);
    if (verbose) {
      stale.slice(0, 10).forEach((f) => {
        console.log(`   - ${f}`);
      });
    }
  }

  // Summary
  console.log(`\n${'━'.repeat(60)}`);
  if (report.passed) {
    console.log('✅ VERIFICATION PASSED - All files processed');
  } else {
    console.log('❌ VERIFICATION FAILED - Issues found');
    console.log(`   Missing: ${missing.length}`);
    console.log(`   Orphaned: ${orphaned.length}`);
    console.log(`   Stale: ${stale.length}`);
  }
  console.log('━'.repeat(60));
}

/**
 * Parse command line arguments
 */
function parseArgs(): VerifyOptions {
  const args = process.argv.slice(2);

  const options: VerifyOptions = {
    sourceDir: process.env.DOCS_SOURCE_PATH || './ingest/source/external/bun-docs',
    processedDir: './ingest/processed/external/bun-docs',
    extensions: DEFAULT_EXTENSIONS,
    strict: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--source':
        options.sourceDir = args[++i];
        break;
      case '--processed':
        options.processedDir = args[++i];
        break;
      case '--extensions':
        options.extensions = args[++i]
          .split(',')
          .map((e) => (e.trim().startsWith('.') ? e.trim() : `.${e.trim()}`));
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: bun run scripts/verify-ingestion-coverage.ts [options]

Options:
  --source <dir>      Source directory (default: ./ingest/source/external/bun-docs)
  --processed <dir>   Processed directory (default: ./ingest/processed/external/bun-docs)
  --extensions <ext>  File extensions to check (default: .md,.mdx)
  --strict            Exit with code 1 on any issue
  --verbose, -v       Show detailed output
  --help, -h          Show this help

Examples:
  bun run scripts/verify-ingestion-coverage.ts
  bun run scripts/verify-ingestion-coverage.ts --source ./docs --processed ./processed --strict
`);
        process.exit(0);
    }
  }

  return options;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const options = parseArgs();

  // Validate directories exist
  if (!existsSync(options.sourceDir)) {
    console.error(`❌ Source directory not found: ${options.sourceDir}`);
    process.exit(2);
  }

  const report = verifyCoverage(options);
  printReport(report, options.verbose);

  // Export missing files list for processing
  if (report.missing.length > 0) {
    const missingFile = join(options.processedDir, '.missing-files.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(missingFile, JSON.stringify(report.missing, null, 2));
    console.log(`\n📝 Missing files list saved to: ${missingFile}`);
  }

  // Exit codes
  if (!report.passed && options.strict) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
