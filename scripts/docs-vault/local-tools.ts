import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix as pathPosix, relative, resolve } from 'node:path';
import { loadDocsVaultSourceConfigs } from './config.js';
import { buildDocsVaultManifest, DOCS_VAULT_MANIFEST_VERSION } from './manifest.js';
import type { DocsVaultManifest, DocsVaultSourceConfig, DocsVaultSourceManifest } from './types.js';
import type {
  DocsVaultAliasIndexEntry,
  DocsVaultLinkIndexEntry,
  DocsVaultPageHeading,
  DocsVaultPageIndexEntry,
} from './writer.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

export type DocsVaultListDocSourcesOptions = {
  cwd?: string;
  configPath?: string;
  indexRoot?: string;
  manifest?: DocsVaultManifest;
  manifestPath?: string;
  sourceConfigs?: readonly DocsVaultSourceConfig[];
};

export type DocsVaultListedSource = DocsVaultSourceManifest & {
  aliasCount: number;
  linkCount: number;
  pageCount: number;
};

export type DocsVaultListDocSourcesResult = {
  manifestVersion: DocsVaultManifest['manifestVersion'];
  sources: readonly DocsVaultListedSource[];
};

export type DocsVaultSearchDocFilesOptions = {
  exact?: boolean;
  indexRoot: string;
  limit?: number;
  query: string;
  sourceIds?: readonly string[];
  vaultRoot: string;
};

export type DocsVaultSearchMatchKind =
  | 'exact-alias'
  | 'exact-path'
  | 'exact-title'
  | 'exact-description'
  | 'exact-content'
  | 'includes-alias'
  | 'includes-path'
  | 'includes-title'
  | 'includes-description'
  | 'includes-content';

export type DocsVaultSearchResult = {
  canonicalPath: string;
  canonicalUrl: string;
  matchedText?: string;
  pageId: string;
  path: string;
  rawPath: string;
  score: number;
  snippet?: string;
  sourceId: string;
  title: string;
  wikiPath: string;
  wikiReference: string;
  matchKind: DocsVaultSearchMatchKind;
};

export type DocsVaultSearchDocFilesResult = {
  exact: boolean;
  limit: number;
  query: string;
  results: readonly DocsVaultSearchResult[];
  totalMatches: number;
};

export type DocsVaultResolveDocLinkOptions = {
  indexRoot: string;
  link: string;
};

export type DocsVaultResolvedHeading = DocsVaultPageHeading;

export type DocsVaultResolvedLinkMatch = {
  canonicalPath: string;
  canonicalUrl: string;
  heading?: DocsVaultResolvedHeading;
  matchedText?: string;
  pageId: string;
  path: string;
  rawPath: string;
  sourceId: string;
  title: string;
  wikiPath: string;
  wikiReference: string;
  matchKind: 'wikiReference' | 'relativePath' | 'alias' | 'title';
};

export type DocsVaultResolveDocLinkResult = {
  anchor?: string;
  ambiguous: boolean;
  link: string;
  lookup: string;
  matchCount: number;
  matches: readonly DocsVaultResolvedLinkMatch[];
  resolved: DocsVaultResolvedLinkMatch | null;
};

export type DocsVaultPageFormat = 'canonical' | 'wiki' | 'raw';

export type DocsVaultGetDocPageOptions = {
  format: DocsVaultPageFormat;
  path: string;
  sourceId: string;
  vaultRoot: string;
};

export type DocsVaultGetDocPageResult = {
  content: string;
  format: DocsVaultPageFormat;
  path: string;
  relativePath: string;
  sourceId: string;
};

type DocsVaultIndexes = {
  aliases: readonly DocsVaultAliasIndexEntry[];
  links: readonly DocsVaultLinkIndexEntry[];
  pages: readonly DocsVaultPageIndexEntry[];
};

type DocsVaultParsedLookup = {
  anchor?: string;
  value: string;
};

