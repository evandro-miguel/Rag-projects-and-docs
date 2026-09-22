/**
 * Fail-closed coordinator for the official database migration workflow.
 *
 * The ordinary runner remains disposable-only.  This module owns the
 * operator-bound artifacts and the single-lock, multi-lane orchestration used
 * for an explicitly acknowledged official operation.  Database and process
 * effects are injected where practical so unit tests can prove policy without
 * opening a live connection.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  type AdoptionChallenge,
  acquireMigrationLock,
  assertDisposableMigrationTarget,
  canonicalizeMigrationTarget,
  describeError,
  type LaneState,
  type LoadedMigration,
  type MigrationLane,
  MigrationRunnerError,
  type MigrationSummaryRow,
  type MigrationTargetIdentity,
  probeLane,
  readLaneStatus,
  readServerFingerprintV2,
  releaseMigrationLock,
  runAdoptLocked,
  runApplyLocked,
  fingerprintV2For as runnerFingerprintV2For,
  type SqlExecutor,
  sha256Bytes,
  sha256Text,
} from './runner.js';
import { MIGRATION_MAINTENANCE_MARKER_ID, MIGRATION_MAINTENANCE_TABLE } from './write-fence.js';

export const OFFICIAL_ARTIFACT_SCHEMA_VERSION = 1;
export const OFFICIAL_TARGET = 'official';
export const OFFICIAL_ACK = 'I_ACKNOWLEDGE_OFFICIAL_DATABASE_MUTATION';
export const OFFICIAL_RECOVERY_ACK = 'I_ACKNOWLEDGE_OFFICIAL_MIGRATION_RECOVERY';
export const DEFAULT_OFFICIAL_ARTIFACT_TTL_MS = 30 * 60 * 1000;
export const fingerprintV2For = runnerFingerprintV2For;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const execFileAsync = promisify(execFile);
const liveRestoreReceiptFingerprints = new WeakMap<RestoreVerificationReceipt, string>();

export interface OfficialLanePlanState {
  readonly lane: MigrationLane;
  readonly state: LaneState;
  readonly prefixOrdinal: number;
  readonly pendingOrdinals: readonly number[];
  readonly statusDigest: string;
  readonly probeDigest: string;
  readonly challenge?: AdoptionChallenge;
}

export interface OfficialMigrationPlan {
  readonly schemaVersion: typeof OFFICIAL_ARTIFACT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly repoSha: string;
  /** Expected v2 fingerprint supplied by the operator and checked per lane. */
  readonly targetFingerprint: string;
  readonly targetFingerprints: Readonly<Record<MigrationLane, string>>;
  readonly targetIdentities: Readonly<
    Record<MigrationLane, Pick<MigrationTargetIdentity, 'host' | 'port' | 'database'>>
  >;
  readonly lanes: readonly MigrationLane[];
  readonly manifestChecksums: Readonly<Record<MigrationLane, readonly string[]>>;
  readonly manifestDigest: string;
  readonly laneStates: Readonly<Record<MigrationLane, OfficialLanePlanState>>;
  readonly laneStateDigest: string;
  readonly contentDigest: string;
}

export interface BackupReceipt {
  readonly schemaVersion: typeof OFFICIAL_ARTIFACT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly repoSha: string;
  readonly targetFingerprint: string;
  readonly manifestDigest: string;
  readonly laneStateDigest: string;
  readonly planDigest: string;
  readonly backupSha256: string;
  readonly backupSizeBytes: number;
  readonly backupFormat: 'custom';
  readonly postgresVersion: string;
  readonly command: Readonly<{ program: 'pg_dump'; format: 'custom' }>;
  readonly contentDigest: string;
}

export interface RestoreVerificationReceipt {
  readonly schemaVersion: typeof OFFICIAL_ARTIFACT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly repoSha: string;
  readonly targetFingerprint: string;
  readonly manifestDigest: string;
  readonly laneStateDigest: string;
  readonly planDigest: string;
  readonly backupReceiptDigest: string;
  readonly backupSha256: string;
  readonly backupSizeBytes: number;
  readonly restoreTarget: 'disposable';
  /** V2 fingerprint observed on the connected disposable restore database. */
  readonly restoreTargetFingerprint?: string;
  readonly schemaProbes: Readonly<Record<MigrationLane, boolean>>;
  readonly lanePrefixes: Readonly<Record<MigrationLane, number>>;
  readonly rowCountDigests: Readonly<Record<string, string>>;
  readonly readSmoke: true;
  readonly contentDigest: string;
}

export interface WriteDrainObservation {
  readonly activeSessions: number;
  readonly activeTransactions: number;
  readonly connectionLimit: number;
  readonly baselineConnectionLimit: number;
  readonly bypassRoleDetected: boolean;
  readonly settlingMs: number;
  readonly drained: boolean;
  readonly grantsDigest?: string;
}

export interface WriteDrainReceipt {
  readonly schemaVersion: typeof OFFICIAL_ARTIFACT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly repoSha: string;
  readonly targetFingerprint: string;
  readonly manifestDigest: string;
  readonly laneStateDigest: string;
  readonly planDigest: string;
  readonly drain: WriteDrainObservation;
  readonly contentDigest: string;
}

export interface OfficialMutationGateEnv {
  readonly RAG_MIGRATION_TARGET?: string;
  readonly RAG_MIGRATION_OFFICIAL_ACK?: string;
  readonly RAG_MIGRATION_WRITE_ACK?: string;
  readonly RAG_MIGRATION_MAINTENANCE_ACK?: string;
  readonly RAG_MIGRATION_RECOVERY_ACK?: string;
  readonly RAG_MIGRATION_EXPECTED_TARGET_FINGERPRINT?: string;
}

export interface OfficialApplyRequest {
  readonly plan: OfficialMigrationPlan;
  readonly backupReceipt: BackupReceipt;
  readonly restoreReceipt: RestoreVerificationReceipt;
  readonly drainReceipt: WriteDrainReceipt;
  readonly env: OfficialMutationGateEnv;
  readonly execute: boolean;
  /** One reserved connection shared by both lanes. */
  readonly db: SqlExecutor;
  readonly targetIdentity: MigrationTargetIdentity;
  readonly manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>>;
  readonly actor?: string;
  readonly candidateSha?: string;
  readonly auditPath?: string;
  readonly now?: Date;
}

export interface OfficialRecoveryRequest extends OfficialApplyRequest {
  /** Operation id recorded by the failed owner in the durable marker. */
  readonly priorOperationId: string;
}

export interface OfficialApplyResult {
  readonly ok: true;
  readonly operationId: string;
  readonly executed: Readonly<Record<MigrationLane, readonly MigrationSummaryRow[]>>;
  readonly adopted: Readonly<Record<MigrationLane, readonly MigrationSummaryRow[]>>;
  readonly after: Readonly<Record<MigrationLane, OfficialLanePlanState>>;
  readonly audit: OfficialOperationAudit;
}

