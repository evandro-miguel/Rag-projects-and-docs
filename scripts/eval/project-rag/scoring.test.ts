import { describe, expect, it } from 'vitest';
import { getProjectFixture } from './fixtures.js';
import { evaluateCapturedRun } from './metrics.js';

describe('project rag scoring compatibility', () => {
  it('penalizes forbidden result leakage inside a mixed expectation scenario', () => {
    const fixture = getProjectFixture('fixture-limit-edges');
    if (!fixture) throw new Error('fixture-limit-edges missing');

    const report = evaluateCapturedRun(fixture, {
      fixtureId: fixture.id,
      variantId: 'project-hybrid',
      capturedAt: '2026-03-08T00:00:00Z',
      source: 'script',
      responses: [
        {
          scenarioId: 'limit-edges-batching',
          latencyMs: 600,
          results: [
            {
              path: 'src/services/batch-processor.ts',
              symbolName: 'splitIntoBatches',
              symbolKind: 'function',
              startLine: 1,
              endLine: 7,
            },
            { path: 'src/generated/huge.generated.ts' },
          ],
        },
      ],
    });

    expect(report.scenarios[0]?.contamination).toBe(true);
    expect(report.scenarios[0]?.success).toBe(false);
    expect(report.metrics.contaminationRate).toBe(1);
    expect(report.metrics.avgQualityScore).toBeLessThan(0.8);
  });

  it('treats missing responses as hard quality failures', () => {
    const fixture = getProjectFixture('fixture-graph-relations');
    if (!fixture) throw new Error('fixture-graph-relations missing');

    const report = evaluateCapturedRun(fixture, {
      fixtureId: fixture.id,
      variantId: 'project-keyword',
      capturedAt: '2026-03-08T00:00:00Z',
      source: 'manual',
      responses: [],
    });

    expect(report.metrics.hitRate).toBe(0);
    expect(report.thresholdFailures.length).toBeGreaterThan(0);
    expect(report.scenarios.every((scenario) => scenario.warnings.length > 0)).toBe(true);
  });
});
