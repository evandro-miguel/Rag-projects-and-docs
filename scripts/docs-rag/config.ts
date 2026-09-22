import { normalizeEnvValue, resolveRepoPath } from '../lib/runtime-env.js';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface DocsRagPoolConfig {
  /** Maximum connections in the pool (range: 1–64, default: 2). */
  readonly max: number;
  /** Connection timeout in milliseconds (range: 1_000–120_000, default: 5_000). Bun.SQL expects seconds. */
  readonly connectionTimeoutMs: number;
  /**
   * Maximum connection lifetime in milliseconds.
   * 0 = unlimited, else 60_000–86_400_000 (default: 0).
   * Converted to seconds for Bun.SQL's maxLifetime option.
   */
  readonly maxLifetimeMs: number;
}

export interface DocsRagLabConfig {
  readonly tool: 'docs-rag-pg-lab';
  readonly rootDir: string;
  readonly defaultEvalFixturePath: string;
  readonly evalTopK: number;
  readonly healthTimeoutMs: number;
  readonly embedding: {
    readonly provider: 'llamacpp';
    readonly model: string;
    readonly baseUrl: string;
    readonly dimensions: 1024;
    readonly timeoutMs: number;
    readonly batchSize: number;
    readonly maxConcurrentBatches: number;
  };
  readonly database: {
    readonly url?: string;
    readonly redactedUrl?: string;
    readonly source?: string;
  };
  readonly pool: DocsRagPoolConfig;
  readonly gates: {
    readonly liveSearchEnabled: boolean;
    readonly embeddingEnabled: boolean;
    readonly mutationEnabled: boolean;
  };
}

function parseBoolean(value: string | undefined): boolean {
  return value ? TRUE_VALUES.has(value.trim().toLowerCase()) : false;
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const normalized = normalizeEnvValue(value);
  if (!normalized) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse an integer from an env var or override, clamped to [min, max].
 * When `allowZero` is true, zero is accepted as a valid value (for
 * "unlimited" semantics).  Invalid or out-of-range values return fallback.
 */
function parseBoundedPoolValue(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  allowZero = false
): number {
  const normalized = normalizeEnvValue(value);
  if (!normalized) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (allowZero && parsed === 0) {
    return 0;
  }

  return parsed >= min && parsed <= max ? parsed : fallback;
}

function resolveDatabaseUrl(env: NodeJS.ProcessEnv): { value?: string; source?: string } {
  const candidates = [
    'DOCS_RAG_PG_LAB_DATABASE_URL',
    'DOCS_RAG_PG_LAB_POSTGRES_URL',
    'POSTGRES_URL',
    'DATABASE_URL',
  ] as const;

  for (const key of candidates) {
    const value = normalizeEnvValue(env[key]);
    if (value) {
      return { value, source: key };
    }
  }

  return {};
}

export function redactPostgresUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return value.replace(/:([^:@/]+)@/, ':***@');
  }
}

