import * as ts from 'typescript';

export interface ParsedSymbol {
  name: string;
  symbolType: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable';
  exportType: 'named' | 'default' | 'none';
  signature?: string;
  startLine?: number;
  endLine?: number;
  description?: string;
}

export interface ParsedEdge {
  targetId: string; // The imported module, imported binding, or called function
  relationType: 'IMPORTS' | 'CALLS';
}

/**
 * Property-access call names that drown the shallow CALLS graph with stdlib /
 * test-framework noise (e.g. arr.map, console.log, expect().toBe).
 * Direct identifier calls (withReadDeadline(...)) are never filtered.
 */
const PROPERTY_CALL_NOISE = new Set([
  // Array / String / Object prototypes
  'map',
  'filter',
  'reduce',
  'forEach',
  'find',
  'findIndex',
  'some',
  'every',
  'includes',
  'join',
  'slice',
  'splice',
  'push',
  'pop',
  'shift',
  'unshift',
  'concat',
  'flat',
  'flatMap',
  'sort',
  'reverse',
  'fill',
  'entries',
  'keys',
  'values',
  'at',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'replace',
  'replaceAll',
  'match',
  'startsWith',
  'endsWith',
  'toLowerCase',
  'toUpperCase',
  'padStart',
  'padEnd',
  'toString',
  'valueOf',
  'hasOwnProperty',
  // Promise / thenables
  'then',
  'catch',
  'finally',
  // console
  'log',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  // common test runners / matchers
  'toBe',
  'toEqual',
  'toContain',
  'toThrow',
  'toHaveBeenCalled',
  'toHaveBeenCalledWith',
  'toHaveBeenCalledTimes',
  'toMatchObject',
  'toBeDefined',
  'toBeUndefined',
  'toBeNull',
  'toBeTruthy',
  'toBeFalsy',
  'toHaveLength',
  'toBeInstanceOf',
  'rejects',
  'resolves',
]);

function clampLine(line: number, totalLines: number): number {
  if (!Number.isFinite(line) || line < 1) return 1;
  if (line > totalLines) return totalLines;
  return line;
}

function clampLineRange(
  startLine: number,
  endLine: number,
  totalLines: number
): { startLine: number; endLine: number } {
  const start = clampLine(startLine, totalLines);
  const end = clampLine(endLine, totalLines);
  return {
    startLine: Math.min(start, end),
    endLine: Math.max(start, end),
  };
}

