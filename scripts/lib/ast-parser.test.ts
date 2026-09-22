import { describe, expect, test } from 'vitest';
import { chunkCodeWithAST } from './ast-parser.js';

describe('AST Parser', () => {
  test('extracts function and class from typescript codebase', () => {
    const code = `
      export class TestParser {
        constructor() {}
        public run() { return true; }
      }

      function doSomething() {
        return false;
      }

      const inlineFn = () => {};
    `;

    const chunks = chunkCodeWithAST(code, 'typescript');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.name === 'TestParser' && c.type === 'ClassDeclaration')).toBe(true);
    expect(chunks.some((c) => c.name === 'doSomething' && c.type === 'FunctionDeclaration')).toBe(
      true
    );
    expect(chunks.some((c) => c.name === 'inlineFn' && c.type === 'VariableDeclaration')).toBe(
      true
    );
  });
});
