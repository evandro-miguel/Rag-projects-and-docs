import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);

const REQUIRED_PUBLIC_FILES = [
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'DEPENDENCY-SECURITY.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD-PARTY-NOTICES.md',
  'THREAT-MODEL.md',
  '.gitleaksignore',
] as const;

describe('release hygiene', () => {
  it.each(REQUIRED_PUBLIC_FILES)('ships a non-empty public artifact: %s', (path) => {
    const file = new URL(path, ROOT);
    expect(statSync(file).isFile()).toBe(true);
    expect(readFileSync(file, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it('keeps the package private and identifies the alpha release contract', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as {
      private?: boolean;
      license?: string;
      version?: string;
      packageManager?: string;
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe('MIT');
    expect(packageJson.version).toMatch(/^0\.1\.0-alpha\.\d+$/);
    expect(packageJson.packageManager).toMatch(/^bun@/);
  });
});
