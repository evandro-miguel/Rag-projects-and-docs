import { isIP } from 'node:net';
import { posix as pathPosix } from 'node:path';
import { calculateHash } from '../../lib/hash.js';
import type { DocsVaultLlmsAcquisition, DocsVaultSourceManifest } from '../types.js';

export type DocsVaultFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
};

export type DocsVaultFetch = (input: string, init?: RequestInit) => Promise<DocsVaultFetchResponse>;

export type DocsVaultLlmsLink = {
  title: string;
  description?: string;
  sourceUrl: string;
  canonicalUrl: string;
  relativePath: string;
};

export type DocsVaultFetchedLlmsPage = DocsVaultLlmsLink & {
  content: string;
  bytes: number;
  contentHash: string;
  retrievedAt: string;
};

export type DocsVaultFetchedLlmsSource = {
  sourceId: string;
  sourceUrl: string;
  retrievedAt: string;
  index: {
    content: string;
    bytes: number;
    contentHash: string;
  };
  pages: readonly DocsVaultFetchedLlmsPage[];
};

const LLMS_MARKDOWN_LINK_PATTERN = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)(?::\s*(.+))?\s*$/u;

function normalizeAllowedDomains(allowedDomains: readonly string[]): string[] {
  return Array.from(
    new Set(
      allowedDomains
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0)
    )
  );
}

function isAllowedHostname(hostname: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some(
    (allowedDomain) => hostname === allowedDomain || hostname.endsWith(`.${allowedDomain}`)
  );
}

function normalizeHostnameForIpCheck(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function assertSafeHostname(hostname: string, context: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    throw new Error(`Docs Vault ${context} is missing hostname`);
  }
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    throw new Error(`Docs Vault ${context} points to localhost/private host '${hostname}'`);
  }
  if (isIP(normalizeHostnameForIpCheck(normalized))) {
    throw new Error(`Docs Vault ${context} points to localhost/private host '${hostname}'`);
  }
}

function assertAllowedUrl(
  urlValue: string,
  allowedDomains: readonly string[],
  context: string
): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error(`Docs Vault ${context} has invalid URL '${urlValue}'`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Docs Vault ${context} has unsupported protocol '${parsed.protocol}'`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Docs Vault ${context} must not include credentials`);
  }

  const hostname = parsed.hostname.toLowerCase();
  assertSafeHostname(hostname, context);

  if (!isAllowedHostname(hostname, allowedDomains)) {
    throw new Error(
      `Docs Vault ${context} host '${hostname}' is outside allowed domains: ${allowedDomains.join(', ')}`
    );
  }

  return parsed;
}

function normalizeRelativePath(pathname: string, includePaths: readonly string[]): string {
  const decodedPath = decodeURIComponent(pathname);
  const withoutLeadingSlash = decodedPath.replace(/^\/+/u, '');
  const normalizedPath = pathPosix.normalize(withoutLeadingSlash);

  if (
    normalizedPath.length === 0 ||
    normalizedPath === '.' ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../') ||
    normalizedPath.includes('/../')
  ) {
    throw new Error(`Docs Vault llms page path '${pathname}' is not safe to stage`);
  }

  for (const includePath of includePaths) {
    const normalizedIncludePath =
      includePath === '.' ? '' : pathPosix.normalize(includePath).replace(/^\/+/u, '');

    if (!normalizedIncludePath) {
      return normalizedPath;
    }
    if (normalizedPath === normalizedIncludePath) {
      return pathPosix.basename(normalizedPath);
    }
    if (normalizedPath.startsWith(`${normalizedIncludePath}/`)) {
      return normalizedPath.slice(normalizedIncludePath.length + 1);
    }
  }

  throw new Error(
    `Docs Vault llms page path '${pathname}' is outside include paths: ${includePaths.join(', ')}`
  );
}

function canonicalizeMarkdownUrl(parsed: URL): string {
  return new URL(parsed.pathname, parsed.origin).toString();
}

function ensureLlmsAcquisition(source: DocsVaultSourceManifest): DocsVaultLlmsAcquisition {
  if (source.acquisition.type !== 'llms') {
    throw new Error(
      `Docs Vault source '${source.sourceId}' is not llms-backed: ${source.acquisition.type}`
    );
  }
  return source.acquisition;
}

