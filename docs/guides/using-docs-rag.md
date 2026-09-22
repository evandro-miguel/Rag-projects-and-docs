---
doc_type: guide
id: "using-docs-rag"
theme: "docs-rag-operations"
status: active
created_at: "2026-03-25T00:00:00Z"
updated_at: "2026-08-29T00:00:00Z"
---

# Using Docs RAG

Docs RAG searches external technical documentation. It does not index local
repository documentation.

## Read-Only Search

```bash
./bin/ragctl docs health --json
./bin/ragctl docs sources list --json
./bin/ragctl docs search "Bun.serve routes" --limit 5 --json
./bin/ragctl docs search "Go contexts" --language go --authority official --json
```

The MCP compatibility surface uses `search_docs` with the same source registry
and Postgres-backed retrieval contract.

## Source Filters

Docs search supports source identity, language, kind, authority, and category
filters. Prefer these over retired MCP tag tools (`list_tags`, `assign_tag`,
and related). Explicit filters apply before or during ranking when supported.
Results retain source path, title, section, score, freshness, and normalized
source metadata.

## Freshness And Validation

```bash
bun run health:docs-rag -- --strict
bun run eval:docs-live
bun run eval
bun run verify:docs-rag-live
```

Use this order: strict freshness, the 27-case live retrieval fixture, the full
corpus/latency/resource harness, and the single answer-specific smoke. The
fixture gates hit rate, recall, MRR, citation-path rate, and duplicate-path
share. The full harness repeats those checks and proves isolated container,
coverage, and resource boundaries. `verify:docs-rag-live` additionally requires
complete provenance and a revision-bound canonical citation for the answer.

All three commands require the configured Docs RAG Postgres and embedding lane.
A missing or degraded service is not passing evidence. Hosted CI is optional;
local executable evidence is canonical.

`bun run eval:docs-live` retains source-scoped and unscoped hybrid metrics and
exits non-zero when either scope's hit rate, recall, MRR, citation, or diversity
threshold regresses.

## External Documentation Providers

The canonical upstream repository, branch, and docs root live in
`scripts/sources.json`. Retrieval metadata and aliases live in
`scripts/lib/docs-source-registry.ts`. Change both surfaces together.

The React source includes the `reference/react-dom/` reference pages, including
`useFormStatus`; noisy `blog/` material remains excluded. Every source refresh
must preserve the source revision, canonical URL, freshness timestamp, and
empty `missingFields` for published results.

| Source ID | Provider | Branch | Upstream docs root |
| --- | --- | --- | --- |
| `components` | Tailwind CSS | `main` | `src/docs` |
| `tanstack` | TanStack Router | `main` | `docs/router` |
| `react-docs` | React | `main` | `src/content` |
| `zod-docs` | Zod | `main` | `packages/docs/content` |
| `python-docs` | Python | `main` | `Doc` |
| `typescript-docs` | TypeScript | `v2` | `packages/documentation/copy/en` |
| `bun-docs` | Bun | `main` | `docs` |
| `uv-docs` | uv | `main` | `docs` |
| `fastapi-docs` | FastAPI | `master` | `docs/en/docs` |
| `zustand-docs` | Zustand | `main` | `docs` |
| `react-router-docs` | React Router | `main` | `docs` |
| `docker-docs` | Docker | `main` | `content` |
| `go-docs` | Go | `master` | `_content/doc` |
| `go-books` | Learn Go with Tests | `main` | repository root |
| `pgvector-docs` | pgvector | `master` | `README.md` |
| `mcp-docs` | Model Context Protocol | `main` | `docs` |
| `vitest-docs` | Vitest | `main` | `docs` |
| `biome-docs` | Biome | `main` | `src/content/docs/en` |
| `tanstack-query-docs` | TanStack Query | `main` | `docs/framework/react` |
| `playwright-docs` | Playwright | `main` | `nodejs/docs` |
| `vite-docs` | Vite | `main` | `docs` |
| `hono-docs` | Hono | `main` | `docs` |
| `pydantic-docs` | Pydantic | `main` | `docs/concepts` |
| `supabase-database-docs` | Supabase DB | `master` | See manifest |

Use a source ID, not a category, to target one provider:

```bash
./bin/ragctl docs search "ReadableStream direct stream" \
  --source bun-docs --limit 5 --json

bun run sync:external -- --source bun-docs --dry-run
```

Refresh one provider at a time unless measured resources justify a larger run.
The sync rejects empty, include-only, redirect-only, control-character-only,
and other non-semantic processed artifacts. It reprocesses invalid cache
entries even when the raw hash is unchanged, and atomically replaces a cached
file only after content and chunk validation pass.

Docs and Project RAG use the configured embedding provider. Set the endpoint,
model, and expected dimensions for the selected lane, then verify provider
health before retrieval. The project does not prescribe a host service name.

When adding a provider or widening a source path, add a scoped live case to
`scripts/docs-rag/fixtures/eval-external-sources.json`. A freshness timestamp
alone is insufficient: content integrity, chunks, embeddings, freshness, and
live hybrid retrieval must all pass.

For an agent research answer, cite the returned `sourcePath` and
revision-bound `canonicalUrl`; use only the returned content for claims. Do not
promote keyword-only or degraded-provenance results to an answer.

The smoke command never substitutes for the full release gate. **Gemini-powered
adaptation is retired.** The `adapt_docs` and `search_and_adapt` MCP tools now
perform deterministic local-only extraction — no external API keys required.
They remain discoverable for backward compatibility but should be replaced by
subagent-based file processing for production needs.

## Ingestion Boundary

External source synchronization may add many legitimate documents. It follows
the source manifest, source-specific budgets, sensitivity checks, and scoped
cleanup. It does not inherit the Project RAG code-inventory `25%`/`500` review
threshold unchanged.

## Project Documentation

Local README files and project documentation belong to planned Project Docs
RAG. That surface will be separate from external Docs RAG and Project RAG code.

See [Using Project Docs RAG](./using-project-docs-rag.md).
