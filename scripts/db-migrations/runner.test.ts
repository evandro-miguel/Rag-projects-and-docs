/**
 * Unit tests for the fixed-manifest schema migration runner.
 *
 * All database interaction goes through a scripted fake executor; no real
 * Postgres connection is opened here. Real-database behavior (fresh install,
 * upgrades, adoption, drift, contention) is proven separately in
 * runner.postgres.integration.test.ts against an isolated disposable instance.
 */
import { accessSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adaptReservedSql,
  assertMutationGates,
  boundText,
  buildAdoptionChallenge,
  classifyLane,
  DEFAULT_REPO_ROOT,
  DOCS_MIGRATIONS,
  DOCS_PUBLICATION_VALIDATOR_METADATA,
  describeError,
  LANE_URL_ENV,
  type LedgerIssue,
  type LedgerRow,
  type LoadedMigration,
  loadManifest,
  MIGRATION_PROBES,
  type MigrationLane,
  MigrationRunnerError,
  manifestForLane,
  OFFICIAL_DATABASE_NAMES,
  OFFICIAL_DATABASE_PORTS,
  OFFICIAL_DEFAULT_URLS,
  PROJECT_MIGRATIONS,
  probeLane,
  proofDigestFor,
  type Row,
  readLedger,
  redactDetails,
  redactPostgresUrl,
  resolveLaneDatabaseUrl,
  runAdopt,
  runApply,
  runStatus,
  type SqlExecutor,
  sha256Text,
  validateLedger,
} from './runner.js';

/* -------------------------------------------------------------------------- */
/* Fake executor                                                              */
/* -------------------------------------------------------------------------- */

function missingRelation(): Error {
  return Object.assign(new Error('relation "public.rag_schema_migrations" does not exist'), {
    errno: '42P01',
  });
}

interface FakeDbOptions {
  ledgerRows?: readonly LedgerRow[];
  /** Absent ledger table until a mutation creates it. */
  ledgerMissing?: boolean;
  footprintPresent?: boolean;
  lockAvailable?: boolean;
  /** One artifact-result row per probe query; consumed in order, the last repeats. */
  probeResponses?: boolean[][];
  failScript?: (sqlText: string) => boolean;
  failLedgerInsert?: boolean;
  /** Fail ledger inserts at ordinals >= this value (mid-prefix fault injection). */
  failLedgerInsertFromOrdinal?: number;
  /** Make advisory unlock cleanup fail to prove original-error preservation. */
  failUnlock?: boolean;
  /** Make transaction rollback cleanup fail to prove original-error preservation. */
  failRollback?: boolean;
}

class FakeDb implements SqlExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly appliedScripts: string[] = [];
  readonly ledgerInserts: Array<readonly unknown[] | undefined> = [];
  unlockCount = 0;
  beginCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  private probeCursor = 0;
  private ledgerMissing: boolean;
  private ledgerRows: LedgerRow[];
  private footprintPresent: boolean;
  private opts: FakeDbOptions;
  /** Ledger-row count snapshot captured at BEGIN; restored on ROLLBACK. */
  private txSnapshot: number | null = null;

  constructor(opts: FakeDbOptions = {}) {
    this.opts = opts;
    this.ledgerMissing = opts.ledgerMissing === true;
    this.ledgerRows = [...(opts.ledgerRows ?? [])];
    this.footprintPresent = opts.footprintPresent === true;
  }

  get lockAttempts(): number {
    return this.calls.filter((c) => c.text.includes('pg_try_advisory_lock')).length;
  }

  async unsafe(text: string, values?: readonly unknown[]): Promise<Row[]> {
    this.calls.push({ text, values });
    const normalized = text.trim().toLowerCase();

    if (normalized.startsWith('select 1 as ready')) {
      return [{ ready: 1 }];
    }
    if (normalized === 'begin') {
      this.beginCount += 1;
      this.txSnapshot = this.ledgerRows.length;
      return [];
    }
    if (normalized === 'commit') {
      this.commitCount += 1;
      this.txSnapshot = null;
      return [];
    }
    if (normalized === 'rollback') {
      this.rollbackCount += 1;
      if (this.opts.failRollback) {
        throw new Error('rollback refused');
      }
      if (this.txSnapshot !== null) {
        this.ledgerRows.length = this.txSnapshot;
        this.txSnapshot = null;
      }
      return [];
    }
    if (text.includes('pg_try_advisory_lock')) {
      return [{ locked: this.opts.lockAvailable !== false }];
    }
    if (text.includes('pg_advisory_unlock')) {
      this.unlockCount += 1;
      if (this.opts.failUnlock) {
        throw new Error('advisory unlock refused');
      }
      return [{ unlocked: true }];
    }
    if (text.includes('to_regclass($1::text)')) {
      return [{ present: this.footprintPresent }];
    }
    if (text.includes(' as a0')) {
      const artifactCount = (text.match(/\bas a\d+\b/g) ?? []).length;
      return [this.probeRow(artifactCount)];
    }
    if (normalized.startsWith('create table if not exists public.rag_schema_migrations')) {
      this.ledgerMissing = false;
      return [];
    }
    if (text.includes('from public.rag_schema_migrations where lane')) {
      if (this.ledgerMissing) {
        throw missingRelation();
      }
      return this.ledgerRows.map(rowToSqlRow);
    }
    if (normalized.startsWith('insert into public.rag_schema_migrations')) {
      const ordinalValue = Number(values?.[1] ?? Number.NaN);
      if (
        this.opts.failLedgerInsert ||
        (this.opts.failLedgerInsertFromOrdinal !== undefined &&
          Number.isFinite(ordinalValue) &&
          ordinalValue >= this.opts.failLedgerInsertFromOrdinal)
      ) {
        throw new Error('ledger insert refused');
      }
      this.ledgerInserts.push(values);
      if (values?.length !== 6) {
        throw new Error('invalid simulated ledger insert');
      }
      const [lane, ordinal, name, checksumSha256, recordKind, proofDigest] = values;
      this.ledgerRows.push({
        lane: lane as MigrationLane,
        ordinal: Number(ordinal),
        name: String(name),
        checksumSha256: String(checksumSha256),
        recordKind: recordKind as LedgerRow['recordKind'],
        proofDigest: String(proofDigest),
      });
      return [];
    }

    // Raw historical script execution (simple query protocol, no binds).
    if (this.opts.failScript?.(text)) {
      throw new Error(`script failed: ${text.slice(0, 40)}`);
    }
    this.appliedScripts.push(text);
    // Applying real scripts creates the lane footprint, like migration 001.
    this.footprintPresent = true;
    return [];
  }

  private probeRow(artifactCount: number): Row {
    const plan = this.opts.probeResponses;
    let result: boolean[];
    if (!plan || plan.length === 0) {
      result = new Array<boolean>(artifactCount).fill(true);
    } else {
      const index = Math.min(this.probeCursor, plan.length - 1);
      result = plan[index];
      this.probeCursor += 1;
    }
    const row: Row = {};
    result.slice(0, artifactCount).forEach((present, i) => {
      row[`a${i}`] = present;
    });
    return row;
  }
}

function rowToSqlRow(row: LedgerRow): Row {
  return {
    ordinal: row.ordinal,
    name: row.name,
    checksum_sha256: row.checksumSha256,
    record_kind: row.recordKind,
    proof_digest: row.proofDigest,
  };
}

/* -------------------------------------------------------------------------- */
/* Manifest helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Synthetic two-item manifest used by most executor-driven tests. */
function tinyManifest(): LoadedMigration[] {
  const item = (ordinal: number, name: string): LoadedMigration => ({
    descriptor: { lane: 'docs', ordinal, name, relativePath: `fixture/${name}.sql` },
    checksumSha256: sha256Text(`${name}:checksum`),
    sqlText: `-- ${name} fixture script\nselect ${ordinal};`,
  });
  return [item(1, 'one'), item(2, 'two')];
}

function projectManifest(): LoadedMigration[] {
  return PROJECT_MIGRATIONS.map((descriptor) => ({
    descriptor,
    checksumSha256: sha256Text(`${descriptor.name}:checksum`),
    sqlText: `-- ${descriptor.name} fixture script\nselect ${descriptor.ordinal};`,
  }));
}

function projectProbeResponses(missingArtifactId?: string): boolean[][] {
  let prefixBroken = false;
  return MIGRATION_PROBES.project.map((probe) => {
    const containsMissing = probe.artifacts.some((artifact) => artifact.id === missingArtifactId);
    prefixBroken ||= containsMissing;
    return probe.artifacts.map((artifact) => !prefixBroken && artifact.id !== missingArtifactId);
  });
}

