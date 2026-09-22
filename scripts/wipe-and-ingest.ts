/**
 * @module wipe-and-ingest
 * @description Deprecated compatibility wrapper for a removed destructive reset flow.
 *
 * This command is intentionally disabled. Use `bun run sync:external` for
 * normal external Docs RAG syncs. No Convex-free destructive reset command
 * exists yet.
 */

const message = [
  '`scripts/wipe-and-ingest.ts` is deprecated and intentionally disabled.',
  'Use `bun run sync:external` for normal external Docs RAG syncs.',
  'No Convex-free destructive reset command exists yet.',
].join('\n');

export {};

function main(): never {
  // ponytail: keep the legacy entrypoint as a fail-fast stub until a real reset exists.
  console.error(message);
  process.exit(1);
}

main();
