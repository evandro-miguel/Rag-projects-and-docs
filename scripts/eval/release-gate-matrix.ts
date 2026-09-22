/**
 * Executable release gate matrix for isolated development resources.
 *
 * The matrix is intentionally an orchestrator over existing suites.  It does
 * not create a second test framework, and it refuses live gates without an
 * explicit isolation marker and disposable loopback database identities.
 */
import { spawnSync } from 'node:child_process';
import { redactCredentialText } from '../../lib/shared/credential-redact.js';
import { MCP_CONCURRENCY_P95_THRESHOLDS } from './thresholds.js';

export type GateStatus = 'ready' | 'blocked' | 'skipped' | 'passed' | 'failed';
export type GateIsolation = 'none' | 'self-provisioned' | 'loopback-database' | 'loopback-project';
export type GateSkipClass = 'release-required' | 'diagnostic-optional';
export type ReleaseGateVerdict = 'passed' | 'failed';

export interface GateCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly display: string;
}

export interface ReleaseGate {
  readonly id: string;
  readonly lane: string;
  readonly description: string;
  readonly isolation: GateIsolation;
  readonly requiredEnv: readonly string[];
  readonly urlEnv: readonly string[];
  readonly repeat: number;
  readonly external: boolean;
  readonly skipClass: GateSkipClass;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly commands: (env: NodeJS.ProcessEnv) => readonly GateCommand[];
}

export interface GatePrerequisites {
  readonly status: 'ready' | 'blocked' | 'skipped';
  readonly reasons: readonly string[];
}

export interface GateResult {
  readonly id: string;
  readonly status: GateStatus;
  readonly skipClass: GateSkipClass;
  readonly attempts: number;
  readonly requiredRepeats: number;
  readonly reasons: readonly string[];
  readonly commands: readonly string[];
}

export interface MatrixArgs {
  readonly mode: 'plan' | 'run';
  readonly json: boolean;
  readonly only: readonly string[];
}

export interface ReleaseGateSummaryOptions {
  readonly fullCoverage?: boolean;
}

export interface ReleaseGateCounts {
  readonly total: number;
  readonly ready: number;
  readonly passed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly releaseRequiredSkipped: number;
  readonly diagnosticOptionalSkipped: number;
}

export interface ReleaseGateSummary {
  readonly overall: ReleaseGateVerdict;
  readonly overallPass: boolean;
  readonly releaseEligible: boolean;
  readonly fullCoverage: boolean;
  readonly counts: ReleaseGateCounts;
}

const OFFICIAL_DATABASE_PORTS = new Set([5432, 5440, 5441, 5542, 6542]);
const DISPOSABLE_DATABASE_NAME = /^rag_v2_migration_[a-z0-9][a-z0-9_-]{0,45}$/;
const OFFICIAL_PROJECT_IDS = new Set(['3', 'rag-v2', 'rag-v2-dev']);
const REAL_GATE_TIMEOUT_MS = 15 * 60 * 1000;

/** Suites that require Bun globals or Bun.SQL at runtime. */
export const BUN_RUNTIME_UNIT_FILES = [
  'scripts/db-migrations/runner.postgres.integration.test.ts',
  'scripts/docs-rag/store.postgres.integration.test.ts',
  'scripts/eval/project-rag/t09-real.integration.test.ts',
  'scripts/project-rag/finalizer.postgres.integration.test.ts',
  'scripts/project-rag/version-owned.postgres.integration.test.ts',
] as const;

