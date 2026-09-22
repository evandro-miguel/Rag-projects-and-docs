#!/usr/bin/env bun
/**
 * @module check-embedding-health
 * @description Health check for the local embedding provider used by RAG.
 *
 * llama.cpp is the only supported embedding provider for this RAG system.
 */

import './lib/runtime-env.js';
import { execSync } from 'node:child_process';
import {
  PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL,
  PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS,
  PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
  resolveProjectRagPostgresEmbeddingConfig,
} from './project-rag/embeddings.js';

export type EmbeddingProvider = 'llamacpp';
export type EmbeddingHealthProfile = 'default' | 'project-rag';

const DEFAULT_EMBEDDING_DIMENSIONS: number = PROJECT_RAG_POSTGRES_EMBEDDING_DIMENSIONS;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const LATENCY_DEGRADED_THRESHOLD_MS = 5000;

export interface EmbeddingHealthTarget {
  readonly profile: EmbeddingHealthProfile;
  readonly provider: EmbeddingProvider;
  readonly baseUrl: string;
  readonly model: string;
  readonly expectedDimensions: number;
  readonly timeoutMs: number;
}

export function resolveEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const rawProvider = (env.EMBEDDING_PROVIDER ?? 'llamacpp').trim().toLowerCase();
  if (rawProvider === 'llamacpp' || rawProvider === 'llama.cpp' || rawProvider === 'llama-cpp') {
    return 'llamacpp';
  }
  if (rawProvider === 'ollama') {
    throw new Error('Unsupported EMBEDDING_PROVIDER "ollama". This RAG system requires llama.cpp.');
  }
  throw new Error(
    `Unsupported EMBEDDING_PROVIDER "${rawProvider}". This RAG system requires llama.cpp.`
  );
}

export function resolveEmbeddingModel(env: NodeJS.ProcessEnv = process.env): string {
  resolveEmbeddingProvider(env);
  return (
    env.LLAMACPP_EMBEDDING_MODEL ?? env.EMBEDDING_MODEL ?? PROJECT_RAG_POSTGRES_EMBEDDING_MODEL
  );
}

export function resolveEmbeddingBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  resolveEmbeddingProvider(env);
  return (
    env.LLAMACPP_BASE_URL ?? env.RAG_LLAMACPP_BASE_URL ?? PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL
  );
}

function resolveConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Number.parseInt(
    env.EMBEDDING_CONNECT_TIMEOUT_MS ??
      env.LLAMACPP_CONNECT_TIMEOUT_MS ??
      String(DEFAULT_CONNECT_TIMEOUT_MS),
    10
  );
}