export interface OfficialDrainRequest {
  readonly plan: OfficialMigrationPlan;
  readonly db: SqlExecutor;
  readonly targetIdentity: MigrationTargetIdentity;
  readonly now?: Date;
  readonly ttlMs?: number;
  readonly settlingMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface OfficialBackupRequest {
  readonly plan: OfficialMigrationPlan;
  readonly backupPath: string;
  readonly targetIdentity: MigrationTargetIdentity;
  readonly db?: SqlExecutor;
  readonly now?: Date;
  readonly ttlMs?: number;
  readonly dump?: () => Promise<void>;
}

export interface OfficialVerifyBackupRequest {
  readonly plan: OfficialMigrationPlan;
  readonly backupPath: string;
  readonly restoreTarget: string;
  readonly db: SqlExecutor;
  readonly manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>>;
  readonly backupReceipt?: BackupReceipt;
  readonly now?: Date;
  readonly ttlMs?: number;
}

export interface OfficialOperationAudit {
  readonly schemaVersion: typeof OFFICIAL_ARTIFACT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly repoSha: string;
  readonly targetFingerprint: string;
  readonly manifestDigest: string;
  readonly laneStateDigest: string;
  readonly actor: string;
  readonly candidateSha: string;
  readonly receiptDigests: readonly string[];
  readonly beforeLaneStates: Readonly<Partial<Record<MigrationLane, LaneState>>>;
  readonly afterLaneStates: Readonly<Partial<Record<MigrationLane, LaneState>>>;
  readonly executedOrdinals: Readonly<Partial<Record<MigrationLane, readonly number[]>>>;
  readonly lock: 'not-acquired' | 'acquired';
  readonly drain: 'verified';
  readonly outcome: 'start' | 'takeover' | 'success' | 'failure' | 'rollback';
  readonly priorOperationId?: string;
  readonly error?: string;
  readonly contentDigest: string;
}

function fail(
  code: ConstructorParameters<typeof MigrationRunnerError>[0],
  message: string,
  details?: Record<string, unknown>
): never {
  throw new MigrationRunnerError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Stable JSON with sorted object keys; arrays retain their semantic order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('MIGRATION_ARTIFACT_INVALID', 'artifact contains a non-finite number');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(String(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  fail('MIGRATION_ARTIFACT_INVALID', 'artifact contains an unsupported value');
}

export function canonicalDigest(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function artifactDigest(value: Record<string, unknown>): string {
  const { contentDigest: _contentDigest, ...unsigned } = value;
  return canonicalDigest(unsigned);
}

export function sealArtifact<T extends Record<string, unknown>>(
  value: T
): T & { contentDigest: string } {
  const { contentDigest: _contentDigest, ...unsigned } = value;
  return { ...unsigned, contentDigest: artifactDigest(unsigned) } as T & {
    contentDigest: string;
  };
}

function assertSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('MIGRATION_ARTIFACT_INVALID', `${field} must be a lowercase SHA-256 digest`);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('MIGRATION_ARTIFACT_INVALID', `${field} must be an ISO timestamp`);
  }
}

function assertCommonArtifact(
  value: unknown,
  kind: string,
  now: Date
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    fail('MIGRATION_ARTIFACT_INVALID', `${kind} must be a JSON object`);
  }
  if (value.schemaVersion !== OFFICIAL_ARTIFACT_SCHEMA_VERSION) {
    fail('MIGRATION_ARTIFACT_INVALID', `${kind} has an unsupported schemaVersion`);
  }
  if (typeof value.operationId !== 'string' || !OPERATION_PATTERN.test(value.operationId)) {
    fail('MIGRATION_ARTIFACT_INVALID', `${kind} has an invalid operationId`);
  }
  assertTimestamp(value.createdAt, `${kind}.createdAt`);
  assertTimestamp(value.expiresAt, `${kind}.expiresAt`);
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    fail('MIGRATION_ARTIFACT_INVALID', `${kind}.expiresAt must be after createdAt`);
  }
  if (Date.parse(value.expiresAt) <= now.getTime()) {
    fail('MIGRATION_ARTIFACT_EXPIRED', `${kind} has expired`);
  }
  if (typeof value.repoSha !== 'string' || value.repoSha.length < 7 || value.repoSha.length > 128) {
    fail('MIGRATION_ARTIFACT_INVALID', `${kind}.repoSha is missing or invalid`);
  }
  assertSha(value.targetFingerprint, `${kind}.targetFingerprint`);
  assertSha(value.manifestDigest, `${kind}.manifestDigest`);
  assertSha(value.laneStateDigest, `${kind}.laneStateDigest`);
  assertSha(value.contentDigest, `${kind}.contentDigest`);
  if (artifactDigest(value) !== value.contentDigest) {
    fail('MIGRATION_ARTIFACT_INVALID', `${kind} contentDigest does not match canonical content`);
  }
}

export function assertArtifactIntegrity(
  value: unknown,
  kind = 'artifact',
  now = new Date()
): asserts value is Record<string, unknown> {
  assertCommonArtifact(value, kind, now);
}

export function parseArtifact<T extends Record<string, unknown>>(
  text: string,
  kind: string,
  now = new Date()
): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('MIGRATION_ARTIFACT_INVALID', `${kind} is not valid JSON`);
  }
  assertArtifactIntegrity(value, kind, now);
  return value as T;
}

export function assertOfficialRouteMode(env: { RAG_MIGRATION_TARGET?: string }): void {
  if (env.RAG_MIGRATION_TARGET === 'isolated') {
    fail(
      'MIGRATION_OFFICIAL_TARGET_REJECTED',
      'official migration commands cannot run with RAG_MIGRATION_TARGET=isolated'
    );
  }
}

export function assertOfficialMutationGates(
  env: OfficialMutationGateEnv,
  opts: { execute: boolean; expectedTargetFingerprint?: string }
): void {
  if (!opts.execute) {
    fail('MIGRATION_OFFICIAL_ACK_REQUIRED', 'official mutation requires --execute');
  }
  if (env.RAG_MIGRATION_TARGET !== OFFICIAL_TARGET) {
    fail(
      'MIGRATION_OFFICIAL_TARGET_REJECTED',
      'official mutation requires RAG_MIGRATION_TARGET=official'
    );
  }
  if (env.RAG_MIGRATION_OFFICIAL_ACK !== OFFICIAL_ACK) {
    fail(
      'MIGRATION_OFFICIAL_ACK_REQUIRED',
      `RAG_MIGRATION_OFFICIAL_ACK=${OFFICIAL_ACK} is required`
    );
  }
  if (env.RAG_MIGRATION_WRITE_ACK !== '1') {
    fail('MIGRATION_OFFICIAL_ACK_REQUIRED', 'RAG_MIGRATION_WRITE_ACK=1 is required');
  }
  if (env.RAG_MIGRATION_MAINTENANCE_ACK !== '1') {
    fail('MIGRATION_OFFICIAL_ACK_REQUIRED', 'RAG_MIGRATION_MAINTENANCE_ACK=1 is required');
  }
  const expected = env.RAG_MIGRATION_EXPECTED_TARGET_FINGERPRINT;
  assertSha(expected, 'RAG_MIGRATION_EXPECTED_TARGET_FINGERPRINT');
  if (opts.expectedTargetFingerprint && opts.expectedTargetFingerprint !== expected) {
    fail('MIGRATION_FINGERPRINT_MISMATCH', 'expected target fingerprints disagree');
  }
}

function assertOfficialRecoveryGates(
  env: OfficialMutationGateEnv,
  opts: { execute: boolean; expectedTargetFingerprint?: string }
): void {
  assertOfficialMutationGates(env, opts);
  if (env.RAG_MIGRATION_RECOVERY_ACK !== OFFICIAL_RECOVERY_ACK) {
    fail(
      'MIGRATION_OFFICIAL_ACK_REQUIRED',
      `RAG_MIGRATION_RECOVERY_ACK=${OFFICIAL_RECOVERY_ACK} is required`
    );
  }
}

/** Positive official-target policy; disposable URLs are never accepted here. */
export function assertOfficialTarget(
  rawValue: string,
  identity = canonicalizeMigrationTarget(rawValue)
): MigrationTargetIdentity {
  const raw = rawValue.trim().replace(/^['"]|['"]$/g, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('MIGRATION_OFFICIAL_TARGET_REJECTED', 'official target is not a valid Postgres URL');
  }
  if (url.search || url.hash) {
    fail(
      'MIGRATION_OFFICIAL_TARGET_REJECTED',
      'official database URLs may not contain query or fragment overrides'
    );
  }
  try {
    assertDisposableMigrationTarget(raw, identity);
    fail(
      'MIGRATION_OFFICIAL_TARGET_REJECTED',
      'disposable migration targets are not official targets'
    );
  } catch (error) {
    if (
      !(error instanceof MigrationRunnerError) ||
      error.code !== 'MIGRATION_TARGET_NOT_ISOLATED'
    ) {
      throw error;
    }
  }
  if (/^rag_v2_migration_[a-z0-9][a-z0-9_-]{0,45}$/.test(identity.database)) {
    fail('MIGRATION_OFFICIAL_TARGET_REJECTED', 'official target database has a disposable name');
  }
  return identity;
}

export function assertExpectedTargetFingerprint(expected: string, observed: string): void {
  assertSha(expected, 'expected target fingerprint');
  assertSha(observed, 'observed target fingerprint');
  if (expected !== observed) {
    fail(
      'MIGRATION_FINGERPRINT_MISMATCH',
      'connected server fingerprint does not match the operator expectation'
    );
  }
}

function assertPlanTarget(plan: OfficialMigrationPlan, identity: MigrationTargetIdentity): void {
  assertOfficialTarget(identity.redactedUrl, identity);
  for (const lane of plan.lanes) {
    const planned = plan.targetIdentities[lane];
    if (
      planned.host !== identity.host ||
      planned.port !== identity.port ||
      planned.database !== identity.database
    ) {
      fail('MIGRATION_RECEIPT_MISMATCH', `official target identity differs for ${lane}`);
    }
  }
}

async function readPostgresVersion(db: SqlExecutor): Promise<string> {
  const rows = await db.unsafe(`select current_setting('server_version') as server_version`);
  const version = String(rows[0]?.server_version ?? '').trim();
  if (!version)
    fail('MIGRATION_ARTIFACT_INVALID', 'connected server did not return a Postgres version');
  return version.slice(0, 128);
}

function libpqEnvironment(identity: MigrationTargetIdentity, rawUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PGHOST = identity.host;
  env.PGPORT = String(identity.port);
  env.PGDATABASE = identity.database;
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.username) env.PGUSER = decodeURIComponent(url.username);
      if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
    } catch {
      // The URL was already canonicalized by the caller; never put it in an
      // error or command argument if its credential encoding is malformed.
    }
  }
  return env;
}

