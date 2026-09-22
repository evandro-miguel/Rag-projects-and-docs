#!/usr/bin/env bun
/**
 * @module verify-vector-index-dimensions
 * @description Retired legacy Convex vector-index dimension verifier.
 */

console.error(
  [
    'scripts/verify-vector-index-dimensions.ts is retired.',
    'Use `bun run health:embeddings` to verify the embedding provider.',
    'Use `bun run verify:project-rag:postgres` to verify Project RAG Postgres indexes.',
  ].join('\n')
);

process.exitCode = 1;

export {};
