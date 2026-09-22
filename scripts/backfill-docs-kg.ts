export {};

function main(): never {
  console.error('Docs KG Convex backfill is retired.');
  console.error('Use Postgres Docs RAG sync/search gates instead:');
  console.error('- bun run sync:external');
  console.error('- bun run health:docs-rag');
  console.error('- bun run verify:docs-rag-live');
  process.exit(1);
}

main();
