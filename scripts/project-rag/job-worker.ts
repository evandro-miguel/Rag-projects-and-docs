import { resolveProjectRagPostgresWriteConfig } from './config.js';
import { ingestProjectRagPostgres, type ProjectRagPostgresIngestArgs } from './ingest-postgres.js';
import {
  assertProjectRagPostgresJobLifecycleSchemaReady,
  blockProjectRagJobForReview,
  cancelProjectRagJob,
  checkpointProjectRagJob,
  claimProjectRagJob,
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  failProjectRagJob,
  finishProjectRagJob,
  type ProjectRagSql,
  renewProjectRagJobLease,
} from './store.js';

export const PROJECT_INGEST_FULL_JOB = 'project_ingest_full';
export const PROJECT_RAG_JOB_LEASE_SECONDS = 60;
export const PROJECT_RAG_JOB_HEARTBEAT_INTERVAL_MS = (PROJECT_RAG_JOB_LEASE_SECONDS * 1000) / 3;
export const PROJECT_RAG_WORKER_POLL_INTERVAL_MS = 5_000;
export const PROJECT_RAG_WORKER_MAX_CLAIM_BACKOFF_MS = 30_000;
const PROJECT_RAG_JOB_DEFAULT_CLAIM_BACKOFF_MS = 1_000;

export interface ProjectRagJobWorkerOptions {
  readonly sql?: ProjectRagSql;
}

class ProjectRagJobCancellationRequestedError extends Error {
  constructor() {
    super('Project RAG job cancellation requested');
    this.name = 'ProjectRagJobCancellationRequestedError';
  }
}

function isCancellationRequested(error: unknown): boolean {
  return error instanceof ProjectRagJobCancellationRequestedError;
}

