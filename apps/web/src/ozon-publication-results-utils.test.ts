import { describe, expect, it } from 'vitest';
import type { OzonPublication } from './api/client';
import {
  isOzonPublicationActive,
  ozonPublicationActions,
  ozonPublicationCanRecheckLocally,
  ozonPublicationProducts,
  summarizeOzonPublications
} from './ozon-publication-results-utils';

function publication(patch: Partial<OzonPublication> = {}): OzonPublication {
  return {
    id: 'publication-1', sku: '0000049', generatedVersionId: 'generated-1', revision: 1,
    storeId: 'store-a', storeAliasSnapshot: 'ozon-a', storeDisplayNameSnapshot: 'OZON A 店',
    status: 'QUEUED', source: 'MANUAL', credentialBindingMode: 'VAULT', storeConfigVersion: 1,
    warehouseId: 'warehouse-a', warehouseName: '莫斯科仓',
    fulfillmentMode: 'FBS', accountCurrency: 'RUB', offerIds: ['0000049-01'],
    offerContractHash: 'sha256:offer', materializationHash: 'sha256:material', result: {},
    productIds: [], ozonSkus: [], productLinks: [], rowVersion: 1,
    createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z',
    ...patch
  };
}

describe('OZON 店铺发布结果', () => {
  it('区分活动、成功和需处理状态', () => {
    expect(isOzonPublicationActive(publication())).toBe(true);
    expect(isOzonPublicationActive(publication({ status: 'SUCCEEDED' }))).toBe(false);
    expect(summarizeOzonPublications([
      publication({ status: 'SUCCEEDED', taskId: 'task-a' }),
      publication({ id: 'publication-2', storeId: 'store-b', taskId: 'task-b' }),
      publication({ id: 'publication-3', status: 'FAILED', taskId: 'task-c' })
    ])).toMatchObject({ total: 3, succeeded: 1, active: 1, attention: 1, taskCount: 3 });
  });

  it('同 offer_id 在不同 publication 内保持各自的平台身份', () => {
    expect(ozonPublicationProducts(publication({
      productIds: ['product-a'], ozonSkus: ['sku-a'],
      productLinks: ['https://www.ozon.ru/product/product-a']
    }))).toEqual([{
      offerId: '0000049-01', productId: 'product-a', ozonSku: 'sku-a', url: 'https://www.ozon.ru/product/product-a'
    }]);
  });

  it('只按 publication 状态开放对应的独立操作', () => {
    expect(ozonPublicationActions('QUEUED')).toEqual({
      canCancel: true, canRecheck: false, canCompatibleAppend: false, canRepublish: false
    });
    expect(ozonPublicationActions('FAILED')).toEqual({
      canCancel: false, canRecheck: true, canCompatibleAppend: false, canRepublish: true
    });
    expect(ozonPublicationActions('SUCCEEDED')).toEqual({
      canCancel: false, canRecheck: false, canCompatibleAppend: true, canRepublish: true
    });
    expect(ozonPublicationActions('PLANNED')).toEqual({
      canCancel: true, canRecheck: true, canCompatibleAppend: false, canRepublish: false
    });
    expect(ozonPublicationCanRecheckLocally(publication({ status: 'NEEDS_ATTENTION', taskId: undefined }))).toBe(true);
    expect(ozonPublicationCanRecheckLocally(publication({ status: 'NEEDS_ATTENTION', taskId: 'fixed-planned-task' }))).toBe(true);
  });
});
