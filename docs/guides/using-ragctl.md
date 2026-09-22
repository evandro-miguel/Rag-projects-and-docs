# Using ragctl

`ragctl` is a short-lived CLI for Docs RAG and Project RAG reads. It emits JSON
for scripts and agents without requiring a resident MCP session.

## Run from this checkout

```bash
./bin/ragctl health --json
./bin/ragctl docs health --json
./bin/ragctl docs sources list --json
./bin/ragctl docs search "Bun.serve routes" --limit 5 --json
./bin/ragctl project search --project my-project "search implementation" --json
```

From another repository, call the executable by its checkout path:

```bash
/path/to/rag-v2/bin/ragctl health --json
```

## Configuration

The CLI reads explicit environment overrides first. Set `RAG_CONFIG_DIR` to a
directory containing the local `.env.local` file when configuration is kept
outside the checkout. When unset, repository-relative configuration is used
where available. Keep credential files out of version control.

```bash
RAG_CONFIG_DIR=/path/to/rag-config \
  ./bin/ragctl docs health --json
```

## Command behavior

| Command | Purpose | Side effects |
| --- | --- | --- |
| `health` | Check configured RAG services | None |
| `docs search` | Search external documentation | May contact the configured embedding service |
| `project search` | Search indexed repository code | May contact the configured embedding service |
| `project file`, `outline`, `symbol`, `verify` | Read indexed project data | None |
| `project prepare` | Reconcile and verify one selected project | Bounded index updates for that project |

Ordinary read commands do not refresh indexes or start watchers. Preparation is
explicit, scope-bound, and may report `ready`, `partial`, `blocked`, or
`failed`. Registration and direct ingestion are available through the MCP and
script interfaces with explicit write controls.

See [Using Project RAG](using-project-rag.md) for preparation and indexing
details.
