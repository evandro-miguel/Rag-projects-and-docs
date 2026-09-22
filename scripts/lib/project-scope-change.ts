import { normalizeProjectIncludeRoots } from '../../lib/shared/project-registry.js';

export type ProjectScopeMutationKind = 'register' | 'set' | 'add' | 'remove';

export interface ProjectScopeChangeInput {
  currentRoots?: string[];
  includeRoots?: string[];
  addRoots?: string[];
  removeRoots?: string[];
}

export interface ProjectScopeChangePlan {
  currentRoots: string[];
  nextRoots: string[];
  addedRoots: string[];
  removedRoots: string[];
  mutationKind: ProjectScopeMutationKind;
}

function normalizeInputRoots(roots?: string[]): string[] {
  return normalizeProjectIncludeRoots(roots);
}

export function planProjectScopeChange(input: ProjectScopeChangeInput): ProjectScopeChangePlan {
  const currentRoots = input.currentRoots ? normalizeInputRoots(input.currentRoots) : [];
  const exactRoots = input.includeRoots ? normalizeInputRoots(input.includeRoots) : undefined;
  const addRoots = input.addRoots ? normalizeInputRoots(input.addRoots) : [];
  const removeRoots = input.removeRoots ? normalizeInputRoots(input.removeRoots) : [];

  if (exactRoots && (addRoots.length > 0 || removeRoots.length > 0)) {
    throw new Error('Use either --include or --add-include/--remove-include, not both');
  }

  if (!exactRoots && addRoots.length === 0 && removeRoots.length === 0) {
    throw new Error('Provide --include, --add-include, or --remove-include');
  }

  const nextRoots = exactRoots ?? currentRoots.slice();
  if (!exactRoots) {
    for (const root of addRoots) {
      if (!nextRoots.includes(root)) {
        nextRoots.push(root);
      }
    }

    if (removeRoots.length > 0) {
      for (const root of removeRoots) {
        const index = nextRoots.indexOf(root);
        if (index !== -1) {
          nextRoots.splice(index, 1);
        }
      }
    }
  }

  const nextNormalized = normalizeInputRoots(nextRoots);
  const currentSet = new Set(currentRoots);
  const nextSet = new Set(nextNormalized);
  const addedRoots = nextNormalized.filter((root) => !currentSet.has(root));
  const removedRoots = currentRoots.filter((root) => !nextSet.has(root));

  return {
    currentRoots,
    nextRoots: nextNormalized,
    addedRoots,
    removedRoots,
    mutationKind: exactRoots
      ? currentRoots.length === 0
        ? 'register'
        : 'set'
      : addRoots.length > 0 && removeRoots.length > 0
        ? 'set'
        : addRoots.length > 0
          ? 'add'
          : 'remove',
  };
}

export function formatProjectScopeChangeSummary(plan: ProjectScopeChangePlan): string {
  const lines = [
    `Current roots: ${plan.currentRoots.length > 0 ? plan.currentRoots.join(', ') : 'none'}`,
    `Next roots: ${plan.nextRoots.join(', ')}`,
  ];

  if (plan.addedRoots.length > 0) {
    lines.push(`Added: ${plan.addedRoots.join(', ')}`);
  }
  if (plan.removedRoots.length > 0) {
    lines.push(`Removed: ${plan.removedRoots.join(', ')}`);
  }

  return lines.join('\n');
}
