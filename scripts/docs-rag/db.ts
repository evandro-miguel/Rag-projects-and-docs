import { performance } from 'node:perf_hooks';
import {
  formatDocsCorpusFailure,
  isDocsCorpusReady,
  normalizeDocsCorpusProbeResult,
} from '../lib/docs-corpus-readiness.js';
import {
  DOCS_SOURCE_REGISTRY,
  lookupDocsSourceById,
  stripDocsSourceArtifactPrefix,
} from '../lib/docs-source-registry.js';
import type { DocsRagLabConfig } from './config.js';
import { redactPostgresUrl } from './config.js';
import { assertDocsRagGenerationSchemaReady, assertDocsRagProcessingSchemaReady } from './store.js';

export interface DocsRagLabDbConnectionInfo {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user?: string;
  readonly sslmode?: string;
}

export interface DocsRagLabDbHealthResult {
  readonly status: 'healthy' | 'unhealthy' | 'blocked';
  readonly method: 'bun-sql' | 'none';
  readonly target?: string;
  readonly connection?: DocsRagLabDbConnectionInfo;
  readonly latencyMs?: number;
  readonly message: string;
  readonly warnings: string[];
}

export interface DocsRagLabSqlProbeResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface DocsRagLabCorpusHealthResult {
  readonly status: 'healthy' | 'unhealthy' | 'blocked';
  readonly documents: number;
  readonly unexpectedSourceIds: string[];
  readonly invalidPathCount: number;
  readonly sourcePathMismatchCount: number;
  readonly missingMetadataCount: number;
  readonly missingSourceIds?: string[];
  readonly emptyDocumentCount?: number;
  readonly zeroChunkDocumentCount?: number;
  readonly emptyChunkCount?: number;
  readonly missingEmbeddingChunkCount?: number;
  readonly message: string;
}

export type DocsRagLabCorpusProbeRunner = (
  databaseUrl: string,
  timeoutMs: number,
  embedding: { readonly model: string; readonly dimensions: number }
) => Promise<Omit<DocsRagLabCorpusHealthResult, 'status' | 'message'>>;

export interface DocsRagLabCorpusHealthOptions {
  readonly timeoutMs?: number;
}

export function isRegisteredDocsSourcePathMatch(sourceId: string, sourcePath: string): boolean {
  const source = lookupDocsSourceById(sourceId);
  if (!source) return false;
  const relativeSourcePath = stripDocsSourceArtifactPrefix(sourcePath);
  return source.pathPrefixes.some((prefix) => relativeSourcePath.startsWith(prefix));
}

export type DocsRagLabSqlProbeRunner = (
  databaseUrl: string,
  timeoutMs: number
) => Promise<DocsRagLabSqlProbeResult>;

export interface DocsRagLabDbHealthOptions {
  readonly timeoutMs?: number;
  readonly runSqlProbe?: DocsRagLabSqlProbeRunner;
}

function buildBlockedResult(
  target: string | undefined,
  connection: DocsRagLabDbConnectionInfo | undefined,
  message: string,
  warnings: string[] = []
): DocsRagLabDbHealthResult {
  return {
    status: 'blocked',
    method: 'none',
    target,
    connection,
    message,
    warnings,
  };
}

function sanitizeDatabaseError(message: string, databaseUrl: string): string {
  const redactedUrl = redactPostgresUrl(databaseUrl);
  return redactedUrl ? message.replaceAll(databaseUrl, redactedUrl) : message;
}

