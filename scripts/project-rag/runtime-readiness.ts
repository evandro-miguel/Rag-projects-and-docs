/**
 * Project RAG preparation runtime selection and readiness.
 *
 * Preparation owns only the dependencies needed to index a Project RAG
 * corpus: the selected Project Postgres lane and the configured Project
 * embedding service.  It deliberately does not call the full `start-rag`
 * stack or start reranking services.
 */

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { redactCredentialText } from '../../lib/shared/credential-redact.js';
import { ensureEmbeddingProvider } from '../ensure-embedding-provider.js';
import {
  fetchProjectRagPostgresEmbeddings,
  type ProjectRagPostgresEmbeddingConfig,
  resolveProjectRagPostgresEmbeddingConfig,
} from './embeddings.js';

export type ProjectRagPrepareRuntimeLane = 'official' | 'isolated_dev' | 'test';

const IMPLEMENTATION_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export type ProjectRagPrepareRuntimeErrorCode =
  | 'RUNTIME_CONFIGURATION_MISSING'
  | 'RUNTIME_UNSUPPORTED_PROFILE'
  | 'DATABASE_UNAVAILABLE'
  | 'EMBEDDING_UNAVAILABLE'
  | 'EMBEDDING_PROFILE_MISMATCH'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_GPU_UNAVAILABLE'
  | 'RUNTIME_DEADLINE_EXCEEDED'
  | 'RUNTIME_OWNERSHIP_CONFLICT';

export class ProjectRagPrepareRuntimeError extends Error {
  readonly code: ProjectRagPrepareRuntimeErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ProjectRagPrepareRuntimeErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ProjectRagPrepareRuntimeError';
    this.code = code;
    this.details = details;
  }
}

export interface ProjectRagPrepareRuntimeIdentity {
  readonly lane: ProjectRagPrepareRuntimeLane;
  readonly owner: 'installed_user_service' | 'explicit_isolated_process' | 'test_injected';
  readonly databaseConfigured: boolean;
  readonly embedding: {
    readonly provider: string;
    readonly model: string;
    readonly baseUrl: string;
    readonly dimensions: number;
    readonly profileHash: string;
    readonly gpuProof: 'request_journal' | 'cuda_capable_listener' | 'injected_test';
    readonly ready: boolean;
  };
}

export interface ProjectRagPrepareRuntimeResult {
  readonly identity: ProjectRagPrepareRuntimeIdentity;
  readonly elapsedMs: number;
}

export interface ProjectRagPrepareRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly ensureEmbedding?: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  }) => Promise<void>;
  readonly resolveEmbedding?: (env: NodeJS.ProcessEnv) => ProjectRagPostgresEmbeddingConfig;
  readonly fetchEmbeddings?: (
    config: ProjectRagPostgresEmbeddingConfig,
    texts: readonly string[],
    signal?: AbortSignal
  ) => Promise<number[][]>;
  readonly ensureDatabase?: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly checkDatabase?: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
}

interface RuntimeConfiguration {
  readonly lane: ProjectRagPrepareRuntimeLane;
  readonly owner: ProjectRagPrepareRuntimeIdentity['owner'];
  readonly env: NodeJS.ProcessEnv;
  readonly databaseConfigured: boolean;
}

interface RuntimeReadinessOperation {
  readonly promise: Promise<ProjectRagPrepareRuntimeResult>;
}

const runtimePromises = new Map<string, RuntimeReadinessOperation>();

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactCredentialText(message).slice(0, 240);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function runtimeLane(env: NodeJS.ProcessEnv): ProjectRagPrepareRuntimeLane {
  const raw = normalize(env.PROJECT_RAG_PREPARE_RUNTIME ?? env.PROJECT_RAG_RUNTIME_LANE);
  if (!raw) {
    const configuredRoot = normalize(env.RAG_REPO_ROOT ?? env.RAG_V2_ROOT);
    if (basename(IMPLEMENTATION_ROOT) !== 'rag-v2') return 'isolated_dev';
    if (configuredRoot && basename(configuredRoot) !== 'rag-v2') return 'isolated_dev';
    return 'official';
  }
  if (raw === 'official' || raw === 'production') {
    if (basename(IMPLEMENTATION_ROOT) !== 'rag-v2') {
      throw new ProjectRagPrepareRuntimeError(
        'RUNTIME_OWNERSHIP_CONFLICT',
        'The repository-local Project RAG runtime cannot claim installed official ownership',
        { implementationRoot: IMPLEMENTATION_ROOT }
      );
    }
    return 'official';
  }
  if (raw === 'isolated_dev' || raw === 'isolated-dev' || raw === 'dev') {
    return 'isolated_dev';
  }
  if (raw === 'test') return 'test';
  throw new ProjectRagPrepareRuntimeError(
    'RUNTIME_UNSUPPORTED_PROFILE',
    `Unsupported Project RAG preparation runtime "${raw}"`,
    { allowed: ['official', 'isolated_dev', 'test'] }
  );
}

function loopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function knownOfficialDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const officialPorts = new Set(['5432', '5440', '5441', '5542', '6542']);
    const officialNames = new Set([
      'docs_rag_lab',
      'docs_lab',
      'rag_engine',
      'rag_dev',
      'project_rag',
      'project_rag_lab',
    ]);
    const port = parsed.port || (parsed.protocol === 'postgres:' ? '5432' : '');
    return officialPorts.has(port) || officialNames.has(parsed.pathname.slice(1));
  } catch {
    return false;
  }
}

function knownOfficialEmbeddingUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && parsed.port === '8082';
  } catch {
    return false;
  }
}

function databaseIsConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    normalize(
      env.PROJECT_RAG_DATABASE_URL ??
        env.PROJECT_RAG_POSTGRES_URL ??
        env.POSTGRES_URL ??
        env.DATABASE_URL
    )
  );
}

function installedOfficialDatabaseStartCommand(
  lane: ProjectRagPrepareRuntimeLane,
  env: NodeJS.ProcessEnv
): string | undefined {
  const explicit = normalize(env.PROJECT_RAG_DATABASE_START_COMMAND);
  if (explicit || lane !== 'official' || basename(IMPLEMENTATION_ROOT) !== 'rag-v2') {
    return explicit;
  }
  const rawUrl = normalize(
    env.PROJECT_RAG_DATABASE_URL ??
      env.PROJECT_RAG_POSTGRES_URL ??
      env.POSTGRES_URL ??
      env.DATABASE_URL
  );
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    const port = parsed.port || '5432';
    const hostname = parsed.hostname;
    const database = parsed.pathname.slice(1);
    if (
      ['127.0.0.1', 'localhost', '::1'].includes(hostname) &&
      port === '5440' &&
      database === 'rag_engine'
    ) {
      // The installed owner starts only its selected Postgres service.  It
      // does not start embedding or reranking dependencies.
      return `bash ${IMPLEMENTATION_ROOT}/scripts/start-rag.sh --docker-only --prod`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function redactedRuntimeEnv(
  env: NodeJS.ProcessEnv,
  config: RuntimeConfiguration
): NodeJS.ProcessEnv {
  const scoped = { ...env };
  const configuredStart = normalize(env.PROJECT_RAG_EMBEDDING_START_COMMAND);
  if (configuredStart) {
    scoped.EMBEDDING_START_COMMAND = configuredStart;
  }

  if (config.lane === 'isolated_dev' || config.lane === 'test') {
    // The explicit Project setting is accepted by the embedding resolver only
    // in an isolated lane.  Keeping the alias in the child environment also
    // makes the service owner and the health probe use the same endpoint.
    if (env.PROJECT_RAG_PG_EMBEDDING_BASE_URL) {
      scoped.LLAMACPP_BASE_URL = env.PROJECT_RAG_PG_EMBEDDING_BASE_URL;
    }
    if (env.PROJECT_RAG_PG_EMBEDDING_MODEL) {
      scoped.LLAMACPP_EMBEDDING_MODEL = env.PROJECT_RAG_PG_EMBEDDING_MODEL;
    }
  }

  return scoped;
}

function resolveRuntimeConfiguration(env: NodeJS.ProcessEnv): RuntimeConfiguration {
  const lane = runtimeLane(env);
  const databaseConfigured = databaseIsConfigured(env);
  const embeddingBaseUrl = normalize(env.PROJECT_RAG_PG_EMBEDDING_BASE_URL);
  const startCommand = normalize(
    env.PROJECT_RAG_EMBEDDING_START_COMMAND ??
      env.EMBEDDING_START_COMMAND ??
      env.LLAMACPP_START_COMMAND ??
      env.RAG_LLAMACPP_START_COMMAND
  );
  const databaseStartCommand = installedOfficialDatabaseStartCommand(lane, env);

  if (lane === 'isolated_dev' || lane === 'test') {
    if (!databaseConfigured || !embeddingBaseUrl || !startCommand) {
      throw new ProjectRagPrepareRuntimeError(
        'RUNTIME_CONFIGURATION_MISSING',
        'Isolated Project RAG preparation requires an explicit database URL, embedding endpoint, and embedding start command',
        {
          lane,
          databaseConfigured,
          embeddingEndpointConfigured: Boolean(embeddingBaseUrl),
          startCommandConfigured: Boolean(startCommand),
        }
      );
    }
    if (!loopbackUrl(embeddingBaseUrl)) {
      throw new ProjectRagPrepareRuntimeError(
        'RUNTIME_OWNERSHIP_CONFLICT',
        'Isolated Project RAG embedding endpoints must use loopback ownership',
        { lane }
      );
    }
    const databaseUrl = normalize(
      env.PROJECT_RAG_DATABASE_URL ??
        env.PROJECT_RAG_POSTGRES_URL ??
        env.POSTGRES_URL ??
        env.DATABASE_URL
    );
    if (knownOfficialEmbeddingUrl(embeddingBaseUrl) || knownOfficialDatabaseUrl(databaseUrl)) {
      throw new ProjectRagPrepareRuntimeError(
        'RUNTIME_OWNERSHIP_CONFLICT',
        'Isolated Project RAG preparation cannot target a known official embedding or database lane',
        { lane }
      );
    }
  }

  return {
    lane,
    owner:
      lane === 'official'
        ? 'installed_user_service'
        : lane === 'test'
          ? 'test_injected'
          : 'explicit_isolated_process',
    env: redactedRuntimeEnv(
      databaseStartCommand
        ? { ...env, PROJECT_RAG_DATABASE_START_COMMAND: databaseStartCommand }
        : env,
      {
        lane,
        owner:
          lane === 'official'
            ? 'installed_user_service'
            : lane === 'test'
              ? 'test_injected'
              : 'explicit_isolated_process',
        databaseConfigured,
        env,
      }
    ),
    databaseConfigured,
  };
}

function runtimeKey(
  configuration: RuntimeConfiguration,
  embedding: ProjectRagPostgresEmbeddingConfig
) {
  return [
    configuration.lane,
    configuration.env.PROJECT_RAG_DATABASE_URL ??
      configuration.env.PROJECT_RAG_POSTGRES_URL ??
      configuration.env.POSTGRES_URL ??
      configuration.env.DATABASE_URL ??
      '',
    embedding.baseUrl,
    embedding.model,
    String(embedding.dimensions),
  ].join('|');
}

function remainingMs(deadline: number, now: () => number): number {
  return Math.max(1, deadline - now());
}

function runtimeReadinessBudgetMs(env: NodeJS.ProcessEnv): number {
  return positiveInteger(env.PROJECT_RAG_PREPARE_TIMEOUT_MS, 120_000);
}

function runtimeDeadlineError(signal?: AbortSignal): ProjectRagPrepareRuntimeError {
  return new ProjectRagPrepareRuntimeError(
    'RUNTIME_DEADLINE_EXCEEDED',
    signal?.aborted
      ? 'Project RAG runtime readiness was cancelled'
      : 'Project RAG runtime readiness exceeded its deadline'
  );
}

function assertWithinDeadline(deadline: number, now: () => number, signal?: AbortSignal): void {
  if (signal?.aborted || now() >= deadline) {
    throw new ProjectRagPrepareRuntimeError(
      'RUNTIME_DEADLINE_EXCEEDED',
      'Project RAG runtime readiness exceeded its deadline'
    );
  }
}

async function defaultDatabaseCheck(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const [{ resolveProjectRagPostgresConfig }, store] = await Promise.all([
    import('./config.js'),
    import('./store.js'),
  ]);
  const config = resolveProjectRagPostgresConfig(input.env);
  if (!config.database.url) {
    throw new ProjectRagPrepareRuntimeError(
      'DATABASE_UNAVAILABLE',
      'Project RAG Postgres URL is not configured'
    );
  }
  if (input.signal?.aborted) {
    throw new ProjectRagPrepareRuntimeError(
      'RUNTIME_DEADLINE_EXCEEDED',
      'Project RAG database readiness was cancelled'
    );
  }

  const sql = store.createProjectRagPostgresSql({
    ...config,
    healthTimeoutMs: Math.min(config.healthTimeoutMs, input.timeoutMs),
  });
  try {
    await sql`SELECT 1 AS ready`;
  } catch (error) {
    throw new ProjectRagPrepareRuntimeError(
      'DATABASE_UNAVAILABLE',
      'Project RAG Postgres is not reachable',
      { cause: safeCause(error) }
    );
  }
}

async function ensureDatabaseAvailable(
  input: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
  checkDatabase: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<void>
): Promise<void> {
  try {
    await checkDatabase(input);
    return;
  } catch (initialError) {
    const startCommand = normalize(input.env.PROJECT_RAG_DATABASE_START_COMMAND);
    if (!startCommand) throw initialError;
    if (input.signal?.aborted) {
      throw new ProjectRagPrepareRuntimeError(
        'RUNTIME_DEADLINE_EXCEEDED',
        'Project RAG database readiness was cancelled'
      );
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(startCommand, {
        cwd: process.cwd(),
        detached: true,
        shell: true,
        stdio: 'ignore',
      });
    } catch (error) {
      throw new ProjectRagPrepareRuntimeError(
        'DATABASE_UNAVAILABLE',
        'Project RAG database start command could not be launched',
        { cause: safeCause(error) }
      );
    }
    child.unref();

    const startedAt = Date.now();
    const pollIntervalMs = positiveInteger(input.env.PROJECT_RAG_DB_START_POLL_INTERVAL_MS, 250);
    let lastError: unknown = initialError;
    while (Date.now() - startedAt < input.timeoutMs) {
      if (input.signal?.aborted) {
        throw new ProjectRagPrepareRuntimeError(
          'RUNTIME_DEADLINE_EXCEEDED',
          'Project RAG database readiness was cancelled'
        );
      }
      await sleep(
        Math.min(pollIntervalMs, Math.max(1, input.timeoutMs - (Date.now() - startedAt)))
      );
      try {
        await checkDatabase(input);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new ProjectRagPrepareRuntimeError(
      'DATABASE_UNAVAILABLE',
      'Project RAG Postgres did not become ready after its configured start command',
      { cause: safeCause(lastError) }
    );
  }
}

async function ensureRuntimeOnce(
  configuration: RuntimeConfiguration,
  options: ProjectRagPrepareRuntimeOptions,
  embedding: ProjectRagPostgresEmbeddingConfig,
  deadline: number,
  now: () => number
): Promise<ProjectRagPrepareRuntimeResult> {
  const checkDatabase = options.checkDatabase ?? defaultDatabaseCheck;
  const ensureDatabase =
    options.ensureDatabase ?? ((input) => ensureDatabaseAvailable(input, checkDatabase));
  const ensureEmbedding =
    options.ensureEmbedding ??
    (async (input) =>
      ensureEmbeddingProvider({
        quiet: true,
        env: input.env,
        signal: input.signal,
      }));
  const fetchEmbeddings = options.fetchEmbeddings ?? fetchProjectRagPostgresEmbeddings;
  // The injected seams are used by unit tests and disposable fake services.
  // Native preparation must additionally verify the advertised model and tie
  // the successful probe to a CUDA-capable endpoint owner.
  const nativeEmbeddingHealth = !options.fetchEmbeddings && !options.resolveEmbedding;
  const startedAt = now();
  assertWithinDeadline(deadline, now, options.signal);
  await ensureDatabase({
    env: configuration.env,
    timeoutMs: remainingMs(deadline, now),
    signal: options.signal,
  });
  assertWithinDeadline(deadline, now, options.signal);

  const embeddingEnv = {
    ...configuration.env,
    EMBEDDING_AUTOSTART:
      configuration.lane === 'official' ? (configuration.env.EMBEDDING_AUTOSTART ?? '1') : '1',
    EMBEDDING_START_TIMEOUT_MS: String(remainingMs(deadline, now)),
    EMBEDDING_CONNECT_TIMEOUT_MS: String(Math.min(remainingMs(deadline, now), 10_000)),
    PROJECT_RAG_PREPARE_RUNTIME: configuration.lane,
  };
  try {
    await ensureEmbedding({
      env: embeddingEnv,
      signal: options.signal,
      timeoutMs: remainingMs(deadline, now),
    });
  } catch (error) {
    if (options.signal?.aborted || now() >= deadline) {
      throw runtimeDeadlineError();
    }
    if (error instanceof ProjectRagPrepareRuntimeError) throw error;
    throw new ProjectRagPrepareRuntimeError(
      'EMBEDDING_UNAVAILABLE',
      'Project RAG embedding service is not ready',
      { cause: safeCause(error) }
    );
  }

  assertWithinDeadline(deadline, now, options.signal);
  let vectors: number[][];
  let gpuProof: ProjectRagPrepareRuntimeIdentity['embedding']['gpuProof'] = nativeEmbeddingHealth
    ? 'cuda_capable_listener'
    : 'injected_test';
  try {
    if (nativeEmbeddingHealth) {
      const { checkLlamaCppGpuOffloadDuringRequest, checkModel } = await import(
        '../check-embedding-health.js'
      );
      const modelCheck = await checkModel(
        embedding.provider,
        embedding.baseUrl,
        embedding.model,
        Math.min(remainingMs(deadline, now), 10_000)
      );
      if (!modelCheck.ok) {
        throw new ProjectRagPrepareRuntimeError(
          'EMBEDDING_PROFILE_MISMATCH',
          'Project RAG embedding endpoint does not advertise the configured model',
          {
            healthMessage: redactCredentialText(modelCheck.message),
            healthDetails: modelCheck.details
              ? redactCredentialText(modelCheck.details)
              : undefined,
          }
        );
      }
      const healthProbe = await checkLlamaCppGpuOffloadDuringRequest(
        embedding.provider,
        embedding.baseUrl,
        () => fetchEmbeddings(embedding, ['project-rag readiness probe'], options.signal),
        undefined,
        undefined,
        embedding.dimensions
      );
      vectors = healthProbe.value;
      if (healthProbe.gpu.ok) {
        gpuProof = 'request_journal';
      } else if (
        healthProbe.gpu.level === 'warning' &&
        (configuration.lane === 'isolated_dev' || configuration.lane === 'test')
      ) {
        // Explicit isolated/test owners may run outside user journald.  The
        // helper's warning still proves loopback listener ownership and CUDA
        // backend/device handles; the real model probe below proves request
        // execution and dimensions.
        gpuProof = 'cuda_capable_listener';
      } else {
        throw new ProjectRagPrepareRuntimeError(
          'EMBEDDING_GPU_UNAVAILABLE',
          'Project RAG embedding GPU ownership could not be proven',
          {
            healthMessage: redactCredentialText(healthProbe.gpu.message),
            healthDetails: healthProbe.gpu.details
              ? redactCredentialText(healthProbe.gpu.details)
              : undefined,
          }
        );
      }
    } else {
      vectors = await fetchEmbeddings(embedding, ['project-rag readiness probe'], options.signal);
    }
  } catch (error) {
    if (options.signal?.aborted || now() >= deadline) {
      throw runtimeDeadlineError();
    }
    if (error instanceof ProjectRagPrepareRuntimeError) throw error;
    throw new ProjectRagPrepareRuntimeError(
      'EMBEDDING_UNAVAILABLE',
      'Project RAG embedding readiness probe failed',
      { cause: safeCause(error) }
    );
  }
  assertWithinDeadline(deadline, now, options.signal);
  const vector = vectors[0];
  if (!vector || vector.length !== embedding.dimensions) {
    throw new ProjectRagPrepareRuntimeError(
      'EMBEDDING_DIMENSION_MISMATCH',
      `Project RAG embedding readiness returned ${vector?.length ?? 0} dimensions; expected ${embedding.dimensions}`,
      { expectedDimensions: embedding.dimensions, observedDimensions: vector?.length ?? 0 }
    );
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new ProjectRagPrepareRuntimeError(
      'EMBEDDING_PROFILE_MISMATCH',
      'Project RAG embedding readiness returned a non-finite vector'
    );
  }

  return {
    identity: {
      lane: configuration.lane,
      owner: configuration.owner,
      databaseConfigured: configuration.databaseConfigured,
      embedding: {
        provider: embedding.provider,
        model: embedding.model,
        baseUrl: embedding.baseUrl,
        dimensions: embedding.dimensions,
        profileHash: embedding.profileHash,
        gpuProof,
        ready: true,
      },
    },
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

function startRuntimeReadinessOperation(
  key: string,
  configuration: RuntimeConfiguration,
  options: ProjectRagPrepareRuntimeOptions,
  embedding: ProjectRagPostgresEmbeddingConfig
): RuntimeReadinessOperation {
  const ownerController = new AbortController();
  const ownerNow = Date.now;
  const ownerTimeoutMs = runtimeReadinessBudgetMs(configuration.env);
  const ownerDeadline = ownerNow() + ownerTimeoutMs;
  const ownerTimer = setTimeout(
    () => ownerController.abort(new Error('Project RAG runtime readiness owner deadline exceeded')),
    ownerTimeoutMs
  );
  ownerTimer.unref?.();

  let operation!: RuntimeReadinessOperation;
  const ownerPromise = ensureRuntimeOnce(
    configuration,
    { ...options, signal: ownerController.signal },
    embedding,
    ownerDeadline,
    ownerNow
  ).finally(() => {
    clearTimeout(ownerTimer);
    if (runtimePromises.get(key) === operation) runtimePromises.delete(key);
  });
  void ownerPromise.catch(() => undefined);
  operation = { promise: ownerPromise };
  runtimePromises.set(key, operation);
  return operation;
}

function waitForRuntimeReadiness(
  operation: RuntimeReadinessOperation,
  deadline: number,
  now: () => number,
  signal?: AbortSignal
): Promise<ProjectRagPrepareRuntimeResult> {
  if (signal?.aborted || now() >= deadline) {
    return Promise.reject(runtimeDeadlineError(signal));
  }

  return new Promise<ProjectRagPrepareRuntimeResult>((resolve, reject) => {
    let settled = false;
    const callerTimer = setTimeout(
      () => finish(reject, runtimeDeadlineError(signal)),
      Math.max(1, deadline - now())
    );
    callerTimer.unref?.();

    const cleanup = () => {
      clearTimeout(callerTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = <T>(settle: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle(value);
    };
    const onAbort = () => finish(reject, runtimeDeadlineError(signal));

    signal?.addEventListener('abort', onAbort, { once: true });
    operation.promise.then(
      (result) => finish(resolve, result),
      (error: unknown) => finish(reject, error)
    );
  });
}

export async function ensureProjectRagRuntimeReady(
  options: ProjectRagPrepareRuntimeOptions = {}
): Promise<ProjectRagPrepareRuntimeResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const deadline =
    now() + (options.deadlineMs ?? positiveInteger(env.PROJECT_RAG_PREPARE_TIMEOUT_MS, 120_000));
  const configuration = resolveRuntimeConfiguration(env);
  const resolveEmbedding = options.resolveEmbedding ?? resolveProjectRagPostgresEmbeddingConfig;
  let embedding: ProjectRagPostgresEmbeddingConfig;
  try {
    embedding = resolveEmbedding(configuration.env);
  } catch (error) {
    throw new ProjectRagPrepareRuntimeError(
      'EMBEDDING_PROFILE_MISMATCH',
      'Project RAG embedding profile is not supported',
      { cause: safeCause(error) }
    );
  }
  const key = runtimeKey(configuration, embedding);
  const operation =
    runtimePromises.get(key) ??
    startRuntimeReadinessOperation(key, configuration, options, embedding);
  return waitForRuntimeReadiness(operation, deadline, now, options.signal);
}

export function clearProjectRagRuntimeReadinessForTesting(): void {
  runtimePromises.clear();
}
