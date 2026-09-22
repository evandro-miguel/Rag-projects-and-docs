import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { McpOutputValidationError, validateMcpToolResult } from './lib/output-validation.js';
import { checkRateLimitOrThrow, RateLimitExceededError } from './lib/rate-limiter.js';
import { runWithStdioSafeConsole } from './lib/stdio-safe-console.js';
import { ReadDeadlineError, withReadDeadline } from './lib/timeout.js';
import { isPublicMcpTool, resolveMcpContractToolName, toPublicMcpTool } from './public-surface.js';
import {
  allRegisteredTools,
  getMcpToolContract,
  isToolEnabledForToolset,
  isWriteCapability,
  mcpToolContracts,
  resolveMcpPermissionMode,
  resolveMcpToolset,
} from './tool-contracts.js';

export type { McpToolset } from './tool-contracts.js';
export {
  allRegisteredTools,
  BlockedFindingAllowlistEntrySchema,
  mcpToolContracts,
  RegisterProjectSchema,
  resolveMcpToolset,
} from './tool-contracts.js';

const registeredToolNames = new Set(allRegisteredTools.map((tool) => tool.name));

export function isToolEnabled(toolName: string, toolset = resolveMcpToolset()): boolean {
  const contractName = resolveMcpContractToolName(toolName);
  return Boolean(
    contractName &&
      registeredToolNames.has(contractName) &&
      isToolEnabledForToolset(contractName, toolset)
  );
}

export function getVisibleMcpTools(toolset = resolveMcpToolset()): Tool[] {
  const permissionMode = resolveMcpPermissionMode();
  return mcpToolContracts
    .filter((contract) => isPublicMcpTool(contract.name))
    .filter((contract) => isToolEnabled(contract.name, toolset))
    .filter(
      (contract) =>
        permissionMode !== 'read_only' || !isWriteCapability(contract.metadata.capability)
    )
    .map((contract) => toPublicMcpTool(contract.tool))
    .filter((tool): tool is Tool => tool !== undefined);
}

export async function dispatchMcpToolCall(
  name: string,
  args: unknown,
  toolset = resolveMcpToolset()
) {
  if (!isToolEnabled(name, toolset)) {
    throw new Error(`TOOL_NOT_ENABLED: ${name} is disabled for MCP toolset "${toolset}"`);
  }

  const contractName = resolveMcpContractToolName(name);
  if (!contractName) {
    throw new Error(`TOOL_NOT_ENABLED: ${name} is disabled for MCP toolset "${toolset}"`);
  }
  const contract = getMcpToolContract(contractName);
  const permissionMode = resolveMcpPermissionMode();
  if (permissionMode === 'read_only' && isWriteCapability(contract.metadata.capability)) {
    throw new Error(`PERMISSION_DENIED: ${name} requires write capability`);
  }

  // MCP omits `arguments` for no-argument tools; validate those as an empty
  // object while still rejecting missing required fields on other tools.
  const validatedArgs = contract.inputSchema.parse(args ?? {});
  if (contract.rateLimit) {
    checkRateLimitOrThrow(contract.rateLimit.limiter, contract.rateLimit.key);
  }

  const result =
    contract.deadline.kind === 'read'
      ? await withReadDeadline(
          (signal) => contract.dispatch(validatedArgs, signal),
          contract.deadline.timeoutMs ?? 30_000,
          name
        )
      : await contract.dispatch(validatedArgs);

  return validateMcpToolResult(name, result, contract.outputSchema);
}

export function formatToolCallError(error: unknown) {
  let message = 'Unknown error occurred';
  let errorCode = 'INTERNAL_ERROR';
  let extraFields: Record<string, unknown> = {};

  if (error instanceof z.ZodError) {
    message = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    errorCode = 'VALIDATION_ERROR';
  } else if (error instanceof ReadDeadlineError) {
    message = error.message;
    errorCode = error.code;
  } else if (error instanceof RateLimitExceededError) {
    message = error.message;
    errorCode = error.code;
    extraFields = { retryAfter: error.retryAfter };
  } else if (error instanceof McpOutputValidationError) {
    message = error.message;
    errorCode = error.code;
  } else if (error instanceof Error) {
    message = error.message;
    if (message.startsWith('TOOL_NOT_ENABLED:')) {
      errorCode = 'TOOL_NOT_ENABLED';
    } else if (message.startsWith('PERMISSION_DENIED:')) {
      errorCode = 'PERMISSION_DENIED';
    } else if (message.startsWith('INVALID_CONFIG:')) {
      errorCode = 'INVALID_CONFIG';
    } else if (message.startsWith('MCP_TOOL_METADATA_MISSING:')) {
      errorCode = 'MCP_TOOL_METADATA_MISSING';
    }
  }

  const errorOutput = {
    success: false,
    error: {
      code: errorCode,
      message,
      retryAfter: extraFields.retryAfter,
      timestamp: new Date().toISOString(),
    },
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(errorOutput, null, 2) }],
    structuredContent: errorOutput,
    isError: true,
  };
}

export function createRagMcpServer(options: { stdioSafe?: boolean } = {}) {
  const toolset = resolveMcpToolset();
  const server = new Server(
    {
      name: 'rag-v2-docs-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getVisibleMcpTools(toolset),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const dispatch = () => dispatchMcpToolCall(name, args, toolset);
      return options.stdioSafe ? await runWithStdioSafeConsole(dispatch) : await dispatch();
    } catch (error) {
      return formatToolCallError(error);
    }
  });

  return { server, toolset };
}
