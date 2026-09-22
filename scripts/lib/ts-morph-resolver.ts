/**
 * @module ts-morph-resolver
 * @description Cross-file symbol resolution using ts-morph for Project RAG.
 *
 * T-06: AST Symbol Table Completion for TypeScript/JavaScript
 */

import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { SourceFile } from 'ts-morph';
import { type Node, Project, SyntaxKind } from 'ts-morph';

export interface ResolvedSymbol {
  name: string;
  symbolType:
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'variable'
    | 'method'
    | 'property';
  exportType: 'named' | 'default' | 'none';
  sourcePath: string;
  signature: string;
  description?: string;
  startLine: number;
  endLine: number;
  symbolId: string;
  parentSymbolId?: string;
}

export interface ResolvedEdge {
  sourcePath: string;
  sourceSymbolId?: string;
  sourceLine: number;
  targetPath: string;
  targetSymbol: string;
  targetSymbolId?: string;
  relationType: 'IMPORTS' | 'EXPORTS' | 'CALLS' | 'EXTENDS' | 'IMPLEMENTS';
  confidence: number;
}

export interface CallGraphEntry {
  callerSymbolId: string;
  callerPath: string;
  calledSymbol: string;
  calledSymbolId?: string;
  calledPath?: string;
  line: number;
}

export class TsMorphResolver {
  private project: Project | null = null;
  private projectRoot: string;
  private symbolTable: Map<string, ResolvedSymbol> = new Map();
  private fileSymbols: Map<string, ResolvedSymbol[]> = new Map();

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  async initialize(): Promise<void> {
    const tsconfigPath = this.findTsConfig();

    if (tsconfigPath) {
      this.project = new Project({
        tsConfigFilePath: tsconfigPath,
      });
    } else {
      this.project = new Project({
        useInMemoryFileSystem: true,
      });
    }
  }

  addSourceFile(filePath: string, content: string): SourceFile {
    if (!this.project) {
      throw new Error('Project not initialized. Call initialize() first.');
    }

    const relativePath = this.normalizePath(filePath);
    return this.project.createSourceFile(relativePath, content, { overwrite: true });
  }

  extractAllSymbols(): ResolvedSymbol[] {
    if (!this.project) {
      throw new Error('Project not initialized. Call initialize() first.');
    }

    this.symbolTable.clear();
    this.fileSymbols.clear();

    const allSymbols: ResolvedSymbol[] = [];

    for (const sourceFile of this.project.getSourceFiles()) {
      const filePath = this.normalizePath(sourceFile.getFilePath());
      const symbols = this.extractSymbolsFromFile(sourceFile, filePath);
      this.fileSymbols.set(filePath, symbols);
      allSymbols.push(...symbols);

      for (const symbol of symbols) {
        this.symbolTable.set(symbol.symbolId, symbol);
      }
    }

    return allSymbols;
  }

  resolveCrossFileEdges(): ResolvedEdge[] {
    if (!this.project) {
      throw new Error('Project not initialized. Call initialize() first.');
    }

    const edges: ResolvedEdge[] = [];

    for (const sourceFile of this.project.getSourceFiles()) {
      const filePath = this.normalizePath(sourceFile.getFilePath());

      const importEdges = this.resolveImports(sourceFile, filePath);
      edges.push(...importEdges);

      const exportEdges = this.resolveExports(sourceFile, filePath);
      edges.push(...exportEdges);

      const callEdges = this.resolveCalls(sourceFile, filePath);
      edges.push(...callEdges);
    }

    return edges;
  }

  buildCallGraph(): CallGraphEntry[] {
    if (!this.project) {
      throw new Error('Project not initialized. Call initialize() first.');
    }

    const callGraph: CallGraphEntry[] = [];

    for (const sourceFile of this.project.getSourceFiles()) {
      const filePath = this.normalizePath(sourceFile.getFilePath());
      const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

      for (const callExpr of callExpressions) {
        const callLine = callExpr.getStartLineNumber();
        const containingFunction = this.findContainingFunction(callExpr);
        const callerSymbolId = containingFunction
          ? this.getSymbolId(filePath, containingFunction.getName() || 'anonymous')
          : filePath;

        const calledSymbol = this.extractCalledSymbolName(callExpr);
        if (!calledSymbol) continue;

        const resolved = this.resolveSymbol(calledSymbol, sourceFile);

        callGraph.push({
          callerSymbolId,
          callerPath: filePath,
          calledSymbol,
          calledSymbolId: resolved?.symbolId,
          calledPath: resolved?.sourcePath,
          line: callLine,
        });
      }
    }

    return callGraph;
  }

  getSymbolTable(): Map<string, ResolvedSymbol> {
    return this.symbolTable;
  }

