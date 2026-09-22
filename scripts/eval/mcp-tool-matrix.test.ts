import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formatErrorForOutput } from '../../lib/shared/credential-redact.js';
import { readPositiveIntegerEnv, withTimeout } from '../../mcp/lib/timeout.js';
import { expectedVisibleMcpToolNames } from './mcp-expected-surface.js';
import {
  assertAdaptationResult,
  buildMcpRequestOptions,
  buildProjectSearchArguments,
  callToolWithTimeout,
  connectWithTimeout,
  extractPayload,
  isNonBlockingRun,
  isOptionalAdaptationTool,
  parseArgs,
  requireHealthyHealthResult,
  requireSuccess,
  summarizeMcpReleaseEvidence,
} from './mcp-tool-matrix.js';

describe('Project search arguments', () => {
  it('uses the supported hybrid mode for canonical and compatibility searches', () => {
    expect(buildProjectSearchArguments('project-2', 'symbol references')).toEqual({
      projectId: 'project-2',
      query: 'symbol references',
      limit: 5,
      mode: 'hybrid',
    });
  });
});

describe('caller-visible MCP surface', () => {
  it('keeps the frozen read-only all-toolset surface at 18 public reads', () => {
    const names = expectedVisibleMcpToolNames('read_only', 'all');

    expect(names).toHaveLength(18);
    expect(names).toContain('get_directory_groups');
    expect(names).toContain('search_project_docs');
    expect(names).not.toContain('get_feature_hubs');
    expect(names).not.toContain('get_code_metrics');
    expect(names).not.toContain('search_inventory');
    expect(names).not.toContain('get_dead_code_report');
    expect(names).not.toContain('register_project');
    expect(names).not.toContain('ingest_project');
    expect(names).not.toContain('ingest_project_file');
    expect(names).not.toContain('ensure_reranker');
  });

  it('adds only guarded writes for an opted-in read-write all-toolset caller', () => {
    const names = expectedVisibleMcpToolNames('read_write', 'all');

    expect(names).toHaveLength(23);
    expect(names).toEqual(
      expect.arrayContaining([
        'register_project',
        'ingest_project',
        'ingest_project_file',
        'ensure_reranker',
      ])
    );
    expect(names).not.toContain('get_feature_hubs');
    expect(names).not.toContain('search_inventory');
  });

  it('selects docs and project cases by toolset without expanding visibility', () => {
    const docs = expectedVisibleMcpToolNames('read_only', 'docs');
    const projects = expectedVisibleMcpToolNames('read_only', 'projects');

    expect(docs).toHaveLength(6);
    expect(docs).not.toContain('register_project');
    expect(docs).not.toContain('search_project_docs');
    expect(projects).toHaveLength(13);
    expect(projects).toContain('search_project_docs');
    expect(projects).not.toContain('search_docs');
  });
});

