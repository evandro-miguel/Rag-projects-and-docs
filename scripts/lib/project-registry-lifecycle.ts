const EPHEMERAL_NAME_PATTERN = /(^|[-_/])(fixture|test|e2e|benchmark|bench|smoke)([-_/]|$)/i;
const EPHEMERAL_ROOT_PATTERN = /\/scripts\/eval\/project-rag\/repos\/fixture-/i;

export type ProjectRegistryOrigin = 'manual' | 'fixture' | 'test' | 'benchmark' | 'watch';

export interface ProjectRegistryLifecycle {
  origin: ProjectRegistryOrigin;
  ephemeral: boolean;
}

export interface ProjectRegistryLike {
  name: string;
  rootPath: string;
  worktreeName?: string;
  origin?: ProjectRegistryOrigin;
  ephemeral?: boolean;
}

export function inferProjectRegistryOrigin(
  name: string,
  rootPath: string,
  worktreeName?: string
): ProjectRegistryOrigin {
  const haystack = [name, rootPath, worktreeName ?? ''].join(' ').toLowerCase();

  if (EPHEMERAL_ROOT_PATTERN.test(rootPath) || haystack.includes('fixture')) {
    return 'fixture';
  }

  if (haystack.includes('benchmark') || haystack.includes('bench')) {
    return 'benchmark';
  }

  if (haystack.includes('watch')) {
    return 'watch';
  }

  if (EPHEMERAL_NAME_PATTERN.test(haystack)) {
    return 'test';
  }

  return 'manual';
}

export function resolveProjectRegistryLifecycle(
  project: ProjectRegistryLike
): ProjectRegistryLifecycle {
  const origin =
    project.origin ??
    inferProjectRegistryOrigin(project.name, project.rootPath, project.worktreeName);
  const ephemeral = project.ephemeral ?? origin !== 'manual';

  return { origin, ephemeral };
}
