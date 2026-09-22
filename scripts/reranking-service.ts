#!/usr/bin/env bun

/**
 * @module scripts/reranking-service
 * @description HTTP-based cross-encoder reranking service for Docs RAG.
 *
 * This service provides an HTTP endpoint that local RAG tools can call to perform
 * cross-encoder reranking. It uses the Hugging Face Transformers.js library with
 * ONNX Runtime to compute relevance scores between queries and documents.
 *
 * ## Usage
 *
 * ```bash
 * # Start the service
 * bun run scripts/reranking-service.ts
 *
 * # Or with custom port
 * PORT=3456 bun run scripts/reranking-service.ts
 * ```
 *
 * ## API
 *
 * POST /rerank
 * Body: { query: string, documents: string[], model?: string, quantized?: boolean }
 * Response: { scores: number[], model: string, processingTimeMs: number }
 *
 * When model loading or inference fails, the endpoint still answers HTTP 200
 * with uniform 0.5 scores and additionally sets `degraded: true` plus a
 * `degradedReason` string so consumers can distinguish fallback output from
 * real cross-encoder scoring. These fields are absent on the success path.
 */

import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type DataType,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor,
} from '@huggingface/transformers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { z } from 'zod';

import { createAsyncLock } from './lib/async-lock.js';

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.RERANKING_SERVICE_PORT ?? '3456');
const HOST = process.env.RERANKING_SERVICE_HOST ?? '127.0.0.1';
const DEFAULT_MODEL = process.env.RERANKING_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2';

// ============================================================================
// Request Validation Schema
// ============================================================================

const RerankRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  documents: z.array(z.string()).min(1, 'At least one document is required'),
  model: z.string().optional().default(DEFAULT_MODEL),
  quantized: z.boolean().optional().default(true),
});

interface RerankResponse {
  scores: number[];
  model: string;
  processingTimeMs: number;
  /** Present only when scores came from the uniform-0.5 fallback, not the model. */
  degraded?: boolean;
  /** Human-readable reason for degraded fallback output. */
  degradedReason?: string;
}

// ============================================================================
// Metrics Tracking
// ============================================================================

interface ServiceMetrics {
  totalCalls: number;
  totalErrors: number;
  totalLatencyMs: number;
  modelCacheHits: number;
  modelCacheMisses: number;
  startTime: number;
}

const metrics: ServiceMetrics = {
  totalCalls: 0,
  totalErrors: 0,
  totalLatencyMs: 0,
  modelCacheHits: 0,
  modelCacheMisses: 0,
  startTime: Date.now(),
};

/**
 * Record a successful call with its latency
 */
function recordCall(latencyMs: number): void {
  metrics.totalCalls++;
  metrics.totalLatencyMs += latencyMs;
}

/**
 * Record an error
 */
function recordError(): void {
  metrics.totalErrors++;
}

/**
 * Record model cache hit
 */
function recordModelCacheHit(): void {
  metrics.modelCacheHits++;
}

/**
 * Record model cache miss
 */
function recordModelCacheMiss(): void {
  metrics.modelCacheMisses++;
}

/**
 * Get current metrics summary
 */
function getMetrics() {
  const avgLatency =
    metrics.totalCalls > 0 ? Math.round(metrics.totalLatencyMs / metrics.totalCalls) : 0;

  const totalModelCacheAccesses = metrics.modelCacheHits + metrics.modelCacheMisses;
  const cacheHitRate =
    totalModelCacheAccesses > 0
      ? Math.round((metrics.modelCacheHits / totalModelCacheAccesses) * 100)
      : 0;

  const uptimeMs = Date.now() - metrics.startTime;
  const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

  return {
    totalCalls: metrics.totalCalls,
    totalErrors: metrics.totalErrors,
    averageLatencyMs: avgLatency,
    cacheHitRate: cacheHitRate,
    modelCacheHits: metrics.modelCacheHits,
    modelCacheMisses: metrics.modelCacheMisses,
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
  };
}

