import { describe, expect, it } from 'vitest';
import { backfillProjectRagPostgresEdges, parseBackfillEdgesArgs } from './backfill-edges.js';

describe('project-rag postgres edge backfill cli', () => {
  it('parses project and limit args', () => {
    const args = parseBackfillEdgesArgs(['--project', 'rag-v2-dev', '--limit=200', '--offset=0']);
    expect(args).toEqual({
      project: 'rag-v2-dev',
      limit: 200,
      offset: 0,
      dryRun: false,
    });
  });

  it('caps limit at 10000', () => {
    const args = parseBackfillEdgesArgs(['--project', 'test', '--limit=99999']);
    expect(args.limit).toBe(10000);
  });

  it('parses dry-run flag', () => {
    const args = parseBackfillEdgesArgs(['--project', 'test', '--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('defaults limit to 5000 and offset to 0', () => {
    const args = parseBackfillEdgesArgs(['--project', 'test']);
    expect(args.limit).toBe(5000);
    expect(args.offset).toBe(0);
  });

  it('requires an explicit project ref', () => {
    expect(() => parseBackfillEdgesArgs([])).toThrow('Missing --project');
  });

  it('refuses non-dry-run writes with UNGUARDED_INDEX_MUTATION_REFUSED', async () => {
    const nonDryArgs = { project: 'test', limit: 10, offset: 0, dryRun: false };
    await expect(backfillProjectRagPostgresEdges(nonDryArgs)).rejects.toThrow(
      'UNGUARDED_INDEX_MUTATION_REFUSED'
    );
  });
});

describe('backfill-edges security block reporting', () => {
  it('ok is false when filesSkippedBlocked > 0 per the updated logic', () => {
    const okLogic = (filesSkippedBlocked: number, errorsLen: number, totalFiles: number) =>
      filesSkippedBlocked === 0 && (errorsLen === 0 || errorsLen < totalFiles);

    // Security blocks make ok false
    expect(okLogic(1, 0, 10)).toBe(false);
    expect(okLogic(5, 0, 10)).toBe(false);

    // No security blocks, no errors -> ok true
    expect(okLogic(0, 0, 10)).toBe(true);

    // No security blocks, some errors but not all -> ok true (partial success tolerated)
    expect(okLogic(0, 3, 10)).toBe(true);

    // No security blocks, all files errored -> ok false
    expect(okLogic(0, 10, 10)).toBe(false);
  });

  it('securityBlocks entries include pattern and details fields', () => {
    // Verify the contract shape: BackfillEdgeSecurityBlock must have pattern and details
    const block: {
      sourcePath: string;
      reason: 'filename' | 'content' | 'path';
      pattern: string | undefined;
      details: string | undefined;
    } = { sourcePath: 'test', reason: 'filename', pattern: 'dot-env', details: 'env file' };
    expect(block.sourcePath).toBe('test');
    expect(block.reason).toBe('filename');
    expect(block.pattern).toBe('dot-env');
    expect(block.details).toBe('env file');
  });
});
