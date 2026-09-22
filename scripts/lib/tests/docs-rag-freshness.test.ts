import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDocsRagFreshness } from '../docs-rag-freshness.js';

function writeLatestReport(cwd: string, report: Record<string, unknown>) {
  const reportDir = join(cwd, '.data', 'reports', 'sync-external-docs');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'latest.json'), JSON.stringify(report), 'utf-8');
}

function writeTimestampedReport(cwd: string, name: string, report: Record<string, unknown>) {
  const reportDir = join(cwd, '.data', 'reports', 'sync-external-docs');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `sync-report-${name}.json`), JSON.stringify(report), 'utf-8');
}

function tempProject(name: string): string {
  return join(tmpdir(), `rag-v2-docs-freshness-${name}-${Date.now()}-${Math.random()}`);
}

describe('docs-rag-freshness', () => {
  const now = new Date('2026-06-20T12:00:00.000Z');

  it('returns ok for a recent successful sync report', () => {
    const cwd = tempProject('ok');
    writeLatestReport(cwd, {
      finishedAt: '2026-06-20T06:00:00.000Z',
      status: 'ok',
      alerts: [],
    });

    const freshness = readDocsRagFreshness({ cwd, now, maxAgeHours: 24 });

    expect(freshness.status).toBe('ok');
    expect(freshness.ageHours).toBe(6);
    expect(freshness.warning).toBeUndefined();
  });

  it('warns when no sync report exists', () => {
    const freshness = readDocsRagFreshness({
      cwd: tempProject('missing'),
      now,
      maxAgeHours: 24,
    });

    expect(freshness.status).toBe('missing');
    expect(freshness.warning).toContain('bun run sync:external');
  });

  it('warns when the latest sync report is stale', () => {
    const cwd = tempProject('stale');
    writeLatestReport(cwd, {
      finishedAt: '2026-06-18T00:00:00.000Z',
      status: 'ok',
      alerts: [],
    });

    const freshness = readDocsRagFreshness({ cwd, now, maxAgeHours: 24 });

    expect(freshness.status).toBe('stale');
    expect(freshness.warning).toContain('Docs RAG sync is stale');
  });

  it('warns when the latest sync report covers only part of the configured sources', () => {
    const cwd = tempProject('partial');
    writeLatestReport(cwd, {
      finishedAt: '2026-06-20T11:00:00.000Z',
      status: 'ok',
      alerts: [],
      sources: [{ source: 'bun-docs' }],
    });

    const freshness = readDocsRagFreshness({
      cwd,
      now,
      maxAgeHours: 24,
      expectedSourceIds: ['bun-docs', 'react-docs', 'go-books'],
    });

    expect(freshness.status).toBe('partial');
    expect(freshness.sourceCoverage?.missing).toEqual(['react-docs', 'go-books']);
    expect(freshness.warning).toContain('1/3 configured sources');
  });

  it('aggregates recent per-source sync reports for safe one-source-at-a-time refreshes', () => {
    const cwd = tempProject('aggregate');
    writeLatestReport(cwd, {
      finishedAt: '2026-06-20T11:00:00.000Z',
      status: 'ok',
      alerts: [],
      sources: [{ source: 'react-docs' }],
    });
    writeTimestampedReport(cwd, '2026-06-20T10-00-00-000Z', {
      finishedAt: '2026-06-20T10:00:00.000Z',
      status: 'ok',
      alerts: [],
      sources: [{ sourceId: 'bun-docs' }],
    });
    writeTimestampedReport(cwd, '2026-06-20T09-00-00-000Z', {
      finishedAt: '2026-06-20T09:00:00.000Z',
      status: 'ok',
      alerts: [],
      sources: [{ sourceName: 'go-books' }],
    });

    const freshness = readDocsRagFreshness({
      cwd,
      now,
      maxAgeHours: 24,
      expectedSourceIds: ['bun-docs', 'go-books', 'react-docs'],
    });

    expect(freshness.status).toBe('ok');
    expect(freshness.sourceCoverage?.reportedSourceIds).toEqual([
      'bun-docs',
      'go-books',
      'react-docs',
    ]);
    expect(freshness.finishedAt).toBe('2026-06-20T09:00:00.000Z');
    expect(freshness.ageHours).toBe(3);
  });

  it('warns when the last sync reported alerts', () => {
    const cwd = tempProject('alert');
    writeLatestReport(cwd, {
      finishedAt: '2026-06-20T11:00:00.000Z',
      status: 'alert',
      alerts: ['failedFiles 1 exceeds maxFailedDocs 0'],
    });

    const freshness = readDocsRagFreshness({ cwd, now, maxAgeHours: 24 });

    expect(freshness.status).toBe('alert');
    expect(freshness.warning).toContain('failedFiles 1');
  });

  it('warns when the latest sync report timestamp is in the future', () => {
    const cwd = tempProject('future');
    writeLatestReport(cwd, {
      finishedAt: '2026-06-20T13:00:00.000Z',
      status: 'ok',
      alerts: [],
    });

    const freshness = readDocsRagFreshness({ cwd, now, maxAgeHours: 24 });

    expect(freshness.status).toBe('invalid');
    expect(freshness.warning).toContain('sync report is invalid');
  });
});
