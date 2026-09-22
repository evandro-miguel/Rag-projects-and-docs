import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DocsVaultArchiveSourceConfig,
  DocsVaultCrawlSourceConfig,
  DocsVaultDefaultIngestMode,
  DocsVaultGitSourceConfig,
  DocsVaultLlmsSourceConfig,
  DocsVaultLocalGeneratorSourceConfig,
  DocsVaultRefreshMode,
  DocsVaultSourceConfig,
} from './types.js';

const DEFAULT_SOURCE_FILE_EXTENSIONS = ['md', 'mdx'] as const;
const DEFAULT_REFRESH_MODE: DocsVaultRefreshMode = 'incremental';
const DEFAULT_INGEST_MODE: DocsVaultDefaultIngestMode = 'canonical_and_wiki';

type JsonRecord = Record<string, unknown>;

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeIdentifier(value: unknown, fieldName: string): string {
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) {
    throw new Error(`Docs Vault source is missing ${fieldName}`);
  }
  return normalized;
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//u, '');
  return normalized.length > 0 ? normalized.replace(/\/$/u, '') : '.';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries = value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => entry !== undefined);

  return Array.from(new Set(entries));
}

function normalizePathArray(value: unknown, fallback?: string): string[] {
  const normalized = normalizeStringArray(value).map(normalizePath);
  if (normalized.length > 0) {
    return normalized;
  }

  return fallback ? [normalizePath(fallback)] : ['.'];
}

function validateUrl(
  value: string,
  sourceId: string,
  sourceType: string,
  fieldName: string
): string {
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || !parsed.hostname) {
      throw new Error('missing hostname');
    }
    return value;
  } catch {
    throw new Error(
      `Docs Vault ${sourceType} source '${sourceId}' has invalid ${fieldName}: ${value}`
    );
  }
}

export function normalizeDocsVaultSourceFileExtensions(value: unknown): string[] {
  const rawExtensions = Array.isArray(value) ? value : DEFAULT_SOURCE_FILE_EXTENSIONS;
  const extensions = rawExtensions
    .map((extension) => String(extension).trim().toLowerCase().replace(/^\./u, ''))
    .filter((extension) => /^[a-z0-9]+$/u.test(extension));

  return extensions.length > 0
    ? Array.from(new Set(extensions))
    : [...DEFAULT_SOURCE_FILE_EXTENSIONS];
}

function normalizeRefreshMode(value: unknown): DocsVaultRefreshMode {
  return value === 'full' || value === 'manual' || value === 'incremental'
    ? value
    : DEFAULT_REFRESH_MODE;
}

function normalizeDefaultIngestMode(value: unknown): DocsVaultDefaultIngestMode {
  return value === 'canonical_only' || value === 'canonical_and_wiki' ? value : DEFAULT_INGEST_MODE;
}

function normalizeCommonFields(record: JsonRecord) {
  const sourceId = normalizeIdentifier(record.id ?? record.name, 'id');
  const category = normalizeIdentifier(record.category, 'category');

  return {
    sourceId,
    title: normalizeString(record.title),
    category,
    version: normalizeString(record.version),
    refreshMode: normalizeRefreshMode(record.refreshMode),
    defaultIngestMode: normalizeDefaultIngestMode(record.defaultIngestMode),
    contentHash: normalizeString(record.contentHash),
    sourceRevision: normalizeString(record.sourceRevision),
    retrievedAt: normalizeString(record.retrievedAt),
  };
}

function normalizeGitConfig(record: JsonRecord): DocsVaultGitSourceConfig {
  const common = normalizeCommonFields(record);
  const docsPath = normalizeString(record.docsPath ?? record.path) ?? '.';
  const branch = normalizeString(record.branch) ?? 'main';
  const url = normalizeString(record.url);

  if (!url) {
    throw new Error(`Docs Vault git source '${common.sourceId}' is missing url`);
  }

  return {
    ...common,
    type: 'git',
    url: validateUrl(url, common.sourceId, 'git', 'url'),
    branch,
    version: common.version ?? branch,
    includePaths: normalizePathArray(record.includePaths, docsPath),
    fileExtensions: normalizeDocsVaultSourceFileExtensions(record.fileExtensions),
    ignorePaths: normalizeStringArray(record.ignorePaths).map(normalizePath),
  };
}

