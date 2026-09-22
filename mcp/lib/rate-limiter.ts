/**
 * @module mcp/lib/rate-limiter
 * @description Rate limiting utility for MCP tool handlers.
 *
 * Provides request throttling to prevent abuse of heavy operations like
 * project ingestion. Uses a sliding window approach with in-memory storage.
 *
 * ## Limitations
 *
 * - **In-Memory Storage**: Rate limits are stored in memory and are not
 *   persisted across server restarts. Each server instance maintains
 *   its own rate limit counters.
 *
 * - **Single Instance**: This implementation is designed for single-instance
 *   deployments. For multi-instance deployments, a shared rate limit store
 *   (e.g., Redis) would be required.
 *
 * - **Process-Global Scope**: Currently uses 'process-global' as the identifier. Future
 *   enhancements should support per-user or per-IP rate limiting when
 *   user identification is available.
 *
 * - **No Distributed Coordination**: Rate limits are not synchronized
 *   across multiple MCP server instances.
 *
 * ## Rate Limits
 *
 * | Operation | Max Requests | Window |
 * |-----------|--------------|--------|
 * | ingest_project | 5 | 10 minutes |
 * | ingest_project_file | 10 | 5 minutes |
 * | search | 100 | 1 minute |
 *
 * @example
 * const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60000 });
 * if (limiter.checkLimit('ingest_project', 'user123')) {
 *   // Allow request
 * } else {
 *   // Rate limit exceeded
 * }
 */

export interface RateLimiterConfig {
  /** Maximum number of requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Optional custom error message */
  errorMessage?: string;
}

export interface RateLimitEntry {
  /** Array of timestamps for requests in the current window */
  timestamps: number[];
  /** Number of requests in current window */
  count: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of remaining requests in the window */
  remaining: number;
  /** Timestamp when the rate limit resets */
  resetAt: number;
  /** Error message if not allowed */
  errorMessage?: string;
}

/**
 * Rate limiter implementation using sliding window algorithm.
 *
 * Tracks requests per action and identifier (e.g., tool name + user ID).
 * Automatically cleans up expired entries to prevent memory leaks.
 */
export class RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = {
      errorMessage: 'Rate limit exceeded. Please try again later.',
      ...config,
    };
  }

  /**
   * Check if a request is allowed under the rate limit.
   *
   * @param action - The action being rate limited (e.g., tool name)
   * @param identifier - Unique identifier for the requester (e.g., user ID, IP)
   * @returns RateLimitResult with allowed status and metadata
   */
  checkLimit(action: string, identifier: string): RateLimitResult {
    const key = `${action}:${identifier}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let entry = this.store.get(key);

    if (!entry) {
      entry = { timestamps: [], count: 0 };
      this.store.set(key, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
    entry.count = entry.timestamps.length;

    // Check if request is allowed
    const allowed = entry.count < this.config.maxRequests;

    if (allowed) {
      entry.timestamps.push(now);
      entry.count++;
    }

    // Calculate reset time (oldest timestamp in window + window duration)
    const resetAt =
      entry.timestamps.length > 0
        ? entry.timestamps[0] + this.config.windowMs
        : now + this.config.windowMs;

    return {
      allowed,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetAt,
      errorMessage: allowed ? undefined : this.config.errorMessage,
    };
  }

  /**
   * Reset the rate limit for a specific action and identifier.
   *
   * @param action - The action to reset
   * @param identifier - The identifier to reset for
   */
  reset(action: string, identifier: string): void {
    const key = `${action}:${identifier}`;
    this.store.delete(key);
  }

  /**
   * Clear all rate limit entries. Useful for testing.
   */
  clearAll(): void {
    this.store.clear();
  }

  /**
   * Clean up expired entries to prevent memory leaks.
   * Should be called periodically (e.g., via setInterval).
   */
  cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    for (const [key, entry] of this.store.entries()) {
      entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
      entry.count = entry.timestamps.length;

      if (entry.count === 0) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Get current rate limit status without consuming a request.
   *
   * @param action - The action to check
   * @param identifier - The identifier to check for
   * @returns RateLimitResult with current status
   */
  getStatus(action: string, identifier: string): RateLimitResult {
    const key = `${action}:${identifier}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    const entry = this.store.get(key);

    if (!entry) {
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetAt: now + this.config.windowMs,
      };
    }

    const validTimestamps = entry.timestamps.filter((ts) => ts > windowStart);
    const count = validTimestamps.length;
    const resetAt =
      validTimestamps.length > 0
        ? validTimestamps[0] + this.config.windowMs
        : now + this.config.windowMs;

    return {
      allowed: count < this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - count),
      resetAt,
    };
  }
}

