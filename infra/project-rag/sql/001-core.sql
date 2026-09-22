BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION project_rag_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION project_rag_refresh_file_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.source_path_normalized := lower(unaccent(coalesce(NEW.source_path, '')));
  NEW.search_text_normalized := lower(
    unaccent(concat_ws(' ', NEW.source_path, NEW.lang, NEW.skeleton_text))
  );
  NEW.search_vector := to_tsvector('simple', NEW.search_text_normalized);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION project_rag_refresh_chunk_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text_normalized := lower(
    unaccent(
      concat_ws(
        ' ',
        NEW.symbol_name,
        NEW.symbol_kind,
        NEW.symbol_signature,
        coalesce(nullif(NEW.searchable_text, ''), NEW.content)
      )
    )
  );
  NEW.search_vector := to_tsvector('simple', NEW.search_text_normalized);
  RETURN NEW;
END;
$$;

CREATE TABLE project_repositories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  root_path text NOT NULL,
  normalized_root_path text NOT NULL,
  git_remote text,
  default_branch text,
  active_branch text,
  worktree_name text,
  origin text,
  ephemeral boolean NOT NULL DEFAULT false,
  owner text,
  expires_at double precision,
  last_used_at double precision,
  status text NOT NULL DEFAULT 'active',
  sync_mode text NOT NULL DEFAULT 'full',
  include_roots text[] NOT NULL DEFAULT '{}',
  ignore_rules text[] NOT NULL DEFAULT '{}',
  sensitivity_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_repositories_slug_unique UNIQUE (slug),
  CONSTRAINT project_repositories_root_unique UNIQUE (normalized_root_path),
  CONSTRAINT project_repositories_status_check CHECK (
    status IN ('active', 'paused', 'blocked', 'archived')
  ),
  CONSTRAINT project_repositories_sync_mode_check CHECK (
    sync_mode IN ('full', 'file', 'diff', 'watch')
  )
);

CREATE TABLE project_scope_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  action text NOT NULL,
  previous_include_roots text[] NOT NULL DEFAULT '{}',
  next_include_roots text[] NOT NULL DEFAULT '{}',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_scope_events_action_check CHECK (
    action IN ('register', 'set', 'add', 'remove')
  )
);

CREATE TABLE project_scope_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  scope_source_event_id bigint REFERENCES project_scope_events(id) ON DELETE SET NULL,
  include_roots text[] NOT NULL DEFAULT '{}',
  scope_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_scope_snapshots_source_type_check CHECK (
    source_type IN ('event', 'registry')
  )
);

CREATE TABLE project_files (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  source_path text NOT NULL,
  absolute_path text NOT NULL,
  content_hash text NOT NULL,
  file_modified_at double precision NOT NULL,
  lang text,
  ecosystem text,
  size_bytes bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  metadata_quality text NOT NULL DEFAULT 'minimal',
  skeleton_text text,
  outline_version text,
  active_version_id bigint,
  latest_version_id bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_path_normalized text NOT NULL DEFAULT '',
  search_text_normalized text NOT NULL DEFAULT '',
  search_vector tsvector NOT NULL DEFAULT ''::tsvector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_files_identity_unique UNIQUE (project_id, source_path),
  CONSTRAINT project_files_status_check CHECK (
    status IN ('pending', 'indexed', 'skipped', 'blocked', 'unsupported', 'error', 'deleted')
  ),
  CONSTRAINT project_files_metadata_quality_check CHECK (
    metadata_quality IN ('full', 'partial', 'minimal')
  )
);

CREATE TABLE project_file_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  file_id bigint NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  content_hash text NOT NULL,
  file_modified_at double precision NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  lang text,
  metadata_quality text NOT NULL DEFAULT 'minimal',
  skeleton_text text,
  outline_version text,
  compatibility_status text NOT NULL DEFAULT 'pending',
  scope_snapshot_id bigint REFERENCES project_scope_snapshots(id) ON DELETE SET NULL,
  scope_source_event_id bigint REFERENCES project_scope_events(id) ON DELETE SET NULL,
  scope_snapshot_include_roots text[] NOT NULL DEFAULT '{}',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  failed_at timestamptz,
  promoted_at timestamptz,
  replaced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_file_versions_status_check CHECK (
    status IN ('pending', 'ready', 'failed', 'replaced')
  ),
  CONSTRAINT project_file_versions_compatibility_status_check CHECK (
    compatibility_status IN (
      'pending', 'indexed', 'skipped', 'blocked', 'unsupported', 'error', 'deleted'
    )
  ),
  CONSTRAINT project_file_versions_metadata_quality_check CHECK (
    metadata_quality IN ('full', 'partial', 'minimal')
  )
);

