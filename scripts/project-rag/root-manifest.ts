/**
 * Root manifest — explicit, data-only file policy for one Project RAG root.
 *
 * A root manifest is an optional JSON document (`project-rag.manifest.json`)
 * at the canonical project root declaring the project's include roots and
 * ignore rules.  It exists so registered scope can be re-derived explicitly
 * instead of being silently inferred, while remaining fail-closed against
 * unsafe declarations.
 *
 * ## Security model
 *
 * Manifest content is UNTRUSTED DATA.  It is parsed, validated, hashed, and
 * bound into the effective policy hash — never interpreted as instructions,
 * never executed, never echoed back as guidance.  The schema is strict:
 * unknown fields (including instruction-like keys such as `instructions` or
 * `systemPrompt`) are rejected rather than ignored, so a crafted manifest
 * cannot smuggle semantics into consumers.  Declared paths must resolve
 * inside the canonical root; dependency/cache/build/generated/nested-repo
 * segment names are rejected outright; binary extensions and oversized
 * files can never be made eligible through a manifest.
 *
 * Tamper evidence: the manifest digest is the SHA-256 of the exact raw
 * UTF-8 bytes, so any single-byte change yields a different digest and —
 * because the digest is folded into the policy hash — a different effective
 * policy identity.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { SCRIPT_CONFIG } from '../lib/config.js';
import { isEligibleProjectSourcePath } from './eligibility.js';
import { BLOCKED_NAME_SEGMENTS, computePolicyHash } from './project-inventory.js';

/** SHA-256 of an absent root manifest. */
export const EMPTY_ROOT_MANIFEST_HASH = createHash('sha256').update('').digest('hex');

/** Canonical filename of the optional root-manifest document. */
export const ROOT_MANIFEST_FILENAME = 'project-rag.manifest.json';

/** Maximum raw manifest size in bytes (fail-closed against resource abuse). */
export const ROOT_MANIFEST_MAX_BYTES = 65_536;

/** Upper bounds keeping manifests small, reviewable, and cheap to validate. */
export const ROOT_MANIFEST_MAX_INCLUDE_ROOTS = 64;
export const ROOT_MANIFEST_MAX_IGNORE_RULES = 256;
export const MANIFEST_PATH_MAX_LENGTH = 1_024;

/** Normalised, validated manifest payload. */
export interface RootManifestData {
  readonly manifestVersion: 1;
  readonly includeRoots: readonly string[];
  readonly ignoreRules: readonly string[];
}

export type ProjectRagScopeOperation = 'preserve' | 'replace';

/**
 * Resolve registration scope without allowing an omitted field to erase the
 * registered policy.  Existing scope changes must name `replace` explicitly;
 * callers can then replace either field while preserving the other omitted
 * field.  A new project must still provide a non-empty include-root set.
 */
export function resolveProjectRagScope(input: {
  readonly existingIncludeRoots?: readonly string[];
  readonly existingIgnoreRules?: readonly string[];
  readonly requestedIncludeRoots?: readonly string[];
  readonly requestedIgnoreRules?: readonly string[];
  readonly manifest?: RootManifestData;
  readonly scopeOperation?: ProjectRagScopeOperation;
}): { readonly includeRoots: string[]; readonly ignoreRules: string[]; readonly changed: boolean } {
  const hasExisting = input.existingIncludeRoots !== undefined;
  const requestedIncludeRoots = input.requestedIncludeRoots;
  const requestedIgnoreRules = input.requestedIgnoreRules;
  const requestedIncludeRootsChanged =
    requestedIncludeRoots !== undefined &&
    JSON.stringify(requestedIncludeRoots) !== JSON.stringify(input.existingIncludeRoots ?? []);
  const requestedIgnoreRulesChanged =
    requestedIgnoreRules !== undefined &&
    JSON.stringify(requestedIgnoreRules) !== JSON.stringify(input.existingIgnoreRules ?? []);
  const operation = input.scopeOperation ?? 'preserve';

  if (operation !== 'preserve' && operation !== 'replace') {
    throw new Error(`Unsupported scope operation: ${String(operation)}`);
  }
  if (
    hasExisting &&
    (requestedIncludeRootsChanged || requestedIgnoreRulesChanged) &&
    operation !== 'replace'
  ) {
    throw new Error(
      'SCOPE_MUTATION_REQUIRES_OPERATION: includeRoots or ignoreRules changes require scopeOperation=replace'
    );
  }
  const manifestIncludeRoots = input.manifest?.includeRoots;
  const manifestIgnoreRules = input.manifest?.ignoreRules;
  const includeRoots = hasExisting
    ? operation === 'replace' && requestedIncludeRoots !== undefined
      ? [...requestedIncludeRoots]
      : [...(input.existingIncludeRoots ?? [])]
    : [...(requestedIncludeRoots ?? manifestIncludeRoots ?? [])];
  const ignoreRules = hasExisting
    ? operation === 'replace' && requestedIgnoreRules !== undefined
      ? [...requestedIgnoreRules]
      : [...(input.existingIgnoreRules ?? [])]
    : [...(requestedIgnoreRules ?? manifestIgnoreRules ?? [])];

  if (includeRoots.length === 0) {
    throw new Error(
      'SCOPE_REQUIRED: a new Project RAG registration requires includeRoots or a manifest includeRoots declaration'
    );
  }

  return {
    includeRoots,
    ignoreRules,
    changed:
      !hasExisting ||
      JSON.stringify(includeRoots) !== JSON.stringify(input.existingIncludeRoots ?? []) ||
      JSON.stringify(ignoreRules) !== JSON.stringify(input.existingIgnoreRules ?? []),
  };
}

const rootManifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  includeRoots: z.array(z.string()).max(ROOT_MANIFEST_MAX_INCLUDE_ROOTS).optional(),
  ignoreRules: z.array(z.string()).max(ROOT_MANIFEST_MAX_IGNORE_RULES).optional(),
});

/** Windows reserved device names, case-insensitive, optionally extended. */
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Control characters that must never appear inside a declared path. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — this validator exists to detect control characters in declared paths
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

function extensionOf(pathValue: string): string {
  const base = pathValue.split('/').pop() ?? '';
  const index = base.lastIndexOf('.');
  return index >= 0 ? base.slice(index).toLowerCase() : '';
}

function isPathInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(rootPath, absolutePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

export type ManifestPathKind = 'directory' | 'file';

/**
 * Validate one manifest-declared relative path syntactically.
 *
 * Returns the list of violations (empty means valid).  Checks cover path
 * traversal, absolute/drive/UNC forms, backslashes, control characters,
 * oversized paths, blocked dependency/cache/build/generated/nested-repo
 * directory segments, Windows reserved device names, trailing dot/space
 * segments, and — for files — non-source extensions (binary rejection).
 */
export function findManifestPathViolations(
  pathValue: string,
  kind: ManifestPathKind = 'directory'
): string[] {
  const errors: string[] = [];
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return ['path must be a non-empty string'];
  }
  if (pathValue.length > MANIFEST_PATH_MAX_LENGTH) {
    errors.push(`path exceeds ${MANIFEST_PATH_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHAR_PATTERN.test(pathValue)) {
    errors.push('path contains control characters');
  }
  if (pathValue.includes('\\')) {
    errors.push('path contains backslash separators');
  }
  if (pathValue.startsWith('/')) {
    errors.push('path must be relative, not absolute');
  }
  if (/^[A-Za-z]:/.test(pathValue)) {
    errors.push('drive-letter paths are not allowed');
  }

  const segments = pathValue.split('/');
  for (const [index, segment] of segments.entries()) {
    if (segment === '') {
      errors.push('path contains an empty segment (double slash or leading/trailing slash)');
      continue;
    }
    if (segment === '.' || segment === '..') {
      errors.push(`path segment ${JSON.stringify(segment)} is not allowed`);
      continue;
    }
    if (BLOCKED_NAME_SEGMENTS.has(segment)) {
      errors.push(
        `path segment ${JSON.stringify(segment)} matches a blocked dependency/cache/nested-repo name`
      );
    }
    if (WINDOWS_RESERVED_NAME_PATTERN.test(segment)) {
      errors.push(`path segment ${JSON.stringify(segment)} is a reserved device name`);
    }
    const isLast = index === segments.length - 1;
    if ((segment.endsWith('.') || segment.endsWith(' ')) && !isLast) {
      errors.push(`directory segment ${JSON.stringify(segment)} ends with a dot or space`);
    }
  }
  const lastSegment = segments[segments.length - 1] ?? '';
  if (lastSegment !== '' && (lastSegment.endsWith('.') || lastSegment.endsWith(' '))) {
    errors.push(`final segment ${JSON.stringify(lastSegment)} ends with a dot or space`);
  }

  if (kind === 'file' && errors.length === 0 && !isEligibleProjectSourcePath(pathValue)) {
    const ext = extensionOf(pathValue);
    errors.push(
      ext.length > 0
        ? `file extension ${JSON.stringify(ext)} is not an eligible source extension`
        : `file path ${JSON.stringify(pathValue)} is not an eligible source file`
    );
  }
  return [...new Set(errors)];
}

/**
 * Validate one declared include root against the filesystem.
 *
 * Syntactic checks first ({@link findManifestPathViolations}); then, when
 * the target exists, its real path must still resolve inside the canonical
 * root so symlink escapes fail closed.  Existence itself is NOT required —
 * manifests may declare roots before materialisation; callers decide whether
 * missing include roots are acceptable at scan time.
 */
export async function validateManifestIncludeRoot(
  canonicalRoot: string,
  includeRoot: string
): Promise<string[]> {
  const errors = findManifestPathViolations(includeRoot, 'directory');
  if (errors.length > 0) {
    return errors;
  }
  const absolutePath = resolve(canonicalRoot, includeRoot);
  if (!isPathInsideRoot(canonicalRoot, absolutePath)) {
    return [`include root ${JSON.stringify(includeRoot)} resolves outside the project root`];
  }
  try {
    const realPath = await realpath(absolutePath);
    if (!isPathInsideRoot(canonicalRoot, realPath)) {
      errors.push(
        `include root ${JSON.stringify(includeRoot)} escapes the project root via symlinks`
      );
    }
  } catch {
    // Missing targets are tolerated here; scan-time validation decides.
  }
  return errors;
}

/**
 * Validate one ignore rule: non-empty, bounded length, no control
 * characters.  Glob semantics are owned by the scanner; this only rejects
 * values that cannot participate safely in a canonical policy hash.
 */
export function findIgnoreRuleViolations(rule: string): string[] {
  const errors: string[] = [];
  if (typeof rule !== 'string' || rule.trim() === '') {
    return ['ignore rule must be a non-empty string'];
  }
  if (rule.length > MANIFEST_PATH_MAX_LENGTH) {
    errors.push(`ignore rule exceeds ${MANIFEST_PATH_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHAR_PATTERN.test(rule)) {
    errors.push('ignore rule contains control characters');
  }
  return errors;
}

/**
 * Enforce eligible-file policy for anything a manifest-based flow intends
 * to index: safe relative path, source-code extension (binary rejection),
 * and size within {@link SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES} (large-file
 * rejection).  Throws fail-closed with every violation listed.
 */
export function validateManifestEligibleFile(relativePath: string, sizeBytes: number): void {
  const violations = findManifestPathViolations(relativePath, 'file');
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    violations.push(`sizeBytes must be a positive integer, got ${String(sizeBytes)}`);
  }
  if (Number.isInteger(sizeBytes) && sizeBytes > SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES) {
    violations.push(
      `file exceeds MAX_FILE_SIZE_BYTES (${SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES}), got ${sizeBytes}`
    );
  }
  if (violations.length > 0) {
    throw new Error(`Manifest file policy rejected '${relativePath}': ${violations.join('; ')}`);
  }
}

export type RootManifestParseResult =
  | { readonly ok: true; readonly manifest: RootManifestData; readonly digest: string }
  | { readonly ok: false; readonly errors: readonly string[]; readonly digest: string };

/** Maximum number of collected diagnostics before failing closed. */
const MAX_REPORTED_ERRORS = 50;

/**
 * Parse and fully validate a raw manifest document (data-only).
 *
 * The returned digest binds the EXACT raw bytes; structural normalisation
 * happens only in the parsed payload.  All schema, semantic, duplicate, and
 * filesystem-escape findings are collected (bounded) instead of fail-first
 * so callers get actionable diagnostics in one shot.
 */
export function parseRootManifestDocument(raw: string): RootManifestParseResult {
  const digest = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
  const errors: string[] = [];

  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > ROOT_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      errors: [`manifest exceeds ${ROOT_MANIFEST_MAX_BYTES} bytes (got ${byteLength})`],
      digest,
    };
  }

  let unknown: unknown;
  try {
    unknown = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
      digest,
    };
  }

  const parsed = rootManifestSchema.safeParse(unknown);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, MAX_REPORTED_ERRORS)) {
      errors.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    if (parsed.error.issues.length > MAX_REPORTED_ERRORS) {
      errors.push(`...and ${parsed.error.issues.length - MAX_REPORTED_ERRORS} more issues`);
    }
    return { ok: false, errors, digest };
  }

  const includeRoots = parsed.data.includeRoots ?? [];
  const ignoreRules = parsed.data.ignoreRules ?? [];

  // Duplicates are rejected: explicit policy must stay reviewable.
  const seenIncludeRoots = new Set<string>();
  for (const [index, entry] of includeRoots.entries()) {
    for (const violation of findManifestPathViolations(entry, 'directory')) {
      errors.push(`includeRoots[${index}] (${JSON.stringify(entry)}): ${violation}`);
    }
    const duplicateKey = entry.normalize('NFC');
    if (seenIncludeRoots.has(duplicateKey)) {
      errors.push(`includeRoots[${index}]: duplicate include root ${JSON.stringify(entry)}`);
    }
    seenIncludeRoots.add(duplicateKey);
  }

  const seenRules = new Set<string>();
  for (const [index, rule] of ignoreRules.entries()) {
    for (const violation of findIgnoreRuleViolations(rule)) {
      errors.push(`ignoreRules[${index}]: ${violation}`);
    }
    if (seenRules.has(rule)) {
      errors.push(`ignoreRules[${index}]: duplicate ignore rule ${JSON.stringify(rule)}`);
    }
    seenRules.add(rule);
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors.slice(0, MAX_REPORTED_ERRORS + 1), digest };
  }

  return {
    ok: true,
    manifest: {
      manifestVersion: 1,
      includeRoots: [...includeRoots],
      ignoreRules: [...ignoreRules],
    },
    digest,
  };
}

