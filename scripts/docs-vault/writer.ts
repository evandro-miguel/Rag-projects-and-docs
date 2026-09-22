import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix as pathPosix } from 'node:path';
import { extractTitle } from '../lib/file-helpers.js';
import { calculateHash } from '../lib/hash.js';
import type { DocsVaultStagedSource } from './sync.js';
import type { DocsVaultSourceManifest } from './types.js';

export type DocsVaultPageHeading = {
  depth: number;
  text: string;
  slug: string;
};

export type DocsVaultPageIndexEntry = {
  pageId: string;
  sourceId: string;
  title: string;
  listedTitle: string;
  description?: string;
  canonicalUrl: string;
  canonicalPath: string;
  wikiPath: string;
  rawPath: string;
  wikiReference: string;
  relativePath: string;
  contentHash: string;
  wikiHash: string;
  bytes: number;
  retrievedAt: string;
  headings: readonly DocsVaultPageHeading[];
};

export type DocsVaultAliasIndexEntry = {
  alias: string;
  normalizedAlias: string;
  aliasKind: 'title' | 'path' | 'basename';
  sourceId: string;
  pageId: string;
  canonicalUrl: string;
  canonicalPath: string;
  wikiPath: string;
};

export type DocsVaultLinkIndexEntry = {
  sourceId: string;
  fromPageId: string;
  fromCanonicalUrl: string;
  fromCanonicalPath: string;
  fromWikiPath: string;
  toPageId: string;
  toCanonicalUrl: string;
  toCanonicalPath: string;
  toWikiPath: string;
  linkText: string;
};

export type DocsVaultWrittenSource = {
  wikiRoot: string;
  pagesIndexPath: string;
  aliasesIndexPath: string;
  linksIndexPath: string;
  pageCount: number;
  aliasCount: number;
  linkCount: number;
};

type ParsedMarkdownLink = {
  text: string;
  target: string;
};

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const MARKDOWN_LINK_PATTERN = /!?\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;

function normalizeSafeRelativePath(relativePath: string, label: string): string {
  if (isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/u.test(relativePath)) {
    throw new Error(`Docs Vault ${label} '${relativePath}' is not safe to write`);
  }

  const normalizedInput = relativePath.replace(/\\/g, '/');
  const normalizedPath = pathPosix.normalize(normalizedInput);

  if (
    normalizedPath.length === 0 ||
    normalizedPath === '.' ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../') ||
    normalizedPath.includes('/../')
  ) {
    throw new Error(`Docs Vault ${label} '${relativePath}' is not safe to write`);
  }

  return normalizedPath;
}

