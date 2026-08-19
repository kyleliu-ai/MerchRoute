import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { wbUpdatedDateBounds } from './wb-date-filter';

describe('WB updated date filter', () => {
  const reference = dayjs('2026-07-21T16:30:00.000Z');

  it('uses Asia/Shanghai natural-day boundaries for presets', () => {
    expect(wbUpdatedDateBounds('TODAY', null, reference)).toEqual({
      updatedFrom: '2026-07-21T16:00:00.000Z',
      updatedTo: '2026-07-22T16:00:00.000Z'
    });
    expect(wbUpdatedDateBounds('YESTERDAY', null, reference)).toEqual({
      updatedFrom: '2026-07-20T16:00:00.000Z',
      updatedTo: '2026-07-21T16:00:00.000Z'
    });
    expect(wbUpdatedDateBounds('LAST_7_DAYS', null, reference)).toEqual({
      updatedFrom: '2026-07-15T16:00:00.000Z',
      updatedTo: '2026-07-22T16:00:00.000Z'
    });
  });

  it('includes both selected custom calendar days with an exclusive upper bound', () => {
    expect(wbUpdatedDateBounds('CUSTOM', [dayjs('2026-07-30'), dayjs('2026-08-02')], reference)).toEqual({
      updatedFrom: '2026-07-29T16:00:00.000Z',
      updatedTo: '2026-08-02T16:00:00.000Z'
    });
  });

  it('does not send bounds for all dates or an incomplete custom range', () => {
    expect(wbUpdatedDateBounds('ALL', null, reference)).toEqual({});
    expect(wbUpdatedDateBounds('CUSTOM', null, reference)).toEqual({});
  });
});
