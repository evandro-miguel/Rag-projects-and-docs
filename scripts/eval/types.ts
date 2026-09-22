/**
 * @module eval/types
 * @description Type definitions for the RAG evaluation framework.
 *
 * Defines all types used for evaluation metrics, test queries,
 * and baseline data structures.
 */

import type { ThresholdConfig } from './thresholds.js';
import {
  BLOCK_THRESHOLDS as CANONICAL_BLOCK_THRESHOLDS,
  DEFAULT_THRESHOLDS as CANONICAL_DEFAULT_THRESHOLDS,
} from './thresholds.js';

/**
 * Single evaluation query with ground truth.
 */
export interface EvalQuery {
  /** Unique identifier */
  id: string;
  /** Natural language query */
  query: string;
  /** Expected answer/ground truth */
  expectedAnswer: string;
  /** Keywords that should appear in relevant context */
  expectedKeywords: string[];
  /** Document paths that contain relevant information */
  expectedDocPaths: string[];
  /** Category for grouping (optional) */
  category?: string;
  /** Difficulty level (affects scoring expectations) */
  difficulty?: 'easy' | 'medium' | 'hard';
}

/**
 * Result of a single query evaluation.
 */
export interface QueryEvalResult {
  queryId: string;
  query: string;
  /** Retrieved contexts */
  contexts: string[];
  /** Ordered document paths used for stable ranking comparisons */
  resultSources?: string[];
  /** Number of contexts retrieved */
  contextCount: number;
  /** Whether expected docs were found in results */
  foundExpectedDocs: boolean;
  /** Rank of first expected doc (1-based, 0 if not found) */
  firstExpectedDocRank: number;
  /** Relevance scores for each context */
  relevanceScores: number[];
  /** nDCG@10 score for this query */
  ndcgScore: number;
  /** MRR score (1/rank of first relevant, 0 if none) */
  mrrScore: number;
  /** Execution latency in ms */
  latencyMs: number;
}

/**
 * Comprehensive evaluation metrics (Retrieval-Only).
 */
export interface EvalMetrics {
  /** Hit Rate (Recall@K) - percentage of queries where expected doc was found */
  hitRate: number;
  /** nDCG@10 - normalized discounted cumulative gain */
  'nDCG@10': number;
  /** MRR - mean reciprocal rank */
  MRR: number;
  /** Ragas retrieval metric: relevant context precision */
  context_precision?: number;
  /** Ragas retrieval metric: relevant context recall */
  context_recall?: number;
  /** Ragas grounding metric: answer faithfulness to retrieved evidence */
  faithfulness?: number;
  /** Ragas answer metric: correctness against the expected answer */
  answer_correctness?: number;
  /** Ragas answer metric: relevance to the user intent/question */
  answer_relevancy?: number;
  /** Latency p95 - 95th percentile response time in seconds */
  latency_p95?: number;
}

/**
 * Complete baseline or evaluation result.
 */
export interface EvalBaseline {
  /** ISO timestamp when captured */
  captured_at: string;
  /** All computed metrics */
  metrics: EvalMetrics;
  /** Number of queries evaluated */
  query_count: number;
  /** Embedding model used */
  model: string;
  /** Number of queries that failed relevance expectations */
  failed_query_count?: number;
  /** Number of queries that failed by execution error */
  error_query_count?: number;
  /** Optional: individual query results for debugging */
  query_results?: QueryEvalResult[];
  /** Optional: git commit hash */
  commit_hash?: string;
}

export type { ThresholdConfig } from './thresholds.js';

/**
 * BLOCK thresholds - used for CI gate enforcement.
 * Fails the build if any of these are not met.
 */
export const BLOCK_THRESHOLDS: ThresholdConfig = {
  ...CANONICAL_BLOCK_THRESHOLDS,
};

/**
 * Default threshold configuration.
 */
export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  ...CANONICAL_DEFAULT_THRESHOLDS,
};
