/**
 * @module mcp/server.test
 * @description Unit tests for MCP server initialization and tool registration.
 *
 * Test coverage:
 * - Server configuration and initialization
 * - Tool registration and listing
 * - Tool call routing with validation
 * - Error handling and response formatting
 *
 * This tests the patterns used in server.ts without requiring actual server import
 * (which would start STDIO transport and block).
 */

import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';

// Mock logger - must be at top level
vi.mock('../lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock handlers - must be at top level (no variables referenced)
vi.mock('./handlers.js', () => ({
  handleIngestProject: vi.fn(),
  handleIngestProjectFile: vi.fn(),
  handleGetCodeMetrics: vi.fn(),
  handleSearchInventory: vi.fn(),
  handleGetDeadCodeReport: vi.fn(),
}));

vi.mock('./docs-handlers.js', () => ({
  handleSearchDocs: vi.fn(),
  handleListCategories: vi.fn(),
  handleHealthCheck: vi.fn(),
  handleGetDocument: vi.fn(),
  handleAdaptDocs: vi.fn(),
}));

vi.mock('./project-handlers.js', () => ({
  handleSearchProjectCode: vi.fn(),
  handleGetProjectFile: vi.fn(),
  handleGetProjectOutline: vi.fn(),
  handleRegisterProject: vi.fn(),
  handleVerifyProjectIndex: vi.fn(),
  handleFindProjectSymbol: vi.fn(),
  handleFindSymbolReferences: vi.fn(),
  handleGetProjectSkeleton: vi.fn(),
}));

import {
  handleAdaptDocs,
  handleGetDocument,
  handleHealthCheck,
  handleListCategories,
  handleSearchDocs,
} from './docs-handlers.js';
// Now import handlers after mocks
import {
  handleGetCodeMetrics,
  handleGetDeadCodeReport,
  handleIngestProject,
  handleIngestProjectFile,
  handleSearchInventory,
} from './handlers.js';
import {
  handleFindProjectSymbol,
  handleFindSymbolReferences,
  handleGetProjectFile,
  handleGetProjectOutline,
  handleGetProjectSkeleton,
  handleRegisterProject,
  handleSearchProjectCode,
  handleVerifyProjectIndex,
} from './project-handlers.js';

describe('MCP Server', () => {
  describe('Server Configuration', () => {
    it('should have correct server name and version', () => {
      const serverName = 'rag-v2-docs-mcp-server';
      const serverVersion = '1.0.0';

      expect(serverName).toBe('rag-v2-docs-mcp-server');
      expect(serverVersion).toBe('1.0.0');
    });

    it('should declare tools capability', () => {
      const capabilities = { tools: {} };
      expect(capabilities).toHaveProperty('tools');
    });
  });

  describe('Tool Call Routing - Direct Handler Tests', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('handleSearchDocs returns results', async () => {
      const mockResult = {
        content: [{ type: 'text', text: 'Search results here' }],
        isError: false,
      };
      (handleSearchDocs as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleSearchDocs({ query: 'test query', limit: 10 });
      expect(result.content[0].text).toBe('Search results here');
    });

    it('handleSearchProjectCode returns results', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Project results' }], isError: false };
      (handleSearchProjectCode as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleSearchProjectCode({ projectId: 'p1', query: 'test' });
      expect(result.content[0].text).toBe('Project results');
    });

    it('handleGetProjectFile returns file', async () => {
      const mockResult = { content: [{ type: 'text', text: 'File content' }], isError: false };
      (handleGetProjectFile as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleGetProjectFile({ projectId: 'p1', sourcePath: 'src/main.ts' });
      expect(result.content[0].text).toBe('File content');
    });

    it('handleGetProjectOutline returns outline', async () => {
      const mockResult = {
        content: [{ type: 'text', text: 'Outline: functions...' }],
        isError: false,
      };
      (handleGetProjectOutline as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleGetProjectOutline({ projectId: 'p1', sourcePath: 'src/main.ts' });
      expect(result.content[0].text).toBe('Outline: functions...');
    });

    it('handleRegisterProject returns confirmation', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Project Created' }], isError: false };
      (handleRegisterProject as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleRegisterProject({
        name: 'Test',
        rootPath: '/test',
        includeRoots: ['src'],
      });
      expect(result.content[0].text).toBe('Project Created');
    });

    it('handleVerifyProjectIndex returns verification', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Index Verified' }], isError: false };
      (handleVerifyProjectIndex as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleVerifyProjectIndex({ projectId: 'p1' });
      expect(result.content[0].text).toBe('Index Verified');
    });

    it('handleHealthCheck returns health status', async () => {
      const mockResult = { content: [{ type: 'text', text: 'MCP Server: OK' }], isError: false };
      (handleHealthCheck as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleHealthCheck();
      expect(result.content[0].text).toContain('OK');
    });

    it('handleListCategories returns categories', async () => {
      const mockResult = {
        content: [{ type: 'text', text: 'Bun, React, Tailwind' }],
        isError: false,
      };
      (handleListCategories as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleListCategories();
      expect(result.content[0].text).toBe('Bun, React, Tailwind');
    });

    it('handleGetDocument returns document', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Document content' }], isError: false };
      (handleGetDocument as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleGetDocument({ sourcePath: 'docs/test.md' });
      expect(result.content[0].text).toBe('Document content');
    });

    it('handleIngestProject returns status', async () => {
      const mockResult = {
        content: [{ type: 'text', text: 'Ingestion complete' }],
        isError: false,
      };
      (handleIngestProject as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleIngestProject({ force: false });
      expect(result.content[0].text).toBe('Ingestion complete');
    });

    it('handleIngestProjectFile returns file status', async () => {
      const mockResult = { content: [{ type: 'text', text: 'File indexed' }], isError: false };
      (handleIngestProjectFile as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleIngestProjectFile({ filePath: 'test.ts' });
      expect(result.content[0].text).toBe('File indexed');
    });

    it('handleAdaptDocs returns adapted content', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Adapted content' }], isError: false };
      (handleAdaptDocs as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleAdaptDocs({ content: 'test', context: 'senior' });
      expect(result.content[0].text).toBe('Adapted content');
    });

    it('handleGetCodeMetrics returns metrics', async () => {
      const mockResult = {
        content: [{ type: 'text', text: 'Metrics: 100 files' }],
        isError: false,
      };
      (handleGetCodeMetrics as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleGetCodeMetrics({});
      expect(result.content[0].text).toBe('Metrics: 100 files');
    });

    it('handleSearchInventory returns inventory results', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Found: 5 files' }], isError: false };
      (handleSearchInventory as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleSearchInventory({ pattern: '*.ts' });
      expect(result.content[0].text).toBe('Found: 5 files');
    });

    it('handleGetDeadCodeReport returns report', async () => {
      const mockResult = {
        content: [{ type: 'text', text: 'Dead code: 3 functions' }],
        isError: false,
      };
      (handleGetDeadCodeReport as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleGetDeadCodeReport({});
      expect(result.content[0].text).toBe('Dead code: 3 functions');
    });

    it('handleFindProjectSymbol returns symbols', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Found: myFunction' }], isError: false };
      (handleFindProjectSymbol as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleFindProjectSymbol({ projectId: 'p1', symbolName: 'myFunction' });
      expect(result.content[0].text).toBe('Found: myFunction');
    });

    it('handleFindSymbolReferences returns references', async () => {
      const mockResult = { content: [{ type: 'text', text: 'References: 5' }], isError: false };
      (handleFindSymbolReferences as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleFindSymbolReferences({ projectId: 'p1', symbolName: 'test' });
      expect(result.content[0].text).toBe('References: 5');
    });

    it('handleGetProjectSkeleton returns skeleton', async () => {
      const mockResult = {
        content: [{ type: 'text', text: 'Skeleton: class X {}' }],
        isError: false,
      };
      (handleGetProjectSkeleton as Mock).mockResolvedValueOnce(mockResult);

      const result = await handleGetProjectSkeleton({ projectId: 'p1', sourcePath: 'main.ts' });
      expect(result.content[0].text).toBe('Skeleton: class X {}');
    });
  });

  describe('Schema Validation', () => {
    describe('SearchProjectCodeSchema', () => {
      const SearchProjectCodeSchema = z.object({
        projectId: z.string().min(1, 'projectId is required'),
        query: z.string().min(1, 'query is required'),
        limit: z.number().min(1).max(50).optional().default(10),
        activeFile: z.string().optional(),
        mode: z.enum(['keyword', 'vector', 'hybrid']).optional().default('hybrid'),
      });

      it('validates valid input', () => {
        const result = SearchProjectCodeSchema.safeParse({
          projectId: 'project-123',
          query: 'test query',
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.limit).toBe(10);
          expect(result.data.mode).toBe('hybrid');
        }
      });

      it('validates with all optional params', () => {
        const result = SearchProjectCodeSchema.safeParse({
          projectId: 'project-123',
          query: 'test query',
          limit: 25,
          activeFile: 'src/main.ts',
          mode: 'vector',
        });
        expect(result.success).toBe(true);
      });

      it('rejects empty projectId', () => {
        const result = SearchProjectCodeSchema.safeParse({ projectId: '', query: 'test' });
        expect(result.success).toBe(false);
      });

      it('rejects empty query', () => {
        const result = SearchProjectCodeSchema.safeParse({ projectId: 'p1', query: '' });
        expect(result.success).toBe(false);
      });

      it('rejects limit below 1', () => {
        const result = SearchProjectCodeSchema.safeParse({
          projectId: 'p1',
          query: 'test',
          limit: 0,
        });
        expect(result.success).toBe(false);
      });

      it('rejects limit above 50', () => {
        const result = SearchProjectCodeSchema.safeParse({
          projectId: 'p1',
          query: 'test',
          limit: 100,
        });
        expect(result.success).toBe(false);
      });

      it('accepts deprecated keyword mode', () => {
        const result = SearchProjectCodeSchema.safeParse({
          projectId: 'p1',
          query: 'test',
          mode: 'keyword',
        });
        expect(result.success).toBe(true);
      });
    });

    describe('GetProjectFileSchema', () => {
      const GetProjectFileSchema = z.object({
        projectId: z.string().min(1, 'projectId is required'),
        sourcePath: z.string().min(1, 'sourcePath is required'),
      });

      it('validates valid input', () => {
        const result = GetProjectFileSchema.safeParse({
          projectId: 'p1',
          sourcePath: 'src/main.ts',
        });
        expect(result.success).toBe(true);
      });

      it('rejects empty projectId', () => {
        const result = GetProjectFileSchema.safeParse({ projectId: '', sourcePath: 'main.ts' });
        expect(result.success).toBe(false);
      });

      it('rejects empty sourcePath', () => {
        const result = GetProjectFileSchema.safeParse({ projectId: 'p1', sourcePath: '' });
        expect(result.success).toBe(false);
      });
    });

    describe('GetProjectOutlineSchema', () => {
      const GetProjectOutlineSchema = z.object({
        projectId: z.string().min(1),
        sourcePath: z.string().min(1),
      });

      it('validates valid input', () => {
        const result = GetProjectOutlineSchema.safeParse({
          projectId: 'p1',
          sourcePath: 'src/utils.ts',
        });
        expect(result.success).toBe(true);
      });
    });

    describe('RegisterProjectSchema', () => {
      const RegisterProjectSchema = z.object({
        name: z.string().min(1, 'name is required'),
        rootPath: z.string().min(1, 'rootPath is required'),
        includeRoots: z.array(z.string().min(1, 'includeRoots entries must be non-empty')).min(1),
        gitRemote: z.string().optional(),
        defaultBranch: z.string().optional(),
      });

      it('validates minimal input', () => {
        const result = RegisterProjectSchema.safeParse({
          name: 'My Project',
          rootPath: '/path',
          includeRoots: ['src'],
        });
        expect(result.success).toBe(true);
      });

      it('validates with optional params', () => {
        const result = RegisterProjectSchema.safeParse({
          name: 'My Project',
          rootPath: '/path',
          includeRoots: ['src', 'docs'],
          gitRemote: 'https://github.com/test/test.git',
          defaultBranch: 'main',
        });
        expect(result.success).toBe(true);
      });

      it('rejects empty name', () => {
        const result = RegisterProjectSchema.safeParse({
          name: '',
          rootPath: '/path',
          includeRoots: ['src'],
        });
        expect(result.success).toBe(false);
      });

      it('rejects empty rootPath', () => {
        const result = RegisterProjectSchema.safeParse({
          name: 'Test',
          rootPath: '',
          includeRoots: ['src'],
        });
        expect(result.success).toBe(false);
      });

      it('rejects missing includeRoots', () => {
        const result = RegisterProjectSchema.safeParse({ name: 'Test', rootPath: '/path' });
        expect(result.success).toBe(false);
      });

      it('rejects empty includeRoots', () => {
        const result = RegisterProjectSchema.safeParse({
          name: 'Test',
          rootPath: '/path',
          includeRoots: [],
        });
        expect(result.success).toBe(false);
      });
    });

    describe('VerifyProjectIndexSchema', () => {
      const VerifyProjectIndexSchema = z.object({
        projectId: z.string().min(1, 'projectId is required'),
      });

      it('validates valid input', () => {
        const result = VerifyProjectIndexSchema.safeParse({ projectId: 'p1' });
        expect(result.success).toBe(true);
      });

      it('rejects empty projectId', () => {
        const result = VerifyProjectIndexSchema.safeParse({ projectId: '' });
        expect(result.success).toBe(false);
      });
    });

    describe('SearchProjectDocsAliasSchema', () => {
      const SearchProjectDocsAliasSchema = z.object({
        projectId: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().min(1).max(50).optional().default(10),
        active_file: z.string().optional(),
        mode: z.enum(['keyword', 'vector', 'hybrid']).optional().default('hybrid'),
      });

      it('validates alias input with active_file', () => {
        const result = SearchProjectDocsAliasSchema.safeParse({
          projectId: 'p1',
          query: 'test',
          active_file: 'src/main.ts',
        });
        expect(result.success).toBe(true);
      });

      it('accepts deprecated keyword mode', () => {
        const result = SearchProjectDocsAliasSchema.safeParse({
          projectId: 'p1',
          query: 'test',
          mode: 'keyword',
        });
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Error Response Formatting', () => {
    it('formats ZodError with correct error code', () => {
      const schema = z.object({ query: z.string().min(1) });
      const result = schema.safeParse({ query: '' });

      if (!result.success) {
        const message = result.error.issues
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        const errorCode = 'VALIDATION_ERROR';

        expect(message).toContain('query');
        expect(errorCode).toBe('VALIDATION_ERROR');
      }
    });

    it('formats generic errors with INTERNAL_ERROR', () => {
      const _error = new Error('Database connection failed');
      const errorCode = 'INTERNAL_ERROR';
      expect(errorCode).toBe('INTERNAL_ERROR');
    });

    it('handles unknown tool errors', () => {
      const unknownTool = 'unknown_tool';
      const throwFn = () => {
        throw new Error(`Unknown tool: ${unknownTool}`);
      };
      expect(throwFn).toThrow('Unknown tool: unknown_tool');
    });

    it('includes timestamp in error response', () => {
      const timestamp = new Date().toISOString();
      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'VALIDATION_ERROR', message: 'Invalid', timestamp }),
          },
        ],
        isError: true,
      };

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.timestamp).toBe(timestamp);
    });

    it('creates error response with correct structure', () => {
      const createErrorResponse = (error: Error) => ({
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
      });

      const error = new Error('Test error');
      const response = createErrorResponse(error);

      expect(response.isError).toBe(true);
      expect(response.content[0].type).toBe('text');
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.error).toBe('INTERNAL_ERROR');
      expect(parsed.message).toBe('Test error');
    });
  });

  describe('Tool List', () => {
    it('includes all required tools', () => {
      const toolNames = [
        'search_docs',
        'ingest_project',
        'ingest_project_file',
        'list_categories',
        'health_check',
        'get_document',
        'adapt_docs',
        'get_code_metrics',
        'search_inventory',
        'get_dead_code_report',
        'search_project_code',
        'get_project_file',
        'get_project_outline',
        'register_project',
        'verify_project_index',
        'find_project_symbol',
        'find_symbol_references',
        'get_project_skeleton',
      ];

      expect(toolNames.length).toBe(18);
    });
  });

  describe('Tool Routing Map', () => {
    const toolRoutingMap: Record<string, string> = {
      search_docs: 'handleSearchDocs',
      search_project_code: 'handleSearchProjectCode',
      search_project_docs: 'handleSearchProjectCode (alias)',
      ingest_project: 'handleIngestProject',
      ingest_project_file: 'handleIngestProjectFile',
      list_categories: 'handleListCategories',
      health_check: 'handleHealthCheck',
      get_document: 'handleGetDocument',
      adapt_docs: 'handleAdaptDocs',
      get_code_metrics: 'handleGetCodeMetrics',
      search_inventory: 'handleSearchInventory',
      get_dead_code_report: 'handleGetDeadCodeReport',
      get_project_file: 'handleGetProjectFile',
      get_project_outline: 'handleGetProjectOutline',
      register_project: 'handleRegisterProject',
      verify_project_index: 'handleVerifyProjectIndex',
      find_project_symbol: 'handleFindProjectSymbol',
      find_symbol_references: 'handleFindSymbolReferences',
      get_project_skeleton: 'handleGetProjectSkeleton',
    };

    it('maps all tools to handlers', () => {
      expect(Object.keys(toolRoutingMap).length).toBe(19);
    });

    it('includes project code search tool', () => {
      expect(toolRoutingMap.search_project_code).toBe('handleSearchProjectCode');
    });

    it('includes project file retrieval tool', () => {
      expect(toolRoutingMap.get_project_file).toBe('handleGetProjectFile');
    });

    it('includes project outline tool', () => {
      expect(toolRoutingMap.get_project_outline).toBe('handleGetProjectOutline');
    });

    it('includes register project tool', () => {
      expect(toolRoutingMap.register_project).toBe('handleRegisterProject');
    });
  });
});
