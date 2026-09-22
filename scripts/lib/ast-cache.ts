/**
 * @module ast-cache
 * @description AST preprocessing cache for code files.
 *
 * Provides hash-based cache invalidation for preprocessed AST data.
 * Uses content hashing to determine when files need reprocessing.
 *
 * @example
 * // Read cached data
 * const cached = await readAstCache('/path/to/file.ts', cacheDir);
 * if (cached && await isCacheValid('/path/to/file.ts', cached.hash)) {
 *   return cached.data;
 * }
 *
 * // Process and cache
 * const ast = await extractSymbols(code, '.ts');
 * await writeAstCache('/path/to/file.ts', { symbols: ast, hash }, cacheDir);
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { calculateHash } from './hash.js';

/**
 * AST symbol chunk with content.
 */
export interface AstSymbolChunk {
  /** Symbol name */
  symbolName: string;
  /** Symbol kind */
  kind: string;
  /** Chunk content */
  content: string;
  /** Start line (1-indexed) */
  line: number;
  /** End line (1-indexed) */
  endLine: number;
}

/**
 * Extracted symbol information.
 */
export interface AstSymbol {
  /** Symbol name */
  name: string;
  /** Symbol kind (function, class, etc.) */
  kind: string;
  /** Start line (1-indexed) */
  line: number;
  /** End line (1-indexed) */
  endLine: number;
  /** First line of the symbol (signature) */
  signature: string;
}

/**
 * Cached AST data for a file.
 */
export interface AstCacheEntry {
  /** Absolute file path */
  filePath: string;
  /** SHA-256 hash of file content */
  hash: string;
  /** Last modified time */
  mtime: number;
  /** Extracted symbols */
  symbols: AstSymbol[];
  /** Symbol chunks with content */
  chunks: AstSymbolChunk[];
}

/**
 * Cache metadata file structure.
 */
interface CacheMetadata {
  version: string;
  entries: Record<string, AstCacheEntry>;
}

const CACHE_VERSION = '1.0.0';
const METADATA_FILE = 'metadata.json';

/**
 * Get the path to the cache metadata file.
 */
function getMetadataPath(cacheDir: string): string {
  return path.join(cacheDir, METADATA_FILE);
}

/**
 * Get the cache key for a file path.
 */
function getCacheKey(filePath: string): string {
  // Normalize path separators and remove leading slashes
  return filePath.replace(/\\/g, '/').replace(/^\//, '');
}

/**
 * Load cache metadata from disk.
 */
async function loadMetadata(cacheDir: string): Promise<CacheMetadata> {
  const metadataPath = getMetadataPath(cacheDir);

  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const parsed = JSON.parse(content) as CacheMetadata;

    // Validate version
    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }

    return parsed;
  } catch {
    // File doesn't exist or is invalid
    return { version: CACHE_VERSION, entries: {} };
  }
}

/**
 * Save cache metadata to disk.
 */
async function saveMetadata(cacheDir: string, metadata: CacheMetadata): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const metadataPath = getMetadataPath(cacheDir);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * Calculate hash for file content.
 *
 * @param filePath - Path to the file
 * @returns SHA-256 hash of file content
 */
export async function calculateFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8');
  return await calculateHash(content);
}

/**
 * Read cached AST data for a file.
 *
 * @param filePath - Path to the source file
 * @param cacheDir - Directory where cache is stored
 * @returns Cached entry or null if not found
 */
export async function readAstCache(
  filePath: string,
  cacheDir: string
): Promise<AstCacheEntry | null> {
  const metadata = await loadMetadata(cacheDir);
  const key = getCacheKey(filePath);
  const entry = metadata.entries[key];

  if (!entry) {
    return null;
  }

  return entry;
}

/**
 * Check if cache is still valid by comparing hashes.
 *
 * @param filePath - Path to the source file
 * @param cachedHash - Hash stored in cache
 * @returns True if cache is valid
 */
