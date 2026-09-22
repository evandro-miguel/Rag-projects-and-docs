#!/usr/bin/env bun

import { checkLlamaCppGpuOffloadDuringRequest } from './check-embedding-health.js';
import {
  type DocsRagLabConfig,
  resolveDocsRagLabConfigWithLocalDefault,
} from './docs-rag/config.js';
import { checkDocsRagLabCorpusHealth, checkDocsRagLabDatabaseHealth } from './docs-rag/db.js';
import {
  DOCS_RAG_REQUIRED_PROVENANCE_FIELDS,
  type DocsRagLabSearchReport,
  type DocsRagLabSearchResult,
  searchDocsRagLab,
} from './docs-rag/store.js';
import { readDocsRagFreshness } from './lib/docs-rag-freshness.js';
import { resolveDocsRagReadiness } from './lib/docs-readiness.js';
import {
  DOCS_SOURCE_REGISTRY,
  type DocsSourceAuthority,
  type DocsSourceFilter,
  type DocsSourceKind,
  listDocsSources,
  matchesDocsSourceFilter,
  normalizeDocsSourceMetadata,
} from './lib/docs-source-registry.js';
import { normalizeEnvValue, REPO_ROOT } from './lib/runtime-env.js';
import {
  createProjectRagApplicationService,
  isProjectApplicationError,
} from './project-rag/application-service.js';
import {
  ProjectPrepareError,
  type ProjectPrepareResult,
  prepareProject,
} from './project-rag/prepare.js';

export type RagctlExitCode = 0 | 2 | 3 | 4 | 5 | 10 | 20;
export type RagctlSearchMode = 'keyword' | 'vector' | 'hybrid';
export type RagctlProjectSearchMode = 'keyword' | 'vector' | 'hybrid';

type RagctlCommand =
  | 'help'
  | 'health'
  | 'docs health'
  | 'projects list'
  | 'docs search'
  | 'docs sources list'
  | 'project search'
  | 'project file'
  | 'project outline'
  | 'project symbol'
  | 'project verify'
  | 'project prepare';

type JsonRecord = Record<string, unknown>;

type RagctlEmbeddingReadiness = {
  readonly ok: boolean;
  readonly provider: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly expectedDimensions?: number;
  readonly gpu?: {
    readonly ok: boolean;
    readonly message: string;
    readonly details?: string;
  };
  readonly error?: string;
};

export interface ParsedRagctlArgs {
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

export interface RagctlEnvelope<T = unknown> {
  ok: boolean;
  command?: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  warnings?: string[];
  meta: {
    tool: 'ragctl';
    version: 1;
    json: true;
  };
}

export interface RagctlRunResult {
  exitCode: RagctlExitCode;
  stdout: string;
  stderr: string;
}

export interface RagctlDocsSearchArgs {
  query: string;
  limit: number;
  categories?: string[];
  sourceIds?: string[];
  language?: string;
  kind?: DocsSourceKind;
  authority?: DocsSourceAuthority;
  tags?: string[];
  mode: RagctlSearchMode;
}

export interface RagctlProjectRef {
  id: string;
  name: string;
  slug: string;
  rootPath: string;
  status?: string;
  includeRoots?: string[];
  ignoreRules?: string[];
  origin?: string;
  ephemeral?: boolean;
  updatedAt?: number;
}

export interface RagctlService {
  health(): Promise<unknown>;
  docsHealth(): Promise<unknown>;
  listProjects(args: { includeEphemeral: boolean; limit: number }): Promise<unknown>;
  searchDocs(args: RagctlDocsSearchArgs): Promise<unknown>;
  searchProject(args: {
    project: string;
    query: string;
    limit: number;
    mode: RagctlProjectSearchMode;
  }): Promise<unknown>;
  getProjectFile(args: { project: string; file: string; limit: number }): Promise<unknown>;
  getProjectOutline(args: { project: string; file: string; limit: number }): Promise<unknown>;
  findProjectSymbol(args: {
    project: string;
    name: string;
    type?: string;
    limit: number;
  }): Promise<unknown>;
  verifyProject(args: { project: string }): Promise<unknown>;
  prepareProject(args: {
    rootPath: string;
    project?: string;
    includeRoots?: string[];
    timeoutMs?: number;
    maxFiles?: number;
    maxBatches?: number;
  }): Promise<ProjectPrepareResult>;
}

export class RagctlError extends Error {
  readonly exitCode: RagctlExitCode;
  readonly code: string;
  readonly details: unknown;

