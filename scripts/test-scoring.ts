/**
 * @module test-scoring
 * @description Scoring algorithm testing for weighted fusion logic.
 *
 * This script tests the weighted fusion scoring algorithm used in hybrid search.
 * It validates the combination of:
 * - Vector similarity scores (cosine similarity)
 * - Text match scores (exponential decay by rank)
 * - Recency scores (temporal decay based on document age)
 *
 * **Purpose:**
 * - Validate scoring algorithm correctness
 * - Test edge cases in fusion logic
 * - Understand score component contributions
 * - Debug ranking issues
 *
 * **When to run:**
 * - After modifying scoring weights
 * - When debugging search ranking issues
 * - During scoring algorithm development
 *
 * **Dependencies:**
 * - lib/search/scoring module (imported from project)
 *
 * **Test Cases:**
 * 1. **Semantic vs Exact Keyword**: Compares strong semantic match with weak
 *    keyword match against moderate semantic with strong keyword match
 * 2. **Recency Tie-breaker**: Tests how freshness affects scoring when
 *    semantic and text scores are identical
 * 3. **Component Scales**: Shows the range of each scoring component
 *
 * **Scoring Components:**
 * - Vector Score: 0-1 cosine similarity
 * - Text Score: Exponential decay based on BM25 rank
 * - Recency Score: Temporal decay (newer = higher score)
 *
 * **Output:**
 * - Score comparisons for each test case
 * - Winner determination
 * - Component value ranges
 *
 * @example
 * // Run scoring tests
 * bun run scripts/test-scoring.ts
 *
 * @see eval-retrieval.ts - End-to-end retrieval evaluation
 * @see search.ts - Manual search testing
 * @see lib/search/scoring.ts - Scoring implementation
 */

import {
  applyWeightedFusion,
  calculateRecencyScore,
  calculateTextScore,
} from '../lib/search/scoring.js';

/**
 * Run scoring algorithm tests.
 *
 * Executes three test scenarios:
 * 1. Semantic match vs exact keyword match
 * 2. Recency tie-breaker
 * 3. Component scale analysis
 *
 * @returns {void} This function logs results to console
 *
 * @example
 * // Run all scoring tests
 * testScoring();
 */
function testScoring() {
  console.log('🧪 Testing Weighted Fusion Logic...\n');

  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;

  // Test Case 1: Exact keyword match vs Semantic match
  // Chunk A: Strong semantic (0.9), Weak keyword (Rank 10)
  // Chunk B: Moderate semantic (0.7), Strong keyword (Rank 0)

  const vScoreA = 0.9;
  const tRankA = 10;
  const rScoreA = calculateRecencyScore(now - 30 * dayMs); // 30 days old

  const vScoreB = 0.7;
  const tRankB = 0;
  const rScoreB = calculateRecencyScore(now - 30 * dayMs); // 30 days old

  const scoreA = applyWeightedFusion(vScoreA, calculateTextScore(tRankA), rScoreA);
  const scoreB = applyWeightedFusion(vScoreB, calculateTextScore(tRankB), rScoreB);

  console.log('Case 1: Semantic (A) vs Exact Keyword (B)');
  console.log(`- Score A (0.9 semantic, rank 10): ${scoreA.toFixed(4)}`);
  console.log(`- Score B (0.7 semantic, rank 0): ${scoreB.toFixed(4)}`);
  console.log(`Winner: ${scoreA > scoreB ? 'A (Semantic)' : 'B (Exact Match)'}`);
  console.log('');

  // Test Case 2: Freshness Tie-breaker
  // Two identical semantic/keyword matches, but one is newer
  const vScoreC = 0.8;
  const tScoreC = calculateTextScore(2);
  const rScoreC_new = calculateRecencyScore(now); // Today
  const rScoreC_old = calculateRecencyScore(now - 365 * dayMs); // 1 year ago

  const scoreNew = applyWeightedFusion(vScoreC, tScoreC, rScoreC_new);
  const scoreOld = applyWeightedFusion(vScoreC, tScoreC, rScoreC_old);

  console.log('Case 2: Recency Tie-breaker');
  console.log(`- Score New (Today): ${scoreNew.toFixed(4)}`);
  console.log(`- Score Old (1 year): ${scoreOld.toFixed(4)}`);
  console.log(`Difference: ${(scoreNew - scoreOld).toFixed(4)}`);
  console.log('');

  // Test Case 3: Scales
  console.log('Component Ranges:');
  console.log(`- Text Score Rank 0: ${calculateTextScore(0).toFixed(4)}`);
  console.log(`- Text Score Rank 8: ${calculateTextScore(8).toFixed(4)}`);
  console.log(`- Text Score Rank 20: ${calculateTextScore(20).toFixed(4)}`);
  console.log(`- Recency Today: ${calculateRecencyScore(now).toFixed(4)}`);
  console.log(`- Recency 100 days: ${calculateRecencyScore(now - 100 * dayMs).toFixed(4)}`);
}

testScoring();
