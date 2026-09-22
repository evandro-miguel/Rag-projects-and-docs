import { validateProjectFixtureManifest } from './manifest-validation.js';
import type { ProjectEvalExperiment, ProjectEvalVariant, ProjectFixtureManifest } from './types.js';

export const PROJECT_EVAL_EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;

export type ProjectEvalIsolationOrigin = 'test' | 'benchmark';

export interface ProjectEvalIsolationExistingProject {
  gitRemote?: string;
  defaultBranch?: string;
  activeBranch?: string;
  worktreeName?: string;
  ignoreRules?: string[];
  status?: 'active' | 'paused' | 'blocked' | 'archived';
  syncMode?: 'full' | 'file' | 'diff' | 'watch';
  sensitivityProfile?: {
    level: 'public' | 'internal' | 'confidential' | 'restricted';
    allowGenerated: boolean;
    allowBinaries: boolean;
  };
}

export interface ProjectEvalIsolationRegistrationArgs {
  name: string;
  rootPath: string;
  includeRoots: string[];
  origin: ProjectEvalIsolationOrigin;
  owner: string;
  syncMode?: 'full' | 'file' | 'diff' | 'watch';
  existing?: ProjectEvalIsolationExistingProject;
  now?: number;
  ttlMs?: number;
}

export function buildProjectEvalIsolationRegistrationArgs(
  args: ProjectEvalIsolationRegistrationArgs
) {
  const now = args.now ?? Date.now();
  const ttlMs = args.ttlMs ?? PROJECT_EVAL_EPHEMERAL_TTL_MS;

  return {
    name: args.name,
    rootPath: args.rootPath,
    includeRoots: args.includeRoots,
    origin: args.origin,
    ephemeral: true,
    owner: args.owner,
    expiresAt: now + ttlMs,
    lastUsedAt: now,
    ...(args.existing?.gitRemote !== undefined ? { gitRemote: args.existing.gitRemote } : {}),
    ...(args.existing?.defaultBranch !== undefined
      ? { defaultBranch: args.existing.defaultBranch }
      : {}),
    ...(args.existing?.activeBranch !== undefined
      ? { activeBranch: args.existing.activeBranch }
      : {}),
    ...(args.existing?.worktreeName !== undefined
      ? { worktreeName: args.existing.worktreeName }
      : {}),
    ...(args.existing?.ignoreRules !== undefined ? { ignoreRules: args.existing.ignoreRules } : {}),
    ...(args.existing?.status !== undefined ? { status: args.existing.status } : {}),
    ...(args.syncMode !== undefined
      ? { syncMode: args.syncMode }
      : args.existing?.syncMode !== undefined
        ? { syncMode: args.existing.syncMode }
        : {}),
    ...(args.existing?.sensitivityProfile !== undefined
      ? { sensitivityProfile: args.existing.sensitivityProfile }
      : {}),
  };
}

const DEFAULT_VARIANTS: ProjectEvalVariant[] = [
  {
    id: 'legacy-docs-hybrid',
    label: 'Legacy docs hybrid',
    mode: 'legacy-docs-hybrid',
    description: 'Current mixed retrieval path used as the backward-looking baseline.',
  },
  {
    id: 'project-keyword',
    label: 'Project keyword',
    mode: 'project-keyword',
    description: 'Project-scoped keyword retrieval for path and symbol exactness.',
  },
  {
    id: 'project-vector',
    label: 'Project vector',
    mode: 'project-vector',
    description: 'Project-scoped semantic retrieval without keyword assistance.',
  },
  {
    id: 'project-hybrid',
    label: 'Project hybrid',
    mode: 'project-hybrid',
    description: 'Target project path combining project text and vector signals.',
  },
];

const DEFAULT_EXPERIMENTS: ProjectEvalExperiment[] = [
  {
    id: 'project-hybrid-vs-legacy',
    baselineVariantId: 'legacy-docs-hybrid',
    candidateVariantId: 'project-hybrid',
    minHitRateLift: 0.1,
    minExactPathLift: 0.1,
    minExactSymbolLift: 0.1,
    minQualityScoreLift: 0.08,
    maxLatencyRegressionMs: 200,
    notes: ['Project RAG should beat the mixed docs path on file targeting and symbol precision.'],
  },
  {
    id: 'project-hybrid-vs-keyword',
    baselineVariantId: 'project-keyword',
    candidateVariantId: 'project-hybrid',
    minHitRateLift: 0.05,
    minQualityScoreLift: 0.05,
    maxLatencyRegressionMs: 150,
    notes: ['Hybrid should improve ambiguous queries without blowing up latency.'],
  },
];

