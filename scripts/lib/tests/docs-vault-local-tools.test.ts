import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeDocsVaultSourceConfig } from '../../docs-vault/config.js';
import {
  getDocPage,
  listDocSources,
  resolveDocLink,
  searchDocFiles,
} from '../../docs-vault/local-tools.js';
import { buildDocsVaultSourceManifest } from '../../docs-vault/manifest.js';
import { stageDocsVaultSource } from '../../docs-vault/sync.js';
import type { DocsVaultSourceConfig } from '../../docs-vault/types.js';
import { writeDocsVaultPages } from '../../docs-vault/writer.js';

const FIXED_DATE = new Date('2026-06-20T18:30:00.000Z');

type JsonRecord = Record<string, unknown>;

function createResponse(
  body: string,
  init?: { ok?: boolean; status?: number; statusText?: string }
) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    async text() {
      return body;
    },
  };
}

function createFetchFixture(map: Record<string, ReturnType<typeof createResponse>>) {
  return async (input: string) => {
    const response = map[input];
    if (!response) {
      throw new Error(`Unexpected fetch URL in test fixture: ${input}`);
    }
    return response;
  };
}

function readJsonLines(path: string): JsonRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

function writeJsonLines(path: string, entries: readonly JsonRecord[]) {
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
  writeFileSync(path, content.length > 0 ? `${content}\n` : '', 'utf8');
}

function mergeSourceIndexes(indexRoot: string, sourceIndexRoots: readonly string[]) {
  const pages = sourceIndexRoots.flatMap((root) => readJsonLines(join(root, 'pages.jsonl')));
  const aliases = sourceIndexRoots.flatMap((root) => readJsonLines(join(root, 'aliases.jsonl')));
  const links = sourceIndexRoots.flatMap((root) => readJsonLines(join(root, 'links.jsonl')));

  pages.sort(
    (left, right) =>
      String(left.sourceId).localeCompare(String(right.sourceId)) ||
      String(left.relativePath).localeCompare(String(right.relativePath))
  );
  aliases.sort(
    (left, right) =>
      String(left.normalizedAlias).localeCompare(String(right.normalizedAlias)) ||
      String(left.pageId).localeCompare(String(right.pageId))
  );
  links.sort(
    (left, right) =>
      String(left.fromPageId).localeCompare(String(right.fromPageId)) ||
      String(left.toPageId).localeCompare(String(right.toPageId)) ||
      String(left.linkText).localeCompare(String(right.linkText))
  );

  writeJsonLines(join(indexRoot, 'pages.jsonl'), pages);
  writeJsonLines(join(indexRoot, 'aliases.jsonl'), aliases);
  writeJsonLines(join(indexRoot, 'links.jsonl'), links);
}

