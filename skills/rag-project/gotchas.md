---
description: Project RAG failure modes, stale-index traps, and safe recovery steps.
metadata:
  tags: "project-rag, gotchas, freshness, ingestion, troubleshooting"
---

# Project RAG Gotchas

## Coverage Is Not Freshness

`verify_project_index` / `ragctl project verify` can report healthy coverage
while a specific file is stale or blocked. Read freshness and blocked coverage
before trusting indexed chunks.

## Project Not Found

Register first, keep the returned `projectId`, and reuse it in follow-up calls
when the slug is ambiguous.

## File Not Found

Usually means one of these:

- the path is outside `includeRoots`
- the file was blocked
- the file has not been ingested yet
- the path is wrong relative to project root

## Hybrid Or Vector Search Degraded

If embeddings fail, Project RAG reports degradation. For exact symbols and
paths, fall back to `rg`, outline, and symbol tools — not a fictional keyword
lane. `keyword` mode is deprecated and maps to hybrid.

## Deterministic Mode Is Not Implemented

Do not depend on `deterministic: true` as a public Project search lane. Use
exact local tools and symbol/outline APIs for graph-like navigation questions.

## Broad Scope Hurts Quality

Do not register the entire repository root and hope ignore rules will clean it
up later. Keep `includeRoots` intentional.

## Watchers Are Disabled

Do not expect MCP startup or read commands to refresh indexes via watchers.
Use explicit ingest or repair flows.

## Deprecated Alias

Do not build new flows on `search_project_docs`. Keep it only for compatibility.
Project Docs RAG is planned and must not reuse that name until it is versioned
or retired.
