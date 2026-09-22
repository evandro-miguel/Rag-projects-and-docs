# Use official Bun image as the base (matching current runtime)
FROM oven/bun:1.3.14

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock ./

# Install all dependencies, including @huggingface/transformers for ONNX reranking
RUN bun install --frozen-lockfile

# Use existing bun user (uid/gid 1000) as non-root rerunner; create /home/reranker
# for cache isolation under HOME=/home/reranker instead of the default /home/bun.
RUN mkdir -p /home/reranker/.cache/huggingface && \
    chown -R 1000:1000 /home/reranker && \
    chown -R 1000:1000 /app

# Runtime environment for the non-root user
ENV HOME=/home/reranker \
    HF_HOME=/home/reranker/.cache/huggingface \
    XDG_CACHE_HOME=/home/reranker/.cache

USER bun

# Source code and node_modules are handled via docker-compose:
# - ../../:/app  bind-mounts the project root (read-only for non-root)
# - /app/node_modules  anonymous volume keeps image-installed deps
#   (prevents host node_modules from shadowing this installation)
CMD ["bun", "run", "scripts/reranking-service.ts"]
