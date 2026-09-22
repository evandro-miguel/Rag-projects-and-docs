import { describe, expect, it } from 'vitest';
import { buildSearchContext } from './detect-lang';

describe('buildSearchContext', () => {
  it('detects typscript files', () => {
    expect(buildSearchContext('src/app/main.ts')).toEqual({ lang: 'ts', ecosystem: 'node' });
    expect(buildSearchContext('component.tsx')).toEqual({ lang: 'ts', ecosystem: 'node' });
  });

  it('detects python files', () => {
    expect(buildSearchContext('api/server.py')).toEqual({ lang: 'py', ecosystem: 'python' });
  });

  it('detects go files', () => {
    expect(buildSearchContext('main.go')).toEqual({ lang: 'go', ecosystem: 'go' });
  });

  it('returns empty for unknown extensions', () => {
    expect(buildSearchContext('README.md')).toEqual({});
    expect(buildSearchContext('styles.css')).toEqual({});
    expect(buildSearchContext('Makefile')).toEqual({});
  });

  it('returns empty for no file', () => {
    expect(buildSearchContext('')).toEqual({});
  });
});
