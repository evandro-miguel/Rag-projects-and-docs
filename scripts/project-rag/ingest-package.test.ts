import { describe, expect, it, vi } from 'vitest';
import { parsePackageProjectIngestArgs } from './ingest-package.js';

// Use vi.mock with inline vi.fn() to avoid TDZ issues with hoisted factory
vi.mock('./ingest-postgres.js', () => ({
  ingestProjectRagPostgres: vi.fn(),
}));

import { runPackageProjectIngestCli } from './ingest-package.js';
import { ingestProjectRagPostgres } from './ingest-postgres.js';

const mockIngest = ingestProjectRagPostgres as ReturnType<typeof vi.fn>;

describe('project-rag package ingest wrapper', () => {
  it('requires explicit root and project identity', () => {
    expect(
      parsePackageProjectIngestArgs([
        '--project',
        'demo',
        '--root',
        '/tmp/repo',
        '--include',
        'src, docs',
        '--force',
      ])
    ).toEqual({
      projectSlug: 'demo',
      rootPath: '/tmp/repo',
      includeRoots: ['src', 'docs'],
      force: true,
      maxFiles: undefined,
      concurrency: undefined,
    });

    expect(() => parsePackageProjectIngestArgs(['--include', 'src'])).toThrow(
      'Missing project identity'
    );
    expect(() => parsePackageProjectIngestArgs(['--project', 'demo', '--include', 'src'])).toThrow(
      'Missing project root'
    );
  });

  it('rejects missing snapshotGate by throwing', async () => {
    mockIngest.mockResolvedValueOnce({
      projectId: 'test-project',
      slug: 'test-project',
      postgresId: 42,
      finalStatus: 'completed',
      stats: {
        filesScanned: 1,
        filesSelected: 1,
        filesIndexed: 1,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 2,
        embeddingsCreated: 2,
        errors: [],
      },
      // snapshotGate is intentionally omitted (undefined)
    });

    await expect(
      runPackageProjectIngestCli([
        '--project',
        'test-project',
        '--root',
        '/tmp/test',
        '--include',
        'src',
      ])
    ).rejects.toThrow(/snapshot gate is missing/);
  });

  it('rejects snapshot gate refusal by throwing', async () => {
    mockIngest.mockResolvedValueOnce({
      projectId: 'test-project',
      slug: 'test-project',
      postgresId: 42,
      finalStatus: 'partial',
      stats: {
        filesScanned: 500,
        filesSelected: 0,
        filesIndexed: 0,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 0,
        embeddingsCreated: 0,
        errors: [],
      },
      snapshotGate: {
        snapshotUuid: '00000000-0000-0000-0000-000000000099',
        status: 'REVIEW_REQUIRED',
        thresholdResult: 'delta_500: total delta 500 >= 500 file threshold',
        preflightSummary: {
          addsCount: 300,
          updatesCount: 150,
          deletesCount: 50,
          eligibleCount: 500,
          trackedCount: 100,
          totalDelta: 500,
          blockedFindingCategories: '',
        },
      },
    });

    await expect(
      runPackageProjectIngestCli([
        '--project',
        'test-project',
        '--root',
        '/tmp/test',
        '--include',
        'src',
      ])
    ).rejects.toThrow(/snapshot gate status is REVIEW_REQUIRED/);
  });

  it('reports bounded redacted per-file errors for a failed snapshot', async () => {
    mockIngest.mockResolvedValueOnce({
      projectId: 'test-project',
      slug: 'test-project',
      postgresId: 42,
      finalStatus: 'partial',
      stats: {
        filesScanned: 2,
        filesSelected: 2,
        filesIndexed: 1,
        filesBlocked: 0,
        filesDeleted: 0,
        chunksCreated: 1,
        embeddingsCreated: 1,
        errors: [
          { file: 'src/broken.ts', error: 'api_key=abcdefghijklmnop parse failure' },
          { file: 'src/second.ts', error: 'second failure' },
          { file: 'src/third.ts', error: 'third failure' },
          { file: 'src/fourth.ts', error: 'must be omitted' },
        ],
      },
      snapshotGate: {
        snapshotUuid: '00000000-0000-0000-0000-000000000100',
        status: 'FAILED',
        thresholdResult: 'partial_ingest_not_consumed',
        preflightSummary: {
          addsCount: 2,
          updatesCount: 0,
          deletesCount: 0,
          eligibleCount: 2,
          trackedCount: 0,
          totalDelta: 2,
          blockedFindingCategories: '',
        },
      },
    });

    const result = runPackageProjectIngestCli([
      '--project',
      'test-project',
      '--root',
      '/tmp/test',
      '--include',
      'src',
    ]);
    await expect(result).rejects.toThrow(
      /src\/broken\.ts: api_key=\[REDACTED:generic-api-key\] parse failure/
    );
    await expect(result).rejects.toThrow(/src\/third\.ts: third failure/);
    await expect(result).rejects.not.toThrow(/src\/fourth\.ts/);
  });

  it('rejects package-only gaps clearly', () => {
    expect(() => parsePackageProjectIngestArgs(['--project', 'demo', '--include', 'src'])).toThrow(
      'Missing project root'
    );
    expect(() =>
      parsePackageProjectIngestArgs(['--project', 'demo', '--root', '/tmp/repo', '--dry-run'])
    ).toThrow('does not implement --dry-run yet');
  });
});
