#!/bin/bash
#
# @module scripts/status-rag
# @description Check status of all RAG services
#

set -u

overall_status=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TSX_BIN="$PROJECT_ROOT/node_modules/.bin/tsx"
SINK="$(mktemp)"
DEV_ENV_FILE="$PROJECT_ROOT/.env.dev.local"
trap 'rm -f "$SINK"' EXIT

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
STACK="prod"
for arg in "$@"; do
    case $arg in
        --stack=prod|--prod) STACK="prod" ;;
        --stack=dev|--dev) STACK="dev" ;;
        --stack=both|--both) STACK="both" ;;
        --help|-h)
            echo "Usage: ./scripts/status-rag.sh [--stack=prod|dev|both] [--prod|--dev|--both]"
            exit 0
            ;;
        *) ;;
    esac
done

read_project_env_value() {
    local key=$1
    local file=$2

    [ -f "$file" ] || return 1
    awk -F= -v key="$key" '
        $1 == key {
            value = substr($0, index($0, "=") + 1)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            gsub(/^'\''|'\''$/, "", value)
            gsub(/^"|"$/, "", value)
            print value
        }
    ' "$file" | tail -n 1
}

env_or_project_file() {
    local key=$1
    local fallback=$2
    local value="${!key:-}"

    if [ -z "$value" ] && [ -f "$DEV_ENV_FILE" ]; then
        value="$(read_project_env_value "$key" "$DEV_ENV_FILE" || true)"
    fi

    printf "%s" "${value:-$fallback}"
}

DEV_STACK_PREFIX="$(env_or_project_file COMPOSE_PROJECT_NAME "rag-v2-dev")"
DEV_POSTGRES_NAME="${DEV_STACK_PREFIX}-postgres-dev"
DEV_POSTGRES_PORT="$(env_or_project_file RAG_DEV_POSTGRES_PORT "5441")"

check_port() {
    local port=$1
    local name=$2

    if curl -s --connect-timeout 1 "http://localhost:$port" >"$SINK" 2>&1 || \
       curl -s --connect-timeout 1 "http://localhost:$port/health" >"$SINK" 2>&1 || \
       curl -s --connect-timeout 1 "http://localhost:$port/version" >"$SINK" 2>&1 || \
       nc -z localhost "$port" >"$SINK" 2>&1; then
        printf "%-25s ${GREEN}✓ Running${NC} (port %s)\n" "$name" "$port"
        return 0
    else
        printf "%-25s ${RED}✗ Stopped${NC} (port %s)\n" "$name" "$port"
        return 1
    fi
}

check_reranker_health() {
    local port=$1
    local name=$2
    local health

    if ! health=$(curl -fsS --connect-timeout 1 "http://localhost:$port/health" 2>"$SINK"); then
        printf "%-25s ${RED}✗ Stopped${NC} (port %s)\n" "$name" "$port"
        return 1
    fi

    if printf '%s' "$health" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"healthy"' && \
       printf '%s' "$health" | grep -Eq '"service"[[:space:]]*:[[:space:]]*"reranking-service"'; then
        printf "%-25s ${GREEN}✓ Running${NC} (port %s)\n" "$name" "$port"
        return 0
    fi

    printf "%-25s ${RED}✗ Unhealthy${NC} (port %s)\n" "$name" "$port"
    return 1
}

check_docker() {
    local name=$1
    local state
    local health

    state=$(docker inspect "$name" --format='{{.State.Status}}' 2>"$SINK" || echo "not_found")
    health=$(docker inspect "$name" --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>"$SINK" || echo "not_found")

    if [ "$health" = "healthy" ]; then
        printf "%-25s ${GREEN}✓ Healthy${NC}\n" "$name"
        return 0
    elif [ "$state" = "running" ] && [ "$health" = "none" ]; then
        printf "%-25s ${GREEN}✓ Running${NC} (no healthcheck)\n" "$name"
        return 0
    elif [ "$state" = "running" ]; then
        printf "%-25s ${YELLOW}⚠ Running${NC} (health: %s)\n" "$name" "$health"
        return 1
    else
        printf "%-25s ${RED}✗ Stopped${NC}\n" "$name"
        return 1
    fi
}

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$STACK" = "dev" ]; then
    echo "                   RAG DEV Stack Status (separate)             "
elif [ "$STACK" = "both" ]; then
    echo "                RAG Stack Status (prod + dev)                "
else
    echo "                      RAG Services Status                    "
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""

if [ "$STACK" = "dev" ] || [ "$STACK" = "both" ]; then
    echo "  Dev stack is separate and not part of the normal startup cycle."
    echo "  Dev stack prefix: ${DEV_STACK_PREFIX}; PostgreSQL port: ${DEV_POSTGRES_PORT}."
    echo ""
