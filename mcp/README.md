---
doc_type: module-doc
id: mcp-server
status: active
created_at: '2026-02-25T00:00:00Z'
updated_at: '2026-08-22T00:00:00Z'
version: '2.2'
---

# MCP Server Module

## Purpose

Model Context Protocol (MCP) server exposing RAG capabilities to AI agents (Claude, Qwen, etc.) via standardized tool interfaces. Supports both Docs RAG (external documentation) and Project RAG (repository code) retrieval.

Contract:

- `search_project_code` is the canonical project search tool.
- `search_project_docs` remains discoverable as a deprecated compatibility alias.
- Stdio is the primary transport and exposes the full canonical surface.
- `bun run mcp` starts the safe launcher path. Service health belongs to
  explicit health commands (`ragctl health`, `health_check`), not MCP startup.
- SSE is a limited compatibility surface, not a separate public API tier.
- Streamable HTTP `/mcp` (auth-gated) is available alongside the stdio primary
  and the legacy SSE compatibility surface.
- Current Project RAG search accepts public modes `vector` and `hybrid`. The
  Postgres backend executes hybrid vector plus lexical retrieval for both and
  reports vector-mode degradation explicitly. Keyword, deterministic, and
  semantic-only public modes remain unavailable.
- Project Docs RAG is a planned separate surface under the same `projectId`.
  The deprecated `search_project_docs` code-search alias must retire or version
  before that name can represent local documentation.
- The planned compact Project RAG facade is `search_project_code`,
  `get_project_outline`, `find_project_symbol`, `navigate_project_graph`,
  `verify_project_index`, and `prepare_project` (implemented). Granular tools
  remain available until parity and migration evidence permit consolidation.

## Location

`mcp/`

## Responsibilities

- Implement MCP protocol with stdio-first transport and a limited SSE compatibility surface
- Expose 18 public read tools by default; `read_write` adds five guarded
  mutation/service tools for 23 discoverable names
- Handle authentication and rate limiting
- Provide health check endpoint
- Launch and manage server lifecycle
- Support context-specific documentation adaptation

## Architecture

### Overview

