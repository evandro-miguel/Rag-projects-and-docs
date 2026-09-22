import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeProjectRagEmbeddingProfileHash,
  fetchProjectRagPostgresEmbeddings,
  PROJECT_RAG_EMBEDDING_PROFILE_LEGACY_UNKNOWN,
  PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
  type ProjectRagPostgresEmbeddingConfig,
  projectRagPostgresEmbeddingProfileIdentity,
  resolveProjectRagPostgresEmbeddingConfig,
} from './embeddings.js';

const CONFIG: ProjectRagPostgresEmbeddingConfig = {
  provider: 'llamacpp',
  model: 'qwen3-embedding-1024',
  baseUrl: 'http://127.0.0.1:8082',
  dimensions: 1024,
  timeoutMs: 60_000,
  profileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
};
const ORIGINAL_FETCH = globalThis.fetch;

function mockEmbeddingFetch(expectInput: readonly string[]) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      input: string[];
    };

    expect(body.input).toEqual(expectInput);

    return Response.json({
      data: expectInput.map(() => ({ embedding: new Array(1024).fill(0) })),
    });
  });

  globalThis.fetch = Object.assign(fetchMock, ORIGINAL_FETCH);
  return fetchMock;
}

/** Mirror of canonicalizeProjectRagEmbeddingProfileIdentity for drift tests. */
function canonicalIdentityForSqlTest(
  identity: ReturnType<typeof projectRagPostgresEmbeddingProfileIdentity>
): string {
  return [
    identity.schemaVersion,
    identity.provider,
    identity.model,
    identity.dimensions,
    identity.inputFormat,
    identity.inputFormatVersion,
  ].join(':');
}

describe('project-rag postgres embeddings', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('keeps the canonical profile hash byte-identical to migration 010 backfill', () => {
    // Migration 010 derives the digest in SQL from exactly this identity
    // string; changing either side without the other is checksum drift.
    expect(canonicalIdentityForSqlTest(projectRagPostgresEmbeddingProfileIdentity())).toBe(
      '1:llamacpp:qwen3-embedding-1024:1024:plain-wellformed:1'
    );
    expect(PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH).toBe(
      computeProjectRagEmbeddingProfileHash(projectRagPostgresEmbeddingProfileIdentity())
    );
    expect(PROJECT_RAG_EMBEDDING_PROFILE_LEGACY_UNKNOWN).toBe('legacy_unknown');
  });

  it('resolves only the Project RAG GPU embedding lane', () => {
    expect(resolveProjectRagPostgresEmbeddingConfig({})).toMatchObject({
      provider: 'llamacpp',
      model: 'qwen3-embedding-1024',
      baseUrl: 'http://127.0.0.1:8082',
      dimensions: 1024,
      profileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
    });

    expect(
      resolveProjectRagPostgresEmbeddingConfig({
        PROJECT_RAG_PG_EMBEDDING_BASE_URL: 'http://127.0.0.1:8082/',
        PROJECT_RAG_PG_EMBEDDING_MODEL: 'qwen3-embedding-1024',
      })
    ).toMatchObject({
      model: 'qwen3-embedding-1024',
      baseUrl: 'http://127.0.0.1:8082',
    });
  });

  it('rejects non-Project RAG or non-GPU embedding settings', () => {
    expect(() =>
      resolveProjectRagPostgresEmbeddingConfig({
        DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL: 'http://127.0.0.1:8082',
      })
    ).toThrow('DOCS_RAG_PG_LAB_*');

    expect(() =>
      resolveProjectRagPostgresEmbeddingConfig({
        PROJECT_RAG_PG_EMBEDDING_BASE_URL: 'http://127.0.0.1:9999',
      })
    ).toThrow('http://127.0.0.1:8082');

    expect(() =>
      resolveProjectRagPostgresEmbeddingConfig({
        PROJECT_RAG_PG_EMBEDDING_MODEL: 'wrong-model',
      })
    ).toThrow('qwen3-embedding-1024');
  });

  it('keeps explicitly configured Docs and isolated Project embedding lanes independent', () => {
    expect(
      resolveProjectRagPostgresEmbeddingConfig({
        PROJECT_RAG_PREPARE_RUNTIME: 'isolated_dev',
        PROJECT_RAG_PG_EMBEDDING_BASE_URL: 'http://127.0.0.1:18082',
        PROJECT_RAG_PG_EMBEDDING_MODEL: 'qwen3-embedding-1024',
        DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL: 'http://127.0.0.1:18083',
        DOCS_RAG_PG_LAB_EMBEDDING_MODEL: 'docs-model',
      })
    ).toMatchObject({
      baseUrl: 'http://127.0.0.1:18082',
      model: 'qwen3-embedding-1024',
    });
  });

  it('truncates oversized inputs before posting to the embedding provider', async () => {
    const fetchMock = mockEmbeddingFetch(['a'.repeat(800)]);

    const embeddings = await fetchProjectRagPostgresEmbeddings(CONFIG, ['a'.repeat(8_000)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]).toHaveLength(1024);
  });

  it.each([
    { label: 'lone high surrogate', input: `ok\uD800tail`, expected: 'ok\uFFFDtail' },
    { label: 'lone low surrogate', input: `ok\uDC00tail`, expected: 'ok\uFFFDtail' },
    { label: 'valid surrogate pair', input: 'emoji 😀 ok', expected: 'emoji 😀 ok' },
    {
      label: 'surrogate pair split by the 800-char cap',
      input: `${'a'.repeat(799)}😀`,
      expected: `${'a'.repeat(799)}\uFFFD`,
    },
  ])('sanitizes $label before posting to the embedding provider', async ({ input, expected }) => {
    const fetchMock = mockEmbeddingFetch([expected]);

    const embeddings = await fetchProjectRagPostgresEmbeddings(CONFIG, [input]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]).toHaveLength(1024);
  });
});
