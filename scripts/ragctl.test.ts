import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectRagPostgresEmbeddingConfig } from './project-rag/embeddings.js';
import {
  enforceReadOnlyProjectIntent,
  normalizeDocsRagLabSearchReport,
  parseRagctlArgs,
  RagctlError,
  type RagctlService,
  resolveDocsRagReadiness,
  resolveDocsSearchBackendSourceIds,
  resolveRagctlDocsRagLabConfig,
  resolveRagctlProjectBackend,
  runRagctl,
} from './ragctl.js';

const mocks = vi.hoisted(() => ({
  checkLlamaCppGpuOffloadDuringRequest: vi.fn(),
  checkDocsRagLabDatabaseHealth: vi.fn(),
  checkDocsRagLabCorpusHealth: vi.fn(),
  readDocsRagFreshness: vi.fn(),
}));

vi.mock('./check-embedding-health.js', () => ({
  checkLlamaCppGpuOffloadDuringRequest: mocks.checkLlamaCppGpuOffloadDuringRequest,
}));
vi.mock('./docs-rag/db.js', () => ({
  checkDocsRagLabDatabaseHealth: mocks.checkDocsRagLabDatabaseHealth,
  checkDocsRagLabCorpusHealth: mocks.checkDocsRagLabCorpusHealth,
}));
vi.mock('./lib/docs-rag-freshness.js', () => ({
  readDocsRagFreshness: mocks.readDocsRagFreshness,
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.values(mocks).forEach((mock) => {
    mock.mockReset();
  });
  vi.unstubAllEnvs();
});

function parseJson(stdout: string) {
  return JSON.parse(stdout) as {
    ok: boolean;
    command?: string;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
    warnings?: string[];
  };
}

function readOkData(result: { stdout: string }) {
  const payload = parseJson(result.stdout);
  expect(payload.ok).toBe(true);
  return payload.data as Record<string, unknown>;
}

function createFakeService(overrides: Partial<RagctlService> = {}): RagctlService {
  return {
    health: async () => ({ status: 'ok' }),
    docsHealth: async () => ({
      status: 'ok',
      docsPostgres: { status: 'healthy' },
      docsFreshness: { status: 'ok' },
      capabilities: { docsSearch: true },
    }),
    listProjects: async () => ({ projects: [{ id: 'p1', slug: 'rag-v2' }], count: 1 }),
    searchDocs: async (args) => ({
      query: args.query,
      limit: args.limit,
      categories: args.categories,
      sourceIds: args.sourceIds,
      language: args.language,
      kind: args.kind,
      authority: args.authority,
      tags: args.tags,
      mode: args.mode,
    }),
    searchProject: async (args) => ({
      project: args.project,
      query: args.query,
      mode: args.mode,
      limit: args.limit,
    }),
    getProjectFile: async (args) => ({ project: args.project, file: args.file, limit: args.limit }),
    getProjectOutline: async (args) => ({
      project: args.project,
      file: args.file,
      limit: args.limit,
    }),
    findProjectSymbol: async (args) => ({
      project: args.project,
      name: args.name,
      type: args.type,
      limit: args.limit,
    }),
    verifyProject: async (args) => ({ project: args.project, status: 'ok' }),
    prepareProject: async (args) => ({
      status: 'ready',
      ready: true,
      operation: { id: 'test-operation', deduplicated: false },
      stage: 'ready',
      project: {
        slug: args.project ?? 'test-project',
        name: args.project ?? 'test-project',
        rootPath: args.rootPath,
        includeRoots: args.includeRoots ?? ['src'],
        existing: Boolean(args.project),
      },
      progress: {
        batch: 0,
        maxBatches: args.maxBatches ?? 32,
        indexed: 0,
        selected: 0,
        scanned: 0,
        deleted: 0,
        embeddings: 0,
        errors: 0,
        remaining: 0,
        elapsedMs: 0,
      },
    }),
    ...overrides,
  };
}

describe('ragctl', () => {
  it('separates Docs search availability from release readiness', () => {
    expect(
      resolveDocsRagReadiness({
        docsPostgresStatus: 'healthy',
        docsCorpusStatus: 'healthy',
        docsFreshnessStatus: 'stale',
        embeddingAvailable: true,
      })
    ).toEqual({ keywordSearchAvailable: true, searchAvailable: true, ready: false });
    expect(
      resolveDocsRagReadiness({
        docsPostgresStatus: 'healthy',
        docsCorpusStatus: 'unhealthy',
        docsFreshnessStatus: 'ok',
        embeddingAvailable: true,
      })
    ).toEqual({ keywordSearchAvailable: false, searchAvailable: false, ready: false });
    expect(
      resolveDocsRagReadiness({
        docsPostgresStatus: 'healthy',
        docsCorpusStatus: 'healthy',
        docsFreshnessStatus: 'ok',
        embeddingAvailable: true,
      })
    ).toEqual({ keywordSearchAvailable: true, searchAvailable: true, ready: true });
    expect(
      resolveDocsRagReadiness({
        docsPostgresStatus: 'healthy',
        docsCorpusStatus: 'healthy',
        docsFreshnessStatus: 'ok',
        embeddingAvailable: false,
      })
    ).toEqual({ keywordSearchAvailable: true, searchAvailable: false, ready: false });
  });

  it('keeps unfiltered docs search broad and uses the sentinel only for unmatched filters', () => {
    expect(resolveDocsSearchBackendSourceIds({})).toBeUndefined();
    expect(resolveDocsSearchBackendSourceIds({ language: 'nonexistent' })).toEqual([
      '__no_matching_source__',
    ]);
    expect(resolveDocsSearchBackendSourceIds({ category: 'typescript' })).toEqual([
      'typescript-docs',
    ]);
  });

  it('parses flags, options, and positionals without hiding query words', () => {
    const parsed = parseRagctlArgs([
      'project',
      'search',
      '--project',
      'rag-v2',
      'search_project_code',
      '--limit=5',
      '--json',
    ]);

    expect(parsed.positionals).toEqual(['project', 'search', 'search_project_code']);
    expect(parsed.options.get('project')).toBe('rag-v2');
    expect(parsed.options.get('limit')).toBe('5');
    expect(parsed.flags.has('json')).toBe(true);
  });

  it('forces read-only project intent for CLI commands', () => {
    const env: NodeJS.ProcessEnv = {};
    enforceReadOnlyProjectIntent(env);

    expect(env.RAG_PROJECT_SESSION_INTENT).toBe('read_only');
    expect(env.RAG_PROJECT_WATCHER_ENABLED).toBe('false');
  });

  it('throws when Docs RAG PG lab database URL is not configured', () => {
    expect(() => resolveRagctlDocsRagLabConfig({})).toThrow(
      'DOCS_RAG_PG_LAB_DATABASE_URL is required but not set'
    );
  });

  it('preserves explicit Docs RAG PG lab database URL from environment', () => {
    const config = resolveRagctlDocsRagLabConfig({
      DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://test-user:test-pass@127.0.0.1:5542/test_db',
    });

    expect(config.database.url).toBe('postgres://test-user:test-pass@127.0.0.1:5542/test_db');
  });

  it('keeps a healthy 24-source Docs corpus on the Docs embedding lane', async () => {
    const docsEnv = {
      DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://docs-test@127.0.0.1:5542/docs_test',
      DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL: 'http://127.0.0.1:18082',
      DOCS_RAG_PG_LAB_EMBEDDING_MODEL: 'docs-test-model',
    };
    vi.stubEnv('DOCS_RAG_PG_LAB_DATABASE_URL', docsEnv.DOCS_RAG_PG_LAB_DATABASE_URL);
    vi.stubEnv('DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL', docsEnv.DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL);
    vi.stubEnv('DOCS_RAG_PG_LAB_EMBEDDING_MODEL', docsEnv.DOCS_RAG_PG_LAB_EMBEDDING_MODEL);

    const config = resolveRagctlDocsRagLabConfig(docsEnv);
    mocks.checkDocsRagLabDatabaseHealth.mockResolvedValue({ status: 'healthy' });
    mocks.checkDocsRagLabCorpusHealth.mockResolvedValue({
      status: 'healthy',
      documents: 24,
      unexpectedSourceIds: [],
      invalidPathCount: 0,
      sourcePathMismatchCount: 0,
      missingMetadataCount: 0,
    });
    mocks.readDocsRagFreshness.mockReturnValue({ status: 'ok' });
    mocks.checkLlamaCppGpuOffloadDuringRequest.mockImplementation(
      async (_provider: string, _baseUrl: string, operation: () => Promise<unknown>) => ({
        gpu: { ok: true, message: 'test GPU proof' },
        value: await operation(),
      })
    );
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ embedding: new Array(1024).fill(0) }] })
    );
    globalThis.fetch = Object.assign(fetchMock, originalFetch);

    const result = await runRagctl(['docs', 'health', '--json']);
    const data = readOkData(result);

    expect(result.exitCode).toBe(0);
    expect(data.status).toBe('ok');
    expect(data.docsCorpus).toMatchObject({ status: 'healthy', documents: 24 });
    expect(data.embeddings).toMatchObject({ ok: true, model: 'docs-test-model' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18082/v1/embeddings',
      expect.objectContaining({
        body: JSON.stringify({ model: 'docs-test-model', input: ['ragctl health'] }),
      })
    );
    expect(() =>
      resolveProjectRagPostgresEmbeddingConfig({
        DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL: docsEnv.DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL,
      })
    ).toThrow('DOCS_RAG_PG_LAB_*');
    expect(config.embedding.model).toBe('docs-test-model');
  });

  it('does not let a blocking embedding GPU probe starve Docs corpus health', async () => {
    vi.stubEnv('DOCS_RAG_PG_LAB_DATABASE_URL', 'postgres://docs-test@127.0.0.1:5542/docs_test');
    vi.stubEnv('DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL', 'http://127.0.0.1:18082');
    vi.stubEnv('DOCS_RAG_PG_LAB_EMBEDDING_MODEL', 'docs-test-model');

    let embeddingProbeStarted = false;
    mocks.checkDocsRagLabDatabaseHealth.mockResolvedValue({ status: 'healthy' });
    mocks.checkDocsRagLabCorpusHealth.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(
              embeddingProbeStarted
                ? {
                    status: 'unhealthy',
                    documents: 0,
                    unexpectedSourceIds: [],
                    invalidPathCount: 0,
                    sourcePathMismatchCount: 0,
                    missingMetadataCount: 0,
                    message: 'Corpus health probe timed out after 5s.',
                  }
                : {
                    status: 'healthy',
                    documents: 24,
                    unexpectedSourceIds: [],
                    invalidPathCount: 0,
                    sourcePathMismatchCount: 0,
                    missingMetadataCount: 0,
                  }
            );
          }, 0);
        })
    );
    mocks.readDocsRagFreshness.mockReturnValue({ status: 'ok' });
    mocks.checkLlamaCppGpuOffloadDuringRequest.mockImplementation(async () => {
      embeddingProbeStarted = true;
      const end = performance.now() + 25;
      while (performance.now() < end) {
        // Model synchronous journal/process inspection in the GPU proof helper.
      }
      return {
        gpu: { ok: true, message: 'test GPU proof' },
        value: [new Array(1024).fill(0)],
      };
    });

    const result = await runRagctl(['docs', 'health', '--json']);
    const data = readOkData(result);

    expect(result.exitCode).toBe(0);
    expect(data.docsCorpus).toMatchObject({ status: 'healthy', documents: 24 });
    expect(data.embeddings).toMatchObject({ ok: true, expectedDimensions: 1024 });
    expect(mocks.checkLlamaCppGpuOffloadDuringRequest).toHaveBeenCalledTimes(1);
  });

  it('forces Project RAG reads to Postgres', () => {
    expect(resolveRagctlProjectBackend()).toBe('postgres');
  });

  it('does not reference Convex runtime modules in ragctl', () => {
    const source = readFileSync(new URL('./ragctl.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('../convex/');
  });

  it('uses request-correlated GPU proof for live embedding readiness', () => {
    const source = readFileSync(new URL('./ragctl.ts', import.meta.url), 'utf8');

    expect(source).toContain('checkLlamaCppGpuOffloadDuringRequest');
    expect(source).not.toContain("checkLlamaCppGpuOffload('llamacpp'");
  });

  it('resolves Docs freshness from the configured repository root instead of caller cwd', () => {
    const source = readFileSync(new URL('./ragctl.ts', import.meta.url), 'utf8');

    expect(source).toContain("import { normalizeEnvValue, REPO_ROOT } from './lib/runtime-env.js'");
    expect(source.match(/readDocsRagFreshness\(\{ cwd: REPO_ROOT \}\)/g)).toHaveLength(2);
    expect(source).toContain('readDocsRagFreshness({ cwd: REPO_ROOT })');
    expect(source).not.toContain('readDocsRagFreshness()');
    expect(source).toMatch(/docsFreshness = readDocsRagFreshness\(\{ cwd: REPO_ROOT \}\)/);
  });

  it('keeps embedding availability independent of GPU proof and counts projects separately', () => {
    const source = readFileSync(new URL('./ragctl.ts', import.meta.url), 'utf8');

    // Availability is dimension match after a real embedding request, not gpu.ok.
    expect(source).toContain('const dimensionsMatch = embedding.length === config.dimensions');
    expect(source).toContain('ok: dimensionsMatch');
    expect(source).not.toMatch(/if\s*\(\s*!gpu\.ok\s*\)/);
    // projectCount must come from COUNT(*), not list({ limit: 1 }).length
    expect(source).toContain('countProjectRagPostgresProjects');
    expect(source).toContain('projectCount,');
    expect(source).not.toContain('projectCount: projects.length');
    // Sample must prefer a substantive index, not most-recently-updated empty fixture.
    expect(source).toContain('findProjectRagPostgresHealthSample');
  });

  it('returns JSON for health', async () => {
    const result = await runRagctl(['health', '--json'], () => createFakeService());
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('health');
    expect(payload.data?.status).toBe('ok');
  });

  it('returns JSON for docs health without calling the general health path', async () => {
    const generalHealth = vi.fn(async () => ({ status: 'should-not-run' }));
    const docsHealth = vi.fn(async () => ({
      status: 'ok',
      docsPostgres: { status: 'healthy' },
      docsFreshness: { status: 'ok' },
      capabilities: { docsSearch: true },
    }));
    const result = await runRagctl(['docs', 'health', '--json'], () =>
      createFakeService({ docsHealth, health: generalHealth })
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe('docs health');
    expect(payload.data?.status).toBe('ok');
    expect(payload.data?.capabilities).toEqual({ docsSearch: true });
    expect(docsHealth).toHaveBeenCalledTimes(1);
    expect(generalHealth).not.toHaveBeenCalled();
  });

  it('maps input validation failures to exit code 2', async () => {
    const result = await runRagctl(['project', 'search', 'query only'], () => createFakeService());
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('INVALID_INPUT');
  });

  it('passes docs search query, limit, and category options to the service', async () => {
    const result = await runRagctl(
      ['docs', 'search', 'react', 'hooks', '--limit', '3', '--category', 'react'],
      () => createFakeService()
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe('docs search');
    expect(payload.data).toMatchObject({
      query: 'react hooks',
      limit: 3,
      categories: ['react'],
      mode: 'hybrid',
    });
  });

  it('passes docs search mode to the service', async () => {
    const result = await runRagctl(['docs', 'search', 'react hooks', '--mode', 'keyword'], () =>
      createFakeService()
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe('docs search');
    expect(payload.data).toMatchObject({
      query: 'react hooks',
      mode: 'keyword',
    });
  });

  it('does not treat a following flag as a repeated option value', async () => {
    const result = await runRagctl(['docs', 'search', 'react', '--category', '--json'], () =>
      createFakeService()
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.data).toMatchObject({
      query: 'react',
    });
    expect(payload.data?.categories).toBeUndefined();
  });

  it('passes docs source filter options to the service', async () => {
    const result = await runRagctl(
      [
        'docs',
        'search',
        'interfaces',
        '--source',
        'go-books',
        '--language',
        'go',
        '--kind',
        'book',
        '--authority',
        'community-vetted',
        '--tag',
        'book',
      ],
      () => createFakeService()
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe('docs search');
    expect(payload.data).toMatchObject({
      query: 'interfaces',
      sourceIds: ['go-books'],
      language: 'go',
      kind: 'book',
      authority: 'community-vetted',
      tags: ['book'],
    });
  });

  it('propagates docs search degradation warnings to the JSON envelope', async () => {
    const warning = 'Docs RAG vector search failed; results are lexical diagnostics only.';
    const result = await runRagctl(['docs', 'search', 'react hooks', '--json'], () =>
      createFakeService({
        searchDocs: async (args) => ({
          query: args.query,
          results: [],
          count: 0,
          warnings: [warning],
        }),
      })
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe('docs search');
    expect(payload.warnings).toEqual([warning]);
    expect(payload.data?.warnings).toEqual([warning]);
  });

  it('normalizes Postgres Docs RAG rows into the docs search envelope', () => {
    const report = normalizeDocsRagLabSearchReport(
      {
        query: 'Compose depends_on healthcheck',
        limit: 2,
        mode: 'hybrid',
        results: [
          {
            sourceId: 'docker-docs',
            sourcePath: 'ingest/processed/external/docker-docs/manuals/compose/startup-order.md',
            title: 'Startup order',
            heading: 'Control startup and shutdown order',
            section: 'Control startup and shutdown order',
            content: 'Control startup order with depends_on and service_healthy.',
            chunkIndex: 4,
            canonicalUrl: null,
            sourceRevision: null,
            syncedAt: null,
            authority: 'official',
            score: 12.5,
            provenanceStatus: 'degraded',
            missingFields: ['canonicalUrl', 'sourceRevision', 'syncedAt'],
          },
          {
            sourceId: 'components',
            sourcePath: 'ingest/processed/external/components/functions-and-directives.mdx',
            title: 'Functions and directives',
            heading: null,
            section: null,
            content: '@theme and @source directives.',
            chunkIndex: 1,
            canonicalUrl: null,
            sourceRevision: null,
            syncedAt: null,
            authority: 'official',
            score: 7,
            provenanceStatus: 'degraded',
            missingFields: ['canonicalUrl', 'sourceRevision', 'syncedAt'],
          },
        ],
      },
      { sourceIds: ['docker'] },
      1
    );

    expect(report).toMatchObject({
      query: 'Compose depends_on healthcheck',
      limit: 1,
      count: 1,
      warnings: [],
      results: [
        {
          score: 12.5,
          title: 'Startup order',
          heading: 'Control startup and shutdown order',
          section: 'Control startup and shutdown order',
          citationPath: 'ingest/processed/external/docker-docs/manuals/compose/startup-order.md',
          sourcePath: 'ingest/processed/external/docker-docs/manuals/compose/startup-order.md',
          content: 'Control startup order with depends_on and service_healthy.',
          chunkIndex: 4,
          source: {
            sourceId: 'docker-docs',
            category: 'docker',
          },
        },
      ],
    });
  });

  it('exposes the complete canonical citation subset without dropping CLI aliases', () => {
    const sourceRevision = 'a'.repeat(40);
    const report = normalizeDocsRagLabSearchReport(
      {
        query: 'http',
        limit: 1,
        mode: 'keyword',
        results: [
          {
            sourceId: 'bun-docs',
            sourcePath: 'ingest/processed/external/bun-docs/runtime/http.md',
            canonicalUrl: `https://github.com/example/docs/blob/${sourceRevision}/runtime/http.md`,
            title: 'HTTP',
            heading: 'Fetch',
            section: 'Requests',
            chunkIndex: 2,
            sourceRevision,
            syncedAt: '2026-08-30T00:00:00.000Z',
            authority: 'official',
            score: 0.9,
            content: 'Use fetch.',
            provenanceStatus: 'complete',
            missingFields: [],
          },
        ],
      },
      {},
      1
    );
    const result = report.results[0] as Record<string, unknown>;
    expect(
      [
        'sourceId',
        'sourcePath',
        'canonicalUrl',
        'title',
        'heading',
        'section',
        'chunkIndex',
        'sourceRevision',
        'syncedAt',
        'authority',
        'score',
        'content',
        'provenanceStatus',
        'missingFields',
      ].every((key) => Object.hasOwn(result, key))
    ).toBe(true);
    expect(result).toMatchObject({
      sourceId: 'bun-docs',
      canonicalUrl: `https://github.com/example/docs/blob/${sourceRevision}/runtime/http.md`,
      heading: 'Fetch',
      section: 'Requests',
      sourceRevision,
      syncedAt: '2026-08-30T00:00:00.000Z',
      authority: 'official',
      provenanceStatus: 'complete',
      missingFields: [],
      citationPath: 'ingest/processed/external/bun-docs/runtime/http.md',
      source: expect.objectContaining({ sourceId: 'bun-docs' }),
    });
  });

  it('keeps legacy CLI results visible as degraded with fixed missing-field order', () => {
    const report = normalizeDocsRagLabSearchReport(
      {
        query: 'legacy',
        limit: 1,
        mode: 'keyword',
        results: [
          {
            sourceId: 'legacy-source',
            sourcePath: 'legacy/source.md',
            title: 'Legacy',
            heading: null,
            section: null,
            content: 'Legacy content.',
            chunkIndex: 0,
            canonicalUrl: null,
            sourceRevision: null,
            syncedAt: null,
            authority: null,
            score: 0.2,
            provenanceStatus: 'degraded',
            missingFields: ['canonicalUrl', 'sourceRevision', 'syncedAt', 'authority'],
          },
        ],
      },
      {},
      1
    );
    expect(report.results[0]).toMatchObject({
      canonicalUrl: null,
      sourceRevision: null,
      syncedAt: null,
      authority: null,
      provenanceStatus: 'degraded',
      missingFields: ['canonicalUrl', 'sourceRevision', 'syncedAt', 'authority'],
    });
  });

  it('lists registered docs sources from the registry', async () => {
    const result = await runRagctl(['docs', 'sources', 'list', '--json'], () =>
      createFakeService()
    );
    const payload = parseJson(result.stdout);
    const data = payload.data as {
      count: number;
      sources: Array<Record<string, unknown>>;
    };

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe('docs sources list');
    expect(data.count).toBeGreaterThan(0);
    expect(data.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'typescript-docs',
          language: 'typescript',
          lang: 'ts',
        }),
      ])
    );
  });

  it('short-circuits docs sources list before backend service creation', async () => {
    const serviceFactory = vi.fn(() => {
      throw new Error('service factory should not be used');
    });

    const result = await runRagctl(['docs', 'sources', 'list', '--json'], serviceFactory);
    const payload = parseJson(result.stdout);
    const data = payload.data as { count: number };

    expect(result.exitCode).toBe(0);
    expect(serviceFactory).not.toHaveBeenCalled();
    expect(payload.command).toBe('docs sources list');
    expect(data.count).toBeGreaterThan(0);
  });

  it('accepts deprecated keyword mode and maps to hybrid with deprecation warning', async () => {
    const result = await runRagctl(
      [
        'project',
        'search',
        '--project',
        'rag-v2',
        'loginUser',
        '--mode',
        'keyword',
        '--limit',
        '2',
      ],
      () =>
        createFakeService({
          searchProject: async () => ({
            project: { id: 'p1', slug: 'rag-v2', name: 'RAG V2', status: 'active' },
            query: 'loginUser',
            mode: 'keyword',
            results: [],
            count: 0,
            warnings: [
              'Keyword search mode is deprecated and has been mapped to hybrid vector+lexical search.',
            ],
          }),
        })
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('project search');
    expect(payload.data?.mode).toBe('keyword');
    expect(payload.warnings).toContain(
      'Keyword search mode is deprecated and has been mapped to hybrid vector+lexical search.'
    );
  });

  it('preserves not found failures as exit code 4 with JSON error', async () => {
    const result = await runRagctl(['project', 'verify', '--project', 'missing'], () =>
      createFakeService({
        verifyProject: async () => {
          throw new RagctlError(4, 'NOT_FOUND', 'Project not found: missing');
        },
      })
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(4);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('NOT_FOUND');
    expect(result.stderr).toContain('Project not found: missing');
  });

  it('runs project prepare through the shared service and returns ready exit semantics', async () => {
    const prepareProject = vi.fn(async (args: Parameters<RagctlService['prepareProject']>[0]) => ({
      ...((await createFakeService().prepareProject(args)) as Awaited<
        ReturnType<RagctlService['prepareProject']>
      >),
      project: {
        slug: 'fixture-project',
        name: 'Fixture Project',
        rootPath: args.rootPath,
        includeRoots: args.includeRoots ?? ['src'],
        existing: false,
      },
    }));
    const result = await runRagctl(
      [
        'project',
        'prepare',
        '--root',
        '/workspace/fixture-project',
        '--include-root',
        'src',
        '--max-files',
        '10',
        '--json',
      ],
      () => createFakeService({ prepareProject })
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe('project prepare');
    expect(payload.data).toMatchObject({ status: 'ready', ready: true });
    expect(prepareProject).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: '/workspace/fixture-project',
        includeRoots: ['src'],
        maxFiles: 10,
      })
    );
  });

  it('returns exit code 5 for bounded prepare continuation', async () => {
    const result = await runRagctl(
      ['project', 'prepare', '--root', '/workspace/fixture-project'],
      () =>
        createFakeService({
          prepareProject: async (args) => ({
            ...(await createFakeService().prepareProject(args)),
            status: 'partial',
            ready: false,
            reason: { code: 'PREPARATION_DEADLINE_EXCEEDED', message: 'retry' },
            nextAction: 'retry',
          }),
        })
    );
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(5);
    expect(payload.ok).toBe(true);
    expect(payload.data).toMatchObject({ status: 'partial', ready: false });
  });

  it('runs the bin wrapper for help without backend access', () => {
    const result = spawnSync('bun', ['bin/ragctl', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stderr).not.toContain('{');
  });

  it('returns a JSON envelope for help when --json is set', async () => {
    const result = await runRagctl(['--help', '--json'], () => {
      throw new Error('service should not be created for help');
    });
    const payload = parseJson(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('help');
    expect(payload.data?.usage).toContain('Usage:');
    expect(payload.data?.usage).toContain('[--mode keyword|vector|hybrid]');
    expect(payload.data?.usage).toContain('keyword|vector|hybrid');
  });

  it('compacts project file payload by default but preserves identity and ranges', async () => {
    const result = await runRagctl(
      ['project', 'file', '--project', 'rag-v2', '--file', 'src/main.ts'],
      () =>
        createFakeService({
          getProjectFile: async () => ({
            project: { id: 'p1', slug: 'rag-v2', name: 'RAG V2', status: 'active' },
            file: {
              sourcePath: 'src/main.ts',
              status: 'indexed',
              lineCount: 120,
              content: 'FULL_FILE_CONTENT',
            },
            chunks: [
              { id: 'c1', sourcePath: 'src/main.ts', startLine: 1, endLine: 30, content: 'A' },
              { id: 'c2', sourcePath: 'src/main.ts', startLine: 31, endLine: 60, content: 'B' },
            ],
            chunkCount: 2,
          }),
        })
    );
    const data = readOkData(result);
    const file = data.file as Record<string, unknown>;
    const chunks = data.chunks as Array<Record<string, unknown>>;

    expect(result.exitCode).toBe(0);
    expect(data.project).toMatchObject({ id: 'p1', slug: 'rag-v2' });
    expect(data.chunkCount).toBe(2);
    expect(file).toMatchObject({ sourcePath: 'src/main.ts', status: 'indexed', lineCount: 120 });
    expect('content' in file).toBe(false);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ sourcePath: 'src/main.ts', startLine: 1, endLine: 30 });
    expect(chunks[1]).toMatchObject({ sourcePath: 'src/main.ts', startLine: 31, endLine: 60 });
    expect('content' in chunks[0]).toBe(false);
  });

  it('returns full project file content when --include-content is set', async () => {
    const result = await runRagctl(
      ['project', 'file', '--project', 'rag-v2', '--file', 'src/main.ts', '--include-content'],
      () =>
        createFakeService({
          getProjectFile: async () => ({
            project: { id: 'p1', slug: 'rag-v2' },
            file: { sourcePath: 'src/main.ts', content: 'FULL_FILE_CONTENT' },
            chunks: [{ sourcePath: 'src/main.ts', startLine: 1, endLine: 10, content: 'CHUNK_A' }],
            chunkCount: 1,
          }),
        })
    );
    const data = readOkData(result);
    const file = data.file as Record<string, unknown>;
    const chunks = data.chunks as Array<Record<string, unknown>>;

    expect(result.exitCode).toBe(0);
    expect(file.content).toBe('FULL_FILE_CONTENT');
    expect(chunks[0].content).toBe('CHUNK_A');
  });

  it('compacts project outline payload by default but preserves paths and line ranges', async () => {
    const result = await runRagctl(
      ['project', 'outline', '--project', 'rag-v2', '--file', 'src/main.ts'],
      () =>
        createFakeService({
          getProjectOutline: async () => ({
            project: { id: 'p1', slug: 'rag-v2' },
            sourcePath: 'src/main.ts',
            skeleton: { summary: 'FULL_SKELETON' },
            symbols: [
              {
                name: 'buildIndex',
                type: 'function',
                sourcePath: 'src/main.ts',
                startLine: 8,
                endLine: 42,
              },
            ],
            symbolCount: 1,
          }),
        })
    );
    const data = readOkData(result);
    const symbols = data.symbols as Array<Record<string, unknown>>;

    expect(result.exitCode).toBe(0);
    expect(data.sourcePath).toBe('src/main.ts');
    expect(data.symbolCount).toBe(1);
    expect(symbols[0]).toMatchObject({
      name: 'buildIndex',
      type: 'function',
      sourcePath: 'src/main.ts',
      startLine: 8,
      endLine: 42,
    });
    expect('skeleton' in data).toBe(false);
  });

  it('returns skeleton detail for project outline when --include-skeleton is set', async () => {
    const result = await runRagctl(
      ['project', 'outline', '--project', 'rag-v2', '--file', 'src/main.ts', '--include-skeleton'],
      () =>
        createFakeService({
          getProjectOutline: async () => ({
            project: { id: 'p1', slug: 'rag-v2' },
            sourcePath: 'src/main.ts',
            skeleton: { summary: 'FULL_SKELETON' },
            symbols: [],
            symbolCount: 0,
          }),
        })
    );
    const data = readOkData(result);

    expect(result.exitCode).toBe(0);
    expect((data.skeleton as Record<string, unknown>).summary).toBe('FULL_SKELETON');
  });

  it('compacts project symbol payload by default but preserves counts and definition ranges', async () => {
    const result = await runRagctl(
      ['project', 'symbol', '--project', 'rag-v2', '--name', 'buildIndex'],
      () =>
        createFakeService({
          findProjectSymbol: async () => ({
            project: { id: 'p1', slug: 'rag-v2' },
            name: 'buildIndex',
            definitions: [{ sourcePath: 'src/main.ts', startLine: 8, endLine: 42 }],
            references: [{ sourcePath: 'src/search.ts', startLine: 5, endLine: 6 }],
            definitionCount: 1,
            referenceCount: 1,
          }),
        })
    );
    const data = readOkData(result);
    const definitions = data.definitions as Array<Record<string, unknown>>;

    expect(result.exitCode).toBe(0);
    expect(data.name).toBe('buildIndex');
    expect(data.definitionCount).toBe(1);
    expect(data.referenceCount).toBe(1);
    expect(definitions[0]).toMatchObject({ sourcePath: 'src/main.ts', startLine: 8, endLine: 42 });
    expect('references' in data).toBe(false);
  });

  it('returns references for project symbol when --references is set', async () => {
    const result = await runRagctl(
      ['project', 'symbol', '--project', 'rag-v2', '--name', 'buildIndex', '--references'],
      () =>
        createFakeService({
          findProjectSymbol: async () => ({
            project: { id: 'p1', slug: 'rag-v2' },
            name: 'buildIndex',
            definitions: [{ sourcePath: 'src/main.ts', startLine: 8, endLine: 42 }],
            references: [{ sourcePath: 'src/search.ts', startLine: 5, endLine: 6 }],
            definitionCount: 1,
            referenceCount: 1,
          }),
        })
    );
    const data = readOkData(result);
    const references = data.references as Array<Record<string, unknown>>;

    expect(result.exitCode).toBe(0);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ sourcePath: 'src/search.ts', startLine: 5, endLine: 6 });
  });

  it('compacts project verify payload by default and expands with --full', async () => {
    const baseVerifyPayload = {
      project: { id: 'p1', slug: 'rag-v2' },
      stats: {
        fileCount: 12,
        chunkCount: 40,
        symbolCount: 20,
        lastSyncAt: '2026-07-11T00:00:00.000Z',
      },
      freshness: {
        status: 'stale',
        files: [{ sourcePath: 'src/old.ts', lagMinutes: 120 }],
      },
      scopeCoverage: {
        status: 'partial',
        uncoveredPaths: ['src/old.ts'],
      },
      status: 'degraded',
    };

    const compactResult = await runRagctl(['project', 'verify', '--project', 'rag-v2'], () =>
      createFakeService({
        verifyProject: async () => baseVerifyPayload,
      })
    );
    const compactData = readOkData(compactResult);
    const compactFreshness = compactData.freshness as Record<string, unknown> | undefined;
    const compactScope = compactData.scopeCoverage as Record<string, unknown> | undefined;

    expect(compactResult.exitCode).toBe(0);
    expect(compactData.project).toMatchObject({ id: 'p1', slug: 'rag-v2' });
    expect(compactData.status).toBe('degraded');
    expect(compactData.stats).toMatchObject({ lastSyncAt: '2026-07-11T00:00:00.000Z' });
    if (compactFreshness) {
      expect('files' in compactFreshness).toBe(false);
    }
    if (compactScope) {
      expect('uncoveredPaths' in compactScope).toBe(false);
    }

    const fullResult = await runRagctl(['project', 'verify', '--project', 'rag-v2', '--full'], () =>
      createFakeService({
        verifyProject: async () => baseVerifyPayload,
      })
    );
    const fullData = readOkData(fullResult);
    const fullFreshness = fullData.freshness as Record<string, unknown>;
    const fullScope = fullData.scopeCoverage as Record<string, unknown>;

    expect(fullResult.exitCode).toBe(0);
    expect(fullFreshness.files).toEqual([{ sourcePath: 'src/old.ts', lagMinutes: 120 }]);
    expect(fullScope.uncoveredPaths).toEqual(['src/old.ts']);
  });

  it('preserves a null last sync timestamp without numeric coercion', async () => {
    const result = await runRagctl(['project', 'verify', '--project', 'rag-v2'], () =>
      createFakeService({
        verifyProject: async () => ({
          project: { id: 'p1', slug: 'rag-v2' },
          stats: { lastSyncAt: null },
          status: 'degraded',
        }),
      })
    );
    const data = readOkData(result);
    const stats = data.stats as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(stats.lastSyncAt).toBeNull();
  });

  it('exposes invariant coverage and blocked coverage in compact verify output', async () => {
    const result = await runRagctl(['project', 'verify', '--project', 'rag-v2'], () =>
      createFakeService({
        verifyProject: async () => ({
          project: { id: 'p1', slug: 'rag-v2' },
          stats: { fileCount: 12, indexedFileCount: 10, blockedFileCount: 2 },
          status: 'degraded',
          freshness: { status: 'fresh' },
          scopeCoverage: { status: 'covered' },
          embeddingCoverage: { status: 'drift', missingOwners: 2 },
          ownershipCoverage: { status: 'covered' },
          blockedCoverage: { status: 'blocked', blockedFileCount: 2 },
        }),
      })
    );
    const data = readOkData(result);

    expect(data.status).toBe('degraded');
    expect(data.embeddingCoverage).toMatchObject({ status: 'drift', missingOwners: 2 });
    expect(data.ownershipCoverage).toMatchObject({ status: 'covered' });
    expect(data.blockedCoverage).toMatchObject({ status: 'blocked', blockedFileCount: 2 });
  });
});
