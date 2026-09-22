import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { resolveExternalDocsProcessingProfile } from '../sync-external-docs.js';
import type { DocsRagLabConfig } from './config.js';
import {
  DOCS_RAG_PROCESSING_PROFILE_PIPELINE_REVISION,
  DOCS_RAG_PROCESSING_PROFILE_VERSION,
  type DocsRagProcessingProfile,
  type DocsRagProcessingProfileInput,
  docsRagProcessingProfileHash,
  resolveDocsRagProcessingProfile,
} from './processing-profile.js';
import { buildDocsRagEmbeddingInputForChunk, buildDocsRagSourceGenerationKey } from './store.js';

const BASE_INPUT = {
  cleaner: 'cleaner-v2',
  refiner: 'refiner-v2',
  chunker: 'chunker-v2',
  redaction: 'redaction-v2',
  normalization: 'normalization-v2',
  provider: 'llamacpp',
  model: 'embedding-v2',
  dimensions: 1024,
  chunkSize: 1_000,
  chunkOverlap: 50,
  embeddingInputMaxChars: 2_000,
  sourceRevision: 'a'.repeat(40),
} satisfies DocsRagProcessingProfileInput;

const PROFILE_CONFIG = {
  tool: 'docs-rag-pg-lab',
  rootDir: '.',
  defaultEvalFixturePath: 'fixture.json',
  evalTopK: 5,
  healthTimeoutMs: 5_000,
  embedding: {
    provider: 'llamacpp',
    model: 'embedding-v2',
    baseUrl: 'http://127.0.0.1:8082',
    dimensions: 1024,
    timeoutMs: 5_000,
    batchSize: 1,
    maxConcurrentBatches: 1,
  },
  database: {},
  pool: { max: 1, connectionTimeoutMs: 1_000, maxLifetimeMs: 0 },
  gates: { liveSearchEnabled: false, embeddingEnabled: true, mutationEnabled: false },
} satisfies DocsRagLabConfig;

function resolveBaseProfile(): DocsRagProcessingProfile {
  return resolveDocsRagProcessingProfile(BASE_INPUT);
}

describe('Docs RAG processing identity', () => {
  it('keeps the schema version compatible with migration 005', () => {
    expect(DOCS_RAG_PROCESSING_PROFILE_VERSION).toBe(1);
    expect(DOCS_RAG_PROCESSING_PROFILE_PIPELINE_REVISION).toBe(2);
  });

  it('bumps external component identities for provenance-aware sync', () => {
    const { profile } = resolveExternalDocsProcessingProfile(
      PROFILE_CONFIG,
      { skipLlm: true },
      'a'.repeat(40)
    );
    expect(profile).toMatchObject({
      cleaner: 'external-sync-cleaner-v2',
      refiner: 'refiner:bypass-deterministic-v2',
      redaction: 'external-secret-redactions-v2',
      normalization: 'external-control-normalize-v2',
      profileVersion: 1,
      sourceRevision: 'a'.repeat(40),
    });
  });

  it('changes identity for every derived-data and provenance component', () => {
    const base = resolveBaseProfile();
    const baseHash = docsRagProcessingProfileHash(base);
    const baseGenerationKey = buildDocsRagSourceGenerationKey({
      sourceId: 'bun-docs',
      upstreamRevision: base.sourceRevision,
      rawManifestSha256: 'b'.repeat(64),
      processingProfileHash: baseHash,
    });
    const variants: readonly [string, DocsRagProcessingProfile][] = [
      ['profileVersion', { ...base, profileVersion: base.profileVersion + 1 }],
      [
        'sourceRevision',
        resolveDocsRagProcessingProfile({ ...BASE_INPUT, sourceRevision: 'b'.repeat(40) }),
      ],
      ['cleaner', resolveDocsRagProcessingProfile({ ...BASE_INPUT, cleaner: 'cleaner-v3' })],
      ['refiner', resolveDocsRagProcessingProfile({ ...BASE_INPUT, refiner: 'refiner-v3' })],
      ['chunker', resolveDocsRagProcessingProfile({ ...BASE_INPUT, chunker: 'chunker-v3' })],
      [
        'normalization',
        resolveDocsRagProcessingProfile({ ...BASE_INPUT, normalization: 'normalization-v3' }),
      ],
      ['redaction', resolveDocsRagProcessingProfile({ ...BASE_INPUT, redaction: 'redaction-v3' })],
      ['provider', resolveDocsRagProcessingProfile({ ...BASE_INPUT, provider: 'provider-v3' })],
      ['model', resolveDocsRagProcessingProfile({ ...BASE_INPUT, model: 'embedding-v3' })],
      ['dimensions', resolveDocsRagProcessingProfile({ ...BASE_INPUT, dimensions: 768 })],
      ['chunkSize', resolveDocsRagProcessingProfile({ ...BASE_INPUT, chunkSize: 900 })],
      ['chunkOverlap', resolveDocsRagProcessingProfile({ ...BASE_INPUT, chunkOverlap: 40 })],
      [
        'embeddingInputMaxChars',
        resolveDocsRagProcessingProfile({ ...BASE_INPUT, embeddingInputMaxChars: 1_500 }),
      ],
    ];

    for (const [field, variant] of variants) {
      const variantHash = docsRagProcessingProfileHash(variant);
      expect(variantHash, field).not.toBe(baseHash);
      expect(
        buildDocsRagSourceGenerationKey({
          sourceId: 'bun-docs',
          upstreamRevision: variant.sourceRevision,
          rawManifestSha256: 'b'.repeat(64),
          processingProfileHash: variantHash,
        }),
        field
      ).not.toBe(baseGenerationKey);
    }
  });

  it('keeps the persisted embedding input bound and hash compatible', () => {
    const profile = resolveBaseProfile();
    expect(profile.embeddingInputMaxChars).toBe(2_000);
    expect(Object.keys(profile).sort()).toEqual([
      'chunkOverlap',
      'chunkSize',
      'chunker',
      'cleaner',
      'dimensions',
      'embeddingInputMaxChars',
      'model',
      'normalization',
      'profileVersion',
      'provider',
      'redaction',
      'refiner',
      'sourceRevision',
    ]);
    const input = buildDocsRagEmbeddingInputForChunk({
      searchableText: 'x'.repeat(profile.embeddingInputMaxChars + 1),
      content: 'fallback',
    });
    expect(input.text).toHaveLength(profile.embeddingInputMaxChars);
    expect(input.sha256).toBe(createHash('sha256').update(input.text, 'utf8').digest('hex'));
  });
});