  constructor(exitCode: RagctlExitCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RagctlError';
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

function mapProjectApplicationError(error: unknown): never {
  if (!isProjectApplicationError(error)) {
    throw error;
  }
  const exitCode: RagctlExitCode =
    error.code === 'INVALID_INPUT'
      ? 2
      : error.code === 'NOT_FOUND'
        ? 4
        : error.code === 'NOT_READY'
          ? 5
          : 20;
  throw new RagctlError(exitCode, error.code, error.message, error.details);
}

function mapProjectPrepareError(error: unknown): never {
  if (!(error instanceof ProjectPrepareError)) throw error;
  const exitCode: RagctlExitCode =
    error.code === 'INVALID_ROOT' || error.code === 'SCOPE_UNAVAILABLE'
      ? 2
      : error.code === 'PROJECT_IDENTITY_MISMATCH' || error.code === 'PROJECT_ROOT_MISMATCH'
        ? 4
        : error.code === 'PROJECT_NOT_READY' ||
            error.code === 'SNAPSHOT_REVIEW_REQUIRED' ||
            error.code === 'SNAPSHOT_GATE_FAILED'
          ? 5
          : 20;
  throw new RagctlError(exitCode, error.code, error.message, error.details);
}

function helpText(): string {
  return `Usage:
  ragctl health --json
  ragctl docs health --json
  ragctl projects list --json
  ragctl docs sources list --json
  ragctl docs search <query> [--limit 5] [--category react] [--source go-books] [--language go] [--kind book] [--authority official] --json
  ragctl project search --project <id-or-name> <query> [--mode keyword|vector|hybrid] --json
  ragctl project file --project <id-or-name> --file <path> [--include-content|--full] --json
  ragctl project outline --project <id-or-name> --file <path> [--include-skeleton|--full] --json
  ragctl project symbol --project <id-or-name> --name <symbol> [--references|--full] --json
  ragctl project verify --project <id-or-name> [--full] --json
  ragctl project prepare --root <target-root> [--project <id-or-name>] [--include-root <path>] --json
`;
}

export function enforceReadOnlyProjectIntent(env: NodeJS.ProcessEnv = process.env): void {
  env.RAG_PROJECT_SESSION_INTENT = 'read_only';
  env.RAG_PROJECT_WATCHER_ENABLED = 'false';
}

function enforceProjectPrepareIntent(env: NodeJS.ProcessEnv = process.env): void {
  env.RAG_PROJECT_SESSION_INTENT = 'edit_session';
  env.RAG_PROJECT_WATCHER_ENABLED = 'false';
}

export function parseRagctlArgs(argv: string[]): ParsedRagctlArgs {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex !== -1) {
      const key = token.slice(2, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      options.set(key, value);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(key, next);
      index++;
    } else {
      flags.add(key);
    }
  }

  return { positionals, options, flags };
}

function option(parsed: ParsedRagctlArgs, name: string): string | undefined {
  return normalizeEnvValue(parsed.options.get(name));
}

function repeatedOption(argv: string[], name: string): string[] {
  const values: string[] = [];
  const longFlag = `--${name}`;
  const longPrefix = `--${name}=`;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith(longPrefix)) {
      const value = normalizeEnvValue(token.slice(longPrefix.length));
      if (value) values.push(value);
      continue;
    }
    if (token === longFlag) {
      const value = normalizeEnvValue(argv[index + 1]);
      if (value && !value.startsWith('--')) {
        values.push(value);
        index++;
      }
    }
  }

  return values;
}

function parseLimit(parsed: ParsedRagctlArgs, fallback: number, max = 50): number {
  const raw = option(parsed, 'limit');
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new RagctlError(2, 'INVALID_INPUT', '--limit must be a positive integer');
  }
  return Math.min(value, max);
}

function parseSearchMode(parsed: ParsedRagctlArgs): RagctlSearchMode {
  const raw = option(parsed, 'mode') ?? 'hybrid';
  if (raw === 'keyword' || raw === 'vector' || raw === 'hybrid') {
    return raw;
  }
  throw new RagctlError(2, 'INVALID_INPUT', '--mode must be keyword, vector, or hybrid');
}

function parseProjectSearchMode(parsed: ParsedRagctlArgs): RagctlProjectSearchMode {
  const raw = option(parsed, 'mode') ?? 'hybrid';
  if (raw === 'keyword' || raw === 'vector' || raw === 'hybrid') {
    return raw;
  }
  throw new RagctlError(2, 'INVALID_INPUT', '--mode must be keyword, vector, or hybrid');
}

function parseDocsSourceKind(parsed: ParsedRagctlArgs): DocsSourceKind | undefined {
  const raw = option(parsed, 'kind');
  if (!raw) return undefined;
  if (
    raw === 'official-docs' ||
    raw === 'book' ||
    raw === 'package-docs' ||
    raw === 'repository-docs'
  ) {
    return raw;
  }
  throw new RagctlError(
    2,
    'INVALID_INPUT',
    '--kind must be official-docs, book, package-docs, or repository-docs'
  );
}

function parseDocsSourceAuthority(parsed: ParsedRagctlArgs): DocsSourceAuthority | undefined {
  const raw = option(parsed, 'authority');
  if (!raw) return undefined;
  if (raw === 'official' || raw === 'publisher' || raw === 'community-vetted') {
    return raw;
  }
  throw new RagctlError(
    2,
    'INVALID_INPUT',
    '--authority must be official, publisher, or community-vetted'
  );
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new RagctlError(2, 'INVALID_INPUT', `${label} is required`);
  }
  return value;
}

function requireQuery(parsed: ParsedRagctlArgs, startIndex: number): string {
  const query = parsed.positionals.slice(startIndex).join(' ').trim();
  if (!query) {
    throw new RagctlError(2, 'INVALID_INPUT', 'query is required');
  }
  return query;
}

function envelope<T>(command: RagctlCommand, data: T, warnings?: string[]): RagctlEnvelope<T> {
  return {
    ok: true,
    command,
    data,
    warnings: warnings && warnings.length > 0 ? warnings : undefined,
    meta: { tool: 'ragctl', version: 1, json: true },
  };
}

function envelopeWithDataWarnings<T>(command: RagctlCommand, data: T): RagctlEnvelope<T> {
  const warnings =
    data &&
    typeof data === 'object' &&
    'warnings' in data &&
    Array.isArray((data as { warnings?: unknown }).warnings)
      ? (data as { warnings: string[] }).warnings
      : undefined;
  return envelope(command, data, warnings);
}

