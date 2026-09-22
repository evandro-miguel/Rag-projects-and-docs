import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureEmbeddingProvider,
  main,
  resolveEmbeddingStartSpec,
  resolveEnsureTarget,
} from './ensure-embedding-provider.js';

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  return child;
}

describe('resolveEnsureTarget', () => {
  it('defaults to the required Project RAG 1024D GPU lane', () => {
    expect(resolveEnsureTarget({})).toEqual({
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8082',
      model: 'qwen3-embedding-1024',
    });
  });

  it('preserves explicit llama.cpp compatibility overrides', () => {
    expect(
      resolveEnsureTarget({
        LLAMACPP_BASE_URL: 'http://127.0.0.1:8081',
        LLAMACPP_EMBEDDING_MODEL: 'qwen3-embedding',
      })
    ).toEqual({
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8081',
      model: 'qwen3-embedding',
    });
  });

  it('ignores model-only llama.cpp env and stays on the Project RAG GPU lane', () => {
    expect(
      resolveEnsureTarget({
        LLAMACPP_EMBEDDING_MODEL: 'qwen3-embedding',
      })
    ).toEqual({
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8082',
      model: 'qwen3-embedding-1024',
    });
  });

  it('rejects Ollama provider configuration', () => {
    expect(() => resolveEnsureTarget({ EMBEDDING_PROVIDER: 'ollama' })).toThrow(
      'Unsupported EMBEDDING_PROVIDER "ollama". This RAG system requires llama.cpp.'
    );
  });

  it('defaults to the portable llama.cpp launcher', () => {
    const startSpec = resolveEmbeddingStartSpec({});

    expect(startSpec.command).toBe('bash');
    expect(startSpec.args[0]).toMatch(/start-llamacpp-embedding-gpu\.sh$/u);
    expect(startSpec.shell).toBe(false);
  });

  it('preserves an explicit start command while pinning the repository cwd', () => {
    const startSpec = resolveEmbeddingStartSpec({
      EMBEDDING_START_COMMAND: 'custom-start --profile project',
    });

    expect(startSpec.command).toBe('custom-start --profile project');
    expect(startSpec.args).toEqual([]);
    expect(startSpec.cwd).toBe(fileURLToPath(new URL('..', import.meta.url)));
    expect(startSpec.shell).toBe(true);
  });

  it('does not spawn when the endpoint is already healthy', async () => {
    const spawnImpl = vi.fn();

    await ensureEmbeddingProvider({
      quiet: true,
      env: {},
      fetchImpl: async () => new Response(null, { status: 200 }),
      spawnImpl: spawnImpl as never,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('starts once and waits for readiness when the endpoint is initially unavailable', async () => {
    const responses = [false, false, true];
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: responses.shift() ? 200 : 503 })
    );
    const child = fakeChildProcess();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }) as never;
    let nowMs = 0;

    await ensureEmbeddingProvider({
      quiet: true,
      env: {
        EMBEDDING_AUTOSTART: '1',
        EMBEDDING_START_TIMEOUT_MS: '100',
        EMBEDDING_START_POLL_INTERVAL_MS: '1',
      },
      fetchImpl,
      spawnImpl,
      sleepImpl: async () => {
        nowMs += 1;
      },
      now: () => nowMs,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('fails promptly when the detached start command emits an error', async () => {
    const child = fakeChildProcess();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    }) as never;

    await expect(
      ensureEmbeddingProvider({
        quiet: true,
        env: {
          EMBEDDING_AUTOSTART: '1',
          EMBEDDING_START_TIMEOUT_MS: '120000',
          EMBEDDING_START_POLL_INTERVAL_MS: '10000',
        },
        fetchImpl: async () => new Response(null, { status: 503 }),
        spawnImpl,
        sleepImpl: () => new Promise(() => undefined),
      })
    ).rejects.toThrow('spawn failed');
  });

  it('fails promptly when the detached start command exits nonzero', async () => {
    const child = fakeChildProcess();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 7, null));
      return child;
    }) as never;

    await expect(
      ensureEmbeddingProvider({
        quiet: true,
        env: {
          EMBEDDING_AUTOSTART: '1',
          EMBEDDING_START_TIMEOUT_MS: '120000',
          EMBEDDING_START_POLL_INTERVAL_MS: '10000',
        },
        fetchImpl: async () => new Response(null, { status: 503 }),
        spawnImpl,
        sleepImpl: () => new Promise(() => undefined),
      })
    ).rejects.toThrow('exited with code 7');
  });

  it('fails within the configured bound when startup never becomes ready', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const spawnImpl = vi.fn(() => fakeChildProcess()) as never;
    let nowMs = 0;

    await expect(
      ensureEmbeddingProvider({
        quiet: true,
        env: {
          EMBEDDING_AUTOSTART: '1',
          EMBEDDING_START_TIMEOUT_MS: '3',
          EMBEDDING_START_POLL_INTERVAL_MS: '1',
        },
        fetchImpl,
        spawnImpl,
        sleepImpl: async () => {
          nowMs += 1;
        },
        now: () => nowMs,
      })
    ).rejects.toThrow('within 3ms');

    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('fails fast without spawning when the default endpoint is unavailable', async () => {
    const spawnImpl = vi.fn();

    await expect(
      ensureEmbeddingProvider({
        quiet: true,
        env: {
          EMBEDDING_START_TIMEOUT_MS: '1',
          EMBEDDING_START_POLL_INTERVAL_MS: '1',
        },
        fetchImpl: async () => new Response(null, { status: 503 }),
        spawnImpl: spawnImpl as never,
      })
    ).rejects.toThrow('no local service was started');

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('does not start the local owner for an unreachable explicit remote endpoint', async () => {
    const spawnImpl = vi.fn();

    await expect(
      ensureEmbeddingProvider({
        quiet: true,
        env: {
          LLAMACPP_BASE_URL: 'https://embeddings.example.test',
        },
        fetchImpl: async () => new Response(null, { status: 503 }),
        spawnImpl: spawnImpl as never,
      })
    ).rejects.toThrow('no local service was started');

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.each([
    'LLAMACPP_START_COMMAND',
    'RAG_LLAMACPP_START_COMMAND',
  ])('honors the %s alias for an explicit endpoint', async (startVariable) => {
    const responses = [false, true];
    const spawnImpl = vi.fn(() => fakeChildProcess()) as never;
    let nowMs = 0;

    await ensureEmbeddingProvider({
      quiet: true,
      env: {
        LLAMACPP_BASE_URL: 'https://embeddings.example.test',
        [startVariable]: 'custom-start',
        EMBEDDING_START_TIMEOUT_MS: '10',
        EMBEDDING_START_POLL_INTERVAL_MS: '1',
      },
      fetchImpl: async () => new Response(null, { status: responses.shift() ? 200 : 503 }),
      spawnImpl,
      sleepImpl: async () => {
        nowMs += 1;
      },
      now: () => nowMs,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      'custom-start',
      [],
      expect.objectContaining({ shell: true })
    );
  });

  it('runs the CLI main path against an already healthy explicit endpoint', async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      LLAMACPP_BASE_URL: 'http://127.0.0.1:18082',
    };
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const consoleMock = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    try {
      await main();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(consoleMock).toHaveBeenCalledWith(
        expect.stringContaining('Embedding provider llamacpp is available')
      );
    } finally {
      process.env = originalEnv;
      vi.unstubAllGlobals();
      consoleMock.mockRestore();
    }
  });
});

describe('package lifecycle hooks', () => {
  it('runs the embedding readiness prehook for eval:docs-live', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['preeval:docs-live']).toBe('bun run preeval');
  });

  it('does not opt test or eval hooks into embedding autostart', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.pretest).toBeUndefined();
    expect(packageJson.scripts?.test).toBe('vitest run');
    expect(packageJson.scripts?.preeval).not.toContain('EMBEDDING_AUTOSTART=1');
  });
});
