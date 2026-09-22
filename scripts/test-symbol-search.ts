/**
 * Compatibility stub for the retired direct Convex symbol-search smoke.
 * Usage: bun x tsx scripts/test-symbol-search.ts
 */

export {};

function main(): never {
  console.error(
    [
      'Deprecated: scripts/test-symbol-search.ts has been retired.',
      'Direct Convex symbol-search smoke tests are no longer supported.',
      'Use the supported Postgres Project RAG search instead:',
      '  ./bin/ragctl project search --project <project> <query> --json',
    ].join('\n')
  );
  process.exit(1);
}

main();
