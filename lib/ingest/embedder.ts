/**
 * @module ingest/embedder
 * @description Local embedding generation with caching, batching, and rate limiting.
 *
 * Uses the RAG-scoped llama.cpp embedding endpoint. Ollama is not supported.
 */

import pLimit from 'p-limit';
import pRetry from 'p-retry';
import {
  DEFAULT_PROJECT_EMBEDDING_MODEL,
  PROJECT_EMBEDDING_DIMENSIONS,
} from '../shared/project-embedding-profiles.js';
import {
  calculateProjectRagNormalizedTextHash,
  createProjectRagEmbeddingCacheKey,
} from '../shared/project-rag-contract.js';
import { detectPII, redactPII } from './pii_redactor.js';

export type EmbeddingProvider = 'llamacpp';

export function resolveEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const rawProvider = (env.EMBEDDING_PROVIDER ?? 'llamacpp').trim().toLowerCase();
  if (rawProvider === 'llamacpp' || rawProvider === 'llama.cpp' || rawProvider === 'llama-cpp') {
    return 'llamacpp';
  }
  if (rawProvider === 'ollama') {
    throw new Error('Unsupported EMBEDDING_PROVIDER "ollama". This RAG system requires llama.cpp.');
  }
  throw new Error(
    `Unsupported EMBEDDING_PROVIDER "${rawProvider}". This RAG system requires llama.cpp.`
  );
}

export function resolveEmbeddingModel(env: NodeJS.ProcessEnv = process.env): string {
  resolveEmbeddingProvider(env);
  return env.LLAMACPP_EMBEDDING_MODEL ?? env.EMBEDDING_MODEL ?? DEFAULT_PROJECT_EMBEDDING_MODEL;
}

export const EMBEDDING_DIMENSIONS: number = PROJECT_EMBEDDING_DIMENSIONS;
const CACHE_METRIC_TRACKING_CONCURRENCY = 4;
let resolvedEmbeddingBaseUrl: string | null = null;
let resolvedEmbeddingProvider: EmbeddingProvider | null = null;
let resolvedEmbeddingPrimaryBaseUrl: string | null = null;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveDefaultEmbeddingBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(env.EMBEDDING_BATCH_SIZE ?? env.LLAMACPP_EMBEDDING_BATCH_SIZE, 1);
}

function resolveDefaultEmbeddingMaxConcurrentBatches(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(
    env.EMBEDDING_MAX_CONCURRENT_BATCHES ?? env.LLAMACPP_EMBEDDING_MAX_CONCURRENT_BATCHES,
    1
  );
}

function getEmbeddingProvider(): EmbeddingProvider {
  return resolveEmbeddingProvider();
}

function getEmbeddingPrimaryBaseUrl(_provider = getEmbeddingProvider()): string {
  return (
    process.env.LLAMACPP_BASE_URL ?? process.env.RAG_LLAMACPP_BASE_URL ?? 'http://127.0.0.1:8082'
  );
}

function buildEmbeddingBaseUrls(primaryUrl: string): string[] {
  const candidates: string[] = [];
  const pushCandidate = (url: string) => {
    const normalizedUrl = url.replace(/\/$/, '');
    if (!candidates.includes(normalizedUrl)) {
      candidates.push(normalizedUrl);
    }
  };

  try {
    const primary = new URL(primaryUrl);
    const primaryHostname = primary.hostname.toLowerCase();

    if (primaryHostname === 'host.docker.internal') {
      const loopback = new URL(primaryUrl);
      loopback.hostname = '127.0.0.1';
      pushCandidate(loopback.toString());

      const localhost = new URL(primaryUrl);
      localhost.hostname = 'localhost';
      pushCandidate(localhost.toString());
    }

    pushCandidate(primaryUrl);

    const hostDocker = new URL(primaryUrl);
    hostDocker.hostname = 'host.docker.internal';
    pushCandidate(hostDocker.toString());

    const localhost = new URL(primaryUrl);
    localhost.hostname = 'localhost';
    pushCandidate(localhost.toString());

    const loopback = new URL(primaryUrl);
    loopback.hostname = '127.0.0.1';
    pushCandidate(loopback.toString());
  } catch {
    pushCandidate(primaryUrl);
  }

  return candidates;
}

