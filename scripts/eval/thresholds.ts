import type { ProjectEvalThresholds } from './project-rag/types.js';

export type EvalThresholdProfile = 'minimum' | 'target' | 'stretch';

export interface ThresholdConfig {
  hitRate?: number;
  ndcg?: number;
  mrr?: number;
  latency_p95?: number;
}

export interface DocsAnswerQualityThresholds {
  context_precision: number;
  context_recall: number;
  faithfulness: number;
  answer_correctness: number;
  answer_relevancy: number;
}

export interface ToolPerformanceThreshold {
  p50: number;
  p95: number;
  p99: number;
  maxMemoryMB: number;
}

export type McpToolCategory = 'search' | 'ingestion' | 'system' | 'analysis' | 'enhancement';

export const DOCS_RETRIEVAL_THRESHOLDS: Record<EvalThresholdProfile, ThresholdConfig> = {
  minimum: {
    hitRate: 0.85,
    ndcg: 0.8,
    mrr: 0.75,
    latency_p95: 2.0,
  },
  target: {
    hitRate: 0.9,
    ndcg: 0.85,
    mrr: 0.8,
    latency_p95: 1.5,
  },
  stretch: {
    hitRate: 0.93,
    ndcg: 0.88,
    mrr: 0.84,
    latency_p95: 1.2,
  },
};

/**
 * Grounding and answer-quality targets based on the metric families defined by
 * Ragas. These are not enforced by the current lightweight retrieval runner yet,
 * but they provide the canonical targets for live evaluation and future suites.
 */
export const DOCS_ANSWER_QUALITY_THRESHOLDS: Record<
  EvalThresholdProfile,
  DocsAnswerQualityThresholds
> = {
  minimum: {
    context_precision: 0.75,
    context_recall: 0.8,
    faithfulness: 0.85,
    answer_correctness: 0.7,
    answer_relevancy: 0.8,
  },
  target: {
    context_precision: 0.8,
    context_recall: 0.85,
    faithfulness: 0.9,
    answer_correctness: 0.75,
    answer_relevancy: 0.85,
  },
  stretch: {
    context_precision: 0.85,
    context_recall: 0.9,
    faithfulness: 0.93,
    answer_correctness: 0.82,
    answer_relevancy: 0.88,
  },
};

export const PROJECT_EVAL_THRESHOLD_PROFILES: Record<EvalThresholdProfile, ProjectEvalThresholds> =
  {
    minimum: {
      hitRate: 0.8,
      exactPathRate: 0.8,
      exactSymbolRate: 0.65,
      exactLineRate: 0.55,
      mrr: 0.65,
      ndcgAt10: 0.7,
      avgQualityScore: 0.72,
      maxContaminationRate: 0.05,
      latencyP95Ms: 1800,
    },
    target: {
      hitRate: 0.88,
      exactPathRate: 0.85,
      exactSymbolRate: 0.75,
      exactLineRate: 0.65,
      mrr: 0.75,
      ndcgAt10: 0.8,
      avgQualityScore: 0.8,
      maxContaminationRate: 0.02,
      latencyP95Ms: 1550,
    },
    stretch: {
      hitRate: 0.92,
      exactPathRate: 0.9,
      exactSymbolRate: 0.82,
      exactLineRate: 0.72,
      mrr: 0.82,
      ndcgAt10: 0.86,
      avgQualityScore: 0.86,
      maxContaminationRate: 0,
      latencyP95Ms: 900,
    },
  };

/**
 * Live MCP runtime budgets. These include Postgres, local service, and any
 * embedding/LLM work where relevant.
 */
export const MCP_RUNTIME_PERFORMANCE_THRESHOLDS: Record<McpToolCategory, ToolPerformanceThreshold> =
  {
    search: {
      p50: 600,
      p95: 1500,
      p99: 2500,
      maxMemoryMB: 150,
    },
    ingestion: {
      p50: 1500,
      p95: 5000,
      p99: 8000,
      maxMemoryMB: 300,
    },
    system: {
      p50: 50,
      p95: 250,
      p99: 500,
      maxMemoryMB: 75,
    },
    analysis: {
      p50: 150,
      p95: 600,
      p99: 1200,
      maxMemoryMB: 150,
    },
    enhancement: {
      p50: 2000,
      p95: 5000,
      p99: 8000,
      maxMemoryMB: 200,
    },
  };

/**
 * End-to-end MCP STDIO concurrency budgets. These include one server process
 * per worker and contention on the shared embedding and Postgres services, so
 * they are intentionally distinct from the single-call tool budgets above.
 */
export const MCP_CONCURRENCY_P95_THRESHOLDS = {
  standard: 1_750,
  releaseConcurrency10: 6_000,
} as const;

/**
 * Local handler budgets for deterministic tests. These are intentionally
 * stricter than runtime budgets because they run without live network latency.
 */
export const MCP_HANDLER_PERFORMANCE_THRESHOLDS: Record<McpToolCategory, ToolPerformanceThreshold> =
  {
    search: {
      p50: 200,
      p95: 500,
      p99: 1000,
      maxMemoryMB: 100,
    },
    ingestion: {
      p50: 500,
      p95: 3000,
      p99: 5000,
      maxMemoryMB: 200,
    },
    system: {
      p50: 20,
      p95: 100,
      p99: 200,
      maxMemoryMB: 50,
    },
    analysis: {
      p50: 50,
      p95: 200,
      p99: 500,
      maxMemoryMB: 100,
    },
    enhancement: {
      p50: 1000,
      p95: 3000,
      p99: 5000,
      maxMemoryMB: 150,
    },
  };

export const MCP_TOOL_CATEGORIES = {
  search_docs: 'search',
  get_document: 'search',
  list_categories: 'system',
  ingest_project: 'ingestion',
  ingest_project_file: 'ingestion',
  search_project_docs: 'search',
  search_project_code: 'search',
  get_project_file: 'search',
  get_project_outline: 'search',
  register_project: 'ingestion',
  verify_project_index: 'analysis',
  health_check: 'system',
  adapt_docs: 'enhancement',
} as const satisfies Record<string, McpToolCategory>;

export const BLOCK_THRESHOLDS = DOCS_RETRIEVAL_THRESHOLDS.minimum;
export const DEFAULT_THRESHOLDS = DOCS_RETRIEVAL_THRESHOLDS.target;
export const STRICT_THRESHOLDS = DOCS_RETRIEVAL_THRESHOLDS.stretch;

export const DEFAULT_PROJECT_THRESHOLDS = PROJECT_EVAL_THRESHOLD_PROFILES.target;
export const MINIMUM_PROJECT_THRESHOLDS = PROJECT_EVAL_THRESHOLD_PROFILES.minimum;
export const STRETCH_PROJECT_THRESHOLDS = PROJECT_EVAL_THRESHOLD_PROFILES.stretch;
