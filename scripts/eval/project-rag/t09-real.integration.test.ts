/**
 * Opt-in T-09 integration proof for context identity, immutable publication,
 * durable jobs, worker recovery, and multiprocess MCP startup.
 *
 * This suite never falls back to an official database. Set
 * PROJECT_RAG_T09_DATABASE_URL to an isolated disposable Postgres instance
 * whose migrations 001-009 have already been applied.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { resolveProjectRagPostgresConfig } from '../../../scripts/project-rag/config.js';
import {
  listProjectRagWorkspaceTrackedFiles,
  resolveProjectRagWorkspaceContext,
} from '../../../scripts/project-rag/context.js';
import {
  claimProjectRagJob,
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  enqueueProjectRagJob,
  failProjectRagJob,
  findProjectRagPostgresSymbols,
  finishProjectRagJob,
  getProjectRagPostgresNavigationPaths,
  getProjectRagPostgresPublishedBuildState,
  promoteProjectRagPostgresFileVersions,
  publishProjectRagPostgresIndexBuild,
  renewProjectRagJobLease,
  upsertProjectRagPostgresRepository,
  upsertProjectRagWorkspaceContext,
} from '../../../scripts/project-rag/store.js';

const databaseUrl = process.env.PROJECT_RAG_T09_DATABASE_URL;
const describeReal = databaseUrl ? describe : describe.skip;
const scratchRoot = resolve('.tmp');
const hash = 'a'.repeat(64);

function uniqueToken(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function insertIndexedFile(
  sql: Bun.SQL,
  projectId: number,
  sourcePath: string,
  contentHash: string = hash,
  versionStatus: 'pending' | 'ready' = 'ready'
): Promise<{ fileId: number; versionId: number }> {
  const fileRows = (await sql`
    insert into project_files (
      project_id, source_path, absolute_path, content_hash, file_modified_at,
      lang, size_bytes, status, metadata_quality
    ) values (
      ${projectId}, ${sourcePath}, ${`/t09/${sourcePath}`}, ${contentHash}, 0,
      'typescript', 1, 'indexed', 'full'
    ) returning id
  `) as Array<{ id: number | string }>;
  const fileId = Number(fileRows[0]?.id);
  const versionRows = (await sql`
    insert into project_file_versions (
      project_id, file_id, status, content_hash, file_modified_at, lang,
      size_bytes, metadata_quality, compatibility_status
    ) values (
      ${projectId}, ${fileId}, ${versionStatus}, ${contentHash}, 0, 'typescript',
      1, 'full', 'indexed'
    ) returning id
  `) as Array<{ id: number | string }>;
  const versionId = Number(versionRows[0]?.id);
  if (versionStatus === 'ready') {
    await sql`
      update project_files
      set active_version_id = ${versionId}, latest_version_id = ${versionId}
      where id = ${fileId}
    `;
  } else {
    await sql`
      update project_files
      set latest_version_id = ${versionId}
      where id = ${fileId}
    `;
  }
  return { fileId, versionId };
}

function createGitFixture(): { repo: string; worktree: string } {
  mkdirSync(scratchRoot, { recursive: true });
  const repo = mkdtempSync(join(scratchRoot, 't09-git-repo-'));
  const worktree = join(scratchRoot, `t09-git-worktree-${uniqueToken()}`);
  execFileSync('git', ['init', '--quiet', repo]);
  writeFileSync(join(repo, 'README.md'), '# T09 fixture\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Project RAG T09',
    '-c',
    'user.email=project-rag-t09@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--quiet', '-b', 't09-side', worktree]);
  return { repo, worktree };
}

function cleanupGitFixture(fixture: { repo: string; worktree: string }): void {
  try {
    execFileSync('git', ['-C', fixture.repo, 'worktree', 'remove', '--force', fixture.worktree]);
  } catch {
    // The fixture is disposable; the final filesystem cleanup is authoritative.
  }
  rmSync(fixture.repo, { recursive: true, force: true });
  rmSync(fixture.worktree, { recursive: true, force: true });
}

async function waitForLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline >= 0) {
        child.stdout?.off('data', onData);
        resolveLine(output.slice(0, newline));
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', rejectLine);
    child.once('exit', (code, signal) => {
      if (!output.includes('\n')) {
        rejectLine(
          new Error(`worker fixture exited before claim (${code ?? signal ?? 'unknown'})`)
        );
      }
    });
  });
}

describeReal('T-09 real Project RAG invariant matrix', () => {
  it('binds Git worktrees to distinct persisted contexts', async () => {
    const sql = createProjectRagPostgresSql(resolveProjectRagPostgresConfig({}, { databaseUrl }));
    const fixture = createGitFixture();
    let repositoryId: number | undefined;
    let workspaceIds: number[] = [];
    try {
      const main = await resolveProjectRagWorkspaceContext(fixture.repo);
      const side = await resolveProjectRagWorkspaceContext(fixture.worktree);
      expect(main.repositoryCommonDir).toBe(side.repositoryCommonDir);
      expect(main.workspaceRoot).not.toBe(side.workspaceRoot);
      expect(await listProjectRagWorkspaceTrackedFiles(fixture.repo)).toContain('README.md');

      const mainRecord = await upsertProjectRagWorkspaceContext(sql, main);
      const sideRecord = await upsertProjectRagWorkspaceContext(sql, side);
      repositoryId = mainRecord.repositoryId;
      workspaceIds = [mainRecord.workspaceId, sideRecord.workspaceId];
      expect(mainRecord.repositoryId).toBe(sideRecord.repositoryId);
      expect(mainRecord.workspaceId).not.toBe(sideRecord.workspaceId);
      expect(mainRecord.revisionId).not.toBe(sideRecord.revisionId);
      expect(main.isDetached).toBe(false);
      expect(side.branchName).toBe('t09-side');
    } finally {
      if (workspaceIds.length > 0) {
        await sql`
          delete from project_rag_revisions
          where workspace_id = any(${`{${workspaceIds.join(',')}}`}::bigint[])
        `;
        await sql`
          delete from project_rag_workspaces
          where id = any(${`{${workspaceIds.join(',')}}`}::bigint[])
        `;
      }
      if (repositoryId !== undefined) {
        await sql`delete from project_rag_repositories where id = ${repositoryId}`;
      }
      cleanupGitFixture(fixture);
      await closeProjectRagPostgresSql(databaseUrl);
    }
  });

  it('keeps the published build readable when a candidate build is empty', async () => {
    const sql = createProjectRagPostgresSql(resolveProjectRagPostgresConfig({}, { databaseUrl }));
    const token = uniqueToken();
    const projectId = await upsertProjectRagPostgresRepository(sql, {
      name: `T09 publication ${token}`,
      slug: `t09-publication-${token}`,
      rootPath: `/t09/publication/${token}`,
      normalizedRootPath: `/t09/publication/${token}`,
      ephemeral: true,
    });
    try {
      await insertIndexedFile(sql, projectId, 'src/kept.ts');
      const first = await publishProjectRagPostgresIndexBuild(sql, projectId);
      expect(first.fileCount).toBe(1);

      await sql`update project_files set status = 'pending' where project_id = ${projectId}`;
      await expect(publishProjectRagPostgresIndexBuild(sql, projectId)).rejects.toThrow(
        'empty index build'
      );
      const state = await getProjectRagPostgresPublishedBuildState(sql, projectId);
      expect(state.buildId).toBe(first.id);

      const rows = (await sql`
        select count(*)::int as count
        from project_index_builds
        where project_id = ${projectId} and status = 'published'
      `) as Array<{ count: number }>;
      expect(Number(rows[0]?.count)).toBe(1);
    } finally {
      await sql`delete from project_repositories where id = ${projectId}`;
      await closeProjectRagPostgresSql(databaseUrl);
    }
  });

  it('rejects build-file associations whose file or version belongs to another project', async () => {
    const sql = createProjectRagPostgresSql(resolveProjectRagPostgresConfig({}, { databaseUrl }));
    const token = uniqueToken();
    const projectA = await upsertProjectRagPostgresRepository(sql, {
      name: `T09 FK A ${token}`,
      slug: `t09-fk-a-${token}`,
      rootPath: `/t09/fk/a/${token}`,
      normalizedRootPath: `/t09/fk/a/${token}`,
      ephemeral: true,
    });
    const projectB = await upsertProjectRagPostgresRepository(sql, {
      name: `T09 FK B ${token}`,
      slug: `t09-fk-b-${token}`,
      rootPath: `/t09/fk/b/${token}`,
      normalizedRootPath: `/t09/fk/b/${token}`,
      ephemeral: true,
    });
    try {
      const own = await insertIndexedFile(sql, projectA, 'src/own.ts');
      const ownVersion = await insertIndexedFile(sql, projectA, 'src/own-version.ts');
      const foreign = await insertIndexedFile(sql, projectB, 'src/foreign.ts');
      const buildRows = (await sql`
        insert into project_index_builds (project_id, status)
        values (${projectA}, 'building') returning id
      `) as Array<{ id: number | string }>;
      const buildId = Number(buildRows[0]?.id);

      await expect(sql`
        insert into project_index_build_files (
          build_id, project_id, file_id, version_id, source_path, absolute_path,
          status, size_bytes, metadata_quality
        ) values (
          ${buildId}, ${projectA}, ${own.fileId}, ${own.versionId}, 'src/own.ts',
          '/t09/fk/own.ts', 'indexed', 1, 'full'
        )
      `).resolves.toBeDefined();
      await expect(sql`
        insert into project_index_build_files (
          build_id, project_id, file_id, version_id, source_path, absolute_path,
          status, size_bytes, metadata_quality
        ) values (
          ${buildId}, ${projectA}, ${ownVersion.fileId}, ${foreign.versionId}, 'src/foreign-version.ts',
          '/t09/fk/foreign-version.ts', 'indexed', 1, 'full'
        )
      `).rejects.toThrow('project_index_build_files_version_project_fk');
      await expect(sql`
        insert into project_index_build_files (
          build_id, project_id, file_id, version_id, source_path, absolute_path,
          status, size_bytes, metadata_quality
        ) values (
          ${buildId}, ${projectA}, ${foreign.fileId}, ${own.versionId}, 'src/foreign-file.ts',
          '/t09/fk/foreign-file.ts', 'indexed', 1, 'full'
        )
      `).rejects.toThrow('project_index_build_files_file_project_fk');
    } finally {
      await sql`delete from project_repositories where id in (${projectA}, ${projectB})`;
      await closeProjectRagPostgresSql(databaseUrl);
    }
  });

  it('resolves symbols, references, and navigation against a published build', async () => {
    const sql = createProjectRagPostgresSql(resolveProjectRagPostgresConfig({}, { databaseUrl }));
    const token = uniqueToken();
    const projectId = await upsertProjectRagPostgresRepository(sql, {
      name: `T09 read models ${token}`,
      slug: `t09-readmodels-${token}`,
      rootPath: `/t09/readmodels/${token}`,
      normalizedRootPath: `/t09/readmodels/${token}`,
      ephemeral: true,
    });
    try {
      const router = await insertIndexedFile(sql, projectId, 'src/router.ts', hash, 'pending');
      const handler = await insertIndexedFile(sql, projectId, 'src/handler.ts', hash, 'pending');

      await sql`
        insert into project_symbols (
          project_id, file_id, version_id, name, symbol_type, export_type,
          signature, start_line, end_line, confidence
        ) values (
          ${projectId}, ${router.fileId}, ${router.versionId},
          'routeRequest', 'function', 'named', 'function routeRequest()', 10, 20, 0.9
        )
      `;
      await sql`
        insert into project_edges (
          project_id, source_file_id, source_version_id, source_ref, source_ref_lower,
          target_file_id, target_version_id, target_ref, target_ref_lower, relation_type
        ) values (
          ${projectId}, ${handler.fileId}, ${handler.versionId}, 'handleRequest', 'handlerequest',
          ${router.fileId}, ${router.versionId}, 'routeRequest', 'routerequest', 'imports'
        )
      `;

      await expect(promoteProjectRagPostgresFileVersions(sql, projectId)).resolves.toBe(2);
      const build = await publishProjectRagPostgresIndexBuild(sql, projectId);
      expect(build.fileCount).toBe(2);

      // Regression guard for the undefined SQL aliases that previously broke
      // find_project_symbol, find_symbol_references, and navigation tools.
      const { definitions, references } = await findProjectRagPostgresSymbols(sql, projectId, {
        name: 'routeRequest',
      });
      expect(definitions).toHaveLength(1);
      expect(definitions[0]?.sourcePath).toBe('src/router.ts');
      expect(definitions[0]?.startLine).toBe(10);
      expect(references).toHaveLength(1);
      expect(references[0]?.sourcePath).toBe('src/handler.ts');
      expect(references[0]?.targetPath).toBe('src/router.ts');

      const paths = await getProjectRagPostgresNavigationPaths(sql, projectId, 'src/handler.ts');
      expect(paths).toBeDefined();
      expect(paths?.length).toBeGreaterThanOrEqual(1);
      expect(paths?.[0]?.sourcePath).toBe('src/router.ts');
      expect(paths?.[0]?.relationshipType).toBe('imports');
    } finally {
      await sql`delete from project_repositories where id = ${projectId}`;
      await closeProjectRagPostgresSql(databaseUrl);
    }
  });

  it('deduplicates jobs, fences reclaimed workers, and persists provider failure', async () => {
    const sql = createProjectRagPostgresSql(resolveProjectRagPostgresConfig({}, { databaseUrl }));
    const token = uniqueToken();
    try {
      const first = await enqueueProjectRagJob(sql, {
        type: 't09_fault_fixture',
        dedupeKey: `t09-dedupe-${token}`,
        payload: { token },
      });
      const duplicate = await enqueueProjectRagJob(sql, {
        type: 't09_fault_fixture',
        dedupeKey: `t09-dedupe-${token}`,
        payload: { token, duplicate: true },
      });
      expect(duplicate.id).toBe(first.id);

      const workerA = await claimProjectRagJob(sql, `t09-a-${token}`, 1);
      expect(workerA?.fenceToken).toBe(1);
      expect(await claimProjectRagJob(sql, `t09-b-${token}`, 1)).toBeUndefined();
      await wait(1_200);
      const workerB = await claimProjectRagJob(sql, `t09-b-${token}`, 10);
      expect(workerB?.id).toBe(first.id);
      expect(workerB?.fenceToken).toBe(2);
      expect(
        await finishProjectRagJob(sql, first.id, workerA?.fenceToken ?? 0, {
          stale: true,
        })
      ).toBeUndefined();
      expect(
        (
          await finishProjectRagJob(sql, first.id, workerB?.fenceToken ?? 0, {
            recovered: true,
          })
        )?.status
      ).toBe('succeeded');

      const failedJob = await enqueueProjectRagJob(sql, {
        type: 't09_provider_fault',
        dedupeKey: `t09-provider-${token}`,
        payload: { token },
        maxAttempts: 1,
      });
      const failedClaim = await claimProjectRagJob(sql, `t09-provider-${token}`, 10);
      expect(failedClaim?.id).toBe(failedJob.id);
      expect(
        (
          await failProjectRagJob(
            sql,
            failedJob.id,
            failedClaim?.fenceToken ?? 0,
            'synthetic provider outage'
          )
        )?.status
      ).toBe('dead-letter');
    } finally {
      await sql`delete from project_jobs where dedupe_key like ${`t09-%-${token}`}`;
      await closeProjectRagPostgresSql(databaseUrl);
    }
  });

  it('recovers a leased job after the worker process is killed', async () => {
    const sql = createProjectRagPostgresSql(resolveProjectRagPostgresConfig({}, { databaseUrl }));
    const token = uniqueToken();
    const job = await enqueueProjectRagJob(sql, {
      type: 't09_process_restart',
      dedupeKey: `t09-process-${token}`,
      payload: { token },
    });
    const childCode = [
      "import { resolveProjectRagPostgresConfig } from './scripts/project-rag/config.ts';",
      "import { claimProjectRagJob, createProjectRagPostgresSql } from './scripts/project-rag/store.ts';",
      'const cfg=resolveProjectRagPostgresConfig({}, { databaseUrl: process.env.PROJECT_RAG_T09_DATABASE_URL });',
      'const sql=createProjectRagPostgresSql(cfg);',
      "const job=await claimProjectRagJob(sql, 't09-killed-worker', 1);",
      'console.log(JSON.stringify({ id: job?.id ?? null, fence: job?.fenceToken ?? null }));',
      'await new Promise(() => {});',
    ].join('\n');
    const child = spawn('bun', ['-e', childCode], {
      cwd: process.cwd(),
      env: { ...process.env, PROJECT_RAG_T09_DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const claimLine = await waitForLine(child);
      expect(JSON.parse(claimLine)).toMatchObject({ id: job.id, fence: 1 });
      child.kill('SIGKILL');
      await wait(1_200);
      const recovered = await claimProjectRagJob(sql, `t09-restarted-${token}`, 10);
      expect(recovered).toMatchObject({ id: job.id, fenceToken: 2 });
      await finishProjectRagJob(sql, job.id, recovered?.fenceToken ?? 0, { restarted: true });
    } finally {
      child.kill('SIGKILL');
      await sql`delete from project_jobs where id = ${job.id}`;
      await closeProjectRagPostgresSql(databaseUrl);
    }
  });

  it('rejects stale lease renewal and completion after forced expiry and reclaim', async () => {
    const sql = createProjectRagPostgresSql(resolveProjectRagPostgresConfig({}, { databaseUrl }));
    const token = uniqueToken();
    const job = await enqueueProjectRagJob(sql, {
      type: 't09_forced_expiry',
      dedupeKey: `t09-forced-expiry-${token}`,
      payload: { token },
    });
    try {
      const first = await claimProjectRagJob(sql, `t09-expiry-a-${token}`, 60);
      expect(first).toMatchObject({ id: job.id, fenceToken: 1 });

      await sql`
        update project_jobs
        set lease_expires_at = now() - interval '1 second'
        where id = ${job.id} and fence_token = ${first?.fenceToken ?? 0}
      `;

      const reclaimed = await claimProjectRagJob(sql, `t09-expiry-b-${token}`, 60);
      expect(reclaimed).toMatchObject({ id: job.id, fenceToken: 2 });
      expect(
        await renewProjectRagJobLease(sql, job.id, first?.fenceToken ?? 0, 60)
      ).toBeUndefined();
      expect(
        await finishProjectRagJob(sql, job.id, first?.fenceToken ?? 0, { stale: true })
      ).toBeUndefined();
      expect(
        (
          await finishProjectRagJob(sql, job.id, reclaimed?.fenceToken ?? 0, {
            reclaimed: true,
          })
        )?.status
      ).toBe('succeeded');
    } finally {
      await sql`delete from project_jobs where id = ${job.id}`;
      await closeProjectRagPostgresSql(databaseUrl);
    }
  });

  it('keeps concurrent job claims unique under a bounded load', async () => {
    const sql = createProjectRagPostgresSql(resolveProjectRagPostgresConfig({}, { databaseUrl }));
    const token = uniqueToken();
    const count = 24;
    try {
      const jobs = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          enqueueProjectRagJob(sql, {
            type: 't09_bounded_load',
            dedupeKey: `t09-load-${token}-${index}`,
            payload: { token, index },
          })
        )
      );
      const claimed = (
        await Promise.all(
          Array.from({ length: count }, (_, index) =>
            claimProjectRagJob(sql, `t09-load-worker-${token}-${index}`, 10)
          )
        )
      ).filter((job): job is NonNullable<typeof job> => job !== undefined);
      expect(claimed).toHaveLength(count);
      expect(new Set(claimed.map((job) => job.id)).size).toBe(count);
      await Promise.all(
        claimed.map((job) => finishProjectRagJob(sql, job.id, job.fenceToken, { load: true }))
      );
      expect(jobs.every((job) => job.status === 'queued')).toBe(true);
    } finally {
      await sql`delete from project_jobs where dedupe_key like ${`t09-load-${token}-%`}`;
      await closeProjectRagPostgresSql(databaseUrl);
    }
  });

  it('starts two independent MCP processes with the same read-only toolset', async () => {
    const baseEnv = {
      ...process.env,
      PROJECT_RAG_T09_DATABASE_URL: databaseUrl ?? '',
      PROJECT_RAG_DATABASE_URL: databaseUrl ?? '',
      MCP_PERMISSION_MODE: 'read_only',
      RAG_PROJECT_SESSION_INTENT: 'read_only',
      RAG_PROJECT_WATCHER_ENABLED: 'false',
      MCP_TOOLSET: 'projects',
    };
    const sessions = await Promise.all(
      [0, 1].map(async (workerId) => {
        const transport = new StdioClientTransport({
          command: 'bun',
          args: ['mcp/launcher.ts'],
          cwd: process.cwd(),
          env: baseEnv,
        });
        const client = new Client(
          { name: `t09-mcp-${workerId}`, version: '1.0.0' },
          { capabilities: {} }
        );
        await client.connect(transport, { timeout: 30_000 });
        const listed = await client.listTools();
        await client.close();
        await transport.close();
        return listed.tools.map((tool) => tool.name).sort();
      })
    );
    expect(sessions[0]).toEqual(sessions[1]);
    expect(sessions[0]).not.toContain('ingest_project');
    expect(sessions[0]).not.toContain('register_project');
  });
});
