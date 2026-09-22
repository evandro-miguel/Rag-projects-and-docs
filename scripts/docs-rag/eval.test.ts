import { describe, expect, test } from 'vitest';

import {
  evaluateDocsRagLabFixture,
  evaluateDocsRagLabGate,
  loadDocsRagLabEvalFixture,
  parseDocsRagLabEvalFixture,
} from './eval';

describe('Docs RAG eval fixture', () => {
  test('preserves an optional source scope for live retrieval', () => {
    const fixture = parseDocsRagLabEvalFixture({
      meta: { name: 'source-scoped' },
      cases: [
        {
          id: 'bun-streams',
          sourceId: 'bun-docs',
          query: 'ReadableStream',
          expectedPaths: ['ingest/processed/external/bun-docs/runtime/streams.mdx'],
          retrieved: [],
        },
      ],
    });

    expect(fixture.cases[0]?.sourceId).toBe('bun-docs');
  });

  test('aligns the React Router dataStrategy query with its data strategy guide', () => {
    const fixture = loadDocsRagLabEvalFixture(
      'scripts/docs-rag/fixtures/eval-external-sources.json'
    );
    const scenario = fixture.cases.find((item) => item.id === 'react-router-data-route');

    expect(scenario?.query).toContain('dataStrategy');
    expect(scenario?.query).toContain('loader action execution');
    expect(scenario).toMatchObject({
      expectedPaths: ['ingest/processed/external/react-router-docs/how-to/data-strategy.md'],
      expectedCitationPath: 'ingest/processed/external/react-router-docs/how-to/data-strategy.md',
    });
  });

  test('scores a source-scoped result with stable citation semantics', () => {
    const fixture = parseDocsRagLabEvalFixture({
      meta: { name: 'source-scoped' },
      cases: [
        {
          id: 'bun-streams',
          sourceId: 'bun-docs',
          query: 'ReadableStream',
          expectedPaths: ['ingest/processed/external/bun-docs/runtime/streams.mdx'],
          retrieved: [
            {
              path: '/repo/ingest/processed/external/bun-docs/runtime/streams.mdx',
              citationPath: 'ingest/processed/external/bun-docs/runtime/streams.mdx',
            },
          ],
        },
      ],
    });

    expect(evaluateDocsRagLabFixture(fixture).summary).toMatchObject({
      hitRate: 1,
      recallAtK: 1,
      mrr: 1,
      citationPathRate: 1,
      duplicatePathShare: 0,
      fullKRate: 0,
    });
  });

  test('keeps unscoped retrieval quality separate from source-scoped metrics', () => {
    const fixture = parseDocsRagLabEvalFixture({
      meta: { name: 'scoped-and-unscoped' },
      cases: [
        {
          id: 'scoped-pass',
          sourceId: 'bun-docs',
          query: 'ReadableStream',
          expectedPaths: ['ingest/processed/external/bun-docs/runtime/streams.mdx'],
          retrieved: [
            {
              path: 'ingest/processed/external/bun-docs/runtime/streams.mdx',
              citationPath: 'ingest/processed/external/bun-docs/runtime/streams.mdx',
            },
          ],
        },
        {
          id: 'unscoped-fail',
          query: 'global query',
          expectedPaths: ['ingest/processed/external/react-docs/reference/react/useEffect.md'],
          retrieved: [],
        },
      ],
    });

    const report = evaluateDocsRagLabFixture(fixture);

    expect(report.summary.sourceScoped).toMatchObject({
      scenarioCount: 1,
      hitRate: 1,
      recallAtK: 1,
      mrr: 1,
      citationPathRate: 1,
      duplicatePathShare: 0,
    });
    expect(report.summary.unscoped).toMatchObject({
      scenarioCount: 1,
      hitRate: 0,
      recallAtK: 0,
      mrr: 0,
      citationPathRate: 0,
      duplicatePathShare: 0,
    });
    expect(evaluateDocsRagLabGate(report.summary)).toMatchObject({
      passed: false,
      unscoped: { passed: false },
    });
  });

  test('fails closed when a fixture has no unscoped scenario', () => {
    const fixture = parseDocsRagLabEvalFixture({
      meta: { name: 'source-scoped-only' },
      cases: [
        {
          id: 'scoped-pass',
          sourceId: 'bun-docs',
          query: 'ReadableStream',
          expectedPaths: ['ingest/processed/external/bun-docs/runtime/streams.mdx'],
          retrieved: [
            {
              path: 'ingest/processed/external/bun-docs/runtime/streams.mdx',
              citationPath: 'ingest/processed/external/bun-docs/runtime/streams.mdx',
            },
          ],
        },
      ],
    });

    const gate = evaluateDocsRagLabGate(evaluateDocsRagLabFixture(fixture).summary);

    expect(gate.unscoped).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(['unscoped.scenarioCount 0 is below 1']),
    });
  });

  test('fails the release gate when retrieval quality regresses', () => {
    expect(
      evaluateDocsRagLabGate({
        scenarioCount: 10,
        topK: 5,
        hitRate: 0.8,
        recallAtK: 0.8,
        mrr: 0.6,
        citationPathRate: 0.5,
        duplicatePathShare: 0.4,
        fullKRate: 1,
        sourceScoped: {
          scenarioCount: 10,
          topK: 5,
          hitRate: 0.8,
          recallAtK: 0.8,
          mrr: 0.6,
          citationPathRate: 0.5,
          duplicatePathShare: 0.4,
          fullKRate: 1,
        },
        unscoped: {
          scenarioCount: 1,
          topK: 5,
          hitRate: 1,
          recallAtK: 1,
          mrr: 1,
          citationPathRate: 1,
          duplicatePathShare: 0,
          fullKRate: 1,
        },
      })
    ).toMatchObject({
      passed: false,
      failures: [
        'sourceScoped.hitRate 0.800 is below 0.950',
        'sourceScoped.recallAtK 0.800 is below 0.950',
        'sourceScoped.mrr 0.600 is below 0.800',
        'sourceScoped.citationPathRate 0.500 is below 0.800',
        'sourceScoped.duplicatePathShare 0.400 exceeds 0.300',
      ],
    });
  });

  test('reports duplicate path slots and fails only above the diversity ceiling', () => {
    const fixture = parseDocsRagLabEvalFixture({
      meta: { name: 'diversity' },
      cases: [
        {
          id: 'unscoped-diverse',
          query: 'query',
          expectedPaths: ['a.md'],
          retrieved: [
            { path: 'a.md' },
            { path: 'b.md' },
            { path: 'a.md' },
            { path: 'c.md' },
            { path: 'd.md' },
          ],
        },
      ],
    });

    const report = evaluateDocsRagLabFixture(fixture);
    expect(report.cases[0]).toMatchObject({
      returnedCount: 5,
      uniquePathCount: 4,
      duplicatePathSlots: 1,
      duplicatePathShare: 0.2,
      fullK: true,
    });
    expect(report.summary.unscoped).toMatchObject({
      duplicatePathShare: 0.2,
      fullKRate: 1,
    });
    expect(evaluateDocsRagLabGate(report.summary).unscoped.passed).toBe(true);
  });

  test('counts the same path from different sources as distinct identities', () => {
    const fixture = parseDocsRagLabEvalFixture({
      meta: { name: 'cross-source-diversity' },
      cases: [
        {
          id: 'cross-source',
          query: 'query',
          expectedPaths: ['guide.md'],
          retrieved: [
            { path: 'guide.md', sourceId: 'alpha' },
            { path: 'guide.md', sourceId: 'beta' },
            { path: 'guide.md', sourceId: 'alpha' },
            { path: 'guide.md', sourceId: 'beta' },
          ],
        },
      ],
    });

    expect(evaluateDocsRagLabFixture(fixture).cases[0]).toMatchObject({
      uniquePathCount: 2,
      duplicatePathSlots: 2,
      duplicatePathShare: 0.5,
    });
  });
});
