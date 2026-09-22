/**
 * @module ingest-shared.test
 * @description Tests for ingest-shared module.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IngestSharedModule = typeof import('../ingest-shared.js');

function createTestProjectStructure(baseDir: string) {
  mkdirSync(baseDir, { recursive: true });
  const srcDir = join(baseDir, 'src');
  const docsDir = join(baseDir, 'docs');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(srcDir, 'index.ts'), 'export const app = "test";');
  writeFileSync(join(docsDir, 'README.md'), '# Project Docs\n\nMain docs.');
  writeFileSync(join(baseDir, 'config.json'), '{"name": "test"}');
}

describe('ingest-shared', () => {
  let testProjectDir: string;
  let originalProjectSourcePath: string | undefined;
  let ingestFullProject: IngestSharedModule['ingestFullProject'];
  let validateFile: IngestSharedModule['validateFile'];

  beforeEach(async () => {
    vi.resetModules();
    originalProjectSourcePath = process.env.PROJECT_SOURCE_PATH;
    testProjectDir = resolve(join(tmpdir(), `ingest-test-${Date.now()}`));
    createTestProjectStructure(testProjectDir);
    process.env.PROJECT_SOURCE_PATH = testProjectDir;
    process.env.PROJECT_FILE_GLOB = '**/*.{md,mdx,ts,tsx,js,jsx,json,yml,yaml}';
    process.env.RAG_MCP_PROJECT_IGNORE_PATTERNS = '';
    ({ ingestFullProject, validateFile } = await import('../ingest-shared.js'));
  });

  afterEach(() => {
    try {
      rmSync(testProjectDir, { recursive: true, force: true });
    } catch {}
    vi.clearAllMocks();
    process.env.PROJECT_SOURCE_PATH = originalProjectSourcePath;
    process.env.PROJECT_FILE_GLOB = undefined;
    process.env.RAG_MCP_PROJECT_IGNORE_PATTERNS = undefined;
  });

  describe('validateFile', () => {
    it('accepts valid file', () => {
      const result = validateFile(join(testProjectDir, 'src', 'index.ts'), testProjectDir);
      expect(result.valid).toBe(true);
    });

    it('rejects file outside root', () => {
      const result = validateFile('/etc/passwd', testProjectDir);
      expect(result.valid).toBe(false);
    });

    it('rejects .env files', () => {
      const envFile = join(testProjectDir, '.env');
      writeFileSync(envFile, 'SECRET=value');
      const result = validateFile(envFile, testProjectDir);
      expect(result.valid).toBe(false);
    });

    it('rejects .pem files', () => {
      const pemFile = join(testProjectDir, 'cert.pem');
      writeFileSync(pemFile, '-----BEGIN');
      const result = validateFile(pemFile, testProjectDir);
      expect(result.valid).toBe(false);
    });

    it('rejects files with /handling/ in path', () => {
      const dir = join(testProjectDir, 'docs', 'handling');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'guide.md');
      writeFileSync(file, '# Handling');
      const result = validateFile(file, testProjectDir);
      expect(result.valid).toBe(false);
    });

    it('rejects files with /rendering/ in path', () => {
      const dir = join(testProjectDir, 'docs', 'rendering');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'guide.md');
      writeFileSync(file, '# Rendering');
      const result = validateFile(file, testProjectDir);
      expect(result.valid).toBe(false);
    });

    it('handles non-existent files', () => {
      const result = validateFile(join(testProjectDir, 'missing.txt'), testProjectDir);
      expect(result.valid).toBe(false);
    });
  });

  describe('ingestFullProject', () => {
    it('fails fast with Postgres ingest guidance', async () => {
      await expect(ingestFullProject({}, vi.fn())).rejects.toThrow('bun run ingest-project');
    });
  });
});
