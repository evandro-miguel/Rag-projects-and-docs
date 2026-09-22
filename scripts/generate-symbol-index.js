#!/usr/bin/env node
/**
 * Lightweight symbol indexer (ctags-like functionality)
 * Extracts function, class, interface, and export definitions from TypeScript files
 *
 * Usage: node scripts/generate-symbol-index.js [output-file]
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT_DIR = process.argv[3] || join(process.cwd());
const OUTPUT_FILE = process.argv[2] || 'symbol-index.json';

console.log(`Scanning: ${ROOT_DIR}`);

// Patterns for TypeScript symbols
const SYMBOL_PATTERNS = {
  // export const/function/class/etc
  export: /export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g,
  // export default
  'export-default': /export\s+default\s+(?:function\s+)?(\w+)/g,
  // const/let/var name =
  const: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g,
  // function name(
  function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g,
  // class Name
  class: /(?:export\s+)?class\s+(\w+)/g,
  // interface Name
  interface: /(?:export\s+)?interface\s+(\w+)/g,
  // type Name =
  type: /(?:export\s+)?type\s+(\w+)\s*=/g,
  // enum Name
  enum: /(?:export\s+)?enum\s+(\w+)/g,
};

const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.qwen',
  '.afol/wb',
  'coverage',
  '__tests__',
  '__mocks__',
];

const FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function shouldIgnore(dir) {
  // Don't ignore root directory
  if (dir === '.' || dir.endsWith('/.') || dir === process.cwd()) {
    return false;
  }
  return IGNORE_DIRS.some((ignore) => dir.includes(ignore));
}

function extractSymbols(_filePath, content) {
  const symbols = [];

  // Extract exports
  for (const match of content.matchAll(SYMBOL_PATTERNS.export)) {
    symbols.push({
      name: match[1],
      kind: 'export',
      line: getLineNumber(content, match.index),
    });
  }

  // Extract functions
  for (const match of content.matchAll(SYMBOL_PATTERNS.function)) {
    symbols.push({
      name: match[1],
      kind: 'function',
      line: getLineNumber(content, match.index),
    });
  }

  // Extract classes
  for (const match of content.matchAll(SYMBOL_PATTERNS.class)) {
    symbols.push({
      name: match[1],
      kind: 'class',
      line: getLineNumber(content, match.index),
    });
  }

  // Extract interfaces
  for (const match of content.matchAll(SYMBOL_PATTERNS.interface)) {
    symbols.push({
      name: match[1],
      kind: 'interface',
      line: getLineNumber(content, match.index),
    });
  }

  // Extract types
  for (const match of content.matchAll(SYMBOL_PATTERNS.type)) {
    symbols.push({
      name: match[1],
      kind: 'type',
      line: getLineNumber(content, match.index),
    });
  }

  // Extract enums
  for (const match of content.matchAll(SYMBOL_PATTERNS.enum)) {
    symbols.push({
      name: match[1],
      kind: 'enum',
      line: getLineNumber(content, match.index),
    });
  }

  return symbols;
}

function getLineNumber(content, index) {
  return content.substring(0, index).split('\n').length;
}

function walkDir(dir, baseDir = dir) {
  const results = [];

  if (shouldIgnore(dir)) {
    return results;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, baseDir));
    } else if (entry.isFile() && FILE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const symbols = extractSymbols(content, fullPath);

        if (symbols.length > 0) {
          results.push({
            path: relPath,
            symbols,
            symbolCount: symbols.length,
          });
        } else {
          console.log(`No symbols in ${relPath}`);
        }
      } catch (error) {
        console.log(`Error reading ${relPath}: ${error.message}`);
      }
    }
  }

  return results;
}

function generateIndex() {
  console.log('🔍 Generating symbol index...');

  const files = walkDir(ROOT_DIR);

  // Sort by symbol count
  files.sort((a, b) => b.symbolCount - a.symbolCount);

  const totalSymbols = files.reduce((sum, f) => sum + f.symbolCount, 0);

  const index = {
    generated: new Date().toISOString(),
    totalFiles: files.length,
    totalSymbols,
    files,
    topSymbols: files
      .flatMap((f) => f.symbols.map((s) => ({ ...s, file: f.path })))
      .sort((a, b) => a.line - b.line)
      .slice(0, 100),
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(index, null, 2));

  console.log(`✅ Generated symbol index with ${totalSymbols} symbols from ${files.length} files`);
  console.log(`📄 Output: ${OUTPUT_FILE}`);

  // Print top files
  console.log('\n📊 Top files by symbol count:');
  files.slice(0, 10).forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.path} (${f.symbolCount} symbols)`);
  });

  return index;
}

// Run
generateIndex();
