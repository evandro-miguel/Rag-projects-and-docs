/**
 * Project RAG inventory scanner — deterministic preflight for snapshot gate.
 *
 * This module reuses the **exact same** scanner/policy/canonicalisation that
 * `ingest-postgres.ts` uses so the snapshot gate sees a faithful preflight.
 *
 * It provides:
 *  - `scanCandidateFiles()`  – glob-based candidate scan (same as ingest)
 *  - `detectBlockedFindings()` – compact relative blocked-finding summary
 *  - `buildPreflightPlan()`   – full deterministic plan with all hashes,
 *    plus root-manifest policy binding and scan-completeness classification
 *    (`complete|incomplete|blocked`, deterministic evidence hash, and a
 *    deletion-eligibility decision where only complete scans may plan
 *    deletions) when optional evidence is provided.
 *
 * Evidence omission is an explicit legacy default: hash outputs stay
 * byte-identical for existing callers and deletion planning is refused with
 * `scan_evidence_not_provided` — never silently granted.
 *
 * ## Sync filesystem note
 *
 * This module intentionally uses synchronous `existsSync`, `statSync`,
 * `readdirSync`, and `realpathSync.native` in the blocked-finding walker
 * and preflight validation.  This is safe because:
 *  1. These calls are scoped to **explicit mutation preflight** — they
 *     only run inside `buildPreflightPlan` and `detectBlockedFindings`,
 *     which are called at most once per ingest invocation.
 *  2. The progress callback (`onProgress`) is the only yield point,
 *     invoked every 100 files/dirs so the caller can renew lease heartbeats
 *     (filesystem-bound lease, not event-loop availability).
 *  3. Node.js sync I/O within a single bounded walk (< 100k dirs, < 50k
 *     files) completes in well under 1 s on local SSD — the sync design
 *     avoids the overhead of an async queue for what is fundamentally a
 *     sequential directory crawl.
 *
 * Do not refactor these to async I/O without understanding the above
 * constraints.  Do not add sync I/O outside the preflight path.
 *
 * No DB writes, no snapshot inserts, no MCP — pure data + hashing.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { glob } from 'glob';
import {
  buildProjectIgnoreGlobPatterns,
  buildProjectIncludeGlobPatterns,
} from '../../lib/shared/project-include-roots.js';
import { calculateProjectContentHash } from '../lib/project-content-hash.js';
import type { RootManifestReadResult } from './root-manifest.js';
import type {
  DeletionPlanDecision,
  ScanCompletenessStatus,
  ScanCompletenessVerdict,
  ScanIssue,
  ScanManifestState,
  ScanObservation,
} from './scan-completeness.js';
import {
  decideDeletionEligibility,
  evaluateScanCompleteness,
  manifestStateFromReadResult,
} from './scan-completeness.js';
import type { BlockedFinding, ProgressCallback } from './snapshot-gate.js';
import {
  BLOCKED_FINDING_SAMPLE_MAX,
  BLOCKED_FINDING_SAMPLE_PATH_MAX,
  deterministicHashJson,
  hashBlockedFindingAllowlist,
} from './snapshot-gate.js';
import type { BlockedFindingAllowlistEntry, SuppressedBlockedFinding } from './store.js';
import { EMPTY_ALLOWLIST_HASH, runAllowlistPathValidation } from './store.js';

// ==========================================================================
// Shared constants — MUST match ingest-postgres.ts exactly
// ==========================================================================

import { isEligibleProjectSourcePath, PROJECT_SOURCE_EXTENSIONS } from './eligibility.js';

/** SHA-256 of an absent root manifest; kept here to avoid a runtime cycle. */
export const EMPTY_ROOT_MANIFEST_HASH = createHash('sha256').update('').digest('hex');

/** Canonical source extensions re-exported for manifest and inventory callers. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = PROJECT_SOURCE_EXTENSIONS;

// ==========================================================================
// Helper: extension guard (centralized in eligibility.ts)
// ==========================================================================

function shouldIndexPath(pathValue: string, sizeBytes: number): boolean {
  return isEligibleProjectSourcePath(pathValue, sizeBytes);
}

function isPathInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(rootPath, absolutePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

// ==========================================================================
// Candidate file representation
// ==========================================================================

export interface CandidateFileInfo {
  readonly sourcePath: string;
  readonly absolutePath: string;
  readonly contentHash: string;
}

export interface TrackedFileState {
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly status: string;
  readonly latestVersionStatus: string | null;
}

// ==========================================================================
// Effective policy helpers — merge project rules with defaults
// ==========================================================================

/**
 * Return the effective ignore rules: platform-defaults first, then project-
 * specific rules.  The project rules may override defaults by negation or
 * add new exclusions.  Sorting is preserved caller-side.
 */
export function effectivePolicy(
  defaults: readonly string[],
  projectRules: readonly string[],
  includeRoots?: readonly string[]
): string[] {
  const explicitlySelectedRootIngest = (includeRoots ?? []).some((root) => {
    const normalized = root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    return normalized === 'ingest' || normalized.startsWith('ingest/');
  });
  const merged = new Set(
    explicitlySelectedRootIngest ? defaults.filter((rule) => rule !== '/ingest') : defaults
  );
  for (const rule of projectRules) {
    merged.add(rule);
  }
  return [...merged];
}

// ==========================================================================
// Scanner — same glob/policy as ingest-postgres.ts
// ==========================================================================

/**
 * Scan candidate project files using the exact same glob + ignore + extension
 * logic that `ingest-postgres.ts` uses.
 *
 * Accepts an optional set of project-specific ignore rules that are merged
 * with DEFAULT_IGNORE_RULES to form the effective scan policy.
 *
 * When `onProgress` is provided, it is invoked every 100 files during the
 * content-hash phase so the caller can renew leases during long scans.
 *
 * Returns empty arrays when the root does not exist (caller validation).
 */
