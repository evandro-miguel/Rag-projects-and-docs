/**
 * Canonical operator entrypoint for current-project Project RAG verification and bounded repair.
 *
 * This wrapper replaces the previous fixture-only validation script so `verify:project`
 * and related operator commands now exercise the live current-project contract path.
 *
 * Usage:
 *   bun run scripts/verify-project-index.ts
 *   bun run scripts/verify-project-index.ts contract --json
 *   bun run scripts/verify-project-index.ts repair --max-files 25
 */

import { resolveProjectRagPostgresEmbeddingConfig } from './project-rag/embeddings.js';

type Mode = 'contract' | 'repair';
const MUTATION_ACK_ENV = 'RAG_MCP_PROJECT_CURRENT_MUTATION_ACK';

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function expectedProjectEmbeddingConfig(env: NodeJS.ProcessEnv) {
  return resolveProjectRagPostgresEmbeddingConfig({
    ...env,
    PROJECT_RAG_PG_EMBEDDING_BASE_URL: undefined,
    PROJECT_RAG_PG_EMBEDDING_MODEL: undefined,
  });
}

export function assertProjectEmbeddingsSafe(
  mode: Mode,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (
    mode === 'repair' &&
    normalizeEnvValue(env.EMBEDDING_FALLBACK_ON_UNAVAILABLE)?.toLowerCase() === 'true'
  ) {
    throw new Error(
      'repair refused: EMBEDDING_FALLBACK_ON_UNAVAILABLE=true would permit test-vector fallback'
    );
  }

  const runningUnderTest =
    normalizeEnvValue(env.NODE_ENV)?.toLowerCase() === 'test' ||
    normalizeEnvValue(env.VITEST) !== undefined;
  if (
    mode === 'repair' &&
    runningUnderTest &&
    normalizeEnvValue(env.EMBEDDER_FORCE_PROVIDER) !== '1'
  ) {
    throw new Error(
      'repair refused: NODE_ENV=test or VITEST requires EMBEDDER_FORCE_PROVIDER=1 for real embeddings'
    );
  }

  if (
    normalizeEnvValue(env.DOCS_RAG_PG_LAB_EMBEDDING_BASE_URL) ||
    normalizeEnvValue(env.DOCS_RAG_PG_LAB_EMBEDDING_MODEL)
  ) {
    throw new Error(
      'repair refused: Project RAG repair must not inherit DOCS_RAG_PG_LAB_* embedding settings'
    );
  }

  const expectedConfig = expectedProjectEmbeddingConfig(env);
  const resolvedConfig = resolveProjectRagPostgresEmbeddingConfig(env);
  if (resolvedConfig.baseUrl !== expectedConfig.baseUrl) {
    throw new Error(
      `repair refused: PROJECT_RAG_PG_EMBEDDING_BASE_URL=${resolvedConfig.baseUrl} must match the Project RAG 1024D GPU lane ${expectedConfig.baseUrl}`
    );
  }
  if (resolvedConfig.model !== expectedConfig.model) {
    throw new Error(
      `repair refused: PROJECT_RAG_PG_EMBEDDING_MODEL=${resolvedConfig.model} must match the Project RAG 1024D model ${expectedConfig.model}`
    );
  }
}

export function assertProjectCurrentMutationAck(env: NodeJS.ProcessEnv = process.env): void {
  if (normalizeEnvValue(env[MUTATION_ACK_ENV]) === '1') {
    return;
  }
  throw new Error(
    `${MUTATION_ACK_ENV}=1 is required because this command registers the current project and may write Project RAG state`
  );
}

function printUsage(): void {
  console.log(`Usage: bun run scripts/verify-project-index.ts [contract|repair] [options]

Modes:
  contract   Verify current-project freshness and contract readiness (default)
  repair     Apply bounded stale-file repair using the current-project repair flow

Examples:
  bun run scripts/verify-project-index.ts
  bun run scripts/verify-project-index.ts contract --json
  bun run scripts/verify-project-index.ts repair --max-files 25 --offset 0
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const explicitMode = argv[0] === 'repair' || argv[0] === 'contract' ? argv[0] : undefined;
  const mode = explicitMode ?? 'contract';
  assertProjectEmbeddingsSafe(mode);
  assertProjectCurrentMutationAck();
  const passThroughArgs = explicitMode ? argv.slice(1) : argv;

  const child = Bun.spawn({
    cmd: ['bun', 'run', 'scripts/eval/mcp-project-current.ts', mode, ...passThroughArgs],
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await child.exited;
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
