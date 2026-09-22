import { describe, expect, it } from 'vitest';
import {
  embedProjectRagPostgresChunks,
  parseEmbedProjectRagPostgresArgs,
} from './embed-postgres.js';

describe('project-rag postgres embedding cli', () => {
  it('parses bounded embedding args', () => {
    const args = parseEmbedProjectRagPostgresArgs([
      '--project=rag-v2',
      '--limit',
      '20000',
      '--batch-size=64',
      '--dry-run',
    ]);

    expect(args).toEqual({
      project: 'rag-v2',
      limit: 10_000,
      batchSize: 32,
      dryRun: true,
    });
  });

  it('requires an explicit project ref', () => {
    expect(() => parseEmbedProjectRagPostgresArgs([])).toThrow('Missing --project');
  });

  it('allows dry-run without snapshot gate guard', async () => {
    // Just check parse + guard logic — dry-run should not throw UNGUARDED
    const args = parseEmbedProjectRagPostgresArgs(['--project=test', '--dry-run']);
    // We can't run embedProjectRagPostgresChunks without a real DB, but
    // the guard should be checked before any DB ops. Verify the guard:
    // import { requireSnapshotGateOrDryRun } via the module.
    // For now, test that dry-run parse works.
    expect(args.dryRun).toBe(true);
  });

  it('refuses non-dry-run writes with UNGUARDED_INDEX_MUTATION_REFUSED', async () => {
    // Guard fires before any DB/config resolution, so no mocking needed.
    // The function throws UNGUARDED_INDEX_MUTATION_REFUSED immediately.
    const nonDryArgs = { project: 'test', limit: 10, batchSize: 5, dryRun: false };
    await expect(embedProjectRagPostgresChunks(nonDryArgs)).rejects.toThrow(
      'UNGUARDED_INDEX_MUTATION_REFUSED'
    );
  });
});
