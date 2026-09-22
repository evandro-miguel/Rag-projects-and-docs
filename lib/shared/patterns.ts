/**
 * @module lib/shared/patterns
 * @description Central pattern definitions for ingestion security.
 *
 * This module provides pattern matching utilities used to identify and filter
 * sensitive files during ingestion. All sensitive pattern checks should import
 * from this module for consistency.
 *
 * **Implementation:**
 * The actual implementation lives in `scripts/lib/sensitive-patterns.ts`.
 * This module re-exports that implementation for convenient access.
 *
 * **Patterns Provided:**
 * - `getSensitivePatterns()` - Returns array of RegExp patterns for sensitive files
 * - `DEFAULT_SENSITIVE_PATTERNS` - Default patterns for testing/direct use
 *
 * **Default Patterns Block:**
 * - `.env`, `.pem`, `.key` files
 * - Files with `secret`, `password`, `token` in name
 * - `.credentials.json` files
 *
 * **Customization:**
 * Set `SENSITIVE_PATTERNS` environment variable with comma-separated patterns:
 * ```
 * SENSITIVE_PATTERNS="\.env$,.pem$,secret/i,password/i"
 * ```
 *
 * **Usage:**
 * ```typescript
 * import { getSensitivePatterns } from '../lib/shared/patterns.js';
 *
 * const patterns = getSensitivePatterns();
 * const isSensitive = patterns.some(rx => rx.test(filename));
 * ```
 *
 * **Why this module exists:**
 * - Provides a single import location for pattern utilities
 * - Abstracts the implementation location from consumers
 * - Enables future pattern extensions without breaking imports
 * - Used by both CLI scripts and MCP server
 *
 * @see scripts/lib/sensitive-patterns.ts - Canonical implementation
 */

// Re-export from the canonical source
export {
  DEFAULT_SENSITIVE_PATTERNS,
  getSensitivePatterns,
} from '../../scripts/lib/sensitive-patterns.js';
