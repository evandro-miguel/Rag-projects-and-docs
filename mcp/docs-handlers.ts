import { fileURLToPath } from 'node:url';
import type { DocsVaultSearchMetadata } from '../lib/docs-vault-types.js';
import { logger } from '../lib/logger.js';
import { resolveDocsRagLabConfigWithLocalDefault } from '../scripts/docs-rag/config.js';
import {
  checkDocsRagLabCorpusHealth,
  checkDocsRagLabDatabaseHealth,
} from '../scripts/docs-rag/db.js';
import {
  DOCS_RAG_REQUIRED_PROVENANCE_FIELDS,
  type DocsRagLabSearchResult,
  type DocsRagProvenanceField,
  type DocsRagProvenanceStatus,
  getDocsRagLabDocumentByPath,
  listDocsRagLabCategories,
  searchDocsRagLab,
} from '../scripts/docs-rag/store.js';
import { type DocsVaultSearchResult, searchDocFiles } from '../scripts/docs-vault/local-tools.js';
import {
  DOCS_SOURCE_REGISTRY,
  type DocsSourceAuthority,
  type DocsSourceFilter,
  type DocsSourceKind,
  lookupDocsSourceByPath,
  matchesDocsSourceFilter,
  normalizeDocsSourceMetadata,
} from '../scripts/lib/docs-source-registry.js';
import {
  createSecurityErrorResponse,
  VALID_CONTEXTS,
  validateEnum,
  validateNumber,
  validateString,
} from './lib/input-validation.js';

interface PathValidationResult {
  valid: boolean;
  error?: string;
  sanitizedPath?: string;
}

function validateSourcePath(sourcePath: string): PathValidationResult {
  if (sourcePath.includes('\0')) {
    return { valid: false, error: 'Path contains invalid characters (null bytes)' };
  }

  const normalized = sourcePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  const traversalPattern = /(?:^|\/)\.\.(?:\/|$)/;
  if (traversalPattern.test(normalized)) {
    return { valid: false, error: 'Path contains directory traversal sequences (..)' };
  }
  if (normalized.startsWith('/')) {
    return { valid: false, error: 'Absolute paths are not allowed' };
  }

  return { valid: true, sanitizedPath: normalized };
}

function isExternalDocSourcePath(sourcePath: string): boolean {
  return lookupDocsSourceByPath(sourcePath) !== undefined;
}

function matchesRequestedDocTypes(sourcePath: string, docTypes?: string[]): boolean {
  if (!docTypes || docTypes.length === 0) {
    return true;
  }

  const isExternal = isExternalDocSourcePath(sourcePath);
  return docTypes.some((docType) => (docType === 'external' ? isExternal : !isExternal));
}

type SearchDocsSourceArgs = {
  categories?: string[];
  source?: string;
  sources?: string[];
  sourceId?: string;
  sourceIds?: string[];
  language?: string;
  kind?: DocsSourceKind;
  authority?: DocsSourceAuthority;
  sourceTags?: string[];
};

type SearchDocsTagFilters = {
  include?: string[];
  exclude?: string[];
  operator?: 'AND' | 'OR';
};

