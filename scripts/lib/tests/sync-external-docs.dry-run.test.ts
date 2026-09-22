import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkDocsRagTextWithContext } from '../../docs-rag/chunker.js';
import {
  deleteStaleDocsRagLabDocuments,
  docsRagLabDocumentNeedsProcessing,
  inspectDocsRagLabDocumentProcessing,
  upsertDocsRagLabDocument,
} from '../../docs-rag/store.js';
import {
  classifyExternalDocEntries,
  filterExternalDocEntries,
} from '../../lib/external-doc-inventory.js';
import {
  accumulateExternalDocsBudget,
  assertExternalDocsBudget,
  assertExternalDocsRunBudget,
  buildDocsRagCleanupInput,
  buildDocsRagSourceManifestHash,
  buildExternalDocsProvenance,
  buildSourceGlob,
  buildSyncRunReport,
  cloneRepo,
  estimateExternalDocsBudget,
  evaluateSyncThresholds,
  main,
  normalizeSourceFileExtensions,
  parseSyncRuntimeOptions,
  prepareDeterministicExternalDocContent,
  processFile,
  resolveExternalDocsChunkConfig,
  resolveExternalDocsEmbeddingOptions,
  type SyncRunReport,
  sanitizeExternalDocsContent,
  saveSyncRunReport,
  shouldAllowDeleteAllForExcludedSource,
  shouldRunDocsRagCleanup,
  shouldRunGarbageCollection,
} from '../../sync-external-docs.js';

vi.mock('../../docs-rag/store.js', () => ({
  deleteStaleDocsRagLabDocuments: vi.fn(),
  docsRagLabDocumentNeedsProcessing: vi.fn(),
  inspectDocsRagLabDocumentProcessing: vi.fn(),
  resolveDocsRagCanonicalProcessingProfile: vi.fn(() => ({
    profile: null,
    profileHash: 'test-processing-profile',
  })),
  upsertDocsRagLabDocument: vi.fn(),
}));

type CallableMock = ReturnType<typeof vi.fn> & ((...args: unknown[]) => unknown);
const mockFn = (fn: unknown): CallableMock => fn as CallableMock;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createDocsRagConfig(rootDir: string): any {
  return {
    tool: 'docs-rag-pg-lab',
    rootDir,
    defaultEvalFixturePath: join(rootDir, 'fixture.json'),
    evalTopK: 5,
    healthTimeoutMs: 5_000,
    embedding: {
      provider: 'llamacpp',
      model: 'qwen3-embedding-1024',
      baseUrl: 'http://127.0.0.1:8082',
      dimensions: 1024,
      timeoutMs: 60_000,
    },
    database: {
      url: 'postgres://127.0.0.1:5542/docs_rag_lab',
      redactedUrl: 'postgres://127.0.0.1:5542/docs_rag_lab',
      source: 'test',
    },
    gates: {
      liveSearchEnabled: true,
      embeddingEnabled: true,
      mutationEnabled: true,
    },
  };
}

