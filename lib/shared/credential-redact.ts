/**
 * @module credential-redact
 * @description Credential redaction for safe error/output formatting.
 *
 * Composes with project-security's redactSensitiveContent for comprehensive
 * coverage of credentials in free-form text (error messages, log output, etc.).
 *
 * Additional patterns beyond project-security:
 * - Generic URL userinfo (any protocol, not just DB schemes)
 * - Sensitive query parameter values (api_key, token, etc.)
 *
 * @example
 * import { formatErrorForOutput } from './credential-redact.js';
 *
 * const safe = formatErrorForOutput(
 *   new Error('connection to postgres://user:pass@host:5432/db failed')
 * );
 * // "connection to postgres://user:[REDACTED:database-url-password]@host:5432/db failed"
 */

import { redactSensitiveContent } from './project-security.js';

/**
 * Pattern to redact URL userinfo (user:password) in any protocol URL.
 *
 * This pattern:
 * - Matches only URLs with a non-empty password (user:pass@host)
 * - Skips already-redacted passwords (avoids double-redacting URLs already
 *   handled by project-security's database-url-password pattern)
 *
 * Covers protocols NOT matched by project-security's database-url-password
 * pattern (which targets postgresql|mysql|mongodb|redis).
 *
 * Examples matched:
 *   https://user:pass@host/path
 *   ftp://user:pass@host/file
 *   custom://user:pass@host
 *
 * Examples NOT matched (correctly):
 *   https://user@host/path                — no password
 *   postgresql://user:[REDACTED:...]@host — already redacted
 *
 * The entire user:password portion is redacted, preserving protocol and host.
 */
const URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@:\s/]+:(?!\[REDACTED)[^@\s]+@/g;

/**
 * Pattern to redact sensitive query parameter values.
 *
 * Covers parameter names commonly used for credentials in URL query strings
 * that may not be caught by project-security's broader patterns (especially
 * when values are shorter than 16 characters).
 *
 * Examples matched:
 *   ?api_key=value
 *   &token=value
 *   &access_token=value
 *   &refresh_token=value
 *   &client_secret=value
 *   &id_token=value
 *   &password=value
 *   &passwd=value
 *   &pwd=value
 *
 * The parameter name is preserved, only the value is redacted.
 *
 * NOTE: multi-word param names must appear before their single-word base
 * (e.g. `access_token` before `token`) to avoid partial substring matching
 * inside the alternation.
 */
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&])(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd)=([^&\s]*)/gi;

/**
 * Redact credential-like strings from free-form text (error messages, log output, etc.).
 *
 * Two-layer approach:
 * 1. Run project-security's redactSensitiveContent for JWT, bearer/basic auth,
 *    DB URL passwords, API key assignments, password-in-code, etc.
 * 2. Add credential-redact-specific patterns for generic URL userinfo and
 *    sensitive query parameter values left uncovered by the first pass.
 *
 * @param input - The text to redact credentials from
 * @returns Redacted text with credentials replaced by [REDACTED:*] markers
 */
export function redactCredentialText(input: string): string {
  // Layer 1: project-security's comprehensive content redaction
  const layer1 = redactSensitiveContent(input).content;

  // Layer 2: generic URL userinfo (any protocol)
  const layer2 = layer1.replace(URL_USERINFO_PATTERN, '$1[REDACTED:userinfo]@');

  // Layer 3: sensitive query parameter values
  return layer2.replace(SENSITIVE_QUERY_PARAM_PATTERN, '$1$2=[REDACTED:query-param]');
}

/**
 * Format an error for safe external output, redacting any credentials
 * from the error message.
 *
 * This is the credential-aware replacement for simple error-to-string
 * utilities like the inline `summarizeError` in mcp-tool-matrix.
 *
 * @param error - The error to format (unknown)
 * @returns A redacted string representation safe for external output
 *
 * @example
 * const safe = formatErrorForOutput(
 *   new Error('connection to https://admin:secret@api.example.com failed')
 * );
 * // "connection to https://[REDACTED:userinfo]@api.example.com failed"
 */
function formatCauseChain(error: Error): string {
  const parts: string[] = [];
  const seen = new Set<Error>();
  let current: unknown = (error as Error & { cause?: unknown }).cause;
  let depth = 0;
  const MAX_CAUSE_DEPTH = 8;

  while (current instanceof Error) {
    if (seen.has(current)) {
      parts.push('Caused by: [cyclic reference detected]');
      break;
    }
    if (depth >= MAX_CAUSE_DEPTH) {
      parts.push('Caused by: [max depth exceeded]');
      break;
    }
    seen.add(current);
    parts.push(`Caused by: ${redactCredentialText(current.message)}`);
    current = (current as Error & { cause?: unknown }).cause;
    depth++;
  }

  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

export function formatErrorForOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    return redactCredentialText(String(error));
  }

  // Build the redacted message body
  const redactedMessage = redactCredentialText(error.message);

  // Prefix with error name when useful (skip empty name or 'Error' to
  // avoid the "Error: Error: msg" duplication).
  // Always redact credentials from the name before using it as a prefix.
  const safeName = redactCredentialText(error.name);
  const namePrefix =
    safeName && safeName !== 'Error' && safeName !== 'ErrorConstructor' ? `${safeName}: ` : '';

  // Append code suffix if present (Node errno style: ECONNREFUSED, etc.)
  // String codes are run through credential redaction; numeric codes are safe.
  let codeSuffix = '';
  const code = (error as Error & { code?: unknown }).code;
  if (code !== undefined && code !== null) {
    if (typeof code === 'string') {
      codeSuffix = ` (code=${redactCredentialText(code)})`;
    } else if (typeof code === 'number') {
      codeSuffix = ` (code=${code})`;
    }
  }

  const main = `${namePrefix}${redactedMessage}${codeSuffix}`;

  // Append cause chain (unchanged format, cyclic-safe)
  return main + formatCauseChain(error);
}
