export type ProjectEvalVariantMode =
  | 'project-hybrid'
  | 'project-keyword'
  | 'project-vector'
  | 'legacy-docs-hybrid'
  | 'capture-only';

export type ProjectEvalScenarioCategory =
  | 'happy_path'
  | 'security'
  | 'graph'
  | 'drift'
  | 'fallback'
  | 'performance';

export type ProjectEvalGoldenGroupId =
  | 'project-lexical'
  | 'project-conceptual'
  | 'project-symbol-graph'
  | 'project-caller-reference'
  | 'project-active-file';

export type ProjectEvalExpectationMode = 'must_find' | 'must_avoid' | 'mixed';

export interface ProjectEvalLineRange {
  start: number;
  end: number;
  strict?: boolean;
}

export interface ProjectEvalTarget {
  path: string;
  symbolName?: string;
  symbolKind?: string;
  lineRange?: ProjectEvalLineRange;
  maxRank?: number;
  weight?: number;
}

export interface ProjectEvalForbiddenTarget {
  path: string;
  symbolName?: string;
  reason: string;
}

export interface ProjectEvalScenario {
  id: string;
  query: string;
  intent: string;
  category: ProjectEvalScenarioCategory;
  difficulty: 'easy' | 'medium' | 'hard';
  expectationMode?: ProjectEvalExpectationMode;
  expectedTargets: ProjectEvalTarget[];
  forbiddenTargets?: ProjectEvalForbiddenTarget[];
  minRelevantHits?: number;
  maxLatencyMs?: number;
  tags?: string[];
  tuningHints?: string[];
}

export interface ProjectFixtureInventoryExpectation {
  indexedPaths: string[];
  blockedPaths?: string[];
  degradedPaths?: string[];
  minimumSymbolCount?: number;
  minimumChunkCount?: number;
}

export interface ProjectEvalThresholds {
  hitRate: number;
  exactPathRate: number;
  exactSymbolRate: number;
  exactLineRate: number;
  mrr: number;
  ndcgAt10: number;
  avgQualityScore: number;
  maxContaminationRate: number;
  latencyP95Ms: number;
}

export interface ProjectEvalVariant {
  id: string;
  label: string;
  mode: ProjectEvalVariantMode;
  description: string;
}

export interface ProjectEvalExperiment {
  id: string;
  baselineVariantId: string;
  candidateVariantId: string;
  minHitRateLift?: number;
  minExactPathLift?: number;
  minExactSymbolLift?: number;
  minQualityScoreLift?: number;
  maxLatencyRegressionMs?: number;
  notes?: string[];
}

export interface ProjectEvalDbAction {
  id: string;
  phase:
    | 'register'
    | 'full_ingest'
    | 'incremental_sync'
    | 'search'
    | 'verify'
    | 'drift_baseline'
    | 'ab_test';
  description: string;
  commandHint: string;
  repoSubdir?: string;
  expected: {
    filesIndexedMin?: number;
    blockedFiles?: number;
    skippedFiles?: number;
    staleFiles?: number;
    symbolCountMin?: number;
    chunkCountMin?: number;
    thresholds?: Partial<ProjectEvalThresholds>;
  };
  qualityChecks: string[];
  abTestIds?: string[];
}

export interface ProjectFixtureManifest {
  id: string;
  title: string;
  description: string;
  repoType:
    | 'ts_service'
    | 'security_noise'
    | 'graph_relations'
    | 'branch_drift'
    | 'mixed_language'
    | 'limit_edges';
  repoRoot: string;
  languages: string[];
  sharedBenchmarkSources: string[];
  inventory: ProjectFixtureInventoryExpectation;
  thresholds: Partial<ProjectEvalThresholds>;
  variants: ProjectEvalVariant[];
  experiments: ProjectEvalExperiment[];
  scenarios: ProjectEvalScenario[];
  dbActions: ProjectEvalDbAction[];
}

export interface ProjectEvalRetrievedResult {
  path: string;
  score?: number;
  symbolName?: string;
  symbolKind?: string;
  startLine?: number;
  endLine?: number;
  source?: 'file' | 'chunk' | 'symbol' | 'edge';
}

