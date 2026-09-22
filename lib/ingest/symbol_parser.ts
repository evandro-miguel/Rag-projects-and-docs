'use node';
/**
 * @module ingest/symbol-parser
 * @description Tree-sitter based symbol extraction for code chunking.
 *
 * Uses web-tree-sitter with WASM grammars to parse code and extract
 * symbol boundaries (functions, classes, methods, etc.) for intelligent
 * chunk splitting.
 *
 * **Supported Languages:**
 * TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, C#, PHP, Swift,
 * Kotlin, Scala, Solidity, Zig, Bash, OCaml, and more.
 *
 * **IMPORTANT:** This module requires Node.js runtime. It will NOT work in
 * non-Node edge/worker environments. Use only from scripts or actions that
 * explicitly require Node.js.
 *
 * @example
 * import { extractSymbols, getGrammarName } from './symbol-parser.js';
 *
 * const symbols = await extractSymbols(code, '.ts');
 * // Returns: [{ name: 'foo', kind: 'function', line: 1, endLine: 10, ... }]
 */

// Note: Node.js APIs are loaded dynamically at runtime to avoid bundling issues
// This module requires a Node.js runtime environment for full functionality

// ============================================================================
// TYPES
// ============================================================================

/**
 * Symbol kinds extracted from code.
 */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'enum'
  | 'interface'
  | 'struct'
  | 'type'
  | 'trait'
  | 'const'
  | 'variable'
  | 'export';

/**
 * Represents a code symbol with its location and metadata.
 */
export interface CodeSymbol {
  /** Symbol name */
  name: string;
  /** Kind of symbol (function, class, etc.) */
  kind: SymbolKind;
  /** Start line (1-indexed) */
  line: number;
  /** End line (1-indexed) */
  endLine: number;
  /** First line of the symbol (signature) */
  signature: string;
  /** Nested symbols (e.g., methods in a class) */
  children: CodeSymbol[];
}

/**
 * Flattened symbol location for chunking.
 */
export interface SymbolLocation {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  signature: string;
  parentName?: string;
}

// Dynamic imports for web-tree-sitter (ESM)
interface Point {
  row: number;
  column: number;
}

interface Node {
  id: number;
  type: string;
  text: string;
  startPosition: Point;
  endPosition: Point;
  namedChildren: (Node | null)[];
  childForFieldName(name: string): Node | null;
}

interface Tree {
  rootNode: Node;
  delete(): void;
}

interface Language {
  name: string | null;
  load(path: string): Promise<Language>;
}

interface ParserClass {
  language: Language | null;
  setLanguage(language: Language | null): void;
  parse(input: string): Tree | null;
  delete(): void;
}

interface ParserModule {
  init(): Promise<void>;
  Language: { load(path: string): Promise<Language> };
  new (): ParserClass;
}

// ============================================================================
// LANGUAGE CONFIGURATION
// ============================================================================

/**
 * File extension to grammar name mapping.
 */
const EXT_TO_GRAMMAR: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'c_sharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.lua': 'lua',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.elm': 'elm',
  '.ml': 'ocaml',
  '.scala': 'scala',
  '.sc': 'scala',
  '.sol': 'solidity',
  '.zig': 'zig',
  '.vue': 'vue',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.toml': 'toml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.html': 'html',
  '.css': 'css',
  '.m': 'objc',
  '.re': 'rescript',
};

/**
 * Tree-sitter node types that represent symbol definitions, by grammar.
 */
