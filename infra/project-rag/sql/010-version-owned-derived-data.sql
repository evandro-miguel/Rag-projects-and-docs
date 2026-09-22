BEGIN;

-- Migration 010: version-owned derived data (release-completion T-05).
--
-- Makes Project RAG derived data (build files, chunks, symbols, edge
-- endpoints, embeddings) structurally owned by their exact project, file,
-- and file-version parents, and enforces candidate-only immutability using
-- the EXISTING project_file_versions lifecycle fields (status plus
-- error_message/timestamps). A duplicate graph_state column is intentionally
-- NOT invented: project_file_versions.status ('pending','ready','failed',
-- 'replaced') is the canonical lifecycle and this migration wires its
-- transition rules instead of duplicating state.
--
-- Compatibility contract (writer slice adopted in this migration):
-- - The chunk uniqueness surface project_chunks_file_version_chunk_unique is
--   preserved verbatim.
-- - Guard triggers police UPDATE mutations only. Deletions keep flowing
--   through the supported replace/cascade/finalizer paths, so ON DELETE
--   CASCADE chains and the atomic ingest finalizer never see a new failure.
-- - The embedding profile identity column embedding_profile_hash is NOT NULL:
--   rows whose stored provider/model/dimensions match this codebase's
--   canonical lane are backfilled to the exact sha256 digest the TypeScript
--   writer computes; every other row receives the 'legacy_unknown' sentinel,
--   which promotion, search, and the writer all refuse. The legacy conflict
--   target (project_id, owner_type, owner_ref, embedding_model) is retired
--   after the deterministic backfill; inserts resolve conflicts on the new
--   (project_id, owner_type, owner_ref, embedding_profile_hash) key with DO
--   NOTHING so stored vectors are never mutated and foreign profiles can
--   coexist.

