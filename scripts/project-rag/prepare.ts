/**
 * One bounded, idempotent Project RAG preparation operation.
 *
 * CLI and MCP adapters call this module.  It is intentionally small at the
 * orchestration boundary: registration identity/scope, snapshot-gated ingest,
 * runtime readiness, and semantic verification remain owned by their current
 * modules.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { redactCredentialText } from '../../lib/shared/credential-redact.js';
import {
  suggestProjectIncludeRoots,
  validateProjectIncludeRoots,
} from '../../lib/shared/project-include-roots.js';
import {
  createProjectSlug,
  inferProjectNameFromRootPath,
  normalizeProjectRootPath,
} from '../../lib/shared/project-registry.js';
import { validateProjectRootPath } from '../../mcp/lib/path-validator.js';
import {
  ingestProjectRagPostgres,
  type ProjectRagPostgresIngestResult,
} from './ingest-postgres.js';
import { readRootManifest } from './root-manifest.js';
import {
  ensureProjectRagRuntimeReady,
  ProjectRagPrepareRuntimeError,
  type ProjectRagPrepareRuntimeOptions,
  type ProjectRagPrepareRuntimeResult,
} from './runtime-readiness.js';
import type { ProjectRagSql } from './store.js';
import { beginProjectRagWrite } from './transaction.js';
import { verifyProjectRagPostgres } from './verify-postgres.js';

export type ProjectPrepareStatus = 'ready' | 'running' | 'partial' | 'blocked' | 'failed';
export type ProjectPrepareStage = 'resolve' | 'runtime' | 'verify' | 'ingest' | 'ready';

export type ProjectPrepareErrorCode =
  | 'INVALID_ROOT'
  | 'UNTRUSTED_ROOT'
  | 'PROJECT_IDENTITY_MISMATCH'
  | 'PROJECT_ROOT_MISMATCH'
  | 'SCOPE_UNAVAILABLE'
  | 'RUNTIME_CONFIGURATION_MISSING'
  | 'RUNTIME_OWNERSHIP_CONFLICT'
  | 'EMBEDDING_UNAVAILABLE'
  | 'EMBEDDING_PROFILE_MISMATCH'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_GPU_UNAVAILABLE'
  | 'RUNTIME_UNAVAILABLE'
  | 'PROJECT_NOT_READY'
  | 'SNAPSHOT_REVIEW_REQUIRED'
  | 'SNAPSHOT_GATE_FAILED'
  | 'INGESTION_FAILED'
  | 'NO_PROGRESS'
  | 'PREPARATION_DEADLINE_EXCEEDED'
  | 'INTERNAL_ERROR';

export interface ProjectPrepareReason {
  readonly code: ProjectPrepareErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface ProjectPrepareProgress {
  readonly batch: number;
  readonly maxBatches: number;
  readonly indexed: number;
  readonly selected: number;
  readonly scanned: number;
  readonly deleted: number;
  readonly embeddings: number;
  readonly errors: number;
  readonly remaining: number;
  readonly elapsedMs: number;
}

export interface ProjectPrepareProjectIdentity {
  readonly id?: string;
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
  readonly includeRoots: readonly string[];
  readonly existing: boolean;
}

export interface ProjectPrepareResult {
  readonly status: ProjectPrepareStatus;
  readonly ready: boolean;
  readonly operation: {
    readonly id: string;
    readonly deduplicated: boolean;
  };
  readonly stage: ProjectPrepareStage;
  readonly project: ProjectPrepareProjectIdentity;
  readonly runtime?: ProjectRagPrepareRuntimeResult['identity'];
  readonly progress: ProjectPrepareProgress;
  readonly verification?: Record<string, unknown>;
  readonly reason?: ProjectPrepareReason;
  readonly nextAction?: string;
}

export interface ProjectPrepareRequest {
  readonly rootPath: string;
  readonly project?: string;
  readonly includeRoots?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxFiles?: number;
  readonly maxBatches?: number;
  readonly signal?: AbortSignal;
  readonly runtime?: ProjectRagPrepareRuntimeOptions;
}

export interface ProjectPrepareLookupProject {
  readonly id: string | number;
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
  readonly normalizedRootPath?: string;
  readonly includeRoots: readonly string[];
}

export interface ProjectPrepareDependencies {
  readonly lookupProject?: (input: {
    readonly rootPath: string;
    readonly project?: string;
    readonly env?: NodeJS.ProcessEnv;
  }) => Promise<ProjectPrepareLookupProject | undefined>;
  readonly inferIncludeRoots?: (rootPath: string) => Promise<readonly string[]>;
  readonly ensureRuntime?: (
    options: ProjectRagPrepareRuntimeOptions
  ) => Promise<ProjectRagPrepareRuntimeResult>;
  readonly ingest?: (args: {
    readonly projectSlug?: string;
    readonly rootPath: string;
    readonly includeRoots?: readonly string[];
    readonly maxFiles: number;
    readonly signal?: AbortSignal;
  }) => Promise<ProjectRagPostgresIngestResult>;
  readonly coordinateIngest?: (args: {
    readonly operationId: string;
    readonly projectId?: number;
    readonly projectSlug?: string;
    readonly rootPath: string;
    readonly includeRoots?: readonly string[];
    readonly maxFiles: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly env?: NodeJS.ProcessEnv;
  }) => Promise<{
    readonly result: ProjectRagPostgresIngestResult;
    readonly deduplicated: boolean;
  }>;
  readonly verify?: (args: {
    readonly project: string;
    readonly signal?: AbortSignal;
  }) => Promise<Record<string, unknown>>;
  readonly now?: () => number;
}

export class ProjectPrepareError extends Error {
  readonly code: ProjectPrepareErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ProjectPrepareErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ProjectPrepareError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_MAX_FILES = 120;
const DEFAULT_MAX_BATCHES = 32;
const DEFAULT_TIMEOUT_MS = 120_000;
const COMMON_TRUSTED_ROOTS = ['01_projects/dev', '01_projects/experiments', '01_projects/external'];
const PROJECT_INGEST_FULL_JOB = 'project_ingest_full';
const PROJECT_PREPARE_JOB_LEASE_SECONDS = 300;
const PROJECT_PREPARE_JOB_POLL_MS = 100;

let defaultDependencies: ProjectPrepareDependencies | undefined;
const activePreparations = new Map<string, Promise<ProjectPrepareResult>>();

const NATIVE_ENV_CONTEXT_GROUPS = [
  {
    name: 'database',
    keys: ['PROJECT_RAG_DATABASE_URL', 'PROJECT_RAG_POSTGRES_URL', 'POSTGRES_URL', 'DATABASE_URL'],
  },
  {
    name: 'database_allow_local_default',
    keys: ['PROJECT_RAG_ALLOW_LOCAL_DEFAULT'],
  },
  {
    name: 'database_timeout',
    keys: [
      'PROJECT_RAG_DB_TIMEOUT_MS',
      'PROJECT_RAG_DB_POOL_MAX',
      'PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS',
      'PROJECT_RAG_DB_MAX_LIFETIME_MS',
      'PROJECT_RAG_DB_START_POLL_INTERVAL_MS',
    ],
  },
  {
    name: 'database_start_command',
    keys: ['PROJECT_RAG_DATABASE_START_COMMAND'],
  },
  {
    name: 'runtime_lane',
    keys: ['PROJECT_RAG_PREPARE_RUNTIME', 'PROJECT_RAG_RUNTIME_LANE'],
  },
  {
    name: 'project_embedding_endpoint',
    keys: ['PROJECT_RAG_PG_EMBEDDING_BASE_URL'],
  },
  {
    name: 'project_embedding_model',
    keys: [
      'PROJECT_RAG_PG_EMBEDDING_MODEL',
      'PROJECT_RAG_EMBEDDING_MODEL',
      'LLAMACPP_EMBEDDING_MODEL',
      'EMBEDDING_MODEL',
    ],
  },
  {
    name: 'project_embedding_dimensions',
    keys: [
      'PROJECT_RAG_PG_EMBEDDING_DIMENSIONS',
      'PROJECT_RAG_EMBEDDING_DIMENSIONS',
      'LLAMACPP_EMBEDDING_DIMENSIONS',
      'EMBEDDING_DIMENSIONS',
      'EMBEDDING_EXPECTED_DIMENSIONS',
    ],
  },
  {
    name: 'project_embedding_timeout',
    keys: ['PROJECT_RAG_PG_EMBEDDING_TIMEOUT_MS'],
  },
  {
    name: 'embedding_start_command',
    keys: [
      'PROJECT_RAG_EMBEDDING_START_COMMAND',
      'EMBEDDING_START_COMMAND',
      'LLAMACPP_START_COMMAND',
      'RAG_LLAMACPP_START_COMMAND',
    ],
  },
  {
    name: 'embedding_provider',
    keys: ['EMBEDDING_PROVIDER'],
  },
  {
    name: 'embedding_autostart',
    keys: ['EMBEDDING_AUTOSTART'],
  },
  {
    name: 'embedding_connect_timeout',
    keys: [
      'EMBEDDING_START_TIMEOUT_MS',
      'EMBEDDING_CONNECT_TIMEOUT_MS',
      'LLAMACPP_CONNECT_TIMEOUT_MS',
    ],
  },
  {
    name: 'embedding_poll_interval',
    keys: ['EMBEDDING_START_POLL_INTERVAL_MS'],
  },
  {
    name: 'docs_embedding_endpoint',
    keys: ['DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL'],
  },
  {
    name: 'docs_embedding_model',
    keys: ['DOCS_RAG_PG_LAB_EMBEDDING_MODEL'],
  },
] as const;

function effectiveNativeEnvValue(
  env: NodeJS.ProcessEnv,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = normalizeText(env[key]);
    if (value) return value;
  }
  return undefined;
}

function nativeEnvironmentDifferences(
  requestEnv: NodeJS.ProcessEnv,
  processEnv: NodeJS.ProcessEnv
): string[] {
  return NATIVE_ENV_CONTEXT_GROUPS.filter(
    (group) =>
      effectiveNativeEnvValue(requestEnv, group.keys) !==
      effectiveNativeEnvValue(processEnv, group.keys)
  ).map((group) => group.name);
}

function usesNativePreparationEnvironment(dependencies?: ProjectPrepareDependencies): boolean {
  return (
    !dependencies?.ensureRuntime ||
    !dependencies.lookupProject ||
    !dependencies.verify ||
    (!dependencies.coordinateIngest && !dependencies.ingest)
  );
}

function assertNativeEnvironmentBoundary(
  request: ProjectPrepareRequest,
  dependencies?: ProjectPrepareDependencies
): void {
  const requestEnv = request.runtime?.env;
  if (!requestEnv || !usesNativePreparationEnvironment(dependencies)) return;

  const divergentContext = nativeEnvironmentDifferences(requestEnv, process.env);
  if (divergentContext.length === 0) return;

  throw new ProjectPrepareError(
    'RUNTIME_OWNERSHIP_CONFLICT',
    'Native Project RAG preparation requires the request runtime environment to match the process-owned database and embedding context',
    { divergentContext }
  );
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max?: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProjectPrepareError('INTERNAL_ERROR', 'Preparation bounds must be positive integers');
  }
  return max ? Math.min(value, max) : value;
}

function canonicalRoot(rootPath: string): string {
  const validation = validateProjectRootPath(rootPath);
  if (!validation.valid) {
    throw new ProjectPrepareError('INVALID_ROOT', validation.error, { code: validation.code });
  }
  try {
    return normalizeProjectRootPath(realpathSync.native(validation.resolvedPath));
  } catch (error) {
    throw new ProjectPrepareError('INVALID_ROOT', 'Project root could not be canonicalized', {
      cause: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    });
  }
}

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function trustedRoots(env: NodeJS.ProcessEnv): string[] {
  const configured = normalizeText(env.PROJECT_RAG_TRUSTED_ROOTS);
  if (configured) {
    return configured
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        try {
          return realpathSync.native(resolve(entry));
        } catch {
          return resolve(entry);
        }
      });
  }
  const home = normalizeText(env.HOME);
  return home ? COMMON_TRUSTED_ROOTS.map((entry) => join(home, entry)) : [];
}

function assertTrustedRoot(rootPath: string, env: NodeJS.ProcessEnv): void {
  const roots = trustedRoots(env);
  if (roots.length > 0 && roots.some((trustedRoot) => isInside(trustedRoot, rootPath))) {
    return;
  }
  throw new ProjectPrepareError(
    'UNTRUSTED_ROOT',
    'Project root is outside the configured trusted Project RAG roots',
    { trustedRootCount: roots.length }
  );
}

async function inferIncludeRootsDefault(rootPath: string): Promise<readonly string[]> {
  const manifest = await readRootManifest(rootPath);
  if (manifest.present && !manifest.ok) {
    throw new ProjectPrepareError(
      'SCOPE_UNAVAILABLE',
      `Project RAG root manifest is invalid: ${manifest.errors.join('; ')}`
    );
  }
  const manifestRoots = manifest.present && manifest.ok ? manifest.manifest.includeRoots : [];
  const candidates =
    manifestRoots.length > 0 ? manifestRoots : suggestProjectIncludeRoots(rootPath);
  const validation = validateProjectIncludeRoots(rootPath, [...candidates]);
  if (!validation.valid) {
    throw new ProjectPrepareError('SCOPE_UNAVAILABLE', validation.error, {
      suggestions: validation.suggestions.slice(0, 16),
    });
  }
  return validation.includeRoots;
}

async function lookupProjectDefault(input: {
  readonly rootPath: string;
  readonly project?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<ProjectPrepareLookupProject | undefined> {
  const [{ resolveProjectRagPostgresWriteConfig }, store] = await Promise.all([
    import('./config.js'),
    import('./store.js'),
  ]);
  const config = resolveProjectRagPostgresWriteConfig(input.env);
  const sql = store.createProjectRagPostgresSql(config);
  const byRoot = await store.findProjectRagPostgresProjectByRootPath(sql, input.rootPath);
  const byRef = input.project
    ? await store.findProjectRagPostgresProject(sql, input.project)
    : undefined;
  if (byRef && (byRef.normalizedRootPath || byRef.rootPath) !== input.rootPath) {
    throw new ProjectPrepareError(
      'PROJECT_ROOT_MISMATCH',
      `Project "${input.project}" is registered at a different root`,
      { project: input.project }
    );
  }
  if (byRoot && byRef && byRoot.id !== byRef.id) {
    throw new ProjectPrepareError(
      'PROJECT_IDENTITY_MISMATCH',
      `Root is registered as "${byRoot.slug}"; requested project identity does not match`,
      { requestedProject: input.project, registeredProject: byRoot.slug }
    );
  }
  const selected = byRef ?? byRoot;
  if (!selected) return undefined;
  return {
    id: selected.id,
    slug: selected.slug,
    name: selected.name,
    rootPath: selected.rootPath,
    includeRoots: selected.includeRoots,
  };
}

async function ingestDefault(args: {
  readonly projectSlug?: string;
  readonly rootPath: string;
  readonly includeRoots?: readonly string[];
  readonly maxFiles: number;
  readonly signal?: AbortSignal;
}): Promise<ProjectRagPostgresIngestResult> {
  return ingestProjectRagPostgres({
    ...(args.projectSlug ? { projectSlug: args.projectSlug } : {}),
    rootPath: args.rootPath,
    ...(args.includeRoots ? { includeRoots: args.includeRoots } : {}),
    force: false,
    maxFiles: args.maxFiles,
    signal: args.signal,
  });
}

type PreparationJobClaim = {
  readonly id: number;
  readonly fenceToken: number;
};

function preparationWorkerId(operationId: string): string {
  return `prepare-${process.pid}-${operationId.slice(0, 12)}-${Date.now().toString(36)}`;
}

function preparationJobDedupeKey(args: {
  readonly projectId?: number;
  readonly projectSlug?: string;
  readonly rootPath: string;
  readonly includeRoots?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): string {
  const env = args.env ?? process.env;
  const database =
    env.PROJECT_RAG_DATABASE_URL ??
    env.PROJECT_RAG_POSTGRES_URL ??
    env.POSTGRES_URL ??
    env.DATABASE_URL ??
    '';
  const lane = env.PROJECT_RAG_PREPARE_RUNTIME ?? env.PROJECT_RAG_RUNTIME_LANE ?? '';
  const embedding =
    env.PROJECT_RAG_PG_EMBEDDING_BASE_URL ?? env.DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL ?? '';
  const model =
    env.PROJECT_RAG_PG_EMBEDDING_MODEL ??
    env.PROJECT_RAG_EMBEDDING_MODEL ??
    env.LLAMACPP_EMBEDDING_MODEL ??
    '';
  const dimensions =
    env.PROJECT_RAG_PG_EMBEDDING_DIMENSIONS ?? env.PROJECT_RAG_EMBEDDING_DIMENSIONS ?? '';
  const identity =
    args.projectId !== undefined
      ? `project-id:${args.projectId}`
      : `root:${args.rootPath}\nproject:${args.projectSlug ?? ''}\nscope:${[...(args.includeRoots ?? [])].sort().join(',')}`;
  return createHash('sha256')
    .update(
      `project-rag-prepare-job\n${identity}\nlane:${lane}\ndatabase:${database}\nembedding:${embedding}\nmodel:${model}\ndimensions:${dimensions}`
    )
    .digest('hex')
    .slice(0, 48);
}

/** Claim only the operation's durable job; the generic worker claim is global. */
async function claimPreparationJob(
  sql: ProjectRagSql,
  jobId: number,
  workerId: string,
  leaseSeconds: number
): Promise<PreparationJobClaim | undefined> {
  const rows = (await beginProjectRagWrite(
    sql,
    async (tx) =>
      tx`
      with candidate as (
        select id from project_jobs
        where id = ${jobId}
          and (
            (status in ('queued', 'retry-wait') and available_at <= clock_timestamp())
            or (status = 'running' and lease_expires_at <= clock_timestamp())
          )
          and attempts < max_attempts
          and cancel_requested_at is null
        for update skip locked
      )
      update project_jobs j set status = 'running', worker_id = ${workerId},
        attempts = j.attempts + 1, last_attempt_at = now(), heartbeat_at = now(),
        lease_expires_at = clock_timestamp() + make_interval(secs => ${leaseSeconds}),
        available_at = clock_timestamp(), cancel_requested_at = null,
        status_reason = null, fence_token = j.fence_token + 1,
        started_at = coalesce(j.started_at, now()), updated_at = now()
      from candidate where j.id = candidate.id
      returning j.id, j.fence_token
    `
  )) as Array<{ id?: number | string; fence_token?: number | string }>;
  const row = rows[0];
  const id = Number(row?.id);
  const fenceToken = Number(row?.fence_token);
  return Number.isInteger(id) && id > 0 && Number.isInteger(fenceToken)
    ? { id, fenceToken }
    : undefined;
}

