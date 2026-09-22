import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: './.tmp/vitest-env',
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: [
        'scripts/ensure-embedding-provider.ts',
        'scripts/lib/docs-corpus-readiness.ts',
        'scripts/lib/docs-readiness.ts',
        'scripts/lib/external-doc-inventory.ts',
        'scripts/lib/external-doc-quality.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        perFile: true,
        autoUpdate: false,
      },
    },
  },
});
