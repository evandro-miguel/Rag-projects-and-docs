/**
 * CLI entry point for the fixed-manifest schema migration runner.
 *
 * Usage:
 *   bun run db:migrations -- status  --lane project|docs
 *   bun run db:migrations -- apply   --lane project|docs [--dry-run] --execute*
 *   bun run db:migrations -- adopt   --lane project|docs --challenge <digest> [--dry-run] --execute*
 *   bun run db:migrations -- official plan --lanes project,docs --expect-target <sha256> --out <plan.json>
 *   bun run db:migrations -- official backup --plan <plan.json> --backup <file>
 *   bun run db:migrations -- official verify-backup --plan <plan.json> --backup <file> --restore-receipt <file>
 *   bun run db:migrations -- official drain --plan <plan.json> --out <drain.json>
 *   bun run db:migrations -- official apply --plan <plan.json> --backup <file> --backup-receipt <file> --restore-target <url> --restore-receipt <file> --drain-receipt <file> --audit-path <file> --execute
 *   bun run db:migrations -- official recover --plan <plan.json> --backup <file> --backup-receipt <file> --restore-target <url> --restore-receipt <file> --drain-receipt <file> --prior-operation-id <id> --audit-path <file> --execute
 *
 * (*) apply/adopt mutate only with --execute AND
 *     RAG_MIGRATION_TARGET=isolated AND RAG_MIGRATION_WRITE_ACK=1, plus the
 *     runner's strict loopback disposable-target URL policy.
 *     The adopt challenge digest is the `adoptionChallenge.proofDigest`
 *     printed by a prior read-only status call.
 *     Official recovery additionally requires RAG_MIGRATION_RECOVERY_ACK.
 *
 * The database URL comes exclusively from the lane environment variable
 * (PROJECT_RAG_DATABASE_URL or DOCS_RAG_PG_LAB_DATABASE_URL); generic
 * variables are intentionally ignored.
 *
 * Output is always structured JSON. Errors are bounded and credential-
 * redacted; SQL file contents never appear in output.
 */

import { lstat } from 'node:fs/promises';
import {
  assertExpectedTargetFingerprint,
  assertOfficialMutationGates,
  assertOfficialRouteMode,
  assertOfficialTarget,
  type BackupReceipt,
  createBackupReceipt,
  createDisposableDatabase,
  createOfficialPlan,
  dropDisposableDatabase,
  OFFICIAL_RECOVERY_ACK,
  type OfficialMigrationPlan,
  type RestoreVerificationReceipt,
  readOfficialArtifact,
  runOfficialApply,
  runOfficialBackup as runOfficialBackupPrimitive,
  runOfficialDrain as runOfficialDrainPrimitive,
  runOfficialRecovery,
  runOfficialVerifyBackup as runOfficialVerifyBackupPrimitive,
  runPgRestore,
  validateBackupReceipt,
  validateOfficialPlan,
  validateRestoreVerificationReceipt,
  type WriteDrainReceipt,
  writeOfficialArtifact,
} from './official.js';
import {
  adaptReservedSql,
  assertDisposableMigrationTarget,
  assertMutationGates,
  canonicalizeMigrationTarget,
  DEFAULT_REPO_ROOT,
  describeError,
  isMigrationLane,
  type LoadedMigration,
  loadManifest,
  type MigrationLane,
  MigrationRunnerError,
  type MigrationTargetIdentity,
  resolveLaneDatabaseUrl,
  runAdopt,
  runApply,
  runStatus,
} from './runner.js';

const REPO_ROOT = DEFAULT_REPO_ROOT;

interface CliArgs {
  command?: 'status' | 'apply' | 'adopt';
  lane?: MigrationLane;
  execute: boolean;
  dryRun: boolean;
  challenge?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { execute: false, dryRun: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--execute':
        args.execute = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--lane':
        i += 1;
        args.lane = argv[i] as MigrationLane;
        break;
      case '--challenge':
        i += 1;
        args.challenge = argv[i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg?.startsWith('--')) {
          throw new MigrationRunnerError('MIGRATION_ACK_REQUIRED', `unknown flag ${arg}`);
        }
        positional.push(arg ?? '');
    }
  }
  if (positional.length !== 1) {
    throw new MigrationRunnerError(
      'MIGRATION_ACK_REQUIRED',
      'exactly one subcommand is required: status|apply|adopt'
    );
  }
  if (!['status', 'apply', 'adopt'].includes(positional[0])) {
    throw new MigrationRunnerError(
      'MIGRATION_ACK_REQUIRED',
      `unknown subcommand '${positional[0]}'`
    );
  }
  args.command = positional[0] as CliArgs['command'];
  return args;
}

