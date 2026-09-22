import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTrackedIngestLockCountForTest,
  registerTrackedIngestLock,
  releaseAllTrackedIngestLocksForTest,
  releaseTrackedIngestLock,
} from '../ingest-lock-guard.js';

describe('ingest-lock-guard', () => {
  afterEach(async () => {
    await releaseAllTrackedIngestLocksForTest();
  });

  it('tracks and releases a single lock', async () => {
    const mutation = vi.fn().mockResolvedValue(undefined);
    const client = { mutation };
    const runId = 'sync_1' as any;

    await registerTrackedIngestLock(client, runId, 'ingest-project-mcp');
    expect(getTrackedIngestLockCountForTest()).toBe(1);

    await releaseTrackedIngestLock(runId, {
      status: 'completed',
      filesScanned: 10,
      filesAdded: 2,
      filesUpdated: 1,
      chunksCreated: 5,
    });

    expect(getTrackedIngestLockCountForTest()).toBe(0);
    expect(mutation).toHaveBeenCalledWith('ingest/lock:releaseLock', {
      runId,
      status: 'completed',
      filesScanned: 10,
      filesAdded: 2,
      filesUpdated: 1,
      chunksCreated: 5,
    });
  });

  it('releases every tracked lock during forced cleanup', async () => {
    const firstMutation = vi.fn().mockResolvedValue(undefined);
    const secondMutation = vi.fn().mockResolvedValue(undefined);

    await registerTrackedIngestLock({ mutation: firstMutation }, 'sync_1' as any, 'first');
    await registerTrackedIngestLock({ mutation: secondMutation }, 'sync_2' as any, 'second');

    expect(getTrackedIngestLockCountForTest()).toBe(2);

    await releaseAllTrackedIngestLocksForTest('Forced cleanup');

    expect(getTrackedIngestLockCountForTest()).toBe(0);
    expect(firstMutation).toHaveBeenCalledWith('ingest/lock:releaseLock', {
      runId: 'sync_1',
      status: 'failed',
      error: 'Forced cleanup',
    });
    expect(secondMutation).toHaveBeenCalledWith('ingest/lock:releaseLock', {
      runId: 'sync_2',
      status: 'failed',
      error: 'Forced cleanup',
    });
  });
});
