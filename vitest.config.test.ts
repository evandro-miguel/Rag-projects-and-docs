import { describe, expect, it } from 'vitest';
import vitestConfig from './vitest.config.js';

describe('Vitest discovery configuration', () => {
  it('excludes repository scratch files from test discovery', () => {
    expect(vitestConfig.test?.exclude).toContain('.tmp/**');
  });
});
