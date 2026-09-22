#!/usr/bin/env bash
set -euo pipefail

# @module scripts/ensure-reranker
# @description Ensure the explicitly configured local reranker is running.
#
# This script is called only by the write-capability ensure_reranker tool or by
# an operator. Read paths must never invoke it. Runtime state stays inside the
# project scratch directory by default; set RERANKING_SERVICE_RUN_DIR only for
# an explicitly supervised runtime directory.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_URL="${RERANKING_SERVICE_URL:-}"
if [[ -z "$SERVICE_URL" ]]; then
  SERVICE_HOST="${RERANKING_SERVICE_HOST:-127.0.0.1}"
  SERVICE_PORT="${RERANKING_SERVICE_PORT:-3456}"
  SERVICE_URL="http://${SERVICE_HOST}:${SERVICE_PORT}"
fi
SERVICE_URL="${SERVICE_URL%/}"

RUN_DIR="${RERANKING_SERVICE_RUN_DIR:-$PROJECT_ROOT/.tmp/reranker}"
PID_FILE="$RUN_DIR/reranker.pid"
LOG_FILE="$RUN_DIR/reranker.log"
LOCK_DIR="$RUN_DIR/start.lock"
STARTUP_TIMEOUT="${RERANKING_SERVICE_STARTUP_TIMEOUT_SEC:-30}"

if ! [[ "$STARTUP_TIMEOUT" =~ ^[0-9]+$ ]] || (( STARTUP_TIMEOUT < 1 || STARTUP_TIMEOUT > 120 )); then
  STARTUP_TIMEOUT=30
fi

mkdir -p "$RUN_DIR"

health_check() {
  curl --fail --silent --show-error --max-time 2 "$SERVICE_URL/health" >/dev/null 2>&1
}

cleanup_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

stop_started_process() {
  local pid="${1:-}"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

if health_check; then
  echo "Reranker already running at $SERVICE_URL"
  exit 0
fi

# mkdir is an atomic lock and avoids duplicate model loads when two explicit
# supervisors race. A second caller waits for the first one to become healthy.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  for ((second = 1; second <= STARTUP_TIMEOUT; second++)); do
    if health_check; then
      echo "Reranker started by another supervisor at $SERVICE_URL"
      exit 0
    fi
    sleep 1
  done
  echo "Reranker supervisor lock is held but service did not become healthy: $SERVICE_URL" >&2
  exit 1
fi
trap cleanup_lock EXIT

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(<"$PID_FILE")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Reranker process $existing_pid is already running; waiting for health"
    for ((second = 1; second <= STARTUP_TIMEOUT; second++)); do
      if health_check; then
        echo "Reranker healthy after ${second}s"
        exit 0
      fi
      if ! kill -0 "$existing_pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "Reranker process $existing_pid is alive but unhealthy; refusing a duplicate start." >&2
      exit 1
    fi
  else
    rm -f "$PID_FILE"
  fi
fi

echo "Reranker not healthy, starting at $SERVICE_URL..."
cd "$PROJECT_ROOT"
nohup bun run "$PROJECT_ROOT/scripts/reranking-service.ts" \
  >"$LOG_FILE" 2>&1 < /dev/null &
reranker_pid=$!
printf '%s\n' "$reranker_pid" >"$PID_FILE"
echo "Started reranker (PID: $reranker_pid), waiting for health check..."

for ((second = 1; second <= STARTUP_TIMEOUT; second++)); do
  if health_check; then
    echo "Reranker healthy after ${second}s"
    exit 0
  fi
  if ! kill -0 "$reranker_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

stop_started_process "$reranker_pid"
rm -f "$PID_FILE"
echo "Reranker failed to start after ${STARTUP_TIMEOUT}s. Recent log output:" >&2
tail -20 "$LOG_FILE" 2>/dev/null || true
exit 1
