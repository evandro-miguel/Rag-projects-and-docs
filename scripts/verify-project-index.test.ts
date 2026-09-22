import { describe, expect, it } from 'vitest';
import {
  assertProjectCurrentMutationAck,
  assertProjectEmbeddingsSafe,
} from './verify-project-index.js';

describe('assertProjectEmbeddingsSafe', () => {
  it('allows contract mode when non-writing test env markers are present', () => {
    expect(() =>
      assertProjectEmbeddingsSafe('contract', {
        EMBEDDING_FALLBACK_ON_UNAVAILABLE: 'true',
        NODE_ENV: 'test',
        VITEST: '1',
      })
    ).not.toThrow();
  });

  it('blocks repair when fallback embeddings are explicitly allowed', () => {
    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        EMBEDDING_FALLBACK_ON_UNAVAILABLE: 'true',
      })
    ).toThrow('EMBEDDING_FALLBACK_ON_UNAVAILABLE=true');
  });

  it('blocks repair in test env without forcing the real provider', () => {
    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        NODE_ENV: 'test',
      })
    ).toThrow('EMBEDDER_FORCE_PROVIDER=1');

    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        VITEST: '1',
      })
    ).toThrow('EMBEDDER_FORCE_PROVIDER=1');
  });

  it('allows repair in test env only when the real provider is forced', () => {
    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        NODE_ENV: 'test',
        EMBEDDER_FORCE_PROVIDER: '1',
      })
    ).not.toThrow();
  });

  it('blocks contract and repair when the explicit Project RAG embedding base URL is not the 1024D GPU lane', () => {
    expect(() =>
      assertProjectEmbeddingsSafe('contract', {
        PROJECT_RAG_PG_EMBEDDING_BASE_URL: 'http://127.0.0.1:9999',
      })
    ).toThrow('http://127.0.0.1:8082');

    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        PROJECT_RAG_PG_EMBEDDING_BASE_URL: 'http://127.0.0.1:9999',
      })
    ).toThrow('http://127.0.0.1:8082');
  });

  it('blocks repair when Docs RAG embedding settings are present', () => {
    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL: 'http://127.0.0.1:8082',
      })
    ).toThrow('DOCS_RAG_PG_LAB_*');

    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        DOCS_RAG_PG_LAB_EMBEDDING_MODEL: 'qwen3-embedding-1024',
      })
    ).toThrow('DOCS_RAG_PG_LAB_*');
  });

  it('blocks repair when the explicit Project RAG embedding model is not the 1024D model', () => {
    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        PROJECT_RAG_PG_EMBEDDING_MODEL: 'wrong-model',
      })
    ).toThrow('qwen3-embedding-1024');
  });

  it('allows repair when the explicit Project RAG embedding base URL matches the expected lane', () => {
    expect(() =>
      assertProjectEmbeddingsSafe('repair', {
        PROJECT_RAG_PG_EMBEDDING_BASE_URL: 'http://127.0.0.1:8082/',
        PROJECT_RAG_PG_EMBEDDING_MODEL: 'qwen3-embedding-1024',
      })
    ).not.toThrow();
  });
});

describe('assertProjectCurrentMutationAck', () => {
  it('blocks the current-project wrapper unless mutating registry writes are acknowledged', () => {
    expect(() => assertProjectCurrentMutationAck({})).toThrow(
      'RAG_MCP_PROJECT_CURRENT_MUTATION_ACK=1'
    );
  });

  it('allows the wrapper when mutating registry writes are acknowledged', () => {
    expect(() =>
      assertProjectCurrentMutationAck({
        RAG_MCP_PROJECT_CURRENT_MUTATION_ACK: '1',
      })
    ).not.toThrow();
  });
});
