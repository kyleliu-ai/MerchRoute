import { describe, expect, it } from 'vitest';
import { normalizeUpdatedDateRange } from './updated-date-range.js';

describe('updated date range validation', () => {
  it('normalizes complete and one-sided ISO ranges', () => {
    expect(normalizeUpdatedDateRange({ updatedFrom: '2026-07-21T16:00:00+00:00', updatedTo: '2026-07-22T16:00:00Z' })).toEqual({
      updatedFrom: '2026-07-21T16:00:00.000Z',
      updatedTo: '2026-07-22T16:00:00.000Z'
    });
    expect(normalizeUpdatedDateRange({ updatedFrom: '2026-07-21T16:00:00Z' })).toEqual({
      updatedFrom: '2026-07-21T16:00:00.000Z',
      updatedTo: undefined
    });
  });

  it('rejects malformed and reversed ranges', () => {
    expect(() => normalizeUpdatedDateRange({ updatedFrom: 'not-a-date' })).toThrow('更新日期起始时间格式无效');
    expect(() => normalizeUpdatedDateRange({ updatedFrom: '2026-07-22T16:00:00Z', updatedTo: '2026-07-22T16:00:00Z' })).toThrow('更新日期结束时间必须晚于起始时间');
    expect(() => normalizeUpdatedDateRange({ updatedFrom: '2026-07-23T16:00:00Z', updatedTo: '2026-07-22T16:00:00Z' })).toThrow('更新日期结束时间必须晚于起始时间');
  });
});
