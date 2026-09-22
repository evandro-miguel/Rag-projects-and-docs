import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve as resolvePath } from 'node:path';
import { glob } from 'glob';
import {
  buildProjectIgnoreGlobPatterns,
  buildProjectIncludeGlobPatterns,
} from '../../lib/shared/project-include-roots.js';
import { SCRIPT_CONFIG } from '../../scripts/lib/config.js';
import { calculateProjectContentHash } from '../../scripts/lib/project-content-hash.js';

export type ProjectFreshnessStatus =
  | 'fresh'
  | 'fresh_with_metadata_drift'
  | 'stale'
  | 'missing'
  | 'unverified';

export interface ProjectFileFreshness {
  status: ProjectFreshnessStatus;
  checkedAt: string;
  reason?: string;
  indexedFileModifiedAt?: number;
  currentFileModifiedAt?: number;
  indexedContentHash?: string;
  currentContentHash?: string;
}

export interface ProjectFreshnessSummary {
  status: ProjectFreshnessStatus;
  checkedFiles: number;
  eligibleFiles: number;
  freshFiles: number;
  staleFiles: number;
  missingFiles: number;
  metadataDriftFiles: number;
  unverifiedFiles: number;
  stalePaths: string[];
  checkedAt: string;
  versionSignals?: {
    filesWithVersionMetadata: number;
    filesWithActiveReadyVersion: number;
    filesWithNonReadyActiveVersion: number;
    filesPendingVersionBackfill: number;
    filesUsingLegacyStatusRead: number;
  };
}

export interface ProjectFileVersionFreshnessState {
  hasVersionMetadata: boolean;
  activeVersionIsReady: boolean;
  activeVersionCompatibilityStatus?: string;
}

export interface ProjectIndexedFileRecord {
  _id: { toString(): string };
  _creationTime?: number;
  projectId?: unknown;
  sourcePath: string;
  absolutePath: string;
  contentHash: string;
  fileModifiedAt: number;
  sizeBytes?: number;
  status: string;
  metadataQuality?: string;
  activeVersionId?: unknown;
  latestVersionId?: unknown;
  updatedAt?: number;
}

export interface ProjectScopeCoverageSummary {
  status: 'covered' | 'drift' | 'unverified';
  checkedAt: string;
  expectedFiles: number;
  trackedFiles: number;
  indexedFiles: number;
  missingExpectedFiles: number;
  extraIndexedFiles: number;
  ignoredExpectedFiles: number;
  ignoredIndexedFiles: number;
  missingExpectedPaths: string[];
  extraIndexedPaths: string[];
  ignoredExpectedPaths: string[];
  ignoredIndexedPaths: string[];
  reason?: string;
}

