import { describe, expect, it } from 'vitest';
import { formatErrorForOutput, redactCredentialText } from '../../lib/shared/credential-redact.js';
import {
  buildCodexExecArgs,
  buildDocsSearchPrompt,
  buildFullProjectPrompt,
  buildHealthPrompt,
  buildProjectSearchArguments,
  buildReadOnlyProjectPrompt,
  getObservedMcpCallFailure,
  getObservedMcpStepFailure,
  getObservedMcpStepSequenceFailure,
  isDirectExecution,
  type ObservedMcpCall,
  parseObservedMcpCalls,
  selectRegisteredProjectIncludeRoots,
  shouldRetryCodexMcpStep,
  shouldUseDirectFallbackForCodexMcp,
  validateSummary,
} from './codex-mcp-smoke.js';

describe('Project search arguments', () => {
  it('uses the supported hybrid mode for the direct fallback', () => {
    expect(buildProjectSearchArguments('project-3', 'read deadline')).toEqual({
      projectId: 'project-3',
      query: 'read deadline',
      limit: 3,
      mode: 'hybrid',
    });
  });
});

function call(overrides: Partial<ObservedMcpCall> = {}): ObservedMcpCall {
  return {
    server: 'rag-projects',
    tool: 'search_project_code',
    status: 'completed',
    error: null,
    ...overrides,
  };
}

