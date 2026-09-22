---
doc_type: module-doc
id: "scripts-docs-sync"
status: legacy
created_at: "2026-02-25T00:00:00Z"
updated_at: "2026-03-20T00:00:00Z"
---

# Scripts docs-sync Module

`scripts/docs-sync/` is legacy documentation for the older multi-step sync
prototype. It is not the current operational entrypoint for Docs RAG source
sync.

The retired Docker Compose prototype was removed because its final ingest phase
was deliberately fail-fast and could not complete an operational sync.

## Current Entry Points

Use the root sync script and `ragctl`:

```bash
# List canonical sourceIds
./bin/ragctl docs sources list --json

# Sync one external Docs RAG source
bun run sync:external -- --source bun-docs

# Low-memory source sync under the 10 GB RAM budget
SYNC_EXTERNAL_EMBEDDING_BATCH_SIZE=2 \
SYNC_EXTERNAL_EMBEDDING_MAX_CONCURRENT_BATCHES=1 \
  bun run sync:external -- --source bun-docs

# Preview without mutating Postgres or processed docs
bun run sync:external -- --source bun-docs --dry-run

# Verify freshness and live retrieval
bun run health:docs-rag
bun run verify:docs-rag-live
```

The canonical source catalog lives in `scripts/sources.json` and
`scripts/lib/docs-source-registry.ts`.

## Operational Docs

- `docs/internal/project/docs-rag-source-ops.md`: source list, safe sync
  profile, health gates, and practical query checks.
- `docs/internal/project/external-sync-pipeline.md`: current pipeline behavior,
  safety gates, and memory bounds.
- `scripts/README.md`: root script map.

## Legacy Boundary

Do not use examples that reference `sync-docs.ts`, `--category`, or a
single-source legacy sync as current behavior. The current corpus has 14
registered sources and uses `sourceId` filters.