function docsSearchSourceIds(args: SearchDocsSourceArgs): string[] {
  return [
    args.source,
    args.sourceId,
    ...(Array.isArray(args.sources) ? args.sources : []),
    ...(Array.isArray(args.sourceIds) ? args.sourceIds : []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function hasDocsSourceFilters(args: SearchDocsSourceArgs): boolean {
  return (
    docsSearchSourceIds(args).length > 0 ||
    (Array.isArray(args.categories) && args.categories.length > 0) ||
    typeof args.language === 'string' ||
    typeof args.kind === 'string' ||
    typeof args.authority === 'string' ||
    (Array.isArray(args.sourceTags) && args.sourceTags.length > 0)
  );
}

function hasSearchDocsTagFilters(tags?: SearchDocsTagFilters): boolean {
  return Boolean(
    tags &&
      ((Array.isArray(tags.include) && tags.include.length > 0) ||
        (Array.isArray(tags.exclude) && tags.exclude.length > 0) ||
        typeof tags.operator === 'string')
  );
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function parseDocsSourceKindValue(value: unknown): DocsSourceKind | undefined {
  return value === 'official-docs' ||
    value === 'book' ||
    value === 'package-docs' ||
    value === 'repository-docs'
    ? value
    : undefined;
}

function parseDocsSourceAuthorityValue(value: unknown): DocsSourceAuthority | undefined {
  return value === 'official' || value === 'publisher' || value === 'community-vetted'
    ? value
    : undefined;
}

type SearchDocsRetrievalMode = 'hybrid' | 'local_first';

type DocsSearchCanonicalFields = {
  sourceId: string | null;
  sourcePath: string;
  canonicalUrl: string | null;
  title: string;
  heading: string | null;
  section: string | null;
  chunkIndex: number | null;
  sourceRevision: string | null;
  syncedAt: string | null;
  authority: DocsSourceAuthority | null;
  score: number;
  content: string;
  provenanceStatus: DocsRagProvenanceStatus;
  missingFields: readonly DocsRagProvenanceField[];
};

type DocsSearchNormalizedResult = {
  readonly title: string;
  readonly sourcePath: string;
  readonly score: number;
  readonly excerpt: string;
  readonly section: string | null;
  readonly isCrossLang?: boolean;
  readonly metadata?: DocsVaultSearchMetadata;
  readonly retrievalSource: 'docs_rag_postgres' | 'docs_vault_local';
  readonly matchKind?: string;
} & DocsSearchCanonicalFields;

type DocsSearchStructuredResult = DocsSearchCanonicalFields & {
  excerpt: string;
  retrievalSource: 'docs_rag_postgres' | 'docs_vault_local';
  language?: string;
  kind?: DocsSourceKind;
  tags?: readonly string[];
  isCrossLang?: boolean;
  matchKind?: string;
  canonicalPath?: string;
  wikiPath?: string;
  rawPath?: string;
  pageId?: string;
  pageRef?: string;
  trustLevel?: DocsSourceAuthority;
};

function normalizeSearchDocsRetrievalMode(value: unknown): SearchDocsRetrievalMode {
  return value === 'local_first' ? 'local_first' : 'hybrid';
}

function hasDocsVaultRoots(): boolean {
  return Boolean(process.env.DOCS_VAULT_ROOT?.trim() && process.env.DOCS_VAULT_INDEX_ROOT?.trim());
}

function buildDocsSearchMetadata(
  sourcePath: string | undefined,
  rawMetadata: Record<string, unknown>
): DocsVaultSearchMetadata | undefined {
  const normalized = normalizeDocsSourceMetadata({
    sourcePath,
    sourceId: stringField(rawMetadata.sourceId),
    category: stringField(rawMetadata.category),
    language: stringField(rawMetadata.language),
    kind: parseDocsSourceKindValue(rawMetadata.kind),
    authority: parseDocsSourceAuthorityValue(rawMetadata.authority),
    tags: toStringArray(rawMetadata.tags),
  });

  const metadata: DocsVaultSearchMetadata = {
    sourceId: normalized.sourceId,
    category: normalized.category,
    language: normalized.language,
    kind: normalized.kind,
    authority: normalized.authority,
    tags: normalized.tags.length > 0 ? [...normalized.tags] : undefined,
    canonicalUrl: stringField(rawMetadata.canonicalUrl),
    canonicalPath: stringField(rawMetadata.canonicalPath),
    wikiPath: stringField(rawMetadata.wikiPath),
    rawPath: stringField(rawMetadata.rawPath),
    wikiReference: stringField(rawMetadata.wikiReference),
    pageId: stringField(rawMetadata.pageId),
    trustLevel: normalized.authority ?? parseDocsSourceAuthorityValue(rawMetadata.trustLevel),
  };

  return Object.values(metadata).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return value !== undefined;
  })
    ? metadata
    : undefined;
}

function resolveDocsSearchProvenance(input: {
  canonicalUrl: string | null;
  sourceRevision: string | null;
  syncedAt: string | null;
  authority: DocsSourceAuthority | null;
  missingFields?: readonly DocsRagProvenanceField[];
  provenanceStatus?: DocsRagProvenanceStatus;
}): Pick<
  DocsSearchCanonicalFields,
  | 'canonicalUrl'
  | 'sourceRevision'
  | 'syncedAt'
  | 'authority'
  | 'provenanceStatus'
  | 'missingFields'
> {
  const missingFields = input.missingFields
    ? [...input.missingFields]
    : DOCS_RAG_REQUIRED_PROVENANCE_FIELDS.filter((field) => {
        if (field === 'canonicalUrl') return input.canonicalUrl === null;
        if (field === 'sourceRevision') return input.sourceRevision === null;
        if (field === 'syncedAt') return input.syncedAt === null;
        return input.authority === null;
      });
  return {
    canonicalUrl: input.canonicalUrl,
    sourceRevision: input.sourceRevision,
    syncedAt: input.syncedAt,
    authority: input.authority,
    provenanceStatus:
      input.provenanceStatus ?? (missingFields.length === 0 ? 'complete' : 'degraded'),
    missingFields,
  };
}

function normalizePostgresDocsSearchResult(
  result: DocsRagLabSearchResult
): DocsSearchNormalizedResult {
  const metadata = buildDocsSearchMetadata(result.sourcePath, {
    sourceId: result.sourceId,
    canonicalUrl: result.canonicalUrl,
    authority: result.authority,
  });
  const authority =
    result.authority !== undefined ? (result.authority ?? null) : (metadata?.authority ?? null);
  const provenance = resolveDocsSearchProvenance({
    canonicalUrl: Object.hasOwn(result, 'canonicalUrl') ? (result.canonicalUrl ?? null) : null,
    sourceRevision: Object.hasOwn(result, 'sourceRevision')
      ? (result.sourceRevision ?? null)
      : null,
    syncedAt: Object.hasOwn(result, 'syncedAt') ? (result.syncedAt ?? null) : null,
    authority,
    missingFields: result.missingFields,
    provenanceStatus: result.provenanceStatus,
  });
  return {
    sourceId: result.sourceId,
    sourcePath: result.sourcePath,
    canonicalUrl: provenance.canonicalUrl,
    title: result.title,
    heading: result.heading ?? null,
    section: result.section ?? null,
    chunkIndex: result.chunkIndex,
    sourceRevision: provenance.sourceRevision,
    syncedAt: provenance.syncedAt,
    authority: provenance.authority,
    score: result.score,
    excerpt: result.content,
    content: result.content,
    provenanceStatus: provenance.provenanceStatus,
    missingFields: provenance.missingFields,
    metadata,
    retrievalSource: 'docs_rag_postgres',
  };
}

function normalizeLocalDocsVaultSearchResult(
  result: DocsVaultSearchResult
): DocsSearchNormalizedResult {
  const metadata = buildDocsSearchMetadata(result.path, {
    sourceId: result.sourceId,
    canonicalUrl: result.canonicalUrl,
    canonicalPath: result.canonicalPath,
    wikiPath: result.wikiPath,
    rawPath: result.rawPath,
    wikiReference: result.wikiReference,
    pageId: result.pageId,
  });

  const sourceId = metadata?.sourceId ?? result.sourceId ?? null;
  const authority = metadata?.authority ?? null;
  const provenance = resolveDocsSearchProvenance({
    canonicalUrl: metadata?.canonicalUrl ?? null,
    sourceRevision: null,
    syncedAt: null,
    authority,
  });
  return {
    sourceId,
    sourcePath: result.path,
    canonicalUrl: provenance.canonicalUrl,
    title: result.title,
    heading: null,
    section: `Local match: ${result.matchKind}`,
    chunkIndex: null,
    sourceRevision: provenance.sourceRevision,
    syncedAt: provenance.syncedAt,
    authority: provenance.authority,
    score: result.score / 100,
    excerpt: result.snippet ?? result.matchedText ?? result.path,
    content: result.snippet ?? result.matchedText ?? result.path,
    provenanceStatus: provenance.provenanceStatus,
    missingFields: provenance.missingFields,
    metadata,
    retrievalSource: 'docs_vault_local',
    matchKind: result.matchKind,
  };
}

function buildStructuredDocsSearchResult(
  result: DocsSearchNormalizedResult,
  options: {
    includePageRefs?: boolean;
    includeTrust?: boolean;
  }
): DocsSearchStructuredResult {
  const structured: DocsSearchStructuredResult = {
    sourceId: result.sourceId,
    sourcePath: result.sourcePath,
    canonicalUrl: result.canonicalUrl,
    title: result.title,
    heading: result.heading,
    section: result.section,
    chunkIndex: result.chunkIndex,
    sourceRevision: result.sourceRevision,
    syncedAt: result.syncedAt,
    authority: result.authority,
    score: result.score,
    content: result.content,
    provenanceStatus: result.provenanceStatus,
    missingFields: result.missingFields,
    excerpt: result.excerpt,
    language: result.metadata?.language,
    kind: result.metadata?.kind,
    tags: result.metadata?.tags,
    retrievalSource: result.retrievalSource,
    isCrossLang: result.isCrossLang,
    matchKind: result.matchKind,
  };

  if (options.includePageRefs) {
    structured.canonicalPath = result.metadata?.canonicalPath;
    structured.wikiPath = result.metadata?.wikiPath;
    structured.rawPath = result.metadata?.rawPath;
    structured.pageId = result.metadata?.pageId;
    structured.pageRef = result.metadata?.wikiReference;
  }

  if (options.includeTrust) {
    structured.trustLevel = result.metadata?.trustLevel;
  }

  return structured;
}

function matchesNormalizedDocsSearchSourceFilters(
  result: DocsSearchNormalizedResult,
  filter: DocsSourceFilter
): boolean {
  return matchesDocsSourceFilter(
    {
      sourcePath: result.sourcePath,
      sourceId: result.metadata?.sourceId,
      category: result.metadata?.category,
      language: result.metadata?.language,
      kind: result.metadata?.kind,
      authority: result.metadata?.authority,
      tags: result.metadata?.tags,
    },
    filter
  );
}

function formatDocsSearchResult(result: DocsSearchNormalizedResult, index: number): string {
  const localMatchInfo =
    result.retrievalSource === 'docs_vault_local' && result.matchKind
      ? `
**Local Match:** ${result.matchKind}`
      : '';

  return `
## ${index + 1}. ${result.title}
**Source:** ${result.sourcePath} ${result.isCrossLang ? '(Cross-language match)' : ''}
**Score:** ${result.score.toFixed(3)}${localMatchInfo}
${result.section ? `**Section:** ${result.section}` : ''}

\`\`\`
${result.excerpt}
\`\`\`
      `.trim();
}

function getDocsVaultSearchRoots():
  | {
      indexRoot: string;
      vaultRoot: string;
    }
  | undefined {
  const vaultRoot = process.env.DOCS_VAULT_ROOT?.trim();
  const indexRoot = process.env.DOCS_VAULT_INDEX_ROOT?.trim();
  if (!vaultRoot || !indexRoot) {
    return undefined;
  }

  return { vaultRoot, indexRoot };
}

function maybeRunLocalDocsVaultSearch(args: {
  query: string;
  limit: number;
  retrievalMode: SearchDocsRetrievalMode;
  sourceIds: string[];
}):
  | {
      results?: DocsSearchNormalizedResult[];
      warning?: string;
    }
  | undefined {
  if (args.retrievalMode !== 'local_first') {
    return undefined;
  }

  const roots = getDocsVaultSearchRoots();
  if (!roots) {
    return {
      warning:
        'Docs Vault local-first retrieval requested, but DOCS_VAULT_ROOT or DOCS_VAULT_INDEX_ROOT is not configured. Falling back to backend search.',
    };
  }

  try {
    const localResults = searchDocFiles({
      query: args.query,
      exact: true,
      limit: args.limit,
      sourceIds: args.sourceIds.length > 0 ? args.sourceIds : undefined,
      vaultRoot: roots.vaultRoot,
      indexRoot: roots.indexRoot,
    });

    if (localResults.results.length === 0) {
      return undefined;
    }

    return {
      results: localResults.results.map(normalizeLocalDocsVaultSearchResult),
    };
  } catch (error) {
    logger.warn(
      { operation: 'mcp', query: args.query, error },
      'Docs Vault local pre-search failed; continuing with backend search'
    );
    return {
      warning: 'Docs Vault local pre-search failed; continuing with backend search.',
    };
  }
}

export async function handleSearchDocs(
  args: {
    query: string;
    categories?: string[];
    source?: string;
    sources?: string[];
    sourceId?: string;
    sourceIds?: string[];
    language?: string;
    kind?: DocsSourceKind;
    authority?: DocsSourceAuthority;
    sourceTags?: string[];
    retrievalMode?: SearchDocsRetrievalMode;
    includePageRefs?: boolean;
    includeTrust?: boolean;
    tags?: SearchDocsTagFilters;
    limit?: number;
    active_file?: string;
  },
  docTypes?: string[],
  signal?: AbortSignal
) {
  const queryValidation = validateString(args.query, 'query', { maxLength: 2000 });
  if (!queryValidation.valid) {
    return createSecurityErrorResponse(queryValidation.error);
  }
  const query = queryValidation.value;

  let validatedLimit = 10;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== 'number') {
      return createSecurityErrorResponse('Invalid limit: expected number');
    }
    validatedLimit = Math.min(Math.max(args.limit, 1), 50);
  }

  if (args.active_file !== undefined) {
    const activeFileValidation = validateString(args.active_file, 'active_file', {
      maxLength: 500,
    });
    if (!activeFileValidation.valid) {
      return createSecurityErrorResponse(activeFileValidation.error);
    }
  }

  const validLimit = Math.min(Math.max(validatedLimit, 1), 50);
  const { categories, tags } = args;
  const retrievalMode = normalizeSearchDocsRetrievalMode(args.retrievalMode);
  const requestedDocTypes = Array.isArray(docTypes) && docTypes.length > 0 ? docTypes : undefined;
  const sourceIds = docsSearchSourceIds(args);
  const sourceFilter: DocsSourceFilter = {
    sourceIds,
    categories,
    language: args.language,
    kind: args.kind,
    authority: args.authority,
    tags: args.sourceTags,
  };
  const hasSourceFilters = hasDocsSourceFilters(args);
  const backendLimit =
    requestedDocTypes || hasSourceFilters
      ? Math.min(Math.max(validLimit * 4, validLimit), 100)
      : validLimit;
  const warnings: string[] = [];

  try {
    const hasTagFilters = hasSearchDocsTagFilters(tags);
    const localSearch =
      retrievalMode === 'local_first' && !hasTagFilters
        ? maybeRunLocalDocsVaultSearch({
            query,
            limit: backendLimit,
            retrievalMode,
            sourceIds,
          })
        : undefined;

    if (localSearch?.warning) {
      warnings.push(localSearch.warning);
    }

    let normalizedResults: DocsSearchNormalizedResult[];
    const filteredLocalResults =
      localSearch?.results?.filter(
        (result) =>
          matchesRequestedDocTypes(result.sourcePath, requestedDocTypes) &&
          (!hasSourceFilters || matchesNormalizedDocsSearchSourceFilters(result, sourceFilter))
      ) ?? [];

    if (filteredLocalResults.length > 0) {
      normalizedResults = filteredLocalResults.slice(0, validLimit);
    } else {
      const docsRagLabConfig = resolveDocsRagLabConfigWithLocalDefault(process.env);
      if (!docsRagLabConfig.database.url) {
        throw new Error(
          'Docs RAG Postgres database is required. Set DOCS_RAG_PG_LAB_DATABASE_URL.'
        );
      }
      if (requestedDocTypes?.[0] === 'project') {
        throw new Error('Project docs search is retired. Use search_project_code.');
      }

      const backendSourceIds = hasSourceFilters
        ? DOCS_SOURCE_REGISTRY.filter((source) =>
            matchesDocsSourceFilter(source, sourceFilter)
          ).map((source) => source.sourceId)
        : undefined;
      // Honest degradation signals (additive warnings only).
      if (!docsRagLabConfig.gates.embeddingEnabled) {
        warnings.push('Embedding gate disabled; backend search degraded to keyword-only mode.');
      }
      if (hasSourceFilters && !backendSourceIds?.length) {
        // Sentinel source-id path below masks the filter miss as a plain
        // "No results found"; surface the real cause as a warning too.
        warnings.push(
          'Filter matched zero sources; check category/sourceId/language/kind/tag values.'
        );
      }
      const report = await searchDocsRagLab(docsRagLabConfig, query, {
        limit: Math.min(backendLimit, 50),
        sourceIds: backendSourceIds?.length
          ? backendSourceIds
          : hasSourceFilters
            ? ['__no_matching_source__']
            : undefined,
        mode: docsRagLabConfig.gates.embeddingEnabled ? 'hybrid' : 'keyword',
        signal,
      });
      normalizedResults = report.results
        .filter(
          (result) =>
            matchesRequestedDocTypes(result.sourcePath, requestedDocTypes) &&
            (!hasSourceFilters ||
              matchesDocsSourceFilter(
                { sourcePath: result.sourcePath, sourceId: result.sourceId },
                sourceFilter
              ))
        )
        .slice(0, validLimit)
        .map(normalizePostgresDocsSearchResult);
    }

    const warningText = warnings.length > 0 ? `\n\nWarning: ${warnings.join('\nWarning: ')}` : '';

    if (normalizedResults.length === 0) {
      return {
        content: [{ type: 'text', text: `No results found for query: "${query}"${warningText}` }],
        structuredContent: {
          query,
          retrievalMode,
          resultCount: 0,
          localFirstConfigured: hasDocsVaultRoots(),
          warnings,
          results: [],
        },
      };
    }

    const formattedResults = normalizedResults
      .map((result, index) => formatDocsSearchResult(result, index))
      .join('\n\n---\n\n');
    const structuredResults = normalizedResults.map((result) =>
      buildStructuredDocsSearchResult(result, {
        includePageRefs: args.includePageRefs,
        includeTrust: args.includeTrust,
      })
    );
    const renderedResultCount = normalizedResults.length;

    return {
      content: [
        {
          type: 'text',
          text: `Found ${renderedResultCount} results for: "${query}"${warningText}\n\n${formattedResults}`,
        },
      ],
      structuredContent: {
        query,
        retrievalMode,
        resultCount: renderedResultCount,
        localFirstConfigured: hasDocsVaultRoots(),
        warnings,
        results: structuredResults,
      },
    };
  } catch (error) {
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message ?? error.name ?? 'Unknown error';
      if (!errorMessage || errorMessage === 'Error') {
        errorMessage = String(error);
      }
    } else if (error === null || error === undefined) {
      errorMessage = 'Unknown error (null/undefined)';
    } else {
      errorMessage = String(error);
    }
    throw new Error(`Failed to search: ${errorMessage}`);
  }
}

