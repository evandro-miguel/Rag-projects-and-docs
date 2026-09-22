const message = `scripts/check-all-tables.ts is retired.

Use supported Postgres-backed health and verification instead:
  ./bin/ragctl health --json
  bun run verify:project-rag:postgres
`;

console.error(message);
process.exitCode = 1;

export {};
