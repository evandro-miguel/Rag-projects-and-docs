import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type McpToolSurfaceStatus = 'supported' | 'experimental' | 'deprecated' | 'internal';

const INTERNAL_TOOL_NAMES = new Set([
  'get_code_metrics',
  'search_inventory',
  'get_dead_code_report',
]);

const DEPRECATED_TOOL_NAMES = new Set(['search_project_docs', 'get_feature_hubs']);

const EXPERIMENTAL_TOOL_NAMES = new Set([
  'get_semantic_clusters',
  'get_feature_hubs',
  'get_navigation_paths',
  'get_topic_groups',
]);

const PUBLIC_TOOL_RENAMES = {
  get_feature_hubs: 'get_directory_groups',
} as const;

/** Resolve a discoverable name to the existing contract/handler name. */
export function resolveMcpContractToolName(toolName: string): string | undefined {
  if (INTERNAL_TOOL_NAMES.has(toolName)) return undefined;
  if (toolName === 'get_directory_groups') return 'get_feature_hubs';
  return toolName;
}

/** Return the name advertised by the public MCP tools/list surface. */
export function getPublicMcpToolName(toolName: string): string | undefined {
  if (INTERNAL_TOOL_NAMES.has(toolName)) return undefined;
  return PUBLIC_TOOL_RENAMES[toolName as keyof typeof PUBLIC_TOOL_RENAMES] ?? toolName;
}

export function isPublicMcpTool(toolName: string): boolean {
  return getPublicMcpToolName(toolName) !== undefined;
}

export function getMcpToolSurfaceStatus(toolName: string): McpToolSurfaceStatus {
  if (INTERNAL_TOOL_NAMES.has(toolName)) return 'internal';
  if (toolName === 'get_directory_groups') return 'experimental';
  if (DEPRECATED_TOOL_NAMES.has(toolName)) return 'deprecated';
  if (EXPERIMENTAL_TOOL_NAMES.has(toolName)) return 'experimental';
  return 'supported';
}

/** Rename compatibility definitions without duplicating schemas or handlers. */
export function toPublicMcpTool(tool: Tool): Tool | undefined {
  const name = getPublicMcpToolName(tool.name);
  if (!name) return undefined;
  return name === tool.name ? tool : { ...tool, name };
}

export const internalMcpToolNames = [...INTERNAL_TOOL_NAMES] as const;
