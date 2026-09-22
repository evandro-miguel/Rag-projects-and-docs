-- Docs RAG 004: immutable source generations and atomic serving pointers.
--
-- A source generation is a complete, immutable snapshot of one external
-- source.  Documents may be staged and retried, but readers only join through
-- docs_source_generation_pointers, which is switched in the same transaction
-- that marks a generation published.  A complete zero-document generation is
-- valid; incomplete or blocked scans can never become the serving pointer.

BEGIN;

CREATE TABLE IF NOT EXISTS docs_source_generations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL,
  generation_key text NOT NULL,
  upstream_revision text,
  upstream_path text,
  license text,
  raw_manifest_sha256 text,
  processing_profile_hash text NOT NULL DEFAULT 'legacy',
  processing_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  scan_state text NOT NULL DEFAULT 'pending',
  expected_document_count integer NOT NULL DEFAULT 0,
  indexed_document_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'staging',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT docs_source_generations_identity_unique UNIQUE (source_id, generation_key),
  CONSTRAINT docs_source_generations_source_id_check CHECK (btrim(source_id) <> ''),
  CONSTRAINT docs_source_generations_scan_state_check
    CHECK (scan_state IN ('pending', 'complete', 'incomplete', 'blocked')),
  CONSTRAINT docs_source_generations_status_check
    CHECK (status IN ('staging', 'published', 'retired')),
  CONSTRAINT docs_source_generations_expected_count_check CHECK (expected_document_count >= 0),
  CONSTRAINT docs_source_generations_indexed_count_check CHECK (indexed_document_count >= 0),
  CONSTRAINT docs_source_generations_lifecycle_check CHECK (
    (status = 'staging' AND published_at IS NULL)
    OR (status IN ('published', 'retired') AND published_at IS NOT NULL)
  )
);

ALTER TABLE docs_documents
  ADD COLUMN IF NOT EXISTS generation_id bigint;

-- Existing rows are retained as one truthful legacy generation per source so
-- an upgrade does not silently turn a populated Docs RAG lane into an empty
-- one.  The migration intentionally does not fabricate an upstream revision,
-- manifest digest, or processing profile for those rows.
INSERT INTO docs_source_generations (
  source_id,
  generation_key,
  scan_state,
  expected_document_count,
  indexed_document_count,
  status,
  published_at
)
SELECT
  d.source_id,
  'legacy-' || md5(d.source_id),
  'complete',
  count(*)::integer,
  count(*)::integer,
  'published',
  now()
FROM docs_documents d
WHERE d.generation_id IS NULL
GROUP BY d.source_id
ON CONFLICT (source_id, generation_key) DO NOTHING;

UPDATE docs_documents d
SET generation_id = g.id
FROM docs_source_generations g
WHERE d.generation_id IS NULL
  AND g.source_id = d.source_id
  AND g.generation_key = 'legacy-' || md5(d.source_id);

ALTER TABLE docs_documents
  DROP CONSTRAINT IF EXISTS docs_documents_source_identity_unique;

ALTER TABLE docs_documents
  ADD CONSTRAINT docs_documents_generation_fk
  FOREIGN KEY (generation_id) REFERENCES docs_source_generations(id) ON DELETE CASCADE;

-- Generation-bound rows may share a source path across immutable generations.
-- The legacy index preserves the old identity rule for any explicitly retained
-- pre-generation row while PostgreSQL's NULL-distinct unique constraint keeps
-- the generation-bound write path compatible with ON CONFLICT inference.
CREATE UNIQUE INDEX IF NOT EXISTS docs_documents_generation_identity_unique
  ON docs_documents (generation_id, source_id, source_path);
CREATE UNIQUE INDEX IF NOT EXISTS docs_documents_legacy_identity_unique
  ON docs_documents (source_id, source_path)
  WHERE generation_id IS NULL;
CREATE INDEX IF NOT EXISTS docs_documents_generation_id_idx
  ON docs_documents (generation_id);

