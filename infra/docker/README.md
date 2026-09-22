# Docker infrastructure

Docker Compose provides local Postgres services and the optional reranker.
Embedding services are configured separately and are not part of these
Compose files.

## Local setup

Initialize the isolated local database configuration and review the resulting
settings:

```bash
bun run rag:init
```

The operations script binds database ports to loopback, generates an ignored
`.env.local`, and uses a distinct Compose project. CLI and MCP commands load
that same file automatically.

Start the separately configured embedding endpoint as described in the root
README, then run `bun run rag:doctor`.

## Compose files

- `compose.local.yml` defines the local Postgres plus optional worker and
  reranker profiles.

Run `docker compose config` with the intended environment before starting a
stack. Keep published endpoints bound to loopback for local evaluation.
