/**
 * In-Memory Rate Limiter
 *
 * Simple rate limiting for HTTP endpoints using a fixed window algorithm.
 * Stores request counts in-memory for fast synchronous checks.
 *
 * @module lib/rate-limiter
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/**
 * In-memory rate limiter using a fixed window algorithm.
 *
 * Features:
 * - Configurable request limit and time window
 * - Automatic cleanup of expired entries
 * - Returns remaining requests and reset time for client guidance
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter(100, 60 * 60 * 1000); // 100 req/hour
 * const result = limiter.check('192.168.1.1');
 * if (!result.allowed) {
 *   return new Response('Rate limited', { status: 429, headers: { 'Retry-After': String(result.retryAfter) } });
 * }
 * ```
 */
export class RateLimiter {
  private requests = new Map<string, RateLimitEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Creates a new RateLimiter instance.
   *
   * @param maxRequests - Maximum requests allowed per window (default: 100)
   * @param windowMs - Time window in milliseconds (default: 1 hour)
   * @param autoCleanup - Enable automatic cleanup of expired entries (default: true)
   */
  constructor(
    private maxRequests = 100,
    private windowMs: number = 60 * 60 * 1000,
    autoCleanup = true
  ) {
    if (autoCleanup) {
      // Run cleanup every 5 minutes
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }
  }

  /**
   * Check if a request is allowed for the given key.
   *
   * @param key - Unique identifier for the client (e.g., IP address)
   * @returns Rate limit result with allowed status and metadata
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    const entry = this.requests.get(key);

    // New window or expired entry
    if (!entry || now > entry.resetAt) {
      const resetAt = now + this.windowMs;
      this.requests.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetAt,
      };
    }

    // Rate limit exceeded
    if (entry.count >= this.maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000); // seconds
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
        retryAfter,
      };
    }

    // Increment counter
    entry.count++;
    return {
      allowed: true,
      remaining: this.maxRequests - entry.count,
      resetAt: entry.resetAt,
    };
  }

  /**
   * Remove expired entries from memory.
   * Called automatically if autoCleanup is enabled.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.requests) {
      if (now > entry.resetAt) {
        this.requests.delete(key);
      }
    }
  }

  /**
   * Get current statistics for monitoring/debugging.
   */
  getStats(): { totalKeys: number; activeKeys: number } {
    const now = Date.now();
    let activeKeys = 0;
    for (const entry of this.requests.values()) {
      if (now <= entry.resetAt) {
        activeKeys++;
      }
    }
    return {
      totalKeys: this.requests.size,
      activeKeys,
    };
  }

  /**
   * Stop the cleanup interval and clear all entries.
   * Call this when shutting down the server.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.requests.clear();
  }
}

/**
 * Extract client IP from request headers.
 * Checks X-Forwarded-For (common for proxies) then falls back to 'unknown'.
 *
 * @param request - The incoming HTTP request
 * @returns Client IP address or 'unknown'
 */
export function getClientIP(request: Request): string {
  // X-Forwarded-For: client, proxy1, proxy2
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) {
    // Take the first IP (original client)
    const ips = forwardedFor.split(',').map((ip) => ip.trim());
    if (ips[0]) {
      return ips[0];
    }
  }

  // Fall back to X-Real-IP (used by some proxies like nginx)
  const realIP = request.headers.get('X-Real-IP');
  if (realIP) {
    return realIP;
  }

  return 'unknown';
}