  getFileSymbols(filePath: string): ResolvedSymbol[] {
    return this.fileSymbols.get(this.normalizePath(filePath)) || [];
  }

  private findTsConfig(): string | undefined {
    const possiblePaths = [
      join(this.projectRoot, 'tsconfig.json'),
      join(this.projectRoot, 'src', 'tsconfig.json'),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    return undefined;
  }

  private normalizePath(filePath: string): string {
    const resolved = resolve(filePath);
    if (resolved.startsWith(this.projectRoot)) {
      return relative(this.projectRoot, resolved).replace(/\\/g, '/');
    }
    return filePath.replace(/\\/g, '/');
  }

  private extractSymbolsFromFile(sourceFile: SourceFile, filePath: string): ResolvedSymbol[] {
    const symbols: ResolvedSymbol[] = [];

    for (const cls of sourceFile.getClasses()) {
      const symbol = this.classToSymbol(cls, filePath);
      symbols.push(symbol);

      for (const method of cls.getMethods()) {
        const methodSymbol = this.methodToSymbol(method, filePath, symbol.symbolId);
        symbols.push(methodSymbol);
      }

      for (const prop of cls.getProperties()) {
        const propSymbol = this.propertyToSymbol(prop, filePath, symbol.symbolId);
        symbols.push(propSymbol);
      }
    }

    for (const intf of sourceFile.getInterfaces()) {
      symbols.push(this.interfaceToSymbol(intf, filePath));
    }

    for (const type of sourceFile.getTypeAliases()) {
      symbols.push(this.typeToSymbol(type, filePath));
    }

    for (const enumDecl of sourceFile.getEnums()) {
      symbols.push(this.enumToSymbol(enumDecl, filePath));
    }

    for (const func of sourceFile.getFunctions()) {
      symbols.push(this.functionToSymbol(func, filePath));
    }

    for (const varStmt of sourceFile.getVariableStatements()) {
      if (varStmt.isExported()) {
        for (const decl of varStmt.getDeclarations()) {
          symbols.push(this.variableToSymbol(decl, filePath, varStmt));
        }
      }
    }

    return symbols;
  }

  private classToSymbol(
    cls: import('ts-morph').ClassDeclaration,
    filePath: string
  ): ResolvedSymbol {
    const name = cls.getName() || 'anonymous';
    return {
      name,
      symbolType: 'class',
      exportType: cls.isExported() ? (cls.isDefaultExport() ? 'default' : 'named') : 'none',
      sourcePath: filePath,
      signature: cls.getText().split('{')[0].trim(),
      description: cls
        .getJsDocs()
        .map((doc) => doc.getCommentText())
        .join('\n'),
      startLine: cls.getStartLineNumber(),
      endLine: cls.getEndLineNumber(),
      symbolId: this.getSymbolId(filePath, name),
    };
  }

  private methodToSymbol(
    method: import('ts-morph').MethodDeclaration,
    filePath: string,
    parentId: string
  ): ResolvedSymbol {
    const name = method.getName();
    return {
      name,
      symbolType: 'method',
      exportType: 'none',
      sourcePath: filePath,
      signature: method.getText().split('{')[0].trim(),
      description: method
        .getJsDocs()
        .map((doc) => doc.getCommentText())
        .join('\n'),
      startLine: method.getStartLineNumber(),
      endLine: method.getEndLineNumber(),
      symbolId: this.getSymbolId(filePath, `${parentId}.${name}`),
      parentSymbolId: parentId,
    };
  }

  private propertyToSymbol(
    prop: import('ts-morph').PropertyDeclaration,
    filePath: string,
    parentId: string
  ): ResolvedSymbol {
    const name = prop.getName();
    return {
      name,
      symbolType: 'property',
      exportType: 'none',
      sourcePath: filePath,
      signature: prop.getText(),
      description: undefined,
      startLine: prop.getStartLineNumber(),
      endLine: prop.getEndLineNumber(),
      symbolId: this.getSymbolId(filePath, `${parentId}.${name}`),
      parentSymbolId: parentId,
    };
  }

  private interfaceToSymbol(
    intf: import('ts-morph').InterfaceDeclaration,
    filePath: string
  ): ResolvedSymbol {
    const name = intf.getName();
    return {
      name,
      symbolType: 'interface',
      exportType: intf.isExported() ? (intf.isDefaultExport() ? 'default' : 'named') : 'none',
      sourcePath: filePath,
      signature: intf.getText().split('{')[0].trim(),
      description: intf
        .getJsDocs()
        .map((doc) => doc.getCommentText())
        .join('\n'),
      startLine: intf.getStartLineNumber(),
      endLine: intf.getEndLineNumber(),
      symbolId: this.getSymbolId(filePath, name),
    };
  }

  private typeToSymbol(
    type: import('ts-morph').TypeAliasDeclaration,
    filePath: string
  ): ResolvedSymbol {
    const name = type.getName();
    return {
      name,
      symbolType: 'type',
      exportType: type.isExported() ? (type.isDefaultExport() ? 'default' : 'named') : 'none',
      sourcePath: filePath,
      signature: type.getText(),
      description: type
        .getJsDocs()
        .map((doc) => doc.getCommentText())
        .join('\n'),
      startLine: type.getStartLineNumber(),
      endLine: type.getEndLineNumber(),
      symbolId: this.getSymbolId(filePath, name),
    };
  }

  private enumToSymbol(
    enumDecl: import('ts-morph').EnumDeclaration,
    filePath: string
  ): ResolvedSymbol {
    const name = enumDecl.getName();
    return {
      name,
      symbolType: 'enum',
      exportType: enumDecl.isExported()
        ? enumDecl.isDefaultExport()
          ? 'default'
          : 'named'
        : 'none',
      sourcePath: filePath,
      signature: enumDecl.getText().split('{')[0].trim(),
      description: undefined,
      startLine: enumDecl.getStartLineNumber(),
      endLine: enumDecl.getEndLineNumber(),
      symbolId: this.getSymbolId(filePath, name),
    };
  }

  private functionToSymbol(
    func: import('ts-morph').FunctionDeclaration,
    filePath: string
  ): ResolvedSymbol {
    const name = func.getName() || 'anonymous';
    return {
      name,
      symbolType: 'function',
      exportType: func.isExported() ? (func.isDefaultExport() ? 'default' : 'named') : 'none',
      sourcePath: filePath,
      signature: func.getText().split('{')[0].trim(),
      description: func
        .getJsDocs()
        .map((doc) => doc.getCommentText())
        .join('\n'),
      startLine: func.getStartLineNumber(),
      endLine: func.getEndLineNumber(),
      symbolId: this.getSymbolId(filePath, name),
    };
  }

  private variableToSymbol(
    decl: import('ts-morph').VariableDeclaration,
    filePath: string,
    stmt: import('ts-morph').VariableStatement
  ): ResolvedSymbol {
    const name = decl.getName();
    return {
      name,
      symbolType: 'variable',
      exportType: stmt.isExported() ? (stmt.isDefaultExport() ? 'default' : 'named') : 'none',
      sourcePath: filePath,
      signature: decl.getText(),
      description: undefined,
      startLine: decl.getStartLineNumber(),
      endLine: decl.getEndLineNumber(),
      symbolId: this.getSymbolId(filePath, name),
    };
  }

  private getSymbolId(filePath: string, name: string): string {
    return `${filePath}::${name}`;
  }

  private resolveImports(sourceFile: SourceFile, filePath: string): ResolvedEdge[] {
    const edges: ResolvedEdge[] = [];

    for (const importDecl of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      const line = importDecl.getStartLineNumber();

      let resolvedPath: string | undefined;
      try {
        const resolved = importDecl.getModuleSpecifierSourceFile();
        if (resolved) {
          resolvedPath = this.normalizePath(resolved.getFilePath());
        }
      } catch {
        // External module or resolution failed
      }

      for (const namedImport of importDecl.getNamedImports()) {
        const name = namedImport.getName();
        const alias = namedImport.getAliasNode()?.getText();

        edges.push({
          sourcePath: filePath,
          sourceLine: line,
          targetPath: resolvedPath || moduleSpecifier,
          targetSymbol: alias || name,
          targetSymbolId: resolvedPath ? this.getSymbolId(resolvedPath, name) : undefined,
          relationType: 'IMPORTS',
          confidence: resolvedPath ? 1.0 : 0.5,
        });
      }

      const defaultImport = importDecl.getDefaultImport();
      if (defaultImport) {
        edges.push({
          sourcePath: filePath,
          sourceLine: line,
          targetPath: resolvedPath || moduleSpecifier,
          targetSymbol: 'default',
          targetSymbolId: resolvedPath ? this.getSymbolId(resolvedPath, 'default') : undefined,
          relationType: 'IMPORTS',
          confidence: resolvedPath ? 1.0 : 0.5,
        });
      }

      const namespaceImport = importDecl.getNamespaceImport();
      if (namespaceImport) {
        edges.push({
          sourcePath: filePath,
          sourceLine: line,
          targetPath: resolvedPath || moduleSpecifier,
          targetSymbol: namespaceImport.getText(),
          relationType: 'IMPORTS',
          confidence: resolvedPath ? 1.0 : 0.5,
        });
      }
    }

    return edges;
  }

  private resolveExports(sourceFile: SourceFile, filePath: string): ResolvedEdge[] {
    const edges: ResolvedEdge[] = [];

    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const moduleSpecifier = exportDecl.getModuleSpecifierValue();
      if (!moduleSpecifier) continue;

      const line = exportDecl.getStartLineNumber();

      let resolvedPath: string | undefined;
      try {
        const resolved = exportDecl.getModuleSpecifierSourceFile();
        if (resolved) {
          resolvedPath = this.normalizePath(resolved.getFilePath());
        }
      } catch {
        // Resolution failed
      }

      for (const namedExport of exportDecl.getNamedExports()) {
        edges.push({
          sourcePath: filePath,
          sourceLine: line,
          targetPath: resolvedPath || moduleSpecifier,
          targetSymbol: namedExport.getName(),
          targetSymbolId: resolvedPath
            ? this.getSymbolId(resolvedPath, namedExport.getName())
            : undefined,
          relationType: 'EXPORTS',
          confidence: resolvedPath ? 1.0 : 0.5,
        });
      }
    }

    return edges;
  }