/** Execute pg_dump without placing the database URL in argv or artifacts. */
export async function runPgDump(input: {
  readonly rawUrl: string;
  readonly targetIdentity: MigrationTargetIdentity;
  readonly backupPath: string;
}): Promise<void> {
  try {
    await execFileAsync('pg_dump', ['--format=custom', '--file', input.backupPath], {
      env: libpqEnvironment(input.targetIdentity, input.rawUrl),
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    fail('MIGRATION_APPLY_FAILED', `pg_dump failed: ${describeError(error).message}`);
  }
}

/** Restore a custom-format dump using libpq environment fields, never a URL argument. */
export async function runPgRestore(input: {
  readonly rawUrl: string;
  readonly targetIdentity: MigrationTargetIdentity;
  readonly backupPath: string;
}): Promise<void> {
  const identity = canonicalizeMigrationTarget(input.rawUrl);
  assertDisposableMigrationTarget(input.rawUrl, identity);
  if (
    identity.host !== input.targetIdentity.host ||
    identity.port !== input.targetIdentity.port ||
    identity.database !== input.targetIdentity.database
  ) {
    fail('MIGRATION_RECEIPT_MISMATCH', 'restore target identity changed before restore');
  }
  try {
    await execFileAsync(
      'pg_restore',
      ['--exit-on-error', '--no-owner', '--format=custom', input.backupPath],
      { env: libpqEnvironment(input.targetIdentity, input.rawUrl), maxBuffer: 64 * 1024 }
    );
  } catch (error) {
    fail('MIGRATION_APPLY_FAILED', `pg_restore failed: ${describeError(error).message}`);
  }
}

/** Create exactly one named disposable database; an existing target is a refusal. */
export async function createDisposableDatabase(input: {
  readonly rawUrl: string;
  readonly targetIdentity: MigrationTargetIdentity;
}): Promise<void> {
  const identity = canonicalizeMigrationTarget(input.rawUrl);
  assertDisposableMigrationTarget(input.rawUrl, identity);
  if (
    identity.host !== input.targetIdentity.host ||
    identity.port !== input.targetIdentity.port ||
    identity.database !== input.targetIdentity.database
  ) {
    fail('MIGRATION_RECEIPT_MISMATCH', 'restore target identity changed before creation');
  }
  try {
    await execFileAsync(
      'createdb',
      ['--no-password', '--maintenance-db=postgres', identity.database],
      { env: libpqEnvironment(identity, input.rawUrl), maxBuffer: 64 * 1024 }
    );
  } catch (error) {
    fail(
      'MIGRATION_ARTIFACT_INVALID',
      `cannot create fresh disposable restore target: ${describeError(error).message}`
    );
  }
}

/** Remove only the disposable database created by this verification attempt. */
export async function dropDisposableDatabase(input: {
  readonly rawUrl: string;
  readonly targetIdentity: MigrationTargetIdentity;
}): Promise<void> {
  const identity = canonicalizeMigrationTarget(input.rawUrl);
  assertDisposableMigrationTarget(input.rawUrl, identity);
  if (
    identity.host !== input.targetIdentity.host ||
    identity.port !== input.targetIdentity.port ||
    identity.database !== input.targetIdentity.database
  ) {
    fail('MIGRATION_RECEIPT_MISMATCH', 'restore target identity changed before cleanup');
  }
  try {
    await execFileAsync(
      'dropdb',
      ['--no-password', '--if-exists', '--maintenance-db=postgres', identity.database],
      { env: libpqEnvironment(identity, input.rawUrl), maxBuffer: 64 * 1024 }
    );
  } catch (error) {
    fail(
      'MIGRATION_ARTIFACT_INVALID',
      `cannot clean disposable restore target: ${describeError(error).message}`
    );
  }
}

const DRAIN_ACTIVITY_SQL = `select
  current_setting('max_connections')::integer as connection_limit,
  (select count(*)::integer
   from pg_stat_activity
   where backend_type = 'client backend'
     and pid <> pg_backend_pid()) as active_sessions,
  (select count(*)::integer
   from pg_stat_activity
   where backend_type = 'client backend'
     and pid <> pg_backend_pid()
     and xact_start is not null) as active_transactions,
  exists (
    select 1 from pg_stat_activity a
    join pg_roles r on r.rolname = a.usename
    where a.backend_type = 'client backend'
      and a.pid <> pg_backend_pid()
      and (r.rolsuper or r.rolreplication or r.rolbypassrls)
  ) as bypass_role_detected`;
const DRAIN_GRANTS_SQL = `select coalesce(
  string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type),
  ''
) as grants_material from information_schema.role_table_grants where table_schema = 'public'
  and (table_schema || '.' || table_name) <> '${MIGRATION_MAINTENANCE_TABLE}'`;

/** Observe drain state without exposing session identities or grant material. */
export async function readDrainObservation(
  db: SqlExecutor,
  baselineConnectionLimit?: number
): Promise<WriteDrainObservation> {
  const [activityRows, grantsRows] = await Promise.all([
    db.unsafe(DRAIN_ACTIVITY_SQL),
    db.unsafe(DRAIN_GRANTS_SQL),
  ]);
  const row = activityRows[0] ?? {};
  const connectionLimit = Number(row.connection_limit);
  const activeSessions = Number(row.active_sessions);
  const activeTransactions = Number(row.active_transactions);
  if (
    !Number.isSafeInteger(connectionLimit) ||
    connectionLimit < 1 ||
    !Number.isSafeInteger(activeSessions) ||
    activeSessions < 0 ||
    !Number.isSafeInteger(activeTransactions) ||
    activeTransactions < 0
  ) {
    fail('MIGRATION_DRAIN_REQUIRED', 'database drain observation is incomplete');
  }
  const grantsMaterial = String(grantsRows[0]?.grants_material ?? '');
  const drained = activeSessions === 0 && activeTransactions === 0;
  return {
    activeSessions,
    activeTransactions,
    connectionLimit,
    baselineConnectionLimit: baselineConnectionLimit ?? connectionLimit,
    bypassRoleDetected: row.bypass_role_detected === true,
    settlingMs: 0,
    drained,
    grantsDigest: sha256Text(grantsMaterial),
  };
}

export async function runOfficialDrain(input: OfficialDrainRequest): Promise<WriteDrainReceipt> {
  const now = input.now ?? new Date();
  validateOfficialPlan(input.plan, now);
  assertPlanTarget(input.plan, input.targetIdentity);
  const server = await readServerFingerprintV2(input.db, input.targetIdentity);
  assertExpectedTargetFingerprint(input.plan.targetFingerprint, server.fingerprint);
  const settlingMs = input.settlingMs ?? 1_000;
  if (!Number.isSafeInteger(settlingMs) || settlingMs < 1 || settlingMs > 60_000) {
    fail('MIGRATION_DRAIN_REQUIRED', 'drain settling interval must be between 1ms and 60000ms');
  }
  const first = await readDrainObservation(input.db);
  if (!first.drained || first.bypassRoleDetected) {
    fail('MIGRATION_DRAIN_REQUIRED', 'database still has active sessions or a bypass role');
  }
  await (
    input.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  )(settlingMs);
  const second = await readDrainObservation(input.db, first.connectionLimit);
  if (
    !second.drained ||
    second.bypassRoleDetected ||
    second.connectionLimit !== first.connectionLimit ||
    second.grantsDigest !== first.grantsDigest
  ) {
    fail('MIGRATION_DRAIN_REQUIRED', 'database drain was lost during the settling interval');
  }
  return createWriteDrainReceipt({
    plan: input.plan,
    observation: { ...second, settlingMs },
    now,
    ttlMs: input.ttlMs,
  });
}

export function manifestChecksumsFor(
  manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>>,
  lanes: readonly MigrationLane[]
): Readonly<Record<MigrationLane, readonly string[]>> {
  const result = {} as Record<MigrationLane, readonly string[]>;
  for (const lane of lanes) {
    result[lane] = manifests[lane].map(
      (item) => `${item.descriptor.ordinal}:${item.checksumSha256}`
    );
  }
  return result;
}

export function manifestDigestFor(
  checksums: Readonly<Record<MigrationLane, readonly string[]>>
): string {
  return canonicalDigest(checksums);
}

function prefixForState(state: LaneState, challenge?: AdoptionChallenge): number {
  if (challenge) return challenge.prefixOrdinal;
  if (state.kind === 'fresh') return 0;
  if (state.kind === 'adoption_required') return 0;
  if (state.kind === 'up_to_date' || state.kind === 'upgrade_pending') {
    return state.appliedThrough;
  }
  return 0;
}

function stateForReport(
  lane: MigrationLane,
  report: Awaited<ReturnType<typeof readLaneStatus>>,
  challengeOverride?: AdoptionChallenge
): OfficialLanePlanState {
  const challenge = challengeOverride ?? report.adoptionChallenge;
  const stateDigestInput = {
    lane,
    state: report.state,
    applied: report.applied,
    pending: report.pending,
    challenge: challenge ?? null,
    unsupportedAdoptionReason: report.unsupportedAdoptionReason ?? null,
  };
  return {
    lane,
    state: report.state,
    prefixOrdinal: prefixForState(report.state, challenge),
    pendingOrdinals: report.pending.map((item) => item.ordinal),
    statusDigest: canonicalDigest(stateDigestInput),
    probeDigest: canonicalDigest(challenge ?? { state: report.state }),
    ...(challenge ? { challenge } : {}),
  };
}

type AdoptionChallengeShape = Pick<
  AdoptionChallenge,
  | 'lane'
  | 'prefixOrdinal'
  | 'provenArtifacts'
  | 'absentOrdinals'
  | 'manifestChecksums'
  | 'recordKind'
>;

function adoptionChallengeShape(challenge: AdoptionChallenge): AdoptionChallengeShape {
  return {
    lane: challenge.lane,
    prefixOrdinal: challenge.prefixOrdinal,
    provenArtifacts: challenge.provenArtifacts,
    absentOrdinals: challenge.absentOrdinals,
    manifestChecksums: challenge.manifestChecksums,
    recordKind: challenge.recordKind,
  };
}

function adoptionChallengeShapesMatch(
  restored: AdoptionChallenge,
  planned: AdoptionChallenge
): boolean {
  return (
    canonicalDigest(adoptionChallengeShape(restored)) ===
    canonicalDigest(adoptionChallengeShape(planned))
  );
}

function laneStateDigestFor(
  states: Readonly<Record<MigrationLane, OfficialLanePlanState>>
): string {
  return canonicalDigest(
    Object.fromEntries(
      Object.entries(states)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([lane, state]) => [lane, state.statusDigest])
    )
  );
}

async function repositorySha(repoRoot: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 1024,
    });
    const sha = String(result.stdout).trim();
    if (!sha) fail('MIGRATION_ARTIFACT_INVALID', 'repository HEAD is empty');
    return sha;
  } catch (error) {
    if (error instanceof MigrationRunnerError) throw error;
    fail(
      'MIGRATION_ARTIFACT_INVALID',
      `cannot resolve repository SHA: ${describeError(error).message}`
    );
  }
}