function printHelp(): void {
  process.stderr.write(
    [
      'Usage:',
      '  db:migrations status  --lane project|docs',
      '  db:migrations apply   --lane project|docs [--dry-run] --execute',
      '  db:migrations adopt   --lane project|docs --challenge <digest> [--dry-run] --execute',
      '  db:migrations official plan --lanes project,docs --expect-target <sha256> --out <plan.json>',
      '  db:migrations official backup --plan <plan.json> --backup <file> [--out <receipt.json>]',
      '  db:migrations official verify-backup --plan <plan.json> --backup <file> --restore-receipt <file> [--backup-receipt <file>]',
      '  db:migrations official drain --plan <plan.json> --out <drain.json>',
      '  db:migrations official apply --plan <plan.json> --backup <file> --backup-receipt <file> --restore-target <url> --restore-receipt <file> --drain-receipt <file> --audit-path <file> --execute',
      '  db:migrations official recover --plan <plan.json> --backup <file> --backup-receipt <file> --restore-target <url> --restore-receipt <file> --drain-receipt <file> --prior-operation-id <id> --audit-path <file> --execute',
      '  db:migrations official rollback --operation <id> --backup-receipt <file> --execute',
      '',
      'Mutating commands additionally require RAG_MIGRATION_TARGET=isolated,',
      'RAG_MIGRATION_WRITE_ACK=1, and a loopback rag_v2_migration_* database on',
      'a non-official explicit port. The database URL is read from the explicit',
      'lane variable only: PROJECT_RAG_DATABASE_URL or DOCS_RAG_PG_LAB_DATABASE_URL.',
      'The adopt digest is the adoptionChallenge.proofDigest printed by status.',
      'Official commands reject isolated mode. Apply requires the exact official',
      'acknowledgements and RAG_MIGRATION_EXPECTED_TARGET_FINGERPRINT. Restore',
      'verification uses RAG_MIGRATION_RESTORE_DATABASE_URL or --restore-target,',
      'which must be a fresh loopback rag_v2_migration_* database.',
      'Official apply/recover require fresh receipts, exact target fingerprint, and an audit path.',
      'Official recover also requires RAG_MIGRATION_RECOVERY_ACK and',
      '--prior-operation-id matching the durable maintenance marker.',
      '',
      'Exit codes: 0 ok, 1 execution failure, 2 policy refusal, 3 lock busy.',
      '',
    ].join('\n')
  );
}

function fail(payload: { code: string; message: string; details?: Record<string, unknown> }): void {
  process.stdout.write(`${JSON.stringify({ ok: false, ...payload }, null, 2)}\n`);
  process.stderr.write(`db:migrations failed: ${payload.code}\n`);
  process.exitCode =
    payload.code === 'MIGRATION_LOCK_BUSY' ? 3 : payload.code === 'MIGRATION_APPLY_FAILED' ? 1 : 2;
}

function emit(payload: object): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

interface OfficialCliArgs {
  readonly command?:
    | 'plan'
    | 'backup'
    | 'verify-backup'
    | 'drain'
    | 'apply'
    | 'recover'
    | 'rollback';
  readonly lanes?: readonly MigrationLane[];
  readonly expectedTarget?: string;
  readonly plan?: string;
  readonly backup?: string;
  readonly restoreReceipt?: string;
  readonly backupReceipt?: string;
  readonly drainReceipt?: string;
  readonly restoreTarget?: string;
  readonly auditPath?: string;
  readonly actor?: string;
  readonly candidateSha?: string;
  readonly priorOperationId?: string;
  readonly settlingMs?: number;
  readonly out?: string;
  execute: boolean;
}

