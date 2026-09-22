/**
 * @module eval/run-eval.test
 * @description Tests for eval run mode comparison and rerank effectiveness guardrails.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import STANDARD_QUERIES from './queries/standard.json' with { type: 'json' };
import {
  compareRerankEffectiveness,
  parseCompareModes,
  reportModeDivergence,
  resolveProfileLimit,
} from './run-eval.js';
import type { EvalBaseline } from './types.js';

describe('run-eval helpers', () => {
  describe('fixture source coverage', () => {
    it('keeps default eval source families configured for ingestion', () => {
      const sourceConfig = JSON.parse(readFileSync('scripts/sources.json', 'utf8')) as {
        sources: Array<{ id: string }>;
      };
      const sourceIds = new Set(sourceConfig.sources.map((source) => source.id));
      const queryIds = (STANDARD_QUERIES as Array<{ id: string }>).map((query) => query.id);

      if (queryIds.some((id) => id.startsWith('react-'))) {
        expect(sourceIds).toContain('react-docs');
      }
      if (queryIds.some((id) => id.startsWith('zod-'))) {
        expect(sourceIds).toContain('zod-docs');
      }
    });
  });

  describe('parseCompareModes', () => {
    it('defaults to all comparison modes when no input provided', () => {
      expect(parseCompareModes()).toEqual(['keyword', 'vector', 'hybrid']);
    });

    it('parses mixed-case comma list and deduplicates', () => {
      expect(parseCompareModes('Keyword,vector,HYBRID,vector')).toEqual([
        'keyword',
        'vector',
        'hybrid',
      ]);
    });

    it('throws for unsupported mode tokens', () => {
      expect(() => parseCompareModes('keyword,foo')).toThrow('Invalid mode "foo"');
    });
  });

  describe('resolveProfileLimit', () => {
    it('resolves known profiles', () => {
      expect(resolveProfileLimit('minimum')).toBe(10);
      expect(resolveProfileLimit('target')).toBe(20);
      expect(resolveProfileLimit('stretch')).toBe(50);
    });

    it('returns undefined for unknown profile', () => {
      expect(resolveProfileLimit('unknown')).toBeUndefined();
    });
  });

  describe('compareRerankEffectiveness', () => {
    let base: EvalBaseline;
    let reranked: EvalBaseline;

    beforeEach(() => {
      base = {
        captured_at: new Date().toISOString(),
        model: 'test',
        query_count: 2,
        metrics: {
          hitRate: 0.5,
          'nDCG@10': 0.3,
          MRR: 0.4,
          latency_p95: 1,
        },
        query_results: [
          {
            queryId: '1',
            query: 'a',
            contexts: ['x'],
            resultSources: ['A'],
            contextCount: 1,
            foundExpectedDocs: true,
            firstExpectedDocRank: 1,
            relevanceScores: [1],
            ndcgScore: 1,
            mrrScore: 1,
            latencyMs: 50,
          },
          {
            queryId: '2',
            query: 'b',
            contexts: ['y'],
            resultSources: ['B'],
            contextCount: 1,
            foundExpectedDocs: true,
            firstExpectedDocRank: 1,
            relevanceScores: [1],
            ndcgScore: 1,
            mrrScore: 1,
            latencyMs: 50,
          },
        ],
      };

      reranked = {
        captured_at: new Date().toISOString(),
        model: 'test',
        query_count: 2,
        metrics: {
          hitRate: 0.5,
          'nDCG@10': 0.3,
          MRR: 0.4,
          latency_p95: 1,
        },
        query_results: [
          {
            queryId: '1',
            query: 'a',
            contexts: ['x'],
            resultSources: ['A'],
            contextCount: 1,
            foundExpectedDocs: true,
            firstExpectedDocRank: 1,
            relevanceScores: [1],
            ndcgScore: 1,
            mrrScore: 1,
            latencyMs: 50,
          },
          {
            queryId: '2',
            query: 'b',
            contexts: ['y'],
            resultSources: ['B'],
            contextCount: 1,
            foundExpectedDocs: true,
            firstExpectedDocRank: 1,
            relevanceScores: [1],
            ndcgScore: 1,
            mrrScore: 1,
            latencyMs: 50,
          },
        ],
      };
    });

    it('flags rerank as likely ineffective when signatures and metrics are unchanged', () => {
      const result = compareRerankEffectiveness(base, reranked);

      expect(result.changedRate).toBe(0);
      expect(result.changedResultCount).toBe(0);
      expect(result.likelyIneffective).toBe(true);
    });

    it('marks rerank as effective when signatures change', () => {
      reranked.query_results = [
        {
          queryId: '1',
          query: 'a',
          contexts: ['x2'],
          resultSources: ['A2'],
          contextCount: 1,
          foundExpectedDocs: true,
          firstExpectedDocRank: 1,
          relevanceScores: [1],
          ndcgScore: 1,
          mrrScore: 1,
          latencyMs: 55,
        },
        {
          queryId: '2',
          query: 'b',
          contexts: ['y2'],
          resultSources: ['B2'],
          contextCount: 1,
          foundExpectedDocs: true,
          firstExpectedDocRank: 1,
          relevanceScores: [1],
          ndcgScore: 1,
          mrrScore: 1,
          latencyMs: 45,
        },
      ];

      const result = compareRerankEffectiveness(base, reranked, 0.1);
      expect(result.changedRate).toBe(1);
      expect(result.changedResultCount).toBe(2);
      expect(result.likelyIneffective).toBe(false);
    });
  });

  describe('reportModeDivergence', () => {
    const logs: string[] = [];
    let spy: ReturnType<typeof vi.spyOn> | null = null;

    beforeEach(() => {
      logs.length = 0;
      spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.join(' '));
      });
    });

    afterEach(() => {
      spy?.mockRestore();
      spy = null;
    });

    it('returns false when no severe divergence is present', () => {
      const severe = reportModeDivergence([
        {
          mode: 'hybrid',
          result: {
            captured_at: 'x',
            model: 'm',
            query_count: 2,
            metrics: { hitRate: 0.95, 'nDCG@10': 0.92, MRR: 0.8, latency_p95: 1.1 },
          },
        },
        {
          mode: 'keyword',
          result: {
            captured_at: 'x',
            model: 'm',
            query_count: 2,
            metrics: { hitRate: 0.9, 'nDCG@10': 0.86, MRR: 0.8, latency_p95: 1.2 },
          },
        },
      ]);

      expect(severe).toBe(false);
    });

    it('returns true when severe divergence is detected', () => {
      const severe = reportModeDivergence([
        {
          mode: 'hybrid',
          result: {
            captured_at: 'x',
            model: 'm',
            query_count: 2,
            metrics: { hitRate: 0.8, 'nDCG@10': 0.74, MRR: 0.8, latency_p95: 1.1 },
          },
        },
        {
          mode: 'keyword',
          result: {
            captured_at: 'x',
            model: 'm',
            query_count: 2,
            metrics: { hitRate: 0.4, 'nDCG@10': 0.5, MRR: 0.5, latency_p95: 1.2 },
          },
        },
      ]);

      expect(severe).toBe(true);
      expect(logs.some((line) => line.includes('Severe mode divergence'))).toBe(true);
    });
  });
});
