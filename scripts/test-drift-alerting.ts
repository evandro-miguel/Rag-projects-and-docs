/**
 * @module test-drift-alerting
 * @description Retired legacy Convex drift alerting smoke script.
 */

console.error(
  [
    'scripts/test-drift-alerting.ts is retired.',
    'Use `bun run scripts/eval/drift-check.ts --alert` for drift alerting.',
    'No legacy Convex drift alerting smoke exists anymore.',
  ].join('\n')
);

process.exitCode = 1;

export {};
