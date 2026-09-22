/**
 * @module sensitive-patterns
 * @description Configurable sensitive file patterns for ingestion security.
 *
 * This module provides the `getSensitivePatterns()` function that returns
 * an array of RegExp patterns used to block sensitive files during ingestion.
 *
 * **Configuration:**
 * Set `SENSITIVE_PATTERNS` environment variable with comma-separated patterns.
 * Patterns can include flags suffix like `/i` for case-insensitive matching.
 *
 * **Example env var:**
 * ```
 * SENSITIVE_PATTERNS="\.env$,\.pem$,\.key$,secret/i,password/i,token/i,\.credentials\.json$"
 * ```
 *
 * **Default patterns** (used when env var is not set):
 * - `.env`, `.pem`, `.key` files
 * - Files with `secret`, `password`, `token` in name (case-insensitive)
 * - `.credentials.json` files
 *
 * @example
 * import { getSensitivePatterns } from './lib/sensitive-patterns.js';
 *
 * const patterns = getSensitivePatterns();
 * const isSensitive = patterns.some(rx => rx.test(filename));
 */

/**
 * Parse a pattern string into a RegExp.
 *
 * Supports flag suffixes like `/i` for case-insensitive matching.
 * If no flags are specified, defaults to case-insensitive (`i` flag).
 *
 * @param pattern - Pattern string (e.g., `\.env$` or `secret/i`)
 * @returns Compiled RegExp
 */
function parsePattern(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new Error('Empty pattern in SENSITIVE_PATTERNS');
  }

  // Check for flag suffix like /i, /g, etc.
  const flagMatch = trimmed.match(/\/([igmsuy]+)$/);
  if (flagMatch) {
    const patternPart = trimmed.slice(0, -flagMatch[0].length);
    return new RegExp(patternPart, flagMatch[1]);
  }

  // Default to case-insensitive for convenience
  return new RegExp(trimmed, 'i');
}

/**
 * Default sensitive patterns used when SENSITIVE_PATTERNS env var is not set.
 *
 * Blocks files that may contain:
 * - API keys and tokens (.env, .key, .pem)
 * - Credentials (.credentials.json)
 * - Passwords and secrets (filename patterns)
 */
const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /\.env$/,
  /\.pem$/,
  /\.key$/,
  /secret/i,
  /password/i,
  /token/i,
  /\.credentials\.json$/,
];

/**
 * Get sensitive file patterns from environment or defaults.
 *
 * Reads `SENSITIVE_PATTERNS` environment variable if set, parsing
 * comma-separated patterns into RegExp objects. Falls back to
 * DEFAULT_SENSITIVE_PATTERNS if not configured.
 *
 * @returns Array of RegExp patterns for sensitive file detection
 *
 * @example
 * // With SENSITIVE_PATTERNS="\.env$,secret/i"
 * const patterns = getSensitivePatterns();
 * // Returns: [/\.env$/, /secret/i]
 *
 * @example
 * // Without SENSITIVE_PATTERNS env var
 * const patterns = getSensitivePatterns();
 * // Returns: DEFAULT_SENSITIVE_PATTERNS array
 */
export function getSensitivePatterns(): RegExp[] {
  const envPatterns = process.env.SENSITIVE_PATTERNS;

  if (!envPatterns) {
    return DEFAULT_SENSITIVE_PATTERNS;
  }

  const patterns = envPatterns
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => parsePattern(p));

  // If all patterns were invalid/empty, fall back to defaults
  if (patterns.length === 0) {
    return DEFAULT_SENSITIVE_PATTERNS;
  }

  return patterns;
}

/**
 * Default patterns for testing or direct import.
 */
export { DEFAULT_SENSITIVE_PATTERNS };
