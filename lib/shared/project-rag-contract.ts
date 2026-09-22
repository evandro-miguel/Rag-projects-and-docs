import { calculateHashAsync } from './hashing.js';

export const PROJECT_RAG_EMBEDDING_CACHE_NAMESPACE = 'project_rag' as const;
export const PROJECT_RAG_EMBEDDING_INPUT_MODE = 'project_chunk_searchable_text' as const;
export const PROJECT_RAG_CACHE_KEY_VERSION = 'v1' as const;

export interface ProjectRagEmbeddingCacheKeyParts {
  provider: string;
  model: string;
  dimensions: number;
  inputMode: string;
  redactionVersion: string;
  chunkerVersion: string;
  normalizedTextHash: string;
}

export interface ProjectRagConfigHashInput {
  includeRoots: string[];
  ignoreRules: string[];
  chunkSize: number;
  chunkOverlap: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  inputMode: string;
  redactionVersion: string;
  chunkerVersion: string;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = stableNormalize(record[key]);
      return acc;
    }, {});
}

export function normalizeProjectRagEmbeddingInput(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export async function calculateProjectRagNormalizedTextHash(text: string): Promise<string> {
  return await calculateHashAsync(normalizeProjectRagEmbeddingInput(text));
}

export function createProjectRagEmbeddingCacheKey(parts: ProjectRagEmbeddingCacheKeyParts): string {
  return [
    PROJECT_RAG_CACHE_KEY_VERSION,
    parts.provider,
    parts.model,
    String(parts.dimensions),
    parts.inputMode,
    parts.redactionVersion,
    parts.chunkerVersion,
    parts.normalizedTextHash,
  ].join('|');
}

export async function createProjectRagConfigHash(
  config: ProjectRagConfigHashInput
): Promise<string> {
  return await calculateHashAsync(JSON.stringify(stableNormalize(config)));
}
