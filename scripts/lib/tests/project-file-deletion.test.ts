import { describe, expect, it, vi } from 'vitest';
import { deleteIndexedProjectFile } from '../project-file-deletion.js';

describe('project-file-deletion', () => {
  it('returns without purging when the file is already absent or deleted', async () => {
    const mutation = vi.fn().mockResolvedValue({ deleted: false });

    const result = await deleteIndexedProjectFile(
      { mutation },
      {
        projectId: 'project_1' as any,
        sourcePath: 'src/missing.ts',
      }
    );

    expect(result).toEqual({
      deleted: false,
      fileId: undefined,
      purgePasses: 0,
      deletedChunks: 0,
      deletedEmbeddings: 0,
      deletedSymbols: 0,
      deletedEdges: 0,
    });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledWith('project/ingest:deleteProjectFileByPath', {
      projectId: 'project_1',
      sourcePath: 'src/missing.ts',
    });
  });

  it('purges artifacts until the backend reports completion', async () => {
    const mutation = vi
      .fn()
      .mockResolvedValueOnce({ deleted: true, fileId: 'file_1' })
      .mockResolvedValueOnce({
        deletedChunks: 2,
        deletedEmbeddings: 2,
        deletedSymbols: 1,
        deletedEdges: 0,
        done: false,
      })
      .mockResolvedValueOnce({
        deletedChunks: 1,
        deletedEmbeddings: 0,
        deletedSymbols: 1,
        deletedEdges: 3,
        done: true,
      });

    const result = await deleteIndexedProjectFile(
      { mutation },
      {
        projectId: 'project_1' as any,
        sourcePath: 'src/removed.ts',
      }
    );

    expect(result).toEqual({
      deleted: true,
      fileId: 'file_1',
      purgePasses: 2,
      deletedChunks: 3,
      deletedEmbeddings: 2,
      deletedSymbols: 2,
      deletedEdges: 3,
    });
    expect(mutation).toHaveBeenCalledTimes(3);
    expect(mutation).toHaveBeenNthCalledWith(1, 'project/ingest:deleteProjectFileByPath', {
      projectId: 'project_1',
      sourcePath: 'src/removed.ts',
    });
    expect(mutation).toHaveBeenNthCalledWith(2, 'project/ingest:purgeProjectFileArtifactsBatch', {
      projectId: 'project_1',
      fileId: 'file_1',
    });
    expect(mutation).toHaveBeenNthCalledWith(3, 'project/ingest:purgeProjectFileArtifactsBatch', {
      projectId: 'project_1',
      fileId: 'file_1',
    });
  });
});
