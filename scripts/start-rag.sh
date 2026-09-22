#!/bin/bash
#
# @module scripts/start-rag
# @description Start the RAG database and reranker, then verify embeddings
#
# Usage:
#   ./scripts/start-rag.sh [--reranker-only] [--docker-only] [--stack=prod|dev] [--prod|--dev]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SINK="$(mktemp)"
DEV_ENV_FILE="$PROJECT_ROOT/.env.dev.local"
trap 'rm -f "$SINK"' EXIT

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

read_project_env_value() {
    local key=$1
    local file=$2

    [ -f "$file" ] || return 1
    awk -v key="$key" '
        $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
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

# Parse arguments
STACK="prod"
RERANKER_ONLY=false
DOCKER_ONLY=false
COMPOSE_ENV_ARGS=()

for arg in "$@"; do
    case $arg in
        --stack=prod|--prod) STACK="prod" ;;
        --stack=dev|--dev) STACK="dev" ;;
        --stack=both|--both)
            echo "ERROR: --stack for start only accepts prod or dev." >&2
            exit 1
            ;;
        --reranker-only) RERANKER_ONLY=true ;;
        --docker-only) DOCKER_ONLY=true ;;
        --help|-h)
            echo "Usage: $0 [--reranker-only] [--docker-only] [--stack=prod|dev] [--prod|--dev]"
            exit 0
            ;;
        *) ;;
    esac
done

if [ "$STACK" = "dev" ]; then
    COMPOSE_FILE="compose.dev.yml"
    if [ -f "$DEV_ENV_FILE" ]; then
        COMPOSE_ENV_ARGS=(--env-file "$DEV_ENV_FILE")
    fi
    DEV_STACK_PREFIX="$(env_or_project_file COMPOSE_PROJECT_NAME "rag-v2-dev")"
    POSTGRES_NAME="${DEV_STACK_PREFIX}-postgres-dev"
    POSTGRES_SERVICE="postgres-dev"
    POSTGRES_PORT="$(env_or_project_file RAG_DEV_POSTGRES_PORT "5441")"
else
    COMPOSE_FILE="compose.yml"
    POSTGRES_NAME="rag-v2-postgres"
    POSTGRES_SERVICE="postgres"
    POSTGRES_PORT="5440"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$STACK" = "dev" ]; then
    echo "            RAG DEV Stack Startup (temporary)               "
else
    echo "                    RAG Services Startup                   "
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""

if [ "$STACK" = "dev" ]; then
    log_warn "Dev stack is intentionally separated from the normal startup cycle."
    log_info "Dev stack prefix: ${DEV_STACK_PREFIX}; PostgreSQL port: ${POSTGRES_PORT}"
fi

# =============================================================================
# Docker Services
# =============================================================================
if [ "$RERANKER_ONLY" = false ]; then
    log_info "Checking Docker services..."

    cd "$PROJECT_ROOT/infra/docker"

    # Check if Docker is running
    if ! docker info >"$SINK" 2>&1; then
        log_error "Docker is not running. Please start Docker first."
        exit 1
    fi

    # Check if containers are already running
    POSTGRES_RUNNING=$(docker ps --filter "name=$POSTGRES_NAME" --filter "status=running" -q | wc -l)

    if [ "$POSTGRES_RUNNING" -gt 0 ]; then
        log_success "PostgreSQL already running"
    else
        log_info "Starting PostgreSQL service..."
        docker compose "${COMPOSE_ENV_ARGS[@]}" -f "$COMPOSE_FILE" up -d "$POSTGRES_SERVICE"

        # Wait for health checks
        log_info "Waiting for PostgreSQL to be healthy..."
        sleep 5

        for i in {1..30}; do
            POSTGRES_HEALTH=$(docker inspect "$POSTGRES_NAME" --format='{{.State.Health.Status}}' 2>"$SINK" || echo "unknown")

            if [ "$POSTGRES_HEALTH" = "healthy" ]; then
                break
            fi

            echo -n "."
            sleep 1
        done
        echo ""

        log_success "PostgreSQL service started"
    fi
fi

# =============================================================================
# Reranker Service
# =============================================================================
if [ "$DOCKER_ONLY" = false ]; then
    log_info "Checking Reranker service..."

    # Check if reranker is already running
    if curl -s http://localhost:3456/health >"$SINK" 2>&1; then
        log_success "Reranker already running (port 3456)"
    else
        log_info "Starting Reranker service..."

        cd "$PROJECT_ROOT"

        # Start in background
        nohup bun run reranker:service > /tmp/reranker.log 2>&1 &
        RERANKER_PID=$!

        # Wait for it to start
        for i in {1..30}; do
            if curl -s http://localhost:3456/health >"$SINK" 2>&1; then
                break
            fi
            echo -n "."
            sleep 1
        done
        echo ""

        if curl -s http://localhost:3456/health >"$SINK" 2>&1; then
            log_success "Reranker started (PID: $RERANKER_PID, port 3456)"
            echo "$RERANKER_PID" > /tmp/reranker.pid
        else
            log_warn "Reranker may need model download. Check /tmp/reranker.log"
        fi
    fi
fi

# =============================================================================
# Embedding Provider
# =============================================================================
if [ "$RERANKER_ONLY" = false ] && [ "$DOCKER_ONLY" = false ]; then
    log_info "Checking the configured embedding provider..."
    if (cd "$PROJECT_ROOT" && bun run scripts/ensure-embedding-provider.ts); then
        log_success "Embedding provider ready"
    else
        log_error "Embedding provider is not ready. Configure llama.cpp as described in README.md."
        exit 1
    fi
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "                      Status Summary                         "
echo "═══════════════════════════════════════════════════════════════"

# Final status
echo ""
printf "%-25s %s\n" "Component" "Status"
printf "%-25s %s\n" "---------" "------"

if [ "$RERANKER_ONLY" = false ]; then
    # PostgreSQL
    if docker ps --filter "name=$POSTGRES_NAME" --filter "status=running" -q | grep -q .; then
        printf "%-25s ${GREEN}✓ Running${NC}\n" "PostgreSQL (${POSTGRES_PORT})"
    else
        printf "%-25s ${RED}✗ Stopped${NC}\n" "PostgreSQL (${POSTGRES_PORT})"
    fi

fi

if [ "$DOCKER_ONLY" = false ]; then
    # Reranker
    if curl -s http://localhost:3456/health >"$SINK" 2>&1; then
        printf "%-25s ${GREEN}✓ Running${NC}\n" "Reranker (3456)"
    else
        printf "%-25s ${RED}✗ Stopped${NC}\n" "Reranker (3456)"
    fi
fi

if [ "$RERANKER_ONLY" = false ] && [ "$DOCKER_ONLY" = false ]; then
    # Embedding provider
    if bun run health:embeddings:project -- --readiness-only >"$SINK" 2>&1; then
        printf "%-25s ${GREEN}✓ Running${NC}\n" "Embeddings"
    else
        printf "%-25s ${YELLOW}⚠ Not ready${NC}\n" "Embeddings"
    fi
fi

echo ""
if [ "$STACK" = "dev" ]; then
    log_success "RAG dev startup complete (temporary stack)!"
else
    log_success "RAG startup complete!"
fi
echo ""
