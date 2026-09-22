/**
 * @module lib/shared/abort-utils
 * @description Shared abort-signal composition utilities used by MCP tool
 * handlers and embedding helper functions.
 *
 * ## Design
 *
 * `composeAbortSignals` returns a compound signal that aborts when **either**
 * source aborts. Every internal event listener is cleaned up once either
 * signal fires or the compound signal itself is aborted.
 *
 * This is used to compose a read-deadline signal with a provider-internal
 * timeout signal so that the earlier trigger always wins without leaking
 * listeners.
 */

/**
 * Compose two AbortSignals into one: the returned signal aborts when
 * **either** `a` or `b` abort, propagating the abort reason of the one
 * that fired first.
 *
 * When `b` is `undefined` the function returns `a` directly (no wrapper).
 *
 * ## Precondition (bounded usage)
 *
 * At least one of the two source signals **must** eventually fire/abort
 * (e.g. from a timeout, a finally-block cleanup, or a read deadline).
 * If neither signal ever fires, internal event listeners leak.  All
 * current production callers satisfy this: one signal is either a
 * timeout (`AbortSignal.timeout()`) or a read-deadline signal that is
 * aborted in a `finally` block, and the other is an upstream caller
 * signal scoped to the same bounded operation.
 *
 * This precondition is intentionally documented rather than adding a
 * general-purpose cleanup mechanism that would complicate every caller
 * or require WeakRef-based GC hooks.
 */
export function composeAbortSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (a.aborted) return a;
  if (b.aborted) return b;

  const composite = new AbortController();

  const onA = (): void => composite.abort(a.reason);
  const onB = (): void => composite.abort(b.reason);
  const onComposite = (): void => {
    a.removeEventListener('abort', onA);
    b.removeEventListener('abort', onB);
  };

  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  composite.signal.addEventListener('abort', onComposite, { once: true });

  return composite.signal;
}
