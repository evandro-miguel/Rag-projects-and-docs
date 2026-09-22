import '../lib/runtime-env.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatErrorForOutput, redactCredentialText } from '../../lib/shared/credential-redact.js';
import { suggestProjectIncludeRoots } from '../../lib/shared/project-include-roots.js';
import { createProjectSlug } from '../../lib/shared/project-registry.js';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../lib/shared/project-scope-advisory.js';
import { resolveProjectRagPostgresConfig } from '../project-rag/config.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
} from '../project-rag/store.js';

type SmokeSummary = {
  mode: 'docs-only' | 'full';
  health: string;
  docs_count: number;
  docs_first_source: string | null;
  project_id: string | null;
  project_count: number;
  project_first_source: string | null;
  errors: string[];
};

type ToolLatency = {
  server: string;
  tool: string;
  latency_ms: number;
};

export type ObservedMcpCall = {
  server: string;
  tool: string;
  status: string;
  error: string | null;
};

export function buildProjectSearchArguments(projectId: string, query: string, limit = 3) {
  return {
    projectId,
    query,
    limit,
    mode: 'hybrid' as const,
  };
}

function getAcceptedServerNames(expectedServer: string): string[] {
  if (expectedServer === 'rag-docs' || expectedServer === 'rag-projects') {
    return [expectedServer, 'rag'];
  }

  return [expectedServer];
}

type StartupFailure = {
  server: string;
  reason: string;
};

type ExpectedMcpCall = {
  server: string;
  tool: string;
};

type StepOutput = {
  errors: string[];
};

type StepRun<T extends StepOutput> = {
  output: T;
  stdout: string;
  elapsedMs: number;
  observedMcpCalls: ObservedMcpCall[];
  startupFailures: StartupFailure[];
};

type HealthStepOutput = StepOutput & {
  health: string;
};

type DocsStepOutput = StepOutput & {
  health?: string;
  docs_count: number;
  docs_first_source: string | null;
};

type RegisterStepOutput = StepOutput & {
  project_id: string | null;
};

type ProjectStepOutput = StepOutput & {
  project_count: number;
  project_first_source: string | null;
};

type FullProjectStepOutput = RegisterStepOutput & ProjectStepOutput;
type ReadOnlyProjectStepOutput = FullProjectStepOutput & {
  project_ready: boolean;
};

function parseArgs(args: string[]) {
  const readString = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  return {
    json: args.includes('--json'),
    cwd: readString('--cwd'),
    projectRoot: readString('--project-root'),
    includeRoots: readString('--include-roots'),
    projectQuery: readString('--project-query') ?? 'mcp-project-current',
    docsOnly: args.includes('--docs-only'),
    model: readString('--model') ?? process.env.CODEX_MCP_SMOKE_MODEL,
    reasoningEffort:
      readString('--reasoning-effort') ?? process.env.CODEX_MCP_SMOKE_REASONING_EFFORT ?? 'low',
    timeoutMs: Number.parseInt(
      process.env.CODEX_MCP_SMOKE_TIMEOUT_MS ??
        (args.includes('--timeout-ms') ? (args[args.indexOf('--timeout-ms') + 1] ?? '') : ''),
      10
    ),
    strictCodex:
      args.includes('--strict-codex') || process.env.CODEX_MCP_SMOKE_STRICT_CODEX === 'true',
  };
}

function defaultSmokeIncludeRoots(projectRoot: string): string[] {
  if (existsSync(join(projectRoot, 'scripts/eval'))) {
    return ['scripts/eval'];
  }

  return suggestProjectIncludeRoots(projectRoot);
}

export function selectRegisteredProjectIncludeRoots(
  computedRoots: readonly string[],
  existingProject?: { includeRoots?: readonly string[] }
): string[] {
  if (existingProject?.includeRoots && existingProject.includeRoots.length > 0) {
    return [...existingProject.includeRoots];
  }

  return [...computedRoots];
}

async function resolveSmokeProjectIncludeRoots(
  projectName: string,
  computedRoots: string[]
): Promise<string[]> {
  try {
    const config = resolveProjectRagPostgresConfig(process.env);
    if (!config.database.url) {
      return computedRoots;
    }

    const sql = createProjectRagPostgresSql(config);
    try {
      const existingProject = await findProjectRagPostgresProject(
        sql,
        createProjectSlug(projectName)
      );
      return selectRegisteredProjectIncludeRoots(computedRoots, existingProject);
    } finally {
      await closeProjectRagPostgresSql(config.database.url);
    }
  } catch {
    return computedRoots;
  }
}

export function buildHealthPrompt(): string {
  return [
    'Call exactly one MCP tool: rag-docs.health_check with arguments {}.',
    'Preserve the exact health text returned by the tool; do not summarize it.',
    'Return immediately after the tool call as strict JSON on a single line:',
    '{"health":string,"errors":string[]}',
  ].join(' ');
}

export function buildDocsSearchPrompt(): string {
  return [
    'Use only MCP tools. Do not run shell commands.',
    'First call rag-docs-read.health_check with arguments {}.',
    'Then call rag-docs-read.search_docs with arguments {"query":"Bun.serve routes","limit":3}.',
    'Copy the complete health_check text into health without condensing or summarizing it.',
    'Do not call any other RAG MCP tool, shell command, or web tool.',
    'Return immediately after the tool call as strict JSON on a single line:',
    '{"health":string,"docs_count":number,"docs_first_source":string|null,"errors":string[]}',
  ].join(' ');
}

