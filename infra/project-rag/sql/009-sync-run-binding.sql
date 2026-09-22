BEGIN;

-- Bind every new sync run to the exact ingest snapshot and, for durable
-- execution, the exact job lease.  Nullable columns preserve historical rows;
-- application transactions require both bindings for new ingest rows.
ALTER TABLE project_sync_runs
  ADD COLUMN IF NOT EXISTS snapshot_uuid uuid,
  ADD COLUMN IF NOT EXISTS job_id bigint;

-- Composite parent keys make project consistency a database invariant without
-- requiring a cross-table CHECK constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_ingest_snapshots'::regclass
      AND conname = 'project_ingest_snapshots_snapshot_uuid_project_unique'
  ) THEN
    ALTER TABLE project_ingest_snapshots
      ADD CONSTRAINT project_ingest_snapshots_snapshot_uuid_project_unique
      UNIQUE (snapshot_uuid, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_jobs'::regclass
      AND conname = 'project_jobs_id_project_unique'
  ) THEN
    ALTER TABLE project_jobs
      ADD CONSTRAINT project_jobs_id_project_unique UNIQUE (id, project_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_sync_runs'::regclass
      AND conname = 'project_sync_runs_snapshot_project_fk'
  ) THEN
    ALTER TABLE project_sync_runs
      ADD CONSTRAINT project_sync_runs_snapshot_project_fk
      FOREIGN KEY (snapshot_uuid, project_id)
      REFERENCES project_ingest_snapshots (snapshot_uuid, project_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_sync_runs'::regclass
      AND conname = 'project_sync_runs_job_project_fk'
  ) THEN
    ALTER TABLE project_sync_runs
      ADD CONSTRAINT project_sync_runs_job_project_fk
      FOREIGN KEY (job_id, project_id)
      REFERENCES project_jobs (id, project_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- One immutable sync-run binding per snapshot prevents a second same-snapshot
-- row from becoming an indistinguishable finalizer target.  Historical rows
-- with no snapshot binding are intentionally outside this index.
CREATE UNIQUE INDEX IF NOT EXISTS project_sync_runs_snapshot_binding_unique
  ON project_sync_runs (snapshot_uuid)
  WHERE snapshot_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_sync_runs_binding_idx
  ON project_sync_runs (project_id, snapshot_uuid, job_id)
  WHERE snapshot_uuid IS NOT NULL;

CREATE OR REPLACE FUNCTION project_rag_sync_run_freeze_binding_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'binding field project_id cannot be mutated after insert';
  END IF;
  IF NEW.snapshot_uuid IS DISTINCT FROM OLD.snapshot_uuid THEN
    RAISE EXCEPTION 'binding field snapshot_uuid cannot be mutated after insert';
  END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'binding field job_id cannot be mutated after insert';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_sync_runs_freeze_binding_fields ON project_sync_runs;
CREATE TRIGGER project_sync_runs_freeze_binding_fields
BEFORE UPDATE ON project_sync_runs
FOR EACH ROW EXECUTE FUNCTION project_rag_sync_run_freeze_binding_fields();

COMMIT;
