/**
 * Compatibility stub for the retired Convex-only system benchmark.
 */

type RetiredBenchmarkReport = {
  status: 'retired';
  command: string;
  reason: string;
  replacements: string[];
};

const COMMAND = 'bun run bench:system';
const REPLACEMENTS = [
  'bun run bench:docs-rag-real',
  'bun run bench:codex-mcp',
  'bun run eval:mcp-live',
  'bun run eval:project-rag',
];

function parseArgs(args: string[]) {
  return {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
  };
}

function buildReport(): RetiredBenchmarkReport {
  return {
    status: 'retired',
    command: COMMAND,
    reason:
      'This benchmark was retired because it measured Convex-only Docs RAG and Project RAG paths that are no longer part of the supported runtime.',
    replacements: REPLACEMENTS,
  };
}

function printHelp() {
  console.log(`
System Benchmark Retired
========================

${COMMAND} no longer runs a live benchmark.

Reason:
  This entrypoint depended on Convex-only runtime surfaces and no equivalent
  end-to-end system benchmark exists in this repo today.

Use these supported commands instead:
  ${REPLACEMENTS.join('\n  ')}
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const report = buildReport();

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('[retired] bench:system');
  console.log(report.reason);
  console.log('Supported replacements:');
  for (const replacement of report.replacements) {
    console.log(`- ${replacement}`);
  }
  process.exitCode = 1;
}

main();

export {};