export function buildReadOnlyProjectPrompt(args: {
  projectId: string;
  projectQuery: string;
}): string {
  const searchArguments = buildProjectSearchArguments(args.projectId, args.projectQuery);
  return [
    'Use only MCP tools. Do not run shell commands or use ragctl.',
    `First call rag-projects-read.verify_project_index with arguments {"projectId":"${args.projectId}"}.`,
    `Then call rag-projects-read.search_project_code with arguments ${JSON.stringify(searchArguments)}.`,
    'Set project_ready to the exact verify_project_index data.gateSignal.ready boolean.',
    'Set project_count to the number of search_project_code results, never the verify fileCount.',
    'Do not call register_project or ingest_project.',
    'Do not call any other RAG MCP tool or web tool.',
    'Return immediately after the tool call as strict JSON on a single line:',
    `{"project_id":"${args.projectId}","project_ready":boolean,"project_count":number,"project_first_source":string|null,"errors":string[]}`,
  ].join(' ');
}

export function buildFullProjectPrompt(args: {
  projectName: string;
  projectRoot: string;
  includeRoots: readonly string[];
  projectQuery: string;
}): string {
  return [
    'Call exactly three MCP tools from server rag-projects, in this order.',
    'The current operator has authorized these local development register_project and ingest_project calls for this smoke.',
    `First call register_project with name '${args.projectName}', rootPath '${args.projectRoot}', includeRoots ${JSON.stringify(args.includeRoots)}, and scopeAck '${PROJECT_SCOPE_ACK_TOKEN}'.`,
    `Then call ingest_project with rootPath '${args.projectRoot}', includeRoots ${JSON.stringify(args.includeRoots)}, force false, maxFiles 50, and scopeAck '${PROJECT_SCOPE_ACK_TOKEN}'.`,
    `Then call search_project_code with the projectId returned by register_project, query '${args.projectQuery}', limit 3, and mode 'hybrid'.`,
    'Return immediately after the third tool call as strict JSON on a single line:',
    '{"project_id":string|null,"project_count":number,"project_first_source":string|null,"errors":string[]}',
  ].join(' ');
}

const DISCOVERY_MCP_METHODS = new Set([
  'list_mcp_resources',
  'read_mcp_resource',
  'list_mcp_resource_templates',
  'tools/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
]);

function withoutFailedDiscoveryCalls(calls: ObservedMcpCall[]): ObservedMcpCall[] {
  return calls.filter(
    (call) => !(call.status === 'failed' && DISCOVERY_MCP_METHODS.has(call.tool))
  );
}

export function shouldRetryCodexMcpStep(
  step: Pick<StepRun<StepOutput>, 'output' | 'observedMcpCalls'>
): boolean {
  if (step.observedMcpCalls.length > 0) {
    return step.observedMcpCalls.every(
      (call) => call.status === 'failed' && DISCOVERY_MCP_METHODS.has(call.tool)
    );
  }

  return step.output.errors.some((error) =>
    /not available|not exposed|not observed|no direct MCP|does not expose/i.test(error)
  );
}

export function isDirectExecution(scriptPath: string | undefined = process.argv[1]): boolean {
  return (
    import.meta.main ||
    (typeof scriptPath === 'string' && resolve(scriptPath) === fileURLToPath(import.meta.url))
  );
}

function parseToolLatencies(stdout: string): ToolLatency[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^([\w-]+)\.([\w_]+)\(.*\) success in (\d+)ms:/);
      if (!match) {
        return [];
      }

      return [
        {
          server: match[1],
          tool: match[2],
          latency_ms: Number.parseInt(match[3], 10),
        },
      ];
    });
}

export function parseObservedMcpCalls(stdout: string): ObservedMcpCall[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => {
      if (!line.startsWith('{')) {
        return [];
      }

      try {
        const event = JSON.parse(line) as {
          type?: string;
          item?: {
            type?: string;
            server?: string;
            tool?: string;
            status?: string;
            error?: unknown;
          };
        };
        if (event.type !== 'item.completed' || event.item?.type !== 'mcp_tool_call') {
          return [];
        }
        const server = event.item.server;
        const tool = event.item.tool;
        if (typeof server !== 'string' || typeof tool !== 'string') {
          return [];
        }

        return [
          {
            server,
            tool,
            status: typeof event.item.status === 'string' ? event.item.status : 'unknown',
            error:
              typeof event.item.error === 'string'
                ? event.item.error
                : event.item.error
                  ? JSON.stringify(event.item.error)
                  : null,
          },
        ];
      } catch {
        return [];
      }
    });
}

export function getObservedMcpCallFailure(
  call: ObservedMcpCall | undefined,
  expectedTool: string,
  expectedServer = 'rag-docs'
): string | null {
  if (!call) {
    return `expected ${expectedServer}.${expectedTool} call was not observed in Codex event stream`;
  }

  if (call.status !== 'completed') {
    return `${expectedServer}.${expectedTool} did not complete successfully (status: ${call.status})${
      call.error ? `: ${redactCredentialText(call.error)}` : ''
    }`;
  }

  if (call.error) {
    return `${expectedServer}.${expectedTool} failed: ${redactCredentialText(call.error)}`;
  }

  return null;
}

