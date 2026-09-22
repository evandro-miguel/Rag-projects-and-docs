import { describe, expect, it } from 'vitest';
import {
  formatDocsCorpusFailure,
  isDocsCorpusReady,
  normalizeDocsCorpusProbeResult,
} from '../docs-corpus-readiness.js';

const clean = {
  documents: 14,
  unexpectedSourceIds: [],
  invalidPathCount: 0,
  sourcePathMismatchCount: 0,
  missingMetadataCount: 0,
};

describe('docs-corpus-readiness', () => {
  it('normalizes legacy probe results conservatively to zero integrity failures', () => {
    const result = normalizeDocsCorpusProbeResult(clean);

    expect(result).toMatchObject({
      missingSourceIds: [],
      emptyDocumentCount: 0,
      zeroChunkDocumentCount: 0,
      emptyChunkCount: 0,
      missingEmbeddingChunkCount: 0,
    });
    expect(isDocsCorpusReady(result)).toBe(true);
  });

  it.each([
    ['documents', 0],
    ['invalidPathCount', 1],
    ['sourcePathMismatchCount', 1],
    ['missingMetadataCount', 1],
    ['emptyDocumentCount', 1],
    ['zeroChunkDocumentCount', 1],
    ['emptyChunkCount', 1],
    ['missingEmbeddingChunkCount', 1],
  ] as const)('rejects %s=%s', (field, value) => {
    const result = normalizeDocsCorpusProbeResult({ ...clean, [field]: value });
    expect(isDocsCorpusReady(result)).toBe(false);
  });

  it('rejects unexpected or missing sources and formats all failure counters', () => {
    const result = normalizeDocsCorpusProbeResult({
      ...clean,
      unexpectedSourceIds: ['unknown'],
      missingSourceIds: ['go-books'],
      emptyDocumentCount: 1,
    });

    expect(isDocsCorpusReady(result)).toBe(false);
    expect(formatDocsCorpusFailure(result)).toContain('unexpected sources=unknown');
    expect(formatDocsCorpusFailure(result)).toContain('missing sources=go-books');
    expect(formatDocsCorpusFailure(result)).toContain('empty documents=1');
  });
});
