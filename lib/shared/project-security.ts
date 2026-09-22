/**
 * @module security
 * @description Project RAG ingestion security module for file blocking and content redaction.
 *
 * This module provides comprehensive security scanning for project ingestion:
 * - Filename-based blocking for sensitive files (.env, .pem, credentials, etc.)
 * - Content-based credential redaction before chunking and embedding
 * - Path traversal and sensitive directory detection
 *
 * @example
 * import { checkFileSecurity, getSensitivePatterns, getContentSecretPatterns } from './security.js';
 *
 * // Check if a file should be blocked
 * const result = checkFileSecurity('.env', 'SECRET=123', '/project');
 * if (result.blocked) {
 *   console.log(`Blocked: ${result.reason} - ${result.pattern}`);
 * }
 */

/**
 * Filename patterns that indicate potentially sensitive files.
 * These are matched case-insensitively against filenames and paths.
 */
const FILENAME_SENSITIVE_PATTERNS: Array<{ id: string; regex: RegExp; description: string }> = [
  // Environment files
  { id: 'dot-env', regex: /\.env(\.[\w.-]+)?$/, description: 'Environment configuration files' },

  // Certificate and key files
  { id: 'pem-file', regex: /\.pem$/i, description: 'PEM certificate files' },
  { id: 'key-file', regex: /\.key$/i, description: 'Private key files' },
  { id: 'crt-file', regex: /\.crt$/i, description: 'Certificate files' },
  { id: 'p12-file', regex: /\.p12$/i, description: 'PKCS#12 certificate files' },
  { id: 'pfx-file', regex: /\.pfx$/i, description: 'PFX certificate files' },

  // Credential files
  { id: 'credentials-json', regex: /\.credentials\.json$/i, description: 'Credential JSON files' },
  { id: 'secret-file', regex: /\.secret$/i, description: 'Secret files' },
  { id: 'password-file', regex: /\.password$/i, description: 'Password files' },

  // Cloud configuration files
  { id: 'aws-credentials', regex: /\.aws[/]credentials$/i, description: 'AWS credentials file' },
  { id: 'kubeconfig', regex: /kubeconfig$/i, description: 'Kubernetes configuration' },

  // SSH keys
  { id: 'ssh-id-rsa', regex: /id_rsa$/i, description: 'RSA SSH private key' },
  { id: 'ssh-id-dsa', regex: /id_dsa$/i, description: 'DSA SSH private key' },
  { id: 'ssh-id-ecdsa', regex: /id_ecdsa$/i, description: 'ECDSA SSH private key' },
  { id: 'ssh-id-ed25519', regex: /id_ed25519$/i, description: 'Ed25519 SSH private key' },

  // Case-insensitive filename matches
  { id: 'secret-in-name', regex: /secret/i, description: 'Files with "secret" in name' },
  { id: 'password-in-name', regex: /password/i, description: 'Files with "password" in name' },
  {
    id: 'credential-in-name',
    regex: /credential/i,
    description: 'Files with "credential" in name',
  },
  {
    id: 'private-key-in-name',
    regex: /private[_-]?key/i,
    description: 'Files with "private_key" in name',
  },
  {
    id: 'access-token-in-name',
    regex: /access[_-]?token/i,
    description: 'Files with "access_token" in name',
  },
  { id: 'api-key-in-name', regex: /api[_-]?key/i, description: 'Files with "api_key" in name' },
];

/**
 * Path patterns that indicate sensitive directories.
 * These block files within certain directories.
 */
const PATH_SENSITIVE_PATTERNS: Array<{ id: string; regex: RegExp; description: string }> = [
  { id: 'aws-dir', regex: /[/]\.aws[/]/i, description: 'AWS configuration directory' },
  { id: 'ssh-dir', regex: /[/]\.ssh[/]/i, description: 'SSH configuration directory' },
  { id: 'gnupg-dir', regex: /[/]\.gnupg[/]/i, description: 'GnuPG configuration directory' },
  { id: 'docker-dir', regex: /[/]\.docker[/]/i, description: 'Docker configuration directory' },
  { id: 'kube-dir', regex: /[/]\.kube[/]/i, description: 'Kubernetes configuration directory' },
];