function writeTextFile(root: string, relativePath: string, content: string) {
  const safeRelativePath = normalizeSafeRelativePath(relativePath, 'output path');
  const outputPath = join(root, safeRelativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');
}

function readTextFile(root: string, relativePath: string): string {
  const safeRelativePath = normalizeSafeRelativePath(relativePath, 'input path');
  return readFileSync(join(root, safeRelativePath), 'utf8');
}

function stripMarkdownExtension(relativePath: string): string {
  return relativePath.replace(/\.(md|mdx)$/iu, '');
}

function buildPageId(sourceId: string, relativePath: string): string {
  return `${sourceId}:${stripMarkdownExtension(relativePath)}`;
}

function buildWikiReference(wikiRelativePath: string): string {
  return stripMarkdownExtension(wikiRelativePath.replace(/^wiki\//u, ''));
}

function normalizeAlias(alias: string): string {
  return alias.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function compareDeterministically(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeWikiLinkLabel(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .replace(/\]/gu, '\\]')
    .replace(/\[/gu, '\\[');
}

function slugifyHeading(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[`*_#[\]()<>{}]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function extractHeadings(content: string): DocsVaultPageHeading[] {
  const headings: DocsVaultPageHeading[] = [];
  let inFence = false;

  for (const line of content.split(/\r?\n/u)) {
    if (/^```/u.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const match = line.match(HEADING_PATTERN);
    if (!match) {
      continue;
    }

    const text = match[2].trim();
    headings.push({
      depth: match[1].length,
      text,
      slug: slugifyHeading(text),
    });
  }

  return headings;
}

function extractMarkdownLinks(content: string): ParsedMarkdownLink[] {
  const links: ParsedMarkdownLink[] = [];
  let inFence = false;

  for (const line of content.split(/\r?\n/u)) {
    if (/^```/u.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    MARKDOWN_LINK_PATTERN.lastIndex = 0;

    for (const match of line.matchAll(MARKDOWN_LINK_PATTERN)) {
      if (match[0].startsWith('![')) {
        continue;
      }
      links.push({
        text: match[1].trim(),
        target: match[2].trim(),
      });
    }
  }

  return links;
}

function canonicalizePageUrl(urlValue: string): string {
  const parsed = new URL(urlValue);
  parsed.hash = '';
  parsed.search = '';
  return new URL(parsed.pathname, parsed.origin).toString();
}

function resolveLocalTargetUrl(baseUrl: string, target: string): string | undefined {
  if (target.startsWith('#')) {
    return undefined;
  }

  let resolved: URL;
  try {
    resolved = new URL(target, baseUrl);
  } catch {
    return undefined;
  }

  resolved.hash = '';
  resolved.search = '';
  return new URL(resolved.pathname, resolved.origin).toString();
}

function buildAliasEntries(page: {
  pageId: string;
  sourceId: string;
  title: string;
  canonicalUrl: string;
  canonicalPath: string;
  wikiPath: string;
  relativePath: string;
}): DocsVaultAliasIndexEntry[] {
  const pathStem = stripMarkdownExtension(page.relativePath);
  const basenameStem = pathPosix.basename(pathStem);
  const aliasSpecs = [
    { alias: `${page.sourceId}:${page.title}`, aliasKind: 'title' as const },
    { alias: `${page.sourceId}:${pathStem}`, aliasKind: 'path' as const },
    ...(basenameStem !== 'index'
      ? [{ alias: `${page.sourceId}:${basenameStem}`, aliasKind: 'basename' as const }]
      : []),
  ];
  const aliases = new Map<string, DocsVaultAliasIndexEntry>();

  for (const spec of aliasSpecs) {
    const normalizedAlias = normalizeAlias(spec.alias);
    if (!normalizedAlias || aliases.has(normalizedAlias)) {
      continue;
    }

    aliases.set(normalizedAlias, {
      alias: spec.alias,
      normalizedAlias,
      aliasKind: spec.aliasKind,
      sourceId: page.sourceId,
      pageId: page.pageId,
      canonicalUrl: page.canonicalUrl,
      canonicalPath: page.canonicalPath,
      wikiPath: page.wikiPath,
    });
  }

  return Array.from(aliases.values()).sort((left, right) =>
    compareDeterministically(left.normalizedAlias, right.normalizedAlias)
  );
}

function buildWikiFrontmatter(page: DocsVaultPageIndexEntry, aliases: readonly string[]): string {
  const lines = [
    '---',
    `title: "${escapeYamlString(page.title)}"`,
    `source_id: "${escapeYamlString(page.sourceId)}"`,
    `page_id: "${escapeYamlString(page.pageId)}"`,
    `canonical_url: "${escapeYamlString(page.canonicalUrl)}"`,
    `canonical_path: "${escapeYamlString(page.canonicalPath)}"`,
    `wiki_path: "${escapeYamlString(page.wikiPath)}"`,
    `raw_path: "${escapeYamlString(page.rawPath)}"`,
    `content_hash: "${escapeYamlString(page.contentHash)}"`,
    `heading_count: ${page.headings.length}`,
    'aliases:',
    ...aliases.map((alias) => `  - "${escapeYamlString(alias)}"`),
    '---',
  ];

  return lines.join('\n');
}

function buildRelatedSection(
  page: DocsVaultPageIndexEntry,
  relatedLinks: readonly DocsVaultLinkIndexEntry[],
  titlesByPageId: ReadonlyMap<string, string>
): string {
  const relatedLines =
    relatedLinks.length > 0
      ? relatedLinks.map((link) => {
          const targetTitle = titlesByPageId.get(link.toPageId) ?? link.toPageId;
          const wikiReference = buildWikiReference(link.toWikiPath);
          return `- [[${wikiReference}|${escapeWikiLinkLabel(targetTitle)}]]`;
        })
      : ['- None'];

  return [
    '## Related Pages',
    ...relatedLines,
    '',
    '## Canonical Source',
    `- [Official Page](${page.canonicalUrl})`,
    `- Local canonical: \`${page.canonicalPath}\``,
    `- Local raw: \`${page.rawPath}\``,
  ].join('\n');
}

function writeJsonLinesFile(root: string, filename: string, entries: readonly unknown[]) {
  const lines = entries.map((entry) => JSON.stringify(entry));
  writeTextFile(root, filename, lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

export async function writeDocsVaultPages(options: {
  source: DocsVaultSourceManifest;
  stagedSource: DocsVaultStagedSource;
  stagingRoot: string;
  indexRoot: string;
}): Promise<DocsVaultWrittenSource> {
  const { source, stagedSource, stagingRoot, indexRoot } = options;

  if (source.sourceId !== stagedSource.manifest.sourceId) {
    throw new Error(
      `Docs Vault staged source '${stagedSource.manifest.sourceId}' does not match source '${source.sourceId}'`
    );
  }

  const wikiRoot = source.projections.wiki.relativeRoot;
  const pages: DocsVaultPageIndexEntry[] = [];
  const canonicalContentByPageId = new Map<string, string>();

  for (const stagedPage of stagedSource.manifest.pages) {
    const relativePath = normalizeSafeRelativePath(stagedPage.relativePath, 'page relative path');
    const canonicalPath = normalizeSafeRelativePath(
      stagedPage.canonicalRelativePath,
      'canonical page path'
    );
    const rawPath = normalizeSafeRelativePath(stagedPage.rawRelativePath, 'raw page path');
    const wikiPath = normalizeSafeRelativePath(`${wikiRoot}/${relativePath}`, 'wiki page path');
    const canonicalContent = readTextFile(stagingRoot, canonicalPath);
    const pageId = buildPageId(source.sourceId, relativePath);
    canonicalContentByPageId.set(pageId, canonicalContent);
    const canonicalHash = `sha256:${await calculateHash(canonicalContent)}`;

    if (canonicalHash !== stagedPage.contentHash) {
      throw new Error(
        `Docs Vault canonical page '${canonicalPath}' hash drifted from staged content`
      );
    }

    const headings = extractHeadings(canonicalContent);
    const title =
      headings.find((heading) => heading.depth === 1)?.text ??
      stagedPage.title.trim() ??
      extractTitle(canonicalContent, pathPosix.basename(relativePath));

    pages.push({
      pageId,
      sourceId: source.sourceId,
      title,
      listedTitle: stagedPage.title,
      description: stagedPage.description,
      canonicalUrl: canonicalizePageUrl(stagedPage.canonicalUrl),
      canonicalPath,
      wikiPath,
      rawPath,
      wikiReference: buildWikiReference(wikiPath),
      relativePath,
      contentHash: stagedPage.contentHash,
      wikiHash: '',
      bytes: stagedPage.bytes,
      retrievedAt: stagedPage.retrievedAt,
      headings,
    });
  }

  pages.sort((left, right) => compareDeterministically(left.relativePath, right.relativePath));

  const pagesByCanonicalUrl = new Map(pages.map((page) => [page.canonicalUrl, page]));
  const titlesByPageId = new Map(pages.map((page) => [page.pageId, page.title]));
  const links: DocsVaultLinkIndexEntry[] = [];
  const linksBySourcePageId = new Map<string, DocsVaultLinkIndexEntry[]>();
  const aliasesBySourceAndAlias = new Map<string, DocsVaultAliasIndexEntry>();
  const aliasesByPageId = new Map<string, DocsVaultAliasIndexEntry[]>();

  for (const page of pages) {
    const pageAliases = buildAliasEntries(page);
    const uniquePageAliases: DocsVaultAliasIndexEntry[] = [];

    for (const alias of pageAliases) {
      const aliasKey = `${alias.sourceId}\u0000${alias.normalizedAlias}`;
      if (aliasesBySourceAndAlias.has(aliasKey)) {
        continue;
      }

      aliasesBySourceAndAlias.set(aliasKey, alias);
      uniquePageAliases.push(alias);
    }

    aliasesByPageId.set(page.pageId, uniquePageAliases);

    const canonicalContent = canonicalContentByPageId.get(page.pageId);
    if (canonicalContent === undefined) {
      throw new Error(`Docs Vault canonical content missing for page '${page.pageId}'`);
    }

    const outgoingLinks: DocsVaultLinkIndexEntry[] = [];
    const seenLinkKeys = new Set<string>();

    for (const link of extractMarkdownLinks(canonicalContent)) {
      const targetUrl = resolveLocalTargetUrl(page.canonicalUrl, link.target);
      if (!targetUrl) {
        continue;
      }

      const targetPage = pagesByCanonicalUrl.get(targetUrl);
      if (!targetPage || targetPage.pageId === page.pageId) {
        continue;
      }

      const linkKey = `${page.pageId}->${targetPage.pageId}:${link.text}`;
      if (seenLinkKeys.has(linkKey)) {
        continue;
      }
      seenLinkKeys.add(linkKey);

      const entry: DocsVaultLinkIndexEntry = {
        sourceId: source.sourceId,
        fromPageId: page.pageId,
        fromCanonicalUrl: page.canonicalUrl,
        fromCanonicalPath: page.canonicalPath,
        fromWikiPath: page.wikiPath,
        toPageId: targetPage.pageId,
        toCanonicalUrl: targetPage.canonicalUrl,
        toCanonicalPath: targetPage.canonicalPath,
        toWikiPath: targetPage.wikiPath,
        linkText: link.text,
      };
      outgoingLinks.push(entry);
      links.push(entry);
    }

    outgoingLinks.sort(
      (left, right) =>
        compareDeterministically(left.toPageId, right.toPageId) ||
        compareDeterministically(left.linkText, right.linkText)
    );
    linksBySourcePageId.set(page.pageId, outgoingLinks);
  }

  const aliases = [...aliasesBySourceAndAlias.values()].sort((left, right) => {
    const byAlias = compareDeterministically(left.normalizedAlias, right.normalizedAlias);
    return byAlias !== 0 ? byAlias : compareDeterministically(left.pageId, right.pageId);
  });
  links.sort((left, right) => {
    const bySource = compareDeterministically(left.fromPageId, right.fromPageId);
    if (bySource !== 0) {
      return bySource;
    }
    const byTarget = compareDeterministically(left.toPageId, right.toPageId);
    return byTarget !== 0 ? byTarget : compareDeterministically(left.linkText, right.linkText);
  });

  for (const page of pages) {
    const pageAliases = (aliasesByPageId.get(page.pageId) ?? []).map((entry) => entry.alias);
    const canonicalContent = canonicalContentByPageId.get(page.pageId);
    if (canonicalContent === undefined) {
      throw new Error(`Docs Vault canonical content missing for page '${page.pageId}'`);
    }
    const relatedSection = buildRelatedSection(
      page,
      linksBySourcePageId.get(page.pageId) ?? [],
      titlesByPageId
    );
    const wikiContent = `${buildWikiFrontmatter(page, pageAliases)}\n\n${canonicalContent}${canonicalContent.endsWith('\n') ? '' : '\n'}\n${relatedSection}\n`;

    page.wikiHash = `sha256:${await calculateHash(wikiContent)}`;
    writeTextFile(stagingRoot, page.wikiPath, wikiContent);
  }

  writeJsonLinesFile(indexRoot, 'pages.jsonl', pages);
  writeJsonLinesFile(indexRoot, 'aliases.jsonl', aliases);
  writeJsonLinesFile(indexRoot, 'links.jsonl', links);

  return {
    wikiRoot,
    pagesIndexPath: pathPosix.join(indexRoot, 'pages.jsonl'),
    aliasesIndexPath: pathPosix.join(indexRoot, 'aliases.jsonl'),
    linksIndexPath: pathPosix.join(indexRoot, 'links.jsonl'),
    pageCount: pages.length,
    aliasCount: aliases.length,
    linkCount: links.length,
  };
}
