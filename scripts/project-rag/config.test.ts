import { describe, expect, it } from 'vitest';
import {
  resolveProjectRagPostgresConfig,
  resolveProjectRagPostgresConfigWithLocalDefault,
  resolveProjectRagPostgresWriteConfig,
} from './config.js';

describe('project-rag postgres config', () => {
  it('resolves explicit Project RAG database env first', () => {
    const config = resolveProjectRagPostgresConfig({
      PROJECT_RAG_DATABASE_URL: 'postgres://project:secret@127.0.0.1:5440/rag',
      POSTGRES_URL: 'postgres://shared:secret@127.0.0.1:5440/shared',
    });

    expect(config.tool).toBe('project-rag-postgres');
    expect(config.database.url).toBe('postgres://project:secret@127.0.0.1:5440/rag');
    expect(config.database.source).toBe('PROJECT_RAG_DATABASE_URL');
    expect(config.database.redactedUrl).toContain('project:***@');
    // Pool defaults
    expect(config.pool).toEqual({ max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 });
  });

  it('uses local default only through the local-default resolver with explicit opt-in', () => {
    expect(resolveProjectRagPostgresConfig({}).database.url).toBeUndefined();
    expect(resolveProjectRagPostgresConfig({}).pool).toEqual({
      max: 2,
      connectionTimeoutMs: 5_000,
      maxLifetimeMs: 0,
    });

    // Without PROJECT_RAG_ALLOW_LOCAL_DEFAULT=1 the resolver throws
    expect(() => resolveProjectRagPostgresConfigWithLocalDefault({})).toThrow(
      'Project RAG requires an explicit Postgres URL'
    );

    // With explicit opt-in the local default is applied
    const config = resolveProjectRagPostgresConfigWithLocalDefault({
      PROJECT_RAG_ALLOW_LOCAL_DEFAULT: '1',
    });
    expect(config.database.url).toBe('postgres://127.0.0.1:5542/docs_rag_lab');
    expect(config.database.source).toBe('override');
    expect(config.pool).toEqual({ max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 });
  });

  it('keeps invalid timeout values on the safe default', () => {
    const config = resolveProjectRagPostgresConfig({
      PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/docs_rag_lab',
      PROJECT_RAG_DB_TIMEOUT_MS: 'nope',
    });

    expect(config.healthTimeoutMs).toBe(5_000);
    expect(config.pool).toEqual({ max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 });
  });

  it('requires an explicit database URL for write operations', () => {
    expect(() => resolveProjectRagPostgresWriteConfig({})).toThrow(
      'Project RAG write operations require an explicit Postgres URL'
    );

    expect(
      resolveProjectRagPostgresWriteConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://project:secret@127.0.0.1:5440/rag',
      }).database.source
    ).toBe('PROJECT_RAG_DATABASE_URL');
  });

  describe('pool config', () => {
    it('applies pool defaults', () => {
      const config = resolveProjectRagPostgresConfig({});
      expect(config.pool).toEqual({ max: 2, connectionTimeoutMs: 5_000, maxLifetimeMs: 0 });
    });

    it('reads pool env overrides', () => {
      const config = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_POOL_MAX: '5',
        PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: '10000',
        PROJECT_RAG_DB_MAX_LIFETIME_MS: '3600000',
      });
      expect(config.pool).toEqual({
        max: 5,
        connectionTimeoutMs: 10_000,
        maxLifetimeMs: 3_600_000,
      });
    });

    it('falls back to defaults for invalid or out-of-range pool env values', () => {
      const config = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_POOL_MAX: 'nope',
        PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: '0',
        PROJECT_RAG_DB_MAX_LIFETIME_MS: '-1',
      });
      expect(config.pool.max).toBe(2);
      expect(config.pool.connectionTimeoutMs).toBe(5_000);
      expect(config.pool.maxLifetimeMs).toBe(0);
    });

    it('clamps out-of-range pool max to default', () => {
      const tooLow = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_POOL_MAX: '0',
      });
      expect(tooLow.pool.max).toBe(2);

      const tooHigh = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_POOL_MAX: '99',
      });
      expect(tooHigh.pool.max).toBe(2);
    });

    it('clamps out-of-range connection timeout to default', () => {
      const tooLow = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: '500',
      });
      expect(tooLow.pool.connectionTimeoutMs).toBe(5_000);

      const tooHigh = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: '200000',
      });
      expect(tooHigh.pool.connectionTimeoutMs).toBe(5_000);
    });

    it('clamps out-of-range max lifetime to default', () => {
      const negative = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_MAX_LIFETIME_MS: '-100',
      });
      expect(negative.pool.maxLifetimeMs).toBe(0);

      const tooLow = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_MAX_LIFETIME_MS: '30000',
      });
      expect(tooLow.pool.maxLifetimeMs).toBe(0);
    });

    it('accepts boundary pool env values', () => {
      const config = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_POOL_MAX: '64',
        PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: '1000',
        PROJECT_RAG_DB_MAX_LIFETIME_MS: '60000',
      });
      expect(config.pool.max).toBe(64);
      expect(config.pool.connectionTimeoutMs).toBe(1_000);
      expect(config.pool.maxLifetimeMs).toBe(60_000);

      const upper = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_POOL_MAX: '1',
        PROJECT_RAG_DB_CONNECTION_TIMEOUT_MS: '120000',
        PROJECT_RAG_DB_MAX_LIFETIME_MS: '86400000',
      });
      expect(upper.pool.max).toBe(1);
      expect(upper.pool.connectionTimeoutMs).toBe(120_000);
      expect(upper.pool.maxLifetimeMs).toBe(86_400_000);

      // Zero is valid for maxLifetime (unlimited)
      const zeroLifetime = resolveProjectRagPostgresConfig({
        PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        PROJECT_RAG_DB_MAX_LIFETIME_MS: '0',
      });
      expect(zeroLifetime.pool.maxLifetimeMs).toBe(0);
    });

    it('clamps out-of-range pool overrides to default', () => {
      const config = resolveProjectRagPostgresConfig(
        {
          PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        },
        { poolMax: 0, poolConnectionTimeoutMs: 500, poolMaxLifetimeMs: 30_000 }
      );
      expect(config.pool.max).toBe(2);
      expect(config.pool.connectionTimeoutMs).toBe(5_000);
      expect(config.pool.maxLifetimeMs).toBe(0);
    });

    it('accepts pool overrides via resolveProjectRagPostgresWriteConfig', () => {
      const config = resolveProjectRagPostgresWriteConfig(
        {
          PROJECT_RAG_DATABASE_URL: 'postgres://127.0.0.1:5542/rag',
        },
        { poolMax: 10 }
      );
      expect(config.pool.max).toBe(10);
    });

    it('accepts pool overrides via resolveProjectRagPostgresConfigWithLocalDefault', () => {
      const config = resolveProjectRagPostgresConfigWithLocalDefault(
        {
          PROJECT_RAG_ALLOW_LOCAL_DEFAULT: '1',
        },
        { poolConnectionTimeoutMs: 15_000, poolMaxLifetimeMs: 7_200_000 }
      );
      expect(config.pool.connectionTimeoutMs).toBe(15_000);
      expect(config.pool.maxLifetimeMs).toBe(7_200_000);
    });
  });
});
