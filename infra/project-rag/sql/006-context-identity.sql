BEGIN;

-- Project RAG's original registry identifies an indexed dataset.  It cannot
-- identify multiple worktrees of one Git repository safely, so context is
-- deliberately additive and never inferred from a slug or basename.
CREATE TABLE IF NOT EXISTS project_rag_repositories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  git_common_dir text NOT NULL UNIQUE,
  remote_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_rag_workspaces (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repository_id bigint NOT NULL REFERENCES project_rag_repositories(id) ON DELETE RESTRICT,
  canonical_root_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_rag_workspaces_repository_idx
  ON project_rag_workspaces (repository_id);

CREATE TABLE IF NOT EXISTS project_rag_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES project_rag_workspaces(id) ON DELETE CASCADE,
  head_oid text,
  branch_name text,
  is_detached boolean NOT NULL,
  dirty_digest text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_rag_revisions_head_oid_check
    CHECK (head_oid IS NULL OR head_oid ~ '^[0-9a-f]{40,64}$'),
  CONSTRAINT project_rag_revisions_branch_name_check
    CHECK (branch_name IS NULL OR length(branch_name) BETWEEN 1 AND 1024),
  CONSTRAINT project_rag_revisions_dirty_digest_check
    CHECK (dirty_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_rag_revisions_detached_branch_check
    CHECK ((is_detached AND branch_name IS NULL) OR NOT is_detached)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_rag_revisions_identity_unique
  ON project_rag_revisions (
    workspace_id,
    coalesce(head_oid, ''),
    coalesce(branch_name, ''),
    is_detached,
    dirty_digest
  );

-- An alias is a deliberate compatibility binding.  `legacy_project_id` stays
-- NULL until an exact canonical-root match is established by the application;
-- migration intentionally performs no slug or basename backfill.
CREATE TABLE IF NOT EXISTS project_rag_workspace_aliases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES project_rag_workspaces(id) ON DELETE CASCADE,
  alias text NOT NULL,
  alias_normalized text NOT NULL,
  legacy_project_id bigint UNIQUE REFERENCES project_repositories(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_rag_workspace_aliases_alias_check
    CHECK (length(alias) BETWEEN 1 AND 255),
  CONSTRAINT project_rag_workspace_aliases_alias_normalized_check
    CHECK (alias_normalized = lower(alias) AND length(alias_normalized) BETWEEN 1 AND 255),
  CONSTRAINT project_rag_workspace_aliases_normalized_unique UNIQUE (alias_normalized)
);

CREATE INDEX IF NOT EXISTS project_rag_workspace_aliases_workspace_idx
  ON project_rag_workspace_aliases (workspace_id);

DROP TRIGGER IF EXISTS project_rag_repositories_touch_updated_at ON project_rag_repositories;
CREATE TRIGGER project_rag_repositories_touch_updated_at
BEFORE UPDATE ON project_rag_repositories
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

DROP TRIGGER IF EXISTS project_rag_workspaces_touch_updated_at ON project_rag_workspaces;
CREATE TRIGGER project_rag_workspaces_touch_updated_at
BEFORE UPDATE ON project_rag_workspaces
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

COMMIT;