async function fetchText(
  fetchImpl: DocsVaultFetch,
  url: string,
  allowedDomains: readonly string[],
  context: string
): Promise<string> {
  const parsed = assertAllowedUrl(url, allowedDomains, context);
  const response = await fetchImpl(parsed.toString(), {
    headers: {
      accept: 'text/plain, text/markdown;q=0.9, text/*;q=0.8, */*;q=0.1',
    },
  });

  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    throw new Error(`Docs Vault fetch failed for ${url}: ${response.status}${statusText}`);
  }

  return response.text();
}

export function parseLlmsMarkdownPageLinks(options: {
  llmsText: string;
  baseUrl: string;
  allowedDomains: readonly string[];
  includePaths: readonly string[];
}): DocsVaultLlmsLink[] {
  const allowedDomains = normalizeAllowedDomains(options.allowedDomains);
  const parsedBaseUrl = assertAllowedUrl(options.baseUrl, allowedDomains, 'llms source URL');
  const linksByCanonicalUrl = new Map<string, DocsVaultLlmsLink>();

  for (const line of options.llmsText.split(/\r?\n/u)) {
    const match = line.match(LLMS_MARKDOWN_LINK_PATTERN);
    if (!match) {
      continue;
    }

    const [, rawTitle, rawUrl, rawDescription] = match;
    const resolvedUrl = new URL(rawUrl.trim(), parsedBaseUrl);
    if (!resolvedUrl.pathname.toLowerCase().endsWith('.md')) {
      continue;
    }

    const safeUrl = assertAllowedUrl(
      resolvedUrl.toString(),
      allowedDomains,
      `llms page link '${rawTitle.trim()}'`
    );
    const canonicalUrl = canonicalizeMarkdownUrl(safeUrl);
    const relativePath = normalizeRelativePath(safeUrl.pathname, options.includePaths);

    if (!linksByCanonicalUrl.has(canonicalUrl)) {
      linksByCanonicalUrl.set(canonicalUrl, {
        title: rawTitle.trim(),
        description: rawDescription?.trim() || undefined,
        sourceUrl: resolvedUrl.toString(),
        canonicalUrl,
        relativePath,
      });
    }
  }

  const links = Array.from(linksByCanonicalUrl.values()).sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );

  if (links.length === 0) {
    throw new Error(`Docs Vault llms source '${options.baseUrl}' did not contain any .md links`);
  }

  return links;
}

export async function fetchLlmsSource(options: {
  source: DocsVaultSourceManifest;
  fetch?: DocsVaultFetch;
  now?: () => Date;
}): Promise<DocsVaultFetchedLlmsSource> {
  const source = options.source;
  const acquisition = ensureLlmsAcquisition(source);
  const allowedDomains = normalizeAllowedDomains(acquisition.allowedDomains);
  const fetchImpl = options.fetch ?? (globalThis.fetch.bind(globalThis) as DocsVaultFetch);
  const retrievedAt = (options.now ?? (() => new Date()))().toISOString();
  const indexContent = await fetchText(
    fetchImpl,
    acquisition.url,
    allowedDomains,
    'llms source URL'
  );
  const links = parseLlmsMarkdownPageLinks({
    llmsText: indexContent,
    baseUrl: acquisition.url,
    allowedDomains,
    includePaths: acquisition.includePaths,
  });

  const pages: DocsVaultFetchedLlmsPage[] = [];

  for (const link of links) {
    const content = await fetchText(
      fetchImpl,
      link.canonicalUrl,
      allowedDomains,
      `llms page '${link.title}'`
    );
    const bytes = Buffer.byteLength(content, 'utf8');
    pages.push({
      ...link,
      content,
      bytes,
      contentHash: `sha256:${await calculateHash(content)}`,
      retrievedAt,
    });
  }

  return {
    sourceId: source.sourceId,
    sourceUrl: acquisition.url,
    retrievedAt,
    index: {
      content: indexContent,
      bytes: Buffer.byteLength(indexContent, 'utf8'),
      contentHash: `sha256:${await calculateHash(indexContent)}`,
    },
    pages,
  };
}