const PROJECT_DEFAULT_IGNORES = [
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

  // Generated repo-map / analysis artifacts (not source code).
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
const COVERAGE_SAMPLE_LIMIT = 25;
const SEARCHABLE_COMPATIBILITY_STATUSES = new Set(['indexed', 'skipped']);

function resolveProjectFileGlobPattern(): string {
  const configured = process.env.PROJECT_FILE_GLOB?.trim();
  if (configured) {
    return configured;
  }

  const extensions = [...PROJECT_CODE_EXTENSIONS, ...PROJECT_TEXT_EXTENSIONS, 'json'].sort();
  return `**/*.{${extensions.join(',')}}`;
}

function getProjectIgnoreList(projectIgnoreRules?: string[]): string[] {
  const userIgnores = SCRIPT_CONFIG.PROJECT_IGNORE_PATTERNS
    ? SCRIPT_CONFIG.PROJECT_IGNORE_PATTERNS.split(',')
        .map((pattern) => pattern.trim())
        .filter(Boolean)
    : [];

  return [
    ...PROJECT_DEFAULT_IGNORES,
    ...buildProjectIgnoreGlobPatterns(projectIgnoreRules),
    ...userIgnores,
  ];
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

function shouldIngestProjectFile(sourcePath: string, sizeBytes: number): boolean {
  const normalizedPath = sourcePath.replace(/\\/g, '/').replace(/^\.\//, '');

  // Generated repo-map / analysis artifacts are never useful for RAG indexing.
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

  if (ext === 'json') {
    return isRelevantProjectJsonFile(normalizedPath, sizeBytes);
  }

  return false;
}

function toSourcePath(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).replace(/\\/g, '/');
}

function selectRelevantPaths(projectRoot: string, absolutePaths: Iterable<string>): Set<string> {
  const selected = new Set<string>();

  for (const absolutePath of absolutePaths) {
    try {
      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        continue;
      }

      const sourcePath = toSourcePath(projectRoot, absolutePath);
      if (shouldIngestProjectFile(sourcePath, stats.size)) {
        selected.add(sourcePath);
      }
    } catch {
      // Ignore files that disappear during verification.
    }
  }

  return selected;
}

async function scanProjectScope(
  projectRoot: string,
  includeRoots: string[],
  ignoreRules?: string[]
): Promise<{
  expectedPaths: Set<string>;
  ignoredRelevantPaths: Set<string>;
}> {
  const scanPatterns = buildProjectIncludeGlobPatterns(
    includeRoots,
    resolveProjectFileGlobPattern()
  );
  const ignoreList = getProjectIgnoreList(ignoreRules);
  const rawMatches = new Set<string>();
  const scopedMatches = new Set<string>();

  for (const pattern of scanPatterns) {
    const [allPaths, includedPaths] = await Promise.all([
      glob(pattern, {
        cwd: projectRoot,
        absolute: true,
        nodir: true,
      }),
      glob(pattern, {
        cwd: projectRoot,
        absolute: true,
        nodir: true,
        ignore: ignoreList,
      }),
    ]);

    for (const match of allPaths) {
      rawMatches.add(match);
    }
    for (const match of includedPaths) {
      scopedMatches.add(match);
    }
  }

  const expectedPaths = selectRelevantPaths(projectRoot, scopedMatches);
  const relevantRawPaths = selectRelevantPaths(projectRoot, rawMatches);
  const ignoredRelevantPaths = new Set(
    [...relevantRawPaths].filter((path) => !expectedPaths.has(path))
  );

  return { expectedPaths, ignoredRelevantPaths };
}

export function isFreshnessCheckEligible(
  file: ProjectIndexedFileRecord,
  versionState?: ProjectFileVersionFreshnessState
): boolean {
  if (file.status === 'indexed' || file.status === 'skipped') {
    return true;
  }

  if (!versionState) {
    return file.activeVersionId !== undefined;
  }

  return (
    versionState.activeVersionIsReady &&
    SEARCHABLE_COMPATIBILITY_STATUSES.has(versionState.activeVersionCompatibilityStatus ?? '')
  );
}

export function formatFreshnessStatus(status: ProjectFreshnessStatus): string {
  switch (status) {
    case 'fresh':
      return 'Fresh';
    case 'fresh_with_metadata_drift':
      return 'Fresh (metadata drift)';
    case 'stale':
      return 'Stale';
    case 'missing':
      return 'Missing on disk';
    case 'unverified':
      return 'Unverified';
  }
}

function resolveIndexedAbsolutePath(projectRoot: string, file: ProjectIndexedFileRecord): string {
  const normalizedRoot = resolvePath(projectRoot);
  const indexedAbsolutePath = resolvePath(file.absolutePath);
  if (
    indexedAbsolutePath === normalizedRoot ||
    indexedAbsolutePath.startsWith(`${normalizedRoot}/`)
  ) {
    return indexedAbsolutePath;
  }
  return resolvePath(join(normalizedRoot, file.sourcePath));
}

export async function assessProjectFileFreshness(
  projectRoot: string,
  file: ProjectIndexedFileRecord,
  versionState?: ProjectFileVersionFreshnessState
): Promise<ProjectFileFreshness> {
  const checkedAt = new Date().toISOString();

  if (!isFreshnessCheckEligible(file, versionState)) {
    return {
      status: 'unverified',
      checkedAt,
      reason: `status_${file.status}`,
      indexedFileModifiedAt: file.fileModifiedAt,
      indexedContentHash: file.contentHash,
    };
  }

  try {
    const absolutePath = resolveIndexedAbsolutePath(projectRoot, file);

    if (!existsSync(absolutePath)) {
      return {
        status: 'missing',
        checkedAt,
        reason: 'file_missing_on_disk',
        indexedFileModifiedAt: file.fileModifiedAt,
        indexedContentHash: file.contentHash,
      };
    }

    const currentFileModifiedAt = Math.floor(statSync(absolutePath).mtimeMs);
    if (currentFileModifiedAt === file.fileModifiedAt) {
      return {
        status: 'fresh',
        checkedAt,
        indexedFileModifiedAt: file.fileModifiedAt,
        currentFileModifiedAt,
        indexedContentHash: file.contentHash,
      };
    }

    const currentContentHash = await calculateProjectContentHash(
      readFileSync(absolutePath, 'utf8')
    );
    if (currentContentHash !== file.contentHash) {
      return {
        status: 'stale',
        checkedAt,
        reason: 'content_hash_mismatch',
        indexedFileModifiedAt: file.fileModifiedAt,
        currentFileModifiedAt,
        indexedContentHash: file.contentHash,
        currentContentHash,
      };
    }

    return {
      status: 'fresh_with_metadata_drift',
      checkedAt,
      reason: 'mtime_changed_but_hash_matches',
      indexedFileModifiedAt: file.fileModifiedAt,
      currentFileModifiedAt,
      indexedContentHash: file.contentHash,
      currentContentHash,
    };
  } catch (error) {
    return {
      status: 'unverified',
      checkedAt,
      reason: error instanceof Error ? error.message : String(error),
      indexedFileModifiedAt: file.fileModifiedAt,
      indexedContentHash: file.contentHash,
    };
  }
}

export async function summarizeProjectFreshness(
  projectRoot: string,
  files: ProjectIndexedFileRecord[],
  versionStatesByFileId?: Record<string, ProjectFileVersionFreshnessState>
): Promise<ProjectFreshnessSummary> {
  const versionSignals = {
    filesWithVersionMetadata: 0,
    filesWithActiveReadyVersion: 0,
    filesWithNonReadyActiveVersion: 0,
    filesPendingVersionBackfill: 0,
    filesUsingLegacyStatusRead: 0,
  };
  for (const file of files) {
    const versionState = versionStatesByFileId?.[file._id.toString()];
    const hasVersionMetadata =
      versionState?.hasVersionMetadata ??
      (file.activeVersionId !== undefined || file.latestVersionId !== undefined);
    if (hasVersionMetadata) {
      versionSignals.filesWithVersionMetadata++;
      const activeReady = versionState?.activeVersionIsReady ?? file.activeVersionId !== undefined;
      if (activeReady) {
        versionSignals.filesWithActiveReadyVersion++;
      } else {
        versionSignals.filesWithNonReadyActiveVersion++;
      }
    } else if (file.status === 'indexed' || file.status === 'skipped') {
      versionSignals.filesPendingVersionBackfill++;
      versionSignals.filesUsingLegacyStatusRead++;
    }
  }

  const eligibleFiles = files.filter((file) =>
    isFreshnessCheckEligible(file, versionStatesByFileId?.[file._id.toString()])
  );
  const freshnessChecks = await Promise.all(
    eligibleFiles.map(async (file) => ({
      sourcePath: file.sourcePath,
      freshness: await assessProjectFileFreshness(
        projectRoot,
        file,
        versionStatesByFileId?.[file._id.toString()]
      ),
    }))
  );

  const summary: ProjectFreshnessSummary = {
    status: 'fresh',
    checkedFiles: freshnessChecks.length,
    eligibleFiles: eligibleFiles.length,
    freshFiles: 0,
    staleFiles: 0,
    missingFiles: 0,
    metadataDriftFiles: 0,
    unverifiedFiles: 0,
    stalePaths: [],
    checkedAt: new Date().toISOString(),
    versionSignals,
  };

  for (const result of freshnessChecks) {
    switch (result.freshness.status) {
      case 'fresh':
        summary.freshFiles++;
        break;
      case 'fresh_with_metadata_drift':
        summary.freshFiles++;
        summary.metadataDriftFiles++;
        break;
      case 'stale':
        summary.staleFiles++;
        summary.stalePaths.push(result.sourcePath);
        break;
      case 'missing':
        summary.missingFiles++;
        summary.stalePaths.push(result.sourcePath);
        break;
      case 'unverified':
        summary.unverifiedFiles++;
        break;
    }
  }

  if (summary.staleFiles > 0 || summary.missingFiles > 0) {
    summary.status = 'stale';
  } else if (summary.unverifiedFiles > 0) {
    summary.status = 'unverified';
  } else if (summary.metadataDriftFiles > 0) {
    summary.status = 'fresh_with_metadata_drift';
  }

  return summary;
}

export async function summarizeProjectScopeCoverage(
  projectRoot: string,
  files: ProjectIndexedFileRecord[],
  options: {
    includeRoots?: string[];
    ignoreRules?: string[];
  }
): Promise<ProjectScopeCoverageSummary> {
  const checkedAt = new Date().toISOString();
  const includeRoots = (options.includeRoots ?? []).filter(
    (includeRoot): includeRoot is string =>
      typeof includeRoot === 'string' && includeRoot.trim().length > 0
  );

  if (includeRoots.length === 0) {
    return {
      status: 'unverified',
      checkedAt,
      expectedFiles: 0,
      trackedFiles: 0,
      indexedFiles: 0,
      missingExpectedFiles: 0,
      extraIndexedFiles: 0,
      ignoredExpectedFiles: 0,
      ignoredIndexedFiles: 0,
      missingExpectedPaths: [],
      extraIndexedPaths: [],
      ignoredExpectedPaths: [],
      ignoredIndexedPaths: [],
      reason: 'missing_include_roots',
    };
  }

  try {
    const { expectedPaths, ignoredRelevantPaths } = await scanProjectScope(
      projectRoot,
      includeRoots,
      options.ignoreRules
    );

    const trackedPaths = new Set(
      files.filter((file) => file.status !== 'deleted').map((file) => file.sourcePath)
    );
    const indexedPaths = new Set(
      files
        .filter((file) => file.status === 'indexed' || file.status === 'skipped')
        .map((file) => file.sourcePath)
    );

    const expectedPathList = [...expectedPaths].sort();
    const indexedPathList = [...indexedPaths].sort();
    const ignoredPathList = [...ignoredRelevantPaths].sort();

    const missingExpectedPaths = expectedPathList
      .filter((sourcePath) => !trackedPaths.has(sourcePath))
      .slice(0, COVERAGE_SAMPLE_LIMIT);
    const ignoredIndexedPaths = indexedPathList
      .filter((sourcePath) => ignoredRelevantPaths.has(sourcePath))
      .slice(0, COVERAGE_SAMPLE_LIMIT);
    const extraIndexedPaths = indexedPathList
      .filter(
        (sourcePath) => !expectedPaths.has(sourcePath) && !ignoredRelevantPaths.has(sourcePath)
      )
      .slice(0, COVERAGE_SAMPLE_LIMIT);

    const missingExpectedFiles = expectedPathList.filter(
      (sourcePath) => !trackedPaths.has(sourcePath)
    ).length;
    const ignoredIndexedFiles = indexedPathList.filter((sourcePath) =>
      ignoredRelevantPaths.has(sourcePath)
    ).length;
    const extraIndexedFiles = indexedPathList.filter(
      (sourcePath) => !expectedPaths.has(sourcePath) && !ignoredRelevantPaths.has(sourcePath)
    ).length;

    const status =
      missingExpectedFiles > 0 || extraIndexedFiles > 0 || ignoredIndexedFiles > 0
        ? 'drift'
        : 'covered';

    return {
      status,
      checkedAt,
      expectedFiles: expectedPathList.length,
      trackedFiles: trackedPaths.size,
      indexedFiles: indexedPaths.size,
      missingExpectedFiles,
      extraIndexedFiles,
      ignoredExpectedFiles: ignoredPathList.length,
      ignoredIndexedFiles,
      missingExpectedPaths,
      extraIndexedPaths,
      ignoredExpectedPaths: ignoredPathList.slice(0, COVERAGE_SAMPLE_LIMIT),
      ignoredIndexedPaths,
    };
  } catch (error) {
    return {
      status: 'unverified',
      checkedAt,
      expectedFiles: 0,
      trackedFiles: 0,
      indexedFiles: 0,
      missingExpectedFiles: 0,
      extraIndexedFiles: 0,
      ignoredExpectedFiles: 0,
      ignoredIndexedFiles: 0,
      missingExpectedPaths: [],
      extraIndexedPaths: [],
      ignoredExpectedPaths: [],
      ignoredIndexedPaths: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
