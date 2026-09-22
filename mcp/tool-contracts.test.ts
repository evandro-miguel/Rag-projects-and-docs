import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateMcpToolResult } from './lib/output-validation.js';
import {
  allRegisteredTools,
  getMcpToolContract,
  getToolCapabilityMetadata,
  isToolEnabledForToolset,
  mcpToolContracts,
  resolveMcpToolset,
} from './tool-contracts.js';

describe('MCP tool contracts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('owns one complete contract for every registered tool, including internal helpers', () => {
    expect(mcpToolContracts).toHaveLength(26);
    expect(new Set(mcpToolContracts.map((contract) => contract.name)).size).toBe(26);
    expect(allRegisteredTools.map((tool) => tool.name)).toEqual(
      mcpToolContracts.map((contract) => contract.name)
    );

    for (const contract of mcpToolContracts) {
      expect(contract.tool.outputSchema).toBeDefined();
      expect(contract.annotations.readOnlyHint).toBeDefined();
      expect(contract.metadata.toolName).toBe(contract.name);
      expect(contract.deadline.kind).toBeDefined();
      if (contract.metadata.capability === 'read') {
        expect(contract.deadline.kind).toBe('read');
        expect(contract.deadline.timeoutMs).toBeGreaterThan(0);
      } else {
        expect(contract.deadline.kind).toBe('none');
      }
    }
  });

  it('keeps capability metadata fail-closed for unknown tools', () => {
    expect(() => getMcpToolContract('retired_tool')).toThrow('MCP_TOOL_METADATA_MISSING');
    expect(() => getToolCapabilityMetadata('retired_tool')).toThrow('MCP_TOOL_METADATA_MISSING');
    expect(isToolEnabledForToolset('retired_tool', 'all')).toBe(false);
  });

  it('isolates docs and project toolsets from the same contract source', () => {
    expect(isToolEnabledForToolset('search_docs', 'docs')).toBe(true);
    expect(isToolEnabledForToolset('search_docs', 'projects')).toBe(false);
    expect(isToolEnabledForToolset('search_project_code', 'projects')).toBe(true);
    expect(isToolEnabledForToolset('search_project_code', 'docs')).toBe(false);
  });

  it('exposes prepare as an idempotent write without an interactive acknowledgement', () => {
    const contract = getMcpToolContract('prepare_project');
    expect(contract.metadata.capability).toBe('write');
    expect(contract.metadata.requiresAck).toBe(false);
    expect(contract.tool.annotations).toMatchObject({
      idempotentHint: true,
      destructiveHint: false,
    });
  });

  it('declares and validates the structured health result returned by the handler', () => {
    const contract = getMcpToolContract('health_check');
    const outputVariants = contract.outputSchema.anyOf as Array<{ required?: string[] }>;
    expect(outputVariants[0]?.required).toEqual(['success', 'data']);

    expect(
      validateMcpToolResult(
        'health_check',
        {
          content: [{ type: 'text', text: '# Health Check Results' }],
          structuredContent: {
            success: false,
            data: {
              components: [
                { component: 'MCP Server', status: 'OK', latencyMs: 0 },
                { component: 'Docs RAG Postgres', status: 'ERROR', details: 'unavailable' },
              ],
            },
          },
          isError: true,
        },
        contract.outputSchema
      )
    ).toMatchObject({ isError: true });
  });

  it('rejects an unsupported configured toolset instead of widening to all', () => {
    vi.stubEnv('MCP_TOOLSET', 'everything');
    expect(() => resolveMcpToolset()).toThrow('INVALID_CONFIG');
  });
});