/**
 * Pre-configured rate limiters for MCP operations.
 */
export const rateLimiters = {
  /** Rate limiter for heavy ingestion operations (5 requests per 10 minutes) */
  ingest: new RateLimiter({
    maxRequests: 5,
    windowMs: 10 * 60 * 1000, // 10 minutes
    errorMessage:
      'Ingestion rate limit exceeded. Maximum 5 ingestions per 10 minutes. Please wait before retrying.',
  }),

  /** Rate limiter for file ingestion (10 requests per 5 minutes) */
  ingestFile: new RateLimiter({
    maxRequests: 10,
    windowMs: 5 * 60 * 1000, // 5 minutes
    errorMessage:
      'File ingestion rate limit exceeded. Maximum 10 files per 5 minutes. Please wait before retrying.',
  }),

  /** Rate limiter for search operations (100 requests per minute) */
  search: new RateLimiter({
    maxRequests: 100,
    windowMs: 60 * 1000, // 1 minute
    errorMessage: 'Search rate limit exceeded. Please slow down your requests.',
  }),
};

// ---------------------------------------------------------------------------
// RateLimitExceededError
// ---------------------------------------------------------------------------

/**
 * Machine-readable error thrown when a rate limit is exceeded.
 *
 * Carries a stable `code` ('RATE_LIMITED') and a human-readable message
 * that includes the action name and retry-after duration.  The `retryAfter`
 * field indicates the number of seconds the caller should wait before
 * retrying.
 */
export class RateLimitExceededError extends Error {
  readonly code = 'RATE_LIMITED' as const;
  readonly retryAfter: number;

  constructor(action: string, retryAfterMs: number) {
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    super(
      `RATE_LIMITED: Rate limit exceeded for "${action}". Try again in ${retryAfterSec} seconds.`
    );
    this.name = 'RateLimitExceededError';
    this.retryAfter = retryAfterSec;
  }
}

// ---------------------------------------------------------------------------
// Process-global key
// ---------------------------------------------------------------------------

/**
 * Default identifier used when no client identity is available at dispatch.
 *
 * Both STDIO and HTTP transports use the same process-local `dispatchMcpToolCall`
 * entry point and neither provides a per-session user identity to the dispatch
 * layer.  Using this global key ensures deterministic, session-safe rate
 * enforcement without inventing auth identity.
 *
 * **HTTP note:** The HTTP transport (`mcp/index.ts`) applies its own
 * IP-address-based rate limiter via `express-rate-limit`.  The process-local
 * limiter here is an **additional** layer that applies uniformly to all
 * transports.  When per-client identity becomes available in the dispatch
 * path, the identifier argument should be plumbed from the caller instead.
 */
export const PROCESS_GLOBAL_KEY = 'process-global';

// ---------------------------------------------------------------------------
// checkRateLimitOrThrow
// ---------------------------------------------------------------------------

/**
 * Check a rate limit and throw {@link RateLimitExceededError} if exceeded.
 *
 * This is the canonical entry point for production dispatch wiring.
 * When no caller identity is available (current default), the
 * `PROCESS_GLOBAL_KEY` is used so limits are shared across all callers
 * in the same process.
 *
 * @param limiter  - The pre-configured rate limiter instance.
 * @param action   - The action or tool name being rate-limited.
 * @param identifier  - Caller identity; defaults to `PROCESS_GLOBAL_KEY`.
 * @throws {RateLimitExceededError} when the limit has been reached.
 */
export function checkRateLimitOrThrow(
  limiter: RateLimiter,
  action: string,
  identifier: string = PROCESS_GLOBAL_KEY
): void {
  const result = limiter.checkLimit(action, identifier);
  if (!result.allowed) {
    const retryAfterMs = result.resetAt - Date.now();
    throw new RateLimitExceededError(action, retryAfterMs);
  }
}

// ---------------------------------------------------------------------------
// Cleanup interval
// ---------------------------------------------------------------------------

/**
 * Start the rate-limiter cleanup interval.
 *
 * The interval timer is **unref'd** when supported by the runtime (Bun,
 * Node.js 18+) so it does not keep the process alive.  Cleanup prunes
 * expired entries from every pre-configured limiter every 5 minutes.
 */
export function startCleanupInterval(): ReturnType<typeof setInterval> {
  const timer = setInterval(
    () => {
      rateLimiters.ingest.cleanup();
      rateLimiters.ingestFile.cleanup();
      rateLimiters.search.cleanup();
    },
    5 * 60 * 1000
  );

  // unref() is available on Bun, Node.js, and Deno timers.  When absent
  // (very rare) the interval still works but may block process exit.
  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref(): void }).unref();
  }

  return timer;
}

// Start cleanup on module load.
startCleanupInterval();
