import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatErrorForOutput,
  redactCredentialText,
} from '../../../lib/shared/credential-redact.js';
import { checkLlamaCppGpuOffloadDuringRequest } from '../../check-embedding-health.js';
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

export type RealEmbeddingProfileId = 'qwen3-8b-4096' | 'qwen3-0.6b-1024';
export type RealEmbeddingProfileStatus = 'passed' | 'blocked' | 'failed' | 'dry-run';

export interface RealEmbeddingProfileConfig {
  readonly id: RealEmbeddingProfileId;
  readonly label: string;
  readonly expectedDimensions: 4096 | 1024;
  readonly baseUrl?: string;
  readonly model: string;
  readonly modelPath?: string;
}

export interface RealEmbeddingScenarioReport extends ProjectScenarioEvaluation {
  fixtureId: string;
  profileId: RealEmbeddingProfileId;
  topPaths: string[];
}

export interface RealEmbeddingProfileReport {
  profileId: RealEmbeddingProfileId;
  label: string;
  expectedDimensions: 4096 | 1024;
  status: RealEmbeddingProfileStatus;
  endpoint?: string;
  model: string;
  modelPath?: string;
  blockReason?: string;
  error?: string;
  fixtureIds: string[];
  corpusSize: number;
  scenarioCount: number;
  indexEmbeddingLatencyMs?: number;
  metrics?: ProjectVariantMetrics;
  scenarios: RealEmbeddingScenarioReport[];
}

