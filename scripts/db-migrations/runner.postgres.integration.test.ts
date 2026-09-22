/**
 * Opt-in real-Postgres/pgvector coverage for the fixed migration runner.
 *
 * Enable with RAG_MIGRATION_POSTGRES_INTEGRATION=1 and provide the explicit
 * disposable target RAG_MIGRATION_INTEGRATION_DATABASE_URL. The suite owns the
 * database contents and resets the public schema between scenarios; it never
 * edits historical SQL or targets a repository-configured database by default.
 */

import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DocsRagProcessingProfile,
  docsRagProcessingProfileHash,
} from '../docs-rag/processing-profile.js';
import {
  buildDocsRagSourceGenerationKey,
  normalizeDocsRagLabSearchResult,
} from '../docs-rag/store.js';
import { PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH } from '../project-rag/embeddings.js';
import {
  adaptReservedSql,
  ensureLedgerTable,
  type LedgerRow,
  type LoadedMigration,
  loadManifest,
  MIGRATION_LOCK_KEY,
  type MigrationRunnerError,
  probeLane,
  proofDigestFor,
  type ReservedSqlExecutor,
  runAdopt,
  runApply,
  runStatus,
  sha256Text,
} from './runner.js';

const RUN_REAL_DB = process.env.RAG_MIGRATION_POSTGRES_INTEGRATION === '1';
const describeReal = RUN_REAL_DB ? describe : describe.skip;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REDACTED_TARGET = 'postgres://integration-target';
const TARGET_FINGERPRINT = sha256Text('integration-disposable-target');
const TEST_VECTOR = `[${Array.from({ length: 1024 }, () => '0.1').join(',')}]`;

function createSql(url: string): Bun.SQL {
  return new Bun.SQL({
    url,
    max: 1,
    idleTimeout: 30,
    connectionTimeout: 10,
    prepare: false,
  });
}

function expectRunnerError(
  promise: Promise<unknown>,
  code: MigrationRunnerError['code']
): Promise<unknown> {
  return expect(promise).rejects.toMatchObject({ code });
}

