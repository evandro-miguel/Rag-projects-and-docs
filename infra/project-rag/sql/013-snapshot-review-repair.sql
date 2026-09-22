-- Repair the snapshot-review surface left incomplete by legacy adoption.
--
-- Migration 005 used CREATE TABLE IF NOT EXISTS, which is intentionally
-- idempotent but does not repair a pre-existing table with a partial shape.
-- This migration is the forward repair: it preserves every existing value,
-- refuses rows that cannot be truthfully made complete, and then restores the
-- 005 contract used by the Project RAG store.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.project_ingest_snapshot_reviews') IS NULL
     OR to_regclass('public.project_ingest_snapshots') IS NULL
     OR to_regclass('public.project_repositories') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42P01',
      MESSAGE = 'MIGRATION_SNAPSHOT_REVIEW_REPAIR: migration 005 review dependencies are missing';
  END IF;
END;
$$;

-- Add missing columns without defaults first.  operator_id intentionally stays
-- nullable until unattributed legacy rows are archived below: reviewer_id is a
-- separate audit identity and must never be copied into operator_id.
ALTER TABLE project_ingest_snapshot_reviews
  ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS snapshot_id bigint,
  ADD COLUMN IF NOT EXISTS snapshot_uuid uuid,
  ADD COLUMN IF NOT EXISTS project_id bigint,
  ADD COLUMN IF NOT EXISTS reviewer_id text,
  ADD COLUMN IF NOT EXISTS operator_id text,
  ADD COLUMN IF NOT EXISTS reviewer_capability text,
  ADD COLUMN IF NOT EXISTS evidence_id text,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS command_scope text,
  ADD COLUMN IF NOT EXISTS token_digest text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

ALTER TABLE project_ingest_snapshot_reviews
  ALTER COLUMN reviewer_capability SET DEFAULT 'high-trust-write',
  ALTER COLUMN approved_at SET DEFAULT now(),
  ALTER COLUMN created_at SET DEFAULT now();

-- Preserve legacy rows for which no operator can be truthfully identified.
-- Archive columns remain nullable because this table records the legacy row as
-- observed; no missing audit value is fabricated during repair.
CREATE TABLE IF NOT EXISTS project_ingest_snapshot_reviews_legacy_archive (
  archive_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_review_id bigint NOT NULL,
  snapshot_id      bigint,
  snapshot_uuid    uuid,
  project_id       bigint,
  reviewer_id      text,
  operator_id      text,
  reviewer_capability text,
  evidence_id      text,
  reason           text,
  command_scope   text,
  token_digest    text,
  approved_at     timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz,
  archived_at     timestamptz NOT NULL DEFAULT now(),
  archive_reason  text NOT NULL DEFAULT 'legacy_unattributed'
);

ALTER TABLE project_ingest_snapshot_reviews_legacy_archive
  ADD COLUMN IF NOT EXISTS archive_id bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS legacy_review_id bigint,
  ADD COLUMN IF NOT EXISTS snapshot_id bigint,
  ADD COLUMN IF NOT EXISTS snapshot_uuid uuid,
  ADD COLUMN IF NOT EXISTS project_id bigint,
  ADD COLUMN IF NOT EXISTS reviewer_id text,
  ADD COLUMN IF NOT EXISTS operator_id text,
  ADD COLUMN IF NOT EXISTS reviewer_capability text,
  ADD COLUMN IF NOT EXISTS evidence_id text,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS command_scope text,
  ADD COLUMN IF NOT EXISTS token_digest text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archive_reason text;

ALTER TABLE project_ingest_snapshot_reviews_legacy_archive
  ALTER COLUMN archived_at SET DEFAULT now(),
  ALTER COLUMN archive_reason SET DEFAULT 'legacy_unattributed',
  ALTER COLUMN legacy_review_id SET NOT NULL,
  ALTER COLUMN archived_at SET NOT NULL,
  ALTER COLUMN archive_reason SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_ingest_snapshot_reviews_legacy_archive'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE project_ingest_snapshot_reviews_legacy_archive
      ADD CONSTRAINT project_ingest_snapshot_reviews_legacy_archive_pkey
      PRIMARY KEY (archive_id);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS project_ingest_snapshot_reviews_legacy_archive_review_unique
  ON project_ingest_snapshot_reviews_legacy_archive (legacy_review_id);

CREATE OR REPLACE FUNCTION project_rag_snapshot_review_archive_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'legacy snapshot-review archive is immutable';
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS project_ingest_snapshot_reviews_legacy_archive_immutable
  ON project_ingest_snapshot_reviews_legacy_archive;
CREATE TRIGGER project_ingest_snapshot_reviews_legacy_archive_immutable
BEFORE UPDATE OR DELETE ON project_ingest_snapshot_reviews_legacy_archive
FOR EACH ROW EXECUTE FUNCTION project_rag_snapshot_review_archive_immutable();

DROP TRIGGER IF EXISTS project_ingest_snapshot_reviews_legacy_archive_truncate_immutable
  ON project_ingest_snapshot_reviews_legacy_archive;
