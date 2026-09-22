/**
 * @module mcp/tests/performance/tools-performance.test
 * @description Performance tests for all 12 MCP tools.
 *
 * Tests performance metrics including:
 * - Latency (p50, p95, p99)
 * - Throughput (requests/second)
 * - Memory usage
 * - Cold vs warm start times
 *
 * Each tool has specific local handler thresholds based on its category:
 * - Search tools: p95 < 500ms (read-only, should be fast)
 * - Ingestion tools: p95 < 3000ms (write operations, acceptable latency)
 * - System tools: p95 < 100ms (health checks, must be instant)
 * - Analysis tools: p95 < 200ms (in-memory operations)
 *
 * These thresholds intentionally differ from live runtime SLOs. The canonical
 * source for both profiles is `scripts/eval/thresholds.ts`.
 *
 * @see AGENTS.md - MCP Tools (15 Tools)
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SCOPE_ACK_TOKEN } from '../../../lib/shared/project-scope-advisory.js';
import {
  MCP_HANDLER_PERFORMANCE_THRESHOLDS as PERFORMANCE_THRESHOLDS,
  MCP_TOOL_CATEGORIES as TOOL_CATEGORIES,
} from '../../../scripts/eval/thresholds.js';
import { SCRIPT_CONFIG } from '../../../scripts/lib/config.js';
import { ingestProjectRagPostgresFile } from '../../../scripts/project-rag/ingest-postgres.js';
import {
  handleAdaptDocs,
  handleGetDocument,
  handleHealthCheck,
  handleListCategories,
  handleSearchDocs,
} from '../../docs-handlers.js';
import {
  handleGetCodeMetrics,
  handleGetDeadCodeReport,
  handleIngestProjectFile,
  handleSearchInventory,
} from '../../handlers.js';
import { resetDocsRagPostgresMocks } from '../helpers/docs-rag-postgres.js';

vi.mock('../../../scripts/docs-rag/db.js', () => ({
  checkDocsRagLabDatabaseHealth: vi.fn(),
  checkDocsRagLabCorpusHealth: vi.fn(async () => ({
    status: 'healthy',
    documents: 1,
    unexpectedSourceIds: [],
    invalidPathCount: 0,
    sourcePathMismatchCount: 0,
    missingMetadataCount: 0,
    message: 'Corpus inventory is clean.',
  })),
}));
vi.mock('../../../scripts/docs-rag/store.js', () => ({
  getDocsRagLabDocumentByPath: vi.fn(),
  listDocsRagLabCategories: vi.fn(),
  searchDocsRagLab: vi.fn(),
}));
vi.mock('../../../scripts/project-rag/ingest-postgres.js', () => ({
  ingestProjectRagPostgresFile: vi.fn(),
}));

const mockIngestProjectRagPostgresFile = ingestProjectRagPostgresFile as ReturnType<typeof vi.fn>;
const RUN_LIVE_MCP_PERF = process.env.RUN_LIVE_MCP_PERF === '1';

// =============================================================================
// PERFORMANCE UTILITIES
// =============================================================================

interface PerformanceResult {
  toolName: string;
  category: string;
  iterations: number;
  latencies: number[];
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
  passed: boolean;
  failures: string[];
}

/**
 * Calculate percentile from sorted array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index];
}

/**
 * Run a performance test for a tool.
 */
