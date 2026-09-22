import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { minimatch } from 'minimatch';
import {
  buildProjectIgnoreGlobPatterns,
  NOISY_INCLUDE_ROOT_SEGMENTS,
} from '../../lib/shared/project-include-roots.js';
import { SCRIPT_CONFIG } from '../lib/config.js';
import { isEligibleProjectSourcePath } from './eligibility.js';

export interface ProjectRagGitCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export type ProjectRagGitRunner = (
  cwd: string,
  args: readonly string[]
) => Promise<ProjectRagGitCommandResult>;

/** One canonicalised `git status --porcelain=v1 -z` entry. */
export interface ProjectRagStatusEntry {
  /** Index (staged) status code, e.g. `M`, `A`, `?`. */
  readonly x: string;
  /** Worktree status code, e.g. `M`, `D`, `?`. */
  readonly y: string;
  /** Current path as Git reports it (rename destination for renames). */
  readonly path: string;
  /** Original path for rename/copy entries, otherwise null. */
  readonly origPath: string | null;
}

export interface ResolvedProjectRagWorkspaceContext {
  readonly repositoryCommonDir: string;
  /**
   * Absolute, canonicalised Git dir of THIS worktree.  For the main worktree
   * this is typically `<root>/.git`; for a linked worktree it is
   * `<commonDir>/worktrees/<id>`.  Together with `repositoryCommonDir` it
   * distinguishes multiple worktrees of one repository without any
   * machine-specific identity assumption.
   */
  readonly worktreeGitDir: string;
  /** Stable binding for the Git repository identity. */
  readonly repositoryHash: string;
  /** Stable binding for this worktree within the repository. */
  readonly workspaceHash: string;
  readonly remoteUrl: string | null;
  /** Relative path of the registered project root within the Git worktree. */
  readonly scopePath: string;
  readonly workspaceRoot: string;
  /** Commit OID when HEAD resolves; null on an unborn branch or bare failure. */
  readonly headOid: string | null;
  /** Hash of the HEAD OID, including an explicit unborn marker. */
  readonly headHash: string;
  /** Short branch name; null when detached. */
  readonly branchName: string | null;
  /** Hash of the branch name or detached marker. */
  readonly branchHash: string;
  /** True when HEAD resolves to a commit but no branch is checked out. */
  readonly isDetached: boolean;
  /** Hash of the detached/attached state. */
  readonly detachedHash: string;
  /**
   * True when HEAD names a branch that does not exist yet (no commits).
   * Detected as: symbolic-ref succeeds AND HEAD does not resolve.
   */
  readonly isUnborn: boolean;
  /**
   * SHA-256 over the canonical, order-stable encoding of the porcelain
   * status entries — the dirty *shape* signal.  Two different contents can
   * share this digest (e.g. two successive edits to one modified file);
   * use {@link dirtyDigest} to distinguish them.
   */
  readonly statusDigest: string;
  /** SHA-256 over complete content digests of every eligible scoped path. */
  readonly contentFingerprint: string;
  /** Alias used when binding dirty eligible content to persistence. */
  readonly contentHash: string;
  /**
   * Combined stable dirty/content signal:
   * SHA-256(`${statusDigest}\n${contentFingerprint}`).
   */
  readonly dirtyDigest: string;
  /**
   * Scoped corpus identity. Branch names, HEAD metadata, and remote aliases
   * are intentionally excluded; worktree, scope, policy, content, and dirty
   * membership remain part of the identity.
   */
  readonly identityDigest: string;
}

/** The identity fields persisted with a revision and ingest snapshot. */
export interface ProjectRagIdentityBinding {
  readonly repositoryHash: string;
  readonly workspaceHash: string;
  readonly headHash: string;
  readonly branchHash: string;
  readonly detachedHash: string;
  readonly contentHash: string;
  readonly identityDigest: string;
  readonly headOid: string | null;
  readonly branchName: string | null;
  readonly isDetached: boolean;
  readonly isUnborn: boolean;
}

export function projectRagIdentityBinding(
  context: ResolvedProjectRagWorkspaceContext
): ProjectRagIdentityBinding {
  return {
    repositoryHash: context.repositoryHash,
    workspaceHash: context.workspaceHash,
    headHash: context.headHash,
    branchHash: context.branchHash,
    detachedHash: context.detachedHash,
    contentHash: context.contentHash,
    identityDigest: context.identityDigest,
    headOid: context.headOid,
    branchName: context.branchName,
    isDetached: context.isDetached,
    isUnborn: context.isUnborn,
  };
}

