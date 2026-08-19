import { DatePicker, Select } from 'antd';
import {
  OZON_PURCHASE_DATE_PRESET_OPTIONS,
  type OzonPurchaseDatePreset,
  type OzonPurchaseDateRange
} from './ozon-purchase-date-filter';

export function OzonPurchaseDateFilterControl({
  preset,
  customRange,
  onPresetChange,
  onCustomRangeChange
}: {
  preset: OzonPurchaseDatePreset;
  customRange: OzonPurchaseDateRange;
  onPresetChange: (value: OzonPurchaseDatePreset) => void;
  onCustomRangeChange: (value: OzonPurchaseDateRange) => void;
}) {
  return <>
    <Select<OzonPurchaseDatePreset>
      className="ozon-purchase-date-preset"
      aria-label="采购记录新建日期"
      value={preset}
      onChange={onPresetChange}
      options={OZON_PURCHASE_DATE_PRESET_OPTIONS}
    />
    {preset === 'CUSTOM' && <DatePicker.RangePicker
      className="ozon-purchase-date-range"
      aria-label="采购记录新建日期时间段"
      value={customRange}
      onChange={(value) => onCustomRangeChange(value as OzonPurchaseDateRange)}
      allowClear
      placeholder={['开始日期', '结束日期']}
    />}
  </>;
}
