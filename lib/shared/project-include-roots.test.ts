import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProjectIgnoreGlobPatterns,
  buildProjectIncludeGlobPatterns,
  suggestProjectIncludeRoots,
  validateProjectIncludeRoots,
} from './project-include-roots.js';

describe('project-include-roots', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = join(tmpdir(), `project-include-roots-${Date.now()}`);
    mkdirSync(join(rootDir, 'src'), { recursive: true });
    mkdirSync(join(rootDir, 'packages', 'app'), { recursive: true });
    writeFileSync(join(rootDir, 'package.json'), '{}');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('suggests common code roots that exist in the repository', () => {
    expect(suggestProjectIncludeRoots(rootDir)).toEqual(['src', 'packages']);
  });

  it('includes useful discovered roots while skipping noisy and legacy operational folders', () => {
    mkdirSync(join(rootDir, 'backend'), { recursive: true });
    mkdirSync(join(rootDir, 'vendor'), { recursive: true });
    mkdirSync(join(rootDir, 'frontend'), { recursive: true });
    mkdirSync(join(rootDir, 'archives'), { recursive: true });
    mkdirSync(join(rootDir, 'generated'), { recursive: true });
    mkdirSync(join(rootDir, '.agent', 'wb'), { recursive: true });
    mkdirSync(join(rootDir, '.agents', 'wb'), { recursive: true });

    expect(suggestProjectIncludeRoots(rootDir)).toEqual(['src', 'packages', 'backend', 'frontend']);
  });

  it('validates explicit include roots against the filesystem', () => {
    expect(validateProjectIncludeRoots(rootDir, ['src', 'packages/app'])).toEqual({
      valid: true,
      includeRoots: ['src', 'packages/app'],
    });
  });

  it('allows .github but rejects other dot include roots', () => {
    mkdirSync(join(rootDir, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(rootDir, '.codex'), { recursive: true });

    expect(validateProjectIncludeRoots(rootDir, ['.github'])).toEqual({
      valid: true,
      includeRoots: ['.github'],
    });

    const result = validateProjectIncludeRoots(rootDir, ['.codex']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INVALID_INCLUDE_ROOTS');
      expect(result.error).toContain('dot directories');
    }
  });

  it('rejects missing include roots and returns suggestions', () => {
    const result = validateProjectIncludeRoots(rootDir, []);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INCLUDE_ROOTS_REQUIRED');
      expect(result.suggestions).toEqual(['src', 'packages']);
    }
  });

  it('rejects non-existent include roots', () => {
    const result = validateProjectIncludeRoots(rootDir, ['src', 'missing']);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INCLUDE_ROOT_NOT_FOUND');
      expect(result.error).toContain('missing');
    }
  });

  it('rejects symlinked include roots', () => {
    const externalDir = join(tmpdir(), `project-include-roots-external-${Date.now()}`);
    mkdirSync(externalDir, { recursive: true });
    symlinkSync(externalDir, join(rootDir, 'external'), 'dir');

    try {
      const result = validateProjectIncludeRoots(rootDir, ['external']);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('INCLUDE_ROOT_IS_SYMLINK');
      }
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('builds scoped glob patterns for each include root', () => {
    expect(buildProjectIncludeGlobPatterns(['src', 'packages/app'], '**/*.{ts,tsx}')).toEqual([
      'src/**/*.{ts,tsx}',
      'packages/app/**/*.{ts,tsx}',
    ]);
  });

  it('expands ignore rules into runtime glob patterns', () => {
    expect(
      buildProjectIgnoreGlobPatterns(['dist/**', '.afol/wb', 'package-lock.json', '*.generated.ts'])
    ).toEqual(['**/dist/**', '**/.afol/wb/**', '**/package-lock.json', '**/*.generated.ts']);
  });

  it('permits an explicitly selected consumer source root named ingest', () => {
    mkdirSync(join(rootDir, 'ingest'), { recursive: true });
    const result = validateProjectIncludeRoots(rootDir, ['ingest']);
    expect(result).toEqual({ valid: true, includeRoots: ['ingest'] });
  });

  it('allows a nested source folder named ingest while keeping root ingest blocked', () => {
    mkdirSync(join(rootDir, 'lib', 'ingest'), { recursive: true });
    expect(validateProjectIncludeRoots(rootDir, ['lib/ingest'])).toEqual({
      valid: true,
      includeRoots: ['lib/ingest'],
    });
  });

  it('anchors slash-prefixed ignore rules at the registered root', () => {
    expect(buildProjectIgnoreGlobPatterns(['/ingest'])).toEqual(['ingest/**']);
    expect(buildProjectIgnoreGlobPatterns(['ingest'])).toEqual(['**/ingest/**']);
  });

  it('rejects include root pointing to generated directory', () => {
    mkdirSync(join(rootDir, 'generated'), { recursive: true });
    const result = validateProjectIncludeRoots(rootDir, ['generated']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INVALID_INCLUDE_ROOTS');
      expect(result.error).toContain('generated');
    }
  });

  it('rejects include root pointing to _generated directory', () => {
    mkdirSync(join(rootDir, '_generated'), { recursive: true });
    const result = validateProjectIncludeRoots(rootDir, ['_generated']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INVALID_INCLUDE_ROOTS');
      expect(result.error).toContain('_generated');
    }
  });

  it('rejects include root pointing to archive directory', () => {
    mkdirSync(join(rootDir, 'archive'), { recursive: true });
    const result = validateProjectIncludeRoots(rootDir, ['archive']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INVALID_INCLUDE_ROOTS');
      expect(result.error).toContain('archive');
    }
  });

  it('rejects include root pointing to .data directory via dot rejection', () => {
    mkdirSync(join(rootDir, '.data'), { recursive: true });
    const result = validateProjectIncludeRoots(rootDir, ['.data']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INVALID_INCLUDE_ROOTS');
    }
  });

  it('rejects include root pointing to vendor directory', () => {
    mkdirSync(join(rootDir, 'vendor'), { recursive: true });
    const result = validateProjectIncludeRoots(rootDir, ['vendor']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INVALID_INCLUDE_ROOTS');
      expect(result.error).toContain('vendor');
    }
  });

  it('rejects include root pointing to out directory', () => {
    mkdirSync(join(rootDir, 'out'), { recursive: true });
    const result = validateProjectIncludeRoots(rootDir, ['out']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('INVALID_INCLUDE_ROOTS');
      expect(result.error).toContain('out');
    }
  });

  it('still allows safe include roots after noisy-rejection hardening', () => {
    mkdirSync(join(rootDir, 'backend'), { recursive: true });
    mkdirSync(join(rootDir, 'frontend'), { recursive: true });

    expect(validateProjectIncludeRoots(rootDir, ['src'])).toEqual({
      valid: true,
      includeRoots: ['src'],
    });
    expect(validateProjectIncludeRoots(rootDir, ['backend', 'frontend'])).toEqual({
      valid: true,
      includeRoots: ['backend', 'frontend'],
    });
  });
});
