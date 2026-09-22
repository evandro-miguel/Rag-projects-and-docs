/**
 * Compatibility stub for the retired clear-ingest-lock CLI.
 * Usage: bun x tsx scripts/clear-ingest-lock.ts
 */

export {};

function main(): never {
  console.error(
    [
      'Deprecated: scripts/clear-ingest-lock.ts has been retired.',
      'This legacy command used direct Convex mutations and no longer runs.',
      'Use the supported ingest/project repair flow instead.',
    ].join('\n')
  );
  process.exit(1);
}

main();
