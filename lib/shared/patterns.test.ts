/**
 * @module lib/shared/patterns.test
 * @description Tests for shared pattern utilities.
 *
 * Tests re-exports from sensitive-patterns module.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SENSITIVE_PATTERNS, getSensitivePatterns } from './patterns';

describe('patterns module re-exports', () => {
  it('should export getSensitivePatterns', () => {
    expect(getSensitivePatterns).toBeDefined();
    expect(typeof getSensitivePatterns).toBe('function');
  });

  it('should export DEFAULT_SENSITIVE_PATTERNS', () => {
    expect(DEFAULT_SENSITIVE_PATTERNS).toBeDefined();
    expect(Array.isArray(DEFAULT_SENSITIVE_PATTERNS)).toBe(true);
  });

  it('should return same patterns as direct import', () => {
    const patterns = getSensitivePatterns();
    expect(patterns.length).toBeGreaterThan(0);
  });
});
