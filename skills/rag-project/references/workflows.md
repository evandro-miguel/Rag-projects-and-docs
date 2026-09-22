---
description: Practical Project RAG workflows for registration, ingestion, and freshness-aware retrieval.
metadata:
  tags: "project-rag, workflows, registration, ingestion, freshness, ragctl"
---

# Project RAG Workflows

## Registration (CLI preferred)

1. Confirm absence or staleness:

   ```bash
   ./bin/ragctl projects list --json
   ./bin/ragctl project verify --project <slug-or-id> --json
   ```

2. Dry-run scope from the RAG checkout:

   ```bash
   bun run ingest-project --root <absolute-repo-path> --include src,docs,tests --dry-run
   ```

3. Ingest without `--dry-run` when scope is correct.
4. Capture `projectId` / slug and verify again.
5. Record the Project RAG identity in the consumer repo `AGENTS.md`.

## Registration (MCP, write-enabled)

1. Call `register_project` with absolute `rootPath` and explicit `includeRoots`.
2. Confirm scope with `scopeAck=I_UNDERSTAND_PROJECT_RAG_SCOPE_V1`.
3. Optionally replace blocked-finding allowlist only with
   `replaceBlockedFindingAllowlist=true`.
4. Run `ingest_project` or `ingest_project_file`.
5. Run `verify_project_index` or `ragctl project verify`.

Example:

```text
register_project(
  name="consumer-app",
  rootPath="<absolute-repository-path>",
  includeRoots=["src", "docs", "tests"],
  scopeAck="I_UNDERSTAND_PROJECT_RAG_SCOPE_V1"
)
```

## Local Ingestion

- Broad refresh: `bun run ingest-project --project <slug>`
- Ad hoc root: `bun run ingest-project --root <absolute-path> --include lib,mcp,scripts,docs`
- First pass safety: add `--dry-run`
- One-file repair: MCP `ingest_project_file` or the matching repair script path

Prefer the CLI for broad local maintenance so root path and scope stay explicit.

## Retrieval Ladder

1. `rg` / `fd` for exact identifiers and paths.
2. `ragctl project verify` when index trust matters.
3. `ragctl project search --mode hybrid` or MCP `search_project_code`.
4. `ragctl project outline --file ...` or `find_project_symbol`.
5. `find_symbol_references` for orientation only.
6. `ragctl project file --file ...` or `get_project_file` / `get_project_skeleton`.
7. Semantic navigation or analysis tools if you need repo shape.

## Freshness Check

Use this when indexed content looks wrong:

1. Run `ragctl project verify --project <slug-or-id> [--full] --json` or
   `verify_project_index(projectId)`.
2. Read freshness, blocked files, and coverage separately.
3. Inspect the file with `ragctl project file --file <path> --json` or
   `get_project_file`.
4. If stale or missing, run `ingest_project_file` or bounded project ingestion.
5. Cross-check with `rg` when you need exact working-tree truth.
