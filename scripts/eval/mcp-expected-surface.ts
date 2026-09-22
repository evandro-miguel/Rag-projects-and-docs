import { getPublicMcpToolName } from '../../mcp/public-surface.js';
import {
  isToolEnabledForToolset,
  type McpPermissionMode,
  type McpToolset,
  mcpToolContracts,
} from '../../mcp/tool-contracts.js';

export type McpCallerSurface = {
  permissionMode: McpPermissionMode;
  toolset: McpToolset;
  toolNames: string[];
};

function resolvePermissionMode(env: NodeJS.ProcessEnv): McpPermissionMode {
  return env.MCP_PERMISSION_MODE?.trim().toLowerCase() === 'read_write'
    ? 'read_write'
    : 'read_only';
}

function resolveToolset(env: NodeJS.ProcessEnv): McpToolset {
  const raw = (env.MCP_TOOLSET ?? env.RAG_MCP_TOOLSET ?? env.RAG_MCP_SURFACE ?? 'all')
    .trim()
    .toLowerCase();
  if (raw === 'all') return 'all';
  if (['docs', 'doc', 'documentation', 'rag-docs'].includes(raw)) return 'docs';
  if (['projects', 'project', 'rag-projects', 'project-rag'].includes(raw)) return 'projects';
  throw new Error(`INVALID_CONFIG: unsupported MCP toolset "${raw}"`);
}

export function expectedVisibleMcpToolNames(
  permissionMode: McpPermissionMode,
  toolset: McpToolset
): string[] {
  return mcpToolContracts.flatMap((contract) => {
    if (!isToolEnabledForToolset(contract.name, toolset)) return [];
    if (permissionMode === 'read_only' && contract.metadata.capability !== 'read') return [];
    const publicName = getPublicMcpToolName(contract.name);
    return publicName ? [publicName] : [];
  });
}

export function resolveMcpCallerSurface(env: NodeJS.ProcessEnv = process.env): McpCallerSurface {
  const permissionMode = resolvePermissionMode(env);
  const toolset = resolveToolset(env);
  return {
    permissionMode,
    toolset,
    toolNames: expectedVisibleMcpToolNames(permissionMode, toolset),
  };
}

export function callerCanSeeMcpTool(
  name: string,
  permissionMode: McpPermissionMode,
  toolset: McpToolset
): boolean {
  return expectedVisibleMcpToolNames(permissionMode, toolset).includes(name);
}