describe('sync-external-docs --dry-run', () => {
  let testDir: string | undefined;

  beforeEach(() => {
    mockFn(inspectDocsRagLabDocumentProcessing).mockImplementation(
      async (
        config: Parameters<typeof docsRagLabDocumentNeedsProcessing>[0],
        input: Parameters<typeof docsRagLabDocumentNeedsProcessing>[1]
      ) => {
        const needsProcessing = Boolean(
          await mockFn(docsRagLabDocumentNeedsProcessing)(config, input)
        );
        return {
          needsProcessing,
          contentChanged: needsProcessing,
          indexRepairNeeded: false,
          processedContentSha256: null,
        };
      }
    );
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
    vi.clearAllMocks();
    mockFn(deleteStaleDocsRagLabDocuments).mockReset();
    mockFn(docsRagLabDocumentNeedsProcessing).mockReset();
    mockFn(upsertDocsRagLabDocument).mockReset();
  });

  it('does not call store, LLM, or embedder in dry-run mode', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-dry-run-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'processed.md');
    writeFileSync(rawFilePath, '# Source\n\nEmail: john@example.com');

    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn(),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'python-docs/source.md',
      'python',
      null,
      { dryRun: true, skipLlm: true },
      deps
    );

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(existsSync(processedFilePath)).toBe(false);
    expect(deps.chunker).toHaveBeenCalledTimes(1);
    expect(deps.refiner).not.toHaveBeenCalled();
    expect(docsRagLabDocumentNeedsProcessing).not.toHaveBeenCalled();
    expect(upsertDocsRagLabDocument).not.toHaveBeenCalled();
  });

  it('completes a multi-file orchestration dry-run without a generation or store writes', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-main-dry-run-'));
    const sourceRootDir = join(testDir, 'sources');
    const fixtureSourceDir = join(sourceRootDir, 'zod-docs', 'fixture');
    const reportDir = join(testDir, 'reports');
    mkdirSync(fixtureSourceDir, { recursive: true });
    writeFileSync(
      join(fixtureSourceDir, 'first.mdx'),
      '# Zod fixture one\n\nA schema validates structured input before parsing.\n'
    );
    writeFileSync(
      join(fixtureSourceDir, 'second.mdx'),
      '# Zod fixture two\n\nA parser returns typed data after validation succeeds.\n'
    );

    const exitCode = await main({
      dryRun: true,
      skipLlm: true,
      sourceName: 'zod-docs',
      sourceRootDir,
      reportDir,
      maxFailedDocs: 0,
      maxFailureRate: 0.05,
      maxSourceBytes: 32 * 1024 * 1024,
      maxEstimatedChunks: 30_000,
      maxRunBytes: 32 * 1024 * 1024,
      maxRunEstimatedChunks: 30_000,
      fileConcurrency: 1,
    });

    const reportFile = readdirSync(reportDir).find((name) => name.endsWith('.json'));
    expect(exitCode).toBe(0);
    expect(reportFile).toBeDefined();
    const report = JSON.parse(readFileSync(join(reportDir, reportFile as string), 'utf-8'));
    const attemptedFiles = report.totals.attemptedFiles;
    expect(attemptedFiles).toBeGreaterThan(1);
    expect(report).toMatchObject({
      dryRun: true,
      status: 'ok',
      totals: { attemptedFiles: expect.any(Number), failedFiles: 0 },
    });
    expect(docsRagLabDocumentNeedsProcessing).not.toHaveBeenCalled();
    expect(inspectDocsRagLabDocumentProcessing).not.toHaveBeenCalled();
    expect(upsertDocsRagLabDocument).not.toHaveBeenCalled();
    expect(deleteStaleDocsRagLabDocuments).not.toHaveBeenCalled();
  });

  it('fails closed for non-dry-run processing without a source generation', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-missing-generation-'));
    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'processed.md');
    writeFileSync(rawFilePath, '# Source\n\nUseful technical content.');
    const deps = {
      chunker: vi.fn(),
      refiner: vi.fn(),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: true },
      deps
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('source generation is required');
    expect(deps.chunker).not.toHaveBeenCalled();
    expect(deps.refiner).not.toHaveBeenCalled();
    expect(existsSync(processedFilePath)).toBe(false);
    expect(upsertDocsRagLabDocument).not.toHaveBeenCalled();
  });

  it('rejects unknown external source prefixes before writing in dry-run mode', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-dry-run-unknown-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'processed.md');
    writeFileSync(rawFilePath, '# Source\n\nUnknown external docs.');

    const deps = {
      chunker: vi.fn(),
      refiner: vi.fn(),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'unknown-docs/source.md',
      'unknown',
      null,
      { dryRun: true, skipLlm: true },
      deps
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown external Docs RAG source prefix');
    expect(existsSync(processedFilePath)).toBe(false);
    expect(deps.chunker).not.toHaveBeenCalled();
    expect(deps.refiner).not.toHaveBeenCalled();
    expect(upsertDocsRagLabDocument).not.toHaveBeenCalled();
  });

  it('saves normalized source metadata for ingested external docs', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-metadata-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/go-books/effective-go.md');
    writeFileSync(rawFilePath, '# Effective Go\n\nUse interfaces effectively.');

    mockFn(docsRagLabDocumentNeedsProcessing).mockResolvedValue(true);
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const deps = {
      chunker: vi.fn().mockResolvedValue([
        {
          content: 'chunk',
          searchableText: 'chunk',
          heading: 'Interfaces',
          section: 'Language basics',
        },
      ]),
      refiner: vi.fn(),
    };
    const docsRagConfig = createDocsRagConfig(testDir);

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'go-books/effective-go.md',
      'go',
      docsRagConfig,
      {
        dryRun: false,
        skipLlm: true,
        generationId: 1,
        sourceUrl: 'https://github.com/example/docs.git',
        sourceRevision: 'a'.repeat(40),
        upstreamPath: 'effective-go.md',
        syncedAt: '2026-08-30T00:00:00.000Z',
      },
      deps
    );

    expect(result.success).toBe(true);
    expect(docsRagLabDocumentNeedsProcessing).toHaveBeenCalledWith(
      docsRagConfig,
      expect.objectContaining({
        sourceId: 'go-books',
        sourcePath: 'ingest/processed/external/go-books/effective-go.md',
      })
    );
    expect(upsertDocsRagLabDocument).toHaveBeenCalledTimes(1);
    const payload = mockFn(upsertDocsRagLabDocument).mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      sourceId: 'go-books',
      sourcePath: 'ingest/processed/external/go-books/effective-go.md',
      category: 'go',
      metadata: {
        sourceId: 'go-books',
        category: 'go',
        language: 'go',
        kind: 'book',
        authority: 'community-vetted',
        tags: ['go', 'book'],
        rawSourcePath: 'go-books/effective-go.md',
        canonicalUrl: `https://github.com/example/docs/blob/${'a'.repeat(40)}/effective-go.md`,
        sourceRevision: 'a'.repeat(40),
        syncedAt: '2026-08-30T00:00:00.000Z',
      },
      chunks: [
        {
          chunkIndex: 0,
          content: 'chunk',
          searchableText: 'chunk',
          heading: 'Interfaces',
          section: 'Language basics',
        },
      ],
    });
  });

  it('builds and validates canonical GitHub blob provenance', () => {
    const sourceRevision = 'b'.repeat(64);
    expect(
      buildExternalDocsProvenance({
        sourceUrl: 'https://github.com/example/docs.git',
        sourceRevision,
        upstreamPath: 'docs/guide/hello world.md',
        syncedAt: '2026-08-30T00:00:00.000Z',
      })
    ).toEqual({
      canonicalUrl: `https://github.com/example/docs/blob/${sourceRevision}/docs/guide/hello%20world.md`,
      sourceRevision,
      syncedAt: '2026-08-30T00:00:00.000Z',
    });

    expect(() =>
      buildExternalDocsProvenance({
        sourceUrl: 'http://github.com/example/docs.git',
        sourceRevision: 'c'.repeat(40),
        upstreamPath: 'docs/index.md',
        syncedAt: '2026-08-30T00:00:00.000Z',
      })
    ).toThrow(/HTTPS GitHub repository/);
    expect(() =>
      buildExternalDocsProvenance({
        sourceUrl: 'https://github.com/example/docs.git',
        sourceRevision: 'not-a-revision',
        upstreamPath: 'docs/index.md',
        syncedAt: '2026-08-30T00:00:00.000Z',
      })
    ).toThrow(/40 or 64 hexadecimal/);
    expect(() =>
      buildExternalDocsProvenance({
        sourceUrl: 'https://github.com/example/docs.git',
        sourceRevision: 'c'.repeat(40),
        upstreamPath: '../secrets.md',
        syncedAt: '2026-08-30T00:00:00.000Z',
      })
    ).toThrow(/safe POSIX/);
  });

  it('sanitizes raw content before persisting processed docs when LLM is skipped', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-sanitize-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/go-books/effective-go.md');
    writeFileSync(rawFilePath, '# Source\n\npostgres://docs:secret@127.0.0.1:5441/docs_lab');

    mockFn(docsRagLabDocumentNeedsProcessing).mockResolvedValue(true);
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn(),
    };
    const docsRagConfig = createDocsRagConfig(testDir);

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'go-books/effective-go.md',
      'go',
      docsRagConfig,
      { dryRun: false, skipLlm: true, generationId: 1 },
      deps
    );

    expect(result.success).toBe(true);
    expect(readFileSync(processedFilePath, 'utf-8')).toContain('[REDACTED_CREDENTIALS]');
    expect(readFileSync(processedFilePath, 'utf-8')).not.toContain('secret');
    expect(deps.chunker).toHaveBeenCalledWith(
      expect.stringContaining('[REDACTED_CREDENTIALS]'),
      expect.anything(),
      expect.anything()
    );
    expect(mockFn(upsertDocsRagLabDocument).mock.calls[0]?.[1].content).toContain(
      '[REDACTED_CREDENTIALS]'
    );
  });

  it('rejects refined documents that produce no chunks before writing or upserting', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-empty-chunks-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    writeFileSync(rawFilePath, '# Source\n\nUseful technical content.');

    mockFn(docsRagLabDocumentNeedsProcessing).mockResolvedValue(true);
    const deps = {
      chunker: vi.fn().mockResolvedValue([]),
      refiner: vi.fn().mockResolvedValue('# Source\n\nUseful technical content.'),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      deps
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('zero chunks');
    expect(existsSync(processedFilePath)).toBe(false);
    expect(upsertDocsRagLabDocument).not.toHaveBeenCalled();
  });

  it('reprocesses an invalid cached artifact even when the raw hash is unchanged', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-invalid-cache-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    writeFileSync(rawFilePath, '# Source\n\nUseful technical content.');
    mkdirSync(dirname(processedFilePath), { recursive: true });
    writeFileSync(processedFilePath, '');

    mockFn(docsRagLabDocumentNeedsProcessing).mockResolvedValue(false);
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn().mockResolvedValue('# Source\n\nRepaired technical content.'),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      deps
    );

    expect(result.success).toBe(true);
    expect(result.skipped).not.toBe(true);
    expect(deps.refiner).toHaveBeenCalledTimes(1);
    expect(readFileSync(processedFilePath, 'utf-8')).toContain('Repaired technical content.');
    expect(upsertDocsRagLabDocument).toHaveBeenCalledTimes(1);
  });

  it('reuses a valid cached artifact for an index-only repair without the refiner', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-index-only-repair-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    const cachedContent = '# Source\n\nStable refined technical content.';
    writeFileSync(rawFilePath, '# Source\n\nStable upstream technical content.');
    mkdirSync(dirname(processedFilePath), { recursive: true });
    writeFileSync(processedFilePath, cachedContent);

    mockFn(docsRagLabDocumentNeedsProcessing).mockResolvedValue(true);
    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: true,
      contentChanged: false,
      indexRepairNeeded: true,
      processedContentSha256: sha256(cachedContent),
    });
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn().mockRejectedValue(new Error('refiner unavailable')),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      deps
    );

    expect(result.success).toBe(true);
    expect(deps.refiner).not.toHaveBeenCalled();
    expect(readFileSync(processedFilePath, 'utf-8')).toBe(cachedContent);
    expect(mockFn(upsertDocsRagLabDocument).mock.calls[0]?.[1].content).toBe(cachedContent);
  });

  it('reuses a valid cached artifact when raw content is excluded', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-excluded-raw-cache-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    const cachedContent = '# Source\n\nStable refined technical content.';
    writeFileSync(rawFilePath, '<!--{ "Redirect": "/api" }-->');
    mkdirSync(dirname(processedFilePath), { recursive: true });
    writeFileSync(processedFilePath, cachedContent);

    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: true,
      contentChanged: true,
      indexRepairNeeded: false,
      processedContentSha256: sha256(cachedContent),
    });
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn().mockRejectedValue(new Error('refiner unavailable')),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      deps
    );

    expect(result.success).toBe(true);
    expect(deps.refiner).not.toHaveBeenCalled();
    expect(readFileSync(processedFilePath, 'utf-8')).toBe(cachedContent);
    expect(mockFn(upsertDocsRagLabDocument).mock.calls[0]?.[1].content).toBe(cachedContent);
  });

  it('does not leave a staged artifact after the Postgres commit fails', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-db-failure-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    writeFileSync(rawFilePath, '# Source\n\nUseful technical content.');
    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: true,
      contentChanged: true,
      indexRepairNeeded: false,
      processedContentSha256: null,
    });
    mockFn(upsertDocsRagLabDocument).mockRejectedValue(new Error('database unavailable'));
    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn().mockResolvedValue('# Source\n\nRefined content.'),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      deps
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('database unavailable');
    expect(existsSync(processedFilePath)).toBe(false);
    expect(readFileSync(rawFilePath, 'utf-8')).toContain('Useful technical content.');
    expect(
      readdirSync(dirname(processedFilePath), { withFileTypes: true }).filter((entry) =>
        entry.name.includes('.tmp-')
      )
    ).toHaveLength(0);
  });

  it('retains a post-commit staging artifact and adopts it on retry', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-stage-retry-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    const refinedContent = '# Source\n\nRefined content survives the retry.';
    writeFileSync(rawFilePath, '# Source\n\nUseful technical content.');
    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: true,
      contentChanged: true,
      indexRepairNeeded: false,
      processedContentSha256: null,
    });
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const renameStage = vi.fn(() => {
      throw new Error('cache rename interrupted');
    });
    const firstDeps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn().mockResolvedValue(refinedContent),
      renameStage,
    };

    const firstResult = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      firstDeps
    );

    expect(firstResult.success).toBe(false);
    expect(renameStage).toHaveBeenCalledTimes(1);
    const stagedFiles = readdirSync(dirname(processedFilePath)).filter((name) =>
      name.includes('.tmp-')
    );
    expect(stagedFiles).toHaveLength(1);

    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: false,
      contentChanged: false,
      indexRepairNeeded: false,
      processedContentSha256: sha256(refinedContent),
    });
    const retryRefiner = vi.fn().mockRejectedValue(new Error('refiner must not run on retry'));
    const retryResult = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      {
        chunker: vi.fn(),
        refiner: retryRefiner,
      }
    );

    expect(retryResult).toEqual({ success: true, file: 'bun-docs/source.md', skipped: true });
    expect(retryRefiner).not.toHaveBeenCalled();
    expect(readFileSync(processedFilePath, 'utf-8')).toBe(refinedContent);
    expect(
      readdirSync(dirname(processedFilePath)).filter((name) => name.includes('.tmp-'))
    ).toEqual([]);
  });

  it('does not adopt a staged artifact after a processing-identity change', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-stage-profile-change-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    const staleContent = '# Source\n\nStaged with the previous processing identity.';
    const freshContent = '# Source\n\nRebuilt for the current processing identity.';
    writeFileSync(rawFilePath, '# Source\n\nUseful upstream technical content.');
    mkdirSync(dirname(processedFilePath), { recursive: true });
    const stalePath = `${processedFilePath}.tmp-stale-profile`;
    writeFileSync(stalePath, staleContent);

    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: true,
      contentChanged: true,
      indexRepairNeeded: false,
      processedContentSha256: sha256(staleContent),
    });
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const refiner = vi.fn().mockResolvedValue(freshContent);
    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      {
        chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
        refiner,
      }
    );

    expect(result.success).toBe(true);
    expect(refiner).toHaveBeenCalledTimes(1);
    expect(readFileSync(processedFilePath, 'utf-8')).toBe(freshContent);
    expect(existsSync(stalePath)).toBe(false);
    expect(inspectDocsRagLabDocumentProcessing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ processingProfileHash: 'test-processing-profile' })
    );
  });

  it('rebuilds a revision-bound skip-LLM document from sanitized raw bytes when profile parity is unknown', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-profile-miss-raw-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    const rawContent =
      '# Source\n\nRaw technical content: postgres://docs:old-cache-check@127.0.0.1:5441/docs_lab';
    const oldCache = '# Source\n\nOld canonical content must not be relabeled.';
    writeFileSync(rawFilePath, rawContent);
    mkdirSync(dirname(processedFilePath), { recursive: true });
    writeFileSync(processedFilePath, oldCache);

    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: true,
      contentChanged: true,
      indexRepairNeeded: false,
      processedContentSha256: null,
    });
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      {
        dryRun: false,
        skipLlm: true,
        generationId: 1,
        sourceUrl: 'https://github.com/example/docs.git',
        sourceRevision: 'a'.repeat(40),
        upstreamPath: 'source.md',
        syncedAt: '2026-08-30T00:00:00.000Z',
      },
      {
        chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
        refiner: vi.fn(),
      }
    );

    const sanitizedRawContent = prepareDeterministicExternalDocContent(
      rawContent,
      'bun-docs/source.md'
    );
    expect(result.success).toBe(true);
    expect(upsertDocsRagLabDocument).toHaveBeenCalledTimes(1);
    expect(mockFn(upsertDocsRagLabDocument).mock.calls[0]?.[1].content).toBe(sanitizedRawContent);
    expect(readFileSync(processedFilePath, 'utf8')).toBe(sanitizedRawContent);
    expect(readFileSync(processedFilePath, 'utf8')).not.toBe(oldCache);
  });

  it('honors force by invoking the refiner for cache-backed excluded raw content', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-excluded-raw-force-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    const cachedContent = '# Source\n\nStable refined technical content.';
    const forcedContent = '# Source\n\nForced refined technical content.';
    writeFileSync(rawFilePath, '<!--{ "Redirect": "/api" }-->');
    mkdirSync(dirname(processedFilePath), { recursive: true });
    writeFileSync(processedFilePath, cachedContent);

    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: false,
      contentChanged: false,
      indexRepairNeeded: false,
    });
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn().mockResolvedValue(forcedContent),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, force: true, generationId: 1 },
      deps
    );

    expect(result.success).toBe(true);
    expect(deps.refiner).toHaveBeenCalledTimes(1);
    expect(readFileSync(processedFilePath, 'utf-8')).toBe(forcedContent);
    expect(mockFn(upsertDocsRagLabDocument).mock.calls[0]?.[1].content).toBe(forcedContent);
  });

  it('preserves the cache and disables cleanup when forced refinement fails', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-excluded-raw-force-failure-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    const cachedContent = '# Source\n\nStable refined technical content.';
    writeFileSync(rawFilePath, '<!--{ "Redirect": "/api" }-->');
    mkdirSync(dirname(processedFilePath), { recursive: true });
    writeFileSync(processedFilePath, cachedContent);

    mockFn(inspectDocsRagLabDocumentProcessing).mockResolvedValue({
      needsProcessing: false,
      contentChanged: false,
      indexRepairNeeded: false,
    });
    const deps = {
      chunker: vi.fn(),
      refiner: vi.fn().mockRejectedValue(new Error('refiner unavailable')),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, force: true, generationId: 1 },
      deps
    );

    expect(result.success).toBe(false);
    expect(readFileSync(processedFilePath, 'utf-8')).toBe(cachedContent);
    expect(upsertDocsRagLabDocument).not.toHaveBeenCalled();
    expect(
      shouldRunGarbageCollection({
        dryRun: false,
        skipLlm: false,
        skipped: 0,
        failed: 1,
      })
    ).toBe(false);
  });

  it('does not replace a valid cached artifact when refinement produces invalid content', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-invalid-refinement-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'ingest/processed/external/bun-docs/source.md');
    const cachedContent = '# Source\n\nPreviously valid technical content.';
    writeFileSync(rawFilePath, '# Source\n\nUpdated technical content.');
    mkdirSync(dirname(processedFilePath), { recursive: true });
    writeFileSync(processedFilePath, cachedContent);

    mockFn(docsRagLabDocumentNeedsProcessing).mockResolvedValue(true);
    const deps = {
      chunker: vi.fn(),
      refiner: vi.fn().mockResolvedValue('<iframe src="widget"></iframe>'),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      createDocsRagConfig(testDir),
      { dryRun: false, skipLlm: false, generationId: 1 },
      deps
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-semantic');
    expect(readFileSync(processedFilePath, 'utf-8')).toBe(cachedContent);
    expect(deps.chunker).not.toHaveBeenCalled();
    expect(upsertDocsRagLabDocument).not.toHaveBeenCalled();
  });

  it('sanitizes known secret-like external docs content', () => {
    expect(sanitizeExternalDocsContent('postgres://docs:secret@127.0.0.1/db')).toBe(
      'postgres://[REDACTED_CREDENTIALS]@127.0.0.1/db'
    );
  });

  it('preserves indented RST imports during deterministic cleanup', () => {
    const input = [
      'RST example',
      '==========',
      '',
      '.. code-block:: python',
      '   import requests',
      '   requests.get("https://example.test")',
      '',
      'postgres://docs:secret@127.0.0.1/db',
    ].join('\n');

    const output = prepareDeterministicExternalDocContent(input, 'python-docs/guide.rst');

    expect(output).toContain('   import requests');
    expect(output).toContain('postgres://[REDACTED_CREDENTIALS]@127.0.0.1/db');
  });

  it('excludes a frontmatter-only Docker index with stale cache but retains an index with prose', () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-docker-index-'));
    const rawFile = join(testDir, '_index.md');
    const frontmatter = [
      '---',
      'title: Get started',
      'layout: get-started',
      'params:',
      '  tutorials:',
      '    - title: Build and share a containerized application',
      '      link: /get-started/tutorials/run-an-app/',
      '---',
      '',
    ].join('\n');
    writeFileSync(rawFile, frontmatter);
    writeFileSync(
      join(testDir, 'processed.md'),
      '# Get started\n\nRun a container using Docker Engine.'
    );
    const classify = () =>
      classifyExternalDocEntries(
        [{ rawFile, relativePath: 'get-started/_index.md' }],
        'docker-docs',
        prepareDeterministicExternalDocContent
      );

    expect(
      prepareDeterministicExternalDocContent(
        frontmatter,
        'docker-docs/get-started/_index.md'
      ).trim()
    ).toBe('');
    expect(classify().eligible).toEqual([]);
    expect(classify().excluded[0]?.quality.reasons).toContain('empty');

    writeFileSync(
      rawFile,
      `${frontmatter}\n# Get started\n\nRun a container using Docker Engine.\n`
    );
    expect(classify().eligible.map(({ sourcePath }) => sourcePath)).toEqual([
      'docker-docs/get-started/_index.md',
    ]);
    expect(classify().excluded).toEqual([]);
  });

  it('keeps Markdown import cleanup unchanged', () => {
    const output = prepareDeterministicExternalDocContent(
      '# Guide\n\nimport { Noise } from "x";\n\nUseful content.',
      'python-docs/guide.md'
    );

    expect(output).not.toContain('import { Noise }');
    expect(output).toContain('Useful content.');
  });

  it('saves normalized TypeScript source metadata for official docs', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-ts-metadata-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(
      testDir,
      'ingest/processed/external/typescript-docs/handbook/intro.md'
    );
    writeFileSync(rawFilePath, '# TypeScript\n\nTyped language documentation.');

    mockFn(docsRagLabDocumentNeedsProcessing).mockResolvedValue(true);
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 1,
      embeddedChunks: 1,
    });
    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn(),
    };
    const docsRagConfig = createDocsRagConfig(testDir);

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'typescript-docs/handbook/intro.md',
      'typescript',
      docsRagConfig,
      { dryRun: false, skipLlm: true, generationId: 1 },
      deps
    );

    expect(result.success).toBe(true);
    const payload = mockFn(upsertDocsRagLabDocument).mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      sourceId: 'typescript-docs',
      sourcePath: 'ingest/processed/external/typescript-docs/handbook/intro.md',
      category: 'typescript',
      metadata: {
        sourceId: 'typescript-docs',
        category: 'typescript',
        language: 'typescript',
        kind: 'official-docs',
        authority: 'official',
        tags: ['typescript', 'official'],
        rawSourcePath: 'typescript-docs/handbook/intro.md',
      },
    });
  });

  it('saves large documents through one Postgres upsert payload', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-docs-large-upsert-'));

    const rawFilePath = join(testDir, 'large.md');
    const processedFilePath = join(
      testDir,
      'ingest/processed/external/typescript-docs/reference/large.md'
    );
    const oversizedContent = `# Large\n\n${'x'.repeat(900_000)}`;
    writeFileSync(rawFilePath, oversizedContent);

    const chunks = Array.from({ length: 27 }, (_, index) => ({
      content: `chunk ${index}`,
      searchableText: `chunk ${index}`,
    }));
    mockFn(docsRagLabDocumentNeedsProcessing).mockResolvedValue(true);
    mockFn(upsertDocsRagLabDocument).mockResolvedValue({
      status: 'completed',
      documentId: 1,
      indexedChunks: 27,
      embeddedChunks: 27,
    });
    const deps = {
      chunker: vi.fn().mockResolvedValue(chunks),
      refiner: vi.fn(),
    };
    const docsRagConfig = createDocsRagConfig(testDir);

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'typescript-docs/reference/large.md',
      'typescript',
      docsRagConfig,
      { dryRun: false, skipLlm: true, generationId: 1 },
      deps
    );

    expect(result.success).toBe(true);
    const payload = mockFn(upsertDocsRagLabDocument).mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      sourceId: 'typescript-docs',
      sourcePath: 'ingest/processed/external/typescript-docs/reference/large.md',
      sourceAbsolutePath: processedFilePath,
      metadata: {
        sourceId: 'typescript-docs',
        category: 'typescript',
        language: 'typescript',
        kind: 'official-docs',
        authority: 'official',
        rawSourcePath: 'typescript-docs/reference/large.md',
      },
    });
    expect(payload.content).toBe(oversizedContent);
    expect(payload.chunks).toHaveLength(27);
  });

  it('uses existing processed file as preview source in dry-run mode', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-dry-run-preview-'));

    const rawFilePath = join(testDir, 'source.md');
    const processedFilePath = join(testDir, 'processed.md');
    writeFileSync(rawFilePath, '# Raw\n\nThis is raw content.');
    writeFileSync(processedFilePath, '# Processed\n\nThis is processed content.');

    const deps = {
      chunker: vi.fn().mockResolvedValue([{ content: 'chunk', searchableText: 'chunk' }]),
      refiner: vi.fn(),
    };

    const result = await processFile(
      rawFilePath,
      processedFilePath,
      'bun-docs/source.md',
      'bun',
      null,
      { dryRun: true, skipLlm: true },
      deps
    );

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(deps.chunker).toHaveBeenCalledWith(
      '# Processed\n\nThis is processed content.',
      expect.any(Object),
      expect.any(Object)
    );
    expect(deps.refiner).not.toHaveBeenCalled();
    expect(upsertDocsRagLabDocument).not.toHaveBeenCalled();
  });
});

