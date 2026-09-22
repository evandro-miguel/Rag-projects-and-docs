/**
 * @module mcp/lib/timeout
 * @description Read-deadline and abort-signal composition for MCP read tools.
 *
 * ## Design
 *
 * - Timeout applies to **all** read-only MCP tools.  Write/mutation tools
 *   are not wrapped.
 * - Uses an internal AbortController backed by setTimeout; the controller
 *   is aborted when the wall-clock deadline fires, signalling cooperative
 *   fetch work (embedding HTTP calls) to cancel.
 * - `withReadDeadline` races the operation against the deadline timer that
 *   rejects immediately with `ReadDeadlineError`.  The underlying operation
 *   promise is caught so a late rejection is observed and not unhandled.
 * - The `ReadDeadlineError` carries a machine-readable code and a message
 *   making it clear that **cooperative** cancellation was requested but
 *   non-cooperative DB work may still be in flight.
 * - Does **not** close SQL pools, set `statement_timeout`, or depend on
 *   Bun.SQL cancellation.
 */

// ---------------------------------------------------------------------------
// ReadDeadlineError
// ---------------------------------------------------------------------------

/**
 * Machine-readable error thrown when a read-tool deadline expires.
 *
 * Cooperative cancellation (via AbortSignal) was requested, but any
 * non-cooperative DB query started before the deadline may continue to
 * execute server-side until completion or its own driver-level timeout.
 */
export class ReadDeadlineError extends Error {
  readonly code = 'READ_DEADLINE_EXCEEDED' as const;
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(
      `READ_DEADLINE_EXCEEDED: Cooperative cancellation was requested for tool "${toolName}" after ${timeoutMs}ms, but non-cooperative DB work may continue.`
    );
    this.name = 'ReadDeadlineError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// createReadDeadline
// ---------------------------------------------------------------------------

/**
 * Create an AbortController whose signal fires after `timeoutMs`
 * or when the optional `callerSignal` aborts.
 *
 * The caller **must** call `controller.abort()` in a `finally` block
 * after the guarded operation finishes to prevent timer leaks.
 */
export function createReadDeadline(timeoutMs: number, callerSignal?: AbortSignal): AbortController {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      const onCallerAbort = (): void => controller.abort();
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      controller.signal.addEventListener(
        'abort',
        () => callerSignal.removeEventListener('abort', onCallerAbort),
        { once: true }
      );
    }
  }

  return controller;
}

// ---------------------------------------------------------------------------
// withReadDeadline
// ---------------------------------------------------------------------------

/**
 * Run `operation` guarded by a read deadline.
 *
 * The deadline aborts `signal` (so cooperative fetch work like embedding
 * HTTP calls can short-circuit) **and** races the operation promise against
 * an immediate `ReadDeadlineError` rejection.  The underlying operation
 * promise is caught so a late rejection is observed and not unhandled.
 *
 * @param operation  Callback that receives the deadline signal.
 * @param timeoutMs  Wall-clock timeout in milliseconds.
 * @param toolName   Human-readable tool name for error messages.
 * @param callerSignal  Optional upstream signal to compose.
 */
export async function withReadDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  toolName: string,
  callerSignal?: AbortSignal
): Promise<T> {
  const deadline = createReadDeadline(timeoutMs, callerSignal);

  // Wrap in Promise.resolve().then() so a synchronous throw from
  // operation() becomes a proper rejection — this guarantees that
  // the .catch() below is always reached and the deadline timer +
  // listeners always cleaned up by the finally block.
  const resultPromise = Promise.resolve().then(() => operation(deadline.signal));

  // Observe late rejections — prevent unhandled rejection when the
  // deadline fires before a non-cooperative DB operation finishes.
  // Late root causes (e.g. a DB query that rejects after the deadline)
  // are intentionally observed here but never surfaced after a response
  // has already been sent; no raw late error is logged or exposed.
  resultPromise.catch(() => {
    /* observed — late root cause is intentionally swallowed */
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    if (deadline.signal.aborted) {
      reject(new ReadDeadlineError(toolName, timeoutMs));
      return;
    }
    deadline.signal.addEventListener(
      'abort',
      () => {
        reject(new ReadDeadlineError(toolName, timeoutMs));
      },
      { once: true }
    );
  });

  try {
    return await Promise.race([resultPromise, timeoutPromise]);
  } finally {
    deadline.abort();
  }
}

// ---------------------------------------------------------------------------
// withTimeout — legacy backward-compat wrapper
// ---------------------------------------------------------------------------

/**
 * Legacy `withTimeout` using the original `Promise.race` approach.
 *
 * Preserved for backward compatibility with `scripts/eval/mcp-tool-matrix.*`.
 * New code should use `withReadDeadline` instead.
 *
 * @deprecated Use `withReadDeadline(cb, timeoutMs, operation)` for signal
 *   integration and machine-readable error codes.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy helpers (preserved for backward compat)
// ---------------------------------------------------------------------------

/**
 * Read a positive integer from an environment variable with a fallback.
 *
 * Returns `fallback` when the variable is unset, empty, zero, or not a
 * valid positive integer.
 */
export function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read a runtime safety budget without silently accepting malformed values.
 * Optional evaluation-harness settings should continue using the legacy
 * fallback helper above.
 */
export function readRequiredPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`INVALID_CONFIG: ${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`INVALID_CONFIG: ${name} must be a safe positive integer`);
  }
  return parsed;
}
