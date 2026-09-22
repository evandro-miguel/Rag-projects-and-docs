import { describe, expect, it } from 'vitest';
import { getProjectFixture } from './fixtures.js';
import { validateProjectFixtureManifest } from './manifest-validation.js';
import { buildExecutionPlan } from './run-project-rag-eval.js';

describe('project rag verification compatibility', () => {
  it('verifies secret fixture inventory and blocked paths', () => {
    const fixture = getProjectFixture('fixture-secret-noise');
    if (!fixture) throw new Error('fixture-secret-noise missing');

    const result = validateProjectFixtureManifest(fixture);

    expect(result.valid).toBe(true);
    expect(result.missingIndexedPaths).toEqual([]);
    expect(result.missingBlockedPaths).toEqual([]);
  });

  it('keeps drift fixture db actions explicit for future agents', () => {
    const plan = buildExecutionPlan('fixture-branch-drift');
    expect(plan).toHaveLength(1);
    expect(plan[0]?.dbActions.some((action) => action.phase === 'incremental_sync')).toBe(true);
    expect(plan[0]?.experiments.length).toBeGreaterThan(0);
  });
});
