import { describe, expect, it } from 'vitest';
import { parseSearchProjectRagPostgresArgs } from './search-postgres.js';

describe('project-rag postgres search cli', () => {
  it('parses project, limit, and positional query', () => {
    const args = parseSearchProjectRagPostgresArgs([
      '--project',
      'rag-v2',
      '--limit=100',
      'project',
      'search',
    ]);

    expect(args).toEqual({
      project: 'rag-v2',
      query: 'project search',
      limit: 50,
    });
  });

  it('requires query text', () => {
    expect(() => parseSearchProjectRagPostgresArgs(['--project', 'rag-v2'])).toThrow(
      'Missing search query'
    );
  });
});