export async function createOfficialPlan(input: {
  readonly lanes: readonly MigrationLane[];
  readonly dbByLane: Readonly<Record<MigrationLane, SqlExecutor>>;
  readonly manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>>;
  readonly targetIdentities: Readonly<Record<MigrationLane, MigrationTargetIdentity>>;
  readonly expectedTargetFingerprint: string;
  readonly repoRoot?: string;
  readonly repoSha?: string;
  readonly operationId?: string;
  readonly now?: Date;
  readonly ttlMs?: number;
}): Promise<OfficialMigrationPlan> {
  const now = input.now ?? new Date();
  const lanes = [...new Set(input.lanes)];
  if (lanes.length === 0 || lanes.some((lane) => lane !== 'project' && lane !== 'docs')) {
    fail('MIGRATION_LANE_UNKNOWN', 'official plan requires at least one known lane');
  }
  assertSha(input.expectedTargetFingerprint, 'expected target fingerprint');
  for (const lane of lanes) {
    assertOfficialTarget(input.targetIdentities[lane].redactedUrl, input.targetIdentities[lane]);
  }
  const repoSha =
    input.repoSha ?? (input.repoRoot ? await repositorySha(input.repoRoot) : 'unknown-repo-sha');
  if (repoSha === 'unknown-repo-sha') {
    fail('MIGRATION_ARTIFACT_INVALID', 'repoSha or repoRoot is required for an official plan');
  }
  const manifestChecksums = manifestChecksumsFor(input.manifests, lanes);
  const laneStates = {} as Record<MigrationLane, OfficialLanePlanState>;
  const targetFingerprints = {} as Record<MigrationLane, string>;
  const targetIdentities = {} as Record<
    MigrationLane,
    Pick<MigrationTargetIdentity, 'host' | 'port' | 'database'>
  >;
  for (const lane of lanes) {
    const identity = input.targetIdentities[lane];
    const server = await readServerFingerprintV2(input.dbByLane[lane], identity);
    assertExpectedTargetFingerprint(input.expectedTargetFingerprint, server.fingerprint);
    targetFingerprints[lane] = server.fingerprint;
    targetIdentities[lane] = {
      host: identity.host,
      port: identity.port,
      database: identity.database,
    };
    const report = await readLaneStatus({
      db: input.dbByLane[lane],
      lane,
      manifest: input.manifests[lane],
      redactedUrl: identity.redactedUrl,
      targetFingerprint: server.fingerprint,
    });
    laneStates[lane] = stateForReport(lane, report);
  }
  const unsigned = {
    schemaVersion: OFFICIAL_ARTIFACT_SCHEMA_VERSION,
    operationId: input.operationId ?? `official-${randomUUID()}`,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (input.ttlMs ?? DEFAULT_OFFICIAL_ARTIFACT_TTL_MS)
    ).toISOString(),
    repoSha,
    targetFingerprint: input.expectedTargetFingerprint,
    targetFingerprints,
    targetIdentities,
    lanes,
    manifestChecksums,
    manifestDigest: manifestDigestFor(manifestChecksums),
    laneStates,
    laneStateDigest: laneStateDigestFor(laneStates),
  };
  if (!OPERATION_PATTERN.test(unsigned.operationId)) {
    fail('MIGRATION_ARTIFACT_INVALID', 'operationId is invalid');
  }
  return sealArtifact(unsigned) as OfficialMigrationPlan;
}

function assertPlanShape(plan: unknown, now = new Date()): asserts plan is OfficialMigrationPlan {
  assertCommonArtifact(plan, 'official plan', now);
  if (!Array.isArray(plan.lanes) || plan.lanes.length === 0 || plan.lanes.length > 2) {
    fail('MIGRATION_ARTIFACT_INVALID', 'official plan lanes are invalid');
  }
  const seen = new Set<string>();
  for (const lane of plan.lanes) {
    if ((lane !== 'project' && lane !== 'docs') || seen.has(lane)) {
      fail('MIGRATION_ARTIFACT_INVALID', 'official plan contains an invalid or duplicate lane');
    }
    seen.add(lane);
    if (!isRecord(plan.manifestChecksums) || !Array.isArray(plan.manifestChecksums[lane])) {
      fail(
        'MIGRATION_ARTIFACT_INVALID',
        `official plan manifest checksums are missing for ${lane}`
      );
    }
    if (!isRecord(plan.targetFingerprints)) {
      fail('MIGRATION_ARTIFACT_INVALID', 'official plan target fingerprints are missing');
    }
    assertSha(plan.targetFingerprints[lane], `official plan targetFingerprints.${lane}`);
    if (plan.targetFingerprints[lane] !== plan.targetFingerprint) {
      fail(
        'MIGRATION_FINGERPRINT_MISMATCH',
        `official plan target fingerprint differs for ${lane}`
      );
    }
    if (!isRecord(plan.targetIdentities) || !isRecord(plan.targetIdentities[lane])) {
      fail('MIGRATION_ARTIFACT_INVALID', `official plan target identity is missing for ${lane}`);
    }
    const identity = plan.targetIdentities[lane];
    if (
      typeof identity.host !== 'string' ||
      !Number.isSafeInteger(identity.port) ||
      typeof identity.database !== 'string'
    ) {
      fail('MIGRATION_ARTIFACT_INVALID', `official plan target identity is invalid for ${lane}`);
    }
    if (!isRecord(plan.laneStates) || !isRecord(plan.laneStates[lane])) {
      fail('MIGRATION_ARTIFACT_INVALID', `official plan lane state is missing for ${lane}`);
    }
    const state = plan.laneStates[lane];
    assertSha(state.statusDigest, `official plan laneStates.${lane}.statusDigest`);
    assertSha(state.probeDigest, `official plan laneStates.${lane}.probeDigest`);
    if (!Number.isSafeInteger(state.prefixOrdinal) || (state.prefixOrdinal as number) < 0) {
      fail('MIGRATION_ARTIFACT_INVALID', `official plan prefix is invalid for ${lane}`);
    }
  }
  if (
    plan.manifestDigest !==
    manifestDigestFor(plan.manifestChecksums as Readonly<Record<MigrationLane, readonly string[]>>)
  ) {
    fail(
      'MIGRATION_ARTIFACT_INVALID',
      'official plan manifestDigest does not match manifest checksums'
    );
  }
  if (
    plan.laneStateDigest !==
    laneStateDigestFor(plan.laneStates as Readonly<Record<MigrationLane, OfficialLanePlanState>>)
  ) {
    fail('MIGRATION_ARTIFACT_INVALID', 'official plan laneStateDigest does not match lane states');
  }
}

export function validateOfficialPlan(plan: unknown, now = new Date()): OfficialMigrationPlan {
  assertPlanShape(plan, now);
  return plan;
}

