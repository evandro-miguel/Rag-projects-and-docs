import { createHash } from 'node:crypto';
import {
  DEFAULT_PROJECT_EMBEDDING_MODEL,
  DEFAULT_PROJECT_EMBEDDING_PROVIDER,
  PROJECT_EMBEDDING_DIMENSIONS,
} from '../../lib/shared/project-embedding-profiles.js';

export interface ProjectRagPostgresEmbeddingConfig {
  readonly provider: typeof DEFAULT_PROJECT_EMBEDDING_PROVIDER;
  readonly model: string;
  readonly baseUrl: string;
  readonly dimensions: typeof PROJECT_EMBEDDING_DIMENSIONS;
  readonly timeoutMs: number;
  /**
   * Deterministic sha256 hex digest of the canonical embedding profile
   * identity (schema version, provider, model, dimensions, input format and
   * its version). Stored on every embedding row and required by search so a
   * vector is only ever used with the exact processing profile that produced
   * it.
   */
  readonly profileHash: string;
}

/**
 * Version of the embedding profile identity schema itself. Bump only when the
 * canonical serialization changes (field set, order, or separator).
 */
export const PROJECT_RAG_EMBEDDING_PROFILE_SCHEMA_VERSION = 1;

/**
 * Input-format identity for chunk text sent to the embedding provider:
 * plain text truncated to {@link PROJECT_EMBEDDING_INPUT_MAX_CHARS} chars and
 * WTF-8 sanitized (lone surrogates replaced with U+FFFD). Bump the input
 * format version whenever truncation or sanitization semantics change.
 */
export const PROJECT_RAG_EMBEDDING_INPUT_FORMAT = 'plain-wellformed';
export const PROJECT_RAG_EMBEDDING_INPUT_FORMAT_VERSION = 1;

/**
 * Sentinel stored on rows whose processing profile cannot be proven to match
 * any canonical lane (e.g. pre-profile rows with foreign provider/model).
 * Search and promotion predicates must fail closed against it.
 */
export const PROJECT_RAG_EMBEDDING_PROFILE_LEGACY_UNKNOWN = 'legacy_unknown';

export interface ProjectRagEmbeddingProfileIdentity {
  readonly schemaVersion: number;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly inputFormat: string;
  readonly inputFormatVersion: number;
}

/**
 * Canonical, deterministic serialization of an embedding profile identity.
 *
 * Fields join with ':' in fixed order; string fields must be non-empty and
 * must not contain ':' so the encoding is unambiguous. The same value is
 * reproduced by migration 010's SQL backfill for the current lane.
 */
export function canonicalizeProjectRagEmbeddingProfileIdentity(
  identity: ProjectRagEmbeddingProfileIdentity
): string {
  const parts = [
    String(identity.schemaVersion),
    identity.provider,
    identity.model,
    String(identity.dimensions),
    identity.inputFormat,
    String(identity.inputFormatVersion),
  ];
  for (const part of parts) {
    if (!part.length || part.includes(':')) {
      throw new Error(
        `Invalid embedding profile identity component ${JSON.stringify(part)}; components must be non-empty and colon-free`
      );
    }
  }
  return parts.join(':');
}

/** Deterministic sha256 hex digest of the canonical profile identity. */
export function computeProjectRagEmbeddingProfileHash(
  identity: ProjectRagEmbeddingProfileIdentity
): string {
  return createHash('sha256')
    .update(canonicalizeProjectRagEmbeddingProfileIdentity(identity), 'utf8')
    .digest('hex');
}

/** The single canonical embedding profile identity for this codebase lane. */
export function projectRagPostgresEmbeddingProfileIdentity(): ProjectRagEmbeddingProfileIdentity {
  return {
    schemaVersion: PROJECT_RAG_EMBEDDING_PROFILE_SCHEMA_VERSION,
    provider: DEFAULT_PROJECT_EMBEDDING_PROVIDER,
    model: DEFAULT_PROJECT_EMBEDDING_MODEL,
    dimensions: PROJECT_EMBEDDING_DIMENSIONS,
    inputFormat: PROJECT_RAG_EMBEDDING_INPUT_FORMAT,
    inputFormatVersion: PROJECT_RAG_EMBEDDING_INPUT_FORMAT_VERSION,
  };
}

/** Canonical profile hash for this codebase lane (stable across processes). */
export const PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH = computeProjectRagEmbeddingProfileHash(
  projectRagPostgresEmbeddingProfileIdentity()
);

export const PROJECT_RAG_POSTGRES_EMBEDDING_MODEL = DEFAULT_PROJECT_EMBEDDING_MODEL;
export const PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL = 'http://127.0.0.1:8082';
export const PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS = PROJECT_EMBEDDING_DIMENSIONS;

