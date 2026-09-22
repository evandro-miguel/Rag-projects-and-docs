import { DEFAULT_PROJECT_THRESHOLDS } from '../thresholds.js';
import type {
  ProjectEvalCapturedRun,
  ProjectEvalExpectationMode,
  ProjectEvalExperiment,
  ProjectEvalForbiddenTarget,
  ProjectEvalRetrievedResult,
  ProjectEvalScenario,
  ProjectEvalTarget,
  ProjectEvalThresholds,
  ProjectExperimentMetricComparison,
  ProjectExperimentReport,
  ProjectFixtureManifest,
  ProjectScenarioEvaluation,
  ProjectVariantMetrics,
  ProjectVariantReport,
} from './types.js';

const NDCG_K = 10;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathsMatch(resultPath: string, expectedPath: string): boolean {
  const normalizedResult = normalizePath(resultPath);
  const normalizedExpected = normalizePath(expectedPath);
  return (
    normalizedResult === normalizedExpected || normalizedResult.endsWith(`/${normalizedExpected}`)
  );
}

function lineRangeMatches(result: ProjectEvalRetrievedResult, target: ProjectEvalTarget): boolean {
  if (!target.lineRange) return true;
  if (result.startLine === undefined || result.endLine === undefined) return false;
  const { start, end, strict } = target.lineRange;
  if (strict) {
    return result.startLine === start && result.endLine === end;
  }
  return result.startLine <= end && result.endLine >= start;
}

function targetMatches(result: ProjectEvalRetrievedResult, target: ProjectEvalTarget): boolean {
  if (!pathsMatch(result.path, target.path)) return false;
  if (target.symbolName && result.symbolName !== target.symbolName) return false;
  if (target.symbolKind && result.symbolKind !== target.symbolKind) return false;
  return lineRangeMatches(result, target);
}

function pathTargetMatches(result: ProjectEvalRetrievedResult, target: ProjectEvalTarget): boolean {
  return pathsMatch(result.path, target.path);
}

function symbolTargetMatches(
  result: ProjectEvalRetrievedResult,
  target: ProjectEvalTarget
): boolean {
  return (
    pathTargetMatches(result, target) &&
    (!target.symbolName || result.symbolName === target.symbolName)
  );
}

function forbiddenMatches(
  result: ProjectEvalRetrievedResult,
  target: ProjectEvalForbiddenTarget
): boolean {
  if (!pathsMatch(result.path, target.path)) return false;
  if (target.symbolName && result.symbolName !== target.symbolName) return false;
  return true;
}

function scoreResult(result: ProjectEvalRetrievedResult, targets: ProjectEvalTarget[]): number {
  let best = 0;
  for (const target of targets) {
    if (!pathTargetMatches(result, target)) continue;
    let score = 0.55;
    if (target.symbolName) {
      score += result.symbolName === target.symbolName ? 0.25 : 0;
    } else {
      score += 0.2;
    }
    if (target.lineRange) {
      score += lineRangeMatches(result, target) ? 0.2 : 0;
    } else {
      score += 0.05;
    }
    if (targetMatches(result, target)) {
      score = Math.max(score, 1);
    }
    best = Math.max(best, Math.min(1, score));
  }
  return best;
}

function calculateNdcg(scores: number[], k = NDCG_K): number {
  const capped = scores.slice(0, k);
  const dcg = capped.reduce((sum, rel, index) => sum + rel / Math.log2(index + 2), 0);
  const idcg = [...capped]
    .sort((a, b) => b - a)
    .reduce((sum, rel, index) => sum + rel / Math.log2(index + 2), 0);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

function calculateMrr(firstRelevantRank: number): number {
  return firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue));
  return sorted[index];
}

