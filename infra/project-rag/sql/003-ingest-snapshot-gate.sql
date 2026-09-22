BEGIN;

-- ==========================================================================
-- 003-ingest-snapshot-gate.sql
--
-- Immutable snapshot-bound prepare/consume gate for Project RAG index
-- mutations (SPEC-007 §8, RULE-013, DEC-003).
--
-- Every mutation that adds, updates, or deletes indexed content must
-- route through this gate or return a refusal.  The snapshot row is
-- immutable in its binding and audit fields after creation; only the
-- lifecycle state-machine fields may be updated.
--
-- States: PREPARED -> REVIEW_REQUIRED | CONSUMING -> CONSUMED | FAILED | EXPIRED
-- ==========================================================================

-- -------------------------------------------------------------------------
-- 1. Freeze trigger: only lifecycle fields may change after INSERT
--
--    Binding/audit fields are frozen: id, snapshot_uuid, project_id,
--    command_scope, the six hashes, the five counts, blocked_findings,
--    ttl_seconds, created_at, expires_at.
--
--    Lifecycle fields may be set by transitions: status, failure_code,
--    failure_detail, claimed_at, consumed_at, failed_at,
--    lease_expires_at, updated_at.
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

-- -------------------------------------------------------------------------
-- 2. Main snapshot table
--
--    snapshot_uuid: external immutable identifier (UNIQUE, generated on insert)
--    id:            internal serial PK (not exposed externally)
-- -------------------------------------------------------------------------
CREATE TABLE project_ingest_snapshots (
  -- Identity
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_uuid   uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id      bigint NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,

  -- Command / scope metadata
  command_scope   text NOT NULL DEFAULT 'full',

  -- Deterministic binding hashes (hex SHA-256, case-sensitive raw bytes)
  root_hash       text,   -- hash of the project root path
  scope_hash      text,   -- hash of include-roots (code-point sorted)
  policy_hash     text,   -- hash of ignore-rules + sensitivity profile
  inventory_hash  text,   -- hash of the current tracked inventory
  baseline_hash   text,   -- hash of the indexed baseline at snapshot creation
  plan_hash       text,   -- hash of the planned delta operation

  -- File counts (immutable once set)
  adds_count      integer NOT NULL DEFAULT 0,
  updates_count   integer NOT NULL DEFAULT 0,
  deletes_count   integer NOT NULL DEFAULT 0,
  eligible_count  integer NOT NULL DEFAULT 0,
  tracked_count   integer NOT NULL DEFAULT 0,

  -- Compact relative blocked findings (JSONB array of {category,count,sample?})
  -- NEVER stores absolute paths, file contents, or secrets.
  -- Any non-empty findings cause a terminal FAILED (BLOCKED_ROOT_FINDINGS) snapshot.
  -- CHECK enforces it is a JSON array (not object, scalar, or null).
  blocked_findings jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT project_ingest_snapshots_blocked_findings_is_array CHECK (jsonb_typeof(blocked_findings) = 'array'),

  -- -----------------------------------------------------------------------
  -- State machine (SPEC-007 §8)
  --   PREPARED        — preflight complete, immutable row written, no mutation started
  --   REVIEW_REQUIRED — delta exceeds threshold; fail-closed (no reviewer configured)
  --   CONSUMING       — gate passed; writer actively consuming the snapshot
  --   CONSUMED        — mutation completed successfully
  --   FAILED          — rescan mismatch, precondition failure, or system error
  --   EXPIRED         — TTL lease elapsed; fresh snapshot required
  --
  --   Initial insert status: PREPARED, REVIEW_REQUIRED, or FAILED (must include code).
  --   REVIEW_REQUIRED is non-consumable until migration 005 records a current,
  --   single-use approval from the qualified snapshot-review authority.
  -- -----------------------------------------------------------------------
  status          text NOT NULL DEFAULT 'PREPARED',

  -- Failure detail (REQUIRED when status = 'FAILED')
  -- failure_code must be an allowed code; failure_detail max 1024 chars
  failure_code    text,
  failure_detail  text,

  -- TTL / lease timing
  ttl_seconds     integer NOT NULL DEFAULT 300,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  lease_expires_at timestamptz,
  claimed_at      timestamptz,
  consumed_at     timestamptz,
  failed_at       timestamptz,

  -- Audit timestamps
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- -----------------------------------------------------------------------
  -- Constraints
  -- -----------------------------------------------------------------------
  CONSTRAINT project_ingest_snapshots_snapshot_uuid_unique UNIQUE (snapshot_uuid),
  CONSTRAINT project_ingest_snapshots_status_check CHECK (
    status IN ('PREPARED', 'REVIEW_REQUIRED', 'CONSUMING', 'CONSUMED', 'FAILED', 'EXPIRED')
  ),
  CONSTRAINT project_ingest_snapshots_fail_requires_code CHECK (
    status <> 'FAILED' OR failure_code IS NOT NULL
  ),
  CONSTRAINT project_ingest_snapshots_failure_code_check CHECK (
    failure_code IS NULL OR failure_code IN (
      'BLOCKED_ROOT_FINDINGS',
      'RESCAN_MISMATCH',
      'PRECONDITION_FAILURE',
      'CLAIM_LEASE_ABANDONED',
      'REVIEW_REJECTED',
      'SYSTEM_ERROR'
    )
  ),
  CONSTRAINT project_ingest_snapshots_failure_detail_length CHECK (
    failure_detail IS NULL OR length(failure_detail) <= 1024
  ),
  CONSTRAINT project_ingest_snapshots_ttl_check CHECK (ttl_seconds >= 30 AND ttl_seconds <= 86400),
  CONSTRAINT project_ingest_snapshots_adds_positive CHECK (adds_count >= 0),
  CONSTRAINT project_ingest_snapshots_updates_positive CHECK (updates_count >= 0),
  CONSTRAINT project_ingest_snapshots_deletes_positive CHECK (deletes_count >= 0),
  CONSTRAINT project_ingest_snapshots_eligible_positive CHECK (eligible_count >= 0),
  CONSTRAINT project_ingest_snapshots_tracked_positive CHECK (tracked_count >= 0)
);

