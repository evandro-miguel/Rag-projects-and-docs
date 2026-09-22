export type DocsSourceKind = 'official-docs' | 'book' | 'package-docs' | 'repository-docs';
export type DocsSourceAuthority = 'official' | 'publisher' | 'community-vetted';

export type DocsSourceRegistryEntry = {
  sourceId: string;
  category: string;
  language?: string;
  kind: DocsSourceKind;
  authority: DocsSourceAuthority;
  tags: readonly string[];
  pathPrefixes: readonly string[];
  aliases?: readonly string[];
  lang?: string;
  ecosystem?: string;
  lib?: string;
};

export type DocsSourceMetadataInput = {
  sourceId?: string | null;
  sourcePath?: string | null;
  category?: string | null;
  language?: string | null;
  kind?: DocsSourceKind | null;
  authority?: DocsSourceAuthority | null;
  tags?: readonly string[] | null;
  lang?: string | null;
  ecosystem?: string | null;
  lib?: string | null;
};

export type NormalizedDocsSourceMetadata = {
  sourceId?: string;
  category?: string;
  language?: string;
  kind?: DocsSourceKind;
  authority?: DocsSourceAuthority;
  tags: readonly string[];
  lang?: string;
  ecosystem?: string;
  lib?: string;
};

export type DocsSourceFilter = {
  sourceId?: string | null;
  sourceIds?: readonly string[] | null;
  category?: string | null;
  categories?: readonly string[] | null;
  language?: string | null;
  kind?: DocsSourceKind | null;
  authority?: DocsSourceAuthority | null;
  tags?: readonly string[] | null;
};

export const DOCS_SOURCE_ARTIFACT_PREFIXES = [
  'ingest/source/external/',
  'ingest/processed/external/',
] as const;

