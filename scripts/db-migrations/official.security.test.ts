import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalDigest,
  createBackupReceipt,
  createOfficialPlan,
  createRestoreVerificationReceipt,
  createWriteDrainReceipt,
  fingerprintV2For,
  OFFICIAL_ACK,
  OFFICIAL_RECOVERY_ACK,
  type OfficialMigrationPlan,
  runOfficialApply,
  runOfficialRecovery,
  sealArtifact,
  verifyRestoredDatabase,
} from './official.js';
import {
  canonicalizeMigrationTarget,
  type LoadedMigration,
  type MigrationLane,
  proofDigestFor,
  type Row,
  type SqlExecutor,
  sha256Text,
} from './runner.js';

const now = new Date('2026-08-31T12:00:00.000Z');
const officialIdentity = canonicalizeMigrationTarget('postgres://127.0.0.1:5542/project_rag');
const officialFingerprint = fingerprintV2For({
  host: officialIdentity.host,
  port: officialIdentity.port,
  database: officialIdentity.database,
  systemIdentifier: 'official-system',
  databaseOid: 'official-oid',
});

function manifest(lane: MigrationLane, count = 1): LoadedMigration[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    return {
      descriptor: {
        lane,
        ordinal,
        name: `${String(ordinal).padStart(3, '0')}-security`,
        relativePath: `${lane}/${String(ordinal).padStart(3, '0')}.sql`,
      },
      checksumSha256: sha256Text(`${lane}-${ordinal}`),
      sqlText: `select ${ordinal}`,
    };
  });
}

function firstManifestItem(items: readonly LoadedMigration[]): LoadedMigration {
  const item = items[0];
  if (!item) throw new Error('fixture manifest is empty');
  return item;
}

class PlanDb implements SqlExecutor {
  constructor(
    private readonly options: {
      readonly ledgerRows?: readonly Row[];
      readonly footprintPresent?: boolean;
      readonly probeRows?: readonly Row[];
    } = {}
  ) {}

  async unsafe(text: string): Promise<Row[]> {
    if (text.includes('pg_control_system')) {
      return [
        {
          system_identifier: 'official-system',
          database_oid: 'official-oid',
          database: 'project_rag',
        },
      ];
    }
    if (text.includes('from public.rag_schema_migrations')) {
      if (this.options.ledgerRows !== undefined) return [...this.options.ledgerRows];
      throw Object.assign(new Error('missing ledger'), { code: '42P01' });
    }
    if (text.trimStart().startsWith('select (')) return [...(this.options.probeRows ?? [{}])];
    if (text.includes('to_regclass')) {
      return [{ present: this.options.footprintPresent === true }];
    }
    throw new Error(`unexpected plan query: ${text}`);
  }
}

class RestoreDb implements SqlExecutor {
  readonly calls: string[] = [];

  constructor(
    private readonly options: {
      readonly ledgerRows?: readonly Row[];
      readonly footprintPresent?: boolean;
      readonly probeRows?: readonly Row[];
    } = {}
  ) {}

  async unsafe(text: string): Promise<Row[]> {
    this.calls.push(text);
    if (text.includes('pg_control_system')) {
      return [
        {
          system_identifier: 'wrong-system',
          database_oid: 'wrong-oid',
          database: 'another_database',
        },
      ];
    }
    if (text.includes('from public.rag_schema_migrations')) {
      if (this.options.ledgerRows !== undefined) return [...this.options.ledgerRows];
      throw Object.assign(new Error('missing ledger'), { code: '42P01' });
    }
    if (text.includes('to_regclass($1::text) is not null as present')) {
      return [{ present: this.options.footprintPresent === true }];
    }
    if (text.includes('to_regclass($1::text) as relation')) {
      return [{ relation: 'project_repositories' }];
    }
    if (text.trimStart().startsWith('select (')) return [...(this.options.probeRows ?? [{}])];
    if (text.includes('select count(*)::text as row_count')) return [{ row_count: '0' }];
    if (text.trim().startsWith('select 1 as ready')) return [{ ready: 1 }];
    throw new Error(`unexpected restore query: ${text}`);
  }
}

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function planFixture(
  operationId = 'official-security-1',
  options: ConstructorParameters<typeof PlanDb>[0] = {},
  projectManifest: readonly LoadedMigration[] = manifest('project')
): Promise<OfficialMigrationPlan> {
  const db = new PlanDb(options);
  return createOfficialPlan({
    lanes: ['project'],
    dbByLane: { project: db, docs: db },
    manifests: { project: projectManifest, docs: manifest('docs') },
    targetIdentities: { project: officialIdentity, docs: officialIdentity },
    expectedTargetFingerprint: officialFingerprint,
    repoSha: 'a'.repeat(40),
    operationId,
    now,
    ttlMs: 60_000,
  });
}

