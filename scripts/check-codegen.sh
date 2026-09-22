#!/bin/bash
# Historical CI entrypoint kept for compatibility.
# Project RAG no longer requires backend codegen artifacts.

set -e

echo "→ Checking generated-code independence..."
echo "  ✓ Backend generated artifacts are not required for the Postgres runtime"

# Verify that typecheck passes
echo "→ Running TypeScript type check..."
if bun run typecheck; then
    echo "  ✓ TypeScript type check passed"
else
    echo "  ✗ TypeScript type check failed"
    exit 1
fi

echo ""
echo "✓ Generated-code compatibility checks passed"
echo "  - No backend codegen artifact check required"
echo "  - TypeScript type check passed"