-- -------------------------------------------------------------------------
-- 3. Partial unique index: at most one CONSUMING snapshot per project
-- -------------------------------------------------------------------------
CREATE UNIQUE INDEX project_ingest_snapshots_one_consuming_idx
  ON project_ingest_snapshots (project_id)
  WHERE status = 'CONSUMING';

-- -------------------------------------------------------------------------
-- 4. Indexes for expiry sweeps, project listing, status transitions
-- -------------------------------------------------------------------------
CREATE INDEX project_ingest_snapshots_expiry_idx
  ON project_ingest_snapshots (expires_at)
  WHERE status IN ('PREPARED', 'REVIEW_REQUIRED');

CREATE INDEX project_ingest_snapshots_lease_expiry_idx
  ON project_ingest_snapshots (lease_expires_at)
  WHERE status = 'CONSUMING';

CREATE INDEX project_ingest_snapshots_project_status_idx
  ON project_ingest_snapshots (project_id, status, created_at DESC);

-- Note: snapshot_uuid has an implicit btree index from the UNIQUE constraint.
-- An explicit index is redundant and not created here.

-- -------------------------------------------------------------------------
-- 5. Freeze trigger: binding + audit fields are immutable after INSERT
-- -------------------------------------------------------------------------
CREATE TRIGGER project_ingest_snapshot_freeze_binding_fields
BEFORE UPDATE ON project_ingest_snapshots
FOR EACH ROW EXECUTE FUNCTION project_rag_ingest_snapshot_freeze_binding_fields();

-- -------------------------------------------------------------------------
-- 6. Touch updated_at trigger
-- -------------------------------------------------------------------------
CREATE TRIGGER project_ingest_snapshots_touch_updated_at
BEFORE UPDATE ON project_ingest_snapshots
FOR EACH ROW EXECUTE FUNCTION project_rag_touch_updated_at();

COMMIT;
