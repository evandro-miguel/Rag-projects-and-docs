# Threat model

This model covers the documented local alpha setup. It does not establish
security readiness for hosted or multi-tenant deployments.

## Assets and boundaries

| Asset | Boundary | Protection |
| --- | --- | --- |
| Database records | Operator and Postgres | Loopback binding, scoped credentials, backups |
| Repository files | Filesystem and indexer | Explicit roots, sensitivity checks, bounded scans |
| MCP tools | Agent and local runtime | Read-only default, guarded mutation tools |
| Embedding and reranker services | Local process and application | Explicit configuration, local endpoints |

## Threats and mitigations

- A local run could collide with another Compose project. The operations script
  checks project identity, ports, and target paths before setup.
- A repository could contain credentials or hostile, oversized files. Path
  filters, file policies, bounded scans, and review gates reduce exposure.
- A backup or restore path could target an unintended file. The local
  operations workflow canonicalizes paths and requires explicit restore
  confirmation.
- An HTTP endpoint could receive untrusted requests. MCP stdio is the primary
  agent path; experimental HTTP endpoints should remain on loopback.

## Residual risk

The alpha runs on operator-controlled hosts and trusts Docker, Bun, the local
embedding service, and upstream images. It does not provide hosted tenant
isolation or a separate key-management service. Review Compose and environment
configuration before each run.
