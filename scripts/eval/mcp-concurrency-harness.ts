/**
 * Strictly read-only production-like MCP concurrency harness.
 *
 * Modes:
 * - stdio: independent MCP clients (one stdio process per concurrent worker)
 * - http: concurrent sessions against an existing shared Streamable HTTP MCP process
 *
 * Allowlist only:
 * - tools/list
 * - search_docs
 * - search_project_code
 * - optional: get_project_file, get_project_outline
 *
 * Never registers, ingests, repairs, verifies via mutating MCP, or sets mutation ack.
 *
 * Call results are inspected for MCP `isError` and structured error codes
 * (e.g. READ_DEADLINE_EXCEEDED). Worker connect failures are folded into the
 * JSON report via Promise.allSettled rather than crashing without a report.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_CONCURRENCY_P95_THRESHOLDS } from './thresholds.js';

export type TransportMode = 'stdio' | 'http';

export type AllowlistedOperation =
  | 'tools/list'
  | 'search_docs'
  | 'search_project_code'
  | 'get_project_file'
  | 'get_project_outline';

export type CallOutcome = 'success' | 'error' | 'timeout';

export type ClassifiedCall = {
  readonly outcome: CallOutcome;
  readonly error?: string;
  readonly code?: string;
};

export type CallResult = {
  readonly workerId: number;
  readonly index: number;
  readonly operation: AllowlistedOperation;
  readonly outcome: CallOutcome;
  readonly latencyMs: number;
  readonly error?: string;
  readonly code?: string;
};

export type PerToolStats = {
  readonly total: number;
  readonly success: number;
  readonly error: number;
  readonly timeout: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
};

export type PoolEnvEntry = {
  readonly env: string | null;
  readonly effective: number;
  readonly default: number;
};

export type ConcurrencyReport = {
  readonly ok: boolean;
  readonly commitSha: string;
  readonly transport: TransportMode;
  readonly allowlist: readonly AllowlistedOperation[];
  readonly poolEnv: {
    readonly PROJECT_RAG_DB_POOL_MAX: PoolEnvEntry;
    readonly PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: PoolEnvEntry;
    readonly PROJECT_RAG_DB_MAX_LIFETIME_MS: PoolEnvEntry;
    readonly DOCS_RAG_PG_LAB_DB_POOL_MAX: PoolEnvEntry;
    readonly DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS: PoolEnvEntry;
    readonly DOCS_RAG_PG_LAB_DB_MAX_LIFETIME_MS: PoolEnvEntry;
  };
  readonly concurrency: number;
  readonly iterations: number;
  readonly total: number;
  readonly success: number;
  readonly error: number;
  readonly timeout: number;
  readonly mutationCalls: number;
  readonly cleanupErrorCount: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly perTool: Record<string, PerToolStats>;
  readonly p95ThresholdMs: number;
  readonly permissionMode: 'read_only';
  readonly watcherEnabled: false;
  readonly failures: readonly string[];
};

export type HarnessArgs = {
  readonly transport: TransportMode;
  readonly concurrency: number;
  readonly iterations: number;
  readonly projectId: string;
  readonly docsQuery: string;
  readonly projectQuery: string;
  readonly sourcePath?: string;
  readonly includeOptionalReads: boolean;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly p95ThresholdMs: number;
  readonly json: boolean;
};

export type WorkerRunOutcome = {
  readonly workerId: number;
  readonly results: readonly CallResult[];
  readonly cleanupErrors: readonly string[];
};

/** Core read-only allowlist. Optional get/outline added when requested. */
export const CORE_ALLOWLIST: readonly AllowlistedOperation[] = [
  'tools/list',
  'search_docs',
  'search_project_code',
] as const;

export const OPTIONAL_READ_ALLOWLIST: readonly AllowlistedOperation[] = [
  'get_project_file',
  'get_project_outline',
] as const;

/** Explicit mutation / write surface that must never be invoked. */
export const MUTATION_TOOLS = [
  'register_project',
  'ingest_project',
  'ingest_project_file',
  'verify_project_index',
  'repair_project_index',
  'cleanup_project',
  'adapt_docs',
  'search_and_adapt',
  'ensure_reranker',
] as const;

