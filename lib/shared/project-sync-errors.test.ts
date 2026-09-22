import { describe, expect, it } from 'vitest';
import { MAX_SYNC_RUN_ERRORS_STORED, truncateProjectSyncRunErrors } from './project-sync-errors.js';

describe('truncateProjectSyncRunErrors', () => {
  it('returns undefined for empty input', () => {
    expect(truncateProjectSyncRunErrors()).toBeUndefined();
    expect(truncateProjectSyncRunErrors([])).toBeUndefined();
  });

  it('truncates stored entries, messages, and file paths', () => {
    const errors = Array.from({ length: MAX_SYNC_RUN_ERRORS_STORED + 10 }, (_value, index) => ({
      file: `src/path/${index}`.repeat(30),
      error: `error-${index}-${'x'.repeat(700)}`,
    }));

    const truncated = truncateProjectSyncRunErrors(errors);

    expect(truncated).toHaveLength(MAX_SYNC_RUN_ERRORS_STORED + 1);
    expect(truncated?.[0]?.error.length).toBeLessThanOrEqual(500);
    expect(truncated?.[0]?.file?.length).toBeLessThanOrEqual(200);
    expect(truncated?.at(-1)?.error).toContain('Omitted 10 additional errors');
  });
});
