import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProjectEvalIsolationRegistrationArgs, PROJECT_RAG_FIXTURES } from './fixtures.js';
import { resolveFixtureRoot, validateProjectFixtureManifest } from './manifest-validation.js';

describe('project-rag fixtures', () => {
  it('have unique fixture ids and variant ids', () => {
    const fixtureIds = new Set<string>();

    for (const fixture of PROJECT_RAG_FIXTURES) {
      expect(fixtureIds.has(fixture.id)).toBe(false);
      fixtureIds.add(fixture.id);

      const variantIds = fixture.variants.map((variant) => variant.id);
      expect(new Set(variantIds).size).toBe(variantIds.length);
    }
  });

  it('validate fixture manifests against on-disk repos', () => {
    for (const fixture of PROJECT_RAG_FIXTURES) {
      const report = validateProjectFixtureManifest(fixture);
      expect(report.valid).toBe(true);
      expect(report.missingIndexedPaths).toEqual([]);
      expect(report.missingBlockedPaths).toEqual([]);
      expect(report.missingDegradedPaths).toEqual([]);
      expect(report.missingExpectedTargetPaths).toEqual([]);
      expect(report.missingForbiddenTargetPaths).toEqual([]);
      expect(report.untrackedFiles).toEqual([]);
    }
  });

  it('keeps target line ranges within file bounds', () => {
    for (const fixture of PROJECT_RAG_FIXTURES) {
      const repoRoot = resolveFixtureRoot(fixture);

      for (const scenario of fixture.scenarios) {
        for (const target of scenario.expectedTargets) {
          if (!target.lineRange) continue;

          const fileContent = readFileSync(join(repoRoot, target.path), 'utf-8');
          const lineCount = fileContent.split('\n').length;

          expect(target.lineRange.start).toBeGreaterThanOrEqual(1);
          expect(target.lineRange.end).toBeGreaterThanOrEqual(target.lineRange.start);
          expect(target.lineRange.end).toBeLessThanOrEqual(lineCount);
        }
      }
    }
  });

  it('keeps experiment references aligned with declared variants', () => {
    for (const fixture of PROJECT_RAG_FIXTURES) {
      const variantIds = new Set(fixture.variants.map((variant) => variant.id));
      for (const experiment of fixture.experiments) {
        expect(variantIds.has(experiment.baselineVariantId)).toBe(true);
        expect(variantIds.has(experiment.candidateVariantId)).toBe(true);
      }
    }
  });

  it('builds ephemeral registration metadata without dropping existing registry fields', () => {
    const registration = buildProjectEvalIsolationRegistrationArgs({
      name: 'fixture-ts-service',
      rootPath: '/tmp/fixture-ts-service',
      includeRoots: ['src', 'docs'],
      origin: 'benchmark',
      owner: 'eval:fixture-ts-service',
      now: 1_700_000_000_000,
      ttlMs: 3_600_000,
      existing: {
        gitRemote: 'https://github.com/example/repo.git',
        defaultBranch: 'main',
        activeBranch: 'main',
        worktreeName: 'fixture-ts-service',
        ignoreRules: ['dist/**'],
        status: 'active',
        syncMode: 'diff',
        sensitivityProfile: {
          level: 'internal',
          allowGenerated: false,
          allowBinaries: false,
        },
      },
    });

    expect(registration).toMatchObject({
      name: 'fixture-ts-service',
      rootPath: '/tmp/fixture-ts-service',
      includeRoots: ['src', 'docs'],
      origin: 'benchmark',
      ephemeral: true,
      owner: 'eval:fixture-ts-service',
      expiresAt: 1_700_003_600_000,
      lastUsedAt: 1_700_000_000_000,
      gitRemote: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      activeBranch: 'main',
      worktreeName: 'fixture-ts-service',
      ignoreRules: ['dist/**'],
      status: 'active',
      syncMode: 'diff',
    });
  });
});
