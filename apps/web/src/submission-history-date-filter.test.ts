import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { submissionHistoryDateBounds, submissionHistoryDateLabel } from './submission-history-date-filter';

describe('submission history completed date filter', () => {
  const reference = dayjs('2026-07-29T06:30:00.000Z');

  it('uses Asia/Shanghai natural-day boundaries for quick presets', () => {
    expect(submissionHistoryDateBounds('TODAY', null, reference)).toEqual({
      completedFrom: '2026-07-28T16:00:00.000Z',
      completedTo: '2026-07-29T16:00:00.000Z'
    });
    expect(submissionHistoryDateBounds('YESTERDAY', null, reference)).toEqual({
      completedFrom: '2026-07-27T16:00:00.000Z',
      completedTo: '2026-07-28T16:00:00.000Z'
    });
    expect(submissionHistoryDateBounds('LAST_7_DAYS', null, reference)).toEqual({
      completedFrom: '2026-07-22T16:00:00.000Z',
      completedTo: '2026-07-29T16:00:00.000Z'
    });
  });

  it('includes both selected custom calendar days with an exclusive upper bound', () => {
    const range = [dayjs('2026-07-20'), dayjs('2026-07-23')] as [dayjs.Dayjs, dayjs.Dayjs];
    expect(submissionHistoryDateBounds('CUSTOM', range, reference)).toEqual({
      completedFrom: '2026-07-19T16:00:00.000Z',
      completedTo: '2026-07-23T16:00:00.000Z'
    });
    expect(submissionHistoryDateLabel('CUSTOM', range)).toBe('2026-07-20 至 2026-07-23');
  });

  it('does not add bounds for all dates or an incomplete custom range', () => {
    expect(submissionHistoryDateBounds('ALL', null, reference)).toEqual({});
    expect(submissionHistoryDateBounds('CUSTOM', null, reference)).toEqual({});
    expect(submissionHistoryDateLabel('ALL', null)).toBeUndefined();
  });
});
