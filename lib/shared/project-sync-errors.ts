export interface ProjectSyncErrorRecord {
  file?: string;
  error: string;
}

export const MAX_SYNC_RUN_ERRORS_STORED = 50;
export const MAX_SYNC_RUN_ERROR_MESSAGE_LENGTH = 500;
export const MAX_SYNC_RUN_ERROR_FILE_LENGTH = 200;

export function truncateProjectSyncRunErrors(
  errors?: ProjectSyncErrorRecord[]
): ProjectSyncErrorRecord[] | undefined {
  if (!errors || errors.length === 0) {
    return undefined;
  }

  const truncated = errors.slice(0, MAX_SYNC_RUN_ERRORS_STORED).map((entry) => ({
    file: entry.file?.slice(0, MAX_SYNC_RUN_ERROR_FILE_LENGTH),
    error: entry.error.slice(0, MAX_SYNC_RUN_ERROR_MESSAGE_LENGTH),
  }));

  if (errors.length > MAX_SYNC_RUN_ERRORS_STORED) {
    truncated.push({
      file: undefined,
      error: `Omitted ${errors.length - MAX_SYNC_RUN_ERRORS_STORED} additional errors from persisted sync run payload.`,
    });
  }

  return truncated;
}
