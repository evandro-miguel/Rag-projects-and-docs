import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatErrorForOutput,
  redactCredentialText,
} from '../../../lib/shared/credential-redact.js';
import { checkLlamaCppGpuOffloadDuringRequest } from '../../check-embedding-health.js';

export type DocsRealEmbeddingProfileId = 'qwen3-8b-4096' | 'qwen3-0.6b-1024';
export type DocsRealBenchmarkStatus = 'passed' | 'blocked' | 'failed' | 'dry-run';

export interface DocsRealEmbeddingProfileConfig {
  readonly id: DocsRealEmbeddingProfileId;
  readonly label: string;
  readonly expectedDimensions: 4096 | 1024;
  readonly baseUrl?: string;
  readonly model: string;
}

export interface DocsRealBenchmarkOptions {
  readonly profileIds?: DocsRealEmbeddingProfileId[];
  readonly topK?: number;
  readonly timeoutMs?: number;
  readonly generatedAt?: string;
  readonly dryRun?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxChunksPerDocument?: number;
  readonly embeddingBatchSize?: number;
}

interface DocsBenchmarkDocument {
  readonly path: string;
  readonly title: string;
}

interface DocsBenchmarkScenario {
  readonly id: string;
  readonly query: string;
  readonly expectedPaths: string[];
}

interface DocsChunk {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly text: string;
}

interface EmbeddedDocsChunk extends DocsChunk {
  readonly embedding: number[];
}

interface EmbeddingBatchResult {
  readonly embeddings: number[][];
  readonly elapsedMs: number;
}

export interface DocsRealRetrievedResult {
  readonly path: string;
  readonly title: string;
  readonly chunkId: string;
  readonly score: number;
}

export interface DocsRealScenarioReport {
  readonly id: string;
  readonly query: string;
  readonly expectedPaths: string[];
  readonly success: boolean;
  readonly firstRelevantRank: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
  readonly top1PathHit: boolean;
  readonly queryEmbeddingLatencyMs: number;
  readonly rankingLatencyMs: number;
  readonly topResults: DocsRealRetrievedResult[];
}

export interface DocsRealMetrics {
  readonly scenarioCount: number;
  readonly hitRate: number;
  readonly top1PathRate: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
  readonly queryEmbeddingLatencyP95Ms: number;
  readonly rankingLatencyP95Ms: number;
}

export interface DocsRealProfileReport {
  readonly profileId: DocsRealEmbeddingProfileId;
  readonly label: string;
  readonly expectedDimensions: 4096 | 1024;
  readonly status: DocsRealBenchmarkStatus;
  readonly endpoint?: string;
  readonly model: string;
  readonly blockReason?: string;
  readonly error?: string;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly scenarioCount: number;
  readonly corpusEmbeddingLatencyMs?: number;
  readonly metrics?: DocsRealMetrics;
  readonly scenarios: DocsRealScenarioReport[];
}

export interface DocsRealBenchmarkReport {
  readonly generatedAt: string;
  readonly mode: 'real-docs-provider';
  readonly dryRun: boolean;
  readonly disclaimer: string;
  readonly documents: DocsBenchmarkDocument[];
  readonly profiles: DocsRealProfileReport[];
}

const REPO_ROOT = process.cwd();
const DOCS_ROOT = join(REPO_ROOT, 'ingest/processed/external/bun-docs');
const DEFAULT_PROFILE_IDS: DocsRealEmbeddingProfileId[] = ['qwen3-0.6b-1024', 'qwen3-8b-4096'];
const DEFAULT_TOP_K = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CHUNKS_PER_DOCUMENT = 8;
const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
const MAX_CHUNK_CHARS = 1_800;
const CHUNK_OVERLAP_CHARS = 180;

const DISCLAIMER =
  'Uses already processed real Bun docs from ingest/processed/external with an already-running embedding endpoint. It does not start llama-server or ingest documents.';

const DOCUMENTS: DocsBenchmarkDocument[] = [
  { path: 'runtime/http/server.mdx', title: 'Bun HTTP server' },
  { path: 'runtime/file-io.mdx', title: 'Bun file I/O' },
  { path: 'runtime/shell.mdx', title: 'Bun shell' },
  { path: 'runtime/workers.mdx', title: 'Bun workers' },
  { path: 'runtime/bunfig.mdx', title: 'Bun configuration' },
  { path: 'pm/workspaces.mdx', title: 'Bun workspaces' },
  { path: 'bundler/plugins.mdx', title: 'Bun bundler plugins' },
  { path: 'pm/lockfile.mdx', title: 'Bun lockfile' },
  { path: 'runtime/debugger.mdx', title: 'Bun debugger' },
];