function errorEnvelope(error: RagctlError): RagctlEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
    meta: { tool: 'ragctl', version: 1, json: true },
  };
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : {};
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null;
  return stringField(value);
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function idField(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object' && 'toString' in value) {
    const rendered = String(value);
    return rendered === '[object Object]' ? undefined : rendered;
  }
  return undefined;
}

function limitedStrings(value: unknown, limit = 10): string[] {
  return (toStringArray(value) ?? []).slice(0, limit);
}

function compactProject(raw: unknown): JsonRecord {
  const entry = asRecord(raw);
  return {
    id: idField(entry._id ?? entry.id),
    name: stringField(entry.name),
    slug: stringField(entry.slug),
    status: stringField(entry.status),
    origin: stringField(entry.origin),
    ephemeral: booleanField(entry.ephemeral),
  };
}

function compactFile(raw: unknown, args: { includeContent: boolean }): JsonRecord {
  const entry = asRecord(raw);
  return {
    id: idField(entry._id ?? entry.id),
    sourcePath: stringField(entry.sourcePath),
    lang: stringField(entry.lang),
    status: stringField(entry.status),
    lineCount: numberField(entry.lineCount),
    sizeBytes: numberField(entry.sizeBytes),
    metadataQuality: stringField(entry.metadataQuality),
    updatedAt: numberField(entry.updatedAt),
    content: args.includeContent ? stringField(entry.content) : undefined,
  };
}

function compactChunk(raw: unknown, args: { includeContent: boolean }): JsonRecord {
  const entry = asRecord(raw);
  return {
    id: idField(entry._id ?? entry.id),
    sourcePath: stringField(entry.sourcePath),
    chunkIndex: numberField(entry.chunkIndex),
    startLine: numberField(entry.startLine),
    endLine: numberField(entry.endLine),
    symbolName: stringField(entry.symbolName),
    symbolKind: stringField(entry.symbolKind),
    content: args.includeContent ? stringField(entry.content) : undefined,
  };
}

function compactSkeleton(raw: unknown, args: { includeSkeleton: boolean }): JsonRecord | undefined {
  if (!args.includeSkeleton) return undefined;
  const entry = asRecord(raw);
  if (Object.keys(entry).length === 0) return undefined;

  return {
    sourcePath: stringField(entry.sourcePath),
    lang: stringField(entry.lang),
    outlineVersion: stringField(entry.outlineVersion),
    sizeBytes: numberField(entry.sizeBytes),
    summary: stringField(entry.summary),
    skeletonText: stringField(entry.skeletonText),
  };
}

function compactSymbol(raw: unknown): JsonRecord {
  const entry = asRecord(raw);
  return {
    id: idField(entry._id ?? entry.id),
    name: stringField(entry.name),
    type: stringField(entry.type ?? entry.symbolType),
    symbolType: stringField(entry.symbolType ?? entry.type),
    sourcePath: stringField(entry.sourcePath),
    fileId: idField(entry.fileId),
    startLine: numberField(entry.startLine),
    endLine: numberField(entry.endLine),
    signature: stringField(entry.signature),
    exportType: stringField(entry.exportType),
    confidence: numberField(entry.confidence),
  };
}

function compactReference(raw: unknown): JsonRecord {
  const entry = asRecord(raw);
  return {
    id: idField(entry._id ?? entry.id),
    relationType: stringField(entry.relationType),
    sourcePath: stringField(entry.sourcePath),
    startLine: numberField(entry.startLine),
    endLine: numberField(entry.endLine),
    sourceFileId: idField(entry.sourceFileId),
    sourceRef: stringField(entry.sourceRef),
    targetPath: stringField(entry.targetPath),
    targetFileId: idField(entry.targetFileId),
    targetRef: stringField(entry.targetRef),
    confidence: numberField(entry.confidence),
  };
}

function compactStats(raw: unknown): JsonRecord {
  const entry = asRecord(raw);
  return {
    fileCount: numberField(entry.fileCount),
    indexedFileCount: numberField(entry.indexedFileCount),
    blockedFileCount: numberField(entry.blockedFileCount),
    chunkCount: numberField(entry.chunkCount),
    symbolCount: numberField(entry.symbolCount),
    edgeCount: numberField(entry.edgeCount),
    embedding1024Count: numberField(entry.embedding1024Count),
    lastSyncAt: nullableStringField(entry.lastSyncAt),
    coverage: entry.coverage,
  };
}

function compactFreshness(raw: unknown): JsonRecord {
  const entry = asRecord(raw);
  return {
    status: stringField(entry.status),
    checkedFiles: numberField(entry.checkedFiles),
    eligibleFiles: numberField(entry.eligibleFiles),
    freshFiles: numberField(entry.freshFiles),
    staleFiles: numberField(entry.staleFiles),
    missingFiles: numberField(entry.missingFiles),
    metadataDriftFiles: numberField(entry.metadataDriftFiles),
    unverifiedFiles: numberField(entry.unverifiedFiles),
    stalePaths: limitedStrings(entry.stalePaths),
    checkedAt: stringField(entry.checkedAt),
  };
}

