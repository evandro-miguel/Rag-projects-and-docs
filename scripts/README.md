# Scripts

The `scripts/` directory contains CLI implementation, ingestion and sync
workflows, database migrations, evaluation suites, and local operations.

## Common entry points

- `bun run sync:external` synchronizes configured external documentation
  sources. Review source configuration and run database writes only against an
  isolated local database.
- `bun run ingest-project -- --root /path/to/project --include src,docs`
  indexes an explicitly scoped repository.
- `bun run eval:project-rag` evaluates Project RAG against configured local
  services.
- `bun run rag:start` and `bun run rag:stop` manage the local Compose stack.
- `./bin/ragctl` provides short-lived JSON reads.

For user workflows, see [Using Docs RAG](../docs/guides/using-docs-rag.md),
[Using Project RAG](../docs/guides/using-project-rag.md), and
[Using ragctl](../docs/guides/using-ragctl.md).
