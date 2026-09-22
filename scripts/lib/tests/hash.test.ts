import { describe, expect, it } from 'vitest';
import { calculateHashAsync } from '../../../lib/shared/hashing.js';

describe('hash utilities', () => {
  describe('calculateHashAsync', () => {
    it('returns a 64-character hex string', async () => {
      const hash = await calculateHashAsync('test content');
      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
    });

    it('returns consistent hash for same input', async () => {
      const content = 'consistent content';
      const hash1 = await calculateHashAsync(content);
      const hash2 = await calculateHashAsync(content);
      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different inputs', async () => {
      const hash1 = await calculateHashAsync('content one');
      const hash2 = await calculateHashAsync('content two');
      expect(hash1).not.toBe(hash2);
    });

    it('handles empty string', async () => {
      const hash = await calculateHashAsync('');
      expect(hash).toHaveLength(64);
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('handles unicode characters', async () => {
      const hash = await calculateHashAsync('こんにちは世界 🌍');
      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
    });

    it('handles large input', async () => {
      const largeContent = 'x'.repeat(100000);
      const hash = await calculateHashAsync(largeContent);
      expect(hash).toHaveLength(64);
    });

    it('produces correct SHA-256 hash for known input', async () => {
      // SHA-256 of "hello world" - known value
      const hash = await calculateHashAsync('hello world');
      expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });

    it('handles special characters', async () => {
      const hash = await calculateHashAsync('!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`');
      expect(hash).toHaveLength(64);
    });

    it('handles newlines and whitespace', async () => {
      const hash = await calculateHashAsync('line1\nline2\r\nline3\ttabbed');
      expect(hash).toHaveLength(64);
    });
  });
});
