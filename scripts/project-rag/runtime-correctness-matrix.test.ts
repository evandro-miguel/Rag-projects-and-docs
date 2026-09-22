/**
 * Deterministic F-20 regressions. Database assertions live in the disposable
 * Docs store and version-owned Project RAG integration suites.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SEARCH_QUERIES } from '../benchmarks/project-search-latency.js';
import { parseProjectRagPorcelainStatusZ } from './context.js';
import { isEligibleProjectSourcePath } from './eligibility.js';
import { SOURCE_EXTENSIONS } from './project-inventory.js';

describe('F-20 Runtime Correctness Hardening — Executable Failure Matrix', () => {
  it('2. verifies safe eligibility for .sql, .sh, and trusted launchers while excluding policy rejections', () => {
    expect(SOURCE_EXTENSIONS.has('.sql')).toBe(true);
    expect(SOURCE_EXTENSIONS.has('.sh')).toBe(true);
    expect(isEligibleProjectSourcePath('scripts/db-migrations/migrations/001.sql')).toBe(true);
    expect(isEligibleProjectSourcePath('start-rag.sh')).toBe(true);
    expect(isEligibleProjectSourcePath('bin/ragctl')).toBe(true);
    expect(isEligibleProjectSourcePath('bin/rag-mcp')).toBe(true);

    // Non-code policy exclusions remain excluded
    expect(isEligibleProjectSourcePath('assets/image.png')).toBe(false);
    expect(isEligibleProjectSourcePath('random_binary')).toBe(false);
    expect(isEligibleProjectSourcePath('data.csv')).toBe(false);
  });

  it('5. verifies benchmark queries are externalized and do not appear in benchmark source', () => {
    // The benchmark query literals must NOT be present in the benchmark script itself
    const benchmarkSource = readFileSync('scripts/benchmarks/project-search-latency.ts', 'utf8');
    for (const q of DEFAULT_PROJECT_SEARCH_QUERIES) {
      expect(benchmarkSource).not.toContain(q.query);
    }
  });

  it('6. verifies porcelain parsing filters out non-corpus out-of-scope paths', () => {
    const rawStatus = new TextEncoder().encode(
      ' M .afol/wb/session_task_01.md\0?? .data/scratch.json\0 M scripts/server.ts\0'
    );
    const parsed = parseProjectRagPorcelainStatusZ(rawStatus);

    // With corpus filtering, out-of-scope paths are excluded and in-scope paths retained
    const paths = parsed.map((e) => e.path);
    expect(paths).not.toContain('.afol/wb/session_task_01.md');
    expect(paths).not.toContain('.data/scratch.json');
    expect(paths).toContain('scripts/server.ts');

    // Raw mode retains everything
    const raw = parseProjectRagPorcelainStatusZ(rawStatus, { raw: true });
    expect(raw.map((e) => e.path)).toEqual([
      '.afol/wb/session_task_01.md',
      '.data/scratch.json',
      'scripts/server.ts',
    ]);
  });
});
