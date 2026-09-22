/**
 * Core snapshot gate for Project RAG index mutations (SPEC-007 §8, RULE-013).
 *
 * Pure-policy helpers (refresh policy, hash, error classes) live in
 * ./snapshot-policy.ts and are re-exported here for compatibility.
 * This module provides SQL-backed gate operations (prepare, claim,
 * consume, fail, revalidate).
 */

import type { SnapshotFailureCode, SnapshotInitialStatus } from './snapshot-policy.js';
// Import policy functions used by gate operations (Bun requires explicit import
// — re-export alone does not create a local binding).
import {
  FAILURE_DETAIL_MAX_LENGTH,
  refreshRequiresReview,
  validateBlockedFindings,
} from './snapshot-policy.js';
import type {
  ProjectRagPostgresIngestSnapshot,
  ProjectRagPostgresIngestSnapshotInput,
} from './store.js';
import {
  claimProjectRagPostgresIngestSnapshot,
  claimProjectRagPostgresIngestSnapshotByUuid,
  consumeProjectRagPostgresIngestSnapshot,
  failProjectRagPostgresIngestSnapshot,
  findProjectRagPostgresIngestSnapshot,
  insertProjectRagPostgresIngestSnapshotInTransaction,
} from './store.js';
import { beginProjectRagWrite, type ProjectRagWriteSql } from './transaction.js';

export type {
  BlockedFinding,
  DeltaEstimate,
  RefreshPolicyInput,
  RescanPlanInput,
  SnapshotFailureCode,
  SnapshotInitialStatus,
} from './snapshot-policy.js';

/** Optional async progress callback for long-running scans/operations. */
export type ProgressCallback = (kind: 'scan_file' | 'scan_dir', count: number) => Promise<void>;

// Re-export all pure policy helpers from snapshot-policy.
export {
  BLOCKED_FINDING_SAMPLE_MAX,
  BLOCKED_FINDING_SAMPLE_PATH_MAX,
  BLOCKED_FINDINGS_MAX,
  ContentHashMismatchError,
  deterministicHash,
  deterministicHashJson,
  deterministicHashList,
  estimateDelta,
  FAILURE_DETAIL_MAX_LENGTH,
  hashBlockedFindingAllowlist,
  hashSuppressedBlockedFindings,
  LeaseLostError,
  refreshRequiresReview,
  SnapshotRescanMismatchError,
  thresholdRequiresReview,
  validateBlockedFindings,
} from './snapshot-policy.js';

// Review lifecycle operations intentionally live in the service layer, but
// the gate remains the stable public boundary for callers that already depend
// on this module. Runtime mutations require the protected operator assertion;
// inspect/audit/resume are read-only and resume never claims a snapshot.
export type {
  SnapshotReviewAudit,
  SnapshotReviewAuditRecord,
  SnapshotReviewAuthenticatedOperator,
  SnapshotReviewOperatorRuntimeAction,
  SnapshotReviewOperatorRuntimeOptions,
  SnapshotReviewOperatorRuntimeRequest,
  SnapshotReviewResumeReadiness,
} from './snapshot-review-service.js';
export {
  approveProjectRagIngestSnapshot as approveSnapshot,
  approveProjectRagIngestSnapshotFromOperatorRuntime as approveSnapshotFromOperatorRuntime,
  auditProjectRagIngestSnapshot as auditSnapshot,
  deferProjectRagIngestSnapshotReview as deferSnapshot,
  deferProjectRagIngestSnapshotReviewFromOperatorRuntime as deferSnapshotFromOperatorRuntime,
  inspectProjectRagIngestSnapshot as inspectSnapshot,
  rejectProjectRagIngestSnapshotReview as rejectSnapshot,
  rejectProjectRagIngestSnapshotReviewFromOperatorRuntime as rejectSnapshotFromOperatorRuntime,
  resumeProjectRagIngestSnapshot as resumeSnapshot,
} from './snapshot-review-service.js';
export { EMPTY_ALLOWLIST_HASH } from './store.js';

// ==========================================================================
// Snapshot gate operations
// ==========================================================================

export interface SnapshotGatePrepareResult {
  readonly snapshot: ProjectRagPostgresIngestSnapshot;
  readonly thresholdResult: { readonly requiresReview: boolean; readonly reason: string };
}

/**
 * Prepare a new snapshot: compute deletion review policy, validate blocked findings,
 * and insert the row.
 *
 * Blocked findings always produce a terminal FAILED (BLOCKED_ROOT_FINDINGS)
 * snapshot — never PREPARED or REVIEW_REQUIRED.
 *
 * totalDelta is retained in the snapshot for inventory evidence; cardinality
 * does not independently require review.
 *
 * Does NOT perform the filesystem scan — the caller supplies hashes and counts
 * that were computed externally.  This keeps the gate independent of the scanner.
 */