export const DOCS_SOURCE_REGISTRY: readonly DocsSourceRegistryEntry[] = [
  {
    sourceId: 'react-docs',
    category: 'react',
    kind: 'official-docs',
    authority: 'official',
    tags: ['react', 'javascript', 'typescript'],
    pathPrefixes: ['react-docs/'],
    ecosystem: 'node',
    lib: 'react',
  },
  {
    sourceId: 'components',
    category: 'tailwind',
    kind: 'official-docs',
    authority: 'official',
    tags: ['tailwind', 'css'],
    pathPrefixes: ['components/', 'tailwindcss-docs/', 'tailwind/'],
    aliases: ['tailwindcss-docs', 'tailwind'],
    lib: 'tailwind',
  },
  {
    sourceId: 'tanstack',
    category: 'tanstack',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['tanstack', 'router', 'typescript'],
    pathPrefixes: ['tanstack/', 'tanstack-router-docs/'],
    aliases: ['tanstack-router-docs'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'tanstack-router',
  },
  {
    sourceId: 'zod-docs',
    category: 'zod',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['zod', 'typescript'],
    pathPrefixes: ['zod-docs/'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'zod',
  },
  {
    sourceId: 'python-docs',
    category: 'python',
    language: 'python',
    kind: 'official-docs',
    authority: 'official',
    tags: ['python', 'official'],
    pathPrefixes: ['python-docs/'],
    lang: 'py',
    ecosystem: 'python',
    lib: 'python',
  },
  {
    sourceId: 'typescript-docs',
    category: 'typescript',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['typescript', 'official'],
    pathPrefixes: ['typescript-docs/'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'typescript',
  },
  {
    sourceId: 'bun-docs',
    category: 'bun',
    language: 'bun',
    kind: 'official-docs',
    authority: 'official',
    tags: ['bun', 'typescript', 'official'],
    pathPrefixes: ['bun-docs/'],
    lang: 'ts',
    ecosystem: 'bun',
    lib: 'bun',
  },
  {
    sourceId: 'uv-docs',
    category: 'uv',
    language: 'python',
    kind: 'official-docs',
    authority: 'official',
    tags: ['uv', 'python', 'package-manager', 'official'],
    pathPrefixes: ['uv-docs/'],
    aliases: ['uv'],
    lang: 'py',
    ecosystem: 'python',
    lib: 'uv',
  },
  {
    sourceId: 'fastapi-docs',
    category: 'fastapi',
    language: 'python',
    kind: 'official-docs',
    authority: 'official',
    tags: ['fastapi', 'python', 'api', 'official'],
    pathPrefixes: ['fastapi-docs/'],
    aliases: ['fastapi'],
    lang: 'py',
    ecosystem: 'python',
    lib: 'fastapi',
  },
  {
    sourceId: 'zustand-docs',
    category: 'zustand',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['zustand', 'react', 'typescript', 'state'],
    pathPrefixes: ['zustand-docs/'],
    aliases: ['zustand'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'zustand',
  },
  {
    sourceId: 'react-router-docs',
    category: 'react-router',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['react-router', 'react', 'typescript', 'routing'],
    pathPrefixes: ['react-router-docs/'],
    aliases: ['react-router', 'reactrouter'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'react-router',
  },
  {
    sourceId: 'docker-docs',
    category: 'docker',
    kind: 'official-docs',
    authority: 'official',
    tags: ['docker', 'containers', 'compose', 'official'],
    pathPrefixes: ['docker-docs/'],
    aliases: ['docker'],
    ecosystem: 'containers',
    lib: 'docker',
  },
  {
    sourceId: 'go-docs',
    category: 'go',
    language: 'go',
    kind: 'official-docs',
    authority: 'official',
    tags: ['go', 'official'],
    pathPrefixes: ['go-docs/'],
    lang: 'go',
    ecosystem: 'go',
    lib: 'go',
  },
  {
    sourceId: 'go-books',
    category: 'go',
    language: 'go',
    kind: 'book',
    authority: 'community-vetted',
    tags: ['go', 'book'],
    pathPrefixes: ['go-books/'],
    lang: 'go',
    ecosystem: 'go',
    lib: 'go',
  },
  {
    sourceId: 'pgvector-docs',
    category: 'pgvector',
    kind: 'official-docs',
    authority: 'official',
    tags: ['postgres', 'pgvector', 'hnsw', 'halfvec', 'official'],
    pathPrefixes: ['pgvector-docs/'],
    aliases: ['pgvector'],
    ecosystem: 'postgres',
    lib: 'pgvector',
  },
  {
    sourceId: 'mcp-docs',
    category: 'mcp',
    kind: 'official-docs',
    authority: 'official',
    tags: ['mcp', 'protocol', 'stdio', 'tools', 'official'],
    pathPrefixes: ['mcp-docs/'],
    aliases: ['mcp', 'mcp-spec'],
    lib: 'mcp',
  },
  {
    sourceId: 'vitest-docs',
    category: 'vitest',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['vitest', 'testing', 'typescript', 'official'],
    pathPrefixes: ['vitest-docs/'],
    aliases: ['vitest'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'vitest',
  },
  {
    sourceId: 'biome-docs',
    category: 'biome',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['biome', 'linter', 'formatter', 'typescript', 'official'],
    pathPrefixes: ['biome-docs/'],
    aliases: ['biome'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'biome',
  },
  {
    sourceId: 'tanstack-query-docs',
    category: 'tanstack-query',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['tanstack', 'react-query', 'react', 'typescript', 'official'],
    pathPrefixes: ['tanstack-query-docs/'],
    aliases: ['tanstack-query', 'react-query'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'tanstack-query',
  },
  {
    sourceId: 'playwright-docs',
    category: 'playwright',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['playwright', 'testing', 'e2e', 'typescript', 'official'],
    pathPrefixes: ['playwright-docs/'],
    aliases: ['playwright'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'playwright',
  },
  {
    sourceId: 'vite-docs',
    category: 'vite',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['vite', 'bundler', 'typescript', 'official'],
    pathPrefixes: ['vite-docs/'],
    aliases: ['vite'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'vite',
  },
  {
    sourceId: 'hono-docs',
    category: 'hono',
    language: 'typescript',
    kind: 'official-docs',
    authority: 'official',
    tags: ['hono', 'http', 'typescript', 'official'],
    pathPrefixes: ['hono-docs/'],
    aliases: ['hono'],
    lang: 'ts',
    ecosystem: 'node',
    lib: 'hono',
  },
  {
    sourceId: 'pydantic-docs',
    category: 'pydantic',
    language: 'python',
    kind: 'official-docs',
    authority: 'official',
    tags: ['pydantic', 'python', 'validation', 'official'],
    pathPrefixes: ['pydantic-docs/'],
    aliases: ['pydantic'],
    lang: 'py',
    ecosystem: 'python',
    lib: 'pydantic',
  },
  {
    sourceId: 'supabase-database-docs',
    category: 'supabase',
    kind: 'official-docs',
    authority: 'official',
    tags: ['supabase', 'postgres', 'rls', 'official'],
    pathPrefixes: ['supabase-database-docs/'],
    aliases: ['supabase', 'supabase-docs'],
    ecosystem: 'postgres',
    lib: 'supabase',
  },
] as const;

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDocsSourcePath(sourcePath: string): string {
  return sourcePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//u, '').toLowerCase();
}

export function stripDocsSourceArtifactPrefix(sourcePath: string): string {
  const normalized = normalizeDocsSourcePath(sourcePath);
  const artifactPrefix = DOCS_SOURCE_ARTIFACT_PREFIXES.find((prefix) =>
    normalized.startsWith(prefix)
  );

  return artifactPrefix ? normalized.slice(artifactPrefix.length) : normalized;
}

export function isDocsSourceArtifactPath(sourcePath: string): boolean {
  const normalized = normalizeDocsSourcePath(sourcePath);
  return DOCS_SOURCE_ARTIFACT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function lookupDocsSourceById(sourceId: string): DocsSourceRegistryEntry | undefined {
  const normalizedSourceId = normalizeIdentifier(sourceId);
  return DOCS_SOURCE_REGISTRY.find(
    (source) =>
      source.sourceId === normalizedSourceId || source.aliases?.includes(normalizedSourceId)
  );
}

export function canonicalizeDocsSourceId(sourceId: string): string {
  const normalizedSourceId = normalizeIdentifier(sourceId);
  return lookupDocsSourceById(normalizedSourceId)?.sourceId ?? normalizedSourceId;
}

export function lookupDocsSourceByPath(sourcePath: string): DocsSourceRegistryEntry | undefined {
  const canonicalPath = stripDocsSourceArtifactPrefix(sourcePath);
  return DOCS_SOURCE_REGISTRY.find((source) =>
    source.pathPrefixes.some((prefix) => canonicalPath.startsWith(prefix))
  );
}

export function normalizeDocsSourceCanonicalKey(sourcePath: string): string {
  return stripDocsSourceArtifactPrefix(sourcePath).replace(/\.(md|mdx|rst)$/u, '');
}

export function normalizeDocsSourceMetadata(
  input: DocsSourceMetadataInput
): NormalizedDocsSourceMetadata {
  const registryEntry =
    (input.sourceId ? lookupDocsSourceById(input.sourceId) : undefined) ??
    (input.sourcePath ? lookupDocsSourceByPath(input.sourcePath) : undefined) ??
    (input.category ? lookupDocsSourceById(input.category) : undefined);

  const inputTags = input.tags?.map(normalizeIdentifier) ?? [];
  const registryTags = registryEntry?.tags ?? [];
  const tags = Array.from(new Set([...registryTags, ...inputTags]));

  return {
    sourceId: registryEntry?.sourceId ?? normalizeOptional(input.sourceId),
    category: registryEntry?.category ?? normalizeOptional(input.category),
    language: registryEntry?.language ?? normalizeOptional(input.language),
    kind: registryEntry?.kind ?? input.kind ?? undefined,
    authority: registryEntry?.authority ?? input.authority ?? undefined,
    tags,
    lang: registryEntry?.lang ?? normalizeOptional(input.lang),
    ecosystem: registryEntry?.ecosystem ?? normalizeOptional(input.ecosystem),
    lib: registryEntry?.lib ?? normalizeOptional(input.lib),
  };
}

export function deriveDocsSourceCategoryNames(input: {
  sourceId?: string | null;
  sourceIds?: readonly string[] | null;
  category?: string | null;
  categories?: readonly string[] | null;
  language?: string | null;
}): string[] | undefined {
  const categories = new Set(normalizedFilterValues(input.category, input.categories));
  const sourceIds = normalizedSourceIdFilterValues(input.sourceId, input.sourceIds);

  for (const sourceId of sourceIds) {
    const source = lookupDocsSourceById(sourceId);
    if (source?.category) {
      categories.add(source.category);
    }
  }

  const language = normalizeOptional(input.language);
  if (language && categories.size === 0 && sourceIds.length === 0) {
    for (const source of DOCS_SOURCE_REGISTRY) {
      const normalized = normalizeDocsSourceMetadata({ sourceId: source.sourceId });
      if (normalized.language === language && normalized.category) {
        categories.add(normalized.category);
      }
    }
  }

  return categories.size > 0 ? Array.from(categories) : undefined;
}

export function listDocsSources(): DocsSourceRegistryEntry[] {
  return DOCS_SOURCE_REGISTRY.map((source) => {
    const normalized = normalizeDocsSourceMetadata({ sourceId: source.sourceId });
    return {
      ...source,
      sourceId: normalized.sourceId ?? source.sourceId,
      category: normalized.category ?? source.category,
      language: normalized.language,
      kind: normalized.kind ?? source.kind,
      authority: normalized.authority ?? source.authority,
      tags: [...normalized.tags],
      pathPrefixes: [...source.pathPrefixes],
      aliases: source.aliases ? [...source.aliases] : undefined,
      lang: normalized.lang,
      ecosystem: normalized.ecosystem,
      lib: normalized.lib,
    };
  });
}

export function matchesDocsSourceFilter(
  metadataInput: DocsSourceMetadataInput,
  filter: DocsSourceFilter
): boolean {
  const metadata = normalizeDocsSourceMetadata(metadataInput);

  if (
    !matchesAny(
      metadata.sourceId,
      normalizedSourceIdFilterValues(filter.sourceId, filter.sourceIds)
    )
  ) {
    return false;
  }

  const categoryMatches = normalizedFilterValues(filter.category, filter.categories);
  if (
    categoryMatches.length > 0 &&
    !categoryMatches.some((category) =>
      [metadata.category, metadata.sourceId].some((value) => value === category)
    )
  ) {
    return false;
  }

  if (!matchesDocsSourceLanguage(metadata, filter.language)) {
    return false;
  }

  if (filter.kind && metadata.kind !== filter.kind) {
    return false;
  }

  if (filter.authority && metadata.authority !== filter.authority) {
    return false;
  }

  const requiredTags = filter.tags?.map(normalizeIdentifier) ?? [];
  if (requiredTags.length > 0 && !requiredTags.every((tag) => metadata.tags.includes(tag))) {
    return false;
  }

  return true;
}

export function matchesDocsSourceLanguage(
  source: Pick<NormalizedDocsSourceMetadata, 'language' | 'lang'>,
  language: string | null | undefined
): boolean {
  const acceptedLanguages = normalizedLanguageValues(language);
  if (acceptedLanguages.length === 0) return true;

  const sourceLanguages = normalizedLanguageValues(source.language, source.lang);
  return acceptedLanguages.some((languageValue) => sourceLanguages.includes(languageValue));
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? normalizeIdentifier(value)
    : undefined;
}

function normalizedFilterValues(
  single?: string | null,
  multiple?: readonly string[] | null
): string[] {
  return [single, ...(multiple ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeIdentifier);
}

function normalizedSourceIdFilterValues(
  single?: string | null,
  multiple?: readonly string[] | null
): string[] {
  const canonicalValues = normalizedFilterValues(single, multiple).map(canonicalizeDocsSourceId);

  return Array.from(new Set(canonicalValues));
}

function normalizedLanguageValues(...values: Array<string | null | undefined>): string[] {
  const expanded = values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => languageAliases(normalizeIdentifier(value)));

  return Array.from(new Set(expanded));
}

function languageAliases(language: string): string[] {
  switch (language) {
    case 'ts':
    case 'typescript':
      return ['ts', 'typescript'];
    case 'js':
    case 'javascript':
      return ['js', 'javascript'];
    case 'py':
    case 'python':
      return ['py', 'python'];
    case 'golang':
    case 'go':
      return ['go', 'golang'];
    default:
      return [language];
  }
}

function matchesAny(value: string | undefined, acceptedValues: readonly string[]): boolean {
  return acceptedValues.length === 0 || (value !== undefined && acceptedValues.includes(value));
}
