/**
 * @module top-queries
 * @description Retired legacy Convex query analytics script.
 */

console.error(
  [
    'scripts/analytics/top-queries.ts is retired.',
    'The old Convex analytics query log is not part of the Postgres Docs/Project RAG runtime.',
    'Add a dedicated Postgres analytics report when query logging exists there.',
  ].join('\n')
);

process.exitCode = 1;

export {};
