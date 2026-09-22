import { describe, expect, it } from 'vitest';
import { resolveDocsRagReadiness } from '../docs-readiness.js';

describe('docs-readiness', () => {
  it.each([
    ['healthy', 'healthy', 'ok', true, true, true, true],
    ['healthy', 'healthy', 'stale', true, true, true, false],
    ['healthy', 'healthy', 'ok', false, true, false, false],
    ['healthy', 'unhealthy', 'ok', true, false, false, false],
    ['unhealthy', 'healthy', 'ok', true, false, false, false],
  ])('maps postgres=%s corpus=%s freshness=%s embeddings=%s', (postgres, corpus, freshness, embeddings, keywordSearchAvailable, searchAvailable, ready) => {
    expect(
      resolveDocsRagReadiness({
        docsPostgresStatus: postgres,
        docsCorpusStatus: corpus,
        docsFreshnessStatus: freshness,
        embeddingAvailable: embeddings,
      })
    ).toEqual({ keywordSearchAvailable, searchAvailable, ready });
  });
});
