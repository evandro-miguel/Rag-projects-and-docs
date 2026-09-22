BEGIN;

-- ==========================================================================
-- 004-blocked-finding-allowlist.sql
--
-- Generic exact blocked-finding allowlist infrastructure:
--   1. project_repositories.blocked_finding_allowlist
--   2. project_ingest_snapshots.blocked_finding_allowlist_hash
--   3. project_ingest_snapshots.suppressed_blocked_findings
--   4. Updated freeze trigger protects the new binding fields.
--
-- Idempotent: uses ADD COLUMN IF NOT EXISTS and DO blocks for constraints.
-- ==========================================================================

-- -------------------------------------------------------------------------
-- 1. project_repositories.blocked_finding_allowlist
--
-- Stores allowlist entries as a JSONB array of {relativePath, category}
-- objects.  MUST be a JSON array and MUST not exceed 32 entries.
-- -------------------------------------------------------------------------
ALTER TABLE project_repositories
  ADD COLUMN IF NOT EXISTS blocked_finding_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_repositories'::regclass
      AND conname = 'project_repositories_blocked_finding_allowlist_is_array'
  ) THEN
    ALTER TABLE project_repositories
      ADD CONSTRAINT project_repositories_blocked_finding_allowlist_is_array
      CHECK (jsonb_typeof(blocked_finding_allowlist) = 'array');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_repositories'::regclass
      AND conname = 'project_repositories_blocked_finding_allowlist_max_length'
  ) THEN
    ALTER TABLE project_repositories
      ADD CONSTRAINT project_repositories_blocked_finding_allowlist_max_length
      CHECK (jsonb_array_length(blocked_finding_allowlist) <= 32);
  END IF;
END $$;

-- -------------------------------------------------------------------------
-- 2. project_ingest_snapshots.blocked_finding_allowlist_hash
--
-- Deterministic SHA-256 hex of the allowlist at snapshot-creation time.
-- The default is the SHA-256 digest of the empty string, which matches
-- the empty-allowlist hash produced by deterministicHash('') on the
-- TypeScript side.
-- -------------------------------------------------------------------------
ALTER TABLE project_ingest_snapshots
  ADD COLUMN IF NOT EXISTS blocked_finding_allowlist_hash text NOT NULL
  DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

-- -------------------------------------------------------------------------
-- 3. project_ingest_snapshots.suppressed_blocked_findings
--
-- Compact JSONB array of blocked-finding entries that were silenced by
-- the allowlist at snapshot time.  MUST be a JSON array and MUST not
-- exceed 32 entries.
-- -------------------------------------------------------------------------
ALTER TABLE project_ingest_snapshots
  ADD COLUMN IF NOT EXISTS suppressed_blocked_findings jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_ingest_snapshots'::regclass
      AND conname = 'project_ingest_snapshots_suppressed_blocked_findings_is_array'
  ) THEN
    ALTER TABLE project_ingest_snapshots
      ADD CONSTRAINT project_ingest_snapshots_suppressed_blocked_findings_is_array
      CHECK (jsonb_typeof(suppressed_blocked_findings) = 'array');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_ingest_snapshots'::regclass
      AND conname = 'project_ingest_snapshots_suppressed_blocked_findings_max_length'
  ) THEN
    ALTER TABLE project_ingest_snapshots
      ADD CONSTRAINT project_ingest_snapshots_suppressed_blocked_findings_max_length
      CHECK (jsonb_array_length(suppressed_blocked_findings) <= 32);
  END IF;
END $$;

-- -------------------------------------------------------------------------
-- 4. Updated freeze trigger — protects the two new binding fields
--    (blocked_finding_allowlist_hash, suppressed_blocked_findings) in
--    addition to all existing fields from migration 003.
-- -------------------------------------------------------------------------
-- -------------------------------------------------------------------------
-- 5. Policy-race trigger on project_repositories
--
-- Blocks UPDATE to include_roots, ignore_rules, or blocked_finding_allowlist
-- while a CONSUMING snapshot exists for that project.  This prevents a
-- configuration change from racing with an in-progress ingest that may
-- already have bound its preflight plan to the old configuration.
--
-- Only the CONSUMING status is guarded — PREPARED/REVIEW_REQUIRED snapshots
-- can be failed and re-created with new config.  CONSUMING is the active
-- mutation phase where config drift would corrupt the index.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION project_rag_repo_block_config_during_consuming()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW.include_roots IS DISTINCT FROM OLD.include_roots
      OR NEW.ignore_rules IS DISTINCT FROM OLD.ignore_rules
      OR NEW.blocked_finding_allowlist IS DISTINCT FROM OLD.blocked_finding_allowlist
    ) AND EXISTS (
      SELECT 1
      FROM project_ingest_snapshots
      WHERE project_id = OLD.id
        AND status = 'CONSUMING'
    ) THEN
      RAISE EXCEPTION 'cannot modify include_roots, ignore_rules, or blocked_finding_allowlist while a CONSUMING ingest snapshot exists';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_repositories_block_config_during_consuming ON project_repositories;
