#!/usr/bin/env bun

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { type DocsRagFreshness, readDocsRagFreshness } from '../lib/docs-rag-freshness.js';
import { canonicalizeDocsSourceId, lookupDocsSourceByPath } from '../lib/docs-source-registry.js';
import { auditDocsRagCorpusPaths } from './audit.js';
import { resolveDocsRagLabConfig } from './config.js';
import { checkDocsRagLabDatabaseHealth } from './db.js';
import {
  type DocsRagLabEvalFixture,
  evaluateDocsRagLabFixture,
  evaluateDocsRagLabGate,
  loadDocsRagLabEvalFixture,
} from './eval.js';
import {
  collectDocsRagLabFiles,
  type DocsRagLabIngestReport,
  ingestDocsRagLabCorpus,
  searchDocsRagLab,
} from './store.js';

type DocsRagLabCommand =
  | 'help'
  | 'config'
  | 'db-health'
  | 'sync-check'
  | 'sanitize-plan'
  | 'ingest'
  | 'search'
  | 'eval'
  | 'unknown';

const DOCS_RAG_LAB_COMMANDS = new Set<DocsRagLabCommand>([
  'help',
  'config',
  'db-health',
  'sync-check',
  'sanitize-plan',
  'ingest',
  'search',
  'eval',
]);

interface ParsedArgs {
  readonly command: DocsRagLabCommand;
  readonly positionals: string[];
  readonly options: Map<string, string>;
  readonly flags: Set<string>;
}

interface DocsRagLabEnvelope<T = unknown> {
  readonly ok: boolean;
  readonly command: DocsRagLabCommand;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly warnings?: string[];
  readonly meta: {
    readonly tool: 'docs-rag-pg-lab';
    readonly version: 1;
  };
}

function printHelp(): void {
  console.log(`
Docs RAG Postgres Lab
=====================

Safe-by-default CLI for an isolated Docs-only Postgres RAG lab.
It resolves config, performs DB smoke checks, indexes docs into Postgres, runs
lexical search, and scores offline or live retrieval fixtures behind gates.

Usage:
  bun run docs-rag:lab <command> [options]

Commands:
  config                       Print resolved lab config
  db-health                    Run a Postgres smoke check against the configured URL
  sync-check                   Check weekly source freshness; optionally sync and ingest
  sanitize-plan                Read-only audit for secret-like and path-reference risks
  eval                         Score an offline or live retrieval fixture
  ingest [paths...]            Index docs into the isolated Postgres lab
  search <query>               Search indexed docs in the isolated Postgres lab
  help                         Show this help

Options:
  --db-url <url>               Override the configured Postgres URL for this run
  --dataset <path>             Offline eval fixture path
  --top-k <n>                  Eval cutoff k (default from config)
  --timeout-ms <n>             DB health timeout in milliseconds
  --max-age-hours <n>          Source freshness window (default 168)
  --source <sourceId>          Limit sync-check/search to one source
  --query <text>               Live search query
  --limit <n>                  Live search result limit
  --max-files <n>              Sanitize-plan/ingest file cap (default 500/5000)
  --max-file-bytes <n>         Sanitize-plan per-file size cap (default 256000)
  --write <path>               Write the JSON payload to a file
  --live-search                Use live SQL search during eval
  --allow-live-search          Required for live search flows
  --require-pass               Fail eval when live quality thresholds are missed
  --allow-sync                 Required for sync-check to fetch/process upstream docs
  --allow-write                Required for ingest flows
  --skip-llm                   Pass through to sync-check source sync
  --force                      Force sync-check revalidation; passed to one-source sync
  --single-process             Internal ingest worker mode
  --help, -h                   Show this help

Environment:
  DOCS_RAG_PG_LAB_DATABASE_URL     Primary isolated Postgres URL
  DOCS_RAG_PG_LAB_EVAL_TOP_K       Default eval cutoff
  DOCS_RAG_PG_LAB_DB_TIMEOUT_MS    DB probe timeout
  DOCS_RAG_LONG_RUNNING_CHILD_TIMEOUT_MS  Sync/aggregate ingest timeout (default 6h)
  DOCS_RAG_INGEST_WORKER_TIMEOUT_MS       Per-source ingest worker timeout (default 6h)
  DOCS_RAG_CHILD_OUTPUT_TAIL_BYTES        Captured stdout/stderr tail (default 2 MiB)
  DOCS_RAG_PG_LAB_ENABLE_LIVE_SEARCH=true
  DOCS_RAG_PG_LAB_ENABLE_EMBEDDING=true
  DOCS_RAG_PG_LAB_ENABLE_MUTATIONS=true

Examples:
  bun run docs-rag:lab config
  bun run docs-rag:lab db-health --db-url postgres://user:pass@127.0.0.1:5441/docs_lab
  bun run docs-rag:lab sync-check
  DOCS_RAG_PG_LAB_ENABLE_MUTATIONS=true DOCS_RAG_PG_LAB_ENABLE_EMBEDDING=true bun run docs-rag:lab sync-check --allow-sync --allow-write
  bun run docs-rag:lab sanitize-plan scripts/docs-rag tests/docs-rag
  bun run docs-rag:lab eval --dataset scripts/docs-rag/fixtures/eval-external-sources.json
  DOCS_RAG_PG_LAB_ENABLE_MUTATIONS=true bun run docs-rag:lab ingest ingest/processed/external/bun-docs --allow-write
  DOCS_RAG_PG_LAB_ENABLE_LIVE_SEARCH=true bun run docs-rag:lab search --allow-live-search --query "backendHarness IS_TEST"
`);
}