type DocsVaultCandidate = {
  canonicalPath: string;
  canonicalUrl: string;
  matchedText?: string;
  matchKind: DocsVaultSearchMatchKind;
  pageId: string;
  path: string;
  rawPath: string;
  score: number;
  snippet?: string;
  sourceId: string;
  title: string;
  wikiPath: string;
  wikiReference: string;
};

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function splitQueryTerms(normalizedQuery: string): readonly string[] {
  return normalizedQuery.split(' ').filter((term) => term.length > 0);
}

function includesAllTerms(
  value: string | undefined,
  normalizedQueryTerms: readonly string[]
): boolean {
  if (!value || normalizedQueryTerms.length < 2) {
    return false;
  }

  const normalizedValue = normalizeText(value);
  return normalizedQueryTerms.every((term) => normalizedValue.includes(term));
}

function normalizeSourceId(sourceId: string): string {
  const normalized = sourceId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) {
    throw new Error(`Docs Vault sourceId '${sourceId}' is not safe to read`);
  }
  return normalized;
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Docs Vault search limit '${limit}' must be a positive integer`);
  }

  return Math.min(limit, MAX_SEARCH_LIMIT);
}

function ensureRootDirectory(root: string, label: string): string {
  const resolvedRoot = realpathSync(resolve(root));
  if (!statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Docs Vault ${label} '${root}' is not a directory`);
  }
  return resolvedRoot;
}

function isUnsafeRelativePath(relativePath: string): boolean {
  if (
    isAbsolute(relativePath) ||
    /^[a-zA-Z]:[\\/]/u.test(relativePath) ||
    relativePath.includes('\0')
  ) {
    return true;
  }

  const normalized = pathPosix.normalize(relativePath.replace(/\\/g, '/'));
  return (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  );
}

function normalizeSafeRelativePath(relativePath: string, label: string): string {
  const trimmed = relativePath.trim();
  if (isUnsafeRelativePath(trimmed)) {
    throw new Error(`Docs Vault ${label} '${relativePath}' is not safe to read`);
  }

  return pathPosix.normalize(trimmed.replace(/\\/g, '/'));
}

function assertPathWithinRoot(root: string, targetPath: string, label: string) {
  const relativeTarget = relative(root, targetPath).replace(/\\/g, '/');
  if (relativeTarget === '..' || relativeTarget.startsWith('../') || isAbsolute(relativeTarget)) {
    throw new Error(`Docs Vault ${label} '${targetPath}' escapes root '${root}'`);
  }
}

function resolveFileWithinRoot(root: string, relativePath: string, label: string): string {
  const safeRelativePath = normalizeSafeRelativePath(relativePath, label);
  const candidatePath = join(root, safeRelativePath);
  const resolvedPath = realpathSync(candidatePath);
  assertPathWithinRoot(root, resolvedPath, label);
  if (!statSync(resolvedPath).isFile()) {
    throw new Error(`Docs Vault ${label} '${safeRelativePath}' is not a file`);
  }
  return resolvedPath;
}

function readTextFileWithinRoot(root: string, relativePath: string, label: string): string {
  return readFileSync(resolveFileWithinRoot(root, relativePath, label), 'utf8');
}

