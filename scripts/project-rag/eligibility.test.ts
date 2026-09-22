import { describe, expect, it } from 'vitest';
import { SCRIPT_CONFIG } from '../lib/config.js';
import {
  classifyProjectFilePolicy,
  detectLanguage,
  extensionOf,
  isEligibleProjectSourcePath,
  normalizeSourcePath,
  PROJECT_SOURCE_EXTENSIONS,
  SOURCE_EXTENSIONS,
  TRUSTED_EXTENSIONLESS_LAUNCHERS,
} from './eligibility.js';

describe('Project RAG file eligibility and language detection', () => {
  it('includes .sql and .sh in canonical source extensions', () => {
    expect(PROJECT_SOURCE_EXTENSIONS.has('.sql')).toBe(true);
    expect(PROJECT_SOURCE_EXTENSIONS.has('.sh')).toBe(true);
    expect(SOURCE_EXTENSIONS).toBe(PROJECT_SOURCE_EXTENSIONS);
  });

  it('recognizes trusted extensionless launchers in bin/', () => {
    expect(TRUSTED_EXTENSIONLESS_LAUNCHERS.has('bin/ragctl')).toBe(true);
    expect(TRUSTED_EXTENSIONLESS_LAUNCHERS.has('bin/rag-mcp')).toBe(true);
    expect(isEligibleProjectSourcePath('bin/ragctl')).toBe(true);
    expect(isEligibleProjectSourcePath('bin/rag-mcp')).toBe(true);
    expect(isEligibleProjectSourcePath('./bin/ragctl')).toBe(true);
    expect(isEligibleProjectSourcePath('/bin/ragctl')).toBe(false);
  });

  it('does not admit arbitrary extensionless files under bin/', () => {
    expect(isEligibleProjectSourcePath('bin/unsafe-launcher')).toBe(false);
    expect(detectLanguage('bin/unsafe-launcher')).toBeUndefined();
    expect(classifyProjectFilePolicy('bin/unsafe-launcher')).toEqual({
      eligible: false,
      reason: 'policy_excluded_extension',
    });
  });

  it('recognizes source files with code and docs extensions as eligible', () => {
    expect(isEligibleProjectSourcePath('scripts/db-migrations/migrations/001.sql')).toBe(true);
    expect(isEligibleProjectSourcePath('start-rag.sh')).toBe(true);
    expect(isEligibleProjectSourcePath('mcp/server.ts')).toBe(true);
    expect(isEligibleProjectSourcePath('docs/architecture.md')).toBe(true);
    expect(isEligibleProjectSourcePath('package.json')).toBe(true);
  });

  it('rejects policy-excluded file types and arbitrary extensionless files', () => {
    expect(isEligibleProjectSourcePath('assets/logo.png')).toBe(false);
    expect(isEligibleProjectSourcePath('dist/bundle.zip')).toBe(false);
    expect(isEligibleProjectSourcePath('data/records.csv')).toBe(false);
    expect(isEligibleProjectSourcePath('build/binary')).toBe(false);
    expect(isEligibleProjectSourcePath('some_random_file')).toBe(false);
  });

  it('enforces file size bounds during eligibility check', () => {
    expect(isEligibleProjectSourcePath('mcp/server.ts', 1000)).toBe(true);
    expect(isEligibleProjectSourcePath('mcp/server.ts', 0)).toBe(false);
    expect(isEligibleProjectSourcePath('mcp/server.ts', -10)).toBe(false);
    expect(
      isEligibleProjectSourcePath('mcp/server.ts', SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES + 1)
    ).toBe(false);
  });

  it('detects language accurately for code, scripts, and launchers', () => {
    expect(detectLanguage('scripts/migrate.sql')).toBe('sql');
    expect(detectLanguage('start-rag.sh')).toBe('shell');
    expect(detectLanguage('bin/ragctl')).toBe('shell');
    expect(detectLanguage('bin/rag-mcp')).toBe('shell');
    expect(detectLanguage('lib/index.ts')).toBe('typescript');
    expect(detectLanguage('lib/index.js')).toBe('javascript');
    expect(detectLanguage('docs/index.md')).toBe('markdown');
    expect(detectLanguage('data.json')).toBe('json');
    expect(detectLanguage('assets/img.png')).toBeUndefined();
  });

  it('classifies policy decisions with reason', () => {
    expect(classifyProjectFilePolicy('scripts/migrate.sql')).toEqual({ eligible: true });
    expect(classifyProjectFilePolicy('bin/ragctl')).toEqual({ eligible: true });
    expect(classifyProjectFilePolicy('scripts/migrate.sql', 0)).toEqual({
      eligible: false,
      reason: 'empty_file',
    });
    expect(
      classifyProjectFilePolicy('scripts/migrate.sql', SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES + 1)
    ).toEqual({
      eligible: false,
      reason: 'size_exceeded',
    });
    expect(classifyProjectFilePolicy('image.png')).toEqual({
      eligible: false,
      reason: 'policy_excluded_extension',
    });
  });

  it('normalizes source paths and extracts extensions correctly', () => {
    expect(normalizeSourcePath('./scripts/foo.ts')).toBe('scripts/foo.ts');
    expect(normalizeSourcePath('/scripts/foo.ts')).toBe('scripts/foo.ts');
    expect(normalizeSourcePath('scripts\\foo.ts')).toBe('scripts/foo.ts');
    expect(extensionOf('scripts/foo.ts')).toBe('.ts');
    expect(extensionOf('scripts/foo.TS')).toBe('.ts');
    expect(extensionOf('bin/ragctl')).toBe('');
  });
});