function parseOfficialArgs(argv: readonly string[]): OfficialCliArgs {
  const positional: string[] = [];
  const args: OfficialCliArgs = { execute: false };
  let lanes: readonly MigrationLane[] | undefined;
  let expectedTarget: string | undefined;
  let out: string | undefined;
  let plan: string | undefined;
  let backup: string | undefined;
  let restoreReceipt: string | undefined;
  let backupReceipt: string | undefined;
  let drainReceipt: string | undefined;
  let restoreTarget: string | undefined;
  let auditPath: string | undefined;
  let actor: string | undefined;
  let candidateSha: string | undefined;
  let priorOperationId: string | undefined;
  let settlingMs: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--lanes':
        i += 1;
        lanes = (argv[i] ?? '').split(',').filter(Boolean) as MigrationLane[];
        break;
      case '--expect-target':
        i += 1;
        expectedTarget = argv[i];
        break;
      case '--out':
        i += 1;
        out = argv[i];
        break;
      case '--plan':
        i += 1;
        plan = argv[i];
        break;
      case '--backup':
        i += 1;
        backup = argv[i];
        break;
      case '--restore-receipt':
        i += 1;
        restoreReceipt = argv[i];
        break;
      case '--backup-receipt':
        i += 1;
        backupReceipt = argv[i];
        break;
      case '--drain-receipt':
        i += 1;
        drainReceipt = argv[i];
        break;
      case '--restore-target':
        i += 1;
        restoreTarget = argv[i];
        break;
      case '--audit-path':
        i += 1;
        auditPath = argv[i];
        break;
      case '--actor':
        i += 1;
        actor = argv[i];
        break;
      case '--candidate-sha':
        i += 1;
        candidateSha = argv[i];
        break;
      case '--prior-operation-id':
      case '--prior-operation':
        i += 1;
        priorOperationId = argv[i];
        break;
      case '--settling-ms':
        i += 1;
        if (argv[i] === undefined) {
          fail({
            code: 'MIGRATION_ACK_REQUIRED',
            message: 'official command requires a value for --settling-ms',
          });
        }
        settlingMs = Number(argv[i]);
        break;
      case '--execute':
        args.execute = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg?.startsWith('--')) {
          throw new MigrationRunnerError('MIGRATION_ACK_REQUIRED', `unknown flag ${arg}`);
        }
        positional.push(arg ?? '');
    }
  }
  if (
    positional.length !== 1 ||
    !['plan', 'backup', 'verify-backup', 'drain', 'apply', 'recover', 'rollback'].includes(
      positional[0] ?? ''
    )
  ) {
    throw new MigrationRunnerError(
      'MIGRATION_ACK_REQUIRED',
      'official requires one subcommand: plan|backup|verify-backup|drain|apply|recover|rollback'
    );
  }
  return {
    command: positional[0] as OfficialCliArgs['command'],
    lanes,
    expectedTarget,
    out,
    plan,
    backup,
    restoreReceipt,
    backupReceipt,
    drainReceipt,
    restoreTarget,
    auditPath,
    actor,
    candidateSha,
    priorOperationId,
    execute: args.execute,
    settlingMs,
  };
}

function assertOfficialArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MigrationRunnerError('MIGRATION_ACK_REQUIRED', `${name} is required`);
  }
  return value;
}

function officialMutationEnv() {
  return {
    RAG_MIGRATION_TARGET: process.env.RAG_MIGRATION_TARGET,
    RAG_MIGRATION_OFFICIAL_ACK: process.env.RAG_MIGRATION_OFFICIAL_ACK,
    RAG_MIGRATION_WRITE_ACK: process.env.RAG_MIGRATION_WRITE_ACK,
    RAG_MIGRATION_MAINTENANCE_ACK: process.env.RAG_MIGRATION_MAINTENANCE_ACK,
    RAG_MIGRATION_RECOVERY_ACK: process.env.RAG_MIGRATION_RECOVERY_ACK,
    RAG_MIGRATION_EXPECTED_TARGET_FINGERPRINT:
      process.env.RAG_MIGRATION_EXPECTED_TARGET_FINGERPRINT,
  };
}

function assertOfficialCliMutationGates(
  plan: OfficialMigrationPlan,
  args: OfficialCliArgs,
  recovery: boolean
): void {
  const env = officialMutationEnv();
  assertOfficialMutationGates(env, {
    execute: args.execute,
    expectedTargetFingerprint: plan.targetFingerprint,
  });
  if (recovery && env.RAG_MIGRATION_RECOVERY_ACK !== OFFICIAL_RECOVERY_ACK) {
    throw new MigrationRunnerError(
      'MIGRATION_OFFICIAL_ACK_REQUIRED',
      `RAG_MIGRATION_RECOVERY_ACK=${OFFICIAL_RECOVERY_ACK} is required`
    );
  }
}

