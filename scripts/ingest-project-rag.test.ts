import { describe, expect, it } from 'vitest';
import {
  ingestProjectRagFile,
  isProjectEmbeddingInputOversized,
  isProjectFileOverSizeLimit,
  resolveProjectContext,
  resolveProjectFileGlobPattern,
  shouldIngestProjectFile,
} from './ingest-project-rag.js';

describe('shouldIngestProjectFile', () => {
  it('includes source code files', () => {
    expect(shouldIngestProjectFile('src/app/page.tsx', 4_096)).toBe(true);
    expect(shouldIngestProjectFile('backend/main.py', 4_096)).toBe(true);
  });

  it('includes root config json files', () => {
    expect(shouldIngestProjectFile('package.json', 250_000)).toBe(true);
    expect(shouldIngestProjectFile('tsconfig.base.json', 250_000)).toBe(true);
  });

  it('includes small json files in source-oriented directories', () => {
    expect(shouldIngestProjectFile('src/messages/en.json', 32_000)).toBe(true);
    expect(shouldIngestProjectFile('scripts/eval/queries/standard.json', 64_000)).toBe(true);
  });

  it('excludes large cache-like json files by default', () => {
    expect(
      shouldIngestProjectFile('data/cache/providers/yfinance/hist_AAPL_5y_1d.json', 255_900)
    ).toBe(false);
    expect(shouldIngestProjectFile('coverage.json', 153_600)).toBe(false);
  });
});

describe('resolveProjectFileGlobPattern', () => {
  it('builds a broad default glob when PROJECT_FILE_GLOB is not configured', () => {
    const glob = resolveProjectFileGlobPattern(undefined);

    expect(glob).toContain('py');
    expect(glob).toContain('go');
    expect(glob).toContain('rs');
    expect(glob).toContain('sql');
    expect(glob).toContain('md');
    expect(glob).toContain('json');
  });

  it('prefers explicitly configured PROJECT_FILE_GLOB', () => {
    expect(resolveProjectFileGlobPattern('**/*.{ts,tsx}')).toBe('**/*.{ts,tsx}');
  });
});

describe('resolveProjectContext', () => {
  it('fails fast because the legacy runtime path is retired', async () => {
    await expect(resolveProjectContext({}, {})).rejects.toThrow('resolveProjectContext is retired');
  });
});

describe('ingestProjectRagFile safe file reads', () => {
  it('fails fast because the legacy runtime path is retired', async () => {
    await expect(
      ingestProjectRagFile('/tmp/file.ts', '/tmp', 'project-test', {}, {})
    ).rejects.toThrow('ingestProjectRagFile is retired');
  });

  it('exposes file size guard as a pure helper', () => {
    expect(isProjectFileOverSizeLimit(100, 100)).toBe(false);
    expect(isProjectFileOverSizeLimit(101, 100)).toBe(true);
  });
});

// ============================================================================
// T-03A: Generated artifact exclusion
// ============================================================================

describe('shouldIngestProjectFile - generated artifact exclusion (T-03A)', () => {
  it('excludes docs/map/extra/** generated JSON artifacts', () => {
    // These are large repo-map analysis outputs that produce oversized embeddings
    expect(shouldIngestProjectFile('docs/map/extra/metadata.json', 64_000)).toBe(false);
    expect(shouldIngestProjectFile('docs/map/extra/phase2/exports.json', 128_000)).toBe(false);
    expect(shouldIngestProjectFile('docs/map/extra/phase4/hotspots.json', 256_000)).toBe(false);
    expect(shouldIngestProjectFile('docs/map/extra/bootstrap/analysis-boundary.json', 32_000)).toBe(
      false
    );
  });

  it('excludes docs/map/extra/** generated text/log artifacts', () => {
    expect(shouldIngestProjectFile('docs/map/extra/phase1/depcruise.dot', 16_000)).toBe(false);
    expect(shouldIngestProjectFile('docs/map/extra/logs/semgrep-stdout.log', 32_000)).toBe(false);
    expect(shouldIngestProjectFile('docs/map/extra/tool-versions.txt', 1_024)).toBe(false);
  });

  it('still admits legitimate source JSON files outside docs/map/extra/', () => {
    expect(shouldIngestProjectFile('package.json', 250_000)).toBe(true);
    expect(shouldIngestProjectFile('tsconfig.json', 2_048)).toBe(true);
    expect(shouldIngestProjectFile('src/locales/en.json', 32_000)).toBe(true);
    expect(shouldIngestProjectFile('docs/guide/config.json', 8_192)).toBe(true);
  });
});

// ============================================================================
// T-03B: Embedding input guard
// ============================================================================

describe('isProjectEmbeddingInputOversized (T-03B)', () => {
  it('returns false for inputs within the safe limit', () => {
    const safeText = 'a'.repeat(799);
    expect(isProjectEmbeddingInputOversized(safeText)).toBe(false);

    const exactLimit = 'a'.repeat(800);
    expect(isProjectEmbeddingInputOversized(exactLimit)).toBe(false);
  });

  it('returns true for inputs exceeding the safe limit', () => {
    const overLimit = 'a'.repeat(801);
    expect(isProjectEmbeddingInputOversized(overLimit)).toBe(true);

    const largeText = 'a'.repeat(5_000);
    expect(isProjectEmbeddingInputOversized(largeText)).toBe(true);
  });

  it('handles empty and short inputs', () => {
    expect(isProjectEmbeddingInputOversized('')).toBe(false);
    expect(isProjectEmbeddingInputOversized('short')).toBe(false);
  });
});
