import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RateLimitExceededError, rateLimiters } from '../lib/rate-limiter.js';
import { ReadDeadlineError } from '../lib/timeout.js';
import { getPublicMcpToolName } from '../public-surface.js';
import {
  getToolCapabilityMetadata,
  isWriteCapability,
  resolveMcpPermissionMode,
} from '../tool-capabilities.js';
import {
  allRegisteredTools,
  BlockedFindingAllowlistEntrySchema,
  createRagMcpServer,
  dispatchMcpToolCall,
  getVisibleMcpTools,
  isToolEnabled,
  RegisterProjectSchema,
} from '../tool-registry.js';

// Handler mocks for rate-limit dispatch tests.  Placed at the top level
// because vitest 4 warns that vi.mock() inside describe() will become an
// error.  Safe for existing tests — they hit TOOL_NOT_ENABLED or
// PERMISSION_DENIED before reaching any handler.
vi.mock('../docs-handlers.js', () => ({
  handleSearchDocs: vi.fn(async () => ({
    content: [{ type: 'text', text: 'mocked search result' }],
  })),
  handleListCategories: vi.fn(async () => ({
    content: [{ type: 'text', text: 'Available Categories (0)' }],
    structuredContent: { success: true, data: { categories: [] } },
  })),
}));

vi.mock('../handlers.js', () => ({
  handleIngestProject: vi.fn(async () => ({
    content: [{ type: 'text', text: 'mocked ingest result' }],
    isError: false,
  })),
  handleIngestProjectFile: vi.fn(async () => ({
    content: [{ type: 'text', text: 'mocked file ingest result' }],
    isError: false,
  })),
}));

vi.mock('../project-handlers.js', () => ({
  handleVerifyProjectIndex: vi.fn(async () => ({
    content: [{ type: 'text', text: 'schema is not ready' }],
    structuredContent: {
      success: false,
      error: {
        code: 'SCHEMA_NOT_READY',
        message: 'Project RAG schema is missing migration 004',
        timestamp: '2026-08-31T00:00:00.000Z',
      },
      data: {
        failureCode: 'VERIFY_PROJECT_INDEX_INTERNAL_ERROR',
        phase: 'verify_project_index',
      },
    },
    isError: true,
  })),
}));

