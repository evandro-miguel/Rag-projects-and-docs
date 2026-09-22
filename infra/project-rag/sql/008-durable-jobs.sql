-- Durable Project RAG jobs.  A job lease is fenced: each successful claim
-- increments fence_token and every terminal/checkpoint update requires it.

ALTER TABLE project_jobs
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS fence_token bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS snapshot_uuid uuid
    REFERENCES project_ingest_snapshots(snapshot_uuid) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS project_jobs_active_dedupe_idx
  ON project_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS project_jobs_claim_idx
  ON project_jobs (status, created_at, id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS project_jobs_snapshot_idx
  ON project_jobs (snapshot_uuid)
  WHERE snapshot_uuid IS NOT NULL;
