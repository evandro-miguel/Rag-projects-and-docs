import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeProjectIncludeRoots } from './project-registry.js';

const COMMON_INCLUDE_ROOT_CANDIDATES = [
  'src',
  'app',
  'apps',
  'packages',
  'libs',
  'lib',
  'mcp',
  'scripts',
  'docs',
  'infra',
  'server',
  'client',
  'web',
  'api',
  'services',
  'workers',
  'components',
] as const;

export const NOISY_INCLUDE_ROOT_SEGMENTS = new Set([
  '.afol',
  '.agent',
  '.agents',
  '.aider',
  '.cache',
  '.claude',
  '.continue',
  '.copilot',
  '.cursor',
  '.data',
  '.gemini',
  '.git',
  '.idea',
  '.opencode',
  '.vscode',
  '_generated',
  'archive',
  'archives',
  'artifacts',
  'build',
  'cache',
  'caches',
  'coverage',
  'dist',
  'generated',
  'logs',
  'log',
  'node_modules',
  'out',
  'output',
  'outputs',
  'playwright-report',
  'reports',
  'report',
  'scratch',
  'temp',
  'tmp',
  'vendor',
  'test-results',
]);

export type ProjectIncludeRootsValidationResult =
  | { valid: true; includeRoots: string[] }
  | {
      valid: false;
      code:
        | 'INCLUDE_ROOTS_REQUIRED'
        | 'INVALID_INCLUDE_ROOTS'
        | 'INCLUDE_ROOT_NOT_FOUND'
        | 'INCLUDE_ROOT_NOT_DIRECTORY'
        | 'INCLUDE_ROOT_IS_SYMLINK'
        | 'INCLUDE_ROOT_ESCAPES_ROOT';
      error: string;
      suggestions: string[];
    };

function normalizeSuggestedIncludeRootCandidate(candidate: string): string | undefined {
  const normalized = candidate.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized) {
    return undefined;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  // A root-level `ingest` directory is ambiguous: this repository uses it for
  // generated corpus input, while consumers may explicitly select it as a
  // source root. Keep it out of inferred suggestions; explicit validation is
  // contextual and permits it. Nested source folders remain discoverable.
  if (segments[0]?.toLowerCase() === 'ingest') {
    return undefined;
  }

  if (segments.some((segment) => segment.startsWith('.'))) {
    return undefined;
  }

  if (
    segments.some(
      (segment) =>
        NOISY_INCLUDE_ROOT_SEGMENTS.has(segment.toLowerCase()) ||
        /^generated([._-].+)?$/i.test(segment) ||
        /^archive([._-].+)?$/i.test(segment)
    )
  ) {
    return undefined;
  }

  return segments.join('/');
}

function collectProjectIncludeRootSuggestions(rootPath: string): string[] {
  const resolvedRoot = resolve(rootPath);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    return [];
  }

  const suggestions: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: string) => {
    const normalizedCandidate = normalizeSuggestedIncludeRootCandidate(candidate);
    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      return;
    }

    const candidatePath = resolve(resolvedRoot, normalizedCandidate);
    if (!existsSync(candidatePath) || !statSync(candidatePath).isDirectory()) {
      return;
    }

    seen.add(normalizedCandidate);
    suggestions.push(normalizedCandidate);
  };

  for (const candidate of COMMON_INCLUDE_ROOT_CANDIDATES) {
    addCandidate(candidate);
  }

  const discoveredCandidates = readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const candidate of discoveredCandidates) {
    addCandidate(candidate);
  }

  return suggestions;
}

export function suggestProjectIncludeRoots(rootPath: string): string[] {
  return collectProjectIncludeRootSuggestions(rootPath);
}

