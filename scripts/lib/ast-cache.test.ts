/**
 * @module ast-cache.test
 * @description Tests for AST cache utilities
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  calculateFileHash,
  clearCache,
  getCachedFilePaths,
  getCacheStats,
  invalidateCache,
  isCacheValid,
  pruneCache,
  readAstCache,
  writeAstCache,
} from './ast-cache.js';

describe('ast-cache', () => {
  let tempDir: string;
  let cacheDir: string;
  let testFile: string;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-cache-test-'));
    cacheDir = path.join(tempDir, 'cache');
    testFile = path.join(tempDir, 'test.ts');

    // Create test file
    await fs.writeFile(
      testFile,
      `function greet(name: string) {
  return \`Hello, \${name}!\`;
}

class Greeter {
  greet(name: string) {
    return \`Hello, \${name}!\`;
  }
}`,
      'utf-8'
    );

    // Ensure cache directory exists
    await fs.mkdir(cacheDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('calculateFileHash', () => {
    it('should calculate consistent hash for file content', async () => {
      const hash1 = await calculateFileHash(testFile);
      const hash2 = await calculateFileHash(testFile);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex length
    });

    it('should return different hash for different content', async () => {
      const hash1 = await calculateFileHash(testFile);

      // Modify file
      await fs.writeFile(testFile, 'different content', 'utf-8');

      const hash2 = await calculateFileHash(testFile);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('writeAstCache and readAstCache', () => {
    it('should write and read cache entry', async () => {
      const hash = await calculateFileHash(testFile);
      const entry = {
        hash,
        mtime: Date.now(),
        symbols: [
          { name: 'greet', kind: 'function', line: 1, endLine: 3, signature: 'function greet' },
          { name: 'Greeter', kind: 'class', line: 5, endLine: 9, signature: 'class Greeter' },
        ],
        chunks: [
          {
            symbolName: 'greet',
            kind: 'function',
            content: 'function greet(name: string) { ... }',
            line: 1,
            endLine: 3,
          },
        ],
      };

      await writeAstCache(testFile, entry, cacheDir);

      const read = await readAstCache(testFile, cacheDir);
      expect(read).not.toBeNull();
      expect(read?.filePath).toBe(testFile);
      expect(read?.hash).toBe(hash);
      expect(read?.symbols).toHaveLength(2);
      expect(read?.chunks).toHaveLength(1);
    });

    it('should return null for non-existent cache entry', async () => {
      const nonExistentFile = path.join(tempDir, 'nonexistent.ts');
      const result = await readAstCache(nonExistentFile, cacheDir);
      expect(result).toBeNull();
    });
  });

  describe('isCacheValid', () => {
    it('should return true for valid cache', async () => {
      const hash = await calculateFileHash(testFile);
      const entry = {
        hash,
        mtime: Date.now(),
        symbols: [],
        chunks: [],
      };

      await writeAstCache(testFile, entry, cacheDir);

      const valid = await isCacheValid(testFile, hash);
      expect(valid).toBe(true);
    });

    it('should return false for invalid cache (file changed)', async () => {
      const hash = await calculateFileHash(testFile);
      const entry = {
        hash,
        mtime: Date.now(),
        symbols: [],
        chunks: [],
      };

      await writeAstCache(testFile, entry, cacheDir);

      // Modify file
      await fs.writeFile(testFile, 'different content', 'utf-8');

      const valid = await isCacheValid(testFile, hash);
      expect(valid).toBe(false);
    });

    it('should return false for non-existent file', async () => {
      const nonExistentFile = path.join(tempDir, 'nonexistent.ts');
      const valid = await isCacheValid(nonExistentFile, 'somehash');
      expect(valid).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should remove all cache entries', async () => {
      const hash = await calculateFileHash(testFile);
      const entry = {
        hash,
        mtime: Date.now(),
        symbols: [],
        chunks: [],
      };

      await writeAstCache(testFile, entry, cacheDir);

      // Verify entry exists
      const before = await readAstCache(testFile, cacheDir);
      expect(before).not.toBeNull();

      // Clear cache
      await clearCache(cacheDir);

      // Verify entry is gone
      const after = await readAstCache(testFile, cacheDir);
      expect(after).toBeNull();
    });
  });

  describe('getCachedFilePaths', () => {
    it('should return all cached file paths', async () => {
      const file1 = path.join(tempDir, 'file1.ts');
      const file2 = path.join(tempDir, 'file2.ts');

      await fs.writeFile(file1, 'content1', 'utf-8');
      await fs.writeFile(file2, 'content2', 'utf-8');

      const hash1 = await calculateFileHash(file1);
      const hash2 = await calculateFileHash(file2);

      const entry = {
        hash: hash1,
        mtime: Date.now(),
        symbols: [],
        chunks: [],
      };

      await writeAstCache(file1, entry, cacheDir);
      await writeAstCache(file2, { ...entry, hash: hash2 }, cacheDir);

      const paths = await getCachedFilePaths(cacheDir);
      expect(paths).toHaveLength(2);
      expect(paths).toContain(file1);
      expect(paths).toContain(file2);
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', async () => {
      const hash = await calculateFileHash(testFile);
      const entry = {
        hash,
        mtime: Date.now(),
        symbols: [],
        chunks: [],
      };

      await writeAstCache(testFile, entry, cacheDir);

      const stats = await getCacheStats(cacheDir);
      expect(stats.totalEntries).toBe(1);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.oldestEntry).toBeInstanceOf(Date);
      expect(stats.newestEntry).toBeInstanceOf(Date);
    });

    it('should return zero stats for empty cache', async () => {
      const stats = await getCacheStats(cacheDir);
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });
  });

  describe('pruneCache', () => {
    it('should remove invalid entries', async () => {
      const hash = await calculateFileHash(testFile);
      const entry = {
        hash,
        mtime: Date.now(),
        symbols: [],
        chunks: [],
      };

      await writeAstCache(testFile, entry, cacheDir);

      // Modify file to invalidate cache
      await fs.writeFile(testFile, 'different content', 'utf-8');

      const removed = await pruneCache(cacheDir);
      expect(removed).toBe(1);

      const after = await readAstCache(testFile, cacheDir);
      expect(after).toBeNull();
    });
  });

  describe('invalidateCache', () => {
    it('should remove specific cache entry', async () => {
      const hash = await calculateFileHash(testFile);
      const entry = {
        hash,
        mtime: Date.now(),
        symbols: [],
        chunks: [],
      };

      await writeAstCache(testFile, entry, cacheDir);

      // Verify entry exists
      const before = await readAstCache(testFile, cacheDir);
      expect(before).not.toBeNull();

      // Invalidate specific entry
      await invalidateCache(testFile, cacheDir);

      // Verify entry is gone
      const after = await readAstCache(testFile, cacheDir);
      expect(after).toBeNull();
    });
  });
});
