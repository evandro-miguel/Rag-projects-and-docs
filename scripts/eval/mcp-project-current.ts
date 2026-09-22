import '../lib/runtime-env.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { suggestProjectIncludeRoots } from '../../lib/shared/project-include-roots.js';
import {
  createProjectSlug,
  inferProjectNameFromRootPath,
} from '../../lib/shared/project-registry.js';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../lib/shared/project-scope-advisory.js';
import { resolveProjectRagPostgresConfig } from '../project-rag/config.js';
import {
  PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL,
  PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
  PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
} from '../project-rag/embeddings.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
} from '../project-rag/store.js';

type Mode = 'contract' | 'repair';

type Args = {
  mode: Mode;
  json: boolean;
  jsonOutPath?: string;
  cwd: string;
  projectRoot: string;
  projectName: string;
  projectSlug: string;
  includeRoots: string[];
  maxFiles: number;
  offset: number;
  ingestTimeoutMs: number;
  searchQuery: string;
};

const CURRENT_REPO_INCLUDE_ROOTS = [
  'mcp',
  'lib',
  'scripts',
  'docs',
  'infra',
  '.github',
  'skills',
  'tests',
] as const;
const MCP_CONNECT_TIMEOUT_MS = 120000;
const REPAIR_BATCH_HARD_CAP = 10;
const MUTATION_ACK_ENV = 'RAG_MCP_PROJECT_CURRENT_MUTATION_ACK';

export function buildProjectSearchArguments(projectId: string, query: string, limit = 5) {
  return {
    projectId,
    query,
    limit,
    mode: 'hybrid' as const,
  };
}

type ToolPayload = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; timestamp?: string };
  rawText?: string;
  isError?: boolean;
  [key: string]: unknown;
};

type VerifyIndexData = {
  projectId?: string;
  fileCount?: number;
  freshness?: {
    status?: string;
    stalePaths?: string[];
    staleFiles?: number;
    missingFiles?: number;
    checkedFiles?: number;
  };
  scopeCoverage?: {
    status?: string;
    missingExpectedPaths?: string[];
    extraIndexedPaths?: string[];
    ignoredIndexedPaths?: string[];
    missingExpectedFiles?: number;
    extraIndexedFiles?: number;
    ignoredIndexedFiles?: number;
  };
};

type SearchResult = {
  sourcePath?: string;
};

type SearchEmbeddingEvidence = {
  provider?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  dimensions?: unknown;
};

type OutlineData = {
  symbols?: Array<{ name?: string }>;
};

type PhaseStatus = 'passed' | 'failed' | 'skipped';

type PhaseResult = {
  name: string;
  status: PhaseStatus;
  latencyMs: number;
  detail?: string;
};

type FailureCode =
  | 'freshness_precondition_failed'
  | 'project_not_indexed'
  | 'ingest_request_timeout'
  | 'runtime_function_timeout'
  | 'embedding_lane_mismatch'
  | 'repair_incomplete'
  | 'contract_step_failed';

type RunSummary = {
  ok: boolean;
  mode: Mode;
  failureCode?: FailureCode;
  failedPhase?: string;
  projectId?: string;
  freshnessStatus?: string;
  staleCount?: number;
  scopeDriftCount?: number;
  batchOffset?: number;
  batchSize?: number;
  batchCandidates?: number;
  processedBatchCount?: number;
  remainingCount?: number;
  nextOffset?: number;
  reindexedCount?: number;
  skippedMissingCount?: number;
  timedOutCount?: number;
  postVerifyStatus?: 'complete' | 'timeout';
  postVerifyDetail?: string;
  phaseTimingsMs: Record<string, number>;
  phases: PhaseResult[];
  message?: string;
};

type FreshnessSnapshot = {
  status?: string;
  stalePaths: string[];
  staleCount: number;
  missingCount: number;
  fileCount: number;
};

type ScopeCoverageSnapshot = {
  status?: string;
  missingExpectedPaths: string[];
  extraIndexedPaths: string[];
  ignoredIndexedPaths: string[];
  missingExpectedCount: number;
  extraIndexedCount: number;
  ignoredIndexedCount: number;
};

type ReconciliationSnapshot = {
  freshness: FreshnessSnapshot;
  scopeCoverage: ScopeCoverageSnapshot;
  candidatePaths: string[];
  candidateCount: number;
  candidatePathCount: number;
};

type RepairPostVerifyOutcome =
  | {
      kind: 'complete';
      latencyMs: number;
      reconciliation: ReconciliationSnapshot;
    }
  | {
      kind: 'timeout';
      latencyMs: number;
      message: string;
    };

function readFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readMode(args: string[]): Mode {
  const candidate = (args[0] ?? '').toLowerCase();
  return candidate === 'repair' ? 'repair' : 'contract';
}

function defaultIncludeRoots(projectRoot: string): string[] {
  const currentRepoRoots = CURRENT_REPO_INCLUDE_ROOTS.filter((includeRoot) =>
    existsSync(resolve(projectRoot, includeRoot))
  );
  return currentRepoRoots.length > 0 ? currentRepoRoots : suggestProjectIncludeRoots(projectRoot);
}

/**
 * Resolve project includeRoots, preferring an existing project's configuration
 * to prevent accidental overwrite during repeated evaluations.
 *
 * When an existing project is found in the database, its includeRoots are
 * returned unchanged.  If the lookup fails or returns no roots, the computed
 * (fallback) roots are used instead, so the script never blocks on an
 * unavailable database.
 *
 * @param projectSlug  - Project slug to look up
 * @param computedRoots - Fallback roots (CLI-provided or hardcoded defaults)
 * @param lookupExisting - Async callback that returns the existing project
 *                         or undefined when no project is found
 * @returns The resolved includeRoots to use for registration
 */
export async function resolveProjectIncludeRoots(
  projectSlug: string,
  computedRoots: string[],
  lookupExisting: (slug: string) => Promise<{ includeRoots: string[] } | undefined>
): Promise<string[]> {
  try {
    const existing = await lookupExisting(projectSlug);
    if (existing?.includeRoots && existing.includeRoots.length > 0) {
      console.error(
        `[mcp-project-current] Preserving existing includeRoots for ${projectSlug}: ${existing.includeRoots.join(', ')}`
      );
      return existing.includeRoots;
    }
  } catch {
    // DB unavailable or lookup failure — proceed with computed roots
  }
  return computedRoots;
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): Args {
  const mode = readMode(argv);
  const resolvedCwd = resolve(readStringFlag(argv, '--cwd') ?? cwd);
  const projectRoot = resolve(readStringFlag(argv, '--project-root') ?? resolvedCwd);
  const projectName =
    readStringFlag(argv, '--project-name') ?? inferProjectNameFromRootPath(projectRoot);
  const projectSlug =
    readStringFlag(argv, '--project-slug') ??
    process.env.PROJECT_RAG_PROJECT_SLUG ??
    createProjectSlug(projectName);
  const includeRoots =
    readStringFlag(argv, '--include-roots')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? defaultIncludeRoots(projectRoot);

  if (includeRoots.length === 0) {
    throw new Error(
      `No include roots could be determined for ${projectRoot}. Pass --include-roots <dir,dir>.`
    );
  }

  const maxFilesRaw = Number.parseInt(readStringFlag(argv, '--max-files') ?? '10', 10);
  const maxFilesUpperBound = mode === 'repair' ? REPAIR_BATCH_HARD_CAP : 1000;
  const maxFiles = Number.isFinite(maxFilesRaw)
    ? Math.min(Math.max(maxFilesRaw, 1), maxFilesUpperBound)
    : 10;
  const offsetRaw = Number.parseInt(readStringFlag(argv, '--offset') ?? '0', 10);
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
  const ingestTimeoutRaw = Number.parseInt(
    readStringFlag(argv, '--ingest-timeout-ms') ?? '12000',
    10
  );
  const ingestTimeoutMs = Number.isFinite(ingestTimeoutRaw)
    ? Math.min(Math.max(ingestTimeoutRaw, 1000), 120000)
    : 12000;

  const json = readFlag(argv, '--json');
  const jsonOutPath = json
    ? resolve(
        readStringFlag(argv, '--json-out') ??
          join(resolvedCwd, '.tmp', 'mcp-project-current-last.json')
      )
    : undefined;

  return {
    mode,
    json,
    jsonOutPath,
    cwd: resolvedCwd,
    projectRoot,
    projectName,
    projectSlug,
    includeRoots,
    maxFiles,
    offset,
    ingestTimeoutMs,
    searchQuery: readStringFlag(argv, '--search-query') ?? 'mcp-project-current',
  };
}

export function createMachineReadableResultLine(summary: RunSummary): string {
  return `MCP_PROJECT_CURRENT_RESULT ${JSON.stringify(summary)}`;
}

