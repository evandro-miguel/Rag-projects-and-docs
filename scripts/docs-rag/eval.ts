import { readFileSync } from 'node:fs';
import { z } from 'zod';

const RetrievedItemSchema = z.object({
  path: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  score: z.number().finite().optional(),
  citationPath: z.string().min(1).optional(),
});

const EvalCaseSchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  expectedPaths: z.array(z.string().min(1)).min(1),
  expectedCitationPath: z.string().min(1).optional(),
  k: z.number().int().positive().optional(),
  retrieved: z.array(RetrievedItemSchema),
});

const EvalFixtureSchema = z.object({
  meta: z
    .object({
      name: z.string().min(1),
      description: z.string().min(1).optional(),
    })
    .passthrough(),
  cases: z.array(EvalCaseSchema).min(1),
});

export type DocsRagLabEvalFixture = z.infer<typeof EvalFixtureSchema>;

export interface DocsRagLabEvalCaseReport {
  readonly id: string;
  readonly query: string;
  readonly sourceId?: string;
  readonly k: number;
  readonly expectedPaths: string[];
  readonly expectedCitationPath: string;
  readonly retrievedPaths: string[];
  readonly retrievedSourceIds: (string | undefined)[];
  readonly hit: boolean;
  readonly recallAtK: number;
  readonly firstRelevantRank: number;
  readonly mrr: number;
  readonly citationPathHit: boolean;
  readonly returnedCount: number;
  readonly uniquePathCount: number;
  readonly duplicatePathSlots: number;
  readonly duplicatePathShare: number;
  readonly fullK: boolean;
}

export interface DocsRagLabEvalMetrics {
  readonly scenarioCount: number;
  readonly topK: number;
  readonly hitRate: number;
  readonly recallAtK: number;
  readonly mrr: number;
  readonly citationPathRate: number;
  readonly duplicatePathShare: number;
  readonly fullKRate: number;
}

export interface DocsRagLabEvalSummary extends DocsRagLabEvalMetrics {
  readonly sourceScoped: DocsRagLabEvalMetrics;
  readonly unscoped: DocsRagLabEvalMetrics;
}

export interface DocsRagLabEvalReport {
  readonly meta: DocsRagLabEvalFixture['meta'];
  readonly summary: DocsRagLabEvalSummary;
  readonly cases: DocsRagLabEvalCaseReport[];
}

export const DEFAULT_DOCS_RAG_LIVE_THRESHOLDS = {
  hitRate: 0.95,
  recallAtK: 0.95,
  mrr: 0.8,
  citationPathRate: 0.8,
  maxDuplicatePathShare: 0.3,
} as const;

export interface DocsRagLabEvalGate {
  readonly passed: boolean;
  readonly failures: string[];
  readonly thresholds: typeof DEFAULT_DOCS_RAG_LIVE_THRESHOLDS;
  readonly sourceScoped: DocsRagLabEvalGateResult;
  readonly unscoped: DocsRagLabEvalGateResult;
}

export interface DocsRagLabEvalGateResult {
  readonly passed: boolean;
  readonly failures: string[];
  readonly thresholds: typeof DEFAULT_DOCS_RAG_LIVE_THRESHOLDS;
}