CREATE TRIGGER project_ingest_snapshot_reviews_legacy_archive_truncate_immutable
BEFORE TRUNCATE ON project_ingest_snapshot_reviews_legacy_archive
FOR EACH STATEMENT EXECUTE FUNCTION project_rag_snapshot_review_archive_immutable();

-- The insert and delete are one transaction.  A successful replay has no
-- active unattributed rows; a conflicting legacy id fails closed instead of
-- discarding a potentially different audit record.
INSERT INTO project_ingest_snapshot_reviews_legacy_archive (
  legacy_review_id,
  snapshot_id,
  snapshot_uuid,
  project_id,
  reviewer_id,
  operator_id,
  reviewer_capability,
  evidence_id,
  reason,
  command_scope,
  token_digest,
  approved_at,
  expires_at,
  created_at
)
SELECT
  id,
  snapshot_id,
  snapshot_uuid,
  project_id,
  reviewer_id,
  operator_id,
  reviewer_capability,
  evidence_id,
  reason,
  command_scope,
  token_digest,
  approved_at,
  expires_at,
  created_at
FROM project_ingest_snapshot_reviews
WHERE operator_id IS NULL
  AND expires_at IS NOT NULL
  AND expires_at <= now();

DELETE FROM project_ingest_snapshot_reviews
WHERE operator_id IS NULL
  AND expires_at IS NOT NULL
  AND expires_at <= now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project_ingest_snapshot_reviews
    WHERE operator_id IS NULL
      AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'MIGRATION_SNAPSHOT_REVIEW_REPAIR: active review rows without operator_id are not expired; refusing to fabricate audit data';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM project_ingest_snapshot_reviews
    WHERE id IS NULL
       OR snapshot_id IS NULL
       OR snapshot_uuid IS NULL
       OR project_id IS NULL
       OR reviewer_id IS NULL
       OR operator_id IS NULL
       OR reviewer_capability IS NULL
       OR evidence_id IS NULL
       OR reason IS NULL
       OR command_scope IS NULL
       OR token_digest IS NULL
       OR approved_at IS NULL
       OR expires_at IS NULL
       OR created_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'MIGRATION_SNAPSHOT_REVIEW_REPAIR: existing review rows lack required values; refusing to fabricate audit data';
  END IF;
END;
$$;

ALTER TABLE project_ingest_snapshot_reviews
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN snapshot_id SET NOT NULL,
  ALTER COLUMN snapshot_uuid SET NOT NULL,
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN reviewer_id SET NOT NULL,
  ALTER COLUMN operator_id SET NOT NULL,
  ALTER COLUMN reviewer_capability SET NOT NULL,
  ALTER COLUMN evidence_id SET NOT NULL,
  ALTER COLUMN reason SET NOT NULL,
  ALTER COLUMN command_scope SET NOT NULL,
  ALTER COLUMN token_digest SET NOT NULL,
  ALTER COLUMN approved_at SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL;

-- The decision table is safe to create when absent: it carries no legacy
-- values.  Existing partial tables are repaired by the additive steps below.
CREATE TABLE IF NOT EXISTS project_ingest_snapshot_review_decisions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id   bigint NOT NULL,
  snapshot_uuid uuid NOT NULL,
  project_id    bigint NOT NULL,
  decision      text NOT NULL,
  operator_id   text NOT NULL,
  reason        text NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE project_ingest_snapshot_review_decisions
  ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS snapshot_id bigint,
  ADD COLUMN IF NOT EXISTS snapshot_uuid uuid,
  ADD COLUMN IF NOT EXISTS project_id bigint,
  ADD COLUMN IF NOT EXISTS decision text,
  ADD COLUMN IF NOT EXISTS operator_id text,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

ALTER TABLE project_ingest_snapshot_review_decisions
  ALTER COLUMN decided_at SET DEFAULT now(),
  ALTER COLUMN created_at SET DEFAULT now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project_ingest_snapshot_review_decisions
    WHERE id IS NULL
       OR snapshot_id IS NULL
       OR snapshot_uuid IS NULL
       OR project_id IS NULL
       OR decision IS NULL
       OR operator_id IS NULL
       OR reason IS NULL
       OR decided_at IS NULL
       OR created_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'MIGRATION_SNAPSHOT_REVIEW_REPAIR: existing decision rows lack required values; refusing to fabricate audit data';
  END IF;
END;
$$;

ALTER TABLE project_ingest_snapshot_review_decisions
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN snapshot_id SET NOT NULL,
  ALTER COLUMN snapshot_uuid SET NOT NULL,
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN decision SET NOT NULL,
  ALTER COLUMN operator_id SET NOT NULL,
  ALTER COLUMN reason SET NOT NULL,
  ALTER COLUMN decided_at SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_ingest_snapshot_reviews'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE project_ingest_snapshot_reviews
      ADD CONSTRAINT project_ingest_snapshot_reviews_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_ingest_snapshot_review_decisions'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE project_ingest_snapshot_review_decisions
      ADD CONSTRAINT project_ingest_snapshot_review_decisions_pkey PRIMARY KEY (id);
  END IF;
