#!/bin/bash
#
# @module scripts/stop-rag
# @description Stop all RAG services
#
# Usage:
#   ./scripts/stop-rag.sh [--reranker-only] [--docker-only] [--stack=prod|dev|both] [--prod|--dev|--both]
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_ENV_FILE="$PROJECT_ROOT/.env.dev.local"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

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

# Parse arguments
STACK="prod"
RERANKER_ONLY=false
DOCKER_ONLY=false
DEV_COMPOSE_ENV_ARGS=()
for arg in "$@"; do
    case $arg in
        --stack=prod|--prod) STACK="prod" ;;
        --stack=dev|--dev) STACK="dev" ;;
        --stack=both|--both) STACK="both" ;;
        --reranker-only) RERANKER_ONLY=true ;;
        --docker-only) DOCKER_ONLY=true ;;
        --help|-h)
            echo "Usage: ./scripts/stop-rag.sh [--reranker-only] [--docker-only] [--stack=prod|dev|both] [--prod|--dev|--both]"
            exit 0
            ;;
        *) ;;
    esac
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "                    RAG Services Shutdown                       "
echo "═══════════════════════════════════════════════════════════════"
echo ""

# =============================================================================
# Reranker Service
# =============================================================================
if [ "$DOCKER_ONLY" = false ]; then
    log_info "Stopping Reranker service..."

    # Kill by PID file
    if [ -f /tmp/reranker.pid ]; then
        PID=$(cat /tmp/reranker.pid)
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID" 2>/dev/null || true
            log_success "Reranker stopped (PID: $PID)"
        fi
        rm -f /tmp/reranker.pid
    fi

    # Also kill any process on port 3456
    if lsof -i :3456 -t &>/dev/null; then
        kill $(lsof -i :3456 -t) 2>/dev/null || true
        log_success "Killed process on port 3456"
    fi
fi

# =============================================================================
# Docker Services
# =============================================================================
if [ "$RERANKER_ONLY" = false ]; then
    log_info "Stopping Docker services..."

    cd "$PROJECT_ROOT/infra/docker"

    if [ -f "$DEV_ENV_FILE" ]; then
        DEV_COMPOSE_ENV_ARGS=(--env-file "$DEV_ENV_FILE")
    fi
    DEV_STACK_PREFIX="$(env_or_project_file COMPOSE_PROJECT_NAME "rag-v2-dev")"
    DEV_POSTGRES_NAME="${DEV_STACK_PREFIX}-postgres-dev"

    STOP_PROD=false
    STOP_DEV=false
    case "$STACK" in
        prod) STOP_PROD=true ;;
        dev) STOP_DEV=true ;;
        both) STOP_PROD=true; STOP_DEV=true ;;
        *) STOP_PROD=true ;;
    esac

    if [ "$STOP_PROD" = true ]; then
        if docker ps --filter "name=rag-v2-postgres$" --filter "status=running" -q | grep -q .; then
            docker compose -f compose.yml down
            log_success "Production Docker services stopped"
        else
            log_info "Production Docker services already stopped"
        fi
    fi

    if [ "$STOP_DEV" = true ]; then
        if docker ps --filter "name=${DEV_POSTGRES_NAME}$" --filter "status=running" -q | grep -q .; then
            docker compose "${DEV_COMPOSE_ENV_ARGS[@]}" -f compose.dev.yml down
            log_success "Dev Docker services stopped"
        else
            log_info "Dev Docker services already stopped"
        fi
    fi

    if [ "$STACK" = "prod" ] && [ "$STOP_PROD" = true ]; then
        if docker ps --filter "name=${DEV_POSTGRES_NAME}$" -q | grep -q .; then
            log_warn "Dev stack is separate and appears to be running."
            log_warn "To stop it, run: ./scripts/stop-rag.sh --stack=dev"
            log_warn "Or: docker compose --env-file .env.dev.local -f infra/docker/compose.dev.yml down"
        fi
    fi
fi

echo ""
log_success "RAG shutdown complete!"
echo ""
