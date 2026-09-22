import type { vi } from 'vitest';

import { checkDocsRagLabDatabaseHealth } from '../../../scripts/docs-rag/db.js';
import {
  getDocsRagLabDocumentByPath,
  listDocsRagLabCategories,
  searchDocsRagLab,
} from '../../../scripts/docs-rag/store.js';

export const testDocsPostgresUrl = 'postgres://127.0.0.1:5542/docs_rag_lab';

export const mockCheckDocsRagLabDatabaseHealth = checkDocsRagLabDatabaseHealth as ReturnType<
  typeof vi.fn
>;
export const mockGetDocsRagLabDocumentByPath = getDocsRagLabDocumentByPath as ReturnType<
  typeof vi.fn
>;
export const mockListDocsRagLabCategories = listDocsRagLabCategories as ReturnType<typeof vi.fn>;
export const mockSearchDocsRagLab = searchDocsRagLab as ReturnType<typeof vi.fn>;

export function docsRagLabConfig(databaseUrl = testDocsPostgresUrl) {
  return {
    tool: 'docs-rag-pg-lab',
    rootDir: process.cwd(),
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

export function postgresSearchReport(
  results: Array<{
    sourceId?: string;
    sourcePath: string;
    title: string;
    content: string;
    heading?: string;
    section?: string;
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
      content: result.content,
      chunkIndex: index,
      score: result.score ?? 1,
    })),
  };
}

export function resetDocsRagPostgresMocks() {
  process.env.DOCS_RAG_PG_LAB_DATABASE_URL = testDocsPostgresUrl;
  mockCheckDocsRagLabDatabaseHealth.mockReset();
  mockGetDocsRagLabDocumentByPath.mockReset();
  mockListDocsRagLabCategories.mockReset();
  mockSearchDocsRagLab.mockReset();

  mockSearchDocsRagLab.mockResolvedValue(postgresSearchReport());
  mockListDocsRagLabCategories.mockResolvedValue([
    { name: 'bun', displayName: 'Bun', docCount: 5, chunkCount: 25 },
    { name: 'react', displayName: 'React 19', docCount: 10, chunkCount: 50 },
  ]);
  mockGetDocsRagLabDocumentByPath.mockResolvedValue({
    document: { title: 'Full Document', sourcePath: 'full/doc.md' },
    chunks: [
      { chunkIndex: 0, content: '# Full Document\n\nIntroduction section.' },
      { chunkIndex: 1, content: '## Main Content\n\nDetails here.' },
    ],
  });
  mockCheckDocsRagLabDatabaseHealth.mockResolvedValue({
    status: 'healthy',
    method: 'bun-sql',
    target: testDocsPostgresUrl,
    latencyMs: 1,
    message: 'Connection succeeded.',
    warnings: [],
  });
}
