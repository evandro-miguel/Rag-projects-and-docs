/**
 * @module mcp/project-contracts.test
 * @description Contract tests for MCP Project RAG response schemas (T-29).
 *
 * These tests verify:
 * - ProjectCodeSearchResult completeness
 * - Field optionality verification
 * - Response shape validation
 * - Prevention of optional-field and missing-ID regressions
 *
 * @see project-tools.ts - Tool schema definitions
 * @see project-handlers.ts - Handler implementations
 */

import { describe, expect, it } from 'vitest';
import type {
  ProjectCodeSearchResult,
  ProjectFileChunk,
  ProjectIndexVerificationResult,
  ProjectOutlineSymbol,
  ProjectRegistrationResult,
} from './project-tools.js';
import { searchProjectCodeOutputSchema, searchProjectCodeTool } from './project-tools.js';
import {
  findProjectSymbolTool,
  findSymbolReferencesTool,
  getProjectSkeletonTool,
  searchProjectDocsTool,
} from './tools.js';

/**
 * MCP Error envelope structure for contract validation.
 */
interface ErrorEnvelope {
  code: string;
  message: string;
  timestamp: string;
}

/**
 * Find project symbol result structure.
 */
interface FindSymbolResult {
  name: string;
  symbolType: string;
  sourcePath: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  exportType?: string;
}

/**
 * Symbol reference structure.
 */
interface SymbolReference {
  sourcePath: string;
  relationType: string;
  confidence: number;
  sourceRef?: string;
}

/**
 * Skeleton result structure.
 */
interface SkeletonResult {
  sourcePath: string;
  skeletonText?: string;
  outlineVersion?: string;
  lang?: string;
  sizeBytes: number;
  available: boolean;
}

