import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calculateProjectContentHash } from '../../scripts/lib/project-content-hash.js';
import type { ProjectIndexedFileRecord } from './project-freshness.js';
import {
  assessProjectFileFreshness,
  summarizeProjectFreshness,
  summarizeProjectScopeCoverage,
} from './project-freshness.js';

function createIndexedFile(
  overrides: Partial<ProjectIndexedFileRecord> = {}
): ProjectIndexedFileRecord {
  return {
    _id: 'file-id',
    _creationTime: Date.now(),
    projectId: 'project-id',
    sourcePath: 'src/example.ts',
    absolutePath: '/tmp/project-freshness-test/src/example.ts',
    contentHash: 'hash',
    fileModifiedAt: Date.now(),
    sizeBytes: 0,
    status: 'indexed',
    metadataQuality: 'full',
    updatedAt: Date.now(),
    ...overrides,
  };
}

const TEMP_ROOT = '/tmp/project-freshness-test';

afterEach(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe('project freshness', () => {
  it('classifies matching content with changed mtime as metadata drift', async () => {
    const sourcePath = 'src/example.ts';
    const absolutePath = join(TEMP_ROOT, sourcePath);
    const content = 'export const value = 1;\n';

    mkdirSync(join(TEMP_ROOT, 'src'), { recursive: true });
    writeFileSync(absolutePath, content);

    const file = createIndexedFile({
      sourcePath,
      absolutePath,
      contentHash: await calculateProjectContentHash(content),
      fileModifiedAt: Math.floor(statSync(absolutePath).mtimeMs) + 1_000,
      sizeBytes: content.length,
    });

    const freshness = await assessProjectFileFreshness(TEMP_ROOT, file);

    expect(freshness.status).toBe('fresh_with_metadata_drift');
    expect(freshness.reason).toBe('mtime_changed_but_hash_matches');
  });

  it('classifies changed content as stale', async () => {
    const sourcePath = 'src/example.ts';
    const absolutePath = join(TEMP_ROOT, sourcePath);
    const indexedContent = 'export const value = 1;\n';
    const currentContent = 'export const value = 2;\n';

    mkdirSync(join(TEMP_ROOT, 'src'), { recursive: true });
    writeFileSync(absolutePath, currentContent);

    const file = createIndexedFile({
      sourcePath,
      absolutePath,
      contentHash: await calculateProjectContentHash(indexedContent),
      fileModifiedAt: Math.floor(statSync(absolutePath).mtimeMs) - 1_000,
      sizeBytes: currentContent.length,
    });

    const freshness = await assessProjectFileFreshness(TEMP_ROOT, file);

    expect(freshness.status).toBe('stale');
    expect(freshness.reason).toBe('content_hash_mismatch');
  });

  it('treats pending files with active ready versions as freshness-eligible', async () => {
    const sourcePath = 'src/versioned.ts';
    const absolutePath = join(TEMP_ROOT, sourcePath);
    const content = 'export const versioned = true;\n';

    mkdirSync(join(TEMP_ROOT, 'src'), { recursive: true });
    writeFileSync(absolutePath, content);

    const file = createIndexedFile({
      sourcePath,
      absolutePath,
      contentHash: await calculateProjectContentHash(content),
      fileModifiedAt: Math.floor(statSync(absolutePath).mtimeMs),
      status: 'pending',
      activeVersionId: 'version-id',
      latestVersionId: 'version-id',
    });

    const summary = await summarizeProjectFreshness(TEMP_ROOT, [file], {
      [file._id.toString()]: {
        hasVersionMetadata: true,
        activeVersionIsReady: true,
        activeVersionCompatibilityStatus: 'indexed',
      },
    });

    expect(summary.eligibleFiles).toBe(1);
    expect(summary.freshFiles).toBe(1);
    expect(summary.versionSignals?.filesWithVersionMetadata).toBe(1);
    expect(summary.versionSignals?.filesWithActiveReadyVersion).toBe(1);
  });

  it('reports legacy indexed rows as backfill-pending compatibility signals', async () => {
    const file = createIndexedFile({
      sourcePath: 'legacy/migrate.ts',
      absolutePath: '/tmp/project-freshness-test/legacy/migrate.ts',
      status: 'indexed',
      activeVersionId: undefined,
      latestVersionId: undefined,
    });

    const summary = await summarizeProjectFreshness(TEMP_ROOT, [file]);

    expect(summary.versionSignals?.filesPendingVersionBackfill).toBe(1);
    expect(summary.versionSignals?.filesUsingLegacyStatusRead).toBe(1);
  });

  it('reports missing expected files, extra indexed files, and ignored paths separately', async () => {
    const projectRoot = join(TEMP_ROOT, 'coverage');
    const appFile = join(projectRoot, 'src', 'app.ts');
    const helperFile = join(projectRoot, 'src', 'nested', 'helper.py');
    const ignoredFile = join(projectRoot, 'src', 'ignored.test.ts');

    mkdirSync(join(projectRoot, 'src', 'nested'), { recursive: true });
    writeFileSync(appFile, 'export const app = true;\n');
    writeFileSync(helperFile, 'def helper():\n  return True\n');
    writeFileSync(ignoredFile, 'export const ignored = true;\n');

    const indexedFiles: ProjectIndexedFileRecord[] = [
      createIndexedFile({
        sourcePath: 'src/app.ts',
        absolutePath: appFile,
      }),
      createIndexedFile({
        sourcePath: 'src/old.ts',
        absolutePath: join(projectRoot, 'src', 'old.ts'),
      }),
      createIndexedFile({
        sourcePath: 'src/ignored.test.ts',
        absolutePath: ignoredFile,
      }),
    ];

    const coverage = await summarizeProjectScopeCoverage(projectRoot, indexedFiles, {
      includeRoots: ['src'],
      ignoreRules: ['**/*.test.ts'],
    });

    expect(coverage.status).toBe('drift');
    expect(coverage.expectedFiles).toBe(2);
    expect(coverage.missingExpectedFiles).toBe(1);
    expect(coverage.extraIndexedFiles).toBe(1);
    expect(coverage.ignoredExpectedFiles).toBe(1);
    expect(coverage.ignoredIndexedFiles).toBe(1);
    expect(coverage.missingExpectedPaths).toContain('src/nested/helper.py');
    expect(coverage.extraIndexedPaths).toContain('src/old.ts');
    expect(coverage.ignoredExpectedPaths).toContain('src/ignored.test.ts');
    expect(coverage.ignoredIndexedPaths).toContain('src/ignored.test.ts');
  });

  it('keeps docs and test source files in scope while excluding generated artifacts', async () => {
    const projectRoot = join(TEMP_ROOT, 'source-guidance');
    const docFile = join(projectRoot, 'docs', 'guide.md');
    const testFile = join(projectRoot, 'tests', 'unit', 'feature.test.ts');
    const reportFile = join(projectRoot, 'tests', 'reports', 'feature-report.md');
    const snapshotFile = join(projectRoot, 'tests', '__snapshots__', 'feature.md');

    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    mkdirSync(join(projectRoot, 'tests', 'unit'), { recursive: true });
    mkdirSync(join(projectRoot, 'tests', 'reports'), { recursive: true });
    mkdirSync(join(projectRoot, 'tests', '__snapshots__'), { recursive: true });
    writeFileSync(docFile, '# Guidance\n');
    writeFileSync(
      testFile,
      'import { expect, it } from "vitest";\nit("documents behavior", () => expect(true).toBe(true));\n'
    );
    writeFileSync(reportFile, '# Generated report\n');
    writeFileSync(snapshotFile, 'snapshot output\n');

    const coverage = await summarizeProjectScopeCoverage(projectRoot, [], {
      includeRoots: ['docs', 'tests'],
    });

    expect(coverage.status).toBe('drift');
    expect(coverage.expectedFiles).toBe(2);
    expect(coverage.ignoredExpectedFiles).toBe(2);
    expect(coverage.missingExpectedPaths).toEqual(['docs/guide.md', 'tests/unit/feature.test.ts']);
    expect(coverage.ignoredExpectedPaths).toContain('tests/reports/feature-report.md');
    expect(coverage.ignoredExpectedPaths).toContain('tests/__snapshots__/feature.md');
  });

  it('returns unverified scope coverage when include roots are missing', async () => {
    const coverage = await summarizeProjectScopeCoverage('/tmp/project-freshness-test', [], {
      includeRoots: [],
    });

    expect(coverage.status).toBe('unverified');
    expect(coverage.reason).toBe('missing_include_roots');
  });
});