async function syncFile(path: string): Promise<{ bytes: Buffer; size: number }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathInfo = await lstat(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      fail('MIGRATION_ARTIFACT_INVALID', 'backup path must be a non-symlink regular file');
    }
    handle = await open(path, 'r');
    await handle.sync();
    const [bytes, info] = await Promise.all([handle.readFile(), handle.stat()]);
    if (!info.isFile()) fail('MIGRATION_ARTIFACT_INVALID', 'backup path is not a regular file');
    return { bytes, size: info.size };
  } catch (error) {
    if (error instanceof MigrationRunnerError) throw error;
    throw new MigrationRunnerError(
      'MIGRATION_ARTIFACT_INVALID',
      `cannot read backup: ${describeError(error).message}`
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function createBackupReceipt(input: {
  readonly plan: OfficialMigrationPlan;
  readonly backupPath: string;
  readonly postgresVersion: string;
  readonly now?: Date;
  readonly ttlMs?: number;
}): Promise<BackupReceipt> {
  const now = input.now ?? new Date();
  validateOfficialPlan(input.plan, now);
  const { bytes, size } = await syncFile(input.backupPath);
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== 'PGDMP') {
    fail('MIGRATION_ARTIFACT_INVALID', 'backup is not a PostgreSQL custom-format dump');
  }
  if (!input.postgresVersion.trim()) {
    fail('MIGRATION_ARTIFACT_INVALID', 'Postgres version is required in the backup receipt');
  }
  return sealArtifact({
    schemaVersion: OFFICIAL_ARTIFACT_SCHEMA_VERSION,
    operationId: input.plan.operationId,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (input.ttlMs ?? DEFAULT_OFFICIAL_ARTIFACT_TTL_MS)
    ).toISOString(),
    repoSha: input.plan.repoSha,
    targetFingerprint: input.plan.targetFingerprint,
    manifestDigest: input.plan.manifestDigest,
    laneStateDigest: input.plan.laneStateDigest,
    planDigest: input.plan.contentDigest,
    backupSha256: sha256Bytes(bytes),
    backupSizeBytes: size,
    backupFormat: 'custom',
    postgresVersion: input.postgresVersion.trim().slice(0, 128),
    command: { program: 'pg_dump', format: 'custom' },
  }) as unknown as BackupReceipt;
}

export async function runOfficialBackup(
  input: OfficialBackupRequest & { readonly rawUrl?: string }
): Promise<BackupReceipt> {
  const now = input.now ?? new Date();
  validateOfficialPlan(input.plan, now);
  assertPlanTarget(input.plan, input.targetIdentity);
  const server = input.db
    ? await readServerFingerprintV2(input.db, input.targetIdentity)
    : undefined;
  if (server) assertExpectedTargetFingerprint(input.plan.targetFingerprint, server.fingerprint);
  if (input.dump) await input.dump();
  else {
    if (!input.rawUrl) {
      fail('MIGRATION_ACK_REQUIRED', 'official backup requires the explicit lane URL');
    }
    await runPgDump({
      rawUrl: input.rawUrl,
      targetIdentity: input.targetIdentity,
      backupPath: input.backupPath,
    });
  }
  const postgresVersion = input.db ? await readPostgresVersion(input.db) : 'unknown';
  return createBackupReceipt({
    plan: input.plan,
    backupPath: input.backupPath,
    postgresVersion,
    now,
    ttlMs: input.ttlMs,
  });
}

function assertBoundToPlan(
  artifact: Record<string, unknown>,
  plan: OfficialMigrationPlan,
  kind: string
): void {
  for (const field of [
    'operationId',
    'repoSha',
    'targetFingerprint',
    'manifestDigest',
    'laneStateDigest',
  ] as const) {
    if (artifact[field] !== plan[field]) {
      fail('MIGRATION_RECEIPT_MISMATCH', `${kind}.${field} does not match the official plan`);
    }
  }
  if (artifact.planDigest !== plan.contentDigest) {
    fail(
      'MIGRATION_RECEIPT_MISMATCH',
      `${kind}.planDigest does not match the official plan contentDigest`
    );
  }
}

export function validateBackupReceipt(
  receipt: unknown,
  plan: OfficialMigrationPlan,
  now = new Date()
): BackupReceipt {
  assertCommonArtifact(receipt, 'backup receipt', now);
  assertBoundToPlan(receipt, plan, 'backup receipt');
  assertSha(receipt.backupSha256, 'backup receipt.backupSha256');
  if (
    receipt.backupFormat !== 'custom' ||
    !isRecord(receipt.command) ||
    receipt.command.program !== 'pg_dump'
  ) {
    fail('MIGRATION_ARTIFACT_INVALID', 'backup receipt is not custom-format pg_dump evidence');
  }
  if (!Number.isSafeInteger(receipt.backupSizeBytes) || (receipt.backupSizeBytes as number) < 5) {
    fail('MIGRATION_ARTIFACT_INVALID', 'backup receipt size is invalid');
  }
  return receipt as unknown as BackupReceipt;
}

export interface RestoreVerificationInput {
  readonly schemaProbes: Readonly<Record<MigrationLane, boolean>>;
  readonly lanePrefixes: Readonly<Record<MigrationLane, number>>;
  readonly rowCountDigests: Readonly<Record<string, string>>;
  readonly readSmoke: boolean;
}

export async function createRestoreVerificationReceipt(input: {
  readonly plan: OfficialMigrationPlan;
  readonly backupReceipt: BackupReceipt;
  readonly backupPath: string;
  readonly restoreTarget: string;
  readonly restoreTargetFingerprint?: string;
  readonly verification: RestoreVerificationInput;
  readonly now?: Date;
  readonly ttlMs?: number;
}): Promise<RestoreVerificationReceipt> {
  const now = input.now ?? new Date();
  validateOfficialPlan(input.plan, now);
  validateBackupReceipt(input.backupReceipt, input.plan, now);
  const identity = canonicalizeMigrationTarget(input.restoreTarget);
  assertDisposableMigrationTarget(input.restoreTarget, identity);
  const { bytes, size } = await syncFile(input.backupPath);
  const checksum = sha256Bytes(bytes);
  if (
    checksum !== input.backupReceipt.backupSha256 ||
    size !== input.backupReceipt.backupSizeBytes
  ) {
    fail('MIGRATION_RECEIPT_MISMATCH', 'backup changed after the backup receipt was created');
  }
  if (!input.verification.readSmoke) {
    fail('MIGRATION_ARTIFACT_INVALID', 'restore verification requires a successful read smoke');
  }
  if (input.restoreTargetFingerprint !== undefined) {
    assertSha(input.restoreTargetFingerprint, 'restore target fingerprint');
  }
  for (const lane of input.plan.lanes) {
    if (input.verification.schemaProbes[lane] !== true) {
      fail('MIGRATION_ARTIFACT_INVALID', `restore schema probes failed for ${lane}`);
    }
    const prefix = input.verification.lanePrefixes[lane];
    const max = input.plan.manifestChecksums[lane]?.length ?? 0;
    if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > max) {
      fail('MIGRATION_ARTIFACT_INVALID', `restore lane prefix is invalid for ${lane}`);
    }
  }
  for (const digest of Object.values(input.verification.rowCountDigests))
    assertSha(digest, 'row-count digest');
  return sealArtifact({
    schemaVersion: OFFICIAL_ARTIFACT_SCHEMA_VERSION,
    operationId: input.plan.operationId,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (input.ttlMs ?? DEFAULT_OFFICIAL_ARTIFACT_TTL_MS)
    ).toISOString(),
    repoSha: input.plan.repoSha,
    targetFingerprint: input.plan.targetFingerprint,
    manifestDigest: input.plan.manifestDigest,
    laneStateDigest: input.plan.laneStateDigest,
    planDigest: input.plan.contentDigest,
    backupReceiptDigest: input.backupReceipt.contentDigest,
    backupSha256: checksum,
    backupSizeBytes: size,
    restoreTarget: 'disposable',
    ...(input.restoreTargetFingerprint
      ? { restoreTargetFingerprint: input.restoreTargetFingerprint }
      : {}),
    schemaProbes: input.verification.schemaProbes,
    lanePrefixes: input.verification.lanePrefixes,
    rowCountDigests: input.verification.rowCountDigests,
    readSmoke: true,
  }) as unknown as RestoreVerificationReceipt;
}

export function validateRestoreVerificationReceipt(
  receipt: unknown,
  plan: OfficialMigrationPlan,
  backupReceipt: BackupReceipt,
  now = new Date()
): RestoreVerificationReceipt {
  assertCommonArtifact(receipt, 'restore verification receipt', now);
  assertBoundToPlan(receipt, plan, 'restore verification receipt');
  if (receipt.backupReceiptDigest !== backupReceipt.contentDigest) {
    fail(
      'MIGRATION_RECEIPT_MISMATCH',
      'restore receipt is not bound to the supplied backup receipt'
    );
  }
  assertSha(receipt.backupSha256, 'restore receipt.backupSha256');
  if (receipt.restoreTargetFingerprint !== undefined) {
    assertSha(receipt.restoreTargetFingerprint, 'restore receipt.restoreTargetFingerprint');
  }
  if (receipt.restoreTarget !== 'disposable' || receipt.readSmoke !== true) {
    fail(
      'MIGRATION_ARTIFACT_INVALID',
      'restore receipt is not verified disposable read-smoke evidence'
    );
  }
  return receipt as unknown as RestoreVerificationReceipt;
}

function assertLiveRestoreVerificationReceipt(receipt: RestoreVerificationReceipt): void {
  const observedFingerprint = liveRestoreReceiptFingerprints.get(receipt);
  if (
    observedFingerprint === undefined ||
    receipt.restoreTargetFingerprint !== observedFingerprint
  ) {
    fail(
      'MIGRATION_RECEIPT_MISMATCH',
      'official apply requires a restore receipt produced by the live verifier in this process'
    );
  }
}

const CRITICAL_TABLES: Readonly<Record<MigrationLane, readonly string[]>> = {
  project: [
    'project_repositories',
    'project_files',
    'project_chunks',
    'project_embeddings_1024',
    'project_jobs',
  ],
  docs: ['docs_documents', 'docs_chunks', 'docs_embeddings'],
};