function getEmbeddingBaseUrls(): string[] {
  const provider = getEmbeddingProvider();
  const primaryUrl = getEmbeddingPrimaryBaseUrl(provider);
  const candidates = buildEmbeddingBaseUrls(primaryUrl);
  if (resolvedEmbeddingProvider !== provider || resolvedEmbeddingPrimaryBaseUrl !== primaryUrl) {
    resolvedEmbeddingBaseUrl = null;
    resolvedEmbeddingProvider = provider;
    resolvedEmbeddingPrimaryBaseUrl = primaryUrl;
  }

  if (!resolvedEmbeddingBaseUrl) {
    return candidates;
  }

  return [
    resolvedEmbeddingBaseUrl,
    ...candidates.filter((url) => url !== resolvedEmbeddingBaseUrl),
  ];
}

function formatEmbeddingTargets(): string {
  return getEmbeddingBaseUrls().join(', ');
}

// Timeout configuration (in milliseconds)
const EMBEDDING_TIMEOUT_MS = parseInt(
  process.env.EMBEDDING_TIMEOUT_MS ?? process.env.LLAMACPP_TIMEOUT_MS ?? '120000',
  10
);
const EMBEDDING_CONNECT_TIMEOUT_MS = parseInt(
  process.env.EMBEDDING_CONNECT_TIMEOUT_MS ?? process.env.LLAMACPP_CONNECT_TIMEOUT_MS ?? '10000',
  10
);

export interface EmbeddingCacheApi {
  ingest: {
    db: {
      batchGetProjectCachedEmbeddings: any;
      batchGetCachedEmbeddings: any;
      cacheProjectEmbedding: any;
      cacheEmbedding: any;
    };
  };
  analytics: {
    trackCacheMetric: any;
  };
}

export interface EmbeddingCacheClient {
  query: (handle: unknown, args: unknown) => Promise<any>;
  mutation: (handle: unknown, args: unknown) => Promise<any>;
}

export interface EmbeddingOptions {
  maxRetries?: number;
  batchSize?: number;
  minTimeout?: number;
  cacheClient?: EmbeddingCacheClient;
  cacheApi?: EmbeddingCacheApi;
  maxConcurrentBatches?: number;
  enablePIIRedaction?: boolean;
  enablePIIProofLogging?: boolean;
  timeoutMs?: number;
  fallbackOnUnavailable?: boolean;
  quiet?: boolean;
  expectedDimensions?: number;
  cacheContext?: {
    namespace: 'docs' | 'project_rag';
    provider?: string;
    model?: string;
    dimensions?: number;
    inputMode?: string;
    redactionVersion?: string;
    chunkerVersion?: string;
  };
}

/**
 * PII Redaction proof log entry
 */
interface PIIRedactionProof {
  timestamp: string;
  sessionId: string;
  totalChunks: number;
  redactedChunks: number;
  redactionDetails: Array<{
    chunkIndex: number;
    matchCount: number;
    types: string[];
    sample?: string; // First 100 chars of redacted text (sanitized)
  }>;
}

// Simple hash function using SubtleCrypto (Standard Web API)
async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const cryptoAPI = typeof crypto !== 'undefined' ? crypto : (globalThis as any).crypto;
  if (!cryptoAPI?.subtle?.digest) {
    throw new Error('Web Crypto API (subtle.digest) is not available in this runtime');
  }
  const hashBuffer = await cryptoAPI.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Log PII redaction proof to stdout.
 * Captures evidence of redaction for compliance verification.
 * Note: File-based proof logging is available via operational scripts.
 */
function writePIIRedactionProof(proof: PIIRedactionProof, quiet = false): void {
  if (quiet) {
    return;
  }
  // File-based proof logging can be done via separate scripts.
  console.log(
    `📝 PII redaction proof: sessionId=${proof.sessionId}, totalChunks=${proof.totalChunks}, redactedChunks=${proof.redactedChunks}`
  );
}

/**
 * Generate a unique session ID for proof logging.
 */
function generateSessionId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

