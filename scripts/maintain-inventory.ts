#!/usr/bin/env bun
/**
 * @module maintain-inventory
 * @description Automated maintenance of code_inventory.md for the project.
 *
 * This script scans all code files dynamically and maintains an inventory
 * document with status tracking for reviewed files.
 *
 * Features:
 * - Preserves manual edits (status checkboxes and descriptions)
 * - Scans all code files dynamically
 * - Groups by top-level directory
 * - Generates changelogs for added/removed files
 * - Maintains Mermaid diagram if present
 *
 * @example
 * // Generate inventory with defaults
 * bun run scripts/maintain-inventory.ts
 *
 * @example
 * // Generate inventory for specific directory (use quotes in shell)
 * bun run scripts/maintain-inventory.ts --scope apps/web/src --out docs/web-inventory.md
 *
 * @example
 * // Generate with custom grouping
 * bun run scripts/maintain-inventory.ts --relative-to apps/web/src --title WebAppInventory
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { glob } from 'glob';

// Import config
import { SCRIPT_CONFIG } from './lib/config.js';

// Import advanced metrics
import {
  type AdvancedFileMetrics,
  calculateAdvancedMetrics,
  calculateProjectAdvancedMetrics,
  formatComplexity,
  formatDebtCount,
  formatMaintainability,
  generateAdvancedMetricsSummary,
  type ProjectAdvancedMetrics,
} from './lib/metrics/advanced_metrics.js';

// ============================================================================
// Types
// ============================================================================

interface InventoryItem {
  id?: string;
  status: '[x]' | '[ ]';
  description: string;
}

interface InventoryRow {
  id: string;
  filepath: string;
  status: '[x]' | '[ ]';
  description: string;
  metrics?: FileMetrics;
  advancedMetrics?: AdvancedFileMetrics;
}

interface FileMetrics {
  lines: number;
  functions: number;
  exports: number;
}

interface ChangelogEntry {
  added: string[];
  removed: string[];
}

interface CliArgs {
  scope: string;
  out: string;
  title: string;
  relativeTo: string;
  changelogDir: string;
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_ARGS: CliArgs = {
  scope: '**/*',
  out: 'docs/architecture/code_inventory.md',
  title: 'Code Inventory',
  relativeTo: '',
  changelogDir: 'inventory',
};

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.agent/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/out/**',
  // Additional ignore patterns from config
  ...(SCRIPT_CONFIG.PROJECT_IGNORE_PATTERNS
    ? SCRIPT_CONFIG.PROJECT_IGNORE_PATTERNS.split(',').map((p) => p.trim())
    : []),
];

const CODE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.mdx'];

// ============================================================================
// Utilities
// ============================================================================

/**
 * Show help message
 */
function showHelp(): void {
  console.log(`
Usage: bun run scripts/maintain-inventory.ts [options]

Options:
  --scope <glob>          Pattern for files to scan (default: "**/*")
  --out <path>            Output file path (default: "docs/architecture/code_inventory.md")
  --title <string>        Document title (default: "Code Inventory")
  --relative-to <path>    Base path for relative grouping (default: root)
                          Example: "apps/web/src" groups files by next subdir
  --changelog-dir <name>  Sub-directory for changelogs (default: "inventory")
  --help, -h              Show this help message

Examples:
  # Generate inventory for a specific directory
  bun run scripts/maintain-inventory.ts --scope "apps/web/src/**/*" --out "docs/web-inventory.md"

  # Generate inventory with custom grouping
  bun run scripts/maintain-inventory.ts --relative-to "apps/web/src" --title "Web App Inventory"

  # Use custom changelog directory
  bun run scripts/maintain-inventory.ts --changelog-dir "custom-inventory"
`);
}

/**
 * Parse CLI arguments from process.argv
 *
 * Supports:
 * --scope <glob>
 * --out <path>
 * --title <string>
 * --relative-to <path>
 * --changelog-dir <name>
 * --help, -h
 */
