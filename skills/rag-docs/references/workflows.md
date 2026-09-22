---
description: Practical Docs RAG workflows for search, adaptation, and reranker-aware troubleshooting.
metadata:
  tags: "docs-rag, workflows, search, adaptation, reranker, ragctl"
---

# Docs RAG Workflows

## Discovery Flow (CLI first)

1. If readiness is uncertain, run `ragctl docs health --json` or
   `ragctl health --json`.
2. Optionally list sources with `ragctl docs sources list --json`.
3. Run `ragctl docs search "<query>" --limit 5 --json` with a concrete,
   task-shaped query.
4. Add source, language, kind, authority, or category filters when the first
   pass is noisy.
5. Fetch full source with MCP `get_document` only before strong claims.

Good query shape:

```text
Bun.serve route handler error handling timeout
```

## Adaptation Flow

1. Prefer `search_docs` / `ragctl docs search` when comparing multiple sources.
2. Use MCP `search_and_adapt` for a direct shaped answer only when adaptation is
   explicitly useful.
3. Use MCP `get_document` before exact implementation guidance.
4. Use MCP `adapt_docs` on retrieved content for the final audience.

Remember: adaptation is local deterministic extraction, not Gemini rewriting.

## Reranker Flow

1. Run `ragctl docs health --json` or MCP `health_check`.
2. If reranker is unavailable and write tools are exposed, call
   `ensure_reranker`.
3. If search is still slow, lower `limit`.
4. If fallback remains visible, inspect full documents before summarizing.

## Filter Recovery Flow

1. If results are empty after filtering, re-run without filters.
2. Confirm the source exists with `ragctl docs sources list --json`.
3. Prefer authority/source filters over broad vague queries.
