import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUN_RUNTIME_UNIT_FILES,
  buildReleaseGateMatrix,
  evaluateGatePrerequisites,
  isDisposableLoopbackDatabaseUrl,
  parseMatrixArgs,
  releaseGateMatrixPassed,
  runReleaseGateMatrix,
  summarizeReleaseGateResults,
} from './release-gate-matrix.js';

const ISOLATED_ENV: NodeJS.ProcessEnv = {
  RAG_T18_ISOLATED: '1',
  RAG_T18_PROJECT_ID: 't18-project',
  PROJECT_RAG_DATABASE_URL: 'postgres://postgres@127.0.0.1:6543/rag_v2_migration_t18_project',
  DOCS_RAG_PG_LAB_DATABASE_URL: 'postgres://postgres@127.0.0.1:6544/rag_v2_migration_t18_docs',
  RAG_MIGRATION_INTEGRATION_DATABASE_URL:
    'postgres://postgres@127.0.0.1:6545/rag_v2_migration_t18_migrations',
  PROJECT_RAG_T09_DATABASE_URL: 'postgres://postgres@127.0.0.1:6546/rag_v2_migration_t18_t09',
};

describe('release gate matrix', () => {
  it('makes the snapshot Postgres suite fail closed without an explicit disposable URL', () => {
    const source = readFileSync(
      new URL('../project-rag/snapshot-gate.postgres.integration.test.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain('assertDisposableSnapshotGateTarget(databaseUrl)');
    expect(source).not.toContain("process.env.PROJECT_RAG_ALLOW_LOCAL_DEFAULT = '1'");

    const packageJson = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    expect(packageJson).not.toContain(
      'test:project-rag:snapshot-gate:real": "PROJECT_RAG_REAL_DB_TEST=1 PROJECT_RAG_ALLOW_LOCAL_DEFAULT=1'
    );
  });

  it('contains the required lanes and ten-fold critical repetition', () => {
    const gates = buildReleaseGateMatrix();
    const ids = new Set(gates.map((gate) => gate.id));

    for (const id of [
      'migration-fresh-upgrade',
      'dependency-audit',
      'secret-history',
      'release-hygiene',
      'docs-postgres',
      'project-postgres',
      'project-t09-real',
      'mcp-stdio-concurrency',
      'cli-project-verify',
      'cli-project-search',
      'migration-fault-recovery',
      'project-fault-recovery',
      'worker-recovery',
    ]) {
      expect(ids.has(id)).toBe(true);
    }

    expect(gates.find((gate) => gate.id === 'mcp-stdio-concurrency')?.repeat).toBe(10);
    expect(
      gates.find((gate) => gate.id === 'mcp-stdio-concurrency')?.commands(ISOLATED_ENV)[0]?.args
    ).toEqual(expect.arrayContaining(['--p95-threshold-ms', '6000']));
    expect(gates.find((gate) => gate.id === 'project-fault-recovery')?.repeat).toBe(10);
  });

  it('scopes the secret-history scan to the exact candidate HEAD', () => {
    const gate = buildReleaseGateMatrix().find((entry) => entry.id === 'secret-history');
    if (!gate) throw new Error('secret history gate missing');

    const commands = gate.commands(ISOLATED_ENV);
    expect(commands[0]).toEqual({
      executable: 'git',
      args: ['rev-parse', '--verify', 'HEAD'],
      display: 'git rev-parse --verify HEAD',
    });
    expect(commands[1]).toMatchObject({ executable: 'gitleaks' });
    expect(commands[1]?.args).toEqual([
      'git',
      '.',
      '--redact',
      '--no-banner',
      '--no-color',
      '--log-opts=HEAD',
    ]);
  });

  it('requires explicit isolated resources and rejects official targets', () => {
    const projectGate = buildReleaseGateMatrix().find(
      (gate) => gate.id === 'mcp-stdio-concurrency'
    );
    if (!projectGate) throw new Error('mcp gate missing');

    expect(
      evaluateGatePrerequisites(projectGate, { ...ISOLATED_ENV, RAG_T18_ISOLATED: '0' })
    ).toEqual(expect.objectContaining({ status: 'blocked' }));
    expect(
      evaluateGatePrerequisites(projectGate, {
        ...ISOLATED_ENV,
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/docs_rag_lab',
      }).status
    ).toBe('blocked');
    expect(isDisposableLoopbackDatabaseUrl(ISOLATED_ENV.PROJECT_RAG_DATABASE_URL)).toBe(true);
    expect(isDisposableLoopbackDatabaseUrl('postgres://127.0.0.1:5542/docs_rag_lab')).toBe(false);

    const projectPostgresGate = buildReleaseGateMatrix().find(
      (gate) => gate.id === 'project-postgres'
    );
    if (!projectPostgresGate) throw new Error('project Postgres gate missing');
    expect(
      evaluateGatePrerequisites(projectPostgresGate, {
        ...ISOLATED_ENV,
        PROJECT_RAG_DATABASE_URL: undefined,
      }).status
    ).toBe('blocked');

    const t09Gate = buildReleaseGateMatrix().find((gate) => gate.id === 'project-t09-real');
    if (!t09Gate) throw new Error('T-09 real gate missing');
    expect(t09Gate.requiredEnv).toEqual(['PROJECT_RAG_T09_DATABASE_URL']);
    expect(evaluateGatePrerequisites(t09Gate, ISOLATED_ENV).status).toBe('ready');
    expect(
      evaluateGatePrerequisites(t09Gate, {
        ...ISOLATED_ENV,
        PROJECT_RAG_T09_DATABASE_URL: undefined,
      }).status
    ).toBe('blocked');
  });

  it('classifies the external-provider gate instead of silently passing it', () => {
    const gate = buildReleaseGateMatrix().find((entry) => entry.id === 'mcp-codex-stdio');
    if (!gate) throw new Error('Codex MCP gate missing');

    expect(evaluateGatePrerequisites(gate, ISOLATED_ENV).status).toBe('skipped');
    expect(
      evaluateGatePrerequisites(gate, { ...ISOLATED_ENV, RAG_T18_ALLOW_EXTERNAL: '1' }).status
    ).toBe('ready');
  });

  it('makes release-required skips ineligible and keeps optional skips diagnostic-only', () => {
    const base = {
      id: 'gate',
      attempts: 0,
      requiredRepeats: 1,
      reasons: [],
      commands: [],
    } as const;

    const diagnosticSkip = [
      { ...base, status: 'skipped' as const, skipClass: 'diagnostic-optional' as const },
    ];
    const requiredSkip = [
      { ...base, status: 'skipped' as const, skipClass: 'release-required' as const },
    ];

    expect(releaseGateMatrixPassed(diagnosticSkip)).toBe(true);
    expect(summarizeReleaseGateResults(diagnosticSkip)).toMatchObject({
      overall: 'passed',
      overallPass: true,
      releaseEligible: true,
      fullCoverage: true,
      counts: { total: 1, skipped: 1, diagnosticOptionalSkipped: 1, releaseRequiredSkipped: 0 },
    });
    expect(releaseGateMatrixPassed(requiredSkip)).toBe(false);
    expect(summarizeReleaseGateResults(requiredSkip)).toMatchObject({
      overall: 'failed',
      overallPass: false,
      releaseEligible: false,
      counts: { total: 1, skipped: 1, diagnosticOptionalSkipped: 0, releaseRequiredSkipped: 1 },
    });
    expect(
      releaseGateMatrixPassed([{ ...base, status: 'passed', skipClass: 'release-required' }])
    ).toBe(true);
    expect(
      releaseGateMatrixPassed([{ ...base, status: 'blocked', skipClass: 'release-required' }])
    ).toBe(false);
    expect(
      releaseGateMatrixPassed([{ ...base, status: 'failed', skipClass: 'release-required' }])
    ).toBe(false);
  });

  it('marks the external provider opt-out as release-required', () => {
    const gate = buildReleaseGateMatrix().find((entry) => entry.id === 'mcp-codex-stdio');
    expect(gate?.skipClass).toBe('release-required');
    expect(
      runReleaseGateMatrix({ mode: 'run', json: true, only: ['mcp-codex-stdio'] }, ISOLATED_ENV)[0]
    ).toMatchObject({ status: 'skipped', skipClass: 'release-required' });
  });

  it('reports a passing summary for all-pass results', () => {
    expect(
      summarizeReleaseGateResults([
        {
          id: 'gate',
          status: 'passed',
          skipClass: 'release-required',
          attempts: 1,
          requiredRepeats: 1,
          reasons: [],
          commands: [],
        },
      ])
    ).toEqual({
      overall: 'passed',
      overallPass: true,
      releaseEligible: true,
      fullCoverage: true,
      counts: {
        total: 1,
        ready: 0,
        passed: 1,
        failed: 0,
        blocked: 0,
        skipped: 0,
        releaseRequiredSkipped: 0,
        diagnosticOptionalSkipped: 0,
      },
    });
  });

  it('emits failed release JSON and counts for a required skip', () => {
    const env = { ...process.env, ...ISOLATED_ENV };
    delete env.RAG_T18_ALLOW_EXTERNAL;
    const result = spawnSync(
      'bun',
      [
        'run',
        'scripts/eval/release-gate-matrix.ts',
        '--run',
        '--json',
        '--only',
        'mcp-codex-stdio',
      ],
      { cwd: process.cwd(), env, encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'run',
      overall: 'failed',
      overallPass: false,
      releaseEligible: false,
      counts: {
        total: 1,
        skipped: 1,
        releaseRequiredSkipped: 1,
        diagnosticOptionalSkipped: 0,
      },
    });
  });

  it('marks a partial all-pass selection as diagnostic-only in release JSON', () => {
    const result = spawnSync(
      'bun',
      ['run', 'scripts/eval/release-gate-matrix.ts', '--run', '--json', '--only', 'static-diff'],
      { cwd: process.cwd(), env: process.env, encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'run',
      overall: 'failed',
      overallPass: false,
      releaseEligible: false,
      fullCoverage: false,
      counts: {
        total: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
        skipped: 0,
      },
    });
  });

  it('keeps local unit and self-contained integration gates independent of provider pretest', () => {
    const gates = buildReleaseGateMatrix();

    const unitCommands = gates
      .find((entry) => entry.id === 'unit-contract')
      ?.commands(ISOLATED_ENV);
    expect(unitCommands).toHaveLength(2);
    expect(unitCommands?.[0]?.display).toContain('bun x vitest run');
    expect(unitCommands?.[0]?.display).not.toContain('bun --bun x vitest run');
    expect(unitCommands?.[1]?.display).toContain('bun --bun x vitest run');
    for (const file of BUN_RUNTIME_UNIT_FILES) {
      expect(unitCommands?.[0]?.args).toContain(file);
      expect(unitCommands?.[1]?.args).toContain(file);
    }
    for (const command of unitCommands ?? []) {
      expect(command.args).toContain('--exclude');
      expect(command.args).toContain('.tmp/**');
    }

    for (const id of ['migration-fresh-upgrade', 'docs-postgres', 'project-postgres']) {
      const gate = gates.find((entry) => entry.id === id);
      expect(
        gate
          ?.commands(ISOLATED_ENV)
          .every(
            (command) =>
              command.display.includes('bun --bun x vitest run') &&
              command.args.includes('--exclude') &&
              command.args.includes('.tmp/**')
          )
      ).toBe(true);
    }

    expect(
      gates.find((entry) => entry.id === 'worker-recovery')?.commands(ISOLATED_ENV)[0]?.display
    ).toBe('bun --bun x vitest run scripts/project-rag/job-worker.test.ts --exclude ".tmp/**"');

    expect(gates.find((entry) => entry.id === 'docs-postgres')?.env).toMatchObject({
      CHUNK_SIZE: '1000',
      CHUNK_OVERLAP: '50',
    });

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.pretest).toBeUndefined();
    expect(packageJson.scripts.test).toBe('vitest run');
    expect(packageJson.scripts['health:embeddings:project']).toBe(
      'tsx scripts/check-embedding-health.ts --project-rag'
    );
    expect(packageJson.scripts.preeval).not.toContain('|| true');
    expect(packageJson.scripts['validate:release']).toBe('bun run gate:release');
  });

  it('supports a non-executing plan without starting live resources', () => {
    expect(parseMatrixArgs(['--plan', '--json'])).toEqual({ mode: 'plan', json: true, only: [] });
    const result = runReleaseGateMatrix(
      { mode: 'plan', json: true, only: ['mcp-stdio-concurrency'] },
      ISOLATED_ENV
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('ready');
    expect(result[0]?.attempts).toBe(0);
  });
});