export function parsePostgresConnection(databaseUrl: string): DocsRagLabDbConnectionInfo {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Unsupported database protocol "${url.protocol}"`);
  }
  const sslmode = url.searchParams.get('sslmode') ?? undefined;

  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number.parseInt(url.port, 10) : 5432,
    database: url.pathname.replace(/^\/+/, '') || 'postgres',
    ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
    ...(sslmode ? { sslmode } : {}),
  };
}

async function runBunSqlProbe(
  databaseUrl: string,
  timeoutMs: number
): Promise<DocsRagLabSqlProbeResult> {
  const connectionTimeout = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const sql = new Bun.SQL({
    url: databaseUrl,
    max: 1,
    idleTimeout: Math.max(2, Math.ceil(timeoutMs / 1_000) + 1),
    maxLifetime: 0,
    connectionTimeout,
    prepare: false,
  });

  try {
    const rows = (await sql`select 1 as ok`) as Array<{ ok: number | string }>;
    const ok = rows[0]?.ok;
    if (ok === 1 || ok === '1') {
      return {
        ok: true,
        message: 'Connection succeeded and SELECT 1 returned the expected result.',
      };
    }

    return {
      ok: false,
      message: `Unexpected SELECT 1 result: ${JSON.stringify(rows[0] ?? null)}.`,
    };
  } finally {
    await sql.close({ timeout: 5 });
  }
}

async function runBunCorpusProbe(
  databaseUrl: string,
  timeoutMs: number,
  embedding: { readonly model: string; readonly dimensions: number }
): Promise<Omit<DocsRagLabCorpusHealthResult, 'status' | 'message'>> {
  const sql = new Bun.SQL({
    url: databaseUrl,
    max: 1,
    idleTimeout: Math.max(2, Math.ceil(timeoutMs / 1_000) + 1),
    maxLifetime: 0,
    connectionTimeout: Math.max(1, Math.ceil(timeoutMs / 1_000)),
    prepare: false,
  });
  const expectedSourceIds = DOCS_SOURCE_REGISTRY.map((source) => source.sourceId);
  const languageSourceIds = DOCS_SOURCE_REGISTRY.filter((source) => source.language).map(
    (source) => source.sourceId
  );
  try {
    await sql`select set_config('statement_timeout', ${String(timeoutMs)}, false)`;
    await assertDocsRagProcessingSchemaReady(sql);
    await assertDocsRagGenerationSchemaReady(sql);
    const rows = (await sql`
      with serving_documents as (
        select d.*
        from docs_documents d
        join docs_source_generation_pointers p
          on p.source_id = d.source_id
         and p.generation_id = d.generation_id
      )
      select
        count(*)::int as documents,
        coalesce(
          array_agg(distinct source_id order by source_id)
            filter (where source_id not in ${sql(expectedSourceIds)}),
          array[]::text[]
        ) as "unexpectedSourceIds",
        count(*) filter (
          where source_path not like 'ingest/processed/external/%'
        )::int as "invalidPathCount",
        count(*) filter (
          where category is null or kind is null or authority is null
            or (source_id in ${sql(languageSourceIds)} and language is null)
        )::int as "missingMetadataCount"
      from serving_documents
    `) as Array<{
      documents: number | string;
      unexpectedSourceIds: string[];
      invalidPathCount: number | string;
      missingMetadataCount: number | string;
    }>;
    const row = rows[0];
    const strictPathMismatches = (await sql`
      select d.source_id as "sourceId", d.source_path as "sourcePath"
      from docs_documents d
      join docs_source_generation_pointers p
        on p.source_id = d.source_id
       and p.generation_id = d.generation_id
      where d.source_path not like ('ingest/processed/external/' || d.source_id || '/%')
    `) as Array<{ sourceId: string; sourcePath: string }>;
    const sourceRows = (await sql`
      select distinct d.source_id as "sourceId"
      from docs_documents d
      join docs_source_generation_pointers p
        on p.source_id = d.source_id
       and p.generation_id = d.generation_id
    `) as Array<{ sourceId: string }>;
    const presentSourceIds = new Set(sourceRows.map(({ sourceId }) => sourceId));
    const integrityRows = (await sql`
      with serving_documents as (
        select d.*
        from docs_documents d
        join docs_source_generation_pointers p
          on p.source_id = d.source_id
         and p.generation_id = d.generation_id
      )
      select
        (
          select count(*)::int
          from serving_documents
          where btrim(content) = ''
        ) as "emptyDocumentCount",
        (
          select count(*)::int
          from serving_documents d
          where not exists (
            select 1
            from docs_chunks c
            where c.document_id = d.id and c.enabled
          )
        ) as "zeroChunkDocumentCount",
        (
          select count(*)::int
          from docs_chunks c
          join serving_documents d on d.id = c.document_id
          where c.enabled and btrim(c.content) = ''
        ) as "emptyChunkCount",
        (
          select count(*)::int
          from docs_chunks c
          join serving_documents d on d.id = c.document_id
          where c.enabled
            and not exists (
              select 1
              from docs_embeddings e
              where e.chunk_id = c.id
                and e.embedding_kind = 'chunk'
                and e.embedding_model = ${embedding.model}
                and e.embedding_dimensions = ${embedding.dimensions}
            )
        ) as "missingEmbeddingChunkCount"
    `) as Array<{
      emptyDocumentCount: number | string;
      zeroChunkDocumentCount: number | string;
      emptyChunkCount: number | string;
      missingEmbeddingChunkCount: number | string;
    }>;
    const integrity = integrityRows[0];
    return {
      documents: Number(row?.documents ?? 0),
      unexpectedSourceIds: row?.unexpectedSourceIds ?? [],
      invalidPathCount: Number(row?.invalidPathCount ?? 0),
      sourcePathMismatchCount: strictPathMismatches.filter(
        ({ sourceId, sourcePath }) => !isRegisteredDocsSourcePathMatch(sourceId, sourcePath)
      ).length,
      missingMetadataCount: Number(row?.missingMetadataCount ?? 0),
      missingSourceIds: expectedSourceIds.filter((sourceId) => !presentSourceIds.has(sourceId)),
      emptyDocumentCount: Number(integrity?.emptyDocumentCount ?? 0),
      zeroChunkDocumentCount: Number(integrity?.zeroChunkDocumentCount ?? 0),
      emptyChunkCount: Number(integrity?.emptyChunkCount ?? 0),
      missingEmbeddingChunkCount: Number(integrity?.missingEmbeddingChunkCount ?? 0),
    };
  } finally {
    await sql.close({ timeout: 5 });
  }
}

export async function checkDocsRagLabCorpusHealth(
  configOrUrl: DocsRagLabConfig | string | undefined,
  runProbe: DocsRagLabCorpusProbeRunner = runBunCorpusProbe,
  options: DocsRagLabCorpusHealthOptions = {}
): Promise<DocsRagLabCorpusHealthResult> {
  const databaseUrl = typeof configOrUrl === 'string' ? configOrUrl : configOrUrl?.database.url;
  if (!databaseUrl) {
    return {
      status: 'blocked',
      documents: 0,
      unexpectedSourceIds: [],
      invalidPathCount: 0,
      sourcePathMismatchCount: 0,
      missingMetadataCount: 0,
      message: 'No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.',
    };
  }
  const timeoutMs =
    options.timeoutMs ??
    (typeof configOrUrl === 'string' ? 5_000 : (configOrUrl?.healthTimeoutMs ?? 5_000));
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Corpus health probe timed out after ${timeoutMs}ms.`)),
        timeoutMs
      );
    });
    const embedding =
      typeof configOrUrl === 'object' && configOrUrl
        ? {
            model: configOrUrl.embedding.model,
            dimensions: configOrUrl.embedding.dimensions,
          }
        : { model: 'qwen3-embedding-1024', dimensions: 1024 };
    const result = await Promise.race([
      runProbe(databaseUrl, timeoutMs, embedding),
      timeoutPromise,
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    const normalizedResult = normalizeDocsCorpusProbeResult(result);
    const healthy = isDocsCorpusReady(normalizedResult);
    return {
      status: healthy ? 'healthy' : 'unhealthy',
      ...normalizedResult,
      message: healthy
        ? `Corpus inventory is clean across ${normalizedResult.documents} documents.`
        : formatDocsCorpusFailure(normalizedResult),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      documents: 0,
      unexpectedSourceIds: [],
      invalidPathCount: 0,
      sourcePathMismatchCount: 0,
      missingMetadataCount: 0,
      message: sanitizeDatabaseError(
        error instanceof Error ? error.message : String(error),
        databaseUrl
      ),
    };
  }
}