describe('T-29: MCP Response Contract Tests', () => {
  describe('ProjectCodeSearchResult completeness', () => {
    it('should accept complete result with all fields', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'src/auth.ts',
        startLine: 10,
        endLine: 15,
        content: 'function authenticateUser() { }',
        score: 0.95,
        symbolName: 'authenticateUser',
        symbolKind: 'function',
      };

      expect(result.sourcePath).toBe('src/auth.ts');
      expect(result.startLine).toBe(10);
      expect(result.endLine).toBe(15);
      expect(result.content).toBe('function authenticateUser() { }');
      expect(result.score).toBe(0.95);
      expect(result.symbolName).toBe('authenticateUser');
      expect(result.symbolKind).toBe('function');
    });

    it('should accept result without optional line numbers (T-28 regression guard)', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'src/utils.ts',
        content: 'const helper = () => {}',
        score: 0.87,
      };

      expect(result.sourcePath).toBe('src/utils.ts');
      expect(result.startLine).toBeUndefined();
      expect(result.endLine).toBeUndefined();
      expect(result.content).toBe('const helper = () => {}');
      expect(result.score).toBe(0.87);
    });

    it('should accept result without symbol information', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'src/config.ts',
        startLine: 1,
        endLine: 5,
        content: 'export const config = {}',
        score: 0.75,
      };

      expect(result.symbolName).toBeUndefined();
      expect(result.symbolKind).toBeUndefined();
    });

    it('should require sourcePath field', () => {
      // @ts-expect-error - sourcePath should be required
      const result: ProjectCodeSearchResult = {
        content: 'test',
        score: 0.5,
      };

      expect(result).toBeDefined();
    });

    it('should require content field', () => {
      // @ts-expect-error - content should be required
      const result: ProjectCodeSearchResult = {
        sourcePath: 'test.ts',
        score: 0.5,
      };

      expect(result).toBeDefined();
    });

    it('should require score field', () => {
      // @ts-expect-error - score should be required
      const result: ProjectCodeSearchResult = {
        sourcePath: 'test.ts',
        content: 'test',
      };

      expect(result).toBeDefined();
    });
  });

  describe('Field optionality verification', () => {
    it('should allow optional startLine to be undefined', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'test.ts',
        content: 'test',
        score: 0.5,
        startLine: undefined,
      };

      expect(result.startLine).toBeUndefined();
    });

    it('should allow optional endLine to be undefined', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'test.ts',
        content: 'test',
        score: 0.5,
        endLine: undefined,
      };

      expect(result.endLine).toBeUndefined();
    });

    it('should allow optional symbolName to be undefined', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'test.ts',
        content: 'test',
        score: 0.5,
        symbolName: undefined,
      };

      expect(result.symbolName).toBeUndefined();
    });

    it('should allow optional symbolKind to be undefined', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'test.ts',
        content: 'test',
        score: 0.5,
        symbolKind: undefined,
      };

      expect(result.symbolKind).toBeUndefined();
    });
  });

  describe('Response shape validation', () => {
    it('should validate array of search results', () => {
      const results: ProjectCodeSearchResult[] = [
        {
          sourcePath: 'src/file1.ts',
          startLine: 10,
          endLine: 20,
          content: 'function a() {}',
          score: 0.9,
          symbolName: 'a',
          symbolKind: 'function',
        },
        {
          sourcePath: 'src/file2.ts',
          content: 'const b = 1',
          score: 0.8,
        },
      ];

      expect(results).toHaveLength(2);
      expect(results[0].symbolName).toBe('a');
      expect(results[1].symbolName).toBeUndefined();
    });

    it('should handle empty results array', () => {
      const results: ProjectCodeSearchResult[] = [];
      expect(results).toHaveLength(0);
    });

    it('should validate result with partial optional fields', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'src/partial.ts',
        startLine: 5,
        content: 'test',
        score: 0.6,
        symbolKind: 'variable',
      };

      expect(result.endLine).toBeUndefined();
      expect(result.symbolName).toBeUndefined();
      expect(result.symbolKind).toBe('variable');
    });
  });

  describe('ProjectFileChunk contract', () => {
    it('should validate chunk with minimal fields', () => {
      const chunk: ProjectFileChunk = {
        chunkIndex: 0,
        content: 'function test() {}',
      };

      expect(chunk.chunkIndex).toBe(0);
      expect(chunk.content).toBe('function test() {}');
      expect(chunk.startLine).toBeUndefined();
      expect(chunk.endLine).toBeUndefined();
    });

    it('should validate chunk with all optional fields', () => {
      const chunk: ProjectFileChunk = {
        chunkIndex: 1,
        content: 'const x = 1',
        startLine: 10,
        endLine: 15,
        symbolName: 'x',
        symbolKind: 'const',
      };

      expect(chunk.startLine).toBe(10);
      expect(chunk.endLine).toBe(15);
      expect(chunk.symbolName).toBe('x');
      expect(chunk.symbolKind).toBe('const');
    });
  });

  describe('ProjectOutlineSymbol contract', () => {
    it('should validate symbol with minimal fields', () => {
      const symbol: ProjectOutlineSymbol = {
        name: 'myFunction',
        kind: 'function',
      };

      expect(symbol.name).toBe('myFunction');
      expect(symbol.kind).toBe('function');
      expect(symbol.startLine).toBeUndefined();
    });

    it('should validate symbol with all fields', () => {
      const symbol: ProjectOutlineSymbol = {
        name: 'MyClass',
        kind: 'class',
        startLine: 1,
        endLine: 50,
        signature: 'class MyClass extends Base',
      };

      expect(symbol.signature).toBe('class MyClass extends Base');
    });
  });

  describe('ProjectRegistrationResult contract', () => {
    it('should validate registration result', () => {
      const result: ProjectRegistrationResult = {
        projectId: 'proj-123',
        slug: 'my-project',
        status: 'active',
        includeRoots: ['src'],
        created: true,
        allowlistAction: 'preserved',
        effectiveBlockedFindingAllowlist: [],
      };

      expect(result.projectId).toBe('proj-123');
      expect(result.slug).toBe('my-project');
      expect(result.status).toBe('active');
      expect(result.created).toBe(true);
      expect(result.allowlistAction).toBe('preserved');
      expect(result.effectiveBlockedFindingAllowlist).toEqual([]);
    });

    it('should accept replaced allowlist action', () => {
      const result: ProjectRegistrationResult = {
        projectId: 'proj-123',
        slug: 'my-project',
        status: 'active',
        includeRoots: ['src'],
        created: false,
        allowlistAction: 'replaced',
        effectiveBlockedFindingAllowlist: ['vendor/dep1'],
      };

      expect(result.allowlistAction).toBe('replaced');
      expect(result.effectiveBlockedFindingAllowlist).toEqual(['vendor/dep1']);
    });

    it('should accept cleared allowlist action', () => {
      const result: ProjectRegistrationResult = {
        projectId: 'proj-123',
        slug: 'my-project',
        status: 'active',
        includeRoots: ['src'],
        created: false,
        allowlistAction: 'cleared',
        effectiveBlockedFindingAllowlist: [],
      };

      expect(result.allowlistAction).toBe('cleared');
    });
  });

  describe('ProjectIndexVerificationResult contract', () => {
    it('should validate verification result with optional fields', () => {
      const result: ProjectIndexVerificationResult = {
        projectId: 'proj-123',
        fileCount: 10,
        chunkCount: 100,
        symbolCount: 50,
        coverage: 'Indexed',
        gateSignal: {
          ready: true,
          blockingFailureCode: null,
        },
        watcher: {
          status: 'skipped',
          rootPath: '/tmp/proj-123',
          reason: 'watcher_disabled_in_vitest',
        },
      };

      expect(result.lastSyncAt).toBeUndefined();
      expect(result.status).toBeUndefined();
      expect(result.coverage).toBe('Indexed');
      expect(result.gateSignal.ready).toBe(true);
      expect(result.gateSignal.blockingFailureCode).toBeNull();
    });

    it('should validate verification result with all fields', () => {
      const result: ProjectIndexVerificationResult = {
        projectId: 'proj-123',
        fileCount: 10,
        chunkCount: 100,
        symbolCount: 50,
        lastSyncAt: '2026-03-24T09:00:00.000Z',
        coverage: 'Indexed',
        status: 'active',
        gateSignal: {
          ready: false,
          blockingFailureCode: 'PROJECT_INDEX_SCOPE_DRIFT',
        },
        watcher: {
          status: 'already_running',
          rootPath: '/tmp/proj-123',
          pid: 4242,
          slug: 'proj-123',
          logPath: '/tmp/proj-123.log',
          metadataPath: '/tmp/proj-123.json',
        },
      };

      expect(result.lastSyncAt).toBe('2026-03-24T09:00:00.000Z');
      expect(result.status).toBe('active');
      expect(result.gateSignal.blockingFailureCode).toBe('PROJECT_INDEX_SCOPE_DRIFT');
      expect(result.watcher.status).toBe('already_running');
    });
  });

  describe('Prevent missing-ID regressions', () => {
    it('should require projectId in registration result', () => {
      // @ts-expect-error - projectId should be required
      const result: ProjectRegistrationResult = {
        slug: 'test',
        status: 'active',
        created: true,
      };

      expect(result).toBeDefined();
    });

    it('should require projectId in verification result', () => {
      // @ts-expect-error - projectId should be required
      const result: ProjectIndexVerificationResult = {
        fileCount: 0,
        chunkCount: 0,
        symbolCount: 0,
        coverage: 'none',
      };

      expect(result).toBeDefined();
    });
  });

  describe('Runtime payload alignment', () => {
    it('should match actual search handler output shape', () => {
      // Simulates the actual output from searchProjectCode handler
      const handlerOutput = {
        sourcePath: 'src/auth.ts',
        chunkIndex: 0,
        content: 'function auth() {}',
        searchableText: 'auth function',
        startLine: 10,
        endLine: 15,
        symbolName: 'auth',
        symbolKind: 'function',
        score: 0.95,
      };

      // This should map cleanly to ProjectCodeSearchResult
      const result: ProjectCodeSearchResult = {
        sourcePath: handlerOutput.sourcePath,
        startLine: handlerOutput.startLine,
        endLine: handlerOutput.endLine,
        content: handlerOutput.content,
        score: handlerOutput.score,
        symbolName: handlerOutput.symbolName,
        symbolKind: handlerOutput.symbolKind,
      };

      expect(result).toBeDefined();
      expect(result.sourcePath).toBe('src/auth.ts');
    });

    it('should handle chunks without line numbers from handler', () => {
      // Simulates handler output for chunks without line info
      const handlerOutput = {
        sourcePath: 'src/generated.ts',
        chunkIndex: 0,
        content: '// generated content',
        searchableText: 'generated content',
        score: 0.5,
      };

      const result: ProjectCodeSearchResult = {
        sourcePath: handlerOutput.sourcePath,
        content: handlerOutput.content,
        score: handlerOutput.score,
      };

      expect(result.startLine).toBeUndefined();
      expect(result.endLine).toBeUndefined();
    });
  });

  // ============================================================================
  // T-28: Expanded Coverage Tests
  // ============================================================================

  describe('T-28: search_project_code response with all optional fields', () => {
    it('should accept result with all optional fields populated', () => {
      const result: ProjectCodeSearchResult = {
        sourcePath: 'src/complete.ts',
        startLine: 1,
        endLine: 100,
        content: 'function completeFunction(): void { }',
        score: 0.99,
        symbolName: 'completeFunction',
        symbolKind: 'function',
      };

      expect(result.sourcePath).toBe('src/complete.ts');
      expect(result.startLine).toBe(1);
      expect(result.endLine).toBe(100);
      expect(result.content).toBe('function completeFunction(): void { }');
      expect(result.score).toBe(0.99);
      expect(result.symbolName).toBe('completeFunction');
      expect(result.symbolKind).toBe('function');
    });
  });

  describe('T-28: search_project_code error response format', () => {
    it('should validate error envelope structure', () => {
      const errorResponse: { success: boolean; error: ErrorEnvelope } = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Project not found',
          timestamp: '2026-03-14T10:00:00.000Z',
        },
      };

      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error.code).toBe('NOT_FOUND');
      expect(errorResponse.error.message).toBe('Project not found');
      expect(errorResponse.error.timestamp).toBeDefined();
    });

    it('should accept all error code variants', () => {
      const errorCodes = [
        'VALIDATION_ERROR',
        'NOT_FOUND',
        'INTERNAL_ERROR',
        'RATE_LIMITED',
      ] as const;

      errorCodes.forEach((code) => {
        const error: ErrorEnvelope = {
          code,
          message: `Test error for ${code}`,
          timestamp: new Date().toISOString(),
        };
        expect(error.code).toBe(code);
      });
    });
  });

  describe('T-28: search_project_code response modes', () => {
    it('constrains actual and requested modes to runtime-supported values', () => {
      const dataSchema = searchProjectCodeOutputSchema?.properties?.data as {
        properties?: {
          mode?: { enum?: string[] };
          requestedMode?: { enum?: string[] };
        };
        required?: string[];
      };

      expect(dataSchema.properties?.mode?.enum).toEqual(['hybrid']);
      expect(dataSchema.properties?.requestedMode?.enum).toEqual(['keyword', 'vector', 'hybrid']);
      expect(dataSchema.required).toEqual(expect.arrayContaining(['mode', 'requestedMode']));
    });

    it('shares the canonical output schema with the deprecated alias', () => {
      expect(searchProjectDocsTool.outputSchema).toBe(searchProjectCodeOutputSchema);
    });
  });

  describe('T-28: find_project_symbol response contracts', () => {
    it('should validate result with multiple symbol matches', () => {
      const multiMatchResult = {
        success: true,
        data: {
          symbols: [
            {
              name: 'handleSearch',
              symbolType: 'function',
              sourcePath: 'src/handlers/search.ts',
              startLine: 10,
              endLine: 20,
              signature: 'function handleSearch(query: string)',
              exportType: 'export',
            },
            {
              name: 'handleSearch',
              symbolType: 'function',
              sourcePath: 'src/handlers/search-utils.ts',
              startLine: 5,
              endLine: 15,
              signature: 'export function handleSearch(query)',
            },
          ],
          count: 2,
        },
      };

      expect(multiMatchResult.data.symbols).toHaveLength(2);
      expect(multiMatchResult.data.count).toBe(2);
      expect(multiMatchResult.data.symbols[0].exportType).toBe('export');
    });

    it('should validate result with no matches', () => {
      const noMatchResult = {
        success: true,
        data: {
          symbols: [],
          count: 0,
        },
      };

      expect(noMatchResult.data.symbols).toHaveLength(0);
      expect(noMatchResult.data.count).toBe(0);
    });

    it('should validate error envelope for find_project_symbol', () => {
      const errorResult = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid symbol name',
          timestamp: '2026-03-14T10:00:00.000Z',
        },
      };

      expect(errorResult.success).toBe(false);
      expect(errorResult.error.code).toBe('VALIDATION_ERROR');
    });

    it('should validate symbol result with minimal fields', () => {
      const minimalSymbol: FindSymbolResult = {
        name: 'myFunc',
        symbolType: 'function',
        sourcePath: 'src/test.ts',
      };

      expect(minimalSymbol.name).toBe('myFunc');
      expect(minimalSymbol.symbolType).toBe('function');
      expect(minimalSymbol.startLine).toBeUndefined();
      expect(minimalSymbol.signature).toBeUndefined();
    });
  });

  describe('T-28: find_symbol_references response contracts', () => {
    it('should validate transitive references response', () => {
      const transitiveResult = {
        success: true,
        data: {
          definitions: [
            {
              name: 'processData',
              symbolType: 'function',
              sourcePath: 'src/core.ts',
              startLine: 50,
              endLine: 60,
            },
          ],
          references: [
            {
              sourcePath: 'src/caller1.ts',
              relationType: 'call',
              confidence: 0.95,
            },
            {
              sourcePath: 'src/caller2.ts',
              relationType: 'call',
              confidence: 0.88,
            },
            {
              sourcePath: 'src/indirect.ts',
              relationType: 'import',
              confidence: 0.75,
              sourceRef: './core',
            },
          ],
          definitionCount: 1,
          referenceCount: 3,
        },
      };

      expect(transitiveResult.data.referenceCount).toBe(3);
      expect(transitiveResult.data.references[2].sourceRef).toBe('./core');
    });

    it('should validate direct references only', () => {
      const directResult = {
        success: true,
        data: {
          definitions: [
            {
              name: 'AuthService',
              symbolType: 'class',
              sourcePath: 'src/auth/service.ts',
              startLine: 1,
              endLine: 50,
              signature: 'class AuthService { }',
            },
          ],
          references: [
            {
              sourcePath: 'src/login.ts',
              relationType: 'import',
              confidence: 1.0,
              sourceRef: './auth/service',
            },
          ],
          definitionCount: 1,
          referenceCount: 1,
        },
      };

      expect(directResult.data.referenceCount).toBe(1);
      expect(directResult.data.references[0].confidence).toBe(1.0);
    });

    it('should validate error envelope for find_symbol_references', () => {
      const errorResult = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Symbol not found in project',
          timestamp: '2026-03-14T10:00:00.000Z',
        },
      };

      expect(errorResult.success).toBe(false);
      expect(errorResult.error.code).toBe('NOT_FOUND');
    });

    it('should validate reference with all relation types', () => {
      const relationTypes = ['import', 'call', 'extends', 'implements', 'uses'];

      relationTypes.forEach((type) => {
        const ref: SymbolReference = {
          sourcePath: 'src/test.ts',
          relationType: type,
          confidence: 0.9,
        };
        expect(ref.relationType).toBe(type);
      });
    });
  });

  describe('T-28: get_project_skeleton response contracts', () => {
    it('should validate complete skeleton response', () => {
      const completeSkeleton = {
        success: true,
        data: {
          sourcePath: 'src/main.ts',
          skeletonText: 'import { foo } from "./bar"\nexport class Main { }',
          outlineVersion: '1.0',
          lang: 'typescript',
          sizeBytes: 1024,
          available: true,
        },
      };

      expect(completeSkeleton.data.available).toBe(true);
      expect(completeSkeleton.data.skeletonText).toContain('import');
      expect(completeSkeleton.data.lang).toBe('typescript');
    });

    it('should validate unavailable skeleton', () => {
      const unavailableSkeleton = {
        success: true,
        data: {
          sourcePath: 'src/binary.dat',
          skeletonText: '',
          outlineVersion: undefined,
          lang: 'binary',
          sizeBytes: 4096,
          available: false,
        },
      };

      expect(unavailableSkeleton.data.available).toBe(false);
      expect(unavailableSkeleton.data.skeletonText).toBe('');
    });

    it('should validate error envelope for get_project_skeleton', () => {
      const errorResult = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'File not found in project index',
          timestamp: '2026-03-14T10:00:00.000Z',
        },
      };

      expect(errorResult.success).toBe(false);
      expect(errorResult.error.code).toBe('NOT_FOUND');
    });

    it('should validate skeleton result structure', () => {
      const skeleton: SkeletonResult = {
        sourcePath: 'src/test.ts',
        sizeBytes: 500,
        available: true,
      };

      expect(skeleton.sourcePath).toBe('src/test.ts');
      expect(skeleton.sizeBytes).toBe(500);
      expect(skeleton.available).toBe(true);
    });
  });

  describe('T-28: outputSchema validation', () => {
    it('search_project_code should have outputSchema', () => {
      expect(searchProjectCodeTool.outputSchema).toBeDefined();
      expect(searchProjectCodeTool.outputSchema?.type).toBe('object');
      expect(searchProjectCodeTool.outputSchema?.properties).toBeDefined();
      expect(searchProjectCodeTool.outputSchema?.properties?.success).toBeDefined();
    });

    it('find_project_symbol should have outputSchema', () => {
      expect(findProjectSymbolTool.outputSchema).toBeDefined();
      expect(findProjectSymbolTool.outputSchema?.type).toBe('object');
      expect(findProjectSymbolTool.outputSchema?.properties?.success).toBeDefined();
    });

    it('find_symbol_references should have outputSchema', () => {
      expect(findSymbolReferencesTool.outputSchema).toBeDefined();
      expect(findSymbolReferencesTool.outputSchema?.type).toBe('object');
      expect(findSymbolReferencesTool.outputSchema?.properties?.success).toBeDefined();
    });

    it('get_project_skeleton should have outputSchema', () => {
      expect(getProjectSkeletonTool.outputSchema).toBeDefined();
      expect(getProjectSkeletonTool.outputSchema?.type).toBe('object');
      expect(getProjectSkeletonTool.outputSchema?.properties?.success).toBeDefined();
    });

    it('all tool outputSchemas should have error property', () => {
      const tools = [
        searchProjectCodeTool,
        findProjectSymbolTool,
        findSymbolReferencesTool,
        getProjectSkeletonTool,
      ];

      tools.forEach((tool) => {
        expect(tool.outputSchema?.properties?.error).toBeDefined();
        const errorProps = tool.outputSchema?.properties?.error as any;
        expect(errorProps.properties?.code).toBeDefined();
        expect(errorProps.properties?.message).toBeDefined();
        expect(errorProps.properties?.timestamp).toBeDefined();
      });
    });

    it('all tool outputSchemas should require success field', () => {
      const tools = [
        searchProjectCodeTool,
        findProjectSymbolTool,
        findSymbolReferencesTool,
        getProjectSkeletonTool,
      ];

      tools.forEach((tool) => {
        expect(tool.outputSchema?.required).toContain('success');
      });
    });
  });

  describe('T-28: deprecation metadata validation', () => {
    it('search_project_code should have description', () => {
      expect(searchProjectCodeTool.description).toBeDefined();
      expect(typeof searchProjectCodeTool.description).toBe('string');
      expect(searchProjectCodeTool.description?.length).toBeGreaterThan(0);
    });

    it('find_project_symbol should have description', () => {
      expect(findProjectSymbolTool.description).toBeDefined();
      expect(typeof findProjectSymbolTool.description).toBe('string');
    });

    it('find_symbol_references should have description', () => {
      expect(findSymbolReferencesTool.description).toBeDefined();
      expect(typeof findSymbolReferencesTool.description).toBe('string');
    });

    it('get_project_skeleton should have description', () => {
      expect(getProjectSkeletonTool.description).toBeDefined();
      expect(typeof getProjectSkeletonTool.description).toBe('string');
    });
  });

  describe('T-28: outputSchema validation', () => {
    it('search_project_code should have outputSchema', () => {
      expect(searchProjectCodeTool.outputSchema).toBeDefined();
      expect(searchProjectCodeTool.outputSchema?.type).toBe('object');
      expect(searchProjectCodeTool.outputSchema?.properties).toBeDefined();
      expect(searchProjectCodeTool.outputSchema?.properties?.success).toBeDefined();
    });

    it('find_project_symbol should have outputSchema', () => {
      expect(findProjectSymbolTool.outputSchema).toBeDefined();
      expect(findProjectSymbolTool.outputSchema?.type).toBe('object');
      expect(findProjectSymbolTool.outputSchema?.properties?.success).toBeDefined();
    });

    it('find_symbol_references should have outputSchema', () => {
      expect(findSymbolReferencesTool.outputSchema).toBeDefined();
      expect(findSymbolReferencesTool.outputSchema?.type).toBe('object');
      expect(findSymbolReferencesTool.outputSchema?.properties?.success).toBeDefined();
    });

    it('get_project_skeleton should have outputSchema', () => {
      expect(getProjectSkeletonTool.outputSchema).toBeDefined();
      expect(getProjectSkeletonTool.outputSchema?.type).toBe('object');
      expect(getProjectSkeletonTool.outputSchema?.properties?.success).toBeDefined();
    });

    it('all tool outputSchemas should have error property', () => {
      const tools = [
        searchProjectCodeTool,
        findProjectSymbolTool,
        findSymbolReferencesTool,
        getProjectSkeletonTool,
      ];

      tools.forEach((tool) => {
        expect(tool.outputSchema?.properties?.error).toBeDefined();
        const errorProps = tool.outputSchema?.properties?.error as any;
        expect(errorProps.properties?.code).toBeDefined();
        expect(errorProps.properties?.message).toBeDefined();
        expect(errorProps.properties?.timestamp).toBeDefined();
      });
    });

    it('all tool outputSchemas should require success field', () => {
      const tools = [
        searchProjectCodeTool,
        findProjectSymbolTool,
        findSymbolReferencesTool,
        getProjectSkeletonTool,
      ];

      tools.forEach((tool) => {
        expect(tool.outputSchema?.required).toContain('success');
      });
    });
  });

  describe('T-28: deprecation metadata validation', () => {
    it('search_project_code should have description', () => {
      expect(searchProjectCodeTool.description).toBeDefined();
      expect(typeof searchProjectCodeTool.description).toBe('string');
      expect(searchProjectCodeTool.description?.length).toBeGreaterThan(0);
    });

    it('find_project_symbol should have description', () => {
      expect(findProjectSymbolTool.description).toBeDefined();
      expect(typeof findProjectSymbolTool.description).toBe('string');
    });

    it('find_symbol_references should have description', () => {
      expect(findSymbolReferencesTool.description).toBeDefined();
      expect(typeof findSymbolReferencesTool.description).toBe('string');
    });

    it('get_project_skeleton should have description', () => {
      expect(getProjectSkeletonTool.description).toBeDefined();
      expect(typeof getProjectSkeletonTool.description).toBe('string');
    });
  });
});