describeReal('migration runner real Postgres integration (opt-in)', () => {
  let databaseUrl: string;
  let sql: Bun.SQL;
  let db: ReservedSqlExecutor;
  let projectManifest: readonly LoadedMigration[];
  let docsManifest: readonly LoadedMigration[];

  /**
   * Second disposable database on the same disposable server for cross-target
   * replay and challenge-binding coverage. Both names satisfy the runner's
   * strict disposable-target policy; the suite owns both and drops the
   * sibling on exit.
   */
  const SIBLING_DB = 'rag_v2_migration_t03_b';
  const TARGET_B_FINGERPRINT = sha256Text('integration-disposable-target-b');

  function withDatabaseName(rawUrl: string, database: string): string {
    const parsed = new URL(rawUrl);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }

  async function withMaintenanceConnection<T>(run: (maint: Bun.SQL) => Promise<T>): Promise<T> {
    const maint = createSql(withDatabaseName(databaseUrl, 'postgres'));
    try {
      return await run(maint);
    } finally {
      await maint.close({ timeout: 5 }).catch(() => {});
    }
  }

  beforeAll(async () => {
    databaseUrl = process.env.RAG_MIGRATION_INTEGRATION_DATABASE_URL ?? '';
    if (!databaseUrl) {
      throw new Error(
        'RAG_MIGRATION_INTEGRATION_DATABASE_URL is required when RAG_MIGRATION_POSTGRES_INTEGRATION=1'
      );
    }
    sql = createSql(databaseUrl);
    db = adaptReservedSql(await sql.reserve());
    projectManifest = await loadManifest(REPO_ROOT, 'project');
    docsManifest = await loadManifest(REPO_ROOT, 'docs');
    await withMaintenanceConnection(async (maint) => {
      const existing = await maint.unsafe('select 1 from pg_database where datname = $1', [
        SIBLING_DB,
      ]);
      if (existing.length === 0) {
        await maint.unsafe(`create database ${SIBLING_DB}`);
      }
    });
  });

  afterAll(async () => {
    await db?.release().catch(() => {});
    await sql?.close({ timeout: 5 }).catch(() => {});
    await withMaintenanceConnection(async (maint) => {
      await maint.unsafe(`drop database if exists ${SIBLING_DB} with (force)`).catch(() => {});
    });
  });

  async function resetDatabase(): Promise<void> {
    await db.unsafe('drop schema if exists public cascade');
    await db.unsafe('create schema public');
  }

  async function hasRelationOn(executor: ReservedSqlExecutor, relation: string): Promise<boolean> {
    const rows = await executor.unsafe('select to_regclass($1::text) as relation', [relation]);
    return rows[0]?.relation !== null && rows[0]?.relation !== undefined;
  }

  async function hasRelation(relation: string): Promise<boolean> {
    return hasRelationOn(db, relation);
  }

  async function ledgerRowsOn(
    executor: ReservedSqlExecutor,
    lane: 'project' | 'docs'
  ): Promise<LedgerRow[]> {
    const rows = await executor.unsafe(
      'select lane, ordinal, name, checksum_sha256, record_kind, proof_digest ' +
        'from public.rag_schema_migrations where lane = $1 order by ordinal',
      [lane]
    );
    return rows.map((row) => ({
      lane,
      ordinal: Number(row.ordinal),
      name: String(row.name),
      checksumSha256: String(row.checksum_sha256),
      recordKind: String(row.record_kind) as LedgerRow['recordKind'],
      proofDigest: String(row.proof_digest),
    }));
  }

  async function expectExactLedgerOn(
    executor: ReservedSqlExecutor,
    lane: 'project' | 'docs',
    manifest: readonly LoadedMigration[],
    kinds: readonly LedgerRow['recordKind'][] = manifest.map(() => 'executed')
  ): Promise<void> {
    const rows = await ledgerRowsOn(executor, lane);
    expect(rows).toHaveLength(manifest.length);
    expect(rows.map((row) => row.ordinal)).toEqual(manifest.map((item) => item.descriptor.ordinal));
    expect(rows.map((row) => row.name)).toEqual(manifest.map((item) => item.descriptor.name));
    expect(rows.map((row) => row.checksumSha256)).toEqual(
      manifest.map((item) => item.checksumSha256)
    );
    expect(rows.map((row) => row.recordKind)).toEqual(kinds);
    expect(rows.map((row) => row.proofDigest)).toEqual(
      manifest.map((item, index) =>
        proofDigestFor({
          kind: kinds[index] ?? 'executed',
          lane,
          ordinal: item.descriptor.ordinal,
          name: item.descriptor.name,
          checksum: item.checksumSha256,
        })
      )
    );
  }

  async function expectExactLedger(
    lane: 'project' | 'docs',
    manifest: readonly LoadedMigration[],
    kinds: readonly LedgerRow['recordKind'][] = manifest.map(() => 'executed')
  ): Promise<void> {
    return expectExactLedgerOn(db, lane, manifest, kinds);
  }

  async function applyProjectFresh(): Promise<void> {
    await resetDatabase();
    const report = await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(report.executed.map((item) => item.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  }

  const PUBLICATION_RAW_MANIFEST_HASH = 'b'.repeat(64);
  const PUBLICATION_SOURCE_REVISION = 'c'.repeat(40);
  const PUBLICATION_UPSTREAM_PATH = 'docs';
  const PUBLICATION_PROFILE = {
    profileVersion: 1,
    cleaner: 'fixture-cleaner-v1',
    refiner: 'fixture-refiner-v1',
    chunker: 'docs-rag-canonical-chunker-v1',
    redaction: 'fixture-redaction-v1',
    normalization: 'fixture-normalization-v1',
    provider: 'llamacpp',
    model: 't04-fixture-model',
    dimensions: 1024,
    chunkSize: 1_200,
    chunkOverlap: 200,
    embeddingInputMaxChars: 2_000,
    sourceRevision: PUBLICATION_SOURCE_REVISION,
  };
  const PUBLICATION_IMPORT_PROFILE = {
    profileVersion: 1,
    cleaner: 'none',
    refiner: 'none',
    chunker: 'docs-rag-canonical-chunker-v1',
    redaction: 'none',
    normalization: 'none',
    provider: 'llamacpp',
    model: 't04-fixture-model',
    dimensions: 1024,
    chunkSize: 1_200,
    chunkOverlap: 200,
    embeddingInputMaxChars: 2_000,
  } satisfies DocsRagProcessingProfile;

  interface DocsPublicationFixture {
    readonly generationId: number;
    readonly documentId?: number;
    readonly chunkId?: number;
    readonly embeddingId?: number;
  }

  async function seedDocsPublicationFixture(input: {
    readonly sourceId: string;
    readonly generationKey: string;
    readonly expectedDocumentCount?: number;
    readonly includeDocument?: boolean;
    readonly provenanceClass?: 'revision_bound_external' | 'processed_external_import';
    readonly generationProfile?: Record<string, unknown>;
    readonly documentProfile?: Record<string, unknown>;
  }): Promise<DocsPublicationFixture> {
    const expectedDocumentCount = input.expectedDocumentCount ?? 1;
    const includeDocument = input.includeDocument ?? expectedDocumentCount > 0;
    const provenanceClass = input.provenanceClass ?? 'revision_bound_external';
    const isExternal = provenanceClass === 'revision_bound_external';
    const sourceRevision = isExternal ? PUBLICATION_SOURCE_REVISION : null;
    const generationProfile =
      input.generationProfile ?? (isExternal ? PUBLICATION_PROFILE : PUBLICATION_IMPORT_PROFILE);
    const documentProfile = input.documentProfile ?? generationProfile;
    const processingProfileHash = docsRagProcessingProfileHash(
      generationProfile as DocsRagProcessingProfile
    );
    const generationKey = buildDocsRagSourceGenerationKey({
      sourceId: input.sourceId,
      upstreamRevision: sourceRevision,
      rawManifestSha256: PUBLICATION_RAW_MANIFEST_HASH,
      processingProfileHash,
    });
    const generationRows = await db.unsafe(
      `insert into docs_source_generations
           (source_id, provenance_class, generation_key, upstream_revision, upstream_path,
            license, raw_manifest_sha256, processing_profile_hash,
            processing_profile, expected_document_count, indexed_document_count, scan_state, status)
       values ($1, $2, $3, $4, $5, 'NOASSERTION', $6, $7, $8::jsonb, $9, $9, 'pending', 'staging')
       returning id`,
      [
        input.sourceId,
        provenanceClass,
        generationKey,
        isExternal ? PUBLICATION_SOURCE_REVISION : null,
        isExternal ? PUBLICATION_UPSTREAM_PATH : null,
        PUBLICATION_RAW_MANIFEST_HASH,
        processingProfileHash,
        JSON.stringify(generationProfile),
        expectedDocumentCount,
      ]
    );
    const generationId = Number(generationRows[0]?.id);
    if (!Number.isSafeInteger(generationId) || generationId <= 0) {
      throw new Error('publication fixture generation insert returned no id');
    }
    if (!includeDocument) {
      return { generationId };
    }

    const content = `${input.sourceId} fixture body`;
    const searchableText = `${input.sourceId} fixture chunk`;
    const sourcePath = `ingest/processed/external/${input.sourceId}/${input.generationKey}.md`;
    const upstreamPath = isExternal
      ? `${PUBLICATION_UPSTREAM_PATH}/${input.generationKey}.md`
      : null;
    const canonicalUrl = isExternal
      ? `https://github.com/example/docs/blob/${PUBLICATION_SOURCE_REVISION}/${upstreamPath}`
      : null;
    const documentMetadata = isExternal
      ? {
          canonicalUrl,
          authority: 'fixture',
          license: 'NOASSERTION',
          sourceRevision: PUBLICATION_SOURCE_REVISION,
          syncedAt: '2026-01-01T00:00:00.000Z',
        }
      : { authority: 'fixture' };
    const contentHash = sha256Text(content);
    const documentRows = await db.unsafe(
      `insert into docs_documents
         (source_id, source_path, source_absolute_path, title, authority, canonical_url,
          content_hash, searchable_text, content, metadata, status, upstream_path,
          upstream_content_sha256, processed_path, processed_content_sha256,
          processing_profile_hash, processing_profile, generation_id)
       values ($1, $2, $3, $4, 'fixture', $5, $6, $7, $8, $9::jsonb, 'indexed', $10,
               case when $10::text is null then null else $6 end, $2, $11, $12, $13::jsonb, $14)
       returning id`,
      [
        input.sourceId,
        sourcePath,
        `/processed/${input.sourceId}/${input.generationKey}.md`,
        `${input.sourceId} fixture`,
        canonicalUrl,
        contentHash,
        searchableText,
        content,
        JSON.stringify(documentMetadata),
        upstreamPath,
        contentHash,
        processingProfileHash,
        JSON.stringify(documentProfile),
        generationId,
      ]
    );
    const documentId = Number(documentRows[0]?.id);
    const chunkRows = await db.unsafe(
      `insert into docs_chunks (document_id, chunk_index, heading, section, content, searchable_text, enabled)
       values ($1, 0, 'Fixture heading', 'Fixture section', $2, $3, true)
       returning id`,
      [documentId, searchableText, searchableText]
    );
    const chunkId = Number(chunkRows[0]?.id);
    const embeddingRows = await db.unsafe(
      `insert into docs_embeddings
         (chunk_id, embedding_kind, embedding_model, embedding_provider, embedding_dimensions,
          embedding, source_hash, embedding_input_text, embedding_input_sha256)
       values ($1, 'chunk', $2, $3, $4, $5::halfvec, $6, $7, $8)
       returning id`,
      [
        chunkId,
        PUBLICATION_PROFILE.model,
        PUBLICATION_PROFILE.provider,
        PUBLICATION_PROFILE.dimensions,
        TEST_VECTOR,
        sha256Text(`${contentHash}:0:${searchableText}`),
        searchableText,
        sha256Text(searchableText),
      ]
    );
    return {
      generationId,
      documentId,
      chunkId,
      embeddingId: Number(embeddingRows[0]?.id),
    };
  }

  async function publishDocsPublicationFixture(generationId: number): Promise<void> {
    await db.unsafe('begin');
    try {
      await db.unsafe(
        `update docs_source_generations
         set scan_state = 'complete', status = 'published', published_at = now()
         where id = $1`,
        [generationId]
      );
      await db.unsafe(
        `insert into docs_source_generation_pointers (source_id, generation_id, updated_at)
         select source_id, id, now()
         from docs_source_generations
         where id = $1
         on conflict (source_id) do update set
           generation_id = excluded.generation_id,
           updated_at = now()`,
        [generationId]
      );
      await db.unsafe('commit');
    } catch (error) {
      try {
        await db.unsafe('rollback');
      } catch {
        // Preserve the original publication error.
      }
      throw error;
    }
  }

  async function expectDocsPublicationFailure(
    code: string,
    label: string,
    mutate: (fixture: DocsPublicationFixture) => Promise<void>
  ): Promise<void> {
    const fixture = await seedDocsPublicationFixture({
      sourceId: `t04-${label}`,
      generationKey: `generation-${label}`,
    });
    await mutate(fixture);
    await expect(publishDocsPublicationFixture(fixture.generationId)).rejects.toThrow(code);
  }

  it('accepts complete nonlegacy and zero-document generations on a fresh Docs lane', async () => {
    await resetDatabase();
    const report = await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(report.executed.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5]);

    const complete = await seedDocsPublicationFixture({
      sourceId: 't04-complete',
      generationKey: 'generation-complete',
    });
    await publishDocsPublicationFixture(complete.generationId);

    const empty = await seedDocsPublicationFixture({
      sourceId: 't04-empty',
      generationKey: 'generation-empty',
      expectedDocumentCount: 0,
      includeDocument: false,
    });
    await publishDocsPublicationFixture(empty.generationId);

    const imported = await seedDocsPublicationFixture({
      sourceId: 't04-import',
      generationKey: 'generation-import',
      provenanceClass: 'processed_external_import',
    });
    await publishDocsPublicationFixture(imported.generationId);

    const pointers = await db.unsafe(
      `select source_id as "sourceId", generation_id as "generationId"
       from docs_source_generation_pointers
       where source_id in ('t04-complete', 't04-empty', 't04-import')
       order by source_id`
    );
    expect(pointers).toHaveLength(3);
    expect(pointers.map((row) => row.sourceId)).toEqual([
      't04-complete',
      't04-empty',
      't04-import',
    ]);

    const importedRows = await db.unsafe(
      `select g.provenance_class as "provenanceClass", g.upstream_revision as "upstreamRevision",
              g.upstream_path as "upstreamPath", g.license,
              d.canonical_url as "canonicalUrl", d.upstream_path as "documentUpstreamPath",
              d.metadata
       from docs_source_generations g
       join docs_documents d on d.generation_id = g.id
       where g.id = $1`,
      [imported.generationId]
    );
    expect(importedRows[0]).toMatchObject({
      provenanceClass: 'processed_external_import',
      upstreamRevision: null,
      upstreamPath: null,
      license: 'NOASSERTION',
      canonicalUrl: null,
      documentUpstreamPath: null,
      metadata: { authority: 'fixture' },
    });

    const probe = (await probeLane(db, 'docs')).find((item) => item.ordinal === 5);
    expect(probe?.passed).toBe(true);
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
    expect(probe?.artifacts.every((artifact) => artifact.present)).toBe(true);
  }, 30_000);

  it('rejects count, document, chunk, and embedding publication corruption', async () => {
    await resetDatabase();
    await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });

    await expectDocsPublicationFailure('COUNT_INVALID', 'count', async (fixture) => {
      await db.unsafe(
        `update docs_source_generations set indexed_document_count = 0 where id = $1`,
        [fixture.generationId]
      );
    });
    await expectDocsPublicationFailure('DOCUMENT_INVALID', 'document', async (fixture) => {
      await db.unsafe(`update docs_documents set processed_content_sha256 = $1 where id = $2`, [
        '0'.repeat(64),
        fixture.documentId,
      ]);
    });
    await expectDocsPublicationFailure('CHUNK_INVALID', 'chunk', async (fixture) => {
      await db.unsafe(`update docs_chunks set enabled = false where id = $1`, [fixture.chunkId]);
    });
    await expectDocsPublicationFailure('EMBEDDING_INVALID', 'embedding', async (fixture) => {
      await db.unsafe(`update docs_embeddings set embedding_input_sha256 = $1 where id = $2`, [
        '0'.repeat(64),
        fixture.embeddingId,
      ]);
    });
  }, 30_000);

  it('rejects partial profiles and incomplete or duplicated derived provenance', async () => {
    await resetDatabase();
    await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });

    await expectDocsPublicationFailure('DOCUMENT_INVALID', 'partial-profile', async (fixture) => {
      await db.unsafe(
        `update docs_source_generations
         set processing_profile = processing_profile - 'cleaner'
         where id = $1`,
        [fixture.generationId]
      );
    });
    await expectDocsPublicationFailure('DOCUMENT_INVALID', 'missing-canonical', async (fixture) => {
      await db.unsafe(`update docs_documents set canonical_url = null where id = $1`, [
        fixture.documentId,
      ]);
    });
    await expectDocsPublicationFailure('DOCUMENT_INVALID', 'missing-upstream', async (fixture) => {
      await db.unsafe(
        `update docs_documents
         set upstream_path = null, upstream_content_sha256 = null
         where id = $1`,
        [fixture.documentId]
      );
    });
    await expectDocsPublicationFailure('DOCUMENT_INVALID', 'missing-license', async (fixture) => {
      await db.unsafe(`update docs_source_generations set license = null where id = $1`, [
        fixture.generationId,
      ]);
    });
    await expectDocsPublicationFailure('DOCUMENT_INVALID', 'spoof-legacy', async (fixture) => {
      await db.unsafe(
        `update docs_source_generations
         set generation_key = 'legacy-' || md5(source_id), processing_profile_hash = 'legacy'
         where id = $1`,
        [fixture.generationId]
      );
    });
    await expectDocsPublicationFailure(
      'DOCUMENT_INVALID',
      'spoof-generation-key',
      async (fixture) => {
        await db.unsafe(`update docs_source_generations set generation_key = $1 where id = $2`, [
          'd'.repeat(64),
          fixture.generationId,
        ]);
      }
    );
    await expectDocsPublicationFailure('DOCUMENT_INVALID', 'profile-drift', async (fixture) => {
      await db.unsafe(
        `update docs_source_generations
         set processing_profile = jsonb_set(processing_profile, '{model}', '"t04-drifted-model"')
         where id = $1`,
        [fixture.generationId]
      );
    });
    await expectDocsPublicationFailure(
      'DOCUMENT_INVALID',
      'null-generation-provenance',
      async (fixture) => {
        await db.unsafe(
          `update docs_source_generations
         set upstream_revision = null, upstream_path = null
         where id = $1`,
          [fixture.generationId]
        );
      }
    );

    const importWithExternalFields = await seedDocsPublicationFixture({
      sourceId: 't04-import-with-external-fields',
      generationKey: 'generation-import-with-external-fields',
      provenanceClass: 'processed_external_import',
    });
    await db.unsafe(
      `update docs_source_generations
       set upstream_revision = $1, upstream_path = $2
       where id = $3`,
      [
        PUBLICATION_SOURCE_REVISION,
        PUBLICATION_UPSTREAM_PATH,
        importWithExternalFields.generationId,
      ]
    );
    await expect(
      publishDocsPublicationFixture(importWithExternalFields.generationId)
    ).rejects.toThrow('DOCUMENT_INVALID');

    const externalRelabeledImport = await seedDocsPublicationFixture({
      sourceId: 't04-external-relabeled-import',
      generationKey: 'generation-external-relabeled-import',
      provenanceClass: 'revision_bound_external',
    });
    await db.unsafe(
      `update docs_source_generations
       set provenance_class = 'processed_external_import'
       where id = $1`,
      [externalRelabeledImport.generationId]
    );
    await expect(
      publishDocsPublicationFixture(externalRelabeledImport.generationId)
    ).rejects.toThrow('DOCUMENT_INVALID');

    await expectDocsPublicationFailure('CHUNK_INVALID', 'disabled-extra-chunk', async (fixture) => {
      await db.unsafe(
        `insert into docs_chunks (document_id, chunk_index, content, searchable_text, enabled)
         values ($1, 1, 'disabled extra chunk', 'disabled extra chunk', false)`,
        [fixture.documentId]
      );
    });
    await expectDocsPublicationFailure(
      'EMBEDDING_INVALID',
      'mismatched-extra-embedding',
      async (fixture) => {
        await db.unsafe(
          `insert into docs_embeddings
             (chunk_id, embedding_kind, embedding_model, embedding_provider,
              embedding_dimensions, embedding, source_hash, embedding_input_text,
              embedding_input_sha256)
           values ($1, 'chunk', 't04-extra-model', $2, 1024, $3::halfvec, $4, $5, $6)`,
          [
            fixture.chunkId,
            PUBLICATION_PROFILE.provider,
            TEST_VECTOR,
            'd'.repeat(64),
            't04-mismatched-extra-embedding fixture chunk',
            sha256Text('t04-mismatched-extra-embedding fixture chunk'),
          ]
        );
      }
    );
  }, 30_000);

  it('detects an altered publication validator body through the adoption probe', async () => {
    await resetDatabase();
    await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });

    await db.unsafe(`
      create or replace function docs_rag_assert_generation_publishable(
        p_generation_id bigint,
        p_source_id text
      ) returns void
      language plpgsql
      as $$
      begin
        null;
      end;
      $$
    `);
    const probe = (await probeLane(db, 'docs')).find((item) => item.ordinal === 5);
    expect(probe?.passed).toBe(false);
    const exemptionArtifact = probe?.artifacts.find(
      (artifact) => artifact.id === 'table_legacy_generation_exemptions'
    );
    const fingerprintArtifact = probe?.artifacts.find(
      (artifact) => artifact.id === 'func_generation_publication_prosrc_digest'
    );
    expect(exemptionArtifact?.present).toBe(true);
    expect(fingerprintArtifact?.present).toBe(false);
  }, 30_000);

  it('uses the pinned prosrc digest rather than a mutable function comment', async () => {
    await resetDatabase();
    await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });

    await db.unsafe(
      `comment on function docs_rag_assert_generation_publishable(bigint, text)
       is 'tampered comment only'`
    );
    const commentOnlyProbe = (await probeLane(db, 'docs')).find((item) => item.ordinal === 5);
    expect(commentOnlyProbe?.passed).toBe(true);

    await db.unsafe(`
      create or replace function docs_rag_assert_generation_publishable(
        p_generation_id bigint,
        p_source_id text
      ) returns void
      language plpgsql
      as $$
      begin
        null;
      end;
      $$
    `);
    await db.unsafe(
      `comment on function docs_rag_assert_generation_publishable(bigint, text)
       is 'tampered body and comment'`
    );
    const bodyAndCommentProbe = (await probeLane(db, 'docs')).find((item) => item.ordinal === 5);
    expect(bodyAndCommentProbe?.passed).toBe(false);
  }, 30_000);

  it('aborts migration-004 upgrades with unclassifiable published rows', async () => {
    await resetDatabase();
    await db.unsafe(docsManifest[0].sqlText);
    await db.unsafe(docsManifest[1].sqlText);
    await db.unsafe(docsManifest[2].sqlText);
    await db.unsafe(docsManifest[3].sqlText);

    const fixtures = [
      { sourceId: 't04-legacy-profile-spoof', profile: '{"spoof":true}', revision: null, count: 1 },
      {
        sourceId: 't04-legacy-provenance-spoof',
        profile: '{}',
        revision: 'd'.repeat(40),
        count: 1,
      },
      { sourceId: 't04-legacy-empty-spoof', profile: '{}', revision: null, count: 0 },
    ] as const;
    for (const fixture of fixtures) {
      const generationRows = await db.unsafe(
        `insert into docs_source_generations
           (source_id, generation_key, upstream_revision, upstream_path,
            raw_manifest_sha256, processing_profile_hash, processing_profile,
            expected_document_count, indexed_document_count, scan_state, status)
         values ($1, 'legacy-' || md5($1), $2, $3, null, 'legacy', $4::jsonb,
                 $5, $5, 'pending', 'staging')
         returning id`,
        [
          fixture.sourceId,
          fixture.revision,
          fixture.revision === null ? null : 'docs',
          fixture.profile,
          fixture.count,
        ]
      );
      const generationId = Number(generationRows[0]?.id);
      if (fixture.count > 0) {
        await db.unsafe(
          `insert into docs_documents
             (source_id, source_path, title, content_hash, searchable_text, content,
              status, generation_id)
           values ($1, $2, $3, $4, $5, $5, 'indexed', $6)`,
          [
            fixture.sourceId,
            `ingest/processed/external/${fixture.sourceId}/legacy.md`,
            fixture.sourceId,
            sha256Text(`${fixture.sourceId}:content`),
            `${fixture.sourceId} body`,
            generationId,
          ]
        );
      }
      await db.unsafe('begin');
      try {
        await db.unsafe(
          `update docs_source_generations
           set scan_state = 'complete', status = 'published', published_at = now()
           where id = $1`,
          [generationId]
        );
        await db.unsafe(
          `insert into docs_source_generation_pointers (source_id, generation_id)
           values ($1, $2)`,
          [fixture.sourceId, generationId]
        );
        await db.unsafe('commit');
      } catch (error) {
        await db.unsafe('rollback').catch(() => {});
        throw error;
      }
    }

    const status = await runStatus({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
    });
    const challengeDigest = status.adoptionChallenge?.proofDigest;
    if (!challengeDigest)
      throw new Error('expected a Docs adoption challenge through migration 004');
    await runAdopt({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      challengeDigest,
      dryRun: false,
    });
    await expectRunnerError(
      runApply({
        db,
        lane: 'docs',
        manifest: docsManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      }),
      'MIGRATION_APPLY_FAILED'
    );
    expect(await hasRelation('docs_rag_legacy_generation_exemptions')).toBe(false);
  }, 30_000);

  it('keeps virgin status and dry-run strictly read-only with no ledger', async () => {
    await resetDatabase();

    const projectStatus = await runStatus({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
    });
    const docsStatus = await runStatus({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
    });
    expect(projectStatus.state).toEqual({ kind: 'fresh' });
    expect(docsStatus.state).toEqual({ kind: 'fresh' });

    await expect(
      runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: true,
      })
    ).resolves.toMatchObject({ executed: [] });
    await expect(
      runApply({
        db,
        lane: 'docs',
        manifest: docsManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: true,
      })
    ).resolves.toMatchObject({ executed: [] });

    await expect(hasRelation('public.rag_schema_migrations')).resolves.toBe(false);
    await expect(hasRelation('public.project_repositories')).resolves.toBe(false);
    await expect(hasRelation('public.docs_documents')).resolves.toBe(false);
  });

  it('applies fresh Project and Docs lanes with exact ledger rows and reruns as no-ops', async () => {
    await resetDatabase();

    const projectReport = await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    const docsReport = await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(projectReport.executed.map((item) => item.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(docsReport.executed.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(await hasRelation('project_ingest_snapshot_reviews_legacy_archive')).toBe(true);
    const freshArchiveRows = await db.unsafe(
      'select count(*)::integer as count from project_ingest_snapshot_reviews_legacy_archive'
    );
    expect(freshArchiveRows[0]?.count).toBe(0);
    const scopeIdentityProbe = (await probeLane(db, 'project')).find(
      (probe) => probe.ordinal === 11
    );
    expect(scopeIdentityProbe?.passed).toBe(true);
    await expectExactLedger('project', projectManifest);
    await expectExactLedger('docs', docsManifest);

    const projectRerun = await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    const docsRerun = await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(projectRerun.executed).toEqual([]);
    expect(docsRerun.executed).toEqual([]);
    await expectExactLedger('project', projectManifest);
    await expectExactLedger('docs', docsManifest);
  });

  it('repairs an adopted partial snapshot-review shape with migration 013', async () => {
    await resetDatabase();
    const legacyManifest = projectManifest.slice(0, 12);
    await runApply({
      db,
      lane: 'project',
      manifest: legacyManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });

    const repositoryRows = await db.unsafe(
      `insert into project_repositories (name, slug, root_path, normalized_root_path)
       values ('t03-review-repair', 't03-review-repair', '/tmp/t03-review-repair', '/tmp/t03-review-repair')
       returning id`
    );
    const repositoryId = Number(repositoryRows[0]?.id);

    const snapshotRows = await db.unsafe(
      `insert into project_ingest_snapshots (project_id, status, expires_at)
       values ($1, 'REVIEW_REQUIRED', now() - interval '1 hour')
       returning id, snapshot_uuid`,
      [repositoryId]
    );
    const snapshotId = Number(snapshotRows[0]?.id);
    const snapshotUuid = String(snapshotRows[0]?.snapshot_uuid);

    // Model a database adopted before the complete 005 shape was observed:
    // the operator field and decision table are absent. The legacy review is
    // expired and must be preserved without assigning reviewer_id as operator_id.
    await db.unsafe(
      `alter table project_ingest_snapshot_reviews
         drop constraint if exists project_ingest_snapshot_reviews_operator_id_check`
    );
    await db.unsafe(
      `alter table project_ingest_snapshot_reviews drop column operator_id;
       drop table project_ingest_snapshot_review_decisions`
    );
    const legacyReviewRows = await db.unsafe(
      `insert into project_ingest_snapshot_reviews
         (snapshot_id, snapshot_uuid, project_id, reviewer_id, reviewer_capability,
          evidence_id, reason, command_scope, token_digest, approved_at, expires_at)
       values ($1, $2, $3, 'legacy-reviewer', 'high-trust-write', 'legacy-evidence',
               'legacy review without attributable operator', 'project-ingest',
               'legacy-review-digest', now() - interval '2 hours', now() - interval '1 hour')
       returning id`,
      [snapshotId, snapshotUuid, repositoryId]
    );
    const legacyReviewId = Number(legacyReviewRows[0]?.id);

    const upgrade = await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(upgrade.executed).toEqual([
      { ordinal: 13, name: '013-snapshot-review-repair', recordKind: 'executed' },
    ]);

    const readinessRows = await db.unsafe(
      `
      select
        exists (select 1 from information_schema.columns
          where table_name = 'project_ingest_snapshot_reviews' and column_name = 'operator_id') as "reviewOperatorId",
        exists (select 1 from pg_constraint
          where conname = 'project_ingest_snapshot_reviews_one_per_snapshot') as "reviewUnique",
        exists (select 1 from pg_constraint
          where conname = 'project_ingest_snapshot_reviews_operator_id_check') as "reviewOperatorCheck",
        exists (select 1 from information_schema.tables
          where table_name = 'project_ingest_snapshot_reviews_legacy_archive') as "reviewArchiveTable",
        (select count(*)::integer from project_ingest_snapshot_reviews) as "activeReviewCount",
        (select count(*)::integer from project_ingest_snapshot_reviews_legacy_archive) as "archiveCount",
        (select snapshot_id from project_ingest_snapshot_reviews_legacy_archive
          where legacy_review_id = $2) as "archiveSnapshotId",
        (select snapshot_uuid from project_ingest_snapshot_reviews_legacy_archive
          where legacy_review_id = $2) as "archiveSnapshotUuid",
        (select project_id from project_ingest_snapshot_reviews_legacy_archive
          where legacy_review_id = $2) as "archiveProjectId",
        (select reviewer_id from project_ingest_snapshot_reviews_legacy_archive
          where legacy_review_id = $2) as "archiveReviewerId",
        (select operator_id from project_ingest_snapshot_reviews_legacy_archive
          where legacy_review_id = $2) as "archiveOperatorId",
        (select archive_reason from project_ingest_snapshot_reviews_legacy_archive
          where legacy_review_id = $2) as "archiveReason",
        exists (select 1 from information_schema.tables
          where table_name = 'project_ingest_snapshot_review_decisions') as "decisionsTable",
        (select count(*)::integer from project_repositories where id = $1) as "repositoryCount"
    `,
      [repositoryId, legacyReviewId]
    );
    expect(readinessRows[0]).toMatchObject({
      reviewOperatorId: true,
      reviewUnique: true,
      reviewOperatorCheck: true,
      reviewArchiveTable: true,
      activeReviewCount: 0,
      archiveCount: 1,
      archiveSnapshotUuid: snapshotUuid,
      archiveReviewerId: 'legacy-reviewer',
      archiveOperatorId: null,
      archiveReason: 'legacy_unattributed',
      decisionsTable: true,
      repositoryCount: 1,
    });
    expect(Number(readinessRows[0]?.archiveSnapshotId)).toBe(snapshotId);
    expect(Number(readinessRows[0]?.archiveProjectId)).toBe(repositoryId);
    const repairProbe = (await probeLane(db, 'project')).find((probe) => probe.ordinal === 13);
    expect(repairProbe?.passed).toBe(true);
    await expectExactLedger('project', projectManifest);

    const repairMigration = projectManifest.find(
      (migration) => migration.descriptor.ordinal === 13
    );
    if (!repairMigration) throw new Error('migration 013 fixture missing');
    await db.unsafe(repairMigration.sqlText);
    const replayRows = await db.unsafe(
      `select
         (select count(*)::integer from project_ingest_snapshot_reviews) as "activeReviewCount",
         (select count(*)::integer from project_ingest_snapshot_reviews_legacy_archive) as "archiveCount"`
    );
    expect(replayRows[0]).toMatchObject({ activeReviewCount: 0, archiveCount: 1 });
    await expect(
      db.unsafe(
        `update project_ingest_snapshot_reviews_legacy_archive
         set reason = 'tampered' where legacy_review_id = $1`,
        [legacyReviewId]
      )
    ).rejects.toThrow();
  }, 30_000);

  it('fails closed for an unattributed review that is not yet expired', async () => {
    await resetDatabase();
    const legacyManifest = projectManifest.slice(0, 12);
    await runApply({
      db,
      lane: 'project',
      manifest: legacyManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    const repositoryRows = await db.unsafe(
      `insert into project_repositories (name, slug, root_path, normalized_root_path)
       values ('t03-review-unexpired', 't03-review-unexpired', '/tmp/t03-review-unexpired', '/tmp/t03-review-unexpired')
       returning id`
    );
    const repositoryId = Number(repositoryRows[0]?.id);
    const snapshotRows = await db.unsafe(
      `insert into project_ingest_snapshots (project_id, status, expires_at)
       values ($1, 'REVIEW_REQUIRED', now() + interval '1 hour')
       returning id, snapshot_uuid`,
      [repositoryId]
    );
    await db.unsafe(
      `alter table project_ingest_snapshot_reviews
         drop constraint if exists project_ingest_snapshot_reviews_operator_id_check`
    );
    await db.unsafe('alter table project_ingest_snapshot_reviews drop column operator_id');
    await db.unsafe(
      `insert into project_ingest_snapshot_reviews
         (snapshot_id, snapshot_uuid, project_id, reviewer_id, reviewer_capability,
          evidence_id, reason, command_scope, token_digest, approved_at, expires_at)
       values ($1, $2, $3, 'legacy-reviewer', 'high-trust-write', 'legacy-evidence',
               'legacy review without attributable operator', 'project-ingest',
               'legacy-unexpired-digest', now() - interval '1 hour', now() + interval '1 hour')`,
      [Number(snapshotRows[0]?.id), String(snapshotRows[0]?.snapshot_uuid), repositoryId]
    );

    await expectRunnerError(
      runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      }),
      'MIGRATION_APPLY_FAILED'
    );
    expect(await hasRelation('project_ingest_snapshot_reviews_legacy_archive')).toBe(false);
    const residueRows = await db.unsafe(
      'select count(*)::integer as count from project_ingest_snapshot_reviews'
    );
    expect(residueRows[0]?.count).toBe(1);
    await expectExactLedger('project', legacyManifest);
  }, 30_000);

  it('fails closed for a decision row without an operator and does not archive it', async () => {
    await resetDatabase();
    const legacyManifest = projectManifest.slice(0, 12);
    await runApply({
      db,
      lane: 'project',
      manifest: legacyManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    const repositoryRows = await db.unsafe(
      `insert into project_repositories (name, slug, root_path, normalized_root_path)
       values ('t03-decision-repair', 't03-decision-repair', '/tmp/t03-decision-repair', '/tmp/t03-decision-repair')
       returning id`
    );
    const repositoryId = Number(repositoryRows[0]?.id);
    const snapshotRows = await db.unsafe(
      `insert into project_ingest_snapshots (project_id, status)
       values ($1, 'REVIEW_REQUIRED')
       returning id, snapshot_uuid`,
      [repositoryId]
    );
    await db.unsafe(
      `alter table project_ingest_snapshot_review_decisions
         drop constraint if exists project_ingest_snapshot_review_decisions_operator_id_check`
    );
    await db.unsafe('alter table project_ingest_snapshot_review_decisions drop column operator_id');
    await db.unsafe(
      `insert into project_ingest_snapshot_review_decisions
         (snapshot_id, snapshot_uuid, project_id, decision, reason)
       values ($1, $2, $3, 'REJECTED', 'legacy decision without attributable operator')`,
      [Number(snapshotRows[0]?.id), String(snapshotRows[0]?.snapshot_uuid), repositoryId]
    );

    await expectRunnerError(
      runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      }),
      'MIGRATION_APPLY_FAILED'
    );
    expect(await hasRelation('project_ingest_snapshot_reviews_legacy_archive')).toBe(false);
    const residueRows = await db.unsafe(
      'select count(*)::integer as count from project_ingest_snapshot_review_decisions'
    );
    expect(residueRows[0]?.count).toBe(1);
    await expectExactLedger('project', legacyManifest);
  }, 30_000);

  it('fails closed when a snapshot authorizes deletion without complete evidence', async () => {
    await resetDatabase();
    await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    const projectRows = await db.unsafe(
      `insert into project_repositories (name, slug, root_path, normalized_root_path)
       values ('t06-completeness', 't06-completeness', '/tmp/t06-completeness', '/tmp/t06-completeness')
       returning id`
    );
    const projectId = Number(projectRows[0]?.id);
    const evidenceHash = 'e'.repeat(64);

    await expect(
      db.unsafe(
        `insert into project_ingest_snapshots
           (project_id, completeness_status, completeness_evidence_hash, deletion_allowed)
         values ($1, 'incomplete', $2, true)`,
        [projectId, evidenceHash]
      )
    ).rejects.toThrow();

    await expect(
      db.unsafe(
        `insert into project_ingest_snapshots
           (project_id, completeness_status, deletion_allowed)
         values ($1, 'complete', true)`,
        [projectId]
      )
    ).rejects.toThrow();

    const accepted = await db.unsafe(
      `insert into project_ingest_snapshots
         (project_id, completeness_status, completeness_evidence_hash, deletion_allowed)
       values ($1, 'complete', $2, true)
       returning id`,
      [projectId, evidenceHash]
    );
    expect(accepted).toHaveLength(1);
  });

  it('applies Docs migrations 003 through 005 with truthful legacy backfill and complete probes', async () => {
    await resetDatabase();
    await db.unsafe(docsManifest[0].sqlText);
    await db.unsafe(docsManifest[1].sqlText);

    const documentRows = await db.unsafe(
      `insert into docs_documents
         (source_id, source_path, source_absolute_path, title, content_hash, searchable_text, content, metadata)
       values
         ('bun-docs', 'ingest/processed/external/bun-docs/legacy.md', '/tmp/processed/legacy.md',
          'Legacy', 'raw-hash', 'legacy searchable text', 'legacy body',
          '{"rawSourcePath":"bun-docs/legacy.md"}'::jsonb)
       returning id`
    );
    const documentId = Number(documentRows[0]?.id);
    const chunkRows = await db.unsafe(
      `insert into docs_chunks (document_id, chunk_index, content, searchable_text)
       values ($1, 0, 'legacy chunk', 'legacy searchable text') returning id`,
      [documentId]
    );
    await db.unsafe(
      `insert into docs_embeddings
         (chunk_id, embedding_kind, embedding_model, embedding_dimensions, embedding, source_hash)
       values ($1, 'chunk', 'legacy-model', 1024, $2::halfvec, 'legacy-source')`,
      [Number(chunkRows[0]?.id), TEST_VECTOR]
    );

    const status = await runStatus({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
    });
    const challengeDigest = status.adoptionChallenge?.proofDigest;
    if (!challengeDigest) {
      throw new Error('expected a Docs adoption challenge for the legacy prefix');
    }
    const adopted = await runAdopt({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      challengeDigest,
      dryRun: false,
    });
    expect(adopted.adopted.map((item) => item.ordinal)).toEqual([1, 2]);

    const upgraded = await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(upgraded.executed).toEqual([
      { ordinal: 3, name: '003-processing-provenance', recordKind: 'executed' },
      { ordinal: 4, name: '004-source-generations', recordKind: 'executed' },
      { ordinal: 5, name: '005-generation-publication-integrity', recordKind: 'executed' },
    ]);
    await expectExactLedger('docs', docsManifest, [
      'verified_adoption',
      'verified_adoption',
      'executed',
      'executed',
      'executed',
    ]);

    const provenanceRows = await db.unsafe(
      `select upstream_path as "upstreamPath",
              upstream_content_sha256 as "upstreamHash",
              processed_path as "processedPath",
              processed_content_sha256 as "processedHash"
       from docs_documents where id = $1`,
      [documentId]
    );
    expect(provenanceRows[0]).toMatchObject({
      upstreamPath: 'bun-docs/legacy.md',
      upstreamHash: null,
      processedPath: '/tmp/processed/legacy.md',
    });
    expect(String(provenanceRows[0]?.processedHash)).toMatch(/^[0-9a-f]{64}$/);

    const embeddingRows = await db.unsafe(
      `select embedding_input_text as "inputText", embedding_input_sha256 as "inputHash"
       from docs_embeddings where chunk_id = $1`,
      [Number(chunkRows[0]?.id)]
    );
    expect(embeddingRows[0]).toEqual({
      inputText: 'legacy searchable text',
      inputHash: sha256Text('legacy searchable text'),
    });
    const generationRows = await db.unsafe(
      `select source_id as "sourceId", generation_key as "generationKey",
              scan_state as "scanState", expected_document_count as "expectedCount",
              indexed_document_count as "indexedCount", status
       from docs_source_generations where source_id = 'bun-docs'`
    );
    expect(generationRows).toHaveLength(1);
    expect(generationRows[0]).toMatchObject({
      sourceId: 'bun-docs',
      generationKey: expect.stringMatching(/^legacy-[0-9a-f]{32}$/),
      scanState: 'complete',
      expectedCount: 1,
      indexedCount: 1,
      status: 'published',
    });
    const pointerRows = await db.unsafe(
      `select p.source_id as "sourceId", p.generation_id as "generationId",
              d.generation_id as "documentGenerationId"
       from docs_source_generation_pointers p
       join docs_documents d on d.source_id = p.source_id
       where p.source_id = 'bun-docs'`
    );
    expect(pointerRows).toHaveLength(1);
    expect(pointerRows[0]?.generationId).toBe(pointerRows[0]?.documentGenerationId);

    const exemptionRows = await db.unsafe(
      `select source_id as "sourceId", generation_id as "generationId",
              generation_key as "generationKey", processing_profile_hash as "profileHash",
              sealed_at as "sealedAt"
       from docs_rag_legacy_generation_exemptions
       where source_id = 'bun-docs'`
    );
    expect(exemptionRows).toHaveLength(1);
    expect(exemptionRows[0]).toMatchObject({
      sourceId: 'bun-docs',
      generationId: pointerRows[0]?.generationId,
      generationKey: expect.stringMatching(/^legacy-[0-9a-f]{32}$/),
      profileHash: 'legacy',
    });
    expect(exemptionRows[0]?.sealedAt).not.toBeNull();
    await expect(
      db.unsafe(`delete from docs_rag_legacy_generation_exemptions where source_id = 'bun-docs'`)
    ).rejects.toThrow(/sealed and immutable/iu);
    await expect(db.unsafe('truncate docs_rag_legacy_generation_exemptions')).rejects.toThrow(
      /sealed and immutable/iu
    );

    await expect(
      db.unsafe(
        `update docs_source_generations
         set upstream_revision = 'must-not-change'
         where source_id = 'bun-docs'`
      )
    ).rejects.toThrow(/published Docs RAG source generation/);

    for (const ordinal of [3, 4, 5]) {
      const probe = (await probeLane(db, 'docs')).find((item) => item.ordinal === ordinal);
      expect(probe?.passed).toBe(true);
      expect(probe?.artifacts.every((artifact) => artifact.present)).toBe(true);
    }
  });

  it('upgrades a migration-004 legacy pointer through 005 without losing searchability', async () => {
    await resetDatabase();
    await db.unsafe(docsManifest[0].sqlText);
    await db.unsafe(docsManifest[1].sqlText);

    const documentRows = await db.unsafe(
      `insert into docs_documents
         (source_id, source_path, source_absolute_path, title, content_hash, searchable_text, content, metadata)
       values
         ('bun-docs', 'ingest/processed/external/bun-docs/legacy-upgrade.md', '/tmp/legacy-upgrade.md',
          'Legacy Upgrade', 'legacy-hash', 'legacy upgrade searchable text', 'legacy upgrade body', '{}')
       returning id`
    );
    const documentId = Number(documentRows[0]?.id);
    const chunkRows = await db.unsafe(
      `insert into docs_chunks (document_id, chunk_index, content, searchable_text)
       values ($1, 0, 'legacy upgrade chunk', 'legacy upgrade searchable text') returning id`,
      [documentId]
    );
    await db.unsafe(
      `insert into docs_embeddings
         (chunk_id, embedding_kind, embedding_model, embedding_dimensions, embedding, source_hash)
       values ($1, 'chunk', 'legacy-model', 1024, $2::halfvec, 'legacy-source')`,
      [Number(chunkRows[0]?.id), TEST_VECTOR]
    );

    await db.unsafe(docsManifest[2].sqlText);
    await db.unsafe(docsManifest[3].sqlText);

    const status = await runStatus({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
    });
    expect(status.adoptionChallenge).toMatchObject({
      prefixOrdinal: 4,
      absentOrdinals: [5],
    });
    const challenge = status.adoptionChallenge;
    if (!challenge) {
      throw new Error('expected a migration-004 adoption challenge');
    }
    const adopted = await runAdopt({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      challengeDigest: challenge.proofDigest,
      dryRun: false,
    });
    expect(adopted.adopted.map((item) => item.ordinal)).toEqual([1, 2, 3, 4]);

    const upgraded = await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(upgraded.executed).toEqual([
      { ordinal: 5, name: '005-generation-publication-integrity', recordKind: 'executed' },
    ]);
    await expectExactLedger('docs', docsManifest, [
      'verified_adoption',
      'verified_adoption',
      'verified_adoption',
      'verified_adoption',
      'executed',
    ]);

    const legacyServingRows = await db.unsafe(
      `select p.generation_id as "generationId", g.provenance_class as "provenanceClass",
              d.generation_id as "documentGenerationId",
              d.search_vector::text as "documentSearchVector",
              c.search_vector::text as "chunkSearchVector"
       from docs_source_generation_pointers p
       join docs_source_generations g on g.id = p.generation_id
       join docs_documents d on d.generation_id = p.generation_id
       join docs_chunks c on c.document_id = d.id
       where p.source_id = 'bun-docs'`
    );
    expect(legacyServingRows).toHaveLength(1);
    expect(legacyServingRows[0]?.provenanceClass).toBe('processed_external_import');
    expect(legacyServingRows[0]?.generationId).toBe(legacyServingRows[0]?.documentGenerationId);
    expect(legacyServingRows[0]?.documentSearchVector).not.toBe('');
    expect(legacyServingRows[0]?.chunkSearchVector).not.toBe('');

    const searchRows = await db.unsafe(
      `select count(*)::integer as count
       from docs_source_generation_pointers p
       join docs_documents d on d.generation_id = p.generation_id
       where p.source_id = 'bun-docs'
         and d.search_vector @@ plainto_tsquery('simple', 'legacy upgrade searchable text')`
    );
    expect(Number(searchRows[0]?.count)).toBe(1);

    const legacyResultRows = await db.unsafe(
      `select d.source_id as "sourceId", d.source_path as "sourcePath", d.title,
              d.content, d.metadata, d.canonical_url as "canonicalUrl", d.authority,
              g.upstream_revision as "sourceRevision", g.generation_key as "generationKey",
              g.published_at as "publishedAt", c.content as "chunkContent",
              c.chunk_index as "chunkIndex"
       from docs_source_generation_pointers p
       join docs_source_generations g on g.id = p.generation_id
       join docs_documents d on d.generation_id = g.id
       join docs_chunks c on c.document_id = d.id
       where p.source_id = 'bun-docs'`
    );
    expect(legacyResultRows).toHaveLength(1);
    const legacyResultRow = legacyResultRows[0];
    if (!legacyResultRow) throw new Error('expected the serving legacy result row');
    const legacyResult = normalizeDocsRagLabSearchResult({
      sourceId: String(legacyResultRow.sourceId),
      sourcePath: String(legacyResultRow.sourcePath),
      title: String(legacyResultRow.title),
      content: String(legacyResultRow.chunkContent ?? legacyResultRow.content ?? ''),
      chunkIndex: Number(legacyResultRow.chunkIndex ?? 0),
      score: 1,
      metadata: legacyResultRow.metadata,
      canonicalUrl: null,
      sourceRevision: null,
      generationKey: String(legacyResultRow.generationKey),
    });
    expect(legacyResult).toMatchObject({
      canonicalUrl: null,
      sourceRevision: null,
      syncedAt: null,
      provenanceStatus: 'degraded',
    });
    expect(legacyResult.missingFields).toContain('syncedAt');

    const malformed = await seedDocsPublicationFixture({
      sourceId: 'bun-docs',
      generationKey: 'generation-new-malformed',
    });
    await db.unsafe(
      `update docs_source_generations set processing_profile = '{}'::jsonb where id = $1`,
      [malformed.generationId]
    );
    await expect(publishDocsPublicationFixture(malformed.generationId)).rejects.toThrow(
      'DOCUMENT_INVALID'
    );

    const pointerAfterFailure = await db.unsafe(
      `select generation_id as "generationId"
       from docs_source_generation_pointers where source_id = 'bun-docs'`
    );
    expect(pointerAfterFailure[0]?.generationId).toBe(legacyServingRows[0]?.generationId);

    const probe = (await probeLane(db, 'docs')).find((item) => item.ordinal === 5);
    expect(probe?.passed).toBe(true);
    expect(probe?.artifacts.every((artifact) => artifact.present)).toBe(true);
  }, 30_000);

  it('upgrades a Project ledger from 008 through the ordered 009, 010, 011, and 012 migrations', async () => {
    await resetDatabase();
    const legacyProjectManifest = projectManifest.slice(0, 8);
    const legacyReport = await runApply({
      db,
      lane: 'project',
      manifest: legacyProjectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(legacyReport.executed.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const upgrade = await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(upgrade.executed).toEqual([
      { ordinal: 9, name: '009-sync-run-binding', recordKind: 'executed' },
      { ordinal: 10, name: '010-version-owned-derived-data', recordKind: 'executed' },
      { ordinal: 11, name: '011-scope-identity-completeness', recordKind: 'executed' },
      { ordinal: 12, name: '012-durable-job-lifecycle', recordKind: 'executed' },
      { ordinal: 13, name: '013-snapshot-review-repair', recordKind: 'executed' },
    ]);
    await expectExactLedger('project', projectManifest);
  });

  it('rolls back migration 012 after a mid-script failure and retries cleanly', async () => {
    await resetDatabase();
    const prefixManifest = projectManifest.slice(0, 11);
    await runApply({
      db,
      lane: 'project',
      manifest: prefixManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });

    const jobRows = await db.unsafe(
      `insert into project_jobs (type, attempts, max_attempts)
       values ('t03-mid-migration-failure', -1, 3) returning id`
    );
    const jobId = Number(jobRows[0]?.id);
    expect(jobId).toBeGreaterThan(0);

    const applyInput = {
      db,
      lane: 'project' as const,
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    };
    await expectRunnerError(runApply(applyInput), 'MIGRATION_APPLY_FAILED');

    // The invalid attempts row fails after 012 has already added columns and
    // replaced the status check.  The explicit script transaction plus the
    // runner's rollback must leave all of those earlier DDL statements absent.
    const residue = await db.unsafe(`
      select
        exists (select 1 from information_schema.columns where table_name = 'project_jobs' and column_name = 'available_at') as "availableAt",
        exists (select 1 from information_schema.columns where table_name = 'project_jobs' and column_name = 'cancel_requested_at') as "cancelRequestedAt",
        exists (select 1 from pg_constraint where conrelid = 'project_jobs'::regclass and conname = 'project_jobs_attempts_nonnegative') as "attemptsConstraint",
        (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'project_jobs'::regclass and conname = 'project_jobs_status_check') as "statusDefinition",
        (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'project_jobs_claim_idx') as "claimIndexDefinition"
    `);
    expect(residue[0]).toMatchObject({
      availableAt: false,
      cancelRequestedAt: false,
      attemptsConstraint: false,
    });
    expect(String(residue[0]?.statusDefinition)).not.toContain('blocked-review');
    expect(String(residue[0]?.claimIndexDefinition)).toContain('created_at');
    expect(String(residue[0]?.claimIndexDefinition)).not.toContain('available_at');
    await expectExactLedgerOn(db, 'project', prefixManifest);

    await db.unsafe('update project_jobs set attempts = 0 where id = $1', [jobId]);
    const retried = await runApply(applyInput);
    expect(retried.executed).toEqual([
      { ordinal: 12, name: '012-durable-job-lifecycle', recordKind: 'executed' },
      { ordinal: 13, name: '013-snapshot-review-repair', recordKind: 'executed' },
    ]);
    await expectExactLedger('project', projectManifest);

    // Direct replay proves migration 012 itself is idempotent, independently
    // of the ledger's no-op behavior on a completed run.
    await expect(db.unsafe(projectManifest[11].sqlText)).resolves.toBeDefined();
    const ready = await db.unsafe(`
      select
        exists (select 1 from information_schema.columns where table_name = 'project_jobs' and column_name = 'available_at') as "availableAt",
        exists (select 1 from pg_constraint where conrelid = 'project_jobs'::regclass and conname = 'project_jobs_attempts_nonnegative') as "attemptsConstraint",
        (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'project_jobs_claim_idx') as "claimIndexDefinition"
    `);
    expect(ready[0]).toMatchObject({ availableAt: true, attemptsConstraint: true });
    expect(String(ready[0]?.claimIndexDefinition)).toContain('available_at');
    await expect(runApply(applyInput)).resolves.toMatchObject({ executed: [] });
  });

  it('upgrades a Project ledger stopped at 009 through version-owned data, scope identity, and durable job lifecycle migrations', async () => {
    await resetDatabase();
    const legacyProjectManifest = projectManifest.slice(0, 9);
    const legacyReport = await runApply({
      db,
      lane: 'project',
      manifest: legacyProjectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(legacyReport.executed.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expect(hasRelation('public.project_embeddings_1024_profile_hash_idx')).resolves.toBe(
      false
    );

    const upgrade = await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(upgrade.executed).toEqual([
      { ordinal: 10, name: '010-version-owned-derived-data', recordKind: 'executed' },
      { ordinal: 11, name: '011-scope-identity-completeness', recordKind: 'executed' },
      { ordinal: 12, name: '012-durable-job-lifecycle', recordKind: 'executed' },
      { ordinal: 13, name: '013-snapshot-review-repair', recordKind: 'executed' },
    ]);
    await expectExactLedger('project', projectManifest);

    // Strong postconditions from the ordinal-10 probe set must hold for real.
    // Aliases are quoted camelCase because Bun.SQL preserves raw column
    // identifiers; unquoted snake_case would not match the keys below.
    const probeRows = await db.unsafe(`
      select
        exists (select 1 from pg_constraint where conname = 'project_chunks_id_project_unique') as "chunksUnique",
        exists (select 1 from pg_constraint where conname = 'project_file_versions_id_file_project_unique') as "versionsTripleUnique",
        exists (select 1 from pg_constraint where conname = 'project_chunks_version_file_project_fk') as "chunksVersionFk",
        exists (select 1 from pg_constraint where conname = 'project_index_build_files_version_file_project_fk') as "buildFilesVersionFk",
        exists (select 1 from pg_trigger where tgname = 'project_chunks_candidate_immutable_guard' and tgrelid = 'project_chunks'::regclass and not tgisinternal) as "chunksGuard",
        exists (select 1 from pg_trigger where tgname = 'project_file_versions_lifecycle_transitions' and tgrelid = 'project_file_versions'::regclass and not tgisinternal) as "lifecycleGuard",
        exists (select 1 from information_schema.columns where table_name = 'project_embeddings_1024' and column_name = 'embedding_profile_hash') as "profileColumn"
    `);
    expect(probeRows[0]).toMatchObject({
      chunksUnique: true,
      versionsTripleUnique: true,
      chunksVersionFk: true,
      buildFilesVersionFk: true,
      chunksGuard: true,
      lifecycleGuard: true,
      profileColumn: true,
    });
  });

  it('backfills canonical and legacy embedding identities and proves migration-010 probes', async () => {
    await resetDatabase();
    const legacyProjectManifest = projectManifest.slice(0, 9);
    await runApply({
      db,
      lane: 'project',
      manifest: legacyProjectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });

    const projectRows = await db.unsafe(
      `insert into project_repositories (name, slug, root_path, normalized_root_path)
       values ('t05-profile-backfill', 't05-profile-backfill', '/tmp/t05-profile-backfill', '/tmp/t05-profile-backfill')
       returning id`
    );
    const projectId = Number(projectRows[0]?.id);
    const fileRows = await db.unsafe(
      `insert into project_files (project_id, source_path, absolute_path, content_hash, file_modified_at)
       values ($1, 'src/profile.ts', '/tmp/t05-profile-backfill/src/profile.ts', 'profile-hash', 1)
       returning id`,
      [projectId]
    );
    const fileId = Number(fileRows[0]?.id);
    const versionRows = await db.unsafe(
      `insert into project_file_versions (project_id, file_id, status, content_hash, file_modified_at)
       values ($1, $2, 'pending', 'profile-hash', 1)
       returning id`,
      [projectId, fileId]
    );
    const versionId = Number(versionRows[0]?.id);
    const canonicalChunkRows = await db.unsafe(
      `insert into project_chunks (project_id, file_id, version_id, chunk_index, content, searchable_text)
       values ($1, $2, $3, 0, 'canonical legacy fixture', 'canonical legacy fixture')
       returning id`,
      [projectId, fileId, versionId]
    );
    const legacyChunkRows = await db.unsafe(
      `insert into project_chunks (project_id, file_id, version_id, chunk_index, content, searchable_text)
       values ($1, $2, $3, 1, 'foreign legacy fixture', 'foreign legacy fixture')
       returning id`,
      [projectId, fileId, versionId]
    );
    const canonicalChunkId = Number(canonicalChunkRows[0]?.id);
    const legacyChunkId = Number(legacyChunkRows[0]?.id);
    // Legacy-shaped rows exactly as the pre-T-05 writer produced them: no
    // file_id on chunk owners, version derived from the parent chunk.
    // Migration 010 must derive the missing file bindings and upgrade in place.
    await db.unsafe(
      `insert into project_embeddings_1024
         (project_id, owner_type, owner_ref, chunk_id, embedding_model, embedding_provider, dimensions, embedding, source_hash, version_id)
       values ($1, 'chunk', $2, $3, 'qwen3-embedding-1024', null, 1024, $4::halfvec, 'canonical-source', $5),
              ($1, 'chunk', $6, $7, 'legacy-model', 'foreign-provider', 1024, $4::halfvec, 'legacy-source', $5)`,
      [
        projectId,
        String(canonicalChunkId),
        canonicalChunkId,
        TEST_VECTOR,
        versionId,
        String(legacyChunkId),
        legacyChunkId,
      ]
    );

    const upgrade = await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(upgrade.executed).toEqual([
      { ordinal: 10, name: '010-version-owned-derived-data', recordKind: 'executed' },
      { ordinal: 11, name: '011-scope-identity-completeness', recordKind: 'executed' },
      { ordinal: 12, name: '012-durable-job-lifecycle', recordKind: 'executed' },
      { ordinal: 13, name: '013-snapshot-review-repair', recordKind: 'executed' },
    ]);

    const identityRows = await db.unsafe(
      `select owner_ref as "ownerRef", embedding_profile_hash as "profileHash"
       from project_embeddings_1024 where project_id = $1 order by owner_ref::bigint`,
      [projectId]
    );
    expect(
      identityRows.map((row) => ({ ownerRef: row.ownerRef, profileHash: row.profileHash }))
    ).toEqual([
      {
        ownerRef: String(canonicalChunkId),
        profileHash: PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
      },
      { ownerRef: String(legacyChunkId), profileHash: 'legacy_unknown' },
    ]);

    const schemaRows = await db.unsafe(`
      select
        (select is_nullable = 'NO' from information_schema.columns
         where table_name = 'project_embeddings_1024' and column_name = 'embedding_profile_hash') as "profileNotNull",
        (select pg_get_constraintdef(oid) from pg_constraint
         where conname = 'project_embeddings_1024_profile_owner_unique') as "profileUnique",
        exists (select 1 from pg_constraint where conname = 'project_embeddings_1024_owner_unique') as "legacyUnique",
        exists (select 1 from pg_trigger where tgname = 'project_embeddings_1024_binding_immutable_guard'
          and tgrelid = 'project_embeddings_1024'::regclass and not tgisinternal) as "immutableTrigger",
        exists (select 1 from pg_trigger where tgname = 'project_embeddings_1024_touch_updated_at'
          and tgrelid = 'project_embeddings_1024'::regclass and not tgisinternal) as "touchTrigger"
    `);
    expect(schemaRows[0]).toMatchObject({
      profileNotNull: true,
      profileUnique: 'UNIQUE (project_id, owner_type, owner_ref, embedding_profile_hash)',
      legacyUnique: false,
      immutableTrigger: true,
      touchTrigger: false,
    });

    const migrationProbe = (await probeLane(db, 'project')).find((probe) => probe.ordinal === 10);
    expect(migrationProbe?.passed).toBe(true);
    expect(migrationProbe?.artifacts.every((artifact) => artifact.present)).toBe(true);

    await expect(
      db.unsafe(
        `insert into project_embeddings_1024
           (project_id, owner_type, owner_ref, file_id, chunk_id, embedding_model, dimensions, embedding, embedding_profile_hash, version_id)
         values ($1, 'chunk', 'null-profile', $2, $3, 'qwen3-embedding-1024', 1024, $4::halfvec, null, $5)`,
        [projectId, fileId, canonicalChunkId, TEST_VECTOR, versionId]
      )
    ).rejects.toThrow(/not-null|null value/iu);

    await expect(
      db.unsafe(
        `insert into project_embeddings_1024
           (project_id, owner_type, owner_ref, file_id, chunk_id, embedding_model, embedding_provider, dimensions, embedding, source_hash, embedding_profile_hash, version_id)
         values ($1, 'chunk', $2, $3, $4, 'qwen3-embedding-1024', 'llamacpp', 1024, $5::halfvec, 'duplicate', $6, $7)`,
        [
          projectId,
          String(canonicalChunkId),
          fileId,
          canonicalChunkId,
          TEST_VECTOR,
          PROJECT_RAG_POSTGRES_EMBEDDING_PROFILE_HASH,
          versionId,
        ]
      )
    ).rejects.toThrow(/duplicate key|unique/iu);

    await expect(
      db.unsafe(
        `update project_embeddings_1024 set source_hash = 'mutated'
         where project_id = $1 and owner_ref = $2`,
        [projectId, String(canonicalChunkId)]
      )
    ).rejects.toThrow(/immutable/iu);
  });

  it('aborts migration 010 without partial state when derived ownership is ambiguous', async () => {
    await resetDatabase();
    const legacyProjectManifest = projectManifest.slice(0, 9);
    const legacyReport = await runApply({
      db,
      lane: 'project',
      manifest: legacyProjectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(legacyReport.executed.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Two projects; derived rows whose project/file/version ownership is
    // ambiguous are exactly what migration 010 must refuse.
    const projects = await db.unsafe(
      `insert into project_repositories (name, slug, root_path, normalized_root_path)
       values ('t05-a', 't05-a', '/tmp/t05-a', '/tmp/t05-a'),
              ('t05-b', 't05-b', '/tmp/t05-b', '/tmp/t05-b')
       returning id`
    );
    const projectA = Number(projects[0]?.id);
    const projectB = Number(projects[1]?.id);
    expect(projectA).toBeGreaterThan(0);
    expect(projectB).toBeGreaterThan(0);

    const fileRow = await db.unsafe(
      `insert into project_files (project_id, source_path, absolute_path, content_hash, file_modified_at)
       values ($1, 'src/ambiguous.ts', '/tmp/t05-a/src/ambiguous.ts', 'hash-ambiguous', 1) returning id`,
      [projectA]
    );
    const fileId = Number(fileRow[0]?.id);
    const versionRow = await db.unsafe(
      `insert into project_file_versions (project_id, file_id, status, content_hash, file_modified_at)
       values ($1, $2, 'pending', 'hash-ambiguous', 1) returning id`,
      [projectA, fileId]
    );
    const versionId = Number(versionRow[0]?.id);

    const ambiguousChunkRows = await db.unsafe(
      `insert into project_chunks (project_id, file_id, version_id, chunk_index, content)
       values ($1, $2, $3, 0, 'ambiguous ownership payload') returning id`,
      [projectB, fileId, versionId]
    );
    const ambiguousChunkId = Number(ambiguousChunkRows[0]?.id);

    let failureMessage = '';
    try {
      await runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      });
      throw new Error('expected the ambiguous-ownership upgrade to fail closed');
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }
    expect(failureMessage).toContain('MIGRATION_AMBIGUOUS_OWNERSHIP');

    // The whole script owns one transaction: nothing leaked through. The
    // ledger stays at 9 and none of the ordinal-10 schema exists.
    await expectExactLedgerOn(db, 'project', projectManifest.slice(0, 9));
    const residue = await db.unsafe(`
      select
        exists (select 1 from information_schema.columns where table_name = 'project_embeddings_1024' and column_name = 'embedding_profile_hash') as "profileColumn",
        exists (select 1 from pg_constraint where conname = 'project_chunks_id_project_unique') as "chunksUnique",
        exists (select 1 from pg_trigger where tgname = 'project_chunks_candidate_immutable_guard' and not tgisinternal) as "chunksGuard"
    `);
    expect(residue[0]).toMatchObject({
      profileColumn: false,
      chunksUnique: false,
      chunksGuard: false,
    });

    // Repair the chunk ambiguity without deletion or guessing. The next
    // attempt must then reach the symbol preflight.
    await db.unsafe('update project_chunks set project_id = $1 where project_id = $2', [
      projectA,
      projectB,
    ]);
    const fileBRows = await db.unsafe(
      `insert into project_files (project_id, source_path, absolute_path, content_hash, file_modified_at)
       values ($1, 'src/second.ts', '/tmp/t05-a/src/second.ts', 'hash-second', 1) returning id`,
      [projectA]
    );
    const fileB = Number(fileBRows[0]?.id);
    const versionBRows = await db.unsafe(
      `insert into project_file_versions (project_id, file_id, status, content_hash, file_modified_at)
       values ($1, $2, 'pending', 'hash-second', 1) returning id`,
      [projectA, fileB]
    );
    const versionB = Number(versionBRows[0]?.id);
    const chunkBRows = await db.unsafe(
      `insert into project_chunks (project_id, file_id, version_id, chunk_index, content)
       values ($1, $2, $3, 0, 'second-version payload') returning id`,
      [projectA, fileB, versionB]
    );
    const chunkB = Number(chunkBRows[0]?.id);
    const symbolRows = await db.unsafe(
      `insert into project_symbols
         (project_id, file_id, version_id, chunk_id, name, symbol_type)
       values ($1, $2, $3, $4, 'ambiguousSymbol', 'function') returning id`,
      [projectA, fileId, versionId, chunkB]
    );
    const symbolId = Number(symbolRows[0]?.id);
    // Legacy-shaped row (no file binding): the stale version binding plus the
    // missing file agreement are exactly the embedding ambiguity migration
    // 010 must refuse.
    await db.unsafe(
      `insert into project_embeddings_1024
         (project_id, owner_type, owner_ref, chunk_id, version_id,
          embedding_model, embedding_provider, dimensions, embedding, source_hash)
       values ($1, 'chunk', $2, $3, $4, 'qwen3-embedding-1024', 'llamacpp', 1024,
               $5::halfvec, 'ambiguous-embedding')`,
      [projectA, String(chunkB), chunkB, versionId, TEST_VECTOR]
    );

    let symbolFailure = '';
    try {
      await runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      });
      throw new Error('expected the ambiguous symbol upgrade to fail closed');
    } catch (error) {
      symbolFailure = error instanceof Error ? error.message : String(error);
    }
    expect(symbolFailure).toContain('MIGRATION_AMBIGUOUS_OWNERSHIP');
    await expectExactLedgerOn(db, 'project', projectManifest.slice(0, 9));

    await db.unsafe('update project_symbols set chunk_id = $1 where id = $2', [
      ambiguousChunkId,
      symbolId,
    ]);
    let embeddingFailure = '';
    try {
      await runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      });
      throw new Error('expected the ambiguous embedding upgrade to fail closed');
    } catch (error) {
      embeddingFailure = error instanceof Error ? error.message : String(error);
    }
    expect(embeddingFailure).toContain('MIGRATION_AMBIGUOUS_OWNERSHIP');
    await expectExactLedgerOn(db, 'project', projectManifest.slice(0, 9));

    await db.unsafe('update project_embeddings_1024 set version_id = $1 where chunk_id = $2', [
      versionB,
      chunkB,
    ]);
    const repaired = await runApply({
      db,
      lane: 'project',
      manifest: projectManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(repaired.executed).toEqual([
      { ordinal: 10, name: '010-version-owned-derived-data', recordKind: 'executed' },
      { ordinal: 11, name: '011-scope-identity-completeness', recordKind: 'executed' },
      { ordinal: 12, name: '012-durable-job-lifecycle', recordKind: 'executed' },
      { ordinal: 13, name: '013-snapshot-review-repair', recordKind: 'executed' },
    ]);
    await expectExactLedger('project', projectManifest);
  });

  it('fails closed for checksum drift without running a script', async () => {
    await applyProjectFresh();
    const replacementChecksum = sha256Text('integration-drift');
    const replacementProof = proofDigestFor({
      kind: 'executed',
      lane: 'project',
      ordinal: 1,
      name: projectManifest[0].descriptor.name,
      checksum: replacementChecksum,
    });
    await db.unsafe(
      'update public.rag_schema_migrations set checksum_sha256 = $1, proof_digest = $2 ' +
        'where lane = $3 and ordinal = $4',
      [replacementChecksum, replacementProof, 'project', 1]
    );
    await expectRunnerError(
      runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      }),
      'MIGRATION_CHECKSUM_DRIFT'
    );
  });

  it('fails closed for gaps, unknown rows, bad kinds, and proof mismatches', async () => {
    await applyProjectFresh();
    await db.unsafe(
      "delete from public.rag_schema_migrations where lane = 'project' and ordinal = 1"
    );
    await expectRunnerError(
      runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      }),
      'MIGRATION_LEDGER_GAP'
    );

    await applyProjectFresh();
    await db.unsafe(
      'insert into public.rag_schema_migrations ' +
        '(lane, ordinal, name, checksum_sha256, record_kind, proof_digest) ' +
        "values ('project', 99, 'unknown', 'unknown', 'executed', 'unknown')"
    );
    await expectRunnerError(
      runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      }),
      'MIGRATION_LEDGER_UNKNOWN_ROW'
    );

    await applyProjectFresh();
    await db.unsafe(
      'alter table public.rag_schema_migrations drop constraint rag_schema_migrations_record_kind_check'
    );
    await db.unsafe(
      "update public.rag_schema_migrations set record_kind = 'corrupt' " +
        "where lane = 'project' and ordinal = 1"
    );
    await expectRunnerError(
      runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      }),
      'MIGRATION_LEDGER_INVALID'
    );

    await applyProjectFresh();
    await db.unsafe(
      "update public.rag_schema_migrations set proof_digest = 'forged' " +
        "where lane = 'project' and ordinal = 1"
    );
    await expectRunnerError(
      runApply({
        db,
        lane: 'project',
        manifest: projectManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        dryRun: false,
      }),
      'MIGRATION_LEDGER_INVALID'
    );
  });

  it('requires a current verified adoption challenge and refuses unproven legacy state', async () => {
    await resetDatabase();
    await db.unsafe(docsManifest[0].sqlText);

    const status = await runStatus({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
    });
    expect(status.state).toEqual({ kind: 'adoption_required' });
    expect(status.adoptionChallenge).toMatchObject({
      prefixOrdinal: 1,
      absentOrdinals: [2, 3, 4, 5],
    });
    const challenge = status.adoptionChallenge;
    if (!challenge) {
      throw new Error('expected adoption challenge');
    }

    await expectRunnerError(
      runAdopt({
        db,
        lane: 'docs',
        manifest: docsManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        challengeDigest: sha256Text('wrong-challenge'),
        dryRun: false,
      }),
      'MIGRATION_CHALLENGE_MISMATCH'
    );
    await expect(hasRelation('public.rag_schema_migrations')).resolves.toBe(false);

    const adopted = await runAdopt({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      challengeDigest: challenge.proofDigest,
      dryRun: false,
    });
    expect(adopted.adopted).toEqual([
      { ordinal: 1, name: '001-core', recordKind: 'verified_adoption' },
    ]);
    await expectExactLedger('docs', docsManifest.slice(0, 1), ['verified_adoption']);

    const upgraded = await runApply({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      dryRun: false,
    });
    expect(upgraded.executed).toEqual([
      { ordinal: 2, name: '002-eval', recordKind: 'executed' },
      { ordinal: 3, name: '003-processing-provenance', recordKind: 'executed' },
      { ordinal: 4, name: '004-source-generations', recordKind: 'executed' },
      { ordinal: 5, name: '005-generation-publication-integrity', recordKind: 'executed' },
    ]);
    await expectExactLedger('docs', docsManifest, [
      'verified_adoption',
      'executed',
      'executed',
      'executed',
      'executed',
    ]);

    await resetDatabase();
    await db.unsafe(docsManifest[0].sqlText);
    await db.unsafe('drop function public.docs_rag_refresh_chunk_search() cascade');
    const unproven = await runStatus({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
    });
    expect(unproven.state).toEqual({ kind: 'adoption_required' });
    expect(unproven.adoptionChallenge).toBeUndefined();
    await expectRunnerError(
      runAdopt({
        db,
        lane: 'docs',
        manifest: docsManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
        challengeDigest: 'anything',
        dryRun: false,
      }),
      'MIGRATION_ADOPTION_UNSUPPORTED'
    );
    await expect(hasRelation('public.rag_schema_migrations')).resolves.toBe(false);
  });

  it('rolls back the whole adoption prefix on a real mid-prefix ledger fault and recovers', async () => {
    await resetDatabase();
    // Legacy database: every docs manifest migration was hand-applied before
    // any ledger existed, so adoption must prove the full contiguous prefix.
    await db.unsafe(docsManifest[0].sqlText);
    await db.unsafe(docsManifest[1].sqlText);
    await db.unsafe(docsManifest[2].sqlText);
    await db.unsafe(docsManifest[3].sqlText);
    await db.unsafe(docsManifest[4].sqlText);

    // Pre-create the runner-owned ledger and install a temporary fault
    // trigger that rejects every ledger insert at ordinal >= 2.
    await ensureLedgerTable(db);
    await db.unsafe(
      'create function public.rag_t03_ledger_fault() returns trigger as $fault$ ' +
        'begin ' +
        'if new.ordinal >= 2 then ' +
        "raise exception 't03 induced ledger fault' using errcode = '23505'; " +
        'end if; ' +
        'return new; ' +
        'end; ' +
        '$fault$ language plpgsql'
    );
    await db.unsafe(
      'create trigger rag_t03_ledger_fault_trigger ' +
        'before insert on public.rag_schema_migrations ' +
        'for each row execute function public.rag_t03_ledger_fault()'
    );

    const status = await runStatus({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
    });
    const digest = status.adoptionChallenge?.proofDigest;
    if (!digest) {
      throw new Error('expected a supported adoption challenge');
    }

    try {
      await expectRunnerError(
        runAdopt({
          db,
          lane: 'docs',
          manifest: docsManifest,
          redactedUrl: REDACTED_TARGET,
          targetFingerprint: TARGET_FINGERPRINT,
          challengeDigest: digest,
          dryRun: false,
        }),
        'MIGRATION_APPLY_FAILED'
      );
      // Real-Postgres rollback proof: the aborted adoption must leave zero
      // prefix rows — not even the ordinal-1 insert that preceded the fault.
      await expect(ledgerRowsOn(db, 'docs')).resolves.toHaveLength(0);
    } finally {
      // Remove the fault trigger even when assertions fail so the retry below
      // runs against clean runner-owned state.
      await db
        .unsafe(
          'drop trigger if exists rag_t03_ledger_fault_trigger on public.rag_schema_migrations'
        )
        .catch(() => {});
      await db.unsafe('drop function if exists public.rag_t03_ledger_fault()').catch(() => {});
    }

    // With the fault removed the identical challenge still binds: the retry
    // adopts the whole prefix atomically with exact verified_adoption rows.
    const retried = await runAdopt({
      db,
      lane: 'docs',
      manifest: docsManifest,
      redactedUrl: REDACTED_TARGET,
      targetFingerprint: TARGET_FINGERPRINT,
      challengeDigest: digest,
      dryRun: false,
    });
    expect(retried.adopted.map((item) => item.recordKind)).toEqual([
      'verified_adoption',
      'verified_adoption',
      'verified_adoption',
      'verified_adoption',
      'verified_adoption',
    ]);
    await expectExactLedger('docs', docsManifest, [
      'verified_adoption',
      'verified_adoption',
      'verified_adoption',
      'verified_adoption',
      'verified_adoption',
    ]);
  });

  it('fails immediately when the database-global advisory lock is held elsewhere', async () => {
    await resetDatabase();
    const holderSql = createSql(databaseUrl);
    const holder = adaptReservedSql(await holderSql.reserve());
    try {
      await holder.unsafe('select pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
      await expectRunnerError(
        runApply({
          db,
          lane: 'docs',
          manifest: docsManifest,
          redactedUrl: REDACTED_TARGET,
          targetFingerprint: TARGET_FINGERPRINT,
          dryRun: false,
        }),
        'MIGRATION_LOCK_BUSY'
      );
      await expect(hasRelation('public.rag_schema_migrations')).resolves.toBe(false);
    } finally {
      await holder
        .unsafe('select pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY])
        .catch(() => {});
      await holder.release().catch(() => {});
      await holderSql.close({ timeout: 5 }).catch(() => {});
    }
  });

  it('enforces the single global advisory lock across both migration lanes', async () => {
    // One database-global key must fence project and docs mutations alike:
    // with the key held externally, both lanes refuse closed without creating
    // the ledger or executing any historical SQL.
    await resetDatabase();
    const holderSql = createSql(databaseUrl);
    const holder = adaptReservedSql(await holderSql.reserve());
    try {
      await holder.unsafe('select pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
      await expectRunnerError(
        runApply({
          db,
          lane: 'project',
          manifest: projectManifest,
          redactedUrl: REDACTED_TARGET,
          targetFingerprint: TARGET_FINGERPRINT,
          dryRun: false,
        }),
        'MIGRATION_LOCK_BUSY'
      );
      await expectRunnerError(
        runApply({
          db,
          lane: 'docs',
          manifest: docsManifest,
          redactedUrl: REDACTED_TARGET,
          targetFingerprint: TARGET_FINGERPRINT,
          dryRun: false,
        }),
        'MIGRATION_LOCK_BUSY'
      );
      await expect(hasRelation('public.rag_schema_migrations')).resolves.toBe(false);
      await expect(hasRelation('public.project_repositories')).resolves.toBe(false);
      await expect(hasRelation('public.docs_documents')).resolves.toBe(false);
    } finally {
      await holder
        .unsafe('select pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY])
        .catch(() => {});
      await holder.release().catch(() => {});
      await holderSql.close({ timeout: 5 }).catch(() => {});
    }
  });

  it('replays manifests per target and binds adoption challenges to target identity', async () => {
    await resetDatabase();
    const siblingSqlLocal = createSql(withDatabaseName(databaseUrl, SIBLING_DB));
    const siblingDb = adaptReservedSql(await siblingSqlLocal.reserve());
    try {
      await siblingDb.unsafe('drop schema if exists public cascade');
      await siblingDb.unsafe('create schema public');

      // Cross-target replay: the same fixed docs manifest applies freshly on
      // target B while target A stays untouched, and reruns are no-ops on both.
      const bApplyInput = {
        db: siblingDb,
        lane: 'docs' as const,
        manifest: docsManifest,
        redactedUrl: 'postgres://integration-target-b',
        targetFingerprint: TARGET_B_FINGERPRINT,
        dryRun: false,
      };
      const bApply = await runApply(bApplyInput);
      expect(bApply.executed.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5]);
      const bRerun = await runApply(bApplyInput);
      expect(bRerun.executed).toEqual([]);
      const aStatusAfterB = await runStatus({
        db,
        lane: 'docs',
        manifest: docsManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
      });
      expect(aStatusAfterB.state).toEqual({ kind: 'fresh' });

      // Challenge binding: identical legacy footprints on A and B publish
      // different proof digests because the digest includes the target
      // fingerprint. A's digest must be refused on B before any ledger write.
      await resetDatabase();
      await db.unsafe(docsManifest[0].sqlText);
      await siblingDb.unsafe('drop schema if exists public cascade');
      await siblingDb.unsafe('create schema public');
      await siblingDb.unsafe(docsManifest[0].sqlText);

      const statusA = await runStatus({
        db,
        lane: 'docs',
        manifest: docsManifest,
        redactedUrl: REDACTED_TARGET,
        targetFingerprint: TARGET_FINGERPRINT,
      });
      const statusB = await runStatus(bApplyInput);
      const digestA = statusA.adoptionChallenge?.proofDigest;
      const digestB = statusB.adoptionChallenge?.proofDigest;
      if (!digestA || !digestB) {
        throw new Error('expected adoption challenges on both targets');
      }
      expect(digestA).not.toBe(digestB);

      await expectRunnerError(
        runAdopt({ ...bApplyInput, challengeDigest: digestA }),
        'MIGRATION_CHALLENGE_MISMATCH'
      );
      await expect(hasRelationOn(siblingDb, 'public.rag_schema_migrations')).resolves.toBe(false);

      const adopted = await runAdopt({ ...bApplyInput, challengeDigest: digestB });
      expect(adopted.adopted.map((item) => item.recordKind)).toEqual(['verified_adoption']);
      await expectExactLedgerOn(siblingDb, 'docs', docsManifest.slice(0, 1), ['verified_adoption']);
    } finally {
      await siblingDb.release().catch(() => {});
      await siblingSqlLocal.close({ timeout: 5 }).catch(() => {});
    }
  });
});