/** Process at most one job.  The store's fence token prevents stale workers from publishing. */
export async function runProjectRagJobWorker(
  workerId: string,
  options: ProjectRagJobWorkerOptions = {}
): Promise<boolean> {
  const config = options.sql ? undefined : resolveProjectRagPostgresWriteConfig();
  const sql =
    options.sql ?? createProjectRagPostgresSql(config ?? resolveProjectRagPostgresWriteConfig());
  try {
    const job = await claimProjectRagJob(sql, workerId);
    if (!job) return false;

    let leaseLost = false;
    let renewalInFlight: Promise<void> | undefined;
    const assertOwnership = async (): Promise<void> => {
      if (leaseLost) throw new Error('Project RAG job lease was lost');
      if (renewalInFlight) return renewalInFlight;
      const renewal = (async () => {
        const renewed = await renewProjectRagJobLease(
          sql,
          job.id,
          job.fenceToken,
          PROJECT_RAG_JOB_LEASE_SECONDS
        );
        if (!renewed) {
          leaseLost = true;
          throw new Error('Project RAG job lease was lost');
        }
        if (renewed.cancelRequestedAt) {
          throw new ProjectRagJobCancellationRequestedError();
        }
      })();
      renewalInFlight = renewal;
      try {
        await renewal;
      } finally {
        if (renewalInFlight === renewal) renewalInFlight = undefined;
      }
    };

    const checkpoint = async (phase: string, detail?: Record<string, unknown>): Promise<void> => {
      const checkpointValue = detail === undefined ? { phase } : { phase, detail };
      const saved = await checkpointProjectRagJob(sql, job.id, job.fenceToken, checkpointValue);
      if (!saved) {
        leaseLost = true;
        throw new Error('Project RAG job lease was lost before checkpoint');
      }
      if (saved.cancelRequestedAt) throw new ProjectRagJobCancellationRequestedError();
    };

    const heartbeat = setInterval(() => {
      void assertOwnership().catch((error: unknown) => {
        if (error instanceof ProjectRagJobCancellationRequestedError) return;
        leaseLost = true;
        // Keep diagnostics fixed: provider/database errors may carry secrets.
        console.error('[job-worker] heartbeat renewal failed; lease marked lost');
      });
    }, PROJECT_RAG_JOB_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    try {
      if (job.type !== PROJECT_INGEST_FULL_JOB) {
        throw new Error(`Unsupported Project RAG job type: ${job.type}`);
      }
      await assertOwnership();
      await checkpoint('claimed');
      const result = await ingestProjectRagPostgres({
        ...(job.payload as unknown as ProjectRagPostgresIngestArgs),
        jobLease: { jobId: job.id, fenceToken: job.fenceToken, assertOwnership },
      });
      // Durable ingest finalization already clears the running lease inside
      // its atomic publication transaction; a post-finalization checkpoint
      // would be fenced out and incorrectly turn a successful run into an
      // operation error.
      if (!result.jobFinalized) {
        await checkpoint('ingest-returned', { finalStatus: result.finalStatus });
      }

      if (result.snapshotGate?.status === 'REVIEW_REQUIRED' && !result.jobFinalized) {
        const blocked = await blockProjectRagJobForReview(
          sql,
          job.id,
          job.fenceToken,
          {
            finalStatus: result.finalStatus,
            snapshotGate: result.snapshotGate,
          },
          'Project RAG ingest is blocked pending snapshot review'
        );
        if (!blocked) throw new Error('Project RAG job lease was lost before review blocking');
      } else if (!result.jobFinalized) {
        // Partial or gate-failed results are terminal failures. They must not
        // be reported as succeeded or requeue a partially-mutated ingest.
        const failed = await finishProjectRagJob(
          sql,
          job.id,
          job.fenceToken,
          {
            finalStatus: result.finalStatus,
            snapshotGate: result.snapshotGate ?? null,
          },
          'failed'
        );
        if (!failed) {
          throw new Error('Project RAG job lease was lost before failure completion');
        }
      }
    } catch (error) {
      // Cancellation is deliberate and terminal; worker/provider errors use
      // bounded retry-wait and become dead-letter after max_attempts.
      if (isCancellationRequested(error)) {
        await cancelProjectRagJob(sql, job.id, {
          fenceToken: job.fenceToken,
          reason: 'cancelled at worker heartbeat boundary',
        }).catch(() => undefined);
      } else {
        await Promise.resolve(
          failProjectRagJob(
            sql,
            job.id,
            job.fenceToken,
            error instanceof Error ? error.message : String(error),
            { retryable: job.type === PROJECT_INGEST_FULL_JOB }
          )
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  } finally {
    // A worker supplied by the long-lived loop shares its pool. A one-shot
    // invocation closes through the cache owner so restart cannot reuse a
    // closed Bun.SQL instance.
    if (!options.sql) {
      await closeProjectRagPostgresSql(config?.database?.url);
    }
  }
}

export interface ProjectRagJobWorkerCliOptions {
  readonly help: boolean;
  readonly once: boolean;
}

export function parseProjectRagJobWorkerArgs(
  argv: readonly string[]
): ProjectRagJobWorkerCliOptions {
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    once: argv.includes('--once'),
  };
}

export function getProjectRagJobWorkerUsage(): string {
  return `Usage: bun run project-rag:worker [--once]

Operator worker for durable Project RAG ingest jobs.

Options:
  --once      Claim and process at most one queued job, then exit
  --help, -h  Show this help

Without --once the worker loops: it claims jobs back-to-back while work is
available and sleeps ${PROJECT_RAG_WORKER_POLL_INTERVAL_MS}ms whenever the queue is idle. The worker id comes
from PROJECT_RAG_WORKER_ID or defaults to worker-<pid>. Start it deliberately as
an operator; rag-daemon never starts it.
`;
}

export function resolveProjectRagJobWorkerId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PROJECT_RAG_WORKER_ID?.trim();
  return fromEnv ? fromEnv : `worker-${process.pid}`;
}

/** Injectable sleep/abort/pool hooks keep restart and shutdown tests deterministic. */
export interface ProjectRagJobWorkerLoopHooks {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly sql?: ProjectRagSql;
  readonly closePool?: () => Promise<void>;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runProjectRagJobWorkerLoop(
  options: ProjectRagJobWorkerCliOptions,
  workerId: string,
  hooks: ProjectRagJobWorkerLoopHooks = {}
): Promise<void> {
  const ownsPool = !hooks.sql;
  const config = ownsPool ? resolveProjectRagPostgresWriteConfig() : undefined;
  const sql =
    hooks.sql ?? createProjectRagPostgresSql(config ?? resolveProjectRagPostgresWriteConfig());
  const closePool = hooks.closePool ?? (() => closeProjectRagPostgresSql(config?.database?.url));
  let claimBackoffMs = PROJECT_RAG_JOB_DEFAULT_CLAIM_BACKOFF_MS;
  console.log(
    `[job-worker] ${workerId} started (${options.once ? 'once' : `polling every ${PROJECT_RAG_WORKER_POLL_INTERVAL_MS}ms`})`
  );
  try {
    await assertProjectRagPostgresJobLifecycleSchemaReady(sql);
    while (!hooks.signal?.aborted) {
      let claimed: boolean;
      let claimFailed = false;
      try {
        claimed = await runProjectRagJobWorker(workerId, { sql });
      } catch (error) {
        // A durable worker survives transient claim failures; --once fails loudly.
        if (options.once) throw error;
        console.error('[job-worker] claim failed; retrying');
        claimed = false;
        claimFailed = true;
      }
      if (options.once) return;
      if (!claimed) {
        const sleep = hooks.sleep ?? ((ms: number) => sleepWithAbort(ms, hooks.signal));
        await sleep(claimFailed ? claimBackoffMs : PROJECT_RAG_WORKER_POLL_INTERVAL_MS);
        if (claimFailed && claimBackoffMs < PROJECT_RAG_WORKER_MAX_CLAIM_BACKOFF_MS) {
          claimBackoffMs = Math.min(claimBackoffMs * 2, PROJECT_RAG_WORKER_MAX_CLAIM_BACKOFF_MS);
        } else if (!claimFailed) {
          claimBackoffMs = PROJECT_RAG_JOB_DEFAULT_CLAIM_BACKOFF_MS;
        }
      } else {
        claimBackoffMs = PROJECT_RAG_JOB_DEFAULT_CLAIM_BACKOFF_MS;
      }
    }
  } finally {
    if (ownsPool) await closePool();
  }
}

export async function runProjectRagJobWorkerCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  hooks: ProjectRagJobWorkerLoopHooks = {}
): Promise<void> {
  const options = parseProjectRagJobWorkerArgs(argv);
  if (options.help) {
    console.log(getProjectRagJobWorkerUsage());
    return;
  }
  await runProjectRagJobWorkerLoop(options, resolveProjectRagJobWorkerId(env), hooks);
}

if (import.meta.main) {
  runProjectRagJobWorkerCli().catch(() => {
    // Do not print raw database/provider errors from the worker boundary.
    console.error('[job-worker] worker terminated after an operation failure');
    process.exitCode = 1;
  });
}
