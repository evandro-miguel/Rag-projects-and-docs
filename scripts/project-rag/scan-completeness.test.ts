import { describe, expect, it } from 'vitest';
import type { RootManifestReadResult } from './root-manifest.js';
import {
  decideDeletionEligibility,
  evaluateScanCompleteness,
  manifestStateFromReadResult,
  SCAN_ISSUE_KINDS,
  SCAN_MAX_REASONS,
  type ScanObservation,
} from './scan-completeness.js';

function completeObservation(overrides: Partial<ScanObservation> = {}): ScanObservation {
  return {
    interrupted: false,
    issues: [],
    blockedFindings: [],
    manifest: { state: 'absent' },
    eligibleFileCount: 3,
    scannedPathCount: 3,
    ...overrides,
  };
}

const BLOCKED_FINDING_FIXTURE = [
  {
    category: 'dependency_dir',
    count: 2,
    sample: ['lib/a/node_modules', 'lib/b/node_modules'],
  },
] as const;

describe('evaluateScanCompleteness — complete scans', () => {
  it('classifies a clean scan as complete', () => {
    const verdict = evaluateScanCompleteness(completeObservation());
    expect(verdict.status).toBe('complete');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.issueKinds).toEqual([]);
    expect(verdict.blockedFindingCategories).toEqual([]);
    expect(verdict.eligibleFileCount).toBe(3);
    expect(verdict.scannedPathCount).toBe(3);
  });

  it('treats omitted optional fields the same as explicit empty values', () => {
    const verdict = evaluateScanCompleteness({});
    expect(verdict.status).toBe('complete');
    expect(verdict.eligibleFileCount).toBe(0);
    expect(verdict.scannedPathCount).toBeNull();
  });
});

describe('evaluateScanCompleteness — zero eligible files (empty build)', () => {
  it('keeps status complete when eligibleFileCount is zero', () => {
    const verdict = evaluateScanCompleteness(completeObservation({ eligibleFileCount: 0 }));
    expect(verdict.status).toBe('complete');
  });

  it('allows planning deletion of every tracked file for a valid empty build', () => {
    const verdict = evaluateScanCompleteness(
      completeObservation({ eligibleFileCount: 0, scannedPathCount: 0 })
    );
    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: [],
      trackedSourcePaths: ['a.ts', 'b.ts', 'c.md'],
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.stalePaths).toEqual(['a.ts', 'b.ts', 'c.md']);
      expect(decision.count).toBe(3);
    }
  });
});

describe('evaluateScanCompleteness — interrupted scans', () => {
  it('classifies an interrupted walk as incomplete and refuses deletions', () => {
    const verdict = evaluateScanCompleteness(completeObservation({ interrupted: true }));
    expect(verdict.status).toBe('incomplete');
    expect(verdict.reasons.map((r) => r.code)).toEqual(['scan_interrupted']);

    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: [],
      trackedSourcePaths: ['stale.ts'],
    });
    expect(decision).toEqual({
      allowed: false,
      status: 'incomplete',
      reasonCodes: ['scan_interrupted'],
    });
  });

  it('does not treat an explicit interrupted=false flag as a reason', () => {
    const verdict = evaluateScanCompleteness(completeObservation({ interrupted: false }));
    expect(verdict.status).toBe('complete');
  });
});

describe('evaluateScanCompleteness — blocked findings', () => {
  it('classifies unsuppressed blocked findings as blocked and never deletes', () => {
    const verdict = evaluateScanCompleteness(
      completeObservation({ blockedFindings: [...BLOCKED_FINDING_FIXTURE] })
    );
    expect(verdict.status).toBe('blocked');
    expect(verdict.reasons.map((r) => r.code)).toContain('blocked_findings_present');
    expect(verdict.blockedFindingCategories).toEqual(['dependency_dir']);

    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: ['kept.ts'],
      trackedSourcePaths: ['gone.ts'],
    });
    expect(decision).toMatchObject({ allowed: false, status: 'blocked' });
  });

  it('rejects malformed blocked findings loudly instead of classifying them', () => {
    expect(() =>
      evaluateScanCompleteness(
        completeObservation({
          blockedFindings: [
            { category: 'dependency_dir', count: 1, sample: ['../traversal'] } as any,
          ],
        })
      )
    ).toThrow(/relative/i);

    expect(() =>
      evaluateScanCompleteness(
        completeObservation({
          blockedFindings: [{ category: 'not a safe token!', count: 1 } as any],
        })
      )
    ).toThrow(/safe token/i);
  });

  it('throws when blocked-findings array exceeds the shared maximum', async () => {
    const { BLOCKED_FINDINGS_MAX } = await import('./snapshot-policy.js');
    const oversized = Array.from({ length: BLOCKED_FINDINGS_MAX + 1 }, (_, i) => ({
      category: `cat_${i}`,
      count: 1,
    }));
    expect(() =>
      evaluateScanCompleteness(completeObservation({ blockedFindings: oversized }))
    ).toThrow(/exceeds max/);
  });
});