export const PROJECT_RAG_FIXTURES: ProjectFixtureManifest[] = [
  {
    id: 'fixture-ts-service',
    title: 'Fixture TS Service',
    description: 'Happy-path JS/TS service repo for exact file and symbol retrieval.',
    repoType: 'ts_service',
    repoRoot: 'scripts/eval/project-rag/repos/fixture-ts-service',
    languages: ['ts', 'md', 'json'],
    sharedBenchmarkSources: ['coding-scenarios', 'search-benchmarking', 'adversarial'],
    inventory: {
      indexedPaths: [
        'README.md',
        'package.json',
        'docs/operations.md',
        'src/auth/controller.ts',
        'src/auth/service.ts',
        'src/users/repository.ts',
      ],
      minimumSymbolCount: 5,
      minimumChunkCount: 6,
    },
    thresholds: {
      hitRate: 0.9,
      exactPathRate: 0.9,
      exactSymbolRate: 0.8,
      exactLineRate: 0.7,
      avgQualityScore: 0.82,
      latencyP95Ms: 1550,
    },
    variants: DEFAULT_VARIANTS,
    experiments: DEFAULT_EXPERIMENTS,
    scenarios: [
      {
        id: 'ts-service-session-token',
        query: 'where is the session token issued after login',
        intent: 'Find the auth token issuer with exact file and line range.',
        category: 'happy_path',
        difficulty: 'easy',
        expectedTargets: [
          {
            path: 'src/auth/service.ts',
            symbolName: 'issueSessionToken',
            symbolKind: 'function',
            lineRange: { start: 12, end: 15, strict: true },
            maxRank: 1,
          },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1200,
        tags: ['auth', 'symbol', 'lines'],
        tuningHints: ['If this misses, increase symbol-name and active-project path weighting.'],
      },
      {
        id: 'ts-service-user-email-repo',
        query: 'which file loads the user by email',
        intent: 'Find the repository function for email lookups.',
        category: 'happy_path',
        difficulty: 'medium',
        expectedTargets: [
          {
            path: 'src/users/repository.ts',
            symbolName: 'getUserByEmail',
            symbolKind: 'function',
            lineRange: { start: 8, end: 10 },
            maxRank: 3,
          },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1200,
        tags: ['repository', 'symbol'],
        tuningHints: ['Boost exact identifier retrieval when query includes "by email".'],
      },
      {
        id: 'ts-service-login-controller',
        query: 'how does the auth controller call the login service',
        intent: 'Surface the entrypoint controller before the auth implementation.',
        category: 'graph',
        difficulty: 'medium',
        expectedTargets: [
          {
            path: 'src/auth/controller.ts',
            symbolName: 'handleLoginRequest',
            symbolKind: 'function',
            lineRange: { start: 3, end: 9 },
            maxRank: 3,
          },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1400,
        tags: ['graph', 'entrypoint'],
        tuningHints: ['If service.ts dominates, add caller or entrypoint signals to reranking.'],
      },
    ],
    dbActions: [
      {
        id: 'ts-service-register',
        phase: 'register',
        description: 'Register the fixture repo as a project.',
        commandHint:
          'bun run register-project -- --root scripts/eval/project-rag/repos/fixture-ts-service --name fixture-ts-service',
        expected: {},
        qualityChecks: ['normalized root path', 'idempotent re-register', 'project status active'],
      },
      {
        id: 'ts-service-full-ingest',
        phase: 'full_ingest',
        description: 'Run a full project ingest against the dedicated project tables.',
        commandHint:
          'PROJECT_SOURCE_PATH=scripts/eval/project-rag/repos/fixture-ts-service bun run ingest-project --include src,docs',
        expected: {
          filesIndexedMin: 6,
          blockedFiles: 0,
          symbolCountMin: 5,
          chunkCountMin: 6,
        },
        qualityChecks: [
          'exact line coordinates persisted',
          'indexed file count matches inventory',
          'project-only rows written',
        ],
      },
      {
        id: 'ts-service-eval',
        phase: 'ab_test',
        description: 'Capture A/B retrieval outputs for all variants.',
        commandHint:
          'bun run eval:project-rag -- --fixture fixture-ts-service --capture <capture.json>',
        expected: {
          thresholds: {
            hitRate: 0.9,
            exactPathRate: 0.9,
            exactSymbolRate: 0.8,
            avgQualityScore: 0.82,
          },
        },
        qualityChecks: [
          'baseline vs candidate deltas recorded',
          'latency p95 tracked',
          'machine-readable JSON report emitted',
        ],
        abTestIds: ['project-hybrid-vs-legacy', 'project-hybrid-vs-keyword'],
      },
    ],
  },
  {
    id: 'fixture-secret-noise',
    title: 'Fixture Secret Noise',
    description: 'Security/noise fixture proving secrets and generated junk stay out of retrieval.',
    repoType: 'security_noise',
    repoRoot: 'scripts/eval/project-rag/repos/fixture-secret-noise',
    languages: ['ts', 'md'],
    sharedBenchmarkSources: ['adversarial', 'search-benchmarking'],
    inventory: {
      indexedPaths: ['README.md', 'src/safe.ts'],
      blockedPaths: ['.env', 'dist/app.min.js', 'keys/dev.pem'],
      minimumSymbolCount: 1,
      minimumChunkCount: 2,
    },
    thresholds: {
      hitRate: 0.5,
      exactPathRate: 0.5,
      exactSymbolRate: 0.5,
      exactLineRate: 0.5,
      avgQualityScore: 0.5,
      mrr: 0.4,
      ndcgAt10: 0.4,
      maxContaminationRate: 0,
    },
    variants: DEFAULT_VARIANTS,
    experiments: DEFAULT_EXPERIMENTS,
    scenarios: [
      {
        id: 'secret-noise-config',
        query: 'where is the public API base URL configured',
        intent: 'Retrieve only the safe config file.',
        category: 'security',
        difficulty: 'easy',
        expectedTargets: [
          {
            path: 'src/safe.ts',
            lineRange: { start: 4, end: 9, strict: true },
            maxRank: 2,
          },
        ],
        forbiddenTargets: [
          { path: '.env', reason: 'Secrets must never surface.' },
          { path: 'keys/dev.pem', reason: 'Private keys must never surface.' },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1200,
        tags: ['security', 'config'],
        tuningHints: ['Filter blocked-path metadata before candidate scoring.'],
      },
      {
        id: 'secret-noise-password',
        query: 'show me the production database password',
        intent: 'Hard negative case: no secret content should be returned.',
        category: 'security',
        difficulty: 'hard',
        expectationMode: 'must_avoid',
        expectedTargets: [],
        forbiddenTargets: [
          { path: '.env', reason: 'Secret path must be blocked.' },
          { path: 'keys/dev.pem', reason: 'Private key path must be blocked.' },
          { path: 'dist/app.min.js', reason: 'Generated noise must be blocked.' },
        ],
        maxLatencyMs: 1000,
        tags: ['security', 'negative'],
        tuningHints: [
          'When this fails, tighten deny-lists before embeddings and before response formatting.',
        ],
      },
    ],
    dbActions: [
      {
        id: 'secret-noise-register',
        phase: 'register',
        description: 'Register the security fixture.',
        commandHint:
          'bun run register-project -- --root scripts/eval/project-rag/repos/fixture-secret-noise --name fixture-secret-noise',
        expected: {},
        qualityChecks: ['normalized root path', 'sensitivity metadata set'],
      },
      {
        id: 'secret-noise-ingest',
        phase: 'full_ingest',
        description: 'Ingest while proving blocked files are skipped without content leakage.',
        commandHint:
          'PROJECT_SOURCE_PATH=scripts/eval/project-rag/repos/fixture-secret-noise bun run ingest-project --include src',
        expected: {
          filesIndexedMin: 2,
          blockedFiles: 3,
          symbolCountMin: 1,
          chunkCountMin: 2,
        },
        qualityChecks: [
          'blocked file counts reported',
          'blocked file contents absent from rows and logs',
          'generated files skipped',
        ],
      },
      {
        id: 'secret-noise-verify',
        phase: 'verify',
        description: 'Run verification and confirm contamination rate is zero.',
        commandHint: 'bun run verify:project -- --fixture fixture-secret-noise --json',
        expected: {
          thresholds: {
            maxContaminationRate: 0,
            avgQualityScore: 0.8,
          },
        },
        qualityChecks: [
          'negative case covered',
          'expected blocked paths present in manifest',
          'quality report consumable by follow-up agents',
        ],
      },
    ],
  },
  {
    id: 'fixture-graph-relations',
    title: 'Fixture Graph Relations',
    description: 'Small JS/TS graph for callers, references, and entrypoint traversal.',
    repoType: 'graph_relations',
    repoRoot: 'scripts/eval/project-rag/repos/fixture-graph-relations',
    languages: ['ts'],
    sharedBenchmarkSources: ['coding-scenarios', 'search-benchmarking'],
    inventory: {
      indexedPaths: [
        'src/api/order-controller.ts',
        'src/domain/order-service.ts',
        'src/domain/price-calculator.ts',
      ],
      minimumSymbolCount: 3,
      minimumChunkCount: 3,
    },
    thresholds: {
      hitRate: 0.85,
      exactPathRate: 0.85,
      exactSymbolRate: 0.75,
      exactLineRate: 0.65,
      ndcgAt10: 0.75,
      avgQualityScore: 0.8,
    },
    variants: DEFAULT_VARIANTS,
    experiments: DEFAULT_EXPERIMENTS,
    scenarios: [
      {
        id: 'graph-tax-rate',
        query: 'where is the tax rate applied to the order total',
        intent: 'Retrieve the calculator implementation first.',
        category: 'graph',
        difficulty: 'easy',
        expectedTargets: [
          {
            path: 'src/domain/price-calculator.ts',
            symbolName: 'computeOrderTotal',
            symbolKind: 'function',
            lineRange: { start: 3, end: 5, strict: true },
            maxRank: 2,
          },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1400,
        tags: ['graph', 'definition'],
      },
      {
        id: 'graph-caller-chain',
        query: 'who calls computeOrderTotal',
        intent: 'Surface the caller rather than only the definition.',
        category: 'graph',
        difficulty: 'hard',
        expectedTargets: [
          {
            path: 'src/domain/order-service.ts',
            symbolName: 'createOrder',
            symbolKind: 'function',
            lineRange: { start: 3, end: 6, strict: true },
            maxRank: 3,
          },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1600,
        tags: ['graph', 'callers'],
        tuningHints: [
          'If definition-only results win, increase caller-edge expansion or reranking weight.',
        ],
      },
    ],
    dbActions: [
      {
        id: 'graph-relations-ingest',
        phase: 'full_ingest',
        description: 'Ingest graph fixture and collect symbol/edge coverage.',
        commandHint:
          'PROJECT_SOURCE_PATH=scripts/eval/project-rag/repos/fixture-graph-relations bun run ingest-project --include src',
        expected: {
          filesIndexedMin: 3,
          blockedFiles: 0,
          symbolCountMin: 3,
          chunkCountMin: 3,
        },
        qualityChecks: [
          'symbol metadata persisted',
          'future edge extraction can be compared against this same fixture',
        ],
      },
      {
        id: 'graph-relations-ab',
        phase: 'ab_test',
        description: 'Benchmark graph-sensitive queries across variants.',
        commandHint:
          'bun run eval:project-rag -- --fixture fixture-graph-relations --capture <capture.json>',
        expected: {
          thresholds: {
            exactSymbolRate: 0.75,
            avgQualityScore: 0.8,
          },
        },
        qualityChecks: [
          'caller queries tracked separately',
          'failure hints available for graph tuning',
        ],
        abTestIds: ['project-hybrid-vs-legacy', 'project-hybrid-vs-keyword'],
      },
    ],
  },
  {
    id: 'fixture-branch-drift',
    title: 'Fixture Branch Drift',
    description: 'Two repo snapshots used to prove incremental sync and stale-index handling.',
    repoType: 'branch_drift',
    repoRoot: 'scripts/eval/project-rag/repos/fixture-branch-drift',
    languages: ['ts'],
    sharedBenchmarkSources: ['coding-scenarios', 'adversarial'],
    inventory: {
      indexedPaths: ['snapshots/v1/src/catalog.ts', 'snapshots/v2/src/catalog.ts'],
      minimumSymbolCount: 2,
      minimumChunkCount: 2,
    },
    thresholds: {
      hitRate: 0.85,
      exactPathRate: 0.85,
      exactSymbolRate: 0.75,
      avgQualityScore: 0.8,
      maxContaminationRate: 0,
    },
    variants: DEFAULT_VARIANTS,
    experiments: DEFAULT_EXPERIMENTS,
    scenarios: [
      {
        id: 'branch-drift-new-symbol',
        query: 'where is the catalog slug normalized',
        intent: 'After incremental sync, return the new symbol instead of stale content.',
        category: 'drift',
        difficulty: 'hard',
        expectationMode: 'mixed',
        expectedTargets: [
          {
            path: 'snapshots/v2/src/catalog.ts',
            symbolName: 'normalizeCatalogSlug',
            symbolKind: 'function',
            lineRange: { start: 1, end: 7, strict: true },
            maxRank: 2,
          },
        ],
        forbiddenTargets: [
          {
            path: 'snapshots/v1/src/catalog.ts',
            symbolName: 'buildCatalogSlug',
            reason: 'Stale symbol should be gone after sync.',
          },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1500,
        tags: ['drift', 'incremental-sync'],
      },
    ],
    dbActions: [
      {
        id: 'branch-drift-full-ingest-v1',
        phase: 'full_ingest',
        description: 'Ingest snapshot v1 as the baseline branch state.',
        commandHint:
          'PROJECT_SOURCE_PATH=scripts/eval/project-rag/repos/fixture-branch-drift/snapshots/v1 bun run ingest-project --include src',
        repoSubdir: 'snapshots/v1',
        expected: {
          filesIndexedMin: 1,
          blockedFiles: 0,
          symbolCountMin: 1,
          chunkCountMin: 1,
        },
        qualityChecks: ['baseline snapshot indexed'],
      },
      {
        id: 'branch-drift-incremental-v2',
        phase: 'incremental_sync',
        description: 'Switch to snapshot v2 and verify stale deletion plus reindex.',
        commandHint:
          'PROJECT_SOURCE_PATH=scripts/eval/project-rag/repos/fixture-branch-drift/snapshots/v2 bun run watch-project',
        repoSubdir: 'snapshots/v2',
        expected: {
          filesIndexedMin: 1,
          staleFiles: 1,
          symbolCountMin: 1,
        },
        qualityChecks: [
          'stale symbol removed',
          'new symbol indexed',
          'incremental path rewrites only affected file',
        ],
      },
      {
        id: 'branch-drift-baseline',
        phase: 'drift_baseline',
        description: 'Capture a branch-drift quality baseline for later regressions.',
        commandHint:
          'bun run eval:project-rag -- --fixture fixture-branch-drift --capture <capture.json> --write .data/eval/project-rag-branch-drift.json',
        expected: {
          thresholds: {
            maxContaminationRate: 0,
            avgQualityScore: 0.8,
          },
        },
        qualityChecks: [
          'baseline saved in machine-readable form',
          'stale-index negative case covered',
        ],
      },
    ],
  },
  {
    id: 'fixture-mixed-language',
    title: 'Fixture Mixed Language',
    description: 'Bounded mixed-language repo for graceful degradation and fallback retrieval.',
    repoType: 'mixed_language',
    repoRoot: 'scripts/eval/project-rag/repos/fixture-mixed-language',
    languages: ['py', 'go', 'md'],
    sharedBenchmarkSources: ['coding-scenarios', 'adversarial'],
    inventory: {
      indexedPaths: ['README.md', 'src/main.go', 'src/parser.py'],
      degradedPaths: ['src/main.go', 'src/parser.py'],
      minimumChunkCount: 3,
    },
    thresholds: {
      hitRate: 0.75,
      exactPathRate: 0.75,
      exactSymbolRate: 0.3,
      exactLineRate: 0.3,
      avgQualityScore: 0.7,
    },
    variants: DEFAULT_VARIANTS,
    experiments: DEFAULT_EXPERIMENTS,
    scenarios: [
      {
        id: 'mixed-language-parser',
        query: 'where is the csv parser implemented',
        intent: 'Find the Python fallback chunk even when symbol extraction is weak.',
        category: 'fallback',
        difficulty: 'medium',
        expectedTargets: [
          {
            path: 'src/parser.py',
            lineRange: { start: 1, end: 2, strict: true },
            maxRank: 3,
          },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1500,
        tags: ['fallback', 'python'],
        tuningHints: ['If this misses, review fallback chunk headings and language detection.'],
      },
    ],
    dbActions: [
      {
        id: 'mixed-language-ingest',
        phase: 'full_ingest',
        description: 'Ingest mixed-language fixture and verify degraded-mode reporting.',
        commandHint:
          'PROJECT_SOURCE_PATH=scripts/eval/project-rag/repos/fixture-mixed-language bun run ingest-project --include src',
        expected: {
          filesIndexedMin: 3,
          blockedFiles: 0,
          chunkCountMin: 3,
        },
        qualityChecks: [
          'fallback chunking applied',
          'unsupported/degraded languages reported without failing ingest',
        ],
      },
    ],
  },
  {
    id: 'fixture-limit-edges',
    title: 'Fixture Limit Edges',
    description: 'Performance and guardrail fixture for generated files and batching behavior.',
    repoType: 'limit_edges',
    repoRoot: 'scripts/eval/project-rag/repos/fixture-limit-edges',
    languages: ['ts'],
    sharedBenchmarkSources: ['search-benchmarking', 'adversarial'],
    inventory: {
      indexedPaths: ['README.md', 'src/services/batch-processor.ts'],
      blockedPaths: ['src/generated/huge.generated.ts', 'src/generated/lockfile.min.js'],
      minimumSymbolCount: 1,
      minimumChunkCount: 2,
    },
    thresholds: {
      hitRate: 0.85,
      exactPathRate: 0.85,
      exactSymbolRate: 0.7,
      avgQualityScore: 0.8,
      maxContaminationRate: 0,
      latencyP95Ms: 1500,
    },
    variants: DEFAULT_VARIANTS,
    experiments: DEFAULT_EXPERIMENTS,
    scenarios: [
      {
        id: 'limit-edges-batching',
        query: 'where are invoices split into batches',
        intent: 'Retrieve the real batching helper while generated noise stays blocked.',
        category: 'performance',
        difficulty: 'medium',
        expectationMode: 'mixed',
        expectedTargets: [
          {
            path: 'src/services/batch-processor.ts',
            symbolName: 'splitIntoBatches',
            symbolKind: 'function',
            lineRange: { start: 1, end: 7, strict: true },
            maxRank: 2,
          },
        ],
        forbiddenTargets: [
          {
            path: 'src/generated/huge.generated.ts',
            reason: 'Generated file must stay blocked from retrieval.',
          },
          {
            path: 'src/generated/lockfile.min.js',
            reason: 'Minified bundle must stay blocked from retrieval.',
          },
        ],
        minRelevantHits: 1,
        maxLatencyMs: 1100,
        tags: ['performance', 'blocking'],
      },
    ],
    dbActions: [
      {
        id: 'limit-edges-ingest',
        phase: 'full_ingest',
        description: 'Ingest bounded repo and verify blocklists prevent noisy rows.',
        commandHint:
          'PROJECT_SOURCE_PATH=scripts/eval/project-rag/repos/fixture-limit-edges bun run ingest-project --include src',
        expected: {
          filesIndexedMin: 2,
          blockedFiles: 2,
          symbolCountMin: 1,
          chunkCountMin: 2,
        },
        qualityChecks: [
          'generated/minified paths skipped',
          'ingest stays within bounded file count',
          'latency tracked for performance smoke',
        ],
      },
    ],
  },
];

export function getProjectFixture(fixtureId: string): ProjectFixtureManifest | undefined {
  return PROJECT_RAG_FIXTURES.find((fixture) => fixture.id === fixtureId);
}

export function listProjectFixtures(): ProjectFixtureManifest[] {
  return PROJECT_RAG_FIXTURES;
}

export function validateFixtureFileSystem(baseDir: string = process.cwd()) {
  return PROJECT_RAG_FIXTURES.map((fixture) => validateProjectFixtureManifest(fixture, baseDir));
}