export function summarizeScenarioMetrics(
  evaluations: ProjectScenarioEvaluation[]
): ProjectVariantMetrics {
  const searchLatencies = evaluations.map((evaluation) => evaluation.latencyMs);
  const endToEndLatencies = evaluations
    .map((evaluation) => evaluation.endToEndLatencyMs)
    .filter((latency): latency is number => latency !== undefined);
  const embeddingLatencies = evaluations
    .map((evaluation) => evaluation.embeddingLatencyMs)
    .filter((latency): latency is number => latency !== undefined);

  return {
    scenarioCount: evaluations.length,
    successRate:
      evaluations.length > 0
        ? evaluations.filter((evaluation) => evaluation.success).length / evaluations.length
        : 0,
    hitRate:
      evaluations.length > 0
        ? evaluations.filter((evaluation) => evaluation.success).length / evaluations.length
        : 0,
    exactPathRate:
      evaluations.length > 0
        ? (() => {
            const pathHits = evaluations.filter((e) => e.pathHit === true).length;
            const applicable = evaluations.filter((e) => e.pathHit !== null).length;
            return applicable > 0 ? pathHits / applicable : 0;
          })()
        : 0,
    exactSymbolRate:
      evaluations.length > 0
        ? (() => {
            const symbolHits = evaluations.filter((e) => e.symbolHit === true).length;
            const applicable = evaluations.filter((e) => e.symbolHit !== null).length;
            return applicable > 0 ? symbolHits / applicable : 0;
          })()
        : 0,
    exactLineRate:
      evaluations.length > 0
        ? (() => {
            const lineHits = evaluations.filter((e) => e.lineHit === true).length;
            const applicable = evaluations.filter((e) => e.lineHit !== null).length;
            return applicable > 0 ? lineHits / applicable : 0;
          })()
        : 0,
    contaminationRate:
      evaluations.length > 0
        ? evaluations.filter((evaluation) => evaluation.contamination).length / evaluations.length
        : 0,
    mrr:
      evaluations.length > 0
        ? evaluations.reduce((sum, evaluation) => sum + evaluation.mrr, 0) / evaluations.length
        : 0,
    ndcgAt10:
      evaluations.length > 0
        ? evaluations.reduce((sum, evaluation) => sum + evaluation.ndcgAt10, 0) / evaluations.length
        : 0,
    avgQualityScore:
      evaluations.length > 0
        ? evaluations.reduce((sum, evaluation) => sum + evaluation.qualityScore, 0) /
          evaluations.length
        : 0,
    latencyP50Ms: percentile(searchLatencies, 0.5),
    latencyP95Ms: percentile(searchLatencies, 0.95),
    ...(endToEndLatencies.length > 0
      ? {
          endToEndLatencyP50Ms: percentile(endToEndLatencies, 0.5),
          endToEndLatencyP95Ms: percentile(endToEndLatencies, 0.95),
        }
      : {}),
    ...(embeddingLatencies.length > 0
      ? {
          embeddingLatencyP50Ms: percentile(embeddingLatencies, 0.5),
          embeddingLatencyP95Ms: percentile(embeddingLatencies, 0.95),
        }
      : {}),
  };
}

function mergeThresholds(fixtureThresholds: Partial<ProjectEvalThresholds>): ProjectEvalThresholds {
  return {
    ...DEFAULT_PROJECT_THRESHOLDS,
    ...fixtureThresholds,
  };
}

function resolveExpectationMode(scenario: ProjectEvalScenario): ProjectEvalExpectationMode {
  return scenario.expectationMode ?? 'must_find';
}

