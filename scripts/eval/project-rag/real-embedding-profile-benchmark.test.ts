import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLlamaCppGpuOffloadDuringRequest } from '../../check-embedding-health.js';
import {
  formatRealProjectEmbeddingProfileBenchmark,
  resolveRealEmbeddingProfiles,
  runRealProjectEmbeddingProfileBenchmark,
} from './real-embedding-profile-benchmark.js';

vi.mock('../../check-embedding-health.js', () => ({
  checkLlamaCppGpuOffloadDuringRequest: vi.fn(
    async (_provider: string, _baseUrl: string, operation: () => Promise<unknown>) => ({
      gpu: { ok: true, message: 'GPU offload proven for llama.cpp PID 1234' },
      value: await operation(),
    })
  ),
}));

function makeEmbedding(dimensions: number, seed: number): number[] {
  return Array.from({ length: dimensions }, (_, index) => Math.sin(seed + index) * 0.01);
}

function mockEmbeddingFetch(dimensions: number) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/health')) {
      return new Response('OK', { status: 200 });
    }

    if (target.endsWith('/v1/embeddings')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
      const inputs = body.input ?? [];
      return Response.json({
        data: inputs.map((value, index) => ({
          index,
          embedding: makeEmbedding(dimensions, value.length + index),
        })),
      });
    }

    return new Response('not found', { status: 404 });
  });
}

