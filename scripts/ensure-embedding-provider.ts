#!/usr/bin/env bun
/**
 * @module ensure-embedding-provider
 * @description Ensure the RAG-scoped local embedding provider is reachable.
 *
 * This script checks the RAG-scoped llama.cpp embedding endpoint. Run a
 * dedicated embedding server, set EMBEDDING_AUTOSTART=1 for the repository
 * owner, or provide EMBEDDING_START_COMMAND for an explicit start command.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { composeAbortSignals } from '../lib/shared/abort-utils.js';
import {
  resolveEmbeddingBaseUrl,
  resolveEmbeddingModel,
  resolveEmbeddingProvider,
} from './check-embedding-health.js';
import {
  PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL,
  PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
} from './project-rag/embeddings.js';

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const QUIET = process.argv.includes('--quiet') || process.argv.includes('-q');
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_START_SCRIPT = fileURLToPath(
  new URL('./start-llamacpp-embedding-gpu.sh', import.meta.url)
);

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SpawnImplementation = typeof spawn;
type SleepImplementation = (milliseconds: number) => Promise<unknown>;

interface StartedEmbeddingService {
  failure: Promise<never>;
  cleanup: () => void;
}

export interface EnsureEmbeddingProviderOptions {
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImplementation;
  spawnImpl?: SpawnImplementation;
  sleepImpl?: SleepImplementation;
  now?: () => number;
  signal?: AbortSignal;
}

export interface EmbeddingStartSpec {
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
}

function log(message: string, quiet = QUIET): void {
  if (!quiet) {
    console.log(message);
  }
}

function availabilityPath(): string {
  return '/health';
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchImplementation,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const composedSignal = signal
      ? composeAbortSignals(controller.signal, signal)
      : controller.signal;
    return await fetchImpl(url, { ...options, signal: composedSignal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkApi(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: FetchImplementation,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}${availabilityPath()}`,
      { method: 'GET' },
      timeoutMs,
      fetchImpl,
      signal
    );
    return response.ok;
  } catch {
    return false;
  }
}

export function resolveEmbeddingStartSpec(
  env: NodeJS.ProcessEnv = process.env
): EmbeddingStartSpec {
  const configuredCommand = resolveConfiguredEmbeddingStartCommand(env);
  if (configuredCommand) {
    return {
      command: configuredCommand,
      args: [],
      cwd: PROJECT_ROOT,
      shell: true,
    };
  }
  return {
    command: 'bash',
    args: [DEFAULT_START_SCRIPT],
    cwd: PROJECT_ROOT,
    shell: false,
  };
}

function resolveConfiguredEmbeddingStartCommand(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.EMBEDDING_START_COMMAND ??
    env.LLAMACPP_START_COMMAND ??
    env.RAG_LLAMACPP_START_COMMAND
  )?.trim();
}

function hasExplicitAutoStartOptIn(env: NodeJS.ProcessEnv): boolean {
  return ['1', 'true', 'yes'].includes((env.EMBEDDING_AUTOSTART ?? '').trim().toLowerCase());
}

function startFromSpec(
  spec: EmbeddingStartSpec,
  spawnImpl: SpawnImplementation
): StartedEmbeddingService {
  const child = spawnImpl(spec.command, spec.args, {
    cwd: spec.cwd,
    detached: true,
    shell: spec.shell,
    stdio: 'ignore',
  });

  let rejectFailure: (reason: Error) => void = () => undefined;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const onError = (error: Error) => {
    rejectFailure(error);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (code !== 0) {
      rejectFailure(
        new Error(
          `Embedding start command exited with code ${code ?? 'null'}${
            signal ? ` (signal ${signal})` : ''
          }`
        )
      );
    }
  };

  child.once('error', onError);
  child.once('exit', onExit);
  child.unref();
  const cleanup = () => {
    child.removeListener('error', onError);
    child.removeListener('exit', onExit);
  };
  return { failure, cleanup };
}

async function waitForApi(input: {
  baseUrl: string;
  startTimeoutMs: number;
  apiTimeoutMs: number;
  intervalMs: number;
  fetchImpl: FetchImplementation;
  sleepImpl: SleepImplementation;
  now: () => number;
  startupFailure?: Promise<never>;
  signal?: AbortSignal;
}): Promise<boolean> {
  const deadline = input.now() + input.startTimeoutMs;
  const raceWithStartupFailure = <T>(operation: Promise<T>): Promise<T> =>
    input.startupFailure ? Promise.race([operation, input.startupFailure]) : operation;

  while (input.now() < deadline) {
    if (input.signal?.aborted) return false;
    if (
      await raceWithStartupFailure(
        checkApi(input.baseUrl, input.apiTimeoutMs, input.fetchImpl, input.signal)
      )
    ) {
      return true;
    }
    await raceWithStartupFailure(input.sleepImpl(input.intervalMs));
  }
  return false;
}

function startupHint(_provider: string, baseUrl: string, model: string): string {
  return [
    `llama.cpp embedding endpoint is not reachable at ${baseUrl}.`,
    'Start a RAG-scoped embedding server, for example:',
    'bun run embeddings:gpu:1024',
    'For the 4096D compatibility/benchmark lane:',
    'bun run embeddings:gpu',
    'Or manually:',
    `llama-server --embedding --pooling <mean|last> --host 127.0.0.1 --port 8082 --model <embedding-model.gguf> --alias ${model} --device CUDA0 --n-gpu-layers 999 --ctx-size 8192 --parallel 1 --batch-size 256 --ubatch-size 64 --fit off`,
    'Or set EMBEDDING_START_COMMAND to the exact command for this repository.',
    'The default readiness hook never starts the repository owner; set EMBEDDING_AUTOSTART=1 to opt in.',
  ].join('\n');
}

function hasExplicitLlamaCppEndpoint(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LLAMACPP_BASE_URL || env.RAG_LLAMACPP_BASE_URL);
}

export function resolveEnsureTarget(env: NodeJS.ProcessEnv = process.env): {
  provider: string;
  baseUrl: string;
  model: string;
} {
  const provider = resolveEmbeddingProvider(env);
  if (hasExplicitLlamaCppEndpoint(env)) {
    return {
      provider,
      baseUrl: resolveEmbeddingBaseUrl(env),
      model: resolveEmbeddingModel(env),
    };
  }

  return {
    provider,
    baseUrl: PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL,
    model: PROJECT_RAG_POSTGRES_EMBEDDING_MODEL,
  };
}

export async function ensureEmbeddingProvider(
  options: EnsureEmbeddingProviderOptions = {}
): Promise<void> {
  const quiet = options.quiet ?? QUIET;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const sleepImpl = options.sleepImpl ?? sleep;
  const now = options.now ?? Date.now;
  if (options.signal?.aborted) {
    throw new Error('Embedding provider startup was cancelled');
  }
  const startTimeoutMs = parsePositiveInteger(env.EMBEDDING_START_TIMEOUT_MS, 120_000);
  const apiTimeoutMs = parsePositiveInteger(
    env.EMBEDDING_CONNECT_TIMEOUT_MS ?? env.LLAMACPP_CONNECT_TIMEOUT_MS,
    10_000
  );
  const intervalMs = parsePositiveInteger(env.EMBEDDING_START_POLL_INTERVAL_MS, 500);
  const { provider, baseUrl, model } = resolveEnsureTarget(env);

  if (await checkApi(baseUrl, apiTimeoutMs, fetchImpl, options.signal)) {
    log(`Embedding provider ${provider} is available at ${baseUrl}`, quiet);
    return;
  }

  const isProjectRagEndpoint =
    baseUrl.replace(/\/+$/u, '') === PROJECT_RAG_POSTGRES_EMBEDDING_BASE_URL.replace(/\/+$/u, '');
  const canStartOwnedService =
    Boolean(resolveConfiguredEmbeddingStartCommand(env)) ||
    (isProjectRagEndpoint && hasExplicitAutoStartOptIn(env));
  if (!canStartOwnedService) {
    throw new Error(
      `Embedding endpoint is not reachable at ${baseUrl}; no local service was started.\n${startupHint(provider, baseUrl, model)}`
    );
  }

  const startSpec = resolveEmbeddingStartSpec(env);
  log(`Embedding provider ${provider} is not reachable; starting its service owner...`, quiet);
  const startedService = startFromSpec(startSpec, spawnImpl);

  try {
    if (
      !(await waitForApi({
        baseUrl,
        startTimeoutMs,
        apiTimeoutMs,
        intervalMs,
        fetchImpl,
        sleepImpl,
        now,
        startupFailure: startedService.failure,
        signal: options.signal,
      }))
    ) {
      throw new Error(
        `Embedding provider did not become ready at ${baseUrl} within ${startTimeoutMs}ms.\n${startupHint(provider, baseUrl, model)}`
      );
    }
  } finally {
    startedService.cleanup();
  }

  log(`Embedding provider ${provider} is ready at ${baseUrl}`, quiet);
}

export async function main(): Promise<void> {
  await ensureEmbeddingProvider({ quiet: QUIET });
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Embedding provider ensure failed: ${message}`);
      process.exit(1);
    });
}