/**
 * Content-based secret detection patterns.
 * These regexes scan file contents for hardcoded secrets.
 */
const CONTENT_SECRET_PATTERNS: Array<{
  id: string;
  regex: RegExp;
  description: string;
  severity: 'critical' | 'high' | 'medium';
}> = [
  {
    id: 'github-pat',
    regex: /(ghp_[a-zA-Z0-9]{36})/g,
    description: 'GitHub Personal Access Token',
    severity: 'critical',
  },
  {
    id: 'github-oauth',
    regex: /(gho_[a-zA-Z0-9]{36})/g,
    description: 'GitHub OAuth Token',
    severity: 'critical',
  },
  {
    id: 'github-app-token',
    regex: /(ghs_[a-zA-Z0-9]{36})/g,
    description: 'GitHub App Token',
    severity: 'critical',
  },
  {
    id: 'github-refresh-token',
    regex: /(ghr_[a-zA-Z0-9]{36})/g,
    description: 'GitHub Refresh Token',
    severity: 'critical',
  },
  {
    id: 'private-key',
    regex: /(-----BEGIN ((?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \2-----)/g,
    description: 'Private key (RSA/EC/DSA/OpenSSH)',
    severity: 'critical',
  },
  {
    id: 'slack-bot-token',
    regex: /(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9]*)/g,
    description: 'Slack Bot Token',
    severity: 'critical',
  },
  {
    id: 'slack-user-token',
    regex: /(xoxp-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9]*)/g,
    description: 'Slack User Token',
    severity: 'critical',
  },
  {
    id: 'stripe-secret',
    regex: /(sk_live_[0-9a-zA-Z]{24,})/g,
    description: 'Stripe Live Secret Key',
    severity: 'critical',
  },
  {
    id: 'stripe-restricted',
    regex: /(rk_live_[0-9a-zA-Z]{24,})/g,
    description: 'Stripe Live Restricted Key',
    severity: 'critical',
  },
  {
    id: 'openai-api-key',
    regex: /(sk-[a-zA-Z0-9_-]{10,})/g,
    description: 'OpenAI-style API key (sk-/sk-proj-/sk-test-)',
    severity: 'critical',
  },
  {
    id: 'generic-api-key',
    regex: /(?:api[_-]?key|api[_-]?secret)[\s"'=:]*["']?([a-zA-Z0-9_-]{16,})["']?/gi,
    description: 'Generic API key pattern',
    severity: 'high',
  },
  {
    id: 'database-url-password',
    regex: /(?:postgresql|mysql|mongodb|redis):\/\/[^:\s]+:([^@\s]+)@[^\s]+/gi,
    description: 'Database URL with embedded password',
    severity: 'high',
  },
  {
    id: 'jwt-token',
    regex: /(eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*)/g,
    description: 'JWT Token',
    severity: 'high',
  },
  {
    id: 'bearer-token',
    regex:
      /bearer\s+((?=[a-zA-Z0-9_\-.~+/=]*[0-9_\-.~+/=])[a-zA-Z0-9_\-.~+/=]{1,}|[a-zA-Z0-9_\-.~+/=]{12,})/gi,
    description: 'Bearer token in Authorization header',
    severity: 'medium',
  },
  {
    id: 'basic-auth',
    regex: /basic\s+([a-zA-Z0-9+/=]{4,})/gi,
    description: 'Basic authentication header',
    severity: 'high',
  },
  {
    id: 'auth-token',
    regex: /(?:auth[_-]?token|access[_-]?token)[\s"'=:]*["']?([a-zA-Z0-9_-]{16,})["']?/gi,
    description: 'Authentication token',
    severity: 'high',
  },
  {
    id: 'password-in-code',
    regex: /(?:password|passwd|pwd)[\s"'=:]*["']([^"'\s]{8,})["']/gi,
    description: 'Hardcoded password',
    severity: 'high',
  },
  {
    id: 'secret-in-code',
    regex: /(?:secret[_-]?key|app[_-]?secret)[\s"'=:]*["']?([a-zA-Z0-9_-]{16,})["']?/gi,
    description: 'Application secret key',
    severity: 'high',
  },
];

