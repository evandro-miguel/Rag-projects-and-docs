/**
 * @module read-deadline-coverage.test
 * @description Verifies that EVERY read-only MCP tool is wrapped by
 * `withReadDeadline` (T-01 hardening) while write/mutation tools remain
 * unwrapped.
 *
 * Strategy: set a tiny `MCP_READ_TIMEOUT_MS=1`, load a fresh
 * `tool-registry.js` module, and point every handler mock at a promise that
 * never resolves.  Wrapped read tools must reject promptly with
 * `ReadDeadlineError` (`READ_DEADLINE_EXCEEDED`).  Write tools must still
 * reach their handler and succeed even when the handler outlives the budget,
 * proving they are not deadline-wrapped.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Shared hoisted handler mocks so the factories stay self-contained and the
// same function instances survive vi.resetModules().
const h = vi.hoisted(() => {
  const hang = (): Promise<never> => new Promise<never>(() => {});
  // Typed as vitest Mock (any-arity) so tests may swap in resolving
  // implementations despite the never-resolving default seed.
  const mk = (): Mock => vi.fn(hang);
  return {
    docs: {
      handleSearchDocs: mk(),
      handleListCategories: mk(),
      handleHealthCheck: mk(),
      handleEnsureReranker: mk(),
      handleGetDocument: mk(),
      handleAdaptDocs: mk(),
      handleSearchAndAdapt: mk(),
    },
    handlers: {
      handleIngestProject: mk(),
      handleIngestProjectFile: mk(),
      handleGetCodeMetrics: mk(),
      handleSearchInventory: mk(),
      handleGetDeadCodeReport: mk(),
    },
    project: {
      handleSearchProjectCode: mk(),
      handleGetProjectFile: mk(),
      handleGetProjectOutline: mk(),
      handleRegisterProject: mk(),
      handleVerifyProjectIndex: mk(),
      handleFindProjectSymbol: mk(),
      handleFindSymbolReferences: mk(),
      handleGetProjectSkeleton: mk(),
      handleGetSemanticClusters: mk(),
      handleGetFeatureHubs: mk(),
      handleGetNavigationPaths: mk(),
      handleGetTopicGroups: mk(),
    },
  };
});

vi.mock('../docs-handlers.js', () => h.docs);
vi.mock('../handlers.js', () => h.handlers);
vi.mock('../project-handlers.js', () => h.project);

type Dispatch = typeof import('../tool-registry.js')['dispatchMcpToolCall'];

let dispatchMcpToolCall: Dispatch;
// Imported fresh alongside tool-registry.js so instanceof matches the exact
// class instance used inside the reloaded module graph.
let FreshReadDeadlineError: typeof import('../lib/timeout.js')['ReadDeadlineError'];

/** Every registered read-only tool with its minimal valid arguments. */
const READ_TOOLS: Array<[name: string, args: Record<string, unknown>]> = [
  ['search_docs', { query: 'q' }],
  ['list_categories', {}],
  ['health_check', {}],
  ['get_document', { sourcePath: 'docs/x.md' }],
  ['adapt_docs', { content: 'c', context: 'quick-ref' }],
  ['search_and_adapt', { query: 'q', context: 'quick-ref' }],
  ['search_project_code', { projectId: 'p', query: 'q' }],
  ['search_project_docs', { projectId: 'p', query: 'q' }],
  ['get_project_file', { projectId: 'p', sourcePath: 'src/a.ts' }],
  ['get_project_outline', { projectId: 'p', sourcePath: 'src/a.ts' }],
  ['verify_project_index', { projectId: 'p' }],
  ['find_project_symbol', { projectId: 'p', symbolName: 'foo' }],
  ['find_symbol_references', { projectId: 'p', symbolName: 'foo' }],
  ['get_project_skeleton', { projectId: 'p', sourcePath: 'src/a.ts' }],
  ['get_semantic_clusters', { projectId: 'p' }],
  ['get_feature_hubs', { projectId: 'p' }],
  ['get_navigation_paths', { projectId: 'p', sourcePath: 'src/a.ts' }],
  ['get_topic_groups', { projectId: 'p' }],
];

