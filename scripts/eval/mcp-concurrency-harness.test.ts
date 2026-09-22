import { describe, expect, it } from 'vitest';
import {
  assertAllowlistedOperation,
  buildCallPlan,
  buildReadOnlyEnv,
  buildReport,
  buildToolArguments,
  type CallResult,
  CORE_ALLOWLIST,
  type ConcurrencyReport,
  classifyThrownError,
  classifyToolCallResult,
  countMutationCalls,
  foldConnectFailure,
  isAllowlistedOperation,
  MUTATION_TOOLS,
  mergeSettledWorkerOutcomes,
  OPTIONAL_READ_ALLOWLIST,
  parseArgs,
  percentile,
  READ_DEADLINE_CODE,
  readPoolEnvSnapshot,
  resolveAllowlist,
  summarizeLatencies,
  validateReport,
  type WorkerRunOutcome,
} from './mcp-concurrency-harness.js';
import { MCP_CONCURRENCY_P95_THRESHOLDS } from './thresholds.js';

function sampleArgs() {
  return parseArgs(
    ['--project-id', 'rag-v2-dev', '--project-query', 'loginUser', '--docs-query', 'bun'],
    '/workspace'
  );
}

describe('mcp-concurrency-harness parseArgs', () => {
  it('parses stdio defaults and CLI overrides', () => {
    const args = parseArgs(
      [
        '--transport',
        'stdio',
        '--concurrency',
        '8',
        '--iterations',
        '12',
        '--project-id',
        '3',
        '--docs-query',
        'bun serve',
        '--project-query',
        'loginUser',
        '--cwd',
        '/tmp/rag',
        '--timeout-ms',
        '5000',
        '--p95-threshold-ms',
        '1500',
      ],
      '/workspace/default'
    );

    expect(args.transport).toBe('stdio');
    expect(args.concurrency).toBe(8);
    expect(args.iterations).toBe(12);
    expect(args.projectId).toBe('3');
    expect(args.docsQuery).toBe('bun serve');
    expect(args.projectQuery).toBe('loginUser');
    expect(args.cwd).toBe('/tmp/rag');
    expect(args.timeoutMs).toBe(5000);
    expect(args.p95ThresholdMs).toBe(1500);
    expect(args.includeOptionalReads).toBe(false);
    expect(args.json).toBe(true);
  });

  it('accepts --calls as an alias for iterations', () => {
    const args = parseArgs(['--calls', '7'], '/workspace');
    expect(args.iterations).toBe(7);
  });

  it('requires endpoint and api key for http transport', () => {
    expect(() => parseArgs(['--transport', 'http'], '/workspace')).toThrow(/--endpoint/);

    const previousApiKey = process.env.MCP_API_KEY;
    delete process.env.MCP_API_KEY;
    try {
      expect(() =>
        parseArgs(['--transport', 'http', '--endpoint', 'http://127.0.0.1:3333/mcp'], '/workspace')
      ).toThrow(/api-key|MCP_API_KEY/);
    } finally {
      if (previousApiKey === undefined) delete process.env.MCP_API_KEY;
      else process.env.MCP_API_KEY = previousApiKey;
    }
  });

  it('accepts http transport with endpoint and api key', () => {
    const args = parseArgs(
      ['--transport', 'http', '--endpoint', 'http://127.0.0.1:3333/mcp', '--api-key', 'test-key'],
      '/workspace'
    );
    expect(args.transport).toBe('http');
    expect(args.endpoint).toBe('http://127.0.0.1:3333/mcp');
    expect(args.apiKey).toBe('test-key');
  });

  it('requires source-path when optional reads are enabled', () => {
    expect(() => parseArgs(['--include-optional-reads'], '/workspace')).toThrow(/source-path/);
  });

  it('defaults p95 threshold to the standard concurrent runtime budget', () => {
    const args = parseArgs([], '/workspace');
    expect(args.p95ThresholdMs).toBe(MCP_CONCURRENCY_P95_THRESHOLDS.standard);
    expect(args.p95ThresholdMs).toBe(1750);
  });

  it('rejects invalid transport values', () => {
    expect(() => parseArgs(['--transport', 'websocket'], '/workspace')).toThrow(
      /Invalid --transport/
    );
  });
});