export type RootManifestReadResult =
  | {
      readonly present: false;
      readonly manifest: RootManifestData;
      readonly digest: typeof EMPTY_ROOT_MANIFEST_HASH;
    }
  | {
      readonly present: true;
      readonly ok: true;
      readonly manifest: RootManifestData;
      readonly digest: string;
    }
  | { readonly present: true; readonly ok: false; readonly errors: readonly string[] };

/**
 * Read and validate the root manifest for a canonical project root.
 *
 * Absent file → empty default manifest with {@link EMPTY_ROOT_MANIFEST_HASH}
 * (never an error).  Present but invalid → structured failure with the
 * tamper-evident digest of whatever bytes were found.  Never interprets
 * manifest content beyond the strict schema.
 */
export async function readRootManifest(rootPath: string): Promise<RootManifestReadResult> {
  const manifestPath = resolve(rootPath, ROOT_MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return {
        present: false,
        manifest: { manifestVersion: 1, includeRoots: [], ignoreRules: [] },
        digest: EMPTY_ROOT_MANIFEST_HASH,
      };
    }
    return {
      present: true,
      ok: false,
      errors: [
        `unable to read ${ROOT_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const parsed = parseRootManifestDocument(raw);
  if (!parsed.ok) {
    return { present: true, ok: false, errors: parsed.errors };
  }

  // Filesystem containment pass for declared include roots.
  const containmentErrors: string[] = [];
  for (const [index, includeRoot] of parsed.manifest.includeRoots.entries()) {
    for (const violation of await validateManifestIncludeRoot(rootPath, includeRoot)) {
      containmentErrors.push(`includeRoots[${index}]: ${violation}`);
    }
  }
  if (containmentErrors.length > 0) {
    return { present: true, ok: false, errors: containmentErrors };
  }

  return {
    present: true,
    ok: true,
    manifest: parsed.manifest,
    digest: parsed.digest,
  };
}

/**
 * Bind a validated manifest digest into the effective policy hash.
 *
 * A null/absent manifest digest reproduces exactly the pre-manifest policy
 * hash; providing one changes the policy identity, so any manifest edit —
 * including a single-byte tamper — is detectable through the policy hash.
 *
 * @param params.effectiveIgnoreRules already-merged ignore rules for the scan
 * @param params.allowlistHash optional blocked-finding allowlist hash
 * @param params.manifestDigest raw-bytes manifest digest, or null when absent
 */
export function computeManifestPolicyHash(params: {
  readonly effectiveIgnoreRules: readonly string[];
  readonly allowlistHash?: string;
  readonly manifestDigest: string | null;
}): string {
  return computePolicyHash(
    params.effectiveIgnoreRules,
    params.allowlistHash,
    params.manifestDigest ?? undefined
  );
}
