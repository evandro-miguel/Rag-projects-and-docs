/**
 * Fixed-manifest schema migration runner for the two RAG Postgres lanes.
 *
 * Design contract (release-completion T-03):
 * - Fixed catalogs only: Project RAG `infra/project-rag/sql/001..013` and
 *   Docs RAG `infra/docs-rag/sql/001..005`. No directory scanning.
 * - Ledger: `public.rag_schema_migrations`, keyed by (lane, ordinal), with
 *   exact raw-byte SHA-256 checksums, `record_kind` of `executed` or
 *   `verified_adoption`, and a verifiable proof digest per row. The runner
 *   owns the ledger DDL and creates the table only inside mutating paths;
 *   historical SQL never creates it.
 * - Short-lived Bun.SQL pool with max=1; every mutating operation pins one
 *   reserved connection so session-level advisory locks stay attached for the
 *   whole run.
 * - One database-global advisory try-lock. Contention fails closed with
 *   MIGRATION_LOCK_BUSY instead of waiting or queueing.
 * - `status` and dry-run are strictly read-only: SELECT statements only, no
 *   ledger DDL, no advisory locks, no writes of any kind.
 * - Fresh install applies the full manifest only when the lane has no ledger
 *   rows and no lane footprint anchors.
 * - Valid-ledger contiguous suffix upgrades apply k+1..N after rows 1..k
 *   validate against current file checksums.
 * - No auto-baseline. Pre-ledger databases must go through explicit adoption:
 *   migration-specific postcondition probes prove a contiguous applied prefix,
 *   the runner publishes the proof digest in read-only status output, and
 *   execution requires that exact digest plus isolated-target acknowledgements.
 *   Unproven legacy states refuse without writing any ledger row.
 * - Checksum drift, ordinal gaps, unknown rows, bad record kinds, and proof
 *   mismatches fail closed before any script executes.
 * - The runner never wraps historical SQL in its own transaction; each script
 *   owns its boundaries (most files carry BEGIN/COMMIT, 008 is idempotent
 *   auto-commit DDL).
 *
 * All error output is structured, bounded, and credential-redacted; SQL file
 * contents are never included in errors or reports.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_LOCK_KEY } from './write-fence.js';

export { MIGRATION_LOCK_KEY };

export type MigrationLane = 'project' | 'docs';

export interface MigrationDescriptor {
  readonly lane: MigrationLane;
  readonly ordinal: number;
  readonly name: string;
  readonly relativePath: string;
}

export type Row = Record<string, unknown>;

/**
 * Minimal executor surface used by the runner. Production adapts a pinned
 * `Bun.SQL` reserved connection; tests inject fakes. All dynamic values are
 * passed as bind parameters; scripts execute as raw multi-statement text via
 * the simple query protocol because they own their transaction boundaries.
 */
export interface SqlExecutor {
  unsafe(text: string, values?: readonly unknown[]): Promise<Row[]>;
}

export interface ReservedSqlExecutor extends SqlExecutor {
  release(): Promise<void>;
}

/**
 * Adapt a pinned Bun.SQL reserved connection to the runner executor surface.
 * Multi-statement scripts run through the simple query protocol and come back
 * as nested per-statement result arrays; those are flattened. Callers of DDL
 * ignore results while single SELECTs yield flat row arrays.
 */