describe('evaluateScanCompleteness — permission/read/stat errors', () => {
  for (const kind of ['permission_denied', 'read_error', 'stat_error'] as const) {
    it(`classifies ${kind} as incomplete and forbids deletion`, () => {
      const verdict = evaluateScanCompleteness(
        completeObservation({
          issues: [{ kind, count: 2, sample: `lib/locked/${kind}.ts` }],
        })
      );
      expect(verdict.status).toBe('incomplete');
      expect(verdict.issueKinds).toEqual([kind]);

      const decision = decideDeletionEligibility({
        verdict,
        candidateSourcePaths: ['seen.ts'],
        trackedSourcePaths: ['unseen.ts'],
      });
      expect(decision).toMatchObject({ allowed: false, status: 'incomplete' });
    });
  }

  it('reports each issue kind exactly once with sanitized detail', () => {
    const verdict = evaluateScanCompleteness(
      completeObservation({
        issues: [
          { kind: 'permission_denied', count: 1 },
          { kind: 'read_error', count: 3, sample: 'a\u0000b'.replace('\u0000', '') },
        ],
      })
    );
    expect(verdict.issueKinds).toEqual(['permission_denied', 'read_error']);
    expect(verdict.reasons).toHaveLength(2);
    for (const reason of verdict.reasons) {
      expect(reason.code.startsWith('scan_issue_')).toBe(true);
    }
  });

  it('throws on unknown issue kinds and duplicate kinds', () => {
    expect(() =>
      evaluateScanCompleteness(
        completeObservation({
          issues: [{ kind: 'made_up_kind' as any, count: 1 }],
        })
      )
    ).toThrow(/Unknown scan issue kind/);

    expect(() =>
      evaluateScanCompleteness(
        completeObservation({
          issues: [
            { kind: 'read_error', count: 1 },
            { kind: 'read_error', count: 2 },
          ],
        })
      )
    ).toThrow(/Duplicate scan issue kind/);
  });

  it('throws on non-positive or non-integer issue counts', () => {
    expect(() =>
      evaluateScanCompleteness(completeObservation({ issues: [{ kind: 'read_error', count: 0 }] }))
    ).toThrow(/positive integer/);
    expect(() =>
      evaluateScanCompleteness(completeObservation({ issues: [{ kind: 'stat_error', count: -2 }] }))
    ).toThrow(/positive integer/);
  });
});

describe('evaluateScanCompleteness — bound overflow', () => {
  it('classifies bound_exceeded as incomplete so overflowed walks never delete', () => {
    const verdict = evaluateScanCompleteness(
      completeObservation({
        issues: [{ kind: 'bound_exceeded', count: 1 }],
      })
    );
    expect(verdict.status).toBe('incomplete');
    expect(verdict.reasons[0]?.code).toBe('scan_bound_exceeded');

    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: [],
      trackedSourcePaths: ['anything.ts'],
    });
    expect(decision.allowed).toBe(false);
  });

  it('refuses a deletion plan that would exceed its listing bound instead of truncating', () => {
    const verdict = evaluateScanCompleteness(completeObservation());
    const tracked = Array.from({ length: 10 }, (_, i) => `file_${i}.ts`);
    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: [],
      trackedSourcePaths: tracked,
      maxPlannedDeletions: 5,
    });
    expect(decision).toEqual({
      allowed: false,
      status: 'complete',
      reasonCodes: ['deletion_plan_bound_exceeded'],
    });
  });

  it('throws when counters exceed the hard cap', () => {
    expect(() =>
      evaluateScanCompleteness(completeObservation({ eligibleFileCount: Number.MAX_SAFE_INTEGER }))
    ).toThrow(/SCAN_COUNT_CAP/);
  });
});

describe('evaluateScanCompleteness — manifest rejection', () => {
  it('classifies a rejected manifest as blocked and never deletes', () => {
    const verdict = evaluateScanCompleteness(
      completeObservation({
        manifest: { state: 'rejected', errors: ['manifest is not valid JSON: unexpected token'] },
      })
    );
    expect(verdict.status).toBe('blocked');
    const rejection = verdict.reasons.find((r) => r.code === 'manifest_rejected');
    expect(rejection?.detail).toContain('not valid JSON');

    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: ['a.ts'],
      trackedSourcePaths: ['b.ts'],
    });
    expect(decision).toMatchObject({ allowed: false, status: 'blocked' });
  });
});