function syntheticCompletedIngest(
  projectSlug: string,
  projectId: number | undefined,
  result: unknown,
  jobFinalized = false
): ProjectRagPostgresIngestResult {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const finalStatus = record.finalStatus === 'completed' ? 'completed' : 'partial';
  return {
    projectId: projectSlug,
    slug: projectSlug,
    postgresId: projectId ?? 0,
    finalStatus,
    ...(jobFinalized ? { jobFinalized: true } : {}),
    stats: {
      filesScanned: 0,
      filesSelected: 0,
      filesIndexed: 0,
      filesBlocked: 0,
      filesDeleted: 0,
      chunksCreated: 0,
      embeddingsCreated: 0,
      errors: [],
    },
    ...(record.snapshotGate && typeof record.snapshotGate === 'object'
      ? { snapshotGate: record.snapshotGate as ProjectRagPostgresIngestResult['snapshotGate'] }
      : {}),
  };
}

async function coordinateIngestDefault(args: {
  readonly operationId: string;
  readonly projectId?: number;
  readonly projectSlug?: string;
  readonly rootPath: string;
  readonly includeRoots?: readonly string[];
  readonly maxFiles: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{
  readonly result: ProjectRagPostgresIngestResult;
  readonly deduplicated: boolean;
}> {
  const [{ resolveProjectRagPostgresWriteConfig }, store] = await Promise.all([
    import('./config.js'),
    import('./store.js'),
  ]);
  const sql = store.createProjectRagPostgresSql(
    resolveProjectRagPostgresWriteConfig(args.env ?? process.env)
  );
  const enqueued = await store.enqueueProjectRagJob(sql, {
    type: PROJECT_INGEST_FULL_JOB,
    ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
    dedupeKey: preparationJobDedupeKey(args),
    payload: {
      projectSlug: args.projectSlug,
      rootPath: args.rootPath,
      includeRoots: args.includeRoots,
      maxFiles: args.maxFiles,
      force: false,
    },
    maxAttempts: 3,
  });
  const workerId = preparationWorkerId(args.operationId);
  const deadline = Date.now() + Math.max(1, args.timeoutMs);
  let claimed = await claimPreparationJob(
    sql,
    enqueued.id,
    workerId,
    Math.max(PROJECT_PREPARE_JOB_LEASE_SECONDS, Math.ceil(args.timeoutMs / 1000) + 30)
  );

  const runClaimed = async (
    claim: PreparationJobClaim
  ): Promise<{
    readonly result: ProjectRagPostgresIngestResult;
    readonly deduplicated: boolean;
  }> => {
    let leaseLost = false;
    const deadlineController = new AbortController();
    const abortFromRequest = () => {
      if (!deadlineController.signal.aborted) {
        deadlineController.abort(args.signal?.reason);
      }
    };
    if (args.signal?.aborted) {
      abortFromRequest();
    } else {
      args.signal?.addEventListener('abort', abortFromRequest, { once: true });
    }
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(new Error('Project preparation deadline exceeded')),
      Math.max(0, deadline - Date.now())
    );
    deadlineTimer.unref?.();
    const assertOwnership = async (): Promise<void> => {
      if (leaseLost) throw new Error('Project RAG preparation job lease was lost');
      if (args.signal?.aborted)
        throw new ProjectPrepareError(
          'PREPARATION_DEADLINE_EXCEEDED',
          'Project preparation was cancelled'
        );
      if (deadlineController.signal.aborted || Date.now() >= deadline) {
        throw new ProjectPrepareError(
          'PREPARATION_DEADLINE_EXCEEDED',
          'Project preparation exceeded its bounded deadline'
        );
      }
      const renewed = await store.renewProjectRagJobLease(
        sql,
        claim.id,
        claim.fenceToken,
        Math.max(PROJECT_PREPARE_JOB_LEASE_SECONDS, Math.ceil(args.timeoutMs / 1000) + 30)
      );
      if (!renewed) {
        leaseLost = true;
        throw new Error('Project RAG preparation job lease was lost');
      }
      if (renewed.cancelRequestedAt) {
        throw new ProjectPrepareError(
          'PREPARATION_DEADLINE_EXCEEDED',
          'Project preparation was cancelled'
        );
      }
    };

    try {
      // The job may have been queued after another process published the
      // required build but before this caller acquired the row. Reverify
      // under the durable owner before starting a second ingest publication.
      if (args.projectSlug) {
        let alreadyReady = false;
        try {
          alreadyReady = verificationReady(
            await verifyDefault({ project: args.projectSlug, signal: deadlineController.signal })
          );
        } catch {
          // The ingest path remains the source of truth when verification is
          // temporarily unavailable; it will fail closed if the runtime is
          // not actually usable.
        }
        await assertOwnership();
        if (alreadyReady) {
          const noOpResult = syntheticCompletedIngest(
            args.projectSlug,
            args.projectId,
            { finalStatus: 'completed' },
            true
          );
          const finished = await store.finishProjectRagJob(
            sql,
            claim.id,
            claim.fenceToken,
            { finalStatus: 'completed', skipped: 'already_ready' },
            'succeeded'
          );
          if (!finished) {
            throw new Error('Project RAG preparation job lease was lost before no-op completion');
          }
          return { result: noOpResult, deduplicated: true };
        }
      }
      const result = await ingestProjectRagPostgres({
        ...(args.projectSlug ? { projectSlug: args.projectSlug } : {}),
        rootPath: args.rootPath,
        ...(args.includeRoots ? { includeRoots: args.includeRoots } : {}),
        force: false,
        maxFiles: args.maxFiles,
        signal: deadlineController.signal,
        jobLease: { jobId: claim.id, fenceToken: claim.fenceToken, assertOwnership },
      });
      if (!result.jobFinalized) {
        if (result.snapshotGate?.status === 'REVIEW_REQUIRED') {
          await store.blockProjectRagJobForReview(
            sql,
            claim.id,
            claim.fenceToken,
            { finalStatus: result.finalStatus, snapshotGate: result.snapshotGate },
            'Project RAG preparation is blocked pending snapshot review'
          );
        } else {
          await store.finishProjectRagJob(
            sql,
            claim.id,
            claim.fenceToken,
            { finalStatus: result.finalStatus, snapshotGate: result.snapshotGate ?? null },
            'failed'
          );
        }
      }
      return { result, deduplicated: false };
    } catch (error) {
      const boundedError = deadlineController.signal.aborted
        ? new ProjectPrepareError(
            'PREPARATION_DEADLINE_EXCEEDED',
            'Project preparation exceeded its bounded deadline'
          )
        : error;
      await store
        .failProjectRagJob(
          sql,
          claim.id,
          claim.fenceToken,
          redactCredentialText(
            boundedError instanceof Error ? boundedError.message : String(boundedError)
          ),
          { retryable: true }
        )
        .catch(() => undefined);
      throw boundedError;
    } finally {
      clearTimeout(deadlineTimer);
      args.signal?.removeEventListener('abort', abortFromRequest);
    }
  };

  while (!claimed && Date.now() < deadline) {
    if (args.signal?.aborted) {
      throw new ProjectPrepareError(
        'PREPARATION_DEADLINE_EXCEEDED',
        'Project preparation was cancelled'
      );
    }
    const job = await store.getProjectRagJob(sql, enqueued.id);
    if (!job)
      throw new ProjectPrepareError('INGESTION_FAILED', 'Project preparation job disappeared');
    if (job.status === 'succeeded') {
      return {
        result: syntheticCompletedIngest(args.projectSlug ?? 'project', args.projectId, job.result),
        deduplicated: true,
      };
    }
    if (job.status === 'blocked-review') {
      return {
        result: syntheticCompletedIngest(args.projectSlug ?? 'project', args.projectId, job.result),
        deduplicated: true,
      };
    }
    if (job.status === 'failed' || job.status === 'dead-letter' || job.status === 'cancelled') {
      throw new ProjectPrepareError(
        'INGESTION_FAILED',
        redactCredentialText(job.error ?? job.statusReason ?? 'Project preparation job failed')
      );
    }
    claimed = await claimPreparationJob(
      sql,
      enqueued.id,
      workerId,
      Math.max(PROJECT_PREPARE_JOB_LEASE_SECONDS, Math.ceil(args.timeoutMs / 1000) + 30)
    );
    if (!claimed)
      await sleep(Math.min(PROJECT_PREPARE_JOB_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  if (!claimed) {
    throw new ProjectPrepareError(
      'PREPARATION_DEADLINE_EXCEEDED',
      'Project preparation waited for another durable ingest owner past its deadline'
    );
  }
  return runClaimed(claimed);
}

async function verifyDefault(args: {
  readonly project: string;
  readonly signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return (await verifyProjectRagPostgres({
    project: args.project,
    query: 'project rag preparation',
    limit: 3,
    signal: args.signal,
  })) as Record<string, unknown>;
}

function getDefaultDependencies(): ProjectPrepareDependencies {
  if (defaultDependencies) return defaultDependencies;
  defaultDependencies = {
    lookupProject: lookupProjectDefault,
    inferIncludeRoots: inferIncludeRootsDefault,
    ensureRuntime: ensureProjectRagRuntimeReady,
    coordinateIngest: coordinateIngestDefault,
    verify: verifyDefault,
  };
  return defaultDependencies;
}

export function setProjectPrepareDependenciesForTesting(
  dependencies: ProjectPrepareDependencies | null
): void {
  defaultDependencies = dependencies ?? undefined;
  if (!dependencies) activePreparations.clear();
}

function operationId(rootPath: string, request: ProjectPrepareRequest): string {
  const env = request.runtime?.env ?? process.env;
  const database =
    env.PROJECT_RAG_DATABASE_URL ??
    env.PROJECT_RAG_POSTGRES_URL ??
    env.POSTGRES_URL ??
    env.DATABASE_URL ??
    '';
  const lane = env.PROJECT_RAG_PREPARE_RUNTIME ?? env.PROJECT_RAG_RUNTIME_LANE ?? '';
  const embedding = env.PROJECT_RAG_PG_EMBEDDING_BASE_URL ?? '';
  const model =
    env.PROJECT_RAG_PG_EMBEDDING_MODEL ??
    env.PROJECT_RAG_EMBEDDING_MODEL ??
    env.LLAMACPP_EMBEDDING_MODEL ??
    '';
  const dimensions =
    env.PROJECT_RAG_PG_EMBEDDING_DIMENSIONS ?? env.PROJECT_RAG_EMBEDDING_DIMENSIONS ?? '';
  const scope = [...(request.includeRoots ?? [])].sort().join(',');
  return createHash('sha256')
    .update(
      `project-rag-prepare\n${rootPath}\n${request.project ?? ''}\n${scope}\n${lane}\n${database}\n${embedding}\n${model}\n${dimensions}`
    )
    .digest('hex')
    .slice(0, 24);
}

function emptyProgress(
  now: () => number,
  startedAt: number,
  maxBatches: number
): ProjectPrepareProgress {
  return {
    batch: 0,
    maxBatches,
    indexed: 0,
    selected: 0,
    scanned: 0,
    deleted: 0,
    embeddings: 0,
    errors: 0,
    remaining: 0,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

function resultProject(
  rootPath: string,
  selected: ProjectPrepareLookupProject | undefined,
  includeRoots: readonly string[],
  project?: string
): ProjectPrepareProjectIdentity {
  const name = selected?.name ?? inferProjectNameFromRootPath(rootPath);
  const slug = selected?.slug ?? project ?? createProjectSlug(name);
  return {
    ...(selected?.id !== undefined ? { id: String(selected.id) } : {}),
    slug,
    name,
    rootPath,
    includeRoots,
    existing: Boolean(selected),
  };
}

type PreparationWaitOutcome =
  | { readonly kind: 'completed'; readonly result: ProjectPrepareResult }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timed_out' };

async function waitForActivePreparation(
  operation: Promise<ProjectPrepareResult>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProjectPrepareResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const owner = operation.then<PreparationWaitOutcome, PreparationWaitOutcome>(
    (result) => ({ kind: 'completed', result }),
    (error: unknown) => ({ kind: 'failed', error })
  );
  const waiter = new Promise<PreparationWaitOutcome>((resolveWaiter) => {
    timer = setTimeout(() => resolveWaiter({ kind: 'timed_out' }), timeoutMs);
    timer.unref?.();
    abort = () => resolveWaiter({ kind: 'timed_out' });
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
  });
  try {
    const outcome = await Promise.race([owner, waiter]);
    if (outcome.kind === 'failed') throw outcome.error;
    return outcome.kind === 'completed' ? outcome.result : undefined;
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

function verificationReady(report: Record<string, unknown>): boolean {
  const gate = report.gateSignal;
  return Boolean(
    report.ok === true &&
      gate &&
      typeof gate === 'object' &&
      (gate as { ready?: unknown }).ready === true
  );
}

function verificationReason(report: Record<string, unknown>): string | undefined {
  const gate = report.gateSignal;
  if (gate && typeof gate === 'object') {
    const code = (gate as { blockingFailureCode?: unknown }).blockingFailureCode;
    return typeof code === 'string' ? code : undefined;
  }
  const issues = report.issues;
  return Array.isArray(issues) && typeof issues[0] === 'string' ? issues[0] : undefined;
}

function progressFromIngest(
  previous: ProjectPrepareProgress,
  ingest: ProjectRagPostgresIngestResult,
  batch: number,
  maxBatches: number,
  now: () => number,
  startedAt: number
): ProjectPrepareProgress {
  const remaining = ingest.continuation?.remainingOperations ?? 0;
  return {
    batch,
    maxBatches,
    indexed: previous.indexed + ingest.stats.filesIndexed,
    selected: previous.selected + ingest.stats.filesSelected,
    scanned: previous.scanned + ingest.stats.filesScanned,
    deleted: previous.deleted + ingest.stats.filesDeleted,
    embeddings: previous.embeddings + ingest.stats.embeddingsCreated,
    errors: previous.errors + ingest.stats.errors.length,
    remaining,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

function isDeadlineError(error: unknown): boolean {
  return (
    error instanceof ProjectRagPrepareRuntimeError && error.code === 'RUNTIME_DEADLINE_EXCEEDED'
  );
}

function normalizeFailure(error: unknown): ProjectPrepareReason {
  if (error instanceof ProjectPrepareError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof ProjectRagPrepareRuntimeError) {
    const code: ProjectPrepareErrorCode =
      error.code === 'RUNTIME_CONFIGURATION_MISSING'
        ? 'RUNTIME_CONFIGURATION_MISSING'
        : error.code === 'RUNTIME_OWNERSHIP_CONFLICT'
          ? 'RUNTIME_OWNERSHIP_CONFLICT'
          : error.code === 'EMBEDDING_UNAVAILABLE'
            ? 'EMBEDDING_UNAVAILABLE'
            : error.code === 'EMBEDDING_PROFILE_MISMATCH'
              ? 'EMBEDDING_PROFILE_MISMATCH'
              : error.code === 'EMBEDDING_DIMENSION_MISMATCH'
                ? 'EMBEDDING_DIMENSION_MISMATCH'
                : error.code === 'EMBEDDING_GPU_UNAVAILABLE'
                  ? 'EMBEDDING_GPU_UNAVAILABLE'
                  : error.code === 'RUNTIME_DEADLINE_EXCEEDED'
                    ? 'PREPARATION_DEADLINE_EXCEEDED'
                    : 'RUNTIME_UNAVAILABLE';
    return { code, message: error.message, details: error.details };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const safe = redactCredentialText(raw).slice(0, 600);
  return { code: 'INTERNAL_ERROR', message: safe };
}

async function executePreparation(
  request: ProjectPrepareRequest,
  dependencies: ProjectPrepareDependencies,
  rootPath: string,
  id: string,
  startedAt: number,
  timeoutMs: number,
  maxFiles: number,
  maxBatches: number,
  now: () => number
): Promise<ProjectPrepareResult> {
  const progress = emptyProgress(now, startedAt, maxBatches);
  let selected: ProjectPrepareLookupProject | undefined;
  let includeRoots: readonly string[] = request.includeRoots ?? [];
  let runtime: ProjectRagPrepareRuntimeResult | undefined;
  const preparationController = new AbortController();
  const abortFromRequest = () => {
    if (!preparationController.signal.aborted) {
      preparationController.abort(request.signal?.reason);
    }
  };
  if (request.signal?.aborted) {
    abortFromRequest();
  } else {
    request.signal?.addEventListener('abort', abortFromRequest, { once: true });
  }
  const preparationTimer = setTimeout(
    () => preparationController.abort(new Error('Project preparation deadline exceeded')),
    Math.max(0, startedAt + timeoutMs - now())
  );
  preparationTimer.unref?.();
  const assertPreparationActive = (): void => {
    if (preparationController.signal.aborted || now() - startedAt >= timeoutMs) {
      throw new ProjectPrepareError(
        'PREPARATION_DEADLINE_EXCEEDED',
        request.signal?.aborted
          ? 'Project preparation was cancelled'
          : 'Project preparation exceeded its bounded deadline'
      );
    }
  };

  const baseProject = () => resultProject(rootPath, selected, includeRoots, request.project);
  try {
    assertPreparationActive();
    const runtimeDeadlineMs = Math.max(1, timeoutMs - (now() - startedAt));
    runtime = await (dependencies.ensureRuntime ?? ensureProjectRagRuntimeReady)({
      ...(request.runtime ?? {}),
      deadlineMs: runtimeDeadlineMs,
      signal: preparationController.signal,
    });

    assertPreparationActive();
    selected = await (dependencies.lookupProject ?? lookupProjectDefault)({
      rootPath,
      project: request.project,
      env: request.runtime?.env,
    });
    assertPreparationActive();
    if (request.project && !selected) {
      throw new ProjectPrepareError(
        'PROJECT_IDENTITY_MISMATCH',
        `Project not found: ${request.project}`
      );
    }
    if (selected && selected.includeRoots.length === 0) {
      throw new ProjectPrepareError(
        'SCOPE_UNAVAILABLE',
        'Registered project has no include roots; preparation will not widen its scope'
      );
    }
    includeRoots = selected?.includeRoots ?? includeRoots;
    if (includeRoots.length === 0) {
      includeRoots = await (dependencies.inferIncludeRoots ?? inferIncludeRootsDefault)(rootPath);
      assertPreparationActive();
    }
    const project = baseProject();
    const operation = { id, deduplicated: false };

    let verification: Record<string, unknown> | undefined;
    if (selected) {
      assertPreparationActive();
      verification = await (dependencies.verify ?? verifyDefault)({
        project: selected.slug,
        signal: preparationController.signal,
      });
      assertPreparationActive();
      if (verificationReady(verification)) {
        return {
          status: 'ready',
          ready: true,
          operation,
          stage: 'ready',
          project,
          runtime: runtime.identity,
          progress: { ...progress, elapsedMs: Math.max(0, now() - startedAt) },
          verification,
        };
      }
    }

    let currentProgress = progress;
    let lastRemaining = Number.POSITIVE_INFINITY;
    for (let batch = 1; batch <= maxBatches; batch += 1) {
      if (preparationController.signal.aborted || now() - startedAt >= timeoutMs) {
        return {
          status: 'partial',
          ready: false,
          operation,
          stage: 'ingest',
          project: baseProject(),
          runtime: runtime.identity,
          progress: { ...currentProgress, elapsedMs: Math.max(0, now() - startedAt) },
          ...(verification ? { verification } : {}),
          reason: {
            code: 'PREPARATION_DEADLINE_EXCEEDED',
            message: 'Project preparation exceeded its bounded deadline',
          },
          nextAction: `Retry preparation with project=${baseProject().slug}; the next run resumes the same non-forced delta.`,
        };
      }

      assertPreparationActive();
      const coordinated = dependencies.coordinateIngest
        ? await dependencies.coordinateIngest({
            operationId: id,
            ...(selected && Number.isInteger(Number(selected.id))
              ? { projectId: Number(selected.id) }
              : {}),
            ...(selected?.slug ? { projectSlug: selected.slug } : {}),
            rootPath,
            ...(includeRoots.length > 0 && !selected ? { includeRoots } : {}),
            maxFiles,
            timeoutMs: Math.max(1, timeoutMs - (now() - startedAt)),
            signal: preparationController.signal,
            env: request.runtime?.env,
          })
        : {
            result: await (dependencies.ingest ?? ingestDefault)({
              ...(selected?.slug ? { projectSlug: selected.slug } : {}),
              rootPath,
              ...(includeRoots.length > 0 && !selected ? { includeRoots } : {}),
              maxFiles,
              signal: preparationController.signal,
            }),
            deduplicated: false,
          };
      operation.deduplicated = coordinated.deduplicated;
      const ingest = coordinated.result;
      currentProgress = progressFromIngest(
        currentProgress,
        ingest,
        batch,
        maxBatches,
        now,
        startedAt
      );
      assertPreparationActive();
      includeRoots = selected?.includeRoots ?? includeRoots;
      if (!selected) {
        assertPreparationActive();
        selected = await (dependencies.lookupProject ?? lookupProjectDefault)({
          rootPath,
          env: request.runtime?.env,
        });
        assertPreparationActive();
      }
      const selectedSlug =
        selected?.slug ??
        request.project ??
        createProjectSlug(inferProjectNameFromRootPath(rootPath));
      verification = await (dependencies.verify ?? verifyDefault)({
        project: selectedSlug,
        signal: preparationController.signal,
      });
      assertPreparationActive();
      if (verificationReady(verification)) {
        return {
          status: 'ready',
          ready: true,
          operation,
          stage: 'ready',
          project: baseProject(),
          runtime: runtime.identity,
          progress: currentProgress,
          verification,
        };
      }

      const remaining = currentProgress.remaining;
      const resumablePartialGate =
        ingest.snapshotGate?.status === 'FAILED' &&
        ingest.snapshotGate.thresholdResult.startsWith('partial_ingest_not_consumed:') &&
        remaining > 0;
      if (ingest.snapshotGate?.status === 'FAILED' && !resumablePartialGate) {
        const gate = ingest.snapshotGate;
        return {
          status: 'blocked',
          ready: false,
          operation,
          stage: 'ingest',
          project: baseProject(),
          runtime: runtime.identity,
          progress: currentProgress,
          verification,
          reason: {
            code: 'SNAPSHOT_GATE_FAILED',
            message: `Project preparation snapshot gate failed: ${redactCredentialText(gate.thresholdResult)}`,
            details: {
              snapshotUuid: gate.snapshotUuid,
              status: gate.status,
              thresholdResult: redactCredentialText(gate.thresholdResult),
              blockedFindingCategories: redactCredentialText(
                gate.preflightSummary.blockedFindingCategories
              ),
            },
          },
          nextAction: 'Correct the named scope findings, then retry preparation for this project.',
        };
      }
      const concurrentPublication =
        ingest.finalStatus === 'completed' &&
        verificationReason(verification) === 'PROJECT_INDEX_EMPTY';
      if (concurrentPublication && batch < maxBatches) {
        // A second process can observe the fenced ingest's inventory after
        // it has claimed work but before the first process publishes its
        // build. Give that owner a bounded chance to publish before
        // reporting a true zero-progress blocker.
        await sleep(Math.min(50, Math.max(1, timeoutMs - (now() - startedAt))));
        lastRemaining = currentProgress.remaining;
        continue;
      }
      if (
        !concurrentPublication &&
        remaining === 0 &&
        ingest.finalStatus === 'completed' &&
        ingest.stats.errors.length === 0
      ) {
        return {
          status: 'blocked',
          ready: false,
          operation,
          stage: 'verify',
          project: baseProject(),
          runtime: runtime.identity,
          progress: currentProgress,
          verification,
          reason: {
            code: 'PROJECT_NOT_READY',
            message: `Project verification is not ready after a complete ingest${verificationReason(verification) ? ` (${verificationReason(verification)})` : ''}`,
          },
          nextAction: 'Inspect verification issues before retrying preparation.',
        };
      }
      if (ingest.snapshotGate?.status === 'REVIEW_REQUIRED') {
        return {
          status: 'blocked',
          ready: false,
          operation,
          stage: 'ingest',
          project: baseProject(),
          runtime: runtime.identity,
          progress: currentProgress,
          verification,
          reason: {
            code: 'SNAPSHOT_REVIEW_REQUIRED',
            message:
              'The current inventory snapshot requires a qualified review before indexing can continue',
            details: { snapshotUuid: ingest.snapshotGate.snapshotUuid },
          },
          nextAction:
            'Obtain a qualified snapshot review or refresh the complete inventory evidence.',
        };
      }
      if (
        currentProgress.remaining >= lastRemaining &&
        currentProgress.indexed === 0 &&
        currentProgress.embeddings === 0
      ) {
        return {
          status: 'blocked',
          ready: false,
          operation,
          stage: 'ingest',
          project: baseProject(),
          runtime: runtime.identity,
          progress: currentProgress,
          verification,
          reason: {
            code: 'NO_PROGRESS',
            message: 'Project preparation made no progress while resuming the bounded ingest',
          },
          nextAction: 'Inspect the ingest errors and retry after correcting the named blocker.',
        };
      }
      lastRemaining = currentProgress.remaining;
    }

    return {
      status: 'partial',
      ready: false,
      operation,
      stage: 'ingest',
      project: baseProject(),
      runtime: runtime.identity,
      progress: currentProgress,
      ...(verification ? { verification } : {}),
      reason: {
        code: 'PREPARATION_DEADLINE_EXCEEDED',
        message: `Project preparation reached its bounded batch limit (${maxBatches})`,
      },
      nextAction: `Retry preparation with project=${baseProject().slug} to resume pending operations.`,
    };
  } catch (error) {
    const reason = preparationController.signal.aborted
      ? {
          code: 'PREPARATION_DEADLINE_EXCEEDED' as const,
          message: request.signal?.aborted
            ? 'Project preparation was cancelled'
            : 'Project preparation exceeded its bounded deadline',
          details: {},
        }
      : normalizeFailure(error);
    const operation = { id, deduplicated: false } as const;
    const isPartial = reason.code === 'PREPARATION_DEADLINE_EXCEEDED' || isDeadlineError(error);
    return {
      status: isPartial
        ? 'partial'
        : reason.code === 'SNAPSHOT_REVIEW_REQUIRED'
          ? 'blocked'
          : 'failed',
      ready: false,
      operation,
      stage: runtime
        ? 'verify'
        : reason.code.startsWith('RUNTIME') || reason.code === 'RUNTIME_UNAVAILABLE'
          ? 'runtime'
          : 'resolve',
      project: baseProject(),
      ...(runtime ? { runtime: runtime.identity } : {}),
      progress: { ...progress, elapsedMs: Math.max(0, now() - startedAt) },
      reason,
      nextAction: isPartial ? `Retry preparation with project=${baseProject().slug}.` : undefined,
    };
  } finally {
    clearTimeout(preparationTimer);
    request.signal?.removeEventListener('abort', abortFromRequest);
  }
}

export async function prepareProject(
  request: ProjectPrepareRequest,
  dependencies?: ProjectPrepareDependencies
): Promise<ProjectPrepareResult> {
  const env = request.runtime?.env ?? process.env;
  const rootPath = canonicalRoot(request.rootPath);
  assertTrustedRoot(rootPath, env);
  assertNativeEnvironmentBoundary(request, dependencies);
  const id = operationId(rootPath, request);
  const now = dependencies?.now ?? getDefaultDependencies().now ?? Date.now;
  const timeoutMs = boundedPositiveInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, 3_600_000);
  const maxFiles = boundedPositiveInteger(
    request.maxFiles,
    Number.parseInt(env.PROJECT_RAG_PREPARE_MAX_FILES ?? '', 10) || DEFAULT_MAX_FILES,
    2_000
  );
  const maxBatches = boundedPositiveInteger(request.maxBatches, DEFAULT_MAX_BATCHES, 128);
  const existing = activePreparations.get(id);
  if (existing) {
    const result = await waitForActivePreparation(existing, timeoutMs, request.signal);
    if (!result) {
      const waiterStartedAt = Date.now();
      return {
        status: 'running',
        ready: false,
        operation: { id, deduplicated: true },
        stage: 'ingest',
        project: resultProject(rootPath, undefined, request.includeRoots ?? [], request.project),
        progress: emptyProgress(Date.now, waiterStartedAt, maxBatches),
        reason: {
          code: 'PREPARATION_DEADLINE_EXCEEDED',
          message: 'Another preparation operation is still running past this caller deadline',
        },
        nextAction: `Retry preparation with project=${request.project ?? 'the registered root'}; the owner continues independently.`,
      };
    }
    if (
      request.project &&
      result.project.id !== request.project &&
      result.project.slug !== request.project
    ) {
      return {
        ...result,
        status: 'failed' as const,
        ready: false,
        operation: { ...result.operation, deduplicated: true },
        reason: {
          code: 'PROJECT_IDENTITY_MISMATCH' as const,
          message: `Project "${request.project}" does not match the selected root identity`,
        },
        nextAction: 'Retry with the registered project ID or slug for this root.',
      };
    }
    return { ...result, operation: { ...result.operation, deduplicated: true } };
  }

  const startedAt = now();
  const operation = executePreparation(
    request,
    dependencies ?? getDefaultDependencies(),
    rootPath,
    id,
    startedAt,
    timeoutMs,
    maxFiles,
    maxBatches,
    now
  ).finally(() => {
    activePreparations.delete(id);
  });
  activePreparations.set(id, operation);
  return operation;
}