export function getObservedMcpStepFailure(
  calls: ObservedMcpCall[],
  expectedTool: string,
  expectedServer = 'rag-docs'
): string | null {
  const substantiveCalls = withoutFailedDiscoveryCalls(calls);
  const acceptedServers = getAcceptedServerNames(expectedServer);
  const expectedCall = substantiveCalls.find(
    (call) => acceptedServers.includes(call.server) && call.tool === expectedTool
  );
  const expectedCallFailure = getObservedMcpCallFailure(expectedCall, expectedTool, expectedServer);
  if (expectedCallFailure) {
    return expectedCallFailure;
  }

  if (substantiveCalls.length !== 1) {
    const observed = substantiveCalls
      .map((call) => `${call.server}.${call.tool}:${call.status}`)
      .join(', ');
    return `expected exactly one MCP tool call ${expectedServer}.${expectedTool}, observed ${substantiveCalls.length}${observed ? `: ${observed}` : ''}`;
  }

  return null;
}

export function getObservedMcpStepSequenceFailure(
  calls: ObservedMcpCall[],
  expectedCalls: ExpectedMcpCall[]
): string | null {
  const substantiveCalls = withoutFailedDiscoveryCalls(calls);
  if (substantiveCalls.length !== expectedCalls.length) {
    const observed = substantiveCalls
      .map((call) => `${call.server}.${call.tool}:${call.status}`)
      .join(', ');
    const expected = expectedCalls.map((call) => `${call.server}.${call.tool}`).join(', ');
    return `expected MCP tool call sequence [${expected}], observed ${substantiveCalls.length}${observed ? `: ${observed}` : ''}`;
  }

  for (let index = 0; index < expectedCalls.length; index += 1) {
    const expected = expectedCalls[index];
    const observed = substantiveCalls[index];
    if (!expected || !observed) {
      return `missing MCP tool call at position ${index + 1}`;
    }

    const acceptedServers = getAcceptedServerNames(expected.server);
    if (!acceptedServers.includes(observed.server) || observed.tool !== expected.tool) {
      return `expected MCP call ${index + 1} to be ${expected.server}.${expected.tool}, observed ${observed.server}.${observed.tool}`;
    }

    const failure = getObservedMcpCallFailure(observed, expected.tool, expected.server);
    if (failure) {
      return failure;
    }
  }

  return null;
}

export function shouldUseDirectFallbackForCodexMcp(
  steps: Array<{ output: StepOutput; observedMcpCalls: ObservedMcpCall[] }>
): boolean {
  return steps.some(
    (step) =>
      step.observedMcpCalls.length === 0 &&
      step.output.errors.some(
        (error) =>
          error.includes('unavailable in this session') ||
          error.includes('Requested MCP tool server') ||
          error.includes('was not observed in Codex event stream')
      )
  );
}

function parseStartupFailures(stdout: string): StartupFailure[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^mcp: ([^ ]+) failed: (.+)$/);
      if (!match) {
        return [];
      }

      return [
        {
          server: match[1],
          reason: redactCredentialText(match[2]),
        },
      ];
    });
}

function parseSummary(raw: string): SmokeSummary {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Codex returned an empty final message');
  }

  return JSON.parse(trimmed) as SmokeSummary;
}

function parseStructuredJson<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Codex returned empty structured output');
  }

  const attempts: string[] = [trimmed];

  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (candidate) {
      attempts.push(candidate);
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // keep trying
    }
  }

  throw new Error(`Unable to parse JSON from Codex output: ${trimmed.slice(0, 240)}`);
}

const REQUIRED_HEALTH_COMPONENTS = ['MCP Server', 'Docs RAG Postgres'] as const;
const MAX_HEALTH_FAILURE_DIAGNOSTIC_LENGTH = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHealthComponent(value: unknown): value is { component: string; status: string } {
  return isRecord(value) && typeof value.component === 'string' && typeof value.status === 'string';
}

function parseStructuredHealth(raw: string): boolean | null {
  const normalized = raw.trim();
  if (!normalized.startsWith('{') && !normalized.startsWith('[')) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!isRecord(parsed) || parsed.success !== true || !isRecord(parsed.data)) {
      return false;
    }

    const components = parsed.data.components;
    if (!Array.isArray(components) || !components.every(isHealthComponent)) {
      return false;
    }

    return REQUIRED_HEALTH_COMPONENTS.every((requiredComponent) => {
      const matches = components.filter((component) => component.component === requiredComponent);
      return matches.length > 0 && matches.every((component) => component.status === 'OK');
    });
  } catch {
    return false;
  }
}

function formatHealthFailureDiagnostic(health: unknown): string {
  const rendered = typeof health === 'string' ? health : String(health);
  const redacted = redactCredentialText(rendered).replace(/\s+/g, ' ').trim();
  const bounded = redacted.slice(0, MAX_HEALTH_FAILURE_DIAGNOSTIC_LENGTH);
  return bounded || '<empty>';
}

