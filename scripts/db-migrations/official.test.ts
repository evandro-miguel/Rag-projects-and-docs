import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendOfficialAudit,
  assertExpectedTargetFingerprint,
  assertOfficialMutationGates,
  assertOfficialRouteMode,
  assertOfficialTarget,
  canonicalDigest,
  canonicalJson,
  createBackupReceipt,
  createOfficialPlan,
  createOperationAudit,
  createRestoreVerificationReceipt,
  createWriteDrainReceipt,
  fingerprintV2For,
  type OfficialMigrationPlan,
  readDrainObservation,
  validateBackupReceipt,
  validateOfficialPlan,
  validateRestoreVerificationReceipt,
  validateWriteDrainReceipt,
} from './official.js';
import {
  canonicalizeMigrationTarget,
  type LoadedMigration,
  type MigrationLane,
  MigrationRunnerError,
  type SqlExecutor,
  sha256Text,
} from './runner.js';
import { MIGRATION_MAINTENANCE_TABLE } from './write-fence.js';

class ReadOnlyDb implements SqlExecutor {
  readonly calls: string[] = [];
  async unsafe(text: string): Promise<Record<string, unknown>[]> {
    this.calls.push(text);
    if (text.includes('pg_control_system')) {
      return [
        {
          system_identifier: '1001',
          database_oid: '2002',
          database: 'project_rag',
        },
      ];
    }
    if (text.includes('from public.rag_schema_migrations')) {
      throw Object.assign(new Error('relation is absent'), { code: '42P01' });
    }
    if (text.includes('to_regclass')) return [{ present: false }];
    throw new Error(`unexpected query: ${text}`);
  }
}

class DrainDb implements SqlExecutor {
  readonly calls: string[] = [];

  constructor(
    private readonly activityRow: Record<string, unknown>,
    private readonly grantsMaterial = ''
  ) {}

  async unsafe(text: string): Promise<Record<string, unknown>[]> {
    this.calls.push(text);
    if (text.includes('pg_stat_activity')) return [this.activityRow];
    if (text.includes('information_schema.role_table_grants')) {
      return [{ grants_material: this.grantsMaterial }];
    }
    throw new Error(`unexpected drain query: ${text}`);
  }
}

const now = new Date('2026-08-31T12:00:00.000Z');
const identity = canonicalizeMigrationTarget('postgres://127.0.0.1:5542/project_rag');
const targetFingerprint = fingerprintV2For({
  host: identity.host,
  port: identity.port,
  database: identity.database,
  systemIdentifier: '1001',
  databaseOid: '2002',
});
const EMPTY_GRANTS_DIGEST = sha256Text('');

function manifest(lane: MigrationLane): LoadedMigration[] {
  return [
    {
      descriptor: { lane, ordinal: 1, name: '001-core', relativePath: `${lane}/001.sql` },
      checksumSha256: sha256Text(`${lane}-001`),
      sqlText: 'select 1',
    },
  ];
}

async function planFixture(): Promise<OfficialMigrationPlan> {
  const db = new ReadOnlyDb();
  const project = manifest('project');
  return createOfficialPlan({
    lanes: ['project'],
    dbByLane: { project: db, docs: db },
    manifests: { project, docs: manifest('docs') },
    targetIdentities: { project: identity, docs: identity },
    expectedTargetFingerprint: targetFingerprint,
    repoSha: 'a'.repeat(40),
    operationId: 'official-test-1',
    now,
    ttlMs: 60_000,
  });
}

