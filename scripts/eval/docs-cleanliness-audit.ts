/**
 * @module eval/docs-cleanliness-audit
 * @description Audits cleanliness indicators for processed external docs.
 *
 * This script compares files under `ingest/processed/external` against
 * `ingest/source/external` and reports:
 * - how many files are byte-identical to source
 * - how many processed files still contain common MDX/UI noise markers
 *
 * Usage:
 *   bun run scripts/eval/docs-cleanliness-audit.ts
 *   bun run scripts/eval/docs-cleanliness-audit.ts --source components
 *   bun run scripts/eval/docs-cleanliness-audit.ts --source bun-docs --strict --json
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { glob } from 'glob';
import {
  assessExternalDocContent,
  type ExternalDocQualityReason,
} from '../lib/external-doc-quality.js';

type AuditMetrics = {
  totalFiles: number;
  matchedSourceFiles: number;
  missingSourcePairFiles: number;
  identicalToSourceFiles: number;
  filesWithImportLines: number;
  filesWithExportMeta: number;
  filesWithJsxTags: number;
  filesWithSiteMarkers: number;
  filesWithFrontmatter: number;
  invalidContentFiles: number;
  emptyFiles: number;
  controlCharacterFiles: number;
  includeOnlyFiles: number;
  redirectOnlyFiles: number;
  nonSemanticFiles: number;
};

type AuditReport = {
  generatedAt: string;
  root: string;
  filters: {
    sources: string[];
  };
  totals: AuditMetrics;
  bySource: Record<string, AuditMetrics>;
  invalidSamples: Array<{
    path: string;
    reasons: ExternalDocQualityReason[];
  }>;
};

const SOURCE_ROOT = join(process.cwd(), 'ingest', 'source', 'external');
const PROCESSED_ROOT = join(process.cwd(), 'ingest', 'processed', 'external');

const IMPORT_LINE_REGEX = /^import\s+/mu;
const EXPORT_META_REGEX = /^export const (title|description|metadata)\b/mu;
const JSX_TAG_REGEX = /<[A-Z][A-Za-z0-9]*/mu;
const SITE_MARKERS_REGEX = /@site\/src\/components|ComponentCardList|Figure|Admonition|TabItem/mu;
const FRONTMATTER_REGEX = /^---\s*\n[\s\S]*?\n---(\s*\n|$)/u;

function createEmptyMetrics(): AuditMetrics {
  return {
    totalFiles: 0,
    matchedSourceFiles: 0,
    missingSourcePairFiles: 0,
    identicalToSourceFiles: 0,
    filesWithImportLines: 0,
    filesWithExportMeta: 0,
    filesWithJsxTags: 0,
    filesWithSiteMarkers: 0,
    filesWithFrontmatter: 0,
    invalidContentFiles: 0,
    emptyFiles: 0,
    controlCharacterFiles: 0,
    includeOnlyFiles: 0,
    redirectOnlyFiles: 0,
    nonSemanticFiles: 0,
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/');
}

export function parseArgs(argv: string[]): {
  sourceFilters: Set<string>;
  json: boolean;
  strict: boolean;
} {
  const sourceFilters = new Set<string>();
  let json = false;
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--source') {
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) {
        sourceFilters.add(value.trim());
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--source=')) {
      const value = arg.slice('--source='.length).trim();
      if (value) {
        sourceFilters.add(value);
      }
    }
  }

  return { sourceFilters, json, strict };
}

function incrementNoiseCounters(metrics: AuditMetrics, content: string): void {
  if (IMPORT_LINE_REGEX.test(content)) {
    metrics.filesWithImportLines += 1;
  }
  if (EXPORT_META_REGEX.test(content)) {
    metrics.filesWithExportMeta += 1;
  }
  if (JSX_TAG_REGEX.test(content)) {
    metrics.filesWithJsxTags += 1;
  }
  if (SITE_MARKERS_REGEX.test(content)) {
    metrics.filesWithSiteMarkers += 1;
  }
  if (FRONTMATTER_REGEX.test(content)) {
    metrics.filesWithFrontmatter += 1;
  }
}

function incrementQualityCounters(
  metrics: AuditMetrics,
  reasons: readonly ExternalDocQualityReason[]
): void {
  if (reasons.length === 0) return;
  metrics.invalidContentFiles += 1;
  if (reasons.includes('empty')) metrics.emptyFiles += 1;
  if (reasons.includes('control-character')) metrics.controlCharacterFiles += 1;
  if (reasons.includes('include-only')) metrics.includeOnlyFiles += 1;
  if (reasons.includes('redirect-only')) metrics.redirectOnlyFiles += 1;
  if (reasons.includes('non-semantic')) metrics.nonSemanticFiles += 1;
}

function getSourceMetrics(
  bySource: Record<string, AuditMetrics>,
  sourceName: string
): AuditMetrics {
  if (!bySource[sourceName]) {
    bySource[sourceName] = createEmptyMetrics();
  }
  return bySource[sourceName];
}

function percent(value: number, base: number): string {
  if (base <= 0) {
    return '0.0%';
  }
  return `${((value / base) * 100).toFixed(1)}%`;
}