function planWithClusterBoundChallenge(plan: OfficialMigrationPlan): OfficialMigrationPlan {
  const laneState = plan.laneStates.project;
  const challenge = laneState.challenge;
  if (!challenge) throw new Error('adoption plan fixture is missing its challenge');
  const clusterBoundChallenge = {
    ...challenge,
    targetFingerprint: sha256Text('plan-challenge-cluster'),
    proofDigest: sha256Text('plan-challenge-proof'),
  };
  const statusDigest = canonicalDigest({
    lane: 'project',
    state: laneState.state,
    applied: [],
    pending: [],
    challenge: clusterBoundChallenge,
    unsupportedAdoptionReason: null,
  });
  return sealArtifact({
    ...plan,
    laneStates: {
      ...plan.laneStates,
      project: {
        ...laneState,
        challenge: clusterBoundChallenge,
        statusDigest,
        probeDigest: canonicalDigest(clusterBoundChallenge),
      },
    },
    laneStateDigest: canonicalDigest({ project: statusDigest }),
  }) as unknown as OfficialMigrationPlan;
}

interface ApplyDbState {
  markerTable: boolean;
  markerOperation?: string;
}

class ApplyDb implements SqlExecutor {
  readonly calls: string[] = [];
  private ledgerPresent = false;
  private footprintPresent = false;
  private readonly ledgerRows: Row[] = [];
  readonly state: ApplyDbState;

  constructor(
    private readonly options: {
      readonly lockAvailable?: boolean;
      readonly failMigration?: boolean;
      readonly onUnlock?: () => Promise<void>;
      readonly systemIdentifier?: string;
      readonly databaseOid?: string;
      readonly initialLedgerRows?: readonly Row[];
      readonly initialFootprintPresent?: boolean;
    } = {},
    state: ApplyDbState = { markerTable: false }
  ) {
    this.state = state;
    this.ledgerPresent = this.options.initialLedgerRows !== undefined;
    this.footprintPresent = this.options.initialFootprintPresent === true;
    this.ledgerRows.push(...(this.options.initialLedgerRows ?? []));
  }

