/**
 * Tests for lib/rate-limiter.ts
 *
 * Covers:
 * - new RateLimiter(100, 3600000) creates limiter with 100 req/hour
 * - check(key) returns { allowed: true, remaining: 99, resetAt } on first request
 * - check(key) returns { allowed: false, remaining: 0 } after limit exceeded
 * - cleanup() removes expired entries
 * - Window resets after expiry time
 * - getClientIP() extracts IP from request headers
 */

import { describe, expect, it } from 'vitest';
import { getClientIP, RateLimiter } from '../rate-limiter.js';

describe('rate-limiter', () => {
  describe('RateLimiter constructor', () => {
    it('creates limiter with default values (100 req/hour)', () => {
      const limiter = new RateLimiter();
      // Can't directly access private properties, but can test behavior
      const result = limiter.check('test-key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99); // 100 - 1
    });

    it('creates limiter with custom max requests', () => {
      const limiter = new RateLimiter(5, 60000, false);
      for (let i = 0; i < 5; i++) {
        const result = limiter.check('test-key');
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }
    });

    it('creates limiter with custom window', () => {
      const limiter = new RateLimiter(10, 1000, false);
      const result = limiter.check('test-key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.resetAt).toBeGreaterThan(Date.now());
      expect(result.resetAt).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('disables auto cleanup when specified', () => {
      // This test ensures the constructor accepts the parameter
      // Without throwing or causing issues
      const limiter = new RateLimiter(100, 3600000, false);
      expect(limiter).toBeDefined();
    });
  });

  describe('RateLimiter.check()', () => {
    it('allows first request and returns remaining count', () => {
      const limiter = new RateLimiter(100, 3600000, false);
      const result = limiter.check('new-client');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
      expect(result.resetAt).toBeDefined();
      expect(result.resetAt).toBeGreaterThan(Date.now());
    });

    it('tracks multiple requests from same key', () => {
      const limiter = new RateLimiter(5, 3600000, false);

      const result1 = limiter.check('client-1');
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(4);

      const result2 = limiter.check('client-1');
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(3);

      const result3 = limiter.check('client-1');
      expect(result3.allowed).toBe(true);
      expect(result3.remaining).toBe(2);
    });

    it('tracks different keys independently', () => {
      const limiter = new RateLimiter(10, 3600000, false);

      const result1 = limiter.check('client-A');
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(9);

      const result2 = limiter.check('client-B');
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(9);
    });

    it('blocks requests after limit is exceeded', () => {
      const limiter = new RateLimiter(3, 3600000, false);

      // Use up all allowed requests
      limiter.check('limited-client');
      limiter.check('limited-client');
      limiter.check('limited-client');

      // Next request should be blocked
      const result = limiter.check('limited-client');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('returns retryAfter in seconds when rate limited', () => {
      const limiter = new RateLimiter(2, 5000, false);

      limiter.check('retry-client');
      limiter.check('retry-client');
      const result = limiter.check('retry-client');

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeLessThanOrEqual(5);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('allows requests after window resets', async () => {
      const windowMs = 100;
      const limiter = new RateLimiter(2, windowMs, false);

      // Use up the limit
      limiter.check('reset-client');
      limiter.check('reset-client');
      expect(limiter.check('reset-client').allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, windowMs + 50));

      // Should be allowed again
      const result = limiter.check('reset-client');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });
  });

  describe('RateLimiter.cleanup()', () => {
    it('removes expired entries', async () => {
      const windowMs = 50;
      const limiter = new RateLimiter(10, windowMs, false);

      // Add some entries
      limiter.check('temp-client-1');
      limiter.check('temp-client-2');

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, windowMs + 50));

      // Cleanup should remove expired entries
      limiter.cleanup();

      // After cleanup, these should be treated as new clients
      const result1 = limiter.check('temp-client-1');
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(9); // Fresh window
    });

    it('keeps active entries during cleanup', () => {
      const limiter = new RateLimiter(10, 3600000, false);

      // Add entries
      limiter.check('active-client-1');
      limiter.check('active-client-2');

      // Cleanup should not remove active entries
      limiter.cleanup();

      // Should still be tracked
      const result1 = limiter.check('active-client-1');
      expect(result1.remaining).toBe(8); // Was 9, now 8
    });
  });

  describe('RateLimiter.getStats()', () => {
    it('returns total and active keys count', () => {
      const limiter = new RateLimiter(10, 3600000, false);

      limiter.check('stats-client-1');
      limiter.check('stats-client-2');
      limiter.check('stats-client-3');

      const stats = limiter.getStats();
      expect(stats.totalKeys).toBe(3);
      expect(stats.activeKeys).toBe(3);
    });

    it('excludes expired keys from active count', async () => {
      const windowMs = 50;
      const limiter = new RateLimiter(10, windowMs, false);

      limiter.check('expired-client');
      await new Promise((resolve) => setTimeout(resolve, windowMs + 50));

      const stats = limiter.getStats();
      expect(stats.totalKeys).toBe(1);
      expect(stats.activeKeys).toBe(0);
    });
  });

  describe('RateLimiter.destroy()', () => {
    it('clears all entries', () => {
      const limiter = new RateLimiter(10, 3600000, false);

      limiter.check('destroy-client-1');
      limiter.check('destroy-client-2');

      limiter.destroy();

      const stats = limiter.getStats();
      expect(stats.totalKeys).toBe(0);
      expect(stats.activeKeys).toBe(0);
    });

    it('stops cleanup interval', () => {
      const limiter = new RateLimiter(10, 3600000, true);
      limiter.destroy();
      // If we reach here without errors, the interval was cleared
    });
  });

  describe('getClientIP()', () => {
    it('extracts IP from X-Forwarded-For header', () => {
      const request = new Request('http://example.com', {
        headers: {
          'X-Forwarded-For': '192.168.1.1, 10.0.0.1, 172.16.0.1',
        },
      });

      const ip = getClientIP(request);
      expect(ip).toBe('192.168.1.1');
    });

    it('extracts single IP from X-Forwarded-For header', () => {
      const request = new Request('http://example.com', {
        headers: {
          'X-Forwarded-For': '203.0.113.50',
        },
      });

      const ip = getClientIP(request);
      expect(ip).toBe('203.0.113.50');
    });

    it('extracts IP from X-Real-IP header when X-Forwarded-For is absent', () => {
      const request = new Request('http://example.com', {
        headers: {
          'X-Real-IP': '198.51.100.42',
        },
      });

      const ip = getClientIP(request);
      expect(ip).toBe('198.51.100.42');
    });

    it('prefers X-Forwarded-For over X-Real-IP', () => {
      const request = new Request('http://example.com', {
        headers: {
          'X-Forwarded-For': '192.168.1.1',
          'X-Real-IP': '10.0.0.1',
        },
      });

      const ip = getClientIP(request);
      expect(ip).toBe('192.168.1.1');
    });

    it('returns "unknown" when no IP headers present', () => {
      const request = new Request('http://example.com');

      const ip = getClientIP(request);
      expect(ip).toBe('unknown');
    });

    it('handles whitespace in X-Forwarded-For values', () => {
      const request = new Request('http://example.com', {
        headers: {
          'X-Forwarded-For': '  192.168.1.1  ,  10.0.0.1  ',
        },
      });

      const ip = getClientIP(request);
      expect(ip).toBe('192.168.1.1');
    });
  });
});
