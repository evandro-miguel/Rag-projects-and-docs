/**
 * @module mcp/lib/path-validator.test
 * @description Tests for project root path validation.
 *
 * Security tests for the path validation module that prevents
 * indexing of system directories containing sensitive files.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearBlockedExactPathCache,
  getBlockedSystemPaths,
  isBlockedSystemPath,
  validateProjectRootPath,
} from './path-validator.js';

describe('validateProjectRootPath', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary test directory
    testDir = join(tmpdir(), `path-validator-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Security: System directory protection', () => {
    it('rejects /etc (system configuration)', () => {
      const result = validateProjectRootPath('/etc');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
        expect(result.error).toContain('/etc');
        expect(result.error).toContain('not allowed');
      }
    });

    it('rejects /root (root user home)', () => {
      const result = validateProjectRootPath('/root');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /var (variable data)', () => {
      const result = validateProjectRootPath('/var');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /usr (system software)', () => {
      const result = validateProjectRootPath('/usr');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /bin (system binaries)', () => {
      const result = validateProjectRootPath('/bin');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /sbin (system binaries)', () => {
      const result = validateProjectRootPath('/sbin');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /lib (system libraries)', () => {
      const result = validateProjectRootPath('/lib');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /sys (kernel interface)', () => {
      const result = validateProjectRootPath('/sys');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /proc (process information)', () => {
      const result = validateProjectRootPath('/proc');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /dev (device files)', () => {
      const result = validateProjectRootPath('/dev');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('rejects /home (user homes root - exact match only)', () => {
      const result = validateProjectRootPath('/home');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
        expect(result.error).toContain('lists all user accounts');
      }
    });

    it('rejects the current user home as a project root', () => {
      const previousHome = process.env.HOME;
      process.env.HOME = testDir;
      clearBlockedExactPathCache();

      try {
        const result = validateProjectRootPath(testDir);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
          expect(result.error).toContain('private user files');
        }
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
        clearBlockedExactPathCache();
      }
    });

    it('rejects subdirectories of blocked paths', () => {
      const subdirs = [
        '/etc/ssh',
        '/etc/nginx',
        '/root/.ssh',
        '/var/log',
        '/usr/local',
        '/sys/kernel',
        '/proc/1',
      ];

      for (const path of subdirs) {
        const result = validateProjectRootPath(path);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
        }
      }
    });

    it('rejects symlinks that resolve into blocked paths', () => {
      const linkPath = join(testDir, 'etc-link');
      symlinkSync('/etc', linkPath, 'dir');

      const result = validateProjectRootPath(linkPath);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('does NOT reject paths that merely start with blocked path name', () => {
      // These should NOT be rejected - they're not actually under /etc, etc.
      // They just happen to start with similar names
      const safePaths = ['/etc_backup', '/home2', '/var2', '/usr-local-backup', '/etc2'];

      // Note: These paths don't exist, so they'll fail PATH_DOES_NOT_EXIST
      // but they should NOT fail with PATH_IS_SYSTEM_DIRECTORY
      for (const path of safePaths) {
        const result = validateProjectRootPath(path);
        if (!result.valid) {
          expect(result.code).not.toBe('PATH_IS_SYSTEM_DIRECTORY');
        }
      }
    });
  });

  describe('Special handling for /home', () => {
    it('rejects exact /home path', () => {
      const result = validateProjectRootPath('/home');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_SYSTEM_DIRECTORY');
      }
    });

    it('ALLOWS /home/user/projects (subdirectories are allowed)', () => {
      // /home/user/projects is a LEGITIMATE project location
      // Only /home itself is blocked (because it lists all users)
      expect(isBlockedSystemPath('/home/user/projects')).toBe(false);
      expect(isBlockedSystemPath('/home/user')).toBe(false);
      expect(isBlockedSystemPath('/home')).toBe(true);
    });

    it('accepts paths under /home/user/... via validateProjectRootPath when they exist', () => {
      // /home itself is always rejected
      expect(validateProjectRootPath('/home').valid).toBe(false);

      // A project subdirectory under a /home-like structure is accepted
      // when it exists on the filesystem (use a temp dir as stand-in)
      const homeSubdir = join(testDir, 'user', 'project');
      mkdirSync(homeSubdir, { recursive: true });

      const result = validateProjectRootPath(homeSubdir);
      expect(result.valid).toBe(true);
    });
  });

  describe('Path format validation', () => {
    it('rejects relative paths', () => {
      const relativePaths = [
        './my-project',
        '../my-project',
        'my-project',
        './some/path/to/project',
        '../another/project',
      ];

      for (const path of relativePaths) {
        const result = validateProjectRootPath(path);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.code).toBe('PATH_NOT_ABSOLUTE');
          expect(result.error).toContain('absolute');
        }
      }
    });

    it('accepts absolute paths', () => {
      // This test validates that absolute paths pass the "is absolute" check
      // (they'll fail on PATH_DOES_NOT_EXIST since we're not creating them)
      const result = validateProjectRootPath('/nonexistent/path/to/project');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_DOES_NOT_EXIST');
      }
    });

    it('normalizes paths with backslashes', () => {
      // On Unix systems, backslashes are valid filename characters
      // But we normalize them for consistency
      const result = validateProjectRootPath(testDir.replace(/\//g, '\\'));
      // Should either work or fail with PATH_DOES_NOT_EXIST, not PATH_NOT_ABSOLUTE
      if (!result.valid) {
        expect(result.code).not.toBe('PATH_NOT_ABSOLUTE');
      }
    });
  });

  describe('Path existence validation', () => {
    it('rejects non-existent paths', () => {
      const result = validateProjectRootPath('/nonexistent/path/to/project');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_DOES_NOT_EXIST');
        expect(result.error).toContain('does not exist');
      }
    });

    it('accepts existing directories', () => {
      const result = validateProjectRootPath(testDir);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.resolvedPath).toBe(testDir);
      }
    });
  });

  describe('Path type validation', () => {
    it('rejects files (not directories)', () => {
      const filePath = join(testDir, 'test-file.txt');
      writeFileSync(filePath, 'test content');

      const result = validateProjectRootPath(filePath);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PATH_IS_NOT_DIRECTORY');
        expect(result.error).toContain('not a directory');
      }
    });
  });

  describe('Valid project paths', () => {
    it('accepts /home/user/projects style paths', () => {
      // Create a simulated user project directory
      const userProjectDir = join(testDir, 'user', 'projects', 'my-app');
      mkdirSync(userProjectDir, { recursive: true });

      const result = validateProjectRootPath(userProjectDir);
      expect(result.valid).toBe(true);
    });

    it('accepts deep project paths', () => {
      const deepPath = join(testDir, 'a', 'b', 'c', 'd', 'e', 'project');
      mkdirSync(deepPath, { recursive: true });

      const result = validateProjectRootPath(deepPath);
      expect(result.valid).toBe(true);
    });

    it('resolves the path correctly', () => {
      const result = validateProjectRootPath(testDir);
      expect(result.valid).toBe(true);
      if (result.valid) {
        // Resolved path should match the test directory
        expect(result.resolvedPath).toBe(testDir);
      }
    });
  });

  describe('Edge cases', () => {
    it('handles paths with trailing slashes', () => {
      const pathWithSlash = `${testDir}/`;
      const result = validateProjectRootPath(pathWithSlash);
      expect(result.valid).toBe(true);
    });

    it('handles paths with multiple slashes', () => {
      const pathWithSlashes = testDir.replace(/\/+/g, '//');
      const result = validateProjectRootPath(pathWithSlashes);
      expect(result.valid).toBe(true);
    });

    it('handles paths with .. segments', () => {
      const parentDir = join(testDir, '..');
      const result = validateProjectRootPath(parentDir);
      // Should resolve to tmpdir, which should exist
      expect(result.valid).toBe(true);
    });

    it('clearBlockedExactPathCache forces HOME re-read on next call', () => {
      const previousHome = process.env.HOME;
      clearBlockedExactPathCache();

      // Set HOME to a non-existent directory – it should be added as a blocked path
      process.env.HOME = '/nonexistent_home_test';
      clearBlockedExactPathCache();

      try {
        expect(isBlockedSystemPath('/nonexistent_home_test')).toBe(true);
      } finally {
        process.env.HOME = previousHome;
        clearBlockedExactPathCache();
      }
    });
  });
});

describe('getBlockedSystemPaths', () => {
  it('returns array of blocked paths', () => {
    const blocked = getBlockedSystemPaths();
    expect(Array.isArray(blocked)).toBe(true);
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('includes critical system directories', () => {
    const blocked = getBlockedSystemPaths();
    expect(blocked).toContain('/etc');
    expect(blocked).toContain('/root');
    expect(blocked).toContain('/var');
    expect(blocked).toContain('/usr');
    expect(blocked).toContain('/sys');
    expect(blocked).toContain('/proc');
    expect(blocked).toContain('/home'); // exact match only
  });
});

describe('isBlockedSystemPath', () => {
  it('returns true for blocked paths', () => {
    expect(isBlockedSystemPath('/etc')).toBe(true);
    expect(isBlockedSystemPath('/root')).toBe(true);
    expect(isBlockedSystemPath('/var/log')).toBe(true);
    expect(isBlockedSystemPath('/home')).toBe(true); // exact match
  });

  it('returns false for non-blocked paths', () => {
    expect(isBlockedSystemPath('/home/user/projects')).toBe(false);
    expect(isBlockedSystemPath('/home/user')).toBe(false);
    expect(isBlockedSystemPath('/etc_backup')).toBe(false);
  });

  it('correctly handles /home special case', () => {
    // /home itself is blocked
    expect(isBlockedSystemPath('/home')).toBe(true);
    // But subdirectories are allowed
    expect(isBlockedSystemPath('/home/user')).toBe(false);
    expect(isBlockedSystemPath('/home/user/projects/my-app')).toBe(false);
  });
});
