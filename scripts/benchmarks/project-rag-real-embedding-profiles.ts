import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  formatRealProjectEmbeddingProfileBenchmark,
  type RealEmbeddingProfileId,
  resolveRealEmbeddingProfiles,
  runRealProjectEmbeddingProfileBenchmark,
} from '../eval/project-rag/real-embedding-profile-benchmark.js';

function readListArg(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }
    const raw = args[index + 1];
    if (!raw || raw.startsWith('--')) {
      continue;
    }
    values.push(
      ...raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    );
  }
  return values;
}

function parseArgs(args: string[]) {
  const fixtureIds = readListArg(args, '--fixture');
  const profileIds = readListArg(args, '--profile') as RealEmbeddingProfileId[];
  const topKArg = args.includes('--top-k') ? args[args.indexOf('--top-k') + 1] : undefined;
  const timeoutArg = args.includes('--timeout-ms')
    ? args[args.indexOf('--timeout-ms') + 1]
    : undefined;
  const writePath = args.includes('--write') ? args[args.indexOf('--write') + 1] : undefined;
  return {
    fixtureIds: fixtureIds.length > 0 ? fixtureIds : undefined,
    profileIds: profileIds.length > 0 ? profileIds : undefined,
    topK: topKArg ? Number.parseInt(topKArg, 10) : undefined,
    timeoutMs: timeoutArg ? Number.parseInt(timeoutArg, 10) : undefined,
    writePath,
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run'),
    requireAll: args.includes('--require-all'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp() {
  const profiles = resolveRealEmbeddingProfiles();
  console.log(`
Project RAG Real Embedding Profile Benchmark
============================================

Uses already-running embedding endpoints over small Project RAG fixtures.
It does not start llama-server, download models, run Convex ingest, or truncate dimensions.

Usage:
  bun run scripts/benchmarks/project-rag-real-embedding-profiles.ts [options]

Options:
  --fixture <id[,id]>   Limit fixtures (default: fixture-ts-service)
  --profile <id[,id]>   Limit profiles (default: qwen3-0.6b-1024,qwen3-8b-4096)
  --top-k <n>           Retrieved results per scenario (default: 3)
  --timeout-ms <n>      Endpoint timeout per request (default: 10000)
  --dry-run             Resolve config and fixture corpus without network calls
  --write <path>        Write JSON report to file
  --json                Print JSON report
  --require-all         Exit 2 if any requested profile is blocked or failed
  --help, -h            Show this help

Environment:
  4096D: LLAMACPP_BASE_URL or PROJECT_RAG_4096_BASE_URL, model via LLAMACPP_EMBEDDING_MODEL
  1024D: PROJECT_RAG_1024_BASE_URL, model via PROJECT_RAG_1024_MODEL

Available profiles:
  ${Object.values(profiles)
    .map(
      (profile) =>
        `${profile.id} -> ${profile.expectedDimensions}d, endpoint=${profile.baseUrl ?? '<not configured>'}`
    )
    .join('\n  ')}
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const report = await runRealProjectEmbeddingProfileBenchmark({
    fixtureIds: args.fixtureIds,
    profileIds: args.profileIds,
    topK: args.topK,
    timeoutMs: args.timeoutMs,
    dryRun: args.dryRun,
  });

  if (args.writePath) {
    const outputPath = resolve(args.writePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(report, null, 2));
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatRealProjectEmbeddingProfileBenchmark(report));
  }

  if (
    !args.dryRun &&
    args.requireAll &&
    report.profiles.some((profile) => profile.status !== 'passed')
  ) {
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
