BEGIN;

-- T-06: bind scope policy, workspace identity, and scan completeness to the
-- immutable revision/snapshot records.  Columns are nullable for adoption of
-- rows written before this migration; new application writes populate them.

ALTER TABLE project_rag_repositories
  ADD COLUMN IF NOT EXISTS repository_hash text;

ALTER TABLE project_rag_workspaces
  ADD COLUMN IF NOT EXISTS worktree_git_dir text,
  ADD COLUMN IF NOT EXISTS workspace_hash text;

ALTER TABLE project_rag_revisions
  ADD COLUMN IF NOT EXISTS is_unborn boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS head_hash text,
  ADD COLUMN IF NOT EXISTS branch_hash text,
  ADD COLUMN IF NOT EXISTS detached_hash text,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS status_digest text,
  ADD COLUMN IF NOT EXISTS content_fingerprint text,
  ADD COLUMN IF NOT EXISTS identity_digest text;

ALTER TABLE project_ingest_snapshots
  ADD COLUMN IF NOT EXISTS repository_hash text,
  ADD COLUMN IF NOT EXISTS workspace_hash text,
  ADD COLUMN IF NOT EXISTS head_hash text,
  ADD COLUMN IF NOT EXISTS branch_hash text,
  ADD COLUMN IF NOT EXISTS detached_hash text,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS index_profile_hash text,
  ADD COLUMN IF NOT EXISTS root_manifest_hash text,
  ADD COLUMN IF NOT EXISTS completeness_status text,
  ADD COLUMN IF NOT EXISTS completeness_evidence_hash text,
  ADD COLUMN IF NOT EXISTS deletion_allowed boolean;

ALTER TABLE project_ingest_snapshots
  DROP CONSTRAINT IF EXISTS project_ingest_snapshots_completeness_status_check;
ALTER TABLE project_ingest_snapshots
  ADD CONSTRAINT project_ingest_snapshots_completeness_status_check
  CHECK (completeness_status IS NULL OR completeness_status IN ('complete', 'incomplete', 'blocked'));

-- A deletion plan is authoritative only when the scan proved complete.  Keep
-- the legacy NULL state admissible during adoption, but reject both an
-- incomplete/blocked status and a missing status when a writer asks the
-- database to authorize deletions.
ALTER TABLE project_ingest_snapshots
  DROP CONSTRAINT IF EXISTS project_ingest_snapshots_deletion_requires_complete;
ALTER TABLE project_ingest_snapshots
  ADD CONSTRAINT project_ingest_snapshots_deletion_requires_complete
  CHECK (NOT (deletion_allowed IS TRUE AND completeness_status IS DISTINCT FROM 'complete'));

-- A non-legacy completeness verdict must carry its bounded, canonical
-- evidence digest.  Unknown legacy rows remain NULL instead of being
-- backfilled with fabricated evidence.
ALTER TABLE project_ingest_snapshots
  DROP CONSTRAINT IF EXISTS project_ingest_snapshots_completeness_requires_evidence;
ALTER TABLE project_ingest_snapshots
  ADD CONSTRAINT project_ingest_snapshots_completeness_requires_evidence
  CHECK (completeness_status IS NULL OR completeness_evidence_hash IS NOT NULL);