export const READ_DEADLINE_CODE = 'READ_DEADLINE_EXCEEDED';

const MUTATION_ACK_ENV_KEYS = new Set([
  'RAG_MCP_PROJECT_CURRENT_MUTATION_ACK',
  'RAG_PROJECT_MUTATION_ACK',
  'MCP_MUTATION_ACK',
]);

const POOL_DEFAULTS = {
  PROJECT_RAG_DB_POOL_MAX: 2,
  PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: 5_000,
  PROJECT_RAG_DB_MAX_LIFETIME_MS: 0,
  DOCS_RAG_PG_LAB_DB_POOL_MAX: 2,
  DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS: 5_000,
  DOCS_RAG_PG_LAB_DB_MAX_LIFETIME_MS: 0,
} as const;

const DEFAULT_P95_THRESHOLD_MS = MCP_CONCURRENCY_P95_THRESHOLDS.standard;

function readFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readNumberFlag(
  args: string[],
  flag: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = readStringFlag(args, flag);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): HarnessArgs {
  const transportRaw = (readStringFlag(argv, '--transport') ?? 'stdio').toLowerCase();
  if (transportRaw !== 'stdio' && transportRaw !== 'http') {
    throw new Error(`Invalid --transport "${transportRaw}". Expected stdio or http.`);
  }
  const transport = transportRaw as TransportMode;

  const iterationsFromCalls = readStringFlag(argv, '--calls');
  const iterations = iterationsFromCalls
    ? readNumberFlag(argv, '--calls', 5, 1, 10_000)
    : readNumberFlag(argv, '--iterations', 5, 1, 10_000);

  const includeOptionalReads = readFlag(argv, '--include-optional-reads');
  const sourcePath = readStringFlag(argv, '--source-path');
  if (includeOptionalReads && !sourcePath) {
    throw new Error('--include-optional-reads requires --source-path');
  }

  const endpoint = readStringFlag(argv, '--endpoint');
  const apiKey = readStringFlag(argv, '--api-key') ?? process.env.MCP_API_KEY;
  if (transport === 'http' && !endpoint) {
    throw new Error('--endpoint is required when --transport http');
  }
  if (transport === 'http' && !apiKey) {
    throw new Error('--api-key or MCP_API_KEY is required when --transport http');
  }

  return {
    transport,
    concurrency: readNumberFlag(argv, '--concurrency', 4, 1, 64),
    iterations,
    projectId: readStringFlag(argv, '--project-id') ?? 'rag-v2-dev',
    docsQuery:
      readStringFlag(argv, '--docs-query') ??
      'React components import and export TypeScript patterns',
    projectQuery: readStringFlag(argv, '--project-query') ?? 'search_project_code',
    sourcePath,
    includeOptionalReads,
    endpoint,
    apiKey,
    cwd: resolve(readStringFlag(argv, '--cwd') ?? cwd),
    timeoutMs: readNumberFlag(argv, '--timeout-ms', 30_000, 1_000, 600_000),
    connectTimeoutMs: readNumberFlag(argv, '--connect-timeout-ms', 30_000, 1_000, 600_000),
    p95ThresholdMs: readNumberFlag(
      argv,
      '--p95-threshold-ms',
      DEFAULT_P95_THRESHOLD_MS,
      1,
      600_000
    ),
    json: !readFlag(argv, '--no-json'),
  };
}

export function resolveAllowlist(includeOptionalReads: boolean): readonly AllowlistedOperation[] {
  return includeOptionalReads
    ? [...CORE_ALLOWLIST, ...OPTIONAL_READ_ALLOWLIST]
    : [...CORE_ALLOWLIST];
}

export function isAllowlistedOperation(
  name: string,
  allowlist: readonly AllowlistedOperation[]
): name is AllowlistedOperation {
  return (allowlist as readonly string[]).includes(name);
}

