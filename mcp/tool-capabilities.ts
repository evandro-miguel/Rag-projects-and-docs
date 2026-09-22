/**
 * Compatibility exports for the canonical MCP tool contract registry.
 *
 * Capability metadata is owned by `tool-contracts.ts`; this module remains a
 * stable import path for existing callers and tests.
 */
export type {
  McpCapability,
  McpPermissionMode,
  McpRiskLevel,
  McpToolset,
  McpToolsetScope,
  ToolCapabilityMetadata,
} from './tool-contracts.js';
export {
  getToolCapabilityMetadata,
  isToolEnabledForToolset,
  isWriteCapability,
  resolveMcpPermissionMode,
} from './tool-contracts.js';