async function readCriticalRowCountDigests(
  db: SqlExecutor,
  lanes: readonly MigrationLane[]
): Promise<Readonly<Record<string, string>>> {
  const counts: Record<string, number> = {};
  for (const lane of lanes) {
    for (const table of CRITICAL_TABLES[lane]) {
      const relation = await db.unsafe('select to_regclass($1::text) as relation', [table]);
      if (!relation[0]?.relation) continue;
      const rows = await db.unsafe(`select count(*)::text as row_count from public.${table}`);
      const count = Number(rows[0]?.row_count);
      if (!Number.isSafeInteger(count) || count < 0) {
        fail('MIGRATION_ARTIFACT_INVALID', `row count is invalid for ${lane}.${table}`);
      }
      counts[`${lane}.${table}`] = count;
    }
  }
  if (Object.keys(counts).length === 0) {
    fail('MIGRATION_ARTIFACT_INVALID', 'restored database has no critical lane tables');
  }
  return Object.fromEntries(
    Object.entries(counts).map(([table, count]) => [
      table,
      sha256Text(canonicalJson({ table, count })),
    ])
  );
}

/** Inspect a connected disposable restore; no caller-supplied booleans are trusted. */
export async function verifyRestoredDatabase(input: {
  readonly plan: OfficialMigrationPlan;
  readonly backupReceipt: BackupReceipt;
  readonly backupPath: string;
  readonly restoreTarget: string;
  readonly db: SqlExecutor;
  readonly manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>>;
  readonly now?: Date;
  readonly ttlMs?: number;
}): Promise<RestoreVerificationReceipt> {
  const now = input.now ?? new Date();
  validateOfficialPlan(input.plan, now);
  validateBackupReceipt(input.backupReceipt, input.plan, now);
  const restoreIdentity = canonicalizeMigrationTarget(input.restoreTarget);
  assertDisposableMigrationTarget(input.restoreTarget, restoreIdentity);
  const { bytes, size } = await syncFile(input.backupPath);
  const backupSha256 = sha256Bytes(bytes);
  if (
    backupSha256 !== input.backupReceipt.backupSha256 ||
    size !== input.backupReceipt.backupSizeBytes
  ) {
    fail('MIGRATION_RECEIPT_MISMATCH', 'backup checksum changed before restore inspection');
  }

  // The restore target is disposable, but its URL alone is not evidence that
  // the reserved connection reached that database. Read the connected server
  // identity before any schema inspection and bind the observed fingerprint to
  // the live receipt. A mismatched current_database() is rejected by the v2
  // helper rather than being allowed to produce a plausible receipt.
  const restoreServer = await readServerFingerprintV2(input.db, restoreIdentity);
  if (
    restoreServer.host !== restoreIdentity.host ||
    restoreServer.port !== restoreIdentity.port ||
    restoreServer.database !== restoreIdentity.database
  ) {
    fail(
      'MIGRATION_FINGERPRINT_MISMATCH',
      'connected database does not match the disposable restore target'
    );
  }

  const schemaProbes = {} as Record<MigrationLane, boolean>;
  const lanePrefixes = {} as Record<MigrationLane, number>;
  for (const lane of input.plan.lanes) {
    const status = await readLaneStatus({
      db: input.db,
      lane,
      manifest: input.manifests[lane],
      redactedUrl: restoreIdentity.redactedUrl,
      targetFingerprint: restoreServer.fingerprint,
    });
    const planned = input.plan.laneStates[lane];
    let challengeForState: AdoptionChallenge | undefined;
    if (status.state.kind === 'adoption_required') {
      const restoredChallenge = status.adoptionChallenge;
      const plannedChallenge = planned.challenge;
      if (!restoredChallenge || !plannedChallenge) {
        fail('MIGRATION_RECEIPT_MISMATCH', `restored ${lane} adoption challenge is missing`);
      }
      if (!adoptionChallengeShapesMatch(restoredChallenge, plannedChallenge)) {
        fail(
          'MIGRATION_RECEIPT_MISMATCH',
          `restored ${lane} adoption challenge differs from the plan`
        );
      }
      challengeForState = plannedChallenge;
    }
    const current = stateForReport(lane, status, challengeForState);
    if (current.statusDigest !== planned.statusDigest) {
      fail('MIGRATION_RECEIPT_MISMATCH', `restored ${lane} lane state differs from the plan`);
    }
    const prefix = current.prefixOrdinal;
    lanePrefixes[lane] = prefix;
    const probes = await probeLane(input.db, lane, prefix);
    schemaProbes[lane] = probes.every((probe) => probe.passed);
    if (!schemaProbes[lane]) {
      fail('MIGRATION_ARTIFACT_INVALID', `restored ${lane} schema probes failed`);
    }
  }
  const smoke = await input.db.unsafe('select 1 as ready');
  if (smoke[0]?.ready !== 1 && smoke[0]?.ready !== '1') {
    fail('MIGRATION_ARTIFACT_INVALID', 'restored database read smoke failed');
  }
  const rowCountDigests = await readCriticalRowCountDigests(input.db, input.plan.lanes);
  const receipt = await createRestoreVerificationReceipt({
    plan: input.plan,
    backupReceipt: input.backupReceipt,
    backupPath: input.backupPath,
    restoreTarget: input.restoreTarget,
    restoreTargetFingerprint: restoreServer.fingerprint,
    verification: {
      schemaProbes,
      lanePrefixes,
      rowCountDigests,
      readSmoke: true,
    },
    now,
    ttlMs: input.ttlMs,
  });
  liveRestoreReceiptFingerprints.set(receipt, restoreServer.fingerprint);
  return receipt;
}

export async function runOfficialVerifyBackup(
  input: OfficialVerifyBackupRequest
): Promise<RestoreVerificationReceipt> {
  const now = input.now ?? new Date();
  validateOfficialPlan(input.plan, now);
  const restoreIdentity = canonicalizeMigrationTarget(input.restoreTarget);
  assertDisposableMigrationTarget(input.restoreTarget, restoreIdentity);
  const backupReceipt =
    input.backupReceipt ??
    (await createBackupReceipt({
      plan: input.plan,
      backupPath: input.backupPath,
      postgresVersion: 'unknown',
      now,
      ttlMs: input.ttlMs,
    }));
  return verifyRestoredDatabase({
    plan: input.plan,
    backupReceipt,
    backupPath: input.backupPath,
    restoreTarget: input.restoreTarget,
    db: input.db,
    manifests: input.manifests,
    now,
    ttlMs: input.ttlMs,
  });
}

export function createWriteDrainReceipt(input: {
  readonly plan: OfficialMigrationPlan;
  readonly observation: WriteDrainObservation;
  readonly now?: Date;
  readonly ttlMs?: number;
}): WriteDrainReceipt {
  const now = input.now ?? new Date();
  validateOfficialPlan(input.plan, now);
  const observation = input.observation;
  if (
    !observation.drained ||
    observation.activeSessions !== 0 ||
    observation.activeTransactions !== 0 ||
    observation.bypassRoleDetected ||
    !Number.isSafeInteger(observation.settlingMs) ||
    observation.settlingMs < 1
  ) {
    fail('MIGRATION_DRAIN_REQUIRED', 'write drain receipt must prove a settled zero-session drain');
  }
  return sealArtifact({
    schemaVersion: OFFICIAL_ARTIFACT_SCHEMA_VERSION,
    operationId: input.plan.operationId,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (input.ttlMs ?? DEFAULT_OFFICIAL_ARTIFACT_TTL_MS)
    ).toISOString(),
    repoSha: input.plan.repoSha,
    targetFingerprint: input.plan.targetFingerprint,
    manifestDigest: input.plan.manifestDigest,
    laneStateDigest: input.plan.laneStateDigest,
    planDigest: input.plan.contentDigest,
    drain: observation,
  }) as unknown as WriteDrainReceipt;
}

export function validateWriteDrainReceipt(
  receipt: unknown,
  plan: OfficialMigrationPlan,
  now = new Date()
): WriteDrainReceipt {
  assertCommonArtifact(receipt, 'write drain receipt', now);
  assertBoundToPlan(receipt, plan, 'write drain receipt');
  const drain = receipt.drain;
  if (
    !isRecord(drain) ||
    drain.drained !== true ||
    drain.activeSessions !== 0 ||
    drain.activeTransactions !== 0 ||
    drain.bypassRoleDetected === true
  ) {
    fail(
      'MIGRATION_DRAIN_REQUIRED',
      'write drain receipt does not prove a settled zero-session drain'
    );
  }
  assertSha(drain.grantsDigest, 'write drain receipt.drain.grantsDigest');
  return receipt as unknown as WriteDrainReceipt;
}

function auditSafe(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]').slice(0, 300);
  }
  if (Array.isArray(value)) return value.slice(0, 24).map(auditSafe);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      if (/url|password|passwd|secret|token|credential|key/i.test(key)) output[key] = '[REDACTED]';
      else output[key] = auditSafe(item);
    }
    return output;
  }
  return value;
}

