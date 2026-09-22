import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECRET_PATTERNS,
  checkFileSecurity,
  redactSensitiveContent,
} from './project-security.js';

describe('project-security provider scope', () => {
  it('does not register AWS-specific content detectors', () => {
    expect(CONTENT_SECRET_PATTERNS.some((pattern) => pattern.id.startsWith('aws-'))).toBe(false);
  });

  it('keeps provider-neutral credential detectors active', () => {
    const patternIds = new Set(CONTENT_SECRET_PATTERNS.map((pattern) => pattern.id));
    expect(patternIds.has('private-key')).toBe(true);
    expect(patternIds.has('generic-api-key')).toBe(true);
    expect(patternIds.has('database-url-password')).toBe(true);
    expect(patternIds.has('bearer-token')).toBe(true);
  });
});

describe('project-security integration', () => {
  it('does not block files with SHA1 hashes in content', () => {
    const content = "const hash = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';";
    const result = checkFileSecurity('src/hash.ts', content, '/project');
    expect(result.blocked).toBe(false);
  });

  it('does not block files with git commit references', () => {
    const content = 'See commit abc123def456abc123def456abc123def456abc1 for context.';
    const result = checkFileSecurity('src/history.ts', content, '/project');
    expect(result.blocked).toBe(false);
  });

  it('redacts credential values without dropping the surrounding file', () => {
    const rawValue = 'example_api_value_1234567890';
    const result = redactSensitiveContent(
      `export const config = { api_key: "${rawValue}", enabled: true };`
    );

    expect(result.content).not.toContain(rawValue);
    expect(result.content).toContain('[REDACTED:generic-api-key]');
    expect(result.content).toContain('enabled: true');
    expect(result.count).toBe(1);
    expect(result.patternIds).toEqual(['generic-api-key']);
  });

  it('preserves JavaScript assignment syntax around a redacted credential', () => {
    const result = redactSensitiveContent('const apiKey = "abcdefghijklmnop";');

    expect(result.content).toBe('const apiKey = "[REDACTED:generic-api-key]";');
  });

  it.each([
    ['const authToken = "abcdefghijklmnop";', 'const authToken = "[REDACTED:auth-token]";'],
    ['const password = "abcdefgh";', 'const password = "[REDACTED:password-in-code]";'],
    ['const secretKey = "abcdefghijklmnop";', 'const secretKey = "[REDACTED:secret-in-code]";'],
    [
      'const authorization = "Bearer abcdefghijklmnopqrst";',
      'const authorization = "Bearer [REDACTED:bearer-token]";',
    ],
  ])('preserves code around each assignment-style detector', (content, expected) => {
    expect(redactSensitiveContent(content).content).toBe(expected);
  });

  it('redacts short 1-3 char Bearer tokens with non-alpha chars', () => {
    const result = redactSensitiveContent('Authorization: Bearer a1');
    expect(result.content).toContain('[REDACTED:bearer-token]');
    expect(result.content).toContain('Authorization:');
    expect(result.content).not.toContain('a1');
  });

  it('redacts single-char Bearer token that is a digit', () => {
    const result = redactSensitiveContent('Authorization: Bearer 1');
    expect(result.content).toContain('[REDACTED:bearer-token]');
    expect(result.content).toContain('Authorization:');
  });

  it.each([
    'Authorization: Bearer token',
    'Error: Bearer token missing',
    'Error: Bearer invalid',
  ])('preserves "%s" without false positive', (input) => {
    const result = redactSensitiveContent(input);
    expect(result.content).not.toContain('[REDACTED:bearer-token]');
    expect(result.count).toBe(0);
  });

  it('redacts a sk-proj- OpenAI-style API key in error message', () => {
    const input = 'Incorrect API key provided: sk-proj-abc123DEF456'; // gitleaks:allow
    const result = redactSensitiveContent(input);
    expect(result.content).toContain('[REDACTED:openai-api-key]');
    expect(result.content).toContain('Incorrect API key provided:');
    expect(result.content).not.toContain('sk-proj-abc123DEF456');
    expect(result.count).toBe(1);
  });

  it('redacts an sk-test- OpenAI-style key', () => {
    const input = 'Invalid key: sk-test-key-abc-12345'; // gitleaks:allow
    const result = redactSensitiveContent(input);
    expect(result.content).toContain('[REDACTED:openai-api-key]');
    expect(result.content).toContain('Invalid key:');
    expect(result.content).not.toContain('sk-test-key-abc-12345');
    expect(result.count).toBe(1);
  });

  it('redacts a standard sk- OpenAI-style key', () => {
    const input = 'Expired key sk-abcdefghijklmnopqrst'; // 22 chars after sk-
    const result = redactSensitiveContent(input);
    expect(result.content).toContain('[REDACTED:openai-api-key]');
    expect(result.content).not.toContain('sk-abcdefghijklmnopqrst');
    expect(result.count).toBe(1);
  });

  it('preserves surrounding message text when redacting OpenAI-style keys', () => {
    const result = redactSensitiveContent(
      'Error: Incorrect API key provided: sk-proj-abc123DEF456. Please check your key and try again.' // gitleaks:allow
    );
    expect(result.content).toContain('Error: Incorrect API key provided:');
    expect(result.content).toContain('[REDACTED:openai-api-key]');
    expect(result.content).toContain('Please check your key and try again.');
    expect(result.content).not.toContain('sk-proj-abc123DEF456');
  });

  it('does not redact short sk- strings that are not keys (7 chars or less)', () => {
    const result = redactSensitiveContent('Use the sk-etcher tool for sketching');
    expect(result.content).not.toContain('[REDACTED:openai-api-key]');
    expect(result.count).toBe(0);
  });

  it('redacts an entire embedded private-key block', () => {
    const result = redactSensitiveContent(
      'before\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\nafter' // gitleaks:allow
    );

    expect(result.content).toBe('before\n[REDACTED:private-key]\n\n\nafter');
    expect(result.content).not.toContain('private-material');
  });

  it('preserves the exact LF/CRLF line-break sequence after multiline redaction', () => {
    const input =
      'before\r\n-----BEGIN PRIVATE KEY-----\r\nprivate-material\n-----END PRIVATE KEY-----\r\nafter';
    const lineBreaks = (value: string) => (value.match(/\r\n|\r|\n/gu) ?? []).join('');
    const result = redactSensitiveContent(input);

    expect(lineBreaks(result.content)).toBe(lineBreaks(input));
    expect(result.content).toContain('[REDACTED:private-key]');
    expect(result.content).not.toContain('private-material');
    expect(result.content).not.toContain('BEGIN PRIVATE KEY');
    expect(result.content).not.toContain('END PRIVATE KEY');
  });
});