describe('sync-external-docs runtime options and thresholds', () => {
  it('chunks external docs with contextual searchable text', async () => {
    const chunks = await chunkDocsRagTextWithContext(
      '# Install\n\nUse the CLI.\n\n## Configure\n\nSet the config file.',
      { title: 'Guide', sourcePath: 'docs/guide.md' },
      { chunkSize: 32, chunkOverlap: 0, docType: 'external' }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.searchableText).toContain('[Guide] > [docs/guide.md]');
    expect(chunks.every((chunk) => chunk.content.length > 0)).toBe(true);
  });

  it('builds source globs from configured file extensions', () => {
    expect(normalizeSourceFileExtensions(['.RST', 'md', 'rst', ''])).toEqual(['rst', 'md']);
    expect(normalizeSourceFileExtensions(['../bad'])).toEqual(['md', 'mdx']);
    expect(buildSourceGlob(['rst'])).toBe('**/*.rst');
    expect(buildSourceGlob(['md', 'mdx', 'rst'])).toBe('**/*.{md,mdx,rst}');
  });

  it('defaults external docs chunks below the llama.cpp per-input limit', () => {
    expect(resolveExternalDocsChunkConfig({})).toEqual({
      chunkSize: 1000,
      chunkOverlap: 50,
    });
    expect(resolveExternalDocsChunkConfig({ CHUNK_SIZE: '640', CHUNK_OVERLAP: '64' })).toEqual({
      chunkSize: 640,
      chunkOverlap: 64,
    });
  });

  it('defaults external docs embedding to low-memory batches', () => {
    expect(resolveExternalDocsEmbeddingOptions({})).toEqual({
      batchSize: 2,
      maxConcurrentBatches: 1,
    });
    expect(
      resolveExternalDocsEmbeddingOptions({
        SYNC_EXTERNAL_EMBEDDING_BATCH_SIZE: '6',
        SYNC_EXTERNAL_EMBEDDING_MAX_CONCURRENT_BATCHES: '2',
      })
    ).toEqual({
      batchSize: 6,
      maxConcurrentBatches: 2,
    });
    expect(
      resolveExternalDocsEmbeddingOptions({
        SYNC_EXTERNAL_EMBEDDING_BATCH_SIZE: '0',
        SYNC_EXTERNAL_EMBEDDING_MAX_CONCURRENT_BATCHES: '-1',
      })
    ).toEqual({
      batchSize: 1,
      maxConcurrentBatches: 1,
    });
  });

  it('estimates and enforces external docs sync budgets before ingestion', () => {
    const budgetDir = mkdtempSync(join(tmpdir(), 'sync-docs-budget-'));
    const smallFile = join(budgetDir, 'small.md');
    const largeFile = join(budgetDir, 'large.md');
    writeFileSync(smallFile, 'x'.repeat(500));
    writeFileSync(largeFile, 'x'.repeat(1200));

    try {
      const budget = estimateExternalDocsBudget(
        [{ rawFile: smallFile }, { rawFile: largeFile }],
        500,
        50
      );

      expect(budget).toEqual({ totalBytes: 1700, estimatedChunks: 5 });
      expect(() =>
        assertExternalDocsBudget('test-source', budget, {
          maxSourceBytes: 1700,
          maxEstimatedChunks: 5,
        })
      ).not.toThrow();
      expect(() =>
        assertExternalDocsBudget('test-source', budget, {
          maxSourceBytes: 1699,
          maxEstimatedChunks: 5,
        })
      ).toThrow('source bytes 1700 exceeds maxSourceBytes 1699');
      expect(() =>
        assertExternalDocsBudget('test-source', budget, {
          maxSourceBytes: 1700,
          maxEstimatedChunks: 4,
        })
      ).toThrow('estimated chunks 5 exceeds maxEstimatedChunks 4');
    } finally {
      rmSync(budgetDir, { recursive: true, force: true });
    }
  });

  it('enforces total external docs sync run budgets before source ingestion', () => {
    expect(() =>
      assertExternalDocsRunBudget(
        'source-b',
        { totalBytes: 2600, estimatedChunks: 8 },
        { maxRunBytes: 2600, maxRunEstimatedChunks: 8 }
      )
    ).not.toThrow();
    expect(() =>
      assertExternalDocsRunBudget(
        'source-b',
        { totalBytes: 2601, estimatedChunks: 8 },
        { maxRunBytes: 2600, maxRunEstimatedChunks: 8 }
      )
    ).toThrow('run bytes 2601 exceeds maxRunBytes 2600');
    expect(() =>
      assertExternalDocsRunBudget(
        'source-b',
        { totalBytes: 2600, estimatedChunks: 9 },
        { maxRunBytes: 2600, maxRunEstimatedChunks: 8 }
      )
    ).toThrow('run estimated chunks 9 exceeds maxRunEstimatedChunks 8');
  });

  it('keeps pre-read run budgets cumulative when a source has no eligible files', () => {
    const afterExcludedSource = accumulateExternalDocsBudget(
      { totalBytes: 0, estimatedChunks: 0 },
      { totalBytes: 900, estimatedChunks: 9 }
    );
    const afterEligibleSource = accumulateExternalDocsBudget(afterExcludedSource, {
      totalBytes: 200,
      estimatedChunks: 2,
    });

    expect(afterEligibleSource).toEqual({ totalBytes: 1100, estimatedChunks: 11 });
    expect(() =>
      assertExternalDocsRunBudget('eligible-source', afterEligibleSource, {
        maxRunBytes: 1000,
        maxRunEstimatedChunks: 10,
      })
    ).toThrow('run bytes 1100 exceeds maxRunBytes 1000');
  });

  it('filters unsafe raw entries before pre-read budget estimation', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-docs-prefilter-'));
    const outside = mkdtempSync(join(tmpdir(), 'sync-docs-prefilter-outside-'));
    const symlink = join(root, 'linked.md');
    const directory = join(root, 'directory.md');
    writeFileSync(join(outside, 'linked.md'), 'x'.repeat(2_000));
    symlinkSync(join(outside, 'linked.md'), symlink);
    mkdirSync(directory);

    expect(
      filterExternalDocEntries([
        { rawFile: symlink, relativePath: 'linked.md' },
        { rawFile: directory, relativePath: 'directory.md' },
      ])
    ).toEqual([]);
  });

  it('forces skipLlm when dry-run is enabled', () => {
    const options = parseSyncRuntimeOptions(['--dry-run']);
    expect(options.dryRun).toBe(true);
    expect(options.skipLlm).toBe(true);
  });

  it('parses external docs sync budget limits from environment', () => {
    const options = parseSyncRuntimeOptions([], {
      SYNC_EXTERNAL_REPORT_DIR: '/tmp/report',
      SYNC_EXTERNAL_MAX_SOURCE_BYTES: '1234',
      SYNC_EXTERNAL_MAX_ESTIMATED_CHUNKS: '56',
      SYNC_EXTERNAL_MAX_RUN_BYTES: '2345',
      SYNC_EXTERNAL_MAX_RUN_ESTIMATED_CHUNKS: '67',
      SYNC_EXTERNAL_FILE_CONCURRENCY: '3',
    } as NodeJS.ProcessEnv);

    expect(options.reportDir).toBe('/tmp/report');
    expect(options.maxSourceBytes).toBe(1234);
    expect(options.maxEstimatedChunks).toBe(56);
    expect(options.maxRunBytes).toBe(2345);
    expect(options.maxRunEstimatedChunks).toBe(67);
    expect(options.fileConcurrency).toBe(3);
  });

  it('defaults to a conservative estimated chunk budget for 4096-dimensional embeddings', () => {
    const options = parseSyncRuntimeOptions([], {
      SYNC_EXTERNAL_REPORT_DIR: '/tmp/report',
    } as NodeJS.ProcessEnv);

    expect(options.maxEstimatedChunks).toBe(30_000);
    expect(options.maxRunEstimatedChunks).toBe(30_000);
    expect(options.fileConcurrency).toBe(1);
  });

  it('parses --source and --force options', () => {
    const options = parseSyncRuntimeOptions(['--source', 'bun-docs', '--force']);
    expect(options.sourceName).toBe('bun-docs');
    expect(options.force).toBe(true);
    expect(options.dryRun).toBe(false);
  });

  it('rejects --source without value', () => {
    expect(() => parseSyncRuntimeOptions(['--source'])).toThrow(
      'Flag --source requires a non-empty value'
    );
  });

  it('rejects --force without --source', () => {
    expect(() => parseSyncRuntimeOptions(['--force'])).toThrow(
      'Flag --force requires --source <name>'
    );
  });

  it('runs GC when skipped files were seen but no failures occurred', () => {
    expect(
      shouldRunGarbageCollection({
        dryRun: false,
        skipLlm: false,
        skipped: 1,
        failed: 0,
      })
    ).toBe(true);
    expect(
      shouldRunGarbageCollection({
        dryRun: false,
        skipLlm: true,
        skipped: 1,
        failed: 0,
      })
    ).toBe(true);
    expect(
      shouldRunGarbageCollection({
        dryRun: false,
        skipLlm: false,
        skipped: 0,
        failed: 1,
      })
    ).toBe(false);
    expect(
      shouldRunGarbageCollection({
        dryRun: false,
        skipLlm: false,
        skipped: 0,
        failed: 0,
      })
    ).toBe(true);
  });

  it('builds canonical Postgres cleanup input for aliased source paths', () => {
    expect(
      buildDocsRagCleanupInput(
        'tailwind-docs',
        'tailwind',
        ['docs/installation.md', 'docs/installation.md'],
        process.cwd()
      )
    ).toEqual({
      sourceId: 'components',
      currentSourcePaths: ['ingest/processed/external/components/docs/installation.md'],
      allowDeleteAll: false,
    });
    expect(buildDocsRagCleanupInput('tailwind-docs', 'tailwind', [], process.cwd())).toEqual({
      sourceId: 'components',
      currentSourcePaths: [],
      allowDeleteAll: false,
    });
    expect(
      shouldRunDocsRagCleanup(
        buildDocsRagCleanupInput('tailwind-docs', 'tailwind', [], process.cwd())
      )
    ).toBe(false);
    expect(
      shouldRunDocsRagCleanup(
        buildDocsRagCleanupInput('tailwind-docs', 'tailwind', [], process.cwd(), true)
      )
    ).toBe(true);
  });

  it('allows delete-all only after a completed all-excluded source scan', () => {
    expect(
      shouldAllowDeleteAllForExcludedSource({
        pathFilteredFiles: 3,
        eligibleFiles: 0,
        contentExcludedFiles: 3,
      })
    ).toBe(true);
    expect(
      shouldAllowDeleteAllForExcludedSource({
        pathFilteredFiles: 0,
        eligibleFiles: 0,
        contentExcludedFiles: 0,
      })
    ).toBe(false);
    expect(
      shouldAllowDeleteAllForExcludedSource({
        pathFilteredFiles: 3,
        eligibleFiles: 1,
        contentExcludedFiles: 2,
      })
    ).toBe(false);
  });

  it('creates alerts when thresholds are exceeded', () => {
    const report: SyncRunReport = {
      startedAt: '2026-03-05T00:00:00.000Z',
      finishedAt: '2026-03-05T00:10:00.000Z',
      durationMs: 600000,
      dryRun: false,
      skipLlm: false,
      thresholds: { maxFailedDocs: 0, maxFailureRate: 0.05 },
      totals: {
        sources: 1,
        totalFiles: 100,
        ignoredFiles: 10,
        contentExcludedFiles: 0,
        attemptedFiles: 90,
        processedFiles: 80,
        skippedFiles: 0,
        failedFiles: 10,
        failureRate: 10 / 90,
        removedProcessedArtifacts: 0,
        deletedDocs: 0,
        deletedChunks: 0,
      },
      alerts: [],
      status: 'ok',
      sources: [],
    };

    const alerts = evaluateSyncThresholds(report);
    expect(alerts.length).toBe(2);
  });

  it('builds a durable progress report from completed sources', () => {
    const report = buildSyncRunReport({
      startedAt: '2026-03-05T00:00:00.000Z',
      finishedAt: '2026-03-05T00:00:02.000Z',
      durationMs: 2000,
      dryRun: false,
      skipLlm: true,
      maxFailedDocs: 0,
      maxFailureRate: 0.05,
      sources: [
        {
          source: 'bun-docs',
          totalFiles: 2,
          ignoredFiles: 0,
          contentExcludedFiles: 0,
          attemptedFiles: 2,
          processedFiles: 2,
          skippedFiles: 0,
          failedFiles: 0,
          failures: [],
          exclusions: [],
          durationMs: 1500,
          removedProcessedArtifacts: 0,
          deletedDocs: 1,
          deletedChunks: 3,
        },
      ],
    });

    expect(report.status).toBe('ok');
    expect(report.totals).toMatchObject({
      sources: 1,
      totalFiles: 2,
      processedFiles: 2,
      failedFiles: 0,
      deletedDocs: 1,
      deletedChunks: 3,
    });
    expect(report.sources.map((source) => source.source)).toEqual(['bun-docs']);
  });

  it('creates alerts when a source discovers no docs', () => {
    const report: SyncRunReport = {
      startedAt: '2026-03-05T00:00:00.000Z',
      finishedAt: '2026-03-05T00:00:01.000Z',
      durationMs: 1000,
      dryRun: true,
      skipLlm: true,
      thresholds: { maxFailedDocs: 0, maxFailureRate: 0.05 },
      totals: {
        sources: 1,
        totalFiles: 0,
        ignoredFiles: 0,
        contentExcludedFiles: 0,
        attemptedFiles: 0,
        processedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
        failureRate: 0,
        removedProcessedArtifacts: 0,
        deletedDocs: 0,
        deletedChunks: 0,
      },
      alerts: [],
      status: 'ok',
      sources: [
        {
          source: 'python-docs',
          totalFiles: 0,
          ignoredFiles: 0,
          contentExcludedFiles: 0,
          attemptedFiles: 0,
          processedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          failures: [],
          exclusions: [],
          durationMs: 1000,
          removedProcessedArtifacts: 0,
          deletedDocs: 0,
          deletedChunks: 0,
        },
      ],
    };

    expect(evaluateSyncThresholds(report)).toContain(
      'sources with no discovered docs: python-docs'
    );
  });

  it('does not replace latest report for dry-run reports', () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sync-report-dry-run-'));
    const reportDir = join(localDir, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const latestPath = join(reportDir, 'latest.json');
    writeFileSync(latestPath, JSON.stringify({ dryRun: false, status: 'ok' }), 'utf-8');

    const report: SyncRunReport = {
      startedAt: '2026-03-05T00:00:00.000Z',
      finishedAt: '2026-03-05T00:00:01.000Z',
      durationMs: 1000,
      dryRun: true,
      skipLlm: true,
      thresholds: { maxFailedDocs: 0, maxFailureRate: 0.05 },
      totals: {
        sources: 1,
        totalFiles: 0,
        ignoredFiles: 0,
        contentExcludedFiles: 0,
        attemptedFiles: 0,
        processedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
        failureRate: 0,
        removedProcessedArtifacts: 0,
        deletedDocs: 0,
        deletedChunks: 0,
      },
      alerts: [],
      status: 'ok',
      sources: [],
    };

    const paths = saveSyncRunReport(report, reportDir);

    expect(paths.latestPath).toBeNull();
    expect(existsSync(paths.timestampedPath)).toBe(true);
    expect(JSON.parse(readFileSync(latestPath, 'utf-8'))).toEqual({
      dryRun: false,
      status: 'ok',
    });

    rmSync(localDir, { recursive: true, force: true });
  });
});

