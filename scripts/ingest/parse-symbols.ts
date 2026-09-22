import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getLanguage, parseWithQuality } from '../../lib/ingest/multi_lang_parser.js';
import {
  disposeTypeResolver,
  enhanceChunksWithTypes,
} from '../../lib/ingest/tsmorph_integration.js';
import { IncrementalTreeSitterParser, type ParseMetrics } from '../lib/tree-sitter-incremental.js';

export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type';
  startLine: number;
  endLine: number;
  code: string;
  /** Unique identifier from ts-morph (for disambiguation) */
  uniqueId?: string;
  /** Return type string */
  returnType?: string;
  /** Dependencies (imported/referenced types) */
  dependencies?: string[];
}

export interface ParsedEdge {
  sourceRef: string;
  targetRef: string;
  relationType: 'IMPORTS' | 'EXPORTS' | 'CALLS';
  sourceLine?: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// INCREMENTAL PARSING STATE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * AST cache for incremental parsing across sync runs.
 * Maps file paths to their parser state.
 */
const astCache = new Map<
  string,
  {
    parser: IncrementalTreeSitterParser;
    lastContent: string;
    lastModifiedAt: number;
    symbols: ParsedSymbol[];
  }
>();

/**
 * Performance metrics for incremental parsing.
 */
const incrementalMetrics: ParseMetrics[] = [];

/**
 * Get grammar name from extension.
 */
function getGrammarName(ext: string): string | null {
  const grammarMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
  };
  return grammarMap[ext.toLowerCase()] || null;
}

/**
 * Clear the AST cache (call after sync completes).
 */
export function clearAstCache(): void {
  for (const entry of astCache.values()) {
    entry.parser.dispose();
  }
  astCache.clear();

  // Also dispose the type resolver
  disposeTypeResolver();
}

/**
 * Get incremental parsing metrics.
 */
export function getIncrementalMetrics(): ParseMetrics[] {
  return [...incrementalMetrics];
}

/**
 * Get average performance metrics.
 */
export function getAverageIncrementalMetrics(): {
  avgFullParseTimeMs: number;
  avgIncrementalParseTimeMs: number;
  avgSpeedupFactor: number;
  totalParses: number;
  incrementalRatio: number;
} {
  if (incrementalMetrics.length === 0) {
    return {
      avgFullParseTimeMs: 0,
      avgIncrementalParseTimeMs: 0,
      avgSpeedupFactor: 1,
      totalParses: 0,
      incrementalRatio: 0,
    };
  }

  const fullParses = incrementalMetrics.filter(
    (m) => m.fullParseTimeMs > 0 && m.incrementalParseTimeMs === 0
  );
  const incrementalParses = incrementalMetrics.filter((m) => m.incrementalParseTimeMs > 0);

  const avgFullParseTimeMs =
    fullParses.length > 0
      ? fullParses.reduce((sum, m) => sum + m.fullParseTimeMs, 0) / fullParses.length
      : 0;

  const avgIncrementalParseTimeMs =
    incrementalParses.length > 0
      ? incrementalParses.reduce((sum, m) => sum + m.incrementalParseTimeMs, 0) /
        incrementalParses.length
      : 0;

  const avgSpeedupFactor =
    incrementalParses.length > 0
      ? incrementalParses.reduce((sum, m) => sum + m.speedupFactor, 0) / incrementalParses.length
      : 1;

  return {
    avgFullParseTimeMs,
    avgIncrementalParseTimeMs,
    avgSpeedupFactor,
    totalParses: incrementalMetrics.length,
    incrementalRatio: incrementalParses.length / incrementalMetrics.length,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SYMBOL EXTRACTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Parse symbols from code using regex-based extraction.
 * This is the fallback method when tree-sitter is not available.
 */
export function parseSymbols(code: string, ext: string): ParsedSymbol[] {
  if (!ext.match(/\.(ts|tsx|js|jsx)$/)) {
    return [];
  }

  const symbols: ParsedSymbol[] = [];
  const lines = code.split('\n');

  // Simple regex-based symbol extraction for fallback
  const patterns = [
    { regex: /^(export\s+)?(async\s+)?function\s+(\w+)/, kind: 'function' as const },
    { regex: /^(export\s+)?class\s+(\w+)/, kind: 'class' as const },
    { regex: /^(export\s+)?interface\s+(\w+)/, kind: 'interface' as const },
    { regex: /^(export\s+)?type\s+(\w+)\s*=/, kind: 'type' as const },
    { regex: /^(export\s+)?enum\s+(\w+)/, kind: 'type' as const },
    { regex: /^(export\s+)?const\s+(\w+)\s*[:=]/, kind: 'function' as const },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match) {
        const name = match[match.length - 1];
        // Find the end of this symbol
        let endLine = i + 1;
        let braceCount = 0;
        let inString = false;
        let stringChar = '';

        for (let j = i; j < lines.length; j++) {
          const checkLine = lines[j];
          for (let k = 0; k < checkLine.length; k++) {
            const char = checkLine[k];
            const prevChar = k > 0 ? checkLine[k - 1] : '';

            // Handle strings
            if (!inString && (char === '"' || char === "'" || char === '`')) {
              inString = true;
              stringChar = char;
            } else if (inString && char === stringChar && prevChar !== '\\') {
              inString = false;
            }

            if (!inString) {
              if (char === '{' || char === '(') braceCount++;
              if (char === '}' || char === ')') braceCount--;
            }
          }

          if (j > i && braceCount === 0 && checkLine.trim().endsWith('}')) {
            endLine = j + 1;
            break;
          }
        }

        const symbolCode = lines.slice(i, endLine).join('\n');
        symbols.push({
          name,
          kind: pattern.kind,
          startLine: i + 1,
          endLine,
          code: symbolCode,
        });
        break;
      }
    }
  }

  return symbols.sort((a, b) => a.startLine - b.startLine);
}

