# RAG Projects and Docs

A personal RAG for coding agents, running on your own machine. It has two divisions:

- **Docs** is where an agent looks up upstream technical documentation with semantic search.
- **Projects** is where an agent looks up the code of a repository you registered.

Both are reached through the MCP server (`bun run mcp`) or the short-lived CLI (`./bin/ragctl`). Docs search uses `search_docs`. Project search uses `search_project_code`. The npm package stays private. This repository is a local alpha, for evaluation on one machine.

## Docs

Docs exists so an agent can consult current documentation instead of answering from a training cutoff that has gone stale.

Search embeds the question and compares it with the indexed pages. A hit keeps the source path, title, section, score, and freshness, and the agent is expected to cite that page.

The source list in `scripts/sources.json` has 24 upstream sets. Twenty-three are marked official, including Bun, TypeScript, React, Go, Python, Docker, and pgvector. One Go book is marked community-vetted. A refresh follows that list, pulls the upstream pages, updates the documents that changed, and writes their embeddings in the same run.

```bash
bun run sync:external -- --source bun-docs --dry-run
bun run sync:external -- --source bun-docs
./bin/ragctl docs search "Bun.serve routes" --source bun-docs --limit 5 --json
```

Refresh one source at a time unless a measured run shows room for more. Search only reads.

The full source table, filters, and freshness checks are in [Using Docs RAG](docs/guides/using-docs-rag.md).

## Projects

Projects indexes one selected repository: files, chunks, symbols, embeddings, and graph hints. The default search mode is `hybrid`. A `vector` request currently uses that same Postgres hybrid path and reports the degradation.

Registering a repository and reconciling deletions stay explicit commands of their own. Search only reads.

```bash
./bin/ragctl projects list --json
./bin/ragctl project search --project my-project "search implementation" --json
./bin/ragctl project prepare --root /path/to/project \
  --include-root src --max-files 120 --max-batches 32 \
  --timeout-ms 120000 --json
```

Local README and docs files inside a repository are a planned third surface. In this alpha, `search_project_docs` is still an alias of project code search. See [Project Docs RAG status](docs/guides/using-project-docs-rag.md).

## Requirements

- Bun 1.3.14 or newer.
- Docker with Compose, for the local Postgres database.
- `llama-server` from llama.cpp, and an embedding GGUF, for vector and hybrid search.

## Clone and start

```bash
git clone https://github.com/evandro-miguel/Rag-projects-and-docs.git
cd Rag-projects-and-docs
bun install --frozen-lockfile
bun run rag:init
```

`bun run rag:init` writes an ignored `.env.local` that the CLI and MCP load automatically, starts an isolated Compose project, binds Postgres to loopback, and applies the Docs and Projects migrations. Review the output before using the stack.

The embedding server stays outside Docker. In another terminal:

```bash
export LLAMACPP_SERVER_BIN=/absolute/path/to/llama-server
export LLAMACPP_MODEL_PATH=/absolute/path/to/embedding-model.gguf
bun run embeddings:gpu:1024
```

That command listens on `127.0.0.1:8082`, publishes the alias `qwen3-embedding-1024`, and uses last-token pooling. Change the `LLAMACPP_*` variables when the model or the machine needs different values.

Then check the local database:

```bash
bun run rag:doctor
./bin/ragctl health --json
./bin/ragctl docs sources list --json
```

`doctor` checks the isolated database and its migrations. The embedding endpoint remains the host process started above.

Use `bun run rag:start`, `bun run rag:stop`, and `bun run rag:status` for the same isolated stack. The public repository has one Compose lifecycle.

## Benchmarks

Retrieval benchmarks run against local Postgres and a local embedding provider. Their saved pass bars are below. One archived run also has measured times, and that run is the TypeScript compiler, not a search benchmark.

### Recorded run: TypeScript typecheck

Run `260711_075200_typescript-typecheck_deep` on 2026-07-11, status pass. Machine: WSL2, Intel Core i9-14900K, Bun 1.3.14, Node 26.3.1. Method: Hyperfine 1.20.0, warm filesystem, a fresh compiler process each time, incremental cache disabled, two warmups and six measured runs per arm, both command orders. Source commit `e4d220428771` in a dirty worktree. This measures full no-emit typecheck of this repository.

| Compiler | Mean | Median | P95 | Std dev | Range |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript 6.0.3 | 3,356.1 ms | 3,294.3 ms | 3,723.7 ms | 184.4 ms | 3,235.0–3,723.7 ms |
| TypeScript 6.0.3 with `stableTypeOrdering` | 3,427.2 ms | 3,416.6 ms | 3,489.1 ms | 39.6 ms | 3,375.3–3,489.1 ms |
| TypeScript 7.0.2 native | 397.1 ms | 398.8 ms | 414.7 ms | 15.1 ms | 373.4–414.7 ms |

TypeScript 7 was 8.45× faster than TypeScript 6, which is 88.17% less time. Against TypeScript 6 with stable ordering it was 8.63× faster, 88.41% less time. Stable ordering itself added 2.12% over plain TypeScript 6. There is no earlier baseline for this run, and a GitHub-hosted runner can differ.

