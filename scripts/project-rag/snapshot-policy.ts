/**
 * Pure policy helpers for the Project RAG ingest snapshot gate.
 *
 * This module is intentionally free of SQL, MCP, and side-effect imports
 * so it can be used by snapshot-gate.ts, ingest-postgres.ts, and their
 * tests without mocking concerns.
 *
 * snapshot-gate.ts re-exports everything for backward compatibility.
 */

import { createHash } from 'node:crypto';
import type { BlockedFindingAllowlistEntry, SuppressedBlockedFinding } from './store.js';
import {
  BLOCKED_FINDING_SAMPLE_MAX,
  BLOCKED_FINDING_SAMPLE_PATH_MAX,
  BLOCKED_FINDINGS_MAX,
} from './store.js';

export type { SnapshotFailureCode, SnapshotInitialStatus } from './store.js';
export {
  BLOCKED_FINDING_SAMPLE_MAX,
  BLOCKED_FINDING_SAMPLE_PATH_MAX,
  BLOCKED_FINDINGS_MAX,
  FAILURE_DETAIL_MAX_LENGTH,
} from './store.js';

// ==========================================================================
// Typed error classes (no string-prefix error classification)
// ==========================================================================

/**
 * Thrown when a snapshot lease has been lost (dead / sweep-reclaimed).
 * Uses a stable error code — never match on message prefix.
 */
export class LeaseLostError extends Error {
  readonly code = 'SNAPSHOT_LEASE_LOST';
  constructor(snapshotId: number, detail: string) {
    super(`Snapshot lease lost (id=${snapshotId}): ${detail}`);
    this.name = 'LeaseLostError';
  }
}

/**
 * Thrown when the per-file content hash has changed between preflight
 * scan and write time (TOCTOU drift).
 * Uses a stable error code — never match on message prefix.
 */