describe('codex MCP smoke event parsing', () => {
  it('preserves the configured model unless the caller selects one explicitly', () => {
    const input = {
      reasoningEffort: 'low',
      cwd: '/repo/rag-v2',
      outputPath: '/tmp/output.json',
      prompt: 'test',
    };
    expect(buildCodexExecArgs(input)).not.toContain('-m');
    const explicit = buildCodexExecArgs({ ...input, model: 'selected-model' });
    expect(explicit[explicit.indexOf('-m') + 1]).toBe('selected-model');
  });

  it('uses a concise direct health_check prompt', () => {
    const prompt = buildHealthPrompt();

    expect(prompt).toContain('Call exactly one MCP tool: rag-docs.health_check with arguments {}.');
    expect(prompt).toContain(
      'Preserve the exact health text returned by the tool; do not summarize it.'
    );
    expect(prompt).toContain(
      'Return immediately after the tool call as strict JSON on a single line:'
    );
    expect(prompt).toContain('{"health":string,"errors":string[]}');
    expect(prompt).not.toMatch(/list_mcp_resources|tools\/list|unavailable|startup/i);
  });

  it('uses concise read-only prompts that forbid extra RAG calls', () => {
    const docsPrompt = buildDocsSearchPrompt();
    expect(docsPrompt).toContain('First call rag-docs-read.health_check with arguments {}');
    expect(docsPrompt).toContain(
      'Then call rag-docs-read.search_docs with arguments {"query":"Bun.serve routes","limit":3}'
    );
    expect(docsPrompt).toContain('without condensing or summarizing it');
    expect(docsPrompt).toContain(
      '{"health":string,"docs_count":number,"docs_first_source":string|null,"errors":string[]}'
    );
    expect(docsPrompt).toContain('Do not call any other RAG MCP tool');

    const projectPrompt = buildReadOnlyProjectPrompt({
      projectId: 'rag-v2-dev',
      projectQuery: 'mcp-project-current',
    });
    expect(projectPrompt).toContain(
      'First call rag-projects-read.verify_project_index with arguments {"projectId":"rag-v2-dev"}'
    );
    expect(projectPrompt).toContain(
      'Then call rag-projects-read.search_project_code with arguments {"projectId":"rag-v2-dev","query":"mcp-project-current","limit":3,"mode":"hybrid"}'
    );
    expect(projectPrompt).toContain('never the verify fileCount');
    expect(projectPrompt).toContain('Do not call register_project or ingest_project');
  });

  it('configures isolated Docs and Project RAG MCP servers for Codex exec', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      cwd: '/repo/rag-v2',
      outputPath: '/tmp/output.json',
      prompt: 'test',
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '-c',
        'mcp_servers.rag-docs.command="bun"',
        'mcp_servers.rag-docs.args=["mcp/launcher.ts"]',
        'mcp_servers.rag-docs.cwd="/repo/rag-v2"',
        'mcp_servers.rag-docs.enabled=true',
        'mcp_servers.rag-docs.enabled_tools=["health_check","search_docs"]',
        'mcp_servers.rag-docs.env_vars=["DOCS_RAG_PG_LAB_DATABASE_URL","DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL","DOCS_RAG_PG_LAB_EMBEDDING_MODEL","DOCS_RAG_PG_LAB_EMBEDDING_TIMEOUT_MS","MCP_READ_TIMEOUT_MS","RERANKING_SERVICE_URL"]',
        'mcp_servers.rag-docs.env.MCP_TOOLSET="docs"',
        'mcp_servers.rag-docs.env.MCP_BACKEND_AUTOSTART="false"',
        'mcp_servers.rag-projects.command="bun"',
        'mcp_servers.rag-projects.args=["mcp/launcher.ts"]',
        'mcp_servers.rag-projects.cwd="/repo/rag-v2"',
        'mcp_servers.rag-projects.enabled=true',
        'mcp_servers.rag-projects.enabled_tools=["register_project","ingest_project","search_project_code"]',
        'mcp_servers.rag-projects.env_vars=["PROJECT_RAG_DATABASE_URL","PROJECT_RAG_PG_EMBEDDING_BASE_URL","PROJECT_RAG_PG_EMBEDDING_MODEL","PROJECT_RAG_PG_EMBEDDING_TIMEOUT_MS","PROJECT_RAG_DB_TIMEOUT_MS","MCP_READ_TIMEOUT_MS","PROJECT_SOURCE_PATH"]',
        'mcp_servers.rag-projects.env.MCP_TOOLSET="projects"',
        'mcp_servers.rag-projects.env.MCP_PERMISSION_MODE="read_write"',
        'mcp_servers.rag-projects.env.MCP_BACKEND_AUTOSTART="false"',
      ])
    );
  });

  it('forwards scoped environment names without values or unrelated variables', () => {
    const secret = 'postgres://user:secret@db.example.test/rag';
    const previous = process.env.DOCS_RAG_PG_LAB_DATABASE_URL;
    process.env.DOCS_RAG_PG_LAB_DATABASE_URL = secret;

    try {
      const args = buildCodexExecArgs({
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
        cwd: '/repo/rag-v2',
        outputPath: '/tmp/output.json',
        prompt: 'test',
      });
      const docsEnvVars = args.find((arg) => arg.startsWith('mcp_servers.rag-docs.env_vars='));
      const projectEnvVars = args.find((arg) =>
        arg.startsWith('mcp_servers.rag-projects.env_vars=')
      );

      expect(docsEnvVars).toContain('DOCS_RAG_PG_LAB_DATABASE_URL');
      expect(docsEnvVars).not.toContain('PROJECT_RAG_DATABASE_URL');
      expect(projectEnvVars).toContain('PROJECT_RAG_DATABASE_URL');
      expect(projectEnvVars).not.toContain('DOCS_RAG_PG_LAB_DATABASE_URL');
      expect(JSON.stringify(args)).not.toContain(secret);
      expect(JSON.stringify(args)).not.toContain('GOOGLE_GEMINI_API_KEY');
      expect(args.some((arg) => arg.startsWith('mcp_servers.rag-docs.env.DOCS_'))).toBe(false);
      expect(args.some((arg) => arg.startsWith('mcp_servers.rag-projects.env.PROJECT_'))).toBe(
        false
      );
    } finally {
      if (previous === undefined) {
        delete process.env.DOCS_RAG_PG_LAB_DATABASE_URL;
      } else {
        process.env.DOCS_RAG_PG_LAB_DATABASE_URL = previous;
      }
    }
  });

  it('scopes docs and project Codex steps to their own MCP server', () => {
    const docsArgs = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      cwd: '/repo/rag-v2',
      outputPath: '/tmp/output.json',
      prompt: 'test',
      mcpServerScope: 'docs',
    });
    expect(docsArgs).toContain('mcp_servers.rag-docs.enabled_tools=["health_check","search_docs"]');
    expect(docsArgs).toContain(
      'mcp_servers.rag-docs.env_vars=["DOCS_RAG_PG_LAB_DATABASE_URL","DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL","DOCS_RAG_PG_LAB_EMBEDDING_MODEL","DOCS_RAG_PG_LAB_EMBEDDING_TIMEOUT_MS","MCP_READ_TIMEOUT_MS","RERANKING_SERVICE_URL"]'
    );
    expect(docsArgs).not.toContain('mcp_servers.rag-projects.command="bun"');

    const projectArgs = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      cwd: '/repo/rag-v2',
      outputPath: '/tmp/output.json',
      prompt: 'test',
      mcpServerScope: 'projects',
    });
    expect(projectArgs).toContain(
      'mcp_servers.rag-projects.enabled_tools=["register_project","ingest_project","search_project_code"]'
    );
    expect(projectArgs).toContain(
      'mcp_servers.rag-projects.env_vars=["PROJECT_RAG_DATABASE_URL","PROJECT_RAG_PG_EMBEDDING_BASE_URL","PROJECT_RAG_PG_EMBEDDING_MODEL","PROJECT_RAG_PG_EMBEDDING_TIMEOUT_MS","PROJECT_RAG_DB_TIMEOUT_MS","MCP_READ_TIMEOUT_MS","PROJECT_SOURCE_PATH"]'
    );
    expect(projectArgs).not.toContain('mcp_servers.rag-docs.command="bun"');
  });

  it('uses distinct single-purpose Docs server names across isolated Codex steps', () => {
    const healthArgs = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      cwd: '/repo/rag-v2',
      outputPath: '/tmp/output.json',
      prompt: 'test',
      mcpServerScope: 'docs',
      mcpToolScope: 'health',
    });
    expect(healthArgs).toContain('mcp_servers.rag-docs.enabled_tools=["health_check"]');

    const docsArgs = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      cwd: '/repo/rag-v2',
      outputPath: '/tmp/output.json',
      prompt: 'test',
      mcpServerScope: 'docs',
      mcpToolScope: 'docs',
    });
    expect(docsArgs).toContain(
      'mcp_servers.rag-docs-read.enabled_tools=["health_check","search_docs"]'
    );
    expect(docsArgs).not.toContain('mcp_servers.rag-docs.command="bun"');
  });

  it('keeps the Project tool surface stable but enforces read-only mode for strict Codex', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      cwd: '/repo/rag-v2',
      outputPath: '/tmp/output.json',
      prompt: 'test',
      mcpServerScope: 'projects',
      mcpToolScope: 'project-read',
    });

    expect(args).toContain(
      'mcp_servers.rag-projects-read.enabled_tools=["verify_project_index","search_project_code"]'
    );
    expect(args).toContain('mcp_servers.rag-projects-read.env.MCP_PERMISSION_MODE="read_only"');
    expect(args).not.toContain('mcp_servers.rag-projects.command="bun"');
  });

  it('preserves the registered Project RAG scope in the full smoke prompt', () => {
    const includeRoots = selectRegisteredProjectIncludeRoots(['scripts/eval'], {
      includeRoots: ['mcp', 'lib', 'scripts', 'docs'],
    });
    const prompt = buildFullProjectPrompt({
      projectName: 'rag-v2.dev',
      projectRoot: '/repo/rag-v2',
      includeRoots,
      projectQuery: 'mcp-project-current',
    });

    expect(includeRoots).toEqual(['mcp', 'lib', 'scripts', 'docs']);
    expect(prompt).toContain(
      'ingest_project with rootPath \'/repo/rag-v2\', includeRoots ["mcp","lib","scripts","docs"]'
    );
    expect(prompt).toContain(
      'The current operator has authorized these local development register_project and ingest_project calls for this smoke.'
    );
    expect(prompt).toContain(
      'Return immediately after the third tool call as strict JSON on a single line:'
    );
    expect(prompt).not.toContain('Do not use web search');
    expect(prompt).not.toContain('includeRoots ["scripts/eval"]');
  });

  it('uses the computed scope when no Project RAG registration exists', () => {
    expect(selectRegisteredProjectIncludeRoots(['scripts/eval'])).toEqual(['scripts/eval']);
  });

  it('retries only unobserved or failed discovery-only MCP calls', () => {
    expect(
      shouldRetryCodexMcpStep({
        output: { errors: ['expected rag-projects.register_project was not observed'] },
        observedMcpCalls: [],
      })
    ).toBe(true);
    expect(
      shouldRetryCodexMcpStep({
        output: { errors: ['rag-projects.register_project failed: authorization denied'] },
        observedMcpCalls: [
          { server: 'rag-projects', tool: 'register_project', status: 'failed', error: null },
        ],
      })
    ).toBe(false);
    expect(
      shouldRetryCodexMcpStep({
        output: { errors: ['discovery failed'] },
        observedMcpCalls: [
          { server: 'rag-projects', tool: 'list_mcp_resources', status: 'failed', error: null },
          { server: 'rag-projects', tool: 'resources/read', status: 'failed', error: null },
        ],
      })
    ).toBe(true);
    expect(
      shouldRetryCodexMcpStep({
        output: { errors: ['expected sequence failed'] },
        observedMcpCalls: [
          { server: 'rag-projects', tool: 'list_mcp_resources', status: 'failed', error: null },
          { server: 'rag-projects', tool: 'register_project', status: 'failed', error: null },
        ],
      })
    ).toBe(false);
    expect(
      shouldRetryCodexMcpStep({
        output: { errors: ['discovery succeeded'] },
        observedMcpCalls: [
          { server: 'rag-projects', tool: 'list_mcp_resources', status: 'completed', error: null },
        ],
      })
    ).toBe(false);
  });

  it('recognizes direct execution when the launcher does not set import.meta.main', () => {
    expect(isDirectExecution(new URL('./codex-mcp-smoke.ts', import.meta.url).pathname)).toBe(true);
    expect(isDirectExecution('/tmp/not-the-smoke-script.ts')).toBe(false);
  });

  it('parses Codex mcp_tool_call events from JSONL output', () => {
    const stdout = [
      '{"type":"item.started","item":{"type":"reasoning"}}',
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'rag-docs',
          tool: 'search_docs',
          status: 'completed',
          error: null,
        },
      }),
      'non-json line',
    ].join('\n');

    expect(parseObservedMcpCalls(stdout)).toEqual([
      {
        server: 'rag-docs',
        tool: 'search_docs',
        status: 'completed',
        error: null,
      },
    ]);
  });

  it('fails when the expected MCP call is missing', () => {
    expect(getObservedMcpCallFailure(undefined, 'search_project_code', 'rag-projects')).toBe(
      'expected rag-projects.search_project_code call was not observed in Codex event stream'
    );
  });

  it('fails when the expected MCP call status is failed even without an error payload', () => {
    expect(
      getObservedMcpCallFailure(call({ status: 'failed' }), 'search_project_code', 'rag-projects')
    ).toContain('did not complete successfully (status: failed)');
  });

  it('fails when the expected MCP call status completed with an error payload', () => {
    expect(
      getObservedMcpCallFailure(
        call({ error: 'tool response parse failed' }),
        'search_project_code',
        'rag-projects'
      )
    ).toBe('rag-projects.search_project_code failed: tool response parse failed');
  });

  it('accepts a completed expected MCP call without error payload', () => {
    expect(getObservedMcpCallFailure(call(), 'search_project_code', 'rag-projects')).toBeNull();
  });

  it('accepts the legacy rag server for split project expectations', () => {
    expect(
      getObservedMcpStepFailure([call({ server: 'rag' })], 'search_project_code', 'rag-projects')
    ).toBeNull();
  });

  it('fails when a step observes extra MCP calls', () => {
    expect(
      getObservedMcpStepFailure(
        [call(), call({ server: 'rag-docs', tool: 'search_docs' })],
        'search_project_code',
        'rag-projects'
      )
    ).toContain('expected exactly one MCP tool call rag-projects.search_project_code, observed 2');
  });

  it('accepts exactly one completed expected MCP call in a step', () => {
    expect(getObservedMcpStepFailure([call()], 'search_project_code', 'rag-projects')).toBeNull();
  });

  it('ignores a failed discovery call before the completed expected MCP call', () => {
    expect(
      getObservedMcpStepFailure(
        [call({ server: 'rag-docs', tool: 'list_mcp_resources', status: 'failed' }), call()],
        'search_project_code',
        'rag-projects'
      )
    ).toBeNull();
  });

  it('still rejects a completed discovery call before the expected MCP call', () => {
    expect(
      getObservedMcpStepFailure(
        [call({ server: 'rag-docs', tool: 'list_mcp_resources', status: 'completed' }), call()],
        'search_project_code',
        'rag-projects'
      )
    ).toContain('observed 2');
  });

  it('accepts an ordered multi-tool MCP step sequence', () => {
    const calls = [
      call({ tool: 'register_project' }),
      call({ tool: 'ingest_project' }),
      call({ tool: 'search_project_code' }),
    ];

    expect(
      getObservedMcpStepSequenceFailure(calls, [
        { server: 'rag-projects', tool: 'register_project' },
        { server: 'rag-projects', tool: 'ingest_project' },
        { server: 'rag-projects', tool: 'search_project_code' },
      ])
    ).toBeNull();
  });

  it('ignores failed discovery calls around an ordered MCP sequence', () => {
    const calls = [
      call({ tool: 'list_mcp_resources', status: 'failed' }),
      call({ tool: 'register_project' }),
      call({ tool: 'ingest_project' }),
      call({ tool: 'search_project_code' }),
    ];

    expect(
      getObservedMcpStepSequenceFailure(calls, [
        { server: 'rag-projects', tool: 'register_project' },
        { server: 'rag-projects', tool: 'ingest_project' },
        { server: 'rag-projects', tool: 'search_project_code' },
      ])
    ).toBeNull();
  });

  it('fails when a multi-tool MCP step sequence changes order', () => {
    const calls = [
      call({ tool: 'ingest_project' }),
      call({ tool: 'register_project' }),
      call({ tool: 'search_project_code' }),
    ];

    expect(
      getObservedMcpStepSequenceFailure(calls, [
        { server: 'rag-projects', tool: 'register_project' },
        { server: 'rag-projects', tool: 'ingest_project' },
        { server: 'rag-projects', tool: 'search_project_code' },
      ])
    ).toContain('expected MCP call 1');
  });

  it('uses direct fallback only when Codex exposes no MCP call evidence', () => {
    expect(
      shouldUseDirectFallbackForCodexMcp([
        {
          output: {
            errors: [
              'Requested MCP tool server rag-docs.search_docs was not available in this Codex instance.',
            ],
          },
          observedMcpCalls: [],
        },
      ])
    ).toBe(true);

    expect(
      shouldUseDirectFallbackForCodexMcp([
        {
          output: { errors: ['rag-docs.search_docs failed: backend down'] },
          observedMcpCalls: [call({ server: 'rag-docs', tool: 'search_docs', status: 'failed' })],
        },
      ])
    ).toBe(false);
  });
});

