/**
 * @module lib/shared/hashing.test
 * @description Tests for shared hashing utilities.
 *
 * Tests SHA-256 hashing functionality.
 */

import { describe, expect, it } from 'vitest';
import { calculateHash, calculateHashAsync } from './hashing';

describe('calculateHashAsync', () => {
  it('should generate a SHA-256 hash for a string', async () => {
    const content = 'Hello, World!';
    const hash = await calculateHashAsync(content);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64); // SHA-256 produces 64 hex characters
    expect(hash).toMatch(/^[0-9a-f]+$/); // Should be hexadecimal
  });

  it('should generate consistent hashes for the same input', async () => {
    const content = 'test content';
    const hash1 = await calculateHashAsync(content);
    const hash2 = await calculateHashAsync(content);

    expect(hash1).toBe(hash2);
  });

  it('should generate different hashes for different inputs', async () => {
    const hash1 = await calculateHashAsync('input1');
    const hash2 = await calculateHashAsync('input2');

    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty strings', async () => {
    const hash = await calculateHashAsync('');

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
    // SHA-256 of empty string is a known value
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('should handle unicode characters', async () => {
    const content = 'Hello, 世界！🌍';
    const hash = await calculateHashAsync(content);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });

  it('should handle very long strings', async () => {
    const content = 'a'.repeat(10000);
    const hash = await calculateHashAsync(content);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });

  it('should handle special characters', async () => {
    const content = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\`~';
    const hash = await calculateHashAsync(content);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });

  it('should handle multiline strings', async () => {
    const content = `Line 1
Line 2
Line 3`;
    const hash = await calculateHashAsync(content);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });

  it('should be case-sensitive', async () => {
    const hash1 = await calculateHashAsync('Hello');
    const hash2 = await calculateHashAsync('hello');

    expect(hash1).not.toBe(hash2);
  });

  it('should handle whitespace differences', async () => {
    const hash1 = await calculateHashAsync('test');
    const hash2 = await calculateHashAsync('test ');
    const hash3 = await calculateHashAsync(' test');

    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash2).not.toBe(hash3);
  });
});

describe('calculateHash (alias)', () => {
  it('should be the same as calculateHashAsync', () => {
    expect(calculateHash).toBe(calculateHashAsync);
  });

  it('should work as an async function', async () => {
    const hash = await calculateHash('test');
    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });
});

describe('Hash format validation', () => {
  it('should produce valid hexadecimal strings', async () => {
    const testCases = ['test1', 'test2', 'test3', 'unique content 1', 'unique content 2'];

    for (const content of testCases) {
      const hash = await calculateHashAsync(content);
      // Verify it's valid hex
      expect(() => parseInt(hash, 16)).not.toThrow();
      // Verify length
      expect(hash).toHaveLength(64);
    }
  });

  it('should produce hashes that can be used as object keys', async () => {
    const hash1 = await calculateHashAsync('key1');
    const hash2 = await calculateHashAsync('key2');

    const hashMap: Record<string, string> = {};
    hashMap[hash1] = 'value1';
    hashMap[hash2] = 'value2';

    expect(hashMap[hash1]).toBe('value1');
    expect(hashMap[hash2]).toBe('value2');
  });
});

describe('Performance characteristics', () => {
  it('should hash small strings quickly (< 10ms)', async () => {
    const start = Date.now();
    await calculateHashAsync('small string');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10);
  });

  it('should hash large strings reasonably (< 100ms)', async () => {
    const largeString = 'x'.repeat(100000); // 100KB
    const start = Date.now();
    await calculateHashAsync(largeString);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it('should handle concurrent hash operations', async () => {
    const inputs = Array(10)
      .fill(null)
      .map((_, i) => `input-${i}`);

    const hashes = await Promise.all(inputs.map((input) => calculateHashAsync(input)));

    expect(hashes).toHaveLength(10);
    expect(new Set(hashes).size).toBe(10); // All should be unique
  });
});

describe('Edge cases', () => {
  it('should handle null-like values when stringified', async () => {
    // Note: These will be stringified by TextEncoder
    const hashNull = await calculateHashAsync(String(null));
    const hashUndefined = await calculateHashAsync(String(undefined));

    expect(hashNull).toBeDefined();
    expect(hashUndefined).toBeDefined();
    expect(hashNull).not.toBe(hashUndefined);
  });

  it('should handle numbers as strings', async () => {
    const hash1 = await calculateHashAsync('123');
    const hash2 = await calculateHashAsync('123');

    expect(hash1).toBe(hash2);
  });

  it('should handle JSON strings', async () => {
    const json = JSON.stringify({ key: 'value', number: 42 });
    const hash = await calculateHashAsync(json);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });

  it('should handle base64 strings', async () => {
    const base64 = 'SGVsbG8sIFdvcmxkIQ==';
    const hash = await calculateHashAsync(base64);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });

  it('should handle emoji-only strings', async () => {
    const emoji = '😀🎉🚀💻';
    const hash = await calculateHashAsync(emoji);

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
  });

  it('should handle whitespace-only strings', async () => {
    const hash1 = await calculateHashAsync(' ');
    const hash2 = await calculateHashAsync('  ');
    const hash3 = await calculateHashAsync('\t');
    const hash4 = await calculateHashAsync('\n');

    expect(hash1).toBeDefined();
    expect(hash2).toBeDefined();
    expect(hash3).toBeDefined();
    expect(hash4).toBeDefined();
    expect(new Set([hash1, hash2, hash3, hash4]).size).toBe(4); // All different
  });
});
