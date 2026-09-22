import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectFixture } from './fixtures.js';
import { resolveFixtureRoot } from './manifest-validation.js';
import { evaluateScenario, summarizeScenarioMetrics } from './metrics.js';
import type {
  ProjectEvalRetrievedResult,
  ProjectEvalScenario,
  ProjectFixtureManifest,
  ProjectScenarioEvaluation,
  ProjectVariantMetrics,
} from './types.js';

export type LightEmbeddingProfileId = 'profile-4096' | 'profile-1024';

export interface LightEmbeddingProfile {
  id: LightEmbeddingProfileId;
  dimensions: number;
  laneMode: 'segmented' | 'shared';
  label: string;
  description: string;
}

export interface LightEmbeddingScenarioReport extends ProjectScenarioEvaluation {
  fixtureId: string;
  profileId: LightEmbeddingProfileId;
  topPaths: string[];
}

export interface LightEmbeddingFixtureReport {
  fixtureId: string;
  title: string;
  profileId: LightEmbeddingProfileId;
  dimensions: number;
  laneMode: LightEmbeddingProfile['laneMode'];
  corpusSize: number;
  indexedDocumentCount: number;
  blockedDocumentCount: number;
  metrics: ProjectVariantMetrics;
  scenarios: LightEmbeddingScenarioReport[];
}

export interface LightEmbeddingProfileSummary {
  profileId: LightEmbeddingProfileId;
  label: string;
  dimensions: number;
  laneMode: LightEmbeddingProfile['laneMode'];
  fixtureIds: string[];
  corpusSize: number;
  scenarioCount: number;
  metrics: ProjectVariantMetrics;
}

export interface LightEmbeddingComparison {
  baselineProfileId: LightEmbeddingProfileId;
  candidateProfileId: LightEmbeddingProfileId;
  deltas: {
    hitRate: number;
    exactPathRate: number;
    exactSymbolRate: number;
    exactLineRate: number;
    avgQualityScore: number;
    contaminationRate: number;
    latencyP95Ms: number;
    embeddingLatencyP95Ms: number;
  };
}

export interface LightEmbeddingBenchmarkReport {
  generatedAt: string;
  mode: 'light';
  disclaimer: string;
  fixtures: string[];
  profiles: LightEmbeddingProfileSummary[];
  fixtureReports: LightEmbeddingFixtureReport[];
  comparison: LightEmbeddingComparison;
}

export interface LightEmbeddingBenchmarkOptions {
  fixtureIds?: string[];
  profileIds?: LightEmbeddingProfileId[];
  topK?: number;
  generatedAt?: string;
}

interface CorpusDocument {
  key: string;
  path: string;
  symbolName?: string;
  symbolKind?: string;
  startLine?: number;
  endLine?: number;
  text: string;
  blocked: boolean;
}

interface HashedVector {
  readonly dimensions: number;
  readonly values: Float64Array;
  readonly norm: number;
}

const DEFAULT_TOP_K = 3;
const DEFAULT_FIXTURE_IDS = [
  'fixture-ts-service',
  'fixture-secret-noise',
  'fixture-graph-relations',
] as const;
const DEFAULT_PROFILE_IDS = ['profile-1024', 'profile-4096'] as const;
const MAX_FILE_LINES = 18;

const LIGHT_EMBEDDING_DISCLAIMER =
  'Deterministic hashed embeddings over fixture snippets only. This measures lane, scoring, and metric wiring, not semantic quality of the real embedding model.';

