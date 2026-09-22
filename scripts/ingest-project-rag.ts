import { statSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { glob } from 'glob';
import {
  buildProjectIgnoreGlobPatterns,
  buildProjectIncludeGlobPatterns,
} from '../lib/shared/project-include-roots.js';

const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/out/**',
  '**/.output/**',
  '**/.git/**',
  '**/.agent/**',
  '**/.agents/**',
  '**/.claude/**',
  '**/.gemini/**',
  '**/.cursor/**',
  '**/.copilot/**',
  '**/.opencode/**',
  '**/.aider/**',
  '**/.continue/**',
  '**/.vscode/**',
  '**/.idea/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/tests/screenshots/**',
  '**/tests/artifacts/**',
  '**/tests/reports/**',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/cypress/screenshots/**',
  '**/cypress/videos/**',
  '**/cypress/downloads/**',
  '**/.nyc_output/**',
  '**/junit*.xml',
  '**/coverage-final.json',
  '**/lcov-report/**',
  '**/lcov.info',
  '**/reports/**',
  '**/report/**',
  '**/bun.lockb',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/docs/map/extra/**',
] as const;

const PROJECT_CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'go',
  'rs',
  'java',
  'rb',
  'php',
  'cs',
  'cpp',
  'c',
  'h',
  'hpp',
  'swift',
  'kt',
  'kts',
  'scala',
  'sh',
  'bash',
  'zsh',
  'sql',
]);

const PROJECT_TEXT_EXTENSIONS = new Set(['md', 'mdx', 'yml', 'yaml']);
const PROJECT_JSON_SOURCE_DIR_PATTERN =
  /(^|\/)(src|app|apps|packages|libs|config|configs|schemas|migrations|scripts|docs|locales|i18n|messages)\//;
const MAX_RELEVANT_JSON_BYTES = 128 * 1024;
const DEFAULT_MAX_FILE_SIZE_BYTES = 5_000_000;
const MAX_PROJECT_EMBEDDING_INPUT_CHARS = 800;
const RETIRED_RUNTIME_MESSAGE =
  'Legacy project ingest is retired. Use bun run scripts/project-rag/ingest-package.ts instead.';

export interface CliArgs {
  project?: string;
  root?: string;
  includeRoots?: string[];
  force?: boolean;
  concurrency?: number;
  dryRun?: boolean;
}

export interface ProjectContext {
  projectId: string;
  projectRoot: string;
  projectName: string;
  projectSlug: string;
  includeRoots: string[];
  ignoreRules: string[];
}

export interface ProjectIngestionResult {
  project: ProjectContext;
  syncRunId: string;
  stats: {
    filesScanned: number;
    filesSelected: number;
    filesIndexed: number;
    filesAdded: number;
    filesUpdated: number;
    filesSkipped: number;
    filesBlocked: number;
    filesDeleted: number;
    chunksCreated: number;
    embeddingsCreated: number;
    symbolsCreated: number;
    edgesCreated: number;
    plannedFiles?: number;
    processedFiles?: number;
    remainingFiles?: number;
    errors: Array<{ file?: string; error: string }>;
  };
  finalStatus: 'completed' | 'partial';
}

export interface ProjectIngestionScopeEstimate {
  project: ProjectContext;
  scanPatterns: string[];
  scannedFileCount: number;
  selectedFileCount: number;
}

export interface ProjectFileIo {
  stat(path: string): { mtimeMs: number; size: number };
  readText(path: string): string;
}

export interface FileResult {
  sourcePath: string;
  absolutePath: string;
  status: 'indexed' | 'skipped' | 'blocked' | 'error';
  operation?: 'added' | 'updated';
  reason?: string;
  chunksCreated?: number;
  symbolsCreated?: number;
  edgesCreated?: number;
  error?: string;
}

function retiredRuntimeError(surface: string): Error {
  return new Error(`${surface} is retired. ${RETIRED_RUNTIME_MESSAGE}`);
}

function parseMaxFileSizeBytes(rawValue = process.env.RAG_MCP_PROJECT_MAX_FILE_BYTES): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FILE_SIZE_BYTES;
}

function buildDefaultProjectFileGlob(): string {
  const extensions = [...PROJECT_CODE_EXTENSIONS, ...PROJECT_TEXT_EXTENSIONS, 'json'].sort();
  return `**/*.{${extensions.join(',')}}`;
}

export function isProjectEmbeddingInputOversized(text: string): boolean {
  return text.length > MAX_PROJECT_EMBEDDING_INPUT_CHARS;
}

export function isProjectFileOverSizeLimit(
  sizeBytes: number,
  maxBytes = parseMaxFileSizeBytes()
): boolean {
  return sizeBytes > maxBytes;
}

export function resolveProjectFileGlobPattern(
  projectFileGlob: string | undefined = process.env.PROJECT_FILE_GLOB
): string {
  const configured = projectFileGlob?.trim();
  return configured || buildDefaultProjectFileGlob();
}

function isRelevantProjectJsonFile(sourcePath: string, sizeBytes: number): boolean {
  const normalizedPath = sourcePath.toLowerCase();
  const baseName = basename(normalizedPath);

  if (
    baseName === 'package.json' ||
    baseName === 'jsconfig.json' ||
    baseName === 'biome.json' ||
    baseName === 'bunfig.json' ||
    baseName === 'turbo.json' ||
    baseName === 'vercel.json' ||
    baseName === 'deno.json' ||
    baseName === 'components.json' ||
    baseName === 'manifest.json' ||
    baseName === 'openapi.json' ||
    baseName === 'typedoc.json' ||
    baseName === 'nest-cli.json' ||
    baseName === '.eslintrc.json' ||
    baseName === '.prettierrc.json' ||
    /^tsconfig(\..+)?\.json$/.test(baseName)
  ) {
    return true;
  }

  return (
    sizeBytes <= MAX_RELEVANT_JSON_BYTES && PROJECT_JSON_SOURCE_DIR_PATTERN.test(normalizedPath)
  );
}

export function shouldIngestProjectFile(sourcePath: string, sizeBytes: number): boolean {
  const normalizedPath = sourcePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalizedPath.startsWith('docs/map/extra/')) {
    return false;
  }

  const ext = normalizedPath.split('.').pop()?.toLowerCase();
  if (!ext) {
    return false;
  }

  if (PROJECT_CODE_EXTENSIONS.has(ext) || PROJECT_TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  return ext === 'json' && isRelevantProjectJsonFile(normalizedPath, sizeBytes);
}

export function buildSourcePath(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).replace(/\\/g, '/');
}

export function getIgnoreList(projectIgnoreRules?: string[]): string[] {
  const envIgnores = (process.env.RAG_MCP_PROJECT_IGNORE_PATTERNS ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);

  return [...DEFAULT_IGNORES, ...buildProjectIgnoreGlobPatterns(projectIgnoreRules), ...envIgnores];
}

function filterProjectFiles(files: string[], projectRoot: string): string[] {
  return files.filter((absolutePath) => {
    const sourcePath = buildSourcePath(projectRoot, absolutePath);
    return shouldIngestProjectFile(sourcePath, statSync(absolutePath).size);
  });
}

export async function scanProjectFiles(
  projectRoot: string,
  includeRoots: string[],
  ignoreList: string[]
): Promise<{
  scanPatterns: string[];
  scannedFiles: string[];
  files: string[];
}> {
  const scanPatterns = buildProjectIncludeGlobPatterns(
    includeRoots,
    resolveProjectFileGlobPattern()
  );
  const uniqueFiles = new Set<string>();

  for (const pattern of scanPatterns) {
    const matches = await glob(pattern, {
      cwd: projectRoot,
      absolute: true,
      ignore: ignoreList,
      nodir: true,
    });

    for (const match of matches) {
      uniqueFiles.add(match);
    }
  }

  const scannedFiles = [...uniqueFiles].sort();
  return {
    scanPatterns,
    scannedFiles,
    files: filterProjectFiles(scannedFiles, projectRoot),
  };
}

export async function resolveProjectContext(..._args: readonly unknown[]): Promise<never> {
  throw retiredRuntimeError('resolveProjectContext');
}

export async function ingestProjectRagFile(..._args: readonly unknown[]): Promise<never> {
  throw retiredRuntimeError('ingestProjectRagFile');
}

export async function ingestConfiguredProjectRagFile(..._args: readonly unknown[]): Promise<never> {
  throw retiredRuntimeError('ingestConfiguredProjectRagFile');
}

export async function runProjectRagIngestion(..._args: readonly unknown[]): Promise<never> {
  throw retiredRuntimeError('runProjectRagIngestion');
}

export async function runProjectRagReconciliation(..._args: readonly unknown[]): Promise<never> {
  throw retiredRuntimeError('runProjectRagReconciliation');
}

export async function estimateProjectRagIngestionScope(
  ..._args: readonly unknown[]
): Promise<never> {
  throw retiredRuntimeError('estimateProjectRagIngestionScope');
}

if (import.meta.main) {
  console.error(RETIRED_RUNTIME_MESSAGE);
  process.exit(1);
}
