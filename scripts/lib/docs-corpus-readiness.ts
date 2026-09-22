export interface DocsCorpusProbeResult {
  readonly documents: number;
  readonly unexpectedSourceIds: string[];
  readonly invalidPathCount: number;
  readonly sourcePathMismatchCount: number;
  readonly missingMetadataCount: number;
  readonly missingSourceIds?: string[];
  readonly emptyDocumentCount?: number;
  readonly zeroChunkDocumentCount?: number;
  readonly emptyChunkCount?: number;
  readonly missingEmbeddingChunkCount?: number;
}

export type NormalizedDocsCorpusProbeResult = Required<DocsCorpusProbeResult>;

export function normalizeDocsCorpusProbeResult(
  result: DocsCorpusProbeResult
): NormalizedDocsCorpusProbeResult {
  return {
    ...result,
    missingSourceIds: result.missingSourceIds ?? [],
    emptyDocumentCount: result.emptyDocumentCount ?? 0,
    zeroChunkDocumentCount: result.zeroChunkDocumentCount ?? 0,
    emptyChunkCount: result.emptyChunkCount ?? 0,
    missingEmbeddingChunkCount: result.missingEmbeddingChunkCount ?? 0,
  };
}

export function isDocsCorpusReady(result: NormalizedDocsCorpusProbeResult): boolean {
  return (
    result.documents > 0 &&
    result.unexpectedSourceIds.length === 0 &&
    result.invalidPathCount === 0 &&
    result.sourcePathMismatchCount === 0 &&
    result.missingMetadataCount === 0 &&
    result.missingSourceIds.length === 0 &&
    result.emptyDocumentCount === 0 &&
    result.zeroChunkDocumentCount === 0 &&
    result.emptyChunkCount === 0 &&
    result.missingEmbeddingChunkCount === 0
  );
}

export function formatDocsCorpusFailure(result: NormalizedDocsCorpusProbeResult): string {
  return `Corpus inventory failed: documents=${result.documents}, unexpected sources=${result.unexpectedSourceIds.join(',') || 'none'}, missing sources=${result.missingSourceIds.join(',') || 'none'}, invalid paths=${result.invalidPathCount}, source/path mismatches=${result.sourcePathMismatchCount}, missing metadata=${result.missingMetadataCount}, empty documents=${result.emptyDocumentCount}, zero-chunk documents=${result.zeroChunkDocumentCount}, empty chunks=${result.emptyChunkCount}, missing chunk embeddings=${result.missingEmbeddingChunkCount}.`;
}