export const LIGHT_EMBEDDING_PROFILES: Record<LightEmbeddingProfileId, LightEmbeddingProfile> = {
  'profile-4096': {
    id: 'profile-4096',
    dimensions: 4096,
    laneMode: 'segmented',
    label: 'Deterministic 4096',
    description:
      'Uses separate hash lanes for path, symbol, content, and bigrams to preserve structural signal.',
  },
  'profile-1024': {
    id: 'profile-1024',
    dimensions: 1024,
    laneMode: 'shared',
    label: 'Deterministic 1024',
    description:
      'Compresses all token families into one shared hash space, increasing collisions and reducing exactness.',
  },
};

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function makeBigrams(tokens: string[]): string[] {
  const bigrams: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    bigrams.push(`${tokens[index]}_${tokens[index + 1]}`);
  }
  return bigrams;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addHashedTokens(
  vector: Float64Array,
  tokens: readonly string[],
  profile: LightEmbeddingProfile,
  laneIndex: number,
  weight: number
) {
  if (tokens.length === 0) {
    return;
  }

  if (profile.laneMode === 'segmented') {
    const laneCount = 4;
    const laneSize = Math.floor(profile.dimensions / laneCount);
    const laneOffset = Math.min(laneIndex, laneCount - 1) * laneSize;
    for (const token of tokens) {
      const slot = laneOffset + (fnv1a(token) % laneSize);
      vector[slot] += weight;
    }
    return;
  }

  for (const token of tokens) {
    const slot = fnv1a(`${laneIndex}:${token}`) % profile.dimensions;
    vector[slot] += weight;
  }
}

function buildVector(
  pathText: string,
  symbolText: string,
  contentText: string,
  profile: LightEmbeddingProfile
): HashedVector {
  const vector = new Float64Array(profile.dimensions);
  const pathTokens = tokenize(pathText);
  const symbolTokens = tokenize(symbolText);
  const contentTokens = tokenize(contentText);
  const bigramTokens = makeBigrams(contentTokens);

  addHashedTokens(vector, pathTokens, profile, 0, 2.2);
  addHashedTokens(vector, symbolTokens, profile, 1, 2);
  addHashedTokens(vector, contentTokens, profile, 2, 1);
  addHashedTokens(vector, bigramTokens, profile, 3, 0.9);

  let squaredNorm = 0;
  for (const value of vector) {
    squaredNorm += value * value;
  }

  return {
    dimensions: profile.dimensions,
    values: vector,
    norm: Math.sqrt(squaredNorm),
  };
}

function cosineSimilarity(left: HashedVector, right: HashedVector): number {
  if (left.norm === 0 || right.norm === 0) {
    return 0;
  }

  let dot = 0;
  for (let index = 0; index < left.dimensions; index += 1) {
    dot += left.values[index] * right.values[index];
  }

  return dot / (left.norm * right.norm);
}

function readFileLines(fixture: ProjectFixtureManifest, relativePath: string): string[] {
  const fixtureRoot = resolveFixtureRoot(fixture);
  return readFileSync(join(fixtureRoot, relativePath), 'utf-8').split(/\r?\n/);
}

function readExcerpt(
  fixture: ProjectFixtureManifest,
  path: string,
  startLine?: number,
  endLine?: number
): string {
  const lines = readFileLines(fixture, path);
  if (startLine !== undefined && endLine !== undefined) {
    return lines
      .slice(startLine - 1, endLine)
      .join('\n')
      .trim();
  }
  return lines.slice(0, MAX_FILE_LINES).join('\n').trim();
}

function makeDocumentKey(parts: {
  path: string;
  symbolName?: string;
  startLine?: number;
  endLine?: number;
  blocked: boolean;
}) {
  return [
    parts.path,
    parts.symbolName ?? 'file',
    parts.startLine ?? 'start',
    parts.endLine ?? 'end',
    parts.blocked ? 'blocked' : 'indexed',
  ].join(':');
}

function pushDocument(
  documents: Map<string, CorpusDocument>,
  fixture: ProjectFixtureManifest,
  args: {
    path: string;
    symbolName?: string;
    symbolKind?: string;
    startLine?: number;
    endLine?: number;
    blocked: boolean;
  }
) {
  const key = makeDocumentKey(args);
  if (documents.has(key)) {
    return;
  }

  const excerpt = readExcerpt(fixture, args.path, args.startLine, args.endLine);
  const textParts = [args.path, args.symbolName ?? '', args.symbolKind ?? '', excerpt].filter(
    (value) => value.length > 0
  );

  documents.set(key, {
    key,
    path: args.path,
    symbolName: args.symbolName,
    symbolKind: args.symbolKind,
    startLine: args.startLine,
    endLine: args.endLine,
    text: textParts.join('\n'),
    blocked: args.blocked,
  });
}

