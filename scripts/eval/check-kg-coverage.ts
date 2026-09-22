type KgRetiredSummary = {
  status: 'retired';
  reason: string;
  replacements: string[];
};

export {};

function readFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function buildRetiredSummary(): KgRetiredSummary {
  return {
    status: 'retired',
    reason: 'Convex-only Docs KG coverage validation was retired during the Postgres transition.',
    replacements: [
      'bun run verify:docs-rag-live',
      'bun run health:docs-rag',
      'bun run eval',
      'bun run eval:raw',
    ],
  };
}

async function main() {
  const summary = buildRetiredSummary();

  if (readFlag(process.argv.slice(2), '--json')) {
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('Docs KG coverage check retired.');
  console.log(`Reason: ${summary.reason}`);
  console.log(`Use instead: ${summary.replacements.join(', ')}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