function getCliArgv(): string[] {
  const directArgv = process.argv.slice(1);
  const runScriptArgv = process.argv.slice(2);
  const first = directArgv[0];
  if (first && (first.startsWith('--') || DOCS_RAG_LAB_COMMANDS.has(first as DocsRagLabCommand))) {
    return directArgv;
  }
  return runScriptArgv;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex >= 0) {
      options.set(token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }

  const helpRequested = flags.has('help') || flags.has('h');
  const rawCommand = positionals[0];
  const command =
    helpRequested || !rawCommand
      ? 'help'
      : DOCS_RAG_LAB_COMMANDS.has(rawCommand as DocsRagLabCommand)
        ? (rawCommand as DocsRagLabCommand)
        : 'unknown';

  return {
    command,
    positionals,
    options,
    flags,
  };
}

function readNumberOption(
  args: ParsedArgs,
  name: string,
  fallback: number | undefined
): number | undefined {
  const value = args.options.get(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildEnvelope<T>(
  command: DocsRagLabCommand,
  payload: Omit<DocsRagLabEnvelope<T>, 'command' | 'meta'>
): DocsRagLabEnvelope<T> {
  return {
    ...payload,
    command,
    meta: {
      tool: 'docs-rag-pg-lab',
      version: 1,
    },
  };
}

function writePayloadIfRequested(args: ParsedArgs, payload: unknown): void {
  const writePath = args.options.get('write');
  if (!writePath) {
    return;
  }

  const outputPath = resolve(writePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2));
}

function emitPayload(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function getSearchLimit(args: ParsedArgs, fallback: number): number {
  return readNumberOption(args, 'limit', readNumberOption(args, 'top-k', fallback)) ?? fallback;
}

function getSearchQuery(args: ParsedArgs): string {
  return args.options.get('query') ?? args.positionals.slice(1).join(' ');
}

export async function buildLiveEvalFixture(
  fixture: DocsRagLabEvalFixture,
  config: ReturnType<typeof resolveDocsRagLabConfig>,
  topK: number,
  runSearch: typeof searchDocsRagLab = searchDocsRagLab
): Promise<DocsRagLabEvalFixture> {
  const cases: DocsRagLabEvalFixture['cases'] = [];
  for (const testCase of fixture.cases) {
    const searchReport = await runSearch(config, testCase.query, {
      limit: testCase.k ?? topK,
      sourceId: testCase.sourceId,
    });
    cases.push({
      ...testCase,
      retrieved: searchReport.results.map((result) => ({
        path: result.sourcePath,
        sourceId: result.sourceId,
        citationPath: result.sourcePath,
        score: result.score,
      })),
    });
  }

  return {
    ...fixture,
    cases,
  };
}

function blockedEnvelope(
  command: DocsRagLabCommand,
  code: string,
  message: string,
  requirements: string[]
): DocsRagLabEnvelope<{
  readonly status: 'blocked';
  readonly requirements: string[];
}> {
  return buildEnvelope(command, {
    ok: false,
    error: { code, message },
    data: { status: 'blocked', requirements },
  });
}

interface ChildCommandSummary {
  readonly command: string;
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

export interface DocsRagChildProcessResult {
  readonly exitCode: number;
  readonly stdout: { readonly text: string; readonly truncated: boolean };
  readonly stderr: { readonly text: string; readonly truncated: boolean };
  readonly timedOut: boolean;
}

export interface DocsRagChildProcessLimits {
  readonly longRunningTimeoutMs: number;
  readonly ingestWorkerTimeoutMs: number;
  readonly capturedOutputTailBytes: number;
}

function strictEnvInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!value || !/^[1-9]\d*$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function resolveDocsRagChildProcessLimits(
  env: NodeJS.ProcessEnv = process.env
): DocsRagChildProcessLimits {
  return {
    longRunningTimeoutMs: strictEnvInteger(
      env.DOCS_RAG_LONG_RUNNING_CHILD_TIMEOUT_MS,
      6 * 60 * 60 * 1_000,
      5 * 60 * 1_000,
      2_147_483_647
    ),
    ingestWorkerTimeoutMs: strictEnvInteger(
      env.DOCS_RAG_INGEST_WORKER_TIMEOUT_MS,
      6 * 60 * 60 * 1_000,
      5 * 60 * 1_000,
      2_147_483_647
    ),
    capturedOutputTailBytes: strictEnvInteger(
      env.DOCS_RAG_CHILD_OUTPUT_TAIL_BYTES,
      2 * 1024 * 1024,
      4 * 1024,
      64 * 1024 * 1024
    ),
  };
}

function tailLines(text: string, maxLines = 30): string {
  const lines = text.trim().split(/\r?\n/u).filter(Boolean);
  return lines.slice(-maxLines).join('\n');
}

async function runChildCommand(
  command: string[],
  cwd: string,
  options: { readonly timeoutMs: number; readonly outputTailBytes: number }
): Promise<ChildCommandSummary> {
  const result = await runDocsRagChildProcess(command, cwd, options);
  return {
    command: command.join(' '),
    exitCode: result.exitCode,
    stdoutTail: tailLines(result.stdout.text),
    stderrTail: tailLines(result.stderr.text),
    stdoutTruncated: result.stdout.truncated,
    stderrTruncated: result.stderr.truncated,
    timedOut: result.timedOut,
  };
}

function signalProcessGroup(child: Bun.Subprocess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the group has already exited or is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The direct child has already exited.
  }
}

export async function runDocsRagChildProcess(
  command: string[],
  cwd: string,
  options: { readonly timeoutMs: number; readonly outputTailBytes: number }
): Promise<DocsRagChildProcessResult> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
  });
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    signalProcessGroup(child, 'SIGTERM');
    setTimeout(() => signalProcessGroup(child, 'SIGKILL'), 5_000);
  }, options.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    readStreamTail(child.stdout, options.outputTailBytes),
    readStreamTail(child.stderr, options.outputTailBytes),
    child.exited,
  ]);
  clearTimeout(timeoutTimer);
  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
  };
}

