/**
 * @file validate-project-rag-e2e.ts
 * @description Retired legacy Convex Project RAG E2E validation script.
 */

console.error(
  [
    'scripts/validate-project-rag-e2e.ts is retired.',
    'Use `bun run verify:project` for the current Project RAG contract.',
    'Use `bun run eval:project-rag` for fixture E2E evaluation.',
  ].join('\n')
);

process.exitCode = 1;

export {};
