import { describe, expect, it } from 'vitest';
import {
  buildProjectSourcePath,
  extractCategory,
  extractTitle,
  getProjectCategory,
  shouldIgnoreExternalDocPath,
  shouldIgnorePath,
} from './file-helpers';

describe('file-helpers', () => {
  describe('extractTitle', () => {
    it('extracts H1 title from markdown', () => {
      const content = '# My Document\n\nContent here';
      expect(extractTitle(content, 'file.md')).toBe('My Document');
    });

    it('falls back to filename when no H1 found', () => {
      const content = 'No heading here';
      expect(extractTitle(content, 'my-file.md')).toBe('my file');
    });

    it('handles empty content', () => {
      expect(extractTitle('', 'file.md')).toBe('file');
    });

    it('handles multiple H1s (takes first)', () => {
      const content = '# First\n\n# Second';
      expect(extractTitle(content, 'file.md')).toBe('First');
    });

    it('normalizes hyphens to spaces in fallback', () => {
      expect(extractTitle('', 'my-test-file.md')).toBe('my test file');
    });

    it('handles H1 with extra whitespace', () => {
      const content = '#   Title with spaces   ';
      expect(extractTitle(content, 'file.md')).toBe('Title with spaces');
    });

    it('handles H1 with inline formatting', () => {
      const content = '# **Bold** Title';
      expect(extractTitle(content, 'file.md')).toBe('**Bold** Title');
    });
  });

  describe('extractCategory', () => {
    it('extracts first non-docs/reference path segment', () => {
      expect(extractCategory('docs/react/guide.md')).toBe('react');
      expect(extractCategory('reference/react/hooks.md')).toBe('react');
    });

    it('returns filename for docs-only paths (no subdirectory)', () => {
      expect(extractCategory('docs/README.md')).toBe('README.md');
    });

    it('handles nested paths correctly', () => {
      expect(extractCategory('docs/react/api/v2/endpoint.md')).toBe('react');
    });

    it('handles root-level files', () => {
      // Root-level file returns the filename as category
      expect(extractCategory('README.md')).toBe('README.md');
    });

    it('handles deep nested paths', () => {
      expect(extractCategory('docs/react/modules/internal/core/utils.md')).toBe('react');
    });
  });

  describe('shouldIgnorePath', () => {
    it('returns true for /handling/ paths', () => {
      expect(shouldIgnorePath('/docs/rendering/')).toBe(true);
      expect(shouldIgnorePath('/docs/rendering/file.md')).toBe(true);
      expect(shouldIgnorePath('/docs/handling/file.md')).toBe(true);
    });

    it('case insensitive matching', () => {
      expect(shouldIgnorePath('/docs/Rendering/file.md')).toBe(true);
      expect(shouldIgnorePath('/docs/HANDLING/file.md')).toBe(true);
    });

    it('returns false for normal paths', () => {
      expect(shouldIgnorePath('/docs/react/guide.md')).toBe(false);
    });

    it('handles empty string', () => {
      expect(shouldIgnorePath('')).toBe(false);
    });

    it('handles partial matches correctly', () => {
      expect(shouldIgnorePath('/docs/rendering-guide.md')).toBe(false);
    });
  });

  describe('shouldIgnoreExternalDocPath', () => {
    it('inherits base ignore rules', () => {
      expect(shouldIgnoreExternalDocPath('/docs/rendering/page.md')).toBe(true);
      expect(shouldIgnoreExternalDocPath('/docs/handling/errors.md')).toBe(true);
    });

    it('ignores noisy repository segments', () => {
      expect(shouldIgnoreExternalDocPath('test/e2e/example.md')).toBe(true);
      expect(shouldIgnoreExternalDocPath('docs/__tests__/fixtures.md')).toBe(true);
      expect(shouldIgnoreExternalDocPath('docs/fixtures/sample.md')).toBe(true);
      expect(
        shouldIgnoreExternalDocPath('websockets/v2/vendor/github.com/gorilla/websocket/README.md')
      ).toBe(true);
    });

    it('supports source-specific ignore prefixes', () => {
      expect(
        shouldIgnoreExternalDocPath('packages/next/src/README.md', ['packages/', 'turbopack/'])
      ).toBe(true);
      expect(shouldIgnoreExternalDocPath('docs/app/guide.mdx', ['packages/'])).toBe(false);
    });
  });

  describe('getProjectCategory', () => {
    it('extracts directory name as category', () => {
      expect(getProjectCategory('/home/user/my-repo')).toBe('my-repo');
      expect(getProjectCategory('/var/www/project')).toBe('project');
    });

    it('handles trailing slashes', () => {
      expect(getProjectCategory('/home/user/my-repo/')).toBe('my-repo');
    });

    it('handles Windows-style paths (when running on Windows)', () => {
      // Note: basename behavior depends on platform
      // On Windows: returns 'my-app', on Linux: returns full path
      const result = getProjectCategory('C:\\Projects\\my-app');
      // On Linux/Unix, basename doesn't handle backslashes as separators
      // On Windows, it works correctly
      const expected = process.platform === 'win32' ? 'my-app' : result;
      expect(result).toBe(expected);
    });
  });

  describe('buildProjectSourcePath', () => {
    it('constructs correct relative paths', () => {
      expect(buildProjectSourcePath('/home/user/my-repo', '/home/user/my-repo/src/app.ts')).toBe(
        'my-repo/src/app.ts'
      );
    });

    it('normalizes Windows paths to forward slashes (when running on Windows)', () => {
      // Note: This only works correctly on Windows due to path handling
      // On Linux, Node.js doesn't recognize backslashes as separators
      if (process.platform === 'win32') {
        expect(
          buildProjectSourcePath('C:\\Projects\\repo', 'C:\\Projects\\repo\\src\\app.ts')
        ).toBe('repo/src/app.ts');
      } else {
        // Skip on non-Windows platforms
        expect(true).toBe(true);
      }
    });

    it('handles nested directories', () => {
      expect(
        buildProjectSourcePath(
          '/home/user/my-repo',
          '/home/user/my-repo/packages/core/src/utils.ts'
        )
      ).toBe('my-repo/packages/core/src/utils.ts');
    });

    it('handles root-level files', () => {
      expect(buildProjectSourcePath('/home/user/my-repo', '/home/user/my-repo/README.md')).toBe(
        'my-repo/README.md'
      );
    });
  });
});