ALTER TABLE project_files
  ADD CONSTRAINT project_files_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES project_file_versions(id) ON DELETE SET NULL;

ALTER TABLE project_files
  ADD CONSTRAINT project_files_latest_version_fk
  FOREIGN KEY (latest_version_id) REFERENCES project_file_versions(id) ON DELETE SET NULL;

CREATE TABLE project_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  file_id bigint NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  version_id bigint REFERENCES project_file_versions(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  searchable_text text NOT NULL DEFAULT '',
  start_line integer,
  end_line integer,
  symbol_name text,
  symbol_kind text,
  symbol_signature text,
  section text,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_text_normalized text NOT NULL DEFAULT '',
  search_vector tsvector NOT NULL DEFAULT ''::tsvector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_chunks_file_version_chunk_unique UNIQUE (file_id, version_id, chunk_index),
  CONSTRAINT project_chunks_line_order_check CHECK (
    start_line IS NULL OR end_line IS NULL OR start_line <= end_line
  )
);

CREATE TABLE project_symbols (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  file_id bigint NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  version_id bigint REFERENCES project_file_versions(id) ON DELETE CASCADE,
  chunk_id bigint REFERENCES project_chunks(id) ON DELETE SET NULL,
  name text NOT NULL,
  symbol_type text NOT NULL,
  export_type text NOT NULL DEFAULT 'unknown',
  signature text,
  start_line integer,
  end_line integer,
  confidence double precision,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_symbols_line_order_check CHECK (
    start_line IS NULL OR end_line IS NULL OR start_line <= end_line
  )
);

CREATE TABLE project_edges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  source_version_id bigint REFERENCES project_file_versions(id) ON DELETE CASCADE,
  target_version_id bigint REFERENCES project_file_versions(id) ON DELETE CASCADE,
  source_file_id bigint REFERENCES project_files(id) ON DELETE CASCADE,
  source_symbol_id bigint REFERENCES project_symbols(id) ON DELETE CASCADE,
  source_ref text,
  source_ref_lower text,
  target_file_id bigint REFERENCES project_files(id) ON DELETE CASCADE,
  target_symbol_id bigint REFERENCES project_symbols(id) ON DELETE CASCADE,
  target_ref text,
  target_ref_lower text,
  relation_type text NOT NULL,
  confidence double precision NOT NULL DEFAULT 1,
  extraction_method text NOT NULL DEFAULT 'unknown',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  scope_snapshot_id bigint REFERENCES project_scope_snapshots(id) ON DELETE SET NULL,
  scope_source_event_id bigint REFERENCES project_scope_events(id) ON DELETE SET NULL,
  config_hash text,
  manifest_id bigint,
  status text NOT NULL DEFAULT 'running',
  mode text NOT NULL DEFAULT 'full',
  files_scanned integer NOT NULL DEFAULT 0,
  files_added integer NOT NULL DEFAULT 0,
  files_updated integer NOT NULL DEFAULT 0,
  files_deleted integer NOT NULL DEFAULT 0,
  chunks_created integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_sync_runs_status_check CHECK (
    status IN ('running', 'completed', 'failed', 'partial')
  ),
  CONSTRAINT project_sync_runs_mode_check CHECK (
    mode IN ('full', 'file', 'diff', 'watch')
  )
);

CREATE TABLE project_index_manifests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  sync_run_id bigint NOT NULL REFERENCES project_sync_runs(id) ON DELETE CASCADE,
  scope_snapshot_id bigint NOT NULL REFERENCES project_scope_snapshots(id) ON DELETE RESTRICT,
  scope_source_event_id bigint REFERENCES project_scope_events(id) ON DELETE SET NULL,
  scope_snapshot_include_roots text[] NOT NULL DEFAULT '{}',
  config_hash text NOT NULL,
  mode text NOT NULL DEFAULT 'full',
  status text NOT NULL DEFAULT 'running',
  embedding_provider text NOT NULL,
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL,
  input_mode text NOT NULL,
  redaction_version text,
  chunker_version text,
  files_scanned integer NOT NULL DEFAULT 0,
  files_selected integer NOT NULL DEFAULT 0,
  files_indexed integer NOT NULL DEFAULT 0,
  files_blocked integer NOT NULL DEFAULT 0,
  files_skipped integer NOT NULL DEFAULT 0,
  files_deleted integer NOT NULL DEFAULT 0,
  chunks_created integer NOT NULL DEFAULT 0,
  embeddings_created integer NOT NULL DEFAULT 0,
  symbols_created integer NOT NULL DEFAULT 0,
  edges_created integer NOT NULL DEFAULT 0,
  invariant_summary_ref text,
  eval_summary_ref text,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_index_manifests_status_check CHECK (
    status IN ('running', 'completed', 'failed', 'partial')
  ),
  CONSTRAINT project_index_manifests_mode_check CHECK (
    mode IN ('full', 'file', 'diff', 'watch')
  )
);

