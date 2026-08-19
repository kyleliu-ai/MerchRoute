import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AppstoreAddOutlined, ArrowDownOutlined, ArrowUpOutlined, CheckCircleOutlined, ClockCircleOutlined, CloudUploadOutlined, DatabaseOutlined, DeleteOutlined,
  FileTextOutlined, FolderOpenOutlined, FormOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, RocketOutlined,
  LockOutlined, SaveOutlined, SettingOutlined, SyncOutlined, TagsOutlined, ThunderboltOutlined, VideoCameraOutlined
} from '@ant-design/icons';
import {
  Alert, Badge, Button, Card, Checkbox, Col, Descriptions, Divider, Drawer, Empty, Flex, Form, Image, Input,
  InputNumber, List, message, Modal, Progress, Row, Select, Skeleton, Space, Switch, Table, Tabs, Tag,
  Tooltip, Typography
} from 'antd';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import {
  WB_DESCRIPTION_MAX_LENGTH,
  WB_PURCHASE_CHARACTERISTIC_BINDINGS,
  isWbPurchaseCharacteristicId,
  type ProductVariant,
  type WbPurchaseMeasurements
} from '@n8n-media-review/shared';
import {
  api,
  ApiError,
  type WbCatalogErrorCode,
  type WbCatalogStatus,
  type WbCategory,
  type WbCategoryFormConfig,
  type WbCategoryVersion,
  type WbCharacteristic,
  type WbDictionaryName,
  type WbDictionaryValue,
  type WbFormField,
  type WbListing,
  type WbListingStatus,
  type WbMediaAsset,
  type ProcurementVersion,
  type WbPublishingReadiness,
  type WbStorePublication,
  type WbSubject,
  type WbVariant,
  type WbVariantMedia
} from './api/client';
import { normalizeWbFormConfigCompliance, projectWbBilingualSubjectSchema, type WbSchemaProjection } from './wb-schema-projection';
import { WbPresetRegistry } from './wb-presets';
import { WbAutoPublishPanel } from './wb-automation';
import { WbStoreSettingsDrawer } from './wb-store-settings';
import { WbPublicationDialog } from './wb-publication-dialog';
import { WbPublicationResults } from './wb-publication-results';
import {
  isWbPublicationActive,
  summarizeWbPublications,
  wbManualListingRows,
  wbPublicationProductLinks,
  wbPublicationStatusMeta,
  type WbManualListingRow
} from './wb-publication-results-utils';
import { WbUpdatedDateFilterControl } from './wb-date-filter-control';
import {
  wbUpdatedDateBounds,
  type WbUpdatedDatePreset,
  type WbUpdatedDateRange
} from './wb-date-filter';
import { calculateWbDiscountAudit, decodeWbDescriptionTxt } from './wb-preset-utils';
import { CopyValueButton } from './copy-value';
import {
  applyWbMediaSuggestions,
  colorIdentityFromDictionary,
  linkVariantToProductVariant,
  WB_COLOR_CHARACTERISTIC_ID,
  withColorCharacteristic,
  type WbMediaSuggestionReport
} from './wb-media-suggestions';
import './wb-listing.css';

const { Title, Text, Paragraph } = Typography;
const WB_FIELD_DICTIONARY_ALIASES: Record<string, WbDictionaryName> = {
  countries: 'countries', seasons: 'seasons', kinds: 'kinds', genders: 'kinds', colors: 'colors'
};
const WB_FIELD_DICTIONARY_LABELS: Record<WbDictionaryName, string> = {
  countries: '原产国', seasons: '季节', kinds: '性别', colors: '颜色'
};
const DEFAULT_WB_CATEGORY_MEDIA = {
  minImages: 1,
  maxImages: 30,
  videoAllowed: true,
  defaultVideoUploadMode: 'COMPRESSED_COPY' as const
};

function normalizedWbCategoryFormConfig(input?: WbCategoryFormConfig): WbCategoryFormConfig {
  return {
    ...(input || { fields: [] }),
    fields: input?.fields || [],
    media: { ...DEFAULT_WB_CATEGORY_MEDIA, ...(input?.media || {}) }
  };
}

function patchWbCategoryMedia(
  formConfig: WbCategoryFormConfig,
  patch: Partial<NonNullable<WbCategoryFormConfig['media']>>
): WbCategoryFormConfig {
  return { ...formConfig, media: { ...DEFAULT_WB_CATEGORY_MEDIA, ...(formConfig.media || {}), ...patch } };
}

const listingStatusMeta: Record<WbListingStatus, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'gold' },
  GENERATING: { label: '生成中', color: 'processing' },
  GENERATED: { label: '文件已生成', color: 'cyan' },
  STALE: { label: '文件已过期', color: 'orange' },
  SUBMITTING: { label: '提交中', color: 'processing' },
  WAITING_NETWORK: { label: '等待网络恢复', color: 'orange' },
  QUEUED: { label: '已排队', color: 'blue' },
  RUNNING: { label: '上品中', color: 'processing' },
  SUCCEEDED: { label: '已完成', color: 'green' },
  BLOCKED: { label: '已阻塞', color: 'volcano' },
  FAILED: { label: '失败', color: 'red' },
  NEEDS_ATTENTION: { label: '需要人工处理', color: 'volcano' }
};

function listingTaskNotice(status: WbListingStatus): { type: 'error' | 'info' | 'warning'; message: string; closable: boolean } {
  if (status === 'FAILED' || status === 'BLOCKED') return { type: 'error', message: '最近一次任务失败', closable: true };
  if (status === 'WAITING_NETWORK') return { type: 'warning', message: '等待网络恢复', closable: false };
  if (status === 'NEEDS_ATTENTION') return { type: 'warning', message: '需要人工按原任务重检', closable: false };
  if (['GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING'].includes(status)) return { type: 'info', message: '当前上品进度', closable: false };
  return { type: 'warning', message: '最近一次任务提示', closable: true };
}

function renderManualPublicationLinks(row: WbManualListingRow) {
  const links = wbPublicationProductLinks(row.publication);
  if (!links.length) return <Text type="secondary">—</Text>;
  return <div className="wb-product-links">
    {links.length > 1 && <Text type="secondary">共 {links.length} 个变体</Text>}
    {links.map((link, index) => { const label = link.variantCode || `商品 ${index + 1}`; return <a
      key={link.nmId}
      className="wb-product-link mono-small"
      href={link.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`打开 SKU ${row.listing.sku} 的 WB 商品 ${label}`}
    >{label} <LinkOutlined /></a>; })}
  </div>;
}

function manualPublicationReasonCell(row: WbManualListingRow) {
  const publication = row.publication;
  const active = isWbPublicationActive(publication);
  const attention = ['FAILED', 'NEEDS_ATTENTION', 'PAUSED'].includes(publication.status);
  const messageByStatus: Record<WbStorePublication['status'], string> = {
    PLANNED: '逐店版本已冻结，等待派发',
    DISPATCHING: '正在派发不可变发布包',
    QUEUED: '已进入 WB 上品队列',
    RUNNING: '正在执行媒体、价格或库存流程',
    SUCCEEDED: '该店铺上品已完成',
    FAILED: '该店铺上品失败',
    NEEDS_ATTENTION: '该店铺任务需要人工处理',
    PAUSED: '该店铺任务已暂停'
  };
  return <div className={`wb-manual-reason${active ? ' has-progress' : attention ? ' has-error' : ''}`}>
    <span>{publication.errorMessage || messageByStatus[publication.status]}</span>
    {publication.errorCode && publication.status !== 'SUCCEEDED' && <code>{active ? '进度代码' : '错误代码'}：{publication.errorCode}</code>}
    {row.currentDraftChanged && <small>公共素材已更新；此行为上一次发布结果（D{row.publishedDraftVersion} → D{row.listing.draftVersion}）</small>}
    {row.listing.sourceMediaState === 'CLEANED' && <small>公共媒体已在成功上品后清理</small>}
    {row.listing.sourceMediaState === 'CLEANUP_PENDING' && <small>公共媒体等待安全清理</small>}
  </div>;
}

const projectionMeta = {
  NOT_SYNCED: { label: '未同步', color: 'default' },
  PENDING: { label: '待同步', color: 'gold' },
  SYNCED: { label: '已同步', color: 'green' },
  FAILED: { label: '同步失败', color: 'red' }
} as const;

const catalogStatusMeta = {
  EMPTY: { label: '尚未初始化', color: 'default', badge: 'default' },
  SYNCING: { label: '同步中', color: 'processing', badge: 'processing' },
  READY: { label: '目录可用', color: 'success', badge: 'success' },
  STALE: { label: '目录已过期', color: 'warning', badge: 'warning' },
  FAILED: { label: '同步失败', color: 'error', badge: 'error' }
} as const;

const catalogFailureCopy: Record<WbCatalogErrorCode, { title: string; description: string }> = {
  BRIDGE_NOT_CONFIGURED: { title: 'n8n WB 桥接未配置', description: '请配置 WB 自动化地址和密钥，再点击“立即同步”。' },
  WB_AUTH_FAILED: { title: 'WB Token 认证失败', description: '请检查 n8n 中 WB Seller API 凭证的有效期和 Content API 权限。' },
  WB_RATE_LIMITED: { title: 'WB 接口限频', description: '同步已被 WB 限频，请稍后再次同步；现有本地目录不会被覆盖。' },
  WB_NETWORK_ERROR: { title: 'WB 网络请求失败', description: '无法连接 WB Content API，请检查网络后再次同步。' },
  WB_SYNC_FAILED: { title: 'WB 目录同步失败', description: '本次完整同步未生效，系统继续使用上一版目录。' }
};

function showError(error: Error) { message.error(error.message); }
function isImage(asset: WbMediaAsset) { return asset.kind.toUpperCase() === 'IMAGE'; }
function isVideo(asset: WbMediaAsset) { return asset.kind.toUpperCase() === 'VIDEO'; }
function wbBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLocaleLowerCase('ru-RU');
  if (['true', 'yes', 'да'].includes(normalized)) return true;
  if (['false', 'no', 'нет'].includes(normalized)) return false;
  return undefined;
}
function newVariant(sku: string, index: number): WbVariant {
  const suffix = String(index + 1).padStart(2, '0');
  return { variantId: crypto.randomUUID(), variantCode: `${sku}-${suffix}`, vendorCode: `${sku}-${suffix}`, characteristics: [], sizes: [] };
}
function emptyVariantMedia(variantId: string): WbVariantMedia { return { variantId, imageAssetIds: [] }; }
function selectedCategoryVersion(category?: WbCategory, versionId?: string): WbCategoryVersion | undefined {
  if (!category?.versions?.length) return undefined;
  return category.versions.find((version) => version.id === versionId)
    || category.versions.find((version) => version.status === 'PUBLISHED')
    || category.versions.find((version) => version.status === 'DRAFT');
}
function publishedVersionId(category: WbCategory) {
  return category.publishedVersion?.id || category.versions?.find((version) => version.status === 'PUBLISHED')?.id;
}
function displayDescription(value: string) { return value.replace(/\\r\\n|\\r|\\n/g, '\n').replace(/\n+/g, '\n\n'); }
function isValidWbClubDiscount(value?: number | null) { return value == null || (Number.isInteger(value) && (value === 0 || (value >= 3 && value <= 31))); }
function listingForEditor(listing: WbListing): WbListing {
  const next = structuredClone(listing);
  next.descriptionRu = displayDescription(next.descriptionRu || '');
  next.variants = next.variants.map((variant) => ({
    ...variant,
    sizes: variant.sizes.map((size) => ({ ...size, sizeId: typeof size.sizeId === 'string' && size.sizeId ? size.sizeId : crypto.randomUUID() }))
  }));
  return next;
}
function bilingualLabel(nameZh?: string, nameRu?: string) {
  const zh = nameZh?.trim();
  const ru = nameRu?.trim();
  if (zh && ru && zh !== ru) return `${zh} / ${ru}`;
  return zh || ru || '未命名';
}
function subjectNameRu(subject: WbSubject) { return subject.subjectNameRu?.trim() || subject.subjectName?.trim() || ''; }
function subjectNameZh(subject: WbSubject) { return subject.subjectNameZh?.trim() || ''; }
function parentNameRu(subject: WbSubject) { return subject.parentNameRu?.trim() || subject.parentName?.trim() || ''; }
function parentNameZh(subject: WbSubject) { return subject.parentNameZh?.trim() || ''; }
async function fetchBilingualSubjectSchema(subjectId: number) {
  const liveSchema = await api.wbSubjectSchema(subjectId, 'ru');
  await new Promise((resolve) => window.setTimeout(resolve, 650));
  const schemaZh = await api.wbSubjectSchema(subjectId, 'zh');
  return { liveSchema, schemaZh };
}
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debounced;
}

function catalogFailure(status?: WbCatalogStatus) {
  const fallback = { title: 'WB 目录同步失败', description: '本次同步没有完成，请查看错误后再次同步。' };
  const copy = status?.lastErrorCode ? catalogFailureCopy[status.lastErrorCode] : fallback;
  return { ...copy, detail: status?.lastError };
}

function formatCatalogTime(value?: string) {
  return value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
}

