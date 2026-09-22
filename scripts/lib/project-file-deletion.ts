const MAX_PURGE_PASSES = 10_000;
const DELETE_PROJECT_FILE_BY_PATH = 'project/ingest:deleteProjectFileByPath';
const PURGE_PROJECT_FILE_ARTIFACTS_BATCH = 'project/ingest:purgeProjectFileArtifactsBatch';

type ProjectRegistryId = string;
type ProjectFileId = string;

interface DeleteProjectFileByPathResult {
  deleted: boolean;
  fileId?: ProjectFileId;
}

interface PurgeProjectFileArtifactsBatchResult {
  deletedChunks: number;
  deletedEmbeddings: number;
  deletedSymbols: number;
  deletedEdges: number;
  done: boolean;
}

interface ProjectMutationClient {
  mutation(
    reference: string,
    args:
      | { projectId: ProjectRegistryId; sourcePath: string }
      | { projectId: ProjectRegistryId; fileId: ProjectFileId }
  ): Promise<unknown>;
}

export interface DeleteIndexedProjectFileArgs {
  projectId: ProjectRegistryId;
  sourcePath: string;
}

export interface DeleteIndexedProjectFileResult {
  deleted: boolean;
  fileId?: ProjectFileId;
  purgePasses: number;
  deletedChunks: number;
  deletedEmbeddings: number;
  deletedSymbols: number;
  deletedEdges: number;
}

/**
 * Delete a project file and fully purge its project-scoped artifacts.
 *
 * The underlying purge mutation is intentionally batched to stay within
 * transaction limits, so callers should use this helper instead of only
 * toggling the file status to `deleted`.
 */
export async function deleteIndexedProjectFile(
  client: ProjectMutationClient,
  args: DeleteIndexedProjectFileArgs
): Promise<DeleteIndexedProjectFileResult> {
  const deleteResult = (await client.mutation(DELETE_PROJECT_FILE_BY_PATH, {
    projectId: args.projectId,
    sourcePath: args.sourcePath,
  })) as DeleteProjectFileByPathResult;

  if (!deleteResult.deleted || !deleteResult.fileId) {
    return {
      deleted: false,
      fileId: deleteResult.fileId,
      purgePasses: 0,
      deletedChunks: 0,
      deletedEmbeddings: 0,
      deletedSymbols: 0,
      deletedEdges: 0,
    };
  }

  let purgePasses = 0;
  let deletedChunks = 0;
  let deletedEmbeddings = 0;
  let deletedSymbols = 0;
  let deletedEdges = 0;

  while (true) {
    purgePasses++;
    if (purgePasses > MAX_PURGE_PASSES) {
      throw new Error(
        `Artifact purge exceeded ${MAX_PURGE_PASSES} passes for ${args.sourcePath} in project ${args.projectId}`
      );
    }

    const purgeResult = (await client.mutation(PURGE_PROJECT_FILE_ARTIFACTS_BATCH, {
      projectId: args.projectId,
      fileId: deleteResult.fileId,
    })) as PurgeProjectFileArtifactsBatchResult;

    deletedChunks += purgeResult.deletedChunks;
    deletedEmbeddings += purgeResult.deletedEmbeddings;
    deletedSymbols += purgeResult.deletedSymbols;
    deletedEdges += purgeResult.deletedEdges;

    if (purgeResult.done) {
      return {
        deleted: true,
        fileId: deleteResult.fileId,
        purgePasses,
        deletedChunks,
        deletedEmbeddings,
        deletedSymbols,
        deletedEdges,
      };
    }
  }
}
