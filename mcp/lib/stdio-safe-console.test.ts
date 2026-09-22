import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithStdioSafeConsole } from './stdio-safe-console.js';

describe('runWithStdioSafeConsole', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects console.log/info/debug to stderr while the operation runs', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as never);

    await runWithStdioSafeConsole(async () => {
      console.log('log message');
      console.info('info message');
      console.debug('debug message');
    });

    const lines = stderrSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('log message'))).toBe(true);
    expect(lines.some((line) => line.includes('info message'))).toBe(true);
    expect(lines.some((line) => line.includes('debug message'))).toBe(true);
  });

  it('restores the original console methods after completion', async () => {
    const originalLog = console.log;

    await runWithStdioSafeConsole(async () => {
      expect(console.log).not.toBe(originalLog);
    });

    expect(console.log).toBe(originalLog);
  });

  it('keeps protocol output off stdout while redirected console methods run', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as never);

    await runWithStdioSafeConsole(async () => {
      console.log('stdio-safe');
    });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('restores original console methods after an error', async () => {
    const originalLog = console.log;

    await expect(
      runWithStdioSafeConsole(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(console.log).toBe(originalLog);
  });
});
