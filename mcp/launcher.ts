/**
 * @module launcher
 * @description MCP server launcher for the Postgres-backed RAG runtime.
 *
 * This launcher keeps stdio startup protocol-clean. It does not probe or
 * autostart Convex; service health belongs to explicit health commands.
 *
 * @see server.ts - MCP server implementation
 * @see index.ts - Legacy HTTP/SSE compatibility surface
 */

await import('./server.js');

export {};