function compactScopeCoverage(raw: unknown): JsonRecord {
  const entry = asRecord(raw);
  return {
    status: stringField(entry.status),
    expectedFiles: numberField(entry.expectedFiles),
    trackedFiles: numberField(entry.trackedFiles),
    indexedFiles: numberField(entry.indexedFiles),
    missingExpectedFiles: numberField(entry.missingExpectedFiles),
    unsearchableExpectedFiles: numberField(entry.unsearchableExpectedFiles),
    blockedExpectedFiles: numberField(entry.blockedExpectedFiles),
    extraIndexedFiles: numberField(entry.extraIndexedFiles),
    ignoredExpectedFiles: numberField(entry.ignoredExpectedFiles),
    ignoredIndexedFiles: numberField(entry.ignoredIndexedFiles),
    missingExpectedPaths: limitedStrings(entry.missingExpectedPaths),
    unsearchableExpectedPaths: limitedStrings(entry.unsearchableExpectedPaths),
    blockedExpectedPaths: limitedStrings(entry.blockedExpectedPaths),
    extraIndexedPaths: limitedStrings(entry.extraIndexedPaths),
    checkedAt: stringField(entry.checkedAt),
  };
}

function compactProjectFileResult(raw: unknown, args: { includeContent: boolean }): JsonRecord {
  const entry = asRecord(raw);
  const chunks = Array.isArray(entry.chunks) ? entry.chunks : [];
  return {
    project: compactProject(entry.project),
    buildId: numberField(entry.buildId),
    versionId: numberField(entry.versionId),
    serving: entry.serving,
    file: compactFile(entry.file, { includeContent: args.includeContent }),
    chunks: chunks.map((chunk) => compactChunk(chunk, args)),
    chunkCount: numberField(entry.chunkCount) ?? chunks.length,
    returnedChunkCount: chunks.length,
  };
}

function compactProjectOutlineResult(raw: unknown, args: { includeSkeleton: boolean }): JsonRecord {
  const entry = asRecord(raw);
  const symbols = Array.isArray(entry.symbols) ? entry.symbols : [];
  return {
    project: compactProject(entry.project),
    buildId: numberField(entry.buildId),
    versionId: numberField(entry.versionId),
    serving: entry.serving,
    sourcePath: stringField(entry.sourcePath),
    skeleton: compactSkeleton(entry.skeleton, args),
    symbols: symbols.map(compactSymbol),
    symbolCount: numberField(entry.symbolCount) ?? symbols.length,
    returnedSymbolCount: symbols.length,
  };
}

function compactProjectSymbolResult(
  raw: unknown,
  args: { includeReferences: boolean }
): JsonRecord {
  const entry = asRecord(raw);
  const definitions = Array.isArray(entry.definitions) ? entry.definitions : [];
  const references = Array.isArray(entry.references) ? entry.references : [];
  return {
    project: compactProject(entry.project),
    buildId: numberField(entry.buildId),
    serving: entry.serving,
    name: stringField(entry.name),
    definitions: definitions.map(compactSymbol),
    references: args.includeReferences ? references.map(compactReference) : undefined,
    definitionCount: numberField(entry.definitionCount) ?? definitions.length,
    referenceCount: numberField(entry.referenceCount) ?? references.length,
  };
}

function compactProjectVerifyResult(raw: unknown): JsonRecord {
  const entry = asRecord(raw);
  const search = asRecord(entry.search);
  const compact: JsonRecord = {
    backend: stringField(entry.backend),
    project: compactProject(entry.project),
    status: stringField(entry.status),
    stats: compactStats(entry.stats),
    issues: Array.isArray(entry.issues) ? limitedStrings(entry.issues) : undefined,
    search: entry.search
      ? {
          query: stringField(search.query),
          resultCount: numberField(search.resultCount),
          topResult: asRecord(search.topResult).sourcePath
            ? {
                sourcePath: stringField(asRecord(search.topResult).sourcePath),
                score: numberField(asRecord(search.topResult).score),
                vectorScore: numberField(asRecord(search.topResult).vectorScore),
              }
            : null,
        }
      : undefined,
  };
  if (entry.freshness) {
    compact.freshness = compactFreshness(entry.freshness);
  }
  if (entry.serving) {
    compact.serving = entry.serving;
  }
  if (entry.workspace) {
    compact.workspace = entry.workspace;
  }
  if (entry.scopeCoverage) {
    compact.scopeCoverage = compactScopeCoverage(entry.scopeCoverage);
  }
  if (entry.embeddingCoverage) {
    compact.embeddingCoverage = entry.embeddingCoverage;
  }
  if (entry.ownershipCoverage) {
    compact.ownershipCoverage = entry.ownershipCoverage;
  }
  if (entry.blockedCoverage) {
    compact.blockedCoverage = entry.blockedCoverage;
  }
  if (entry.versionReadiness) {
    compact.versionReadiness = entry.versionReadiness;
  }
  if (entry.invariants) {
    compact.invariants = entry.invariants;
  }
  if (entry.gateSignal) {
    compact.gateSignal = entry.gateSignal;
  }
  return compact;
}