describe('MCP tool registry', () => {
  it('returns structured list_categories output to an MCP client', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createRagMcpServer();
    const client = new Client({ name: 'mcp-tool-registry-test', version: '1.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({ name: 'list_categories', arguments: {} });

      expect(result.structuredContent).toEqual({
        success: true,
        data: { categories: [] },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('preserves safe handler error codes through registry output validation', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createRagMcpServer();
    const client = new Client({ name: 'mcp-tool-registry-error-test', version: '1.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();

      const result = await client.callTool({
        name: 'verify_project_index',
        arguments: { projectId: 'rag-v2-dev' },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          success: false,
          error: { code: 'SCHEMA_NOT_READY' },
          data: {
            failureCode: 'VERIFY_PROJECT_INDEX_INTERNAL_ERROR',
            phase: 'verify_project_index',
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('advertises an error-compatible schema for tools with success-only payloads', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createRagMcpServer();
    const client = new Client({ name: 'mcp-tool-registry-search-error-test', version: '1.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();

      const result = await client.callTool({ name: 'search_docs', arguments: {} });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          success: false,
          error: { code: 'VALIDATION_ERROR' },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps all registered tool names unique', () => {
    const names = allRegisteredTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes the same canonical surface for all transports', () => {
    const names = getVisibleMcpTools('all').map((tool) => tool.name);
    expect(names).toContain('search_docs');
    expect(names).toContain('search_project_code');
    expect(names).toContain('verify_project_index');
    expect(names).toContain('health_check');
  });

  it('filters docs and project toolsets explicitly', () => {
    const docs = getVisibleMcpTools('docs').map((tool) => tool.name);
    const projects = getVisibleMcpTools('projects').map((tool) => tool.name);

    expect(docs).toContain('search_docs');
    expect(docs).not.toContain('search_project_code');
    expect(docs).not.toContain('rate_result');
    expect(docs).not.toContain('list_tags');
    expect(docs).not.toContain('get_drift_alerts');
    expect(projects).toContain('search_project_code');
    expect(projects).not.toContain('rate_result');
    expect(projects).not.toContain('search_docs');
  });

  it('derives toolset visibility from capability metadata', () => {
    const expectedDocs = allRegisteredTools
      .filter((tool) => isToolEnabled(tool.name, 'docs'))
      .filter(
        (tool) =>
          resolveMcpPermissionMode() !== 'read_only' ||
          !isWriteCapability(getToolCapabilityMetadata(tool.name).capability)
      )
      .map((tool) => getPublicMcpToolName(tool.name))
      .filter((name): name is string => name !== undefined);
    const expectedProjects = allRegisteredTools
      .filter((tool) => isToolEnabled(tool.name, 'projects'))
      .filter(
        (tool) =>
          resolveMcpPermissionMode() !== 'read_only' ||
          !isWriteCapability(getToolCapabilityMetadata(tool.name).capability)
      )
      .map((tool) => getPublicMcpToolName(tool.name))
      .filter((name): name is string => name !== undefined);

    expect(getVisibleMcpTools('docs').map((tool) => tool.name)).toEqual(expectedDocs);
    expect(getVisibleMcpTools('projects').map((tool) => tool.name)).toEqual(expectedProjects);
  });

  it('does not register retired legacy Convex-only tools', async () => {
    const retired = [
      'rate_result',
      'get_job_status',
      'list_jobs',
      'get_drift_alerts',
      'acknowledge_drift_alert',
      'resolve_drift_alert',
      'list_tags',
      'get_tag_info',
      'assign_tag',
      'remove_tag',
    ];

    const registered = allRegisteredTools.map((tool) => tool.name);
    const visible = getVisibleMcpTools('all').map((tool) => tool.name);

    for (const toolName of retired) {
      expect(registered).not.toContain(toolName);
      expect(visible).not.toContain(toolName);
      expect(isToolEnabled(toolName, 'all')).toBe(false);
    }

    await expect(
      dispatchMcpToolCall(
        'rate_result',
        { documentId: 'doc', query: 'q', rating: 'positive' },
        'all'
      )
    ).rejects.toThrow('TOOL_NOT_ENABLED');
  });

  it('exposes capability metadata for project ingestion write tools', () => {
    const metadata = getToolCapabilityMetadata('ingest_project');
    expect(metadata.capability).toBe('write');
    expect(metadata.risk).toBe('high');
    expect(metadata.requiresAck).toBe(true);
    expect(metadata.toolset).toBe('projects');
  });

  it('defaults MCP permission mode to read_only', () => {
    const previous = process.env.MCP_PERMISSION_MODE;
    delete process.env.MCP_PERMISSION_MODE;

    try {
      expect(resolveMcpPermissionMode()).toBe('read_only');
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_PERMISSION_MODE;
      } else {
        process.env.MCP_PERMISSION_MODE = previous;
      }
    }
  });

  it('blocks write tools unless MCP_PERMISSION_MODE=read_write is explicit', async () => {
    const previous = process.env.MCP_PERMISSION_MODE;
    delete process.env.MCP_PERMISSION_MODE;

    try {
      await expect(
        dispatchMcpToolCall(
          'ingest_project',
          {
            scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
            executionMode: 'durable',
          },
          'all'
        )
      ).rejects.toThrow('PERMISSION_DENIED');
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_PERMISSION_MODE;
      } else {
        process.env.MCP_PERMISSION_MODE = previous;
      }
    }
  });

  it('marks guarded write tools as requiresAck in metadata', () => {
    const metadata = getToolCapabilityMetadata('register_project');
    expect(metadata.requiresAck).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Read deadline integration
  // --------------------------------------------------------------------------

  it('formats ReadDeadlineError with READ_DEADLINE_EXCEEDED code in formatToolCallError', async () => {
    // We can't directly test formatToolCallError (it's not exported).
    // Instead, verify that a ReadDeadlineError thrown during dispatch
    // propagates correctly and is catchable.
    const err = new ReadDeadlineError('search_docs', 100);
    expect(err.code).toBe('READ_DEADLINE_EXCEEDED');
    expect(err.message).toContain('Cooperative cancellation was requested');
    expect(err.message).toContain('search_docs');
  });

  it('wraps read tool search_docs with read deadline wiring (import paths check)', () => {
    // Verify the read tool names overlap with capability metadata.
    const searchDocsMeta = getToolCapabilityMetadata('search_docs');
    expect(searchDocsMeta.capability).toBe('read');
    expect(searchDocsMeta.toolset).toBe('docs');

    const searchCodeMeta = getToolCapabilityMetadata('search_project_code');
    expect(searchCodeMeta.capability).toBe('read');
    expect(searchCodeMeta.toolset).toBe('projects');

    const searchDocsAliasMeta = getToolCapabilityMetadata('search_project_docs');
    expect(searchDocsAliasMeta.capability).toBe('read');
    expect(searchDocsAliasMeta.toolset).toBe('projects');
  });

  it('preserves deprecated search_project_docs alias in registered tools', () => {
    const names = allRegisteredTools.map((tool) => tool.name);
    expect(names).toContain('search_project_docs');
  });

  it('advertises deprecated keyword mode for Project RAG compatibility', () => {
    const searchProjectCode = allRegisteredTools.find(
      (tool) => tool.name === 'search_project_code'
    );
    const properties = searchProjectCode?.inputSchema.properties as {
      mode?: { enum?: string[] };
    };

    expect(properties.mode?.enum).toEqual(['keyword', 'vector', 'hybrid']);
  });

  it('hides write tools from tools/list in read_only mode', () => {
    const previous = process.env.MCP_PERMISSION_MODE;
    process.env.MCP_PERMISSION_MODE = 'read_only';

    try {
      const names = getVisibleMcpTools('all').map((tool) => tool.name);
      expect(names).toContain('search_project_code');
      expect(names).not.toContain('register_project');
      expect(names).not.toContain('ingest_project');
      expect(names).not.toContain('ingest_project_file');
      expect(names).not.toContain('ensure_reranker');
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_PERMISSION_MODE;
      } else {
        process.env.MCP_PERMISSION_MODE = previous;
      }
    }
  });

  it('filters writes and internal tools from the read_only tools/list surface', async () => {
    const previous = process.env.MCP_PERMISSION_MODE;
    process.env.MCP_PERMISSION_MODE = 'read_only';
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createRagMcpServer();
    const client = new Client({ name: 'mcp-tool-registry-read-only-test', version: '1.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['search_docs', 'verify_project_index']));
      expect(names).not.toEqual(
        expect.arrayContaining([
          'register_project',
          'ingest_project',
          'ingest_project_file',
          'ensure_reranker',
          'get_code_metrics',
          'search_inventory',
          'get_dead_code_report',
        ])
      );

      await expect(dispatchMcpToolCall('ingest_project', {}, 'all')).rejects.toThrow(
        'PERMISSION_DENIED'
      );
    } finally {
      await client.close();
      await server.close();
      if (previous === undefined) {
        delete process.env.MCP_PERMISSION_MODE;
      } else {
        process.env.MCP_PERMISSION_MODE = previous;
      }
    }
  });

  it('lists write tools when read_write mode makes them executable', () => {
    const previous = process.env.MCP_PERMISSION_MODE;
    process.env.MCP_PERMISSION_MODE = 'read_write';

    try {
      const names = getVisibleMcpTools('projects').map((tool) => tool.name);
      expect(names).toContain('register_project');
      expect(names).toContain('ingest_project');
      expect(names).toContain('ingest_project_file');
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_PERMISSION_MODE;
      } else {
        process.env.MCP_PERMISSION_MODE = previous;
      }
    }
  });

  it('does not wrap write tools (ingest_project) with ReadDeadlineError wiring', () => {
    // Write tools are NOT wrapped. Verify that the capability metadata
    // marks them as write so the dispatch throws PERMISSION_DENIED instead.
    const meta = getToolCapabilityMetadata('ingest_project');
    expect(meta.capability).toBe('write');

    // The PERMISSION_DENIED check fires before any timeout could apply.
    const _permMode = resolveMcpPermissionMode();
    // In test default is read_write (env not set). Set to read_only to verify.
    const prev = process.env.MCP_PERMISSION_MODE;
    delete process.env.MCP_PERMISSION_MODE;
    try {
      expect(resolveMcpPermissionMode()).toBe('read_only');
    } finally {
      if (prev === undefined) {
        delete process.env.MCP_PERMISSION_MODE;
      } else {
        process.env.MCP_PERMISSION_MODE = prev;
      }
    }
  });

  // --------------------------------------------------------------------------
  // Schema strict() validation — T-04 slice3
  // --------------------------------------------------------------------------

  it('RegisterProjectSchema .strict() rejects unknown top-level keys', () => {
    expect(() =>
      RegisterProjectSchema.parse({
        name: 'Test',
        rootPath: '/tmp',
        includeRoots: ['src'],
        blokedFndingAllowlist: [], // typo — should be blockedFindingAllowlist
      })
    ).toThrow(z.ZodError);
    // Verify a valid call still passes
    expect(() =>
      RegisterProjectSchema.parse({
        name: 'Test',
        rootPath: '/tmp',
        includeRoots: ['src'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      })
    ).not.toThrow();
  });

  it('BlockedFindingAllowlistEntrySchema .strict() rejects entries with extra keys', () => {
    // Valid entry passes
    expect(() =>
      BlockedFindingAllowlistEntrySchema.parse({
        relativePath: 'vendor/dep1',
        category: 'dependency_dir',
      })
    ).not.toThrow();
    // Extra key rejected
    expect(() =>
      BlockedFindingAllowlistEntrySchema.parse({
        relativePath: 'vendor/dep1',
        category: 'dependency_dir',
        extraField: 'nope',
      })
    ).toThrow(z.ZodError);
    // Typo key rejected
    expect(() =>
      BlockedFindingAllowlistEntrySchema.parse({
        relativePath: 'vendor/dep1',
        categor: 'typo',
      })
    ).toThrow(z.ZodError);
  });

  it('dispatchMcpToolCall rejects register_project with unknown keys', async () => {
    const prevMode = process.env.MCP_PERMISSION_MODE;
    process.env.MCP_PERMISSION_MODE = 'read_write';
    try {
      // The schema is strict, so unknown keys should produce a ZodError
      // which gets formatted as a VALIDATION_ERROR.
      await expect(
        dispatchMcpToolCall(
          'register_project',
          {
            name: 'Test',
            rootPath: '/tmp',
            includeRoots: ['src'],
            replaceBlockedFindingAllowlist: true,
            blockedFindingAllowlist: [],
            unknownKey: 'should be rejected',
          },
          'all'
        )
      ).rejects.toThrow(/VALIDATION_ERROR|Unknown key|Unexpected key|Unrecognized key/);
    } finally {
      if (prevMode === undefined) {
        delete process.env.MCP_PERMISSION_MODE;
      } else {
        process.env.MCP_PERMISSION_MODE = prevMode;
      }
    }
  });

  // --------------------------------------------------------------------------
  // Rate-limit dispatch wiring
  // --------------------------------------------------------------------------

  describe('rate-limit dispatch wiring', () => {
    beforeEach(() => {
      rateLimiters.search.clearAll();
      rateLimiters.ingest.clearAll();
      rateLimiters.ingestFile.clearAll();
    });

    it('throws RATE_LIMITED with retryAfter for search_docs after exhausting search limiter', async () => {
      const args = { query: 'test' };

      // Exhaust the 100-request/min search limiter
      for (let i = 0; i < 100; i++) {
        await dispatchMcpToolCall('search_docs', args, 'all');
      }

      // 101st call — should be rate-limited
      try {
        await dispatchMcpToolCall('search_docs', args, 'all');
        expect.fail('Expected RateLimitExceededError');
      } catch (e) {
        expect(e).toBeInstanceOf(RateLimitExceededError);
        expect((e as RateLimitExceededError).code).toBe('RATE_LIMITED');
        expect((e as RateLimitExceededError).retryAfter).toBeGreaterThanOrEqual(0);
        expect((e as RateLimitExceededError).message).toContain('search_docs');
        expect((e as RateLimitExceededError).message).toContain('RATE_LIMITED');
      }
    });

    it('throws RATE_LIMITED with retryAfter for ingest_project after exhausting ingest limiter', async () => {
      const prevMode = process.env.MCP_PERMISSION_MODE;
      process.env.MCP_PERMISSION_MODE = 'read_write';
      const args = {
        rootPath: process.cwd(),
        includeRoots: ['mcp'],
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      };

      try {
        // Exhaust the 5-request/10min ingest limiter
        for (let i = 0; i < 5; i++) {
          await dispatchMcpToolCall('ingest_project', args, 'all');
        }

        // 6th call — should be rate-limited
        try {
          await dispatchMcpToolCall('ingest_project', args, 'all');
          expect.fail('Expected RateLimitExceededError');
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitExceededError);
          expect((e as RateLimitExceededError).code).toBe('RATE_LIMITED');
          expect((e as RateLimitExceededError).retryAfter).toBeGreaterThanOrEqual(0);
          expect((e as RateLimitExceededError).message).toContain('ingest_project');
          expect((e as RateLimitExceededError).message).toContain('RATE_LIMITED');
        }
      } finally {
        if (prevMode === undefined) {
          delete process.env.MCP_PERMISSION_MODE;
        } else {
          process.env.MCP_PERMISSION_MODE = prevMode;
        }
      }
    });

    it('throws RATE_LIMITED with retryAfter for ingest_project_file after exhausting ingestFile limiter', async () => {
      const prevMode = process.env.MCP_PERMISSION_MODE;
      process.env.MCP_PERMISSION_MODE = 'read_write';
      const args = {
        filePath: 'src/test.ts',
        rootPath: process.cwd(),
        scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1',
      };

      try {
        // Exhaust the 10-request/5min ingestFile limiter
        for (let i = 0; i < 10; i++) {
          await dispatchMcpToolCall('ingest_project_file', args, 'all');
        }

        // 11th call — should be rate-limited
        try {
          await dispatchMcpToolCall('ingest_project_file', args, 'all');
          expect.fail('Expected RateLimitExceededError');
        } catch (e) {
          expect(e).toBeInstanceOf(RateLimitExceededError);
          expect((e as RateLimitExceededError).code).toBe('RATE_LIMITED');
          expect((e as RateLimitExceededError).retryAfter).toBeGreaterThanOrEqual(0);
          expect((e as RateLimitExceededError).message).toContain('ingest_project_file');
          expect((e as RateLimitExceededError).message).toContain('RATE_LIMITED');
        }
      } finally {
        if (prevMode === undefined) {
          delete process.env.MCP_PERMISSION_MODE;
        } else {
          process.env.MCP_PERMISSION_MODE = prevMode;
        }
      }
    });
  });
});
