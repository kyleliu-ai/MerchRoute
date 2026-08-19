import { DatePicker, Select } from 'antd';
import {
  WB_UPDATED_DATE_PRESET_OPTIONS,
  type WbUpdatedDatePreset,
  type WbUpdatedDateRange
} from './wb-date-filter';

export function WbUpdatedDateFilterControl({
  preset,
  customRange,
  onPresetChange,
  onCustomRangeChange
}: {
  preset: WbUpdatedDatePreset;
  customRange: WbUpdatedDateRange;
  onPresetChange: (value: WbUpdatedDatePreset) => void;
  onCustomRangeChange: (value: WbUpdatedDateRange) => void;
}) {
  return <>
    <Select<WbUpdatedDatePreset>
      className="wb-updated-date-preset"
      aria-label="更新日期"
      value={preset}
      onChange={onPresetChange}
      options={WB_UPDATED_DATE_PRESET_OPTIONS}
    />
    {preset === 'CUSTOM' && <DatePicker.RangePicker
      className="wb-updated-date-range"
      aria-label="更新日期时间段"
      value={customRange}
      onChange={(value) => onCustomRangeChange(value as WbUpdatedDateRange)}
      allowClear
      placeholder={['开始日期', '结束日期']}
    />}
  </>;
}
