/**
 * Internal local-development-only Postgres URL.
 *
 * This value MUST NOT be used without explicit opt-in. It points at a
 * local Postgres instance (port 5542) trusted to accept
 * credential-free connections from the loopback interface.
 *
 * The only code path that may use this constant is
 * {@link resolveProjectRagPostgresConfigWithLocalDefault}, and only when
 * the caller has set `PROJECT_RAG_ALLOW_LOCAL_DEFAULT=1`.
 *
 * Production deployments must set `PROJECT_RAG_DATABASE_URL` (or one of
 * the fallback env vars) to a properly secured Postgres connection string.
 */
const LOCAL_DEV_DATABASE_URL = 'postgres://127.0.0.1:5542/docs_rag_lab';

export interface ProjectRagPoolConfig {
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

export interface ProjectRagPostgresConfig {
  readonly tool: 'project-rag-postgres';
  readonly healthTimeoutMs: number;
  readonly database: {
    readonly url?: string;
    readonly redactedUrl?: string;
    readonly source?: string;
  };
  readonly pool: ProjectRagPoolConfig;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/^['"]|['"]$/g, '') || undefined;
}

function redactPostgresUrl(value: string | undefined): string | undefined {
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
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
    'PROJECT_RAG_DATABASE_URL',
    'PROJECT_RAG_POSTGRES_URL',
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

/**
 * Resolve Project RAG Postgres config from environment variables.
 *
 * **No default database URL is applied.** When no env var is set the
 * returned `database.url` is `undefined`, which will cause downstream
 * connection attempts to fail. This is the safe choice for production
 * read paths: they must be explicitly configured.
 *
 * Prefer the more specific resolvers when the caller knows its intent:
 * - {@link resolveProjectRagPostgresConfigWithLocalDefault} – CLI/dev fallback
 * - {@link resolveProjectRagPostgresWriteConfig} – write path (throws if unset)
 *
 * Env var precedence (first non-empty wins):
 * 1. `PROJECT_RAG_DATABASE_URL`
 * 2. `PROJECT_RAG_POSTGRES_URL`
 * 3. `POSTGRES_URL`
 * 4. `DATABASE_URL`
 */
export function resolveProjectRagPostgresConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: {
    readonly databaseUrl?: string;
    readonly healthTimeoutMs?: number;
    readonly poolMax?: number;
    readonly poolConnectionTimeoutMs?: number;
    readonly poolMaxLifetimeMs?: number;
  } = {}
): ProjectRagPostgresConfig {
  const database = resolveDatabaseUrl(env);
  const databaseUrl = normalizeEnvValue(overrides.databaseUrl) ?? database.value;
  const healthTimeoutMs =
    overrides.healthTimeoutMs ?? parsePositiveInteger(env.PROJECT_RAG_DB_TIMEOUT_MS, 5_000);
  const poolMax =
    overrides.poolMax !== undefined
      ? parseBoundedPoolValue(String(overrides.poolMax), 2, 1, 64)
      : parseBoundedPoolValue(env.PROJECT_RAG_DB_POOL_MAX, 2, 1, 64);
  const poolConnectionTimeoutMs =
    overrides.poolConnectionTimeoutMs !== undefined
      ? parseBoundedPoolValue(String(overrides.poolConnectionTimeoutMs), 5_000, 1_000, 120_000)
      : parseBoundedPoolValue(env.PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS, 5_000, 1_000, 120_000);
  const poolMaxLifetimeMs =
    overrides.poolMaxLifetimeMs !== undefined
      ? parseBoundedPoolValue(String(overrides.poolMaxLifetimeMs), 0, 60_000, 86_400_000, true)
      : parseBoundedPoolValue(env.PROJECT_RAG_DB_MAX_LIFETIME_MS, 0, 60_000, 86_400_000, true);

  return {
    tool: 'project-rag-postgres',
    healthTimeoutMs,
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
  };
}

/**
 * Resolve Project RAG Postgres config, allowing a local-dev-only fallback
 * **only** when explicitly opted in via `PROJECT_RAG_ALLOW_LOCAL_DEFAULT=1`.
 *
 * Normal behavior (no env, no override, no opt-in):
 *   Throws a clear error telling the caller to configure
 *   `PROJECT_RAG_DATABASE_URL` or opt in with `PROJECT_RAG_ALLOW_LOCAL_DEFAULT=1`.
 *
 * Opt-in behavior (`PROJECT_RAG_ALLOW_LOCAL_DEFAULT=1` in env):
 *   Falls back to a hardcoded local-development Postgres URL when no
 *   other source provides one. This is intended for local CLI commands
 *   and test fixtures running against a known local Postgres instance.
 *
 * Production MCP read paths should use {@link resolveProjectRagPostgresConfig}
 * instead — that resolver never applies a default and returns `undefined`
 * for the database URL when no env var is set.
 *
 * @throws {Error} When no database URL is found and
 *   `PROJECT_RAG_ALLOW_LOCAL_DEFAULT` is not `'1'`.
 *
 * @see resolveProjectRagPostgresConfig - Production-safe resolver (no default)
 * @see resolveProjectRagPostgresWriteConfig - Write-path resolver (always throws if missing)
 */
export function resolveProjectRagPostgresConfigWithLocalDefault(
  env: NodeJS.ProcessEnv = process.env,
  overrides: {
    readonly databaseUrl?: string;
    readonly healthTimeoutMs?: number;
    readonly poolMax?: number;
    readonly poolConnectionTimeoutMs?: number;
    readonly poolMaxLifetimeMs?: number;
  } = {}
): ProjectRagPostgresConfig {
  const config = resolveProjectRagPostgresConfig(env, overrides);
  if (config.database.url) {
    return config;
  }

  const allowLocal = normalizeEnvValue(env.PROJECT_RAG_ALLOW_LOCAL_DEFAULT);
  if (allowLocal === '1') {
    return resolveProjectRagPostgresConfig(env, {
      ...overrides,
      databaseUrl: LOCAL_DEV_DATABASE_URL,
    });
  }

  throw new Error(
    'Project RAG requires an explicit Postgres URL. ' +
      'Set PROJECT_RAG_DATABASE_URL (or PROJECT_RAG_POSTGRES_URL, POSTGRES_URL, DATABASE_URL) ' +
      'in your environment, or opt into the local development default by setting ' +
      'PROJECT_RAG_ALLOW_LOCAL_DEFAULT=1.'
  );
}

/**
 * Resolve Project RAG Postgres config for write operations.
 *
 * Fails loudly when no database URL is configured — write operations must
 * never fall back to a local-dev default.
 *
 * @throws {Error} When no database URL is found via env or overrides.
 */
export function resolveProjectRagPostgresWriteConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: {
    readonly databaseUrl?: string;
    readonly healthTimeoutMs?: number;
    readonly poolMax?: number;
    readonly poolConnectionTimeoutMs?: number;
    readonly poolMaxLifetimeMs?: number;
  } = {}
): ProjectRagPostgresConfig {
  const config = resolveProjectRagPostgresConfig(env, overrides);
  if (!config.database.url) {
    throw new Error(
      'Project RAG write operations require an explicit Postgres URL. Set PROJECT_RAG_DATABASE_URL first.'
    );
  }

  return config;
}
