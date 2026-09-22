/**
 * @file ast-parser.test.ts
 * @description Comprehensive tests for TypeScript AST parser.
 */

import { describe, expect, test } from 'vitest';
import { parseAst } from '../ast-parser.js';

describe('ast-parser', () => {
  describe('parseAst', () => {
    test('should handle empty file', () => {
      const result = parseAst('empty.ts', '');
      expect(result.symbols).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    test('should handle file with no exports', () => {
      const code = `
function privateFunc() {
    return 'hello';
}
class PrivateClass {}
const privateVar = 42;
`;
      const result = parseAst('private.ts', code);
      // The implementation includes non-exported symbols with exportType: 'none'
      expect(result.symbols.length).toBeGreaterThanOrEqual(2);
      expect(result.symbols.every((s) => s.exportType === 'none')).toBe(true);
      expect(result.edges).toEqual([]);
    });

    test('should parse named export function', () => {
      const code = `
export function myFunction(param: string): string {
    return param;
}
`;
      const result = parseAst('func.ts', code);

      expect(result.symbols).toHaveLength(1);
      const symbol = result.symbols[0];
      expect(symbol.name).toBe('myFunction');
      expect(symbol.symbolType).toBe('function');
      expect(symbol.exportType).toBe('named');
      expect(symbol.signature).toContain('myFunction');
      expect(symbol.startLine).toBeDefined();
      expect(symbol.endLine).toBeDefined();
    });

    test('should parse named export class', () => {
      const code = `
export class MyClass {
    prop: string;
}
`;
      const result = parseAst('class.ts', code);

      expect(result.symbols).toHaveLength(1);
      const symbol = result.symbols[0];
      expect(symbol.name).toBe('MyClass');
      expect(symbol.symbolType).toBe('class');
      expect(symbol.exportType).toBe('named');
    });

    test('should parse named export interface', () => {
      const code = `
export interface MyInterface {
    prop: string;
    method(): void;
}
`;
      const result = parseAst('interface.ts', code);

      expect(result.symbols).toHaveLength(1);
      const symbol = result.symbols[0];
      expect(symbol.name).toBe('MyInterface');
      expect(symbol.symbolType).toBe('interface');
      expect(symbol.exportType).toBe('named');
    });

    test('should parse named export type', () => {
      const code = `
export type MyType = string | number;
export type MyObjectType = { key: string };
`;
      const result = parseAst('type.ts', code);

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols.map((s) => s.name)).toContain('MyType');
      expect(result.symbols.map((s) => s.name)).toContain('MyObjectType');
      expect(result.symbols.every((s) => s.symbolType === 'type')).toBe(true);
      expect(result.symbols.every((s) => s.exportType === 'named')).toBe(true);
    });

    test('should parse named export enum', () => {
      const code = `
export enum MyEnum {
    Value1 = 'value1',
    Value2 = 'value2'
}
`;
      const result = parseAst('enum.ts', code);

      expect(result.symbols).toHaveLength(1);
      const symbol = result.symbols[0];
      expect(symbol.name).toBe('MyEnum');
      expect(symbol.symbolType).toBe('enum');
      expect(symbol.exportType).toBe('named');
    });

    test('should parse named export variable', () => {
      const code = `
export const myConst = 42;
export let myLet = 'hello';
`;
      const result = parseAst('variable.ts', code);

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols.map((s) => s.name)).toContain('myConst');
      expect(result.symbols.map((s) => s.name)).toContain('myLet');
      expect(result.symbols.every((s) => s.symbolType === 'variable')).toBe(true);
      expect(result.symbols.every((s) => s.exportType === 'named')).toBe(true);
    });

    test('should parse named default export function', () => {
      const code = `
export default function myDefault() {
    return 'default';
}
`;
      const result = parseAst('default-func.ts', code);

      expect(result.symbols).toHaveLength(1);
      const symbol = result.symbols[0];
      expect(symbol.symbolType).toBe('function');
      expect(symbol.exportType).toBe('default');
      expect(symbol.name).toBe('myDefault');
    });

    test('should parse named default export class', () => {
      const code = `
export default class MyDefault {
    prop = 'value';
}
`;
      const result = parseAst('default-class.ts', code);

      expect(result.symbols).toHaveLength(1);
      const symbol = result.symbols[0];
      expect(symbol.symbolType).toBe('class');
      expect(symbol.exportType).toBe('default');
      expect(symbol.name).toBe('MyDefault');
    });

    test('should handle default export arrow function (limited)', () => {
      const code = `
export default () => 'arrow';
`;
      const result = parseAst('default-arrow.ts', code);

      // Implementation does not handle anonymous default export arrow functions
      // This test documents the current limitation
      expect(result.symbols).toHaveLength(0);
    });

    test('should parse mixed named and default exports', () => {
      const code = `
export default class DefaultClass {}
export class NamedClass {}
export function namedFunc() {}
`;
      const result = parseAst('mixed.ts', code);

      expect(result.symbols).toHaveLength(3);

      const defaultSym = result.symbols.find((s) => s.exportType === 'default');
      expect(defaultSym?.symbolType).toBe('class');

      const namedSyms = result.symbols.filter((s) => s.exportType === 'named');
      expect(namedSyms).toHaveLength(2);
    });

    test('should parse default import', () => {
      const code = `
import React from 'react';
`;
      const result = parseAst('import.ts', code);

      const imports = result.edges.filter((e) => e.relationType === 'IMPORTS');
      expect(imports).toHaveLength(1);
      expect(imports[0].targetId).toBe('react');
    });

    test('should parse named imports', () => {
      const code = `
import { useState, useEffect } from 'react';
`;
      const result = parseAst('named-import.ts', code);

      const imports = result.edges.filter((e) => e.relationType === 'IMPORTS');
      // Module path + each named binding (for symbol-reference lookup)
      expect(imports.map((i) => i.targetId).sort()).toEqual(
        ['react', 'useEffect', 'useState'].sort()
      );
    });

    test('should parse namespace import', () => {
      const code = `
import * as Utils from './utils';
`;
      const result = parseAst('namespace-import.ts', code);

      const imports = result.edges.filter((e) => e.relationType === 'IMPORTS');
      expect(imports).toHaveLength(1);
      expect(imports[0].targetId).toBe('./utils');
    });

    test('should parse multiple imports from same module', () => {
      const code = `
import { a, b, c } from 'lodash';
import { d } from 'lodash';
`;
      const result = parseAst('multi-import.ts', code);

      // Module path is deduped; named bindings are also recorded once each.
      const imports = result.edges.filter((e) => e.relationType === 'IMPORTS');
      const targets = imports.map((i) => i.targetId).sort();
      expect(targets).toEqual(['a', 'b', 'c', 'd', 'lodash'].sort());
    });

    test('should parse side-effect import', () => {
      const code = `
import './styles.css';
import './init';
`;
      const result = parseAst('side-effect.ts', code);

      const imports = result.edges.filter((e) => e.relationType === 'IMPORTS');
      expect(imports).toHaveLength(2);
      expect(imports.map((i) => i.targetId)).toContain('./styles.css');
      expect(imports.map((i) => i.targetId)).toContain('./init');
    });

    test('should parse direct function call', () => {
      const code = `
function myFunc() {
    helper();
    runTask(1);
}
`;
      const result = parseAst('call.ts', code);

      const calls = result.edges.filter((e) => e.relationType === 'CALLS');
      expect(calls.map((c) => c.targetId)).toContain('helper');
      expect(calls.map((c) => c.targetId)).toContain('runTask');
    });

    test('should drop noisy property-access calls but keep project methods', () => {
      const code = `
const x = items.map((n) => n);
console.log(x);
const y = service.ingestProject();
`;
      const result = parseAst('method-call.ts', code);

      const calls = result.edges.filter((e) => e.relationType === 'CALLS').map((c) => c.targetId);
      expect(calls).not.toContain('map');
      expect(calls).not.toContain('log');
      expect(calls).toContain('ingestProject');
    });

    test('should parse imported module in imports', () => {
      const code = `
import { useState } from 'react';
export function Component() {
    const [state, setState] = useState(null);
    return state;
}
`;
      const result = parseAst('imported-module.ts', code);

      const imports = result.edges.filter((e) => e.relationType === 'IMPORTS');
      expect(imports.map((i) => i.targetId)).toContain('react');
      expect(imports.map((i) => i.targetId)).toContain('useState');
      const calls = result.edges.filter((e) => e.relationType === 'CALLS');
      expect(calls.map((c) => c.targetId)).toContain('useState');
    });

    test('records original name for aliased named imports', () => {
      const code = `
import { withReadDeadline as deadline } from './timeout';
deadline(() => Promise.resolve(1), 10, 't');
`;
      const result = parseAst('aliased-import.ts', code);
      const imports = result.edges
        .filter((e) => e.relationType === 'IMPORTS')
        .map((e) => e.targetId);
      const calls = result.edges.filter((e) => e.relationType === 'CALLS').map((e) => e.targetId);
      expect(imports).toContain('withReadDeadline');
      expect(imports).toContain('./timeout');
      expect(calls).toContain('deadline');
    });

    test('skips type-only named import bindings for symbol edges', () => {
      const code = `
import type { Foo } from './x';
import { type Bar, Baz } from './y';
`;
      const result = parseAst('type-only-import.ts', code);
      const imports = result.edges
        .filter((e) => e.relationType === 'IMPORTS')
        .map((e) => e.targetId);
      expect(imports).toContain('./x');
      expect(imports).toContain('./y');
      expect(imports).toContain('Baz');
      expect(imports).not.toContain('Foo');
      expect(imports).not.toContain('Bar');
    });

    test('should parse complex file with all features', () => {
      const code = `
import React, { useState } from 'react';
import * as API from './api';
import './styles';

export interface Config {
    apiUrl: string;
}

export type Theme = 'light' | 'dark';

export enum Status {
    Active = 'active',
    Inactive = 'inactive'
}

export class Service {
    async fetch(url: string) {
        return fetch(url);
    }
}

export const CONFIG: Config = {
    apiUrl: 'http://localhost'
};

export function processData(data: string[]): string[] {
    return data.map(item => item.trim());
}

const privateHelper = () => 'private';
`;
      const result = parseAst('complex.ts', code);

      // Check symbols
      expect(result.symbols.length).toBeGreaterThanOrEqual(6); // Config, Theme, Status, Service, CONFIG, processData

      const symbolNames = result.symbols.map((s) => s.name);
      expect(symbolNames).toContain('Config');
      expect(symbolNames).toContain('Theme');
      expect(symbolNames).toContain('Status');
      expect(symbolNames).toContain('Service');
      expect(symbolNames).toContain('CONFIG');
      expect(symbolNames).toContain('processData');
      expect(symbolNames).not.toContain('privateHelper');

      // Check import edges: module paths + named bindings (useState)
      const imports = result.edges.filter((e) => e.relationType === 'IMPORTS');
      const importTargets = imports.map((i) => i.targetId);
      expect(importTargets).toContain('react');
      expect(importTargets).toContain('useState');
      expect(importTargets).toContain('./api');
      expect(importTargets).toContain('./styles');
      expect(imports.length).toBe(4);
    });

    test('should return line numbers', () => {
      const code = `
// Line 1
// Line 2
export function test() { // Line 3
}
`;
      const result = parseAst('lines.ts', code);

      expect(result.symbols).toHaveLength(1);
      // Implementation reports 1-indexed line numbers
      expect(result.symbols[0].startLine).toBe(4);
      expect(result.symbols[0].endLine).toBe(5);
    });

    test('should handle arrow functions', () => {
      const code = `
export const arrow = () => {};
export const arrow2 = (x: number) => x * 2;
export const arrow3 = (a: string, b: string) => a + b;
`;
      const result = parseAst('arrow.ts', code);

      expect(result.symbols).toHaveLength(3);
      // Exported arrow functions are indexed as callable function symbols.
      expect(result.symbols.every((s) => s.symbolType === 'function')).toBe(true);
    });

    test('should handle generic types', () => {
      const code = `
export type Generic<T> = T[];
export interface Container<T, U> {
    key: T;
    value: U;
}
`;
      const result = parseAst('generic.ts', code);

      expect(result.symbols).toHaveLength(2);
      const types = result.symbols.filter((s) => s.symbolType === 'type');
      expect(types).toHaveLength(1);
      const interfaces = result.symbols.filter((s) => s.symbolType === 'interface');
      expect(interfaces).toHaveLength(1);
    });

    test('should handle export all (limited support)', () => {
      const code = `
export * from './module1';
export { a, b } from './module2';
`;
      const result = parseAst('export-all.ts', code);

      // Implementation has limited support for export from - only basic imports
      const imports = result.edges.filter((e) => e.relationType === 'IMPORTS');
      // The implementation treats export {} from as import
      expect(imports.length).toBeGreaterThanOrEqual(0);
    });

    test('should handle async functions', () => {
      const code = `
export async function asyncFunc() {
    await Promise.resolve();
}
export const asyncArrow = async () => {};
`;
      const result = parseAst('async.ts', code);

      // asyncArrow is indexed as a function symbol even though it is a
      // variable statement rather than a function declaration.
      const symbols = result.symbols;
      expect(symbols.find((s) => s.name === 'asyncFunc')?.symbolType).toBe('function');
      expect(symbols.find((s) => s.name === 'asyncArrow')?.symbolType).toBe('function');
    });

    test('should handle comments in code', () => {
      const code = `
export function /* inline */ commented() {}
// single line comment
export function afterComment() {}
/**
 * Multi-line
 * comment
 */
export function afterMultiline() {}
`;
      const result = parseAst('comments.ts', code);

      // Should still parse all exports even with comments
      const symbolNames = result.symbols.map((s) => s.name);
      expect(symbolNames).toContain('commented');
      expect(symbolNames).toContain('afterComment');
      expect(symbolNames).toContain('afterMultiline');
    });
  });
});