ALTER TABLE project_sync_runs
  ADD CONSTRAINT project_sync_runs_manifest_fk
  FOREIGN KEY (manifest_id) REFERENCES project_index_manifests(id) ON DELETE SET NULL;

CREATE TABLE project_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL,
  project_id bigint REFERENCES project_repositories(id) ON DELETE CASCADE,
  dedupe_key text,
  status text NOT NULL DEFAULT 'queued',
  capability text,
  tool_name text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  heartbeat_at timestamptz,
  last_attempt_at timestamptz,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_jobs_status_check CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  )
);

CREATE TABLE project_embeddings_1024 (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  owner_type text NOT NULL,
  owner_ref text NOT NULL,
  file_id bigint REFERENCES project_files(id) ON DELETE CASCADE,
  chunk_id bigint REFERENCES project_chunks(id) ON DELETE CASCADE,
  symbol_id bigint REFERENCES project_symbols(id) ON DELETE CASCADE,
  version_id bigint REFERENCES project_file_versions(id) ON DELETE CASCADE,
  embedding_model text NOT NULL,
  embedding_provider text,
  dimensions integer NOT NULL DEFAULT 1024,
  embedding halfvec(1024) NOT NULL,
  source_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_embeddings_1024_owner_type_check CHECK (
    owner_type IN ('file', 'chunk', 'symbol')
  ),
  CONSTRAINT project_embeddings_1024_dimensions_check CHECK (dimensions = 1024),
  CONSTRAINT project_embeddings_1024_owner_check CHECK (
    (owner_type = 'file' AND file_id IS NOT NULL AND chunk_id IS NULL AND symbol_id IS NULL)
    OR (owner_type = 'chunk' AND file_id IS NULL AND chunk_id IS NOT NULL AND symbol_id IS NULL)
    OR (owner_type = 'symbol' AND file_id IS NULL AND chunk_id IS NULL AND symbol_id IS NOT NULL)
  ),
  CONSTRAINT project_embeddings_1024_owner_unique UNIQUE (
    project_id, owner_type, owner_ref, embedding_model
  )
);

CREATE INDEX project_repositories_status_idx ON project_repositories (status);
CREATE INDEX project_repositories_origin_idx ON project_repositories (origin);
CREATE INDEX project_repositories_ephemeral_idx ON project_repositories (ephemeral);
CREATE INDEX project_repositories_owner_idx ON project_repositories (owner);

CREATE INDEX project_scope_events_project_created_idx
  ON project_scope_events (project_id, created_at);
CREATE INDEX project_scope_snapshots_project_created_idx
  ON project_scope_snapshots (project_id, created_at);
CREATE INDEX project_scope_snapshots_project_hash_idx
  ON project_scope_snapshots (project_id, scope_hash);

CREATE INDEX project_files_project_status_idx ON project_files (project_id, status);
CREATE INDEX project_files_project_hash_idx ON project_files (project_id, content_hash);
CREATE INDEX project_files_source_path_trgm_idx
  ON project_files USING gin (source_path_normalized gin_trgm_ops);
CREATE INDEX project_files_search_vector_idx ON project_files USING gin (search_vector);

CREATE INDEX project_file_versions_project_file_idx
  ON project_file_versions (project_id, file_id);
CREATE INDEX project_file_versions_file_created_idx
  ON project_file_versions (file_id, created_at);
CREATE INDEX project_file_versions_project_status_idx
  ON project_file_versions (project_id, status);

