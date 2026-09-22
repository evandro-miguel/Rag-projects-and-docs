/**
 * @module test-ingest
 * @description Retired legacy Convex-backed ingestion smoke.
 */

console.error(
  [
    'scripts/test-ingest.ts is retired.',
    'Use `bun run sync:external` to sync external docs.',
    'Use `bun run health:docs-rag` to check Docs RAG freshness.',
    'Use `bun run verify:docs-rag-live` to verify live Docs RAG retrieval.',
  ].join('\n')
);

process.exitCode = 1;

export {};
