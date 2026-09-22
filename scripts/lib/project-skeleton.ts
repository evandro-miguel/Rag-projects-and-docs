/**
 * @module project-skeleton
 * @description Enhanced project skeleton generation from symbol/edge graph.
 *
 * T-08: Project Skeleton Indexing
 *
 * This module generates hierarchical project skeletons from:
 * - Symbol table (functions, classes, interfaces, types, enums)
 * - Edge relationships (imports, exports, calls)
 * - Cross-file references
 *
 * Produces a comprehensive outline of the entire project structure.
 *
 * @example
 * const builder = new ProjectSkeletonBuilder(projectRoot);
 * const skeleton = await builder.buildSkeleton();
 * // Returns hierarchical structure with files, symbols, and relationships
 */

import { type ResolvedEdge, type ResolvedSymbol, TsMorphResolver } from './ts-morph-resolver.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Hierarchical file node in the project skeleton.
 */
export interface FileSkeleton {
  /** File path (relative to project root) */
  path: string;
  /** File name */
  name: string;
  /** File extension */
  extension: string;
  /** Directory containing the file */
  directory: string;
  /** Symbols defined in this file */
  symbols: SymbolSkeleton[];
  /** Imports from other files */
  imports: ImportSkeleton[];
  /** Exports to other files */
  exports: ExportSkeleton[];
  /** Call references from this file */
  calls: CallSkeleton[];
  /** Line count */
  lineCount: number;
  /** Whether this is an entry point (has exports) */
  isEntryPoint: boolean;
}

/**
 * Symbol information in skeleton.
 */
export interface SymbolSkeleton {
  /** Symbol name */
  name: string;
  /** Symbol type */
  type: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'method' | 'property';
  /** Export status */
  exportType: 'named' | 'default' | 'none';
  /** Signature (function signature, class declaration, etc.) */
  signature: string;
  /** JSDoc description */
  description?: string;
  /** Start line */
  startLine: number;
  /** End line */
  endLine: number;
  /** Parent symbol name (for methods/properties) */
  parentName?: string;
  /** Child symbols (methods, properties) */
  children: SymbolSkeleton[];
}

/**
 * Import relationship.
 */
export interface ImportSkeleton {
  /** Imported symbol name */
  symbol: string;
  /** Source module/file */
  source: string;
  /** Source file path (resolved) */
  sourcePath?: string;
  /** Import type */
  importType: 'named' | 'default' | 'namespace';
  /** Line number */
  line: number;
}

/**
 * Export relationship.
 */
export interface ExportSkeleton {
  /** Exported symbol name */
  symbol: string;
  /** Target module/file (for re-exports) */
  target?: string;
  /** Export type */
  exportType: 'named' | 'default' | 're-export';
  /** Line number */
  line: number;
}

/**
 * Call relationship.
 */
export interface CallSkeleton {
  /** Called symbol name */
  symbol: string;
  /** Source file of called symbol (if resolved) */
  sourcePath?: string;
  /** Call site line */
  line: number;
  /** Confidence of resolution */
  confidence: number;
}

/**
 * Complete project skeleton.
 */
export interface ProjectSkeleton {
  /** Project root path */
  rootPath: string;
  /** All files in the project */
  files: FileSkeleton[];
  /** Directory tree */
  directories: DirectorySkeleton[];
  /** Summary statistics */
  stats: SkeletonStats;
  /** Entry points (files with exports) */
  entryPoints: string[];
  /** Module dependency graph */
  dependencies: DependencyGraph;
}

/**
 * Directory in the project.
 */
export interface DirectorySkeleton {
  /** Directory path */
  path: string;
  /** Directory name */
  name: string;
  /** Files in this directory */
  files: string[];
  /** Subdirectories */
  subdirectories: string[];
  /** Whether this is a package/module root */
  isModuleRoot: boolean;
}

/**
 * Skeleton statistics.
 */
export interface SkeletonStats {
  totalFiles: number;
  totalSymbols: number;
  totalClasses: number;
  totalFunctions: number;
  totalInterfaces: number;
  totalTypes: number;
  totalEnums: number;
  totalImports: number;
  totalExports: number;
}

/**
 * Dependency graph between modules.
 */
export interface DependencyGraph {
  /** Nodes (files) */
  nodes: Array<{ id: string; label: string; type: string }>;
  /** Edges (dependencies) */
  edges: Array<{ source: string; target: string; type: string }>;
}

// ============================================================================
// SKELETON BUILDER
// ============================================================================

