import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWatcherDeleteSourcePath,
  parseWatchProjectArgs,
  resolveWatchProjectRootPath,
  runWatchProjectCli,
} from './watch-project.js';

describe('watch-project', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PROJECT_SOURCE_PATH;
  });

  describe('parseWatchProjectArgs', () => {
    it('parses --path and --status', () => {
      expect(parseWatchProjectArgs(['--path', '/tmp/repo', '--status'])).toEqual({
        path: '/tmp/repo',
        status: true,
      });
    });

    it('parses --help aliases', () => {
      expect(parseWatchProjectArgs(['--help'])).toEqual({ help: true });
      expect(parseWatchProjectArgs(['-h'])).toEqual({ help: true });
    });
  });

  describe('resolveWatchProjectRootPath', () => {
    it('accepts explicit absolute --path', () => {
      const args = parseWatchProjectArgs(['--path', '/tmp/repo']);
      expect(resolveWatchProjectRootPath(args)).toBe('/tmp/repo');
    });

    it('rejects relative --path values', () => {
      const args = parseWatchProjectArgs(['--path', './scripts']);
      expect(() => resolveWatchProjectRootPath(args)).toThrow('absolute');
    });
  });

  describe('buildWatcherDeleteSourcePath', () => {
    it('uses ingestion-style relative sourcePath for nested file deletes', () => {
      expect(
        buildWatcherDeleteSourcePath('/home/user/my-repo', '/home/user/my-repo/src/app.ts')
      ).toBe('src/app.ts');
    });

    it('uses ingestion-style relative sourcePath for root-level file deletes', () => {
      expect(
        buildWatcherDeleteSourcePath('/home/user/my-repo', '/home/user/my-repo/README.md')
      ).toBe('README.md');
    });
  });

  describe('runWatchProjectCli', () => {
    it('reports skipped status instead of starting a watcher', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await runWatchProjectCli(['--path', '/tmp/repo', '--status']);

      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          {
            status: 'skipped',
            rootPath: '/tmp/repo',
            reason: 'watcher_removed',
          },
          null,
          2
        )
      );
    });
  });
});