export async function scanCandidateFiles(
  rootPath: string,
  includeRoots: readonly string[],
  ignoreRules: readonly string[] = [],
  onProgress?: ProgressCallback
): Promise<{ readonly scannedFiles: string[]; readonly candidateFiles: CandidateFileInfo[] }> {
  const effectiveRules = effectivePolicy(DEFAULT_IGNORE_RULES, ignoreRules, includeRoots);
  const patterns = buildProjectIncludeGlobPatterns([...includeRoots], '**/*');
  const ignore = buildProjectIgnoreGlobPatterns(effectiveRules);
  const canonicalRoot = realpathSync.native(rootPath);
  const fileSet = new Set<string>();

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootPath,
      absolute: true,
      nodir: true,
      ignore,
    });
    for (const match of matches) {
      const absoluteMatch = resolve(match);
      const canonicalMatch = realpathSync.native(absoluteMatch);
      if (!isPathInsideRoot(canonicalRoot, canonicalMatch)) {
        // Files that escape the project root are excluded silently —
        // the ingest itself will throw if they appear.
        continue;
      }
      // Security post-filter: reject any path whose project-relative
      // directory segments contain a BLOCKED_NAME_SEGMENTS name.
      // This runs AFTER the glob engine's ignore processing so that
      // negation patterns (e.g. `!**/node_modules/**`) cannot bypass
      // the blocked-directory policy.  Exact segment match, case-
      // sensitive, only directory segments (not filename basename).
      const segRelPath = relative(canonicalRoot, canonicalMatch).replace(/\\/g, '/');
      if (hasBlockedDirectorySegment(segRelPath)) {
        continue;
      }
      fileSet.add(canonicalMatch);
    }
  }

  const scannedFiles = [...fileSet].sort();
  const candidateFiles: CandidateFileInfo[] = [];

  for (const [index, absolutePath] of scannedFiles.entries()) {
    const stats = statSync(absolutePath);
    // Extension policy is defined over repository-relative paths.  Keep the
    // canonical absolute path for containment and reading, but classify only
    // after deriving the relative path so trusted extensionless launchers
    // (for example bin/ragctl) match their allowlist entry.
    const sourcePath = relative(canonicalRoot, absolutePath).replace(/\\/g, '/');
    if (!shouldIndexPath(sourcePath, stats.size)) {
      continue;
    }
    const content = await readFile(absolutePath, 'utf8');
    const contentHash = await calculateProjectContentHash(content);
    candidateFiles.push({ sourcePath, absolutePath, contentHash });

    // Progress callback every 100 files
    if (onProgress && index > 0 && index % 100 === 0) {
      await onProgress('scan_file', index + 1);
    }
  }

  return { scannedFiles, candidateFiles };
}

// ==========================================================================
// Blocked-finding detection under include roots
// ==========================================================================

/**
 * Options for the blocked-directory scan.
 */
export interface BlockedScanOptions {
  /**
   * Maximum directories visited by the iterative blocked scan.
   * Must be a positive integer between 1 and 10_000_000.
   * Default: 100_000.
   * Exceeding this bound refuses the scan rather than silently skipping.
   * The resulting `scan_bound_exceeded` finding is never suppressible.
   */
  readonly maxVisitedDirs?: number;
}

/** Validate and normalise maxVisitedDirs (strict positive bounded). */
function validateMaxVisitedDirs(value: number | undefined): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : 100_000;
  if (!Number.isInteger(raw)) {
    throw new Error(`maxVisitedDirs must be an integer, got ${raw}`);
  }
  if (raw < 1 || raw > 10_000_000) {
    throw new Error(`maxVisitedDirs must be between 1 and 10_000_000, got ${raw}`);
  }
  return raw;
}

/** Directory/base-name patterns to flag as blocked findings. */
export const BLOCKED_NAME_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly category: string;
}> = [
  // Nested repository markers
  { name: '.git', category: 'nested_repo_marker' },
  { name: '.hg', category: 'nested_repo_marker' },
  { name: '.svn', category: 'nested_repo_marker' },
  { name: '.jj', category: 'nested_repo_marker' },
  // Dependency directories
  { name: 'node_modules', category: 'dependency_dir' },
  { name: 'vendor', category: 'dependency_dir' },
  { name: '.bundle', category: 'dependency_dir' },
  // Cache directories
  { name: '.cache', category: 'cache_dir' },
  { name: '__pycache__', category: 'cache_dir' },
  { name: '.pytest_cache', category: 'cache_dir' },
  { name: '.mypy_cache', category: 'cache_dir' },
  // Temp directories
  { name: 'tmp', category: 'temp_dir' },
  { name: 'temp', category: 'temp_dir' },
  // Build/artifact directories
  { name: 'dist', category: 'build_dir' },
  { name: 'build', category: 'build_dir' },
  { name: 'coverage', category: 'build_dir' },
  { name: '.turbo', category: 'build_dir' },
  { name: '.next', category: 'build_dir' },
  { name: 'out', category: 'build_dir' },
  // Generated/data directories
  { name: '.data', category: 'generated_dir' },
  { name: '_generated', category: 'generated_dir' },
  { name: 'generated', category: 'generated_dir' },
  // Runtime/tool directories
  { name: 'logs', category: 'runtime_dir' },
  { name: 'playwright-report', category: 'runtime_dir' },
  { name: 'test-results', category: 'runtime_dir' },
  { name: '.eslint', category: 'runtime_dir' },
  { name: '.nyc_output', category: 'runtime_dir' },
];

/** Suffix-based generated directory names that must never be indexed. */
export const BLOCKED_NAME_SUFFIX_PATTERNS: ReadonlyArray<{
  readonly suffix: string;
  readonly category: string;
}> = [{ suffix: '.egg-info', category: 'generated_dir' }];

