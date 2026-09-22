/**
 * Compatibility stub for the retired direct Convex RAG health CLI.
 * Usage: bun x tsx scripts/test-rag-health.ts
 */

export {};

function main(): never {
  console.error(
    [
      'Deprecated: scripts/test-rag-health.ts has been retired.',
      'This legacy helper depended on direct Convex health checks and no longer runs.',
      'Use the supported Postgres-first health commands instead:',
      '  ./bin/ragctl health --json',
      '  ./bin/ragctl project verify --project <project> --json',
      '  bun run health:docs-rag -- --strict',
      '  bun run verify:docs-rag-live',
    ].join('\n')
  );
  process.exit(1);
}

main();