CREATE INDEX project_chunks_project_file_idx ON project_chunks (project_id, file_id);
CREATE INDEX project_chunks_project_version_idx ON project_chunks (project_id, version_id);
CREATE INDEX project_chunks_project_symbol_idx ON project_chunks (project_id, symbol_name);
CREATE INDEX project_chunks_search_trgm_idx
  ON project_chunks USING gin (search_text_normalized gin_trgm_ops);
CREATE INDEX project_chunks_search_vector_idx ON project_chunks USING gin (search_vector);

CREATE INDEX project_symbols_project_name_idx ON project_symbols (project_id, name);
CREATE INDEX project_symbols_project_file_idx ON project_symbols (project_id, file_id);
CREATE INDEX project_symbols_project_version_idx ON project_symbols (project_id, version_id);
CREATE INDEX project_symbols_project_type_idx ON project_symbols (project_id, symbol_type);

CREATE INDEX project_edges_project_idx ON project_edges (project_id);
CREATE INDEX project_edges_project_source_file_idx ON project_edges (project_id, source_file_id);
CREATE INDEX project_edges_project_source_version_idx
  ON project_edges (project_id, source_version_id);
CREATE INDEX project_edges_project_source_symbol_idx
  ON project_edges (project_id, source_symbol_id);
CREATE INDEX project_edges_project_target_symbol_idx
  ON project_edges (project_id, target_symbol_id);
CREATE INDEX project_edges_project_relation_idx ON project_edges (project_id, relation_type);
CREATE INDEX project_edges_project_relation_target_ref_idx
  ON project_edges (project_id, relation_type, target_ref);
CREATE INDEX project_edges_project_relation_target_ref_lower_idx
  ON project_edges (project_id, relation_type, target_ref_lower);

CREATE INDEX project_sync_runs_project_started_idx ON project_sync_runs (project_id, started_at);
CREATE INDEX project_sync_runs_project_status_idx ON project_sync_runs (project_id, status);

CREATE INDEX project_index_manifests_project_started_idx
  ON project_index_manifests (project_id, started_at);
CREATE INDEX project_index_manifests_project_sync_run_idx
  ON project_index_manifests (project_id, sync_run_id);
CREATE INDEX project_index_manifests_project_status_idx
  ON project_index_manifests (project_id, status);

CREATE INDEX project_jobs_status_created_idx ON project_jobs (status, created_at);
CREATE INDEX project_jobs_dedupe_key_idx ON project_jobs (dedupe_key);
CREATE INDEX project_jobs_project_created_idx ON project_jobs (project_id, created_at);
CREATE INDEX project_jobs_type_status_created_idx ON project_jobs (type, status, created_at);
CREATE INDEX project_jobs_status_heartbeat_idx ON project_jobs (status, heartbeat_at);

CREATE INDEX project_embeddings_1024_project_owner_idx
  ON project_embeddings_1024 (project_id, owner_type, owner_ref);
CREATE INDEX project_embeddings_1024_project_version_idx
  ON project_embeddings_1024 (project_id, version_id);
CREATE INDEX project_embeddings_1024_model_dimensions_idx
  ON project_embeddings_1024 (embedding_model, dimensions);
CREATE INDEX project_embeddings_1024_hnsw_idx
  ON project_embeddings_1024
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 128);

CREATE TRIGGER project_repositories_touch_updated_at
BEFORE UPDATE ON project_repositories
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

CREATE TRIGGER project_files_refresh_search
BEFORE INSERT OR UPDATE ON project_files
FOR EACH ROW EXECUTE FUNCTION project_rag_refresh_file_search();

CREATE TRIGGER project_files_touch_updated_at
BEFORE UPDATE ON project_files
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

CREATE TRIGGER project_file_versions_touch_updated_at
BEFORE UPDATE ON project_file_versions
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

CREATE TRIGGER project_chunks_refresh_search
BEFORE INSERT OR UPDATE ON project_chunks
FOR EACH ROW EXECUTE FUNCTION project_rag_refresh_chunk_search();

CREATE TRIGGER project_chunks_touch_updated_at
BEFORE UPDATE ON project_chunks
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

CREATE TRIGGER project_sync_runs_touch_updated_at
BEFORE UPDATE ON project_sync_runs
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

CREATE TRIGGER project_index_manifests_touch_updated_at
BEFORE UPDATE ON project_index_manifests
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

CREATE TRIGGER project_jobs_touch_updated_at
BEFORE UPDATE ON project_jobs
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

CREATE TRIGGER project_embeddings_1024_touch_updated_at
BEFORE UPDATE ON project_embeddings_1024
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

COMMIT;
