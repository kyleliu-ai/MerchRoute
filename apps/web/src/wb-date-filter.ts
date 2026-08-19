import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export const WB_UPDATED_DATE_TIME_ZONE = 'Asia/Shanghai';

export type WbUpdatedDatePreset = 'ALL' | 'TODAY' | 'YESTERDAY' | 'LAST_7_DAYS' | 'CUSTOM';
export type WbUpdatedDateRange = [Dayjs, Dayjs] | null;
export type WbUpdatedDateBounds = { updatedFrom?: string; updatedTo?: string };

export const WB_UPDATED_DATE_PRESET_OPTIONS: Array<{ value: WbUpdatedDatePreset; label: string }> = [
  { value: 'ALL', label: '全部更新日期' },
  { value: 'TODAY', label: '当天' },
  { value: 'YESTERDAY', label: '昨天' },
  { value: 'LAST_7_DAYS', label: '近 7 天' },
  { value: 'CUSTOM', label: '时间段查询' }
];

export function wbUpdatedDateBounds(
  preset: WbUpdatedDatePreset,
  customRange: WbUpdatedDateRange,
  reference: Dayjs = dayjs()
): WbUpdatedDateBounds {
  const today = reference.tz(WB_UPDATED_DATE_TIME_ZONE).startOf('day');
  let range: [Dayjs, Dayjs] | undefined;
  if (preset === 'TODAY') range = [today, today.add(1, 'day')];
  if (preset === 'YESTERDAY') range = [today.subtract(1, 'day'), today];
  if (preset === 'LAST_7_DAYS') range = [today.subtract(6, 'day'), today.add(1, 'day')];
  if (preset === 'CUSTOM' && customRange) {
    const start = shanghaiCalendarDay(customRange[0]);
    const endExclusive = shanghaiCalendarDay(customRange[1]).add(1, 'day');
    range = [start, endExclusive];
  }
  return range ? { updatedFrom: range[0].toISOString(), updatedTo: range[1].toISOString() } : {};
}

function shanghaiCalendarDay(value: Dayjs): Dayjs {
  return dayjs.tz(value.format('YYYY-MM-DD'), WB_UPDATED_DATE_TIME_ZONE).startOf('day');
}