function parsePositiveInteger(value: string | undefined, label: string, fallback?: number): number {
  if (!value) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`${label} must be a positive integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(`${label} must be a positive integer, got "${value}"`);
}

function readArgValue(args: readonly string[], ...flags: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    for (const flag of flags) {
      if (current === flag) {
        return args[index + 1];
      }
      if (current.startsWith(`${flag}=`)) {
        return current.slice(flag.length + 1);
      }
    }
  }
  return undefined;
}

export function resolveEmbeddingHealthProfile(
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): EmbeddingHealthProfile {
  const raw = args.includes('--project-rag')
    ? 'project-rag'
    : (readArgValue(args, '--profile') ?? env.EMBEDDING_HEALTH_PROFILE);

  if (!raw) {
    return 'default';
  }

  switch (raw.trim().toLowerCase()) {
    case 'default':
    case 'llamacpp':
      return 'default';
    case 'project':
    case 'project-rag':
    case 'project-rag-postgres':
    case 'project-rag-1024':
      return 'project-rag';
    default:
      throw new Error(
        `Unsupported embedding health profile "${raw}". Use "default" or "project-rag".`
      );
  }
}

function resolveExpectedDimensionsOverride(
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const raw =
    readArgValue(args, '--dimensions', '--expected-dimensions') ??
    env.EMBEDDING_EXPECTED_DIMENSIONS ??
    env.LLAMACPP_EMBEDDING_DIMENSIONS ??
    env.EMBEDDING_DIMENSIONS ??
    env.PROJECT_RAG_PG_EMBEDDING_DIMENSIONS;

  if (!raw) {
    return undefined;
  }

  return parsePositiveInteger(raw, 'Embedding dimensions override');
}

export function resolveEmbeddingHealthTarget(
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): EmbeddingHealthTarget {
  const profile = resolveEmbeddingHealthProfile(args, env);
  const expectedDimensionsOverride = resolveExpectedDimensionsOverride(args, env);

  if (profile === 'project-rag') {
    const config = resolveProjectRagPostgresEmbeddingConfig(env);
    return {
      profile,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      expectedDimensions: expectedDimensionsOverride ?? config.dimensions,
      timeoutMs: parsePositiveInteger(
        env.EMBEDDING_CONNECT_TIMEOUT_MS ?? env.PROJECT_RAG_PG_EMBEDDING_TIMEOUT_MS,
        'Project RAG embedding timeout',
        config.timeoutMs
      ),
    };
  }

  return {
    profile,
    provider: resolveEmbeddingProvider(env),
    baseUrl: resolveEmbeddingBaseUrl(env),
    model: resolveEmbeddingModel(env),
    expectedDimensions: expectedDimensionsOverride ?? DEFAULT_EMBEDDING_DIMENSIONS,
    timeoutMs: resolveConnectTimeoutMs(env),
  };
}

function isLocalUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return true;
  }
}

function availabilityPath(): string {
  return '/health';
}

function embeddingPath(): string {
  return '/v1/embeddings';
}

type CheckLevel = 'ok' | 'warning' | 'error';

interface CheckResult {
  ok: boolean;
  message: string;
  details?: string;
  level?: CheckLevel;
}

interface EmbeddingReadinessResult {
  result: CheckResult;
  elapsedMs?: number;
}

type ExecText = (command: string) => string;

function localPortFor(baseUrl: string): number | undefined {
  try {
    const url = new URL(baseUrl);
    if (!isLocalUrl(baseUrl)) {
      return undefined;
    }
    if (url.port) {
      return Number.parseInt(url.port, 10);
    }
    if (url.protocol === 'http:') {
      return 80;
    }
    if (url.protocol === 'https:') {
      return 443;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function splitPids(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\s+/)
        .map((value) => value.trim())
        .filter((value) => /^\d+$/.test(value))
    ),
  ];
}

function listenerPidsForPort(port: number, execText: ExecText): string[] {
  for (const command of [
    `lsof -nP -iTCP:${port} -sTCP:LISTEN -t`,
    `fuser -n tcp ${port} 2>/dev/null`,
  ]) {
    try {
      const pids = splitPids(execText(command));
      if (pids.length > 0) {
        return pids;
      }
    } catch {
      // Try the next local process lookup.
    }
  }

  try {
    const output = execText(`ss -ltnp 'sport = :${port}'`);
    return [
      ...new Set(
        [...output.matchAll(/pid=(\d+)/g)]
          .map((match) => match[1])
          .filter((pid): pid is string => Boolean(pid))
      ),
    ];
  } catch {
    return [];
  }
}

function localCudaBackendPids(listenerPids: string[], execText: ExecText): string[] {
  return listenerPids.filter((pid) => {
    try {
      const maps = execText(`cat /proc/${pid}/maps 2>/dev/null`);
      return (
        /libggml-cuda|ggml-cuda/.test(maps) && /libcuda\.so|libcudart\.so|libcublas/.test(maps)
      );
    } catch {
      return false;
    }
  });
}

/**
 * WSL can hide a CUDA process from nvidia-smi's compute-app query.  A process
 * that has opened a /dev/nvidia* device is stronger evidence than merely
 * loading the CUDA shared libraries: it proves the listener owns a CUDA
 * device handle in this PID namespace.
 */
function localCudaDevicePids(listenerPids: string[], execText: ExecText): string[] {
  return listenerPids.filter((pid) => {
    try {
      const descriptors = execText(`find /proc/${pid}/fd -maxdepth 1 -type l -printf '%l\n'`);
      return descriptors.split('\n').some((target) => /^\/dev\/(?:nvidia|dxg)/u.test(target));
    } catch {
      return false;
    }
  });
}

function journalFullGpuOffload(pid: string, execText: ExecText): string | undefined {
  try {
    const output = execText(
      `journalctl --user -b _PID=${pid} --grep='offloaded [0-9]+/[0-9]+ layers to GPU' -o cat --no-pager`
    );
    for (const match of output.matchAll(/offloaded (\d+)\/(\d+) layers to GPU/gu)) {
      const offloaded = Number.parseInt(match[1] ?? '', 10);
      const total = Number.parseInt(match[2] ?? '', 10);
      if (offloaded > 0 && offloaded === total) return `${offloaded}/${total}`;
    }
  } catch {
    // Missing or inaccessible journal evidence is non-green.
  }
  return undefined;
}

function journalLatestEmbeddingCompletion(pid: string, execText: ExecText): string | undefined {
  try {
    const output = execText(
      `journalctl --user -b _PID=${pid} --grep='done request: POST /v1/embeddings .* 200' --lines=1 -o json --no-pager`
    ).trim();
    const lastLine = output.split('\n').filter(Boolean).at(-1);
    if (!lastLine) return undefined;

    try {
      const entry = JSON.parse(lastLine) as {
        __CURSOR?: unknown;
        __REALTIME_TIMESTAMP?: unknown;
        MESSAGE?: unknown;
      };
      if (
        typeof entry.MESSAGE !== 'string' ||
        !/done request: POST \/v1\/embeddings .* \b200\b/u.test(entry.MESSAGE)
      ) {
        return undefined;
      }
      return String(entry.__CURSOR ?? entry.__REALTIME_TIMESTAMP ?? lastLine);
    } catch {
      return /done request: POST \/v1\/embeddings .* \b200\b/u.test(lastLine)
        ? lastLine
        : undefined;
    }
  } catch {
    return undefined;
  }
}

async function waitForNewJournalEmbeddingCompletion(
  pid: string,
  previousCompletion: string | undefined,
  execText: ExecText,
  wait: (delayMs: number) => Promise<void>
): Promise<boolean> {
  const attempts = 5;
  const delayMs = 50;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const completion = journalLatestEmbeddingCompletion(pid, execText);
    if (completion !== undefined && completion !== previousCompletion) {
      return true;
    }
    if (attempt < attempts - 1) {
      await wait(delayMs);
    }
  }

  return false;
}

export function checkLlamaCppGpuOffload(
  provider: EmbeddingProvider,
  baseUrl: string,
  execText: ExecText = (command) => execSync(command, { encoding: 'utf-8', stdio: 'pipe' })
): CheckResult {
  if (provider !== 'llamacpp') {
    return {
      ok: false,
      level: 'error',
      message: 'GPU proof requires the llama.cpp provider',
    };
  }

  const port = localPortFor(baseUrl);
  if (!port) {
    return {
      ok: false,
      level: 'error',
      message: 'GPU proof unavailable for non-local llama.cpp endpoint',
      details: 'Only a loopback listener can be tied to local GPU evidence.',
    };
  }

  const listenerPids = listenerPidsForPort(port, execText);
  if (listenerPids.length === 0) {
    return {
      ok: false,
      level: 'error',
      message: 'No local llama.cpp listener PID found',
      details: `Could not map ${baseUrl} to a local process via lsof, fuser, or ss.`,
    };
  }

  const cudaBackendPids = localCudaBackendPids(listenerPids, execText);
  const cudaDevicePids = localCudaDevicePids(cudaBackendPids, execText);
  return {
    ok: false,
    level: cudaBackendPids.length > 0 || cudaDevicePids.length > 0 ? 'warning' : 'error',
    message:
      cudaBackendPids.length > 0 || cudaDevicePids.length > 0
        ? 'CUDA-capable llama.cpp listener; request-time GPU offload unproven'
        : 'llama.cpp GPU offload unproven',
    details: `Listener PID(s): ${listenerPids.join(', ')}. Static libraries or device handles are not compute proof.`,
  };
}

export async function checkLlamaCppGpuOffloadDuringRequest<T>(
  provider: EmbeddingProvider,
  baseUrl: string,
  operation: () => Promise<T>,
  execText: ExecText = (command) => execSync(command, { encoding: 'utf-8', stdio: 'pipe' }),
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  // Keep the legacy argument for callers that pass dimensions; GPU attribution
  // is intentionally based on endpoint ownership, never on a profile constant.
  _expectedDimensions: number = DEFAULT_EMBEDDING_DIMENSIONS
): Promise<{ readonly gpu: CheckResult; readonly value: T }> {
  if (provider !== 'llamacpp') {
    return { gpu: checkLlamaCppGpuOffload(provider, baseUrl, execText), value: await operation() };
  }
  const port = localPortFor(baseUrl);
  const listenerPids = port ? listenerPidsForPort(port, execText) : [];
  if (listenerPids.length !== 1) {
    const staticCheck = checkLlamaCppGpuOffload(provider, baseUrl, execText);
    const ownershipDetails =
      listenerPids.length === 0
        ? `No visible listener PID owns ${baseUrl}; user-unit journal evidence cannot be attributed to this endpoint.`
        : `Multiple listener PIDs (${listenerPids.join(', ')}) own ${baseUrl}; a request completion cannot be attributed to one process.`;
    return {
      gpu: {
        ...staticCheck,
        message: 'llama.cpp GPU offload unproven after real embedding request',
        details: `${staticCheck.details ?? ''} ${ownershipDetails}`.trim(),
      },
      value: await operation(),
    };
  }

  const offloadByPid = new Map(
    listenerPids.map((pid) => [pid, journalFullGpuOffload(pid, execText)] as const)
  );
  const latestCompletions = new Map(
    listenerPids.map((pid) => [pid, journalLatestEmbeddingCompletion(pid, execText)] as const)
  );
  const value = await operation();
  let proven: string | undefined;
  for (const pid of listenerPids) {
    if (
      offloadByPid.get(pid) !== undefined &&
      (await waitForNewJournalEmbeddingCompletion(pid, latestCompletions.get(pid), execText, wait))
    ) {
      proven = pid;
      break;
    }
  }

  if (proven) {
    return {
      gpu: {
        ok: true,
        level: 'ok',
        message: `GPU offload proven for llama.cpp PID ${proven}`,
        details: `Current-boot listener evidence reports ${offloadByPid.get(
          proven
        )} model layers offloaded to GPU and a new successful embedding request completed in that process.`,
      },
      value,
    };
  }

  const staticCheck = checkLlamaCppGpuOffload(provider, baseUrl, execText);
  return {
    gpu: {
      ...staticCheck,
      message: 'llama.cpp GPU offload unproven after real embedding request',
      details:
        'No current-boot listener PID had both an explicit full-layer GPU offload record and a new successful embedding request record.',
    },
    value,
  };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function checkProcess(): CheckResult {
  return {
    ok: true,
    message: 'Skipped; llama.cpp is validated by the configured endpoint',
  };
}

async function checkApi(
  _provider: EmbeddingProvider,
  baseUrl: string,
  timeoutMs: number
): Promise<CheckResult> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}${availabilityPath()}`,
      { method: 'GET' },
      timeoutMs
    );

    if (response.ok) {
      return {
        ok: true,
        message: 'Local llama.cpp endpoint responding',
      };
    }

    return {
      ok: false,
      message: 'Not responding',
      details: `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: 'Not responding',
      details: message.includes('abort') ? 'Connection timeout' : message,
    };
  }
}

export async function checkModel(
  _provider: EmbeddingProvider,
  baseUrl: string,
  model: string,
  timeoutMs: number,
  allowModelListWarning = false
): Promise<CheckResult> {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: 'GET' }, timeoutMs);
    if (!response.ok) {
      if (!allowModelListWarning) {
        return {
          ok: false,
          level: 'error',
          message: 'Model list unavailable',
          details: `HTTP ${response.status}: ${response.statusText}`,
        };
      }
      return {
        ok: true,
        level: 'warning',
        message: 'Model list unavailable; readiness probe will validate embeddings',
        details: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (data.data ?? []).map((entry) => entry.id).filter(Boolean);
    if (ids.length === 0) {
      if (!allowModelListWarning) {
        return {
          ok: false,
          level: 'error',
          message: 'No model ids reported',
        };
      }
      return {
        ok: true,
        level: 'warning',
        message: 'No model ids reported; readiness probe will validate embeddings',
      };
    }
    const match = ids.find((id) => id === model || id?.startsWith(model));
    if (match) {
      return {
        ok: true,
        message: match,
      };
    }
    if (!allowModelListWarning) {
      return {
        ok: false,
        level: 'error',
        message: 'Configured model name not listed',
        details: `Expected "${model}". Reported: ${ids.join(', ')}`,
      };
    }
    return {
      ok: true,
      level: 'warning',
      message: 'Configured model name not listed; endpoint is still scoped',
      details: `Expected "${model}". Reported: ${ids.join(', ')}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!allowModelListWarning) {
      return {
        ok: false,
        level: 'error',
        message: 'Model list check failed',
        details: message,
      };
    }
    return {
      ok: true,
      level: 'warning',
      message: 'Model list check skipped',
      details: message,
    };
  }
}

