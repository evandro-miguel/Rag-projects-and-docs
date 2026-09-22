/**
 * Tests for scripts/lib/hash - Hash utility re-exports
 */

import { describe, expect, it } from 'vitest';
import { calculateHash } from '../hash.js';

describe('scripts/lib/hash', () => {
  describe('calculateHash', () => {
    it('exports calculateHash function', () => {
      expect(calculateHash).toBeDefined();
      expect(typeof calculateHash).toBe('function');
    });

    it('calculates consistent SHA-256 hash', async () => {
      const hash = await calculateHash('test content');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns same hash for same input', async () => {
      const hash1 = await calculateHash('consistent input');
      const hash2 = await calculateHash('consistent input');
      expect(hash1).toBe(hash2);
    });

    it('returns different hash for different input', async () => {
      const hash1 = await calculateHash('input one');
      const hash2 = await calculateHash('input two');
      expect(hash1).not.toBe(hash2);
    });

    it('handles empty string', async () => {
      const hash = await calculateHash('');
      expect(hash).toHaveLength(64);
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('handles unicode characters', async () => {
      const hash = await calculateHash('日本語テキスト 🎌');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
