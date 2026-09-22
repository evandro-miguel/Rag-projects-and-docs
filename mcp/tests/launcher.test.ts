import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverImportMock } = vi.hoisted(() => ({
  serverImportMock: vi.fn(),
}));

vi.mock('../server.js', () => {
  serverImportMock();
  return {};
});

describe('Launcher CLI and Startup', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('starts the MCP server without Convex bootstrap, even with legacy env vars', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    process.env.PROJECT_RAG_BACKEND = 'legacy-backend';
    process.env.MCP_BACKEND_REQUIRED = 'true';
    process.env.MCP_BACKEND_AUTOSTART = 'true';

    await import('../launcher.js');

    expect(serverImportMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
