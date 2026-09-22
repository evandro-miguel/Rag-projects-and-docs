interface IngestLockClientLike {
  mutation: (...args: any[]) => Promise<any>;
}

type SyncRunId = string;

type TrackedLock = {
  client: IngestLockClientLike;
  runId: SyncRunId;
};

type ReleaseLockArgs = {
  status: string;
  filesScanned?: number;
  filesAdded?: number;
  filesUpdated?: number;
  chunksCreated?: number;
  error?: string;
};

const trackedLocks = new Map<string, TrackedLock>();
let signalHandlersInstalled = false;
let signalCleanupInFlight: Promise<void> | null = null;
const RELEASE_LOCK_MUTATION = 'ingest/lock:releaseLock';

function buildSignalExitCode(signal: 'SIGINT' | 'SIGTERM'): number {
  return signal === 'SIGINT' ? 130 : 143;
}

async function releaseTrackedLock(lock: TrackedLock, args: ReleaseLockArgs): Promise<void> {
  await lock.client.mutation(RELEASE_LOCK_MUTATION, {
    runId: lock.runId,
    ...args,
  });
}

async function handleSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (signalCleanupInFlight) {
    await signalCleanupInFlight;
    return;
  }

  signalCleanupInFlight = (async () => {
    const activeLocks = [...trackedLocks.values()];
    trackedLocks.clear();

    if (activeLocks.length === 0) {
      return;
    }

    process.stderr.write(
      `[ingest-lock-guard] Releasing ${activeLocks.length} active ingest lock(s) after ${signal}.\n`
    );

    await Promise.allSettled(
      activeLocks.map((lock) =>
        releaseTrackedLock(lock, {
          status: 'failed',
          error: `Ingestion interrupted by ${signal}.`,
        })
      )
    );
  })();

  try {
    await signalCleanupInFlight;
  } finally {
    process.exit(buildSignalExitCode(signal));
  }
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) {
    return;
  }

  signalHandlersInstalled = true;
  process.once('SIGINT', () => {
    void handleSignal('SIGINT');
  });
  process.once('SIGTERM', () => {
    void handleSignal('SIGTERM');
  });
}

export async function registerTrackedIngestLock(
  client: IngestLockClientLike,
  runId: SyncRunId,
  operation: string
): Promise<void> {
  void operation;
  installSignalHandlers();
  trackedLocks.set(runId.toString(), {
    client,
    runId,
  });
}

export async function releaseTrackedIngestLock(
  runId: SyncRunId,
  args: ReleaseLockArgs
): Promise<void> {
  const key = runId.toString();
  const trackedLock = trackedLocks.get(key);
  if (!trackedLock) {
    return;
  }

  trackedLocks.delete(key);
  await releaseTrackedLock(trackedLock, args);
}

export async function releaseAllTrackedIngestLocksForTest(
  error: string = 'Ingestion interrupted by test cleanup.'
): Promise<void> {
  const activeLocks = [...trackedLocks.values()];
  trackedLocks.clear();
  await Promise.allSettled(
    activeLocks.map((lock) =>
      releaseTrackedLock(lock, {
        status: 'failed',
        error,
      })
    )
  );
  signalCleanupInFlight = null;
}

export function getTrackedIngestLockCountForTest(): number {
  return trackedLocks.size;
}
