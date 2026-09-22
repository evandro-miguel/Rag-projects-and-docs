/**
 * @module search/scoring
 * @description Weighted Hybrid Search scoring algorithms and fusion configuration.
 *
 * This module provides the mathematical formulas for combining five scoring components:
 * 1. **Vector Score** (Semantic similarity from embeddings, 0-1)
 * 2. **Text Score** (Lexical match from BM25 proxy via rank decay)
 * 3. **Recency Score** (Temporal freshness based on document age)
 * 4. **Heat Score** (Popularity/access frequency signal)
 * 5. **KG Score** (Knowledge Graph relationship strength)
 *
 * The "secret formula" uses weighted fusion to balance these signals.
 *
 * TUNING (2026-03-15): Weights optimized for nDCG@10 and MRR:
 * - vectorWeight: 6.5 (increased from 6.0) - emphasize semantic relevance
 * - textWeight: 3.5 (decreased from 4.0) - rebalanced proportion
 * - recencyWeight: 0.12 (decreased from 0.15) - reduce temporal bias
 * - heatWeight: 0.9 (decreased from 1.0) - popularity slightly less dominant
 * - kgWeight: 1.2 (increased from 1.0) - boost knowledge graph
 * - textDecay: 5 (decreased from 6) - faster rank decay
 *
 * @example
 * // Calculate fused score for a result
 * import { applyWeightedFusion, calculateTextScore, calculateRecencyScore } from './scoring.js';
 *
 * const vectorScore = 0.85;  // From cosine similarity
 * const textScore = calculateTextScore(rank);  // From text search rank
 * const recencyScore = calculateRecencyScore(updatedAt);  // From document age
 *
 * const finalScore = applyWeightedFusion(vectorScore, textScore, recencyScore);
 */

/**
 * Configuration and utility functions for Weighted Hybrid Search Fusion.
 *
 * This module provides the mathematical formulas for combining:
 * 1. Vector Search Scores (Semantic)
 * 2. Text Search Ranks (Lexical/BM25 Proxy)
 * 3. Recency (Temporal Freshness)
 * 4. Heat (Popularity/Access Frequency)
 * 5. Knowledge Graph (Relationship Strength)
 */

export const FUSION_CONFIG = {
  // Weights (The "Secret Formula" weights)
  // TUNING (2026-03-15): Optimized for nDCG@10 and MRR improvement
  // Changes from previous tuning (2026-03-14):
  // - vectorWeight: 6.5 (increased from 6.0) - stronger semantic signal for top-result precision
  // - textWeight: 3.5 (decreased from 4.0) - rebalanced for vector emphasis
  // - recencyWeight: 0.12 (decreased from 0.15) - reduce temporal bias
  // - heatWeight: 0.9 (decreased from 1.0) - popularity slightly less dominant
  // - kgWeight: 1.2 (increased from 1.0) - boost knowledge graph for semantic relevance
  // - textDecay: 5 (decreased from 6) - faster decay for sharper rank distinction
  vectorWeight: 6.5,
  textWeight: 3.5,
  recencyWeight: 0.12,
  heatWeight: 0.9,
  kgWeight: 1.2,

  // Decay constants
  textDecay: 5, // exp(-rank / textDecay) - faster decay for sharper ranking
  recencyLambda: 0.01, // 1 / (1 + lambda * ageDays)

  // Similarity threshold for filtering low-relevance results
  // Maintained at 0.25 for good recall/quality balance
  similarityThreshold: 0.25,
};

/**
 * Tag match boost for filtered results.
 *
 * When tag filtering is applied, results that match the include tags
 * receive a percentage boost to their final score. This rewards
 * documents that strongly match the requested tag criteria.
 *
 * **Formula**: `finalScore *= (1 + TAG_MATCH_BOOST * matchingTagCount)`
 *
 * @example
 * // Result with 2 matching tags gets 40% boost
 * const boostedScore = baseScore * (1 + TAG_MATCH_BOOST * 2);
 */
export const TAG_MATCH_BOOST = 0.2; // 20% boost per matching tag