function normalizeDocsRagLabResult(result: DocsRagLabSearchResult) {
  const normalized = normalizeDocsSourceMetadata({
    sourcePath: result.sourcePath,
    sourceId: result.sourceId,
  });
  const authority = Object.hasOwn(result, 'authority')
    ? (result.authority ?? null)
    : (normalized.authority ?? null);
  const canonicalUrl = Object.hasOwn(result, 'canonicalUrl') ? (result.canonicalUrl ?? null) : null;
  const sourceRevision = Object.hasOwn(result, 'sourceRevision')
    ? (result.sourceRevision ?? null)
    : null;
  const syncedAt = Object.hasOwn(result, 'syncedAt') ? (result.syncedAt ?? null) : null;
  const missingFields = result.missingFields
    ? [...result.missingFields]
    : DOCS_RAG_REQUIRED_PROVENANCE_FIELDS.filter((field) => {
        if (field === 'canonicalUrl') return canonicalUrl === null;
        if (field === 'sourceRevision') return sourceRevision === null;
        if (field === 'syncedAt') return syncedAt === null;
        return authority === null;
      });
  const provenanceStatus =
    result.provenanceStatus ?? (missingFields.length === 0 ? 'complete' : 'degraded');
  return {
    sourceId: result.sourceId,
    sourcePath: result.sourcePath,
    canonicalUrl,
    title: result.title,
    heading: result.heading ?? null,
    section: result.section ?? null,
    chunkIndex: result.chunkIndex,
    sourceRevision,
    syncedAt,
    authority,
    score: result.score,
    content: result.content,
    provenanceStatus,
    missingFields,
    citationPath: result.sourcePath,
    source: {
      sourceId: normalized.sourceId,
      category: normalized.category,
      language: normalized.language,
      kind: normalized.kind,
      authority,
      tags: normalized.tags,
      lang: normalized.lang,
      ecosystem: normalized.ecosystem,
      lib: normalized.lib,
    },
  };
}

function matchesDocsRagLabSearchFilters(
  result: DocsRagLabSearchResult,
  filter: DocsSourceFilter
): boolean {
  return matchesDocsSourceFilter(
    {
      sourcePath: result.sourcePath,
      sourceId: result.sourceId,
    },
    filter
  );
}

export function normalizeDocsRagLabSearchReport(
  report: DocsRagLabSearchReport,
  filter: DocsSourceFilter,
  limit: number
) {
  const results = report.results
    .filter((result) => matchesDocsRagLabSearchFilters(result, filter))
    .slice(0, limit)
    .map(normalizeDocsRagLabResult);

  return {
    query: report.query,
    limit,
    mode: report.mode,
    results,
    count: results.length,
    warnings: [],
  };
}

function hasDocsSearchPostFilters(filter: DocsSourceFilter): boolean {
  return Boolean(
    (filter.sourceIds?.length ?? 0) > 0 ||
      (filter.categories?.length ?? 0) > 0 ||
      filter.sourceId ||
      filter.category ||
      filter.language ||
      filter.kind ||
      filter.authority ||
      (filter.tags?.length ?? 0) > 0
  );
}

export function resolveDocsSearchBackendSourceIds(filter: DocsSourceFilter): string[] | undefined {
  if (!hasDocsSearchPostFilters(filter)) {
    return undefined;
  }
  const matches = DOCS_SOURCE_REGISTRY.filter((source) =>
    matchesDocsSourceFilter(source, filter)
  ).map((source) => source.sourceId);
  return matches.length > 0 ? matches : ['__no_matching_source__'];
}

export function resolveRagctlDocsRagLabConfig(env: NodeJS.ProcessEnv = process.env) {
  return resolveDocsRagLabConfigWithLocalDefault(env);
}

export function resolveRagctlProjectBackend() {
  return 'postgres';
}

export { resolveDocsRagReadiness } from './lib/docs-readiness.js';

class LiveRagctlService implements RagctlService {
  private readonly projectApplicationService = createProjectRagApplicationService({
    closePool: true,
  });

  async health() {
    const docsConfig = resolveRagctlDocsRagLabConfig();
    const [docsPostgres, docsCorpus] = await Promise.all([
      checkDocsRagLabDatabaseHealth(docsConfig),
      checkDocsRagLabCorpusHealth(docsConfig),
    ]);
    const projectBackend = resolveRagctlProjectBackend();
    const projects = await this.checkProjectPostgresReadiness();
    const embeddings = await this.checkProjectPostgresEmbeddingReadiness();
    const docsFreshness = readDocsRagFreshness({ cwd: REPO_ROOT });
    const warnings = docsFreshness.warning ? [docsFreshness.warning] : [];
    // GPU proof is diagnostic only — do not demote vector-search availability
    // when the embedding HTTP request already succeeded.
    if (embeddings.ok && embeddings.gpu && !embeddings.gpu.ok) {
      warnings.push(
        `Embedding GPU proof: ${embeddings.gpu.message}${
          embeddings.gpu.details ? ` (${embeddings.gpu.details})` : ''
        }`
      );
    }
    if (docsCorpus.status !== 'healthy') {
      warnings.push(`Docs corpus: ${docsCorpus.message ?? docsCorpus.status}`);
    }
    const docsReadiness = resolveDocsRagReadiness({
      docsPostgresStatus: docsPostgres.status,
      docsCorpusStatus: docsCorpus.status,
      docsFreshnessStatus: docsFreshness.status,
      embeddingAvailable: embeddings.ok,
    });

    return {
      status: docsReadiness.ready && projects.ok && embeddings.ok ? 'ok' : 'degraded',
      projectBackend,
      docsPostgres,
      docsCorpus,
      projects,
      embeddings,
      docsFreshness,
      warnings,
      capabilities: {
        docsKeywordSearch: docsReadiness.keywordSearchAvailable,
        docsSearch: docsReadiness.searchAvailable,
        docsVectorSearch: docsReadiness.searchAvailable,
        docsHybridSearch: docsReadiness.searchAvailable,
        docsReady: docsReadiness.ready,
        // Keyword-only mode is deprecated; hybrid always needs embeddings.
        projectKeywordSearch: false,
        // Uncached hybrid/vector search needs Postgres + live embedding lane.
        projectVectorSearch: projects.ok && embeddings.ok,
        projectPostgresSearch: projects.ok && embeddings.ok,
        // file/outline/symbol/verify need only the Postgres project store.
        projectMetadataLookup: projects.ok,
      },
    };
  }