function extractEmbeddings(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  if ('embeddings' in data) {
    return (data as { embeddings?: unknown }).embeddings;
  }
  if ('data' in data) {
    const rows = (data as { data?: unknown }).data;
    if (Array.isArray(rows)) {
      return rows.map((row) =>
        typeof row === 'object' && row !== null && 'embedding' in row
          ? (row as { embedding?: unknown }).embedding
          : undefined
      );
    }
  }
  if ('embedding' in data) {
    return [(data as { embedding?: unknown }).embedding];
  }
  return undefined;
}

export function validateEmbeddingResponse(
  data: unknown,
  expectedDimensions = DEFAULT_EMBEDDING_DIMENSIONS
): CheckResult {
  const embeddings = extractEmbeddings(data);
  const embedding = Array.isArray(embeddings) ? embeddings[0] : undefined;

  if (!Array.isArray(embedding)) {
    return {
      ok: false,
      level: 'error',
      message: 'Invalid response',
      details: 'Response did not contain valid embedding array',
    };
  }

  const dimensions = embedding.length;
  if (dimensions !== expectedDimensions) {
    return {
      ok: false,
      level: 'error',
      message: 'Wrong dimensions',
      details: `Expected ${expectedDimensions} dimensions, got ${dimensions}`,
    };
  }

  return {
    ok: true,
    level: 'ok',
    message: `${dimensions} dimensions`,
  };
}

