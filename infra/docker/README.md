# Docker infrastructure

Docker Compose provides local Postgres services and the optional reranker.
Embedding services are configured separately and are not part of these
Compose files.

## Local setup

Initialize the isolated local database configuration and review the resulting
settings:

```bash
bash scripts/rag-ops.sh init
```

The operations script binds database ports to loopback and uses a distinct
Compose project. Configure `POSTGRES_PASSWORD` through the generated ignored
environment file or a secret manager; do not put credentials in tracked files.

Start the separately configured embedding endpoint as described in the root
README, then run `bash scripts/rag-ops.sh doctor`. The older `bun run rag:start`
command manages `compose.yml` or `compose.dev.yml`; it is separate from the
isolated `rag-ops.sh` workflow.

Use `compose.dev.yml` for a separate development database. Do not reuse a
volume that contains data you need to preserve.

## Compose files

- `compose.yml` defines the local Postgres and optional reranker services.
- `compose.dev.yml` defines an isolated development Postgres service.
- `compose.local.yml` provides the local evaluation profile.

Run `docker compose config` with the intended environment before starting a
stack. Keep published endpoints bound to loopback for local evaluation.
