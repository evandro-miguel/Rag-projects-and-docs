import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as currentProjectModule from './mcp-project-current.js';
import {
  buildProjectSearchArguments,
  callToolWithTimeout,
  classifyFailureCode,
  createMachineReadableResultLine,
  finalizeRepairSummary,
  isTimeoutLikeError,
  parseArgs,
  requireProjectSearchEmbeddingEvidence,
  requireVerifyPayload,
  resolveProjectIncludeRoots,
  selectRepairCandidates,
} from './mcp-project-current.js';

describe('Project MCP availability', () => {
  it('does not block Project repair when only Docs RAG health is degraded', () => {
    const requireProjectMcpAvailability = (currentProjectModule as Record<string, unknown>)
      .requireProjectMcpAvailability;

    expect(requireProjectMcpAvailability).toBeTypeOf('function');
    expect(() =>
      (requireProjectMcpAvailability as (payload: unknown) => void)({
        isError: true,
        rawText: [
          '# Health Check Results',
          'MCP Server: OK (0ms)',
          'Docs RAG Postgres: OK (3ms)',
          'Docs RAG Corpus: ERROR',
        ].join('\n'),
      })
    ).not.toThrow();
    expect(() =>
      (requireProjectMcpAvailability as (payload: unknown) => void)({
        isError: true,
        rawText: 'Docs RAG Corpus: ERROR',
      })
    ).toThrow('MCP server availability was not proven');
  });
});

describe('Project search arguments', () => {
  it('uses the supported hybrid mode for the current-project gate', () => {
    expect(buildProjectSearchArguments('project-1', 'timeout handler')).toEqual({
      projectId: 'project-1',
      query: 'timeout handler',
      limit: 5,
      mode: 'hybrid',
    });
  });
});