export function validateSummary(summary: SmokeSummary) {
  const failures: string[] = [];
  const normalizedHealth = typeof summary.health === 'string' ? summary.health.trim() : '';
  const structuredHealth =
    typeof summary.health === 'string' ? parseStructuredHealth(summary.health) : false;
  const hasExplicitHealthMarkers =
    structuredHealth === null &&
    /MCP Server:?\s+OK(?!\w)/.test(normalizedHealth) &&
    /Docs RAG Postgres:?\s+OK(?!\w)/.test(normalizedHealth);
  if (structuredHealth !== true && !hasExplicitHealthMarkers) {
    const diagnostic = formatHealthFailureDiagnostic(summary.health);
    failures.push(`health missing MCP OK marker: ${diagnostic}`);
    failures.push(`health missing Docs RAG Postgres OK marker: ${diagnostic}`);
  }
  if (summary.docs_count < 1) {
    failures.push('docs_count < 1');
  }
  if (summary.mode === 'full' && summary.project_count < 1) {
    failures.push('project_count < 1');
  }
  if (summary.mode === 'full' && summary.project_count > 3) {
    failures.push('project_count exceeds requested search limit 3');
  }
  if (summary.errors.length > 0) {
    failures.push(
      `tool errors: ${summary.errors.map((error) => redactCredentialText(error)).join('; ')}`
    );
  }

  return failures;
}

function formatFailure(result: ReturnType<typeof spawnSync>) {
  const stdout =
    typeof result.stdout === 'string'
      ? result.stdout
      : result.stdout
        ? Buffer.from(result.stdout).toString('utf8')
        : '';
  const stderr =
    typeof result.stderr === 'string'
      ? result.stderr
      : result.stderr
        ? Buffer.from(result.stderr).toString('utf8')
        : '';
  const parts = [
    `codex exec exited with status ${result.status ?? 'null'}`,
    result.error ? `error: ${result.error.message}` : '',
    stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
    stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
  ].filter(Boolean);

  return redactCredentialText(parts.join('\n\n'));
}

type SmokeMcpServerScope = 'docs' | 'projects' | 'both';
type SmokeMcpToolScope = 'health' | 'docs' | 'projects' | 'project-read';

const DOCS_MCP_ENV_VARS = [
  'DOCS_RAG_PG_LAB_DATABASE_URL',
  'DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL',
  'DOCS_RAG_PG_LAB_EMBEDDING_MODEL',
  'DOCS_RAG_PG_LAB_EMBEDDING_TIMEOUT_MS',
  'MCP_READ_TIMEOUT_MS',
  'RERANKING_SERVICE_URL',
] as const;

const PROJECT_MCP_ENV_VARS = [
  'PROJECT_RAG_DATABASE_URL',
  'PROJECT_RAG_PG_EMBEDDING_BASE_URL',
  'PROJECT_RAG_PG_EMBEDDING_MODEL',
  'PROJECT_RAG_PG_EMBEDDING_TIMEOUT_MS',
  'PROJECT_RAG_DB_TIMEOUT_MS',
  'MCP_READ_TIMEOUT_MS',
  'PROJECT_SOURCE_PATH',
] as const;

function buildRagMcpConfigOverrides(
  cwd: string,
  scope: SmokeMcpServerScope = 'both',
  toolScope?: SmokeMcpToolScope
): string[] {
  const serverOverrides = (
    name: string,
    envVars: readonly string[],
    env: Record<string, string>,
    enabledTools: readonly string[]
  ) => {
    const prefix = `mcp_servers.${name}`;
    const config = [
      `${prefix}.command="bun"`,
      `${prefix}.args=["mcp/launcher.ts"]`,
      `${prefix}.cwd=${JSON.stringify(cwd)}`,
      `${prefix}.enabled=true`,
      `${prefix}.enabled_tools=${JSON.stringify(enabledTools)}`,
      `${prefix}.env_vars=${JSON.stringify(envVars)}`,
      ...Object.entries(env).map(([key, value]) => `${prefix}.env.${key}=${JSON.stringify(value)}`),
    ];

    return config.flatMap((entry) => ['-c', entry]);
  };

  const docsServerName = toolScope === 'docs' ? 'rag-docs-read' : 'rag-docs';
  const docsTools =
    toolScope === 'docs'
      ? ['health_check', 'search_docs']
      : toolScope === 'health'
        ? ['health_check']
        : ['health_check', 'search_docs'];
  const docsOverrides = serverOverrides(
    docsServerName,
    DOCS_MCP_ENV_VARS,
    {
      MCP_TOOLSET: 'docs',
      RAG_PROJECT_WATCHER_ENABLED: 'false',
      MCP_BACKEND_AUTOSTART: 'false',
    },
    docsTools
  );
  const projectReadOnly = toolScope === 'project-read';
  const projectServerName = projectReadOnly ? 'rag-projects-read' : 'rag-projects';
  const projectOverrides = serverOverrides(
    projectServerName,
    PROJECT_MCP_ENV_VARS,
    {
      MCP_TOOLSET: 'projects',
      MCP_PERMISSION_MODE: projectReadOnly ? 'read_only' : 'read_write',
      RAG_PROJECT_WATCHER_ENABLED: 'false',
      MCP_BACKEND_AUTOSTART: 'false',
    },
    projectReadOnly
      ? ['verify_project_index', 'search_project_code']
      : ['register_project', 'ingest_project', 'search_project_code']
  );

  if (scope === 'docs') {
    return docsOverrides;
  }
  if (scope === 'projects') {
    return projectOverrides;
  }
  return [...docsOverrides, ...projectOverrides];
}

