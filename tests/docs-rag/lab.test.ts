import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { auditDocsRagCorpusPaths } from '../../scripts/docs-rag/audit.js';
import { resolveDocsRagLabConfig } from '../../scripts/docs-rag/config.js';
import {
  checkDocsRagLabCorpusHealth,
  checkDocsRagLabDatabaseHealth,
  isRegisteredDocsSourcePathMatch,
} from '../../scripts/docs-rag/db.js';
import { evaluateDocsRagLabFixture } from '../../scripts/docs-rag/eval.js';
import { readStreamTail, resolveDocsRagChildProcessLimits } from '../../scripts/docs-rag/index.js';
import {
  buildDocsRagLabDocument,
  collectDocsRagLabFiles,
  normalizeDocsRagStoredSourcePath,
  resolveDocsRagSearchPlan,
  upsertDocsRagLabDocument,
} from '../../scripts/docs-rag/store.js';
import { DOCS_SOURCE_REGISTRY } from '../../scripts/lib/docs-source-registry.js';

describe('docs rag pg lab config', () => {
  it('normalizes public and aliased document paths to stored canonical paths', () => {
    expect(normalizeDocsRagStoredSourcePath('bun-docs/runtime/http/server.mdx')).toBe(
      'ingest/processed/external/bun-docs/runtime/http/server.mdx'
    );
    expect(
      normalizeDocsRagStoredSourcePath(
        'ingest/source/external/typescript-docs/release-notes/TypeScript 2.8.md'
      )
    ).toBe('ingest/processed/external/typescript-docs/release-notes/TypeScript 2.8.md');
    expect(normalizeDocsRagStoredSourcePath('tailwindcss-docs/theme.mdx')).toBe(
      'ingest/processed/external/components/theme.mdx'
    );
  });

  it('uses long-running configurable child limits', () => {
    expect(resolveDocsRagChildProcessLimits({})).toEqual({
      longRunningTimeoutMs: 21_600_000,
      ingestWorkerTimeoutMs: 21_600_000,
      capturedOutputTailBytes: 2_097_152,
    });
    expect(
      resolveDocsRagChildProcessLimits({
        DOCS_RAG_LONG_RUNNING_CHILD_TIMEOUT_MS: '900000',
        DOCS_RAG_INGEST_WORKER_TIMEOUT_MS: '600000',
        DOCS_RAG_CHILD_OUTPUT_TAIL_BYTES: '4096',
      })
    ).toEqual({
      longRunningTimeoutMs: 900_000,
      ingestWorkerTimeoutMs: 600_000,
      capturedOutputTailBytes: 4_096,
    });
    expect(
      resolveDocsRagChildProcessLimits({
        DOCS_RAG_LONG_RUNNING_CHILD_TIMEOUT_MS: '1ms',
        DOCS_RAG_INGEST_WORKER_TIMEOUT_MS: '1e3',
        DOCS_RAG_CHILD_OUTPUT_TAIL_BYTES: '1',
      })
    ).toEqual({
      longRunningTimeoutMs: 21_600_000,
      ingestWorkerTimeoutMs: 21_600_000,
      capturedOutputTailBytes: 2_097_152,
    });
    expect(
      resolveDocsRagChildProcessLimits({
        DOCS_RAG_LONG_RUNNING_CHILD_TIMEOUT_MS: '2147483648',
        DOCS_RAG_INGEST_WORKER_TIMEOUT_MS: '9007199254740991',
        DOCS_RAG_CHILD_OUTPUT_TAIL_BYTES: '67108865',
      })
    ).toEqual({
      longRunningTimeoutMs: 21_600_000,
      ingestWorkerTimeoutMs: 21_600_000,
      capturedOutputTailBytes: 2_097_152,
    });
  });

  it('keeps the bounded output tail without aborting verbose streams', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('prefix-that-will-be-truncated\n'));
        controller.enqueue(new TextEncoder().encode('final-json-payload'));
        controller.close();
      },
    });

    const result = await readStreamTail(stream, 18);

    expect(result.truncated).toBe(true);
    expect(result.text).toBe('final-json-payload');
  });

  it('force-kills descendants that ignore SIGTERM after the group leader exits', async () => {
    if (process.platform === 'win32') return;
    const modulePath = resolve('scripts/docs-rag/index.ts');
    const probe = spawnSync(
      'bun',
      [
        '--eval',
        `import { runDocsRagChildProcess } from ${JSON.stringify(modulePath)};
         const result = await runDocsRagChildProcess(
           ['bash', '-lc', 'trap "exit 0" TERM; (trap "" TERM; sleep 30) >/dev/null 2>&1 & echo $!; wait'],
           process.cwd(),
           { timeoutMs: 1_000, outputTailBytes: 4096 }
         );
         const descendantPid = Number.parseInt(result.stdout.text.trim(), 10);
         await Bun.sleep(5_500);
         let descendantAlive = true;
         try { process.kill(descendantPid, 0); } catch { descendantAlive = false; }
         if (descendantAlive) process.kill(descendantPid, 'SIGKILL');
         console.log(JSON.stringify({ ...result, descendantPid, descendantAlive }));`,
      ],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 10_000 }
    );
    expect(probe.status).toBe(0);
    const result = JSON.parse(probe.stdout) as {
      timedOut: boolean;
      stdout: { text: string };
      descendantPid: number;
      descendantAlive: boolean;
    };

    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(result.descendantPid)).toBe(true);
    expect(result.descendantAlive).toBe(false);
  }, 10_000);

  it('redacts the configured Postgres URL and resolves defaults', () => {
    const config = resolveDocsRagLabConfig({
      DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://docs:secret@127.0.0.1:5441/docs_lab',
      DOCS_RAG_PG_LAB_EVAL_TOP_K: '7',
    });

    expect(config.database.redactedUrl).toBe('postgres://docs:***@127.0.0.1:5441/docs_lab');
    expect(config.database.source).toBe('DOCS_RAG_PG_LAB_DATABASE_URL');
    expect(config.evalTopK).toBe(7);
    expect(config.defaultEvalFixturePath).toContain(
      'scripts/docs-rag/fixtures/eval-external-sources.json'
    );
    expect(config.gates.embeddingEnabled).toBe(false);
    expect(config.embedding).toMatchObject({
      provider: 'llamacpp',
      model: 'qwen3-embedding-1024',
      baseUrl: 'http://127.0.0.1:8082',
      dimensions: 1024,
    });
  });
});