const DEFINITION_TYPES: Record<string, Record<string, string>> = {
  typescript: {
    function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    type_alias_declaration: 'type',
    lexical_declaration: 'const',
  },
  javascript: {
    function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    variable_declaration: 'const',
  },
  tsx: {
    function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    type_alias_declaration: 'type',
  },
  python: {
    function_definition: 'function',
    class_definition: 'class',
  },
  rust: {
    function_item: 'function',
    struct_item: 'struct',
    enum_item: 'enum',
    trait_item: 'trait',
    impl_item: 'class',
  },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: 'type',
  },
  java: {
    method_declaration: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
  },
  c: {
    function_definition: 'function',
    struct_specifier: 'struct',
    enum_specifier: 'enum',
  },
  cpp: {
    function_definition: 'function',
    class_specifier: 'class',
    struct_specifier: 'struct',
    enum_specifier: 'enum',
  },
  c_sharp: {
    method_declaration: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    struct_declaration: 'struct',
  },
  ruby: {},
  lua: {},
  dart: {},
  elixir: {},
  php: {
    function_definition: 'function',
    method_declaration: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
  },
  swift: {
    function_declaration: 'function',
    class_declaration: 'class',
    struct_declaration: 'struct',
    enum_declaration: 'enum',
    protocol_declaration: 'interface',
  },
  kotlin: {
    function_declaration: 'function',
    class_declaration: 'class',
    object_declaration: 'class',
    interface_delegation: 'interface',
  },
  scala: {
    function_definition: 'function',
    class_definition: 'class',
    trait_definition: 'trait',
    object_definition: 'class',
  },
  solidity: {
    function_definition: 'function',
    contract_declaration: 'class',
    struct_declaration: 'struct',
    enum_declaration: 'enum',
    event_definition: 'export',
  },
  zig: {
    function_declaration: 'function',
  },
  bash: {
    function_definition: 'function',
  },
  ocaml: {
    let_binding: 'function',
    type_binding: 'type',
  },
};

// ============================================================================
// PARSER INITIALIZATION
// ============================================================================

let ParserModule: ParserModule | null = null;
let parserInitialized = false;
const grammarCache = new Map<string, Language>();

// Lazy-loaded Node.js modules (only used in Node.js runtime)
const nodeFs: typeof import('node:fs/promises') | null = null;
const nodePath: typeof import('node:path') | null = null;
const nodeUrl: typeof import('node:url') | null = null;

/**
 * Get the path to WASM grammar files.
 */
function getGrammarDir(): string {
  // In non-Node runtimes, we won't have access to the filesystem
  // This function is only meaningful in Node.js environments
  if (!nodePath) {
    return '';
  }

  // Try different locations based on runtime
  const possiblePaths = [
    // Standard node_modules location
    nodePath.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out'),
    // Monorepo style
    nodePath.join(process.cwd(), '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'),
  ];

  // In ESM context with import.meta.url
  if (typeof import.meta?.url === 'string' && nodeUrl && nodePath) {
    try {
      const currentDir = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
      possiblePaths.unshift(
        nodePath.join(currentDir, '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'),
        nodePath.join(
          currentDir,
          '..',
          '..',
          '..',
          '..',
          'node_modules',
          'tree-sitter-wasms',
          'out'
        )
      );
    } catch {
      // Ignore if import.meta.url is not available
    }
  }

  // Return first path (will be validated when loading)
  return (
    possiblePaths[0] ?? nodePath.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out')
  );
}

/**
 * Initialize the tree-sitter parser module.
 */
async function initParser(): Promise<ParserModule | null> {
  if (ParserModule && parserInitialized) return ParserModule;

  try {
    // Dynamic import for ESM compatibility
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const mod = await import('web-tree-sitter');
    // The module can be default export or named export
    const Parser = mod as unknown as ParserModule;
    await Parser.init();
    ParserModule = Parser;
    parserInitialized = true;
    return Parser;
  } catch (error) {
    console.warn('[symbol-parser] Failed to initialize tree-sitter:', error);
    return null;
  }
}

/**
 * Load a grammar by name.
 * Caches loaded grammars for reuse.
 */
async function loadGrammar(grammarName: string): Promise<Language | null> {
  if (grammarCache.has(grammarName)) {
    return grammarCache.get(grammarName) ?? null;
  }

  try {
    const parser = await initParser();
    if (!parser) return null;

    // Check if we're in a Node.js environment with filesystem access
    if (!nodePath || !nodeFs) {
      console.warn('[symbol-parser] Node.js filesystem APIs not available in this runtime');
      return null;
    }

    const grammarDir = getGrammarDir();
    const wasmPath = nodePath.join(grammarDir, `tree-sitter-${grammarName}.wasm`);

    // Verify file exists
    await nodeFs.readFile(wasmPath);

    const lang = await parser.Language.load(wasmPath);
    grammarCache.set(grammarName, lang);
    return lang;
  } catch (error) {
    console.warn(`[symbol-parser] Failed to load grammar '${grammarName}':`, error);
    return null;
  }
}

