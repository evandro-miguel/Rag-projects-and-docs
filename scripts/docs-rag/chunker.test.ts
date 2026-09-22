import { describe, expect, it } from 'vitest';
import {
  DOCS_RAG_DEFAULT_CHUNK_OVERLAP,
  DOCS_RAG_DEFAULT_CHUNK_SIZE,
  resolveDocsRagChunkConfig,
} from './chunker.js';

describe('resolveDocsRagChunkConfig', () => {
  it('defaults to the canonical Docs RAG chunker parameters', () => {
    expect(resolveDocsRagChunkConfig({})).toEqual({
      chunkSize: DOCS_RAG_DEFAULT_CHUNK_SIZE,
      chunkOverlap: DOCS_RAG_DEFAULT_CHUNK_OVERLAP,
    });
  });

  it('honors CHUNK_SIZE and CHUNK_OVERLAP together so ingest surfaces stay aligned', () => {
    expect(resolveDocsRagChunkConfig({ CHUNK_SIZE: '640', CHUNK_OVERLAP: '64' })).toEqual({
      chunkSize: 640,
      chunkOverlap: 64,
    });
  });

  it('rejects invalid overrides and keeps a positive chunk size', () => {
    expect(resolveDocsRagChunkConfig({ CHUNK_SIZE: '0', CHUNK_OVERLAP: 'nope' })).toEqual({
      chunkSize: 1,
      chunkOverlap: DOCS_RAG_DEFAULT_CHUNK_OVERLAP,
    });
  });
});
