#!/bin/bash
# Configure WSL GPU environment for the RAG-scoped llama.cpp embedding server.
# Source this file before starting llama-server when the shell does not already
# expose the WSL CUDA libraries.

export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
export LD_LIBRARY_PATH="/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}"

echo "GPU environment configured for llama.cpp:"
echo "   CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES"
echo "   LD_LIBRARY_PATH includes /usr/lib/wsl/lib"
echo "Start the repository embedding endpoint with:"
echo "   bun run embeddings:gpu"
echo "or the bounded 1024D lab endpoint with:"
echo "   bun run embeddings:gpu:1024"
