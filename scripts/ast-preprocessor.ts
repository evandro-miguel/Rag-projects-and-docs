/**
 * @module ast-preprocessor
 * @description AST preprocessing service for code files.
 *
 * This script preprocesses code files using the tree-sitter based symbol parser
 * to extract functions, classes, interfaces, and other symbols before ingestion.
 * Results are cached with hash-based invalidation for efficient incremental processing.
 *
 * **Purpose:**
 * - Extract code symbols using tree-sitter AST parsing
 * - Create atomic chunks from symbols for intelligent chunking
 * - Cache results with content hashing for incremental updates
 * - Prepare code files for RAG ingestion
 *
 * **When to run:**
 * - Before project ingestion to precompute symbol boundaries
 * - During development to analyze code structure
 * - As part of CI/CD pipeline for consistent chunking
 *
 * **Supported Languages:**
 * - TypeScript/TSX (.ts, .tsx)
 * - JavaScript/JSX (.js, .jsx, .mjs, .cjs)
 * - Python (.py)
 * - Rust, Go, Java, C, C++, C#, and more (see symbol_parser.ts)
 *
 * **Usage:**
 * ```bash
 * # Process files in a directory
 * bun run scripts/ast-preprocessor.ts --root ./lib --output ./.data/ast-cache
 *
 * # Process with specific extensions
 * bun run scripts/ast-preprocessor.ts --root ./src --output ./.cache --extensions .ts,.tsx
 *
 * # Force reprocessing (ignore cache)
 * bun run scripts/ast-preprocessor.ts --root ./src --output ./.cache --force
 * ```
 *
 * **Output Format:**
 * Each file produces a JSON entry with:
 * - `filePath`: Absolute path to source file
 * - `hash`: SHA-256 hash of file content
 * - `symbols`: Array of extracted symbols with kind, name, line numbers
 * - `chunks`: Array of symbol chunks with content for RAG ingestion
 *
 * @example
 * // Process library sources
 * bun run scripts/ast-preprocessor.ts --root ./lib --output ./.data/ast-cache
 *
 * @see lib/ingest/symbol_parser.ts - Tree-sitter symbol extraction
 * @see scripts/lib/ast-cache.ts - Cache management
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { glob } from 'glob';
import {
  extractSymbols,
  flattenSymbols,
  type SymbolLocation,
} from '../lib/ingest/symbol_parser.js';
import {
  type AstSymbol,
  type AstSymbolChunk,
  calculateFileHash,
  isCacheValid,
  readAstCache,
  writeAstCache,
} from './lib/ast-cache.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Processing result for a single file.
 */
interface ProcessedFile {
  filePath: string;
  hash: string;
  symbols: AstSymbol[];
  chunks: AstSymbolChunk[];
  error?: string;
}

/**
 * Summary statistics for preprocessing run.
 */
