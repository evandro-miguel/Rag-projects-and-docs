import '../lib/runtime-env.js';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, parse, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatErrorForOutput } from '../../lib/shared/credential-redact.js';
import { suggestProjectIncludeRoots } from '../../lib/shared/project-include-roots.js';
import {
  createProjectSlug,
  inferProjectNameFromRootPath,
} from '../../lib/shared/project-registry.js';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../lib/shared/project-scope-advisory.js';
import { callerCanSeeMcpTool, resolveMcpCallerSurface } from './mcp-expected-surface.js';

type ToolPayload = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; timestamp?: string };
  rawText?: string;
  isError?: boolean;
  [key: string]: unknown;
};

type HarnessSummary = {
  overallPass: boolean;
  mode: 'docs-only' | 'full' | 'edit-session';
  transport: 'stdio';
  surface: {
    discoverableCount: number;
    canonicalPublicCount: number;
    aliasPresent: boolean;
    missingCanonicalTools: string[];
  };
  checks: {
    healthCheck: boolean;
    listCategories: boolean;
    searchDocs: boolean;
    registerProject: boolean | null;
    verifyProjectIndex: boolean | null;
    ingestProject: boolean | null;
    searchProjectCode: boolean | null;
    findProjectSymbol: boolean | null;
    findSymbolReferences: boolean | null;
    getProjectFile: boolean | null;
    getProjectOutline: boolean | null;
    editSessionConvergence: boolean | null;
  };
  details: {
    categoryCount: number;
    docsHitCount: number;
    docsError?: string;
    explicitEditIngestEnabled: boolean;
    watcherAutostartEnabled: boolean;
    projectId?: string;
    projectSlug?: string;
    indexedFilePath?: string;
    gateReady?: boolean;
    gateBlockingFailureCode?: string | null;
    freshnessStatus?: string;
    freshnessCheckedFiles?: number;
    ingestionRequested: boolean;
    ingestionCompleted: boolean;
    projectSearchHitCount: number;
    projectFileChunkCount: number;
    outlineSymbolCount: number;
    probeSymbolName?: string;
    editSessionEnabled: boolean;
    editProbeSourcePath?: string;
    editAddToken?: string;
    editChangeToken?: string;
    editAddConverged?: boolean | null;
    editChangeConverged?: boolean | null;
    editDeleteConverged?: boolean | null;
    editCloseoutFilesIndexed?: number;
    editCloseoutFilesDeleted?: number;
  };
};

type HarnessArgs = {
  json: boolean;
  cwd: string;
  projectRoot: string;
  projectName: string;
  projectSlug: string;
  includeRoots: string[];
  docsQuery: string;
  ingestProject: boolean;
  forceIngest: boolean;
  verifyFreshness: boolean;
  docsOnly: boolean;
  editSession: boolean;
  editTimeoutMs: number;
  editPollMs: number;
  editCloseoutMaxFiles: number;
};

type VerifyIndexData = {
  projectId?: string;
  fileCount?: number;
  gateSignal?: {
    ready?: boolean;
    blockingFailureCode?: string | null;
  };
  freshness?: {
    status?: string;
    checkedFiles?: number;
  };
};

type OutlineData = {
  sourcePath?: string;
  symbols?: Array<{
    name?: string;
  }>;
};

type SearchResult = {
  sourcePath?: string;
};

type EditSessionResult = {
  sourcePath: string;
  addToken: string;
  changeToken: string;
  addConverged: boolean;
  changeConverged: boolean;
  deleteConverged: boolean;
  closeoutFilesIndexed: number;
  closeoutFilesDeleted: number;
};

const MCP_CONNECT_TIMEOUT_MS = 120000;
export const PROJECT_SEARCH_MODE = 'hybrid' as const;
const PROJECT_READ_JOURNEY_TOOLS = [
  'verify_project_index',
  'search_project_code',
  'get_project_file',
  'get_project_outline',
  'find_project_symbol',
  'find_symbol_references',
] as const;
const PROJECT_WRITE_JOURNEY_TOOLS = [
  'register_project',
  'ingest_project',
  'ingest_project_file',
] as const;

export function validateProjectJourneySurface(
  args: Pick<HarnessArgs, 'docsOnly' | 'ingestProject' | 'editSession'>,
  availableTools: Iterable<string>
): {
  readJourneyRequired: boolean;
  readJourneyVisible: boolean;
  writeJourneyRequested: boolean;
  writeJourneyVisible: boolean;
} {
  const toolSet = new Set(availableTools);
  const readJourneyRequired = !args.docsOnly;
  const writeJourneyRequested = !args.docsOnly && (args.ingestProject || args.editSession);
  const missingReadTools = PROJECT_READ_JOURNEY_TOOLS.filter((name) => !toolSet.has(name));
  const missingWriteTools = PROJECT_WRITE_JOURNEY_TOOLS.filter((name) => !toolSet.has(name));

  if (writeJourneyRequested && missingWriteTools.length > 0) {
    throw new Error(
      `Project write journey requested by --ingest-project/--edit-session, but MCP tools are unavailable: ${missingWriteTools.join(', ')}`
    );
  }
  if (readJourneyRequired && missingReadTools.length > 0) {
    throw new Error(`full Project read journey requires MCP tools: ${missingReadTools.join(', ')}`);
  }

  return {
    readJourneyRequired,
    readJourneyVisible: missingReadTools.length === 0,
    writeJourneyRequested,
    writeJourneyVisible: writeJourneyRequested && missingWriteTools.length === 0,
  };
}