/** Maximum number of scoped paths hashed into the content fingerprint. */
const CONTENT_FINGERPRINT_MAX_FILES = 4_096;

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

async function runGitCommand(
  cwd: string,
  args: readonly string[]
): Promise<ProjectRagGitCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', ['-C', cwd, ...args]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', () => {
      resolveResult({ exitCode: 127, stdout: new Uint8Array(), stderr: new Uint8Array() });
    });
    child.once('close', (exitCode) => {
      resolveResult({
        exitCode: exitCode ?? 1,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: new Uint8Array(Buffer.concat(stderr)),
      });
    });
  });
}

function requireGitOutput(result: ProjectRagGitCommandResult, description: string): string {
  const output = decode(result.stdout);
  if (result.exitCode !== 0 || !output) {
    throw new Error(`Unable to resolve ${description} for this Git workspace`);
  }
  return output;
}

async function optionalGitOutput(
  runner: ProjectRagGitRunner,
  cwd: string,
  args: readonly string[]
): Promise<string | null> {
  const result = await runner(cwd, args);
  return result.exitCode === 0 ? decode(result.stdout) || null : null;
}

function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Parse `git status --porcelain=v1 -z` output into canonical entries.
 *
 * In `-z` mode paths are NUL-separated and never quoted; rename/copy entries
 * are followed by a second NUL-terminated field holding the original path.
 * Parsing failures throw loudly instead of silently degrading the digest.
 */
export const NON_CORPUS_SEGMENTS: ReadonlySet<string> = new Set([...NOISY_INCLUDE_ROOT_SEGMENTS]);

export function isCorpusPath(
  pathValue: string,
  options?: {
    readonly includeRoots?: readonly string[];
    readonly ignoreRules?: readonly string[];
  }
): boolean {
  const normalized = pathValue.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const segments = normalized.split('/');
  const rootIngest = segments[0]?.toLowerCase() === 'ingest';
  const explicitlySelectedRootIngest = (options?.includeRoots ?? []).some((root) => {
    const normalizedRoot = root
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    return (
      normalizedRoot.toLowerCase() === 'ingest' ||
      normalizedRoot.toLowerCase().startsWith('ingest/')
    );
  });
  // `ingest/` is a generated corpus at this repository's root, but is also a
  // valid consumer source root. It is eligible only when the caller selected
  // that root explicitly; inferred scopes remain fail-closed.
  if (rootIngest && !explicitlySelectedRootIngest) {
    return false;
  }
  for (const seg of segments) {
    if (NON_CORPUS_SEGMENTS.has(seg.toLowerCase())) {
      return false;
    }
  }

  if (options?.includeRoots && options.includeRoots.length > 0) {
    const inRoot = options.includeRoots.some((root) => {
      const normRoot = root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      return normalized === normRoot || normalized.startsWith(`${normRoot}/`);
    });
    if (!inRoot) {
      return false;
    }
  }

  if (options?.ignoreRules && options.ignoreRules.length > 0) {
    const patterns = buildProjectIgnoreGlobPatterns([...options.ignoreRules]);
    if (patterns.some((pattern) => minimatch(normalized, pattern, { dot: true }))) {
      return false;
    }
  }

  return isEligibleProjectSourcePath(normalized);
}