export interface SensitiveContentRedaction {
  readonly content: string;
  readonly count: number;
  readonly patternIds: readonly string[];
}

function redactSecretMatch(match: string, secret: string, patternId: string): string {
  const replacement = `[REDACTED:${patternId}]`;
  const lineBreaks = secret.match(/\r\n|\r|\n/gu)?.join('') ?? '';
  return match.replace(secret, `${replacement}${lineBreaks}`);
}

/** Redact credential-like spans while preserving the rest of an indexable file. */
export function redactSensitiveContent(content: string): SensitiveContentRedaction {
  let redactedContent = content;
  let count = 0;
  const patternIds = new Set<string>();

  for (const pattern of CONTENT_SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    redactedContent = redactedContent.replace(pattern.regex, (match, secret: string) => {
      count += 1;
      patternIds.add(pattern.id);
      return redactSecretMatch(match, secret, pattern.id);
    });
  }

  return { content: redactedContent, count, patternIds: [...patternIds] };
}

/**
 * Result type for file security check.
 */
export type SecurityCheckResult =
  | {
      blocked: true;
      reason: 'filename' | 'content' | 'path';
      pattern?: string;
      filePath: string;
      details?: string;
    }
  | {
      blocked: false;
      filePath: string;
    };

/**
 * Check if a file should be blocked from ingestion based on security rules.
 *
 * Performs three levels of checks:
 * 1. Path-based: Checks if file is in a sensitive directory (.aws/, .ssh/, etc.)
 * 2. Filename-based: Checks if filename matches sensitive patterns (.env, .pem, secret, etc.)
 * 3. Content-based: Scans file content for hardcoded secrets (if content provided)
 *
 * @param filePath - The full or relative path to the file
 * @param content - Optional file content to scan for secrets
 * @param projectRoot - The project root path for normalization
 * @returns SecurityCheckResult indicating if file is blocked and why
 *
 * @example
 * // Block sensitive filename
 * const result = checkFileSecurity('.env.local', undefined, '/project');
 * // { blocked: true, reason: 'filename', pattern: 'dot-env', filePath: '.env.local' }
 *
 * @example
 * // Block based on content
 * const content = 'AWS_ACCESS_KEY_ID=[redacted-example-key]';
 * const result = checkFileSecurity('config.txt', content, '/project');
 * // { blocked: true, reason: 'content', pattern: 'aws-access-key', ... }
 *
 * @example
 * // Allow safe file
 * const result = checkFileSecurity('src/main.ts', 'console.log("hello")', '/project');
 * // { blocked: false, filePath: 'src/main.ts' }
 */
export function checkFileSecurity(
  filePath: string,
  content: string | undefined,
  _projectRoot: string
): SecurityCheckResult {
  // Normalize the file path for consistent matching
  const normalizedPath = filePath.replace(/\\/g, '/');

  // 1. Check path-based patterns (sensitive directories)
  for (const pattern of PATH_SENSITIVE_PATTERNS) {
    if (pattern.regex.test(normalizedPath)) {
      return {
        blocked: true,
        reason: 'path',
        pattern: pattern.id,
        filePath,
        details: pattern.description,
      };
    }
  }

  // Extract filename from path
  const fileName = normalizedPath.split('/').pop() || normalizedPath;

  // 2. Check filename-based patterns
  for (const pattern of FILENAME_SENSITIVE_PATTERNS) {
    if (pattern.regex.test(fileName)) {
      return {
        blocked: true,
        reason: 'filename',
        pattern: pattern.id,
        filePath,
        details: pattern.description,
      };
    }
  }

  // 3. Check content-based patterns (only if content is provided)
  if (content !== undefined && content.length > 0) {
    for (const pattern of CONTENT_SECRET_PATTERNS) {
      // Reset regex lastIndex to ensure proper matching
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(content)) {
        return {
          blocked: true,
          reason: 'content',
          pattern: pattern.id,
          filePath,
          details: pattern.description,
        };
      }
    }
  }

  // File passed all security checks
  return {
    blocked: false,
    filePath,
  };
}

