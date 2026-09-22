import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  getPackageProjectRegisterUsage,
  parsePackageProjectRegisterArgs,
  registerPackageProject,
} from './register-package.js';

vi.mock('./project-inventory.js', () => ({
  validateAllowlistAgainstRoot: vi.fn(),
}));

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'rag-v2-register-package-'));
const REPO_ROOT = join(TEST_ROOT, 'example-project');
mkdirSync(REPO_ROOT);
mkdirSync(join(REPO_ROOT, 'mcp'));
mkdirSync(join(REPO_ROOT, 'scripts'));
mkdirSync(join(REPO_ROOT, 'lib'));
const EXPECTED_DEFAULT_SLUG = 'example-project';

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// Shared mock for assertProjectRagPostgresAllowlistSchemaReady used by all tests.
const mockAssertAllowlistSchemaReady = vi.fn().mockResolvedValue(undefined);

describe('project-rag package register wrapper', () => {
  it('requires explicit root and project identity', () => {
    expect(
      parsePackageProjectRegisterArgs([
        '--project',
        'demo',
        '--root',
        '/tmp/repo',
        '--include',
        'src, docs',
        '--sync',
      ])
    ).toEqual({
      projectSlug: 'demo',
      name: undefined,
      rootPath: '/tmp/repo',
      includeRoots: ['src', 'docs'],
      sync: true,
      force: false,
      maxFiles: undefined,
      concurrency: undefined,
    });

    expect(() => parsePackageProjectRegisterArgs(['--include', 'src'])).toThrow(
      'Missing project root'
    );
    expect(() =>
      parsePackageProjectRegisterArgs(['--root', '/tmp/repo', '--include', 'src'])
    ).toThrow('Missing project identity');
  });

  it('rejects unsupported legacy flags and sync-only ingest flags clearly', () => {
    expect(() =>
      parsePackageProjectRegisterArgs(['--project', 'demo', '--include', 'src'])
    ).toThrow('Missing project root');
    expect(() =>
      parsePackageProjectRegisterArgs([
        '--root',
        '/tmp/repo',
        '--include',
        'src',
        '--add-include',
        'docs',
      ])
    ).toThrow('does not support incremental scope mutation flags');
    expect(() =>
      parsePackageProjectRegisterArgs([
        '--project',
        'demo',
        '--root',
        '/tmp/repo',
        '--include',
        'src',
        '--force',
      ])
    ).toThrow('require --sync');
  });

  it('throws on missing snapshotGate when --sync is used', async () => {
    const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
    const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(29);
    const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

    const ingestProjectRagPostgres = vi.fn().mockResolvedValue({
      projectId: 'demo',
      slug: 'demo',
      postgresId: 29,
      finalStatus: 'completed',
      stats: {
        filesScanned: 1,
        filesSelected: 1,
        filesIndexed: 1,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 2,
        embeddingsCreated: 2,
        errors: [],
      },
      // snapshotGate is intentionally omitted (undefined)
    });

    const existingDir = process.cwd();

    await expect(
      registerPackageProject(
        {
          rootPath: existingDir,
          includeRoots: ['scripts'],
          name: 'Demo',
          sync: true,
          force: false,
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: vi.fn().mockResolvedValue(undefined) as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: ingestProjectRagPostgres as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      )
    ).rejects.toThrow(/snapshot gate is missing/);

    expect(upsertProjectRagPostgresRepository).toHaveBeenCalled();
    expect(ingestProjectRagPostgres).toHaveBeenCalled();
  });

  it('throws on snapshot gate refusal when --sync is used', async () => {
    const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
    const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(29);
    const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

    const ingestProjectRagPostgres = vi.fn().mockResolvedValue({
      projectId: 'demo',
      slug: 'demo',
      postgresId: 29,
      finalStatus: 'partial',
      stats: {
        filesScanned: 500,
        filesSelected: 0,
        filesIndexed: 0,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 0,
        embeddingsCreated: 0,
        errors: [],
      },
      snapshotGate: {
        snapshotUuid: '00000000-0000-0000-0000-000000000098',
        status: 'REVIEW_REQUIRED',
        thresholdResult: 'delta_500: total delta 500 >= 500 file threshold',
        preflightSummary: {
          addsCount: 300,
          updatesCount: 150,
          deletesCount: 50,
          eligibleCount: 500,
          trackedCount: 100,
          totalDelta: 500,
          blockedFindingCategories: '',
        },
      },
    });

    // Use an existing directory to avoid realpath ENOENT and valid include roots
    const existingDir = process.cwd();

    await expect(
      registerPackageProject(
        {
          rootPath: existingDir,
          includeRoots: ['scripts'],
          name: 'Demo',
          sync: true,
          force: false,
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: vi.fn().mockResolvedValue(undefined) as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: ingestProjectRagPostgres as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      )
    ).rejects.toThrow(/snapshot gate status is REVIEW_REQUIRED/);

    expect(upsertProjectRagPostgresRepository).toHaveBeenCalled();
    expect(ingestProjectRagPostgres).toHaveBeenCalled();
  });

  it('exposes help text for the Postgres package wrapper', () => {
    expect(parsePackageProjectRegisterArgs(['--help'])).toEqual({ help: true });
    expect(getPackageProjectRegisterUsage()).toContain(
      'Without --sync, this only upserts project_repositories in Postgres.'
    );
  });

  it('upserts only the repository row when sync is omitted', async () => {
    const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
    const findProjectRagPostgresProject = vi.fn().mockResolvedValue({
      name: 'Existing Demo',
      rootPath: REPO_ROOT,
      normalizedRootPath: REPO_ROOT,
    });
    const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(17);
    const ingestProjectRagPostgres = vi.fn();
    const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

    const result = await registerPackageProject(
      {
        rootPath: REPO_ROOT,
        includeRoots: ['scripts'],
        sync: false,
        force: false,
      },
      {
        resolveProjectRagPostgresWriteConfig: () =>
          ({
            tool: 'project-rag-postgres',
            healthTimeoutMs: 5_000,
            database: { url: 'postgres://local/test' },
          }) as never,
        closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
        createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
        findProjectRagPostgresProject: findProjectRagPostgresProject as never,
        findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
        upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
        ingestProjectRagPostgres: ingestProjectRagPostgres as never,
        assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
      }
    );

    expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        name: 'Existing Demo',
        slug: EXPECTED_DEFAULT_SLUG,
        rootPath: REPO_ROOT,
        normalizedRootPath: REPO_ROOT,
        includeRoots: ['scripts'],
      })
    );
    expect(ingestProjectRagPostgres).not.toHaveBeenCalled();
    expect(closeProjectRagPostgresSql).toHaveBeenCalledWith('postgres://local/test');
    expect(result).toEqual({
      mode: 'register',
      projectId: 17,
      slug: EXPECTED_DEFAULT_SLUG,
      name: 'Existing Demo',
      rootPath: REPO_ROOT,
      includeRoots: ['scripts'],
    });
  });

  it('keeps same-basename registrations distinct when explicit project identities differ', async () => {
    const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
    const upsertProjectRagPostgresRepository = vi
      .fn()
      .mockResolvedValueOnce(17)
      .mockResolvedValueOnce(18);
    const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };
    const deps = {
      resolveProjectRagPostgresWriteConfig: () =>
        ({
          tool: 'project-rag-postgres',
          healthTimeoutMs: 5_000,
          database: { url: 'postgres://local/test' },
        }) as never,
      closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
      createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
      findProjectRagPostgresProject: vi.fn().mockResolvedValue(undefined) as never,
      findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
      upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
      ingestProjectRagPostgres: vi.fn() as never,
      assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
    };

    await registerPackageProject(
      {
        projectSlug: 'workspace-a-repo',
        rootPath: REPO_ROOT,
        includeRoots: ['scripts'],
        sync: false,
        force: false,
      },
      deps
    );
    await registerPackageProject(
      {
        projectSlug: 'workspace-b-repo',
        rootPath: REPO_ROOT,
        includeRoots: ['scripts'],
        sync: false,
        force: false,
      },
      deps
    );

    expect(upsertProjectRagPostgresRepository).toHaveBeenNthCalledWith(
      1,
      sql,
      expect.objectContaining({ slug: 'workspace-a-repo' })
    );
    expect(upsertProjectRagPostgresRepository).toHaveBeenNthCalledWith(
      2,
      sql,
      expect.objectContaining({ slug: 'workspace-b-repo' })
    );
  });

  it('registers first and then routes sync through Postgres ingest', async () => {
    const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
    const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(29);
    const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };
    const ingestProjectRagPostgres = vi.fn().mockResolvedValue({
      projectId: 'demo',
      slug: 'demo',
      postgresId: 29,
      finalStatus: 'completed',
      stats: {
        filesScanned: 1,
        filesSelected: 1,
        filesIndexed: 1,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 2,
        embeddingsCreated: 2,
        errors: [],
      },
      snapshotGate: {
        snapshotUuid: '00000000-0000-0000-0000-000000000099',
        status: 'CONSUMED',
        thresholdResult: 'delta_safe: write phase completed',
        preflightSummary: {
          addsCount: 1,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 1,
          trackedCount: 10,
          totalDelta: 1,
          blockedFindingCategories: '',
        },
      },
    });

    const result = await registerPackageProject(
      {
        rootPath: REPO_ROOT,
        includeRoots: ['scripts'],
        name: 'Custom Demo',
        sync: true,
        force: true,
        maxFiles: 25,
        concurrency: 3,
      },
      {
        resolveProjectRagPostgresWriteConfig: () =>
          ({
            tool: 'project-rag-postgres',
            healthTimeoutMs: 5_000,
            database: { url: 'postgres://local/test' },
          }) as never,
        closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
        createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
        findProjectRagPostgresProject: vi.fn().mockResolvedValue(undefined) as never,
        findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
        upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
        ingestProjectRagPostgres: ingestProjectRagPostgres as never,
        assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
      }
    );

    expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        name: 'Custom Demo',
        slug: EXPECTED_DEFAULT_SLUG,
        includeRoots: ['scripts'],
      })
    );
    expect(ingestProjectRagPostgres).toHaveBeenCalledWith({
      projectSlug: EXPECTED_DEFAULT_SLUG,
      rootPath: REPO_ROOT,
      includeRoots: ['scripts'],
      force: true,
      maxFiles: 25,
      concurrency: 3,
    });
    expect(closeProjectRagPostgresSql).toHaveBeenCalledWith('postgres://local/test');
    expect(result).toEqual({
      mode: 'sync',
      registration: {
        projectId: 29,
        slug: EXPECTED_DEFAULT_SLUG,
        name: 'Custom Demo',
        rootPath: REPO_ROOT,
        includeRoots: ['scripts'],
      },
      ingestion: {
        projectId: 'demo',
        slug: 'demo',
        postgresId: 29,
        finalStatus: 'completed',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 1,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 2,
          embeddingsCreated: 2,
          errors: [],
        },
        snapshotGate: {
          snapshotUuid: '00000000-0000-0000-0000-000000000099',
          status: 'CONSUMED',
          thresholdResult: 'delta_safe: write phase completed',
          preflightSummary: {
            addsCount: 1,
            updatesCount: 0,
            deletesCount: 0,
            eligibleCount: 1,
            trackedCount: 10,
            totalDelta: 1,
            blockedFindingCategories: '',
          },
        },
      },
    });
  });

  describe('--replace-blocked-finding-allowlist CLI flag', () => {
    it('accepts valid JSON array for replacement', () => {
      const parsed = parsePackageProjectRegisterArgs([
        '--project',
        'demo',
        '--root',
        '/tmp/repo',
        '--include',
        'src',
        '--replace-blocked-finding-allowlist',
        '[{"relativePath":"vendor/dep1","category":"dependency_dir"}]',
      ]);

      expect(parsed).not.toHaveProperty('help');
      if (!('help' in parsed)) {
        expect(parsed.replaceBlockedFindingAllowlist).toEqual([
          { relativePath: 'vendor/dep1', category: 'dependency_dir' },
        ]);
      }
    });

    it('accepts empty array for clearing', () => {
      const parsed = parsePackageProjectRegisterArgs([
        '--project',
        'demo',
        '--root',
        '/tmp/repo',
        '--include',
        'src',
        '--replace-blocked-finding-allowlist',
        '[]',
      ]);

      if (!('help' in parsed)) {
        expect(parsed.replaceBlockedFindingAllowlist).toEqual([]);
      }
    });

    it('rejects non-JSON value', () => {
      expect(() =>
        parsePackageProjectRegisterArgs([
          '--root',
          '/tmp/repo',
          '--include',
          'src',
          '--replace-blocked-finding-allowlist',
          'not-json',
        ])
      ).toThrow('not valid JSON');
    });

    it('rejects non-array JSON value', () => {
      expect(() =>
        parsePackageProjectRegisterArgs([
          '--root',
          '/tmp/repo',
          '--include',
          'src',
          '--replace-blocked-finding-allowlist',
          '{"key":"value"}',
        ])
      ).toThrow('non-array');
    });

    it('rejects entries with missing fields', () => {
      expect(() =>
        parsePackageProjectRegisterArgs([
          '--root',
          '/tmp/repo',
          '--include',
          'src',
          '--replace-blocked-finding-allowlist',
          '[{"relativePath":"vendor/dep1"}]',
        ])
      ).toThrow('has unexpected keys');
    });

    it('rejects missing value for flag', () => {
      expect(() =>
        parsePackageProjectRegisterArgs([
          '--root',
          '/tmp/repo',
          '--include',
          'src',
          '--replace-blocked-finding-allowlist',
        ])
      ).toThrow('requires a JSON array value');
    });

    it('help text mentions the new flag', () => {
      const help = getPackageProjectRegisterUsage();
      expect(help).toContain('--replace-blocked-finding-allowlist');
      expect(help).toContain('dependency_dir');
    });
  });

  describe('CLI scope preservation', () => {
    it('preserves existing includeRoots and ignoreRules on re-registration', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue({
        name: 'Existing Project',
        rootPath: REPO_ROOT,
        normalizedRootPath: REPO_ROOT,
        includeRoots: ['mcp', 'scripts', 'docs'],
        ignoreRules: ['*.generated.*'],
      });
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(17);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

      await registerPackageProject(
        {
          rootPath: REPO_ROOT,
          includeRoots: ['scripts'], // narrower than persisted
          sync: false,
          force: false,
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: findProjectRagPostgresProject as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: vi.fn() as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      );

      // Must use preserved roots and ignoreRules, not request roots
      expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({
          includeRoots: ['mcp', 'scripts', 'docs'],
          ignoreRules: ['*.generated.*'],
        })
      );
    });

    it('falls back to request includeRoots when existing project has empty includeRoots', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue({
        name: 'Empty Roots',
        rootPath: REPO_ROOT,
        normalizedRootPath: REPO_ROOT,
        includeRoots: [],
        ignoreRules: [],
      });
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(17);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

      await registerPackageProject(
        {
          rootPath: REPO_ROOT,
          includeRoots: ['scripts', 'mcp'],
          sync: false,
          force: false,
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: findProjectRagPostgresProject as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: vi.fn() as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      );

      expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({ includeRoots: ['scripts', 'mcp'] })
      );
    });

    it('returns preserved includeRoots in registration result', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue({
        name: 'Preserved',
        rootPath: REPO_ROOT,
        normalizedRootPath: REPO_ROOT,
        includeRoots: ['mcp', 'scripts', 'docs'],
      });
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(17);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

      const result = await registerPackageProject(
        {
          rootPath: REPO_ROOT,
          includeRoots: ['scripts'], // narrower, will be overridden
          sync: false,
          force: false,
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: findProjectRagPostgresProject as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: vi.fn() as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      );

      // Result must reflect preserved roots, not request roots
      expect(result).toMatchObject({
        mode: 'register',
        includeRoots: ['mcp', 'scripts', 'docs'],
      });
    });

    it('validates allowlist against persisted includeRoots', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue({
        name: 'Existing',
        rootPath: REPO_ROOT,
        normalizedRootPath: REPO_ROOT,
        includeRoots: ['mcp', 'scripts'],
        ignoreRules: [],
      });
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(17);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

      // Entry 'scripts/project-rag' is valid against ['mcp', 'scripts'] but NOT against request ['lib']
      await registerPackageProject(
        {
          rootPath: REPO_ROOT,
          includeRoots: ['lib'], // narrower, but preserved roots are used
          sync: false,
          force: false,
          replaceBlockedFindingAllowlist: [
            { relativePath: 'scripts/project-rag', category: 'test_fixture' },
          ],
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: findProjectRagPostgresProject as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: vi.fn() as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      );

      expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({
          includeRoots: ['mcp', 'scripts'],
          blockedFindingAllowlist: [
            { relativePath: 'scripts/project-rag', category: 'test_fixture' },
          ],
        })
      );
    });
  });

  describe('CLI error handling', () => {
    it('emits safe message on policy-race (CONSUMING snapshot)', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue({
        name: 'Locked',
        rootPath: REPO_ROOT,
        normalizedRootPath: REPO_ROOT,
        includeRoots: ['scripts'],
      });
      const upsertProjectRagPostgresRepository = vi
        .fn()
        .mockRejectedValue(
          new Error(
            'cannot modify include_roots, ignore_rules, or blocked_finding_allowlist while a CONSUMING ingest snapshot exists'
          )
        );
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

      await expect(
        registerPackageProject(
          {
            rootPath: REPO_ROOT,
            includeRoots: ['scripts'],
            sync: false,
            force: false,
          },
          {
            resolveProjectRagPostgresWriteConfig: () =>
              ({
                tool: 'project-rag-postgres',
                healthTimeoutMs: 5_000,
                database: { url: 'postgres://local/test' },
              }) as never,
            closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
            createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
            findProjectRagPostgresProject: findProjectRagPostgresProject as never,
            findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
            upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
            ingestProjectRagPostgres: vi.fn() as never,
            assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
          }
        )
      ).rejects.toThrow('Project configuration is locked');

      expect(closeProjectRagPostgresSql).toHaveBeenCalled();
    });

    it('emits actionable error when migration 004 schema is not ready', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue(undefined);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };
      const schemaErrorMock = vi
        .fn()
        .mockRejectedValue(
          new Error('Project RAG snapshot schema is missing migration-004 column')
        );

      await expect(
        registerPackageProject(
          {
            rootPath: REPO_ROOT,
            includeRoots: ['scripts'],
            sync: false,
            force: false,
          },
          {
            resolveProjectRagPostgresWriteConfig: () =>
              ({
                tool: 'project-rag-postgres',
                healthTimeoutMs: 5_000,
                database: { url: 'postgres://local/test' },
              }) as never,
            closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
            createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
            findProjectRagPostgresProject: findProjectRagPostgresProject as never,
            findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
            upsertProjectRagPostgresRepository: vi.fn() as never,
            ingestProjectRagPostgres: vi.fn() as never,
            assertProjectRagPostgresAllowlistSchemaReady: schemaErrorMock as never,
          }
        )
      ).rejects.toThrow(/migration 004/);

      expect(schemaErrorMock).toHaveBeenCalledWith(sql);
    });

    it('preserves --sync unchanged and still forwards to ingestion', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue(undefined);
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(42);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };
      const ingestProjectRagPostgres = vi.fn().mockResolvedValue({
        projectId: 'demo',
        slug: 'demo',
        postgresId: 42,
        finalStatus: 'completed',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 1,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 2,
          embeddingsCreated: 2,
          errors: [],
        },
        snapshotGate: {
          snapshotUuid: '00000000-0000-0000-0000-000000000099',
          status: 'CONSUMED',
          thresholdResult: 'delta_safe: write phase completed',
          preflightSummary: {
            addsCount: 1,
            updatesCount: 0,
            deletesCount: 0,
            eligibleCount: 1,
            trackedCount: 10,
            totalDelta: 1,
            blockedFindingCategories: '',
          },
        },
      });

      const result = await registerPackageProject(
        {
          rootPath: REPO_ROOT,
          includeRoots: ['scripts'],
          name: 'Sync Test',
          sync: true,
          force: false,
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: findProjectRagPostgresProject as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: ingestProjectRagPostgres as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      );

      expect(result).toMatchObject({
        mode: 'sync',
        registration: expect.objectContaining({
          projectId: 42,
          includeRoots: ['scripts'],
        }),
      });
      expect(ingestProjectRagPostgres).toHaveBeenCalledWith({
        projectSlug: EXPECTED_DEFAULT_SLUG,
        rootPath: REPO_ROOT,
        includeRoots: ['scripts'],
        force: false,
        maxFiles: undefined,
        concurrency: undefined,
      });
    });

    it('clears allowlist on empty replacement (CLI)', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue(undefined);
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(42);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

      await registerPackageProject(
        {
          rootPath: REPO_ROOT,
          includeRoots: ['scripts'],
          sync: false,
          force: false,
          replaceBlockedFindingAllowlist: [],
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: findProjectRagPostgresProject as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: vi.fn() as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      );

      expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({ blockedFindingAllowlist: [] })
      );
    });

    it('forwards nonempty allowlist on replacement (CLI)', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue(undefined);
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(42);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

      await registerPackageProject(
        {
          rootPath: REPO_ROOT,
          includeRoots: ['scripts'],
          sync: false,
          force: false,
          replaceBlockedFindingAllowlist: [
            { relativePath: 'scripts/project-rag', category: 'test_fixture' },
          ],
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: findProjectRagPostgresProject as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: vi.fn() as never,
          assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
        }
      );

      expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({
          blockedFindingAllowlist: [
            { relativePath: 'scripts/project-rag', category: 'test_fixture' },
          ],
        })
      );
    });
  });

  describe('T-04 slice3: root identity, --sync preserved roots, CLI parser strict', () => {
    it('--sync passes registeredIncludeRoots (preserved) to ingestProjectRagPostgres, not request roots', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue({
        name: 'Existing Wide',
        rootPath: REPO_ROOT,
        normalizedRootPath: REPO_ROOT,
        includeRoots: ['mcp', 'scripts', 'docs'],
        ignoreRules: ['*.generated.*'],
      });
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(42);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };
      const ingestProjectRagPostgres = vi.fn().mockResolvedValue({
        projectId: 'demo',
        slug: 'demo',
        postgresId: 42,
        finalStatus: 'completed',
        stats: {
          filesScanned: 1,
          filesSelected: 1,
          filesIndexed: 1,
          filesBlocked: 0,
          filesDeleted: 0,
          chunksCreated: 2,
          embeddingsCreated: 2,
          errors: [],
        },
        snapshotGate: {
          snapshotUuid: '00000000-0000-0000-0000-000000000099',
          status: 'CONSUMED',
          thresholdResult: 'delta_safe: write phase completed',
          preflightSummary: {
            addsCount: 1,
            updatesCount: 0,
            deletesCount: 0,
            eligibleCount: 1,
            trackedCount: 10,
            totalDelta: 1,
            blockedFindingCategories: '',
          },
        },
      });

      const result = await registerPackageProject(
        {
          rootPath: REPO_ROOT,
          includeRoots: ['scripts'], // narrower than persisted
          name: 'Sync Preserved',
          sync: true,
          force: false,
        },
        {
          resolveProjectRagPostgresWriteConfig: () =>
            ({
              tool: 'project-rag-postgres',
              healthTimeoutMs: 5_000,
              database: { url: 'postgres://local/test' },
            }) as never,
          closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
          createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
          findProjectRagPostgresProject: findProjectRagPostgresProject as never,
          findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
          upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
          ingestProjectRagPostgres: ingestProjectRagPostgres as never,
          assertProjectRagPostgresAllowlistSchemaReady: vi
            .fn()
            .mockResolvedValue(undefined) as never,
        }
      );

      // Upsert gets preserved roots
      expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({ includeRoots: ['mcp', 'scripts', 'docs'] })
      );
      // Ingestion MUST also get preserved roots, not request ['scripts']
      expect(ingestProjectRagPostgres).toHaveBeenCalledWith({
        projectSlug: EXPECTED_DEFAULT_SLUG,
        rootPath: REPO_ROOT,
        includeRoots: ['mcp', 'scripts', 'docs'],
        force: false,
        maxFiles: undefined,
        concurrency: undefined,
      });
      // Registration result also reports preserved roots
      expect(result).toMatchObject({
        mode: 'sync',
        registration: { includeRoots: ['mcp', 'scripts', 'docs'] },
      });
    });

    it('rejects PROJECT_ROOT_MISMATCH when existing project root differs', async () => {
      const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
      // Create temp dir with src subdir so include root validation passes
      const testRoot = mkdtempSync('/tmp/rag-mismatch-');
      mkdirSync(join(testRoot, 'src'), { recursive: true });
      const findProjectRagPostgresProject = vi.fn().mockResolvedValue({
        name: 'Existing',
        includeRoots: ['src'],
        rootPath: join(testRoot, 'other/path'),
        normalizedRootPath: join(testRoot, 'other/path'),
      });
      const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(42);
      const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

      await expect(
        registerPackageProject(
          {
            rootPath: testRoot, // differs from testRoot/other/path
            includeRoots: ['src'],
            sync: false,
            force: false,
          },
          {
            resolveProjectRagPostgresWriteConfig: () =>
              ({
                tool: 'project-rag-postgres',
                healthTimeoutMs: 5_000,
                database: { url: 'postgres://local/test' },
              }) as never,
            closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
            createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
            findProjectRagPostgresProject: findProjectRagPostgresProject as never,
            findProjectRagPostgresProjectByRootPath: vi.fn().mockResolvedValue(undefined) as never,
            upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
            ingestProjectRagPostgres: vi.fn() as never,
            assertProjectRagPostgresAllowlistSchemaReady: vi
              .fn()
              .mockResolvedValue(undefined) as never,
          }
        )
      ).rejects.toThrow('PROJECT_ROOT_MISMATCH');

      expect(upsertProjectRagPostgresRepository).not.toHaveBeenCalled();
    });

    it('CLI parser hoists max32 check before entry validation loop', async () => {
      // 33 entries should fail the max32 check, regardless of entry content
      const entries = Array.from({ length: 33 }, (_, i) => ({
        relativePath: `path${i}`,
        category: 'dependency_dir',
      }));
      expect(() =>
        parsePackageProjectRegisterArgs([
          '--root',
          '/tmp/repo',
          '--include',
          'src',
          '--replace-blocked-finding-allowlist',
          JSON.stringify(entries),
        ])
      ).toThrow('max 32');
    });

    it('CLI parser rejects entries with extra keys', async () => {
      expect(() =>
        parsePackageProjectRegisterArgs([
          '--root',
          '/tmp/repo',
          '--include',
          'src',
          '--replace-blocked-finding-allowlist',
          '[{"relativePath":"vendor/dep1","category":"dependency_dir","extraKey":"nope"}]',
        ])
      ).toThrow('unexpected keys');
    });

    it('CLI parser rejects entries with typos in keys', async () => {
      expect(() =>
        parsePackageProjectRegisterArgs([
          '--root',
          '/tmp/repo',
          '--include',
          'src',
          '--replace-blocked-finding-allowlist',
          '[{"relativePath":"vendor/dep1","categor":"typo"}]',
        ])
      ).toThrow('unexpected keys');
    });
  });

  it('reuses the root-registered project identity when no explicit slug is given', async () => {
    const closeProjectRagPostgresSql = vi.fn().mockResolvedValue(undefined);
    // ByRoot resolver returns a project that was previously registered at this root
    // with a custom slug (not the basename-derived slug).
    const findProjectRagPostgresProjectByRootPath = vi.fn().mockResolvedValue({
      name: 'Custom Registered',
      slug: 'custom-registered-name',
      rootPath: REPO_ROOT,
      normalizedRootPath: REPO_ROOT,
      includeRoots: ['scripts'],
    } as never);
    const upsertProjectRagPostgresRepository = vi.fn().mockResolvedValue(17);
    const ingestProjectRagPostgres = vi.fn();
    const sql = { sql: true, close: vi.fn().mockResolvedValue(undefined) };

    await registerPackageProject(
      {
        rootPath: REPO_ROOT,
        includeRoots: ['scripts'],
        sync: false,
        force: false,
      },
      {
        resolveProjectRagPostgresWriteConfig: () =>
          ({
            tool: 'project-rag-postgres',
            healthTimeoutMs: 5_000,
            database: { url: 'postgres://local/test' },
          }) as never,
        closeProjectRagPostgresSql: closeProjectRagPostgresSql as never,
        createProjectRagPostgresSql: vi.fn().mockReturnValue(sql) as never,
        findProjectRagPostgresProject: vi.fn().mockResolvedValue(undefined) as never,
        findProjectRagPostgresProjectByRootPath: findProjectRagPostgresProjectByRootPath as never,
        upsertProjectRagPostgresRepository: upsertProjectRagPostgresRepository as never,
        ingestProjectRagPostgres: ingestProjectRagPostgres as never,
        assertProjectRagPostgresAllowlistSchemaReady: mockAssertAllowlistSchemaReady as never,
      }
    );

    // Identity follows the registered root, not a basename-derived fork.
    expect(upsertProjectRagPostgresRepository).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({ slug: 'custom-registered-name' })
    );
    expect(ingestProjectRagPostgres).not.toHaveBeenCalled();
    expect(closeProjectRagPostgresSql).toHaveBeenCalledWith('postgres://local/test');
  });
});
