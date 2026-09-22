import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRagPostgresEmbeddingConfig } from './embeddings.js';
import { PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH } from './embeddings.js';
import {
  clearProjectRagRuntimeReadinessForTesting,
  ensureProjectRagRuntimeReady,
} from './runtime-readiness.js';

const healthMocks = vi.hoisted(() => ({
  checkModel: vi.fn(),
  checkLlamaCppGpuOffloadDuringRequest: vi.fn(),
}));

vi.mock('../check-embedding-health.js', () => healthMocks);

const EMBEDDING_CONFIG: ProjectRagPostgresEmbeddingConfig = {
  provider: 'llamacpp',
  model: 'qwen3-embedding-1024',
  baseUrl: 'http://127.0.0.1:18082',
  dimensions: 1024,
  timeoutMs: 1_000,
  profileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
};

const ISOLATED_ENV: NodeJS.ProcessEnv = {
  PROJECT_RAG_PREPARE_RUNTIME: 'test',
  PROJECT_RAG_PREPARE_TIMEOUT_MS: '500',
  PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:63514/rag_v2_migration_prepare_journeys',
  PROJECT_RAG_PG_EMBEDDING_BASE_URL: 'http://127.0.0.1:18082',
  PROJECT_RAG_PG_EMBEDDING_MODEL: 'qwen3-embedding-1024',
  PROJECT_RAG_EMBEDDING_START_COMMAND: 'task-owned-start-command',
};

