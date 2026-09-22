#!/usr/bin/env bun
/**
 * @module ensure-ollama
 * @deprecated Use scripts/ensure-embedding-provider.ts.
 *
 * This compatibility entrypoint intentionally no longer starts or pulls a
 * global Ollama service. The only supported embedding provider is the
 * RAG-scoped llama.cpp endpoint.
 */

console.error(
  'scripts/ensure-ollama.ts is deprecated; delegating to scripts/ensure-embedding-provider.ts'
);

const { main } = await import('./ensure-embedding-provider.js');
await main();

export {};
