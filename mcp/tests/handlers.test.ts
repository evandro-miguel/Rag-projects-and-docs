/**
 * @module handlers.test
 * @description Unit tests for MCP handler functions.
 *
 * Test count: 35 tests
 * Target coverage: 60%+ for handlers.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// We need to mock before importing handlers
vi.mock('../lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../scripts/lib/config.js', () => ({
  SCRIPT_CONFIG: {
    CONCURRENCY_LIMIT: 2,
    PROJECT_SOURCE_PATH: '/test/project',
  },
}));
vi.mock('../../scripts/docs-rag/config.js', () => ({
  resolveDocsRagLabConfig: vi.fn(),
  resolveDocsRagLabConfigWithLocalDefault: vi.fn(),
}));
vi.mock('../../scripts/docs-rag/db.js', () => ({
  checkDocsRagLabDatabaseHealth: vi.fn(),
  checkDocsRagLabCorpusHealth: vi.fn(async () => ({
    status: 'healthy',
    documents: 1,
    unexpectedSourceIds: [],
    invalidPathCount: 0,
    sourcePathMismatchCount: 0,
    missingMetadataCount: 0,
    message: 'Corpus inventory is clean.',
  })),
}));
vi.mock('../../scripts/docs-rag/store.js', () => ({
  DOCS_RAG_REQUIRED_PROVENANCE_FIELDS: ['canonicalUrl', 'sourceRevision', 'syncedAt', 'authority'],
  getDocsRagLabDocumentByPath: vi.fn(),
  listDocsRagLabCategories: vi.fn(),
  searchDocsRagLab: vi.fn(),
}));
vi.mock('../../scripts/project-rag/ingest-postgres.js', () => ({
  ingestProjectRagPostgres: vi.fn(),
  ingestProjectRagPostgresFile: vi.fn(),
}));

import { PROJECT_SCOPE_ACK_TOKEN } from '../../lib/shared/project-scope-advisory.js';
import { resolveDocsRagLabConfigWithLocalDefault } from '../../scripts/docs-rag/config.js';
import {
  checkDocsRagLabCorpusHealth,
  checkDocsRagLabDatabaseHealth,
} from '../../scripts/docs-rag/db.js';
import {
  getDocsRagLabDocumentByPath,
  listDocsRagLabCategories,
  searchDocsRagLab,
} from '../../scripts/docs-rag/store.js';
import { SCRIPT_CONFIG } from '../../scripts/lib/config.js';
import {
  ingestProjectRagPostgres,
  ingestProjectRagPostgresFile,
} from '../../scripts/project-rag/ingest-postgres.js';

// Shared CONSUMED snapshot gate fixture matching production buildGateResult.
const CONSUMED_SNAPSHOT_GATE = {
  snapshotUuid: '00000000-0000-0000-0000-000000000001',
  status: 'CONSUMED',
  thresholdResult: 'delta_safe: write phase completed',
  preflightSummary: {
    addsCount: 1,
    updatesCount: 0,
    deletesCount: 0,
    eligibleCount: 1,
    trackedCount: 10,
    totalDelta: 1,
    blockedFindingCategories: '',
  },
};

// Now import after mocks
import {
  handleEnsureReranker,
  handleGetDocument,
  handleHealthCheck,
  handleListCategories,
  handleSearchAndAdapt,
  handleSearchDocs,
} from '../docs-handlers.js';
import { handleIngestProject, handleIngestProjectFile } from '../handlers.js';
import { rateLimiters } from '../lib/rate-limiter.js';
import {
  handleVerifyProjectIndex,
  setProjectRagPostgresRuntimeModulesForTesting,
} from '../project-handlers.js';

// Get the mock functions - use type assertion instead of vi.mocked()
const mockIngestProjectRagPostgres = ingestProjectRagPostgres as ReturnType<typeof vi.fn>;
const mockIngestProjectRagPostgresFile = ingestProjectRagPostgresFile as ReturnType<typeof vi.fn>;
const mockCheckDocsRagLabDatabaseHealth = checkDocsRagLabDatabaseHealth as ReturnType<typeof vi.fn>;
const mockCheckDocsRagLabCorpusHealth = checkDocsRagLabCorpusHealth as ReturnType<typeof vi.fn>;
const mockResolveDocsRagLabConfig = resolveDocsRagLabConfigWithLocalDefault as ReturnType<
  typeof vi.fn
>;
const mockGetDocsRagLabDocumentByPath = getDocsRagLabDocumentByPath as ReturnType<typeof vi.fn>;
const mockListDocsRagLabCategories = listDocsRagLabCategories as ReturnType<typeof vi.fn>;
const mockSearchDocsRagLab = searchDocsRagLab as ReturnType<typeof vi.fn>;
const testProjectRoot = mkdtempSync(join(tmpdir(), 'rag-v1-test-root-'));
const explicitProjectRoot = mkdtempSync(join(tmpdir(), 'rag-v1-test-explicit-root-'));
const docsVaultCleanupRoots = new Set<string>();
const inventoryFixtureRoot = mkdtempSync(join(tmpdir(), 'rag-v1-inventory-'));
const inventoryFixturePath = join(inventoryFixtureRoot, 'code_inventory.md');

function writeJsonLines(path: string, entries: readonly Record<string, unknown>[]) {
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function createLocalDocsVaultFixture() {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'rag-v1-docs-vault-'));
  const indexRoot = mkdtempSync(join(tmpdir(), 'rag-v1-docs-vault-index-'));
  docsVaultCleanupRoots.add(vaultRoot);
  docsVaultCleanupRoots.add(indexRoot);

  const canonicalPath = 'canonical/bun-docs/bundler/bytecode.md';
  const rawPath = 'raw/bun-docs/bundler/bytecode.md';
  const wikiPath = 'wiki/bun-docs/bundler/bytecode.md';
  mkdirSync(join(vaultRoot, 'canonical/bun-docs/bundler'), { recursive: true });
  mkdirSync(join(vaultRoot, 'raw/bun-docs/bundler'), { recursive: true });
  mkdirSync(join(vaultRoot, 'wiki/bun-docs/bundler'), { recursive: true });
  writeFileSync(join(vaultRoot, canonicalPath), '# Bytecode\n\nBytecode docs\n', 'utf8');
  writeFileSync(join(vaultRoot, rawPath), '# Bytecode\n\nBytecode docs\n', 'utf8');
  writeFileSync(join(vaultRoot, wikiPath), '# Bytecode\n\nBytecode docs\n', 'utf8');
  writeJsonLines(join(indexRoot, 'pages.jsonl'), [
    {
      bytes: 28,
      canonicalPath,
      canonicalUrl: 'https://bun.sh/docs/bundler/bytecode',
      contentHash: 'test-content-hash',
      headings: [],
      listedTitle: 'Bytecode',
      pageId: 'bun-docs:bundler/bytecode',
      rawPath,
      relativePath: 'bun-docs/bundler/bytecode.md',
      retrievedAt: '2026-06-22T00:00:00.000Z',
      sourceId: 'bun-docs',
      title: 'Bytecode',
      wikiHash: 'test-wiki-hash',
      wikiPath,
      wikiReference: 'bun-docs/bundler/bytecode',
    },
  ]);
  writeJsonLines(join(indexRoot, 'aliases.jsonl'), []);
  writeJsonLines(join(indexRoot, 'links.jsonl'), []);

  return { indexRoot, vaultRoot };
}

function createBrokenDocsVaultRoots() {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'rag-v1-docs-vault-broken-'));
  const indexRoot = mkdtempSync(join(tmpdir(), 'rag-v1-docs-vault-index-broken-'));
  docsVaultCleanupRoots.add(vaultRoot);
  docsVaultCleanupRoots.add(indexRoot);
  return { indexRoot, vaultRoot };
}

function writeInventoryFixture() {
  writeFileSync(
    inventoryFixturePath,
    `# Code Inventory

> Last updated: test fixture

### Shared

| ID | Status | Lines | Functions | Exports | Filepath | Description |
|----|--------|-------|-----------|---------|----------|-------------|
| 1 | [x] | 100 | 5 | 3 | \`lib/shared/project-registry.ts\` | Project registry |
| 2 | [x] | 200 | 10 | 8 | \`lib/search/scoring.ts\` | Search scoring |

### Docs

| ID | Status | Lines | Functions | Exports | Filepath | Description |
|----|--------|-------|-----------|---------|----------|-------------|
| 3 | [x] | 50 | 2 | 1 | \`docs/README.md\` | Documentation |
`,
    'utf8'
  );
}

function docsRagLabConfig(databaseUrl?: string) {
  return {
    tool: 'docs-rag-pg-lab',
    rootDir: testProjectRoot,
    defaultEvalFixturePath: '',
    evalTopK: 5,
    healthTimeoutMs: 5000,
    embedding: {
      provider: 'llamacpp',
      model: 'qwen3-embedding-1024',
      baseUrl: 'http://127.0.0.1:8082',
      dimensions: 1024,
      timeoutMs: 60000,
    },
    database: {
      url: databaseUrl,
      redactedUrl: databaseUrl,
      source: databaseUrl ? 'test' : undefined,
    },
    gates: {
      liveSearchEnabled: false,
      embeddingEnabled: false,
      mutationEnabled: false,
    },
  } as const;
}

const testDocsPostgresUrl = 'postgres://127.0.0.1:5542/docs_rag_lab';

function postgresSearchReport(
  results: Array<{
    sourceId?: string;
    sourcePath: string;
    title: string;
    content: string;
    heading?: string;
    section?: string;
    canonicalUrl?: string;
    sourceRevision?: string;
    syncedAt?: string;
    authority?: 'official' | 'publisher' | 'community-vetted';
    provenanceStatus?: 'complete' | 'degraded';
    missingFields?: string[];
    score?: number;
  }> = [
    {
      sourceId: 'docs',
      sourcePath: 'docs/start.md',
      title: 'Getting Started',
      content: 'First result content',
      section: 'Introduction',
      score: 0.95,
    },
    {
      sourceId: 'docs',
      sourcePath: 'docs/install.md',
      title: 'Installation',
      content: 'Second result content',
      section: 'Installation',
      score: 0.87,
    },
  ]
) {
  return {
    query: 'test',
    limit: 10,
    results: results.map((result, index) => ({
      sourceId: result.sourceId ?? 'docs',
      sourcePath: result.sourcePath,
      title: result.title,
      heading: result.heading,
      section: result.section,
      canonicalUrl: result.canonicalUrl,
      sourceRevision: result.sourceRevision,
      syncedAt: result.syncedAt,
      authority: result.authority,
      provenanceStatus: result.provenanceStatus,
      missingFields: result.missingFields,
      content: result.content,
      chunkIndex: index,
      score: result.score ?? 1,
    })),
  };
}

// Create shared mock client
const mockClient = {
  query: vi.fn(),
  mutation: vi.fn(),
  action: vi.fn(),
};

describe('MCP Handlers', () => {
  const originalProjectSourcePath = SCRIPT_CONFIG.PROJECT_SOURCE_PATH;
  const originalInventoryPath = process.env.RAG_CODE_INVENTORY_PATH;

  beforeAll(() => {
    writeInventoryFixture();
    process.env.RAG_CODE_INVENTORY_PATH = inventoryFixturePath;
    SCRIPT_CONFIG.PROJECT_SOURCE_PATH = testProjectRoot;
  });

  afterAll(() => {
    SCRIPT_CONFIG.PROJECT_SOURCE_PATH = originalProjectSourcePath;
    for (const root of docsVaultCleanupRoots) {
      rmSync(root, { force: true, recursive: true });
    }
    docsVaultCleanupRoots.clear();
    if (originalInventoryPath === undefined) {
      delete process.env.RAG_CODE_INVENTORY_PATH;
    } else {
      process.env.RAG_CODE_INVENTORY_PATH = originalInventoryPath;
    }
    rmSync(inventoryFixtureRoot, { force: true, recursive: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIngestProjectRagPostgres.mockReset();
    mockIngestProjectRagPostgresFile.mockReset();
    mockClient.query.mockReset();
    mockClient.mutation.mockReset();
    mockClient.action.mockReset();
    mockCheckDocsRagLabDatabaseHealth.mockReset();
    mockCheckDocsRagLabCorpusHealth.mockReset();
    mockGetDocsRagLabDocumentByPath.mockReset();
    mockListDocsRagLabCategories.mockReset();
    mockSearchDocsRagLab.mockReset();
    mockResolveDocsRagLabConfig.mockReturnValue(docsRagLabConfig(testDocsPostgresUrl));
    mockCheckDocsRagLabCorpusHealth.mockResolvedValue({
      status: 'healthy',
      documents: 1,
      unexpectedSourceIds: [],
      invalidPathCount: 0,
      sourcePathMismatchCount: 0,
      missingMetadataCount: 0,
      message: 'Corpus inventory is clean.',
    });
    mockSearchDocsRagLab.mockResolvedValue(postgresSearchReport());
    mockListDocsRagLabCategories.mockResolvedValue([
      { name: 'bun', displayName: 'Bun', docCount: 25, chunkCount: 150 },
      { name: 'react', displayName: 'React', docCount: 30, chunkCount: 200 },
    ]);
    mockGetDocsRagLabDocumentByPath.mockResolvedValue({
      document: { title: 'API Doc', sourcePath: 'bun-docs/runtime/http/server.mdx' },
      chunks: [
        { chunkIndex: 0, content: '# API Doc\n\nContent 1' },
        { chunkIndex: 1, content: 'Content 2' },
      ],
    });
    mockCheckDocsRagLabDatabaseHealth.mockResolvedValue({
      status: 'blocked',
      method: 'none',
      message: 'No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.',
      warnings: [],
    });
    delete process.env.DOCS_VAULT_ROOT;
    delete process.env.DOCS_VAULT_INDEX_ROOT;
    delete process.env.MCP_FULL_PROJECT_INGEST_MAX_FILES;
    delete process.env.MCP_ALLOW_LARGE_PROJECT_INGEST;
    process.env.PROJECT_RAG_BACKEND = 'legacy-backend';
    // Clear rate limiters to prevent interference between tests
    rateLimiters.ingest.clearAll();
    rateLimiters.ingestFile.clearAll();
    rateLimiters.search.clearAll();
    mockIngestProjectRagPostgres.mockResolvedValue({
      projectId: 'project-1',
      slug: 'test-project',
      postgresId: 1,
      finalStatus: 'completed',
      stats: {
        filesScanned: 1,
        filesSelected: 1,
        filesIndexed: 1,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 1,
        embeddingsCreated: 1,
        errors: [],
      },
      snapshotGate: CONSUMED_SNAPSHOT_GATE,
    });
    mockIngestProjectRagPostgresFile.mockResolvedValue({
      projectId: 'project-1',
      slug: 'test-project',
      postgresId: 1,
      finalStatus: 'completed',
      stats: {
        filesScanned: 1,
        filesSelected: 1,
        filesIndexed: 1,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 1,
        embeddingsCreated: 1,
        errors: [],
      },
      snapshotGate: CONSUMED_SNAPSHOT_GATE,
    });
  });

  describe('handleSearchDocs', () => {
    it('returns formatted Postgres results with scores and sections', async () => {
      const result = await handleSearchDocs({ query: 'getting started', limit: 10 });

      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'getting started',
        expect.objectContaining({ limit: 10, mode: 'keyword' })
      );
      expect(mockClient.action).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Found 2 results');
      expect(result.content[0].text).toContain('Getting Started');
      expect(result.content[0].text).toContain('**Score:** 0.950');
      expect((result as { structuredContent: any }).structuredContent.results[0]).toEqual(
        expect.objectContaining({ retrievalSource: 'docs_rag_postgres' })
      );
    });

    it('exposes canonical provenance independently of page-reference flags', async () => {
      const sourceRevision = 'a'.repeat(40);
      mockSearchDocsRagLab.mockResolvedValueOnce(
        postgresSearchReport([
          {
            sourceId: 'bun-docs',
            sourcePath: 'ingest/processed/external/bun-docs/runtime/http.md',
            title: 'HTTP',
            heading: 'Fetch',
            section: 'Requests',
            content: 'Use fetch.',
            canonicalUrl: `https://github.com/example/docs/blob/${sourceRevision}/runtime/http.md`,
            sourceRevision,
            syncedAt: '2026-08-30T00:00:00.000Z',
            authority: 'official',
            provenanceStatus: 'complete',
            missingFields: [],
            score: 0.9,
          },
        ])
      );

      const result = await handleSearchDocs({ query: 'http', limit: 1 });
      const row = (result as { structuredContent: any }).structuredContent.results[0];
      expect(row).toMatchObject({
        sourceId: 'bun-docs',
        sourcePath: 'ingest/processed/external/bun-docs/runtime/http.md',
        canonicalUrl: `https://github.com/example/docs/blob/${sourceRevision}/runtime/http.md`,
        title: 'HTTP',
        heading: 'Fetch',
        section: 'Requests',
        chunkIndex: 0,
        sourceRevision,
        syncedAt: '2026-08-30T00:00:00.000Z',
        authority: 'official',
        score: 0.9,
        content: 'Use fetch.',
        provenanceStatus: 'complete',
        missingFields: [],
      });
    });

    it('keeps legacy Postgres rows visibly degraded with CLI-equivalent fields', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(
        postgresSearchReport([
          {
            sourceId: 'legacy-source',
            sourcePath: 'legacy/source.md',
            title: 'Legacy',
            content: 'Legacy content.',
            score: 0.2,
          },
        ])
      );

      const result = await handleSearchDocs({ query: 'legacy', limit: 1 });
      const row = (result as { structuredContent: any }).structuredContent.results[0];
      expect(row).toMatchObject({
        canonicalUrl: null,
        sourceRevision: null,
        syncedAt: null,
        authority: null,
        provenanceStatus: 'degraded',
        missingFields: ['canonicalUrl', 'sourceRevision', 'syncedAt', 'authority'],
      });
    });

    it('handles empty Postgres results gracefully', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(postgresSearchReport([]));
      const result = await handleSearchDocs({ query: 'nothing', limit: 10 });
      expect(result.content[0].text).toContain('No results found');
    });

    it('clamps limit to minimum 1', async () => {
      await handleSearchDocs({ query: 'test', limit: 0 });
      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'test',
        expect.objectContaining({ limit: 1 })
      );
    });

    it('clamps limit to maximum 50', async () => {
      await handleSearchDocs({ query: 'test', limit: 100 });
      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'test',
        expect.objectContaining({ limit: 50 })
      );
    });

    it('filters by registered Docs RAG source metadata', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(
        postgresSearchReport([
          {
            sourceId: 'go-books',
            sourcePath: 'go-books/effective-go.md',
            title: 'Effective Go',
            content: 'Effective Go content',
            section: 'Interfaces',
            score: 0.99,
          },
          {
            sourceId: 'go-docs',
            sourcePath: 'go-docs/spec.md',
            title: 'Go Docs',
            content: 'Go official docs',
            section: 'Spec',
            score: 0.95,
          },
          {
            sourceId: 'python-docs',
            sourcePath: 'python-docs/classes.md',
            title: 'Python Docs',
            content: 'Python docs',
            section: 'Classes',
            score: 0.9,
          },
        ])
      );

      const result = await handleSearchDocs({
        query: 'interfaces',
        sourceId: 'go-books',
        language: 'go',
        kind: 'book',
        authority: 'community-vetted',
        limit: 2,
      });

      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'interfaces',
        expect.objectContaining({ limit: 8, sourceIds: ['go-books'] })
      );
      expect(result.content[0].text).toContain('Found 1 results');
      expect(result.content[0].text).toContain('Effective Go');
      expect(result.content[0].text).not.toContain('Go Docs');
      expect(result.content[0].text).not.toContain('Python Docs');
    });

    it('pushes a category-only filter into the backend source allowlist', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(postgresSearchReport([]));

      await handleSearchDocs({ query: 'conditional types', categories: ['typescript'] });

      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'conditional types',
        expect.objectContaining({ sourceIds: ['typescript-docs'] })
      );
    });

    it('uses registry-normalized metadata for structured output', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(
        postgresSearchReport([
          {
            sourceId: 'typescript-docs',
            sourcePath: 'typescript-docs/handbook-v2/The Handbook.md',
            title: 'TypeScript Docs',
            content: 'Typed language docs',
            section: 'Overview',
            score: 0.99,
          },
        ])
      );

      const result = await handleSearchDocs({
        query: 'typed helpers',
        sourceId: 'typescript-docs',
        language: 'typescript',
        kind: 'official-docs',
        authority: 'official',
        limit: 2,
      });

      const structured = (result as { structuredContent: unknown }).structuredContent;
      expect(structured).toEqual(
        expect.objectContaining({
          results: [
            expect.objectContaining({
              sourceId: 'typescript-docs',
              language: 'typescript',
              kind: 'official-docs',
              authority: 'official',
              retrievalSource: 'docs_rag_postgres',
            }),
          ],
        })
      );
    });

    it('requires Postgres when no local result can satisfy the request', async () => {
      mockResolveDocsRagLabConfig.mockReturnValueOnce(docsRagLabConfig());
      await expect(handleSearchDocs({ query: 'test' })).rejects.toThrow(
        'Docs RAG Postgres database is required'
      );
      expect(mockClient.action).not.toHaveBeenCalled();
    });

    it('propagates Postgres search errors', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('Search failed'));
      await expect(handleSearchDocs({ query: 'test' })).rejects.toThrow(
        'Failed to search: Search failed'
      );
    });

    it('uses local-first Docs Vault hits before Postgres search when configured', async () => {
      const fixture = createLocalDocsVaultFixture();
      process.env.DOCS_VAULT_ROOT = fixture.vaultRoot;
      process.env.DOCS_VAULT_INDEX_ROOT = fixture.indexRoot;

      const result = await handleSearchDocs({
        query: 'bun-docs/bundler/bytecode',
        retrievalMode: 'local_first',
        includePageRefs: true,
        includeTrust: true,
        limit: 10,
      });

      expect(mockSearchDocsRagLab).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Bytecode');
      expect(result.content[0].text).toContain('**Local Match:** exact-path');
      const structured = (result as { structuredContent: unknown }).structuredContent;
      expect(structured).toEqual(
        expect.objectContaining({
          retrievalMode: 'local_first',
          resultCount: 1,
          localFirstConfigured: true,
          results: [
            expect.objectContaining({
              sourcePath: 'bun-docs/bundler/bytecode.md',
              sourceId: 'bun-docs',
              retrievalSource: 'docs_vault_local',
              matchKind: 'exact-path',
            }),
          ],
        })
      );
    });

    it('falls back to Postgres when local-first is requested without Docs Vault roots', async () => {
      const result = await handleSearchDocs({
        query: 'getting started',
        retrievalMode: 'local_first',
        limit: 10,
      });

      expect(mockSearchDocsRagLab).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain(
        'Warning: Docs Vault local-first retrieval requested, but DOCS_VAULT_ROOT or DOCS_VAULT_INDEX_ROOT is not configured. Falling back to backend search.'
      );
    });

    it('preserves local-first warnings when Postgres returns no results', async () => {
      const fixture = createBrokenDocsVaultRoots();
      process.env.DOCS_VAULT_ROOT = fixture.vaultRoot;
      process.env.DOCS_VAULT_INDEX_ROOT = fixture.indexRoot;
      mockSearchDocsRagLab.mockResolvedValueOnce(postgresSearchReport([]));

      const result = await handleSearchDocs({
        query: 'missing docs',
        retrievalMode: 'local_first',
        limit: 10,
      });

      expect(result.content[0].text).toContain('No results found for query: "missing docs"');
      expect(result.content[0].text).toContain(
        'Warning: Docs Vault local pre-search failed; continuing with backend search.'
      );
      const structured = (result as { structuredContent: unknown }).structuredContent;
      expect(structured).toEqual(
        expect.objectContaining({
          resultCount: 0,
          warnings: [
            'Docs Vault local pre-search failed; continuing with backend search.',
            'Embedding gate disabled; backend search degraded to keyword-only mode.',
          ],
        })
      );
    });

    it('warns when the embedding gate downgrades hybrid search to keyword-only', async () => {
      const result = await handleSearchDocs({ query: 'vector scoring', limit: 5 });

      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'vector scoring',
        expect.objectContaining({ mode: 'keyword' })
      );
      const structured = (result as { structuredContent: { warnings: string[] } })
        .structuredContent;
      expect(structured.warnings).toContain(
        'Embedding gate disabled; backend search degraded to keyword-only mode.'
      );
      expect(result.content[0].text).toContain(
        'Warning: Embedding gate disabled; backend search degraded to keyword-only mode.'
      );
    });

    it('uses hybrid retrieval so exact API docs outrank nearby vector matches', async () => {
      mockResolveDocsRagLabConfig.mockReturnValueOnce({
        ...docsRagLabConfig(testDocsPostgresUrl),
        gates: {
          liveSearchEnabled: false,
          embeddingEnabled: true,
          mutationEnabled: false,
        },
      });
      mockSearchDocsRagLab.mockImplementationOnce(
        (_config: unknown, _query: string, options: { mode?: string }) =>
          Promise.resolve(
            postgresSearchReport(
              options.mode === 'vector'
                ? [
                    {
                      sourcePath:
                        'ingest/processed/external/bun-docs/guides/util/file-url-to-path.mdx',
                      title: 'file-url-to-path.mdx',
                      content: 'Bun.fileURLToPath converts file URLs.',
                      score: 3.5,
                    },
                  ]
                : [
                    {
                      sourcePath:
                        'ingest/processed/external/bun-docs/guides/process/nanoseconds.mdx',
                      title: 'nanoseconds.mdx',
                      content: 'Bun.nanoseconds returns process uptime.',
                      score: 13.3,
                    },
                    {
                      sourcePath:
                        'ingest/processed/external/bun-docs/guides/util/file-url-to-path.mdx',
                      title: 'file-url-to-path.mdx',
                      content: 'Bun.fileURLToPath converts file URLs.',
                      score: 3.5,
                    },
                  ]
            )
          )
      );
      const result = await handleSearchDocs({ query: 'Bun.nanoseconds()', limit: 5 });

      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'Bun.nanoseconds()',
        expect.objectContaining({ mode: 'hybrid' })
      );
      expect(result.content[0].text).toContain('## 1. nanoseconds.mdx');
      expect((result as { structuredContent: any }).structuredContent.results[0]).toEqual(
        expect.objectContaining({ title: 'nanoseconds.mdx' })
      );
    });

    it('warns when source filters match zero registered sources (sentinel path)', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(postgresSearchReport([]));

      const result = await handleSearchDocs({
        query: 'orphan filter',
        categories: ['definitely-not-a-registered-category'],
        limit: 5,
      });

      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'orphan filter',
        expect.objectContaining({ sourceIds: ['__no_matching_source__'] })
      );
      const structured = (result as { structuredContent: { warnings: string[] } })
        .structuredContent;
      expect(structured.warnings).toContain(
        'Filter matched zero sources; check category/sourceId/language/kind/tag values.'
      );
      expect(result.content[0].text).toContain('No results found for query: "orphan filter"');
      expect(result.content[0].text).toContain(
        'Warning: Filter matched zero sources; check category/sourceId/language/kind/tag values.'
      );
    });

    it('does not warn about zero-source filters when the filter matches registered sources', async () => {
      const result = await handleSearchDocs({
        query: 'conditional types',
        categories: ['typescript'],
      });

      expect(mockSearchDocsRagLab).toHaveBeenCalledWith(
        expect.anything(),
        'conditional types',
        expect.objectContaining({ sourceIds: ['typescript-docs'] })
      );
      const structured = (result as { structuredContent: { warnings: string[] } })
        .structuredContent;
      expect(structured.warnings).not.toContain(
        'Filter matched zero sources; check category/sourceId/language/kind/tag values.'
      );
    });
  });

  describe('handleSearchAndAdapt', () => {
    it('preserves a result whose content contains the legacy empty-result phrase', async () => {
      mockSearchDocsRagLab.mockResolvedValueOnce(
        postgresSearchReport([
          {
            sourceId: 'bun-docs',
            sourcePath: 'bun-docs/sentinel.md',
            title: 'Sentinel',
            content: 'No results found is a documented phrase in this guide.',
            score: 0.91,
          },
        ])
      );

      const result = await handleSearchAndAdapt({
        query: 'sentinel',
        context: 'quick-ref',
        limit: 1,
      });

      expect(result.isError).not.toBe(true);
      expect((result as { structuredContent: any }).structuredContent).toMatchObject({
        success: true,
        data: { query: 'sentinel', deprecated: true },
      });
      expect((result as { structuredContent: any }).structuredContent.data.content).toContain(
        'No results found'
      );
    });

    it('preserves search errors as MCP errors instead of treating them as empty results', async () => {
      mockSearchDocsRagLab.mockRejectedValueOnce(new Error('docs search unavailable'));

      const result = await handleSearchAndAdapt({
        query: 'unavailable',
        context: 'quick-ref',
        limit: 1,
      });

      expect(result.isError).toBe(true);
      expect((result as { structuredContent: any }).structuredContent).toMatchObject({
        success: false,
        error: { code: 'SEARCH_AND_ADAPT_FAILED' },
      });
      expect(result.content[0].text).toContain('docs search unavailable');
    });
  });

  describe('handleGetDocument', () => {
    it('rejects project-local paths outside the registered external corpus', async () => {
      const result = await handleGetDocument({ sourcePath: 'docs/map/CLI_REFERENCE.md' });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('registered external Docs RAG source');
      expect(mockGetDocsRagLabDocumentByPath).not.toHaveBeenCalled();
    });

    it('returns document with chunks from Postgres', async () => {
      const result = await handleGetDocument({ sourcePath: 'bun-docs/runtime/http/server.mdx' });
      expect(mockGetDocsRagLabDocumentByPath).toHaveBeenCalledWith(
        expect.anything(),
        'bun-docs/runtime/http/server.mdx'
      );
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('# API Doc');
      expect(result.content[0].text).toContain('### Chunk 0');
      expect(result.content[0].text).toContain('Content 1');
      expect(result.structuredContent).toMatchObject({
        success: true,
        data: {
          sourcePath: 'bun-docs/runtime/http/server.mdx',
          found: true,
          title: 'API Doc',
          chunkCount: 2,
        },
      });
      expect((result.structuredContent as { data: { content: string } }).data.content).toContain(
        '### Chunk 0'
      );
      expect((result.structuredContent as { data: { content: string } }).data.content).toContain(
        'Content 1'
      );
    });

    it('returns not found message', async () => {
      mockGetDocsRagLabDocumentByPath.mockResolvedValueOnce(null);
      const result = await handleGetDocument({ sourcePath: 'bun-docs/missing.md' });
      expect(result.content[0].text).toContain('Document not found');
      expect(result.structuredContent).toMatchObject({
        success: true,
        data: { sourcePath: 'bun-docs/missing.md', found: false, chunkCount: 0 },
      });
    });

    it('handles empty chunks', async () => {
      mockGetDocsRagLabDocumentByPath.mockResolvedValueOnce({
        document: { title: 'Empty', sourcePath: 'e.md' },
        chunks: [],
      });
      const result = await handleGetDocument({ sourcePath: 'bun-docs/e.md' });
      expect(result.content[0].text).toContain('# Empty');
      expect(result.content[0].text).not.toContain('### Chunk');
    });

    it('requires Postgres config', async () => {
      mockResolveDocsRagLabConfig.mockReturnValueOnce(docsRagLabConfig());
      await expect(handleGetDocument({ sourcePath: 'bun-docs/test.md' })).rejects.toThrow(
        'Docs RAG Postgres database is required'
      );
    });

    it('throws on Postgres read error', async () => {
      mockGetDocsRagLabDocumentByPath.mockRejectedValueOnce(new Error('Query failed'));
      await expect(handleGetDocument({ sourcePath: 'bun-docs/test.md' })).rejects.toThrow(
        'Failed to get document: Query failed'
      );
    });
  });

  describe('handleIngestProject', () => {
    const projectRun = {
      projectId: 'project-1',
      slug: 'test-project',
      postgresId: 1,
      finalStatus: 'completed',
      stats: {
        filesScanned: 22,
        filesSelected: 19,
        filesIndexed: 19,
        filesBlocked: 1,
        filesDeleted: 2,
        chunksCreated: 40,
        embeddingsCreated: 40,
        errors: [],
      },
      snapshotGate: CONSUMED_SNAPSHOT_GATE,
    };

    beforeEach(() => {
      mockIngestProjectRagPostgres.mockResolvedValue(projectRun);
    });

    it('requires scopeAck before ingestion', async () => {
      const result = await handleIngestProject({ rootPath: explicitProjectRoot });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Critical project scope warning');
      expect(result.content[0].text).toContain(`scopeAck=${PROJECT_SCOPE_ACK_TOKEN}`);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'SCOPE_CONFIRMATION_REQUIRED',
          }),
        })
      );
      expect(mockIngestProjectRagPostgres).not.toHaveBeenCalled();
    });

    it('returns success summary', async () => {
      const result = await handleIngestProject({ scopeAck: PROJECT_SCOPE_ACK_TOKEN });
      expect(result.content[0].text).toContain('Project Postgres ingestion complete');
      expect(result.content[0].text).toContain('Selected: 19');
      expect(result.content[0].text).toContain('Indexed: 19');
      expect(result.content[0].text).toContain('Embeddings: 40');
      expect(result.content[0].text).toContain('Errors: 0');
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            finalStatus: 'completed',
          }),
        })
      );
    });

    it('passes root, includeRoots, force, and maxFiles to Postgres ingestion', async () => {
      await handleIngestProject({
        force: true,
        rootPath: explicitProjectRoot,
        includeRoots: ['src', 'docs'],
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        maxFiles: 12,
      });
      expect(mockIngestProjectRagPostgres).toHaveBeenCalledWith({
        rootPath: explicitProjectRoot,
        includeRoots: ['src', 'docs'],
        force: true,
        maxFiles: 12,
      });
    });

    it('uses configured PROJECT_SOURCE_PATH when rootPath is omitted', async () => {
      await handleIngestProject({ scopeAck: PROJECT_SCOPE_ACK_TOKEN });
      expect(mockIngestProjectRagPostgres).toHaveBeenCalledWith({
        rootPath: testProjectRoot,
        includeRoots: [],
        force: undefined,
        maxFiles: 120,
      });
    });

    it('caps maxFiles to the configured MCP ingestion budget', async () => {
      process.env.MCP_FULL_PROJECT_INGEST_MAX_FILES = '5';

      await handleIngestProject({
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        maxFiles: 12,
      });

      expect(mockIngestProjectRagPostgres).toHaveBeenCalledWith(
        expect.objectContaining({ maxFiles: 5 })
      );
    });

    it('allows an explicit large-ingestion override', async () => {
      process.env.MCP_FULL_PROJECT_INGEST_MAX_FILES = '5';
      process.env.MCP_ALLOW_LARGE_PROJECT_INGEST = 'true';

      await handleIngestProject({
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        maxFiles: 12,
      });

      expect(mockIngestProjectRagPostgres).toHaveBeenCalledWith(
        expect.objectContaining({ maxFiles: 12 })
      );
    });

    it('preserves the forced-ingestion scope error code', async () => {
      const error = Object.assign(new Error('Forced ingestion exceeds the bounded budget.'), {
        code: 'MCP_INGESTION_SCOPE_TOO_LARGE',
      });
      mockIngestProjectRagPostgres.mockRejectedValueOnce(error);

      const result = await handleIngestProject({
        force: true,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'MCP_INGESTION_SCOPE_TOO_LARGE' }),
        })
      );
    });

    it('returns an error when project ingestion reports partial file errors', async () => {
      mockIngestProjectRagPostgres.mockResolvedValueOnce({
        projectId: 'project-1',
        slug: 'test-project',
        postgresId: 1,
        finalStatus: 'partial',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [{ file: 'src/bad.ts', error: 'parse failed' }],
        },
        snapshotGate: CONSUMED_SNAPSHOT_GATE,
      });

      const result = await handleIngestProject({ scopeAck: PROJECT_SCOPE_ACK_TOKEN });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('src/bad.ts: parse failed');
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'INGESTION_PARTIAL' }),
        })
      );
    });

    it('returns continuation details instead of announcing completion for bounded partial ingestion', async () => {
      mockIngestProjectRagPostgres.mockResolvedValueOnce({
        projectId: 'project-1',
        slug: 'test-project',
        postgresId: 1,
        finalStatus: 'partial',
        continuation: {
          maxFiles: 1,
          totalOperations: 3,
          remainingOperations: 2,
          remainingStalePaths: 0,
          remainingCandidateFiles: 2,
        },
        stats: {
          filesScanned: 2,
          filesSelected: 0,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 1,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: CONSUMED_SNAPSHOT_GATE,
      });

      const result = await handleIngestProject({ scopeAck: PROJECT_SCOPE_ACK_TOKEN });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('2 operations remain');
      expect(result.content[0].text).not.toContain('ingestion complete');
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'INGESTION_PARTIAL' }),
          data: expect.objectContaining({
            continuation: expect.objectContaining({ remainingOperations: 2 }),
          }),
        })
      );
    });

    it('returns clear error when no project root is configured', async () => {
      const originalRoot = SCRIPT_CONFIG.PROJECT_SOURCE_PATH;
      SCRIPT_CONFIG.PROJECT_SOURCE_PATH = '';

      try {
        const result = await handleIngestProject({
          force: true,
          scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Missing ingestion root path');
        expect(mockIngestProjectRagPostgres).not.toHaveBeenCalled();
      } finally {
        SCRIPT_CONFIG.PROJECT_SOURCE_PATH = originalRoot;
      }
    });

    it('returns Postgres ingestion failures as internal errors', async () => {
      mockIngestProjectRagPostgres.mockRejectedValueOnce(new Error('Error'));
      const result = await handleIngestProject({ scopeAck: PROJECT_SCOPE_ACK_TOKEN });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to ingest project into Postgres: Error');
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
          }),
        })
      );
    });
  });

  describe('handleIngestProjectFile', () => {
    it('requires scopeAck before single-file ingestion', async () => {
      const result = await handleIngestProjectFile({
        filePath: `${testProjectRoot}/test.ts`,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Critical project scope warning');
      expect(result.content[0].text).toContain(`scopeAck=${PROJECT_SCOPE_ACK_TOKEN}`);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'SCOPE_CONFIRMATION_REQUIRED',
          }),
        })
      );
      expect(mockIngestProjectRagPostgresFile).not.toHaveBeenCalled();
    });

    it('returns success with chunks', async () => {
      mockIngestProjectRagPostgresFile.mockResolvedValueOnce({
        projectId: 'project-1',
        slug: 'test-project',
        postgresId: 1,
        finalStatus: 'completed',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 1,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 3,
          embeddingsCreated: 3,
          errors: [],
        },
        snapshotGate: CONSUMED_SNAPSHOT_GATE,
      });
      const result = await handleIngestProjectFile({
        filePath: `${testProjectRoot}/test.ts`,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });
      expect(result.content[0].text).toContain('Successfully indexed');
      expect(result.content[0].text).toContain('3 chunks');
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            finalStatus: 'completed',
            result: { status: 'indexed' },
          }),
        })
      );
    });

    it('returns skip message', async () => {
      mockIngestProjectRagPostgresFile.mockResolvedValueOnce({
        projectId: 'project-1',
        slug: 'test-project',
        postgresId: 1,
        finalStatus: 'completed',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [],
        },
        snapshotGate: CONSUMED_SNAPSHOT_GATE,
      });
      const result = await handleIngestProjectFile({
        filePath: `${testProjectRoot}/test.ts`,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });
      expect(result.content[0].text).toContain('No eligible file indexed');
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            result: { status: 'skipped' },
          }),
        })
      );
    });

    it('returns an error when single-file ingestion reports partial file errors', async () => {
      mockIngestProjectRagPostgresFile.mockResolvedValueOnce({
        projectId: 'project-1',
        slug: 'test-project',
        postgresId: 1,
        finalStatus: 'partial',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 0,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 0,
          embeddingsCreated: 0,
          errors: [{ file: 'src/bad.ts', error: 'parse failed' }],
        },
        snapshotGate: CONSUMED_SNAPSHOT_GATE,
      });

      const result = await handleIngestProjectFile({
        filePath: `${testProjectRoot}/bad.ts`,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('src/bad.ts: parse failed');
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'INGESTION_FAILED' }),
        })
      );
    });

    it('passes force option', async () => {
      await handleIngestProjectFile({
        filePath: `${testProjectRoot}/t.ts`,
        force: true,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });
      expect(mockIngestProjectRagPostgresFile).toHaveBeenCalledWith({
        rootPath: testProjectRoot,
        filePath: `${testProjectRoot}/t.ts`,
        force: true,
      });
    });

    it('uses explicit rootPath for file ingestion validation', async () => {
      await handleIngestProjectFile({
        filePath: `${explicitProjectRoot}/test.ts`,
        rootPath: explicitProjectRoot,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(mockIngestProjectRagPostgresFile).toHaveBeenCalledWith({
        rootPath: explicitProjectRoot,
        filePath: `${explicitProjectRoot}/test.ts`,
        force: undefined,
      });
    });

    it('returns clear error when no project root is configured for file ingestion', async () => {
      const originalRoot = SCRIPT_CONFIG.PROJECT_SOURCE_PATH;
      SCRIPT_CONFIG.PROJECT_SOURCE_PATH = '';

      try {
        const result = await handleIngestProjectFile({
          filePath: `${testProjectRoot}/file.ts`,
          force: false,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Missing ingestion root path');
        expect(result.structuredContent).toEqual(
          expect.objectContaining({
            success: false,
            error: expect.objectContaining({
              code: 'MISSING_ROOT',
            }),
          })
        );
      } finally {
        SCRIPT_CONFIG.PROJECT_SOURCE_PATH = originalRoot;
      }
    });

    it('surfaces Postgres ingestion failures', async () => {
      mockIngestProjectRagPostgresFile.mockRejectedValueOnce(
        new Error('ingest_project_file requires a file inside an explicit include root folder.')
      );

      const result = await handleIngestProjectFile({
        filePath: `${testProjectRoot}/src/missing.ts`,
        rootPath: testProjectRoot,
        force: true,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to ingest project file into Postgres');
      expect(result.content[0].text).toContain('explicit include root folder');
    });

    it('returns the Postgres error code for failed ingestion', async () => {
      mockIngestProjectRagPostgresFile.mockRejectedValueOnce(
        new Error('directory traversal is not allowed')
      );

      const result = await handleIngestProjectFile({
        filePath: `${testProjectRoot}/docs/outside.ts`,
        rootPath: testProjectRoot,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'INGESTION_FAILED' }),
        })
      );
      expect(result.content[0].text).toContain('directory traversal');
    });
  });

  describe('handleListCategories', () => {
    it('returns formatted Postgres categories', async () => {
      const result = await handleListCategories();
      expect(mockListDocsRagLabCategories).toHaveBeenCalledWith(expect.anything());
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Available Categories (2)');
      expect(result.content[0].text).toContain('Bun (bun)');
      expect(result.content[0].text).toContain('**Documents:** 25 | **Chunks:** 150');
      expect(result.structuredContent).toEqual({
        success: true,
        data: {
          categories: [
            { name: 'bun', displayName: 'Bun', docCount: 25, chunkCount: 150 },
            { name: 'react', displayName: 'React', docCount: 30, chunkCount: 200 },
          ],
        },
      });
    });

    it('returns empty message for empty array', async () => {
      mockListDocsRagLabCategories.mockResolvedValueOnce([]);
      const result = await handleListCategories();
      expect(result.content[0].text).toBe('No categories found.');
      expect(result.structuredContent).toEqual({
        success: true,
        data: { categories: [] },
      });
    });

    it('requires Postgres config', async () => {
      mockResolveDocsRagLabConfig.mockReturnValueOnce(docsRagLabConfig());
      await expect(handleListCategories()).rejects.toThrow(
        'Docs RAG Postgres database is required'
      );
    });

    it('throws on Postgres read error', async () => {
      mockListDocsRagLabCategories.mockRejectedValueOnce(new Error('Failed'));
      await expect(handleListCategories()).rejects.toThrow('Failed to list categories: Failed');
    });
  });

  describe('handleHealthCheck', () => {
    it('reports Docs RAG Postgres health', async () => {
      mockCheckDocsRagLabDatabaseHealth.mockResolvedValueOnce({
        status: 'healthy',
        method: 'bun-sql',
        target: 'postgres://postgres:***@127.0.0.1:5542/docs_rag_lab',
        latencyMs: 7,
        message: 'Connection succeeded and SELECT 1 returned the expected result.',
        warnings: [],
      });

      const result = await handleHealthCheck();

      expect(mockCheckDocsRagLabDatabaseHealth).toHaveBeenCalledWith(expect.anything());
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(mockClient.action).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('MCP Server: OK');
      expect(result.content[0].text).toContain('Docs RAG Postgres: OK');
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        success: true,
        data: {
          components: expect.arrayContaining([
            expect.objectContaining({ component: 'MCP Server', status: 'OK' }),
            expect.objectContaining({ component: 'Docs RAG Postgres', status: 'OK' }),
          ]),
        },
      });
    });

    it('returns error when Docs RAG Postgres is down', async () => {
      mockCheckDocsRagLabDatabaseHealth.mockResolvedValueOnce({
        status: 'unhealthy',
        method: 'bun-sql',
        message: 'Connection refused',
        latencyMs: 3,
        warnings: [],
      });

      const result = await handleHealthCheck();
      expect(result.content[0].text).toContain('Docs RAG Postgres: ERROR');
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        success: false,
        data: {
          components: expect.arrayContaining([
            expect.objectContaining({ component: 'Docs RAG Postgres', status: 'ERROR' }),
          ]),
        },
      });
    });

    it('returns error when the Docs RAG corpus inventory is unhealthy', async () => {
      mockCheckDocsRagLabCorpusHealth.mockResolvedValueOnce({
        status: 'unhealthy',
        documents: 3,
        unexpectedSourceIds: ['docs'],
        invalidPathCount: 1,
        sourcePathMismatchCount: 0,
        missingMetadataCount: 1,
        message: 'Corpus inventory failed.',
      });

      const result = await handleHealthCheck();

      expect(result.content[0].text).toContain('Docs RAG Corpus: ERROR');
      expect(result.isError).toBe(true);
    });

    it('returns error when Postgres URL is not configured', async () => {
      mockResolveDocsRagLabConfig.mockReturnValueOnce(docsRagLabConfig());
      const result = await handleHealthCheck();
      expect(result.content[0].text).toContain('Docs RAG Postgres: ERROR');
      expect(result.content[0].text).toContain('Set DOCS_RAG_PG_LAB_DATABASE_URL');
      expect(result.isError).toBe(true);
    });
  });

  describe('handleVerifyProjectIndex', () => {
    it('uses the Postgres read path even when PROJECT_RAG_BACKEND=legacy-backend', async () => {
      const sqlClose = vi.fn().mockResolvedValue(undefined);
      const sql = { close: sqlClose } as unknown as Bun.SQL;
      const createSql = vi.fn(() => sql);
      const findProject = vi.fn().mockResolvedValue({
        id: 7,
        name: 'Test Project',
        slug: 'test-project',
        normalizedRootPath: '/test/project',
        status: 'ready',
      });
      const getStats = vi.fn().mockResolvedValue({
        fileCount: 3,
        indexedFileCount: 3,
        blockedFileCount: 0,
        chunkCount: 5,
        symbolCount: 2,
        edgeCount: 1,
        embedding1024Count: 5,
      });
      const versionReadiness = {
        filesWithVersionMetadata: 3,
        filesWithActiveReadyVersion: 3,
        filesWithNonReadyActiveVersion: 0,
        filesPendingVersionBackfill: 0,
        filesUsingLegacyStatusRead: 0,
      };
      const getInvariantReport = vi.fn().mockResolvedValue({
        versionReadiness,
        freshness: {
          status: 'fresh',
          checkedFiles: 3,
          eligibleFiles: 3,
          freshFiles: 3,
          staleFiles: 0,
          missingFiles: 0,
          metadataDriftFiles: 0,
          unverifiedFiles: 0,
          stalePaths: [],
          checkedAt: '2026-03-24T09:00:00.000Z',
          reason: 'test',
          versionSignals: versionReadiness,
        },
        scopeCoverage: {
          status: 'covered',
          checkedAt: '2026-03-24T09:00:00.000Z',
          expectedFiles: 0,
          trackedFiles: 3,
          indexedFiles: 3,
          missingExpectedFiles: 0,
          extraIndexedFiles: 0,
          ignoredExpectedFiles: 0,
          ignoredIndexedFiles: 0,
          missingExpectedPaths: [],
          extraIndexedPaths: [],
          ignoredExpectedPaths: [],
          ignoredIndexedPaths: [],
          reason: 'test',
        },
        embeddingCoverage: {
          status: 'covered',
          expectedModel: 'qwen3-embedding-1024',
          expectedProvider: 'llamacpp',
          expectedDimensions: 1024,
          chunkOwners: 5,
          embeddingOwners: 5,
          embeddingRecords: 5,
          ownersWithValidEmbedding: 5,
          missingOwners: 0,
          staleOwners: 0,
          modelMismatchOwners: 0,
          providerMismatchOwners: 0,
          dimensionMismatchOwners: 0,
          invalidVectorLengthOwners: 0,
          chunkVersionGaps: 0,
          embeddingVersionGaps: 0,
          embeddingVersionMismatchOwners: 0,
          missingOwnerSample: [],
          staleOwnerSample: [],
          mismatchOwnerSample: [],
          versionMismatchOwnerSample: [],
        },
        ownershipCoverage: {
          status: 'covered',
          chunkFileOrphans: 0,
          symbolFileOrphans: 0,
          symbolChunkOrphans: 0,
          edgeMissingSourceFileRefs: 0,
          edgeMissingTargetFileRefs: 0,
          edgeMissingSourceSymbolRefs: 0,
          edgeMissingTargetSymbolRefs: 0,
          deletedFileChunkRefs: 0,
          deletedFileSymbolRefs: 0,
          deletedFileEdgeRefs: 0,
          sampleRefs: [],
        },
        lastSyncAt: null,
      });

      setProjectRagPostgresRuntimeModulesForTesting({
        config: {
          resolveProjectRagPostgresConfigWithLocalDefault: () => ({
            tool: 'project-rag-postgres',
            healthTimeoutMs: 5_000,
            database: { url: 'postgres://test' },
            pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
          }),
          resolveProjectRagPostgresWriteConfig: () => ({
            tool: 'project-rag-postgres',
            healthTimeoutMs: 5_000,
            database: {
              url: 'postgres://test',
              redactedUrl: 'postgres://test',
              source: 'test',
            },
            pool: { max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 },
          }),
        },
        embeddings: {
          resolveProjectRagPostgresEmbeddingConfig: vi.fn(),
          fetchProjectRagPostgresEmbeddings: vi.fn(),
        },
        store: {
          createProjectRagPostgresSql: createSql,
          findProjectRagPostgresProject: findProject,
          getProjectRagPostgresProjectStats: getStats,
          getProjectRagPostgresPublishedBuildState: vi
            .fn()
            .mockResolvedValue({ buildId: 1, dirtyDigest: 'b'.repeat(64) }),
          getProjectRagPostgresInvariantReport: getInvariantReport,
          searchProjectRagPostgresChunks: vi.fn(),
          getProjectRagPostgresFileWithChunks: vi.fn(),
          getProjectRagPostgresFileOutline: vi.fn(),
          findProjectRagPostgresSymbols: vi.fn(),
          getProjectRagPostgresNavigationPaths: vi.fn(),
          getProjectRagPostgresSemanticClusters: vi.fn(),
          getProjectRagPostgresFeatureHubs: vi.fn(),
          getProjectRagPostgresTopicGroups: vi.fn(),
          upsertProjectRagPostgresRepository: vi.fn(),
          upsertProjectRagWorkspaceContext: vi.fn(),
          upsertProjectRagWorkspaceAlias: vi.fn(),
        },
      });

      try {
        const result = await handleVerifyProjectIndex({ projectId: 'project-1' });

        expect(createSql).toHaveBeenCalledTimes(1);
        expect(findProject).toHaveBeenCalledWith(expect.anything(), 'project-1');
        expect(getStats).toHaveBeenCalledWith(expect.anything(), 7);
        expect(getInvariantReport).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ id: 7 })
        );
        // Pool is shared across requests – close is NOT called per request
        expect(sqlClose).not.toHaveBeenCalled();
        expect(mockClient.query).not.toHaveBeenCalled();
        expect(mockClient.action).not.toHaveBeenCalled();
        expect(result.structuredContent).toEqual(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              backend: 'postgres',
              projectId: 'project-1',
              lastSyncAt: null,
            }),
          })
        );
      } finally {
        setProjectRagPostgresRuntimeModulesForTesting(null);
      }
    });
  });

  describe('handleEnsureReranker', () => {
    it('checks the local reranker service when it is already healthy', async () => {
      const originalFetch = globalThis.fetch;
      const originalServiceUrl = process.env.RERANKING_SERVICE_URL;
      process.env.RERANKING_SERVICE_URL = 'http://127.0.0.1:3456';
      const fetchMock = vi.fn(
        async () =>
          ({
            json: async () => ({
              model: 'test-reranker',
              service: 'reranking-service',
              status: 'healthy',
            }),
            ok: true,
          }) as Response
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        const result = await handleEnsureReranker({ timeout: 5 });

        expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3456/health', {
          method: 'GET',
          signal: expect.any(AbortSignal),
        });
        expect(mockClient.action).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain('Reranker Service: Already Running');
        expect(result.content[0].text).toContain('Status: OK');
        expect(result.content[0].text).toContain('Service URL: http://127.0.0.1:3456');
        expect(result.isError).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalServiceUrl === undefined) delete process.env.RERANKING_SERVICE_URL;
        else process.env.RERANKING_SERVICE_URL = originalServiceUrl;
      }
    });
  });

  describe('handleGetDocument edge cases', () => {
    it('does not log Postgres document reads through legacy heat tracking', async () => {
      const result = await handleGetDocument({ sourcePath: 'bun-docs/runtime/http/server.mdx' });
      expect(result.content[0].text).toContain('# API Doc');
      expect(mockClient.mutation).not.toHaveBeenCalled();
    });
  });

  // =============================================================================
  // Inventory Handler Tests (Integration - uses actual inventory file)
  // =============================================================================

  describe('Inventory Handlers', () => {
    // Import inventory handlers after configuring the isolated inventory fixture.
    let handleGetCodeMetrics: typeof import('../handlers.js').handleGetCodeMetrics;
    let handleSearchInventory: typeof import('../handlers.js').handleSearchInventory;
    let handleGetDeadCodeReport: typeof import('../handlers.js').handleGetDeadCodeReport;

    beforeAll(async () => {
      const handlers = await import('../handlers.js');
      handleGetCodeMetrics = handlers.handleGetCodeMetrics;
      handleSearchInventory = handlers.handleSearchInventory;
      handleGetDeadCodeReport = handlers.handleGetDeadCodeReport;
    });

    describe('handleGetCodeMetrics', () => {
      it('returns aggregate metrics for all categories', async () => {
        const result = await handleGetCodeMetrics();

        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('Code Inventory Metrics');
        expect(result.content[0].text).toContain('Total Files:');
        expect(result.content[0].text).toContain('Total Lines:');
        expect(result.content[0].text).toContain('Shared');
        expect(result.content[0].text).toContain('Docs');
      });

      it('filters metrics by category', async () => {
        const result = await handleGetCodeMetrics({ category: 'Shared' });

        expect(result.content[0].text).toContain('Shared');
        // Shared category has 2 files
        expect(result.content[0].text).toContain('Files: 2');
        expect(result.content[0].text).not.toContain('### Docs');
      });

      it('returns error for non-existent category', async () => {
        const result = await handleGetCodeMetrics({ category: 'NonExistent' });

        // Should return empty metrics for non-existent category (no error, just no results)
        expect(result.content[0].text).toContain('**Total Files:** 0');
      });
    });

    describe('handleSearchInventory', () => {
      it('finds files by pattern', async () => {
        const result = await handleSearchInventory({ pattern: 'registry' });

        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('Search Results for "registry"');
        expect(result.content[0].text).toContain('lib/shared/project-registry.ts');
      });

      it('filters by category', async () => {
        const result = await handleSearchInventory({ pattern: 'registry', category: 'Docs' });

        // Should find nothing since 'registry' is in Shared category, not Docs
        expect(result.content[0].text).toContain('No files found');
      });

      it('applies limit to results', async () => {
        // Use a pattern that matches multiple entries
        const result = await handleSearchInventory({ pattern: 'lib', limit: 1 });

        expect(result.content[0].text).toContain('(showing first 1)');
      });

      it('returns empty message when no matches', async () => {
        const result = await handleSearchInventory({ pattern: 'nonexistent-file-xyz' });

        expect(result.content[0].text).toContain('No files found');
      });

      it('sorts by relevance (exact match first)', async () => {
        // Search for pattern 'lib' which matches both files
        const result = await handleSearchInventory({ pattern: 'lib' });
        const text = (result.content[0] as { text: string }).text;

        // Both should be present
        expect(text).toContain('lib/shared/project-registry.ts');
        expect(text).toContain('lib/search/scoring.ts');
      });
    });

    describe('handleGetDeadCodeReport', () => {
      it('identifies files with zero exports', async () => {
        // The test inventory has all files with exports > 0
        // Using very high minLines to get empty result
        const result = await handleGetDeadCodeReport({ minLines: 10000 });

        expect(result.content[0].text).toContain('No potential dead code found');
      });

      it('filters by category', async () => {
        const result = await handleGetDeadCodeReport({ category: 'NonExistent' });

        expect(result.content[0].text).toContain('No potential dead code found');
      });

      it('excludes unreviewed files when flag is false', async () => {
        const result = await handleGetDeadCodeReport({ includeUnreviewed: false, minLines: 0 });

        // Since all entries in test inventory are reviewed (marked [x]), should work
        expect(result.content[0].text).toMatch(/Dead Code Report|No potential dead code found/);
      });

      it('includes unreviewed files when flag is true (default)', async () => {
        const result = await handleGetDeadCodeReport({ includeUnreviewed: true });

        expect(result.content[0].text).toMatch(/Dead Code Report|No potential dead code found/);
      });
    });
  });
});