export function buildProjectSearchArguments(projectId: string, query: string, limit = 10) {
  return {
    projectId,
    query,
    limit,
    mode: PROJECT_SEARCH_MODE,
  };
}

function readFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readNumberFlag(
  args: string[],
  flag: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = readStringFlag(args, flag);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): HarnessArgs {
  const resolvedCwd = resolve(readStringFlag(argv, '--cwd') ?? cwd);
  const docsOnly = readFlag(argv, '--docs-only');
  const editSession = readFlag(argv, '--edit-session');
  const ingestProject = readFlag(argv, '--ingest-project') || editSession;
  const smokeFixtureRoot = resolve(
    resolvedCwd,
    'scripts/eval/project-rag/repos/fixture-ts-service'
  );
  const defaultProjectRoot =
    !docsOnly && existsSync(smokeFixtureRoot) ? smokeFixtureRoot : resolvedCwd;
  const projectRoot = resolve(readStringFlag(argv, '--project-root') ?? defaultProjectRoot);
  const rootProjectName = basename(projectRoot);
  const projectName = ingestProject
    ? rootProjectName
    : (readStringFlag(argv, '--project-name') ?? inferProjectNameFromRootPath(projectRoot));
  const projectSlug = ingestProject
    ? createProjectSlug(rootProjectName)
    : (readStringFlag(argv, '--project-slug') ??
      process.env.PROJECT_RAG_PROJECT_SLUG ??
      createProjectSlug(projectName));
  const includeRoots =
    readStringFlag(argv, '--include-roots')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? suggestProjectIncludeRoots(projectRoot);

  if (includeRoots.length === 0) {
    throw new Error(
      `No include roots could be determined for ${projectRoot}. Pass --include-roots <dir,dir>.`
    );
  }

  if (docsOnly && editSession) {
    throw new Error('--docs-only and --edit-session are mutually exclusive');
  }
  if (docsOnly && ingestProject) {
    throw new Error('--docs-only and --ingest-project are mutually exclusive');
  }

  return {
    json: readFlag(argv, '--json'),
    cwd: resolvedCwd,
    projectRoot,
    projectName,
    projectSlug,
    includeRoots,
    docsQuery:
      readStringFlag(argv, '--docs-query') ??
      'How do React components import and export other components?',
    ingestProject,
    forceIngest: readFlag(argv, '--force-ingest'),
    verifyFreshness: !readFlag(argv, '--skip-freshness'),
    docsOnly,
    editSession,
    editTimeoutMs: readNumberFlag(argv, '--edit-timeout-ms', 60_000, 5_000, 300_000),
    editPollMs: readNumberFlag(argv, '--edit-poll-ms', 1_200, 200, 10_000),
    editCloseoutMaxFiles: readNumberFlag(argv, '--edit-closeout-max-files', 25, 1, 120),
  };
}

function extractPayload(result: any): ToolPayload {
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object') {
    return {
      ...(structured as ToolPayload),
      isError: Boolean(result?.isError),
    };
  }

  const text = Array.isArray(result?.content)
    ? result.content
        .filter((entry: any) => entry?.type === 'text' && typeof entry.text === 'string')
        .map((entry: any) => entry.text)
        .join('\n')
    : '';

  if (!text) {
    return { isError: Boolean(result?.isError) };
  }

  try {
    return {
      ...(JSON.parse(text) as ToolPayload),
      rawText: text,
      isError: Boolean(result?.isError),
    };
  } catch {
    return { rawText: text, isError: Boolean(result?.isError) };
  }
}

function requireSuccess(step: string, payload: ToolPayload): ToolPayload {
  if (payload.isError || payload.success === false) {
    throw new Error(`${step} failed: ${payload.error?.message ?? 'unknown MCP tool failure'}`);
  }

  return payload;
}