function quoteArg(value: string): string {
  return /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function makeCommand(executable: string, args: readonly string[]): GateCommand {
  return { executable, args, display: [executable, ...args].map(quoteArg).join(' ') };
}

function projectId(env: NodeJS.ProcessEnv): string {
  return env.RAG_T18_PROJECT_ID?.trim() || '<RAG_T18_PROJECT_ID>';
}

function bunRun(...args: readonly string[]): GateCommand {
  return makeCommand('bun', ['run', ...args]);
}

function vitestBunRun(...args: readonly string[]): GateCommand {
  return makeCommand('bun', ['--bun', 'x', 'vitest', 'run', ...args, '--exclude', '.tmp/**']);
}

function testFiles(...files: readonly string[]): GateCommand {
  return vitestBunRun(...files);
}

function vitestNodeUnitAll(): GateCommand {
  return makeCommand('bun', [
    'x',
    'vitest',
    'run',
    '--exclude',
    '.tmp/**',
    ...BUN_RUNTIME_UNIT_FILES.flatMap((file) => ['--exclude', file]),
  ]);
}

function vitestBunUnitFiles(): GateCommand {
  return vitestBunRun(...BUN_RUNTIME_UNIT_FILES);
}

function gate(
  input: Omit<ReleaseGate, 'commands' | 'skipClass'> & {
    readonly skipClass?: GateSkipClass;
    readonly commands: (env: NodeJS.ProcessEnv) => readonly GateCommand[];
  }
): ReleaseGate {
  return { ...input, skipClass: input.skipClass ?? 'release-required' };
}

export function buildReleaseGateMatrix(): readonly ReleaseGate[] {
  return [
    gate({
      id: 'static-diff',
      lane: 'static',
      description: 'Working-tree whitespace and patch validation.',
      isolation: 'none',
      requiredEnv: [],
      urlEnv: [],
      repeat: 1,
      external: false,
      timeoutMs: 120_000,
      env: {},
      commands: () => [makeCommand('git', ['diff', '--check'])],
    }),
    gate({
      id: 'dependency-audit',
      lane: 'security',
      description: 'Production and development dependency advisory audit.',
      isolation: 'none',
      requiredEnv: [],
      urlEnv: [],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: () => [makeCommand('bun', ['audit', '--json'])],
    }),
    gate({
      id: 'secret-history',
      lane: 'security',
      description: 'Redacted secret scan across reachable Git history.',
      isolation: 'none',
      requiredEnv: [],
      urlEnv: [],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: () => [
        makeCommand('git', ['rev-parse', '--verify', 'HEAD']),
        makeCommand('gitleaks', [
          'git',
          '.',
          '--redact',
          '--no-banner',
          '--no-color',
          '--log-opts=HEAD',
        ]),
      ],
    }),
    gate({
      id: 'release-hygiene',
      lane: 'security',
      description: 'Required public artifacts and alpha package contract.',
      isolation: 'none',
      requiredEnv: [],
      urlEnv: [],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: () => [testFiles('scripts/eval/release-hygiene.test.ts')],
    }),
    gate({
      id: 'lint',
      lane: 'static',
      description: 'Canonical Biome lint gate.',
      isolation: 'none',
      requiredEnv: [],
      urlEnv: [],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: () => [bunRun('lint')],
    }),
    gate({
      id: 'typecheck',
      lane: 'static',
      description: 'Canonical TypeScript typecheck gate.',
      isolation: 'none',
      requiredEnv: [],
      urlEnv: [],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: () => [bunRun('typecheck')],
    }),
    gate({
      id: 'unit-contract',
      lane: 'unit',
      description:
        'Direct unit/contract Vitest suite split between Node-default and Bun.SQL runtime lanes; provider readiness is owned by provider-bound gates.',
      isolation: 'none',
      requiredEnv: [],
      urlEnv: [],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: () => [vitestNodeUnitAll(), vitestBunUnitFiles()],
    }),
    gate({
      id: 'migration-fresh-upgrade',
      lane: 'postgres',
      description: 'Fresh and ordered-upgrade migration runner against one disposable target.',
      isolation: 'loopback-database',
      requiredEnv: ['RAG_MIGRATION_INTEGRATION_DATABASE_URL'],
      urlEnv: ['RAG_MIGRATION_INTEGRATION_DATABASE_URL'],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {
        RAG_MIGRATION_POSTGRES_INTEGRATION: '1',
        RAG_MIGRATION_TARGET: 'isolated',
        RAG_MIGRATION_WRITE_ACK: '1',
      },
      commands: () => [testFiles('scripts/db-migrations/runner.postgres.integration.test.ts')],
    }),
    gate({
      id: 'docs-postgres',
      lane: 'docs',
      description:
        'Docs staging, provenance, retrieval, and failure-recovery integration (DOCS_RAG_REAL_DB_TEST=1).',
      isolation: 'self-provisioned',
      requiredEnv: [],
      urlEnv: [],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {
        DOCS_RAG_REAL_DB_TEST: '1',
        CHUNK_SIZE: '1000',
        CHUNK_OVERLAP: '50',
      },
      commands: () => [testFiles('scripts/docs-rag/store.postgres.integration.test.ts')],
    }),
    gate({
      id: 'project-postgres',
      lane: 'project',
      description:
        'Project prepare, publish, snapshot, verify, and cleanup integration (PROJECT_RAG_REAL_DB_TEST=1).',
      isolation: 'self-provisioned',
      requiredEnv: ['PROJECT_RAG_DATABASE_URL'],
      urlEnv: ['PROJECT_RAG_DATABASE_URL'],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: { PROJECT_RAG_REAL_DB_TEST: '1' },
      commands: () => [
        testFiles(
          'scripts/project-rag/snapshot-gate.postgres.integration.test.ts',
          'scripts/project-rag/finalizer.postgres.integration.test.ts',
          'scripts/project-rag/version-owned.postgres.integration.test.ts'
        ),
      ],
    }),
    gate({
      id: 'project-t09-real',
      lane: 'project',
      description:
        'T-09 Project RAG context, worker, and MCP startup integration against prepared Postgres.',
      isolation: 'loopback-database',
      requiredEnv: ['PROJECT_RAG_T09_DATABASE_URL'],
      urlEnv: ['PROJECT_RAG_T09_DATABASE_URL'],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: { RAG_PROJECT_WATCHER_ENABLED: 'false' },
      commands: () => [testFiles('scripts/eval/project-rag/t09-real.integration.test.ts')],
    }),
    gate({
      id: 'docs-retrieval',
      lane: 'docs',
      description: 'Docs live retrieval and citation gate with current provider readiness.',
      isolation: 'loopback-database',
      requiredEnv: ['DOCS_RAG_PG_LAB_DATABASE_URL'],
      urlEnv: ['DOCS_RAG_PG_LAB_DATABASE_URL'],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: () => [bunRun('eval:docs-live')],
    }),
    gate({
      id: 'project-retrieval',
      lane: 'project',
      description: 'Project isolated end-to-end ingest, search, and cleanup evaluation.',
      isolation: 'loopback-database',
      requiredEnv: ['PROJECT_RAG_DATABASE_URL'],
      urlEnv: ['PROJECT_RAG_DATABASE_URL'],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: { RAG_PROJECT_WATCHER_ENABLED: 'false' },
      commands: () => [bunRun('eval:project-rag')],
    }),
    gate({
      id: 'project-search-quality',
      lane: 'benchmark',
      description: 'At least 30 measured Project search samples with nonzero hits per query.',
      isolation: 'loopback-project',
      requiredEnv: ['PROJECT_RAG_DATABASE_URL', 'RAG_T18_PROJECT_ID'],
      urlEnv: ['PROJECT_RAG_DATABASE_URL'],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: (currentEnv) => [
        bunRun(
          'bench:project-search',
          '--',
          '--project',
          projectId(currentEnv),
          '--iterations',
          '10',
          '--warmup',
          '2',
          '--json'
        ),
      ],
    }),
    gate({
      id: 'mcp-stdio-concurrency',
      lane: 'mcp',
      description: 'Read-only MCP STDIO calls at concurrency 10, repeated 10 times.',
      isolation: 'loopback-project',
      requiredEnv: [
        'PROJECT_RAG_DATABASE_URL',
        'DOCS_RAG_PG_LAB_DATABASE_URL',
        'RAG_T18_PROJECT_ID',
      ],
      urlEnv: ['PROJECT_RAG_DATABASE_URL', 'DOCS_RAG_PG_LAB_DATABASE_URL'],
      repeat: 10,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: { MCP_PERMISSION_MODE: 'read_only', RAG_PROJECT_WATCHER_ENABLED: 'false' },
      commands: (currentEnv) => [
        bunRun(
          'eval:mcp-concurrency',
          '--',
          '--transport',
          'stdio',
          '--project-id',
          projectId(currentEnv),
          '--concurrency',
          '10',
          '--iterations',
          '10',
          '--p95-threshold-ms',
          String(MCP_CONCURRENCY_P95_THRESHOLDS.releaseConcurrency10),
          '--json'
        ),
      ],
    }),
    gate({
      id: 'cli-project-verify',
      lane: 'cli',
      description: 'Repo-local read-only CLI verification against the same isolated project.',
      isolation: 'loopback-project',
      requiredEnv: ['PROJECT_RAG_DATABASE_URL', 'RAG_T18_PROJECT_ID'],
      urlEnv: ['PROJECT_RAG_DATABASE_URL'],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: { RAG_PROJECT_WATCHER_ENABLED: 'false' },
      commands: (currentEnv) => [
        bunRun('ragctl', '--', 'project', 'verify', '--project', projectId(currentEnv), '--json'),
      ],
    }),
    gate({
      id: 'cli-project-search',
      lane: 'cli',
      description: 'Repo-local read-only CLI search against the same isolated project.',
      isolation: 'loopback-project',
      requiredEnv: ['PROJECT_RAG_DATABASE_URL', 'RAG_T18_PROJECT_ID'],
      urlEnv: ['PROJECT_RAG_DATABASE_URL'],
      repeat: 1,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: { RAG_PROJECT_WATCHER_ENABLED: 'false' },
      commands: (currentEnv) => [
        bunRun(
          'ragctl',
          '--',
          'project',
          'search',
          '--project',
          projectId(currentEnv),
          'search_project_code',
          '--mode',
          'hybrid',
          '--json'
        ),
      ],
    }),
    gate({
      id: 'migration-fault-recovery',
      lane: 'fault-recovery',
      description: 'Migration rollback/adoption fault paths repeated ten times.',
      isolation: 'loopback-database',
      requiredEnv: ['RAG_MIGRATION_INTEGRATION_DATABASE_URL'],
      urlEnv: ['RAG_MIGRATION_INTEGRATION_DATABASE_URL'],
      repeat: 10,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {
        RAG_MIGRATION_POSTGRES_INTEGRATION: '1',
        RAG_MIGRATION_TARGET: 'isolated',
        RAG_MIGRATION_WRITE_ACK: '1',
      },
      commands: () => [testFiles('scripts/db-migrations/runner.postgres.integration.test.ts')],
    }),
    gate({
      id: 'project-fault-recovery',
      lane: 'fault-recovery',
      description: 'Project finalizer/snapshot recovery paths repeated ten times.',
      isolation: 'self-provisioned',
      requiredEnv: [],
      urlEnv: [],
      repeat: 10,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: { PROJECT_RAG_REAL_DB_TEST: '1', RAG_PROJECT_WATCHER_ENABLED: 'false' },
      commands: () => [
        testFiles(
          'scripts/project-rag/finalizer.postgres.integration.test.ts',
          'scripts/project-rag/snapshot-gate.postgres.integration.test.ts'
        ),
      ],
    }),
    gate({
      id: 'worker-recovery',
      lane: 'recovery',
      description: 'Worker heartbeat, shutdown, and restart recovery tests repeated ten times.',
      isolation: 'none',
      requiredEnv: [],
      urlEnv: [],
      repeat: 10,
      external: false,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: {},
      commands: () => [testFiles('scripts/project-rag/job-worker.test.ts')],
    }),
    gate({
      id: 'mcp-codex-stdio',
      lane: 'mcp-external',
      description: 'Strict Codex MCP STDIO tool listing/calls; external provider opt-in.',
      isolation: 'loopback-database',
      requiredEnv: ['DOCS_RAG_PG_LAB_DATABASE_URL', 'RAG_T18_ALLOW_EXTERNAL'],
      urlEnv: ['DOCS_RAG_PG_LAB_DATABASE_URL'],
      repeat: 1,
      external: true,
      timeoutMs: REAL_GATE_TIMEOUT_MS,
      env: { RAG_PROJECT_WATCHER_ENABLED: 'false' },
      commands: () => [bunRun('eval:codex-mcp', '--', '--docs-only', '--strict-codex', '--json')],
    }),
  ];
}

export function isDisposableLoopbackDatabaseUrl(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  try {
    const url = new URL(raw.trim().replace(/^['"]|['"]$/g, ''));
    const host = url.hostname.toLowerCase();
    const port = Number(url.port);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return (
      (host === '127.0.0.1' || host === '::1') &&
      Boolean(url.port) &&
      Number.isInteger(port) &&
      port > 0 &&
      !OFFICIAL_DATABASE_PORTS.has(port) &&
      DISPOSABLE_DATABASE_NAME.test(database) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function evaluateGatePrerequisites(
  gateDefinition: ReleaseGate,
  env: NodeJS.ProcessEnv = process.env
): GatePrerequisites {
  const reasons: string[] = [];
  if (gateDefinition.isolation !== 'none' && env.RAG_T18_ISOLATED !== '1') {
    reasons.push('RAG_T18_ISOLATED=1 is required for live gates');
  }
  for (const name of gateDefinition.requiredEnv) {
    if (!env[name]?.trim()) reasons.push(`${name} is required`);
  }
  for (const name of gateDefinition.urlEnv) {
    if (env[name]?.trim() && !isDisposableLoopbackDatabaseUrl(env[name])) {
      reasons.push(`${name} must identify a disposable loopback database`);
    }
  }
  if (gateDefinition.isolation === 'loopback-project') {
    const id = env.RAG_T18_PROJECT_ID?.trim();
    if (id && OFFICIAL_PROJECT_IDS.has(id)) {
      reasons.push('RAG_T18_PROJECT_ID must not target the official project identity');
    }
  }
  if (gateDefinition.external && env.RAG_T18_ALLOW_EXTERNAL !== '1') {
    return {
      status: 'skipped',
      reasons: [...reasons, 'external provider gate requires RAG_T18_ALLOW_EXTERNAL=1'],
    };
  }
  return { status: reasons.length > 0 ? 'blocked' : 'ready', reasons };
}

export function parseMatrixArgs(argv: readonly string[]): MatrixArgs {
  const wantsRun = argv.includes('--run');
  const wantsPlan = argv.includes('--plan');
  if (wantsRun && wantsPlan) throw new Error('Choose exactly one of --run or --plan.');
  const only = argv
    .flatMap((arg, index) => (arg === '--only' ? [argv[index + 1] ?? ''] : []))
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return { mode: wantsRun ? 'run' : 'plan', json: argv.includes('--json'), only };
}

function gateResult(gateDefinition: ReleaseGate, env: NodeJS.ProcessEnv, run: boolean): GateResult {
  const prerequisites = evaluateGatePrerequisites(gateDefinition, env);
  const commands = gateDefinition.commands(env);
  if (!run || prerequisites.status !== 'ready') {
    return {
      id: gateDefinition.id,
      status: prerequisites.status,
      skipClass: gateDefinition.skipClass,
      attempts: 0,
      requiredRepeats: gateDefinition.repeat,
      reasons: prerequisites.reasons,
      commands: commands.map((command) => command.display),
    };
  }

  const failures: string[] = [];
  let attempts = 0;
  for (let repetition = 1; repetition <= gateDefinition.repeat; repetition += 1) {
    attempts = repetition;
    for (const command of commands) {
      const child = spawnSync(command.executable, [...command.args], {
        cwd: process.cwd(),
        env: { ...env, ...gateDefinition.env },
        encoding: 'utf8',
        timeout: gateDefinition.timeoutMs,
        stdio: 'pipe',
      });
      if (child.status !== 0) {
        const output = redactCredentialText(`${child.error?.message ?? ''}\n${child.stderr ?? ''}`)
          .trim()
          .slice(-600);
        failures.push(
          `${gateDefinition.id} attempt ${repetition} failed (${child.status ?? 'signal'})${
            output ? `: ${output}` : ''
          }`
        );
      }
    }
  }

  return {
    id: gateDefinition.id,
    status: failures.length === 0 ? 'passed' : 'failed',
    skipClass: gateDefinition.skipClass,
    attempts,
    requiredRepeats: gateDefinition.repeat,
    reasons: failures,
    commands: commands.map((command) => command.display),
  };
}

function printResults(results: readonly GateResult[]): void {
  for (const result of results) {
    const marker =
      result.status === 'passed' || result.status === 'ready'
        ? 'PASS'
        : result.status.toUpperCase();
    console.log(`${marker} ${result.id} attempts=${result.attempts}/${result.requiredRepeats}`);
    for (const reason of result.reasons) console.log(`  ${reason}`);
    for (const command of result.commands) console.log(`  $ ${command}`);
  }
}

export function runReleaseGateMatrix(
  args: MatrixArgs,
  env: NodeJS.ProcessEnv = process.env
): readonly GateResult[] {
  const allGates = buildReleaseGateMatrix();
  const selected =
    args.only.length > 0
      ? allGates.filter((gateDefinition) => args.only.includes(gateDefinition.id))
      : allGates;
  const unknown = args.only.filter(
    (id) => !allGates.some((gateDefinition) => gateDefinition.id === id)
  );
  if (unknown.length > 0) throw new Error(`Unknown gate(s): ${unknown.join(', ')}`);
  return selected.map((gateDefinition) => gateResult(gateDefinition, env, args.mode === 'run'));
}

export function releaseGateMatrixPassed(
  results: readonly GateResult[],
  options: ReleaseGateSummaryOptions = {}
): boolean {
  return summarizeReleaseGateResults(results, options).overallPass;
}

export function summarizeReleaseGateResults(
  results: readonly GateResult[],
  options: ReleaseGateSummaryOptions = {}
): ReleaseGateSummary {
  const fullCoverage = options.fullCoverage ?? true;
  const count = (predicate: (result: GateResult) => boolean): number =>
    results.filter(predicate).length;
  const counts: ReleaseGateCounts = {
    total: results.length,
    ready: count((result) => result.status === 'ready'),
    passed: count((result) => result.status === 'passed'),
    failed: count((result) => result.status === 'failed'),
    blocked: count((result) => result.status === 'blocked'),
    skipped: count((result) => result.status === 'skipped'),
    releaseRequiredSkipped: count(
      (result) => result.status === 'skipped' && result.skipClass === 'release-required'
    ),
    diagnosticOptionalSkipped: count(
      (result) => result.status === 'skipped' && result.skipClass === 'diagnostic-optional'
    ),
  };
  const releaseEligible =
    fullCoverage &&
    counts.ready === 0 &&
    counts.failed === 0 &&
    counts.blocked === 0 &&
    counts.releaseRequiredSkipped === 0;
  const overall: ReleaseGateVerdict = releaseEligible ? 'passed' : 'failed';
  return { overall, overallPass: releaseEligible, releaseEligible, fullCoverage, counts };
}

async function main(): Promise<void> {
  const args = parseMatrixArgs(process.argv.slice(2));
  const results = runReleaseGateMatrix(args);
  const fullCoverage = results.length === buildReleaseGateMatrix().length;
  const summary = summarizeReleaseGateResults(results, { fullCoverage });
  if (args.json) {
    console.log(
      JSON.stringify(
        args.mode === 'run'
          ? { mode: args.mode, ...summary, results }
          : { mode: args.mode, results },
        null,
        2
      )
    );
  } else {
    printResults(results);
  }
  if (args.mode === 'run' && !summary.overallPass) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(redactCredentialText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
