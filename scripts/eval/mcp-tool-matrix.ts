import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import dotenv from 'dotenv';
import { formatErrorForOutput } from '../../lib/shared/credential-redact.js';
import { suggestProjectIncludeRoots } from '../../lib/shared/project-include-roots.js';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../lib/shared/project-scope-advisory.js';
import { readPositiveIntegerEnv, withTimeout } from '../../mcp/lib/timeout.js';
import { callerCanSeeMcpTool, resolveMcpCallerSurface } from './mcp-expected-surface.js';

dotenv.config({ path: '.env.local' });

type ToolPayload = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; timestamp?: string };
  rawText?: string;
  isError?: boolean;
  [key: string]: unknown;
};

type ToolRun = {
  name: string;
  target: 'surface' | 'docs' | 'system' | 'analysis' | 'current' | 'external';
  status: 'passed' | 'failed';
  latencyMs: number;
  detail: string;
};

export type McpProjectJourney = 'current' | 'external';
export type McpSkipClass = 'release-required' | 'diagnostic-optional';

export type McpReleaseEvidence = {
  status: 'complete' | 'incomplete' | 'diagnostic-only';
  eligible: boolean;
  missingJourneys: McpProjectJourney[];
};

type ProjectRegistration = {
  projectId: string;
  slug: string;
  created: boolean;
};

type HarnessArgs = {
  json: boolean;
  docsSurfaceOnly: boolean;
  refreshInventory: boolean;
  cwd: string;
  currentProjectRoot: string;
  currentProjectName: string;
  currentIncludeRoots: string[];
  currentProbeFile: string;
  currentSearchQuery: string;
  currentSymbolName: string;
  currentNavigationProbeFile: string;
  externalProjectRoot: string;
  externalProjectName: string;
  externalIncludeRoots: string[];
  externalProbeFile: string;
  externalExcludedPaths: string[];
  externalSearchQuery: string;
  externalSymbolName: string;
  docsQuery: string;
  cleanupExternal: boolean;
  skipAdaptation: boolean;
  externalSkipped: boolean;
  externalSkipReason?: 'externalProjectRootMissing' | 'externalProjectRootNotProvided';
};

type SkippedProjectSummary = {
  skipped: true;
  skipClass: McpSkipClass;
  reason:
    | 'docsSurfaceOnly'
    | 'callerCapability'
    | 'externalProjectRootMissing'
    | 'externalProjectRootNotProvided';
  path?: string;
};

type CurrentProjectSummary =
  | SkippedProjectSummary
  | {
      skipped: false;
      projectId: string;
      slug: string;
      searchHits: number;
      symbolMatches: number;
      referenceCount: number;
    };

type ExternalProjectSummary =
  | SkippedProjectSummary
  | {
      skipped: false;
      projectId: string;
      slug: string;
      indexedCount: number;
      invalidIndexedPaths: string[];
      excludedIndexedPaths: string[];
      searchHits: number;
      symbolMatches: number;
    };

export function summarizeMcpReleaseEvidence(
  docsSurfaceOnly: boolean,
  currentProject: CurrentProjectSummary,
  externalProject: ExternalProjectSummary
): McpReleaseEvidence {
  const missingJourneys: McpProjectJourney[] = [];
  if (currentProject.skipped) missingJourneys.push('current');
  if (externalProject.skipped) missingJourneys.push('external');

  if (docsSurfaceOnly) {
    return { status: 'diagnostic-only', eligible: false, missingJourneys };
  }
  if (missingJourneys.length > 0) {
    return { status: 'incomplete', eligible: false, missingJourneys };
  }
  return { status: 'complete', eligible: true, missingJourneys };
}

type HarnessSummary = {
  overallPass: boolean;
  diagnosticPass: boolean;
  releaseEvidence: McpReleaseEvidence;
  docsSurfaceOnly: boolean;
  surface: {
    discoverableCount: number;
    canonicalPublicCount: number;
    aliasPresent: boolean;
    missingCanonicalTools: string[];
  };
  currentProject: CurrentProjectSummary;
  externalProject: ExternalProjectSummary;
  docs: {
    sourcePath: string;
    categoryCount: number;
  };
  runs: ToolRun[];
};

type VerifyIndexData = {
  fileCount?: number;
  gateSignal?: {
    ready?: boolean;
    blockingFailureCode?: string | null;
  };
  freshness?: {
    status?: string;
  };
  scopeCoverage?: {
    extraIndexedPaths?: string[];
    ignoredIndexedPaths?: string[];
  };
};

const OPTIONAL_ADAPTATION_TOOLS = new Set(['adapt_docs', 'search_and_adapt']);

export function isOptionalAdaptationTool(name: string): boolean {
  return OPTIONAL_ADAPTATION_TOOLS.has(name);
}

/** Runs that are not part of core matrix pass/fail (e.g. informational cleanup). */
const NON_BLOCKING_RUNS = new Set(['cleanup_external']);

export function buildProjectSearchArguments(projectId: string, query: string, limit = 5) {
  return {
    projectId,
    query,
    limit,
    mode: 'hybrid' as const,
  };
}

export function isNonBlockingRun(name: string): boolean {
  return NON_BLOCKING_RUNS.has(name);
}

function readFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): HarnessArgs {
  const docsSurfaceOnly = readFlag(argv, '--docs-surface-only');
  const resolvedCwd = resolve(readStringFlag(argv, '--cwd') ?? cwd);
  const currentProjectRoot = resolve(readStringFlag(argv, '--current-project-root') ?? resolvedCwd);
  const currentIncludeRoots =
    splitCsv(readStringFlag(argv, '--current-include-roots')) ??
    suggestProjectIncludeRoots(currentProjectRoot);

  if (currentIncludeRoots.length === 0) {
    throw new Error('No include roots found for the current project.');
  }

  // External project is opt-in: without --external-project-root the harness
  // skips the external lane instead of assuming a machine-local default path.
  const externalProjectRootArg = readStringFlag(argv, '--external-project-root');
  const externalProjectRoot = externalProjectRootArg ? resolve(externalProjectRootArg) : '';
  const externalIncludeRoots = splitCsv(readStringFlag(argv, '--external-include-roots')) ?? [
    'src',
    'scripts',
  ];

  const externalExists = externalProjectRoot !== '' && existsSync(externalProjectRoot);
  const externalSkipped = !docsSurfaceOnly && !externalExists;
  const externalSkipReason:
    | 'externalProjectRootMissing'
    | 'externalProjectRootNotProvided'
    | undefined = externalSkipped
    ? externalProjectRoot === ''
      ? 'externalProjectRootNotProvided'
      : 'externalProjectRootMissing'
    : undefined;

  return {
    json: readFlag(argv, '--json'),
    docsSurfaceOnly,
    refreshInventory: readFlag(argv, '--refresh-inventory'),
    cwd: resolvedCwd,
    currentProjectRoot,
    currentProjectName:
      readStringFlag(argv, '--current-project-name') ?? basename(currentProjectRoot),
    currentIncludeRoots,
    currentProbeFile:
      readStringFlag(argv, '--current-probe-file') ?? 'lib/shared/project-scope-advisory.ts',
    currentSearchQuery:
      readStringFlag(argv, '--current-search-query') ?? 'buildProjectScopeAdvisory',
    currentSymbolName: readStringFlag(argv, '--current-symbol-name') ?? 'requireProjectScopeAck',
    currentNavigationProbeFile:
      readStringFlag(argv, '--current-navigation-probe-file') ?? 'mcp/server.ts',
    externalProjectRoot,
    externalProjectName:
      readStringFlag(argv, '--external-project-name') ?? basename(externalProjectRoot),
    externalIncludeRoots,
    externalProbeFile: readStringFlag(argv, '--external-probe-file') ?? 'src/mcp.js',
    externalExcludedPaths: splitCsv(readStringFlag(argv, '--external-excluded-paths')) ?? [
      'docs/README.md',
      'tmp-test/test-debug.js',
      'authenticate.js',
      'usage.js',
    ],
    externalSearchQuery: readStringFlag(argv, '--external-search-query') ?? 'mcpPostHandler',
    externalSymbolName: readStringFlag(argv, '--external-symbol-name') ?? 'mcpPostHandler',
    docsQuery: readStringFlag(argv, '--docs-query') ?? 'Bun.serve routes',
    cleanupExternal: !readFlag(argv, '--keep-external-project'),
    skipAdaptation: readFlag(argv, '--skip-adaptation'),
    externalSkipped,
    externalSkipReason,
  };
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function extractText(result: any): string {
  if (!Array.isArray(result?.content)) {
    return '';
  }

  return result.content
    .filter((entry: any) => entry?.type === 'text' && typeof entry.text === 'string')
    .map((entry: any) => entry.text)
    .join('\n');
}

export function extractPayload(result: any): ToolPayload {
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object') {
    return {
      ...(structured as ToolPayload),
      isError: Boolean(result?.isError),
      rawText: extractText(result),
    };
  }

  const rawText = extractText(result);
  if (!rawText) {
    return { isError: Boolean(result?.isError) };
  }

  try {
    return {
      ...(JSON.parse(rawText) as ToolPayload),
      isError: Boolean(result?.isError),
      rawText,
    };
  } catch {
    return { rawText, isError: Boolean(result?.isError) };
  }
}

export function requireSuccess(name: string, payload: ToolPayload): ToolPayload {
  if (payload.isError || payload.success === false) {
    throw new Error(
      `${name} failed: ${payload.error?.message ?? payload.rawText ?? 'unknown error'}`
    );
  }

  return payload;
}

export function requireHealthyHealthResult(name: string, payload: ToolPayload): ToolPayload {
  const successPayload = requireSuccess(name, payload);
  const components = successPayload.data?.components;
  ensure(Array.isArray(components), `${name} did not return structured components`);
  for (const component of components) {
    const entry = component as Record<string, unknown>;
    ensure(
      entry.status === 'OK',
      `${name} reported ${String(entry.component ?? 'unknown')}=${String(entry.status ?? 'unknown')}`
    );
  }
  return successPayload;
}

export function assertAdaptationResult(
  name: 'adapt_docs' | 'search_and_adapt',
  payload: ToolPayload,
  rawText: string
): string {
  requireSuccess(name, payload);
  ensure(rawText.trim().length >= 50, `${name} returned too little content`);
  return `chars=${rawText.length}`;
}

