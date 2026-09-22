import { describe, expect, it } from 'vitest';
import {
  calculateProjectRagNormalizedTextHash,
  createProjectRagConfigHash,
  createProjectRagEmbeddingCacheKey,
} from './project-rag-contract.js';

describe('project-rag-contract', () => {
  it('produces stable configHash for identical config values', async () => {
    const base = {
      includeRoots: ['src', 'docs'],
      ignoreRules: ['node_modules/**'],
      chunkSize: 1000,
      chunkOverlap: 100,
      embeddingProvider: 'llamacpp',
      embeddingModel: 'qwen3-embedding',
      embeddingDimensions: 4096,
      inputMode: 'project_chunk_searchable_text',
      redactionVersion: 'pii-redactor-v1',
      chunkerVersion: 'project-chunker-v1',
    };

    const hashA = await createProjectRagConfigHash(base);
    const hashB = await createProjectRagConfigHash({ ...base });

    expect(hashA).toBe(hashB);
  });

  it('changes configHash when relevant config changes', async () => {
    const base = {
      includeRoots: ['src'],
      ignoreRules: [],
      chunkSize: 1000,
      chunkOverlap: 100,
      embeddingProvider: 'llamacpp',
      embeddingModel: 'qwen3-embedding',
      embeddingDimensions: 4096,
      inputMode: 'project_chunk_searchable_text',
      redactionVersion: 'pii-redactor-v1',
      chunkerVersion: 'project-chunker-v1',
    };

    const hashA = await createProjectRagConfigHash(base);
    const hashB = await createProjectRagConfigHash({
      ...base,
      chunkerVersion: 'project-chunker-v2',
    });

    expect(hashA).not.toBe(hashB);
  });

  it('creates different cache keys when input mode/redaction/chunker differs', () => {
    const base = {
      provider: 'llamacpp',
      model: 'qwen3-embedding',
      dimensions: 4096,
      inputMode: 'project_chunk_searchable_text',
      redactionVersion: 'pii-redactor-v1',
      chunkerVersion: 'project-chunker-v1',
      normalizedTextHash: 'abc',
    };

    const keyA = createProjectRagEmbeddingCacheKey(base);
    const keyB = createProjectRagEmbeddingCacheKey({
      ...base,
      redactionVersion: 'pii-redactor-v2',
    });
    const keyC = createProjectRagEmbeddingCacheKey({
      ...base,
      inputMode: 'project_raw_chunk',
    });

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });

  it('normalizes text hashing for line endings and surrounding whitespace', async () => {
    const hashA = await calculateProjectRagNormalizedTextHash('line1\r\nline2\n');
    const hashB = await calculateProjectRagNormalizedTextHash('line1\nline2');

    expect(hashA).toBe(hashB);
  });
});