export function evaluateScenario(
  scenario: ProjectEvalScenario,
  response: ProjectEvalCapturedRun['responses'][number] | undefined
): ProjectScenarioEvaluation {
  const expectationMode = resolveExpectationMode(scenario);
  const results = response?.results ?? [];
  const warnings = [...(response?.warnings ?? [])];
  const relevanceScores = results.map((result) => scoreResult(result, scenario.expectedTargets));
  const firstRelevantIndex = relevanceScores.findIndex((score) => score > 0);
  const firstRelevantRank = firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : 0;
  const relevantHitCount = relevanceScores.filter((score) => score > 0).length;

  // For must_avoid scenarios, path/symbol/line metrics don't apply
  const isAvoidScenario = expectationMode === 'must_avoid';
  const pathHit: boolean | null = isAvoidScenario
    ? null // N/A for avoid scenarios
    : scenario.expectedTargets.length > 0
      ? scenario.expectedTargets.some((target) =>
          results.some((result) => pathTargetMatches(result, target))
        )
      : null;
  const symbolHit: boolean | null = isAvoidScenario
    ? null
    : scenario.expectedTargets.length > 0
      ? scenario.expectedTargets.some((target) =>
          target.symbolName
            ? results.some((result) => symbolTargetMatches(result, target))
            : pathHit
        )
      : null;
  const lineHit: boolean | null = isAvoidScenario
    ? null
    : scenario.expectedTargets.length > 0
      ? scenario.expectedTargets.some((target) =>
          target.lineRange ? results.some((result) => targetMatches(result, target)) : symbolHit
        )
      : null;
  const contamination = (scenario.forbiddenTargets ?? []).some((target) =>
    results.some((result) => forbiddenMatches(result, target))
  );
  const ndcgAt10 = calculateNdcg(relevanceScores);
  const mrr = calculateMrr(firstRelevantRank);
  const latencyMs = response?.latencyMs ?? Number.POSITIVE_INFINITY;
  const endToEndLatencyMs = response?.endToEndLatencyMs;
  const embeddingLatencyMs = response?.embeddingLatencyMs;
  if (!response) {
    warnings.push('Missing captured response for scenario');
  }

  let success = false;
  if (expectationMode === 'must_find') {
    const minRelevantHits = scenario.minRelevantHits ?? 1;
    success = relevantHitCount >= minRelevantHits && !contamination;
  } else if (expectationMode === 'must_avoid') {
    success = !contamination;
  } else {
    const minRelevantHits = scenario.minRelevantHits ?? 1;
    success = relevantHitCount >= minRelevantHits && !contamination;
  }

  const qualityScore = isAvoidScenario
    ? Math.max(
        0,
        Math.min(
          1,
          (success ? 0.7 : 0) +
            // Avoid scenarios are judged on staying clean first, not on exact target hits.
            (!contamination ? 0.3 : 0)
        )
      )
    : Math.max(
        0,
        Math.min(
          1,
          (success ? 0.3 : 0) +
            (pathHit ? 0.2 : 0) +
            (symbolHit ? 0.15 : 0) +
            (lineHit ? 0.1 : 0) +
            mrr * 0.15 +
            ndcgAt10 * 0.15 -
            (contamination ? 0.3 : 0)
        )
      );

  return {
    scenarioId: scenario.id,
    query: scenario.query,
    expectationMode,
    success,
    pathHit,
    symbolHit,
    lineHit,
    contamination,
    relevantHitCount,
    firstRelevantRank,
    ndcgAt10,
    mrr,
    qualityScore,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0,
    ...(endToEndLatencyMs !== undefined ? { endToEndLatencyMs } : {}),
    ...(embeddingLatencyMs !== undefined ? { embeddingLatencyMs } : {}),
    warnings,
  };
}

export function evaluateCapturedRun(
  fixture: ProjectFixtureManifest,
  run: ProjectEvalCapturedRun
): ProjectVariantReport {
  const evaluations = fixture.scenarios.map((scenario) =>
    evaluateScenario(
      scenario,
      run.responses.find((response) => response.scenarioId === scenario.id)
    )
  );
  const thresholdConfig = mergeThresholds(fixture.thresholds);
  const metrics = summarizeScenarioMetrics(evaluations);

  const thresholdFailures: string[] = [];
  const thresholdChecks: Array<[keyof ProjectEvalThresholds, number, number, 'min' | 'max']> = [
    ['hitRate', metrics.hitRate, thresholdConfig.hitRate, 'min'],
    ['exactPathRate', metrics.exactPathRate, thresholdConfig.exactPathRate, 'min'],
    ['exactSymbolRate', metrics.exactSymbolRate, thresholdConfig.exactSymbolRate, 'min'],
    ['exactLineRate', metrics.exactLineRate, thresholdConfig.exactLineRate, 'min'],
    ['mrr', metrics.mrr, thresholdConfig.mrr, 'min'],
    ['ndcgAt10', metrics.ndcgAt10, thresholdConfig.ndcgAt10, 'min'],
    ['avgQualityScore', metrics.avgQualityScore, thresholdConfig.avgQualityScore, 'min'],
    [
      'maxContaminationRate',
      metrics.contaminationRate,
      thresholdConfig.maxContaminationRate,
      'max',
    ],
    ['latencyP95Ms', metrics.latencyP95Ms, thresholdConfig.latencyP95Ms, 'max'],
  ];

  for (const [name, value, threshold, direction] of thresholdChecks) {
    const passes = direction === 'min' ? value >= threshold : value <= threshold;
    if (!passes) {
      thresholdFailures.push(
        `${name}: ${value.toFixed(3)} ${direction === 'min' ? '<' : '>'} ${threshold.toFixed(3)}`
      );
    }
  }

  return {
    fixtureId: fixture.id,
    variantId: run.variantId,
    capturedAt: run.capturedAt,
    source: run.source,
    metrics,
    thresholdFailures,
    scenarios: evaluations,
  };
}

