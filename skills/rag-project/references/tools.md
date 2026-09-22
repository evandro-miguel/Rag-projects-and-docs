---
description: Full Project RAG MCP and CLI surface grouped by purpose.
metadata:
  tags: "project-rag, tools, mcp, search, navigation, ragctl"
---

# Project RAG Tool Inventory

## CLI (preferred for ordinary reads)

```bash
./bin/ragctl projects list --json
./bin/ragctl project verify --project <slug-or-id> [--full] --json
./bin/ragctl project search --project <slug-or-id> "<query>" --mode hybrid --json
./bin/ragctl project file --project <slug-or-id> --file <path> --json
./bin/ragctl project outline --project <slug-or-id> --file <path> --json
./bin/ragctl project symbol --project <slug-or-id> --name <symbol> [--references] --json
```

### Search modes

| Mode | Status | Guidance |
| --- | --- | --- |
| `hybrid` | Default | Preferred for mixed concept and identifier queries |
| `vector` | Supported | Semantic intent; backend reports any degradation |
| `keyword` | Deprecated | Maps to hybrid; do not treat as a distinct lane |

Exact path/symbol work is not a search mode. Use `rg`/`fd`, outline, symbol, and
file tools.

## Core Search And Retrieval (MCP)

- `search_project_code` — vector or hybrid code retrieval.
- `get_project_file` — indexed file metadata, chunks, and per-file freshness.
- `get_project_outline` — symbol outline before loading full indexed content.
- `get_project_skeleton` — lightweight structural view of a file.

## Symbol Navigation

- `find_project_symbol` — symbol definition lookup.
- `find_symbol_references` — reference and graph hints. Useful for orientation,
  not a substitute for exhaustive `rg` when completeness matters.

## Registration And Ingestion

- `register_project` — absolute `rootPath`, explicit `includeRoots`, optional
  `scopeAck`, optional blocked-finding allowlist fields:
  `blockedFindingAllowlist`, `replaceBlockedFindingAllowlist`.
- `verify_project_index` — coverage and freshness.
- `ingest_project` — bounded delta reconciliation by default; `force=true` is
  guarded full rebuild and may fail with `MCP_INGESTION_SCOPE_TOO_LARGE`.
- `ingest_project_file` — targeted single-file repair.

Mutating tools require write-enabled MCP. Prefer
`bun run ingest-project --root ... --include ...` for broad local maintenance.

## Experimental project navigation

- `get_semantic_clusters`
- `get_directory_groups` (the old `get_feature_hubs` name is deprecated)
- `get_navigation_paths`
- `get_topic_groups`

These are experimental shape/navigation helpers, not semantic-clustering
guarantees. Use them only when repository shape is more useful than a single
symbol or file.

## Internal analysis helpers

Inventory and dead-code helpers are internal maintenance code, not public MCP
tools. Use repository-local scripts when maintainers explicitly need them.

Inventory orientation only. Not proof of dependency completeness.

## Compatibility

- `search_project_docs` — deprecated alias for `search_project_code`. Do not use
  for new flows. Project Docs RAG is a planned separate surface and must not
  reuse this alias until it is versioned or retired.

## Search Hints

- Prefer `mode: "hybrid"` for mixed concept plus identifier queries.
- Prefer `mode: "vector"` for conceptual discovery when identifiers are unknown.
- Use `activeFile` when local file context should bias ranking.
- Do not rely on `deterministic: true` as an implemented public search lane.