// Lazy-loaded model and tokenizer
let cachedModel: PreTrainedModel | null = null;
let cachedTokenizer: PreTrainedTokenizer | null = null;
let currentModel: string | null = null;
let currentDtype: DataType | null = null;
const withModelLoadLock = createAsyncLock();

/**
 * Model cache entry containing both model and tokenizer
 */
interface ModelCache {
  model: PreTrainedModel;
  tokenizer: PreTrainedTokenizer;
}

function quantizedToDtype(quantized: boolean): DataType {
  return quantized ? 'q8' : 'fp32';
}

/**
 * Get or initialize the cross-encoder model and tokenizer
 */
async function getModel(modelName: string, quantized: boolean): Promise<ModelCache> {
  return withModelLoadLock(async () => {
    const dtype = quantizedToDtype(quantized);

    // Re-initialize if model changed
    if (
      (cachedModel || cachedTokenizer) &&
      (currentModel !== modelName || currentDtype !== dtype)
    ) {
      console.log(
        `[RerankingService] Switching model from ${currentModel} (${currentDtype}) to ${modelName} (${dtype})`
      );
      cachedModel = null;
      cachedTokenizer = null;
    }

    if (!cachedModel || !cachedTokenizer) {
      console.log(`[RerankingService] Loading model: ${modelName} (dtype: ${dtype})`);
      recordModelCacheMiss();

      // Configure ONNX runtime for Node.js
      env.allowLocalModels = false;
      env.useBrowserCache = false;

      // Load model and tokenizer directly (not via pipeline)
      // This gives us access to raw logits for cross-encoder scoring
      cachedModel = await AutoModelForSequenceClassification.from_pretrained(modelName, {
        dtype,
      });
      cachedTokenizer = await AutoTokenizer.from_pretrained(modelName);

      currentModel = modelName;
      currentDtype = dtype;
      console.log(`[RerankingService] Model loaded successfully`);
    } else {
      recordModelCacheHit();
    }

    return { model: cachedModel, tokenizer: cachedTokenizer };
  });
}

/**
 * Compute cross-encoder scores for query-document pairs.
 *
 * Uses AutoModel to get raw logits, then applies sigmoid for 0-1 range.
 * The ms-marco-MiniLM-L-6-v2 model outputs a single relevance logit.
 *
 * IMPORTANT: Use `text_pair` parameter for tokenizer to properly format
 * cross-encoder input as [CLS] query [SEP] document [SEP]. Using manual
 * [SEP] string produces incorrect scores (~0.001 instead of 0.1-0.99).
 *
 * On model/inference failure, returns uniform 0.5 scores flagged with
 * `degraded: true` so the HTTP layer can expose honest degradation signals
 * instead of silently masquerading fallback output as real scoring.
 */