/**
 * Parse symbols incrementally using tree-sitter.
 * Returns symbols and performance metrics.
 */
export async function parseSymbolsIncremental(
  filePath: string,
  content: string,
  ext: string
): Promise<{ symbols: ParsedSymbol[]; metrics: ParseMetrics | null; isIncremental: boolean }> {
  const grammarName = getGrammarName(ext);
  if (!grammarName) {
    return { symbols: parseSymbols(content, ext), metrics: null, isIncremental: false };
  }

  // Check if we have cached parser for this file
  const cached = astCache.get(filePath);

  if (cached) {
    // Check if content changed significantly
    const changes = cached.parser.detectChanges(cached.lastContent, content);

    if (changes.hasChanged && changes.changePercent < 30) {
      // Small change - use incremental parse
      const tree = await cached.parser.parse(filePath, content);
      const metrics = cached.parser.getMetrics().pop() || null;

      if (tree) {
        // Extract symbols from content (tree-sitter tree available if needed)
        const symbols = parseSymbols(content, ext);
        cached.lastContent = content;
        cached.lastModifiedAt = Date.now();
        cached.symbols = symbols;

        if (metrics) {
          incrementalMetrics.push(metrics);
        }

        return { symbols, metrics, isIncremental: true };
      }
    }
  }

  // Full parse - create new parser
  const parser = new IncrementalTreeSitterParser();
  const initialized = await parser.initialize(grammarName);

  if (!initialized) {
    // Fallback to regex-based parsing
    return { symbols: parseSymbols(content, ext), metrics: null, isIncremental: false };
  }

  const _tree = await parser.parse(filePath, content);
  const metrics = parser.getMetrics().pop() || null;

  // Extract symbols from content
  const symbols = parseSymbols(content, ext);

  // Cache the parser for this file
  astCache.set(filePath, {
    parser,
    lastContent: content,
    lastModifiedAt: Date.now(),
    symbols,
  });

  if (metrics) {
    incrementalMetrics.push(metrics);
  }

  return { symbols, metrics, isIncremental: false };
}

// ═════════════════════════════════════════════════════════════════════════════
// MULTI-LANGUAGE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Map multi-language symbol kind to ParsedSymbol kind.
 */
function mapMultiLangKind(kind: string): ParsedSymbol['kind'] {
  const kindMap: Record<string, ParsedSymbol['kind']> = {
    function: 'function',
    method: 'method',
    class: 'class',
    interface: 'interface',
    type: 'type',
    struct: 'class',
    trait: 'interface',
    enum: 'type',
    const: 'function',
    variable: 'function',
    impl: 'class',
  };
  return kindMap[kind] || 'function';
}

/**
 * Extract code block from source using line numbers.
 */