describe('mcp-concurrency-harness allowlist enforcement', () => {
  it('resolves core allowlist without optional reads', () => {
    expect(resolveAllowlist(false)).toEqual([...CORE_ALLOWLIST]);
    expect(resolveAllowlist(true)).toEqual([...CORE_ALLOWLIST, ...OPTIONAL_READ_ALLOWLIST]);
  });

  it('accepts only allowlisted operations', () => {
    const allowlist = resolveAllowlist(false);
    expect(isAllowlistedOperation('search_docs', allowlist)).toBe(true);
    expect(isAllowlistedOperation('tools/list', allowlist)).toBe(true);
    expect(isAllowlistedOperation('register_project', allowlist)).toBe(false);
    expect(isAllowlistedOperation('ingest_project', allowlist)).toBe(false);
    expect(isAllowlistedOperation('verify_project_index', allowlist)).toBe(false);
  });

  it('throws when asserting a non-allowlisted or mutation tool', () => {
    const allowlist = resolveAllowlist(false);
    expect(() => assertAllowlistedOperation('search_docs', allowlist)).not.toThrow();
    expect(() => assertAllowlistedOperation('register_project', allowlist)).toThrow(
      /not allowlisted/
    );
    expect(() => assertAllowlistedOperation('ingest_project', allowlist)).toThrow(
      /not allowlisted/
    );
    for (const tool of MUTATION_TOOLS) {
      expect(isAllowlistedOperation(tool, allowlist)).toBe(false);
    }
  });

  it('builds a rotating call plan within the allowlist only', () => {
    const plan = buildCallPlan(resolveAllowlist(false), 5);
    expect(plan).toHaveLength(5);
    expect(plan.every((op) => CORE_ALLOWLIST.includes(op))).toBe(true);
    expect(plan[0]).toBe('tools/list');
    expect(plan[1]).toBe('search_docs');
    expect(plan[2]).toBe('search_project_code');
    expect(plan[3]).toBe('tools/list');
  });
});

describe('mcp-concurrency-harness hybrid project search mode', () => {
  it('sends mode hybrid for search_project_code, not keyword', () => {
    const args = sampleArgs();
    const toolArgs = buildToolArguments('search_project_code', args);
    expect(toolArgs).toEqual({
      projectId: 'rag-v2-dev',
      query: 'loginUser',
      limit: 5,
      mode: 'hybrid',
    });
    expect(toolArgs).not.toMatchObject({ mode: 'keyword' });
  });
});

describe('mcp-concurrency-harness call result classification', () => {
  it('classifies isError:true as failure even without structured code', () => {
    const classified = classifyToolCallResult({
      isError: true,
      content: [{ type: 'text', text: 'tool failed hard' }],
    });
    expect(classified.outcome).toBe('error');
    expect(classified.error).toContain('tool failed hard');
  });

  it('classifies structured success:false as failure', () => {
    const classified = classifyToolCallResult({
      isError: false,
      structuredContent: {
        success: false,
        error: { code: 'NOT_FOUND', message: 'project missing' },
      },
    });
    expect(classified.outcome).toBe('error');
    expect(classified.code).toBe('NOT_FOUND');
    expect(classified.error).toContain('project missing');
  });

  it('classifies READ_DEADLINE_EXCEEDED structured code as timeout', () => {
    const classified = classifyToolCallResult({
      isError: true,
      structuredContent: {
        success: false,
        error: {
          code: READ_DEADLINE_CODE,
          message: 'READ_DEADLINE_EXCEEDED: Cooperative cancellation requested',
        },
      },
    });
    expect(classified.outcome).toBe('timeout');
    expect(classified.code).toBe(READ_DEADLINE_CODE);
  });

  it('classifies successful callTool results as success', () => {
    expect(
      classifyToolCallResult({
        isError: false,
        structuredContent: { success: true, data: { results: [] } },
      })
    ).toEqual({ outcome: 'success' });
  });

  it('never classifies a successful result as timeout for timeout-like text', () => {
    // Auditor repro: search results quoting files that contain "timeout"
    // must stay successes even though rawText mentions the word.
    const classified = classifyToolCallResult({
      isError: false,
      content: [
        {
          type: 'text',
          text: 'Found 5 results ... mcp/lib/timeout.ts uses MCP_TOOL_TIMEOUT_MS and deadline handling ...',
        },
      ],
      structuredContent: { success: true, count: 5 },
    });
    expect(classified.outcome).toBe('success');

    const rawTextOnly = classifyToolCallResult({
      isError: false,
      content: [{ type: 'text', text: 'request timed out after 30000ms' }],
    });
    expect(rawTextOnly.outcome).toBe('success');
  });

  it('still classifies failed payloads with descriptive legacy timeout messages as timeout', () => {
    const classified = classifyToolCallResult({
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ message: 'MCP request timed out after 30000ms' }) },
      ],
    });
    expect(classified.outcome).toBe('timeout');
  });

  it('treats structured READ_DEADLINE_CODE as timeout regardless of failure flags', () => {
    const classified = classifyToolCallResult({
      structuredContent: { error: { code: READ_DEADLINE_CODE } },
    });
    expect(classified.outcome).toBe('timeout');
    expect(classified.code).toBe(READ_DEADLINE_CODE);
  });

  it('classifies thrown deadline/timeout errors as timeout', () => {
    const timeout = classifyThrownError(new Error('MCP request timed out after 30000ms'));
    expect(timeout.outcome).toBe('timeout');

    const deadline = classifyThrownError(new Error(`${READ_DEADLINE_CODE}: tool deadline`));
    expect(deadline.outcome).toBe('timeout');
    expect(deadline.code).toBe(READ_DEADLINE_CODE);

    const generic = classifyThrownError(new Error('ECONNREFUSED'));
    expect(generic.outcome).toBe('error');
  });
});

