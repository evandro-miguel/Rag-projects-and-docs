#!/usr/bin/env bash
set -euo pipefail

# GPU-first launcher for the repository-scoped llama.cpp embedding endpoint.
# Keep this conservative: one slot and bounded context prevent indexing jobs
# from multiplying RAM/CPU pressure while still offloading model layers to GPU.

export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"

MODEL_PATH="${LLAMACPP_MODEL_PATH:-${EMBEDDING_MODEL_PATH:-}}"
LLAMA_SERVER_BIN="${LLAMACPP_SERVER_BIN:-}"

if [[ -z "$MODEL_PATH" ]]; then
  echo "Missing embedding model: set LLAMACPP_MODEL_PATH (or EMBEDDING_MODEL_PATH) to the GGUF path." >&2
  exit 64
fi
if [[ -z "$LLAMA_SERVER_BIN" ]]; then
  echo "Missing llama-server binary: set LLAMACPP_SERVER_BIN to the llama-server path." >&2
  exit 64
fi

LLAMA_SERVER_DIR="$(dirname "$LLAMA_SERVER_BIN")"
export LD_LIBRARY_PATH="$LLAMA_SERVER_DIR:/usr/local/cuda/targets/x86_64-linux/lib:/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}"
MODEL_ALIAS="${LLAMACPP_EMBEDDING_MODEL:-qwen3-embedding}"
HOST="${LLAMACPP_HOST:-127.0.0.1}"
PORT="${LLAMACPP_PORT:-8081}"
DEVICE="${LLAMACPP_DEVICE:-CUDA0}"
GPU_LAYERS="${LLAMACPP_N_GPU_LAYERS:-999}"
CTX_SIZE="${LLAMACPP_CTX_SIZE:-8192}"
PARALLEL="${LLAMACPP_PARALLEL:-1}"
BATCH_SIZE="${LLAMACPP_BATCH_SIZE:-1024}"
UBATCH_SIZE="${LLAMACPP_UBATCH_SIZE:-1024}"
FIT="${LLAMACPP_FIT:-off}"
POOLING="${LLAMACPP_POOLING:-mean}"

if [[ "$FIT" != "off" ]]; then
  echo "Refusing to start with LLAMACPP_FIT=$FIT; keep --fit off to avoid automatic CPU/RAM fallback." >&2
  exit 64
fi

case "$GPU_LAYERS" in
  auto|0|none)
    echo "Refusing to start with LLAMACPP_N_GPU_LAYERS=$GPU_LAYERS; use a positive count or 'all' for GPU offload." >&2
    exit 64
    ;;
esac

exec "$LLAMA_SERVER_BIN" \
  --embedding \
  --pooling "$POOLING" \
  --host "$HOST" \
  --port "$PORT" \
  --model "$MODEL_PATH" \
  --alias "$MODEL_ALIAS" \
  --device "$DEVICE" \
  --n-gpu-layers "$GPU_LAYERS" \
  --ctx-size "$CTX_SIZE" \
  --parallel "$PARALLEL" \
  --batch-size "$BATCH_SIZE" \
  --ubatch-size "$UBATCH_SIZE" \
  --fit "$FIT"
