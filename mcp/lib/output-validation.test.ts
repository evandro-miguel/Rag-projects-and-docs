import { describe, expect, it } from 'vitest';
import { getProjectFileTool, searchProjectCodeOutputSchema } from '../project-tools.js';
import { getMcpToolContract } from '../tool-contracts.js';
import { searchProjectDocsTool } from '../tools.js';
import {
  McpOutputValidationError,
  validateMcpToolResult,
  validateStructuredOutput,
} from './output-validation.js';

const ok = (structuredContent: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: 'ok' }],
  structuredContent,
});

describe('MCP output validation', () => {
  it('accepts bounded success and error envelopes', () => {
    expect(validateMcpToolResult('search_project_code', ok({ success: true, data: {} }))).toEqual(
      expect.objectContaining({ structuredContent: { success: true, data: {} } })
    );
    expect(
      validateMcpToolResult('search_project_code', {
        ...ok({ success: false, error: { code: 'NOT_FOUND', message: 'missing' } }),
        isError: true,
      })
    ).toEqual(expect.objectContaining({ isError: true }));
  });

  it('rejects malformed line ranges and oversized pagination', () => {
    expect(() =>
      validateStructuredOutput('get_project_file', {
        success: true,
        data: { startLine: 8, endLine: 2 },
      })
    ).toThrow(McpOutputValidationError);
    expect(() =>
      validateStructuredOutput('search_project_code', {
        success: true,
        data: { nextCursor: 'x'.repeat(257) },
      })
    ).toThrow('cursor length');
  });

  it('rejects unbounded arrays and response payloads', () => {
    expect(() =>
      validateStructuredOutput('search_project_code', {
        success: true,
        data: { results: Array.from({ length: 101 }, () => ({ sourcePath: 'x' })) },
      })
    ).toThrow('more than 100 items');
    expect(() =>
      validateMcpToolResult(
        'get_project_file',
        ok({
          success: true,
          data: Object.fromEntries(
            Array.from({ length: 6 }, (_, index) => [`part${index}`, 'x'.repeat(180_000)])
          ),
        })
      )
    ).toThrow('response limit');
  });

  it('validates the declared output schema when present', () => {
    const schema = {
      type: 'object' as const,
      properties: { success: { type: 'boolean' } },
      required: ['success'],
    };
    expect(() => validateStructuredOutput('verify_project_index', {}, schema)).toThrow(
      'is required'
    );
    expect(validateStructuredOutput('verify_project_index', { success: true }, schema)).toEqual({
      success: true,
    });
  });

  it('accepts safe error codes with diagnostic data instead of success payload data', () => {
    const outputSchema = getMcpToolContract('verify_project_index').outputSchema;
    const result = validateMcpToolResult(
      'verify_project_index',
      ok({
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
      }),
      outputSchema
    );

    expect(result.structuredContent).toMatchObject({
      success: false,
      error: { code: 'SCHEMA_NOT_READY' },
      data: {
        failureCode: 'VERIFY_PROJECT_INDEX_INTERNAL_ERROR',
        phase: 'verify_project_index',
      },
    });

    expect(() =>
      validateMcpToolResult(
        'verify_project_index',
        ok({
          success: false,
          error: {
            code: 42,
            message: 'Project RAG schema is missing migration 004',
            timestamp: '2026-08-31T00:00:00.000Z',
          },
          data: { phase: 'verify_project_index' },
        }),
        outputSchema
      )
    ).toThrow('does not match any output variant');

    expect(() =>
      validateMcpToolResult(
        'verify_project_index',
        ok({
          success: false,
          error: {
            code: 'SCHEMA_NOT_READY',
            message: 'Project RAG schema is missing migration 004',
          },
        }),
        outputSchema
      )
    ).toThrow('does not match any output variant');
  });

  it('omits undefined optional fields for canonical, alias, and file outputs', () => {
    const searchStructuredContent = {
      success: true,
      data: {
        results: [
          {
            sourcePath: 'src/a.ts',
            startLine: undefined,
            endLine: undefined,
            content: 'const value = 1;',
            score: 0.5,
            symbolName: undefined,
            symbolKind: undefined,
          },
        ],
        query: 'value',
        mode: 'hybrid',
        requestedMode: 'hybrid',
        fallbackUsed: undefined,
      },
    };

    for (const [toolName, outputSchema] of [
      ['search_project_code', searchProjectCodeOutputSchema],
      ['search_project_docs', searchProjectDocsTool.outputSchema],
    ] as const) {
      const result = validateMcpToolResult(toolName, ok(searchStructuredContent), outputSchema);

      expect(result.structuredContent).toEqual({
        success: true,
        data: {
          results: [
            {
              sourcePath: 'src/a.ts',
              content: 'const value = 1;',
              score: 0.5,
            },
          ],
          query: 'value',
          mode: 'hybrid',
          requestedMode: 'hybrid',
        },
      });
    }

    const fileResult = validateMcpToolResult(
      'get_project_file',
      ok({
        success: true,
        data: {
          file: {
            sourcePath: 'src/a.ts',
            status: 'indexed',
            lang: undefined,
            sizeBytes: 16,
            fileModifiedAt: 0,
            freshness: {
              status: 'fresh',
              checkedAt: '2026-08-23T00:00:00.000Z',
              reason: undefined,
            },
          },
          chunks: [
            {
              chunkIndex: 0,
              content: 'const value = 1;',
              startLine: undefined,
              endLine: undefined,
              symbolName: undefined,
              symbolKind: undefined,
            },
          ],
        },
      }),
      getProjectFileTool.outputSchema
    );

    expect(fileResult.structuredContent).toEqual({
      success: true,
      data: {
        file: {
          sourcePath: 'src/a.ts',
          status: 'indexed',
          sizeBytes: 16,
          fileModifiedAt: 0,
          freshness: {
            status: 'fresh',
            checkedAt: '2026-08-23T00:00:00.000Z',
          },
        },
        chunks: [{ chunkIndex: 0, content: 'const value = 1;' }],
      },
    });
  });

  it('preserves null and maps undefined array entries to JSON null', () => {
    expect(
      validateStructuredOutput('search_project_code', {
        success: true,
        data: {
          explicitNull: null,
          omitted: undefined,
          values: [undefined, null],
        },
      })
    ).toEqual({
      success: true,
      data: {
        explicitNull: null,
        values: [null, null],
      },
    });
  });

  it('requires structured content for protocol error results', () => {
    expect(() =>
      validateMcpToolResult('health_check', {
        content: [{ type: 'text' as const, text: 'failed' }],
        isError: true,
      })
    ).toThrow('structuredContent');
  });
});