async function buildDocsVaultFixture() {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'docs-vault-local-tools-vault-'));
  const indexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-local-tools-index-'));
  const extraRoot = mkdtempSync(join(tmpdir(), 'docs-vault-local-tools-extra-'));
  const sourceIndexRoots: string[] = [];
  const sourceConfigs: DocsVaultSourceConfig[] = [
    normalizeDocsVaultSourceConfig({
      id: 'bun-docs',
      type: 'llms',
      category: 'bun',
      title: 'Bun Documentation',
      url: 'https://bun.com/docs/llms.txt',
      docsPath: 'docs',
    }),
    normalizeDocsVaultSourceConfig({
      id: 'typescript-docs',
      type: 'llms',
      category: 'typescript',
      title: 'TypeScript Documentation',
      url: 'https://www.typescriptlang.org/docs/llms.txt',
      docsPath: 'docs',
    }),
  ];

  const sources = await Promise.all(
    sourceConfigs.map((config) => buildDocsVaultSourceManifest(config))
  );
  const [bunSource, typescriptSource] = sources;
  if (!bunSource || !typescriptSource) {
    throw new Error('Docs Vault test fixture requires two source manifests');
  }

  const bunSourceIndexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-local-tools-bun-index-'));
  const typescriptSourceIndexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-local-tools-ts-index-'));
  sourceIndexRoots.push(bunSourceIndexRoot, typescriptSourceIndexRoot);

  const bunStaged = await stageDocsVaultSource({
    source: bunSource,
    stagingRoot: vaultRoot,
    fetch: createFetchFixture({
      'https://bun.com/docs/llms.txt': createResponse(
        '# Bun\n\n- [Bytecode Caching](https://bun.com/docs/bundler/bytecode.md)\n- [CSS](https://bun.com/docs/bundler/css.md): Bun CSS docs\n- [TLS](https://bun.com/docs/runtime/http/tls.md): Enable TLS in Bun.serve\n'
      ),
      'https://bun.com/docs/bundler/bytecode.md': createResponse(
        '# Bytecode Caching\n\nSee [CSS](./css.md) and [Bun](https://bun.com/docs/llms.txt).\n'
      ),
      'https://bun.com/docs/bundler/css.md': createResponse('# CSS\n\nOfficial Bun CSS page.\n'),
      'https://bun.com/docs/runtime/http/tls.md': createResponse(
        '# TLS\n\nConfigure Bun.serve with TLS certificates and keys.\n'
      ),
    }),
    now: () => FIXED_DATE,
  });
  await writeDocsVaultPages({
    source: bunSource,
    stagedSource: bunStaged,
    stagingRoot: vaultRoot,
    indexRoot: bunSourceIndexRoot,
  });

  const typescriptStaged = await stageDocsVaultSource({
    source: typescriptSource,
    stagingRoot: vaultRoot,
    fetch: createFetchFixture({
      'https://www.typescriptlang.org/docs/llms.txt': createResponse(
        '# TypeScript\n\n- [Bytecode Caching](https://www.typescriptlang.org/docs/bytecode.md): TypeScript page with a colliding title\n'
      ),
      'https://www.typescriptlang.org/docs/bytecode.md': createResponse(
        '# Bytecode Caching\n\nTypeScript keeps a separate page with the same title.\n'
      ),
    }),
    now: () => FIXED_DATE,
  });
  await writeDocsVaultPages({
    source: typescriptSource,
    stagedSource: typescriptStaged,
    stagingRoot: vaultRoot,
    indexRoot: typescriptSourceIndexRoot,
  });

  mergeSourceIndexes(indexRoot, sourceIndexRoots);

  return {
    extraRoot,
    indexRoot,
    sourceConfigs,
    sourceIndexRoots,
    sources,
    vaultRoot,
  };
}

