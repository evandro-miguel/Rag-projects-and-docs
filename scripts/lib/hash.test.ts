/**
 * @module scripts/lib/hash.test
 * @description Tests for hash utility re-export in scripts/lib
 *
 * Verifies re-export from shared hashing module.
 */

import { describe, expect, it } from 'vitest';
import { calculateHash } from './hash';

describe('calculateHash (scripts/lib hash re-export)', () => {
  it('should be exported from scripts/lib/hash', () => {
    expect(calculateHash).toBeDefined();
    expect(typeof calculateHash).toBe('function');
  });

  it('should hash strings correctly', async () => {
    const hash = await calculateHash('test');

    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('should produce consistent hashes', async () => {
    const hash1 = await calculateHash('consistent test');
    const hash2 = await calculateHash('consistent test');

    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different content', async () => {
    const hash1 = await calculateHash('content 1');
    const hash2 = await calculateHash('content 2');

    expect(hash1).not.toBe(hash2);
  });

  it('should be the same function as from shared module', async () => {
    // Import from shared to compare
    const { calculateHashAsync: sharedHash } = await import('../../lib/shared/hashing.js');

    expect(calculateHash).toBe(sharedHash);
  });
});