export interface ProjectRagPorcelainStatusOptions {
  readonly raw?: boolean;
  readonly includeRoots?: readonly string[];
  readonly ignoreRules?: readonly string[];
  /** Git-root-relative path of the registered project root. */
  readonly pathPrefix?: string;
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizePathPrefix(pathPrefix: string | undefined): string {
  return pathPrefix ? normalizeRelativePath(pathPrefix) : '';
}

function pathWithinPrefix(pathValue: string, pathPrefix: string): string | null {
  const normalizedPath = normalizeRelativePath(pathValue);
  if (!pathPrefix) return normalizedPath;
  if (normalizedPath === pathPrefix) return '';
  const prefix = `${pathPrefix}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null;
}

export function parseProjectRagPorcelainStatusZ(
  stdout: Uint8Array,
  options: ProjectRagPorcelainStatusOptions = {}
): ProjectRagStatusEntry[] {
  const text = new TextDecoder().decode(stdout);
  const fields = text.split('\0');
  const entries: ProjectRagStatusEntry[] = [];
  const pathPrefix = normalizePathPrefix(options.pathPrefix);
  for (let i = 0; i < fields.length; ) {
    const field = fields[i];
    if (field === '') {
      i += 1;
      continue;
    }
    if (field.length < 4 || field[2] !== ' ') {
      throw new Error(
        `Malformed git status porcelain entry: ${JSON.stringify(field.slice(0, 32))}`
      );
    }
    const x = field[0];
    const y = field[1];
    const path = field.slice(3);
    let origPath: string | null = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const next = i + 1 < fields.length ? fields[i + 1] : undefined;
      origPath = next && next !== '' ? next : null;
      i += 2;
    } else {
      i += 1;
    }

    const scopedPath = pathWithinPrefix(path, pathPrefix);
    const scopedOrigPath = origPath ? pathWithinPrefix(origPath, pathPrefix) : null;
    if (scopedPath === null && scopedOrigPath === null) {
      continue;
    }

    // A rename/copy that crosses the registered-root boundary must retain the
    // in-scope side as an add/delete event. Keeping the outside path would let
    // a sibling file alter the nested project's dirty identity.
    let entryPath = scopedPath;
    let entryOrigPath = scopedOrigPath;
    let entryX = x;
    let entryY = y;
    if (scopedPath === null && scopedOrigPath !== null) {
      entryPath = scopedOrigPath;
      entryOrigPath = null;
      entryX = 'D';
      entryY = ' ';
    } else if (scopedPath !== null && scopedOrigPath === null && origPath !== null) {
      entryPath = scopedPath;
      entryOrigPath = null;
      entryX = 'A';
      entryY = ' ';
    }

    if (!entryPath) {
      continue;
    }
    if (!options.raw) {
      const isPathCorpus = isCorpusPath(entryPath, options);
      const isOrigCorpus = entryOrigPath ? isCorpusPath(entryOrigPath, options) : false;
      if (!isPathCorpus && !isOrigCorpus) {
        continue;
      }
    }

    entries.push({ x: entryX, y: entryY, path: entryPath, origPath: entryOrigPath });
  }
  // Canonical order: byte-sorted by path, then origPath, then status codes.
  entries.sort((a, b) => {
    const byPath = compareUtf8Bytes(a.path, b.path);
    if (byPath !== 0) return byPath;
    const byOrig = compareUtf8Bytes(a.origPath ?? '', b.origPath ?? '');
    if (byOrig !== 0) return byOrig;
    const codeA = a.x + a.y;
    const codeB = b.x + b.y;
    return codeA < codeB ? -1 : codeA > codeB ? 1 : 0;
  });
  return entries;
}

function computeStatusDigest(entries: readonly ProjectRagStatusEntry[]): string {
  const encoded = entries.map((entry) =>
    JSON.stringify({ x: entry.x, y: entry.y, path: entry.path, origPath: entry.origPath })
  );
  return sha256Hex(encoded.join('\n'));
}

interface FileHash {
  readonly state: 'present' | 'missing' | 'ineligible';
  readonly digest: string;
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isPathInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(rootPath, absolutePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

/**
 * Resolve and fully hash one eligible worktree file.
 *
 * `lstat` prevents silently treating a symlink as its target and `realpath`
 * proves that the target (including symlinked parent directories) remains
 * inside the canonical worktree. Files over the ingestion limit are rejected
 * instead of receiving a prefix-only digest that could alias later edits.
 */
function hashEligibleFile(
  workspaceRoot: string,
  relativePath: string,
  absolutePath: string
): FileHash {
  if (!isPathInsideRoot(workspaceRoot, absolutePath)) {
    throw new Error(`Cannot fingerprint path outside the project root: ${relativePath}`);
  }

  try {
    lstatSync(absolutePath);
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') {
      return { state: 'missing', digest: '' };
    }
    throw new Error(`Unable to inspect dirty Project RAG path: ${relativePath}`);
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(absolutePath);
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') {
      return { state: 'missing', digest: '' };
    }
    throw new Error(`Unable to resolve dirty Project RAG path: ${relativePath}`);
  }

  if (!isPathInsideRoot(workspaceRoot, canonicalPath)) {
    throw new Error(`Dirty Project RAG path escapes the project root: ${relativePath}`);
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(canonicalPath);
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') {
      return { state: 'missing', digest: '' };
    }
    throw new Error(`Unable to inspect dirty Project RAG path: ${relativePath}`);
  }
  if (!stats.isFile()) {
    return { state: 'missing', digest: '' };
  }
  if (!isEligibleProjectSourcePath(relativePath, stats.size)) {
    if (stats.size > SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Cannot fingerprint eligible Project RAG path ${relativePath}: file exceeds MAX_FILE_SIZE_BYTES`
      );
    }
    return { state: 'ineligible', digest: '' };
  }

  let handle: number;
  try {
    handle = openSync(canonicalPath, 'r');
  } catch {
    throw new Error(`Unable to read dirty Project RAG path: ${relativePath}`);
  }
  try {
    const hash = createHash('sha256');
    const chunkSize = 65_536;
    const buffer = Buffer.alloc(chunkSize);
    let offset = 0;
    while (true) {
      const bytesRead = readSync(handle, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return { state: 'present', digest: hash.digest('hex') };
  } finally {
    closeSync(handle);
  }
}

/**
 * Content fingerprint over every eligible path in the registered scope.
 *
 * Each unique path contributes `<path>\0<state>` where state is either
 * `missing`, `ineligible`, or the SHA-256 of the complete file bytes.
 * Unbounded trees fail closed rather than silently aliasing an overflow marker.
 */
function computeContentFingerprint(workspaceRoot: string, paths: readonly string[]): string {
  const uniquePaths = [...new Set(paths)].sort(compareUtf8Bytes);
  if (uniquePaths.length > CONTENT_FINGERPRINT_MAX_FILES) {
    throw new Error(
      `Cannot fingerprint more than ${CONTENT_FINGERPRINT_MAX_FILES} dirty Project RAG paths`
    );
  }
  const parts: string[] = [];
  for (const relPath of uniquePaths) {
    // Defence in depth: never read outside the resolved worktree root.
    const absolutePath = resolve(workspaceRoot, relPath);
    const hashed = hashEligibleFile(workspaceRoot, relPath, absolutePath);
    parts.push(`${relPath}\0${hashed.state === 'present' ? hashed.digest : hashed.state}`);
  }
  return sha256Hex(parts.join('\n'));
}

/**
 * Stable canonical JSON hashing with recursively sorted object keys.
 *
 * Self-contained (no store/gate imports) so workspace context resolution
 * stays dependency-light; mirrors the deterministicObjectSort contract used
 * by snapshot-policy.ts.
 */
function hashCanonicalJson(value: unknown): string {
  const sortValue = (_key: string, input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map((item, index) => sortValue(String(index), item));
    }
    const record = input as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const nestedKey of Object.keys(record).sort()) {
      sorted[nestedKey] = sortValue(nestedKey, record[nestedKey]);
    }
    return sorted;
  };
  return sha256Hex(JSON.stringify(value, sortValue));
}