async function computeRerankScores(
  query: string,
  documents: string[],
  modelName: string,
  quantized: boolean
): Promise<{ scores: number[]; degraded: boolean; degradedReason?: string }> {
  const startTime = Date.now();

  try {
    const { model, tokenizer } = await getModel(modelName, quantized);

    const scores: number[] = [];
    // Set when any document's model output lacks usable logits; such documents
    // silently receive the uniform-0.5 fallback below, so the whole response
    // must be flagged as degraded instead of masquerading as real scoring.
    let missingLogitsFallback = false;

    // Process each query-document pair
    for (const doc of documents) {
      // Use tokenizer's text_pair for proper cross-encoder formatting
      // This produces: [CLS] query [SEP] document [SEP]
      const encoded = await tokenizer(query, {
        text_pair: doc,
        return_tensor: true,
      });

      // Get model outputs (contains logits)
      const outputs = await model(encoded as Record<string, Tensor>);

      // Extract the logit and apply sigmoid
      // ms-marco outputs a single relevance logit
      const logits = outputs.logits;
      if (logits?.data) {
        const rawLogit = logits.data[0] as number;
        // Apply sigmoid: 1 / (1 + exp(-x))
        const score = 1 / (1 + Math.exp(-rawLogit));
        scores.push(score);
      } else {
        // Fallback if no logits (shouldn't happen with valid model)
        scores.push(0.5);
        missingLogitsFallback = true;
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[RerankingService] Computed ${scores.length} scores in ${duration}ms (avg: ${(duration / scores.length).toFixed(1)}ms/doc)`
    );

    // Log score distribution for monitoring
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(
      `[RerankingService] Score distribution: min=${minScore.toFixed(3)}, max=${maxScore.toFixed(3)}, avg=${avgScore.toFixed(3)}`
    );

    if (missingLogitsFallback) {
      return {
        scores,
        degraded: true,
        degradedReason: 'model response missing logits data',
      };
    }

    return { scores, degraded: false };
  } catch (error) {
    console.error('[RerankingService] Error computing scores:', error);
    // Return uniform scores on error (fallback), flagged as degraded so the
    // HTTP response can distinguish fallback output from real model scoring.
    return {
      scores: documents.map(() => 0.5),
      degraded: true,
      degradedReason: `Model inference failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// Hono App
// ============================================================================

// Exported for tests; importing this module never starts the server.
export const app = new Hono();

// Middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'reranking-service',
    model: currentModel ?? DEFAULT_MODEL,
    timestamp: new Date().toISOString(),
    metrics: getMetrics(),
  });
});

// Main reranking endpoint
app.post('/rerank', async (c) => {
  const requestStartTime = Date.now();

  try {
    const body = await c.req.json();
    const validation = RerankRequestSchema.safeParse(body);

    if (!validation.success) {
      recordError();
      const issues = validation.error.issues.map((issue: z.ZodIssue) => issue.message).join(', ');
      throw new HTTPException(400, {
        message: `Invalid request: ${issues}`,
      });
    }

    const { query, documents, model, quantized } = validation.data;

    // Limit document count to prevent abuse
    const MAX_DOCUMENTS = 100;
    if (documents.length > MAX_DOCUMENTS) {
      recordError();
      throw new HTTPException(400, {
        message: `Too many documents: ${documents.length} (max: ${MAX_DOCUMENTS})`,
      });
    }

    console.log(`[RerankingService] Reranking ${documents.length} documents with model: ${model}`);

    const result = await computeRerankScores(query, documents, model, quantized ?? true);

    const processingTimeMs = Date.now() - requestStartTime;
    recordCall(processingTimeMs);

    const response: RerankResponse = {
      scores: result.scores,
      model: model ?? DEFAULT_MODEL,
      processingTimeMs,
    };

    // Degradation fields are additive and set ONLY on the fallback path so
    // consumers can tell uniform-0.5 fallback output from real scoring.
    if (result.degraded) {
      response.degraded = true;
      if (result.degradedReason !== undefined) {
        response.degradedReason = result.degradedReason;
      }
    }

    return c.json(response);
  } catch (error) {
    recordError();
    if (error instanceof HTTPException) {
      throw error;
    }

    console.error('[RerankingService] Unexpected error:', error);
    throw new HTTPException(500, {
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

// Error handler
app.onError((err, c) => {
  console.error('[RerankingService] Error:', err);

  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  return c.json({ error: 'Internal server error' }, 500);
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// ============================================================================
// Server Startup
// ============================================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('  Cross-Encoder Reranking Service');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Port:    ${PORT}`);
console.log(`  Host:    ${HOST}`);
console.log(`  Model:   ${DEFAULT_MODEL}`);
console.log('═══════════════════════════════════════════════════════════');

console.log('');
console.log('  ✓ @huggingface/transformers is available');
console.log('');
console.log('  Endpoints:');
console.log(`    POST http://${HOST}:${PORT}/rerank`);
console.log(`    GET  http://${HOST}:${PORT}/health`);
console.log('');
console.log('  Starting server...');
console.log('');

// Start the server only when this file is the entrypoint so tests can
// import the Hono app without binding a port.
if (import.meta.main) {
  Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch: app.fetch,
  });
}
