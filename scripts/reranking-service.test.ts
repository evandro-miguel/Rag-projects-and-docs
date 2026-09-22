/**
 * @module reranking-service.test
 * @description Unit tests for the /rerank honest-degradation contract
 * (T-02 hardening): the uniform-0.5 fallback path must expose
 * `degraded: true` + `degradedReason`, while the success path must not carry
 * those fields at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Configurable transformers stubs, hoisted so vi.mock can reference them.
const tf = vi.hoisted(() => ({
  fromPretrained: vi.fn(),
  tokenizerFactory: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  env: {},
  AutoTokenizer: { from_pretrained: tf.tokenizerFactory },
  AutoModelForSequenceClassification: { from_pretrained: tf.fromPretrained },
  // DataType is a type-only export at runtime usage sites.
}));

const { app } = await import('./reranking-service.js');

async function postRerank(documents = ['doc one', 'doc two']): Promise<Response> {
  const response = await app.request('/rerank', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'test query', documents }),
  });
  return response as Response;
}

describe('reranking service /rerank degradation signal', () => {
  // Single persistent invocable model stub: `getModel` caches the resolved
  // model at module level across tests in this file, so every test must share
  // the SAME function instance and switch its behavior instead of installing
  // a new one.
  const modelInvoke = vi.fn<(encoded: unknown) => Promise<unknown>>();
  const stubHealthyModel = () => {
    // logit 2 -> sigmoid(2) ~= 0.8808 for every document
    modelInvoke.mockImplementation(async () => ({ logits: { data: [2] } }));
    tf.fromPretrained.mockResolvedValue(modelInvoke);
  };

  beforeEach(() => {
    tf.fromPretrained.mockReset();
    tf.tokenizerFactory.mockReset();
  });

  it('does NOT set degraded fields on the success path', async () => {
    const tokenize = async () => ({ input_ids: [1, 2, 3] });
    tf.tokenizerFactory.mockResolvedValue(tokenize);
    stubHealthyModel();

    const response = await postRerank();
    expect(response.status).toBe(200);

    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.scores).toEqual([0.8807970779778823, 0.8807970779778823]);
    expect(payload.model).toBe('Xenova/ms-marco-MiniLM-L-6-v2');
    expect(typeof payload.processingTimeMs).toBe('number');
    expect(payload).not.toHaveProperty('degraded');
    expect(payload).not.toHaveProperty('degradedReason');
  });

  it('sets degraded:true and degradedReason when model inference fails', async () => {
    const tokenize = async () => ({ input_ids: [1, 2, 3] });
    tf.tokenizerFactory.mockResolvedValue(tokenize);
    // Cover both orders: cache hit (model invocation rejects) and cold start
    // (from_pretrained resolves to the same rejecting stub).
    stubHealthyModel();
    modelInvoke.mockRejectedValue(new Error('inference failed'));
    const response = await postRerank();
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      scores: number[];
      degraded?: boolean;
      degradedReason?: string;
      model: string;
      processingTimeMs: number;
    };
    // Uniform 0.5 fallback scores are preserved (no ranking change).
    expect(payload.scores).toEqual([0.5, 0.5]);
    expect(payload.degraded).toBe(true);
    expect(payload.degradedReason).toContain('Model inference failed');
    expect(payload.degradedReason).toContain('inference failed');
    // Existing fields stay intact.
    expect(payload.model).toBe('Xenova/ms-marco-MiniLM-L-6-v2');
    expect(typeof payload.processingTimeMs).toBe('number');
  });

  it('sets degraded:true and degradedReason when model output lacks logits data', async () => {
    const tokenize = async () => ({ input_ids: [1, 2, 3] });
    tf.tokenizerFactory.mockResolvedValue(tokenize);
    // Model resolves successfully but returns no usable logits: every document
    // falls back to uniform 0.5 and must be flagged as degraded.
    stubHealthyModel();
    modelInvoke.mockImplementation(async () => ({}));
    const response = await postRerank();
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      scores: number[];
      degraded?: boolean;
      degradedReason?: string;
      model: string;
      processingTimeMs: number;
    };
    expect(payload.scores).toEqual([0.5, 0.5]);
    expect(payload.degraded).toBe(true);
    expect(payload.degradedReason?.length ?? 0).toBeGreaterThan(0);
    // Existing fields stay intact.
    expect(payload.model).toBe('Xenova/ms-marco-MiniLM-L-6-v2');
    expect(typeof payload.processingTimeMs).toBe('number');
  });
});
