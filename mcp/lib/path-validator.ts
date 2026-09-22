/**
 * @module mcp/lib/path-validator
 * @description Path validation utility for project root paths.
 *
 * Provides security validation to prevent indexing of system directories
 * that may contain sensitive files (credentials, keys, configurations).
 *
 * @example
 * import { validateProjectRootPath } from './lib/path-validator.js';
 *
 * const result = validateProjectRootPath('/home/user/projects/my-app');
 * if (!result.valid) {
 *   console.error(result.error);
 * }
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * System directories that should never be indexed as project roots.
 *
 * These directories typically contain:
 * - System credentials and secrets
 * - User private data
 * - Configuration files with sensitive information
 * - Runtime data that could expose system state
 *
 * @see https://refspecs.linuxfoundation.org/FHS_3.0/fhs-3.0.html - Filesystem Hierarchy Standard
 */
const BLOCKED_SYSTEM_PATHS = new Set([
  // System configuration - contains passwd, shadow, hosts, SSH configs
  '/etc',

  // Root user home - contains sensitive configs and potentially secrets
  '/root',

  // Variable data - logs, caches, potentially secrets in app configs
  '/var',

  // System software - no legitimate project code here
  '/usr',

  // System binaries
  '/bin',
  '/sbin',

  // System libraries
  '/lib',
  '/lib64',

  // Kernel interface - exposes system state
  '/sys',

  // Process information - exposes running processes
  '/proc',

  // Device files
  '/dev',

  // Bootloader files
  '/boot',

  // Service data
  '/srv',

  // Runtime variable data
  '/run',

  // macOS specific
  '/System',
  '/Library',
  '/Applications',

  // Windows specific (when running on WSL or similar)
  '/mnt/c/Windows',
  '/mnt/c/Program Files',
  '/mnt/c/Program Files (x86)',
]);

/**
 * Paths that should only be blocked as exact matches (not their subdirectories).
 *
 * For example, `/home` alone is blocked (it would list all users),
 * but `/home/user/projects` is allowed (legitimate project location).
 */
const BLOCKED_EXACT_ONLY = new Set([
  // User homes root - block listing all users, but allow /home/user/projects
  '/home',
]);

/**
 * Lazily-initialised module-level cache for exact-only blocked paths.
 *
 * Reads `process.env.HOME` once and reuses the result.  Tests that need
 * to change `HOME` must call `clearBlockedExactPathCache()` afterwards.
 */
let cachedExactBlockedPaths: Set<string> | null = null;

function getBlockedExactPaths(): Set<string> {
  if (cachedExactBlockedPaths) {
    return cachedExactBlockedPaths;
  }
  const blocked = new Set(BLOCKED_EXACT_ONLY);
  const home = process.env.HOME?.trim()
    .replace(/\\/g, '/')
    .replace(/[\\/]+$/, '');
  if (home) {
    blocked.add(home);
  }
  cachedExactBlockedPaths = blocked;
  return blocked;
}

/**
 * Clear the module-level blocked-exact-paths cache.
 *
 * Call when `process.env.HOME` changes between tests to force a re-read.
 */
export function clearBlockedExactPathCache(): void {
  cachedExactBlockedPaths = null;
}

/**
 * Result of path validation.
 */
export type PathValidationResult =
  | { valid: true; resolvedPath: string }
  | { valid: false; error: string; code: PathValidationErrorCode };

/**
 * Error codes for path validation failures.
 */
export type PathValidationErrorCode =
  | 'PATH_NOT_ABSOLUTE'
  | 'PATH_IS_SYSTEM_DIRECTORY'
  | 'PATH_DOES_NOT_EXIST'
  | 'PATH_IS_NOT_DIRECTORY';

/**
 * Validate that a project root path is safe for indexing.
 *
 * Performs the following security checks:
 * 1. Path must be absolute (no relative paths)
 * 2. Path must not be a system directory (e.g., /etc, /root)
 * 3. Path must exist on the filesystem
 * 4. Path must be a directory (not a file)
 *
 * @param rootPath - The proposed project root path
 * @returns PathValidationResult indicating success or failure with error details
 *
 * @example
 * // Valid project path
 * const result = validateProjectRootPath('/home/user/projects/my-app');
 * // { valid: true, resolvedPath: '/home/user/projects/my-app' }
 *
 * @example
 * // System directory rejected
 * const result = validateProjectRootPath('/etc');
 * // { valid: false, error: 'System directory /etc is not allowed...', code: 'PATH_IS_SYSTEM_DIRECTORY' }
 *
 * @example
 * // Relative path rejected
 * const result = validateProjectRootPath('./my-project');
 * // { valid: false, error: 'Path must be absolute...', code: 'PATH_NOT_ABSOLUTE' }
 */