describe('docs-vault local tools', () => {
  const cleanupRoots = new Set<string>();

  afterEach(() => {
    for (const root of cleanupRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    cleanupRoots.clear();
  });

  it('lists manifest sources with index counts from source config input', async () => {
    const fixture = await buildDocsVaultFixture();
    cleanupRoots.add(fixture.vaultRoot);
    cleanupRoots.add(fixture.indexRoot);
    cleanupRoots.add(fixture.extraRoot);
    fixture.sourceIndexRoots.forEach((root) => {
      cleanupRoots.add(root);
    });

    const listed = await listDocSources({
      indexRoot: fixture.indexRoot,
      sourceConfigs: fixture.sourceConfigs,
    });

    expect(listed).toEqual({
      manifestVersion: 'docs-vault-manifest/v1',
      sources: [
        expect.objectContaining({
          sourceId: 'bun-docs',
          pageCount: 3,
          aliasCount: 7,
          linkCount: 1,
        }),
        expect.objectContaining({
          sourceId: 'typescript-docs',
          pageCount: 1,
          aliasCount: 2,
          linkCount: 0,
        }),
      ],
    });
  });

  it('rejects escaped manifestPath and configPath inputs in listDocSources', async () => {
    const fixture = await buildDocsVaultFixture();
    cleanupRoots.add(fixture.vaultRoot);
    cleanupRoots.add(fixture.indexRoot);
    cleanupRoots.add(fixture.extraRoot);
    fixture.sourceIndexRoots.forEach((root) => {
      cleanupRoots.add(root);
    });

    const manifestPayload = {
      manifestVersion: 'docs-vault-manifest/v1',
      sources: fixture.sources,
    };
    const configPayload = {
      sources: fixture.sourceConfigs,
    };

    const escapedManifestPath = join(fixture.extraRoot, 'manifest.json');
    const escapedConfigPath = join(fixture.extraRoot, 'sources.json');
    writeFileSync(escapedManifestPath, `${JSON.stringify(manifestPayload)}\n`, 'utf8');
    writeFileSync(escapedConfigPath, `${JSON.stringify(configPayload)}\n`, 'utf8');

    await expect(
      listDocSources({
        cwd: fixture.vaultRoot,
        manifestPath: relative(fixture.vaultRoot, escapedManifestPath),
      })
    ).rejects.toThrow(/not safe to read/u);

    await expect(
      listDocSources({
        cwd: fixture.vaultRoot,
        configPath: escapedConfigPath,
      })
    ).rejects.toThrow(/not safe to read/u);

    const manifestLinkPath = join(fixture.vaultRoot, 'manifest-link.json');
    symlinkSync(escapedManifestPath, manifestLinkPath);

    await expect(
      listDocSources({
        cwd: fixture.vaultRoot,
        manifestPath: 'manifest-link.json',
      })
    ).rejects.toThrow(/escapes root/u);
  });

  it('searches local indexes and page content with deterministic ordering and source filters', async () => {
    const fixture = await buildDocsVaultFixture();
    cleanupRoots.add(fixture.vaultRoot);
    cleanupRoots.add(fixture.indexRoot);
    cleanupRoots.add(fixture.extraRoot);
    fixture.sourceIndexRoots.forEach((root) => {
      cleanupRoots.add(root);
    });

    const filtered = searchDocFiles({
      indexRoot: fixture.indexRoot,
      vaultRoot: fixture.vaultRoot,
      query: 'Bytecode Caching',
      sourceIds: ['bun-docs'],
      exact: true,
    });

    expect(filtered.exact).toBe(true);
    expect(filtered.totalMatches).toBe(1);
    expect(filtered.results).toEqual([
      expect.objectContaining({
        sourceId: 'bun-docs',
        pageId: 'bun-docs:bundler/bytecode',
        matchKind: 'exact-title',
      }),
    ]);

    const contentMatch = searchDocFiles({
      indexRoot: fixture.indexRoot,
      vaultRoot: fixture.vaultRoot,
      query: 'Official Bun CSS page',
      limit: 1,
    });

    expect(contentMatch.limit).toBe(1);
    expect(contentMatch.totalMatches).toBe(1);
    expect(contentMatch.results).toEqual([
      expect.objectContaining({
        sourceId: 'bun-docs',
        pageId: 'bun-docs:bundler/css',
        matchKind: 'includes-content',
        snippet: expect.stringContaining('Official Bun CSS page'),
      }),
    ]);

    const allTermsMatch = searchDocFiles({
      indexRoot: fixture.indexRoot,
      vaultRoot: fixture.vaultRoot,
      query: 'Bun.serve TLS',
    });

    expect(allTermsMatch.totalMatches).toBe(1);
    expect(allTermsMatch.results).toEqual([
      expect.objectContaining({
        sourceId: 'bun-docs',
        pageId: 'bun-docs:runtime/http/tls',
        matchKind: 'includes-description',
        matchedText: 'Enable TLS in Bun.serve',
      }),
    ]);
  });

  it('resolves wikilinks, source-scoped aliases, and reports ambiguous title-only matches', async () => {
    const fixture = await buildDocsVaultFixture();
    cleanupRoots.add(fixture.vaultRoot);
    cleanupRoots.add(fixture.indexRoot);
    cleanupRoots.add(fixture.extraRoot);
    fixture.sourceIndexRoots.forEach((root) => {
      cleanupRoots.add(root);
    });

    const wikiLink = resolveDocLink({
      indexRoot: fixture.indexRoot,
      link: '[[bun-docs/bundler/bytecode#bytecode-caching]]',
    });
    const resolvedHeading = wikiLink.resolved?.heading;

    expect(resolvedHeading).toEqual({
      depth: 1,
      text: 'Bytecode Caching',
      slug: 'bytecode-caching',
    });
    expect(wikiLink).toMatchObject({
      ambiguous: false,
      matchCount: 1,
      resolved: expect.objectContaining({
        sourceId: 'bun-docs',
        pageId: 'bun-docs:bundler/bytecode',
        matchKind: 'wikiReference',
      }),
    });

    const sourceScopedAlias = resolveDocLink({
      indexRoot: fixture.indexRoot,
      link: 'bun-docs:Bytecode Caching',
    });

    expect(sourceScopedAlias).toMatchObject({
      ambiguous: false,
      matchCount: 1,
      resolved: expect.objectContaining({
        sourceId: 'bun-docs',
        matchKind: 'alias',
      }),
    });

    const ambiguous = resolveDocLink({
      indexRoot: fixture.indexRoot,
      link: 'Bytecode Caching',
    });

    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.resolved).toBeNull();
    expect(ambiguous.matches.map((match) => match.sourceId)).toEqual([
      'bun-docs',
      'typescript-docs',
    ]);
  });

  it('reads canonical, wiki, and raw pages from a caller-provided vault root', async () => {
    const fixture = await buildDocsVaultFixture();
    cleanupRoots.add(fixture.vaultRoot);
    cleanupRoots.add(fixture.indexRoot);
    cleanupRoots.add(fixture.extraRoot);
    fixture.sourceIndexRoots.forEach((root) => {
      cleanupRoots.add(root);
    });

    const canonicalPage = getDocPage({
      vaultRoot: fixture.vaultRoot,
      sourceId: 'bun-docs',
      path: 'bun-docs/bundler/bytecode',
      format: 'canonical',
    });
    const wikiPage = getDocPage({
      vaultRoot: fixture.vaultRoot,
      sourceId: 'bun-docs',
      path: 'bundler/bytecode',
      format: 'wiki',
    });
    const rawPage = getDocPage({
      vaultRoot: fixture.vaultRoot,
      sourceId: 'bun-docs',
      path: 'raw/bun-docs/bundler/bytecode.md',
      format: 'raw',
    });

    expect(canonicalPage.relativePath).toBe('canonical/bun-docs/bundler/bytecode.md');
    expect(canonicalPage.content).toContain('# Bytecode Caching');
    expect(wikiPage.content).toContain('## Related Pages');
    expect(rawPage.relativePath).toBe('raw/bun-docs/bundler/bytecode.md');
    expect(rawPage.content).toContain('See [CSS](./css.md)');
  });

  it('rejects traversal, absolute-path, and symlink escapes', async () => {
    const fixture = await buildDocsVaultFixture();
    cleanupRoots.add(fixture.vaultRoot);
    cleanupRoots.add(fixture.indexRoot);
    cleanupRoots.add(fixture.extraRoot);
    fixture.sourceIndexRoots.forEach((root) => {
      cleanupRoots.add(root);
    });

    expect(() =>
      resolveDocLink({
        indexRoot: fixture.indexRoot,
        link: '[[../escape]]',
      })
    ).toThrow(/not safe to resolve/u);

    expect(() =>
      getDocPage({
        vaultRoot: fixture.vaultRoot,
        sourceId: 'bun-docs',
        path: '../escape',
        format: 'canonical',
      })
    ).toThrow(/not safe to read/u);

    expect(() =>
      getDocPage({
        vaultRoot: fixture.vaultRoot,
        sourceId: 'bun-docs',
        path: '/etc/passwd',
        format: 'canonical',
      })
    ).toThrow(/not safe to read/u);

    const escapedTarget = join(fixture.extraRoot, 'escaped.md');
    writeFileSync(escapedTarget, '# Escaped\n', 'utf8');
    const canonicalPath = join(fixture.vaultRoot, 'canonical/bun-docs/bundler/bytecode.md');
    rmSync(canonicalPath);
    symlinkSync(escapedTarget, canonicalPath);

    expect(() =>
      getDocPage({
        vaultRoot: fixture.vaultRoot,
        sourceId: 'bun-docs',
        path: 'bundler/bytecode.md',
        format: 'canonical',
      })
    ).toThrow(/escapes root/u);
  });
});