/**
 * Apply tag match boost to a score.
 *
 * Calculates the boosted score based on the number of matching tags.
 * The boost is multiplicative and compounds with multiple matches.
 *
 * @param baseScore - The original score to boost
 * @param matchingTagCount - Number of tags that matched the filter
 * @param boostPerTag - Boost percentage per tag (default: TAG_MATCH_BOOST)
 * @returns Boosted score
 *
 * @example
 * const boosted = applyTagBoost(10.0, 2); // Returns: 14.0 (40% boost)
 */
export function applyTagBoost(
  baseScore: number,
  matchingTagCount: number,
  boostPerTag: number = TAG_MATCH_BOOST
): number {
  if (matchingTagCount <= 0) return baseScore;
  return baseScore * (1 + boostPerTag * matchingTagCount);
}

/**
 * Get the similarity threshold from environment variable or use default.
 *
 * Allows runtime configuration via SIMILARITY_THRESHOLD env var.
 * Falls back to FUSION_CONFIG.similarityThreshold (0.3) if not set.
 *
 * @returns The similarity threshold value (0-1 range)
 *
 * @example
 * // Set via environment
 * // SIMILARITY_THRESHOLD=0.4
 * getSimilarityThreshold(); // Returns 0.4
 */
export function getSimilarityThreshold(): number {
  const envThreshold = process.env.SIMILARITY_THRESHOLD;
  if (envThreshold !== undefined && envThreshold !== '') {
    const parsed = Number.parseFloat(envThreshold);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
    console.warn(
      `Invalid SIMILARITY_THRESHOLD value: "${envThreshold}". Using default ${FUSION_CONFIG.similarityThreshold}`
    );
  }
  return FUSION_CONFIG.similarityThreshold;
}

/**
 * Alternative weights when vector search is disabled (e.g. no Gemini key).
 *
 * When embeddings are unavailable, this configuration:
 * - Sets vector weight to 0 (disabled)
 * - Boosts text weight to 8.0 to compensate (adjusted from 9.0 for consistency)
 * - Keeps other weights aligned with FUSION_CONFIG
 */
export const FALLBACK_FUSION_CONFIG = {
  ...FUSION_CONFIG,
  vectorWeight: 0.0,
  textWeight: 8.0, // Boost text weight to compensate
};

/**
 * Calculate a proxy for BM25 score using exponential decay on rank.
 *
 * Since the text-search backend does not provide true BM25 scores, we approximate
 * relevance using rank position with exponential decay. Higher-ranked results
 * (lower rank numbers) receive higher scores.
 *
 * **Formula**: `score = exp(-rank / decay)`
 *
 * **Examples** (with decay=5):
 * - Rank 0 (best) → 1.0
 * - Rank 8 → ~0.20
 * - Rank 20 → ~0.02
 *
 * @param rank - Position in search results (0 = best match)
 * @param decay - Decay constant controlling score drop-off (default: 5 from FUSION_CONFIG)
 *
 * @returns Score between 0 and 1, where 1 is best possible relevance
 *
 * @example
 * // Top result gets perfect score
 * const topScore = calculateTextScore(0); // Returns: 1.0
 *
 * @example
 * // 10th result gets moderate score
 * const tenthScore = calculateTextScore(10); // Returns: ~0.14
 */
export function calculateTextScore(rank: number, decay = FUSION_CONFIG.textDecay): number {
  return Math.exp(-rank / decay);
}

/**
 * Calculate recency score based on document age.
 *
 * Implements temporal decay to favor recently updated documents.
 * Uses inverse relationship: newer documents score higher, older documents decay.
 *
 * **Formula**: `score = 1 / (1 + λ * ageDays)`
 *
 * **Examples**:
 * - Today (0 days) → 1.0
 * - 100 days ago → ~0.5
 * - 365 days ago → ~0.21
 *
 * @param updatedAt - Document update timestamp (milliseconds since epoch)
 * @param now - Current timestamp for age calculation (default: Date.now())
 * @param lambda - Decay rate constant (default: 0.01 from FUSION_CONFIG)
 *                 Higher lambda = faster decay (older docs penalized more)
 *
 * @returns Score between 0 and 1, where 1 is most recent
 *
 * @example
 * // Fresh document (updated today)
 * const freshScore = calculateRecencyScore(Date.now()); // Returns: 1.0
 *
 * @example
 * // Old document (updated 1 year ago)
 * const oldTimestamp = Date.now() - (365 * 24 * 60 * 60 * 1000);
 * const oldScore = calculateRecencyScore(oldTimestamp); // Returns: ~0.21
 */