function blockedPatternForDirectoryName(
  name: string
): { readonly name: string; readonly category: string } | undefined {
  const exact = BLOCKED_NAME_PATTERNS.find((pattern) => pattern.name === name);
  if (exact) return exact;
  const suffix = BLOCKED_NAME_SUFFIX_PATTERNS.find((pattern) => name.endsWith(pattern.suffix));
  return suffix ? { name: suffix.suffix, category: suffix.category } : undefined;
}

/**
 * Maximum blocked-finding counts per category (avoids unbounded
 * aggregation when the same category has thousands of instances).
 * Once a category reaches this count the walker stops counting and
 * collecting samples for that category, but still skips descending
 * into blocked directories.
 */
const BLOCKED_COUNT_CAP = 50_000;

/**
 * Set of directory segment names that are always blocked from indexing.
 *
 * Derived from BLOCKED_NAME_PATTERNS — kept as a separate exported Set so
 * callers and the security post-filter (scanCandidateFiles) share the same
 * source of truth without relying on string[] membership checks.
 *
 * Every name in this set represents a directory name that must never appear
 * as a segment in any indexed file's project-relative path, regardless of
 * glob ignore negations, custom rules, or glob-engine ordering.
 */
export const BLOCKED_NAME_SEGMENTS: ReadonlySet<string> = new Set(
  BLOCKED_NAME_PATTERNS.map((p) => p.name)
);

/**
 * Check if a project-relative path contains a directory segment matching
 * any BLOCKED_NAME_SEGMENTS name.
 *
 * Only directory segments (all path components except the last / filename)
 * are checked — the filename basename alone is not considered a directory
 * segment, so a file named `dist.ts` at the root is NOT blocked, while a
 * file at `dist/index.ts` IS blocked.
 *
 * Uses exact case-sensitive byte-level comparison against BLOCKED_NAME_SEGMENTS.
 */
function hasBlockedDirectorySegment(sourcePath: string): boolean {
  const segments = sourcePath.split('/');
  // The last segment is the filename; only check directory segments (all
  // segments except the last).  A single-segment path (no directory) is safe.
  for (let i = 0; i < segments.length - 1; i++) {
    if (blockedPatternForDirectoryName(segments[i])) {
      return true;
    }
  }
  return false;
}

/**
 * Default ignore rules for the project scanner.
 *
 * Derived from ALL BLOCKED_NAME_PATTERNS names (every blocked directory is
 * also globally ignored by the glob scanner) PLUS any legacy rules that are
 * not in BLOCKED_NAME_PATTERNS.  This ensures the scanner's ignore set and
 * the blocked-finding detector are always consistent — a blocked directory
 * can never be indexed even if suppression is removed.
 *
 * `archive`, `.agents`, and `ingest` are legacy rules not in
 * BLOCKED_NAME_PATTERNS — they are excluded from glob scanning but do not
 * produce blocked findings.
 */
export const DEFAULT_IGNORE_RULES: readonly string[] = (() => {
  const fromBlocked = BLOCKED_NAME_PATTERNS.map((p) => p.name);
  const legacyExtra = ['archive', '.agents', '/ingest', '*.egg-info/**'];
  return [...new Set([...fromBlocked, ...legacyExtra])];
})();

/**
 * Validate an allowlist against the current filesystem before scanning.
 *
 * Every entry must:
 *  1. Resolve inside the canonical root
 *  2. Lie beneath a registered include root
 *  3. Exist as a directory
 *  4. Have a basename matching BLOCKED_NAME_PATTERNS
 *  5. Be encountered during the walk (lazy: verified during walk)
 *
 * Throws fail-closed on first violation.
 *
 * Exported so that MCP register_project and register-package CLI can validate
 * the allowlist against the project root before writing to the DB.
 */
export function validateAllowlistAgainstRoot(
  canonicalRoot: string,
  includeRoots: readonly string[],
  allowlist: readonly BlockedFindingAllowlistEntry[]
): void {
  for (let i = 0; i < allowlist.length; i++) {
    const { relativePath, category } = allowlist[i];

    // 0. Shared path validation (reused from store.ts)
    runAllowlistPathValidation(i, relativePath);

    // 1. Resolve inside canonical root
    const absolutePath = resolve(canonicalRoot, relativePath);
    if (!isPathInsideRoot(canonicalRoot, absolutePath)) {
      throw new Error(
        `Allowlist entry ${i} relativePath '${relativePath}' resolves outside the project root`
      );
    }

    // 2. Lies beneath a registered include root
    const includeRootMatch = includeRoots.some((ir) => {
      const absIr = resolve(canonicalRoot, ir);
      return isPathInsideRoot(absIr, absolutePath);
    });
    if (!includeRootMatch) {
      throw new Error(
        `Allowlist entry ${i} relativePath '${relativePath}' is not inside any include root`
      );
    }

    // 3. Exists as a directory
    if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
      throw new Error(
        `Allowlist entry ${i} relativePath '${relativePath}' does not exist as a directory`
      );
    }

    // 4. Basename matches a known BLOCKED_NAME_PATTERNS pattern
    const basename = relativePath.split('/').pop() ?? '';
    const pattern = blockedPatternForDirectoryName(basename);
    if (!pattern) {
      throw new Error(
        `Allowlist entry ${i} relativePath '${relativePath}' basename '${basename}' does not match any blocked-name pattern`
      );
    }

    // 5. Category matches the pattern's category
    if (pattern.category !== category) {
      throw new Error(
        `Allowlist entry ${i} relativePath '${relativePath}' category '${category}' does not match expected category '${pattern.category}' for pattern '${basename}'`
      );
    }

    // nested_repo_marker is rejected by validateRepositoryAllowlist already,
    // but double-check here for defense in depth
    if (category === 'nested_repo_marker') {
      throw new Error(
        `Allowlist entry ${i} relativePath '${relativePath}' is a nested_repo_marker — these are never suppressible`
      );
    }
  }
}