  async unsafe(text: string, values?: readonly unknown[]): Promise<Row[]> {
    this.calls.push(text);
    if (text.includes('pg_control_system')) {
      return [
        {
          system_identifier: this.options.systemIdentifier ?? 'official-system',
          database_oid: this.options.databaseOid ?? 'official-oid',
          database: 'project_rag',
        },
      ];
    }
    if (text.includes('pg_try_advisory_lock')) {
      return [{ locked: this.options.lockAvailable !== false }];
    }
    if (text.includes('pg_advisory_unlock')) {
      await this.options.onUnlock?.();
      return [{ unlocked: true }];
    }
    if (
      text.trimStart().startsWith('create table if not exists public.rag_migration_maintenance')
    ) {
      this.state.markerTable = true;
      return [];
    }
    if (text.trimStart().startsWith('insert into public.rag_migration_maintenance')) {
      if (!this.state.markerOperation) this.state.markerOperation = String(values?.[0] ?? '');
      return [];
    }
    if (text.includes('to_regclass') && text.includes('as relation')) {
      return [{ relation: this.state.markerTable ? 'public.rag_migration_maintenance' : null }];
    }
    if (text.trimStart().startsWith('select operation_id from public.rag_migration_maintenance')) {
      return this.state.markerOperation ? [{ operation_id: this.state.markerOperation }] : [];
    }
    if (text.trimStart().startsWith('update public.rag_migration_maintenance')) {
      if (this.state.markerOperation === String(values?.[1] ?? '')) {
        this.state.markerOperation = String(values?.[0] ?? '');
        return [{ operation_id: this.state.markerOperation }];
      }
      return [];
    }
    if (text.trimStart().startsWith('delete from public.rag_migration_maintenance')) {
      if (this.state.markerOperation === String(values?.[0] ?? '')) {
        this.state.markerOperation = undefined;
        return [{ id: 1 }];
      }
      return [];
    }
    if (text.includes('current_setting') && text.includes('pg_stat_activity')) {
      return [
        {
          connection_limit: 10,
          active_sessions: 0,
          active_transactions: 0,
          bypass_role_detected: false,
        },
      ];
    }
    if (text.includes('information_schema.role_table_grants')) return [{ grants_material: '' }];
    if (text.includes('from public.rag_schema_migrations')) {
      if (!this.ledgerPresent) throw Object.assign(new Error('missing ledger'), { code: '42P01' });
      return this.ledgerRows;
    }
    if (text.trimStart().startsWith('create table if not exists public.rag_schema_migrations')) {
      this.ledgerPresent = true;
      return [];
    }
    if (text.includes('to_regclass($1::text) is not null as present')) {
      return [{ present: this.footprintPresent }];
    }
    if (text.trimStart().startsWith('insert into public.rag_schema_migrations')) {
      const [lane, ordinal, name, checksumSha256, recordKind, proofDigest] = values ?? [];
      this.ledgerRows.push({
        lane,
        ordinal,
        name,
        checksum_sha256: checksumSha256,
        record_kind: recordKind,
        proof_digest: proofDigest,
      });
      return [];
    }
    if (/^select [12]$/.test(text.trim())) {
      if (this.options.failMigration) throw new Error('migration execution failed');
      this.footprintPresent = true;
      return [{ '?column?': 1 }];
    }
    throw new Error(`unexpected apply query: ${text}`);
  }
}

class MatchingRestoreDb extends RestoreDb {
  override async unsafe(text: string): Promise<Row[]> {
    if (text.includes('pg_control_system')) {
      return [
        {
          system_identifier: 'restore-system',
          database_oid: 'restore-oid',
          database: 'rag_v2_migration_restore',
        },
      ];
    }
    return super.unsafe(text);
  }
}

async function applyFixture(
  plan: OfficialMigrationPlan | undefined = undefined,
  manifests: Readonly<Record<MigrationLane, readonly LoadedMigration[]>> = {
    project: manifest('project'),
    docs: manifest('docs'),
  },
  restoreOptions: ConstructorParameters<typeof MatchingRestoreDb>[0] = {}
) {
  const selectedPlan = plan ?? (await planFixture());
  const dir = await mkdtemp(join(process.cwd(), '.tmp', 'official-security-'));
  scratch.push(dir);
  const backupPath = join(dir, 'backup.dump');
  await writeFile(backupPath, Buffer.from('PGDMP official security fixture'));
  const backup = await createBackupReceipt({
    plan: selectedPlan,
    backupPath,
    postgresVersion: '16',
    now,
  });
  const restoreReceipt = await verifyRestoredDatabase({
    plan: selectedPlan,
    backupReceipt: backup,
    backupPath,
    restoreTarget: 'postgres://127.0.0.1:6543/rag_v2_migration_restore',
    db: new MatchingRestoreDb(restoreOptions),
    manifests,
    now,
  });
  const drainReceipt = createWriteDrainReceipt({
    plan: selectedPlan,
    observation: {
      activeSessions: 0,
      activeTransactions: 0,
      connectionLimit: 10,
      baselineConnectionLimit: 10,
      bypassRoleDetected: false,
      settlingMs: 1,
      drained: true,
      grantsDigest: sha256Text(''),
    },
    now,
  });
  return {
    plan: selectedPlan,
    dir,
    backupPath,
    backup,
    restoreReceipt,
    drainReceipt,
    manifests,
    env: {
      RAG_MIGRATION_TARGET: 'official',
      RAG_MIGRATION_OFFICIAL_ACK: OFFICIAL_ACK,
      RAG_MIGRATION_WRITE_ACK: '1',
      RAG_MIGRATION_MAINTENANCE_ACK: '1',
      RAG_MIGRATION_EXPECTED_TARGET_FINGERPRINT: officialFingerprint,
    },
  } as const;
}