// ============================================================================
// SYMBOL EXTRACTION
// ============================================================================

/**
 * Extract the name from a syntax node.
 */
function extractName(node: Node, _kind: string): string {
  // Try common name field patterns
  const nameNode =
    node.childForFieldName('name') ??
    node.childForFieldName('declarator') ??
    node.namedChildren.find((c): c is Node => {
      if (!c) return false;
      return ['identifier', 'type_identifier', 'property_identifier', 'simple_identifier'].includes(
        c.type
      );
    });

  if (nameNode) {
    // Handle function declarators (C-style languages)
    if (nameNode.type === 'function_declarator' || nameNode.type === 'pointer_declarator') {
      const inner = nameNode.childForFieldName('declarator') ?? nameNode.namedChildren[0];
      if (inner) return inner.text;
    }
    return nameNode.text;
  }

  // Look for variable declarators
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'variable_declarator' || child.type === 'const_declaration') {
      const inner = child.childForFieldName('name');
      if (inner) return inner.text;
    }
  }

  // Fallback: extract from first token
  return node.text.split(/[\s({]/)[0]?.trim() ?? 'anonymous';
}

/**
 * Extract a signature from a syntax node.
 */
function extractSignature(node: Node): string {
  const lines = node.text.split('\n');
  const firstLine = lines[0].trim();
  // Limit signature length for readability
  return firstLine.length > 150 ? `${firstLine.substring(0, 150)}...` : firstLine;
}

/**
 * Map a string kind to SymbolKind type.
 */
function mapKind(typeStr: string): SymbolKind {
  const kinds: Record<string, SymbolKind> = {
    function: 'function',
    method: 'method',
    class: 'class',
    struct: 'struct',
    enum: 'enum',
    interface: 'interface',
    type: 'type',
    trait: 'trait',
    const: 'const',
    variable: 'variable',
    export: 'export',
  };
  return kinds[typeStr] ?? 'function';
}

/**
 * Walk the tree-sitter AST and extract symbols.
 */
function walkTree(rootNode: Node, defTypes: Record<string, string>, maxDepth = 3): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function visit(node: Node, depth: number, parent: CodeSymbol | null): void {
    if (depth > maxDepth) return;

    const kindStr = defTypes[node.type];
    if (kindStr) {
      const sym: CodeSymbol = {
        name: extractName(node, kindStr),
        kind: mapKind(kindStr),
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: extractSignature(node),
        children: [],
      };

      if (parent && depth > 0) {
        parent.children.push(sym);
      } else {
        symbols.push(sym);
      }

      // Recurse into children with this symbol as parent
      for (const child of node.namedChildren) {
        if (child) visit(child, depth + 1, sym);
      }
      return;
    }

    // No match at this node, continue to children
    for (const child of node.namedChildren) {
      if (child) visit(child, depth, parent);
    }
  }

  visit(rootNode, 0, null);
  return symbols;
}

export function getDefinitionTypesForExtension(ext: string): Record<string, string> | null {
  const grammarName = getGrammarName(ext);
  if (!grammarName) {
    return null;
  }

  const defTypes = DEFINITION_TYPES[grammarName];
  if (!defTypes || Object.keys(defTypes).length === 0) {
    return null;
  }

  return defTypes;
}