function countMarkdownResults(text: string | undefined): number {
  if (!text) return 0;
  return [...text.matchAll(/^##\s+\d+\.\s+/gm)].length;
}

function parseFirstDocsSourcePath(text: string): string | undefined {
  const match = text.match(/\*\*Source:\*\*\s+([^\s]+)/);
  return match?.[1];
}

/** SDK RequestOptions shape for timeout passthrough. */
export type SdkRequestOptions = { timeout: number };

/** Build SDK RequestOptions with the given timeout (milliseconds).
 * Exported for testability — verifies the object shape passed to the SDK. */
export function buildMcpRequestOptions(timeoutMs: number): SdkRequestOptions {
  return { timeout: timeoutMs };
}

/** Call an MCP tool with the configured timeout passed through to the SDK.
 * Exported for testability — encapsulates the exact SDK call signature so
 * a mock Client can be used without a live MCP server. */
export async function callToolWithTimeout(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({ name, arguments: args }, undefined, buildMcpRequestOptions(timeoutMs));
}

/** Connect an MCP client with the configured timeout passed through to the SDK.
 * Exported for testability — encapsulates the exact SDK call signature so
 * a mock Client can be used without a live MCP server. */
export async function connectWithTimeout(
  client: Client,
  transport: StdioClientTransport,
  timeoutMs: number
): Promise<void> {
  await client.connect(transport, buildMcpRequestOptions(timeoutMs));
}

function summarizeError(error: unknown): string {
  return formatErrorForOutput(error);
}

function normalizeStringArray(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
}

function pathMatchesAnyPrefix(sourcePath: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`));
}

function runInventory(cwd: string, projectSourcePath: string) {
  execFileSync('bun', ['run', 'inventory'], {
    cwd,
    env: {
      ...process.env,
      PROJECT_SOURCE_PATH: process.env.PROJECT_SOURCE_PATH ?? projectSourcePath,
    },
    stdio: 'pipe',
  });
}

async function cleanupProject(projectId: string | undefined, removeProject: boolean) {
  if (!projectId) {
    return 'skipped: no external project was registered';
  }
  if (!removeProject) {
    return 'skipped: keep-external-project requested';
  }
  return 'unsupported: no MCP cleanup surface; external project registration retained';
}

async function callTool(
  client: Client,
  runs: ToolRun[],
  name: string,
  target: ToolRun['target'],
  args: Record<string, unknown>,
  assertResult: (payload: ToolPayload, rawText: string) => Promise<string> | string,
  softFail = false
) {
  const toolTimeoutMs = readPositiveIntegerEnv('MCP_TOOL_TIMEOUT_MS', 120_000);
  const startedAt = performance.now();
  try {
    const response = await withTimeout(
      callToolWithTimeout(client, name, args, toolTimeoutMs),
      toolTimeoutMs,
      `MCP tool call "${name}"`
    );
    const latencyMs = Math.round(performance.now() - startedAt);
    const rawText = extractText(response);
    const payload = extractPayload(response);
    const detail = await assertResult(payload, rawText);
    runs.push({ name, target, status: 'passed', latencyMs, detail });
    return { payload, rawText, response };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    runs.push({
      name,
      target,
      status: 'failed',
      latencyMs,
      detail: summarizeError(error),
    });
    if (softFail) {
      return { payload: { isError: true } as ToolPayload, rawText: '', response: undefined };
    }
    throw error;
  }
}

async function registerProjectViaMcp(
  client: Client,
  runs: ToolRun[],
  target: 'current' | 'external',
  name: string,
  rootPath: string,
  includeRoots: string[]
): Promise<ProjectRegistration> {
  const { payload } = await callTool(
    client,
    runs,
    'register_project',
    target,
    {
      name,
      rootPath,
      includeRoots,
      scopeAck: PROJECT_SCOPE_ACK_TOKEN,
    },
    (toolPayload) => {
      const successPayload = requireSuccess('register_project', toolPayload);
      const projectId = successPayload.data?.projectId;
      const slug = successPayload.data?.slug;
      ensure(typeof projectId === 'string', 'register_project did not return projectId');
      ensure(typeof slug === 'string', 'register_project did not return slug');
      return `projectId=${projectId} slug=${slug} created=${successPayload.data?.created === true}`;
    }
  );

  const projectId = payload.data?.projectId;
  const slug = payload.data?.slug;
  const created = payload.data?.created === true;
  ensure(typeof projectId === 'string', 'register_project projectId missing');
  ensure(typeof slug === 'string', 'register_project slug missing');
  return { projectId, slug, created };
}

async function ingestProjectViaMcp(
  client: Client,
  runs: ToolRun[],
  target: 'current' | 'external',
  rootPath: string,
  includeRoots: string[]
) {
  await callTool(
    client,
    runs,
    'ingest_project',
    target,
    {
      rootPath,
      includeRoots,
      scopeAck: PROJECT_SCOPE_ACK_TOKEN,
    },
    (toolPayload) => {
      const successPayload = requireSuccess('ingest_project', toolPayload);
      const stats = successPayload.data?.stats as Record<string, unknown> | undefined;
      return `indexed=${stats?.filesAdded ?? 0} updated=${stats?.filesUpdated ?? 0} skipped=${stats?.filesSkipped ?? 0}`;
    }
  );
}

async function prepareProjectViaMcp(
  client: Client,
  runs: ToolRun[],
  target: 'current' | 'external',
  rootPath: string,
  projectId: string
): Promise<void> {
  await callTool(
    client,
    runs,
    'prepare_project',
    target,
    { rootPath, projectId, maxFiles: 120, maxBatches: 32 },
    (toolPayload) => {
      const successPayload = requireSuccess('prepare_project', toolPayload);
      const data = successPayload.data;
      ensure(data?.ready === true, 'prepare_project did not reach ready=true');
      ensure(data?.status === 'ready', `prepare_project returned status=${String(data?.status)}`);
      const progress = data?.progress as Record<string, unknown> | undefined;
      ensure(progress && typeof progress === 'object', 'prepare_project omitted progress');
      return `status=${String(data.status)} indexed=${String(progress.indexed ?? 0)} deduplicated=${String((data.operation as Record<string, unknown> | undefined)?.deduplicated ?? false)}`;
    }
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs: ToolRun[] = [];
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['mcp/launcher.ts'],
    cwd: args.cwd,
    // Preserve the caller's permission mode. The MCP server defaults to
    // read_only; write journeys must opt in explicitly in the environment.
    env: { ...process.env } as Record<string, string>,
  });
  const client = new Client(
    {
      name: 'rag-v1-mcp-tool-matrix',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  const connectTimeoutMs = readPositiveIntegerEnv('MCP_CONNECT_TIMEOUT_MS', 30_000);

  let currentRegistration: ProjectRegistration | undefined;
  let externalRegistration: ProjectRegistration | undefined;

  try {
    if (args.refreshInventory) {
      runInventory(args.cwd, args.currentProjectRoot);
    }

    await withTimeout(
      connectWithTimeout(client, transport, connectTimeoutMs),
      connectTimeoutMs,
      'MCP connect'
    );

    const toolsResponse = await client.listTools();
    const toolNames = toolsResponse.tools.map((tool) => tool.name);
    const toolSet = new Set(toolNames);
    const callerSurface = resolveMcpCallerSurface(process.env);
    const expectedTools = callerSurface.toolNames;
    const canSee = (name: string) =>
      callerCanSeeMcpTool(name, callerSurface.permissionMode, callerSurface.toolset);
    const missingCanonicalTools = expectedTools.filter((tool) => !toolSet.has(tool));
    const aliasExpected = canSee('search_project_docs');
    runs.push({
      name: 'tool_surface',
      target: 'surface',
      status:
        missingCanonicalTools.length === 0 && (!aliasExpected || toolSet.has('search_project_docs'))
          ? 'passed'
          : 'failed',
      latencyMs: 0,
      detail: `discoverable=${toolNames.length} missing=${missingCanonicalTools.length}`,
    });
    ensure(
      missingCanonicalTools.length === 0,
      `Missing caller-visible tools: ${missingCanonicalTools.join(', ')}`
    );
    if (aliasExpected) {
      ensure(toolSet.has('search_project_docs'), 'Deprecated alias search_project_docs is missing');
    }

    if (canSee('ensure_reranker')) {
      await callTool(
        client,
        runs,
        'ensure_reranker',
        'system',
        { timeout: 30 },
        (payload, rawText) => {
          ensure(!payload.isError, 'ensure_reranker returned isError');
          ensure(
            rawText.includes('Reranker Service'),
            'ensure_reranker did not describe reranker state'
          );
          return rawText.split('\n')[0] ?? 'reranker ensured';
        },
        true
      );
    }

    if (canSee('health_check')) {
      await callTool(client, runs, 'health_check', 'system', {}, (payload) => {
        requireHealthyHealthResult('health_check', payload);
        return 'MCP and Docs RAG components healthy';
      });
    }

    let categoryCount = 0;
    let docsSourcePath = '';
    let getDocumentText = '';
    if (canSee('list_categories')) {
      const { rawText: listCategoriesText } = await callTool(
        client,
        runs,
        'list_categories',
        'docs',
        {},
        (_payload, rawText) => {
          const count = [...rawText.matchAll(/^##\s+/gm)].length;
          ensure(count > 0, 'list_categories returned no categories');
          return `categories=${count}`;
        }
      );
      categoryCount = [...listCategoriesText.matchAll(/^##\s+/gm)].length;
    }

    if (canSee('search_docs')) {
      const { rawText: searchDocsText } = await callTool(
        client,
        runs,
        'search_docs',
        'docs',
        {
          query: args.docsQuery,
          limit: 5,
        },
        (_payload, rawText) => {
          ensure(rawText.includes('Found '), 'search_docs did not report results');
          ensure(countMarkdownResults(rawText) > 0, 'search_docs returned zero markdown hits');
          return `hits=${countMarkdownResults(rawText)}`;
        }
      );
      docsSourcePath = parseFirstDocsSourcePath(searchDocsText) ?? '';
      ensure(docsSourcePath, 'Could not extract sourcePath from search_docs');

      if (canSee('get_document')) {
        const documentResult = await callTool(
          client,
          runs,
          'get_document',
          'docs',
          { sourcePath: docsSourcePath },
          (_payload, rawText) => {
            ensure(rawText.includes(docsSourcePath), 'get_document returned unexpected path');
            ensure(rawText.includes('### Chunk 0'), 'get_document did not return chunk content');
            return `path=${docsSourcePath}`;
          }
        );
        getDocumentText = documentResult.rawText;
      }
    }

    const projectWriteJourneyVisible =
      !args.docsSurfaceOnly &&
      ['register_project', 'ingest_project', 'ingest_project_file', 'prepare_project'].every(
        canSee
      );
    const projectSkipClass: McpSkipClass = args.docsSurfaceOnly
      ? 'diagnostic-optional'
      : 'release-required';
    let currentProject: CurrentProjectSummary = {
      skipped: true,
      skipClass: projectSkipClass,
      reason: args.docsSurfaceOnly ? 'docsSurfaceOnly' : 'callerCapability',
    };
    let externalProject: ExternalProjectSummary = args.externalSkipped
      ? {
          skipped: true,
          skipClass: projectSkipClass,
          reason: args.externalSkipReason ?? 'externalProjectRootMissing',
          path: args.externalProjectRoot || undefined,
        }
      : {
          skipped: true,
          skipClass: projectSkipClass,
          reason: args.docsSurfaceOnly ? 'docsSurfaceOnly' : 'callerCapability',
        };

    if (projectWriteJourneyVisible) {
      currentRegistration = await registerProjectViaMcp(
        client,
        runs,
        'current',
        args.currentProjectName,
        args.currentProjectRoot,
        args.currentIncludeRoots
      );

      await ingestProjectViaMcp(
        client,
        runs,
        'current',
        args.currentProjectRoot,
        args.currentIncludeRoots
      );

      await prepareProjectViaMcp(
        client,
        runs,
        'current',
        args.currentProjectRoot,
        currentRegistration.projectId
      );

      await callTool(
        client,
        runs,
        'verify_project_index',
        'current',
        { projectId: currentRegistration.projectId },
        (payload, rawText) => {
          const successPayload = requireSuccess('verify_project_index', payload);
          const gateSignal = successPayload.data?.gateSignal as
            | { ready?: boolean; blockingFailureCode?: string | null }
            | undefined;
          ensure(
            typeof gateSignal?.ready === 'boolean',
            'verify_project_index missing semantic gateSignal.ready'
          );
          ensure(
            gateSignal.ready === true,
            `verify_project_index semantic gate blocked (${gateSignal.blockingFailureCode ?? 'unknown'})`
          );
          const fileCount = successPayload.data?.fileCount;
          ensure(
            typeof fileCount === 'number' && fileCount > 0,
            'verify_project_index reported zero files'
          );
          ensure(
            rawText.includes('## Freshness'),
            'verify_project_index missing freshness section'
          );
          return `files=${fileCount} gate=${gateSignal.blockingFailureCode ?? 'none'}`;
        }
      );

      await callTool(
        client,
        runs,
        'ingest_project_file',
        'current',
        {
          filePath: resolve(args.currentProjectRoot, args.currentProbeFile),
          rootPath: args.currentProjectRoot,
          scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        },
        (payload) => {
          const successPayload = requireSuccess('ingest_project_file', payload);
          const ingestStatus =
            typeof successPayload.data?.result === 'object' &&
            successPayload.data?.result !== null &&
            'status' in successPayload.data.result
              ? (successPayload.data.result as { status?: unknown }).status
              : undefined;
          ensure(
            ingestStatus === 'indexed' || ingestStatus === 'skipped',
            'ingest_project_file returned unexpected status'
          );
          return `${args.currentProbeFile} status=${String(ingestStatus ?? 'unknown')}`;
        }
      );

      const currentSearch = await callTool(
        client,
        runs,
        'search_project_code',
        'current',
        buildProjectSearchArguments(currentRegistration.projectId, args.currentSearchQuery),
        (payload) => {
          const successPayload = requireSuccess('search_project_code', payload);
          const results = successPayload.data?.results as
            | Array<{ sourcePath?: string }>
            | undefined;
          ensure(
            Array.isArray(results) && results.length > 0,
            'search_project_code returned no results'
          );
          ensure(
            results.some((result) => result.sourcePath === args.currentProbeFile),
            `search_project_code did not surface ${args.currentProbeFile}`
          );
          return `hits=${results.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'search_project_docs',
        'current',
        buildProjectSearchArguments(currentRegistration.projectId, args.currentSearchQuery),
        (payload) => {
          const successPayload = requireSuccess('search_project_docs', payload);
          const results = successPayload.data?.results as
            | Array<{ sourcePath?: string }>
            | undefined;
          ensure(
            Array.isArray(results) && results.length > 0,
            'search_project_docs alias returned no results'
          );
          return `hits=${results.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_project_outline',
        'current',
        {
          projectId: currentRegistration.projectId,
          sourcePath: args.currentProbeFile,
        },
        (payload) => {
          const successPayload = requireSuccess('get_project_outline', payload);
          const symbols = successPayload.data?.symbols as Array<{ name?: string }> | undefined;
          ensure(
            Array.isArray(symbols) && symbols.length > 0,
            'get_project_outline returned no symbols'
          );
          ensure(
            symbols.some((symbol) => symbol.name === args.currentSymbolName),
            `get_project_outline missing ${args.currentSymbolName}`
          );
          return `symbols=${symbols.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_project_file',
        'current',
        {
          projectId: currentRegistration.projectId,
          sourcePath: args.currentProbeFile,
        },
        (payload) => {
          const successPayload = requireSuccess('get_project_file', payload);
          const chunks = successPayload.data?.chunks as Array<{ chunkIndex?: number }> | undefined;
          ensure(Array.isArray(chunks) && chunks.length > 0, 'get_project_file returned no chunks');
          return `chunks=${chunks.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_project_skeleton',
        'current',
        {
          projectId: currentRegistration.projectId,
          sourcePath: args.currentProbeFile,
        },
        (payload) => {
          const successPayload = requireSuccess('get_project_skeleton', payload);
          const skeletonText = successPayload.data?.skeletonText;
          ensure(
            typeof skeletonText === 'string' && skeletonText.trim().length > 0,
            'get_project_skeleton returned empty skeleton'
          );
          return `chars=${skeletonText.length}`;
        }
      );

      const currentFindSymbol = await callTool(
        client,
        runs,
        'find_project_symbol',
        'current',
        {
          projectId: currentRegistration.projectId,
          symbolName: args.currentSymbolName,
          limit: 10,
        },
        (payload) => {
          const successPayload = requireSuccess('find_project_symbol', payload);
          const symbols = successPayload.data?.symbols as
            | Array<{ sourcePath?: string }>
            | undefined;
          ensure(
            Array.isArray(symbols) && symbols.length > 0,
            'find_project_symbol returned no matches'
          );
          ensure(
            symbols.some((symbol) => symbol.sourcePath === args.currentProbeFile),
            `find_project_symbol did not return ${args.currentProbeFile}`
          );
          return `matches=${symbols.length}`;
        }
      );

      const currentReferences = await callTool(
        client,
        runs,
        'find_symbol_references',
        'current',
        {
          projectId: currentRegistration.projectId,
          symbolName: args.currentSymbolName,
          limit: 20,
        },
        (payload) => {
          const successPayload = requireSuccess('find_symbol_references', payload);
          const references = successPayload.data?.references as
            | Array<{ sourcePath?: string }>
            | undefined;
          ensure(
            Array.isArray(references) && references.length > 0,
            'find_symbol_references returned no references'
          );
          return `references=${references.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_semantic_clusters',
        'current',
        { projectId: currentRegistration.projectId, maxClusters: 5, minClusterSize: 2 },
        (payload) => {
          const successPayload = requireSuccess('get_semantic_clusters', payload);
          const clusters = successPayload.data?.clusters as
            | Array<{ topicLabel?: string }>
            | undefined;
          ensure(
            Array.isArray(clusters) && clusters.length > 0,
            'get_semantic_clusters returned no clusters'
          );
          return `clusters=${clusters.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_directory_groups',
        'current',
        { projectId: currentRegistration.projectId, minFiles: 2 },
        (payload) => {
          const successPayload = requireSuccess('get_directory_groups', payload);
          const hubs = successPayload.data?.hubs as Array<{ directory?: string }> | undefined;
          ensure(Array.isArray(hubs) && hubs.length > 0, 'get_directory_groups returned no groups');
          return `hubs=${hubs.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_navigation_paths',
        'current',
        {
          projectId: currentRegistration.projectId,
          sourcePath: args.currentNavigationProbeFile,
          limit: 10,
        },
        (payload) => {
          const successPayload = requireSuccess('get_navigation_paths', payload);
          const paths = successPayload.data?.paths as Array<{ sourcePath?: string }> | undefined;
          ensure(
            Array.isArray(paths) && paths.length > 0,
            'get_navigation_paths returned no paths'
          );
          return `paths=${paths.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_topic_groups',
        'current',
        { projectId: currentRegistration.projectId, maxTopics: 5, minTopicSize: 2 },
        (payload) => {
          const successPayload = requireSuccess('get_topic_groups', payload);
          const topics = successPayload.data?.topics as Array<{ name?: string }> | undefined;
          ensure(Array.isArray(topics) && topics.length > 0, 'get_topic_groups returned no topics');
          return `topics=${topics.length}`;
        }
      );

      const currentSearchResults =
        (currentSearch.payload.data?.results as Array<Record<string, unknown>> | undefined) ?? [];
      const currentSymbolMatches =
        (currentFindSymbol.payload.data?.symbols as Array<Record<string, unknown>> | undefined) ??
        [];
      const currentReferencesCount = (
        (currentReferences.payload.data?.references as
          | Array<Record<string, unknown>>
          | undefined) ?? []
      ).length;

      currentProject = {
        skipped: false,
        projectId: currentRegistration.projectId,
        slug: currentRegistration.slug,
        searchHits: currentSearchResults.length,
        symbolMatches: currentSymbolMatches.length,
        referenceCount: currentReferencesCount,
      };
    }

    if (projectWriteJourneyVisible && !args.docsSurfaceOnly && !args.externalSkipped) {
      externalRegistration = await registerProjectViaMcp(
        client,
        runs,
        'external',
        args.externalProjectName,
        args.externalProjectRoot,
        args.externalIncludeRoots
      );

      await ingestProjectViaMcp(
        client,
        runs,
        'external',
        args.externalProjectRoot,
        args.externalIncludeRoots
      );

      await prepareProjectViaMcp(
        client,
        runs,
        'external',
        args.externalProjectRoot,
        externalRegistration.projectId
      );

      const externalVerify = await callTool(
        client,
        runs,
        'verify_project_index',
        'external',
        { projectId: externalRegistration.projectId },
        (payload) => {
          const successPayload = requireSuccess('verify_project_index', payload);
          const gateSignal = successPayload.data?.gateSignal as
            | { ready?: boolean; blockingFailureCode?: string | null }
            | undefined;
          ensure(
            typeof gateSignal?.ready === 'boolean',
            'external verify_project_index missing semantic gateSignal.ready'
          );
          ensure(
            gateSignal.ready === true,
            `external verify_project_index semantic gate blocked (${gateSignal.blockingFailureCode ?? 'unknown'})`
          );
          const fileCount = successPayload.data?.fileCount;
          ensure(
            typeof fileCount === 'number' && fileCount > 0,
            'external verify_project_index reported zero files'
          );
          return `files=${fileCount} gate=${gateSignal.blockingFailureCode ?? 'none'}`;
        }
      );
      const externalVerifyData = externalVerify.payload.data as VerifyIndexData | undefined;

      await callTool(
        client,
        runs,
        'ingest_project_file',
        'external',
        {
          filePath: resolve(args.externalProjectRoot, args.externalProbeFile),
          rootPath: args.externalProjectRoot,
          scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        },
        (payload) => {
          const successPayload = requireSuccess('ingest_project_file', payload);
          const ingestStatus =
            typeof successPayload.data?.result === 'object' &&
            successPayload.data?.result !== null &&
            'status' in successPayload.data.result
              ? (successPayload.data.result as { status?: unknown }).status
              : undefined;
          ensure(
            ingestStatus === 'indexed' || ingestStatus === 'skipped',
            'external ingest_project_file returned unexpected status'
          );
          return `${args.externalProbeFile} status=${String(ingestStatus ?? 'unknown')}`;
        }
      );

      const externalSearch = await callTool(
        client,
        runs,
        'search_project_code',
        'external',
        buildProjectSearchArguments(externalRegistration.projectId, args.externalSearchQuery),
        (payload) => {
          const successPayload = requireSuccess('search_project_code', payload);
          const results = successPayload.data?.results as
            | Array<{ sourcePath?: string }>
            | undefined;
          ensure(
            Array.isArray(results) && results.length > 0,
            'external search_project_code returned no results'
          );
          ensure(
            results.some((result) => result.sourcePath === args.externalProbeFile),
            `external search did not surface ${args.externalProbeFile}`
          );
          return `hits=${results.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_project_outline',
        'external',
        {
          projectId: externalRegistration.projectId,
          sourcePath: args.externalProbeFile,
        },
        (payload) => {
          const successPayload = requireSuccess('get_project_outline', payload);
          const symbols = successPayload.data?.symbols as Array<{ name?: string }> | undefined;
          ensure(
            Array.isArray(symbols) && symbols.length > 0,
            'external get_project_outline returned no symbols'
          );
          ensure(
            symbols.some((symbol) => symbol.name === args.externalSymbolName),
            `external get_project_outline missing ${args.externalSymbolName}`
          );
          return `symbols=${symbols.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_project_file',
        'external',
        {
          projectId: externalRegistration.projectId,
          sourcePath: args.externalProbeFile,
        },
        (payload) => {
          const successPayload = requireSuccess('get_project_file', payload);
          const chunks = successPayload.data?.chunks as Array<{ chunkIndex?: number }> | undefined;
          ensure(
            Array.isArray(chunks) && chunks.length > 0,
            'external get_project_file returned no chunks'
          );
          return `chunks=${chunks.length}`;
        }
      );

      await callTool(
        client,
        runs,
        'get_project_skeleton',
        'external',
        {
          projectId: externalRegistration.projectId,
          sourcePath: args.externalProbeFile,
        },
        (payload) => {
          const successPayload = requireSuccess('get_project_skeleton', payload);
          const skeletonText = successPayload.data?.skeletonText;
          ensure(
            typeof skeletonText === 'string' && skeletonText.trim().length > 0,
            'external get_project_skeleton returned empty skeleton'
          );
          return `chars=${skeletonText.length}`;
        }
      );

      const externalFindSymbol = await callTool(
        client,
        runs,
        'find_project_symbol',
        'external',
        {
          projectId: externalRegistration.projectId,
          symbolName: args.externalSymbolName,
          limit: 10,
        },
        (payload) => {
          const successPayload = requireSuccess('find_project_symbol', payload);
          const symbols = successPayload.data?.symbols as
            | Array<{ sourcePath?: string }>
            | undefined;
          ensure(
            Array.isArray(symbols) && symbols.length > 0,
            'external find_project_symbol returned no matches'
          );
          return `matches=${symbols.length}`;
        }
      );

      const externalScopeCoverage = externalVerifyData?.scopeCoverage;
      const invalidIndexedPaths = normalizeStringArray(externalScopeCoverage?.extraIndexedPaths);
      const excludedIndexedPaths = [
        ...Array.from(
          new Set(
            normalizeStringArray(externalScopeCoverage?.ignoredIndexedPaths).filter((sourcePath) =>
              pathMatchesAnyPrefix(sourcePath, args.externalExcludedPaths)
            )
          )
        ),
      ];

      ensure(
        invalidIndexedPaths.length === 0,
        `external project indexed paths outside scope: ${invalidIndexedPaths.join(', ')}`
      );
      ensure(
        excludedIndexedPaths.length === 0,
        `external project indexed excluded paths: ${excludedIndexedPaths.join(', ')}`
      );

      const externalSearchResults =
        (externalSearch.payload.data?.results as Array<Record<string, unknown>> | undefined) ?? [];
      const externalSymbolMatches =
        (externalFindSymbol.payload.data?.symbols as Array<Record<string, unknown>> | undefined) ??
        [];

      externalProject = {
        skipped: false,
        projectId: externalRegistration.projectId,
        slug: externalRegistration.slug,
        indexedCount:
          typeof externalVerifyData?.fileCount === 'number'
            ? externalVerifyData.fileCount
            : externalSearchResults.length,
        invalidIndexedPaths,
        excludedIndexedPaths,
        searchHits: externalSearchResults.length,
        symbolMatches: externalSymbolMatches.length,
      };

      const cleanupDetail = await cleanupProject(
        externalRegistration.projectId,
        Boolean(externalRegistration.created && args.cleanupExternal)
      );

      runs.push({
        name: 'cleanup_external',
        target: 'external',
        status: 'passed',
        latencyMs: 0,
        detail: cleanupDetail,
      });
    }

    // ── Optional adaptation (local-only deterministic; deferred after core probes) ──
    if (
      !args.skipAdaptation &&
      canSee('adapt_docs') &&
      canSee('search_and_adapt') &&
      canSee('get_document')
    ) {
      try {
        const adaptSnippet = getDocumentText.slice(0, 1_200);
        await callTool(
          client,
          runs,
          'adapt_docs',
          'docs',
          {
            content: adaptSnippet,
            context: 'quick-ref',
            maxLength: 1_500,
            preserveCode: true,
          },
          (payload, rawText) => assertAdaptationResult('adapt_docs', payload, rawText),
          true
        );

        await callTool(
          client,
          runs,
          'search_and_adapt',
          'docs',
          {
            query: args.docsQuery,
            context: 'senior',
            limit: 3,
            maxLength: 1_500,
          },
          (payload, rawText) => assertAdaptationResult('search_and_adapt', payload, rawText),
          true
        );
      } catch (adaptError) {
        // Transport-level crash (e.g. connection dropped after timeout).
        // Record soft failure for any tools not already recorded by callTool's softFail handler.
        const detail = summarizeError(adaptError);
        for (const name of ['adapt_docs', 'search_and_adapt']) {
          if (!runs.some((r) => r.name === name)) {
            runs.push({ name, target: 'docs', status: 'failed', latencyMs: 0, detail });
          }
        }
      }
    }

    const diagnosticPass = runs
      .filter((run) => !isNonBlockingRun(run.name))
      .every((run) => run.status === 'passed');
    const releaseEvidence = summarizeMcpReleaseEvidence(
      args.docsSurfaceOnly,
      currentProject,
      externalProject
    );
    // A docs-only run may pass its diagnostic slice, but never becomes full
    // release evidence without both project journeys.
    const summary: HarnessSummary = {
      overallPass: diagnosticPass && (args.docsSurfaceOnly || releaseEvidence.eligible),
      diagnosticPass,
      releaseEvidence,
      docsSurfaceOnly: args.docsSurfaceOnly,
      surface: {
        discoverableCount: toolNames.length,
        canonicalPublicCount: expectedTools.length,
        aliasPresent: toolSet.has('search_project_docs'),
        missingCanonicalTools,
      },
      currentProject,
      externalProject,
      docs: {
        sourcePath: docsSourcePath,
        categoryCount,
      },
      runs,
    };
    process.exitCode = summary.overallPass ? 0 : 1;

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log('MCP tool matrix');
    console.log(`- discoverable tools: ${summary.surface.discoverableCount}`);
    console.log(`- canonical tools: ${summary.surface.canonicalPublicCount}`);
    console.log(`- alias present: ${summary.surface.aliasPresent ? 'yes' : 'no'}`);
    console.log(`- docs source path: ${summary.docs.sourcePath}`);
    if (!summary.currentProject.skipped && !summary.externalProject.skipped) {
      const currentProject = summary.currentProject;
      const externalProject = summary.externalProject;
      console.log(`- current project: ${currentProject.slug} (${currentProject.projectId})`);
      console.log(`- external project: ${externalProject.slug} (${externalProject.projectId})`);
      console.log(`- external indexed files: ${externalProject.indexedCount}`);
      console.log(
        `- external invalid indexed paths: ${externalProject.invalidIndexedPaths.length}`
      );
      console.log(
        `- external excluded indexed paths: ${externalProject.excludedIndexedPaths.length}`
      );
    } else {
      if (summary.currentProject.skipped) {
        console.log(
          `- current project: skipped (${summary.currentProject.reason === 'docsSurfaceOnly' ? 'docs-surface-only' : 'caller lacks project write capability'})`
        );
      } else {
        const currentProject = summary.currentProject;
        console.log(`- current project: ${currentProject.slug} (${currentProject.projectId})`);
      }
      if (summary.externalProject.skipped) {
        const ext = summary.externalProject;
        if (ext.reason === 'externalProjectRootNotProvided') {
          console.log('- external project: skipped (--external-project-root not provided)');
        } else if (ext.reason === 'externalProjectRootMissing') {
          console.log(
            `- external project: skipped (path not found: ${ext.path ?? args.externalProjectRoot}; pass --external-project-root to enable)`
          );
        } else {
          console.log(
            `- external project: skipped (${ext.reason === 'docsSurfaceOnly' ? 'docs-surface-only' : 'caller lacks project write capability'})`
          );
        }
      } else {
        const externalProject = summary.externalProject;
        console.log(`- external project: ${externalProject.slug} (${externalProject.projectId})`);
        console.log(`- external indexed files: ${externalProject.indexedCount}`);
        console.log(
          `- external invalid indexed paths: ${externalProject.invalidIndexedPaths.length}`
        );
        console.log(
          `- external excluded indexed paths: ${externalProject.excludedIndexedPaths.length}`
        );
      }
    }
    console.log(`- diagnostic pass: ${summary.diagnosticPass ? 'PASS' : 'FAIL'}`);
    console.log(
      `- release evidence: ${summary.releaseEvidence.status} (${summary.releaseEvidence.eligible ? 'eligible' : 'not eligible'})`
    );
    if (summary.releaseEvidence.missingJourneys.length > 0) {
      console.log(
        `- missing project journeys: ${summary.releaseEvidence.missingJourneys.join(', ')}`
      );
    }
    console.log(`- overall: ${summary.overallPass ? 'PASS' : 'FAIL'}`);
    const optionalFailures = runs.filter(
      (run) => run.status === 'failed' && isOptionalAdaptationTool(run.name)
    );
    if (optionalFailures.length > 0) {
      for (const run of optionalFailures) {
        console.log(`  FAIL ${run.name}: ${run.detail} (soft-failed call; matrix fails)`);
      }
      console.log('  (optional adaptation tools failed; matrix marked FAIL)');
    }
    const nonBlockingRuns = runs.filter((run) => isNonBlockingRun(run.name));
    for (const run of nonBlockingRuns) {
      console.log(`  INFO ${run.name}: ${run.detail} (non-blocking)`);
    }
  } catch (error) {
    process.exitCode = 1;
    const failure = {
      overallPass: false,
      diagnosticPass: false,
      error: { message: summarizeError(error) },
      runs,
    };
    if (args.json) {
      console.log(JSON.stringify(failure, null, 2));
    } else {
      console.error(`MCP tool matrix failed: ${failure.error.message}`);
      for (const run of runs) {
        console.error(`  ${run.status.toUpperCase()} ${run.name}: ${run.detail}`);
      }
    }
  } finally {
    await transport.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(summarizeError(error));
    process.exit(1);
  });
}