function validRows(manifest: readonly LoadedMigration[], through: number): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (let ordinal = 1; ordinal <= through; ordinal += 1) {
    const item = manifest[ordinal - 1];
    out.push({
      lane: item.descriptor.lane,
      ordinal,
      name: item.descriptor.name,
      checksumSha256: item.checksumSha256,
      recordKind: 'executed',
      proofDigest: proofDigestFor({
        kind: 'executed',
        lane: item.descriptor.lane,
        ordinal,
        name: item.descriptor.name,
        checksum: item.checksumSha256,
      }),
    });
  }
  return out;
}

function expectRunnerError(
  promise: Promise<unknown>,
  code: MigrationRunnerError['code']
): Promise<unknown> {
  return expect(promise).rejects.toMatchObject({ code });
}

const TEST_TARGET_FINGERPRINT = sha256Text('test-disposable-target');

/* -------------------------------------------------------------------------- */
/* Fixed manifests                                                            */
/* -------------------------------------------------------------------------- */

describe('fixed migration catalogs', () => {
  const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

  it('pins the project lane to exactly migrations 001..013', () => {
    expect(PROJECT_MIGRATIONS.map((m) => m.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(PROJECT_MIGRATIONS[0].relativePath).toBe('infra/project-rag/sql/001-core.sql');
    expect(PROJECT_MIGRATIONS[7]?.relativePath).toBe('infra/project-rag/sql/008-durable-jobs.sql');
    expect(PROJECT_MIGRATIONS[8]?.relativePath).toBe(
      'infra/project-rag/sql/009-sync-run-binding.sql'
    );
    expect(PROJECT_MIGRATIONS[9]?.relativePath).toBe(
      'infra/project-rag/sql/010-version-owned-derived-data.sql'
    );
    expect(PROJECT_MIGRATIONS[10]?.relativePath).toBe(
      'infra/project-rag/sql/011-scope-identity-completeness.sql'
    );
    expect(PROJECT_MIGRATIONS[11]?.relativePath).toBe(
      'infra/project-rag/sql/012-durable-job-lifecycle.sql'
    );
    expect(PROJECT_MIGRATIONS[12]?.relativePath).toBe(
      'infra/project-rag/sql/013-snapshot-review-repair.sql'
    );
    expect(manifestForLane('project')).toBe(PROJECT_MIGRATIONS);
  });

  it('pins the docs lane to exactly migrations 001..005', () => {
    expect(DOCS_MIGRATIONS.map((m) => m.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(DOCS_MIGRATIONS[1].relativePath).toBe('infra/docs-rag/sql/002-eval.sql');
    expect(DOCS_MIGRATIONS[2].relativePath).toBe(
      'infra/docs-rag/sql/003-processing-provenance.sql'
    );
    expect(DOCS_MIGRATIONS[3].relativePath).toBe('infra/docs-rag/sql/004-source-generations.sql');
    expect(DOCS_MIGRATIONS[4].relativePath).toBe(
      'infra/docs-rag/sql/005-generation-publication-integrity.sql'
    );
    expect(manifestForLane('docs')).toBe(DOCS_MIGRATIONS);
  });

  it('keeps migration 005 adoption evidence bound to publication integrity', () => {
    const probe = MIGRATION_PROBES.docs.find((candidate) => candidate.ordinal === 5);
    expect(probe?.artifacts.map((artifact) => artifact.id)).toEqual([
      'column_generation_provenance_class',
      'constraint_generation_provenance_class',
      'table_legacy_generation_exemptions',
      'func_legacy_generation_exemption_seal',
      'trigger_legacy_generation_exemptions_sealed',
      'trigger_legacy_generation_exemptions_truncate_sealed',
      'func_generation_publication_prosrc_digest',
      'func_generation_publication_count_invalid',
      'func_generation_publication_document_invalid',
      'func_generation_publication_chunk_invalid',
      'func_generation_publication_embedding_invalid',
      'func_generation_publication_revision_bound_external',
      'func_generation_publication_processed_external_import',
    ]);
    expect(DOCS_PUBLICATION_VALIDATOR_METADATA).toMatchObject({
      functionName: 'docs_rag_assert_generation_publishable',
      identityArguments: 'bigint,text',
    });
    expect(DOCS_PUBLICATION_VALIDATOR_METADATA.prosrcSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ships the four redacted publication-integrity failure codes', async () => {
    const migration = (await loadManifest(REPO_ROOT, 'docs'))[4];
    expect(migration?.sqlText).toContain('docs_rag_legacy_generation_exemptions');
    expect(migration?.sqlText).not.toContain('COMMENT ON FUNCTION');
    expect(migration?.sqlText).toContain("MESSAGE = 'COUNT_INVALID'");
    expect(migration?.sqlText).toContain("MESSAGE = 'DOCUMENT_INVALID'");
    expect(migration?.sqlText).toContain("MESSAGE = 'CHUNK_INVALID'");
    expect(migration?.sqlText).toContain("MESSAGE = 'EMBEDDING_INVALID'");
  });

  it('pins the publication validator prosrc digest in runner metadata', async () => {
    const db = new FakeDb({ footprintPresent: true });
    await probeLane(db, 'docs', 5);
    const probeSql = db.calls.find((call) => call.text.includes('p.prosrc'))?.text;
    expect(probeSql).toContain(DOCS_PUBLICATION_VALIDATOR_METADATA.prosrcSha256);
    expect(probeSql).toContain('sha256(convert_to(p.prosrc');
    expect(probeSql).not.toContain('pg_description');
  });

  it('keeps migration 004 adoption evidence bound to source-generation publication artifacts', () => {
    const probe = MIGRATION_PROBES.docs.find((candidate) => candidate.ordinal === 4);
    expect(probe?.artifacts.map((artifact) => artifact.id)).toEqual([
      'table_docs_source_generations',
      'table_docs_source_generation_pointers',
      'column_documents_generation_id',
      'constraint_generations_identity_unique',
      'constraint_generations_scan_state',
      'constraint_generations_status',
      'constraint_generations_expected_count',
      'constraint_generations_indexed_count',
      'constraint_documents_generation_fk',
      'index_documents_generation_identity',
      'index_documents_legacy_identity',
      'index_documents_generation_id',
      'index_generations_source_status',
      'index_pointers_generation_id',
      'func_touch_source_generation_updated_at',
      'trigger_generations_touch_updated_at',
      'func_reject_published_generation_mutation',
      'trigger_generations_reject_published_update',
      'func_reject_published_document_mutation',
      'trigger_documents_reject_published_generation_update',
      'func_reject_published_derived_mutation',
      'trigger_chunks_reject_published_generation_mutation',
      'func_reject_published_embedding_mutation',
      'trigger_embeddings_reject_published_generation_mutation',
    ]);
  });

  it('references existing historical SQL files', () => {
    for (const descriptor of [...PROJECT_MIGRATIONS, ...DOCS_MIGRATIONS]) {
      expect(() => accessSync(join(REPO_ROOT, descriptor.relativePath))).not.toThrow();
    }
  });

  it('keeps migration 009 adoption evidence bound to sync-run identity artifacts', () => {
    const probe = MIGRATION_PROBES.project.find((candidate) => candidate.ordinal === 9);
    expect(probe?.artifacts.map((artifact) => artifact.id)).toEqual([
      'column_sync_snapshot_uuid',
      'column_sync_job_id',
      'constraint_sync_snapshot_project_fk',
      'constraint_sync_job_project_fk',
      'index_sync_snapshot_binding_unique',
      'index_sync_binding_lookup',
      'trigger_sync_binding_immutable',
    ]);
  });

  it('keeps migration 010 adoption evidence bound to version-owned derived data artifacts', () => {
    const probe = MIGRATION_PROBES.project.find((candidate) => candidate.ordinal === 10);
    expect(probe?.artifacts.map((artifact) => artifact.id)).toEqual([
      'constraint_chunks_id_project_unique',
      'constraint_chunks_id_version_project_unique',
      'constraint_chunks_id_file_version_project_unique',
      'constraint_symbols_id_project_unique',
      'constraint_symbols_id_version_project_unique',
      'constraint_symbols_id_file_version_project_unique',
      'constraint_edges_id_project_unique',
      'constraint_embeddings_id_project_unique',
      'constraint_versions_id_file_project_unique',
      'fk_chunks_version_file_project',
      'fk_symbols_chunk_project',
      'fk_edges_target_symbol_project',
      'fk_embeddings_file_version_project',
      'fk_embeddings_chunk_version_project',
      'fk_embeddings_symbol_version_project',
      'fk_build_files_version_file_project',
      'column_embeddings_profile_hash',
      'column_embeddings_profile_hash_not_null',
      'constraint_embeddings_profile_owner_unique',
      'constraint_embeddings_legacy_owner_unique_absent',
      'index_embeddings_profile_hash',
      'trigger_chunks_candidate_immutable_guard',
      'trigger_symbols_immutable_guard',
      'trigger_symbols_candidate_insert_guard',
      'trigger_edges_candidate_immutable_guard',
      'trigger_edges_candidate_insert_guard',
      'trigger_embeddings_binding_immutable_guard',
      'trigger_versions_lifecycle_transitions',
    ]);
  });

  it('keeps migration 011 adoption evidence bound to scope, identity, and scan-completeness artifacts', () => {
    const probe = MIGRATION_PROBES.project.find((candidate) => candidate.ordinal === 11);
    expect(probe?.artifacts.map((artifact) => artifact.id)).toEqual([
      'column_repository_hash',
      'column_workspace_worktree_git_dir',
      'column_workspace_hash',
      'column_revision_is_unborn',
      'column_revision_head_hash',
      'column_revision_branch_hash',
      'column_revision_detached_hash',
      'column_revision_content_hash',
      'column_revision_status_digest',
      'column_revision_content_fingerprint',
      'column_revision_identity_digest',
      'column_snapshot_repository_hash',
      'column_snapshot_workspace_hash',
      'column_snapshot_head_hash',
      'column_snapshot_branch_hash',
      'column_snapshot_detached_hash',
      'column_snapshot_content_hash',
      'column_snapshot_index_profile_hash',
      'column_snapshot_root_manifest_hash',
      'column_snapshot_completeness_status',
      'column_snapshot_completeness_evidence_hash',
      'column_snapshot_deletion_allowed',
      'constraint_snapshot_completeness_status',
      'constraint_snapshot_deletion_requires_complete',
      'constraint_snapshot_completeness_requires_evidence',
      'trigger_snapshot_binding_immutable',
    ]);
  });

  it('keeps migration 012 adoption evidence bound to durable-job lifecycle artifacts', () => {
    const probe = MIGRATION_PROBES.project.find((candidate) => candidate.ordinal === 12);
    expect(probe?.artifacts.map((artifact) => artifact.id)).toEqual([
      'column_job_available_at',
      'column_job_cancel_requested_at',
      'column_job_blocked_at',
      'column_job_dead_lettered_at',
      'column_job_status_reason',
      'constraint_job_attempts_nonnegative',
      'constraint_job_max_attempts_positive',
      'constraint_job_status_lifecycle',
      'index_job_active_dedupe_lifecycle',
      'index_job_claim_lifecycle',
      'index_job_available_claim_lifecycle',
      'index_job_recovery',
    ]);
  });

  it('keeps migration 013 adoption evidence bound to snapshot-review readiness', () => {
    const probe = MIGRATION_PROBES.project.find((candidate) => candidate.ordinal === 13);
    expect(probe?.artifacts.map((artifact) => artifact.id)).toEqual([
      'table_snapshot_reviews',
      'table_review_legacy_archive',
      'column_archive_id',
      'column_archive_legacy_review_id',
      'column_archive_operator_id',
      'column_archive_expires_at',
      'column_archive_archived_at',
      'column_archive_reason',
      'index_archive_legacy_review_unique',
      'trigger_archive_immutable',
      'trigger_archive_truncate_immutable',
      'column_review_id',
      'column_review_snapshot_id',
      'column_review_snapshot_uuid',
      'column_review_project_id',
      'column_review_reviewer_id',
      'column_review_operator_id',
      'column_review_reviewer_capability',
      'column_review_evidence_id',
      'column_review_reason',
      'column_review_command_scope',
      'column_review_token_digest',
      'column_review_approved_at',
      'column_review_expires_at',
      'column_review_created_at',
      'constraint_review_one_per_snapshot',
      'constraint_review_token_digest_unique',
      'constraint_review_operator_id',
      'constraint_review_capability',
      'constraint_review_expiry',
      'table_review_decisions',
      'column_decision_id',
      'column_decision_snapshot_id',
      'column_decision_snapshot_uuid',
      'column_decision_project_id',
      'column_decision_kind',
      'column_decision_operator_id',
      'column_decision_reason',
      'column_decision_decided_at',
      'column_decision_created_at',
      'constraint_decision_one_per_snapshot',
      'constraint_decision_kind',
      'constraint_decision_operator_id',
      'trigger_reviews_immutable',
      'trigger_decisions_immutable',
    ]);
  });

  it('emits SQL-safe escaped literals for migration 012 catalog comparisons', async () => {
    const db = new FakeDb({ footprintPresent: true });
    await probeLane(db, 'project', 12);
    const probeSql = db.calls.find((call) => call.text.includes('project_jobs_status_check'))?.text;

    expect(probeSql).toContain("array[''queued''::text");
    expect(probeSql).toContain("''blocked-review''::text");
    expect(probeSql).not.toContain("array['queued'::text");
  });

  it('adopts a canonical migration 013 footprint', async () => {
    const manifest = projectManifest();
    const db = new FakeDb({ footprintPresent: true });
    const status = await runStatus({
      db,
      lane: 'project',
      manifest,
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
    });
    expect(status.adoptionChallenge).toMatchObject({ prefixOrdinal: 13, absentOrdinals: [] });

    const challenge = status.adoptionChallenge;
    if (!challenge) throw new Error('expected a canonical migration 013 challenge');
    const adopted = await runAdopt({
      db,
      lane: 'project',
      manifest,
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
      challengeDigest: challenge.proofDigest,
      dryRun: false,
    });
    expect(adopted.adopted.map((item) => item.ordinal)).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 1)
    );
  });

  const migration012Probe = MIGRATION_PROBES.project.find((candidate) => candidate.ordinal === 12);
  const migration012ConstraintAndIndexIds =
    migration012Probe?.artifacts
      .filter(
        (artifact) =>
          artifact.id.startsWith('constraint_job_') || artifact.id.startsWith('index_job_')
      )
      .map((artifact) => artifact.id) ?? [];

  it.each(
    migration012ConstraintAndIndexIds
  )('does not adopt migration 012 when %s is missing', async (missingArtifactId) => {
    const manifest = projectManifest();
    const db = new FakeDb({
      footprintPresent: true,
      probeResponses: projectProbeResponses(missingArtifactId),
    });
    const status = await runStatus({
      db,
      lane: 'project',
      manifest,
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
    });
    expect(status.adoptionChallenge).toMatchObject({
      prefixOrdinal: 11,
      absentOrdinals: [12, 13],
    });
    expect(status.adoptionChallenge?.provenArtifacts).not.toContain(`12:${missingArtifactId}`);
  });

  it('loads every migration with exact raw-byte checksums', async () => {
    for (const lane of ['project', 'docs'] as const) {
      const manifest = await loadManifest(REPO_ROOT, lane);
      expect(manifest).toHaveLength(lane === 'project' ? 13 : 5);
      for (const item of manifest) {
        expect(item.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(item.sqlText.length).toBeGreaterThan(0);
      }
      const again = await loadManifest(REPO_ROOT, lane);
      expect(again.map((m) => m.checksumSha256)).toEqual(manifest.map((m) => m.checksumSha256));
    }
  });

  it('rejects a manifest migration symlink even when its target is readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rag-v2-migration-manifest-'));
    try {
      const laneRoot = join(root, 'infra/docs-rag/sql');
      await mkdir(laneRoot, { recursive: true });
      const docs = manifestForLane('docs');
      for (const descriptor of docs) {
        await copyFile(
          join(DEFAULT_REPO_ROOT, descriptor.relativePath),
          join(root, descriptor.relativePath)
        );
      }
      const descriptor = docs[0];
      const target = join(root, 'outside.sql');
      await writeFile(target, await readFile(join(DEFAULT_REPO_ROOT, descriptor.relativePath)));
      const migrationPath = join(root, descriptor.relativePath);
      await rm(migrationPath);
      await symlink(target, migrationPath);
      await expectRunnerError(loadManifest(root, 'docs'), 'MIGRATION_APPLY_FAILED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a lane SQL directory replaced by a symlink escaping the repository root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rag-v2-migration-lane-esc-'));
    const outside = await mkdtemp(join(tmpdir(), 'rag-v2-migration-lane-out-'));
    try {
      // Outside leaf files are regular files on purpose. Their bytes are
      // deliberately wrong: if the loader ever read them, loadManifest would
      // succeed with drifted checksums instead of failing closed before IO.
      const docs = manifestForLane('docs');
      for (const [index, item] of docs.entries()) {
        await writeFile(
          join(outside, `${item.name}.sql`),
          `-- outside copy ${index}\nselect ${index};`
        );
      }
      await mkdir(join(root, 'infra/docs-rag'), { recursive: true });
      await symlink(outside, join(root, 'infra/docs-rag/sql'));
      let error: unknown;
      try {
        await loadManifest(root, 'docs');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(MigrationRunnerError);
      expect((error as MigrationRunnerError).code).toBe('MIGRATION_APPLY_FAILED');
      expect((error as MigrationRunnerError).message).not.toContain(outside);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked migration parent directory that escapes the repo root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rag-v2-migration-parent-esc-'));
    const outside = await mkdtemp(join(tmpdir(), 'rag-v2-migration-parent-out-'));
    try {
      const docs = manifestForLane('docs');
      for (const [index, item] of docs.entries()) {
        await mkdir(join(outside, 'sql'), { recursive: true });
        await writeFile(
          join(outside, 'sql', `${item.name}.sql`),
          `-- outside parent copy ${index}\nselect ${index};`
        );
      }
      await mkdir(join(root, 'infra'), { recursive: true });
      await symlink(outside, join(root, 'infra/docs-rag'));
      await expectRunnerError(loadManifest(root, 'docs'), 'MIGRATION_APPLY_FAILED');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails fast when a fixed-manifest file is unreadable', async () => {
    await expectRunnerError(
      loadManifest(join(REPO_ROOT, 'nonexistent-dir'), 'project'),
      'MIGRATION_APPLY_FAILED'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Redaction, bounds, errors                                                  */
/* -------------------------------------------------------------------------- */

describe('redaction and text bounds', () => {
  it('bounds messages and strips control characters', () => {
    expect(boundText('line1\nline2\ttab')).toBe('line1 line2 tab');
    const long = 'x'.repeat(400);
    const bounded = boundText(long);
    expect(bounded.length).toBeLessThanOrEqual(300);
    expect(bounded.endsWith('...')).toBe(true);
  });

  it('redacts passwords in postgres URLs', () => {
    expect(redactPostgresUrl('postgres://user:secret@host.example:5432/db')).toBe(
      'postgres://user:***@host.example:5432/db'
    );
    expect(redactPostgresUrl('not really :hidden@ url')).toContain(':***@');
  });

  it('bounds detail strings while preserving other types', () => {
    const details = redactDetails({ message: 'y'.repeat(500), ordinal: 4, flag: true });
    expect((details.message as string).length).toBeLessThanOrEqual(300);
    expect(details.ordinal).toBe(4);
    expect(details.flag).toBe(true);
  });

  it('describes unknown errors with optional SQLSTATE', () => {
    expect(describeError(new Error('boom'))).toEqual({ message: 'boom' });
    expect(describeError(Object.assign(new Error('db'), { errno: '42P01' }))).toEqual({
      message: 'db',
      pgCode: '42P01',
    });
    expect(describeError('raw failure')).toEqual({ message: 'raw failure' });
    expect(describeError(Object.assign(new Error('password=secret'), { code: '23505' }))).toEqual({
      message: 'password=***',
      pgCode: '23505',
    });
    const nested = redactDetails({ nested: { password: 'secret', list: ['token=abc'] } });
    expect(nested).toEqual({ nested: { password: '[REDACTED]', list: ['token=***'] } });
  });

  it('redacts credentials inside runner errors and their details', () => {
    const error = new MigrationRunnerError(
      'MIGRATION_APPLY_FAILED',
      'apply failed against postgres://migrator:hunter2@db.internal:5432/production?password=leaked',
      {
        url: 'postgres://svc:topsecret@127.0.0.1:6001/rag_v2_migration_x',
        accessToken: 'raw-token-value',
        ordinal: 3,
      }
    );
    const serialized = `${error.message} ${JSON.stringify(error.details ?? {})}`;
    for (const secret of ['hunter2', 'leaked', 'topsecret', 'raw-token-value']) {
      expect(serialized).not.toContain(secret);
    }
    expect(error.message).toContain(':***@');
    const detailUrl = typeof error.details?.url === 'string' ? error.details.url : '';
    expect(detailUrl.startsWith('postgres://svc:***@')).toBe(true);
    // Sensitive keys are fully masked regardless of value shape.
    expect(error.details?.accessToken).toBe('[REDACTED]');
    expect(error.details?.ordinal).toBe(3);
  });

  it('fully redacts values under sensitive keys regardless of shape', () => {
    const details = redactDetails({
      credentials: { user: 'admin', password: { inner: 'deep-secret' } },
      tokenList: ['t1', { nested: true }],
      apiKey: 42,
      secretHolder: null,
      keep: { sub: 'visible', count: 3 },
    });
    expect(details.credentials).toBe('[REDACTED]');
    expect(details.tokenList).toBe('[REDACTED]');
    expect(details.apiKey).toBe('[REDACTED]');
    expect(details.secretHolder).toBe('[REDACTED]');
    expect(details.keep).toEqual({ sub: 'visible', count: 3 });
  });

  it('masks values under over-length keys whose sensitive suffix is truncated away', () => {
    // MAX_TEXT is 300: boundText cuts these keys before their trailing
    // password/token suffix begins, so sensitivity must be classified from
    // the original key. Before the fix, scalar and nested values leaked
    // unmasked because the truncated bounded key matched nothing.
    const longPasswordKey = `${'x'.repeat(300)}password`;
    const longTokenKey = `${'y'.repeat(300)}token`;
    const details = redactDetails({
      [longPasswordKey]: 'scalar-hunter2',
      [longTokenKey]: { nested: 'deep-secret', keep: 7 },
      visible: 'plain',
    });
    expect(Object.values(details).filter((value) => value === '[REDACTED]')).toHaveLength(2);
    const serialized = JSON.stringify(details);
    for (const secret of ['scalar-hunter2', 'deep-secret']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('plain');
  });

  it('replaces composite values at the depth limit instead of passing them through', () => {
    // MAX_DETAIL_DEPTH is 4: the object holding `credentials` sits exactly at
    // the limit, so before the fix it was returned unchanged and both the key
    // name and its secret bypassed sanitization entirely.
    const details = redactDetails({
      l1: { l2: { l3: { l4: { credentials: { password: 'hunter2-deep' }, keep: 7 } } } },
    });
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain('hunter2-deep');
    expect(serialized).not.toContain('credentials');
    expect(serialized).toContain('[TRUNCATED]');
  });

  it('truncates arrays and masks sensitive strings at the depth limit', () => {
    const details = redactDetails({
      a: { b: { c: { d: ['token=abc-leak', { deeper: true }] } } },
      s: { t: { u: { v: 'postgres://svc:hunter2@db.internal/x?password=leak' } } },
    });
    const serialized = JSON.stringify(details);
    // Composite at the limit becomes '[TRUNCATED]': neither element nor key survives.
    expect(serialized).not.toContain('token=abc-leak');
    expect(serialized).not.toContain('deeper');
    // Strings at the limit are still text-redacted, not truncated away silently.
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('leak');
    // Primitives below composite truncation points still survive.
    const primitive = redactDetails({ l1: { l2: { l3: { l4: 42 } } } });
    expect(primitive).toEqual({ l1: { l2: { l3: { l4: 42 } } } });
  });

  it('redacts percent-encoded sensitive query parameter names in well-formed URLs', () => {
    // Intra-word encoding defeats the literal generic pass; only structured
    // URL/URLSearchParams decoding can classify these keys as sensitive.
    const error = new MigrationRunnerError(
      'MIGRATION_APPLY_FAILED',
      'status https://ops.example/health?p%61ssword=url-leak-1&keep=1&ACCESS%5FT%4FKEN=url-leak-2'
    );
    const serialized = `${error.message} ${JSON.stringify(error.details ?? {})}`;
    for (const secret of ['url-leak-1', 'url-leak-2']) {
      expect(serialized).not.toContain(secret);
    }
    expect(error.message).toContain('p%61ssword=***');
    expect(error.message).toContain('ACCESS%5FT%4FKEN=***');
    // Non-sensitive pairs stay byte-identical (no re-serialization drift).
    expect(error.message).toContain('keep=1');
  });

  it('redacts percent-encoded secrets in malformed ledger-derived status output', async () => {
    const item = tinyManifest()[0];
    const rows: LedgerRow[] = [
      {
        lane: 'docs',
        ordinal: 1,
        name: item.descriptor.name,
        checksumSha256: item.checksumSha256,
        recordKind:
          'executed ?api%5Fkey=bare-leak-3&creden%74ials=bare-leak-4&page=2' as LedgerRow['recordKind'],
        proofDigest: sha256Text('forged'),
      },
    ];
    const db = new FakeDb({ ledgerRows: rows, footprintPresent: true });
    const report = await runStatus({
      db,
      lane: 'docs',
      manifest: tinyManifest(),
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
    });
    expect(report.state.kind).toBe('invalid_ledger');
    const serialized = JSON.stringify(report);
    for (const secret of ['bare-leak-3', 'bare-leak-4']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('api%5Fkey=***');
    expect(serialized).toContain('creden%74ials=***');
    expect(serialized).toContain('page=2');
  });

  it('redacts encoded case-variant parameter names in error text and describeError', () => {
    const error = new MigrationRunnerError(
      'MIGRATION_APPLY_FAILED',
      'callback http://hooks.test/cb?API%5FKEY=cv-leak-5&access%5Ftoken=cv-leak-6&x=3'
    );
    const serialized = `${error.message}`;
    for (const secret of ['cv-leak-5', 'cv-leak-6']) {
      expect(serialized).not.toContain(secret);
    }
    expect(error.message).toContain('x=3');
    const described = describeError(
      Object.assign(new Error('gateway ?Crede%6Etial=err-leak-7&q=ok'), { code: '23505' })
    );
    expect(described.message).not.toContain('err-leak-7');
    expect(described.pgCode).toBe('23505');
    expect(described.message).toContain('q=ok');
  });

  it('redacts URL query secrets in fallback text redaction', () => {
    const error = new MigrationRunnerError(
      'MIGRATION_APPLY_FAILED',
      'redirect https://hooks.example/cb?pwd=p1&state=ok&jwt=j2&credentials=c3&signature=s4&next=/x'
    );
    for (const leak of ['p1', 'j2', 'c3', 's4']) {
      expect(error.message).not.toContain(leak);
    }
    expect(error.message).toContain('pwd=***');
    expect(error.message).toContain('jwt=***');
    expect(error.message).toContain('credentials=***');
    expect(error.message).toContain('signature=***');
    // Non-sensitive query parameters must survive redaction untouched.
    expect(error.message).toContain('state=ok');
    expect(error.message).toContain('next=/x');
    const fallback = redactPostgresUrl('unparseable dsn ?access_token=zz&sslmode=disable');
    expect(fallback).toContain('access_token=***');
    expect(fallback).toContain('sslmode=disable');
  });

  it('sanitizes malicious ledger-derived status output before CLI serialization', async () => {
    const item = tinyManifest()[0];
    const rows: LedgerRow[] = [
      {
        lane: 'docs',
        ordinal: 1,
        name: item.descriptor.name,
        checksumSha256: item.checksumSha256,
        recordKind:
          'executed password=hunter2 postgres://svc:hunter2@db.internal/x' as LedgerRow['recordKind'],
        proofDigest: sha256Text('forged'),
      },
    ];
    const db = new FakeDb({ ledgerRows: rows, footprintPresent: true });
    const report = await runStatus({
      db,
      lane: 'docs',
      manifest: tinyManifest(),
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
    });
    expect(report.state.kind).toBe('invalid_ledger');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain('password=***');
    expect(serialized).toContain(':***@');
    if (report.state.kind === 'invalid_ledger') {
      expect(JSON.stringify(report.state.issues)).not.toContain('hunter2');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Proof digests and ledger validation                                        */
/* -------------------------------------------------------------------------- */

describe('proof digests', () => {
  const base = {
    kind: 'executed' as const,
    lane: 'docs' as const,
    ordinal: 2,
    name: 'two',
    checksum: 'c',
  };

  it('is deterministic and field-sensitive', () => {
    expect(proofDigestFor(base)).toBe(proofDigestFor({ ...base }));
    expect(proofDigestFor(base)).not.toBe(proofDigestFor({ ...base, ordinal: 3 }));
    expect(proofDigestFor(base)).not.toBe(proofDigestFor({ ...base, kind: 'verified_adoption' }));
    expect(proofDigestFor(base)).not.toBe(proofDigestFor({ ...base, checksum: 'd' }));
  });
});

describe('validateLedger', () => {
  const manifest = tinyManifest();

  it('accepts fully valid rows', () => {
    expect(validateLedger(manifest, validRows(manifest, 2))).toEqual([]);
  });

  it('detects checksum drift', () => {
    const rows = validRows(manifest, 2).map((r) =>
      r.ordinal === 2
        ? {
            ...r,
            checksumSha256: sha256Text('tampered'),
            proofDigest: proofDigestFor({
              kind: r.recordKind,
              lane: r.lane,
              ordinal: r.ordinal,
              name: r.name,
              checksum: sha256Text('tampered'),
            }),
          }
        : r
    );
    expect(validateLedger(manifest, rows).map((i: LedgerIssue) => i.code)).toEqual([
      'CHECKSUM_DRIFT',
    ]);
  });

  it('detects unknown ordinals and name mismatches', () => {
    const rows = [...validRows(manifest, 2), { ...validRows(manifest, 1)[0], ordinal: 99 }];
    const issues = validateLedger(manifest, rows);
    expect(issues.filter((i) => i.code === 'UNKNOWN_ROW')).toHaveLength(1);

    const renamed = validRows(manifest, 2).map((r) =>
      r.ordinal === 1 ? { ...r, name: 'renamed' } : r
    );
    expect(validateLedger(manifest, renamed).map((i) => i.code)).toContain('UNKNOWN_ROW');
  });

  it('detects gaps below the highest ordinal', () => {
    const rows = validRows(manifest, 2).filter((r) => r.ordinal !== 1);
    expect(validateLedger(manifest, rows).map((i) => i.code)).toEqual(['GAP']);
  });

  it('detects bad record kinds and proof mismatches', () => {
    const badKind = validRows(manifest, 2).map((r) =>
      r.ordinal === 1 ? { ...r, recordKind: 'bogus' as LedgerRow['recordKind'] } : r
    );
    const badProof = validRows(manifest, 2).map((r) =>
      r.ordinal === 2 ? { ...r, proofDigest: sha256Text('forged') } : r
    );
    expect(validateLedger(manifest, badKind).map((i) => i.code)).toEqual([
      'BAD_RECORD_KIND',
      'PROOF_DIGEST_MISMATCH',
    ]);
    expect(validateLedger(manifest, badProof).map((i) => i.code)).toEqual([
      'PROOF_DIGEST_MISMATCH',
    ]);
  });

  it('bounds ledger rows, ordinals, and field lengths', () => {
    const oversized = { ...validRows(manifest, 1)[0], name: 'x'.repeat(129) };
    expect(validateLedger(manifest, [oversized]).map((issue) => issue.code)).toContain(
      'FIELD_TOO_LARGE'
    );
    expect(
      validateLedger(manifest, [
        ...validRows(manifest, 2),
        { ...validRows(manifest, 1)[0], ordinal: 0 },
      ]).map((issue) => issue.code)
    ).toContain('UNKNOWN_ROW');
    expect(
      validateLedger(manifest, [...validRows(manifest, 2), validRows(manifest, 1)[0]]).map(
        (issue) => issue.code
      )
    ).toContain('ROW_COUNT_EXCEEDED');
  });
});

describe('classifyLane', () => {
  const manifest = tinyManifest();

  it('reports fresh when there is no ledger and no footprint', () => {
    expect(
      classifyLane({ manifest, ledgerPresent: false, rows: [], footprintPresent: false }).kind
    ).toBe('fresh');
    expect(
      classifyLane({ manifest, ledgerPresent: true, rows: [], footprintPresent: false }).kind
    ).toBe('fresh');
  });

  it('requires adoption when a footprint exists without ledger rows', () => {
    expect(
      classifyLane({ manifest, ledgerPresent: false, rows: [], footprintPresent: true }).kind
    ).toBe('adoption_required');
    expect(
      classifyLane({ manifest, ledgerPresent: true, rows: [], footprintPresent: true }).kind
    ).toBe('adoption_required');
  });

  it('reports up_to_date and upgrade_pending states', () => {
    const done = classifyLane({
      manifest,
      ledgerPresent: true,
      rows: validRows(manifest, 2),
      footprintPresent: true,
    });
    expect(done).toEqual({ kind: 'up_to_date', appliedThrough: 2 });

    const partial = classifyLane({
      manifest,
      ledgerPresent: true,
      rows: validRows(manifest, 1),
      footprintPresent: true,
    });
    expect(partial).toEqual({ kind: 'upgrade_pending', appliedThrough: 1, pendingOrdinals: [2] });
  });

  it('marks a ledger-without-footprint database invalid', () => {
    const state = classifyLane({
      manifest,
      ledgerPresent: true,
      rows: validRows(manifest, 2),
      footprintPresent: false,
    });
    expect(state.kind).toBe('invalid_ledger');
    if (state.kind === 'invalid_ledger') {
      expect(state.issues.map((i) => i.code)).toEqual(['LEDGER_WITHOUT_FOOTPRINT']);
    }
  });

  it('propagates validation issues into invalid_ledger', () => {
    const drifted = validRows(manifest, 2).map((r) =>
      r.ordinal === 1 ? { ...r, checksumSha256: sha256Text('drift') } : r
    );
    const state = classifyLane({
      manifest,
      ledgerPresent: true,
      rows: drifted,
      footprintPresent: true,
    });
    expect(state.kind).toBe('invalid_ledger');
  });
});

describe('readLedger', () => {
  it('reads a missing table as an absent ledger', async () => {
    const db = new FakeDb({ ledgerMissing: true });
    await expect(readLedger(db, 'docs')).resolves.toEqual({ present: false, rows: [] });
  });

  it('rethrows unexpected ledger read failures', async () => {
    const db = new FakeDb();
    db.unsafe = async () => {
      throw new Error('connection reset');
    };
    await expect(readLedger(db, 'docs')).rejects.toThrow('connection reset');
  });
});

/* -------------------------------------------------------------------------- */
/* Adoption challenges                                                        */
/* -------------------------------------------------------------------------- */

describe('buildAdoptionChallenge', () => {
  const lane: MigrationLane = 'docs';
  const manifest = tinyManifest();

  function probes(
    passedPerOrdinal: number[]
  ): Parameters<typeof buildAdoptionChallenge>[0]['probes'] {
    return passedPerOrdinal.map((passed, index) => ({
      ordinal: index + 1,
      passed: passed > 0,
      artifacts: [{ id: 'artifact', present: passed > 0 }],
    }));
  }

  const targetFingerprint = sha256Text('test-disposable-target');

  it('publishes a verifiable proof for a fully contiguous prefix', () => {
    const challenge = buildAdoptionChallenge({
      lane,
      manifest,
      probes: probes([1, 1]),
      targetFingerprint,
    });
    expect(challenge).toMatchObject({ prefixOrdinal: 2, absentOrdinals: [] });
    if (!('unsupported' in challenge)) {
      const expected = sha256Text(
        JSON.stringify({
          lane,
          prefixOrdinal: 2,
          provenArtifacts: ['1:artifact', '2:artifact'],
          targetFingerprint,
          manifestChecksums: manifest.map(
            (item) => `${item.descriptor.ordinal}:${item.checksumSha256}`
          ),
        })
      );
      expect(challenge.proofDigest).toBe(expected);
      expect(challenge.targetFingerprint).toBe(targetFingerprint);
      expect(challenge.manifestChecksums).toHaveLength(manifest.length);
    }
  });

  it('supports partial prefixes and reports absent ordinals', () => {
    const challenge = buildAdoptionChallenge({
      lane,
      manifest,
      probes: probes([1, 0]),
      targetFingerprint,
    });
    expect(challenge).toMatchObject({ prefixOrdinal: 1, absentOrdinals: [2] });
  });

  it('refuses when nothing could be proven', () => {
    expect(
      buildAdoptionChallenge({ lane, manifest, probes: probes([0, 0]), targetFingerprint })
    ).toEqual({
      unsupported: true,
      reason: expect.stringContaining('refusing to adopt'),
    });
  });

  it('refuses evidence beyond the proven prefix (non-contiguous legacy state)', () => {
    expect(
      buildAdoptionChallenge({ lane, manifest, probes: probes([1, 0, 1]), targetFingerprint })
    ).toMatchObject({
      unsupported: true,
    });
  });

  it('refuses out-of-order evidence', () => {
    const odd = [
      { ordinal: 1, passed: false, artifacts: [{ id: 'a', present: false }] },
      { ordinal: 2, passed: true, artifacts: [{ id: 'b', present: true }] },
    ];
    expect(
      buildAdoptionChallenge({ lane, manifest, probes: odd, targetFingerprint })
    ).toMatchObject({
      unsupported: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Mutation gates and URL resolution                                          */
/* -------------------------------------------------------------------------- */

describe('assertMutationGates', () => {
  it('requires --execute', () => {
    expect(() => assertMutationGates({}, { execute: false })).toThrowError(MigrationRunnerError);
    try {
      assertMutationGates({}, { execute: false });
    } catch (error) {
      expect((error as MigrationRunnerError).code).toBe('MIGRATION_ACK_REQUIRED');
    }
  });

  it('requires the isolated-target acknowledgement', () => {
    try {
      assertMutationGates({ RAG_MIGRATION_WRITE_ACK: '1' }, { execute: true });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as MigrationRunnerError).code).toBe('MIGRATION_TARGET_NOT_ISOLATED');
    }
  });

  it('requires the write acknowledgement', () => {
    try {
      assertMutationGates({ RAG_MIGRATION_TARGET: 'isolated' }, { execute: true });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as MigrationRunnerError).code).toBe('MIGRATION_ACK_REQUIRED');
    }
  });

  it('passes with all gates set', () => {
    expect(() =>
      assertMutationGates(
        { RAG_MIGRATION_TARGET: 'isolated', RAG_MIGRATION_WRITE_ACK: '1' },
        { execute: true }
      )
    ).not.toThrow();
  });
});

describe('resolveLaneDatabaseUrl', () => {
  it('ignores generic variables entirely', () => {
    expect(() =>
      resolveLaneDatabaseUrl({
        lane: 'project',
        env: { DATABASE_URL: 'postgres://generic/db' },
        mutating: false,
      })
    ).toThrowError(/PROJECT_RAG_DATABASE_URL/);
  });

  it('rejects non-postgres schemes', () => {
    expect(() =>
      resolveLaneDatabaseUrl({
        lane: 'docs',
        env: { [LANE_URL_ENV.docs]: 'mysql://x/y' },
        mutating: false,
      })
    ).toThrowError(/Postgres/);
  });

  it('strips surrounding quotes and labels the source variable', () => {
    const resolved = resolveLaneDatabaseUrl({
      lane: 'project',
      env: { PROJECT_RAG_DATABASE_URL: '"postgres://u:p@127.0.0.1:6001/rag_v2_migration_test"' },
      mutating: true,
    });
    expect(resolved.url).toBe('postgres://u:p@127.0.0.1:6001/rag_v2_migration_test');
    expect(resolved.source).toBe('env:PROJECT_RAG_DATABASE_URL');
  });

  it('rejects known shared default endpoints for mutations but allows reads', () => {
    const official = OFFICIAL_DEFAULT_URLS[0];
    expect(() =>
      resolveLaneDatabaseUrl({
        lane: 'project',
        env: { PROJECT_RAG_DATABASE_URL: official },
        mutating: true,
      })
    ).toThrowError(MigrationRunnerError);
    const allowed = resolveLaneDatabaseUrl({
      lane: 'project',
      env: { PROJECT_RAG_DATABASE_URL: official },
      mutating: false,
    });
    expect(allowed.url).toBe(official.replace(/\/$/, ''));
  });
});

/**
 * Negative no-connect proof for the positive disposable-target policy.
 *
 * Every case here must fail with MIGRATION_TARGET_NOT_ISOLATED during pure,
 * synchronous URL resolution — before any Bun.SQL client is constructed and
 * before any socket is opened. cli.ts resolves the URL policy first
 * (resolveLaneDatabaseUrl) and only then builds the connection pool, so a
 * policy refusal can never perform network IO against an official-shaped or
 * aliased target. The disposable integration target used by the real-Postgres
 * suite is included as the positive control.
 */
describe('mutating URL resolution rejects official-shaped and aliased targets pre-connect', () => {
  function expectMutationRejected(url: string, lane: MigrationLane = 'docs'): void {
    let error: unknown;
    try {
      resolveLaneDatabaseUrl({
        lane,
        env: { [LANE_URL_ENV[lane]]: url },
        mutating: true,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MigrationRunnerError);
    expect((error as MigrationRunnerError).code).toBe('MIGRATION_TARGET_NOT_ISOLATED');
  }

  it('accepts the exact disposable integration target shape as positive control', () => {
    const resolved = resolveLaneDatabaseUrl({
      lane: 'docs',
      env: {
        DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://postgres@127.0.0.1:18325/rag_v2_migration_t03_a',
      },
      mutating: true,
    });
    expect(resolved.targetIdentity.host).toBe('127.0.0.1');
    expect(resolved.targetIdentity.database).toBe('rag_v2_migration_t03_a');
  });

  it('rejects every known official default URL for mutations', () => {
    for (const url of OFFICIAL_DEFAULT_URLS) {
      expectMutationRejected(url);
      expectMutationRejected(url.replace(/^postgres:/, 'postgresql:'));
    }
  });

  it('rejects every official database name even on loopback non-official ports', () => {
    for (const name of OFFICIAL_DATABASE_NAMES) {
      expectMutationRejected(`postgres://postgres@127.0.0.1:18325/${name}`);
      // Percent-encoded aliases of official names decode before the policy
      // check, so they must be rejected too.
      expectMutationRejected(`postgres://postgres@127.0.0.1:18325/${encodeURIComponent(name)}`);
    }
  });

  it('rejects every official listener port even with a disposable database name', () => {
    for (const port of OFFICIAL_DATABASE_PORTS) {
      expectMutationRejected(`postgres://postgres@127.0.0.1:${port}/rag_v2_migration_t03`);
    }
  });

  it('rejects the implicit default port when no explicit port is present', () => {
    expectMutationRejected('postgres://postgres@127.0.0.1/rag_v2_migration_t03');
  });

  it('rejects non-loopback host aliases that would dodge the loopback rule', () => {
    expectMutationRejected('postgres://postgres@localhost:18325/rag_v2_migration_t03');
    expectMutationRejected('postgres://postgres@db.internal.example:18325/rag_v2_migration_t03');
    expectMutationRejected('postgres://postgres@[::ffff:127.0.0.1]:18325/rag_v2_migration_t03');
    // Decimal-shorthand IPv4 loopback alias; only literal 127.0.0.1 / ::1 pass.
    expectMutationRejected('postgres://postgres@127.1:18325/rag_v2_migration_t03');
  });

  it('rejects query or fragment overrides on otherwise valid targets', () => {
    expectMutationRejected(
      'postgres://postgres@127.0.0.1:18325/rag_v2_migration_t03?sslmode=disable'
    );
    expectMutationRejected('postgres://postgres@127.0.0.1:18325/rag_v2_migration_t03#frag');
  });

  it('rejects uppercase and malformed aliases of the disposable name pattern', () => {
    expectMutationRejected('postgres://postgres@127.0.0.1:18325/RAG_V2_MIGRATION_T03');
    expectMutationRejected('postgres://postgres@127.0.0.1:18325/rag_v2_migration_');
  });

  it('rejects multi-segment database paths during canonicalization before policy runs', () => {
    expect(() =>
      resolveLaneDatabaseUrl({
        lane: 'docs',
        env: {
          DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://postgres@127.0.0.1:18325/docs_rag_lab/extra',
        },
        mutating: true,
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'MIGRATION_URL_REJECTED',
        name: 'MigrationRunnerError',
      })
    );
  });

  it('canonicalizes postgresql:// scheme aliases to the same identity fingerprint', () => {
    const viaPostgres = resolveLaneDatabaseUrl({
      lane: 'docs',
      env: { DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://u:p@127.0.0.1:18325/rag_v2_migration_x' },
      mutating: true,
    });
    const viaPostgresql = resolveLaneDatabaseUrl({
      lane: 'docs',
      env: {
        DOCS_RAG_PG_LAB_DATABASE_URL: 'postgresql://u:p@127.0.0.1:18325/rag_v2_migration_x',
      },
      mutating: true,
    });
    // The scheme alias must not produce a different target identity.
    expect(viaPostgresql.targetIdentity.fingerprint).toBe(viaPostgres.targetIdentity.fingerprint);
    expect(viaPostgresql.targetIdentity.redactedUrl).toBe(viaPostgres.targetIdentity.redactedUrl);
  });
});

/* -------------------------------------------------------------------------- */
/* Status and dry-run                                                         */
/* -------------------------------------------------------------------------- */

describe('runStatus', () => {
  it('executes strictly read-only statements', async () => {
    const db = new FakeDb();
    const report = await runStatus({
      db,
      lane: 'docs',
      manifest: tinyManifest(),
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
    });
    for (const call of db.calls) {
      expect(call.text.trim().toLowerCase()).toMatch(/^select\b/);
    }
    expect(report.readOnly).toBe(true);
    expect(report.state.kind).toBe('fresh');
    expect(report.pending.map((p) => p.ordinal)).toEqual([1, 2]);
  });
});

describe('runApply dry-run', () => {
  it('plans without locking or writing anything', async () => {
    const db = new FakeDb({ ledgerMissing: true });
    const report = await runApply({
      db,
      lane: 'docs',
      manifest: tinyManifest(),
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
      dryRun: true,
    });
    expect(report.executed).toEqual([]);
    expect(report.pending.map((p) => p.ordinal)).toEqual([1, 2]);
    const texts = db.calls.map((c) => c.text.toLowerCase());
    expect(texts.some((t) => t.includes('pg_try_advisory_lock'))).toBe(false);
    expect(texts.some((t) => t.includes('create table'))).toBe(false);
    expect(texts.some((t) => t.includes('insert into'))).toBe(false);
    expect(db.appliedScripts).toHaveLength(0);
  });
});

describe('runApply execution', () => {
  const manifest = tinyManifest();
  const baseInput = {
    lane: 'docs' as const,
    manifest,
    redactedUrl: 'redacted',
    targetFingerprint: TEST_TARGET_FINGERPRINT,
    dryRun: false,
  };

  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it('applies a fresh lane in order and records executed rows', async () => {
    const report = await runApply({ db, ...baseInput });
    expect(report.executed.map((e) => e.ordinal)).toEqual([1, 2]);
    expect(report.state.kind).toBe('up_to_date');
    expect(db.appliedScripts).toEqual(manifest.map((m) => m.sqlText));
    expect(db.unlockCount).toBe(1);
    expect(db.ledgerInserts).toHaveLength(2);
    expect(db.ledgerInserts[0]).toEqual([
      'docs',
      1,
      'one',
      manifest[0].checksumSha256,
      'executed',
      proofDigestFor({
        kind: 'executed',
        lane: 'docs',
        ordinal: 1,
        name: 'one',
        checksum: manifest[0].checksumSha256,
      }),
    ]);
    // Ledger DDL runs inside the mutating path only.
    expect(
      db.calls.some((c) =>
        c.text.includes('create table if not exists public.rag_schema_migrations')
      )
    ).toBe(true);
  });

  it('applies only the contiguous pending suffix for upgrades', async () => {
    const upgradeDb = new FakeDb({ ledgerRows: validRows(manifest, 1), footprintPresent: true });
    const report = await runApply({ db: upgradeDb, ...baseInput });
    expect(report.executed.map((e) => e.ordinal)).toEqual([2]);
    expect(upgradeDb.appliedScripts).toEqual([manifest[1].sqlText]);
  });

  it('performs a no-op rerun when already up to date', async () => {
    const doneDb = new FakeDb({ ledgerRows: validRows(manifest, 2), footprintPresent: true });
    const report = await runApply({ db: doneDb, ...baseInput });
    expect(report.executed).toEqual([]);
    expect(doneDb.appliedScripts).toHaveLength(0);
    expect(doneDb.lockAttempts).toBe(1);
  });

  it('fails closed on invalid ledgers before taking the lock', async () => {
    const drifted = validRows(manifest, 2).map((r) =>
      r.ordinal === 2 ? { ...r, checksumSha256: sha256Text('drifted') } : r
    );
    const invalidDb = new FakeDb({ ledgerRows: drifted, footprintPresent: true });
    await expectRunnerError(runApply({ db: invalidDb, ...baseInput }), 'MIGRATION_CHECKSUM_DRIFT');
    expect(invalidDb.lockAttempts).toBe(0);
  });

  it('refuses adoption_required lanes instead of auto-baselining', async () => {
    const adoptDb = new FakeDb({ footprintPresent: true });
    await expectRunnerError(runApply({ db: adoptDb, ...baseInput }), 'MIGRATION_ADOPTION_REQUIRED');
    expect(adoptDb.appliedScripts).toHaveLength(0);
  });

  it('fails closed with MIGRATION_LOCK_BUSY and releases nothing', async () => {
    const busyDb = new FakeDb({ lockAvailable: false });
    await expectRunnerError(runApply({ db: busyDb, ...baseInput }), 'MIGRATION_LOCK_BUSY');
    expect(busyDb.unlockCount).toBe(0);
  });

  it('wraps script failures with ordinal context and still unlocks', async () => {
    const failing = new FakeDb({
      failScript: (sqlText) => sqlText.includes('two'),
    });
    await expectRunnerError(runApply({ db: failing, ...baseInput }), 'MIGRATION_APPLY_FAILED');
    expect(failing.unlockCount).toBe(1);
    expect(failing.ledgerInserts).toHaveLength(1);
  });

  it('fails closed when the ledger insert itself fails', async () => {
    const failing = new FakeDb({ failLedgerInsert: true });
    await expectRunnerError(runApply({ db: failing, ...baseInput }), 'MIGRATION_APPLY_FAILED');
    expect(failing.unlockCount).toBe(1);
  });

  it('preserves the original script error when advisory unlock cleanup fails', async () => {
    const failing = new FakeDb({
      failScript: (sqlText) => sqlText.includes('two'),
      failUnlock: true,
    });
    let caught: unknown;
    try {
      await runApply({ db: failing, ...baseInput });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationRunnerError);
    const runnerError = caught as MigrationRunnerError;
    // The original migration failure must surface, never the cleanup error.
    expect(runnerError.code).toBe('MIGRATION_APPLY_FAILED');
    expect(runnerError.message).toContain('migration 2');
    expect(runnerError.message).not.toContain('unlock');
  });

  it('refuses a blind rerun after a crash between script and ledger record', async () => {
    // Crash window: migration 001 executed but its ledger row was never
    // written. A rerun sees footprint-without-ledger and must fail closed as
    // adoption_required instead of re-executing historical SQL blindly.
    const crashed = new FakeDb({ failLedgerInsert: true });
    await expectRunnerError(runApply({ db: crashed, ...baseInput }), 'MIGRATION_APPLY_FAILED');
    expect(crashed.appliedScripts).toHaveLength(1);

    await expectRunnerError(runApply({ db: crashed, ...baseInput }), 'MIGRATION_ADOPTION_REQUIRED');
    // No additional script execution, no new lock attempts, no unlock drift.
    expect(crashed.appliedScripts).toHaveLength(1);
    expect(crashed.ledgerInserts).toHaveLength(0);
    expect(crashed.lockAttempts).toBe(1);
    expect(crashed.unlockCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Adoption                                                                   */
/* -------------------------------------------------------------------------- */

describe('runAdopt', () => {
  const manifest = tinyManifest();
  const baseInput = {
    lane: 'docs' as const,
    manifest,
    redactedUrl: 'redacted',
    targetFingerprint: TEST_TARGET_FINGERPRINT,
    dryRun: false,
  };

  async function previewChallenge(db: FakeDb): Promise<string> {
    const report = await runStatus({
      db,
      lane: 'docs',
      manifest,
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
    });
    if (!report.adoptionChallenge) {
      throw new Error('fixture expected a supported challenge');
    }
    return report.adoptionChallenge.proofDigest;
  }

  it('refuses when the lane is not in adoption_required state', async () => {
    const db = new FakeDb();
    await expectRunnerError(
      runAdopt({ db, ...baseInput, challengeDigest: 'anything' }),
      'MIGRATION_ADOPTION_UNSUPPORTED'
    );
  });

  it('guards against empty challenge digests before any database IO', async () => {
    for (const digest of ['', '   ']) {
      const db = new FakeDb({ footprintPresent: true });
      await expectRunnerError(
        runAdopt({ db, ...baseInput, challengeDigest: digest }),
        'MIGRATION_ACK_REQUIRED'
      );
      expect(db.calls).toHaveLength(0);
    }
  });

  it('refuses unproven legacy states without writing rows', async () => {
    const db = new FakeDb({ footprintPresent: true, probeResponses: [[false, false]] });
    const status = await runStatus({
      db,
      lane: 'docs',
      manifest,
      redactedUrl: 'redacted',
      targetFingerprint: TEST_TARGET_FINGERPRINT,
    });
    expect(status.adoptionChallenge).toBeUndefined();
    await expectRunnerError(
      runAdopt({ db, ...baseInput, challengeDigest: 'guess' }),
      'MIGRATION_ADOPTION_UNSUPPORTED'
    );
    expect(db.ledgerInserts).toHaveLength(0);
  });

  it('rejects stale or wrong challenge digests without writing', async () => {
    const db = new FakeDb({ footprintPresent: true });
    await expectRunnerError(
      runAdopt({ db, ...baseInput, challengeDigest: sha256Text('wrong') }),
      'MIGRATION_CHALLENGE_MISMATCH'
    );
    expect(db.ledgerInserts).toHaveLength(0);
    expect(db.unlockCount).toBe(0);
  });

  it('returns a plan without locking during dry-run', async () => {
    const db = new FakeDb({ footprintPresent: true });
    const digest = await previewChallenge(db);
    const report = await runAdopt({ db, ...baseInput, challengeDigest: digest, dryRun: true });
    expect(report.adopted).toEqual([]);
    expect(db.lockAttempts).toBe(0);
    expect(db.ledgerInserts).toHaveLength(0);
  });

  it('records verified_adoption rows for the proven prefix under the lock', async () => {
    const db = new FakeDb({ footprintPresent: true });
    const digest = await previewChallenge(db);
    const report = await runAdopt({ db, ...baseInput, challengeDigest: digest });
    expect(report.adopted.map((a) => ({ ordinal: a.ordinal, recordKind: a.recordKind }))).toEqual([
      { ordinal: 1, recordKind: 'verified_adoption' },
      { ordinal: 2, recordKind: 'verified_adoption' },
    ]);
    expect(report.state.kind).toBe('up_to_date');
    expect(db.ledgerInserts[0]).toEqual([
      'docs',
      1,
      'one',
      manifest[0].checksumSha256,
      'verified_adoption',
      proofDigestFor({
        kind: 'verified_adoption',
        lane: 'docs',
        ordinal: 1,
        name: 'one',
        checksum: manifest[0].checksumSha256,
      }),
    ]);
    expect(db.unlockCount).toBe(1);
  });

  it('refuses when the world changed between preview and execution', async () => {
    // First probe cycle proves everything; the mandatory re-probe under the
    // lock then reports missing evidence, so the proof no longer matches.
    const db = new FakeDb({
      footprintPresent: true,
      probeResponses: [
        [true, true, true, true, true, true],
        [true, true, true, true],
        [true, true, true, true, true, true],
        [true, true, true, true],
        [false, false, false, false, false, false],
      ],
    });
    const digest = await previewChallenge(db);
    await expectRunnerError(
      runAdopt({ db, ...baseInput, challengeDigest: digest }),
      'MIGRATION_CHALLENGE_MISMATCH'
    );
    expect(db.ledgerInserts).toHaveLength(0);
    expect(db.unlockCount).toBe(1);
  });

  it('wraps adoption prefix writes in an explicit committed transaction', async () => {
    const db = new FakeDb({ footprintPresent: true });
    const digest = await previewChallenge(db);
    await runAdopt({ db, ...baseInput, challengeDigest: digest });
    expect(db.beginCount).toBe(1);
    expect(db.commitCount).toBe(1);
    expect(db.rollbackCount).toBe(0);
    expect(db.ledgerInserts).toHaveLength(2);
  });

  it('rolls back the whole adoption prefix when a mid-prefix insert fails', async () => {
    const db = new FakeDb({ footprintPresent: true, failLedgerInsertFromOrdinal: 2 });
    const digest = await previewChallenge(db);
    let caught: unknown;
    try {
      await runAdopt({ db, ...baseInput, challengeDigest: digest });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationRunnerError);
    const runnerError = caught as MigrationRunnerError;
    expect(runnerError.code).toBe('MIGRATION_APPLY_FAILED');
    expect(runnerError.message).toContain('migration 2');
    // The transaction was aborted and never committed.
    expect(db.rollbackCount).toBe(1);
    expect(db.commitCount).toBe(0);
    // No partial adoption representation survives: zero ledger rows for lane.
    const ledger = await readLedger(db, 'docs');
    expect(ledger.rows).toHaveLength(0);
    expect(db.unlockCount).toBe(1);
  });

  it('preserves the original adopt error when rollback and unlock cleanup fail', async () => {
    const db = new FakeDb({
      footprintPresent: true,
      failLedgerInsertFromOrdinal: 2,
      failRollback: true,
      failUnlock: true,
    });
    const digest = await previewChallenge(db);
    let caught: unknown;
    try {
      await runAdopt({ db, ...baseInput, challengeDigest: digest });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationRunnerError);
    const runnerError = caught as MigrationRunnerError;
    // Original insert failure surfaces; cleanup failures are suppressed.
    expect(runnerError.code).toBe('MIGRATION_APPLY_FAILED');
    expect(runnerError.message).toContain('migration 2');
    expect(runnerError.message).not.toContain('rollback refused');
    expect(runnerError.message).not.toContain('unlock');
    expect(db.rollbackCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Reserved connection adapter                                                */
/* -------------------------------------------------------------------------- */

describe('adaptReservedSql', () => {
  it('flattens nested multi-statement results and forwards release', async () => {
    let released = 0;
    const reserved = {
      async unsafe(text: string, values?: readonly unknown[]): Promise<unknown> {
        void text;
        void values;
        return [[], [], [{ answer: 42 }]];
      },
      async release(): Promise<void> {
        released += 1;
      },
    };
    const db = adaptReservedSql(reserved);
    await expect(db.unsafe('anything')).resolves.toEqual([{ answer: 42 }]);
    await expect(db.unsafe('with params', [1])).resolves.toEqual([{ answer: 42 }]);
    await db.release();
    expect(released).toBe(1);
  });

  it('keeps flat result arrays untouched', async () => {
    const reserved = {
      async unsafe(): Promise<unknown> {
        return [{ v: 1 }, { v: 2 }];
      },
      async release(): Promise<void> {},
    };
    await expect(adaptReservedSql(reserved).unsafe('q')).resolves.toHaveLength(2);
  });
});