export function WbListingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const client = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: api.config });
  const wbStores = useQuery({ queryKey: ['wb-stores'], queryFn: api.wbStores, retry: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [automationListingSku, setAutomationListingSku] = useState<string>();
  const [autoQueryText, setAutoQueryText] = useState('');
  const [autoStateFilter, setAutoStateFilter] = useState<string>();
  const [manualQueryText, setManualQueryText] = useState('');
  const [updatedDatePreset, setUpdatedDatePreset] = useState<WbUpdatedDatePreset>('ALL');
  const [customUpdatedDateRange, setCustomUpdatedDateRange] = useState<WbUpdatedDateRange>(null);
  const updatedDateBounds = useMemo(
    () => wbUpdatedDateBounds(updatedDatePreset, customUpdatedDateRange),
    [customUpdatedDateRange, updatedDatePreset]
  );
  const changeUpdatedDatePreset = (value: WbUpdatedDatePreset) => {
    setUpdatedDatePreset(value);
    if (value !== 'CUSTOM') setCustomUpdatedDateRange(null);
  };
  const resetUpdatedDate = () => {
    setUpdatedDatePreset('ALL');
    setCustomUpdatedDateRange(null);
  };
  const requestedView = searchParams.get('view');
  const activeView: WbWorkspaceView = isWbWorkspaceView(requestedView) ? requestedView : 'auto';
  const selectView = (view: WbWorkspaceView) => {
    const next = new URLSearchParams(searchParams);
    next.set('view', view);
    setSearchParams(next);
  };
  useEffect(() => {
    if (searchParams.get('settings') !== '1') return;
    setSettingsOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('settings');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const handleViewKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, view: WbWorkspaceView) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = WB_WORKSPACE_VIEWS.indexOf(view);
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? WB_WORKSPACE_VIEWS.length - 1
        : event.key === 'ArrowRight' ? (currentIndex + 1) % WB_WORKSPACE_VIEWS.length
          : (currentIndex - 1 + WB_WORKSPACE_VIEWS.length) % WB_WORKSPACE_VIEWS.length;
    const nextView = WB_WORKSPACE_VIEWS[nextIndex]!;
    selectView(nextView);
    window.requestAnimationFrame(() => document.getElementById(`wb-view-tab-${nextView}`)?.focus());
  };
  const navGroups: Array<{ key: string; label: string; items: Array<{ key: WbWorkspaceView; label: string; code?: string; icon: ReactNode }> }> = [
    { key: 'workspace', label: '上品工作区', items: [
      { key: 'auto', label: '自动上品任务', code: 'AUTO', icon: <ThunderboltOutlined /> },
      { key: 'manual', label: '手动上品资料', code: 'MANUAL', icon: <FileTextOutlined /> }
    ] },
    { key: 'configuration', label: '配置管理', items: [
      { key: 'categories', label: '类目模板', icon: <TagsOutlined /> },
      { key: 'presets', label: '上品预设模板', icon: <RocketOutlined /> }
    ] }
  ];
  const settingsReadiness = config.data?.wbPublishingReadiness;
  const settingsEnabled = Boolean(config.data?.config.wbPublishing?.enabled);
  const currentStores = (wbStores.data?.items || []).filter((store) => !store.archivedAt);
  const readyStoreCount = currentStores.filter((store) => store.enabled && store.readiness.ready).length;
  const settingsStatus = wbStores.isSuccess ? `${readyStoreCount}/${currentStores.length} 店铺可用` : settingsReadiness?.complete ? '可以提交' : settingsEnabled ? '尚未就绪' : '未启用';
  return <div className="page-stack wb-page">
    <div className="wb-page-title">
      <div><span>WILDBERRIES LISTING DESK</span><Title level={2}>WB上品</Title><Paragraph className="wb-page-title-description">管理自动任务、手动资料与上品配置。</Paragraph></div>
      <div className="wb-page-title-tools">
        <div className="wb-page-seal"><b>WB</b><span>CONTENT OPS</span></div>
        <Button
          className="wb-page-settings-trigger"
          aria-label="打开WB上品设置"
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen(true)}
        >
          <span>WB上品设置</span>
          <Tooltip title={settingsStatus}><span className="wb-page-settings-status" aria-hidden="true"><Badge status={readyStoreCount > 0 || (!wbStores.isSuccess && settingsReadiness?.complete) ? 'success' : settingsEnabled ? 'warning' : 'default'} /></span></Tooltip>
        </Button>
      </div>
    </div>
    <WbStoreSettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    <nav className="wb-workspace-nav" role="tablist" aria-label="WB 上品工作区">
      {navGroups.map((group) => <div className={`wb-workspace-nav-group is-${group.key}`} role="presentation" key={group.key}>
        <span className="wb-workspace-nav-group-label">{group.label}</span>
        <div className="wb-workspace-nav-items" role="presentation">
          {group.items.map((item) => <button
            type="button"
            role="tab"
            id={`wb-view-tab-${item.key}`}
            aria-label={item.label}
            aria-selected={activeView === item.key}
            aria-controls={`wb-view-panel-${item.key}`}
            tabIndex={activeView === item.key ? 0 : -1}
            className={`wb-workspace-nav-item${activeView === item.key ? ' is-active' : ''}`}
            onClick={() => selectView(item.key)}
            onKeyDown={(event) => handleViewKeyDown(event, item.key)}
            key={item.key}
          >
            {item.code && <span className="wb-workspace-nav-code" aria-hidden="true">{item.code}</span>}
            <span className="wb-workspace-nav-icon" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>)}
        </div>
      </div>)}
    </nav>
    <section className="wb-workspace-panel" role="tabpanel" id={`wb-view-panel-${activeView}`} aria-labelledby={`wb-view-tab-${activeView}`}>
      {activeView === 'auto' && <WbAutoPublishPanel
        queryText={autoQueryText}
        onQueryTextChange={setAutoQueryText}
        stateFilter={autoStateFilter}
        onStateFilterChange={setAutoStateFilter}
        updatedDatePreset={updatedDatePreset}
        customUpdatedDateRange={customUpdatedDateRange}
        updatedDateBounds={updatedDateBounds}
        onUpdatedDatePresetChange={changeUpdatedDatePreset}
        onCustomUpdatedDateRangeChange={setCustomUpdatedDateRange}
        onUpdatedDateReset={resetUpdatedDate}
        onOpenListing={setAutomationListingSku}
      />}
      {activeView === 'manual' && <WbListingRegistry
        queryText={manualQueryText}
        onQueryTextChange={setManualQueryText}
        onOpenSettings={() => setSettingsOpen(true)}
        updatedDatePreset={updatedDatePreset}
        customUpdatedDateRange={customUpdatedDateRange}
        updatedDateBounds={updatedDateBounds}
        onUpdatedDatePresetChange={changeUpdatedDatePreset}
        onCustomUpdatedDateRangeChange={setCustomUpdatedDateRange}
        onUpdatedDateReset={resetUpdatedDate}
      />}
      {activeView === 'categories' && <WbCategoryRegistry />}
      {activeView === 'presets' && <WbPresetRegistry />}
    </section>
    <WbListingEditor
      sku={automationListingSku}
      onClose={() => setAutomationListingSku(undefined)}
      onChanged={() => Promise.all([
        client.invalidateQueries({ queryKey: ['wb-listings'] }),
        client.invalidateQueries({ queryKey: ['wb-automation'] })
      ])}
    />
  </div>;
}

type WbWorkspaceView = 'auto' | 'manual' | 'categories' | 'presets';
const WB_WORKSPACE_VIEWS: WbWorkspaceView[] = ['auto', 'manual', 'categories', 'presets'];
function isWbWorkspaceView(value: string | null): value is WbWorkspaceView {
  return Boolean(value && WB_WORKSPACE_VIEWS.includes(value as WbWorkspaceView));
}

function WbListingRegistry({
  onOpenSettings,
  queryText,
  onQueryTextChange,
  updatedDatePreset,
  customUpdatedDateRange,
  updatedDateBounds,
  onUpdatedDatePresetChange,
  onCustomUpdatedDateRangeChange,
  onUpdatedDateReset
}: {
  onOpenSettings: () => void;
  queryText: string;
  onQueryTextChange: (value: string) => void;
  updatedDatePreset: WbUpdatedDatePreset;
  customUpdatedDateRange: WbUpdatedDateRange;
  updatedDateBounds: { updatedFrom?: string; updatedTo?: string };
  onUpdatedDatePresetChange: (value: WbUpdatedDatePreset) => void;
  onCustomUpdatedDateRangeChange: (value: WbUpdatedDateRange) => void;
  onUpdatedDateReset: () => void;
}) {
  const client = useQueryClient();
  const [effectiveQueryText, setEffectiveQueryText] = useState(queryText);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedSku, setSelectedSku] = useState<string>();
  const [createSku, setCreateSku] = useState<string>();
  useEffect(() => {
    if (!queryText.trim()) {
      setEffectiveQueryText('');
      return;
    }
    const timeout = window.setTimeout(() => setEffectiveQueryText(queryText), 300);
    return () => window.clearTimeout(timeout);
  }, [queryText]);
  const params = useMemo(() => new URLSearchParams({
    page: '1',
    pageSize: '100',
    source: 'MANUAL',
    ...(effectiveQueryText.trim() ? { query: effectiveQueryText.trim() } : {}),
    ...updatedDateBounds
  }), [effectiveQueryText, updatedDateBounds]);
  const config = useQuery({ queryKey: ['config'], queryFn: api.config });
  const stores = useQuery({ queryKey: ['wb-stores'], queryFn: api.wbStores, retry: false });
  const listings = useQuery({
    queryKey: ['wb-listings', params.toString()],
    queryFn: () => api.wbListings(params),
    retry: false,
    refetchInterval: (query) => (query.state.data as { items?: WbListing[] } | undefined)?.items?.some((item) => ['GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING'].includes(item.status)) ? 3000 : false
  });
  const manualListingSkus = useMemo(
    () => [...new Set((listings.data?.items || []).map((item) => item.sku))],
    [listings.data?.items]
  );
  const manualPublicationScope = useMemo(
    () => (listings.data?.items || []).map((item) => `${item.sku}:D${item.draftVersion}:${item.generatedVersionId || ''}`).sort().join('|'),
    [listings.data?.items]
  );
  const publicationStatuses = useQuery({
    queryKey: ['wb-publications', 'manual-list', manualPublicationScope],
    queryFn: () => api.wbPublications({ skus: manualListingSkus, source: 'MANUAL' }),
    enabled: manualListingSkus.length > 0,
    retry: false,
    refetchInterval: (query) => (query.state.data?.items || []).some(isWbPublicationActive) ? 3000 : false
  });
  const manualRows = useMemo(
    () => wbManualListingRows(listings.data?.items || [], publicationStatuses.data?.items || []),
    [listings.data?.items, publicationStatuses.data?.items]
  );
  const products = useQuery({ queryKey: ['wb-product-options'], queryFn: () => api.purchases(new URLSearchParams({ page: '1', pageSize: '100' })), enabled: createOpen, retry: false });
  const create = useMutation({
    mutationFn: () => api.createWbListing(createSku!),
    onSuccess: async ({ listing }) => {
      message.success(`SKU ${listing.sku} 的公共素材任务已创建`);
      setCreateOpen(false); setCreateSku(undefined); setSelectedSku(listing.sku);
      await Promise.all([client.invalidateQueries({ queryKey: ['wb-listings'] }), client.invalidateQueries({ queryKey: ['wb-automation'] })]);
    },
    onError: showError
  });
  const startCompatible = useMutation({
    mutationFn: ({ sku, storeId }: { sku: string; storeId: string }) => api.startCompatibleWbAutoPublishJob(sku, storeId),
    onSuccess: async (job) => {
      message.success(`SKU ${job.sku} 已启动第 ${job.runNo} 轮兼容重新上品`);
      await Promise.all([client.invalidateQueries({ queryKey: ['wb-listings'] }), client.invalidateQueries({ queryKey: ['wb-automation'] })]);
    },
    onError: showError
  });
  const localDirectoryReady = Boolean(config.data?.wbPublishingReadiness?.enabled && config.data.wbPublishingReadiness.local?.exists && config.data.wbPublishingReadiness.local.readable && config.data.wbPublishingReadiness.local.writable);
  const storesById = useMemo(() => new Map((stores.data?.items || []).map((store) => [store.id, store])), [stores.data?.items]);
  const openCompatibleRestart = (row: WbManualListingRow) => {
    const store = storesById.get(row.publication.storeId);
    if (!store) return;
    Modal.confirm({
      title: `重新上品 SKU ${row.listing.sku} 到 ${store.displayName}？`,
      content: <Text type="secondary">本次只锁定当前行店铺 {store.displayName} · {store.storeAlias}，不会再次选择或影响其他店铺。</Text>,
      okText: '确认重新上品', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: () => startCompatible.mutateAsync({ sku: row.listing.sku, storeId: store.id })
    });
  };
  const canCreate = localDirectoryReady;
  const createDisabledReason = !localDirectoryReady ? '请先初始化 WB 产品资料目录' : undefined;
  const databaseUnavailable = listings.isError && listings.error.message.startsWith('DATABASE_UNAVAILABLE:');
  return <div className="wb-registry">
    <Card className="wb-workspace-console wb-manual-console">
      <Flex className="wb-workspace-heading" justify="space-between" align="flex-start" gap={14} wrap="wrap">
        <div className="wb-workspace-title"><span className="wb-workspace-title-icon"><FileTextOutlined /></span><div><strong>手动上品公共素材</strong><Text type="secondary">维护产品变体、图片、视频及顺序；提交时按每家店铺的默认预设独立生成完整商品资料。</Text></div></div>
        <Tooltip title={createDisabledReason}><Button type="primary" icon={<PlusOutlined />} disabled={!canCreate} onClick={() => setCreateOpen(true)}>新建上品资料</Button></Tooltip>
      </Flex>
      <div className="wb-workspace-alerts">
        {databaseUnavailable && <Alert showIcon type="warning" message="WB 上品数据暂不可用" description="请先配置 PostgreSQL DATABASE_URL 并重启 MerchRoute 服务。" action={<Button onClick={() => void listings.refetch()}>重新检测</Button>} />}
        {publicationStatuses.isError && <Alert showIcon type="warning" message="逐店发布任务暂不可用" description="清单只展示已经创建的逐店 publication；重新读取成功后会恢复最近一次发布批次。" action={<Button onClick={() => void publicationStatuses.refetch()}>重试</Button>} />}
        {!localDirectoryReady && <Alert showIcon type="warning" message="WB 产品资料目录尚未就绪" description="请先在本页的“WB上品设置”中启用 WB 上品管理并初始化一个可读写的本机根目录。已有草稿仍可查看。" action={<Button onClick={onOpenSettings}>打开WB上品设置</Button>} />}
      </div>
      {!databaseUnavailable && <>
        <Flex className="wb-workspace-filter wb-manual-filter" gap={12} align="center" wrap="wrap">
          <Input.Search aria-label="搜索手动上品资料" allowClear className="wb-search" placeholder="搜索 SKU、产品名称或俄文标题" value={queryText} onChange={(event) => onQueryTextChange(event.target.value)} onSearch={(value) => setEffectiveQueryText(value)} />
          <WbUpdatedDateFilterControl
            preset={updatedDatePreset}
            customRange={customUpdatedDateRange}
            onPresetChange={onUpdatedDatePresetChange}
            onCustomRangeChange={onCustomUpdatedDateRangeChange}
          />
          <Button disabled={!queryText && updatedDatePreset === 'ALL'} onClick={() => {
            onQueryTextChange('');
            setEffectiveQueryText('');
            onUpdatedDateReset();
          }}>重置</Button>
          <Text type="secondary" className="wb-workspace-result-count">共 {manualRows.length} 个逐店任务</Text>
        </Flex>
        <Table<WbManualListingRow> className="wb-manual-table" rowKey="key" size="small" loading={listings.isLoading || (manualListingSkus.length > 0 && publicationStatuses.isLoading)} dataSource={manualRows} pagination={false} scroll={{ x: 1715 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已发布的手动上品任务"><Button type="primary" disabled={!canCreate} onClick={() => setCreateOpen(true)}>选择一个产品 SKU</Button></Empty> }} columns={[
      { title: '店铺', width: 160, render: (_, row) => <div className="wb-manual-store"><strong>{row.publication.storeDisplayName || storesById.get(row.publication.storeId)?.displayName || '历史店铺'}</strong><Text type="secondary" className="mono-small">{row.publication.storeAlias}</Text></div> },
      { title: 'SKU', width: 150, render: (_, row) => <span className="copy-value-inline"><strong className="mono-small">{row.listing.sku}</strong><CopyValueButton label="SKU" value={row.listing.sku} /></span> },
      { title: '轮次 / 方式', width: 190, render: (_, row) => <div className="wb-manual-round"><Space size={4}><Tag color="blue">发布 R{row.publication.revision}</Tag><Tag>手动发布</Tag></Space><Text type="secondary">资料 D{row.publishedDraftVersion || '—'} · {row.publication.operationMode === 'COMPATIBLE_UPSERT' ? '兼容更新' : row.publication.operationMode === 'CREATE_ONLY' ? '仅创建' : '历史方式'}</Text></div> },
      { title: '手动状态', width: 160, render: (_, row) => <Tag color={wbPublicationStatusMeta[row.publication.status].color}>{wbPublicationStatusMeta[row.publication.status].label}</Tag> },
      { title: '绑定预设', width: 190, render: (_, row) => row.publication.presetName || row.publication.presetId ? <div className="wb-manual-preset"><Space size={4} wrap><strong>{row.publication.presetName || '历史预设快照'}</strong>{row.publication.sourcePresetExists === false && <Tag color="default">原预设已删除</Tag>}</Space><Text type="secondary">R{row.publication.presetRowVersion || '—'} · 已锁定快照</Text></div> : <Text type="secondary">历史任务未记录预设名称</Text> },
      { title: '当前说明', width: 320, render: (_, row) => manualPublicationReasonCell(row) },
      { title: '更新时间', width: 155, render: (_, row) => <span className="mono-small">{dayjs(row.publication.updatedAt).format('YYYY-MM-DD HH:mm:ss')}</span> },
      { title: '操作', width: 200, fixed: 'right', render: (_, row) => { const store = storesById.get(row.publication.storeId); const disabledReason = stores.isLoading ? '正在读取 WB 店铺，请稍候' : stores.isError ? 'WB 店铺读取失败，请先刷新或检查 WB上品设置' : !store || store.archivedAt ? '该店铺已删除或归档，不能重新上品' : !store.enabled || !store.autoPublishEnabled ? '该店铺当前未启用自动上品' : store.autoPublishMode !== 'COMPATIBLE_UPSERT' ? '该店铺不是兼容更新模式' : isWbPublicationActive(row.publication) ? '当前逐店任务尚未结束，不能重新上品' : undefined; return <Space size={4}><Button size="small" onClick={() => setSelectedSku(row.listing.sku)}>打开工作台</Button><Tooltip title={disabledReason}><Button size="small" icon={<ReloadOutlined />} disabled={Boolean(disabledReason)} loading={startCompatible.isPending && startCompatible.variables?.sku === row.listing.sku && startCompatible.variables?.storeId === row.publication.storeId} onClick={() => openCompatibleRestart(row)}>重新上品</Button></Tooltip></Space>; } },
      { title: 'WB 商品链接', width: 190, fixed: 'right', render: (_, row) => renderManualPublicationLinks(row) }
        ]} />
      </>}
    </Card>
    <Modal title="选择 MerchRoute 产品" open={createOpen} okText="创建公共素材任务" confirmLoading={create.isPending} okButtonProps={{ disabled: !createSku }} onCancel={() => { setCreateOpen(false); setCreateSku(undefined); }} onOk={() => create.mutate()}><Alert showIcon type="info" message="不会套用任何全局预设" description="SKU、产品变体和媒体作为公共素材保存；价格、折扣、类目、标题、详情、包装、特征和尺码在选择店铺后按该店默认预设生成。" /><Form layout="vertical" className="wb-create-form"><Form.Item label="产品 SKU" required><Select aria-label="产品 SKU" showSearch optionFilterProp="label" loading={products.isLoading} value={createSku} onChange={setCreateSku} placeholder="选择产品" options={(products.data?.items || []).map((item) => ({ value: item.sku, label: `${item.sku} · ${item.productName}` }))} /></Form.Item></Form></Modal>
    <WbListingEditor sku={selectedSku} onClose={() => setSelectedSku(undefined)} onChanged={() => Promise.all([
      client.invalidateQueries({ queryKey: ['wb-listings'] }),
      client.invalidateQueries({ queryKey: ['wb-publications'] }),
      client.invalidateQueries({ queryKey: ['wb-automation'] })
    ])} />
  </div>;
}

