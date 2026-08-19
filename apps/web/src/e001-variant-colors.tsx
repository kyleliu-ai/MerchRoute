import { useState } from 'react';
import { Button, Select, Tag, Tooltip, Typography } from 'antd';
import type { OzonCatalogDictionaryValue, OzonColorIdentity, ProductVariant, VariantSelectionGroup } from '@n8n-media-review/shared';
import type { WbDictionaryValue } from './api/client';

const { Text } = Typography;

export type OzonColorCatalogState = {
  loading: boolean;
  error: boolean;
  stale: boolean;
};

type Props = {
  group: VariantSelectionGroup;
  groups: VariantSelectionGroup[];
  wbItems: WbDictionaryValue[];
  wbLoading: boolean;
  wbError: boolean;
  ozonItems: OzonCatalogDictionaryValue[];
  ozonCatalog: OzonColorCatalogState;
  onChange: (groups: VariantSelectionGroup[]) => void;
  onDelete: () => void;
  canDelete: boolean;
};

export function E001VariantColorPassport({
  group,
  groups,
  wbItems,
  wbLoading,
  wbError,
  ozonItems,
  ozonCatalog,
  onChange,
  onDelete,
  canDelete
}: Props) {
  const [wbSearch, setWbSearch] = useState('');
  const [ozonSearch, setOzonSearch] = useState('');
  const selectedOzonActive = Boolean(group.ozonColor && ozonItems.some((item) => item.itemKey === group.ozonColor?.itemKey));
  const ozonOptions = filterOzonColors(ozonItems, ozonSearch, group.ozonColor?.itemKey);
  const wbOptions = wbItems.map((item) => ({
    value: item.itemKey,
    label: bilingualColorLabel(item.nameZh, item.nameRu),
    disabled: groups.some((candidate) => candidate.groupId !== group.groupId && candidate.wbColor?.colorKey === item.itemKey)
  }));

  return <div className="variant-name-editor variant-color-passport" aria-label={`当前变体 ${group.variantName || '未命名'} 的双平台颜色`}>
    <div className="variant-passport-title"><span>当前变体</span><strong>{group.variantName || '尚未选择 WB 颜色'}</strong></div>
    <div className="variant-passport-card">
      <section className="platform-color-lane is-wb">
        <div className="platform-color-heading">
          <span className="platform-color-name"><b>WB</b><strong>颜色变体</strong></span>
          <Tag color="cyan">必填</Tag>
        </div>
        {group.variantName && !group.wbColor ? <div className="platform-color-inline-warning">历史变体“{group.variantName}”尚未关联 WB 颜色，请重新选择。</div> : null}
        <Select
          className="platform-color-select"
          popupClassName="platform-color-dropdown"
          showSearch
          allowClear
          aria-label="WB 颜色变体，必填"
          value={group.wbColor?.colorKey}
          placeholder="搜索中文或俄文颜色"
          loading={wbLoading}
          status={wbError ? 'error' : undefined}
          filterOption={(input, option) => colorSearchMatch(String(input), String(option?.label || ''))}
          onSearch={setWbSearch}
          onDropdownVisibleChange={(open) => { if (!open) setWbSearch(''); }}
          notFoundContent={wbError ? '本地 WB 颜色字典不可用' : '没有匹配的颜色'}
          options={wbOptions}
          optionRender={(option) => {
            const item = wbItems.find((candidate) => candidate.itemKey === option.value);
            return item ? <BilingualColorOption nameZh={item.nameZh} nameRu={item.nameRu} platform="WB" identifier={item.wbId} query={wbSearch} /> : option.label;
          }}
          onChange={(colorKey) => {
            const item = wbItems.find((candidate) => candidate.itemKey === colorKey);
            onChange(applyWbColorChange(groups, group.groupId, item, ozonItems));
          }}
        />
        <Text type="secondary">产品变体名和媒体目录使用中文；提交 WB 时使用对应俄文颜色值。</Text>
      </section>

      <section className="platform-color-lane is-ozon">
        <div className="platform-color-heading">
          <span className="platform-color-name"><b>OZON</b><strong>颜色变体</strong></span>
          <div className="platform-color-state">{ozonColorStatusTag(group, ozonCatalog, selectedOzonActive)}</div>
          <Tag>选填</Tag>
        </div>
        <Select
          className="platform-color-select"
          popupClassName="platform-color-dropdown"
          showSearch
          allowClear
          aria-label="OZON 颜色变体，选填"
          value={group.ozonColor?.itemKey}
          placeholder="搜索 OZON 中文或俄文颜色"
          loading={ozonCatalog.loading}
          status={group.ozonColor && !ozonCatalog.loading && !ozonCatalog.error && !selectedOzonActive ? 'error' : undefined}
          filterOption={false}
          onSearch={setOzonSearch}
          onDropdownVisibleChange={(open) => { if (!open) setOzonSearch(''); }}
          notFoundContent={ozonCatalog.error ? 'OZON 本地颜色字典不可用' : '没有匹配的中文颜色'}
          options={ozonOptions.map((item) => ({ value: item.itemKey, label: bilingualColorLabel(item.nameZh, item.nameRu) }))}
          optionRender={(option) => {
            const item = ozonItems.find((candidate) => candidate.itemKey === option.value);
            return item ? <BilingualColorOption nameZh={item.nameZh} nameRu={item.nameRu} platform="OZON" identifier={item.valueId} query={ozonSearch} /> : option.label;
          }}
          onChange={(itemKey) => {
            const item = ozonItems.find((candidate) => candidate.itemKey === itemKey);
            onChange(applyOzonColorChange(groups, group.groupId, item));
          }}
        />
        {group.ozonColor && !ozonCatalog.loading && !ozonCatalog.error && !selectedOzonActive
          ? <Text className="platform-color-invalid">已选值已停用，请重新选择。</Text>
          : <Text type="secondary">选填。选择后保存到产品变体，并用于 OZON 商品颜色和颜色名称。</Text>}
        {!group.ozonColor ? <Text type="secondary">不影响 WB 审核；需要上架 OZON 时可在手动上品资料中补充。</Text> : null}
      </section>
    </div>
    <Button danger type="text" className="variant-delete-action" disabled={!canDelete} onClick={onDelete}>删除当前组</Button>
  </div>;
}

