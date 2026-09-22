/**
 * Canonical STDIO MCP server for the RAG-v2 knowledge base.
 *
 * Tool registration, validation, and dispatch are centralized in
 * `mcp/tool-registry.ts` so STDIO and HTTP transports expose the same contract.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../lib/logger.js';
import { createRagMcpServer } from './tool-registry.js';

async function main() {
  const { server, toolset } = createRagMcpServer({ stdioSafe: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ operation: 'mcp', mcpToolset: toolset }, 'MCP server connected');
}

main().catch((error) => {
  logger.error(
    { operation: 'mcp' },
    'Fatal error in MCP server',
    error instanceof Error ? error : new Error(String(error))
  );
  process.exit(1);
});
