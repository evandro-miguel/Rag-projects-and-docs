BEGIN;

-- A published build is the sole read boundary.  Ingest may create pending
-- file versions freely, but readers keep using the prior published build
-- until this pointer is swapped in one transaction.
CREATE TABLE IF NOT EXISTS project_index_builds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  revision_id bigint REFERENCES project_rag_revisions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'building',
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT project_index_builds_status_check CHECK (
    status IN ('building', 'published', 'failed', 'retired', 'garbage_collected')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS project_index_builds_one_published
  ON project_index_builds (project_id) WHERE status = 'published';

-- Composite keys bind each published-file row to one project.  The base schema
-- predates immutable builds, so add the referenced keys here for both fresh
-- installs and idempotent upgrades.  The later validated FKs intentionally
-- refuse a legacy cross-project association rather than leaving it reachable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_index_builds'::regclass AND conname = 'project_index_builds_id_project_unique') THEN
    ALTER TABLE project_index_builds
      ADD CONSTRAINT project_index_builds_id_project_unique UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_files'::regclass AND conname = 'project_files_id_project_unique') THEN
    ALTER TABLE project_files
      ADD CONSTRAINT project_files_id_project_unique UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_file_versions'::regclass AND conname = 'project_file_versions_id_project_unique') THEN
    ALTER TABLE project_file_versions
      ADD CONSTRAINT project_file_versions_id_project_unique UNIQUE (id, project_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS project_index_build_files (
  build_id bigint NOT NULL,
  project_id bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
  file_id bigint NOT NULL,
  version_id bigint NOT NULL,
  source_path text NOT NULL,
  absolute_path text NOT NULL,
  lang text,
  status text NOT NULL,
  size_bytes bigint NOT NULL,
  metadata_quality text NOT NULL,
  skeleton_text text,
  outline_version text,
  PRIMARY KEY (build_id, file_id),
  UNIQUE (build_id, source_path),
  CONSTRAINT project_index_build_files_build_project_fk
    FOREIGN KEY (build_id, project_id)
    REFERENCES project_index_builds (id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_index_build_files_file_project_fk
    FOREIGN KEY (file_id, project_id)
    REFERENCES project_files (id, project_id) ON DELETE RESTRICT,
  CONSTRAINT project_index_build_files_version_project_fk
    FOREIGN KEY (version_id, project_id)
    REFERENCES project_file_versions (id, project_id) ON DELETE RESTRICT
);

-- CREATE TABLE IF NOT EXISTS does not alter installations that ran a prior
-- migration-007 revision.  Add the same validated FKs on rerun; any legacy
-- mismatch aborts this transaction before partial schema state is committed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_index_build_files'::regclass AND conname = 'project_index_build_files_build_project_fk') THEN
    ALTER TABLE project_index_build_files
      ADD CONSTRAINT project_index_build_files_build_project_fk
      FOREIGN KEY (build_id, project_id)
      REFERENCES project_index_builds (id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_index_build_files'::regclass AND conname = 'project_index_build_files_file_project_fk') THEN
    ALTER TABLE project_index_build_files
      ADD CONSTRAINT project_index_build_files_file_project_fk
      FOREIGN KEY (file_id, project_id)
      REFERENCES project_files (id, project_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_index_build_files'::regclass AND conname = 'project_index_build_files_version_project_fk') THEN
    ALTER TABLE project_index_build_files
      ADD CONSTRAINT project_index_build_files_version_project_fk
      FOREIGN KEY (version_id, project_id)
      REFERENCES project_file_versions (id, project_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS project_index_build_files_project_version_idx
  ON project_index_build_files (project_id, build_id, version_id);

-- Existing installations receive one immutable baseline rather than silently
-- exposing an empty index after the migration.
INSERT INTO project_index_builds (project_id, status, published_at)
SELECT p.id, 'published', now()
FROM project_repositories p
WHERE NOT EXISTS (
  SELECT 1 FROM project_index_builds b WHERE b.project_id = p.id AND b.status = 'published'
)
  AND EXISTS (
    SELECT 1 FROM project_files f WHERE f.project_id = p.id AND f.active_version_id IS NOT NULL
  );

INSERT INTO project_index_build_files (
  build_id, project_id, file_id, version_id, source_path, absolute_path, lang,
  status, size_bytes, metadata_quality, skeleton_text, outline_version
)
SELECT b.id, f.project_id, f.id, f.active_version_id, f.source_path, f.absolute_path, f.lang,
  f.status, f.size_bytes, f.metadata_quality, v.skeleton_text, v.outline_version
FROM project_index_builds b
JOIN project_files f ON f.project_id = b.project_id AND f.active_version_id IS NOT NULL
JOIN project_file_versions v ON v.id = f.active_version_id
WHERE b.status = 'published'
ON CONFLICT (build_id, file_id) DO NOTHING;

COMMIT;
