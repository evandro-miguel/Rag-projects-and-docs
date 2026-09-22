/**
 * Deterministic symbol extraction and line-range tests (T-06).
 * Published read models are tested with disposable version-owned fixtures.
 */

import { describe, expect, it } from 'vitest';
import { parseAst } from '../lib/ast-parser.js';

describe('T-06: Symbols, Navigation, and Line Clamping', () => {
  describe('parseAst line-range clamping and function detection', () => {
    it('clamps symbol line ranges strictly to [1, totalLines]', () => {
      const code = 'export function hello() {\n  return "world";\n}\n';
      const result = parseAst('hello.ts', code);
      expect(result.symbols).toHaveLength(1);
      const sym = result.symbols[0];
      expect(sym?.name).toBe('hello');
      expect(sym?.symbolType).toBe('function');
      expect(sym?.startLine).toBeGreaterThanOrEqual(1);
      expect(sym?.endLine).toBeLessThanOrEqual(3);
    });

    it('extracts exported arrow functions as function symbols with signatures', () => {
      const code = 'export const greet = (name: string) => "Hello " + name;\n';
      const result = parseAst('greet.ts', code);
      expect(result.symbols).toHaveLength(1);
      const sym = result.symbols[0];
      expect(sym?.name).toBe('greet');
      expect(sym?.symbolType).toBe('function');
      expect(sym?.signature).toBe('greet = (name: string)');
      expect(sym?.startLine).toBe(1);
      expect(sym?.endLine).toBe(1);
    });

    it('handles multiple declarations in variable statements with accurate start/end lines', () => {
      const code = 'export const a = 1,\n  b = 2;\n';
      const result = parseAst('vars.ts', code);
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]?.name).toBe('a');
      expect(result.symbols[0]?.startLine).toBe(1);
      expect(result.symbols[1]?.name).toBe('b');
      expect(result.symbols[1]?.startLine).toBe(2);
    });

    it('deduplicates parsed edges by (targetId, relationType)', () => {
      const code = `
        import { foo, foo as bar } from './helper.js';
        foo();
        foo();
      `;
      const result = parseAst('test.ts', code);
      const calls = result.edges.filter((e) => e.relationType === 'CALLS' && e.targetId === 'foo');
      expect(calls).toHaveLength(1);

      const imports = result.edges.filter(
        (e) => e.relationType === 'IMPORTS' && e.targetId === './helper.js'
      );
      expect(imports).toHaveLength(1);
    });
  });
});
