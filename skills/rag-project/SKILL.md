---
name: rag-project
description: Use when you need to register, search, inspect, or troubleshoot repository code with Project RAG.
metadata:
  category: reference
  tags: "project-rag, code-retrieval, symbol-navigation, freshness, mcp, ragctl"
  triggers: "project rag, search_project_code, register_project, ingest_project, verify_project_index, find_project_symbol, stale index, project not found, project verify"
  references: "overview, tools, workflows, gotchas"
  version: "2.0.0"
  updated_at: "2026-07-18T00:00:00Z"
  target_provider: universal
---

# Project RAG

Tier 2 dispatcher for repository-code retrieval in this repo and in consumer
projects.

Canonical surface: Project core, navigation, semantic navigation, and analysis
tools, plus the deprecated alias `search_project_docs`.

Prefer short-lived `ragctl` for ordinary read-only lookups. Use MCP for
registration, ingestion, or explicit MCP parity. Default MCP permission mode is
`read_only`; mutating tools need `MCP_PERMISSION_MODE=read_write`.

## Use This Skill When

- You need code search, symbol lookup, or line-level file retrieval.
- You need to register or ingest a project for Project RAG.
- You suspect stale, blocked, or missing indexed content.
- You need semantic navigation or inventory orientation across a codebase.

## Decision Tree

Need the full tool surface and which tool to call first?

- Read [Tool Inventory](./references/tools.md).

Need to register, ingest, refresh, or verify a project?

- Read [Operational Workflows](./references/workflows.md).

Need to debug stale, missing, noisy, or degraded results?

- Read [Gotchas](./gotchas.md).

Need external documentation instead of repository code?

- Stop and use `rag-docs`.

## Non-Negotiables

- Prefer `search_project_code`; `search_project_docs` is a deprecated
  code-search alias, not Project Docs RAG.
- Use explicit `includeRoots` and confirm
  `scopeAck=I_UNDERSTAND_PROJECT_RAG_SCOPE_V1` for mutating registration/ingest.
- Treat index coverage, blocked files, and file freshness as separate checks.
- Prefer Project search modes `hybrid` (default) or `vector`. `keyword` is
  deprecated and maps to hybrid execution.
- Deterministic-only Project search is not an implemented public mode. Use
  `rg`, outline, symbol, and file tools for exact navigation.
- Cross-check suspicious indexed content with `rg` when working-tree truth
  matters.
- Current watchers are disabled. Reads must not start watcher herds. Refresh
  with explicit ingest or repair scripts.
