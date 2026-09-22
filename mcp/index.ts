/**
 * HTTP MCP server.
 *
 * `/mcp` is the canonical Streamable HTTP endpoint. `/sse` and `/messages`
 * remain as deprecated compatibility endpoints, but they use the same
 * transport-neutral tool registry as STDIO and route by session ID.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import dotenv from 'dotenv';
import type { Express } from 'express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { logger } from '../lib/logger.js';
import { createRagMcpServer } from './tool-registry.js';

function secureCompare(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function createAuthMiddleware(apiKey: string, allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !secureCompare(authHeader, `Bearer ${apiKey}`)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
  };
}

async function createConnectedStreamableTransport(
  streamableTransports: Map<string, StreamableHTTPServerTransport>
) {
  let transport!: StreamableHTTPServerTransport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      streamableTransports.set(sessionId, transport);
    },
  });

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) {
      streamableTransports.delete(sessionId);
    }
  };

  const { server } = createRagMcpServer();
  await server.connect(transport);
  return transport;
}

async function createConnectedSseTransport(
  res: Response,
  sseTransports: Map<string, SSEServerTransport>,
  allowedOrigins: string[]
) {
  const transport = new SSEServerTransport('/messages', res, {
    allowedOrigins,
    enableDnsRebindingProtection: true,
  });
  sseTransports.set(transport.sessionId, transport);
  transport.onclose = () => {
    sseTransports.delete(transport.sessionId);
  };

  const { server } = createRagMcpServer();
  await server.connect(transport);
  return transport;
}

interface HttpMcpAppOptions {
  apiKey: string;
  allowedOrigins: string[];
}

export function createMcpHttpApp({ apiKey, allowedOrigins }: HttpMcpAppOptions): Express {
  const app = express();
  const authMiddleware = createAuthMiddleware(apiKey, allowedOrigins);
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  const sseTransports = new Map<string, SSEServerTransport>();

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      exposedHeaders: ['Mcp-Session-Id'],
    })
  );
  app.use(express.json({ limit: '4mb' }));
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 1000,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.post('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const sessionId = headerValue(req.headers['mcp-session-id']);

    try {
      if (sessionId) {
        const transport = streamableTransports.get(sessionId);
        if (!transport) {
          return res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session not found' },
            id: null,
          });
        }
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
          id: null,
        });
      }

      const transport = await createConnectedStreamableTransport(streamableTransports);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error(
        { operation: 'mcp' },
        'Error handling Streamable HTTP request',
        error instanceof Error ? error : new Error(String(error))
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const sessionId = headerValue(req.headers['mcp-session-id']);
    const transport = sessionId ? streamableTransports.get(sessionId) : undefined;
    if (!transport) {
      return res.status(400).send('Invalid or missing Mcp-Session-Id');
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const sessionId = headerValue(req.headers['mcp-session-id']);
    const transport = sessionId ? streamableTransports.get(sessionId) : undefined;
    if (!transport) {
      return res.status(400).send('Invalid or missing Mcp-Session-Id');
    }
    await transport.handleRequest(req, res);
  });

  app.get('/sse', authMiddleware, async (_req: Request, res: Response) => {
    try {
      await createConnectedSseTransport(res, sseTransports, allowedOrigins);
    } catch (error) {
      logger.error(
        { operation: 'mcp' },
        'Error handling deprecated SSE setup',
        error instanceof Error ? error : new Error(String(error))
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.post('/messages', authMiddleware, async (req: Request, res: Response) => {
    const sessionId =
      typeof req.query.sessionId === 'string'
        ? req.query.sessionId
        : headerValue(req.headers['mcp-session-id']);
    const transport = sessionId ? sseTransports.get(sessionId) : undefined;

    if (!transport) {
      return res.status(400).json({ error: 'No SSE connection established for session' });
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      logger.error(
        { operation: 'mcp' },
        'Error handling deprecated SSE message endpoint',
        error instanceof Error ? error : new Error(String(error))
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  return app;
}

dotenv.config({ path: '.env.local' });

const PORT = Number(process.env.MCP_PORT || 3333);
const HOST = process.env.MCP_HOST || '127.0.0.1';
const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS
  ? process.env.MCP_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  : ['http://localhost:3333', 'http://127.0.0.1:3333'];

export function isMcpHttpEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.MCP_HTTP_ENABLED ?? '').trim().toLowerCase()
  );
}

export function isLoopbackMcpHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function startMcpHttpServer(port = PORT, host = HOST): Express | undefined {
  if (!isMcpHttpEnabled()) return undefined;
  if (!isLoopbackMcpHost(host)) {
    throw new Error(
      `MCP_HTTP_REMOTE_DISABLED: HTTP transport is experimental and loopback-only (received ${host})`
    );
  }

  const apiKey = process.env.MCP_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'MCP_API_KEY is required when MCP_HTTP_ENABLED is true; set a non-default Bearer credential.'
    );
  }

  const app = createMcpHttpApp({ apiKey, allowedOrigins });
  app.listen(port, host, () => {
    logger.info(
      { operation: 'mcp', port, host, streamableEndpoint: '/mcp' },
      'MCP HTTP server started'
    );
  });
  return app;
}

if (import.meta.main) {
  startMcpHttpServer();
}
