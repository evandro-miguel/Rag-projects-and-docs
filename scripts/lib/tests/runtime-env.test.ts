import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Minimal dotenv-format parser used by the mock to make config() actually
 * set process.env so precedence behavior is testable in integration.
 */
function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

vi.mock('dotenv', () => {
  const configFn = vi.fn((options?: { path?: string; quiet?: boolean; override?: boolean }) => {
    if (options?.path) {
      try {
        const content = readFileSync(options.path, 'utf-8');
        const parsed = parseDotenv(content);
        for (const [key, value] of Object.entries(parsed)) {
          if (!options?.override && process.env[key] !== undefined) continue;
          process.env[key] = value;
        }
      } catch {
        // file missing or unreadable — dotenv's quiet:true swallows this
      }
    }
    return { parsed: {} };
  });

  return {
    config: configFn,
    parse: vi.fn(parseDotenv),
  };
});

describe('runtime-env', () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env;
  const importRuntimeEnv = () => import('../runtime-env.js');

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.RAG_SKIP_REPO_ENV;
    delete process.env.RAG_REPO_ROOT;
    delete process.env.RAG_V2_ROOT;
    delete process.env.RAG_CONFIG_DIR;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('resolves repo paths independently of cwd', async () => {
    const expectedRepoRoot = originalCwd;
    const tempDir = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-'));
    process.chdir(tempDir);

    const runtimeEnv = await importRuntimeEnv();

    expect(runtimeEnv.REPO_ROOT).toBe(expectedRepoRoot);
    expect(runtimeEnv.REPO_ENV_PATH).toBe(join(expectedRepoRoot, '.env.local'));
    expect(runtimeEnv.resolveRepoPath('ingest', 'prompts', 'adapt-beginner.md')).toBe(
      join(expectedRepoRoot, 'ingest', 'prompts', 'adapt-beginner.md')
    );
  });

  it('boots dotenv from the repo .env.local even when cwd changes', async () => {
    const expectedEnvPath = join(originalCwd, '.env.local');
    const tempDir = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-'));
    process.chdir(tempDir);

    const dotenv = await import('dotenv');
    const runtimeEnv = await importRuntimeEnv();

    expect(runtimeEnv.ensureRepoEnvLoaded()).toBe(expectedEnvPath);
    expect(dotenv.config).toHaveBeenCalledWith({
      path: expectedEnvPath,
      quiet: true,
    });
  });

  it('prefers RAG_REPO_ROOT over RAG_V2_ROOT and cwd', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-root-'));
    const aliasRoot = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-alias-'));
    const tempDir = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-cwd-'));
    process.env.RAG_REPO_ROOT = repoRoot;
    process.env.RAG_V2_ROOT = aliasRoot;
    process.chdir(tempDir);

    const runtimeEnv = await importRuntimeEnv();

    expect(runtimeEnv.REPO_ROOT).toBe(repoRoot);
    expect(runtimeEnv.REPO_ENV_PATH).toBe(join(repoRoot, '.env.local'));
  });

  it('loads the explicit repository root env instead of the caller cwd env', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-root-'));
    const callerCwd = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-cwd-'));
    process.env.RAG_REPO_ROOT = repoRoot;
    process.chdir(callerCwd);

    const dotenv = await import('dotenv');
    const runtimeEnv = await importRuntimeEnv();

    expect(runtimeEnv.REPO_ROOT).toBe(repoRoot);
    expect(dotenv.config).toHaveBeenCalledWith({
      path: join(repoRoot, '.env.local'),
      quiet: true,
    });
  });

  it('uses RAG_V2_ROOT when RAG_REPO_ROOT is unset', async () => {
    const aliasRoot = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-alias-'));
    process.env.RAG_V2_ROOT = aliasRoot;

    const runtimeEnv = await importRuntimeEnv();

    expect(runtimeEnv.REPO_ROOT).toBe(aliasRoot);
  });

  it('rejects an invalid configured repo root', async () => {
    process.env.RAG_REPO_ROOT = join(tmpdir(), 'rag-v2-runtime-env-missing');

    await expect(importRuntimeEnv()).rejects.toThrow(
      'RAG_REPO_ROOT must be an absolute path to an existing directory'
    );
  });

  it('rejects a relative configured repo root without exposing its value', async () => {
    process.env.RAG_REPO_ROOT = 'relative/private-root';

    await expect(importRuntimeEnv()).rejects.toThrow(
      'RAG_REPO_ROOT must be an absolute path to an existing directory'
    );
  });

  it('normalizes env values', async () => {
    const runtimeEnv = await importRuntimeEnv();

    expect(runtimeEnv.normalizeEnvValue(' "value" ')).toBe('value');
    expect(runtimeEnv.normalizeEnvValue('')).toBeUndefined();
    expect(runtimeEnv.normalizeEnvValue(undefined)).toBeUndefined();
  });

  describe('RAG_CONFIG_DIR', () => {
    it('loads env from RAG_CONFIG_DIR and skips repo-relative loading', async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'rag-v2-config-'));
      const envValue = 'exported_from_config_dir=yes';
      writeFileSync(join(configDir, '.env.local'), envValue);
      process.env.RAG_CONFIG_DIR = configDir;

      const dotenvModule = await import('dotenv');
      const runtimeEnv = await importRuntimeEnv();

      // verify config dir .env.local was loaded
      expect(dotenvModule.config).toHaveBeenCalledWith({
        path: join(configDir, '.env.local'),
        quiet: true,
      });

      // verify repo-relative .env.local was NOT loaded (ensureRepoEnvLoaded
      // runs at module init and should skip because configDirUsed is true)
      expect(dotenvModule.config).not.toHaveBeenCalledWith({
        path: runtimeEnv.REPO_ENV_PATH,
        quiet: true,
      });

      // REPO_ROOT is still a valid path (SCRIPT_LIB_DIR fallback or override)
      expect(runtimeEnv.REPO_ROOT).toBeTruthy();
    });

    it('skips repo-relative env when RAG_CONFIG_DIR is set but .env.local is missing', async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'rag-v2-config-empty-'));
      process.env.RAG_CONFIG_DIR = configDir;

      const dotenvModule = await import('dotenv');
      const runtimeEnv = await importRuntimeEnv();

      // No .env.local exists in config dir, and repo-relative is skipped
      // because configDirUsed is true. dotenv.config should not have been
      // called for any .env.local path.
      expect(dotenvModule.config).not.toHaveBeenCalledWith({
        path: runtimeEnv.REPO_ENV_PATH,
        quiet: true,
      });
      expect(dotenvModule.config).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringContaining('.env.local') })
      );
    });

    it('rejects RAG_CONFIG_DIR when the directory does not exist', async () => {
      process.env.RAG_CONFIG_DIR = join(tmpdir(), 'rag-v2-config-missing-');

      await expect(importRuntimeEnv()).rejects.toThrow(
        'RAG_CONFIG_DIR must be an absolute path to an existing directory'
      );
    });

    it('rejects RAG_CONFIG_DIR when the value is a relative path', async () => {
      process.env.RAG_CONFIG_DIR = 'relative/config-dir';

      await expect(importRuntimeEnv()).rejects.toThrow(
        'RAG_CONFIG_DIR must be an absolute path to an existing directory'
      );
    });

    it('respects RAG_REPO_ROOT even when RAG_CONFIG_DIR is also set', async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'rag-v2-config-root-'));
      writeFileSync(join(configDir, '.env.local'), 'SOME_OTHER_VAR=value');
      const repoRoot = mkdtempSync(join(tmpdir(), 'rag-v2-runtime-env-root-'));
      process.env.RAG_CONFIG_DIR = configDir;
      process.env.RAG_REPO_ROOT = repoRoot;

      const runtimeEnv = await importRuntimeEnv();

      expect(runtimeEnv.REPO_ROOT).toBe(repoRoot);
    });

    it('gives .env.prod.local precedence over .env.local for keys not in shell env', async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'rag-v2-config-'));
      writeFileSync(join(configDir, '.env.local'), 'SHARED=from_local\nLOCAL_ONLY=local');
      writeFileSync(join(configDir, '.env.prod.local'), 'SHARED=from_prod\nPROD_ONLY=prod');
      process.env.RAG_CONFIG_DIR = configDir;

      await importRuntimeEnv();

      // SHARED was not in original process.env, .env.prod.local overrides .env.local
      expect(process.env.SHARED).toBe('from_prod');
      // PROD_ONLY comes only from .env.prod.local
      expect(process.env.PROD_ONLY).toBe('prod');
      // LOCAL_ONLY comes only from .env.local
      expect(process.env.LOCAL_ONLY).toBe('local');
    });

    it('preserves shell env vars over .env.prod.local', async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'rag-v2-config-'));
      writeFileSync(join(configDir, '.env.local'), 'DATABASE_URL=from_local');
      writeFileSync(join(configDir, '.env.prod.local'), 'DATABASE_URL=from_prod');
      process.env.DATABASE_URL = 'from_shell';
      process.env.RAG_CONFIG_DIR = configDir;

      await importRuntimeEnv();

      // DATABASE_URL was in original process.env, so shell value wins over prod
      expect(process.env.DATABASE_URL).toBe('from_shell');
    });

    it('.env.prod.local fills keys missing from both shell and .env.local', async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'rag-v2-config-'));
      writeFileSync(join(configDir, '.env.local'), 'DB_HOST=local_host');
      writeFileSync(join(configDir, '.env.prod.local'), 'DB_PORT=5432');
      process.env.RAG_CONFIG_DIR = configDir;

      await importRuntimeEnv();

      expect(process.env.DB_HOST).toBe('local_host');
      expect(process.env.DB_PORT).toBe('5432');
    });
  });
});