```text
┌────────────────────────────────────────────────────────────────────┐
│                      MCP Server                                    │
│                   (stdio-first)                                    │
├────────────────────────────────────────────────────────────────────┤
│  Public tools: 18 read-only by default; 23 with read_write          │
│  Docs core (4): search_docs, get_document, list_categories,        │
│              health_check                                           │
│  Docs adaptation (2): adapt_docs, search_and_adapt                 │
│  Project core (8): search_project_code, get_project_file,          │
│                 get_project_outline, register_project,             │
│                 verify_project_index, ingest_project,               │
│                 ingest_project_file, prepare_project                │
│  Project navigation (3): find_project_symbol, find_symbol_references,│
│                 get_project_skeleton                               │
│  Compatibility alias (discoverable/deprecated): search_project_docs │
│  Experimental navigation (4): get_semantic_clusters,              │
│    get_directory_groups, get_navigation_paths, get_topic_groups   │
│  Internal only: inventory/dead-code helpers are not discoverable    │
│  System (1): ensure_reranker                                        │
├────────────────────────────────────────────────────────────────────┤
│  Transport: stdio primary; HTTP /mcp opt-in + loopback-only;       │
│  legacy SSE surface (/sse, /messages)                              │
│  Auth: Bearer token via authMiddleware                             │
│  Rate Limit: fixed HTTP limiter — 15-min window, max 1000 req      │
└────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | File | Description |
|-----------|------|-------------|
| **Server** | `server.ts` | MCP server implementation |
| **Tools** | `tools.ts` | Shared and compatibility tool definitions |
| **Handlers** | `handlers.ts` | Docs RAG handler implementations |
| **Project Handlers** | `project-handlers.ts` | Project RAG handler implementations |
| **Index** | `index.ts` | Opt-in loopback-only experimental HTTP `/mcp`; stdio remains the primary transport |
| **Launcher** | `launcher.ts` | Protocol-clean stdio launcher |

## Exports

### Tools (18 Public Reads; 5 Guarded Writes)

`rate_result`, tag tools, durable job tools, drift alert tools, and Convex-era
tools are retired from the stdio surface.

#### Docs Core Tools (4)

| Tool | Description | Input | Output |
|------|-------------|-------|--------|
| `search_docs` | Search external documentation | query, limit, categories, source/language/kind/authority filters | Search results with scores |
| `get_document` | Retrieve full document | sourcePath | Document with chunks |
| `list_categories` | List available categories | - | Category list |
| `health_check` | Check server and Docs RAG Postgres health | - | Health status |

#### Docs Adaptation Tools (2)

| Tool | Description | Input | Output |
|------|-------------|-------|--------|
| `adapt_docs` | Adapt docs for context | content, context, maxLength | Adapted text |
| `search_and_adapt` | Search + adapt in one step | query, context | Adapted response |

Adaptation is fail-closed in evaluation. **Gemini-powered adaptation is
retired.** The adapt tools now use deterministic local-only extraction
(`adaptDocumentLocally`). No external API keys are required. Adaptation
always resolves with `isError: false` unless an internal error occurs.

The MCP tool matrix treats an adaptation error envelope as a failure
even when the text payload looks non-empty.

#### Project Core Tools (7 Default)

| Tool | Description | Input | Output |
|------|-------------|-------|--------|
| `search_project_code` | Search indexed project code | projectId, query, limit, activeFile, mode | Ranked code results |
| `get_project_file` | Retrieve indexed project file content | projectId, sourcePath | File metadata + chunks |
| `get_project_outline` | Retrieve indexed file outline | projectId, sourcePath | Symbol/file outline |
| `register_project` | Register a project root with explicit ingest scope and optional blocked-finding allowlist | name, rootPath, includeRoots[], scopeAck, branch metadata, blockedFindingAllowlist[], replaceBlockedFindingAllowlist | Project registration result with allowlistAction and effectiveBlockedFindingAllowlist |
| `verify_project_index` | Verify project index health, freshness, and scope | projectId | Coverage and sync summary |
| `ingest_project` | Bounded delta ingestion into Postgres; `executionMode=durable` queues a deduplicated fenced `project_ingest_full` job for a separately operated worker | force, rootPath, includeRoots[], scopeAck, maxFiles, executionMode | Inline result, or queued-job acknowledgement for durable mode |
| `ingest_project_file` | Ingest one file inline | filePath, rootPath, force, scopeAck | Inline file result |
| `prepare_project` | Prepare one project | rootPath | Readiness and progress |

Project RAG scoping rules:

- `register_project` must receive explicit relative `includeRoots[]`.
- `register_project`, `ingest_project`, and `ingest_project_file` scope confirmation flows require `scopeAck=I_UNDERSTAND_PROJECT_RAG_SCOPE_V1` before execution.
- `rootPath` alone is not enough to define the ingestion corpus.
- `register_project` supports optional `blockedFindingAllowlist` and `replaceBlockedFindingAllowlist`:
  - Omit both (default): preserve the current DB allowlist.
  - `replaceBlockedFindingAllowlist: true` + `blockedFindingAllowlist: [...]`: replace the stored allowlist.
  - `replaceBlockedFindingAllowlist: true` + `blockedFindingAllowlist: []`: clear the stored allowlist.
  - Providing `blockedFindingAllowlist` without `replaceBlockedFindingAllowlist: true` is rejected.
  - `replaceBlockedFindingAllowlist: true` without `blockedFindingAllowlist` is rejected.
  - Each allowlist entry must be a project-relative path under an include root, with a valid suppressible category.
  - Max 32 entries. `nested_repo_marker` entries are never suppressible.
  - The DB migration 004 must be applied before allowlist replacement is allowed.
- First-time root ingestion via `ingest_project` must provide `includeRoots[]` (or run `register_project` first).
- Non-forced `ingest_project` is the normal bounded delta reconciliation path:
  it adds missing files, updates changed or failed files, and purges deleted or
  out-of-scope indexed files. It processes up to `maxFiles` or
  `MCP_FULL_PROJECT_INGEST_MAX_FILES` (default: 120) per MCP request.
- `force=true` is the guarded full-rebuild path. If the selected file count
  exceeds the MCP budget, it returns `MCP_INGESTION_SCOPE_TOO_LARGE` with CLI
  guidance instead of rebuilding through stdio.
- Full ingest must scan only the declared `includeRoots`.
- Removed files inside those folders must be purged from the project index.
- `executionMode=durable` on `ingest_project` queues a deduplicated, fenced
  `project_ingest_full` job; nothing drains that queue until an operator starts
  the worker. Run `bun run project-rag:worker` for the continuous claim/sleep
  loop (claims back-to-back while work exists, sleeps 5s when idle) or
  `bun run project-rag:worker --once` for a single claim. Workers identify
  themselves via `PROJECT_RAG_WORKER_ID` (default `worker-<pid>`) and are never
  started by `rag-daemon`.
- Watchers are removed/disabled in the current runtime. Keep read-only client
  configs read-only and use `bun run ingest-project` for bounded refreshes or
  `bun run repair:project` for operator repair.
- Legacy Convex MCP tools are retired from the stdio surface.
- Current-repo freshness should be checked with `bun run eval:mcp-project-current` and repaired with non-forced `ingest_project` or `bun run repair:project` before falling back to a full reingest.
- The current-project repair gate proves MCP availability independently from
  Docs RAG corpus health. Project registration, verification, and ingestion
  remain available when Docs RAG is degraded; each surface reports its own
  readiness.
- A completed repair batch verifies a newly calculated candidate list. Resume
  that list at `--offset 0`; an offset advances only when post-repair
  verification timed out and the prior list remains unconfirmed.
- Ordinary reads never mutate project state.
- Known cache, temporary, dependency, generated, and nested-repository roots
  are always rejected before mutation.
- The planned snapshot gate blocks candidate inventory changes of at least 25%
  or at least 500 files before mutation and routes them to qualified review.
- Current watchers are disabled. A future hot watcher records dirty paths under
  one lease per project with heartbeat and TTL; it never starts services or
  performs ingestion.

#### Project Navigation Tools (3)

| Tool | Description | Input | Output |
|------|-------------|-------|--------|
| `find_project_symbol` | Find a symbol by name | symbol, project | Symbol matches |
| `find_symbol_references` | Find references to a symbol | symbol, project | Reference list |
| `get_project_skeleton` | Retrieve stored project skeleton | projectId, sourcePath | Skeleton content |

Compatibility aliases:

- `search_project_docs` is a discoverable deprecated alias for `search_project_code`.
- `get_feature_hubs` is a non-discoverable deprecated alias for
  `get_directory_groups`.
- `get_project_skeleton` is the canonical project tool, no alias.

#### Internal analysis helpers

`get_code_metrics`, `search_inventory`, and `get_dead_code_report` remain
implementation helpers for repository maintenance. They are intentionally not
discoverable or callable through the public MCP registry.

#### Experimental project navigation (4)

| Tool | Description | Input | Output |
|------|-------------|-------|--------|
| `get_semantic_clusters` | Compute semantic clusters | projectId | Cluster map |
| `get_directory_groups` | Identify directory-based groups | projectId | Groups list |
| `get_navigation_paths` | Build navigation paths | projectId, sourcePath | Related file paths |
| `get_topic_groups` | Create topic groups | projectId | Topic clusters |

#### System Tools (1)

| Tool | Description | Input | Output |
|------|-------------|-------|--------|
| `ensure_reranker` | Ensure reranker service availability | - | Service readiness |

### Schemas

| Schema | Description |
|--------|-------------|
| `SearchDocsSchema` | Search tool input |
| `GetDocumentSchema` | Get document input |
| `IngestProjectSchema` | Project ingestion input |
| `IngestProjectFileSchema` | Single file ingestion input |

### Interfaces

| Interface | Description |
|-----------|-------------|
| `SearchDocsArgs` | Search arguments |
| `Category` | Category data |
| `SearchChunk` | Search result chunk |
| `SearchDocument` | Result document summary |
| `SearchResult` | Complete search result |
| `SearchResponse` | Search response envelope |
| `CategoriesResponse` | Categories response |

## Dependencies

### Internal

- `lib/ingest` - Document and project chunking/parsing helpers
- `lib/search` - Search scoring helpers
- `lib/shared` - Project registry, security, invariants, and shared types
- `scripts/project-rag` - Postgres Project RAG runtime operations

### External

- `@modelcontextprotocol/sdk` - MCP SDK
- `zod` - Schema validation
- `express` - HTTP server (Streamable HTTP `/mcp` + legacy SSE compatibility surface)

## Usage Examples

### Via MCP Client (Claude Desktop)

```json
{
  "mcpServers": {
    "rag-v2": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/path/to/rag-v2",
      "env": {
        "MCP_PERMISSION_MODE": "read_only",
        "DOCS_RAG_PG_LAB_DATABASE_URL": "${DOCS_RAG_PG_LAB_DATABASE_URL}",
        "PROJECT_RAG_DATABASE_URL": "${PROJECT_RAG_DATABASE_URL}",
        "EMBEDDING_PROVIDER": "llamacpp",
        "LLAMACPP_BASE_URL": "http://127.0.0.1:8082",
        "EMBEDDING_MODEL": "qwen3-embedding-1024"
      }
    }
  }
}
```

This command resolves to `mcp/launcher.ts`, which starts stdio directly. Health
checks and embedding/reranker readiness belong to explicit health commands, not
MCP startup side effects. Current Project RAG watchers are disabled.

#### Server Names For Smoke Tests

`scripts/eval/codex-mcp-smoke.ts` (exposed via `bun run eval:codex-mcp`) parses
`codex exec` JSONL output and matches MCP calls by **server name**. The
expected names are `rag-docs-read` and `rag-projects-read`. If you only
register the server under a different name (for example a single unified
`rag-v2` entry),
the smoke script will report `Requested MCP tool server rag-docs-read.health_check
was not available in this Codex instance.` and the strict gate will fail.

This smoke proves only the exercised connectivity and tool-call slice. It is
never release-passing evidence by itself. The full tool matrix also requires
every non-skipped adaptation call to return a non-error success envelope; an
adaptation failure marks the matrix overall result as failed.

To make the smoke lane pass, register two server entries pointing to the
same launcher with different `MCP_TOOLSET` env values:

```json
{
  "mcpServers": {
    "rag-docs": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "<PROJECT_ROOT>",
      "env": {
        "MCP_TOOLSET": "docs",
        "DOCS_RAG_PG_LAB_DATABASE_URL": "${DOCS_RAG_PG_LAB_DATABASE_URL}"
      }
    },
    "rag-projects": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "<PROJECT_ROOT>",
      "env": {
        "MCP_TOOLSET": "projects",
        "DOCS_RAG_PG_LAB_DATABASE_URL": "${DOCS_RAG_PG_LAB_DATABASE_URL}"
      }
    }
  }
}
```

For host-side acceptance without the Codex CLI, run the repo-owned matrix
directly via stdio:

```bash
bun run eval:mcp-live -- --docs-only
bun run eval:mcp-live
```

### Tool Call Examples

#### Search Docs

```typescript
// MCP tool call
{
  "name": "search_docs",
  "arguments": {
    "query": "How do I deploy to production?",
    "limit": 5,
    "categories": ["Infrastructure", "DevOps"]
  }
}