export function validateProjectIncludeRoots(
  rootPath: string,
  includeRoots?: string[]
): ProjectIncludeRootsValidationResult {
  const suggestions = suggestProjectIncludeRoots(rootPath);

  if (!includeRoots || includeRoots.length === 0) {
    return {
      valid: false,
      code: 'INCLUDE_ROOTS_REQUIRED',
      error: 'Project includeRoots are required. Provide at least one relative folder to ingest.',
      suggestions,
    };
  }

  let normalizedIncludeRoots: string[];
  try {
    normalizedIncludeRoots = normalizeProjectIncludeRoots(includeRoots);
  } catch (error) {
    return {
      valid: false,
      code: 'INVALID_INCLUDE_ROOTS',
      error: error instanceof Error ? error.message : String(error),
      suggestions,
    };
  }

  for (const includeRoot of normalizedIncludeRoots) {
    const segments = includeRoot.split('/').filter(Boolean);
    if (
      segments.some(
        (segment) =>
          NOISY_INCLUDE_ROOT_SEGMENTS.has(segment.toLowerCase()) ||
          /^generated([._-].+)?$/i.test(segment) ||
          /^archive([._-].+)?$/i.test(segment)
      )
    ) {
      return {
        valid: false,
        code: 'INVALID_INCLUDE_ROOTS',
        error: `Configured include root must not target generated, corpus, cache, or runtime directories: "${includeRoot}"`,
        suggestions,
      };
    }
  }

  const resolvedRoot = resolve(rootPath);
  const canonicalRoot = existsSync(resolvedRoot) ? realpathSync.native(resolvedRoot) : resolvedRoot;

  for (const includeRoot of normalizedIncludeRoots) {
    const absoluteIncludeRoot = resolve(resolvedRoot, includeRoot);

    if (!existsSync(absoluteIncludeRoot)) {
      return {
        valid: false,
        code: 'INCLUDE_ROOT_NOT_FOUND',
        error: `Configured include root does not exist: "${includeRoot}"`,
        suggestions,
      };
    }

    if (lstatSync(absoluteIncludeRoot).isSymbolicLink()) {
      return {
        valid: false,
        code: 'INCLUDE_ROOT_IS_SYMLINK',
        error: `Configured include root must not be a symlink: "${includeRoot}"`,
        suggestions,
      };
    }

    const canonicalIncludeRoot = realpathSync.native(absoluteIncludeRoot);
    if (
      canonicalIncludeRoot !== canonicalRoot &&
      !canonicalIncludeRoot.startsWith(`${canonicalRoot}/`)
    ) {
      return {
        valid: false,
        code: 'INCLUDE_ROOT_ESCAPES_ROOT',
        error: `Configured include root resolves outside the project root: "${includeRoot}"`,
        suggestions,
      };
    }

    if (!statSync(canonicalIncludeRoot).isDirectory()) {
      return {
        valid: false,
        code: 'INCLUDE_ROOT_NOT_DIRECTORY',
        error: `Configured include root is not a directory: "${includeRoot}"`,
        suggestions,
      };
    }
  }

  return {
    valid: true,
    includeRoots: normalizedIncludeRoots,
  };
}

function normalizeProjectIgnoreRule(rule: string): string | undefined {
  const normalized = rule.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized) {
    return undefined;
  }

  return normalized;
}

function expandProjectIgnoreRule(rule: string): string[] {
  const raw = rule.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const rootAnchored = raw.startsWith('/');
  const normalized = normalizeProjectIgnoreRule(raw);
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith('!')) {
    return [normalized];
  }

  if (normalized.startsWith('**/')) {
    return [normalized];
  }

  if (rootAnchored) {
    const baseName = normalized.split('/').pop() ?? normalized;
    const hasExtension = Boolean(baseName?.includes('.') && !baseName.startsWith('.'));
    return [hasExtension ? normalized : `${normalized}/**`];
  }

  const baseName = normalized.split('/').pop() ?? normalized;
  const hasExtension = Boolean(baseName?.includes('.') && !baseName.startsWith('.'));

  if (/[*?[\]{}]/.test(normalized)) {
    return [`**/${normalized}`];
  }

  if (normalized.includes('/')) {
    return hasExtension ? [`**/${normalized}`] : [`**/${normalized}/**`];
  }

  return hasExtension ? [`**/${normalized}`] : [`**/${normalized}/**`];
}

export function buildProjectIgnoreGlobPatterns(ignoreRules?: string[]): string[] {
  if (!ignoreRules || ignoreRules.length === 0) {
    return [];
  }

  const patterns = new Set<string>();
  for (const rule of ignoreRules) {
    for (const pattern of expandProjectIgnoreRule(rule)) {
      patterns.add(pattern);
    }
  }

  return [...patterns];
}

export function buildProjectIncludeGlobPatterns(
  includeRoots: string[],
  fileGlob: string
): string[] {
  const normalizedIncludeRoots = normalizeProjectIncludeRoots(includeRoots);
  const normalizedFileGlob = fileGlob.trim().replace(/^\.\//, '').replace(/^\/+/, '');

  return normalizedIncludeRoots.map((includeRoot) => `${includeRoot}/${normalizedFileGlob}`);
}
