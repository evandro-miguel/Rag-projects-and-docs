import type { DocsSourceAuthority, DocsSourceKind } from '../lib/docs-source-registry.js';

export type DocsVaultAcquisitionType = 'git' | 'llms' | 'archive' | 'local_generator' | 'crawl';

export type DocsVaultRefreshMode = 'incremental' | 'full' | 'manual';

export type DocsVaultDefaultIngestMode = 'canonical_only' | 'canonical_and_wiki';

export type DocsVaultProjectionKind = 'canonical' | 'wiki';

export type DocsVaultProjection = {
  kind: DocsVaultProjectionKind;
  relativeRoot: string;
  writer: 'canonical_verbatim' | 'wiki_generated';
};

export type DocsVaultSnapshotMetadata = {
  hashAlgorithm: 'sha256';
  configHash: string;
  contentHash?: string;
  sourceRevision?: string;
  retrievedAt?: string;
  versionToken?: string;
};

export type DocsVaultSourceConfigBase = {
  sourceId: string;
  title?: string;
  category: string;
  version?: string;
  refreshMode?: DocsVaultRefreshMode;
  defaultIngestMode?: DocsVaultDefaultIngestMode;
  contentHash?: string;
  sourceRevision?: string;
  retrievedAt?: string;
};

export type DocsVaultAcquisitionBase = {
  type: DocsVaultAcquisitionType;
  includePaths: readonly string[];
};

export type DocsVaultGitSourceConfig = DocsVaultSourceConfigBase & {
  type: 'git';
  url: string;
  branch: string;
  includePaths: readonly string[];
  fileExtensions: readonly string[];
  ignorePaths: readonly string[];
};

export type DocsVaultLlmsSourceConfig = DocsVaultSourceConfigBase & {
  type: 'llms';
  url: string;
  includePaths: readonly string[];
};

export type DocsVaultArchiveSourceConfig = DocsVaultSourceConfigBase & {
  type: 'archive';
  url: string;
  format?: string;
  includePaths: readonly string[];
};

export type DocsVaultLocalGeneratorSourceConfig = DocsVaultSourceConfigBase & {
  type: 'local_generator';
  generator: string;
  includePaths: readonly string[];
};

export type DocsVaultCrawlSourceConfig = DocsVaultSourceConfigBase & {
  type: 'crawl';
  startUrls: readonly string[];
  includePaths: readonly string[];
};

export type DocsVaultSourceConfig =
  | DocsVaultGitSourceConfig
  | DocsVaultLlmsSourceConfig
  | DocsVaultArchiveSourceConfig
  | DocsVaultLocalGeneratorSourceConfig
  | DocsVaultCrawlSourceConfig;

export type DocsVaultGitAcquisition = DocsVaultAcquisitionBase & {
  type: 'git';
  url: string;
  branch: string;
  allowedDomains: readonly string[];
  allowedRepos: readonly string[];
  fileExtensions: readonly string[];
  ignorePaths: readonly string[];
};

export type DocsVaultLlmsAcquisition = DocsVaultAcquisitionBase & {
  type: 'llms';
  url: string;
  allowedDomains: readonly string[];
  allowedRepos: readonly string[];
};

export type DocsVaultArchiveAcquisition = DocsVaultAcquisitionBase & {
  type: 'archive';
  url: string;
  format?: string;
  allowedDomains: readonly string[];
  allowedRepos: readonly string[];
};

export type DocsVaultLocalGeneratorAcquisition = DocsVaultAcquisitionBase & {
  type: 'local_generator';
  generator: string;
  allowedDomains: readonly [];
  allowedRepos: readonly [];
};

export type DocsVaultCrawlAcquisition = DocsVaultAcquisitionBase & {
  type: 'crawl';
  startUrls: readonly string[];
  allowedDomains: readonly string[];
  allowedRepos: readonly [];
};

export type DocsVaultAcquisition =
  | DocsVaultGitAcquisition
  | DocsVaultLlmsAcquisition
  | DocsVaultArchiveAcquisition
  | DocsVaultLocalGeneratorAcquisition
  | DocsVaultCrawlAcquisition;

export type DocsVaultSourceManifest = {
  sourceId: string;
  title?: string;
  category: string;
  language?: string;
  kind: DocsSourceKind;
  authority: DocsSourceAuthority;
  trustLevel: DocsSourceAuthority;
  tags: readonly string[];
  lang?: string;
  ecosystem?: string;
  lib?: string;
  version?: string;
  refreshMode: DocsVaultRefreshMode;
  defaultIngestMode: DocsVaultDefaultIngestMode;
  acquisition: DocsVaultAcquisition;
  projections: {
    canonical: DocsVaultProjection;
    wiki: DocsVaultProjection;
  };
  snapshot: DocsVaultSnapshotMetadata;
};

export type DocsVaultManifest = {
  manifestVersion: 'docs-vault-manifest/v1';
  sources: readonly DocsVaultSourceManifest[];
};