export function compareExperiment(
  fixture: ProjectFixtureManifest,
  experiment: ProjectEvalExperiment,
  reports: ProjectVariantReport[]
): ProjectExperimentReport {
  const baseline = reports.find((report) => report.variantId === experiment.baselineVariantId);
  const candidate = reports.find((report) => report.variantId === experiment.candidateVariantId);
  const failures: string[] = [];

  if (!baseline || !candidate) {
    failures.push('Missing baseline or candidate report');
    return {
      fixtureId: fixture.id,
      experimentId: experiment.id,
      baselineVariantId: experiment.baselineVariantId,
      candidateVariantId: experiment.candidateVariantId,
      passed: false,
      deltas: {
        hitRate: 0,
        exactPathRate: 0,
        exactSymbolRate: 0,
        avgQualityScore: 0,
        latencyP95Ms: 0,
      },
      lifts: {
        hitRatePercent: 0,
        exactPathRatePercent: 0,
        exactSymbolRatePercent: 0,
        avgQualityScorePercent: 0,
        latencyP95Percent: 0,
      },
      comparisons: [],
      baselineMetrics: {
        hitRate: 0,
        exactPathRate: 0,
        exactSymbolRate: 0,
        avgQualityScore: 0,
        latencyP95Ms: 0,
      },
      candidateMetrics: {
        hitRate: 0,
        exactPathRate: 0,
        exactSymbolRate: 0,
        avgQualityScore: 0,
        latencyP95Ms: 0,
      },
      failures,
    };
  }

  // Calculate absolute deltas
  const deltas = {
    hitRate: candidate.metrics.hitRate - baseline.metrics.hitRate,
    exactPathRate: candidate.metrics.exactPathRate - baseline.metrics.exactPathRate,
    exactSymbolRate: candidate.metrics.exactSymbolRate - baseline.metrics.exactSymbolRate,
    avgQualityScore: candidate.metrics.avgQualityScore - baseline.metrics.avgQualityScore,
    latencyP95Ms: candidate.metrics.latencyP95Ms - baseline.metrics.latencyP95Ms,
  };

  // Calculate percentage lifts: (B - A) / A * 100
  const calculateLift = (baseline: number, candidate: number): number => {
    if (baseline === 0) return candidate > 0 ? 100 : 0;
    return ((candidate - baseline) / baseline) * 100;
  };

  const lifts = {
    hitRatePercent: calculateLift(baseline.metrics.hitRate, candidate.metrics.hitRate),
    exactPathRatePercent: calculateLift(
      baseline.metrics.exactPathRate,
      candidate.metrics.exactPathRate
    ),
    exactSymbolRatePercent: calculateLift(
      baseline.metrics.exactSymbolRate,
      candidate.metrics.exactSymbolRate
    ),
    avgQualityScorePercent: calculateLift(
      baseline.metrics.avgQualityScore,
      candidate.metrics.avgQualityScore
    ),
    latencyP95Percent: calculateLift(baseline.metrics.latencyP95Ms, candidate.metrics.latencyP95Ms),
  };

  // Build metric comparisons
  const comparisons: ProjectExperimentMetricComparison[] = [
    {
      metric: 'hitRate',
      baseline: baseline.metrics.hitRate,
      candidate: candidate.metrics.hitRate,
      absoluteLift: deltas.hitRate,
      percentageLift: lifts.hitRatePercent,
      passed:
        experiment.minHitRateLift === undefined || deltas.hitRate >= experiment.minHitRateLift,
    },
    {
      metric: 'exactPathRate',
      baseline: baseline.metrics.exactPathRate,
      candidate: candidate.metrics.exactPathRate,
      absoluteLift: deltas.exactPathRate,
      percentageLift: lifts.exactPathRatePercent,
      passed:
        experiment.minExactPathLift === undefined ||
        deltas.exactPathRate >= experiment.minExactPathLift,
    },
    {
      metric: 'exactSymbolRate',
      baseline: baseline.metrics.exactSymbolRate,
      candidate: candidate.metrics.exactSymbolRate,
      absoluteLift: deltas.exactSymbolRate,
      percentageLift: lifts.exactSymbolRatePercent,
      passed:
        experiment.minExactSymbolLift === undefined ||
        deltas.exactSymbolRate >= experiment.minExactSymbolLift,
    },
    {
      metric: 'avgQualityScore',
      baseline: baseline.metrics.avgQualityScore,
      candidate: candidate.metrics.avgQualityScore,
      absoluteLift: deltas.avgQualityScore,
      percentageLift: lifts.avgQualityScorePercent,
      passed:
        experiment.minQualityScoreLift === undefined ||
        deltas.avgQualityScore >= experiment.minQualityScoreLift,
    },
    {
      metric: 'latencyP95Ms',
      baseline: baseline.metrics.latencyP95Ms,
      candidate: candidate.metrics.latencyP95Ms,
      absoluteLift: deltas.latencyP95Ms,
      percentageLift: lifts.latencyP95Percent,
      passed:
        experiment.maxLatencyRegressionMs === undefined ||
        deltas.latencyP95Ms <= experiment.maxLatencyRegressionMs,
    },
  ];

  // Check experiment thresholds and collect failures
  if (experiment.minHitRateLift !== undefined && deltas.hitRate < experiment.minHitRateLift) {
    failures.push(
      `hitRate lift ${deltas.hitRate.toFixed(3)} (${lifts.hitRatePercent.toFixed(1)}%) < ${experiment.minHitRateLift.toFixed(3)}`
    );
  }
  if (
    experiment.minExactPathLift !== undefined &&
    deltas.exactPathRate < experiment.minExactPathLift
  ) {
    failures.push(
      `exactPathRate lift ${deltas.exactPathRate.toFixed(3)} (${lifts.exactPathRatePercent.toFixed(1)}%) < ${experiment.minExactPathLift.toFixed(3)}`
    );
  }
  if (
    experiment.minExactSymbolLift !== undefined &&
    deltas.exactSymbolRate < experiment.minExactSymbolLift
  ) {
    failures.push(
      `exactSymbolRate lift ${deltas.exactSymbolRate.toFixed(3)} (${lifts.exactSymbolRatePercent.toFixed(1)}%) < ${experiment.minExactSymbolLift.toFixed(3)}`
    );
  }
  if (
    experiment.minQualityScoreLift !== undefined &&
    deltas.avgQualityScore < experiment.minQualityScoreLift
  ) {
    failures.push(
      `avgQualityScore lift ${deltas.avgQualityScore.toFixed(3)} (${lifts.avgQualityScorePercent.toFixed(1)}%) < ${experiment.minQualityScoreLift.toFixed(3)}`
    );
  }
  if (
    experiment.maxLatencyRegressionMs !== undefined &&
    deltas.latencyP95Ms > experiment.maxLatencyRegressionMs
  ) {
    failures.push(
      `latency regression ${deltas.latencyP95Ms.toFixed(1)}ms (${lifts.latencyP95Percent > 0 ? '+' : ''}${lifts.latencyP95Percent.toFixed(1)}%) > ${experiment.maxLatencyRegressionMs.toFixed(1)}ms`
    );
  }

  return {
    fixtureId: fixture.id,
    experimentId: experiment.id,
    baselineVariantId: experiment.baselineVariantId,
    candidateVariantId: experiment.candidateVariantId,
    passed: failures.length === 0,
    deltas,
    lifts,
    comparisons,
    baselineMetrics: {
      hitRate: baseline.metrics.hitRate,
      exactPathRate: baseline.metrics.exactPathRate,
      exactSymbolRate: baseline.metrics.exactSymbolRate,
      avgQualityScore: baseline.metrics.avgQualityScore,
      latencyP95Ms: baseline.metrics.latencyP95Ms,
    },
    candidateMetrics: {
      hitRate: candidate.metrics.hitRate,
      exactPathRate: candidate.metrics.exactPathRate,
      exactSymbolRate: candidate.metrics.exactSymbolRate,
      avgQualityScore: candidate.metrics.avgQualityScore,
      latencyP95Ms: candidate.metrics.latencyP95Ms,
    },
    failures,
  };
}

export function resolveThresholds(fixture: ProjectFixtureManifest): ProjectEvalThresholds {
  return mergeThresholds(fixture.thresholds);
}