export interface ProjectEvalCapturedScenario {
  scenarioId: string;
  latencyMs: number;
  endToEndLatencyMs?: number;
  embeddingLatencyMs?: number;
  results: ProjectEvalRetrievedResult[];
  warnings?: string[];
}

export interface ProjectEvalCapturedRun {
  fixtureId: string;
  variantId: string;
  capturedAt: string;
  source: 'manual' | 'agent' | 'script';
  notes?: string[];
  responses: ProjectEvalCapturedScenario[];
}

export interface ProjectScenarioEvaluation {
  scenarioId: string;
  query: string;
  expectationMode: ProjectEvalExpectationMode;
  success: boolean;
  pathHit: boolean | null;
  symbolHit: boolean | null;
  lineHit: boolean | null;
  contamination: boolean;
  relevantHitCount: number;
  firstRelevantRank: number;
  ndcgAt10: number;
  mrr: number;
  qualityScore: number;
  latencyMs: number;
  endToEndLatencyMs?: number;
  embeddingLatencyMs?: number;
  warnings: string[];
}

export interface ProjectVariantMetrics {
  scenarioCount: number;
  successRate: number;
  hitRate: number;
  exactPathRate: number;
  exactSymbolRate: number;
  exactLineRate: number;
  contaminationRate: number;
  mrr: number;
  ndcgAt10: number;
  avgQualityScore: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  endToEndLatencyP50Ms?: number;
  endToEndLatencyP95Ms?: number;
  embeddingLatencyP50Ms?: number;
  embeddingLatencyP95Ms?: number;
}

export interface ProjectVariantReport {
  fixtureId: string;
  variantId: string;
  capturedAt: string;
  source: ProjectEvalCapturedRun['source'];
  metrics: ProjectVariantMetrics;
  thresholdFailures: string[];
  scenarios: ProjectScenarioEvaluation[];
}

export interface ProjectGoldenGroupReport {
  fixtureId: string;
  variantId: string;
  groupId: ProjectEvalGoldenGroupId;
  groupLabel: string;
  scenarioCount: number;
  metrics: ProjectVariantMetrics;
  scenarioIds: string[];
}

export interface ProjectExperimentMetricComparison {
  metric: string;
  baseline: number;
  candidate: number;
  absoluteLift: number;
  percentageLift: number;
  passed: boolean;
}

export interface ProjectExperimentReport {
  fixtureId: string;
  experimentId: string;
  baselineVariantId: string;
  candidateVariantId: string;
  passed: boolean;
  deltas: {
    hitRate: number;
    exactPathRate: number;
    exactSymbolRate: number;
    avgQualityScore: number;
    latencyP95Ms: number;
  };
  lifts: {
    hitRatePercent: number;
    exactPathRatePercent: number;
    exactSymbolRatePercent: number;
    avgQualityScorePercent: number;
    latencyP95Percent: number;
  };
  comparisons: ProjectExperimentMetricComparison[];
  baselineMetrics: {
    hitRate: number;
    exactPathRate: number;
    exactSymbolRate: number;
    avgQualityScore: number;
    latencyP95Ms: number;
  };
  candidateMetrics: {
    hitRate: number;
    exactPathRate: number;
    exactSymbolRate: number;
    avgQualityScore: number;
    latencyP95Ms: number;
  };
  failures: string[];
}

export interface ProjectFixtureValidationReport {
  fixtureId: string;
  repoRoot: string;
  missingIndexedPaths: string[];
  missingBlockedPaths: string[];
  missingDegradedPaths: string[];
  missingExpectedTargetPaths: string[];
  missingForbiddenTargetPaths: string[];
  untrackedFiles: string[];
  valid: boolean;
}

export interface ProjectExecutionPlanItem {
  fixtureId: string;
  title: string;
  repoRoot: string;
  sharedBenchmarkSources: string[];
  dbActions: ProjectEvalDbAction[];
  experiments: ProjectEvalExperiment[];
  thresholds: ProjectEvalThresholds;
}

export interface ProjectEvalReport {
  generatedAt: string;
  fixtures: ProjectExecutionPlanItem[];
  variantReports: ProjectVariantReport[];
  goldenGroupReports: ProjectGoldenGroupReport[];
  experimentReports: ProjectExperimentReport[];
}