async function runPerformanceTest(
  toolName: string,
  fn: () => Promise<unknown>,
  iterations: number = 10
): Promise<PerformanceResult> {
  const category = TOOL_CATEGORIES[toolName as keyof typeof TOOL_CATEGORIES] || 'search';
  const thresholds = PERFORMANCE_THRESHOLDS[category as keyof typeof PERFORMANCE_THRESHOLDS];

  const latencies: number[] = [];
  const failures: string[] = [];

  // Warmup run (not counted)
  try {
    await fn();
  } catch (error) {
    failures.push(`Warmup: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Measured runs
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      await fn();
      const latency = performance.now() - start;
      latencies.push(latency);
    } catch (error) {
      const latency = performance.now() - start;
      latencies.push(latency);
      failures.push(`Iteration ${i}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Sort for percentile calculation
  const sorted = [...latencies].sort((a, b) => a - b);

  const result: PerformanceResult = {
    toolName,
    category,
    iterations,
    latencies: sorted,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    passed: false,
    failures,
  };

  // Check thresholds
  if (result.p50 > thresholds.p50) {
    failures.push(`p50 (${result.p50.toFixed(1)}ms) > threshold (${thresholds.p50}ms)`);
  }
  if (result.p95 > thresholds.p95) {
    failures.push(`p95 (${result.p95.toFixed(1)}ms) > threshold (${thresholds.p95}ms)`);
  }
  if (result.p99 > thresholds.p99) {
    failures.push(`p99 (${result.p99.toFixed(1)}ms) > threshold (${thresholds.p99}ms)`);
  }

  result.passed = failures.length === 0;
  result.failures = failures;

  return result;
}

/**
 * Format performance result for reporting.
 */
function formatResult(result: PerformanceResult): string {
  const status = result.passed ? '✅ PASS' : '❌ FAIL';
  return `${status} ${result.toolName} (${result.category})
    p50: ${result.p50.toFixed(1)}ms (threshold: ${PERFORMANCE_THRESHOLDS[result.category as keyof typeof PERFORMANCE_THRESHOLDS].p50}ms)
    p95: ${result.p95.toFixed(1)}ms (threshold: ${PERFORMANCE_THRESHOLDS[result.category as keyof typeof PERFORMANCE_THRESHOLDS].p95}ms)
    p99: ${result.p99.toFixed(1)}ms (threshold: ${PERFORMANCE_THRESHOLDS[result.category as keyof typeof PERFORMANCE_THRESHOLDS].p99}ms)
    min: ${result.min.toFixed(1)}ms | max: ${result.max.toFixed(1)}ms | avg: ${result.avg.toFixed(1)}ms
    iterations: ${result.iterations}${result.failures.length > 0 ? `\n    failures: ${result.failures.join('; ')}` : ''}`;
}

// =============================================================================
// PERFORMANCE TESTS
// =============================================================================

describe('MCP Tools Performance Tests', () => {
  let testFilePath: string;
  let inventoryPath: string;
  let inventoryRoot: string;
  const originalInventoryPath = process.env.RAG_CODE_INVENTORY_PATH;

  beforeAll(() => {
    (SCRIPT_CONFIG as any).PROJECT_SOURCE_PATH = process.cwd();

    // Create test file for ingestion tests
    testFilePath = join(process.cwd(), 'perf-test-file.md');
    writeFileSync(testFilePath, '# Performance Test\n\nTest content for file ingestion.\n\n');

    // Create inventory file for analysis tests
    inventoryRoot = mkdtempSync(join(tmpdir(), 'rag-v1-perf-inventory-'));
    inventoryPath = join(inventoryRoot, 'code_inventory.md');
    process.env.RAG_CODE_INVENTORY_PATH = inventoryPath;
    writeFileSync(
      inventoryPath,
      `# Code Inventory

> Last updated: test fixture

### Project RAG

| ID | Status | Lines | Functions | Exports | Filepath | Description |
|----|--------|-------|-----------|---------|----------|-------------|
| 1 | [x] | 100 | 5 | 3 | \`scripts/project-rag/store.ts\` | Postgres store |
| 2 | [x] | 200 | 10 | 8 | \`mcp/project-handlers.ts\` | Project handlers |

### Docs

| ID | Status | Lines | Functions | Exports | Filepath | Description |
|----|--------|-------|-----------|---------|----------|-------------|
| 3 | [x] | 50 | 2 | 1 | \`docs/README.md\` | Documentation |
`
    );
  });

  afterAll(() => {
    // Cleanup test files
    if (existsSync(testFilePath)) {
      rmSync(testFilePath);
    }
    if (originalInventoryPath === undefined) {
      delete process.env.RAG_CODE_INVENTORY_PATH;
    } else {
      process.env.RAG_CODE_INVENTORY_PATH = originalInventoryPath;
    }
    if (inventoryRoot) {
      rmSync(inventoryRoot, { force: true, recursive: true });
    }
  });

  beforeEach(() => {
    resetDocsRagPostgresMocks();
    mockIngestProjectRagPostgresFile.mockReset();
    mockIngestProjectRagPostgresFile.mockResolvedValue({
      projectId: 'perf-project',
      slug: 'perf-project',
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
    });
  });

  // =========================================================================
  // DOCS RAG TOOLS (4 tools)
  // =========================================================================

  describe('Docs RAG Tools', () => {
    describe('search_docs', () => {
      it('should meet performance thresholds', async () => {
        const result = await runPerformanceTest(
          'search_docs',
          () => handleSearchDocs({ query: 'TypeScript interfaces', limit: 10 }, ['external']),
          20
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.search.p95);
      });

      it('should handle concurrent requests efficiently', async () => {
        const concurrentCount = 5;
        const start = performance.now();

        await Promise.all(
          Array(concurrentCount)
            .fill(null)
            .map(() => handleSearchDocs({ query: 'React hooks', limit: 5 }, ['external']))
        );

        const totalTime = performance.now() - start;
        const avgTime = totalTime / concurrentCount;

        console.log(
          `Concurrent search_docs: ${concurrentCount} requests in ${totalTime.toFixed(1)}ms (avg: ${avgTime.toFixed(1)}ms)`
        );
        expect(avgTime).toBeLessThan(PERFORMANCE_THRESHOLDS.search.p95);
      });
    });
    describe('get_document', () => {
      it('should meet performance thresholds', async () => {
        const result = await runPerformanceTest(
          'get_document',
          () => handleGetDocument({ sourcePath: 'bun-docs/perf/test.md' }),
          20
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.search.p95);
      });
    });

    describe('list_categories', () => {
      it('should meet performance thresholds', async () => {
        const result = await runPerformanceTest(
          'list_categories',
          () => handleListCategories(),
          20
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.system.p95);
      });
    });
  });

  // =========================================================================
  // PROJECT RAG TOOLS (3 tools)
  // =========================================================================

  describe('Project RAG Tools', () => {
    describe('ingest_project_file', () => {
      it('should meet performance thresholds for small files', async () => {
        const result = await runPerformanceTest(
          'ingest_project_file',
          () =>
            handleIngestProjectFile({
              filePath: testFilePath,
              force: true,
              scopeAck: PROJECT_SCOPE_ACK_TOKEN,
            }),
          5 // Fewer iterations for ingestion
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.ingestion.p95);
      });
    });
  });

  // =========================================================================
  // SYSTEM TOOLS (1 tool)
  // =========================================================================

  describe('System Tools', () => {
    describe('health_check', () => {
      // Explicitly classified: the live database lane is opt-in.
      it.skipIf(!RUN_LIVE_MCP_PERF)('should meet performance thresholds', async () => {
        const result = await runPerformanceTest(
          'health_check',
          () => handleHealthCheck(),
          50 // More iterations for system tools
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.system.p95);
      });

      it.skipIf(!RUN_LIVE_MCP_PERF)('should be extremely fast for health checks', async () => {
        const latencies: number[] = [];

        for (let i = 0; i < 100; i++) {
          const start = performance.now();
          await handleHealthCheck();
          latencies.push(performance.now() - start);
        }

        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const sorted = [...latencies].sort((a, b) => a - b);
        const p95 = percentile(sorted, 0.95);

        console.log(
          `health_check 100 iterations: avg=${avg.toFixed(2)}ms, p95=${p95.toFixed(2)}ms`
        );
        expect(avg).toBeLessThan(50); // Average should be under 50ms
      });
    });
  });

  // =========================================================================
  // ENHANCEMENT TOOLS (1 tool)
  // =========================================================================

  describe('Enhancement Tools', () => {
    describe('adapt_docs', () => {
      it('should meet performance thresholds (local deterministic)', async () => {
        // Note: adapt_docs now uses local deterministic extraction (Gemini retired)
        const testContent = `
# API Reference

## Getting Started

This guide will help you get started with the API.

\`\`\`typescript
const client = new Client({
  apiKey: 'your-api-key',
});

await client.connect();
\`\`\`

## Authentication

All API requests require authentication using Bearer tokens.
        `.trim();

        const result = await runPerformanceTest(
          'adapt_docs',
          () =>
            handleAdaptDocs({
              content: testContent,
              context: 'code-focused',
              maxLength: 1000,
            }),
          5 // Fewer iterations for LLM operations
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
      });
    });
  });

  // =========================================================================
  // ANALYSIS TOOLS (3 tools)
  // =========================================================================

  describe('Analysis Tools', () => {
    describe('get_code_metrics', () => {
      it('should meet performance thresholds', async () => {
        const result = await runPerformanceTest(
          'get_code_metrics',
          () => handleGetCodeMetrics(),
          20
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.analysis.p95);
      });

      it('should handle category filter efficiently', async () => {
        const result = await runPerformanceTest(
          'get_code_metrics',
          () => handleGetCodeMetrics({ category: 'Project RAG' }),
          20
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.analysis.p95);
      });
    });

    describe('search_inventory', () => {
      it('should meet performance thresholds', async () => {
        const result = await runPerformanceTest(
          'search_inventory',
          () => handleSearchInventory({ pattern: 'project-rag', limit: 20 }),
          20
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.analysis.p95);
      });

      it('should handle large result sets efficiently', async () => {
        const result = await runPerformanceTest(
          'search_inventory',
          () => handleSearchInventory({ pattern: '', limit: 100 }),
          10
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.analysis.p99);
      });
    });

    describe('get_dead_code_report', () => {
      it('should meet performance thresholds', async () => {
        const result = await runPerformanceTest(
          'get_dead_code_report',
          () => handleGetDeadCodeReport({ includeUnreviewed: true }),
          20
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.analysis.p95);
      });

      it('should handle filters efficiently', async () => {
        const result = await runPerformanceTest(
          'get_dead_code_report',
          () =>
            handleGetDeadCodeReport({
              category: 'Project RAG',
              includeUnreviewed: false,
              minLines: 50,
            }),
          20
        );

        console.log(formatResult(result));
        expect(result.passed).toBe(true);
        expect(result.p95).toBeLessThan(PERFORMANCE_THRESHOLDS.analysis.p95);
      });
    });
  });

  // =========================================================================
  // PERFORMANCE SUMMARY
  // =========================================================================

  describe('Performance Summary', () => {
    it('should generate performance report', async () => {
      const results: PerformanceResult[] = [];

      // Run a quick performance check on key tools
      results.push(await runPerformanceTest('health_check', () => handleHealthCheck(), 10));
      results.push(await runPerformanceTest('list_categories', () => handleListCategories(), 10));
      results.push(await runPerformanceTest('get_code_metrics', () => handleGetCodeMetrics(), 10));
      results.push(
        await runPerformanceTest(
          'search_inventory',
          () => handleSearchInventory({ pattern: 'test', limit: 10 }),
          10
        )
      );

      console.log('\n========================================');
      console.log('PERFORMANCE SUMMARY');
      console.log('========================================\n');

      let allPassed = true;
      for (const result of results) {
        console.log(formatResult(result));
        console.log('');
        if (!result.passed) allPassed = false;
      }

      console.log('========================================');
      console.log(`Overall: ${allPassed ? '✅ ALL PASSED' : '❌ SOME FAILED'}`);
      console.log('========================================\n');

      expect(results).toHaveLength(4);
      expect(results.every((result) => result.passed)).toBe(true);
    });
  });
});

// =============================================================================
// STRESS TESTS (Optional)
// =============================================================================

describe('MCP Tools Stress Tests', () => {
  beforeEach(() => {
    resetDocsRagPostgresMocks();
  });

  describe('High Load Scenarios', () => {
    it('should handle burst of search requests', async () => {
      const burstSize = 20;
      const start = performance.now();

      const results = await Promise.all(
        Array(burstSize)
          .fill(null)
          .map((_, i) =>
            handleSearchDocs({ query: `query ${i}`, limit: 5 }, ['external']).catch((e) => ({
              error: e.message,
            }))
          )
      );

      const totalTime = performance.now() - start;
      const successCount = results.filter((r) => !('error' in r)).length;

      console.log(`Burst test: ${burstSize} requests in ${totalTime.toFixed(1)}ms`);
      console.log(
        `Success rate: ${successCount}/${burstSize} (${((successCount / burstSize) * 100).toFixed(1)}%)`
      );

      expect(successCount).toBeGreaterThan(burstSize * 0.8); // 80% success rate
    });

    it('should handle mixed concurrent operations', async () => {
      const start = performance.now();

      await Promise.all([
        handleHealthCheck(),
        handleListCategories(),
        handleSearchDocs({ query: 'test', limit: 5 }, ['external']),
        handleGetCodeMetrics(),
        handleSearchInventory({ pattern: 'test', limit: 10 }),
      ]);

      const totalTime = performance.now() - start;
      console.log(`Mixed concurrent operations completed in ${totalTime.toFixed(1)}ms`);

      expect(totalTime).toBeLessThan(2000); // All should complete within 2 seconds
    });
  });
});
