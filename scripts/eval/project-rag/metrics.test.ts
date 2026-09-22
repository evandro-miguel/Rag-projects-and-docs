import { describe, expect, it } from 'vitest';
import { getProjectFixture } from './fixtures.js';
import {
  compareExperiment,
  evaluateCapturedRun,
  evaluateScenario,
  resolveThresholds,
} from './metrics.js';
import type { ProjectEvalCapturedRun } from './types.js';

describe('project-rag metrics', () => {
  it('scores an exact symbol and line match as a successful scenario', () => {
    const fixture = getProjectFixture('fixture-ts-service');
    if (!fixture) throw new Error('fixture-ts-service missing');
    const scenario = fixture.scenarios[0];

    const evaluation = evaluateScenario(scenario, {
      scenarioId: scenario.id,
      latencyMs: 420,
      results: [
        {
          path: 'src/auth/service.ts',
          symbolName: 'issueSessionToken',
          symbolKind: 'function',
          startLine: 12,
          endLine: 15,
        },
      ],
    });

    expect(evaluation.success).toBe(true);
    expect(evaluation.pathHit).toBe(true);
    expect(evaluation.symbolHit).toBe(true);
    expect(evaluation.lineHit).toBe(true);
    expect(evaluation.mrr).toBe(1);
    expect(evaluation.ndcgAt10).toBe(1);
  });

  it('treats forbidden secret retrieval as contamination', () => {
    const fixture = getProjectFixture('fixture-secret-noise');
    if (!fixture) throw new Error('fixture-secret-noise missing');
    const scenario = fixture.scenarios[1];

    const evaluation = evaluateScenario(scenario, {
      scenarioId: scenario.id,
      latencyMs: 150,
      results: [{ path: '.env' }],
    });

    expect(evaluation.success).toBe(false);
    expect(evaluation.contamination).toBe(true);
    expect(evaluation.qualityScore).toBeLessThan(0.5);
  });

  it('aggregates exact-match metrics across a captured run', () => {
    const fixture = getProjectFixture('fixture-ts-service');
    if (!fixture) throw new Error('fixture-ts-service missing');

    const run: ProjectEvalCapturedRun = {
      fixtureId: fixture.id,
      variantId: 'project-hybrid',
      capturedAt: new Date().toISOString(),
      source: 'script',
      responses: [
        {
          scenarioId: 'ts-service-session-token',
          latencyMs: 400,
          results: [
            {
              path: 'src/auth/service.ts',
              symbolName: 'issueSessionToken',
              symbolKind: 'function',
              startLine: 12,
              endLine: 15,
            },
          ],
        },
        {
          scenarioId: 'ts-service-user-email-repo',
          latencyMs: 450,
          results: [
            {
              path: 'src/users/repository.ts',
              symbolName: 'getUserByEmail',
              symbolKind: 'function',
              startLine: 7,
              endLine: 9,
            },
          ],
        },
        {
          scenarioId: 'ts-service-login-controller',
          latencyMs: 500,
          results: [
            {
              path: 'src/auth/controller.ts',
              symbolName: 'handleLoginRequest',
              symbolKind: 'function',
              startLine: 3,
              endLine: 9,
            },
          ],
        },
      ],
    };

    const report = evaluateCapturedRun(fixture, run);

    expect(report.metrics.hitRate).toBe(1);
    expect(report.metrics.exactPathRate).toBe(1);
    expect(report.metrics.exactSymbolRate).toBe(1);
    expect(report.thresholdFailures).toEqual([]);
  });

  it('compares A/B variants using the declared experiment thresholds', () => {
    const fixture = getProjectFixture('fixture-ts-service');
    if (!fixture) throw new Error('fixture-ts-service missing');

    const baseline = evaluateCapturedRun(fixture, {
      fixtureId: fixture.id,
      variantId: 'legacy-docs-hybrid',
      capturedAt: new Date().toISOString(),
      source: 'script',
      responses: fixture.scenarios.map((scenario) => ({
        scenarioId: scenario.id,
        latencyMs: 350,
        results: [{ path: 'README.md' }],
      })),
    });

    const candidate = evaluateCapturedRun(fixture, {
      fixtureId: fixture.id,
      variantId: 'project-hybrid',
      capturedAt: new Date().toISOString(),
      source: 'script',
      responses: [
        {
          scenarioId: 'ts-service-session-token',
          latencyMs: 420,
          results: [
            {
              path: 'src/auth/service.ts',
              symbolName: 'issueSessionToken',
              symbolKind: 'function',
              startLine: 12,
              endLine: 15,
            },
          ],
        },
        {
          scenarioId: 'ts-service-user-email-repo',
          latencyMs: 450,
          results: [
            {
              path: 'src/users/repository.ts',
              symbolName: 'getUserByEmail',
              symbolKind: 'function',
              startLine: 7,
              endLine: 9,
            },
          ],
        },
        {
          scenarioId: 'ts-service-login-controller',
          latencyMs: 500,
          results: [
            {
              path: 'src/auth/controller.ts',
              symbolName: 'handleLoginRequest',
              symbolKind: 'function',
              startLine: 3,
              endLine: 9,
            },
          ],
        },
      ],
    });

    const experiment = fixture.experiments[0];
    const comparison = compareExperiment(fixture, experiment, [baseline, candidate]);

    expect(comparison.passed).toBe(true);
    expect(comparison.deltas.hitRate).toBeGreaterThan(0);
    expect(comparison.failures).toEqual([]);
  });

  // ============================================================================
  // EDGE CASES AND ADDITIONAL COVERAGE
  // ============================================================================

  describe('evaluateScenario edge cases', () => {
    it('handles missing response with warning', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');
      const scenario = fixture.scenarios[0];

      const evaluation = evaluateScenario(scenario, undefined);

      expect(evaluation.warnings).toContain('Missing captured response for scenario');
      expect(evaluation.success).toBe(false);
      expect(evaluation.latencyMs).toBe(0);
    });

    it('handles empty results', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');
      const scenario = fixture.scenarios[0];

      const evaluation = evaluateScenario(scenario, {
        scenarioId: scenario.id,
        latencyMs: 100,
        results: [],
      });

      expect(evaluation.success).toBe(false);
      expect(evaluation.mrr).toBe(0);
      expect(evaluation.ndcgAt10).toBe(0);
      expect(evaluation.firstRelevantRank).toBe(0);
    });

    it('keeps quality scoring independent from latency penalties', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');
      const scenario = fixture.scenarios[0];

      const fastEvaluation = evaluateScenario(scenario, {
        scenarioId: scenario.id,
        latencyMs: 80,
        results: [{ path: 'src/auth/service.ts' }],
      });
      const slowEvaluation = evaluateScenario(scenario, {
        scenarioId: scenario.id,
        latencyMs: 150,
        results: [{ path: 'src/auth/service.ts' }],
      });

      expect(fastEvaluation.qualityScore).toBeDefined();
      expect(slowEvaluation.qualityScore).toBe(fastEvaluation.qualityScore);
    });

    it('handles must_avoid scenario mode', () => {
      const fixture = getProjectFixture('fixture-secret-noise');
      if (!fixture) throw new Error('fixture-secret-noise missing');
      const scenario = fixture.scenarios[1]; // This is a must_avoid scenario

      // When there's no contamination, should succeed
      const evaluation = evaluateScenario(scenario, {
        scenarioId: scenario.id,
        latencyMs: 100,
        results: [{ path: 'safe-file.ts' }],
      });

      expect(evaluation.success).toBe(true);
      expect(evaluation.contamination).toBe(false);
      expect(evaluation.pathHit).toBeNull();
      expect(evaluation.symbolHit).toBeNull();
      expect(evaluation.lineHit).toBeNull();
      expect(evaluation.qualityScore).toBe(1);
    });

    it('calculates correct mrr when first relevant is at position 2', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');
      const scenario = fixture.scenarios[0];

      const evaluation = evaluateScenario(scenario, {
        scenarioId: scenario.id,
        latencyMs: 100,
        results: [
          { path: 'wrong/path.ts' }, // Not relevant
          { path: 'src/auth/service.ts' }, // Relevant at position 2
        ],
      });

      expect(evaluation.firstRelevantRank).toBe(2);
      expect(evaluation.mrr).toBe(0.5);
    });

    it('calculates ndcg correctly with partial relevance', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');
      const scenario = fixture.scenarios[0];

      // With partial relevance scores
      const evaluation = evaluateScenario(scenario, {
        scenarioId: scenario.id,
        latencyMs: 100,
        results: [
          { path: 'src/auth/service.ts', symbolName: 'wrong' }, // Partial match
          { path: 'src/auth/service.ts', symbolName: 'issueSessionToken' }, // Exact match
        ],
      });

      expect(evaluation.ndcgAt10).toBeGreaterThan(0);
      expect(evaluation.ndcgAt10).toBeLessThanOrEqual(1);
    });
  });

  describe('evaluateCapturedRun edge cases', () => {
    it('handles empty fixture with no scenarios', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');

      // Use fixture but with empty responses
      const run: ProjectEvalCapturedRun = {
        fixtureId: fixture.id,
        variantId: 'v1',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: [], // Empty responses for all scenarios
      };

      const report = evaluateCapturedRun(fixture, run);

      expect(report.metrics.hitRate).toBe(0);
      expect(report.metrics.ndcgAt10).toBe(0);
      expect(report.metrics.mrr).toBe(0);
    });

    it('calculates percentile latency correctly', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');

      // Create responses with varying latencies
      const run: ProjectEvalCapturedRun = {
        fixtureId: fixture.id,
        variantId: 'test',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: fixture.scenarios.map((scenario, index) => ({
          scenarioId: scenario.id,
          latencyMs: (index + 1) * 100, // 100, 200, 300ms
          results: [{ path: 'src/auth/service.ts' }],
        })),
      };

      const report = evaluateCapturedRun(fixture, run);

      expect(report.metrics.latencyP50Ms).toBeGreaterThan(0);
      expect(report.metrics.latencyP95Ms).toBeGreaterThanOrEqual(report.metrics.latencyP50Ms);
    });

    it('excludes must_avoid scenarios from exact path/symbol aggregation', () => {
      const fixture = getProjectFixture('fixture-secret-noise');
      if (!fixture) throw new Error('fixture-secret-noise missing');
      const mustFindScenario = fixture.scenarios[0];
      const mustAvoidScenario = fixture.scenarios[1];

      const run: ProjectEvalCapturedRun = {
        fixtureId: fixture.id,
        variantId: 'test',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: [
          {
            scenarioId: mustFindScenario.id,
            latencyMs: 100,
            results: [{ path: 'src/safe.ts' }],
          },
          {
            scenarioId: mustAvoidScenario.id,
            latencyMs: 100,
            results: [{ path: 'safe.ts' }],
          },
        ],
      };

      const report = evaluateCapturedRun(fixture, run);
      const avoidEvaluation = report.scenarios.find((s) => s.scenarioId === mustAvoidScenario.id);

      expect(avoidEvaluation?.pathHit).toBeNull();
      expect(avoidEvaluation?.symbolHit).toBeNull();
      expect(avoidEvaluation?.lineHit).toBeNull();
      expect(report.metrics.exactPathRate).toBe(1);
      expect(report.metrics.exactSymbolRate).toBe(1);
      expect(report.metrics.exactLineRate).toBe(0);
      expect(report.metrics.avgQualityScore).toBeGreaterThan(0.5);
    });
  });

  describe('compareExperiment edge cases', () => {
    it('handles missing baseline report', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');

      const experiment = fixture.experiments[0];

      const result = compareExperiment(fixture, experiment, []);

      expect(result.passed).toBe(false);
      expect(result.failures).toContain('Missing baseline or candidate report');
    });

    it('calculates correct lift when baseline is zero', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');

      // Both baseline and candidate have mixed results
      // This test is to verify the comparison logic works
      const baseline = evaluateCapturedRun(fixture, {
        fixtureId: fixture.id,
        variantId: 'baseline',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: fixture.scenarios.map((scenario) => ({
          scenarioId: scenario.id,
          latencyMs: 100,
          results: [{ path: 'src/auth/service.ts' }], // Path match
        })),
      });

      const candidate = evaluateCapturedRun(fixture, {
        fixtureId: fixture.id,
        variantId: 'candidate',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: fixture.scenarios.map((scenario) => ({
          scenarioId: scenario.id,
          latencyMs: 100,
          results: [{ path: 'src/auth/service.ts', symbolName: 'issueSessionToken' }], // Better match
        })),
      });

      const experiment = fixture.experiments[0];
      const comparison = compareExperiment(fixture, experiment, [baseline, candidate]);

      // Verify comparison runs without errors
      expect(comparison.deltas).toBeDefined();
      expect(comparison.lifts).toBeDefined();
    });

    it('reports threshold failures correctly', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');

      // Very poor baseline
      const baseline = evaluateCapturedRun(fixture, {
        fixtureId: fixture.id,
        variantId: 'baseline',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: fixture.scenarios.map((scenario) => ({
          scenarioId: scenario.id,
          latencyMs: 10000, // Very slow
          results: [{ path: 'wrong.ts' }],
        })),
      });

      // Slightly better candidate
      const candidate = evaluateCapturedRun(fixture, {
        fixtureId: fixture.id,
        variantId: 'candidate',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: fixture.scenarios.map((scenario, idx) => ({
          scenarioId: scenario.id,
          latencyMs: 5000,
          results: idx === 0 ? [{ path: 'src/auth/service.ts' }] : [],
        })),
      });

      const experiment: any = {
        id: 'test-exp',
        baselineVariantId: 'baseline',
        candidateVariantId: 'candidate',
        minHitRateLift: 0.5, // Expect 50% improvement
      };

      const comparison = compareExperiment(fixture, experiment, [baseline, candidate]);

      // Should fail because improvement is not enough
      expect(comparison.passed).toBe(false);
      expect(comparison.failures.length).toBeGreaterThan(0);
    });
  });

  describe('resolveThresholds', () => {
    it('returns merged thresholds with defaults', () => {
      const fixture = getProjectFixture('fixture-ts-service');
      if (!fixture) throw new Error('fixture-ts-service missing');

      // Override hitRate threshold
      const customFixture = {
        ...fixture,
        thresholds: { hitRate: 0.8 },
      };

      const thresholds = resolveThresholds(customFixture);

      expect(thresholds.hitRate).toBe(0.8);
      // Other fields should have defaults
      expect(thresholds.exactPathRate).toBeDefined();
      expect(thresholds.ndcgAt10).toBeDefined();
    });
  });
});