  private resolveCalls(sourceFile: SourceFile, filePath: string): ResolvedEdge[] {
    const edges: ResolvedEdge[] = [];

    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const calledName = this.extractCalledSymbolName(callExpr);
      if (!calledName) continue;

      const line = callExpr.getStartLineNumber();

      const resolved = this.resolveSymbol(calledName, sourceFile);

      edges.push({
        sourcePath: filePath,
        sourceLine: line,
        targetPath: resolved?.sourcePath || 'unknown',
        targetSymbol: calledName,
        targetSymbolId: resolved?.symbolId,
        relationType: 'CALLS',
        confidence: resolved ? 1.0 : 0.3,
      });
    }

    return edges;
  }

  private extractCalledSymbolName(callExpr: import('ts-morph').CallExpression): string | null {
    const expression = callExpr.getExpression();

    if (expression.getKind() === SyntaxKind.Identifier) {
      return expression.getText();
    }

    if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = expression as import('ts-morph').PropertyAccessExpression;
      return propAccess.getName();
    }

    return null;
  }

  private resolveSymbol(symbolName: string, sourceFile: SourceFile): ResolvedSymbol | undefined {
    const filePath = this.normalizePath(sourceFile.getFilePath());
    const localId = this.getSymbolId(filePath, symbolName);
    if (this.symbolTable.has(localId)) {
      return this.symbolTable.get(localId);
    }

    for (const importDecl of sourceFile.getImportDeclarations()) {
      for (const namedImport of importDecl.getNamedImports()) {
        if (
          namedImport.getName() === symbolName ||
          namedImport.getAliasNode()?.getText() === symbolName
        ) {
          try {
            const resolved = importDecl.getModuleSpecifierSourceFile();
            if (resolved) {
              const resolvedPath = this.normalizePath(resolved.getFilePath());
              const symbolId = this.getSymbolId(resolvedPath, namedImport.getName());
              return this.symbolTable.get(symbolId);
            }
          } catch {
            // Resolution failed
          }
        }
      }
    }

    return undefined;
  }

  private findContainingFunction(
    node: Node
  ): import('ts-morph').FunctionDeclaration | import('ts-morph').MethodDeclaration | null {
    let current: Node | undefined = node;
    while (current) {
      if (current.getKind() === SyntaxKind.FunctionDeclaration) {
        return current as import('ts-morph').FunctionDeclaration;
      }
      if (current.getKind() === SyntaxKind.MethodDeclaration) {
        return current as import('ts-morph').MethodDeclaration;
      }
      current = current.getParent();
    }
    return null;
  }
}

export async function analyzeProject(projectRoot: string): Promise<{
  symbols: ResolvedSymbol[];
  edges: ResolvedEdge[];
  callGraph: CallGraphEntry[];
}> {
  const resolver = new TsMorphResolver(projectRoot);
  await resolver.initialize();

  const symbols = resolver.extractAllSymbols();
  const edges = resolver.resolveCrossFileEdges();
  const callGraph = resolver.buildCallGraph();

  return { symbols, edges, callGraph };
}

export async function analyzeFile(
  projectRoot: string,
  filePath: string,
  content: string
): Promise<{
  symbols: ResolvedSymbol[];
  edges: ResolvedEdge[];
}> {
  const resolver = new TsMorphResolver(projectRoot);
  await resolver.initialize();

  resolver.addSourceFile(filePath, content);

  const symbols = resolver.extractAllSymbols();
  const edges = resolver.resolveCrossFileEdges();

  return { symbols, edges };
}
