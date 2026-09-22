import { describe, expect, it } from 'vitest';

import type { DocsRagLabEvalFixture } from './eval.js';
import {
  buildLiveEvalFixture,
  groupDocsRagIngestWorkerPaths,
  summarizeDocsRagWorkerReport,
} from './index.js';

describe('buildLiveEvalFixture', () => {
  it('runs live searches sequentially to respect the Docs RAG connection budget', async () => {
    const fixture = {
      meta: { name: 'sequential-live-eval' },
      cases: [
        {
          id: 'first',
          query: 'first query',
          expectedPaths: ['first.md'],
          retrieved: [],
        },
        {
          id: 'second',
          query: 'second query',
          expectedPaths: ['second.md'],
          retrieved: [],
        },
      ],
    } satisfies DocsRagLabEvalFixture;
    let activeSearches = 0;
    let maxActiveSearches = 0;
    const observedQueries: string[] = [];

    const result = await buildLiveEvalFixture(
      fixture,
      {} as Parameters<typeof buildLiveEvalFixture>[1],
      5,
      async (_config, query, options) => {
        activeSearches += 1;
        maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
        observedQueries.push(query);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        activeSearches -= 1;
        return {
          query,
          limit: options?.limit ?? 5,
          mode: 'keyword',
          results: [
            {
              sourceId: 'bun-docs',
              sourcePath: `${query.split(' ')[0]}.md`,
              title: query,
              heading: null,
              section: null,
              content: query,
              chunkIndex: 0,
              canonicalUrl: null,
              sourceRevision: null,
              syncedAt: null,
              authority: 'official',
              score: 1,
              provenanceStatus: 'degraded',
              missingFields: ['canonicalUrl', 'sourceRevision', 'syncedAt'],
            },
          ],
        };
      }
    );

    expect(maxActiveSearches).toBe(1);
    expect(observedQueries).toEqual(['first query', 'second query']);
    expect(result.cases.map((testCase) => testCase.retrieved[0]?.path)).toEqual([
      'first.md',
      'second.md',
    ]);
  });
});

describe('groupDocsRagIngestWorkerPaths', () => {
  it('keeps every file from one source in the same atomic worker batch', () => {
    const rootDir = '/repo';
    const batches = groupDocsRagIngestWorkerPaths(
      [
        '/repo/ingest/processed/external/react-docs/reference/react/useEffect.md',
        '/repo/ingest/processed/external/bun-docs/api/http.md',
        '/repo/ingest/processed/external/react-docs/reference/react/useMemo.md',
      ],
      rootDir
    );

    expect(batches).toEqual([
      [
        'ingest/processed/external/react-docs/reference/react/useEffect.md',
        'ingest/processed/external/react-docs/reference/react/useMemo.md',
      ],
      ['ingest/processed/external/bun-docs/api/http.md'],
    ]);
  });

  it('isolates unregistered files so one failure cannot suppress a registered source', () => {
    const batches = groupDocsRagIngestWorkerPaths(
      [
        '/repo/ingest/processed/external/react-docs/reference/react/useEffect.md',
        '/repo/ingest/processed/external/unknown-docs/page.md',
        '/repo/ingest/processed/external/unknown-docs/other.md',
      ],
      '/repo'
    );

    expect(batches).toEqual([
      ['ingest/processed/external/react-docs/reference/react/useEffect.md'],
      ['ingest/processed/external/unknown-docs/page.md'],
      ['ingest/processed/external/unknown-docs/other.md'],
    ]);
  });

  it('preserves exact worker failures without double-counting them as skipped files', () => {
    const summary = summarizeDocsRagWorkerReport({
      status: 'completed',
      inputPaths: ['ingest/processed/external/components'],
      scannedFiles: 197,
      indexedDocuments: 196,
      indexedChunks: 1905,
      skippedFiles: 3,
      failedFiles: [
        {
          path: 'ingest/processed/external/components/hover-focus-and-other-states.mdx',
          message: 'embedding context exceeded',
        },
      ],
    });

    expect(summary).toEqual({
      indexedDocuments: 196,
      indexedChunks: 1905,
      skippedFilesExcludingFailures: 2,
      failedFiles: [
        {
          path: 'ingest/processed/external/components/hover-focus-and-other-states.mdx',
          message: 'embedding context exceeded',
        },
      ],
    });
  });
});
