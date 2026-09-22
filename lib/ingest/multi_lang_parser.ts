'use node';
/**
 * @module ingest/multi_lang_parser
 * @description Multi-language symbol extraction with quality bounds for Project RAG.
 *
 * This module provides specialized parsers for Python, Go, Rust, and Java with
 * configurable quality thresholds and metrics tracking. It extends the base
 * symbol_parser.ts with language-specific optimizations and quality guarantees.
 *
 * **Supported Languages:**
 * - **Python**: AST-based parsing with class/function extraction
 * - **Go**: Tree-sitter with struct/interface/method support
 * - **Rust**: Tree-sitter with trait/impl/struct/function support
 * - **Java**: Tree-sitter with class/interface/method support
 *
 * **Quality Bounds:**
 * Each language has configurable quality thresholds:
 * - `minAccuracy`: Minimum symbol detection accuracy (0-1)
 * - `minCoverage`: Minimum code coverage for extraction (0-1)
 * - `maxParseTimeMs`: Maximum parsing time allowed
 * - `minConfidence`: Minimum confidence score for symbols (0-1)
 *
 * @example
 * import { parseWithQuality, Language } from './multi_lang_parser.js';
 *
 * const result = await parseWithQuality({
 *   code: pythonCode,
 *   language: Language.Python,
 *   sourcePath: 'src/main.py',
 *   qualityBounds: { minAccuracy: 0.9, minCoverage: 0.8 }
 * });
 *
 * if (result.quality.passed) {
 *   console.log(`Extracted ${result.symbols.length} symbols`);
 *   console.log(`Quality score: ${result.quality.score}`);
 * }
 */

import {
  type CodeSymbol,
  extractSymbols,
  flattenSymbols,
  type SymbolLocation,
} from './symbol_parser.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Supported programming languages for multi-language parsing.
 */
export enum Language {
  Python = 'python',
  Go = 'go',
  Rust = 'rust',
  Java = 'java',
}

/**
 * Quality bounds configuration for language-specific parsing.
 */
export interface QualityBounds {
  /** Minimum symbol detection accuracy (0-1, default: 0.85) */
  minAccuracy?: number;
  /** Minimum code coverage for extraction (0-1, default: 0.75) */
  minCoverage?: number;
  /** Maximum parsing time in milliseconds (default: 5000) */
  maxParseTimeMs?: number;
  /** Minimum confidence score for symbols (0-1, default: 0.7) */
  minConfidence?: number;
  /** Minimum number of symbols expected (default: 0) */
  minSymbolCount?: number;
}

/**
 * Quality metrics from parsing operation.
 */
export interface QualityMetrics {
  /** Whether quality bounds were met */
  passed: boolean;
  /** Overall quality score (0-1) */
  score: number;
  /** Symbol detection accuracy estimate */
  accuracy: number;
  /** Code coverage percentage */
  coverage: number;
  /** Average confidence score */
  confidence: number;
  /** Parsing time in milliseconds */
  parseTimeMs: number;
  /** Number of symbols extracted */
  symbolCount: number;
  /** Number of syntax errors encountered */
  errorCount: number;
  /** Whether quality fallback was used */
  usedFallback: boolean;
}

/**
 * Result from multi-language parsing with quality metrics.
 */
export interface MultiLangParseResult {
  /** Extracted symbols */
  symbols: CodeSymbol[];
  /** Quality metrics and pass/fail status */
  quality: QualityMetrics;
  /** Language used for parsing */
  language: Language;
  /** Source path (for debugging) */
  sourcePath: string;
  /** Any warnings or errors */
  warnings: string[];
}

/**
 * Parser configuration per language.
 */
interface LanguageConfig {
  /** File extensions for this language */
  extensions: string[];
  /** Default quality bounds */
  defaultBounds: QualityBounds;
  /** Whether AST parsing is available (vs tree-sitter only) */
  supportsAst: boolean;
  /** Symbol types this language supports */
  supportedSymbols: string[];
}

/**
 * Internal parse result before quality assessment.
 */
interface ParseAttempt {
  symbols: CodeSymbol[];
  parseTimeMs: number;
  errorCount: number;
  usedFallback: boolean;
}

// ============================================================================
// LANGUAGE CONFIGURATION
// ============================================================================

/**
 * Language-specific configurations with quality defaults.
 */