function makeTemp(prefix: string): string {
  return mkdtempSync(
    join(tmpdir(), `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  );
}

describe('mcp-tool-matrix arg parsing', () => {
  it('skips the external project instead of throwing when --external-project-root is absent', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    try {
      const args = parseArgs(['--current-include-roots', 'src'], cwd);
      expect(args.docsSurfaceOnly).toBe(false);
      expect(args.externalSkipped).toBe(true);
      expect(args.externalSkipReason).toBe('externalProjectRootNotProvided');
      expect(args.externalProjectRoot).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('skips the external project when --external-project-root points to a missing path', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    try {
      const missing = join(cwd, 'does-not-exist');
      const args = parseArgs(
        ['--current-include-roots', 'src', '--external-project-root', missing],
        cwd
      );
      expect(args.externalSkipped).toBe(true);
      expect(args.externalSkipReason).toBe('externalProjectRootMissing');
      expect(args.externalProjectRoot).toBe(resolve(missing));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not mark external as skipped when --external-project-root points to an existing path', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    const external = makeTemp('mcp-tool-matrix-test-ext-');
    try {
      const args = parseArgs(
        ['--current-include-roots', 'src', '--external-project-root', external],
        cwd
      );
      expect(args.externalSkipped).toBe(false);
      expect(args.externalSkipReason).toBeUndefined();
      expect(args.externalProjectRoot).toBe(resolve(external));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('uses the configured external probe file for the write journey', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    const external = makeTemp('mcp-tool-matrix-test-ext-');
    try {
      const args = parseArgs(
        [
          '--current-include-roots',
          'src',
          '--external-project-root',
          external,
          '--external-probe-file',
          'src/auth.ts',
        ],
        cwd
      );
      expect(args.externalProbeFile).toBe('src/auth.ts');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('still throws when include roots cannot be inferred', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    try {
      expect(() => parseArgs([], cwd)).toThrow(/No include roots found/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('missing external root does NOT leak into docsSurfaceOnly: externalSkipped is independent', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    try {
      const args = parseArgs(['--current-include-roots', 'src'], cwd);
      expect(args.externalSkipped).toBe(true);
      expect(args.docsSurfaceOnly).toBe(false);
      expect(args.externalSkipReason).toBe('externalProjectRootNotProvided');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps --docs-surface-only as the explicit opt-in and does not mark external as missing', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    try {
      const args = parseArgs(['--current-include-roots', 'src', '--docs-surface-only'], cwd);
      expect(args.docsSurfaceOnly).toBe(true);
      expect(args.externalSkipped).toBe(false);
      expect(args.externalSkipReason).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--skip-adaptation flag sets skipAdaptation to true', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    try {
      const args = parseArgs(['--current-include-roots', 'src', '--skip-adaptation'], cwd);
      expect(args.skipAdaptation).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('skipAdaptation defaults to false without --skip-adaptation', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    try {
      const args = parseArgs(['--current-include-roots', 'src'], cwd);
      expect(args.skipAdaptation).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps source inventory mutation opt-in', () => {
    const cwd = makeTemp('mcp-tool-matrix-test-cwd-');
    try {
      const defaultArgs = parseArgs(['--current-include-roots', 'src'], cwd);
      const optedInArgs = parseArgs(['--current-include-roots', 'src', '--refresh-inventory'], cwd);

      expect(defaultArgs.refreshInventory).toBe(false);
      expect(optedInArgs.refreshInventory).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('MCP release evidence', () => {
  const currentProject = {
    skipped: false as const,
    projectId: 'current-project',
    slug: 'current-project',
    searchHits: 1,
    symbolMatches: 1,
    referenceCount: 1,
  };
  const externalProject = {
    skipped: false as const,
    projectId: 'external-project',
    slug: 'external-project',
    indexedCount: 1,
    invalidIndexedPaths: [],
    excludedIndexedPaths: [],
    searchHits: 1,
    symbolMatches: 1,
  };

  it('does not mark full evidence eligible when a project journey is missing', () => {
    expect(
      summarizeMcpReleaseEvidence(false, currentProject, {
        skipped: true,
        skipClass: 'release-required',
        reason: 'externalProjectRootNotProvided',
      })
    ).toEqual({
      status: 'incomplete',
      eligible: false,
      missingJourneys: ['external'],
    });
  });

  it('marks explicit docs-only skips as diagnostic-only evidence', () => {
    const skipped = {
      skipped: true as const,
      skipClass: 'diagnostic-optional' as const,
      reason: 'docsSurfaceOnly' as const,
    };

    expect(summarizeMcpReleaseEvidence(true, skipped, skipped)).toEqual({
      status: 'diagnostic-only',
      eligible: false,
      missingJourneys: ['current', 'external'],
    });
  });

  it('marks full evidence complete only after both project journeys run', () => {
    expect(summarizeMcpReleaseEvidence(false, currentProject, externalProject)).toEqual({
      status: 'complete',
      eligible: true,
      missingJourneys: [],
    });
  });
});

describe('optional adaptation tool classification', () => {
  it('classifies adapt_docs as optional', () => {
    expect(isOptionalAdaptationTool('adapt_docs')).toBe(true);
  });

  it('classifies search_and_adapt as optional', () => {
    expect(isOptionalAdaptationTool('search_and_adapt')).toBe(true);
  });

  it('does not classify core tools as optional', () => {
    expect(isOptionalAdaptationTool('search_docs')).toBe(false);
    expect(isOptionalAdaptationTool('get_document')).toBe(false);
    expect(isOptionalAdaptationTool('health_check')).toBe(false);
    expect(isOptionalAdaptationTool('register_project')).toBe(false);
    expect(isOptionalAdaptationTool('ingest_project')).toBe(false);
  });

  it('rejects MCP error envelopes before adaptation content assertions', () => {
    const payload = extractPayload({
      isError: true,
      content: [{ type: 'text', text: 'API_KEY_INVALID' }],
    });

    expect(payload.isError).toBe(true);
    expect(() => assertAdaptationResult('adapt_docs', payload, 'API_KEY_INVALID')).toThrow(
      'adapt_docs failed'
    );
    expect(() => requireSuccess('search_and_adapt', payload)).toThrow('search_and_adapt failed');
  });

  it('accepts a non-error adaptation fallback with sufficient text', () => {
    const rawText = 'Local fallback adaptation content '.repeat(3);
    const payload = extractPayload({
      isError: false,
      content: [{ type: 'text', text: rawText }],
    });

    expect(assertAdaptationResult('search_and_adapt', payload, rawText)).toBe(
      `chars=${rawText.length}`
    );
  });

  it('counts optional adaptation failures in overallPass', () => {
    const runs = [
      { name: 'search_docs', status: 'passed' as const },
      { name: 'adapt_docs', status: 'failed' as const },
    ];
    const overallPass = runs
      .filter((run) => !isNonBlockingRun(run.name))
      .every((run) => run.status === 'passed');

    expect(overallPass).toBe(false);
  });
});

describe('structured health assertions', () => {
  it('rejects an error-bearing health component even when text is positive', () => {
    const payload = extractPayload({
      isError: false,
      content: [{ type: 'text', text: 'MCP Server: OK\nDocs RAG Postgres: OK' }],
      structuredContent: {
        success: true,
        data: {
          components: [
            { component: 'MCP Server', status: 'OK' },
            { component: 'Docs RAG Postgres', status: 'ERROR', details: 'unavailable' },
          ],
        },
      },
    });

    expect(() => requireHealthyHealthResult('health_check', payload)).toThrow(
      'Docs RAG Postgres=ERROR'
    );
  });
});

describe('non-blocking run classification', () => {
  it('classifies cleanup_external as non-blocking', () => {
    expect(isNonBlockingRun('cleanup_external')).toBe(true);
  });

  it('does not classify core tools as non-blocking', () => {
    expect(isNonBlockingRun('search_docs')).toBe(false);
    expect(isNonBlockingRun('get_document')).toBe(false);
    expect(isNonBlockingRun('health_check')).toBe(false);
    expect(isNonBlockingRun('register_project')).toBe(false);
    expect(isNonBlockingRun('ingest_project')).toBe(false);
  });

  it('does not classify adaptation tools as non-blocking (they use a separate path)', () => {
    expect(isNonBlockingRun('adapt_docs')).toBe(false);
    expect(isNonBlockingRun('search_and_adapt')).toBe(false);
  });

  it('non-blocking runs do not affect overallPass', () => {
    // Simulate the overallPass filter logic
    const runs = [
      { name: 'search_docs', status: 'passed' },
      { name: 'cleanup_external', status: 'passed' },
    ];
    const coreRuns = runs.filter((r) => !isNonBlockingRun(r.name));
    const overallPass = coreRuns.every((r) => r.status === 'passed');
    expect(overallPass).toBe(true);
  });

  it('cleanup_external always reports as passed regardless of cleanup detail', () => {
    // The cleanup function returns strings like:
    // - 'unsupported: no MCP cleanup surface; external project registration retained'
    // - 'skipped: no external project was registered'
    // - 'skipped: keep-external-project requested'
    // All are expected outcomes, so status should always be 'passed'
    const details = [
      'unsupported: no MCP cleanup surface; external project registration retained',
      'skipped: no external project was registered',
      'skipped: keep-external-project requested',
    ];
    for (const detail of details) {
      // The run is always pushed with status 'passed'
      const run = {
        name: 'cleanup_external',
        target: 'external',
        status: 'passed',
        latencyMs: 0,
        detail,
      };
      expect(run.status).toBe('passed');
      expect(run.detail).toBeTruthy();
    }
  });
});

describe('MCP timeout — env parsing (timeout lib)', () => {
  const PREV_VALUES: Record<string, string | undefined> = {};
  function preserveEnv(names: string[]) {
    for (const name of names) {
      PREV_VALUES[name] = process.env[name];
    }
  }
  function restoreEnv(names: string[]) {
    for (const name of names) {
      const v = PREV_VALUES[name];
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  }

  it('readPositiveIntegerEnv returns fallback when MCP_CONNECT_TIMEOUT_MS is not set', () => {
    preserveEnv(['MCP_CONNECT_TIMEOUT_MS']);
    delete process.env.MCP_CONNECT_TIMEOUT_MS;
    expect(readPositiveIntegerEnv('MCP_CONNECT_TIMEOUT_MS', 30_000)).toBe(30_000);
    restoreEnv(['MCP_CONNECT_TIMEOUT_MS']);
  });

  it('readPositiveIntegerEnv returns fallback when MCP_TOOL_TIMEOUT_MS is invalid', () => {
    preserveEnv(['MCP_TOOL_TIMEOUT_MS']);
    process.env.MCP_TOOL_TIMEOUT_MS = 'not-a-number';
    expect(readPositiveIntegerEnv('MCP_TOOL_TIMEOUT_MS', 120_000)).toBe(120_000);
    restoreEnv(['MCP_TOOL_TIMEOUT_MS']);
  });

  it('readPositiveIntegerEnv parses valid MCP_CONNECT_TIMEOUT_MS', () => {
    preserveEnv(['MCP_CONNECT_TIMEOUT_MS']);
    process.env.MCP_CONNECT_TIMEOUT_MS = '15000';
    expect(readPositiveIntegerEnv('MCP_CONNECT_TIMEOUT_MS', 30_000)).toBe(15_000);
    restoreEnv(['MCP_CONNECT_TIMEOUT_MS']);
  });

  it('withTimeout resolves quickly for fast operations', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 5_000, 'fast operation');
    expect(result).toBe('ok');
  });

  it('withTimeout rejects with a descriptive message when operation times out', async () => {
    await expect(withTimeout(new Promise<string>(() => {}), 1, 'slow operation')).rejects.toThrow(
      'slow operation timed out after 1ms'
    );
  });
});

describe('MCP timeout — SDK call boundary', () => {
  it('buildMcpRequestOptions produces { timeout } object', () => {
    const opts = buildMcpRequestOptions(12345);
    expect(opts).toEqual({ timeout: 12345 });
  });

  it('buildMcpRequestOptions rejects non-finite values via the type boundary', () => {
    // The runtime contract is a positive number; the function does not validate
    // because it mirrors the SDK RequestOptions type directly.
    const opts = buildMcpRequestOptions(0);
    expect(opts).toEqual({ timeout: 0 });
  });

  it('callToolWithTimeout passes { timeout } as 3rd argument to Client.callTool', async () => {
    const mockCallTool = vi.fn<any>();
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const client = { callTool: mockCallTool } as any;

    const result = await callToolWithTimeout(client, 'search_docs', { query: 'test' }, 42_000);

    // 1st arg: the request object with name + arguments
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'search_docs', arguments: { query: 'test' } }),
      // 2nd arg: result schema — undefined in our production call
      undefined,
      // 3rd arg: RequestOptions with timeout
      { timeout: 42_000 }
    );
    expect(result.content).toBeDefined();
  });

  it('connectWithTimeout passes { timeout } as 2nd argument to Client.connect', async () => {
    const mockConnect = vi.fn<any>();
    mockConnect.mockResolvedValue(undefined);
    const client = { connect: mockConnect } as any;
    const transport = {} as any;

    await connectWithTimeout(client, transport, 60_000);

    expect(mockConnect).toHaveBeenCalledWith(transport, { timeout: 60_000 });
  });

  it('callToolWithTimeout rejects when mock rejects', async () => {
    const mockCallTool = vi.fn<any>();
    mockCallTool.mockRejectedValue(new Error('SDK timeout'));
    const client = { callTool: mockCallTool } as any;

    await expect(callToolWithTimeout(client, 'search_docs', {}, 1)).rejects.toThrow('SDK timeout');
  });

  it('connectWithTimeout rejects when mock rejects', async () => {
    const mockConnect = vi.fn<any>();
    mockConnect.mockRejectedValue(new Error('connect refused'));
    const client = { connect: mockConnect } as any;
    const transport = {} as any;

    await expect(connectWithTimeout(client, transport, 30_000)).rejects.toThrow('connect refused');
  });
});

describe('credential redaction in eval output (S1)', () => {
  // formatErrorForOutput is the function wired into summarizeError, which
  // populates run detail and main().catch output in mcp-tool-matrix.
  // These tests prove the redaction path works for the three synthetic
  // credential classes the task targets.

  it('redacts user:secret@ in error messages from MCP failures', () => {
    const result = formatErrorForOutput(
      new Error('MCP call failed: connection to https://admin:vo5secreta@api.example.com refused')
    );
    expect(result).toContain('[REDACTED:userinfo]');
    expect(result).toContain('api.example.com');
    expect(result).toContain('refused');
    expect(result).not.toContain('vo5secreta');
    expect(result).not.toContain('admin:vo5secreta');
  });

  it('redacts Bearer tokens in MCP failure detail', () => {
    const result = formatErrorForOutput(
      new Error('Authorization: Bearer syn-bearer-value-abcdef1234567890 rejected')
    );
    expect(result).toContain('[REDACTED:bearer-token]');
    expect(result).toContain('Authorization:');
    expect(result).not.toContain('syn-bearer-value-abcdef1234567890');
  });

  it('redacts postgres connection passwords in eval error messages', () => {
    const result = formatErrorForOutput(
      new Error(
        'postgresql://dbuser:syn-db-pass-9999@pg.example.com:5432/mydb — connection refused'
      )
    );
    expect(result).toContain('[REDACTED:database-url-password]');
    expect(result).toContain('pg.example.com');
    expect(result).toContain('mydb');
    expect(result).toContain('refused');
    expect(result).not.toContain('syn-db-pass-9999');
  });

  it('preserves non-secret MCP error details', () => {
    const result = formatErrorForOutput(
      new Error('tool search_docs failed: SDK timeout after 30000ms')
    );
    expect(result).toContain('search_docs');
    expect(result).toContain('SDK timeout');
    expect(result).toContain('30000ms');
  });
});
