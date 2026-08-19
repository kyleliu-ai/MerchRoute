import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export const OZON_PURCHASE_DATE_TIME_ZONE = 'Asia/Shanghai';

export type OzonPurchaseDatePreset = 'ALL' | 'TODAY' | 'YESTERDAY' | 'LAST_7_DAYS' | 'CUSTOM';
export type OzonPurchaseDateRange = [Dayjs, Dayjs] | null;
export type OzonPurchaseDateBounds = { purchaseCreatedFrom?: string; purchaseCreatedTo?: string };

export const OZON_PURCHASE_DATE_PRESET_OPTIONS: Array<{ value: OzonPurchaseDatePreset; label: string }> = [
  { value: 'ALL', label: '全部采购新建日期' },
  { value: 'TODAY', label: '当天' },
  { value: 'YESTERDAY', label: '昨天' },
  { value: 'LAST_7_DAYS', label: '近 7 天' },
  { value: 'CUSTOM', label: '时间段查询' }
];

export function ozonPurchaseCreatedDateBounds(
  preset: OzonPurchaseDatePreset,
  customRange: OzonPurchaseDateRange,
  reference: Dayjs = dayjs()
): OzonPurchaseDateBounds {
  const today = reference.tz(OZON_PURCHASE_DATE_TIME_ZONE).startOf('day');
  let range: [Dayjs, Dayjs] | undefined;
  if (preset === 'TODAY') range = [today, today.add(1, 'day')];
  if (preset === 'YESTERDAY') range = [today.subtract(1, 'day'), today];
  if (preset === 'LAST_7_DAYS') range = [today.subtract(6, 'day'), today.add(1, 'day')];
  if (preset === 'CUSTOM' && customRange) {
    range = [shanghaiCalendarDay(customRange[0]), shanghaiCalendarDay(customRange[1]).add(1, 'day')];
  }
  return range ? { purchaseCreatedFrom: range[0].toISOString(), purchaseCreatedTo: range[1].toISOString() } : {};
}

function shanghaiCalendarDay(value: Dayjs): Dayjs {
  return dayjs.tz(value.format('YYYY-MM-DD'), OZON_PURCHASE_DATE_TIME_ZONE).startOf('day');
}
