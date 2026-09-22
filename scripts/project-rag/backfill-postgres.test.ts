import { describe, expect, it } from 'vitest';
import { parseBackfillProjectRagPostgresArgs } from './backfill-postgres.js';

describe('project-rag postgres backfill cli', () => {
  it('parses bounded one-project backfill args', () => {
    const args = parseBackfillProjectRagPostgresArgs([
      '--project',
      'rag-v2',
      '--limit=10000',
      '--dry-run',
    ]);

    expect(args).toEqual({
      project: 'rag-v2',
      limit: 5000,
      dryRun: true,
    });
  });

  it('requires an explicit project ref', () => {
    expect(() => parseBackfillProjectRagPostgresArgs([])).toThrow('Missing --project');
  });
});
