#!/usr/bin/env bun
/**
 * @module verify-index
 * @description DEPRECATED compatibility shim for a legacy Convex-backed index check.
 *
 * This command is intentionally kept for discoverability only and now exits
 * non-zero to point callers to current verification commands.
 *
 * Replacement commands:
 * - `bun run verify` (Docs RAG live gate)
 * - `bun run verify:project`
 * - `bun run verify:project-rag:postgres`
 * - `bun run ragctl -- project verify --project <projectId>`
 */

const instructions = [
  'Use the current verification commands instead:',
  ' - bun run verify',
  ' - bun run verify:project',
  ' - bun run verify:project-rag:postgres',
  ' - bun run ragctl -- project verify --project <projectId>',
];

function main() {
  console.error('Deprecated: scripts/verify-index.ts is legacy Convex-backed verification.');
  console.error('The canonical verification paths are now Postgres/Docs-RAG based.');
  console.error('');
  for (const line of instructions) {
    console.error(line);
  }
  process.exit(2);
}

main();
