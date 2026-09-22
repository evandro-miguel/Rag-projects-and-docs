import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeDocsVaultSourceConfig } from '../../docs-vault/config.js';
import {
  type DocsVaultFetch,
  fetchLlmsSource,
  parseLlmsMarkdownPageLinks,
} from '../../docs-vault/fetchers/llms.js';
import { buildDocsVaultSourceManifest } from '../../docs-vault/manifest.js';
import { stageDocsVaultSource } from '../../docs-vault/sync.js';

const FIXED_DATE = new Date('2026-06-20T18:00:00.000Z');

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

describe('docs-vault llms fetcher', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('parses Bun llms.txt markdown links deterministically', () => {
    const links = parseLlmsMarkdownPageLinks({
      llmsText: `# Bun\n\n## Docs\n- [Zeta](https://bun.com/docs/runtime/zeta.md)\n- [Alpha](https://bun.com/docs/runtime/alpha.md): First page\n- [Alpha](https://bun.com/docs/runtime/alpha.md): Duplicate\n- [Ignore](https://bun.com/docs/runtime/index.html)\n`,
      baseUrl: 'https://bun.com/docs/llms.txt',
      allowedDomains: ['bun.com'],
      includePaths: ['docs'],
    });

    expect(links).toEqual([
      {
        title: 'Alpha',
        description: 'First page',
        sourceUrl: 'https://bun.com/docs/runtime/alpha.md',
        canonicalUrl: 'https://bun.com/docs/runtime/alpha.md',
        relativePath: 'runtime/alpha.md',
      },
      {
        title: 'Zeta',
        sourceUrl: 'https://bun.com/docs/runtime/zeta.md',
        canonicalUrl: 'https://bun.com/docs/runtime/zeta.md',
        relativePath: 'runtime/zeta.md',
      },
    ]);
  });

  it.each([
    [
      'out of domain',
      '- [Bad](https://evil.example/docs/pwn.md)',
      "Docs Vault llms page link 'Bad' host 'evil.example' is outside allowed domains: bun.com",
    ],
    [
      'localhost',
      '- [Bad](http://localhost/docs/pwn.md)',
      "Docs Vault llms page link 'Bad' points to localhost/private host 'localhost'",
    ],
    [
      'private ip',
      '- [Bad](http://127.0.0.1/docs/pwn.md)',
      "Docs Vault llms page link 'Bad' points to localhost/private host '127.0.0.1'",
    ],
    [
      'ipv6 loopback',
      '- [Bad](http://[::1]/docs/pwn.md)',
      "Docs Vault llms page link 'Bad' points to localhost/private host '[::1]'",
    ],
    [
      'ipv6 unique-local',
      '- [Bad](http://[fc00::1]/docs/pwn.md)',
      "Docs Vault llms page link 'Bad' points to localhost/private host '[fc00::1]'",
    ],
  ])('blocks %s markdown targets', (_label, line, message) => {
    expect(() =>
      parseLlmsMarkdownPageLinks({
        llmsText: line,
        baseUrl: 'https://bun.com/docs/llms.txt',
        allowedDomains: ['bun.com'],
        includePaths: ['docs'],
      })
    ).toThrow(message);
  });

  it('rejects markdown links outside the includePaths boundary', () => {
    expect(() =>
      parseLlmsMarkdownPageLinks({
        llmsText: '- [Outside](https://bun.com/blog/post.md)',
        baseUrl: 'https://bun.com/docs/llms.txt',
        allowedDomains: ['bun.com'],
        includePaths: ['docs'],
      })
    ).toThrow("Docs Vault llms page path '/blog/post.md' is outside include paths: docs");
  });

  it('fetches Bun llms.txt pages through injected fetch only', async () => {
    const source = await buildBunLlmsSourceManifest();
    const fetch = createFetchFixture({
      'https://bun.com/docs/llms.txt': createResponse(
        '# Bun\n\n- [Bytecode Caching](https://bun.com/docs/bundler/bytecode.md)\n'
      ),
      'https://bun.com/docs/bundler/bytecode.md': createResponse(
        '# Bytecode Caching\n\nOfficial Bun page.\n'
      ),
    });

    const result = await fetchLlmsSource({
      source,
      fetch,
      now: () => FIXED_DATE,
    });

    expect(result).toMatchObject({
      sourceId: 'bun-docs',
      sourceUrl: 'https://bun.com/docs/llms.txt',
      retrievedAt: FIXED_DATE.toISOString(),
      index: {
        bytes: expect.any(Number),
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(result.pages).toEqual([
      {
        title: 'Bytecode Caching',
        sourceUrl: 'https://bun.com/docs/bundler/bytecode.md',
        canonicalUrl: 'https://bun.com/docs/bundler/bytecode.md',
        relativePath: 'bundler/bytecode.md',
        content: '# Bytecode Caching\n\nOfficial Bun page.\n',
        bytes: Buffer.byteLength('# Bytecode Caching\n\nOfficial Bun page.\n', 'utf8'),
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        retrievedAt: FIXED_DATE.toISOString(),
      },
    ]);
  });

  it('stages fetched raw and canonical files and writes a deterministic manifest', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'docs-vault-llms-'));
    const source = await buildBunLlmsSourceManifest();
    const fetch = createFetchFixture({
      'https://bun.com/docs/llms.txt': createResponse(
        '# Bun\n\n- [Bytecode Caching](https://bun.com/docs/bundler/bytecode.md)\n- [CSS](https://bun.com/docs/bundler/css.md): Bun CSS docs\n'
      ),
      'https://bun.com/docs/bundler/bytecode.md': createResponse(
        '# Bytecode Caching\n\nOfficial Bun bytecode page.\n'
      ),
      'https://bun.com/docs/bundler/css.md': createResponse('# CSS\n\nOfficial Bun CSS page.\n'),
    });

    const staged = await stageDocsVaultSource({
      source,
      stagingRoot: tempDir,
      fetch,
      now: () => FIXED_DATE,
    });

    const manifestText = readFileSync(staged.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText);

    expect(staged.manifestRelativePath).toBe('manifests/bun-docs.json');
    expect(manifest).toMatchObject({
      manifestVersion: 'docs-vault-staged-source/v1',
      sourceId: 'bun-docs',
      sourceConfigHash: source.snapshot.configHash,
      fetchedAt: FIXED_DATE.toISOString(),
      sourceUrl: 'https://bun.com/docs/llms.txt',
      rawRoot: 'raw/bun-docs',
      canonicalRoot: 'canonical/bun-docs',
      manifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      index: {
        rawRelativePath: 'raw/bun-docs/llms.txt',
        bytes: expect.any(Number),
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        retrievedAt: FIXED_DATE.toISOString(),
      },
      pageCount: 2,
      pages: [
        {
          title: 'Bytecode Caching',
          relativePath: 'bundler/bytecode.md',
          rawRelativePath: 'raw/bun-docs/bundler/bytecode.md',
          canonicalRelativePath: 'canonical/bun-docs/bundler/bytecode.md',
          canonicalUrl: 'https://bun.com/docs/bundler/bytecode.md',
          retrievedAt: FIXED_DATE.toISOString(),
        },
        {
          title: 'CSS',
          description: 'Bun CSS docs',
          relativePath: 'bundler/css.md',
          rawRelativePath: 'raw/bun-docs/bundler/css.md',
          canonicalRelativePath: 'canonical/bun-docs/bundler/css.md',
          canonicalUrl: 'https://bun.com/docs/bundler/css.md',
          retrievedAt: FIXED_DATE.toISOString(),
        },
      ],
    });

    expect(existsSync(join(tempDir, 'raw/bun-docs/llms.txt'))).toBe(true);
    expect(existsSync(join(tempDir, 'raw/bun-docs/bundler/bytecode.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'canonical/bun-docs/bundler/bytecode.md'))).toBe(true);
    expect(readFileSync(join(tempDir, 'canonical/bun-docs/bundler/css.md'), 'utf8')).toBe(
      '# CSS\n\nOfficial Bun CSS page.\n'
    );
  });
});
