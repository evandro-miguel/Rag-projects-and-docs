const message = `scripts/search.ts is retired.

Use supported Postgres-backed commands instead:
  ./bin/ragctl docs search "<query>" --json
  ./bin/ragctl project search --project <project> "<query>" --json
`;

console.error(message);
process.exitCode = 1;

export {};