export class ContentHashMismatchError extends Error {
  readonly code = 'CONTENT_HASH_MISMATCH';
  readonly sourcePath: string;
  readonly expectedHash: string;
  readonly actualHash: string;
  constructor(sourcePath: string, expectedHash: string, actualHash: string) {
    super(
      `Content hash mismatch for '${sourcePath}': file changed between preflight and write ` +
        `(expected ${expectedHash.slice(0, 12)}..., got ${actualHash.slice(0, 12)}...)`
    );
    this.name = 'ContentHashMismatchError';
    this.sourcePath = sourcePath;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * Thrown when a post-claim rescan reveals a hash or count mismatch.
 * Uses a stable error code — never match on message prefix.
 */
export class SnapshotRescanMismatchError extends Error {
  readonly code = 'SNAPSHOT_RESCAN_MISMATCH';
  readonly mismatchedFields: readonly string[];
  readonly statusChanged: boolean;
  constructor(mismatchedFields: readonly string[], statusChanged: boolean, detail: string) {
    super(`Snapshot rescan mismatch: ${detail}`);
    this.name = 'SnapshotRescanMismatchError';
    this.mismatchedFields = mismatchedFields;
    this.statusChanged = statusChanged;
  }
}

// ==========================================================================
// Deterministic hash helpers (case-sensitive raw bytes, stable sort)
// ==========================================================================

/**
 * Compute a deterministic SHA-256 hex digest from raw UTF-8 bytes.
 *
 * Input is hashed as-is — no lowercasing, no trimming, no normalisation.
 * This guarantees that byte-identical inputs produce identical hashes
 * regardless of locale or platform.
 */
export function deterministicHash(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

/**
 * Compute a deterministic SHA-256 hex digest from a list of strings using
 * stable code-point (UCS) sort via Buffer.compare.
 *
 * Sorts the array by raw UTF-8 byte order before joining with '\n'.
 * Empty arrays produce a fixed hash from the empty string.
 */
export function deterministicHashList(values: readonly string[]): string {
  if (values.length === 0) {
    return deterministicHash('');
  }
  const sorted = [...values].sort((a, b) => {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    return bufA.compare(bufB);
  });
  return deterministicHash(sorted.join('\n'));
}

/**
 * Compute a deterministic SHA-256 hex digest from a JSON-serialisable value.
 *
 * The value is serialised with JSON.stringify (sorted keys via
 * deterministicObjectSort) before hashing so that equivalent objects
 * with different key order produce the same hash.
 */
/**
 * Compute a deterministic SHA-256 hex digest from a blocked-finding
 * allowlist array.
 *
 * Each entry is serialised as `${relativePath}:${category}` and sorted
 * by raw UTF-8 byte order (same as deterministicHashList) before
 * hashing.  An empty array produces the same hash as
 * `deterministicHash('')`, which equals `EMPTY_ALLOWLIST_HASH`.
 */
export function hashBlockedFindingAllowlist(
  entries: readonly BlockedFindingAllowlistEntry[]
): string {
  const canonical = entries.map((e) => `${e.relativePath}:${e.category}`);
  return deterministicHashList(canonical);
}

/**
 * Compute a deterministic SHA-256 hex digest from a suppressed-blocked-findings
 * array (order-independent, for drift detection between prepare and rescan).
 *
 * Each entry is serialised as `${relativePath}:${category}:${mae.relativePath}:${mae.category}`
 * and sorted by raw UTF-8 byte order before hashing.
 */
export function hashSuppressedBlockedFindings(
  entries: readonly SuppressedBlockedFinding[]
): string {
  const canonical = entries.map(
    (e) =>
      `${e.relativePath}:${e.category}:${e.matchedAllowlistEntry.relativePath}:${e.matchedAllowlistEntry.category}`
  );
  return deterministicHashList(canonical);
}

export function deterministicHashJson(value: unknown): string {
  const serialised = JSON.stringify(value, deterministicObjectSort);
  return deterministicHash(serialised);
}

/**
 * JSON.stringify replacer that sorts object keys deterministically.
 */
function deterministicObjectSort(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item !== null && typeof item === 'object' ? deterministicObjectSort('', item) : item
    );
  }
  return value;
}

// ==========================================================================
// Blocked-findings validation
// ==========================================================================

/** A single blocked-finding entry (compact, no secrets, no absolute paths). */
export interface BlockedFinding {
  [key: string]: unknown;
  /** Category identifier — safe bounded token (alphanumeric, underscore, dash). */
  readonly category: string;
  /** Number of files or paths matched in this category. */
  readonly count: number;
  /**
   * Optional bounded sample of relative paths.
   * Each path must be relative (no leading `/`, no `..`), no control characters.
   * NEVER store absolute paths, file contents, or secrets.
   */
  readonly sample?: readonly string[];
}

/** Regex for a safe category token: alphanumeric, underscore, dash, dot, colon, forward-slash. */
const SAFE_CATEGORY_RE = /^[a-zA-Z0-9_\-.:/]+$/;

/** Regex for characters that look like absolute paths or parent-dir traversal. */
const ABSOLUTE_OR_TRAVERSAL_RE = /^\/|[\\]|[.][.]\/|^[A-Za-z]:\\/;

/**
 * Regex for control characters (ASCII < 0x20 except \t \n).
 * Built from char codes to avoid lint control-char-in-regex warnings.
 */
const CONTROL_CHAR_RE = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}` +
    `${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}` +
    `${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}]`
);

/**
 * Validate a blocked-findings array.
 *
 * @throws {Error} When validation fails
 */
export function validateBlockedFindings(findings: ReadonlyArray<Record<string, unknown>>): void {
  if (findings.length > BLOCKED_FINDINGS_MAX) {
    throw new Error(
      `Blocked findings count ${findings.length} exceeds max ${BLOCKED_FINDINGS_MAX}`
    );
  }

  for (const f of findings) {
    if (typeof f.category !== 'string' || !SAFE_CATEGORY_RE.test(f.category)) {
      throw new Error(
        `Blocked finding category must be a safe token (alphanumeric/underscore/dash), got '${String(f.category)}'`
      );
    }
    if (typeof f.count !== 'number' || f.count < 0 || !Number.isFinite(f.count)) {
      throw new Error(
        `Blocked finding count must be a non-negative finite number, got ${typeof f.count}`
      );
    }
    if ('sample' in f) {
      if (!Array.isArray(f.sample)) {
        throw new Error('Blocked finding sample must be an array when present');
      }
      if (f.sample.length > BLOCKED_FINDING_SAMPLE_MAX) {
        throw new Error(
          `Blocked finding sample exceeds max length ${BLOCKED_FINDING_SAMPLE_MAX}, got ${f.sample.length}`
        );
      }
      for (const s of f.sample as readonly unknown[]) {
        if (typeof s !== 'string') {
          throw new Error('Blocked finding sample items must be strings');
        }
        if (s.length > BLOCKED_FINDING_SAMPLE_PATH_MAX) {
          throw new Error(
            `Blocked finding sample item exceeds ${BLOCKED_FINDING_SAMPLE_PATH_MAX} chars`
          );
        }
        if (ABSOLUTE_OR_TRAVERSAL_RE.test(s)) {
          throw new Error(`Blocked finding sample path must be relative, got '${s}'`);
        }
        if (CONTROL_CHAR_RE.test(s)) {
          throw new Error('Blocked finding sample path contains control characters');
        }
      }
    }
  }
}

// ==========================================================================
// Threshold helpers
// ==========================================================================

/**
 * Legacy cardinality helper retained for callers that still report the old
 * threshold result. Runtime snapshot gates use {@link refreshRequiresReview},
 * which gates only deletion plans on complete immutable scan evidence.
 *
 * @deprecated Use refreshRequiresReview for mutation authorization.
 */
export function thresholdRequiresReview(totalDelta: number, trackedCount: number): boolean {
  if (trackedCount <= 0) {
    return totalDelta >= 500;
  }
  if (totalDelta >= 500) {
    return true;
  }
  if (totalDelta / trackedCount >= 0.25) {
    return true;
  }
  return false;
}

export interface RefreshPolicyInput {
  readonly addsCount?: number;
  readonly updatesCount?: number;
  readonly deletesCount?: number;
  readonly completenessStatus?: 'complete' | 'incomplete' | 'blocked' | null;
  readonly completenessEvidenceHash?: string | null;
  readonly deletionAllowed?: boolean | null;
}

const COMPLETENESS_EVIDENCE_HASH_RE = /^[0-9a-f]{64}$/;

function validateRefreshCount(value: number | undefined, label: string): number {
  const count = value ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${String(value)}`);
  }
  return count;
}

