import type { WbStore } from './api/client';

export type WbStoreReadinessStep = {
  key: 'credential' | 'identity' | 'warehouse' | 'ready';
  label: string;
  ready: boolean;
  detail: string;
};

export function wbStoreReadinessSteps(store: WbStore): WbStoreReadinessStep[] {
  const credentialReady = store.credential.configured;
  const identityReady = Boolean(store.seller.id && store.permissions.length);
  const warehouseReady = Boolean(store.warehouseId && store.accountCurrency === 'CNY');
  const currencyDetail = store.preflight.currencyVerification === 'DEFERRED_EMPTY_CATALOG'
    ? 'CNY · 空目录，首次价格回读时强制验证'
    : store.preflight.currencyVerified
      ? `${store.accountCurrency} · WB 已验证`
      : store.accountCurrency || '未识别币种';
  return [
    {
      key: 'credential',
      label: 'Token',
      ready: credentialReady,
      detail: credentialReady ? store.credential.fingerprint || '已安全保存' : '尚未配置'
    },
    {
      key: 'identity',
      label: '身份 / 权限',
      ready: identityReady,
      detail: store.seller.name || store.seller.id || (credentialReady ? '等待连接检查' : '需要先配置 Token')
    },
    {
      key: 'warehouse',
      label: '仓库 / 币种',
      ready: warehouseReady,
      detail: store.warehouseId
        ? `${store.warehouseName || store.warehouseId} · ${currencyDetail}`
        : '尚未选择仓库'
    },
    {
      key: 'ready',
      label: '可上品',
      ready: store.readiness.ready,
      detail: store.readiness.ready ? '检查通过' : store.readiness.blockers[0] || '等待完成配置'
    }
  ];
}

export function summarizeWbStores(stores: readonly WbStore[]) {
  const current = stores.filter((store) => !store.archivedAt);
  return {
    total: current.length,
    enabled: current.filter((store) => store.enabled).length,
    ready: current.filter((store) => store.enabled && store.readiness.ready).length,
    activeTasks: current.reduce((sum, store) => sum + store.activeTaskCount, 0),
    queuedTasks: current.reduce((sum, store) => sum + store.queuedTaskCount, 0)
  };
}

export function defaultManualWbStoreIds(stores: readonly WbStore[]): string[] {
  const ready = stores.filter((store) => !store.archivedAt && store.enabled && store.readiness.ready);
  return ready.length === 1 ? [ready[0]!.id] : [];
}
