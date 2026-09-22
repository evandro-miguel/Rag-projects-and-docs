-- Docs RAG 005: validate every non-legacy generation before publication.
--
-- Migration 004 established lifecycle and source/count checks.  This
-- replacement keeps those checks and adds the provenance/profile contract for
-- new generations. Historical rows are exempt only when migration 004's
-- already-serving pointer was captured into the sealed membership table below.

BEGIN;

-- The migration runner holds this same database-global lock.  Acquire its
-- transaction-scoped form as well so a direct SQL upgrade cannot classify
-- migration-004 generations while another writer is changing their fields.
SELECT pg_advisory_xact_lock(8675309001::bigint);

ALTER TABLE docs_source_generations
  ADD COLUMN IF NOT EXISTS provenance_class text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'docs_source_generations'::regclass
      AND conname = 'docs_source_generations_provenance_class_check'
  ) THEN
    ALTER TABLE docs_source_generations
      ADD CONSTRAINT docs_source_generations_provenance_class_check
      CHECK (
        provenance_class IS NULL
        OR provenance_class IN ('revision_bound_external', 'processed_external_import')
      );
  END IF;
END
$$;

-- A migration-004 upgrade may contain one already-serving legacy generation per
-- source. Capture only those genuine pointer targets before sealing the table;
-- an exact legacy-looking key/hash is not an exemption by itself.
CREATE TABLE IF NOT EXISTS docs_rag_legacy_generation_exemptions (
  source_id text PRIMARY KEY,
  generation_id bigint NOT NULL UNIQUE,
  generation_key text NOT NULL,
  processing_profile_hash text NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_rag_legacy_generation_exemptions_generation_fk
    FOREIGN KEY (generation_id) REFERENCES docs_source_generations(id) ON DELETE RESTRICT,
  CONSTRAINT docs_rag_legacy_generation_exemptions_key_check
    CHECK (generation_key = 'legacy-' || md5(source_id)),
  CONSTRAINT docs_rag_legacy_generation_exemptions_profile_check
    CHECK (processing_profile_hash = 'legacy')
);

INSERT INTO docs_rag_legacy_generation_exemptions (
  source_id, generation_id, generation_key, processing_profile_hash
)
SELECT p.source_id, p.generation_id, g.generation_key, g.processing_profile_hash
FROM docs_source_generation_pointers p
JOIN docs_source_generations g
  ON g.id = p.generation_id
 AND g.source_id = p.source_id
WHERE g.status = 'published'
  AND g.generation_key = 'legacy-' || md5(g.source_id)
  AND g.processing_profile_hash = 'legacy'
  AND g.processing_profile = '{}'::jsonb
  AND g.upstream_revision IS NULL
  AND g.upstream_path IS NULL
  AND g.raw_manifest_sha256 IS NULL
  AND g.license IS NULL
  AND g.expected_document_count > 0
  AND g.expected_document_count = g.indexed_document_count
  AND g.expected_document_count = (
    SELECT count(*)::integer
    FROM docs_documents d
    WHERE d.generation_id = g.id
      AND d.source_id = p.source_id
      AND d.status = 'indexed'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM docs_documents d
    WHERE d.generation_id = g.id
      AND (d.source_id IS DISTINCT FROM p.source_id OR d.status IS DISTINCT FROM 'indexed')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM docs_rag_legacy_generation_exemptions e
    WHERE e.source_id = p.source_id
       OR e.generation_id = p.generation_id
  )
ON CONFLICT DO NOTHING;

-- Classify the rows that migration 004 could have left behind while the
-- runner lock is held. A complete upstream pair is external; a pair that is
-- absent is an import. Anything half-populated is deliberately left
-- unclassified so a published row aborts the upgrade instead of being guessed.
-- Migration 004 makes published generations immutable. The new class is a
-- migration-owned backfill, so hold the table lock while replacing that
-- trigger for these updates; the transaction rolls back to the original
-- trigger on failure and no concurrent writer can observe the gap.
DROP TRIGGER IF EXISTS docs_source_generations_reject_published_update
  ON docs_source_generations;

