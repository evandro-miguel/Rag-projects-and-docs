/**
 * Vitest global setup file.
 *
 * Polyfills Web Crypto API for Node.js 18 which does not expose
 * `crypto` as a global. Node 19+ exposes it automatically.
 */
import { webcrypto } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync(resolve(process.cwd(), '.tmp'), { recursive: true });

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

// Polyfill globalThis.crypto for Node 18 environments (test env)
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}
