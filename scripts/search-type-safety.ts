const message = `scripts/search-type-safety.ts is retired.

Use supported Postgres-backed Project RAG search instead:
  ./bin/ragctl project search --project <project> "TypeScript any type assertions" --json
`;

console.error(message);
process.exitCode = 1;

export {};
