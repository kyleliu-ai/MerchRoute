import { describe, expect, it } from 'vitest';
import {
  classifyOzonImportFailures,
  OZON_DUPLICATE_PRODUCT_CARD_ERROR_CODE,
  ozonErrorsAreTransient
} from './ozon-retry.js';

describe('OZON import failure classification', () => {
  it('classifies a duplicate product card as a permanent structured blocker', () => {
    expect(classifyOzonImportFailures({
      importFailures: [{
        offer_id: '0000171-01',
        errors: [{
          code: OZON_DUPLICATE_PRODUCT_CARD_ERROR_CODE,
          message: 'Карточка похожа на товар 0000143-01 в аккаунте 2466679'
        }]
      }]
    })).toEqual({
      classification: 'DUPLICATE_PRODUCT_CARD',
      blockerCode: 'OZON_DUPLICATE_PRODUCT_CARD',
      blockedOffers: [{
        offerId: '0000171-01',
        errorCodes: [OZON_DUPLICATE_PRODUCT_CARD_ERROR_CODE],
        platformMessage: 'Карточка похожа на товар 0000143-01 в аккаунте 2466679',
        conflictOfferIds: ['0000143-01']
      }]
    });
  });

  it('keeps explicitly transient failures retryable and unknown errors permanent', () => {
    expect(ozonErrorsAreTransient([{ code: 'HTTP_429' }, { code: 'SERVICE_UNAVAILABLE' }])).toBe(true);
    expect(classifyOzonImportFailures({ importFailures: [{
      offerId: '0000171-02', errors: [{ code: 'TOO_MANY_REQUESTS' }]
    }] })).toEqual({ classification: 'TRANSIENT', blockedOffers: [] });
    expect(classifyOzonImportFailures({ importFailures: [{
      offerId: '0000171-02', errors: [{ code: 'INVALID_ATTRIBUTE', message: 'invalid value' }]
    }] })).toMatchObject({ classification: 'PERMANENT', blockerCode: 'OZON_IMPORT_PERMANENT_FAILURE' });
    expect(classifyOzonImportFailures({ importFailures: [{
      offerId: '0000171-02', errors: []
    }] })).toEqual({
      classification: 'PERMANENT',
      blockedOffers: [{
        offerId: '0000171-02', errorCodes: ['OZON_IMPORT_FAILED'], platformMessage: '', conflictOfferIds: []
      }]
    });
  });
});