/** Cardinality never requires review; deletion requires complete evidence. */
export function refreshRequiresReview(input: RefreshPolicyInput): boolean {
  validateRefreshCount(input.addsCount, 'addsCount');
  validateRefreshCount(input.updatesCount, 'updatesCount');
  const deletesCount = validateRefreshCount(input.deletesCount, 'deletesCount');
  if (deletesCount === 0) return false;
  return !(
    input.completenessStatus === 'complete' &&
    typeof input.completenessEvidenceHash === 'string' &&
    COMPLETENESS_EVIDENCE_HASH_RE.test(input.completenessEvidenceHash) &&
    input.deletionAllowed === true
  );
}

// ==========================================================================
// Rescan planning input contracts (no scanner duplication)
// ==========================================================================

/** Input contract for planning a rescan/inventory update. */
export interface RescanPlanInput {
  readonly trackedFiles: ReadonlyArray<{
    readonly sourcePath: string;
    readonly contentHash: string;
  }>;
  readonly candidateFiles: ReadonlyArray<{
    readonly sourcePath: string;
    readonly contentHash: string;
  }>;
}

/** Estimated delta from comparing tracked vs candidate files. */
export interface DeltaEstimate {
  readonly adds: number;
  readonly updates: number;
  readonly deletes: number;
  readonly unchanged: number;
  readonly totalDelta: number;
  readonly trackedCount: number;
}

/**
 * Compute an estimated delta between a tracked baseline and a candidate set.
 */
export function estimateDelta(input: RescanPlanInput): DeltaEstimate {
  const trackedMap = new Map<string, string>();
  for (const f of input.trackedFiles) {
    trackedMap.set(f.sourcePath, f.contentHash);
  }

  const candidateMap = new Map<string, string>();
  for (const f of input.candidateFiles) {
    candidateMap.set(f.sourcePath, f.contentHash);
  }

  let adds = 0;
  let updates = 0;
  let unchanged = 0;

  for (const [path, hash] of candidateMap) {
    const trackedHash = trackedMap.get(path);
    if (trackedHash === undefined) {
      adds++;
    } else if (trackedHash !== hash) {
      updates++;
    } else {
      unchanged++;
    }
  }

  let deletes = 0;
  for (const path of trackedMap.keys()) {
    if (!candidateMap.has(path)) {
      deletes++;
    }
  }

  return {
    adds,
    updates,
    deletes,
    unchanged,
    totalDelta: adds + updates + deletes,
    trackedCount: trackedMap.size,
  };
}
