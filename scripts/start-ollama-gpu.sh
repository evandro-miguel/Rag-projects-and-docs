#!/bin/bash
set -euo pipefail

cat >&2 <<'MSG'
scripts/start-ollama-gpu.sh is deprecated and unsupported.

This repository no longer starts a global Ollama daemon for embeddings.
Do not use Ollama as an alternate embedding path.
Use a RAG-scoped llama.cpp embedding server instead, for example:

  bun run embeddings:gpu

For the bounded 1024D lab lane:

  bun run embeddings:gpu:1024

Then validate with:

  bun run health:embeddings
MSG

exit 1