export function extractSymbolsFromRootNode(rootNode: Node, ext: string): CodeSymbol[] | null {
  const defTypes = getDefinitionTypesForExtension(ext);
  if (!defTypes) {
    return null;
  }

  return walkTree(rootNode, defTypes);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get the grammar name for a file extension.
 *
 * @param ext - File extension (e.g., ".ts", ".py")
 * @returns Grammar name or null if unsupported
 */
export function getGrammarName(ext: string): string | null {
  return EXT_TO_GRAMMAR[ext.toLowerCase()] ?? null;
}

/**
 * Check if a file extension is supported for symbol extraction.
 *
 * @param ext - File extension (e.g., ".ts", ".py")
 * @returns True if the extension has a grammar
 */
export function isExtensionSupported(ext: string): boolean {
  return ext.toLowerCase() in EXT_TO_GRAMMAR;
}

/**
 * Get all supported file extensions.
 *
 * @returns Array of supported extensions
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_GRAMMAR);
}

/**
 * Extract symbols from code using tree-sitter.
 *
 * This is the main entry point for symbol extraction. It:
 * 1. Detects the language from the file extension
 * 2. Loads the appropriate WASM grammar
 * 3. Parses the code and walks the AST
 * 4. Returns symbol locations with line ranges
 *
 * @param code - Source code to analyze
 * @param ext - File extension (e.g., ".ts", ".py")
 * @returns Array of extracted symbols, or null if parsing failed
 *
 * @example
 * const symbols = await extractSymbols(`
 *   function foo() { return 1; }
 *   class Bar { method() {} }
 * `, '.ts');
 * // Returns:
 * // [
 * //   { name: 'foo', kind: 'function', line: 2, endLine: 2, ... },
 * //   { name: 'Bar', kind: 'class', line: 3, endLine: 3, children: [...] }
 * // ]
 */
export async function extractSymbols(code: string, ext: string): Promise<CodeSymbol[] | null> {
  const grammarName = getGrammarName(ext);
  if (!grammarName) return null;

  const defTypes = getDefinitionTypesForExtension(ext);
  if (!defTypes || Object.keys(defTypes).length === 0) return null;

  const lang = await loadGrammar(grammarName);
  if (!lang) return null;

  const parserModule = await initParser();
  if (!parserModule) return null;

  let parser: ParserClass | null = null;
  let tree: Tree | null = null;

  try {
    parser = new parserModule();
    parser.setLanguage(lang);
    tree = parser.parse(code);

    if (!tree) return null;

    return walkTree(tree.rootNode, defTypes);
  } catch (error) {
    console.warn(`[symbol-parser] Parse error for '${grammarName}':`, error);
    return null;
  } finally {
    // Cleanup
    tree?.delete();
    parser?.delete();
  }
}

/**
 * Flatten nested symbols into a flat array with parent names.
 *
 * Useful for creating chunks from a flat list of symbol boundaries.
 *
 * @param symbols - Array of symbols (possibly with nested children)
 * @param parentName - Optional parent name for recursion
 * @returns Flattened array of symbol locations
 *
 * @example
 * const flat = flattenSymbols([
 *   { name: 'Foo', kind: 'class', children: [
 *     { name: 'bar', kind: 'method', ... }
 *   ]}
 * ]);
 * // Returns: [
 * //   { name: 'Foo', kind: 'class', ... },
 * //   { name: 'bar', kind: 'method', parentName: 'Foo', ... }
 * // ]
 */
export function flattenSymbols(symbols: CodeSymbol[], parentName?: string): SymbolLocation[] {
  const out: SymbolLocation[] = [];

  for (const sym of symbols) {
    out.push({
      name: sym.name,
      kind: sym.kind,
      line: sym.line,
      endLine: sym.endLine,
      signature: sym.signature,
      parentName,
    });

    if (sym.children.length > 0) {
      out.push(...flattenSymbols(sym.children, sym.name));
    }
  }

  return out;
}

/**
 * Get symbol boundaries for chunking.
 *
 * Returns non-overlapping symbol boundaries sorted by line number.
 * Useful for determining where to split code into chunks.
 *
 * @param code - Source code to analyze
 * @param ext - File extension
 * @returns Array of symbol boundaries (sorted by line), or null if unsupported
 */
export async function getSymbolBoundaries(
  code: string,
  ext: string
): Promise<SymbolLocation[] | null> {
  const symbols = await extractSymbols(code, ext);
  if (!symbols) return null;

  // Flatten and sort by line number
  const flat = flattenSymbols(symbols);
  flat.sort((a, b) => a.line - b.line);

  // Remove overlapping symbols (keep the outermost)
  const nonOverlapping: SymbolLocation[] = [];
  for (const sym of flat) {
    const last = nonOverlapping[nonOverlapping.length - 1];
    if (!last || sym.line > last.endLine) {
      nonOverlapping.push(sym);
    }
  }

  return nonOverlapping;
}
