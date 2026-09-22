import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  formatLightProjectEmbeddingProfileBenchmark,
  LIGHT_EMBEDDING_PROFILES,
  type LightEmbeddingProfileId,
  runLightProjectEmbeddingProfileBenchmark,
} from '../eval/project-rag/embedding-profile-benchmark.js';
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
  const profileIds = readListArg(args, '--profile');
  const topKArg = args.includes('--top-k') ? args[args.indexOf('--top-k') + 1] : undefined;
  const writePath = args.includes('--write') ? args[args.indexOf('--write') + 1] : undefined;
  const modeArg = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : undefined;
  const timeoutArg = args.includes('--timeout-ms')
    ? args[args.indexOf('--timeout-ms') + 1]
    : undefined;
  return {
    fixtureIds: fixtureIds.length > 0 ? fixtureIds : undefined,
    profileIds: profileIds.length > 0 ? profileIds : undefined,
    topK: topKArg ? Number.parseInt(topKArg, 10) : undefined,
    writePath,
    mode: modeArg === 'real' ? 'real' : 'light',
    timeoutMs: timeoutArg ? Number.parseInt(timeoutArg, 10) : undefined,
    dryRun: args.includes('--dry-run'),
    preflight: args.includes('--preflight'),
    json: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp() {
  const realProfiles = resolveRealEmbeddingProfiles();
  console.log(`
Project RAG Light Embedding Profile Benchmark
============================================

Compares deterministic 4096d vs 1024d embedding profiles on small Project RAG fixtures.
This does not start llama-server, does not call real embedding providers, and does not run project ingest.

Usage:
  bun run scripts/benchmarks/project-rag-embedding-profiles.ts [options]

Options:
  --mode <light|real>   Select deterministic benchmark or real provider fixture benchmark (default: light)
  --fixture <id[,id]>   Limit fixtures (default: fixture-ts-service, fixture-secret-noise, fixture-graph-relations)
  --profile <id[,id]>   Limit profiles (light: profile-1024,profile-4096; real: qwen3-0.6b-1024,qwen3-8b-4096)
  --top-k <n>           Retrieved results per scenario (default: 3)
  --timeout-ms <n>      Real provider request timeout override
  --preflight           Real mode uses the bounded default fixture and no ingest
  --dry-run             Real mode resolves config and fixture corpus without network calls
  --write <path>        Write JSON report to file
  --json                Print JSON report
  --help, -h            Show this help

Available light profiles:
  ${Object.values(LIGHT_EMBEDDING_PROFILES)
    .map((profile) => `${profile.id} -> ${profile.description}`)
    .join('\n  ')}

Available real profiles:
  ${Object.values(realProfiles)
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

  if (args.mode === 'real') {
    const report = await runRealProjectEmbeddingProfileBenchmark({
      fixtureIds: args.fixtureIds ?? (args.preflight ? ['fixture-ts-service'] : undefined),
      profileIds: args.profileIds as RealEmbeddingProfileId[] | undefined,
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

    return;
  }

  const report = runLightProjectEmbeddingProfileBenchmark({
    fixtureIds: args.fixtureIds,
    profileIds: args.profileIds as LightEmbeddingProfileId[] | undefined,
    topK: args.topK,
  });

  if (args.writePath) {
    const outputPath = resolve(args.writePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(report, null, 2));
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatLightProjectEmbeddingProfileBenchmark(report));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
