/**
 * @module store-read-models
 * @description Read-model functions extracted from store.ts.
 *
 * These functions perform read-only queries against the Project RAG Postgres
 * schema (file details, outlines, symbols, navigation, semantic grouping).
 * They are re-exported from store.ts so all existing importers remain
 * unaffected.
 */

import { basename } from 'node:path/posix';
import type { ProjectRagSql } from './store.js';
import {
  chunkFromRow,
  fileFromRow,
  numberField,
  optionalNumberField,
  referenceFromRow,
  symbolFromRow,
} from './store-row-utils.js';

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

interface ProjectRagPostgresGraphFile {
  readonly id: number;
  readonly sourcePath: string;
  readonly lang?: string;
  readonly symbols: string[];
}

export interface ProjectRagPostgresServingState {
  readonly status: 'serving' | 'unavailable';
  readonly buildId: number | null;
  readonly revisionId: number | null;
  readonly publishedAt: string | null;
  readonly fileCount: number;
  readonly versionCount: number;
  readonly dirtyDigest: string | null;
  readonly provenance: {
    readonly repositoryHash: string | null;
    readonly workspaceHash: string | null;
    readonly headOid: string | null;
    readonly branchName: string | null;
    readonly isDetached: boolean | null;
    readonly isUnborn: boolean | null;
    readonly headHash: string | null;
    readonly branchHash: string | null;
    readonly detachedHash: string | null;
    readonly contentHash: string | null;
    readonly contentFingerprint: string | null;
    readonly statusDigest: string | null;
    readonly identityDigest: string | null;
  };
  readonly reason?: string;
}

const validatedReadSchemas = new WeakSet<object>();

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function nullableIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return nullableString(value);
}

/**
 * Read-side schema gate for the immutable version and scope-identity
 * contracts.  The probe is deliberately structural instead of ledger-based:
 * it also protects databases adopted before the migration ledger existed.
 */
export async function assertProjectRagPostgresReadSchemaReady(sql: ProjectRagSql): Promise<void> {
  const key = sql as unknown as object;
  if (validatedReadSchemas.has(key)) return;

  const rows = (await sql`
    select
      (
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project_embeddings_1024'
            and column_name = 'embedding_profile_hash'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('project_index_build_files')
            and conname = 'project_index_build_files_version_file_project_fk'
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('project_file_versions')
            and tgname = 'project_file_versions_lifecycle_transitions'
            and not tgisinternal
        )
      ) as "migration010Ready",
      (
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project_rag_repositories'
            and column_name = 'repository_hash'
        )
        and exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project_rag_workspaces'
            and column_name = 'workspace_hash'
        )
        and (
          select count(*) = 8
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project_rag_revisions'
            and column_name in (
              'is_unborn', 'head_hash', 'branch_hash', 'detached_hash',
              'content_hash', 'status_digest', 'content_fingerprint', 'identity_digest'
            )
        )
        and exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project_ingest_snapshots'
            and column_name = 'completeness_status'
        )
        and exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project_ingest_snapshots'
            and column_name = 'completeness_evidence_hash'
        )
        and exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project_ingest_snapshots'
            and column_name = 'deletion_allowed'
        )
      ) as "migration011Ready"
  `) as Array<Record<string, unknown>>;

  if (rows[0]?.migration010Ready !== true) {
    throw new Error(
      'Project RAG schema migration 010 is required for build-bound reads ' +
        '(infra/project-rag/sql/010-version-owned-derived-data.sql). Run: ' +
        'bun run db:migrations apply --lane project --execute (requires RAG_MIGRATION_TARGET=isolated and RAG_MIGRATION_WRITE_ACK=1; check state first with: bun run db:migrations status --lane project)'
    );
  }
  if (rows[0]?.migration011Ready !== true) {
    throw new Error(
      'Project RAG schema migration 011 is required for workspace provenance reads ' +
        '(infra/project-rag/sql/011-scope-identity-completeness.sql). Run: ' +
        'bun run db:migrations apply --lane project --execute (requires RAG_MIGRATION_TARGET=isolated and RAG_MIGRATION_WRITE_ACK=1; check state first with: bun run db:migrations status --lane project)'
    );
  }
  validatedReadSchemas.add(key);
}

