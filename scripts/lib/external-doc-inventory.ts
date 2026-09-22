import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import {
  assessExternalDocContent,
  type ExternalDocQualityAssessment,
} from './external-doc-quality.js';

export interface ExternalDocFileEntry {
  readonly rawFile: string;
  readonly relativePath: string;
}

export interface AssessedExternalDocFileEntry extends ExternalDocFileEntry {
  readonly sourcePath: string;
  readonly quality: ExternalDocQualityAssessment;
}

export function filterExternalDocEntries(
  entries: readonly ExternalDocFileEntry[]
): ExternalDocFileEntry[] {
  return entries.filter((entry) => {
    try {
      return lstatSync(entry.rawFile).isFile();
    } catch {
      return false;
    }
  });
}

export function classifyExternalDocEntries(
  entries: readonly ExternalDocFileEntry[],
  sourceName: string,
  prepareContent: (content: string, sourcePath: string) => string
): {
  eligible: AssessedExternalDocFileEntry[];
  excluded: AssessedExternalDocFileEntry[];
} {
  const assessed = filterExternalDocEntries(entries).flatMap((entry) => {
    const sourcePath = `${sourceName}/${entry.relativePath.replaceAll('\\', '/')}`;
    const preparedContent = prepareContent(readFileSync(entry.rawFile, 'utf-8'), sourcePath);
    return [
      {
        ...entry,
        sourcePath,
        // Cached output cannot establish that the current source is retrievable.
        // Its hash parity is checked later by processFile before cache reuse.
        quality: assessExternalDocContent(preparedContent),
      },
    ];
  });
  return {
    eligible: assessed.filter(({ quality }) => quality.valid),
    excluded: assessed.filter(({ quality }) => !quality.valid),
  };
}

function resolveGeneratedArtifact(
  processedRoot: string,
  sourceName: string,
  relativePath: string
): string {
  if (
    isAbsolute(relativePath) ||
    normalize(relativePath)
      .split(/[\\/]/u)
      .some((segment) => segment === '..')
  ) {
    throw new Error(`Refusing unsafe generated Docs artifact path: ${relativePath}`);
  }
  const processedRootPath = resolve(processedRoot);
  if (existsSync(processedRootPath)) {
    const canonicalProcessedRoot = realpathSync(processedRootPath);
    if (
      canonicalProcessedRoot !== processedRootPath ||
      lstatSync(processedRootPath).isSymbolicLink()
    ) {
      throw new Error(`Refusing generated Docs artifact through symlinked processed root`);
    }
  }
  const sourceRoot = resolve(processedRootPath, sourceName);
  const sourceRootRelative = relative(processedRootPath, sourceRoot);
  if (
    sourceRootRelative === '' ||
    sourceRootRelative === '..' ||
    sourceRootRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(sourceRootRelative)
  ) {
    throw new Error(`Refusing unsafe generated Docs source root: ${sourceName}`);
  }
  const candidate = resolve(join(sourceRoot, relativePath));
  const relativeCandidate = relative(sourceRoot, candidate);
  if (
    relativeCandidate === '' ||
    relativeCandidate === '..' ||
    relativeCandidate.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`Refusing generated Docs artifact outside source root: ${relativePath}`);
  }

  // Lexical checks do not protect against a symlinked source directory or an
  // intermediate symlink in the artifact path. Resolve the existing physical
  // path before allowing deletion so rmSync cannot escape processedRoot.
  if (existsSync(sourceRoot)) {
    const physicalSourceRoot = realpathSync(sourceRoot);
    if (lstatSync(sourceRoot).isSymbolicLink()) {
      throw new Error(
        `Refusing generated Docs artifact through symlinked source root: ${sourceName}`
      );
    }
    if (existsSync(candidate)) {
      const physicalCandidate = realpathSync(candidate);
      const physicalRelative = relative(physicalSourceRoot, physicalCandidate);
      if (
        physicalRelative === '' ||
        physicalRelative === '..' ||
        physicalRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(physicalRelative)
      ) {
        throw new Error(`Refusing generated Docs artifact outside source root: ${relativePath}`);
      }
    }
  }
  return candidate;
}

export function removeGeneratedExternalDocArtifacts(
  processedRoot: string,
  sourceName: string,
  relativePaths: readonly string[]
): string[] {
  const removed: string[] = [];
  for (const relativePath of relativePaths) {
    const artifactPath = resolveGeneratedArtifact(processedRoot, sourceName, relativePath);
    if (!existsSync(artifactPath)) continue;
    rmSync(artifactPath);
    removed.push(relativePath);
  }
  return removed;
}
