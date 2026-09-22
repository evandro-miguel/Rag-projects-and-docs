import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('project-watcher-manager', () => {
  let tempRoot = '';
  let projectRoot = '';

  beforeEach(() => {
    tempRoot = mkdtempSync(resolve(tmpdir(), 'rag-project-watcher-'));
    projectRoot = resolve(tempRoot, 'external-project');
    mkdirSync(projectRoot, { recursive: true });
    process.env.RAG_PROJECT_WATCHER_ENABLED = 'true';
    delete process.env.VITEST;
    delete process.env.RAG_PROJECT_WATCHER_FORCE_AUTOSTART;
  });

  afterEach(() => {
    delete process.env.RAG_PROJECT_WATCHER_ENABLED;
    delete process.env.RAG_PROJECT_WATCHER_FORCE_AUTOSTART;
    delete process.env.VITEST;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('skips watcher for read-only/search session intent', async () => {
    const { ensureProjectWatcher } = await import('../project-watcher-manager.js');
    const status = await ensureProjectWatcher({
      rootPath: projectRoot,
      slug: 'external-project',
      sessionIntent: 'read_only',
    });

    expect(status).toMatchObject({
      status: 'skipped',
      rootPath: projectRoot,
      slug: 'external-project',
      reason: 'watcher_edit_session_required',
    });
  });

  it('skips watcher for edit sessions because the live watcher was removed', async () => {
    const { ensureProjectWatcher } = await import('../project-watcher-manager.js');
    const status = await ensureProjectWatcher({
      rootPath: projectRoot,
      slug: 'external-project',
      sessionIntent: 'edit_session',
    });

    expect(status).toMatchObject({
      status: 'skipped',
      rootPath: projectRoot,
      slug: 'external-project',
      reason: 'watcher_removed',
    });
  });

  it('skips watcher when explicitly disabled by env', async () => {
    process.env.RAG_PROJECT_WATCHER_ENABLED = 'false';

    const { ensureProjectWatcher } = await import('../project-watcher-manager.js');
    const status = await ensureProjectWatcher({
      rootPath: projectRoot,
      slug: 'external-project',
      sessionIntent: 'edit_session',
    });

    expect(status).toMatchObject({
      status: 'skipped',
      rootPath: projectRoot,
      slug: 'external-project',
      reason: 'watcher_disabled_by_env',
    });
  });

  it('skips watcher when the root path is missing', async () => {
    const { ensureProjectWatcher } = await import('../project-watcher-manager.js');
    const status = await ensureProjectWatcher({
      rootPath: resolve(tempRoot, 'missing-project'),
      slug: 'missing-project',
      sessionIntent: 'edit_session',
    });

    expect(status).toMatchObject({
      status: 'skipped',
      reason: 'watcher_root_missing',
    });
  });

  it('stopSessionOwnedProjectWatchers is a no-op', async () => {
    const manager = await import('../project-watcher-manager.js');

    expect(() => manager.stopSessionOwnedProjectWatchers()).not.toThrow();
  });
});