export function adaptReservedSql(reserved: {
  unsafe(text: string, values?: readonly unknown[]): Promise<unknown>;
  release(): Promise<void> | void;
}): ReservedSqlExecutor {
  return {
    async unsafe(text: string, values?: readonly unknown[]): Promise<Row[]> {
      const result = await reserved.unsafe(text, values ? [...values] : undefined);
      if (Array.isArray(result)) {
        return (result.some((item) => Array.isArray(item)) ? result.flat() : result) as Row[];
      }
      return [result] as Row[];
    },
    async release(): Promise<void> {
      await reserved.release();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fixed manifests                                                            */
/* -------------------------------------------------------------------------- */

function descriptor(
  lane: MigrationLane,
  ordinal: number,
  name: string,
  relativePath: string
): MigrationDescriptor {
  return { lane, ordinal, name, relativePath };
}

/** Project RAG lane: migrations 001..013 under infra/project-rag/sql. */
export const PROJECT_MIGRATIONS: readonly MigrationDescriptor[] = [
  descriptor('project', 1, '001-core', 'infra/project-rag/sql/001-core.sql'),
  descriptor(
    'project',
    2,
    '002-versioned-chunk-uniqueness',
    'infra/project-rag/sql/002-versioned-chunk-uniqueness.sql'
  ),
  descriptor(
    'project',
    3,
    '003-ingest-snapshot-gate',
    'infra/project-rag/sql/003-ingest-snapshot-gate.sql'
  ),
  descriptor(
    'project',
    4,
    '004-blocked-finding-allowlist',
    'infra/project-rag/sql/004-blocked-finding-allowlist.sql'
  ),
  descriptor('project', 5, '005-snapshot-review', 'infra/project-rag/sql/005-snapshot-review.sql'),
  descriptor(
    'project',
    6,
    '006-context-identity',
    'infra/project-rag/sql/006-context-identity.sql'
  ),
  descriptor(
    'project',
    7,
    '007-index-build-publication',
    'infra/project-rag/sql/007-index-build-publication.sql'
  ),
  descriptor('project', 8, '008-durable-jobs', 'infra/project-rag/sql/008-durable-jobs.sql'),
  descriptor(
    'project',
    9,
    '009-sync-run-binding',
    'infra/project-rag/sql/009-sync-run-binding.sql'
  ),
  descriptor(
    'project',
    10,
    '010-version-owned-derived-data',
    'infra/project-rag/sql/010-version-owned-derived-data.sql'
  ),
  descriptor(
    'project',
    11,
    '011-scope-identity-completeness',
    'infra/project-rag/sql/011-scope-identity-completeness.sql'
  ),
  descriptor(
    'project',
    12,
    '012-durable-job-lifecycle',
    'infra/project-rag/sql/012-durable-job-lifecycle.sql'
  ),
  descriptor(
    'project',
    13,
    '013-snapshot-review-repair',
    'infra/project-rag/sql/013-snapshot-review-repair.sql'
  ),
];

/** Docs RAG lane: migrations 001..005 under infra/docs-rag/sql. */
export const DOCS_MIGRATIONS: readonly MigrationDescriptor[] = [
  descriptor('docs', 1, '001-core', 'infra/docs-rag/sql/001-core.sql'),
  descriptor('docs', 2, '002-eval', 'infra/docs-rag/sql/002-eval.sql'),
  descriptor(
    'docs',
    3,
    '003-processing-provenance',
    'infra/docs-rag/sql/003-processing-provenance.sql'
  ),
  descriptor('docs', 4, '004-source-generations', 'infra/docs-rag/sql/004-source-generations.sql'),
  descriptor(
    'docs',
    5,
    '005-generation-publication-integrity',
    'infra/docs-rag/sql/005-generation-publication-integrity.sql'
  ),
];

/** Runner-owned catalog identity for the migration-005 publication guard. */
export const DOCS_PUBLICATION_VALIDATOR_METADATA = Object.freeze({
  functionName: 'docs_rag_assert_generation_publishable',
  identityArguments: 'bigint,text',
  prosrcSha256: '3af303b0accee1af187a3b7e86940968d5d7d263dfa7cc9bd649efb7b495467d',
} as const);

export function manifestForLane(lane: MigrationLane): readonly MigrationDescriptor[] {
  return lane === 'project' ? PROJECT_MIGRATIONS : DOCS_MIGRATIONS;
}

export function isMigrationLane(value: unknown): value is MigrationLane {
  return value === 'project' || value === 'docs';
}

/* -------------------------------------------------------------------------- */
/* Lane configuration                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Explicit lane URL environment variables. Generic fallbacks such as
 * DATABASE_URL or POSTGRES_URL are deliberately never consulted.
 */
export const LANE_URL_ENV: Readonly<Record<MigrationLane, string>> = {
  project: 'PROJECT_RAG_DATABASE_URL',
  docs: 'DOCS_RAG_PG_LAB_DATABASE_URL',
};

/**
 * Known official database identities and listener ports. Mutating migration
 * commands use a positive disposable-target policy below instead of relying
 * on this denylist alone; these values provide explicit fail-closed coverage
 * for the repository's supported official lanes.
 */
export const OFFICIAL_DATABASE_NAMES: readonly string[] = [
  'docs_rag_lab',
  'docs_lab',
  'rag_engine',
  'rag_dev',
  'project_rag',
  'project_rag_lab',
];

export const OFFICIAL_DATABASE_PORTS: readonly number[] = [5432, 5440, 5441, 5542, 6542];

/** Retained as a compatibility fixture for existing callers/tests. */
export const OFFICIAL_DEFAULT_URLS: readonly string[] = [
  'postgres://127.0.0.1:5542/docs_rag_lab',
  'postgres://127.0.0.1:5440/rag_engine',
];

const DISPOSABLE_DATABASE_NAME = /^rag_v2_migration_[a-z0-9][a-z0-9_-]{0,45}$/;
// Sensitive detail-key vocabulary: values under any such key are fully
// redacted regardless of shape. 'credential' covers credentials/client
// credential holders the same way the URL-query vocabulary does.
const SENSITIVE_KEY_PATTERN = /password|passwd|credential|secret|token|key/i;
const MAX_LEDGER_FIELD_LENGTH = 128;
const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_ITEMS = 24;
const MAX_LEDGER_QUERY_ROWS = 10_000;

export interface MigrationTargetIdentity {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Credential-free canonical target fingerprint. */
  readonly fingerprint: string;
  /** Credential-free, bounded display identity. */
  readonly redactedUrl: string;
}

/** Connected-server identity used by the official coordinator. */
export interface ServerFingerprintV2 {
  readonly version: 'v2';
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly systemIdentifier: string;
  readonly databaseOid: string;
  readonly fingerprint: string;
}

export function fingerprintV2For(input: {
  host: string;
  port: number;
  database: string;
  systemIdentifier: string;
  databaseOid: string;
}): string {
  return sha256Text(
    JSON.stringify({
      host: input.host,
      port: input.port,
      database: input.database,
      systemIdentifier: input.systemIdentifier,
      databaseOid: input.databaseOid,
    })
  );
}

/** Read the cluster/database identity over the already-connected lane. */
export async function readServerFingerprintV2(
  db: SqlExecutor,
  target: MigrationTargetIdentity
): Promise<ServerFingerprintV2> {
  const rows = await db.unsafe(
    `select (pg_control_system()).system_identifier::text as system_identifier,
            (select oid::text from pg_database where datname = current_database()) as database_oid,
            current_database() as database`
  );
  const row = rows[0] ?? {};
  const systemIdentifier = String(row.system_identifier ?? row.systemIdentifier ?? '').trim();
  const databaseOid = String(row.database_oid ?? row.databaseOid ?? '').trim();
  const connectedDatabase = String(row.database ?? '').trim();
  if (
    !systemIdentifier ||
    !databaseOid ||
    (connectedDatabase && connectedDatabase !== target.database)
  ) {
    throw new MigrationRunnerError(
      'MIGRATION_FINGERPRINT_MISMATCH',
      'connected database did not return a complete v2 fingerprint identity'
    );
  }
  return {
    version: 'v2',
    host: target.host,
    port: target.port,
    database: target.database,
    systemIdentifier,
    databaseOid,
    fingerprint: fingerprintV2For({
      host: target.host,
      port: target.port,
      database: target.database,
      systemIdentifier,
      databaseOid,
    }),
  };
}

function canonicalHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function isContainedPath(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function decodeDatabasePath(pathname: string): string {
  if (!pathname.startsWith('/') || pathname.length <= 1) {
    throw new MigrationRunnerError(
      'MIGRATION_URL_REJECTED',
      'database URL must include a database name'
    );
  }
  let database: string;
  try {
    database = decodeURIComponent(pathname.slice(1));
  } catch {
    throw new MigrationRunnerError(
      'MIGRATION_URL_REJECTED',
      'database URL contains invalid path encoding'
    );
  }
  if (!database || database.includes('/') || database.includes('\u0000')) {
    throw new MigrationRunnerError(
      'MIGRATION_URL_REJECTED',
      'database URL contains an invalid database name'
    );
  }
  return database;
}

/** Parse one URL into a credential-free canonical server/database identity. */
export function canonicalizeMigrationTarget(rawValue: string): MigrationTargetIdentity {
  const raw = rawValue.trim().replace(/^['"]|['"]$/g, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MigrationRunnerError(
      'MIGRATION_URL_REJECTED',
      'database URL is not a valid Postgres URL'
    );
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new MigrationRunnerError(
      'MIGRATION_URL_REJECTED',
      'database URL must use the Postgres scheme'
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    throw new MigrationRunnerError('MIGRATION_URL_REJECTED', 'database URL must include a host');
  }
  const port = url.port ? Number(url.port) : 5432;
  const database = decodeDatabasePath(url.pathname);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MigrationRunnerError(
      'MIGRATION_URL_REJECTED',
      'database URL contains an invalid port'
    );
  }
  const canonicalIdentity = { protocol: 'postgres', host, port, database };
  return {
    host,
    port,
    database,
    fingerprint: sha256Text(JSON.stringify(canonicalIdentity)),
    redactedUrl: `postgres://${canonicalHostForUrl(host)}:${port}/${encodeURIComponent(database)}`,
  };
}

export function assertDisposableMigrationTarget(
  rawValue: string,
  identity: MigrationTargetIdentity
): void {
  const raw = rawValue.trim().replace(/^['"]|['"]$/g, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MigrationRunnerError(
      'MIGRATION_TARGET_NOT_ISOLATED',
      'migration target is not a valid disposable Postgres URL'
    );
  }
  if (identity.host !== '127.0.0.1' && identity.host !== '::1') {
    throw new MigrationRunnerError(
      'MIGRATION_TARGET_NOT_ISOLATED',
      'mutating migrations require the target host to be the loopback address 127.0.0.1 or ::1'
    );
  }
  if (!url.port || OFFICIAL_DATABASE_PORTS.includes(identity.port)) {
    throw new MigrationRunnerError(
      'MIGRATION_TARGET_NOT_ISOLATED',
      'mutating migrations require an explicit non-official disposable listener port'
    );
  }
  if (
    OFFICIAL_DATABASE_NAMES.includes(identity.database) ||
    !DISPOSABLE_DATABASE_NAME.test(identity.database)
  ) {
    throw new MigrationRunnerError(
      'MIGRATION_TARGET_NOT_ISOLATED',
      'mutating migrations require a database named rag_v2_migration_<lowercase-token>'
    );
  }
  if (url.search || url.hash) {
    throw new MigrationRunnerError(
      'MIGRATION_TARGET_NOT_ISOLATED',
      'mutating migration URLs may not contain query or fragment overrides'
    );
  }
}

const LEDGER_TABLE = 'public.rag_schema_migrations';

/**
 * Runner-owned ledger DDL. Historical migration files never create this
 * table, so mutating paths must ensure it exists after the advisory lock is
 * held and before any script executes or any row is written. Read-only paths
 * (status, dry-run) never call this; a missing table simply reads as an empty
 * ledger.
 */
const CREATE_LEDGER_SQL = `
create table if not exists ${LEDGER_TABLE} (
  lane text not null,
  ordinal integer not null,
  name text not null,
  checksum_sha256 text not null,
  record_kind text not null check (record_kind in ('executed', 'verified_adoption')),
  proof_digest text not null,
  applied_at timestamptz not null default now(),
  primary key (lane, ordinal)
)`;

export async function ensureLedgerTable(db: SqlExecutor): Promise<void> {
  await db.unsafe(CREATE_LEDGER_SQL);
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type MigrationErrorCode =
  | 'MIGRATION_LOCK_BUSY'
  | 'MIGRATION_CHECKSUM_DRIFT'
  | 'MIGRATION_LEDGER_GAP'
  | 'MIGRATION_LEDGER_UNKNOWN_ROW'
  | 'MIGRATION_LEDGER_INVALID'
  | 'MIGRATION_ADOPTION_REQUIRED'
  | 'MIGRATION_ADOPTION_UNSUPPORTED'
  | 'MIGRATION_ACK_REQUIRED'
  | 'MIGRATION_TARGET_NOT_ISOLATED'
  | 'MIGRATION_CHALLENGE_MISMATCH'
  | 'MIGRATION_URL_REJECTED'
  | 'MIGRATION_APPLY_FAILED'
  | 'MIGRATION_LANE_UNKNOWN'
  | 'MIGRATION_OFFICIAL_ACK_REQUIRED'
  | 'MIGRATION_OFFICIAL_TARGET_REJECTED'
  | 'MIGRATION_FINGERPRINT_MISMATCH'
  | 'MIGRATION_ARTIFACT_INVALID'
  | 'MIGRATION_ARTIFACT_EXPIRED'
  | 'MIGRATION_RECEIPT_MISMATCH'
  | 'MIGRATION_DRAIN_REQUIRED'
  | 'MIGRATION_AUDIT_FAILED'
  | 'MIGRATION_ROLLBACK_REQUIRED';

export class MigrationRunnerError extends Error {
  override readonly name = 'MigrationRunnerError';
  readonly code: MigrationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: MigrationErrorCode, message: string, details?: Record<string, unknown>) {
    super(redactSensitiveText(message));
    this.code = code;
    this.details = details ? redactDetails(details) : undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Redaction and text bounds                                                  */
/* -------------------------------------------------------------------------- */

const MAX_TEXT = 300;

/** Bound a message and strip control characters so output stays structured. */
export function boundText(text: string): string {
  const flat = [...String(text)]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? ' ' : char;
    })
    .join('');
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 3)}...` : flat;
}

/** Redact passwords in a Postgres URL for display. */
export function redactPostgresUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = '***';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
        url.searchParams.set(key, '***');
      }
    }
    return url.toString();
  } catch {
    return redactUrlQuerySecrets(
      value
        .replace(/:([^:@/]+)@/, ':***@')
        .replace(/(password|passwd|secret|token|key)=([^&\s]+)/gi, '$1=***')
    );
  }
}

function redactSensitiveText(value: string): string {
  const urlsRedacted = String(value).replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, (url) =>
    redactPostgresUrl(url)
  );
  // Generic key=value pass first (covers plain text), then the broader
  // URL-query pass (?pwd=, &jwt=, ?credentials=, ...) on the result.
  const generic = urlsRedacted.replace(/(password|passwd|secret|token|key)=([^&\s]+)/gi, '$1=***');
  return boundText(redactUrlQuerySecrets(generic));
}

/**
 * Sensitive URL/query parameter vocabulary. Broader than the generic
 * key=value text pass so access_token, apikey, client_secret, jwt, pwd,
 * credentials, signature, and auth-style parameters are covered even when
 * URL parsing fails or the scheme is not Postgres.
 */
const SENSITIVE_QUERY_KEY_PATTERN =
  /(?:password|passwd|pwd|secret|token|key|credential|auth|signature|jwt)/i;

const URL_QUERY_SECRET_PATTERN =
  /([?&#])([a-z0-9_.~-]*(?:password|passwd|pwd|secret|token|key|credential|auth|signature|jwt)[a-z0-9_.~-]*)=([^&\s'"]*)/gi;

/** Well-formed absolute http(s) URLs eligible for structured query parsing. */
const WELL_FORMED_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * Bounded malformed-query fallback: one '?'/'&'-led run of pairs without
 * whitespace, quotes, or markup. Pair count and pair length are capped so a
 * hostile ledger row cannot force unbounded work here.
 */
const QUERY_RUN_PATTERN = /[?&][^\s'"&<>]{0,512}(?:&[^\s'"&<>]{0,512}){0,63}/g;
const MAX_QUERY_PAIRS = 64;
const MAX_QUERY_RUN_LENGTH = 4096;
const MAX_QUERY_KEY_TOKEN_LENGTH = 256;

/**
 * Safely decode one percent-encoded query-key candidate. Decoding is bounded
 * and rejects empty or control-character results, so hostile encoded input is
 * never expanded into executable or structural output content; malformed
 * sequences fail closed to `null` (literal matching still applies).
 */
function safeDecodeQueryKey(token: string): string | null {
  if (!token.includes('%') || token.length > MAX_QUERY_KEY_TOKEN_LENGTH) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(token);
    if (!decoded) {
      return null;
    }
    // Reject control characters (same policy as boundText) so hostile encoded
    // input can never expand into executable or structural output content.
    for (const char of decoded) {
      const code = char.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f) {
        return null;
      }
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Decide sensitivity from the raw key and (optionally) its URL-decoded form.
 * Percent-encoded names such as `api%5Fkey`, `creden%74ials`, or encoded case
 * variants like `ACCESS%5FTOKEN` must redact exactly like their literal forms.
 */
function isSensitiveQueryKey(rawKey: string, decodedKey?: string): boolean {
  if (SENSITIVE_QUERY_KEY_PATTERN.test(rawKey)) {
    return true;
  }
  const decoded = decodedKey ?? safeDecodeQueryKey(rawKey);
  return decoded !== null && SENSITIVE_QUERY_KEY_PATTERN.test(decoded);
}

/** Redact one raw `&`-separated query segment, preserving original bytes otherwise. */
function redactQueryPairSegment(segment: string, decodedKeys?: readonly string[]): string {
  const rawPairs = segment.split('&');
  if (rawPairs.length > MAX_QUERY_PAIRS) {
    return segment;
  }
  let changed = false;
  const rebuilt = rawPairs.map((pair, index) => {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      return pair;
    }
    const rawKey = pair.slice(0, eq);
    if (isSensitiveQueryKey(rawKey, decodedKeys?.[index])) {
      changed = true;
      return `${rawKey}=***`;
    }
    return pair;
  });
  return changed ? rebuilt.join('&') : segment;
}

/**
 * Redact sensitive query parameters of well-formed absolute URLs. URL and
 * URLSearchParams provide authoritative percent-decoding of key names while
 * output keeps every non-sensitive pair byte-identical (no re-serialization
 * drift), so only sensitive values are replaced.
 */
function redactWellFormedUrlQueries(text: string): string {
  return text.replace(WELL_FORMED_URL_PATTERN, (candidate) => {
    const queryStart = candidate.indexOf('?');
    if (
      queryStart < 0 ||
      candidate.length - queryStart > MAX_QUERY_RUN_LENGTH ||
      candidate.length - queryStart <= 1
    ) {
      return candidate;
    }
    const rawQuery = candidate.slice(queryStart + 1);
    try {
      const parsed = new URL(candidate);
      const decodedKeys = [...parsed.searchParams.keys()];
      if (decodedKeys.length !== rawQuery.split('&').length) {
        // Parser-structure drift edge: fall back to the bounded raw pass.
        return `${candidate.slice(0, queryStart + 1)}${redactQueryPairSegment(rawQuery)}`;
      }
      const redacted = redactQueryPairSegment(rawQuery, decodedKeys);
      return redacted === rawQuery ? candidate : `${candidate.slice(0, queryStart + 1)}${redacted}`;
    } catch {
      return `${candidate.slice(0, queryStart + 1)}${redactQueryPairSegment(rawQuery)}`;
    }
  });
}

/** Bounded fallback for bare/malformed query runs embedded in free text. */
function redactMalformedQueryRuns(text: string): string {
  return text.replace(
    QUERY_RUN_PATTERN,
    (run) => `${run[0]}${redactQueryPairSegment(run.slice(1))}`
  );
}

/**
 * Redact sensitive query parameters in any text that may embed a URL,
 * including percent-encoded parameter names. Structured URL parsing runs
 * first, then the literal-name regex pass, then the bounded malformed-query
 * fallback for fragments that never parse as URLs.
 */
export function redactUrlQuerySecrets(text: string): string {
  const structured = redactWellFormedUrlQueries(text);
  const literal = structured.replace(
    URL_QUERY_SECRET_PATTERN,
    (_match, lead: string, key: string) => {
      return `${lead}${key}=***`;
    }
  );
  return redactMalformedQueryRuns(literal);
}

function sanitizeDetail(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (depth >= MAX_DETAIL_DEPTH) {
    // At or beyond the depth limit, composite values must never pass through
    // unchanged: a nested object/array could carry secrets under keys that
    // would otherwise never be examined again. Replace the whole subtree with
    // a bounded marker so nothing below the limit can bypass sanitization.
    // Primitive values (and already-redacted strings above) stay intact.
    return value !== null && typeof value === 'object' ? '[TRUNCATED]' : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ITEMS).map((item) => sanitizeDetail(item, depth + 1));
  }
  const objectValue = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(objectValue).slice(0, MAX_DETAIL_ITEMS)) {
    // Classify sensitivity from the ORIGINAL key: boundText truncates keys
    // longer than MAX_TEXT, which can cut off a trailing password/token
    // suffix and let a secret value bypass masking entirely. The bounded key
    // is used only for structured output.
    const boundedKey = boundText(key);
    // A value under a sensitive key is fully redacted regardless of its
    // shape: primitives, objects, arrays, and null all become '[REDACTED]'
    // so nested secrets cannot leak through structure.
    output[boundedKey] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeDetail(item, depth + 1);
  }
  return output;
}

export function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDetail(details, 0) as Record<string, unknown>;
}

/**
 * Final sanitization pass over any status/apply/adopt report before it may
 * reach CLI JSON output. Ledger rows are untrusted database content: row
 * names, record kinds, and validation details are treated as attacker-
 * controllable text, so every string is credential-redacted and bounded and
 * every value under a sensitive key is fully replaced.
 */
function sanitizeReport<T>(report: T): T {
  return sanitizeDetail(report, 0) as T;
}

/** Extract a bounded message plus optional SQLSTATE from an unknown throw. */
export function describeError(error: unknown): { message: string; pgCode?: string } {
  if (error instanceof Error) {
    const candidate = error as { errno?: unknown; code?: unknown };
    const pgCode = [candidate.errno, candidate.code]
      .map((value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : ''))
      .find((value) => /^[0-9A-Z]{5}$/.test(value));
    return pgCode
      ? { message: redactSensitiveText(error.message), pgCode }
      : { message: redactSensitiveText(error.message) };
  }
  return { message: redactSensitiveText(String(error)) };
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

export interface LoadedMigration {
  readonly descriptor: MigrationDescriptor;
  /** Exact raw-byte SHA-256 of the migration file. */
  readonly checksumSha256: string;
  readonly sqlText: string;
}

/** Module-derived repository root; CLI callers must not depend on their CWD. */
export const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function migrationPathError(item: MigrationDescriptor, reason: string): MigrationRunnerError {
  return new MigrationRunnerError(
    'MIGRATION_APPLY_FAILED',
    `fixed-manifest migration ${item.relativePath} is not a regular file inside the canonical lane root: ${reason}`
  );
}

/** Load every manifest migration, rejecting symlinks and containment escapes. */
export async function loadManifest(
  repoRoot: string,
  lane: MigrationLane
): Promise<readonly LoadedMigration[]> {
  let canonicalRepoRoot: string;
  let canonicalLaneRoot: string;
  try {
    canonicalRepoRoot = await realpath(repoRoot);
    canonicalLaneRoot = await realpath(
      join(canonicalRepoRoot, lane === 'project' ? 'infra/project-rag/sql' : 'infra/docs-rag/sql')
    );
  } catch (error) {
    throw new MigrationRunnerError(
      'MIGRATION_APPLY_FAILED',
      `cannot resolve the canonical ${lane} migration root: ${describeError(error).message}`
    );
  }
  // Security invariant: the resolved lane root must stay inside the resolved
  // repository root. A symlinked lane directory (or any parent) that escapes
  // must fail closed here, before any manifest file is read or executed.
  if (!isContainedPath(canonicalRepoRoot, canonicalLaneRoot)) {
    throw new MigrationRunnerError(
      'MIGRATION_APPLY_FAILED',
      `canonical ${lane} migration root escaped the canonical repository root; refusing to load fixed-manifest files through a symlinked path`,
      {}
    );
  }
  const loaded: LoadedMigration[] = [];
  for (const item of manifestForLane(lane)) {
    const absolutePath = resolve(canonicalRepoRoot, item.relativePath);
    let bytes: Buffer;
    try {
      if (
        !isContainedPath(canonicalRepoRoot, absolutePath) ||
        !isContainedPath(canonicalLaneRoot, absolutePath)
      ) {
        throw migrationPathError(item, 'path containment check failed');
      }
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw migrationPathError(item, 'file must be a non-symlink regular file');
      }
      const canonicalFile = await realpath(absolutePath);
      if (!isContainedPath(canonicalLaneRoot, canonicalFile)) {
        throw migrationPathError(item, 'resolved path escaped the canonical lane root');
      }
      bytes = await readFile(canonicalFile);
    } catch (error) {
      if (error instanceof MigrationRunnerError) {
        throw error;
      }
      throw new MigrationRunnerError(
        'MIGRATION_APPLY_FAILED',
        `cannot read fixed-manifest migration ${item.relativePath}: ${describeError(error).message}`,
        { ordinal: item.ordinal }
      );
    }
    loaded.push({
      descriptor: item,
      checksumSha256: sha256Bytes(bytes),
      sqlText: bytes.toString('utf8'),
    });
  }
  return loaded;
}

/* -------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* -------------------------------------------------------------------------- */

export type RecordKind = 'executed' | 'verified_adoption';

export interface LedgerRow {
  readonly lane: MigrationLane;
  readonly ordinal: number;
  readonly name: string;
  readonly checksumSha256: string;
  readonly recordKind: RecordKind;
  readonly proofDigest: string;
}

/** Proof digest binds a row to its exact content; recomputable for tamper checks. */
export function proofDigestFor(input: {
  kind: RecordKind;
  lane: MigrationLane;
  ordinal: number;
  name: string;
  checksum: string;
}): string {
  return sha256Text(
    JSON.stringify({
      checksum: input.checksum,
      kind: input.kind,
      lane: input.lane,
      name: input.name,
      ordinal: input.ordinal,
    })
  );
}

export interface LedgerReadResult {
  readonly present: boolean;
  readonly rows: readonly LedgerRow[];
}

function isMissingRelation(error: unknown): boolean {
  const candidate = error as { errno?: unknown; code?: unknown } | null;
  return String(candidate?.errno ?? '') === '42P01' || String(candidate?.code ?? '') === '42P01';
}

/** Read ledger rows for one lane. A missing table reads as present=false. */
export async function readLedger(
  db: SqlExecutor,
  lane: MigrationLane,
  maxRows?: number
): Promise<LedgerReadResult> {
  try {
    const boundedLimit =
      maxRows && Number.isInteger(maxRows) && maxRows > 0
        ? Math.min(maxRows, MAX_LEDGER_QUERY_ROWS)
        : undefined;
    const query =
      'select ordinal, name, checksum_sha256, record_kind, proof_digest ' +
      `from ${LEDGER_TABLE} where lane = $1 order by ordinal asc` +
      (boundedLimit ? ' limit $2' : '');
    const values = boundedLimit ? [lane, boundedLimit] : [lane];
    const rows = await db.unsafe(query, values);
    return { present: true, rows: asLedgerRows(lane, rows) };
  } catch (error) {
    if (isMissingRelation(error)) {
      return { present: false, rows: [] };
    }
    throw error;
  }
}

function asLedgerRows(lane: MigrationLane, rows: readonly Row[]): LedgerRow[] {
  return rows.map((row) => ({
    lane,
    ordinal: Number(row.ordinal),
    name: String(row.name).slice(0, MAX_LEDGER_FIELD_LENGTH + 1),
    checksumSha256: String(row.checksum_sha256).slice(0, MAX_LEDGER_FIELD_LENGTH + 1),
    recordKind: String(row.record_kind).slice(0, MAX_LEDGER_FIELD_LENGTH + 1) as RecordKind,
    proofDigest: String(row.proof_digest).slice(0, MAX_LEDGER_FIELD_LENGTH + 1),
  }));
}

/* -------------------------------------------------------------------------- */
/* Validation and classification                                              */
/* -------------------------------------------------------------------------- */

export type LedgerIssueCode =
  | 'CHECKSUM_DRIFT'
  | 'UNKNOWN_ROW'
  | 'GAP'
  | 'BAD_RECORD_KIND'
  | 'PROOF_DIGEST_MISMATCH'
  | 'ROW_COUNT_EXCEEDED'
  | 'FIELD_TOO_LARGE'
  | 'LEDGER_WITHOUT_FOOTPRINT';

export interface LedgerIssue {
  readonly code: LedgerIssueCode;
  readonly detail: string;
}

function issueForCode(code: LedgerIssueCode): MigrationErrorCode {
  switch (code) {
    case 'CHECKSUM_DRIFT':
      return 'MIGRATION_CHECKSUM_DRIFT';
    case 'GAP':
      return 'MIGRATION_LEDGER_GAP';
    case 'UNKNOWN_ROW':
      return 'MIGRATION_LEDGER_UNKNOWN_ROW';
    case 'ROW_COUNT_EXCEEDED':
      return 'MIGRATION_LEDGER_INVALID';
    default:
      return 'MIGRATION_LEDGER_INVALID';
  }
}

/**
 * Validate recorded ledger rows against the fixed manifest and current file
 * checksums. Any drift, gap, unknown row, bad kind, or proof mismatch is an
 * issue; callers fail closed on any issue.
 */
export function validateLedger(
  manifest: readonly LoadedMigration[],
  rows: readonly LedgerRow[]
): LedgerIssue[] {
  const issues: LedgerIssue[] = [];
  const byOrdinal = new Map(manifest.map((m) => [m.descriptor.ordinal, m]));
  const validOrdinals = new Set<number>();

  for (const row of rows) {
    if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 1 || row.ordinal > manifest.length) {
      issues.push({
        code: 'UNKNOWN_ROW',
        detail: 'ledger contains an ordinal outside the fixed manifest range',
      });
      continue;
    }
    validOrdinals.add(row.ordinal);
    if (
      row.name.length > MAX_LEDGER_FIELD_LENGTH ||
      row.recordKind.length > MAX_LEDGER_FIELD_LENGTH ||
      row.checksumSha256.length > MAX_LEDGER_FIELD_LENGTH ||
      row.proofDigest.length > MAX_LEDGER_FIELD_LENGTH
    ) {
      issues.push({
        code: 'FIELD_TOO_LARGE',
        detail: `ledger row ${row.ordinal} contains a field exceeding ${MAX_LEDGER_FIELD_LENGTH} characters`,
      });
      continue;
    }
    const known = byOrdinal.get(row.ordinal);
    if (!known || known.descriptor.name !== row.name) {
      issues.push({
        code: 'UNKNOWN_ROW',
        detail: `ledger row ordinal ${row.ordinal} does not match the fixed manifest`,
      });
      continue;
    }
    if (row.checksumSha256 !== known.checksumSha256) {
      issues.push({
        code: 'CHECKSUM_DRIFT',
        detail: `checksum drift for migration ${row.ordinal} (${row.name}): ledger vs current file bytes`,
      });
    }
    if (row.recordKind !== 'executed' && row.recordKind !== 'verified_adoption') {
      issues.push({
        code: 'BAD_RECORD_KIND',
        detail: `bad record_kind '${row.recordKind}' at ordinal ${row.ordinal}`,
      });
    }
    const expectedProof = proofDigestFor({
      kind: row.recordKind,
      lane: row.lane,
      ordinal: row.ordinal,
      name: row.name,
      checksum: row.checksumSha256,
    });
    if (row.proofDigest !== expectedProof) {
      issues.push({
        code: 'PROOF_DIGEST_MISMATCH',
        detail: `proof digest mismatch at ordinal ${row.ordinal}`,
      });
    }
  }

  if (validOrdinals.size > 0) {
    const highestOrdinal = Math.max(...validOrdinals);
    for (let expected = 1; expected <= highestOrdinal; expected += 1) {
      if (!validOrdinals.has(expected)) {
        issues.push({
          code: 'GAP',
          detail: `ledger has no row for ordinal ${expected} but later ordinals exist`,
        });
      }
    }
  }
  if (rows.length > manifest.length) {
    issues.push({
      code: 'ROW_COUNT_EXCEEDED',
      detail: `ledger contains ${rows.length} rows but the fixed manifest has only ${manifest.length}`,
    });
  }
  return issues;
}

export type LaneState =
  | { kind: 'fresh' }
  | { kind: 'up_to_date'; appliedThrough: number }
  | { kind: 'upgrade_pending'; appliedThrough: number; pendingOrdinals: readonly number[] }
  | { kind: 'adoption_required' }
  | { kind: 'invalid_ledger'; issues: readonly LedgerIssue[] };

/**
 * Classify a lane from its footprint anchors and ledger contents.
 * Fresh requires zero ledger rows AND zero lane footprint.
 */
export function classifyLane(input: {
  manifest: readonly LoadedMigration[];
  ledgerPresent: boolean;
  rows: readonly LedgerRow[];
  footprintPresent: boolean;
}): LaneState {
  if (input.rows.length === 0 && !input.ledgerPresent) {
    return input.footprintPresent ? { kind: 'adoption_required' } : { kind: 'fresh' };
  }
  if (input.rows.length === 0 && input.ledgerPresent) {
    // Ledger table exists but holds nothing for this lane; footprint decides.
    return input.footprintPresent ? { kind: 'adoption_required' } : { kind: 'fresh' };
  }

  const issues = validateLedger(input.manifest, input.rows);
  if (!input.footprintPresent) {
    issues.push({
      code: 'LEDGER_WITHOUT_FOOTPRINT',
      detail:
        'ledger claims migrations for this lane but no lane schema anchor exists in this database',
    });
  }
  if (issues.length > 0) {
    return { kind: 'invalid_ledger', issues };
  }

  const appliedThrough = Math.max(...input.rows.map((r) => r.ordinal));
  if (appliedThrough >= input.manifest.length) {
    return { kind: 'up_to_date', appliedThrough };
  }
  const pendingOrdinals = Array.from(
    { length: input.manifest.length - appliedThrough },
    (_, i) => appliedThrough + i + 1
  );
  return { kind: 'upgrade_pending', appliedThrough, pendingOrdinals };
}

/* -------------------------------------------------------------------------- */
/* Footprint anchors                                                          */
/* -------------------------------------------------------------------------- */

const LANE_ANCHOR_RELATION: Readonly<Record<MigrationLane, string>> = {
  project: 'project_repositories',
  docs: 'docs_documents',
};

/** Read-only probe of the lane's base-table anchor in the current schema. */
export async function detectFootprint(db: SqlExecutor, lane: MigrationLane): Promise<boolean> {
  const rows = await db.unsafe('select to_regclass($1::text) is not null as present', [
    LANE_ANCHOR_RELATION[lane],
  ]);
  return rows[0]?.present === true;
}

/* -------------------------------------------------------------------------- */
/* Postcondition probes (adoption evidence)                                   */
/* -------------------------------------------------------------------------- */

export interface ProbeArtifact {
  readonly id: string;
  /** Self-contained boolean SQL expression over catalogs only. */
  readonly expr: string;
}

interface MigrationProbe {
  readonly ordinal: number;
  readonly artifacts: readonly ProbeArtifact[];
}

function tableExists(relation: string): string {
  return `to_regclass('${relation}') is not null`;
}

function columnExists(table: string, column: string): string {
  return `exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = '${table}' and column_name = '${column}')`;
}

function requiredColumnExists(table: string, column: string): string {
  return `exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = '${table}' and column_name = '${column}' and is_nullable = 'NO')`;
}

function constraintExists(constraint: string): string {
  return `exists (select 1 from pg_constraint where conname = '${constraint}')`;
}

function indexExists(table: string, index: string): string {
  return `exists (select 1 from pg_indexes where schemaname = current_schema() and tablename = '${table}' and indexname = '${index}')`;
}

function normalizeCatalogExpression(expression: string): string {
  return expression.toLowerCase().replace(/\s+/g, '').replace(/[()]/g, '');
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizedCatalogExpressionSql(expression: string): string {
  return `regexp_replace(regexp_replace(lower(${expression}), '[[:space:]]', '', 'g'), '[()]', '', 'g')`;
}

function constraintDefinitionMatches(
  table: string,
  constraint: string,
  definition: string
): string {
  return (
    `exists (select 1 from pg_constraint where conrelid = to_regclass('${table}') ` +
    `and conname = '${constraint}' and contype = 'c' ` +
    `and ${normalizedCatalogExpressionSql('pg_get_constraintdef(oid)')} = ` +
    `${sqlStringLiteral(normalizeCatalogExpression(definition))})`
  );
}

function indexDefinitionMatches(input: {
  readonly table: string;
  readonly index: string;
  readonly columns: readonly string[];
  readonly predicate: string;
  readonly unique: boolean;
}): string {
  const columnChecks = input.columns
    .map(
      (column, position) =>
        `pg_get_indexdef(i.indexrelid, ${position + 1}, true) = ${sqlStringLiteral(column)}`
    )
    .join(' and ');
  return (
    `exists (select 1 from pg_index i ` +
    `join pg_class idx on idx.oid = i.indexrelid ` +
    `join pg_class tbl on tbl.oid = i.indrelid ` +
    `join pg_namespace ns on ns.oid = tbl.relnamespace ` +
    `join pg_am am on am.oid = idx.relam ` +
    `where ns.nspname = current_schema() and tbl.relname = '${input.table}' ` +
    `and idx.relname = '${input.index}' and am.amname = 'btree' ` +
    `and i.indisvalid and i.indisready and i.indisunique = ${input.unique} ` +
    `and i.indnkeyatts = ${input.columns.length} and i.indnatts = ${input.columns.length} ` +
    `and i.indpred is not null and ${columnChecks} ` +
    `and ${normalizedCatalogExpressionSql('pg_get_expr(i.indpred, i.indrelid)')} = ` +
    `${sqlStringLiteral(normalizeCatalogExpression(input.predicate))})`
  );
}

function functionExists(name: string): string {
  return `exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = '${name}' and n.nspname = current_schema())`;
}

function functionDefinitionContains(name: string, marker: string): string {
  return (
    `exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace ` +
    `where p.proname = '${name}' and n.nspname = current_schema() ` +
    `and position(${sqlStringLiteral(marker)} in pg_get_functiondef(p.oid)) > 0)`
  );
}

function functionProsrcDigestMatches(
  name: string,
  identityArguments: string,
  prosrcSha256: string
): string {
  const identity = sqlStringLiteral(`${name}(${identityArguments})`);
  return (
    `exists (select 1 from pg_proc p ` +
    `join pg_namespace n on n.oid = p.pronamespace ` +
    `where p.oid = to_regprocedure(${identity})::oid ` +
    `and n.nspname = current_schema() ` +
    `and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = ` +
    `${sqlStringLiteral(prosrcSha256)})`
  );
}

function triggerExists(table: string, trigger: string): string {
  return `exists (select 1 from pg_trigger where tgname = '${trigger}' and tgrelid = to_regclass('${table}') and not tgisinternal)`;
}

function extensionInstalled(extension: string): string {
  return `exists (select 1 from pg_extension where extname = '${extension}')`;
}

/**
 * Check chunk embedding provenance without binding the probe query to the
 * migration-003 columns at parse time.  Adoption probes run against legacy
 * prefixes, so those columns legitimately do not exist until migration 003
 * executes.  `to_jsonb` reads the named fields dynamically while the catalog
 * guards make the artifact fail closed until both columns are present.
 */
function chunkEmbeddingExactInputComplete(): string {
  const inputTextColumn = columnExists('docs_embeddings', 'embedding_input_text');
  const inputHashColumn = columnExists('docs_embeddings', 'embedding_input_sha256');
  return (
    `(${inputTextColumn} and ${inputHashColumn} ` +
    `and not exists (select 1 from docs_embeddings e ` +
    `where e.chunk_id is not null ` +
    `and ((to_jsonb(e)->>'embedding_input_text') is null ` +
    `or (to_jsonb(e)->>'embedding_input_sha256') is null))` +
    `)`
  );
}

/**
 * Strong per-migration postconditions used ONLY as adoption evidence for
 * pre-ledger databases. Every artifact is distinctive to that migration
 * (named constraints/indexes/triggers/functions/columns), never just "a table
 * with this name exists".
 */
export const MIGRATION_PROBES: Readonly<Record<MigrationLane, readonly MigrationProbe[]>> = {
  project: [
    {
      ordinal: 1,
      artifacts: [
        { id: 'table_project_repositories', expr: tableExists('project_repositories') },
        { id: 'table_project_files', expr: tableExists('project_files') },
        { id: 'table_project_chunks', expr: tableExists('project_chunks') },
        { id: 'func_touch_updated_at', expr: functionExists('project_rag_touch_updated_at') },
        {
          id: 'func_refresh_chunk_search',
          expr: functionExists('project_rag_refresh_chunk_search'),
        },
        { id: 'ext_vector', expr: extensionInstalled('vector') },
      ],
    },
    {
      ordinal: 2,
      artifacts: [
        {
          id: 'constraint_versioned_chunk_unique',
          expr:
            `exists (select 1 from pg_constraint where conrelid = to_regclass('project_chunks') ` +
            `and conname = 'project_chunks_file_version_chunk_unique' ` +
            `and pg_get_constraintdef(oid) = 'UNIQUE (file_id, version_id, chunk_index)')`,
        },
      ],
    },
    {
      ordinal: 3,
      artifacts: [
        { id: 'table_project_ingest_snapshots', expr: tableExists('project_ingest_snapshots') },
        {
          id: 'trigger_freeze_binding_fields',
          expr: triggerExists(
            'project_ingest_snapshots',
            'project_ingest_snapshot_freeze_binding_fields'
          ),
        },
        {
          id: 'index_one_consuming',
          expr: indexExists(
            'project_ingest_snapshots',
            'project_ingest_snapshots_one_consuming_idx'
          ),
        },
        {
          id: 'constraint_fail_requires_code',
          expr: constraintExists('project_ingest_snapshots_fail_requires_code'),
        },
      ],
    },
    {
      ordinal: 4,
      artifacts: [
        {
          id: 'column_blocked_finding_allowlist_hash',
          expr: columnExists('project_ingest_snapshots', 'blocked_finding_allowlist_hash'),
        },
        {
          id: 'column_suppressed_blocked_findings',
          expr: columnExists('project_ingest_snapshots', 'suppressed_blocked_findings'),
        },
        {
          id: 'constraint_repo_allowlist_max_length',
          expr: constraintExists('project_repositories_blocked_finding_allowlist_max_length'),
        },
        {
          id: 'trigger_block_config_during_consuming',
          expr: triggerExists(
            'project_repositories',
            'project_repositories_block_config_during_consuming'
          ),
        },
      ],
    },
    {
      ordinal: 5,
      artifacts: [
        { id: 'table_snapshot_reviews', expr: tableExists('project_ingest_snapshot_reviews') },
        {
          id: 'table_review_decisions',
          expr: tableExists('project_ingest_snapshot_review_decisions'),
        },
        {
          id: 'unique_one_per_snapshot',
          expr: constraintExists('project_ingest_snapshot_reviews_one_per_snapshot'),
        },
        {
          id: 'trigger_reviews_immutable',
          expr: triggerExists(
            'project_ingest_snapshot_reviews',
            'project_ingest_snapshot_reviews_immutable'
          ),
        },
      ],
    },
    {
      ordinal: 6,
      artifacts: [
        { id: 'table_ctx_repositories', expr: tableExists('project_rag_repositories') },
        { id: 'table_ctx_workspaces', expr: tableExists('project_rag_workspaces') },
        { id: 'table_ctx_revisions', expr: tableExists('project_rag_revisions') },
        {
          id: 'index_revisions_identity_unique',
          expr: indexExists('project_rag_revisions', 'project_rag_revisions_identity_unique'),
        },
        {
          id: 'constraint_head_oid_check',
          expr: constraintExists('project_rag_revisions_head_oid_check'),
        },
      ],
    },
    {
      ordinal: 7,
      artifacts: [
        { id: 'table_index_builds', expr: tableExists('project_index_builds') },
        { id: 'table_index_build_files', expr: tableExists('project_index_build_files') },
        {
          id: 'index_one_published',
          expr: indexExists('project_index_builds', 'project_index_builds_one_published'),
        },
        {
          id: 'fk_build_files_build_project',
          expr: constraintExists('project_index_build_files_build_project_fk'),
        },
        {
          id: 'unique_files_id_project',
          expr: constraintExists('project_files_id_project_unique'),
        },
      ],
    },
    {
      ordinal: 8,
      artifacts: [
        { id: 'column_fence_token', expr: columnExists('project_jobs', 'fence_token') },
        { id: 'column_checkpoint', expr: columnExists('project_jobs', 'checkpoint') },
        { id: 'column_lease_expires_at', expr: columnExists('project_jobs', 'lease_expires_at') },
        {
          id: 'index_active_dedupe',
          expr: indexExists('project_jobs', 'project_jobs_active_dedupe_idx'),
        },
      ],
    },
    {
      ordinal: 9,
      artifacts: [
        {
          id: 'column_sync_snapshot_uuid',
          expr: columnExists('project_sync_runs', 'snapshot_uuid'),
        },
        { id: 'column_sync_job_id', expr: columnExists('project_sync_runs', 'job_id') },
        {
          id: 'constraint_sync_snapshot_project_fk',
          expr: constraintExists('project_sync_runs_snapshot_project_fk'),
        },
        {
          id: 'constraint_sync_job_project_fk',
          expr: constraintExists('project_sync_runs_job_project_fk'),
        },
        {
          id: 'index_sync_snapshot_binding_unique',
          expr: indexExists('project_sync_runs', 'project_sync_runs_snapshot_binding_unique'),
        },
        {
          id: 'index_sync_binding_lookup',
          expr: indexExists('project_sync_runs', 'project_sync_runs_binding_idx'),
        },
        {
          id: 'trigger_sync_binding_immutable',
          expr: triggerExists('project_sync_runs', 'project_sync_runs_freeze_binding_fields'),
        },
      ],
    },
    {
      ordinal: 10,
      artifacts: [
        {
          id: 'constraint_chunks_id_project_unique',
          expr: constraintExists('project_chunks_id_project_unique'),
        },
        {
          id: 'constraint_chunks_id_version_project_unique',
          expr: constraintExists('project_chunks_id_version_project_unique'),
        },
        {
          id: 'constraint_chunks_id_file_version_project_unique',
          expr: constraintExists('project_chunks_id_file_version_project_unique'),
        },
        {
          id: 'constraint_symbols_id_project_unique',
          expr: constraintExists('project_symbols_id_project_unique'),
        },
        {
          id: 'constraint_symbols_id_version_project_unique',
          expr: constraintExists('project_symbols_id_version_project_unique'),
        },
        {
          id: 'constraint_symbols_id_file_version_project_unique',
          expr: constraintExists('project_symbols_id_file_version_project_unique'),
        },
        {
          id: 'constraint_edges_id_project_unique',
          expr: constraintExists('project_edges_id_project_unique'),
        },
        {
          id: 'constraint_embeddings_id_project_unique',
          expr: constraintExists('project_embeddings_1024_id_project_unique'),
        },
        {
          id: 'constraint_versions_id_file_project_unique',
          expr: constraintExists('project_file_versions_id_file_project_unique'),
        },
        {
          id: 'fk_chunks_version_file_project',
          expr: constraintExists('project_chunks_version_file_project_fk'),
        },
        {
          id: 'fk_symbols_chunk_project',
          expr: constraintExists('project_symbols_chunk_project_fk'),
        },
        {
          id: 'fk_edges_target_symbol_project',
          expr: constraintExists('project_edges_target_symbol_project_fk'),
        },
        {
          id: 'fk_embeddings_file_version_project',
          expr: constraintExists('project_embeddings_1024_file_project_fk'),
        },
        {
          id: 'fk_embeddings_chunk_version_project',
          expr: constraintExists('project_embeddings_1024_chunk_version_project_fk'),
        },
        {
          id: 'fk_embeddings_symbol_version_project',
          expr: constraintExists('project_embeddings_1024_symbol_version_project_fk'),
        },
        {
          id: 'fk_build_files_version_file_project',
          expr: constraintExists('project_index_build_files_version_file_project_fk'),
        },
        {
          id: 'column_embeddings_profile_hash',
          expr: columnExists('project_embeddings_1024', 'embedding_profile_hash'),
        },
        {
          id: 'column_embeddings_profile_hash_not_null',
          expr:
            `exists (select 1 from information_schema.columns ` +
            `where table_schema = current_schema() and table_name = 'project_embeddings_1024' ` +
            `and column_name = 'embedding_profile_hash' and is_nullable = 'NO')`,
        },
        {
          id: 'constraint_embeddings_profile_owner_unique',
          expr: constraintExists('project_embeddings_1024_profile_owner_unique'),
        },
        {
          id: 'constraint_embeddings_legacy_owner_unique_absent',
          expr: `not exists (select 1 from pg_constraint where conname = 'project_embeddings_1024_owner_unique')`,
        },
        {
          id: 'index_embeddings_profile_hash',
          expr: indexExists('project_embeddings_1024', 'project_embeddings_1024_profile_hash_idx'),
        },
        {
          id: 'trigger_chunks_candidate_immutable_guard',
          expr: triggerExists('project_chunks', 'project_chunks_candidate_immutable_guard'),
        },
        {
          id: 'trigger_symbols_immutable_guard',
          expr: triggerExists('project_symbols', 'project_symbols_immutable_guard'),
        },
        {
          id: 'trigger_symbols_candidate_insert_guard',
          expr: triggerExists('project_symbols', 'project_symbols_candidate_insert_guard'),
        },
        {
          id: 'trigger_edges_candidate_immutable_guard',
          expr: triggerExists('project_edges', 'project_edges_candidate_immutable_guard'),
        },
        {
          id: 'trigger_edges_candidate_insert_guard',
          expr: triggerExists('project_edges', 'project_edges_candidate_insert_guard'),
        },
        {
          id: 'trigger_embeddings_binding_immutable_guard',
          expr: triggerExists(
            'project_embeddings_1024',
            'project_embeddings_1024_binding_immutable_guard'
          ),
        },
        {
          id: 'trigger_versions_lifecycle_transitions',
          expr: triggerExists(
            'project_file_versions',
            'project_file_versions_lifecycle_transitions'
          ),
        },
      ],
    },
    {
      ordinal: 11,
      artifacts: [
        {
          id: 'column_repository_hash',
          expr: columnExists('project_rag_repositories', 'repository_hash'),
        },
        {
          id: 'column_workspace_worktree_git_dir',
          expr: columnExists('project_rag_workspaces', 'worktree_git_dir'),
        },
        {
          id: 'column_workspace_hash',
          expr: columnExists('project_rag_workspaces', 'workspace_hash'),
        },
        {
          id: 'column_revision_is_unborn',
          expr: columnExists('project_rag_revisions', 'is_unborn'),
        },
        {
          id: 'column_revision_head_hash',
          expr: columnExists('project_rag_revisions', 'head_hash'),
        },
        {
          id: 'column_revision_branch_hash',
          expr: columnExists('project_rag_revisions', 'branch_hash'),
        },
        {
          id: 'column_revision_detached_hash',
          expr: columnExists('project_rag_revisions', 'detached_hash'),
        },
        {
          id: 'column_revision_content_hash',
          expr: columnExists('project_rag_revisions', 'content_hash'),
        },
        {
          id: 'column_revision_status_digest',
          expr: columnExists('project_rag_revisions', 'status_digest'),
        },
        {
          id: 'column_revision_content_fingerprint',
          expr: columnExists('project_rag_revisions', 'content_fingerprint'),
        },
        {
          id: 'column_revision_identity_digest',
          expr: columnExists('project_rag_revisions', 'identity_digest'),
        },
        {
          id: 'column_snapshot_repository_hash',
          expr: columnExists('project_ingest_snapshots', 'repository_hash'),
        },
        {
          id: 'column_snapshot_workspace_hash',
          expr: columnExists('project_ingest_snapshots', 'workspace_hash'),
        },
        {
          id: 'column_snapshot_head_hash',
          expr: columnExists('project_ingest_snapshots', 'head_hash'),
        },
        {
          id: 'column_snapshot_branch_hash',
          expr: columnExists('project_ingest_snapshots', 'branch_hash'),
        },
        {
          id: 'column_snapshot_detached_hash',
          expr: columnExists('project_ingest_snapshots', 'detached_hash'),
        },
        {
          id: 'column_snapshot_content_hash',
          expr: columnExists('project_ingest_snapshots', 'content_hash'),
        },
        {
          id: 'column_snapshot_index_profile_hash',
          expr: columnExists('project_ingest_snapshots', 'index_profile_hash'),
        },
        {
          id: 'column_snapshot_root_manifest_hash',
          expr: columnExists('project_ingest_snapshots', 'root_manifest_hash'),
        },
        {
          id: 'column_snapshot_completeness_status',
          expr: columnExists('project_ingest_snapshots', 'completeness_status'),
        },
        {
          id: 'column_snapshot_completeness_evidence_hash',
          expr: columnExists('project_ingest_snapshots', 'completeness_evidence_hash'),
        },
        {
          id: 'column_snapshot_deletion_allowed',
          expr: columnExists('project_ingest_snapshots', 'deletion_allowed'),
        },
        {
          id: 'constraint_snapshot_completeness_status',
          expr: constraintExists('project_ingest_snapshots_completeness_status_check'),
        },
        {
          id: 'constraint_snapshot_deletion_requires_complete',
          expr: constraintExists('project_ingest_snapshots_deletion_requires_complete'),
        },
        {
          id: 'constraint_snapshot_completeness_requires_evidence',
          expr: constraintExists('project_ingest_snapshots_completeness_requires_evidence'),
        },
        {
          id: 'trigger_snapshot_binding_immutable',
          expr: triggerExists(
            'project_ingest_snapshots',
            'project_ingest_snapshot_freeze_binding_fields'
          ),
        },
      ],
    },
    {
      ordinal: 12,
      artifacts: [
        {
          id: 'column_job_available_at',
          expr: columnExists('project_jobs', 'available_at'),
        },
        {
          id: 'column_job_cancel_requested_at',
          expr: columnExists('project_jobs', 'cancel_requested_at'),
        },
        {
          id: 'column_job_blocked_at',
          expr: columnExists('project_jobs', 'blocked_at'),
        },
        {
          id: 'column_job_dead_lettered_at',
          expr: columnExists('project_jobs', 'dead_lettered_at'),
        },
        {
          id: 'column_job_status_reason',
          expr: columnExists('project_jobs', 'status_reason'),
        },
        {
          id: 'constraint_job_attempts_nonnegative',
          expr: constraintDefinitionMatches(
            'project_jobs',
            'project_jobs_attempts_nonnegative',
            'CHECK ((attempts >= 0))'
          ),
        },
        {
          id: 'constraint_job_max_attempts_positive',
          expr: constraintDefinitionMatches(
            'project_jobs',
            'project_jobs_max_attempts_positive',
            'CHECK ((max_attempts > 0))'
          ),
        },
        {
          id: 'constraint_job_status_lifecycle',
          expr: constraintDefinitionMatches(
            'project_jobs',
            'project_jobs_status_check',
            "CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'blocked-review'::text, 'retry-wait'::text, 'succeeded'::text, 'failed'::text, 'dead-letter'::text, 'cancelled'::text])))"
          ),
        },
        {
          id: 'index_job_active_dedupe_lifecycle',
          expr: indexDefinitionMatches({
            table: 'project_jobs',
            index: 'project_jobs_active_dedupe_idx',
            columns: ['dedupe_key'],
            unique: true,
            predicate:
              "dedupe_key IS NOT NULL AND status = ANY (ARRAY['queued'::text, 'running'::text, 'blocked-review'::text, 'retry-wait'::text])",
          }),
        },
        {
          id: 'index_job_claim_lifecycle',
          expr: indexDefinitionMatches({
            table: 'project_jobs',
            index: 'project_jobs_claim_idx',
            columns: ['status', 'available_at', 'created_at', 'id'],
            unique: false,
            predicate: "status = ANY (ARRAY['queued'::text, 'retry-wait'::text, 'running'::text])",
          }),
        },
        {
          id: 'index_job_available_claim_lifecycle',
          expr: indexDefinitionMatches({
            table: 'project_jobs',
            index: 'project_jobs_available_claim_idx',
            columns: ['status', 'available_at', 'created_at', 'id'],
            unique: false,
            predicate: "status = ANY (ARRAY['queued'::text, 'retry-wait'::text])",
          }),
        },
        {
          id: 'index_job_recovery',
          expr: indexDefinitionMatches({
            table: 'project_jobs',
            index: 'project_jobs_recovery_idx',
            columns: ['status', 'lease_expires_at', 'id'],
            unique: false,
            predicate: "status = 'running'::text",
          }),
        },
      ],
    },
    {
      ordinal: 13,
      artifacts: [
        { id: 'table_snapshot_reviews', expr: tableExists('project_ingest_snapshot_reviews') },
        {
          id: 'table_review_legacy_archive',
          expr: tableExists('project_ingest_snapshot_reviews_legacy_archive'),
        },
        {
          id: 'column_archive_id',
          expr: requiredColumnExists(
            'project_ingest_snapshot_reviews_legacy_archive',
            'archive_id'
          ),
        },
        {
          id: 'column_archive_legacy_review_id',
          expr: requiredColumnExists(
            'project_ingest_snapshot_reviews_legacy_archive',
            'legacy_review_id'
          ),
        },
        {
          id: 'column_archive_operator_id',
          expr: columnExists('project_ingest_snapshot_reviews_legacy_archive', 'operator_id'),
        },
        {
          id: 'column_archive_expires_at',
          expr: columnExists('project_ingest_snapshot_reviews_legacy_archive', 'expires_at'),
        },
        {
          id: 'column_archive_archived_at',
          expr: requiredColumnExists(
            'project_ingest_snapshot_reviews_legacy_archive',
            'archived_at'
          ),
        },
        {
          id: 'column_archive_reason',
          expr: requiredColumnExists(
            'project_ingest_snapshot_reviews_legacy_archive',
            'archive_reason'
          ),
        },
        {
          id: 'index_archive_legacy_review_unique',
          expr: indexExists(
            'project_ingest_snapshot_reviews_legacy_archive',
            'project_ingest_snapshot_reviews_legacy_archive_review_unique'
          ),
        },
        {
          id: 'trigger_archive_immutable',
          expr: triggerExists(
            'project_ingest_snapshot_reviews_legacy_archive',
            'project_ingest_snapshot_reviews_legacy_archive_immutable'
          ),
        },
        {
          id: 'trigger_archive_truncate_immutable',
          expr: triggerExists(
            'project_ingest_snapshot_reviews_legacy_archive',
            'project_ingest_snapshot_reviews_legacy_archive_truncate_immutable'
          ),
        },
        {
          id: 'column_review_id',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'id'),
        },
        {
          id: 'column_review_snapshot_id',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'snapshot_id'),
        },
        {
          id: 'column_review_snapshot_uuid',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'snapshot_uuid'),
        },
        {
          id: 'column_review_project_id',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'project_id'),
        },
        {
          id: 'column_review_reviewer_id',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'reviewer_id'),
        },
        {
          id: 'column_review_operator_id',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'operator_id'),
        },
        {
          id: 'column_review_reviewer_capability',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'reviewer_capability'),
        },
        {
          id: 'column_review_evidence_id',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'evidence_id'),
        },
        {
          id: 'column_review_reason',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'reason'),
        },
        {
          id: 'column_review_command_scope',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'command_scope'),
        },
        {
          id: 'column_review_token_digest',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'token_digest'),
        },
        {
          id: 'column_review_approved_at',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'approved_at'),
        },
        {
          id: 'column_review_expires_at',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'expires_at'),
        },
        {
          id: 'column_review_created_at',
          expr: requiredColumnExists('project_ingest_snapshot_reviews', 'created_at'),
        },
        {
          id: 'constraint_review_one_per_snapshot',
          expr: constraintExists('project_ingest_snapshot_reviews_one_per_snapshot'),
        },
        {
          id: 'constraint_review_token_digest_unique',
          expr: constraintExists('project_ingest_snapshot_reviews_token_digest_unique'),
        },
        {
          id: 'constraint_review_operator_id',
          expr: constraintExists('project_ingest_snapshot_reviews_operator_id_check'),
        },
        {
          id: 'constraint_review_capability',
          expr: constraintExists('project_ingest_snapshot_reviews_capability_check'),
        },
        {
          id: 'constraint_review_expiry',
          expr: constraintExists('project_ingest_snapshot_reviews_expiry_check'),
        },
        {
          id: 'table_review_decisions',
          expr: tableExists('project_ingest_snapshot_review_decisions'),
        },
        {
          id: 'column_decision_id',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'id'),
        },
        {
          id: 'column_decision_snapshot_id',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'snapshot_id'),
        },
        {
          id: 'column_decision_snapshot_uuid',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'snapshot_uuid'),
        },
        {
          id: 'column_decision_project_id',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'project_id'),
        },
        {
          id: 'column_decision_kind',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'decision'),
        },
        {
          id: 'column_decision_operator_id',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'operator_id'),
        },
        {
          id: 'column_decision_reason',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'reason'),
        },
        {
          id: 'column_decision_decided_at',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'decided_at'),
        },
        {
          id: 'column_decision_created_at',
          expr: requiredColumnExists('project_ingest_snapshot_review_decisions', 'created_at'),
        },
        {
          id: 'constraint_decision_one_per_snapshot',
          expr: constraintExists('project_ingest_snapshot_review_decisions_one_per_snapshot'),
        },
        {
          id: 'constraint_decision_kind',
          expr: constraintExists('project_ingest_snapshot_review_decisions_kind_check'),
        },
        {
          id: 'constraint_decision_operator_id',
          expr: constraintExists('project_ingest_snapshot_review_decisions_operator_id_check'),
        },
        {
          id: 'trigger_reviews_immutable',
          expr: triggerExists(
            'project_ingest_snapshot_reviews',
            'project_ingest_snapshot_reviews_immutable'
          ),
        },
        {
          id: 'trigger_decisions_immutable',
          expr: triggerExists(
            'project_ingest_snapshot_review_decisions',
            'project_ingest_snapshot_review_decisions_immutable'
          ),
        },
      ],
    },
  ],
  docs: [
    {
      ordinal: 1,
      artifacts: [
        { id: 'table_docs_documents', expr: tableExists('docs_documents') },
        { id: 'table_docs_chunks', expr: tableExists('docs_chunks') },
        { id: 'table_docs_embeddings', expr: tableExists('docs_embeddings') },
        {
          id: 'func_refresh_document_search',
          expr: functionExists('docs_rag_refresh_document_search'),
        },
        { id: 'func_refresh_chunk_search', expr: functionExists('docs_rag_refresh_chunk_search') },
        { id: 'ext_vector', expr: extensionInstalled('vector') },
      ],
    },
    {
      ordinal: 2,
      artifacts: [
        { id: 'table_docs_eval_runs', expr: tableExists('docs_eval_runs') },
        { id: 'table_docs_eval_cases', expr: tableExists('docs_eval_cases') },
        {
          id: 'func_refresh_eval_case_search',
          expr: functionExists('docs_rag_refresh_eval_case_search'),
        },
        {
          id: 'index_eval_cases_query_vector',
          expr: indexExists('docs_eval_cases', 'docs_eval_cases_query_vector_idx'),
        },
      ],
    },
    {
      ordinal: 3,
      artifacts: [
        {
          id: 'column_documents_upstream_path',
          expr: columnExists('docs_documents', 'upstream_path'),
        },
        {
          id: 'column_documents_upstream_content_sha256',
          expr: columnExists('docs_documents', 'upstream_content_sha256'),
        },
        {
          id: 'column_documents_processed_path',
          expr: columnExists('docs_documents', 'processed_path'),
        },
        {
          id: 'column_documents_processed_content_sha256',
          expr: columnExists('docs_documents', 'processed_content_sha256'),
        },
        {
          id: 'column_documents_processing_profile_hash_not_null',
          expr:
            `exists (select 1 from information_schema.columns ` +
            `where table_schema = current_schema() and table_name = 'docs_documents' ` +
            `and column_name = 'processing_profile_hash' and is_nullable = 'NO')`,
        },
        {
          id: 'column_documents_processing_profile',
          expr: columnExists('docs_documents', 'processing_profile'),
        },
        {
          id: 'index_documents_processing_profile_hash',
          expr: indexExists('docs_documents', 'docs_documents_processing_profile_hash_idx'),
        },
        {
          id: 'column_embeddings_embedding_input_text',
          expr: columnExists('docs_embeddings', 'embedding_input_text'),
        },
        {
          id: 'column_embeddings_embedding_input_sha256',
          expr: columnExists('docs_embeddings', 'embedding_input_sha256'),
        },
        {
          // Exact-input provenance is mandatory for chunk-kind embeddings;
          // legacy document-level rows may stay NULL (explicitly unknown).
          // Nullable columns + this data invariant = truthful unknown state
          // without fabricating inputs for rows whose exact text is lost.
          id: 'chunk_embeddings_exact_input_complete',
          expr: chunkEmbeddingExactInputComplete(),
        },
      ],
    },
    {
      ordinal: 4,
      artifacts: [
        {
          id: 'table_docs_source_generations',
          expr: tableExists('docs_source_generations'),
        },
        {
          id: 'table_docs_source_generation_pointers',
          expr: tableExists('docs_source_generation_pointers'),
        },
        {
          id: 'column_documents_generation_id',
          expr: columnExists('docs_documents', 'generation_id'),
        },
        {
          id: 'constraint_generations_identity_unique',
          expr: constraintExists('docs_source_generations_identity_unique'),
        },
        {
          id: 'constraint_generations_scan_state',
          expr: constraintExists('docs_source_generations_scan_state_check'),
        },
        {
          id: 'constraint_generations_status',
          expr: constraintExists('docs_source_generations_status_check'),
        },
        {
          id: 'constraint_generations_expected_count',
          expr: constraintExists('docs_source_generations_expected_count_check'),
        },
        {
          id: 'constraint_generations_indexed_count',
          expr: constraintExists('docs_source_generations_indexed_count_check'),
        },
        {
          id: 'constraint_documents_generation_fk',
          expr: constraintExists('docs_documents_generation_fk'),
        },
        {
          id: 'index_documents_generation_identity',
          expr: indexExists('docs_documents', 'docs_documents_generation_identity_unique'),
        },
        {
          id: 'index_documents_legacy_identity',
          expr: indexExists('docs_documents', 'docs_documents_legacy_identity_unique'),
        },
        {
          id: 'index_documents_generation_id',
          expr: indexExists('docs_documents', 'docs_documents_generation_id_idx'),
        },
        {
          id: 'index_generations_source_status',
          expr: indexExists('docs_source_generations', 'docs_source_generations_source_status_idx'),
        },
        {
          id: 'index_pointers_generation_id',
          expr: indexExists(
            'docs_source_generation_pointers',
            'docs_source_generation_pointers_generation_idx'
          ),
        },
        {
          id: 'func_touch_source_generation_updated_at',
          expr: functionExists('docs_rag_touch_source_generation_updated_at'),
        },
        {
          id: 'trigger_generations_touch_updated_at',
          expr: triggerExists(
            'docs_source_generations',
            'docs_source_generations_touch_updated_at'
          ),
        },
        {
          id: 'func_reject_published_generation_mutation',
          expr: functionExists('docs_rag_reject_published_generation_mutation'),
        },
        {
          id: 'trigger_generations_reject_published_update',
          expr: triggerExists(
            'docs_source_generations',
            'docs_source_generations_reject_published_update'
          ),
        },
        {
          id: 'func_reject_published_document_mutation',
          expr: functionExists('docs_rag_reject_published_document_mutation'),
        },
        {
          id: 'trigger_documents_reject_published_generation_update',
          expr: triggerExists(
            'docs_documents',
            'docs_documents_reject_published_generation_update'
          ),
        },
        {
          id: 'func_reject_published_derived_mutation',
          expr: functionExists('docs_rag_reject_published_derived_mutation'),
        },
        {
          id: 'trigger_chunks_reject_published_generation_mutation',
          expr: triggerExists('docs_chunks', 'docs_chunks_reject_published_generation_mutation'),
        },
        {
          id: 'func_reject_published_embedding_mutation',
          expr: functionExists('docs_rag_reject_published_embedding_mutation'),
        },
        {
          id: 'trigger_embeddings_reject_published_generation_mutation',
          expr: triggerExists(
            'docs_embeddings',
            'docs_embeddings_reject_published_generation_mutation'
          ),
        },
      ],
    },
    {
      ordinal: 5,
      artifacts: [
        {
          id: 'column_generation_provenance_class',
          expr: columnExists('docs_source_generations', 'provenance_class'),
        },
        {
          id: 'constraint_generation_provenance_class',
          expr: constraintExists('docs_source_generations_provenance_class_check'),
        },
        {
          id: 'table_legacy_generation_exemptions',
          expr: tableExists('docs_rag_legacy_generation_exemptions'),
        },
        {
          id: 'func_legacy_generation_exemption_seal',
          expr: functionExists('docs_rag_reject_legacy_generation_exemption_mutation'),
        },
        {
          id: 'trigger_legacy_generation_exemptions_sealed',
          expr: triggerExists(
            'docs_rag_legacy_generation_exemptions',
            'docs_rag_legacy_generation_exemptions_sealed'
          ),
        },
        {
          id: 'trigger_legacy_generation_exemptions_truncate_sealed',
          expr: triggerExists(
            'docs_rag_legacy_generation_exemptions',
            'docs_rag_legacy_generation_exemptions_truncate_sealed'
          ),
        },
        {
          id: 'func_generation_publication_prosrc_digest',
          expr: functionProsrcDigestMatches(
            DOCS_PUBLICATION_VALIDATOR_METADATA.functionName,
            DOCS_PUBLICATION_VALIDATOR_METADATA.identityArguments,
            DOCS_PUBLICATION_VALIDATOR_METADATA.prosrcSha256
          ),
        },
        {
          id: 'func_generation_publication_count_invalid',
          expr: functionDefinitionContains(
            'docs_rag_assert_generation_publishable',
            'COUNT_INVALID'
          ),
        },
        {
          id: 'func_generation_publication_document_invalid',
          expr: functionDefinitionContains(
            'docs_rag_assert_generation_publishable',
            'DOCUMENT_INVALID'
          ),
        },
        {
          id: 'func_generation_publication_chunk_invalid',
          expr: functionDefinitionContains(
            'docs_rag_assert_generation_publishable',
            'CHUNK_INVALID'
          ),
        },
        {
          id: 'func_generation_publication_embedding_invalid',
          expr: functionDefinitionContains(
            'docs_rag_assert_generation_publishable',
            'EMBEDDING_INVALID'
          ),
        },
        {
          id: 'func_generation_publication_revision_bound_external',
          expr: functionDefinitionContains(
            'docs_rag_assert_generation_publishable',
            'revision_bound_external'
          ),
        },
        {
          id: 'func_generation_publication_processed_external_import',
          expr: functionDefinitionContains(
            'docs_rag_assert_generation_publishable',
            'processed_external_import'
          ),
        },
      ],
    },
  ],
};

export interface ProbeArtifactResult {
  readonly id: string;
  readonly present: boolean;
}

export interface MigrationProbeResult {
  readonly ordinal: number;
  readonly passed: boolean;
  readonly artifacts: readonly ProbeArtifactResult[];
}

async function runProbe(db: SqlExecutor, probe: MigrationProbe): Promise<MigrationProbeResult> {
  const columns = probe.artifacts.map((_, i) => `(${probe.artifacts[i].expr}) as a${i}`).join(', ');
  const rows = await db.unsafe(`select ${columns}`);
  const row = rows[0] ?? {};
  const artifacts = probe.artifacts.map((artifact, i) => ({
    id: artifact.id,
    present: row[`a${i}`] === true,
  }));
  return { ordinal: probe.ordinal, passed: artifacts.every((a) => a.present), artifacts };
}

/** Run every postcondition probe for the lane. Read-only SELECT statements. */
export async function probeLane(
  db: SqlExecutor,
  lane: MigrationLane,
  maxOrdinal = Number.POSITIVE_INFINITY
): Promise<readonly MigrationProbeResult[]> {
  const results: MigrationProbeResult[] = [];
  for (const probe of MIGRATION_PROBES[lane].filter((item) => item.ordinal <= maxOrdinal)) {
    results.push(await runProbe(db, probe));
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Adoption challenge                                                         */
/* -------------------------------------------------------------------------- */

export interface AdoptionChallenge {
  readonly lane: MigrationLane;
  /** Highest contiguously proven ordinal (all probes 1..prefix passed). */
  readonly prefixOrdinal: number;
  readonly provenArtifacts: readonly string[];
  /** Ordinals beyond the prefix whose probes show absent evidence. */
  readonly absentOrdinals: readonly number[];
  readonly proofDigest: string;
  /** Stable credential-free fingerprint of the canonical target identity. */
  readonly targetFingerprint: string;
  /** Complete fixed-manifest checksum set bound into the challenge. */
  readonly manifestChecksums: readonly string[];
  readonly recordKind: 'verified_adoption';
}

function manifestChecksumSet(manifest: readonly LoadedMigration[]): readonly string[] {
  return manifest.map((item) => `${item.descriptor.ordinal}:${item.checksumSha256}`);
}

export function buildAdoptionChallenge(input: {
  lane: MigrationLane;
  manifest: readonly LoadedMigration[];
  probes: readonly MigrationProbeResult[];
  targetFingerprint: string;
}): AdoptionChallenge | { unsupported: true; reason: string } {
  let prefixOrdinal = 0;
  for (const probe of input.probes) {
    if (probe.passed) {
      if (probe.ordinal === prefixOrdinal + 1) {
        prefixOrdinal = probe.ordinal;
        continue;
      }
      return {
        unsupported: true,
        reason:
          `probe for migration ${probe.ordinal} passed while earlier migrations are unproven; ` +
          'the legacy state is not a provable contiguous prefix',
      };
    }
    break;
  }
  if (prefixOrdinal === 0) {
    return {
      unsupported: true,
      reason:
        'no migration could be proven against the existing schema footprint; refusing to adopt without evidence',
    };
  }
  const absentOrdinals = input.probes
    .filter((p) => p.ordinal > prefixOrdinal)
    .map((p) => p.ordinal);
  for (const probe of input.probes.filter((p) => p.ordinal > prefixOrdinal)) {
    if (probe.passed) {
      return {
        unsupported: true,
        reason: `probe for migration ${probe.ordinal} passed beyond proven prefix ${prefixOrdinal}; non-contiguous legacy state`,
      };
    }
  }
  const provenArtifacts = input.probes
    .filter((p) => p.ordinal <= prefixOrdinal)
    .flatMap((p) => p.artifacts.filter((a) => a.present).map((a) => `${p.ordinal}:${a.id}`));
  const manifestChecksums = manifestChecksumSet(input.manifest);
  const proofDigest = sha256Text(
    JSON.stringify({
      lane: input.lane,
      prefixOrdinal,
      provenArtifacts,
      targetFingerprint: input.targetFingerprint,
      manifestChecksums,
    })
  );
  return {
    lane: input.lane,
    prefixOrdinal,
    provenArtifacts,
    absentOrdinals,
    proofDigest,
    targetFingerprint: input.targetFingerprint,
    manifestChecksums,
    recordKind: 'verified_adoption',
  };
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

export interface MigrationSummaryRow {
  readonly ordinal: number;
  readonly name: string;
  readonly recordKind?: RecordKind;
  readonly checksumSha256?: string;
}

export interface StatusReport {
  readonly ok: boolean;
  readonly lane: MigrationLane;
  readonly target: string;
  readonly readOnly: true;
  readonly ledgerPresent: boolean;
  readonly footprintPresent: boolean;
  readonly state: LaneState;
  readonly applied: readonly MigrationSummaryRow[];
  readonly pending: readonly MigrationSummaryRow[];
  readonly adoptionChallenge?: AdoptionChallenge;
  readonly unsupportedAdoptionReason?: string;
}

async function buildStatus(
  db: SqlExecutor,
  lane: MigrationLane,
  manifest: readonly LoadedMigration[],
  redactedUrl: string,
  targetFingerprint: string
): Promise<StatusReport> {
  const [ledger, footprintPresent] = await Promise.all([
    readLedger(db, lane, manifest.length + 1),
    detectFootprint(db, lane),
  ]);
  const state = classifyLane({
    manifest,
    ledgerPresent: ledger.present,
    rows: ledger.rows,
    footprintPresent,
  });

  const applied: MigrationSummaryRow[] = [...ledger.rows]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((r) => ({
      ordinal: r.ordinal,
      name: boundText(r.name),
      recordKind: r.recordKind,
      checksumSha256: boundText(r.checksumSha256),
    }));
  const pending: MigrationSummaryRow[] =
    state.kind === 'fresh'
      ? manifest.map((m) => ({ ordinal: m.descriptor.ordinal, name: m.descriptor.name }))
      : state.kind === 'upgrade_pending'
        ? manifest
            .filter((m) => state.pendingOrdinals.includes(m.descriptor.ordinal))
            .map((m) => ({ ordinal: m.descriptor.ordinal, name: m.descriptor.name }))
        : [];

  const report: StatusReport = {
    ok: true,
    lane,
    target: redactedUrl,
    readOnly: true,
    ledgerPresent: ledger.present,
    footprintPresent,
    state,
    applied,
    pending,
  };

  if (state.kind === 'adoption_required') {
    const probes = await probeLane(db, lane, manifest.length);
    const challenge = buildAdoptionChallenge({ lane, manifest, probes, targetFingerprint });
    if ('unsupported' in challenge) {
      return sanitizeReport({ ...report, unsupportedAdoptionReason: challenge.reason });
    }
    return sanitizeReport({ ...report, adoptionChallenge: challenge });
  }
  return sanitizeReport(report);
}

/** Read one lane without the connection readiness probe.  Official
 * coordination uses this while one advisory lock is already held. */
export async function readLaneStatus(input: {
  db: SqlExecutor;
  lane: MigrationLane;
  manifest: readonly LoadedMigration[];
  redactedUrl: string;
  targetFingerprint: string;
}): Promise<StatusReport> {
  return buildStatus(
    input.db,
    input.lane,
    input.manifest,
    input.redactedUrl,
    input.targetFingerprint
  );
}

/** Strictly read-only status report for one lane. */
export async function runStatus(input: {
  db: SqlExecutor;
  lane: MigrationLane;
  manifest: readonly LoadedMigration[];
  redactedUrl: string;
  targetFingerprint: string;
}): Promise<StatusReport> {
  const { db, lane, manifest, redactedUrl, targetFingerprint } = input;
  await db.unsafe('select 1 as ready');
  return buildStatus(db, lane, manifest, redactedUrl, targetFingerprint);
}

/**
 * Release the database-global advisory lock without ever masking the original
 * operation error: cleanup failures are suppressed because the session-scoped
 * lock dies with the reserved connection regardless.
 */
export async function releaseAdvisoryLockQuietly(db: SqlExecutor): Promise<void> {
  try {
    await db.unsafe('select pg_advisory_unlock($1::bigint) as unlocked', [MIGRATION_LOCK_KEY]);
  } catch {
    // Cleanup-only failure; never propagate over the original error.
  }
}

/** Acquire the shared migration lock without queueing behind another runner. */
export async function acquireMigrationLock(db: SqlExecutor): Promise<void> {
  const lockRows = await db.unsafe('select pg_try_advisory_lock($1::bigint) as locked', [
    MIGRATION_LOCK_KEY,
  ]);
  if (lockRows[0]?.locked !== true) {
    throw new MigrationRunnerError(
      'MIGRATION_LOCK_BUSY',
      'another migration runner holds the advisory lock'
    );
  }
}

/** Alias for callers that need to make lock ownership explicit. */
export const releaseMigrationLock = releaseAdvisoryLockQuietly;

/**
 * Plan (dry-run=true) or execute (dry-run=false) migrations for one lane.
 * Dry-run performs only SELECT statements. Execution acquires the database-
 * global advisory try-lock on the pinned connection, re-validates under the
 * lock, then applies the contiguous suffix; each script runs exactly as the
 * file defines it (scripts own transaction boundaries).
 */
/** Execute one lane while the caller owns MIGRATION_LOCK_KEY. */
export async function runApplyLocked(input: {
  db: SqlExecutor;
  lane: MigrationLane;
  manifest: readonly LoadedMigration[];
  redactedUrl: string;
  targetFingerprint: string;
}): Promise<StatusReport & { executed: readonly MigrationSummaryRow[] }> {
  const { db, lane, manifest, redactedUrl, targetFingerprint } = input;
  await ensureLedgerTable(db);
  const ledger = await readLedger(db, lane, manifest.length + 1);
  const footprintPresent = await detectFootprint(db, lane);
  const state = classifyLane({
    manifest,
    ledgerPresent: ledger.present,
    rows: ledger.rows,
    footprintPresent,
  });

  if (state.kind === 'invalid_ledger') {
    const first = state.issues[0];
    throw new MigrationRunnerError(
      issueForCode(first.code),
      `refusing to migrate: ${first.detail}`,
      { issues: state.issues.map((i) => `${i.code}: ${i.detail}`) }
    );
  }
  if (state.kind === 'adoption_required') {
    throw new MigrationRunnerError(
      'MIGRATION_ADOPTION_REQUIRED',
      'database has a lane schema footprint but no migration ledger; run the explicit adopt flow instead of apply',
      {}
    );
  }

  const executed: MigrationSummaryRow[] = [];
  if (state.kind === 'fresh' || state.kind === 'upgrade_pending') {
    for (const ordinal of state.kind === 'fresh'
      ? manifest.map((m) => m.descriptor.ordinal)
      : state.pendingOrdinals) {
      const item = manifest[ordinal - 1];
      try {
        await db.unsafe(item.sqlText);
      } catch (error) {
        await db.unsafe('rollback').catch(() => {});
        const described = describeError(error);
        throw new MigrationRunnerError(
          'MIGRATION_APPLY_FAILED',
          `migration ${ordinal} (${item.descriptor.name}) failed: ${described.message}`,
          { ordinal, pgCode: described.pgCode }
        );
      }
      const proof = proofDigestFor({
        kind: 'executed',
        lane,
        ordinal,
        name: item.descriptor.name,
        checksum: item.checksumSha256,
      });
      try {
        await db.unsafe(
          `insert into ${LEDGER_TABLE} (lane, ordinal, name, checksum_sha256, record_kind, proof_digest) values ($1, $2, $3, $4, $5, $6)`,
          [lane, ordinal, item.descriptor.name, item.checksumSha256, 'executed', proof]
        );
      } catch (error) {
        const described = describeError(error);
        throw new MigrationRunnerError(
          'MIGRATION_APPLY_FAILED',
          `ledger record for migration ${ordinal} failed: ${described.message}`,
          { ordinal, pgCode: described.pgCode }
        );
      }
      executed.push({ ordinal, name: item.descriptor.name, recordKind: 'executed' });
    }
  }

  const finalLedger = await readLedger(db, lane, manifest.length + 1);
  const finalFootprintPresent = await detectFootprint(db, lane);
  const finalState = classifyLane({
    manifest,
    ledgerPresent: finalLedger.present,
    rows: finalLedger.rows,
    footprintPresent: finalFootprintPresent,
  });
  if (finalState.kind !== 'up_to_date') {
    throw new MigrationRunnerError(
      'MIGRATION_APPLY_FAILED',
      `post-apply verification failed: lane state is ${finalState.kind}`,
      {}
    );
  }
  const finalReport = await buildStatus(db, lane, manifest, redactedUrl, targetFingerprint);
  return { ...finalReport, executed };
}

export async function runApply(input: {
  db: SqlExecutor;
  lane: MigrationLane;
  manifest: readonly LoadedMigration[];
  redactedUrl: string;
  targetFingerprint: string;
  dryRun: boolean;
}): Promise<StatusReport & { executed: readonly MigrationSummaryRow[] }> {
  const { db, lane, manifest, redactedUrl, targetFingerprint, dryRun } = input;
  await db.unsafe('select 1 as ready');
  const report = await buildStatus(db, lane, manifest, redactedUrl, targetFingerprint);

  if (dryRun) {
    return { ...report, executed: [] };
  }

  if (report.state.kind === 'invalid_ledger') {
    const first = report.state.issues[0];
    throw new MigrationRunnerError(
      issueForCode(first.code),
      `refusing to migrate: ${first.detail}`,
      {
        issues: report.state.issues.map((i) => `${i.code}: ${i.detail}`),
      }
    );
  }
  if (report.state.kind === 'adoption_required') {
    throw new MigrationRunnerError(
      'MIGRATION_ADOPTION_REQUIRED',
      'database has a lane schema footprint but no migration ledger; run the explicit adopt flow instead of apply',
      { unsupportedReason: report.unsupportedAdoptionReason }
    );
  }

  // Acquire the database-global advisory try-lock, then re-read and
  // re-validate so concurrent classification cannot race between plan and
  // execution.
  await acquireMigrationLock(db);

  try {
    return await runApplyLocked({ db, lane, manifest, redactedUrl, targetFingerprint });
  } finally {
    await releaseAdvisoryLockQuietly(db);
  }
}

/**
 * Explicit verified adoption for pre-ledger databases. Requires the challenge
 * digest captured from a prior read-only status/adoption preview; writes rows
 * 1..prefix with record_kind='verified_adoption'. Refuses without writing when
 * the legacy state is unproven or non-contiguous.
 *
 * The accepted digest is the published `adoptionChallenge.proofDigest` from
 * status output; under the lock the lane is re-probed and must still produce
 * the identical proof before any ledger row is written.
 */
/** Adopt one lane while the caller owns MIGRATION_LOCK_KEY. */
export async function runAdoptLocked(input: {
  db: SqlExecutor;
  lane: MigrationLane;
  manifest: readonly LoadedMigration[];
  redactedUrl: string;
  targetFingerprint: string;
  challengeDigest: string;
}): Promise<StatusReport & { adopted: readonly MigrationSummaryRow[] }> {
  const { db, lane, manifest, redactedUrl, targetFingerprint, challengeDigest } = input;
  const probes = await probeLane(db, lane, manifest.length);
  const fresh = buildAdoptionChallenge({ lane, manifest, probes, targetFingerprint });
  if ('unsupported' in fresh || fresh.proofDigest !== challengeDigest) {
    throw new MigrationRunnerError(
      'MIGRATION_CHALLENGE_MISMATCH',
      'adoption state changed between challenge and execution; refusing to write ledger rows'
    );
  }

  await ensureLedgerTable(db);
  const adopted: MigrationSummaryRow[] = [];
  await db.unsafe('begin');
  try {
    for (const ordinal of Array.from({ length: fresh.prefixOrdinal }, (_, i) => i + 1)) {
      const item = manifest[ordinal - 1];
      const proof = proofDigestFor({
        kind: 'verified_adoption',
        lane,
        ordinal,
        name: item.descriptor.name,
        checksum: item.checksumSha256,
      });
      try {
        await db.unsafe(
          `insert into ${LEDGER_TABLE} (lane, ordinal, name, checksum_sha256, record_kind, proof_digest) values ($1, $2, $3, $4, $5, $6)`,
          [lane, ordinal, item.descriptor.name, item.checksumSha256, 'verified_adoption', proof]
        );
      } catch (error) {
        const described = describeError(error);
        throw new MigrationRunnerError(
          'MIGRATION_APPLY_FAILED',
          `ledger record for migration ${ordinal} (${item.descriptor.name}) failed: ${described.message}`,
          { ordinal, pgCode: described.pgCode }
        );
      }
      adopted.push({ ordinal, name: item.descriptor.name, recordKind: 'verified_adoption' });
    }
    await db.unsafe('commit');
  } catch (error) {
    try {
      await db.unsafe('rollback');
    } catch {
      // Preserve the original error below.
    }
    throw error;
  }

  const finalReport = await buildStatus(db, lane, manifest, redactedUrl, targetFingerprint);
  return { ...finalReport, adopted };
}

export async function runAdopt(input: {
  db: SqlExecutor;
  lane: MigrationLane;
  manifest: readonly LoadedMigration[];
  redactedUrl: string;
  targetFingerprint: string;
  challengeDigest: string;
  dryRun: boolean;
}): Promise<StatusReport & { adopted: readonly MigrationSummaryRow[] }> {
  const { db, lane, manifest, redactedUrl, targetFingerprint, challengeDigest, dryRun } = input;
  if (!challengeDigest.trim()) {
    throw new MigrationRunnerError(
      'MIGRATION_ACK_REQUIRED',
      'adopt requires a non-empty proofDigest from a prior read-only status report'
    );
  }
  await db.unsafe('select 1 as ready');
  const report = await buildStatus(db, lane, manifest, redactedUrl, targetFingerprint);

  if (report.state.kind !== 'adoption_required') {
    throw new MigrationRunnerError(
      'MIGRATION_ADOPTION_UNSUPPORTED',
      `adopt is only valid when the lane state is adoption_required (current: ${report.state.kind})`
    );
  }
  const challenge = report.adoptionChallenge;
  if (!challenge) {
    throw new MigrationRunnerError(
      'MIGRATION_ADOPTION_UNSUPPORTED',
      report.unsupportedAdoptionReason ?? 'legacy state could not be proven; refusing adoption',
      {}
    );
  }

  if (challengeDigest !== challenge.proofDigest) {
    throw new MigrationRunnerError(
      'MIGRATION_CHALLENGE_MISMATCH',
      'challenge digest does not match the current adoption proof; re-read status and retry with the printed proofDigest',
      { expectedPrefix: challenge.prefixOrdinal }
    );
  }

  if (dryRun) {
    return { ...report, adopted: [] };
  }

  await acquireMigrationLock(db);

  try {
    return await runAdoptLocked({
      db,
      lane,
      manifest,
      redactedUrl,
      targetFingerprint,
      challengeDigest,
    });
  } finally {
    await releaseAdvisoryLockQuietly(db);
  }
}

/* -------------------------------------------------------------------------- */
/* Mutation gates                                                             */
/* -------------------------------------------------------------------------- */

export interface MutationGateEnv {
  readonly RAG_MIGRATION_TARGET?: string;
  readonly RAG_MIGRATION_WRITE_ACK?: string;
}

/**
 * Every mutating operation requires --execute plus explicit isolated-target
 * acknowledgements in the environment. Read-only modes never call this.
 */
export function assertMutationGates(env: MutationGateEnv, opts: { execute: boolean }): void {
  if (!opts.execute) {
    throw new MigrationRunnerError(
      'MIGRATION_ACK_REQUIRED',
      'mutating commands require --execute; without it the runner only reports or plans'
    );
  }
  if (env.RAG_MIGRATION_TARGET !== 'isolated') {
    throw new MigrationRunnerError(
      'MIGRATION_TARGET_NOT_ISOLATED',
      'RAG_MIGRATION_TARGET=isolated must be set to confirm this command targets an isolated disposable database'
    );
  }
  if (env.RAG_MIGRATION_WRITE_ACK !== '1') {
    throw new MigrationRunnerError(
      'MIGRATION_ACK_REQUIRED',
      'RAG_MIGRATION_WRITE_ACK=1 must be set to acknowledge that this command writes schema changes'
    );
  }
}

/**
 * Resolve the database URL from the explicit lane environment variable only.
 * Generic fallbacks (DATABASE_URL, POSTGRES_URL, ...) are never consulted.
 * Read-only status accepts an explicit Postgres URL; mutations additionally
 * require the positive loopback/disposable-target contract.
 */
export function resolveLaneDatabaseUrl(input: {
  lane: MigrationLane;
  env: Record<string, string | undefined>;
  mutating: boolean;
}): { url: string; source: string; targetIdentity: MigrationTargetIdentity } {
  const variable = LANE_URL_ENV[input.lane];
  const raw = input.env[variable]?.trim();
  if (!raw) {
    throw new MigrationRunnerError(
      'MIGRATION_URL_REJECTED',
      `${variable} must be set explicitly for the ${input.lane} lane; generic variables such as DATABASE_URL are intentionally ignored`
    );
  }
  const normalized = raw.replace(/^['"]|['"]$/g, '');
  const targetIdentity = canonicalizeMigrationTarget(normalized);
  if (input.mutating) {
    assertDisposableMigrationTarget(normalized, targetIdentity);
  }
  return { url: normalized, source: `env:${variable}`, targetIdentity };
}