/**
 * Detect known blocked directories under include roots.
 *
 * Walks each include root recursively (no fixed depth limit) looking
 * for directory names that match known cache/temp/dependency/repo
 * markers.  Matched directories are **not** descended into, so the
 * scan cannot be poisoned by large blocked subtrees.
 *
 * When an allowlist is provided, entries are validated against the
 * filesystem before walking.  During the walk, matched directories
 * that correspond to allowlist entries are recorded as suppressed
 * (not counted as blocked findings) and not descended into.  Each
 * suppression produces an audit trail entry matching the allowlist.
 *
 * Per-category count is capped at BLOCKED_COUNT_CAP and per-category
 * sample paths at BLOCKED_FINDING_SAMPLE_MAX.
 *
 * Every allowlist entry must resolve inside the canonical root, lie
 * beneath a registered include root, exist as a directory, have a
 * basename matching BLOCKED_NAME_PATTERNS, and be encountered during
 * the walk — otherwise the function throws fail-closed before any
 * write.
 *
 * When `onProgress` is provided, it is invoked every 100 directories
 * visited so the caller can renew leases during long scans.
 *
 * All paths in findings are **relative** (to rootPath), bounded, and
 * contain no absolute paths, control characters, or secrets.
 */
export async function detectBlockedFindings(
  rootPath: string,
  includeRoots: readonly string[],
  allowlist?: readonly BlockedFindingAllowlistEntry[],
  onProgress?: ProgressCallback,
  options?: BlockedScanOptions
): Promise<{
  readonly blockedFindings: BlockedFinding[];
  readonly suppressedBlockedFindings: SuppressedBlockedFinding[];
  readonly scanIssues: readonly ScanIssue[];
  readonly walkerObserved: boolean;
  readonly scannedPathCount: number;
}> {
  const canonicalRoot = realpathSync.native(rootPath);
  const maxVisitedDirs = validateMaxVisitedDirs(options?.maxVisitedDirs);

  // Validate allowlist against filesystem before scanning (fail-closed)
  if (allowlist && allowlist.length > 0) {
    validateAllowlistAgainstRoot(canonicalRoot, includeRoots, allowlist);
  }

  // Build a set of allowlist keys for O(1) lookup during walk
  const allowlistKeys = new Set<string>();
  if (allowlist) {
    for (const entry of allowlist) {
      allowlistKeys.add(`${entry.relativePath}:${entry.category}`);
    }
  }

  const findings = new Map<string, { count: number; samples: string[] }>();
  const suppressed: SuppressedBlockedFinding[] = [];
  const encounteredAllowlistKeys = new Set<string>();
  const scanIssues: ScanIssue[] = [];
  let visitedDirectories = 0;
  let walkerObserved = true;

  for (const includeRoot of includeRoots) {
    const absoluteIncludeRoot = resolve(canonicalRoot, includeRoot);
    if (!existsSync(absoluteIncludeRoot)) {
      walkerObserved = false;
      scanIssues.push({ kind: 'read_error', count: 1, sample: includeRoot });
      continue;
    }
    const walkResult = await walkBlockedScan(
      canonicalRoot,
      absoluteIncludeRoot,
      findings,
      suppressed,
      allowlistKeys,
      encounteredAllowlistKeys,
      onProgress,
      maxVisitedDirs
    );
    visitedDirectories += walkResult.visitedDirectories;
    scanIssues.push(...walkResult.issues);
    if (!walkResult.completed) {
      walkerObserved = false;
      // scan_bound_exceeded category is already recorded in findings
      break; // stop scanning additional include roots
    }
  }

  // Verify every allowlist entry was encountered (fail-closed)
  if (allowlist) {
    for (const entry of allowlist) {
      const key = `${entry.relativePath}:${entry.category}`;
      if (!encounteredAllowlistKeys.has(key)) {
        throw new Error(
          `Allowlist entry relativePath '${entry.relativePath}' with category '${entry.category}' was not encountered during scan`
        );
      }
    }
  }

  // Convert findings map to sorted BlockedFinding array
  const blockedFindings: BlockedFinding[] = [];
  for (const [category, info] of findings) {
    blockedFindings.push({
      category,
      count: info.count,
      sample:
        info.samples.length > 0 ? info.samples.slice(0, BLOCKED_FINDING_SAMPLE_MAX) : undefined,
    });
  }
  blockedFindings.sort((a, b) => a.category.localeCompare(b.category));

  if (scanIssues.length > 0) {
    walkerObserved = false;
  }
  return {
    blockedFindings,
    suppressedBlockedFindings: suppressed,
    scanIssues,
    walkerObserved,
    scannedPathCount: visitedDirectories,
  };
}

/**
 * Iterative bounded blocked-directory walker.
 *
 * Uses an explicit queue instead of recursion to avoid stack overflow on
 * deeply nested trees.  The queue is bounded at `maxVisitedDirs`;
 * exceeding the bound causes a blocked finding to be recorded and the scan
 * to abort (refusal, not silent skip).
 *
 * - Any directory whose name matches BLOCKED_NAME_PATTERNS is counted
 *   and sampled, but **not** enqueued for descent.
 * - Per-category count capped at BLOCKED_COUNT_CAP.
 * - Per-category sample capped at BLOCKED_FINDING_SAMPLE_MAX.
 */
const BLOCKED_SCAN_BOUND_EXCEEDED_CATEGORY = 'scan_bound_exceeded';

