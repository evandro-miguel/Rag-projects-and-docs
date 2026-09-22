/**
 * @module eval-retrieval
 * @description Retrieval evaluation script for RAG system testing.
 *
 * This script evaluates the quality of the RAG retrieval system by running
 * predefined test queries and checking if expected documents appear in the
 * top results. It uses hybrid search (vector + text) to retrieve results
 * and measures retrieval accuracy.
 *
 * **Purpose:**
 * - Validate RAG retrieval quality
 * - Test search relevance for common queries
 * - Identify gaps in knowledge base coverage
 * - Benchmark retrieval performance
 *
 * **When to run:**
 * - After ingesting new documentation
 * - Before deploying RAG changes to production
 * - When tuning search scoring parameters
 * - As part of CI/CD pipeline
 *
 * **Dependencies:**
 * - Docs RAG Postgres database with ingested data
 * - EMBEDDING_MODEL environment variable configured
 *
 * **Environment Variables:**
 * - `DOCS_RAG_PG_LAB_DATABASE_URL` - Docs RAG Postgres URL
 * - `EMBEDDING_MODEL` - Embedding model for query encoding
 *
 * **Test Cases:**
 * The script includes predefined test cases covering:
 * - Bun HTTP server routes
 * - React hooks usage
 * - Zod validation
 * - Tailwind configuration
 * - TanStack Router navigation
 *
 * **Metrics:**
 * - Pass rate: Percentage of queries returning expected docs in top 5
 * - Score distribution: Relevance scores of returned results
 * - Failure analysis: Top 3 results for failed queries
 *
 * **Workflow:**
 * 1. Connect to Docs RAG Postgres
 * 2. For each test case:
 *    - Execute Docs RAG search
 *    - Check if expected doc path appears in top 5
 *    - Record pass/fail status
 * 3. Report final accuracy percentage
 *
 * @example
 * // Run retrieval evaluation
 * bun run scripts/eval-retrieval.ts
 *
 * @example
 * // Run with custom Postgres URL
 * DOCS_RAG_PG_LAB_DATABASE_URL=postgres://user:pass@host:port/dbname bun run scripts/eval-retrieval.ts
 *
 * @see search.ts - Manual search testing script
 * @see test-scoring.ts - Scoring algorithm testing
 */

// scripts/eval-retrieval.ts
import { resolveDocsRagLabConfigWithLocalDefault } from './docs-rag/config.js';
import { searchDocsRagLab } from './docs-rag/store.js';

/**
 * Test case for retrieval evaluation.
 */
interface TestCase {
  /** Search query to test */
  query: string;
  /** Expected document path that should appear in top 5 results */
  expectedDocPath: string;
  /** Optional description of what this test validates */
  description?: string;
}

interface EvalSearchResult {
  sourcePath?: string;
  score?: number;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Test cases tailored for the currently configured external Docs RAG sources.
const TEST_CASES: TestCase[] = [
  {
    query: 'como usar Bun.serve com rotas HTTP',
    expectedDocPath: 'bun-docs/runtime/http/server',
    description: 'Busca sobre servidor HTTP no Bun',
  },
  {
    query: 'usar useEffect para conectar sistema externo',
    expectedDocPath: 'react-docs/reference/react/useeffect',
    description: 'Busca sobre useEffect no React',
  },
  {
    query: 'TypeScript handbook generics interfaces',
    expectedDocPath: 'typescript-docs',
    description: 'Documentação TypeScript',
  },
  {
    query: 'FastAPI dependency injection tutorial',
    expectedDocPath: 'fastapi-docs',
    description: 'Documentação FastAPI',
  },
  {
    query: 'learn go with tests concurrency goroutine',
    expectedDocPath: 'go-books/concurrency',
    description: 'Documentação Go',
  },
];

/**
 * Evaluate retrieval quality using predefined test cases.
 *
 * @returns {Promise<void>} Resolves when all tests complete
 *
 * @throws {Error} If Docs RAG Postgres connection fails or search errors occur
 *
 * @example
 * // Run evaluation
 * await evaluateRetrieval();
 */
async function evaluateRetrieval() {
  const config = resolveDocsRagLabConfigWithLocalDefault(process.env, { evalTopK: 20 });
  console.log(`📡 Using Docs RAG Postgres at ${config.database.redactedUrl ?? 'unconfigured'}...`);

  let passed = 0;
  let failed = 0;

  console.log('🧪 RAG Evaluation Starting...\n');

  for (const testCase of TEST_CASES) {
    try {
      console.log(`🔍 Testing: "${testCase.query}"...`);

      const result = await searchDocsRagLab(config, testCase.query, {
        limit: 20,
      });

      const results = result.results as EvalSearchResult[];
      const top5 = results.slice(0, 5);
      const foundInTop5 = top5.some((r) =>
        r.sourcePath?.toLowerCase().includes(testCase.expectedDocPath.toLowerCase())
      );

      if (foundInTop5) {
        console.log(`✅ PASS: Found "${testCase.expectedDocPath}" in top 5`);
        passed++;
      } else {
        console.log(`❌ FAIL: Expected "${testCase.expectedDocPath}" not in top 5`);
        console.log('   Top 3 results:');
        top5.slice(0, 3).forEach((r: EvalSearchResult, i: number) => {
          console.log(`     ${i + 1}. ${r.sourcePath} (Score: ${r.score?.toFixed(4) ?? 'N/A'})`);
        });
        failed++;
      }
    } catch (error) {
      console.error(`💥 Error testing "${testCase.query}":`, formatErrorMessage(error));
      failed++;
    }
    console.log('---');
  }

  console.log(
    `\n📊 FINAL RESULTS: ${passed}/${TEST_CASES.length} passed (${((passed / TEST_CASES.length) * 100).toFixed(1)}%)`
  );

  process.exit(failed > 0 ? 1 : 0);
}

evaluateRetrieval();