UPDATE docs_source_generations g
SET provenance_class = 'processed_external_import'
FROM docs_rag_legacy_generation_exemptions e
WHERE g.id = e.generation_id
  AND g.source_id = e.source_id
  AND g.provenance_class IS NULL;

UPDATE docs_source_generations
SET provenance_class = 'revision_bound_external'
WHERE provenance_class IS NULL
  AND upstream_revision IS NOT NULL
  AND btrim(upstream_revision) <> ''
  AND upstream_path IS NOT NULL
  AND btrim(upstream_path) <> '';

UPDATE docs_source_generations
SET provenance_class = 'processed_external_import'
WHERE provenance_class IS NULL
  AND upstream_revision IS NULL
  AND upstream_path IS NULL;

DO $$
BEGIN
IF EXISTS (
    SELECT 1
    FROM docs_source_generations
    WHERE status = 'published'
      AND provenance_class IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;
END
$$;

CREATE TRIGGER docs_source_generations_reject_published_update
BEFORE INSERT OR UPDATE OR DELETE ON docs_source_generations
FOR EACH ROW
EXECUTE FUNCTION docs_rag_reject_published_generation_mutation();

CREATE OR REPLACE FUNCTION docs_rag_reject_legacy_generation_exemption_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Docs RAG legacy generation exemptions are sealed and immutable';
END;
$$;

DROP TRIGGER IF EXISTS docs_rag_legacy_generation_exemptions_sealed
  ON docs_rag_legacy_generation_exemptions;
CREATE TRIGGER docs_rag_legacy_generation_exemptions_sealed
BEFORE INSERT OR UPDATE OR DELETE ON docs_rag_legacy_generation_exemptions
FOR EACH ROW
EXECUTE FUNCTION docs_rag_reject_legacy_generation_exemption_mutation();
DROP TRIGGER IF EXISTS docs_rag_legacy_generation_exemptions_truncate_sealed
  ON docs_rag_legacy_generation_exemptions;
CREATE TRIGGER docs_rag_legacy_generation_exemptions_truncate_sealed
BEFORE TRUNCATE ON docs_rag_legacy_generation_exemptions
FOR EACH STATEMENT
EXECUTE FUNCTION docs_rag_reject_legacy_generation_exemption_mutation();

CREATE OR REPLACE FUNCTION docs_rag_assert_generation_publishable(
  p_generation_id bigint,
  p_source_id text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  generation_source_id text;
  generation_provenance_class text;
  generation_key_value text;
  generation_status text;
  generation_scan_state text;
  generation_upstream_revision text;
  generation_upstream_path text;
  generation_license text;
  generation_raw_manifest_sha256 text;
  generation_profile_hash_value text;
  generation_profile jsonb;
  expected_count bigint;
  indexed_count bigint;
  document_count bigint;
  indexed_document_count bigint;
  source_document_count bigint;
  profile_embedding_provider text;
  profile_embedding_model text;
  profile_version_text text;
  profile_cleaner text;
  profile_refiner text;
  profile_chunker text;
  profile_redaction text;
  profile_normalization text;
  profile_provider text;
  profile_model text;
  profile_dimensions_text text;
  profile_chunk_size_text text;
  profile_chunk_overlap_text text;
  profile_input_max_chars_text text;
  profile_source_revision text;
  profile_key_count integer;
  profile_version_value bigint;
  profile_dimensions_value bigint;
  profile_chunk_size_value bigint;
  profile_chunk_overlap_value bigint;
  profile_input_max_chars_value bigint;
  profile_embedding_dimensions integer;
  profile_embedding_input_max_chars integer;
  generation_is_external boolean;
  legacy_generation boolean;
  computed_profile_hash text;
  computed_generation_key text;
BEGIN
  SELECT g.source_id,
         g.provenance_class,
         g.generation_key,
         g.status,
         g.scan_state,
         g.upstream_revision,
         g.upstream_path,
         g.license,
         g.raw_manifest_sha256,
         g.processing_profile_hash,
         g.processing_profile,
         g.expected_document_count,
         g.indexed_document_count
  INTO generation_source_id,
       generation_provenance_class,
       generation_key_value,
         generation_status,
         generation_scan_state,
         generation_upstream_revision,
         generation_upstream_path,
         generation_license,
         generation_raw_manifest_sha256,
         generation_profile_hash_value,
         generation_profile,
         expected_count,
         indexed_count
  FROM docs_source_generations g
  WHERE g.id = p_generation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'COUNT_INVALID';
  END IF;

  IF generation_source_id IS DISTINCT FROM p_source_id THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  -- These are the complete-generation and serving-state checks introduced by
  -- migration 004.  Keep them ahead of the stricter derived-data checks.
  IF generation_status IS DISTINCT FROM 'published'
     OR generation_scan_state IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'COUNT_INVALID';
  END IF;

  SELECT count(*)::bigint,
         count(*) FILTER (WHERE source_id = p_source_id)::bigint,
         count(*) FILTER (WHERE status = 'indexed')::bigint
    INTO document_count, source_document_count, indexed_document_count
  FROM docs_documents
  WHERE generation_id = p_generation_id;

  IF expected_count <> indexed_count
     OR document_count <> expected_count
     OR source_document_count <> document_count
     OR indexed_document_count <> expected_count THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'COUNT_INVALID';
  END IF;

  -- Foreign keys normally make this implication automatic.  Keep the
  -- explicit assertion so a future derived table cannot silently attach rows
  -- to an empty published generation.
  IF expected_count = 0
     AND (
       EXISTS (
         SELECT 1
         FROM docs_chunks c
         JOIN docs_documents d ON d.id = c.document_id
         WHERE d.generation_id = p_generation_id
       )
       OR EXISTS (
         SELECT 1
         FROM docs_embeddings e
         JOIN docs_documents d ON d.id = e.document_id
         WHERE d.generation_id = p_generation_id
       )
       OR EXISTS (
         SELECT 1
         FROM docs_embeddings e
         JOIN docs_chunks c ON c.id = e.chunk_id
         JOIN docs_documents d ON d.id = c.document_id
         WHERE d.generation_id = p_generation_id
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'COUNT_INVALID';
  END IF;

  legacy_generation := EXISTS (
    SELECT 1
    FROM docs_rag_legacy_generation_exemptions e
    WHERE e.source_id = generation_source_id
      AND e.generation_id = p_generation_id
      AND e.generation_key = generation_key_value
      AND e.processing_profile_hash = generation_profile_hash_value
  );
  IF legacy_generation THEN
    RETURN;
  END IF;

  IF generation_provenance_class IS NULL
     OR generation_provenance_class NOT IN (
       'revision_bound_external', 'processed_external_import'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;
  generation_is_external := generation_provenance_class = 'revision_bound_external';
  IF generation_is_external THEN
    IF generation_upstream_revision IS NULL
       OR btrim(generation_upstream_revision) = ''
       OR generation_upstream_path IS NULL
       OR btrim(generation_upstream_path) = ''
       OR generation_license IS NULL
       OR btrim(generation_license) = '' THEN
      RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
    END IF;
  ELSIF generation_upstream_revision IS NOT NULL
     OR generation_upstream_path IS NOT NULL
     OR generation_license IS DISTINCT FROM 'NOASSERTION' THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  -- A non-legacy generation must carry a complete, deterministic processing
  -- identity.  The profile values are also used below to bind each embedding
  -- to the exact provider/model/dimension/input contract for this generation.
  IF generation_raw_manifest_sha256 IS NULL
     OR generation_raw_manifest_sha256 !~ '^[0-9a-f]{64}$'
     OR generation_profile_hash_value IS NULL
     OR generation_profile_hash_value !~ '^[0-9a-f]{64}$'
     OR generation_profile IS NULL
     OR jsonb_typeof(generation_profile) <> 'object'
     OR generation_profile = '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  IF generation_is_external
     AND (
       generation_upstream_revision !~* '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
       OR generation_upstream_path IS NULL
       OR btrim(generation_upstream_path) = ''
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;
  SELECT count(*)::integer
    INTO profile_key_count
  FROM jsonb_object_keys(generation_profile) AS profile_key_item(profile_key);
  IF (
       generation_is_external
       AND profile_key_count <> 13
     )
     OR (
       NOT generation_is_external
       AND profile_key_count <> 12
       AND NOT (
         profile_key_count = 13
         AND generation_profile ? 'sourceRevision'
         AND jsonb_typeof(generation_profile->'sourceRevision') = 'null'
       )
     )
     OR NOT (
       generation_profile ?& ARRAY[
         'profileVersion', 'cleaner', 'refiner', 'chunker', 'redaction',
         'normalization', 'provider', 'model', 'dimensions', 'chunkSize',
         'chunkOverlap', 'embeddingInputMaxChars'
       ]
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_object_keys(generation_profile) AS profile_key_item(profile_key)
       WHERE profile_key_item.profile_key NOT IN (
         'profileVersion', 'cleaner', 'refiner', 'chunker', 'redaction',
         'normalization', 'provider', 'model', 'dimensions', 'chunkSize',
         'chunkOverlap', 'embeddingInputMaxChars', 'sourceRevision'
       )
     )
     OR generation_is_external AND NOT (generation_profile ? 'sourceRevision')
     OR NOT generation_is_external
        AND generation_profile ? 'sourceRevision'
        AND jsonb_typeof(generation_profile->'sourceRevision') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  profile_version_text := generation_profile->>'profileVersion';
  profile_cleaner := generation_profile->>'cleaner';
  profile_refiner := generation_profile->>'refiner';
  profile_chunker := generation_profile->>'chunker';
  profile_redaction := generation_profile->>'redaction';
  profile_normalization := generation_profile->>'normalization';
  profile_provider := generation_profile->>'provider';
  profile_model := generation_profile->>'model';
  profile_dimensions_text := generation_profile->>'dimensions';
  profile_chunk_size_text := generation_profile->>'chunkSize';
  profile_chunk_overlap_text := generation_profile->>'chunkOverlap';
  profile_input_max_chars_text := generation_profile->>'embeddingInputMaxChars';
  profile_source_revision := generation_profile->>'sourceRevision';
  IF jsonb_typeof(generation_profile->'profileVersion') IS DISTINCT FROM 'number'
     OR profile_version_text !~ '^[0-9]{1,10}$'
     OR jsonb_typeof(generation_profile->'cleaner') IS DISTINCT FROM 'string'
     OR btrim(profile_cleaner) = ''
     OR jsonb_typeof(generation_profile->'refiner') IS DISTINCT FROM 'string'
     OR btrim(profile_refiner) = ''
     OR jsonb_typeof(generation_profile->'chunker') IS DISTINCT FROM 'string'
     OR btrim(profile_chunker) = ''
     OR jsonb_typeof(generation_profile->'redaction') IS DISTINCT FROM 'string'
     OR btrim(profile_redaction) = ''
     OR jsonb_typeof(generation_profile->'normalization') IS DISTINCT FROM 'string'
     OR btrim(profile_normalization) = ''
     OR jsonb_typeof(generation_profile->'provider') IS DISTINCT FROM 'string'
     OR btrim(profile_provider) = ''
     OR jsonb_typeof(generation_profile->'model') IS DISTINCT FROM 'string'
     OR btrim(profile_model) = ''
     OR jsonb_typeof(generation_profile->'dimensions') IS DISTINCT FROM 'number'
     OR profile_dimensions_text !~ '^[0-9]{1,10}$'
     OR jsonb_typeof(generation_profile->'chunkSize') IS DISTINCT FROM 'number'
     OR profile_chunk_size_text !~ '^[0-9]{1,10}$'
     OR jsonb_typeof(generation_profile->'chunkOverlap') IS DISTINCT FROM 'number'
     OR profile_chunk_overlap_text !~ '^[0-9]{1,10}$'
     OR jsonb_typeof(generation_profile->'embeddingInputMaxChars') IS DISTINCT FROM 'number'
     OR profile_input_max_chars_text !~ '^[0-9]{1,10}$'
     OR generation_is_external
        AND jsonb_typeof(generation_profile->'sourceRevision') IS DISTINCT FROM 'string'
     OR NOT generation_is_external
        AND generation_profile ? 'sourceRevision'
        AND jsonb_typeof(generation_profile->'sourceRevision') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  profile_version_value := profile_version_text::bigint;
  profile_dimensions_value := profile_dimensions_text::bigint;
  profile_chunk_size_value := profile_chunk_size_text::bigint;
  profile_chunk_overlap_value := profile_chunk_overlap_text::bigint;
  profile_input_max_chars_value := profile_input_max_chars_text::bigint;
  IF profile_version_value <> 1
     OR profile_dimensions_value <> 1024
     OR profile_chunk_size_value <= 0
     OR profile_chunk_size_value > 2147483647
     OR profile_chunk_overlap_value < 0
     OR profile_chunk_overlap_value > 2147483647
     OR profile_input_max_chars_value <= 0
     OR profile_input_max_chars_value > 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  IF generation_is_external
     AND (
       btrim(profile_source_revision) = ''
       OR profile_source_revision IS DISTINCT FROM generation_upstream_revision
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  IF NOT generation_is_external
     AND (
       profile_cleaner IS DISTINCT FROM 'none'
       OR profile_refiner IS DISTINCT FROM 'none'
       OR profile_redaction IS DISTINCT FROM 'none'
       OR profile_normalization IS DISTINCT FROM 'none'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  -- Match docsRagProcessingProfileHash exactly: stable key order, JSON string
  -- escaping, and integer JSON numbers rather than PostgreSQL jsonb's
  -- key-sorted serialization.
  computed_profile_hash := encode(
    sha256(convert_to(
      '{"chunker":' || to_json(profile_chunker)::text ||
      ',"chunkOverlap":' || to_json(profile_chunk_overlap_value)::text ||
      ',"chunkSize":' || to_json(profile_chunk_size_value)::text ||
      ',"cleaner":' || to_json(profile_cleaner)::text ||
      ',"dimensions":' || to_json(profile_dimensions_value)::text ||
      ',"embeddingInputMaxChars":' || to_json(profile_input_max_chars_value)::text ||
      ',"model":' || to_json(profile_model)::text ||
      ',"normalization":' || to_json(profile_normalization)::text ||
      ',"profileVersion":' || to_json(profile_version_value)::text ||
      ',"provider":' || to_json(profile_provider)::text ||
      ',"redaction":' || to_json(profile_redaction)::text ||
      ',"refiner":' || to_json(profile_refiner)::text ||
      ',"sourceRevision":' || COALESCE(to_json(profile_source_revision)::text, 'null') ||
      '}',
      'UTF8'
    )),
    'hex'
  );
  IF generation_profile_hash_value IS DISTINCT FROM computed_profile_hash THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  -- Match buildDocsRagSourceGenerationKey exactly, including object order.
  computed_generation_key := encode(
    sha256(convert_to(
      '{"processingProfileHash":' || to_json(generation_profile_hash_value)::text ||
      ',"rawManifestSha256":' || to_json(generation_raw_manifest_sha256)::text ||
      ',"sourceId":' || to_json(generation_source_id)::text ||
      ',"upstreamRevision":' || COALESCE(to_json(generation_upstream_revision)::text, 'null') ||
      '}',
      'UTF8'
    )),
    'hex'
  );
  IF generation_key_value IS DISTINCT FROM computed_generation_key THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;
  profile_embedding_provider := profile_provider;
  profile_embedding_model := profile_model;
  profile_embedding_dimensions := profile_dimensions_value::integer;
  profile_embedding_input_max_chars := profile_input_max_chars_value::integer;

  -- Every document must retain the generation's exact profile and truthful
  -- processed content hash.  External generations must also retain complete
  -- upstream citation provenance; duplicate provenance metadata cannot drift
  -- from the dedicated columns.
  IF EXISTS (
    SELECT 1
    FROM docs_documents d
    WHERE d.generation_id = p_generation_id
      AND (
        d.source_id IS DISTINCT FROM generation_source_id
        OR d.status IS DISTINCT FROM 'indexed'
        OR d.processing_profile_hash IS DISTINCT FROM generation_profile_hash_value
        OR d.processing_profile IS DISTINCT FROM generation_profile
        OR d.content_hash IS NULL
        OR d.content_hash !~ '^[0-9a-f]{64}$'
        OR d.processed_path IS NULL
        OR btrim(d.processed_path) = ''
        OR d.processed_content_sha256 IS NULL
        OR d.processed_content_sha256 !~ '^[0-9a-f]{64}$'
        OR d.processed_content_sha256 IS DISTINCT FROM encode(
          sha256(convert_to(d.content, 'UTF8')), 'hex'
        )
        OR (
          d.upstream_path IS NULL
          AND d.upstream_content_sha256 IS NOT NULL
        )
        OR (
          d.upstream_path IS NOT NULL
          AND d.upstream_content_sha256 IS NULL
        )
        OR d.upstream_content_sha256 IS NOT NULL
           AND (
             d.upstream_content_sha256 !~ '^[0-9a-f]{64}$'
             OR d.upstream_path IS NULL
             OR btrim(d.upstream_path) = ''
             OR d.upstream_content_sha256 IS DISTINCT FROM d.content_hash
           )
        OR generation_is_external
           AND (
             d.canonical_url IS NULL
             OR btrim(d.canonical_url) = ''
             OR d.canonical_url !~* '^https://'
             OR d.authority IS NULL
             OR btrim(d.authority) = ''
             OR d.upstream_path IS NULL
             OR btrim(d.upstream_path) = ''
             OR d.upstream_content_sha256 IS NULL
             OR d.upstream_content_sha256 !~ '^[0-9a-f]{64}$'
             OR d.upstream_content_sha256 IS DISTINCT FROM d.content_hash
           )
        OR NOT generation_is_external
           AND (
             d.canonical_url IS NOT NULL
             OR d.upstream_path IS NOT NULL
             OR d.upstream_content_sha256 IS NOT NULL
             OR d.metadata ? 'canonicalUrl'
             OR d.metadata ? 'sourceRevision'
             OR d.metadata ? 'upstreamPath'
             OR d.metadata ? 'rawSourcePath'
             OR d.metadata ? 'rawSourceSha256'
           )
        OR d.metadata ? 'canonicalUrl'
           AND (
             jsonb_typeof(d.metadata->'canonicalUrl') IS DISTINCT FROM 'string'
             OR btrim(d.metadata->>'canonicalUrl') = ''
             OR d.metadata->>'canonicalUrl' IS DISTINCT FROM d.canonical_url
           )
        OR d.metadata ? 'authority'
           AND (
             jsonb_typeof(d.metadata->'authority') IS DISTINCT FROM 'string'
             OR btrim(d.metadata->>'authority') = ''
             OR d.metadata->>'authority' IS DISTINCT FROM d.authority
           )
        OR d.metadata ? 'sourceRevision'
           AND (
             jsonb_typeof(d.metadata->'sourceRevision') IS DISTINCT FROM 'string'
             OR btrim(d.metadata->>'sourceRevision') = ''
             OR d.metadata->>'sourceRevision' IS DISTINCT FROM generation_upstream_revision
           )
        OR d.metadata ? 'license'
           AND (
             jsonb_typeof(d.metadata->'license') IS DISTINCT FROM 'string'
             OR btrim(d.metadata->>'license') = ''
             OR d.metadata->>'license' IS DISTINCT FROM generation_license
           )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'DOCUMENT_INVALID';
  END IF;

  -- Every document needs a nonempty, enabled, zero-based contiguous chunk
  -- sequence. Disabled or orphaned extras are not silently ignored.
  IF EXISTS (
    SELECT 1
    FROM docs_documents d
    WHERE d.generation_id = p_generation_id
      AND (
        NOT EXISTS (
          SELECT 1
          FROM docs_chunks c
          WHERE c.document_id = d.id
        )
        OR EXISTS (
          SELECT 1
          FROM docs_chunks c
          WHERE c.document_id = d.id
            AND (
              c.enabled IS NOT TRUE
              OR btrim(c.content) = ''
              OR btrim(c.searchable_text) = ''
            )
        )
        OR EXISTS (
          SELECT 1
          FROM docs_chunks c
          WHERE c.document_id = d.id
            AND c.chunk_index < 0
        )
        OR EXISTS (
          SELECT expected_chunk.chunk_index
          FROM generate_series(
            0,
            (
              SELECT max(c2.chunk_index)
              FROM docs_chunks c2
              WHERE c2.document_id = d.id
            )
          ) AS expected_chunk(chunk_index)
          WHERE NOT EXISTS (
            SELECT 1
            FROM docs_chunks c3
            WHERE c3.document_id = d.id
              AND c3.chunk_index = expected_chunk.chunk_index
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'CHUNK_INVALID';
  END IF;

  -- Document-level embeddings and any other embedding extras are not valid for
  -- a generation. Each enabled chunk must have exactly one total row, and that
  -- row must carry the generation's provider/model/dimension and both exact
  -- source and input hashes.
  IF EXISTS (
    SELECT 1
    FROM docs_documents d
    JOIN docs_embeddings e ON e.document_id = d.id
    WHERE d.generation_id = p_generation_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'EMBEDDING_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM docs_chunks c
    JOIN docs_documents d ON d.id = c.document_id
    WHERE d.generation_id = p_generation_id
      AND c.enabled
      AND (
        (
          SELECT count(*)
          FROM docs_embeddings e
          WHERE e.chunk_id = c.id
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM docs_embeddings e
          WHERE e.chunk_id = c.id
            AND e.document_id IS NULL
            AND e.embedding_kind = 'chunk'
            AND e.embedding_provider = profile_embedding_provider
            AND e.embedding_model = profile_embedding_model
            AND e.embedding_dimensions = profile_embedding_dimensions
            AND e.embedding_input_text = left(
              coalesce(nullif(c.searchable_text, ''), c.content),
              profile_embedding_input_max_chars
            )
            AND e.embedding_input_sha256 = encode(
              sha256(convert_to(e.embedding_input_text, 'UTF8')), 'hex'
            )
            AND e.source_hash IS NOT NULL
            AND e.source_hash ~ '^[0-9a-f]{64}$'
            AND e.source_hash = encode(
              sha256(convert_to(
                d.content_hash || ':' || c.chunk_index::text || ':' || c.content,
                'UTF8'
              )), 'hex'
            )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'EMBEDDING_INVALID';
  END IF;
END;
$$;

-- Re-validate every already-published pointer before committing the upgrade.
-- Exact migration-004 exemptions return early in the guard; every other
-- published row must satisfy the new class-specific contract now.
DO $$
DECLARE
  published_generation record;
BEGIN
  FOR published_generation IN
    SELECT id, source_id
    FROM docs_source_generations
    WHERE status = 'published'
  LOOP
    PERFORM docs_rag_assert_generation_publishable(
      published_generation.id,
      published_generation.source_id
    );
  END LOOP;
END
$$;

COMMIT;