describe('MCP read-deadline coverage (all read tools wrapped)', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.MCP_READ_TIMEOUT_MS = '1';
    process.env.MCP_PERMISSION_MODE = 'read_write';
    // Restore every handler to the never-resolving default.
    for (const group of [h.docs, h.handlers, h.project] as const) {
      for (const fn of Object.values(group)) {
        fn.mockReset();
        fn.mockImplementation(() => new Promise<never>(() => {}));
      }
    }
    const registry = await import('../tool-registry.js');
    const timeout = await import('../lib/timeout.js');
    dispatchMcpToolCall = registry.dispatchMcpToolCall;
    FreshReadDeadlineError = timeout.ReadDeadlineError;
  });

  afterEach(() => {
    delete process.env.MCP_READ_TIMEOUT_MS;
    delete process.env.MCP_PERMISSION_MODE;
  });

  it.each(
    READ_TOOLS
  )('rejects %s with ReadDeadlineError when the handler exceeds the budget', async (name, args) => {
    let caught: unknown;
    try {
      await dispatchMcpToolCall(name, args, 'all');
      expect.fail(`Expected ${name} to reject with ReadDeadlineError`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FreshReadDeadlineError);
    const deadlineError = caught as InstanceType<typeof FreshReadDeadlineError>;
    expect(deadlineError.code).toBe('READ_DEADLINE_EXCEEDED');
    expect(deadlineError.toolName).toBe(name);
    expect(deadlineError.timeoutMs).toBe(1);
    expect(deadlineError.message).toContain('Cooperative cancellation');
  });

  it('blocks write tools outright in read_only permission mode (unchanged)', async () => {
    process.env.MCP_PERMISSION_MODE = 'read_only';
    // Reload so resolveMcpPermissionMode picks up the new env value.
    ({ dispatchMcpToolCall } = await import('../tool-registry.js'));

    await expect(
      dispatchMcpToolCall(
        'ingest_project',
        { scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1' },
        'all'
      )
    ).rejects.toThrow('PERMISSION_DENIED');
    expect(h.handlers.handleIngestProject).not.toHaveBeenCalled();
  });

  it('does not wrap write tools: ingest_project succeeds even when slower than the budget', async () => {
    h.handlers.handleIngestProject.mockImplementation(async () => {
      // Outlives the 1ms MCP_READ_TIMEOUT_MS budget on purpose.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        content: [{ type: 'text', text: 'mocked ingest result' }],
        isError: false,
      };
    });

    const result = (await dispatchMcpToolCall(
      'ingest_project',
      { scopeAck: 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1' },
      'all'
    )) as { isError?: boolean };

    expect(h.handlers.handleIngestProject).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
  });

  it('does not wrap write tools: ingest_project_file succeeds even when slower than the budget', async () => {
    h.handlers.handleIngestProjectFile.mockImplementation(async () => {
      // Outlives the 1ms MCP_READ_TIMEOUT_MS budget on purpose.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        content: [{ type: 'text', text: 'mocked file ingest result' }],
        isError: false,
      };
    });

    const result = (await dispatchMcpToolCall(
      'ingest_project_file',
      { filePath: 'src/a.ts' },
      'all'
    )) as { isError?: boolean };

    expect(h.handlers.handleIngestProjectFile).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
  });

  it('does not wrap register_project: instant resolve is not a deadline error', async () => {
    h.project.handleRegisterProject.mockImplementation(async () => ({
      content: [{ type: 'text', text: 'mocked register result' }],
      isError: false,
    }));

    const result = (await dispatchMcpToolCall(
      'register_project',
      { name: 'sample-project', rootPath: '/repos/sample', includeRoots: ['src'] },
      'all'
    )) as { isError?: boolean };

    expect(h.project.handleRegisterProject).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    // The unwrapped result must be the handler payload itself, never a
    // ReadDeadlineError-shaped rejection.
    expect(JSON.stringify(result)).not.toContain('READ_DEADLINE_EXCEEDED');
  });

  it('does not wrap ensure_reranker: it resolves directly without deadline wiring', async () => {
    h.docs.handleEnsureReranker.mockImplementation(async () => ({
      content: [{ type: 'text', text: '# Reranker Service: Started\n\nStatus: OK' }],
      isError: false,
    }));

    const result = (await dispatchMcpToolCall('ensure_reranker', {}, 'all')) as {
      isError?: boolean;
    };

    expect(h.docs.handleEnsureReranker).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
  });
});
