#!/usr/bin/env bun

/**
 * @module advanced_metrics
 * @description Advanced code quality metrics for inventory reports.
 *
 * This module provides sophisticated code analysis including:
 * - Code complexity scores (cyclomatic, cognitive)
 * - Duplicate code detection
 * - Technical debt indicators
 * - Test coverage correlation
 *
 * @example
 * // Calculate all metrics for a file
 * const metrics = await calculateAdvancedMetrics('src/utils.ts', projectPath);
 *
 * @example
 * // Detect duplicates across project
 * const duplicates = await detectDuplicateCode(files, projectPath);
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface ComplexityMetrics {
  /** Cyclomatic complexity (branching paths) */
  cyclomatic: number;
  /** Cognitive complexity (human readability) */
  cognitive: number;
  /** Maximum nesting depth */
  maxNestingDepth: number;
  /** Number of return statements */
  returnCount: number;
}

export interface DuplicateBlock {
  /** Content hash of the duplicate */
  hash: string;
  /** Number of lines in the duplicate block */
  lineCount: number;
  /** Files containing this duplicate */
  files: DuplicateLocation[];
  /** Sample of the duplicated code */
  sample: string;
}

export interface DuplicateLocation {
  filepath: string;
  startLine: number;
  endLine: number;
}

export interface TechnicalDebtItem {
  /** Type of debt indicator */
  type: 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'DEPRECATED' | 'BUG' | 'NOTE';
  /** Line number where found */
  line: number;
  /** Context/surrounding code */
  context: string;
  /** Full comment text */
  comment: string;
}

export interface TechnicalDebtReport {
  /** All debt items found */
  items: TechnicalDebtItem[];
  /** Count by type */
  byType: Record<TechnicalDebtItem['type'], number>;
  /** Total debt score (weighted) */
  debtScore: number;
}

export interface TestCorrelation {
  /** Source file path */
  sourceFile: string;
  /** Associated test file(s) */
  testFiles: string[];
  /** Coverage status */
  coverage: 'full' | 'partial' | 'none' | 'unknown';
  /** Number of test cases */
  testCount: number;
}

export interface AdvancedFileMetrics {
  /** Complexity metrics */
  complexity: ComplexityMetrics;
  /** Technical debt indicators */
  technicalDebt: TechnicalDebtReport;
  /** Code duplication within this file */
  internalDuplicates: DuplicateBlock[];
  /** Maintainability index (0-100) */
  maintainabilityIndex: number;
}

