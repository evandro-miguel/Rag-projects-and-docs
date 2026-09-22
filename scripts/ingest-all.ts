/**
 * @module ingest-all
 * @description Deprecated fail-fast compatibility stub for the retired full external-docs ingest command.
 *
 * Use `bun run sync:external` for external Docs RAG syncs.
 * No legacy Convex full-ingest command exists anymore.
 */

// ponytail: keep the filename as a stub until remaining legacy references are removed, then delete it.
const message = [
  'scripts/ingest-all.ts is deprecated and no longer runs ingestion.',
  'Use `bun run sync:external` for external Docs RAG syncs.',
  'No legacy Convex full-ingest command exists anymore.',
].join('\n');

console.error(message);
process.exit(1);
