import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config', () => {
  const originalEnv = process.env;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.RAG_SKIP_REPO_ENV = 'true';
    console.warn = vi.fn();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    console.warn = originalWarn;
    vi.clearAllMocks();
  });

  describe('SCRIPT_CONFIG', () => {
    it('uses default values when env vars not set', async () => {
      // Clear relevant env vars by setting to undefined
      process.env.DOCS_SOURCE_PATH = undefined as unknown as string;
      process.env.PROJECT_SOURCE_PATH = undefined as unknown as string;
      process.env.RAG_MCP_PROJECT_IGNORE_PATTERNS = undefined as unknown as string;
      process.env.RAG_MCP_PROJECT_MAX_FILE_BYTES = undefined as unknown as string;
      process.env.PROJECT_FILE_GLOB = undefined as unknown as string;
      process.env.PROJECT_WATCH_DEBOUNCE_MS = undefined as unknown as string;
      process.env.INGEST_CONCURRENCY = undefined as unknown as string;
      process.env.CHUNK_SIZE = undefined as unknown as string;
      process.env.CHUNK_OVERLAP = undefined as unknown as string;
      process.env.EMBEDDING_PROVIDER = undefined as unknown as string;
      process.env.EMBEDDING_MODEL = undefined as unknown as string;
      process.env.PROJECT_EMBEDDING_DIMENSIONS = undefined as unknown as string;

      const { SCRIPT_CONFIG } = await import('../config.js');

      expect(SCRIPT_CONFIG.DOCS_SOURCE_PATH).toBe('');
      expect(SCRIPT_CONFIG.PROJECT_SOURCE_PATH).toBe('');
      expect(SCRIPT_CONFIG.PROJECT_IGNORE_PATTERNS).toBe('');
      expect(SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES).toBe(5000000);
      expect(SCRIPT_CONFIG.PROJECT_FILE_GLOB).toBe('**/*.{md,mdx,ts,tsx,js,jsx,json,yml,yaml}');
      expect(SCRIPT_CONFIG.PROJECT_WATCH_DEBOUNCE_MS).toBe(1500);
      expect(SCRIPT_CONFIG.CONCURRENCY_LIMIT).toBe(10);
      expect(SCRIPT_CONFIG.CHUNK_SIZE).toBe(1000);
      expect(SCRIPT_CONFIG.CHUNK_OVERLAP).toBe(100);
      expect(SCRIPT_CONFIG.EMBEDDING_PROVIDER).toBe('llamacpp');
      expect(SCRIPT_CONFIG.EMBEDDING_MODEL).toBe('qwen3-embedding-1024');
      expect(SCRIPT_CONFIG.PROJECT_EMBEDDING_DIMENSIONS).toBe(1024);
    });

    it('uses environment variables when set', async () => {
      process.env.DOCS_SOURCE_PATH = '/path/to/docs';
      process.env.PROJECT_SOURCE_PATH = '/path/to/project';
      process.env.RAG_MCP_PROJECT_IGNORE_PATTERNS = 'node_modules,dist';
      process.env.RAG_MCP_PROJECT_MAX_FILE_BYTES = '1000000';
      process.env.PROJECT_FILE_GLOB = '**/*.ts';
      process.env.PROJECT_WATCH_DEBOUNCE_MS = '2000';
      process.env.INGEST_CONCURRENCY = '5';
      process.env.CHUNK_SIZE = '512';
      process.env.CHUNK_OVERLAP = '64';
      process.env.EMBEDDING_PROVIDER = 'llama.cpp';
      process.env.EMBEDDING_MODEL = 'custom-model';
      process.env.PROJECT_EMBEDDING_DIMENSIONS = '2048';

      const { SCRIPT_CONFIG } = await import('../config.js');

      expect(SCRIPT_CONFIG.DOCS_SOURCE_PATH).toBe('/path/to/docs');
      expect(SCRIPT_CONFIG.PROJECT_SOURCE_PATH).toBe('/path/to/project');
      expect(SCRIPT_CONFIG.PROJECT_IGNORE_PATTERNS).toBe('node_modules,dist');
      expect(SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES).toBe(1000000);
      expect(SCRIPT_CONFIG.PROJECT_FILE_GLOB).toBe('**/*.ts');
      expect(SCRIPT_CONFIG.PROJECT_WATCH_DEBOUNCE_MS).toBe(2000);
      expect(SCRIPT_CONFIG.CONCURRENCY_LIMIT).toBe(5);
      expect(SCRIPT_CONFIG.CHUNK_SIZE).toBe(512);
      expect(SCRIPT_CONFIG.CHUNK_OVERLAP).toBe(64);
      expect(SCRIPT_CONFIG.EMBEDDING_PROVIDER).toBe('llamacpp');
      expect(SCRIPT_CONFIG.EMBEDDING_MODEL).toBe('custom-model');
      expect(SCRIPT_CONFIG.PROJECT_EMBEDDING_DIMENSIONS).toBe(2048);
    });

    it('does not warn at module load when optional source paths are unset', async () => {
      process.env.DOCS_SOURCE_PATH = undefined as unknown as string;
      process.env.PROJECT_SOURCE_PATH = undefined as unknown as string;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await import('../config.js');

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('does not warn when both paths are set', async () => {
      process.env.DOCS_SOURCE_PATH = '/path/to/docs';
      process.env.PROJECT_SOURCE_PATH = '/path/to/project';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await import('../config.js');

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('handles invalid number values gracefully', async () => {
      process.env.RAG_MCP_PROJECT_MAX_FILE_BYTES = 'invalid';
      process.env.PROJECT_WATCH_DEBOUNCE_MS = 'invalid';
      process.env.INGEST_CONCURRENCY = 'invalid';
      process.env.CHUNK_SIZE = 'invalid';
      process.env.CHUNK_OVERLAP = 'invalid';
      process.env.PROJECT_EMBEDDING_DIMENSIONS = 'invalid';
      process.env.DOCS_SOURCE_PATH = '/docs';
      process.env.PROJECT_SOURCE_PATH = '/project';

      const { SCRIPT_CONFIG } = await import('../config.js');

      // Number() returns NaN for invalid, and NaN || default returns default
      expect(SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES).toBe(5000000);
      expect(SCRIPT_CONFIG.PROJECT_WATCH_DEBOUNCE_MS).toBe(1500);
      expect(SCRIPT_CONFIG.CONCURRENCY_LIMIT).toBe(10);
      expect(SCRIPT_CONFIG.CHUNK_SIZE).toBe(1000);
      expect(SCRIPT_CONFIG.CHUNK_OVERLAP).toBe(100);
      expect(SCRIPT_CONFIG.PROJECT_EMBEDDING_DIMENSIONS).toBe(1024);
    });

    it('rejects non-llama.cpp embedding providers', async () => {
      process.env.EMBEDDING_PROVIDER = 'ollama';

      await expect(import('../config.js')).rejects.toThrow(
        'Unsupported EMBEDDING_PROVIDER "ollama". This RAG system requires llama.cpp.'
      );
    });
  });
});
