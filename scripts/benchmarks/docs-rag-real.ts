import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type DocsRealEmbeddingProfileId,
  formatRealDocsRagBenchmark,
  runRealDocsRagBenchmark,
} from '../eval/docs-rag/real-docs-rag-benchmark.js';

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
  const profileIds = readListArg(args, '--profile') as DocsRealEmbeddingProfileId[];
  const topKArg = args.includes('--top-k') ? args[args.indexOf('--top-k') + 1] : undefined;
  const timeoutArg = args.includes('--timeout-ms')
    ? args[args.indexOf('--timeout-ms') + 1]
    : undefined;
  const maxChunksArg = args.includes('--max-chunks-per-document')
    ? args[args.indexOf('--max-chunks-per-document') + 1]
    : undefined;
  const embeddingBatchArg = args.includes('--embedding-batch-size')
    ? args[args.indexOf('--embedding-batch-size') + 1]
    : undefined;
  const writePath = args.includes('--write') ? args[args.indexOf('--write') + 1] : undefined;

  return {
    profileIds: profileIds.length > 0 ? profileIds : undefined,
    topK: topKArg ? Number.parseInt(topKArg, 10) : undefined,
    timeoutMs: timeoutArg ? Number.parseInt(timeoutArg, 10) : undefined,
    maxChunksPerDocument: maxChunksArg ? Number.parseInt(maxChunksArg, 10) : undefined,
    embeddingBatchSize: embeddingBatchArg ? Number.parseInt(embeddingBatchArg, 10) : undefined,
    writePath,
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run'),
    requirePass: args.includes('--require-pass'),
    requireAll: args.includes('--require-all'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp() {
  console.log(`
Docs RAG Real Embedding Benchmark
=================================

Embeds a small real Docs RAG corpus against already-running embedding
providers. It does not rebuild indexes, ingest documents, or
start llama-server.

Usage:
  bun run scripts/benchmarks/docs-rag-real.ts [options]

Options:
  --profile <id[,id]>             Profile ids: qwen3-0.6b-1024, qwen3-8b-4096
  --top-k <n>                     Retrieved results per scenario (default: 5)
  --timeout-ms <n>                Endpoint timeout per request (default: 10000)
  --max-chunks-per-document <n>   Max chunks loaded from each document (default: 8)
  --embedding-batch-size <n>      Corpus embedding request batch size (default: 16)
  --dry-run                       Resolve corpus and configuration without network calls
  --write <path>                  Write JSON report to file
  --json                          Print JSON report
  --require-pass                  Exit 2 if every selected profile is not passed
  --require-all                   Alias for --require-pass
  --help, -h                      Show this help

Environment:
  DOCS_RAG_1024_BASE_URL or PROJECT_RAG_1024_BASE_URL overrides the 1024D default (http://127.0.0.1:8082)
  DOCS_RAG_4096_BASE_URL or LLAMACPP_BASE_URL overrides the 4096D default (http://127.0.0.1:8081)
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const report = await runRealDocsRagBenchmark({
    profileIds: args.profileIds,
    topK: args.topK,
    timeoutMs: args.timeoutMs,
    maxChunksPerDocument: args.maxChunksPerDocument,
    embeddingBatchSize: args.embeddingBatchSize,
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
    console.log(formatRealDocsRagBenchmark(report));
  }

  if (!args.dryRun && (args.requirePass || args.requireAll)) {
    const allPassed = report.profiles.every((profile) => profile.status === 'passed');
    if (!allPassed) {
      process.exitCode = 2;
    }
  }
  if (!args.dryRun && args.requirePass && report.profiles.length === 0) {
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