interface PreprocessSummary {
  totalFiles: number;
  processedFiles: number;
  cachedFiles: number;
  errorFiles: number;
  totalSymbols: number;
  totalChunks: number;
  durationMs: number;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Default file extensions to process.
 */
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py'];

/**
 * Glob patterns to ignore.
 */
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.git/**',
  '**/.agent/**',
  '**/.agents/**',
  '**/.claude/**',
  '**/.gemini/**',
  '**/.cursor/**',
  '**/.copilot/**',
  '**/.opencode/**',
  '**/.aider/**',
  '**/.continue/**',
  '**/.vscode/**',
  '**/.idea/**',
];

// ============================================================================
// CLI ARGUMENTS
// ============================================================================

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: {
      type: 'string',
      short: 'r',
      description: 'Root directory to process',
    },
    output: {
      type: 'string',
      short: 'o',
      description: 'Output directory for cache',
    },
    extensions: {
      type: 'string',
      short: 'e',
      description: 'Comma-separated file extensions (default: .ts,.tsx,.js,.jsx,.py)',
    },
    force: {
      type: 'boolean',
      short: 'f',
      default: false,
      description: 'Force reprocessing (ignore cache)',
    },
    verbose: {
      type: 'boolean',
      short: 'v',
      default: false,
      description: 'Enable verbose output',
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
      description: 'Show help message',
    },
  },
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Show help message and exit.
 */
function showHelp(): void {
  console.log(`
AST Preprocessor - Extract code symbols using tree-sitter

Usage: bun run scripts/ast-preprocessor.ts [options]

Options:
  -r, --root <path>      Root directory to process (required)
  -o, --output <path>    Output directory for cache (required)
  -e, --extensions <ext> Comma-separated file extensions (default: .ts,.tsx,.js,.jsx,.py)
  -f, --force            Force reprocessing (ignore cache)
  -v, --verbose          Enable verbose output
  -h, --help             Show this help message

Examples:
  bun run scripts/ast-preprocessor.ts --root ./lib --output ./.data/ast-cache
  bun run scripts/ast-preprocessor.ts --root ./src --output ./.cache --extensions .ts,.tsx
  bun run scripts/ast-preprocessor.ts --root ./src --output ./.cache --force
`);
  process.exit(0);
}

/**
 * Log verbose message if verbose mode is enabled.
 */
function logVerbose(msg: string): void {
  if (values.verbose) {
    console.log(`  ${msg}`);
  }
}

/**
 * Convert SymbolLocation to AstSymbol format.
 */
function convertSymbolLocation(sym: SymbolLocation): AstSymbol {
  return {
    name: sym.name,
    kind: sym.kind,
    line: sym.line,
    endLine: sym.endLine,
    signature: sym.signature,
  };
}

/**
 * Extract chunk content from file based on line range.
 */
async function extractChunkContent(
  filePath: string,
  startLine: number,
  endLine: number
): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  } catch {
    return '';
  }
}

/**
 * Create symbol chunks from extracted symbols.
 */
async function createSymbolChunks(
  filePath: string,
  symbols: SymbolLocation[]
): Promise<AstSymbolChunk[]> {
  const chunks: AstSymbolChunk[] = [];

  for (const sym of symbols) {
    const content = await extractChunkContent(filePath, sym.line, sym.endLine);
    chunks.push({
      symbolName: sym.name,
      kind: sym.kind,
      content,
      line: sym.line,
      endLine: sym.endLine,
    });
  }

  return chunks;
}

// ============================================================================
// FILE PROCESSING
// ============================================================================

/**
 * Process a single file and extract symbols.
 */
async function processFile(
  filePath: string,
  cacheDir: string,
  force: boolean
): Promise<ProcessedFile> {
  const startTime = Date.now();
  const ext = path.extname(filePath).toLowerCase();

  logVerbose(`Processing: ${filePath}`);

  try {
    // Check cache if not forcing reprocess
    if (!force) {
      const cached = await readAstCache(filePath, cacheDir);
      if (cached && (await isCacheValid(filePath, cached.hash))) {
        logVerbose(`  Cache hit (${Date.now() - startTime}ms)`);
        return {
          filePath,
          hash: cached.hash,
          symbols: cached.symbols,
          chunks: cached.chunks,
        };
      }
    }

    // Read file content
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = await calculateFileHash(filePath);

    // Extract symbols using tree-sitter
    const symbols = await extractSymbols(content, ext);

    if (!symbols) {
      // No symbols found or unsupported language
      logVerbose(`  No symbols found (${Date.now() - startTime}ms)`);
      return {
        filePath,
        hash,
        symbols: [],
        chunks: [],
      };
    }

    // Flatten symbols and convert to output format
    const flatSymbols = flattenSymbols(symbols);
    const astSymbols = flatSymbols.map(convertSymbolLocation);

    // Create chunks with content
    const chunks = await createSymbolChunks(filePath, flatSymbols);

    // Write to cache
    const mtime = Date.now();
    await writeAstCache(
      filePath,
      {
        hash,
        mtime,
        symbols: astSymbols,
        chunks,
      },
      cacheDir
    );

    logVerbose(`  Processed ${symbols.length} symbols (${Date.now() - startTime}ms)`);

    return {
      filePath,
      hash,
      symbols: astSymbols,
      chunks,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`  Error processing ${filePath}: ${errorMsg}`);
    return {
      filePath,
      hash: '',
      symbols: [],
      chunks: [],
      error: errorMsg,
    };
  }
}

/**
 * Discover files to process.
 */