async function assertSafeOutputPath(path: string, name: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new MigrationRunnerError(
        'MIGRATION_ARTIFACT_INVALID',
        `${name} must be a regular file or a new path`
      );
    }
  } catch (error) {
    if (error instanceof MigrationRunnerError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new MigrationRunnerError(
      'MIGRATION_ARTIFACT_INVALID',
      `cannot inspect ${name}: ${describeError(error).message}`
    );
  }
}

function assertOfficialLanes(value: readonly MigrationLane[]): readonly MigrationLane[] {
  if (
    value.length === 0 ||
    value.length > 2 ||
    value.some((lane) => !isMigrationLane(lane)) ||
    new Set(value).size !== value.length
  ) {
    throw new MigrationRunnerError(
      'MIGRATION_LANE_UNKNOWN',
      'official plan lanes must contain one or two distinct known lanes'
    );
  }
  return value;
}

async function prepareBackupReceipt(
  plan: OfficialMigrationPlan,
  backupPath: string,
  receiptPath?: string,
  now = new Date()
): Promise<BackupReceipt> {
  const receipt = receiptPath
    ? await loadOfficialArtifactOrFail<BackupReceipt>(receiptPath, 'backup receipt', now)
    : await createBackupReceipt({
        plan,
        backupPath,
        postgresVersion: 'unknown',
        now,
      });
  validateBackupReceipt(receipt, plan, now);

  // Validate the on-disk dump before creating or connecting to a restore DB.
  const observed = await createBackupReceipt({
    plan,
    backupPath,
    postgresVersion:
      typeof receipt.postgresVersion === 'string' && receipt.postgresVersion.trim()
        ? receipt.postgresVersion
        : 'unknown',
    now,
  });
  if (
    observed.backupSha256 !== receipt.backupSha256 ||
    observed.backupSizeBytes !== receipt.backupSizeBytes
  ) {
    throw new MigrationRunnerError(
      'MIGRATION_RECEIPT_MISMATCH',
      'backup checksum or size does not match the supplied backup receipt'
    );
  }
  return receipt;
}

async function loadOfficialArtifactOrFail<T>(
  path: string,
  kind: string,
  now = new Date()
): Promise<T> {
  return (await readOfficialArtifact<Record<string, unknown>>(path, kind, now)) as T;
}

async function openLaneSql(targetUrl: string): Promise<{
  db: ReturnType<typeof adaptReservedSql>;
  sql: Bun.SQL;
}> {
  const sql = new Bun.SQL({
    url: targetUrl,
    max: 1,
    idleTimeout: 0,
    connectionTimeout: 10,
    prepare: false,
  });
  return { db: adaptReservedSql(await sql.reserve()), sql };
}

function planTargetIdentity(plan: OfficialMigrationPlan): MigrationTargetIdentity {
  const lane = plan.lanes[0];
  if (!lane) {
    throw new MigrationRunnerError(
      'MIGRATION_LANE_UNKNOWN',
      'official plan is missing lane identities'
    );
  }
  const resolved = resolveLaneDatabaseUrl({ lane, env: process.env, mutating: false });
  assertOfficialTarget(resolved.url, resolved.targetIdentity);
  for (const plannedLane of plan.lanes) {
    const planned = plan.targetIdentities[plannedLane];
    if (
      !planned ||
      planned.host !== resolved.targetIdentity.host ||
      planned.port !== resolved.targetIdentity.port ||
      planned.database !== resolved.targetIdentity.database
    ) {
      throw new MigrationRunnerError(
        'MIGRATION_RECEIPT_MISMATCH',
        `official target identity differs for ${plannedLane}`
      );
    }
  }
  return resolved.targetIdentity;
}