// ---------------------------------------------------------------------------
// Private helpers (read-models-only)
// ---------------------------------------------------------------------------

/** Resolve the published (active) build id with a failing fast guarantee. */
export async function getPublishedProjectRagPostgresBuildId(
  sql: ProjectRagSql,
  projectId: number
): Promise<number> {
  await assertProjectRagPostgresReadSchemaReady(sql);
  const rows = (await sql`
    select id from project_index_builds
    where project_id = ${projectId} and status = 'published'
    order by published_at desc, id desc
    limit 1
  `) as Array<Record<string, unknown>>;
  const buildId = numberField(rows[0]?.id);
  if (!buildId)
    throw new Error(`Project RAG has no published index build for project ${projectId}`);
  return buildId;
}

/** Return the immutable build currently visible to readers, without conflating
 * serving availability with workspace freshness or semantic readiness. */
export async function getProjectRagPostgresServingState(
  sql: ProjectRagSql,
  projectId: number
): Promise<ProjectRagPostgresServingState> {
  await assertProjectRagPostgresReadSchemaReady(sql);
  const rows = (await sql`
    select b.id as "buildId", b.revision_id as "revisionId", b.published_at as "publishedAt",
      r.dirty_digest as "dirtyDigest", repo.repository_hash as "repositoryHash",
      w.workspace_hash as "workspaceHash", r.head_oid as "headOid", r.branch_name as "branchName",
      r.is_detached as "isDetached", r.is_unborn as "isUnborn", r.head_hash as "headHash",
      r.branch_hash as "branchHash", r.detached_hash as "detachedHash", r.content_hash as "contentHash",
      r.content_fingerprint as "contentFingerprint", r.status_digest as "statusDigest",
      r.identity_digest as "identityDigest", count(bf.file_id)::int as "fileCount",
      count(distinct bf.version_id)::int as "versionCount"
    from project_index_builds b
    left join project_rag_revisions r on r.id = b.revision_id
    left join project_rag_workspaces w on w.id = r.workspace_id
    left join project_rag_repositories repo on repo.id = w.repository_id
    left join project_index_build_files bf
      on bf.project_id = b.project_id and bf.build_id = b.id
    where b.project_id = ${projectId} and b.status = 'published'
    group by b.id, b.revision_id, b.published_at, r.dirty_digest, repo.repository_hash,
      w.workspace_hash, r.head_oid, r.branch_name, r.is_detached, r.is_unborn,
      r.head_hash, r.branch_hash, r.detached_hash, r.content_hash, r.content_fingerprint,
      r.status_digest, r.identity_digest
    order by b.published_at desc nulls last, b.id desc
    limit 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  const buildId = optionalNumberField(row?.buildId);
  if (!buildId) {
    return {
      status: 'unavailable',
      buildId: null,
      revisionId: null,
      publishedAt: null,
      fileCount: 0,
      versionCount: 0,
      dirtyDigest: null,
      provenance: {
        repositoryHash: null,
        workspaceHash: null,
        headOid: null,
        branchName: null,
        isDetached: null,
        isUnborn: null,
        headHash: null,
        branchHash: null,
        detachedHash: null,
        contentHash: null,
        contentFingerprint: null,
        statusDigest: null,
        identityDigest: null,
      },
      reason: `Project RAG has no published index build for project ${projectId}`,
    };
  }
  return {
    status: 'serving',
    buildId,
    revisionId: optionalNumberField(row.revisionId) ?? null,
    publishedAt: nullableIsoString(row.publishedAt),
    fileCount: numberField(row.fileCount),
    versionCount: numberField(row.versionCount),
    dirtyDigest: nullableString(row.dirtyDigest),
    provenance: {
      repositoryHash: nullableString(row.repositoryHash),
      workspaceHash: nullableString(row.workspaceHash),
      headOid: nullableString(row.headOid),
      branchName: nullableString(row.branchName),
      isDetached: nullableBoolean(row.isDetached),
      isUnborn: nullableBoolean(row.isUnborn),
      headHash: nullableString(row.headHash),
      branchHash: nullableString(row.branchHash),
      detachedHash: nullableString(row.detachedHash),
      contentHash: nullableString(row.contentHash),
      contentFingerprint: nullableString(row.contentFingerprint),
      statusDigest: nullableString(row.statusDigest),
      identityDigest: nullableString(row.identityDigest),
    },
  };
}

/** Gather all tracked files (with symbol names) for graph-based queries. */
async function listProjectRagPostgresGraphFiles(
  sql: ProjectRagSql,
  projectId: number,
  buildId: number
): Promise<ProjectRagPostgresGraphFile[]> {
  const rows = (await sql`
    select bf.file_id as id, bf.source_path as "sourcePath", bf.lang, s.name as "symbolName"
    from project_index_build_files bf
    left join project_symbols s on s.project_id = bf.project_id
      and s.file_id = bf.file_id
      and (
        s.version_id = bf.version_id
        or (s.version_id is null and not exists (
          select 1 from project_symbols v_sym
          where v_sym.project_id = s.project_id
            and v_sym.file_id = s.file_id
            and v_sym.version_id = bf.version_id
        ))
      )
    where bf.project_id = ${projectId} and bf.build_id = ${buildId}
    order by bf.source_path asc, s.start_line asc nulls last, s.name asc nulls last
    limit 5000
  `) as Array<Record<string, unknown>>;

  const files = new Map<number, { sourcePath: string; lang?: string; symbols: string[] }>();
  for (const row of rows) {
    const id = numberField(row.id);
    if (!id) {
      continue;
    }
    const current = files.get(id) ?? {
      sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : '',
      lang: typeof row.lang === 'string' ? row.lang : undefined,
      symbols: [],
    };
    if (typeof row.symbolName === 'string') {
      current.symbols.push(row.symbolName);
    }
    files.set(id, current);
  }

  return [...files.entries()].map(([id, file]) => ({ id, ...file }));
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function projectDirectory(sourcePath: string): string {
  const parts = sourcePath.split('/');
  parts.pop(); // remove file name
  return parts.length === 0 || (parts.length === 1 && parts[0] === '') ? 'root' : parts.join('/');
}

function fileExtension(sourcePath: string): string {
  const idx = sourcePath.lastIndexOf('.');
  return idx >= 0 ? sourcePath.slice(idx + 1).toLowerCase() : 'unknown';
}

function topicTerms(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_./-]+|[/._-]+/)
    .filter((term) => term.length >= 3);
}

// ---------------------------------------------------------------------------
// Public read-model functions (re-exported from store.ts)
// ---------------------------------------------------------------------------

/**
 * Return a single indexed file with its associated chunks.
 */
export async function getProjectRagPostgresFileWithChunks(
  sql: ProjectRagSql,
  projectId: number,
  sourcePath: string,
  args: { readonly limit?: number; readonly buildId?: number } = {}
): Promise<
  | {
      readonly buildId: number;
      readonly versionId: number;
      readonly file: import('./store.js').ProjectRagPostgresFile;
      readonly chunks: import('./store.js').ProjectRagPostgresChunk[];
      readonly chunkCount: number;
    }
  | undefined
> {
  await assertProjectRagPostgresReadSchemaReady(sql);
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 500);
  const buildId = args.buildId ?? (await getPublishedProjectRagPostgresBuildId(sql, projectId));
  const files = (await sql`
    select bf.file_id as id, bf.version_id as "versionId", bf.source_path as "sourcePath", bf.lang, bf.status,
      bf.size_bytes as "sizeBytes", bf.metadata_quality as "metadataQuality",
      bf.skeleton_text as "skeletonText", bf.outline_version as "outlineVersion",
      (select max(c.end_line) from project_chunks c
        where c.file_id = bf.file_id and c.version_id = bf.version_id)::int as "lineCount"
    from project_index_build_files bf
    where bf.project_id = ${projectId} and bf.build_id = ${buildId}
      and bf.source_path = ${sourcePath}
    limit 1
  `) as Array<Record<string, unknown>>;
  const file = files[0] ? fileFromRow(files[0]) : undefined;
  if (!file) {
    return undefined;
  }
  const versionId = optionalNumberField(files[0]?.versionId);
  if (!versionId) {
    throw new Error(
      `Published Project RAG build ${buildId} has no version binding for ${sourcePath}`
    );
  }

  const chunks = (await sql`
    select c.id, c.chunk_index as "chunkIndex", c.start_line as "startLine",
      c.end_line as "endLine", c.symbol_name as "symbolName",
      c.symbol_kind as "symbolKind", c.content,
      count(*) over()::int as "chunkCount"
    from project_chunks c
    where c.project_id = ${projectId}
      and c.file_id = ${file.id}
      and c.version_id = (select version_id from project_index_build_files
        where project_id = ${projectId} and build_id = ${buildId} and file_id = ${file.id})
    order by c.chunk_index asc
    limit ${limit}
  `) as Array<Record<string, unknown>>;

  return {
    buildId,
    versionId,
    file,
    chunks: chunks.map(chunkFromRow),
    chunkCount: numberField(chunks[0]?.chunkCount),
  };
}

/**
 * Return a single indexed file's symbol outline with skeleton metadata.
 */
export async function getProjectRagPostgresFileOutline(
  sql: ProjectRagSql,
  projectId: number,
  sourcePath: string,
  args: { readonly limit?: number; readonly buildId?: number } = {}
): Promise<
  | {
      readonly buildId: number;
      readonly versionId: number;
      readonly sourcePath: string;
      readonly skeleton: import('./store.js').ProjectRagPostgresFile;
      readonly symbols: import('./store.js').ProjectRagPostgresSymbol[];
      readonly symbolCount: number;
    }
  | undefined
> {
  await assertProjectRagPostgresReadSchemaReady(sql);
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const buildId = args.buildId ?? (await getPublishedProjectRagPostgresBuildId(sql, projectId));
  const fileResult = await getProjectRagPostgresFileWithChunks(sql, projectId, sourcePath, {
    limit: 1,
    buildId,
  });
  if (!fileResult) {
    return undefined;
  }

  const rows = (await sql`
    select s.id, s.name, s.symbol_type as "symbolType", s.export_type as "exportType",
      s.signature, s.start_line as "startLine", s.end_line as "endLine",
      s.confidence, s.file_id as "fileId", bf.source_path as "sourcePath",
      count(*) over()::int as "symbolCount"
    from project_symbols s
    join project_index_build_files bf on bf.project_id = s.project_id and bf.file_id = s.file_id
      and (
        s.version_id = bf.version_id
        or (s.version_id is null and not exists (
          select 1 from project_symbols v_sym
          where v_sym.project_id = s.project_id
            and v_sym.file_id = s.file_id
            and v_sym.version_id = bf.version_id
        ))
      )
    where s.project_id = ${projectId}
      and bf.build_id = ${buildId} and s.file_id = ${fileResult.file.id}
    order by s.start_line asc nulls last, s.name asc
    limit ${limit}
  `) as Array<Record<string, unknown>>;

  return {
    buildId: fileResult.buildId,
    versionId: fileResult.versionId,
    sourcePath,
    skeleton: fileResult.file,
    symbols: rows.map(symbolFromRow),
    symbolCount: numberField(rows[0]?.symbolCount),
  };
}

/**
 * Search for symbol definitions and references matching a name (and optional type).
 */
export async function findProjectRagPostgresSymbols(
  sql: ProjectRagSql,
  projectId: number,
  args: {
    readonly name: string;
    readonly type?: string;
    readonly limit?: number;
    readonly buildId?: number;
  }
): Promise<{
  readonly buildId: number;
  readonly definitions: import('./store.js').ProjectRagPostgresSymbol[];
  readonly references: import('./store.js').ProjectRagPostgresReference[];
}> {
  await assertProjectRagPostgresReadSchemaReady(sql);
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
  const buildId = args.buildId ?? (await getPublishedProjectRagPostgresBuildId(sql, projectId));
  const normalizedName = args.name.toLowerCase();
  const definitions = (await sql`
    select s.id, s.name, s.symbol_type as "symbolType", s.export_type as "exportType",
      s.signature, s.start_line as "startLine", s.end_line as "endLine",
      s.confidence, s.file_id as "fileId", bf.source_path as "sourcePath"
    from project_symbols s
    join project_index_build_files bf on bf.project_id = s.project_id and bf.file_id = s.file_id
      and (
        s.version_id = bf.version_id
        or (s.version_id is null and not exists (
          select 1 from project_symbols v_sym
          where v_sym.project_id = s.project_id
            and v_sym.file_id = s.file_id
            and v_sym.version_id = bf.version_id
        ))
      )
    where s.project_id = ${projectId}
      and bf.build_id = ${buildId}
      and lower(s.name) = ${normalizedName}
      and (${args.type ?? null}::text is null or s.symbol_type = ${args.type ?? null})
    order by s.confidence desc nulls last, s.start_line asc nulls last, bf.source_path asc
    limit ${limit}
  `) as Array<Record<string, unknown>>;

  const rawReferences = (await sql`
    select e.id, e.relation_type as "relationType", e.source_ref as "sourceRef",
      e.target_ref as "targetRef", e.source_file_id as "sourceFileId",
      e.target_file_id as "targetFileId", e.confidence,
      source_build.source_path as "sourcePath", target_build.source_path as "targetPath",
      ss.start_line as "startLine", ss.end_line as "endLine"
    from project_edges e
    join project_index_build_files source_build on source_build.project_id = e.project_id
      and source_build.file_id = e.source_file_id
      and source_build.version_id = e.source_version_id
      and source_build.build_id = ${buildId}
    left join project_index_build_files target_build on target_build.project_id = e.project_id
      and target_build.file_id = e.target_file_id
      and target_build.version_id = e.target_version_id
      and target_build.build_id = ${buildId}
    left join project_symbols ss on ss.project_id = e.project_id
      and ss.id = e.source_symbol_id and ss.file_id = e.source_file_id
      and (ss.version_id = e.source_version_id or ss.version_id is null)
    where e.project_id = ${projectId}
      and e.target_ref_lower = ${normalizedName}
    order by e.confidence desc, source_build.source_path asc nulls last, e.id asc
  `) as Array<Record<string, unknown>>;

  const seenRefs = new Set<string>();
  const references: Record<string, unknown>[] = [];
  for (const ref of rawReferences) {
    const key = `${ref.sourcePath}:${ref.relationType}:${ref.targetRef}:${ref.sourceRef}:${ref.startLine}`;
    if (!seenRefs.has(key)) {
      seenRefs.add(key);
      references.push(ref);
      if (references.length >= limit) break;
    }
  }

  return {
    buildId,
    definitions: definitions.map(symbolFromRow),
    references: references.map(referenceFromRow),
  };
}

/**
 * Return navigation paths from a file's outgoing edges.
 */
export async function getProjectRagPostgresNavigationPaths(
  sql: ProjectRagSql,
  projectId: number,
  sourcePath: string,
  args: { readonly limit?: number } = {}
): Promise<import('./store.js').ProjectRagPostgresNavigationPath[] | undefined> {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const buildId = await getPublishedProjectRagPostgresBuildId(sql, projectId);
  const sourceFiles = (await sql`
    select file_id as id, version_id as "versionId"
    from project_index_build_files
    where project_id = ${projectId} and build_id = ${buildId} and source_path = ${sourcePath}
    limit 1
  `) as Array<Record<string, unknown>>;
  const sourceFileId = numberField(sourceFiles[0]?.id);
  const sourceVersionId = numberField(sourceFiles[0]?.versionId);
  if (!sourceFileId || !sourceVersionId) {
    return undefined;
  }

  // Use a lateral join instead of an OR condition to avoid cartesian
  // products when multiple symbols share the same name.  The lateral
  // subquery picks the best matching symbol deterministically (same-file
  // preference, lowest id tiebreaker).  Edges with a resolved
  // target_file_id skip the symbol lookup entirely.
  // Materialize resolved source edges first to prevent the planner from
  // choosing the entire build files index as the outer loop.
  // File-bound edges may carry a null target_version_id (the ingest edge
  // resolver binds target files without versions); build_files is unique on
  // (build_id, file_id), so the published build is the binding authority.
  const rows = (await sql`
    with source_edges as materialized (
      select
        e.id,
        e.relation_type,
        e.confidence,
        coalesce(target_file.file_id, sym.symbol_file_id) as target_file_id
      from project_edges e
      left join project_index_build_files target_file on target_file.project_id = e.project_id
        and target_file.file_id = e.target_file_id
        and (target_file.version_id = e.target_version_id or e.target_version_id is null)
        and target_file.build_id = ${buildId}
      left join lateral (
        select s.file_id as symbol_file_id
        from project_symbols s
        join project_index_build_files symbol_build on symbol_build.project_id = s.project_id
          and symbol_build.file_id = s.file_id
          and symbol_build.version_id = s.version_id
          and symbol_build.build_id = ${buildId}
        where s.project_id = ${projectId}
          and e.target_file_id is null
          and e.target_ref_lower is not null
          and lower(s.name) = e.target_ref_lower
          and s.file_id is not null
        order by
          case when s.file_id = e.source_file_id then 0 else 1 end,
          s.id
        limit 1
      ) sym on true
      where e.project_id = ${projectId}
        and e.source_file_id = ${sourceFileId}
        and e.source_version_id = ${sourceVersionId}
    )
    select
      related_build.source_path as "sourcePath",
      se.relation_type as "relationshipType",
      max(greatest(coalesce(se.confidence, 1), 0))::float8 as strength
    from source_edges se
    join project_index_build_files related_build on related_build.project_id = ${projectId}
      and related_build.file_id = se.target_file_id
      and related_build.build_id = ${buildId}
    where se.target_file_id is not null
      and se.target_file_id <> ${sourceFileId}
    group by related_build.source_path, se.relation_type
    order by strength desc, related_build.source_path asc
    limit ${limit}
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const relationshipType =
      typeof row.relationshipType === 'string' ? row.relationshipType : 'related';
    const strength = typeof row.strength === 'number' ? row.strength : Number(row.strength ?? 0);
    return {
      sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : '',
      relationshipType,
      strength,
      explanation: `Related through ${relationshipType} graph edge`,
    };
  });
}

