import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { ozonPurchaseCreatedDateBounds } from './ozon-purchase-date-filter';

describe('ozonPurchaseCreatedDateBounds', () => {
  const reference = dayjs('2026-07-27T12:30:00.000Z');

  it('builds Shanghai calendar-day bounds for the quick presets', () => {
    expect(ozonPurchaseCreatedDateBounds('TODAY', null, reference)).toEqual({
      purchaseCreatedFrom: '2026-07-26T16:00:00.000Z',
      purchaseCreatedTo: '2026-07-27T16:00:00.000Z'
    });
    expect(ozonPurchaseCreatedDateBounds('YESTERDAY', null, reference)).toEqual({
      purchaseCreatedFrom: '2026-07-25T16:00:00.000Z',
      purchaseCreatedTo: '2026-07-26T16:00:00.000Z'
    });
    expect(ozonPurchaseCreatedDateBounds('LAST_7_DAYS', null, reference)).toEqual({
      purchaseCreatedFrom: '2026-07-20T16:00:00.000Z',
      purchaseCreatedTo: '2026-07-27T16:00:00.000Z'
    });
  });

  it('uses inclusive calendar dates and an exclusive end for custom ranges', () => {
    expect(ozonPurchaseCreatedDateBounds('CUSTOM', [dayjs('2026-07-20'), dayjs('2026-07-23')], reference)).toEqual({
      purchaseCreatedFrom: '2026-07-19T16:00:00.000Z',
      purchaseCreatedTo: '2026-07-23T16:00:00.000Z'
    });
  });

  it('does not add a filter for all dates or an incomplete custom range', () => {
    expect(ozonPurchaseCreatedDateBounds('ALL', null, reference)).toEqual({});
    expect(ozonPurchaseCreatedDateBounds('CUSTOM', null, reference)).toEqual({});
  });
});
