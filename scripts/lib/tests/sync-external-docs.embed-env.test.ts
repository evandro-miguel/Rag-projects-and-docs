/**
 * @module sync-external-docs.embed-env.test
 * @description Unit tests for `resolveSyncDocsRagLabEnv` env defaulting:
 * non-dry-run sync must default the Docs RAG Postgres embedding gate ON so
 * mutation runs never produce chunks without embeddings, while dry runs pass
 * the environment through untouched.
 */

import { describe, expect, it } from 'vitest';
import { resolveSyncDocsRagLabEnv } from '../../sync-external-docs.js';

describe('resolveSyncDocsRagLabEnv', () => {
  it('defaults DOCS_RAG_PG_LAB_ENABLE_EMBEDDING to true when unset', () => {
    const resolved = resolveSyncDocsRagLabEnv({}, false);
    expect(resolved.DOCS_RAG_PG_LAB_ENABLE_EMBEDDING).toBe('true');
  });

  it('rejects an explicitly disabled embedding gate for mutating sync', () => {
    expect(() =>
      resolveSyncDocsRagLabEnv({ DOCS_RAG_PG_LAB_ENABLE_EMBEDDING: 'false' }, false)
    ).toThrow('DOCS_RAG_PG_LAB_ENABLE_EMBEDDING=true is required for non-dry-run external sync');
  });

  it('keeps an explicit DOCS_RAG_PG_LAB_ENABLE_EMBEDDING=true', () => {
    const resolved = resolveSyncDocsRagLabEnv({ DOCS_RAG_PG_LAB_ENABLE_EMBEDDING: 'true' }, false);
    expect(resolved.DOCS_RAG_PG_LAB_ENABLE_EMBEDDING).toBe('true');
  });

  it('returns the environment untouched for dry runs', () => {
    const env: NodeJS.ProcessEnv = {
      DOCS_RAG_PG_LAB_ENABLE_EMBEDDING: undefined,
      SYNC_EXTERNAL_MAX_FAILED_DOCS: '3',
    };
    expect(resolveSyncDocsRagLabEnv(env, true)).toBe(env);
  });
});