function buildCorpus(fixture: ProjectFixtureManifest): CorpusDocument[] {
  const documents = new Map<string, CorpusDocument>();

  for (const scenario of fixture.scenarios) {
    for (const target of scenario.expectedTargets) {
      pushDocument(documents, fixture, {
        path: target.path,
        symbolName: target.symbolName,
        symbolKind: target.symbolKind,
        startLine: target.lineRange?.start,
        endLine: target.lineRange?.end,
        blocked: false,
      });
    }

    for (const target of scenario.forbiddenTargets ?? []) {
      pushDocument(documents, fixture, {
        path: target.path,
        blocked: true,
      });
    }
  }

  for (const path of fixture.inventory.indexedPaths) {
    pushDocument(documents, fixture, {
      path,
      blocked: false,
    });
  }

  for (const path of fixture.inventory.blockedPaths ?? []) {
    pushDocument(documents, fixture, {
      path,
      blocked: true,
    });
  }

  return [...documents.values()];
}

function scenarioQueryText(scenario: ProjectEvalScenario): string {
  return [
    scenario.query,
    scenario.intent,
    ...(scenario.tags ?? []),
    ...(scenario.tuningHints ?? []),
  ].join('\n');
}

function simulateEmbeddingLatencyMs(
  profile: LightEmbeddingProfile,
  queryText: string,
  corpusSize: number
): number {
  const tokenCount = Math.max(1, tokenize(queryText).length);
  const dimensionFactor = profile.dimensions / 1024;
  return roundMetric(6 + tokenCount * (0.7 + dimensionFactor * 1.4) + corpusSize * 0.35);
}

function simulateLatencyMs(
  embeddingLatencyMs: number,
  corpusSize: number,
  topK: number,
  profile: LightEmbeddingProfile
): number {
  const rankingCost = corpusSize * (profile.laneMode === 'segmented' ? 0.42 : 0.28) + topK * 0.6;
  return roundMetric(embeddingLatencyMs + rankingCost);
}

