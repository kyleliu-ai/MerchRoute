import { describe, expect, it } from 'vitest';
import { assertIntegrationSchemaBoundary, guardedIntegrationDatabaseUrl } from './integration-database-guard.js';

describe('integration database guard', () => {
  it('skips safely when no dedicated test database is configured', () => {
    expect(guardedIntegrationDatabaseUrl({ purpose: 'WB 清理队列' })).toBeUndefined();
  });

  it('rejects a production-looking database and the exact production identity', () => {
    expect(() => guardedIntegrationDatabaseUrl({
      purpose: 'WB 清理队列',
      testDatabaseUrl: 'postgresql://tester@127.0.0.1/n8n_media_review'
    })).toThrow('数据库名明确包含 test');
    expect(() => guardedIntegrationDatabaseUrl({
      purpose: 'WB 清理队列',
      testDatabaseUrl: 'postgresql://tester@127.0.0.1/merchroute_test',
      productionDatabaseUrl: 'postgresql://tester@127.0.0.1/merchroute_test'
    })).toThrow('不得与 DATABASE_URL 指向同一数据库');
  });

  it('accepts a dedicated test database and fails closed outside the random schema', () => {
    const url = 'postgresql://tester@127.0.0.1/merchroute_wb_cleanup_test';
    expect(guardedIntegrationDatabaseUrl({
      purpose: 'WB 清理队列',
      testDatabaseUrl: url,
      productionDatabaseUrl: 'postgresql://app@127.0.0.1/n8n_media_review'
    })).toBe(url);
    expect(() => assertIntegrationSchemaBoundary('public', 'wb_cleanup_test_123', 'WB 清理队列'))
      .toThrow('隔离 schema 校验失败');
    expect(() => assertIntegrationSchemaBoundary('other_schema', 'wb_cleanup_test_123', 'WB 清理队列'))
      .toThrow('隔离 schema 校验失败');
    expect(() => assertIntegrationSchemaBoundary('wb_cleanup_test_123', 'wb_cleanup_test_123', 'WB 清理队列'))
      .not.toThrow();
  });
});