function WbListingEditor({ sku, onClose, onChanged }: { sku?: string; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const client = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: api.config, enabled: Boolean(sku) });
  const categories = useQuery({ queryKey: ['wb-categories'], queryFn: api.wbCategories, enabled: Boolean(sku), retry: false });
  const detail = useQuery({
    queryKey: ['wb-listing', sku],
    queryFn: () => api.wbListingStatus(sku!),
    enabled: Boolean(sku),
    retry: false,
    refetchInterval: (query) => ['GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING'].includes((query.state.data as { listing?: WbListing } | undefined)?.listing?.status || '') ? 3000 : false
  });
  const publications = useQuery({
    queryKey: ['wb-publications', sku],
    queryFn: () => api.wbListingPublications(sku!),
    enabled: Boolean(sku),
    retry: false,
    refetchInterval: (query) => ((query.state.data as { items?: WbStorePublication[] } | undefined)?.items || []).some(isWbPublicationActive) ? 3_000 : false
  });
  const [draft, setDraft] = useState<WbListing>();
  const [dirty, setDirty] = useState(false);
  const [activeVariantId, setActiveVariantId] = useState<string>();
  const [mediaSuggestionReport, setMediaSuggestionReport] = useState<WbMediaSuggestionReport>();
  const [publicationOpen, setPublicationOpen] = useState(false);
  const appliedSuggestionKey = useRef<string>();
  const descriptionFileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    appliedSuggestionKey.current = undefined;
    setMediaSuggestionReport(undefined);
  }, [sku]);
  useEffect(() => {
    if (!detail.data?.listing || dirty) return;
    const next = listingForEditor(detail.data.listing);
    setDraft(next);
    setActiveVariantId((current) => next.variants.some((variant) => variant.variantId === current) ? current : next.variants[0]?.variantId);
  }, [detail.data, dirty]);
  const categoryDetail = useQuery({ queryKey: ['wb-category', draft?.categoryKey], queryFn: () => api.wbCategory(draft!.categoryKey!), enabled: Boolean(sku && draft?.categoryKey), retry: false });
  const purchaseDetail = useQuery({ queryKey: ['purchase', sku], queryFn: () => api.purchase(sku!), enabled: Boolean(sku), retry: false });
  const category = categoryDetail.data?.category || categories.data?.items.find((item) => item.categoryKey === draft?.categoryKey);
  const categoryVersion = selectedCategoryVersion(categoryDetail.data?.category, draft?.categoryVersionId);
  const fields = [...(categoryVersion?.formConfig.fields || [])].sort((a, b) => a.order - b.order);
  const tnvedCharacteristicId = categoryVersion?.formConfig.compliance?.tnvedCharacteristicId;
  const normalizedTnved = String(draft?.compliance.tnved || '').replace(/\D/g, '');
  const tnvedDirectory = useQuery({
    queryKey: ['wb-tnved-directory', categoryVersion?.subjectId, normalizedTnved],
    queryFn: () => api.wbTnvedDirectory(Number(categoryVersion!.subjectId), normalizedTnved),
    enabled: Boolean(sku && categoryVersion?.subjectId && /^\d{10}$/.test(normalizedTnved)),
    retry: false,
    staleTime: 5 * 60_000
  });
  const exactTnved = tnvedDirectory.data?.find((item) => String(item.tnved).replace(/\D/g, '') === normalizedTnved);
  const expectedKizMarked = wbBoolean(exactTnved?.isKiz);
  const tnvedKizMismatch = expectedKizMarked !== undefined && Boolean(draft?.compliance.kizMarked) !== expectedKizMarked;
  const purchaseManagedFields = fields.filter((field) => isWbPurchaseCharacteristicId(field.characteristicId));
  const invalidPurchaseManagedFields = purchaseManagedFields.filter((field) => field.scope !== 'shared');
  const sharedFields = fields.filter((field) => field.scope === 'shared'
    && field.characteristicId !== tnvedCharacteristicId
    && !isWbPurchaseCharacteristicId(field.characteristicId));
  const variantFields = fields.filter((field) => field.scope === 'variant' && !isWbPurchaseCharacteristicId(field.characteristicId));
  const colorSupported = variantFields.some((field) => field.characteristicId === WB_COLOR_CHARACTERISTIC_ID);
  const productVariants = detail.data?.productVariants || [];
  const colors = useQuery({
    queryKey: ['wb-dictionary', 'colors'],
    queryFn: () => api.wbDictionary('colors', '', 1_000),
    enabled: Boolean(sku),
    retry: false,
    staleTime: 10 * 60_000
  });
  const mediaRules = {
    maxImages: Number(categoryVersion?.formConfig.media?.maxImages || 30),
    videoAllowed: categoryVersion?.formConfig.media?.videoAllowed !== false,
    colorSupported
  };
  const sourceMediaCleaned = draft?.sourceMediaState === 'CLEANED';
  const immutable = Boolean(draft && (sourceMediaCleaned || draft.autoPublishLocked || ['GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING'].includes(draft.status)));
  useEffect(() => {
    if (!draft || immutable || colors.isLoading || colors.isError) return;
    const key = JSON.stringify({
      sku: draft.sku,
      draftVersion: draft.draftVersion,
      assets: draft.mediaAssets.map((asset) => [asset.assetId, asset.sha256, asset.sortOrder, asset.productVariantId, asset.productVariantColor?.colorKey]),
      productVariants: productVariants.map((variant) => [variant.variantId, variant.wbColor?.colorKey]),
      mediaRules
    });
    if (appliedSuggestionKey.current === key) return;
    appliedSuggestionKey.current = key;
    const suggested = applyWbMediaSuggestions(draft, productVariants, colors.data?.items || [], mediaRules);
    if (suggested.report.changed || suggested.report.warnings.length > 0) setMediaSuggestionReport(suggested.report);
    if (!suggested.report.changed) return;
    setDraft({ ...draft, variants: suggested.variants, variantMedia: suggested.variantMedia });
    setDirty(true);
  }, [draft?.sku, draft?.draftVersion, draft?.mediaAssets, productVariants, colors.data?.items, immutable, mediaRules.maxImages, mediaRules.videoAllowed, mediaRules.colorSupported]);
  const patchDraft = (patch: Partial<WbListing>) => { setDraft((current) => current ? { ...current, ...patch } : current); setDirty(true); };
  const importDescriptionFile = async (file?: File) => {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const normalized = decodeWbDescriptionTxt(file.name, buffer);
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
      patchDraft({ descriptionRu: normalized, descriptionProvenance: { type: 'MANUAL_IMPORT', fileName: file.name, sha256 } });
      message.success(`已导入 ${file.name}，保存草稿后生效`);
    } catch (error) {
      showError(error instanceof Error ? error : new Error('TXT 导入失败'));
    } finally {
      if (descriptionFileRef.current) descriptionFileRef.current.value = '';
    }
  };
  const patchTnved = (tnved: string) => {
    setDraft((current) => current ? {
      ...current,
      compliance: { ...current.compliance, tnved },
      ...(tnvedCharacteristicId ? { sharedCharacteristics: setCharacteristic(current.sharedCharacteristics, tnvedCharacteristicId, tnved.trim() ? [tnved.trim()] : []) } : {})
    } : current);
    setDirty(true);
  };
  const replaceFromServer = (listing: WbListing) => {
    const next = listingForEditor(listing);
    setDraft(next);
    setDirty(false);
    client.setQueryData(['wb-listing', listing.sku], (current: any) => ({ ...(current || {}), listing }));
    void onChanged();
  };
  const mergeMediaScanFromServer = (listing: WbListing, scannedProductVariants: ProductVariant[]) => {
    const scanned = listingForEditor(listing);
    setDraft((current) => {
      if (current?.sku !== scanned.sku) return current;
      const merged = { ...current, status: scanned.status, draftVersion: scanned.draftVersion, revision: scanned.revision, mediaAssets: scanned.mediaAssets, lastError: scanned.lastError, generatedAt: scanned.generatedAt };
      const suggested = applyWbMediaSuggestions(merged, scannedProductVariants, colors.data?.items || [], mediaRules);
      setMediaSuggestionReport(suggested.report);
      if (suggested.report.changed) setDirty(true);
      return suggested.report.changed ? { ...merged, variants: suggested.variants, variantMedia: suggested.variantMedia } : merged;
    });
    client.setQueryData(['wb-listing', listing.sku], (current: any) => ({ ...(current || {}), listing, productVariants: scannedProductVariants }));
    void onChanged();
  };
  const save = useMutation({
    mutationFn: () => api.updateWbListing(draft!.sku, {
      draftVersion: draft!.draftVersion,
      variantMedia: draft!.variantMedia
    }),
    onSuccess: ({ listing }) => { message.success('公共媒体分配与顺序已保存'); replaceFromServer(listing); },
    onError: showError
  });
  const scan = useMutation({
    mutationFn: () => api.scanWbListingMedia(draft!.sku),
    onSuccess: ({ listing, productVariants: scannedProductVariants }) => { message.success(`已扫描到 ${listing.mediaAssets.length} 个媒体文件`); mergeMediaScanFromServer(listing, scannedProductVariants); },
    onError: showError
  });
  if (!sku) return null;
  const readiness = config.data?.wbPublishingReadiness;
  const clubDiscountInvalid = Boolean(draft && !isValidWbClubDiscount(draft.clubDiscount));
  const grossWeightResolution = draft?.initialization?.grossWeightResolution;
  const networkRecovery = draft?.networkRecovery;
  const taskNotice = draft && (draft.lastError || networkRecovery)
    ? listingTaskNotice(networkRecovery ? 'WAITING_NETWORK' : draft.status)
    : undefined;
  const taskNoticeDescription = networkRecovery
    ? <Space direction="vertical" size={2}>
      <span>{networkRecovery.lastErrorMessage || draft?.lastError || '网络暂不可用，任务会按原 taskId 自动续跑。'}</span>
      <Text type="secondary">
        第 {networkRecovery.attempt} 次等待 · 恢复阶段 {networkRecovery.resumeState} · 下次尝试 {dayjs(networkRecovery.nextAttemptAt).format('YYYY-MM-DD HH:mm:ss')}
      </Text>
  </Space>
    : draft?.lastError;
  return <><Drawer className="wb-listing-drawer" open width="min(1480px, 98vw)" title={draft ? <Space wrap><span className="mono-badge">{draft.sku}</span><strong>{draft.productName}</strong><Tag color={listingStatusMeta[draft.status]?.color}>{listingStatusMeta[draft.status]?.label}</Tag>{sourceMediaCleaned && <Tag>媒体已清理</Tag>}{dirty && <Tag color="orange">有未保存修改</Tag>}</Space> : '加载上品资料'} onClose={() => { setPublicationOpen(false); onClose(); }} extra={draft && <Space wrap className="wb-drawer-actions">
    <Button icon={<SaveOutlined />} loading={save.isPending} disabled={immutable || !dirty} onClick={() => save.mutate()}>保存媒体顺序</Button>
    <Tooltip title={sourceMediaCleaned ? '公共媒体已在成功上品后清理，请重新投递媒体' : !readiness?.complete ? '请先在 WB上品设置中完成公共目录配置' : dirty ? '请先保存媒体分配与顺序' : undefined}><Button type="primary" icon={<RocketOutlined />} disabled={immutable || dirty || !readiness?.complete} onClick={() => setPublicationOpen(true)}>选择店铺并提交</Button></Tooltip>
  </Space>}>
    {detail.isLoading || !draft ? <Skeleton active /> : detail.isError ? <Alert showIcon type="error" message="上品资料加载失败" description={detail.error.message} /> : <div className="wb-editor-layout">
      <main className="wb-editor-main">
        {detail.data?.pollError && <Alert showIcon type="warning" message="WB 任务状态暂时无法确认" description={detail.data.pollError} />}
        {sourceMediaCleaned && <Alert showIcon type="warning" message="公共媒体已清理" description="公共媒体已在成功上品后清理，请重新投递媒体。历史成功包、商品链接和上品结果不受影响。" />}
        {(draft.lastError || networkRecovery) && taskNotice && <Alert closable={taskNotice.closable} showIcon type={taskNotice.type} message={taskNotice.message} description={taskNoticeDescription} />}
        <WbPublicationResults
          publications={publications.data?.items || []}
          loading={publications.isLoading}
          refreshing={publications.isFetching}
          error={publications.error}
          onRefresh={() => void publications.refetch()}
        />
        <Card style={{ display: 'none' }} aria-hidden title={<Space><FormOutlined />产品资料</Space>}>
          <Form layout="vertical" disabled={immutable}>
            <Row gutter={[14, 0]}><Col xs={24} md={12}><Form.Item label="WB 类目模板" required><Select aria-label="WB 类目模板" showSearch optionFilterProp="label" value={draft.categoryKey} placeholder="选择已发布且已同步的类目" onChange={(categoryKey) => {
              const next = categories.data?.items.find((item) => item.categoryKey === categoryKey);
              patchDraft({ categoryKey, categoryVersionId: next ? publishedVersionId(next) : undefined, sharedCharacteristics: [], variants: draft.variants.map((variant) => ({ ...variant, characteristics: [] })) });
            }} options={(categories.data?.items || []).filter((item) => item.active && item.publishedVersion).map((item) => ({ value: item.categoryKey, label: `${bilingualLabel(item.publishedVersion!.nameZh || item.nameZh, item.publishedVersion!.nameRu || item.nameRu)} · ${item.publishedVersion!.subjectId || item.subjectId} · V${item.publishedVersion!.versionNo}`, disabled: item.projection.status !== 'SYNCED' }))} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="品牌（允许留空）"><Input value={draft.brand} onChange={(event) => patchDraft({ brand: event.target.value })} placeholder="留空时不向 WB 发送品牌特征" /></Form.Item></Col></Row>
            <Form.Item label="俄文商品标题" required><Input value={draft.titleRu} maxLength={60} showCount onChange={(event) => patchDraft({ titleRu: event.target.value })} /></Form.Item>
            <Form.Item label={<Flex align="center" justify="space-between" gap={12} wrap="wrap"><span>共享俄文产品详情（兼容兜底） <Text type="danger">*</Text></span><Button size="small" icon={<FileTextOutlined />} disabled={immutable} onClick={() => descriptionFileRef.current?.click()}>导入 UTF-8 TXT</Button><input ref={descriptionFileRef} hidden type="file" accept=".txt,text/plain" onChange={(event) => void importDescriptionFile(event.target.files?.[0])} /></Flex>} extra={`各颜色变体优先使用自己在下方填写或从 E003 导入的详情；保存后段落统一为字面量 \\n\\n。WB 当前按 ${WB_DESCRIPTION_MAX_LENGTH} 字符安全上限生成，超出部分会在生成时自动截断。`}><Input.TextArea value={draft.descriptionRu} maxLength={WB_DESCRIPTION_MAX_LENGTH} showCount autoSize={{ minRows: 5, maxRows: 12 }} onChange={(event) => patchDraft({ descriptionRu: event.target.value, descriptionProvenance: { type: 'USER_EDIT' } })} /></Form.Item>
            <Row gutter={[14, 0]}><Col xs={12} md={4}><Form.Item label="上架价 CNY" required><InputNumber min={0.01} value={draft.priceCny} onChange={(value) => patchDraft({ priceCny: Number(value || 0) })} /></Form.Item></Col><Col xs={12} md={4}><Form.Item label="商家折扣 %"><InputNumber min={0} max={99} precision={0} value={draft.discountPercent} onChange={(value) => patchDraft({ discountPercent: Number(value || 0) })} /></Form.Item></Col><Col xs={12} md={4}><Form.Item label="WB Club 专享折扣 %" validateStatus={clubDiscountInvalid ? 'error' : undefined} help={clubDiscountInvalid ? '仅允许 0 或 3–31' : '留空不修改；0 关闭；3–31 启用'}><InputNumber aria-label="WB Club 专享折扣 %" min={0} max={31} precision={0} value={draft.clubDiscount ?? undefined} onChange={(value) => patchDraft({ clubDiscount: value == null ? null : Number(value) })} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label={tnvedCharacteristicId ? <Space size={5}>TNVED<span className="mono-small">#{tnvedCharacteristicId}</span></Space> : 'TNVED'}><Input value={String(draft.compliance.tnved || '')} onChange={(event) => patchTnved(event.target.value)} /></Form.Item></Col><Col xs={12} md={4}><Form.Item label="KIZ 标记" extra={tnvedDirectory.isFetching ? '正在核对 WB 目录…' : expectedKizMarked === undefined ? undefined : `WB 目录要求：${expectedKizMarked ? '是' : '否'}`}><Switch checked={Boolean(draft.compliance.kizMarked)} onChange={(kizMarked) => patchDraft({ compliance: { ...draft.compliance, kizMarked } })} /></Form.Item></Col></Row>
            {tnvedKizMismatch && <Alert showIcon type="error" message="KIZ 与 WB TNVED 目录不一致" description={`TNVED ${normalizedTnved} 在 WB 目录中要求 KIZ 标记为“${expectedKizMarked ? '是' : '否'}”。`} action={<Button size="small" danger onClick={() => patchDraft({ compliance: { ...draft.compliance, kizMarked: expectedKizMarked! } })}>按 WB 要求修正</Button>} />}
            <WbPricingInitializationAudit listing={draft} />
            <Divider orientation="left">包装信息</Divider>
            <Row gutter={[12, 0]}>{(['grossWeightGrams', 'lengthCm', 'widthCm', 'heightCm'] as const).map((key) => {
              const label = { grossWeightGrams: '毛重 (g)', lengthCm: '长 cm', widthCm: '宽 cm', heightCm: '高 cm' }[key];
              const grossWeightLocked = key === 'grossWeightGrams' && Boolean(grossWeightResolution);
              const grossWeightSource = grossWeightResolution?.source === 'PROCUREMENT'
                ? `采购 V${grossWeightResolution.procurementVersionNo}`
                : grossWeightResolution?.source === 'PRESET_FALLBACK' ? '预设兜底' : undefined;
              return <Col xs={12} md={6} key={key}><Form.Item required label={label} extra={key === 'grossWeightGrams' ? grossWeightSource
                ? <Space size={4}><Text type="secondary">毛重来源</Text><Tag color={grossWeightResolution?.source === 'PROCUREMENT' ? 'blue' : 'gold'}>{grossWeightSource}</Tag></Space>
                : <Text type="warning">历史未联动：毛重仍可手动编辑</Text> : undefined}><InputNumber aria-label={label} min={key === 'grossWeightGrams' ? 1 : 0.01} readOnly={grossWeightLocked} value={Number(draft.packaging[key] || 0)} onChange={(value) => {
                  if (grossWeightLocked) return;
                  patchDraft({ packaging: { ...draft.packaging, [key]: Number(value || 0) } });
                }} /></Form.Item></Col>;
            })}</Row>
          </Form>
        </Card>
        <Card style={{ display: 'none' }} aria-hidden title={<Space><TagsOutlined />WB 类目字段</Space>} extra={category?.publishedVersion && <Tag color={category.projection.status === 'SYNCED' ? 'green' : 'gold'}>模板 V{category.publishedVersion.versionNo} · {projectionMeta[category.projection.status].label}</Tag>}>
          {!draft.categoryKey ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择 WB 类目模板" /> : categoryDetail.isLoading ? <Skeleton active /> : categoryDetail.isError ? <Alert showIcon type="error" message="类目模板加载失败" description={categoryDetail.error.message} /> : !fields.length ? <Alert showIcon type="warning" message="该模板尚未配置可视化字段" description="请在“类目模板”页添加 characteristic 字段并发布同步。" /> : <>
            {!!invalidPurchaseManagedFields.length && <Alert showIcon type="error" message="采购自动取值字段的类目配置错误" description={`以下 characteristic 必须配置为“所有变体共享”：${invalidPurchaseManagedFields.map((field) => `#${field.characteristicId}`).join('、')}`} />}
            {!!purchaseManagedFields.length && <PurchaseManagedWorkbenchFields
              sku={draft.sku}
              fields={purchaseManagedFields}
              latestProcurement={purchaseDetail.data?.purchase.procurementVersions[0]}
              savedSnapshot={draft.purchaseMeasurements}
              loading={purchaseDetail.isLoading}
              error={purchaseDetail.error}
            />}
            {!!sharedFields.length && <CharacteristicFieldGroup key={`shared-${categoryVersion?.id || draft.categoryKey}`} fields={sharedFields} disabled={immutable} valueFor={(field) => characteristicToStrings(draft.sharedCharacteristics.find((item) => item.id === field.characteristicId)?.value)} onChange={(field, value) => patchDraft({ sharedCharacteristics: setCharacteristic(draft.sharedCharacteristics, field.characteristicId, value) })} />}
          </>}
        </Card>
        <Alert showIcon type="info" message="公共素材任务" description="这里只维护 MerchRoute 产品变体、图片、视频及顺序。价格、折扣、类目、标题、详情、包装、特征和尺码由所选店铺的默认预设生成，并在发布计划中只读预览。" />
        {mediaSuggestionReport && (mediaSuggestionReport.changed || mediaSuggestionReport.warnings.length > 0) && <Alert className="wb-media-suggestion-alert" showIcon type={mediaSuggestionReport.warnings.length ? 'warning' : 'success'} message={mediaSuggestionReport.changed ? '已生成媒体自动匹配建议，尚未保存' : '部分媒体未能自动匹配'} description={<Space direction="vertical" size={4}><span>匹配 {mediaSuggestionReport.matchedVariants} 个变体，新增 {mediaSuggestionReport.imagesAdded} 张图片、{mediaSuggestionReport.videosAdded} 个视频。</span>{mediaSuggestionReport.warnings.map((warning) => <span key={warning}>• {warning}</span>)}</Space>} />}
        <VariantEditor publicMaterialOnly draft={sourceMediaCleaned ? { ...draft, mediaAssets: [] } : draft} fields={variantFields} productVariants={productVariants} colors={colors.data?.items || []} mediaRules={mediaRules} immutable={immutable} activeVariantId={activeVariantId} onActiveVariantId={setActiveVariantId} onChange={patchDraft} onSuggestion={setMediaSuggestionReport} onScan={() => scan.mutate()} scanning={scan.isPending} />
      </main>
      <WbReadinessRail listing={draft} publications={publications.data?.items || []} readiness={readiness} dirty={dirty} category={category} />
    </div>}
  </Drawer>{draft && <WbPublicationDialog listing={draft} open={publicationOpen} onClose={() => setPublicationOpen(false)} onSubmitted={async () => {
    await client.invalidateQueries({ queryKey: ['wb-publications'] });
    await Promise.all([detail.refetch(), publications.refetch(), onChanged()]);
  }} />}</>;
}

function WbPricingInitializationAudit({ listing }: { listing: WbListing }) {
  const pricing = listing.initialization?.pricing;
  if (!pricing) return null;
  const targetValue = pricing.targetSalePriceCny ?? pricing.targetSaleCny ?? pricing.targetPriceCny;
  const target = typeof targetValue === 'number' ? targetValue : Number(targetValue);
  const { estimatedDiscountedPriceCny: estimated, differenceCny: difference, mismatch } = calculateWbDiscountAudit(Number(listing.priceCny || 0), Number(listing.discountPercent || 0), Number.isFinite(target) ? target : undefined);
  const versionText = [pricing.pricingTemplateVersionNo ? `定价 V${pricing.pricingTemplateVersionNo}` : '', pricing.shippingTemplateVersionNo ? `运费 V${pricing.shippingTemplateVersionNo}` : '', pricing.shippingServiceCode || ''].filter(Boolean).join(' · ');
  return <div className={`wb-price-audit${mismatch ? ' has-warning' : ''}`}>
    <div className="wb-price-audit-head"><div><span>PRESET PRICE TRACE</span><strong>预设价格与折扣核对</strong>{versionText && <Text type="secondary">{versionText}</Text>}</div>{mismatch ? <Tag color="gold">预计成交价有差额</Tag> : <Tag color="green">价格一致</Tag>}</div>
    <div className="wb-price-audit-chain"><span><small>上架价</small><strong>{Number(listing.priceCny || 0).toFixed(2)}</strong><em>CNY</em></span><i>×</i><span><small>商家折扣后</small><strong>{100 - Number(listing.discountPercent || 0)}%</strong><em>保留比例</em></span><i>=</i><span className="is-estimated"><small>预计成交价</small><strong>{estimated.toFixed(2)}</strong><em>CNY</em></span><i>↔</i><span><small>定价目标</small><strong>{Number.isFinite(target) ? target.toFixed(2) : '—'}</strong><em>CNY</em></span></div>
    {mismatch && <Alert showIcon type="warning" message={`与定价目标相差 ${difference! > 0 ? '+' : ''}${difference!.toFixed(2)} CNY`} description="商家折扣允许独立于定价模板设置，因此该差额只作提示，不阻止保存或生成。" />}
  </div>;
}

function PurchaseManagedWorkbenchFields({
  sku,
  fields,
  latestProcurement,
  savedSnapshot,
  loading,
  error
}: {
  sku: string;
  fields: WbFormField[];
  latestProcurement?: ProcurementVersion;
  savedSnapshot?: WbPurchaseMeasurements;
  loading: boolean;
  error: Error | null;
}) {
  const versionNo = latestProcurement?.versionNo ?? savedSnapshot?.procurementVersionNo;
  const valueFor = (purchaseField: (typeof WB_PURCHASE_CHARACTERISTIC_BINDINGS)[number]['purchaseField']) => {
    const input = latestProcurement
      ? latestProcurement[purchaseField]
      : savedSnapshot?.[purchaseField];
    if (input === undefined || input === null || String(input).trim() === '') return null;
    const value = Number(input);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return <section className="wb-purchase-managed-fields wb-purchase-managed-workbench">
    <Alert
      showIcon
      icon={<LockOutlined />}
      type={error ? 'warning' : 'info'}
      message="采购管理自动取值"
      description={error
        ? `最新采购信息暂时读取失败，页面显示草稿快照；保存和生成时仍由服务端重新读取。${error.message}`
        : `以下属性不可在 WB 工作台覆盖，保存和生成时读取采购管理最新采购版本${versionNo ? ` V${versionNo}` : ''}。`}
      action={<Button type="link" href={`/purchases?query=${encodeURIComponent(sku)}`}>前往采购管理</Button>}
    />
    {loading ? <Skeleton active paragraph={{ rows: 1 }} /> : <div className="wb-purchase-managed-grid">
      {fields.map((field) => {
        const binding = WB_PURCHASE_CHARACTERISTIC_BINDINGS.find((item) => item.characteristicId === field.characteristicId)!;
        const value = valueFor(binding.purchaseField);
        return <div key={field.fieldId} className={`wb-purchase-managed-item${field.required && value === null ? ' has-error' : ''}`}>
          <LockOutlined />
          <span>
            <strong>{binding.labelZh}{field.required && <Text type="danger"> *</Text>}</strong>
            <small>{binding.labelRu} · #{binding.characteristicId}</small>
          </span>
          {value === null
            ? <Tag color={field.required ? 'red' : 'default'}>{field.required ? '采购信息必填，请补充' : '采购信息未填写，本次不上传'}</Tag>
            : <Tag color="cyan">{value} {binding.unit} · 采购 V{versionNo || '—'}</Tag>}
        </div>;
      })}
    </div>}
  </section>;
}

function CharacteristicField({ field, value, disabled, onChange }: { field: WbFormField; value: string[]; disabled: boolean; onChange: (value: string[]) => void }) {
  const directory = WB_FIELD_DICTIONARY_ALIASES[field.directory || ''] || (field.characteristicId === 14177449 ? 'colors' : undefined);
  const dictionary = useQuery({
    queryKey: ['wb-field-dictionary', directory],
    queryFn: () => api.wbDictionary(directory!, '', 1_000),
    enabled: Boolean(directory),
    staleTime: 30 * 60 * 1_000,
    retry: false
  });
  const label = <Space size={6} align="start"><span className="wb-characteristic-label"><strong>{field.labelZh?.trim() || field.labelRu}</strong>{field.labelZh?.trim() && <small>{field.labelRu}</small>}</span>{field.required && <Text type="danger">*</Text>}<span className="mono-small">#{field.characteristicId}</span></Space>;
  if (field.control === 'boolean') return <Form.Item label={label}><Select disabled={disabled} allowClear value={value[0]} onChange={(next) => onChange(next ? [next] : [])} options={[{ value: 'Да', label: 'Да' }, { value: 'Нет', label: 'Нет' }]} /></Form.Item>;
  if (field.control === 'number') return <Form.Item label={label}><InputNumber disabled={disabled} value={value[0]} onChange={(next) => onChange(next === null ? [] : [String(next)])} /></Form.Item>;
  if (field.control === 'select' || field.control === 'multi-select') {
    if (directory) return <Form.Item label={label} extra={dictionary.isError ? `本地中俄${WB_FIELD_DICTIONARY_LABELS[directory]}字典不可用，请在类目模板页执行“立即同步”。` : `从本地 WB 中俄${WB_FIELD_DICTIONARY_LABELS[directory]}字典选择；product.json 始终保存俄文值。`}><Select showSearch allowClear disabled={disabled} loading={dictionary.isLoading} mode={field.control === 'multi-select' ? 'multiple' : undefined} value={field.control === 'multi-select' ? value : value[0]} onChange={(next) => onChange(Array.isArray(next) ? next : next ? [next] : [])} optionFilterProp="label" placeholder={`搜索中文或俄文${WB_FIELD_DICTIONARY_LABELS[directory]}`} options={(dictionary.data?.items || []).map((item) => ({ value: item.nameRu, label: wbDictionaryOptionLabel(directory, item) }))} /></Form.Item>;
    return <Form.Item label={label} extra={field.directory ? `WB 字典：${field.directory}` : '请输入 WB 接受的俄文值'}><Select disabled={disabled} mode="tags" maxCount={field.control === 'select' ? 1 : undefined} value={value} onChange={onChange} tokenSeparators={[',']} /></Form.Item>;
  }
  return <Form.Item label={label}><Input disabled={disabled} value={value[0] || ''} onChange={(event) => onChange(event.target.value ? [event.target.value] : [])} /></Form.Item>;
}

function wbDictionaryOptionLabel(directory: WbDictionaryName, item: WbDictionaryValue): string {
  const name = bilingualLabel(item.nameZh, item.nameRu);
  if (directory === 'colors' && (item.parentNameRu || item.parentNameZh)) {
    return `${name} · ${bilingualLabel(item.parentNameZh, item.parentNameRu)}`;
  }
  if (directory === 'countries' && item.wbId) return `${name} · WB #${item.wbId}`;
  return name;
}

function CharacteristicFieldGroup({ fields, disabled, valueFor, onChange }: {
  fields: WbFormField[];
  disabled: boolean;
  valueFor: (field: WbFormField) => string[];
  onChange: (field: WbFormField, value: string[]) => void;
}) {
  const [showOptional, setShowOptional] = useState(false);
  const required = fields.filter((field) => field.required);
  const optional = fields.filter((field) => !field.required);
  const filledOptional = optional.filter((field) => valueFor(field).length > 0).length;
  const visible = showOptional ? [...required, ...optional] : required;
  return <div className="wb-characteristic-group">
    {visible.length > 0 && <div className="wb-characteristic-grid">{visible.map((field) => <CharacteristicField key={field.fieldId} field={field} value={valueFor(field)} disabled={disabled} onChange={(value) => onChange(field, value)} />)}</div>}
    {optional.length > 0 && <Flex className="wb-optional-fields-toggle" align="center" justify="space-between" gap={12} wrap="wrap"><Text type="secondary">WB 选填字段 {optional.length} 项{filledOptional ? `，已填写 ${filledOptional} 项` : '，默认收起'}</Text><Button onClick={() => setShowOptional((current) => !current)}>{showOptional ? '收起选填字段' : '显示所有'}</Button></Flex>}
  </div>;
}

function setCharacteristic(items: WbCharacteristic[], id: number, value: string[]) {
  const rest = items.filter((item) => item.id !== id);
  return value.length ? [...rest, { id, value }] : rest;
}

function characteristicToStrings(value: WbCharacteristic['value'] | undefined): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function VariantEditor({ publicMaterialOnly = false, draft, fields, productVariants, colors, mediaRules, immutable, activeVariantId, onActiveVariantId, onChange, onSuggestion, onScan, scanning }: {
  publicMaterialOnly?: boolean;
  draft: WbListing;
  fields: WbFormField[];
  productVariants: ProductVariant[];
  colors: WbDictionaryValue[];
  mediaRules: { maxImages: number; videoAllowed: boolean; colorSupported: boolean };
  immutable: boolean;
  activeVariantId?: string;
  onActiveVariantId: (value?: string) => void;
  onChange: (patch: Partial<WbListing>) => void;
  onSuggestion: (report: WbMediaSuggestionReport) => void;
  onScan: () => void;
  scanning: boolean;
}) {
  const activeVariant = draft.variants.find((variant) => variant.variantId === activeVariantId) || draft.variants[0];
  const productVariantOptions = productVariants.map((variant) => ({
    value: variant.variantId,
    label: variant.wbColor ? `${variant.name} · ${variant.wbColor.nameRu}` : `${variant.name} · 未关联 WB 颜色`,
    variant
  }));
  const descriptionSources = Array.isArray(draft.initialization?.description?.variantSources)
    ? draft.initialization.description.variantSources as Array<Record<string, unknown>>
    : [];
  const patchVariant = (variantId: string, patch: Partial<WbVariant>) => onChange({ variants: draft.variants.map((variant) => variant.variantId === variantId ? { ...variant, ...patch } : variant) });
  const reconcileVariant = (nextVariant: WbVariant) => {
    const candidate = { ...draft, variants: draft.variants.map((variant) => variant.variantId === nextVariant.variantId ? nextVariant : variant) };
    const suggested = applyWbMediaSuggestions(candidate, productVariants, colors, mediaRules);
    onSuggestion(suggested.report);
    onChange({ variants: suggested.variants, variantMedia: suggested.variantMedia });
  };
  const addVariant = () => {
    const variant = newVariant(draft.sku, draft.variants.length);
    onChange({ variants: [...draft.variants, variant], variantMedia: [...draft.variantMedia, emptyVariantMedia(variant.variantId)] });
    onActiveVariantId(variant.variantId);
  };
  const removeVariant = (variantId: string) => {
    const variants = draft.variants.filter((variant) => variant.variantId !== variantId);
    onChange({ variants, variantMedia: draft.variantMedia.filter((item) => item.variantId !== variantId) });
    onActiveVariantId(variants[0]?.variantId);
  };
  return <Card className="wb-variant-card" title={<Space><AppstoreAddOutlined />产品变体与媒体</Space>} extra={<Space><Button icon={<ReloadOutlined />} loading={scanning} onClick={onScan}>扫描 variants 目录</Button>{!publicMaterialOnly && <Button icon={<PlusOutlined />} disabled={immutable} onClick={addVariant}>添加变体</Button>}</Space>}>
    {!draft.variants.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="至少创建一个颜色变体"><Button icon={<PlusOutlined />} disabled={immutable} onClick={addVariant}>添加第一个变体</Button></Empty> : <Tabs className="wb-variant-tabs" activeKey={activeVariant?.variantId} onChange={onActiveVariantId} items={draft.variants.map((variant, index) => ({ key: variant.variantId, label: <span>{variant.vendorCode || `变体 ${index + 1}`}<small>{draft.variantMedia.find((item) => item.variantId === variant.variantId)?.imageAssetIds.length || 0} 图</small></span>, children: activeVariant?.variantId === variant.variantId ? <div className="wb-variant-panel">
      <Flex justify="space-between" align="center" gap={12} wrap="wrap"><Space wrap><Tag color="cyan">变体 {index + 1}</Tag><Text type="secondary">{variant.productVariantName || variant.productVariantId || variant.variantId}</Text></Space>{!publicMaterialOnly && <Button danger icon={<DeleteOutlined />} disabled={immutable || draft.variants.length === 1} onClick={() => Modal.confirm({ title: `删除变体 ${variant.vendorCode}？`, content: '只会删除变体和媒体分配关系，不会删除磁盘文件。', okText: '删除变体', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => removeVariant(variant.variantId) })}>删除变体</Button>}</Flex>
      {!publicMaterialOnly && <><Form layout="vertical" disabled={immutable}><Row gutter={[12, 0]}><Col xs={24} md={12}><Form.Item label="变体代码" required><Input value={variant.variantCode} onChange={(event) => patchVariant(variant.variantId, { variantCode: event.target.value })} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="WB vendorCode" required><Input value={variant.vendorCode} onChange={(event) => patchVariant(variant.variantId, { vendorCode: event.target.value })} /></Form.Item></Col></Row><Form.Item label="关联产品变体（用于媒体建议）" extra="选择产品变体后会自动填写 WB 俄文颜色，并追加该颜色最新投递批次的媒体建议。"><Select allowClear placeholder="选择 E001 审核阶段识别出的颜色变体" value={variant.productVariantId} options={productVariantOptions} onChange={(value) => { const selected = productVariantOptions.find((item) => item.value === value)?.variant; reconcileVariant(linkVariantToProductVariant(variant, selected, mediaRules.colorSupported)); }} /></Form.Item><Form.Item label={<Space>该颜色的俄文产品详情{descriptionSources.some((source) => String(source.productVariantId || '') === String(variant.productVariantId || '')) && <Tag color="blue">E003 已导入</Tag>}</Space>} extra={`自动初始化时按产品变体精确匹配 E003 详情；此处内容会覆盖上方共享兜底详情并发送到对应 WB 商品卡。WB 当前按 ${WB_DESCRIPTION_MAX_LENGTH} 字符安全上限生成，超出部分会在生成时自动截断。`}><Input.TextArea value={variant.descriptionRu || ''} maxLength={WB_DESCRIPTION_MAX_LENGTH} showCount autoSize={{ minRows: 4, maxRows: 10 }} onChange={(event) => patchVariant(variant.variantId, { descriptionRu: event.target.value })} /></Form.Item><CharacteristicFieldGroup key={`variant-fields-${variant.variantId}`} fields={fields} disabled={immutable} valueFor={(field) => characteristicToStrings(variant.characteristics.find((item) => item.id === field.characteristicId)?.value)} onChange={(field, value) => {
        if (field.characteristicId !== WB_COLOR_CHARACTERISTIC_ID) return patchVariant(variant.variantId, { characteristics: setCharacteristic(variant.characteristics, field.characteristicId, value) });
        const color = colors.find((item) => item.nameRu === value[0]);
        if (!color) return reconcileVariant(linkVariantToProductVariant(withColorCharacteristic(variant, value[0]), undefined, mediaRules.colorSupported));
        const matches = productVariants.filter((item) => item.wbColor?.colorKey === color.itemKey);
        const colored = withColorCharacteristic(variant, color.nameRu);
        reconcileVariant(matches.length === 1 ? linkVariantToProductVariant(colored, matches[0], mediaRules.colorSupported) : { ...linkVariantToProductVariant(colored, undefined, mediaRules.colorSupported), productVariantColor: colorIdentityFromDictionary(color) });
      }} /></Form>
      <SizeEditor sizes={variant.sizes} disabled={immutable} onChange={(sizes) => patchVariant(variant.variantId, { sizes })} /></>}
      <MediaAssignment listing={draft} variant={variant} immutable={immutable} onChange={onChange} />
    </div> : null }))} />}
  </Card>;
}

function SizeEditor({ sizes, disabled, onChange }: { sizes: Array<Record<string, unknown>>; disabled: boolean; onChange: (sizes: Array<Record<string, unknown>>) => void }) {
  const patch = (index: number, values: Record<string, unknown>) => onChange(sizes.map((size, sizeIndex) => sizeIndex === index ? { ...size, ...values } : size));
  return <div className="wb-size-editor"><div className="wb-section-title"><div><strong>尺码、条码与库存</strong><Text type="secondary">生成前每个变体至少添加一行；techSize 是商品标注尺码，wbSize 是对应的俄罗斯尺码。</Text></div><Button icon={<PlusOutlined />} disabled={disabled} onClick={() => onChange([...sizes, { sizeId: crypto.randomUUID(), techSize: '', wbSize: '', insoleLengthCm: undefined, barcode: '', stock: 0 }])}>添加尺码</Button></div>
    <Alert className="wb-size-api-note" showIcon type="info" message="WB 尺码表暂不能通过公开 Seller API 同步或绑定" description={<span>公开 Content API 只接受每行的 techSize、wbSize 和条码。标准尺码表仍需在 WB 卖家后台按类目选择；MerchRoute 会把这里填写的两种尺码原样提交。 <a href="https://seller.wildberries.ru/instructions/ru/uz/material/sizing-chart-in-item-card" target="_blank" rel="noreferrer">查看 WB 官方说明</a></span>} />
    {!sizes.length ? <Text type="warning">当前变体还没有尺码/库存行，暂时不能生成 product.json。</Text> : <div className="wb-size-list">{sizes.map((size, index) => <div className="wb-size-row" key={String(size.sizeId)}><span>{String(index + 1).padStart(2, '0')}</span><Input aria-label={`尺码 ${index + 1}`} disabled={disabled} value={String(size.techSize || '')} placeholder="techSize" onChange={(event) => patch(index, { techSize: event.target.value })} /><Input aria-label={`WB 俄码 ${index + 1}`} disabled={disabled} value={String(size.wbSize || '')} placeholder="wbSize（俄码）" onChange={(event) => patch(index, { wbSize: event.target.value })} /><InputNumber aria-label={`鞋垫长度 ${index + 1}`} disabled={disabled} min={0} value={typeof size.insoleLengthCm === 'number' ? size.insoleLengthCm : undefined} placeholder="鞋垫 cm" onChange={(value) => patch(index, { insoleLengthCm: value ?? undefined })} /><Input aria-label={`条码 ${index + 1}`} disabled={disabled} value={String(size.barcode || '')} placeholder="barcode（留空自动分配）" onChange={(event) => patch(index, { barcode: event.target.value })} /><InputNumber aria-label={`库存 ${index + 1}`} disabled={disabled} min={0} precision={0} value={Number(size.stock || 0)} placeholder="库存" onChange={(value) => patch(index, { stock: Number(value || 0) })} /><Button aria-label={`删除尺码 ${index + 1}`} danger type="text" icon={<DeleteOutlined />} disabled={disabled} onClick={() => onChange(sizes.filter((_, sizeIndex) => sizeIndex !== index))} /></div>)}</div>}
  </div>;
}

function MediaAssignment({ listing, variant, immutable, onChange }: { listing: WbListing; variant: WbVariant; immutable: boolean; onChange: (patch: Partial<WbListing>) => void }) {
  const [draggedId, setDraggedId] = useState<string>();
  const [sharedAsset, setSharedAsset] = useState<WbMediaAsset>();
  const [targetVariantIds, setTargetVariantIds] = useState<string[]>([]);
  const assignment = listing.variantMedia.find((item) => item.variantId === variant.variantId) || emptyVariantMedia(variant.variantId);
  const images = listing.mediaAssets.filter(isImage);
  const videos = listing.mediaAssets.filter(isVideo);
  const replaceAssignment = (next: WbVariantMedia) => onChange({ variantMedia: listing.variantMedia.some((item) => item.variantId === variant.variantId) ? listing.variantMedia.map((item) => item.variantId === variant.variantId ? next : item) : [...listing.variantMedia, next] });
  const toggleImage = (assetId: string) => replaceAssignment({ ...assignment, imageAssetIds: assignment.imageAssetIds.includes(assetId) ? assignment.imageAssetIds.filter((id) => id !== assetId) : [...assignment.imageAssetIds, assetId] });
  const applyToAll = (asset: WbMediaAsset) => onChange({ variantMedia: listing.variants.map((item) => {
    const current = listing.variantMedia.find((value) => value.variantId === item.variantId) || emptyVariantMedia(item.variantId);
    return isImage(asset) ? { ...current, imageAssetIds: current.imageAssetIds.includes(asset.assetId) ? current.imageAssetIds : [...current.imageAssetIds, asset.assetId] } : { ...current, videoAssetId: asset.assetId };
  }) });
  const openVariantAssignment = (asset: WbMediaAsset) => {
    setSharedAsset(asset);
    setTargetVariantIds(listing.variants.filter((item) => {
      const current = listing.variantMedia.find((value) => value.variantId === item.variantId) || emptyVariantMedia(item.variantId);
      return isImage(asset) ? current.imageAssetIds.includes(asset.assetId) : current.videoAssetId === asset.assetId;
    }).map((item) => item.variantId));
  };
  const applyToSelectedVariants = () => {
    if (!sharedAsset) return;
    const targets = new Set(targetVariantIds);
    onChange({ variantMedia: listing.variants.map((item) => {
      const current = listing.variantMedia.find((value) => value.variantId === item.variantId) || emptyVariantMedia(item.variantId);
      if (isImage(sharedAsset)) {
        const hasAsset = current.imageAssetIds.includes(sharedAsset.assetId);
        return targets.has(item.variantId)
          ? { ...current, imageAssetIds: hasAsset ? current.imageAssetIds : [...current.imageAssetIds, sharedAsset.assetId] }
          : { ...current, imageAssetIds: current.imageAssetIds.filter((assetId) => assetId !== sharedAsset.assetId) };
      }
      if (targets.has(item.variantId)) return { ...current, videoAssetId: sharedAsset.assetId };
      return current.videoAssetId === sharedAsset.assetId ? { ...current, videoAssetId: undefined } : current;
    }) });
    setSharedAsset(undefined);
  };
  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = [...assignment.imageAssetIds];
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    const moved = ids.splice(from, 1)[0];
    if (!moved) return;
    ids.splice(to, 0, moved);
    replaceAssignment({ ...assignment, imageAssetIds: ids });
  };
  const move = (assetId: string, direction: -1 | 1) => {
    const ids = [...assignment.imageAssetIds];
    const index = ids.indexOf(assetId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const current = ids[index];
    const next = ids[target];
    if (!current || !next) return;
    ids[index] = next;
    ids[target] = current;
    replaceAssignment({ ...assignment, imageAssetIds: ids });
  };
  const mediaGroups = [...listing.mediaAssets.reduce((groups, asset) => {
    const key = asset.productVariantName || '未识别变体';
    const items = groups.get(key) || [];
    items.push(asset);
    groups.set(key, items);
    return groups;
  }, new Map<string, WbMediaAsset[]>())];
  return <><div className="wb-media-workbench">
    <section className="wb-media-library"><div className="wb-section-title"><div><strong>共享媒体库</strong><Text type="secondary">文件只保存一份，可同时分配给多个变体。</Text></div><Space><Tag>{images.length} 图</Tag><Tag>{videos.length} 视频</Tag></Space></div>
      {!listing.mediaAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="variants 目录中还没有可用媒体，请先由审核工作台投递文件，再扫描目录。" /> : <div className="wb-media-groups">{mediaGroups.map(([groupName, groupAssets]) => <section className={`wb-media-variant-group${groupName === '未识别变体' ? ' is-unidentified' : ''}`} key={groupName}><div className="wb-media-variant-heading"><Space><strong>{groupName}</strong>{groupName === '未识别变体' ? <Tag color="warning">清单缺失或损坏</Tag> : <Tag color="cyan">产品变体</Tag>}{variant.productVariantName === groupName && <Tag color="green">当前 WB 变体已关联</Tag>}</Space><Text type="secondary">{groupAssets.length} 个媒体</Text></div><div className="wb-media-grid">{groupAssets.map((asset) => {
        const selected = isImage(asset) ? assignment.imageAssetIds.includes(asset.assetId) : assignment.videoAssetId === asset.assetId;
        return <article className={`wb-media-tile ${selected ? 'is-selected' : ''}`} key={asset.assetId}>
          <div className="wb-media-preview">{isImage(asset) ? <Image preview={{ src: api.wbMediaUrl(listing.sku, asset.assetId) }} src={`${api.wbMediaUrl(listing.sku, asset.assetId)}?thumbnail=true`} alt={asset.relativePath} /> : <div className="wb-video-placeholder"><VideoCameraOutlined /><span>MP4 / MOV</span></div>}</div>
          <Tooltip title={asset.relativePath}><strong>{asset.relativePath.split('/').pop()}</strong></Tooltip><Text type="secondary">{formatBytes(asset.sizeBytes)}{asset.sourceStageId ? ` · ${asset.sourceStageId}` : ''}</Text>
          <Checkbox disabled={immutable} checked={selected} onChange={() => isImage(asset) ? toggleImage(asset.assetId) : replaceAssignment({ ...assignment, videoAssetId: selected ? undefined : asset.assetId })}>{isImage(asset) ? '用于当前变体' : '设为当前视频'}</Checkbox>
          <Space size={6} wrap><Button size="small" disabled={immutable} onClick={() => openVariantAssignment(asset)}>应用到变体…</Button><Button size="small" disabled={immutable} onClick={() => applyToAll(asset)}>应用到全部变体</Button></Space>
        </article>;
      })}</div></section>)}</div>}
    </section>
    <section className="wb-media-selection"><div className="wb-section-title"><div><strong>{variant.vendorCode} 的图片顺序</strong><Text type="secondary">拖拽排序；第 1 张将作为该变体主图。</Text></div></div>
      {!assignment.imageAssetIds.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未为当前变体选择图片" /> : <List className="wb-selected-media" dataSource={assignment.imageAssetIds} renderItem={(assetId, index) => {
        const asset = listing.mediaAssets.find((item) => item.assetId === assetId);
        if (!asset) return null;
        return <List.Item draggable={!immutable} onDragStart={() => setDraggedId(assetId)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedId) reorder(draggedId, assetId); setDraggedId(undefined); }} actions={[<Button aria-label={`上移 ${asset.relativePath}`} type="text" icon={<ArrowUpOutlined />} disabled={immutable || index === 0} onClick={() => move(assetId, -1)} />, <Button aria-label={`下移 ${asset.relativePath}`} type="text" icon={<ArrowDownOutlined />} disabled={immutable || index === assignment.imageAssetIds.length - 1} onClick={() => move(assetId, 1)} />, <Button aria-label={`移除 ${asset.relativePath}`} danger type="text" icon={<DeleteOutlined />} disabled={immutable} onClick={() => toggleImage(assetId)} />]}><List.Item.Meta avatar={<span className={index === 0 ? 'wb-photo-number is-cover' : 'wb-photo-number'}>{index + 1}</span>} title={asset.relativePath.split('/').pop()} description={index === 0 ? '主图' : `图片 ${index + 1}`} /></List.Item>;
      }} />}
      <Divider orientation="left">产品视频</Divider>
      {assignment.videoAssetId ? <div className="wb-selected-video"><VideoCameraOutlined /><div><strong>{listing.mediaAssets.find((asset) => asset.assetId === assignment.videoAssetId)?.relativePath.split('/').pop()}</strong><Text type="secondary">同一个视频可被其他颜色变体复用</Text></div><Button danger type="text" disabled={immutable} onClick={() => replaceAssignment({ ...assignment, videoAssetId: undefined })}>移除</Button></div> : <Text type="secondary">当前变体未选择视频</Text>}
    </section>
  </div><Modal title={`分配媒体：${sharedAsset?.relativePath.split('/').pop() || ''}`} open={Boolean(sharedAsset)} okText="保存分配" cancelText="取消" okButtonProps={{ disabled: !sharedAsset }} onOk={applyToSelectedVariants} onCancel={() => setSharedAsset(undefined)}>
    <Paragraph type="secondary">同一文件可复用给多个变体；取消勾选会移除该文件与对应变体的分配关系，不会删除磁盘文件。</Paragraph>
    <Checkbox.Group className="wb-variant-assignment-options" value={targetVariantIds} onChange={(values) => setTargetVariantIds(values as string[])} options={listing.variants.map((item, index) => ({ value: item.variantId, label: item.vendorCode || `变体 ${index + 1}` }))} />
  </Modal></>;
}