/**
 * Resolve immutable-enough Git context for one worktree.  No slug, basename,
 * environment fallback, or remote is used as an identity substitute.
 *
 * Handles detached HEAD, unborn branches, and linked worktrees:
 *  - detached: `headOid` set, `branchName`/`isUnborn` null/false
 *  - unborn:   `branchName` set, `headOid` null, `isUnborn` true
 *  - worktrees: `worktreeGitDir` distinguishes each worktree while
 *    `repositoryCommonDir` stays shared across all of them
 */
export interface ProjectRagWorkspaceContextOptions {
  readonly includeRoots?: readonly string[];
  readonly ignoreRules?: readonly string[];
  readonly rawStatus?: boolean;
}

export async function resolveProjectRagWorkspaceContext(
  rootPath: string,
  runner: ProjectRagGitRunner = runGitCommand,
  options: ProjectRagWorkspaceContextOptions = {}
): Promise<ResolvedProjectRagWorkspaceContext> {
  const requestedRoot = realpathSync.native(resolve(rootPath));
  const gitRoot = requireGitOutput(
    await runner(requestedRoot, ['rev-parse', '--show-toplevel']),
    'Git worktree root'
  );
  const canonicalWorkspaceRoot = realpathSync.native(gitRoot);
  if (!isPathInsideRoot(canonicalWorkspaceRoot, requestedRoot)) {
    throw new Error('Registered Project RAG root must be inside the Git worktree root');
  }
  const scopePath = relative(canonicalWorkspaceRoot, requestedRoot).replace(/\\/g, '/');
  const commonDirRaw = requireGitOutput(
    await runner(canonicalWorkspaceRoot, ['rev-parse', '--git-common-dir']),
    'Git common directory'
  );
  const repositoryCommonDir = realpathSync.native(resolve(canonicalWorkspaceRoot, commonDirRaw));
  const gitDirRaw = requireGitOutput(
    await runner(canonicalWorkspaceRoot, ['rev-parse', '--git-dir']),
    'Git worktree directory'
  );
  const worktreeGitDir = realpathSync.native(resolve(canonicalWorkspaceRoot, gitDirRaw));
  const headOid = await optionalGitOutput(runner, canonicalWorkspaceRoot, [
    'rev-parse',
    '--verify',
    'HEAD',
  ]);
  const branchName = await optionalGitOutput(runner, canonicalWorkspaceRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const status = await runner(canonicalWorkspaceRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (status.exitCode !== 0) {
    throw new Error('Unable to determine Git workspace dirty state');
  }

  const statusEntries = parseProjectRagPorcelainStatusZ(status.stdout, {
    raw: options.rawStatus,
    includeRoots: options.includeRoots,
    ignoreRules: options.ignoreRules,
    pathPrefix: scopePath,
  });
  const statusDigest = computeStatusDigest(statusEntries);
  const dirtyContentFingerprint = computeContentFingerprint(
    requestedRoot,
    statusEntries.map((entry) => entry.path)
  );
  const trackedPaths = await listProjectRagWorkspaceTrackedFiles(canonicalWorkspaceRoot, runner, {
    pathPrefix: scopePath,
    includeRoots: options.includeRoots,
    ignoreRules: options.ignoreRules,
    raw: options.rawStatus,
  });
  const contentFingerprint = computeContentFingerprint(requestedRoot, [
    ...trackedPaths,
    ...statusEntries.map((entry) => entry.path),
  ]);
  const dirtyDigest = sha256Hex(`${statusDigest}\n${dirtyContentFingerprint}`);

  const isDetached = headOid !== null && branchName === null;
  const isUnborn = headOid === null && branchName !== null;
  const remoteUrl = await optionalGitOutput(runner, canonicalWorkspaceRoot, [
    'remote',
    'get-url',
    'origin',
  ]);

  // Machine-independent worktree marker: position of this worktree's git dir
  // relative to the shared common directory (e.g. `.git` vs
  // `worktrees/<id>`), never an absolute host path.
  const worktreeMarkerRaw = relative(repositoryCommonDir, worktreeGitDir);
  const worktreeMarker = worktreeMarkerRaw === '' ? '.' : worktreeMarkerRaw.replace(/\\/g, '/');

  const repositoryHash = hashCanonicalJson({
    family: 'project-rag.repository',
    version: 2,
    gitCommonDir: repositoryCommonDir,
  });
  const workspaceHash = hashCanonicalJson({
    family: 'project-rag.workspace',
    version: 2,
    repositoryHash,
    scopePath,
    worktreeMarker,
  });
  const identityDigest = hashCanonicalJson({
    family: 'project-rag.scoped-corpus',
    version: 2,
    workspaceHash,
    scopePath,
    includeRoots: [...(options.includeRoots ?? [])]
      .map((value) => normalizeRelativePath(value))
      .sort(compareUtf8Bytes),
    ignoreRules: [...(options.ignoreRules ?? [])]
      .map((value) => value.replace(/\\/g, '/').trim())
      .sort(compareUtf8Bytes),
    contentFingerprint,
    dirtyDigest,
  });
  const headHash = hashCanonicalJson({
    family: 'project-rag.head',
    version: 1,
    headOid,
    isUnborn,
  });
  const branchHash = hashCanonicalJson({
    family: 'project-rag.branch',
    version: 1,
    branchName,
    isDetached,
  });
  const detachedHash = hashCanonicalJson({
    family: 'project-rag.detached',
    version: 1,
    isDetached,
  });

  return {
    repositoryCommonDir,
    worktreeGitDir,
    repositoryHash,
    workspaceHash,
    remoteUrl,
    scopePath,
    workspaceRoot: requestedRoot,
    headOid,
    headHash,
    branchName,
    branchHash,
    isDetached,
    detachedHash,
    isUnborn,
    statusDigest,
    contentFingerprint,
    contentHash: contentFingerprint,
    dirtyDigest,
    identityDigest,
  };
}

/** List tracked paths exactly as Git sees them, including root-level files. */
export async function listProjectRagWorkspaceTrackedFiles(
  rootPath: string,
  runner: ProjectRagGitRunner = runGitCommand,
  options: ProjectRagPorcelainStatusOptions = {}
): Promise<string[]> {
  const workspaceRoot = realpathSync.native(resolve(rootPath));
  const result = await runner(workspaceRoot, ['ls-files', '-z']);
  if (result.exitCode !== 0) {
    throw new Error('Unable to list Git-tracked workspace files');
  }
  const pathPrefix = normalizePathPrefix(options.pathPrefix);
  return new TextDecoder()
    .decode(result.stdout)
    .split('\0')
    .filter(Boolean)
    .map((pathValue) => pathWithinPrefix(pathValue, pathPrefix))
    .filter((pathValue): pathValue is string => pathValue !== null)
    .filter((pathValue) =>
      options.raw
        ? true
        : isCorpusPath(pathValue, {
            includeRoots: options.includeRoots,
            ignoreRules: options.ignoreRules,
          })
    );
}
