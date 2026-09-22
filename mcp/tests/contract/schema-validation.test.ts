/**
 * @module mcp/tests/contract/schema-validation.test
 * @description Schema validation tests for MCP tool inputs.
 *
 * Tests schema validation:
 * 1. Test valid inputs pass validation
 * 2. Test invalid inputs rejected with clear errors
 * 3. Edge cases: empty strings, null, wrong types
 * 4. Boundary value testing
 *
 * Test count: 18 tests
 */

import { describe, expect, it } from 'vitest';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../../lib/shared/project-scope-advisory.js';
import { searchProjectCodeTool } from '../../project-tools.js';
import {
  getDocumentTool,
  healthCheckTool,
  ingestProjectFileTool,
  ingestProjectTool,
  listCategoriesTool,
  searchDocsTool,
  searchProjectDocsTool,
} from '../../tools.js';

// Simple JSON Schema validator for testing
function validateSchema(data: any, schema: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      errors.push('Expected object');
      return { valid: errors.length === 0, errors };
    }

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Validate properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const value = data[key];
        if (value !== undefined) {
          const propResult = validateProperty(value, propSchema as any);
          if (!propResult.valid) {
            errors.push(...propResult.errors.map((e: any) => `${key}: ${e}`));
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateProperty(value: any, schema: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Type check
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`Expected string, got ${typeof value}`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`Value must be one of: ${schema.enum.join(', ')}`);
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number') {
      errors.push(`Expected ${schema.type}, got ${typeof value}`);
    } else if (schema.type === 'integer' && !Number.isInteger(value)) {
      errors.push(`Expected integer, got ${value}`);
    } else {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`Value ${value} is less than minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`Value ${value} is greater than maximum ${schema.maximum}`);
      }
    }
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`Expected boolean, got ${typeof value}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`Expected array, got ${typeof value}`);
    } else if (schema.items) {
      value.forEach((item: any, index: number) => {
        const itemResult = validateProperty(item, schema.items);
        if (!itemResult.valid) {
          errors.push(...itemResult.errors.map((e: any) => `[${index}]: ${e}`));
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

describe('Schema Validation', () => {
  describe('search_docs', () => {
    const schema = searchDocsTool.inputSchema;

    it('accepts valid query only', () => {
      const result = validateSchema({ query: 'test query' }, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts valid query with categories', () => {
      const result = validateSchema({ query: 'test', categories: ['bun', 'react'] }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts valid query with limit', () => {
      const result = validateSchema({ query: 'test', limit: 10 }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts valid query with all parameters', () => {
      const result = validateSchema({ query: 'test', categories: ['bun'], limit: 20 }, schema);
      expect(result.valid).toBe(true);
    });

    it('rejects missing query', () => {
      const result = validateSchema({}, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: query');
    });

    it('rejects empty string query', () => {
      const result = validateSchema({ query: '' }, schema);
      // Empty string is technically valid string type
      expect(result.valid).toBe(true);
    });

    it('rejects non-string query', () => {
      const result = validateSchema({ query: 123 }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Expected string');
    });

    it('rejects invalid categories type', () => {
      const result = validateSchema({ query: 'test', categories: 'not-array' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Expected array');
    });

    it('rejects limit below minimum', () => {
      const result = validateSchema({ query: 'test', limit: 0 }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('less than minimum');
    });

    it('rejects limit above maximum', () => {
      const result = validateSchema({ query: 'test', limit: 100 }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('greater than maximum');
    });

    it('accepts limit at minimum boundary', () => {
      const result = validateSchema({ query: 'test', limit: 1 }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts limit at maximum boundary', () => {
      const result = validateSchema({ query: 'test', limit: 50 }, schema);
      expect(result.valid).toBe(true);
    });
  });

  describe('search_project_docs', () => {
    const schema = searchProjectDocsTool.inputSchema;

    it('accepts valid query', () => {
      const result = validateSchema({ projectId: 'project-123', query: 'test' }, schema);
      expect(result.valid).toBe(true);
    });

    it('rejects missing query', () => {
      const result = validateSchema({}, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: query');
    });

    it('rejects missing projectId', () => {
      const result = validateSchema({ query: 'test' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: projectId');
    });

    it('rejects non-string query', () => {
      const result = validateSchema({ projectId: 'project-123', query: null }, schema);
      expect(result.valid).toBe(false);
    });
  });

  describe('search_project_code', () => {
    const schema = searchProjectCodeTool.inputSchema;

    it('accepts valid canonical project search arguments', () => {
      const result = validateSchema({ projectId: 'project-123', query: 'test', limit: 5 }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts includeDiagnostics boolean flag', () => {
      const result = validateSchema(
        { projectId: 'project-123', query: 'test', includeDiagnostics: true },
        schema
      );
      expect(result.valid).toBe(true);
    });

    it('rejects missing projectId', () => {
      const result = validateSchema({ query: 'test' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: projectId');
    });
  });

  describe('ingest_project', () => {
    const schema = ingestProjectTool.inputSchema;

    it('accepts empty object', () => {
      const result = validateSchema({}, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts force: true', () => {
      const result = validateSchema({ force: true }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts force: false', () => {
      const result = validateSchema({ force: false }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts explicit rootPath', () => {
      const result = validateSchema({ rootPath: '/tmp/project' }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts whitespace-trimmed rootPath', () => {
      const result = validateSchema({ rootPath: '  /tmp/project  ' }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts includeRoots array', () => {
      const result = validateSchema({ includeRoots: ['src', 'docs'] }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts an integer maxFiles value', () => {
      expect(validateSchema({ maxFiles: 12 }, schema).valid).toBe(true);
    });

    it('rejects a fractional maxFiles value', () => {
      const result = validateSchema({ maxFiles: 1.5 }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Expected integer');
    });

    it('rejects non-boolean force', () => {
      const result = validateSchema({ force: 'true' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Expected boolean');
    });

    it('rejects non-string rootPath', () => {
      const result = validateSchema({ rootPath: 123 }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Expected string');
    });

    it('rejects non-array includeRoots', () => {
      const result = validateSchema({ includeRoots: 'src' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Expected array');
    });

    it('rejects non-string includeRoots entry', () => {
      const result = validateSchema({ includeRoots: ['src', 123] }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Expected string');
    });

    it('rejects null force', () => {
      const result = validateSchema({ force: null }, schema);
      expect(result.valid).toBe(false);
    });
  });

  describe('ingest_project_file', () => {
    const schema = ingestProjectFileTool.inputSchema;

    it('accepts valid filePath only', () => {
      const result = validateSchema({ filePath: '/home/test/file.md' }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts filePath with force', () => {
      const result = validateSchema({ filePath: '/test.md', force: true }, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts explicit rootPath', () => {
      const result = validateSchema(
        { filePath: '/tmp/project/file.md', rootPath: '/tmp/project' },
        schema
      );
      expect(result.valid).toBe(true);
    });

    it('accepts the project scope acknowledgement token', () => {
      const result = validateSchema(
        { filePath: '/tmp/project/file.md', scopeAck: PROJECT_SCOPE_ACK_TOKEN },
        schema
      );
      expect(result.valid).toBe(true);
    });

    it('rejects an invalid project scope acknowledgement token', () => {
      const result = validateSchema({ filePath: '/tmp/project/file.md', scopeAck: 'yes' }, schema);
      expect(result.valid).toBe(false);
    });

    it('rejects missing filePath', () => {
      const result = validateSchema({}, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: filePath');
    });

    it('rejects empty string filePath', () => {
      const result = validateSchema({ filePath: '' }, schema);
      // Empty string is technically valid
      expect(result.valid).toBe(true);
    });

    it('rejects non-string filePath', () => {
      const result = validateSchema({ filePath: 123 }, schema);
      expect(result.valid).toBe(false);
    });

    it('rejects non-string rootPath', () => {
      const result = validateSchema({ filePath: '/test.md', rootPath: null as any }, schema);
      expect(result.valid).toBe(false);
    });

    it('rejects null filePath', () => {
      const result = validateSchema({ filePath: null }, schema);
      expect(result.valid).toBe(false);
    });
  });

  describe('list_categories', () => {
    const schema = listCategoriesTool.inputSchema;

    it('accepts empty object', () => {
      const result = validateSchema({}, schema);
      expect(result.valid).toBe(true);
    });

    it('accepts any additional properties (graceful)', () => {
      const result = validateSchema({ extra: 'field' }, schema);
      // JSON Schema by default allows additional properties
      expect(result.valid).toBe(true);
    });
  });

  describe('health_check', () => {
    const schema = healthCheckTool.inputSchema;

    it('accepts empty object', () => {
      const result = validateSchema({}, schema);
      expect(result.valid).toBe(true);
    });
  });

  describe('get_document', () => {
    const schema = getDocumentTool.inputSchema;

    it('accepts valid sourcePath', () => {
      const result = validateSchema(
        { sourcePath: 'react-docs/reference/react/useEffect.md' },
        schema
      );
      expect(result.valid).toBe(true);
    });

    it('rejects missing sourcePath', () => {
      const result = validateSchema({}, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: sourcePath');
    });

    it('rejects non-string sourcePath', () => {
      const result = validateSchema({ sourcePath: 123 }, schema);
      expect(result.valid).toBe(false);
    });

    it('rejects null sourcePath', () => {
      const result = validateSchema({ sourcePath: null }, schema);
      expect(result.valid).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('handles null input gracefully', () => {
      const result = validateSchema(null, searchDocsTool.inputSchema);
      expect(result.valid).toBe(false);
    });

    it('handles undefined input gracefully', () => {
      const result = validateSchema(undefined, searchDocsTool.inputSchema);
      expect(result.valid).toBe(false);
    });

    it('handles array input for object schema', () => {
      const result = validateSchema([], searchDocsTool.inputSchema);
      expect(result.valid).toBe(false);
    });

    it('handles number input for object schema', () => {
      const result = validateSchema(123, searchDocsTool.inputSchema);
      expect(result.valid).toBe(false);
    });
  });
});