function WbReadinessRail({ listing, publications, readiness, dirty, category }: { listing: WbListing; publications: WbStorePublication[]; readiness?: WbPublishingReadiness; dirty: boolean; category?: WbCategory }) {
  const mediaReady = listing.sourceMediaState !== 'CLEANED' && listing.variants.length > 0 && listing.variants.every((variant) => (listing.variantMedia.find((item) => item.variantId === variant.variantId)?.imageAssetIds.length || 0) > 0);
  const categoryReady = Boolean(category?.publishedVersion && category.projection.status === 'SYNCED');
  const fileReady = listing.status === 'GENERATED' && !dirty;
  const publicationSummary = summarizeWbPublications(publications);
  const steps = [
    { key: 'directory', title: '目录', ok: Boolean(readiness?.complete), detail: readiness?.complete ? '本机与 n8n 已同步' : '前往系统设置完成配置', icon: <FolderOpenOutlined /> },
    { key: 'file', title: '文件', ok: fileReady, detail: dirty ? '草稿已变化，需重新生成' : listing.generatedAt ? `生成于 ${dayjs(listing.generatedAt).format('MM-DD HH:mm')}` : '尚未生成 product.json', icon: <FileTextOutlined /> },
    { key: 'validation', title: '校验', ok: categoryReady && mediaReady, detail: listing.sourceMediaState === 'CLEANED' ? '公共媒体已清理，需重新投递' : !categoryReady ? '类目模板未发布同步' : !mediaReady ? '有变体尚未选择图片' : '类目与媒体完整', icon: <CheckCircleOutlined /> },
    { key: 'submit', title: '店铺发布', ok: publicationSummary.submitted, detail: publicationSummary.detail, icon: <CloudUploadOutlined /> }
  ];
  const score = steps.filter((step) => step.ok).length * 25;
  return <aside className="wb-readiness-rail"><div className="wb-rail-head"><span>RELEASE READINESS</span><Title level={4}>发布准备轨</Title><Progress percent={score} size="small" strokeColor="#16a4b2" /></div><div className="wb-rail-stops">{steps.map((step, index) => <div className={`wb-rail-stop ${step.ok ? 'is-ready' : ''}`} key={step.key}><i>{String(index + 1).padStart(2, '0')}</i><span>{step.icon}</span><div><strong>{step.title}</strong><Text type="secondary">{step.detail}</Text></div></div>)}</div>
    <Descriptions size="small" column={1} bordered items={[
      { key: 'revision', label: '修订', children: listing.revision ? `R${listing.revision}` : '尚未生成' },
      { key: 'draft', label: '草稿版本', children: listing.draftVersion },
      { key: 'folder', label: '资料目录', children: <code>{readiness?.rootDirectory ? `${readiness.rootDirectory}/inbox/${listing.sku}/variants` : '未配置'}</code> },
      { key: 'stores', label: '店铺发布记录', children: publicationSummary.total || '—' },
      { key: 'tasks', label: '独立任务', children: publicationSummary.taskCount || '—' }
    ]} />
    {!!publicationSummary.total && <Text className="wb-rail-publication-note" type="secondary">逐店任务、nmID、错误与更新时间请查看左侧“店铺发布结果”。</Text>}
  </aside>;
}

