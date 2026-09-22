import { describe, expect, it } from 'vitest';
import {
  formatLightProjectEmbeddingProfileBenchmark,
  runLightProjectEmbeddingProfileBenchmark,
} from './embedding-profile-benchmark.js';

describe('light project rag embedding profile benchmark', () => {
  it('compares deterministic 1024d vs 4096d profiles on small fixtures', () => {
    const report = runLightProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
    });

    expect(report.mode).toBe('light');
    expect(report.fixtures).toEqual([
      'fixture-ts-service',
      'fixture-secret-noise',
      'fixture-graph-relations',
    ]);
    expect(report.profiles).toHaveLength(2);

    const profile1024 = report.profiles.find((profile) => profile.profileId === 'profile-1024');
    const profile4096 = report.profiles.find((profile) => profile.profileId === 'profile-4096');

    expect(profile1024).toBeDefined();
    expect(profile4096).toBeDefined();
    if (!profile1024 || !profile4096) {
      throw new Error('expected both deterministic profiles');
    }

    expect(profile4096.metrics.successRate).toBeGreaterThan(profile1024.metrics.successRate);
    expect(profile4096.metrics.hitRate).toBeGreaterThan(profile1024.metrics.hitRate);
    expect(profile4096.metrics.exactPathRate).toBeGreaterThan(profile1024.metrics.exactPathRate);
    expect(profile4096.metrics.exactSymbolRate).toBeGreaterThanOrEqual(
      profile1024.metrics.exactSymbolRate
    );
    expect(profile4096.metrics.avgQualityScore).toBeGreaterThanOrEqual(
      profile1024.metrics.avgQualityScore
    );
    expect(profile4096.metrics.latencyP95Ms).toBeGreaterThan(profile1024.metrics.latencyP95Ms);
    expect(profile1024.metrics.contaminationRate).toBe(0);
    expect(profile4096.metrics.contaminationRate).toBe(0);
    expect(report.comparison.baselineProfileId).toBe('profile-1024');
    expect(report.comparison.candidateProfileId).toBe('profile-4096');
  });

  it('formats a human report with the non-semantic disclaimer', () => {
    const report = runLightProjectEmbeddingProfileBenchmark({
      generatedAt: '2026-06-23T00:00:00.000Z',
    });

    const formatted = formatLightProjectEmbeddingProfileBenchmark(report);
    expect(formatted).toContain('Deterministic hashed embeddings');
    expect(formatted).toContain('profile-4096');
    expect(formatted).toContain('fixture-graph-relations/profile-1024');
    expect(formatted).toContain('fixture-secret-noise/profile-1024');
  });
});
