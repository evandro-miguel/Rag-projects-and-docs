import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCorpusPath,
  listProjectRagWorkspaceTrackedFiles,
  type ProjectRagGitRunner,
  type ProjectRagStatusEntry,
  parseProjectRagPorcelainStatusZ,
  resolveProjectRagWorkspaceContext,
} from './context.js';

const encoder = new TextEncoder();

function runnerFor(
  outputs: ReadonlyMap<string, { readonly code?: number; readonly stdout?: string }>
): ProjectRagGitRunner {
  return async (_cwd, args) => {
    const result = outputs.get(args.join(' ')) ?? {};
    return {
      exitCode: result.code ?? 0,
      stdout: encoder.encode(result.stdout ?? ''),
      stderr: encoder.encode(''),
    };
  };
}

/** Run a git command in a fixture, failing loudly on non-zero exit. */
function git(dir: string, args: readonly string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Project RAG Test',
      '-c',
      'user.email=project-rag@example.invalid',
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    { stdio: 'pipe' }
  );
}

function initFixture(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', dir], {
    stdio: 'pipe',
  });
  return dir;
}

describe('resolveProjectRagWorkspaceContext (mocked runner)', () => {
  const root = realpathSync.native(resolve('.'));

  it('supports a detached, no-remote workspace and digests untracked root files', async () => {
    const context = await resolveProjectRagWorkspaceContext(
      root,
      runnerFor(
        new Map([
          ['rev-parse --show-toplevel', { stdout: root }],
          ['rev-parse --git-common-dir', { stdout: '.git' }],
          ['rev-parse --git-dir', { stdout: '.git' }],
          ['rev-parse --verify HEAD', { stdout: 'a'.repeat(40) }],
          ['symbolic-ref --quiet --short HEAD', { code: 1 }],
          ['status --porcelain=v1 -z --untracked-files=all', { stdout: '?? root-file.ts\0' }],
          ['remote get-url origin', { code: 2 }],
        ])
      )
    );

    expect(context.workspaceRoot).toBe(root);
    expect(context.repositoryCommonDir).toBe(realpathSync.native(resolve(root, '.git')));
    expect(context.worktreeGitDir).toBe(realpathSync.native(resolve(root, '.git')));
    expect(context.remoteUrl).toBeNull();
    expect(context.headOid).toBe('a'.repeat(40));
    expect(context.branchName).toBeNull();
    expect(context.isDetached).toBe(true);
    expect(context.isUnborn).toBe(false);
    expect(context.dirtyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(context.statusDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(context.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(context.identityDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('supports an unborn repository with a branch and no HEAD OID', async () => {
    const context = await resolveProjectRagWorkspaceContext(
      root,
      runnerFor(
        new Map([
          ['rev-parse --show-toplevel', { stdout: root }],
          ['rev-parse --git-common-dir', { stdout: '.git' }],
          ['rev-parse --git-dir', { stdout: '.git' }],
          ['rev-parse --verify HEAD', { code: 128 }],
          ['symbolic-ref --quiet --short HEAD', { stdout: 'main' }],
          ['status --porcelain=v1 -z --untracked-files=all', { stdout: '' }],
          ['remote get-url origin', { code: 2 }],
        ])
      )
    );

    expect(context.headOid).toBeNull();
    expect(context.branchName).toBe('main');
    expect(context.isDetached).toBe(false);
    expect(context.isUnborn).toBe(true);
  });

  it('throws loudly on malformed porcelain entries instead of degrading the digest', async () => {
    await expect(
      resolveProjectRagWorkspaceContext(
        root,
        runnerFor(
          new Map([
            ['rev-parse --show-toplevel', { stdout: root }],
            ['rev-parse --git-common-dir', { stdout: '.git' }],
            ['rev-parse --git-dir', { stdout: '.git' }],
            ['rev-parse --verify HEAD', { stdout: 'a'.repeat(40) }],
            ['symbolic-ref --quiet --short HEAD', { code: 1 }],
            ['status --porcelain=v1 -z --untracked-files=all', { stdout: 'garbage\0' }],
            ['remote get-url origin', { code: 2 }],
          ])
        )
      )
    ).rejects.toThrow('Malformed git status porcelain entry');
  });
});

describe('parseProjectRagPorcelainStatusZ', () => {
  it('keeps nested ingest source folders eligible while rejecting the root ingest corpus', () => {
    expect(isCorpusPath('ingest/prompt.md')).toBe(false);
    expect(isCorpusPath('ingest/worker.ts', { includeRoots: ['ingest'] })).toBe(true);
    expect(isCorpusPath('lib/ingest/parser.ts')).toBe(true);
    expect(isCorpusPath('scripts/ingest/parser.ts')).toBe(true);
  });

  it('projects status paths into a nested registered root', () => {
    const entries = parseProjectRagPorcelainStatusZ(
      encoder.encode(
        ' M packages/app/src/a.ts\0 M packages/other/src/b.ts\0R  packages/app/src/new.ts\0packages/app/src/old.ts\0'
      ),
      { pathPrefix: 'packages/app' }
    );

    expect(entries).toEqual([
      { x: ' ', y: 'M', path: 'src/a.ts', origPath: null },
      { x: 'R', y: ' ', path: 'src/new.ts', origPath: 'src/old.ts' },
    ]);
  });

  it('parses plain and untracked entries', () => {
    const entries = parseProjectRagPorcelainStatusZ(encoder.encode(' M src/a.ts\0?? notes.md\0'));
    // Canonical output is byte-sorted by path: 'n' < 's'.
    expect(entries.map((entry) => ({ x: entry.x, y: entry.y, path: entry.path }))).toEqual([
      { x: '?', y: '?', path: 'notes.md' },
      { x: ' ', y: 'M', path: 'src/a.ts' },
    ]);
  });

  it('captures the original path of rename entries', () => {
    const entries = parseProjectRagPorcelainStatusZ(encoder.encode('R  new.ts\0old.ts\0'));
    expect(entries).toHaveLength(1);
    const renamed: ProjectRagStatusEntry | undefined = entries[0];
    expect(renamed?.x).toBe('R');
    expect(renamed?.path).toBe('new.ts');
    expect(renamed?.origPath).toBe('old.ts');
  });

  it('produces a canonical order independent of input order', () => {
    const first = parseProjectRagPorcelainStatusZ(encoder.encode(' M b.ts\0 M a.ts\0'));
    const second = parseProjectRagPorcelainStatusZ(encoder.encode(' M a.ts\0 M b.ts\0'));
    expect(first.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts']);
    expect(second.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('rejects truncated or malformed fields', () => {
    expect(() => parseProjectRagPorcelainStatusZ(encoder.encode('xx\0'))).toThrow(
      'Malformed git status porcelain entry'
    );
    expect(() => parseProjectRagPorcelainStatusZ(encoder.encode('MMbroken\0'))).toThrow(
      'Malformed git status porcelain entry'
    );
  });

  it('filters out non-corpus paths (.afol, .data) unless raw=true is requested', () => {
    const raw = encoder.encode(
      ' M .afol/wb/session_task_01.md\0?? .data/scratch.json\0 M src/app.ts\0'
    );
    const filtered = parseProjectRagPorcelainStatusZ(raw);
    expect(filtered.map((e) => e.path)).toEqual(['src/app.ts']);

    const rawEntries = parseProjectRagPorcelainStatusZ(raw, { raw: true });
    expect(rawEntries.map((e) => e.path)).toEqual([
      '.afol/wb/session_task_01.md',
      '.data/scratch.json',
      'src/app.ts',
    ]);
  });
});

describe('resolveProjectRagWorkspaceContext (real git fixtures)', () => {
  it('distinguishes clean and dirty states and returns to the identical digest after restore', async () => {
    const dir = initFixture('project-rag-ctx-clean-');
    try {
      writeFileSync(join(dir, 'f.txt'), 'one\n');
      commitAll(dir, 'base');

      const clean = await resolveProjectRagWorkspaceContext(dir);
      appendFileSync(join(dir, 'f.txt'), 'two\n');
      const dirty = await resolveProjectRagWorkspaceContext(dir);

      expect(dirty.dirtyDigest).not.toBe(clean.dirtyDigest);
      expect(dirty.statusDigest).not.toBe(clean.statusDigest);
      expect(dirty.identityDigest).not.toBe(clean.identityDigest);

      writeFileSync(join(dir, 'f.txt'), 'one\n');
      const restored = await resolveProjectRagWorkspaceContext(dir);
      expect(restored.statusDigest).toBe(clean.statusDigest);
      expect(restored.contentFingerprint).toBe(clean.contentFingerprint);
      expect(restored.dirtyDigest).toBe(clean.dirtyDigest);
      expect(restored.identityDigest).toBe(clean.identityDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binds a nested registered root instead of the enclosing Git root', async () => {
    const dir = initFixture('project-rag-ctx-nested-');
    try {
      mkdirSync(join(dir, 'packages', 'app'), { recursive: true });
      mkdirSync(join(dir, 'packages', 'other'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'app', 'app.ts'), 'export const app = 1;\n');
      writeFileSync(join(dir, 'packages', 'other', 'other.ts'), 'export const other = 1;\n');
      commitAll(dir, 'base');

      const nestedRoot = join(dir, 'packages', 'app');
      const clean = await resolveProjectRagWorkspaceContext(nestedRoot);
      expect(clean.workspaceRoot).toBe(realpathSync.native(nestedRoot));
      expect(clean.scopePath).toBe('packages/app');

      writeFileSync(join(dir, 'packages', 'other', 'other.ts'), 'export const other = 2;\n');
      const siblingChanged = await resolveProjectRagWorkspaceContext(nestedRoot);
      expect(siblingChanged.contentFingerprint).toBe(clean.contentFingerprint);
      expect(siblingChanged.identityDigest).toBe(clean.identityDigest);

      writeFileSync(join(nestedRoot, 'app.ts'), 'export const app = 2;\n');
      const nestedChanged = await resolveProjectRagWorkspaceContext(nestedRoot);
      expect(nestedChanged.contentFingerprint).not.toBe(clean.contentFingerprint);
      expect(nestedChanged.identityDigest).not.toBe(clean.identityDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps scoped identity stable when a sibling-only commit changes repository metadata', async () => {
    const dir = initFixture('project-rag-ctx-sibling-commit-');
    try {
      mkdirSync(join(dir, 'packages', 'app'), { recursive: true });
      mkdirSync(join(dir, 'packages', 'other'), { recursive: true });
      writeFileSync(join(dir, 'packages', 'app', 'app.ts'), 'export const app = 1;\n');
      writeFileSync(join(dir, 'packages', 'other', 'other.ts'), 'export const other = 1;\n');
      commitAll(dir, 'base');

      const nestedRoot = join(dir, 'packages', 'app');
      const before = await resolveProjectRagWorkspaceContext(nestedRoot);

      writeFileSync(join(dir, 'packages', 'other', 'other.ts'), 'export const other = 2;\n');
      commitAll(dir, 'sibling-only change');
      const after = await resolveProjectRagWorkspaceContext(nestedRoot);

      expect(after.headOid).not.toBe(before.headOid);
      expect(after.headHash).not.toBe(before.headHash);
      expect(after.contentFingerprint).toBe(before.contentFingerprint);
      expect(after.repositoryHash).toBe(before.repositoryHash);
      expect(after.workspaceHash).toBe(before.workspaceHash);
      expect(after.identityDigest).toBe(before.identityDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changes scoped content identity after a clean committed file change', async () => {
    const dir = initFixture('project-rag-ctx-committed-content-');
    try {
      writeFileSync(join(dir, 'f.ts'), 'one\n');
      commitAll(dir, 'base');
      const first = await resolveProjectRagWorkspaceContext(dir);

      writeFileSync(join(dir, 'f.ts'), 'two\n');
      commitAll(dir, 'content change');
      const second = await resolveProjectRagWorkspaceContext(dir);

      expect(second.dirtyDigest).toBe(first.dirtyDigest);
      expect(second.contentFingerprint).not.toBe(first.contentFingerprint);
      expect(second.identityDigest).not.toBe(first.identityDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yields distinct identities for the same commit checked out on different branches', async () => {
    const dir = initFixture('project-rag-ctx-branches-');
    try {
      writeFileSync(join(dir, 'f.txt'), 'content\n');
      commitAll(dir, 'base');

      const mainContext = await resolveProjectRagWorkspaceContext(dir);
      git(dir, ['branch', 'feature']);
      git(dir, ['checkout', '--quiet', 'feature']);
      const featureContext = await resolveProjectRagWorkspaceContext(dir);

      expect(featureContext.headOid).toBe(mainContext.headOid);
      expect(featureContext.branchName).toBe('feature');
      expect(mainContext.branchName).toBe('main');
      expect(featureContext.identityDigest).toBe(mainContext.identityDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks detached HEAD distinctly even at the same commit as a branch', async () => {
    const dir = initFixture('project-rag-ctx-detach-same-');
    try {
      writeFileSync(join(dir, 'f.txt'), 'content\n');
      commitAll(dir, 'base');
      const branched = await resolveProjectRagWorkspaceContext(dir);
      git(dir, ['checkout', '--quiet', '--detach']);
      const detached = await resolveProjectRagWorkspaceContext(dir);

      expect(detached.headOid).toBe(branched.headOid);
      expect(detached.branchName).toBeNull();
      expect(detached.isDetached).toBe(true);
      expect(detached.isUnborn).toBe(false);
      expect(detached.identityDigest).toBe(branched.identityDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shares repositoryCommonDir across linked worktrees while separating workspace identity', async () => {
    const dir = initFixture('project-rag-ctx-worktree-');
    const worktreePath = join(dirname(dir), `${basename(dir)}-linked`);
    try {
      writeFileSync(join(dir, 'f.txt'), 'content\n');
      commitAll(dir, 'base');

      git(dir, ['worktree', 'add', '--quiet', worktreePath, '-b', 'wt-topic']);

      const mainContext = await resolveProjectRagWorkspaceContext(dir);
      const linkedContext = await resolveProjectRagWorkspaceContext(worktreePath);

      expect(linkedContext.repositoryCommonDir).toBe(mainContext.repositoryCommonDir);
      expect(linkedContext.workspaceRoot).not.toBe(mainContext.workspaceRoot);
      expect(linkedContext.worktreeGitDir).not.toBe(mainContext.worktreeGitDir);
      expect(linkedContext.branchName).toBe('wt-topic');
      expect(linkedContext.identityDigest).not.toBe(mainContext.identityDigest);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      try {
        git(dir, ['worktree', 'prune']);
      } catch {
        // fixture teardown best effort
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes two detached worktrees pinned to the exact same commit', async () => {
    const dir = initFixture('project-rag-ctx-two-detached-');
    const secondWorktree = join(dirname(dir), `${basename(dir)}-second`);
    try {
      writeFileSync(join(dir, 'f.txt'), 'content\n');
      commitAll(dir, 'base');
      git(dir, ['checkout', '--quiet', '--detach']);
      git(dir, ['worktree', 'add', '--quiet', '--detach', secondWorktree]);

      const first = await resolveProjectRagWorkspaceContext(dir);
      const second = await resolveProjectRagWorkspaceContext(secondWorktree);

      expect(second.headOid).toBe(first.headOid);
      expect(second.isDetached).toBe(true);
      expect(second.branchName).toBeNull();
      // Same commit, both detached, both clean — yet the worktrees are
      // distinguishable through the machine-independent worktree marker.
      expect(second.identityDigest).not.toBe(first.identityDigest);
      expect(first.identityDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(secondWorktree, { recursive: true, force: true });
      try {
        git(dir, ['worktree', 'prune']);
      } catch {
        // fixture teardown best effort
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changes the content fingerprint when file bytes change under an identical status shape', async () => {
    const dir = initFixture('project-rag-ctx-shape-');
    try {
      writeFileSync(join(dir, 'f.txt'), 'base\n');
      commitAll(dir, 'base');

      appendFileSync(join(dir, 'f.txt'), 'first-edit\n');
      const firstEdit = await resolveProjectRagWorkspaceContext(dir);
      appendFileSync(join(dir, 'f.txt'), 'second-edit\n');
      const secondEdit = await resolveProjectRagWorkspaceContext(dir);

      // Both edits show exactly one ` M f.txt` entry — identical shape.
      expect(secondEdit.statusDigest).toBe(firstEdit.statusDigest);
      // But the reported bytes differ, so content signals must diverge.
      expect(secondEdit.contentFingerprint).not.toBe(firstEdit.contentFingerprint);
      expect(secondEdit.dirtyDigest).not.toBe(firstEdit.dirtyDigest);
      expect(secondEdit.identityDigest).not.toBe(firstEdit.identityDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes the complete eligible file instead of only its first 256KiB', async () => {
    const dir = initFixture('project-rag-ctx-full-hash-');
    try {
      const prefix = Buffer.alloc(262_144, 0x61);
      writeFileSync(join(dir, 'large.txt'), Buffer.concat([prefix, Buffer.from('00000')]));
      commitAll(dir, 'base');

      writeFileSync(join(dir, 'large.txt'), Buffer.concat([prefix, Buffer.from('11111')]));
      const firstEdit = await resolveProjectRagWorkspaceContext(dir);
      writeFileSync(join(dir, 'large.txt'), Buffer.concat([prefix, Buffer.from('22222')]));
      const secondEdit = await resolveProjectRagWorkspaceContext(dir);

      expect(secondEdit.statusDigest).toBe(firstEdit.statusDigest);
      expect(secondEdit.contentFingerprint).not.toBe(firstEdit.contentFingerprint);
      expect(secondEdit.dirtyDigest).not.toBe(firstEdit.dirtyDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a dirty eligible path resolves through a symlink outside the root', async () => {
    const dir = initFixture('project-rag-ctx-symlink-');
    const outside = mkdtempSync(join(tmpdir(), 'project-rag-ctx-outside-'));
    try {
      const outsideFile = join(outside, 'secret.ts');
      writeFileSync(outsideFile, 'export const secret = true;\n');
      symlinkSync(outsideFile, join(dir, 'leak.ts'));

      await expect(resolveProjectRagWorkspaceContext(dir)).rejects.toThrow(
        'escapes the project root'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps digests stable when only git-ignored content changes', async () => {
    const dir = initFixture('project-rag-ctx-ignored-');
    try {
      writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
      writeFileSync(join(dir, 'src.txt'), 'tracked\n');
      commitAll(dir, 'base');

      const clean = await resolveProjectRagWorkspaceContext(dir);

      mkdirSync(join(dir, 'ignored'), { recursive: true });
      writeFileSync(join(dir, 'ignored', 'generated.ts'), 'export const noise = 1;\n');
      appendFileSync(join(dir, 'ignored', 'generated.ts'), 'export const more = 2;\n');

      const afterIgnoredChange = await resolveProjectRagWorkspaceContext(dir);
      expect(afterIgnoredChange.statusDigest).toBe(clean.statusDigest);
      expect(afterIgnoredChange.contentFingerprint).toBe(clean.contentFingerprint);
      expect(afterIgnoredChange.dirtyDigest).toBe(clean.dirtyDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes out-of-scope non-corpus paths (.afol, .data, scratch) from dirty digest', async () => {
    const dir = initFixture('project-rag-ctx-non-corpus-');
    try {
      writeFileSync(join(dir, 'README.md'), '# Project\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
      commitAll(dir, 'base');

      const clean = await resolveProjectRagWorkspaceContext(dir, undefined, {
        includeRoots: ['src'],
      });

      // Modifying .afol session state or .data scratch must not alter dirtyDigest
      mkdirSync(join(dir, '.afol', 'wb'), { recursive: true });
      writeFileSync(join(dir, '.afol', 'wb', 'task_01.md'), '# Task progress\n');
      mkdirSync(join(dir, '.data'), { recursive: true });
      writeFileSync(join(dir, '.data', 'scratch.json'), '{"transient": true}\n');

      const withNonCorpus = await resolveProjectRagWorkspaceContext(dir, undefined, {
        includeRoots: ['src'],
      });
      expect(withNonCorpus.statusDigest).toBe(clean.statusDigest);
      expect(withNonCorpus.contentFingerprint).toBe(clean.contentFingerprint);
      expect(withNonCorpus.dirtyDigest).toBe(clean.dirtyDigest);

      // But an in-scope change inside includeRoots DOES alter dirtyDigest
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 2;\n');
      const withCorpusEdit = await resolveProjectRagWorkspaceContext(dir, undefined, {
        includeRoots: ['src'],
      });
      expect(withCorpusEdit.dirtyDigest).not.toBe(clean.dirtyDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('listProjectRagWorkspaceTrackedFiles', () => {
  it('retains root-level Git-tracked files', async () => {
    await expect(
      listProjectRagWorkspaceTrackedFiles(
        realpathSync.native(resolve('.')),
        runnerFor(new Map([['ls-files -z', { stdout: 'README.md\0src/main.ts\0' }]]))
      )
    ).resolves.toEqual(['README.md', 'src/main.ts']);
  });

  it('resolves a real detached, no-remote repository and retains its root file', async () => {
    const scratchRoot = resolve('.tmp');
    mkdirSync(scratchRoot, { recursive: true });
    const fixture = mkdtempSync(join(scratchRoot, 'project-rag-context-'));
    try {
      execFileSync('git', ['init', '--quiet', fixture]);
      writeFileSync(join(fixture, 'root-file.ts'), 'export const root = true;\n');
      execFileSync('git', ['-C', fixture, 'add', 'root-file.ts']);
      execFileSync('git', [
        '-C',
        fixture,
        '-c',
        'user.name=Project RAG Test',
        '-c',
        'user.email=project-rag@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ]);
      execFileSync('git', ['-C', fixture, 'checkout', '--quiet', '--detach']);

      const context = await resolveProjectRagWorkspaceContext(fixture);
      expect(context.remoteUrl).toBeNull();
      expect(context.isDetached).toBe(true);
      expect(context.headOid).toMatch(/^[0-9a-f]{40}$/);
      await expect(listProjectRagWorkspaceTrackedFiles(fixture)).resolves.toContain('root-file.ts');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
