import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { calculateHash } from '../lib/hash.js';
import { type DocsVaultFetch, fetchLlmsSource } from './fetchers/llms.js';
import type { DocsVaultSourceManifest } from './types.js';

export type DocsVaultStagedPage = {
  title: string;
  description?: string;
  sourceUrl: string;
  canonicalUrl: string;
  relativePath: string;
  rawRelativePath: string;
  canonicalRelativePath: string;
  bytes: number;
  contentHash: string;
  retrievedAt: string;
};

export type DocsVaultStagedSourceManifest = {
  manifestVersion: 'docs-vault-staged-source/v1';
  sourceId: string;
  sourceConfigHash: string;
  fetchedAt: string;
  sourceUrl: string;
  rawRoot: string;
  canonicalRoot: string;
  manifestHash: string;
  index: {
    rawRelativePath: string;
    bytes: number;
    contentHash: string;
    retrievedAt: string;
  };
  pageCount: number;
  pages: readonly DocsVaultStagedPage[];
};

export type DocsVaultStagedSource = {
  manifestPath: string;
  manifestRelativePath: string;
  manifest: DocsVaultStagedSourceManifest;
};

function writeTextFile(root: string, relativePath: string, content: string) {
  const outputPath = join(root, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');
}

function clearStagePath(root: string, relativePath: string) {
  rmSync(join(root, relativePath), { recursive: true, force: true });
}

function buildRawRelativePath(sourceId: string, relativePath: string): string {
  return `raw/${sourceId}/${relativePath}`;
}

async function buildManifestHash(
  manifest: Omit<DocsVaultStagedSourceManifest, 'manifestHash'>
): Promise<string> {
  return `sha256:${await calculateHash(JSON.stringify(manifest))}`;
}

export async function stageDocsVaultSource(options: {
  source: DocsVaultSourceManifest;
  stagingRoot: string;
  fetch?: DocsVaultFetch;
  now?: () => Date;
}): Promise<DocsVaultStagedSource> {
  const source = options.source;

  if (source.acquisition.type !== 'llms') {
    throw new Error(
      `Docs Vault staging does not support acquisition type '${source.acquisition.type}' yet`
    );
  }

  const fetchedSource = await fetchLlmsSource({
    source,
    fetch: options.fetch,
    now: options.now,
  });

  const rawRoot = `raw/${source.sourceId}`;
  const canonicalRoot = source.projections.canonical.relativeRoot;
  const manifestRelativePath = `manifests/${source.sourceId}.json`;

  clearStagePath(options.stagingRoot, rawRoot);
  clearStagePath(options.stagingRoot, canonicalRoot);
  clearStagePath(options.stagingRoot, manifestRelativePath);

  writeTextFile(options.stagingRoot, `${rawRoot}/llms.txt`, fetchedSource.index.content);

  const pages: DocsVaultStagedPage[] = [];
  for (const page of fetchedSource.pages) {
    const rawRelativePath = buildRawRelativePath(source.sourceId, page.relativePath);
    const canonicalRelativePath = `${canonicalRoot}/${page.relativePath}`;

    writeTextFile(options.stagingRoot, rawRelativePath, page.content);
    writeTextFile(options.stagingRoot, canonicalRelativePath, page.content);

    pages.push({
      title: page.title,
      description: page.description,
      sourceUrl: page.sourceUrl,
      canonicalUrl: page.canonicalUrl,
      relativePath: page.relativePath,
      rawRelativePath,
      canonicalRelativePath,
      bytes: page.bytes,
      contentHash: page.contentHash,
      retrievedAt: page.retrievedAt,
    });
  }

  const manifestBase: Omit<DocsVaultStagedSourceManifest, 'manifestHash'> = {
    manifestVersion: 'docs-vault-staged-source/v1',
    sourceId: source.sourceId,
    sourceConfigHash: source.snapshot.configHash,
    fetchedAt: fetchedSource.retrievedAt,
    sourceUrl: fetchedSource.sourceUrl,
    rawRoot,
    canonicalRoot,
    index: {
      rawRelativePath: `${rawRoot}/llms.txt`,
      bytes: fetchedSource.index.bytes,
      contentHash: fetchedSource.index.contentHash,
      retrievedAt: fetchedSource.retrievedAt,
    },
    pageCount: pages.length,
    pages,
  };
  const manifest: DocsVaultStagedSourceManifest = {
    ...manifestBase,
    manifestHash: await buildManifestHash(manifestBase),
  };

  writeTextFile(
    options.stagingRoot,
    manifestRelativePath,
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  return {
    manifestPath: join(options.stagingRoot, manifestRelativePath),
    manifestRelativePath,
    manifest,
  };
}