// Response
{
  "results": [
    {
      "chunk": {
        "content": "To deploy to production...",
        "section": "Deployment",
        "chunkIndex": 3
      },
      "score": 8.5,
      "document": {
        "title": "Deployment Guide",
        "sourcePath": "docs/deployment.md"
      }
    }
  ]
}
```

#### Get Document

```typescript
// MCP tool call
{
  "name": "get_document",
  "arguments": {
    "sourcePath": "docs/getting-started.md"
  }
}

// Response
{
  "document": {
    "title": "Getting Started",
    "sourcePath": "docs/getting-started.md",
    "content": "# Getting Started\n\n..."
  },
  "chunks": [...]
}
```

#### List Categories

```typescript
// MCP tool call
{
  "name": "list_categories"
}

// Response
{
  "categories": [
    { "name": "bun", "displayName": "Bun", "docCount": 42 },
    { "name": "react", "displayName": "React 19", "docCount": 38 },
    ...
  ]
}
```

#### Health Check

```typescript
// MCP tool call
{
  "name": "health_check"
}

// Response text
MCP Server: OK (0ms)
Docs RAG Postgres: OK (7ms)
  Connection succeeded and SELECT 1 returned the expected result.
```

## Deployment Notes

### Migration 004 Must Precede Registration Code

The `register_project` MCP tool and the `register-project` CLI both depend on
the `blocked_finding_allowlist` column in `project_repositories`. This column
is added by **migration 004**.

**Deployment order:**

1. Apply migration 004 to the Postgres Project RAG database.
2. Verify the schema is ready: `SELECT blocked_finding_allowlist FROM project_repositories LIMIT 1;`
3. Deploy the updated MCP server or CLI.

Without migration 004, both the CLI and MCP `register_project` return
`SCHEMA_NOT_READY` and refuse to upsert the repository row.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOCS_RAG_PG_LAB_DATABASE_URL` | Yes | - | Docs RAG Postgres database URL |
| `EMBEDDING_PROVIDER` | No | llamacpp | Local embedding provider (`llamacpp` by default; `ollama` only for legacy compatibility) |
| `LLAMACPP_BASE_URL` | No | <http://127.0.0.1:8082> | RAG-scoped llama.cpp endpoint for the live 1024D lane; defaults apply when unset (`RAG_LLAMACPP_BASE_URL` fallback) |
| `EMBEDDING_MODEL` | No | qwen3-embedding-1024 | 1024-dimensional live embedding model alias; defaults apply when unset (`LLAMACPP_EMBEDDING_MODEL` takes precedence) |
| `MCP_PORT` | No | 3333 | MCP HTTP server port (a plain `PORT` env var is silently ignored) |

