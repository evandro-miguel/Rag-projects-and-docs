import { describe, expect, it } from 'vitest';
import {
  loadDocsVaultSourceConfigs,
  normalizeDocsVaultSourceConfig,
} from '../../docs-vault/config.js';
import {
  buildDocsVaultManifest,
  buildDocsVaultSourceManifest,
  DOCS_VAULT_MANIFEST_VERSION,
} from '../../docs-vault/manifest.js';

describe('docs-vault manifest contract', () => {
  it('loads current sources.json entries as git-backed Docs Vault sources', () => {
    const sources = loadDocsVaultSourceConfigs();
    const bunDocs = sources.find((source) => source.sourceId === 'bun-docs');
    const goBooks = sources.find((source) => source.sourceId === 'go-books');

    expect(bunDocs).toMatchObject({
      sourceId: 'bun-docs',
      type: 'git',
      category: 'bun',
      version: 'main',
      includePaths: ['docs'],
    });
    expect(goBooks).toMatchObject({
      sourceId: 'go-books',
      type: 'git',
      category: 'go',
      includePaths: ['.'],
    });
  });

  it.each([
    [
      'git missing url',
      {
        id: 'bun-docs',
        type: 'git',
        category: 'bun',
        branch: 'main',
      },
      "Docs Vault git source 'bun-docs' is missing url",
    ],
    [
      'git invalid url',
      {
        id: 'bun-docs',
        type: 'git',
        category: 'bun',
        url: 'not-a-url',
        branch: 'main',
      },
      "Docs Vault git source 'bun-docs' has invalid url: not-a-url",
    ],
    [
      'llms invalid url',
      {
        id: 'bun-docs',
        type: 'llms',
        category: 'bun',
        url: 'not-a-url',
      },
      "Docs Vault llms source 'bun-docs' has invalid url: not-a-url",
    ],
    [
      'archive missing url',
      {
        id: 'python-docs',
        type: 'archive',
        category: 'python',
      },
      "Docs Vault archive source 'python-docs' is missing url",
    ],
    [
      'crawl invalid startUrls',
      {
        id: 'go-docs',
        type: 'crawl',
        category: 'go',
        startUrls: ['not-a-url'],
      },
      "Docs Vault crawl source 'go-docs' has invalid startUrls: not-a-url",
    ],
  ])('rejects %s', async (_label, input, message) => {
    expect(() => normalizeDocsVaultSourceConfig(input)).toThrow(message);
  });

  it('builds a deterministic manifest entry from current git sources and registry metadata', async () => {
    const source = normalizeDocsVaultSourceConfig({
      id: 'bun-docs',
      type: 'git',
      category: 'bun',
      title: 'Bun Documentation',
      url: 'https://github.com/oven-sh/bun.git',
      branch: 'main',
      docsPath: 'docs',
    });

    const manifest = await buildDocsVaultSourceManifest(source);

    expect(manifest).toMatchObject({
      sourceId: 'bun-docs',
      category: 'bun',
      language: 'bun',
      kind: 'official-docs',
      authority: 'official',
      trustLevel: 'official',
      lang: 'ts',
      ecosystem: 'bun',
      lib: 'bun',
      version: 'main',
      refreshMode: 'incremental',
      defaultIngestMode: 'canonical_and_wiki',
      acquisition: {
        type: 'git',
        url: 'https://github.com/oven-sh/bun.git',
        branch: 'main',
        allowedDomains: ['github.com'],
        allowedRepos: ['oven-sh/bun'],
        includePaths: ['docs'],
      },
      projections: {
        canonical: {
          kind: 'canonical',
          relativeRoot: 'canonical/bun-docs',
          writer: 'canonical_verbatim',
        },
        wiki: {
          kind: 'wiki',
          relativeRoot: 'wiki/bun-docs',
          writer: 'wiki_generated',
        },
      },
      snapshot: {
        hashAlgorithm: 'sha256',
        versionToken: 'main',
      },
    });
    expect(manifest.snapshot.configHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('changes configHash when title drifts', async () => {
    const base = normalizeDocsVaultSourceConfig({
      id: 'bun-docs',
      type: 'git',
      category: 'bun',
      title: 'Bun Documentation',
      url: 'https://github.com/oven-sh/bun.git',
      branch: 'main',
      docsPath: 'docs',
    });
    const renamed = normalizeDocsVaultSourceConfig({
      id: 'bun-docs',
      type: 'git',
      category: 'bun',
      title: 'Bun Docs',
      url: 'https://github.com/oven-sh/bun.git',
      branch: 'main',
      docsPath: 'docs',
    });

    const [baseManifest, renamedManifest] = await Promise.all([
      buildDocsVaultSourceManifest(base),
      buildDocsVaultSourceManifest(renamed),
    ]);

    expect(baseManifest.snapshot.configHash).not.toBe(renamedManifest.snapshot.configHash);
  });

  it('supports future acquisition types without inventing new source ids', async () => {
    const configs = [
      normalizeDocsVaultSourceConfig({
        id: 'bun-docs',
        type: 'llms',
        category: 'bun',
        url: 'https://bun.com/docs/llms.txt',
      }),
      normalizeDocsVaultSourceConfig({
        id: 'python-docs',
        type: 'archive',
        category: 'python',
        url: 'https://docs.python.org/3/archives/python-docs-text.tar.bz2',
        format: 'tar.bz2',
      }),
      normalizeDocsVaultSourceConfig({
        id: 'typescript-docs',
        type: 'local_generator',
        category: 'typescript',
        generator: 'pkgsite export',
        includePaths: ['generated/typescript'],
      }),
      normalizeDocsVaultSourceConfig({
        id: 'go-docs',
        type: 'crawl',
        category: 'go',
        startUrls: ['https://pkg.go.dev/std'],
      }),
    ];

    const manifest = await buildDocsVaultManifest({ sources: configs });

    expect(manifest.manifestVersion).toBe(DOCS_VAULT_MANIFEST_VERSION);
    expect(manifest.sources.map((source) => source.sourceId)).toEqual([
      'bun-docs',
      'go-docs',
      'python-docs',
      'typescript-docs',
    ]);
    expect(manifest.sources.map((source) => source.acquisition.type)).toEqual([
      'llms',
      'crawl',
      'archive',
      'local_generator',
    ]);
    expect(manifest.sources[0]?.acquisition).toMatchObject({
      type: 'llms',
      allowedDomains: ['bun.com'],
    });
    expect(manifest.sources[1]?.acquisition).toMatchObject({
      type: 'crawl',
      allowedDomains: ['pkg.go.dev'],
    });
    expect(manifest.sources[2]?.acquisition).toMatchObject({
      type: 'archive',
      allowedDomains: ['docs.python.org'],
    });
    expect(manifest.sources[3]?.acquisition).toMatchObject({
      type: 'local_generator',
      allowedDomains: [],
      allowedRepos: [],
      includePaths: ['generated/typescript'],
    });
  });

  it('rejects duplicate source ids', async () => {
    const source = normalizeDocsVaultSourceConfig({
      id: 'bun-docs',
      type: 'git',
      category: 'bun',
      url: 'https://github.com/oven-sh/bun.git',
      branch: 'main',
      docsPath: 'docs',
    });

    await expect(buildDocsVaultManifest({ sources: [source, source] })).rejects.toThrow(
      "Docs Vault manifest has duplicate sourceId 'bun-docs'"
    );
  });

  it('fails when a source config drifts away from the registered source category', async () => {
    await expect(
      buildDocsVaultSourceManifest(
        normalizeDocsVaultSourceConfig({
          id: 'bun-docs',
          type: 'git',
          category: 'typescript',
          url: 'https://github.com/oven-sh/bun.git',
          branch: 'main',
          docsPath: 'docs',
        })
      )
    ).rejects.toThrow(
      "Docs Vault source 'bun-docs' category 'typescript' does not match registry category 'bun'"
    );
  });
});