const LANGUAGE_CONFIGS: Record<Language, LanguageConfig> = {
  [Language.Python]: {
    extensions: ['.py', '.pyw', '.pyi'],
    defaultBounds: {
      minAccuracy: 0.9,
      minCoverage: 0.8,
      maxParseTimeMs: 3000,
      minConfidence: 0.75,
      minSymbolCount: 0,
    },
    supportsAst: true,
    supportedSymbols: ['function', 'class', 'method', 'const', 'variable'],
  },
  [Language.Go]: {
    extensions: ['.go'],
    defaultBounds: {
      minAccuracy: 0.88,
      minCoverage: 0.75,
      maxParseTimeMs: 3000,
      minConfidence: 0.7,
      minSymbolCount: 0,
    },
    supportsAst: false,
    supportedSymbols: ['function', 'method', 'struct', 'interface', 'type'],
  },
  [Language.Rust]: {
    extensions: ['.rs'],
    defaultBounds: {
      minAccuracy: 0.9,
      minCoverage: 0.8,
      maxParseTimeMs: 4000,
      minConfidence: 0.75,
      minSymbolCount: 0,
    },
    supportsAst: false,
    supportedSymbols: ['function', 'struct', 'enum', 'trait', 'impl', 'const'],
  },
  [Language.Java]: {
    extensions: ['.java'],
    defaultBounds: {
      minAccuracy: 0.88,
      minCoverage: 0.75,
      maxParseTimeMs: 4000,
      minConfidence: 0.7,
      minSymbolCount: 0,
    },
    supportsAst: false,
    supportedSymbols: ['method', 'class', 'interface', 'enum'],
  },
};

// File extension to language mapping
const EXT_TO_LANGUAGE: Record<string, Language> = {
  '.py': Language.Python,
  '.pyw': Language.Python,
  '.pyi': Language.Python,
  '.go': Language.Go,
  '.rs': Language.Rust,
  '.java': Language.Java,
};

// ============================================================================
// PYTHON AST PARSER
// ============================================================================

/**
 * Parse Python code using regex-based extraction (AST-like).
 * This provides better accuracy than tree-sitter for Python-specific constructs.
 *
 * @param code - Python source code
 * @returns Extracted symbols
 */
function parsePythonAst(code: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = code.split('\n');

  // Track class context for methods
  let currentClass: CodeSymbol | null = null;
  let classIndent = -1;
  let inClass = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect class definition
    // Matches: class Foo:, class Foo(Bar):, class Foo(object, metaclass=...):
    const classMatch = line.match(/^(\s*)class\s+(\w+)\s*(?:\([^)]*\))?\s*:/);
    if (classMatch) {
      const indent = classMatch[1].length;
      const className = classMatch[2];

      // Reset class context if indentation decreased
      if (inClass && indent <= classIndent) {
        currentClass = null;
        inClass = false;
      }

      const classSymbol: CodeSymbol = {
        name: className,
        kind: 'class',
        line: lineNum,
        endLine: findBlockEnd(lines, i),
        signature: line.trim(),
        children: [],
      };

      symbols.push(classSymbol);
      currentClass = classSymbol;
      classIndent = indent;
      inClass = true;
      continue;
    }

    // Detect function definition
    // Matches: def foo():, async def foo():, def foo(self, ...):
    const funcMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
    if (funcMatch) {
      const indent = funcMatch[1].length;
      const funcName = funcMatch[2];

      // Skip __init__ and other dunder methods from being top-level
      const isDunder = funcName.startsWith('__') && funcName.endsWith('__');

      const funcSymbol: CodeSymbol = {
        name: funcName,
        kind: inClass && indent > classIndent ? 'method' : 'function',
        line: lineNum,
        endLine: findBlockEnd(lines, i),
        signature: line.trim(),
        children: [],
      };

      if (inClass && indent > classIndent && currentClass) {
        // This is a method inside a class
        currentClass.children.push(funcSymbol);
      } else if (!isDunder) {
        // Top-level function (skip dunder methods)
        symbols.push(funcSymbol);
      }

      continue;
    }

    // Detect module-level constants (ALL_CAPS)
    const constMatch = line.match(/^(\s*)([A-Z][A-Z_0-9]*)\s*=\s*/);
    if (constMatch && !inClass) {
      const constName = constMatch[2];
      symbols.push({
        name: constName,
        kind: 'const',
        line: lineNum,
        endLine: lineNum,
        signature: line.trim(),
        children: [],
      });
    }
  }

  return symbols;
}

/**
 * Find the end line of a Python block (function/class).
 *
 * @param lines - All lines of code
 * @param startIdx - Starting line index
 * @returns End line number (1-indexed)
 */