async function loadOfficialPlanArtifacts(planPath: string): Promise<{
  plan: OfficialMigrationPlan;
  manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>>;
}> {
  const plan = (await readOfficialArtifact<Record<string, unknown>>(
    planPath,
    'official plan',
    new Date()
  )) as unknown as OfficialMigrationPlan;
  validateOfficialPlan(plan);
  const manifests = {} as Record<MigrationLane, readonly LoadedMigration[]>;
  for (const lane of plan.lanes) {
    manifests[lane] = await loadManifest(REPO_ROOT, lane);
  }
  return { plan, manifests };
}

async function runOfficialBackup(args: OfficialCliArgs): Promise<void> {
  const out = assertOfficialArg(args.out, 'official backup requires --out <receipt.json>');
  const planPath = assertOfficialArg(args.plan, '--plan');
  const backupPath = assertOfficialArg(args.backup, '--backup');
  await assertSafeOutputPath(out, '--out');
  await assertSafeOutputPath(backupPath, '--backup');
  assertOfficialRouteMode({ RAG_MIGRATION_TARGET: process.env.RAG_MIGRATION_TARGET });
  const { plan } = await loadOfficialPlanArtifacts(planPath);
  const target = planTargetIdentity(plan);
  const targetResolved = resolveLaneDatabaseUrl({
    lane: plan.lanes[0],
    env: process.env,
    mutating: false,
  });
  if (
    targetResolved.targetIdentity.host !== target.host ||
    targetResolved.targetIdentity.port !== target.port ||
    targetResolved.targetIdentity.database !== target.database
  ) {
    fail({
      code: 'MIGRATION_ARTIFACT_INVALID',
      message: 'backup target identity does not match the official plan',
    });
    return;
  }
  const { db, sql } = await openLaneSql(targetResolved.url);
  try {
    const backup = await runOfficialBackupPrimitive({
      plan,
      backupPath,
      targetIdentity: target,
      db,
      rawUrl: targetResolved.url,
    });
    await writeOfficialArtifact(out, backup as unknown as Record<string, unknown>);
    emit({ ok: true, command: 'official backup', backup });
  } finally {
    await db.release().catch(() => {});
    await sql.close({ timeout: 5 }).catch(() => {});
  }
}

async function runOfficialVerifyBackup(args: OfficialCliArgs): Promise<void> {
  const planPath = assertOfficialArg(args.plan, '--plan');
  const backupPath = assertOfficialArg(args.backup, '--backup');
  const restoreReceiptPath = assertOfficialArg(args.restoreReceipt, '--restore-receipt');
  const restoreTarget = assertOfficialArg(
    args.restoreTarget ?? process.env.RAG_MIGRATION_RESTORE_DATABASE_URL,
    '--restore-target or RAG_MIGRATION_RESTORE_DATABASE_URL'
  );
  await assertSafeOutputPath(restoreReceiptPath, '--restore-receipt');
  assertOfficialRouteMode({ RAG_MIGRATION_TARGET: process.env.RAG_MIGRATION_TARGET });
  const { plan, manifests } = await loadOfficialPlanArtifacts(planPath);
  const backupReceipt = await prepareBackupReceipt(
    plan,
    backupPath,
    args.backupReceipt,
    new Date()
  );
  const restoreIdentity = canonicalizeMigrationTarget(restoreTarget);
  assertDisposableMigrationTarget(restoreTarget, restoreIdentity);
  let restoreDb: ReturnType<typeof adaptReservedSql> | undefined;
  let restoreSql: Bun.SQL | undefined;
  let created = false;
  try {
    await createDisposableDatabase({ rawUrl: restoreTarget, targetIdentity: restoreIdentity });
    created = true;
    const opened = await openLaneSql(restoreTarget);
    restoreSql = opened.sql;
    restoreDb = opened.db;
    await runPgRestore({ rawUrl: restoreTarget, targetIdentity: restoreIdentity, backupPath });
    const verify = await runOfficialVerifyBackupPrimitive({
      plan,
      backupReceipt,
      backupPath,
      restoreTarget,
      db: restoreDb,
      manifests,
    });
    await writeOfficialArtifact(restoreReceiptPath, verify as unknown as Record<string, unknown>);
    emit({ ok: true, command: 'official verify-backup', verify });
  } finally {
    if (restoreDb) await restoreDb.release().catch(() => {});
    if (restoreSql) await restoreSql.close({ timeout: 5 }).catch(() => {});
    if (created) {
      await dropDisposableDatabase({
        rawUrl: restoreTarget,
        targetIdentity: restoreIdentity,
      }).catch(() => {});
    }
  }
}

