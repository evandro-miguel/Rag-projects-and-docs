#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

LOCAL_COMPOSE_PROJECT="${RAG_LOCAL_COMPOSE_PROJECT:-rag-v2-local}"
CONTAINER="${DOCS_RAG_BENCH_CONTAINER:-${LOCAL_COMPOSE_PROJECT}-postgres}"
DB_NAME="${DOCS_RAG_POSTGRES_DB:-${RAG_LOCAL_POSTGRES_DB:-}}"
DB_USER="${DOCS_RAG_POSTGRES_USER:-${RAG_LOCAL_POSTGRES_USER:-}}"
DB_URL="${DOCS_RAG_PG_LAB_DATABASE_URL:-}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${DOCS_RAG_BENCH_RUN_DIR:-.data/tmp/rag-benchmark-tests/$RUN_ID}"
EVAL_DATASET="${DOCS_RAG_BENCH_EVAL_DATASET:-scripts/docs-rag/fixtures/eval-external-sources.json}"
SEARCH_REPS="${DOCS_RAG_BENCH_SEARCH_REPS:-5}"
MAX_SEARCH_P95_MS="${DOCS_RAG_BENCH_MAX_SEARCH_P95_MS:-1500}"
STRICT_SANITIZE="${DOCS_RAG_BENCH_STRICT_SANITIZE:-false}"
ALLOW_CPU_REBUILD="${DOCS_RAG_BENCH_ALLOW_CPU_REBUILD:-false}"
REQUIRE_EMBEDDINGS="${DOCS_RAG_BENCH_REQUIRE_EMBEDDINGS:-true}"
MIN_HIT_RATE="${DOCS_RAG_BENCH_MIN_HIT_RATE:-0.95}"
MIN_RECALL="${DOCS_RAG_BENCH_MIN_RECALL:-0.95}"
MIN_MRR="${DOCS_RAG_BENCH_MIN_MRR:-0.80}"
MIN_CITATION_RATE="${DOCS_RAG_BENCH_MIN_CITATION_RATE:-0.80}"
MAX_DUPLICATE_PATH_SHARE="${DOCS_RAG_BENCH_MAX_DUPLICATE_PATH_SHARE:-0.30}"
REBUILD=false

for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

[[ -n "$DB_NAME" ]] || { echo "Set DOCS_RAG_POSTGRES_DB or RAG_LOCAL_POSTGRES_DB" >&2; exit 26; }
[[ -n "$DB_USER" ]] || { echo "Set DOCS_RAG_POSTGRES_USER or RAG_LOCAL_POSTGRES_USER" >&2; exit 27; }
[[ -n "$DB_URL" ]] || { echo "Set DOCS_RAG_PG_LAB_DATABASE_URL" >&2; exit 28; }

if "$REBUILD" && [[ "$ALLOW_CPU_REBUILD" != "true" ]]; then
  echo "--rebuild is CPU-bound Postgres/Bun indexing, not GPU embedding/indexing." >&2
  echo "Set DOCS_RAG_BENCH_ALLOW_CPU_REBUILD=true only when CPU rebuild is explicitly allowed." >&2
  exit 24
fi

command -v jq >/dev/null || { echo "jq is required" >&2; exit 21; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "Missing dev container: $CONTAINER" >&2
  exit 22
}

compose_project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$CONTAINER")"
compose_service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$CONTAINER")"
compose_files="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$CONTAINER")"
expected_compose_file="$ROOT/infra/docker/compose.local.yml"