async function discoverFiles(rootDir: string, extensions: string[]): Promise<string[]> {
  const patterns = extensions.map((ext) => path.join(rootDir, '**', `*${ext}`));
  const files: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      ignore: IGNORE_PATTERNS,
      absolute: true,
    });
    files.push(...matches);
  }

  // Remove duplicates and sort
  return Array.from(new Set(files)).sort();
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  // Show help if requested
  if (values.help) {
    showHelp();
  }

  // Validate required arguments
  if (!values.root) {
    console.error('Error: --root is required');
    showHelp();
    process.exit(1);
  }
  if (!values.output) {
    console.error('Error: --output is required');
    showHelp();
    process.exit(1);
  }

  const rootDir = path.resolve(values.root);
  const cacheDir = path.resolve(values.output);
  const force = values.force ?? false;
  const verbose = values.verbose ?? false;

  // Parse extensions
  const extensions = values.extensions
    ? values.extensions.split(',').map((e) => (e.startsWith('.') ? e : `.${e}`))
    : DEFAULT_EXTENSIONS;

  console.log('🔍 AST Preprocessor');
  console.log(`   Root: ${rootDir}`);
  console.log(`   Output: ${cacheDir}`);
  console.log(`   Extensions: ${extensions.join(', ')}`);
  console.log(`   Force: ${force}`);
  console.log();

  // Verify root directory exists
  try {
    const stats = await fs.stat(rootDir);
    if (!stats.isDirectory()) {
      console.error(`Error: ${rootDir} is not a directory`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: Directory not found: ${rootDir}`);
    process.exit(1);
  }

  // Ensure cache directory exists
  await fs.mkdir(cacheDir, { recursive: true });

  // Discover files
  const startTime = Date.now();
  console.log('📁 Discovering files...');
  const files = await discoverFiles(rootDir, extensions);
  console.log(`   Found ${files.length} files to process`);
  console.log();

  if (files.length === 0) {
    console.log('No files found matching the specified extensions.');
    process.exit(0);
  }

  // Process files
  console.log('⚙️  Processing files...');
  if (verbose) {
    console.log();
  }

  const results: ProcessedFile[] = [];
  let processedCount = 0;
  let cachedCount = 0;
  let errorCount = 0;
  let totalSymbols = 0;
  let totalChunks = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progress = `[${i + 1}/${files.length}]`;

    if (!verbose) {
      process.stdout.write(`\r   ${progress} Processing...`);
    }

    const result = await processFile(file, cacheDir, force);
    results.push(result);

    if (result.error) {
      errorCount++;
    } else {
      // Check if it was cached or processed
      const cached = await readAstCache(file, cacheDir);
      const isFresh = !cached || cached.hash !== result.hash;
      if (isFresh) {
        processedCount++;
      } else {
        cachedCount++;
      }
    }

    totalSymbols += result.symbols.length;
    totalChunks += result.chunks.length;
  }

  if (!verbose) {
    console.log(); // New line after progress
  }
  console.log();

  // Generate summary
  const durationMs = Date.now() - startTime;
  const summary: PreprocessSummary = {
    totalFiles: files.length,
    processedFiles: processedCount,
    cachedFiles: cachedCount,
    errorFiles: errorCount,
    totalSymbols,
    totalChunks,
    durationMs,
  };

  // Print summary
  console.log('📊 Summary');
  console.log(`   Total files: ${summary.totalFiles}`);
  console.log(`   Processed: ${summary.processedFiles}`);
  console.log(`   Cached: ${summary.cachedFiles}`);
  console.log(`   Errors: ${summary.errorFiles}`);
  console.log(`   Total symbols: ${summary.totalSymbols}`);
  console.log(`   Total chunks: ${summary.totalChunks}`);
  console.log(`   Duration: ${(summary.durationMs / 1000).toFixed(2)}s`);
  console.log();

  // Write summary JSON
  const summaryPath = path.join(cacheDir, 'preprocess-summary.json');
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        ...summary,
        timestamp: new Date().toISOString(),
        rootDir,
        extensions,
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log(`💾 Summary written to: ${summaryPath}`);

  // Exit with error code if there were errors
  if (errorCount > 0) {
    console.log();
    console.warn(`⚠️  ${errorCount} files had errors`);
    process.exit(1);
  }

  console.log();
  console.log('✅ Preprocessing complete');
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