async function walkBlockedScan(
  canonicalRoot: string,
  startDir: string,
  findings: Map<string, { count: number; samples: string[] }>,
  suppressed: SuppressedBlockedFinding[],
  allowlistKeys: Set<string>,
  encounteredAllowlistKeys: Set<string>,
  onProgress?: ProgressCallback,
  maxVisitedDirs = 100_000
): Promise<{
  readonly completed: boolean;
  readonly issues: readonly ScanIssue[];
  readonly visitedDirectories: number;
}> {
  const queue: string[] = [startDir];
  let visited = 0;
  const issues: ScanIssue[] = [];

  while (queue.length > 0) {
    if (visited >= maxVisitedDirs) {
      // Exceeded bound — record refusal, do not continue
      const info = findings.get(BLOCKED_SCAN_BOUND_EXCEEDED_CATEGORY) ?? { count: 0, samples: [] };
      if (info.count < BLOCKED_COUNT_CAP) {
        info.count += 1;
      }
      findings.set(BLOCKED_SCAN_BOUND_EXCEEDED_CATEGORY, info);
      issues.push({ kind: 'bound_exceeded', count: 1 });
      return { completed: false, issues, visitedDirectories: visited };
    }

    const dirPath = queue.shift();
    if (!dirPath) break;
    visited++;

    // Progress callback every 100 directories
    if (onProgress && visited > 0 && visited % 100 === 0) {
      await onProgress('scan_dir', visited);
    }

    let entries: string[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // Permission/read failures are observability gaps, never silently
      // treated as an empty directory.
      issues.push({
        kind: 'permission_denied',
        count: 1,
        sample: relative(canonicalRoot, dirPath).replace(/\\/g, '/'),
      });
      continue;
    }

    for (const name of entries) {
      const pattern = blockedPatternForDirectoryName(name);
      if (pattern) {
        const fullPath = resolve(dirPath, name);
        const relPath = relative(canonicalRoot, fullPath).replace(/\\/g, '/');
        const allowlistKey = `${relPath}:${pattern.category}`;

        // Check allowlist FIRST (suppression): if this exact
        // relativePath+category is in the allowlist, record
        // suppression instead of a blocked finding.
        if (allowlistKeys.has(allowlistKey)) {
          encounteredAllowlistKeys.add(allowlistKey);
          suppressed.push({
            relativePath: relPath,
            category: pattern.category,
            matchedAllowlistEntry: {
              relativePath: relPath,
              category: pattern.category,
            },
          });
          // Do NOT descend into suppressed directories
          continue;
        }

        // Not suppressed — count as a blocked finding
        const info = findings.get(pattern.category) ?? { count: 0, samples: [] };
        if (info.count < BLOCKED_COUNT_CAP) {
          info.count += 1;
        }
        if (info.samples.length < BLOCKED_FINDING_SAMPLE_MAX) {
          if (relPath.length <= BLOCKED_FINDING_SAMPLE_PATH_MAX) {
            info.samples.push(relPath);
          }
        }
        findings.set(pattern.category, info);
        // Do NOT descend into matched directories
        continue;
      }

      // Enqueue non-matched directories for later processing
      const subPath = resolve(dirPath, name);
      if (existsSync(subPath)) {
        queue.push(subPath);
      }
    }
  }

  return { completed: true, issues, visitedDirectories: visited };
}

// ==========================================================================
// Deterministic hash helpers (for root/scope/policy/inventory/baseline/plan)
// ==========================================================================

/**
 * Version of the canonical root/scope/inventory/baseline hash encodings.
 *
 * v1 (legacy) joined `${path}:${hash}` lines with `\n`, which is ambiguous
 * when a source path itself contains `:` or `\n` (both legal in Git).  v2
 * hashes length-safe JSON documents tagged with an explicit family name and
 * version so future encoding changes land in a different hash space.
 */
export const CANONICAL_INVENTORY_HASH_VERSION = 2;

/** Encoding version of {@link computePolicyHash} (kept for stored-value compatibility). */
export const POLICY_HASH_VERSION = 1;

/**
 * Compare two strings by raw UTF-8 bytes (never locale-aware).
 * Canonical ordering must be identical across machines and locales.
 */
function byteOrderCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Sort path/content-hash pairs by path bytes, then hash bytes. */
function sortContentPairs(
  pairs: ReadonlyArray<readonly [string, string]>
): Array<readonly [string, string]> {
  return [...pairs].sort((a, b) => {
    const byPath = byteOrderCompare(a[0], b[0]);
    return byPath !== 0 ? byPath : byteOrderCompare(a[1], b[1]);
  });
}

/**
 * Hash one named hash family with an explicit version tag.
 *
 * The payload is serialised through deterministicHashJson (sorted keys), so
 * equivalent inputs always produce the same digest while structurally
 * different payloads cannot alias across families or versions.
 */
function canonicalFamilyHash(family: string, version: number, payload: unknown): string {
  return deterministicHashJson({ family, version, payload });
}

/**
 * SHA-256 over the canonical absolute project root path.
 *
 * Binds drift of the on-disk registration location (v2 encoding).
 */
export function computeRootHash(rootPath: string): string {
  return canonicalFamilyHash('project-rag.root', CANONICAL_INVENTORY_HASH_VERSION, {
    canonicalPath: realpathSync.native(rootPath),
  });
}

/** Hash of the include-root set; order-independent via UTF-8 byte sorting. */
export function computeScopeHash(includeRoots: readonly string[]): string {
  return canonicalFamilyHash('project-rag.scope', CANONICAL_INVENTORY_HASH_VERSION, {
    includeRoots: [...includeRoots].sort(byteOrderCompare),
  });
}

/**
 * Hash of the effective policy: sorted ignore-rules + allowlist hash.
 *
 * Encoded at `POLICY_HASH_VERSION` (v1) with sorted keys so existing stored
 * values remain comparable.  When `manifestDigest` is provided it is bound
 * into the policy hash (root-manifest integration); omitting it reproduces
 * exactly the pre-manifest digest, so callers that have no manifest keep
 * full backward compatibility.
 */
export function computePolicyHash(
  ignoreRules: readonly string[],
  allowlistHash?: string,
  manifestDigest?: string
): string {
  return deterministicHashJson({
    v: POLICY_HASH_VERSION,
    ignoreRules: [...ignoreRules].sort((a, b) => {
      const bufA = Buffer.from(a, 'utf8');
      const bufB = Buffer.from(b, 'utf8');
      return bufA.compare(bufB);
    }),
    allowlistHash: allowlistHash ?? EMPTY_ALLOWLIST_HASH,
    ...(manifestDigest !== undefined ? { manifestDigest } : {}),
  });
}

