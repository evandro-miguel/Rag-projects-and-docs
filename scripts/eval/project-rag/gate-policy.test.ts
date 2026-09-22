import { describe, expect, it } from 'vitest';
import {
  buildConservativeProjectEvalGatePolicy,
  buildProjectEvalGatePolicy,
  checkProjectEvalGateCoverage,
  resolveProjectEvalGatePolicy,
} from './gate-policy.js';

describe('project-rag gate policy', () => {
  it('requires schema gates when schema surfaces change', () => {
    const policy = buildProjectEvalGatePolicy([
      'scripts/project-rag/store.ts',
      'lib/shared/project-invariants.ts',
    ]);

    expect(policy.surfaceHits.some((hit) => hit.surface === 'schema')).toBe(true);
    expect(policy.requiredGates).toContain('bun run verify:project');
    expect(policy.requiredGates).toContain('bun run eval:project-rag');
  });

  it('requires watcher-specific gates when watcher surfaces change', () => {
    const policy = buildProjectEvalGatePolicy(['scripts/watch-project.ts']);

    expect(policy.surfaceHits.some((hit) => hit.surface === 'watcher')).toBe(true);
    expect(policy.requiredGates).toContain('bun run eval:mcp-project-current');
    expect(policy.requiredGates).toContain('bun run verify:project');
  });

  it('requires codex MCP smoke for MCP schema changes', () => {
    const policy = buildProjectEvalGatePolicy(['mcp/project-tools.ts']);

    expect(policy.surfaceHits.some((hit) => hit.surface === 'mcp_schema')).toBe(true);
    expect(policy.requiredGates).toContain('bun run eval:codex-mcp');
  });

  it('requires embedding profile benchmarks when profile surfaces change', () => {
    const policy = buildProjectEvalGatePolicy([
      'lib/shared/project-embedding-profiles.ts',
      'scripts/eval/project-rag/real-embedding-profile-benchmark.ts',
    ]);

    expect(policy.surfaceHits.some((hit) => hit.surface === 'embedding_profile')).toBe(true);
    expect(policy.requiredGates).toContain('bun run bench:project-embedding-profiles -- --json');
    expect(policy.requiredGates).toContain(
      'bun run bench:project-embedding-profiles:real -- --dry-run --json'
    );
    expect(policy.requiredGates).toContain('bun run verify:project');
    expect(policy.requiredGates).toContain('bun run eval:project-rag');
  });

  it('does not require eval gates for non-gated file changes', () => {
    const policy = buildProjectEvalGatePolicy(['docs/README.md', 'package.json']);

    expect(policy.mode).toBe('changed');
    expect(policy.surfaceHits).toEqual([]);
    expect(policy.requiredGates).toEqual([]);
  });

  it('uses the conservative gate set when no trusted range is available', () => {
    const policy = buildConservativeProjectEvalGatePolicy();

    expect(policy.mode).toBe('conservative');
    expect(policy.reason).toContain('Trusted base/head range is unavailable');
    expect(policy.requiredGates).toEqual(
      expect.arrayContaining([
        'bun run verify:project',
        'bun run eval:project-rag',
        'bun run eval:mcp-project-current',
        'bun run eval:codex-mcp',
        'bun run health:embeddings',
      ])
    );
  });

  it('fails closed when the range is missing and conservative mode is not requested', () => {
    expect(() => resolveProjectEvalGatePolicy({ changedFiles: [], conservative: false })).toThrow(
      /Missing trusted base\/head range/
    );
  });

  it('fails closed when git cannot resolve the provided range', () => {
    expect(() =>
      resolveProjectEvalGatePolicy({
        changedFiles: [],
        base: 'definitely-invalid-base',
        head: 'definitely-invalid-head',
        conservative: false,
      })
    ).toThrow(/Failed to collect changed files from git/);
  });

  it('injects failure when required gates are missing from executed list', () => {
    const coverage = checkProjectEvalGateCoverage(
      ['bun run verify:project', 'bun run eval:project-rag'],
      ['bun run verify:project']
    );

    expect(coverage.passed).toBe(false);
    expect(coverage.missing).toEqual(['bun run eval:project-rag']);
  });

  it('passes when executed gates cover every required gate', () => {
    const coverage = checkProjectEvalGateCoverage(
      ['bun run verify:project', 'bun run eval:project-rag'],
      ['bun run verify:project', 'bun run eval:project-rag', 'bun run lint']
    );

    expect(coverage.passed).toBe(true);
    expect(coverage.missing).toEqual([]);
  });
});
