import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRagPostgresIngestResult } from './ingest-postgres.js';
import {
  type ProjectPrepareDependencies,
  ProjectPrepareError,
  type ProjectPrepareLookupProject,
  prepareProject,
  setProjectPrepareDependenciesForTesting,
} from './prepare.js';

const ROOT = process.cwd();
const TEST_RUNTIME_ENV = {
  PROJECT_RAG_PREPARE_RUNTIME: 'test',
  PROJECT_RAG_TRUSTED_ROOTS: ROOT,
};
const RUNTIME = {
  identity: {
    lane: 'test' as const,
    owner: 'test_injected' as const,
    databaseConfigured: true,
    embedding: {
      provider: 'llamacpp',
      model: 'qwen3-embedding-1024',
      baseUrl: 'http://127.0.0.1:18082',
      dimensions: 1024,
      profileHash: 'profile',
      gpuProof: 'injected_test' as const,
      ready: true,
    },
  },
  elapsedMs: 3,
};

function ingestResult(
  overrides: Partial<ProjectRagPostgresIngestResult> = {}
): ProjectRagPostgresIngestResult {
  return {
    projectId: 'project-1',
    slug: 'journey-project',
    postgresId: 1,
    finalStatus: 'completed',
    stats: {
      filesScanned: 1,
      filesSelected: 1,
      filesIndexed: 1,
      filesBlocked: 0,
      filesDeleted: 0,
      chunksCreated: 1,
      embeddingsCreated: 1,
      errors: [],
    },
    ...overrides,
  };
}

function selectedProject(includeRoots: readonly string[] = ['src']): ProjectPrepareLookupProject {
  return {
    id: 'project-1',
    slug: 'journey-project',
    name: 'Journey Project',
    rootPath: ROOT,
    normalizedRootPath: ROOT,
    includeRoots,
  };
}

function baseDependencies(
  overrides: Partial<ProjectPrepareDependencies> = {}
): ProjectPrepareDependencies {
  return {
    lookupProject: async () => selectedProject(),
    inferIncludeRoots: async () => ['src'],
    ensureRuntime: async () => RUNTIME,
    ingest: async () => ingestResult(),
    verify: async () => ({ ok: true, gateSignal: { ready: true, blockingFailureCode: null } }),
    ...overrides,
  };
}

afterEach(() => {
  setProjectPrepareDependenciesForTesting(null);
  vi.restoreAllMocks();
});

