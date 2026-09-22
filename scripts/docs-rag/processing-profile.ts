import { createHash } from 'node:crypto';
import { DOCS_RAG_DEFAULT_CHUNK_OVERLAP, DOCS_RAG_DEFAULT_CHUNK_SIZE } from './chunker.js';

/**
 * Deterministic Docs RAG processing profile.
 *
 * The profile is the processing identity of a derived document: cleaner,
 * refiner, chunker, redaction, normalization, embedding provider, model,
 * dimensions, chunk parameters, embedding-input bound, and the upstream source
 * revision. Any component change produces a different profile hash, which
 * invalidates cached derived data (chunks/embeddings) and forces reprocessing.
 *
 * Component strings are supplied by callers; this module only provides the
 * structure, validation, and a stable order-independent identity hash so both
 * ingestion surfaces (external sync and direct corpus ingest) derive identical
 * identities for identical components.
 */

/** Serialized profile schema version accepted by Docs RAG migration 005. */
export const DOCS_RAG_PROCESSING_PROFILE_VERSION = 1;
/** Processing epoch for the current provenance-aware ingestion behavior. */
export const DOCS_RAG_PROCESSING_PROFILE_PIPELINE_REVISION = 2;

export interface DocsRagProcessingProfile {
  readonly profileVersion: number;
  /** Deterministic content cleaner identity (control characters etc.). */
  readonly cleaner: string;
  /** Refinement strategy identity ('none', deterministic id, or provider:model). */
  readonly refiner: string;
  /** Canonical chunker identity (DOCS_RAG_CHUNKER_ID). */
  readonly chunker: string;
  /** Secret-redaction rule-set identity applied before storage. */
  readonly redaction: string;
  /** Text normalization identity (unicode/control-character handling). */
  readonly normalization: string;
  /** Embedding provider identity. */
  readonly provider: string;
  /** Embedding model name as sent to the provider. */
  readonly model: string;
  /** Embedding vector dimensions validated before any write. */
  readonly dimensions: number;
  /** Canonical chunk size in characters. */
  readonly chunkSize: number;
  /** Canonical chunk overlap in characters. */
  readonly chunkOverlap: number;
  /** Hard bound on the exact text embedded per chunk. */
  readonly embeddingInputMaxChars: number;
  /** Upstream source revision when known (git commit, tag, or explicit id). */
  readonly sourceRevision?: string;
}

export interface DocsRagProcessingProfileInput {
  readonly cleaner: string;
  readonly refiner: string;
  readonly chunker: string;
  readonly redaction: string;
  readonly normalization: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly chunkSize?: number;
  readonly chunkOverlap?: number;
  readonly embeddingInputMaxChars?: number;
  readonly sourceRevision?: string | null;
}

const MAX_COMPONENT_LENGTH = 200;

function requireComponent(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Docs RAG processing profile component '${field}' must be a non-empty string`);
  }
  if (value.length > MAX_COMPONENT_LENGTH) {
    throw new Error(
      `Docs RAG processing profile component '${field}' exceeds ${MAX_COMPONENT_LENGTH} characters`
    );
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(
        `Docs RAG processing profile component '${field}' contains control characters`
      );
    }
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Docs RAG processing profile component '${field}' must be a positive integer`);
  }
  return value;
}

/**
 * Resolve and validate a processing profile from its components.
 * Optional numeric components fall back to the canonical chunker defaults so
 * callers that do not override chunking stay on one canonical parameterization.
 */
export function resolveDocsRagProcessingProfile(
  input: DocsRagProcessingProfileInput
): DocsRagProcessingProfile {
  const resolved: DocsRagProcessingProfile = Object.freeze({
    profileVersion: DOCS_RAG_PROCESSING_PROFILE_VERSION,
    cleaner: requireComponent(input.cleaner, 'cleaner'),
    refiner: requireComponent(input.refiner, 'refiner'),
    chunker: requireComponent(input.chunker, 'chunker'),
    redaction: requireComponent(input.redaction, 'redaction'),
    normalization: requireComponent(input.normalization, 'normalization'),
    provider: requireComponent(input.provider, 'provider'),
    model: requireComponent(input.model, 'model'),
    dimensions: requirePositiveInt(input.dimensions, 'dimensions'),
    chunkSize: requirePositiveInt(input.chunkSize ?? DOCS_RAG_DEFAULT_CHUNK_SIZE, 'chunkSize'),
    chunkOverlap: requireNonNegativeInt(
      input.chunkOverlap ?? DOCS_RAG_DEFAULT_CHUNK_OVERLAP,
      'chunkOverlap'
    ),
    embeddingInputMaxChars: requirePositiveInt(
      input.embeddingInputMaxChars ?? 2_000,
      'embeddingInputMaxChars'
    ),
    ...(input.sourceRevision
      ? { sourceRevision: requireComponent(input.sourceRevision, 'sourceRevision') }
      : {}),
  });
  return resolved;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Docs RAG processing profile component '${field}' must be a non-negative integer`
    );
  }
  return value;
}

/**
 * Stable SHA-256 identity of a processing profile. Field order in caller
 * objects cannot change the hash; unknown/extra fields are ignored by
 * construction because only canonical fields are serialized.
 */
export function docsRagProcessingProfileHash(profile: DocsRagProcessingProfile): string {
  const canonical = JSON.stringify({
    chunker: profile.chunker,
    chunkOverlap: profile.chunkOverlap,
    chunkSize: profile.chunkSize,
    cleaner: profile.cleaner,
    dimensions: profile.dimensions,
    embeddingInputMaxChars: profile.embeddingInputMaxChars,
    model: profile.model,
    normalization: profile.normalization,
    profileVersion: profile.profileVersion,
    provider: profile.provider,
    redaction: profile.redaction,
    refiner: profile.refiner,
    sourceRevision: profile.sourceRevision ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
