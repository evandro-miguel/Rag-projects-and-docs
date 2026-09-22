/**
 * @module ingest/tsmorph_resolver
 * @description TypeScript type-aware symbol resolution using ts-morph.
 *
 * This module provides type-aware symbol disambiguation for Project RAG by:
 * 1. Parsing TypeScript/JavaScript files using ts-morph
 * 2. Resolving type references across files
 * 3. Disambiguating symbols with same name in different namespaces
 * 4. Building a type graph for improved exactSymbolRate (+15-20% target)
 *
 * **Features:**
 * - Full TypeScript AST traversal
 * - Type resolution for imports, exports, and cross-file references
 * - Namespace-aware symbol disambiguation
 * - Integration with existing AST chunking pipeline
 *
 * @example
 * // Resolve types for a single file
 * const resolver = new TSMorphResolver(projectRoot);
 * await resolver.initialize();
 * const typeInfo = await resolver.resolveFileTypes('/path/to/file.ts');
 *
 * @example
 * // Resolve cross-file type references
 * const references = await resolver.findTypeReferences('UserService');
 *
 * @see https://ts-morph.com/ - ts-morph documentation
 */

'use node';

import {
  type ClassDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type Type,
  type TypeAliasDeclaration,
} from 'ts-morph';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Resolved type information for a symbol.
 */
export interface ResolvedType {
  /** Symbol name */
  name: string;
  /** Fully qualified name including namespace/module path */
  fullyQualifiedName: string;
  /** Symbol kind */
  kind: TypeSymbolKind;
  /** File path where symbol is defined */
  sourceFile: string;
  /** Line number of definition */
  line: number;
  /** Resolved type string representation */
  typeString: string;
  /** Is this a built-in type */
  isBuiltIn: boolean;
  /** Is this an external library type */
  isExternal: boolean;
  /** Namespace/module path if applicable */
  namespace?: string;
}

/**
 * Type-aware symbol with resolved references.
 */
export interface TypeAwareSymbol {
  /** Symbol name */
  name: string;
  /** Symbol kind */
  kind: TypeSymbolKind;
  /** Source file path */
  sourceFile: string;
  /** Start line */
  startLine: number;
  /** End line */
  endLine: number;
  /** Signature if available */
  signature?: string;
  /** Resolved return type for functions/methods */
  returnType?: ResolvedType;
  /** Parameter types */
  parameterTypes?: ResolvedType[];
  /** Property types for classes/interfaces */
  propertyTypes?: Record<string, ResolvedType>;
  /** Types this symbol depends on */
  dependencies: ResolvedType[];
  /** Unique identifier for disambiguation */
  uniqueId: string;
}

/**
 * Cross-file type reference.
 */
export interface TypeReference {
  /** Source symbol */
  sourceSymbol: string;
  /** Source file */
  sourceFile: string;
  /** Target symbol being referenced */
  targetSymbol: string;
  /** Target file where symbol is defined */
  targetFile: string;
  /** Line where reference occurs */
  line: number;
  /** Type of reference (import, type usage, implementation) */
  referenceType: 'IMPORT' | 'TYPE_USAGE' | 'IMPLEMENTATION' | 'INHERITANCE';
}

/**
 * Symbol kinds supported by the resolver.
 */
export type TypeSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'method'
  | 'property'
  | 'parameter'
  | 'variable'
  | 'import'
  | 'export';

/**
 * Type resolution result for a file.
 */
export interface TypeResolutionResult {
  /** File path */
  filePath: string;
  /** Symbols found in file */
  symbols: TypeAwareSymbol[];
  /** Cross-file type references */
  references: TypeReference[];
  /** Resolution errors if any */
  errors?: string[];
}

/**
 * Namespace disambiguation info.
 */
export interface NamespaceInfo {
  /** Namespace/module name */
  name: string;
  /** Full path */
  path: string;
  /** Exported symbols */
  exports: string[];
  /** Parent namespace if nested */
  parent?: string;
}

// ============================================================================
// RESOLVER CLASS
// ============================================================================

/**
 * TypeScript type-aware symbol resolver using ts-morph.
 *
 * This class provides comprehensive type resolution capabilities for
 * Project RAG ingestion, enabling:
 * - Accurate symbol disambiguation through type information
 * - Cross-file reference tracking
 * - Namespace-aware symbol resolution
 */
