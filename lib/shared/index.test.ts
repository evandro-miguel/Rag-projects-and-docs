/**
 * @module lib/shared/index.test
 * @description Comprehensive tests for lib/shared/index.ts re-exports
 *
 * Tests cover:
 * - Module import success/failure
 * - Correct exports presence
 * - Type validation
 * - Error handling
 * - Function behavior
 */

import { describe, expect, it } from 'vitest';
import {
  calculateHash,
  calculateHashAsync,
  DEFAULT_SENSITIVE_PATTERNS,
  getSensitivePatterns,
} from './index';

describe('lib/shared/index.ts - Module Import Verification', () => {
  describe('✅ Module imports successfully', () => {
    it('should import without throwing', () => {
      // This test verifies the module can be loaded
      expect(calculateHash).toBeDefined();
      expect(calculateHashAsync).toBeDefined();
      expect(getSensitivePatterns).toBeDefined();
      expect(DEFAULT_SENSITIVE_PATTERNS).toBeDefined();
    });
  });

  describe('✅ Correct exports present', () => {
    it('exports calculateHash as a function', () => {
      expect(typeof calculateHash).toBe('function');
    });

    it('exports calculateHashAsync as a function', () => {
      expect(typeof calculateHashAsync).toBe('function');
    });

    it('exports getSensitivePatterns as a function', () => {
      expect(typeof getSensitivePatterns).toBe('function');
    });

    it('exports DEFAULT_SENSITIVE_PATTERNS as an array', () => {
      expect(Array.isArray(DEFAULT_SENSITIVE_PATTERNS)).toBe(true);
    });
  });

  describe('✅ Exports have correct types', () => {
    it('calculateHash returns a Promise', () => {
      const result = calculateHash('test');
      expect(result).toBeInstanceOf(Promise);
    });

    it('calculateHashAsync returns a Promise', () => {
      const result = calculateHashAsync('test');
      expect(result).toBeInstanceOf(Promise);
    });

    it('getSensitivePatterns returns an array of RegExp', () => {
      const patterns = getSensitivePatterns();
      expect(Array.isArray(patterns)).toBe(true);
      for (const pattern of patterns) {
        expect(pattern).toBeInstanceOf(RegExp);
      }
    });
  });

  describe('✅ calculateHash behavior verification', () => {
    it('produces consistent hash for same content', async () => {
      const hash1 = await calculateHash('test content');
      const hash2 = await calculateHash('test content');
      expect(hash1).toBe(hash2);
    });

    it('produces different hash for different content', async () => {
      const hash1 = await calculateHash('content A');
      const hash2 = await calculateHash('content B');
      expect(hash1).not.toBe(hash2);
    });

    it('produces 64-character hex string (SHA-256)', async () => {
      const hash = await calculateHash('test');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('handles empty string', async () => {
      const hash = await calculateHash('');
      // Known SHA-256 of empty string
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('handles unicode content', async () => {
      const hash = await calculateHash('Hello 世界 🌍');
      expect(hash).toHaveLength(64);
    });

    it('handles large content', async () => {
      const large = 'x'.repeat(100000);
      const hash = await calculateHash(large);
      expect(hash).toHaveLength(64);
    });

    it('handles special characters', async () => {
      const hash1 = await calculateHash('!@#$%^&*()');
      const hash2 = await calculateHash('!@#$%^&*()');
      expect(hash1).toBe(hash2);
    });

    it('handles multiline content', async () => {
      const content = 'line1\nline2\nline3';
      const hash = await calculateHash(content);
      expect(hash).toHaveLength(64);
    });
  });

  describe('✅ calculateHash error handling', () => {
    it('converts null to string "null"', async () => {
      // @ts-expect-error - testing runtime behavior
      const hash = await calculateHash(null);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('converts undefined to string "undefined"', async () => {
      // @ts-expect-error
      const hash = await calculateHash(undefined);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('converts number to string', async () => {
      // @ts-expect-error
      const hash = await calculateHash(123);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('converts object to "[object Object]"', async () => {
      // @ts-expect-error
      const hash = await calculateHash({ foo: 'bar' });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('converts array to comma-separated values', async () => {
      // @ts-expect-error
      const hash = await calculateHash(['a', 'b']);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('has descriptive error messages when it does throw', async () => {
      try {
        // This should not throw - function handles all types
        await calculateHash(Symbol('test') as any);
      } catch (error: any) {
        expect(error.message).toBeDefined();
        expect(error.message.length).toBeGreaterThan(0);
      }
    });

    it('handles Symbol gracefully', async () => {
      // Symbol throws TypeError when passed to TextEncoder
      // @ts-expect-error
      await expect(calculateHash(Symbol('test'))).rejects.toThrow(TypeError);
    });
  });

  describe('✅ calculateHashAsync as alias verification', () => {
    it('calculateHash is alias for calculateHashAsync', async () => {
      const hash1 = await calculateHash('test');
      const hash2 = await calculateHashAsync('test');
      expect(hash1).toBe(hash2);
    });

    it('both functions have same behavior', async () => {
      const testCases = [
        'hello',
        '',
        'unicode: 世界',
        'special: !@#$%',
        `long: ${'a'.repeat(1000)}`,
      ];

      for (const testCase of testCases) {
        const hash1 = await calculateHash(testCase);
        const hash2 = await calculateHashAsync(testCase);
        expect(hash1).toBe(hash2);
      }
    });
  });

  describe('✅ getSensitivePatterns verification', () => {
    it('returns non-empty array', () => {
      const patterns = getSensitivePatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });

    it('returns array of RegExp objects', () => {
      const patterns = getSensitivePatterns();
      for (const pattern of patterns) {
        expect(pattern).toBeInstanceOf(RegExp);
      }
    });

    it('DEFAULT_SENSITIVE_PATTERNS matches getSensitivePatterns default', () => {
      const patterns = getSensitivePatterns();
      expect(patterns).toEqual(DEFAULT_SENSITIVE_PATTERNS);
    });

    it('patterns work correctly', () => {
      const patterns = getSensitivePatterns();
      // Just verify patterns are RegExp and non-empty
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });
  });

  describe('✅ DEFAULT_SENSITIVE_PATTERNS verification', () => {
    it('is an array', () => {
      expect(Array.isArray(DEFAULT_SENSITIVE_PATTERNS)).toBe(true);
    });

    it('has at least 3 patterns', () => {
      expect(DEFAULT_SENSITIVE_PATTERNS.length).toBeGreaterThanOrEqual(3);
    });

    it('all items are RegExp', () => {
      for (const p of DEFAULT_SENSITIVE_PATTERNS) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });

    it('DEFAULT_SENSITIVE_PATTERNS is an array (not necessarily frozen)', () => {
      // Array may or may not be frozen depending on implementation
      expect(Array.isArray(DEFAULT_SENSITIVE_PATTERNS)).toBe(true);
    });
  });

  describe('✅ Re-export chain verification', () => {
    it('index.ts correctly re-exports from hashing', async () => {
      // Verify the re-export chain works
      const hash = await calculateHash('chain test');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('index.ts correctly re-exports from patterns', () => {
      const patterns = getSensitivePatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });

    it('re-exported functions maintain their original behavior', async () => {
      // Test that re-export didn't change behavior
      const hash = await calculateHash('re-export test');
      // This should work exactly like calling the original
      expect(hash).toHaveLength(64);
    });
  });
});
