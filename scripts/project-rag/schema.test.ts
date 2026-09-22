import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const coreSql = readFileSync(
  new URL('../../infra/project-rag/sql/001-core.sql', import.meta.url),
  'utf8'
);
const versionedChunkMigration = readFileSync(
  new URL('../../infra/project-rag/sql/002-versioned-chunk-uniqueness.sql', import.meta.url),
  'utf8'
);
const snapshotGateSql = readFileSync(
  new URL('../../infra/project-rag/sql/003-ingest-snapshot-gate.sql', import.meta.url),
  'utf8'
);
const allowlistSql = readFileSync(
  new URL('../../infra/project-rag/sql/004-blocked-finding-allowlist.sql', import.meta.url),
  'utf8'
);
const snapshotReviewSql = readFileSync(
  new URL('../../infra/project-rag/sql/005-snapshot-review.sql', import.meta.url),
  'utf8'
);
const contextIdentitySql = readFileSync(
  new URL('../../infra/project-rag/sql/006-context-identity.sql', import.meta.url),
  'utf8'
);
const indexBuildPublicationSql = readFileSync(
  new URL('../../infra/project-rag/sql/007-index-build-publication.sql', import.meta.url),
  'utf8'
);
const syncRunBindingSql = readFileSync(
  new URL('../../infra/project-rag/sql/009-sync-run-binding.sql', import.meta.url),
  'utf8'
);
const versionOwnedDerivedDataSql = readFileSync(
  new URL('../../infra/project-rag/sql/010-version-owned-derived-data.sql', import.meta.url),
  'utf8'
);
const scopeIdentityCompletenessSql = readFileSync(
  new URL('../../infra/project-rag/sql/011-scope-identity-completeness.sql', import.meta.url),
  'utf8'
);
const durableJobLifecycleSql = readFileSync(
  new URL('../../infra/project-rag/sql/012-durable-job-lifecycle.sql', import.meta.url),
  'utf8'
);
const snapshotReviewRepairSql = readFileSync(
  new URL('../../infra/project-rag/sql/013-snapshot-review-repair.sql', import.meta.url),
  'utf8'
);

