import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { resolveRepoPath } from '../lib/runtime-env.js';
import { getSensitivePatterns } from '../lib/sensitive-patterns.js';

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 256_000;
const MAX_FINDING_SAMPLES = 20;
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.conf',
  '.css',
  '.env',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.rst',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const SECRET_LIKE_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^@\s]+@/i,
] as const;
const UNIX_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`])\/(?:home|Users|opt|srv|tmp|var|etc)\/[^\s"'`]+/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`])[A-Za-z]:\\[^\s"'`]+/;
const TRAVERSAL_PATTERN = /(?:^|[\s("'`])(?:\.\.\/|\.\.\\)[^\s"'`]*/;

export interface DocsRagLabRiskCounts {
  secretLikePathCount: number;
  secretLikeContentCount: number;
  absolutePathReferenceCount: number;
  traversalReferenceCount: number;
}

export interface DocsRagLabAuditFinding {
  readonly category: keyof DocsRagLabRiskCounts;
  readonly path: string;
  readonly line?: number;
  readonly reason: string;
}

export interface DocsRagLabAuditRootReport {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly kind: 'file' | 'directory' | 'missing';
  readonly status: 'scanned' | 'missing';
  readonly scannedFileCount: number;
  readonly skippedBinaryFileCount: number;
  readonly skippedLargeFileCount: number;
  readonly riskCounts: DocsRagLabRiskCounts;
}

export interface DocsRagLabAuditReport {
  readonly requestedPaths: string[];
  readonly rootReports: DocsRagLabAuditRootReport[];
  readonly findings: DocsRagLabAuditFinding[];
  readonly warnings: string[];
  readonly summary: DocsRagLabRiskCounts & {
    readonly requestedPathCount: number;
    readonly scannedRootCount: number;
    readonly missingRootCount: number;
    readonly scannedFileCount: number;
    readonly skippedBinaryFileCount: number;
    readonly skippedLargeFileCount: number;
    readonly fileLimitHit: boolean;
  };
}

export interface DocsRagLabAuditOptions {
  readonly cwd?: string;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

function createRiskCounts(): DocsRagLabRiskCounts {
  return {
    secretLikePathCount: 0,
    secretLikeContentCount: 0,
    absolutePathReferenceCount: 0,
    traversalReferenceCount: 0,
  };
}

function mergeRiskCounts(target: DocsRagLabRiskCounts, source: DocsRagLabRiskCounts): void {
  target.secretLikePathCount += source.secretLikePathCount;
  target.secretLikeContentCount += source.secretLikeContentCount;
  target.absolutePathReferenceCount += source.absolutePathReferenceCount;
  target.traversalReferenceCount += source.traversalReferenceCount;
}

function toDisplayPath(filePath: string, cwd: string): string {
  const relativePath = relative(cwd, filePath);
  if (!relativePath || relativePath.startsWith('..')) {
    return filePath;
  }

  return relativePath.split('\\').join('/');
}

function shouldTreatAsText(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === '' || TEXT_EXTENSIONS.has(extension);
}

function pushFinding(findings: DocsRagLabAuditFinding[], finding: DocsRagLabAuditFinding): void {
  if (findings.length < MAX_FINDING_SAMPLES) {
    findings.push(finding);
  }
}

function collectFiles(
  rootPath: string,
  maxFiles: number,
  warnings: string[]
): { files: string[]; fileLimitHit: boolean } {
  if (maxFiles <= 0) {
    return { files: [], fileLimitHit: true };
  }

  const files: string[] = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath) {
      continue;
    }

    const stats = lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      warnings.push(`Skipped symlink: ${currentPath}`);
      continue;
    }

    if (stats.isFile()) {
      files.push(currentPath);
      if (files.length >= maxFiles) {
        return { files, fileLimitHit: true };
      }
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = resolve(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symlink: ${nextPath}`);
        continue;
      }

      if (entry.isDirectory() || entry.isFile()) {
        queue.push(nextPath);
      }
    }
  }

  return { files, fileLimitHit: false };
}

function auditFilePath(
  filePath: string,
  sensitivePatterns: RegExp[],
  cwd: string,
  riskCounts: DocsRagLabRiskCounts,
  findings: DocsRagLabAuditFinding[]
): void {
  const displayPath = toDisplayPath(filePath, cwd);
  if (sensitivePatterns.some((pattern) => pattern.test(displayPath))) {
    riskCounts.secretLikePathCount += 1;
    pushFinding(findings, {
      category: 'secretLikePathCount',
      path: displayPath,
      reason: 'Path matches a sensitive filename pattern.',
    });
  }
}

function auditFileContent(
  filePath: string,
  content: string,
  cwd: string,
  riskCounts: DocsRagLabRiskCounts,
  findings: DocsRagLabAuditFinding[]
): void {
  const displayPath = toDisplayPath(filePath, cwd);
  const lines = content.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (SECRET_LIKE_CONTENT_PATTERNS.some((pattern) => pattern.test(line))) {
      riskCounts.secretLikeContentCount += 1;
      pushFinding(findings, {
        category: 'secretLikeContentCount',
        path: displayPath,
        line: lineNumber,
        reason: 'Line contains a secret-like marker or credential URL.',
      });
    }

    if (UNIX_ABSOLUTE_PATH_PATTERN.test(line) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(line)) {
      riskCounts.absolutePathReferenceCount += 1;
      pushFinding(findings, {
        category: 'absolutePathReferenceCount',
        path: displayPath,
        line: lineNumber,
        reason: 'Line contains an absolute filesystem path reference.',
      });
    }

    if (TRAVERSAL_PATTERN.test(line)) {
      riskCounts.traversalReferenceCount += 1;
      pushFinding(findings, {
        category: 'traversalReferenceCount',
        path: displayPath,
        line: lineNumber,
        reason: 'Line contains a path traversal-like reference.',
      });
    }
  }
}

export function auditDocsRagCorpusPaths(
  inputPaths: readonly string[],
  options: DocsRagLabAuditOptions = {}
): DocsRagLabAuditReport {
  const cwd = options.cwd ? resolve(options.cwd) : resolveRepoPath();
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const warnings: string[] = [];
  const rootReports: DocsRagLabAuditRootReport[] = [];
  const findings: DocsRagLabAuditFinding[] = [];
  const summaryCounts = createRiskCounts();
  const sensitivePatterns = getSensitivePatterns();
  let scannedFileCount = 0;
  let skippedBinaryFileCount = 0;
  let skippedLargeFileCount = 0;
  let fileLimitHit = false;

  for (const inputPath of inputPaths) {
    const resolvedPath = resolve(cwd, inputPath);
    let rootStats: ReturnType<typeof lstatSync> | undefined;
    try {
      rootStats = lstatSync(resolvedPath);
    } catch {
      rootReports.push({
        inputPath,
        resolvedPath,
        kind: 'missing',
        status: 'missing',
        scannedFileCount: 0,
        skippedBinaryFileCount: 0,
        skippedLargeFileCount: 0,
        riskCounts: createRiskCounts(),
      });
      warnings.push(`Missing audit path: ${toDisplayPath(resolvedPath, cwd)}`);
      continue;
    }

    const rootRiskCounts = createRiskCounts();
    let rootScannedFileCount = 0;
    let rootSkippedBinaryFileCount = 0;
    let rootSkippedLargeFileCount = 0;

    const { files, fileLimitHit: rootFileLimitHit } = collectFiles(
      resolvedPath,
      Math.max(0, maxFiles - scannedFileCount),
      warnings
    );
    fileLimitHit = fileLimitHit || rootFileLimitHit;
    for (const filePath of files) {
      auditFilePath(filePath, sensitivePatterns, cwd, rootRiskCounts, findings);

      const fileStats = lstatSync(filePath);
      if (fileStats.size > maxFileBytes) {
        skippedLargeFileCount += 1;
        rootSkippedLargeFileCount += 1;
        continue;
      }

      if (!shouldTreatAsText(filePath)) {
        skippedBinaryFileCount += 1;
        rootSkippedBinaryFileCount += 1;
        continue;
      }

      const buffer = readFileSync(filePath);
      if (buffer.includes(0)) {
        skippedBinaryFileCount += 1;
        rootSkippedBinaryFileCount += 1;
        continue;
      }

      rootScannedFileCount += 1;
      scannedFileCount += 1;
      auditFileContent(filePath, buffer.toString('utf8'), cwd, rootRiskCounts, findings);
    }

    mergeRiskCounts(summaryCounts, rootRiskCounts);
    rootReports.push({
      inputPath,
      resolvedPath,
      kind: rootStats.isDirectory() ? 'directory' : 'file',
      status: 'scanned',
      scannedFileCount: rootScannedFileCount,
      skippedBinaryFileCount: rootSkippedBinaryFileCount,
      skippedLargeFileCount: rootSkippedLargeFileCount,
      riskCounts: rootRiskCounts,
    });
  }

  if (fileLimitHit) {
    warnings.push(
      `Stopped after scanning ${scannedFileCount} files. Raise --max-files to inspect more.`
    );
  }

  return {
    requestedPaths: [...inputPaths],
    rootReports,
    findings,
    warnings,
    summary: {
      ...summaryCounts,
      requestedPathCount: inputPaths.length,
      scannedRootCount: rootReports.filter((root) => root.status === 'scanned').length,
      missingRootCount: rootReports.filter((root) => root.status === 'missing').length,
      scannedFileCount,
      skippedBinaryFileCount,
      skippedLargeFileCount,
      fileLimitHit,
    },
  };
}
