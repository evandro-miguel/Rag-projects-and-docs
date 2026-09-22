/**
 * Scan completeness model — fail-closed classification of Project RAG scans.
 *
 * SPEC §5.2: "Represent scans as complete, incomplete, or blocked. Only
 * complete scans may produce deletions." Invariant 6: "A complete scan with
 * zero eligible files may publish an empty build; an incomplete scan may not
 * publish deletions."
 *
 * This module is a PURE decision model. It performs no filesystem access,
 * no database access, and no process spawning. Callers (scan walkers,
 * preflight plans) feed in plain observation data; the module classifies the
 * scan and decides whether deletions may be planned. Wiring into live scan
 * paths is deliberately out of scope here.
 *
 * ## Status semantics (fail-closed)
 *
 *  - `blocked`     — policy refusal observed by the scan itself: unsuppressed
 *                    blocked findings, or a rejected root manifest. The tree
 *                    may have been fully observable, but policy says NO.
 *  - `incomplete`  — observability gap: interrupted walk, permission/read/stat
 *                    errors, walker bounds exceeded, or no walker evidence at
 *                    all (`walkerObserved: false` — the explicit legacy default
 *                    for callers that only ran a glob+policy scan). The
 *                    inventory cannot be proven authoritative, so anything not
 *                    re-observed must be presumed alive.
 *  - `complete`    — every include root walked within bounds, zero unreadable
 *                    entries, zero unsuppressed blocked findings, manifest valid
 *                    or absent. Zero eligible files is still complete: an empty
 *                    build is a valid publication target.
 *
 * `incomplete` and `blocked` NEVER plan deletions — deleting from an
 * untrusted inventory can destroy files the scan never saw.
 *
 * ## Integration without overlap
 *
 *  - Inventory side: accepts `BlockedFinding[]` exactly as produced by
 *    `detectBlockedFindings()` (project-inventory.ts) and validates it with
 *    the shared `validateBlockedFindings` policy — no duplicated validation.
 *  - Manifest side: `manifestStateFromReadResult()` maps the existing
 *    `RootManifestReadResult` union (root-manifest.ts) into this model's
 *    compact manifest-state input. No manifest parsing is duplicated.
 *
 * ## Bounded evidence
 *
 * Reasons, issue kinds, categories, samples, and detail strings are all hard-
 * capped and sanitized (control characters stripped). The evidence hash is a
 * SHA-256 over canonical key-sorted JSON of the verdict, so equal scans hash
 * equally regardless of input key order and any single-byte difference in
 * classified evidence yields a different digest.
 */

import type { RootManifestReadResult } from './root-manifest.js';
import {
  BLOCKED_FINDINGS_MAX,
  type BlockedFinding,
  deterministicHashJson,
  validateBlockedFindings,
} from './snapshot-policy.js';

// ==========================================================================
// Statuses and issue vocabulary
// ==========================================================================

export type ScanCompletenessStatus = 'complete' | 'incomplete' | 'blocked';

/** Fixed vocabulary of per-walk observability issues. */
export const SCAN_ISSUE_KINDS = [
  'scan_interrupted',
  'permission_denied',
  'read_error',
  'stat_error',
  'bound_exceeded',
] as const;

export type ScanIssueKind = (typeof SCAN_ISSUE_KINDS)[number];

const SCAN_ISSUE_KIND_SET: ReadonlySet<string> = new Set(SCAN_ISSUE_KINDS);

// ==========================================================================
// Bounds (hard caps keep evidence log-safe and hash-stable)
// ==========================================================================

export const SCAN_REASON_DETAIL_MAX_LENGTH = 256;
export const SCAN_SAMPLE_PATH_MAX_LENGTH = 200;
/** Maximum distinct reason codes reported for one verdict. */
export const SCAN_MAX_REASONS = 16;
/** Hard ceiling for any aggregated counter accepted as input. */
export const SCAN_COUNT_CAP = 1_000_000_000;
/** Default cap on planned-deletion listings produced by one decision. */
export const SCAN_DEFAULT_MAX_PLANNED_DELETIONS = 500_000;

// ==========================================================================
// Input shapes (plain data — no behaviour)
// ==========================================================================

/**
 * One aggregated observability issue from a scan walk. Exactly one entry per
 * kind is allowed; walkers aggregate counts before reporting.
 */