export async function prepareSnapshotInTransaction(
  tx: ProjectRagWriteSql,
  input: ProjectRagPostgresIngestSnapshotInput
): Promise<SnapshotGatePrepareResult> {
  // Validate blocked findings before any logic
  const blockedFindings = input.blockedFindings ?? [];
  if (blockedFindings.length > 0) {
    validateBlockedFindings(blockedFindings as ReadonlyArray<Record<string, unknown>>);
  }

  const addsCount = input.addsCount ?? 0;
  const updatesCount = input.updatesCount ?? 0;
  const deletesCount = input.deletesCount ?? 0;
  const policyDeletesCount = input.commandScope === 'file' ? 0 : deletesCount;
  const requiresReview = refreshRequiresReview({
    addsCount,
    updatesCount,
    deletesCount: policyDeletesCount,
    completenessStatus: input.completenessStatus,
    completenessEvidenceHash: input.completenessEvidenceHash,
    deletionAllowed: input.deletionAllowed,
  });

  // Blocked findings → terminal FAILED (not PREPARED)
  if (blockedFindings.length > 0) {
    // Build a bounded failure-detail string (capped at FAILURE_DETAIL_MAX_LENGTH)
    const rawDetail = `Blocked findings: ${blockedFindings
      .map(
        (f) =>
          `${(f as Record<string, unknown>).category ?? '?'}:${(f as Record<string, unknown>).count ?? 0}`
      )
      .join(', ')}`;
    const truncatedDetail =
      rawDetail.length > FAILURE_DETAIL_MAX_LENGTH
        ? rawDetail.slice(0, FAILURE_DETAIL_MAX_LENGTH)
        : rawDetail;

    const snapshot = await insertProjectRagPostgresIngestSnapshotInTransaction(tx, {
      ...input,
      status: 'FAILED',
      failureCode: 'BLOCKED_ROOT_FINDINGS',
      failureDetail: truncatedDetail,
    });
    return {
      snapshot,
      thresholdResult: {
        requiresReview: true,
        reason: `blocked_findings: ${blockedFindings.length} blocked finding categories; terminal FAILED`,
      },
    };
  }

  let reason: string;
  let status: SnapshotInitialStatus;

  if (policyDeletesCount > 0 && requiresReview) {
    reason = `deletion_evidence_required: ${policyDeletesCount} deletion(s) lack complete, hash-bound scanner authorization`;
    status = 'REVIEW_REQUIRED';
  } else if (policyDeletesCount > 0) {
    reason = `deletion_evidence_bound: ${policyDeletesCount} deletion(s) authorized by complete scanner evidence`;
    status = 'PREPARED';
  } else {
    reason = `refresh_safe: ${addsCount} addition(s), ${updatesCount} update(s); cardinality does not require review`;
    status = 'PREPARED';
  }

  const snapshot = await insertProjectRagPostgresIngestSnapshotInTransaction(tx, {
    ...input,
    status,
  });

  return {
    snapshot,
    thresholdResult: { requiresReview, reason },
  };
}

/** Prepare a new snapshot in one top-level fenced write transaction. */
export async function prepareSnapshot(
  sql: Bun.SQL,
  input: ProjectRagPostgresIngestSnapshotInput
): Promise<SnapshotGatePrepareResult> {
  return beginProjectRagWrite(sql, (tx) => prepareSnapshotInTransaction(tx, input));
}

/**
 * Atomic claim: transition a PREPARED snapshot to CONSUMING.
 *
 * Supports lookup by numeric id or snapshot UUID.
 *
 * Returns the claimed snapshot, or undefined if:
 *  - snapshot is not in PREPARED state
 *  - snapshot has expired (expires_at ≤ now())
 *  - another CONSUMING snapshot exists for this project
 *    (enforced by partial unique index; SQLSTATE 23505 caught)
 *
 * REVIEW_REQUIRED snapshots are intentionally unclaimable.
 */
export async function claimSnapshot(
  sql: Bun.SQL,
  projectId: number,
  snapshotId: number,
  allowApprovedReview = false
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return claimProjectRagPostgresIngestSnapshot(sql, projectId, snapshotId, allowApprovedReview);
}

/**
 * Claim by snapshot UUID (external identifier).
 */
export async function claimSnapshotByUuid(
  sql: Bun.SQL,
  projectId: number,
  snapshotUuid: string,
  allowApprovedReview = false
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return claimProjectRagPostgresIngestSnapshotByUuid(
    sql,
    projectId,
    snapshotUuid,
    allowApprovedReview
  );
}