describe('sync-external-docs cloneRepo', () => {
  let testDir: string | undefined;

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
    vi.clearAllMocks();
  });

  it('re-fetches docsPath sources when extracted docs exist without .git', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-clone-docs-path-'));

    const sourceRootDir = join(testDir, 'source-root');
    const repoDir = join(sourceRootDir, 'typescript-docs');
    const tmpCloneDir = join(testDir, 'rag-sync-typescript-docs-123');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'stale.md'), '# stale');

    const runGit = vi.fn((args: readonly string[], options: { cwd: string }) => {
      if (args[0] === 'checkout') {
        const docsSourceDir = join(options.cwd, 'packages', 'docs');
        mkdirSync(docsSourceDir, { recursive: true });
        writeFileSync(join(docsSourceDir, 'fresh.md'), '# fresh');
      }
    });

    await cloneRepo(
      {
        name: 'typescript-docs',
        url: 'https://example.com/typescript.git',
        branch: 'main',
        docsPath: 'packages/docs',
        category: 'typescript',
        fileExtensions: ['md'],
        ignorePaths: [],
      },
      {
        runGit,
        tempRootDir: testDir,
        sourceRootDir,
        now: () => 123,
      }
    );

    expect(runGit).toHaveBeenCalledWith(
      ['fetch', '--depth', '1', '--filter=blob:none', 'origin', 'main'],
      expect.objectContaining({ cwd: tmpCloneDir })
    );
    expect(readFileSync(join(repoDir, 'fresh.md'), 'utf-8')).toContain('# fresh');
    expect(existsSync(join(repoDir, 'stale.md'))).toBe(false);
    expect(existsSync(join(repoDir, '.git'))).toBe(false);
    expect(existsSync(tmpCloneDir)).toBe(false);
  });
});

describe('sync-external-docs source manifest identity', () => {
  it('is independent of traversal order and changes for path or byte changes', () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sync-manifest-'));
    const first = join(localDir, 'a.md');
    const second = join(localDir, 'b.md');
    writeFileSync(first, 'first bytes');
    writeFileSync(second, 'second bytes');
    const entries = [
      { rawFile: first, relativePath: 'docs/a.md' },
      { rawFile: second, relativePath: 'docs/b.md' },
    ];
    const digest = buildDocsRagSourceManifestHash(entries);
    expect(buildDocsRagSourceManifestHash([...entries].reverse())).toBe(digest);
    writeFileSync(second, 'changed bytes');
    expect(buildDocsRagSourceManifestHash(entries)).not.toBe(digest);
    rmSync(localDir, { recursive: true, force: true });
  });
});