export interface ScanIssue {
  readonly kind: ScanIssueKind;
  /** Positive integer occurrence count, capped at {@link SCAN_COUNT_CAP}. */
  readonly count: number;
  /** Optional single bounded relative-path sample (no absolute paths). */
  readonly sample?: string;
}

/** Compact manifest state consumed by the completeness evaluation. */
export type ScanManifestState =
  | { readonly state: 'absent' }
  | { readonly state: 'valid'; readonly digest?: string }
  // A rejected manifest ALWAYS carries its bounded rejection reasons:
  // manifestStateFromReadResult never produces a rejected state without them.
  | { readonly state: 'rejected'; readonly errors: readonly string[] };

/** Plain-data observation of one completed-or-failed scan. */
export interface ScanObservation {
  /**
   * True when the caller had real walker observability over every include
   * root.  Defaults to observed (true/undefined) for backward compatibility
   * with existing callers.  When EXPLICITLY false the caller had no walker
   * evidence at all (legacy preflight callers that only ran a glob+policy
   * scan): such scans can never classify as complete — an explicit
   * `scan_evidence_not_provided` incompleteness reason is recorded unless a
   * blocking signal fires — so omission of evidence can never silently
   * authorise deletion planning.
   */
  readonly walkerObserved?: boolean;
  /** True when the walk aborted before finishing every include root. */
  readonly interrupted?: boolean;
  /** Aggregated IO/bound issues observed during the walk. */
  readonly issues?: readonly ScanIssue[];
  /** Unsuppressed blocked findings, exactly as detectBlockedFindings reports them. */
  readonly blockedFindings?: readonly BlockedFinding[];
  /** Root-manifest outcome; absent means no manifest file existed. */
  readonly manifest?: ScanManifestState;
  /** Eligible candidate count after extension/size filtering. */
  readonly eligibleFileCount?: number;
  /** Total paths seen by the walker before eligibility filtering. */
  readonly scannedPathCount?: number;
}

// ==========================================================================
// Output shapes
// ==========================================================================

export interface CompletenessReason {
  /** Stable snake_case token; part of the fixed classification contract. */
  readonly code: string;
  /** Bounded sanitized human-readable detail (never absolute paths/secrets). */
  readonly detail?: string;
}

export interface ScanCompletenessVerdict {
  readonly status: ScanCompletenessStatus;
  /** Bounded reasons; sorted by code for deterministic hashing. */
  readonly reasons: readonly CompletenessReason[];
  readonly eligibleFileCount: number;
  readonly scannedPathCount: number | null;
  /** Sorted distinct blocked-finding category names (bounded). */
  readonly blockedFindingCategories: readonly string[];
  /** Sorted issue kinds that fired (empty when none). */
  readonly issueKinds: readonly ScanIssueKind[];
  /** Manifest state observed for this scan (digest included when valid). */
  readonly manifestState: ScanManifestState;
  /** SHA-256 over canonical JSON of this verdict — stable and tamper-evident. */
  readonly evidenceHash: string;
}

// ==========================================================================
// Sanitization helpers
// ==========================================================================

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips control characters from caller-supplied evidence text
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

function sanitizeDetail(raw: string): string {
  return raw.replace(CONTROL_CHAR_PATTERN, '').slice(0, SCAN_REASON_DETAIL_MAX_LENGTH);
}

function sanitizeSample(raw: string): string {
  return raw.replace(CONTROL_CHAR_PATTERN, '').slice(0, SCAN_SAMPLE_PATH_MAX_LENGTH);
}

/**
 * Compare two short code strings by raw UTF-8 bytes (never locale-aware).
 * Canonical evidence ordering must be identical across machines and locales.
 */
function byteOrderCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function requireBoundedCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${String(value)}`);
  }
  if (value > SCAN_COUNT_CAP) {
    throw new Error(`${label} exceeds SCAN_COUNT_CAP (${SCAN_COUNT_CAP})`);
  }
  return value;
}

// ==========================================================================
// Manifest adapter — map root-manifest read results into this model
// ==========================================================================

/**
 * Map an existing `RootManifestReadResult` into the compact manifest state.
 *
 * Pure mapping only — no re-validation, no parsing overlap. A rejected or
 * unreadable manifest maps to `rejected`; an absent file maps to `absent`.
 */
export function manifestStateFromReadResult(result: RootManifestReadResult): ScanManifestState {
  if (!result.present) {
    return { state: 'absent' };
  }
  if (!result.ok) {
    return {
      state: 'rejected',
      errors: [...result.errors],
    };
  }
  return { state: 'valid', digest: result.digest };
}

// ==========================================================================
// Completeness evaluation
// ==========================================================================

/**
 * Classify one scan observation into `complete | incomplete | blocked`.
 *
 * Throws loudly on malformed input (negative counts, unknown issue kinds,
 * duplicate issue kinds, oversized blocked-findings arrays) rather than
 * silently normalizing — a malformed observation must never classify as
 * complete.
 *
 * Severity resolution when multiple signals fire: any blocking signal makes
 * the whole verdict `blocked`; otherwise any incompleteness signal makes it
 * `incomplete`; otherwise it is `complete`. All firing reasons are retained.
 */
export function evaluateScanCompleteness(observation: ScanObservation): ScanCompletenessVerdict {
  const reasons: CompletenessReason[] = [];
  const issueKinds: ScanIssueKind[] = [];

  // ---- Validate + collect IO/bound issues --------------------------------
  const seenKinds = new Set<string>();
  for (const issue of observation.issues ?? []) {
    if (!SCAN_ISSUE_KIND_SET.has(issue.kind)) {
      throw new Error(`Unknown scan issue kind: ${JSON.stringify(String(issue.kind))}`);
    }
    if (seenKinds.has(issue.kind)) {
      throw new Error(`Duplicate scan issue kind: ${issue.kind}`);
    }
    seenKinds.add(issue.kind);
    if (!Number.isInteger(issue.count) || issue.count < 1) {
      throw new Error(
        `issue ${issue.kind} count must be a positive integer, got ${String(issue.count)}`
      );
    }
    requireBoundedCount(issue.count, `issue ${issue.kind} count`);
    issueKinds.push(issue.kind);

    const detailParts: string[] = [`${issue.count} occurrence(s)`];
    if (issue.sample !== undefined) {
      detailParts.push(`sample: ${sanitizeSample(issue.sample)}`);
    }
    reasons.push({
      code: issue.kind === 'bound_exceeded' ? 'scan_bound_exceeded' : `scan_issue_${issue.kind}`,
      detail: sanitizeDetail(detailParts.join('; ')),
    });
  }

  // ---- Interruption / observability gap ----------------------------------
  if (observation.walkerObserved === false) {
    reasons.push({ code: 'scan_evidence_not_provided' });
  }
  if (observation.interrupted === true) {
    reasons.push({ code: 'scan_interrupted' });
  }

  // ---- Blocked findings (validated by the shared policy, no overlap) ------
  const blockedFindings = observation.blockedFindings ?? [];
  if (blockedFindings.length > BLOCKED_FINDINGS_MAX) {
    throw new Error(
      `Blocked findings count ${blockedFindings.length} exceeds max ${BLOCKED_FINDINGS_MAX}`
    );
  }
  validateBlockedFindings(blockedFindings);
  if (blockedFindings.length > 0) {
    const total = blockedFindings.reduce((sum, finding) => sum + finding.count, 0);
    requireBoundedCount(total, 'blocked findings total count');
    reasons.push({
      code: 'blocked_findings_present',
      detail: sanitizeDetail(`${total} path(s) across ${blockedFindings.length} categor(ies)`),
    });
  }

  // ---- Manifest state -----------------------------------------------------
  const manifest = observation.manifest ?? { state: 'absent' as const };
  if (manifest.state === 'rejected') {
    const firstError = manifest.errors?.[0];
    reasons.push({
      code: 'manifest_rejected',
      ...(firstError !== undefined ? { detail: sanitizeDetail(firstError) } : {}),
    });
  } else if (manifest.state === 'valid' && typeof manifest.digest !== 'string') {
    throw new Error('Valid manifest state requires a string digest');
  }

  // ---- Counters -----------------------------------------------------------
  const eligibleFileCount = requireBoundedCount(
    observation.eligibleFileCount ?? 0,
    'eligibleFileCount'
  );
  const scannedPathCount =
    observation.scannedPathCount === undefined
      ? null
      : requireBoundedCount(observation.scannedPathCount, 'scannedPathCount');

  // ---- Severity resolution ------------------------------------------------
  const codes = reasons.map((reason) => reason.code);
  let status: ScanCompletenessStatus = 'complete';
  if (codes.includes('blocked_findings_present') || codes.includes('manifest_rejected')) {
    status = 'blocked';
  } else if (codes.length > 0) {
    status = 'incomplete';
  }

  const boundedReasons = [...reasons]
    .sort((a, b) => byteOrderCompare(a.code, b.code))
    .slice(0, SCAN_MAX_REASONS);
  const blockedFindingCategories = [
    ...new Set(blockedFindings.map((finding) => finding.category)),
  ].sort(byteOrderCompare);
  const sortedIssueKinds = [...issueKinds].sort(byteOrderCompare);

  // The manifest state participates in the evidence hash: a valid-manifest
  // digest change (tamper) must yield a different verdict digest even when
  // every other classified signal is identical.
  const evidenceHash = deterministicHashJson({
    blockedFindingCategories,
    eligibleFileCount,
    issueKinds: sortedIssueKinds,
    manifestState: manifest,
    reasons: boundedReasons,
    scannedPathCount,
    status,
  });

  return {
    status,
    reasons: boundedReasons,
    eligibleFileCount,
    scannedPathCount,
    blockedFindingCategories,
    issueKinds: sortedIssueKinds,
    manifestState: manifest,
    evidenceHash,
  };
}

// ==========================================================================
// Pure deletion-eligibility decision
// ==========================================================================

export type DeletionPlanDecision =
  | {
      readonly allowed: true;
      /** Sorted, deduplicated tracked paths absent from the candidate set. */
      readonly stalePaths: readonly string[];
      readonly count: number;
    }
  | {
      readonly allowed: false;
      /** The non-complete status that forbade deletion, or 'complete' when the plan itself overflowed its bound. */
      readonly status: ScanCompletenessStatus;
      readonly reasonCodes: readonly string[];
    };

/**
 * Decide which tracked files may be planned for deletion given a scan
 * verdict and the pure inventory inputs.
 *
 * Rules (all enforced, none advisory):
 *  1. ONLY a `complete` verdict may plan deletions.
 *  2. A complete scan with ZERO candidates is valid: every tracked path
 *     becomes stale — an empty build is a legitimate publication target.
 *  3. `incomplete`/`blocked` verdicts never delete, regardless of inputs.
 *  4. When the stale list would exceed `maxPlannedDeletions`, the decision
 *     fails closed instead of truncating silently.
 *
 * Throws on malformed path arrays (non-string entries) so corrupt inputs
 * cannot masquerade as an empty deletion plan.
 */
export function decideDeletionEligibility(params: {
  readonly verdict: ScanCompletenessVerdict;
  readonly candidateSourcePaths: readonly string[];
  readonly trackedSourcePaths: readonly string[];
  readonly maxPlannedDeletions?: number;
}): DeletionPlanDecision {
  const { verdict } = params;

  if (verdict.status !== 'complete') {
    return {
      allowed: false,
      status: verdict.status,
      reasonCodes: verdict.reasons.map((reason) => reason.code),
    };
  }

  for (const [label, list] of [
    ['candidateSourcePaths', params.candidateSourcePaths],
    ['trackedSourcePaths', params.trackedSourcePaths],
  ] as const) {
    for (const entry of list) {
      if (typeof entry !== 'string') {
        throw new Error(`${label} contains a non-string entry`);
      }
    }
  }

  const candidates = new Set(params.candidateSourcePaths);
  const stalePaths = [...new Set(params.trackedSourcePaths)]
    .filter((sourcePath) => !candidates.has(sourcePath))
    .sort();

  const maxPlannedDeletions = params.maxPlannedDeletions ?? SCAN_DEFAULT_MAX_PLANNED_DELETIONS;
  if (!Number.isInteger(maxPlannedDeletions) || maxPlannedDeletions < 0) {
    throw new Error(
      `maxPlannedDeletions must be a non-negative integer, got ${String(maxPlannedDeletions)}`
    );
  }
  if (stalePaths.length > maxPlannedDeletions) {
    return {
      allowed: false,
      status: 'complete',
      reasonCodes: ['deletion_plan_bound_exceeded'],
    };
  }

  return { allowed: true, stalePaths, count: stalePaths.length };
}