afterEach(() => {
  clearProjectRagRuntimeReadinessForTesting();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('Project RAG preparation runtime readiness', () => {
  it('fails closed before startup when isolated lifecycle configuration is incomplete', async () => {
    await expect(
      ensureProjectRagRuntimeReady({
        env: { PROJECT_RAG_PREPARE_RUNTIME: 'isolated_dev' },
      })
    ).rejects.toMatchObject({
      code: 'RUNTIME_CONFIGURATION_MISSING',
    });
  });

  it('fails closed for an explicit isolated lane without complete runtime settings', async () => {
    await expect(
      ensureProjectRagRuntimeReady({
        env: { PROJECT_RAG_PREPARE_RUNTIME: 'isolated_dev' },
      })
    ).rejects.toMatchObject({
      code: 'RUNTIME_CONFIGURATION_MISSING',
    });
  });

  it('rejects known official database ownership in an isolated lane', async () => {
    await expect(
      ensureProjectRagRuntimeReady({
        env: {
          ...ISOLATED_ENV,
          PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/project_rag',
          PROJECT_RAG_PG_EMBEDDING_BASE_URL: 'http://127.0.0.1:8082',
        },
      })
    ).rejects.toMatchObject({
      code: 'RUNTIME_OWNERSHIP_CONFLICT',
    });
  });

  it('probes the real vector and shares concurrent readiness work by runtime identity', async () => {
    const ensureEmbedding = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const checkDatabase = vi.fn(async () => undefined);
    const fetchEmbeddings = vi.fn(async () => [new Array(1024).fill(0)]);
    const options = {
      env: ISOLATED_ENV,
      deadlineMs: 1_000,
      ensureEmbedding,
      checkDatabase,
      resolveEmbedding: () => EMBEDDING_CONFIG,
      fetchEmbeddings,
    };

    const [first, second] = await Promise.all([
      ensureProjectRagRuntimeReady(options),
      ensureProjectRagRuntimeReady(options),
    ]);

    expect(first.identity).toMatchObject({
      lane: 'test',
      owner: 'test_injected',
      databaseConfigured: true,
      embedding: {
        model: 'qwen3-embedding-1024',
        baseUrl: 'http://127.0.0.1:18082',
        dimensions: 1024,
        ready: true,
      },
    });
    expect(second.identity).toEqual(first.identity);
    expect(checkDatabase).toHaveBeenCalledTimes(1);
    expect(ensureEmbedding).toHaveBeenCalledTimes(1);
    expect(fetchEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('keeps the long caller alive when a later short caller times out', async () => {
    let releaseProbe!: () => void;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const fetchEmbeddings = vi.fn(async () => {
      await probeReleased;
      return [new Array(1024).fill(0)];
    });
    const options = {
      env: ISOLATED_ENV,
      checkDatabase: async () => undefined,
      ensureEmbedding: async () => undefined,
      resolveEmbedding: () => EMBEDDING_CONFIG,
      fetchEmbeddings,
    };

    const longCaller = ensureProjectRagRuntimeReady({ ...options, deadlineMs: 300 });
    await vi.waitFor(() => expect(fetchEmbeddings).toHaveBeenCalledTimes(1));
    const shortCaller = ensureProjectRagRuntimeReady({ ...options, deadlineMs: 20 });
    const shortOutcome = shortCaller.catch((error: unknown) => error);

    await expect(shortOutcome).resolves.toMatchObject({ code: 'RUNTIME_DEADLINE_EXCEEDED' });
    releaseProbe();
    await expect(longCaller).resolves.toMatchObject({ identity: { embedding: { ready: true } } });
    expect(fetchEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('lets a later long caller reconnect after the first short caller times out', async () => {
    let releaseProbe!: () => void;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const fetchEmbeddings = vi.fn(async () => {
      await probeReleased;
      return [new Array(1024).fill(0)];
    });
    const options = {
      env: ISOLATED_ENV,
      checkDatabase: async () => undefined,
      ensureEmbedding: async () => undefined,
      resolveEmbedding: () => EMBEDDING_CONFIG,
      fetchEmbeddings,
    };

    const shortCaller = ensureProjectRagRuntimeReady({ ...options, deadlineMs: 20 });
    const shortOutcome = shortCaller.catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchEmbeddings).toHaveBeenCalledTimes(1));
    const longCaller = ensureProjectRagRuntimeReady({ ...options, deadlineMs: 300 });

    await expect(shortOutcome).resolves.toMatchObject({ code: 'RUNTIME_DEADLINE_EXCEEDED' });
    releaseProbe();
    await expect(longCaller).resolves.toMatchObject({ identity: { embedding: { ready: true } } });
    expect(fetchEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('does not cancel the runtime owner when a caller aborts', async () => {
    let releaseProbe!: () => void;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const fetchEmbeddings = vi.fn(async () => {
      await probeReleased;
      return [new Array(1024).fill(0)];
    });
    const options = {
      env: ISOLATED_ENV,
      checkDatabase: async () => undefined,
      ensureEmbedding: async () => undefined,
      resolveEmbedding: () => EMBEDDING_CONFIG,
      fetchEmbeddings,
    };
    const callerAbort = new AbortController();

    const abortedCaller = ensureProjectRagRuntimeReady({
      ...options,
      deadlineMs: 300,
      signal: callerAbort.signal,
    });
    const abortedOutcome = abortedCaller.catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchEmbeddings).toHaveBeenCalledTimes(1));
    callerAbort.abort();
    await expect(abortedOutcome).resolves.toMatchObject({ code: 'RUNTIME_DEADLINE_EXCEEDED' });

    const reconnectingCaller = ensureProjectRagRuntimeReady({ ...options, deadlineMs: 300 });
    releaseProbe();
    await expect(reconnectingCaller).resolves.toMatchObject({
      identity: { embedding: { ready: true } },
    });
    expect(fetchEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('starts a configured Project database owner before polling readiness', async () => {
    let checks = 0;
    const checkDatabase = vi.fn(async () => {
      checks += 1;
      if (checks === 1) throw new Error('database stopped');
    });

    const result = await ensureProjectRagRuntimeReady({
      env: { ...ISOLATED_ENV, PROJECT_RAG_DATABASE_START_COMMAND: 'true' },
      deadlineMs: 1_000,
      checkDatabase,
      ensureEmbedding: async () => undefined,
      resolveEmbedding: () => EMBEDDING_CONFIG,
      fetchEmbeddings: async () => [new Array(1024).fill(0)],
    });

    expect(result.identity.embedding.ready).toBe(true);
    expect(checkDatabase).toHaveBeenCalledTimes(2);
  });

  it('rejects a wrong dimensional readiness vector', async () => {
    await expect(
      ensureProjectRagRuntimeReady({
        env: ISOLATED_ENV,
        deadlineMs: 1_000,
        checkDatabase: async () => undefined,
        ensureEmbedding: async () => undefined,
        resolveEmbedding: () => EMBEDDING_CONFIG,
        fetchEmbeddings: async () => [new Array(3).fill(0)],
      })
    ).rejects.toMatchObject({
      code: 'EMBEDDING_DIMENSION_MISMATCH',
    });
  });

  it('checks the advertised model and records request-time GPU proof for native readiness', async () => {
    healthMocks.checkModel.mockResolvedValue({
      ok: true,
      level: 'ok',
      message: 'qwen3-embedding-1024',
    });
    healthMocks.checkLlamaCppGpuOffloadDuringRequest.mockResolvedValue({
      gpu: { ok: true, level: 'ok', message: 'GPU offload proven' },
      value: [new Array(1024).fill(0.25)],
    });

    const result = await ensureProjectRagRuntimeReady({
      env: ISOLATED_ENV,
      deadlineMs: 1_000,
      checkDatabase: async () => undefined,
      ensureEmbedding: async () => undefined,
    });

    expect(healthMocks.checkModel).toHaveBeenCalledWith(
      'llamacpp',
      'http://127.0.0.1:18082',
      'qwen3-embedding-1024',
      expect.any(Number)
    );
    expect(result.identity.embedding.gpuProof).toBe('request_journal');
  });

  it('fails native readiness when the endpoint advertises a different model', async () => {
    healthMocks.checkModel.mockResolvedValue({
      ok: false,
      level: 'error',
      message: 'Configured model name not listed',
      details: 'Expected qwen3-embedding-1024; reported another-model',
    });

    await expect(
      ensureProjectRagRuntimeReady({
        env: ISOLATED_ENV,
        deadlineMs: 1_000,
        checkDatabase: async () => undefined,
        ensureEmbedding: async () => undefined,
      })
    ).rejects.toMatchObject({ code: 'EMBEDDING_PROFILE_MISMATCH' });
    expect(healthMocks.checkLlamaCppGpuOffloadDuringRequest).not.toHaveBeenCalled();
  });
});