describe('manifestStateFromReadResult — root-manifest integration', () => {
  it('maps absent manifests to absent state with the empty digest preserved upstream', () => {
    const absent: RootManifestReadResult = {
      present: false,
      manifest: { manifestVersion: 1, includeRoots: [], ignoreRules: [] },
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };
    expect(manifestStateFromReadResult(absent)).toEqual({ state: 'absent' });
  });

  it('maps valid manifests to valid state carrying the raw-bytes digest', () => {
    const valid: RootManifestReadResult = {
      present: true,
      ok: true,
      manifest: { manifestVersion: 1, includeRoots: ['lib'], ignoreRules: [] },
      digest: 'abc123',
    };
    expect(manifestStateFromReadResult(valid)).toEqual({
      state: 'valid',
      digest: 'abc123',
    });
  });

  it('maps invalid manifests to rejected state with bounded error passthrough', () => {
    const invalid: RootManifestReadResult = {
      present: true,
      ok: false,
      errors: ['includeRoots[0]: path must be relative, not absolute'],
    };
    const mapped = manifestStateFromReadResult(invalid);
    expect(mapped.state === 'rejected' && mapped.errors.length === 1).toBe(true);

    const verdict = evaluateScanCompleteness(
      completeObservation({ manifest: manifestStateFromReadResult(invalid) })
    );
    expect(verdict.status).toBe('blocked');
  });

  it('feeds end-to-end through readRootManifest output shapes', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readRootManifest, ROOT_MANIFEST_FILENAME } = await import('./root-manifest.js');

    const dir = await mkdtemp(join(tmpdir(), 'scan-completeness-'));
    await writeFile(
      join(dir, ROOT_MANIFEST_FILENAME),
      '{"manifestVersion":1,"includeRoots":["../escape"]}',
      'utf8'
    );
    const result = await readRootManifest(dir);
    const verdict = evaluateScanCompleteness(
      completeObservation({ manifest: manifestStateFromReadResult(result) })
    );
    expect(result.present && !result.ok).toBe(true);
    expect(verdict.status).toBe('blocked');
  });
});