export function validateProjectRootPath(rootPath: string): PathValidationResult {
  // Normalize the path (resolve . and .., convert backslashes to forward slashes)
  const normalizedPath = rootPath.replace(/\\/g, '/');

  // 1. Check if path is absolute
  // On Unix: starts with /
  // On Windows: starts with drive letter (C:/) or UNC path (//)
  const isAbsolute =
    normalizedPath.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalizedPath) ||
    normalizedPath.startsWith('//');

  if (!isAbsolute) {
    return {
      valid: false,
      error: `Path must be absolute. Received relative path: "${rootPath}". Provide an absolute path like "/home/user/projects/my-app".`,
      code: 'PATH_NOT_ABSOLUTE',
    };
  }

  // Resolve the path to handle any remaining . or .. components
  const resolvedPath = resolve(normalizedPath);

  // 2. Check if path is a blocked system directory
  for (const blockedPath of BLOCKED_SYSTEM_PATHS) {
    // Exact match
    if (resolvedPath === blockedPath) {
      return {
        valid: false,
        error: `System directory "${blockedPath}" is not allowed for project indexing. This directory may contain sensitive system files. Please choose a project directory like "/home/user/projects/my-app".`,
        code: 'PATH_IS_SYSTEM_DIRECTORY',
      };
    }

    // Check if path is a direct subdirectory of a blocked path
    // e.g., /etc/ssh is blocked because it starts with /etc/
    // But /etc_backup is NOT blocked because it doesn't start with /etc/
    if (resolvedPath.startsWith(`${blockedPath}/`)) {
      return {
        valid: false,
        error: `Path "${resolvedPath}" is inside system directory "${blockedPath}" which is not allowed for project indexing. This directory may contain sensitive system files. Please choose a project directory outside of system paths.`,
        code: 'PATH_IS_SYSTEM_DIRECTORY',
      };
    }
  }

  // 3. Check exact-only blocked paths (like /home)
  // These are blocked only as exact matches, not their subdirectories
  for (const blockedPath of getBlockedExactPaths()) {
    if (resolvedPath === blockedPath) {
      return {
        valid: false,
        error: `Directory "${blockedPath}" is not allowed for project indexing. This location may contain private user files or, for /home, lists all user accounts. Please choose a specific project directory like "/home/user/projects/my-app".`,
        code: 'PATH_IS_SYSTEM_DIRECTORY',
      };
    }
    // Note: We do NOT check subdirectories for BLOCKED_EXACT_ONLY
    // /home/user/projects is allowed!
  }

  // 4. Check if path exists
  if (!existsSync(resolvedPath)) {
    return {
      valid: false,
      error: `Path does not exist: "${resolvedPath}". Please verify the path is correct and the directory has been created.`,
      code: 'PATH_DOES_NOT_EXIST',
    };
  }

  let canonicalPath = resolvedPath;
  try {
    canonicalPath = realpathSync.native(resolvedPath);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      error: `Failed to resolve path "${resolvedPath}": ${errorMessage}`,
      code: 'PATH_DOES_NOT_EXIST',
    };
  }

  if (canonicalPath !== resolvedPath && isBlockedSystemPath(canonicalPath)) {
    return {
      valid: false,
      error: `Path "${resolvedPath}" resolves to blocked system directory "${canonicalPath}" which is not allowed for project indexing.`,
      code: 'PATH_IS_SYSTEM_DIRECTORY',
    };
  }

  // 5. Check if path is a directory
  try {
    const stats = statSync(canonicalPath);
    if (!stats.isDirectory()) {
      return {
        valid: false,
        error: `Path is not a directory: "${canonicalPath}". Project root must be a directory, not a file. Please provide a directory path.`,
        code: 'PATH_IS_NOT_DIRECTORY',
      };
    }
  } catch (error) {
    // This shouldn't happen after existsSync check, but handle it defensively
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      error: `Failed to access path "${resolvedPath}": ${errorMessage}`,
      code: 'PATH_IS_NOT_DIRECTORY',
    };
  }

  // All checks passed
  return {
    valid: true,
    resolvedPath: canonicalPath,
  };
}

/**
 * Get the list of blocked system paths.
 *
 * Useful for documentation and testing.
 *
 * @returns Array of blocked system directory paths
 */
export function getBlockedSystemPaths(): string[] {
  return [...Array.from(BLOCKED_SYSTEM_PATHS), ...Array.from(getBlockedExactPaths())];
}

/**
 * Check if a path is a blocked system directory.
 *
 * @param path - The path to check
 * @returns true if the path is blocked, false otherwise
 */
export function isBlockedSystemPath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const resolvedPath = resolve(normalizedPath);

  // Check BLOCKED_SYSTEM_PATHS (exact match and subdirectories)
  for (const blockedPath of BLOCKED_SYSTEM_PATHS) {
    if (resolvedPath === blockedPath || resolvedPath.startsWith(`${blockedPath}/`)) {
      return true;
    }
  }

  // Check BLOCKED_EXACT_ONLY (exact match only)
  for (const blockedPath of getBlockedExactPaths()) {
    if (resolvedPath === blockedPath) {
      return true;
    }
  }

  return false;
}
