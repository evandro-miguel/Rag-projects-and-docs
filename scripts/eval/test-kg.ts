/**
 * Compatibility stub for the retired direct Convex KG eval helper.
 * Usage: bun x tsx scripts/eval/test-kg.ts
 */

export {};

function main(): never {
  console.error(
    [
      'Deprecated: scripts/eval/test-kg.ts has been retired.',
      'This legacy helper depended on direct Convex KG queries and no longer runs.',
      'Use the supported Postgres-first Project RAG flow instead:',
      '  ./bin/ragctl project search --project <project> <query> --json',
      '  ./bin/ragctl project verify --project <project> --json',
      '  bun run eval:project-rag',
    ].join('\n')
  );
  process.exit(1);
}

main();
