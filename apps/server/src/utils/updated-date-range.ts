import { AppError } from '@n8n-media-review/shared';

export type UpdatedDateRangeInput = { updatedFrom?: string; updatedTo?: string };
export type NormalizedUpdatedDateRange = { updatedFrom?: string; updatedTo?: string };

export function normalizeUpdatedDateRange(input: UpdatedDateRangeInput): NormalizedUpdatedDateRange {
  const updatedFrom = input.updatedFrom ? normalizeDate(input.updatedFrom, '更新日期起始时间') : undefined;
  const updatedTo = input.updatedTo ? normalizeDate(input.updatedTo, '更新日期结束时间') : undefined;
  if (updatedFrom && updatedTo && updatedFrom >= updatedTo) {
    throw new AppError('CONFIG_INVALID', '更新日期结束时间必须晚于起始时间');
  }
  return { updatedFrom, updatedTo };
}

function normalizeDate(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new AppError('CONFIG_INVALID', `${label}格式无效`);
  return parsed.toISOString();
}
