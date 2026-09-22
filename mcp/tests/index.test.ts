import { beforeEach, describe, expect, it, vi } from 'vitest';

const app = {
  use: vi.fn().mockReturnThis(),
  get: vi.fn().mockReturnThis(),
  post: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  listen: vi.fn((_port: number, _host?: string, callback?: () => void) => {
    // Support both (port, callback) and (port, host, callback) signatures
    const cb = typeof _host === 'function' ? _host : callback;
    cb?.();
    return app;
  }),
};

const streamableInstances: Array<{
  sessionId: string;
  onclose?: () => void;
  handleRequest: ReturnType<typeof vi.fn>;
}> = [];

const sseInstances: Array<{
  sessionId: string;
  onclose?: () => void;
  handlePostMessage: ReturnType<typeof vi.fn>;
}> = [];

const connectMock = vi.fn(async () => undefined);
const createRagMcpServerMock = vi.fn(() => ({
  server: {
    connect: connectMock,
  },
  toolset: 'all',
}));

vi.mock('express', () => {
  const expressMock = vi.fn(() => app);
  (expressMock as any).json = vi.fn(() => vi.fn());
  return { default: expressMock };
});

vi.mock('cors', () => ({
  default: vi.fn(() => vi.fn()),
}));

vi.mock('express-rate-limit', () => ({
  rateLimit: vi.fn(() => vi.fn()),
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class MockStreamableHTTPServerTransport {
    sessionId: string;
    onclose?: () => void;
    private initialized = false;
    private readonly onSessionInitialized?: (sessionId: string) => void;
    handleRequest = vi.fn(async () => {
      if (!this.initialized) {
        this.initialized = true;
        this.onSessionInitialized?.(this.sessionId);
      }
      return undefined;
    });

    constructor(options: { onsessioninitialized?: (sessionId: string) => void }) {
      this.sessionId = `stream-${streamableInstances.length + 1}`;
      this.onSessionInitialized = options.onsessioninitialized;
      streamableInstances.push(this);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => ({
  SSEServerTransport: class MockSSEServerTransport {
    sessionId: string;
    onclose?: () => void;
    handlePostMessage = vi.fn(async () => undefined);

    constructor(_path: string, _res: unknown) {
      this.sessionId = `sse-${sseInstances.length + 1}`;
      sseInstances.push(this);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: (value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    (value as { method?: string }).method === 'initialize',
}));

vi.mock('../../mcp/tool-registry.js', () => ({
  createRagMcpServer: createRagMcpServerMock,
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

process.env.MCP_API_KEY = 'test-key';
process.env.MCP_HTTP_ENABLED = 'true';

const mcpIndexModule = await import('../../mcp/index.js');
mcpIndexModule.startMcpHttpServer();

function getRouteHandler(
  method: 'get' | 'post' | 'delete',
  path: string
): ((req: any, res: any) => Promise<unknown>) | undefined {
  const routeRegistration = app[method].mock.calls.find((call) => call[0] === path);
  return routeRegistration?.[2];
}

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      res.body = payload;
      res.headersSent = true;
      return res;
    }),
    send: vi.fn((payload: unknown) => {
      res.body = payload;
      res.headersSent = true;
      return res;
    }),
  };
  return res;
}

describe('MCP HTTP server setup', () => {
  beforeEach(() => {
    streamableInstances.length = 0;
    sseInstances.length = 0;
    connectMock.mockClear();
    createRagMcpServerMock.mockClear();
  });

  it('registers canonical Streamable HTTP endpoint', () => {
    expect(app.post).toHaveBeenCalledWith('/mcp', expect.any(Function), expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/mcp', expect.any(Function), expect.any(Function));
    expect(app.delete).toHaveBeenCalledWith('/mcp', expect.any(Function), expect.any(Function));
  });

  it('keeps deprecated SSE endpoints routed by explicit session', () => {
    expect(app.get).toHaveBeenCalledWith('/sse', expect.any(Function), expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/messages', expect.any(Function), expect.any(Function));
  });

  it('starts on the configured default port and loopback host', () => {
    expect(app.listen).toHaveBeenCalledWith(3333, '127.0.0.1', expect.any(Function));
  });

  it('rejects non-loopback host overrides', () => {
    expect(() => mcpIndexModule.startMcpHttpServer(3333, '0.0.0.0')).toThrow(
      'MCP_HTTP_REMOTE_DISABLED'
    );
  });

  it('does not listen unless HTTP is explicitly enabled', () => {
    const previous = process.env.MCP_HTTP_ENABLED;
    process.env.MCP_HTTP_ENABLED = 'false';
    app.listen.mockClear();

    try {
      expect(mcpIndexModule.startMcpHttpServer()).toBeUndefined();
      expect(app.listen).not.toHaveBeenCalled();
    } finally {
      process.env.MCP_HTTP_ENABLED = previous;
    }
  });

  it('defaults HTTP transport to disabled when the opt-in is absent', () => {
    const previous = process.env.MCP_HTTP_ENABLED;
    delete process.env.MCP_HTTP_ENABLED;

    try {
      expect(mcpIndexModule.isMcpHttpEnabled()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_HTTP_ENABLED;
      } else {
        process.env.MCP_HTTP_ENABLED = previous;
      }
    }
  });

  it('creates a streamable session using the shared capability-aware registry', async () => {
    const postMcpHandler = getRouteHandler('post', '/mcp');
    expect(postMcpHandler).toBeTypeOf('function');

    const req = {
      headers: {},
      body: {
        method: 'initialize',
      },
    };
    const res = createMockResponse();

    await postMcpHandler?.(req, res);

    expect(createRagMcpServerMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(streamableInstances).toHaveLength(1);
    expect(streamableInstances[0]?.handleRequest).toHaveBeenCalledWith(req, res, req.body);
  });

  it('routes /mcp requests by session id without creating a new transport server', async () => {
    const postMcpHandler = getRouteHandler('post', '/mcp');
    expect(postMcpHandler).toBeTypeOf('function');

    const initReq = { headers: {}, body: { method: 'initialize' } };
    const initRes = createMockResponse();
    await postMcpHandler?.(initReq, initRes);

    const existingSessionId = streamableInstances[0]?.sessionId;
    expect(existingSessionId).toBeTruthy();

    const serverCreateCount = createRagMcpServerMock.mock.calls.length;
    const handleRequestCallsBeforeFollowup = streamableInstances.reduce(
      (total, instance) => total + instance.handleRequest.mock.calls.length,
      0
    );
    const followupReq = {
      headers: { 'mcp-session-id': existingSessionId },
      body: { method: 'tools/list' },
    };
    const followupRes = createMockResponse();

    await postMcpHandler?.(followupReq, followupRes);

    const handleRequestCallsAfterFollowup = streamableInstances.reduce(
      (total, instance) => total + instance.handleRequest.mock.calls.length,
      0
    );

    expect(createRagMcpServerMock.mock.calls.length).toBe(serverCreateCount);
    expect(handleRequestCallsAfterFollowup).toBe(handleRequestCallsBeforeFollowup + 1);
  });

  it('returns 404 for unknown streamable session ids', async () => {
    const postMcpHandler = getRouteHandler('post', '/mcp');
    expect(postMcpHandler).toBeTypeOf('function');

    const req = {
      headers: { 'mcp-session-id': 'missing-session' },
      body: { method: 'tools/list' },
    };
    const res = createMockResponse();
    await postMcpHandler?.(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toMatchObject({
      error: {
        message: 'Session not found',
      },
    });
  });

  it('routes deprecated /messages by explicit SSE session id', async () => {
    const sseHandler = getRouteHandler('get', '/sse');
    const messagesHandler = getRouteHandler('post', '/messages');
    expect(sseHandler).toBeTypeOf('function');
    expect(messagesHandler).toBeTypeOf('function');

    await sseHandler?.({ headers: {} }, createMockResponse());
    await sseHandler?.({ headers: {} }, createMockResponse());
    expect(sseInstances).toHaveLength(2);

    const req = {
      headers: {},
      query: { sessionId: sseInstances[1]?.sessionId },
      body: { method: 'tools/list' },
    };
    const res = createMockResponse();
    await messagesHandler?.(req, res);

    expect(sseInstances[0]?.handlePostMessage).not.toHaveBeenCalled();
    expect(sseInstances[1]?.handlePostMessage).toHaveBeenCalledTimes(1);
  });
});