describe('Project RAG snapshot-review repair schema (013)', () => {
  it('is transactional, additive, and fail-closed for unknown audit values', () => {
    expect(snapshotReviewRepairSql).toContain('BEGIN;');
    expect(snapshotReviewRepairSql).toContain('COMMIT;');
    expect(snapshotReviewRepairSql).toContain('ADD COLUMN IF NOT EXISTS operator_id text');
    expect(snapshotReviewRepairSql).toContain('MIGRATION_SNAPSHOT_REVIEW_REPAIR');
    expect(snapshotReviewRepairSql).not.toMatch(/\bTRUNCATE\s+TABLE\b/i);
    expect(snapshotReviewRepairSql).toContain('DELETE FROM project_ingest_snapshot_reviews');
    expect(snapshotReviewRepairSql).toContain('operator_id IS NULL');
    expect(snapshotReviewRepairSql).toContain('expires_at <= now()');
    expect(snapshotReviewRepairSql).toContain('project_ingest_snapshot_reviews_legacy_archive');
    expect(snapshotReviewRepairSql).not.toContain('reviewer_id AS operator_id');
  });

  it('restores the store readiness columns and named review constraints', () => {
    for (const column of [
      'snapshot_id',
      'snapshot_uuid',
      'project_id',
      'reviewer_id',
      'operator_id',
      'reviewer_capability',
      'evidence_id',
      'reason',
      'command_scope',
      'token_digest',
      'approved_at',
      'expires_at',
      'created_at',
    ]) {
      expect(snapshotReviewRepairSql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const constraint of [
      'project_ingest_snapshot_reviews_one_per_snapshot',
      'project_ingest_snapshot_reviews_token_digest_unique',
      'project_ingest_snapshot_reviews_operator_id_check',
      'project_ingest_snapshot_reviews_expiry_check',
      'project_ingest_snapshot_review_decisions_one_per_snapshot',
      'project_ingest_snapshot_review_decisions_operator_id_check',
    ]) {
      expect(snapshotReviewRepairSql).toContain(constraint);
    }
    expect(snapshotReviewRepairSql).toContain(
      'project_ingest_snapshot_reviews_legacy_archive_review_unique'
    );
    expect(snapshotReviewRepairSql).toContain(
      'project_ingest_snapshot_reviews_legacy_archive_immutable'
    );
    expect(snapshotReviewRepairSql).toContain(
      'project_ingest_snapshot_reviews_legacy_archive_truncate_immutable'
    );
  });
});

describe('Project RAG durable job lifecycle schema (012)', () => {
  it('adds explicit review, retry, dead-letter, and cancellation state', () => {
    expect(durableJobLifecycleSql).toContain('available_at timestamptz');
    expect(durableJobLifecycleSql).toContain('cancel_requested_at timestamptz');
    expect(durableJobLifecycleSql).toContain('blocked_at timestamptz');
    expect(durableJobLifecycleSql).toContain('dead_lettered_at timestamptz');
    expect(durableJobLifecycleSql).toContain("'blocked-review'");
    expect(durableJobLifecycleSql).toContain("'retry-wait'");
    expect(durableJobLifecycleSql).toContain("'dead-letter'");
    expect(durableJobLifecycleSql).toContain("'cancelled'");
  });

  it('rebuilds active-dedupe and recovery indexes for restart-safe claims', () => {
    expect(durableJobLifecycleSql).toContain('project_jobs_active_dedupe_idx');
    expect(durableJobLifecycleSql).toContain('project_jobs_recovery_idx');
    expect(durableJobLifecycleSql).toContain("status IN ('queued', 'retry-wait', 'running')");
    expect(durableJobLifecycleSql).toContain(
      "status IN ('queued', 'running', 'blocked-review', 'retry-wait')"
    );
  });
});

describe('Project RAG version-owned derived data schema (010)', () => {
  it('aborts on ambiguous ownership instead of deleting or guessing', () => {
    expect(versionOwnedDerivedDataSql).toContain('MIGRATION_AMBIGUOUS_OWNERSHIP');
    expect(versionOwnedDerivedDataSql).toContain('BEGIN;');
    expect(versionOwnedDerivedDataSql).toContain('COMMIT;');
    expect(versionOwnedDerivedDataSql).toContain(
      'refusing to migrate without deletion or guessing'
    );
  });

  it('binds chunks and symbols to exact project, file, and file-version parents', () => {
    expect(versionOwnedDerivedDataSql).toContain(
      'project_file_versions_id_file_project_unique UNIQUE (id, file_id, project_id)'
    );
    expect(versionOwnedDerivedDataSql).toContain('project_chunks_id_project_unique');
    expect(versionOwnedDerivedDataSql).toContain('project_chunks_id_version_project_unique');
    expect(versionOwnedDerivedDataSql).toContain('project_chunks_id_file_version_project_unique');
    expect(versionOwnedDerivedDataSql).toContain('project_symbols_id_project_unique');
    expect(versionOwnedDerivedDataSql).toContain('project_symbols_id_version_project_unique');
    expect(versionOwnedDerivedDataSql).toContain('project_symbols_id_file_version_project_unique');
    expect(versionOwnedDerivedDataSql).toContain('FOREIGN KEY (version_id, file_id, project_id)');
    expect(versionOwnedDerivedDataSql).toContain('project_chunks_version_file_project_fk');
    expect(versionOwnedDerivedDataSql).toContain('project_chunks_file_project_fk');
    expect(versionOwnedDerivedDataSql).toContain('project_symbols_version_file_project_fk');
    expect(versionOwnedDerivedDataSql).toContain('project_symbols_chunk_project_fk');
    expect(versionOwnedDerivedDataSql).toContain(
      'FOREIGN KEY (chunk_id, file_id, version_id, project_id)'
    );
    expect(versionOwnedDerivedDataSql).toContain('ON DELETE SET NULL (chunk_id)');
  });

  it('binds edge endpoints and embedding owners across the project boundary', () => {
    expect(versionOwnedDerivedDataSql).toContain('project_edges_source_file_project_fk');
    expect(versionOwnedDerivedDataSql).toContain('project_edges_target_file_project_fk');
    expect(versionOwnedDerivedDataSql).toContain(
      'FOREIGN KEY (source_version_id, source_file_id, project_id)'
    );
    expect(versionOwnedDerivedDataSql).toContain(
      'FOREIGN KEY (target_version_id, target_file_id, project_id)'
    );
    expect(versionOwnedDerivedDataSql).toContain('project_edges_source_symbol_project_fk');
    expect(versionOwnedDerivedDataSql).toContain('project_edges_target_symbol_project_fk');
    expect(versionOwnedDerivedDataSql).toContain(
      'project_embeddings_1024_chunk_version_project_fk'
    );
    expect(versionOwnedDerivedDataSql).toContain(
      'project_embeddings_1024_symbol_version_project_fk'
    );
    expect(versionOwnedDerivedDataSql).toContain(
      'FOREIGN KEY (chunk_id, file_id, version_id, project_id)'
    );
    expect(versionOwnedDerivedDataSql).toContain('ALTER COLUMN version_id SET NOT NULL');
  });

  it('completes composite build-file ownership with a file-exact version binding', () => {
    expect(versionOwnedDerivedDataSql).toContain(
      'project_index_build_files_version_file_project_fk'
    );
    expect(versionOwnedDerivedDataSql).toContain('ON DELETE RESTRICT');
  });

  it('enforces lifecycle transitions through existing status fields without graph_state', () => {
    expect(versionOwnedDerivedDataSql).not.toContain('ADD COLUMN IF NOT EXISTS graph_state');
    expect(versionOwnedDerivedDataSql).not.toContain('graph_state text');
    expect(versionOwnedDerivedDataSql).toContain('project_rag_version_lifecycle_transitions');
    expect(versionOwnedDerivedDataSql).toContain('invalid file version lifecycle transition');
    expect(versionOwnedDerivedDataSql).toContain(
      'lifecycle transition pending->ready requires ready_at'
    );
    expect(versionOwnedDerivedDataSql).toContain(
      'lifecycle transition ready->replaced requires replaced_at'
    );
    expect(versionOwnedDerivedDataSql).toContain(
      'lifecycle transition pending->failed requires failed_at and error_message'
    );
  });

  it('guards inserts and updates while leaving supported deletes flowing', () => {
    expect(versionOwnedDerivedDataSql).toContain('project_chunks_candidate_immutable_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_chunks_candidate_insert_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_symbols_immutable_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_edges_candidate_immutable_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_symbols_candidate_insert_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_edges_candidate_insert_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_embeddings_1024_binding_immutable_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_embeddings_1024_candidate_insert_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_rag_chunks_candidate_insert_guard');
    expect(versionOwnedDerivedDataSql).toContain('project_rag_embeddings_candidate_insert_guard');
    // Deletions stay open: no BEFORE DELETE guards may exist.
    expect(versionOwnedDerivedDataSql).not.toContain('BEFORE DELETE');
    // The promotion path must keep its supported disable mutation.
    expect(versionOwnedDerivedDataSql).toContain('NEW.enabled IS TRUE');
    expect(versionOwnedDerivedDataSql).toContain("'failed', 'replaced'");
    expect(versionOwnedDerivedDataSql).toContain('only pending candidates accept inserts');
    expect(versionOwnedDerivedDataSql).toContain('CANDIDATE_VERSION_BUILD_MEMBER');
    // Edge target resolution stays available.
    expect(versionOwnedDerivedDataSql).not.toContain('NEW.target_file_id IS DISTINCT FROM');
  });

  it('adds and deterministically backfills embedding profile identity without breaking the writer', () => {
    expect(versionOwnedDerivedDataSql).toContain(
      'ADD COLUMN IF NOT EXISTS embedding_profile_hash text'
    );
    expect(versionOwnedDerivedDataSql).toContain("coalesce(embedding_provider, 'llamacpp')");
    expect(versionOwnedDerivedDataSql).toContain('WHERE embedding_profile_hash IS NULL');
    expect(versionOwnedDerivedDataSql).toContain('project_embeddings_1024_profile_hash_idx');
  });

  it('replaces the legacy owner/model key with profile-owned identity', () => {
    expect(versionOwnedDerivedDataSql).toContain(
      'DROP CONSTRAINT IF EXISTS project_embeddings_1024_owner_unique'
    );
    expect(versionOwnedDerivedDataSql).toContain(
      'UNIQUE (project_id, owner_type, owner_ref, embedding_profile_hash)'
    );
    expect(coreSql).toContain(
      'project_embeddings_1024_owner_unique UNIQUE (\n    project_id, owner_type, owner_ref, embedding_model\n  )'
    );
    expect(coreSql).toContain(
      'project_chunks_file_version_chunk_unique UNIQUE (file_id, version_id, chunk_index)'
    );
  });
});

describe('Project RAG sync-run binding schema (009)', () => {
  it('adds nullable compatibility bindings with project-consistent foreign keys', () => {
    expect(syncRunBindingSql).toContain('ADD COLUMN IF NOT EXISTS snapshot_uuid uuid');
    expect(syncRunBindingSql).toContain('ADD COLUMN IF NOT EXISTS job_id bigint');
    expect(syncRunBindingSql).toContain('project_sync_runs_snapshot_project_fk');
    expect(syncRunBindingSql).toContain('FOREIGN KEY (snapshot_uuid, project_id)');
    expect(syncRunBindingSql).toContain('project_sync_runs_job_project_fk');
    expect(syncRunBindingSql).toContain('FOREIGN KEY (job_id, project_id)');
    expect(syncRunBindingSql).toContain('ON DELETE RESTRICT');
  });

  it('uniquely binds snapshots and freezes project, snapshot, and job identity', () => {
    expect(syncRunBindingSql).toContain('project_sync_runs_snapshot_binding_unique');
    expect(syncRunBindingSql).toContain('project_sync_runs_binding_idx');
    expect(syncRunBindingSql).toContain('project_sync_runs_freeze_binding_fields');
    expect(syncRunBindingSql).toContain(
      'binding field snapshot_uuid cannot be mutated after insert'
    );
    expect(syncRunBindingSql).toContain('binding field job_id cannot be mutated after insert');
    expect(syncRunBindingSql).toContain('BEGIN;');
    expect(syncRunBindingSql).toContain('COMMIT;');
  });
});

describe('Project RAG immutable index build schema (007)', () => {
  it('publishes one complete build and retains retired builds for deferred GC', () => {
    expect(indexBuildPublicationSql).toContain('CREATE TABLE IF NOT EXISTS project_index_builds');
    expect(indexBuildPublicationSql).toContain('project_index_builds_one_published');
    expect(indexBuildPublicationSql).toContain(
      'CREATE TABLE IF NOT EXISTS project_index_build_files'
    );
    expect(indexBuildPublicationSql).toContain(
      'project_index_builds_id_project_unique UNIQUE (id, project_id)'
    );
    expect(indexBuildPublicationSql).toContain(
      'project_files_id_project_unique UNIQUE (id, project_id)'
    );
    expect(indexBuildPublicationSql).toContain(
      'project_file_versions_id_project_unique UNIQUE (id, project_id)'
    );
    expect(indexBuildPublicationSql).toContain('project_index_build_files_build_project_fk');
    expect(indexBuildPublicationSql).toContain('FOREIGN KEY (build_id, project_id)');
    expect(indexBuildPublicationSql).toContain('project_index_build_files_file_project_fk');
    expect(indexBuildPublicationSql).toContain('FOREIGN KEY (file_id, project_id)');
    expect(indexBuildPublicationSql).toContain('project_index_build_files_version_project_fk');
    expect(indexBuildPublicationSql).toContain('FOREIGN KEY (version_id, project_id)');
    expect(indexBuildPublicationSql).toContain(
      "status IN ('building', 'published', 'failed', 'retired', 'garbage_collected')"
    );
    expect(indexBuildPublicationSql).toContain("status = 'published'");
  });
});

describe('Project RAG context identity schema (006)', () => {
  it('keeps repository, worktree, revision, and aliases additive to legacy datasets', () => {
    expect(contextIdentitySql).toContain('CREATE TABLE IF NOT EXISTS project_rag_repositories');
    expect(contextIdentitySql).toContain('git_common_dir text NOT NULL UNIQUE');
    expect(contextIdentitySql).toContain('CREATE TABLE IF NOT EXISTS project_rag_workspaces');
    expect(contextIdentitySql).toContain('canonical_root_path text NOT NULL UNIQUE');
    expect(contextIdentitySql).toContain('CREATE TABLE IF NOT EXISTS project_rag_revisions');
    expect(contextIdentitySql).toContain('head_oid text');
    expect(contextIdentitySql).toContain('branch_name text');
    expect(contextIdentitySql).toContain('dirty_digest text NOT NULL');
    expect(contextIdentitySql).toContain(
      'CREATE TABLE IF NOT EXISTS project_rag_workspace_aliases'
    );
    expect(contextIdentitySql).toContain(
      'legacy_project_id bigint UNIQUE REFERENCES project_repositories'
    );
  });

  it('does not backfill aliases from legacy slugs or basenames', () => {
    expect(contextIdentitySql).not.toMatch(
      /insert\s+into\s+project_rag_workspace_aliases[\s\S]*select/i
    );
  });
});

describe('Project RAG chunk uniqueness schema', () => {
  it('allows active and pending versions to own the same chunk index', () => {
    expect(coreSql).toContain(
      'project_chunks_file_version_chunk_unique UNIQUE (file_id, version_id, chunk_index)'
    );
    expect(coreSql).not.toContain('UNIQUE (file_id, chunk_index)');
  });

  it('migrates existing databases transactionally', () => {
    expect(versionedChunkMigration).toContain('BEGIN;');
    expect(versionedChunkMigration).toContain(
      'DROP CONSTRAINT IF EXISTS project_chunks_file_chunk_unique'
    );
    expect(versionedChunkMigration).toContain('UNIQUE (file_id, version_id, chunk_index)');
    expect(versionedChunkMigration).toContain(
      'chunks.version_id IS DISTINCT FROM files.active_version_id'
    );
    expect(versionedChunkMigration).toContain('COMMIT;');
  });
});

describe('Project RAG ingest snapshot gate schema (003)', () => {
  it('defines the project_ingest_snapshots table', () => {
    expect(snapshotGateSql).toContain('CREATE TABLE project_ingest_snapshots');
  });

  it('renames server_uuid to snapshot_uuid with UNIQUE constraint', () => {
    expect(snapshotGateSql).toContain('snapshot_uuid   uuid NOT NULL DEFAULT gen_random_uuid()');
    expect(snapshotGateSql).toContain(
      'project_ingest_snapshots_snapshot_uuid_unique UNIQUE (snapshot_uuid)'
    );
  });

  it('documents that snapshot_uuid index is implicit from UNIQUE constraint', () => {
    // The UNIQUE constraint on snapshot_uuid already creates a btree index.
    // An explicit index would be redundant — the SQL documents this.
    expect(snapshotGateSql).toContain('implicit btree index from the UNIQUE constraint');
  });

  it('includes a PREPARED default status', () => {
    expect(snapshotGateSql).toContain("status IN ('PREPARED', 'REVIEW_REQUIRED', 'CONSUMING'");
    expect(snapshotGateSql).toContain("DEFAULT 'PREPARED'");
  });

  it('defines all six status values', () => {
    expect(snapshotGateSql).toContain("'PREPARED'");
    expect(snapshotGateSql).toContain("'REVIEW_REQUIRED'");
    expect(snapshotGateSql).toContain("'CONSUMING'");
    expect(snapshotGateSql).toContain("'CONSUMED'");
    expect(snapshotGateSql).toContain("'FAILED'");
    expect(snapshotGateSql).toContain("'EXPIRED'");
  });

  it('has fail_requires_code constraint (FAILED rows must have failure_code)', () => {
    expect(snapshotGateSql).toContain(
      'CONSTRAINT project_ingest_snapshots_fail_requires_code CHECK'
    );
    expect(snapshotGateSql).toContain("status <> 'FAILED' OR failure_code IS NOT NULL");
  });

  it('includes binding hashes for root, scope, policy, inventory, baseline, plan', () => {
    expect(snapshotGateSql).toContain('root_hash');
    expect(snapshotGateSql).toContain('scope_hash');
    expect(snapshotGateSql).toContain('policy_hash');
    expect(snapshotGateSql).toContain('inventory_hash');
    expect(snapshotGateSql).toContain('baseline_hash');
    expect(snapshotGateSql).toContain('plan_hash');
  });

  it('tracks adds, updates, deletes, eligible, and tracked counts', () => {
    expect(snapshotGateSql).toContain('adds_count');
    expect(snapshotGateSql).toContain('updates_count');
    expect(snapshotGateSql).toContain('deletes_count');
    expect(snapshotGateSql).toContain('eligible_count');
    expect(snapshotGateSql).toContain('tracked_count');
  });

  it('has a TTL check constraint (30s–86400s)', () => {
    expect(snapshotGateSql).toContain('ttl_seconds >= 30 AND ttl_seconds <= 86400');
  });

  it('has lease_expires_at column', () => {
    expect(snapshotGateSql).toContain('lease_expires_at');
  });

  it('has lease_expiry index for CONSUMING status', () => {
    expect(snapshotGateSql).toContain('project_ingest_snapshots_lease_expiry_idx');
    expect(snapshotGateSql).toContain("WHERE status = 'CONSUMING'");
  });

  it('prevents mutation of binding fields via a static freeze trigger', () => {
    expect(snapshotGateSql).toContain('project_rag_ingest_snapshot_freeze_binding_fields');
    // Must use static IF checks, not dynamic EXECUTE
    expect(snapshotGateSql).not.toContain('EXECUTE format');
    expect(snapshotGateSql).not.toContain('FOREACH');
    // Each frozen field gets a named IF check
    expect(snapshotGateSql).toContain('RAISE EXCEPTION');
    expect(snapshotGateSql).toContain("'binding field id cannot be mutated after insert'");
    expect(snapshotGateSql).toContain(
      "'binding field snapshot_uuid cannot be mutated after insert'"
    );
    // created_at and expires_at are also frozen
    expect(snapshotGateSql).toContain("'audit field created_at cannot be mutated after insert'");
    expect(snapshotGateSql).toContain("'audit field expires_at cannot be mutated after insert'");
  });

  it('enforces at most one CONSUMING snapshot per project', () => {
    expect(snapshotGateSql).toContain('project_ingest_snapshots_one_consuming_idx');
    expect(snapshotGateSql).toContain("WHERE status = 'CONSUMING'");
  });

  it('has expiry, lease-expiry, and project-status indexes', () => {
    expect(snapshotGateSql).toContain('project_ingest_snapshots_expiry_idx');
    expect(snapshotGateSql).toContain('project_ingest_snapshots_lease_expiry_idx');
    expect(snapshotGateSql).toContain('project_ingest_snapshots_project_status_idx');
  });

  it('defines the touch_updated_at trigger', () => {
    expect(snapshotGateSql).toContain('project_ingest_snapshots_touch_updated_at');
    expect(snapshotGateSql).toContain('project_rag_touch_updated_at');
  });

  it('includes snapshot_uuid with gen_random_uuid default (not server_uuid)', () => {
    expect(snapshotGateSql).toContain('snapshot_uuid');
    expect(snapshotGateSql).toContain('gen_random_uuid()');
    expect(snapshotGateSql).not.toContain('server_uuid');
  });

  it('uses transaction wrapping with COMMIT', () => {
    expect(snapshotGateSql).toContain('BEGIN;');
    expect(snapshotGateSql).toContain('COMMIT;');
  });
});

describe('Project RAG blocked-finding allowlist schema (004)', () => {
  it('uses transaction wrapping with COMMIT', () => {
    expect(allowlistSql).toContain('BEGIN;');
    expect(allowlistSql).toContain('COMMIT;');
  });

  it('adds blocked_finding_allowlist to project_repositories as jsonb array', () => {
    expect(allowlistSql).toContain('ALTER TABLE project_repositories');
    expect(allowlistSql).toContain('ADD COLUMN IF NOT EXISTS blocked_finding_allowlist');
    expect(allowlistSql).toContain('jsonb NOT NULL DEFAULT');
    expect(allowlistSql).toContain('jsonb_typeof(blocked_finding_allowlist)');
  });

  it('constrains allowlist array length <= 32', () => {
    expect(allowlistSql).toContain('project_repositories_blocked_finding_allowlist_max_length');
    expect(allowlistSql).toContain('jsonb_array_length(blocked_finding_allowlist) <= 32');
  });

  it('adds blocked_finding_allowlist_hash to project_ingest_snapshots', () => {
    expect(allowlistSql).toContain('ADD COLUMN IF NOT EXISTS blocked_finding_allowlist_hash');
    expect(allowlistSql).toContain('text NOT NULL');
    // Default is SHA-256 of empty string
    expect(allowlistSql).toContain(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('adds suppressed_blocked_findings to project_ingest_snapshots', () => {
    expect(allowlistSql).toContain('ADD COLUMN IF NOT EXISTS suppressed_blocked_findings');
    expect(allowlistSql).toContain('jsonb NOT NULL DEFAULT');
    expect(allowlistSql).toContain('jsonb_typeof(suppressed_blocked_findings)');
    expect(allowlistSql).toContain('jsonb_array_length(suppressed_blocked_findings) <= 32');
  });

  it('updates freeze trigger function to protect new binding fields', () => {
    expect(allowlistSql).toContain(
      'CREATE OR REPLACE FUNCTION project_rag_ingest_snapshot_freeze_binding_fields'
    );
    expect(allowlistSql).toContain(
      'binding field blocked_finding_allowlist_hash cannot be mutated after insert'
    );
    expect(allowlistSql).toContain(
      'binding field suppressed_blocked_findings cannot be mutated after insert'
    );
  });

  it('preserves all original freeze checks from migration 003', () => {
    expect(allowlistSql).toContain('binding field id cannot be mutated after insert');
    expect(allowlistSql).toContain('binding field inventory_hash cannot be mutated after insert');
    expect(allowlistSql).toContain('audit field created_at cannot be mutated after insert');
    expect(allowlistSql).toContain('binding field ttl_seconds cannot be mutated after insert');
  });

  it('does not use dynamic EXECUTE or FOREACH in freeze trigger', () => {
    expect(allowlistSql).not.toContain('EXECUTE format');
    expect(allowlistSql).not.toContain('FOREACH');
  });

  it('defines project_repositories_blocked_finding_allowlist_is_array CHECK constraint', () => {
    expect(allowlistSql).toContain('project_repositories_blocked_finding_allowlist_is_array');
    expect(allowlistSql).toContain("jsonb_typeof(blocked_finding_allowlist) = 'array'");
  });

  it('defines project_repositories_blocked_finding_allowlist_max_length CHECK constraint', () => {
    expect(allowlistSql).toContain('project_repositories_blocked_finding_allowlist_max_length');
    expect(allowlistSql).toContain('jsonb_array_length(blocked_finding_allowlist) <= 32');
  });

  it('defines project_ingest_snapshots_suppressed_blocked_findings_is_array CHECK constraint', () => {
    expect(allowlistSql).toContain('project_ingest_snapshots_suppressed_blocked_findings_is_array');
    expect(allowlistSql).toContain("jsonb_typeof(suppressed_blocked_findings) = 'array'");
  });

  it('defines project_ingest_snapshots_suppressed_blocked_findings_max_length CHECK constraint', () => {
    expect(allowlistSql).toContain(
      'project_ingest_snapshots_suppressed_blocked_findings_max_length'
    );
    expect(allowlistSql).toContain('jsonb_array_length(suppressed_blocked_findings) <= 32');
  });

  it('creates the project_rag_repo_block_config_during_consuming function', () => {
    expect(allowlistSql).toContain(
      'CREATE OR REPLACE FUNCTION project_rag_repo_block_config_during_consuming'
    );
    expect(allowlistSql).toContain('include_roots');
    expect(allowlistSql).toContain('ignore_rules');
    expect(allowlistSql).toContain('blocked_finding_allowlist');
    expect(allowlistSql).toContain("status = 'CONSUMING'");
  });

  it('creates the project_repositories_block_config_during_consuming trigger idempotently', () => {
    expect(allowlistSql).toContain(
      'DROP TRIGGER IF EXISTS project_repositories_block_config_during_consuming'
    );
    expect(allowlistSql).toContain(
      'CREATE TRIGGER project_repositories_block_config_during_consuming'
    );
    expect(allowlistSql).toContain('BEFORE UPDATE ON project_repositories');
    expect(allowlistSql).toContain('project_rag_repo_block_config_during_consuming');
  });

  it('policy-race trigger rejects include_roots, ignore_rules, and blocked_finding_allowlist', () => {
    expect(allowlistSql).toContain(
      'cannot modify include_roots, ignore_rules, or blocked_finding_allowlist'
    );
    expect(allowlistSql).toContain('while a CONSUMING ingest snapshot exists');
  });

  it('does not use dynamic EXECUTE or FOREACH in repo block trigger function', () => {
    expect(allowlistSql).not.toContain('EXECUTE format');
    expect(allowlistSql).not.toContain('FOREACH');
  });
});

describe('Project RAG snapshot review schema (005)', () => {
  it('defines a transactional, single-use review table', () => {
    expect(snapshotReviewSql).toContain('BEGIN;');
    expect(snapshotReviewSql).toContain(
      'CREATE TABLE IF NOT EXISTS project_ingest_snapshot_reviews'
    );
    expect(snapshotReviewSql).toContain('project_ingest_snapshot_reviews_one_per_snapshot');
    expect(snapshotReviewSql).toContain('project_ingest_snapshot_reviews_token_digest_unique');
    expect(snapshotReviewSql).toContain('COMMIT;');
  });

  it('binds reviews to the snapshot and qualified capability', () => {
    expect(snapshotReviewSql).toContain('REFERENCES project_ingest_snapshots(id)');
    expect(snapshotReviewSql).toContain('REFERENCES project_ingest_snapshots(snapshot_uuid)');
    expect(snapshotReviewSql).toContain("reviewer_capability = 'high-trust-write'");
    expect(snapshotReviewSql).toContain('token_digest');
    expect(snapshotReviewSql).toContain('expires_at > approved_at');
    expect(snapshotReviewSql).toContain('operator_id');
  });

  it('records immutable operator defer and reject decisions', () => {
    expect(snapshotReviewSql).toContain(
      'CREATE TABLE IF NOT EXISTS project_ingest_snapshot_review_decisions'
    );
    expect(snapshotReviewSql).toContain("decision IN ('REJECTED', 'DEFERRED')");
    expect(snapshotReviewSql).toContain(
      'project_ingest_snapshot_review_decisions_one_per_snapshot'
    );
    expect(snapshotReviewSql).toContain(
      'BEFORE UPDATE ON project_ingest_snapshot_review_decisions'
    );
    expect(snapshotReviewSql).toContain("'REVIEW_REJECTED'");
  });

  it('makes audit records immutable and never stores the signed token', () => {
    expect(snapshotReviewSql).toContain('project_rag_snapshot_review_immutable');
    expect(snapshotReviewSql).toContain('BEFORE UPDATE ON project_ingest_snapshot_reviews');
    expect(snapshotReviewSql).not.toContain('review_token');
    expect(snapshotReviewSql).not.toContain('signing_key');
  });
});

describe('Project RAG scope, identity, and scan completeness schema (011)', () => {
  it('is a transactional additive migration for T-06 identity bindings', () => {
    expect(scopeIdentityCompletenessSql).toContain('BEGIN;');
    expect(scopeIdentityCompletenessSql).toContain('COMMIT;');
    expect(scopeIdentityCompletenessSql).toContain('ADD COLUMN IF NOT EXISTS repository_hash text');
    expect(scopeIdentityCompletenessSql).toContain(
      'ADD COLUMN IF NOT EXISTS worktree_git_dir text'
    );
    expect(scopeIdentityCompletenessSql).toContain('ADD COLUMN IF NOT EXISTS workspace_hash text');
    for (const column of [
      'is_unborn',
      'head_hash',
      'branch_hash',
      'detached_hash',
      'content_hash',
      'status_digest',
      'content_fingerprint',
      'identity_digest',
    ]) {
      expect(scopeIdentityCompletenessSql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });

  it('binds snapshot identity, profile, manifest, and completeness evidence', () => {
    for (const column of [
      'repository_hash',
      'workspace_hash',
      'head_hash',
      'branch_hash',
      'detached_hash',
      'content_hash',
      'index_profile_hash',
      'root_manifest_hash',
      'completeness_status',
      'completeness_evidence_hash',
      'deletion_allowed',
    ]) {
      expect(scopeIdentityCompletenessSql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(scopeIdentityCompletenessSql).toContain(
      "CHECK (completeness_status IS NULL OR completeness_status IN ('complete', 'incomplete', 'blocked'))"
    );
    expect(scopeIdentityCompletenessSql).toContain(
      'project_ingest_snapshots_deletion_requires_complete'
    );
    expect(scopeIdentityCompletenessSql).toContain(
      'project_ingest_snapshots_completeness_requires_evidence'
    );
  });

  it('extends the existing snapshot freeze trigger to every new binding field', () => {
    expect(scopeIdentityCompletenessSql).toContain(
      'CREATE OR REPLACE FUNCTION project_rag_ingest_snapshot_freeze_binding_fields'
    );
    for (const column of [
      'repository_hash',
      'workspace_hash',
      'head_hash',
      'branch_hash',
      'detached_hash',
      'content_hash',
      'index_profile_hash',
      'root_manifest_hash',
      'completeness_status',
      'completeness_evidence_hash',
      'deletion_allowed',
    ]) {
      expect(scopeIdentityCompletenessSql).toContain(
        `NEW.${column} IS DISTINCT FROM OLD.${column}`
      );
    }
  });

  it('preserves migration 004 allowlist freeze guards when replacing the trigger', () => {
    expect(scopeIdentityCompletenessSql).toContain(
      'binding field blocked_finding_allowlist_hash cannot be mutated after insert'
    );
    expect(scopeIdentityCompletenessSql).toContain(
      'binding field suppressed_blocked_findings cannot be mutated after insert'
    );
  });
});