function parseCliArgs(): CliArgs | null {
  const args = { ...DEFAULT_ARGS };
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      showHelp();
      return null;
    }

    switch (arg) {
      case '--scope':
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          args.scope = argv[++i];
        }
        break;

      case '--out':
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          args.out = argv[++i];
        }
        break;

      case '--title':
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          args.title = argv[++i];
        }
        break;

      case '--relative-to':
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          args.relativeTo = argv[++i];
        }
        break;

      case '--changelog-dir':
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          args.changelogDir = argv[++i];
        }
        break;
    }
  }

  return args;
}

/**
 * Get the top-level directory name for a file path
 *
 * If `relativeTo` is provided, returns the next subdirectory after that base.
 * Otherwise, returns the first directory component.
 *
 * Examples:
 * - Without relativeTo: "apps/web/src/file.ts" → "Apps"
 * - With relativeTo="apps/web/src": "apps/web/src/features/reader/file.ts" → "Features"
 */
function getTopLevelDirectory(filepath: string, relativeTo: string): string {
  const parts = filepath.split('/').filter(Boolean);

  // If relativeTo is specified, find the position after the base path
  if (relativeTo) {
    const relativeToParts = relativeTo.split('/').filter(Boolean);

    // Find where the relativeTo path starts in the filepath
    let matchIndex = -1;
    for (let i = 0; i <= parts.length - relativeToParts.length; i++) {
      let matches = true;
      for (let j = 0; j < relativeToParts.length; j++) {
        if (parts[i + j] !== relativeToParts[j]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        matchIndex = i + relativeToParts.length;
        break;
      }
    }

    // If we found a match, use the next directory component
    if (matchIndex >= 0 && matchIndex < parts.length) {
      const dir = parts[matchIndex];
      return dir.charAt(0).toUpperCase() + dir.slice(1);
    }
  }

  // Fallback to first directory component
  const firstPart = parts[0] || '';
  return firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
}

/**
 * Parse an existing inventory file to extract table rows
 * Handles:
 * - 4 columns: | ID | Status | Filepath | Description |
 * - 3 columns: | Status | Filepath | Description |
 */
function parseInventoryFile(content: string): Map<string, InventoryItem> {
  const inventory = new Map<string, InventoryItem>();
  const lines = content.split('\n');

  for (const line of lines) {
    if (line.includes('---') || line.trim() === '') continue;

    // Try 4-column format: | ID | [ ] | `path` | desc |
    const match4 = line.match(
      /^\|\s*([^|]+)\s*\|\s*\[([x\s])\]\s*\|\s*`([^`]+)`\s*\|\s*([^|]*)\s*\|/
    );
    if (match4) {
      const [, id, statusChar, filepath, description] = match4;
      const cleanPath = filepath.trim().replace(/^\//, '');
      if (cleanPath && !['File', 'Filepath', 'File Path', 'Status'].includes(cleanPath)) {
        inventory.set(cleanPath, {
          id: id.trim(),
          status: statusChar.trim() === 'x' ? '[x]' : '[ ]',
          description: description.trim(),
        });
      }
      continue;
    }

    // Try 3-column format: | [ ] | `path` | desc |
    const match3 = line.match(/^\|\s*\[([x\s])\]\s*\|\s*`([^`]+)`\s*\|\s*([^|]*)\s*\|/);
    if (match3) {
      const [, statusChar, filepath, description] = match3;
      const cleanPath = filepath.trim().replace(/^\//, '');
      if (cleanPath && !['File', 'Filepath', 'File Path', 'Status'].includes(cleanPath)) {
        inventory.set(cleanPath, {
          status: statusChar.trim() === 'x' ? '[x]' : '[ ]',
          description: description.trim(),
        });
      }
    }
  }

  return inventory;
}

/**
 * Extract the Application Flow (Mermaid) section from inventory content
 * Preserves content between '## Application Flow (Mermaid)' and the next '##' header or EOF
 */
function extractMermaidDiagram(content: string): string | null {
  // Find the start of the Application Flow section
  const startMatch = content.match(/## Application Flow \(Mermaid\)/);
  if (!startMatch) {
    return null;
  }

  const startIndex = (startMatch.index ?? 0) + startMatch[0].length;

  // Find the next '##' header or end of file
  const remainingContent = content.slice(startIndex);
  const nextHeaderMatch = remainingContent.match(/\n## /) as RegExpMatchArray | null;

  let endIndex: number;
  if (nextHeaderMatch) {
    endIndex = startIndex + (nextHeaderMatch.index ?? 0);
  } else {
    endIndex = content.length;
  }

  // Extract the section (including leading newlines after the header)
  const sectionContent = content.slice(startIndex, endIndex).trim();

  if (!sectionContent) {
    return null;
  }

  // Return the full section with header
  return `## Application Flow (Mermaid)\n\n${sectionContent}`;
}

/**
 * Check if a path should be ignored
 */
function _shouldIgnore(path: string): boolean {
  return IGNORE_PATTERNS.some((pattern) => {
    const regex = new RegExp(
      pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.')
    );
    return regex.test(path);
  });
}

/**
 * Generate changelog entry
 */
function generateChangelog(currentFiles: Set<string>, previousFiles: Set<string>): ChangelogEntry {
  const added: string[] = [];
  const removed: string[] = [];

  for (const file of currentFiles) {
    if (!previousFiles.has(file)) {
      added.push(file);
    }
  }

  for (const file of previousFiles) {
    if (!currentFiles.has(file)) {
      removed.push(file);
    }
  }

  return { added, removed };
}

/**
 * Write changelog file
 */
async function writeChangelog(
  changelog: ChangelogEntry,
  targetDir: string,
  changelogSubDir = 'inventory'
): Promise<void> {
  if (changelog.added.length === 0 && changelog.removed.length === 0) {
    return; // No changes, no changelog needed
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15);
  const changelogDir = join(targetDir, '.agent', 'changelogs', changelogSubDir);

  // Create directory if it doesn't exist
  await mkdir(changelogDir, { recursive: true });

  let content = '# Inventory Sync Log\n\n';
  content += `**Timestamp:** ${now.toISOString()}\n\n`;

  if (changelog.added.length > 0) {
    content += '## Added\n\n';
    for (const file of changelog.added) {
      content += `- \`${file}\`\n`;
    }
    content += '\n';
  }

  if (changelog.removed.length > 0) {
    content += '## Removed\n\n';
    for (const file of changelog.removed) {
      content += `- \`${file}\`\n`;
    }
    content += '\n';
  }

  const filename = `${timestamp}_Inventory.md`;
  const filepath = join(changelogDir, filename);

  await writeFile(filepath, content, 'utf-8');
  console.log(`📝 Changelog written to: ${filepath}`);
}

/**
 * Calculate code metrics for a single file
 * Returns: { lines, functions, exports }
 */
async function calculateFileMetrics(filepath: string, projectPath: string): Promise<FileMetrics> {
  const fullPath = join(projectPath, filepath);
  const content = await readFile(fullPath, 'utf-8');
  const lines = content.split('\n').length;

  // Count function declarations
  let functions = 0;

  // Match: function name(...)
  const functionMatches = content.match(/^function\s+\w+\s*\(/gm);
  if (functionMatches) functions += functionMatches.length;

  // Match: const/let/var name = (...), arrow functions
  const arrowMatches = content.match(/^(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/gm);
  if (arrowMatches) functions += arrowMatches.length;

  // Match: methodName(...) { in class
  const methodMatches = content.match(/^\s*(?:async\s+)?\w+\s*\([^)]*\)\s*\{/gm);
  if (methodMatches) functions += methodMatches.length;

  // Match: get/set propertyName(
  const getterSetterMatches = content.match(/^\s*(?:get|set)\s+\w+\s*\(/gm);
  if (getterSetterMatches) functions += getterSetterMatches.length;

  // Count export statements
  let exports = 0;

  // Match: export { ... }
  const namedExports = content.match(/export\s+\{/g);
  if (namedExports) exports += namedExports.length;

  // Match: export const/let/var/function/class
  const directExports = content.match(
    /export\s+(?:const|let|var|function|class|interface|type)\s+/g
  );
  if (directExports) exports += directExports.length;

  // Match: export default ...
  const defaultExports = content.match(/export\s+default\s+/g);
  if (defaultExports) exports += defaultExports.length;

  return { lines, functions, exports };
}

// ============================================================================
// Orphan/Dead Code Detection
// ============================================================================

interface OrphanReport {
  file: string;
  reason: string;
}

/**
 * Detect potentially orphaned files by analyzing imports
 * Returns list of files that may not be imported by any other file
 */
async function detectOrphanFiles(files: string[], projectPath: string): Promise<OrphanReport[]> {
  const orphans: OrphanReport[] = [];

  // Entry points that are expected to not be imported
  const entryPoints = new Set([
    'index.ts',
    'main.ts',
    'server.ts',
    'app.ts',
    'index.js',
    'main.js',
    'server.js',
    'app.js',
    'package.json',
    'vitest.config.ts',
    'vitest.config.js',
    'tsconfig.json',
  ]);

  // Files that may be imported (track all imports)
  const importedFiles = new Set<string>();

  // Scan all TypeScript files for import statements
  const tsFiles = files.filter(
    (f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx')
  );

  for (const filepath of tsFiles) {
    try {
      const fullPath = join(projectPath, filepath);
      const content = await readFile(fullPath, 'utf-8');

      // Match import statements
      // import ... from './module' or import "...module"
      const importMatches = content.matchAll(/import\s+.*?from\s+['"]([^'".]+)['"]/g);

      for (const match of importMatches) {
        const importPath = match[1];
        // Normalize: convert './foo' or '../foo' or 'module' to potential file paths
        const normalized = importPath.replace(/^\.\.?\//, '').replace(/\/index$/, '');
        importedFiles.add(normalized);

        // Also add with extension
        importedFiles.add(`${normalized}.ts`);
        importedFiles.add(`${normalized}.tsx`);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Check each file to see if it's potentially orphaned
  for (const filepath of tsFiles) {
    const filename = filepath.split('/').pop() || '';
    const basename = filename.replace(/\.(ts|tsx|js|jsx)$/, '');

    // Skip entry points
    if (entryPoints.has(filename)) continue;

    // Skip test files (they're typically imported via test runner)
    if (
      filename.endsWith('.test.ts') ||
      filename.endsWith('.test.tsx') ||
      filename.endsWith('.spec.ts') ||
      filename.endsWith('.spec.tsx')
    ) {
      continue;
    }

    // Skip files in __tests__ or test directories
    if (filepath.includes('/tests/') || filepath.includes('/__tests__/')) {
      continue;
    }

    // Check if this file is imported
    const isImported =
      importedFiles.has(basename) ||
      importedFiles.has(filename.replace(/\.(ts|tsx|js|jsx)$/, '')) ||
      importedFiles.has(filepath.replace(/\.(ts|tsx|js|jsx)$/, ''));

    if (!isImported) {
      orphans.push({
        file: filepath,
        reason: 'No imports found from this file',
      });
    }
  }

  return orphans;
}

/**
 * Generate orphan report section for markdown
 */
function generateOrphanReport(orphans: OrphanReport[]): string {
  if (orphans.length === 0) {
    return '## Potential Orphans\n\n> No orphan files detected.\n';
  }

  let content = '## Potential Orphans\n\n';
  content += '> Files that may not be imported by any other file. Review for removal.\n\n';
  content += '| Filepath | Reason |\n';
  content += '| :--- | :--- |\n';

  for (const orphan of orphans) {
    content += `| \`${orphan.file}\` | ${orphan.reason} |\n`;
  }

  return content;
}

/**
 * Generate inventory markdown content
 */
function generateInventoryMarkdown(
  groupedFiles: Map<string, InventoryRow[]>,
  mermaidDiagram: string | null,
  title = 'Code Inventory',
  orphans: OrphanReport[] = [],
  advancedProjectMetrics?: ProjectAdvancedMetrics
): string {
  let content = `# ${title}\n\n`;
  content += '> Auto-generated by `scripts/maintain-inventory.ts`\n';
  content += `> Last updated: ${new Date().toISOString()}\n\n`;

  // Insert Mermaid diagram if exists, otherwise placeholder
  if (mermaidDiagram) {
    content += `${mermaidDiagram}\n\n`;
  } else {
    content += '> Mermaid diagram will be added here. Edit this file to add one.\n\n';
  }

  content += '## Inventory\n\n';
  content += '> Legend:\n';
  content += '> - [x] = Reviewed/Audited\n';
  content += '> - [ ] = Not yet reviewed\n';
  content += '> - Complexity: 🟢 Low (≤10) | 🟡 Medium (11-20) | 🔴 High (>20)\n';
  content += '> - Maintainability: 🟢 Good (≥80) | 🟡 Fair (60-79) | 🔴 Poor (<60)\n\n';

  // Generate table for each group
  for (const [category, files] of groupedFiles.entries()) {
    content += `### ${category}\n\n`;
    content +=
      '| ID | Status | Lines | Functions | Exports | Complexity | Debt | Maintainability | Filepath | Description |\n';
    content += '| :--- | :---: | ---: | ---: | ---: | :---: | :---: | :---: | :--- | :--- |\n';

    for (const file of files) {
      const { id, filepath, status, description, metrics, advancedMetrics } = file;
      const lines = metrics?.lines ?? '-';
      const functions = metrics?.functions ?? '-';
      const exports = metrics?.exports ?? '-';

      // Format advanced metrics
      const complexity = advancedMetrics
        ? formatComplexity(advancedMetrics.complexity.cyclomatic)
        : '-';
      const debt = advancedMetrics
        ? formatDebtCount(advancedMetrics.technicalDebt.items.length)
        : '-';
      const maintainability = advancedMetrics
        ? formatMaintainability(advancedMetrics.maintainabilityIndex)
        : '-';

      content += `| ${id} | ${status} | ${lines} | ${functions} | ${exports} | ${complexity} | ${debt} | ${maintainability} | \`${filepath}\` | ${description} |\n`;
    }

    content += '\n';
  }

  // Add orphan report
  content += `\n${generateOrphanReport(orphans)}\n`;

  // Add advanced metrics summary if available
  if (advancedProjectMetrics) {
    content += '\n';
    content += generateAdvancedMetricsSummary(advancedProjectMetrics);
  }

  return content;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Parse CLI arguments
  const args = parseCliArgs();
  if (!args) {
    // Help was shown, exit gracefully
    process.exit(0);
  }

  console.log('🔍 Starting inventory maintenance...\n');

  console.log('📋 Configuration:');
  console.log(`   Scope: ${args.scope}`);
  console.log(`   Output: ${args.out}`);
  console.log(`   Title: ${args.title}`);
  if (args.relativeTo) {
    console.log(`   Relative to: ${args.relativeTo}`);
  }
  console.log(`   Changelog dir: ${args.changelogDir}`);
  console.log();

  const projectPath = SCRIPT_CONFIG.PROJECT_SOURCE_PATH;

  if (!projectPath) {
    console.error('❌ PROJECT_SOURCE_PATH not configured');
    process.exit(1);
  }

  console.log(`📂 Project path: ${projectPath}`);

  // Target file path
  const targetFile = join(projectPath, args.out);
  const masterFile = join(projectPath, 'docs', 'architecture', 'code_inventory.md');

  // Step 1: Read existing inventory and master inventory
  const existingInventory = new Map<string, InventoryItem>();
  const masterInventory = new Map<string, InventoryItem>();
  const previousFiles = new Set<string>();
  let existingMermaid: string | null = null;

  // Load master first as baseline
  if (existsSync(masterFile)) {
    console.log('📖 Loading master inventory for fallback data...');
    const masterContent = await readFile(masterFile, 'utf-8');
    const parsedMaster = parseInventoryFile(masterContent);
    parsedMaster.forEach((value, key) => {
      masterInventory.set(key, value);
    });
    console.log(`   Found ${parsedMaster.size} master entries`);
  }

  // Load current target
  if (existsSync(targetFile)) {
    console.log('📖 Reading existing inventory...');
    const content = await readFile(targetFile, 'utf-8');
    existingMermaid = extractMermaidDiagram(content);

    const parsed = parseInventoryFile(content);
    parsed.forEach((value, key) => {
      existingInventory.set(key, value);
      previousFiles.add(key);
    });
    console.log(`   Found ${parsed.size} existing entries\n`);
  } else {
    console.log('📄 No existing inventory found. Will create new file.\n');
  }

  // Step 2: Scan for code files
  console.log('🔎 Scanning for code files...');

  // Build patterns combining scope with file extensions
  const patterns = CODE_FILE_EXTENSIONS.map((ext) => {
    // Ensure scope ends with a wildcard if it doesn't already have extension pattern
    if (args.scope.includes('*')) {
      return `${args.scope}${ext}`;
    }
    return `${args.scope}/*${ext}`;
  });

  const allFiles: string[] = [];

  for (const pattern of patterns) {
    const files = await glob(pattern, {
      cwd: projectPath,
      ignore: IGNORE_PATTERNS,
      absolute: false,
      nodir: true,
    });
    allFiles.push(...files);
  }

  // Remove duplicates
  const uniqueFiles = Array.from(new Set(allFiles));
  console.log(`   Found ${uniqueFiles.length} files\n`);

  // Step 3: Build inventory with preserved metadata
  console.log('🏗️  Building inventory...');

  const currentFiles = new Set<string>(uniqueFiles);
  const groupedFiles = new Map<string, InventoryRow[]>();

  let nextId = 1;
  // Get max ID from existing to continue sequence if needed
  const allExistingItems = [...existingInventory.values(), ...masterInventory.values()];
  const numericIds = allExistingItems
    .map((item) => Number.parseInt(item.id || '0', 10))
    .filter((id) => !Number.isNaN(id));
  if (numericIds.length > 0) {
    nextId = Math.max(...numericIds) + 1;
  }

  // Only calculate metrics for code files (.ts, .tsx, .js, .jsx)
  const codeExtensions = ['.ts', '.tsx', '.js', '.jsx'];
  const codeFiles = uniqueFiles.filter((f) => codeExtensions.some((ext) => f.endsWith(ext)));

  console.log(`   Calculating metrics for ${codeFiles.length} code files...`);
  const metricsMap = new Map<string, FileMetrics>();

  // Calculate metrics in parallel
  const metricsPromises = codeFiles.map(async (filepath) => {
    const metrics = await calculateFileMetrics(filepath, projectPath);
    metricsMap.set(filepath, metrics);
  });
  await Promise.all(metricsPromises);
  console.log('   Basic metrics calculated');

  // Calculate advanced metrics
  console.log(`   Calculating advanced metrics for ${codeFiles.length} code files...`);
  const advancedMetricsMap = new Map<string, AdvancedFileMetrics>();
  const advancedMetricsPromises = codeFiles.map(async (filepath) => {
    const metrics = await calculateAdvancedMetrics(filepath, projectPath);
    if (metrics) {
      advancedMetricsMap.set(filepath, metrics);
    }
  });
  await Promise.all(advancedMetricsPromises);
  console.log('   Advanced metrics calculated\n');

  for (const filepath of uniqueFiles) {
    const existing = existingInventory.get(filepath);
    const master = masterInventory.get(filepath);

    // Logic:
    // 1. Prefer existing if it has a description
    // 2. Fallback to master if master has a description
    // 3. Use existing if found, else master
    let preserved = existing;
    if (!existing?.description && master?.description) {
      preserved = master;
    } else if (!existing && master) {
      preserved = master;
    }

    const metrics = metricsMap.get(filepath);
    const advancedMetrics = advancedMetricsMap.get(filepath);

    const row: InventoryRow = {
      id: preserved?.id || (nextId++).toString().padStart(3, '0'),
      filepath,
      status: preserved?.status || '[ ]',
      description: preserved?.description || '',
      metrics,
      advancedMetrics,
    };

    const topLevelDir = getTopLevelDirectory(filepath, args.relativeTo);
    if (!groupedFiles.has(topLevelDir)) {
      groupedFiles.set(topLevelDir, []);
    }
    groupedFiles.get(topLevelDir)?.push(row);
  }

  console.log(`   Grouped into ${groupedFiles.size} categories\n`);

  // Sort categories and files within each category
  const sortedCategories = Array.from(groupedFiles.keys()).sort();
  for (const category of sortedCategories) {
    const files = groupedFiles.get(category) ?? [];
    files.sort((a, b) => a.filepath.localeCompare(b.filepath));
  }

  // Step 4: Detect orphan files
  console.log('🔍 Detecting orphan files...');
  const orphans = await detectOrphanFiles(uniqueFiles, projectPath);
  console.log(`   Found ${orphans.length} potential orphans\n`);

  // Step 5: Calculate project-wide advanced metrics
  console.log('📊 Calculating project-wide advanced metrics...');
  const advancedProjectMetrics = await calculateProjectAdvancedMetrics(uniqueFiles, projectPath);
  console.log('   Project metrics calculated\n');

  // Step 6: Generate and write changelog
  console.log('📝 Checking for changes...');
  const changelog = generateChangelog(currentFiles, previousFiles);

  if (changelog.added.length > 0 || changelog.removed.length > 0) {
    console.log(`   Added: ${changelog.added.length} files`);
    console.log(`   Removed: ${changelog.removed.length} files\n`);

    await writeChangelog(changelog, projectPath, args.changelogDir);
  } else {
    console.log('   No changes detected\n');
  }

  // Step 7: Generate and write inventory file
  console.log('💾 Writing inventory file...');

  // Create docs/architecture directory if it doesn't exist
  const targetDir = dirname(targetFile);
  await mkdir(targetDir, { recursive: true });

  const markdown = generateInventoryMarkdown(
    new Map(sortedCategories.map((cat) => [cat, groupedFiles.get(cat) ?? []])),
    existingMermaid,
    args.title,
    orphans,
    advancedProjectMetrics
  );

  await writeFile(targetFile, markdown, 'utf-8');
  console.log(`   Written to: ${targetFile}\n`);

  console.log('✅ Inventory maintenance complete!\n');
  console.log('📈 Summary:');
  console.log(`   Total files: ${uniqueFiles.length}`);
  console.log(`   Categories: ${sortedCategories.length}`);
  console.log(`   Files with advanced metrics: ${advancedMetricsMap.size}`);
  console.log(`   Cross-file duplicates: ${advancedProjectMetrics.crossFileDuplicates.length}`);
  console.log(`   Total debt items: ${advancedProjectMetrics.projectDebtSummary.totalDebtItems}`);
  if (changelog.added.length > 0 || changelog.removed.length > 0) {
    console.log(`   Files added: ${changelog.added.length}`);
    console.log(`   Files removed: ${changelog.removed.length}`);
  }
}

// Run the script
main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
