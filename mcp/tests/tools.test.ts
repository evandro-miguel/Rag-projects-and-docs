/**
 * @module tools.test
 * @description Unit tests for MCP tool definitions (mcp/tools.ts).
 *
 * Test count: 24 tests
 * Target: Test tool schemas, validation, type definitions, and export structure.
 */

import { describe, expect, it } from 'vitest';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../lib/shared/project-scope-advisory.js';
import {
  getProjectFileTool,
  getProjectOutlineTool,
  prepareProjectTool,
  registerProjectTool,
  searchProjectCodeOutputSchema,
  searchProjectCodeTool,
  verifyProjectIndexTool,
} from '../project-tools.js';
import {
  type CategoriesResponse,
  type Category,
  getDocumentTool,
  healthCheckTool,
  ingestProjectFileTool,
  ingestProjectTool,
  listCategoriesTool,
  type SearchChunk,
  type SearchDocsArgs,
  type SearchDocument,
  type SearchResponse,
  type SearchResult,
  searchDocsTool,
  searchProjectDocsTool,
} from '../tools.js';

describe('MCP Tools (mcp/tools.ts)', () => {
  describe('Tool Exports', () => {
    it('exports searchDocsTool', () => {
      expect(searchDocsTool).toBeDefined();
      expect(searchDocsTool.name).toBe('search_docs');
    });

    it('exports searchProjectDocsTool', () => {
      expect(searchProjectDocsTool).toBeDefined();
      expect(searchProjectDocsTool.name).toBe('search_project_docs');
    });

    it('exports searchProjectCodeTool', () => {
      expect(searchProjectCodeTool).toBeDefined();
      expect(searchProjectCodeTool.name).toBe('search_project_code');
    });

    it('exports getProjectFileTool', () => {
      expect(getProjectFileTool).toBeDefined();
      expect(getProjectFileTool.name).toBe('get_project_file');
    });

    it('exports getProjectOutlineTool', () => {
      expect(getProjectOutlineTool).toBeDefined();
      expect(getProjectOutlineTool.name).toBe('get_project_outline');
    });

    it('exports registerProjectTool', () => {
      expect(registerProjectTool).toBeDefined();
      expect(registerProjectTool.name).toBe('register_project');
    });

    it('exports verifyProjectIndexTool', () => {
      expect(verifyProjectIndexTool).toBeDefined();
      expect(verifyProjectIndexTool.name).toBe('verify_project_index');
    });

    it('exports prepareProjectTool', () => {
      expect(prepareProjectTool).toBeDefined();
      expect(prepareProjectTool.name).toBe('prepare_project');
    });

    it('exports ingestProjectTool', () => {
      expect(ingestProjectTool).toBeDefined();
      expect(ingestProjectTool.name).toBe('ingest_project');
    });

    it('exports ingestProjectFileTool', () => {
      expect(ingestProjectFileTool).toBeDefined();
      expect(ingestProjectFileTool.name).toBe('ingest_project_file');
    });

    it('exports listCategoriesTool', () => {
      expect(listCategoriesTool).toBeDefined();
      expect(listCategoriesTool.name).toBe('list_categories');
    });

    it('exports healthCheckTool', () => {
      expect(healthCheckTool).toBeDefined();
      expect(healthCheckTool.name).toBe('health_check');
    });

    it('exports getDocumentTool', () => {
      expect(getDocumentTool).toBeDefined();
      expect(getDocumentTool.name).toBe('get_document');
    });
  });

  describe('Tool Schema Validation', () => {
    it('prepareProjectTool requires rootPath and exposes bounded controls', () => {
      expect(prepareProjectTool.inputSchema.type).toBe('object');
      expect(prepareProjectTool.inputSchema.required).toEqual(['rootPath']);
      const props = prepareProjectTool.inputSchema.properties as Record<string, any>;
      expect(props.rootPath.type).toBe('string');
      expect(props.timeoutMs).toMatchObject({ type: 'number', minimum: 1 });
      expect(props.maxFiles).toMatchObject({ type: 'number', minimum: 1 });
      expect(props.maxBatches).toMatchObject({ type: 'number', minimum: 1 });
    });

    it('searchDocsTool has correct schema structure', () => {
      expect(searchDocsTool.inputSchema.type).toBe('object');
      expect(searchDocsTool.inputSchema.properties).toBeDefined();
      expect(searchDocsTool.inputSchema.required).toContain('query');
    });

    it('searchDocsTool has query property', () => {
      const props = searchDocsTool.inputSchema.properties as any;
      expect(props.query).toBeDefined();
      expect(props.query.type).toBe('string');
      expect(props.query.description).toBeDefined();
    });

    it('searchDocsTool has optional categories property', () => {
      const props = searchDocsTool.inputSchema.properties as any;
      expect(props.categories).toBeDefined();
      expect(props.categories.type).toBe('array');
      expect(props.categories.items.type).toBe('string');
    });

    it('searchDocsTool has optional source metadata filters', () => {
      const props = searchDocsTool.inputSchema.properties as any;
      expect(props.sourceId.type).toBe('string');
      expect(props.sourceIds.type).toBe('array');
      expect(props.sourceIds.items.type).toBe('string');
      expect(props.language.type).toBe('string');
      expect(props.kind.enum).toEqual(['official-docs', 'book', 'package-docs', 'repository-docs']);
      expect(props.authority.enum).toEqual(['official', 'publisher', 'community-vetted']);
      expect(props.sourceTags.type).toBe('array');
      expect(props.sourceTags.items.type).toBe('string');
    });

    it('searchDocsTool exposes additive retrieval orchestration flags', () => {
      const props = searchDocsTool.inputSchema.properties as any;
      expect(props.retrievalMode.enum).toEqual(['hybrid', 'local_first']);
      expect(props.includePageRefs.type).toBe('boolean');
      expect(props.includeTrust.type).toBe('boolean');
    });

    it('searchDocsTool declares all canonical citation fields in its output schema', () => {
      const schema = searchDocsTool.outputSchema as any;
      const resultSchema = schema.properties.results.items;
      expect(resultSchema.required).toEqual([
        'sourceId',
        'sourcePath',
        'canonicalUrl',
        'title',
        'heading',
        'section',
        'chunkIndex',
        'sourceRevision',
        'syncedAt',
        'authority',
        'score',
        'content',
        'provenanceStatus',
        'missingFields',
      ]);
      expect(resultSchema.properties.canonicalUrl.oneOf).toEqual([
        { type: 'string' },
        { type: 'null' },
      ]);
      expect(resultSchema.properties.provenanceStatus.enum).toEqual(['complete', 'degraded']);
    });

    it('searchDocsTool has limit with min/max constraints', () => {
      const props = searchDocsTool.inputSchema.properties as any;
      expect(props.limit).toBeDefined();
      expect(props.limit.type).toBe('number');
      expect(props.limit.minimum).toBe(1);
      expect(props.limit.maximum).toBe(50);
    });

    it('searchProjectDocsTool has correct schema structure', () => {
      expect(searchProjectDocsTool.inputSchema.type).toBe('object');
      expect(searchProjectDocsTool.inputSchema.properties).toBeDefined();
      expect(searchProjectDocsTool.inputSchema.required).toContain('query');
    });

    it('searchProjectDocsTool requires explicit projectId as a deprecated alias', () => {
      const props = searchProjectDocsTool.inputSchema.properties as any;
      expect(props.projectId).toBeDefined();
      expect(searchProjectDocsTool.inputSchema.required).toContain('projectId');
      expect(props.mode.enum).toEqual(['keyword', 'vector', 'hybrid']);
      expect(searchProjectDocsTool.outputSchema).toBe(searchProjectCodeOutputSchema);
    });

    it('searchProjectCodeTool has the canonical project search schema', () => {
      const props = searchProjectCodeTool.inputSchema.properties as any;
      expect(searchProjectCodeTool.inputSchema.required).toContain('projectId');
      expect(searchProjectCodeTool.inputSchema.required).toContain('query');
      expect(props.mode.enum).toEqual(['keyword', 'vector', 'hybrid']);
      expect(props.includeDiagnostics).toBeDefined();
      expect(props.includeDiagnostics.type).toBe('boolean');
    });

    it('registerProjectTool requires name, rootPath, and includeRoots', () => {
      const props = registerProjectTool.inputSchema.properties as any;
      expect(registerProjectTool.inputSchema.required).toEqual([
        'name',
        'rootPath',
        'includeRoots',
      ]);
      expect(props.rootPath.type).toBe('string');
      expect(props.includeRoots.type).toBe('array');
      expect(props.includeRoots.items.type).toBe('string');
    });

    it('verifyProjectIndexTool requires projectId', () => {
      expect(verifyProjectIndexTool.inputSchema.required).toContain('projectId');
    });

    it('ingestProjectTool has optional force parameter', () => {
      expect(ingestProjectTool.inputSchema.type).toBe('object');
      const props = ingestProjectTool.inputSchema.properties as any;
      expect(props.force).toBeDefined();
      expect(props.force.type).toBe('boolean');
      expect(props.force.default).toBe(false);
      expect(props.rootPath).toBeDefined();
      expect(props.rootPath.type).toBe('string');
      expect(props.includeRoots).toBeDefined();
      expect(props.includeRoots.type).toBe('array');
      expect(props.includeRoots.items.type).toBe('string');
      expect(props.scopeAck).toBeDefined();
      expect(props.executionMode).toBeDefined();
      expect(props.executionMode.enum).toEqual(['inline', 'durable']);
    });

    it('ingestProjectTool has no required fields', () => {
      expect(ingestProjectTool.inputSchema.required).toBeUndefined();
    });

    it('ingestProjectFileTool has required filePath', () => {
      expect(ingestProjectFileTool.inputSchema.type).toBe('object');
      expect(ingestProjectFileTool.inputSchema.required).toContain('filePath');
      const props = ingestProjectFileTool.inputSchema.properties as any;
      expect(props.filePath.type).toBe('string');
    });

    it('ingestProjectFileTool supports optional rootPath', () => {
      const props = ingestProjectFileTool.inputSchema.properties as any;
      expect(props.rootPath).toBeDefined();
      expect(props.rootPath.type).toBe('string');
    });

    it('ingestProjectFileTool has optional force parameter', () => {
      const props = ingestProjectFileTool.inputSchema.properties as any;
      expect(props.force).toBeDefined();
      expect(props.force.type).toBe('boolean');
      expect(props.force.default).toBe(false);
      expect(props.scopeAck).toBeDefined();
      expect(props.scopeAck.enum).toEqual([PROJECT_SCOPE_ACK_TOKEN]);
      expect(props.executionMode).toBeUndefined();
    });

    it('listCategoriesTool has empty input schema', () => {
      expect(listCategoriesTool.inputSchema.type).toBe('object');
      expect(listCategoriesTool.inputSchema.properties).toEqual({});
      expect(listCategoriesTool.inputSchema.required).toBeUndefined();
    });

    it('listCategoriesTool declares its structured output schema', () => {
      const schema = listCategoriesTool.outputSchema as any;
      expect(schema.type).toBe('object');
      expect(schema.required).toEqual(['success']);
      expect(schema.properties.success.type).toBe('boolean');
      expect(schema.properties.data.required).toEqual(['categories']);
      expect(schema.properties.data.properties.categories.items.required).toEqual([
        'name',
        'displayName',
        'docCount',
        'chunkCount',
      ]);
      expect(schema.properties.error.required).toEqual(['code', 'message', 'timestamp']);
    });

    it('healthCheckTool has empty input schema', () => {
      expect(healthCheckTool.inputSchema.type).toBe('object');
      expect(healthCheckTool.inputSchema.properties).toEqual({});
      expect(healthCheckTool.inputSchema.required).toBeUndefined();
    });

    it('getDocumentTool has required sourcePath', () => {
      expect(getDocumentTool.inputSchema.type).toBe('object');
      expect(getDocumentTool.inputSchema.required).toContain('sourcePath');
      const props = getDocumentTool.inputSchema.properties as any;
      expect(props.sourcePath.type).toBe('string');
      expect(props.sourcePath.description).toBeDefined();
    });

    it('getDocumentTool declares the structured response contract', () => {
      const schema = getDocumentTool.outputSchema as any;
      expect(schema.required).toContain('success');
      expect(schema.properties.data.required).toEqual(['sourcePath', 'found']);
      expect(schema.properties.data.properties.content.type).toBe('string');
      expect(schema.properties.data.properties.chunkCount.type).toBe('number');
      expect(schema.properties.error.required).toEqual(['code', 'message', 'timestamp']);
    });
  });

  describe('Tool Descriptions', () => {
    it('searchDocsTool has descriptive description', () => {
      expect(searchDocsTool.description).toContain('Search');
      expect(searchDocsTool.description).toContain('documentation');
      expect(searchDocsTool.description).toContain('semantic search');
    });

    it('searchProjectDocsTool has descriptive description', () => {
      expect(searchProjectDocsTool.description).toContain('Search');
      expect(searchProjectDocsTool.description).toContain('project');
      expect(searchProjectDocsTool.description).toContain('Deprecated');
    });

    it('searchProjectCodeTool has descriptive description', () => {
      expect(searchProjectCodeTool.description).toContain('Search');
      expect(searchProjectCodeTool.description).toContain('project code');
    });

    it('registerProjectTool has descriptive description', () => {
      expect(registerProjectTool.description).toContain('Register');
      expect(registerProjectTool.description).toContain('project');
    });

    it('verifyProjectIndexTool has descriptive description', () => {
      expect(verifyProjectIndexTool.description).toContain('Verify');
      expect(verifyProjectIndexTool.description).toContain('project index');
    });

    it('ingestProjectTool has descriptive description', () => {
      expect(ingestProjectTool.description).toContain('Ingest');
      expect(ingestProjectTool.description).toContain('project');
      expect(ingestProjectTool.description).toContain('RAG index');
    });

    it('ingestProjectFileTool has descriptive description', () => {
      expect(ingestProjectFileTool.description).toContain('Ingest');
      expect(ingestProjectFileTool.description).toContain('single file');
    });

    it('listCategoriesTool has descriptive description', () => {
      expect(listCategoriesTool.description).toContain('List');
      expect(listCategoriesTool.description).toContain('categories');
      expect(listCategoriesTool.description).toContain('statistics');
    });

    it('healthCheckTool has concise description', () => {
      expect(healthCheckTool.description).toContain('Check');
      expect(healthCheckTool.description).toContain('health');
    });

    it('getDocumentTool has descriptive description', () => {
      expect(getDocumentTool.description).toContain('Retrieve');
      expect(getDocumentTool.description).toContain('document');
      expect(getDocumentTool.description).toContain('source path');
    });
  });

  describe('Type Definitions', () => {
    it('SearchDocsArgs type structure', () => {
      // Type checking is done at compile time, this verifies runtime usage
      const args: SearchDocsArgs = {
        query: 'test query',
        categories: ['react', 'go'],
        limit: 10,
        docTypes: ['external'],
      };
      expect(args.query).toBe('test query');
      expect(args.categories).toEqual(['react', 'go']);
      expect(args.limit).toBe(10);
    });

    it('Category type structure', () => {
      const category: Category = {
        _id: 'cat_123',
        name: 'react',
        displayName: 'React',
        description: 'React documentation',
        docCount: 25,
        chunkCount: 150,
        lastSyncAt: Date.now(),
      };
      expect(category.name).toBe('react');
      expect(category.docCount).toBe(25);
      expect(category.chunkCount).toBe(150);
    });

    it('SearchChunk type structure', () => {
      const chunk: SearchChunk = {
        content: 'Test content',
        section: 'Introduction',
        chunkIndex: 0,
        startLine: 1,
        endLine: 10,
      };
      expect(chunk.content).toBe('Test content');
      expect(chunk.chunkIndex).toBe(0);
    });

    it('SearchDocument type structure', () => {
      const doc: SearchDocument = {
        _id: 'doc_456',
        title: 'Test Document',
        sourcePath: 'docs/test.md',
      };
      expect(doc.title).toBe('Test Document');
      expect(doc.sourcePath).toBe('docs/test.md');
    });

    it('SearchResult type structure', () => {
      const result: SearchResult = {
        chunk: {
          content: 'Matching content',
          chunkIndex: 0,
        },
        score: 0.95,
        document: {
          _id: 'doc_789',
          title: 'Test Doc',
          sourcePath: 'test.md',
        },
      };
      expect(result.score).toBe(0.95);
      expect(result.chunk.content).toBe('Matching content');
    });

    it('SearchResponse type structure', () => {
      const response: SearchResponse = {
        results: [
          {
            chunk: { content: 'Result 1', chunkIndex: 0 },
            score: 0.95,
            document: { _id: '1', title: 'Doc 1', sourcePath: 'd1.md' },
          },
        ],
      };
      expect(response.results).toHaveLength(1);
      expect(response.results[0].score).toBe(0.95);
    });

    it('CategoriesResponse type structure', () => {
      const response: CategoriesResponse = {
        categories: [
          {
            _id: 'cat_1',
            name: 'react',
            displayName: 'React',
            docCount: 30,
            chunkCount: 200,
            lastSyncAt: Date.now(),
          },
        ],
      };
      expect(response.categories).toHaveLength(1);
      expect(response.categories[0].name).toBe('react');
    });
  });
});
