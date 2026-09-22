/**
 * Compatibility stub for the retired direct Convex type-symbol analysis CLI.
 * Usage: bun x tsx scripts/analyze-type-symbols.ts
 */

export {};

function main(): never {
  console.error(
    [
      'Deprecated: scripts/analyze-type-symbols.ts has been retired.',
      'This legacy helper depended on direct Convex Project RAG queries and no longer runs.',
      'Use the supported Postgres-first Project RAG search/inspection flow instead:',
      "  ./bin/ragctl project search --project <project> ': any' --json",
      '  ./bin/ragctl project verify --project <project> --json',
    ].join('\n')
  );
  process.exit(1);
}

main();