export async function checkDocsRagLabDatabaseHealth(
  configOrUrl: DocsRagLabConfig | string | undefined,
  options: DocsRagLabDbHealthOptions = {}
): Promise<DocsRagLabDbHealthResult> {
  const databaseUrl = typeof configOrUrl === 'string' ? configOrUrl : configOrUrl?.database.url;
  const target = redactPostgresUrl(databaseUrl);

  if (!databaseUrl) {
    return buildBlockedResult(
      target,
      undefined,
      'No Postgres URL configured. Set DOCS_RAG_PG_LAB_DATABASE_URL first.'
    );
  }

  let connection: DocsRagLabDbConnectionInfo | undefined;
  try {
    connection = parsePostgresConnection(databaseUrl);
  } catch (error) {
    return buildBlockedResult(
      target,
      undefined,
      error instanceof Error ? error.message : String(error)
    );
  }

  const timeoutMs =
    options.timeoutMs ??
    (typeof configOrUrl === 'string' ? 5_000 : (configOrUrl?.healthTimeoutMs ?? 5_000));
  const runSqlProbe = options.runSqlProbe ?? runBunSqlProbe;
  const startedAt = performance.now();

  try {
    const result = await runSqlProbe(databaseUrl, timeoutMs);
    const latencyMs = Math.round(performance.now() - startedAt);
    return {
      status: result.ok ? 'healthy' : 'unhealthy',
      method: 'bun-sql',
      target,
      connection,
      latencyMs,
      message: sanitizeDatabaseError(result.message, databaseUrl),
      warnings: [],
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'unhealthy',
      method: 'bun-sql',
      target,
      connection,
      latencyMs,
      message: sanitizeDatabaseError(message, databaseUrl),
      warnings: [],
    };
  }
}