export function E001VariantGroupStatus({ group }: { group: VariantSelectionGroup }) {
  return <span className="variant-group-statuses" aria-label={variantGroupStatusLabel(group)}>
    <small className={group.wbColor ? 'is-ready' : 'is-empty'}>WB{group.wbColor ? '✓' : '—'}</small>
    <small className={group.ozonColor ? group.ozonColor.source === 'AUTO_EXACT_RU' ? 'is-auto' : 'is-ready' : 'is-empty'}>
      {group.ozonColor ? group.ozonColor.source === 'AUTO_EXACT_RU' ? '自动' : 'OZON✓' : '未设置'}
    </small>
  </span>;
}

export function variantGroupStatusLabel(group: VariantSelectionGroup): string {
  const wb = group.wbColor ? 'WB 颜色已设置' : 'WB 颜色未设置';
  const ozon = group.ozonColor
    ? group.ozonColor.source === 'AUTO_EXACT_RU' ? 'OZON 颜色自动匹配' : 'OZON 颜色人工选择'
    : 'OZON 颜色未设置，选填';
  return `${wb}，${ozon}`;
}

export function reconcileVariantOzonColors(
  groups: VariantSelectionGroup[],
  variants: ProductVariant[],
  ozonItems: OzonCatalogDictionaryValue[]
): VariantSelectionGroup[] {
  let changed = false;
  const next = groups.map((group) => {
    if (!group.wbColor || group.ozonColorSuppressed || group.ozonColor) return group;
    const persisted = variants.find((variant) => variant.wbColor?.colorKey === group.wbColor?.colorKey)?.ozonColor;
    const matched = exactOzonColorForRussianName(group.wbColor.nameRu, ozonItems);
    if (!persisted && !matched) return group;
    changed = true;
    return { ...group, ozonColor: persisted || ozonIdentity(matched!, 'AUTO_EXACT_RU'), ozonColorSuppressed: false };
  });
  return changed ? next : groups;
}

export function applyWbColorChange(
  groups: VariantSelectionGroup[],
  groupId: string,
  item: WbDictionaryValue | undefined,
  ozonItems: OzonCatalogDictionaryValue[]
): VariantSelectionGroup[] {
  const selected = item ? { colorKey: item.itemKey, nameRu: item.nameRu, nameZh: item.nameZh } : undefined;
  const changed = groups.map((group) => {
    if (group.groupId !== groupId) return group;
    const preserveManual = group.ozonColor?.source === 'MANUAL_E001' || group.ozonColor?.source === 'MANUAL_OZON';
    const autoMatch = selected && !preserveManual && !group.ozonColorSuppressed
      ? exactOzonColorForRussianName(selected.nameRu, ozonItems)
      : undefined;
    return {
      ...group,
      variantName: selected?.nameZh || '',
      wbColor: selected,
      ...(preserveManual ? { ozonColor: group.ozonColor } : autoMatch ? { ozonColor: ozonIdentity(autoMatch, 'AUTO_EXACT_RU'), ozonColorSuppressed: false } : { ozonColor: undefined })
    };
  });
  return assignClientVariantNames(changed);
}

