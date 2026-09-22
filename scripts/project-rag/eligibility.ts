/**
 * Canonical Project RAG file eligibility and language detection.
 *
 * Centralizes source extensions, trusted launcher scripts, and eligibility policy
 * across inventory, manifest, ingest, and verification.
 */
import { SCRIPT_CONFIG } from '../lib/config.js';

export const PROJECT_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.md',
  '.mdx',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.css',
  '.scss',
  '.html',
  '.sql',
  '.sh',
  '.txt',
]);

/**
 * Trusted extensionless launcher scripts under includeRoots.
 */
export const TRUSTED_EXTENSIONLESS_LAUNCHERS: ReadonlySet<string> = new Set([
  'bin/ragctl',
  'bin/rag-mcp',
]);

/** Backward-compatibility alias for inventory and manifest callers. */
export const SOURCE_EXTENSIONS = PROJECT_SOURCE_EXTENSIONS;

export function normalizeSourcePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function extensionOf(pathValue: string): string {
  const index = pathValue.lastIndexOf('.');
  return index >= 0 ? pathValue.slice(index).toLowerCase() : '';
}

function isTrustedExtensionlessLauncher(pathValue: string): boolean {
  // The allowlist is for repository-relative paths only.  Extension-based
  // admission may receive absolute paths from ingestion, but an absolute path
  // must never become a trusted launcher merely because normalization strips
  // its leading separator.
  if (pathValue.startsWith('/') || pathValue.startsWith('\\')) return false;
  return TRUSTED_EXTENSIONLESS_LAUNCHERS.has(normalizeSourcePath(pathValue));
}

export function isEligibleProjectSourcePath(pathValue: string, sizeBytes?: number): boolean {
  if (
    sizeBytes !== undefined &&
    (sizeBytes <= 0 || sizeBytes > SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES)
  ) {
    return false;
  }
  const normalized = normalizeSourcePath(pathValue);
  const ext = extensionOf(normalized);
  if (PROJECT_SOURCE_EXTENSIONS.has(ext)) {
    return true;
  }
  if (ext === '') {
    if (isTrustedExtensionlessLauncher(pathValue)) {
      return true;
    }
  }
  return false;
}

export function detectLanguage(pathValue: string): string | undefined {
  const normalized = normalizeSourcePath(pathValue);
  const ext = extensionOf(normalized);
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.java') return 'java';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.json') return 'json';
  if (ext === '.sql') return 'sql';
  if (ext === '.sh') return 'shell';
  if (ext === '.txt') return 'text';
  if (ext === '' && isTrustedExtensionlessLauncher(pathValue)) {
    return 'shell';
  }
  return undefined;
}

export function classifyProjectFilePolicy(
  pathValue: string,
  sizeBytes?: number
): { eligible: boolean; reason?: string } {
  if (sizeBytes !== undefined && sizeBytes <= 0) {
    return { eligible: false, reason: 'empty_file' };
  }
  if (sizeBytes !== undefined && sizeBytes > SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES) {
    return { eligible: false, reason: 'size_exceeded' };
  }
  const normalized = normalizeSourcePath(pathValue);
  const ext = extensionOf(normalized);
  if (PROJECT_SOURCE_EXTENSIONS.has(ext)) {
    return { eligible: true };
  }
  if (ext === '' && isTrustedExtensionlessLauncher(pathValue)) {
    return { eligible: true };
  }
  return { eligible: false, reason: 'policy_excluded_extension' };
}
