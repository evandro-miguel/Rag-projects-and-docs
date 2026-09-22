/**
 * @module eval/capture-baseline.test
 * @description Tests for baseline capture and comparison functionality.
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareBaselinesFromFiles } from './compare-baseline.js';
import type { EvalMetrics } from './types.js';

const TEST_DIR = join(process.cwd(), 'tmp', 'test-baselines');

describe('baseline capture and comparison', () => {
  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      const files = require('node:fs').readdirSync(TEST_DIR);
      for (const file of files) {
        unlinkSync(join(TEST_DIR, file));
      }
      rmdirSync(TEST_DIR);
    }
  });

  const createTestBaseline = (filename: string, metrics: EvalMetrics): string => {
    const baseline = {
      captured_at: new Date().toISOString(),
      metrics,
      query_count: 10,
      environment: {
        commit_hash: 'abc123',
        branch: 'main',
        model: 'test-model',
      },
    };
    const path = join(TEST_DIR, filename);
    writeFileSync(path, JSON.stringify(baseline, null, 2));
    return path;
  };

  describe('compare-baseline', () => {
    it('should calculate percentage change correctly', () => {
      const oldMetrics: EvalMetrics = {
        hitRate: 0.85,
        'nDCG@10': 0.8,
        MRR: 0.75,
        latency_p95: 1.5,
      };

      const newMetrics: EvalMetrics = {
        hitRate: 0.9, // +5.88%
        'nDCG@10': 0.78, // -2.5%
        MRR: 0.75, // 0%
        latency_p95: 1.2, // -20% (improvement)
      };

      const oldPath = createTestBaseline('old.json', oldMetrics);
      const newPath = createTestBaseline('new.json', newMetrics);

      const result = compareBaselinesFromFiles(oldPath, newPath, { silent: true });

      // Find specific comparisons
      const hitRateComp = result.comparisons.find((c) => c.name === 'hitRate');
      const ndcgComp = result.comparisons.find((c) => c.name === 'nDCG@10');
      const mrrComp = result.comparisons.find((c) => c.name === 'MRR');
      const latencyComp = result.comparisons.find((c) => c.name === 'latency_p95');

      expect(hitRateComp).toBeDefined();
      expect(hitRateComp?.changePercent).toBeCloseTo(5.88, 1);
      expect(hitRateComp?.direction).toBe('improved');

      expect(ndcgComp).toBeDefined();
      expect(ndcgComp?.changePercent).toBeCloseTo(-2.5, 1);
      expect(ndcgComp?.direction).toBe('regressed');

      expect(mrrComp).toBeDefined();
      expect(mrrComp?.changePercent).toBe(0);
      expect(mrrComp?.direction).toBe('unchanged');

      // Latency: lower is better, so decrease is improvement
      expect(latencyComp).toBeDefined();
      expect(latencyComp?.changePercent).toBeCloseTo(-20, 0);
      expect(latencyComp?.direction).toBe('improved');
    });

    it('should include both baselines in markdown output', () => {
      const oldMetrics: EvalMetrics = {
        hitRate: 0.85,
        'nDCG@10': 0.8,
        MRR: 0.75,
        latency_p95: 1.5,
      };

      const newMetrics: EvalMetrics = {
        hitRate: 0.9,
        'nDCG@10': 0.85,
        MRR: 0.8,
        latency_p95: 1.3,
      };

      const oldPath = createTestBaseline('old2.json', oldMetrics);
      const newPath = createTestBaseline('new2.json', newMetrics);

      const result = compareBaselinesFromFiles(oldPath, newPath, { silent: true });

      expect(result.markdown).toContain('# Baseline Comparison Report');
      expect(result.markdown).toContain('Old Baseline');
      expect(result.markdown).toContain('New Baseline');
      expect(result.markdown).toContain('hitRate');
      expect(result.markdown).toContain('nDCG@10');
    });

    it('should handle edge cases in percentage calculation', () => {
      const oldMetrics: EvalMetrics = {
        hitRate: 0,
        'nDCG@10': 0.8,
        MRR: 0.75,
        latency_p95: 0,
      };

      const newMetrics: EvalMetrics = {
        hitRate: 0.5, // from 0 to 0.50
        'nDCG@10': 0,
        MRR: 0,
        latency_p95: 0, // no change from 0
      };

      const oldPath = createTestBaseline('old3.json', oldMetrics);
      const newPath = createTestBaseline('new3.json', newMetrics);

      const result = compareBaselinesFromFiles(oldPath, newPath, { silent: true });

      const hitRateComp = result.comparisons.find((c) => c.name === 'hitRate');
      const ndcgComp = result.comparisons.find((c) => c.name === 'nDCG@10');

      // hitRate went from 0 to 0.50, should be 100% change
      expect(hitRateComp?.changePercent).toBe(100);

      // nDCG went from 0.80 to 0, should be -100% change
      expect(ndcgComp?.changePercent).toBe(-100);
    });
  });

  describe('baseline file structure', () => {
    it('should create valid baseline JSON structure', () => {
      const baseline = {
        captured_at: new Date().toISOString(),
        metrics: {
          hitRate: 0.9,
          'nDCG@10': 0.85,
          MRR: 0.8,
          latency_p95: 1.2,
        },
        query_count: 10,
        environment: {
          commit_hash: 'abc123',
          branch: 'main',
          node_version: 'v20.0.0',
          platform: 'linux (x64)',
          model: 'test-model',
          category: undefined,
          mode: 'hybrid',
        },
      };

      const path = join(TEST_DIR, 'test-baseline.json');
      writeFileSync(path, JSON.stringify(baseline, null, 2));

      const loaded = JSON.parse(readFileSync(path, 'utf-8'));

      expect(loaded.captured_at).toBeDefined();
      expect(loaded.metrics).toBeDefined();
      expect(loaded.metrics.hitRate).toBe(0.9);
      expect(loaded.metrics['nDCG@10']).toBe(0.85);
      expect(loaded.metrics.MRR).toBe(0.8);
      expect(loaded.metrics.latency_p95).toBe(1.2);
      expect(loaded.environment.commit_hash).toBe('abc123');
      expect(loaded.environment.branch).toBe('main');
    });
  });
});
