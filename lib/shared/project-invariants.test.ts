import { describe, expect, it } from 'vitest';
import {
  createUnverifiedEmbeddingInvariantSummary,
  createUnverifiedOwnershipInvariantSummary,
  evaluateProjectInvariants,
} from './project-invariants.js';

function coveredInput(contextStatus?: 'covered' | 'drift' | 'unverified') {
  return {
    fileCount: 1,
    contextStatus,
    versionReadiness: {
      filesWithVersionMetadata: 1,
      filesWithActiveReadyVersion: 1,
      filesWithNonReadyActiveVersion: 0,
      filesPendingVersionBackfill: 0,
      filesUsingLegacyStatusRead: 0,
    },
    freshnessStatus: 'fresh' as const,
    scopeCoverageStatus: 'covered' as const,
    embeddingCoverage: {
      ...createUnverifiedEmbeddingInvariantSummary('fixture'),
      status: 'covered' as const,
      chunkOwners: 1,
    },
    ownershipCoverage: {
      ...createUnverifiedOwnershipInvariantSummary('fixture'),
      status: 'covered' as const,
    },
  };
}

describe('Project RAG invariant provenance gate', () => {
  it('keeps a fully covered project ready', () => {
    const result = evaluateProjectInvariants(coveredInput('covered'));

    expect(result.checks.find((check) => check.key === 'context_provenance')).toMatchObject({
      status: 'covered',
    });
    expect(result.gateSignal).toEqual({ ready: true, blockingFailureCode: null });
  });

  it('classifies a serving identity drift as stale', () => {
    const result = evaluateProjectInvariants(coveredInput('drift'));

    expect(result.checks.find((check) => check.key === 'context_provenance')).toMatchObject({
      status: 'drift',
    });
    expect(result.gateSignal).toEqual({
      ready: false,
      blockingFailureCode: 'PROJECT_INDEX_STALE',
    });
  });

  it('classifies missing provenance as unverified', () => {
    const result = evaluateProjectInvariants(coveredInput('unverified'));

    expect(result.summary.status).toBe('unverified');
    expect(result.gateSignal).toEqual({
      ready: false,
      blockingFailureCode: 'PROJECT_INDEX_UNVERIFIED',
    });
  });
});
