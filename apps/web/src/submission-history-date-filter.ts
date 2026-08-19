import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export const SUBMISSION_HISTORY_TIME_ZONE = 'Asia/Shanghai';

export type SubmissionHistoryDatePreset = 'ALL' | 'TODAY' | 'YESTERDAY' | 'LAST_7_DAYS' | 'CUSTOM';
export type SubmissionHistoryDateRange = [Dayjs, Dayjs] | null;
export type SubmissionHistoryDateBounds = { completedFrom?: string; completedTo?: string };

export const SUBMISSION_HISTORY_DATE_PRESET_OPTIONS: Array<{ value: SubmissionHistoryDatePreset; label: string }> = [
  { value: 'ALL', label: '全部投递日期' },
  { value: 'TODAY', label: '当天' },
  { value: 'YESTERDAY', label: '昨天' },
  { value: 'LAST_7_DAYS', label: '近 7 天' },
  { value: 'CUSTOM', label: '时间段查询' }
];

export function submissionHistoryDateBounds(
  preset: SubmissionHistoryDatePreset,
  customRange: SubmissionHistoryDateRange,
  reference: Dayjs = dayjs()
): SubmissionHistoryDateBounds {
  const today = reference.tz(SUBMISSION_HISTORY_TIME_ZONE).startOf('day');
  let range: [Dayjs, Dayjs] | undefined;
  if (preset === 'TODAY') range = [today, today.add(1, 'day')];
  if (preset === 'YESTERDAY') range = [today.subtract(1, 'day'), today];
  if (preset === 'LAST_7_DAYS') range = [today.subtract(6, 'day'), today.add(1, 'day')];
  if (preset === 'CUSTOM' && customRange) {
    range = [shanghaiCalendarDay(customRange[0]), shanghaiCalendarDay(customRange[1]).add(1, 'day')];
  }
  return range ? { completedFrom: range[0].toISOString(), completedTo: range[1].toISOString() } : {};
}

export function submissionHistoryDateLabel(
  preset: SubmissionHistoryDatePreset,
  customRange: SubmissionHistoryDateRange
): string | undefined {
  if (preset === 'ALL') return undefined;
  if (preset === 'TODAY') return '当天';
  if (preset === 'YESTERDAY') return '昨天';
  if (preset === 'LAST_7_DAYS') return '近 7 天';
  if (!customRange) return undefined;
  return `${customRange[0].format('YYYY-MM-DD')} 至 ${customRange[1].format('YYYY-MM-DD')}`;
}

function shanghaiCalendarDay(value: Dayjs): Dayjs {
  return dayjs.tz(value.format('YYYY-MM-DD'), SUBMISSION_HISTORY_TIME_ZONE).startOf('day');
}