const SCENARIOS: DocsBenchmarkScenario[] = [
  {
    id: 'docs-bun-server',
    query: 'Bun.serve routes fetch Response HTTP server',
    expectedPaths: ['runtime/http/server.mdx'],
  },
  {
    id: 'docs-bun-file-io',
    query: 'Bun.file read write file system FileSink',
    expectedPaths: ['runtime/file-io.mdx'],
  },
  {
    id: 'docs-bun-shell',
    query: 'Bun shell dollar command escaped template',
    expectedPaths: ['runtime/shell.mdx'],
  },
  {
    id: 'docs-bun-workers',
    query: 'Worker thread Bun worker postMessage',
    expectedPaths: ['runtime/workers.mdx'],
  },
  {
    id: 'docs-bun-config',
    query: 'bunfig.toml configure preload logLevel telemetry',
    expectedPaths: ['runtime/bunfig.mdx'],
  },
  {
    id: 'docs-bun-workspaces',
    query: 'workspaces package manager monorepo package.json',
    expectedPaths: ['pm/workspaces.mdx'],
  },
  {
    id: 'docs-bun-bundler-plugins',
    query: 'bundler plugin setup onResolve onLoad',
    expectedPaths: ['bundler/plugins.mdx'],
  },
  {
    id: 'docs-bun-lockfile',
    query: 'bun lockfile bun.lock package manager frozen lockfile',
    expectedPaths: ['pm/lockfile.mdx'],
  },
  {
    id: 'docs-bun-debugger',
    query: 'debugger inspect breakpoints Chrome DevTools',
    expectedPaths: ['runtime/debugger.mdx'],
  },
];

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
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

export function resolveDocsRealEmbeddingProfiles(
  env: NodeJS.ProcessEnv = process.env
): Record<DocsRealEmbeddingProfileId, DocsRealEmbeddingProfileConfig> {
  return {
    'qwen3-8b-4096': {
      id: 'qwen3-8b-4096',
      label: 'Qwen3 Embedding 8B 4096D',
      expectedDimensions: 4096,
      baseUrl:
        normalizeBaseUrl(
          firstEnv(env, ['DOCS_RAG_4096_BASE_URL', 'LLAMACPP_BASE_URL', 'RAG_LLAMACPP_BASE_URL'])
        ) ?? 'http://127.0.0.1:8081',
      model:
        firstEnv(env, ['DOCS_RAG_4096_MODEL', 'LLAMACPP_EMBEDDING_MODEL', 'EMBEDDING_MODEL']) ??
        'qwen3-embedding',
    },
    'qwen3-0.6b-1024': {
      id: 'qwen3-0.6b-1024',
      label: 'Qwen3 Embedding 0.6B 1024D',
      expectedDimensions: 1024,
      baseUrl:
        normalizeBaseUrl(
          firstEnv(env, [
            'DOCS_RAG_1024_BASE_URL',
            'PROJECT_RAG_1024_BASE_URL',
            'LLAMACPP_1024_BASE_URL',
          ])
        ) ?? 'http://127.0.0.1:8082',
      model:
        firstEnv(env, [
          'DOCS_RAG_1024_MODEL',
          'PROJECT_RAG_1024_MODEL',
          'LLAMACPP_1024_EMBEDDING_MODEL',
        ]) ?? 'qwen3-embedding-1024',
    },
  };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
}