The HTTP rate limiter is fixed in code: a 15-minute window with a maximum of
1000 requests per window. It is not configurable via environment variables.

### Server Options (HTTP mode only)

The legacy SSE and Streamable HTTP surfaces run from `mcp/index.ts` with this
environment surface:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_HTTP_ENABLED` | No | false | Explicitly enable the experimental HTTP transport |
| `MCP_API_KEY` | Required when enabled | - | Non-default Bearer token required by `authMiddleware` |
| `MCP_HOST` | No | 127.0.0.1 | Loopback-only bind host; non-loopback hosts are rejected |
| `MCP_PORT` | No | 3333 | HTTP bind port |
| `MCP_ALLOWED_ORIGINS` | No | `http://localhost:3333`, `http://127.0.0.1:3333` | Comma-separated CORS allowlist |

## Data Flow

### Tool Call Flow

```text
AI Agent → MCP Client → MCP Server
                              │
                              ▼
                     ┌─────────────────┐
                     │  authMiddleware │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  rateLimiter    │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  Tool Handler   │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ Postgres Backend│
                     └────────┬────────┘
                              │
                              ▼
                     Return Result → AI Agent
```

### Search Flow

```text
search_docs
        │
        ▼
  validate input (zod)
        │
        ▼
  query Docs RAG Postgres
        │
        ▼
  format results
        │
        ▼
  return to MCP client
```