function summaryWithHealth(health: string) {
  return {
    mode: 'docs-only' as const,
    health,
    docs_count: 1,
    docs_first_source: null,
    project_id: null,
    project_count: 0,
    project_first_source: null,
    errors: [],
  };
}

describe('codex MCP smoke health validation', () => {
  it('accepts the structured health payload returned as JSON text', () => {
    const health = JSON.stringify({
      success: true,
      data: {
        components: [
          { component: 'MCP Server', status: 'OK' },
          { component: 'Docs RAG Postgres', status: 'OK' },
        ],
      },
    });

    expect(validateSummary(summaryWithHealth(health))).toEqual([]);
  });

  it.each([
    [
      'missing required component',
      { success: true, data: { components: [{ component: 'MCP Server', status: 'OK' }] } },
    ],
    [
      'degraded required component',
      {
        success: true,
        data: {
          components: [
            { component: 'MCP Server', status: 'OK' },
            { component: 'Docs RAG Postgres', status: 'ERROR' },
          ],
        },
      },
    ],
    [
      'failed structured response with legacy markers in details',
      {
        success: false,
        data: {
          components: [
            { component: 'MCP Server', status: 'OK' },
            { component: 'Docs RAG Postgres', status: 'ERROR' },
          ],
        },
        details: 'MCP Server: OK Docs RAG Postgres: OK',
      },
    ],
  ])('rejects %s structured health', (_label, payload) => {
    expect(validateSummary(summaryWithHealth(JSON.stringify(payload)))).not.toEqual([]);
  });

  it('rejects malformed JSON health instead of falling back to embedded markers', () => {
    const malformed = '{"details":"MCP Server: OK Docs RAG Postgres: OK"';

    expect(validateSummary(summaryWithHealth(malformed))).not.toEqual([]);
  });

  it('accepts explicit textual health markers but rejects condensed health', () => {
    expect(validateSummary(summaryWithHealth('MCP Server: OK\nDocs RAG Postgres: OK'))).toEqual([]);
    expect(validateSummary(summaryWithHealth('OK'))).not.toEqual([]);
  });

  it('rejects a project count copied from verification instead of search results', () => {
    const summary = {
      ...summaryWithHealth('MCP Server: OK\nDocs RAG Postgres: OK'),
      mode: 'full' as const,
      project_id: 'rag-v2-dev',
      project_count: 567,
    };

    expect(validateSummary(summary)).toContain('project_count exceeds requested search limit 3');
  });

  it('rejects legacy text that only prefixes the OK status', () => {
    expect(
      validateSummary(summaryWithHealth('MCP Server: OKAY\nDocs RAG Postgres: OK'))
    ).not.toEqual([]);
  });

  it('bounds and redacts health diagnostics on failure', () => {
    const secret = 'fixture-token';
    const health = `{"details":"Authorization: Bearer ${secret} ${'x'.repeat(2_000)}`;
    const failures = validateSummary(summaryWithHealth(health));
    const output = failures.join('\n');

    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED:bearer-token]');
    expect(failures.every((failure) => failure.length < 320)).toBe(true);
  });
});