/**
 * Create a fetch request with timeout using AbortController.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchEmbeddingProviderWithFallback(
  path: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (const baseUrl of getEmbeddingBaseUrls()) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}${path}`, options, timeoutMs);
      if (response.ok) {
        resolvedEmbeddingBaseUrl = baseUrl;
        return response;
      }

      lastResponse = response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw lastError ?? new Error(`Embedding provider request failed for ${path}`);
}

function parseEmbeddingResponse(data: unknown): number[][] {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Embedding provider response was not an object');
  }

  if ('embeddings' in data) {
    const embeddings = (data as { embeddings?: unknown }).embeddings;
    if (Array.isArray(embeddings)) {
      return embeddings as number[][];
    }
  }

  if ('data' in data) {
    const rows = (data as { data?: unknown }).data;
    if (Array.isArray(rows)) {
      return rows.map((row) => {
        if (typeof row === 'object' && row !== null && 'embedding' in row) {
          return (row as { embedding?: unknown }).embedding as number[];
        }
        return undefined as unknown as number[];
      });
    }
  }

  if ('embedding' in data) {
    const embedding = (data as { embedding?: unknown }).embedding;
    if (Array.isArray(embedding)) {
      return [embedding as number[]];
    }
  }

  throw new Error('Embedding provider response did not contain embeddings');
}

function validateEmbeddingBatch(
  embeddings: number[][],
  expectedCount: number,
  expectedDimensions = EMBEDDING_DIMENSIONS
): void {
  if (embeddings.length !== expectedCount) {
    throw new Error(
      `Embedding provider returned ${embeddings.length} embeddings for ${expectedCount} inputs`
    );
  }

  for (const [index, embedding] of embeddings.entries()) {
    if (!Array.isArray(embedding)) {
      throw new Error(`Embedding provider returned a non-array embedding at index ${index}`);
    }
    if (embedding.length !== expectedDimensions) {
      throw new Error(
        `Embedding provider returned ${embedding.length} dimensions at index ${index}; expected ${expectedDimensions}`
      );
    }
  }
}

function getEmbeddingRequestPath(): string {
  return '/v1/embeddings';
}

function getAvailabilityPath(): string {
  return '/health';
}

/**
 * Call the configured embedding endpoint for a batch of texts.
 */
