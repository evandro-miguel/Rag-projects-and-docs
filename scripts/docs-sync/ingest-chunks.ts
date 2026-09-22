/**
 * @module ingest-chunks
 * @description Retired legacy Convex-backed external docs ingestion phase.
 *
 * Use `bun run sync:external` for Docs RAG Postgres ingestion.
 */

console.error(
  [
    'scripts/docs-sync/ingest-chunks.ts is retired.',
    'Use `bun run sync:external` for Docs RAG Postgres ingestion.',
    'No legacy Convex docs-sync ingest-chunks command exists anymore.',
  ].join('\n')
);

process.exitCode = 1;

export {};
