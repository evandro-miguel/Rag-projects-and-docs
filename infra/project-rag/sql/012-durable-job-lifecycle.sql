-- Durable Project RAG job lifecycle.
--
-- Migration 008 introduced fenced leases.  This migration makes the
-- scheduler state explicit so a worker restart cannot turn a transient
-- failure into an eternal queued/running row or silently retry a review gate.

-- The migration runner executes this file as a raw batch, so own one
-- transaction to prevent partial DDL from surviving a mid-script failure.
BEGIN;

ALTER TABLE project_jobs
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_reason text;

ALTER TABLE project_jobs
  DROP CONSTRAINT IF EXISTS project_jobs_status_check;

ALTER TABLE project_jobs
  ADD CONSTRAINT project_jobs_status_check CHECK (
    status IN (
      'queued', 'running', 'blocked-review', 'retry-wait',
      'succeeded', 'failed', 'dead-letter', 'cancelled'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_jobs'::regclass
      AND conname = 'project_jobs_attempts_nonnegative'
  ) THEN
    ALTER TABLE project_jobs
      ADD CONSTRAINT project_jobs_attempts_nonnegative CHECK (attempts >= 0);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_jobs'::regclass
      AND conname = 'project_jobs_max_attempts_positive'
  ) THEN
    ALTER TABLE project_jobs
      ADD CONSTRAINT project_jobs_max_attempts_positive CHECK (max_attempts > 0);
  END IF;
END;
$$;

-- Migration 008's active-dedupe and claim predicates did not include the
-- scheduler states added above.  Rebuild those indexes with the complete
-- active set; completed/dead/cancelled rows remain dedupe-replayable.
DROP INDEX IF EXISTS project_jobs_active_dedupe_idx;
CREATE UNIQUE INDEX IF NOT EXISTS project_jobs_active_dedupe_idx
  ON project_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL
    AND status IN ('queued', 'running', 'blocked-review', 'retry-wait');

DROP INDEX IF EXISTS project_jobs_claim_idx;
CREATE INDEX IF NOT EXISTS project_jobs_claim_idx
  ON project_jobs (status, available_at, created_at, id)
  WHERE status IN ('queued', 'retry-wait', 'running');

CREATE INDEX IF NOT EXISTS project_jobs_available_claim_idx
  ON project_jobs (status, available_at, created_at, id)
  WHERE status IN ('queued', 'retry-wait');

CREATE INDEX IF NOT EXISTS project_jobs_recovery_idx
  ON project_jobs (status, lease_expires_at, id)
  WHERE status = 'running';

COMMIT;