  async docsHealth() {
    const config = resolveRagctlDocsRagLabConfig();
    const docsPostgresPromise = checkDocsRagLabDatabaseHealth(config);
    const docsCorpusPromise = checkDocsRagLabCorpusHealth(config);
    const [docsPostgres, docsCorpus] = await Promise.all([docsPostgresPromise, docsCorpusPromise]);
    const embeddings = await this.checkDocsEmbeddingReadiness(config);
    const docsFreshness = readDocsRagFreshness({ cwd: REPO_ROOT });
    const warnings = docsFreshness.warning ? [docsFreshness.warning] : [];
    if (docsCorpus.status !== 'healthy') {
      warnings.push(`Docs corpus: ${docsCorpus.message ?? docsCorpus.status}`);
    }
    const docsReadiness = resolveDocsRagReadiness({
      docsPostgresStatus: docsPostgres.status,
      docsCorpusStatus: docsCorpus.status,
      docsFreshnessStatus: docsFreshness.status,
      embeddingAvailable: embeddings.ok,
    });

    return {
      status: docsReadiness.ready ? 'ok' : 'degraded',
      docsPostgres,
      docsCorpus,
      embeddings,
      docsFreshness,
      warnings,
      capabilities: {
        docsKeywordSearch: docsReadiness.keywordSearchAvailable,
        docsSearch: docsReadiness.searchAvailable,
        docsVectorSearch: docsReadiness.searchAvailable,
        docsHybridSearch: docsReadiness.searchAvailable,
        docsReady: docsReadiness.ready,
      },
    };
  }

  async listProjects(args: { includeEphemeral: boolean; limit: number }) {
    const [{ resolveProjectRagPostgresConfigWithLocalDefault }, store] = await Promise.all([
      import('./project-rag/config.js'),
      import('./project-rag/store.js'),
    ]);
    const config = resolveProjectRagPostgresConfigWithLocalDefault();
    const sql = store.createProjectRagPostgresSql(config);
    try {
      const projects = await store.listProjectRagPostgresProjects(sql, {
        limit: args.limit,
        includeEphemeral: args.includeEphemeral,
      });
      return {
        backend: 'postgres',
        projects,
        count: projects.length,
      };
    } finally {
      if (config.database.url) {
        await store.closeProjectRagPostgresSql(config.database.url);
      }
    }
  }

  async searchDocs(args: RagctlDocsSearchArgs) {
    const sourceFilter: DocsSourceFilter = {
      sourceIds: args.sourceIds,
      categories: args.categories,
      language: args.language,
      kind: args.kind,
      authority: args.authority,
      tags: args.tags,
    };
    const backendLimit = hasDocsSearchPostFilters(sourceFilter)
      ? Math.min(Math.max(args.limit * 4, args.limit), 50)
      : args.limit;
    const sourceIds = resolveDocsSearchBackendSourceIds(sourceFilter);
    const report = await searchDocsRagLab(resolveRagctlDocsRagLabConfig(), args.query, {
      limit: backendLimit,
      sourceIds,
      mode: args.mode,
    });

    return normalizeDocsRagLabSearchReport(report, sourceFilter, args.limit);
  }

  async searchProject(args: {
    project: string;
    query: string;
    limit: number;
    mode: RagctlProjectSearchMode;
  }) {
    try {
      return await this.projectApplicationService.searchProject(args);
    } catch (error) {
      return mapProjectApplicationError(error);
    }
  }

  async getProjectFile(args: { project: string; file: string; limit: number }) {
    try {
      return await this.projectApplicationService.getProjectFile(args);
    } catch (error) {
      return mapProjectApplicationError(error);
    }
  }

  async getProjectOutline(args: { project: string; file: string; limit: number }) {
    try {
      return await this.projectApplicationService.getProjectOutline(args);
    } catch (error) {
      return mapProjectApplicationError(error);
    }
  }

  async findProjectSymbol(args: { project: string; name: string; type?: string; limit: number }) {
    try {
      return await this.projectApplicationService.findProjectSymbol(args);
    } catch (error) {
      return mapProjectApplicationError(error);
    }
  }

  async verifyProject(args: { project: string }) {
    try {
      const report = await this.projectApplicationService.verifyProject({
        project: args.project,
        query: 'project rag postgres search',
        limit: 3,
        includeSearch: true,
      });
      return {
        ...report,
        search: {
          query: report.query,
          resultCount: report.resultCount,
          topResult: report.topResult,
        },
      };
    } catch (error) {
      return mapProjectApplicationError(error);
    }
  }

  async prepareProject(args: {
    rootPath: string;
    project?: string;
    includeRoots?: string[];
    timeoutMs?: number;
    maxFiles?: number;
    maxBatches?: number;
  }) {
    try {
      return await prepareProject({
        ...args,
        runtime: {
          env: {
            ...process.env,
            RAG_REPO_ROOT: process.env.RAG_REPO_ROOT ?? REPO_ROOT,
          },
        },
      });
    } catch (error) {
      return mapProjectPrepareError(error);
    }
  }