function executedLedgerRow(item: LoadedMigration): Row {
  return {
    ordinal: item.descriptor.ordinal,
    name: item.descriptor.name,
    checksum_sha256: item.checksumSha256,
    record_kind: 'executed',
    proof_digest: proofDigestFor({
      kind: 'executed',
      lane: item.descriptor.lane,
      ordinal: item.descriptor.ordinal,
      name: item.descriptor.name,
      checksum: item.checksumSha256,
    }),
  };
}

async function partialApplyFixture() {
  const projectManifest = manifest('project', 2);
  const initialLedgerRows = [executedLedgerRow(firstManifestItem(projectManifest))];
  const plan = await createOfficialPlan({
    lanes: ['project'],
    dbByLane: {
      project: new PlanDb({ ledgerRows: initialLedgerRows, footprintPresent: true }),
      docs: new PlanDb(),
    },
    manifests: { project: projectManifest, docs: manifest('docs') },
    targetIdentities: { project: officialIdentity, docs: officialIdentity },
    expectedTargetFingerprint: officialFingerprint,
    repoSha: 'a'.repeat(40),
    operationId: 'official-recovery-partial',
    now,
    ttlMs: 60_000,
  });
  const fixture = await applyFixture(
    plan,
    { project: projectManifest, docs: manifest('docs') },
    {
      ledgerRows: initialLedgerRows,
      footprintPresent: true,
      probeRows: [{ a0: true, a1: true, a2: true, a3: true, a4: true, a5: true }],
    }
  );
  return { fixture, initialLedgerRows };
}

async function runApplyFixture(
  fixture: Awaited<ReturnType<typeof applyFixture>>,
  extra: Partial<Parameters<typeof runOfficialApply>[0]> & {
    /** Deliberately untyped legacy-looking properties for bypass regression tests. */
    readonly appendAudit?: unknown;
    readonly maintenanceFence?: unknown;
  } = {}
) {
  return runOfficialApply({
    plan: fixture.plan,
    backupReceipt: fixture.backup,
    restoreReceipt: fixture.restoreReceipt,
    drainReceipt: fixture.drainReceipt,
    env: fixture.env,
    execute: true,
    db: new ApplyDb(),
    targetIdentity: officialIdentity,
    manifests: fixture.manifests,
    auditPath: join(fixture.dir, 'audit.jsonl'),
    now,
    ...extra,
  } as Parameters<typeof runOfficialApply>[0]);
}

async function runRecoveryFixture(
  fixture: Awaited<ReturnType<typeof applyFixture>>,
  priorOperationId: string,
  db: ApplyDb,
  extra: Partial<Parameters<typeof runOfficialRecovery>[0]> = {}
) {
  return runOfficialRecovery({
    plan: fixture.plan,
    backupReceipt: fixture.backup,
    restoreReceipt: fixture.restoreReceipt,
    drainReceipt: fixture.drainReceipt,
    env: { ...fixture.env, RAG_MIGRATION_RECOVERY_ACK: OFFICIAL_RECOVERY_ACK },
    execute: true,
    db,
    targetIdentity: officialIdentity,
    manifests: fixture.manifests,
    auditPath: join(fixture.dir, 'audit.jsonl'),
    now,
    priorOperationId,
    ...extra,
  } as Parameters<typeof runOfficialRecovery>[0]);
}

