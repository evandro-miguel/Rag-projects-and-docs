/**
 * Opt-in real-Postgres integration tests for the Project RAG snapshot gate.
 *
 * Runs only when PROJECT_RAG_REAL_DB_TEST=1 and requires an explicit disposable
 * PROJECT_RAG_DATABASE_URL on a non-official loopback listener.
 *
 * Creates uniquely named ephemeral project_repositories rows and deletes them
 * in finally (cascade snapshots). Never writes index files/chunks. Never prints
 * URLs, credentials, or absolute paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalizeMigrationTarget, OFFICIAL_DATABASE_PORTS } from '../db-migrations/runner.js';
import { resolveProjectRagPostgresConfig } from './config.js';
import {
  createSnapshotReviewToken,
  QUALIFIED_REVIEWER_CAPABILITY,
  snapshotReviewTokenDigest,
} from './snapshot-review.js';
import { approveProjectRagIngestSnapshot } from './snapshot-review-service.js';
import {
  assertProjectRagPostgresAllowlistSchemaReady,
  assertProjectRagPostgresSnapshotReviewSchemaReady,
  assertProjectRagPostgresSnapshotSchemaReady,
  claimProjectRagPostgresIngestSnapshot,
  closeProjectRagPostgresSql,
  consumeProjectRagPostgresIngestSnapshot,
  consumeProjectRagPostgresIngestSnapshotInTransaction,
  createProjectRagPostgresSql,
  EMPTY_ALLOWLIST_HASH,
  failProjectRagPostgresIngestSnapshot,
  findProjectRagPostgresIngestSnapshot,
  findProjectRagPostgresIngestSnapshotByUuid,
  findProjectRagPostgresSnapshotReview,
  insertProjectRagPostgresIngestSnapshot,
  insertProjectRagPostgresSnapshotReview,
  isPostgresUniqueViolation,
  renewProjectRagPostgresIngestSnapshotLease,
  sweepStaleProjectRagPostgresIngestSnapshots,
  upsertProjectRagPostgresRepository,
} from './store.js';
import { beginProjectRagWrite } from './transaction.js';

const RUN_REAL_DB = process.env.PROJECT_RAG_REAL_DB_TEST === '1';
const describeReal = RUN_REAL_DB ? describe : describe.skip;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function uniqueToken(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function assertDisposableSnapshotGateTarget(rawUrl: string): void {
  const identity = canonicalizeMigrationTarget(rawUrl);
  if (identity.host !== '127.0.0.1' && identity.host !== '::1') {
    throw new Error('snapshot gate target must bind to loopback');
  }
  if (OFFICIAL_DATABASE_PORTS.includes(identity.port)) {
    throw new Error('snapshot gate target must not use an official listener port');
  }
  if (!identity.database.startsWith('rag_v2_migration_')) {
    throw new Error('snapshot gate target must use a rag_v2_migration_* database');
  }
}

function bigintArrayLiteral(ids: readonly number[]): string {
  return `{${ids.map((id) => String(id)).join(',')}}`;
}

async function countSnapshotsForProjects(
  sql: Bun.SQL,
  projectIds: readonly number[]
): Promise<number> {
  if (projectIds.length === 0) {
    return 0;
  }
  const lit = bigintArrayLiteral(projectIds);
  const rows = (await sql`
    select count(*)::int as c
    from project_ingest_snapshots
    where project_id = any(${lit}::bigint[])
  `) as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

async function countProjectsByIds(sql: Bun.SQL, projectIds: readonly number[]): Promise<number> {
  if (projectIds.length === 0) {
    return 0;
  }
  const lit = bigintArrayLiteral(projectIds);
  const rows = (await sql`
    select count(*)::int as c
    from project_repositories
    where id = any(${lit}::bigint[])
  `) as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

describeReal('snapshot gate real Postgres integration (opt-in)', () => {
  let sql: Bun.SQL;
  let databaseUrl: string | undefined;
  let projectAId = 0;
  let projectBId = 0;
  const createdProjectIds: number[] = [];
  const token = uniqueToken();

  async function createEphemeralProject(label: string): Promise<number> {
    const slug = `snap-gate-it-${label}-${token}`;
    // Synthetic root identifiers only (not host filesystem paths printed).
    const root = `/__ephemeral__/snap-gate-it/${label}-${token}`;
    const id = await upsertProjectRagPostgresRepository(sql, {
      name: `snap-gate-it-${label}`,
      slug,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
      metadata: {
        purpose: 'snapshot-gate-postgres-integration',
        token,
        label,
      },
    });
    createdProjectIds.push(id);
    return id;
  }

  async function cleanupCreatedProjects(): Promise<void> {
    if (createdProjectIds.length === 0) {
      return;
    }
    const lit = bigintArrayLiteral(createdProjectIds);
    await sql`delete from project_repositories where id = any(${lit}::bigint[])`;
  }

  beforeAll(async () => {
    databaseUrl = process.env.PROJECT_RAG_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('PROJECT_RAG_DATABASE_URL is required for the snapshot gate real DB suite');
    }
    assertDisposableSnapshotGateTarget(databaseUrl);
    const config = resolveProjectRagPostgresConfig(process.env);
    sql = createProjectRagPostgresSql(config);
    projectAId = await createEphemeralProject('a');
    projectBId = await createEphemeralProject('b');
  });

  afterAll(async () => {
    try {
      await cleanupCreatedProjects();
    } finally {
      if (databaseUrl) {
        await closeProjectRagPostgresSql(databaseUrl);
      } else {
        await closeProjectRagPostgresSql();
      }
    }
  });

  it('asserts snapshot schema readiness (003 + 004)', async () => {
    await expect(assertProjectRagPostgresSnapshotSchemaReady(sql)).resolves.toBeUndefined();
    await expect(assertProjectRagPostgresAllowlistSchemaReady(sql)).resolves.toBeUndefined();
  });

  it('approves and claims one exact snapshot through migration 005', async () => {
    await expect(assertProjectRagPostgresSnapshotReviewSchemaReady(sql)).resolves.toBeUndefined();
    const now = Math.floor(Date.now() / 1000);
    const snapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      commandScope: 'full',
      addsCount: 3,
      trackedCount: 10,
      inventoryHash: HASH_A,
      baselineHash: HASH_B,
      ttlSeconds: 300,
      status: 'REVIEW_REQUIRED',
    });
    const signingKey = 'snapshot-review-integration-key-with-32-bytes';
    const token = createSnapshotReviewToken(
      {
        snapshotUuid: snapshot.snapshotUuid,
        projectId: projectAId,
        commandScope: 'full',
        reviewerId: 'integration-qualified-reviewer',
        capability: QUALIFIED_REVIEWER_CAPABILITY,
        evidenceId: 'E-snapshot-review-integration',
        reason: 'Integration fixture reviewed the exact snapshot binding.',
        issuedAt: now - 1,
        expiresAt: now + 300,
      },
      signingKey
    );

    await expect(
      approveProjectRagIngestSnapshot(sql, snapshot.snapshotUuid, token, {
        signingKey,
        authenticatedOperator: {
          id: 'integration-operator',
          authentication: 'trusted-runtime',
        },
      })
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REVIEW_AUTHENTICATION_REQUIRED' });

    const review = await insertProjectRagPostgresSnapshotReview(sql, {
      snapshotUuid: snapshot.snapshotUuid,
      projectId: projectAId,
      reviewerId: 'integration-qualified-reviewer',
      operatorId: 'integration-operator',
      reviewerCapability: QUALIFIED_REVIEWER_CAPABILITY,
      evidenceId: 'E-snapshot-review-integration',
      reason: 'Integration fixture reviewed the exact snapshot binding.',
      commandScope: 'full',
      tokenDigest: snapshotReviewTokenDigest(token),
      expiresAt: new Date((now + 300) * 1000).toISOString(),
    });
    expect(review.snapshotUuid).toBe(snapshot.snapshotUuid);
    expect(review.reviewerCapability).toBe(QUALIFIED_REVIEWER_CAPABILITY);
    expect(review.tokenDigest).not.toContain(token);
    expect(
      await findProjectRagPostgresSnapshotReview(sql, projectAId, snapshot.snapshotUuid)
    ).toMatchObject({ snapshotUuid: snapshot.snapshotUuid });

    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, snapshot.id, true);
    expect(claimed?.status).toBe('CONSUMING');
    const consumed = await consumeProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      snapshot.id,
      snapshot.snapshotUuid
    );
    expect(consumed?.status).toBe('CONSUMED');
  });

  it('inserts snapshot and freeze trigger rejects binding field changes', async () => {
    const snapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      inventoryHash: HASH_A,
      baselineHash: HASH_B,
      ttlSeconds: 300,
      status: 'PREPARED',
    });

    expect(snapshot.snapshotUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(snapshot.status).toBe('PREPARED');

    let freezeError: unknown;
    try {
      await sql`
        update project_ingest_snapshots
        set inventory_hash = ${'c'.repeat(64)}
        where id = ${snapshot.id}
          and project_id = ${projectAId}
      `;
    } catch (err) {
      freezeError = err;
    }

    expect(freezeError).toBeDefined();
    const message = freezeError instanceof Error ? freezeError.message : String(freezeError);
    expect(message).toMatch(/binding field inventory_hash cannot be mutated after insert/i);

    const reloaded = await findProjectRagPostgresIngestSnapshot(sql, projectAId, snapshot.id);
    expect(reloaded?.inventoryHash).toBe(HASH_A);
    expect(reloaded?.snapshotUuid).toBe(snapshot.snapshotUuid);
  });

  it('inserts snapshot with default allowlist hash and suppressed findings', async () => {
    const snapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      inventoryHash: HASH_A,
      baselineHash: HASH_A,
      ttlSeconds: 300,
      status: 'PREPARED',
    });

    expect(snapshot.blockedFindingAllowlistHash).toBe(EMPTY_ALLOWLIST_HASH);
    expect(snapshot.suppressedBlockedFindings).toEqual([]);

    // Clean up
    const cleaned = await sql`
      update project_ingest_snapshots
      set status = 'FAILED',
        failure_code = 'SYSTEM_ERROR',
        failure_detail = 'allowlist default fixture cleanup',
        failed_at = now(),
        updated_at = now()
      where id = ${snapshot.id}
        and project_id = ${projectAId}
    `;
    expect(cleaned).toBeDefined();
  });

  it('freeze trigger protects blocked_finding_allowlist_hash and suppressed_blocked_findings', async () => {
    const snapshot = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      inventoryHash: HASH_A,
      baselineHash: HASH_A,
      ttlSeconds: 300,
      status: 'PREPARED',
    });

    // Try to mutate blocked_finding_allowlist_hash
    let hashError: unknown;
    try {
      await sql`
        update project_ingest_snapshots
        set blocked_finding_allowlist_hash = ${'b'.repeat(64)}
        where id = ${snapshot.id}
          and project_id = ${projectAId}
      `;
    } catch (err) {
      hashError = err;
    }
    expect(hashError).toBeDefined();
    const hashMsg = hashError instanceof Error ? hashError.message : String(hashError);
    expect(hashMsg).toMatch(/blocked_finding_allowlist_hash cannot be mutated/i);

    // Try to mutate suppressed_blocked_findings
    let suppressedError: unknown;
    try {
      await sql`
        update project_ingest_snapshots
        set suppressed_blocked_findings = ${JSON.stringify([{ category: 'test', count: 1 }])}::jsonb
        where id = ${snapshot.id}
          and project_id = ${projectAId}
      `;
    } catch (err) {
      suppressedError = err;
    }
    expect(suppressedError).toBeDefined();
    const suppMsg =
      suppressedError instanceof Error ? suppressedError.message : String(suppressedError);
    expect(suppMsg).toMatch(/suppressed_blocked_findings cannot be mutated/i);

    // Clean up
    await sql`
      update project_ingest_snapshots
      set status = 'FAILED',
        failure_code = 'SYSTEM_ERROR',
        failure_detail = 'freeze allowlist fixture cleanup',
        failed_at = now(),
        updated_at = now()
      where id = ${snapshot.id}
        and project_id = ${projectAId}
    `;
  });

  it('DB CHECKs reject suppressed_blocked_findings that exceed 32 entries', async () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => ({ category: `cat${i}`, count: 1 }));
    await expect(
      sql`
        insert into project_ingest_snapshots (
          project_id, status, ttl_seconds, expires_at,
          suppressed_blocked_findings
        )
        values (
          ${projectAId}, 'PREPARED', 300, now() + interval '5 minutes',
          ${JSON.stringify(tooMany)}::jsonb
        )
      `
    ).rejects.toThrow();
  });

  it('upserts repository with blocked_finding_allowlist', async () => {
    const slug = `repo-allowlist-${uniqueToken()}`;
    const root = `/__ephemeral__/repo-allowlist/${slug}`;
    const id = await upsertProjectRagPostgresRepository(sql, {
      name: 'Allowlist Repo',
      slug,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
      blockedFindingAllowlist: [
        { relativePath: 'src/secret.ts', category: 'dependency_dir' },
        { relativePath: 'test/fixture', category: 'cache_dir' },
      ],
    });

    expect(id).toBeGreaterThan(0);

    // Verify the value was persisted
    const rows = (await sql`
      select blocked_finding_allowlist
      from project_repositories
      where id = ${id}
    `) as Array<{ blocked_finding_allowlist: unknown }>;

    expect(rows[0]).toBeDefined();
    const list = rows[0]?.blocked_finding_allowlist;
    expect(Array.isArray(list)).toBe(true);
    expect(list as Array<unknown>).toHaveLength(2);

    // Clean up
    await sql`delete from project_repositories where id = ${id}`;
  });

  it('upsert repository: undefined allowlist preserves existing on conflict', async () => {
    const slug = `repo-allowlist-preserve-${uniqueToken()}`;
    const root = `/__ephemeral__/repo-allowlist/${slug}`;
    const id = await upsertProjectRagPostgresRepository(sql, {
      name: 'Preserve Test',
      slug,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
      blockedFindingAllowlist: [{ relativePath: 'src/keep.ts', category: 'dependency_dir' }],
    });
    expect(id).toBeGreaterThan(0);

    // Upsert again without allowlist — should preserve existing entries
    await upsertProjectRagPostgresRepository(sql, {
      name: 'Preserve Test Updated',
      slug,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
    });

    const rows = (await sql`
      select blocked_finding_allowlist
      from project_repositories
      where id = ${id}
    `) as Array<{ blocked_finding_allowlist: unknown }>;
    const list = rows[0]?.blocked_finding_allowlist;
    expect(Array.isArray(list)).toBe(true);
    expect(list as Array<unknown>).toHaveLength(1);

    // Clean up
    await sql`delete from project_repositories where id = ${id}`;
  });

  it('upsert repository: explicit empty array clears existing allowlist', async () => {
    const slug = `repo-allowlist-clear-${uniqueToken()}`;
    const root = `/__ephemeral__/repo-allowlist/${slug}`;
    const id = await upsertProjectRagPostgresRepository(sql, {
      name: 'Clear Test',
      slug,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
      blockedFindingAllowlist: [{ relativePath: 'src/remove.ts', category: 'dependency_dir' }],
    });
    expect(id).toBeGreaterThan(0);

    // Upsert with empty array — should clear
    await upsertProjectRagPostgresRepository(sql, {
      name: 'Clear Test Updated',
      slug,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
      blockedFindingAllowlist: [],
    });

    const rows = (await sql`
      select blocked_finding_allowlist
      from project_repositories
      where id = ${id}
    `) as Array<{ blocked_finding_allowlist: unknown }>;
    const list = rows[0]?.blocked_finding_allowlist;
    expect(Array.isArray(list)).toBe(true);
    expect(list as Array<unknown>).toHaveLength(0);

    // Clean up
    await sql`delete from project_repositories where id = ${id}`;
  });

  it('upsert repository: 32 allowlist entries accepted, 33 rejected by DB CHECK', async () => {
    const slug = `repo-allowlist-bounds-${uniqueToken()}`;
    const root = `/__ephemeral__/repo-allowlist/${slug}`;
    const maxEntries: Array<{ relativePath: string; category: string }> = Array.from(
      { length: 32 },
      (_, i) => ({ relativePath: `path/to/dir${i}`, category: 'dependency_dir' })
    );

    const id = await upsertProjectRagPostgresRepository(sql, {
      name: 'Bounds Test',
      slug,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
      blockedFindingAllowlist: maxEntries,
    });
    expect(id).toBeGreaterThan(0);

    // Verify 32 entries stored
    const rows = (await sql`
      select jsonb_array_length(blocked_finding_allowlist) as len
      from project_repositories
      where id = ${id}
    `) as Array<{ len: number }>;
    expect(Number(rows[0]?.len)).toBe(32);

    // 33 entries should be rejected by DB CHECK constraint
    const tooMany: Array<{ relativePath: string; category: string }> = Array.from(
      { length: 33 },
      (_, i) => ({ relativePath: `path/to/dir${i}`, category: 'dependency_dir' })
    );
    await expect(
      upsertProjectRagPostgresRepository(sql, {
        name: 'Bounds Test Fail',
        slug: `${slug}-fail`,
        rootPath: root,
        normalizedRootPath: root,
        ephemeral: true,
        blockedFindingAllowlist: tooMany,
      })
    ).rejects.toThrow();

    // Clean up
    await sql`delete from project_repositories where id = ${id}`;
  });

  it('DB CHECKs reject FAILED without code, ttl 29/86401, bad status/failure code', async () => {
    await expect(
      sql`
        insert into project_ingest_snapshots (project_id, status, failure_code, ttl_seconds, expires_at)
        values (${projectAId}, 'FAILED', null, 300, now() + interval '5 minutes')
      `
    ).rejects.toThrow();

    await expect(
      sql`
        insert into project_ingest_snapshots (project_id, status, ttl_seconds, expires_at)
        values (${projectAId}, 'PREPARED', 29, now() + interval '29 seconds')
      `
    ).rejects.toThrow();

    await expect(
      sql`
        insert into project_ingest_snapshots (project_id, status, ttl_seconds, expires_at)
        values (${projectAId}, 'PREPARED', 86401, now() + interval '1 day')
      `
    ).rejects.toThrow();

    await expect(
      sql`
        insert into project_ingest_snapshots (project_id, status, ttl_seconds, expires_at)
        values (${projectAId}, 'NOT_A_STATUS', 300, now() + interval '5 minutes')
      `
    ).rejects.toThrow();

    await expect(
      sql`
        insert into project_ingest_snapshots (
          project_id, status, failure_code, ttl_seconds, expires_at
        )
        values (
          ${projectAId}, 'FAILED', 'NOT_A_REAL_CODE', 300, now() + interval '5 minutes'
        )
      `
    ).rejects.toThrow();
  });

  it('two concurrent PREPARED claims: exactly one CONSUMING; Bun.SQL 23505 handled', async () => {
    const snap1 = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      inventoryHash: HASH_A,
      baselineHash: HASH_A,
      ttlSeconds: 300,
      status: 'PREPARED',
      commandScope: 'concurrent-1',
    });
    const snap2 = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      inventoryHash: HASH_B,
      baselineHash: HASH_B,
      ttlSeconds: 300,
      status: 'PREPARED',
      commandScope: 'concurrent-2',
    });

    // Prove Bun.SQL reports unique_violation via errno (not code === '23505').
    let probed: unknown;
    try {
      await sql`create temporary table if not exists _snap_gate_uniq (id int primary key)`;
      await sql`delete from _snap_gate_uniq`;
      await sql`insert into _snap_gate_uniq values (1)`;
      await sql`insert into _snap_gate_uniq values (1)`;
    } catch (err) {
      probed = err;
    }
    expect(probed).toBeDefined();
    expect(isPostgresUniqueViolation(probed)).toBe(true);
    const probedObj = probed as { code?: unknown; errno?: unknown };
    // Bun.SQL: SQLSTATE lives on errno; code is a driver string.
    expect(
      probedObj.errno === 23505 || probedObj.errno === '23505' || probedObj.code === '23505'
    ).toBe(true);

    const results = await Promise.all([
      claimProjectRagPostgresIngestSnapshot(sql, projectAId, snap1.id),
      claimProjectRagPostgresIngestSnapshot(sql, projectAId, snap2.id),
    ]);

    const defined = results.filter((r) => r !== undefined);
    const undefinedCount = results.filter((r) => r === undefined).length;
    expect(defined).toHaveLength(1);
    expect(undefinedCount).toBe(1);
    expect(defined[0]?.status).toBe('CONSUMING');
    expect(defined[0]?.snapshotUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const consumingRows = (await sql`
      select snapshot_uuid::text as snapshot_uuid
      from project_ingest_snapshots
      where project_id = ${projectAId}
        and status = 'CONSUMING'
    `) as Array<{ snapshot_uuid: string }>;
    expect(consumingRows).toHaveLength(1);
    expect(consumingRows[0]?.snapshot_uuid).toBe(defined[0]?.snapshotUuid);

    // Leave project clean for later isolation/claim tests: fail the winner.
    if (defined[0]) {
      await failProjectRagPostgresIngestSnapshot(
        sql,
        projectAId,
        defined[0].id,
        'SYSTEM_ERROR',
        'concurrent claim fixture cleanup'
      );
    }
  });

  it('expired PREPARED is not claimable', async () => {
    const rows = (await sql`
      insert into project_ingest_snapshots (
        project_id, command_scope, inventory_hash, baseline_hash,
        status, ttl_seconds, expires_at
      )
      values (
        ${projectAId}, 'expired-prepared', ${HASH_A}, ${HASH_B},
        'PREPARED', 30, now() - interval '2 seconds'
      )
      returning id, snapshot_uuid
    `) as Array<{ id: number | string; snapshot_uuid: string }>;

    const id = Number(rows[0]?.id);
    const uuid = String(rows[0]?.snapshot_uuid);
    expect(id).toBeGreaterThan(0);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, id);
    expect(claimed).toBeUndefined();

    const still = await findProjectRagPostgresIngestSnapshot(sql, projectAId, id);
    expect(still?.status).toBe('PREPARED');
  });

  it('consume only from CONSUMING; double consume and reclaim fail', async () => {
    const prepared = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      inventoryHash: HASH_A,
      baselineHash: HASH_A,
      ttlSeconds: 300,
      status: 'PREPARED',
      commandScope: 'consume-path',
    });

    // Consume before claim must fail.
    const premature = await consumeProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      prepared.id,
      prepared.snapshotUuid
    );
    expect(premature).toBeUndefined();

    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
    expect(claimed?.status).toBe('CONSUMING');
    expect(claimed?.snapshotUuid).toBe(prepared.snapshotUuid);

    const consumed = await consumeProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      prepared.id,
      prepared.snapshotUuid
    );
    expect(consumed?.status).toBe('CONSUMED');
    expect(consumed?.snapshotUuid).toBe(prepared.snapshotUuid);

    const doubleConsume = await consumeProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      prepared.id,
      prepared.snapshotUuid
    );
    expect(doubleConsume).toBeUndefined();

    const reclaim = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
    expect(reclaim).toBeUndefined();

    const final = await findProjectRagPostgresIngestSnapshotByUuid(
      sql,
      projectAId,
      prepared.snapshotUuid
    );
    expect(final?.status).toBe('CONSUMED');
  });

  it('sweep expires PREPARED and fails stale CONSUMING', async () => {
    const expiredPrepared = (await sql`
      insert into project_ingest_snapshots (
        project_id, command_scope, status, ttl_seconds, expires_at
      )
      values (
        ${projectAId}, 'sweep-prepared', 'PREPARED', 30, now() - interval '5 seconds'
      )
      returning id, snapshot_uuid
    `) as Array<{ id: number | string; snapshot_uuid: string }>;
    const expiredId = Number(expiredPrepared[0]?.id);
    const expiredUuid = String(expiredPrepared[0]?.snapshot_uuid);

    const livePrepared = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      status: 'PREPARED',
      ttlSeconds: 300,
      commandScope: 'sweep-live-then-stale-lease',
    });
    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, livePrepared.id);
    expect(claimed?.status).toBe('CONSUMING');

    // Lifecycle field: force lease past due without touching frozen binding fields.
    await sql`
      update project_ingest_snapshots
      set lease_expires_at = now() - interval '2 seconds'
      where id = ${livePrepared.id}
        and project_id = ${projectAId}
        and status = 'CONSUMING'
    `;

    const sweep = await sweepStaleProjectRagPostgresIngestSnapshots(sql, projectAId);
    expect(sweep.expiredIds).toContain(expiredId);
    expect(sweep.abandonedIds).toContain(livePrepared.id);
    expect(sweep.expiredCount).toBeGreaterThanOrEqual(1);
    expect(sweep.abandonedCount).toBeGreaterThanOrEqual(1);

    const expiredRow = await findProjectRagPostgresIngestSnapshot(sql, projectAId, expiredId);
    expect(expiredRow?.status).toBe('EXPIRED');
    expect(expiredRow?.snapshotUuid).toBe(expiredUuid);

    const abandonedRow = await findProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      livePrepared.id
    );
    expect(abandonedRow?.status).toBe('FAILED');
    expect(abandonedRow?.failureCode).toBe('CLAIM_LEASE_ABANDONED');
    expect(abandonedRow?.snapshotUuid).toBe(livePrepared.snapshotUuid);
  });

  it('reclaiming a claim never lets an expired worker revive its immutable UUID', async () => {
    const isolatedConnectionUrl = databaseUrl;
    if (!isolatedConnectionUrl) {
      throw new Error('PROJECT_RAG_DATABASE_URL is required for the reclaim integration test');
    }
    // Keep the lease-expiry mutation on a distinct pool/connection from the
    // worker operations. The old worker then races only through exact id+UUID
    // predicates after the row has been reclaimed.
    const observer = new Bun.SQL({ url: isolatedConnectionUrl, max: 1, prepare: false });
    let replacement: Awaited<ReturnType<typeof insertProjectRagPostgresIngestSnapshot>> | undefined;
    try {
      const prepared = await insertProjectRagPostgresIngestSnapshot(sql, {
        projectId: projectAId,
        inventoryHash: HASH_A,
        baselineHash: HASH_A,
        ttlSeconds: 300,
        status: 'PREPARED',
        commandScope: 'reclaim-aba-old-worker',
      });
      const firstClaim = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
      expect(firstClaim?.status).toBe('CONSUMING');

      await observer`
        update project_ingest_snapshots
        set lease_expires_at = now() - interval '2 seconds'
        where id = ${prepared.id}
          and project_id = ${projectAId}
          and snapshot_uuid = ${prepared.snapshotUuid}::uuid
          and status = 'CONSUMING'
      `;
      const expiredConsume = await consumeProjectRagPostgresIngestSnapshot(
        sql,
        projectAId,
        prepared.id,
        prepared.snapshotUuid
      );
      expect(expiredConsume).toBeUndefined();

      const sweep = await sweepStaleProjectRagPostgresIngestSnapshots(sql, projectAId);
      expect(sweep.abandonedIds).toContain(prepared.id);

      replacement = await insertProjectRagPostgresIngestSnapshot(sql, {
        projectId: projectAId,
        inventoryHash: HASH_B,
        baselineHash: HASH_B,
        ttlSeconds: 300,
        status: 'PREPARED',
        commandScope: 'reclaim-aba-new-worker',
      });
      const secondClaim = await claimProjectRagPostgresIngestSnapshot(
        sql,
        projectAId,
        replacement.id
      );
      expect(secondClaim?.status).toBe('CONSUMING');
      expect(secondClaim?.snapshotUuid).not.toBe(prepared.snapshotUuid);

      const staleConsume = await consumeProjectRagPostgresIngestSnapshot(
        sql,
        projectAId,
        prepared.id,
        prepared.snapshotUuid
      );
      const staleRenew = await renewProjectRagPostgresIngestSnapshotLease(
        sql,
        projectAId,
        prepared.id,
        prepared.snapshotUuid
      );
      expect(staleConsume).toBeUndefined();
      expect(staleRenew).toBeUndefined();
      await expect(
        findProjectRagPostgresIngestSnapshot(sql, projectAId, replacement.id)
      ).resolves.toMatchObject({
        status: 'CONSUMING',
        snapshotUuid: replacement.snapshotUuid,
      });
    } finally {
      if (replacement) {
        await failProjectRagPostgresIngestSnapshot(
          sql,
          projectAId,
          replacement.id,
          'SYSTEM_ERROR',
          'reclaim ABA fixture cleanup'
        );
      }
      await observer.close({ timeout: 1 });
    }
  });

  it('rolls back a terminal mutation when the claim expires before commit', async () => {
    const prepared = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      inventoryHash: HASH_A,
      baselineHash: HASH_A,
      ttlSeconds: 30,
      status: 'PREPARED',
      commandScope: 'terminal-expiry-rollback',
    });
    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
    expect(claimed?.status).toBe('CONSUMING');

    await expect(
      beginProjectRagWrite(
        sql,
        async (tx) => {
          await tx`
            update project_ingest_snapshots
            set lease_expires_at = clock_timestamp() + interval '50 milliseconds'
            where id = ${prepared.id}
              and project_id = ${projectAId}
              and snapshot_uuid = ${prepared.snapshotUuid}::uuid
              and status = 'CONSUMING'
          `;
          const consumed = await consumeProjectRagPostgresIngestSnapshotInTransaction(
            tx,
            projectAId,
            prepared.id,
            prepared.snapshotUuid
          );
          expect(consumed?.status).toBe('CONSUMED');
          await Bun.sleep(100);
          return consumed;
        },
        {
          projectId: projectAId,
          snapshotId: prepared.id,
          snapshotUuid: prepared.snapshotUuid,
          terminalTransition: 'CONSUMED',
        }
      )
    ).rejects.toMatchObject({ code: 'PROJECT_RAG_SNAPSHOT_LEASE_LOST' });

    const rolledBack = await findProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
    expect(rolledBack?.status).toBe('CONSUMING');
    expect(rolledBack?.snapshotUuid).toBe(prepared.snapshotUuid);
    await sql`
      update project_ingest_snapshots
      set lease_expires_at = now() - interval '1 second'
      where id = ${prepared.id}
        and project_id = ${projectAId}
        and snapshot_uuid = ${prepared.snapshotUuid}::uuid
        and status = 'CONSUMING'
    `;
    await sweepStaleProjectRagPostgresIngestSnapshots(sql, projectAId);
  });

  it('project A cannot find/claim/consume/fail project B snapshot by id or UUID', async () => {
    const bSnap = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectBId,
      inventoryHash: HASH_B,
      baselineHash: HASH_B,
      ttlSeconds: 300,
      status: 'PREPARED',
      commandScope: 'isolation-b',
    });

    const foundById = await findProjectRagPostgresIngestSnapshot(sql, projectAId, bSnap.id);
    expect(foundById).toBeUndefined();

    const foundByUuid = await findProjectRagPostgresIngestSnapshotByUuid(
      sql,
      projectAId,
      bSnap.snapshotUuid
    );
    expect(foundByUuid).toBeUndefined();

    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, bSnap.id);
    expect(claimed).toBeUndefined();

    // Claim legitimately under B so consume/fail isolation can be checked on CONSUMING.
    const claimedB = await claimProjectRagPostgresIngestSnapshot(sql, projectBId, bSnap.id);
    expect(claimedB?.status).toBe('CONSUMING');

    const consumeA = await consumeProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      bSnap.id,
      bSnap.snapshotUuid
    );
    expect(consumeA).toBeUndefined();

    const failA = await failProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      bSnap.id,
      'SYSTEM_ERROR',
      'cross-project isolation probe'
    );
    expect(failA).toBeUndefined();

    const stillB = await findProjectRagPostgresIngestSnapshot(sql, projectBId, bSnap.id);
    expect(stillB?.status).toBe('CONSUMING');
    expect(stillB?.snapshotUuid).toBe(bSnap.snapshotUuid);

    // Cleanup B consumer for later project delete.
    await failProjectRagPostgresIngestSnapshot(
      sql,
      projectBId,
      bSnap.id,
      'SYSTEM_ERROR',
      'isolation fixture cleanup'
    );
  });

  it('lease renew refuses an already expired lease', async () => {
    const prepared = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      status: 'PREPARED',
      ttlSeconds: 300,
      commandScope: 'lease-renew',
    });
    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
    expect(claimed?.status).toBe('CONSUMING');
    expect(claimed?.leaseExpiresAt).toBeTruthy();

    await sql`
      update project_ingest_snapshots
      set lease_expires_at = now() - interval '1 second'
      where id = ${prepared.id}
        and project_id = ${projectAId}
        and status = 'CONSUMING'
    `;

    const renewed = await renewProjectRagPostgresIngestSnapshotLease(
      sql,
      projectAId,
      prepared.id,
      prepared.snapshotUuid
    );
    expect(renewed).toBeUndefined();

    const still = await findProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
    expect(still?.status).toBe('CONSUMING');

    await failProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      prepared.id,
      'CLAIM_LEASE_ABANDONED',
      'lease renew fixture cleanup'
    );
  });

  it('consume requires live lease — expired unswept CONSUMING cannot consume', async () => {
    const prepared = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: projectAId,
      status: 'PREPARED',
      ttlSeconds: 300,
      commandScope: 'consume-expired-lease',
    });
    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
    expect(claimed?.status).toBe('CONSUMING');
    expect(claimed?.leaseExpiresAt).toBeTruthy();

    // Force lease past due (simulating an abandoned unswept consumer)
    await sql`
      update project_ingest_snapshots
      set lease_expires_at = now() - interval '1 second'
      where id = ${prepared.id}
        and project_id = ${projectAId}
        and status = 'CONSUMING'
    `;

    // Consume must fail because lease is dead
    const consumed = await consumeProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      prepared.id,
      prepared.snapshotUuid
    );
    expect(consumed).toBeUndefined();

    // Snapshot should still be CONSUMING (unswept, expired lease)
    const still = await findProjectRagPostgresIngestSnapshot(sql, projectAId, prepared.id);
    expect(still?.status).toBe('CONSUMING');

    // Cleanup
    await failProjectRagPostgresIngestSnapshot(
      sql,
      projectAId,
      prepared.id,
      'CLAIM_LEASE_ABANDONED',
      'consume expired lease fixture cleanup'
    );
  });

  it('project_repositories block trigger rejects config changes during CONSUMING', async () => {
    const slug = `repo-block-consuming-${uniqueToken()}`;
    const root = `/__ephemeral__/repo-block/${slug}`;
    const id = await upsertProjectRagPostgresRepository(sql, {
      name: 'Block During Consuming',
      slug,
      rootPath: root,
      normalizedRootPath: root,
      ephemeral: true,
      includeRoots: ['src'],
    });

    // Create and claim a snapshot for this project
    const snap = await insertProjectRagPostgresIngestSnapshot(sql, {
      projectId: id,
      inventoryHash: HASH_A,
      baselineHash: HASH_A,
      ttlSeconds: 300,
      status: 'PREPARED',
    });
    const claimed = await claimProjectRagPostgresIngestSnapshot(sql, id, snap.id);
    expect(claimed?.status).toBe('CONSUMING');

    // Attempt to update include_roots during CONSUMING — must be rejected
    let includeErr: unknown;
    try {
      await sql`
        update project_repositories
        set include_roots = ${'{lib}'}::text[]
        where id = ${id}
      `;
    } catch (err) {
      includeErr = err;
    }
    expect(includeErr).toBeDefined();
    const includeMsg = includeErr instanceof Error ? includeErr.message : String(includeErr);
    expect(includeMsg).toMatch(/cannot modify include_roots|CONSUMING ingest snapshot/i);

    // Attempt to update ignore_rules during CONSUMING — must be rejected
    let ignoreErr: unknown;
    try {
      await sql`
        update project_repositories
        set ignore_rules = ${'{build}'}::text[]
        where id = ${id}
      `;
    } catch (err) {
      ignoreErr = err;
    }
    expect(ignoreErr).toBeDefined();
    const ignoreMsg = ignoreErr instanceof Error ? ignoreErr.message : String(ignoreErr);
    expect(ignoreMsg).toMatch(/cannot modify ignore_rules|CONSUMING ingest snapshot/i);

    // Attempt to update blocked_finding_allowlist during CONSUMING — must be rejected
    let allowlistErr: unknown;
    try {
      await sql`
        update project_repositories
        set blocked_finding_allowlist = ${JSON.stringify([{ relativePath: 'src/secret', category: 'dependency_dir' }])}::jsonb
        where id = ${id}
      `;
    } catch (err) {
      allowlistErr = err;
    }
    expect(allowlistErr).toBeDefined();
    const allowlistMsg =
      allowlistErr instanceof Error ? allowlistErr.message : String(allowlistErr);
    expect(allowlistMsg).toMatch(
      /cannot modify.*blocked_finding_allowlist|CONSUMING ingest snapshot/i
    );

    // Non-guarded fields (status, sync_mode) must still be updatable during CONSUMING
    const statusUpdate = await sql`
      update project_repositories
      set sync_mode = 'diff'
      where id = ${id}
    `;
    expect(statusUpdate).toBeDefined();

    // Fail the snapshot to release the CONSUMING lock
    await failProjectRagPostgresIngestSnapshot(
      sql,
      id,
      snap.id,
      'SYSTEM_ERROR',
      'block-consuming fixture cleanup'
    );

    // After snapshot is FAILED, updates must succeed
    await sql`
      update project_repositories
      set include_roots = ${'{lib}'}::text[]
      where id = ${id}
    `;
    await sql`
      update project_repositories
      set ignore_rules = ${'{build}'}::text[]
      where id = ${id}
    `;

    // Verify the updates took effect
    const rows = (await sql`
      select include_roots, ignore_rules
      from project_repositories
      where id = ${id}
    `) as Array<{ include_roots: string[]; ignore_rules: string[] }>;
    expect(rows[0]?.include_roots).toContain('lib');
    expect(rows[0]?.ignore_rules).toContain('build');

    // Clean up
    await sql`delete from project_repositories where id = ${id}`;
    const idx = createdProjectIds.indexOf(id);
    if (idx >= 0) createdProjectIds.splice(idx, 1);
  });

  it('no rows left after cleanup', async () => {
    const ids = [...createdProjectIds];
    expect(ids.length).toBeGreaterThanOrEqual(2);

    const beforeSnapshots = await countSnapshotsForProjects(sql, ids);
    expect(beforeSnapshots).toBeGreaterThan(0);

    await cleanupCreatedProjects();
    createdProjectIds.length = 0;

    expect(await countProjectsByIds(sql, ids)).toBe(0);
    expect(await countSnapshotsForProjects(sql, ids)).toBe(0);
  });
});

// Always-registered smoke: default suite path skips real DB work without opt-in.
describe('snapshot gate real Postgres integration gate', () => {
  it('skips real DB suite unless PROJECT_RAG_REAL_DB_TEST=1', () => {
    if (RUN_REAL_DB) {
      expect(process.env.PROJECT_RAG_REAL_DB_TEST).toBe('1');
    } else {
      expect(process.env.PROJECT_RAG_REAL_DB_TEST === '1').toBe(false);
    }
  });
});