export function calculateRecencyScore(
  updatedAt: number,
  now = Date.now(),
  lambda = FUSION_CONFIG.recencyLambda
): number {
  const ageMs = Math.max(0, now - updatedAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return 1 / (1 + lambda * ageDays);
}

/**
 * Clamp a value between min and max (inclusive).
 *
 * Utility function to ensure scores stay within valid range [0, 1].
 *
 * @param val - Value to clamp
 * @param min - Minimum bound
 * @param max - Maximum bound
 *
 * @returns Clamped value within [min, max] range
 *
 * @example
 * clamp(0.5, 0, 1); // Returns: 0.5
 * clamp(1.5, 0, 1); // Returns: 1
 * clamp(-0.2, 0, 1); // Returns: 0
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Combine normalized scores into a single final score using weighted fusion.
 *
 * This is the core "secret formula" that merges five scoring signals:
 * - Vector similarity (semantic meaning)
 * - Text match (lexical relevance)
 * - Recency (temporal freshness)
 * - Heat (popularity/access frequency)
 * - Knowledge Graph (relationship strength)
 *
 * **Formula**: `finalScore = v*V + t*T + r*R + h*H + k*K`
 *
 * Where (as of 2026-03-15 tuning):
 * - V = vectorScore × vectorWeight (typically 6.5)
 * - T = textScore × textWeight (typically 3.5)
 * - R = recencyScore × recencyWeight (typically 0.12)
 * - H = heatScore × heatWeight (typically 0.9)
 * - K = kgScore × kgWeight (typically 1.2)
 *
 * All input scores are clamped to [0, 1] before weighting.
 *
 * @param vectorScore - Cosine similarity score from vector search (0-1)
 * @param textScore - BM25 proxy score from text search rank (0-1)
 * @param recencyScore - Temporal freshness score based on document age (0-1)
 * @param heatScore - Popularity/access frequency score (0-1)
 * @param kgScore - Knowledge Graph relationship strength score (0-1)
 * @param cfg - Fusion configuration with weights and decay constants
 *
 * @returns Final fused score (unbounded, typically 0-13 range)
 *
 * @example
 * // Perfect scores on all components
 * const perfect = applyWeightedFusion(1.0, 1.0, 1.0, 1.0, 1.0);
 * // Returns: 6.5 + 3.5 + 0.12 + 0.9 + 1.2 = 12.22
 *
 * @example
 * // Strong vector match, weak text match
 * const result = applyWeightedFusion(0.9, 0.3, 0.8, 0.5, 0.2);
 * // Returns: (0.9×6.5) + (0.3×3.5) + (0.8×0.12) + (0.5×0.9) + (0.2×1.2)
 * //         = 5.85 + 1.05 + 0.096 + 0.45 + 0.24 = 7.686
 */
export function applyWeightedFusion(
  vectorScore: number,
  textScore: number,
  recencyScore: number,
  heatScore = 0,
  kgScore = 0,
  cfg = FUSION_CONFIG
): number {
  // We assume vectorScore is already normalized (0-1) from cosine similarity
  const v = clamp(vectorScore, 0, 1);
  const t = clamp(textScore, 0, 1);
  const r = clamp(recencyScore, 0, 1);
  const h = clamp(heatScore, 0, 1);
  const k = clamp(kgScore, 0, 1);

  return (
    v * cfg.vectorWeight +
    t * cfg.textWeight +
    r * cfg.recencyWeight +
    h * cfg.heatWeight +
    k * cfg.kgWeight
  );
}