function normalizeLlmsConfig(record: JsonRecord): DocsVaultLlmsSourceConfig {
  const common = normalizeCommonFields(record);
  const url = normalizeString(record.url);
  if (!url) {
    throw new Error(`Docs Vault llms source '${common.sourceId}' is missing url`);
  }

  return {
    ...common,
    type: 'llms',
    url: validateUrl(url, common.sourceId, 'llms', 'url'),
    includePaths: normalizePathArray(
      record.includePaths,
      normalizeString(record.docsPath ?? record.path)
    ),
  };
}

function normalizeArchiveConfig(record: JsonRecord): DocsVaultArchiveSourceConfig {
  const common = normalizeCommonFields(record);
  const url = normalizeString(record.url);
  if (!url) {
    throw new Error(`Docs Vault archive source '${common.sourceId}' is missing url`);
  }

  return {
    ...common,
    type: 'archive',
    url: validateUrl(url, common.sourceId, 'archive', 'url'),
    format: normalizeString(record.format ?? record.archiveFormat),
    includePaths: normalizePathArray(
      record.includePaths,
      normalizeString(record.docsPath ?? record.path)
    ),
  };
}

function normalizeLocalGeneratorConfig(record: JsonRecord): DocsVaultLocalGeneratorSourceConfig {
  const common = normalizeCommonFields(record);
  const generator = normalizeString(record.generator);
  if (!generator) {
    throw new Error(`Docs Vault local_generator source '${common.sourceId}' is missing generator`);
  }

  return {
    ...common,
    type: 'local_generator',
    generator,
    includePaths: normalizePathArray(
      record.includePaths,
      normalizeString(record.docsPath ?? record.path)
    ),
  };
}

function normalizeCrawlConfig(record: JsonRecord): DocsVaultCrawlSourceConfig {
  const common = normalizeCommonFields(record);
  const startUrls = normalizeStringArray(record.startUrls);
  const singleUrl = normalizeString(record.url);
  const urls = startUrls.length > 0 ? startUrls : singleUrl ? [singleUrl] : [];

  if (urls.length === 0) {
    throw new Error(`Docs Vault crawl source '${common.sourceId}' is missing startUrls`);
  }

  const invalidUrl = urls.find((url) => {
    try {
      const parsed = new URL(url);
      return !parsed.protocol || !parsed.hostname;
    } catch {
      return true;
    }
  });

  if (invalidUrl) {
    throw new Error(
      `Docs Vault crawl source '${common.sourceId}' has invalid startUrls: ${invalidUrl}`
    );
  }

  return {
    ...common,
    type: 'crawl',
    startUrls: urls,
    includePaths: normalizePathArray(
      record.includePaths,
      normalizeString(record.docsPath ?? record.path)
    ),
  };
}

export function normalizeDocsVaultSourceConfig(record: JsonRecord): DocsVaultSourceConfig {
  const acquisitionType =
    normalizeString(record.type)?.toLowerCase() ?? ('git' satisfies DocsVaultSourceConfig['type']);

  switch (acquisitionType) {
    case 'git':
      return normalizeGitConfig(record);
    case 'llms':
      return normalizeLlmsConfig(record);
    case 'archive':
      return normalizeArchiveConfig(record);
    case 'local_generator':
      return normalizeLocalGeneratorConfig(record);
    case 'crawl':
      return normalizeCrawlConfig(record);
    default:
      throw new Error(`Unsupported Docs Vault acquisition type: ${acquisitionType}`);
  }
}

export function loadDocsVaultSourceConfigs(options?: {
  cwd?: string;
  configPath?: string;
}): DocsVaultSourceConfig[] {
  const cwd = options?.cwd ?? process.cwd();
  const configPath = options?.configPath ?? join(cwd, 'scripts', 'sources.json');
  const rawConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as
    | {
        sources?: JsonRecord[];
      }
    | JsonRecord[];

  const rawSources = Array.isArray(rawConfig) ? rawConfig : (rawConfig.sources ?? []);
  return rawSources.map(normalizeDocsVaultSourceConfig);
}