describe('mcp-concurrency-harness connect failure folding', () => {
  it('folds connect failures into per-operation results instead of empty crash', () => {
    const plan = buildCallPlan(resolveAllowlist(false), 3);
    const folded = foldConnectFailure(2, plan, new Error('connect ECONNREFUSED'));
    expect(folded).toHaveLength(3);
    expect(folded.every((entry) => entry.workerId === 2)).toBe(true);
    expect(folded.every((entry) => entry.outcome === 'error')).toBe(true);
    expect(folded.every((entry) => entry.error?.startsWith('connect:'))).toBe(true);
    expect(folded.map((entry) => entry.operation)).toEqual(plan);
  });

  it('merges allSettled rejected workers into the reportable result set', () => {
    const plan = buildCallPlan(resolveAllowlist(false), 2);
    const fulfilled: WorkerRunOutcome = {
      workerId: 0,
      results: [
        {
          workerId: 0,
          index: 0,
          operation: 'tools/list',
          outcome: 'success',
          latencyMs: 5,
        },
        {
          workerId: 0,
          index: 1,
          operation: 'search_docs',
          outcome: 'success',
          latencyMs: 10,
        },
      ],
      cleanupErrors: [],
    };
    const settled: PromiseSettledResult<WorkerRunOutcome>[] = [
      { status: 'fulfilled', value: fulfilled },
      { status: 'rejected', reason: new Error('session bootstrap failed') },
    ];
    const merged = mergeSettledWorkerOutcomes(settled, plan);
    expect(merged.results).toHaveLength(4);
    expect(merged.results.filter((entry) => entry.workerId === 1)).toHaveLength(2);
    expect(
      merged.results.filter((entry) => entry.workerId === 1).every((e) => e.outcome === 'error')
    ).toBe(true);
    expect(merged.settlementFailures.some((entry) => entry.includes('worker=1'))).toBe(true);

    const report = buildReport({
      commitSha: 'abc',
      transport: 'http',
      allowlist: resolveAllowlist(false),
      poolEnv: readPoolEnvSnapshot({}),
      concurrency: 2,
      iterations: 2,
      results: merged.results,
      p95ThresholdMs: 1500,
      mutationCalls: 0,
      cleanupErrors: merged.cleanupErrors,
      extraFailures: merged.settlementFailures,
    });
    expect(report.total).toBe(4);
    expect(report.error).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.failures.some((entry) => entry.includes('session bootstrap failed'))).toBe(true);
  });
});

describe('mcp-concurrency-harness cleanup error recording', () => {
  it('records cleanup errors in failures and cleanupErrorCount, failing ok', () => {
    const results: CallResult[] = [
      {
        workerId: 0,
        index: 0,
        operation: 'tools/list',
        outcome: 'success',
        latencyMs: 3,
      },
    ];
    const report = buildReport({
      commitSha: 'abc',
      transport: 'stdio',
      allowlist: resolveAllowlist(false),
      poolEnv: readPoolEnvSnapshot({}),
      concurrency: 1,
      iterations: 1,
      results,
      p95ThresholdMs: 1500,
      mutationCalls: 0,
      cleanupErrors: ['client.close: socket hang up', 'transport.close: already closed'],
    });
    expect(report.cleanupErrorCount).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.failures.some((entry) => entry.includes('cleanup: client.close'))).toBe(true);
    expect(report.failures.some((entry) => entry.includes('cleanupErrorCount=2'))).toBe(true);
  });
});

