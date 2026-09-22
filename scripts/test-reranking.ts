#!/usr/bin/env bun
/**
 * @module scripts/test-reranking
 * @description Test script to verify the HTTP-based reranking service works.
 *
 * This script:
 * 1. Checks if the reranking service is running
 * 2. Sends test documents to the service
 * 3. Verifies that non-zero scores are returned
 * 4. Reports success/failure
 *
 * ## Usage
 *
 * ```bash
 * # First, start the reranking service in another terminal:
 * bun run reranker:service
 *
 * # Then run this test:
 * bun run scripts/test-reranking.ts
 * ```
 */

// ============================================================================
// Configuration
// ============================================================================

export function resolveRerankingServiceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicitUrl = env.RERANKING_SERVICE_URL?.trim();
  if (explicitUrl) {
    return explicitUrl.replace(/\/+$/u, '');
  }

  const host = env.RERANKING_SERVICE_HOST?.trim() || '127.0.0.1';
  const port = env.RERANKING_SERVICE_PORT?.trim() || '3456';
  return `http://${host}:${port}`;
}

const RERANKING_SERVICE_URL = resolveRerankingServiceUrl();

// ============================================================================
// Test Data
// ============================================================================

const TEST_QUERY = 'How to create a React component with hooks';

const TEST_DOCUMENTS = [
  // Relevant documents
  'React hooks allow you to use state and other React features in functional components. useState and useEffect are the most commonly used hooks.',
  'To create a React component, define a function that returns JSX. You can use hooks like useState to manage state within the component.',
  'useEffect hook lets you perform side effects in function components. It serves the same purpose as componentDidMount, componentDidUpdate, and componentWillUnmount.',

  // Less relevant documents
  'Docker containers provide a way to package applications with all their dependencies. This ensures consistency across development and production environments.',
  'Kubernetes is an open-source container orchestration platform that automates the deployment, scaling, and management of containerized applications.',
  'PostgreSQL is a powerful, open-source relational database system. It supports both SQL and JSON querying.',
];

type JsonResponse<T> = {
  ok: boolean;
  status: number;
  data: T;
  bodyText: string;
};

export function buildCurlJsonArgs(
  url: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutSeconds?: number;
  } = {}
): string[] {
  const method = options.method ?? 'GET';
  const args = [
    'curl',
    '-sS',
    '--max-time',
    String(options.timeoutSeconds ?? 30),
    '-X',
    method,
    '-H',
    'Accept: application/json',
    '-w',
    '\n%{http_code}',
  ];

  if (options.body !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(options.body));
  }

  args.push(url);

  return args;
}

export function parseCurlJsonResponse<T>(stdout: string): JsonResponse<T> {
  const statusSeparator = stdout.lastIndexOf('\n');
  if (statusSeparator === -1) {
    throw new Error(`Invalid curl response: ${stdout}`);
  }

  const bodyText = stdout.slice(0, statusSeparator);
  const status = Number(stdout.slice(statusSeparator + 1).trim());
  if (!Number.isFinite(status)) {
    throw new Error(`Invalid HTTP status in curl response: ${stdout}`);
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    data: JSON.parse(bodyText) as T,
    bodyText,
  };
}

export async function requestJson<T>(
  url: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutSeconds?: number;
  } = {}
): Promise<JsonResponse<T>> {
  const args = buildCurlJsonArgs(url, options);

  const process = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `curl exited with code ${exitCode}`);
  }

  return parseCurlJsonResponse<T>(stdout);
}

// ============================================================================
// Test Functions
// ============================================================================

/**
 * Check if the reranking service is healthy.
 */
async function checkServiceHealth(): Promise<boolean> {
  try {
    const response = await requestJson<{ model: string }>(`${RERANKING_SERVICE_URL}/health`, {
      timeoutSeconds: 5,
    });

    if (!response.ok) {
      console.error(`❌ Health check failed with status ${response.status}`);
      return false;
    }

    const data = response.data;
    console.log(`✅ Service is healthy (model: ${data.model})`);
    return true;
  } catch (error) {
    console.error(`❌ Cannot connect to reranking service at ${RERANKING_SERVICE_URL}`);
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`\n   Make sure the service is running with:`);
    console.error(`   bun run reranker:service`);
    return false;
  }
}