function extractCodeBlock(code: string, startLine: number, endLine: number): string {
  const lines = code.split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// CHUNKING
// ═════════════════════════════════════════════════════════════════════════════

export async function chunkAST(
  code: string,
  ext: string,
  chunkSize = 500,
  chunkOverlap = 50,
  filePath?: string,
  projectRoot?: string
): Promise<{ content: string; symbol?: ParsedSymbol }[]> {
  let symbols: ParsedSymbol[];
  let isIncremental = false;
  let parseMetrics: ParseMetrics | null = null;

  // ═════════════════════════════════════════════════════════════════════════════
  // P2-03: Multi-language support (Python, Go, Rust, Java)
  // ═════════════════════════════════════════════════════════════════════════════
  const multiLang = getLanguage(ext);
  if (multiLang) {
    // Use multi-language parser for Python, Go, Rust, Java
    const result = await parseWithQuality({
      code,
      language: multiLang,
      sourcePath: filePath || 'unknown',
    });

    if (result.quality.passed || result.symbols.length > 0) {
      console.log(
        `[${filePath || 'unknown'}] Multi-lang parse (${multiLang}): ${result.symbols.length} symbols, ` +
          `quality: ${result.quality.score.toFixed(2)}`
      );

      // Convert CodeSymbol to ParsedSymbol
      symbols = result.symbols.map((sym) => ({
        name: sym.name,
        kind: mapMultiLangKind(sym.kind),
        startLine: sym.line,
        endLine: sym.endLine,
        code: extractCodeBlock(code, sym.line, sym.endLine),
      }));

      // Flatten nested symbols (children) into the main list
      const flattenSymbols = (
        s: (typeof result.symbols)[0][],
        _parentStart?: number,
        _parentEnd?: number
      ): ParsedSymbol[] => {
        const flat: ParsedSymbol[] = [];
        for (const sym of s) {
          flat.push({
            name: sym.name,
            kind: mapMultiLangKind(sym.kind),
            startLine: sym.line,
            endLine: sym.endLine,
            code: extractCodeBlock(code, sym.line, sym.endLine),
          });
          if (sym.children && sym.children.length > 0) {
            flat.push(...flattenSymbols(sym.children, sym.line, sym.endLine));
          }
        }
        return flat;
      };

      // Add children symbols
      for (const sym of result.symbols) {
        if (sym.children && sym.children.length > 0) {
          symbols.push(...flattenSymbols(sym.children));
        }
      }

      // Remove duplicates and sort
      const uniqueSymbols = new Map<string, ParsedSymbol>();
      for (const sym of symbols) {
        const key = `${sym.name}:${sym.startLine}`;
        if (!uniqueSymbols.has(key)) {
          uniqueSymbols.set(key, sym);
        }
      }
      symbols = Array.from(uniqueSymbols.values()).sort((a, b) => a.startLine - b.startLine);
    } else {
      symbols = [];
    }
  } else if (filePath) {
    // Use incremental parsing if filePath is provided (TypeScript/JavaScript)
    const result = await parseSymbolsIncremental(filePath, code, ext);
    symbols = result.symbols;
    isIncremental = result.isIncremental;
    parseMetrics = result.metrics;

    if (parseMetrics) {
      console.log(
        `[${filePath}] Parsed ${isIncremental ? 'incrementally' : 'fully'} ` +
          `(${isIncremental && parseMetrics.speedupFactor > 1 ? `${parseMetrics.speedupFactor.toFixed(1)}x faster` : 'full parse'})`
      );
    }
  } else {
    symbols = parseSymbols(code, ext);
  }

  if (symbols.length === 0) {
    // Fallback block chunking
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      separators: ['\n\n', '\n', ' '],
    });
    const docs = await splitter.createDocuments([code]);
    return docs.map((d) => ({ content: d.pageContent, symbol: undefined }));
  }

  const chunks: { content: string; symbol?: ParsedSymbol }[] = [];
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });

  // Add all symbols as their own standalone chunks
  for (const symbol of symbols) {
    if (symbol.code.length <= chunkSize + 100) {
      // Allow a bit of flex for AST units
      chunks.push({ content: symbol.code, symbol });
    } else {
      const parts = await splitter.createDocuments([symbol.code]);
      parts.forEach((p) => {
        chunks.push({ content: p.pageContent, symbol });
      });
    }
  }

  // Deduplicate chunks
  const uniqueContents = new Set<string>();
  const finalChunks: typeof chunks = [];
  for (const c of chunks) {
    if (!uniqueContents.has(c.content)) {
      uniqueContents.add(c.content);
      finalChunks.push(c);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // P1-09: Type Resolution with ts-morph
  // ═════════════════════════════════════════════════════════════════════════════
  // Enhance TypeScript/JavaScript chunks with type information
  if (projectRoot && filePath && ext.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/)) {
    try {
      const enhancedResult = await enhanceChunksWithTypes(filePath, code, projectRoot, finalChunks);

      // Log type resolution stats
      if (enhancedResult.typeInfo.symbolsResolved > 0) {
        console.log(
          `[${filePath}] Type resolution: ${enhancedResult.typeInfo.symbolsResolved} symbols, ` +
            `${enhancedResult.typeInfo.referencesFound} cross-file refs`
        );
      }

      // Map enhanced chunks back to ParsedSymbol format
      return enhancedResult.chunks.map((chunk) => ({
        content: chunk.content,
        symbol: chunk.symbol
          ? {
              name: chunk.symbol.name,
              kind: chunk.symbol.kind as ParsedSymbol['kind'],
              startLine: chunk.symbol.startLine,
              endLine: chunk.symbol.endLine,
              code: chunk.symbol.code,
              uniqueId: chunk.symbol.uniqueId,
              returnType: chunk.symbol.returnType,
              dependencies: chunk.symbol.dependencies,
            }
          : undefined,
      }));
    } catch (error) {
      console.warn(`[${filePath}] Type enhancement failed:`, error);
      // Fall back to non-enhanced chunks
    }
  }

  return finalChunks;
}

