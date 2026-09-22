import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeDocsVaultSourceConfig } from '../../docs-vault/config.js';
import type { DocsVaultFetch } from '../../docs-vault/fetchers/llms.js';
import { buildDocsVaultSourceManifest } from '../../docs-vault/manifest.js';
import { stageDocsVaultSource } from '../../docs-vault/sync.js';
import { writeDocsVaultPages } from '../../docs-vault/writer.js';

const FIXED_DATE = new Date('2026-06-20T18:30:00.000Z');

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

function createFetchFixture(
  map: Record<string, ReturnType<typeof createResponse>>
): DocsVaultFetch {
  return async (input) => {
    const response = map[input];
    if (!response) {
      throw new Error(`Unexpected fetch URL in test fixture: ${input}`);
    }
    return response;
  };
}

async function buildBunLlmsSourceManifest() {
  return buildDocsVaultSourceManifest(
    normalizeDocsVaultSourceConfig({
      id: 'bun-docs',
      type: 'llms',
      category: 'bun',
      title: 'Bun Documentation',
      url: 'https://bun.com/docs/llms.txt',
      docsPath: 'docs',
    })
  );
}

function readJsonLines(path: string) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe('docs-vault writer', () => {
  let stagingRoot: string | undefined;
  let indexRoot: string | undefined;

  afterEach(() => {
    if (stagingRoot) {
      rmSync(stagingRoot, { recursive: true, force: true });
      stagingRoot = undefined;
    }
    if (indexRoot) {
      rmSync(indexRoot, { recursive: true, force: true });
      indexRoot = undefined;
    }
  });

  it('writes wiki pages and local pages/aliases/links indexes from staged source output', async () => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'docs-vault-stage-'));
    indexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-index-'));

    const source = await buildBunLlmsSourceManifest();
    const staged = await stageDocsVaultSource({
      source,
      stagingRoot,
      fetch: createFetchFixture({
        'https://bun.com/docs/llms.txt': createResponse(
          '# Bun\n\n- [Bytecode Caching](https://bun.com/docs/bundler/bytecode.md)\n- [CSS](https://bun.com/docs/bundler/css.md): Bun CSS docs\n'
        ),
        'https://bun.com/docs/bundler/bytecode.md': createResponse(
          '# Bytecode Caching\n\nSee [CSS](./css.md) and [Bun](https://bun.com/docs/llms.txt).\n\n## Пример 123\n'
        ),
        'https://bun.com/docs/bundler/css.md': createResponse('# CSS\n\nOfficial Bun CSS page.\n'),
      }),
      now: () => FIXED_DATE,
    });
    const canonicalBefore = readFileSync(
      join(stagingRoot, 'canonical/bun-docs/bundler/bytecode.md'),
      'utf8'
    );

    const written = await writeDocsVaultPages({
      source,
      stagedSource: staged,
      stagingRoot,
      indexRoot,
    });

    expect(written).toMatchObject({
      wikiRoot: 'wiki/bun-docs',
      pageCount: 2,
      aliasCount: 5,
      linkCount: 1,
    });

    expect(readFileSync(join(stagingRoot, 'canonical/bun-docs/bundler/bytecode.md'), 'utf8')).toBe(
      canonicalBefore
    );

    const wikiPage = readFileSync(join(stagingRoot, 'wiki/bun-docs/bundler/bytecode.md'), 'utf8');
    expect(wikiPage).toContain('title: "Bytecode Caching"');
    expect(wikiPage).toContain('source_id: "bun-docs"');
    expect(wikiPage).toContain('canonical_path: "canonical/bun-docs/bundler/bytecode.md"');
    expect(wikiPage).toContain('- "bun-docs:Bytecode Caching"');
    expect(wikiPage).toContain(
      '# Bytecode Caching\n\nSee [CSS](./css.md) and [Bun](https://bun.com/docs/llms.txt).\n'
    );
    expect(wikiPage).toContain('## Related Pages\n- [[bun-docs/bundler/css|CSS]]');
    expect(wikiPage).toContain('## Canonical Source');

    const pages = readJsonLines(join(indexRoot, 'pages.jsonl'));
    expect(pages).toEqual([
      expect.objectContaining({
        pageId: 'bun-docs:bundler/bytecode',
        sourceId: 'bun-docs',
        title: 'Bytecode Caching',
        canonicalUrl: 'https://bun.com/docs/bundler/bytecode.md',
        canonicalPath: 'canonical/bun-docs/bundler/bytecode.md',
        wikiPath: 'wiki/bun-docs/bundler/bytecode.md',
        rawPath: 'raw/bun-docs/bundler/bytecode.md',
        wikiReference: 'bun-docs/bundler/bytecode',
        headings: [
          { depth: 1, text: 'Bytecode Caching', slug: 'bytecode-caching' },
          { depth: 2, text: 'Пример 123', slug: 'пример-123' },
        ],
      }),
      expect.objectContaining({
        pageId: 'bun-docs:bundler/css',
        sourceId: 'bun-docs',
        title: 'CSS',
        description: 'Bun CSS docs',
      }),
    ]);
    expect(pages[0]?.wikiHash).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const aliases = readJsonLines(join(indexRoot, 'aliases.jsonl'));
    expect(aliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alias: 'bun-docs:Bytecode Caching',
          aliasKind: 'title',
          pageId: 'bun-docs:bundler/bytecode',
        }),
        expect.objectContaining({
          alias: 'bun-docs:bundler/bytecode',
          aliasKind: 'path',
          pageId: 'bun-docs:bundler/bytecode',
        }),
        expect.objectContaining({
          alias: 'bun-docs:bytecode',
          aliasKind: 'basename',
          pageId: 'bun-docs:bundler/bytecode',
        }),
      ])
    );

    const links = readJsonLines(join(indexRoot, 'links.jsonl'));
    expect(links).toEqual([
      expect.objectContaining({
        sourceId: 'bun-docs',
        fromPageId: 'bun-docs:bundler/bytecode',
        fromCanonicalPath: 'canonical/bun-docs/bundler/bytecode.md',
        fromWikiPath: 'wiki/bun-docs/bundler/bytecode.md',
        toPageId: 'bun-docs:bundler/css',
        toCanonicalPath: 'canonical/bun-docs/bundler/css.md',
        toWikiPath: 'wiki/bun-docs/bundler/css.md',
        linkText: 'CSS',
      }),
    ]);
  });

  it('deduplicates aliases source-wide and keeps deterministic collision handling', async () => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'docs-vault-stage-'));
    indexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-index-'));

    const source = await buildBunLlmsSourceManifest();
    const staged = await stageDocsVaultSource({
      source,
      stagingRoot,
      fetch: createFetchFixture({
        'https://bun.com/docs/llms.txt': createResponse(
          '# Bun\n\n- [Shared](https://bun.com/docs/a.md)\n- [Shared](https://bun.com/docs/b.md)\n'
        ),
        'https://bun.com/docs/a.md': createResponse('# Shared\n'),
        'https://bun.com/docs/b.md': createResponse('# Shared\n'),
      }),
      now: () => FIXED_DATE,
    });

    const written = await writeDocsVaultPages({
      source,
      stagedSource: staged,
      stagingRoot,
      indexRoot,
    });

    expect(written.aliasCount).toBe(3);

    const aliases = readJsonLines(join(indexRoot, 'aliases.jsonl'));
    const sharedAliasRows = aliases.filter(
      (entry) => entry.alias === 'bun-docs:Shared' && entry.aliasKind === 'title'
    );

    expect(sharedAliasRows).toHaveLength(1);
    expect(sharedAliasRows[0]).toMatchObject({
      pageId: 'bun-docs:a',
      sourceId: 'bun-docs',
    });
  });

  it('sorts JSONL output with deterministic bytewise order for non-ASCII aliases', async () => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'docs-vault-stage-'));
    indexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-index-'));

    const source = await buildBunLlmsSourceManifest();
    const staged = await stageDocsVaultSource({
      source,
      stagingRoot,
      fetch: createFetchFixture({
        'https://bun.com/docs/llms.txt': createResponse(
          '# Bun\n\n- [Zeta](https://bun.com/docs/zeta.md)\n- [Äpfel](https://bun.com/docs/ae.md)\n'
        ),
        'https://bun.com/docs/zeta.md': createResponse('# Zeta\n'),
        'https://bun.com/docs/ae.md': createResponse('# Äpfel\n'),
      }),
      now: () => FIXED_DATE,
    });

    await writeDocsVaultPages({
      source,
      stagedSource: staged,
      stagingRoot,
      indexRoot,
    });

    const aliasTitles = readJsonLines(join(indexRoot, 'aliases.jsonl'))
      .filter((entry) => entry.aliasKind === 'title')
      .map((entry) => entry.alias);

    expect(aliasTitles).toEqual(['bun-docs:Zeta', 'bun-docs:Äpfel']);
  });

  it('escapes wikilink labels for related pages', async () => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'docs-vault-stage-'));
    indexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-index-'));

    const source = await buildBunLlmsSourceManifest();
    const staged = await stageDocsVaultSource({
      source,
      stagingRoot,
      fetch: createFetchFixture({
        'https://bun.com/docs/llms.txt': createResponse(
          '# Bun\n\n- [Source](https://bun.com/docs/source.md)\n- [Target](https://bun.com/docs/target.md)\n'
        ),
        'https://bun.com/docs/source.md': createResponse(
          '# Source\n\nSee [Target](./target.md).\n'
        ),
        'https://bun.com/docs/target.md': createResponse('# Pipe | Bracket ]\n'),
      }),
      now: () => FIXED_DATE,
    });

    await writeDocsVaultPages({
      source,
      stagedSource: staged,
      stagingRoot,
      indexRoot,
    });

    const wikiPage = readFileSync(join(stagingRoot, 'wiki/bun-docs/source.md'), 'utf8');
    expect(wikiPage).toContain('[[bun-docs/target|Pipe \\| Bracket \\]]');
  });

  it('rejects staged traversal paths before writing wiki output', async () => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'docs-vault-stage-'));
    indexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-index-'));

    const source = await buildBunLlmsSourceManifest();
    const staged = await stageDocsVaultSource({
      source,
      stagingRoot,
      fetch: createFetchFixture({
        'https://bun.com/docs/llms.txt': createResponse(
          '# Bun\n\n- [Bytecode Caching](https://bun.com/docs/bundler/bytecode.md)\n'
        ),
        'https://bun.com/docs/bundler/bytecode.md': createResponse('# Bytecode Caching\n'),
      }),
      now: () => FIXED_DATE,
    });

    const unsafeStaged = {
      ...staged,
      manifest: {
        ...staged.manifest,
        pages: staged.manifest.pages.map((page, index) =>
          index === 0
            ? {
                ...page,
                relativePath: '../escape.md',
              }
            : page
        ),
      },
    };

    await expect(
      writeDocsVaultPages({
        source,
        stagedSource: unsafeStaged,
        stagingRoot,
        indexRoot,
      })
    ).rejects.toThrow("Docs Vault page relative path '../escape.md' is not safe to write");
  });

  it('rejects staged absolute paths before writing wiki output', async () => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'docs-vault-stage-'));
    indexRoot = mkdtempSync(join(tmpdir(), 'docs-vault-index-'));

    const source = await buildBunLlmsSourceManifest();
    const staged = await stageDocsVaultSource({
      source,
      stagingRoot,
      fetch: createFetchFixture({
        'https://bun.com/docs/llms.txt': createResponse(
          '# Bun\n\n- [Bytecode Caching](https://bun.com/docs/bundler/bytecode.md)\n'
        ),
        'https://bun.com/docs/bundler/bytecode.md': createResponse('# Bytecode Caching\n'),
      }),
      now: () => FIXED_DATE,
    });

    const unsafeStaged = {
      ...staged,
      manifest: {
        ...staged.manifest,
        pages: staged.manifest.pages.map((page, index) =>
          index === 0
            ? {
                ...page,
                canonicalRelativePath: '/tmp/escape.md',
              }
            : page
        ),
      },
    };

    await expect(
      writeDocsVaultPages({
        source,
        stagedSource: unsafeStaged,
        stagingRoot,
        indexRoot,
      })
    ).rejects.toThrow("Docs Vault canonical page path '/tmp/escape.md' is not safe to write");
  });
});