export async function handleListCategories() {
  try {
    const docsRagLabConfig = resolveDocsRagLabConfigWithLocalDefault(process.env);
    if (!docsRagLabConfig.database.url) {
      throw new Error('Docs RAG Postgres database is required. Set DOCS_RAG_PG_LAB_DATABASE_URL.');
    }
    const categories = await listDocsRagLabCategories(docsRagLabConfig);
    const structuredContent = {
      success: true,
      data: { categories },
    };

    if (!categories || categories.length === 0) {
      return {
        content: [{ type: 'text', text: 'No categories found.' }],
        structuredContent,
      };
    }

    const formatted = categories
      .map(
        (cat: { displayName: string; name: string; docCount: number; chunkCount: number }) =>
          `## ${cat.displayName} (${cat.name})\n**Documents:** ${cat.docCount} | **Chunks:** ${cat.chunkCount}`
      )
      .join('\n\n');

    return {
      content: [
        { type: 'text', text: `Available Categories (${categories.length}):\n\n${formatted}` },
      ],
      structuredContent,
    };
  } catch (error) {
    throw new Error(
      `Failed to list categories: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleGetDocument(args: { sourcePath: string }) {
  const pathValidation = validateSourcePath(args.sourcePath);
  if (!pathValidation.valid) {
    return createSecurityErrorResponse(
      `Invalid source path - ${pathValidation.error ?? 'invalid path'}`
    );
  }

  if (typeof pathValidation.sanitizedPath !== 'string') {
    return createSecurityErrorResponse('Unable to normalize source path.');
  }

  const sourcePath = pathValidation.sanitizedPath;
  if (!isExternalDocSourcePath(sourcePath)) {
    return createSecurityErrorResponse(
      'sourcePath must resolve to a registered external Docs RAG source.'
    );
  }

  try {
    const docsRagLabConfig = resolveDocsRagLabConfigWithLocalDefault(process.env);
    if (!docsRagLabConfig.database.url) {
      throw new Error('Docs RAG Postgres database is required. Set DOCS_RAG_PG_LAB_DATABASE_URL.');
    }
    const data = await getDocsRagLabDocumentByPath(docsRagLabConfig, sourcePath);

    if (!data) {
      return {
        content: [{ type: 'text', text: `Document not found: ${sourcePath}` }],
        structuredContent: {
          success: true,
          data: {
            sourcePath,
            found: false,
            title: '',
            content: '',
            chunkCount: 0,
          },
        },
        isError: false,
      };
    }

    const formatted = data.chunks
      .map(
        (chunk: { chunkIndex: number; content: string }) =>
          `### Chunk ${chunk.chunkIndex}\n${chunk.content}`
      )
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `# ${data.document.title}\n**Path:** ${sourcePath}\n\n${formatted}`,
        },
      ],
      structuredContent: {
        success: true,
        data: {
          sourcePath,
          found: true,
          title: data.document.title,
          content: formatted,
          chunkCount: data.chunks.length,
        },
      },
      isError: false,
    };
  } catch (error) {
    throw new Error(
      `Failed to get document: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleHealthCheck() {
  const results: Array<{
    component: string;
    status: string;
    latencyMs?: number;
    details?: string;
  }> = [];

  results.push({ component: 'MCP Server', status: 'OK', latencyMs: 0 });

  const docsRagLabConfig = resolveDocsRagLabConfigWithLocalDefault(process.env);
  if (docsRagLabConfig.database.url) {
    const docsStart = Date.now();
    const [docsHealth, corpusHealth] = await Promise.all([
      checkDocsRagLabDatabaseHealth(docsRagLabConfig),
      checkDocsRagLabCorpusHealth(docsRagLabConfig),
    ]);
    results.push({
      component: 'Docs RAG Postgres',
      status: docsHealth.status === 'healthy' ? 'OK' : 'ERROR',
      latencyMs: docsHealth.latencyMs ?? Date.now() - docsStart,
      details: docsHealth.message,
    });
    results.push({
      component: 'Docs RAG Corpus',
      status: corpusHealth.status === 'healthy' ? 'OK' : 'ERROR',
      details: corpusHealth.message,
    });
  } else {
    results.push({
      component: 'Docs RAG Postgres',
      status: 'ERROR',
      details: 'Set DOCS_RAG_PG_LAB_DATABASE_URL.',
    });
  }

  const anyError = results.some((r) => r.status === 'ERROR');
  const formatted = results
    .map((r) => {
      const latency = r.latencyMs !== undefined ? ` (${r.latencyMs}ms)` : '';
      const details = r.details ? `\n  ${r.details}` : '';
      return `${r.component}: ${r.status}${latency}${details}`;
    })
    .join('\n');

  return {
    content: [
      {
        type: 'text',
        text: `# Health Check Results\n\n${formatted}`,
      },
    ],
    structuredContent: {
      success: !anyError,
      data: {
        components: results,
      },
    },
    isError: anyError,
  };
}

function getRerankingServiceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RERANKING_SERVICE_URL) {
    return env.RERANKING_SERVICE_URL.replace(/\/+$/, '');
  }

  const host = env.RERANKING_SERVICE_HOST ?? '127.0.0.1';
  const port = env.RERANKING_SERVICE_PORT ?? '3456';
  return `http://${host}:${port}`;
}

async function checkLocalRerankerHealth(timeoutMs: number) {
  const serviceUrl = getRerankingServiceBaseUrl();
  const startTime = Date.now();

  try {
    const response = await fetch(`${serviceUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      model?: unknown;
      status?: unknown;
    };

    return {
      healthy: response.ok,
      latencyMs: Date.now() - startTime,
      model: typeof payload.model === 'string' ? payload.model : undefined,
      serviceUrl,
      status: typeof payload.status === 'string' ? payload.status : undefined,
    };
  } catch {
    return {
      healthy: false,
      latencyMs: Date.now() - startTime,
      serviceUrl,
    };
  }
}

export async function handleEnsureReranker(args?: { timeout?: number }) {
  const timeout = args?.timeout ?? 30;
  const startTime = Date.now();
  const healthTimeoutMs = Math.min(timeout * 1000, 2000);

  try {
    const { execFileSync } = await import('node:child_process');

    const initialHealth = await checkLocalRerankerHealth(healthTimeoutMs);
    if (initialHealth.healthy) {
      const model = initialHealth.model ? `\nModel: ${initialHealth.model}` : '';
      return {
        content: [
          {
            type: 'text',
            text: `# Reranker Service: Already Running\n\nStatus: OK\nLatency: ${Date.now() - startTime}ms\nService URL: ${initialHealth.serviceUrl}${model}\n\nNo action needed. The reranking service is already active.`,
          },
        ],
        structuredContent: {
          success: true,
          data: {
            status: 'running',
            serviceUrl: initialHealth.serviceUrl,
            model: initialHealth.model,
            latencyMs: Date.now() - startTime,
          },
        },
        isError: false,
      };
    }

    logger.info({ operation: 'ensure_reranker' }, 'Starting reranker service...');

    const supervisorScript = fileURLToPath(
      new URL('../scripts/ensure-reranker.sh', import.meta.url)
    );
    execFileSync('bash', [supervisorScript], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: timeout * 1000,
      stdio: 'pipe',
      env: { ...process.env, RERANKING_SERVICE_AUTO_START: 'true' },
    });

    const finalHealth = await checkLocalRerankerHealth(healthTimeoutMs);
    const elapsedMs = Date.now() - startTime;

    if (finalHealth.healthy) {
      const model = finalHealth.model ? `\nModel: ${finalHealth.model}` : '';
      return {
        content: [
          {
            type: 'text',
            text: `# Reranker Service: Started\n\nStatus: OK\nStartup time: ${elapsedMs}ms\nService URL: ${finalHealth.serviceUrl}${model}\n\nThe reranking service is ready for optimal search quality.`,
          },
        ],
        structuredContent: {
          success: true,
          data: {
            status: 'started',
            serviceUrl: finalHealth.serviceUrl,
            model: finalHealth.model,
            latencyMs: elapsedMs,
          },
        },
        isError: false,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `# Reranker Service: Start Attempted\n\nStatus: NOT READY\nElapsed: ${elapsedMs}ms\nService URL: ${finalHealth.serviceUrl}\n\nThe startup script completed, but health check did not pass yet. Check service logs.`,
        },
      ],
      structuredContent: {
        success: false,
        error: {
          code: 'RERANKER_NOT_READY',
          message: `Reranker health check did not pass at ${finalHealth.serviceUrl}.`,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'ensure_reranker' }, 'Failed to ensure reranker service');
    return {
      content: [
        {
          type: 'text',
          text: `# Reranker Service: Failed\n\nError: ${msg}\n\nRun manually: bash scripts/ensure-reranker.sh`,
        },
      ],
      structuredContent: {
        success: false,
        error: {
          code: 'RERANKER_START_FAILED',
          message: msg,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }
}

// sanitizeErrorMessage removed (Gemini API key redaction no longer needed).

/**
 * @deprecated Gemini-powered adaptation is retired.  This handler performs
 * deterministic local-only content reorganization.  Use subagent-based
 * processing for production needs.
 */
export async function handleAdaptDocs(args: {
  content: string;
  context: 'code-focused' | 'architecture' | 'beginner' | 'senior' | 'quick-ref';
  maxLength?: number;
  preserveCode?: boolean;
}) {
  const contentValidation = validateString(args.content, 'content', { maxLength: 50000 });
  if (!contentValidation.valid) {
    return createSecurityErrorResponse(contentValidation.error);
  }

  const contextValidation = validateEnum(args.context, 'context', VALID_CONTEXTS);
  if (!contextValidation.valid) {
    return createSecurityErrorResponse(contextValidation.error);
  }

  const maxLengthValidation = validateNumber(args.maxLength, 'maxLength', {
    min: 100,
    max: 10000,
    defaultValue: 2000,
  });
  if (!maxLengthValidation.valid) {
    return createSecurityErrorResponse(maxLengthValidation.error);
  }

  try {
    const { adaptDocument, validateOutput } = await import('../scripts/lib/adapter.js');
    const adapted = await adaptDocument(args.content, args.context, {
      maxLength: args.maxLength,
      preserveCode: args.preserveCode,
    });

    const validation = validateOutput(args.content, adapted);
    if (!validation.valid) {
      logger.warn(
        { operation: 'mcp', issues: validation.issues, context: args.context },
        'Adaptation validation warnings'
      );
    }

    return {
      content: [
        {
          type: 'text',
          text:
            adapted +
            '\n\n---\n⚠️ **adapt_docs is deprecated.** Gemini-powered adaptation is retired. ' +
            'This tool performs deterministic local-only reorganization. ' +
            'Use subagent-based processing for production needs.',
        },
      ],
      structuredContent: {
        success: true,
        data: {
          content: adapted,
          context: args.context,
          deprecated: true,
        },
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp', context: args.context }, 'Document adaptation failed');
    return {
      content: [{ type: 'text', text: `Adaptation failed: ${msg}` }],
      structuredContent: {
        success: false,
        error: {
          code: 'ADAPTATION_FAILED',
          message: msg,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }
}

/**
 * @deprecated Uses deprecated adapt_docs tool. See handleAdaptDocs.
 */
export async function handleSearchAndAdapt(args: {
  query: string;
  context: 'code-focused' | 'architecture' | 'beginner' | 'senior' | 'quick-ref';
  categories?: string[];
  limit?: number;
  maxLength?: number;
  preserveCode?: boolean;
}) {
  const queryValidation = validateString(args.query, 'query', { maxLength: 2000 });
  if (!queryValidation.valid) {
    return createSecurityErrorResponse(queryValidation.error);
  }

  const contextValidation = validateEnum(args.context, 'context', VALID_CONTEXTS);
  if (!contextValidation.valid) {
    return createSecurityErrorResponse(contextValidation.error);
  }

  const limitValidation = validateNumber(args.limit, 'limit', { min: 1, max: 20, defaultValue: 5 });
  if (!limitValidation.valid) {
    return createSecurityErrorResponse(limitValidation.error);
  }

  const maxLengthValidation = validateNumber(args.maxLength, 'maxLength', {
    min: 100,
    max: 10000,
    defaultValue: 2000,
  });
  if (!maxLengthValidation.valid) {
    return createSecurityErrorResponse(maxLengthValidation.error);
  }

  try {
    const searchResult = await handleSearchDocs(
      {
        query: args.query,
        categories: args.categories,
        limit: args.limit ?? 5,
      },
      ['external']
    );

    const searchPayload =
      searchResult.structuredContent && typeof searchResult.structuredContent === 'object'
        ? (searchResult.structuredContent as {
            resultCount?: unknown;
            results?: unknown;
            success?: unknown;
            error?: unknown;
          })
        : undefined;
    const resultCount =
      typeof searchPayload?.resultCount === 'number'
        ? searchPayload.resultCount
        : Array.isArray(searchPayload?.results)
          ? searchPayload.results.length
          : undefined;
    if ('isError' in searchResult && searchResult.isError) {
      const errorOutput = {
        success: false,
        error: searchPayload?.error ?? {
          code: 'SEARCH_FAILED',
          message: 'Docs search failed',
          timestamp: new Date().toISOString(),
        },
      };
      return {
        content: searchResult.content,
        structuredContent: errorOutput,
        isError: true,
      };
    }

    if (resultCount === undefined || resultCount === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No results found for query: "${args.query}"\n\n---\n⚠️ **search_and_adapt is deprecated.** Gemini-powered adaptation is retired. ` +
              'This tool performs deterministic local-only reorganization. ' +
              'Use subagent-based processing for production needs.',
          },
        ],
        structuredContent: {
          success: true,
          data: {
            query: args.query,
            found: false,
            content: '',
            deprecated: true,
          },
        },
      };
    }

    const searchText = searchResult.content[0]?.text ?? '';

    const { adaptDocument } = await import('../scripts/lib/adapter.js');
    const adapted = await adaptDocument(searchText, args.context, {
      maxLength: args.maxLength,
      preserveCode: args.preserveCode,
    });

    return {
      content: [
        {
          type: 'text',
          text:
            adapted +
            '\n\n---\n⚠️ **search_and_adapt is deprecated.** Gemini-powered adaptation is retired. ' +
            'This tool performs deterministic local-only reorganization. ' +
            'Use subagent-based processing for production needs.',
        },
      ],
      structuredContent: {
        success: true,
        data: {
          query: args.query,
          context: args.context,
          content: adapted,
          deprecated: true,
        },
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error, operation: 'mcp', query: args.query }, 'Search and adapt failed');
    return {
      content: [{ type: 'text', text: `Search and adaptation failed: ${msg}` }],
      structuredContent: {
        success: false,
        error: {
          code: 'SEARCH_AND_ADAPT_FAILED',
          message: msg,
          timestamp: new Date().toISOString(),
        },
      },
      isError: true,
    };
  }
}
