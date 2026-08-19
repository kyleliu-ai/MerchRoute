import type { OzonStore, OzonStoreCreate, OzonStoreUpdate } from './api/client';

export type OzonStoreReadinessStep = {
  key: 'credential' | 'identity' | 'warehouse' | 'ready';
  label: string;
  ready: boolean;
  detail: string;
};

export type OzonAutoJobIdentity = { storeId: string; jobId: string };

export const DEFAULT_OZON_STORE_ACCOUNT_CURRENCY: OzonStore['accountCurrency'] = 'CNY';

type OzonStoreEditorDraft = {
  storeAlias: string;
  displayName: string;
  defaultPresetId?: string | null;
  autoPublishEnabled?: boolean;
  autoPublishMode: OzonStore['autoPublishMode'];
  warehouseId?: string;
  fulfillmentMode: OzonStore['fulfillmentMode'];
  accountCurrency: OzonStore['accountCurrency'];
  maxDailyStyles?: number | null;
};

export function buildOzonStoreCreateInput(values: OzonStoreEditorDraft): OzonStoreCreate {
  return {
    storeAlias: values.storeAlias.trim(),
    displayName: values.displayName.trim(),
    defaultPresetId: values.defaultPresetId || null,
    autoPublishEnabled: Boolean(values.autoPublishEnabled),
    autoPublishMode: values.autoPublishMode,
    warehouseId: values.warehouseId?.trim() || '',
    warehouseName: '',
    fulfillmentMode: values.fulfillmentMode,
    accountCurrency: values.accountCurrency,
    maxDailyStyles: Number(values.maxDailyStyles || 100)
  };
}

export function buildOzonStoreUpdateInput(
  values: OzonStoreEditorDraft,
  rowVersion: number
): OzonStoreUpdate {
  return {
    displayName: values.displayName.trim(),
    defaultPresetId: values.defaultPresetId || null,
    autoPublishEnabled: Boolean(values.autoPublishEnabled),
    autoPublishMode: values.autoPublishMode,
    warehouseId: values.warehouseId?.trim() || '',
    fulfillmentMode: values.fulfillmentMode,
    accountCurrency: values.accountCurrency,
    maxDailyStyles: Number(values.maxDailyStyles || 100),
    rowVersion
  };
}

export function ozonStoreCredentialCanPreflight(store: Pick<OzonStore, 'credential'>) {
  return (store.credential.state === 'ACTIVE'
      && store.credential.configured
      && Boolean(store.credential.activeVersionId))
    || (store.credential.state === 'PENDING' && Boolean(store.credential.pendingVersionId));
}

export function ozonStoreReadinessSteps(store: OzonStore): OzonStoreReadinessStep[] {
  const credentialReady = store.credential.state === 'ACTIVE'
    && store.credential.configured
    && Boolean(store.credential.activeVersionId);
  const credentialCanPreflight = ozonStoreCredentialCanPreflight(store);
  // The server readiness contract treats a PASSED preflight plus a resolved
  // Seller identity as authoritative. Ozon may return no enumerable role
  // labels even though the same preflight has verified the account.
  const identityReady = Boolean(store.seller.id && store.preflight.status === 'PASSED');
  const warehouseReady = Boolean(store.warehouseId && store.accountCurrency && store.preflight.currencyVerified);
  const finalReady = store.readiness.ready && credentialReady && identityReady && warehouseReady;
  const currencyDetail = store.preflight.currencyVerification === 'DEFERRED_EMPTY_CATALOG'
    ? `${store.accountCurrency || '币种待确认'} · 空店铺，首次价格回读时验证`
    : store.preflight.currencyVerified
      ? `${store.accountCurrency || '币种已确认'} · OZON 已验证`
      : store.accountCurrency || '币种尚未验证';
  return [
    {
      key: 'credential',
      label: '双凭据',
      ready: credentialReady,
      detail: credentialReady
        ? store.credential.fingerprint || `凭据 V${store.credential.version || 1}`
        : store.credential.state === 'PENDING' && store.credential.pendingVersionId
          ? `${store.credential.fingerprint || '新凭据'} · 待连接检查激活`
        : store.credential.state === 'LEGACY_EXTERNAL'
          ? '旧凭据待迁移到 Vault'
          : '需要录入 Client-Id 与 Api-Key'
    },
    {
      key: 'identity',
      label: 'Seller / 权限',
      ready: identityReady,
      detail: store.seller.name || store.seller.id || (credentialCanPreflight ? '等待连接检查' : '需要先配置凭据')
    },
    {
      key: 'warehouse',
      label: '仓库 / 币种',
      ready: warehouseReady,
      detail: store.warehouseId
        ? `${store.warehouseName || store.warehouseId} · ${currencyDetail}`
        : '尚未选择默认仓库'
    },
    {
      key: 'ready',
      label: '可上品',
      ready: finalReady,
      detail: finalReady ? '检查通过' : store.readiness.blockers[0] || '等待完成配置'
    }
  ];
}

export function summarizeOzonStores(stores: readonly OzonStore[]) {
  const current = stores.filter((store) => !store.archivedAt);
  return {
    total: current.length,
    enabled: current.filter((store) => store.enabled).length,
    ready: current.filter((store) => store.enabled
      && ozonStoreReadinessSteps(store).every((step) => step.ready)).length,
    runningTasks: current.reduce((sum, store) => sum + store.taskLoad.running, 0),
    queuedTasks: current.reduce((sum, store) => sum + store.taskLoad.queued, 0)
  };
}

export function defaultManualOzonStoreIds(stores: readonly OzonStore[]): string[] {
  const ready = stores.filter((store) => !store.archivedAt
    && store.enabled
    && store.readiness.ready
    && store.preflight.currencyVerified);
  return ready.length === 1 ? [ready[0]!.id] : [];
}

export function ozonAutoJobKey(identity: OzonAutoJobIdentity) {
  return `${identity.storeId}:${identity.jobId}`;
}

export function sameOzonAutoJob(
  identity: OzonAutoJobIdentity,
  selected?: OzonAutoJobIdentity
) {
  return Boolean(selected && identity.storeId === selected.storeId && identity.jobId === selected.jobId);
}
