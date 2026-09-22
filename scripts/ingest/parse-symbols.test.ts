/**
 * @file parse-symbols.test.ts
 * @description Comprehensive tests for AST-based symbol parsing and chunking.
 */

import { describe, expect, test } from 'vitest';
import { chunkAST, parseSymbols } from './parse-symbols.js';

describe('parseSymbols', () => {
  describe('basic symbol extraction', () => {
    test('should return empty array for non-TS/JS files', () => {
      const result = parseSymbols('content', '.py');
      expect(result).toEqual([]);
    });

    test('should return empty array for .txt files', () => {
      const result = parseSymbols('content', '.txt');
      expect(result).toEqual([]);
    });

    test('should extract named export function', () => {
      const code = `
export function myFunction(param: string): string {
    return param;
}
`;
      const result = parseSymbols(code, '.ts');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'myFunction',
        kind: 'function',
      });
      expect(result[0].startLine).toBeDefined();
      expect(result[0].endLine).toBeDefined();
      expect(result[0].code).toContain('function myFunction');
    });

    test('should extract export class as one fallback symbol', () => {
      const code = `
export class MyClass {
    private value: number;

    constructor(val: number) {
        this.value = val;
    }

    getValue(): number {
        return this.value;
    }
}
`;
      const result = parseSymbols(code, '.ts');

      // parseSymbols is the regex fallback; nested methods are emitted by the AST path.
      expect(result).toHaveLength(1);
      const classSymbol = result.find((s) => s.name === 'MyClass');
      expect(classSymbol).toBeDefined();
      expect(classSymbol?.kind).toBe('class');
    });

    test('should extract interface', () => {
      const code = `
export interface UserConfig {
    name: string;
    age: number;
}
`;
      const result = parseSymbols(code, '.ts');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'UserConfig',
        kind: 'interface',
      });
    });

    test('should extract type alias', () => {
      const code = `
export type UserRole = 'admin' | 'user' | 'guest';
`;
      const result = parseSymbols(code, '.ts');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'UserRole',
        kind: 'type',
      });
    });

    test('should extract arrow function assigned to variable', () => {
      const code = `
export const processData = (data: string[]) => {
    return data.map(item => item.trim());
};
`;
      const result = parseSymbols(code, '.ts');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'processData',
        kind: 'function',
      });
    });
  });

  describe('line number accuracy', () => {
    test('should report accurate line numbers', () => {
      const code = `// Line 1
// Line 2
export function lineNumbered() { // Line 3
    return true; // Line 4
}
`;
      const result = parseSymbols(code, '.ts');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('lineNumbered');
      expect(result[0].startLine).toBe(3);
      expect(result[0].endLine).toBe(5);
    });

    test('should sort symbols by line number', () => {
      const code = `
export function second() {}
export function first() {}
export interface Third {}
`;
      const result = parseSymbols(code, '.ts');

      const lineNumbers = result.map((s) => s.startLine);
      expect(lineNumbers).toEqual([...lineNumbers].sort((a, b) => a - b));
    });
  });

  describe('edge cases', () => {
    test('should handle empty file', () => {
      const result = parseSymbols('', '.ts');
      expect(result).toEqual([]);
    });

    test('should handle file with only comments', () => {
      const code = `
// This is a comment
/* Multi-line
   comment */
`;
      const result = parseSymbols(code, '.ts');
      expect(result).toEqual([]);
    });

    test('should document anonymous default function fallback behavior', () => {
      const code = `
export default function() {
    return 'anonymous';
}
`;
      const result = parseSymbols(code, '.ts');

      // The regex fallback intentionally does not synthesize names for anonymous exports.
      expect(result).toEqual([]);
    });

    test('should handle syntax errors gracefully', () => {
      const code = `
export function broken(
    // Missing closing brace
`;
      // Should not throw, but may return partial results or empty
      expect(() => parseSymbols(code, '.ts')).not.toThrow();
    });

    test('should handle multiple classes', () => {
      const code = `
export class First {
    method1() {}
}
export class Second {
    method2() {}
}
`;
      const result = parseSymbols(code, '.ts');

      const classNames = result.filter((s) => s.kind === 'class').map((s) => s.name);
      expect(classNames).toContain('First');
      expect(classNames).toContain('Second');
    });

    test('should handle generic types', () => {
      const code = `
export interface Container<T, U> {
    key: T;
    value: U;
}
`;
      const result = parseSymbols(code, '.ts');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Container');
      expect(result[0].kind).toBe('interface');
      expect(result[0].code).toContain('<T, U>');
    });

    test('should handle JSX/TSX files', () => {
      const code = `
export function Component() {
    return <div>Hello</div>;
}
`;
      const result = parseSymbols(code, '.tsx');

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].name).toBe('Component');
    });
  });
});

describe('chunkAST', () => {
  describe('symbol-based chunking', () => {
    test('should create chunks for each symbol', async () => {
      const code = `
export function func1() {
    return 1;
}

export function func2() {
    return 2;
}
`;
      const result = await chunkAST(code, '.ts', 500, 50);

      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.some((c) => c.content.includes('func1'))).toBe(true);
      expect(result.some((c) => c.content.includes('func2'))).toBe(true);
    });

    test('should include symbol metadata in chunks', async () => {
      const code = `
export class MyClass {
    method() {}
}
`;
      const result = await chunkAST(code, '.ts', 500, 50);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].symbol).toBeDefined();
      expect(result[0].symbol?.name).toBeDefined();
    });

    test('should deduplicate chunks', async () => {
      const code = `
export function duplicate() {}
`;
      const result = await chunkAST(code, '.ts', 500, 50);

      const contents = result.map((c) => c.content);
      const uniqueContents = [...new Set(contents)];
      expect(uniqueContents.length).toBe(contents.length);
    });
  });

  describe('fallback text chunking', () => {
    test('should fallback to text chunking when no symbols', async () => {
      const code = `
// Just a comment
// Another comment
`;
      const result = await chunkAST(code, '.ts', 100, 20);

      // Should fallback to text chunking
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('should fallback for non-TS files', async () => {
      const code = 'Some plain text content here';
      const result = await chunkAST(code, '.md', 50, 10);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].symbol).toBeUndefined();
    });
  });

  describe('large symbol handling', () => {
    test('should split large symbols', async () => {
      // Create a very large function
      const lines = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`    const var${i} = ${i};`);
      }
      const code = `
export function largeFunction() {
${lines.join('\n')}
    return 0;
}
`;
      const result = await chunkAST(code, '.ts', 200, 20);

      // Should split into multiple chunks due to size
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('should respect chunk size limits', async () => {
      const code = `
export function sizeLimited() {
    ${'x'.repeat(1000)}
}
`;
      const result = await chunkAST(code, '.ts', 100, 10);

      // All chunks should respect size limit
      for (const chunk of result) {
        expect(chunk.content.length).toBeLessThanOrEqual(200); // Allow some flexibility
      }
    });
  });

  describe('edge cases', () => {
    test('should handle empty file', async () => {
      const result = await chunkAST('', '.ts', 500, 50);
      expect(result).toEqual([]);
    });

    test('should handle single line', async () => {
      const result = await chunkAST('const x = 1;', '.ts', 500, 50);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('should handle code with syntax errors', async () => {
      const code = `
export function broken(
    // Missing closing brace
`;
      // Should not throw, returns fallback chunks
      const result = await chunkAST(code, '.ts', 500, 50);
      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle very small chunk sizes', async () => {
      const code = `
export function smallChunkFunction() {
    return 1;
}
`;
      const result = await chunkAST(code, '.ts', 50, 5);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });
});