describe('mcp-concurrency-harness percentile math', () => {
  it('returns 0 for empty samples', () => {
    expect(percentile([], 50)).toBe(0);
    expect(summarizeLatencies([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  it('computes nearest-rank percentiles for a known series', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 99)).toBe(100);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile([1], 95)).toBe(1);
  });

  it('rejects out-of-range percentile ranks', () => {
    expect(() => percentile([1, 2, 3], 101)).toThrow(/percentileRank/);
    expect(() => percentile([1, 2, 3], -1)).toThrow(/percentileRank/);
  });
});

describe('mcp-concurrency-harness zero mutation guarantee', () => {
  it('counts mutation tool names when present', () => {
    expect(countMutationCalls(['search_docs', 'register_project', 'ingest_project'])).toBe(2);
    expect(countMutationCalls(['tools/list', 'search_docs', 'search_project_code'])).toBe(0);
  });

  it('strips mutation ack env vars and forces read_only + watcher off', () => {
    const env = buildReadOnlyEnv({
      PATH: '/usr/bin',
      MCP_PERMISSION_MODE: 'read_write',
      RAG_PROJECT_WATCHER_ENABLED: 'true',
      RAG_MCP_PROJECT_CURRENT_MUTATION_ACK: '1',
      RAG_PROJECT_MUTATION_ACK: 'yes',
      MCP_MUTATION_ACK: '1',
      KEEP_ME: 'ok',
    });

    expect(env.MCP_PERMISSION_MODE).toBe('read_only');
    expect(env.RAG_PROJECT_WATCHER_ENABLED).toBe('false');
    expect(env.RAG_PROJECT_SESSION_INTENT).toBe('read_only');
    expect(env.KEEP_ME).toBe('ok');
    expect(env.RAG_MCP_PROJECT_CURRENT_MUTATION_ACK).toBeUndefined();
    expect(env.RAG_PROJECT_MUTATION_ACK).toBeUndefined();
    expect(env.MCP_MUTATION_ACK).toBeUndefined();
  });

  it('forces mutationCalls=0 in successful read-only reports', () => {
    const results: CallResult[] = [
      {
        workerId: 0,
        index: 0,
        operation: 'tools/list',
        outcome: 'success',
        latencyMs: 10,
      },
      {
        workerId: 0,
        index: 1,
        operation: 'search_docs',
        outcome: 'success',
        latencyMs: 20,
      },
    ];
    const report = buildReport({
      commitSha: 'abc123',
      transport: 'stdio',
      allowlist: resolveAllowlist(false),
      poolEnv: readPoolEnvSnapshot({}),
      concurrency: 1,
      iterations: 2,
      results,
      p95ThresholdMs: 1500,
      mutationCalls: 0,
    });
    expect(report.mutationCalls).toBe(0);
    expect(report.cleanupErrorCount).toBe(0);
    expect(report.ok).toBe(true);
  });
});

describe('mcp-concurrency-harness report validation', () => {
  function sampleReport(overrides: Partial<ConcurrencyReport> = {}): ConcurrencyReport {
    const base = buildReport({
      commitSha: 'deadbeef',
      transport: 'http',
      allowlist: resolveAllowlist(true),
      poolEnv: readPoolEnvSnapshot({
        PROJECT_RAG_DB_POOL_MAX: '4',
        DOCS_RAG_PG_LAB_DB_POOL_MAX: '3',
      }),
      concurrency: 2,
      iterations: 3,
      results: [
        {
          workerId: 0,
          index: 0,
          operation: 'tools/list',
          outcome: 'success',
          latencyMs: 5,
        },
        {
          workerId: 1,
          index: 0,
          operation: 'search_project_code',
          outcome: 'success',
          latencyMs: 15,
        },
      ],
      p95ThresholdMs: 1500,
      mutationCalls: 0,
    });
    return { ...base, ...overrides };
  }

  it('accepts a well-formed compact report', () => {
    const report = sampleReport();
    const validation = validateReport(report);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(report.poolEnv.PROJECT_RAG_DB_POOL_MAX.effective).toBe(4);
    expect(report.poolEnv.PROJECT_RAG_DB_POOL_MAX.default).toBe(2);
    expect(report.poolEnv.DOCS_RAG_PG_LAB_DB_POOL_MAX.effective).toBe(3);
    expect(report.permissionMode).toBe('read_only');
    expect(report.watcherEnabled).toBe(false);
    expect(report.perTool['tools/list']?.total).toBe(1);
    expect(report.perTool.search_project_code?.total).toBe(1);
    expect(report.cleanupErrorCount).toBe(0);
  });

  it('fails the gate when any call errors or p95 exceeds threshold', () => {
    const errorReport = buildReport({
      commitSha: 'x',
      transport: 'stdio',
      allowlist: resolveAllowlist(false),
      poolEnv: readPoolEnvSnapshot({}),
      concurrency: 1,
      iterations: 1,
      results: [
        {
          workerId: 0,
          index: 0,
          operation: 'search_docs',
          outcome: 'error',
          latencyMs: 12,
          error: 'boom',
        },
      ],
      p95ThresholdMs: 1500,
      mutationCalls: 0,
    });
    expect(errorReport.ok).toBe(false);
    expect(errorReport.error).toBe(1);

    const slowReport = buildReport({
      commitSha: 'x',
      transport: 'stdio',
      allowlist: resolveAllowlist(false),
      poolEnv: readPoolEnvSnapshot({}),
      concurrency: 1,
      iterations: 1,
      // Nearest-rank p95 for n=20 lands on index 18, so keep the top ranks slow.
      results: Array.from({ length: 20 }, (_, index) => ({
        workerId: 0,
        index,
        operation: 'search_docs' as const,
        outcome: 'success' as const,
        latencyMs: index >= 18 ? 2000 : 100,
      })),
      p95ThresholdMs: 1500,
      mutationCalls: 0,
    });
    expect(slowReport.p95).toBeGreaterThan(1500);
    expect(slowReport.ok).toBe(false);
    expect(slowReport.failures.some((entry) => entry.includes('p95='))).toBe(true);

    const dilutedSlowToolReport = buildReport({
      commitSha: 'x',
      transport: 'stdio',
      allowlist: resolveAllowlist(false),
      poolEnv: readPoolEnvSnapshot({}),
      concurrency: 1,
      iterations: 1,
      results: [
        ...Array.from({ length: 20 }, (_, index) => ({
          workerId: 0,
          index,
          operation: 'tools/list' as const,
          outcome: 'success' as const,
          latencyMs: 5,
        })),
        {
          workerId: 0,
          index: 20,
          operation: 'search_docs' as const,
          outcome: 'success' as const,
          latencyMs: 2_000,
        },
      ],
      p95ThresholdMs: 1_500,
      mutationCalls: 0,
    });
    expect(dilutedSlowToolReport.p95).toBeLessThan(1_500);
    expect(dilutedSlowToolReport.ok).toBe(false);
    expect(dilutedSlowToolReport.failures).toContain(
      'search_docs.p95=2000ms exceeds threshold 1500ms'
    );
  });

  it('rejects empty total and false-green ok with zero calls', () => {
    const empty = buildReport({
      commitSha: 'x',
      transport: 'stdio',
      allowlist: resolveAllowlist(false),
      poolEnv: readPoolEnvSnapshot({}),
      concurrency: 2,
      iterations: 3,
      results: [],
      p95ThresholdMs: 1500,
      mutationCalls: 0,
    });
    expect(empty.total).toBe(0);
    expect(empty.ok).toBe(false);
    expect(empty.failures.some((entry) => entry.includes('total=0'))).toBe(true);

    const validation = validateReport(empty);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContain('total must be > 0');

    const forgedOk = sampleReport({ ok: true, total: 0, success: 0, error: 0, timeout: 0 });
    expect(validateReport(forgedOk).valid).toBe(false);
    expect(validateReport(forgedOk).issues).toContain('total must be > 0');
  });

  it('rejects reports with mutationCalls or inconsistent counters', () => {
    const mutated = sampleReport({ mutationCalls: 1 });
    expect(validateReport(mutated).valid).toBe(false);
    expect(validateReport(mutated).issues).toContain('mutationCalls must be 0');

    const inconsistent = sampleReport({ success: 0 });
    expect(validateReport(inconsistent).valid).toBe(false);
  });

  it('snapshots pool env defaults when unset', () => {
    const pool = readPoolEnvSnapshot({});
    expect(pool.PROJECT_RAG_DB_POOL_MAX).toEqual({
      env: null,
      effective: 2,
      default: 2,
    });
    expect(pool.PROJECT_RAG_DB_MAX_LIFETIME_MS.effective).toBe(0);
    expect(pool.DOCS_RAG_PG_LAB_DB_CONNECTION_TIMEOUT_MS.default).toBe(5_000);
  });
});
