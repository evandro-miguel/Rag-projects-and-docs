import {
  isDocsSourceArtifactPath,
  lookupDocsSourceByPath,
  normalizeDocsSourceCanonicalKey,
} from './docs-source-registry.js';

type SearchLikeResult = {
  document?: { sourcePath?: string | null } | null;
  score?: number;
};

export function isExternalDocSourcePath(sourcePath: string): boolean {
  return lookupDocsSourceByPath(sourcePath) !== undefined;
}

export function isExternalDocArtifactSourcePath(sourcePath: string): boolean {
  return isDocsSourceArtifactPath(sourcePath);
}

export function normalizeExternalDocCanonicalKey(sourcePath: string): string {
  return normalizeDocsSourceCanonicalKey(sourcePath);
}

export function filterExternalDocResults<T extends SearchLikeResult>(results: T[]): T[] {
  return results.filter((result) => {
    const sourcePath = result.document?.sourcePath;
    return typeof sourcePath === 'string' && isExternalDocSourcePath(sourcePath);
  });
}

export function dedupeExternalDocResults<T extends SearchLikeResult>(results: T[]): T[] {
  const dedupedByKey = new Map<string, T>();

  for (const result of results) {
    const sourcePath = result.document?.sourcePath;
    if (!sourcePath) {
      continue;
    }

    const key = normalizeExternalDocCanonicalKey(sourcePath);
    const existing = dedupedByKey.get(key);
    if (!existing) {
      dedupedByKey.set(key, result);
      continue;
    }

    const existingSourcePath = existing.document?.sourcePath ?? '';
    const existingIsArtifact = isExternalDocArtifactSourcePath(existingSourcePath);
    const candidateIsArtifact = isExternalDocArtifactSourcePath(sourcePath);

    if (existingIsArtifact && !candidateIsArtifact) {
      dedupedByKey.set(key, result);
      continue;
    }

    const existingScore = existing.score ?? Number.NEGATIVE_INFINITY;
    const candidateScore = result.score ?? Number.NEGATIVE_INFINITY;
    if (existingIsArtifact === candidateIsArtifact && candidateScore > existingScore) {
      dedupedByKey.set(key, result);
    }
  }

  return Array.from(dedupedByKey.values());
}
