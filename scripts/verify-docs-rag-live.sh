#!/bin/bash
#
# @module scripts/verify-docs-rag-live
# @description Verify Docs RAG answers a real documentation question from the
# live Postgres-backed index, not just that search returns ok=true.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${DOCS_RAG_PG_LAB_DATABASE_URL:-}" ] && [ -f "$PROJECT_ROOT/.env.local" ]; then
  set +u
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/.env.local"
  set +a
  set -u
fi

DOCS_RAG_LIVE_QUERY="${DOCS_RAG_LIVE_QUERY:-Bun.serve error callback Response}"
DOCS_RAG_LIVE_SOURCE="${DOCS_RAG_LIVE_SOURCE:-bun-docs}"
DOCS_RAG_LIVE_EXPECTED_SOURCE_PATH="${DOCS_RAG_LIVE_EXPECTED_SOURCE_PATH:-ingest/processed/external/bun-docs/runtime/http/error-handling.mdx}"
DOCS_RAG_LIVE_REQUIRED_TERMS="${DOCS_RAG_LIVE_REQUIRED_TERMS:-Bun.serve,error,Response}"
DOCS_RAG_LIVE_MODE="${DOCS_RAG_LIVE_MODE:-hybrid}"
DOCS_RAG_ALLOW_DEGRADED="${DOCS_RAG_ALLOW_DEGRADED:-0}"
if [ -z "${DOCS_RAG_PG_LAB_DATABASE_URL:-}" ]; then
  echo "[ERROR] DOCS_RAG_PG_LAB_DATABASE_URL is required — set to your Postgres connection string (e.g., postgres://user:pass@host:port/dbname)" >&2
  exit 1
fi
: "${DOCS_RAG_PG_LAB_ENABLE_EMBEDDING:=true}"
export DOCS_RAG_PG_LAB_DATABASE_URL
export DOCS_RAG_PG_LAB_ENABLE_EMBEDDING

case "$DOCS_RAG_LIVE_MODE" in
  hybrid|vector) ;;
  keyword)
    echo "[ERROR] DOCS_RAG_LIVE_MODE=keyword is not a finalization gate. Use ragctl keyword search only as a manual smoke check." >&2
    exit 1
    ;;
  *)
    echo "[ERROR] DOCS_RAG_LIVE_MODE must be hybrid or vector for finalization" >&2
    exit 1
    ;;
esac

if [[ "$DOCS_RAG_ALLOW_DEGRADED" == "1" ]]; then
  echo "[ERROR] DOCS_RAG_ALLOW_DEGRADED=1 is not allowed in the finalization Docs RAG live gate" >&2
  exit 1
fi

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT

cd "$PROJECT_ROOT"

echo "[INFO] Docs RAG live answer check"
echo "[INFO] Backend: Docs RAG Postgres"
echo "[INFO] Query: $DOCS_RAG_LIVE_QUERY"
echo "[INFO] Source: $DOCS_RAG_LIVE_SOURCE"
echo "[INFO] Mode: $DOCS_RAG_LIVE_MODE"

./bin/ragctl docs search \
  "$DOCS_RAG_LIVE_QUERY" \
  --source "$DOCS_RAG_LIVE_SOURCE" \
  --mode "$DOCS_RAG_LIVE_MODE" \
  --json >"$OUTPUT_FILE"

node --input-type=module - \
  "$OUTPUT_FILE" \
  "$DOCS_RAG_LIVE_EXPECTED_SOURCE_PATH" \
  "$DOCS_RAG_LIVE_REQUIRED_TERMS" <<'NODE'
import { readFileSync } from 'node:fs';

const [outputFile, expectedSourcePath, requiredTermsRaw] = process.argv.slice(2);
const fail = (message) => {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
};

const rawOutput = readFileSync(outputFile, 'utf8');
const parsePayload = (raw) => {
  for (let index = raw.indexOf('{'); index !== -1; index = raw.indexOf('{', index + 1)) {
    try {
      return JSON.parse(raw.slice(index));
    } catch {
      // CLI output can include runtime log lines before JSON. Try the next object.
    }
  }
  fail(`ragctl docs search did not emit parseable JSON. Output prefix: ${raw.slice(0, 200)}`);
};

const payload = parsePayload(rawOutput);

if (payload.ok !== true) {
  fail('ragctl docs search did not return ok=true');
}

const warnings = [
  ...(Array.isArray(payload.warnings) ? payload.warnings : []),
  ...(Array.isArray(payload.data?.warnings) ? payload.data.warnings : []),
];
const uniqueWarnings = [...new Set(warnings.map((warning) => String(warning)))];
const degradedVectorSearch = warnings.some((warning) =>
  String(warning).toLowerCase().includes('vector search failed')
);
if (degradedVectorSearch) {
  fail(
    `Docs RAG search completed with degraded vector retrieval: ${uniqueWarnings.join('; ')}. Finalization requires non-degraded vector retrieval.`
  );
}

const results = payload.data?.results;
if (!Array.isArray(results) || results.length === 0) {
  fail('Docs RAG returned no results');
}

const expected = String(expectedSourcePath).toLowerCase();
const matchingResult = results.find((result) =>
  String(result.sourcePath ?? '').toLowerCase() === expected
);

if (!matchingResult) {
  fail(`Expected sourcePath ${expectedSourcePath}, got ${results.map((r) => r.sourcePath).join(', ')}`);
}

const canonicalUrl = String(matchingResult.canonicalUrl ?? '');
const sourceRevision = String(matchingResult.sourceRevision ?? '');
const provenanceStatus = String(matchingResult.provenanceStatus ?? '');
const missingFields = Array.isArray(matchingResult.missingFields)
  ? matchingResult.missingFields.map((field) => String(field))
  : [];
if (provenanceStatus !== 'complete' || missingFields.length > 0) {
  fail(
    `Expected complete provenance for ${expectedSourcePath}; status=${provenanceStatus || 'missing'}, missing=${missingFields.join(', ') || 'none'}`
  );
}
let citationUrl;
try {
  citationUrl = new URL(canonicalUrl);
} catch {
  fail(`Expected an HTTPS revision-bound canonical citation for ${expectedSourcePath}`);
}
const revisionMarker = `/blob/${sourceRevision}/`;
const treeRevisionMarker = `/tree/${sourceRevision}/`;
if (
  citationUrl?.protocol !== 'https:' ||
  !sourceRevision ||
  (!citationUrl.pathname.includes(revisionMarker) &&
    !citationUrl.pathname.includes(treeRevisionMarker))
) {
  fail(`Expected an HTTPS revision-bound canonical citation for ${expectedSourcePath}`);
}

const answerText = String(matchingResult.content ?? '');
const answerTextLower = answerText.toLowerCase();
const requiredTerms = String(requiredTermsRaw)
  .split(',')
  .map((term) => term.trim())
  .filter(Boolean);

const missingTerms = requiredTerms.filter((term) => !answerTextLower.includes(term.toLowerCase()));
if (missingTerms.length > 0) {
  fail(`Docs RAG result did not answer the validation question; missing terms: ${missingTerms.join(', ')}`);
}

console.log('[OK] Docs RAG live answer check passed');
console.log(`[OK] Top matching source: ${matchingResult.title ?? '(untitled)'} (${matchingResult.sourcePath})`);
console.log(`[OK] Required answer terms present: ${requiredTerms.join(', ')}`);
NODE
