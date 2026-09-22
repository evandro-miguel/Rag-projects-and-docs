---
description: Docs RAG failure modes, retrieval traps, and reranker recovery steps.
metadata:
  tags: "docs-rag, gotchas, reranker, fallback, troubleshooting"
---

# Docs RAG Gotchas

## Vague Queries Waste Recall

Queries such as `auth help` or `deployment` are usually too broad. Prefer a
task-shaped query.

## Short Chunks Are Not Full Truth

If a result is nuanced, fetch the full source with `get_document` before making
strong claims.

## Fallback Changes Quality

If the response shows `fallback` or an explicit warning, expect weaker recall
or precision.

## Filters Can Over-Narrow

Source, language, kind, authority, and category filters improve precision but
can hide otherwise good matches. Re-run without filters after checking
`ragctl docs sources list --json`.

## Slow Search Often Means Reranker Trouble

Lower `limit`, then check `health_check` / `docs health` or call
`ensure_reranker` when write tools are available.

## Adaptation Is Local-Only

`adapt_docs` and `search_and_adapt` do not call an external LLM. Treat them as
deterministic reshaping helpers, not high-quality generation.

## Retired Tools Still Appear In Old Notes

Do not use `rate_result` or tag tools (`list_tags`, `get_tag_info`,
`assign_tag`, `remove_tag`).

## Wrong Surface

If the user actually needs repository behavior, file paths, or symbols, switch
to Project RAG immediately. Local repository docs belong to planned Project Docs
RAG, not Docs RAG.
