import { describe, expect, it } from 'vitest';
import { formatProjectScopeChangeSummary, planProjectScopeChange } from './project-scope-change.js';

describe('project-scope-change', () => {
  it('computes add and remove diffs against the current roots', () => {
    const plan = planProjectScopeChange({
      currentRoots: ['src', 'docs'],
      addRoots: ['packages/app'],
      removeRoots: ['docs'],
    });

    expect(plan.currentRoots).toEqual(['src', 'docs']);
    expect(plan.nextRoots).toEqual(['src', 'packages/app']);
    expect(plan.addedRoots).toEqual(['packages/app']);
    expect(plan.removedRoots).toEqual(['docs']);
    expect(plan.mutationKind).toBe('set');
  });

  it('supports explicit replacement of roots', () => {
    const plan = planProjectScopeChange({
      currentRoots: ['src', 'docs'],
      includeRoots: ['src', 'packages/app'],
    });

    expect(plan.nextRoots).toEqual(['src', 'packages/app']);
    expect(plan.mutationKind).toBe('set');
  });

  it('rejects mixed exact and incremental scope modes', () => {
    expect(() =>
      planProjectScopeChange({
        currentRoots: ['src'],
        includeRoots: ['src'],
        addRoots: ['docs'],
      })
    ).toThrow('Use either --include or --add-include/--remove-include, not both');
  });

  it('formats a readable change summary', () => {
    const summary = formatProjectScopeChangeSummary({
      currentRoots: ['src'],
      nextRoots: ['src', 'docs'],
      addedRoots: ['docs'],
      removedRoots: [],
      mutationKind: 'add',
    });

    expect(summary).toContain('Current roots: src');
    expect(summary).toContain('Next roots: src, docs');
    expect(summary).toContain('Added: docs');
  });
});
