/**
 * Compatibility stub for the retired direct Convex field-check CLI.
 * Usage: bun x tsx scripts/eval/check-fields.ts
 */

export {};

function main(): never {
  console.error(
    [
      'Deprecated: scripts/eval/check-fields.ts has been retired.',
      'This legacy helper depended on direct Convex queries and no longer runs.',
      'Use the supported Postgres-first Docs RAG verification flow instead:',
      '  bun run verify',
      '  bun run verify:docs-rag-live',
      '  bun run health:docs-rag',
      '  ./bin/ragctl docs search <query> --json',
    ].join('\n')
  );
  process.exit(1);
}

main();