describe('parseArgs', () => {
  it('defaults to contract mode and resolves project metadata from cwd', () => {
    const args = parseArgs(['--include-roots', 'scripts,lib'], '/workspace/rag-v1');

    expect(args.mode).toBe('contract');
    expect(args.cwd).toBe('/workspace/rag-v1');
    expect(args.projectRoot).toBe('/workspace/rag-v1');
    expect(args.projectName).toBe('rag-v1');
    expect(args.projectSlug).toBe('rag-v1');
    expect(args.includeRoots).toEqual(['scripts', 'lib']);
    expect(args.maxFiles).toBe(10);
    expect(args.offset).toBe(0);
    expect(args.ingestTimeoutMs).toBe(12000);
  });

  it('accepts repair mode and bounded max-files', () => {
    const args = parseArgs(
      ['repair', '--include-roots', 'src', '--max-files', '5000'],
      '/workspace/rag-v1'
    );

    expect(args.mode).toBe('repair');
    expect(args.maxFiles).toBe(10);
  });

  it('accepts bounded offset', () => {
    const args = parseArgs(
      ['repair', '--include-roots', 'src', '--offset', '12'],
      '/workspace/rag-v1'
    );
    expect(args.offset).toBe(12);
  });

  it('accepts bounded ingest timeout', () => {
    const args = parseArgs(
      ['repair', '--include-roots', 'src', '--ingest-timeout-ms', '200000'],
      '/workspace/rag-v1'
    );
    expect(args.ingestTimeoutMs).toBe(120000);
  });

  it('sets deterministic json artifact path when --json is enabled', () => {
    const args = parseArgs(['repair', '--include-roots', 'src', '--json'], '/workspace/rag-v1');
    expect(args.json).toBe(true);
    expect(args.jsonOutPath).toBe('/workspace/rag-v1/.tmp/mcp-project-current-last.json');
  });

  it('defaults to current repo include roots when available', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mcp-project-current-'));
    try {
      for (const includeRoot of [
        'src',
        'mcp',
        'lib',
        'scripts',
        'docs',
        'infra',
        'skills',
        'tests',
        'plugins',
      ]) {
        mkdirSync(join(rootDir, includeRoot), { recursive: true });
      }

      const args = parseArgs([], rootDir);

      expect(args.includeRoots).toEqual([
        'mcp',
        'lib',
        'scripts',
        'docs',
        'infra',
        'skills',
        'tests',
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('resolveProjectIncludeRoots', () => {
  it('preserves existing includeRoots when an existing project is found', async () => {
    const roots = await resolveProjectIncludeRoots('my-project', ['src', 'lib'], async () => ({
      includeRoots: ['mcp', 'scripts', 'docs'],
    }));

    expect(roots).toEqual(['mcp', 'scripts', 'docs']);
  });

  it('falls back to computed roots when no existing project is found', async () => {
    const roots = await resolveProjectIncludeRoots(
      'new-project',
      ['src', 'lib'],
      async () => undefined
    );

    expect(roots).toEqual(['src', 'lib']);
  });

  it('falls back to computed roots when the existing project has empty includeRoots', async () => {
    const roots = await resolveProjectIncludeRoots('empty-project', ['scripts'], async () => ({
      includeRoots: [],
    }));

    expect(roots).toEqual(['scripts']);
  });

  it('falls back to computed roots when the lookup throws', async () => {
    const roots = await resolveProjectIncludeRoots('broken-project', ['fallback'], async () => {
      throw new Error('DB unavailable');
    });

    expect(roots).toEqual(['fallback']);
  });
});

describe('classifyFailureCode', () => {
  it('maps empty-index bootstrap failures explicitly', () => {
    expect(
      classifyFailureCode('project_not_indexed: verify_project_index reported zero files')
    ).toBe('project_not_indexed');
  });

  it('maps freshness failures explicitly', () => {
    expect(classifyFailureCode('freshness_precondition_failed: status=stale')).toBe(
      'freshness_precondition_failed'
    );
  });

  it('maps timeout and fallback failures', () => {
    expect(classifyFailureCode('Request timed out')).toBe('ingest_request_timeout');
    expect(classifyFailureCode('Function execution timed out (maximum duration: 1s)')).toBe(
      'runtime_function_timeout'
    );
    expect(classifyFailureCode('anything else')).toBe('contract_step_failed');
  });

  it('maps embedding lane failures explicitly', () => {
    expect(classifyFailureCode('embedding_lane_mismatch: baseUrl=http://127.0.0.1:9999')).toBe(
      'embedding_lane_mismatch'
    );
  });
});

describe('isTimeoutLikeError', () => {
  it('detects request and mcp timeout signatures used by repair post-verify fallback', () => {
    expect(isTimeoutLikeError('MCP error -32001: Request timed out')).toBe(true);
    expect(isTimeoutLikeError('verify_project_index_after timeout after 5000ms')).toBe(true);
    expect(isTimeoutLikeError('Request timed out while waiting for response')).toBe(true);
    expect(isTimeoutLikeError('HTTP 429 Too Many Requests')).toBe(true);
    expect(isTimeoutLikeError('rate limit exceeded for ingest_project_file')).toBe(true);
  });

  it('does not classify unrelated errors as timeout-like', () => {
    expect(isTimeoutLikeError('freshness_precondition_failed: status=stale')).toBe(false);
    expect(
      isTimeoutLikeError('project_not_indexed: verify_project_index reported zero files')
    ).toBe(false);
  });
});

describe('requireVerifyPayload', () => {
  it('allows repair mode to inspect a blocked semantic gate payload', () => {
    const payload = {
      success: false,
      isError: true,
      data: {
        gateSignal: {
          ready: false,
          blockingFailureCode: 'PROJECT_INDEX_STALE',
        },
      },
    };

    expect(requireVerifyPayload('verify_project_index', payload, { allowBlockedGate: true })).toBe(
      payload
    );
    expect(() => requireVerifyPayload('verify_project_index', payload)).toThrow(
      'verify_project_index failed'
    );
  });
});

describe('requireProjectSearchEmbeddingEvidence', () => {
  it('accepts the Project RAG GPU lane evidence', () => {
    expect(() =>
      requireProjectSearchEmbeddingEvidence({
        data: {
          embeddingConfig: {
            provider: 'llamacpp',
            model: 'qwen3-embedding-1024',
            baseUrl: 'http://127.0.0.1:8082',
            dimensions: 1024,
          },
        },
      })
    ).not.toThrow();
  });

  it('rejects missing or wrong embedding evidence', () => {
    expect(() => requireProjectSearchEmbeddingEvidence({ data: {} })).toThrow(
      'embedding_lane_mismatch'
    );
    expect(() =>
      requireProjectSearchEmbeddingEvidence({
        data: {
          embeddingConfig: {
            provider: 'llamacpp',
            model: 'qwen3-embedding-1024',
            baseUrl: 'http://127.0.0.1:9999',
            dimensions: 1024,
          },
        },
      })
    ).toThrow('http://127.0.0.1:8082');
  });
});

describe('selectRepairCandidates', () => {
  it('selects bounded stale candidates preserving order', () => {
    expect(selectRepairCandidates(['b.ts', 'a.ts', 'c.ts', 'a.ts'], 2)).toEqual(['a.ts', 'b.ts']);
  });

  it('supports deterministic resume via offset', () => {
    expect(selectRepairCandidates(['b.ts', 'a.ts', 'c.ts'], 2, 1)).toEqual(['b.ts', 'c.ts']);
  });
});

describe('callToolWithTimeout', () => {
  it('forwards timeout to the action without exposing an abort signal', async () => {
    let captured: { timeout: number } | undefined;
    const result = await callToolWithTimeout(
      'verify_project_index_after',
      1234,
      async (options) => {
        captured = options;
        return 'ok';
      }
    );

    expect(result).toBe('ok');
    expect(captured).toEqual({ timeout: 1234 });
    expect(captured && 'signal' in captured).toBe(false);
  });

  it('throws deterministic timeout error when the action reports timeout', async () => {
    await expect(
      callToolWithTimeout('ingest_project_file', 5, async () => {
        throw new Error('Request timed out');
      })
    ).rejects.toThrow('ingest_project_file timeout after 5ms');
  });
});

describe('createMachineReadableResultLine', () => {
  it('builds a deterministic one-line marker with serialized summary', () => {
    const line = createMachineReadableResultLine({
      ok: true,
      mode: 'repair',
      phaseTimingsMs: {},
      phases: [],
    });
    expect(line.startsWith('MCP_PROJECT_CURRENT_RESULT ')).toBe(true);
    expect(() => JSON.parse(line.replace('MCP_PROJECT_CURRENT_RESULT ', ''))).not.toThrow();
  });

  it('serializes repair post-verify timeout fields for deterministic parsing', () => {
    const line = createMachineReadableResultLine({
      ok: false,
      mode: 'repair',
      postVerifyStatus: 'timeout',
      postVerifyDetail: 'MCP error -32001: Request timed out',
      phaseTimingsMs: { verify_project_index_after: 5000 },
      phases: [
        {
          name: 'verify_project_index_after',
          status: 'skipped',
          latencyMs: 5000,
          detail: 'timeout_tolerated: MCP error -32001: Request timed out',
        },
      ],
      message: 'repair_batch_applied_unverified',
    });

    const parsed = JSON.parse(line.replace('MCP_PROJECT_CURRENT_RESULT ', ''));
    expect(parsed.postVerifyStatus).toBe('timeout');
    expect(parsed.phases[0]?.status).toBe('skipped');
  });
});

describe('finalizeRepairSummary', () => {
  it('keeps nextOffset at the first unconfirmed candidate after a mid-batch timeout', () => {
    type RepairSummary = Parameters<typeof finalizeRepairSummary>[0]['summary'];

    const summary: RepairSummary = {
      ok: false,
      mode: 'repair' as const,
      freshnessStatus: 'stale',
      staleCount: 4,
      phaseTimingsMs: {} as Record<string, number>,
      phases: [] as RepairSummary['phases'],
    };

    finalizeRepairSummary({
      summary,
      phases: summary.phases,
      phaseTimingsMs: summary.phaseTimingsMs,
      verifyAfterOutcome: {
        kind: 'timeout',
        latencyMs: 5000,
        message: 'MCP error -32001: Request timed out',
      },
      reindexedCount: 1,
      skippedMissingCount: 1,
      timedOutCount: 1,
      batchCandidates: 4,
      offset: 3,
      maxFiles: 4,
    });

    expect(summary.processedBatchCount).toBe(3);
    expect(summary.nextOffset).toBe(5);
    expect(summary.message).toContain('nextOffset=5');

    const parsed = JSON.parse(
      createMachineReadableResultLine(summary).replace('MCP_PROJECT_CURRENT_RESULT ', '')
    );
    expect(parsed.nextOffset).toBe(5);
    expect(parsed.batchOffset).toBe(3);
    expect(parsed.batchCandidates).toBe(4);
  });

  it('marks repair as failed when verify-after times out after batch progress', () => {
    type RepairSummary = Parameters<typeof finalizeRepairSummary>[0]['summary'];

    const summary: RepairSummary = {
      ok: false,
      mode: 'repair' as const,
      freshnessStatus: 'stale',
      staleCount: 3,
      phaseTimingsMs: {} as Record<string, number>,
      phases: [] as RepairSummary['phases'],
    };

    finalizeRepairSummary({
      summary,
      phases: summary.phases,
      phaseTimingsMs: summary.phaseTimingsMs,
      verifyAfterOutcome: {
        kind: 'timeout',
        latencyMs: 5000,
        message: 'MCP error -32001: Request timed out',
      },
      reindexedCount: 1,
      skippedMissingCount: 0,
      timedOutCount: 0,
      batchCandidates: 1,
      offset: 0,
      maxFiles: 3,
    });

    const verifyAfterPhase = summary.phases.find(
      (phase) => phase.name === 'verify_project_index_after'
    );

    expect(summary.ok).toBe(false);
    expect(summary.postVerifyStatus).toBe('timeout');
    expect(verifyAfterPhase?.status).toBe('skipped');
    expect(summary.message).toContain('repair_batch_applied_unverified');
    expect(summary.failedPhase).toBe('verify_project_index_after');
    expect(summary.failureCode).toBe('ingest_request_timeout');
  });

  it('restarts from the first candidate after a verified repair batch', () => {
    type RepairSummary = Parameters<typeof finalizeRepairSummary>[0]['summary'];

    const summary: RepairSummary = {
      ok: false,
      mode: 'repair' as const,
      freshnessStatus: 'stale',
      staleCount: 2,
      phaseTimingsMs: {} as Record<string, number>,
      phases: [] as RepairSummary['phases'],
    };

    finalizeRepairSummary({
      summary,
      phases: summary.phases,
      phaseTimingsMs: summary.phaseTimingsMs,
      verifyAfterOutcome: {
        kind: 'complete',
        latencyMs: 10,
        reconciliation: {
          freshness: {
            status: 'stale',
            stalePaths: ['c.ts'],
            staleCount: 1,
            missingCount: 0,
            fileCount: 10,
          },
          scopeCoverage: {
            status: 'covered',
            missingExpectedPaths: [],
            extraIndexedPaths: [],
            ignoredIndexedPaths: [],
            missingExpectedCount: 0,
            extraIndexedCount: 0,
            ignoredIndexedCount: 0,
          },
          candidatePaths: ['c.ts'],
          candidateCount: 1,
          candidatePathCount: 1,
        },
      },
      reindexedCount: 2,
      skippedMissingCount: 0,
      timedOutCount: 0,
      batchCandidates: 2,
      offset: 7,
      maxFiles: 2,
    });

    expect(summary.nextOffset).toBe(0);
  });

  it('resets nextOffset when verify returns a paged candidate path list', () => {
    type RepairSummary = Parameters<typeof finalizeRepairSummary>[0]['summary'];

    const summary: RepairSummary = {
      ok: false,
      mode: 'repair' as const,
      freshnessStatus: 'fresh',
      staleCount: 638,
      phaseTimingsMs: {} as Record<string, number>,
      phases: [] as RepairSummary['phases'],
    };

    finalizeRepairSummary({
      summary,
      phases: summary.phases,
      phaseTimingsMs: summary.phaseTimingsMs,
      verifyAfterOutcome: {
        kind: 'complete',
        latencyMs: 10,
        reconciliation: {
          freshness: {
            status: 'fresh',
            stalePaths: [],
            staleCount: 0,
            missingCount: 0,
            fileCount: 10,
          },
          scopeCoverage: {
            status: 'drift',
            missingExpectedPaths: ['next-page.ts'],
            extraIndexedPaths: [],
            ignoredIndexedPaths: [],
            missingExpectedCount: 633,
            extraIndexedCount: 0,
            ignoredIndexedCount: 0,
          },
          candidatePaths: ['next-page.ts'],
          candidateCount: 633,
          candidatePathCount: 1,
        },
      },
      reindexedCount: 2,
      skippedMissingCount: 3,
      timedOutCount: 0,
      batchCandidates: 5,
      offset: 20,
      maxFiles: 5,
    });

    expect(summary.nextOffset).toBe(0);
    expect(summary.remainingCount).toBe(633);
    expect(summary.message).toContain('remaining=633');
  });

  it('treats repair as a successful no-op when the index is already fresh', () => {
    type RepairSummary = Parameters<typeof finalizeRepairSummary>[0]['summary'];

    const summary: RepairSummary = {
      ok: false,
      mode: 'repair' as const,
      freshnessStatus: 'fresh',
      staleCount: 0,
      phaseTimingsMs: {} as Record<string, number>,
      phases: [] as RepairSummary['phases'],
    };

    finalizeRepairSummary({
      summary,
      phases: summary.phases,
      phaseTimingsMs: summary.phaseTimingsMs,
      verifyAfterOutcome: {
        kind: 'complete',
        latencyMs: 25,
        reconciliation: {
          freshness: {
            status: 'fresh',
            stalePaths: [],
            staleCount: 0,
            missingCount: 0,
            fileCount: 10,
          },
          scopeCoverage: {
            status: 'covered',
            missingExpectedPaths: [],
            extraIndexedPaths: [],
            ignoredIndexedPaths: [],
            missingExpectedCount: 0,
            extraIndexedCount: 0,
            ignoredIndexedCount: 0,
          },
          candidatePaths: [],
          candidateCount: 0,
          candidatePathCount: 0,
        },
      },
      reindexedCount: 0,
      skippedMissingCount: 0,
      timedOutCount: 0,
      batchCandidates: 0,
      offset: 0,
      maxFiles: 10,
    });

    expect(summary.ok).toBe(true);
    expect(summary.processedBatchCount).toBe(0);
    expect(summary.remainingCount).toBe(0);
    expect(summary.message).toContain('no stale files found');
  });
});