async function providerEmbed(
  texts: string[],
  model: string,
  timeoutMs: number = EMBEDDING_TIMEOUT_MS,
  expectedDimensions = EMBEDDING_DIMENSIONS
): Promise<number[][]> {
  const res = await fetchEmbeddingProviderWithFallback(
    getEmbeddingRequestPath(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding provider API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const embeddings = parseEmbeddingResponse(data);
  validateEmbeddingBatch(embeddings, texts.length, expectedDimensions);
  return embeddings;
}

/**
 * Generate embeddings for multiple text chunks using the configured local provider.
 *
 * Supports batching, retry logic, cache, and concurrent request limiting.
 *
 * @param texts - Array of text strings
 * @param _apiKey - Unused (kept for API compatibility with old callers)
 * @param model - Embedding model name
 * @param options - Batching, retry, and concurrency options
 * @returns Array of embedding vectors for the configured profile
 */
export async function generateEmbeddings(
  texts: string[],
  _apiKey?: string,
  model = resolveEmbeddingModel(),
  options: EmbeddingOptions = {}
): Promise<number[][]> {
  const {
    maxRetries = 3,
    batchSize = resolveDefaultEmbeddingBatchSize(),
    minTimeout = 500,
    cacheClient,
    cacheApi,
    maxConcurrentBatches = resolveDefaultEmbeddingMaxConcurrentBatches(),
    enablePIIRedaction = process.env.EMBEDDING_REDACT_PII !== 'false',
    enablePIIProofLogging = process.env.EMBEDDING_PII_PROOF_LOGGING === 'true',
    timeoutMs = EMBEDDING_TIMEOUT_MS,
    fallbackOnUnavailable = process.env.EMBEDDING_FALLBACK_ON_UNAVAILABLE === 'true',
    quiet = false,
    expectedDimensions: requestedExpectedDimensions,
    cacheContext = { namespace: 'docs' as const },
  } = options;
  const expectedDimensions =
    requestedExpectedDimensions ?? cacheContext.dimensions ?? EMBEDDING_DIMENSIONS;

  const forceProviderInTests =
    process.env.EMBEDDER_FORCE_PROVIDER === '1' || process.env.EMBEDDER_FORCE_OLLAMA === '1';
  const sessionId = generateSessionId();

  // PII Redaction with proof logging (T-17)
  let embeddingInputs: string[];
  const redactionDetails: PIIRedactionProof['redactionDetails'] = [];

  if (enablePIIRedaction) {
    embeddingInputs = texts.map((text, index) => {
      const redacted = redactPII(text);
      if (redacted !== text) {
        const matches = detectPII(text);
        const types = [...new Set(matches.map((m) => m.type))];
        redactionDetails.push({
          chunkIndex: index,
          matchCount: matches.length,
          types,
          sample:
            redacted.substring(0, 100).replace(/\n/g, ' ') + (redacted.length > 100 ? '...' : ''),
        });
      }
      return redacted;
    });

    const redactedCount = redactionDetails.length;
    if (redactedCount > 0) {
      if (!quiet) {
        console.log(`🧹 PII redacted in ${redactedCount}/${texts.length} chunks before embedding`);
      }

      // Write proof log if enabled
      if (enablePIIProofLogging) {
        const proof: PIIRedactionProof = {
          timestamp: new Date().toISOString(),
          sessionId,
          totalChunks: texts.length,
          redactedChunks: redactedCount,
          redactionDetails,
        };
        writePIIRedactionProof(proof, quiet);
      }
    }
  } else {
    embeddingInputs = texts;
  }

  if ((process.env.NODE_ENV === 'test' || process.env.VITEST) && !forceProviderInTests) {
    // Deterministic mock embeddings for testing
    return embeddingInputs.map((_, i) =>
      Array.from({ length: expectedDimensions }, (_, j) => Math.sin(i + j) * 0.1)
    );
  }

  const allEmbeddings: number[][] = new Array(embeddingInputs.length);
  const textsToEmbed: { text: string; originalIndex: number; hash: string; cacheKey?: string }[] =
    [];
  const cachedResults: Array<{ embedding: number[] } | null> = new Array(embeddingInputs.length);
  const EMBEDDING_CACHE_BATCH_SIZE = 128;

  // Cache metrics tracking
  let cacheHits = 0;
  let cacheMisses = 0;
  const cacheCheckStartTime = Date.now();
  const requireEmbeddingCacheApi = (): EmbeddingCacheApi => {
    if (!cacheApi) {
      throw new Error('Embedding cache API is required when cacheClient is provided.');
    }
    return cacheApi;
  };

  // 1. Check cache
  if (cacheClient) {
    const embeddingCacheApi = requireEmbeddingCacheApi();

    if (!quiet) {
      console.log(`🔍 Checking embedding cache for ${embeddingInputs.length} chunks...`);
    }
    let cacheIdentifiers: string[] = [];
    let cacheKeys: string[] | undefined;

    if (cacheContext.namespace === 'project_rag') {
      if (
        !cacheContext.provider ||
        !cacheContext.model ||
        !cacheContext.dimensions ||
        !cacheContext.inputMode ||
        !cacheContext.redactionVersion ||
        !cacheContext.chunkerVersion
      ) {
        throw new Error(
          'Project cache context requires provider, model, dimensions, inputMode, redactionVersion, and chunkerVersion.'
        );
      }
      const provider = cacheContext.provider;
      const contextModel = cacheContext.model;
      const dimensions = cacheContext.dimensions;
      const inputMode = cacheContext.inputMode;
      const redactionVersion = cacheContext.redactionVersion;
      const chunkerVersion = cacheContext.chunkerVersion;

      const normalizedHashes = await Promise.all(
        embeddingInputs.map((text) => calculateProjectRagNormalizedTextHash(text))
      );
      cacheKeys = normalizedHashes.map((normalizedTextHash) =>
        createProjectRagEmbeddingCacheKey({
          provider,
          model: contextModel,
          dimensions,
          inputMode,
          redactionVersion,
          chunkerVersion,
          normalizedTextHash,
        })
      );
      cacheIdentifiers = cacheKeys;

      for (let i = 0; i < cacheKeys.length; i += EMBEDDING_CACHE_BATCH_SIZE) {
        const batchKeys = cacheKeys.slice(i, i + EMBEDDING_CACHE_BATCH_SIZE);
        const batchResults = await cacheClient.query(
          embeddingCacheApi.ingest.db.batchGetProjectCachedEmbeddings,
          {
            cacheKeys: batchKeys,
          }
        );
        for (let j = 0; j < batchResults.length; j++) {
          cachedResults[i + j] = batchResults[j];
        }
      }

      for (let i = 0; i < embeddingInputs.length; i++) {
        const cachedResult = cachedResults[i];
        if (cachedResult) {
          allEmbeddings[i] = cachedResult.embedding;
          cacheHits++;
        } else {
          textsToEmbed.push({
            text: embeddingInputs[i],
            originalIndex: i,
            hash: normalizedHashes[i],
            cacheKey: cacheKeys[i],
          });
          cacheMisses++;
        }
      }
    } else {
      const hashes = await Promise.all(embeddingInputs.map((t) => sha256(t)));
      cacheIdentifiers = hashes;

      for (let i = 0; i < hashes.length; i += EMBEDDING_CACHE_BATCH_SIZE) {
        const batchHashes = hashes.slice(i, i + EMBEDDING_CACHE_BATCH_SIZE);
        const batchResults = await cacheClient.query(
          embeddingCacheApi.ingest.db.batchGetCachedEmbeddings,
          {
            textHashes: batchHashes,
            model,
          }
        );
        for (let j = 0; j < batchResults.length; j++) {
          cachedResults[i + j] = batchResults[j];
        }
      }
      for (let i = 0; i < embeddingInputs.length; i++) {
        const cachedResult = cachedResults[i];
        if (cachedResult) {
          allEmbeddings[i] = cachedResult.embedding;
          cacheHits++;
        } else {
          textsToEmbed.push({ text: embeddingInputs[i], originalIndex: i, hash: hashes[i] });
          cacheMisses++;
        }
      }
    }
    if (!quiet) {
      console.log(
        `✅ Cache hits: ${cacheHits}, Cache misses: ${cacheMisses}, To embed: ${textsToEmbed.length}`
      );
    }

    if (!quiet) {
      const cacheCheckLatency = Date.now() - cacheCheckStartTime;
      const metricLimit = pLimit(CACHE_METRIC_TRACKING_CONCURRENCY);
      const metricWrites: Promise<void>[] = [];

      const hitHashes: string[] = [];
      for (let i = 0; i < embeddingInputs.length; i++) {
        if (cachedResults[i]) {
          hitHashes.push(cacheIdentifiers[i]);
        }
      }

      for (const hash of hitHashes) {
        metricWrites.push(
          metricLimit(async () => {
            await cacheClient.mutation(embeddingCacheApi.analytics.trackCacheMetric, {
              cacheType: 'document_embedding',
              hit: true,
              queryHash: hash,
              latencyMs: 0,
              model,
            });
          })
        );
      }

      for (const item of textsToEmbed) {
        metricWrites.push(
          metricLimit(async () => {
            await cacheClient.mutation(embeddingCacheApi.analytics.trackCacheMetric, {
              cacheType: 'document_embedding',
              hit: false,
              queryHash: item.hash,
              latencyMs: cacheCheckLatency,
              model,
            });
          })
        );
      }

      const metricResults = await Promise.allSettled(metricWrites);
      const failedMetricWrites = metricResults.filter((result) => result.status === 'rejected');
      if (failedMetricWrites.length > 0) {
        console.warn(`[Embedder] Failed to track ${failedMetricWrites.length} cache metrics`);
      }
    }
  } else {
    for (let i = 0; i < embeddingInputs.length; i++) {
      const hash =
        cacheContext.namespace === 'project_rag'
          ? await calculateProjectRagNormalizedTextHash(embeddingInputs[i])
          : await sha256(embeddingInputs[i]);
      const cacheKey =
        cacheContext.namespace === 'project_rag' &&
        cacheContext.provider &&
        cacheContext.model &&
        cacheContext.dimensions &&
        cacheContext.inputMode &&
        cacheContext.redactionVersion &&
        cacheContext.chunkerVersion
          ? createProjectRagEmbeddingCacheKey({
              provider: cacheContext.provider,
              model: cacheContext.model,
              dimensions: cacheContext.dimensions,
              inputMode: cacheContext.inputMode,
              redactionVersion: cacheContext.redactionVersion,
              chunkerVersion: cacheContext.chunkerVersion,
              normalizedTextHash: hash,
            })
          : undefined;
      textsToEmbed.push({
        text: embeddingInputs[i],
        originalIndex: i,
        hash,
        cacheKey,
      });
      cacheMisses++;
    }
  }

  if (textsToEmbed.length === 0) {
    validateEmbeddingBatch(allEmbeddings, embeddingInputs.length, expectedDimensions);
    return allEmbeddings;
  }

  // 2. Check provider availability before processing (with fallback)
  const providerAvailable = await isEmbeddingProviderAvailable();
  if (!providerAvailable) {
    const errorMessage = `Embedding provider "${getEmbeddingProvider()}" is not available at ${formatEmbeddingTargets()}.`;
    if (fallbackOnUnavailable) {
      if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
        throw new Error(
          `${errorMessage} Test vector fallback is test-only; start the GPU llama.cpp embedding service instead.`
        );
      }
      if (!quiet) {
        console.warn(errorMessage);
        console.warn(
          '⚠️  Test vector fallback explicitly enabled: generating deterministic test vectors.'
        );
      }
      // Generate deterministic test vectors for tests only.
      for (let i = 0; i < textsToEmbed.length; i++) {
        const { originalIndex } = textsToEmbed[i];
        allEmbeddings[originalIndex] = Array.from(
          { length: expectedDimensions },
          (_, j) => Math.sin(i + j) * 0.1
        );
      }
      return allEmbeddings;
    }
    throw new Error(
      `Embedding provider unavailable at ${formatEmbeddingTargets()}. Start the GPU llama.cpp embedding service.`
    );
  }

  // 3. Process in batches with parallelism
  const batchLimit = pLimit(maxConcurrentBatches);
  const batchPromises = [];

  for (let i = 0; i < textsToEmbed.length; i += batchSize) {
    const batch = textsToEmbed.slice(i, i + batchSize);
    const batchIdx = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(textsToEmbed.length / batchSize);

    batchPromises.push(
      batchLimit(async () => {
        if (!quiet) {
          console.log(`📡 Embedding batch ${batchIdx}/${totalBatches} (${batch.length} chunks)...`);
        }

        const batchResults = await pRetry(
          async () =>
            providerEmbed(
              batch.map((b) => b.text),
              model,
              timeoutMs,
              expectedDimensions
            ),
          {
            retries: maxRetries,
            minTimeout,
            onFailedAttempt: (context) => {
              const errorMsg = context.error.message || String(context.error);
              if (!quiet) {
                console.warn(
                  `⚠️ Attempt ${context.attemptNumber} failed (${errorMsg}). ${context.retriesLeft} retries left.`
                );
              }
            },
          }
        );

        for (let j = 0; j < batch.length; j++) {
          const { originalIndex, hash } = batch[j];
          const embedding = batchResults[j];
          allEmbeddings[originalIndex] = embedding;

          if (cacheClient) {
            const embeddingCacheApi = requireEmbeddingCacheApi();
            const cacheWrite =
              cacheContext.namespace === 'project_rag' && batch[j].cacheKey
                ? cacheClient.mutation(embeddingCacheApi.ingest.db.cacheProjectEmbedding, {
                    cacheKey: batch[j].cacheKey,
                    normalizedTextHash: hash,
                    embedding,
                    model: cacheContext.model ?? model,
                    provider: cacheContext.provider ?? getEmbeddingProvider(),
                    dimensions: cacheContext.dimensions ?? expectedDimensions,
                    inputMode: cacheContext.inputMode ?? 'unknown',
                    redactionVersion: cacheContext.redactionVersion ?? 'unknown',
                    chunkerVersion: cacheContext.chunkerVersion ?? 'unknown',
                  })
                : cacheClient.mutation(embeddingCacheApi.ingest.db.cacheEmbedding, {
                    textHash: hash,
                    embedding,
                    model,
                  });

            await cacheWrite.catch((e: any) => {
              if (!quiet) {
                console.error('Cache save failed:', e);
              }
            });
          }
        }
        if (!quiet) {
          console.log(`✅ Completed batch ${batchIdx}/${totalBatches}`);
        }
      })
    );
  }

  await Promise.all(batchPromises);
  validateEmbeddingBatch(allEmbeddings, embeddingInputs.length, expectedDimensions);
  return allEmbeddings;
}

/**
 * Generate a single embedding for one text.
 */
export async function generateEmbedding(
  text: string,
  _apiKey?: string,
  model = resolveEmbeddingModel()
): Promise<number[]> {
  const embeddings = await generateEmbeddings([text], undefined, model, { batchSize: 1 });
  return embeddings[0];
}

/**
 * Validate that the configured embedding provider is reachable.
 *
 * This function keeps the old name because callers treat it as a generic
 * embedding-readiness probe rather than an actual API-key check.
 */
export async function validateApiKey(_apiKey?: string): Promise<boolean> {
  try {
    return isEmbeddingProviderAvailable();
  } catch {
    return false;
  }
}

/**
 * Check if the configured embedding provider is available without throwing.
 * Useful for fallback decisions.
 */
export async function isEmbeddingProviderAvailable(): Promise<boolean> {
  try {
    const res = await fetchEmbeddingProviderWithFallback(
      getAvailabilityPath(),
      { method: 'GET' },
      EMBEDDING_CONNECT_TIMEOUT_MS
    );
    return res.ok;
  } catch {
    return false;
  }
}