/**
 * Get all sensitive filename patterns for external use.
 *
 * Returns an array of RegExp patterns used to detect sensitive filenames.
 * These patterns are case-insensitive by default.
 *
 * @returns Array of RegExp patterns for filename-based detection
 *
 * @example
 * const patterns = getSensitivePatterns();
 * const isSensitive = patterns.some(rx => rx.test('config.pem'));
 */
export function getSensitivePatterns(): RegExp[] {
  // Combine filename and path patterns
  return [
    ...FILENAME_SENSITIVE_PATTERNS.map((p) => p.regex),
    ...PATH_SENSITIVE_PATTERNS.map((p) => p.regex),
  ];
}

/**
 * Get content-based secret detection patterns.
 *
 * Returns detailed pattern definitions for scanning file contents
 * for hardcoded secrets, API keys, tokens, and credentials.
 *
 * @returns Array of pattern objects with id, regex, description, and severity
 *
 * @example
 * const patterns = getContentSecretPatterns();
 * for (const pattern of patterns) {
 *   if (pattern.regex.test(fileContent)) {
 *     console.log(`Found ${pattern.description} (${pattern.severity})`);
 *   }
 * }
 */
export function getContentSecretPatterns(): Array<{
  id: string;
  regex: RegExp;
  description: string;
  severity: 'critical' | 'high' | 'medium';
}> {
  return CONTENT_SECRET_PATTERNS.map((p) => ({
    id: p.id,
    regex: new RegExp(p.regex.source, p.regex.flags),
    description: p.description,
    severity: p.severity,
  }));
}

/**
 * Get filename-based sensitive patterns with metadata.
 *
 * Returns detailed pattern definitions for filename-based detection.
 *
 * @returns Array of pattern objects with id, regex, and description
 */
export function getFilenameSensitivePatterns(): Array<{
  id: string;
  regex: RegExp;
  description: string;
}> {
  return FILENAME_SENSITIVE_PATTERNS.map((p) => ({
    id: p.id,
    regex: new RegExp(p.regex.source, p.regex.flags),
    description: p.description,
  }));
}

/**
 * Get path-based sensitive patterns with metadata.
 *
 * Returns detailed pattern definitions for detecting sensitive directories.
 *
 * @returns Array of pattern objects with id, regex, and description
 */
export function getPathSensitivePatterns(): Array<{
  id: string;
  regex: RegExp;
  description: string;
}> {
  return PATH_SENSITIVE_PATTERNS.map((p) => ({
    id: p.id,
    regex: new RegExp(p.regex.source, p.regex.flags),
    description: p.description,
  }));
}

/**
 * Check if content contains any secrets without file path context.
 *
 * Useful for scanning text content where file path is not available.
 *
 * @param content - The content to scan
 * @returns Array of detected secrets with pattern id and description
 */
export function scanContentForSecrets(
  content: string
): Array<{ pattern: string; description: string; severity: 'critical' | 'high' | 'medium' }> {
  const detected: Array<{
    pattern: string;
    description: string;
    severity: 'critical' | 'high' | 'medium';
  }> = [];

  for (const pattern of CONTENT_SECRET_PATTERNS) {
    // Reset regex lastIndex
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(content)) {
      detected.push({
        pattern: pattern.id,
        description: pattern.description,
        severity: pattern.severity,
      });
    }
  }

  return detected;
}

// Export pattern definitions for testing and extension
export { CONTENT_SECRET_PATTERNS, FILENAME_SENSITIVE_PATTERNS, PATH_SENSITIVE_PATTERNS };
