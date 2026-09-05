import { describe, expect, it } from 'vitest';
import { ozonDuplicateCardNotice } from './ozon-retry';

describe('OZON retry duplicate-card view', () => {
  it('renders the permanent blocker with failed and conflicting Offers', () => {
    expect(ozonDuplicateCardNotice({
      blockerCode: 'OZON_DUPLICATE_PRODUCT_CARD',
      blockedOffers: [{
        offerId: '0000171-01',
        errorCodes: ['SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT'],
        platformMessage: 'duplicate',
        conflictOfferIds: ['0000143-01']
      }]
    })).toEqual({
      title: '商品卡重复',
      description: 'OZON 判定 0000171-01 与已有商品卡 0000143-01 类似或重复。请在 OZON 后台处理后同步平台状态，或取消自动任务。'
    });
  });

  it('does not show the duplicate-card notice for retryable plans', () => {
    expect(ozonDuplicateCardNotice({ blockerCode: undefined, blockedOffers: [] })).toBeUndefined();
  });
});