describe('docs rag pg lab db health', () => {
  it('accepts canonical and registered alias prefixes but rejects cross-source paths', () => {
    expect(
      isRegisteredDocsSourcePathMatch(
        'components',
        'ingest/processed/external/components/theme.mdx'
      )
    ).toBe(true);
    expect(
      isRegisteredDocsSourcePathMatch(
        'components',
        'ingest/processed/external/tailwindcss-docs/theme.mdx'
      )
    ).toBe(true);
    expect(
      isRegisteredDocsSourcePathMatch(
        'tanstack',
        'ingest/processed/external/tanstack-router-docs/guide.md'
      )
    ).toBe(true);
    expect(
      isRegisteredDocsSourcePathMatch(
        'bun-docs',
        'ingest/processed/external/typescript-docs/handbook.md'
      )
    ).toBe(false);
  });

  it('fails corpus health when local or malformed documents are present', async () => {
    const result = await checkDocsRagLabCorpusHealth(
      'postgres://docs:secret@127.0.0.1:5441/docs_lab',
      async () => ({
        documents: 20,
        unexpectedSourceIds: ['docs'],
        invalidPathCount: 3,
        sourcePathMismatchCount: 2,
        missingMetadataCount: 1,
      })
    );

    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('unexpected sources=docs');
  });

  it('accepts a clean registered external corpus', async () => {
    const result = await checkDocsRagLabCorpusHealth('postgres://localhost/docs', async () => ({
      documents: 42,
      unexpectedSourceIds: [],
      invalidPathCount: 0,
      sourcePathMismatchCount: 0,
      missingMetadataCount: 0,
      missingSourceIds: [],
      emptyDocumentCount: 0,
      zeroChunkDocumentCount: 0,
      emptyChunkCount: 0,
      missingEmbeddingChunkCount: 0,
    }));

    expect(result.status).toBe('healthy');
    expect(result.documents).toBe(42);
  });

  it('checks the current Docs read schema before accepting the live corpus', () => {
    const source = readFileSync(new URL('../../scripts/docs-rag/db.ts', import.meta.url), 'utf8');

    expect(source).toContain('assertDocsRagProcessingSchemaReady(sql)');
    expect(source).toContain('assertDocsRagGenerationSchemaReady(sql)');
  });

  it('fails corpus health for incomplete sources or unusable indexed content', async () => {
    const result = await checkDocsRagLabCorpusHealth('postgres://localhost/docs', async () => ({
      documents: 42,
      unexpectedSourceIds: [],
      invalidPathCount: 0,
      sourcePathMismatchCount: 0,
      missingMetadataCount: 0,
      missingSourceIds: ['go-books'],
      emptyDocumentCount: 1,
      zeroChunkDocumentCount: 2,
      emptyChunkCount: 3,
      missingEmbeddingChunkCount: 4,
    }));

    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('missing sources=go-books');
    expect(result.message).toContain('empty documents=1');
    expect(result.message).toContain('zero-chunk documents=2');
    expect(result.message).toContain('missing chunk embeddings=4');
  });

  it('rejects an empty corpus as unhealthy', async () => {
    const result = await checkDocsRagLabCorpusHealth('postgres://localhost/docs', async () => ({
      documents: 0,
      unexpectedSourceIds: [],
      invalidPathCount: 0,
      sourcePathMismatchCount: 0,
      missingMetadataCount: 0,
    }));

    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('documents=0');
  });

  it('bounds a corpus probe with the configured health timeout', async () => {
    const startedAt = performance.now();
    const result = await checkDocsRagLabCorpusHealth(
      'postgres://docs:secret@127.0.0.1:5441/docs_lab',
      async () => new Promise(() => undefined),
      { timeoutMs: 20 }
    );

    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('timed out after 20ms');
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('closes Bun SQL probes without delaying corpus health past its deadline', async () => {
    const expectedSourceIds = DOCS_SOURCE_REGISTRY.map(({ sourceId }) => sourceId);
    const query = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join('');
      if (statement.includes('select 1 as ok')) return [{ ok: 1 }];
      if (statement.includes("set_config('statement_timeout'")) return [];
      if (statement.includes('count(*) = 8')) return [{ ready: true }];
      if (statement.includes("table_name = 'docs_source_generations'")) {
        return [{ ready: true }];
      }
      if (statement.includes('count(*)::int as documents')) {
        return [
          {
            documents: 1,
            unexpectedSourceIds: [],
            invalidPathCount: 0,
            missingMetadataCount: 0,
          },
        ];
      }
      if (statement.includes('select d.source_id as "sourceId", d.source_path')) return [];
      if (statement.includes('select distinct d.source_id as "sourceId"')) {
        return expectedSourceIds.map((sourceId) => ({ sourceId }));
      }
      if (statement.includes('emptyDocumentCount')) {
        return [
          {
            emptyDocumentCount: 0,
            zeroChunkDocumentCount: 0,
            emptyChunkCount: 0,
            missingEmbeddingChunkCount: 0,
          },
        ];
      }
      throw new Error(`Unexpected probe query: ${statement}`);
    });
    const close = vi.fn(async ({ timeout }: { timeout: number }) => {
      if (timeout === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
    const fakeSql = Object.assign(query, { close });
    function FakeSql() {
      return fakeSql;
    }
    vi.stubGlobal('Bun', { SQL: FakeSql });

    try {
      const databaseHealth = await checkDocsRagLabDatabaseHealth('postgres://localhost/docs');
      const startedAt = performance.now();
      const corpusHealth = await checkDocsRagLabCorpusHealth(
        'postgres://localhost/docs',
        undefined,
        { timeoutMs: 50 }
      );

      expect(databaseHealth.status).toBe('healthy');
      expect(corpusHealth.status).toBe('healthy');
      expect(performance.now() - startedAt).toBeLessThan(150);
      expect(close).toHaveBeenCalledTimes(2);
      expect(close.mock.calls.map(([options]) => options)).toEqual([
        { timeout: 5 },
        { timeout: 5 },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses Bun SQL for an authenticated smoke check', async () => {
    const runSqlProbe = vi.fn(async () => ({
      ok: true,
      message: 'Connection succeeded and SELECT 1 returned the expected result.',
    }));

    const result = await checkDocsRagLabDatabaseHealth(
      'postgres://docs:secret@db.internal:5544/docs_lab?sslmode=require',
      {
        timeoutMs: 7_000,
        runSqlProbe,
      }
    );

    expect(result.status).toBe('healthy');
    expect(result.method).toBe('bun-sql');
    expect(result.target).toBe('postgres://docs:***@db.internal:5544/docs_lab?sslmode=require');
    expect(result.connection).toMatchObject({
      host: 'db.internal',
      port: 5544,
      database: 'docs_lab',
      user: 'docs',
      sslmode: 'require',
    });
    expect(runSqlProbe).toHaveBeenCalledWith(
      'postgres://docs:secret@db.internal:5544/docs_lab?sslmode=require',
      7_000
    );
  });

  it('blocks when no database URL is configured', async () => {
    const result = await checkDocsRagLabDatabaseHealth(undefined);

    expect(result.status).toBe('blocked');
    expect(result.method).toBe('none');
    expect(result.message).toContain('No Postgres URL configured');
  });

  it('redacts database URLs from probe errors', async () => {
    const result = await checkDocsRagLabDatabaseHealth(
      'postgres://docs:secret@127.0.0.1:5441/docs_lab',
      {
        runSqlProbe: async (databaseUrl) => {
          throw new Error(`failed to connect to ${databaseUrl}`);
        },
      }
    );

    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('postgres://docs:***@127.0.0.1:5441/docs_lab');
    expect(result.message).not.toContain('secret');
  });
});

describe('docs rag pg lab cli lifecycle', () => {
  it('waits for async db health before emitting JSON and writing the artifact', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-cli-lifecycle-'));
    const outputPath = join(tempRoot, 'db-health.json');

    try {
      const result = spawnSync(
        'bun',
        [
          'scripts/docs-rag/index.ts',
          'db-health',
          '--db-url',
          'postgres://127.0.0.1:1/docs_rag_cli_test',
          '--timeout-ms',
          '1000',
          '--write',
          outputPath,
        ],
        {
          cwd: resolve('.'),
          encoding: 'utf8',
          env: {
            ...process.env,
            DOCS_RAG_PG_LAB_DATABASE_URL: '',
          },
          timeout: 10_000,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(3);

      const stdoutPayload = JSON.parse(result.stdout) as Record<string, unknown>;
      const writtenPayload = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<
        string,
        unknown
      >;

      expect(stdoutPayload).toMatchObject({
        ok: false,
        command: 'db-health',
        data: {
          status: 'unhealthy',
          method: 'bun-sql',
        },
        error: {
          code: 'DB_HEALTH_FAILED',
        },
      });
      expect(writtenPayload).toEqual(stdoutPayload);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('docs rag pg lab eval', () => {
  it('computes offline retrieval metrics from captured paths', () => {
    const report = evaluateDocsRagLabFixture(
      {
        meta: { name: 'unit-fixture' },
        cases: [
          {
            id: 'hit-at-1',
            query: 'find primary path',
            expectedPaths: ['docs/a.md'],
            expectedCitationPath: 'docs/a.md',
            retrieved: [{ path: 'docs/a.md' }, { path: 'docs/b.md' }],
          },
          {
            id: 'hit-at-2',
            query: 'find delayed path',
            expectedPaths: ['docs/c.md'],
            expectedCitationPath: 'docs/c.md',
            retrieved: [{ path: 'docs/noise.md' }, { path: 'docs/c.md' }],
          },
        ],
      },
      { topK: 2 }
    );

    expect(report.summary.scenarioCount).toBe(2);
    expect(report.summary.hitRate).toBe(1);
    expect(report.summary.recallAtK).toBe(1);
    expect(report.summary.mrr).toBeCloseTo(0.75, 6);
    expect(report.summary.citationPathRate).toBeCloseTo(0.5, 6);
  });
});

describe('docs rag pg lab document store', () => {
  it('rejects project-local and unregistered documents', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-store-boundary-'));
    try {
      const localFile = join(tempRoot, 'README.md');
      const rawDir = join(tempRoot, 'ingest', 'source', 'external', 'bun-docs');
      const unknownDir = join(tempRoot, 'ingest', 'processed', 'external', 'unknown-docs');
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(unknownDir, { recursive: true });
      writeFileSync(localFile, '# Local project docs\n');
      writeFileSync(join(rawDir, 'README.md'), '# Raw source docs\n');
      writeFileSync(join(unknownDir, 'guide.md'), '# Unknown docs\n');

      await expect(buildDocsRagLabDocument(localFile, { rootDir: tempRoot })).rejects.toThrow(
        'accepts only external source artifacts'
      );
      await expect(
        buildDocsRagLabDocument(join(rawDir, 'README.md'), { rootDir: tempRoot })
      ).rejects.toThrow('accepts only external source artifacts');
      await expect(
        buildDocsRagLabDocument(join(unknownDir, 'guide.md'), { rootDir: tempRoot })
      ).rejects.toThrow('source is not registered');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('builds distinct retrieval plans for keyword, vector, and hybrid modes', () => {
    expect(resolveDocsRagSearchPlan(false, 'keyword')).toEqual({
      useEmbedding: false,
      includeLexicalCandidates: true,
    });
    expect(resolveDocsRagSearchPlan(true, 'vector')).toEqual({
      useEmbedding: true,
      includeLexicalCandidates: false,
    });
    expect(resolveDocsRagSearchPlan(true, 'hybrid')).toEqual({
      useEmbedding: true,
      includeLexicalCandidates: true,
    });
    expect(() => resolveDocsRagSearchPlan(false, 'vector')).toThrow(
      'requires embeddings to be enabled'
    );
    expect(resolveDocsRagSearchPlan(false)).toEqual({
      useEmbedding: false,
      includeLexicalCandidates: true,
    });
  });

  it('rejects direct upserts whose absolute source is outside the processed corpus', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-upsert-boundary-'));
    try {
      const processedDir = join(tempRoot, 'ingest', 'processed', 'external', 'bun-docs');
      const rawDir = join(tempRoot, 'ingest', 'source', 'external', 'bun-docs');
      mkdirSync(processedDir, { recursive: true });
      mkdirSync(rawDir, { recursive: true });
      const processedPath = join(processedDir, 'README.md');
      const rawPath = join(rawDir, 'README.md');
      writeFileSync(processedPath, '# Processed docs\n');
      writeFileSync(rawPath, '# Raw docs\n');
      const document = await buildDocsRagLabDocument(processedPath, { rootDir: tempRoot });
      const config = {
        ...resolveDocsRagLabConfig({ DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://invalid/test' }),
        rootDir: tempRoot,
      };

      await expect(
        upsertDocsRagLabDocument(
          config,
          { ...document, sourceAbsolutePath: rawPath },
          { generationId: 1 }
        )
      ).rejects.toThrow('Refusing invalid Docs RAG document source');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a direct upsert omits its source generation', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-upsert-generation-'));
    try {
      const processedDir = join(tempRoot, 'ingest', 'processed', 'external', 'bun-docs');
      mkdirSync(processedDir, { recursive: true });
      const processedPath = join(processedDir, 'generation-required.md');
      writeFileSync(processedPath, '# Generation required\n');
      const document = await buildDocsRagLabDocument(processedPath, { rootDir: tempRoot });
      const config = {
        ...resolveDocsRagLabConfig({ DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://invalid/test' }),
        rootDir: tempRoot,
      };

      await expect(
        // @ts-expect-error Deliberately prove the runtime boundary rejects implicit publication.
        upsertDocsRagLabDocument(config, document)
      ).rejects.toThrow('requires a valid staging generationId');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects direct upserts with a noncanonical source id alias', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-upsert-alias-'));
    try {
      const processedDir = join(tempRoot, 'ingest', 'processed', 'external', 'tailwindcss-docs');
      mkdirSync(processedDir, { recursive: true });
      const processedPath = join(processedDir, 'theme.mdx');
      writeFileSync(processedPath, '# Theme docs\n');
      const document = await buildDocsRagLabDocument(processedPath, { rootDir: tempRoot });
      const config = {
        ...resolveDocsRagLabConfig({ DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://invalid/test' }),
        rootDir: tempRoot,
      };

      await expect(
        upsertDocsRagLabDocument(
          config,
          { ...document, sourceId: 'tailwindcss-docs' },
          { generationId: 1 }
        )
      ).rejects.toThrow('Refusing invalid Docs RAG document source');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects processed-path symlinks that target raw source content', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-symlink-boundary-'));
    try {
      const processedDir = join(tempRoot, 'ingest', 'processed', 'external', 'bun-docs');
      const rawDir = join(tempRoot, 'ingest', 'source', 'external', 'bun-docs');
      mkdirSync(processedDir, { recursive: true });
      mkdirSync(rawDir, { recursive: true });
      const processedPath = join(processedDir, 'processed.md');
      const rawPath = join(rawDir, 'raw.md');
      const linkedPath = join(processedDir, 'linked.md');
      writeFileSync(processedPath, '# Processed docs\n');
      writeFileSync(rawPath, '# Raw docs\n');
      symlinkSync(rawPath, linkedPath);

      await expect(buildDocsRagLabDocument(linkedPath, { rootDir: tempRoot })).rejects.toThrow(
        'accepts only external source artifacts'
      );

      const document = await buildDocsRagLabDocument(processedPath, { rootDir: tempRoot });
      const config = {
        ...resolveDocsRagLabConfig({ DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://invalid/test' }),
        rootDir: tempRoot,
      };
      await expect(
        upsertDocsRagLabDocument(
          config,
          { ...document, sourceAbsolutePath: linkedPath },
          { generationId: 1 }
        )
      ).rejects.toThrow('Refusing invalid Docs RAG document source');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('collects markdown documents and builds heading chunks with source metadata', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-store-'));
    try {
      const docsDir = join(tempRoot, 'ingest', 'processed', 'external', 'bun-docs');
      const filePath = join(docsDir, 'README.md');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(
        filePath,
        [
          '---',
          'title: Bun Helpers',
          'framework: bun-helpers',
          '---',
          '# Ignored Heading',
          'Use `npm run testFunctions` with `backendHarness.js`.',
          '',
          '## Testing',
          '`IS_TEST` enables fixture behavior.',
        ].join('\n')
      );
      writeFileSync(join(tempRoot, 'ignore.ts'), 'export const ignored = true;\n');

      const files = collectDocsRagLabFiles(['ingest'], { cwd: tempRoot });
      const document = await buildDocsRagLabDocument(resolve(filePath), { rootDir: tempRoot });

      expect(files).toEqual([resolve(filePath)]);
      expect(document.sourceId).toBe('bun-docs');
      expect(document.sourcePath).toBe('ingest/processed/external/bun-docs/README.md');
      expect(document.title).toBe('Bun Helpers');
      expect(document.category).toBe('bun');
      expect(document.chunks.length).toBeGreaterThanOrEqual(2);
      expect(document.chunks.some((chunk) => chunk.heading === 'Testing')).toBe(true);
      expect(document.searchableText).toContain('npm run testFunctions');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('canonicalizes registered source aliases before indexing', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-store-alias-'));
    try {
      const docsDir = join(tempRoot, 'ingest', 'processed', 'external', 'tailwindcss-docs');
      const filePath = join(docsDir, 'functions-and-directives.mdx');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(filePath, '# Functions and directives\n\nUse `@theme` and `@source`.\n');

      const document = await buildDocsRagLabDocument(resolve(filePath), { rootDir: tempRoot });

      expect(document.sourceId).toBe('components');
      expect(document.sourcePath).toBe(
        'ingest/processed/external/components/functions-and-directives.mdx'
      );
      expect(document.category).toBe('tailwind');
      expect(document.metadata).toMatchObject({
        sourceId: 'components',
        lib: 'tailwind',
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('deduplicates md/mdx siblings and skips metadata json before ingest selection', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-dedupe-'));
    try {
      const docsDir = join(tempRoot, 'ingest', 'processed', 'external', 'bun-docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, 'agents.md'), '# Processed\n');
      writeFileSync(join(docsDir, 'agents.mdx'), '# Original\n');
      writeFileSync(join(docsDir, 'other.mdx'), '# Other\n');
      writeFileSync(join(docsDir, '.missing-files.json'), '[]\n');
      writeFileSync(join(docsDir, 'guide.rst'), 'Guide\n=====\n');

      const files = collectDocsRagLabFiles(['ingest'], { cwd: tempRoot });

      expect(files.map((file) => file.replace(`${tempRoot}/`, ''))).toEqual([
        'ingest/processed/external/bun-docs/agents.md',
        'ingest/processed/external/bun-docs/guide.rst',
        'ingest/processed/external/bun-docs/other.mdx',
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not build chunks for empty markdown bodies', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-empty-'));
    try {
      const docsDir = join(tempRoot, 'ingest', 'processed', 'external', 'bun-docs');
      mkdirSync(docsDir, { recursive: true });
      const filePath = join(docsDir, 'empty.md');
      writeFileSync(filePath, '\n\n');

      const document = await buildDocsRagLabDocument(filePath, { rootDir: tempRoot });

      expect(document.chunks).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('docs rag pg lab sanitize plan', () => {
  it('counts secret-like and path-reference risks without mutating files', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'docs-rag-sanitize-plan-'));
    try {
      writeFileSync(join(tempRoot, '.env'), 'PUBLIC_VALUE=true\n');
      writeFileSync(
        join(tempRoot, 'notes.md'),
        [
          '# Notes',
          'postgres://docs:secret@127.0.0.1:5441/docs_lab',
          'workspace path: /home/example/apps/rag-v2',
          'relative escape: ../secrets.txt',
        ].join('\n')
      );

      const report = auditDocsRagCorpusPaths([tempRoot], {
        cwd: tempRoot,
        maxFiles: 10,
        maxFileBytes: 10_000,
      });

      expect(report.summary.requestedPathCount).toBe(1);
      expect(report.summary.scannedFileCount).toBe(2);
      expect(report.summary.secretLikePathCount).toBe(1);
      expect(report.summary.secretLikeContentCount).toBe(1);
      expect(report.summary.absolutePathReferenceCount).toBe(1);
      expect(report.summary.traversalReferenceCount).toBe(1);
      expect(report.findings.length).toBeGreaterThanOrEqual(4);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
