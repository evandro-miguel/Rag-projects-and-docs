const message = `scripts/verify-self-ingestion.ts is retired.

Use supported Postgres-backed verification instead:
  bun run verify:project
  ./bin/ragctl project verify --project <project> --json
`;

console.error(message);
process.exitCode = 1;

export {};