const tempDirs: string[] = [];
beforeEach(async () => {
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('official target and gate boundaries', () => {
  it('keeps the unimplemented official rollback route gated', () => {
    const command = 'rollback';
    const result = spawnSync(
      'bun',
      [join(process.cwd(), 'scripts/db-migrations/cli.ts'), 'official', command],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('MIGRATION_ARTIFACT_INVALID');
    expect(result.stdout).toContain('security fence fixes');
  });

  it.each([
    'drain',
    'apply',
    'recover',
  ] as const)('rejects official %s before reading artifacts when --plan is absent', (command) => {
    const result = spawnSync(
      'bun',
      [join(process.cwd(), 'scripts/db-migrations/cli.ts'), 'official', command],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('MIGRATION_ACK_REQUIRED');
    expect(result.stdout).toContain('--plan is required');
  });

  it('advertises the governed recovery route and prior-operation declaration', () => {
    const result = spawnSync(
      'bun',
      [join(process.cwd(), 'scripts/db-migrations/cli.ts'), 'official', 'recover', '--help'],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('official recover');
    expect(result.stderr).toContain('--prior-operation-id');
  });

  it('rejects isolated mode before any database operation', () => {
    expect(() => assertOfficialRouteMode({ RAG_MIGRATION_TARGET: 'isolated' })).toThrow(
      MigrationRunnerError
    );
    expect(() =>
      assertOfficialMutationGates(
        {
          RAG_MIGRATION_TARGET: 'isolated',
          RAG_MIGRATION_OFFICIAL_ACK: 'wrong',
        },
        { execute: true }
      )
    ).toThrowError('official mutation requires RAG_MIGRATION_TARGET=official');
  });

  it('requires the exact official acknowledgements and fingerprint', () => {
    expect(() =>
      assertOfficialMutationGates(
        {
          RAG_MIGRATION_TARGET: 'official',
          RAG_MIGRATION_OFFICIAL_ACK: 'I_ACKNOWLEDGE_OFFICIAL_DATABASE_MUTATION',
          RAG_MIGRATION_WRITE_ACK: '1',
          RAG_MIGRATION_MAINTENANCE_ACK: '1',
        },
        { execute: true }
      )
    ).toThrowError('RAG_MIGRATION_EXPECTED_TARGET_FINGERPRINT');

    expect(() => assertExpectedTargetFingerprint(targetFingerprint, sha256Text('other'))).toThrow(
      'connected server fingerprint'
    );
  });

  it('rejects a disposable target from the official route', () => {
    const disposable = canonicalizeMigrationTarget(
      'postgres://127.0.0.1:6543/rag_v2_migration_fixture'
    );
    expect(() => assertOfficialTarget(disposable.redactedUrl, disposable)).toThrowError(
      'disposable migration targets'
    );
  });
});

describe('official fingerprint and canonical artifacts', () => {
  it('uses sorted canonical JSON and v2 identity fields', () => {
    expect(canonicalJson({ z: 1, a: { d: true, c: null } })).toBe(
      '{"a":{"c":null,"d":true},"z":1}'
    );
    expect(canonicalDigest({ z: 1, a: 2 })).toBe(canonicalDigest({ a: 2, z: 1 }));
    expect(targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('creates and validates a read-only plan with per-lane prefix state', async () => {
    const db = new ReadOnlyDb();
    const plan = await planFixture();
    expect(plan.schemaVersion).toBe(1);
    expect(plan.targetFingerprint).toBe(targetFingerprint);
    expect(plan.laneStates.project.prefixOrdinal).toBe(0);
    expect(plan.laneStates.project.state.kind).toBe('fresh');
    expect(db.calls).toHaveLength(0);
    expect(validateOfficialPlan(plan, now)).toEqual(plan);
  });

  it('rejects an invalid expected fingerprint before database I/O', async () => {
    const db = new ReadOnlyDb();
    const project = manifest('project');
    await expect(
      createOfficialPlan({
        lanes: ['project'],
        dbByLane: { project: db, docs: db },
        manifests: { project, docs: manifest('docs') },
        targetIdentities: { project: identity, docs: identity },
        expectedTargetFingerprint: 'b'.repeat(64),
        repoSha: 'a'.repeat(40),
        now,
      })
    ).rejects.toThrowError('connected server fingerprint');
    expect(db.calls).toHaveLength(1);
  });
});

describe('official backup, restore, drain and audit artifacts', () => {
  it('disables the idle timeout for long-running official database operations', async () => {
    const source = await readFile(join(process.cwd(), 'scripts/db-migrations/cli.ts'), 'utf8');
    const start = source.indexOf('async function openLaneSql(');
    const end = source.indexOf('\nfunction planTargetIdentity', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toMatch(/idleTimeout:\s*0/);
  });

  it('disables the idle timeout for long-running lane commands', async () => {
    const source = await readFile(join(process.cwd(), 'scripts/db-migrations/cli.ts'), 'utf8');
    const start = source.indexOf('// Short-lived pool pinned to exactly one reserved connection');
    const end = source.indexOf('\n    const db = adaptReservedSql', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toMatch(/idleTimeout:\s*0/);
  });

  it('binds a custom-format backup receipt to the plan and checksum', async () => {
    const plan = await planFixture();
    const dir = await mkdtemp(join(process.cwd(), '.tmp', 'official-'));
    tempDirs.push(dir);
    const backupPath = join(dir, 'backup.dump');
    await writeFile(backupPath, Buffer.from('PGDMP official fixture'));
    const receipt = await createBackupReceipt({
      plan,
      backupPath,
      postgresVersion: 'PostgreSQL 16',
      now,
    });
    expect(receipt.backupFormat).toBe('custom');
    expect(receipt.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(validateBackupReceipt(receipt, plan, now)).toEqual(receipt);
  });

  it('requires a disposable restore target and successful read smoke', async () => {
    const plan = await planFixture();
    const dir = await mkdtemp(join(process.cwd(), '.tmp', 'official-'));
    tempDirs.push(dir);
    const backupPath = join(dir, 'backup.dump');
    await writeFile(backupPath, Buffer.from('PGDMP official fixture'));
    const backup = await createBackupReceipt({ plan, backupPath, postgresVersion: '16', now });
    const receipt = await createRestoreVerificationReceipt({
      plan,
      backupReceipt: backup,
      backupPath,
      restoreTarget: 'postgres://127.0.0.1:6543/rag_v2_migration_restore',
      verification: {
        schemaProbes: { project: true, docs: true },
        lanePrefixes: { project: 0, docs: 0 },
        rowCountDigests: { project: sha256Text('rows') },
        readSmoke: true,
      },
      now,
    });
    expect(validateRestoreVerificationReceipt(receipt, plan, backup, now)).toEqual(receipt);
    await expect(
      createRestoreVerificationReceipt({
        plan,
        backupReceipt: backup,
        backupPath,
        restoreTarget: identity.redactedUrl,
        verification: {
          schemaProbes: { project: true, docs: true },
          lanePrefixes: { project: 0, docs: 0 },
          rowCountDigests: {},
          readSmoke: true,
        },
        now,
      })
    ).rejects.toThrowError();
  });

  it('rejects an un-drained observation and redacts audit URLs', async () => {
    const plan = await planFixture();
    expect(() =>
      createWriteDrainReceipt({
        plan,
        observation: {
          activeSessions: 1,
          activeTransactions: 0,
          connectionLimit: 10,
          baselineConnectionLimit: 10,
          bypassRoleDetected: false,
          settlingMs: 1000,
          drained: false,
        },
        now,
      })
    ).toThrowError('zero-session drain');
    const drain = createWriteDrainReceipt({
      plan,
      observation: {
        activeSessions: 0,
        activeTransactions: 0,
        connectionLimit: 1,
        baselineConnectionLimit: 10,
        bypassRoleDetected: false,
        settlingMs: 1000,
        drained: true,
        grantsDigest: EMPTY_GRANTS_DIGEST,
      },
      now,
    });
    expect(drain.drain.grantsDigest).toBe(EMPTY_GRANTS_DIGEST);
    expect(validateWriteDrainReceipt(drain, plan, now)).toEqual(drain);
    const audit = createOperationAudit({
      schemaVersion: 1,
      operationId: plan.operationId,
      createdAt: now.toISOString(),
      repoSha: plan.repoSha,
      targetFingerprint: plan.targetFingerprint,
      manifestDigest: plan.manifestDigest,
      laneStateDigest: plan.laneStateDigest,
      actor: 'operator',
      candidateSha: plan.repoSha,
      receiptDigests: [plan.contentDigest],
      beforeLaneStates: { project: plan.laneStates.project.state },
      afterLaneStates: { project: plan.laneStates.project.state },
      executedOrdinals: { project: [] },
      lock: 'acquired',
      drain: 'verified',
      outcome: 'failure',
      error: 'postgres://user:secret@127.0.0.1:5542/project_rag?token=abc',
    });
    const path = join(process.cwd(), '.tmp', 'official-audit', 'audit.jsonl');
    await appendOfficialAudit(path, audit);
    const written = await readFile(path, 'utf8');
    expect(written).not.toContain('secret');
    expect(written).not.toContain('token=abc');
  });

  it('counts only non-self client backends for drain activity', async () => {
    const db = new DrainDb({
      connection_limit: 10,
      active_sessions: 0,
      active_transactions: 0,
      bypass_role_detected: false,
    });
    const observation = await readDrainObservation(db);
    expect(observation).toMatchObject({
      activeSessions: 0,
      activeTransactions: 0,
      bypassRoleDetected: false,
      drained: true,
    });
    const activitySql = db.calls.find((text) => text.includes('pg_stat_activity'));
    expect(activitySql).toMatch(
      /where backend_type = 'client backend'[\s\S]+and pid <> pg_backend_pid\(\)/
    );
    expect(activitySql).toMatch(
      /where a\.backend_type = 'client backend'[\s\S]+and a\.pid <> pg_backend_pid\(\)/
    );
  });

  it('still reports a privileged client backend as a bypass role', async () => {
    const observation = await readDrainObservation(
      new DrainDb({
        connection_limit: 10,
        active_sessions: 1,
        active_transactions: 1,
        bypass_role_detected: true,
      })
    );
    expect(observation.bypassRoleDetected).toBe(true);
    expect(observation.drained).toBe(false);
  });

  it('excludes only maintenance grants while retaining application changes', async () => {
    const activity = {
      connection_limit: 10,
      active_sessions: 0,
      active_transactions: 0,
      bypass_role_detected: false,
    };
    const internalOnly = new DrainDb(activity);
    const applicationGrant = new DrainDb(activity, 'app_reader:SELECT');
    const internalObservation = await readDrainObservation(internalOnly);
    const applicationObservation = await readDrainObservation(applicationGrant);

    expect(internalObservation.grantsDigest).toBe(EMPTY_GRANTS_DIGEST);
    expect(applicationObservation.grantsDigest).toBe(sha256Text('app_reader:SELECT'));
    const grantsSql = internalOnly.calls.find((text) =>
      text.includes('information_schema.role_table_grants')
    );
    expect(grantsSql).toContain(
      `(table_schema || '.' || table_name) <> '${MIGRATION_MAINTENANCE_TABLE}'`
    );
  });
});
