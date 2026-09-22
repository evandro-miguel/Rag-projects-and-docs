# Using Project RAG

Project RAG searches registered repository code and approved maps. It stores
project-scoped files, chunks, symbols, embeddings, and graph information.

## Read and search

```bash
./bin/ragctl projects list --json
./bin/ragctl project search --project my-project "search implementation" --json
./bin/ragctl project file --project my-project --file src/search.ts --json
./bin/ragctl project outline --project my-project --file src/search.ts --json
./bin/ragctl project verify --project my-project --json
```

`hybrid` is the default search mode. `vector` expresses semantic intent, but
the current Postgres backend may use hybrid retrieval and reports that
degradation. The deprecated `search_project_docs` name remains an alias for
Project RAG code search. Exact symbol and file navigation is also available
through the CLI and MCP tools.

## Prepare one project

Reads do not mutate an index. To reconcile and verify one selected project,
invoke the bounded preparation command explicitly:

```bash
./bin/ragctl project prepare --root /path/to/project \
  --include-root src --max-files 120 --max-batches 32 \
  --timeout-ms 120000 --json
```

For a new project, choose the intended relative source roots. Existing
registrations retain their configured scope. Preparation uses the configured
Postgres and embedding services; incomplete readiness or deletion evidence
returns a structured blocked or partial result without claiming success.

MCP defaults to read-only permission. Registration and ingestion require an
explicit write-enabled configuration and project scope acknowledgement.

## Check index quality

```bash
bun run health:embeddings:project -- --readiness-only
bun run eval:project-rag
bun run verify:project-rag
```

The evaluation uses a configured database and embedding service. Run it only
with isolated evaluation resources. Local unit tests do not prove that live
providers or databases are ready.

Project Docs RAG for local README and documentation files is planned; see
[its current status](using-project-docs-rag.md).