fi

printf "%-25s %s\n" "Component" "Status"
printf "%-25s %s\n" "---------" "------"
echo ""

if [ "$STACK" = "prod" ] || [ "$STACK" = "both" ]; then
    # Prod Docker containers
    check_docker "rag-v2-postgres" || overall_status=1

    echo ""

    # Host services
    check_reranker_health 3456 "Reranker Service" || overall_status=1
    if [ -x "$TSX_BIN" ] && "$TSX_BIN" "$PROJECT_ROOT/scripts/check-embedding-health.ts" --project-rag --quiet --readiness-only; then
        printf "%-25s ${GREEN}✓ Ready${NC}\n" "Embeddings GPU 1024"
    else
        printf "%-25s ${RED}✗ Not ready${NC}\n" "Embeddings GPU 1024"
        overall_status=1
    fi

    echo ""

    echo "───────────────────────────────────────────────────────────────"
    echo "Connectivity Tests"
    echo "───────────────────────────────────────────────────────────────"

    # Database
    if docker exec rag-v2-postgres pg_isready -U postgres >"$SINK" 2>&1; then
        printf "%-25s ${GREEN}✓ Accepting connections${NC}\n" "PostgreSQL DB"
    else
        printf "%-25s ${RED}✗ Not ready${NC}\n" "PostgreSQL DB"
        overall_status=1
    fi
fi

if [ "$STACK" = "dev" ] || [ "$STACK" = "both" ]; then
    if [ "$STACK" = "both" ]; then
        echo ""
        echo "───────────────────────────────────────────────────────────────"
        echo "DEV Stack"
    fi
    echo ""
    check_docker "$DEV_POSTGRES_NAME" || overall_status=1
    check_port "$DEV_POSTGRES_PORT" "PostgreSQL Host Port" || overall_status=1
fi

echo ""

if command -v bun >"$SINK" 2>&1 && [ -f "$PROJECT_ROOT/scripts/check-docs-rag-freshness.ts" ]; then
    echo "───────────────────────────────────────────────────────────────"
    echo "Docs RAG Freshness"
    echo "───────────────────────────────────────────────────────────────"
    if DOCS_FRESHNESS=$(cd "$PROJECT_ROOT" && bun run scripts/check-docs-rag-freshness.ts --text --strict 2>"$SINK"); then
        printf "%-25s ${GREEN}✓ Fresh${NC} (%s)\n" "External docs" "$DOCS_FRESHNESS"
    else
        printf "%-25s ${YELLOW}⚠ Update pending${NC} (%s)\n" "External docs" "$DOCS_FRESHNESS"
    fi
    echo ""
fi

# MCP
if [ "$STACK" = "prod" ] || [ "$STACK" = "both" ]; then
    echo "───────────────────────────────────────────────────────────────"
    if command -v bun >"$SINK" 2>&1 && [ -f "$PROJECT_ROOT/mcp/server.ts" ]; then
        printf "%-25s ${GREEN}✓ Available${NC}\n" "MCP Server"
    else
        printf "%-25s ${YELLOW}⚠ Check manually${NC}\n" "MCP Server"
    fi
    echo ""
fi

echo "───────────────────────────────────────────────────────────────"
if [ "$overall_status" -eq 0 ]; then
    printf "Overall status: ${GREEN}HEALTHY${NC}\n"
else
    printf "Overall status: ${YELLOW}DEGRADED${NC} (one or more checks failed)\n"
fi
echo ""

# Quick actions
echo "───────────────────────────────────────────────────────────────"
echo "Quick Actions"
echo "───────────────────────────────────────────────────────────────"
if [ "$STACK" = "both" ]; then
    echo "  Start prod:   ./scripts/start-rag.sh --stack=prod"
    echo "  Start dev:    ./scripts/start-rag.sh --stack=dev"
    echo "  Stop all:     ./scripts/stop-rag.sh --stack=both"
elif [ "$STACK" = "dev" ]; then
    echo "  Start dev:    ./scripts/start-rag.sh --stack=dev"
    echo "  Stop dev:     ./scripts/stop-rag.sh --stack=dev"
else
    echo "  Start all:    ./scripts/start-rag.sh"
    echo "  Stop all:     ./scripts/stop-rag.sh"
    echo "  Stop dev:     ./scripts/stop-rag.sh --stack=dev"
fi
echo "  Start rerank: bun run reranker:service"
echo "  Health check: ./bin/ragctl health --json"
echo ""

exit "$overall_status"
