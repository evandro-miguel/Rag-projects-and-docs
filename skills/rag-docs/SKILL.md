---
name: rag-docs
description: Use when you need to search, retrieve, adapt, or troubleshoot external documentation with Docs RAG.
metadata:
  category: reference
  tags: "docs-rag, documentation-search, adaptation, reranker, mcp, ragctl"
  triggers: "docs rag, search_docs, get_document, search_and_adapt, adapt_docs, ensure_reranker, reranker unavailable, docs sources, docs health"
  references: "overview, tools, workflows, gotchas"
  version: "2.0.0"
  updated_at: "2026-07-18T00:00:00Z"
  target_provider: universal
---

# Docs RAG

Tier 2 dispatcher for the external documentation corpus managed by this repo.

Canonical MCP surface: `search_docs`, `get_document`, `list_categories`,
`health_check`, `adapt_docs`, `search_and_adapt`, and `ensure_reranker`.

Prefer short-lived `ragctl` for ordinary read-only lookups. Use MCP when the
task needs adaptation, write-side reranker recovery, or explicit MCP parity.

## Use This Skill When

- You need external documentation instead of repository code.
- You need to narrow results by source, language, kind, authority, or category.
- You need to adapt retrieved docs for a target audience.
- You need to troubleshoot degraded docs retrieval or reranker issues.

## Decision Tree

Need the full tool inventory?

- Read [Tool Inventory](./references/tools.md).

Need the normal search, adaptation, or reranker workflows?

- Read [Operational Workflows](./references/workflows.md).

Need to debug weak, empty, slow, or fallback-heavy results?

- Read [Gotchas](./gotchas.md).

Need repository code rather than external docs?

- Stop and use `rag-project`.

## Non-Negotiables

- Use `ragctl docs search` or MCP `search_docs` for discovery and
  `get_document` for full context.
- Prefer source filters (`--source`, `--language`, `--kind`, `--authority`,
  `--category`) over retired tag tools.
- Treat scores and fallback warnings as retrieval-quality signals.
- `health_check` / `ragctl docs health` cover backend and corpus readiness;
  inspect them before blaming search quality.
- Adaptation is deterministic local-only extraction. Gemini-powered adaptation
  is retired.
- Retired tools must not be used: `rate_result`, `list_tags`, `get_tag_info`,
  `assign_tag`, `remove_tag`.
- Local project docs belong to planned Project Docs RAG, not Docs RAG.
