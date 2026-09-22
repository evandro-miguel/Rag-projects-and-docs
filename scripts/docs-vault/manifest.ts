import {
  lookupDocsSourceById,
  type NormalizedDocsSourceMetadata,
  normalizeDocsSourceMetadata,
} from '../lib/docs-source-registry.js';
import { calculateHash } from '../lib/hash.js';
import { loadDocsVaultSourceConfigs } from './config.js';
import type {
  DocsVaultAcquisition,
  DocsVaultArchiveSourceConfig,
  DocsVaultCrawlSourceConfig,
  DocsVaultGitSourceConfig,
  DocsVaultLlmsSourceConfig,
  DocsVaultLocalGeneratorSourceConfig,
  DocsVaultManifest,
  DocsVaultSourceConfig,
  DocsVaultSourceManifest,
} from './types.js';

export const DOCS_VAULT_MANIFEST_VERSION = 'docs-vault-manifest/v1' as const;

function normalizeUrlHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeRepoSlug(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const slug = parsed.pathname.replace(/^\//u, '').replace(/\.git$/u, '');
    return slug.length > 0 ? slug : undefined;
  } catch {
    return undefined;
  }
}

function buildGitAcquisition(source: DocsVaultGitSourceConfig): DocsVaultAcquisition {
  const allowedDomain = normalizeUrlHostname(source.url);
  const allowedRepo = normalizeRepoSlug(source.url);

  return {
    type: 'git',
    url: source.url,
    branch: source.branch,
    allowedDomains: allowedDomain ? [allowedDomain] : [],
    allowedRepos: allowedRepo ? [allowedRepo] : [],
    includePaths: [...source.includePaths],
    fileExtensions: [...source.fileExtensions],
    ignorePaths: [...source.ignorePaths],
  };
}

function buildLlmsAcquisition(source: DocsVaultLlmsSourceConfig): DocsVaultAcquisition {
  const allowedDomain = normalizeUrlHostname(source.url);

  return {
    type: 'llms',
    url: source.url,
    allowedDomains: allowedDomain ? [allowedDomain] : [],
    allowedRepos: [],
    includePaths: [...source.includePaths],
  };
}

function buildArchiveAcquisition(source: DocsVaultArchiveSourceConfig): DocsVaultAcquisition {
  const allowedDomain = normalizeUrlHostname(source.url);

  return {
    type: 'archive',
    url: source.url,
    format: source.format,
    allowedDomains: allowedDomain ? [allowedDomain] : [],
    allowedRepos: [],
    includePaths: [...source.includePaths],
  };
}

function buildLocalGeneratorAcquisition(
  source: DocsVaultLocalGeneratorSourceConfig
): DocsVaultAcquisition {
  return {
    type: 'local_generator',
    generator: source.generator,
    allowedDomains: [],
    allowedRepos: [],
    includePaths: [...source.includePaths],
  };
}

function buildCrawlAcquisition(source: DocsVaultCrawlSourceConfig): DocsVaultAcquisition {
  const allowedDomains = Array.from(
    new Set(source.startUrls.map(normalizeUrlHostname).filter((value): value is string => !!value))
  );

  return {
    type: 'crawl',
    startUrls: [...source.startUrls],
    allowedDomains,
    allowedRepos: [],
    includePaths: [...source.includePaths],
  };
}

function buildAcquisition(source: DocsVaultSourceConfig): DocsVaultAcquisition {
  switch (source.type) {
    case 'git':
      return buildGitAcquisition(source);
    case 'llms':
      return buildLlmsAcquisition(source);
    case 'archive':
      return buildArchiveAcquisition(source);
    case 'local_generator':
      return buildLocalGeneratorAcquisition(source);
    case 'crawl':
      return buildCrawlAcquisition(source);
  }
}

function assertRegistryAlignment(source: DocsVaultSourceConfig) {
  const registryEntry = lookupDocsSourceById(source.sourceId);
  if (!registryEntry) {
    throw new Error(
      `Docs Vault source '${source.sourceId}' is not registered in docs-source-registry`
    );
  }
  if (registryEntry.category !== source.category) {
    throw new Error(
      `Docs Vault source '${source.sourceId}' category '${source.category}' does not match registry category '${registryEntry.category}'`
    );
  }
  return registryEntry;
}

function buildProjectionRoot(kind: 'canonical' | 'wiki', sourceId: string): string {
  return `${kind}/${sourceId}`;
}

async function buildSnapshotHash(
  source: DocsVaultSourceConfig,
  metadata: NormalizedDocsSourceMetadata,
  manifest: DocsVaultAcquisition
) {
  const hashInput = JSON.stringify({
    sourceId: source.sourceId,
    title: source.title,
    category: source.category,
    version: source.version,
    refreshMode: source.refreshMode,
    defaultIngestMode: source.defaultIngestMode,
    acquisition: manifest,
    registryMetadata: metadata,
  });

  return `sha256:${await calculateHash(hashInput)}`;
}

export async function buildDocsVaultSourceManifest(
  source: DocsVaultSourceConfig
): Promise<DocsVaultSourceManifest> {
  assertRegistryAlignment(source);
  const metadata = normalizeDocsSourceMetadata({
    sourceId: source.sourceId,
    category: source.category,
  });

  if (!metadata.sourceId || !metadata.category || !metadata.kind || !metadata.authority) {
    throw new Error(`Docs Vault source '${source.sourceId}' could not resolve registry metadata`);
  }

  const acquisition = buildAcquisition(source);

  return {
    sourceId: metadata.sourceId,
    title: source.title,
    category: metadata.category,
    language: metadata.language,
    kind: metadata.kind,
    authority: metadata.authority,
    trustLevel: metadata.authority,
    tags: [...metadata.tags],
    lang: metadata.lang,
    ecosystem: metadata.ecosystem,
    lib: metadata.lib,
    version: source.version,
    refreshMode: source.refreshMode ?? 'incremental',
    defaultIngestMode: source.defaultIngestMode ?? 'canonical_and_wiki',
    acquisition,
    projections: {
      canonical: {
        kind: 'canonical',
        relativeRoot: buildProjectionRoot('canonical', metadata.sourceId),
        writer: 'canonical_verbatim',
      },
      wiki: {
        kind: 'wiki',
        relativeRoot: buildProjectionRoot('wiki', metadata.sourceId),
        writer: 'wiki_generated',
      },
    },
    snapshot: {
      hashAlgorithm: 'sha256',
      configHash: await buildSnapshotHash(source, metadata, acquisition),
      contentHash: source.contentHash,
      sourceRevision: source.sourceRevision,
      retrievedAt: source.retrievedAt,
      versionToken:
        source.type === 'git'
          ? source.branch
          : (source.version ?? source.sourceRevision ?? source.sourceId),
    },
  };
}

export async function buildDocsVaultManifest(options?: {
  cwd?: string;
  configPath?: string;
  sources?: readonly DocsVaultSourceConfig[];
}): Promise<DocsVaultManifest> {
  const configuredSources =
    options?.sources ??
    loadDocsVaultSourceConfigs({ cwd: options?.cwd, configPath: options?.configPath });
  const sourceIds = new Set<string>();

  for (const source of configuredSources) {
    if (sourceIds.has(source.sourceId)) {
      throw new Error(`Docs Vault manifest has duplicate sourceId '${source.sourceId}'`);
    }
    sourceIds.add(source.sourceId);
  }

  const sources = [...configuredSources].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  );

  return {
    manifestVersion: DOCS_VAULT_MANIFEST_VERSION,
    sources: await Promise.all(sources.map((source) => buildDocsVaultSourceManifest(source))),
  };
}