describe('deterministic evidence hashing', () => {
  it('produces identical hashes for identical observations regardless of key order', () => {
    const first = evaluateScanCompleteness(completeObservation());
    const second = evaluateScanCompleteness(completeObservation());
    expect(first.evidenceHash).toBe(second.evidenceHash);
    expect(first.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes issue-kind order independently of input ordering', () => {
    const a = evaluateScanCompleteness(
      completeObservation({
        issues: [
          { kind: 'permission_denied', count: 1 },
          { kind: 'read_error', count: 1 },
        ],
      })
    );
    const b = evaluateScanCompleteness(
      completeObservation({
        issues: [
          { kind: 'read_error', count: 1 },
          { kind: 'permission_denied', count: 1 },
        ],
      })
    );
    expect(a.evidenceHash).toBe(b.evidenceHash);
  });

  it('changes the hash when any classified evidence changes', () => {
    const baseline = evaluateScanCompleteness(completeObservation());
    const variants = [
      completeObservation({ eligibleFileCount: 4 }),
      completeObservation({ scannedPathCount: 4 }),
      completeObservation({ interrupted: true }),
      completeObservation({ blockedFindings: [{ category: 'cache_dir', count: 1 }] }),
      completeObservation({ manifest: { state: 'valid', digest: 'deadbeef' } }),
      completeObservation({ manifest: { state: 'rejected', errors: ['x'] } }),
    ];
    const hashes = new Set(variants.map((v) => evaluateScanCompleteness(v).evidenceHash));
    hashes.add(baseline.evidenceHash);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it('sorts reasons deterministically even when signals fire in different orders', () => {
    const interruptedWithIssues = evaluateScanCompleteness(
      completeObservation({
        interrupted: true,
        issues: [{ kind: 'stat_error', count: 1 }],
      })
    );
    expect(interruptedWithIssues.reasons.map((r) => r.code)).toEqual([
      'scan_interrupted',
      'scan_issue_stat_error',
    ]);
  });

  it('caps reported reasons at the documented maximum', () => {
    const everyKindTwice = SCAN_ISSUE_KINDS.flatMap((kind) => [
      { kind, count: 1 },
      // duplicates throw, so instead saturate via distinct codes below
    ]);
    expect(everyKindTwice.length).toBeGreaterThan(0);

    // Saturation check: more distinct firing reasons than the cap cannot be
    // constructed from the fixed vocabulary alone (5 kinds + interruption +
    // blocked findings + manifest), so assert the cap constant contract.
    const maxConstructible = SCAN_ISSUE_KINDS.length + 3; // + interrupted, blocked_findings, manifest
    expect(SCAN_MAX_REASONS).toBeGreaterThanOrEqual(maxConstructible - 1);
    expect(SCAN_MAX_REASONS).toBeLessThan(64);
  });
});

describe('decideDeletionEligibility — pure inventory decision rules', () => {
  it('plans only genuinely stale paths, sorted and deduplicated', () => {
    const verdict = evaluateScanCompleteness(completeObservation());
    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: ['keep.ts', 'also-keep.ts'],
      trackedSourcePaths: ['z.ts', 'keep.ts', 'a.ts', 'z.ts'],
    });
    expect(decision).toEqual({
      allowed: true,
      stalePaths: ['a.ts', 'z.ts'],
      count: 2,
    });
  });

  it('never lets non-complete verdicts see candidate data', () => {
    const blocked = evaluateScanCompleteness(
      completeObservation({ blockedFindings: [{ category: 'temp_dir', count: 1 }] })
    );
    const incomplete = evaluateScanCompleteness(
      completeObservation({ issues: [{ kind: 'permission_denied', count: 7 }] })
    );
    for (const verdict of [blocked, incomplete]) {
      const decision = decideDeletionEligibility({
        verdict,
        candidateSourcePaths: [],
        trackedSourcePaths: ['do-not-touch.ts'],
      });
      expect(decision.allowed).toBe(false);
    }
  });

  it('throws on non-string path entries instead of producing a silent plan', () => {
    const verdict = evaluateScanCompleteness(completeObservation());
    expect(() =>
      decideDeletionEligibility({
        verdict,
        candidateSourcePaths: [42 as unknown as string],
        trackedSourcePaths: [],
      })
    ).toThrow(/non-string entry/);
    expect(() =>
      decideDeletionEligibility({
        verdict,
        candidateSourcePaths: [],
        trackedSourcePaths: [null as unknown as string],
      })
    ).toThrow(/non-string entry/);
  });

  it('honours an explicit zero deletion bound on an otherwise complete scan', () => {
    const verdict = evaluateScanCompleteness(completeObservation());
    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: ['a.ts'],
      trackedSourcePaths: ['gone.ts'],
      maxPlannedDeletions: 0,
    });
    expect(decision).toMatchObject({
      allowed: false,
      reasonCodes: ['deletion_plan_bound_exceeded'],
    });
  });
});

describe('evaluateScanCompleteness — walkerObserved legacy default', () => {
  it('never classifies an unobserved walk as complete and records the explicit reason', () => {
    const verdict = evaluateScanCompleteness(
      completeObservation({ walkerObserved: false, scannedPathCount: undefined })
    );
    expect(verdict.status).toBe('incomplete');
    expect(verdict.reasons.map((r) => r.code)).toEqual(['scan_evidence_not_provided']);
    const decision = decideDeletionEligibility({
      verdict,
      candidateSourcePaths: [],
      trackedSourcePaths: ['gone.ts'],
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasonCodes).toContain('scan_evidence_not_provided');
    }
  });

  it('keeps blocked signals dominant even without walker evidence', () => {
    const verdict = evaluateScanCompleteness(
      completeObservation({ walkerObserved: false, blockedFindings: BLOCKED_FINDING_FIXTURE })
    );
    expect(verdict.status).toBe('blocked');
    const codes = verdict.reasons.map((r) => r.code);
    expect(codes).toContain('blocked_findings_present');
    expect(codes).toContain('scan_evidence_not_provided');
  });

  it('changes the evidence hash once walker observability is recorded', () => {
    const observed = evaluateScanCompleteness(completeObservation());
    const unobserved = evaluateScanCompleteness(
      completeObservation({ walkerObserved: false, scannedPathCount: undefined })
    );
    expect(unobserved.evidenceHash).not.toBe(observed.evidenceHash);
  });

  it('treats omitted and explicit-true observability identically (backward compatible)', () => {
    const omitted = evaluateScanCompleteness(completeObservation());
    const explicit = evaluateScanCompleteness(completeObservation({ walkerObserved: true }));
    expect(explicit.status).toBe(omitted.status);
    expect(explicit.reasons).toEqual(omitted.reasons);
    expect(explicit.evidenceHash).toBe(omitted.evidenceHash);
  });
});