function persistJsonArtifact(pathValue: string, summary: RunSummary) {
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

function extractPayload(result: any): ToolPayload {
  const text = Array.isArray(result?.content)
    ? result.content
        .filter((entry: any) => entry?.type === 'text' && typeof entry.text === 'string')
        .map((entry: any) => entry.text)
        .join('\n')
    : '';

  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object') {
    const merged: ToolPayload & { rawText?: string } = {
      ...(structured as ToolPayload),
      isError: Boolean(result?.isError),
    };
    // When structuredContent.error is stripped by SDK, fall back to rawText
    if (!merged.error?.message && text) {
      merged.rawText = text;
    }
    return merged;
  }

  if (!text) {
    return { isError: Boolean(result?.isError) };
  }

  try {
    return {
      ...(JSON.parse(text) as ToolPayload),
      rawText: text,
      isError: Boolean(result?.isError),
    };
  } catch {
    return { rawText: text, isError: Boolean(result?.isError) };
  }
}

function requireSuccess(step: string, payload: ToolPayload): ToolPayload {
  if (payload.isError || payload.success === false) {
    throw new Error(`${step} failed: ${payload.error?.message ?? 'unknown MCP tool failure'}`);
  }
  return payload;
}

function requireToolResponse(step: string, payload: ToolPayload): ToolPayload {
  if (payload.isError) {
    const message =
      payload.error?.message ??
      (typeof payload.rawText === 'string' && payload.rawText.length > 0
        ? payload.rawText
        : 'unknown MCP tool failure');
    throw new Error(`${step} failed: ${message}`);
  }
  return payload;
}

export function requireProjectMcpAvailability(payload: ToolPayload): ToolPayload {
  if (payload.rawText?.includes('MCP Server: OK')) {
    return payload;
  }

  throw new Error('health_check failed: MCP server availability was not proven');
}