## Error Handling

### Error Types

| Error | When Thrown | Recovery |
|-------|-------------|----------|
| `ValidationError` | Invalid tool arguments | Return error to client |
| `AuthenticationError` | Invalid/missing token | Return 401 |
| `RateLimitError` | Too many requests | Return 429 |
| `BackendError` | Backend failure | Retry or return error |

### Error Response Format

```typescript
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "Error: <message>"
  }]
}
```

## Performance Considerations

### Optimization Strategies

- **Caching**: Embedding cache avoids re-computation
- **Batching**: Batch database operations when possible
- **Timeout**: Every read tool is wrapped by `withReadDeadline` (`MCP_READ_TIMEOUT_MS`, default 30s) so stuck queries fail fast with `READ_DEADLINE_EXCEEDED`; write tools are never wrapped
- **Rate Limiting**: Protects backend from overload

### Bottlenecks

- **Embedding Generation (llama.cpp)**: ~50-200ms per query (Local)
- **Vector Search**: ~50-200ms
- **Network**: Postgres and local service round-trip latency

## Testing

### Test Location

`mcp/tests/`

### Test Suite

The module features a comprehensive test suite including unit, integration, and contract tests:

| Category | Tests | Description |
|----------|-------|-------------|
| **Handlers** | `handlers.test.ts`, `tools.test.ts` | Unit tests for tool definitions and logic |
| **Server** | `server.test.ts`, `index.test.ts` | Tests for MCP server basics and entry point |
| **Integration** | `integration/full-flow.test.ts`, `integration/error-propagation.test.ts` | End-to-end tool call flows and error handling |
| **Contract** | `contract/api-contract.test.ts`, `contract/schema-validation.test.ts` | Verification against MCP protocol standards |
| **Lifecycle** | `launcher.test.ts`, `server-lifecycle.test.ts` | Tests for server bootstrap and shutdown |