// ═════════════════════════════════════════════════════════════════════════════
// EDGE EXTRACTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract edges (imports, exports, calls) from TypeScript/JavaScript code.
 *
 * This function analyzes import/export statements to build a dependency graph
 * for the project. It extracts:
 * - IMPORTS: Files/modules that this file imports from
 * - EXPORTS: Symbols exported from this file
 *
 * @param content - File content to analyze
 * @param filePath - Source file path for the edges
 * @returns Array of parsed edges
 */
export function extractEdges(content: string, filePath: string): ParsedEdge[] {
  const edges: ParsedEdge[] = [];

  // Extract import statements
  // Matches: import { ... } from 'module', import * as name from 'module', import name from 'module'
  const importRegex = /import\s+(?:\*\s+as\s+\w+|[\w\s,{}]+?)\s+from\s+['"]([^'"]+)['"];?/g;
  let importMatch: RegExpExecArray | null = importRegex.exec(content);
  while (importMatch !== null) {
    const targetRef = importMatch[1];
    if (targetRef) {
      edges.push({
        sourceRef: filePath,
        targetRef,
        relationType: 'IMPORTS',
        sourceLine: content.substring(0, importMatch.index).split('\n').length,
      });
    }
    importMatch = importRegex.exec(content);
  }

  // Extract export statements (named exports)
  // Matches: export { ... }, export const ..., export function ..., export class ..., export interface ...
  const exportNamedRegex =
    /export\s+(?:\{|(?:const|let|var|function|class|interface|type|enum)\s+)(\w+)/g;
  let exportMatch: RegExpExecArray | null = exportNamedRegex.exec(content);
  while (exportMatch !== null) {
    const symbolName = exportMatch[1];
    if (symbolName) {
      edges.push({
        sourceRef: filePath,
        targetRef: symbolName,
        relationType: 'EXPORTS',
        sourceLine: content.substring(0, exportMatch.index).split('\n').length,
      });
    }
    exportMatch = exportNamedRegex.exec(content);
  }

  // Extract default exports
  // Matches: export default ..., export { ... as default }
  const exportDefaultRegex = /export\s+default\s+(?:class|function|interface)?\s*(\w+)?/g;
  let defaultMatch: RegExpExecArray | null = exportDefaultRegex.exec(content);
  while (defaultMatch !== null) {
    const symbolName = defaultMatch[1] || 'default';
    edges.push({
      sourceRef: filePath,
      targetRef: symbolName,
      relationType: 'EXPORTS',
      sourceLine: content.substring(0, defaultMatch.index).split('\n').length,
    });
    defaultMatch = exportDefaultRegex.exec(content);
  }

  return edges;
}