const MIN_UNSCOPED_SCENARIOS = 1;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathsMatch(actualPath: string, expectedPath: string): boolean {
  const normalizedActual = normalizePath(actualPath);
  const normalizedExpected = normalizePath(expectedPath);
  return (
    normalizedActual === normalizedExpected || normalizedActual.endsWith(`/${normalizedExpected}`)
  );
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function summarizeCases(
  cases: readonly DocsRagLabEvalCaseReport[],
  topK: number
): DocsRagLabEvalMetrics {
  const returnedCount = cases.reduce((sum, item) => sum + item.returnedCount, 0);
  const duplicatePathSlots = cases.reduce((sum, item) => sum + item.duplicatePathSlots, 0);
  return {
    scenarioCount: cases.length,
    topK,
    hitRate: mean(cases.map((item) => (item.hit ? 1 : 0))),
    recallAtK: mean(cases.map((item) => item.recallAtK)),
    mrr: mean(cases.map((item) => item.mrr)),
    citationPathRate: mean(cases.map((item) => (item.citationPathHit ? 1 : 0))),
    duplicatePathShare: returnedCount > 0 ? duplicatePathSlots / returnedCount : 0,
    fullKRate: mean(cases.map((item) => (item.fullK ? 1 : 0))),
  };
}

export function loadDocsRagLabEvalFixture(path: string): DocsRagLabEvalFixture {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return parseDocsRagLabEvalFixture(raw);
}

export function parseDocsRagLabEvalFixture(raw: unknown): DocsRagLabEvalFixture {
  return EvalFixtureSchema.parse(raw);
}

export function evaluateDocsRagLabFixture(
  fixture: DocsRagLabEvalFixture,
  options: {
    readonly topK?: number;
  } = {}
): DocsRagLabEvalReport {
  const cases: DocsRagLabEvalCaseReport[] = fixture.cases.map((testCase) => {
    const k = options.topK ?? testCase.k ?? 5;
    const topResults = testCase.retrieved.slice(0, k);
    const retrievedPaths = topResults.map((item) => item.path);
    const retrievedSourceIds = topResults.map((item) => item.sourceId ?? testCase.sourceId);
    const relevantMatches = testCase.expectedPaths.filter((expectedPath) =>
      topResults.some((item) => pathsMatch(item.path, expectedPath))
    );
    const firstRelevantIndex = topResults.findIndex((item) =>
      testCase.expectedPaths.some((expectedPath) => pathsMatch(item.path, expectedPath))
    );
    const firstRelevantRank = firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : 0;
    const expectedCitationPath = testCase.expectedCitationPath ?? testCase.expectedPaths[0];
    const topCitationPath = topResults[0]?.citationPath ?? topResults[0]?.path ?? '';
    const uniquePathCount = new Set(
      topResults.map(
        (item, index) => `${retrievedSourceIds[index] ?? ''}:${normalizePath(item.path)}`
      )
    ).size;
    const duplicatePathSlots = retrievedPaths.length - uniquePathCount;

    return {
      id: testCase.id,
      query: testCase.query,
      sourceId: testCase.sourceId,
      k,
      expectedPaths: [...testCase.expectedPaths],
      expectedCitationPath,
      retrievedPaths,
      retrievedSourceIds,
      hit: relevantMatches.length > 0,
      recallAtK: relevantMatches.length / testCase.expectedPaths.length,
      firstRelevantRank,
      mrr: firstRelevantRank > 0 ? 1 / firstRelevantRank : 0,
      citationPathHit: topCitationPath ? pathsMatch(topCitationPath, expectedCitationPath) : false,
      returnedCount: retrievedPaths.length,
      uniquePathCount,
      duplicatePathSlots,
      duplicatePathShare:
        retrievedPaths.length > 0 ? duplicatePathSlots / retrievedPaths.length : 0,
      fullK: retrievedPaths.length >= k,
    };
  });

  const topK = options.topK ?? Math.max(...cases.map((item) => item.k));
  const sourceScopedCases = cases.filter((item) => item.sourceId !== undefined);
  const unscopedCases = cases.filter((item) => item.sourceId === undefined);
  const aggregate = summarizeCases(cases, topK);
  const sourceScoped = summarizeCases(sourceScopedCases, topK);
  const unscoped = summarizeCases(unscopedCases, topK);

  return {
    meta: fixture.meta,
    summary: {
      ...aggregate,
      sourceScoped,
      unscoped,
    },
    cases,
  };
}

export function evaluateDocsRagLabGate(summary: DocsRagLabEvalSummary): DocsRagLabEvalGate {
  const evaluateMetrics = (
    metrics: DocsRagLabEvalMetrics,
    label: string
  ): DocsRagLabEvalGateResult => {
    const failures: string[] = [];
    for (const metric of ['hitRate', 'recallAtK', 'mrr', 'citationPathRate'] as const) {
      const threshold = DEFAULT_DOCS_RAG_LIVE_THRESHOLDS[metric];
      const value = metrics[metric];
      if (value < threshold) {
        failures.push(`${label}.${metric} ${value.toFixed(3)} is below ${threshold.toFixed(3)}`);
      }
    }
    if (metrics.duplicatePathShare > DEFAULT_DOCS_RAG_LIVE_THRESHOLDS.maxDuplicatePathShare) {
      failures.push(
        `${label}.duplicatePathShare ${metrics.duplicatePathShare.toFixed(3)} exceeds ${DEFAULT_DOCS_RAG_LIVE_THRESHOLDS.maxDuplicatePathShare.toFixed(3)}`
      );
    }
    return {
      passed: failures.length === 0,
      failures,
      thresholds: DEFAULT_DOCS_RAG_LIVE_THRESHOLDS,
    };
  };

  const sourceScoped = evaluateMetrics(summary.sourceScoped, 'sourceScoped');
  const unscopedFailures =
    summary.unscoped.scenarioCount < MIN_UNSCOPED_SCENARIOS
      ? [
          `unscoped.scenarioCount ${summary.unscoped.scenarioCount} is below ${MIN_UNSCOPED_SCENARIOS}`,
        ]
      : [];
  const unscopedMetrics = evaluateMetrics(summary.unscoped, 'unscoped');
  const unscoped: DocsRagLabEvalGateResult = {
    passed: unscopedFailures.length === 0 && unscopedMetrics.passed,
    failures: [...unscopedFailures, ...unscopedMetrics.failures],
    thresholds: DEFAULT_DOCS_RAG_LIVE_THRESHOLDS,
  };
  const failures = [...sourceScoped.failures, ...unscoped.failures];

  // Keep the aggregate fields as the public summary for existing consumers,
  // while release eligibility is determined independently for each scope.
  return {
    passed: failures.length === 0,
    failures,
    thresholds: DEFAULT_DOCS_RAG_LIVE_THRESHOLDS,
    sourceScoped,
    unscoped,
  };
}
