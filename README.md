# RAG Projects and Docs

RAG Projects and Docs is a public, self-hosted alpha for retrieving external technical
documentation and repository code through Postgres, local embeddings, a short-
lived CLI, and MCP. It is intended for local evaluation; hosted-service and
production-readiness claims are outside this alpha.

The npm package remains private and is not published.

## Requirements

- Bun 1.3.14 or newer.
- Docker with Compose for local Postgres services.
- `llama-server` from llama.cpp and a compatible embedding GGUF model for
  vector and hybrid search.

## Clone and start

```bash
git clone https://github.com/evandro-miguel/Rag-projects-and-docs.git
cd Rag-projects-and-docs
bun install --frozen-lockfile
bash scripts/rag-ops.sh init
```

The local operations script creates an ignored environment file and uses an
isolated Compose project with loopback-bound database ports. Review its output
before starting services. The embedding provider is separate from the Docker
stack. Start the default 1024-dimensional lane in another terminal:

```bash
export LLAMACPP_SERVER_BIN=/absolute/path/to/llama-server
export LLAMACPP_MODEL_PATH=/absolute/path/to/embedding-model.gguf
bun run embeddings:gpu:1024
```

The launcher binds to `127.0.0.1:8082`, publishes the model alias
`qwen3-embedding-1024`, and uses last-token pooling by default. Override its
`LLAMACPP_*` variables when your model or hardware requires different values.
Once the endpoint is ready, validate the local stack:

```bash
bash scripts/rag-ops.sh doctor
```

Use the repository CLI for short-lived reads:

```bash
./bin/ragctl health --json
./bin/ragctl docs sources list --json
./bin/ragctl docs search "Bun.serve routes" --limit 5 --json
./bin/ragctl project search --project my-project "search implementation" --json
```

Start the MCP stdio server with `bun run mcp`.

## Retrieval surfaces

Docs RAG searches external technical documentation. Project RAG searches
registered repository code and approved maps. Project search supports `hybrid`
and `vector` intent; the current Postgres backend may execute hybrid retrieval
for both and reports that degradation. The deprecated `search_project_docs`
tool name remains an alias for Project RAG code search.

Project Docs RAG for local repository documents is planned and is not an
implemented search surface in this alpha.

Ordinary reads do not mutate indexes. Project preparation is an explicit,
bounded operation for one selected repository. It preserves the registered
scope and requires complete snapshot evidence before reconciling deletions.

## Validation

```bash
bun run lint
bun run typecheck
bun run test
```

Provider-backed retrieval and database integration checks need the matching
local services. Passing local unit checks alone does not establish hosted,
provider, or production readiness.

## Documentation and policies

- [Documentation hub](docs/README.md)
- [Using Docs RAG](docs/guides/using-docs-rag.md)
- [Using Project RAG](docs/guides/using-project-rag.md)
- [Using ragctl](docs/guides/using-ragctl.md)
- [Project Docs RAG status](docs/guides/using-project-docs-rag.md)
- [MCP server](mcp/README.md)
- [Docker infrastructure](infra/docker/README.md)
- [Security policy](SECURITY.md)
- [Dependency security](DEPENDENCY-SECURITY.md)
- [Support policy](SUPPORT.md)
- [Threat model](THREAT-MODEL.md)
- [Third-party notices](THIRD-PARTY-NOTICES.md)
- [Contributing](CONTRIBUTING.md)
- [Public surface and exclusions](PUBLIC-SURFACE.md)

## License

MIT
