import { describe, expect, it } from 'vitest';
import { formatErrorForOutput, redactCredentialText } from './credential-redact.js';

// All fixtures are synthetic — never real credentials or secrets.

describe('redactCredentialText', () => {
  describe('URL userinfo (generic, any protocol)', () => {
    it('redacts password in an HTTPS URL', () => {
      const result = redactCredentialText('https://admin:vo5secreta@api.example.com/v1/data');
      expect(result).toBe('https://[REDACTED:userinfo]@api.example.com/v1/data');
    });

    it('redacts password in an FTP URL', () => {
      const result = redactCredentialText('ftp://mirror:vo5secreta@files.example.com/release.iso');
      expect(result).toBe('ftp://[REDACTED:userinfo]@files.example.com/release.iso');
    });

    it('redacts userinfo in a custom-scheme URL', () => {
      const result = redactCredentialText('custom+scheme://app:vo5secreta@service.internal/route');
      expect(result).toBe('custom+scheme://[REDACTED:userinfo]@service.internal/route');
    });

    it('preserves a URL that has no userinfo', () => {
      const input = 'https://api.example.com/v1/health';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('preserves a URL with only a username but no password', () => {
      const input = 'https://nobody@api.example.com/guest';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('redacts postgres:// URLs (without ql suffix) via generic URL userinfo pattern', () => {
      const input = 'postgres://user:secret@127.0.0.1/db';
      const result = redactCredentialText(input);
      expect(result).toContain('[REDACTED:userinfo]');
      expect(result).toContain('127.0.0.1');
      expect(result).toContain('/db');
      expect(result).not.toContain('secret');
      expect(result).not.toContain('user:secret');
    });
  });

  describe('query parameter credential values', () => {
    it('redacts api_key query param value', () => {
      const input = 'https://example.com/data?api_key=syn-abc-123-def-456'; // gitleaks:allow
      const result = redactCredentialText(input);
      expect(result).toBe('https://example.com/data?api_key=[REDACTED:query-param]');
    });

    it('redacts token query param value', () => {
      const input = 'https://example.com/data?token=syn-token-value';
      const result = redactCredentialText(input);
      expect(result).toBe('https://example.com/data?token=[REDACTED:query-param]');
    });

    it('redacts access_token query param value', () => {
      const input = 'https://example.com/data?access_token=syn-access-value';
      const result = redactCredentialText(input);
      expect(result).toBe('https://example.com/data?access_token=[REDACTED:query-param]');
    });

    it('redacts secret query param value', () => {
      const input = 'https://example.com/data?secret=syn-secret-value';
      const result = redactCredentialText(input);
      expect(result).toBe('https://example.com/data?secret=[REDACTED:query-param]');
    });

    it('preserves a non-sensitive query param', () => {
      const input = 'https://example.com/data?format=json&page=1';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('redacts only the sensitive param when mixed with safe params', () => {
      const result = redactCredentialText(
        'https://example.com/data?api_key=syn-value-123&format=json&page=1'
      );
      expect(result).toContain('format=json');
      expect(result).toContain('page=1');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).not.toContain('syn-value-123');
    });

    // --- New N1 params: refresh_token, client_secret, id_token, password, passwd, pwd ---

    it('redacts refresh_token query param value (underscore variant)', () => {
      const input =
        'https://auth.example.com/token?refresh_token=syn-rt-abc-def&grant_type=refresh_token';
      const result = redactCredentialText(input);
      expect(result).toContain('refresh_token=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).toContain('grant_type=refresh_token');
      expect(result).toContain('auth.example.com');
      expect(result).not.toContain('syn-rt-abc-def');
    });

    it('redacts refresh-token query param value (hyphen variant)', () => {
      const input = 'https://auth.example.com/token?refresh-token=syn-rt-xyz-789';
      const result = redactCredentialText(input);
      expect(result).toContain('refresh-token=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).not.toContain('syn-rt-xyz-789');
    });

    it('redacts client_secret query param value', () => {
      const input = 'https://api.example.com/auth?client_secret=syn-cs-value-12345';
      const result = redactCredentialText(input);
      expect(result).toContain('client_secret=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).toContain('api.example.com');
      expect(result).not.toContain('syn-cs-value-12345');
    });

    it('redacts client-secret query param value (hyphen variant)', () => {
      const input = 'https://api.example.com/auth?client-secret=syn-cs-hyphen-678';
      const result = redactCredentialText(input);
      expect(result).toContain('client-secret=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).not.toContain('syn-cs-hyphen-678');
    });

    it('redacts id_token query param value', () => {
      const input = 'https://auth.example.com/callback?id_token=syn-id-token-value';
      const result = redactCredentialText(input);
      expect(result).toContain('id_token=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).toContain('auth.example.com');
      expect(result).not.toContain('syn-id-token-value');
    });

    it('redacts id-token query param value (hyphen variant)', () => {
      const input = 'https://auth.example.com/callback?id-token=syn-id-hyphen-value';
      const result = redactCredentialText(input);
      expect(result).toContain('id-token=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).not.toContain('syn-id-hyphen-value');
    });

    it('redacts password query param value', () => {
      const input = 'https://example.com/login?password=syn-p455word&user=admin';
      const result = redactCredentialText(input);
      expect(result).toContain('password=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).toContain('user=admin');
      expect(result).toContain('example.com');
      expect(result).not.toContain('syn-p455word');
    });

    it('redacts passwd query param value', () => {
      const input = 'https://example.com/login?passwd=syn-passwd-val&user=admin';
      const result = redactCredentialText(input);
      expect(result).toContain('passwd=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).toContain('user=admin');
      expect(result).not.toContain('syn-passwd-val');
    });

    it('redacts pwd query param value', () => {
      const input = 'https://example.com/login?pwd=syn-pwd-val&user=admin';
      const result = redactCredentialText(input);
      expect(result).toContain('pwd=');
      expect(result).toContain('[REDACTED:query-param]');
      expect(result).not.toContain('syn-pwd-val');
    });
  });

  describe('composed with project-security patterns', () => {
    it('redacts JWT tokens via project-security', () => {
      // Synthetic JWT-like string — not a real token
      const fakeJwt =
        'eyJzZXNzaW9uIjoiZmFrZS1zZXNzaW9uLWlkIn0.eyJ1c2VyIjoiZmFrZS11c2VyIn0.fake-signature-data-here'; // gitleaks:allow
      const result = redactCredentialText(`Auth: ${fakeJwt}`);
      expect(result).toContain('[REDACTED:jwt-token]');
      expect(result).not.toContain(fakeJwt);
    });

    it('redacts Bearer tokens via project-security', () => {
      const result = redactCredentialText(
        'Authorization: Bearer syn-bearer-value-abcdef1234567890'
      );
      expect(result).toContain('[REDACTED:bearer-token]');
      expect(result).toContain('Authorization:');
    });

    it('redacts Basic auth via project-security', () => {
      const result = redactCredentialText(
        'Authorization: Basic c3luLXVzZXI6c3luLXBhc3N3b3JkLWZha2UtdmFsdWU='
      );
      expect(result).toContain('[REDACTED:basic-auth]');
    });

    it('redacts short Basic auth (4-char dTpw = base64 of u:p)', () => {
      const result = redactCredentialText('Authorization: Basic dTpw');
      expect(result).toContain('[REDACTED:basic-auth]');
      expect(result).toContain('Authorization:');
      expect(result).not.toContain('dTpw');
    });

    it('redacts Bearer tokens containing RFC 6750 special chars (/ + ~)', () => {
      const result = redactCredentialText('Authorization: Bearer ab/~+c123');
      expect(result).toContain('[REDACTED:bearer-token]');
      expect(result).toContain('Authorization:');
      expect(result).not.toContain('ab/~+c123');
    });

    it.each([
      ['Bearer a1', 'Authorization: Bearer a1'],
      ['Bearer 123', 'Authorization: Bearer 123'],
      ['Bearer x-y', 'Authorization: Bearer x-y'],
      ['Bearer a/b', 'Authorization: Bearer a/b'],
      ['Bearer 1', 'Authorization: Bearer 1'],
    ])('redacts short %s tokens (1-3 chars)', (_, input) => {
      const result = redactCredentialText(input);
      expect(result).toContain('[REDACTED:bearer-token]');
      expect(result).toContain('Authorization:');
    });

    it('preserves "Bearer token missing" message without false positive', () => {
      const input = 'Error: Bearer token missing from request';
      const result = redactCredentialText(input);
      expect(result).toBe(input);
      expect(result).not.toContain('[REDACTED:bearer-token]');
    });

    it('preserves "Bearer" followed only by common English words', () => {
      const input = 'Authorization: Bearer invalid';
      const result = redactCredentialText(input);
      expect(result).toBe(input);
      expect(result).not.toContain('[REDACTED:bearer-token]');
    });

    it('redacts postgres connection string password via project-security', () => {
      const input = 'postgresql://dbuser:syn-db-pass-9999@pg.example.com:5432/mydb';
      const result = redactCredentialText(input);
      expect(result).toContain('[REDACTED:database-url-password]');
      expect(result).toContain('pg.example.com');
      expect(result).toContain('mydb');
      expect(result).not.toContain('syn-db-pass-9999');
    });

    it('redacts api_key assignments via project-security when value is 16+ chars', () => {
      const result = redactCredentialText('api_key = "abcdefghijklmnopqrstuvwx"');
      expect(result).toContain('[REDACTED:generic-api-key]');
    });

    it('preserves non-secret code text', () => {
      const input = 'const port = 3000;\napp.listen(port);\nconsole.log("ready");';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('redacts sk-proj- OpenAI-style API key via composition', () => {
      const result = redactCredentialText('Incorrect API key provided: sk-proj-abc123DEF456'); // gitleaks:allow
      expect(result).toContain('[REDACTED:openai-api-key]');
      expect(result).toContain('Incorrect API key provided:');
      expect(result).not.toContain('sk-proj-abc123DEF456');
    });

    it('redacts sk-test- OpenAI-style API key via composition', () => {
      const result = redactCredentialText('Invalid key: sk-test-key-abc-12345'); // gitleaks:allow
      expect(result).toContain('[REDACTED:openai-api-key]');
      expect(result).toContain('Invalid key:');
      expect(result).not.toContain('sk-test-key-abc-12345');
    });

    it('redacts standard sk- OpenAI-style API key via composition', () => {
      const result = redactCredentialText('key sk-abcdefghijklmnopqrst'); // gitleaks:allow
      expect(result).toContain('[REDACTED:openai-api-key]');
      expect(result).not.toContain('sk-abcdefghijklmnopqrst');
    });
  });

  describe('preservation of safe content', () => {
    it('preserves HTTP status codes', () => {
      const input = 'Request failed with status 403 Forbidden';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('preserves error codes', () => {
      const input = 'Error: ENOENT, no such file or directory';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('preserves ECONNREFUSED error code', () => {
      const input = 'Error: connect ECONNREFUSED 127.0.0.1:5432';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('preserves READ_DEADLINE_EXCEEDED error code', () => {
      const input = 'ReadDeadlineError: READ_DEADLINE_EXCEEDED';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('preserves hostnames', () => {
      const input = 'connection refused by db.internal.example.com:5432';
      expect(redactCredentialText(input)).toBe(input);
    });

    it('preserves plain text without any credentials', () => {
      const input = 'All systems operational.';
      expect(redactCredentialText(input)).toBe(input);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(redactCredentialText('')).toBe('');
    });

    it('handles whitespace-only string', () => {
      expect(redactCredentialText('   ')).toBe('   ');
    });

    it('handles single character', () => {
      expect(redactCredentialText('a')).toBe('a');
    });
  });
});

describe('formatErrorForOutput', () => {
  it('redacts credentials from Error instance messages', () => {
    const error = new Error('connection to https://admin:syn-admin-pass@db.example.com failed');
    const result = formatErrorForOutput(error);
    expect(result).toContain('connection to');
    expect(result).toContain('[REDACTED:userinfo]');
    expect(result).toContain('db.example.com');
    expect(result).not.toContain('syn-admin-pass');
  });

  it('handles non-Error values by converting to string', () => {
    expect(formatErrorForOutput('just a plain string')).toBe('just a plain string');
    expect(formatErrorForOutput(42)).toBe('42');
    expect(formatErrorForOutput(null)).toBe('null');
    expect(formatErrorForOutput(undefined)).toBe('undefined');
  });

  it('preserves non-secret error details', () => {
    const error = new Error('Request failed with status 404: resource not found');
    const result = formatErrorForOutput(error);
    expect(result).toContain('404');
    expect(result).toContain('resource not found');
  });

  it('handles Error with empty message', () => {
    expect(formatErrorForOutput(new Error())).toBe('');
  });

  it('redacts OpenAI-style API key from Error message', () => {
    const error = new Error('Incorrect API key provided: sk-proj-abc123DEF456'); // gitleaks:allow
    const result = formatErrorForOutput(error);
    expect(result).toContain('Incorrect API key provided:');
    expect(result).toContain('[REDACTED:openai-api-key]');
    expect(result).not.toContain('sk-proj-abc123DEF456');
  });

  it('redacts sk-test- API key from Error message', () => {
    const error = new Error('Invalid key: sk-test-key-abc-12345'); // gitleaks:allow
    const result = formatErrorForOutput(error);
    expect(result).toContain('Invalid key:');
    expect(result).toContain('[REDACTED:openai-api-key]');
    expect(result).not.toContain('sk-test-key-abc-12345');
  });

  it('preserves message text around redacted OpenAI key', () => {
    const error = new Error(
      'Incorrect API key provided: sk-proj-abc123DEF456. Please check your key and try again.' // gitleaks:allow
    );
    const result = formatErrorForOutput(error);
    expect(result).toContain('Incorrect API key provided:');
    expect(result).toContain('[REDACTED:openai-api-key]');
    expect(result).toContain('Please check your key and try again.');
    expect(result).not.toContain('sk-proj-abc123DEF456');
  });

  it('redacts credentials from nested error messages', () => {
    const inner = new Error('PG connection postgresql://admin:syn-secret@pg.internal/app');
    const outer = new Error(`Wrapped: ${inner.message}`);
    const result = formatErrorForOutput(outer);
    expect(result).toContain('Wrapped:');
    expect(result).toContain('[REDACTED:database-url-password]');
    expect(result).toContain('pg.internal');
    expect(result).not.toContain('syn-secret');
  });

  it('redacts credentials from Error.cause chain', () => {
    const inner = new Error('PG connection postgresql://admin:syn-secret@pg.internal/app');
    const middle = new Error('database pool timeout', { cause: inner });
    const outer = new Error('health check failed', { cause: middle });
    const result = formatErrorForOutput(outer);
    expect(result).toContain('health check failed');
    expect(result).toContain('Caused by:');
    expect(result).toContain('database pool timeout');
    expect(result).toContain('[REDACTED:database-url-password]');
    expect(result).toContain('pg.internal');
    expect(result).not.toContain('syn-secret');
  });

  it('handles Error.cause that is a non-Error value', () => {
    const err = new Error('fetch failed', { cause: 'network error' });
    const result = formatErrorForOutput(err);
    expect(result).toBe('fetch failed');
  });

  it('terminates on self-cyclic Error.cause', () => {
    const err = new Error('self cycle');
    (err as Error & { cause?: unknown }).cause = err;
    const result = formatErrorForOutput(err);
    expect(result).toContain('self cycle');
    expect(result).toContain('Caused by:');
    expect(result).toContain('[cyclic reference detected]');
  });

  it('terminates on two-node cyclic Error.cause chain', () => {
    const inner = new Error('inner error');
    const outer = new Error('outer error');
    (inner as Error & { cause?: unknown }).cause = outer;
    (outer as Error & { cause?: unknown }).cause = inner;
    const result = formatErrorForOutput(outer);
    expect(result).toContain('outer error');
    expect(result).toContain('Caused by:');
    expect(result).toContain('inner error');
    expect(result).toContain('[cyclic reference detected]');
  });

  it('terminates at max depth for deep linear cause chain', () => {
    const errors: Error[] = [];
    for (let index = 0; index < 12; index++) {
      errors.push(new Error(`error ${index}`));
    }
    for (let index = 0; index < 11; index++) {
      (errors[index] as Error & { cause?: unknown }).cause = errors[index + 1];
    }
    const result = formatErrorForOutput(errors[0] as Error);
    expect(result).toContain('error 0');
    expect(result).toContain('Caused by:');
    // Should include at least the first 8 depth entries
    for (let index = 1; index <= 8; index++) {
      expect(result).toContain(`error ${index}`);
    }
    // Should stop before the 9th
    expect(result).not.toContain('error 9');
    expect(result).toContain('[max depth exceeded]');
  });

  // --- N2: additive metadata (name, code) ---

  it('preserves TypeError name prefix (no duplication)', () => {
    const error = new TypeError('Expected string but got number');
    const result = formatErrorForOutput(error);
    expect(result).toContain('TypeError: Expected string but got number');
  });

  it('does not add empty/Error prefix for plain Error', () => {
    const error = new Error('something went wrong');
    const result = formatErrorForOutput(error);
    // Should not become "Error: Error: something went wrong"
    expect(result).not.toMatch(/^Error:\s+Error:/);
    expect(result).toContain('something went wrong');
  });

  it('appends string code suffix (ECONNREFUSED)', () => {
    const error = new Error('connect to 127.0.0.1:5432 failed') as Error & { code?: string };
    error.code = 'ECONNREFUSED';
    const result = formatErrorForOutput(error);
    expect(result).toContain('connect to 127.0.0.1:5432 failed');
    expect(result).toContain('(code=ECONNREFUSED)');
  });

  it('appends numeric code suffix', () => {
    const error = new Error('socket hang up') as Error & { code?: number };
    error.code = 10054;
    const result = formatErrorForOutput(error);
    expect(result).toContain('socket hang up');
    expect(result).toContain('(code=10054)');
  });

  it('redacts secret in message with code still present', () => {
    const error = new Error(
      'https://admin:syn-secret-pass@host.internal/data?api_key=syn-key-value'
    ) as Error & { code?: string };
    error.code = 'ECONNREFUSED';
    const result = formatErrorForOutput(error);
    // Secret redacted
    expect(result).not.toContain('syn-secret-pass');
    expect(result).not.toContain('syn-key-value');
    // Code preserved
    expect(result).toContain('(code=ECONNREFUSED)');
    // Host preserved
    expect(result).toContain('host.internal');
    expect(result).toContain('data');
  });

  it('redacts secret in string code value', () => {
    const error = new Error('auth failed') as Error & { code?: string };
    // Use a 16-char value after '=' to trigger project-security's generic-api-key
    error.code = 'api_key=abcdefghijklmnop';
    const result = formatErrorForOutput(error);
    expect(result).not.toContain('abcdefghijklmnop');
    expect(result).toContain('(code=');
    expect(result).toContain('[REDACTED:generic-api-key]');
  });

  it('omits code suffix when code is undefined', () => {
    const error = new Error('generic failure');
    const result = formatErrorForOutput(error);
    expect(result).not.toContain('(code=');
    expect(result).toBe('generic failure');
  });

  it('omits code suffix when code is null', () => {
    const error = new Error('generic failure') as Error & { code?: null };
    error.code = null;
    const result = formatErrorForOutput(error);
    expect(result).not.toContain('(code=');
    expect(result).toBe('generic failure');
  });

  it('does not dump stack frames in output', () => {
    const error = new Error('something broke');
    const result = formatErrorForOutput(error);
    expect(result).not.toContain('at ');
    expect(result).not.toContain('stack');
    expect(result).not.toContain('/lib/shared/');
  });

  // --- N1: credential redaction in custom error names ---

  it('redacts api_key=secret from custom error name', () => {
    const error = new Error('db connection failed');
    Object.defineProperty(error, 'name', {
      value: 'api_key=abcdefghijklmnop',
      configurable: true,
    });
    const result = formatErrorForOutput(error);
    expect(result).not.toContain('abcdefghijklmnop');
    expect(result).toContain('[REDACTED:generic-api-key]');
    expect(result).toContain('db connection failed');
  });

  it('redacts sk-proj-xxx from custom error name', () => {
    const error = new Error('OpenAI call failed');
    Object.defineProperty(error, 'name', {
      value: 'sk-proj-abc123DEF456',
      configurable: true,
    });
    const result = formatErrorForOutput(error);
    expect(result).not.toContain('sk-proj-abc123DEF456');
    expect(result).toContain('[REDACTED:openai-api-key]');
    expect(result).toContain('OpenAI call failed');
  });

  it('redacts api_key query param from custom error name', () => {
    const error = new Error('API failure');
    Object.defineProperty(error, 'name', {
      value: '?api_key=sk-proj-xxx',
      configurable: true,
    });
    const result = formatErrorForOutput(error);
    expect(result).not.toContain('sk-proj-xxx');
    expect(result).toContain('[REDACTED:');
    expect(result).toContain('API failure');
  });

  it('redacts Bearer token from custom error name', () => {
    const error = new Error('auth failure');
    Object.defineProperty(error, 'name', {
      value: 'Authorization: Bearer syn-bearer-leaked-name',
      configurable: true,
    });
    const result = formatErrorForOutput(error);
    expect(result).not.toContain('syn-bearer-leaked-name');
    expect(result).toContain('[REDACTED:bearer-token]');
    expect(result).toContain('auth failure');
  });

  it('name prefix + code suffix + redacted message all compose', () => {
    const error = new TypeError(
      'request to https://admin:syn-pass@host.com?password=guess failed'
    ) as Error & { code?: string };
    error.code = 'ECONNRESET';
    const result = formatErrorForOutput(error);
    expect(result).toContain('TypeError: request to');
    expect(result).toContain('[REDACTED:userinfo]');
    expect(result).toContain('[REDACTED:query-param]');
    expect(result).toContain('host.com');
    expect(result).toContain('(code=ECONNRESET)');
    expect(result).not.toContain('syn-pass');
    expect(result).not.toContain('guess');
    expect(result).not.toContain('at ');
  });
});