async function runOfficialDrain(args: OfficialCliArgs): Promise<void> {
  const planPath = assertOfficialArg(args.plan, '--plan');
  const out = assertOfficialArg(args.out, 'official drain requires --out <drain.json>');
  await assertSafeOutputPath(out, '--out');
  assertOfficialRouteMode({ RAG_MIGRATION_TARGET: process.env.RAG_MIGRATION_TARGET });
  const { plan } = await loadOfficialPlanArtifacts(planPath);
  const target = planTargetIdentity(plan);
  const resolved = resolveLaneDatabaseUrl({
    lane: plan.lanes[0],
    env: process.env,
    mutating: false,
  });
  const opened = await openLaneSql(resolved.url);
  try {
    const drain = await runOfficialDrainPrimitive({
      plan,
      db: opened.db,
      targetIdentity: target,
      settlingMs: args.settlingMs,
    });
    await writeOfficialArtifact(out, drain as unknown as Record<string, unknown>);
    emit({ ok: true, command: 'official drain', drain });
  } finally {
    await opened.db.release().catch(() => {});
    await opened.sql.close({ timeout: 5 }).catch(() => {});
  }
}

async function runOfficialMutation(args: OfficialCliArgs, recovery: boolean): Promise<void> {
  const now = new Date();
  const planPath = assertOfficialArg(args.plan, '--plan');
  const backupPath = assertOfficialArg(args.backup, '--backup');
  const backupReceiptPath = assertOfficialArg(args.backupReceipt, '--backup-receipt');
  const restoreReceiptPath = assertOfficialArg(args.restoreReceipt, '--restore-receipt');
  const drainReceiptPath = assertOfficialArg(args.drainReceipt, '--drain-receipt');
  const auditPath = assertOfficialArg(args.auditPath, '--audit-path');
  const restoreTarget = assertOfficialArg(
    args.restoreTarget ?? process.env.RAG_MIGRATION_RESTORE_DATABASE_URL,
    '--restore-target or RAG_MIGRATION_RESTORE_DATABASE_URL'
  );
  if (recovery) assertOfficialArg(args.priorOperationId, '--prior-operation-id');
  await assertSafeOutputPath(backupPath, '--backup');
  await assertSafeOutputPath(backupReceiptPath, '--backup-receipt');
  await assertSafeOutputPath(restoreReceiptPath, '--restore-receipt');
  await assertSafeOutputPath(drainReceiptPath, '--drain-receipt');
  await assertSafeOutputPath(auditPath, '--audit-path');
  assertOfficialRouteMode({ RAG_MIGRATION_TARGET: process.env.RAG_MIGRATION_TARGET });

  const { plan, manifests } = await loadOfficialPlanArtifacts(planPath);
  assertOfficialCliMutationGates(plan, args, recovery);
  const backupReceipt = await prepareBackupReceipt(plan, backupPath, backupReceiptPath, now);
  const suppliedRestoreReceipt = await loadOfficialArtifactOrFail<RestoreVerificationReceipt>(
    restoreReceiptPath,
    'restore verification receipt',
    now
  );
  validateRestoreVerificationReceipt(suppliedRestoreReceipt, plan, backupReceipt, now);
  const drainReceipt = await loadOfficialArtifactOrFail<WriteDrainReceipt>(
    drainReceiptPath,
    'write drain receipt',
    now
  );
  const target = planTargetIdentity(plan);

  // Re-run the disposable restore verification in this process so the apply
  // path receives the live verifier's process-local proof, never a caller-
  // fabricated receipt loaded from disk.
  const restoreIdentity = canonicalizeMigrationTarget(restoreTarget);
  assertDisposableMigrationTarget(restoreTarget, restoreIdentity);
  let restoreDb: ReturnType<typeof adaptReservedSql> | undefined;
  let restoreSql: Bun.SQL | undefined;
  let created = false;
  try {
    await createDisposableDatabase({ rawUrl: restoreTarget, targetIdentity: restoreIdentity });
    created = true;
    const openedRestore = await openLaneSql(restoreTarget);
    restoreDb = openedRestore.db;
    restoreSql = openedRestore.sql;
    await runPgRestore({ rawUrl: restoreTarget, targetIdentity: restoreIdentity, backupPath });
    const liveRestoreReceipt = await runOfficialVerifyBackupPrimitive({
      plan,
      backupReceipt,
      backupPath,
      restoreTarget,
      db: restoreDb,
      manifests,
      now,
    });
    await writeOfficialArtifact(
      restoreReceiptPath,
      liveRestoreReceipt as unknown as Record<string, unknown>
    );
    const resolved = resolveLaneDatabaseUrl({
      lane: plan.lanes[0],
      env: process.env,
      mutating: false,
    });
    const officialOpened = await openLaneSql(resolved.url);
    try {
      const common = {
        plan,
        backupReceipt,
        restoreReceipt: liveRestoreReceipt,
        drainReceipt,
        env: officialMutationEnv(),
        execute: args.execute,
        db: officialOpened.db,
        targetIdentity: target,
        manifests,
        actor: args.actor,
        candidateSha: args.candidateSha,
        auditPath,
        now,
      } as const;
      const result = recovery
        ? await runOfficialRecovery({
            ...common,
            priorOperationId: assertOfficialArg(args.priorOperationId, '--prior-operation-id'),
          })
        : await runOfficialApply(common);
      emit({ ok: true, command: recovery ? 'official recover' : 'official apply', result });
    } finally {
      await officialOpened.db.release().catch(() => {});
      await officialOpened.sql.close({ timeout: 5 }).catch(() => {});
    }
  } finally {
    if (restoreDb) await restoreDb.release().catch(() => {});
    if (restoreSql) await restoreSql.close({ timeout: 5 }).catch(() => {});
    if (created) {
      await dropDisposableDatabase({
        rawUrl: restoreTarget,
        targetIdentity: restoreIdentity,
      }).catch(() => {});
    }
  }
}

