/**
 * @module sync-external-docs.clone.test
 * @description Contract tests for `cloneRepo` monorepo (docsPath) cloning:
 * the fetch must be a blobless depth-1 fetch, sparse-checkout must be
 * configured BEFORE checkout (otherwise checkout lazily fetches every blob in
 * the repository), and checkout must consume FETCH_HEAD.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloneRepo } from '../../sync-external-docs.js';

describe('cloneRepo monorepo (docsPath) fetch contract', () => {
  let testDir: string | undefined;

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
    vi.clearAllMocks();
  });

  it('uses blobless depth-1 fetch so sparse checkout pulls only docsPath blobs', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'sync-clone-test-'));
    const sourceRootDir = join(testDir, 'source-root');
    const tmpCloneDir = join(testDir, 'rag-sync-python-docs-123');

    const runGit = vi.fn((args: readonly string[], options: { cwd: string }) => {
      // Simulate checkout materializing docsPath inside the temp clone.
      if (args[0] === 'checkout') {
        mkdirSync(join(options.cwd, 'Doc'), { recursive: true });
      }
    });

    await cloneRepo(
      {
        name: 'python-docs',
        url: 'https://github.com/python/cpython.git',
        branch: 'main',
        docsPath: 'Doc',
        category: 'python',
        fileExtensions: ['rst'],
      },
      {
        runGit,
        tempRootDir: testDir,
        sourceRootDir,
        now: () => 123,
      }
    );

    const calls = runGit.mock.calls.map((call) => call[0]);

    // Regression guard: without --filter=blob:none this fetch downloads every
    // blob in the repo (~250MB for cpython) just to read Doc/*.rst. Assert the
    // exact argv so no argument can silently regress.
    expect(runGit).toHaveBeenCalledWith(
      ['fetch', '--depth', '1', '--filter=blob:none', 'origin', 'main'],
      expect.objectContaining({ cwd: tmpCloneDir })
    );

    const sparseInitIndex = calls.findIndex(
      (args) => args.join(' ') === 'sparse-checkout init --cone'
    );
    const sparseSet = calls.find((args) => args.slice(0, 2).join(' ') === 'sparse-checkout set');
    const checkoutIndex = calls.findIndex((args) => args[0] === 'checkout');
    expect(sparseInitIndex).toBeGreaterThanOrEqual(0);
    expect(sparseSet?.slice(2)).toContain('Doc');

    // Ordering guard: sparse-checkout set MUST precede checkout, otherwise
    // checkout runs unconed and lazily retrieves ALL repo blobs anyway,
    // defeating the --filter=blob:none budget win.
    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(
      calls.findIndex((args) => args.slice(0, 2).join(' ') === 'sparse-checkout set')
    ).toBeLessThan(checkoutIndex);

    // Checkout consumes FETCH_HEAD produced by the filtered fetch.
    expect(calls[checkoutIndex][1]).toBe('FETCH_HEAD');
  });
});