function WbCategoryRegistry() {
  const client = useQueryClient();
  const categories = useQuery({ queryKey: ['wb-categories'], queryFn: api.wbCategories, retry: false });
  const catalogStatus = useQuery({
    queryKey: ['wb-catalog-status'],
    queryFn: api.wbCatalogStatus,
    retry: false,
    refetchInterval: (query) => query.state.data?.catalog.status === 'SYNCING' ? 2_000 : false
  });
  const [editingKey, setEditingKey] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [subjectQuery, setSubjectQuery] = useState('');
  const [selectedSubject, setSelectedSubject] = useState<WbSubject>();
  const debouncedSubjectQuery = useDebouncedValue(subjectQuery.trim(), 250);
  const [createForm] = Form.useForm<{ categoryKey: string; nameRu: string; nameZh: string; subjectId: number }>();
  const selectedSubjectId = Form.useWatch('subjectId', createForm);
  const subjects = useQuery({
    queryKey: ['wb-subjects', debouncedSubjectQuery],
    queryFn: () => api.wbSubjects(debouncedSubjectQuery, 30),
    enabled: createOpen && debouncedSubjectQuery.length >= 2,
    retry: false,
    staleTime: 60_000
  });
  const subjectCandidates = selectedSubject ? [selectedSubject, ...(subjects.data?.items || [])] : (subjects.data?.items || []);
  const seenSubjectIds = new Set<number>();
  const subjectOptions = subjectCandidates.map((subject: WbSubject) => {
    return {
      value: subject.subjectId,
      label: `${bilingualLabel(subjectNameZh(subject), subjectNameRu(subject))} · ${bilingualLabel(parentNameZh(subject), parentNameRu(subject))} · subjectID ${subject.subjectId}`,
      subject
    };
  }).filter((option) => {
    if (!Number.isInteger(option.value) || option.value < 1 || seenSubjectIds.has(option.value)) return false;
    seenSubjectIds.add(option.value);
    return true;
  });
  const catalog = catalogStatus.data?.catalog;
  const statusMeta = catalog ? catalogStatusMeta[catalog.status] : catalogStatusMeta.EMPTY;
  const dictionaryCounts = catalog?.dictionaryCounts || { countries: 0, seasons: 0, kinds: 0, colors: catalog?.colorCount || 0 };
  const readyDictionaryCount = Object.values(dictionaryCounts).filter((count) => count > 0).length;
  const failure = catalogFailure(catalog);
  const syncCatalog = useMutation({
    mutationFn: api.syncWbCatalog,
    onSuccess: async (result) => {
      message[result.accepted ? 'success' : 'info'](result.accepted ? 'WB 目录同步已启动' : `同步任务 ${result.runId} 已在运行`);
      await client.invalidateQueries({ queryKey: ['wb-catalog-status'] });
    },
    onError: showError
  });
  useEffect(() => {
    if (!catalog?.lastSuccessfulAt) return;
    void client.invalidateQueries({ queryKey: ['wb-subjects'] });
  }, [catalog?.lastSuccessfulAt, client]);
  const create = useMutation({
    mutationFn: async (input: { categoryKey: string; nameRu: string; nameZh: string; subjectId: number }) => {
      const { liveSchema, schemaZh } = await fetchBilingualSubjectSchema(input.subjectId);
      const projection = projectWbBilingualSubjectSchema(liveSchema, schemaZh, [], input.subjectId);
      const formConfig: WbCategoryFormConfig = {
        fields: projection.fields,
        sizeMode: 'sized',
        media: { ...DEFAULT_WB_CATEGORY_MEDIA },
        compliance: projection.tnvedCharacteristicId
          ? { tnvedCharacteristicId: projection.tnvedCharacteristicId, tnvedRequired: projection.tnvedRequired }
          : { tnvedRequired: false }
      };
      const created = await api.createWbCategory({ ...input, liveSchema, formConfig });
      return { ...created, projection };
    },
    onSuccess: async ({ category, projection }) => { message.success(`类目 ${category.categoryKey} 已创建，已自动生成 ${projection.fields.length} 个属性字段`); setCreateOpen(false); setSubjectQuery(''); setSelectedSubject(undefined); createForm.resetFields(); setEditingKey(category.categoryKey); await client.invalidateQueries({ queryKey: ['wb-categories'] }); },
    onError: showError
  });
  const sync = useMutation({
    mutationFn: api.syncWbCategory,
    onSuccess: async ({ category }) => { message.success(`${category.nameRu} 已同步到 n8n`); await client.invalidateQueries({ queryKey: ['wb-categories'] }); },
    onError: showError
  });
  const remove = useMutation({
    mutationFn: api.deleteWbCategory,
    onSuccess: async ({ deletedCategoryKey, deletedCategory }) => {
      message.success(`${bilingualLabel(deletedCategory.nameZh, deletedCategory.nameRu)} 已从 MerchRoute 和 n8n 删除`);
      setEditingKey((current) => current === deletedCategoryKey ? undefined : current);
      await client.invalidateQueries({ queryKey: ['wb-categories'] });
      client.removeQueries({ queryKey: ['wb-category', deletedCategoryKey] });
    },
    onError: showError
  });
  if (categories.isError) return <Alert showIcon type="error" message="WB 类目模板加载失败" description={categories.error.message} action={<Button onClick={() => void categories.refetch()}>重试</Button>} />;
  const subjectSearchFeedback = (() => {
    if (subjectQuery.trim().length < 2) return <span>请输入至少 2 个中文/俄文字符或完整 subject ID</span>;
    if (subjectQuery.trim() !== debouncedSubjectQuery || subjects.isFetching) return <span>正在搜索本地目录…</span>;
    if (subjects.isError) {
      if (subjects.error instanceof ApiError && subjects.error.code === 'CATALOG_NOT_INITIALIZED') {
        const emptyFailure = catalog?.status === 'FAILED' ? failure : undefined;
        return <div className="wb-subject-search-state is-error"><strong>{emptyFailure?.title || '本地目录尚未初始化'}</strong><span>{emptyFailure?.description || '请先点击类目页的“立即同步”，同步完成后再搜索。'}</span></div>;
      }
      return <div className="wb-subject-search-state is-error"><strong>本地目录搜索失败</strong><span>{subjects.error instanceof ApiError ? subjects.error.userMessage : subjects.error.message}</span></div>;
    }
    if (!subjects.data?.items.length) return <div className="wb-subject-search-state"><strong>本地目录中没有匹配结果</strong><span>请尝试中文/俄文类目名称、父类目名称或 subject ID。</span></div>;
    return null;
  })();
  return <div className="wb-registry">
    <Card className={`wb-catalog-status is-${(catalog?.status || 'EMPTY').toLowerCase()}`} aria-live="polite">
      <div className="wb-catalog-status-main">
        <span className="wb-catalog-status-icon"><DatabaseOutlined /></span>
        <div>
          <Space size={8} wrap><strong>WB 中俄双语类目与字段字典</strong><Tag color={statusMeta.color}>{statusMeta.label}</Tag></Space>
          <Text type="secondary">
            {catalog?.status === 'SYNCING'
              ? `正在同步：父类目 ${catalog.currentRun?.processedParents || 0}/${catalog.currentRun?.totalParents || 0}，已读取 ${catalog.currentRun?.processedSubjects || 0} 个 subject`
              : catalog?.status === 'FAILED'
                ? `${failure.title}：${failure.description}`
                : catalog?.status === 'STALE'
                  ? '目录超过 8 天未成功更新；搜索继续使用上一版数据。'
                  : catalog?.status === 'READY'
                    ? '中文和俄文搜索均使用本地 PostgreSQL 索引，不会在输入时请求 WB。'
                    : '目录为空；服务启动时会自动补同步，也可以现在立即同步。'}
          </Text>
          {catalog?.status === 'FAILED' && catalog.lastError && <Text className="wb-catalog-error-detail" type="danger">{catalog.lastError}</Text>}
          {catalogStatus.isError && <Text className="wb-catalog-error-detail" type="danger">目录状态读取失败：{catalogStatus.error.message}</Text>}
        </div>
      </div>
      <div className="wb-catalog-metrics">
        <div><span>SUBJECT</span><strong>{catalog?.subjectCount ?? 0}</strong><small>本地条目</small></div>
        <div><span>FIELD DICT</span><strong>{readyDictionaryCount}/4</strong><small>国家 {dictionaryCounts.countries} · 季节 {dictionaryCounts.seasons} · 性别 {dictionaryCounts.kinds} · 颜色 {dictionaryCounts.colors}</small></div>
        <div><span>LAST SUCCESS</span><strong>{formatCatalogTime(catalog?.lastSuccessfulAt)}</strong><small>最近成功同步</small></div>
        <div><span><ClockCircleOutlined /> NEXT RUN</span><strong>{formatCatalogTime(catalog?.nextScheduledAt)}</strong><small>每周一 10:00 · Asia/Shanghai</small></div>
      </div>
      <Button className="wb-catalog-sync-button" type="primary" icon={<SyncOutlined spin={catalog?.status === 'SYNCING'} />} loading={syncCatalog.isPending} onClick={() => syncCatalog.mutate()}>立即同步</Button>
    </Card>
    <Alert showIcon type="info" message="类目字段直接对应 WB characteristic" description="product.json v2 保存原生 characteristic ID 与俄文值；mapping_json 只用于兼容历史 v1 任务，不参与本页创建的新资料。" />
    <Card className="wb-registry-toolbar"><Flex justify="space-between" align="center" wrap="wrap" gap={12}><div><strong>可扩展类目模板</strong><Text type="secondary">发布后同步到 n8n；新增电子、宠物等类目不需要修改工作流代码。</Text></div><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建类目模板</Button></Flex></Card>
    <Card bodyStyle={{ padding: 0 }}><Table<WbCategory> rowKey="categoryKey" loading={categories.isLoading} dataSource={categories.data?.items || []} pagination={false} scroll={{ x: 920 }} columns={[
      { title: '类目模板', width: 280, render: (_, item) => <div className="wb-category-cell"><strong>{bilingualLabel(item.nameZh, item.nameRu)}</strong><span className="mono-small">{item.categoryKey}</span></div> },
      { title: 'WB subject', width: 130, render: (_, item) => <Tag>#{item.subjectId}</Tag> },
      { title: '已发布版本', width: 140, render: (_, item) => item.publishedVersion ? <Tag color="green">V{item.publishedVersion.versionNo}</Tag> : <Tag>未发布</Tag> },
      { title: '草稿', width: 120, render: (_, item) => item.draftVersion ? <Tag color="gold">V{item.draftVersion.versionNo}</Tag> : <Text type="secondary">—</Text> },
      { title: 'n8n 投影', width: 150, render: (_, item) => { const meta = projectionMeta[item.projection?.status || 'NOT_SYNCED']; return <Tooltip title={item.projection?.lastError}><Tag color={meta.color}>{meta.label}</Tag></Tooltip>; } },
      { title: '复核', width: 170, render: (_, item) => item.publishedVersion?.confirmedBy ? <div><strong>{item.publishedVersion.confirmedBy}</strong><br /><Text type="secondary">{dayjs(item.publishedVersion.confirmedAt).format('YYYY-MM-DD HH:mm')}</Text></div> : <Text type="secondary">待发布复核</Text> },
      { title: '操作', width: 250, fixed: 'right', render: (_, item) => <Space size={4}><Button size="small" onClick={() => setEditingKey(item.categoryKey)}>编辑</Button><Button size="small" icon={<SyncOutlined />} loading={sync.isPending && sync.variables === item.categoryKey} disabled={!item.publishedVersion || remove.isPending} onClick={() => sync.mutate(item.categoryKey)}>同步</Button><Button size="small" danger type="text" icon={<DeleteOutlined />} loading={remove.isPending && remove.variables === item.categoryKey} disabled={sync.isPending} onClick={() => Modal.confirm({ title: `删除类目模板“${bilingualLabel(item.nameZh, item.nameRu)}”？`, content: '系统会先检查是否被上品资料或历史版本引用，然后同步删除 n8n Data Tables 中的对应投影。删除后不可恢复。', okText: '同步删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => remove.mutateAsync(item.categoryKey) })}>删除</Button></Space> }
    ]} /></Card>
    <Modal title="新建 WB 类目模板" open={createOpen} okText="创建草稿" confirmLoading={create.isPending} onCancel={() => { setCreateOpen(false); setSubjectQuery(''); setSelectedSubject(undefined); createForm.resetFields(); }} onOk={() => void createForm.validateFields().then((value) => create.mutate(value))}>
      <Form form={createForm} layout="vertical">
        <Form.Item label="category key" name="categoryKey" extra="稳定的内部标识，发布后不应修改。" rules={[{ required: true }, { pattern: /^[a-z][a-z0-9_]{2,63}$/, message: '使用小写字母、数字和下划线，以字母开头' }]}><Input placeholder="pet_accessories" /></Form.Item>
        <Form.Item label="搜索 WB subject" name="subjectId" extra="搜索本地目录：支持中文/俄文类目名、父类目名和 subject ID；选择后自动填写。" rules={[{ required: true, message: '请选择 WB subject' }]}>
          <Select
            aria-label="搜索 WB subject"
            showSearch
            allowClear
            filterOption={false}
            searchValue={subjectQuery}
            onSearch={setSubjectQuery}
            onClear={() => { setSelectedSubject(undefined); createForm.setFieldsValue({ subjectId: undefined, nameRu: '', nameZh: '' }); }}
            loading={subjects.isFetching || subjectQuery.trim() !== debouncedSubjectQuery}
            options={subjectOptions}
            placeholder="例如：背包、рюкзак 或 105"
            notFoundContent={subjectSearchFeedback}
            onSelect={(subjectId) => {
              const selected = subjectOptions.find((option) => option.value === Number(subjectId));
              if (selected) {
                setSelectedSubject(selected.subject);
                setSubjectQuery(bilingualLabel(subjectNameZh(selected.subject), subjectNameRu(selected.subject)));
                createForm.setFieldsValue({ subjectId: selected.value, nameRu: subjectNameRu(selected.subject), nameZh: subjectNameZh(selected.subject) });
              }
            }}
          />
        </Form.Item>
        <Form.Item label="WB subject ID"><InputNumber aria-label="WB subject ID" min={1} value={selectedSubjectId} disabled style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="中文类目名称" name="nameZh"><Input aria-label="中文类目名称" placeholder="选择 subject 后自动填写；旧目录可暂时留空" /></Form.Item>
        <Form.Item label="俄文类目名称" name="nameRu" rules={[{ required: true }]}><Input aria-label="俄文类目名称" placeholder="选择 subject 后自动填写，也可以按业务需要调整" /></Form.Item>
      </Form>
    </Modal>
    <WbCategoryEditor categoryKey={editingKey} onClose={() => setEditingKey(undefined)} onChanged={() => client.invalidateQueries({ queryKey: ['wb-categories'] })} />
  </div>;
}

function WbCategoryEditor({ categoryKey, onClose, onChanged }: { categoryKey?: string; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const detail = useQuery({ queryKey: ['wb-category', categoryKey], queryFn: () => api.wbCategory(categoryKey!), enabled: Boolean(categoryKey), retry: false });
  const [nameRu, setNameRu] = useState('');
  const [nameZh, setNameZh] = useState('');
  const [subjectId, setSubjectId] = useState<number>();
  const [formConfig, setFormConfig] = useState<WbCategoryFormConfig>(() => normalizedWbCategoryFormConfig());
  const [liveSchemaText, setLiveSchemaText] = useState('{}');
  const [projectionSummary, setProjectionSummary] = useState<WbSchemaProjection>();
  const [confirmedBy, setConfirmedBy] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    const category = detail.data?.category;
    if (!category) return;
    const version = category.versions?.find((item) => item.status === 'DRAFT') || category.versions?.find((item) => item.status === 'PUBLISHED');
    setNameRu(category.nameRu);
    setNameZh(category.nameZh || '');
    setSubjectId(category.subjectId);
    setFormConfig(normalizedWbCategoryFormConfig(structuredClone(version?.formConfig)));
    setLiveSchemaText(JSON.stringify(version?.liveSchema || {}, null, 2));
    setProjectionSummary(undefined);
  }, [detail.data]);
  const categoryDraftInput = () => {
    let liveSchema: unknown;
    try { liveSchema = JSON.parse(liveSchemaText); } catch { throw new Error('LIVE_SCHEMA_INVALID: live_schema_json 不是有效 JSON'); }
    const normalizedFormConfig = normalizeWbFormConfigCompliance(liveSchema, formConfig, subjectId);
    return { nameRu, nameZh, subjectId, liveSchema, formConfig: normalizedFormConfig };
  };
  const save = useMutation({
    mutationFn: () => api.saveWbCategoryDraft(categoryKey!, categoryDraftInput()),
    onSuccess: async () => { message.success('类目模板草稿已保存'); await detail.refetch(); await onChanged(); },
    onError: showError
  });
  const publish = useMutation({
    mutationFn: async () => { await api.saveWbCategoryDraft(categoryKey!, categoryDraftInput()); return api.publishWbCategory(categoryKey!, confirmedBy.trim()); },
    onSuccess: async () => { message.success('类目模板已发布，等待同步到 n8n'); setConfirmOpen(false); setConfirmedBy(''); await detail.refetch(); await onChanged(); },
    onError: showError
  });
  const sync = useMutation({
    mutationFn: () => api.syncWbCategory(categoryKey!),
    onSuccess: async () => { message.success('类目模板已同步到 n8n'); await detail.refetch(); await onChanged(); },
    onError: showError
  });
  const refreshSchema = useMutation({
    mutationFn: async () => {
      const { liveSchema: schema, schemaZh } = await fetchBilingualSubjectSchema(subjectId!);
      return { schema, projection: projectWbBilingualSubjectSchema(schema, schemaZh, formConfig.fields, subjectId) };
    },
    onSuccess: ({ schema, projection }) => {
      setLiveSchemaText(JSON.stringify(schema, null, 2));
      setFormConfig((current) => ({
        ...current,
        fields: projection.fields,
        compliance: projection.tnvedCharacteristicId
          ? { ...current.compliance, tnvedCharacteristicId: projection.tnvedCharacteristicId, tnvedRequired: projection.tnvedRequired }
          : { tnvedRequired: false }
      }));
      setProjectionSummary(projection);
      message.success(`已刷新 WB schema，并生成 ${projection.fields.length} 个可填写属性字段`);
    },
    onError: showError
  });
  const patchField = (fieldId: string, patch: Partial<WbFormField>) => setFormConfig((current) => ({ ...current, fields: current.fields.map((field) => field.fieldId === fieldId ? { ...field, ...patch } : field) }));
  const addField = () => setFormConfig((current) => ({ ...current, fields: [...current.fields, { fieldId: crypto.randomUUID(), characteristicId: 0, labelRu: '', labelZh: '', scope: 'shared', control: 'text', required: false, order: current.fields.length * 10 + 10 }] }));
  const moveFieldToTop = (fieldId: string) => setFormConfig((current) => {
    const fields = [...current.fields].sort((a, b) => a.order - b.order);
    const index = fields.findIndex((field) => field.fieldId === fieldId);
    if (index <= 0) return current;
    const [currentField] = fields.splice(index, 1);
    if (!currentField) return current;
    fields.unshift(currentField);
    return { ...current, fields: fields.map((field, fieldIndex) => ({ ...field, order: (fieldIndex + 1) * 10 })) };
  });
  if (!categoryKey) return null;
  const category = detail.data?.category;
  const projection = category?.projection;
  return <Drawer className="wb-category-drawer" open width="min(1180px, 98vw)" title={category ? <Space wrap><TagsOutlined /><strong>{bilingualLabel(category.nameZh, category.nameRu)}</strong><span className="mono-small">{category.categoryKey}</span>{projection && <Tag color={projectionMeta[projection.status].color}>{projectionMeta[projection.status].label}</Tag>}</Space> : '加载类目模板'} onClose={onClose} extra={<Space wrap><Button icon={<SaveOutlined />} loading={save.isPending} onClick={() => save.mutate()}>保存草稿</Button><Button icon={<CheckCircleOutlined />} disabled={!formConfig.fields.length} onClick={() => setConfirmOpen(true)}>发布并复核</Button><Button type="primary" icon={<SyncOutlined />} loading={sync.isPending} disabled={!category?.publishedVersion} onClick={() => sync.mutate()}>同步到 n8n</Button></Space>}>
    {detail.isLoading || !category ? <Skeleton active /> : detail.isError ? <Alert showIcon type="error" message="类目模板加载失败" description={detail.error.message} /> : <div className="wb-category-editor">
      <Alert showIcon type="info" message="product.json v2 直接保存 characteristic" description="这里配置的是字段本身及表单控件，不再配置业务路径到 WB 字段的 mapping_json。" />
      <Card title="类目身份"><Form layout="vertical"><Row gutter={14}><Col xs={24} md={7}><Form.Item label="中文类目名称"><Input value={nameZh} onChange={(event) => setNameZh(event.target.value)} placeholder="中文辅助显示" /></Form.Item></Col><Col xs={24} md={7}><Form.Item label="俄文类目名称" required><Input value={nameRu} onChange={(event) => setNameRu(event.target.value)} /></Form.Item></Col><Col xs={24} md={6}><Form.Item label="WB subject ID" required><InputNumber min={1} value={subjectId} onChange={(value) => setSubjectId(value || undefined)} /></Form.Item></Col><Col xs={24} md={4}><Form.Item label="实时字段"><Button block icon={<ReloadOutlined />} loading={refreshSchema.isPending} disabled={!subjectId} onClick={() => refreshSchema.mutate()}>刷新并生成</Button></Form.Item></Col></Row></Form></Card>
      <Card title="选填字段" extra={<Button icon={<PlusOutlined />} onClick={addField}>添加 characteristic</Button>}>
        {projectionSummary ? <Alert className="wb-schema-projection-summary" showIcon type="success" message={`已按 WB subject ${subjectId} 生成 ${projectionSummary.fields.length} 个可填写属性`} description={`WB 返回 ${projectionSummary.sourceCount} 项：新增 ${projectionSummary.addedCount} 项，保留人工配置 ${projectionSummary.retainedCount} 项${projectionSummary.removedCount ? `，移除 ${projectionSummary.removedCount} 个旧 subject 字段` : ''}；另有 ${projectionSummary.skipped.length} 项停用或由商品基础信息、包装及尺码区域管理。保存草稿后生效。`} /> : null}
        {!formConfig.fields.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未生成字段。点击“刷新并生成”读取当前 subject 的 WB 属性。" /> : <div className="wb-field-list">{[...formConfig.fields].sort((a, b) => a.order - b.order).map((field, index) => <div className="wb-field-row" key={field.fieldId}>
          <div className="wb-field-order"><span>{String(index + 1).padStart(2, '0')}</span><Button className="wb-field-pin" aria-label={`置顶 ${field.labelZh || field.labelRu || index + 1}`} size="small" type="text" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => moveFieldToTop(field.fieldId)}>置顶</Button></div>
          <div className="wb-field-controls"><InputNumber aria-label={`characteristic ID ${index + 1}`} min={1} value={field.characteristicId || undefined} placeholder="charcID" onChange={(value) => patchField(field.fieldId, { characteristicId: Number(value || 0) })} /><div className="wb-field-names"><Input aria-label={`中文字段名 ${index + 1}`} value={field.labelZh} placeholder="中文字段名" onChange={(event) => patchField(field.fieldId, { labelZh: event.target.value || undefined })} /><Input aria-label={`俄文字段名 ${index + 1}`} value={field.labelRu} placeholder="俄文字段名" onChange={(event) => patchField(field.fieldId, { labelRu: event.target.value })} /></div><Select aria-label={`字段范围 ${index + 1}`} value={field.scope} onChange={(scope) => patchField(field.fieldId, { scope })} options={[{ value: 'shared', label: '所有变体共享' }, { value: 'variant', label: '每个变体填写' }]} /><Select aria-label={`控件类型 ${index + 1}`} value={field.control} onChange={(control) => patchField(field.fieldId, { control })} options={[{ value: 'text', label: '文本' }, { value: 'number', label: '数字' }, { value: 'select', label: '单选字典' }, { value: 'multi-select', label: '多选字典' }, { value: 'boolean', label: '是 / 否' }]} /><Input aria-label={`WB 字典 ${index + 1}`} value={field.directory} placeholder="可选：字典名称" onChange={(event) => patchField(field.fieldId, { directory: event.target.value || undefined })} /></div>
          <Flex vertical align="center" gap={5}><Switch aria-label={`必填 ${index + 1}`} size="small" checked={field.required} onChange={(required) => patchField(field.fieldId, { required })} /><Text type="secondary">必填</Text><Button aria-label={`删除字段 ${index + 1}`} danger type="text" icon={<DeleteOutlined />} onClick={() => setFormConfig((current) => ({ ...current, fields: current.fields.filter((item) => item.fieldId !== field.fieldId) }))} /></Flex>
        </div>)}</div>}
      </Card>
      <Card title="媒体、尺码与合规规则"><Form layout="vertical"><Row gutter={14}><Col xs={12} md={4}><Form.Item label="最少图片"><InputNumber min={1} max={30} value={formConfig.media?.minImages ?? 1} onChange={(value) => setFormConfig((current) => patchWbCategoryMedia(current, { minImages: Number(value || 1) }))} /></Form.Item></Col><Col xs={12} md={4}><Form.Item label="最多图片"><InputNumber min={1} max={30} value={formConfig.media?.maxImages ?? 30} onChange={(value) => setFormConfig((current) => patchWbCategoryMedia(current, { maxImages: Number(value || 30) }))} /></Form.Item></Col><Col xs={12} md={3}><Form.Item label="允许视频"><Switch aria-label="允许视频" checked={formConfig.media?.videoAllowed ?? true} onChange={(videoAllowed) => setFormConfig((current) => patchWbCategoryMedia(current, { videoAllowed }))} /></Form.Item></Col><Col xs={12} md={5}><Form.Item label="默认视频上传方式" extra="仅对之后新建的上品资料生效。"><Select aria-label="默认视频上传方式" disabled={formConfig.media?.videoAllowed === false} value={formConfig.media?.defaultVideoUploadMode ?? 'COMPRESSED_COPY'} onChange={(defaultVideoUploadMode) => setFormConfig((current) => patchWbCategoryMedia(current, { defaultVideoUploadMode }))} options={[{ value: 'ORIGINAL', label: '使用原视频' }, { value: 'COMPRESSED_COPY', label: '使用压缩副本' }]} /></Form.Item></Col><Col xs={12} md={4}><Form.Item label="尺码模式" required><Select value={formConfig.sizeMode ?? 'sized'} onChange={(sizeMode) => setFormConfig({ ...formConfig, sizeMode })} options={[{ value: 'sized', label: '有尺码（techSize 必填）' }, { value: 'sizeless', label: '无尺码（单库存行）' }]} /></Form.Item></Col><Col xs={24} md={4}><Form.Item label="TNVED 属性 ID（自动识别）" extra="这是 WB characteristic ID，不是商品 TNVED 编码，无需手工填写。"><Input aria-label="TNVED 属性 ID" readOnly value={formConfig.compliance?.tnvedCharacteristicId ? `#${formConfig.compliance.tnvedCharacteristicId}` : '未检测到'} /></Form.Item></Col></Row></Form></Card>
      <Card title="WB 实时 schema 快照" className="wb-schema-card"><Alert showIcon type="warning" message="仅用于保存 WB 原始 schema 快照" description="业务人员通常不需要修改。字段显示和填写范围以上方选填字段配置为准。" /><Input.TextArea aria-label="WB 实时 schema JSON" className="wb-schema-json" value={liveSchemaText} onChange={(event) => setLiveSchemaText(event.target.value)} autoSize={{ minRows: 5, maxRows: 18 }} /></Card>
      {category.versions?.length ? <Card title="版本历史"><Space wrap>{category.versions.map((version) => <Tag key={version.id} color={version.status === 'PUBLISHED' ? 'green' : version.status === 'DRAFT' ? 'gold' : 'default'}>V{version.versionNo} · {version.status}</Tag>)}</Space></Card> : null}
    </div>}
    <Modal title="发布类目模板" open={confirmOpen} okText="确认发布" confirmLoading={publish.isPending} okButtonProps={{ disabled: !confirmedBy.trim() }} onCancel={() => setConfirmOpen(false)} onOk={() => publish.mutate()}><Alert showIcon type="warning" message="发布后形成不可变版本" description="请确认 subject、字段 ID、作用范围和媒体规则均已复核。发布后还需同步到 n8n 才能用于提交。" /><Form layout="vertical" className="wb-create-form"><Form.Item label="复核人员姓名" required><Input aria-label="复核人员姓名" value={confirmedBy} onChange={(event) => setConfirmedBy(event.target.value)} placeholder="填写实际复核人员" /></Form.Item></Form></Modal>
  </Drawer>;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
