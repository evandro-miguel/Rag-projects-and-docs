#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
TEST_ROOT="$(mktemp -d "$ROOT/.tmp/verify-docs-rag-live-test.XXXXXX")"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

FIXTURE_ROOT="$TEST_ROOT/fixture"
CAPTURE_FILE="$TEST_ROOT/database-url.txt"
CALLER_URL='postgres://caller-lane@127.0.0.1:6550/docs_caller'
FILE_URL='postgres://file-lane@127.0.0.1:6551/docs_file'

mkdir -p "$FIXTURE_ROOT/bin" "$FIXTURE_ROOT/scripts"
cp "$ROOT/scripts/verify-docs-rag-live.sh" "$FIXTURE_ROOT/scripts/verify-docs-rag-live.sh"
chmod +x "$FIXTURE_ROOT/scripts/verify-docs-rag-live.sh"
printf 'DOCS_RAG_PG_LAB_DATABASE_URL=%s\n' "$FILE_URL" > "$FIXTURE_ROOT/.env.local"

cat > "$FIXTURE_ROOT/bin/ragctl" <<'RAGCTL'
#!/usr/bin/env bash
set -euo pipefail

[[ "$*" == docs\ search\ * ]] || {
  echo "Unexpected ragctl invocation: $*" >&2
  exit 99
}

echo "$DOCS_RAG_PG_LAB_DATABASE_URL" > "$CAPTURE_FILE"
if [[ "${RAGCTL_PROVENANCE:-complete}" == complete ]]; then
  printf '%s\n' '{"ok":true,"data":{"results":[{"sourcePath":"ingest/processed/external/bun-docs/runtime/http/error-handling.mdx","content":"Bun.serve error callback Response","title":"fixture","canonicalUrl":"https://github.com/oven-sh/bun/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/docs/runtime/http/error-handling.mdx","sourceRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","provenanceStatus":"complete","missingFields":[]}]}}'
elif [[ "${RAGCTL_PROVENANCE}" == foreign ]]; then
  printf '%s\n' '{"ok":true,"data":{"results":[{"sourcePath":"ingest/processed/external/bun-docs/runtime/http/error-handling.mdx","content":"Bun.serve error callback Response","title":"fixture","canonicalUrl":"https://evil.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/docs/runtime/http/error-handling.mdx","sourceRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","provenanceStatus":"complete","missingFields":[]}]}}'
else
  printf '%s\n' '{"ok":true,"data":{"results":[{"sourcePath":"ingest/processed/external/bun-docs/runtime/http/error-handling.mdx","content":"Bun.serve error callback Response","title":"fixture","canonicalUrl":null,"sourceRevision":null,"provenanceStatus":"degraded","missingFields":["canonicalUrl","sourceRevision"]}]}}'
fi
RAGCTL
chmod +x "$FIXTURE_ROOT/bin/ragctl"

set +e
(
  cd "$FIXTURE_ROOT"
  DOCS_RAG_PG_LAB_DATABASE_URL="$CALLER_URL" \
    DOCS_RAG_LIVE_MODE=vector \
    CAPTURE_FILE="$CAPTURE_FILE" \
    bash "$FIXTURE_ROOT/scripts/verify-docs-rag-live.sh"
) > "$TEST_ROOT/stdout" 2> "$TEST_ROOT/stderr"
status=$?
set -e

[[ "$status" -eq 0 ]] || fail "synthetic verifier lane failed before precedence assertion (status $status)"
[[ -f "$CAPTURE_FILE" ]] || fail "fake ragctl did not observe the selected database lane"
[[ "$(< "$CAPTURE_FILE")" == "$CALLER_URL" ]] || \
  fail "RED: verifier sources .env.local over the explicit caller-selected configuration"

DEFAULT_CAPTURE_FILE="$TEST_ROOT/default-database-url.txt"
set +e
(
  cd "$FIXTURE_ROOT"
  env -u DOCS_RAG_PG_LAB_DATABASE_URL \
    DOCS_RAG_LIVE_MODE=vector \
    CAPTURE_FILE="$DEFAULT_CAPTURE_FILE" \
    bash "$FIXTURE_ROOT/scripts/verify-docs-rag-live.sh"
) > "$TEST_ROOT/default-stdout" 2> "$TEST_ROOT/default-stderr"
default_status=$?
set -e

[[ "$default_status" -eq 0 ]] || fail "synthetic verifier default lane failed (status $default_status)"
[[ -f "$DEFAULT_CAPTURE_FILE" ]] || fail "fake ragctl did not observe the .env.local database lane"
[[ "$(< "$DEFAULT_CAPTURE_FILE")" == "$FILE_URL" ]] || \
  fail "RED: verifier did not source .env.local when the caller left the database lane unset"

set +e
(
  cd "$FIXTURE_ROOT"
  env -u DOCS_RAG_PG_LAB_DATABASE_URL \
    DOCS_RAG_LIVE_MODE=vector \
    RAGCTL_PROVENANCE=degraded \
    CAPTURE_FILE="$TEST_ROOT/degraded-database-url.txt" \
    bash "$FIXTURE_ROOT/scripts/verify-docs-rag-live.sh"
) > "$TEST_ROOT/degraded-stdout" 2> "$TEST_ROOT/degraded-stderr"
degraded_status=$?
set -e

[[ "$degraded_status" -ne 0 ]] || fail "RED: verifier accepted degraded provenance"

set +e
(
  cd "$FIXTURE_ROOT"
  env -u DOCS_RAG_PG_LAB_DATABASE_URL \
    DOCS_RAG_LIVE_MODE=vector \
    RAGCTL_PROVENANCE=foreign \
    CAPTURE_FILE="$TEST_ROOT/foreign-database-url.txt" \
    bash "$FIXTURE_ROOT/scripts/verify-docs-rag-live.sh"
) > "$TEST_ROOT/foreign-stdout" 2> "$TEST_ROOT/foreign-stderr"
foreign_status=$?
set -e

[[ "$foreign_status" -ne 0 ]] || fail "RED: verifier accepted a foreign citation URL"

echo "PASS: verifier preserves explicit precedence and retains .env.local defaults"
