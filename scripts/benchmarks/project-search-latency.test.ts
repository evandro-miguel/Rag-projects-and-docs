import { describe, expect, it, vi } from 'vitest';
import {
  type BenchmarkQueryResult,
  type BenchmarkRuntime,
  type BenchmarkSourceIdentity,
  benchmarkViolations,
  loadDefaultBenchmarkQueries,
  MIN_READINESS_SAMPLES,
  parseProjectSearchBenchmarkArgs,
  percentile,
  runProjectSearchBenchmark,
  summarizeLatencies,
} from './project-search-latency.js';

const SOURCE_IDENTITY: BenchmarkSourceIdentity = {
  headCommit: 'test-commit',
  dirty: true,
  contentSha256: 'a'.repeat(64),
  files: ['package.json'],
};

function runtime(runQuery: BenchmarkRuntime['runQuery']): BenchmarkRuntime {
  return {
    project: { id: 3, slug: 'rag-v2-dev' },
    databaseSource: 'PROJECT_RAG_DATABASE_URL',
    embedding: {
      provider: 'llamacpp',
      model: 'qwen3-embedding-1024',
      dimensions: 1024,
      profileHash: 'profile-a',
    },
    runQuery,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('project search latency benchmark', () => {
  it('requires at least 30 measured samples in readiness mode', () => {
    expect(() =>
      parseProjectSearchBenchmarkArgs(['--project', 'rag-v2-dev', '--iterations=9', '--warmup=0'])
    ).toThrow(`requires at least ${MIN_READINESS_SAMPLES} measured samples`);

    expect(
      parseProjectSearchBenchmarkArgs(['--project', 'rag-v2-dev', '--iterations=10']).mode
    ).toBe('readiness');
  });

  it('allows a small explicit smoke run but never reports release-pass', async () => {
    const args = parseProjectSearchBenchmarkArgs([
      '--project',
      'rag-v2-dev',
      '--iterations=1',
      '--warmup=0',
      '--smoke',
    ]);
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(
        async (query): Promise<BenchmarkQueryResult> => ({
          hits: 4,
          topResults: [
            { sourcePath: query.expectedPaths?.[0] ?? 'scripts/project-rag/store.ts', score: 1 },
          ],
        })
      ),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('smoke');
    expect(report.releaseEligible).toBe(false);
    expect(report.latency.count).toBe(3);
  });

  it('parses an explicit expected-path rank bound', () => {
    const args = parseProjectSearchBenchmarkArgs([
      '--project',
      'rag-v2-dev',
      '--smoke',
      '--iterations=1',
      '--warmup=0',
      '--expected-path-max-rank=1',
    ]);
    expect(args.expectedPathMaxRank).toBe(1);
  });

  it('fails when any canonical query returns zero hits and reports hit counts', async () => {
    const args = parseProjectSearchBenchmarkArgs(['--project', 'rag-v2-dev', '--warmup=0']);
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(async (query) => (query.name === 'postgres-search' ? 0 : 5)),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.violations).toContain('query postgres-search returned zero hits');
    expect(report.queryResults).toHaveLength(3);
    expect(report.queryResults[1]?.minHits).toBe(0);
  });

  it('retains an early zero-hit failure across later successful iterations', async () => {
    const args = parseProjectSearchBenchmarkArgs([
      '--project',
      'rag-v2-dev',
      '--smoke',
      '--iterations=3',
      '--warmup=0',
    ]);
    const calls = new Map<string, number>();
    const firstQueryName = args.queries[0]?.name;
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(async (query): Promise<BenchmarkQueryResult> => {
        const callCount = (calls.get(query.name) ?? 0) + 1;
        calls.set(query.name, callCount);
        return {
          hits: query.name === firstQueryName && callCount === 1 ? 0 : 5,
          topResults: [
            { sourcePath: query.expectedPaths?.[0] ?? 'scripts/project-rag/store.ts', score: 1 },
          ],
        };
      }),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.releaseEligible).toBe(false);
    expect(report.latency.count).toBe(args.iterations * args.queries.length);
    expect(report.queryResults[0]?.samples).toBe(3);
    expect(report.queryResults[0]?.minHits).toBe(0);
    expect(report.violations).toContain(`query ${firstQueryName} returned zero hits`);
  });

  it('fails closed when an expected path is present only below the configured rank', async () => {
    const parsed = parseProjectSearchBenchmarkArgs([
      '--project',
      'rag-v2-dev',
      '--smoke',
      '--iterations=1',
      '--warmup=0',
      '--expected-path-max-rank=1',
    ]);
    const args = {
      ...parsed,
      queries: [
        {
          name: 'ranked-path',
          query: 'ranked path',
          expectedPaths: ['expected.ts'],
        },
      ],
    };
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(
        async (): Promise<BenchmarkQueryResult> => ({
          hits: 2,
          topResults: [
            { sourcePath: 'distractor.ts', score: 2 },
            { sourcePath: 'expected.ts', score: 1 },
          ],
        })
      ),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.queryResults[0]?.expectedPathRank).toBe(2);
    expect(report.violations.some((violation) => violation.includes('within max rank 1'))).toBe(
      true
    );
  });

  it('fails closed when lexical fallback is used instead of real embeddings', async () => {
    const args = parseProjectSearchBenchmarkArgs(['--project', 'rag-v2-dev', '--warmup=0']);
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(
        async (query): Promise<BenchmarkQueryResult> => ({
          hits: 5,
          topResults: [{ sourcePath: 'scripts/project-rag/store.ts', score: 1 }],
          fallbackUsed: query.name === 'embedding-config',
        })
      ),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.releaseEligible).toBe(false);
    expect(report.violations.some((v) => v.includes('triggered lexical fallback'))).toBe(true);
  });

  it('fails closed when workspace context is stale/invalid', async () => {
    const args = parseProjectSearchBenchmarkArgs(['--project', 'rag-v2-dev', '--warmup=0']);
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(
        async (): Promise<BenchmarkQueryResult> => ({
          hits: 5,
          topResults: [{ sourcePath: 'scripts/project-rag/store.ts', score: 1 }],
          contextInvalid: true,
        })
      ),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.releaseEligible).toBe(false);
    expect(report.violations.some((v) => v.includes('invalid/stale workspace context'))).toBe(true);
  });

  it('fails closed on self-referential hits matching benchmark files', async () => {
    const args = parseProjectSearchBenchmarkArgs(['--project', 'rag-v2-dev', '--warmup=0']);
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(
        async (): Promise<BenchmarkQueryResult> => ({
          hits: 3,
          topResults: [{ sourcePath: 'scripts/benchmarks/project-search-latency.ts', score: 2.5 }],
        })
      ),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.releaseEligible).toBe(false);
    expect(report.violations.some((v) => v.includes('returned self-referential hit'))).toBe(true);
  });

  it('fails closed when results do not match expected paths', async () => {
    const args = parseProjectSearchBenchmarkArgs(['--project', 'rag-v2-dev', '--warmup=0']);
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(
        async (): Promise<BenchmarkQueryResult> => ({
          hits: 2,
          topResults: [{ sourcePath: 'unrelated/other.ts', score: 1.5 }],
        })
      ),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.releaseEligible).toBe(false);
    expect(report.violations.some((v) => v.includes('did not match any expected paths'))).toBe(
      true
    );
  });

  it('loads externalized queries with expected paths', () => {
    const queries = loadDefaultBenchmarkQueries();
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const q of queries) {
      expect(q.name).toBeDefined();
      expect(q.query.length).toBeGreaterThan(5);
      expect(q.expectedPaths).toBeDefined();
      expect(q.expectedPaths?.length).toBeGreaterThan(0);
    }
  });

  it('records raw-store latency as diagnostic-only without overriding route status', async () => {
    const args = parseProjectSearchBenchmarkArgs([
      '--project',
      'rag-v2-dev',
      '--warmup=0',
      '--smoke',
      '--iterations=1',
    ]);
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(
        async (query): Promise<BenchmarkQueryResult> => ({
          hits: 5,
          topResults: [
            { sourcePath: query.expectedPaths?.[0] ?? 'scripts/project-rag/store.ts', score: 1 },
          ],
          rawStoreLatencyMs: 15,
        })
      ),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.diagnostics?.rawStoreLatency).toBeDefined();
    expect(report.diagnostics?.rawStoreLatency?.count).toBe(3);
    expect(report.diagnostics?.rawStoreLatency?.p50Ms).toBe(15);
  });

  it('returns a redacted failed report on runtime errors with source identity intact', async () => {
    const args = parseProjectSearchBenchmarkArgs(['--project', 'rag-v2-dev', '--warmup=0']);
    const report = await runProjectSearchBenchmark(args, {
      runtime: runtime(async () => {
        throw new Error('connection failed at postgres://user:password@db.internal/project');
      }),
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.releaseEligible).toBe(false);
    expect(report.error).toContain('[redacted-url]');
    expect(JSON.stringify(report)).not.toContain('password');
    expect(report.provenance.sourceIdentity).toEqual(SOURCE_IDENTITY);
    expect(report.provenance).not.toHaveProperty('redactedUrl');
  });

  it('fails closed when the live runtime cannot close cleanly', async () => {
    const args = parseProjectSearchBenchmarkArgs([
      '--project',
      'rag-v2-dev',
      '--iterations=1',
      '--warmup=0',
      '--smoke',
    ]);
    const failingRuntime = runtime(async () => 3);
    failingRuntime.close = vi
      .fn()
      .mockRejectedValue(new Error('close failed for https://user:secret@db.internal'));
    const report = await runProjectSearchBenchmark(args, {
      runtime: failingRuntime,
      sourceIdentity: SOURCE_IDENTITY,
    });

    expect(report.status).toBe('failed');
    expect(report.releaseEligible).toBe(false);
    expect(report.error).toContain('[redacted-url]');
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('computes percentiles and enforces readiness sample and latency thresholds', () => {
    const samples = [30, 10, 20, 40];
    expect(percentile(samples, 0.5)).toBe(20);
    expect(percentile(samples, 0.95)).toBe(40);
    expect(percentile(samples, 0.99)).toBe(40);
    expect(samples).toEqual([30, 10, 20, 40]);

    const shortLatency = summarizeLatencies(Array.from({ length: 29 }, () => 700));
    expect(benchmarkViolations(shortLatency, [], 500, 'readiness')).toEqual([
      'measured samples 29 below readiness minimum 30',
      'p95 700ms exceeds threshold 500ms',
    ]);
  });
});
