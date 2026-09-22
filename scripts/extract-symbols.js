#!/usr/bin/env node
/**
 * TypeScript Symbol Extractor (ctags-like JSON output)
 *
 * This script extracts TypeScript symbols and outputs in ctags-compatible JSON format
 *
 * Usage: node scripts/extract-symbols.js [output.json] [directory]
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const OUTPUT_FILE = process.argv[2] || 'symbols.json';
const ROOT_DIR = process.argv[3] || '.';

console.log(`🔍 Extracting symbols from ${ROOT_DIR}...`);

const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.qwen',
  '.afol/wb',
  'coverage',
  '__tests__',
  '.nvm',
  '.local',
];

const FILE_PATTERNS = ['.ts', '.tsx'];

// Regex patterns for TypeScript symbols
const PATTERNS = {
  'export-const': {
    regex: /export\s+const\s+(\w+)/g,
    kind: 'variable',
  },
  'export-let': {
    regex: /export\s+let\s+(\w+)/g,
    kind: 'variable',
  },
  'export-var': {
    regex: /export\s+var\s+(\w+)/g,
    kind: 'variable',
  },
  'export-function': {
    regex: /export\s+(?:async\s+)?function\s+(\w+)/g,
    kind: 'function',
  },
  'export-class': {
    regex: /export\s+class\s+(\w+)/g,
    kind: 'class',
  },
  'export-interface': {
    regex: /export\s+interface\s+(\w+)/g,
    kind: 'interface',
  },
  'export-type': {
    regex: /export\s+type\s+(\w+)/g,
    kind: 'type',
  },
  'export-enum': {
    regex: /export\s+enum\s+(\w+)/g,
    kind: 'enum',
  },
  'export-default': {
    regex: /export\s+default\s+(?:function\s+)?(\w+)/g,
    kind: 'function',
  },
  const: {
    regex: /(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=/g,
    kind: 'variable',
  },
  function: {
    regex: /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g,
    kind: 'function',
  },
};

function shouldIgnore(dir) {
  if (dir === '.' || dir === process.cwd()) return false;
  return IGNORE_DIRS.some((ignore) => dir.includes(ignore));
}

function getLineNumber(content, index) {
  return content.substring(0, index).split('\n').length;
}

function extractSymbols(_filePath, content) {
  const symbols = [];

  for (const [patternName, { regex, kind }] of Object.entries(PATTERNS)) {
    // Reset regex lastIndex
    regex.lastIndex = 0;

    for (const match of content.matchAll(regex)) {
      const name = match[1];
      const line = getLineNumber(content, match.index);

      // Skip test files and private members
      if (name.startsWith('_') || name.startsWith('test')) continue;

      symbols.push({
        name,
        kind,
        line,
        pattern: patternName,
      });
    }
  }

  // Remove duplicates (same name, same line)
  const unique = symbols.filter(
    (s, i, arr) => arr.findIndex((x) => x.name === s.name && x.line === s.line) === i
  );

  return unique.sort((a, b) => a.line - b.line);
}

function walkDir(dir, baseDir = dir) {
  const results = [];

  if (shouldIgnore(dir)) return results;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, baseDir));
    } else if (entry.isFile() && FILE_PATTERNS.some((ext) => entry.name.endsWith(ext))) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const symbols = extractSymbols(fullPath, content);

        if (symbols.length > 0) {
          results.push({
            path: relPath,
            symbols,
            count: symbols.length,
          });
        }
      } catch {}
    }
  }

  return results;
}

function generateCTagsJSON(files) {
  // Convert to ctags-like JSON format
  const tags = [];

  for (const file of files) {
    for (const symbol of file.symbols) {
      tags.push({
        name: symbol.name,
        path: file.path,
        kind: symbol.kind,
        line: symbol.line,
      });
    }
  }

  return {
    generated: new Date().toISOString(),
    totalFiles: files.length,
    totalSymbols: tags.length,
    tags: tags.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.line - b.line;
    }),
  };
}

// Main
const files = walkDir(ROOT_DIR);
const sorted = files.sort((a, b) => b.count - a.count);
const output = generateCTagsJSON(sorted);

writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

console.log(`✅ Generated ${output.totalSymbols} symbols from ${output.totalFiles} files`);
console.log(`📄 Output: ${OUTPUT_FILE}`);
console.log('\n📊 Top files by symbol count:');
sorted.slice(0, 10).forEach((f, i) => {
  console.log(`  ${i + 1}. ${f.path} (${f.count} symbols)`);
});

// Save summary
const summary = {
  generated: output.generated,
  totalFiles: output.totalFiles,
  totalSymbols: output.totalSymbols,
  topFiles: sorted.slice(0, 20).map((f) => ({ path: f.path, count: f.count })),
  byKind: {},
};

// Count by kind
for (const tag of output.tags) {
  summary.byKind[tag.kind] = (summary.byKind[tag.kind] || 0) + 1;
}

writeFileSync('symbols-summary.json', JSON.stringify(summary, null, 2));
console.log('\n📝 Summary saved to symbols-summary.json');