END;
$$;

-- Recreate named constraints so a partial or stale legacy definition cannot
-- silently satisfy readiness with weaker semantics.  ADD fails on duplicate
-- or cross-project legacy data and the transaction rolls back unchanged.
ALTER TABLE project_ingest_snapshot_reviews
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_one_per_snapshot,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_token_digest_unique,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_capability_check,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_reviewer_id_check,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_operator_id_check,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_evidence_id_check,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_scope_length_check,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_reason_length_check,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_expiry_check,
  ADD CONSTRAINT project_ingest_snapshot_reviews_one_per_snapshot
    UNIQUE (snapshot_id),
  ADD CONSTRAINT project_ingest_snapshot_reviews_token_digest_unique
    UNIQUE (token_digest),
  ADD CONSTRAINT project_ingest_snapshot_reviews_capability_check
    CHECK (reviewer_capability = 'high-trust-write'),
  ADD CONSTRAINT project_ingest_snapshot_reviews_reviewer_id_check
    CHECK (reviewer_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT project_ingest_snapshot_reviews_operator_id_check
    CHECK (operator_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT project_ingest_snapshot_reviews_evidence_id_check
    CHECK (evidence_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT project_ingest_snapshot_reviews_scope_length_check
    CHECK (length(command_scope) BETWEEN 1 AND 128),
  ADD CONSTRAINT project_ingest_snapshot_reviews_reason_length_check
    CHECK (length(reason) BETWEEN 1 AND 1024),
  ADD CONSTRAINT project_ingest_snapshot_reviews_expiry_check
    CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '1 day');

ALTER TABLE project_ingest_snapshot_review_decisions
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_review_decisions_one_per_snapshot,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_review_decisions_kind_check,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_review_decisions_operator_id_check,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_review_decisions_reason_length_check,
  ADD CONSTRAINT project_ingest_snapshot_review_decisions_one_per_snapshot
    UNIQUE (snapshot_id),
  ADD CONSTRAINT project_ingest_snapshot_review_decisions_kind_check
    CHECK (decision IN ('REJECTED', 'DEFERRED')),
  ADD CONSTRAINT project_ingest_snapshot_review_decisions_operator_id_check
    CHECK (operator_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT project_ingest_snapshot_review_decisions_reason_length_check
    CHECK (length(reason) BETWEEN 1 AND 1024);

-- Explicitly named foreign keys make the repaired shape inspectable while the
-- existing row values are validated by PostgreSQL before COMMIT.
ALTER TABLE project_ingest_snapshot_reviews
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_snapshot_id_fkey,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_snapshot_uuid_fkey,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_reviews_project_id_fkey,
  ADD CONSTRAINT project_ingest_snapshot_reviews_snapshot_id_fkey
    FOREIGN KEY (snapshot_id) REFERENCES project_ingest_snapshots(id) ON DELETE CASCADE,
  ADD CONSTRAINT project_ingest_snapshot_reviews_snapshot_uuid_fkey
    FOREIGN KEY (snapshot_uuid) REFERENCES project_ingest_snapshots(snapshot_uuid) ON DELETE CASCADE,
  ADD CONSTRAINT project_ingest_snapshot_reviews_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES project_repositories(id) ON DELETE CASCADE;

ALTER TABLE project_ingest_snapshot_review_decisions
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_review_decisions_snapshot_id_fkey,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_review_decisions_snapshot_uuid_fkey,
  DROP CONSTRAINT IF EXISTS project_ingest_snapshot_review_decisions_project_id_fkey,
  ADD CONSTRAINT project_ingest_snapshot_review_decisions_snapshot_id_fkey
    FOREIGN KEY (snapshot_id) REFERENCES project_ingest_snapshots(id) ON DELETE CASCADE,
  ADD CONSTRAINT project_ingest_snapshot_review_decisions_snapshot_uuid_fkey
    FOREIGN KEY (snapshot_uuid) REFERENCES project_ingest_snapshots(snapshot_uuid) ON DELETE CASCADE,
  ADD CONSTRAINT project_ingest_snapshot_review_decisions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES project_repositories(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS project_ingest_snapshot_reviews_expiry_idx
  ON project_ingest_snapshot_reviews (expires_at);
CREATE INDEX IF NOT EXISTS project_ingest_snapshot_reviews_project_idx
  ON project_ingest_snapshot_reviews (project_id, approved_at DESC);
CREATE INDEX IF NOT EXISTS project_ingest_snapshot_review_decisions_project_idx
  ON project_ingest_snapshot_review_decisions (project_id, decided_at DESC);

-- Keep the snapshot failure-code surface required by operator rejection.
ALTER TABLE project_ingest_snapshots
  DROP CONSTRAINT IF EXISTS project_ingest_snapshots_failure_code_check,
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