export function buildCodexExecArgs(args: {
  model?: string;
  reasoningEffort: string;
  cwd: string;
  outputPath: string;
  prompt: string;
  mcpServerScope?: SmokeMcpServerScope;
  mcpToolScope?: SmokeMcpToolScope;
}) {
  return [
    'exec',
    '--json',
    '--ephemeral',
    ...(args.model ? ['-m', args.model] : []),
    '-c',
    `model_reasoning_effort="${args.reasoningEffort}"`,
    '-c',
    'web_search="disabled"',
    ...buildRagMcpConfigOverrides(args.cwd, args.mcpServerScope, args.mcpToolScope),
    '-C',
    args.cwd,
    '-o',
    args.outputPath,
    args.prompt,
  ];
}

function runCodexStep<T extends StepOutput>(args: {
  model?: string;
  reasoningEffort: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  expectedMcpServer?: string;
  expectedMcpTool?: string;
  expectedMcpCalls?: ExpectedMcpCall[];
  mcpServerScope?: SmokeMcpServerScope;
  mcpToolScope?: SmokeMcpToolScope;
  parseOutput: (raw: string) => T;
}): StepRun<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-rag-mcp-smoke-step-'));
  const outputPath = join(tempDir, 'last-message.json');

  try {
    const startedAt = performance.now();
    const result = spawnSync(
      'codex',
      buildCodexExecArgs({
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        cwd: args.cwd,
        outputPath,
        prompt: args.prompt,
        mcpServerScope: args.mcpServerScope,
        mcpToolScope: args.mcpToolScope,
      }),
      {
        cwd: args.cwd,
        encoding: 'utf8',
        env: process.env as Record<string, string>,
        timeout: args.timeoutMs,
      }
    );

    const hasStructuredOutput =
      existsSync(outputPath) && readFileSync(outputPath, 'utf8').trim().length > 0;
    if ((result.error && !hasStructuredOutput) || result.status !== 0) {
      throw new Error(formatFailure(result));
    }

    const stdout = result.stdout ?? '';
    const observedMcpCalls = parseObservedMcpCalls(stdout);
    const output = args.parseOutput(readFileSync(outputPath, 'utf8'));
    const expectedMcpCalls =
      args.expectedMcpCalls ??
      (args.expectedMcpServer && args.expectedMcpTool
        ? [{ server: args.expectedMcpServer, tool: args.expectedMcpTool }]
        : []);
    const stepFailure =
      expectedMcpCalls.length === 1
        ? getObservedMcpStepFailure(
            observedMcpCalls,
            expectedMcpCalls[0]?.tool ?? '',
            expectedMcpCalls[0]?.server
          )
        : getObservedMcpStepSequenceFailure(observedMcpCalls, expectedMcpCalls);
    if (stepFailure) {
      output.errors.push(stepFailure);
    }

    return {
      output,
      stdout,
      elapsedMs: Math.round(performance.now() - startedAt),
      observedMcpCalls,
      startupFailures: parseStartupFailures(stdout),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runDirectDocsFallback(args: {
  cwd: string;
  query: string;
}): Promise<{ health: StepRun<HealthStepOutput>; docs: StepRun<DocsStepOutput> }> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['mcp/launcher.ts'],
    cwd: args.cwd,
    env: {
      ...(process.env as Record<string, string>),
      MCP_TOOLSET: 'docs',
      RAG_PROJECT_WATCHER_ENABLED: 'false',
      MCP_BACKEND_AUTOSTART: 'false',
    },
  });
  const client = new Client(
    {
      name: 'rag-v1-codex-mcp-docs-fallback',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);

    const healthStartedAt = performance.now();
    const healthRaw = await client.callTool({ name: 'health_check', arguments: {} });
    const healthElapsed = Math.round(performance.now() - healthStartedAt);
    const healthText =
      Array.isArray(healthRaw.content) && healthRaw.content[0]?.type === 'text'
        ? String(healthRaw.content[0].text ?? '')
        : '';
    const healthErrors = healthRaw.isError ? ['health_check fallback returned isError'] : [];

    const docsStartedAt = performance.now();
    const docsRaw = await client.callTool({
      name: 'search_docs',
      arguments: { query: args.query, limit: 3 },
    });
    const docsElapsed = Math.round(performance.now() - docsStartedAt);
    const docsData =
      docsRaw.structuredContent && typeof docsRaw.structuredContent === 'object'
        ? (docsRaw.structuredContent as any)
        : undefined;
    const results = Array.isArray(docsData?.results) ? docsData.results : [];
    const firstSource = results.find((entry: any) => typeof entry?.sourcePath === 'string');
    const docsErrors = docsRaw.isError ? ['search_docs fallback returned isError'] : [];

    return {
      health: {
        output: { health: healthText, errors: healthErrors },
        stdout: '',
        elapsedMs: healthElapsed,
        observedMcpCalls: [],
        startupFailures: [],
      },
      docs: {
        output: {
          docs_count:
            typeof docsData?.resultCount === 'number' ? docsData.resultCount : results.length,
          docs_first_source: firstSource?.sourcePath ?? null,
          errors: docsErrors,
        },
        stdout: '',
        elapsedMs: docsElapsed,
        observedMcpCalls: [],
        startupFailures: [],
      },
    };
  } catch (error) {
    const message = formatErrorForOutput(error);
    return {
      health: {
        output: { health: '', errors: [`direct docs fallback failed: ${message}`] },
        stdout: '',
        elapsedMs: 0,
        observedMcpCalls: [],
        startupFailures: [],
      },
      docs: {
        output: { docs_count: 0, docs_first_source: null, errors: [] },
        stdout: '',
        elapsedMs: 0,
        observedMcpCalls: [],
        startupFailures: [],
      },
    };
  } finally {
    await transport.close();
  }
}

