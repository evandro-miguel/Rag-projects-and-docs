import { describe, expect, it } from 'vitest';
import { deriveProjectRagBuildOverlay } from './build-overlay.js';

describe('Project RAG dirty build overlay', () => {
  it('marks modified, deleted, and untracked paths stale without a fallback lane', () => {
    const overlay = deriveProjectRagBuildOverlay({
      publishedDirtyDigest: 'a'.repeat(64),
      currentDirtyDigest: 'b'.repeat(64),
      publishedIdentityDigest: 'c'.repeat(64),
      currentIdentityDigest: 'd'.repeat(64),
      dirtyPaths: [
        { path: 'src/changed.ts', kind: 'modified' },
        { path: 'src/removed.ts', kind: 'deleted' },
        { path: 'src/new.ts', kind: 'untracked' },
      ],
    });
    expect(overlay).toMatchObject({
      status: 'invalid',
      contextStatus: 'drift',
      semanticFreshness: 'degraded',
      searchLane: 'unavailable',
    });
    expect(overlay.dirtyPaths.map((entry) => entry.kind)).toEqual([
      'modified',
      'deleted',
      'untracked',
    ]);
  });

  it('covers a matching scoped identity even when branch metadata changes', () => {
    expect(
      deriveProjectRagBuildOverlay({
        publishedDirtyDigest: 'a'.repeat(64),
        currentDirtyDigest: 'a'.repeat(64),
        publishedIdentityDigest: 'b'.repeat(64),
        currentIdentityDigest: 'b'.repeat(64),
      })
    ).toMatchObject({ status: 'published', contextStatus: 'covered' });
  });

  it('fails closed as unverified when either provenance identity is absent', () => {
    expect(
      deriveProjectRagBuildOverlay({
        publishedDirtyDigest: 'a'.repeat(64),
        currentDirtyDigest: 'a'.repeat(64),
        publishedIdentityDigest: null,
        currentIdentityDigest: 'b'.repeat(64),
      })
    ).toMatchObject({ status: 'invalid', contextStatus: 'unverified', searchLane: 'unavailable' });
  });
});