async function runOfficialPlan(args: OfficialCliArgs): Promise<void> {
  assertOfficialRouteMode({ RAG_MIGRATION_TARGET: process.env.RAG_MIGRATION_TARGET });
  const lanes = assertOfficialLanes(args.lanes ?? ['project', 'docs']);
  const expectedTarget = assertOfficialArg(
    args.expectedTarget,
    'official plan requires --expect-target <sha256>'
  );
  const out = assertOfficialArg(args.out, 'official plan requires --out <plan.json>');
  assertExpectedTargetFingerprint(expectedTarget, expectedTarget);
  await assertSafeOutputPath(out, '--out');
  const manifests = {} as Record<MigrationLane, readonly LoadedMigration[]>;
  const dbByLane = {} as Record<MigrationLane, ReturnType<typeof adaptReservedSql>>;
  const identities = {} as Record<
    MigrationLane,
    ReturnType<typeof resolveLaneDatabaseUrl>['targetIdentity']
  >;
  const pools: Array<{ db: ReturnType<typeof adaptReservedSql>; sql: Bun.SQL }> = [];
  try {
    for (const lane of lanes) {
      manifests[lane] = await loadManifest(REPO_ROOT, lane);
      const resolved = resolveLaneDatabaseUrl({ lane, env: process.env, mutating: false });
      assertOfficialTarget(resolved.url, resolved.targetIdentity);
      identities[lane] = resolved.targetIdentity;
      const sql = new Bun.SQL({
        url: resolved.url,
        max: 1,
        idleTimeout: 30,
        connectionTimeout: 10,
        prepare: false,
      });
      const db = adaptReservedSql(await sql.reserve());
      pools.push({ db, sql });
      dbByLane[lane] = db;
    }
    const plan = await createOfficialPlan({
      lanes,
      dbByLane,
      manifests,
      targetIdentities: identities,
      expectedTargetFingerprint: expectedTarget,
      repoRoot: REPO_ROOT,
    });
    await writeOfficialArtifact(out, plan as unknown as Record<string, unknown>);
    emit({ ok: true, command: 'official plan', plan });
  } finally {
    for (const pool of pools) {
      await pool.db.release().catch(() => {});
      await pool.sql.close({ timeout: 5 }).catch(() => {});
    }
  }
}

