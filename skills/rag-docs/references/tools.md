---
description: Full Docs RAG MCP and CLI surface grouped by purpose.
metadata:
  tags: "docs-rag, tools, mcp, search, ragctl"
---

# Docs RAG Tool Inventory

## CLI (preferred for ordinary reads)

| Command | Purpose |
| --- | --- |
| `ragctl docs search "<query>" --json` | External documentation search |
| `ragctl docs health --json` | Docs Postgres and source freshness |
| `ragctl docs sources list --json` | Discover registered sources and metadata |
| `ragctl health --json` | Platform readiness across Docs and Project |

Useful search filters:

```bash
./bin/ragctl docs search "<query>" \
  --limit 5 \
  --source <source-id> \
  --language <lang> \
  --kind official-docs \
  --authority official \
  --category <category> \
  --json
```

`--kind` examples: `official-docs`, `book`, `package-docs`, `repository-docs`.
`--authority` examples: `official`, `publisher`, `community-vetted`.

## Core MCP Docs Tools

- `search_docs` — external documentation search with optional filters
  (`sourceId`/`sourceIds`, `language`, `kind`, `authority`, `sourceTags`,
  categories, limit).
- `get_document` — full source retrieval by `sourcePath`.
- `list_categories` — discover available taxonomy.
- `health_check` — backend and reranker status.

## Adaptation Tools

- `adapt_docs` — adapt already retrieved content.
- `search_and_adapt` — one-shot search plus adaptation.

Available contexts:

- `code-focused`
- `architecture`
- `beginner`
- `senior`
- `quick-ref`

Adaptation uses deterministic local-only extraction. No external API keys are
required. Do not expect LLM rewriting quality from these tools.

## System Tool

- `ensure_reranker` — start or verify reranker availability when retrieval is
  degraded. This is a write-side local service start and requires
  `MCP_PERMISSION_MODE=read_write` when permission filtering is enabled.

## Retired Tools

Do not call these; they are retired from the stdio surface:

- `rate_result`
- `list_tags`
- `get_tag_info`
- `assign_tag`
- `remove_tag`