CREATE TABLE IF NOT EXISTS docs_source_generation_pointers (
  source_id text PRIMARY KEY CHECK (btrim(source_id) <> ''),
  generation_id bigint NOT NULL REFERENCES docs_source_generations(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO docs_source_generation_pointers (source_id, generation_id)
SELECT DISTINCT ON (g.source_id) g.source_id, g.id
FROM docs_source_generations g
WHERE g.status = 'published'
ORDER BY g.source_id, g.published_at DESC NULLS LAST, g.id DESC
ON CONFLICT (source_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS docs_source_generations_source_status_idx
  ON docs_source_generations (source_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS docs_source_generation_pointers_generation_idx
  ON docs_source_generation_pointers (generation_id);

CREATE OR REPLACE FUNCTION docs_rag_touch_source_generation_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_source_generations_touch_updated_at
BEFORE UPDATE ON docs_source_generations
FOR EACH ROW
EXECUTE FUNCTION docs_rag_touch_source_generation_updated_at();

-- Publication is valid only when the generation is a complete, source-bound
-- snapshot and the source pointer names that exact generation.  The check is
-- also used by the pointer trigger so direct SQL cannot point readers at a
-- staging, incomplete, or partially indexed generation.
CREATE OR REPLACE FUNCTION docs_rag_assert_generation_publishable(
  p_generation_id bigint,
  p_source_id text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  generation_source_id text;
  generation_status text;
  generation_scan_state text;
  expected_count bigint;
  indexed_count bigint;
  document_count bigint;
  indexed_document_count bigint;
  source_document_count bigint;
BEGIN
  SELECT g.source_id, g.status, g.scan_state,
         g.expected_document_count, g.indexed_document_count
    INTO generation_source_id, generation_status, generation_scan_state,
         expected_count, indexed_count
  FROM docs_source_generations g
  WHERE g.id = p_generation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Docs RAG source generation % does not exist', p_generation_id;
  END IF;
  IF generation_source_id <> p_source_id THEN
    RAISE EXCEPTION
      'Docs RAG generation % source % does not match pointer source %',
      p_generation_id, generation_source_id, p_source_id;
  END IF;
  IF generation_status <> 'published' THEN
    RAISE EXCEPTION
      'Docs RAG pointer cannot target generation % with status %',
      p_generation_id, generation_status;
  END IF;
  IF generation_scan_state <> 'complete' THEN
    RAISE EXCEPTION
      'Docs RAG generation % cannot serve with scan state %',
      p_generation_id, generation_scan_state;
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
    RAISE EXCEPTION
      'Docs RAG generation % is incomplete or source-inconsistent: expected %, indexed counter %, documents %, source documents %, indexed documents %',
      p_generation_id, expected_count, indexed_count,
      document_count, source_document_count, indexed_document_count;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION docs_rag_validate_generation_pointer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM docs_rag_assert_generation_publishable(NEW.generation_id, NEW.source_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_source_generation_pointers_validate_target
BEFORE INSERT OR UPDATE ON docs_source_generation_pointers
FOR EACH ROW
EXECUTE FUNCTION docs_rag_validate_generation_pointer();

-- The application updates the generation and pointer in one transaction. A
-- deferred constraint trigger makes the same atomicity requirement hold for
-- direct SQL: a published generation without its exact serving pointer is
-- rejected at commit, while a valid transaction ordering remains possible.
CREATE OR REPLACE FUNCTION docs_rag_validate_published_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'published' THEN
    PERFORM docs_rag_assert_generation_publishable(NEW.id, NEW.source_id);
    IF NOT EXISTS (
      SELECT 1
      FROM docs_source_generation_pointers p
      WHERE p.source_id = NEW.source_id
        AND p.generation_id = NEW.id
    ) THEN
      RAISE EXCEPTION
        'published Docs RAG source generation % must have its source pointer', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER docs_source_generations_publish_invariants
AFTER INSERT OR UPDATE ON docs_source_generations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION docs_rag_validate_published_generation();

CREATE OR REPLACE FUNCTION docs_rag_validate_source_generation_pointer_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pointer_source_id text;
  pointer_generation_id bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION 'Docs RAG source generation pointer source_id is immutable';
  END IF;
  pointer_source_id := COALESCE(NEW.source_id, OLD.source_id);
  SELECT generation_id
    INTO pointer_generation_id
  FROM docs_source_generation_pointers
  WHERE source_id = pointer_source_id;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM docs_source_generations
      WHERE source_id = pointer_source_id
        AND status = 'published'
    ) THEN
      RAISE EXCEPTION
        'Docs RAG source % must retain a serving generation pointer', pointer_source_id;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  PERFORM docs_rag_assert_generation_publishable(pointer_generation_id, pointer_source_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER docs_source_generation_pointers_state_invariants
AFTER INSERT OR UPDATE OR DELETE ON docs_source_generation_pointers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION docs_rag_validate_source_generation_pointer_state();

CREATE OR REPLACE FUNCTION docs_rag_reject_published_generation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'staging' THEN
      RAISE EXCEPTION 'Docs RAG source generations must be published through the pointer transaction';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION
        'published Docs RAG source generation % must be retired before deletion', OLD.id;
    END IF;
    IF OLD.status = 'retired'
       AND EXISTS (
         SELECT 1
         FROM docs_source_generation_pointers p
         WHERE p.source_id = OLD.source_id
           AND p.generation_id = OLD.id
       ) THEN
      RAISE EXCEPTION 'active Docs RAG source generation % cannot be deleted', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.source_id IS DISTINCT FROM OLD.source_id
     AND EXISTS (
       SELECT 1 FROM docs_documents WHERE generation_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'Docs RAG source generation % cannot change source after documents are staged', OLD.id;
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.status = 'retired'
       AND NOT EXISTS (
         SELECT 1
         FROM docs_source_generation_pointers p
         WHERE p.source_id = OLD.source_id
           AND p.generation_id = OLD.id
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'published Docs RAG source generation % is immutable', OLD.id;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired Docs RAG source generation % is immutable', OLD.id;
  END IF;
  IF NEW.status = 'retired' THEN
    RAISE EXCEPTION 'staging Docs RAG source generation % cannot be retired', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_source_generations_reject_published_update
BEFORE INSERT OR UPDATE OR DELETE ON docs_source_generations
FOR EACH ROW
EXECUTE FUNCTION docs_rag_reject_published_generation_mutation();

CREATE OR REPLACE FUNCTION docs_rag_reject_published_document_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_status text;
  generation_id_value bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    generation_id_value := NEW.generation_id;
  ELSIF TG_OP = 'DELETE' THEN
    generation_id_value := OLD.generation_id;
  ELSE
    generation_id_value := NEW.generation_id;
  END IF;
  IF generation_id_value IS NOT NULL THEN
    SELECT status INTO generation_status
    FROM docs_source_generations
    WHERE id = generation_id_value;
    IF generation_status = 'published'
       OR (generation_status = 'retired' AND TG_OP <> 'DELETE') THEN
      RAISE EXCEPTION 'document in published Docs RAG generation is immutable';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.generation_id IS DISTINCT FROM NEW.generation_id
     AND OLD.generation_id IS NOT NULL THEN
    SELECT status INTO generation_status
    FROM docs_source_generations
    WHERE id = OLD.generation_id;
    IF generation_status IN ('published', 'retired') THEN
      RAISE EXCEPTION 'document in published Docs RAG generation is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_documents_reject_published_generation_update
BEFORE INSERT OR UPDATE OR DELETE ON docs_documents
FOR EACH ROW
EXECUTE FUNCTION docs_rag_reject_published_document_mutation();

CREATE OR REPLACE FUNCTION docs_rag_reject_published_derived_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_status text;
  document_id_value bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    document_id_value := OLD.document_id;
  ELSE
    document_id_value := NEW.document_id;
  END IF;
  SELECT g.status INTO generation_status
  FROM docs_documents d
  LEFT JOIN docs_source_generations g ON g.id = d.generation_id
  WHERE d.id = document_id_value;
  IF generation_status = 'published'
     OR (generation_status = 'retired' AND TG_OP <> 'DELETE') THEN
    RAISE EXCEPTION 'derived Docs RAG row in a published generation is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.document_id IS DISTINCT FROM NEW.document_id THEN
    SELECT g.status INTO generation_status
    FROM docs_documents d
    LEFT JOIN docs_source_generations g ON g.id = d.generation_id
    WHERE d.id = OLD.document_id;
    IF generation_status IN ('published', 'retired') THEN
      RAISE EXCEPTION 'derived Docs RAG row in a published generation is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_chunks_reject_published_generation_mutation
BEFORE INSERT OR UPDATE OR DELETE ON docs_chunks
FOR EACH ROW
EXECUTE FUNCTION docs_rag_reject_published_derived_mutation();

CREATE OR REPLACE FUNCTION docs_rag_reject_published_embedding_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_status text;
  document_id_value bigint;
  chunk_id_value bigint;
  old_document_id_value bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    chunk_id_value := OLD.chunk_id;
  ELSE
    chunk_id_value := NEW.chunk_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    document_id_value := OLD.document_id;
  ELSIF NEW.document_id IS NOT NULL THEN
    document_id_value := NEW.document_id;
  ELSE
    SELECT document_id INTO document_id_value FROM docs_chunks WHERE id = chunk_id_value;
  END IF;
  SELECT g.status INTO generation_status
  FROM docs_documents d
  LEFT JOIN docs_source_generations g ON g.id = d.generation_id
  WHERE d.id = document_id_value;
  IF generation_status = 'published'
     OR (generation_status = 'retired' AND TG_OP <> 'DELETE') THEN
    RAISE EXCEPTION 'embedding row in a published Docs RAG generation is immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (OLD.document_id IS DISTINCT FROM NEW.document_id
          OR OLD.chunk_id IS DISTINCT FROM NEW.chunk_id) THEN
    IF OLD.document_id IS NOT NULL THEN
      old_document_id_value := OLD.document_id;
    ELSE
      SELECT document_id INTO old_document_id_value
      FROM docs_chunks
      WHERE id = OLD.chunk_id;
    END IF;
    SELECT g.status INTO generation_status
    FROM docs_documents d
    LEFT JOIN docs_source_generations g ON g.id = d.generation_id
    WHERE d.id = old_document_id_value;
    IF generation_status IN ('published', 'retired') THEN
      RAISE EXCEPTION 'embedding row in a published Docs RAG generation is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_embeddings_reject_published_generation_mutation
BEFORE INSERT OR UPDATE OR DELETE ON docs_embeddings
FOR EACH ROW
EXECUTE FUNCTION docs_rag_reject_published_embedding_mutation();

-- A generation-bound document must retain its source identity even when SQL
-- bypasses the application store. Legacy rows with NULL generation_id remain
-- intentionally supported for the migration backfill boundary.
CREATE OR REPLACE FUNCTION docs_rag_validate_document_generation_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_source_id text;
BEGIN
  IF NEW.generation_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT source_id INTO generation_source_id
  FROM docs_source_generations
  WHERE id = NEW.generation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Docs RAG document generation % does not exist', NEW.generation_id;
  END IF;
  IF generation_source_id <> NEW.source_id THEN
    RAISE EXCEPTION
      'Docs RAG document source % does not match generation source %',
      NEW.source_id, generation_source_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_documents_validate_generation_source
BEFORE INSERT OR UPDATE ON docs_documents
FOR EACH ROW
EXECUTE FUNCTION docs_rag_validate_document_generation_source();

COMMIT;
