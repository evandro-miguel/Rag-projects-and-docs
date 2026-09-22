import { describe, expect, it } from 'vitest';
import { acquireProjectRagWriteFence } from './write-fence.js';

function markerTx(options: {
  readonly operationId?: string;
  readonly missingTable?: boolean;
  readonly inspectionError?: Error;
}) {
  const statements: string[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (result, part, index) => `${result}${part}${index < values.length ? '?' : ''}`,
      ''
    );
    statements.push(text);
    if (text.includes('pg_try_advisory_xact_lock_shared')) return [{ locked: true }];
    if (text.includes('to_regclass')) {
      return [
        {
          relation: options.missingTable ? null : 'public.rag_migration_maintenance',
        },
      ];
    }
    if (text.includes('from public.rag_migration_maintenance')) {
      if (options.inspectionError) throw options.inspectionError;
      return options.operationId ? [{ operation_id: options.operationId }] : [];
    }
    return [];
  }) as unknown as Bun.TransactionSQL;
  return { tx, statements };
}

describe('durable migration maintenance marker', () => {
  it('blocks a writer after shared-lock acquisition when the marker exists', async () => {
    const { tx, statements } = markerTx({ operationId: 'official-1' });

    await expect(acquireProjectRagWriteFence(tx)).rejects.toMatchObject({
      code: 'MIGRATION_LOCK_BUSY',
    });
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('pg_try_advisory_xact_lock_shared');
    expect(statements[1]).toContain('to_regclass');
    expect(statements[2]).toContain('from public.rag_migration_maintenance');
  });

  it('allows writers on databases that predate the marker relation', async () => {
    const { tx, statements } = markerTx({ missingTable: true });

    await expect(acquireProjectRagWriteFence(tx)).resolves.toBeUndefined();
    expect(statements).toHaveLength(2);
  });

  it('fails closed when marker inspection is unavailable', async () => {
    const { tx } = markerTx({ inspectionError: new Error('marker read failed') });

    await expect(acquireProjectRagWriteFence(tx)).rejects.toThrow('marker read failed');
  });

  it('retains the marker across a simulated migration connection close', async () => {
    // A new executor represents a new connection after the failed owner died.
    const reopened = markerTx({ operationId: 'official-1' });
    await expect(acquireProjectRagWriteFence(reopened.tx)).rejects.toMatchObject({
      code: 'MIGRATION_LOCK_BUSY',
    });
    expect(reopened.statements[2]).toContain('public.rag_migration_maintenance');
  });
});
