import { describe, expect, it } from 'vitest';
import { resolveRegistrationRootPath } from './register-project.js';

describe('resolveRegistrationRootPath', () => {
  it('prefers the explicit CLI root path', () => {
    expect(
      resolveRegistrationRootPath(
        { rootPath: '/tmp/cli-project' },
        { projectSourcePath: '/tmp/env-project' }
      )
    ).toBe('/tmp/cli-project');
  });

  it('falls back to PROJECT_SOURCE_PATH when CLI root is omitted', () => {
    expect(resolveRegistrationRootPath({}, { projectSourcePath: '/tmp/env-project' })).toBe(
      '/tmp/env-project'
    );
  });

  it('fails when no root can be resolved', () => {
    expect(() => resolveRegistrationRootPath({})).toThrow(
      'Project root path is required. Pass --root <absolute-path> or set PROJECT_SOURCE_PATH.'
    );
  });
});
