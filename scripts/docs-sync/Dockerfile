# Use official Bun image as the base
FROM oven/bun:1.3.14-slim

# Install git for the synchronization script (Phase 1)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# The source code is mounted via docker-compose volume to /app
# Default command serves as a placeholder; overridden in docker-compose.yml
CMD ["bun", "run", "scripts/docs-sync/sync-docs.ts"]
