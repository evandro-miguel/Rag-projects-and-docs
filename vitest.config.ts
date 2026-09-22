import { configDefaults, defineConfig } from 'vitest/config';

const isBunRuntime = process.versions.bun !== undefined;

export default defineConfig({
  // Avoid loading repository .env files during tests. In agent/sandbox sessions
  // those files can be intentionally unreadable, and tests should set explicit
  // env values instead of depending on local secrets.
  envDir: './.tmp/vitest-env',
  test: {
    environment: 'node',
    // Bun-runtime suites share disposable Postgres lanes; serialize their
    // files so activity assertions cannot observe a sibling suite's query.
    fileParallelism: isBunRuntime ? false : undefined,
    setupFiles: ['./vitest.setup.ts'],
    // Set environment variables before any tests or modules load
    // Short timeout for reranker health checks in tests to avoid 5s delays
    // when the reranker service is not available
    env: {
      RERANKING_HEALTH_TIMEOUT_MS: '100',
    },
    exclude: [
      ...configDefaults.exclude,
      '.agent/**',
      '.worktree/**',
      '.tmp/**',
      'tmp/**',
      'ingest/source/external/**',
    ],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['mcp/**/*.ts', 'lib/**/*.ts'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'coverage/**',
        '.worktree/**',
        '**/*.d.ts',
        '**/*.config.ts',
        'lib/**/*.test.ts',
        '**/tests/**',
        // Exclude lib/tests/mocks - mock utilities are not tested directly
        'lib/tests/mocks/**',
        // Exclude pure re-export files - they contain no executable code
        '**/index.ts',
        '**/*reexport*.ts',
        '**/*re-export*.ts',
        // Exclude type definition files
        '**/*.types.ts',
        '**/types.ts',
        // Exclude test fixtures
        '**/fixtures/**',
        '**/seeders.ts',
      ],
      thresholds: {
        // 100% coverage enforcement for all new code
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
        // Per-file thresholds (can be used to allow lower coverage for specific files during transition)
        autoUpdate: false,
      },
    },
  },
});