export function assertAllowlistedOperation(
  name: string,
  allowlist: readonly AllowlistedOperation[]
): AllowlistedOperation {
  if (!isAllowlistedOperation(name, allowlist)) {
    throw new Error(
      `Operation "${name}" is not allowlisted. Allowed: ${allowlist.join(', ')}. Mutation surface is forbidden.`
    );
  }
  if ((MUTATION_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Mutation tool "${name}" is forbidden in the read-only concurrency harness.`);
  }
  return name;
}

export function buildCallPlan(
  allowlist: readonly AllowlistedOperation[],
  iterations: number
): AllowlistedOperation[] {
  if (allowlist.length === 0) {
    throw new Error('Allowlist must not be empty');
  }
  const plan: AllowlistedOperation[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const operation = allowlist[i % allowlist.length];
    if (!operation) {
      throw new Error('Allowlist entry missing while building call plan');
    }
    plan.push(operation);
  }
  return plan;
}

/**
 * Nearest-rank percentile for 0–100 ranks (e.g. 50, 95, 99).
 * Matches scripts/benchmarks/codex-mcp-reliability.ts.
 */
export function percentile(values: readonly number[], percentileRank: number): number {
  if (values.length === 0) {
    return 0;
  }
  if (!Number.isFinite(percentileRank) || percentileRank < 0 || percentileRank > 100) {
    throw new Error(`percentileRank must be between 0 and 100, got ${percentileRank}`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (percentileRank === 0) {
    return sorted[0] ?? 0;
  }
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

export function summarizeLatencies(latencies: readonly number[]): {
  p50: number;
  p95: number;
  p99: number;
} {
  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };
}

export function buildPerToolStats(results: readonly CallResult[]): Record<string, PerToolStats> {
  const byTool = new Map<string, CallResult[]>();
  for (const result of results) {
    const bucket = byTool.get(result.operation) ?? [];
    bucket.push(result);
    byTool.set(result.operation, bucket);
  }

  const stats: Record<string, PerToolStats> = {};
  for (const [operation, toolResults] of byTool) {
    const latencies = toolResults.map((entry) => entry.latencyMs);
    const summary = summarizeLatencies(latencies);
    stats[operation] = {
      total: toolResults.length,
      success: toolResults.filter((entry) => entry.outcome === 'success').length,
      error: toolResults.filter((entry) => entry.outcome === 'error').length,
      timeout: toolResults.filter((entry) => entry.outcome === 'timeout').length,
      p50: summary.p50,
      p95: summary.p95,
      p99: summary.p99,
    };
  }
  return stats;
}

function parsePoolEnvValue(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  allowZero = false
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (allowZero && parsed === 0) {
    return 0;
  }
  if (parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

export function readPoolEnvSnapshot(
  env: NodeJS.ProcessEnv = process.env
): ConcurrencyReport['poolEnv'] {
  return {
    PROJECT_RAG_DB_POOL_MAX: {
      env: env.PROJECT_RAG_DB_POOL_MAX ?? null,
      effective: parsePoolEnvValue(
        env.PROJECT_RAG_DB_POOL_MAX,
        POOL_DEFAULTS.PROJECT_RAG_DB_POOL_MAX,
        1,
        64
      ),
      default: POOL_DEFAULTS.PROJECT_RAG_DB_POOL_MAX,
    },
    PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: {
      env: env.PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS ?? null,
      effective: parsePoolEnvValue(
        env.PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS,
        POOL_DEFAULTS.PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS,
        1_000,
        120_000
      ),
      default: POOL_DEFAULTS.PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS,
    },
    PROJECT_RAG_DB_MAX_LIFETIME_MS: {
      env: env.PROJECT_RAG_DB_MAX_LIFETIME_MS ?? null,
      effective: parsePoolEnvValue(
        env.PROJECT_RAG_DB_MAX_LIFETIME_MS,
        POOL_DEFAULTS.PROJECT_RAG_DB_MAX_LIFETIME_MS,
        60_000,
        86_400_000,
        true
      ),
      default: POOL_DEFAULTS.PROJECT_RAG_DB_MAX_LIFETIME_MS,
    },
    DOCS_RAG_PG_LAB_DB_POOL_MAX: {
      env: env.DOCS_RAG_PG_LAB_DB_POOL_MAX ?? null,
      effective: parsePoolEnvValue(
        env.DOCS_RAG_PG_LAB_DB_POOL_MAX,
        POOL_DEFAULTS.DOCS_RAG_PG_LAB_DB_POOL_MAX,
        1,
        64
      ),
      default: POOL_DEFAULTS.DOCS_RAG_PG_LAB_DB_POOL_MAX,
    },
    DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS: {
      env: env.DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS ?? null,
      effective: parsePoolEnvValue(
        env.DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS,
        POOL_DEFAULTS.DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS,
        1_000,
        120_000
      ),
      default: POOL_DEFAULTS.DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS,
    },
    DOCS_RAG_PG_LAB_DB_MAX_LIFETIME_MS: {
      env: env.DOCS_RAG_PG_LAB_DB_MAX_LIFETIME_MS ?? null,
      effective: parsePoolEnvValue(
        env.DOCS_RAG_PG_LAB_DB_MAX_LIFETIME_MS,
        POOL_DEFAULTS.DOCS_RAG_PG_LAB_DB_MAX_LIFETIME_MS,
        60_000,
        86_400_000,
        true
      ),
      default: POOL_DEFAULTS.DOCS_RAG_PG_LAB_DB_MAX_LIFETIME_MS,
    },
  };
}

export function resolveCommitSha(cwd: string = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.env.GIT_COMMIT ?? process.env.GITHUB_SHA ?? 'unknown';
  }
}

export function countMutationCalls(operations: readonly string[]): number {
  return operations.filter((name) => (MUTATION_TOOLS as readonly string[]).includes(name)).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTimeoutMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadline') ||
    // Structured READ_DEADLINE_EXCEEDED codes are handled authoritatively in
    // classifyToolCallResult; this substring check remains only as
    // defense-in-depth for thrown-string errors lacking a .name to inspect.
    message.includes(READ_DEADLINE_CODE)
  );
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return isTimeoutMessage(String(error));
  }
  return (
    isTimeoutMessage(error.message) ||
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.name === 'ReadDeadlineError'
  );
}

type ToolPayload = {
  success?: boolean;
  error?: { code?: string; message?: string };
  rawText?: string;
  isError?: boolean;
  code?: string;
  message?: string;
};

function extractText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (entry): entry is { type: string; text: string } =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type === 'text' &&
        typeof (entry as { text?: unknown }).text === 'string'
    )
    .map((entry) => entry.text)
    .join('\n');
}

/** Extract MCP tool payload from callTool result (structuredContent or text JSON). */
export function extractToolPayload(result: unknown): ToolPayload {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const isError = Boolean(record.isError);
  const structured = record.structuredContent;
  if (structured && typeof structured === 'object') {
    return {
      ...(structured as ToolPayload),
      isError,
      rawText: extractText(result),
    };
  }

  const rawText = extractText(result);
  if (!rawText) {
    return { isError };
  }

  try {
    return {
      ...(JSON.parse(rawText) as ToolPayload),
      isError,
      rawText,
    };
  } catch {
    return { rawText, isError };
  }
}

function payloadErrorCode(payload: ToolPayload): string | undefined {
  if (typeof payload.error?.code === 'string' && payload.error.code.length > 0) {
    return payload.error.code;
  }
  if (typeof payload.code === 'string' && payload.code.length > 0) {
    return payload.code;
  }
  return undefined;
}

function payloadErrorMessage(payload: ToolPayload): string {
  if (typeof payload.error?.message === 'string' && payload.error.message.length > 0) {
    return payload.error.message;
  }
  if (typeof payload.message === 'string' && payload.message.length > 0) {
    return payload.message;
  }
  if (typeof payload.rawText === 'string' && payload.rawText.length > 0) {
    return payload.rawText;
  }
  return 'tool call failed';
}

/**
 * Classify an MCP callTool result. `isError: true` / `success: false` are
 * always failures. Structured `READ_DEADLINE_EXCEEDED` is classified as
 * timeout. Fuzzy timeout/deadline message matching only runs against failed
 * payloads — never against a successful result's text content, which may
 * legitimately quote words like "timeout" from indexed files.
 */
export function classifyToolCallResult(result: unknown): ClassifiedCall {
  const payload = extractToolPayload(result);
  const code = payloadErrorCode(payload);

  if (code === READ_DEADLINE_CODE) {
    return {
      outcome: 'timeout',
      error: payloadErrorMessage(payload),
      code,
    };
  }

  if (!(payload.isError || payload.success === false)) {
    return { outcome: 'success' };
  }

  // Failed payload: descriptive legacy-withTimeout messages may still carry
  // "timed out"/"deadline" text in the failure message.
  const message = payloadErrorMessage(payload);
  if (isTimeoutMessage(message)) {
    return {
      outcome: 'timeout',
      error: message,
      code: message.includes(READ_DEADLINE_CODE) ? READ_DEADLINE_CODE : undefined,
    };
  }

  return {
    outcome: 'error',
    error: message,
    code,
  };
}

/** Classify a thrown client/transport/connect error. */
export function classifyThrownError(error: unknown): ClassifiedCall {
  const message = errorMessage(error);
  if (isTimeoutError(error)) {
    return {
      outcome: 'timeout',
      error: message,
      code: message.includes(READ_DEADLINE_CODE) ? READ_DEADLINE_CODE : undefined,
    };
  }
  return { outcome: 'error', error: message };
}

/**
 * Fold a worker connect failure into per-operation error/timeout results so the
 * harness always emits a JSON report instead of crashing without evidence.
 */
export function foldConnectFailure(
  workerId: number,
  plan: readonly AllowlistedOperation[],
  error: unknown
): CallResult[] {
  const classified = classifyThrownError(error);
  const prefix = `connect: ${classified.error ?? 'unknown connect failure'}`;
  return plan.map((operation, index) => ({
    workerId,
    index,
    operation,
    outcome: classified.outcome,
    latencyMs: 0,
    error: prefix,
    code: classified.code,
  }));
}

/**
 * Merge Promise.allSettled worker outcomes into flat results + cleanup errors.
 * Rejected workers without folded results become synthetic connect failures.
 */
export function mergeSettledWorkerOutcomes(
  settled: readonly PromiseSettledResult<WorkerRunOutcome>[],
  plan: readonly AllowlistedOperation[]
): {
  readonly results: CallResult[];
  readonly cleanupErrors: string[];
  readonly settlementFailures: string[];
} {
  const results: CallResult[] = [];
  const cleanupErrors: string[] = [];
  const settlementFailures: string[] = [];

  settled.forEach((entry, workerId) => {
    if (entry.status === 'fulfilled') {
      results.push(...entry.value.results);
      cleanupErrors.push(...entry.value.cleanupErrors);
      return;
    }
    const reason = entry.reason;
    const message = errorMessage(reason);
    settlementFailures.push(`worker=${workerId} connect/settlement rejected: ${message}`);
    results.push(...foldConnectFailure(workerId, plan, reason));
  });

  return { results, cleanupErrors, settlementFailures };
}

export function buildReport(input: {
  readonly commitSha: string;
  readonly transport: TransportMode;
  readonly allowlist: readonly AllowlistedOperation[];
  readonly poolEnv: ConcurrencyReport['poolEnv'];
  readonly concurrency: number;
  readonly iterations: number;
  readonly results: readonly CallResult[];
  readonly p95ThresholdMs: number;
  readonly mutationCalls?: number;
  readonly cleanupErrors?: readonly string[];
  readonly extraFailures?: readonly string[];
}): ConcurrencyReport {
  const { results, p95ThresholdMs } = input;
  const cleanupErrors = [...(input.cleanupErrors ?? [])];
  const success = results.filter((entry) => entry.outcome === 'success').length;
  const error = results.filter((entry) => entry.outcome === 'error').length;
  const timeout = results.filter((entry) => entry.outcome === 'timeout').length;
  const latencies = results.map((entry) => entry.latencyMs);
  const summary = summarizeLatencies(latencies);
  const perTool = buildPerToolStats(results);
  const mutationCalls =
    input.mutationCalls ?? countMutationCalls(results.map((entry) => entry.operation));
  const failures: string[] = results
    .filter((entry) => entry.outcome !== 'success')
    .map(
      (entry) =>
        `worker=${entry.workerId} op=${entry.operation} outcome=${entry.outcome}${entry.error ? ` error=${entry.error}` : ''}${entry.code ? ` code=${entry.code}` : ''}`
    );

  for (const cleanupError of cleanupErrors) {
    failures.push(`cleanup: ${cleanupError}`);
  }
  for (const extra of input.extraFailures ?? []) {
    failures.push(extra);
  }

  if (results.length === 0) {
    failures.push('total=0 (no calls recorded)');
  }
  if (mutationCalls > 0) {
    failures.push(`mutationCalls=${mutationCalls} (must be 0)`);
  }
  if (results.length > 0 && summary.p95 > p95ThresholdMs) {
    failures.push(`p95=${summary.p95}ms exceeds threshold ${p95ThresholdMs}ms`);
  }
  for (const [operation, toolSummary] of Object.entries(perTool)) {
    if (toolSummary.p95 > p95ThresholdMs) {
      failures.push(`${operation}.p95=${toolSummary.p95}ms exceeds threshold ${p95ThresholdMs}ms`);
    }
  }
  if (cleanupErrors.length > 0) {
    failures.push(`cleanupErrorCount=${cleanupErrors.length}`);
  }

  const ok =
    results.length > 0 &&
    error === 0 &&
    timeout === 0 &&
    mutationCalls === 0 &&
    cleanupErrors.length === 0 &&
    summary.p95 <= p95ThresholdMs &&
    Object.values(perTool).every((toolSummary) => toolSummary.p95 <= p95ThresholdMs);

  return {
    ok,
    commitSha: input.commitSha,
    transport: input.transport,
    allowlist: [...input.allowlist],
    poolEnv: input.poolEnv,
    concurrency: input.concurrency,
    iterations: input.iterations,
    total: results.length,
    success,
    error,
    timeout,
    mutationCalls,
    cleanupErrorCount: cleanupErrors.length,
    p50: summary.p50,
    p95: summary.p95,
    p99: summary.p99,
    perTool,
    p95ThresholdMs,
    permissionMode: 'read_only',
    watcherEnabled: false,
    failures,
  };
}

export function validateReport(report: ConcurrencyReport): {
  readonly valid: boolean;
  readonly issues: string[];
} {
  const issues: string[] = [];
  if (!report.commitSha) {
    issues.push('commitSha is required');
  }
  if (report.transport !== 'stdio' && report.transport !== 'http') {
    issues.push('transport must be stdio or http');
  }
  if (!Array.isArray(report.allowlist) || report.allowlist.length === 0) {
    issues.push('allowlist must be a non-empty array');
  }
  for (const op of report.allowlist) {
    if (![...CORE_ALLOWLIST, ...OPTIONAL_READ_ALLOWLIST].includes(op)) {
      issues.push(`allowlist contains non-read-only operation: ${op}`);
    }
  }
  if (report.mutationCalls !== 0) {
    issues.push('mutationCalls must be 0');
  }
  if (report.permissionMode !== 'read_only') {
    issues.push('permissionMode must be read_only');
  }
  if (report.watcherEnabled !== false) {
    issues.push('watcherEnabled must be false');
  }
  if (typeof report.total !== 'number' || report.total <= 0) {
    issues.push('total must be > 0');
  }
  if (report.success + report.error + report.timeout !== report.total) {
    issues.push('success + error + timeout must equal total');
  }
  if (
    typeof report.p50 !== 'number' ||
    typeof report.p95 !== 'number' ||
    typeof report.p99 !== 'number'
  ) {
    issues.push('p50/p95/p99 must be numbers');
  }
  if (!report.poolEnv || typeof report.poolEnv !== 'object') {
    issues.push('poolEnv is required');
  }
  if (!report.perTool || typeof report.perTool !== 'object') {
    issues.push('perTool is required');
  }
  if (typeof report.cleanupErrorCount !== 'number' || report.cleanupErrorCount < 0) {
    issues.push('cleanupErrorCount must be a non-negative number');
  }
  if (report.ok && report.total <= 0) {
    issues.push('ok requires total > 0');
  }
  if (report.ok && (report.error > 0 || report.timeout > 0 || report.cleanupErrorCount > 0)) {
    issues.push('ok requires zero errors, timeouts, and cleanup errors');
  }
  return { valid: issues.length === 0, issues };
}

export function buildReadOnlyEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) {
      continue;
    }
    if (MUTATION_ACK_ENV_KEYS.has(key)) {
      continue;
    }
    env[key] = value;
  }
  env.MCP_PERMISSION_MODE = 'read_only';
  env.RAG_PROJECT_WATCHER_ENABLED = 'false';
  env.RAG_PROJECT_SESSION_INTENT = 'read_only';
  return env;
}

/** Build allowlisted tool arguments. Project search uses hybrid mode. */
export function buildToolArguments(
  operation: AllowlistedOperation,
  args: HarnessArgs
): Record<string, unknown> | null {
  switch (operation) {
    case 'tools/list':
      return null;
    case 'search_docs':
      return { query: args.docsQuery, limit: 5 };
    case 'search_project_code':
      return {
        projectId: args.projectId,
        query: args.projectQuery,
        limit: 5,
        mode: 'hybrid',
      };
    case 'get_project_file':
      return {
        projectId: args.projectId,
        sourcePath: args.sourcePath,
      };
    case 'get_project_outline':
      return {
        projectId: args.projectId,
        sourcePath: args.sourcePath,
      };
  }
}

async function executeOperation(
  client: Client,
  operation: AllowlistedOperation,
  args: HarnessArgs,
  allowlist: readonly AllowlistedOperation[]
): Promise<ClassifiedCall> {
  assertAllowlistedOperation(operation, allowlist);
  if (operation === 'tools/list') {
    await client.listTools();
    return { outcome: 'success' };
  }
  const toolArgs = buildToolArguments(operation, args);
  const result = await client.callTool({ name: operation, arguments: toolArgs ?? {} }, undefined, {
    timeout: args.timeoutMs,
  });
  return classifyToolCallResult(result);
}

async function runCallPlan(
  client: Client,
  workerId: number,
  plan: readonly AllowlistedOperation[],
  args: HarnessArgs,
  allowlist: readonly AllowlistedOperation[]
): Promise<CallResult[]> {
  const results: CallResult[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    const operation = plan[index];
    if (!operation) {
      continue;
    }
    const started = performance.now();
    try {
      const classified = await executeOperation(client, operation, args, allowlist);
      results.push({
        workerId,
        index,
        operation,
        outcome: classified.outcome,
        latencyMs: Math.round(performance.now() - started),
        error: classified.error,
        code: classified.code,
      });
    } catch (error) {
      const classified = classifyThrownError(error);
      results.push({
        workerId,
        index,
        operation,
        outcome: classified.outcome,
        latencyMs: Math.round(performance.now() - started),
        error: classified.error,
        code: classified.code,
      });
    }
  }
  return results;
}

type CloseableSession = {
  readonly client: Client;
  readonly close: () => Promise<string[]>;
};

async function collectCloseErrors(
  label: string,
  closeFn: () => Promise<void> | void
): Promise<string[]> {
  try {
    await closeFn();
    return [];
  } catch (error) {
    return [`${label}: ${errorMessage(error)}`];
  }
}

async function createStdioClient(args: HarnessArgs, workerId: number): Promise<CloseableSession> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['mcp/launcher.ts'],
    cwd: args.cwd,
    env: buildReadOnlyEnv(process.env),
  });
  const client = new Client(
    {
      name: `mcp-concurrency-harness-stdio-${workerId}`,
      version: '1.0.0',
    },
    { capabilities: {} }
  );
  await client.connect(transport, { timeout: args.connectTimeoutMs });
  return {
    client,
    close: async () => {
      const clientErrors = await collectCloseErrors('client.close', () => client.close());
      const transportErrors = await collectCloseErrors('transport.close', () => transport.close());
      return [...clientErrors, ...transportErrors];
    },
  };
}

/**
 * Shared HTTP mode uses the official Streamable HTTP client transport against
 * the existing MCP `/mcp` endpoint (Bearer auth). Session IDs are managed by
 * the SDK; this harness does not invent protocol.
 */
async function createHttpClient(args: HarnessArgs, workerId: number): Promise<CloseableSession> {
  if (!args.endpoint || !args.apiKey) {
    throw new Error('HTTP transport requires endpoint and apiKey');
  }
  const transport = new StreamableHTTPClientTransport(new URL(args.endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
      },
    },
  });
  const client = new Client(
    {
      name: `mcp-concurrency-harness-http-${workerId}`,
      version: '1.0.0',
    },
    { capabilities: {} }
  );
  await client.connect(transport, { timeout: args.connectTimeoutMs });
  return {
    client,
    close: async () => {
      const clientErrors = await collectCloseErrors('client.close', () => client.close());
      const transportErrors = await collectCloseErrors('transport.close', () => transport.close());
      return [...clientErrors, ...transportErrors];
    },
  };
}

async function runWorker(
  workerId: number,
  plan: readonly AllowlistedOperation[],
  args: HarnessArgs,
  allowlist: readonly AllowlistedOperation[]
): Promise<WorkerRunOutcome> {
  let session: CloseableSession | undefined;
  try {
    session =
      args.transport === 'stdio'
        ? await createStdioClient(args, workerId)
        : await createHttpClient(args, workerId);
  } catch (error) {
    return {
      workerId,
      results: foldConnectFailure(workerId, plan, error),
      cleanupErrors: [],
    };
  }

  try {
    const results = await runCallPlan(session.client, workerId, plan, args, allowlist);
    const cleanupErrors = await session.close();
    return { workerId, results, cleanupErrors };
  } catch (error) {
    const cleanupErrors = await session.close();
    return {
      workerId,
      results: foldConnectFailure(workerId, plan, error),
      cleanupErrors,
    };
  }
}

export async function runConcurrencyHarness(args: HarnessArgs): Promise<ConcurrencyReport> {
  const allowlist = resolveAllowlist(args.includeOptionalReads);
  const plan = buildCallPlan(allowlist, args.iterations);
  // Enforce allowlist before any network/process work.
  for (const operation of plan) {
    assertAllowlistedOperation(operation, allowlist);
  }

  const settled = await Promise.allSettled(
    Array.from({ length: args.concurrency }, (_, workerId) =>
      runWorker(workerId, plan, args, allowlist)
    )
  );
  const merged = mergeSettledWorkerOutcomes(settled, plan);

  return buildReport({
    commitSha: resolveCommitSha(args.cwd),
    transport: args.transport,
    allowlist,
    poolEnv: readPoolEnvSnapshot(process.env),
    concurrency: args.concurrency,
    iterations: args.iterations,
    results: merged.results,
    p95ThresholdMs: args.p95ThresholdMs,
    mutationCalls: 0,
    cleanupErrors: merged.cleanupErrors,
    extraFailures: merged.settlementFailures,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runConcurrencyHarness(args);

  if (args.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log('MCP read-only concurrency harness');
    console.log(`transport=${report.transport} concurrency=${report.concurrency}`);
    console.log(
      `total=${report.total} success=${report.success} error=${report.error} timeout=${report.timeout}`
    );
    console.log(
      `p50=${report.p50} p95=${report.p95} p99=${report.p99} threshold=${report.p95ThresholdMs}`
    );
    console.log(
      `mutationCalls=${report.mutationCalls} cleanupErrorCount=${report.cleanupErrorCount} ok=${report.ok}`
    );
    if (report.failures.length > 0) {
      console.log('failures:');
      for (const failure of report.failures) {
        console.log(`- ${failure}`);
      }
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    // Last-resort path: still try to emit a minimal failing JSON report.
    const message = error instanceof Error ? error.message : String(error);
    const fallback = buildReport({
      commitSha: resolveCommitSha(process.cwd()),
      transport: 'stdio',
      allowlist: [...CORE_ALLOWLIST],
      poolEnv: readPoolEnvSnapshot(process.env),
      concurrency: 0,
      iterations: 0,
      results: [
        {
          workerId: -1,
          index: 0,
          operation: 'tools/list',
          outcome: 'error',
          latencyMs: 0,
          error: message,
        },
      ],
      p95ThresholdMs: DEFAULT_P95_THRESHOLD_MS,
      mutationCalls: 0,
      extraFailures: [`fatal: ${message}`],
    });
    console.log(JSON.stringify(fallback));
    process.exit(1);
  });
}