export async function isCacheValid(filePath: string, cachedHash: string): Promise<boolean> {
  try {
    const currentHash = await calculateFileHash(filePath);
    return currentHash === cachedHash;
  } catch {
    return false;
  }
}

/**
 * Check if cache entry exists and is valid.
 *
 * @param filePath - Path to the source file
 * @param cacheDir - Directory where cache is stored
 * @returns True if valid cache exists
 */
export async function hasValidCache(filePath: string, cacheDir: string): Promise<boolean> {
  const entry = await readAstCache(filePath, cacheDir);
  if (!entry) {
    return false;
  }
  return await isCacheValid(filePath, entry.hash);
}

/**
 * Write AST data to cache.
 *
 * @param filePath - Path to the source file
 * @param entry - AST cache entry to store
 * @param cacheDir - Directory where cache is stored
 */
export async function writeAstCache(
  filePath: string,
  entry: Omit<AstCacheEntry, 'filePath'>,
  cacheDir: string
): Promise<void> {
  const metadata = await loadMetadata(cacheDir);
  const key = getCacheKey(filePath);

  metadata.entries[key] = {
    ...entry,
    filePath,
  };

  await saveMetadata(cacheDir, metadata);
}

/**
 * Invalidate cache entry for a file.
 *
 * @param filePath - Path to the source file
 * @param cacheDir - Directory where cache is stored
 */
export async function invalidateCache(filePath: string, cacheDir: string): Promise<void> {
  const metadata = await loadMetadata(cacheDir);
  const key = getCacheKey(filePath);

  delete metadata.entries[key];
  await saveMetadata(cacheDir, metadata);
}

/**
 * Clear all cache entries.
 *
 * @param cacheDir - Directory where cache is stored
 */
export async function clearCache(cacheDir: string): Promise<void> {
  const metadata: CacheMetadata = { version: CACHE_VERSION, entries: {} };
  await saveMetadata(cacheDir, metadata);
}

/**
 * Get all cached file paths.
 *
 * @param cacheDir - Directory where cache is stored
 * @returns Array of cached file paths
 */
export async function getCachedFilePaths(cacheDir: string): Promise<string[]> {
  const metadata = await loadMetadata(cacheDir);
  return Object.values(metadata.entries).map((entry) => entry.filePath);
}

/**
 * Get cache statistics.
 *
 * @param cacheDir - Directory where cache is stored
 * @returns Statistics about the cache
 */
export async function getCacheStats(cacheDir: string): Promise<{
  totalEntries: number;
  totalSize: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}> {
  const metadata = await loadMetadata(cacheDir);
  const entries = Object.values(metadata.entries);

  if (entries.length === 0) {
    return {
      totalEntries: 0,
      totalSize: 0,
      oldestEntry: null,
      newestEntry: null,
    };
  }

  const mtimes = entries.map((e) => e.mtime);
  const metadataPath = getMetadataPath(cacheDir);

  let totalSize = 0;
  try {
    const stats = await fs.stat(metadataPath);
    totalSize = stats.size;
  } catch {
    // Ignore stat errors
  }

  return {
    totalEntries: entries.length,
    totalSize,
    oldestEntry: new Date(Math.min(...mtimes)),
    newestEntry: new Date(Math.max(...mtimes)),
  };
}

/**
 * Prune cache by removing invalid entries.
 *
 * @param cacheDir - Directory where cache is stored
 * @returns Number of entries removed
 */
export async function pruneCache(cacheDir: string): Promise<number> {
  const metadata = await loadMetadata(cacheDir);
  const entriesToRemove: string[] = [];

  for (const [key, entry] of Object.entries(metadata.entries)) {
    const isValid = await isCacheValid(entry.filePath, entry.hash);
    if (!isValid) {
      entriesToRemove.push(key);
    }
  }

  for (const key of entriesToRemove) {
    delete metadata.entries[key];
  }

  if (entriesToRemove.length > 0) {
    await saveMetadata(cacheDir, metadata);
  }

  return entriesToRemove.length;
}