/**
 * Complete a CONSUMING snapshot to CONSUMED.
 */
export async function consumeSnapshot(
  sql: Bun.SQL,
  projectId: number,
  snapshotId: number,
  snapshotUuid: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return consumeProjectRagPostgresIngestSnapshot(sql, projectId, snapshotId, snapshotUuid);
}

/**
 * Fail a snapshot with a given failure code.
 *
 * This is the canonical way to represent a refusal (failed preflight,
 * rescan mismatch, precondition failure, lease abandonment).
 */
export async function failSnapshot(
  sql: Bun.SQL,
  projectId: number,
  snapshotId: number,
  failureCode: SnapshotFailureCode,
  failureDetail?: string
): Promise<ProjectRagPostgresIngestSnapshot | undefined> {
  return failProjectRagPostgresIngestSnapshot(
    sql,
    projectId,
    snapshotId,
    failureCode,
    failureDetail
  );
}

/**
 * Revalidate the snapshot baseline against current hashes.
 *
 * Compares all binding hashes that the caller supplies.  Current
 * practice: always supply inventoryHash and baselineHash; supply
 * planHash, scopeHash, rootHash, and policyHash for full coverage.
 *
 * When any supplied hash differs from the snapshot's stored hash,
 * the baseline has drifted and the snapshot should be failed.
 */
export async function revalidateBaseline(
  sql: Bun.SQL,
  projectId: number,
  snapshotId: number,
  currentInventoryHash: string,
  currentBaselineHash: string,
  currentPlanHash: string,
  currentScopeHash: string,
  currentRootHash: string,
  currentPolicyHash: string,
  currentBlockedFindingAllowlistHash: string
): Promise<{
  readonly matches: boolean;
  readonly mismatchedFields: string[];
  readonly snapshot: ProjectRagPostgresIngestSnapshot | undefined;
}> {
  const snapshot = await findProjectRagPostgresIngestSnapshot(sql, projectId, snapshotId);
  if (!snapshot) {
    return { matches: false, mismatchedFields: ['snapshot_not_found'], snapshot: undefined };
  }

  const mismatchedFields: string[] = [];
  if (snapshot.inventoryHash !== currentInventoryHash) {
    mismatchedFields.push('inventory_hash');
  }
  if (snapshot.baselineHash !== currentBaselineHash) {
    mismatchedFields.push('baseline_hash');
  }
  if (snapshot.planHash !== currentPlanHash) {
    mismatchedFields.push('plan_hash');
  }
  if (snapshot.scopeHash !== currentScopeHash) {
    mismatchedFields.push('scope_hash');
  }
  if (snapshot.rootHash !== currentRootHash) {
    mismatchedFields.push('root_hash');
  }
  if (snapshot.policyHash !== currentPolicyHash) {
    mismatchedFields.push('policy_hash');
  }
  if (snapshot.blockedFindingAllowlistHash !== currentBlockedFindingAllowlistHash) {
    mismatchedFields.push('blocked_finding_allowlist_hash');
  }

  return { matches: mismatchedFields.length === 0, mismatchedFields, snapshot };
}

/**
 * Determine the gate status for a project: is there an active CONSUMING
 * snapshot, a pending PREPARED one, or nothing?
 *
 * REVIEW_REQUIRED is non-consumable until a current, single-use review row
 * has been inserted by the qualified snapshot-review path.
 *
 * Sorts snapshots by createdAt (descending) defensively so the caller
 * does not need to pre-sort.
 */
export function getProjectGateStatus(
  snapshots: readonly ProjectRagPostgresIngestSnapshot[]
): 'idle' | 'prepared' | 'consuming' | 'review_required' | 'blocked' {
  if (snapshots.length === 0) {
    return 'idle';
  }

  // Defensive sort: most recent first
  const sorted = [...snapshots].sort((a, b) => {
    const aTime =
      typeof a.createdAt === 'string' ? new Date(a.createdAt).getTime() : a.createdAt.getTime();
    const bTime =
      typeof b.createdAt === 'string' ? new Date(b.createdAt).getTime() : b.createdAt.getTime();
    return bTime - aTime;
  });

  for (const s of sorted) {
    if (s.status === 'CONSUMING') return 'consuming';
    if (s.status === 'PREPARED') return 'prepared';
    if (s.status === 'REVIEW_REQUIRED') return 'review_required';
  }

  const last = sorted[0];
  if (last && (last.status === 'FAILED' || last.status === 'EXPIRED')) {
    return 'blocked';
  }

  return 'idle';
}
