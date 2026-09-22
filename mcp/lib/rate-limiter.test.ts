import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkRateLimitOrThrow,
  PROCESS_GLOBAL_KEY,
  RateLimitExceededError,
  RateLimiter,
  rateLimiters,
  startCleanupInterval,
} from './rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
  });

  afterEach(() => {
    limiter.clearAll();
  });

  it('allows requests within the limit', () => {
    expect(limiter.checkLimit('search', 'user1').allowed).toBe(true);
    expect(limiter.checkLimit('search', 'user1').allowed).toBe(true);
    expect(limiter.checkLimit('search', 'user1').allowed).toBe(true);
  });

  it('blocks requests exceeding the limit', () => {
    limiter.checkLimit('test', 'u');
    limiter.checkLimit('test', 'u');
    limiter.checkLimit('test', 'u');
    const result = limiter.checkLimit('test', 'u');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('reports correct remaining count', () => {
    const r1 = limiter.checkLimit('op', 'id');
    expect(r1.remaining).toBe(2);
    const r2 = limiter.checkLimit('op', 'id');
    expect(r2.remaining).toBe(1);
  });

  it('resets limit for a specific action/identifier', () => {
    limiter.checkLimit('op', 'id');
    limiter.checkLimit('op', 'id');
    limiter.checkLimit('op', 'id');
    expect(limiter.checkLimit('op', 'id').allowed).toBe(false);
    limiter.reset('op', 'id');
    expect(limiter.checkLimit('op', 'id').allowed).toBe(true);
  });

  it('clearAll removes all entries', () => {
    limiter.checkLimit('a', 'x');
    limiter.checkLimit('b', 'y');
    limiter.clearAll();
    expect(limiter.checkLimit('a', 'x').allowed).toBe(true);
    expect(limiter.checkLimit('b', 'y').allowed).toBe(true);
  });

  it('cleanup removes expired entries', async () => {
    limiter = new RateLimiter({ maxRequests: 5, windowMs: 10 });
    limiter.checkLimit('fast', 'u');
    limiter.checkLimit('fast', 'u');
    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 20));
    limiter.cleanup();
    expect(limiter.checkLimit('fast', 'u').allowed).toBe(true);
  });

  it('getStatus returns current state without consuming', () => {
    const before = limiter.getStatus('op', 'id');
    expect(before.remaining).toBe(3);
    limiter.checkLimit('op', 'id');
    const after = limiter.getStatus('op', 'id');
    expect(after.remaining).toBe(2);
  });
});

describe('startCleanupInterval', () => {
  it('returns a timer object with unref when supported', () => {
    const timer = startCleanupInterval();
    expect(timer).toBeDefined();
    expect(typeof timer).toBe('object');
    // unref should not throw
    expect(() => timer.unref?.()).not.toThrow();
    clearInterval(timer);
  });
});

describe('rateLimiters (pre-configured)', () => {
  it('ingest allows up to 5 requests', () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimiters.ingest.checkLimit('ingest_project', 'agent1').allowed).toBe(true);
    }
    expect(rateLimiters.ingest.checkLimit('ingest_project', 'agent1').allowed).toBe(false);
    rateLimiters.ingest.reset('ingest_project', 'agent1');
  });

  it('ingestFile allows up to 10 requests', () => {
    for (let i = 0; i < 10; i++) {
      expect(rateLimiters.ingestFile.checkLimit('ingest_project_file', 'agent2').allowed).toBe(
        true
      );
    }
    expect(rateLimiters.ingestFile.checkLimit('ingest_project_file', 'agent2').allowed).toBe(false);
    rateLimiters.ingestFile.reset('ingest_project_file', 'agent2');
  });

  it('search allows up to 100 requests', () => {
    const id = `search-agent-${Date.now()}`;
    for (let i = 0; i < 100; i++) {
      rateLimiters.search.checkLimit('search_docs', id);
    }
    expect(rateLimiters.search.checkLimit('search_docs', id).allowed).toBe(false);
    rateLimiters.search.reset('search_docs', id);
  });
});

