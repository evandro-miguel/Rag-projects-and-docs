import { describe, expect, it } from 'vitest';
import { planProjectRegistryMigration } from './project-registry-migration.js';

describe('project-registry-migration', () => {
  it('flags synthetic rows for backfill and expired ephemeral rows for cleanup', () => {
    const plan = planProjectRegistryMigration(
      [
        {
          _id: 'manual-1',
          name: 'rag-v1',
          slug: 'rag-v1',
          rootPath: '/repos/rag-v1',
          origin: 'manual',
          ephemeral: false,
        },
        {
          _id: 'fixture-1',
          name: 'fixture-ts-service',
          slug: 'fixture-ts-service',
          rootPath: '/repos/fixture-ts-service',
          includeRoots: ['src'],
          expiresAt: Date.now() - 10,
        },
      ],
      Date.now()
    );

    expect(plan.backfillCount).toBe(1);
    expect(plan.expiredCount).toBe(1);
    expect(plan.entries.find((entry) => entry.projectId === 'fixture-1')).toMatchObject({
      origin: 'fixture',
      ephemeral: true,
      needsBackfill: true,
      isExpiredEphemeral: true,
    });
  });
});