function normalizeMarkdown(markdown: string): string {
  return stripFrontmatter(markdown)
    .replace(/```[\s\S]*?```/g, (block) => block.slice(0, 1_200))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitWithOverlap(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const next = text.slice(offset, offset + maxChars);
    chunks.push(next.trim());
    if (offset + maxChars >= text.length) {
      break;
    }
    offset += maxChars - overlapChars;
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function chunkDocument(document: DocsBenchmarkDocument, maxChunksPerDocument: number): DocsChunk[] {
  const absolutePath = join(DOCS_ROOT, document.path);
  const text = normalizeMarkdown(readFileSync(absolutePath, 'utf-8'));
  const sections = text
    .split(/\n(?=#{1,4}\s+)/g)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  const sourceSections = sections.length > 0 ? sections : [text];
  const chunks: DocsChunk[] = [];

  for (const [sectionIndex, section] of sourceSections.entries()) {
    for (const [partIndex, part] of splitWithOverlap(
      section,
      MAX_CHUNK_CHARS,
      CHUNK_OVERLAP_CHARS
    ).entries()) {
      chunks.push({
        id: `${document.path}#${sectionIndex + 1}.${partIndex + 1}`,
        path: document.path,
        title: document.title,
        text: `${document.title}\n${document.path}\n${part}`,
      });
      if (chunks.length >= maxChunksPerDocument) {
        return chunks;
      }
    }
  }

  return chunks;
}

function buildDocsCorpus(maxChunksPerDocument: number): DocsChunk[] {
  return DOCUMENTS.flatMap((document) => chunkDocument(document, maxChunksPerDocument));
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
  profile: DocsRealEmbeddingProfileConfig,
  timeoutMs: number
): Promise<void> {
  if (!profile.baseUrl) {
    throw new Error(
      profile.expectedDimensions === 1024
        ? 'No 1024D endpoint configured. Set DOCS_RAG_1024_BASE_URL or PROJECT_RAG_1024_BASE_URL to an already-running GPU llama.cpp server.'
        : 'No 4096D endpoint configured. Set DOCS_RAG_4096_BASE_URL or LLAMACPP_BASE_URL.'
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
    embedTexts(profile, ['GPU readiness probe'], timeoutMs, 1)
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
  profile: DocsRealEmbeddingProfileConfig,
  texts: readonly string[],
  timeoutMs: number,
  batchSize: number
): Promise<EmbeddingBatchResult> {
  if (!profile.baseUrl) {
    throw new Error(`Profile ${profile.id} has no endpoint configured`);
  }

  const embeddings: number[][] = [];
  let elapsedMs = 0;

  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const startedAt = Date.now();
    const response = await fetchWithTimeout(
      `${profile.baseUrl}/v1/embeddings`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: profile.model,
          input: batch,
        }),
      },
      timeoutMs
    );
    elapsedMs += Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Embedding request failed: HTTP ${response.status} ${body.slice(0, 240)}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const rows = payload.data ?? [];
    if (rows.length !== batch.length) {
      throw new Error(`Embedding provider returned ${rows.length} rows; expected ${batch.length}`);
    }

    for (const [index, row] of rows.entries()) {
      if (!Array.isArray(row.embedding)) {
        throw new Error(`Embedding provider returned invalid embedding at batch index ${index}`);
      }
      if (row.embedding.length !== profile.expectedDimensions) {
        throw new Error(
          `Embedding dimension mismatch for ${profile.id}: endpoint returned ${row.embedding.length}, expected ${profile.expectedDimensions}`
        );
      }
      embeddings.push(row.embedding.map((value) => Number(value)));
    }
  }

  return { embeddings, elapsedMs };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
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

function pathsMatch(resultPath: string, expectedPaths: readonly string[]): boolean {
  return expectedPaths.some((expectedPath) => resultPath === expectedPath);
}

function calculateNdcg(
  results: readonly DocsRealRetrievedResult[],
  expectedPaths: readonly string[]
): number {
  const relevanceScores: number[] = results.map((result) =>
    pathsMatch(result.path, expectedPaths) ? 1 : 0
  );
  const dcg = relevanceScores
    .slice(0, 10)
    .reduce((sum, relevance, index) => sum + relevance / Math.log2(index + 2), 0);
  const ideal = [...relevanceScores]
    .sort((left, right) => right - left)
    .slice(0, 10)
    .reduce((sum, relevance, index) => sum + relevance / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue));
  return sorted[index] ?? 0;
}

function rankChunks(args: {
  readonly queryEmbedding: readonly number[];
  readonly chunks: readonly EmbeddedDocsChunk[];
  readonly topK: number;
}): DocsRealRetrievedResult[] {
  return args.chunks
    .map((chunk) => {
      const score = cosineSimilarity(args.queryEmbedding, chunk.embedding);
      return {
        result: {
          path: chunk.path,
          title: chunk.title,
          chunkId: chunk.id,
          score: roundMetric(score),
        },
        score,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, args.topK)
    .map((entry) => entry.result);
}

function evaluateScenario(args: {
  readonly scenario: DocsBenchmarkScenario;
  readonly results: readonly DocsRealRetrievedResult[];
  readonly queryEmbeddingLatencyMs: number;
  readonly rankingLatencyMs: number;
}): DocsRealScenarioReport {
  const firstRelevantIndex = args.results.findIndex((result) =>
    pathsMatch(result.path, args.scenario.expectedPaths)
  );
  const firstRelevantRank = firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : 0;
  const mrr = firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;

  return {
    id: args.scenario.id,
    query: args.scenario.query,
    expectedPaths: args.scenario.expectedPaths,
    success: firstRelevantRank > 0,
    firstRelevantRank,
    mrr: roundMetric(mrr),
    ndcgAt10: roundMetric(calculateNdcg(args.results, args.scenario.expectedPaths)),
    top1PathHit:
      args.results[0] !== undefined &&
      pathsMatch(args.results[0].path, args.scenario.expectedPaths),
    queryEmbeddingLatencyMs: args.queryEmbeddingLatencyMs,
    rankingLatencyMs: args.rankingLatencyMs,
    topResults: [...args.results],
  };
}

function summarizeMetrics(scenarios: readonly DocsRealScenarioReport[]): DocsRealMetrics {
  const scenarioCount = scenarios.length;
  const queryLatencies = scenarios.map((scenario) => scenario.queryEmbeddingLatencyMs);
  const rankingLatencies = scenarios.map((scenario) => scenario.rankingLatencyMs);

  return {
    scenarioCount,
    hitRate:
      scenarioCount > 0
        ? scenarios.filter((scenario) => scenario.success).length / scenarioCount
        : 0,
    top1PathRate:
      scenarioCount > 0
        ? scenarios.filter((scenario) => scenario.top1PathHit).length / scenarioCount
        : 0,
    mrr:
      scenarioCount > 0
        ? scenarios.reduce((sum, scenario) => sum + scenario.mrr, 0) / scenarioCount
        : 0,
    ndcgAt10:
      scenarioCount > 0
        ? scenarios.reduce((sum, scenario) => sum + scenario.ndcgAt10, 0) / scenarioCount
        : 0,
    queryEmbeddingLatencyP95Ms: percentile(queryLatencies, 0.95),
    rankingLatencyP95Ms: percentile(rankingLatencies, 0.95),
  };
}

function isBlockedRuntimeError(message: string): boolean {
  return (
    message.includes('No 1024D endpoint configured') ||
    message.includes('No 4096D endpoint configured') ||
    message.includes('dimension mismatch') ||
    message.includes('GPU proof failed') ||
    message.includes('Endpoint health failed') ||
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('Unable to connect') ||
    message.includes('aborted')
  );
}

async function buildProfileReport(args: {
  readonly profile: DocsRealEmbeddingProfileConfig;
  readonly corpus: readonly DocsChunk[];
  readonly topK: number;
  readonly timeoutMs: number;
  readonly embeddingBatchSize: number;
}): Promise<DocsRealProfileReport> {
  const { profile, corpus, topK, timeoutMs, embeddingBatchSize } = args;

  try {
    await checkEndpoint(profile, timeoutMs);

    const corpusResult = await embedTexts(
      profile,
      corpus.map((chunk) => chunk.text),
      timeoutMs,
      embeddingBatchSize
    );
    const embeddedCorpus: EmbeddedDocsChunk[] = corpus.map((chunk, index) => ({
      ...chunk,
      embedding: corpusResult.embeddings[index] ?? [],
    }));
    const scenarioReports: DocsRealScenarioReport[] = [];

    for (const scenario of SCENARIOS) {
      const queryResult = await embedTexts(profile, [scenario.query], timeoutMs, 1);
      const rankingStartedAt = Date.now();
      const results = rankChunks({
        queryEmbedding: queryResult.embeddings[0] ?? [],
        chunks: embeddedCorpus,
        topK,
      });
      const rankingLatencyMs = Date.now() - rankingStartedAt;

      scenarioReports.push(
        evaluateScenario({
          scenario,
          results,
          queryEmbeddingLatencyMs: queryResult.elapsedMs,
          rankingLatencyMs,
        })
      );
    }

    return {
      profileId: profile.id,
      label: profile.label,
      expectedDimensions: profile.expectedDimensions,
      status: 'passed',
      endpoint: profile.baseUrl ? redactCredentialText(profile.baseUrl) : undefined,
      model: profile.model,
      documentCount: DOCUMENTS.length,
      chunkCount: corpus.length,
      scenarioCount: SCENARIOS.length,
      corpusEmbeddingLatencyMs: corpusResult.elapsedMs,
      metrics: summarizeMetrics(scenarioReports),
      scenarios: scenarioReports,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = isBlockedRuntimeError(message);
    const safeMessage = formatErrorForOutput(error);

    return {
      profileId: profile.id,
      label: profile.label,
      expectedDimensions: profile.expectedDimensions,
      status: blocked ? 'blocked' : 'failed',
      endpoint: profile.baseUrl ? redactCredentialText(profile.baseUrl) : undefined,
      model: profile.model,
      blockReason: blocked ? safeMessage : undefined,
      error: blocked ? undefined : safeMessage,
      documentCount: DOCUMENTS.length,
      chunkCount: corpus.length,
      scenarioCount: SCENARIOS.length,
      scenarios: [],
    };
  }
}

function buildDryRunProfileReport(
  profile: DocsRealEmbeddingProfileConfig,
  corpus: readonly DocsChunk[]
): DocsRealProfileReport {
  return {
    profileId: profile.id,
    label: profile.label,
    expectedDimensions: profile.expectedDimensions,
    status: 'dry-run',
    endpoint: profile.baseUrl ? redactCredentialText(profile.baseUrl) : undefined,
    model: profile.model,
    blockReason: 'dry-run: endpoint was not contacted',
    documentCount: DOCUMENTS.length,
    chunkCount: corpus.length,
    scenarioCount: SCENARIOS.length,
    scenarios: [],
  };
}

export async function runRealDocsRagBenchmark(
  options: DocsRealBenchmarkOptions = {}
): Promise<DocsRealBenchmarkReport> {
  const profileIds = options.profileIds ?? DEFAULT_PROFILE_IDS;
  const topK = options.topK ?? DEFAULT_TOP_K;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dryRun = options.dryRun ?? false;
  const maxChunksPerDocument = options.maxChunksPerDocument ?? DEFAULT_MAX_CHUNKS_PER_DOCUMENT;
  const embeddingBatchSize = options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
  const profiles = resolveDocsRealEmbeddingProfiles(options.env);
  const corpus = buildDocsCorpus(maxChunksPerDocument);
  const profileReports: DocsRealProfileReport[] = [];

  for (const profileId of profileIds) {
    const profile = profiles[profileId];
    if (!profile) {
      throw new Error(`Unknown Docs RAG real embedding profile: ${profileId}`);
    }
    profileReports.push(
      dryRun
        ? buildDryRunProfileReport(profile, corpus)
        : await buildProfileReport({
            profile,
            corpus,
            topK,
            timeoutMs,
            embeddingBatchSize,
          })
    );
  }

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode: 'real-docs-provider',
    dryRun,
    disclaimer: DISCLAIMER,
    documents: DOCUMENTS,
    profiles: profileReports,
  };
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? 'n/a' : roundMetric(value).toFixed(3);
}

export function formatRealDocsRagBenchmark(report: DocsRealBenchmarkReport): string {
  const lines = [
    'Docs RAG Real Embedding Benchmark',
    '=================================',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}${report.dryRun ? ' (dry-run)' : ''}`,
    `Corpus: ${report.documents.length} documents`,
    `Note: ${report.disclaimer}`,
    '',
  ];

  for (const profile of report.profiles) {
    lines.push(
      `${profile.profileId} [${profile.status}] ${profile.expectedDimensions}D endpoint=${profile.endpoint ?? '<not configured>'}`,
      `  docs=${profile.documentCount} chunks=${profile.chunkCount} scenarios=${profile.scenarioCount} corpusEmbeddingMs=${profile.corpusEmbeddingLatencyMs ?? 'n/a'}`
    );

    if (profile.metrics) {
      lines.push(
        `  hitRate=${formatMetric(profile.metrics.hitRate)} top1PathRate=${formatMetric(profile.metrics.top1PathRate)} mrr=${formatMetric(profile.metrics.mrr)} nDCG@10=${formatMetric(profile.metrics.ndcgAt10)} queryP95Ms=${formatMetric(profile.metrics.queryEmbeddingLatencyP95Ms)} rankP95Ms=${formatMetric(profile.metrics.rankingLatencyP95Ms)}`
      );
    }

    if (profile.blockReason) {
      lines.push(`  blocked=${profile.blockReason}`);
    }
    if (profile.error) {
      lines.push(`  error=${profile.error}`);
    }

    for (const scenario of profile.scenarios) {
      lines.push(
        `  - ${scenario.id}: ${scenario.success ? 'hit' : 'miss'} rank=${scenario.firstRelevantRank || 'n/a'} top=${scenario.topResults[0]?.path ?? '<none>'}`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
