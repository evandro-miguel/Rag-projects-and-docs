import { describe, expect, it } from 'vitest';
import {
  BLOCK_THRESHOLDS,
  DEFAULT_PROJECT_THRESHOLDS,
  DEFAULT_THRESHOLDS,
  DOCS_ANSWER_QUALITY_THRESHOLDS,
  DOCS_RETRIEVAL_THRESHOLDS,
  MCP_HANDLER_PERFORMANCE_THRESHOLDS,
  MCP_RUNTIME_PERFORMANCE_THRESHOLDS,
  MCP_TOOL_CATEGORIES,
  MINIMUM_PROJECT_THRESHOLDS,
  PROJECT_EVAL_THRESHOLD_PROFILES,
  STRETCH_PROJECT_THRESHOLDS,
  STRICT_THRESHOLDS,
} from './thresholds.js';

describe('search threshold registry', () => {
  it('keeps docs retrieval profiles monotonic', () => {
    expect(DOCS_RETRIEVAL_THRESHOLDS.minimum.hitRate).toBeLessThanOrEqual(
      DOCS_RETRIEVAL_THRESHOLDS.target.hitRate ?? 0
    );
    expect(DOCS_RETRIEVAL_THRESHOLDS.target.hitRate).toBeLessThanOrEqual(
      DOCS_RETRIEVAL_THRESHOLDS.stretch.hitRate ?? 0
    );
    expect(DOCS_RETRIEVAL_THRESHOLDS.minimum.ndcg).toBeLessThanOrEqual(
      DOCS_RETRIEVAL_THRESHOLDS.target.ndcg ?? 0
    );
    expect(DOCS_RETRIEVAL_THRESHOLDS.target.ndcg).toBeLessThanOrEqual(
      DOCS_RETRIEVAL_THRESHOLDS.stretch.ndcg ?? 0
    );
    expect(DOCS_RETRIEVAL_THRESHOLDS.minimum.mrr).toBeLessThanOrEqual(
      DOCS_RETRIEVAL_THRESHOLDS.target.mrr ?? 0
    );
    expect(DOCS_RETRIEVAL_THRESHOLDS.target.mrr).toBeLessThanOrEqual(
      DOCS_RETRIEVAL_THRESHOLDS.stretch.mrr ?? 0
    );
    expect(DOCS_RETRIEVAL_THRESHOLDS.minimum.latency_p95).toBeGreaterThanOrEqual(
      DOCS_RETRIEVAL_THRESHOLDS.target.latency_p95 ?? 0
    );
    expect(DOCS_RETRIEVAL_THRESHOLDS.target.latency_p95).toBeGreaterThanOrEqual(
      DOCS_RETRIEVAL_THRESHOLDS.stretch.latency_p95 ?? 0
    );
  });

  it('keeps docs answer-quality profiles monotonic', () => {
    expect(DOCS_ANSWER_QUALITY_THRESHOLDS.minimum.context_precision).toBeLessThanOrEqual(
      DOCS_ANSWER_QUALITY_THRESHOLDS.target.context_precision
    );
    expect(DOCS_ANSWER_QUALITY_THRESHOLDS.target.context_precision).toBeLessThanOrEqual(
      DOCS_ANSWER_QUALITY_THRESHOLDS.stretch.context_precision
    );
    expect(DOCS_ANSWER_QUALITY_THRESHOLDS.minimum.faithfulness).toBeLessThanOrEqual(
      DOCS_ANSWER_QUALITY_THRESHOLDS.target.faithfulness
    );
    expect(DOCS_ANSWER_QUALITY_THRESHOLDS.target.faithfulness).toBeLessThanOrEqual(
      DOCS_ANSWER_QUALITY_THRESHOLDS.stretch.faithfulness
    );
  });

  it('keeps project profiles monotonic', () => {
    expect(MINIMUM_PROJECT_THRESHOLDS.hitRate).toBeLessThanOrEqual(
      DEFAULT_PROJECT_THRESHOLDS.hitRate
    );
    expect(DEFAULT_PROJECT_THRESHOLDS.hitRate).toBeLessThanOrEqual(
      STRETCH_PROJECT_THRESHOLDS.hitRate
    );
    expect(MINIMUM_PROJECT_THRESHOLDS.exactPathRate).toBeLessThanOrEqual(
      DEFAULT_PROJECT_THRESHOLDS.exactPathRate
    );
    expect(DEFAULT_PROJECT_THRESHOLDS.exactPathRate).toBeLessThanOrEqual(
      STRETCH_PROJECT_THRESHOLDS.exactPathRate
    );
    expect(MINIMUM_PROJECT_THRESHOLDS.maxContaminationRate).toBeGreaterThanOrEqual(
      DEFAULT_PROJECT_THRESHOLDS.maxContaminationRate
    );
    expect(DEFAULT_PROJECT_THRESHOLDS.maxContaminationRate).toBeGreaterThanOrEqual(
      STRETCH_PROJECT_THRESHOLDS.maxContaminationRate
    );
    expect(MINIMUM_PROJECT_THRESHOLDS.latencyP95Ms).toBeGreaterThanOrEqual(
      DEFAULT_PROJECT_THRESHOLDS.latencyP95Ms
    );
    expect(DEFAULT_PROJECT_THRESHOLDS.latencyP95Ms).toBeGreaterThanOrEqual(
      STRETCH_PROJECT_THRESHOLDS.latencyP95Ms
    );
  });

  it('aliases default docs and project thresholds to the canonical target profile', () => {
    expect(BLOCK_THRESHOLDS).toEqual(DOCS_RETRIEVAL_THRESHOLDS.minimum);
    expect(DEFAULT_THRESHOLDS).toEqual(DOCS_RETRIEVAL_THRESHOLDS.target);
    expect(STRICT_THRESHOLDS).toEqual(DOCS_RETRIEVAL_THRESHOLDS.stretch);
    expect(DEFAULT_PROJECT_THRESHOLDS).toEqual(PROJECT_EVAL_THRESHOLD_PROFILES.target);
  });

  it('keeps local handler budgets stricter than live runtime budgets', () => {
    for (const category of Object.keys(MCP_RUNTIME_PERFORMANCE_THRESHOLDS) as Array<
      keyof typeof MCP_RUNTIME_PERFORMANCE_THRESHOLDS
    >) {
      expect(MCP_HANDLER_PERFORMANCE_THRESHOLDS[category].p50).toBeLessThanOrEqual(
        MCP_RUNTIME_PERFORMANCE_THRESHOLDS[category].p50
      );
      expect(MCP_HANDLER_PERFORMANCE_THRESHOLDS[category].p95).toBeLessThanOrEqual(
        MCP_RUNTIME_PERFORMANCE_THRESHOLDS[category].p95
      );
      expect(MCP_HANDLER_PERFORMANCE_THRESHOLDS[category].p99).toBeLessThanOrEqual(
        MCP_RUNTIME_PERFORMANCE_THRESHOLDS[category].p99
      );
    }
  });

  it('maps all known tool categories to valid latency buckets', () => {
    for (const category of Object.values(MCP_TOOL_CATEGORIES)) {
      expect(MCP_RUNTIME_PERFORMANCE_THRESHOLDS[category]).toBeDefined();
      expect(MCP_HANDLER_PERFORMANCE_THRESHOLDS[category]).toBeDefined();
    }
  });
});