/**
 * Test the reranking endpoint.
 */
async function testReranking(): Promise<boolean> {
  console.log('\n📡 Testing reranking endpoint...');
  console.log(`   Query: "${TEST_QUERY}"`);
  console.log(`   Documents: ${TEST_DOCUMENTS.length}`);

  try {
    const response = await requestJson<{
      scores: number[];
      model: string;
      processingTimeMs: number;
    }>(`${RERANKING_SERVICE_URL}/rerank`, {
      method: 'POST',
      body: {
        query: TEST_QUERY,
        documents: TEST_DOCUMENTS,
        model: 'Xenova/ms-marco-MiniLM-L-6-v2',
        quantized: true,
      },
      timeoutSeconds: 30,
    });

    if (!response.ok) {
      const errorText = response.bodyText || 'Unknown error';
      console.error(`❌ Reranking request failed: ${response.status} ${errorText}`);
      return false;
    }

    const data = response.data;

    console.log(`\n📊 Results:`);
    console.log(`   Processing time: ${data.processingTimeMs}ms`);
    console.log(`   Model: ${data.model}`);
    console.log(`   Scores count: ${data.scores.length}`);

    // Verify we got the right number of scores
    if (data.scores.length !== TEST_DOCUMENTS.length) {
      console.error(
        `❌ Score count mismatch: expected ${TEST_DOCUMENTS.length}, got ${data.scores.length}`
      );
      return false;
    }

    // Check that scores are non-zero
    const nonZeroScores = data.scores.filter((s: number) => s > 0);
    if (nonZeroScores.length === 0) {
      console.error(`❌ All scores are zero - reranking is not working!`);
      return false;
    }

    // Check score range
    const minScore = Math.min(...data.scores);
    const maxScore = Math.max(...data.scores);

    if (minScore < 0 || maxScore > 1) {
      console.error(`❌ Scores out of range [0, 1]: min=${minScore}, max=${maxScore}`);
      return false;
    }

    console.log(`   Score range: ${minScore.toFixed(4)} - ${maxScore.toFixed(4)}`);
    console.log(`   Non-zero scores: ${nonZeroScores.length}/${data.scores.length}`);

    // Display ranked results
    console.log(`\n📋 Ranked Results:`);
    const ranked = TEST_DOCUMENTS.map((doc, i) => ({
      doc: `${doc.substring(0, 60)}...`,
      score: data.scores[i],
    })).sort((a, b) => b.score - a.score);

    for (let i = 0; i < ranked.length; i++) {
      const item = ranked[i];
      if (item) {
        console.log(`   ${i + 1}. [${item.score.toFixed(4)}] ${item.doc}`);
      }
    }

    // Verify that relevant documents rank higher
    // Documents 0-2 are React-related, 3-5 are not
    const avgRelevantScore = (data.scores[0] + data.scores[1] + data.scores[2]) / 3;
    const avgIrrelevantScore = (data.scores[3] + data.scores[4] + data.scores[5]) / 3;

    console.log(`\n📈 Relevance Analysis:`);
    console.log(`   Average score (relevant docs 1-3): ${avgRelevantScore.toFixed(4)}`);
    console.log(`   Average score (irrelevant docs 4-6): ${avgIrrelevantScore.toFixed(4)}`);

    if (avgRelevantScore > avgIrrelevantScore) {
      console.log(`   ✅ Relevant documents score higher (good!)`);
    } else {
      console.log(`   ⚠️  Irrelevant documents score higher (model may need tuning)`);
    }

    return true;
  } catch (error) {
    console.error(
      `❌ Reranking test failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Reranking Service Test');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Service URL: ${RERANKING_SERVICE_URL}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Check service health
  console.log('🔍 Checking service health...');
  const healthy = await checkServiceHealth();

  if (!healthy) {
    console.error('\n❌ Test failed: Service is not healthy');
    process.exit(1);
  }

  // Test reranking
  const success = await testReranking();

  console.log('\n═══════════════════════════════════════════════════════════');
  if (success) {
    console.log('  ✅ TEST PASSED: Reranking service is working correctly');
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(0);
  } else {
    console.log('  ❌ TEST FAILED: Reranking service has issues');
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}
