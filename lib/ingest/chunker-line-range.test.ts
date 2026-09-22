import { describe, expect, it } from 'vitest';
import { chunkTextWithContextProfile, lineRangeForChunkContent } from './chunker.js';

describe('lineRangeForChunkContent', () => {
  it('maps chunk text to 1-based line ranges', () => {
    const full = 'a\nb\nc\nd';
    const first = lineRangeForChunkContent(full, 'a\nb', 0);
    expect(first.startLine).toBe(1);
    expect(first.endLine).toBe(2);
    const second = lineRangeForChunkContent(full, 'c\nd', first.nextSearchFrom);
    expect(second.startLine).toBe(3);
    expect(second.endLine).toBe(4);
  });
});

describe('chunkTextWithContextProfile line ranges', () => {
  it('attaches startLine/endLine to each chunk', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = await chunkTextWithContextProfile(
      text,
      { title: 't', sourcePath: 'f.ts' },
      { docType: 'project', chunkSize: 40, chunkOverlap: 5 }
    );
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const { startLine, endLine } = chunk;
      expect(startLine).toEqual(expect.any(Number));
      expect(endLine).toEqual(expect.any(Number));
      if (typeof startLine !== 'number' || typeof endLine !== 'number') continue;
      expect(startLine).toBeGreaterThan(0);
      expect(endLine).toBeGreaterThanOrEqual(startLine);
    }
  });
});
