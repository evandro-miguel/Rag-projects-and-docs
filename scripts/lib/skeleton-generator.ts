/**
 * @module skeleton-generator
 * @description Generate file skeletons for quick overview without loading full content.
 *
 * This module extracts structural information from source files using AST parsing,
 * producing a compact skeleton format that lists exports, imports, classes,
 * functions, types, and constants.
 *
 * @example
 * // Generate skeleton for a TypeScript file
 * const skeleton = generateSkeleton(sourceCode, 'typescript');
 * // Result:
 * // // exports: Button, ButtonProps, ButtonSize
 * // // imports: React, classNames, useTheme
 * // // classes: Button
 * // // functions: handleClick, render
 * // // types: ButtonProps, ButtonSize
 * // // constants: DEFAULT_SIZE
 */

import { parseAst } from './ast-parser.js';

/**
 * Extract import module names from file content using regex.
 * This is a lightweight alternative to full AST parsing for imports.
 *
 * @param content - File content
 * @returns Array of imported module names
 */
function extractImports(content: string): string[] {
  const imports: string[] = [];

  // Match ES6 imports: import { x } from 'module' or import * as x from 'module'
  const es6ImportRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(es6ImportRegex)) {
    const moduleName = match[1];
    // Extract package name (first part before /)
    const packageName = moduleName.split('/')[0];
    if (packageName && !imports.includes(packageName)) {
      imports.push(packageName);
    }
  }

  // Match CommonJS requires: const x = require('module')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of content.matchAll(requireRegex)) {
    const moduleName = match[1];
    const packageName = moduleName.split('/')[0];
    if (packageName && !imports.includes(packageName)) {
      imports.push(packageName);
    }
  }

  return imports;
}

/**
 * Generate a skeleton representation of a source file.
 *
 * The skeleton format includes:
 * - exports: Named and default exports
 * - imports: Imported modules/packages
 * - classes: Class declarations
 * - functions: Function declarations
 * - types: Interface and type alias declarations
 * - constants: Exported const variables
 *
 * @param content - File content
 * @param lang - Language identifier ('typescript' or 'javascript')
 * @param fileName - Optional file name for AST parsing
 * @returns Skeleton text or null if language not supported
 *
 * @example
 * const skeleton = generateSkeleton(sourceCode, 'typescript', 'Button.tsx');
 * if (skeleton) {
 *   console.log(skeleton);
 * }
 */
export function generateSkeleton(
  content: string,
  lang: string,
  fileName: string = 'file.ts'
): string | null {
  // Only support TypeScript/JavaScript
  if (lang !== 'typescript' && lang !== 'javascript') {
    return null;
  }

  try {
    // Use existing AST parser
    const { symbols } = parseAst(fileName, content);

    // Extract exports (named and default)
    const exports = symbols.filter((s) => s.exportType === 'named' || s.exportType === 'default');

    // Extract imports using regex
    const imports = extractImports(content);

    // Group symbols by type
    const classes = symbols.filter((s) => s.symbolType === 'class');
    const functions = symbols.filter((s) => s.symbolType === 'function');
    const types = symbols.filter((s) => s.symbolType === 'interface' || s.symbolType === 'type');
    const enums = symbols.filter((s) => s.symbolType === 'enum');
    const constants = symbols.filter((s) => s.symbolType === 'variable' && s.exportType !== 'none');

    // Build skeleton lines
    const lines: string[] = [];

    // Exports line
    if (exports.length > 0) {
      const exportNames = exports.map((s) =>
        s.exportType === 'default' ? `${s.name} (default)` : s.name
      );
      lines.push(`// exports: ${exportNames.join(', ')}`);
    }

    // Imports line
    if (imports.length > 0) {
      lines.push(`// imports: ${imports.join(', ')}`);
    }

    // Classes line
    if (classes.length > 0) {
      lines.push(`// classes: ${classes.map((s) => s.name).join(', ')}`);
    }

    // Functions line
    if (functions.length > 0) {
      lines.push(`// functions: ${functions.map((s) => s.name).join(', ')}`);
    }

    // Types line (includes interfaces and type aliases)
    if (types.length > 0) {
      lines.push(`// types: ${types.map((s) => s.name).join(', ')}`);
    }

    // Enums line
    if (enums.length > 0) {
      lines.push(`// enums: ${enums.map((s) => s.name).join(', ')}`);
    }

    // Constants line
    if (constants.length > 0) {
      lines.push(`// constants: ${constants.map((s) => s.name).join(', ')}`);
    }

    // Filter out empty lines (lines with just "// key: ")
    const validLines = lines.filter((line) => !line.includes(': ,') && !line.endsWith(': '));

    return validLines.length > 0 ? validLines.join('\n') : null;
  } catch (error) {
    // If AST parsing fails, return null
    console.warn(
      `Failed to generate skeleton: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Generate skeleton with outline version metadata.
 *
 * This variant includes an outline version for tracking format changes.
 *
 * @param content - File content
 * @param lang - Language identifier
 * @param fileName - Optional file name
 * @returns Object with skeleton text and version
 */
export function generateSkeletonWithVersion(
  content: string,
  lang: string,
  fileName: string = 'file.ts'
): { skeletonText: string | null; outlineVersion: string } {
  const skeletonText = generateSkeleton(content, lang, fileName);
  return {
    skeletonText,
    outlineVersion: '1.0.0', // Version for tracking format changes
  };
}