export function assessEmbeddingLatency(
  elapsedMs: number,
  thresholdMs = LATENCY_DEGRADED_THRESHOLD_MS
): CheckResult {
  if (elapsedMs <= thresholdMs) {
    return {
      ok: true,
      level: 'ok',
      message: `${(elapsedMs / 1000).toFixed(2)}s (within ${(thresholdMs / 1000).toFixed(
        1
      )}s threshold)`,
    };
  }

  return {
    ok: true,
    level: 'warning',
    message: `${(elapsedMs / 1000).toFixed(2)}s (above ${(thresholdMs / 1000).toFixed(
      1
    )}s threshold)`,
    details: 'Embedding latency is degraded. Readiness still passed.',
  };
}

async function testEmbeddingReadiness(
  _provider: EmbeddingProvider,
  baseUrl: string,
  model: string,
  timeoutMs: number,
  expectedDimensions: number
): Promise<EmbeddingReadinessResult> {
  try {
    const testText = 'Health check test embedding';
    const startTime = Date.now();

    const response = await fetchWithTimeout(
      `${baseUrl}${embeddingPath()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: [testText],
        }),
      },
      timeoutMs * 2
    );

    const elapsedMs = Date.now() - startTime;

    if (!response.ok) {
      const body = await response.text();
      return {
        result: {
          ok: false,
          level: 'error',
          message: 'Generation failed',
          details: `HTTP ${response.status}: ${body}`,
        },
      };
    }

    const data = await response.json();
    const validation = validateEmbeddingResponse(data, expectedDimensions);
    if (!validation.ok) {
      return { result: validation };
    }

    return {
      result: {
        ok: true,
        level: 'ok',
        message: `${validation.message} ready in ${(elapsedMs / 1000).toFixed(2)}s`,
      },
      elapsedMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        ok: false,
        level: 'error',
        message: 'Test failed',
        details: message,
      },
    };
  }
}

function printCheck(name: string, result: CheckResult): void {
  const level = result.level ?? (result.ok ? 'ok' : 'error');
  const marker = level === 'warning' ? '[warn]' : result.ok ? '[ok]' : '[fail]';
  console.log(`${name}: ${marker} ${result.message}`);
  if (result.details) {
    console.log(`  -> ${result.details}`);
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet') || args.includes('-q');
  const readinessOnly = args.includes('--readiness-only');
  const allowModelListWarning =
    args.includes('--allow-model-list-warning') ||
    process.env.EMBEDDING_HEALTH_ALLOW_MODEL_LIST_WARNING === '1';
  const target = resolveEmbeddingHealthTarget(args);
  const { provider, baseUrl, model, expectedDimensions, timeoutMs } = target;
  let isDegraded = false;

  if (!quiet) {
    console.log('Embedding Provider Health Check');
    console.log('===============================');
    console.log(`Profile: ${target.profile}`);
    console.log(`Provider: ${provider}`);
    console.log('Endpoint: local llama.cpp listener');
    console.log(`Model: ${model}`);
    console.log(`Expected dimensions: ${expectedDimensions}`);
    console.log('');
  }

  const processCheck = checkProcess();
  if (!quiet) printCheck('Process', processCheck);

  if (!processCheck.ok) {
    if (!quiet) {
      console.log('');
      console.log('Status: UNHEALTHY (process not running)');
    }
    process.exit(1);
  }

  const apiCheck = await checkApi(provider, baseUrl, timeoutMs);
  if (!quiet) printCheck('API', apiCheck);

  if (!apiCheck.ok) {
    if (!quiet) {
      console.log('');
      console.log('Status: UNHEALTHY (API not responding)');
    }
    process.exit(2);
  }

  const modelCheck = await checkModel(provider, baseUrl, model, timeoutMs, allowModelListWarning);
  if (!quiet) printCheck('Model', modelCheck);

  if (!modelCheck.ok) {
    if (!quiet) {
      console.log('');
      console.log('Status: UNHEALTHY (model not available)');
    }
    process.exit(3);
  }
  if (modelCheck.level === 'warning') {
    isDegraded = true;
  }

  const observedReadiness = await checkLlamaCppGpuOffloadDuringRequest(provider, baseUrl, () =>
    testEmbeddingReadiness(provider, baseUrl, model, timeoutMs, expectedDimensions)
  );
  const embeddingReadiness = observedReadiness.value;
  if (!quiet) printCheck('Embedding Readiness', embeddingReadiness.result);

  if (!embeddingReadiness.result.ok) {
    if (!quiet) {
      console.log('');
      console.log('Status: UNHEALTHY (embedding generation failed)');
    }
    process.exit(4);
  }

  if (!quiet) printCheck('GPU Offload', observedReadiness.gpu);
  if (!observedReadiness.gpu.ok) {
    if (!quiet) {
      console.log('');
      console.log('Status: UNHEALTHY (GPU offload not proven)');
    }
    process.exit(5);
  }

  if (!readinessOnly && embeddingReadiness.elapsedMs !== undefined) {
    const performanceCheck = assessEmbeddingLatency(embeddingReadiness.elapsedMs);
    if (!quiet) printCheck('Embedding Performance', performanceCheck);
    if (performanceCheck.level === 'warning') {
      isDegraded = true;
    }
  }

  if (!quiet) {
    console.log('');
    console.log(isDegraded ? 'Status: DEGRADED (readiness OK)' : 'Status: HEALTHY');
  }

  process.exit(0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Health check crashed:', error);
    process.exit(1);
  });
}