describe('checkRateLimitOrThrow', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
  });

  afterEach(() => {
    limiter.clearAll();
  });

  it('allows calls within the limit', () => {
    expect(() => checkRateLimitOrThrow(limiter, 'test', 'u')).not.toThrow();
    expect(() => checkRateLimitOrThrow(limiter, 'test', 'u')).not.toThrow();
    expect(() => checkRateLimitOrThrow(limiter, 'test', 'u')).not.toThrow();
    // Fourth call should be rejected
    expect(() => checkRateLimitOrThrow(limiter, 'test', 'u')).toThrow(RateLimitExceededError);
  });

  it('throws RateLimitExceededError with code RATE_LIMITED when over limit', () => {
    limiter.checkLimit('search', 'client1');
    limiter.checkLimit('search', 'client1');
    limiter.checkLimit('search', 'client1');

    expect(() => checkRateLimitOrThrow(limiter, 'search', 'client1')).toThrow(
      RateLimitExceededError
    );
    // Verify we can catch and inspect the error
    try {
      checkRateLimitOrThrow(limiter, 'search', 'client1');
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitExceededError);
      expect((e as RateLimitExceededError).code).toBe('RATE_LIMITED');
      expect((e as RateLimitExceededError).message).toContain('search');
      expect((e as RateLimitExceededError).retryAfter).toBeGreaterThanOrEqual(0);
    }
  });

  it('resets allow subsequent calls (isolation)', () => {
    // Exhaust limit
    checkRateLimitOrThrow(limiter, 'op', 'id');
    checkRateLimitOrThrow(limiter, 'op', 'id');
    checkRateLimitOrThrow(limiter, 'op', 'id');
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'id')).toThrow(RateLimitExceededError);

    // Reset and try again
    limiter.reset('op', 'id');
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'id')).not.toThrow();
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'id')).not.toThrow();
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'id')).not.toThrow();
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'id')).toThrow(RateLimitExceededError);
  });

  it('uses PROCESS_GLOBAL_KEY by default when no identifier provided', () => {
    // Use the process-global key by omitting the identifier
    checkRateLimitOrThrow(limiter, 'ingest');
    checkRateLimitOrThrow(limiter, 'ingest');
    checkRateLimitOrThrow(limiter, 'ingest');
    expect(() => checkRateLimitOrThrow(limiter, 'ingest')).toThrow(RateLimitExceededError);

    // Verify it actually used PROCESS_GLOBAL_KEY by checking the limiter
    const status = limiter.getStatus('ingest', PROCESS_GLOBAL_KEY);
    expect(status.remaining).toBe(0);

    limiter.reset('ingest', PROCESS_GLOBAL_KEY);
  });

  it('isolates different identifiers from each other', () => {
    checkRateLimitOrThrow(limiter, 'op', 'user-a');
    checkRateLimitOrThrow(limiter, 'op', 'user-a');
    checkRateLimitOrThrow(limiter, 'op', 'user-a');
    // user-a is exhausted
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'user-a')).toThrow(RateLimitExceededError);

    // user-b is independent
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'user-b')).not.toThrow();
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'user-b')).not.toThrow();
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'user-b')).not.toThrow();
    expect(() => checkRateLimitOrThrow(limiter, 'op', 'user-b')).toThrow(RateLimitExceededError);
  });

  it('isolates different actions from each other', () => {
    checkRateLimitOrThrow(limiter, 'search', 'client');
    checkRateLimitOrThrow(limiter, 'search', 'client');
    checkRateLimitOrThrow(limiter, 'search', 'client');
    // search is exhausted
    expect(() => checkRateLimitOrThrow(limiter, 'search', 'client')).toThrow(
      RateLimitExceededError
    );

    // ingest is independent (same identifier, different action)
    expect(() => checkRateLimitOrThrow(limiter, 'ingest', 'client')).not.toThrow();
  });
});

describe('RateLimitExceededError', () => {
  it('sets code RATE_LIMITED and computes retryAfter from ms', () => {
    const err = new RateLimitExceededError('search_docs', 5432);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.name).toBe('RateLimitExceededError');
    expect(err.retryAfter).toBe(6); // ceil(5432 / 1000)
    expect(err.message).toContain('search_docs');
    expect(err.message).toContain('RATE_LIMITED');
  });

  it('handles zero ms gracefully', () => {
    const err = new RateLimitExceededError('ingest', 0);
    expect(err.retryAfter).toBe(0);
    expect(err.code).toBe('RATE_LIMITED');
  });
});

describe('PROCESS_GLOBAL_KEY', () => {
  it('is a deterministic string', () => {
    expect(PROCESS_GLOBAL_KEY).toBe('process-global');
  });
});
