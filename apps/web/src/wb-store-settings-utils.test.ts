import { describe, expect, it } from 'vitest';
import type { WbStore } from './api/client';
import { defaultManualWbStoreIds, summarizeWbStores, wbStoreReadinessSteps } from './wb-store-settings-utils';

function store(patch: Partial<WbStore> = {}): WbStore {
  return {
    id: 'store-1',
    storeAlias: 'main',
    displayName: '主店铺',
    enabled: true,
    autoPublishEnabled: true,
    autoPublishMode: 'CREATE_ONLY',
    warehouseId: '1701558',
    warehouseName: 'CEL_深圳_Activated',
    accountCurrency: 'CNY',
    maxDailyStyles: 100,
    credential: { state: 'ACTIVE', configured: true, fingerprint: 'wb_••••1234' },
    seller: { id: 'seller-1', name: '主账号' },
    permissions: ['content', 'prices', 'marketplace'],
    preflight: { status: 'PASSED', checkedAt: '2026-08-10T00:00:00.000Z' },
    network: { status: 'READY' },
    readiness: { ready: true, blockers: [] },
    activeTaskCount: 0,
    queuedTaskCount: 0,
    configVersion: 1,
    rowVersion: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...patch
  };
}

describe('WB 多店铺设置状态', () => {
  it('按 Token、身份权限、仓库币种、最终可用性生成状态轨', () => {
    expect(wbStoreReadinessSteps(store()).map((item) => ({ key: item.key, ready: item.ready }))).toEqual([
      { key: 'credential', ready: true },
      { key: 'identity', ready: true },
      { key: 'warehouse', ready: true },
      { key: 'ready', ready: true }
    ]);
    expect(wbStoreReadinessSteps(store({ accountCurrency: 'RUB', readiness: { ready: false, blockers: ['当前仅支持 CNY 店铺'] } }))[2]).toMatchObject({ ready: false });
    expect(wbStoreReadinessSteps(store({
      preflight: { status: 'PASSED', currencyVerified: false, currencyVerification: 'DEFERRED_EMPTY_CATALOG' }
    }))[2]?.detail).toContain('首次价格回读时强制验证');
  });

  it('只统计未归档店铺，并聚合运行与排队任务', () => {
    expect(summarizeWbStores([
      store({ activeTaskCount: 1, queuedTaskCount: 2 }),
      store({ id: 'store-2', enabled: false, readiness: { ready: false, blockers: ['店铺已停用'] } }),
      store({ id: 'store-3', archivedAt: '2026-08-10T01:00:00.000Z', activeTaskCount: 9 })
    ])).toEqual({ total: 2, enabled: 1, ready: 1, activeTasks: 1, queuedTasks: 2 });
  });

  it('单店就绪时为兼容旧流程自动选中，多店时要求用户明确选择', () => {
    expect(defaultManualWbStoreIds([store()])).toEqual(['store-1']);
    expect(defaultManualWbStoreIds([store(), store({ id: 'store-2', storeAlias: 'second' })])).toEqual([]);
  });
});