export function applyOzonColorChange(
  groups: VariantSelectionGroup[],
  groupId: string,
  item?: OzonCatalogDictionaryValue
): VariantSelectionGroup[] {
  return groups.map((group) => group.groupId === groupId ? {
    ...group,
    ...(item ? { ozonColor: ozonIdentity(item, 'MANUAL_E001'), ozonColorSuppressed: false } : { ozonColor: undefined, ozonColorSuppressed: true })
  } : group);
}

export function exactOzonColorForRussianName(
  nameRu: string,
  items: OzonCatalogDictionaryValue[]
): OzonCatalogDictionaryValue | undefined {
  const key = normalizePlatformColorName(nameRu);
  const matches = items.filter((item) => item.nameZh.trim() && normalizePlatformColorName(item.nameRu) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

export function filterOzonColors(
  items: OzonCatalogDictionaryValue[],
  query: string,
  selectedItemKey?: string
): OzonCatalogDictionaryValue[] {
  const term = normalizePlatformColorName(query);
  const filtered = items.filter((item) => item.nameZh.trim() && (!term
    || normalizePlatformColorName(item.nameZh).includes(term)
    || normalizePlatformColorName(item.nameRu).includes(term)));
  const limited = filtered.slice(0, 30);
  const selected = selectedItemKey ? items.find((item) => item.itemKey === selectedItemKey && item.nameZh.trim()) : undefined;
  return selected && !limited.some((item) => item.itemKey === selected.itemKey) ? [selected, ...limited.slice(0, 29)] : limited;
}

export function normalizePlatformColorName(value: string): string {
  return value.trim().normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[‐‑‒–—―]/g, '-').replace(/\s+/g, ' ');
}

function ozonIdentity(item: OzonCatalogDictionaryValue, source: OzonColorIdentity['source']): OzonColorIdentity {
  return { itemKey: item.itemKey, dictionaryId: item.dictionaryId, valueId: item.valueId, nameRu: item.nameRu, nameZh: item.nameZh, source };
}

function assignClientVariantNames(groups: VariantSelectionGroup[]): VariantSelectionGroup[] {
  const counts = new Map<string, number>();
  for (const group of groups) if (group.wbColor) counts.set(group.wbColor.nameZh, (counts.get(group.wbColor.nameZh) || 0) + 1);
  return groups.map((group) => group.wbColor ? {
    ...group,
    variantName: (counts.get(group.wbColor.nameZh) || 0) > 1 ? `${group.wbColor.nameZh}（${group.wbColor.nameRu}）` : group.wbColor.nameZh
  } : group);
}

function bilingualColorLabel(nameZh: string, nameRu: string): string {
  return `${nameZh || nameRu} / ${nameRu}`;
}

function colorSearchMatch(input: string, value: string): boolean {
  return normalizePlatformColorName(value).includes(normalizePlatformColorName(input));
}

function BilingualColorOption({ nameZh, nameRu, platform, identifier, query }: {
  nameZh: string;
  nameRu: string;
  platform: 'WB' | 'OZON';
  identifier?: number;
  query: string;
}) {
  return <Tooltip title={`${nameZh} / ${nameRu}${identifier ? ` · #${identifier}` : ''}`} mouseEnterDelay={0.5}>
    <div className="platform-color-option">
      <span><strong>{highlight(nameZh || nameRu, query)}</strong><small>{highlight(nameRu, query)}</small></span>
      <em className={platform === 'OZON' ? 'is-ozon' : 'is-wb'}>{platform}{identifier ? <code>#{identifier}</code> : null}</em>
    </div>
  </Tooltip>;
}

function highlight(value: string, query: string) {
  const term = query.trim();
  if (!term) return value;
  const index = value.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + term.length)}</mark>{value.slice(index + term.length)}</>;
}

function ozonColorStatusTag(group: VariantSelectionGroup, catalog: OzonColorCatalogState, selectedActive: boolean) {
  if (catalog.stale) return <Tag color="orange">目录已过期</Tag>;
  if (catalog.error) return <Tag color="orange">目录不可用</Tag>;
  if (group.ozonColor && !catalog.loading && !catalog.error && !selectedActive) return <Tag color="error">已停用</Tag>;
  if (!group.ozonColor) return <Tag>未设置</Tag>;
  return group.ozonColor.source === 'AUTO_EXACT_RU' ? <Tag color="blue">自动匹配</Tag> : <Tag color="green">人工选择</Tag>;
}