/**
 * Group indexed files into feature hubs by directory, ranked by file count.
 */
export async function getProjectRagPostgresFeatureHubs(
  sql: ProjectRagSql,
  projectId: number,
  args: { readonly minFiles?: number; readonly limit?: number } = {}
): Promise<import('./store.js').ProjectRagPostgresFeatureHub[]> {
  const minFiles = Math.min(Math.max(args.minFiles ?? 2, 1), 100);
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const buildId = await getPublishedProjectRagPostgresBuildId(sql, projectId);
  const files = await listProjectRagPostgresGraphFiles(sql, projectId, buildId);
  const groups = new Map<string, ProjectRagPostgresGraphFile[]>();

  for (const file of files) {
    const directory = projectDirectory(file.sourcePath);
    groups.set(directory, [...(groups.get(directory) ?? []), file]);
  }

  return [...groups.entries()]
    .filter(([, groupFiles]) => groupFiles.length >= minFiles)
    .map(([directory, groupFiles]) => {
      const languages = new Set(groupFiles.map((file) => file.lang).filter(Boolean));
      const fileTypeDistribution: Record<string, number> = {};
      let totalSymbols = 0;

      for (const file of groupFiles) {
        const extension = fileExtension(file.sourcePath);
        fileTypeDistribution[extension] = (fileTypeDistribution[extension] ?? 0) + 1;
        totalSymbols += file.symbols.length;
      }

      const name = directory === 'root' ? 'Root' : titleCase(basename(directory));
      return {
        hubId: `hub-${directory.replaceAll('/', '-')}`,
        name,
        directory,
        stats: {
          fileCount: groupFiles.length,
          languageCount: languages.size,
          totalSymbols,
          fileTypeDistribution,
        },
        files: groupFiles.map((file) => ({
          fileName: basename(file.sourcePath),
          symbols: file.symbols.slice(0, 10),
        })),
      };
    })
    .sort((a, b) => b.stats.fileCount - a.stats.fileCount || a.directory.localeCompare(b.directory))
    .slice(0, limit);
}

