#!/usr/bin/env bun
/**
 * @module check-ollama-health
 * @deprecated Use check-embedding-health.ts. Ollama is unsupported; this wrapper
 * remains only so older entrypoints fail through the canonical llama.cpp check.
 */

export * from './check-embedding-health.js';

import { main } from './check-embedding-health.js';

if (import.meta.main) {
  main().catch((error) => {
    console.error('Health check crashed:', error);
    process.exit(1);
  });
}