describe('Project RAG preparation operation', () => {
  it('preserves registered scope and makes a ready warm path a no-op', async () => {
    const ingest = vi.fn(async () => ingestResult());
    const verify = vi.fn(async () => ({
      ok: true,
      gateSignal: { ready: true, blockingFailureCode: null },
    }));

    const result = await prepareProject(
      { rootPath: ROOT, project: 'project-1', runtime: { env: TEST_RUNTIME_ENV } },
      baseDependencies({ ingest, verify })
    );

    expect(result).toMatchObject({
      status: 'ready',
      ready: true,
      stage: 'ready',
      project: { id: 'project-1', slug: 'journey-project', includeRoots: ['src'], existing: true },
      runtime: RUNTIME.identity,
    });
    expect(ingest).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('infers scope for a new root, ingests bounded delta, then verifies readiness', async () => {
    let lookupCount = 0;
    const lookupProject = vi.fn(async () => {
      lookupCount += 1;
      return lookupCount === 1 ? undefined : selectedProject(['src', 'tests']);
    });
    const ingest = vi.fn(async (args) => {
      expect(args.includeRoots).toEqual(['src']);
      expect(args.maxFiles).toBe(10);
      return ingestResult();
    });
    const verify = vi.fn(async () => ({
      ok: true,
      gateSignal: { ready: true, blockingFailureCode: null },
    }));

    const result = await prepareProject(
      {
        rootPath: ROOT,
        maxFiles: 10,
        runtime: { env: TEST_RUNTIME_ENV },
      },
      baseDependencies({ lookupProject, ingest, verify })
    );

    expect(result.status).toBe('ready');
    expect(result.ready).toBe(true);
    expect(result.project.existing).toBe(true);
    expect(result.progress.indexed).toBe(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('shares concurrent preparation by root and marks the waiter deduplicated', async () => {
    let releaseRuntime: (() => void) | undefined;
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const ingest = vi.fn(async () => ingestResult());
    let lookupCount = 0;
    const dependencies = baseDependencies({
      lookupProject: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? undefined : selectedProject();
      },
      ensureRuntime: async () => {
        await runtimeGate;
        return RUNTIME;
      },
      ingest,
    });

    const first = prepareProject(
      { rootPath: ROOT, runtime: { env: TEST_RUNTIME_ENV } },
      dependencies
    );
    await Promise.resolve();
    const second = prepareProject(
      { rootPath: ROOT, runtime: { env: TEST_RUNTIME_ENV } },
      dependencies
    );
    releaseRuntime?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ready).toBe(true);
    expect(secondResult.ready).toBe(true);
    expect(firstResult.operation.deduplicated).toBe(false);
    expect(secondResult.operation.deduplicated).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('bounds a deduplicated waiter without cancelling the active owner', async () => {
    let releaseRuntime: (() => void) | undefined;
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const ingest = vi.fn(async () => ingestResult());
    const dependencies = baseDependencies({
      ensureRuntime: async () => {
        await runtimeGate;
        return RUNTIME;
      },
      ingest,
    });

    const owner = prepareProject(
      { rootPath: ROOT, project: 'project-1', timeoutMs: 500, runtime: { env: TEST_RUNTIME_ENV } },
      dependencies
    );
    await Promise.resolve();
    const startedAt = Date.now();
    const waiter = await prepareProject(
      { rootPath: ROOT, project: 'project-1', timeoutMs: 10, runtime: { env: TEST_RUNTIME_ENV } },
      dependencies
    );

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(waiter).toMatchObject({
      status: 'running',
      ready: false,
      operation: { deduplicated: true },
      reason: { code: 'PREPARATION_DEADLINE_EXCEEDED' },
    });

    releaseRuntime?.();
    await expect(owner).resolves.toMatchObject({ status: 'ready', ready: true });
    expect(ingest).toHaveBeenCalledTimes(0);
  });

  it('returns partial after a bounded batch and leaves a resumable continuation', async () => {
    const result = await prepareProject(
      { rootPath: ROOT, maxBatches: 1, runtime: { env: TEST_RUNTIME_ENV } },
      baseDependencies({
        ingest: async () =>
          ingestResult({
            finalStatus: 'partial',
            snapshotGate: {
              snapshotUuid: 'snapshot-partial',
              status: 'FAILED',
              thresholdResult:
                'partial_ingest_not_consumed: 0 file error(s), 1 operation(s) remaining',
              preflightSummary: {
                addsCount: 1,
                updatesCount: 0,
                deletesCount: 0,
                eligibleCount: 1,
                trackedCount: 1,
                totalDelta: 1,
                blockedFindingCategories: '',
              },
            },
            continuation: {
              maxFiles: 120,
              totalOperations: 2,
              remainingOperations: 1,
              remainingStalePaths: 0,
              remainingCandidateFiles: 1,
            },
          }),
        verify: async () => ({
          ok: false,
          gateSignal: { ready: false, blockingFailureCode: 'PROJECT_INDEX_EMPTY' },
        }),
      })
    );

    expect(result).toMatchObject({
      status: 'partial',
      ready: false,
      reason: { code: 'PREPARATION_DEADLINE_EXCEEDED' },
    });
    expect(result.progress.remaining).toBe(1);
  });

  it('aborts a slow claimed batch at the operation deadline before publication', async () => {
    let published = false;
    const coordinateIngest = vi.fn(async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (args.signal?.aborted) {
        throw new ProjectPrepareError(
          'PREPARATION_DEADLINE_EXCEEDED',
          'Project preparation exceeded its bounded deadline'
        );
      }
      published = true;
      return { result: ingestResult(), deduplicated: false };
    });

    const result = await prepareProject(
      { rootPath: ROOT, project: 'project-1', timeoutMs: 50, runtime: { env: TEST_RUNTIME_ENV } },
      baseDependencies({
        coordinateIngest,
        verify: async () => ({
          ok: false,
          gateSignal: { ready: false, blockingFailureCode: 'PROJECT_INDEX_EMPTY' },
        }),
      })
    );

    expect(result).toMatchObject({
      status: 'partial',
      ready: false,
      reason: { code: 'PREPARATION_DEADLINE_EXCEEDED' },
    });
    expect(coordinateIngest).toHaveBeenCalledTimes(1);
    expect(published).toBe(false);
  });

  it('surfaces a terminal snapshot gate failure instead of retrying as no progress', async () => {
    const result = await prepareProject(
      { rootPath: ROOT, project: 'project-1', runtime: { env: TEST_RUNTIME_ENV } },
      baseDependencies({
        ingest: async () =>
          ingestResult({
            finalStatus: 'partial',
            snapshotGate: {
              snapshotUuid: 'snapshot-failed',
              status: 'FAILED',
              thresholdResult: 'blocked_findings:2 blocked finding categories',
              preflightSummary: {
                addsCount: 0,
                updatesCount: 0,
                deletesCount: 0,
                eligibleCount: 0,
                trackedCount: 0,
                totalDelta: 0,
                blockedFindingCategories: 'build_dir:1 generated_dir:1',
              },
            },
          }),
        verify: async () => ({
          ok: false,
          gateSignal: { ready: false, blockingFailureCode: 'PROJECT_INDEX_EMPTY' },
        }),
      })
    );

    expect(result).toMatchObject({
      status: 'blocked',
      ready: false,
      reason: {
        code: 'SNAPSHOT_GATE_FAILED',
        details: {
          snapshotUuid: 'snapshot-failed',
          blockedFindingCategories: 'build_dir:1 generated_dir:1',
        },
      },
    });
    expect(result.reason?.message).toContain('blocked_findings:2');
  });

  it('ensures the selected runtime before querying a cold Project database', async () => {
    const order: string[] = [];
    const result = await prepareProject(
      { rootPath: ROOT, project: 'project-1', runtime: { env: TEST_RUNTIME_ENV } },
      baseDependencies({
        ensureRuntime: async () => {
          order.push('runtime');
          return RUNTIME;
        },
        lookupProject: async () => {
          order.push('lookup');
          return selectedProject();
        },
      })
    );

    expect(result.ready).toBe(true);
    expect(order).toEqual(['runtime', 'lookup']);
  });

  it('waits through a concurrent publication race instead of returning zero-progress', async () => {
    let ingestCount = 0;
    let verifyCount = 0;
    const result = await prepareProject(
      { rootPath: ROOT, project: 'project-1', maxBatches: 3, runtime: { env: TEST_RUNTIME_ENV } },
      baseDependencies({
        ingest: async () => {
          ingestCount += 1;
          return ingestResult({
            stats: {
              ...ingestResult().stats,
              filesScanned: 0,
              filesSelected: 0,
              filesIndexed: 0,
              embeddingsCreated: 0,
            },
          });
        },
        verify: async () => {
          verifyCount += 1;
          return verifyCount <= 2
            ? {
                ok: false,
                gateSignal: { ready: false, blockingFailureCode: 'PROJECT_INDEX_EMPTY' },
              }
            : { ok: true, gateSignal: { ready: true, blockingFailureCode: null } };
        },
      })
    );

    expect(result).toMatchObject({ status: 'ready', ready: true });
    expect(ingestCount).toBe(2);
    expect(result.reason).toBeUndefined();
  });

  it('rejects a root outside the configured trusted roots before preparation', async () => {
    await expect(
      prepareProject({
        rootPath: ROOT,
        runtime: {
          env: {
            ...TEST_RUNTIME_ENV,
            PROJECT_RAG_TRUSTED_ROOTS: '/workspace',
          },
        },
      })
    ).rejects.toMatchObject({ code: 'UNTRUSTED_ROOT' });
  });

  it('rejects a divergent native database context before any native seam runs', async () => {
    const ensureRuntime = vi.fn(async () => RUNTIME);
    const lookupProject = vi.fn(async () => selectedProject());
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const env = {
      ...process.env,
      PROJECT_RAG_TRUSTED_ROOTS: ROOT,
      PROJECT_RAG_DATABASE_URL: `postgres://127.0.0.1:65531/rag_v2_migration_prepare_guard_${unique}`,
      PROJECT_RAG_DATABASE_START_COMMAND: `prepare-guard-${unique}`,
    };

    await expect(
      prepareProject({ rootPath: ROOT, runtime: { env } }, { ensureRuntime, lookupProject })
    ).rejects.toMatchObject({
      code: 'RUNTIME_OWNERSHIP_CONFLICT',
      details: { divergentContext: expect.arrayContaining(['database']) },
    });
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(lookupProject).not.toHaveBeenCalled();
  });

  it('allows a same-process native context when all preparation seams are injected', async () => {
    const result = await prepareProject(
      {
        rootPath: ROOT,
        runtime: { env: { ...process.env, PROJECT_RAG_TRUSTED_ROOTS: ROOT } },
      },
      baseDependencies()
    );

    expect(result).toMatchObject({ status: 'ready', ready: true });
  });
});