/**
 * Hash of the candidate-file inventory (sourcePath+contentHash pairs).
 *
 * v2 encoding: pairs are byte-sorted (path, then hash) before being hashed
 * as a JSON array, making the digest independent of input order and free of
 * the legacy `${path}:${hash}` delimiter ambiguity.
 */
export function computeInventoryHash(candidateFiles: readonly CandidateFileInfo[]): string {
  const pairs = sortContentPairs(candidateFiles.map((f) => [f.sourcePath, f.contentHash] as const));
  return canonicalFamilyHash('project-rag.inventory', CANONICAL_INVENTORY_HASH_VERSION, {
    files: pairs,
  });
}

/**
 * Hash of the tracked baseline (sourcePath+contentHash pairs).
 * Same unambiguous v2 pairing as {@link computeInventoryHash}.
 */
export function computeBaselineHash(trackedStates: readonly TrackedFileState[]): string {
  const pairs = sortContentPairs(trackedStates.map((f) => [f.sourcePath, f.contentHash] as const));
  return canonicalFamilyHash('project-rag.baseline', CANONICAL_INVENTORY_HASH_VERSION, {
    files: pairs,
  });
}

/**
 * Canonical identity of the evidence bound into one plan hash.
 *
 * Carried verbatim inside {@link computePlanHash} so two plans that differ
 * only in scan/manifest evidence produce different canonical plan hashes.
 */
export interface PreflightPlanEvidenceIdentity {
  /** Evidence hash from the completeness verdict. */
  readonly completenessEvidenceHash: string;
  /** Policy hash bound to the manifest digest (or legacy policy hash). */
  readonly manifestPolicyHash: string;
  /** Whether the plan grants deletion planning. */
  readonly deletionAllowed: boolean;
}