function syncCheckInstructions(sourceId?: string): string[] {
  const canonicalSourceId = sourceId ? canonicalizeDocsSourceId(sourceId) : undefined;
  const sourceArgs = canonicalSourceId ? ` --source ${canonicalSourceId}` : '';
  return [
    `bun run docs-rag:lab sync-check${sourceArgs} --allow-sync`,
    `DOCS_RAG_PG_LAB_ENABLE_MUTATIONS=true DOCS_RAG_PG_LAB_ENABLE_EMBEDDING=true bun run docs-rag:lab sync-check${sourceArgs} --allow-sync --allow-write`,
  ];
}

function readFreshnessForArgs(args: ParsedArgs, rootDir: string): DocsRagFreshness {
  const sourceOption = args.options.get('source')?.trim();
  const sourceId = sourceOption ? canonicalizeDocsSourceId(sourceOption) : undefined;
  return readDocsRagFreshness({
    cwd: rootDir,
    maxAgeHours: readNumberOption(args, 'max-age-hours', undefined),
    expectedSourceIds: sourceId ? [sourceId] : undefined,
  });
}

export async function readStreamTail(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (!stream) {
    return { text: '', truncated: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
      while (size > maxBytes && chunks.length > 0) {
        const overflow = size - maxBytes;
        const first = chunks[0];
        if (first.byteLength <= overflow) {
          chunks.shift();
          size -= first.byteLength;
        } else {
          chunks[0] = first.slice(overflow);
          size -= overflow;
        }
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

export function groupDocsRagIngestWorkerPaths(
  files: readonly string[],
  rootDir: string
): string[][] {
  const batches = new Map<string, string[]>();
  for (const file of files) {
    const relativePath = relative(rootDir, file).replaceAll('\\', '/');
    const source = lookupDocsSourceByPath(relativePath);
    const batchKey = source?.sourceId ?? `unregistered:${relativePath}`;
    const batch = batches.get(batchKey) ?? [];
    batch.push(relativePath);
    batches.set(batchKey, batch);
  }
  return [...batches.values()];
}

export function summarizeDocsRagWorkerReport(report: DocsRagLabIngestReport): {
  readonly indexedDocuments: number;
  readonly indexedChunks: number;
  readonly skippedFilesExcludingFailures: number;
  readonly failedFiles: DocsRagLabIngestReport['failedFiles'];
} {
  return {
    indexedDocuments: report.indexedDocuments,
    indexedChunks: report.indexedChunks,
    skippedFilesExcludingFailures: Math.max(0, report.skippedFiles - report.failedFiles.length),
    failedFiles: report.failedFiles,
  };
}

async function ingestDocsRagLabCorpusInWorkers(
  args: ParsedArgs,
  config: ReturnType<typeof resolveDocsRagLabConfig>
): Promise<DocsRagLabIngestReport> {
  const inputPaths = args.positionals.slice(1);
  const paths = inputPaths.length > 0 ? inputPaths : ['ingest/processed/external'];
  const files = collectDocsRagLabFiles(paths, {
    cwd: config.rootDir,
    maxFiles: readNumberOption(args, 'max-files', undefined),
  });
  const workerBatches = groupDocsRagIngestWorkerPaths(files, config.rootDir);
  let indexedDocuments = 0;
  let indexedChunks = 0;
  let skippedFiles = 0;
  const failedFiles: DocsRagLabIngestReport['failedFiles'] = [];
  const childLimits = resolveDocsRagChildProcessLimits();

  for (const [index, relativeBatch] of workerBatches.entries()) {
    const workerReportPath = resolve(
      config.rootDir,
      '.afol',
      'tmp',
      `docs-rag-worker-${process.pid}-${index}.json`
    );
    mkdirSync(dirname(workerReportPath), { recursive: true });
    rmSync(workerReportPath, { force: true });
    const childResult = await runDocsRagChildProcess(
      [
        process.execPath,
        'scripts/docs-rag/index.ts',
        'ingest',
        ...relativeBatch,
        '--allow-write',
        '--single-process',
        '--write',
        workerReportPath,
      ],
      config.rootDir,
      {
        // A worker owns one complete source generation, so its dedicated
        // timeout must cover the whole source rather than one file.
        timeoutMs: childLimits.ingestWorkerTimeoutMs,
        outputTailBytes: childLimits.capturedOutputTailBytes,
      }
    );
    const stdout = childResult.stdout.text;
    const stderr = childResult.stderr.text;
    let envelope: DocsRagLabEnvelope | undefined;
    try {
      envelope = JSON.parse(readFileSync(workerReportPath, 'utf8')) as DocsRagLabEnvelope;
    } catch {
      envelope = undefined;
    } finally {
      rmSync(workerReportPath, { force: true });
    }
    const report = envelope?.data as DocsRagLabIngestReport | undefined;
    if (report) {
      const summary = summarizeDocsRagWorkerReport(report);
      indexedDocuments += summary.indexedDocuments;
      indexedChunks += summary.indexedChunks;
      skippedFiles += summary.skippedFilesExcludingFailures;
      failedFiles.push(...summary.failedFiles);
    }
    if (childResult.exitCode !== 0 || !envelope?.ok || !report) {
      const timeoutMessage = childResult.timedOut
        ? `worker timed out after ${childLimits.ingestWorkerTimeoutMs}ms`
        : undefined;
      const message =
        timeoutMessage ||
        stderr.trim() ||
        stdout.trim() ||
        `worker exited with code ${childResult.exitCode}`;
      if (!report?.failedFiles.length) {
        failedFiles.push(...relativeBatch.map((path) => ({ path, message })));
      }
    }
  }

  return {
    status: 'completed',
    inputPaths: [...paths],
    scannedFiles: files.length,
    indexedDocuments,
    indexedChunks,
    skippedFiles: skippedFiles + failedFiles.length,
    failedFiles,
  };
}

async function run(): Promise<number> {
  const args = parseArgs(getCliArgv());
  if (args.command === 'help') {
    printHelp();
    return 0;
  }

  const config = resolveDocsRagLabConfig(process.env, {
    databaseUrl: args.options.get('db-url'),
    evalTopK: readNumberOption(args, 'top-k', undefined),
    healthTimeoutMs: readNumberOption(args, 'timeout-ms', undefined),
  });

  let payload: DocsRagLabEnvelope;
  switch (args.command) {
    case 'config':
      payload = buildEnvelope('config', {
        ok: true,
        data: {
          tool: config.tool,
          rootDir: config.rootDir,
          defaultEvalFixturePath: config.defaultEvalFixturePath,
          evalTopK: config.evalTopK,
          healthTimeoutMs: config.healthTimeoutMs,
          database: {
            redactedUrl: config.database.redactedUrl,
            source: config.database.source,
          },
          gates: config.gates,
        },
      });
      break;
    case 'db-health': {
      const result = await checkDocsRagLabDatabaseHealth(config, {
        timeoutMs: config.healthTimeoutMs,
      });
      payload = buildEnvelope('db-health', {
        ok: result.status === 'healthy',
        ...(result.status === 'healthy'
          ? { data: result }
          : {
              data: result,
              error: {
                code: result.status === 'blocked' ? 'DB_HEALTH_BLOCKED' : 'DB_HEALTH_FAILED',
                message: result.message,
              },
            }),
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      });
      break;
    }
    case 'sync-check': {
      const childLimits = resolveDocsRagChildProcessLimits();
      const sourceOption = args.options.get('source')?.trim();
      const sourceId = sourceOption ? canonicalizeDocsSourceId(sourceOption) : undefined;
      const freshness = readFreshnessForArgs(args, config.rootDir);
      const sourceArgs = [
        ...(sourceId ? ['--source', sourceId] : []),
        ...(args.flags.has('skip-llm') ? ['--skip-llm'] : []),
        ...(sourceId && args.flags.has('force') ? ['--force'] : []),
      ];

      if (freshness.status === 'ok' && !args.flags.has('force')) {
        payload = buildEnvelope('sync-check', {
          ok: true,
          data: {
            status: 'fresh',
            freshness,
            action: 'none',
          },
        });
        break;
      }

      if (!args.flags.has('allow-sync')) {
        payload = buildEnvelope('sync-check', {
          ok: false,
          error: {
            code: 'DOCS_RAG_SOURCE_SYNC_REQUIRED',
            message: freshness.warning ?? 'Docs RAG source freshness should be checked.',
          },
          data: {
            status: 'needs_sync',
            freshness,
            requirements: ['--allow-sync'],
            nextCommands: syncCheckInstructions(sourceId),
          },
        });
        break;
      }

      const sync = await runChildCommand(
        [process.execPath, 'run', 'sync:external', '--', ...sourceArgs],
        config.rootDir,
        {
          timeoutMs: childLimits.longRunningTimeoutMs,
          outputTailBytes: childLimits.capturedOutputTailBytes,
        }
      );
      const refreshed = readFreshnessForArgs(args, config.rootDir);
      if (sync.exitCode !== 0) {
        payload = buildEnvelope('sync-check', {
          ok: false,
          error: {
            code: 'DOCS_RAG_SOURCE_SYNC_FAILED',
            message: `sync:external exited with code ${sync.exitCode}`,
          },
          data: {
            status: 'sync_failed',
            freshness: refreshed,
            sync,
          },
        });
        break;
      }

      if (!args.flags.has('allow-write')) {
        payload = buildEnvelope('sync-check', {
          ok: true,
          data: {
            status: 'synced',
            freshness: refreshed,
            sync,
            nextCommands: syncCheckInstructions(sourceId).slice(1),
          },
          warnings: ['Source sync completed. Re-run with --allow-write to update Postgres.'],
        });
        break;
      }

      const requirements = ['DOCS_RAG_PG_LAB_ENABLE_MUTATIONS=true', '--allow-write'];
      if (!config.gates.mutationEnabled) {
        payload = blockedEnvelope(
          'sync-check',
          'INGEST_BLOCKED',
          'Postgres ingest requires the mutation gate after source sync.',
          requirements
        );
        break;
      }

      const ingestPath = sourceId
        ? `ingest/processed/external/${sourceId}`
        : 'ingest/processed/external';
      const ingest = await runChildCommand(
        [process.execPath, 'run', 'docs-rag:lab', 'ingest', ingestPath, '--allow-write'],
        config.rootDir,
        {
          timeoutMs: childLimits.longRunningTimeoutMs,
          outputTailBytes: childLimits.capturedOutputTailBytes,
        }
      );
      payload = buildEnvelope('sync-check', {
        ok: ingest.exitCode === 0,
        ...(ingest.exitCode === 0
          ? {}
          : {
              error: {
                code: 'DOCS_RAG_POSTGRES_INGEST_FAILED',
                message: `docs-rag:lab ingest exited with code ${ingest.exitCode}`,
              },
            }),
        data: {
          status: ingest.exitCode === 0 ? 'processed' : 'ingest_failed',
          freshness: refreshed,
          sync,
          ingest,
        },
        warnings: config.gates.embeddingEnabled
          ? ['Source sync and Postgres embedding ingest completed.']
          : [
              'Postgres ingest completed without embeddings; enable DOCS_RAG_PG_LAB_ENABLE_EMBEDDING=true.',
            ],
      });
      break;
    }
    case 'sanitize-plan': {
      const auditPaths = args.positionals.slice(1);
      if (auditPaths.length === 0) {
        payload = buildEnvelope('sanitize-plan', {
          ok: false,
          error: {
            code: 'AUDIT_PATHS_REQUIRED',
            message: 'Provide at least one file or directory path to audit.',
          },
          data: {
            status: 'blocked',
            nextAction: 'Re-run sanitize-plan with one or more local file or directory paths.',
          },
        });
        break;
      }

      const report = auditDocsRagCorpusPaths(auditPaths, {
        maxFiles: readNumberOption(args, 'max-files', undefined),
        maxFileBytes: readNumberOption(args, 'max-file-bytes', undefined),
      });
      payload = buildEnvelope('sanitize-plan', {
        ok: true,
        data: {
          mode: 'read-only',
          report,
        },
        warnings: ['Read-only planning report. No files were changed.', ...report.warnings],
      });
      break;
    }
    case 'eval': {
      const fixturePath = args.options.get('dataset') ?? config.defaultEvalFixturePath;
      const liveEval = args.flags.has('live-search');
      const requirements = ['DOCS_RAG_PG_LAB_ENABLE_LIVE_SEARCH=true', '--allow-live-search'];
      if (liveEval && (!config.gates.liveSearchEnabled || !args.flags.has('allow-live-search'))) {
        payload = blockedEnvelope(
          'eval',
          'LIVE_EVAL_BLOCKED',
          'Live eval requires the live-search gate and explicit CLI acknowledgement.',
          requirements
        );
        break;
      }

      const loadedFixture = loadDocsRagLabEvalFixture(fixturePath);
      const liveConfig = liveEval
        ? {
            ...config,
            gates: {
              ...config.gates,
              // Agent-facing Docs RAG uses hybrid retrieval by default. The
              // benchmark must exercise that same route instead of silently
              // degrading to keyword-only search.
              embeddingEnabled: true,
            },
          }
        : config;
      const fixture = liveEval
        ? await buildLiveEvalFixture(loadedFixture, liveConfig, config.evalTopK)
        : loadedFixture;
      const report = evaluateDocsRagLabFixture(fixture, {
        topK: config.evalTopK,
      });
      const gate = evaluateDocsRagLabGate(report.summary);
      const requirePass = args.flags.has('require-pass');
      payload = buildEnvelope('eval', {
        ok: !requirePass || gate.passed,
        data: {
          fixturePath,
          report,
          gate,
        },
        error:
          requirePass && !gate.passed
            ? {
                code: 'EVAL_QUALITY_GATE_FAILED',
                message: gate.failures.join('; '),
              }
            : undefined,
        warnings: liveEval
          ? [
              'Live hybrid search performed against the configured Postgres lab and embedding provider.',
            ]
          : ['Offline-only scoring. No live SQL search, embedding, or indexing was performed.'],
      });
      break;
    }
    case 'ingest': {
      const requirements = ['DOCS_RAG_PG_LAB_ENABLE_MUTATIONS=true', '--allow-write'];
      if (!config.gates.mutationEnabled || !args.flags.has('allow-write')) {
        payload = blockedEnvelope(
          'ingest',
          'INGEST_BLOCKED',
          'Ingest requires the mutation gate and explicit CLI acknowledgement.',
          requirements
        );
        break;
      }

      const report = args.flags.has('single-process')
        ? await ingestDocsRagLabCorpus(config, args.positionals.slice(1), {
            maxFiles: readNumberOption(args, 'max-files', undefined),
          })
        : await ingestDocsRagLabCorpusInWorkers(args, config);
      payload = buildEnvelope('ingest', {
        ok: report.failedFiles.length === 0,
        data: report,
        warnings: config.gates.embeddingEnabled
          ? ['Hybrid SQL ingest completed with 1024D Docs RAG chunk embeddings.']
          : [
              'Lexical SQL ingest completed. Set DOCS_RAG_PG_LAB_ENABLE_EMBEDDING=true for embeddings.',
            ],
      });
      break;
    }
    case 'search': {
      const requirements = ['DOCS_RAG_PG_LAB_ENABLE_LIVE_SEARCH=true', '--allow-live-search'];
      if (!config.gates.liveSearchEnabled || !args.flags.has('allow-live-search')) {
        payload = blockedEnvelope(
          'search',
          'SEARCH_BLOCKED',
          'Live search requires the live-search gate and explicit CLI acknowledgement.',
          requirements
        );
        break;
      }

      const query = getSearchQuery(args);
      if (!query.trim()) {
        payload = blockedEnvelope(
          'search',
          'QUERY_REQUIRED',
          'Provide a search query with --query or positional text.',
          ['--query <text>']
        );
        break;
      }

      const report = await searchDocsRagLab(config, query, {
        limit: getSearchLimit(args, config.evalTopK),
        sourceId: args.options.get('source'),
      });
      const freshness = readFreshnessForArgs(args, config.rootDir);
      const sourceOption = args.options.get('source')?.trim();
      payload = buildEnvelope('search', {
        ok: true,
        data: report,
        warnings:
          freshness.status === 'ok'
            ? undefined
            : [
                freshness.warning ?? 'Docs RAG source freshness should be checked.',
                ...syncCheckInstructions(sourceOption),
              ],
      });
      break;
    }
    case 'unknown':
      payload = buildEnvelope('unknown', {
        ok: false,
        error: {
          code: 'UNKNOWN_COMMAND',
          message: `Unknown Docs RAG lab command: ${args.positionals[0] ?? ''}`,
        },
      });
      break;
  }

  writePayloadIfRequested(args, payload);
  emitPayload(payload);

  if (payload.ok) {
    return 0;
  }

  if (args.command === 'db-health') {
    return payload.error?.code === 'DB_HEALTH_BLOCKED' ? 2 : 3;
  }

  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitPayload(
      buildEnvelope('help', {
        ok: false,
        error: {
          code: 'UNEXPECTED_ERROR',
          message,
        },
      })
    );
    process.exitCode = 1;
  }
}
