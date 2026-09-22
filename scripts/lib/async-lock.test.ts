import { describe, expect, it } from 'vitest';

import { createAsyncLock } from './async-lock.js';

describe('createAsyncLock', () => {
  it('serializes overlapping operations in arrival order', async () => {
    const withLock = createAsyncLock();
    const events: string[] = [];
    let releaseFirst = () => {};
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withLock(async () => {
      events.push('first:start');
      await firstCanFinish;
      events.push('first:end');
      return 'first';
    });
    const second = withLock(async () => {
      events.push('second:start');
      events.push('second:end');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('releases the next operation when the current operation fails', async () => {
    const withLock = createAsyncLock();
    const failed = withLock(async () => {
      throw new Error('load failed');
    });
    const recovered = withLock(async () => 'recovered');

    await expect(failed).rejects.toThrow('load failed');
    await expect(recovered).resolves.toBe('recovered');
  });
});
