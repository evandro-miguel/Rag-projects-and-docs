export type AsyncLock = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Serialize asynchronous state mutations while allowing callers to continue
 * independently after their operation leaves the critical section.
 */
export function createAsyncLock(): AsyncLock {
  let tail = Promise.resolve();

  return async function withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}