export function requireProjectSearchEmbeddingEvidence(payload: ToolPayload): void {
  const evidence = payload.data?.embeddingConfig as SearchEmbeddingEvidence | undefined;
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('embedding_lane_mismatch: search_project_code returned no embedding evidence');
  }
  if (evidence.provider !== 'llamacpp') {
    throw new Error(
      `embedding_lane_mismatch: provider=${String(evidence.provider)} expected=llamacpp`
    );
  }
  if (evidence.model !== PROJECT_RAG_POSTGRES_EMBEDDING_MODEL) {
    throw new Error(
      `embedding_lane_mismatch: model=${String(evidence.model)} expected=${PROJECT_RAG_POSTGRES_EMBEDDING_MODEL}`
    );
  }
  if (evidence.baseUrl !== PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL) {
    throw new Error(
      `embedding_lane_mismatch: baseUrl=${String(evidence.baseUrl)} expected=${PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL}`
    );
  }
  if (evidence.dimensions !== PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding_lane_mismatch: dimensions=${String(evidence.dimensions)} expected=${PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS}`
    );
  }
}

export function requireVerifyPayload(
  step: string,
  payload: ToolPayload,
  options: { allowBlockedGate?: boolean } = {}
): ToolPayload {
  const gateSignal = payload.data?.gateSignal as { ready?: unknown } | undefined;
  if (
    options.allowBlockedGate &&
    payload.isError &&
    payload.success === false &&
    typeof gateSignal?.ready === 'boolean'
  ) {
    return payload;
  }
  return requireToolResponse(step, payload);
}

function extractProjectId(payload: ToolPayload): string | undefined {
  const direct = payload.data?.projectId;
  if (typeof direct === 'string') {
    return direct;
  }
  const fromText = payload.rawText?.match(/"projectId"\s*:\s*"([^"]+)"/)?.[1];
  return fromText;
}

function extractFreshness(payload: ToolPayload): FreshnessSnapshot {
  const structured = payload.data as VerifyIndexData | undefined;
  const freshness = structured?.freshness;
  const status = freshness?.status;
  const stalePaths = Array.isArray(freshness?.stalePaths)
    ? freshness?.stalePaths.filter((value): value is string => typeof value === 'string')
    : [];
  const staleCount =
    typeof freshness?.staleFiles === 'number' ? freshness.staleFiles : stalePaths.length;
  const missingCount = typeof freshness?.missingFiles === 'number' ? freshness.missingFiles : 0;
  const fileCount = typeof structured?.fileCount === 'number' ? structured.fileCount : 0;
  return { status, stalePaths, staleCount, missingCount, fileCount };
}

function extractScopeCoverage(payload: ToolPayload): ScopeCoverageSnapshot {
  const structured = payload.data as VerifyIndexData | undefined;
  const scopeCoverage = structured?.scopeCoverage;
  const missingExpectedPaths = Array.isArray(scopeCoverage?.missingExpectedPaths)
    ? scopeCoverage?.missingExpectedPaths.filter(
        (value): value is string => typeof value === 'string'
      )
    : [];
  const extraIndexedPaths = Array.isArray(scopeCoverage?.extraIndexedPaths)
    ? scopeCoverage?.extraIndexedPaths.filter((value): value is string => typeof value === 'string')
    : [];
  const ignoredIndexedPaths = Array.isArray(scopeCoverage?.ignoredIndexedPaths)
    ? scopeCoverage?.ignoredIndexedPaths.filter(
        (value): value is string => typeof value === 'string'
      )
    : [];

  const missingExpectedCount =
    typeof scopeCoverage?.missingExpectedFiles === 'number'
      ? scopeCoverage.missingExpectedFiles
      : missingExpectedPaths.length;
  const extraIndexedCount =
    typeof scopeCoverage?.extraIndexedFiles === 'number'
      ? scopeCoverage.extraIndexedFiles
      : extraIndexedPaths.length;
  const ignoredIndexedCount =
    typeof scopeCoverage?.ignoredIndexedFiles === 'number'
      ? scopeCoverage.ignoredIndexedFiles
      : ignoredIndexedPaths.length;

  return {
    status: scopeCoverage?.status,
    missingExpectedPaths,
    extraIndexedPaths,
    ignoredIndexedPaths,
    missingExpectedCount,
    extraIndexedCount,
    ignoredIndexedCount,
  };
}

function buildReconciliationSnapshot(payload: ToolPayload): ReconciliationSnapshot {
  const freshness = extractFreshness(payload);
  const scopeCoverage = extractScopeCoverage(payload);
  const candidatePaths = [
    ...freshness.stalePaths,
    ...scopeCoverage.missingExpectedPaths,
    ...scopeCoverage.extraIndexedPaths,
    ...scopeCoverage.ignoredIndexedPaths,
  ];
  const candidateCount =
    freshness.staleCount +
    freshness.missingCount +
    scopeCoverage.missingExpectedCount +
    scopeCoverage.extraIndexedCount +
    scopeCoverage.ignoredIndexedCount;

  return {
    freshness,
    scopeCoverage,
    candidatePaths,
    candidateCount,
    candidatePathCount: candidatePaths.length,
  };
}

export function finalizeRepairSummary(params: {
  summary: RunSummary;
  phases: PhaseResult[];
  phaseTimingsMs: Record<string, number>;
  verifyAfterOutcome: RepairPostVerifyOutcome;
  reindexedCount: number;
  skippedMissingCount: number;
  timedOutCount: number;
  batchCandidates: number;
  offset: number;
  maxFiles: number;
}) {
  const {
    summary,
    phases,
    phaseTimingsMs,
    verifyAfterOutcome,
    reindexedCount,
    skippedMissingCount,
    timedOutCount,
    batchCandidates,
    offset,
    maxFiles,
  } = params;

  const confirmedBatchCount = reindexedCount + skippedMissingCount;

  phaseTimingsMs.verify_project_index_after = verifyAfterOutcome.latencyMs;
  if (verifyAfterOutcome.kind === 'complete') {
    phases.push({
      name: 'verify_project_index_after',
      status: 'passed',
      latencyMs: verifyAfterOutcome.latencyMs,
      detail:
        `status=${verifyAfterOutcome.reconciliation.freshness.status ?? 'unknown'} ` +
        `drift=${verifyAfterOutcome.reconciliation.candidateCount} ` +
        `stale=${verifyAfterOutcome.reconciliation.freshness.staleCount} ` +
        `missing=${verifyAfterOutcome.reconciliation.freshness.missingCount}`,
    });
    summary.postVerifyStatus = 'complete';
  } else {
    phases.push({
      name: 'verify_project_index_after',
      status: 'skipped',
      latencyMs: verifyAfterOutcome.latencyMs,
      detail: `timeout_tolerated: ${verifyAfterOutcome.message}`,
    });
    summary.postVerifyStatus = 'timeout';
    summary.postVerifyDetail = verifyAfterOutcome.message;
  }

  summary.batchOffset = offset;
  summary.batchSize = maxFiles;
  summary.batchCandidates = batchCandidates;
  summary.processedBatchCount = confirmedBatchCount + timedOutCount;

  if (verifyAfterOutcome.kind === 'complete') {
    summary.freshnessStatus = verifyAfterOutcome.reconciliation.freshness.status;
    summary.staleCount = verifyAfterOutcome.reconciliation.candidateCount;
    summary.scopeDriftCount =
      verifyAfterOutcome.reconciliation.scopeCoverage.missingExpectedCount +
      verifyAfterOutcome.reconciliation.scopeCoverage.extraIndexedCount +
      verifyAfterOutcome.reconciliation.scopeCoverage.ignoredIndexedCount;
    summary.remainingCount = verifyAfterOutcome.reconciliation.candidateCount;
  } else {
    summary.remainingCount = Math.max(
      (summary.staleCount ?? 0) - (reindexedCount + skippedMissingCount),
      0
    );
  }

  summary.reindexedCount = reindexedCount;
  summary.skippedMissingCount = skippedMissingCount;
  summary.timedOutCount = timedOutCount;
  // A completed post-verify rebuilds the candidate list without the repaired
  // paths, so the next batch must start at the beginning of that new list.
  // When verification times out, keep advancing conservatively through the
  // original unverified list instead.
  summary.nextOffset = verifyAfterOutcome.kind === 'complete' ? 0 : offset + confirmedBatchCount;

  const madeProgress = reindexedCount > 0 || skippedMissingCount > 0 || timedOutCount > 0;
  const hasRemainingDrift = (summary.remainingCount ?? 0) > 0;
  const noRepairNeeded =
    batchCandidates === 0 &&
    verifyAfterOutcome.kind === 'complete' &&
    !hasRemainingDrift &&
    (summary.freshnessStatus === 'fresh' ||
      summary.freshnessStatus === 'fresh_with_metadata_drift');

  if (!madeProgress && !noRepairNeeded) {
    throw new Error('repair_incomplete: no files processed in batch');
  }

  if (summary.postVerifyStatus === 'timeout') {
    summary.ok = false;
    summary.failedPhase = 'verify_project_index_after';
    summary.failureCode = classifyFailureCode(summary.postVerifyDetail ?? '');
    summary.message = `repair_batch_applied_unverified: processed=${summary.processedBatchCount ?? 0} reindexed=${reindexedCount} timedOut=${timedOutCount} remainingEstimate=${summary.remainingCount ?? 0} nextOffset=${summary.nextOffset ?? 0} postVerify=timeout`;
  } else if (hasRemainingDrift) {
    summary.ok = false;
    summary.failedPhase = 'verify_project_index_after';
    summary.failureCode = 'freshness_precondition_failed';
    summary.message = `repair_batch_applied: processed=${summary.processedBatchCount ?? 0} reindexed=${reindexedCount} timedOut=${timedOutCount} remaining=${summary.remainingCount ?? 0} nextOffset=${summary.nextOffset ?? 0}`;
  } else {
    summary.ok = true;
    summary.message = noRepairNeeded
      ? 'Project current-repo repair passed: no stale files found'
      : 'Project current-repo repair passed';
  }
}

export function classifyFailureCode(message: string): FailureCode {
  if (message.includes('freshness_precondition_failed')) {
    return 'freshness_precondition_failed';
  }
  if (message.includes('project_not_indexed')) {
    return 'project_not_indexed';
  }
  if (message.includes('repair_incomplete')) {
    return 'repair_incomplete';
  }
  if (message.includes('embedding_lane_mismatch')) {
    return 'embedding_lane_mismatch';
  }
  if (message.includes('Function execution timed out')) {
    return 'runtime_function_timeout';
  }
  if (message.includes('Request timed out')) {
    return 'ingest_request_timeout';
  }
  return 'contract_step_failed';
}

export function isTimeoutLikeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    message.includes('Request timed out') ||
    message.includes('MCP error -32001') ||
    message.includes('timeout after') ||
    message.includes('RequestTimeout') ||
    message.includes('AbortError') ||
    normalized.includes('too many requests') ||
    normalized.includes('rate limit') ||
    normalized.includes('throttl') ||
    /\b429\b/.test(normalized)
  );
}

export function selectRepairCandidates(
  stalePaths: string[],
  maxFiles: number,
  offset: number = 0
): string[] {
  const deterministic = [...new Set(stalePaths.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
  const start = Math.max(offset, 0);
  return deterministic.slice(start, start + maxFiles);
}

export async function callToolWithTimeout<T>(
  operation: string,
  timeoutMs: number,
  action: (options: { timeout: number }) => Promise<T>
): Promise<T> {
  try {
    return await action({ timeout: timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    if (isAbortError || isTimeoutLikeError(message)) {
      throw new Error(`${operation} timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

function firstSymbolName(payload: ToolPayload): string | undefined {
  const structured = payload.data as OutlineData | undefined;
  const firstSymbol = structured?.symbols?.find(
    (symbol) => typeof symbol?.name === 'string' && symbol.name.trim().length > 0
  );
  return firstSymbol?.name?.trim();
}

function requireMutationAck() {
  if (process.env[MUTATION_ACK_ENV] === '1') {
    return;
  }
  throw new Error(
    `${MUTATION_ACK_ENV}=1 is required because this eval registers the current project and may write Project RAG state`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireMutationAck();

  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['mcp/launcher.ts'],
    cwd: args.cwd,
    env: {
      ...(process.env as Record<string, string>),
      MCP_PERMISSION_MODE: 'read_write',
    },
  });

  const client = new Client(
    {
      name: 'rag-v1-mcp-project-current',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  const phases: PhaseResult[] = [];
  const phaseTimingsMs: Record<string, number> = {};
  const summary: RunSummary = {
    ok: false,
    mode: args.mode,
    phases,
    phaseTimingsMs,
  };

  let projectId: string | undefined;
  let freshnessStatus: string | undefined;
  let stalePaths: string[] = [];
  let reindexedCount = 0;
  let skippedMissingCount = 0;
  let timedOutCount = 0;
  let timedOutIngestRequest = false;

  const runPhase = async <T>(
    name: string,
    action: () => Promise<T>,
    detail?: (value: T) => string
  ) => {
    const startedAt = Date.now();
    try {
      const value = await action();
      const latencyMs = Date.now() - startedAt;
      phaseTimingsMs[name] = latencyMs;
      phases.push({
        name,
        status: 'passed',
        latencyMs,
        detail: detail ? detail(value) : undefined,
      });
      return value;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      phaseTimingsMs[name] = latencyMs;
      const message = error instanceof Error ? error.message : String(error);
      phases.push({
        name,
        status: 'failed',
        latencyMs,
        detail: message,
      });
      throw new Error(`[${name}] ${message}`);
    }
  };

  try {
    await runPhase(
      'connect',
      async () => {
        await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
        return true;
      },
      () => `timeout=${MCP_CONNECT_TIMEOUT_MS}`
    );

    await runPhase(
      'tool_surface',
      async () => {
        const toolsResponse = await client.listTools();
        const toolNames = toolsResponse.tools.map((tool) => tool.name);
        const required = new Set([
          'health_check',
          'register_project',
          'verify_project_index',
          'search_project_code',
          'get_project_outline',
          'find_project_symbol',
          'ingest_project_file',
        ]);
        const missing = [...required].filter((tool) => !toolNames.includes(tool));
        if (missing.length > 0) {
          throw new Error(`missing tools: ${missing.join(', ')}`);
        }
        return toolNames.length;
      },
      (count) => `discoverable=${count}`
    );

    await runPhase(
      'health_check',
      async () =>
        requireProjectMcpAvailability(
          extractPayload(await client.callTool({ name: 'health_check', arguments: {} }))
        ),
      () => 'MCP server reachable; Docs RAG health is independent'
    );

    // Resolve includeRoots before registering: prefer the existing project's
    // roots so that repeated evaluation runs do not accidentally overwrite a
    // carefully configured project scope with a hardcoded list.
    const resolvedIncludeRoots = await resolveProjectIncludeRoots(
      args.projectSlug,
      args.includeRoots,
      async (slug) => {
        const dbConfig = resolveProjectRagPostgresConfig(process.env);
        if (!dbConfig.database.url) {
          return undefined;
        }
        const sql = createProjectRagPostgresSql(dbConfig);
        try {
          const existing = await findProjectRagPostgresProject(sql, slug);
          return existing?.includeRoots && existing.includeRoots.length > 0
            ? { includeRoots: existing.includeRoots }
            : undefined;
        } finally {
          await closeProjectRagPostgresSql(dbConfig.database.url);
        }
      }
    );

    const registerPayload = await runPhase('register_project', async () =>
      requireSuccess(
        'register_project',
        extractPayload(
          await client.callTool({
            name: 'register_project',
            arguments: {
              name: args.projectName,
              rootPath: args.projectRoot,
              includeRoots: resolvedIncludeRoots,
              scopeAck: PROJECT_SCOPE_ACK_TOKEN,
            },
          })
        )
      )
    );

    projectId = extractProjectId(registerPayload);
    if (!projectId) {
      throw new Error('project_not_indexed: project id could not be resolved');
    }
    const resolvedProjectId = projectId;
    summary.projectId = resolvedProjectId;

    const verifyBefore = await runPhase('verify_project_index_before', async () =>
      requireVerifyPayload(
        'verify_project_index',
        extractPayload(
          await client.callTool({
            name: 'verify_project_index',
            arguments: {
              projectId,
            },
          })
        ),
        { allowBlockedGate: args.mode === 'repair' }
      )
    );

    const beforeReconciliation = buildReconciliationSnapshot(verifyBefore);
    freshnessStatus = beforeReconciliation.freshness.status;
    stalePaths = beforeReconciliation.candidatePaths;
    summary.freshnessStatus = freshnessStatus;
    summary.staleCount = beforeReconciliation.candidateCount;
    summary.scopeDriftCount =
      beforeReconciliation.scopeCoverage.missingExpectedCount +
      beforeReconciliation.scopeCoverage.extraIndexedCount +
      beforeReconciliation.scopeCoverage.ignoredIndexedCount;

    if (args.mode !== 'repair' && beforeReconciliation.freshness.fileCount < 1) {
      throw new Error('project_not_indexed: verify_project_index reported zero files');
    }

    if (args.mode === 'repair') {
      const repairBatch = await runPhase(
        'repair_reindex_stale',
        async () => {
          const candidates = selectRepairCandidates(stalePaths, args.maxFiles, args.offset);
          for (const sourcePath of candidates) {
            const absolutePath = resolve(args.projectRoot, sourcePath);
            try {
              const ingestPayload = requireSuccess(
                'ingest_project_file',
                extractPayload(
                  await callToolWithTimeout(
                    'ingest_project_file',
                    args.ingestTimeoutMs,
                    async (options) =>
                      client.callTool(
                        {
                          name: 'ingest_project_file',
                          arguments: {
                            filePath: absolutePath,
                            rootPath: args.projectRoot,
                            force: true,
                            scopeAck: PROJECT_SCOPE_ACK_TOKEN,
                          },
                        },
                        undefined,
                        options
                      )
                  )
                )
              );
              const ingestStatus =
                typeof ingestPayload.data?.result === 'object' &&
                ingestPayload.data?.result !== null &&
                'status' in ingestPayload.data.result
                  ? (ingestPayload.data.result as { status?: unknown }).status
                  : undefined;

              if (ingestStatus === 'indexed') {
                reindexedCount++;
              } else {
                skippedMissingCount++;
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (isTimeoutLikeError(message)) {
                timedOutCount++;
                timedOutIngestRequest = true;
                // Avoid continuing with the same transport after a timed-out MCP request.
                break;
              }
              throw error;
            }
          }
          return {
            candidates: candidates.length,
            reindexedCount,
            skippedMissingCount,
            timedOutCount,
          };
        },
        (result) =>
          `candidates=${result.candidates} reindexed=${result.reindexedCount} skippedMissing=${result.skippedMissingCount} timedOut=${result.timedOutCount}`
      );
      const verifyAfterStartedAt = Date.now();
      let verifyAfterOutcome: RepairPostVerifyOutcome;
      try {
        if (timedOutIngestRequest) {
          verifyAfterOutcome = {
            kind: 'timeout',
            latencyMs: Date.now() - verifyAfterStartedAt,
            message:
              'verify_project_index_after skipped: prior ingest timeout can leave transport in unsafe state',
          };
        } else {
          const verifyAfter = requireVerifyPayload(
            'verify_project_index',
            extractPayload(
              await callToolWithTimeout(
                'verify_project_index_after',
                args.ingestTimeoutMs,
                async (options) =>
                  client.callTool(
                    {
                      name: 'verify_project_index',
                      arguments: {
                        projectId,
                      },
                    },
                    undefined,
                    options
                  )
              )
            ),
            { allowBlockedGate: true }
          );
          const latencyMs = Date.now() - verifyAfterStartedAt;
          verifyAfterOutcome = {
            kind: 'complete',
            latencyMs,
            reconciliation: buildReconciliationSnapshot(verifyAfter),
          };
        }
      } catch (error) {
        const latencyMs = Date.now() - verifyAfterStartedAt;
        const message = error instanceof Error ? error.message : String(error);
        if (isTimeoutLikeError(message)) {
          verifyAfterOutcome = {
            kind: 'timeout',
            latencyMs,
            message,
          };
        } else {
          phaseTimingsMs.verify_project_index_after = latencyMs;
          phases.push({
            name: 'verify_project_index_after',
            status: 'failed',
            latencyMs,
            detail: message,
          });
          throw new Error(`[verify_project_index_after] ${message}`);
        }
      }

      finalizeRepairSummary({
        summary,
        phases,
        phaseTimingsMs,
        verifyAfterOutcome,
        reindexedCount,
        skippedMissingCount,
        timedOutCount,
        batchCandidates: repairBatch.candidates,
        offset: args.offset,
        maxFiles: args.maxFiles,
      });
      if (verifyAfterOutcome.kind === 'complete') {
        freshnessStatus = verifyAfterOutcome.reconciliation.freshness.status;
        stalePaths = verifyAfterOutcome.reconciliation.candidatePaths;
      }
    } else {
      if ((summary.staleCount ?? 0) > 0) {
        throw new Error(
          `freshness_precondition_failed: status=${freshnessStatus ?? 'unknown'} stale=${summary.staleCount ?? 0}`
        );
      }
      const searchPayload = await runPhase('search_project_code', async () =>
        requireSuccess(
          'search_project_code',
          extractPayload(
            await client.callTool({
              name: 'search_project_code',
              arguments: buildProjectSearchArguments(resolvedProjectId, args.searchQuery),
            })
          )
        )
      );

      const results = Array.isArray(searchPayload.data?.results)
        ? (searchPayload.data?.results as SearchResult[])
        : [];
      requireProjectSearchEmbeddingEvidence(searchPayload);
      const sourcePath = results.find((entry) => typeof entry?.sourcePath === 'string')?.sourcePath;

      if (!sourcePath) {
        throw new Error('contract_step_failed: search_project_code returned no sourcePath');
      }

      const outlinePayload = await runPhase('get_project_outline', async () =>
        requireSuccess(
          'get_project_outline',
          extractPayload(
            await client.callTool({
              name: 'get_project_outline',
              arguments: {
                projectId,
                sourcePath,
              },
            })
          )
        )
      );

      const symbolName = firstSymbolName(outlinePayload);
      if (symbolName) {
        await runPhase(
          'find_project_symbol',
          async () =>
            requireSuccess(
              'find_project_symbol',
              extractPayload(
                await client.callTool({
                  name: 'find_project_symbol',
                  arguments: {
                    projectId,
                    symbolName,
                    limit: 5,
                  },
                })
              )
            ),
          () => `symbol=${symbolName}`
        );
      } else {
        phases.push({
          name: 'find_project_symbol',
          status: 'skipped',
          latencyMs: 0,
          detail: 'no symbol in outline',
        });
        phaseTimingsMs.find_project_symbol = 0;
      }

      summary.ok = true;
      summary.message = 'Project current-repo Postgres contract passed';
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const phaseMatch = message.match(/^\[([^\]]+)\]\s*/);
    const failedPhase = phaseMatch?.[1];
    summary.ok = false;
    summary.failedPhase = failedPhase;
    summary.failureCode = classifyFailureCode(message);
    summary.message = message;
  } finally {
    await transport.close();
  }

  if (args.json) {
    if (args.jsonOutPath) {
      persistJsonArtifact(args.jsonOutPath, summary);
      console.error(`[mcp-project-current] json artifact: ${args.jsonOutPath}`);
    }
    // Keep this as the last stdout line for deterministic parsing under noisy logs.
    process.stdout.write(`${createMachineReadableResultLine(summary)}\n`);
  } else {
    console.log(`MCP Project Current (${args.mode})`);
    console.log(`- ok: ${summary.ok ? 'yes' : 'no'}`);
    console.log(`- projectId: ${summary.projectId ?? 'unknown'}`);
    console.log(`- freshness: ${summary.freshnessStatus ?? 'unknown'}`);
    console.log(`- staleCount: ${summary.staleCount ?? 0}`);
    if (args.mode === 'repair') {
      console.log(`- reindexed: ${summary.reindexedCount ?? 0}`);
      console.log(`- skippedMissing: ${summary.skippedMissingCount ?? 0}`);
      console.log(`- timedOut: ${summary.timedOutCount ?? 0}`);
      console.log(`- postVerifyStatus: ${summary.postVerifyStatus ?? 'unknown'}`);
      console.log(`- batchOffset: ${summary.batchOffset ?? 0}`);
      console.log(`- batchSize: ${summary.batchSize ?? 0}`);
      console.log(`- batchCandidates: ${summary.batchCandidates ?? 0}`);
      console.log(`- processedBatchCount: ${summary.processedBatchCount ?? 0}`);
      console.log(`- remainingCount: ${summary.remainingCount ?? 0}`);
      console.log(`- nextOffset: ${summary.nextOffset ?? 0}`);
      if (summary.postVerifyDetail) {
        console.log(`- postVerifyDetail: ${summary.postVerifyDetail}`);
      }
    }
    if (!summary.ok) {
      console.log(`- failedPhase: ${summary.failedPhase ?? 'unknown'}`);
      console.log(`- failureCode: ${summary.failureCode ?? 'contract_step_failed'}`);
    }
    if (summary.message) {
      console.log(`- message: ${summary.message}`);
    }
  }

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
