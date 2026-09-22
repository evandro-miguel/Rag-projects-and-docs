import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ProjectFixtureManifest, ProjectFixtureValidationReport } from './types.js';

function walkFiles(rootDir: string, currentDir = rootDir): string[] {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(rootDir, absolutePath));
      continue;
    }
    files.push(relative(rootDir, absolutePath).replace(/\\/g, '/'));
  }
  return files.sort();
}

export function resolveFixtureRoot(
  fixture: ProjectFixtureManifest,
  baseDir: string = process.cwd()
): string {
  return join(baseDir, fixture.repoRoot);
}

export function validateProjectFixtureManifest(
  fixture: ProjectFixtureManifest,
  baseDir: string = process.cwd()
): ProjectFixtureValidationReport {
  const repoRoot = resolveFixtureRoot(fixture, baseDir);
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    return {
      fixtureId: fixture.id,
      repoRoot,
      missingIndexedPaths: [...fixture.inventory.indexedPaths],
      missingBlockedPaths: [...(fixture.inventory.blockedPaths ?? [])],
      missingDegradedPaths: [...(fixture.inventory.degradedPaths ?? [])],
      missingExpectedTargetPaths: fixture.scenarios.flatMap((scenario) =>
        scenario.expectedTargets.map((target) => target.path)
      ),
      missingForbiddenTargetPaths: fixture.scenarios.flatMap((scenario) =>
        (scenario.forbiddenTargets ?? []).map((target) => target.path)
      ),
      untrackedFiles: [],
      valid: false,
    };
  }

  const repoFiles = walkFiles(repoRoot);
  const trackedPaths = new Set<string>();

  const missingIndexedPaths = fixture.inventory.indexedPaths.filter((filePath) => {
    trackedPaths.add(filePath);
    return !repoFiles.includes(filePath);
  });
  const missingBlockedPaths = (fixture.inventory.blockedPaths ?? []).filter((filePath) => {
    trackedPaths.add(filePath);
    return !repoFiles.includes(filePath);
  });
  const missingDegradedPaths = (fixture.inventory.degradedPaths ?? []).filter((filePath) => {
    trackedPaths.add(filePath);
    return !repoFiles.includes(filePath);
  });

  const missingExpectedTargetPaths = fixture.scenarios.flatMap((scenario) =>
    scenario.expectedTargets
      .filter((target) => {
        trackedPaths.add(target.path);
        return !repoFiles.includes(target.path);
      })
      .map((target) => target.path)
  );

  const missingForbiddenTargetPaths = fixture.scenarios.flatMap((scenario) =>
    (scenario.forbiddenTargets ?? [])
      .filter((target) => {
        trackedPaths.add(target.path);
        return !repoFiles.includes(target.path);
      })
      .map((target) => target.path)
  );

  const untrackedFiles = repoFiles.filter((filePath) => !trackedPaths.has(filePath));

  return {
    fixtureId: fixture.id,
    repoRoot,
    missingIndexedPaths,
    missingBlockedPaths,
    missingDegradedPaths,
    missingExpectedTargetPaths,
    missingForbiddenTargetPaths,
    untrackedFiles,
    valid:
      missingIndexedPaths.length === 0 &&
      missingBlockedPaths.length === 0 &&
      missingDegradedPaths.length === 0 &&
      missingExpectedTargetPaths.length === 0 &&
      missingForbiddenTargetPaths.length === 0,
  };
}

export function validateAllProjectFixtures(
  fixtures: ProjectFixtureManifest[],
  baseDir: string = process.cwd()
) {
  return fixtures.map((fixture) => validateProjectFixtureManifest(fixture, baseDir));
}
