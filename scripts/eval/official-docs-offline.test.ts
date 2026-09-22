import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDocsVaultSourceConfigs } from '../docs-vault/config.js';
import { listDocSources, searchDocFiles } from '../docs-vault/local-tools.js';
import { buildDocsVaultManifest } from '../docs-vault/manifest.js';
import type { DocsVaultManifest } from '../docs-vault/types.js';
import type { DocsVaultPageIndexEntry } from '../docs-vault/writer.js';

const FIXED_DATE = '2026-06-20T18:45:00.000Z';

const OFFICIAL_DOC_SCENARIOS = [
  {
    sourceId: 'bun-docs',
    query: 'Bytecode Caching',
    title: 'Bytecode Caching',
    relativePath: 'bundler/bytecode.md',
    canonicalUrl: 'https://bun.sh/docs/bundler/bytecode',
    body: '# Bytecode Caching\n\nBun caches transpiled output for faster startup.\n',
  },
  {
    sourceId: 'typescript-docs',
    query: 'Utility Types',
    title: 'Utility Types',
    relativePath: 'handbook/utility-types.md',
    canonicalUrl: 'https://www.typescriptlang.org/docs/handbook/utility-types.html',
    body: '# Utility Types\n\nTypeScript ships utility types like Partial and Pick.\n',
  },
  {
    sourceId: 'python-docs',
    query: 'Classes',
    title: 'Classes',
    relativePath: 'tutorial/classes.rst',
    canonicalUrl: 'https://docs.python.org/3/tutorial/classes.html',
    body: 'Classes\n=======\n\nPython classes package data and behavior together.\n',
  },
  {
    sourceId: 'go-docs',
    query: 'Effective Go',
    title: 'Effective Go',
    relativePath: 'doc/effective_go.md',
    canonicalUrl: 'https://go.dev/doc/effective_go',
    body: '# Effective Go\n\nEffective Go documents idiomatic Go patterns.\n',
  },
] as const;

type OfficialDocsFixture = {
  indexRoot: string;
  manifest: DocsVaultManifest;
  vaultRoot: string;
};

function writeTextFile(root: string, relativePath: string, content: string) {
  const outputPath = join(root, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');
}

function writeJsonLines(path: string, entries: readonly unknown[]) {
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
  writeFileSync(path, content.length > 0 ? `${content}\n` : '', 'utf8');
}

function buildRelativeStem(relativePath: string): string {
  return relativePath.replace(/\.(md|mdx|rst|txt)$/iu, '');
}

function buildPageEntry(
  scenario: (typeof OFFICIAL_DOC_SCENARIOS)[number]
): DocsVaultPageIndexEntry {
  const relativeStem = buildRelativeStem(scenario.relativePath);
  const sourceScopedStem = `${scenario.sourceId}/${relativeStem}`;

  return {
    pageId: `${scenario.sourceId}:${relativeStem}`,
    sourceId: scenario.sourceId,
    title: scenario.title,
    listedTitle: scenario.title,
    canonicalUrl: scenario.canonicalUrl,
    canonicalPath: `canonical/${scenario.sourceId}/${scenario.relativePath}`,
    wikiPath: `wiki/${sourceScopedStem}.md`,
    rawPath: `raw/${scenario.sourceId}/${scenario.relativePath}`,
    wikiReference: sourceScopedStem,
    relativePath: scenario.relativePath,
    contentHash: `sha256:${scenario.sourceId}-content`,
    wikiHash: `sha256:${scenario.sourceId}-wiki`,
    bytes: Buffer.byteLength(scenario.body, 'utf8'),
    retrievedAt: FIXED_DATE,
    headings: [
      {
        depth: 1,
        text: scenario.title,
        slug: relativeStem.split('/').at(-1) ?? 'index',
      },
    ],
  };
}

async function buildOfficialDocsFixture(): Promise<OfficialDocsFixture> {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'official-docs-offline-vault-'));
  const indexRoot = mkdtempSync(join(tmpdir(), 'official-docs-offline-index-'));
  const wantedIds = new Set<string>(OFFICIAL_DOC_SCENARIOS.map((scenario) => scenario.sourceId));
  const sourceConfigs = loadDocsVaultSourceConfigs().filter((source) =>
    wantedIds.has(source.sourceId)
  );
  const manifest = await buildDocsVaultManifest({ sources: sourceConfigs });
  const pages = OFFICIAL_DOC_SCENARIOS.map(buildPageEntry);

  for (const scenario of OFFICIAL_DOC_SCENARIOS) {
    const page = buildPageEntry(scenario);
    writeTextFile(vaultRoot, page.canonicalPath, scenario.body);
    writeTextFile(vaultRoot, page.wikiPath, scenario.body);
  }

  writeJsonLines(join(indexRoot, 'pages.jsonl'), pages);
  writeJsonLines(join(indexRoot, 'aliases.jsonl'), []);
  writeJsonLines(join(indexRoot, 'links.jsonl'), []);

  return {
    indexRoot,
    manifest,
    vaultRoot,
  };
}

describe('official docs offline eval coverage', () => {
  const cleanupRoots = new Set<string>();

  afterEach(() => {
    for (const root of cleanupRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    cleanupRoots.clear();
  });

  it('keeps Bun, TypeScript, Python, and Go registered as official docs in Docs Vault fixtures', async () => {
    const fixture = await buildOfficialDocsFixture();
    cleanupRoots.add(fixture.vaultRoot);
    cleanupRoots.add(fixture.indexRoot);

    const listed = await listDocSources({
      manifest: fixture.manifest,
      indexRoot: fixture.indexRoot,
    });

    const officialSources = listed.sources.filter(
      (source) => source.kind === 'official-docs' && source.authority === 'official'
    );

    expect(officialSources.map((source) => source.sourceId)).toEqual([
      'bun-docs',
      'go-docs',
      'python-docs',
      'typescript-docs',
    ]);
    expect(officialSources).toEqual(
      expect.arrayContaining(
        OFFICIAL_DOC_SCENARIOS.map((scenario) =>
          expect.objectContaining({
            sourceId: scenario.sourceId,
            category: scenario.sourceId.split('-')[0],
            kind: 'official-docs',
            authority: 'official',
            trustLevel: 'official',
            pageCount: 1,
            aliasCount: 0,
            linkCount: 0,
          })
        )
      )
    );
  });

  it.each(
    OFFICIAL_DOC_SCENARIOS
  )('resolves $sourceId query "$query" from the deterministic local Docs Vault fixture', async (scenario) => {
    const fixture = await buildOfficialDocsFixture();
    cleanupRoots.add(fixture.vaultRoot);
    cleanupRoots.add(fixture.indexRoot);

    const result = searchDocFiles({
      indexRoot: fixture.indexRoot,
      limit: 5,
      query: scenario.query,
      sourceIds: [scenario.sourceId],
      vaultRoot: fixture.vaultRoot,
    });

    expect(result.totalMatches).toBe(1);
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        sourceId: scenario.sourceId,
        title: scenario.title,
        canonicalUrl: scenario.canonicalUrl,
        path: scenario.relativePath,
        wikiReference: `${scenario.sourceId}/${buildRelativeStem(scenario.relativePath)}`,
        matchKind: 'exact-title',
      })
    );
  });
});
