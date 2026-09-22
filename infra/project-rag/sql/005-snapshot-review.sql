BEGIN;

-- ============================================================================
-- 005-snapshot-review.sql
--
-- Single-use, snapshot-bound approvals for large Project RAG inventory
-- mutations (SPEC-007 §8, RULE-013). The application verifies a signed
-- high-trust reviewer token before inserting a row here. This table stores
-- only the bounded audit record and a digest of that token, never the token
-- or signing key.
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_ingest_snapshot_reviews (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id         bigint NOT NULL
    REFERENCES project_ingest_snapshots(id) ON DELETE CASCADE,
  snapshot_uuid       uuid NOT NULL
    REFERENCES project_ingest_snapshots(snapshot_uuid) ON DELETE CASCADE,
  project_id          bigint NOT NULL
    REFERENCES project_repositories(id) ON DELETE CASCADE,
  reviewer_id         text NOT NULL,
  operator_id         text NOT NULL,
  reviewer_capability text NOT NULL DEFAULT 'high-trust-write',
  evidence_id         text NOT NULL,
  reason              text NOT NULL,
  command_scope       text NOT NULL,
  token_digest        text NOT NULL,
  approved_at         timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT project_ingest_snapshot_reviews_one_per_snapshot
    UNIQUE (snapshot_id),
  CONSTRAINT project_ingest_snapshot_reviews_token_digest_unique
    UNIQUE (token_digest),
  CONSTRAINT project_ingest_snapshot_reviews_capability_check
    CHECK (reviewer_capability = 'high-trust-write'),
  CONSTRAINT project_ingest_snapshot_reviews_reviewer_id_check
    CHECK (reviewer_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT project_ingest_snapshot_reviews_operator_id_check
    CHECK (operator_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT project_ingest_snapshot_reviews_evidence_id_check
    CHECK (evidence_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT project_ingest_snapshot_reviews_scope_length_check
    CHECK (length(command_scope) BETWEEN 1 AND 128),
  CONSTRAINT project_ingest_snapshot_reviews_reason_length_check
    CHECK (length(reason) BETWEEN 1 AND 1024),
  CONSTRAINT project_ingest_snapshot_reviews_expiry_check
    CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '1 day')
);

CREATE INDEX IF NOT EXISTS project_ingest_snapshot_reviews_expiry_idx
  ON project_ingest_snapshot_reviews (expires_at);

CREATE INDEX IF NOT EXISTS project_ingest_snapshot_reviews_project_idx
  ON project_ingest_snapshot_reviews (project_id, approved_at DESC);

-- Non-approval decisions are terminal for this exact snapshot: a deferred or
-- rejected inventory must be re-preflighted instead of being revived later.
CREATE TABLE IF NOT EXISTS project_ingest_snapshot_review_decisions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id   bigint NOT NULL
    REFERENCES project_ingest_snapshots(id) ON DELETE CASCADE,
  snapshot_uuid uuid NOT NULL
    REFERENCES project_ingest_snapshots(snapshot_uuid) ON DELETE CASCADE,
  project_id    bigint NOT NULL
    REFERENCES project_repositories(id) ON DELETE CASCADE,
  decision      text NOT NULL,
  operator_id   text NOT NULL,
  reason        text NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT project_ingest_snapshot_review_decisions_one_per_snapshot
    UNIQUE (snapshot_id),
  CONSTRAINT project_ingest_snapshot_review_decisions_kind_check
    CHECK (decision IN ('REJECTED', 'DEFERRED')),
  CONSTRAINT project_ingest_snapshot_review_decisions_operator_id_check
    CHECK (operator_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT project_ingest_snapshot_review_decisions_reason_length_check
    CHECK (length(reason) BETWEEN 1 AND 1024)
);

CREATE INDEX IF NOT EXISTS project_ingest_snapshot_review_decisions_project_idx
  ON project_ingest_snapshot_review_decisions (project_id, decided_at DESC);

-- Existing deployments may already have migration 003's original failure-code
-- constraint. Extend it transactionally for an explicit operator rejection.
ALTER TABLE project_ingest_snapshots
  DROP CONSTRAINT IF EXISTS project_ingest_snapshots_failure_code_check;
ALTER TABLE project_ingest_snapshots
  ADD CONSTRAINT project_ingest_snapshots_failure_code_check CHECK (
    failure_code IS NULL OR failure_code IN (
      'BLOCKED_ROOT_FINDINGS',
      'RESCAN_MISMATCH',
      'PRECONDITION_FAILURE',
      'CLAIM_LEASE_ABANDONED',
      'REVIEW_REJECTED',
      'SYSTEM_ERROR'
    )
  );

CREATE OR REPLACE FUNCTION project_rag_snapshot_review_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'snapshot review records are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_ingest_snapshot_reviews_immutable
  ON project_ingest_snapshot_reviews;
CREATE TRIGGER project_ingest_snapshot_reviews_immutable
BEFORE UPDATE ON project_ingest_snapshot_reviews
FOR EACH ROW EXECUTE FUNCTION project_rag_snapshot_review_immutable();

DROP TRIGGER IF EXISTS project_ingest_snapshot_review_decisions_immutable
  ON project_ingest_snapshot_review_decisions;
CREATE TRIGGER project_ingest_snapshot_review_decisions_immutable
BEFORE UPDATE ON project_ingest_snapshot_review_decisions
FOR EACH ROW EXECUTE FUNCTION project_rag_snapshot_review_immutable();

COMMIT;
