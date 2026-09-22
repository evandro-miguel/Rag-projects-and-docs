import { describe, expect, it } from 'vitest';
import { parseArgs, resolveEvalSearchMode } from './run-e2e-eval.js';

describe('project-rag e2e eval runner', () => {
  it('parses explicit capture output paths', () => {
    const args = parseArgs([
      '--fixture',
      'fixture-ts-service',
      '--write-capture',
      '/tmp/capture.json',
    ]);

    expect(args.fixtureId).toBe('fixture-ts-service');
    expect(args.captureWritePath).toBe('/tmp/capture.json');
    expect(args.variant).toBe('project-hybrid');
  });

  it('keeps keyword isolated as an eval-only lexical baseline', () => {
    expect(resolveEvalSearchMode('project-keyword')).toBe('keyword');
    expect(resolveEvalSearchMode('project-vector')).toBe('vector');
    expect(resolveEvalSearchMode('project-hybrid')).toBe('hybrid');
  });
});