export function createOperationAudit(
  input: Omit<OfficialOperationAudit, 'contentDigest'>
): OfficialOperationAudit {
  const safe = auditSafe(input) as Omit<OfficialOperationAudit, 'contentDigest'>;
  return sealArtifact(
    safe as unknown as Record<string, unknown>
  ) as unknown as OfficialOperationAudit;
}

export async function appendOfficialAudit(
  path: string,
  audit: OfficialOperationAudit
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const safe = createOperationAudit({ ...audit, contentDigest: undefined } as Omit<
      OfficialOperationAudit,
      'contentDigest'
    >);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    handle = await open(path, 'a', 0o600);
    await handle.write(`${canonicalJson(safe)}\n`);
    await handle.sync();
    await chmod(path, 0o600);
  } catch (error) {
    if (error instanceof MigrationRunnerError) throw error;
    fail('MIGRATION_AUDIT_FAILED', `cannot append official audit: ${describeError(error).message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertManifestBinding(
  plan: OfficialMigrationPlan,
  manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>>
): void {
  const current = manifestChecksumsFor(manifests, plan.lanes);
  if (manifestDigestFor(current) !== plan.manifestDigest) {
    fail('MIGRATION_RECEIPT_MISMATCH', 'current migration manifest differs from the official plan');
  }
  for (const lane of plan.lanes) {
    const expected = plan.manifestChecksums[lane];
    const actual = current[lane];
    if (
      expected.length !== actual.length ||
      expected.some((checksum, index) => checksum !== actual[index])
    ) {
      fail('MIGRATION_RECEIPT_MISMATCH', `current ${lane} manifest differs from the official plan`);
    }
  }
}

async function readOfficialLaneStates(input: {
  readonly plan: OfficialMigrationPlan;
  readonly db: SqlExecutor;
  readonly targetIdentity: MigrationTargetIdentity;
  readonly manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>>;
  readonly comparePlan?: boolean;
}): Promise<Record<MigrationLane, OfficialLanePlanState>> {
  const server = await readServerFingerprintV2(input.db, input.targetIdentity);
  assertExpectedTargetFingerprint(input.plan.targetFingerprint, server.fingerprint);
  const states = {} as Record<MigrationLane, OfficialLanePlanState>;
  for (const lane of input.plan.lanes) {
    const report = await readLaneStatus({
      db: input.db,
      lane,
      manifest: input.manifests[lane],
      redactedUrl: input.targetIdentity.redactedUrl,
      targetFingerprint: server.fingerprint,
    });
    const state = stateForReport(lane, report);
    const planned = input.plan.laneStates[lane];
    if (input.comparePlan !== false && state.statusDigest !== planned.statusDigest) {
      fail(
        'MIGRATION_RECEIPT_MISMATCH',
        `lane ${lane} changed after the official plan was captured`
      );
    }
    states[lane] = state;
  }
  return states;
}

function laneStatesOnly(
  states: Readonly<Record<MigrationLane, OfficialLanePlanState>>
): Readonly<Partial<Record<MigrationLane, LaneState>>> {
  return Object.fromEntries(
    Object.entries(states).map(([lane, state]) => [lane, state.state])
  ) as Readonly<Partial<Record<MigrationLane, LaneState>>>;
}

function executedOrdinalsOnly(
  rows: Readonly<Record<MigrationLane, readonly MigrationSummaryRow[]>>
): Readonly<Partial<Record<MigrationLane, readonly number[]>>> {
  return Object.fromEntries(
    Object.entries(rows).map(([lane, values]) => [lane, values.map((row) => row.ordinal)])
  ) as Readonly<Partial<Record<MigrationLane, readonly number[]>>>;
}

function makeAudit(input: {
  readonly plan: OfficialMigrationPlan;
  readonly now: Date;
  readonly actor?: string;
  readonly candidateSha?: string;
  readonly receiptDigests: readonly string[];
  readonly before: Readonly<Record<MigrationLane, OfficialLanePlanState>>;
  readonly after: Readonly<Record<MigrationLane, OfficialLanePlanState>>;
  readonly executed: Readonly<Record<MigrationLane, readonly MigrationSummaryRow[]>>;
  readonly outcome: OfficialOperationAudit['outcome'];
  readonly lock: OfficialOperationAudit['lock'];
  readonly priorOperationId?: string;
  readonly error?: string;
}): OfficialOperationAudit {
  return createOperationAudit({
    schemaVersion: OFFICIAL_ARTIFACT_SCHEMA_VERSION,
    operationId: input.plan.operationId,
    createdAt: input.now.toISOString(),
    expiresAt: input.plan.expiresAt,
    repoSha: input.plan.repoSha,
    targetFingerprint: input.plan.targetFingerprint,
    manifestDigest: input.plan.manifestDigest,
    laneStateDigest: input.plan.laneStateDigest,
    actor: input.actor ?? 'operator',
    candidateSha: input.candidateSha ?? input.plan.repoSha,
    receiptDigests: input.receiptDigests,
    beforeLaneStates: laneStatesOnly(input.before),
    afterLaneStates: laneStatesOnly(input.after),
    executedOrdinals: executedOrdinalsOnly(input.executed),
    lock: input.lock,
    drain: 'verified',
    outcome: input.outcome,
    ...(input.priorOperationId ? { priorOperationId: input.priorOperationId } : {}),
    ...(input.error ? { error: input.error } : {}),
  });
}

async function readOfficialMaintenanceMarker(db: SqlExecutor): Promise<string | undefined> {
  const relationRows = await db.unsafe('select to_regclass($1::text) as relation', [
    MIGRATION_MAINTENANCE_TABLE,
  ]);
  if (!relationRows[0]?.relation) return undefined;
  const rows = await db.unsafe(
    `select operation_id from ${MIGRATION_MAINTENANCE_TABLE}
     where id = ${MIGRATION_MAINTENANCE_MARKER_ID}`
  );
  const marker = rows[0];
  if (rows.length === 0) return undefined;
  if (!isRecord(marker) || typeof marker.operation_id !== 'string') {
    fail(
      'MIGRATION_DRAIN_REQUIRED',
      'migration maintenance marker could not be read after acquisition'
    );
  }
  if (!OPERATION_PATTERN.test(marker.operation_id)) {
    fail('MIGRATION_DRAIN_REQUIRED', 'migration maintenance marker operation is invalid');
  }
  return marker.operation_id;
}

async function establishOfficialMaintenanceMarker(
  db: SqlExecutor,
  operationId: string
): Promise<string> {
  await db.unsafe(`
    create table if not exists ${MIGRATION_MAINTENANCE_TABLE} (
      id smallint primary key check (id = ${MIGRATION_MAINTENANCE_MARKER_ID}),
      operation_id text not null,
      created_at timestamptz not null default clock_timestamp()
    )`);
  await db.unsafe(
    `insert into ${MIGRATION_MAINTENANCE_TABLE} (id, operation_id)
     values (${MIGRATION_MAINTENANCE_MARKER_ID}, $1)
     on conflict (id) do nothing`,
    [operationId]
  );
  const marker = await readOfficialMaintenanceMarker(db);
  if (!marker) {
    fail(
      'MIGRATION_DRAIN_REQUIRED',
      'migration maintenance marker could not be read after acquisition'
    );
  }
  return marker;
}

async function takeOverOfficialMaintenanceMarker(
  db: SqlExecutor,
  priorOperationId: string,
  operationId: string
): Promise<void> {
  const rows = await db.unsafe(
    `update ${MIGRATION_MAINTENANCE_TABLE}
     set operation_id = $1
     where id = ${MIGRATION_MAINTENANCE_MARKER_ID} and operation_id = $2
     returning operation_id`,
    [operationId, priorOperationId]
  );
  if (rows.length !== 1) {
    fail(
      'MIGRATION_LOCK_BUSY',
      'declared prior operation does not own the durable maintenance marker'
    );
  }
}

async function releaseOfficialMaintenanceMarker(
  db: SqlExecutor,
  operationId: string
): Promise<void> {
  const rows = await db.unsafe(
    `delete from ${MIGRATION_MAINTENANCE_TABLE}
     where id = ${MIGRATION_MAINTENANCE_MARKER_ID} and operation_id = $1
     returning id`,
    [operationId]
  );
  if (rows.length !== 1) {
    fail('MIGRATION_DRAIN_REQUIRED', 'migration maintenance marker ownership could not be proven');
  }
}

/**
 * Official two-lane execution.  All artifact, target, and manifest checks
 * happen before the reserved connection is touched.  The single advisory
 * lock is acquired before a durable maintenance marker. Project and Docs
 * write transactions take the matching shared lock and check that marker
 * before any DML. The marker remains after connection loss and is removed
 * only after the durable success audit, while the exclusive lock is held.
 */
async function runOfficialApplyInternal(
  input: OfficialApplyRequest,
  recovery?: { readonly priorOperationId: string }
): Promise<OfficialApplyResult> {
  const now = input.now ?? new Date();
  if (recovery) {
    if (
      typeof recovery.priorOperationId !== 'string' ||
      !OPERATION_PATTERN.test(recovery.priorOperationId)
    ) {
      fail('MIGRATION_ARTIFACT_INVALID', 'priorOperationId is invalid');
    }
    assertOfficialRecoveryGates(input.env, {
      execute: input.execute,
      expectedTargetFingerprint: input.plan.targetFingerprint,
    });
  } else {
    assertOfficialMutationGates(input.env, {
      execute: input.execute,
      expectedTargetFingerprint: input.plan.targetFingerprint,
    });
  }
  validateOfficialPlan(input.plan, now);
  validateBackupReceipt(input.backupReceipt, input.plan, now);
  validateRestoreVerificationReceipt(input.restoreReceipt, input.plan, input.backupReceipt, now);
  assertLiveRestoreVerificationReceipt(input.restoreReceipt);
  validateWriteDrainReceipt(input.drainReceipt, input.plan, now);
  assertPlanTarget(input.plan, input.targetIdentity);
  assertManifestBinding(input.plan, input.manifests);
  if (!input.auditPath) {
    fail('MIGRATION_AUDIT_FAILED', 'official apply requires an external audit path');
  }

  const emptyStates = input.plan.laneStates as Record<MigrationLane, OfficialLanePlanState>;
  const emptyExecuted = {} as Record<MigrationLane, readonly MigrationSummaryRow[]>;
  const receiptDigests = [
    input.plan.contentDigest,
    input.backupReceipt.contentDigest,
    input.restoreReceipt.contentDigest,
    input.drainReceipt.contentDigest,
  ];
  const startAudit = makeAudit({
    plan: input.plan,
    now,
    actor: input.actor,
    candidateSha: input.candidateSha,
    receiptDigests,
    before: emptyStates,
    after: emptyStates,
    executed: emptyExecuted,
    outcome: 'start',
    lock: 'not-acquired',
    ...(recovery ? { priorOperationId: recovery.priorOperationId } : {}),
  });
  // A failed start-audit append is deliberately before the first DB call.
  // This is always the module-owned fsyncing writer; callers cannot replace
  // the audit sink with an in-memory or no-op callback.
  await appendOfficialAudit(input.auditPath, startAudit);

  let before: Record<MigrationLane, OfficialLanePlanState> = emptyStates;
  let after: Record<MigrationLane, OfficialLanePlanState> = emptyStates;
  const executed = {} as Record<MigrationLane, readonly MigrationSummaryRow[]>;
  const adopted = {} as Record<MigrationLane, readonly MigrationSummaryRow[]>;
  let locked = false;
  let markerHeld = false;
  try {
    await acquireMigrationLock(input.db);
    locked = true;
    if (recovery) {
      const server = await readServerFingerprintV2(input.db, input.targetIdentity);
      assertExpectedTargetFingerprint(input.plan.targetFingerprint, server.fingerprint);
      const markerOperationId = await readOfficialMaintenanceMarker(input.db);
      if (markerOperationId !== recovery.priorOperationId) {
        fail(
          'MIGRATION_LOCK_BUSY',
          'declared prior operation does not own the durable maintenance marker'
        );
      }
      const takeover = makeAudit({
        plan: input.plan,
        now,
        actor: input.actor,
        candidateSha: input.candidateSha,
        receiptDigests,
        before: emptyStates,
        after: emptyStates,
        executed: emptyExecuted,
        outcome: 'takeover',
        lock: 'acquired',
        priorOperationId: recovery.priorOperationId,
      });
      // Record the takeover before changing marker ownership. If this append
      // fails, the old marker remains and the exclusive lock stays held.
      await appendOfficialAudit(input.auditPath, takeover);
      await takeOverOfficialMaintenanceMarker(
        input.db,
        recovery.priorOperationId,
        input.plan.operationId
      );
    } else {
      const markerOperationId = await establishOfficialMaintenanceMarker(
        input.db,
        input.plan.operationId
      );
      if (markerOperationId !== input.plan.operationId) {
        fail('MIGRATION_LOCK_BUSY', 'another official migration holds the maintenance marker');
      }
    }
    markerHeld = true;
    before = await readOfficialLaneStates({
      plan: input.plan,
      db: input.db,
      targetIdentity: input.targetIdentity,
      manifests: input.manifests,
    });
    const drain = await readDrainObservation(input.db, input.drainReceipt.drain.connectionLimit);
    if (
      !drain.drained ||
      drain.bypassRoleDetected ||
      drain.connectionLimit !== input.drainReceipt.drain.connectionLimit ||
      drain.grantsDigest !== input.drainReceipt.drain.grantsDigest
    ) {
      fail('MIGRATION_DRAIN_REQUIRED', 'write drain changed before official migration execution');
    }
    for (const lane of input.plan.lanes) {
      const planned = input.plan.laneStates[lane];
      if (planned.challenge) {
        const adoption = await runAdoptLocked({
          db: input.db,
          lane,
          manifest: input.manifests[lane],
          redactedUrl: input.targetIdentity.redactedUrl,
          targetFingerprint: input.plan.targetFingerprint,
          challengeDigest: planned.challenge.proofDigest,
        });
        adopted[lane] = adoption.adopted;
      } else {
        adopted[lane] = [];
      }
      const applied = await runApplyLocked({
        db: input.db,
        lane,
        manifest: input.manifests[lane],
        redactedUrl: input.targetIdentity.redactedUrl,
        targetFingerprint: input.plan.targetFingerprint,
      });
      executed[lane] = applied.executed;
    }
    after = await readOfficialLaneStates({
      plan: input.plan,
      db: input.db,
      targetIdentity: input.targetIdentity,
      manifests: input.manifests,
      comparePlan: false,
    });
    for (const lane of input.plan.lanes) {
      const state = after[lane];
      if (
        state.state.kind !== 'up_to_date' ||
        state.prefixOrdinal !== input.manifests[lane].length ||
        state.pendingOrdinals.length !== 0
      ) {
        fail('MIGRATION_APPLY_FAILED', `post-apply verification failed for ${lane}`);
      }
    }
  } catch (error) {
    const failure = makeAudit({
      plan: input.plan,
      now,
      actor: input.actor,
      candidateSha: input.candidateSha,
      receiptDigests,
      before,
      after,
      executed,
      outcome: 'failure',
      lock: locked ? 'acquired' : 'not-acquired',
      ...(recovery ? { priorOperationId: recovery.priorOperationId } : {}),
      error: describeError(error).message,
    });
    try {
      await appendOfficialAudit(input.auditPath, failure);
    } catch {
      // If the failure cannot be recorded, retain the exclusive lock.  The
      // caller must close the reserved connection or recover the audit sink.
    }
    // Do not reopen writers after a failed official operation.  The lock
    // remains held on this reserved connection until the caller explicitly
    // recovers the failure and closes the connection.
    throw error;
  }

  // The exclusive advisory lock keeps new writers denied until the internal
  // fsyncing audit append completes.
  const success = makeAudit({
    plan: input.plan,
    now,
    actor: input.actor,
    candidateSha: input.candidateSha,
    receiptDigests,
    before,
    after,
    executed,
    outcome: 'success',
    lock: 'acquired',
    ...(recovery ? { priorOperationId: recovery.priorOperationId } : {}),
  });
  // Never release the exclusive writer fence after a success-audit failure.
  // The caller must close the reserved connection or recover the audit sink.
  await appendOfficialAudit(input.auditPath, success);
  // Remove the durable marker only after appendOfficialAudit has fsynced the
  // success record. The exclusive lock remains held across both operations.
  if (markerHeld) {
    await releaseOfficialMaintenanceMarker(input.db, input.plan.operationId);
    markerHeld = false;
  }
  // Release the exclusive writer fence only after the marker is removed.
  if (locked) {
    await releaseMigrationLock(input.db);
    locked = false;
  }
  return {
    ok: true,
    operationId: input.plan.operationId,
    executed,
    adopted,
    after,
    audit: success,
  };
}

export async function runOfficialApply(input: OfficialApplyRequest): Promise<OfficialApplyResult> {
  return runOfficialApplyInternal(input);
}

export async function runOfficialRecovery(
  input: OfficialRecoveryRequest
): Promise<OfficialApplyResult> {
  return runOfficialApplyInternal(input, { priorOperationId: input.priorOperationId });
}

export async function readOfficialArtifact<T extends Record<string, unknown>>(
  path: string,
  kind: string,
  now = new Date()
): Promise<T> {
  try {
    return parseArtifact<T>(await readFile(path, 'utf8'), kind, now);
  } catch (error) {
    if (error instanceof MigrationRunnerError) throw error;
    fail('MIGRATION_ARTIFACT_INVALID', `cannot read ${kind}: ${describeError(error).message}`);
  }
}

/** Write a sealed artifact without exposing credentials or partially-written JSON. */
export async function writeOfficialArtifact(
  path: string,
  artifact: Record<string, unknown> | OfficialMigrationPlan
): Promise<void> {
  assertArtifactIntegrity(artifact);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.write(`${canonicalJson(artifact)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(temporaryPath);
    } catch {
      // Cleanup is best effort and never masks the write error.
    }
    if (error instanceof MigrationRunnerError) throw error;
    fail('MIGRATION_ARTIFACT_INVALID', `cannot write artifact: ${describeError(error).message}`);
  }
}
