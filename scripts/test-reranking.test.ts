import { describe, expect, it } from 'vitest';
import {
  buildCurlJsonArgs,
  parseCurlJsonResponse,
  resolveRerankingServiceUrl,
} from './test-reranking.js';

describe('test-reranking smoke transport helpers', () => {
  it('resolves the same explicit service URL shape as the supervisor', () => {
    expect(
      resolveRerankingServiceUrl({
        RERANKING_SERVICE_URL: 'http://127.0.0.1:3556///',
        RERANKING_SERVICE_HOST: 'ignored',
        RERANKING_SERVICE_PORT: 'ignored',
      })
    ).toBe('http://127.0.0.1:3556');
  });

  it('derives the service URL from host and port when no explicit URL is set', () => {
    expect(
      resolveRerankingServiceUrl({
        RERANKING_SERVICE_HOST: '127.0.0.1',
        RERANKING_SERVICE_PORT: '3556',
      })
    ).toBe('http://127.0.0.1:3556');
  });

  it('builds curl args with JSON headers, timeout, body, and status trailer', () => {
    const args = buildCurlJsonArgs('http://127.0.0.1:3456/rerank', {
      method: 'POST',
      timeoutSeconds: 7,
      body: { query: 'react hooks', documents: ['doc'] },
    });

    expect(args).toEqual([
      'curl',
      '-sS',
      '--max-time',
      '7',
      '-X',
      'POST',
      '-H',
      'Accept: application/json',
      '-w',
      '\n%{http_code}',
      '-H',
      'Content-Type: application/json',
      '--data',
      JSON.stringify({ query: 'react hooks', documents: ['doc'] }),
      'http://127.0.0.1:3456/rerank',
    ]);
  });

  it('parses body and HTTP status from curl stdout', () => {
    const response = parseCurlJsonResponse<{ model: string }>('{"model":"test"}\n200');

    expect(response).toEqual({
      ok: true,
      status: 200,
      data: { model: 'test' },
      bodyText: '{"model":"test"}',
    });
  });

  it('rejects malformed curl stdout without a status trailer', () => {
    expect(() => parseCurlJsonResponse('{"model":"test"}')).toThrow('Invalid curl response');
  });
});
