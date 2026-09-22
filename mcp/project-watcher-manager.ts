import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProjectWatcherStatus {
  status: 'started' | 'already_running' | 'failed' | 'skipped';
  pid?: number;
  rootPath: string;
  slug?: string;
  logPath?: string;
  metadataPath?: string;
  reason?: string;
}

export type ProjectWatcherSessionIntent = 'read_only' | 'edit_session';

function normalizeRootPath(rootPath: string): string {
  return resolve(rootPath);
}

export function stopSessionOwnedProjectWatchers(): void {}

export async function ensureProjectWatcher(args: {
  rootPath: string;
  slug?: string;
  enabled?: boolean;
  sessionIntent?: ProjectWatcherSessionIntent;
}): Promise<ProjectWatcherStatus> {
  const rootPath = normalizeRootPath(args.rootPath);
  const slug = args.slug;
  const sessionIntent = args.sessionIntent ?? 'read_only';

  if (args.enabled === false) {
    return {
      status: 'skipped',
      rootPath,
      slug,
      reason: 'watcher_disabled',
    };
  }

  if (!existsSync(rootPath)) {
    return {
      status: 'skipped',
      rootPath,
      slug,
      reason: 'watcher_root_missing',
    };
  }

  if (process.env.RAG_PROJECT_WATCHER_ENABLED === 'false') {
    return {
      status: 'skipped',
      rootPath,
      slug,
      reason: 'watcher_disabled_by_env',
    };
  }

  if (sessionIntent !== 'edit_session') {
    return {
      status: 'skipped',
      rootPath,
      slug,
      reason: 'watcher_edit_session_required',
    };
  }

  if (process.env.VITEST && process.env.RAG_PROJECT_WATCHER_FORCE_AUTOSTART !== 'true') {
    return {
      status: 'skipped',
      rootPath,
      slug,
      reason: 'watcher_disabled_in_vitest',
    };
  }

  return {
    status: 'skipped',
    rootPath,
    slug,
    reason: 'watcher_removed',
  };
}