describe('credential redaction in eval output (S1)', () => {
  // formatErrorForOutput is wired into formatFailure, docs/project fallback
  // catch handlers, and main().catch in codex-mcp-smoke.
  // redactCredentialText is used directly in formatFailure.
  // These tests prove the redaction path for synthetic credentials.

  describe('redactCredentialText (used in formatFailure)', () => {
    it('redacts user:secret@ in codex exec failure output', () => {
      const result = redactCredentialText(
        'codex exec exited with status 1\nstdout:\nhttps://admin:vo5secreta@api.example.com'
      );
      expect(result).toContain('[REDACTED:userinfo]');
      expect(result).toContain('api.example.com');
      expect(result).not.toContain('vo5secreta');
    });

    it('redacts Bearer tokens in stderr of formatFailure', () => {
      const result = redactCredentialText('stderr:\nAuthorization: Bearer syn-bearer-codex-xyz789');
      expect(result).toContain('[REDACTED:bearer-token]');
      expect(result).toContain('Authorization:');
      expect(result).not.toContain('syn-bearer-codex-xyz789');
    });

    it('redacts postgres connection passwords in formatFailure', () => {
      const result = redactCredentialText(
        'stderr:\npostgresql://app:syn-db-secret-88@pg.cloud.dev/main — timeout'
      );
      expect(result).toContain('[REDACTED:database-url-password]');
      expect(result).toContain('pg.cloud.dev');
      expect(result).not.toContain('syn-db-secret-88');
    });
  });

  describe('formatErrorForOutput (used in fallback catch + main().catch)', () => {
    it('redacts user:secret@ in direct fallback error capture', () => {
      const result = formatErrorForOutput(
        new Error('direct docs fallback failed: https://user:syn-pass@db.internal/replicas')
      );
      expect(result).toContain('[REDACTED:userinfo]');
      expect(result).toContain('db.internal');
      expect(result).not.toContain('syn-pass');
    });

    it('redacts Bearer tokens in project fallback error capture', () => {
      const result = formatErrorForOutput(
        new Error('register_project failed: Authorization: Bearer syn-bearer-fallback-123')
      );
      expect(result).toContain('[REDACTED:bearer-token]');
      expect(result).toContain('register_project');
      expect(result).not.toContain('syn-bearer-fallback-123');
    });

    it('redacts postgres connection string in main().catch', () => {
      const result = formatErrorForOutput(
        new Error('postgresql://admin:syn-db-secret-77@pg.prod/main — unreachable')
      );
      expect(result).toContain('[REDACTED:database-url-password]');
      expect(result).toContain('pg.prod');
      expect(result).not.toContain('syn-db-secret-77');
    });

    it('preserves non-secret smoke failure details', () => {
      const result = formatErrorForOutput(new Error('codex exec exited with status 127'));
      expect(result).toContain('codex exec');
      expect(result).toContain('status 127');
    });
  });

  describe('getObservedMcpCallFailure error redaction', () => {
    it('redacts credentials in call.error for status failure message', () => {
      const call: ObservedMcpCall = {
        server: 'rag-projects',
        tool: 'register_project',
        status: 'failed',
        error: 'connect to https://admin:syn-admin-pass@llama-srv:8081 failed',
      };
      const result = getObservedMcpCallFailure(call, 'register_project', 'rag-projects');
      expect(result).toContain('[REDACTED:userinfo]');
      expect(result).toContain('llama-srv');
      expect(result).not.toContain('syn-admin-pass');
    });

    it('redacts credentials in call.error for completed-with-error message', () => {
      const call: ObservedMcpCall = {
        server: 'rag-docs',
        tool: 'search_docs',
        status: 'completed',
        error: 'Authorization: Bearer syn-bearer-codex-xyz789',
      };
      const result = getObservedMcpCallFailure(call, 'search_docs', 'rag-docs');
      expect(result).toContain('[REDACTED:bearer-token]');
      expect(result).toContain('search_docs');
      expect(result).not.toContain('syn-bearer-codex-xyz789');
    });
  });
});