CREATE TRIGGER project_repositories_block_config_during_consuming
BEFORE UPDATE ON project_repositories
FOR EACH ROW EXECUTE FUNCTION project_rag_repo_block_config_during_consuming();

-- -------------------------------------------------------------------------
-- 6. Updated freeze trigger — protects the two new binding fields
--    (blocked_finding_allowlist_hash, suppressed_blocked_findings) in
--    addition to all existing fields from migration 003.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION project_rag_ingest_snapshot_freeze_binding_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Frozen binding/audit fields — any change raises an exception
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'binding field id cannot be mutated after insert';
    END IF;
    IF NEW.snapshot_uuid IS DISTINCT FROM OLD.snapshot_uuid THEN
      RAISE EXCEPTION 'binding field snapshot_uuid cannot be mutated after insert';
    END IF;
    IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION 'binding field project_id cannot be mutated after insert';
    END IF;
    IF NEW.command_scope IS DISTINCT FROM OLD.command_scope THEN
      RAISE EXCEPTION 'binding field command_scope cannot be mutated after insert';
    END IF;
    IF NEW.root_hash IS DISTINCT FROM OLD.root_hash THEN
      RAISE EXCEPTION 'binding field root_hash cannot be mutated after insert';
    END IF;
    IF NEW.scope_hash IS DISTINCT FROM OLD.scope_hash THEN
      RAISE EXCEPTION 'binding field scope_hash cannot be mutated after insert';
    END IF;
    IF NEW.policy_hash IS DISTINCT FROM OLD.policy_hash THEN
      RAISE EXCEPTION 'binding field policy_hash cannot be mutated after insert';
    END IF;
    IF NEW.inventory_hash IS DISTINCT FROM OLD.inventory_hash THEN
      RAISE EXCEPTION 'binding field inventory_hash cannot be mutated after insert';
    END IF;
    IF NEW.baseline_hash IS DISTINCT FROM OLD.baseline_hash THEN
      RAISE EXCEPTION 'binding field baseline_hash cannot be mutated after insert';
    END IF;
    IF NEW.plan_hash IS DISTINCT FROM OLD.plan_hash THEN
      RAISE EXCEPTION 'binding field plan_hash cannot be mutated after insert';
    END IF;
    IF NEW.adds_count IS DISTINCT FROM OLD.adds_count THEN
      RAISE EXCEPTION 'binding field adds_count cannot be mutated after insert';
    END IF;
    IF NEW.updates_count IS DISTINCT FROM OLD.updates_count THEN
      RAISE EXCEPTION 'binding field updates_count cannot be mutated after insert';
    END IF;
    IF NEW.deletes_count IS DISTINCT FROM OLD.deletes_count THEN
      RAISE EXCEPTION 'binding field deletes_count cannot be mutated after insert';
    END IF;
    IF NEW.eligible_count IS DISTINCT FROM OLD.eligible_count THEN
      RAISE EXCEPTION 'binding field eligible_count cannot be mutated after insert';
    END IF;
    IF NEW.tracked_count IS DISTINCT FROM OLD.tracked_count THEN
      RAISE EXCEPTION 'binding field tracked_count cannot be mutated after insert';
    END IF;
    IF NEW.blocked_findings IS DISTINCT FROM OLD.blocked_findings THEN
      RAISE EXCEPTION 'binding field blocked_findings cannot be mutated after insert';
    END IF;
    -- 004: new binding fields
    IF NEW.blocked_finding_allowlist_hash IS DISTINCT FROM OLD.blocked_finding_allowlist_hash THEN
      RAISE EXCEPTION 'binding field blocked_finding_allowlist_hash cannot be mutated after insert';
    END IF;
    IF NEW.suppressed_blocked_findings IS DISTINCT FROM OLD.suppressed_blocked_findings THEN
      RAISE EXCEPTION 'binding field suppressed_blocked_findings cannot be mutated after insert';
    END IF;
    IF NEW.ttl_seconds IS DISTINCT FROM OLD.ttl_seconds THEN
      RAISE EXCEPTION 'binding field ttl_seconds cannot be mutated after insert';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'audit field created_at cannot be mutated after insert';
    END IF;
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'audit field expires_at cannot be mutated after insert';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