function parseJsonLines<T>(content: string, label: string): T[] {
  const entries: T[] = [];
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as T);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Docs Vault ${label} has invalid JSONL: ${reason}`);
    }
  }

  return entries;
}

function readJsonLinesWithinRoot<T>(root: string, filename: string, label: string): T[] {
  return parseJsonLines<T>(readTextFileWithinRoot(root, filename, label), label);
}

function parseManifestFile(manifestPath: string): DocsVaultManifest {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<DocsVaultManifest>;
  if (parsed.manifestVersion !== DOCS_VAULT_MANIFEST_VERSION || !Array.isArray(parsed.sources)) {
    throw new Error(
      `Docs Vault manifest '${manifestPath}' is not a valid ${DOCS_VAULT_MANIFEST_VERSION}`
    );
  }

  return {
    manifestVersion: parsed.manifestVersion,
    sources: parsed.sources as readonly DocsVaultSourceManifest[],
  };
}

async function loadManifest(options: DocsVaultListDocSourcesOptions): Promise<DocsVaultManifest> {
  if (options.manifest) {
    return options.manifest;
  }

  const cwd = ensureRootDirectory(options.cwd ?? process.cwd(), 'cwd root');

  if (options.manifestPath) {
    return parseManifestFile(resolveFileWithinRoot(cwd, options.manifestPath, 'manifest file'));
  }

  const sourceConfigs = options.sourceConfigs
    ? [...options.sourceConfigs]
    : loadDocsVaultSourceConfigs({
        configPath: resolveFileWithinRoot(
          cwd,
          options.configPath ?? 'scripts/sources.json',
          'source config file'
        ),
      });

  return buildDocsVaultManifest({
    sources: sourceConfigs,
  });
}

function loadIndexes(indexRoot: string): DocsVaultIndexes {
  const resolvedIndexRoot = ensureRootDirectory(indexRoot, 'index root');

  return {
    pages: readJsonLinesWithinRoot<DocsVaultPageIndexEntry>(
      resolvedIndexRoot,
      'pages.jsonl',
      'pages index'
    ).sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.relativePath.localeCompare(right.relativePath)
    ),
    aliases: readJsonLinesWithinRoot<DocsVaultAliasIndexEntry>(
      resolvedIndexRoot,
      'aliases.jsonl',
      'aliases index'
    ),
    links: readJsonLinesWithinRoot<DocsVaultLinkIndexEntry>(
      resolvedIndexRoot,
      'links.jsonl',
      'links index'
    ),
  };
}

function buildAliasMap(
  aliases: readonly DocsVaultAliasIndexEntry[]
): ReadonlyMap<string, readonly DocsVaultAliasIndexEntry[]> {
  const entries = new Map<string, DocsVaultAliasIndexEntry[]>();

  for (const alias of aliases) {
    const current = entries.get(alias.pageId);
    if (current) {
      current.push(alias);
      continue;
    }
    entries.set(alias.pageId, [alias]);
  }

  for (const pageAliases of entries.values()) {
    pageAliases.sort((left, right) => left.normalizedAlias.localeCompare(right.normalizedAlias));
  }

  return entries;
}

function stripMarkdownExtension(relativePath: string): string {
  return relativePath.replace(/\.(md|mdx|txt)$/iu, '');
}

function parseLookup(value: string): DocsVaultParsedLookup {
  let normalizedValue = value.trim();
  if (normalizedValue.startsWith('[[') && normalizedValue.endsWith(']]')) {
    normalizedValue = normalizedValue.slice(2, -2).trim();
  }

  const pipeIndex = normalizedValue.indexOf('|');
  if (pipeIndex >= 0) {
    normalizedValue = normalizedValue.slice(0, pipeIndex).trim();
  }

  const hashIndex = normalizedValue.indexOf('#');
  if (hashIndex >= 0) {
    const anchor = normalizedValue.slice(hashIndex + 1).trim();
    normalizedValue = normalizedValue.slice(0, hashIndex).trim();
    return {
      anchor: anchor.length > 0 ? anchor : undefined,
      value: normalizedValue,
    };
  }

  return { value: normalizedValue };
}

function normalizeLookupPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/u, '');
  if (isUnsafeRelativePath(normalized)) {
    throw new Error(`Docs Vault link '${value}' is not safe to resolve`);
  }
  return stripMarkdownExtension(pathPosix.normalize(normalized));
}

function createResolvedLinkMatch(
  page: DocsVaultPageIndexEntry,
  matchKind: DocsVaultResolvedLinkMatch['matchKind'],
  matchedText: string | undefined,
  anchor?: string
): DocsVaultResolvedLinkMatch {
  return {
    canonicalPath: page.canonicalPath,
    canonicalUrl: page.canonicalUrl,
    heading: resolveHeading(page, anchor),
    matchedText,
    matchKind,
    pageId: page.pageId,
    path: page.relativePath,
    rawPath: page.rawPath,
    sourceId: page.sourceId,
    title: page.title,
    wikiPath: page.wikiPath,
    wikiReference: page.wikiReference,
  };
}

function extractSnippet(content: string, query: string): string | undefined {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerContent.indexOf(lowerQuery);
  if (matchIndex < 0) {
    return undefined;
  }

  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(content.length, matchIndex + query.length + 72);
  return content.slice(start, end).replace(/\s+/gu, ' ').trim();
}

function extractTermSnippet(
  content: string,
  normalizedQueryTerms: readonly string[]
): string | undefined {
  if (normalizedQueryTerms.length < 2) {
    return undefined;
  }

  const segments = content
    .split(/\n\s*\n/gu)
    .map((segment) => segment.replace(/\s+/gu, ' ').trim())
    .filter((segment) => segment.length > 0);

  for (const segment of segments) {
    const normalizedSegment = normalizeText(segment);
    if (normalizedQueryTerms.every((term) => normalizedSegment.includes(term))) {
      return segment;
    }
  }

  return undefined;
}

function hasExactContentMatch(content: string, query: string): boolean {
  return normalizeText(content).includes(normalizeText(query));
}

function matchExactField(
  page: DocsVaultPageIndexEntry,
  aliasEntries: readonly DocsVaultAliasIndexEntry[],
  normalizedQuery: string
): Pick<DocsVaultCandidate, 'matchedText' | 'matchKind' | 'score' | 'snippet'> | undefined {
  for (const alias of aliasEntries) {
    if (alias.normalizedAlias === normalizedQuery) {
      return {
        matchedText: alias.alias,
        matchKind: 'exact-alias',
        score: 120,
      };
    }
  }

  const pathCandidates = [
    page.wikiReference,
    stripMarkdownExtension(page.relativePath),
    page.relativePath,
    page.pageId,
  ];
  if (pathCandidates.some((entry) => normalizeText(entry) === normalizedQuery)) {
    return {
      matchedText: page.wikiReference,
      matchKind: 'exact-path',
      score: 110,
    };
  }

  if ([page.title, page.listedTitle].some((entry) => normalizeText(entry) === normalizedQuery)) {
    return {
      matchedText: page.title,
      matchKind: 'exact-title',
      score: 100,
    };
  }

  if (page.description && normalizeText(page.description) === normalizedQuery) {
    return {
      matchedText: page.description,
      matchKind: 'exact-description',
      score: 90,
    };
  }

  return undefined;
}

function matchIncludesField(
  page: DocsVaultPageIndexEntry,
  aliasEntries: readonly DocsVaultAliasIndexEntry[],
  normalizedQuery: string,
  normalizedQueryTerms: readonly string[]
): Pick<DocsVaultCandidate, 'matchedText' | 'matchKind' | 'score' | 'snippet'> | undefined {
  for (const alias of aliasEntries) {
    if (alias.normalizedAlias.includes(normalizedQuery)) {
      return {
        matchedText: alias.alias,
        matchKind: 'includes-alias',
        score: 80,
      };
    }
  }

  const pathCandidates = [
    page.wikiReference,
    stripMarkdownExtension(page.relativePath),
    page.relativePath,
  ];
  const matchedPath = pathCandidates.find((entry) =>
    normalizeText(entry).includes(normalizedQuery)
  );
  if (matchedPath) {
    return {
      matchedText: matchedPath,
      matchKind: 'includes-path',
      score: 70,
    };
  }

  const matchedTitle = [page.title, page.listedTitle].find((entry) =>
    normalizeText(entry).includes(normalizedQuery)
  );
  if (matchedTitle) {
    return {
      matchedText: matchedTitle,
      matchKind: 'includes-title',
      score: 65,
    };
  }

  if (page.description && normalizeText(page.description).includes(normalizedQuery)) {
    return {
      matchedText: page.description,
      matchKind: 'includes-description',
      score: 55,
    };
  }

  for (const alias of aliasEntries) {
    if (includesAllTerms(alias.alias, normalizedQueryTerms)) {
      return {
        matchedText: alias.alias,
        matchKind: 'includes-alias',
        score: 76,
      };
    }
  }

  const allTermsPathMatch = pathCandidates.find((entry) =>
    includesAllTerms(entry, normalizedQueryTerms)
  );
  if (allTermsPathMatch) {
    return {
      matchedText: allTermsPathMatch,
      matchKind: 'includes-path',
      score: 68,
    };
  }

  const allTermsTitleMatch = [page.title, page.listedTitle].find((entry) =>
    includesAllTerms(entry, normalizedQueryTerms)
  );
  if (allTermsTitleMatch) {
    return {
      matchedText: allTermsTitleMatch,
      matchKind: 'includes-title',
      score: 63,
    };
  }

  if (includesAllTerms(page.description, normalizedQueryTerms)) {
    return {
      matchedText: page.description,
      matchKind: 'includes-description',
      score: 54,
    };
  }

  return undefined;
}

function buildCandidate(
  page: DocsVaultPageIndexEntry,
  match: Omit<
    DocsVaultCandidate,
    | 'canonicalPath'
    | 'canonicalUrl'
    | 'pageId'
    | 'path'
    | 'rawPath'
    | 'sourceId'
    | 'title'
    | 'wikiPath'
    | 'wikiReference'
  >
): DocsVaultCandidate {
  return {
    canonicalPath: page.canonicalPath,
    canonicalUrl: page.canonicalUrl,
    matchedText: match.matchedText,
    matchKind: match.matchKind,
    pageId: page.pageId,
    path: page.relativePath,
    rawPath: page.rawPath,
    score: match.score,
    snippet: match.snippet,
    sourceId: page.sourceId,
    title: page.title,
    wikiPath: page.wikiPath,
    wikiReference: page.wikiReference,
  };
}

function maybeRecordCandidate(
  candidates: Map<string, DocsVaultCandidate>,
  candidate: DocsVaultCandidate
) {
  const current = candidates.get(candidate.pageId);
  if (!current || current.score < candidate.score) {
    candidates.set(candidate.pageId, candidate);
  }
}

function sortCandidates(candidates: readonly DocsVaultCandidate[]): DocsVaultCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return (
      left.sourceId.localeCompare(right.sourceId) ||
      left.path.localeCompare(right.path) ||
      left.matchKind.localeCompare(right.matchKind)
    );
  });
}

function normalizePagePath(sourceId: string, value: string): string {
  const parsed = parseLookup(value);
  let normalized = parsed.value.replace(/\\/g, '/').replace(/^\.\/+/u, '');

  const formatPrefixes = [`canonical/${sourceId}/`, `wiki/${sourceId}/`, `raw/${sourceId}/`];
  for (const prefix of formatPrefixes) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }

  if (normalized.startsWith(`${sourceId}/`)) {
    normalized = normalized.slice(sourceId.length + 1);
  }

  const safeRelativePath = normalizeSafeRelativePath(normalized, 'page path');
  if (!/\.[a-z0-9]+$/iu.test(safeRelativePath)) {
    return `${safeRelativePath}.md`;
  }
  return safeRelativePath;
}

function resolveHeading(
  page: DocsVaultPageIndexEntry,
  anchor?: string
): DocsVaultResolvedHeading | undefined {
  if (!anchor) {
    return undefined;
  }

  const normalizedAnchor = normalizeText(anchor.replace(/-/g, ' '));
  return page.headings.find(
    (heading) =>
      normalizeText(heading.slug.replace(/-/g, ' ')) === normalizedAnchor ||
      normalizeText(heading.text) === normalizedAnchor
  );
}

export async function listDocSources(
  options: DocsVaultListDocSourcesOptions = {}
): Promise<DocsVaultListDocSourcesResult> {
  const manifest = await loadManifest(options);
  const indexCounts =
    options.indexRoot !== undefined
      ? loadIndexes(options.indexRoot)
      : {
          aliases: [],
          links: [],
          pages: [],
        };

  const pageCounts = new Map<string, number>();
  const aliasCounts = new Map<string, number>();
  const linkCounts = new Map<string, number>();

  for (const page of indexCounts.pages) {
    pageCounts.set(page.sourceId, (pageCounts.get(page.sourceId) ?? 0) + 1);
  }
  for (const alias of indexCounts.aliases) {
    aliasCounts.set(alias.sourceId, (aliasCounts.get(alias.sourceId) ?? 0) + 1);
  }
  for (const link of indexCounts.links) {
    linkCounts.set(link.sourceId, (linkCounts.get(link.sourceId) ?? 0) + 1);
  }

  return {
    manifestVersion: manifest.manifestVersion,
    sources: [...manifest.sources]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((source) => ({
        ...source,
        aliasCount: aliasCounts.get(source.sourceId) ?? 0,
        linkCount: linkCounts.get(source.sourceId) ?? 0,
        pageCount: pageCounts.get(source.sourceId) ?? 0,
      })),
  };
}

export function searchDocFiles(
  options: DocsVaultSearchDocFilesOptions
): DocsVaultSearchDocFilesResult {
  const normalizedQuery = normalizeText(options.query);
  if (!normalizedQuery) {
    throw new Error('Docs Vault search query must not be empty');
  }
  const normalizedQueryTerms = splitQueryTerms(normalizedQuery);

  const limit = normalizeLimit(options.limit);
  const pagesAndAliases = loadIndexes(options.indexRoot);
  const vaultRoot = ensureRootDirectory(options.vaultRoot, 'vault root');
  const aliasMap = buildAliasMap(pagesAndAliases.aliases);
  const sourceFilter = options.sourceIds?.map(normalizeSourceId);
  const allowedSourceIds = sourceFilter ? new Set(sourceFilter) : undefined;
  const candidates = new Map<string, DocsVaultCandidate>();
  const pages = [...pagesAndAliases.pages].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.relativePath.localeCompare(right.relativePath)
  );

  for (const page of pages) {
    if (allowedSourceIds && !allowedSourceIds.has(page.sourceId)) {
      continue;
    }

    const pageAliases = aliasMap.get(page.pageId) ?? [];
    const exactMatch = matchExactField(page, pageAliases, normalizedQuery);
    if (exactMatch) {
      maybeRecordCandidate(candidates, buildCandidate(page, exactMatch));
      continue;
    }

    if (!options.exact) {
      const includesMatch = matchIncludesField(
        page,
        pageAliases,
        normalizedQuery,
        normalizedQueryTerms
      );
      if (includesMatch) {
        maybeRecordCandidate(candidates, buildCandidate(page, includesMatch));
      }
    }
  }

  if (candidates.size < limit) {
    for (const page of pages) {
      if (allowedSourceIds && !allowedSourceIds.has(page.sourceId)) {
        continue;
      }

      const canonicalContent = readTextFileWithinRoot(
        vaultRoot,
        page.canonicalPath,
        'canonical page'
      );
      if (options.exact) {
        if (!hasExactContentMatch(canonicalContent, options.query)) {
          continue;
        }

        maybeRecordCandidate(
          candidates,
          buildCandidate(page, {
            matchedText: options.query,
            matchKind: 'exact-content',
            score: 50,
            snippet: extractSnippet(canonicalContent, options.query),
          })
        );
        continue;
      }

      const canonicalSnippet = extractSnippet(canonicalContent, options.query);
      if (canonicalSnippet) {
        maybeRecordCandidate(
          candidates,
          buildCandidate(page, {
            matchedText: options.query,
            matchKind: 'includes-content',
            score: 50,
            snippet: canonicalSnippet,
          })
        );
        continue;
      }

      const canonicalTermSnippet = extractTermSnippet(canonicalContent, normalizedQueryTerms);
      if (canonicalTermSnippet) {
        maybeRecordCandidate(
          candidates,
          buildCandidate(page, {
            matchedText: options.query,
            matchKind: 'includes-content',
            score: 35,
            snippet: canonicalTermSnippet,
          })
        );
        continue;
      }

      const wikiContent = readTextFileWithinRoot(vaultRoot, page.wikiPath, 'wiki page');
      const wikiSnippet = extractSnippet(wikiContent, options.query);
      if (wikiSnippet) {
        maybeRecordCandidate(
          candidates,
          buildCandidate(page, {
            matchedText: options.query,
            matchKind: 'includes-content',
            score: 40,
            snippet: wikiSnippet,
          })
        );
        continue;
      }

      const wikiTermSnippet = extractTermSnippet(wikiContent, normalizedQueryTerms);
      if (wikiTermSnippet) {
        maybeRecordCandidate(
          candidates,
          buildCandidate(page, {
            matchedText: options.query,
            matchKind: 'includes-content',
            score: 25,
            snippet: wikiTermSnippet,
          })
        );
      }
    }
  }

  const sortedResults = sortCandidates([...candidates.values()]);

  return {
    exact: options.exact ?? false,
    limit,
    query: options.query,
    results: sortedResults.slice(0, limit),
    totalMatches: sortedResults.length,
  };
}

export function resolveDocLink(
  options: DocsVaultResolveDocLinkOptions
): DocsVaultResolveDocLinkResult {
  const parsedLookup = parseLookup(options.link);
  if (!parsedLookup.value) {
    throw new Error(`Docs Vault link '${options.link}' does not target a page`);
  }

  const safeLookupPath = normalizeLookupPath(parsedLookup.value);
  const normalizedLookupPath = normalizeText(safeLookupPath);
  const normalizedLookupText = normalizeText(parsedLookup.value);
  const indexes = loadIndexes(options.indexRoot);
  const aliasMap = buildAliasMap(indexes.aliases);
  const matches: DocsVaultResolvedLinkMatch[] = [];
  const seenPageIds = new Set<string>();

  for (const page of indexes.pages) {
    const pageRelativePath = normalizeText(stripMarkdownExtension(page.relativePath));
    const wikiReference = normalizeText(page.wikiReference);
    if (seenPageIds.has(page.pageId)) {
      continue;
    }

    if (wikiReference === normalizedLookupPath) {
      seenPageIds.add(page.pageId);
      matches.push(
        createResolvedLinkMatch(page, 'wikiReference', page.wikiReference, parsedLookup.anchor)
      );
      continue;
    }

    if (pageRelativePath === normalizedLookupPath) {
      seenPageIds.add(page.pageId);
      matches.push(
        createResolvedLinkMatch(page, 'relativePath', page.relativePath, parsedLookup.anchor)
      );
      continue;
    }

    const alias = (aliasMap.get(page.pageId) ?? []).find(
      (entry) =>
        entry.normalizedAlias === normalizedLookupText ||
        entry.normalizedAlias === normalizedLookupPath
    );
    if (alias) {
      seenPageIds.add(page.pageId);
      matches.push(createResolvedLinkMatch(page, 'alias', alias.alias, parsedLookup.anchor));
      continue;
    }

    if (normalizeText(page.title) === normalizedLookupText) {
      seenPageIds.add(page.pageId);
      matches.push(createResolvedLinkMatch(page, 'title', page.title, parsedLookup.anchor));
    }
  }

  matches.sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.path.localeCompare(right.path) ||
      left.matchKind.localeCompare(right.matchKind)
  );

  return {
    anchor: parsedLookup.anchor,
    ambiguous: matches.length > 1,
    link: options.link,
    lookup: safeLookupPath,
    matchCount: matches.length,
    matches,
    resolved: matches.length === 1 ? matches[0] : null,
  };
}

export function getDocPage(options: DocsVaultGetDocPageOptions): DocsVaultGetDocPageResult {
  const vaultRoot = ensureRootDirectory(options.vaultRoot, 'vault root');
  const sourceId = normalizeSourceId(options.sourceId);
  const pagePath = normalizePagePath(sourceId, options.path);
  const normalizedFormat = options.format;
  if (
    normalizedFormat !== 'canonical' &&
    normalizedFormat !== 'wiki' &&
    normalizedFormat !== 'raw'
  ) {
    throw new Error(`Docs Vault page format '${options.format}' is not supported`);
  }
  const relativePath = `${normalizedFormat}/${sourceId}/${pagePath}`;

  return {
    content: readTextFileWithinRoot(vaultRoot, relativePath, `${normalizedFormat} page`),
    format: normalizedFormat,
    path: pagePath,
    relativePath,
    sourceId,
  };
}
