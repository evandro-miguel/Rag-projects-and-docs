#!/usr/bin/env bash
set -euo pipefail

# Qwen3-Embedding-0.6B is the bounded 1024D Project RAG lab lane. It keeps the
# same GPU-first safety checks as the default launcher, but runs on a separate
# port so it can be benchmarked against the 4096D endpoint.

: "${LLAMACPP_EMBEDDING_MODEL:=qwen3-embedding-1024}"
: "${LLAMACPP_PORT:=8082}"
: "${LLAMACPP_BASE_URL:=http://127.0.0.1:${LLAMACPP_PORT}}"
: "${LLAMACPP_CTX_SIZE:=4096}"
: "${LLAMACPP_BATCH_SIZE:=256}"
: "${LLAMACPP_UBATCH_SIZE:=128}"
: "${LLAMACPP_POOLING:=last}"

if [[ -z "${LLAMACPP_MODEL_PATH:-}" ]]; then
  echo "Missing 1024D model path: set LLAMACPP_MODEL_PATH to the Qwen3-Embedding-0.6B-Q8_0.gguf path." >&2
  exit 66
fi

export LLAMACPP_MODEL_PATH
export LLAMACPP_EMBEDDING_MODEL
export LLAMACPP_PORT
export LLAMACPP_BASE_URL
export LLAMACPP_CTX_SIZE
export LLAMACPP_BATCH_SIZE
export LLAMACPP_UBATCH_SIZE
export LLAMACPP_POOLING

if [[ ! -f "$LLAMACPP_MODEL_PATH" ]]; then
  echo "Missing 1024D GGUF at $LLAMACPP_MODEL_PATH" >&2
  echo "Download Qwen3-Embedding-0.6B-Q8_0.gguf from Qwen/Qwen3-Embedding-0.6B-GGUF first." >&2
  exit 66
fi

exec bash scripts/start-llamacpp-embedding-gpu.sh