/**
 * Derive semantic clusters from feature hubs with similarity and terms.
 */
export async function getProjectRagPostgresSemanticClusters(
  sql: ProjectRagSql,
  projectId: number,
  args: { readonly maxClusters?: number; readonly minClusterSize?: number } = {}
): Promise<import('./store.js').ProjectRagPostgresSemanticCluster[]> {
  const maxClusters = Math.min(Math.max(args.maxClusters ?? 10, 1), 50);
  const minClusterSize = Math.min(Math.max(args.minClusterSize ?? 2, 1), 100);
  const hubs = await getProjectRagPostgresFeatureHubs(sql, projectId, {
    minFiles: minClusterSize,
    limit: maxClusters,
  });

  return hubs.map((hub) => ({
    clusterId: `cluster-${hub.hubId}`,
    topicLabel: hub.name,
    confidence: Math.min(0.95, 0.5 + hub.stats.fileCount / 20),
    files: hub.files.map((file) => ({
      sourcePath: hub.directory === 'root' ? file.fileName : `${hub.directory}/${file.fileName}`,
      similarity: 0.75,
    })),
    terms: [...new Set(topicTerms(hub.directory === 'root' ? hub.name : hub.directory))].slice(
      0,
      8
    ),
  }));
}

/**
 * Group indexed files into topic groups by term frequency.
 */