export function resolveDocsRagLabConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Pick<DocsRagLabConfig, 'evalTopK' | 'healthTimeoutMs'>> & {
    databaseUrl?: string;
    poolMax?: number;
    poolConnectionTimeoutMs?: number;
    poolMaxLifetimeMs?: number;
  } = {}
): DocsRagLabConfig {
  const database = resolveDatabaseUrl(env);
  const databaseUrl = normalizeEnvValue(overrides.databaseUrl) ?? database.value;
  const evalTopK = overrides.evalTopK ?? parsePositiveInteger(env.DOCS_RAG_PG_LAB_EVAL_TOP_K, 5);
  const healthTimeoutMs =
    overrides.healthTimeoutMs ?? parsePositiveInteger(env.DOCS_RAG_PG_LAB_DB_TIMEOUT_MS, 5_000);
  const embeddingBaseUrl =
    normalizeEnvValue(env.DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL) ?? 'http://127.0.0.1:8082';
  const embeddingModel =
    normalizeEnvValue(env.DOCS_RAG_PG_LAB_EMBEDDING_MODEL) ?? 'qwen3-embedding-1024';
  const embeddingTimeoutMs = parsePositiveInteger(env.DOCS_RAG_PG_LAB_EMBEDDING_TIMEOUT_MS, 60_000);
  const embeddingBatchSize = parsePositiveInteger(
    env.DOCS_RAG_PG_LAB_EMBEDDING_BATCH_SIZE ?? env.SYNC_EXTERNAL_EMBEDDING_BATCH_SIZE,
    8
  );
  const maxConcurrentEmbeddingBatches = parsePositiveInteger(
    env.DOCS_RAG_PG_LAB_EMBEDDING_MAX_CONCURRENT_BATCHES ??
      env.SYNC_EXTERNAL_EMBEDDING_MAX_CONCURRENT_BATCHES,
    1
  );
  const poolMax =
    overrides.poolMax !== undefined
      ? parseBoundedPoolValue(String(overrides.poolMax), 2, 1, 64)
      : parseBoundedPoolValue(env.DOCS_RAG_PG_LAB_DB_POOL_MAX, 2, 1, 64);
  const poolConnectionTimeoutMs =
    overrides.poolConnectionTimeoutMs !== undefined
      ? parseBoundedPoolValue(String(overrides.poolConnectionTimeoutMs), 5_000, 1_000, 120_000)
      : parseBoundedPoolValue(env.DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS, 5_000, 1_000, 120_000);
  const poolMaxLifetimeMs =
    overrides.poolMaxLifetimeMs !== undefined
      ? parseBoundedPoolValue(String(overrides.poolMaxLifetimeMs), 0, 60_000, 86_400_000, true)
      : parseBoundedPoolValue(env.DOCS_RAG_PG_LAB_DB_MAX_LIFETIME_MS, 0, 60_000, 86_400_000, true);

  return {
    tool: 'docs-rag-pg-lab',
    rootDir: resolveRepoPath(),
    defaultEvalFixturePath: resolveRepoPath(
      'scripts',
      'docs-rag',
      'fixtures',
      'eval-external-sources.json'
    ),
    evalTopK,
    healthTimeoutMs,
    embedding: {
      provider: 'llamacpp',
      model: embeddingModel,
      baseUrl: embeddingBaseUrl.replace(/\/$/u, ''),
      dimensions: 1024,
      timeoutMs: embeddingTimeoutMs,
      batchSize: embeddingBatchSize,
      maxConcurrentBatches: maxConcurrentEmbeddingBatches,
    },
    database: {
      url: databaseUrl,
      redactedUrl: redactPostgresUrl(databaseUrl),
      source: databaseUrl ? (database.source ?? 'override') : undefined,
    },
    pool: {
      max: poolMax,
      connectionTimeoutMs: poolConnectionTimeoutMs,
      maxLifetimeMs: poolMaxLifetimeMs,
    },
    gates: {
      liveSearchEnabled: parseBoolean(env.DOCS_RAG_PG_LAB_ENABLE_LIVE_SEARCH),
      embeddingEnabled: parseBoolean(env.DOCS_RAG_PG_LAB_ENABLE_EMBEDDING),
      mutationEnabled: parseBoolean(env.DOCS_RAG_PG_LAB_ENABLE_MUTATIONS),
    },
  };
}

export function resolveDocsRagLabConfigWithLocalDefault(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Pick<DocsRagLabConfig, 'evalTopK' | 'healthTimeoutMs'>> & {
    databaseUrl?: string;
    poolMax?: number;
    poolConnectionTimeoutMs?: number;
    poolMaxLifetimeMs?: number;
  } = {}
): DocsRagLabConfig {
  const config = resolveDocsRagLabConfig(
    {
      ...env,
      DOCS_RAG_PG_LAB_ENABLE_EMBEDDING: env.DOCS_RAG_PG_LAB_ENABLE_EMBEDDING ?? 'true',
    },
    overrides
  );
  if (!config.database.url) {
    throw new Error(
      'DOCS_RAG_PG_LAB_DATABASE_URL is required but not set. ' +
        'Set the environment variable to your Postgres connection string (e.g., postgres://user:pass@host:port/dbname).'
    );
  }
  return config;
}
