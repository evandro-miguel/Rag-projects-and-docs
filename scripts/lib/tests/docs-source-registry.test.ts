import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeDocsSourceId,
  deriveDocsSourceCategoryNames,
  listDocsSources,
  lookupDocsSourceById,
  lookupDocsSourceByPath,
  matchesDocsSourceFilter,
  normalizeDocsSourceCanonicalKey,
  normalizeDocsSourceMetadata,
} from '../docs-source-registry.js';

describe('docs-source-registry', () => {
  it('keeps sources.json ids and the registry sourceId set identical', () => {
    const sourcesPath = join(process.cwd(), 'scripts', 'sources.json');
    const catalog = JSON.parse(readFileSync(sourcesPath, 'utf-8')).sources as Array<{
      id: string;
    }>;
    const catalogIds = catalog.map((source) => source.id).sort();
    const registryIds = listDocsSources()
      .map((source) => source.sourceId)
      .sort();

    expect(catalogIds).toEqual(registryIds);
    for (const source of catalog) {
      expect(lookupDocsSourceById(source.id)?.sourceId).toBe(source.id);
    }
  });

  it('keeps canonical React DOM hooks eligible for processing', () => {
    const sourcesPath = join(process.cwd(), 'scripts', 'sources.json');
    const catalog = JSON.parse(readFileSync(sourcesPath, 'utf-8')).sources as Array<{
      id: string;
      ignorePaths?: string[];
    }>;
    const react = catalog.find((source) => source.id === 'react-docs');

    expect(react).toBeDefined();
    expect(react?.ignorePaths).not.toContain('reference/react-dom/');
    expect(react?.ignorePaths).toContain('blog/');
  });

  it('resolves source metadata for go-books as Go book documentation', () => {
    const source = lookupDocsSourceByPath('go-books/effective-go.md');
    expect(source?.sourceId).toBe('go-books');
    expect(source?.language).toBe('go');
    expect(source?.kind).toBe('book');
    expect(source?.authority).toBe('community-vetted');

    expect(
      normalizeDocsSourceMetadata({
        sourcePath: 'ingest/processed/external/go-books/effective-go.md',
      })
    ).toMatchObject({
      sourceId: 'go-books',
      category: 'go',
      language: 'go',
      kind: 'book',
      authority: 'community-vetted',
      lang: 'go',
      ecosystem: 'go',
      lib: 'go',
    });
  });

  it('keeps TypeScript and Bun distinct at language and runtime levels', () => {
    expect(normalizeDocsSourceMetadata({ sourceId: 'typescript-docs' })).toMatchObject({
      sourceId: 'typescript-docs',
      language: 'typescript',
      lang: 'ts',
      ecosystem: 'node',
      lib: 'typescript',
    });
    expect(normalizeDocsSourceMetadata({ sourceId: 'bun-docs' })).toMatchObject({
      sourceId: 'bun-docs',
      language: 'bun',
      lang: 'ts',
      ecosystem: 'bun',
      lib: 'bun',
    });
  });

  it('keeps registry truth over contradictory metadata for known sources', () => {
    expect(
      normalizeDocsSourceMetadata({
        sourceId: 'go-books',
        category: 'python',
        language: 'python',
        kind: 'official-docs',
        authority: 'official',
        tags: ['override'],
        lang: 'py',
        ecosystem: 'python',
        lib: 'cpython',
      })
    ).toMatchObject({
      sourceId: 'go-books',
      category: 'go',
      language: 'go',
      kind: 'book',
      authority: 'community-vetted',
      lang: 'go',
      ecosystem: 'go',
      lib: 'go',
    });
  });

  it('resolves current source aliases without an MCP-only prefix list', () => {
    expect(lookupDocsSourceByPath('tailwindcss-docs/utility-first.mdx')?.sourceId).toBe(
      'components'
    );
    expect(lookupDocsSourceByPath('tailwind/utility-first.mdx')?.sourceId).toBe('components');
    expect(lookupDocsSourceByPath('tanstack-router-docs/overview.md')?.sourceId).toBe('tanstack');
    expect(lookupDocsSourceByPath('uv-docs/getting-started.md')?.sourceId).toBe('uv-docs');
    expect(lookupDocsSourceById('tailwindcss-docs')?.sourceId).toBe('components');
    expect(lookupDocsSourceById('uv')?.sourceId).toBe('uv-docs');
    expect(canonicalizeDocsSourceId('docker')).toBe('docker-docs');
    expect(canonicalizeDocsSourceId('tailwindcss-docs')).toBe('components');
    expect(canonicalizeDocsSourceId('pgvector')).toBe('pgvector-docs');
    expect(canonicalizeDocsSourceId('mcp')).toBe('mcp-docs');
    expect(canonicalizeDocsSourceId('mcp-spec')).toBe('mcp-docs');
    expect(canonicalizeDocsSourceId('vitest')).toBe('vitest-docs');
    expect(canonicalizeDocsSourceId('biome')).toBe('biome-docs');
    expect(canonicalizeDocsSourceId('tanstack-query')).toBe('tanstack-query-docs');
    expect(canonicalizeDocsSourceId('react-query')).toBe('tanstack-query-docs');
    expect(canonicalizeDocsSourceId('tanstack-query-docs')).not.toBe('tanstack');
    expect(lookupDocsSourceById('tanstack-query-docs')?.sourceId).toBe('tanstack-query-docs');
    expect(lookupDocsSourceById('tanstack')?.sourceId).toBe('tanstack');
    expect(canonicalizeDocsSourceId('playwright')).toBe('playwright-docs');
    expect(canonicalizeDocsSourceId('vite')).toBe('vite-docs');
    expect(canonicalizeDocsSourceId('hono')).toBe('hono-docs');
    expect(canonicalizeDocsSourceId('pydantic')).toBe('pydantic-docs');
    expect(canonicalizeDocsSourceId('supabase')).toBe('supabase-database-docs');
  });

  it('resolves pgvector-docs as official Postgres vector documentation', () => {
    expect(lookupDocsSourceByPath('pgvector-docs/README.md')?.sourceId).toBe('pgvector-docs');
    expect(normalizeDocsSourceMetadata({ sourceId: 'pgvector' })).toMatchObject({
      sourceId: 'pgvector-docs',
      category: 'pgvector',
      kind: 'official-docs',
      authority: 'official',
      ecosystem: 'postgres',
      lib: 'pgvector',
    });
    expect(
      lookupDocsSourceByPath('mcp-docs/specification/2026-07-28/server/tools.mdx')?.sourceId
    ).toBe('mcp-docs');
    expect(normalizeDocsSourceMetadata({ sourceId: 'mcp-spec' })).toMatchObject({
      sourceId: 'mcp-docs',
      category: 'mcp',
      kind: 'official-docs',
      authority: 'official',
      lib: 'mcp',
    });
  });

  it('normalizes canonical keys and rejects unknown external prefixes', () => {
    expect(normalizeDocsSourceCanonicalKey('ingest/source/external/go-books/effective-go.md')).toBe(
      'go-books/effective-go'
    );
    expect(
      normalizeDocsSourceCanonicalKey('ingest/source/external/python-docs/tutorial/index.rst')
    ).toBe('python-docs/tutorial/index');
    expect(
      lookupDocsSourceByPath('ingest/processed/external/unknown-docs/page.md')
    ).toBeUndefined();
  });

  it('matches source, language, kind, authority, category, and tag filters', () => {
    const metadata = { sourcePath: 'go-books/effective-go.md' };

    expect(matchesDocsSourceFilter(metadata, { sourceId: 'go-books' })).toBe(true);
    expect(matchesDocsSourceFilter(metadata, { category: 'go' })).toBe(true);
    expect(matchesDocsSourceFilter(metadata, { language: 'go', kind: 'book' })).toBe(true);
    expect(matchesDocsSourceFilter(metadata, { authority: 'official' })).toBe(false);
    expect(matchesDocsSourceFilter(metadata, { tags: ['book'] })).toBe(true);
    expect(matchesDocsSourceFilter(metadata, { sourceId: 'go-docs' })).toBe(false);
  });

  it('matches TypeScript ecosystem sources through normalized language metadata', () => {
    for (const sourcePath of [
      'tanstack/router.md',
      'typescript-docs/handbook/intro.md',
      'zod-docs/basics.md',
    ]) {
      expect(matchesDocsSourceFilter({ sourcePath }, { language: 'typescript' })).toBe(true);
      expect(normalizeDocsSourceMetadata({ sourcePath })).toMatchObject({
        language: 'typescript',
        lang: 'ts',
      });
    }
  });

  it('matches source filters through registered source aliases', () => {
    expect(
      matchesDocsSourceFilter(
        { sourcePath: 'components/installation.md' },
        { sourceId: 'tailwindcss-docs' }
      )
    ).toBe(true);
    expect(
      matchesDocsSourceFilter(
        { sourcePath: 'tanstack/router.md' },
        { sourceId: 'tanstack-router-docs' }
      )
    ).toBe(true);
    expect(
      matchesDocsSourceFilter(
        { sourcePath: 'components/installation.md' },
        { sourceId: 'tanstack-router-docs' }
      )
    ).toBe(false);
    expect(
      matchesDocsSourceFilter(
        { sourcePath: 'tanstack/router.md' },
        { sourceIds: ['tailwindcss-docs', 'tanstack-router-docs'] }
      )
    ).toBe(true);
  });

  it('derives shared source categories and lists normalized registry entries', () => {
    expect(deriveDocsSourceCategoryNames({ language: 'typescript' })).toEqual(
      expect.arrayContaining(['tanstack', 'zod', 'typescript'])
    );
    expect(listDocsSources()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'typescript-docs',
          language: 'typescript',
          lang: 'ts',
        }),
      ])
    );
  });
});
