import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReadDeadline,
  ReadDeadlineError,
  readPositiveIntegerEnv,
  withReadDeadline,
  withTimeout,
} from './timeout.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// ReadDeadlineError
// ============================================================================

describe('ReadDeadlineError', () => {
  it('carries machine-readable code, toolName, timeoutMs', () => {
    const err = new ReadDeadlineError('search_docs', 5000);
    expect(err.code).toBe('READ_DEADLINE_EXCEEDED');
    expect(err.toolName).toBe('search_docs');
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toContain('Cooperative cancellation was requested');
    expect(err.message).toContain('search_docs');
    expect(err.message).toContain('5000ms');
    expect(err.message).toContain('non-cooperative DB work may continue');
  });
});

// ============================================================================
// createReadDeadline
// ============================================================================

describe('createReadDeadline', () => {
  it('fires signal after timeout', async () => {
    const deadline = createReadDeadline(1);
    const signal = new Promise((_resolve, reject) => {
      deadline.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    await expect(signal).rejects.toThrow('aborted');
    deadline.abort();
  });

  it('does not fire when aborted manually before timeout', () => {
    const deadline = createReadDeadline(50_000);
    const abortSpy = vi.fn();
    deadline.signal.addEventListener('abort', abortSpy);
    deadline.abort();
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately when callerSignal is already aborted', () => {
    const caller = new AbortController();
    caller.abort();
    const deadline = createReadDeadline(50_000, caller.signal);
    expect(deadline.signal.aborted).toBe(true);
    deadline.abort();
  });

  it('composes with caller signal and cleans up listeners', () => {
    const caller = new AbortController();
    const deadline = createReadDeadline(50_000, caller.signal);
    const abortSpy = vi.fn();
    deadline.signal.addEventListener('abort', abortSpy);
    caller.abort();
    expect(abortSpy).toHaveBeenCalledTimes(1);
    deadline.abort();
  });
});

// ============================================================================
// withReadDeadline
// ============================================================================

describe('withReadDeadline', () => {
  it('resolves when operation finishes before deadline', async () => {
    const result = await withReadDeadline(
      async (signal) => {
        expect(signal.aborted).toBe(false);
        return 'done';
      },
      5_000,
      'test'
    );
    expect(result).toBe('done');
  });

  it('rejects with ReadDeadlineError when timer fires on unresolved work', async () => {
    await expect(
      withReadDeadline(() => new Promise<never>(() => {}), 1, 'search_docs')
    ).rejects.toThrow(ReadDeadlineError);
  });

  it('rejects with correct tool name', async () => {
    let caught: unknown;
    try {
      await withReadDeadline(() => new Promise<never>(() => {}), 1, 'search_project_code');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReadDeadlineError);
    expect((caught as ReadDeadlineError).toolName).toBe('search_project_code');
  });

  it('preserves non-deadline errors (db failures, etc.)', async () => {
    await expect(
      withReadDeadline(() => Promise.reject(new Error('db connection failed')), 5_000, 'test')
    ).rejects.toThrow('db connection failed');
  });

  it('composes with caller signal — caller abort triggers deadline', async () => {
    const caller = new AbortController();
    const promise = withReadDeadline(
      () => new Promise<never>(() => {}),
      50_000,
      'test',
      caller.signal
    );
    setTimeout(() => caller.abort(), 1);
    await expect(promise).rejects.toThrow(ReadDeadlineError);
  });

  it('observes late promise rejection without unhandled rejection', async () => {
    // The deadline fires while the operation is still in-flight.
    // The operation resolves *after* the deadline — the late rejection
    // must be caught and not become an unhandledRejection.
    const unhandledSpy = vi.fn();
    process.on('unhandledRejection', unhandledSpy);

    await withReadDeadline(() => new Promise<never>(() => {}), 1, 'test').catch(() => {});

    // Give microtasks a chance to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandledSpy).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandledSpy);
  });

  it('handles late operation rejection after deadline — no unhandledRejection', async () => {
    // The operation rejects *after* the deadline has already fired.
    // The underlying promise rejection must be caught by the internal
    // .catch() handler and never surface as unhandledRejection.
    const unhandledSpy = vi.fn();
    process.on('unhandledRejection', unhandledSpy);

    await withReadDeadline(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          if (signal.aborted) {
            // Deadline already fired before we could attach listener
            reject(new Error('late db failure'));
          } else {
            signal.addEventListener(
              'abort',
              () => {
                // Reject after the deadline on a fresh microtask
                setTimeout(() => reject(new Error('late db failure')), 1);
              },
              { once: true }
            );
          }
        }),
      1,
      'test'
    ).catch(() => {
      /* expected ReadDeadlineError */
    });

    // Give enough time for the late rejection to surface
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandledSpy).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandledSpy);
  });

  it('handles synchronous throw from operation — deadline cleaned up', async () => {
    // A synchronous throw from operation() must become a proper rejection
    // so the deadline timer/listeners are cleaned up by the finally block.
    await expect(
      withReadDeadline(
        () => {
          throw new Error('sync kaboom');
        },
        5_000,
        'test'
      )
    ).rejects.toThrow('sync kaboom');
  });
});

// ============================================================================
// withTimeout (legacy backward compat)
// ============================================================================

describe('withTimeout (legacy)', () => {
  it('resolves quickly for fast operations', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 5_000, 'fast operation');
    expect(result).toBe('ok');
  });

  it('rejects with descriptive message when operation times out', async () => {
    await expect(withTimeout(new Promise<string>(() => {}), 1, 'slow operation')).rejects.toThrow(
      'slow operation timed out after 1ms'
    );
  });
});

// ============================================================================
// readPositiveIntegerEnv (backward compat)
// ============================================================================

describe('readPositiveIntegerEnv', () => {
  it('uses fallback for invalid or missing values', () => {
    process.env.TEST_TIMEOUT_VALUE = '0';
    expect(readPositiveIntegerEnv('TEST_TIMEOUT_VALUE', 123)).toBe(123);
    process.env.TEST_TIMEOUT_VALUE = '42';
    expect(readPositiveIntegerEnv('TEST_TIMEOUT_VALUE', 123)).toBe(42);
    delete process.env.TEST_TIMEOUT_VALUE;
    expect(readPositiveIntegerEnv('TEST_TIMEOUT_VALUE', 99)).toBe(99);
  });

  it('rejects non-numeric and negative values', () => {
    process.env.TEST_TIMEOUT_VALUE = '-5';
    expect(readPositiveIntegerEnv('TEST_TIMEOUT_VALUE', 50)).toBe(50);
    process.env.TEST_TIMEOUT_VALUE = 'abc';
    expect(readPositiveIntegerEnv('TEST_TIMEOUT_VALUE', 50)).toBe(50);
    delete process.env.TEST_TIMEOUT_VALUE;
  });
});