/** Hash of the plan parameters — includes force and targetSourcePath/command scope. */
export function computePlanHash(
  addsCount: number,
  updatesCount: number,
  deletesCount: number,
  stalePaths: readonly string[],
  force?: boolean,
  targetSourcePath?: string,
  evidence?: PreflightPlanEvidenceIdentity
): string {
  return deterministicHashJson({
    addsCount,
    updatesCount,
    deletesCount,
    stalePaths: [...stalePaths].sort(),
    ...(force === true ? { force } : {}),
    ...(targetSourcePath !== undefined ? { targetSourcePath } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  });
}

// ==========================================================================
// Preflight plan — full deterministic preflight
// ==========================================================================

/**
 * Evidence inputs wiring root-manifest policy and scan completeness into a
 * preflight plan.
 *
 * Both fields are OPTIONAL so existing positional callers stay source- and
 * behaviour-compatible — but omission is an EXPLICIT legacy default, never a
 * silent grant:
 *
 *  - `manifest` omitted → no manifest digest is folded into any hash; the
 *    top-level `policyHash` stays byte-identical to pre-manifest plans and
 *    `manifestPolicyHash === policyHash`.  Pass the {@link readRootManifest}
 *    result (root-manifest.ts) to bind manifest identity explicitly.
 *  - `scan` omitted → the plan classifies from its own blocked-finding walk
 *    only (`walkerObserved: false`).  Such a plan can NEVER be complete, so
 *    `deletionEligibility.allowed` is always false with reason
 *    `scan_evidence_not_provided` — omitted evidence never authorises
 *    deletion planning.
 */
export interface PreflightPlanEvidence {
  /**
   * Result of `readRootManifest()` for this canonical root.  When provided
   * together with `scan`, this field is authoritative for the verdict's
   * manifest state (single source of truth shared with the policy hash).
   */
  readonly manifest?: RootManifestReadResult;
  /** Walker-supplied observation forwarded to `evaluateScanCompleteness`. */
  readonly scan?: ScanObservation;
  /** Upper bound on planned-deletion listings (forwarded unchanged). */
  readonly maxPlannedDeletions?: number;
}

/** Deletion-eligibility decision carried on the plan, with its authority. */
export interface PreflightPlanDeletionEligibility {
  /**
   * Which authority produced {@link PreflightPlanDeletionEligibility.decision}:
   *  - `scan_completeness` — decided by the scan-completeness verdict.
   *  - `legacy_default` — evidence was omitted; always refuses with
   *    explicit reasons.
   */
  readonly basis: 'scan_completeness' | 'legacy_default';
  readonly decision: DeletionPlanDecision;
}

export interface PreflightPlan {
  readonly rootHash: string;
  readonly scopeHash: string;
  readonly policyHash: string;
  readonly inventoryHash: string;
  readonly baselineHash: string;
  readonly planHash: string;
  readonly addsCount: number;
  readonly updatesCount: number;
  readonly deletesCount: number;
  readonly eligibleCount: number;
  readonly trackedCount: number;
  readonly totalDelta: number;
  readonly force: boolean;
  readonly blockedFindings: BlockedFinding[];
  readonly blockedFindingAllowlistHash: string;
  readonly suppressedBlockedFindings: readonly SuppressedBlockedFinding[];
  readonly candidateFiles: readonly CandidateFileInfo[];
  readonly trackedStates: readonly TrackedFileState[];
  readonly stalePaths: readonly string[];
  /**
   * Policy hash bound to the root-manifest digest.  Equal to `policyHash`
   * when manifest evidence is omitted (legacy) or rejected (no trustworthy
   * digest exists to bind); otherwise folds EMPTY_ROOT_MANIFEST_HASH
   * (explicit absence) or the raw-bytes digest (valid manifest).
   */
  readonly manifestPolicyHash: string;
  /** Fail-closed completeness verdict for this scan (see scan-completeness.ts). */
  readonly completeness: ScanCompletenessVerdict;
  /** Whether deletion planning is granted — only `complete` scans qualify. */
  readonly deletionEligibility: PreflightPlanDeletionEligibility;
  /** Compact summary for the result (no absolute paths, no secrets). */
  readonly summary: {
    readonly rootHash: string;
    readonly scopeHash: string;
    readonly policyHash: string;
    readonly inventoryHash: string;
    readonly baselineHash: string;
    readonly planHash: string;
    readonly addsCount: number;
    readonly updatesCount: number;
    readonly deletesCount: number;
    readonly eligibleCount: number;
    readonly trackedCount: number;
    readonly totalDelta: number;
    readonly force: boolean;
    readonly blockedFindingCategories: string;
    readonly blockedFindingAllowlistHash: string;
    readonly suppressedBlockedFindingCount: number;
    readonly manifestPolicyHash: string;
    readonly completenessStatus: ScanCompletenessStatus;
    readonly completenessEvidenceHash: string;
    readonly deletionEligible: boolean;
  };
}

/**
 * Build the full deterministic preflight plan.
 *
 * Uses the **same** scanner/policy as ingest-postgres.ts:
 *  - `DEFAULT_IGNORE_RULES` glob patterns
 *  - `SOURCE_EXTENSIONS` extension filter
 *  - `calculateProjectContentHash` content hash function
 *
 * When `force` is true, every eligible candidate that already exists in
 * tracked is counted as an update (even if content hash matches).
 *
 * IMPORTANT — full-inventory gate invariant:
 * The inventory hash, baseline hash, and delta counts (adds, updates,
 * deletes, eligible, totalDelta) are ALWAYS computed from the FULL
 * inventory, even when `targetSourcePath` is set.  The returned
 * `candidateFiles` may be filtered to only the target file, and
 * `stalePaths` is forced to [] in single-file mode, but the inventory
 * evidence and plan hash bind the complete project state.  This prevents a
 * single-file call from silently changing unrelated project rows.
 *
 * @param rootPath        canonical project root
 * @param includeRoots    validated include roots
 * @param ignoreRules     project-specific ignore rules
 * @param trackedStates   current tracked file states (from `listProjectRagPostgresFileStates`)
 * @param targetSourcePath optional — when set, only this file is in candidateFiles (returned for execution)
 * @param force           when true, count every tracked candidate as an update
 * @param onProgress      optional progress callback (invoked every bounded N files/dirs during scan)
 * @param allowlist       optional exact-path blocked-finding allowlist
 * @param options         optional blocked-scan options (maxVisitedDirs etc.)
 * @param evidence        optional manifest + scan-completeness evidence.  Omitted
 *                        evidence is an explicit legacy default: policy hashes stay
 *                        byte-identical and deletion planning is refused with
 *                        `scan_evidence_not_provided` (never silently granted).
 */
export async function buildPreflightPlan(
  rootPath: string,
  includeRoots: readonly string[],
  ignoreRules: readonly string[],
  trackedStates: readonly TrackedFileState[],
  targetSourcePath?: string,
  force?: boolean,
  onProgress?: ProgressCallback,
  allowlist?: readonly BlockedFindingAllowlistEntry[],
  options?: BlockedScanOptions,
  evidence?: PreflightPlanEvidence
): Promise<PreflightPlan> {
  const rootHash = computeRootHash(rootPath);
  const scopeHash = computeScopeHash(includeRoots);

  // Compute allowlist hash (separate from policy hash)
  const blockedFindingAllowlistHash = hashBlockedFindingAllowlist(allowlist ?? []);

  // policyHash hashes the EFFECTIVE (merged) policy BINDING ignore rules + allowlist hash
  const effectiveRules = effectivePolicy(DEFAULT_IGNORE_RULES, ignoreRules, includeRoots);
  const policyHash = computePolicyHash(effectiveRules, blockedFindingAllowlistHash);

  // ---- Root-manifest evidence (explicit; omitted = legacy default) --------
  // Legacy: no digest folded anywhere → policyHash stays byte-identical to
  // pre-manifest plans and manifestPolicyHash === policyHash.
  // Explicit absence folds EMPTY_ROOT_MANIFEST_HASH; a valid manifest folds
  // its raw-bytes digest.  A rejected manifest has no trustworthy digest to
  // bind (falls back to the legacy hash) and classifies as blocked below.
  const manifestResult = evidence?.manifest;
  let manifestState: ScanManifestState;
  let manifestDigestForPolicy: string | undefined;
  if (manifestResult === undefined) {
    manifestState = { state: 'absent' };
  } else {
    manifestState = manifestStateFromReadResult(manifestResult);
    if (!manifestResult.present) {
      manifestDigestForPolicy = EMPTY_ROOT_MANIFEST_HASH;
    } else if (manifestResult.ok) {
      manifestDigestForPolicy = manifestResult.digest;
    }
  }
  const manifestPolicyHash = computePolicyHash(
    effectiveRules,
    blockedFindingAllowlistHash,
    manifestDigestForPolicy
  );

  // Scan ALL candidates using the SAME scanner as ingest (with merged rules)
  // This is the full project inventory — NOT filtered to targetSourcePath.
  // The inventory hash, delta, and deletion evidence must reflect the entire project
  // even in single-file mode (full-inventory gate invariant).
  const { candidateFiles: allCandidates } = await scanCandidateFiles(
    rootPath,
    includeRoots,
    effectiveRules,
    onProgress
  );

  // inventoryHash from ALL candidates (full project state)
  const inventoryHash = computeInventoryHash(allCandidates);

  // Build tracked baseline from ALL tracked states
  const trackedByPath = new Map(trackedStates.map((s) => [s.sourcePath, s]));
  const baselineHash = computeBaselineHash(trackedStates);

  // Compute delta from the FULL inventory.
  // When force=true without a single-file target: every tracked candidate is an
  // update (full force-refresh).  When force=true WITH targetSourcePath: only
  // the target is force-counted; other files still count when content drifted.
  // This keeps single-file force repair scoped to the requested candidate
  // while full-project --force remains a deliberate whole-project refresh.
  const trackedCount = trackedStates.length;
  let addsCount = 0;
  let updatesCount = 0;
  let eligibleCount = 0;

  for (const candidate of allCandidates) {
    const tracked = trackedByPath.get(candidate.sourcePath);
    eligibleCount++;
    if (!tracked) {
      addsCount++;
    } else {
      const forceThisFile =
        force === true && (!targetSourcePath || candidate.sourcePath === targetSourcePath);
      if (forceThisFile || tracked.contentHash !== candidate.contentHash) {
        updatesCount++;
      }
    }
  }

  // Deletes/stalePaths FROM the full inventory comparison.
  // In single-file mode, stalePaths is forced to [] for execution safety
  // (single-file must never delete non-target paths), but the deletesCount
  // from the full inventory is still retained for the deletion decision.
  const fullStalePaths = trackedStates
    .filter((s) => !new Set(allCandidates.map((f) => f.sourcePath)).has(s.sourcePath))
    .map((s) => s.sourcePath)
    .sort();
  const deletesCount = fullStalePaths.length;

  // In single-file mode: stalePaths returned for execution MUST be [],
  // and candidateFiles returned for execution MUST be target-only.
  const stalePaths = targetSourcePath ? [] : fullStalePaths;
  const candidateFiles = targetSourcePath
    ? allCandidates.filter((f) => f.sourcePath === targetSourcePath)
    : allCandidates;

  const totalDelta = addsCount + updatesCount + deletesCount;

  // Detect blocked findings under include roots with suppression
  const detectResult = await detectBlockedFindings(
    rootPath,
    includeRoots,
    allowlist,
    onProgress,
    options
  );
  const { blockedFindings, suppressedBlockedFindings } = detectResult;

  const blockedFindingCategories =
    blockedFindings.length > 0
      ? blockedFindings.map((f) => `${f.category}:${f.count}`).join(', ')
      : 'none';

  // ---- Scan-completeness verdict (fail-closed; see scan-completeness.ts) --
  // With evidence omitted, classify ONLY from this plan's own blocked walk:
  // walkerObserved:false records an explicit `scan_evidence_not_provided`
  // incompleteness reason, so a legacy plan can never be complete and can
  // never grant deletion planning.
  // The top-level manifest evidence is authoritative for the verdict's
  // manifest state whenever it is provided (single source of truth shared
  // with manifestPolicyHash); otherwise a caller-supplied scan keeps its own
  // embedded manifest state.
  const evidenceScan = evidence?.scan;
  const scanProvided = evidenceScan !== undefined || evidence?.manifest !== undefined;
  const observation: ScanObservation = evidenceScan
    ? manifestResult !== undefined
      ? { ...evidenceScan, manifest: manifestState }
      : evidenceScan
    : evidence?.manifest !== undefined
      ? {
          walkerObserved: detectResult.walkerObserved,
          issues: detectResult.scanIssues,
          blockedFindings,
          eligibleFileCount: allCandidates.length,
          scannedPathCount: detectResult.scannedPathCount,
          manifest: manifestState,
        }
      : {
          walkerObserved: false,
          blockedFindings,
          eligibleFileCount: allCandidates.length,
          manifest: manifestState,
        };
  const completeness = evaluateScanCompleteness(observation);

  // ---- Deletion eligibility: ONLY complete scans may plan deletions -------
  let deletionEligibility: PreflightPlanDeletionEligibility;
  if (completeness.status !== 'complete') {
    deletionEligibility = {
      basis: scanProvided ? 'scan_completeness' : 'legacy_default',
      decision: {
        allowed: false,
        status: completeness.status,
        reasonCodes: completeness.reasons.map((reason) => reason.code),
      },
    };
  } else {
    deletionEligibility = {
      basis: 'scan_completeness',
      decision: decideDeletionEligibility({
        verdict: completeness,
        candidateSourcePaths: allCandidates.map((f) => f.sourcePath),
        trackedSourcePaths: trackedStates.map((s) => s.sourcePath),
        ...(evidence?.maxPlannedDeletions !== undefined
          ? { maxPlannedDeletions: evidence.maxPlannedDeletions }
          : {}),
      }),
    };
  }

  // Canonical plan hash binds the evidence identity when evidence is
  // provided; legacy callers (evidence omitted) keep byte-identical hashes.
  const evidenceIdentity: PreflightPlanEvidenceIdentity | undefined =
    evidence === undefined
      ? undefined
      : {
          completenessEvidenceHash: completeness.evidenceHash,
          manifestPolicyHash,
          deletionAllowed: deletionEligibility.decision.allowed,
        };
  const planHash = computePlanHash(
    addsCount,
    updatesCount,
    deletesCount,
    fullStalePaths,
    force,
    targetSourcePath,
    evidenceIdentity
  );

  return {
    rootHash,
    scopeHash,
    policyHash,
    inventoryHash,
    baselineHash,
    planHash,
    addsCount,
    updatesCount,
    deletesCount,
    eligibleCount,
    trackedCount,
    totalDelta,
    force: force ?? false,
    blockedFindings,
    blockedFindingAllowlistHash,
    suppressedBlockedFindings,
    candidateFiles,
    trackedStates,
    stalePaths,
    manifestPolicyHash,
    completeness,
    deletionEligibility,
    summary: {
      rootHash,
      scopeHash,
      policyHash,
      inventoryHash,
      baselineHash,
      planHash,
      addsCount,
      updatesCount,
      deletesCount,
      eligibleCount,
      trackedCount,
      totalDelta,
      force: force ?? false,
      blockedFindingCategories,
      blockedFindingAllowlistHash,
      suppressedBlockedFindingCount: suppressedBlockedFindings.length,
      manifestPolicyHash,
      completenessStatus: completeness.status,
      completenessEvidenceHash: completeness.evidenceHash,
      deletionEligible: deletionEligibility.decision.allowed,
    },
  };
}