is_loopback_host_ip() {
  local host_ip="$1"
  if [[ "$host_ip" == "::1" ]]; then
    return 0
  fi
  if [[ "$host_ip" != 127.* ]]; then
    return 1
  fi

  local first second third fourth extra
  IFS=. read -r first second third fourth extra <<< "$host_ip"
  [[ "$first" == "127" && -z "${extra:-}" ]] || return 1
  for octet in "$second" "$third" "$fourth"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    ((10#$octet <= 255)) || return 1
  done
}

case "$compose_project" in
  rag-v2|rag-v2-dev|rag-v2-docs-rag|rag-v2-longevity-docs)
    echo "Refusing official/shared Compose project: $compose_project" >&2
    exit 20
    ;;
esac
[[ "$compose_service" == "postgres" ]] || {
  echo "Benchmark container must be the isolated Postgres service" >&2
  exit 23
}
[[ "$compose_files" == *"$expected_compose_file"* ]] || {
  echo "Benchmark container must come from $expected_compose_file" >&2
  exit 23
}

published_bindings="$(
  docker inspect --format '{{range (index .NetworkSettings.Ports "5432/tcp")}}{{.HostIp}} {{.HostPort}}{{"\n"}}{{end}}' "$CONTAINER"
)"
[[ -n "$published_bindings" ]] || { echo "Benchmark Postgres must publish a loopback port" >&2; exit 23; }
published_host_ips=()
published_ports=()
while read -r published_host_ip published_port extra; do
  [[ -n "$published_host_ip" && -n "$published_port" && -z "${extra:-}" ]] || {
    echo "Benchmark Postgres has an invalid published port binding" >&2
    exit 23
  }
  is_loopback_host_ip "$published_host_ip" || {
    echo "Benchmark Postgres must publish on loopback only (HostIp=$published_host_ip)" >&2
    exit 23
  }
  [[ "$published_port" =~ ^[1-9][0-9]{0,4}$ ]] &&
    ((10#$published_port <= 65535)) || {
    echo "Benchmark Postgres has an invalid published port (HostPort=$published_port)" >&2
    exit 23
  }
  published_host_ips+=("$published_host_ip")
  published_ports+=("$published_port")
done <<< "$published_bindings"
(( ${#published_ports[@]} > 0 )) || { echo "Benchmark Postgres must publish a loopback port" >&2; exit 23; }
IFS=$'\t' read -r db_host db_port db_user_from_url db_name_from_url < <(
  DOCS_RAG_PG_LAB_DATABASE_URL="$DB_URL" node -e '
    const url = new URL(process.env.DOCS_RAG_PG_LAB_DATABASE_URL);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const fields = [hostname, url.port || "5432", decodeURIComponent(url.username), decodeURIComponent(url.pathname.slice(1))];
    process.stdout.write(`${fields.join("\t")}\n`);
  '
)
[[ "$db_host" == "localhost" ]] || is_loopback_host_ip "$db_host" || {
  echo "Benchmark database URL must use a loopback host" >&2
  exit 23
}
db_binding_match=false
for index in "${!published_ports[@]}"; do
  if [[ "$db_port" == "${published_ports[$index]}" &&
    ("$db_host" == "${published_host_ips[$index]}" ||
      ("$db_host" == "localhost" && "${published_host_ips[$index]}" == 127.*)) ]]; then
    db_binding_match=true
    break
  fi
done
[[ "$db_binding_match" == true && "$db_user_from_url" == "$DB_USER" && "$db_name_from_url" == "$DB_NAME" ]] || {
  echo "Benchmark database URL does not match the isolated container identity" >&2
  exit 23
}

mkdir -p "$(dirname "$RUN_DIR")"
if ! mkdir "$RUN_DIR"; then
  echo "Refusing to reuse existing or unavailable run directory: $RUN_DIR" >&2
  exit 25
fi
mkdir "$RUN_DIR/search"
export DOCS_RAG_PG_LAB_DATABASE_URL="$DB_URL"
export DOCS_RAG_PG_LAB_ENABLE_LIVE_SEARCH=true
export DOCS_RAG_PG_LAB_ENABLE_EMBEDDING="${DOCS_RAG_PG_LAB_ENABLE_EMBEDDING:-true}"
DOCS_RAG_CLI=(bun run scripts/docs-rag/index.ts)

redacted_url="$("${DOCS_RAG_CLI[@]}" config | jq -r '.data.database.redactedUrl')"
echo "run_dir=$RUN_DIR"
echo "container=$CONTAINER"
echo "db=$redacted_url"

run_step() {
  local name="$1"
  shift
  echo "== $name" >&2
  "$@"
}

now_ms() { node -e 'console.log(Date.now())'; }

run_step code-tests bun run test -- tests/docs-rag/lab.test.ts
run_step typecheck bun run typecheck
run_step lint bun run lint
run_step docs-cleanliness bun scripts/eval/docs-cleanliness-audit.ts --json > "$RUN_DIR/docs-cleanliness.json"

echo "== container-health"
docker inspect \
  --format '{{if eq .State.Health.Status "healthy"}}healthy{{else}}{{.State.Health.Status}}{{end}}' \
  "$CONTAINER" | tee "$RUN_DIR/container-health.txt"
grep -qx 'healthy' "$RUN_DIR/container-health.txt"

run_step db-health "${DOCS_RAG_CLI[@]}" db-health --write "$RUN_DIR/db-health.json"
jq -e '.ok == true and .data.status == "healthy"' "$RUN_DIR/db-health.json" >/dev/null

echo "== freshness"
bun run scripts/check-docs-rag-freshness.ts --strict | tee "$RUN_DIR/freshness.json"
jq -e '.status == "ok" and .sourceCoverage.missing == []' "$RUN_DIR/freshness.json" >/dev/null

run_step sanitize "${DOCS_RAG_CLI[@]}" sanitize-plan ingest/processed/external \
  --max-files 8000 \
  --write "$RUN_DIR/sanitize-plan.json"
jq -e '
  .data.report.summary.fileLimitHit == false
' "$RUN_DIR/sanitize-plan.json" >/dev/null
if [[ "$STRICT_SANITIZE" == "true" ]]; then
  jq -e '
    .data.report.summary.secretLikePathCount == 0 and
    .data.report.summary.secretLikeContentCount == 0 and
    .data.report.summary.absolutePathReferenceCount == 0 and
    .data.report.summary.traversalReferenceCount == 0
  ' "$RUN_DIR/sanitize-plan.json" >/dev/null
fi

if "$REBUILD"; then
  run_step migrate env \
    RAG_MIGRATION_TARGET=isolated \
    RAG_MIGRATION_WRITE_ACK=1 \
    bun run db:migrations -- apply --lane docs --execute

  run_step reset-dev-db docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    -c 'truncate table docs_embeddings, docs_chunks, docs_documents restart identity cascade'

  if [[ -n "${DOCS_RAG_BENCH_INGEST_PATHS:-}" ]]; then
    read -r -a INGEST_PATHS <<< "$DOCS_RAG_BENCH_INGEST_PATHS"
  else
    mapfile -t INGEST_PATHS < <(
      jq -r '.sources[].id | "ingest/processed/external/" + .' scripts/sources.json |
        while IFS= read -r path; do
          [[ -e "$path" ]] && printf '%s\n' "$path"
        done
    )
  fi
  export DOCS_RAG_PG_LAB_ENABLE_MUTATIONS=true
  run_step ingest "${DOCS_RAG_CLI[@]}" ingest "${INGEST_PATHS[@]}" \
    --allow-write \
    --max-files 8000 \
    --write "$RUN_DIR/ingest.json"
  jq -e '.ok == true and .data.failedFiles == [] and .data.indexedDocuments > 0 and .data.indexedChunks > 0' \
    "$RUN_DIR/ingest.json" >/dev/null
fi

run_step corpus-health ./bin/ragctl docs health --json > "$RUN_DIR/corpus-health.json"
jq -e '
  .ok == true and
  .data.status == "ok" and
  .data.docsCorpus.status == "healthy" and
  .data.docsCorpus.unexpectedSourceIds == [] and
  .data.docsCorpus.invalidPathCount == 0 and
  .data.docsCorpus.sourcePathMismatchCount == 0 and
  .data.docsCorpus.missingMetadataCount == 0
' "$RUN_DIR/corpus-health.json" >/dev/null

docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA <<'SQL' > "$RUN_DIR/corpus.json"
with serving_documents as (
  select d.*
  from docs_documents d
  join docs_source_generation_pointers p
    on p.source_id = d.source_id
   and p.generation_id = d.generation_id
),
normalized as (
  select regexp_replace(source_path, '\.(mdx|md|txt|json)$', '') as base,
         count(*) as n
  from serving_documents
  group by 1
  having count(*) > 1
),
stats as (
  select
    (select count(*) from serving_documents) as documents,
    (select count(*) from docs_chunks c join serving_documents d on d.id = c.document_id) as chunks,
    (select count(*) from serving_documents where status = 'indexed') as indexed_documents,
    (select count(*) from serving_documents where trim(content) = '') as empty_documents,
    (select count(*) from serving_documents where source_path is null or source_path = '') as bad_paths,
    (select count(*) from serving_documents where content_hash is null or content_hash = '') as missing_hashes,
    (select count(*) from docs_chunks c join serving_documents d on d.id = c.document_id where trim(c.content) = '') as empty_chunks,
    (select count(*) from docs_chunks c join serving_documents d on d.id = c.document_id where not c.enabled) as disabled_chunks,
    (select count(*) from docs_embeddings e join docs_chunks c on c.id = e.chunk_id join serving_documents d on d.id = c.document_id where e.embedding_kind = 'chunk') as chunk_embeddings,
    (select count(*) from normalized) as duplicate_groups,
    coalesce((select sum(n) from normalized), 0) as duplicate_documents
)
select jsonb_pretty(to_jsonb(stats)) from stats;
SQL

jq -e '
  .documents > 0 and
  .chunks > 0 and
  .documents == .indexed_documents and
  .empty_documents == 0 and
  .bad_paths == 0 and
  .missing_hashes == 0 and
  .empty_chunks == 0 and
  .disabled_chunks == 0 and
  .duplicate_groups == 0 and
  .duplicate_documents == 0
' "$RUN_DIR/corpus.json" >/dev/null

if [[ "$REQUIRE_EMBEDDINGS" == "true" ]]; then
  jq -e '.chunk_embeddings >= .chunks' "$RUN_DIR/corpus.json" >/dev/null
fi

docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "select distinct d.source_id from docs_documents d join docs_source_generation_pointers p on p.source_id = d.source_id and p.generation_id = d.generation_id order by d.source_id" > "$RUN_DIR/db-source-ids.txt"
jq -r '.sources[].id' scripts/sources.json > "$RUN_DIR/expected-source-ids.txt"
node - "$RUN_DIR/db-source-ids.txt" "$RUN_DIR/expected-source-ids.txt" > "$RUN_DIR/source-coverage.json" <<'NODE'
const { readFileSync } = require('node:fs');
const [, , actualPath, expectedPath] = process.argv;
const actual = new Set(readFileSync(actualPath, 'utf8').split(/\r?\n/).filter(Boolean));
const expected = new Set(readFileSync(expectedPath, 'utf8').split(/\r?\n/).filter(Boolean));
const missing = [...expected].filter((id) => !actual.has(id));
const unexpected = [...actual].filter((id) => !expected.has(id));
const report = { ok: missing.length === 0 && unexpected.length === 0, missing, unexpected };
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 31);
NODE

run_step live-eval "${DOCS_RAG_CLI[@]}" eval \
  --live-search \
  --allow-live-search \
  --dataset "$EVAL_DATASET" \
  --top-k 5 \
  --write "$RUN_DIR/live-eval.json"
jq -e --argjson hit "$MIN_HIT_RATE" --argjson recall "$MIN_RECALL" \
  --argjson mrr "$MIN_MRR" --argjson citation "$MIN_CITATION_RATE" \
  --argjson duplicate "$MAX_DUPLICATE_PATH_SHARE" '
  .ok == true and
  .data.report.summary.hitRate >= $hit and
  .data.report.summary.recallAtK >= $recall and
  .data.report.summary.mrr >= $mrr and
  .data.report.summary.citationPathRate >= $citation and
  .data.report.summary.duplicatePathShare <= $duplicate and
  .data.report.summary.sourceScoped.duplicatePathShare <= $duplicate and
  .data.report.summary.unscoped.duplicatePathShare <= $duplicate
' "$RUN_DIR/live-eval.json" >/dev/null

queries=(
  "defineSchema defineTable validators table schema"
  "convex vector compactor blocked runtime policy"
  "docs rag live verification expected source path"
)
latency_file="$RUN_DIR/latencies.tsv"
: > "$latency_file"

for query in "${queries[@]}"; do
  for ((i = 1; i <= SEARCH_REPS; i += 1)); do
    safe_name="$(printf '%s' "$query" | tr -cs 'A-Za-z0-9_' '_' | sed 's/_$//')-$i.json"
    started="$(now_ms)"
    "${DOCS_RAG_CLI[@]}" search \
      --allow-live-search \
      --limit 5 \
      --query "$query" \
      --write "$RUN_DIR/search/$safe_name" >/dev/null
    ended="$(now_ms)"
    jq -e '.ok == true and (.data.results | length) > 0' "$RUN_DIR/search/$safe_name" >/dev/null
    printf '%s\t%s\n' "$query" "$((ended - started))" >> "$latency_file"
  done
done

node - "$latency_file" "$MAX_SEARCH_P95_MS" > "$RUN_DIR/latency.json" <<'NODE'
const { readFileSync } = require('node:fs');
const [, , path, maxP95Raw] = process.argv;
const maxP95Ms = Number(maxP95Raw);
const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
  .map((line) => Number(line.split('\t').at(-1)));
rows.sort((a, b) => a - b);
const percentile = (p) => rows[Math.min(rows.length - 1, Math.ceil((p / 100) * rows.length) - 1)] ?? 0;
const report = {
  samples: rows.length,
  p50Ms: percentile(50),
  p95Ms: percentile(95),
  maxP95Ms,
  ok: rows.length > 0 && percentile(95) <= maxP95Ms,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 30);
NODE

run_step docker-stats docker stats --no-stream --format '{{json .}}' "$CONTAINER" > "$RUN_DIR/docker-stats.json"
jq -e 'type == "object" and (.CPUPerc | type == "string") and (.MemUsage | type == "string")' \
  "$RUN_DIR/docker-stats.json" >/dev/null

cat > "$RUN_DIR/summary.json" <<JSON
{
  "ok": true,
  "runDir": "$RUN_DIR",
  "container": "$CONTAINER",
  "dataset": "$EVAL_DATASET",
  "rebuild": $REBUILD
}
JSON

echo "Docs RAG health: PASS"
echo "artifacts=$RUN_DIR"
