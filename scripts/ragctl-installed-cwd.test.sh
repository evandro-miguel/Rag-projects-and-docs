#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
INSTALLED_CLI="${RAGCTL_INSTALLED_CLI:-${HOME:-$ROOT}/.local/bin/ragctl}"
OFFICIAL_ROOT="${RAGCTL_OFFICIAL_ROOT:-$ROOT/../rag-v2}"
OUTSIDE_CWD="${RAGCTL_OUTSIDE_CWD:-${TMPDIR:-/tmp}}"
TEST_ROOT="$(mktemp -d "$ROOT/.tmp/ragctl-installed-cwd-test.XXXXXX")"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -x "$INSTALLED_CLI" ]] || fail "installed ragctl is not executable"
[[ -d "$OFFICIAL_ROOT" ]] || fail "official source checkout is unavailable"
[[ -d "$OUTSIDE_CWD" ]] || fail "outside-CWD fixture is unavailable"
OFFICIAL_ROOT="$(cd "$OFFICIAL_ROOT" && pwd)"
OUTSIDE_CWD="$(cd "$OUTSIDE_CWD" && pwd)"

run_health() {
  local cwd="$1"
  local output="$2"
  local cli="$3"
  set +e
  (
    cd "$cwd"
    "$cli" health --json 2>/dev/null |
      jq -c '{ok, status:(.data.status // null), freshnessStatus:(.data.docsFreshness.status // null), freshnessReportPath:(.data.docsFreshness.reportPath // null)}'
  ) > "$output"
  local exit_code=$?
  set -e
  return "$exit_code"
}

official_output="$TEST_ROOT/official.json"
outside_output="$TEST_ROOT/outside.json"
repo_output="$TEST_ROOT/repo.json"

run_health "$OFFICIAL_ROOT" "$official_output" "$INSTALLED_CLI" ||
  fail "installed CLI health failed from the official checkout"
jq -e '.ok == true and .freshnessStatus == "ok"' "$official_output" >/dev/null ||
  fail "official installed CLI fingerprint was not healthy"

run_health "$ROOT" "$repo_output" "$ROOT/bin/ragctl" ||
  fail "repo-local CLI health failed from its development checkout"
jq -e --arg root "$ROOT" \
  '.ok == true and .freshnessStatus == "ok" and (.freshnessReportPath | startswith($root + "/.data/"))' \
  "$repo_output" >/dev/null ||
  fail "repo-local CLI did not preserve development-root freshness resolution"

run_health "$OUTSIDE_CWD" "$outside_output" "$INSTALLED_CLI" ||
  fail "installed CLI health failed outside the official checkout"
jq -e --arg root "$OFFICIAL_ROOT" \
  '.ok == true and .freshnessStatus == "ok" and (.freshnessReportPath | startswith($root + "/.data/"))' \
  "$outside_output" >/dev/null ||
  fail "RED: installed CLI freshness follows caller CWD instead of its source checkout"
cmp -s "$official_output" "$outside_output" ||
  fail "RED: installed CLI health fingerprint differs between official and outside CWD"

echo "PASS: installed and repo-local ragctl health fingerprints are CWD-stable"