-- Migration 003's freeze trigger must also protect the T-06 bindings.  Keep
-- the original function name so existing readiness probes and callers remain
-- valid; replacing the function is an additive compatibility change.
CREATE OR REPLACE FUNCTION project_rag_ingest_snapshot_freeze_binding_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'binding field id cannot be mutated after insert'; END IF;
    IF NEW.snapshot_uuid IS DISTINCT FROM OLD.snapshot_uuid THEN RAISE EXCEPTION 'binding field snapshot_uuid cannot be mutated after insert'; END IF;
    IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN RAISE EXCEPTION 'binding field project_id cannot be mutated after insert'; END IF;
    IF NEW.command_scope IS DISTINCT FROM OLD.command_scope THEN RAISE EXCEPTION 'binding field command_scope cannot be mutated after insert'; END IF;
    IF NEW.root_hash IS DISTINCT FROM OLD.root_hash THEN RAISE EXCEPTION 'binding field root_hash cannot be mutated after insert'; END IF;
    IF NEW.scope_hash IS DISTINCT FROM OLD.scope_hash THEN RAISE EXCEPTION 'binding field scope_hash cannot be mutated after insert'; END IF;
    IF NEW.policy_hash IS DISTINCT FROM OLD.policy_hash THEN RAISE EXCEPTION 'binding field policy_hash cannot be mutated after insert'; END IF;
    IF NEW.inventory_hash IS DISTINCT FROM OLD.inventory_hash THEN RAISE EXCEPTION 'binding field inventory_hash cannot be mutated after insert'; END IF;
    IF NEW.baseline_hash IS DISTINCT FROM OLD.baseline_hash THEN RAISE EXCEPTION 'binding field baseline_hash cannot be mutated after insert'; END IF;
    IF NEW.plan_hash IS DISTINCT FROM OLD.plan_hash THEN RAISE EXCEPTION 'binding field plan_hash cannot be mutated after insert'; END IF;
    IF NEW.repository_hash IS DISTINCT FROM OLD.repository_hash THEN RAISE EXCEPTION 'binding field repository_hash cannot be mutated after insert'; END IF;
    IF NEW.workspace_hash IS DISTINCT FROM OLD.workspace_hash THEN RAISE EXCEPTION 'binding field workspace_hash cannot be mutated after insert'; END IF;
    IF NEW.head_hash IS DISTINCT FROM OLD.head_hash THEN RAISE EXCEPTION 'binding field head_hash cannot be mutated after insert'; END IF;
    IF NEW.branch_hash IS DISTINCT FROM OLD.branch_hash THEN RAISE EXCEPTION 'binding field branch_hash cannot be mutated after insert'; END IF;
    IF NEW.detached_hash IS DISTINCT FROM OLD.detached_hash THEN RAISE EXCEPTION 'binding field detached_hash cannot be mutated after insert'; END IF;
    IF NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN RAISE EXCEPTION 'binding field content_hash cannot be mutated after insert'; END IF;
    IF NEW.index_profile_hash IS DISTINCT FROM OLD.index_profile_hash THEN RAISE EXCEPTION 'binding field index_profile_hash cannot be mutated after insert'; END IF;
    IF NEW.root_manifest_hash IS DISTINCT FROM OLD.root_manifest_hash THEN RAISE EXCEPTION 'binding field root_manifest_hash cannot be mutated after insert'; END IF;
    IF NEW.completeness_status IS DISTINCT FROM OLD.completeness_status THEN RAISE EXCEPTION 'binding field completeness_status cannot be mutated after insert'; END IF;
    IF NEW.completeness_evidence_hash IS DISTINCT FROM OLD.completeness_evidence_hash THEN RAISE EXCEPTION 'binding field completeness_evidence_hash cannot be mutated after insert'; END IF;
    IF NEW.deletion_allowed IS DISTINCT FROM OLD.deletion_allowed THEN RAISE EXCEPTION 'binding field deletion_allowed cannot be mutated after insert'; END IF;
    IF NEW.adds_count IS DISTINCT FROM OLD.adds_count THEN RAISE EXCEPTION 'binding field adds_count cannot be mutated after insert'; END IF;
    IF NEW.updates_count IS DISTINCT FROM OLD.updates_count THEN RAISE EXCEPTION 'binding field updates_count cannot be mutated after insert'; END IF;
    IF NEW.deletes_count IS DISTINCT FROM OLD.deletes_count THEN RAISE EXCEPTION 'binding field deletes_count cannot be mutated after insert'; END IF;
    IF NEW.eligible_count IS DISTINCT FROM OLD.eligible_count THEN RAISE EXCEPTION 'binding field eligible_count cannot be mutated after insert'; END IF;
    IF NEW.tracked_count IS DISTINCT FROM OLD.tracked_count THEN RAISE EXCEPTION 'binding field tracked_count cannot be mutated after insert'; END IF;
    IF NEW.blocked_findings IS DISTINCT FROM OLD.blocked_findings THEN RAISE EXCEPTION 'binding field blocked_findings cannot be mutated after insert'; END IF;
    IF NEW.blocked_finding_allowlist_hash IS DISTINCT FROM OLD.blocked_finding_allowlist_hash THEN RAISE EXCEPTION 'binding field blocked_finding_allowlist_hash cannot be mutated after insert'; END IF;
    IF NEW.suppressed_blocked_findings IS DISTINCT FROM OLD.suppressed_blocked_findings THEN RAISE EXCEPTION 'binding field suppressed_blocked_findings cannot be mutated after insert'; END IF;
    IF NEW.ttl_seconds IS DISTINCT FROM OLD.ttl_seconds THEN RAISE EXCEPTION 'binding field ttl_seconds cannot be mutated after insert'; END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'audit field created_at cannot be mutated after insert'; END IF;
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'audit field expires_at cannot be mutated after insert'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
