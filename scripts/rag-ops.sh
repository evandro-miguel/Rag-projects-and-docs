#!/usr/bin/env bash
# Docker-first local operations for an isolated RAG Postgres database.
#
# The script deliberately owns only the worktree-local compose file and
# .env.rag.local. It never reads or changes the official RAG configuration.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/infra/docker/compose.local.yml"
ENV_FILE="${RAG_LOCAL_ENV_FILE:-$PROJECT_ROOT/.env.rag.local}"
if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$PROJECT_ROOT/$ENV_FILE"
fi
export BUN_CONFIG_DOTENV_DISABLE=1

usage() {
  cat <<'EOF'
Usage: scripts/rag-ops.sh <command> [options]

Commands:
  init [--embedding-profile 1024|4096] [--force]
      Create the ignored local env file, start Postgres, and apply migrations.
  up [--profile worker|reranker]
      Start the local Postgres stack and any explicitly selected profile.
  down [--volumes]
      Stop the local stack; volumes are removed only with --volumes.
  status
      Show Compose state and read-only migration state for both lanes.
  doctor
      Validate isolation, credentials, health checks, and migration state.
  eval-docs [--rebuild]
      Run the Docs RAG health gate against the isolated local Postgres stack.
      --rebuild explicitly permits the CPU-bound corpus rebuild.
  eval-mcp-live
      Run the Docs MCP live smoke against the isolated local Postgres stack.
  migrate status|apply [--lane project|docs|all] [--dry-run]
      Inspect or apply the fixed migration manifests.
  backup [--output <path>] [--force]
      Write a custom-format Postgres dump under .data/backups by default.
  restore --input <path> --confirm
      Restore a custom-format dump after an explicit destructive confirmation.
  upgrade
      Start the local stack and apply only pending migration suffixes.

The generated env file uses a non-default disposable database name and a
loopback-only, non-official port. Do not use this command with the official
rag-v2 compose project.
EOF
}

die() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

info() {
  printf '[INFO] %s\n' "$*"
}