export class TSMorphResolver {
  private project: Project | null = null;
  private projectRoot: string;
  private isInitialized = false;
  private cachedSymbols: Map<string, TypeAwareSymbol[]> = new Map();
  private cachedReferences: Map<string, TypeReference[]> = new Map();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Initialize the ts-morph project.
   *
   * Loads tsconfig.json if available, or creates an in-memory
   * project configuration for type resolution.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Try to find and use existing tsconfig.json
      const { stat } = await import('node:fs/promises');
      const path = await import('node:path');

      const tsConfigPath = path.join(this.projectRoot, 'tsconfig.json');
      let useTsConfig = false;

      try {
        await stat(tsConfigPath);
        useTsConfig = true;
      } catch {
        // No tsconfig.json found
      }

      if (useTsConfig) {
        this.project = new Project({
          tsConfigFilePath: tsConfigPath,
          skipAddingFilesFromTsConfig: true,
        });
      } else {
        // Create in-memory project with sensible defaults
        this.project = new Project({
          compilerOptions: {
            target: 2, // ES2020
            module: 1, // CommonJS
            esModuleInterop: true,
            strict: true,
            skipLibCheck: true,
            declaration: true,
            allowJs: true,
            checkJs: false,
          },
        });
      }

      this.isInitialized = true;
      console.warn(`[TSMorph] Initialized resolver for ${this.projectRoot}`);
    } catch (error) {
      console.error('[TSMorph] Failed to initialize:', error);
      throw error;
    }
  }

  isReady(): boolean {
    return this.isInitialized && this.project !== null;
  }

  /**
   * Dispose resources and cleanup.
   */
  dispose(): void {
    if (this.project) {
      // Release memory by clearing source files
      for (const sf of this.project.getSourceFiles()) {
        sf.forget();
      }
      this.project = null;
    }
    this.isInitialized = false;
    this.cachedSymbols.clear();
    this.cachedReferences.clear();
  }

  /**
   * Add a source file to the project.
   *
   * @param filePath - Absolute path to the file
   * @param content - File content
   * @returns SourceFile instance
   */
  addSourceFile(filePath: string, content: string): SourceFile {
    if (!this.project) {
      throw new Error('TSMorphResolver not initialized. Call initialize() first.');
    }

    // Check if file already exists in project
    const existing = this.project.getSourceFile(filePath);
    if (existing) {
      existing.replaceWithText(content);
      return existing;
    }

    return this.project.createSourceFile(filePath, content, { overwrite: true });
  }

  /**
   * Resolve types for a source file.
   *
   * Analyzes all symbols in the file and resolves their types,
   * including cross-file references.
   *
   * @param filePath - Path to the file to analyze
   * @param content - Optional file content (will read from disk if not provided)
   * @returns Type resolution result
   */
  async resolveFileTypes(filePath: string, content?: string): Promise<TypeResolutionResult> {
    if (!this.project) {
      throw new Error('TSMorphResolver not initialized. Call initialize() first.');
    }

    try {
      let sourceFile: SourceFile;

      if (content !== undefined) {
        sourceFile = this.addSourceFile(filePath, content);
      } else {
        // Try to get from project or read from disk
        const existing = this.project.getSourceFile(filePath);
        if (existing) {
          // Only refresh if file exists on disk
          try {
            await import('node:fs/promises').then((fs) => fs.access(filePath));
            existing.refreshFromFileSystemSync();
          } catch {
            // File doesn't exist on disk, use in-memory version
          }
          sourceFile = existing;
        } else {
          const fs = await import('node:fs/promises');
          const fileContent = await fs.readFile(filePath, 'utf-8');
          sourceFile = this.addSourceFile(filePath, fileContent);
        }
      }

      const symbols: TypeAwareSymbol[] = [];
      const references: TypeReference[] = [];
      const errors: string[] = [];

      // Extract functions
      for (const func of sourceFile.getFunctions()) {
        try {
          const symbol = this.extractFunctionSymbol(func, filePath);
          symbols.push(symbol);
        } catch (err) {
          errors.push(`Error extracting function: ${err}`);
        }
      }

      // Extract classes
      for (const cls of sourceFile.getClasses()) {
        try {
          const symbol = this.extractClassSymbol(cls, filePath);
          symbols.push(symbol);
        } catch (err) {
          errors.push(`Error extracting class: ${err}`);
        }
      }

      // Extract interfaces
      for (const iface of sourceFile.getInterfaces()) {
        try {
          const symbol = this.extractInterfaceSymbol(iface, filePath);
          symbols.push(symbol);
        } catch (err) {
          errors.push(`Error extracting interface: ${err}`);
        }
      }

      // Extract type aliases
      for (const typeAlias of sourceFile.getTypeAliases()) {
        try {
          const symbol = this.extractTypeAliasSymbol(typeAlias, filePath);
          symbols.push(symbol);
        } catch (err) {
          errors.push(`Error extracting type alias: ${err}`);
        }
      }

      // Extract imports and references
      const importRefs = this.extractImports(sourceFile, filePath);
      references.push(...importRefs);

      // Build cross-file references
      const crossRefs = this.buildCrossFileReferences(sourceFile, symbols, filePath);
      references.push(...crossRefs);

      const result: TypeResolutionResult = {
        filePath,
        symbols,
        references,
      };

      if (errors.length > 0) {
        result.errors = errors;
      }

      // Cache results
      this.cachedSymbols.set(filePath, symbols);
      this.cachedReferences.set(filePath, references);

      return result;
    } catch (error) {
      console.error(`[TSMorph] Error resolving types for ${filePath}:`, error);
      return {
        filePath,
        symbols: [],
        references: [],
        errors: [String(error)],
      };
    }
  }

  /**
   * Find all references to a symbol across the project.
   *
   * @param symbolName - Name of the symbol to find
   * @returns Array of type references
   */
  async findTypeReferences(symbolName: string): Promise<TypeReference[]> {
    const allReferences: TypeReference[] = [];

    for (const refs of this.cachedReferences.values()) {
      for (const ref of refs) {
        if (ref.targetSymbol === symbolName || ref.sourceSymbol === symbolName) {
          allReferences.push(ref);
        }
      }
    }

    return allReferences;
  }

  /**
   * Disambiguate symbols with the same name.
   *
   * When multiple symbols have the same name (e.g., `User` in different
   * namespaces), this returns the unique variants with their fully
   * qualified names.
   *
   * @param symbolName - Name to disambiguate
   * @returns Array of type-aware symbols with unique IDs
   */
  disambiguateSymbol(symbolName: string): TypeAwareSymbol[] {
    const matches: TypeAwareSymbol[] = [];

    for (const symbols of this.cachedSymbols.values()) {
      for (const symbol of symbols) {
        if (symbol.name === symbolName) {
          matches.push(symbol);
        }
      }
    }

    // Sort by specificity (more dependencies = more specific)
    return matches.sort((a, b) => b.dependencies.length - a.dependencies.length);
  }

  /**
   * Get namespace information for a file.
   *
   * @param filePath - Path to analyze
   * @returns Namespace info or null
   */
  getNamespaceInfo(filePath: string): NamespaceInfo | null {
    const symbols = this.cachedSymbols.get(filePath);
    if (!symbols || symbols.length === 0) return null;

    const firstSymbol = symbols[0];
    const namespace = firstSymbol.uniqueId.split('#')[0];

    return {
      name: namespace || 'global',
      path: filePath,
      exports: symbols.map((s) => s.name),
    };
  }

  /**
   * Get unique identifier for a symbol.
   *
   * Combines namespace, file path, and symbol name for unique identification.
   */
  private getSymbolUniqueId(
    name: string,
    filePath: string,
    kind: TypeSymbolKind,
    namespace?: string
  ): string {
    const relativePath = filePath.replace(this.projectRoot, '').replace(/^\//, '');
    const ns = namespace || relativePath.split('/').slice(0, -1).join('/') || 'global';
    return `${ns}#${kind}#${name}@${relativePath}`;
  }

  /**
   * Extract function symbol with type information.
   */
  private extractFunctionSymbol(func: FunctionDeclaration, filePath: string): TypeAwareSymbol {
    const name = func.getName() || 'anonymous';
    const startLine = func.getStartLineNumber();
    const endLine = func.getEndLineNumber();

    // Get signature
    const signature = func.getText().split('\n')[0];

    // Resolve return type
    const returnType = func.getReturnType();
    const resolvedReturnType = this.resolveType(returnType, filePath);

    // Resolve parameter types
    const parameterTypes: ResolvedType[] = [];
    for (const param of func.getParameters()) {
      const paramType = param.getType();
      parameterTypes.push(this.resolveType(paramType, filePath, param.getName()));
    }

    // Find dependencies
    const dependencies = this.extractDependencies(func);

    return {
      name,
      kind: 'function',
      sourceFile: filePath,
      startLine,
      endLine,
      signature,
      returnType: resolvedReturnType,
      parameterTypes,
      dependencies,
      uniqueId: this.getSymbolUniqueId(name, filePath, 'function'),
    };
  }

  /**
   * Extract class symbol with type information.
   */
  private extractClassSymbol(cls: ClassDeclaration, filePath: string): TypeAwareSymbol {
    const name = cls.getName() || 'anonymous';
    const startLine = cls.getStartLineNumber();
    const endLine = cls.getEndLineNumber();

    // Get signature (class declaration line)
    const signature = cls.getText().split('\n')[0];

    // Extract property types
    const propertyTypes: Record<string, ResolvedType> = {};
    for (const prop of cls.getProperties()) {
      const propName = prop.getName();
      const propType = prop.getType();
      propertyTypes[propName] = this.resolveType(propType, filePath, propName);
    }

    // Extract method signatures
    for (const method of cls.getMethods()) {
      const methodName = method.getName();
      const methodType = method.getType();
      propertyTypes[methodName] = this.resolveType(methodType, filePath, methodName);
    }

    // Find dependencies (extends, implements)
    const dependencies = this.extractDependencies(cls);

    return {
      name,
      kind: 'class',
      sourceFile: filePath,
      startLine,
      endLine,
      signature,
      propertyTypes,
      dependencies,
      uniqueId: this.getSymbolUniqueId(name, filePath, 'class'),
    };
  }

  /**
   * Extract interface symbol with type information.
   */
  private extractInterfaceSymbol(iface: InterfaceDeclaration, filePath: string): TypeAwareSymbol {
    const name = iface.getName();
    const startLine = iface.getStartLineNumber();
    const endLine = iface.getEndLineNumber();

    // Get signature
    const signature = iface.getText().split('\n')[0];

    // Extract property types
    const propertyTypes: Record<string, ResolvedType> = {};
    for (const member of iface.getMembers()) {
      if (member.getKind() === SyntaxKind.PropertySignature) {
        const propName = member.getText().split(':')[0].trim();
        const propType = member.getType ? member.getType() : null;
        if (propType) {
          propertyTypes[propName] = this.resolveType(propType, filePath, propName);
        }
      }
    }

    // Find dependencies (extends)
    const dependencies = this.extractDependencies(iface);

    return {
      name,
      kind: 'interface',
      sourceFile: filePath,
      startLine,
      endLine,
      signature,
      propertyTypes,
      dependencies,
      uniqueId: this.getSymbolUniqueId(name, filePath, 'interface'),
    };
  }

  /**
   * Extract type alias symbol.
   */
  private extractTypeAliasSymbol(
    typeAlias: TypeAliasDeclaration,
    filePath: string
  ): TypeAwareSymbol {
    const name = typeAlias.getName();
    const startLine = typeAlias.getStartLineNumber();
    const endLine = typeAlias.getEndLineNumber();

    // Get signature
    const signature = typeAlias.getText().split('\n')[0];

    // Resolve the aliased type
    const aliasedType = typeAlias.getType();
    const resolvedType = this.resolveType(aliasedType, filePath);

    // Find dependencies
    const dependencies = this.extractDependencies(typeAlias);

    return {
      name,
      kind: 'type',
      sourceFile: filePath,
      startLine,
      endLine,
      signature,
      dependencies: [...dependencies, resolvedType],
      uniqueId: this.getSymbolUniqueId(name, filePath, 'type'),
    };
  }

  /**
   * Resolve a TypeScript type to our ResolvedType format.
   */
  private resolveType(type: Type, sourceFile: string, name?: string): ResolvedType {
    const typeString = type.getText();
    const symbol = type.getSymbol();

    let fullyQualifiedName = name || typeString;
    let isBuiltIn = false;
    let isExternal = false;
    let targetFile = sourceFile;
    let line = 0;

    if (symbol) {
      fullyQualifiedName = symbol.getFullyQualifiedName();

      // Check if built-in
      isBuiltIn = this.isBuiltInType(typeString);

      // Try to get definition location
      const declarations = symbol.getDeclarations();
      if (declarations.length > 0) {
        const firstDecl = declarations[0];
        const declSourceFile = firstDecl.getSourceFile();
        if (declSourceFile) {
          targetFile = declSourceFile.getFilePath();
          line = firstDecl.getStartLineNumber();
          isExternal = !targetFile.startsWith(this.projectRoot);
        }
      }
    } else {
      isBuiltIn = this.isBuiltInType(typeString);
    }

    return {
      name: name || typeString,
      fullyQualifiedName,
      kind: this.inferSymbolKind(type),
      sourceFile: targetFile,
      line,
      typeString,
      isBuiltIn,
      isExternal,
    };
  }

  /**
   * Check if a type is a built-in TypeScript type.
   */
  private isBuiltInType(typeString: string): boolean {
    const builtInTypes = new Set([
      'string',
      'number',
      'boolean',
      'undefined',
      'null',
      'any',
      'unknown',
      'never',
      'void',
      'object',
      'symbol',
      'bigint',
      'Array',
      'Promise',
      'Map',
      'Set',
      'Record',
      'Partial',
      'Required',
      'Readonly',
      'Pick',
      'Omit',
      'Exclude',
      'Extract',
      'NonNullable',
      'Parameters',
      'ReturnType',
      'InstanceType',
      'ThisParameterType',
      'OmitThisParameter',
      'ThisType',
    ]);

    // Handle generic types like Array<T>
    const baseType = typeString.split('<')[0].trim();
    return builtInTypes.has(baseType) || typeString.startsWith('typeof ');
  }

  /**
   * Infer symbol kind from TypeScript type.
   */
  private inferSymbolKind(type: Type): TypeSymbolKind {
    if (type.isClass()) return 'class';
    if (type.isInterface()) return 'interface';
    if (type.isEnum()) return 'enum';
    if (type.isArray()) return 'variable';
    return 'type';
  }

  /**
   * Extract type dependencies from a node.
   */
  private extractDependencies(node: Node): ResolvedType[] {
    const dependencies: ResolvedType[] = [];
    const seen = new Set<string>();

    node.forEachDescendant((descendant) => {
      if (descendant.getKind() === SyntaxKind.TypeReference) {
        const type = descendant.getType();
        if (type) {
          const resolved = this.resolveType(type, node.getSourceFile().getFilePath());
          const key = `${resolved.sourceFile}#${resolved.fullyQualifiedName}`;
          if (!seen.has(key)) {
            seen.add(key);
            dependencies.push(resolved);
          }
        }
      }
    });

    return dependencies;
  }

  /**
   * Extract import declarations as type references.
   */
  private extractImports(sourceFile: SourceFile, filePath: string): TypeReference[] {
    const references: TypeReference[] = [];

    for (const importDecl of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      const line = importDecl.getStartLineNumber();

      // Named imports
      for (const namedImport of importDecl.getNamedImports()) {
        const name = namedImport.getName();
        references.push({
          sourceSymbol: name,
          sourceFile: filePath,
          targetSymbol: name,
          targetFile: moduleSpecifier,
          line,
          referenceType: 'IMPORT',
        });
      }

      // Default import
      const defaultImport = importDecl.getDefaultImport();
      if (defaultImport) {
        const name = defaultImport.getText();
        references.push({
          sourceSymbol: name,
          sourceFile: filePath,
          targetSymbol: 'default',
          targetFile: moduleSpecifier,
          line,
          referenceType: 'IMPORT',
        });
      }

      // Namespace import
      const namespaceImport = importDecl.getNamespaceImport();
      if (namespaceImport) {
        const name = namespaceImport.getText();
        references.push({
          sourceSymbol: name,
          sourceFile: filePath,
          targetSymbol: '*',
          targetFile: moduleSpecifier,
          line,
          referenceType: 'IMPORT',
        });
      }
    }

    return references;
  }

  /**
   * Build cross-file type references from symbol dependencies.
   */
  private buildCrossFileReferences(
    _sourceFile: SourceFile,
    symbols: TypeAwareSymbol[],
    filePath: string
  ): TypeReference[] {
    const references: TypeReference[] = [];

    for (const symbol of symbols) {
      for (const dep of symbol.dependencies) {
        // Only include external dependencies (cross-file)
        if (dep.sourceFile !== filePath && !dep.isBuiltIn) {
          references.push({
            sourceSymbol: symbol.name,
            sourceFile: filePath,
            targetSymbol: dep.name,
            targetFile: dep.sourceFile,
            line: symbol.startLine,
            referenceType: 'TYPE_USAGE',
          });
        }
      }
    }

    return references;
  }

  /**
   * Get resolver statistics.
   */
  getStats(): {
    cachedFiles: number;
    cachedSymbols: number;
    cachedReferences: number;
  } {
    let totalSymbols = 0;
    let totalReferences = 0;

    for (const symbols of this.cachedSymbols.values()) {
      totalSymbols += symbols.length;
    }

    for (const refs of this.cachedReferences.values()) {
      totalReferences += refs.length;
    }

    return {
      cachedFiles: this.cachedSymbols.size,
      cachedSymbols: totalSymbols,
      cachedReferences: totalReferences,
    };
  }

  /**
   * Clear all cached data.
   */
  clearCache(): void {
    this.cachedSymbols.clear();
    this.cachedReferences.clear();
  }
}

