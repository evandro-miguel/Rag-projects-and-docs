-- Docs RAG 003: processing provenance and exact embedding-input persistence.
--
-- release-completion T-11 contract:
-- - Persist the EXACT text embedded per chunk and its SHA-256 so stored
--   embeddings are verifiable against their inputs.
-- - Record truthful upstream-vs-processed locations and hashes per document.
-- - Bind every document to its deterministic processing profile so any
--   cleaner/refiner/chunker/redaction/normalization/provider/model/dimension/
--   source-revision change invalidates cached derived data.
--
-- Legacy backfill policy (truthful, never fabricated):
-- - processed_content_sha256 is recomputed from the persisted processed body,
--   which is exactly what historical upserts indexed.
-- - Chunk-kind embeddings are reconstructed as the bounded chunk searchable
--   text (falling back to content when searchable_text was empty) that
--   historical embedding fetches actually sent to the provider.
-- - Document-level embeddings predate chunking; their exact provider input
--   cannot be derived from stored data, so their provenance columns stay NULL:
--   an explicit "unknown" state, never a fabricated empty input or hash.
-- - upstream_path is recovered from metadata.rawSourcePath when present;
--   upstream_content_sha256 stays NULL where the raw bytes cannot be derived.
--
-- Nullability contract: embedding_input_text/embedding_input_sha256 remain
-- nullable for legacy document-level rows only. New chunk-kind writes MUST
-- always persist both exact values; the schema-migration postcondition probe
-- enforces that no chunk-kind row lacks them.

BEGIN;

ALTER TABLE docs_documents
  ADD COLUMN IF NOT EXISTS upstream_path text,
  ADD COLUMN IF NOT EXISTS upstream_content_sha256 text,
  ADD COLUMN IF NOT EXISTS processed_path text,
  ADD COLUMN IF NOT EXISTS processed_content_sha256 text,
  ADD COLUMN IF NOT EXISTS processing_profile_hash text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS processing_profile jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE docs_documents
SET processed_path = COALESCE(processed_path, source_absolute_path),
    processed_content_sha256 = COALESCE(
      processed_content_sha256,
      encode(sha256(convert_to(content, 'UTF8')), 'hex')
    ),
    upstream_path = COALESCE(upstream_path, NULLIF(metadata->>'rawSourcePath', '')),
    upstream_content_sha256 = COALESCE(
      upstream_content_sha256,
      NULLIF(metadata->>'rawSourceSha256', '')
    );

ALTER TABLE docs_embeddings
  ADD COLUMN IF NOT EXISTS embedding_input_text text,
  ADD COLUMN IF NOT EXISTS embedding_input_sha256 text;

-- Backfill ONLY where the exact historical provider input is derivable:
-- chunk-kind embeddings sent `left(coalesce(nullif(searchable_text, ''), content), 2000)` at request time.
-- Document-level rows are left NULL (explicitly unknown provenance).
UPDATE docs_embeddings e
SET embedding_input_text = left(coalesce(nullif(c.searchable_text, ''), c.content), 2000),
    embedding_input_sha256 = encode(
      sha256(convert_to(left(coalesce(nullif(c.searchable_text, ''), c.content), 2000), 'UTF8')), 'hex'
    )
FROM docs_chunks c
WHERE e.chunk_id = c.id
  AND (e.embedding_input_text IS NULL OR e.embedding_input_sha256 IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'docs_embeddings'::regclass
      AND conname = 'docs_embeddings_chunk_input_provenance_check'
  ) THEN
    ALTER TABLE docs_embeddings
      ADD CONSTRAINT docs_embeddings_chunk_input_provenance_check
      CHECK (
        embedding_kind <> 'chunk'
        OR (embedding_input_text IS NOT NULL AND embedding_input_sha256 IS NOT NULL)
      );
  END IF;
END
$$;

ALTER TABLE docs_documents
  ALTER COLUMN processing_profile_hash SET STATISTICS 100;

CREATE INDEX IF NOT EXISTS docs_documents_processing_profile_hash_idx
  ON docs_documents (processing_profile_hash);

COMMIT;