ok() {
  printf '[OK] %s\n' "$*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

assert_no_symlink_components() {
  local path="$1"
  local current="$path"
  while [[ "$current" == "$PROJECT_ROOT" || "$current" == "$PROJECT_ROOT/"* ]]; do
    [[ ! -L "$current" ]] || die "symlink is not allowed in ${2:-target}: $current"
    [[ "$current" == "$PROJECT_ROOT" ]] && return 0
    current="$(dirname "$current")"
  done
  die "${2:-target} must remain inside this checkout"
}

canonicalize_project_target() {
  local input="$1"
  local label="$2"
  [[ "$input" != /* ]] && input="$PROJECT_ROOT/$input"
  assert_no_symlink_components "$input" "$label"
  local parent="$(dirname "$input")"
  [[ -d "$parent" ]] || die "$label parent directory does not exist: $parent"
  local canonical_parent
  canonical_parent="$(realpath -e -- "$parent")" || die "unable to canonicalize $label parent"
  [[ "$canonical_parent" == "$PROJECT_ROOT" || "$canonical_parent" == "$PROJECT_ROOT/"* ]] || \
    die "$label must remain inside this checkout"
  CANONICAL_TARGET="$canonical_parent/$(basename "$input")"
  [[ ! -L "$CANONICAL_TARGET" ]] || die "symlink is not allowed for $label: $CANONICAL_TARGET"
}

assert_env_path() {
  canonicalize_project_target "$ENV_FILE" 'environment file'
  ENV_FILE="$CANONICAL_TARGET"
}

load_env() {
  [[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE; run '$0 init' first"
  # Parse simple KEY=VALUE records without evaluating the file as shell code.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    local key="${BASH_REMATCH[1]}"
    local value="${BASH_REMATCH[2]}"
    value="${value#${value%%[![:space:]]*}}"
    value="${value%${value##*[![:space:]]}}"
    if [[ "$value" == "'"*"'" || "$value" == '"'*'"' ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$ENV_FILE"
}

compose() {
  [[ -n "${RAG_LOCAL_COMPOSE_PROJECT:-}" ]] || die 'local Compose project is not loaded'
  docker compose --ansi never --project-name "$RAG_LOCAL_COMPOSE_PROJECT" \
    --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

assert_compose_namespace() {
  local name
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    case "$name" in
      "$RAG_LOCAL_COMPOSE_PROJECT-postgres"|"$RAG_LOCAL_COMPOSE_PROJECT-reranker"|"$RAG_LOCAL_COMPOSE_PROJECT-worker-"*) ;;
      *) die "local Compose project contains unexpected container: $name" ;;
    esac
  done < <(docker ps -a --filter "label=com.docker.compose.project=$RAG_LOCAL_COMPOSE_PROJECT" --format '{{.Names}}')
}

validate_env() {
  assert_env_path
  load_env

  local required key
  for key in RAG_LOCAL_COMPOSE_PROJECT RAG_LOCAL_POSTGRES_PORT RAG_LOCAL_POSTGRES_USER \
    RAG_LOCAL_POSTGRES_PASSWORD RAG_LOCAL_POSTGRES_DB PROJECT_RAG_DATABASE_URL \
    DOCS_RAG_PG_LAB_DATABASE_URL RAG_MIGRATION_TARGET RAG_MIGRATION_WRITE_ACK \
    RAG_LOCAL_EMBEDDING_PROFILE PROJECT_RAG_PG_EMBEDDING_BASE_URL \
    PROJECT_RAG_PG_EMBEDDING_MODEL PROJECT_RAG_PG_EMBEDDING_DIMENSIONS; do
    required="${!key:-}"
    [[ -n "$required" ]] || die "$key is required in $ENV_FILE"
  done

  case "$RAG_LOCAL_COMPOSE_PROJECT" in
    rag-v2|rag-v2-dev|rag-v2-docs-rag|rag-v2-longevity-docs)
      die 'local Compose project may not use an official project name' ;;
  esac
  if [[ -n "${COMPOSE_PROJECT_NAME:-}" && "$COMPOSE_PROJECT_NAME" != "$RAG_LOCAL_COMPOSE_PROJECT" ]]; then
    die 'COMPOSE_PROJECT_NAME is inherited with a different value; unset it before running local operations'
  fi
  [[ "$RAG_LOCAL_COMPOSE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die 'invalid local Compose project name'
  [[ "$RAG_LOCAL_POSTGRES_USER" != "postgres" ]] || die 'local Postgres user must be non-default'
  [[ "$RAG_LOCAL_POSTGRES_PASSWORD" != "postgres" ]] || die 'local Postgres password must be non-default'
  [[ "$RAG_LOCAL_POSTGRES_PASSWORD" != "password" ]] || die 'local Postgres password must be non-default'
  [[ "$RAG_LOCAL_POSTGRES_PASSWORD" != "changeme" ]] || die 'local Postgres password must be non-default'
  [[ "$RAG_LOCAL_POSTGRES_PASSWORD" != "secret" ]] || die 'local Postgres password must be non-default'
  [[ "$RAG_LOCAL_POSTGRES_PASSWORD" != "$RAG_LOCAL_POSTGRES_USER" ]] || die 'local Postgres password must differ from the username'
  case "$RAG_LOCAL_POSTGRES_PASSWORD" in
    *[!A-Za-z0-9_-]*) die 'local Postgres password must be URL-safe ASCII' ;;
  esac
  [[ "$RAG_LOCAL_POSTGRES_DB" =~ ^rag_v2_migration_[a-z0-9][a-z0-9_-]*$ ]] || \
    die 'local Postgres database must match rag_v2_migration_<lowercase-token>'
  [[ "$RAG_LOCAL_POSTGRES_PORT" =~ ^[0-9]+$ ]] || die 'local Postgres port must be numeric'
  (( RAG_LOCAL_POSTGRES_PORT >= 1 && RAG_LOCAL_POSTGRES_PORT <= 65535 )) || die 'local Postgres port is out of range'
  case ",5432,5440,5441,5542,6542," in
    *",$RAG_LOCAL_POSTGRES_PORT,"*) die 'local Postgres port is reserved by an official lane' ;;
  esac
  [[ "$RAG_MIGRATION_TARGET" == "isolated" ]] || die 'RAG_MIGRATION_TARGET must be isolated'
  [[ "$RAG_MIGRATION_WRITE_ACK" == "1" ]] || die 'RAG_MIGRATION_WRITE_ACK must be 1'
  [[ "$RAG_LOCAL_EMBEDDING_PROFILE" == "1024" || "$RAG_LOCAL_EMBEDDING_PROFILE" == "4096" ]] || \
    die 'RAG_LOCAL_EMBEDDING_PROFILE must be 1024 or 4096'
  [[ "$PROJECT_RAG_PG_EMBEDDING_DIMENSIONS" == "$RAG_LOCAL_EMBEDDING_PROFILE" ]] || \
    die 'embedding dimensions do not match the selected local profile'
  [[ "$PROJECT_RAG_DATABASE_URL" == "postgres://${RAG_LOCAL_POSTGRES_USER}:${RAG_LOCAL_POSTGRES_PASSWORD}@127.0.0.1:${RAG_LOCAL_POSTGRES_PORT}/${RAG_LOCAL_POSTGRES_DB}" ]] || \
    die 'PROJECT_RAG_DATABASE_URL does not match the local database identity'
  [[ "$DOCS_RAG_PG_LAB_DATABASE_URL" == "$PROJECT_RAG_DATABASE_URL" ]] || \
    die 'DOCS_RAG_PG_LAB_DATABASE_URL must match the local database identity'
}

wait_for_postgres() {
  local container health state
  container="$(compose ps -q postgres)"
  [[ -n "$container" ]] || die 'local Postgres container was not created'
  for _ in {1..60}; do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
    state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    [[ "$health" == "healthy" ]] && return 0
    [[ "$state" == "exited" || "$state" == "dead" ]] && break
    sleep 1
  done
  compose logs --no-color --tail=30 postgres >&2 || true
  die 'local Postgres did not become healthy'
}

ensure_up() {
  need_command docker
  docker info >/dev/null 2>&1 || die 'Docker daemon is not available'
  assert_compose_namespace
  compose up -d postgres
  wait_for_postgres
}

run_migrations() {
  local action="$1"
  local lane_arg="${2:-all}"
  local dry_run="${3:-false}"
  local lanes=(project docs)
  [[ "$lane_arg" == "all" ]] || lanes=("$lane_arg")
  for lane in "${lanes[@]}"; do
    [[ "$lane" == "project" || "$lane" == "docs" ]] || die 'migration lane must be project, docs, or all'
    local args=("$action" --lane "$lane")
    if [[ "$action" == "apply" && "$dry_run" != "true" ]]; then
      args+=(--execute)
    elif [[ "$action" == "apply" && "$dry_run" == "true" ]]; then
      args+=(--dry-run)
    fi
    info "migration $action ($lane)"
    (cd "$PROJECT_ROOT" && bun run scripts/db-migrations/cli.ts "${args[@]}")
  done
}

embedding_profile_values() {
  case "$1" in
    1024) printf '%s\n' 'http://127.0.0.1:8082' 'qwen3-embedding-1024' '1024' ;;
    4096) printf '%s\n' 'http://127.0.0.1:8081' 'qwen3-embedding' '4096' ;;
    *) die 'embedding profile must be 1024 or 4096' ;;
  esac
}

init_env() {
  local profile="1024"
  local force="false"
  while (($#)); do
    case "$1" in
      --embedding-profile)
        [[ $# -ge 2 ]] || die '--embedding-profile requires 1024 or 4096'
        profile="$2"
        shift 2
        ;;
      --force) force="true"; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown init option: $1" ;;
    esac
  done
  assert_env_path
  if [[ -e "$ENV_FILE" && "$force" != "true" ]]; then
    die "$ENV_FILE already exists; use --force only to replace this local file"
  fi
  need_command od
  local password embedding_url embedding_model embedding_dimensions
  mapfile -t profile_values < <(embedding_profile_values "$profile")
  embedding_url="${profile_values[0]}"
  embedding_model="${profile_values[1]}"
  embedding_dimensions="${profile_values[2]}"
  password="$(od -An -N24 -tx1 /dev/urandom | tr -d '[:space:]')"
  [[ "$password" =~ ^[A-Za-z0-9_-]+$ ]] || die 'failed to generate a URL-safe local credential'

  umask 077
  local env_tmp
  env_tmp="$(mktemp "$(dirname "$ENV_FILE")/.rag-local-env.XXXXXX")"
  if ! {
    printf '# Generated by scripts/rag-ops.sh init; ignored by Git.\n'
    printf 'RAG_LOCAL_COMPOSE_PROJECT=rag-v2-local\n'
    printf 'RAG_LOCAL_POSTGRES_PORT=5560\n'
    printf 'RAG_LOCAL_POSTGRES_USER=rag_operator\n'
    printf 'RAG_LOCAL_POSTGRES_PASSWORD=%s\n' "$password"
    printf 'RAG_LOCAL_POSTGRES_DB=rag_v2_migration_local\n'
    printf 'PROJECT_RAG_DATABASE_URL=postgres://rag_operator:%s@127.0.0.1:5560/rag_v2_migration_local\n' "$password"
    printf 'DOCS_RAG_PG_LAB_DATABASE_URL=postgres://rag_operator:%s@127.0.0.1:5560/rag_v2_migration_local\n' "$password"
    printf 'RAG_MIGRATION_TARGET=isolated\nRAG_MIGRATION_WRITE_ACK=1\n'
    printf 'RAG_LOCAL_EMBEDDING_PROFILE=%s\n' "$profile"
    printf 'PROJECT_RAG_PG_EMBEDDING_BASE_URL=%s\n' "$embedding_url"
    printf 'PROJECT_RAG_PG_EMBEDDING_MODEL=%s\n' "$embedding_model"
    printf 'PROJECT_RAG_PG_EMBEDDING_DIMENSIONS=%s\n' "$embedding_dimensions"
    printf 'RAG_LOCAL_WORKER_EMBEDDING_BASE_URL=http://host.docker.internal:8082\n'
  } > "$env_tmp"; then
    rm -f -- "$env_tmp"
    die 'failed to write the local environment file'
  fi
  chmod 600 "$env_tmp"
  if ! mv -f -- "$env_tmp" "$ENV_FILE"; then
    rm -f -- "$env_tmp"
    die 'failed to install the local environment file atomically'
  fi
  validate_env
  compose config --quiet
  ensure_up
  run_migrations apply all false
  ok "local Docker install ready (embedding profile $profile)"
}

do_up() {
  local profiles=()
  while (($#)); do
    case "$1" in
      --profile)
        [[ $# -ge 2 ]] || die '--profile requires worker or reranker'
        [[ "$2" == "worker" || "$2" == "reranker" ]] || die 'supported profiles are worker and reranker'
        profiles+=(--profile "$2")
        shift 2
        ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown up option: $1" ;;
    esac
  done
  validate_env
  need_command docker
  docker info >/dev/null 2>&1 || die 'Docker daemon is not available'
  assert_compose_namespace
  compose "${profiles[@]}" up -d
  wait_for_postgres
  ok 'local Docker stack is running'
}

do_down() {
  local volumes="false"
  while (($#)); do
    case "$1" in
      --volumes) volumes="true"; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown down option: $1" ;;
    esac
  done
  validate_env
  need_command docker
  assert_compose_namespace
  if [[ "$volumes" == "true" ]]; then
    compose down --volumes
  else
    compose down
  fi
  ok 'local Docker stack stopped'
}

do_status() {
  validate_env
  need_command docker
  assert_compose_namespace
  compose ps
  run_migrations status all false
}

do_doctor() {
  validate_env
  need_command docker
  docker info >/dev/null 2>&1 || die 'Docker daemon is not available'
  compose config --quiet
  ensure_up
  compose ps
  compose exec -T postgres pg_isready -U "$RAG_LOCAL_POSTGRES_USER" -d "$RAG_LOCAL_POSTGRES_DB" >/dev/null
  run_migrations status all false
  ok "doctor passed; local profile $RAG_LOCAL_EMBEDDING_PROFILE is configured (endpoint checks remain host/provider-owned)"
}

do_eval_docs() {
  local rebuild="false"
  while (($#)); do
    case "$1" in
      --rebuild) rebuild="true"; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown eval-docs option: $1" ;;
    esac
  done

  validate_env
  ensure_up
  run_migrations status all false

  export DOCS_RAG_BENCH_CONTAINER="$RAG_LOCAL_COMPOSE_PROJECT-postgres"
  export DOCS_RAG_POSTGRES_DB="$RAG_LOCAL_POSTGRES_DB"
  export DOCS_RAG_POSTGRES_USER="$RAG_LOCAL_POSTGRES_USER"

  if [[ "$rebuild" == "true" ]]; then
    export DOCS_RAG_BENCH_ALLOW_CPU_REBUILD=true
    bash "$PROJECT_ROOT/scripts/eval/run-docs-rag-health.sh" --rebuild
  else
    bash "$PROJECT_ROOT/scripts/eval/run-docs-rag-health.sh"
  fi
}

do_eval_mcp_live() {
  (($# == 0)) || die "eval-mcp-live does not accept arguments"
  validate_env
  ensure_up
  run_migrations status all false

  bun run health:embeddings:docs-live -- --readiness-only
  RAG_PROJECT_WATCHER_ENABLED=false \
    bun run scripts/eval/mcp-live-harness.ts --docs-only
}

do_migrate() {
  local action="${1:-status}"
  shift || true
  local lane="all"
  local dry_run="false"
  while (($#)); do
    case "$1" in
      --lane)
        [[ $# -ge 2 ]] || die '--lane requires project, docs, or all'
        lane="$2"
        shift 2
        ;;
      --dry-run) dry_run="true"; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown migrate option: $1" ;;
    esac
  done
  [[ "$action" == "status" || "$action" == "apply" ]] || die 'migrate action must be status or apply'
  validate_env
  ensure_up
  run_migrations "$action" "$lane" "$dry_run"
}

backup_path_default() {
  printf '%s/.data/backups/rag-local-%s.dump\n' "$PROJECT_ROOT" "$(date -u +%Y%m%dT%H%M%SZ)"
}

ensure_backup_dir() {
  local dir="$PROJECT_ROOT/.data/backups"
  assert_no_symlink_components "$dir" 'backup directory'
  mkdir -p -- "$dir"
  assert_no_symlink_components "$dir" 'backup directory'
}

do_backup() {
  local output=""
  local force="false"
  while (($#)); do
    case "$1" in
      --output)
        [[ $# -ge 2 ]] || die '--output requires a path'
        output="$2"
        shift 2
        ;;
      --force) force="true"; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown backup option: $1" ;;
    esac
  done
  if [[ -z "$output" ]]; then
    ensure_backup_dir
    output="$(backup_path_default)"
  fi
  canonicalize_project_target "$output" 'backup output'
  output="$CANONICAL_TARGET"
  validate_env
  ensure_up
  [[ ! -e "$output" || "$force" == "true" ]] || die "backup already exists: $output (use --force to replace it)"
  local backup_tmp
  backup_tmp="$(mktemp "$(dirname "$output")/.rag-local-backup.XXXXXX")"
  if ! compose exec -T postgres pg_dump --format=custom --no-owner -U "$RAG_LOCAL_POSTGRES_USER" -d "$RAG_LOCAL_POSTGRES_DB" > "$backup_tmp"; then
    rm -f -- "$backup_tmp"
    die 'backup failed'
  fi
  if [[ ! -s "$backup_tmp" ]]; then
    rm -f -- "$backup_tmp"
    die 'backup produced an empty file'
  fi
  if ! mv -f -- "$backup_tmp" "$output"; then
    rm -f -- "$backup_tmp"
    die 'failed to install the backup atomically'
  fi
  ok "backup written to $output"
}

do_restore() {
  local input=""
  local confirmed="false"
  while (($#)); do
    case "$1" in
      --input)
        [[ $# -ge 2 ]] || die '--input requires a path'
        input="$2"
        shift 2
        ;;
      --confirm) confirmed="true"; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown restore option: $1" ;;
    esac
  done
  [[ "$confirmed" == "true" ]] || die 'restore is destructive; pass --confirm explicitly'
  [[ -n "$input" ]] || die 'restore requires --input <path>'
  canonicalize_project_target "$input" 'restore input'
  input="$CANONICAL_TARGET"
  [[ -f "$input" ]] || die "restore input is not a regular file: $input"
  [[ -s "$input" ]] || die 'restore input is empty'
  validate_env
  ensure_up
  compose exec -T postgres pg_restore --clean --if-exists --no-owner --exit-on-error \
    -U "$RAG_LOCAL_POSTGRES_USER" --dbname "$RAG_LOCAL_POSTGRES_DB" < "$input"
  run_migrations status all false
  ok "restore completed from $input"
}

main() {
  assert_env_path
  local command="${1:-}"
  shift || true
  case "$command" in
    init) init_env "$@" ;;
    up) do_up "$@" ;;
    down) do_down "$@" ;;
    status) do_status "$@" ;;
    doctor) do_doctor "$@" ;;
    eval-docs) do_eval_docs "$@" ;;
    eval-mcp-live) do_eval_mcp_live "$@" ;;
    migrate) do_migrate "$@" ;;
    backup) do_backup "$@" ;;
    restore) do_restore "$@" ;;
    upgrade)
      validate_env
      ensure_up
      run_migrations apply all false
      ok 'local database upgrade complete'
      ;;
    help|--help|-h) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