describe('real project rag embedding profile benchmark', () => {
  afterEach(() => {
    vi.mocked(checkLlamaCppGpuOffloadDuringRequest).mockClear();
    vi.unstubAllGlobals();
  });

  it('blocks the 1024d profile when no dedicated endpoint is configured', async () => {
    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-0.6b-1024'],
      env: {},
    });

    expect(report.mode).toBe('real-provider');
    expect(report.dryRun).toBe(false);
    expect(report.profiles).toHaveLength(1);
    expect(report.profiles[0]?.status).toBe('blocked');
    expect(report.profiles[0]?.blockReason).toContain('No 1024D endpoint configured');
  });

  it('supports dry-run without contacting embedding endpoints', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-8b-4096'],
      env: { PROJECT_RAG_4096_BASE_URL: 'http://127.0.0.1:9999' },
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report.profiles[0]?.status).toBe('dry-run');
    expect(report.profiles[0]?.corpusSize).toBeGreaterThan(0);
  });

  it('runs a bounded provider-backed fixture benchmark when dimensions match', async () => {
    vi.stubGlobal('fetch', mockEmbeddingFetch(4096));

    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-8b-4096'],
      env: { PROJECT_RAG_4096_BASE_URL: 'http://127.0.0.1:9999' },
    });

    const profile = report.profiles[0];
    expect(profile?.status).toBe('passed');
    expect(profile?.expectedDimensions).toBe(4096);
    expect(profile?.metrics?.scenarioCount).toBeGreaterThan(0);
    expect(profile?.indexEmbeddingLatencyMs).toBeGreaterThanOrEqual(0);

    const formatted = formatRealProjectEmbeddingProfileBenchmark(report);
    expect(formatted).toContain('Real Embedding Profile Benchmark');
    expect(formatted).toContain('qwen3-8b-4096');
  });

  it('blocks an endpoint that returns the wrong dimensions for the requested profile', async () => {
    vi.stubGlobal('fetch', mockEmbeddingFetch(4096));

    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-0.6b-1024'],
      env: { PROJECT_RAG_1024_BASE_URL: 'http://127.0.0.1:9998' },
    });

    expect(report.profiles[0]?.status).toBe('blocked');
    expect(report.profiles[0]?.blockReason).toContain('dimension mismatch');
  });

  it('blocks an endpoint when GPU offload is not proven', async () => {
    vi.stubGlobal('fetch', mockEmbeddingFetch(1024));
    vi.mocked(checkLlamaCppGpuOffloadDuringRequest).mockImplementationOnce(
      async (_provider, _baseUrl, operation) => ({
        gpu: { ok: false, message: 'llama.cpp GPU offload unproven' },
        value: await operation(),
      })
    );

    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-0.6b-1024'],
      env: { PROJECT_RAG_1024_BASE_URL: 'http://127.0.0.1:9998' },
    });

    expect(report.profiles[0]?.status).toBe('blocked');
    expect(report.profiles[0]?.blockReason).toContain('GPU proof failed');
  });

  it('classifies unreachable endpoints as blocked instead of failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unable to connect. Is the computer able to access the url?');
      })
    );

    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-8b-4096'],
      env: { PROJECT_RAG_4096_BASE_URL: 'http://127.0.0.1:8081' },
    });

    expect(report.profiles[0]?.status).toBe('blocked');
    expect(report.profiles[0]?.blockReason).toContain('Unable to connect');
  });

  it('keeps 1024d endpoint configuration separate from the default 4096d endpoint', () => {
    const profiles = resolveRealEmbeddingProfiles({
      LLAMACPP_BASE_URL: 'http://127.0.0.1:8081',
    });

    expect(profiles['qwen3-8b-4096'].baseUrl).toBe('http://127.0.0.1:8081');
    expect(profiles['qwen3-0.6b-1024'].baseUrl).toBeUndefined();
  });

  it('redacts credentials from embedding API error response bodies', async () => {
    let embedCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith('/health')) return new Response('OK', { status: 200 });
        if (target.endsWith('/v1/embeddings')) {
          embedCalls++;
          if (embedCalls === 1) {
            const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
            const inputs = body.input ?? [];
            return Response.json({
              data: inputs.map((_value: string, index: number) => ({
                index,
                embedding: makeEmbedding(1024, index),
              })),
            });
          }
          return new Response(
            JSON.stringify({
              error: 'Invalid key: sk-test-key-abc-12345', // gitleaks:allow
              details: 'api_key=super-secret-token-67890',
            }),
            { status: 401, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('not found', { status: 404 });
      })
    );

    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-0.6b-1024'],
      env: { PROJECT_RAG_1024_BASE_URL: 'http://127.0.0.1:9998' },
    });

    const profile = report.profiles[0];
    expect(profile?.status).toBe('failed');
    expect(profile?.error).toContain('[REDACTED');
    // api_key= value is redacted by project-security's generic-api-key pattern
    expect(profile?.error).toContain('[REDACTED:generic-api-key]');
    expect(profile?.error).not.toContain('super-secret-token-67890');
  });

  it('redacts user:pass@ in endpoint when baseUrl contains credentials', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-8b-4096'],
      env: { PROJECT_RAG_4096_BASE_URL: 'http://user:vo5secreta@llama-srv:8081' },
      dryRun: true,
    });

    const profile = report.profiles[0];
    expect(profile?.endpoint).toContain('[REDACTED:userinfo]');
    expect(profile?.endpoint).toContain('llama-srv');
    expect(profile?.endpoint).not.toContain('vo5secreta');
    expect(profile?.endpoint).not.toContain('user:vo5secreta');

    const formatted = formatRealProjectEmbeddingProfileBenchmark(report);
    expect(formatted).toContain('[REDACTED:userinfo]');
    expect(formatted).not.toContain('vo5secreta');
  });

  it('redacts credentials from GPU proof failure details', async () => {
    vi.stubGlobal('fetch', mockEmbeddingFetch(1024));
    vi.mocked(checkLlamaCppGpuOffloadDuringRequest).mockImplementationOnce(
      async (_provider, _baseUrl, operation) => ({
        gpu: {
          ok: false,
          message: 'llama.cpp GPU offload unproven',
          details: 'llama-server url: http://user:vo5secreta@llama-srv:8081',
        },
        value: await operation(),
      })
    );

    const report = await runRealProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
      fixtureIds: ['fixture-ts-service'],
      profileIds: ['qwen3-0.6b-1024'],
      env: { PROJECT_RAG_1024_BASE_URL: 'http://127.0.0.1:9998' },
    });

    const profile = report.profiles[0];
    expect(profile?.status).toBe('blocked');
    expect(profile?.blockReason).toContain('[REDACTED:userinfo]');
    expect(profile?.blockReason).toContain('GPU proof failed');
    expect(profile?.blockReason).not.toContain('vo5secreta');
  });
});