function countMarkdownResults(text: string | undefined): number {
  if (!text) {
    return 0;
  }

  return [...text.matchAll(/^##\s+\d+\.\s+/gm)].length;
}

export function extractDocsSearchResults(payload: ToolPayload): unknown[] {
  if (Array.isArray(payload.results)) {
    return payload.results;
  }
  if (Array.isArray(payload.data?.results)) {
    return payload.data.results;
  }

  return Array.from({ length: countMarkdownResults(payload.rawText) });
}

function extractProjectId(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  return text.match(/"projectId"\s*:\s*"([^"]+)"/)?.[1];
}

function extractProjectSlug(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  return text.match(/"slug"\s*:\s*"([^"]+)"/)?.[1];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function extractOutlineSymbolCount(text: string | undefined): number {
  if (!text) {
    return 0;
  }

  const match = text.match(/## Symbols \((\d+)\)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function extractCategoryCount(text: string | undefined): number {
  if (!text) {
    return 0;
  }

  const headingCount = [...text.matchAll(/^##\s+/gm)].length;
  if (headingCount > 0) {
    return headingCount;
  }

  const headerMatch = text.match(/Available Categories \((\d+)\)/);
  return headerMatch ? Number.parseInt(headerMatch[1], 10) : 0;
}

function extractFreshnessStatus(payload: ToolPayload): string | undefined {
  const structuredData = payload.data as VerifyIndexData | undefined;
  if (typeof structuredData?.freshness?.status === 'string') {
    return structuredData.freshness.status;
  }

  return payload.rawText?.match(/## Freshness\s+\*\*Status:\*\*\s+([A-Za-z_]+)/)?.[1];
}

function extractGateReady(payload: ToolPayload): boolean | undefined {
  const structuredData = payload.data as VerifyIndexData | undefined;
  if (typeof structuredData?.gateSignal?.ready === 'boolean') {
    return structuredData.gateSignal.ready;
  }

  const match = payload.rawText?.match(/Project Contract Ready:\*\*\s+(Yes|No)/i);
  if (!match) {
    return undefined;
  }

  return match[1].toLowerCase() === 'yes';
}

function extractGateBlockingFailureCode(payload: ToolPayload): string | null | undefined {
  const structuredData = payload.data as VerifyIndexData | undefined;
  if (typeof structuredData?.gateSignal?.blockingFailureCode === 'string') {
    return structuredData.gateSignal.blockingFailureCode;
  }
  if (structuredData?.gateSignal?.blockingFailureCode === null) {
    return null;
  }

  const match = payload.rawText?.match(/Blocking Failure Code:\*\*\s+([A-Z_]+|none)/);
  if (!match) {
    return undefined;
  }

  return match[1] === 'none' ? null : match[1];
}

function extractFreshnessCheckedFiles(payload: ToolPayload): number | undefined {
  const structuredData = payload.data as VerifyIndexData | undefined;
  if (typeof structuredData?.freshness?.checkedFiles === 'number') {
    return structuredData.freshness.checkedFiles;
  }

  const match = payload.rawText?.match(/Checked Files:\*\*\s+(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function extractIndexedFileCount(payload: ToolPayload): number {
  const structuredData = payload.data as VerifyIndexData | undefined;
  if (typeof structuredData?.fileCount === 'number') {
    return structuredData.fileCount;
  }

  const match = payload.rawText?.match(/File Count:\*\*\s+(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function extractFirstSymbolName(payload: ToolPayload): string | undefined {
  const structuredData = payload.data as OutlineData | undefined;
  const firstStructuredSymbol = structuredData?.symbols?.find(
    (symbol) => typeof symbol?.name === 'string' && symbol.name.trim().length > 0
  );
  if (firstStructuredSymbol?.name) {
    return firstStructuredSymbol.name;
  }

  return payload.rawText?.match(/- \*\*([^*]+)\*\* \(/)?.[1]?.trim();
}

export function pickSearchProbe(sourcePath: string, symbolName?: string): string {
  if (symbolName?.trim()) {
    return symbolName.trim();
  }

  return parse(sourcePath).name || basename(sourcePath);
}

export function buildProjectSearchQueries(args: {
  projectName: string;
  projectSlug: string;
  includeRoots: string[];
}): string[] {
  const codeRoots = args.includeRoots.filter(
    (includeRoot) => includeRoot !== 'docs' && !includeRoot.startsWith('docs/')
  );
  return uniqueStrings([
    args.projectSlug,
    args.projectName,
    ...codeRoots.map((includeRoot) => parse(includeRoot).name || basename(includeRoot)),
    codeRoots.length > 0 ? 'export' : undefined,
    codeRoots.length > 0 ? 'function' : undefined,
    codeRoots.length === 0 ? '##' : undefined,
  ]);
}

function isFreshStatus(status: string | undefined): boolean {
  return status === 'fresh' || status === 'fresh_with_metadata_drift';
}

function extractSearchResults(payload: ToolPayload): SearchResult[] {
  const results = payload.data?.results;
  if (Array.isArray(results)) {
    return (results as SearchResult[]).filter((entry) => typeof entry?.sourcePath === 'string');
  }

  return [];
}

function sourcePathMatches(results: SearchResult[], expectedSourcePath: string): boolean {
  return results.some((result) => {
    const candidate = result.sourcePath;
    if (!candidate) {
      return false;
    }
    return candidate === expectedSourcePath || candidate.endsWith(`/${expectedSourcePath}`);
  });
}

async function resolveProjectProbe(params: {
  client: Client;
  projectId: string;
  projectName: string;
  projectSlug: string;
  includeRoots: string[];
}): Promise<{
  searchPayload: ToolPayload;
  indexedFilePath: string;
  outlinePayload: ToolPayload;
  probeSymbolName?: string;
}> {
  const { client, projectId, projectName, projectSlug, includeRoots } = params;

  for (const query of buildProjectSearchQueries({ projectName, projectSlug, includeRoots })) {
    const searchPayload = requireSuccess(
      'search_project_code',
      extractPayload(
        await client.callTool({
          name: 'search_project_code',
          arguments: buildProjectSearchArguments(projectId, query),
        })
      )
    );
    const searchResults = extractSearchResults(searchPayload);
    if (searchResults.length === 0) {
      continue;
    }

    let fallbackFilePath: string | undefined;
    let fallbackOutline: ToolPayload | undefined;

    for (const result of searchResults) {
      if (!result.sourcePath) {
        continue;
      }

      const outlinePayload = requireSuccess(
        'get_project_outline',
        extractPayload(
          await client.callTool({
            name: 'get_project_outline',
            arguments: {
              projectId,
              sourcePath: result.sourcePath,
            },
          })
        )
      );
      const probeSymbolName = extractFirstSymbolName(outlinePayload);
      if (probeSymbolName) {
        return {
          searchPayload,
          indexedFilePath: result.sourcePath,
          outlinePayload,
          probeSymbolName,
        };
      }

      if (!fallbackOutline) {
        fallbackFilePath = result.sourcePath;
        fallbackOutline = outlinePayload;
      }
    }

    if (fallbackFilePath && fallbackOutline) {
      return {
        searchPayload,
        indexedFilePath: fallbackFilePath,
        outlinePayload: fallbackOutline,
      };
    }
  }

  throw new Error('could not load a project outline from MCP search results');
}

export function extractIngestProjectFileStats(payload: ToolPayload): {
  filesIndexed: number;
  filesDeleted: number;
} {
  const data = payload.data as
    | {
        filesIndexed?: unknown;
        filesDeleted?: unknown;
        stats?: { filesIndexed?: unknown; filesDeleted?: unknown };
      }
    | undefined;

  const filesIndexedStructured =
    typeof data?.filesIndexed === 'number'
      ? data.filesIndexed
      : typeof data?.stats?.filesIndexed === 'number'
        ? data.stats.filesIndexed
        : undefined;
  const filesDeletedStructured =
    typeof data?.filesDeleted === 'number'
      ? data.filesDeleted
      : typeof data?.stats?.filesDeleted === 'number'
        ? data.stats.filesDeleted
        : undefined;

  const filesIndexedFromText =
    payload.rawText?.match(/filesIndexed["']?\s*[:=]\s*(\d+)/i)?.[1] ??
    payload.rawText?.match(/Indexed:\s*(\d+)/i)?.[1];
  const filesDeletedFromText =
    payload.rawText?.match(/filesDeleted["']?\s*[:=]\s*(\d+)/i)?.[1] ??
    payload.rawText?.match(/Deleted:\s*(\d+)/i)?.[1];

  return {
    filesIndexed:
      filesIndexedStructured ??
      (filesIndexedFromText ? Number.parseInt(filesIndexedFromText, 10) : 0) ??
      0,
    filesDeleted:
      filesDeletedStructured ??
      (filesDeletedFromText ? Number.parseInt(filesDeletedFromText, 10) : 0) ??
      0,
  };
}

function buildEditSessionProbe(projectRoot: string, includeRoots: string[]) {
  const selectedIncludeRoot =
    includeRoots.find((candidate) => candidate !== 'docs' && !candidate.startsWith('docs/')) ??
    includeRoots[0];
  const probeRootAbsolute = resolve(projectRoot, selectedIncludeRoot);
  if (!existsSync(probeRootAbsolute)) {
    mkdirSync(probeRootAbsolute, { recursive: true });
  } else {
    const stats = statSync(probeRootAbsolute);
    if (!stats.isDirectory()) {
      throw new Error(`Include root is not a directory: ${selectedIncludeRoot}`);
    }
  }

  const extension =
    selectedIncludeRoot === 'docs' || selectedIncludeRoot.startsWith('docs/') ? 'md' : 'ts';
  const filename = `__mcp_edit_session_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}.${extension}`;
  const absolutePath = resolve(probeRootAbsolute, filename);
  const sourcePath = relative(projectRoot, absolutePath).replace(/\\/g, '/');

  return {
    absolutePath,
    sourcePath,
    extension,
  };
}

function buildEditProbeContent(extension: string, token: string): string {
  if (extension === 'md') {
    return `# MCP Edit Session Probe\n\nToken: ${token}\n`;
  }
  return `export const ${token} = '${token}';\n`;
}

async function ingestProjectFile(params: {
  client: Client;
  rootPath: string;
  filePath: string;
}): Promise<{
  filesIndexed: number;
  filesDeleted: number;
}> {
  const payload = requireSuccess(
    'ingest_project_file',
    extractPayload(
      await params.client.callTool({
        name: 'ingest_project_file',
        arguments: {
          rootPath: params.rootPath,
          filePath: params.filePath,
          scopeAck: PROJECT_SCOPE_ACK_TOKEN,
        },
      })
    )
  );

  return extractIngestProjectFileStats(payload);
}

async function runEditSession(params: {
  args: HarnessArgs;
  client: Client;
  projectId: string;
}): Promise<EditSessionResult> {
  const { args, client, projectId } = params;
  const probe = buildEditSessionProbe(args.projectRoot, args.includeRoots);
  const addToken = `edit_session_add_${Date.now().toString(36)}`;
  const changeToken = `edit_session_change_${Date.now().toString(36)}`;
  const startAt = Date.now();

  const waitForConvergence = async (
    step: 'add' | 'change' | 'delete',
    predicate: (state: {
      freshnessStatus: string | undefined;
      addHits: SearchResult[];
      changeHits: SearchResult[];
    }) => { ok: boolean; detail: string }
  ) => {
    let lastDetail = 'not started';
    while (Date.now() - startAt <= args.editTimeoutMs) {
      const verifyPayload = requireSuccess(
        'verify_project_index',
        extractPayload(
          await client.callTool({
            name: 'verify_project_index',
            arguments: { projectId },
          })
        )
      );
      const freshnessStatus = extractFreshnessStatus(verifyPayload);

      const addSearchPayload = requireSuccess(
        'search_project_code',
        extractPayload(
          await client.callTool({
            name: 'search_project_code',
            arguments: buildProjectSearchArguments(projectId, addToken),
          })
        )
      );
      const changeSearchPayload = requireSuccess(
        'search_project_code',
        extractPayload(
          await client.callTool({
            name: 'search_project_code',
            arguments: buildProjectSearchArguments(projectId, changeToken),
          })
        )
      );

      const state = {
        freshnessStatus,
        addHits: extractSearchResults(addSearchPayload),
        changeHits: extractSearchResults(changeSearchPayload),
      };
      const evaluation = predicate(state);
      if (evaluation.ok) {
        return;
      }

      lastDetail = evaluation.detail;
      await Bun.sleep(args.editPollMs);
    }

    throw new Error(`edit_session_${step}_timeout: ${lastDetail}`);
  };

  try {
    writeFileSync(probe.absolutePath, buildEditProbeContent(probe.extension, addToken), 'utf8');
    await ingestProjectFile({
      client,
      rootPath: args.projectRoot,
      filePath: probe.absolutePath,
    });
    await waitForConvergence('add', (state) => {
      const addHit = sourcePathMatches(state.addHits, probe.sourcePath);
      return {
        ok: isFreshStatus(state.freshnessStatus) && addHit,
        detail: `freshness=${state.freshnessStatus ?? 'unknown'} addHit=${addHit}`,
      };
    });

    writeFileSync(probe.absolutePath, buildEditProbeContent(probe.extension, changeToken), 'utf8');
    await ingestProjectFile({
      client,
      rootPath: args.projectRoot,
      filePath: probe.absolutePath,
    });
    await waitForConvergence('change', (state) => {
      const changeHit = sourcePathMatches(state.changeHits, probe.sourcePath);
      return {
        ok: isFreshStatus(state.freshnessStatus) && changeHit,
        detail: `freshness=${state.freshnessStatus ?? 'unknown'} changeHit=${changeHit}`,
      };
    });

    rmSync(probe.absolutePath, { force: true });
    const closeoutPayload = requireSuccess(
      'ingest_project',
      extractPayload(
        await client.callTool({
          name: 'ingest_project',
          arguments: {
            rootPath: args.projectRoot,
            includeRoots: args.includeRoots,
            maxFiles: args.editCloseoutMaxFiles,
            scopeAck: PROJECT_SCOPE_ACK_TOKEN,
          },
        })
      )
    );
    const closeoutStats = extractIngestProjectFileStats(closeoutPayload);
    await waitForConvergence('delete', (state) => {
      const addHit = sourcePathMatches(state.addHits, probe.sourcePath);
      const changeHit = sourcePathMatches(state.changeHits, probe.sourcePath);
      return {
        ok: isFreshStatus(state.freshnessStatus) && !addHit && !changeHit,
        detail: `freshness=${state.freshnessStatus ?? 'unknown'} addHit=${addHit} changeHit=${changeHit}`,
      };
    });

    return {
      sourcePath: probe.sourcePath,
      addToken,
      changeToken,
      addConverged: true,
      changeConverged: true,
      deleteConverged: true,
      closeoutFilesIndexed: closeoutStats.filesIndexed,
      closeoutFilesDeleted: closeoutStats.filesDeleted,
    };
  } finally {
    rmSync(probe.absolutePath, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const explicitEditIngestEnabled = args.editSession;
  const watcherAutostartEnabled = false;
  const transportEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    RAG_PROJECT_SESSION_INTENT: args.editSession ? 'edit_session' : 'read_only',
    RAG_PROJECT_WATCHER_ENABLED: 'false',
  };
  if (args.docsOnly) {
    transportEnv.MCP_BACKEND_REQUIRED = 'false';
    transportEnv.MCP_TOOLSET = 'docs';
  }
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['mcp/launcher.ts'],
    cwd: args.cwd,
    env: transportEnv,
  });

  const client = new Client(
    {
      name: 'rag-v1-mcp-live-harness',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  let summary: HarnessSummary | null = null;

  try {
    await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });

    const toolsResponse = await client.listTools();
    const toolNames = toolsResponse.tools.map((tool) => tool.name);
    const toolSet = new Set(toolNames);
    const callerSurface = resolveMcpCallerSurface(transportEnv);
    const expectedTools = callerSurface.toolNames;
    const canSee = (name: string) =>
      callerCanSeeMcpTool(name, callerSurface.permissionMode, callerSurface.toolset);
    const missingCanonicalTools = expectedTools.filter((tool) => !toolSet.has(tool));
    const aliasExpected = canSee('search_project_docs');
    const projectJourney = validateProjectJourneySurface(args, toolSet);

    let healthCheckPassed = true;
    if (canSee('health_check')) {
      const healthPayload = requireSuccess(
        'health_check',
        extractPayload(await client.callTool({ name: 'health_check', arguments: {} }))
      );
      healthCheckPassed = healthPayload.success !== false;
    }

    let categoriesCallPassed = true;
    let categories: unknown[] = [];
    if (canSee('list_categories')) {
      const categoriesPayload = requireSuccess(
        'list_categories',
        extractPayload(await client.callTool({ name: 'list_categories', arguments: {} }))
      );

      categoriesCallPassed = categoriesPayload.success !== false;
      categories = Array.isArray(categoriesPayload.data?.categories)
        ? (categoriesPayload.data?.categories as unknown[])
        : Array.from({ length: extractCategoryCount(categoriesPayload.rawText) });
    }

    let docsResults: unknown[] = [];
    let docsError: string | undefined;
    let docsSearchPassed = !canSee('search_docs');

    if (canSee('search_docs')) {
      try {
        const docsPayload = requireSuccess(
          'search_docs',
          extractPayload(
            await client.callTool({
              name: 'search_docs',
              arguments: {
                query: args.docsQuery,
                limit: 5,
              },
            })
          )
        );

        docsResults = extractDocsSearchResults(docsPayload);
        docsSearchPassed = docsResults.length > 0;
        if (!docsSearchPassed) {
          docsError = 'search_docs returned zero results';
        }
      } catch (error) {
        docsError = formatErrorForOutput(error);
      }
    }

    let resolvedProjectId: string | undefined;
    let resolvedProjectSlug: string | undefined;
    let ingestionCompleted = false;
    let gateReady: boolean | undefined;
    let gateBlockingFailureCode: string | null | undefined;
    let freshnessStatus: string | undefined;
    let freshnessCheckedFiles = 0;
    let indexedFilePath: string | undefined;
    let probeSymbolName: string | undefined;
    let projectResults: Array<Record<string, unknown>> = [];
    let symbolMatches: Array<Record<string, unknown>> = [];
    let symbols: unknown[] = [];
    let registerProjectPassed: boolean | null = null;
    let verifyProjectIndexPassed: boolean | null = null;
    let ingestProjectPassed: boolean | null = null;
    let searchProjectCodePassed: boolean | null = null;
    let findProjectSymbolPassed: boolean | null = null;
    let findSymbolReferencesPassed: boolean | null = null;
    let getProjectFilePassed: boolean | null = null;
    let getProjectOutlinePassed: boolean | null = null;
    let editSessionConvergencePassed: boolean | null = null;
    let editSessionResult: EditSessionResult | null = null;
    let projectFileChunkCount = 0;

    const projectWriteJourneyVisible = projectJourney.writeJourneyVisible;

    if (!args.docsOnly) {
      if (projectWriteJourneyVisible) {
        const registerPayload = requireSuccess(
          'register_project',
          extractPayload(
            await client.callTool({
              name: 'register_project',
              arguments: {
                name: args.projectName,
                rootPath: args.projectRoot,
                includeRoots: args.includeRoots,
                scopeAck: PROJECT_SCOPE_ACK_TOKEN,
              },
            })
          )
        );

        const projectId =
          typeof registerPayload.data?.projectId === 'string'
            ? registerPayload.data.projectId
            : extractProjectId(registerPayload.rawText);
        const projectSlug =
          typeof registerPayload.data?.slug === 'string'
            ? registerPayload.data.slug
            : extractProjectSlug(registerPayload.rawText);
        registerProjectPassed = Boolean(projectId);
        resolvedProjectId = projectId;
        resolvedProjectSlug = projectSlug ?? args.projectSlug;

        if (!resolvedProjectId) {
          throw new Error(`could not resolve indexed projectId for slug "${args.projectSlug}"`);
        }

        if (args.ingestProject) {
          requireSuccess(
            'ingest_project',
            extractPayload(
              await client.callTool({
                name: 'ingest_project',
                arguments: {
                  rootPath: args.projectRoot,
                  includeRoots: args.includeRoots,
                  force: args.forceIngest,
                  scopeAck: PROJECT_SCOPE_ACK_TOKEN,
                },
              })
            )
          );
          ingestionCompleted = true;
        }
        ingestProjectPassed = !args.ingestProject || ingestionCompleted;
      } else {
        resolvedProjectId = args.projectSlug;
        resolvedProjectSlug = args.projectSlug;
      }

      const verifyPayload = requireSuccess(
        'verify_project_index',
        extractPayload(
          await client.callTool({
            name: 'verify_project_index',
            arguments: {
              projectId: resolvedProjectId,
            },
          })
        )
      );

      gateReady = extractGateReady(verifyPayload);
      gateBlockingFailureCode = extractGateBlockingFailureCode(verifyPayload);
      freshnessStatus = extractFreshnessStatus(verifyPayload);
      freshnessCheckedFiles = extractFreshnessCheckedFiles(verifyPayload) ?? 0;
      const indexedFileCount = extractIndexedFileCount(verifyPayload);
      verifyProjectIndexPassed = gateReady === true;

      if (gateReady === undefined) {
        throw new Error('verify_project_index did not return gateSignal.ready');
      }

      if (!gateReady) {
        throw new Error(
          `verify_project_index semantic gate is blocked (${gateBlockingFailureCode ?? 'unknown'})`
        );
      }

      if (
        args.verifyFreshness &&
        freshnessStatus !== 'fresh' &&
        freshnessStatus !== 'fresh_with_metadata_drift'
      ) {
        throw new Error(
          `verify_project_index reported freshness status "${freshnessStatus ?? 'unknown'}"`
        );
      }

      if (indexedFileCount < 1) {
        throw new Error(
          args.ingestProject
            ? 'project index remained empty after ingest_project'
            : 'project is not indexed; rerun with --ingest-project'
        );
      }

      const projectProbe = await resolveProjectProbe({
        client,
        projectId: resolvedProjectId,
        projectName: args.projectName,
        projectSlug: resolvedProjectSlug,
        includeRoots: args.includeRoots,
      });
      const outlinePayload = projectProbe.outlinePayload;
      indexedFilePath = projectProbe.indexedFilePath;
      probeSymbolName = projectProbe.probeSymbolName;
      getProjectOutlinePassed = true;
      const projectSearchPayload = projectProbe.searchPayload;

      const filePayload = requireSuccess(
        'get_project_file',
        extractPayload(
          await client.callTool({
            name: 'get_project_file',
            arguments: {
              projectId: resolvedProjectId,
              sourcePath: indexedFilePath,
            },
          })
        )
      );
      const fileChunks = filePayload.data?.chunks;
      if (!Array.isArray(fileChunks) || fileChunks.length === 0) {
        throw new Error('get_project_file returned no chunks');
      }
      projectFileChunkCount = fileChunks.length;
      getProjectFilePassed = true;

      projectResults = Array.isArray(projectSearchPayload.data?.results)
        ? (projectSearchPayload.data?.results as Array<Record<string, unknown>>)
        : Array.from({ length: countMarkdownResults(projectSearchPayload.rawText) });
      searchProjectCodePassed = projectResults.length > 0;

      if (!probeSymbolName) {
        throw new Error('get_project_outline returned no symbol for find_project_symbol probe');
      }

      if (probeSymbolName) {
        const symbolPayload = requireSuccess(
          'find_project_symbol',
          extractPayload(
            await client.callTool({
              name: 'find_project_symbol',
              arguments: {
                projectId: resolvedProjectId,
                symbolName: probeSymbolName,
                limit: 5,
              },
            })
          )
        );

        symbolMatches = Array.isArray(symbolPayload.data?.symbols)
          ? (symbolPayload.data?.symbols as Array<Record<string, unknown>>)
          : Array.from({ length: countMarkdownResults(symbolPayload.rawText) });
      }
      findProjectSymbolPassed = symbolMatches.length > 0;

      requireSuccess(
        'find_symbol_references',
        extractPayload(
          await client.callTool({
            name: 'find_symbol_references',
            arguments: {
              projectId: resolvedProjectId,
              symbolName: probeSymbolName,
              limit: 5,
            },
          })
        )
      );
      findSymbolReferencesPassed = true;
      symbols = Array.isArray(outlinePayload.data?.symbols)
        ? (outlinePayload.data?.symbols as unknown[])
        : Array.from({ length: extractOutlineSymbolCount(outlinePayload.rawText) });

      if (args.editSession) {
        editSessionResult = await runEditSession({
          args,
          client,
          projectId: resolvedProjectId,
        });
        editSessionConvergencePassed =
          editSessionResult.addConverged &&
          editSessionResult.changeConverged &&
          editSessionResult.deleteConverged;
      }
    }

    const projectReadJourneyPassed =
      !projectJourney.readJourneyRequired ||
      (verifyProjectIndexPassed === true &&
        searchProjectCodePassed === true &&
        getProjectFilePassed === true &&
        getProjectOutlinePassed === true &&
        findProjectSymbolPassed === true &&
        findSymbolReferencesPassed === true);
    const projectWriteJourneyPassed =
      !projectJourney.writeJourneyRequested ||
      (registerProjectPassed === true &&
        ingestProjectPassed === true &&
        (!args.editSession || editSessionConvergencePassed === true));

    summary = {
      overallPass:
        missingCanonicalTools.length === 0 &&
        (!aliasExpected || toolSet.has('search_project_docs')) &&
        healthCheckPassed &&
        categoriesCallPassed &&
        docsSearchPassed &&
        projectReadJourneyPassed &&
        projectWriteJourneyPassed,
      mode: args.docsOnly ? 'docs-only' : args.editSession ? 'edit-session' : 'full',
      transport: 'stdio',
      surface: {
        discoverableCount: toolNames.length,
        canonicalPublicCount: expectedTools.length,
        aliasPresent: toolSet.has('search_project_docs'),
        missingCanonicalTools,
      },
      checks: {
        healthCheck: healthCheckPassed,
        listCategories: categoriesCallPassed,
        searchDocs: docsSearchPassed,
        registerProject: registerProjectPassed,
        verifyProjectIndex: verifyProjectIndexPassed,
        ingestProject: ingestProjectPassed,
        searchProjectCode: searchProjectCodePassed,
        findProjectSymbol: findProjectSymbolPassed,
        findSymbolReferences: findSymbolReferencesPassed,
        getProjectFile: getProjectFilePassed,
        getProjectOutline: getProjectOutlinePassed,
        editSessionConvergence: editSessionConvergencePassed,
      },
      details: {
        categoryCount: categories.length,
        docsHitCount: docsResults.length,
        docsError,
        explicitEditIngestEnabled,
        watcherAutostartEnabled,
        projectId: resolvedProjectId,
        projectSlug: resolvedProjectSlug,
        indexedFilePath,
        gateReady,
        gateBlockingFailureCode,
        freshnessStatus,
        freshnessCheckedFiles,
        ingestionRequested: args.ingestProject,
        ingestionCompleted,
        projectSearchHitCount: projectResults.length,
        projectFileChunkCount,
        outlineSymbolCount: symbols.length,
        probeSymbolName,
        editSessionEnabled: args.editSession,
        editProbeSourcePath: editSessionResult?.sourcePath,
        editAddToken: editSessionResult?.addToken,
        editChangeToken: editSessionResult?.changeToken,
        editAddConverged: editSessionResult?.addConverged ?? editSessionConvergencePassed,
        editChangeConverged: editSessionResult?.changeConverged ?? editSessionConvergencePassed,
        editDeleteConverged: editSessionResult?.deleteConverged ?? editSessionConvergencePassed,
        editCloseoutFilesIndexed: editSessionResult?.closeoutFilesIndexed,
        editCloseoutFilesDeleted: editSessionResult?.closeoutFilesDeleted,
      },
    };

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.overallPass) {
        process.exitCode = 1;
      }
      return;
    }

    console.log('MCP live harness');
    console.log(`- mode: ${summary.mode}`);
    console.log(`- transport: ${summary.transport}`);
    console.log(`- discoverable tools: ${summary.surface.discoverableCount}`);
    console.log(`- canonical public tools: ${summary.surface.canonicalPublicCount}`);
    console.log(`- deprecated alias present: ${summary.surface.aliasPresent ? 'yes' : 'no'}`);
    console.log(`- missing canonical tools: ${summary.surface.missingCanonicalTools.length}`);
    console.log(`- categories returned: ${summary.details.categoryCount}`);
    console.log(`- docs search hits: ${summary.details.docsHitCount}`);
    console.log(
      `- explicit edit-session ingest enabled: ${summary.details.explicitEditIngestEnabled ? 'yes' : 'no'}`
    );
    if (summary.mode === 'full' || summary.mode === 'edit-session') {
      console.log(`- project slug: ${summary.details.projectSlug ?? 'unknown'}`);
      console.log(`- semantic gate ready: ${summary.details.gateReady ? 'yes' : 'no'}`);
      console.log(`- semantic gate blocker: ${summary.details.gateBlockingFailureCode ?? 'none'}`);
      console.log(`- freshness status: ${summary.details.freshnessStatus ?? 'unknown'}`);
      console.log(`- indexed sample file: ${summary.details.indexedFilePath ?? 'unknown'}`);
      console.log(`- probe symbol: ${summary.details.probeSymbolName ?? 'unknown'}`);
      console.log(`- project search hits: ${summary.details.projectSearchHitCount}`);
      console.log(`- project file chunks: ${summary.details.projectFileChunkCount}`);
      console.log(`- outline symbols: ${summary.details.outlineSymbolCount}`);
      if (summary.mode === 'edit-session') {
        console.log(`- edit probe sourcePath: ${summary.details.editProbeSourcePath ?? 'unknown'}`);
        console.log(`- edit add converged: ${summary.details.editAddConverged ? 'yes' : 'no'}`);
        console.log(
          `- edit change converged: ${summary.details.editChangeConverged ? 'yes' : 'no'}`
        );
        console.log(
          `- edit delete converged: ${summary.details.editDeleteConverged ? 'yes' : 'no'}`
        );
        console.log(
          `- edit closeout indexed/deleted: ${summary.details.editCloseoutFilesIndexed ?? 0}/${summary.details.editCloseoutFilesDeleted ?? 0}`
        );
      }
    } else {
      console.log('- project validation: skipped (docs-only mode)');
    }
    console.log(`- overall: ${summary.overallPass ? 'PASS' : 'FAIL'}`);
  } finally {
    await transport.close();
  }

  if (!summary?.overallPass) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(formatErrorForOutput(error));
    process.exit(1);
  });
}
