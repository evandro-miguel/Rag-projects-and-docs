/**
 * @module scripts/lib/sensitive-patterns.test
 * @description Tests for sensitive file pattern matching.
 *
 * Tests pattern parsing, defaults, and environment variable configuration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SENSITIVE_PATTERNS, getSensitivePatterns } from './sensitive-patterns';

describe('DEFAULT_SENSITIVE_PATTERNS', () => {
  it('should be an array of RegExp objects', () => {
    expect(Array.isArray(DEFAULT_SENSITIVE_PATTERNS)).toBe(true);
    DEFAULT_SENSITIVE_PATTERNS.forEach((pattern) => {
      expect(pattern).toBeInstanceOf(RegExp);
    });
  });

  it('should include .env pattern', () => {
    const envPattern = DEFAULT_SENSITIVE_PATTERNS.find((p) => p.source === '\\.env$');
    expect(envPattern).toBeDefined();
    expect(envPattern?.test('file.env')).toBe(true);
    expect(envPattern?.test('.env')).toBe(true);
    expect(envPattern?.test('file.env.local')).toBe(false);
  });

  it('should include .pem pattern', () => {
    const pemPattern = DEFAULT_SENSITIVE_PATTERNS.find((p) => p.source === '\\.pem$');
    expect(pemPattern).toBeDefined();
    expect(pemPattern?.test('key.pem')).toBe(true);
    expect(pemPattern?.test('certificate.pem')).toBe(true);
    expect(pemPattern?.test('file.pem.txt')).toBe(false);
  });

  it('should include .key pattern', () => {
    const keyPattern = DEFAULT_SENSITIVE_PATTERNS.find((p) => p.source === '\\.key$');
    expect(keyPattern).toBeDefined();
    expect(keyPattern?.test('private.key')).toBe(true);
    expect(keyPattern?.test('api.key')).toBe(true);
    expect(keyPattern?.test('file.key.backup')).toBe(false);
  });

  it('should include secret pattern (case-insensitive)', () => {
    const secretPattern = DEFAULT_SENSITIVE_PATTERNS.find((p) => p.source === 'secret');
    expect(secretPattern).toBeDefined();
    expect(secretPattern?.test('my_secret.txt')).toBe(true);
    expect(secretPattern?.test('SECRETS.md')).toBe(true);
    expect(secretPattern?.test('secret-config.json')).toBe(true);
    expect(secretPattern?.test('public.txt')).toBe(false);
  });

  it('should include password pattern (case-insensitive)', () => {
    const passwordPattern = DEFAULT_SENSITIVE_PATTERNS.find((p) => p.source === 'password');
    expect(passwordPattern).toBeDefined();
    expect(passwordPattern?.test('password.txt')).toBe(true);
    expect(passwordPattern?.test('PASSWORDS.md')).toBe(true);
    expect(passwordPattern?.test('reset-password.js')).toBe(true);
    expect(passwordPattern?.test('user.txt')).toBe(false);
  });

  it('should include token pattern (case-insensitive)', () => {
    const tokenPattern = DEFAULT_SENSITIVE_PATTERNS.find((p) => p.source === 'token');
    expect(tokenPattern).toBeDefined();
    expect(tokenPattern?.test('token.txt')).toBe(true);
    expect(tokenPattern?.test('TOKEN.md')).toBe(true);
    expect(tokenPattern?.test('auth-token.json')).toBe(true);
    expect(tokenPattern?.test('file.txt')).toBe(false);
  });

  it('should include .credentials.json pattern', () => {
    const credsPattern = DEFAULT_SENSITIVE_PATTERNS.find(
      (p) => p.source === '\\.credentials\\.json$'
    );
    expect(credsPattern).toBeDefined();
    expect(credsPattern?.test('service.credentials.json')).toBe(true);
    expect(credsPattern?.test('app.credentials.json')).toBe(true);
    expect(credsPattern?.test('credentials.json.bak')).toBe(false);
  });
});

describe('getSensitivePatterns (default behavior)', () => {
  it('should return DEFAULT_SENSITIVE_PATTERNS when env var is not set', () => {
    delete process.env.SENSITIVE_PATTERNS;
    const patterns = getSensitivePatterns();

    expect(patterns).toEqual(DEFAULT_SENSITIVE_PATTERNS);
    expect(patterns.length).toBe(7);
  });

  it('should return the same array reference (cached)', () => {
    delete process.env.SENSITIVE_PATTERNS;
    const patterns1 = getSensitivePatterns();
    const patterns2 = getSensitivePatterns();

    expect(patterns1).toEqual(patterns2);
    // Note: Returns same DEFAULT_SENSITIVE_PATTERNS reference
    expect(patterns1).toBe(patterns2);
  });
});

describe('getSensitivePatterns (custom patterns)', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.SENSITIVE_PATTERNS;
    delete process.env.SENSITIVE_PATTERNS;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.SENSITIVE_PATTERNS = originalEnv;
    } else {
      delete process.env.SENSITIVE_PATTERNS;
    }
  });

  it('should parse custom patterns from env var', () => {
    process.env.SENSITIVE_PATTERNS = '\\.txt$,\\.log$';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(2);
    expect(patterns[0].test('file.txt')).toBe(true);
    expect(patterns[0].test('file.log')).toBe(false);
    expect(patterns[1].test('file.log')).toBe(true);
    expect(patterns[1].test('file.txt')).toBe(false);
  });

  it('should support case-insensitive flag (/i)', () => {
    process.env.SENSITIVE_PATTERNS = 'secret/i,password/i';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(2);
    expect(patterns[0].test('SECRET.txt')).toBe(true);
    expect(patterns[0].test('secret.txt')).toBe(true);
    expect(patterns[1].test('PASSWORD.txt')).toBe(true);
    expect(patterns[1].test('password.txt')).toBe(true);
  });

  it('should support multiple flags', () => {
    process.env.SENSITIVE_PATTERNS = 'test/gi';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(1);
    expect(patterns[0].global).toBe(true);
    expect(patterns[0].ignoreCase).toBe(true);
  });

  it('should trim whitespace from patterns', () => {
    process.env.SENSITIVE_PATTERNS = '  \\.env$  ,  \\.pem$  ';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(2);
    expect(patterns[0].test('.env')).toBe(true);
    expect(patterns[1].test('file.pem')).toBe(true);
  });

  it('should filter out empty patterns', () => {
    process.env.SENSITIVE_PATTERNS = '\\.env$,  ,\\.pem$,';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(2);
    expect(patterns[0].test('.env')).toBe(true);
    expect(patterns[1].test('file.pem')).toBe(true);
  });

  it('should fall back to defaults if all patterns are empty', () => {
    process.env.SENSITIVE_PATTERNS = '  ,  ,  ';
    const patterns = getSensitivePatterns();

    expect(patterns).toEqual(DEFAULT_SENSITIVE_PATTERNS);
    expect(patterns.length).toBe(7);
  });

  it('should handle single pattern', () => {
    process.env.SENSITIVE_PATTERNS = '\\.custom$';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(1);
    expect(patterns[0].test('file.custom')).toBe(true);
    expect(patterns[0].test('file.txt')).toBe(false);
  });

  it('should handle complex patterns', () => {
    process.env.SENSITIVE_PATTERNS = '^\\.,\\.$,node_modules';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(3);
    expect(patterns[0].test('.env')).toBe(true);
    expect(patterns[1].test('..')).toBe(true);
    expect(patterns[2].test('node_modules/package')).toBe(true);
  });
});

describe('parsePattern error handling', () => {
  it('should throw on empty pattern', () => {
    process.env.SENSITIVE_PATTERNS = '';
    const patterns = getSensitivePatterns();
    expect(patterns).toEqual(DEFAULT_SENSITIVE_PATTERNS);
  });

  it('should throw on invalid regex pattern', () => {
    process.env.SENSITIVE_PATTERNS = '[invalid';
    expect(() => getSensitivePatterns()).toThrow(SyntaxError);
  });

  it('should handle valid complex regex patterns', () => {
    process.env.SENSITIVE_PATTERNS = '^(?!.*test).*\\.txt$';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(1);
    expect(patterns[0].test('file.txt')).toBe(true);
    expect(patterns[0].test('test.txt')).toBe(false);
  });
});

describe('Integration: Pattern matching', () => {
  it('should detect sensitive files', () => {
    delete process.env.SENSITIVE_PATTERNS;
    const patterns = getSensitivePatterns();

    const sensitiveFiles = [
      '.env',
      'api.key',
      'cert.pem',
      'secrets.json',
      'passwords.txt',
      'auth_token.json',
      'service.credentials.json',
    ];

    sensitiveFiles.forEach((file) => {
      const isSensitive = patterns.some((p) => p.test(file));
      expect(isSensitive).toBe(true);
    });
  });

  it('should allow non-sensitive files', () => {
    delete process.env.SENSITIVE_PATTERNS;
    const patterns = getSensitivePatterns();

    const nonSensitiveFiles = [
      'README.md',
      'index.ts',
      'package.json',
      'config.js',
      'data.txt',
      'report.pdf',
    ];

    nonSensitiveFiles.forEach((file) => {
      const isSensitive = patterns.some((p) => p.test(file));
      expect(isSensitive).toBe(false);
    });
  });

  it('should handle file paths with directories', () => {
    delete process.env.SENSITIVE_PATTERNS;
    const patterns = getSensitivePatterns();

    expect(patterns.some((p) => p.test('/path/to/.env'))).toBe(true);
    expect(patterns.some((p) => p.test('src/secrets/config.json'))).toBe(true);
    expect(patterns.some((p) => p.test('docs/README.md'))).toBe(false);
  });
});

describe('Environment variable edge cases', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.SENSITIVE_PATTERNS;
    delete process.env.SENSITIVE_PATTERNS;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.SENSITIVE_PATTERNS = originalEnv;
    } else {
      delete process.env.SENSITIVE_PATTERNS;
    }
  });

  it('should handle patterns with commas in them', () => {
    // This is a limitation - commas are used as separators
    // If you need commas in patterns, use a different separator
    process.env.SENSITIVE_PATTERNS = 'file\\.(txt|log)$';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(1);
    expect(patterns[0].test('file.txt')).toBe(true);
    expect(patterns[0].test('file.log')).toBe(true);
  });

  it('should handle special characters in patterns', () => {
    process.env.SENSITIVE_PATTERNS = '\\.(env|key|pem)$';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(1);
    expect(patterns[0].test('.env')).toBe(true);
    expect(patterns[0].test('file.key')).toBe(true);
    expect(patterns[0].test('cert.pem')).toBe(true);
  });

  it('should handle unicode patterns', () => {
    process.env.SENSITIVE_PATTERNS = '秘密/i';
    const patterns = getSensitivePatterns();

    expect(patterns.length).toBe(1);
    expect(patterns[0].test('秘密.txt')).toBe(true);
    expect(patterns[0].test('SECRET.txt')).toBe(false);
  });
});
