import {
  type ProjectRegistryLike,
  resolveProjectRegistryLifecycle,
} from './project-registry-lifecycle.js';

export interface ProjectRegistryMigrationCandidate extends ProjectRegistryLike {
  _id: string;
  slug: string;
  includeRoots?: string[];
  gitRemote?: string;
  defaultBranch?: string;
  activeBranch?: string;
  worktreeName?: string;
  ignoreRules?: string[];
  status?: string;
  syncMode?: string;
  owner?: string;
  expiresAt?: number;
  lastUsedAt?: number;
  sensitivityProfile?: {
    level: 'public' | 'internal' | 'confidential' | 'restricted';
    allowGenerated: boolean;
    allowBinaries: boolean;
  };
}

export interface ProjectRegistryMigrationPlanEntry {
  projectId: string;
  slug: string;
  rootPath: string;
  origin: string;
  ephemeral: boolean;
  needsBackfill: boolean;
  isExpiredEphemeral: boolean;
}

export interface ProjectRegistryMigrationPlan {
  entries: ProjectRegistryMigrationPlanEntry[];
  backfillCount: number;
  expiredCount: number;
}

export function planProjectRegistryMigration(
  projects: ProjectRegistryMigrationCandidate[],
  now = Date.now()
): ProjectRegistryMigrationPlan {
  const entries = projects.map((project) => {
    const lifecycle = resolveProjectRegistryLifecycle(project);
    const needsBackfill =
      project.origin !== lifecycle.origin || project.ephemeral !== lifecycle.ephemeral;
    const isExpiredEphemeral =
      lifecycle.ephemeral && project.expiresAt !== undefined && project.expiresAt <= now;

    return {
      projectId: project._id,
      slug: project.slug,
      rootPath: project.rootPath,
      origin: lifecycle.origin,
      ephemeral: lifecycle.ephemeral,
      needsBackfill,
      isExpiredEphemeral,
    };
  });

  return {
    entries,
    backfillCount: entries.filter((entry) => entry.needsBackfill).length,
    expiredCount: entries.filter((entry) => entry.isExpiredEphemeral).length,
  };
}