export class ProjectSkeletonBuilder {
  private projectRoot: string;
  private resolver: TsMorphResolver;
  private symbols: ResolvedSymbol[] = [];
  private edges: ResolvedEdge[] = [];

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.resolver = new TsMorphResolver(projectRoot);
  }

  /**
   * Initialize and analyze the project.
   */
  async initialize(): Promise<void> {
    await this.resolver.initialize();
    this.symbols = this.resolver.extractAllSymbols();
    this.edges = this.resolver.resolveCrossFileEdges();
  }

  /**
   * Build the complete project skeleton.
   */
  async buildSkeleton(): Promise<ProjectSkeleton> {
    if (this.symbols.length === 0) {
      await this.initialize();
    }

    // Group symbols by file
    const symbolsByFile = this.groupSymbolsByFile();

    // Build file skeletons
    const files: FileSkeleton[] = [];
    for (const [filePath, fileSymbols] of symbolsByFile.entries()) {
      files.push(this.buildFileSkeleton(filePath, fileSymbols));
    }

    // Build directory tree
    const directories = this.buildDirectoryTree(files);

    // Build dependency graph
    const dependencies = this.buildDependencyGraph(files);

    // Calculate stats
    const stats = this.calculateStats(files);

    // Find entry points
    const entryPoints = files.filter((f) => f.isEntryPoint).map((f) => f.path);

    return {
      rootPath: this.projectRoot,
      files,
      directories,
      stats,
      entryPoints,
      dependencies,
    };
  }

  /**
   * Generate a text summary of the project skeleton.
   */
  generateSummary(skeleton: ProjectSkeleton): string {
    const lines: string[] = [];

    lines.push(`# Project Skeleton: ${this.projectRoot}`);
    lines.push('');
    lines.push(`## Overview`);
    lines.push(`- Total Files: ${skeleton.stats.totalFiles}`);
    lines.push(`- Total Symbols: ${skeleton.stats.totalSymbols}`);
    lines.push(`- Classes: ${skeleton.stats.totalClasses}`);
    lines.push(`- Functions: ${skeleton.stats.totalFunctions}`);
    lines.push(`- Interfaces: ${skeleton.stats.totalInterfaces}`);
    lines.push(`- Types: ${skeleton.stats.totalTypes}`);
    lines.push(`- Enums: ${skeleton.stats.totalEnums}`);
    lines.push(`- Entry Points: ${skeleton.entryPoints.length}`);
    lines.push('');

    lines.push(`## Entry Points`);
    for (const entry of skeleton.entryPoints.slice(0, 20)) {
      lines.push(`- ${entry}`);
    }
    if (skeleton.entryPoints.length > 20) {
      lines.push(`- ... and ${skeleton.entryPoints.length - 20} more`);
    }
    lines.push('');

    lines.push(`## Top Files by Symbol Count`);
    const topFiles = [...skeleton.files]
      .sort((a, b) => b.symbols.length - a.symbols.length)
      .slice(0, 10);
    for (const file of topFiles) {
      lines.push(`- ${file.path} (${file.symbols.length} symbols)`);
    }
    lines.push('');

    lines.push(`## Directory Structure`);
    for (const dir of skeleton.directories.slice(0, 20)) {
      const indent = dir.path.split('/').length - 1;
      lines.push(`${'  '.repeat(indent)}📁 ${dir.name}/ (${dir.files.length} files)`);
    }

    return lines.join('\n');
  }

  /**
   * Generate a hierarchical outline for a specific file.
   */
  generateFileOutline(filePath: string): string | null {
    const normalizedPath = filePath.replace(this.projectRoot, '').replace(/^\//, '');
    const fileSkeleton = this.buildFileSkeletonFromCache(normalizedPath);

    if (!fileSkeleton) return null;

    const lines: string[] = [];
    lines.push(`// File: ${fileSkeleton.path}`);
    lines.push('');

    // Imports
    if (fileSkeleton.imports.length > 0) {
      lines.push('// Imports:');
      for (const imp of fileSkeleton.imports) {
        lines.push(`//   import { ${imp.symbol} } from '${imp.source}'`);
      }
      lines.push('');
    }

    // Exports
    if (fileSkeleton.exports.length > 0) {
      lines.push('// Exports:');
      for (const exp of fileSkeleton.exports) {
        lines.push(`//   export ${exp.exportType === 'default' ? 'default ' : ''}${exp.symbol}`);
      }
      lines.push('');
    }

    // Symbols
    for (const symbol of fileSkeleton.symbols) {
      this.renderSymbolOutline(symbol, lines, 0);
    }

    return lines.join('\n');
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private groupSymbolsByFile(): Map<string, ResolvedSymbol[]> {
    const map = new Map<string, ResolvedSymbol[]>();

    for (const symbol of this.symbols) {
      const existing = map.get(symbol.sourcePath) || [];
      existing.push(symbol);
      map.set(symbol.sourcePath, existing);
    }

    return map;
  }

  private buildFileSkeleton(filePath: string, fileSymbols: ResolvedSymbol[]): FileSkeleton {
    const fileName = filePath.split('/').pop() || filePath;
    const extension = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
    const directory = filePath.split('/').slice(0, -1).join('/') || '.';

    // Build symbol skeletons
    const symbolSkeletons: SymbolSkeleton[] = [];
    const childSymbols = new Map<string, SymbolSkeleton[]>();

    // First pass: identify parent-child relationships
    for (const symbol of fileSymbols) {
      if (symbol.parentSymbolId) {
        const parentId = symbol.parentSymbolId;
        const existing = childSymbols.get(parentId) || [];
        existing.push(this.toSymbolSkeleton(symbol));
        childSymbols.set(parentId, existing);
      }
    }

    // Second pass: build top-level symbols with children
    for (const symbol of fileSymbols) {
      if (!symbol.parentSymbolId) {
        const skeleton = this.toSymbolSkeleton(symbol);
        skeleton.children = childSymbols.get(symbol.symbolId) || [];
        symbolSkeletons.push(skeleton);
      }
    }

    // Get imports for this file
    const imports = this.edges
      .filter((e) => e.sourcePath === filePath && e.relationType === 'IMPORTS')
      .map((e) => ({
        symbol: e.targetSymbol,
        source: e.targetPath,
        sourcePath: e.targetSymbolId ? e.targetPath : undefined,
        importType: 'named' as const,
        line: e.sourceLine,
      }));

    // Get exports for this file
    const exports: ExportSkeleton[] = this.edges
      .filter((e) => e.sourcePath === filePath && e.relationType === 'EXPORTS')
      .map((e) => ({
        symbol: e.targetSymbol,
        target: e.targetPath,
        exportType: 're-export' as const,
        line: e.sourceLine,
      }));

    // Add local exports from symbols
    for (const symbol of fileSymbols) {
      if (symbol.exportType === 'named' || symbol.exportType === 'default') {
        const alreadyExported = exports.some((e) => e.symbol === symbol.name);
        if (!alreadyExported) {
          exports.push({
            symbol: symbol.name,
            exportType: symbol.exportType,
            line: symbol.startLine,
          });
        }
      }
    }

    // Get calls from this file
    const calls = this.edges
      .filter((e) => e.sourcePath === filePath && e.relationType === 'CALLS')
      .map((e) => ({
        symbol: e.targetSymbol,
        sourcePath: e.targetSymbolId ? e.targetPath : undefined,
        line: e.sourceLine,
        confidence: e.confidence,
      }));

    // Calculate line count
    const maxLine = Math.max(...fileSymbols.map((s) => s.endLine), 0);

    return {
      path: filePath,
      name: fileName,
      extension,
      directory,
      symbols: symbolSkeletons,
      imports,
      exports,
      calls,
      lineCount: maxLine,
      isEntryPoint: exports.length > 0,
    };
  }

  private buildFileSkeletonFromCache(filePath: string): FileSkeleton | null {
    const fileSymbols = this.symbols.filter((s) => s.sourcePath === filePath);
    if (fileSymbols.length === 0) return null;
    return this.buildFileSkeleton(filePath, fileSymbols);
  }

  private toSymbolSkeleton(symbol: ResolvedSymbol): SymbolSkeleton {
    return {
      name: symbol.name,
      type: symbol.symbolType,
      exportType: symbol.exportType,
      signature: symbol.signature,
      description: symbol.description,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      parentName: symbol.parentSymbolId,
      children: [],
    };
  }

  private renderSymbolOutline(symbol: SymbolSkeleton, lines: string[], indent: number): void {
    const indentStr = '  '.repeat(indent);

    switch (symbol.type) {
      case 'class':
        lines.push(`${indentStr}class ${symbol.name} {`);
        break;
      case 'interface':
        lines.push(`${indentStr}interface ${symbol.name} {`);
        break;
      case 'function':
        lines.push(`${indentStr}${symbol.signature}`);
        break;
      case 'type':
        lines.push(`${indentStr}type ${symbol.name} = ...`);
        break;
      case 'enum':
        lines.push(`${indentStr}enum ${symbol.name} { ... }`);
        break;
      case 'method':
        lines.push(`${indentStr}  ${symbol.signature}`);
        break;
      case 'property':
        lines.push(`${indentStr}  ${symbol.name}: ...`);
        break;
      default:
        lines.push(`${indentStr}${symbol.name}`);
    }

    for (const child of symbol.children) {
      this.renderSymbolOutline(child, lines, indent + 1);
    }

    if (symbol.type === 'class' || symbol.type === 'interface') {
      lines.push(`${indentStr}}`);
    }
  }

  private buildDirectoryTree(files: FileSkeleton[]): DirectorySkeleton[] {
    const dirMap = new Map<string, DirectorySkeleton>();

    for (const file of files) {
      const parts = file.directory.split('/');
      let currentPath = '';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        const parentPath = currentPath;
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        if (!dirMap.has(currentPath)) {
          dirMap.set(currentPath, {
            path: currentPath,
            name: part,
            files: [],
            subdirectories: [],
            isModuleRoot: false,
          });
        }

        if (parentPath) {
          const parent = dirMap.get(parentPath);
          if (parent && !parent.subdirectories.includes(currentPath)) {
            parent.subdirectories.push(currentPath);
          }
        }
      }

      // Add file to its directory
      const dir = dirMap.get(file.directory);
      if (dir) {
        dir.files.push(file.path);
      }
    }

    // Detect module roots (directories with package.json or index.ts)
    for (const dir of dirMap.values()) {
      const hasPackageJson = dir.files.some((f) => f.endsWith('package.json'));
      const hasIndex = dir.files.some((f) => /index\.(ts|tsx|js|jsx)$/.test(f));
      dir.isModuleRoot = hasPackageJson || hasIndex;
    }

    return Array.from(dirMap.values());
  }

  private buildDependencyGraph(files: FileSkeleton[]): DependencyGraph {
    const nodes = files.map((f) => ({
      id: f.path,
      label: f.name,
      type: f.extension,
    }));

    const edges: DependencyGraph['edges'] = [];
    const edgeSet = new Set<string>();

    for (const file of files) {
      for (const imp of file.imports) {
        const targetFile = files.find(
          (f) => f.path === imp.sourcePath || f.path.endsWith(imp.source.replace(/^\.\//, ''))
        );

        if (targetFile) {
          const edgeKey = `${file.path}->${targetFile.path}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({
              source: file.path,
              target: targetFile.path,
              type: 'import',
            });
          }
        }
      }
    }

    return { nodes, edges };
  }

  private calculateStats(files: FileSkeleton[]): SkeletonStats {
    let totalSymbols = 0;
    let totalClasses = 0;
    let totalFunctions = 0;
    let totalInterfaces = 0;
    let totalTypes = 0;
    let totalEnums = 0;
    let totalImports = 0;
    let totalExports = 0;

    for (const file of files) {
      totalSymbols += file.symbols.length;
      totalImports += file.imports.length;
      totalExports += file.exports.length;

      for (const symbol of file.symbols) {
        switch (symbol.type) {
          case 'class':
            totalClasses++;
            break;
          case 'function':
          case 'method':
            totalFunctions++;
            break;
          case 'interface':
            totalInterfaces++;
            break;
          case 'type':
            totalTypes++;
            break;
          case 'enum':
            totalEnums++;
            break;
        }
      }
    }

    return {
      totalFiles: files.length,
      totalSymbols,
      totalClasses,
      totalFunctions,
      totalInterfaces,
      totalTypes,
      totalEnums,
      totalImports,
      totalExports,
    };
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Build project skeleton in one call.
 */
export async function buildProjectSkeleton(projectRoot: string): Promise<ProjectSkeleton> {
  const builder = new ProjectSkeletonBuilder(projectRoot);
  await builder.initialize();
  return await builder.buildSkeleton();
}

/**
 * Generate project summary in one call.
 */
export async function generateProjectSummary(projectRoot: string): Promise<string> {
  const builder = new ProjectSkeletonBuilder(projectRoot);
  await builder.initialize();
  const skeleton = await builder.buildSkeleton();
  return builder.generateSummary(skeleton);
}

/**
 * Generate file outline in one call.
 */
export async function generateFileOutline(
  projectRoot: string,
  filePath: string
): Promise<string | null> {
  const builder = new ProjectSkeletonBuilder(projectRoot);
  await builder.initialize();
  return builder.generateFileOutline(filePath);
}