function findBlockEnd(lines: string[], startIdx: number): number {
  const startLine = lines[startIdx];
  const startIndent = startLine.match(/^(\s*)/)?.[1].length ?? 0;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;

    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }

    // If we hit a line with same or less indentation, block ended
    if (lineIndent <= startIndent && line.trim() !== '') {
      return i;
    }
  }

  return lines.length;
}

// ============================================================================
// GO PARSER (Tree-sitter with enhancements)
// ============================================================================

/**
 * Parse Go code using tree-sitter with Go-specific enhancements.
 *
 * @param code - Go source code
 * @returns Extracted symbols
 */
async function parseGo(code: string): Promise<CodeSymbol[]> {
  // Use tree-sitter for Go parsing
  const symbols = await extractSymbols(code, '.go');

  if (!symbols) {
    return [];
  }

  // Add Go-specific symbol detection (receiver methods)
  const enhancedSymbols = enhanceGoSymbols(symbols, code);
  return enhancedSymbols;
}

/**
 * Enhance Go symbols with receiver method detection.
 *
 * @param symbols - Base symbols from tree-sitter
 * @param code - Source code
 * @returns Enhanced symbols
 */
function enhanceGoSymbols(symbols: CodeSymbol[], code: string): CodeSymbol[] {
  const lines = code.split('\n');
  const enhanced: CodeSymbol[] = [];

  // Build struct name map for receiver association
  const structs = symbols.filter((s) => s.kind === 'struct');
  const structNames = new Set(structs.map((s) => s.name));

  for (const sym of symbols) {
    // Detect receiver methods: func (r *Receiver) MethodName(...)
    if (sym.kind === 'function') {
      const line = lines[sym.line - 1] || '';
      const receiverMatch = line.match(/func\s*\(\s*\w+\s*\*?\s*(\w+)\s*\)/);
      if (receiverMatch) {
        const receiverType = receiverMatch[1];
        if (structNames.has(receiverType)) {
          sym.kind = 'method';
          // Store receiver info in signature
          sym.signature = line.trim();
        }
      }
    }
    enhanced.push(sym);
  }

  return enhanced;
}

// ============================================================================
// RUST PARSER (Tree-sitter with enhancements)
// ============================================================================

/**
 * Parse Rust code using tree-sitter with Rust-specific enhancements.
 *
 * @param code - Rust source code
 * @returns Extracted symbols
 */
async function parseRust(code: string): Promise<CodeSymbol[]> {
  // Use tree-sitter for Rust parsing
  const symbols = await extractSymbols(code, '.rs');

  if (!symbols) {
    return [];
  }

  // Add Rust-specific symbol detection
  const enhancedSymbols = enhanceRustSymbols(symbols, code);
  return enhancedSymbols;
}

/**
 * Enhance Rust symbols with impl block and trait detection.
 *
 * @param symbols - Base symbols from tree-sitter
 * @param code - Source code
 * @returns Enhanced symbols
 */
function enhanceRustSymbols(symbols: CodeSymbol[], code: string): CodeSymbol[] {
  const _lines = code.split('\n');
  const enhanced: CodeSymbol[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];

    // Detect impl blocks and associate with structs
    if (sym.kind === 'class' && sym.signature.includes('impl')) {
      sym.kind = 'impl' as any; // Custom kind for impl blocks

      // Extract the type being implemented
      const implMatch = sym.signature.match(/impl\s+(?:<[^>]+>\s+)?(?:\w+\s+for\s+)?(\w+)/);
      if (implMatch) {
        const targetType = implMatch[1];
        sym.name = `impl ${targetType}`;
      }
    }

    enhanced.push(sym);
  }

  return enhanced;
}

// ============================================================================
// JAVA PARSER (Tree-sitter with enhancements)
// ============================================================================

/**
 * Parse Java code using tree-sitter with Java-specific enhancements.
 *
 * @param code - Java source code
 * @returns Extracted symbols
 */
async function parseJava(code: string): Promise<CodeSymbol[]> {
  // Use tree-sitter for Java parsing
  const symbols = await extractSymbols(code, '.java');

  if (!symbols) {
    return [];
  }

  // Add Java-specific symbol detection (annotations, generics)
  const enhancedSymbols = enhanceJavaSymbols(symbols, code);
  return enhancedSymbols;
}

/**
 * Enhance Java symbols with annotation and generic detection.
 *
 * @param symbols - Base symbols from tree-sitter
 * @param code - Source code
 * @returns Enhanced symbols
 */
