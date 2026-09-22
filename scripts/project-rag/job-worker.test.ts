import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockBlock,
  mockCancel,
  mockCheckpoint,
  mockClaim,
  mockClose,
  mockClosePool,
  mockAssertJobSchema,
  mockFail,
  mockFinish,
  mockRenew,
  mockIngest,
} = vi.hoisted(() => ({
  mockBlock: vi.fn(),
  mockCancel: vi.fn(),
  mockCheckpoint: vi.fn(),
  mockClaim: vi.fn(),
  mockClose: vi.fn(),
  mockClosePool: vi.fn(async () => undefined),
  mockAssertJobSchema: vi.fn(),
  mockFail: vi.fn(),
  mockFinish: vi.fn(),
  mockRenew: vi.fn(),
  mockIngest: vi.fn(),
}));

vi.mock('./config.js', () => ({
  resolveProjectRagPostgresWriteConfig: vi.fn(() => ({})),
}));
vi.mock('./ingest-postgres.js', () => ({ ingestProjectRagPostgres: mockIngest }));
vi.mock('./store.js', () => ({
  blockProjectRagJobForReview: mockBlock,
  cancelProjectRagJob: mockCancel,
  checkpointProjectRagJob: mockCheckpoint,
  claimProjectRagJob: mockClaim,
  closeProjectRagPostgresSql: mockClosePool,
  createProjectRagPostgresSql: vi.fn(() => ({ close: mockClose })),
  assertProjectRagPostgresJobLifecycleSchemaReady: mockAssertJobSchema,
  failProjectRagJob: mockFail,
  finishProjectRagJob: mockFinish,
  renewProjectRagJobLease: mockRenew,
}));

import {
  getProjectRagJobWorkerUsage,
  PROJECT_RAG_WORKER_POLL_INTERVAL_MS,
  parseProjectRagJobWorkerArgs,
  resolveProjectRagJobWorkerId,
  runProjectRagJobWorker,
  runProjectRagJobWorkerCli,
} from './job-worker.js';

const job = {
  id: 17,
  type: 'project_ingest_full',
  projectId: 3,
  dedupeKey: 'fixture',
  status: 'running' as const,
  payload: { rootPath: '/fixture', includeRoots: ['src'] },
  result: null,
  attempts: 1,
  maxAttempts: 3,
  workerId: 'worker-a',
  fenceToken: 4,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  checkpoint: {},
  snapshotUuid: null,
  error: null,
};