const PROJECT_EMBEDDING_INPUT_MAX_CHARS = 800;
const TO_WELL_FORMED = (String.prototype as { toWellFormed?: (this: string) => string })
  .toWellFormed;
const LONE_SURROGATE_PATTERN =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/u, '');
}

export function resolveProjectRagPostgresEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env
): ProjectRagPostgresEmbeddingConfig {
  const docsEmbeddingConfigured = Boolean(
    normalizeEnvValue(env.DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL) ||
      normalizeEnvValue(env.DOCS_RAG_PG_LAB_EMBEDDING_MODEL)
  );
  const projectEmbeddingConfigured = Boolean(
    normalizeEnvValue(env.PROJECT_RAG_PG_EMBEDDING_BASE_URL) ||
      normalizeEnvValue(env.PROJECT_RAG_PG_EMBEDDING_MODEL)
  );
  if (docsEmbeddingConfigured && !projectEmbeddingConfigured) {
    throw new Error(
      'Project RAG embeddings require explicit PROJECT_RAG_PG_* settings when DOCS_RAG_PG_LAB_* uses an independent embedding lane'
    );
  }

  const model =
    normalizeEnvValue(env.PROJECT_RAG_PG_EMBEDDING_MODEL) ?? PROJECT_RAG_POSTGRES_EMBEDDING_MODEL;
  const baseUrl = normalizeBaseUrl(
    normalizeEnvValue(env.PROJECT_RAG_PG_EMBEDDING_BASE_URL) ??
      PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL
  );
  const runtimeLane = normalizeEnvValue(
    env.PROJECT_RAG_PREPARE_RUNTIME ?? env.PROJECT_RAG_RUNTIME_LANE
  );
  const isolatedRuntime =
    runtimeLane === 'isolated_dev' || runtimeLane === 'isolated-dev' || runtimeLane === 'test';

  if (model !== PROJECT_RAG_POSTGRES_EMBEDDING_MODEL) {
    throw new Error(
      `Project RAG embeddings require ${PROJECT_RAG_POSTGRES_EMBEDDING_MODEL}; got ${model}`
    );
  }
  if (baseUrl !== PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL && !isolatedRuntime) {
    throw new Error(
      `Project RAG embeddings require GPU lane ${PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL}; got ${baseUrl}`
    );
  }

  return {
    provider: DEFAULT_PROJECT_EMBEDDING_PROVIDER,
    model,
    baseUrl,
    dimensions: PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
    timeoutMs: parsePositiveInteger(env.PROJECT_RAG_PG_EMBEDDING_TIMEOUT_MS, 60_000),
    profileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
  };
}

function parseEmbeddingResponse(data: unknown): number[][] {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Embedding provider response was not an object');
  }

  if ('data' in data && Array.isArray(data.data)) {
    return data.data.map((row) =>
      typeof row === 'object' && row !== null && 'embedding' in row
        ? ((row as { embedding?: unknown }).embedding as number[])
        : []
    );
  }
  if ('embeddings' in data && Array.isArray(data.embeddings)) {
    return data.embeddings as number[][];
  }
  if ('embedding' in data && Array.isArray(data.embedding)) {
    return [data.embedding as number[]];
  }

  throw new Error('Embedding provider response did not contain embeddings');
}

function sanitizeProjectEmbeddingInput(text: string): string {
  const truncated = text.slice(0, PROJECT_EMBEDDING_INPUT_MAX_CHARS);
  return TO_WELL_FORMED
    ? TO_WELL_FORMED.call(truncated)
    : truncated.replace(LONE_SURROGATE_PATTERN, '\uFFFD');
}

export async function fetchProjectRagPostgresEmbeddings(
  config: ProjectRagPostgresEmbeddingConfig,
  texts: readonly string[],
  signal?: AbortSignal
): Promise<number[][]> {
  const providerTimeout = AbortSignal.timeout(config.timeoutMs);
  const { composeAbortSignals } = await import('../../lib/shared/abort-utils.js');
  const composedSignal = signal ? composeAbortSignals(providerTimeout, signal) : providerTimeout;

  const response = await fetch(`${config.baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      input: texts.map(sanitizeProjectEmbeddingInput),
    }),
    signal: composedSignal,
  });
  if (!response.ok) {
    throw new Error(`Embedding provider API error ${response.status}: ${await response.text()}`);
  }

  const embeddings = parseEmbeddingResponse(await response.json());
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embedding provider returned ${embeddings.length} embeddings for ${texts.length} inputs`
    );
  }
  for (const embedding of embeddings) {
    if (embedding.length !== config.dimensions) {
      throw new Error(
        `Embedding has ${embedding.length} dimensions; expected ${config.dimensions}`
      );
    }
  }
  return embeddings;
}