### Docs health

Command: `bash scripts/rag-ops.sh eval-docs`, which runs `scripts/eval/run-docs-rag-health.sh`.

The search sample is five repetitions of three fixed queries. A pass also requires a healthy isolated database, every expected source id present, and one chunk embedding for every serving chunk.

| Measurement | Pass bar |
| --- | ---: |
| Hit rate | ≥ 0.95 |
| Recall | ≥ 0.95 |
| MRR | ≥ 0.80 |
| Citation-path rate | ≥ 0.80 |
| Duplicate-path share | ≤ 0.30 |
| Search latency p95 | ≤ 1,500 ms |

### Docs retrieval profiles

Defined in `scripts/eval/thresholds.ts`. The eval runner uses the target row by default. Latency is in seconds.

| Profile | Hit rate | nDCG | MRR | Latency p95 |
| --- | ---: | ---: | ---: | ---: |
| Minimum | 0.85 | 0.80 | 0.75 | 2.0 s |
| Target | 0.90 | 0.85 | 0.80 | 1.5 s |
| Stretch | 0.93 | 0.88 | 0.84 | 1.2 s |

Answer-quality targets in the same file (context precision, context recall, faithfulness, answer correctness, answer relevancy) are recorded for later live suites. The current retrieval runner does not enforce them.

### Project evaluation

Command: `bun run eval:project-rag`. The default profile is target.

| Measurement | Pass bar |
| --- | ---: |
| Hit rate | ≥ 0.88 |
| Exact path | ≥ 0.85 |
| Exact symbol | ≥ 0.75 |
| Exact line | ≥ 0.65 |
| MRR | ≥ 0.75 |
| nDCG@10 | ≥ 0.80 |
| Average quality | ≥ 0.80 |
| Contamination | ≤ 0.02 |
| Latency p95 | ≤ 1,550 ms |

Minimum and stretch profiles are in the same thresholds file. Stretch lowers the latency bar to 900 ms and the contamination bar to 0.

### Project search latency

Command: `bun run bench:project-search`.

Readiness mode measures at least 30 samples, with 2 warmups and 10 iterations by default. It fails when p95 exceeds 1,550 ms, when a sample has no hit, when context is stale, when ranking falls back to lexical search, or when an expected path ranks worse than 3. Smoke mode is smaller and stays ineligible for a release pass.

### MCP call budgets

Live budgets in `scripts/eval/thresholds.ts` include Postgres and the local services.

| Category | p50 | p95 | p99 | Memory |
| --- | ---: | ---: | ---: | ---: |
| Search | 600 ms | 1,500 ms | 2,500 ms | 150 MB |
| Ingestion | 1,500 ms | 5,000 ms | 8,000 ms | 300 MB |
| System | 50 ms | 250 ms | 500 ms | 75 MB |
| Analysis | 150 ms | 600 ms | 1,200 ms | 150 MB |
| Enhancement | 2,000 ms | 5,000 ms | 8,000 ms | 200 MB |

Stdio concurrency p95 is 1,750 ms for the standard case and 6,000 ms with 10 workers. `bun run bench:codex-mcp` records success, elapsed time, fallback, and failed MCP calls for the fixture service, with a 240 s allowance on the packaged command. That command has no archived score.

### Embedding profiles

`bun run bench:docs-rag-real` and `bun run bench:project-embedding-profiles:real` compare two already-running providers:

| Profile | Model lane | Dimensions |
| --- | --- | ---: |
| `qwen3-0.6b-1024` | Qwen3-Embedding 0.6B | 1,024 |
| `qwen3-8b-4096` | Qwen3-Embedding 8B | 4,096 |

The Docs run records hit rate, top-1 path rate, MRR, nDCG@10, query-embedding p95, and ranking p95. Its defaults are top 5, a 10 s endpoint timeout, at most 8 chunks per document, and embedding batches of 16. It embeds a small corpus for the measurement and does not rebuild the installed index.

`bun run bench:project-embedding-profiles` is the light form. It uses deterministic hashed vectors on small fixtures, so it checks lane and scoring wiring. It is not a quality score for the real model.

### Reranker dtypes

Command: `bun run bench:reranker-dtypes`. Scenario: [reranker dtype comparison](docs/benchmarks/scenarios/active/reranker-dtype-comparison.scenario.md).

Both arms use `Xenova/ms-marco-MiniLM-L-6-v2` on four fixed queries and six documents per query. A pass requires zero request or inference errors, top-1 accuracy of 1 on both `q8` and `fp32`, and mean Spearman rank correlation of at least 0.95. The comparison metric is warm-cache request latency. Setup time is diagnostic because it follows the model cache. No latency number from this scenario is archived.

### Retired system benchmark

`bun run bench:system` records a retired status. It used to measure a Convex runtime. The replacements are `bun run bench:docs-rag-real`, `bun run bench:codex-mcp`, `bun run eval:mcp-live`, and `bun run eval:project-rag`.

## Validation

```bash
bun run lint
bun run typecheck
bun run test
```

Hosted CI runs those three checks. Postgres, embedding, and GPU gates stay on a machine that has those services. A green unit run is not evidence that retrieval is ready.

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