export async function runAudit(sourceFilters: Set<string>): Promise<AuditReport> {
  const totals = createEmptyMetrics();
  const bySource: Record<string, AuditMetrics> = {};
  const invalidSamples: AuditReport['invalidSamples'] = [];

  const processedFiles = await glob('**/*.{md,mdx,rst,txt,json}', {
    cwd: PROCESSED_ROOT,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });

  for (const processedPath of processedFiles) {
    const relativePath = normalizePath(relative(PROCESSED_ROOT, processedPath));
    const sourceName = relativePath.split('/')[0] ?? 'unknown';
    if (sourceFilters.size > 0 && !sourceFilters.has(sourceName)) {
      continue;
    }

    const sourceMetrics = getSourceMetrics(bySource, sourceName);
    const processedBytes = readFileSync(processedPath);
    const processedContent = processedBytes.toString('utf-8');

    totals.totalFiles += 1;
    sourceMetrics.totalFiles += 1;
    incrementNoiseCounters(totals, processedContent);
    incrementNoiseCounters(sourceMetrics, processedContent);
    const quality = assessExternalDocContent(processedContent);
    incrementQualityCounters(totals, quality.reasons);
    incrementQualityCounters(sourceMetrics, quality.reasons);
    if (!quality.valid && invalidSamples.length < 20) {
      invalidSamples.push({ path: relativePath, reasons: quality.reasons });
    }

    const sourcePath = join(SOURCE_ROOT, relativePath);
    if (!existsSync(sourcePath)) {
      totals.missingSourcePairFiles += 1;
      sourceMetrics.missingSourcePairFiles += 1;
      continue;
    }

    totals.matchedSourceFiles += 1;
    sourceMetrics.matchedSourceFiles += 1;

    const sourceBytes = readFileSync(sourcePath);
    if (processedBytes.equals(sourceBytes)) {
      totals.identicalToSourceFiles += 1;
      sourceMetrics.identicalToSourceFiles += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    root: process.cwd(),
    filters: {
      sources: Array.from(sourceFilters),
    },
    totals,
    bySource,
    invalidSamples,
  };
}

function printHumanReport(report: AuditReport): void {
  const { totals } = report;

  console.log('Docs Cleanliness Audit');
  console.log('======================');
  console.log(`Generated at: ${report.generatedAt}`);
  console.log(`Processed root: ${PROCESSED_ROOT}`);
  console.log(`Source root: ${SOURCE_ROOT}`);
  if (report.filters.sources.length > 0) {
    console.log(`Source filter: ${report.filters.sources.join(', ')}`);
  }
  console.log('');
  console.log('Totals');
  console.log('------');
  console.log(`Processed files: ${totals.totalFiles}`);
  console.log(`Matched source pairs: ${totals.matchedSourceFiles}`);
  console.log(`Missing source pairs: ${totals.missingSourcePairFiles}`);
  console.log(`Invalid content files: ${totals.invalidContentFiles}`);
  console.log(
    `Identical to source: ${totals.identicalToSourceFiles} (${percent(totals.identicalToSourceFiles, totals.matchedSourceFiles)})`
  );
  console.log('');
  console.log('Noise Indicators (processed files)');
  console.log('----------------------------------');
  console.log(
    `Import lines: ${totals.filesWithImportLines} (${percent(totals.filesWithImportLines, totals.totalFiles)})`
  );
  console.log(
    `Export metadata: ${totals.filesWithExportMeta} (${percent(totals.filesWithExportMeta, totals.totalFiles)})`
  );
  console.log(
    `JSX tags: ${totals.filesWithJsxTags} (${percent(totals.filesWithJsxTags, totals.totalFiles)})`
  );
  console.log(
    `Site markers: ${totals.filesWithSiteMarkers} (${percent(totals.filesWithSiteMarkers, totals.totalFiles)})`
  );
  console.log(
    `Frontmatter: ${totals.filesWithFrontmatter} (${percent(totals.filesWithFrontmatter, totals.totalFiles)})`
  );
  console.log('');
  console.log('By Source');
  console.log('---------');

  const sourceRows = Object.entries(report.bySource).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [sourceName, metrics] of sourceRows) {
    console.log(
      `${sourceName}: files=${metrics.totalFiles}, identical=${metrics.identicalToSourceFiles}/${metrics.matchedSourceFiles} (${percent(metrics.identicalToSourceFiles, metrics.matchedSourceFiles)}), imports=${metrics.filesWithImportLines}, jsx=${metrics.filesWithJsxTags}, siteMarkers=${metrics.filesWithSiteMarkers}`
    );
  }
  if (report.invalidSamples.length > 0) {
    console.log('');
    console.log('Invalid Samples');
    console.log('---------------');
    for (const sample of report.invalidSamples) {
      console.log(`${sample.path}: ${sample.reasons.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  const { sourceFilters, json, strict } = parseArgs(process.argv.slice(2));
  const report = await runAudit(sourceFilters);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  if (
    strict &&
    (report.totals.missingSourcePairFiles > 0 || report.totals.invalidContentFiles > 0)
  ) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