export function parseAst(filePath: string, fileContent: string) {
  const sourceFile = ts.createSourceFile(filePath, fileContent, ts.ScriptTarget.Latest, true);
  const totalLines = Math.max(1, sourceFile.getLineStarts().length);

  const symbols: ParsedSymbol[] = [];
  const calls = new Set<string>();
  const imports = new Set<string>();
  // Named import bindings keyed by original exported name so
  // find_symbol_references(target_ref_lower) can find import sites.
  const namedImportBindings = new Set<string>();

  function extractModifiers(node: ts.Node) {
    let isExported = false;
    let isDefaultExport = false;

    if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node);
      if (modifiers) {
        isExported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        isDefaultExport = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      }
    }

    const exportType: 'named' | 'default' | 'none' = isExported
      ? isDefaultExport
        ? 'default'
        : 'named'
      : 'none';
    return exportType;
  }

  function visit(node: ts.Node) {
    // 1. Handle Imports — module path + value named bindings (for symbol refs)
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.add(node.moduleSpecifier.text);
      }
      // Skip type-only imports entirely for named-binding symbol edges
      // (import type { Foo } / import { type Bar }) — they are not runtime refs.
      const importClause = node.importClause;
      if (importClause && !importClause.isTypeOnly) {
        const namedBindings = importClause.namedBindings;
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            if (element.isTypeOnly) {
              continue;
            }
            // Prefer the original export name when aliased: import { Foo as Bar }
            const originalName = element.propertyName?.text ?? element.name.text;
            if (originalName) {
              namedImportBindings.add(originalName);
            }
          }
        }
      }
    }

    // 2. Handle Declarations (Symbols)
    const exportType = extractModifiers(node);

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name) {
        let symbolType: ParsedSymbol['symbolType'] = 'variable';
        if (ts.isFunctionDeclaration(node)) symbolType = 'function';
        else if (ts.isClassDeclaration(node)) symbolType = 'class';
        else if (ts.isInterfaceDeclaration(node)) symbolType = 'interface';
        else if (ts.isTypeAliasDeclaration(node)) symbolType = 'type';
        else if (ts.isEnumDeclaration(node)) symbolType = 'enum';

        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        const range = clampLineRange(start.line + 1, end.line + 1, totalLines);

        let signature: string | undefined;
        if (ts.isFunctionDeclaration(node)) {
          signature = node.getText(sourceFile).split('{')[0]?.trim();
        }

        symbols.push({
          name: node.name.text,
          symbolType,
          exportType,
          signature,
          startLine: range.startLine,
          endLine: range.endLine,
        });
      }
    } else if (ts.isVariableStatement(node) && exportType !== 'none') {
      // For variables, we only track them if they are exported (to avoid massive noise)
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const start = sourceFile.getLineAndCharacterOfPosition(declaration.getStart());
          const end = sourceFile.getLineAndCharacterOfPosition(declaration.getEnd());
          const range = clampLineRange(start.line + 1, end.line + 1, totalLines);

          const isFn =
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer));
          const symbolType: ParsedSymbol['symbolType'] = isFn ? 'function' : 'variable';
          let signature: string | undefined;
          if (isFn) {
            const declText = declaration.getText(sourceFile);
            signature = declText.includes('=>')
              ? declText.split('=>')[0]?.trim()
              : declText.split('{')[0]?.trim();
          }

          symbols.push({
            name: declaration.name.text,
            symbolType,
            exportType,
            signature,
            startLine: range.startLine,
            endLine: range.endLine,
          });
        }
      }
    }

    // 3. Handle Function Calls
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        // Direct calls are high-signal for symbol references.
        calls.add(node.expression.text);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.name)
      ) {
        const member = node.expression.name.text;
        // Keep project-like method names; drop stdlib/test noise that dominated
        // the live CALLS graph (map/join/toBe/log/...).
        if (!PROPERTY_CALL_NOISE.has(member)) {
          calls.add(member);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Distinct edges by (targetId, relationType)
  const uniqueEdges = new Map<string, ParsedEdge>();
  for (const imp of imports) {
    uniqueEdges.set(`IMPORTS:${imp}`, { targetId: imp, relationType: 'IMPORTS' });
  }
  for (const binding of namedImportBindings) {
    uniqueEdges.set(`IMPORTS:${binding}`, { targetId: binding, relationType: 'IMPORTS' });
  }
  for (const call of calls) {
    uniqueEdges.set(`CALLS:${call}`, { targetId: call, relationType: 'CALLS' });
  }
  const edges = Array.from(uniqueEdges.values());

  return { symbols, edges };
}

export interface SemanticChunk {
  type: string;
  name?: string;
  content: string;
  start_row: number;
  end_row: number;
}

export function chunkCodeWithAST(
  code: string,
  lang: 'typescript' | 'tsx' = 'typescript'
): SemanticChunk[] {
  const sourceFile = ts.createSourceFile(
    lang === 'tsx' ? 'file.tsx' : 'file.ts',
    code,
    ts.ScriptTarget.Latest,
    true
  );

  const chunks: SemanticChunk[] = [];

  function traverseChunk(node: ts.Node) {
    let handled = false;
    const kind = node.kind;
    const isTarget = [
      ts.SyntaxKind.ClassDeclaration,
      ts.SyntaxKind.FunctionDeclaration,
      ts.SyntaxKind.InterfaceDeclaration,
      ts.SyntaxKind.TypeAliasDeclaration,
      ts.SyntaxKind.MethodDeclaration,
    ].includes(kind);

    const isVariableWithFn =
      kind === ts.SyntaxKind.VariableDeclaration &&
      (node as ts.VariableDeclaration).initializer &&
      ((node as ts.VariableDeclaration).initializer?.kind === ts.SyntaxKind.ArrowFunction ||
        (node as ts.VariableDeclaration).initializer?.kind === ts.SyntaxKind.FunctionExpression);

    if (isTarget || isVariableWithFn) {
      let name = 'anonymous';
      if ((node as any).name?.text) {
        name = (node as any).name.text;
      }

      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

      const typeName = ts.SyntaxKind[node.kind];

      chunks.push({
        type: typeName,
        name,
        content: node.getText(sourceFile),
        start_row: start.line + 1,
        end_row: end.line + 1,
      });
      handled = true;
    }

    if (!handled || kind === ts.SyntaxKind.VariableDeclaration) {
      ts.forEachChild(node, traverseChunk);
    }
  }

  ts.forEachChild(sourceFile, traverseChunk);

  if (chunks.length === 0 && code.trim().length > 0) {
    chunks.push({
      type: 'RawCode',
      name: 'root',
      content: code,
      start_row: 1,
      end_row: code.split('\n').length,
    });
  }

  return chunks;
}