// ============================================================================
// STANDALONE FUNCTIONS
// ============================================================================

/**
 * Resolve types for a single file (convenience function).
 *
 * @param filePath - Path to the file
 * @param content - File content
 * @param projectRoot - Project root for context
 * @returns Type resolution result
 */
export async function resolveTypes(
  filePath: string,
  content: string,
  projectRoot: string
): Promise<TypeResolutionResult> {
  const resolver = new TSMorphResolver(projectRoot);
  await resolver.initialize();

  try {
    return await resolver.resolveFileTypes(filePath, content);
  } finally {
    resolver.dispose();
  }
}

/**
 * Check if a file can be resolved with ts-morph.
 *
 * @param filePath - Path to check
 * @returns True if supported
 */
export function isTSMorphSupportedFile(filePath: string): boolean {
  const supportedExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return supportedExtensions.includes(ext);
}

/**
 * Merge type resolution results into AST chunk metadata.
 *
 * Enhances existing AST chunks with type information for better
 * symbol disambiguation.
 *
 * @param astChunks - Existing AST chunks from tree-sitter
 * @param typeResult - Type resolution result from ts-morph
 * @returns Enhanced chunks with type metadata
 */
export function mergeTypeInfoIntoChunks(
  astChunks: Array<{
    content: string;
    symbol?: {
      name: string;
      kind: string;
      startLine: number;
      endLine: number;
      code: string;
    };
  }>,
  typeResult: TypeResolutionResult
): Array<{
  content: string;
  symbol?: {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    code: string;
    uniqueId?: string;
    returnType?: string;
    dependencies?: string[];
  };
}> {
  const symbolMap = new Map<string, TypeAwareSymbol>();

  // Build lookup map by name and line range
  for (const typeSymbol of typeResult.symbols) {
    const key = `${typeSymbol.name}:${typeSymbol.startLine}-${typeSymbol.endLine}`;
    symbolMap.set(key, typeSymbol);
    // Also map by name alone for fuzzy matching
    symbolMap.set(typeSymbol.name, typeSymbol);
  }

  return astChunks.map((chunk) => {
    if (!chunk.symbol) return chunk;

    // Try exact match first
    const exactKey = `${chunk.symbol.name}:${chunk.symbol.startLine}-${chunk.symbol.endLine}`;
    let typeSymbol = symbolMap.get(exactKey);

    // Fall back to name-only match
    if (!typeSymbol) {
      typeSymbol = symbolMap.get(chunk.symbol.name);
    }

    if (typeSymbol) {
      return {
        ...chunk,
        symbol: {
          ...chunk.symbol,
          uniqueId: typeSymbol.uniqueId,
          returnType: typeSymbol.returnType?.typeString,
          dependencies: typeSymbol.dependencies.map((d) => d.fullyQualifiedName),
        },
      };
    }

    return chunk;
  });
}