describe('official coordinator security boundaries', () => {
  it('accepts adoption state on a distinct restore cluster', async () => {
    const plan = await planFixture('official-security-adoption', {
      footprintPresent: true,
      probeRows: [{ a0: true, a1: true, a2: true, a3: true, a4: true, a5: true }],
    });
    const dir = await mkdtemp(join(process.cwd(), '.tmp', 'official-security-'));
    scratch.push(dir);
    const backupPath = join(dir, 'backup.dump');
    await writeFile(backupPath, Buffer.from('PGDMP official security fixture'));
    const backup = await createBackupReceipt({
      plan,
      backupPath,
      postgresVersion: '16',
      now,
    });

    const receipt = await verifyRestoredDatabase({
      plan,
      backupReceipt: backup,
      backupPath,
      restoreTarget: 'postgres://127.0.0.1:6543/rag_v2_migration_restore',
      db: new MatchingRestoreDb({
        footprintPresent: true,
        probeRows: [{ a0: true, a1: true, a2: true, a3: true, a4: true, a5: true }],
      }),
      manifests: { project: manifest('project'), docs: manifest('docs') },
      now,
    });

    expect(receipt.restoreTargetFingerprint).toBeTruthy();
    expect(receipt.restoreTargetFingerprint).not.toBe(plan.targetFingerprint);
  });

  it('accepts a cluster-bound plan challenge when restored adoption structure matches', async () => {
    const projectManifest = manifest('project', 30);
    const plan = planWithClusterBoundChallenge(
      await planFixture(
        'official-security-cluster-bound',
        {
          footprintPresent: true,
          probeRows: [
            Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`a${index}`, true])),
          ],
        },
        projectManifest
      )
    );
    const fixture = await applyFixture(
      plan,
      { project: projectManifest, docs: manifest('docs') },
      {
        footprintPresent: true,
        probeRows: [
          Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`a${index}`, true])),
        ],
      }
    );

    expect(fixture.restoreReceipt.restoreTargetFingerprint).toBeTruthy();
    expect(fixture.restoreReceipt.restoreTargetFingerprint).not.toBe(
      plan.laneStates.project.challenge?.targetFingerprint
    );
  });

  it('rejects restored adoption when challenge structure diverges', async () => {
    const plan = await planFixture('official-security-structural-mismatch', {
      footprintPresent: true,
      probeRows: [{ a0: true, a1: true, a2: true, a3: true, a4: true, a5: true }],
    });
    const mismatchedProjectManifest = manifest('project');
    const first = mismatchedProjectManifest[0];
    if (!first) throw new Error('fixture manifest is empty');
    mismatchedProjectManifest[0] = {
      ...first,
      checksumSha256: sha256Text('restored-structural-mismatch'),
    };

    await expect(
      applyFixture(
        plan,
        { project: mismatchedProjectManifest, docs: manifest('docs') },
        {
          footprintPresent: true,
          probeRows: [{ a0: true, a1: true, a2: true, a3: true, a4: true, a5: true }],
        }
      )
    ).rejects.toMatchObject({ code: 'MIGRATION_RECEIPT_MISMATCH' });
  });

  it('rejects a restore connection whose fingerprint is not the disposable target', async () => {
    const plan = await planFixture();
    const dir = await mkdtemp(join(process.cwd(), '.tmp', 'official-security-'));
    scratch.push(dir);
    const backupPath = join(dir, 'backup.dump');
    await writeFile(backupPath, Buffer.from('PGDMP official security fixture'));
    const backup = await createBackupReceipt({
      plan,
      backupPath,
      postgresVersion: '16',
      now,
    });

    await expect(
      verifyRestoredDatabase({
        plan,
        backupReceipt: backup,
        backupPath,
        restoreTarget: 'postgres://127.0.0.1:6543/rag_v2_migration_restore',
        db: new RestoreDb(),
        manifests: { project: [], docs: [] },
        now,
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_FINGERPRINT_MISMATCH' });
  });

  it('uses the internal exclusive advisory lock as the maintenance fence', async () => {
    const fixture = await applyFixture();
    const db = new ApplyDb();

    await expect(runApplyFixture(fixture, { db })).resolves.toMatchObject({ ok: true });
    expect(db.calls.some((text) => text.includes('pg_try_advisory_lock'))).toBe(true);
  });

  it('stops before database writes when the exclusive writer fence is unavailable', async () => {
    const fixture = await applyFixture();
    const db = new ApplyDb({ lockAvailable: false });

    await expect(runApplyFixture(fixture, { db })).rejects.toMatchObject({
      code: 'MIGRATION_LOCK_BUSY',
    });
    expect(db.calls.filter((text) => text.includes('pg_try_advisory_lock'))).toHaveLength(1);
    expect(db.calls.some((text) => text.includes('create table if not exists'))).toBe(false);
  });

  it('rejects a normal apply against a foreign durable marker', async () => {
    const fixture = await applyFixture();
    const state: ApplyDbState = {
      markerTable: true,
      markerOperation: 'foreign-operation',
    };
    const db = new ApplyDb({}, state);

    await expect(runApplyFixture(fixture, { db })).rejects.toMatchObject({
      code: 'MIGRATION_LOCK_BUSY',
    });
    expect(state.markerOperation).toBe('foreign-operation');
    expect(db.calls.some((text) => text.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('requires the explicit recovery acknowledgement before database I/O', async () => {
    const fixture = await applyFixture();
    const db = new ApplyDb({}, { markerTable: true, markerOperation: 'stale-operation' });

    await expect(
      runRecoveryFixture(fixture, 'stale-operation', db, { env: fixture.env })
    ).rejects.toMatchObject({ code: 'MIGRATION_OFFICIAL_ACK_REQUIRED' });
    expect(db.calls).toHaveLength(0);
  });

  it('rejects a non-string prior id before database I/O', async () => {
    const fixture = await applyFixture();
    const db = new ApplyDb({}, { markerTable: true, markerOperation: 'stale-operation' });

    await expect(runRecoveryFixture(fixture, 42 as unknown as string, db)).rejects.toMatchObject({
      code: 'MIGRATION_ARTIFACT_INVALID',
    });
    expect(db.calls).toHaveLength(0);
  });

  it('rejects expired recovery artifacts before acquiring the fence', async () => {
    const fixture = await applyFixture();
    const db = new ApplyDb({}, { markerTable: true, markerOperation: 'stale-operation' });

    await expect(
      runRecoveryFixture(fixture, 'stale-operation', db, {
        now: new Date(now.getTime() + 60_001),
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_ARTIFACT_EXPIRED' });
    expect(db.calls).toHaveLength(0);
  });

  it('rejects a wrong prior id without changing the durable marker', async () => {
    const fixture = await applyFixture();
    const state: ApplyDbState = {
      markerTable: true,
      markerOperation: 'stale-operation',
    };
    const db = new ApplyDb({}, state);

    await expect(runRecoveryFixture(fixture, 'wrong-operation', db)).rejects.toMatchObject({
      code: 'MIGRATION_LOCK_BUSY',
    });
    expect(state.markerOperation).toBe('stale-operation');
  });

  it('checks the exact live target fingerprint before takeover', async () => {
    const fixture = await applyFixture();
    const state: ApplyDbState = {
      markerTable: true,
      markerOperation: 'stale-operation',
    };
    const db = new ApplyDb({ systemIdentifier: 'wrong-system' }, state);

    await expect(runRecoveryFixture(fixture, 'stale-operation', db)).rejects.toMatchObject({
      code: 'MIGRATION_FINGERPRINT_MISMATCH',
    });
    expect(state.markerOperation).toBe('stale-operation');
  });

  it('takes over a stale marker and resumes the remaining migration suffix', async () => {
    const { fixture } = await partialApplyFixture();
    const state: ApplyDbState = {
      markerTable: true,
      markerOperation: 'failed-partial',
    };
    const db = new ApplyDb(
      {
        initialLedgerRows: [executedLedgerRow(firstManifestItem(fixture.manifests.project))],
        initialFootprintPresent: true,
      },
      state
    );

    const result = await runRecoveryFixture(fixture, 'failed-partial', db);
    expect(result.executed.project).toEqual([
      { ordinal: 2, name: '002-security', recordKind: 'executed' },
    ]);
    expect(state.markerOperation).toBeUndefined();
    const audit = await readFile(join(fixture.dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"outcome":"takeover"');
    expect(audit).toContain('"priorOperationId":"failed-partial"');
    expect(audit).toContain('"outcome":"success","priorOperationId":"failed-partial"');
  });

  it('keeps the replacement marker after a repeated recovery failure', async () => {
    const { fixture } = await partialApplyFixture();
    const state: ApplyDbState = {
      markerTable: true,
      markerOperation: 'failed-partial',
    };
    const firstDb = new ApplyDb(
      {
        failMigration: true,
        initialLedgerRows: [executedLedgerRow(firstManifestItem(fixture.manifests.project))],
        initialFootprintPresent: true,
      },
      state
    );

    await expect(runRecoveryFixture(fixture, 'failed-partial', firstDb)).rejects.toMatchObject({
      code: 'MIGRATION_APPLY_FAILED',
    });
    expect(state.markerOperation).toBe(fixture.plan.operationId);
    expect(firstDb.calls.some((text) => text.includes('pg_advisory_unlock'))).toBe(false);

    const secondDb = new ApplyDb(
      {
        failMigration: true,
        initialLedgerRows: [executedLedgerRow(firstManifestItem(fixture.manifests.project))],
        initialFootprintPresent: true,
      },
      state
    );
    await expect(
      runRecoveryFixture(fixture, fixture.plan.operationId, secondDb)
    ).rejects.toMatchObject({ code: 'MIGRATION_APPLY_FAILED' });
    expect(state.markerOperation).toBe(fixture.plan.operationId);
    expect(secondDb.calls.some((text) => text.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('keeps the writer fence held after a failed official operation', async () => {
    const fixture = await applyFixture();
    const state: ApplyDbState = { markerTable: false };
    const db = new ApplyDb({ failMigration: true }, state);

    await expect(runApplyFixture(fixture, { db })).rejects.toMatchObject({
      code: 'MIGRATION_APPLY_FAILED',
    });
    expect(db.calls.some((text) => text.includes('pg_advisory_unlock'))).toBe(false);
    expect(state.markerOperation).toBe(fixture.plan.operationId);
    const audit = await readFile(join(fixture.dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"outcome":"failure"');
  });

  it('reuses the durable marker after a failed owner connection closes', async () => {
    const fixture = await applyFixture();
    const state: ApplyDbState = { markerTable: false };
    const failedDb = new ApplyDb({ failMigration: true }, state);

    await expect(runApplyFixture(fixture, { db: failedDb })).rejects.toMatchObject({
      code: 'MIGRATION_APPLY_FAILED',
    });
    // A fresh executor represents the recovery connection; the row remains
    // and may be reused only by the same operation identity. A successful
    // recovery clears it before releasing the exclusive lock.
    const recoveryDb = new ApplyDb({}, state);
    await expect(runApplyFixture(fixture, { db: recoveryDb })).resolves.toMatchObject({ ok: true });
    expect(state.markerOperation).toBeUndefined();
  });

  it('does not apply a receipt fabricated by the public receipt factory', async () => {
    const fixture = await applyFixture();
    const looseReceipt = await createRestoreVerificationReceipt({
      plan: fixture.plan,
      backupReceipt: fixture.backup,
      backupPath: fixture.backupPath,
      restoreTarget: 'postgres://127.0.0.1:6543/rag_v2_migration_restore',
      verification: {
        schemaProbes: { project: true, docs: true },
        lanePrefixes: { project: 0, docs: 0 },
        rowCountDigests: {},
        readSmoke: true,
      },
      now,
    });
    await expect(
      runApplyFixture(fixture, {
        restoreReceipt: looseReceipt,
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_RECEIPT_MISMATCH' });
  });

  it('does not allow caller hooks to replace the audit or writer fence', async () => {
    const fixture = await applyFixture();
    const db = new ApplyDb();
    const events: string[] = [];
    const result = await runApplyFixture(fixture, {
      db,
      maintenanceFence: {
        establish: async () => events.push('establish'),
        assertClosed: async () => events.push('assert-closed'),
        restore: async () => events.push('restore'),
      },
      appendAudit: async () => events.push('append-audit'),
    });
    const audit = await readFile(join(fixture.dir, 'audit.jsonl'), 'utf8');
    expect(result.ok).toBe(true);
    expect(events).toEqual([]);
    expect(db.calls.some((text) => text.includes('pg_try_advisory_lock'))).toBe(true);
    expect(audit).toContain('"outcome":"start"');
    expect(audit).toContain('"outcome":"success"');
  });

  it('releases the writer fence only after the durable success audit', async () => {
    const fixture = await applyFixture();
    const auditPath = join(fixture.dir, 'audit.jsonl');
    let auditAtUnlock = '';
    let markerAtUnlock: string | undefined;
    const db = new ApplyDb({
      onUnlock: async () => {
        auditAtUnlock = await readFile(auditPath, 'utf8');
        markerAtUnlock = db.state.markerOperation;
      },
    });

    await runApplyFixture(fixture, { db });
    expect(auditAtUnlock).toContain('"outcome":"success"');
    expect(markerAtUnlock).toBeUndefined();
  });
});