-- ---------------------------------------------------------------------------
-- Ownership preflight: ambiguous ownership aborts this migration.
-- Every derived row must already agree with its declared parents. Any
-- disagreement raises and rolls the whole transaction back; nothing is
-- deleted, rewritten, or guessed here.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- project_chunks -> project_files / project_file_versions
  IF EXISTS (
    SELECT 1 FROM project_chunks c
    JOIN project_files f ON f.id = c.file_id
    WHERE c.project_id <> f.project_id
  ) OR EXISTS (
    SELECT 1 FROM project_chunks c
    JOIN project_file_versions v ON v.id = c.version_id
    WHERE c.version_id IS NOT NULL
      AND (c.project_id <> v.project_id OR c.file_id <> v.file_id)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'MIGRATION_AMBIGUOUS_OWNERSHIP: project_chunks rows disagree with their project_files/project_file_versions parents; refusing to migrate without deletion or guessing';
  END IF;

  -- project_symbols -> project_files / project_file_versions / project_chunks
  IF EXISTS (
    SELECT 1 FROM project_symbols s
    JOIN project_files f ON f.id = s.file_id
    WHERE s.project_id IS DISTINCT FROM f.project_id
  ) OR EXISTS (
    SELECT 1 FROM project_symbols s
    JOIN project_file_versions v ON v.id = s.version_id
    WHERE s.version_id IS NOT NULL
      AND (s.project_id IS DISTINCT FROM v.project_id OR s.file_id IS DISTINCT FROM v.file_id)
  ) OR EXISTS (
    SELECT 1 FROM project_symbols s
    JOIN project_chunks c ON c.id = s.chunk_id
    WHERE s.chunk_id IS NOT NULL
      AND (
        s.project_id IS DISTINCT FROM c.project_id
        OR s.file_id IS DISTINCT FROM c.file_id
        OR s.version_id IS DISTINCT FROM c.version_id
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'MIGRATION_AMBIGUOUS_OWNERSHIP: project_symbols rows disagree with their exact project/file/version/chunk parents; refusing to migrate without deletion or guessing';
  END IF;

  -- project_edges endpoints -> files / versions / symbols
  IF EXISTS (
    SELECT 1 FROM project_edges e
    JOIN project_files f ON f.id = e.source_file_id
    WHERE e.source_file_id IS NOT NULL AND e.project_id <> f.project_id
  ) OR EXISTS (
    SELECT 1 FROM project_edges e
    JOIN project_files f ON f.id = e.target_file_id
    WHERE e.target_file_id IS NOT NULL AND e.project_id <> f.project_id
  ) OR EXISTS (
    SELECT 1 FROM project_edges e
    JOIN project_file_versions v ON v.id = e.source_version_id
      WHERE e.source_version_id IS NOT NULL AND e.source_file_id IS NOT NULL
      AND (e.project_id IS DISTINCT FROM v.project_id OR e.source_file_id IS DISTINCT FROM v.file_id)
  ) OR EXISTS (
    SELECT 1 FROM project_edges e
    JOIN project_file_versions v ON v.id = e.target_version_id
      WHERE e.target_version_id IS NOT NULL AND e.target_file_id IS NOT NULL
      AND (e.project_id IS DISTINCT FROM v.project_id OR e.target_file_id IS DISTINCT FROM v.file_id)
  ) OR EXISTS (
    SELECT 1 FROM project_edges e
    JOIN project_symbols s ON s.id = e.source_symbol_id
      WHERE e.source_symbol_id IS NOT NULL AND (
        e.project_id IS DISTINCT FROM s.project_id
        OR e.source_file_id IS DISTINCT FROM s.file_id
        OR e.source_version_id IS DISTINCT FROM s.version_id
      )
  ) OR EXISTS (
    SELECT 1 FROM project_edges e
    JOIN project_symbols s ON s.id = e.target_symbol_id
      WHERE e.target_symbol_id IS NOT NULL AND (
        e.project_id IS DISTINCT FROM s.project_id
        OR e.target_file_id IS DISTINCT FROM s.file_id
        OR e.target_version_id IS DISTINCT FROM s.version_id
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'MIGRATION_AMBIGUOUS_OWNERSHIP: project_edges endpoint rows disagree with their exact project/file/version/symbol parents; refusing to migrate without deletion or guessing';
  END IF;

  -- Derive missing chunk/symbol owner file bindings from their hard foreign
  -- keys. Only NULL bindings are filled: an existing disagreeing value is a
  -- real ambiguity and must fail the checks below. The legacy owner_check
  -- forbids these columns on chunk/symbol rows, so it is retired here ahead of
  -- the backfill; the exact post-010 owner shape is re-enforced by its
  -- replacement constraint later in this same transaction.
  ALTER TABLE project_embeddings_1024
    DROP CONSTRAINT IF EXISTS project_embeddings_1024_owner_check;

  UPDATE project_embeddings_1024 x
     SET file_id = c.file_id
    FROM project_chunks c
   WHERE x.owner_type = 'chunk' AND x.chunk_id = c.id AND x.file_id IS NULL;

  UPDATE project_embeddings_1024 x
     SET file_id = s.file_id
    FROM project_symbols s
   WHERE x.owner_type = 'symbol' AND x.symbol_id = s.id AND x.file_id IS NULL;

  -- project_embeddings_1024 owners -> exact files / chunks / symbols / versions.
  -- A version-less embedding cannot be proven to belong to the same file
  -- generation as its owner, so it is an explicit migration ambiguity rather
  -- than a row to preserve under a weaker project-only FK.
  --
  -- The legacy writer (and the pre-010 owner_check) leaves chunk/symbol owner
  -- rows with a NULL file binding, but that file identity is derivable through
  -- the hard chunk/symbol foreign keys, so it is backfilled here instead of
  -- refusing every real legacy database. Version agreement below stays
  -- strictly declared: it can never be derived without guessing.
  IF EXISTS (
    SELECT 1 FROM project_embeddings_1024 x
    WHERE x.version_id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM project_embeddings_1024 x
    JOIN project_chunks c ON c.id = x.chunk_id
    WHERE x.owner_type = 'chunk'
      AND (
        x.project_id IS DISTINCT FROM c.project_id
        OR x.file_id IS DISTINCT FROM c.file_id
        OR x.version_id IS DISTINCT FROM c.version_id
      )
  ) OR EXISTS (
    SELECT 1 FROM project_embeddings_1024 x
    JOIN project_symbols s ON s.id = x.symbol_id
    WHERE x.owner_type = 'symbol'
      AND (
        x.project_id IS DISTINCT FROM s.project_id
        OR x.file_id IS DISTINCT FROM s.file_id
        OR x.version_id IS DISTINCT FROM s.version_id
      )
  ) OR EXISTS (
    SELECT 1 FROM project_embeddings_1024 x
    JOIN project_file_versions v ON v.id = x.version_id
    WHERE x.owner_type = 'file'
      AND (
        x.project_id IS DISTINCT FROM v.project_id
        OR x.file_id IS DISTINCT FROM v.file_id
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'MIGRATION_AMBIGUOUS_OWNERSHIP: project_embeddings_1024 rows lack exact project/file/version owner agreement; refusing to migrate without deletion or guessing';
  END IF;

  -- project_index_build_files -> project_file_versions (file-bound version)
  IF EXISTS (
    SELECT 1 FROM project_index_build_files b
    JOIN project_file_versions v ON v.id = b.version_id
    WHERE b.project_id <> v.project_id OR b.file_id <> v.file_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'MIGRATION_AMBIGUOUS_OWNERSHIP: project_index_build_files rows disagree with their project_file_versions parents; refusing to migrate without deletion or guessing';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Composite ownership keys and validated foreign keys.
-- Each parent gains an (id[, file_id], project_id) unique key so children can
-- bind across the project boundary at the database level. The constraints are
-- added conditionally (fresh installs and idempotent upgrades share one path)
-- and validated immediately: any residual ambiguity fails this transaction.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_chunks'::regclass AND conname = 'project_chunks_id_project_unique') THEN
    ALTER TABLE project_chunks
      ADD CONSTRAINT project_chunks_id_project_unique UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_chunks'::regclass AND conname = 'project_chunks_id_version_project_unique') THEN
    ALTER TABLE project_chunks
      ADD CONSTRAINT project_chunks_id_version_project_unique UNIQUE (id, version_id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_chunks'::regclass AND conname = 'project_chunks_id_file_version_project_unique') THEN
    ALTER TABLE project_chunks
      ADD CONSTRAINT project_chunks_id_file_version_project_unique UNIQUE (id, file_id, version_id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_symbols'::regclass AND conname = 'project_symbols_id_project_unique') THEN
    ALTER TABLE project_symbols
      ADD CONSTRAINT project_symbols_id_project_unique UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_symbols'::regclass AND conname = 'project_symbols_id_version_project_unique') THEN
    ALTER TABLE project_symbols
      ADD CONSTRAINT project_symbols_id_version_project_unique UNIQUE (id, version_id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_symbols'::regclass AND conname = 'project_symbols_id_file_version_project_unique') THEN
    ALTER TABLE project_symbols
      ADD CONSTRAINT project_symbols_id_file_version_project_unique UNIQUE (id, file_id, version_id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_edges'::regclass AND conname = 'project_edges_id_project_unique') THEN
    ALTER TABLE project_edges
      ADD CONSTRAINT project_edges_id_project_unique UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_embeddings_1024'::regclass AND conname = 'project_embeddings_1024_id_project_unique') THEN
    ALTER TABLE project_embeddings_1024
      ADD CONSTRAINT project_embeddings_1024_id_project_unique UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_file_versions'::regclass AND conname = 'project_file_versions_id_file_project_unique') THEN
    ALTER TABLE project_file_versions
      ADD CONSTRAINT project_file_versions_id_file_project_unique UNIQUE (id, file_id, project_id);
  END IF;
END $$;

-- Chunks are owned by their exact project, file, and file version. Nullable
-- version_id keeps historical unbound rows loadable under MATCH SIMPLE while
-- every bound row becomes project/file/version-exact.
ALTER TABLE project_chunks
  DROP CONSTRAINT IF EXISTS project_chunks_file_id_fkey,
  DROP CONSTRAINT IF EXISTS project_chunks_version_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_chunks'::regclass AND conname = 'project_chunks_file_project_fk') THEN
    ALTER TABLE project_chunks
      ADD CONSTRAINT project_chunks_file_project_fk
      FOREIGN KEY (file_id, project_id)
      REFERENCES project_files (id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_chunks'::regclass AND conname = 'project_chunks_version_file_project_fk') THEN
    ALTER TABLE project_chunks
      ADD CONSTRAINT project_chunks_version_file_project_fk
      FOREIGN KEY (version_id, file_id, project_id)
      REFERENCES project_file_versions (id, file_id, project_id) ON DELETE CASCADE;
  END IF;
END $$;

-- Symbols bind to their file and version exactly like chunks, plus a
-- project/file/version-exact chunk link. PostgreSQL's column-list SET NULL
-- action clears only chunk_id, preserving the non-null symbol.project_id and
-- the symbol's own file/version ownership when a candidate chunk is replaced.
ALTER TABLE project_symbols
  DROP CONSTRAINT IF EXISTS project_symbols_file_id_fkey,
  DROP CONSTRAINT IF EXISTS project_symbols_version_id_fkey,
  DROP CONSTRAINT IF EXISTS project_symbols_chunk_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_symbols'::regclass AND conname = 'project_symbols_file_project_fk') THEN
    ALTER TABLE project_symbols
      ADD CONSTRAINT project_symbols_file_project_fk
      FOREIGN KEY (file_id, project_id)
      REFERENCES project_files (id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_symbols'::regclass AND conname = 'project_symbols_version_file_project_fk') THEN
    ALTER TABLE project_symbols
      ADD CONSTRAINT project_symbols_version_file_project_fk
      FOREIGN KEY (version_id, file_id, project_id)
      REFERENCES project_file_versions (id, file_id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_symbols'::regclass AND conname = 'project_symbols_chunk_project_fk') THEN
    ALTER TABLE project_symbols
      ADD CONSTRAINT project_symbols_chunk_project_fk
      FOREIGN KEY (chunk_id, file_id, version_id, project_id)
      REFERENCES project_chunks (id, file_id, version_id, project_id)
      ON DELETE SET NULL (chunk_id);
  END IF;
END $$;

-- Edge endpoints each bind to the matching parent through the project key.
-- Source/target versions additionally bind file-exactly so a version row can
-- never be attached to another file's edge endpoint.
ALTER TABLE project_edges
  DROP CONSTRAINT IF EXISTS project_edges_source_version_id_fkey,
  DROP CONSTRAINT IF EXISTS project_edges_target_version_id_fkey,
  DROP CONSTRAINT IF EXISTS project_edges_source_file_id_fkey,
  DROP CONSTRAINT IF EXISTS project_edges_target_file_id_fkey,
  DROP CONSTRAINT IF EXISTS project_edges_source_symbol_id_fkey,
  DROP CONSTRAINT IF EXISTS project_edges_target_symbol_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_edges'::regclass AND conname = 'project_edges_source_file_project_fk') THEN
    ALTER TABLE project_edges
      ADD CONSTRAINT project_edges_source_file_project_fk
      FOREIGN KEY (source_file_id, project_id)
      REFERENCES project_files (id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_edges'::regclass AND conname = 'project_edges_target_file_project_fk') THEN
    ALTER TABLE project_edges
      ADD CONSTRAINT project_edges_target_file_project_fk
      FOREIGN KEY (target_file_id, project_id)
      REFERENCES project_files (id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_edges'::regclass AND conname = 'project_edges_source_version_file_project_fk') THEN
    ALTER TABLE project_edges
      ADD CONSTRAINT project_edges_source_version_file_project_fk
      FOREIGN KEY (source_version_id, source_file_id, project_id)
      REFERENCES project_file_versions (id, file_id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_edges'::regclass AND conname = 'project_edges_target_version_file_project_fk') THEN
    ALTER TABLE project_edges
      ADD CONSTRAINT project_edges_target_version_file_project_fk
      FOREIGN KEY (target_version_id, target_file_id, project_id)
      REFERENCES project_file_versions (id, file_id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_edges'::regclass AND conname = 'project_edges_source_symbol_project_fk') THEN
    ALTER TABLE project_edges
      ADD CONSTRAINT project_edges_source_symbol_project_fk
      FOREIGN KEY (source_symbol_id, source_file_id, source_version_id, project_id)
      REFERENCES project_symbols (id, file_id, version_id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_edges'::regclass AND conname = 'project_edges_target_symbol_project_fk') THEN
    ALTER TABLE project_edges
      ADD CONSTRAINT project_edges_target_symbol_project_fk
      FOREIGN KEY (target_symbol_id, target_file_id, target_version_id, project_id)
      REFERENCES project_symbols (id, file_id, version_id, project_id) ON DELETE CASCADE;
  END IF;
END $$;

-- Embedding owners become exact file-version bindings. The owner tables carry
-- the file identity either directly (file owners) or through the chunk/symbol
-- version's file binding (chunk and symbol owners).
ALTER TABLE project_embeddings_1024
  DROP CONSTRAINT IF EXISTS project_embeddings_1024_file_id_fkey,
  DROP CONSTRAINT IF EXISTS project_embeddings_1024_chunk_id_fkey,
  DROP CONSTRAINT IF EXISTS project_embeddings_1024_symbol_id_fkey,
  DROP CONSTRAINT IF EXISTS project_embeddings_1024_version_id_fkey;

ALTER TABLE project_embeddings_1024
  ALTER COLUMN version_id SET NOT NULL;

ALTER TABLE project_embeddings_1024
  DROP CONSTRAINT IF EXISTS project_embeddings_1024_owner_check;

ALTER TABLE project_embeddings_1024
  ADD CONSTRAINT project_embeddings_1024_owner_check CHECK (
    (owner_type = 'file' AND file_id IS NOT NULL AND chunk_id IS NULL AND symbol_id IS NULL)
    OR (owner_type = 'chunk' AND file_id IS NOT NULL AND chunk_id IS NOT NULL AND symbol_id IS NULL)
    OR (owner_type = 'symbol' AND file_id IS NOT NULL AND chunk_id IS NULL AND symbol_id IS NOT NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_embeddings_1024'::regclass AND conname = 'project_embeddings_1024_file_project_fk') THEN
    ALTER TABLE project_embeddings_1024
      ADD CONSTRAINT project_embeddings_1024_file_project_fk
      FOREIGN KEY (version_id, file_id, project_id)
      REFERENCES project_file_versions (id, file_id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_embeddings_1024'::regclass AND conname = 'project_embeddings_1024_chunk_version_project_fk') THEN
    ALTER TABLE project_embeddings_1024
      ADD CONSTRAINT project_embeddings_1024_chunk_version_project_fk
      FOREIGN KEY (chunk_id, file_id, version_id, project_id)
      REFERENCES project_chunks (id, file_id, version_id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_embeddings_1024'::regclass AND conname = 'project_embeddings_1024_symbol_version_project_fk') THEN
    ALTER TABLE project_embeddings_1024
      ADD CONSTRAINT project_embeddings_1024_symbol_version_project_fk
      FOREIGN KEY (symbol_id, file_id, version_id, project_id)
      REFERENCES project_symbols (id, file_id, version_id, project_id) ON DELETE CASCADE;
  END IF;
END $$;

-- Build-file rows gain the same file-exact version binding that chunks and
-- symbols use, completing composite project/file/version ownership for the
-- published build surface introduced by migration 007.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_index_build_files'::regclass AND conname = 'project_index_build_files_version_file_project_fk') THEN
    ALTER TABLE project_index_build_files
      ADD CONSTRAINT project_index_build_files_version_file_project_fk
      FOREIGN KEY (version_id, file_id, project_id)
      REFERENCES project_file_versions (id, file_id, project_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Version lifecycle transitions (existing canonical fields only).
--
-- Allowed UPDATE transitions:
--   pending -> ready     (promotion after embeddings succeed)
--   pending -> failed    (candidate failed processing)
--   ready   -> replaced  (superseded by a promoted successor)
-- replaced and failed are terminal. Entering 'ready' requires ready_at,
-- entering 'replaced' requires replaced_at, and entering 'failed' requires
-- both failed_at and a non-empty error_message so failures always carry
-- evidence. No graph_state column is added: project_file_versions.status is
-- the single canonical lifecycle representation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_rag_version_lifecycle_transitions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'ready' THEN
    IF NEW.ready_at IS NULL THEN
      RAISE EXCEPTION 'lifecycle transition pending->ready requires ready_at';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'failed' THEN
    IF NEW.failed_at IS NULL OR coalesce(NEW.error_message, '') = '' THEN
      RAISE EXCEPTION 'lifecycle transition pending->failed requires failed_at and error_message';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'ready' AND NEW.status = 'replaced' THEN
    IF NEW.replaced_at IS NULL THEN
      RAISE EXCEPTION 'lifecycle transition ready->replaced requires replaced_at';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid file version lifecycle transition % -> %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS project_file_versions_lifecycle_transitions ON project_file_versions;
CREATE TRIGGER project_file_versions_lifecycle_transitions
BEFORE UPDATE ON project_file_versions
FOR EACH ROW EXECUTE FUNCTION project_rag_version_lifecycle_transitions();

-- ---------------------------------------------------------------------------
-- Candidate-only immutable guards.
--
-- Derived rows may carry mutable content only while their owning file version
-- is a candidate ('pending'). Once promoted, failed, or replaced, content is
-- frozen. The explicitly supported mutation surfaces stay open so the current
-- writer and the atomic finalizer keep working unchanged:
-- - project_chunks.enabled remains the lifecycle disable flag (the promotion
--   path disables superseded chunks after their version turns 'replaced');
-- - project_edges.target_file_id/target_symbol_id remain the resolution-
--   completion fields written right after raw edge insertion;
-- - project_symbols allow only the chunk_id nullification performed by the
--   supported SET NULL cascade when referenced chunks are replaced;
-- - project_embeddings_1024 rows are fully immutable through UPDATE (identity,
--   profile hash, version binding, payload, source hash); new file versions
--   and new profiles arrive as new insert-only rows;
-- - INSERT is allowed only for a pending version that is not already a member
--   of any index build. This applies to both direct SQL writers and the store
--   APIs; the latter repeat the check before issuing their INSERT.
-- - DELETE is never blocked: replacement deletes, ON DELETE CASCADE chains,
--   and finalizer cleanup keep flowing untouched.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_rag_symbols_candidate_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_status text;
BEGIN
  IF NEW.version_id IS NULL THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_REQUIRED: project_symbols inserts require a file version';
  END IF;

  SELECT v.status INTO candidate_status
  FROM project_file_versions v
  WHERE v.id = NEW.version_id
    AND v.project_id = NEW.project_id
    AND v.file_id = NEW.file_id;

  IF candidate_status IS NULL THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_NOT_FOUND: symbol version % is not owned by project % and file %',
      NEW.version_id, NEW.project_id, NEW.file_id;
  END IF;
  IF candidate_status <> 'pending' THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_IMMUTABLE: symbol version % is ''%''; only pending candidates accept inserts',
      NEW.version_id, candidate_status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM project_index_build_files b
    WHERE b.project_id = NEW.project_id
      AND b.file_id = NEW.file_id
      AND b.version_id = NEW.version_id
  ) THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_BUILD_MEMBER: symbol version % is already bound to an index build', NEW.version_id;
  END IF;
  IF NEW.chunk_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM project_chunks c
    WHERE c.id = NEW.chunk_id
      AND c.project_id = NEW.project_id
      AND c.file_id = NEW.file_id
      AND c.version_id = NEW.version_id
  ) THEN
    RAISE EXCEPTION 'SYMBOL_CHUNK_OWNERSHIP_MISMATCH: symbol chunk % is not owned by project %, file %, version %',
      NEW.chunk_id, NEW.project_id, NEW.file_id, NEW.version_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_symbols_candidate_insert_guard ON project_symbols;
CREATE TRIGGER project_symbols_candidate_insert_guard
BEFORE INSERT ON project_symbols
FOR EACH ROW EXECUTE FUNCTION project_rag_symbols_candidate_insert_guard();

CREATE OR REPLACE FUNCTION project_rag_edges_candidate_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_status text;
BEGIN
  IF NEW.source_version_id IS NULL OR NEW.source_file_id IS NULL THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_REQUIRED: project_edges inserts require a source file and version';
  END IF;

  SELECT v.status INTO candidate_status
  FROM project_file_versions v
  WHERE v.id = NEW.source_version_id
    AND v.project_id = NEW.project_id
    AND v.file_id = NEW.source_file_id;

  IF candidate_status IS NULL THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_NOT_FOUND: edge source version % is not owned by project % and file %',
      NEW.source_version_id, NEW.project_id, NEW.source_file_id;
  END IF;
  IF candidate_status <> 'pending' THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_IMMUTABLE: edge source version % is ''%''; only pending candidates accept inserts',
      NEW.source_version_id, candidate_status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM project_index_build_files b
    WHERE b.project_id = NEW.project_id
      AND b.file_id = NEW.source_file_id
      AND b.version_id = NEW.source_version_id
  ) THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_BUILD_MEMBER: edge source version % is already bound to an index build', NEW.source_version_id;
  END IF;

  IF NEW.source_symbol_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM project_symbols s
    WHERE s.id = NEW.source_symbol_id
      AND s.project_id = NEW.project_id
      AND s.file_id = NEW.source_file_id
      AND s.version_id = NEW.source_version_id
  ) THEN
    RAISE EXCEPTION 'EDGE_SOURCE_SYMBOL_OWNERSHIP_MISMATCH: source symbol % is not owned by the edge source version %',
      NEW.source_symbol_id, NEW.source_version_id;
  END IF;

  IF NEW.target_version_id IS NOT NULL THEN
    IF NEW.target_file_id IS NULL THEN
      RAISE EXCEPTION 'CANDIDATE_VERSION_REQUIRED: edge target version requires a target file';
    END IF;
    SELECT v.status INTO candidate_status
    FROM project_file_versions v
    WHERE v.id = NEW.target_version_id
      AND v.project_id = NEW.project_id
      AND v.file_id = NEW.target_file_id;
    IF candidate_status IS NULL THEN
      RAISE EXCEPTION 'CANDIDATE_VERSION_NOT_FOUND: edge target version % is not owned by project % and file %',
        NEW.target_version_id, NEW.project_id, NEW.target_file_id;
    END IF;
    IF candidate_status <> 'pending' THEN
      RAISE EXCEPTION 'CANDIDATE_VERSION_IMMUTABLE: edge target version % is ''%''; only pending candidates accept inserts',
        NEW.target_version_id, candidate_status;
    END IF;
    IF EXISTS (
      SELECT 1 FROM project_index_build_files b
      WHERE b.project_id = NEW.project_id
        AND b.file_id = NEW.target_file_id
        AND b.version_id = NEW.target_version_id
    ) THEN
      RAISE EXCEPTION 'CANDIDATE_VERSION_BUILD_MEMBER: edge target version % is already bound to an index build', NEW.target_version_id;
    END IF;
  END IF;

  IF NEW.target_symbol_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM project_symbols s
    WHERE s.id = NEW.target_symbol_id
      AND s.project_id = NEW.project_id
      AND s.file_id = NEW.target_file_id
      AND s.version_id = NEW.target_version_id
  ) THEN
    RAISE EXCEPTION 'EDGE_TARGET_SYMBOL_OWNERSHIP_MISMATCH: target symbol % is not owned by the edge target version %',
      NEW.target_symbol_id, NEW.target_version_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_edges_candidate_insert_guard ON project_edges;
CREATE TRIGGER project_edges_candidate_insert_guard
BEFORE INSERT ON project_edges
FOR EACH ROW EXECUTE FUNCTION project_rag_edges_candidate_insert_guard();

CREATE OR REPLACE FUNCTION project_rag_chunks_candidate_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_status text;
BEGIN
  IF NEW.version_id IS NULL THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_REQUIRED: project_chunks inserts require a file version';
  END IF;

  SELECT v.status INTO candidate_status
  FROM project_file_versions v
  WHERE v.id = NEW.version_id
    AND v.project_id = NEW.project_id
    AND v.file_id = NEW.file_id;

  IF candidate_status IS NULL THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_NOT_FOUND: chunk version % is not owned by project % and file %',
      NEW.version_id, NEW.project_id, NEW.file_id;
  END IF;
  IF candidate_status <> 'pending' THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_IMMUTABLE: chunk version % is ''%''; only pending candidates accept inserts',
      NEW.version_id, candidate_status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM project_index_build_files b
    WHERE b.project_id = NEW.project_id
      AND b.file_id = NEW.file_id
      AND b.version_id = NEW.version_id
  ) THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_BUILD_MEMBER: chunk version % is already bound to an index build', NEW.version_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_chunks_candidate_insert_guard ON project_chunks;
CREATE TRIGGER project_chunks_candidate_insert_guard
BEFORE INSERT ON project_chunks
FOR EACH ROW EXECUTE FUNCTION project_rag_chunks_candidate_insert_guard();

CREATE OR REPLACE FUNCTION project_rag_chunks_candidate_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owning_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.file_id IS DISTINCT FROM OLD.file_id
      OR NEW.version_id IS DISTINCT FROM OLD.version_id
      OR NEW.chunk_index IS DISTINCT FROM OLD.chunk_index
      OR NEW.content IS DISTINCT FROM OLD.content
      OR NEW.searchable_text IS DISTINCT FROM OLD.searchable_text
      OR NEW.start_line IS DISTINCT FROM OLD.start_line
      OR NEW.end_line IS DISTINCT FROM OLD.end_line
      OR NEW.symbol_name IS DISTINCT FROM OLD.symbol_name
      OR NEW.symbol_kind IS DISTINCT FROM OLD.symbol_kind
      OR NEW.symbol_signature IS DISTINCT FROM OLD.symbol_signature
      OR NEW.section IS DISTINCT FROM OLD.section
      OR NEW.metadata IS DISTINCT FROM OLD.metadata
    THEN
      RAISE EXCEPTION 'project_chunks content is immutable outside candidate versions (version %)', OLD.version_id;
    END IF;
  END IF;
  -- No-old-enabled invariant: chunks owned by a terminal version (failed or
  -- replaced) can be disabled but never (re-)enabled.
  IF NEW.enabled IS TRUE AND NEW.version_id IS NOT NULL THEN
    SELECT v.status INTO owning_status
    FROM project_file_versions v
    WHERE v.id = NEW.version_id;
    IF owning_status IN ('failed', 'replaced') THEN
      RAISE EXCEPTION 'chunks owned by a % file version cannot be enabled (version %)', owning_status, NEW.version_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_chunks_candidate_immutable_guard ON project_chunks;
CREATE TRIGGER project_chunks_candidate_immutable_guard
BEFORE UPDATE ON project_chunks
FOR EACH ROW EXECUTE FUNCTION project_rag_chunks_candidate_immutable();

CREATE OR REPLACE FUNCTION project_rag_symbols_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.file_id IS DISTINCT FROM OLD.file_id
    OR NEW.version_id IS DISTINCT FROM OLD.version_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.symbol_type IS DISTINCT FROM OLD.symbol_type
    OR NEW.export_type IS DISTINCT FROM OLD.export_type
    OR NEW.signature IS DISTINCT FROM OLD.signature
    OR NEW.start_line IS DISTINCT FROM OLD.start_line
    OR NEW.end_line IS DISTINCT FROM OLD.end_line
    OR NEW.confidence IS DISTINCT FROM OLD.confidence
    OR NEW.metadata IS DISTINCT FROM OLD.metadata
  THEN
    RAISE EXCEPTION 'project_symbols rows are immutable';
  END IF;
  -- Only the supported SET NULL cascade may clear chunk_id; nothing else may
  -- rewrite it through UPDATE.
  IF NEW.chunk_id IS DISTINCT FROM OLD.chunk_id AND NEW.chunk_id IS NOT NULL THEN
    RAISE EXCEPTION 'project_symbols rows are immutable (chunk_id can only be cleared by cascade)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_symbols_immutable_guard ON project_symbols;
CREATE TRIGGER project_symbols_immutable_guard
BEFORE UPDATE ON project_symbols
FOR EACH ROW EXECUTE FUNCTION project_rag_symbols_immutable();

CREATE OR REPLACE FUNCTION project_rag_edges_candidate_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
    OR NEW.target_version_id IS DISTINCT FROM OLD.target_version_id
    OR NEW.source_file_id IS DISTINCT FROM OLD.source_file_id
    OR NEW.source_symbol_id IS DISTINCT FROM OLD.source_symbol_id
    OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
    OR NEW.source_ref_lower IS DISTINCT FROM OLD.source_ref_lower
    OR NEW.target_ref IS DISTINCT FROM OLD.target_ref
    OR NEW.target_ref_lower IS DISTINCT FROM OLD.target_ref_lower
    OR NEW.relation_type IS DISTINCT FROM OLD.relation_type
    OR NEW.confidence IS DISTINCT FROM OLD.confidence
    OR NEW.extraction_method IS DISTINCT FROM OLD.extraction_method
    OR NEW.metadata IS DISTINCT FROM OLD.metadata
  THEN
    RAISE EXCEPTION 'project_edges extraction content is immutable outside candidate versions (edge %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_edges_candidate_immutable_guard ON project_edges;
CREATE TRIGGER project_edges_candidate_immutable_guard
BEFORE UPDATE ON project_edges
FOR EACH ROW EXECUTE FUNCTION project_rag_edges_candidate_immutable();

CREATE OR REPLACE FUNCTION project_rag_embeddings_candidate_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_status text;
BEGIN
  IF NEW.version_id IS NULL THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_REQUIRED: project_embeddings_1024 inserts require a file version';
  END IF;

  SELECT v.status INTO candidate_status
  FROM project_file_versions v
  WHERE v.id = NEW.version_id
    AND v.project_id = NEW.project_id
    AND v.file_id = NEW.file_id;

  IF candidate_status IS NULL THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_NOT_FOUND: embedding version % is not owned by project % and file %',
      NEW.version_id, NEW.project_id, NEW.file_id;
  END IF;
  IF candidate_status <> 'pending' THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_IMMUTABLE: embedding version % is ''%''; only pending candidates accept inserts',
      NEW.version_id, candidate_status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM project_index_build_files b
    WHERE b.project_id = NEW.project_id
      AND b.file_id = NEW.file_id
      AND b.version_id = NEW.version_id
  ) THEN
    RAISE EXCEPTION 'CANDIDATE_VERSION_BUILD_MEMBER: embedding version % is already bound to an index build', NEW.version_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_embeddings_1024_candidate_insert_guard ON project_embeddings_1024;
CREATE TRIGGER project_embeddings_1024_candidate_insert_guard
BEFORE INSERT ON project_embeddings_1024
FOR EACH ROW EXECUTE FUNCTION project_rag_embeddings_candidate_insert_guard();

-- ---------------------------------------------------------------------------
-- Embedding profile identity (canonical vs legacy).
--
-- Adds the NOT NULL embedding_profile_hash column binding every embedding row
-- to its exact processing profile (schema version, provider, model,
-- dimensions, input format and its version). The canonical digest below MUST
-- stay byte-identical to
-- computeProjectRagEmbeddingProfileHash(projectRagPostgresEmbeddingProfileIdentity())
-- in scripts/project-rag/embeddings.ts: sha256 over the colon-joined identity
-- '1:<provider>:<model>:<dimensions>:<input-format>:<input-format-version>'.
--
-- Backfill is deterministic and never guesses:
-- - Rows whose stored lane matches the canonical lane exactly (provider
--   'llamacpp' or the NULL default the historical writer used, canonical
--   model, 1024 dimensions) receive the canonical digest.
-- - Every other row receives the 'legacy_unknown' sentinel. Its vector space
--   cannot be proven compatible with the canonical one, so promotion safety,
--   search predicates, and the writer all fail closed against it while the
--   embed flow may still add a proper canonical-profile row for the same
--   owner.
-- The duplicate preflight refuses to continue when two existing rows would
-- collapse onto the same (project_id, owner_type, owner_ref,
-- embedding_profile_hash) key; resolving that ambiguity requires an explicit
-- operator decision, not silent deletion or rewriting here.
-- ---------------------------------------------------------------------------

ALTER TABLE project_embeddings_1024
  ADD COLUMN IF NOT EXISTS embedding_profile_hash text;

UPDATE project_embeddings_1024
SET embedding_profile_hash =
  CASE
    WHEN coalesce(embedding_provider, 'llamacpp') = 'llamacpp'
      AND embedding_model = 'qwen3-embedding-1024'
      AND dimensions = 1024
    THEN encode(
      sha256(convert_to(
        '1:llamacpp:qwen3-embedding-1024:1024:plain-wellformed:1',
        'utf8'
      )),
      'hex'
    )
    ELSE 'legacy_unknown'
  END
WHERE embedding_profile_hash IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project_embeddings_1024
    GROUP BY project_id, owner_type, owner_ref, embedding_profile_hash
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = 'MIGRATION_AMBIGUOUS_OWNERSHIP: project_embeddings_1024 rows would share one profile identity key (project_id, owner_type, owner_ref, embedding_profile_hash); refusing to migrate without deletion or guessing';
  END IF;
END $$;

ALTER TABLE project_embeddings_1024
  ALTER COLUMN embedding_profile_hash SET NOT NULL;

-- The pre-profile owner/model key cannot represent two profiles for one owner.
-- Retire it only after the backfill and duplicate preflight above have made the
-- profile-owned key authoritative. This is idempotent for fresh installs and
-- upgrades that already applied this compatibility step.
ALTER TABLE project_embeddings_1024
  DROP CONSTRAINT IF EXISTS project_embeddings_1024_owner_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_embeddings_1024'::regclass
      AND conname = 'project_embeddings_1024_profile_owner_unique'
  ) THEN
    ALTER TABLE project_embeddings_1024
      ADD CONSTRAINT project_embeddings_1024_profile_owner_unique
      UNIQUE (project_id, owner_type, owner_ref, embedding_profile_hash);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS project_embeddings_1024_profile_hash_idx
  ON project_embeddings_1024 (embedding_profile_hash);

-- The core schema's generic touch trigger would make an UPDATE of an embedding
-- row observable even when its payload was unchanged. Embeddings are
-- insert-only after migration 010, so remove that generic mutator before the
-- immutable guard is installed.
DROP TRIGGER IF EXISTS project_embeddings_1024_touch_updated_at ON project_embeddings_1024;

-- Embedding rows become fully immutable through UPDATE once their profile is
-- recorded: identity fields (including the new profile hash), version
-- binding, vector payload, and source hash can never be rewritten in place.
-- A different file version or a different processing profile must be a NEW
-- insert-only row; corrections happen by inserting rows, never by mutating
-- history. DELETE stays untouched for the supported replacement/cascade
-- paths. This guard is created only after the backfill above has populated
-- every profile hash, because the backfill itself is the one sanctioned
-- UPDATE this table ever receives from the migration layer.
CREATE OR REPLACE FUNCTION project_rag_embeddings_binding_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
    OR NEW.owner_ref IS DISTINCT FROM OLD.owner_ref
    OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
    OR NEW.embedding_provider IS DISTINCT FROM OLD.embedding_provider
    OR NEW.dimensions IS DISTINCT FROM OLD.dimensions
    OR NEW.embedding_profile_hash IS DISTINCT FROM OLD.embedding_profile_hash
    OR NEW.version_id IS DISTINCT FROM OLD.version_id
    OR NEW.chunk_id IS DISTINCT FROM OLD.chunk_id
    OR NEW.symbol_id IS DISTINCT FROM OLD.symbol_id
    OR NEW.file_id IS DISTINCT FROM OLD.file_id
    OR NEW.embedding IS DISTINCT FROM OLD.embedding
    OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
    OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
  THEN
    RAISE EXCEPTION 'project_embeddings_1024 rows are immutable (identity, profile, version binding, payload, and source hash)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_embeddings_1024_binding_immutable_guard ON project_embeddings_1024;
CREATE TRIGGER project_embeddings_1024_binding_immutable_guard
BEFORE UPDATE ON project_embeddings_1024
FOR EACH ROW EXECUTE FUNCTION project_rag_embeddings_binding_immutable();

COMMIT;
