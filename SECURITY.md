# Security policy

RAG-v2 is a public, self-hosted alpha intended for local evaluation. The
supported boundary is the documented local setup; hosted, multi-tenant,
public-network, and production deployments are not validated by this project.

## Safe operation

- Keep databases and experimental HTTP endpoints bound to loopback.
- Store local credentials in ignored environment files or a secret manager.
- Scope repository indexing to the intended source paths and avoid indexing
  credentials, private data, generated output, or dependency folders.
- Redact logs and indexed content before sharing diagnostic details.

## Reporting a vulnerability

Report security issues through the repository's
[private GitHub security advisory form](https://github.com/evandro-miguel/rag-v2/security/advisories/new)
rather than a public issue. Include the affected version or commit, impact,
preconditions, and a minimal reproduction. Do not include tokens, passwords,
connection strings, private keys, database dumps, or unredacted indexed data.

No response-time or remediation service level is promised for this alpha.

See [the threat model](THREAT-MODEL.md) and
[dependency security guidance](DEPENDENCY-SECURITY.md) for related policies.