export interface ProjectAdvancedMetrics {
  /** Duplicates found across project */
  crossFileDuplicates: DuplicateBlock[];
  /** Test coverage correlations */
  testCorrelations: Map<string, TestCorrelation>;
  /** Project-wide debt summary */
  projectDebtSummary: {
    totalDebtItems: number;
    totalDebtScore: number;
    debtByType: Record<TechnicalDebtItem['type'], number>;
    filesWithDebt: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

const MIN_BLOCK_SIZE = 4; // Minimum lines to consider as duplicate

const COMPLEXITY_PATTERNS = {
  // Branching constructs
  branches: [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bswitch\s*\(/g,
    /\bcase\s+[^:]+:/g,
    /\bdefault\s*:/g,
  ],
  // Loops
  loops: [/\bfor\s*\(/g, /\bwhile\s*\(/g, /\bdo\s*\{/g, /\bforEach\s*\(/g],
  // Logical operators
  logical: [/&&|\|\|/g],
  // Exception handling
  exception: [/\bcatch\b/g, /\bfinally\b/g],
  // Ternary operators
  ternary: [/\?\s*[^:?]+\s*:/g],
};

const DEBT_PATTERNS: { type: TechnicalDebtItem['type']; pattern: RegExp }[] = [
  { type: 'TODO', pattern: /\/\/.*\bTODO\b.*$/gim },
  { type: 'FIXME', pattern: /\/\/.*\bFIXME\b.*$/gim },
  { type: 'HACK', pattern: /\/\/.*\bHACK\b.*$/gim },
  { type: 'XXX', pattern: /\/\/.*\bXXX\b.*$/gim },
  { type: 'BUG', pattern: /\/\/.*\bBUG\b.*$/gim },
  { type: 'NOTE', pattern: /\/\/.*\bNOTE\b.*$/gim },
  { type: 'DEPRECATED', pattern: /\b@deprecated\b/gi },
];

// ============================================================================
// Complexity Calculation
// ============================================================================

/**
 * Calculate cyclomatic complexity
 * Counts decision points in code
 */
function calculateCyclomaticComplexity(content: string): number {
  let complexity = 1; // Base path

  // Count branching statements
  for (const pattern of COMPLEXITY_PATTERNS.branches) {
    const matches = content.match(pattern);
    if (matches) complexity += matches.length;
  }

  // Count loops
  for (const pattern of COMPLEXITY_PATTERNS.loops) {
    const matches = content.match(pattern);
    if (matches) complexity += matches.length;
  }

  // Count logical operators (adds complexity for short-circuit evaluation)
  const logicalMatches = content.match(COMPLEXITY_PATTERNS.logical[0]);
  if (logicalMatches) complexity += logicalMatches.length;

  // Count catch blocks
  const catchMatches = content.match(COMPLEXITY_PATTERNS.exception[0]);
  if (catchMatches) complexity += catchMatches.length;

  return complexity;
}

/**
 * Calculate cognitive complexity
 * Measures how difficult code is to understand
 */
function calculateCognitiveComplexity(content: string): number {
  const lines = content.split('\n');
  let complexity = 0;
  let nestingLevel = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for nesting increase
    if (/^\s*(if|for|while|switch|catch)\s*[({]/.test(trimmed)) {
      complexity += 1 + nestingLevel;
      nestingLevel++;
    }
    // Check for nesting decrease
    else if (trimmed === '}' || trimmed === '};') {
      nestingLevel = Math.max(0, nestingLevel - 1);
    }
    // Logical operators add complexity
    else if (/&&|\|\|/.test(trimmed)) {
      complexity += 1;
    }
    // Recursion adds complexity
    else if (/function\s+\w+.*\{/.test(trimmed)) {
      const funcName = trimmed.match(/function\s+(\w+)/)?.[1];
      if (funcName && new RegExp(`\\b${funcName}\\s*\\(`).test(content)) {
        complexity += 2;
      }
    }
  }

  return complexity;
}

/**
 * Calculate maximum nesting depth
 */
function calculateMaxNestingDepth(content: string): number {
  const lines = content.split('\n');
  let maxDepth = 0;
  let currentDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Opening brace increases depth
    if (/{/.test(trimmed)) {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    }
    // Closing brace decreases depth
    if (/}/.test(trimmed)) {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }

  return maxDepth;
}

/**
 * Count return statements
 */
function countReturnStatements(content: string): number {
  const matches = content.match(/\breturn\b/g);
  return matches ? matches.length : 0;
}

// ============================================================================
// Technical Debt Detection
// ============================================================================

/**
 * Detect technical debt indicators in code
 */
function detectTechnicalDebt(content: string): TechnicalDebtReport {
  const items: TechnicalDebtItem[] = [];
  const lines = content.split('\n');
  const byType: Record<TechnicalDebtItem['type'], number> = {
    TODO: 0,
    FIXME: 0,
    HACK: 0,
    XXX: 0,
    BUG: 0,
    NOTE: 0,
    DEPRECATED: 0,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const { type, pattern } of DEBT_PATTERNS) {
      // Reset lastIndex for global regex
      pattern.lastIndex = 0;

      if (pattern.test(line)) {
        // Get context (2 lines before and after)
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        const context = lines.slice(start, end).join('\n');

        items.push({
          type,
          line: i + 1,
          context: context.trim(),
          comment: line.trim(),
        });

        byType[type]++;
      }
    }
  }

  // Calculate weighted debt score
  const weights = {
    FIXME: 5,
    BUG: 4,
    HACK: 3,
    XXX: 3,
    DEPRECATED: 2,
    TODO: 1,
    NOTE: 0,
  };

  let debtScore = 0;
  for (const [type, count] of Object.entries(byType)) {
    debtScore += count * weights[type as keyof typeof weights];
  }

  return { items, byType, debtScore };
}

// ============================================================================
// Duplicate Detection
// ============================================================================

/**
 * Normalize code for comparison (remove whitespace, comments, etc.)
 */
function normalizeForComparison(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
    .replace(/\/\/.*$/gm, '') // Remove line comments
    .replace(/^\s+|\s+$/gm, '') // Trim lines
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

/**
 * Extract code blocks from content
 */
function extractBlocks(content: string): { hash: string; lines: string; startLine: number }[] {
  const lines = content.split('\n');
  const blocks: { hash: string; lines: string; startLine: number }[] = [];

  // Use sliding window to find similar blocks
  for (let start = 0; start <= lines.length - MIN_BLOCK_SIZE; start++) {
    for (let size = MIN_BLOCK_SIZE; size <= Math.min(20, lines.length - start); size++) {
      const blockLines = lines.slice(start, start + size);
      const blockContent = blockLines.join('\n');
      const normalized = normalizeForComparison(blockContent);

      // Skip very short or trivial blocks
      if (normalized.length < 20) continue;

      const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);

      blocks.push({
        hash,
        lines: blockContent,
        startLine: start + 1,
      });
    }
  }

  return blocks;
}

/**
 * Detect duplicate code blocks within a single file
 */
function detectInternalDuplicates(content: string): DuplicateBlock[] {
  const blocks = extractBlocks(content);
  const hashMap = new Map<string, { lines: string; startLine: number }[]>();

  for (const block of blocks) {
    if (!hashMap.has(block.hash)) {
      hashMap.set(block.hash, []);
    }
    hashMap.get(block.hash)?.push({ lines: block.lines, startLine: block.startLine });
  }

  const duplicates: DuplicateBlock[] = [];

  for (const [hash, locations] of hashMap.entries()) {
    if (locations.length > 1) {
      // Filter overlapping blocks (keep the first occurrence)
      const uniqueLocations = locations.filter((loc, index) => {
        if (index === 0) return true;
        const prev = locations[index - 1];
        return loc.startLine > prev.startLine + 5; // Not within 5 lines
      });

      if (uniqueLocations.length > 1) {
        duplicates.push({
          hash,
          lineCount: uniqueLocations[0].lines.split('\n').length,
          files: uniqueLocations.map((loc) => ({
            filepath: '', // Will be set by caller
            startLine: loc.startLine,
            endLine: loc.startLine + loc.lines.split('\n').length - 1,
          })),
          sample: `${uniqueLocations[0].lines.slice(0, 100)}...`,
        });
      }
    }
  }

  return duplicates;
}

// ============================================================================
// Maintainability Index
// ============================================================================

/**
 * Calculate maintainability index (0-100, higher is better)
 * Based on Microsoft metric: 171 - 5.2 * ln(Halstead Volume) - 0.23 * CC - 16.2 * ln(LOC)
 */
function calculateMaintainabilityIndex(
  lines: number,
  cyclomatic: number,
  cognitive: number
): number {
  // Simplified version without full Halstead metrics
  const loc = Math.max(1, lines);
  const cc = Math.max(1, cyclomatic);
  const cog = Math.max(0, cognitive);

  // Base calculation
  const index = 100 - 0.2 * Math.log(loc) * 10 - 0.5 * cc - 0.1 * cog;

  // Clamp to 0-100 range
  return Math.max(0, Math.min(100, Math.round(index)));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Calculate advanced metrics for a single file
 */
export async function calculateAdvancedMetrics(
  filepath: string,
  projectPath: string
): Promise<AdvancedFileMetrics | null> {
  try {
    const fullPath = join(projectPath, filepath);
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Calculate complexity
    const cyclomatic = calculateCyclomaticComplexity(content);
    const cognitive = calculateCognitiveComplexity(content);
    const maxNestingDepth = calculateMaxNestingDepth(content);
    const returnCount = countReturnStatements(content);

    // Detect technical debt
    const technicalDebt = detectTechnicalDebt(content);

    // Detect internal duplicates
    const internalDuplicates = detectInternalDuplicates(content);
    // Add filepath to duplicates
    internalDuplicates.forEach((dup) => {
      dup.files.forEach((loc) => {
        loc.filepath = filepath;
      });
    });

    // Calculate maintainability
    const maintainabilityIndex = calculateMaintainabilityIndex(lines.length, cyclomatic, cognitive);

    return {
      complexity: {
        cyclomatic,
        cognitive,
        maxNestingDepth,
        returnCount,
      },
      technicalDebt,
      internalDuplicates,
      maintainabilityIndex,
    };
  } catch {
    return null;
  }
}

/**
 * Detect duplicate code across multiple files
 */
export async function detectDuplicateCode(
  filepaths: string[],
  projectPath: string
): Promise<DuplicateBlock[]> {
  const allBlocks = new Map<string, DuplicateLocation[]>();

  for (const filepath of filepaths) {
    try {
      const fullPath = join(projectPath, filepath);
      const content = await readFile(fullPath, 'utf-8');
      const blocks = extractBlocks(content);

      for (const block of blocks) {
        if (!allBlocks.has(block.hash)) {
          allBlocks.set(block.hash, []);
        }
        allBlocks.get(block.hash)?.push({
          filepath,
          startLine: block.startLine,
          endLine: block.startLine + block.lines.split('\n').length - 1,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Find hashes that appear in multiple files
  const duplicates: DuplicateBlock[] = [];

  for (const [hash, locations] of allBlocks.entries()) {
    // Group by file to find cross-file duplicates
    const fileGroups = new Map<string, DuplicateLocation[]>();
    for (const loc of locations) {
      if (!fileGroups.has(loc.filepath)) {
        fileGroups.set(loc.filepath, []);
      }
      fileGroups.get(loc.filepath)?.push(loc);
    }

    // Only count if appears in 2+ files
    if (fileGroups.size >= 2) {
      const allLocations = Array.from(fileGroups.values()).flat();
      const _sampleBlock = allBlocks.get(hash);

      duplicates.push({
        hash,
        lineCount: allLocations[0].endLine - allLocations[0].startLine + 1,
        files: allLocations,
        sample: '[Cross-file duplicate]', // Would need to store actual content
      });
    }
  }

  // Sort by number of files affected (descending)
  return duplicates.sort((a, b) => b.files.length - a.files.length);
}

/**
 * Correlate test files with source files
 */
export async function correlateTests(
  filepaths: string[],
  projectPath: string
): Promise<Map<string, TestCorrelation>> {
  const correlations = new Map<string, TestCorrelation>();

  // Separate test and source files
  const testFiles = filepaths.filter(
    (f) =>
      f.endsWith('.test.ts') ||
      f.endsWith('.test.tsx') ||
      f.endsWith('.spec.ts') ||
      f.endsWith('.spec.tsx')
  );
  const sourceFiles = filepaths.filter(
    (f) =>
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.test.tsx') &&
      !f.endsWith('.spec.ts') &&
      !f.endsWith('.spec.tsx') &&
      !f.includes('/tests/') &&
      !f.includes('/__tests__/')
  );

  // Initialize correlations for all source files
  for (const sourceFile of sourceFiles) {
    correlations.set(sourceFile, {
      sourceFile,
      testFiles: [],
      coverage: 'unknown',
      testCount: 0,
    });
  }

  // Analyze each test file
  for (const testFile of testFiles) {
    try {
      const fullPath = join(projectPath, testFile);
      const content = await readFile(fullPath, 'utf-8');

      // Find imports and references to source files
      const importMatches = content.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g);
      const referencedFiles: string[] = [];

      for (const match of importMatches) {
        const importPath = match[1];
        // Resolve relative imports to find matching source file
        if (importPath.startsWith('.')) {
          const testDir = testFile.split('/').slice(0, -1).join('/');
          const resolvedPath = join(testDir, importPath).replace(/\\/g, '/');

          // Try different extensions
          const candidates = [
            `${resolvedPath}.ts`,
            `${resolvedPath}.tsx`,
            `${resolvedPath}/index.ts`,
          ];

          for (const candidate of candidates) {
            if (sourceFiles.includes(candidate)) {
              referencedFiles.push(candidate);
            }
          }
        }
      }

      // Count test cases
      const testMatches = content.match(/\b(it|test|describe)\s*\(/g);
      const testCount = testMatches ? testMatches.length : 0;

      // Update correlations
      for (const sourceFile of referencedFiles) {
        const correlation = correlations.get(sourceFile);
        if (correlation) {
          if (!correlation.testFiles.includes(testFile)) {
            correlation.testFiles.push(testFile);
          }
          correlation.testCount += testCount;

          // Determine coverage status
          if (correlation.testCount > 5) {
            correlation.coverage = 'full';
          } else if (correlation.testCount > 0) {
            correlation.coverage = 'partial';
          } else {
            correlation.coverage = 'none';
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Mark source files with no tests
  for (const [_sourceFile, correlation] of correlations.entries()) {
    if (correlation.testFiles.length === 0) {
      correlation.coverage = 'none';
    }
  }

  return correlations;
}

/**
 * Calculate project-wide advanced metrics
 */
export async function calculateProjectAdvancedMetrics(
  filepaths: string[],
  projectPath: string
): Promise<ProjectAdvancedMetrics> {
  // Detect cross-file duplicates
  const codeExtensions = ['.ts', '.tsx', '.js', '.jsx'];
  const codeFiles = filepaths.filter((f) => codeExtensions.some((ext) => f.endsWith(ext)));

  const crossFileDuplicates = await detectDuplicateCode(codeFiles, projectPath);
  const testCorrelations = await correlateTests(filepaths, projectPath);

  // Aggregate debt metrics
  let totalDebtItems = 0;
  let totalDebtScore = 0;
  const debtByType: Record<TechnicalDebtItem['type'], number> = {
    TODO: 0,
    FIXME: 0,
    HACK: 0,
    XXX: 0,
    BUG: 0,
    NOTE: 0,
    DEPRECATED: 0,
  };
  let filesWithDebt = 0;

  for (const filepath of codeFiles) {
    const metrics = await calculateAdvancedMetrics(filepath, projectPath);
    if (metrics) {
      totalDebtItems += metrics.technicalDebt.items.length;
      totalDebtScore += metrics.technicalDebt.debtScore;

      if (metrics.technicalDebt.items.length > 0) {
        filesWithDebt++;
        for (const [type, count] of Object.entries(metrics.technicalDebt.byType)) {
          debtByType[type as TechnicalDebtItem['type']] += count;
        }
      }
    }
  }

  return {
    crossFileDuplicates,
    testCorrelations,
    projectDebtSummary: {
      totalDebtItems,
      totalDebtScore,
      debtByType,
      filesWithDebt,
    },
  };
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format complexity score with color indicator
 */
export function formatComplexity(cyclomatic: number): string {
  if (cyclomatic <= 10) return `🟢 ${cyclomatic}`;
  if (cyclomatic <= 20) return `🟡 ${cyclomatic}`;
  return `🔴 ${cyclomatic}`;
}

/**
 * Format maintainability index with color indicator
 */
export function formatMaintainability(index: number): string {
  if (index >= 80) return `🟢 ${index}`;
  if (index >= 60) return `🟡 ${index}`;
  return `🔴 ${index}`;
}

/**
 * Format technical debt count with indicator
 */
export function formatDebtCount(count: number): string {
  if (count === 0) return '🟢 0';
  if (count <= 3) return `🟡 ${count}`;
  return `🔴 ${count}`;
}

/**
 * Generate markdown summary of project metrics
 */
export function generateAdvancedMetricsSummary(metrics: ProjectAdvancedMetrics): string {
  let content = '## Advanced Quality Metrics\n\n';

  // Complexity Summary
  content += '### Complexity Overview\n\n';
  content +=
    'Files are analyzed for cyclomatic complexity (decision points) and cognitive complexity (readability).\n\n';

  // Technical Debt Summary
  content += '### Technical Debt Summary\n\n';
  content += '| Metric | Value |\n';
  content += '| :--- | :--- |\n';
  content += `| Total Debt Items | ${metrics.projectDebtSummary.totalDebtItems} |\n`;
  content += `| Debt Score | ${metrics.projectDebtSummary.totalDebtScore} |\n`;
  content += `| Files with Debt | ${metrics.projectDebtSummary.filesWithDebt} |\n`;

  if (metrics.projectDebtSummary.totalDebtItems > 0) {
    content += '\n**Breakdown by Type:**\n\n';
    content += '| Type | Count |\n';
    content += '| :--- | ---: |\n';
    for (const [type, count] of Object.entries(metrics.projectDebtSummary.debtByType)) {
      if (count > 0) {
        content += `| ${type} | ${count} |\n`;
      }
    }
  }

  content += '\n';

  // Duplicates Summary
  content += '### Code Duplication\n\n';
  if (metrics.crossFileDuplicates.length === 0) {
    content += '> No significant code duplication detected across files.\n';
  } else {
    content += `**Found ${metrics.crossFileDuplicates.length} duplicate patterns across files.**\n\n`;
    content += '| Pattern | Files Affected | Lines |\n';
    content += '| :--- | ---: | ---: |\n';
    for (const dup of metrics.crossFileDuplicates.slice(0, 10)) {
      const uniqueFiles = new Set(dup.files.map((f) => f.filepath)).size;
      content += `| \`${dup.hash.slice(0, 8)}...\` | ${uniqueFiles} | ${dup.lineCount} |\n`;
    }
  }

  content += '\n';

  // Test Coverage Summary
  content += '### Test Coverage Correlation\n\n';
  const correlations = Array.from(metrics.testCorrelations.values());
  const withTests = correlations.filter((c) => c.testFiles.length > 0).length;
  const total = correlations.length;
  const coverage = total > 0 ? Math.round((withTests / total) * 100) : 0;

  content += `| Metric | Value |\n`;
  content += `| :--- | :--- |\n`;
  content += `| Source Files | ${total} |\n`;
  content += `| Files with Tests | ${withTests} |\n`;
  content += `| Coverage Ratio | ${coverage}% |\n`;

  return content;
}