function rankScenarioDocuments(args: {
  scenario: ProjectEvalScenario;
  profile: LightEmbeddingProfile;
  documents: CorpusDocument[];
  topK: number;
}): ProjectEvalRetrievedResult[] {
  const queryText = scenarioQueryText(args.scenario);
  const queryVector = buildVector(queryText, '', queryText, args.profile);

  return args.documents
    .filter((document) => !document.blocked)
    .map((document) => {
      const vector = buildVector(
        document.path,
        document.symbolName ?? '',
        document.text,
        args.profile
      );
      return {
        result: {
          path: document.path,
          score: roundMetric(cosineSimilarity(queryVector, vector)),
          ...(document.symbolName ? { symbolName: document.symbolName } : {}),
          ...(document.symbolKind ? { symbolKind: document.symbolKind } : {}),
          ...(document.startLine !== undefined ? { startLine: document.startLine } : {}),
          ...(document.endLine !== undefined ? { endLine: document.endLine } : {}),
          source: document.symbolName ? ('symbol' as const) : ('file' as const),
        },
        score: cosineSimilarity(queryVector, vector),
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, args.topK)
    .map((entry) => entry.result);
}

function buildFixtureProfileReport(
  fixture: ProjectFixtureManifest,
  profile: LightEmbeddingProfile,
  topK: number
): LightEmbeddingFixtureReport {
  const corpus = buildCorpus(fixture);
  const scenarioReports: LightEmbeddingScenarioReport[] = fixture.scenarios.map((scenario) => {
    const results = rankScenarioDocuments({
      scenario,
      profile,
      documents: corpus,
      topK,
    });
    const queryText = scenarioQueryText(scenario);
    const embeddingLatencyMs = simulateEmbeddingLatencyMs(profile, queryText, corpus.length);
    const latencyMs = simulateLatencyMs(embeddingLatencyMs, corpus.length, topK, profile);
    const evaluation = evaluateScenario(scenario, {
      scenarioId: scenario.id,
      latencyMs,
      endToEndLatencyMs: latencyMs,
      embeddingLatencyMs,
      results,
    });

    return {
      ...evaluation,
      fixtureId: fixture.id,
      profileId: profile.id,
      topPaths: results.map((result) => result.path),
    };
  });

  return {
    fixtureId: fixture.id,
    title: fixture.title,
    profileId: profile.id,
    dimensions: profile.dimensions,
    laneMode: profile.laneMode,
    corpusSize: corpus.length,
    indexedDocumentCount: corpus.filter((document) => !document.blocked).length,
    blockedDocumentCount: corpus.filter((document) => document.blocked).length,
    metrics: summarizeScenarioMetrics(scenarioReports),
    scenarios: scenarioReports,
  };
}

function summarizeProfileReports(
  profile: LightEmbeddingProfile,
  fixtureReports: LightEmbeddingFixtureReport[]
): LightEmbeddingProfileSummary {
  const allScenarios = fixtureReports.flatMap((report) => report.scenarios);
  return {
    profileId: profile.id,
    label: profile.label,
    dimensions: profile.dimensions,
    laneMode: profile.laneMode,
    fixtureIds: fixtureReports.map((report) => report.fixtureId),
    corpusSize: fixtureReports.reduce((sum, report) => sum + report.corpusSize, 0),
    scenarioCount: allScenarios.length,
    metrics: summarizeScenarioMetrics(allScenarios),
  };
}

function buildComparison(
  baseline: LightEmbeddingProfileSummary,
  candidate: LightEmbeddingProfileSummary
): LightEmbeddingComparison {
  return {
    baselineProfileId: baseline.profileId,
    candidateProfileId: candidate.profileId,
    deltas: {
      hitRate: roundMetric(candidate.metrics.hitRate - baseline.metrics.hitRate),
      exactPathRate: roundMetric(candidate.metrics.exactPathRate - baseline.metrics.exactPathRate),
      exactSymbolRate: roundMetric(
        candidate.metrics.exactSymbolRate - baseline.metrics.exactSymbolRate
      ),
      exactLineRate: roundMetric(candidate.metrics.exactLineRate - baseline.metrics.exactLineRate),
      avgQualityScore: roundMetric(
        candidate.metrics.avgQualityScore - baseline.metrics.avgQualityScore
      ),
      contaminationRate: roundMetric(
        candidate.metrics.contaminationRate - baseline.metrics.contaminationRate
      ),
      latencyP95Ms: roundMetric(candidate.metrics.latencyP95Ms - baseline.metrics.latencyP95Ms),
      embeddingLatencyP95Ms: roundMetric(
        (candidate.metrics.embeddingLatencyP95Ms ?? 0) -
          (baseline.metrics.embeddingLatencyP95Ms ?? 0)
      ),
    },
  };
}

function resolveFixtures(fixtureIds: readonly string[]): ProjectFixtureManifest[] {
  return fixtureIds.map((fixtureId) => {
    const fixture = getProjectFixture(fixtureId);
    if (!fixture) {
      throw new Error(`Unknown fixture: ${fixtureId}`);
    }
    return fixture;
  });
}

export function runLightProjectEmbeddingProfileBenchmark(
  options: LightEmbeddingBenchmarkOptions = {}
): LightEmbeddingBenchmarkReport {
  const fixtureIds = options.fixtureIds ?? [...DEFAULT_FIXTURE_IDS];
  const profileIds = options.profileIds ?? [...DEFAULT_PROFILE_IDS];
  const topK = options.topK ?? DEFAULT_TOP_K;
  const fixtures = resolveFixtures(fixtureIds);
  const profiles = profileIds.map((profileId) => LIGHT_EMBEDDING_PROFILES[profileId]);

  const fixtureReports = profiles.flatMap((profile) =>
    fixtures.map((fixture) => buildFixtureProfileReport(fixture, profile, topK))
  );
  const profileSummaries = profiles.map((profile) =>
    summarizeProfileReports(
      profile,
      fixtureReports.filter((report) => report.profileId === profile.id)
    )
  );

  if (profileSummaries.length !== 2) {
    throw new Error('Light embedding benchmark expects exactly two profiles for comparison.');
  }

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode: 'light',
    disclaimer: LIGHT_EMBEDDING_DISCLAIMER,
    fixtures: fixtureIds,
    profiles: profileSummaries,
    fixtureReports,
    comparison: buildComparison(profileSummaries[0], profileSummaries[1]),
  };
}

function formatMetricBlock(summary: LightEmbeddingProfileSummary): string[] {
  return [
    `${summary.profileId} (${summary.dimensions}d, ${summary.laneMode})`,
    `  hitRate=${summary.metrics.hitRate.toFixed(3)} exactPath=${summary.metrics.exactPathRate.toFixed(3)} exactSymbol=${summary.metrics.exactSymbolRate.toFixed(3)} exactLine=${summary.metrics.exactLineRate.toFixed(3)}`,
    `  quality=${summary.metrics.avgQualityScore.toFixed(3)} contamination=${summary.metrics.contaminationRate.toFixed(3)} latencyP95=${summary.metrics.latencyP95Ms.toFixed(1)}ms embeddingP95=${(summary.metrics.embeddingLatencyP95Ms ?? 0).toFixed(1)}ms`,
    `  fixtures=${summary.fixtureIds.join(', ')} scenarios=${summary.scenarioCount} corpusDocs=${summary.corpusSize}`,
  ];
}

export function formatLightProjectEmbeddingProfileBenchmark(
  report: LightEmbeddingBenchmarkReport
): string {
  const lines: string[] = [];
  lines.push('Project RAG Light Embedding Profile Benchmark');
  lines.push('============================================');
  lines.push(report.disclaimer);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Fixtures: ${report.fixtures.join(', ')}`);
  lines.push('');
  lines.push('Profile summaries');
  lines.push('-----------------');
  for (const profile of report.profiles) {
    lines.push(...formatMetricBlock(profile));
  }
  lines.push('');
  lines.push('Comparison');
  lines.push('----------');
  lines.push(
    `${report.comparison.candidateProfileId} - ${report.comparison.baselineProfileId}: hitRate=${report.comparison.deltas.hitRate >= 0 ? '+' : ''}${report.comparison.deltas.hitRate.toFixed(3)} exactPath=${report.comparison.deltas.exactPathRate >= 0 ? '+' : ''}${report.comparison.deltas.exactPathRate.toFixed(3)} exactSymbol=${report.comparison.deltas.exactSymbolRate >= 0 ? '+' : ''}${report.comparison.deltas.exactSymbolRate.toFixed(3)} latencyP95=${report.comparison.deltas.latencyP95Ms >= 0 ? '+' : ''}${report.comparison.deltas.latencyP95Ms.toFixed(1)}ms`
  );
  lines.push('');
  lines.push('Fixture detail');
  lines.push('-------------');
  for (const fixtureReport of report.fixtureReports) {
    lines.push(
      `${fixtureReport.fixtureId}/${fixtureReport.profileId}: hitRate=${fixtureReport.metrics.hitRate.toFixed(3)} exactPath=${fixtureReport.metrics.exactPathRate.toFixed(3)} exactSymbol=${fixtureReport.metrics.exactSymbolRate.toFixed(3)} contamination=${fixtureReport.metrics.contaminationRate.toFixed(3)}`
    );
  }
  return lines.join('\n');
}