export interface RealEmbeddingComparison {
  baselineProfileId: RealEmbeddingProfileId;
  candidateProfileId: RealEmbeddingProfileId;
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

export interface RealEmbeddingBenchmarkReport {
  generatedAt: string;
  mode: 'real-provider';
  dryRun: boolean;
  disclaimer: string;
  fixtures: string[];
  profiles: RealEmbeddingProfileReport[];
  comparison?: RealEmbeddingComparison;
}

export interface RealEmbeddingBenchmarkOptions {
  fixtureIds?: string[];
  profileIds?: RealEmbeddingProfileId[];
  topK?: number;
  timeoutMs?: number;
  generatedAt?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
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

interface EmbeddedDocument extends CorpusDocument {
  embedding: number[];
}

interface EmbeddingBatchResult {
  embeddings: number[][];
  elapsedMs: number;
}

const DEFAULT_FIXTURE_IDS = ['fixture-ts-service'] as const;
const DEFAULT_PROFILE_IDS = ['qwen3-0.6b-1024', 'qwen3-8b-4096'] as const;
const DEFAULT_TOP_K = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FILE_LINES = 18;
const REAL_BENCHMARK_DISCLAIMER =
  'Uses an already-running embedding endpoint over small Project RAG fixtures. It does not start llama-server, download models, run Convex ingest, or truncate dimensions.';

function firstEnv(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, '');
}

export function resolveRealEmbeddingProfiles(
  env: NodeJS.ProcessEnv = process.env
): Record<RealEmbeddingProfileId, RealEmbeddingProfileConfig> {
  return {
    'qwen3-8b-4096': {
      id: 'qwen3-8b-4096',
      label: 'Qwen3 Embedding 8B 4096D',
      expectedDimensions: 4096,
      baseUrl:
        normalizeBaseUrl(
          firstEnv(env, ['PROJECT_RAG_4096_BASE_URL', 'LLAMACPP_BASE_URL', 'RAG_LLAMACPP_BASE_URL'])
        ) ?? 'http://127.0.0.1:8081',
      model:
        firstEnv(env, ['PROJECT_RAG_4096_MODEL', 'LLAMACPP_EMBEDDING_MODEL', 'EMBEDDING_MODEL']) ??
        'qwen3-embedding',
      modelPath: firstEnv(env, [
        'PROJECT_RAG_4096_MODEL_PATH',
        'LLAMACPP_MODEL_PATH',
        'EMBEDDING_MODEL_PATH',
      ]),
    },
    'qwen3-0.6b-1024': {
      id: 'qwen3-0.6b-1024',
      label: 'Qwen3 Embedding 0.6B 1024D',
      expectedDimensions: 1024,
      baseUrl: normalizeBaseUrl(
        firstEnv(env, [
          'PROJECT_RAG_1024_BASE_URL',
          'LLAMACPP_1024_BASE_URL',
          'PROJECT_RAG_1024_LLAMACPP_BASE_URL',
        ])
      ),
      model:
        firstEnv(env, [
          'PROJECT_RAG_1024_MODEL',
          'LLAMACPP_1024_EMBEDDING_MODEL',
          'PROJECT_RAG_1024_EMBEDDING_MODEL',
        ]) ?? 'qwen3-embedding-1024',
      modelPath: firstEnv(env, [
        'PROJECT_RAG_1024_MODEL_PATH',
        'LLAMACPP_1024_MODEL_PATH',
        'PROJECT_RAG_1024_LLAMACPP_MODEL_PATH',
      ]),
    },
  };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
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

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkEndpoint(
  profile: RealEmbeddingProfileConfig,
  timeoutMs: number
): Promise<void> {
  if (!profile.baseUrl) {
    throw new Error(
      profile.expectedDimensions === 1024
        ? 'No 1024D endpoint configured. Set PROJECT_RAG_1024_BASE_URL to an already-running GPU llama.cpp server for qwen3-0.6b-1024.'
        : 'No 4096D endpoint configured. Set LLAMACPP_BASE_URL or PROJECT_RAG_4096_BASE_URL.'
    );
  }

  const response = await fetchWithTimeout(
    `${profile.baseUrl}/health`,
    { method: 'GET' },
    timeoutMs
  );
  if (!response.ok) {
    throw new Error(`Endpoint health failed: HTTP ${response.status} ${response.statusText}`);
  }

  const observed = await checkLlamaCppGpuOffloadDuringRequest('llamacpp', profile.baseUrl, () =>
    embedTexts(profile, ['GPU readiness probe'], timeoutMs)
  );
  const gpuCheck = observed.gpu;
  if (!gpuCheck.ok) {
    throw new Error(
      `Endpoint GPU proof failed for ${profile.id}: ${gpuCheck.message}${
        gpuCheck.details ? ` (${gpuCheck.details})` : ''
      }`
    );
  }
}

async function embedTexts(
  profile: RealEmbeddingProfileConfig,
  texts: string[],
  timeoutMs: number
): Promise<EmbeddingBatchResult> {
  if (!profile.baseUrl) {
    throw new Error(`Profile ${profile.id} has no endpoint configured`);
  }

  const startedAt = Date.now();
  const response = await fetchWithTimeout(
    `${profile.baseUrl}/v1/embeddings`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: profile.model,
        input: texts,
      }),
    },
    timeoutMs
  );
  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Embedding request failed: HTTP ${response.status} ${body.slice(0, 240)}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: unknown }>;
  };
  const rows = payload.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(`Embedding provider returned ${rows.length} rows; expected ${texts.length}`);
  }

  const embeddings = rows.map((row, index) => {
    if (!Array.isArray(row.embedding)) {
      throw new Error(`Embedding provider returned invalid embedding at index ${index}`);
    }
    const embedding = row.embedding;
    if (embedding.length !== profile.expectedDimensions) {
      throw new Error(
        `Embedding dimension mismatch for ${profile.id}: endpoint returned ${embedding.length}, expected ${profile.expectedDimensions}`
      );
    }
    return embedding.map((value) => Number(value));
  });

  return { embeddings, elapsedMs };
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function rankScenarioDocuments(args: {
  queryEmbedding: number[];
  documents: EmbeddedDocument[];
  topK: number;
}): ProjectEvalRetrievedResult[] {
  return args.documents
    .filter((document) => !document.blocked)
    .map((document) => ({
      result: {
        path: document.path,
        score: roundMetric(cosineSimilarity(args.queryEmbedding, document.embedding)),
        ...(document.symbolName ? { symbolName: document.symbolName } : {}),
        ...(document.symbolKind ? { symbolKind: document.symbolKind } : {}),
        ...(document.startLine !== undefined ? { startLine: document.startLine } : {}),
        ...(document.endLine !== undefined ? { endLine: document.endLine } : {}),
        source: document.symbolName ? ('symbol' as const) : ('file' as const),
      },
      score: cosineSimilarity(args.queryEmbedding, document.embedding),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, args.topK)
    .map((entry) => entry.result);
}

async function buildProfileReport(args: {
  profile: RealEmbeddingProfileConfig;
  fixtures: ProjectFixtureManifest[];
  topK: number;
  timeoutMs: number;
}): Promise<RealEmbeddingProfileReport> {
  const { profile, fixtures, topK, timeoutMs } = args;
  const scenarioReports: RealEmbeddingScenarioReport[] = [];
  let corpusSize = 0;
  let indexEmbeddingLatencyMs = 0;

  try {
    await checkEndpoint(profile, timeoutMs);

    for (const fixture of fixtures) {
      const corpus = buildCorpus(fixture);
      corpusSize += corpus.length;
      const embeddingInputs = corpus.map((document) => document.text);
      const embeddedCorpusResult = await embedTexts(profile, embeddingInputs, timeoutMs);
      indexEmbeddingLatencyMs += embeddedCorpusResult.elapsedMs;
      const embeddedDocuments: EmbeddedDocument[] = corpus.map((document, index) => ({
        ...document,
        embedding: embeddedCorpusResult.embeddings[index] ?? [],
      }));

      for (const scenario of fixture.scenarios) {
        const queryText = scenarioQueryText(scenario);
        const queryEmbeddingResult = await embedTexts(profile, [queryText], timeoutMs);
        const results = rankScenarioDocuments({
          queryEmbedding: queryEmbeddingResult.embeddings[0] ?? [],
          documents: embeddedDocuments,
          topK,
        });
        const latencyMs = queryEmbeddingResult.elapsedMs;
        const evaluation = evaluateScenario(scenario, {
          scenarioId: scenario.id,
          latencyMs,
          endToEndLatencyMs: latencyMs,
          embeddingLatencyMs: queryEmbeddingResult.elapsedMs,
          results,
        });

        scenarioReports.push({
          ...evaluation,
          fixtureId: fixture.id,
          profileId: profile.id,
          topPaths: results.map((result) => result.path),
        });
      }
    }

    return {
      profileId: profile.id,
      label: profile.label,
      expectedDimensions: profile.expectedDimensions,
      status: 'passed',
      endpoint: profile.baseUrl ? redactCredentialText(profile.baseUrl) : undefined,
      model: profile.model,
      modelPath: profile.modelPath,
      fixtureIds: fixtures.map((fixture) => fixture.id),
      corpusSize,
      scenarioCount: scenarioReports.length,
      indexEmbeddingLatencyMs,
      metrics: summarizeScenarioMetrics(scenarioReports),
      scenarios: scenarioReports,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked =
      message.includes('No 1024D endpoint configured') ||
      message.includes('No 4096D endpoint configured') ||
      message.includes('dimension mismatch') ||
      message.includes('GPU proof failed') ||
      message.includes('Endpoint health failed') ||
      message.includes('fetch failed') ||
      message.includes('ECONNREFUSED') ||
      message.includes('Unable to connect');
    const safeMessage = formatErrorForOutput(error);

    return {
      profileId: profile.id,
      label: profile.label,
      expectedDimensions: profile.expectedDimensions,
      status: blocked ? 'blocked' : 'failed',
      endpoint: profile.baseUrl ? redactCredentialText(profile.baseUrl) : undefined,
      model: profile.model,
      modelPath: profile.modelPath,
      blockReason: blocked ? safeMessage : undefined,
      error: blocked ? undefined : safeMessage,
      fixtureIds: fixtures.map((fixture) => fixture.id),
      corpusSize,
      scenarioCount: scenarioReports.length,
      indexEmbeddingLatencyMs,
      scenarios: scenarioReports,
    };
  }
}

function buildDryRunProfileReport(
  profile: RealEmbeddingProfileConfig,
  fixtures: ProjectFixtureManifest[]
): RealEmbeddingProfileReport {
  const corpusSize = fixtures.reduce((total, fixture) => total + buildCorpus(fixture).length, 0);
  const scenarioCount = fixtures.reduce((total, fixture) => total + fixture.scenarios.length, 0);

  return {
    profileId: profile.id,
    label: profile.label,
    expectedDimensions: profile.expectedDimensions,
    status: 'dry-run',
    endpoint: profile.baseUrl ? redactCredentialText(profile.baseUrl) : undefined,
    model: profile.model,
    modelPath: profile.modelPath,
    blockReason: 'dry-run: endpoint was not contacted',
    fixtureIds: fixtures.map((fixture) => fixture.id),
    corpusSize,
    scenarioCount,
    scenarios: [],
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

function buildComparison(
  baseline: RealEmbeddingProfileReport,
  candidate: RealEmbeddingProfileReport
): RealEmbeddingComparison | undefined {
  if (!baseline.metrics || !candidate.metrics) {
    return undefined;
  }

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

export async function runRealProjectEmbeddingProfileBenchmark(
  options: RealEmbeddingBenchmarkOptions = {}
): Promise<RealEmbeddingBenchmarkReport> {
  const fixtureIds = options.fixtureIds ?? [...DEFAULT_FIXTURE_IDS];
  const profileIds = options.profileIds ?? [...DEFAULT_PROFILE_IDS];
  const topK = options.topK ?? DEFAULT_TOP_K;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dryRun = options.dryRun ?? false;
  const profileConfigs = resolveRealEmbeddingProfiles(options.env);
  const fixtures = resolveFixtures(fixtureIds);

  const profiles: RealEmbeddingProfileReport[] = [];
  for (const profileId of profileIds) {
    const profile = profileConfigs[profileId];
    if (!profile) {
      throw new Error(`Unknown real embedding profile: ${profileId}`);
    }
    profiles.push(
      dryRun
        ? buildDryRunProfileReport(profile, fixtures)
        : await buildProfileReport({ profile, fixtures, topK, timeoutMs })
    );
  }

  const baseline = profiles.find((profile) => profile.profileId === 'qwen3-0.6b-1024');
  const candidate = profiles.find((profile) => profile.profileId === 'qwen3-8b-4096');

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode: 'real-provider',
    dryRun,
    disclaimer: REAL_BENCHMARK_DISCLAIMER,
    fixtures: fixtureIds,
    profiles,
    comparison:
      baseline && candidate && baseline.status === 'passed' && candidate.status === 'passed'
        ? buildComparison(baseline, candidate)
        : undefined,
  };
}

function formatProfileReport(profile: RealEmbeddingProfileReport): string[] {
  const lines = [
    `${profile.profileId} (${profile.expectedDimensions}d): ${profile.status}`,
    `  endpoint=${profile.endpoint ?? '<not configured>'}`,
    `  model=${profile.model}`,
  ];
  if (profile.modelPath) {
    lines.push(`  modelPath=${profile.modelPath}`);
  }
  if (profile.blockReason) {
    lines.push(`  blocked=${profile.blockReason}`);
  }
  if (profile.error) {
    lines.push(`  error=${profile.error}`);
  }
  if (profile.metrics) {
    lines.push(
      `  hitRate=${profile.metrics.hitRate.toFixed(3)} exactPath=${profile.metrics.exactPathRate.toFixed(3)} exactSymbol=${profile.metrics.exactSymbolRate.toFixed(3)} quality=${profile.metrics.avgQualityScore.toFixed(3)} latencyP95=${profile.metrics.latencyP95Ms.toFixed(1)}ms`
    );
    lines.push(
      `  scenarios=${profile.scenarioCount} corpusDocs=${profile.corpusSize} indexEmbedding=${(profile.indexEmbeddingLatencyMs ?? 0).toFixed(1)}ms`
    );
  }
  return lines;
}

export function formatRealProjectEmbeddingProfileBenchmark(
  report: RealEmbeddingBenchmarkReport
): string {
  const lines = [
    'Project RAG Real Embedding Profile Benchmark',
    '============================================',
    report.disclaimer,
    '',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.dryRun ? 'dry-run' : 'live-provider'}`,
    `Fixtures: ${report.fixtures.join(', ')}`,
    '',
    'Profile summaries',
    '-----------------',
  ];

  for (const profile of report.profiles) {
    lines.push(...formatProfileReport(profile));
  }

  if (report.comparison) {
    lines.push('');
    lines.push('Comparison');
    lines.push('----------');
    lines.push(
      `${report.comparison.candidateProfileId} - ${report.comparison.baselineProfileId}: hitRate=${report.comparison.deltas.hitRate >= 0 ? '+' : ''}${report.comparison.deltas.hitRate.toFixed(3)} exactPath=${report.comparison.deltas.exactPathRate >= 0 ? '+' : ''}${report.comparison.deltas.exactPathRate.toFixed(3)} latencyP95=${report.comparison.deltas.latencyP95Ms >= 0 ? '+' : ''}${report.comparison.deltas.latencyP95Ms.toFixed(1)}ms`
    );
  }

  return lines.join('\n');
}
