export interface DocsRagReadinessInput {
  readonly docsPostgresStatus: string;
  readonly docsCorpusStatus: string;
  readonly docsFreshnessStatus: string;
  readonly embeddingAvailable: boolean;
}

export interface DocsRagReadiness {
  readonly keywordSearchAvailable: boolean;
  readonly searchAvailable: boolean;
  readonly ready: boolean;
}

export function resolveDocsRagReadiness(input: DocsRagReadinessInput): DocsRagReadiness {
  const keywordSearchAvailable =
    input.docsPostgresStatus === 'healthy' && input.docsCorpusStatus === 'healthy';
  const searchAvailable = keywordSearchAvailable && input.embeddingAvailable;
  return {
    keywordSearchAvailable,
    searchAvailable,
    ready: searchAvailable && input.docsFreshnessStatus === 'ok',
  };
}