describe('Project RAG job worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckpoint.mockResolvedValue(job);
    mockBlock.mockResolvedValue(job);
    mockCancel.mockResolvedValue(job);
    mockAssertJobSchema.mockResolvedValue(undefined);
  });

  it('fails polling immediately with the migration-012 domain error', async () => {
    const schemaError = new Error(
      'Project RAG durable job lifecycle schema (migration 012) is missing'
    );
    mockAssertJobSchema.mockRejectedValue(schemaError);
    const controller = new AbortController();
    const sleep = vi.fn(async () => controller.abort());

    await expect(
      runProjectRagJobWorkerCli(
        [],
        { PROJECT_RAG_WORKER_ID: 'schema-missing' },
        { signal: controller.signal, sleep }
      )
    ).rejects.toBe(schemaError);

    expect(mockClaim).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('performs no second finish when the ingest finalizer already finalized the job', async () => {
    mockClaim.mockResolvedValue(job);
    mockRenew.mockResolvedValue(job);
    // A completed ingest finalizes its own job inside the atomic
    // completeProjectRagPostgresIngest finalizer and reports jobFinalized.
    mockIngest.mockResolvedValue({
      finalStatus: 'completed',
      snapshotGate: { status: 'CONSUMED' },
      jobFinalized: true,
    });
    mockFinish.mockResolvedValue(job);

    await expect(runProjectRagJobWorker('worker-a')).resolves.toBe(true);

    // The ingest finalizer owns successful terminal transitions; the worker
    // must never perform a second success update.
    expect(mockFinish).not.toHaveBeenCalled();
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockCheckpoint.mock.calls[0]?.[3]).toStrictEqual({ phase: 'claimed' });
    expect(mockClosePool).toHaveBeenCalledTimes(1);
  });

  it('marks only non-finalized results as failed without requeueing', async () => {
    mockClaim.mockResolvedValue(job);
    mockRenew.mockResolvedValue(job);
    // Defensive fallback: an ingest result that did not finalize the job
    // (no durable lease reached the finalizer) must terminate as failed,
    // never as a silent success or a requeue.
    mockIngest.mockResolvedValue({
      finalStatus: 'completed',
      snapshotGate: { status: 'CONSUMED' },
    });
    mockFinish.mockResolvedValue({ ...job, status: 'failed' });

    await expect(runProjectRagJobWorker('worker-a')).resolves.toBe(true);

    expect(mockFinish).toHaveBeenCalledWith(
      expect.anything(),
      job.id,
      job.fenceToken,
      { finalStatus: 'completed', snapshotGate: { status: 'CONSUMED' } },
      'failed'
    );
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockClosePool).toHaveBeenCalledTimes(1);
  });

  it('finishes a partial ingest as terminal failed instead of requeueing', async () => {
    mockClaim.mockResolvedValue(job);
    mockRenew.mockResolvedValue(job);
    mockIngest.mockResolvedValue({ finalStatus: 'partial' });
    mockFinish.mockResolvedValue({ ...job, status: 'failed' });

    await expect(runProjectRagJobWorker('worker-a')).resolves.toBe(true);

    expect(mockFinish).toHaveBeenCalledWith(
      expect.anything(),
      job.id,
      job.fenceToken,
      { finalStatus: 'partial', snapshotGate: null },
      'failed'
    );
    expect(mockFail).not.toHaveBeenCalled();
  });

  it('finishes a gate-refused ingest as terminal failed instead of requeueing', async () => {
    mockClaim.mockResolvedValue(job);
    mockRenew.mockResolvedValue(job);
    mockIngest.mockResolvedValue({
      finalStatus: 'completed',
      snapshotGate: { status: 'FAILED' },
    });
    mockFinish.mockResolvedValue({ ...job, status: 'failed' });

    await expect(runProjectRagJobWorker('worker-a')).resolves.toBe(true);

    expect(mockFinish).toHaveBeenCalledWith(
      expect.anything(),
      job.id,
      job.fenceToken,
      { finalStatus: 'completed', snapshotGate: { status: 'FAILED' } },
      'failed'
    );
    expect(mockFail).not.toHaveBeenCalled();
  });

  it('rejects unsupported job types before ingest and terminates through the fenced failure path', async () => {
    // Job type fixture: a queue row with a type the v0.1 worker does not
    // implement must never reach ingest and must fail terminally under its
    // own fence instead of being requeued or silently ignored.
    const unsupported = { ...job, type: 'project_ingest_delta' };
    mockClaim.mockResolvedValue(unsupported);

    await expect(runProjectRagJobWorker('worker-a')).rejects.toThrow(
      'Unsupported Project RAG job type: project_ingest_delta'
    );

    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockRenew).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith(
      expect.anything(),
      unsupported.id,
      unsupported.fenceToken,
      'Unsupported Project RAG job type: project_ingest_delta',
      { retryable: false }
    );
    expect(mockClosePool).toHaveBeenCalledTimes(1);
  });

  it('stops a stale worker at the propagated fence before it can finish', async () => {
    mockClaim.mockResolvedValue(job);
    mockRenew.mockResolvedValueOnce(job).mockResolvedValueOnce(undefined);
    mockIngest.mockImplementation(
      async (args: { jobLease: { assertOwnership: () => Promise<void> } }) => {
        await args.jobLease.assertOwnership();
        return { finalStatus: 'completed', snapshotGate: { status: 'CONSUMED' } };
      }
    );

    await expect(runProjectRagJobWorker('worker-a')).rejects.toThrow('lease was lost');

    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        jobLease: expect.objectContaining({ jobId: job.id, fenceToken: job.fenceToken }),
      })
    );
    expect(mockFinish).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith(
      expect.anything(),
      job.id,
      job.fenceToken,
      'Project RAG job lease was lost',
      { retryable: true }
    );
    expect(mockClosePool).toHaveBeenCalledTimes(1);
  });

  it('parses --once and default loop flags', () => {
    expect(parseProjectRagJobWorkerArgs(['--once'])).toEqual({ help: false, once: true });
    expect(parseProjectRagJobWorkerArgs([])).toEqual({ help: false, once: false });
    expect(parseProjectRagJobWorkerArgs(['--help'])).toEqual({ help: true, once: false });
    expect(getProjectRagJobWorkerUsage()).toContain('--once');
  });

  it('resolves the worker id from PROJECT_RAG_WORKER_ID or worker-<pid>', () => {
    expect(resolveProjectRagJobWorkerId({ PROJECT_RAG_WORKER_ID: 'ops-worker-1' })).toBe(
      'ops-worker-1'
    );
    expect(resolveProjectRagJobWorkerId({ PROJECT_RAG_WORKER_ID: '  ' })).toBe(
      `worker-${process.pid}`
    );
    expect(resolveProjectRagJobWorkerId({})).toBe(`worker-${process.pid}`);
  });

  it('runs exactly one claim with --once on an idle queue without sleeping', async () => {
    mockClaim.mockResolvedValue(undefined);
    const sleep = vi.fn(async () => {
      throw new Error('--once must never sleep');
    });

    await runProjectRagJobWorkerCli(['--once'], { PROJECT_RAG_WORKER_ID: 'idle-once' }, { sleep });

    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockClaim).toHaveBeenCalledWith(expect.anything(), 'idle-once');
    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockClosePool).toHaveBeenCalledTimes(1);
  });

  it('loops until idle, sleeps the poll interval, and stops when aborted', async () => {
    mockClaim.mockResolvedValue(undefined);
    const controller = new AbortController();
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length >= 2) controller.abort();
    });

    await runProjectRagJobWorkerCli(
      [],
      { PROJECT_RAG_WORKER_ID: 'loop-test' },
      {
        signal: controller.signal,
        sleep,
      }
    );

    expect(sleeps).toEqual([
      PROJECT_RAG_WORKER_POLL_INTERVAL_MS,
      PROJECT_RAG_WORKER_POLL_INTERVAL_MS,
    ]);
    expect(mockClaim).toHaveBeenCalledTimes(2);
  });
});