### Running Tests

```bash
# Run all MCP tests
bunx vitest run mcp/

# Run specific category
bunx vitest run mcp/tests/integration/

# Run with coverage
bunx vitest run --coverage mcp/
```

### Testing Tools

```bash
# Test via MCP inspector
npx @modelcontextprotocol/inspector bun run mcp
```

## Related Modules

### Docs RAG

- [[lib/ingest]](../lib/ingest/) - Ingestion helpers
- [[lib/search]](../lib/search/) - Search helpers

### Project RAG

- [[scripts/project-rag]](../scripts/project-rag/) - Project registry and retrieval
- [[lib/shared]](../lib/shared/) - Shared Project RAG contracts

### Analysis

- [[scripts/maintain-inventory]](../scripts/maintain-inventory.ts) - Code inventory generation

## Related Documentation

- [Documentation hub](../docs/README.md) - Public user guides
- [Using Docs RAG](../docs/guides/using-docs-rag.md)
- [Using Project RAG](../docs/guides/using-project-rag.md)
- [Using ragctl](../docs/guides/using-ragctl.md)
- [[MCP Protocol]](https://modelcontextprotocol.io/) - MCP specification

## Change Log

| Date | Version | Change | Author |
|------|---------|--------|--------|
| 2026-08-22 | 2.2.1 | Deployment-truth corrections: `MCP_PORT` default 3333 (plain `PORT` silently ignored); fixed HTTP rate limiter (15-min window, max 1000 req) replaces fictional `RATE_LIMIT_*` vars; Server Options table now lists the real HTTP-mode surface (`MCP_API_KEY`, `MCP_HOST`, `MCP_ALLOWED_ORIGINS`); Streamable HTTP `/mcp` documented; embedding endpoint/model vars marked optional with defaults | auditor-verified review |
| 2026-08-22 | 2.2.0 | Corrected durable `ingest_project` behavior; read-deadline coverage extended to all read tools (30s default) | orchestrator |
| 2026-03-10 | 2.0.0 | Added Project RAG tools, Analysis tools, adapt_docs | orchestrator |
| 2026-02-25 | 1.0.0 | Initial module documentation | orchestrator |

---

*Module Documentation: `mcp/README.md`*
*Last Updated: 2026-08-22*
*Version: 2.2*
