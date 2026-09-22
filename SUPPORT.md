# Support policy

This alpha supports reproducible local evaluation with Bun and Docker Compose.
It does not promise hosted availability, native Windows operation, public
network exposure, or production data recovery.

## Before asking for help

Run these checks and redact their output:

```bash
bash scripts/rag-ops.sh doctor
bash scripts/rag-ops.sh status
bun --version
docker compose version
```

Include the alpha version, operating-system and runtime versions, the failing
command, and a short redacted error. Do not share credentials, full connection
strings, database dumps, indexed content, or unredacted logs.

For security-sensitive reports, follow [SECURITY.md](SECURITY.md). For
contribution workflow, see [CONTRIBUTING.md](CONTRIBUTING.md).
