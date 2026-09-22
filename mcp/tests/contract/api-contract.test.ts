/**
 * @module mcp/tests/contract/api-contract.test
 * @description API contract tests for MCP tools.
 *
 * Tests API contracts:
 * 1. Validate all 7 MCP tool schemas
 * 2. Verify required/optional parameters
 * 3. Test schema validation errors
 * 4. Verify tool metadata
 *
 * Test count: 15 tests
 */

import { describe, expect, it } from 'vitest';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../../lib/shared/project-scope-advisory.js';
import {
  getProjectFileTool,
  getProjectOutlineTool,
  prepareProjectTool,
  registerProjectTool,
  searchProjectCodeTool,
  verifyProjectIndexTool,
} from '../../project-tools.js';
import {
  findProjectSymbolTool,
  findSymbolReferencesTool,
  getDocumentTool,
  getProjectSkeletonTool,
  healthCheckTool,
  ingestProjectFileTool,
  ingestProjectTool,
  listCategoriesTool,
  searchDocsTool,
  searchProjectDocsTool,
} from '../../tools.js';

describe('MCP API Contract', () => {
  describe('Tool Export Structure', () => {
    it('search_docs tool has required structure', () => {
      expect(searchDocsTool).toBeDefined();
      expect(searchDocsTool.name).toBe('search_docs');
      expect(searchDocsTool.description).toBeDefined();
      expect(searchDocsTool.inputSchema).toBeDefined();
      expect(searchDocsTool.inputSchema.type).toBe('object');
    });

    it('search_project_docs tool has required structure', () => {
      expect(searchProjectDocsTool).toBeDefined();
      expect(searchProjectDocsTool.name).toBe('search_project_docs');
      expect(searchProjectDocsTool.description).toBeDefined();
      expect(searchProjectDocsTool.inputSchema).toBeDefined();
      expect(searchProjectDocsTool.inputSchema.type).toBe('object');
    });

    it('search_project_code tool has required structure', () => {
      expect(searchProjectCodeTool).toBeDefined();
      expect(searchProjectCodeTool.name).toBe('search_project_code');
      expect(searchProjectCodeTool.inputSchema.type).toBe('object');
    });

    it('get_project_file tool has required structure', () => {
      expect(getProjectFileTool).toBeDefined();
      expect(getProjectFileTool.name).toBe('get_project_file');
      expect(getProjectFileTool.outputSchema?.type).toBe('object');
    });

    it('get_project_outline tool has required structure', () => {
      expect(getProjectOutlineTool).toBeDefined();
      expect(getProjectOutlineTool.name).toBe('get_project_outline');
      expect(getProjectOutlineTool.outputSchema?.type).toBe('object');
    });

    it('register_project tool has required structure', () => {
      expect(registerProjectTool).toBeDefined();
      expect(registerProjectTool.name).toBe('register_project');
      expect(registerProjectTool.outputSchema?.type).toBe('object');
    });

    it('verify_project_index tool has required structure', () => {
      expect(verifyProjectIndexTool).toBeDefined();
      expect(verifyProjectIndexTool.name).toBe('verify_project_index');
      expect(verifyProjectIndexTool.outputSchema?.type).toBe('object');
    });

    it('prepare_project tool has required structure', () => {
      expect(prepareProjectTool).toBeDefined();
      expect(prepareProjectTool.name).toBe('prepare_project');
      expect(prepareProjectTool.description).toBeDefined();
      expect(prepareProjectTool.inputSchema).toBeDefined();
      expect(prepareProjectTool.inputSchema.type).toBe('object');
      expect(prepareProjectTool.outputSchema?.type).toBe('object');
    });

    it('ingest_project tool has required structure', () => {
      expect(ingestProjectTool).toBeDefined();
      expect(ingestProjectTool.name).toBe('ingest_project');
      expect(ingestProjectTool.description).toBeDefined();
      expect(ingestProjectTool.inputSchema).toBeDefined();
      expect(ingestProjectTool.inputSchema.type).toBe('object');
    });

    it('ingest_project_file tool has required structure', () => {
      expect(ingestProjectFileTool).toBeDefined();
      expect(ingestProjectFileTool.name).toBe('ingest_project_file');
      expect(ingestProjectFileTool.description).toBeDefined();
      expect(ingestProjectFileTool.inputSchema).toBeDefined();
      expect(ingestProjectFileTool.inputSchema.type).toBe('object');
    });

    it('list_categories tool has required structure', () => {
      expect(listCategoriesTool).toBeDefined();
      expect(listCategoriesTool.name).toBe('list_categories');
      expect(listCategoriesTool.description).toBeDefined();
      expect(listCategoriesTool.inputSchema).toBeDefined();
      expect(listCategoriesTool.inputSchema.type).toBe('object');
    });

    it('health_check tool has required structure', () => {
      expect(healthCheckTool).toBeDefined();
      expect(healthCheckTool.name).toBe('health_check');
      expect(healthCheckTool.description).toBeDefined();
      expect(healthCheckTool.inputSchema).toBeDefined();
      expect(healthCheckTool.inputSchema.type).toBe('object');
    });

    it('get_document tool has required structure', () => {
      expect(getDocumentTool).toBeDefined();
      expect(getDocumentTool.name).toBe('get_document');
      expect(getDocumentTool.description).toBeDefined();
      expect(getDocumentTool.inputSchema).toBeDefined();
      expect(getDocumentTool.inputSchema.type).toBe('object');
    });

    it('find_project_symbol tool has required structure', () => {
      expect(findProjectSymbolTool).toBeDefined();
      expect(findProjectSymbolTool.name).toBe('find_project_symbol');
      expect(findProjectSymbolTool.description).toBeDefined();
      expect(findProjectSymbolTool.inputSchema).toBeDefined();
      expect(findProjectSymbolTool.inputSchema.type).toBe('object');
      expect(findProjectSymbolTool.outputSchema?.type).toBe('object');
    });

    it('find_symbol_references tool has required structure', () => {
      expect(findSymbolReferencesTool).toBeDefined();
      expect(findSymbolReferencesTool.name).toBe('find_symbol_references');
      expect(findSymbolReferencesTool.description).toBeDefined();
      expect(findSymbolReferencesTool.inputSchema).toBeDefined();
      expect(findSymbolReferencesTool.inputSchema.type).toBe('object');
      expect(findSymbolReferencesTool.outputSchema?.type).toBe('object');
    });

    it('get_project_skeleton tool has required structure', () => {
      expect(getProjectSkeletonTool).toBeDefined();
      expect(getProjectSkeletonTool.name).toBe('get_project_skeleton');
      expect(getProjectSkeletonTool.description).toBeDefined();
      expect(getProjectSkeletonTool.inputSchema).toBeDefined();
      expect(getProjectSkeletonTool.inputSchema.type).toBe('object');
      expect(getProjectSkeletonTool.outputSchema?.type).toBe('object');
    });
  });

  describe('Tool Names', () => {
    it('all tool names are unique', () => {
      const toolNames = [
        searchDocsTool.name,
        searchProjectDocsTool.name,
        searchProjectCodeTool.name,
        getProjectFileTool.name,
        getProjectOutlineTool.name,
        registerProjectTool.name,
        prepareProjectTool.name,
        verifyProjectIndexTool.name,
        ingestProjectTool.name,
        ingestProjectFileTool.name,
        listCategoriesTool.name,
        healthCheckTool.name,
        getDocumentTool.name,
        findProjectSymbolTool.name,
        findSymbolReferencesTool.name,
        getProjectSkeletonTool.name,
      ];

      const uniqueNames = new Set(toolNames);
      expect(uniqueNames.size).toBe(toolNames.length);
    });

    it('all tool names follow naming convention', () => {
      const toolNames = [
        searchDocsTool.name,
        searchProjectDocsTool.name,
        searchProjectCodeTool.name,
        getProjectFileTool.name,
        getProjectOutlineTool.name,
        registerProjectTool.name,
        prepareProjectTool.name,
        verifyProjectIndexTool.name,
        ingestProjectTool.name,
        ingestProjectFileTool.name,
        listCategoriesTool.name,
        healthCheckTool.name,
        getDocumentTool.name,
        findProjectSymbolTool.name,
        findSymbolReferencesTool.name,
        getProjectSkeletonTool.name,
      ];

      toolNames.forEach((name) => {
        // Should be snake_case
        expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      });
    });
  });

  describe('Required Parameters', () => {
    it('prepare_project requires rootPath only', () => {
      expect(prepareProjectTool.inputSchema.required).toEqual(['rootPath']);
    });

    it('search_docs has query as required', () => {
      expect(searchDocsTool.inputSchema.required).toContain('query');
    });

    it('search_docs has categories as optional', () => {
      expect(searchDocsTool.inputSchema.required).not.toContain('categories');
    });

    it('search_docs has limit as optional', () => {
      expect(searchDocsTool.inputSchema.required).not.toContain('limit');
    });

    it('search_project_docs has query as required', () => {
      expect(searchProjectDocsTool.inputSchema.required).toContain('query');
      expect(searchProjectDocsTool.inputSchema.required).toContain('projectId');
    });

    it('search_project_code has projectId and query as required', () => {
      expect(searchProjectCodeTool.inputSchema.required).toContain('projectId');
      expect(searchProjectCodeTool.inputSchema.required).toContain('query');
    });

    it('register_project requires rootPath, name, and includeRoots', () => {
      expect(registerProjectTool.inputSchema.required).toContain('name');
      expect(registerProjectTool.inputSchema.required).toContain('rootPath');
      expect(registerProjectTool.inputSchema.required).toContain('includeRoots');
    });

    it('ingest_project has no required parameters', () => {
      expect(ingestProjectTool.inputSchema.required).toBeUndefined();
    });

    it('ingest_project has no required rootPath parameter', () => {
      expect(ingestProjectTool.inputSchema.required || []).not.toContain('rootPath');
    });

    it('ingest_project_file has filePath as required', () => {
      expect(ingestProjectFileTool.inputSchema.required).toContain('filePath');
    });

    it('ingest_project_file has force as optional', () => {
      expect(ingestProjectFileTool.inputSchema.required).not.toContain('force');
    });

    it('ingest_project_file has no required rootPath parameter', () => {
      expect(ingestProjectFileTool.inputSchema.required || []).not.toContain('rootPath');
    });

    it('ingest_project_file has optional scopeAck parameter', () => {
      expect(ingestProjectFileTool.inputSchema.required || []).not.toContain('scopeAck');
    });

    it('ingest_project_file does not advertise durable execution', () => {
      const props = ingestProjectFileTool.inputSchema.properties as Record<string, any>;
      expect(props.executionMode).toBeUndefined();
    });

    it('list_categories has no required parameters', () => {
      expect(listCategoriesTool.inputSchema.required).toBeUndefined();
    });

    it('health_check has no required parameters', () => {
      expect(healthCheckTool.inputSchema.required).toBeUndefined();
    });

    it('get_document has sourcePath as required', () => {
      expect(getDocumentTool.inputSchema.required).toContain('sourcePath');
    });
  });

  describe('Parameter Types', () => {
    it('search_docs query is string type', () => {
      const props = searchDocsTool.inputSchema.properties as Record<string, any>;
      expect(props.query.type).toBe('string');
    });

    it('search_docs categories is array type', () => {
      const props = searchDocsTool.inputSchema.properties as Record<string, any>;
      expect(props.categories.type).toBe('array');
      expect(props.categories.items.type).toBe('string');
    });

    it('search_docs limit is number type', () => {
      const props = searchDocsTool.inputSchema.properties as Record<string, any>;
      expect(props.limit.type).toBe('number');
    });

    it('ingest_project force is boolean type', () => {
      const props = ingestProjectTool.inputSchema.properties as Record<string, any>;
      expect(props.force.type).toBe('boolean');
    });

    it('ingest_project rootPath is string type', () => {
      const props = ingestProjectTool.inputSchema.properties as Record<string, any>;
      expect(props.rootPath.type).toBe('string');
    });

    it('ingest_project includeRoots is an array of strings', () => {
      const props = ingestProjectTool.inputSchema.properties as Record<string, any>;
      expect(props.includeRoots.type).toBe('array');
      expect(props.includeRoots.items.type).toBe('string');
    });

    it('ingest_project maxFiles is an integer type', () => {
      const props = ingestProjectTool.inputSchema.properties as Record<string, any>;
      expect(props.maxFiles.type).toBe('integer');
      expect(props.maxFiles.minimum).toBe(1);
    });

    it('register_project includeRoots is an array of strings', () => {
      const props = registerProjectTool.inputSchema.properties as Record<string, any>;
      expect(props.includeRoots.type).toBe('array');
      expect(props.includeRoots.items.type).toBe('string');
    });

    it('ingest_project_file filePath is string type', () => {
      const props = ingestProjectFileTool.inputSchema.properties as Record<string, any>;
      expect(props.filePath.type).toBe('string');
    });

    it('ingest_project_file force is boolean type', () => {
      const props = ingestProjectFileTool.inputSchema.properties as Record<string, any>;
      expect(props.force.type).toBe('boolean');
    });

    it('ingest_project_file rootPath is string type', () => {
      const props = ingestProjectFileTool.inputSchema.properties as Record<string, any>;
      expect(props.rootPath.type).toBe('string');
    });

    it('ingest_project_file scopeAck is the project scope token', () => {
      const props = ingestProjectFileTool.inputSchema.properties as Record<string, any>;
      expect(props.scopeAck.type).toBe('string');
      expect(props.scopeAck.enum).toEqual([PROJECT_SCOPE_ACK_TOKEN]);
    });

    it('get_document sourcePath is string type', () => {
      const props = getDocumentTool.inputSchema.properties as Record<string, any>;
      expect(props.sourcePath.type).toBe('string');
    });
  });

  describe('Parameter Constraints', () => {
    it('search_docs limit has minimum constraint', () => {
      const props = searchDocsTool.inputSchema.properties as Record<string, any>;
      expect(props.limit.minimum).toBe(1);
    });

    it('search_docs limit has maximum constraint', () => {
      const props = searchDocsTool.inputSchema.properties as Record<string, any>;
      expect(props.limit.maximum).toBe(50);
    });

    it('search_project_docs limit has minimum constraint', () => {
      const props = searchProjectDocsTool.inputSchema.properties as Record<string, any>;
      expect(props.limit.minimum).toBe(1);
    });

    it('search_project_docs limit has maximum constraint', () => {
      const props = searchProjectDocsTool.inputSchema.properties as Record<string, any>;
      expect(props.limit.maximum).toBe(50);
    });
  });

  describe('Parameter Descriptions', () => {
    it('all search_docs parameters have descriptions', () => {
      const props = searchDocsTool.inputSchema.properties as Record<string, any>;
      expect(props.query.description).toBeDefined();
      expect(props.categories.description).toBeDefined();
      expect(props.limit.description).toBeDefined();
    });

    it('all ingest_project_file parameters have descriptions', () => {
      const props = ingestProjectFileTool.inputSchema.properties as Record<string, any>;
      expect(props.filePath.description).toBeDefined();
      expect(props.force.description).toBeDefined();
      expect(props.scopeAck.description).toBeDefined();
    });

    it('all ingest_project parameters have descriptions', () => {
      const props = ingestProjectTool.inputSchema.properties as Record<string, any>;
      expect(props.force.description).toBeDefined();
      expect(props.rootPath.description).toBeDefined();
      expect(props.includeRoots.description).toBeDefined();
      expect(props.scopeAck.description).toBeDefined();
    });

    it('all get_document parameters have descriptions', () => {
      const props = getDocumentTool.inputSchema.properties as Record<string, any>;
      expect(props.sourcePath.description).toBeDefined();
    });
  });

  describe('Output Schema Validation', () => {
    it('search_project_code output schema has success field', () => {
      expect(searchProjectCodeTool.outputSchema).toBeDefined();
      const schema = searchProjectCodeTool.outputSchema as Record<string, any>;
      expect(schema.properties.success).toBeDefined();
      expect(schema.properties.success.type).toBe('boolean');
    });

    it('search_project_code output schema has data and error fields', () => {
      const schema = searchProjectCodeTool.outputSchema as Record<string, any>;
      expect(schema.properties.data).toBeDefined();
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.data.properties.truncation).toBeDefined();
      expect(schema.properties.data.properties.diagnostics).toBeDefined();
    });

    it('get_project_file output schema has success field', () => {
      expect(getProjectFileTool.outputSchema).toBeDefined();
      const schema = getProjectFileTool.outputSchema as Record<string, any>;
      expect(schema.properties.success).toBeDefined();
      expect(schema.properties.success.type).toBe('boolean');
      expect(schema.properties.data.properties.truncation).toBeDefined();
    });

    it('get_project_outline output schema has success field', () => {
      expect(getProjectOutlineTool.outputSchema).toBeDefined();
      const schema = getProjectOutlineTool.outputSchema as Record<string, any>;
      expect(schema.properties.success).toBeDefined();
      expect(schema.properties.success.type).toBe('boolean');
    });

    it('register_project output schema has success field', () => {
      expect(registerProjectTool.outputSchema).toBeDefined();
      const schema = registerProjectTool.outputSchema as Record<string, any>;
      expect(schema.properties.success).toBeDefined();
      expect(schema.properties.success.type).toBe('boolean');
    });

    it('verify_project_index output schema has success field', () => {
      expect(verifyProjectIndexTool.outputSchema).toBeDefined();
      const schema = verifyProjectIndexTool.outputSchema as Record<string, any>;
      expect(schema.properties.success).toBeDefined();
      expect(schema.properties.success.type).toBe('boolean');
    });

    it('verify_project_index output schema uses a nullable ISO last sync timestamp', () => {
      const schema = verifyProjectIndexTool.outputSchema as Record<string, any>;
      const lastSyncAt = schema.properties.data.properties.lastSyncAt;
      expect(lastSyncAt.oneOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    });

    it('verify_project_index output schema formalizes semantic gate signal', () => {
      const schema = verifyProjectIndexTool.outputSchema as Record<string, any>;
      const dataProperties = schema.properties.data.properties;
      expect(dataProperties.gateSignal).toBeDefined();
      expect(dataProperties.gateSignal.required).toContain('ready');
      expect(dataProperties.gateSignal.required).toContain('blockingFailureCode');
      expect(dataProperties.gateSignal.properties.blockingFailureCode.oneOf).toBeDefined();
    });

    it('verify_project_index output schema includes watcher status contract', () => {
      const schema = verifyProjectIndexTool.outputSchema as Record<string, any>;
      const dataProperties = schema.properties.data.properties;
      expect(dataProperties.watcher).toBeDefined();
      expect(dataProperties.ownershipCoverage).toBeDefined();
      expect(dataProperties.invariants).toBeDefined();
      expect(dataProperties.watcher.required).toContain('status');
      expect(dataProperties.watcher.required).toContain('rootPath');
      expect(dataProperties.watcher.properties.status.enum).toEqual([
        'started',
        'already_running',
        'failed',
        'skipped',
      ]);
      expect(schema.properties.data.required).toContain('gateSignal');
      expect(schema.properties.data.required).toContain('watcher');
    });

    it('find_project_symbol output schema has success field', () => {
      expect(findProjectSymbolTool.outputSchema).toBeDefined();
      const schema = findProjectSymbolTool.outputSchema as Record<string, any>;
      expect(schema.properties.success).toBeDefined();
      expect(schema.properties.success.type).toBe('boolean');
    });

    it('find_symbol_references output schema has success field', () => {
      expect(findSymbolReferencesTool.outputSchema).toBeDefined();
      const schema = findSymbolReferencesTool.outputSchema as Record<string, any>;
      expect(schema.properties.success).toBeDefined();
      expect(schema.properties.success.type).toBe('boolean');
    });

    it('get_project_skeleton output schema has success field', () => {
      expect(getProjectSkeletonTool.outputSchema).toBeDefined();
      const schema = getProjectSkeletonTool.outputSchema as Record<string, any>;
      expect(schema.properties.success).toBeDefined();
      expect(schema.properties.success.type).toBe('boolean');
    });

    it('get_project_skeleton output schema has correct data structure', () => {
      const schema = getProjectSkeletonTool.outputSchema as Record<string, any>;
      expect(schema.properties.data).toBeDefined();
      expect(schema.properties.data.properties.sourcePath).toBeDefined();
      expect(schema.properties.data.properties.skeletonText).toBeDefined();
      expect(schema.properties.data.properties.sizeBytes).toBeDefined();
      expect(schema.properties.data.properties.available).toBeDefined();
    });

    it('get_project_skeleton output schema has error structure', () => {
      const schema = getProjectSkeletonTool.outputSchema as Record<string, any>;
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.error.properties.code).toBeDefined();
      expect(schema.properties.error.properties.message).toBeDefined();
      expect(schema.properties.error.properties.timestamp).toBeDefined();
    });

    it('all output schemas have required success field', () => {
      const tools = [
        searchProjectCodeTool,
        getProjectFileTool,
        getProjectOutlineTool,
        registerProjectTool,
        verifyProjectIndexTool,
        findProjectSymbolTool,
        findSymbolReferencesTool,
        getProjectSkeletonTool,
      ];

      for (const tool of tools) {
        const schema = tool.outputSchema as Record<string, any>;
        expect(schema.required).toContain('success');
      }
    });
  });

  describe('Tool Deprecation Metadata', () => {
    it('search_project_docs has deprecation in description', () => {
      expect(searchProjectDocsTool.description).toContain('Deprecated');
      expect(searchProjectDocsTool.description).toContain('search_project_code');
    });

    it('search_project_docs description includes migration path', () => {
      expect(searchProjectDocsTool.description).toContain('v2.0.0');
    });
  });
});
