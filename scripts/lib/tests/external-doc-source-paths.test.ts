import { describe, expect, it } from 'vitest';
import {
  dedupeExternalDocResults,
  filterExternalDocResults,
  isExternalDocSourcePath,
  normalizeExternalDocCanonicalKey,
} from '../external-doc-source-paths.js';

describe('external-doc-source-paths', () => {
  it('recognizes canonical and artifact external doc paths', () => {
    expect(isExternalDocSourcePath('react-docs/reference/react/useEffect.md')).toBe(true);
    expect(isExternalDocSourcePath('bun-docs/runtime/http/server.mdx')).toBe(true);
    expect(isExternalDocSourcePath('tailwindcss-docs/utility-first.mdx')).toBe(true);
    expect(isExternalDocSourcePath('tanstack-router-docs/overview.md')).toBe(true);
    expect(isExternalDocSourcePath('zod-docs/index.mdx')).toBe(true);
    expect(isExternalDocSourcePath('python-docs/tutorial/index.rst')).toBe(true);
    expect(isExternalDocSourcePath('go-books/effective-go.md')).toBe(true);
    expect(
      isExternalDocSourcePath('ingest/processed/external/react-docs/reference/react/useEffect.md')
    ).toBe(true);
    expect(isExternalDocSourcePath('ingest/source/external/go-books/effective-go.md')).toBe(true);
    expect(isExternalDocSourcePath('ingest/processed/external/unknown-docs/page.md')).toBe(false);
    expect(isExternalDocSourcePath('AGENTS.md')).toBe(false);
  });

  it('normalizes artifact paths to the canonical doc key', () => {
    expect(
      normalizeExternalDocCanonicalKey(
        'ingest/processed/external/react-docs/reference/react/useEffect.md'
      )
    ).toBe('react-docs/reference/react/useeffect');
    expect(normalizeExternalDocCanonicalKey('bun-docs/runtime/http/server.mdx')).toBe(
      'bun-docs/runtime/http/server'
    );
    expect(
      normalizeExternalDocCanonicalKey('ingest/source/external/go-books/effective-go.md')
    ).toBe('go-books/effective-go');
    expect(
      normalizeExternalDocCanonicalKey('ingest/source/external/python-docs/tutorial/index.rst')
    ).toBe('python-docs/tutorial/index');
  });

  it('filters non-external results and prefers canonical docs over artifacts', () => {
    const results = [
      {
        score: 12.2,
        document: { sourcePath: 'react-docs/reference/react/useEffect.md' },
      },
      {
        score: 10.2,
        document: {
          sourcePath: 'ingest/source/external/react-docs/reference/react/useEffect.md',
        },
      },
      {
        score: 9.0,
        document: {
          sourcePath: 'ingest/processed/external/react-docs/reference/react/useEffect.md',
        },
      },
      {
        score: 4.7,
        document: { sourcePath: 'AGENTS.md' },
      },
    ];

    const externalOnly = filterExternalDocResults(results);
    expect(externalOnly).toHaveLength(3);

    const deduped = dedupeExternalDocResults(externalOnly);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.document?.sourcePath).toBe('react-docs/reference/react/useEffect.md');
  });
});
