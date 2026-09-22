function trimToUndefined(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function stripTrailingSlash(value: string): string {
  if (value === '/') {
    return value;
  }
  return value.replace(/[\\/]+$/, '');
}

const BLOCKED_PROJECT_ROOT_PREFIXES = [
  '/etc',
  '/root',
  '/var',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/sys',
  '/proc',
  '/dev',
  '/boot',
  '/srv',
  '/run',
  '/System',
  '/Library',
  '/Applications',
  '/mnt/c/Windows',
  '/mnt/c/Program Files',
  '/mnt/c/Program Files (x86)',
] as const;

const BLOCKED_PROJECT_ROOT_EXACT = ['/', '/home'] as const;
const DOT_INCLUDE_ROOT_ALLOWLIST = new Set(['.github']);

function isAbsoluteProjectRootPath(rootPath: string): boolean {
  return rootPath.startsWith('/') || /^[a-zA-Z]:\//.test(rootPath) || rootPath.startsWith('//');
}

function isWindowsSystemRootPath(rootPath: string): boolean {
  return /^[a-zA-Z]:\/(?:Windows|Program Files|Program Files \(x86\))(?:\/|$)/i.test(rootPath);
}

export function isBlockedProjectRootPath(rootPath: string): boolean {
  const normalized = stripTrailingSlash(rootPath.replace(/\\/g, '/'));
  const userHome = trimToUndefined(process.env.HOME?.replace(/\\/g, '/'));

  if (
    BLOCKED_PROJECT_ROOT_EXACT.includes(normalized as (typeof BLOCKED_PROJECT_ROOT_EXACT)[number])
  ) {
    return true;
  }

  if (userHome && normalized === stripTrailingSlash(userHome)) {
    return true;
  }

  if (isWindowsSystemRootPath(normalized)) {
    return true;
  }

  return BLOCKED_PROJECT_ROOT_PREFIXES.some(
    (blockedPath) => normalized === blockedPath || normalized.startsWith(`${blockedPath}/`)
  );
}

function normalizeProjectIncludeRoot(includeRoot: string): string {
  const trimmed = includeRoot.trim();
  if (!trimmed) {
    throw new Error('Project include roots must not be empty');
  }

  const normalized = stripTrailingSlash(trimmed.replace(/\\/g, '/').replace(/^\.\//, ''));

  if (!normalized || normalized === '.') {
    throw new Error('Project include roots must point to subfolders, not the repository root');
  }

  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new Error('Project include roots must be relative folder paths inside the repository');
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Project include roots must point to subfolders, not the repository root');
  }

  if (
    segments.some((segment) => segment.startsWith('.') && !DOT_INCLUDE_ROOT_ALLOWLIST.has(segment))
  ) {
    throw new Error('Project include roots must not target dot directories');
  }

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Project include roots must stay inside the repository root');
  }

  if (/[*?[\]{}]/.test(normalized)) {
    throw new Error('Project include roots must be explicit folders, not glob patterns');
  }

  return segments.join('/');
}

export function normalizeProjectRootPath(rootPath: string): string {
  const trimmed = rootPath.trim();
  if (!trimmed) {
    throw new Error('Project root path is required');
  }
  if (trimmed.includes('\0')) {
    throw new Error('Project root path contains an invalid null byte');
  }

  const normalized = stripTrailingSlash(trimmed.replace(/\\/g, '/'));
  if (!isAbsoluteProjectRootPath(normalized)) {
    throw new Error('Project root path must be absolute');
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Project root path must not contain traversal segments');
  }

  if (isBlockedProjectRootPath(normalized)) {
    throw new Error(`Project root path "${normalized}" is not allowed for indexing`);
  }

  return normalized;
}

export function normalizeProjectName(name: string, fallbackRootPath?: string): string {
  const trimmed = name.trim();
  if (trimmed) {
    return trimmed;
  }

  if (fallbackRootPath) {
    const parts = normalizeProjectRootPath(fallbackRootPath).split('/').filter(Boolean);
    const leafName = parts.length > 0 ? parts[parts.length - 1] : undefined;
    if (leafName) {
      return leafName;
    }
  }

  throw new Error('Project name is required');
}

function titleCaseProjectWord(word: string): string {
  if (!word) {
    return word;
  }
  if (/^[A-Z0-9]+$/.test(word)) {
    return word;
  }
  return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

export function inferProjectNameFromRootPath(rootPath: string): string {
  const parts = normalizeProjectRootPath(rootPath).split('/').filter(Boolean);
  const leafName = parts.length > 0 ? parts[parts.length - 1] : '';
  const shouldHumanize = /^\d{6,8}[-_]+/.test(leafName) || leafName.includes('_');
  if (!shouldHumanize) {
    return normalizeProjectName(leafName, rootPath);
  }

  const withoutDatePrefix = leafName.replace(/^\d{6,8}[-_]+/, '');
  const words = withoutDatePrefix.replace(/[-_]+/g, ' ').trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return normalizeProjectName('', rootPath);
  }

  return words.map(titleCaseProjectWord).join(' ');
}

export function createProjectSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) {
    throw new Error(`Could not derive a project slug from "${name}"`);
  }

  return slug;
}

export function normalizeIgnoreRules(ignoreRules?: string[]): string[] {
  if (!ignoreRules) {
    return [];
  }

  return [...new Set(ignoreRules.map((rule) => rule.trim()).filter(Boolean))];
}

export function normalizeProjectIncludeRoots(includeRoots?: string[]): string[] {
  if (!includeRoots || includeRoots.length === 0) {
    throw new Error(
      'Project include roots are required. Provide at least one relative folder to ingest.'
    );
  }

  return [...new Set(includeRoots.map((includeRoot) => normalizeProjectIncludeRoot(includeRoot)))];
}

export function normalizeStoredProjectIncludeRoots(includeRoots?: string[]): string[] {
  if (!includeRoots || includeRoots.length === 0) {
    return [];
  }

  return [...new Set(includeRoots.map((includeRoot) => normalizeProjectIncludeRoot(includeRoot)))];
}

export function normalizeOptionalText(value?: string): string | undefined {
  return trimToUndefined(value);
}

export type ProjectSensitivityLevel = 'public' | 'internal' | 'confidential' | 'restricted';

export interface ProjectSensitivityProfile {
  level: ProjectSensitivityLevel;
  allowGenerated: boolean;
  allowBinaries: boolean;
}

export const DEFAULT_PROJECT_SENSITIVITY_PROFILE = {
  level: 'internal',
  allowGenerated: false,
  allowBinaries: false,
} satisfies ProjectSensitivityProfile;

export function normalizeSensitivityProfile(
  profile?: ProjectSensitivityProfile
): ProjectSensitivityProfile {
  if (!profile) {
    return DEFAULT_PROJECT_SENSITIVITY_PROFILE;
  }

  return {
    level: profile.level,
    allowGenerated: profile.allowGenerated,
    allowBinaries: profile.allowBinaries,
  };
}
