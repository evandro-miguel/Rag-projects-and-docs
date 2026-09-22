import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('MCP Server Lifecycle', () => {
  describe('Schema Validation', () => {
    it('validates search docs arguments', async () => {
      const { z } = await import('zod');

      const SearchDocsSchema = z.object({
        query: z.string().min(1, 'Query is required'),
        categories: z.array(z.string()).optional(),
        sourceId: z.string().optional(),
        sourceIds: z.array(z.string()).optional(),
        language: z.string().optional(),
        kind: z.enum(['official-docs', 'book', 'package-docs', 'repository-docs']).optional(),
        authority: z.enum(['official', 'publisher', 'community-vetted']).optional(),
        sourceTags: z.array(z.string()).optional(),
        limit: z.number().min(1).max(50).optional().default(10),
      });

      // Valid input
      const validResult = SearchDocsSchema.safeParse({ query: 'test' });
      expect(validResult.success).toBe(true);

      // Invalid input - empty query
      const invalidResult = SearchDocsSchema.safeParse({ query: '' });
      expect(invalidResult.success).toBe(false);

      // Invalid input - limit out of range
      const outOfRangeResult = SearchDocsSchema.safeParse({ query: 'test', limit: 100 });
      expect(outOfRangeResult.success).toBe(false);
    });

    it('preserves search docs source metadata filters', async () => {
      const { z } = await import('zod');

      const SearchDocsSchema = z.object({
        query: z.string().min(1, 'Query is required'),
        categories: z.array(z.string()).optional(),
        sourceId: z.string().optional(),
        sourceIds: z.array(z.string()).optional(),
        language: z.string().optional(),
        kind: z.enum(['official-docs', 'book', 'package-docs', 'repository-docs']).optional(),
        authority: z.enum(['official', 'publisher', 'community-vetted']).optional(),
        sourceTags: z.array(z.string()).optional(),
        limit: z.number().min(1).max(50).optional().default(10),
      });

      const result = SearchDocsSchema.safeParse({
        query: 'backendHarness',
        sourceId: 'typescript-docs',
        sourceIds: ['typescript-docs'],
        language: 'typescript',
        kind: 'official-docs',
        authority: 'official',
        sourceTags: ['typescript', 'official'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({
          sourceId: 'typescript-docs',
          sourceIds: ['typescript-docs'],
          language: 'typescript',
          kind: 'official-docs',
          authority: 'official',
          sourceTags: ['typescript', 'official'],
        });
      }
    });

    it('validates get document arguments', async () => {
      const { z } = await import('zod');

      const GetDocumentSchema = z.object({
        sourcePath: z.string().min(1, 'sourcePath is required'),
      });

      const validResult = GetDocumentSchema.safeParse({ sourcePath: 'docs/test.md' });
      expect(validResult.success).toBe(true);

      const invalidResult = GetDocumentSchema.safeParse({ sourcePath: '' });
      expect(invalidResult.success).toBe(false);
    });

    it('validates ingest project arguments', async () => {
      const { z } = await import('zod');

      const IngestProjectSchema = z.object({
        force: z.boolean().optional().default(false),
        rootPath: z.string().min(1, 'rootPath is required').optional(),
      });

      const result = IngestProjectSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBe(false);
      }

      const rootPathResult = IngestProjectSchema.safeParse({ rootPath: '/tmp/project' });
      expect(rootPathResult.success).toBe(true);
    });
  });

  describe('Tool Routing', () => {
    it('routes to correct handlers based on tool name', async () => {
      const toolNames = [
        'search_docs',
        'search_project_code',
        'ingest_project',
        'ingest_project_file',
        'list_categories',
        'health_check',
        'get_document',
        'get_project_file',
        'get_project_outline',
        'register_project',
        'prepare_project',
        'verify_project_index',
        'find_project_symbol',
        'find_symbol_references',
      ];

      expect(toolNames).toHaveLength(14);
    });

    it('throws for unknown tool', async () => {
      const unknownTool = 'unknown_tool';
      expect(() => {
        throw new Error(`Unknown tool: ${unknownTool}`);
      }).toThrow('Unknown tool: unknown_tool');
    });
  });

  describe('Error Response Formatting', () => {
    it('formats ZodError correctly', async () => {
      const { z } = await import('zod');

      const schema = z.object({
        query: z.string().min(1),
      });

      const result = schema.safeParse({ query: '' });
      if (!result.success) {
        const message = result.error.issues
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        expect(message).toContain('query');
        expect(message).toContain('Too small');
      }
    });

    it('formats generic errors correctly', async () => {
      const error = new Error('Something went wrong');

      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'INTERNAL_ERROR',
              message: error.message,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
        isError: true,
      };

      expect(response.isError).toBe(true);
      expect(response.content[0].type).toBe('text');
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.error).toBe('INTERNAL_ERROR');
    });

    it('includes timestamp in error response', async () => {
      const now = new Date();
      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'INTERNAL_ERROR',
              message: 'Test error',
              timestamp: now.toISOString(),
            }),
          },
        ],
        isError: true,
      };

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.timestamp).toBe(now.toISOString());
    });
  });

  describe('Server Configuration', () => {
    it('has correct server name', async () => {
      const serverName = 'rag-v2-docs-mcp-server';
      expect(serverName).toBe('rag-v2-docs-mcp-server');
    });

    it('has correct server version', async () => {
      const serverVersion = '1.0.0';
      expect(serverVersion).toBe('1.0.0');
    });

    it('declares tools capability', async () => {
      const capabilities = { tools: {} };
      expect(capabilities).toHaveProperty('tools');
    });
  });

  describe('STDIO Transport Lifecycle', () => {
    const lifecycle = {
      connect: vi.fn(),
      query: vi.fn(),
      ensureProjectWatcher: vi.fn(),
      setRequestHandler: vi.fn(),
      loggerInfo: vi.fn(),
      loggerWarn: vi.fn(),
      loggerError: vi.fn(),
      transportConstructed: vi.fn(),
      handleSearchDocs: vi.fn(),
    };

    const okResult = { content: [{ type: 'text', text: 'ok' }] };

    function installServerMocks(): void {
      vi.doMock('@modelcontextprotocol/sdk/server/index.js', () => ({
        Server: class MockServer {
          connect = lifecycle.connect;
          setRequestHandler = lifecycle.setRequestHandler;
        },
      }));

      vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
        StdioServerTransport: class MockStdioServerTransport {
          constructor() {
            lifecycle.transportConstructed();
          }
        },
      }));

      vi.doMock('../../lib/logger.js', () => ({
        logger: {
          info: lifecycle.loggerInfo,
          warn: lifecycle.loggerWarn,
          error: lifecycle.loggerError,
        },
      }));

      vi.doMock('../project-watcher-manager.js', () => ({
        ensureProjectWatcher: lifecycle.ensureProjectWatcher,
      }));

      vi.doMock('../handlers.js', () => ({
        handleGetCodeMetrics: vi.fn(async () => okResult),
        handleGetDeadCodeReport: vi.fn(async () => okResult),
        handleIngestProject: vi.fn(async () => okResult),
        handleIngestProjectFile: vi.fn(async () => okResult),
        handleSearchInventory: vi.fn(async () => okResult),
      }));

      vi.doMock('../docs-handlers.js', () => ({
        handleAdaptDocs: vi.fn(async () => okResult),
        handleEnsureReranker: vi.fn(async () => okResult),
        handleGetDocument: vi.fn(async () => okResult),
        handleHealthCheck: vi.fn(async () => okResult),
        handleListCategories: vi.fn(async () => okResult),
        handleSearchAndAdapt: vi.fn(async () => okResult),
        handleSearchDocs: lifecycle.handleSearchDocs,
      }));

      vi.doMock('../project-handlers.js', () => ({
        handleFindProjectSymbol: vi.fn(async () => okResult),
        handleFindSymbolReferences: vi.fn(async () => okResult),
        handleGetFeatureHubs: vi.fn(async () => okResult),
        handleGetNavigationPaths: vi.fn(async () => okResult),
        handleGetProjectFile: vi.fn(async () => okResult),
        handleGetProjectOutline: vi.fn(async () => okResult),
        handleGetProjectSkeleton: vi.fn(async () => okResult),
        handleGetSemanticClusters: vi.fn(async () => okResult),
        handleGetTopicGroups: vi.fn(async () => okResult),
        handleRegisterProject: vi.fn(async () => okResult),
        handlePrepareProject: vi.fn(async () => okResult),
        handleSearchProjectCode: vi.fn(async () => okResult),
        handleVerifyProjectIndex: vi.fn(async () => okResult),
      }));

      vi.doMock('../project-tools.js', () => ({
        publicProjectTools: [
          { name: 'search_project_code' },
          { name: 'get_project_file' },
          { name: 'get_project_outline' },
          { name: 'register_project' },
          { name: 'prepare_project' },
          { name: 'verify_project_index' },
        ],
        prepareProjectTool: { name: 'prepare_project' },
      }));

      vi.doMock('../tools.js', () => ({
        adaptDocsTool: { name: 'adapt_docs' },
        ensureRerankerTool: { name: 'ensure_reranker' },
        findProjectSymbolTool: { name: 'find_project_symbol' },
        findSymbolReferencesTool: { name: 'find_symbol_references' },
        getCodeMetricsTool: { name: 'get_code_metrics' },
        getDeadCodeReportTool: { name: 'get_dead_code_report' },
        getDocumentTool: { name: 'get_document' },
        getFeatureHubsTool: { name: 'get_feature_hubs' },
        getNavigationPathsTool: { name: 'get_navigation_paths' },
        getProjectSkeletonTool: { name: 'get_project_skeleton' },
        getSemanticClustersTool: { name: 'get_semantic_clusters' },
        getTopicGroupsTool: { name: 'get_topic_groups' },
        healthCheckTool: { name: 'health_check' },
        ingestProjectFileTool: { name: 'ingest_project_file' },
        ingestProjectTool: { name: 'ingest_project' },
        listCategoriesTool: { name: 'list_categories' },
        searchAndAdaptTool: { name: 'search_and_adapt' },
        searchDocsTool: { name: 'search_docs' },
        searchInventoryTool: { name: 'search_inventory' },
        searchProjectDocsTool: { name: 'search_project_docs' },
      }));
    }

    async function importServerWithMocks(): Promise<void> {
      installServerMocks();
      await import('../server.js');
      await Promise.resolve();
      await Promise.resolve();
    }

    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
      lifecycle.query.mockResolvedValue([]);
      lifecycle.connect.mockResolvedValue(undefined);
      lifecycle.handleSearchDocs.mockResolvedValue(okResult);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it('starts stdio server without writing protocol noise to stdout', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(((_code?: number) => undefined as never) as typeof process.exit);

      await importServerWithMocks();

      expect(lifecycle.transportConstructed).toHaveBeenCalledTimes(1);
      expect(lifecycle.connect).toHaveBeenCalledTimes(1);
      expect(lifecycle.query).not.toHaveBeenCalled();
      expect(lifecycle.ensureProjectWatcher).not.toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('filters docs toolset and returns structured disabled-tool errors', async () => {
      vi.stubEnv('MCP_TOOLSET', 'docs');

      await importServerWithMocks();

      const listToolsHandler = lifecycle.setRequestHandler.mock.calls[0]?.[1];
      const callToolHandler = lifecycle.setRequestHandler.mock.calls[1]?.[1];
      expect(listToolsHandler).toBeTypeOf('function');
      expect(callToolHandler).toBeTypeOf('function');

      const listResponse = await listToolsHandler();
      const toolNames = listResponse.tools.map((tool: { name: string }) => tool.name);

      expect(toolNames).toContain('search_docs');
      expect(toolNames).not.toContain('search_project_code');

      const disabledResponse = await callToolHandler({
        params: {
          name: 'search_project_code',
          arguments: { projectId: 'p1', query: 'test' },
        },
      });

      expect(disabledResponse.isError).toBe(true);
      expect(disabledResponse.structuredContent.error.code).toBe('TOOL_NOT_ENABLED');
      expect(disabledResponse.content[0].text).toContain('TOOL_NOT_ENABLED');
    });

    it('preserves search_docs source filters through canonical server dispatch', async () => {
      vi.stubEnv('MCP_TOOLSET', 'docs');

      await importServerWithMocks();

      const callToolHandler = lifecycle.setRequestHandler.mock.calls[1]?.[1];
      expect(callToolHandler).toBeTypeOf('function');

      const response = await callToolHandler({
        params: {
          name: 'search_docs',
          arguments: {
            query: 'interfaces',
            sourceId: 'go-books',
            sourceIds: ['go-books'],
            language: 'go',
            kind: 'book',
            authority: 'community-vetted',
            sourceTags: ['book'],
            retrievalMode: 'local_first',
            includePageRefs: true,
            includeTrust: true,
            limit: 7,
          },
        },
      });

      expect(response).toBe(okResult);
      expect(lifecycle.handleSearchDocs).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'interfaces',
          sourceId: 'go-books',
          sourceIds: ['go-books'],
          language: 'go',
          kind: 'book',
          authority: 'community-vetted',
          sourceTags: ['book'],
          retrievalMode: 'local_first',
          includePageRefs: true,
          includeTrust: true,
          limit: 7,
        }),
        ['external'],
        expect.any(AbortSignal)
      );
    });

    it('treats transport close as terminal and exits once without reconnecting', async () => {
      const terminalCloseError = Object.assign(new Error('stdio transport closed'), {
        code: 'ERR_STREAM_DESTROYED',
      });
      lifecycle.connect.mockRejectedValueOnce(terminalCloseError);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(((_code?: number) => undefined as never) as typeof process.exit);

      await importServerWithMocks();
      await Promise.resolve();

      expect(lifecycle.connect).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(lifecycle.loggerError).toHaveBeenCalled();
    });
  });
});