async function mainOfficial(argv: readonly string[]): Promise<void> {
  const args = parseOfficialArgs(argv);
  if (args.command === 'rollback') {
    throw new MigrationRunnerError(
      'MIGRATION_ARTIFACT_INVALID',
      `official ${args.command} is gated pending security fence fixes`
    );
  }
  switch (args.command) {
    case 'plan':
      await runOfficialPlan(args);
      return;
    case 'backup':
      await runOfficialBackup(args);
      return;
    case 'verify-backup':
      await runOfficialVerifyBackup(args);
      return;
    case 'drain':
      await runOfficialDrain(args);
      return;
    case 'apply':
      await runOfficialMutation(args, false);
      return;
    case 'recover':
      await runOfficialMutation(args, true);
      return;
    default:
      fail({
        code: 'MIGRATION_ACK_REQUIRED',
        message: `unsupported official command ${args.command}`,
      });
  }
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === 'official') {
    try {
      await mainOfficial(rawArgv.slice(1));
    } catch (error) {
      if (error instanceof MigrationRunnerError) {
        fail({ code: error.code, message: error.message, details: error.details });
      } else {
        const described = describeError(error);
        fail({ code: 'MIGRATION_ARTIFACT_INVALID', message: described.message });
      }
    }
    return;
  }
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof MigrationRunnerError) {
      fail({ code: error.code, message: error.message, details: error.details });
    } else {
      const described = describeError(error);
      fail({
        code: 'MIGRATION_ACK_REQUIRED',
        message: described.message,
        details: { pgCode: described.pgCode },
      });
    }
    return;
  }

  try {
    if (!args.lane || !['project', 'docs'].includes(args.lane)) {
      throw new MigrationRunnerError(
        'MIGRATION_LANE_UNKNOWN',
        '--lane must be "project" or "docs"'
      );
    }
    const lane = args.lane;

    let manifest: readonly LoadedMigration[];
    try {
      manifest = await loadManifest(REPO_ROOT, lane);
    } catch (error) {
      if (error instanceof MigrationRunnerError) {
        fail({ code: error.code, message: error.message, details: error.details });
        return;
      }
      throw error;
    }

    const mutating = args.command !== 'status' && !args.dryRun;
    if (mutating) {
      assertMutationGates(
        {
          RAG_MIGRATION_TARGET: process.env.RAG_MIGRATION_TARGET,
          RAG_MIGRATION_WRITE_ACK: process.env.RAG_MIGRATION_WRITE_ACK,
        },
        { execute: args.execute }
      );
    }
    if (args.command === 'adopt' && !args.challenge?.trim()) {
      throw new MigrationRunnerError(
        'MIGRATION_ACK_REQUIRED',
        'adopt requires --challenge <proofDigest>; read the digest from a prior read-only status report'
      );
    }

    const { url, targetIdentity } = resolveLaneDatabaseUrl({ lane, env: process.env, mutating });

    // Short-lived pool pinned to exactly one reserved connection so the
    // session-level advisory lock stays attached for the whole command.
    const sql = new Bun.SQL({
      url,
      max: 1,
      idleTimeout: 0,
      connectionTimeout: 10,
      prepare: false,
    });
    const db = adaptReservedSql(await sql.reserve());

    try {
      if (args.command === 'status') {
        emit(
          await runStatus({
            db,
            lane,
            manifest,
            redactedUrl: targetIdentity.redactedUrl,
            targetFingerprint: targetIdentity.fingerprint,
          })
        );
        return;
      }
      if (args.command === 'apply') {
        emit(
          await runApply({
            db,
            lane,
            manifest,
            redactedUrl: targetIdentity.redactedUrl,
            targetFingerprint: targetIdentity.fingerprint,
            dryRun: args.dryRun,
          })
        );
        return;
      }
      emit(
        await runAdopt({
          db,
          lane,
          manifest,
          redactedUrl: targetIdentity.redactedUrl,
          targetFingerprint: targetIdentity.fingerprint,
          challengeDigest: args.challenge ?? '',
          dryRun: args.dryRun,
        })
      );
    } finally {
      await db.release().catch(() => {});
      await sql.close({ timeout: 5 }).catch(() => {});
    }
  } catch (error) {
    if (error instanceof MigrationRunnerError) {
      fail({ code: error.code, message: error.message, details: error.details });
      return;
    }
    const described = describeError(error);
    fail({
      code: 'MIGRATION_APPLY_FAILED',
      message: described.message,
      details: { pgCode: described.pgCode },
    });
  }
}

main();