  private async checkProjectPostgresReadiness() {
    const [{ resolveProjectRagPostgresConfigWithLocalDefault }, store] = await Promise.all([
      import('./project-rag/config.js'),
      import('./project-rag/store.js'),
    ]);
    const config = resolveProjectRagPostgresConfigWithLocalDefault();
    const sql = store.createProjectRagPostgresSql(config);
    try {
      const [projectCount, project] = await Promise.all([
        store.countProjectRagPostgresProjects(sql, { includeEphemeral: false }),
        store.findProjectRagPostgresHealthSample(sql),
      ]);
      const stats = project
        ? await store.getProjectRagPostgresProjectStats(sql, project.id)
        : undefined;
      return {
        ok: true,
        database: config.database.redactedUrl,
        projectCount,
        sampleProject: project,
        sampleStats: stats,
      };
    } catch (error) {
      return {
        ok: false,
        database: config.database.redactedUrl,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (config.database.url) {
        await store.closeProjectRagPostgresSql(config.database.url);
      }
    }
  }

  private async checkEmbeddingReadiness(
    config: Pick<DocsRagLabConfig['embedding'], 'provider' | 'model' | 'baseUrl' | 'dimensions'>,
    fetchEmbeddings: () => Promise<number[][]>
  ): Promise<RagctlEmbeddingReadiness> {
    // Always exercise the live embedding request. GPU proof is attached as a
    // separate diagnostic and must not flip operational availability.
    const observed = await checkLlamaCppGpuOffloadDuringRequest(
      config.provider,
      config.baseUrl,
      fetchEmbeddings,
      undefined,
      undefined,
      config.dimensions
    );
    const embedding = observed.value?.[0];
    if (!embedding || !Array.isArray(embedding)) {
      return {
        ok: false,
        provider: 'llamacpp-openai-compatible',
        model: config.model,
        expectedDimensions: config.dimensions,
        gpu: observed.gpu,
        error: 'Embedding provider returned no vector for health probe',
      };
    }
    const dimensionsMatch = embedding.length === config.dimensions;
    return {
      ok: dimensionsMatch,
      provider: 'llamacpp-openai-compatible',
      model: config.model,
      dimensions: embedding.length,
      expectedDimensions: config.dimensions,
      gpu: observed.gpu,
    };
  }

  private async checkProjectPostgresEmbeddingReadiness(): Promise<RagctlEmbeddingReadiness> {
    try {
      const { fetchProjectRagPostgresEmbeddings, resolveProjectRagPostgresEmbeddingConfig } =
        await import('./project-rag/embeddings.js');
      const config = resolveProjectRagPostgresEmbeddingConfig();
      return await this.checkEmbeddingReadiness(config, () =>
        fetchProjectRagPostgresEmbeddings(config, ['ragctl health'])
      );
    } catch (error) {
      return {
        ok: false,
        provider: 'llamacpp-openai-compatible',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkDocsEmbeddingReadiness(
    config: DocsRagLabConfig
  ): Promise<RagctlEmbeddingReadiness> {
    try {
      return await this.checkEmbeddingReadiness(config.embedding, async () => {
        const response = await fetch(`${config.embedding.baseUrl}/v1/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.embedding.model,
            input: ['ragctl health'],
          }),
          signal: AbortSignal.timeout(config.embedding.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(
            `Embedding provider API error ${response.status}: ${await response.text()}`
          );
        }

        const payload = asRecord(await response.json());
        const embeddings = Array.isArray(payload.data)
          ? payload.data.map((entry) => asRecord(entry).embedding)
          : Array.isArray(payload.embeddings)
            ? payload.embeddings
            : Array.isArray(payload.embedding)
              ? [payload.embedding]
              : [];
        if (embeddings.length !== 1) {
          throw new Error(
            `Embedding provider returned ${embeddings.length} embeddings for 1 input`
          );
        }

        const embedding = embeddings[0];
        return [
          Array.isArray(embedding) &&
          embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
            ? (embedding as number[])
            : [],
        ];
      });
    } catch (error) {
      return {
        ok: false,
        provider: 'llamacpp-openai-compatible',
        model: config.embedding.model,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function createLiveService(_parsed: ParsedRagctlArgs): RagctlService {
  return new LiveRagctlService();
}

async function executeCommand(
  argv: string[],
  parsed: ParsedRagctlArgs,
  service: RagctlService
): Promise<RagctlEnvelope> {
  const [family, action] = parsed.positionals;

  if (!family || family === 'help') {
    throw new RagctlError(2, 'INVALID_INPUT', helpText());
  }

  if (family === 'health') {
    return envelope('health', await service.health());
  }

  if (family === 'docs' && action === 'health') {
    return envelopeWithDataWarnings('docs health', await service.docsHealth());
  }

  if (family === 'projects' && action === 'list') {
    const includeEphemeral = parsed.flags.has('include-ephemeral');
    return envelope(
      'projects list',
      await service.listProjects({
        includeEphemeral,
        limit: parseLimit(parsed, 100, 500),
      })
    );
  }

  if (family === 'docs' && action === 'sources' && parsed.positionals[2] === 'list') {
    const sources = listDocsSources();
    return envelope('docs sources list', {
      sources,
      count: sources.length,
    });
  }

  if (family === 'docs' && action === 'search') {
    const categories = repeatedOption(argv, 'category');
    const sourceIds = [...repeatedOption(argv, 'source'), ...repeatedOption(argv, 'source-id')];
    const tags = repeatedOption(argv, 'tag');
    return envelopeWithDataWarnings(
      'docs search',
      await service.searchDocs({
        query: requireQuery(parsed, 2),
        limit: parseLimit(parsed, 10),
        categories: categories.length > 0 ? categories : undefined,
        sourceIds: sourceIds.length > 0 ? sourceIds : undefined,
        language: option(parsed, 'language'),
        kind: parseDocsSourceKind(parsed),
        authority: parseDocsSourceAuthority(parsed),
        tags: tags.length > 0 ? tags : undefined,
        mode: parseSearchMode(parsed),
      })
    );
  }

  if (family === 'project' && action === 'search') {
    return envelopeWithDataWarnings(
      'project search',
      await service.searchProject({
        project: requireString(option(parsed, 'project'), '--project'),
        query: requireQuery(parsed, 2),
        limit: parseLimit(parsed, 10),
        mode: parseProjectSearchMode(parsed),
      })
    );
  }

  if (family === 'project' && action === 'file') {
    const full = parsed.flags.has('full');
    const includeContent = full || parsed.flags.has('include-content');
    const data = await service.getProjectFile({
      project: requireString(option(parsed, 'project'), '--project'),
      file: option(parsed, 'file') ?? '',
      limit: parseLimit(parsed, 20, 200),
    });
    return envelope(
      'project file',
      full ? data : compactProjectFileResult(data, { includeContent })
    );
  }

  if (family === 'project' && action === 'outline') {
    const full = parsed.flags.has('full');
    const includeSkeleton = full || parsed.flags.has('include-skeleton');
    const data = await service.getProjectOutline({
      project: requireString(option(parsed, 'project'), '--project'),
      file: requireString(option(parsed, 'file'), '--file'),
      limit: parseLimit(parsed, 100, 500),
    });
    return envelope(
      'project outline',
      full ? data : compactProjectOutlineResult(data, { includeSkeleton })
    );
  }

  if (family === 'project' && action === 'symbol') {
    const full = parsed.flags.has('full');
    const includeReferences = full || parsed.flags.has('references');
    const data = await service.findProjectSymbol({
      project: requireString(option(parsed, 'project'), '--project'),
      name: requireString(option(parsed, 'name'), '--name'),
      type: option(parsed, 'type'),
      limit: parseLimit(parsed, 10),
    });
    return envelope(
      'project symbol',
      full ? data : compactProjectSymbolResult(data, { includeReferences })
    );
  }

  if (family === 'project' && action === 'verify') {
    const full = parsed.flags.has('full');
    const data = await service.verifyProject({
      project: requireString(option(parsed, 'project'), '--project'),
    });
    return envelope('project verify', full ? data : compactProjectVerifyResult(data));
  }

  if (family === 'project' && action === 'prepare') {
    const parseBound = (name: string, fallback?: number, max = 3_600_000): number | undefined => {
      const raw = option(parsed, name);
      if (!raw) return fallback;
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new RagctlError(2, 'INVALID_INPUT', `--${name} must be a positive integer`);
      }
      return Math.min(value, max);
    };
    const includeRoots = repeatedOption(argv, 'include-root');
    const timeoutMs = parseBound('timeout-ms');
    const maxFiles = parseBound('max-files', undefined, 2_000);
    const maxBatches = parseBound('max-batches', undefined, 128);
    const data = await service.prepareProject({
      rootPath: requireString(option(parsed, 'root'), '--root'),
      project: option(parsed, 'project'),
      ...(includeRoots.length > 0 ? { includeRoots } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxFiles !== undefined ? { maxFiles } : {}),
      ...(maxBatches !== undefined ? { maxBatches } : {}),
    });
    return envelope('project prepare', data);
  }

  throw new RagctlError(
    2,
    'INVALID_INPUT',
    `Unknown command: ${parsed.positionals.slice(0, 2).join(' ')}`
  );
}

export async function runRagctl(
  argv: string[],
  serviceFactory: (parsed: ParsedRagctlArgs) => RagctlService = createLiveService
): Promise<RagctlRunResult> {
  const parsed = parseRagctlArgs(argv);
  const isPrepare = parsed.positionals[0] === 'project' && parsed.positionals[1] === 'prepare';
  if (isPrepare) enforceProjectPrepareIntent();
  else enforceReadOnlyProjectIntent();

  if (parsed.flags.has('help') || parsed.options.has('help')) {
    if (parsed.flags.has('json') || parsed.options.has('json')) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(envelope('help', { usage: helpText() }), null, 2)}\n`,
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: helpText(), stderr: '' };
  }

  if (
    parsed.positionals[0] === 'docs' &&
    parsed.positionals[1] === 'sources' &&
    parsed.positionals[2] === 'list'
  ) {
    const sources = listDocsSources();
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(
        envelope('docs sources list', {
          sources,
          count: sources.length,
        }),
        null,
        2
      )}\n`,
      stderr: '',
    };
  }

  try {
    const service = serviceFactory(parsed);
    const result = await executeCommand(argv, parsed, service);
    const resultData = asRecord(result.data);
    const status = stringField(resultData.status);
    const exitCode: RagctlExitCode = !isPrepare
      ? 0
      : status === 'failed'
        ? 20
        : status && status !== 'ready'
          ? 5
          : 0;
    return {
      exitCode,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: '',
    };
  } catch (error) {
    const ragctlError =
      error instanceof RagctlError
        ? error
        : new RagctlError(
            20,
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : String(error)
          );
    return {
      exitCode: ragctlError.exitCode,
      stdout: `${JSON.stringify(errorEnvelope(ragctlError), null, 2)}\n`,
      stderr: ragctlError.exitCode === 2 ? '' : `${ragctlError.message}\n`,
    };
  }
}

if (import.meta.main) {
  const result = await runRagctl(process.argv.slice(2));
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
