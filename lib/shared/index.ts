/**
 * @module lib/shared
 * @description Shared utilities for the RAG-v1 system.
 *
 * This module provides the central import location for shared utilities
 * used across scripts, MCP server, and legacy compatibility surfaces.
 *
 * **Available Utilities:**
 * - `hashing` - Content hashing for change detection
 * - `patterns` - Sensitive file pattern matching
 *
 * **Usage:**
 * ```typescript
 * // Import individual modules
 * import { calculateHash } from '../lib/shared/hashing.js';
 * import { getSensitivePatterns } from '../lib/shared/patterns.js';
 *
 * // Or import from index
 * import { calculateHash, getSensitivePatterns } from '../lib/shared/index.js';
 * ```
 *
 * **Design Principles:**
 * 1. **Single source of truth** - Each utility has one canonical implementation
 * 2. **Re-export pattern** - This module re-exports from implementation locations
 * 3. **Backward compatible** - Old import paths continue to work via re-exports
 * 4. **Platform agnostic** - Utilities work in both Node.js and browser contexts
 */

export { formatErrorForOutput, redactCredentialText } from './credential-redact.js';

// Re-export all utilities from submodules
export { calculateHash, calculateHashAsync } from './hashing.js';
export { DEFAULT_SENSITIVE_PATTERNS, getSensitivePatterns } from './patterns.js';
export {
  buildProjectScopeAdvisory,
  PROJECT_SCOPE_ACK_TOKEN,
  requireProjectScopeAck,
  validateProjectScopeAck,
} from './project-scope-advisory.js';