async function runDirectProjectFallback(args: {
  cwd: string;
  projectName: string;
  projectRoot: string;
  includeRoots: string[];
  query: string;
}): Promise<{ register: StepRun<RegisterStepOutput>; project: StepRun<ProjectStepOutput> }> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['mcp/launcher.ts'],
    cwd: args.cwd,
    env: {
      ...(process.env as Record<string, string>),
      MCP_TOOLSET: 'projects',
      MCP_PERMISSION_MODE: 'read_write',
      RAG_PROJECT_WATCHER_ENABLED: 'false',
      MCP_BACKEND_AUTOSTART: 'false',
    },
  });
  const client = new Client(
    {
      name: 'rag-v1-codex-mcp-fallback',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);

    const registerStartedAt = performance.now();
    const registerRaw = await client.callTool({
      name: 'register_project',
      arguments: {
        name: args.projectName,
        rootPath: args.projectRoot,
        includeRoots: args.includeRoots,
        scopeAck: PROJECT_SCOPE_ACK_TOKEN,
      },
    });
    const registerElapsed = Math.round(performance.now() - registerStartedAt);
    const registerText =
      Array.isArray(registerRaw.content) && registerRaw.content[0]?.type === 'text'
        ? String(registerRaw.content[0].text ?? '')
        : '';
    const registerData =
      registerRaw.structuredContent && typeof registerRaw.structuredContent === 'object'
        ? (registerRaw.structuredContent as any)
        : undefined;
    const projectId =
      typeof registerData?.data?.projectId === 'string'
        ? registerData.data.projectId
        : (registerText.match(/"projectId"\s*:\s*"([^"]+)"/)?.[1] ?? null);

    const registerErrors: string[] = [];
    if (!projectId) {
      registerErrors.push('register_project fallback did not return projectId');
    }

    const projectStartedAt = performance.now();
    let projectCount = 0;
    let projectFirstSource: string | null = null;
    const projectErrors: string[] = [];

    if (projectId) {
      const projectRaw = await client.callTool({
        name: 'search_project_code',
        arguments: buildProjectSearchArguments(projectId, args.query),
      });
      const projectData =
        projectRaw.structuredContent && typeof projectRaw.structuredContent === 'object'
          ? (projectRaw.structuredContent as any)
          : undefined;
      const results = Array.isArray(projectData?.data?.results) ? projectData.data.results : [];
      projectCount = results.length;
      const firstSource = results.find(
        (entry: any) => typeof entry?.sourcePath === 'string'
      )?.sourcePath;
      projectFirstSource = typeof firstSource === 'string' ? firstSource : null;
      if (projectCount < 1) {
        projectErrors.push('search_project_code fallback returned no results');
      }
    }

    const projectElapsed = Math.round(performance.now() - projectStartedAt);

    return {
      register: {
        output: {
          project_id: projectId,
          errors: registerErrors,
        },
        stdout: '',
        elapsedMs: registerElapsed,
        observedMcpCalls: [],
        startupFailures: [],
      },
      project: {
        output: {
          project_count: projectCount,
          project_first_source: projectFirstSource,
          errors: projectErrors,
        },
        stdout: '',
        elapsedMs: projectElapsed,
        observedMcpCalls: [],
        startupFailures: [],
      },
    };
  } catch (error) {
    const message = formatErrorForOutput(error);
    return {
      register: {
        output: { project_id: null, errors: [`direct fallback failed: ${message}`] },
        stdout: '',
        elapsedMs: 0,
        observedMcpCalls: [],
        startupFailures: [],
      },
      project: {
        output: { project_count: 0, project_first_source: null, errors: [] },
        stdout: '',
        elapsedMs: 0,
        observedMcpCalls: [],
        startupFailures: [],
      },
    };
  } finally {
    await transport.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientCwd = args.cwd ?? process.cwd();
  const projectRoot = args.projectRoot ?? clientCwd;
  const computedIncludeRoots =
    args.includeRoots
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? defaultSmokeIncludeRoots(projectRoot);
  if (computedIncludeRoots.length === 0) {
    throw new Error(
      `No include roots could be determined for ${projectRoot}. Pass --include-roots <dir,dir>.`
    );
  }
  const projectName = basename(projectRoot);
  const includeRoots = await resolveSmokeProjectIncludeRoots(projectName, computedIncludeRoots);
  const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 180000;

  const startedAt = performance.now();

  let docsAttempts = 0;
  let docsRetryReason: string | null = null;
  const runDocsStep = () => {
    docsAttempts += 1;
    return runCodexStep<DocsStepOutput>({
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      cwd: clientCwd,
      timeoutMs,
      prompt: buildDocsSearchPrompt(),
      expectedMcpCalls: [
        { server: 'rag-docs-read', tool: 'health_check' },
        { server: 'rag-docs-read', tool: 'search_docs' },
      ],
      mcpServerScope: 'docs',
      mcpToolScope: 'docs',
      parseOutput: (raw) => parseStructuredJson<DocsStepOutput>(raw),
    });
  };
  let docsStep = runDocsStep();
  if (shouldRetryCodexMcpStep(docsStep)) {
    docsRetryReason =
      docsStep.output.errors.find((error) =>
        /not available|not exposed|not observed|no direct MCP|does not expose/i.test(error)
      ) ?? 'Codex MCP binding was not observed';
    docsStep = runDocsStep();
  }
  const healthAttempts = docsAttempts;
  const healthRetryReason = docsRetryReason;
  let healthStep: StepRun<HealthStepOutput> = {
    output: { health: docsStep.output.health ?? '', errors: [] },
    stdout: '',
    elapsedMs: docsStep.elapsedMs,
    observedMcpCalls: [],
    startupFailures: [],
  };

  let registerStep: StepRun<RegisterStepOutput> | null = null;
  let projectStep: StepRun<ProjectStepOutput> | null = null;
  let fullProjectStep: StepRun<FullProjectStepOutput> | null = null;
  let projectAttempts = 0;
  let projectRetryReason: string | null = null;
  let usedDirectFallback = false;
  let projectFallbackError: string | undefined;

  if (!args.strictCodex && shouldUseDirectFallbackForCodexMcp([healthStep, docsStep])) {
    usedDirectFallback = true;
    const fallback = await runDirectDocsFallback({
      cwd: clientCwd,
      query: 'Bun.serve routes',
    });
    healthStep = fallback.health;
    docsStep = fallback.docs;
  }

  if (!args.docsOnly) {
    try {
      const runFullProjectStep = () => {
        projectAttempts += 1;
        const projectId = createProjectSlug(projectName);
        return runCodexStep<FullProjectStepOutput>({
          model: args.model,
          reasoningEffort: args.reasoningEffort,
          cwd: clientCwd,
          timeoutMs,
          prompt: args.strictCodex
            ? buildReadOnlyProjectPrompt({
                projectId,
                projectQuery: args.projectQuery,
              })
            : buildFullProjectPrompt({
                projectName,
                projectRoot,
                includeRoots,
                projectQuery: args.projectQuery,
              }),
          expectedMcpCalls: args.strictCodex
            ? [
                { server: 'rag-projects-read', tool: 'verify_project_index' },
                { server: 'rag-projects-read', tool: 'search_project_code' },
              ]
            : [
                { server: 'rag-projects', tool: 'register_project' },
                { server: 'rag-projects', tool: 'ingest_project' },
                { server: 'rag-projects', tool: 'search_project_code' },
              ],
          mcpServerScope: 'projects',
          mcpToolScope: args.strictCodex ? 'project-read' : 'projects',
          parseOutput: (raw) => parseStructuredJson<ReadOnlyProjectStepOutput>(raw),
        });
      };

      fullProjectStep = runFullProjectStep();
      if (shouldRetryCodexMcpStep(fullProjectStep)) {
        projectRetryReason =
          fullProjectStep.output.errors.find((error) =>
            /not available|not exposed|not observed|no direct MCP|does not expose/i.test(error)
          ) ?? 'Codex MCP binding was not observed';
        fullProjectStep = runFullProjectStep();
      }
    } catch (error) {
      if (args.strictCodex) {
        throw error;
      }
      usedDirectFallback = true;
      projectFallbackError = formatErrorForOutput(error);
      const fallback = await runDirectProjectFallback({
        cwd: clientCwd,
        projectName,
        projectRoot,
        includeRoots,
        query: args.projectQuery,
      });
      registerStep = fallback.register;
      projectStep = fallback.project;
    }
  }

  const summary = parseSummary(
    JSON.stringify({
      mode: args.docsOnly ? 'docs-only' : 'full',
      health: healthStep.output.health,
      docs_count: docsStep.output.docs_count,
      docs_first_source: docsStep.output.docs_first_source,
      project_id: fullProjectStep?.output.project_id ?? registerStep?.output.project_id ?? null,
      project_count:
        fullProjectStep?.output.project_count ?? projectStep?.output.project_count ?? 0,
      project_first_source:
        fullProjectStep?.output.project_first_source ??
        projectStep?.output.project_first_source ??
        null,
      errors: [
        ...healthStep.output.errors,
        ...docsStep.output.errors,
        ...(fullProjectStep?.output.errors ?? []),
        ...(registerStep?.output.errors ?? []),
        ...(projectStep?.output.errors ?? []),
        ...(projectFallbackError ? [projectFallbackError] : []),
      ],
    })
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  const toolLatencies = [
    ...parseToolLatencies(healthStep.stdout),
    ...parseToolLatencies(docsStep.stdout),
    ...(fullProjectStep ? parseToolLatencies(fullProjectStep.stdout) : []),
    ...(registerStep ? parseToolLatencies(registerStep.stdout) : []),
    ...(projectStep ? parseToolLatencies(projectStep.stdout) : []),
  ];
  const startupFailures = [
    ...healthStep.startupFailures,
    ...docsStep.startupFailures,
    ...(fullProjectStep?.startupFailures ?? []),
    ...(registerStep?.startupFailures ?? []),
    ...(projectStep?.startupFailures ?? []),
  ];
  const observedMcpCalls = [
    ...healthStep.observedMcpCalls,
    ...docsStep.observedMcpCalls,
    ...(fullProjectStep?.observedMcpCalls ?? []),
    ...(registerStep?.observedMcpCalls ?? []),
    ...(projectStep?.observedMcpCalls ?? []),
  ];
  const failures = validateSummary(summary);
  if (args.strictCodex && usedDirectFallback) {
    failures.push('direct MCP fallback used in strict Codex mode');
  }
  if (
    args.strictCodex &&
    !args.docsOnly &&
    (fullProjectStep?.output as Partial<ReadOnlyProjectStepOutput> | undefined)?.project_ready !==
      true
  ) {
    failures.push('Project RAG verify_project_index did not report gateSignal.ready=true');
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: failures.length === 0,
          model: args.model,
          reasoning_effort: args.reasoningEffort,
          cwd: clientCwd,
          project_root: projectRoot,
          strict_codex: args.strictCodex,
          health_attempts: healthAttempts,
          health_retry_reason: healthRetryReason ? redactCredentialText(healthRetryReason) : null,
          docs_attempts: docsAttempts,
          docs_retry_reason: docsRetryReason ? redactCredentialText(docsRetryReason) : null,
          project_attempts: projectAttempts,
          project_retry_reason: projectRetryReason
            ? redactCredentialText(projectRetryReason)
            : null,
          used_direct_fallback: usedDirectFallback,
          elapsed_ms: elapsedMs,
          tool_latencies: toolLatencies,
          observed_mcp_calls: observedMcpCalls.map((call) => ({
            ...call,
            error: call.error ? redactCredentialText(call.error) : null,
          })),
          startup_failures: startupFailures.map((sf) => ({
            ...sf,
            reason: redactCredentialText(sf.reason),
          })),
          summary: {
            ...summary,
            errors: summary.errors.map((error) => redactCredentialText(error)),
          },
          failures,
        },
        null,
        2
      )
    );
  } else {
    console.log('Codex MCP smoke test');
    console.log('====================');
    console.log(`Model: ${args.model} (${args.reasoningEffort})`);
    console.log(`Client cwd: ${clientCwd}`);
    console.log(`Project root: ${projectRoot}`);
    console.log(`Strict Codex: ${args.strictCodex ? 'yes' : 'no'}`);
    console.log(`Health Codex attempts: ${healthAttempts}`);
    if (healthRetryReason) {
      console.log(`Health Codex retry: ${redactCredentialText(healthRetryReason)}`);
    }
    console.log(`Docs Codex attempts: ${docsAttempts}`);
    if (docsRetryReason) {
      console.log(`Docs Codex retry: ${redactCredentialText(docsRetryReason)}`);
    }
    if (!args.docsOnly) {
      console.log(`Project Codex attempts: ${projectAttempts}`);
      if (projectRetryReason) {
        console.log(`Project Codex retry: ${redactCredentialText(projectRetryReason)}`);
      }
    }
    console.log(`Mode: ${summary.mode}`);
    if (usedDirectFallback) {
      console.log('Project fallback: direct MCP client path used');
    }
    console.log(`Elapsed: ${elapsedMs}ms`);
    console.log(`Health: ${summary.health}`);
    console.log(
      `Docs search: ${summary.docs_count} hit(s); first source: ${summary.docs_first_source ?? 'n/a'}`
    );
    if (summary.mode === 'full') {
      console.log(
        `Project search: ${summary.project_count} hit(s); first source: ${summary.project_first_source ?? 'n/a'}`
      );
      console.log(`Project ID: ${summary.project_id ?? 'n/a'}`);
    } else {
      console.log('Project validation: skipped (docs-only mode)');
    }
    if (toolLatencies.length > 0) {
      console.log(
        `Tool latencies: ${toolLatencies.map((entry) => `${entry.server}.${entry.tool}=${entry.latency_ms}ms`).join(', ')}`
      );
    }
    if (observedMcpCalls.length > 0) {
      console.log(
        `Observed MCP calls: ${observedMcpCalls.map((entry) => `${entry.server}.${entry.tool}=${entry.status}`).join(', ')}`
      );
    }
    if (startupFailures.length > 0) {
      console.log(
        `Startup failures: ${startupFailures.map((entry) => `${entry.server}: ${redactCredentialText(entry.reason)}`).join('; ')}`
      );
    }
    if (summary.errors.length > 0) {
      console.log(
        `Tool errors: ${summary.errors.map((error) => redactCredentialText(error)).join('; ')}`
      );
    }
    if (failures.length > 0) {
      console.log(`Failures: ${failures.join('; ')}`);
    }
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(formatErrorForOutput(error));
    process.exit(1);
  });
}