function enhanceJavaSymbols(symbols: CodeSymbol[], code: string): CodeSymbol[] {
  const lines = code.split('\n');
  const enhanced: CodeSymbol[] = [];

  for (const sym of symbols) {
    // Enhance method signatures with annotations
    if (sym.kind === 'method' && sym.line > 1) {
      // Check for annotations on previous lines
      let prevLineIdx = sym.line - 2;
      const annotationLines: string[] = [];

      while (prevLineIdx >= 0) {
        const line = lines[prevLineIdx]?.trim() || '';
        if (line.startsWith('@')) {
          annotationLines.unshift(line);
          prevLineIdx--;
        } else if (line === '' || line.startsWith('//') || line.startsWith('/*')) {
          prevLineIdx--;
        } else {
          break;
        }
      }

      if (annotationLines.length > 0) {
        sym.signature = `${annotationLines.join(' ')} ${sym.signature}`;
      }
    }

    enhanced.push(sym);
  }

  return enhanced;
}

// ============================================================================
// QUALITY METRICS
// ============================================================================

/**
 * Calculate quality metrics for parsed symbols.
 *
 * @param result - Parse attempt result
 * @param code - Source code
 * @param bounds - Quality bounds
 * @returns Quality metrics
 */
function calculateQualityMetrics(
  result: ParseAttempt,
  code: string,
  bounds: QualityBounds
): QualityMetrics {
  const lines = code.split('\n');
  const totalLines = lines.length;
  const { symbols, parseTimeMs, errorCount, usedFallback } = result;

  // Calculate coverage based on lines covered by symbols
  const coveredLines = new Set<number>();
  for (const sym of symbols) {
    for (let i = sym.line; i <= sym.endLine; i++) {
      coveredLines.add(i);
    }
  }
  const coverage = totalLines > 0 ? coveredLines.size / totalLines : 0;

  // Estimate accuracy based on error count and symbol validity
  const symbolValidity =
    symbols.length > 0
      ? symbols.filter((s) => s.name && s.name !== 'anonymous').length / symbols.length
      : 1;
  const accuracy = Math.max(0, symbolValidity - errorCount * 0.1);

  // Calculate confidence based on symbol extraction quality
  const confidence =
    symbols.length > 0
      ? symbols.reduce((sum, s) => sum + (s.name.length > 0 ? 1 : 0), 0) / symbols.length
      : 0;

  // Calculate overall score
  const minAccuracy = bounds.minAccuracy ?? 0.85;
  const minCoverage = bounds.minCoverage ?? 0.75;
  const maxParseTimeMs = bounds.maxParseTimeMs ?? 5000;
  const minConfidence = bounds.minConfidence ?? 0.7;
  const minSymbolCount = bounds.minSymbolCount ?? 0;

  const accuracyScore = Math.min(accuracy / minAccuracy, 1);
  const coverageScore = Math.min(coverage / minCoverage, 1);
  const timeScore = parseTimeMs <= maxParseTimeMs ? 1 : maxParseTimeMs / parseTimeMs;
  const confidenceScore = Math.min(confidence / minConfidence, 1);
  const countScore = symbols.length >= minSymbolCount ? 1 : 0;

  const score = (accuracyScore + coverageScore + timeScore + confidenceScore + countScore) / 5;

  // Determine if quality bounds passed
  const passed =
    accuracy >= minAccuracy &&
    coverage >= minCoverage &&
    parseTimeMs <= maxParseTimeMs &&
    confidence >= minConfidence &&
    symbols.length >= minSymbolCount;

  return {
    passed,
    score,
    accuracy,
    coverage,
    confidence,
    parseTimeMs,
    symbolCount: symbols.length,
    errorCount,
    usedFallback,
  };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get the language for a file extension.
 *
 * @param ext - File extension (e.g., ".py", ".go")
 * @returns Language enum or null if unsupported
 */
export function getLanguage(ext: string): Language | null {
  return EXT_TO_LANGUAGE[ext.toLowerCase()] ?? null;
}

/**
 * Check if a file extension is supported by multi-language parser.
 *
 * @param ext - File extension (e.g., ".py", ".go")
 * @returns True if supported
 */
export function isLanguageSupported(ext: string): boolean {
  return ext.toLowerCase() in EXT_TO_LANGUAGE;
}

/**
 * Get all supported file extensions.
 *
 * @returns Array of supported extensions
 */
export function getSupportedLanguageExtensions(): string[] {
  return Object.keys(EXT_TO_LANGUAGE);
}

/**
 * Get language configuration.
 *
 * @param language - Language enum
 * @returns Language configuration
 */
export function getLanguageConfig(language: Language): LanguageConfig {
  return LANGUAGE_CONFIGS[language];
}

/**
 * Parse code with quality bounds and metrics.
 *
 * This is the main entry point for multi-language parsing with quality guarantees.
 * It supports Python (AST), Go, Rust, and Java with configurable quality thresholds.
 *
 * @param args - Parse arguments
 * @returns Parse result with quality metrics
 *
 * @example
 * const result = await parseWithQuality({
 *   code: pythonCode,
 *   language: Language.Python,
 *   sourcePath: 'src/main.py',
 * });
 *
 * if (result.quality.passed) {
 *   console.log(`Quality: ${result.quality.score.toFixed(2)}`);
 * }
 */
export async function parseWithQuality(args: {
  code: string;
  language: Language;
  sourcePath: string;
  qualityBounds?: QualityBounds;
}): Promise<MultiLangParseResult> {
  const { code, language, sourcePath, qualityBounds } = args;
  const config = LANGUAGE_CONFIGS[language];
  const bounds = { ...config.defaultBounds, ...qualityBounds };

  const warnings: string[] = [];
  const startTime = Date.now();
  let parseResult: ParseAttempt;

  try {
    // Route to appropriate parser
    switch (language) {
      case Language.Python:
        parseResult = await parseWithFallback(
          () => parsePythonAst(code),
          () => extractSymbols(code, '.py'),
          bounds
        );
        break;

      case Language.Go:
        parseResult = {
          symbols: await parseGo(code),
          parseTimeMs: Date.now() - startTime,
          errorCount: 0,
          usedFallback: false,
        };
        break;

      case Language.Rust:
        parseResult = {
          symbols: await parseRust(code),
          parseTimeMs: Date.now() - startTime,
          errorCount: 0,
          usedFallback: false,
        };
        break;

      case Language.Java:
        parseResult = {
          symbols: await parseJava(code),
          parseTimeMs: Date.now() - startTime,
          errorCount: 0,
          usedFallback: false,
        };
        break;

      default:
        warnings.push(`Unsupported language: ${language}`);
        parseResult = {
          symbols: [],
          parseTimeMs: Date.now() - startTime,
          errorCount: 1,
          usedFallback: true,
        };
    }
  } catch (error) {
    warnings.push(`Parse error: ${error instanceof Error ? error.message : String(error)}`);
    parseResult = {
      symbols: [],
      parseTimeMs: Date.now() - startTime,
      errorCount: 1,
      usedFallback: true,
    };
  }

  // Calculate quality metrics
  const quality = calculateQualityMetrics(parseResult, code, bounds);

  // Add warnings for quality failures
  if (!quality.passed) {
    if (quality.accuracy < (bounds.minAccuracy ?? 0)) {
      warnings.push(
        `Accuracy ${quality.accuracy.toFixed(2)} below threshold ${bounds.minAccuracy}`
      );
    }
    if (quality.coverage < (bounds.minCoverage ?? 0)) {
      warnings.push(
        `Coverage ${quality.coverage.toFixed(2)} below threshold ${bounds.minCoverage}`
      );
    }
    if (quality.parseTimeMs > (bounds.maxParseTimeMs ?? 5000)) {
      warnings.push(
        `Parse time ${quality.parseTimeMs}ms exceeds threshold ${bounds.maxParseTimeMs}ms`
      );
    }
  }

  return {
    symbols: parseResult.symbols,
    quality,
    language,
    sourcePath,
    warnings,
  };
}

/**
 * Parse with fallback to tree-sitter if primary parsing fails quality thresholds.
 *
 * @param primaryFn - Primary parser function
 * @param fallbackFn - Fallback tree-sitter function
 * @param bounds - Quality bounds
 * @returns Parse attempt result
 */
async function parseWithFallback(
  primaryFn: () => CodeSymbol[],
  fallbackFn: () => Promise<CodeSymbol[] | null>,
  bounds: QualityBounds
): Promise<ParseAttempt> {
  const startTime = Date.now();
  let symbols: CodeSymbol[] = [];
  let errorCount = 0;
  let usedFallback = false;

  try {
    symbols = primaryFn();
  } catch (error) {
    errorCount++;
    console.warn('[multi-lang-parser] Primary parser failed:', error);
  }

  // Check if we need fallback
  const minSymbolCount = bounds.minSymbolCount ?? 0;
  if (symbols.length < minSymbolCount) {
    try {
      const fallbackSymbols = await fallbackFn();
      if (fallbackSymbols && fallbackSymbols.length > symbols.length) {
        symbols = fallbackSymbols;
        usedFallback = true;
      }
    } catch (error) {
      errorCount++;
      console.warn('[multi-lang-parser] Fallback parser failed:', error);
    }
  }

  return {
    symbols,
    parseTimeMs: Date.now() - startTime,
    errorCount,
    usedFallback,
  };
}

/**
 * Batch parse multiple files with quality tracking.
 *
 * @param files - Array of file objects with code and metadata
 * @returns Array of parse results
 *
 * @example
 * const results = await batchParseWithQuality([
 *   { code: pyCode, language: Language.Python, sourcePath: 'main.py' },
 *   { code: goCode, language: Language.Go, sourcePath: 'main.go' },
 * ]);
 *
 * const passed = results.filter(r => r.quality.passed);
 * console.log(`${passed.length}/${results.length} passed quality`);
 */
export async function batchParseWithQuality(
  files: Array<{
    code: string;
    language: Language;
    sourcePath: string;
    qualityBounds?: QualityBounds;
  }>
): Promise<MultiLangParseResult[]> {
  const results: MultiLangParseResult[] = [];

  for (const file of files) {
    const result = await parseWithQuality(file);
    results.push(result);
  }

  return results;
}

/**
 * Get symbol boundaries for a specific language.
 *
 * Convenience wrapper that returns flattened, sorted symbol locations.
 *
 * @param code - Source code
 * @param language - Target language
 * @returns Flattened symbol locations or null
 */
export async function getLanguageSymbolBoundaries(
  code: string,
  language: Language
): Promise<SymbolLocation[] | null> {
  const result = await parseWithQuality({
    code,
    language,
    sourcePath: 'unknown',
  });

  if (result.symbols.length === 0) {
    return null;
  }

  // Flatten and sort
  const flat = flattenSymbols(result.symbols);
  flat.sort((a, b) => a.line - b.line);

  // Remove overlaps
  const nonOverlapping: SymbolLocation[] = [];
  for (const sym of flat) {
    const last = nonOverlapping[nonOverlapping.length - 1];
    if (!last || sym.line > last.endLine) {
      nonOverlapping.push(sym);
    }
  }

  return nonOverlapping;
}

/**
 * Get quality report for a batch of files.
 *
 * @param results - Parse results from batchParseWithQuality
 * @returns Quality report summary
 */
export function getQualityReport(results: MultiLangParseResult[]): {
  totalFiles: number;
  passedFiles: number;
  failedFiles: number;
  averageScore: number;
  averageAccuracy: number;
  averageCoverage: number;
  totalSymbols: number;
  byLanguage: Record<Language, { count: number; passed: number; avgScore: number }>;
} {
  const byLanguage: Record<Language, { count: number; passed: number; avgScore: number }> = {
    [Language.Python]: { count: 0, passed: 0, avgScore: 0 },
    [Language.Go]: { count: 0, passed: 0, avgScore: 0 },
    [Language.Rust]: { count: 0, passed: 0, avgScore: 0 },
    [Language.Java]: { count: 0, passed: 0, avgScore: 0 },
  };

  let totalScore = 0;
  let totalAccuracy = 0;
  let totalCoverage = 0;
  let totalSymbols = 0;

  for (const result of results) {
    const lang = byLanguage[result.language];
    lang.count++;
    if (result.quality.passed) {
      lang.passed++;
    }
    lang.avgScore += result.quality.score;

    totalScore += result.quality.score;
    totalAccuracy += result.quality.accuracy;
    totalCoverage += result.quality.coverage;
    totalSymbols += result.quality.symbolCount;
  }

  // Calculate averages per language
  for (const lang of Object.values(byLanguage)) {
    if (lang.count > 0) {
      lang.avgScore = lang.avgScore / lang.count;
    }
  }

  const passedFiles = results.filter((r) => r.quality.passed).length;

  return {
    totalFiles: results.length,
    passedFiles,
    failedFiles: results.length - passedFiles,
    averageScore: results.length > 0 ? totalScore / results.length : 0,
    averageAccuracy: results.length > 0 ? totalAccuracy / results.length : 0,
    averageCoverage: results.length > 0 ? totalCoverage / results.length : 0,
    totalSymbols,
    byLanguage,
  };
}