export async function getProjectRagPostgresTopicGroups(
  sql: ProjectRagSql,
  projectId: number,
  args: { readonly maxTopics?: number; readonly minTopicSize?: number } = {}
): Promise<import('./store.js').ProjectRagPostgresTopicGroup[]> {
  const maxTopics = Math.min(Math.max(args.maxTopics ?? 8, 1), 50);
  const minTopicSize = Math.min(Math.max(args.minTopicSize ?? 2, 1), 100);
  const buildId = await getPublishedProjectRagPostgresBuildId(sql, projectId);
  const files = await listProjectRagPostgresGraphFiles(sql, projectId, buildId);
  const ignored = new Set(['src', 'lib', 'dist', 'node_modules', 'test', 'tests']);
  const groups = new Map<string, ProjectRagPostgresGraphFile[]>();

  for (const file of files) {
    const terms = [
      ...file.sourcePath.split('/').filter((part) => part && !ignored.has(part)),
      ...file.symbols.flatMap(topicTerms),
    ];
    for (const term of new Set(terms.map((term) => term.toLowerCase()))) {
      groups.set(term, [...(groups.get(term) ?? []), file]);
    }
  }

  return [...groups.entries()]
    .filter(([, groupFiles]) => groupFiles.length >= minTopicSize)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, maxTopics)
    .map(([topic, groupFiles], index) => ({
      topicId: `topic-${index + 1}`,
      name: titleCase(topic),
      files: groupFiles.map((file) => ({ sourcePath: file.sourcePath })),
      keywords: [topic],
      cohesion: Math.min((groupFiles.length / Math.max(files.length, 1)) * 5, 1),
    }));
}
