import { describe, expect, it } from 'vitest';
import type { OzonStore } from './api/client';
import {
  buildOzonStoreCreateInput,
  buildOzonStoreUpdateInput,
  DEFAULT_OZON_STORE_ACCOUNT_CURRENCY,
  defaultManualOzonStoreIds,
  ozonAutoJobKey,
  ozonStoreCredentialCanPreflight,
  ozonStoreReadinessSteps,
  sameOzonAutoJob,
  summarizeOzonStores
} from './ozon-store-settings-utils';

function store(patch: Partial<OzonStore> = {}): OzonStore {
  return {
    id: 'store-a', storeAlias: 'ozon-a', displayName: 'OZON A 店', enabled: true,
    autoPublishEnabled: true, autoPublishMode: 'CREATE_ONLY', defaultPresetId: 'preset-a',
    warehouseId: 'warehouse-a', warehouseName: '莫斯科仓', fulfillmentMode: 'FBS', accountCurrency: 'RUB',
    maxDailyStyles: 100,
    credential: { state: 'ACTIVE', bindingMode: 'VAULT', configured: true, activeVersionId: 'credential-a', version: 1, fingerprint: 'ozon_•••a1' },
    seller: { id: 'seller-a', name: 'Seller A' }, permissions: ['product', 'price'], limits: {}, warehouses: [],
    preflight: { status: 'PASSED', currencyVerified: true, currencyVerification: 'VERIFIED' },
    network: { status: 'READY' }, taskLoad: { running: 0, queued: 0 },
    readiness: { ready: true, score: 100, blockers: [] }, configVersion: 1, rowVersion: 1,
    createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z',
    ...patch
  };
}

describe('OZON 多店铺前端工具', () => {
  it('创建默认使用 CNY，编辑把当前 CNY/RUB 原样提交并保留 CAS 版本', () => {
    expect(DEFAULT_OZON_STORE_ACCOUNT_CURRENCY).toBe('CNY');
    const draft = {
      storeAlias: ' tek-plus ', displayName: ' Tek+ ', defaultPresetId: null,
      autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY' as const,
      warehouseId: '', fulfillmentMode: 'FBS' as const,
      accountCurrency: DEFAULT_OZON_STORE_ACCOUNT_CURRENCY, maxDailyStyles: 100
    };

    expect(buildOzonStoreCreateInput(draft)).toEqual({
      storeAlias: 'tek-plus', displayName: 'Tek+', defaultPresetId: null,
      autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY',
      warehouseId: '', warehouseName: '', fulfillmentMode: 'FBS',
      accountCurrency: 'CNY', maxDailyStyles: 100
    });
    expect(buildOzonStoreUpdateInput({ ...draft, accountCurrency: 'RUB' }, 7)).toMatchObject({
      displayName: 'Tek+', accountCurrency: 'RUB', rowVersion: 7
    });
  });

  it('把双凭据、Seller、仓库和最终状态投影为四步准备度', () => {
    expect(ozonStoreReadinessSteps(store()).map((step) => [step.key, step.ready])).toEqual([
      ['credential', true], ['identity', true], ['warehouse', true], ['ready', true]
    ]);
    expect(ozonStoreReadinessSteps(store({
      credential: { state: 'LEGACY_EXTERNAL', bindingMode: 'PURE_LEGACY', configured: true },
      seller: {}, permissions: [], warehouseId: '',
      readiness: { ready: false, score: 0, blockers: ['需要重新录入凭据'] }
    }))[0]?.detail).toContain('待迁移');
  });

  it('预检通过且 Seller 已确认时不因权限标签为空误判为未就绪', () => {
    const verifiedWithoutPermissionLabels = store({ permissions: [] });

    expect(ozonStoreReadinessSteps(verifiedWithoutPermissionLabels).map((step) => [step.key, step.ready])).toEqual([
      ['credential', true], ['identity', true], ['warehouse', true], ['ready', true]
    ]);
    expect(ozonStoreReadinessSteps(verifiedWithoutPermissionLabels)[1]?.detail).toBe('Seller A');
  });

  it('新凭据保存为 PENDING 后可立即连接检查，但准备度显示为待验证', () => {
    const pending = store({
      credential: {
        state: 'PENDING', bindingMode: 'VAULT', configured: false,
        pendingVersionId: 'credential-pending', fingerprint: 'ozon_•••p1', version: 2
      },
      preflight: { status: 'NOT_RUN', currencyVerified: false },
      readiness: { ready: false, score: 25, blockers: ['新凭据尚未完成连接检查'] }
    });

    expect(ozonStoreCredentialCanPreflight(pending)).toBe(true);
    expect(ozonStoreReadinessSteps(pending)[0]).toMatchObject({ ready: false });
    expect(ozonStoreReadinessSteps(pending)[0]?.detail).toContain('待连接检查激活');
    expect(ozonStoreCredentialCanPreflight(store({
      credential: { state: 'MISSING', bindingMode: 'VAULT', configured: false }
    }))).toBe(false);
  });

  it('空店铺延后币种验证时不把仓库与币种步骤伪装为完成', () => {
    const deferred = store({
      preflight: {
        status: 'PASSED', currencyVerified: false,
        currencyVerification: 'DEFERRED_EMPTY_CATALOG'
      },
      // Defensive UI gate: even a stale/incorrect ready projection must not
      // preselect a store until the authoritative currency flag is true.
      readiness: { ready: true, score: 75, blockers: [] }
    });

    expect(ozonStoreReadinessSteps(deferred)[2]).toMatchObject({
      key: 'warehouse', ready: false
    });
    expect(ozonStoreReadinessSteps(deferred)[3]).toMatchObject({
      key: 'ready', ready: false
    });
    expect(ozonStoreReadinessSteps(deferred)[2]?.detail).toContain('首次价格回读时验证');
    expect(defaultManualOzonStoreIds([deferred])).toEqual([]);
  });

  it('只有一家就绪店铺时才默认选择', () => {
    expect(defaultManualOzonStoreIds([store()])).toEqual(['store-a']);
    expect(defaultManualOzonStoreIds([store(), store({ id: 'store-b', storeAlias: 'ozon-b' })])).toEqual([]);
    expect(defaultManualOzonStoreIds([store({ enabled: false })])).toEqual([]);
  });

  it('汇总时排除归档店铺并保留任务负载', () => {
    expect(summarizeOzonStores([
      store({ taskLoad: { running: 1, queued: 2 } }),
      store({ id: 'store-b', readiness: { ready: false, score: 50, blockers: ['等待检查'] } }),
      store({ id: 'store-c', archivedAt: '2026-08-11T01:00:00.000Z' })
    ])).toEqual({ total: 2, enabled: 2, ready: 1, runningTasks: 1, queuedTasks: 2 });
  });

  it('自动任务身份同时包含 storeId 与 jobId', () => {
    const selected = { storeId: 'store-b', jobId: 'job-1' };
    expect(ozonAutoJobKey(selected)).toBe('store-b:job-1');
    expect(sameOzonAutoJob({ storeId: 'store-a', jobId: 'job-1' }, selected)).toBe(false);
    expect(sameOzonAutoJob({ storeId: 'store-b', jobId: 'job-1' }, selected)).toBe(true);
  });
});
