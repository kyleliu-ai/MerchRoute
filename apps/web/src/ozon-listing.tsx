import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { OzonPublishRetry } from './ozon-retry';
import {
  ApiOutlined,
  AppstoreAddOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FormOutlined,
  LinkOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined,
  TagsOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
  WarningOutlined
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Flex,
  Form,
  Image,
  Input,
  InputNumber,
  List,
  message,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd';
import dayjs from 'dayjs';
import {
  OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS,
  OZON_MANUAL_PURCHASE_ATTRIBUTE_IDS,
  OZON_PUBLISH_JOB_STATES,
  OZON_PREPARATION_FANOUT_PHASES,
  OZON_PREPARATION_RECOVERY_MODES,
  OZON_DESCRIPTION_MAX_LENGTH,
  OZON_TITLE_MAX_LENGTH,
  OZON_TITLE_TRANSLATION_WORKFLOW_ID,
  classifyOzonImportFailures,
  ozonAutoJobCanCancel,
  ozonJobHasActiveLease,
  ozonJobHasRemoteProgress,
  projectOzonPresetRequiredAttributeCoverage,
  stableOzonOfferId,
  nextOzonVariantCode,
  ozonCategorySizeAttributeCandidates,
  validateOzonDescription,
  validateOzonTitle,
  type OzonActiveJobSummary,
  type OzonCategoryAttribute,
  type OzonDescriptionWarning,
  type OzonJobRecovery,
  type OzonListingDraft,
  type OzonListingDraftInput,
  type OzonGrossWeightResolution,
  type OzonManualPurchaseMeasurementProjection,
  type OzonManualPurchaseMeasurements,
  type OzonMediaAsset,
  type OzonNetworkRecovery,
  type OzonPresetInput,
  type OzonPresetRequiredAttributeCoverage,
  type OzonProductLink,
  type OzonPublicationTaskSummary,
  type OzonPublishJobState,
  type OzonSourceMediaCleanupSummary
} from '@n8n-media-review/shared';
import {
  api,
  ApiError,
  type OzonCategoryTemplate,
  type OzonCatalogDictionaryName,
  type OzonCatalogEntry,
  type OzonCatalogStatus,
  type OzonPlatformBusinessState,
  type OzonPlatformOfferDisplayState,
  type OzonPlatformOfferStatus,
  type OzonManualJobDetail,
  type OzonPreset,
  type OzonFanoutSummary,
  type OzonPreparationManualSuccessReconcilePlan,
  type OzonPreparationMaterialSnapshot,
  type OzonPublication,
  type OzonPublicationTaskDetail,
  type OzonPublishJob,
  type OzonReadiness,
  type ProcurementVersion
} from './api/client';
import { CopyValueButton } from './copy-value';
import { OzonPurchaseDateFilterControl } from './ozon-purchase-date-filter-control';
import {
  ozonPurchaseCreatedDateBounds,
  type OzonPurchaseDatePreset,
  type OzonPurchaseDateRange
} from './ozon-purchase-date-filter';
import { decodeDescriptionTxt } from './description-txt-utils';
import { applyOzonMediaSuggestions, type OzonMediaSuggestionReport } from './ozon-media-suggestions';
import { OzonPublicationDialog } from './ozon-publication-dialog';
import { OzonPublicationResults } from './ozon-publication-results';
import { isOzonPublicationActive, ozonPublicationStatusMeta } from './ozon-publication-results-utils';
import { OzonStoreSettingsDrawer } from './ozon-store-settings';
import { ozonAutoJobKey } from './ozon-store-settings-utils';
import {
  ozonAutomaticStateMeta,
  ozonAutomaticTaskPlatformState,
  ozonAutomaticTaskPrimaryState,
  ozonAutomaticTaskReason,
  ozonAutomaticTaskStatistics,
  ozonAutomaticTaskVersionMode
} from './ozon-automation-utils';
import './ozon-listing.css';

export { ozonAutomaticTaskStatistics } from './ozon-automation-utils';

const { Title, Text, Paragraph } = Typography;
type OzonView = 'auto' | 'manual' | 'categories' | 'presets';
export type OzonListingEditorContext =
  | { mode: 'MANUAL_DRAFT'; sku: string; initialManualJobId?: string }
  | { mode: 'AUTO_TASK_SNAPSHOT'; sku: string; jobId: string; storeId: string };
const OZON_VIDEO_SYSTEM_ATTRIBUTE_IDS = new Set([21837, 21841, 21845, 22273]);
const OZON_AUTOMATED_ATTRIBUTE_IDS = new Set([9048, 4180, 4191, 10097, ...OZON_VIDEO_SYSTEM_ATTRIBUTE_IDS]);
const OZON_PRESET_OFFER_EXAMPLE_COLOR_COUNT = 3;
const OZON_PURCHASE_ATTRIBUTE_ID_SET = new Set<number>(OZON_MANUAL_PURCHASE_ATTRIBUTE_IDS);
const OZON_WEIGHT_TO_GRAMS = { g: 1, kg: 1_000, lb: 453.59237 } as const;
type OzonPurchaseProjectionView = OzonManualPurchaseMeasurementProjection & { warning?: string };
type OzonLocalDictionaryBinding = {
  directory: OzonCatalogDictionaryName;
  dictionaryId?: number;
  storage: 'dictionary' | 'textRu';
};
const OZON_LOCAL_DICTIONARY_BY_ATTRIBUTE: Readonly<Record<number, OzonLocalDictionaryBinding>> = {
  4389: { directory: 'countries', storage: 'dictionary' },
  4495: { directory: 'seasons', storage: 'dictionary' },
  9163: { directory: 'kinds', storage: 'dictionary' },
  10096: { directory: 'colors', dictionaryId: 1494, storage: 'dictionary' },
  10097: { directory: 'colors', dictionaryId: 1494, storage: 'textRu' }
};

function ozonContentValidationError(issues: readonly string[]): Error {
  return new Error(`OZON 内容不符合规则：${issues.join('、')}`);
}

const ozonTitleContentValidator = async (_rule: unknown, value: unknown): Promise<void> => {
  const result = validateOzonTitle(value);
  if (!result.valid) throw ozonContentValidationError(result.issues);
};

const ozonDescriptionContentValidator = async (_rule: unknown, value: unknown): Promise<void> => {
  const result = validateOzonDescription(value);
  if (!result.valid) throw ozonContentValidationError(result.issues);
};

const ozonOptionalDescriptionContentValidator = async (_rule: unknown, value: unknown): Promise<void> => {
  if (value === undefined || value === null || value === '') return;
  await ozonDescriptionContentValidator(_rule, value);
};

function OzonDescriptionWarningAlerts({ warnings }: { warnings?: readonly OzonDescriptionWarning[] }) {
  const cleanupWarnings = (warnings || []).filter((warning) => warning.code === 'OZON_DESCRIPTION_CJK_REMOVED');
  const keywordWarnings = (warnings || []).filter((warning) => warning.code === 'OZON_DESCRIPTION_KEYWORD_STUFFING');
  return <>
    {!!cleanupWarnings.length && <Alert
      showIcon
      type="warning"
      message="历史详情清理记录"
      description={`该记录来自旧版本，不代表当前会自动清理：${cleanupWarnings.flatMap((warning) => warning.removedFragments).join('、')}`}
    />}
    {!!keywordWarnings.length && <Alert
      showIcon
      type="warning"
      message="详情重复词提醒"
      description={`检测到高密度重复词，系统已允许继续上品，请人工确认不是搜索词堆砌。字段：${keywordWarnings.map((warning) => warning.fieldPath).join('、')}`}
    />}
  </>;
}

function ozonGrossWeightResolution(initialization: OzonListingDraft['data']['initialization'] | undefined): OzonGrossWeightResolution | undefined {
  return initialization?.grossWeightResolution;
}

export function ozonDimensionsWithManagedGrossWeight(
  dimensions: OzonListingDraftInput['dimensions'],
  resolution: OzonGrossWeightResolution | undefined
): OzonListingDraftInput['dimensions'] {
  if (!dimensions || !resolution) return dimensions;
  return {
    ...dimensions,
    weight: resolution.effectiveGrossWeightGrams,
    weightUnit: 'g'
  };
}

export function normalizeOzonPresetDimensionsToGrams(dimensions: any): any {
  const source = dimensions || {};
  const unit = source.weightUnit as keyof typeof OZON_WEIGHT_TO_GRAMS | undefined;
  const weight = Number(source.weight);
  const multiplier = unit ? OZON_WEIGHT_TO_GRAMS[unit] : 1;
  return {
    ...source,
    ...(Number.isFinite(weight) ? { weight: Number((weight * multiplier).toFixed(8)) } : {}),
    weightUnit: 'g'
  };
}

const views: Array<{ key: OzonView; code: string; label: string; description: string; icon: React.ReactNode }> = [
  { key: 'auto', code: 'AUTO', label: '自动上品任务', description: '调度、阶段追踪与兼容性重试', icon: <ThunderboltOutlined /> },
  { key: 'manual', code: 'MANUAL', label: '手动上品资料', description: '产品身份、变体、详情与媒体顺序', icon: <FormOutlined /> },
  { key: 'categories', code: 'SCHEMA', label: '类目模板', description: '类目、属性、字典与版本快照', icon: <DatabaseOutlined /> },
  { key: 'presets', code: 'PRESET', label: '上品预设模板', description: '商品、定价、包装与媒体规则', icon: <TagsOutlined /> }
];

const jobStateMeta = ozonAutomaticStateMeta;

const listingStateMeta: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'default' },
  READY: { label: '资料就绪', color: 'cyan' },
  SUBMITTING: { label: '提交中', color: 'processing' },
  IMPORTED: { label: '已受理', color: 'blue' },
  MODERATING: { label: '正在上品', color: 'orange' },
  PUBLISHED: { label: '已发布', color: 'green' },
  NEEDS_ATTENTION: { label: '需要处理', color: 'volcano' },
  FAILED: { label: '失败', color: 'red' },
  CANCELLED: { label: '已取消', color: 'default' }
};

const stages = [
  ['01', '导入受理', 'import'],
  ['02', '平台审核', 'moderation'],
  ['03', '图片读回', 'images'],
  ['04', '产品视频/封面', 'video'],
  ['05', '价格生效', 'price'],
  ['06', '库存可售', 'stock']
] as const;

type OzonMaterialSnapshotReference = {
  id?: string;
  name?: string;
  rowVersion?: number;
  definitionHash?: string;
};

export type OzonMaterialSnapshotView = {
  schemaVersion: number | string;
  capturedAt?: string;
  preset: OzonMaterialSnapshotReference;
  category: {
    key?: string;
    versionId?: string;
    versionNo?: number;
    schemaHash?: string;
  };
  procurement: {
    versionId?: string;
    versionNo?: number;
    capturedAt?: string;
    productHeightCm?: number;
    productDepthCm?: number;
    productWidthCm?: number;
    netWeightGrams?: number;
  };
  packaging: {
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    grossWeightGrams?: number;
    grossWeightSource?: 'PROCUREMENT' | 'PRESET_FALLBACK';
  };
  pricing: {
    pricingTemplateId?: string;
    shippingTemplateId?: string;
    shippingServiceCode?: string;
    optionId?: string;
  };
  store: {
    storeAlias?: string;
    warehouseId?: string;
    currency?: string;
    fulfillmentMode?: string;
  };
  offers: { count?: number; ids: string[] };
  artifact: { revision?: number; signature?: string };
  warnings: string[];
};

export type OzonJobPlatformConsistency = {
  differenceStages: string[];
  warnings: string[];
};

const ozonStageLabels: Readonly<Record<string, string>> = {
  import: '导入受理',
  moderation: '平台审核',
  images: '图片读回',
  video: '产品视频/封面汇总',
  productVideo: '产品介绍视频',
  videoCover: '视频封面',
  price: '价格生效',
  stock: '库存可售'
};

function ozonUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function ozonSnapshotString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function ozonSnapshotNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function ozonSnapshotStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map(ozonSnapshotString));
}

/** Reads the immutable automatic-publishing material contract without trusting persisted JSON. */
export function ozonJobMaterialSnapshot(job: Pick<OzonPublishJob, 'payload'>): OzonMaterialSnapshotView | undefined {
  const payload = ozonUnknownRecord(job.payload);
  const source = ozonUnknownRecord(payload?.materialSnapshot);
  if (!source) return undefined;
  const schemaVersion = ozonSnapshotNumber(source.schemaVersion) ?? ozonSnapshotString(source.schemaVersion);
  if (schemaVersion === undefined) return undefined;

  const preset = ozonUnknownRecord(source.preset) || {};
  const category = ozonUnknownRecord(source.category) || {};
  const procurement = ozonUnknownRecord(source.procurement) || {};
  const packaging = ozonUnknownRecord(source.packaging) || {};
  const pricing = ozonUnknownRecord(source.pricing) || {};
  const store = ozonUnknownRecord(source.store) || {};
  const offers = ozonUnknownRecord(source.offers) || {};
  const artifact = ozonUnknownRecord(source.artifact) || {};
  const grossWeightSource = ozonSnapshotString(packaging.grossWeightSource);

  return {
    schemaVersion,
    ...(ozonSnapshotString(source.capturedAt) ? { capturedAt: ozonSnapshotString(source.capturedAt) } : {}),
    preset: {
      ...(ozonSnapshotString(preset.id) ? { id: ozonSnapshotString(preset.id) } : {}),
      ...(ozonSnapshotString(preset.name) ? { name: ozonSnapshotString(preset.name) } : {}),
      ...(ozonSnapshotNumber(preset.rowVersion) !== undefined ? { rowVersion: ozonSnapshotNumber(preset.rowVersion) } : {}),
      ...(ozonSnapshotString(preset.definitionHash) ? { definitionHash: ozonSnapshotString(preset.definitionHash) } : {})
    },
    category: {
      ...(ozonSnapshotString(category.key) ? { key: ozonSnapshotString(category.key) } : {}),
      ...(ozonSnapshotString(category.versionId) ? { versionId: ozonSnapshotString(category.versionId) } : {}),
      ...(ozonSnapshotNumber(category.versionNo) !== undefined ? { versionNo: ozonSnapshotNumber(category.versionNo) } : {}),
      ...(ozonSnapshotString(category.schemaHash) ? { schemaHash: ozonSnapshotString(category.schemaHash) } : {})
    },
    procurement: {
      ...(ozonSnapshotString(procurement.versionId) ? { versionId: ozonSnapshotString(procurement.versionId) } : {}),
      ...(ozonSnapshotNumber(procurement.versionNo) !== undefined ? { versionNo: ozonSnapshotNumber(procurement.versionNo) } : {}),
      ...(ozonSnapshotString(procurement.capturedAt) ? { capturedAt: ozonSnapshotString(procurement.capturedAt) } : {}),
      ...(ozonSnapshotNumber(procurement.productHeightCm) !== undefined ? { productHeightCm: ozonSnapshotNumber(procurement.productHeightCm) } : {}),
      ...(ozonSnapshotNumber(procurement.productDepthCm) !== undefined ? { productDepthCm: ozonSnapshotNumber(procurement.productDepthCm) } : {}),
      ...(ozonSnapshotNumber(procurement.productWidthCm) !== undefined ? { productWidthCm: ozonSnapshotNumber(procurement.productWidthCm) } : {}),
      ...(ozonSnapshotNumber(procurement.netWeightGrams) !== undefined ? { netWeightGrams: ozonSnapshotNumber(procurement.netWeightGrams) } : {})
    },
    packaging: {
      ...(ozonSnapshotNumber(packaging.lengthCm) !== undefined ? { lengthCm: ozonSnapshotNumber(packaging.lengthCm) } : {}),
      ...(ozonSnapshotNumber(packaging.widthCm) !== undefined ? { widthCm: ozonSnapshotNumber(packaging.widthCm) } : {}),
      ...(ozonSnapshotNumber(packaging.heightCm) !== undefined ? { heightCm: ozonSnapshotNumber(packaging.heightCm) } : {}),
      ...(ozonSnapshotNumber(packaging.grossWeightGrams) !== undefined ? { grossWeightGrams: ozonSnapshotNumber(packaging.grossWeightGrams) } : {}),
      ...(['PROCUREMENT', 'PRESET_FALLBACK'].includes(grossWeightSource || '') ? { grossWeightSource: grossWeightSource as 'PROCUREMENT' | 'PRESET_FALLBACK' } : {})
    },
    pricing: {
      ...(ozonSnapshotString(pricing.pricingTemplateId) ? { pricingTemplateId: ozonSnapshotString(pricing.pricingTemplateId) } : {}),
      ...(ozonSnapshotString(pricing.shippingTemplateId) ? { shippingTemplateId: ozonSnapshotString(pricing.shippingTemplateId) } : {}),
      ...(ozonSnapshotString(pricing.shippingServiceCode) ? { shippingServiceCode: ozonSnapshotString(pricing.shippingServiceCode) } : {}),
      ...(ozonSnapshotString(pricing.optionId) ? { optionId: ozonSnapshotString(pricing.optionId) } : {})
    },
    store: {
      ...(ozonSnapshotString(store.storeAlias) ? { storeAlias: ozonSnapshotString(store.storeAlias) } : {}),
      ...(ozonSnapshotString(store.warehouseId) ? { warehouseId: ozonSnapshotString(store.warehouseId) } : {}),
      ...(ozonSnapshotString(store.currency) ? { currency: ozonSnapshotString(store.currency) } : {}),
      ...(ozonSnapshotString(store.fulfillmentMode) ? { fulfillmentMode: ozonSnapshotString(store.fulfillmentMode) } : {})
    },
    offers: {
      ...(ozonSnapshotNumber(offers.count) !== undefined ? { count: ozonSnapshotNumber(offers.count) } : {}),
      ids: ozonSnapshotStrings(offers.ids)
    },
    artifact: {
      ...(ozonSnapshotNumber(artifact.revision) !== undefined ? { revision: ozonSnapshotNumber(artifact.revision) } : {}),
      ...(ozonSnapshotString(artifact.signature) ? { signature: ozonSnapshotString(artifact.signature) } : {})
    },
    warnings: ozonSnapshotStrings(source.warnings)
  };
}

export function ozonJobNetworkRecovery(job: Pick<OzonPublishJob, 'payload'>): OzonNetworkRecovery | undefined {
  const source = ozonUnknownRecord(ozonUnknownRecord(job.payload)?.networkRecovery);
  if (!source || source.schemaVersion !== 1 || source.status !== 'WAITING_NETWORK') return undefined;
  const attempt = ozonSnapshotNumber(source.attempt);
  const phase = ozonSnapshotString(source.phase);
  const resumeState = ozonSnapshotString(source.resumeState);
  const deliveryState = ozonSnapshotString(source.deliveryState);
  const firstFailureAt = ozonSnapshotString(source.firstFailureAt);
  const lastFailureAt = ozonSnapshotString(source.lastFailureAt);
  const nextAttemptAt = ozonSnapshotString(source.nextAttemptAt);
  const errorCode = ozonSnapshotString(source.errorCode);
  const errorMessage = ozonSnapshotString(source.errorMessage);
  if (!attempt || !phase || !resumeState || !deliveryState || !firstFailureAt || !lastFailureAt || !nextAttemptAt || !errorCode || !errorMessage) return undefined;
  if (!OZON_PUBLISH_JOB_STATES.includes(resumeState as OzonPublishJobState) || !['NOT_SENT', 'UNKNOWN', 'RESPONDED'].includes(deliveryState)) return undefined;
  return source as OzonNetworkRecovery;
}

/** Combines every persisted platform-difference source shown in automatic task details. */
export function ozonJobPlatformConsistency(job: Pick<OzonPublishJob, 'payload' | 'stageStates' | 'ozonProductLinks'>): OzonJobPlatformConsistency {
  const payload = ozonUnknownRecord(job.payload);
  const platformStatusRefresh = ozonUnknownRecord(payload?.platformStatusRefresh);
  const differenceStages = Object.entries(job.stageStates || {})
    .filter(([, value]) => String(value).toUpperCase() === 'DIFFERENCE')
    .map(([key]) => ozonStageLabels[key] || key);
  const linkWarnings = (Array.isArray(job.ozonProductLinks) ? job.ozonProductLinks : [])
    .flatMap((link) => ozonSnapshotStrings(ozonUnknownRecord(link)?.warnings));
  return {
    differenceStages: uniqueStrings(differenceStages),
    warnings: uniqueStrings([
      ...ozonSnapshotStrings(platformStatusRefresh?.warnings),
      ...linkWarnings
    ])
  };
}

export function OzonListingPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('view') as OzonView | null;
  const activeView = views.some((item) => item.key === requested) ? requested! : 'auto';
  const requestedJobId = params.get('job') || undefined;
  const requestedStoreId = params.get('store') || undefined;
  const requestedListingSku = params.get('listing') || undefined;
  const automationListingContext: OzonListingEditorContext | undefined = requestedJobId && requestedStoreId && requestedListingSku
    ? { mode: 'AUTO_TASK_SNAPSHOT', sku: requestedListingSku, jobId: requestedJobId, storeId: requestedStoreId }
    : undefined;
  const [takeoverListingSku, setTakeoverListingSku] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (params.get('settings') === '1') setSettingsOpen(true);
  }, [params]);

  const selectView = (view: OzonView) => {
    const next = new URLSearchParams(params);
    next.delete('job');
    next.delete('store');
    next.delete('listing');
    if (view === 'auto') next.delete('view');
    else next.set('view', view);
    setParams(next, { replace: true });
  };
  const closeJob = () => {
    const next = new URLSearchParams(params);
    next.delete('job');
    next.delete('store');
    next.delete('listing');
    setParams(next, { replace: true });
  };
  const openJob = (jobId: string, storeId: string) => {
    const next = new URLSearchParams(params);
    next.set('job', jobId);
    next.set('store', storeId);
    next.delete('listing');
    setParams(next, { replace: true });
  };
  const openAutomationListing = (context: Extract<OzonListingEditorContext, { mode: 'AUTO_TASK_SNAPSHOT' }>) => {
    const next = new URLSearchParams(params);
    next.set('job', context.jobId);
    next.set('store', context.storeId);
    next.set('listing', context.sku);
    setParams(next, { replace: true });
  };
  const closeAutomationListing = () => {
    const next = new URLSearchParams(params);
    next.delete('listing');
    setParams(next, { replace: true });
  };
  const openSettings = () => {
    const next = new URLSearchParams(params);
    next.set('settings', '1');
    setParams(next, { replace: true });
    setSettingsOpen(true);
  };
  const closeSettings = () => {
    const next = new URLSearchParams(params);
    next.delete('settings');
    setParams(next, { replace: true });
    setSettingsOpen(false);
  };
  const handleNavigationKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length;
    selectView(views[nextIndex]!.key);
    document.getElementById(`ozon-view-${views[nextIndex]!.key}`)?.focus();
  };

  return <div className="ozon-page">
    <section className="ozon-hero">
      <div>
        <span>OZON LISTING CONTROL</span>
        <Title level={2}>OZON 上品</Title>
        <Paragraph className="ozon-hero-description">从本地商品资料到平台可售状态，受理、审核、图片、价格与库存分别追踪。</Paragraph>
      </div>
      <div className="ozon-hero-actions">
        <div className="ozon-seal"><b>OZON</b><span>SELLER API</span></div>
        <Button ghost icon={<SettingOutlined />} aria-label="打开OZON上品设置" onClick={openSettings}>OZON上品设置</Button>
      </div>
    </section>

    <nav className="ozon-workspace-nav" role="tablist" aria-label="OZON 上品工作区">
      {views.map((item, index) => <button
        id={`ozon-view-${item.key}`}
        key={item.key}
        type="button"
        role="tab"
        aria-selected={activeView === item.key}
        className={activeView === item.key ? 'is-active' : ''}
        onClick={() => selectView(item.key)}
        onKeyDown={(event) => handleNavigationKey(event, index)}
      >
        <span className="ozon-nav-code">{item.code}</span>
        <span className="ozon-nav-icon">{item.icon}</span>
        <span><strong>{item.label}</strong><small>{item.description}</small></span>
      </button>)}
    </nav>

    <main role="tabpanel" aria-labelledby={`ozon-view-${activeView}`}>
      {activeView === 'auto' && <AutomaticJobsPanel initialJobId={requestedJobId} initialStoreId={requestedStoreId} onOpenJob={openJob} onCloseJob={closeJob} onOpenListing={openAutomationListing} onOpenManualListing={setTakeoverListingSku} />}
      {activeView === 'manual' && <ManualListingsPanel onOpenSettings={openSettings} />}
      {activeView === 'categories' && <CategoryTemplatesPanel />}
      {activeView === 'presets' && <PresetTemplatesPanel />}
    </main>
    <OzonStoreSettingsDrawer open={settingsOpen} onClose={closeSettings} />
    <ListingEditor
      context={automationListingContext || (takeoverListingSku ? { mode: 'MANUAL_DRAFT', sku: takeoverListingSku } : undefined)}
      onClose={() => automationListingContext ? closeAutomationListing() : setTakeoverListingSku(undefined)}
      onChanged={() => queryClient.invalidateQueries({ queryKey: ['ozon-listings'] })}
    />
  </div>;
}

function AutomaticJobsPanel({ initialJobId, initialStoreId, onOpenJob, onCloseJob, onOpenListing, onOpenManualListing }: {
  initialJobId?: string;
  initialStoreId?: string;
  onOpenJob: (jobId: string, storeId: string) => void;
  onCloseJob: () => void;
  onOpenListing: (context: Extract<OzonListingEditorContext, { mode: 'AUTO_TASK_SNAPSHOT' }>) => void;
  onOpenManualListing: (sku: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<string>();
  const [purchaseDatePreset, setPurchaseDatePreset] = useState<OzonPurchaseDatePreset>('ALL');
  const [customPurchaseDateRange, setCustomPurchaseDateRange] = useState<OzonPurchaseDateRange>(null);
  const [jobId, setJobId] = useState<string | undefined>(initialJobId);
  const [storeId, setStoreId] = useState<string | undefined>(initialStoreId);
  const [sharedMaterialOpen, setSharedMaterialOpen] = useState(false);
  const [retryActionContainer, setRetryActionContainer] = useState<HTMLSpanElement | null>(null);
  const platformStatusRequest = useRef<{ publicationId: string; requestId: string }>();
  const stopAutomationRequest = useRef<{ publicationId: string; requestId: string }>();
  const queryClient = useQueryClient();
  useEffect(() => {
    setJobId(initialJobId);
    setStoreId(initialStoreId);
  }, [initialJobId, initialStoreId]);
  const purchaseDateBounds = useMemo(
    () => ozonPurchaseCreatedDateBounds(purchaseDatePreset, customPurchaseDateRange),
    [customPurchaseDateRange, purchaseDatePreset]
  );
  const params = new URLSearchParams();
  params.set('businessOnly', 'true');
  if (query) params.set('query', query);
  if (state) params.set('state', state);
  if (purchaseDateBounds.purchaseCreatedFrom) params.set('purchaseCreatedFrom', purchaseDateBounds.purchaseCreatedFrom);
  if (purchaseDateBounds.purchaseCreatedTo) params.set('purchaseCreatedTo', purchaseDateBounds.purchaseCreatedTo);
  const jobs = useQuery({
    queryKey: ['ozon-auto-jobs', query, state, purchaseDateBounds.purchaseCreatedFrom, purchaseDateBounds.purchaseCreatedTo],
    queryFn: () => api.ozonJobs(params),
    refetchInterval: (result) => result.state.data?.items.some(ozonJobIsActive) ? 10_000 : false
  });
  const status = useQuery({ queryKey: ['ozon-automation-status'], queryFn: api.ozonAutomationStatus, refetchInterval: 30_000 });
  const stores = useQuery({ queryKey: ['ozon-stores'], queryFn: () => api.ozonStores(true), retry: false });
  const automaticJobList = ozonVisibleAutomaticJobList(jobs.data);
  const automaticJobs = automaticJobList.items;
  const automaticTotal = automaticJobList.total;
  const fallbackJob = automaticJobs.find((candidate) => candidate.id === jobId && (!storeId || ozonJobStoreId(candidate) === storeId));
  const effectiveStoreId = storeId || (fallbackJob ? ozonJobStoreId(fallbackJob) : undefined);
  const preparationSelected = ozonJobIsMultistorePreparation(fallbackJob);
  const selected = useQuery({
    queryKey: ['ozon-auto-job', effectiveStoreId, jobId],
    queryFn: () => api.ozonJob(jobId!, effectiveStoreId!),
    enabled: Boolean(jobId && effectiveStoreId && !preparationSelected),
    retry: false,
    refetchInterval: (result) => ozonJobIsActive(result.state.data?.job) ? 10_000 : false
  });
  const preparationDetail = useQuery({
    queryKey: ['ozon-preparation-task-detail', jobId],
    queryFn: () => api.ozonPreparationTaskDetail(jobId!),
    enabled: Boolean(jobId && preparationSelected),
    retry: false,
    refetchInterval: (result) => ozonJobIsActive(result.state.data?.job) ? 10_000 : false
  });
  const preparationMaterial = useQuery({
    queryKey: ['ozon-preparation-material-snapshot', jobId],
    queryFn: () => api.ozonPreparationMaterialSnapshot(jobId!),
    enabled: Boolean(jobId && preparationSelected && sharedMaterialOpen),
    retry: false
  });
  const job: OzonPublishJob | undefined = preparationDetail.data
    ? {
      ...preparationDetail.data.job,
      events: preparationDetail.data.events,
      fanoutSummary: preparationDetail.data.fanoutSummary
    }
    : selected.data?.job || fallbackJob;
  const detailLoading = preparationSelected ? preparationDetail.isLoading : selected.isLoading;
  const detailError = preparationSelected ? preparationDetail.error : selected.error;
  const sourceMediaCleanup = preparationSelected
    ? preparationDetail.data?.sourceMediaCleanup
    : selected.data?.sourceMediaCleanup;
  const refetchDetail = preparationSelected ? preparationDetail.refetch : selected.refetch;
  const listing = useQuery({
    queryKey: ['ozon-listing', 'AUTO_TASK_ENTRY', effectiveStoreId, jobId, job?.sku],
    queryFn: () => api.ozonListing(job!.sku),
    enabled: Boolean(jobId && job?.sku),
    retry: false
  });
  const invalidateJobQueries = (refreshedJob: OzonPublishJob) => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['ozon-auto-jobs'] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-auto-job', ozonJobStoreId(refreshedJob), refreshedJob.id] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-preparation-task-detail', refreshedJob.id] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-preparation-material-snapshot', refreshedJob.id] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-automation-status'] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-listing'] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-listings'] })
  ]);
  const cancel = useMutation({
    mutationFn: async (target: OzonPublishJob) => {
      const binding = ozonJobActionBinding(target);
      if (binding.kind === 'LEGACY') {
        const result = await api.cancelOzonJob(binding.jobId, binding.storeId);
        return { job: result.job, publication: undefined, automationStopped: false };
      }
      const current = await api.ozonPublication(binding.publicationId);
      const importFailure = classifyOzonImportFailures(target.payload);
      if (importFailure.blockerCode) {
        if (!stopAutomationRequest.current || stopAutomationRequest.current.publicationId !== binding.publicationId) {
          stopAutomationRequest.current = { publicationId: binding.publicationId, requestId: crypto.randomUUID() };
        }
        const result = await api.stopOzonPublicationAutomation(
          binding.publicationId,
          current.publication.rowVersion,
          stopAutomationRequest.current.requestId
        );
        return { job: target, publication: result.publication, automationStopped: true };
      }
      const result = await api.cancelOzonPublication(binding.publicationId, current.publication.rowVersion);
      return { job: target, publication: result.publication, automationStopped: false };
    },
    onSuccess: async (result) => {
      stopAutomationRequest.current = undefined;
      if (!result.publication) {
        queryClient.setQueryData(['ozon-auto-job', ozonJobStoreId(result.job), result.job.id], { job: result.job });
      }
      message.success(result.publication
        ? result.automationStopped
          ? `SKU ${result.job.sku} 的自动流程已取消；未调用 OZON 写接口`
          : `SKU ${result.job.sku} 的店铺 publication 已取消，上品资料已保留`
        : `SKU ${result.job.sku} 的自动上品任务已取消，上品资料已保留`);
      await invalidateJobQueries(result.job);
      if (result.publication) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['ozon-publication', result.publication.id] }),
          queryClient.invalidateQueries({ queryKey: ['ozon-publications'] })
        ]);
      }
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) stopAutomationRequest.current = undefined;
      showError(error);
    }
  });
  const syncPlatformStatus = useMutation({
    mutationFn: async (target: OzonPublishJob) => {
      if (!target.publicationId) throw new Error('当前任务缺少 publicationId，不能同步平台状态');
      const current = await api.ozonPublication(target.publicationId);
      if (!platformStatusRequest.current || platformStatusRequest.current.publicationId !== target.publicationId) {
        platformStatusRequest.current = { publicationId: target.publicationId, requestId: crypto.randomUUID() };
      }
      return api.refreshOzonPublicationPlatformStatus(
        target.publicationId,
        current.publication.rowVersion,
        platformStatusRequest.current.requestId
      );
    },
    onSuccess: async (_, target) => {
      platformStatusRequest.current = undefined;
      message.success(`SKU ${target.sku} 的 OZON 平台状态已同步；未执行上品或库存写入`);
      await invalidateJobQueries(target);
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) platformStatusRequest.current = undefined;
      showError(error);
    }
  });
  const manualTakeover = useMutation({
    mutationFn: async (target: { job: OzonPublishJob; listing: OzonListingDraft }) => api.takeOverOzonAutomaticPreparation(
      target.job.sku,
      target.job.id,
      { jobRowVersion: target.job.rowVersion, listingRowVersion: target.listing.rowVersion }
    ),
    onSuccess: async ({ job: takenOverJob, listing: takenOverListing }) => {
      message.success(`SKU ${takenOverListing.sku} 已转为手动上品资料，自动准备任务已停止`);
      await invalidateJobQueries(takenOverJob);
      closeJob();
      onOpenManualListing(takenOverListing.sku);
    },
    onError: showError
  });
  const manualSuccessReconcile = useMutation({
    mutationFn: async (target: OzonPublishJob) => {
      const { plan } = await api.ozonPreparationManualSuccessReconcilePlan(target.id, target.rowVersion);
      if (!plan.canReconcileManualSuccess) {
        throw new Error(plan.blockedReason || '当前手动发布成功证据不足，不能收口旧自动任务');
      }
      return api.reconcileOzonPreparationToManualSuccess(target.id, {
        rowVersion: plan.rowVersion,
        planHash: plan.planHash,
        requestId: plan.requestId
      });
    },
    onSuccess: async ({ job: reconciledJob, reconciliation }) => {
      message.success(`SKU ${reconciledJob.sku} 的旧自动任务已按 ${reconciliation.targetStores.length} 家店铺手动成功证据收口`);
      await invalidateJobQueries(reconciledJob);
    },
    onError: showError
  });
  const businessCounts = status.data?.businessCounts || status.data?.counts || {};
  const businessStatistics = ozonAutomaticTaskStatistics(businessCounts);
  const selectJob = (nextJob: OzonPublishJob) => {
    const nextStoreId = ozonJobStoreId(nextJob);
    setSharedMaterialOpen(false);
    setJobId(nextJob.id);
    setStoreId(nextStoreId);
    onOpenJob(nextJob.id, nextStoreId);
  };
  const closeJob = () => {
    setSharedMaterialOpen(false);
    setJobId(undefined);
    setStoreId(undefined);
    onCloseJob();
  };
  const openListing = () => {
    if (!job) return;
    if (ozonJobIsMultistorePreparation(job)) {
      setSharedMaterialOpen(true);
      return;
    }
    const targetStoreId = ozonJobStoreId(job);
    if (!targetStoreId) return;
    onOpenListing({ mode: 'AUTO_TASK_SNAPSHOT', sku: job.sku, jobId: job.id, storeId: targetStoreId });
  };
  const importFailure = classifyOzonImportFailures(job?.payload);
  const permanentFailureCanStop = Boolean(job?.publicationId
    && importFailure.blockerCode
    && ['NEEDS_ATTENTION', 'FAILED'].includes(job.state)
    && !ozonJobHasActiveLease(job)
    && ozonUnknownRecord(job.payload?.recoveryHold)?.active !== true);
  const platformStatusSyncAllowed = Boolean(permanentFailureCanStop && job?.state !== 'CANCELLED');
  const confirmCancel = () => {
    if (!job) return;
    const permanentFailure = Boolean(importFailure.blockerCode);
    Modal.confirm({
      title: `取消 SKU ${job.sku} 的自动上品任务？`,
      icon: <ExclamationCircleOutlined />,
      content: permanentFailure
        ? '只终止后续自动流程，保留商品映射、平台状态和重复卡错误证据；不会调用 OZON 商品、媒体、价格或库存写接口。'
        : '只停止尚未进入 OZON 远程执行的自动任务，并保留已经生成的上品资料。已经进入远程阶段的任务不能撤回。',
      okText: '取消自动任务',
      okButtonProps: { danger: true },
      cancelText: '继续保留',
      onOk: () => cancel.mutateAsync(job)
    });
  };
  const fanoutSummary = ozonJobFanoutSummary(job);
  const manualTakeoverAllowed = Boolean(job
    && listing.data?.listing
    && listing.data.listing.managementSource === 'AUTO'
    && ozonJobIsMultistorePreparation(job)
    && (fanoutSummary ? fanoutSummary.canManualTakeover : ['NEEDS_ATTENTION', 'FAILED'].includes(job.state)));
  const manualTakeoverDisabledReason = manualTakeoverAllowed
    ? undefined
    : '仅未进入店铺 publication 的失败共享准备任务可以转为手动处理';
  const confirmManualTakeover = () => {
    if (!job || !listing.data?.listing) return;
    Modal.confirm({
      title: `将 SKU ${job.sku} 转为手动处理？`,
      icon: <ExclamationCircleOutlined />,
      content: '系统会停止这条失败的自动准备任务，并把当前冻结资料移入“手动上品资料”。不会创建店铺 publication，也不会调用 OZON Seller API。',
      okText: '转为手动处理',
      cancelText: '继续自动处理',
      onOk: () => manualTakeover.mutateAsync({ job, listing: listing.data!.listing })
    });
  };
  const manualSuccessReconcilePlan = preparationDetail.data?.manualSuccessReconcilePlan;
  const manualSuccessReconcileAllowed = Boolean(job
    && ozonJobIsMultistorePreparation(job)
    && manualSuccessReconcilePlan?.canReconcileManualSuccess);
  const manualSuccessReconcileDisabledReason = manualSuccessReconcileAllowed
    ? undefined
    : manualSuccessReconcilePlan?.blockedReason || '需要全部当前参与自动上品的店铺均有完整手动成功证据';
  const confirmManualSuccessReconcile = () => {
    if (!job || !manualSuccessReconcilePlan) return;
    Modal.confirm({
      title: `按手动发布成功收口 SKU ${job.sku} 的旧自动任务？`,
      icon: <CheckCircleOutlined />,
      content: <Space direction="vertical" size={6}>
        <span>旧自动任务将标记为“已取消”，不会冒充自动上品成功，也不会调用 n8n 或 OZON。</span>
        <span>已核验店铺：{manualSuccessReconcilePlan.targetStores.map((target) => `${target.storeDisplayName}（${target.offerIds.length} 个 Offer）`).join('；')}</span>
        <span>现有手动任务、publication、商品映射和媒体账本保持不变。</span>
      </Space>,
      okText: '确认收口',
      cancelText: '保持现状',
      onOk: () => manualSuccessReconcile.mutateAsync(job)
    });
  };
  const listingDisabledReason = !job ? '任务详情加载后可打开上品资料' : undefined;
  const cancelAllowed = Boolean(job && (ozonAutoJobCanCancel(job) || permanentFailureCanStop));
  const cancelDisabledReason = !job
    ? '任务详情加载后可取消'
    : cancelAllowed
      ? undefined
      : ozonJobHasActiveLease(job)
        ? `任务正在运行，lease 占用至 ${dayjs(job.leaseExpiresAt).format('YYYY-MM-DD HH:mm:ss')}，释放后才能取消`
        : importFailure.blockerCode
          ? '永久失败任务正在执行其他恢复或状态同步操作，结束后才能取消自动流程'
          : ozonJobHasRemoteProgress(job)
          ? '任务已进入 OZON 远程执行，不能取消'
          : '当前状态不能取消自动任务';
  const automaticEnabled = Boolean(status.data?.acceptingNewJobs);
  const resetFilters = () => {
    setQuery('');
    setState(undefined);
    setPurchaseDatePreset('ALL');
    setCustomPurchaseDateRange(null);
  };
  return <div className="ozon-panel">
    <div className="ozon-workspace-alerts">
      {status.data && !status.data.managementEnabled && <Alert showIcon type="warning" message="OZON 上品管理未启用" description={`新的手动和自动任务均已停止；${status.data.continuingBoundJobs ? `已有 ${status.data.continuingBoundJobs} 个远程任务继续收尾。` : '当前没有需要继续收尾的远程任务。'}`} />}
      {status.data?.managementEnabled && stores.data && !stores.data.items.some((store) => !store.archivedAt && store.enabled && store.autoPublishEnabled) && <Alert showIcon type="info" message="自动上品未开启" description="当前没有已启用且参与自动上品的店铺；手动多店发布仍可使用。" />}
      {status.data?.managementEnabled && stores.data?.items.some((store) => !store.archivedAt && store.enabled && store.autoPublishEnabled && !store.readiness.ready) && <Alert showIcon type="warning" message="部分自动上品店铺尚未就绪" description="请在 OZON上品设置中检查该店铺的双凭据、Seller 权限、仓库与币种验证。已就绪店铺不受影响。" />}
      {status.data?.managementEnabled && stores.data?.items.some((store) => !store.archivedAt && store.enabled && store.autoPublishEnabled && store.readiness.ready) && <Alert showIcon type="success" message={`自动上品已启用 · ${stores.data.items.filter((store) => !store.archivedAt && store.enabled && store.autoPublishEnabled && store.readiness.ready).length} 家店铺可用`} description="新媒体投递会按店铺独立 fan-out；同一店铺串行，不同店铺可并行。" />}
    </div>
    <Card className={`ozon-console ozon-automation-console${automaticEnabled ? ' is-enabled' : ''}`}>
      <Flex className="ozon-automation-heading" justify="space-between" align="flex-start" gap={14} wrap="wrap">
        <div className="ozon-automation-title">
          <span className="ozon-automation-icon"><ThunderboltOutlined /></span>
          <div>
            <Space size={7} wrap>
              <strong>自动上品任务</strong>
              <Tag color={automaticEnabled ? 'green' : 'default'}>{automaticEnabled ? '正在接收新任务' : '停止接收新任务'}</Tag>
              {status.data?.worker.running && <Tag color="processing">协调器运行中</Tag>}
            </Space>
            <Text type="secondary">自动状态概括任务当前推进位置；导入、审核、媒体、价格与库存的完整阶段保留在任务详情中。</Text>
          </div>
        </div>
        <Button className="ozon-automation-refresh" icon={<ReloadOutlined />} loading={status.isFetching || jobs.isFetching} onClick={() => void Promise.all([status.refetch(), jobs.refetch()])}>刷新</Button>
      </Flex>

      <div className="ozon-automation-metrics" aria-label="OZON 自动上品任务统计">
        <OzonAutomaticMetric label="等待条件" value={businessStatistics.waiting} tone="waiting" />
        <OzonAutomaticMetric label="处理中" value={businessStatistics.processing} tone="processing" />
        <OzonAutomaticMetric label="需人工处理" value={businessStatistics.needsAttention} tone="attention" />
        <OzonAutomaticMetric label="成功任务" value={businessStatistics.succeeded} tone="success" />
      </div>

      <Flex className="ozon-filter ozon-auto-filter ozon-automation-filter" gap={10} align="center" wrap>
        <Input.Search aria-label="搜索 OZON 自动任务" allowClear value={query} placeholder="搜索自动任务 SKU 或 offer_id" onChange={(event) => setQuery(event.target.value)} className="ozon-search ozon-automation-search" />
        <OzonPurchaseDateFilterControl preset={purchaseDatePreset} customRange={customPurchaseDateRange} onPresetChange={(value) => { setPurchaseDatePreset(value); if (value !== 'CUSTOM') setCustomPurchaseDateRange(null); }} onCustomRangeChange={setCustomPurchaseDateRange} />
        <Select aria-label="筛选 OZON 自动上品状态" allowClear value={state} placeholder="全部状态" onChange={setState} options={Object.entries(jobStateMeta).map(([value, item]) => ({ value, label: item.label }))} />
        <Button disabled={!query && !state && purchaseDatePreset === 'ALL'} onClick={resetFilters}>重置</Button>
        <Text type="secondary" className="ozon-workspace-result-count">共 {automaticTotal} 个任务</Text>
      </Flex>
      <Table className="ozon-auto-jobs-table ozon-automation-table" rowKey={(record) => ozonAutoJobKey({ storeId: ozonJobStoreId(record), jobId: record.id })} size="small" loading={jobs.isLoading} dataSource={automaticJobs} scroll={{ x: 1660 }} pagination={false} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={automaticEnabled ? '暂无自动上品任务，等待新的 E004/E005 媒体投递。' : '自动上品未开启；历史媒体不会自动加入。'} /> }} onRow={(record) => ({
        tabIndex: 0,
        role: 'button',
        'aria-label': `查看 ${ozonJobStoreAlias(record) || ozonJobStoreId(record)} 店铺的自动任务 ${record.id}`,
        onClick: () => selectJob(record),
        onKeyDown: (event) => {
          if (!['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          selectJob(record);
        }
      })} columns={[
        { title: '店铺', width: 170, render: (_, record) => { if (ozonJobIsMultistorePreparation(record)) return <div className="ozon-auto-job-store"><strong title="共享资料准备">共享资料准备</strong><code>自动协调任务</code></div>; const store = stores.data?.items.find((item) => item.id === ozonJobStoreId(record)); const label = store?.displayName || ozonJobStoreAlias(record) || ozonJobStoreId(record); return <div className="ozon-auto-job-store"><strong title={label}>{label}</strong><code title={ozonJobStoreId(record)}>{store?.storeAlias || ozonJobStoreAlias(record) || ozonJobStoreId(record)}</code></div>; } },
        { title: 'SKU', dataIndex: 'sku', width: 170, render: (_, record) => <div><span className="copy-value-inline"><strong>{record.sku}</strong><CopyValueButton label="SKU" value={record.sku} /></span><Text type="secondary">{record.offerIds?.length ? `${record.offerIds.length} 个 Offer` : record.offerId || '等待生成 Offer'}</Text></div> },
        { title: '修订 / 方式', width: 170, render: (_, record) => <OzonAutomaticVersionMode job={record} /> },
        { title: '自动状态', dataIndex: 'state', width: 150, render: (_: OzonPublishJobState, record: OzonPublishJob) => <OzonJobStateTags job={record} /> },
        { title: '绑定预设', width: 190, render: (_, record) => <OzonFrozenPresetBinding binding={record.presetBinding} /> },
        { title: '当前说明', width: 310, render: (_, record) => <OzonAutomaticReason job={record} /> },
        { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: (value) => <span className="ozon-automation-time">{dayjs(value).format('YYYY-MM-DD HH:mm:ss')}</span> },
        { title: '操作', width: 110, fixed: 'right', render: (_, record) => <Button size="small" icon={<EyeOutlined />} onClick={(event) => { event.stopPropagation(); selectJob(record); }}>查看详情</Button> },
        { title: 'OZON 商品链接', width: 220, fixed: 'right', render: (_, record) => <OzonProductLinksCell links={ozonJobProductLinks(record)} offerIds={ozonJobOfferIds(record)} complete={record.state === 'SUCCEEDED'} /> }
      ]} />
    </Card>
    <Drawer
      className="ozon-drawer ozon-auto-job-drawer"
      width="min(720px, 96vw)"
      open={Boolean(jobId)}
      title={<Space className="ozon-auto-job-title" size={7} wrap><SafetyCertificateOutlined /><strong>自动上品详情</strong>{job && <OzonJobStateTags job={job} />}</Space>}
      onClose={closeJob}
      extra={job && <Space className="ozon-auto-job-actions" size={8}>
        <Tooltip title={listingDisabledReason}><span className="ozon-auto-job-action-tooltip"><Button icon={<FileTextOutlined />} loading={preparationSelected ? preparationMaterial.isFetching : listing.isLoading} disabled={Boolean(listingDisabledReason)} onClick={openListing}>{preparationSelected ? '打开公共素材' : '打开上品资料'}</Button></span></Tooltip>
        {ozonJobIsMultistorePreparation(job) && <Tooltip title={manualTakeoverDisabledReason}><span className="ozon-auto-job-action-tooltip"><Button icon={<FormOutlined />} loading={manualTakeover.isPending} disabled={!manualTakeoverAllowed} onClick={confirmManualTakeover}>转为手动处理</Button></span></Tooltip>}
        {ozonJobIsMultistorePreparation(job) && <Tooltip title={manualSuccessReconcileDisabledReason}><span className="ozon-auto-job-action-tooltip"><Button icon={<CheckCircleOutlined />} loading={manualSuccessReconcile.isPending} disabled={!manualSuccessReconcileAllowed} onClick={confirmManualSuccessReconcile}>按手动成功收口</Button></span></Tooltip>}
        {importFailure.blockerCode && <Tooltip title={platformStatusSyncAllowed ? '仅从 OZON 读取各变体当前状态，不执行上品、价格或库存写入' : '当前任务不能同步平台状态'}><span className="ozon-auto-job-action-tooltip"><Button icon={<SyncOutlined />} loading={syncPlatformStatus.isPending} disabled={!platformStatusSyncAllowed} onClick={() => job && syncPlatformStatus.mutate(job)}>同步平台状态</Button></span></Tooltip>}
        <span ref={setRetryActionContainer} />
        <Tooltip title={cancelDisabledReason}><span className="ozon-auto-job-action-tooltip"><Button danger icon={<StopOutlined />} loading={cancel.isPending} disabled={!cancelAllowed} onClick={confirmCancel}>取消自动任务</Button></span></Tooltip>
      </Space>}
    >
      {detailLoading && !job ? <Skeleton active /> : detailError && !job ? <Alert showIcon type="error" message="自动上品详情加载失败" description={detailError.message} action={<Button onClick={() => void refetchDetail()}>重试</Button>} /> : job ? <>
        {detailError && <Alert className="ozon-auto-job-fallback" showIcon type="warning" message="正在显示列表快照" description="完整事件暂时无法读取，可稍后重试。" action={<Button size="small" onClick={() => void refetchDetail()}>重试</Button>} />}
        <OzonSourceMediaCleanupStatus summary={sourceMediaCleanup} />
        <OzonPublishRetry key={job.id} job={job} actionContainer={retryActionContainer} stores={stores.data?.items || []} onOpenJob={(id, targetStoreId) => {
          setJobId(id); setStoreId(targetStoreId); onOpenJob(id, targetStoreId);
        }} />
        <JobDetail job={job} />
        {preparationDetail.data?.manualSuccessReconcilePlan && <OzonManualSuccessReconcilePlanDetails plan={preparationDetail.data.manualSuccessReconcilePlan} />}
      </> : null}
    </Drawer>
    <Drawer
      className="ozon-drawer ozon-shared-material-drawer"
      width="min(680px, 96vw)"
      open={sharedMaterialOpen}
      title={<Space size={7}><DatabaseOutlined /><strong>公共素材快照</strong>{job && <Tag>{job.sku}</Tag>}</Space>}
      onClose={() => setSharedMaterialOpen(false)}
    >
      {preparationMaterial.isLoading
        ? <Skeleton active />
        : preparationMaterial.isError
          ? <Alert showIcon type="error" message="公共素材快照读取失败" description={preparationMaterial.error.message} action={<Button onClick={() => void preparationMaterial.refetch()}>重新读取</Button>} />
          : preparationMaterial.data
            ? <OzonSharedMaterialSnapshotDetails snapshot={preparationMaterial.data.snapshot} />
            : null}
    </Drawer>
  </div>;
}

function OzonSharedMaterialSnapshotDetails({ snapshot }: { snapshot: OzonPreparationMaterialSnapshot['snapshot'] }) {
  const offers = Array.isArray(snapshot.data.offers) ? snapshot.data.offers : [];
  const mediaAssets = Array.isArray(snapshot.data.mediaAssets) ? snapshot.data.mediaAssets : [];
  const assetById = new Map(mediaAssets.map((asset) => [asset.assetId, asset]));
  const imageCount = mediaAssets.filter((asset) => asset.kind === 'image').length;
  const videoCount = mediaAssets.filter((asset) => asset.kind === 'video').length;
  return <Space direction="vertical" size={14} style={{ width: '100%' }}>
    <Alert
      showIcon
      type="info"
      message="这是共享素材的冻结版本"
      description="这里只展示商品身份、共享文案、变体与媒体顺序；类目、价格、库存、仓库及最终 Offer 会在逐店 publication 中按店铺预设生成。"
    />
    <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
      { key: 'sku', label: 'SKU', children: <code>{snapshot.sku}</code> },
      { key: 'revision', label: '素材 revision', children: snapshot.materialRevision || '—' },
      { key: 'name', label: '产品名称', span: 2, children: snapshot.productName || '—' },
      { key: 'version', label: '稳定版本 ID', span: 2, children: <code>{snapshot.generatedVersionId || '—'}</code> },
      { key: 'hash', label: '公共素材哈希', span: 2, children: <code>{snapshot.materialHash || '—'}</code> },
      { key: 'policy', label: '内容策略', children: snapshot.contentPolicyVersion || '—' },
      { key: 'media', label: '媒体', children: `${imageCount} 张图片 · ${videoCount} 个视频` },
      { key: 'description', label: '共享描述', span: 2, children: snapshot.data.descriptionRu || '—' }
    ]} />
    <Table
      className="ozon-shared-material-table"
      rowKey={(offer) => offer.variantId}
      size="small"
      pagination={false}
      scroll={{ x: 620 }}
      dataSource={offers}
      locale={{ emptyText: '暂无稳定产品变体' }}
      columns={[
        { title: '变体', width: 160, render: (_, offer) => <Space direction="vertical" size={1}><strong>{offer.productVariantName}</strong><code>{offer.variantId}</code></Space> },
        { title: '稳定产品身份', width: 180, render: (_, offer) => <code>{offer.productVariantId}</code> },
        { title: '媒体顺序', width: 280, render: (_, offer) => <Space direction="vertical" size={2}>{[...offer.media].sort((left, right) => left.sortOrder - right.sortOrder).map((item) => <span key={`${offer.variantId}-${item.assetId}`}><Tag>{item.sortOrder}</Tag>{assetById.get(item.assetId)?.relativePath || item.assetId}</span>)}</Space> }
      ]}
    />
  </Space>;
}

function ozonSnapshotDate(value?: string): string {
  if (!value) return '—';
  return dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : value;
}

function ozonSnapshotMetric(value: number | undefined, unit: string): string {
  return value === undefined ? '—' : `${value} ${unit}`;
}

function ozonSnapshotCode(value?: string | number) {
  return value === undefined ? <Text type="secondary">—</Text> : <Text code style={{ overflowWrap: 'anywhere' }}>{value}</Text>;
}

function OzonMaterialSnapshotDetails({ job }: { job: OzonPublishJob }) {
  const snapshot = ozonJobMaterialSnapshot(job);
  if (!snapshot) return <Alert
    showIcon
    type="info"
    message="历史任务未记录上品资料快照"
    description="该任务创建时尚未启用资料快照；可继续根据任务事件和平台状态进行排查。"
  />;

  const packagingDimensions = [snapshot.packaging.lengthCm, snapshot.packaging.widthCm, snapshot.packaging.heightCm]
    .every((value) => value === undefined)
    ? '—'
    : `${snapshot.packaging.lengthCm ?? '—'} × ${snapshot.packaging.widthCm ?? '—'} × ${snapshot.packaging.heightCm ?? '—'} cm`;
  const grossWeightSource = snapshot.packaging.grossWeightSource === 'PROCUREMENT'
    ? { label: '采购记录', color: 'green' }
    : snapshot.packaging.grossWeightSource === 'PRESET_FALLBACK'
      ? { label: '预设兜底', color: 'gold' }
      : undefined;
  const offerCount = snapshot.offers.count ?? snapshot.offers.ids.length;

  return <Card
    size="small"
    title={<Space size={7}><DatabaseOutlined /><span>上品资料快照</span></Space>}
    extra={<Tag color="blue">v{snapshot.schemaVersion}</Tag>}
  >
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
        { key: 'capturedAt', label: '快照时间', children: ozonSnapshotDate(snapshot.capturedAt) },
        { key: 'artifact', label: '产物修订', children: snapshot.artifact.revision === undefined ? '—' : `revision ${snapshot.artifact.revision}` },
        { key: 'preset', label: '上品预设', span: 2, children: <Space direction="vertical" size={2}>
          <span>{snapshot.preset.name || '—'}{snapshot.preset.rowVersion === undefined ? '' : ` · rowVersion ${snapshot.preset.rowVersion}`}</span>
          {ozonSnapshotCode(snapshot.preset.id)}
          {snapshot.preset.definitionHash && <span><Text type="secondary">定义指纹 </Text>{ozonSnapshotCode(snapshot.preset.definitionHash)}</span>}
        </Space> },
        { key: 'category', label: '类目版本', span: 2, children: <Space direction="vertical" size={2}>
          <span>{snapshot.category.key || '—'}{snapshot.category.versionNo === undefined ? '' : ` · v${snapshot.category.versionNo}`}</span>
          {ozonSnapshotCode(snapshot.category.versionId)}
          {snapshot.category.schemaHash && <span><Text type="secondary">类目指纹 </Text>{ozonSnapshotCode(snapshot.category.schemaHash)}</span>}
        </Space> },
        { key: 'procurementVersion', label: '采购版本', children: <Space direction="vertical" size={2}>
          <span>{snapshot.procurement.versionNo === undefined ? '—' : `v${snapshot.procurement.versionNo}`} · {ozonSnapshotDate(snapshot.procurement.capturedAt)}</span>
          {ozonSnapshotCode(snapshot.procurement.versionId)}
        </Space> },
        { key: 'procurementValues', label: '四项采购值', children: <Space direction="vertical" size={2}>
          <span>商品高 {ozonSnapshotMetric(snapshot.procurement.productHeightCm, 'cm')} · 商品深 {ozonSnapshotMetric(snapshot.procurement.productDepthCm, 'cm')}</span>
          <span>商品宽 {ozonSnapshotMetric(snapshot.procurement.productWidthCm, 'cm')} · 净重 {ozonSnapshotMetric(snapshot.procurement.netWeightGrams, 'g')}</span>
        </Space> },
        { key: 'packaging', label: '包装与毛重', span: 2, children: <Space direction="vertical" size={2}>
          <span>包装（长 × 宽 × 高） {packagingDimensions}</span>
          <Space size={6} wrap><span>毛重 {ozonSnapshotMetric(snapshot.packaging.grossWeightGrams, 'g')}</span>{grossWeightSource && <Tag color={grossWeightSource.color}>{grossWeightSource.label}</Tag>}</Space>
        </Space> },
        { key: 'pricing', label: '定价与物流', span: 2, children: <Space direction="vertical" size={2}>
          <span>定价模板 {ozonSnapshotCode(snapshot.pricing.pricingTemplateId)} · 物流模板 {ozonSnapshotCode(snapshot.pricing.shippingTemplateId)}</span>
          <span>服务渠道 {ozonSnapshotCode(snapshot.pricing.shippingServiceCode)}{snapshot.pricing.optionId && <> · 报价 {ozonSnapshotCode(snapshot.pricing.optionId)}</>}</span>
        </Space> },
        { key: 'store', label: '店铺与履约', span: 2, children: <Space size={[8, 4]} wrap>
          <Tag>店铺 {snapshot.store.storeAlias || '—'}</Tag><Tag>仓库 {snapshot.store.warehouseId || '—'}</Tag><Tag>{snapshot.store.fulfillmentMode || '—'}</Tag><Tag color="blue">{snapshot.store.currency || '—'}</Tag>
        </Space> },
        { key: 'offers', label: 'Offer', span: 2, children: <Space direction="vertical" size={2}>
          <span>共 {offerCount} 个 Offer</span>
          {snapshot.offers.ids.length ? <Text code style={{ overflowWrap: 'anywhere' }}>{snapshot.offers.ids.join(' · ')}</Text> : <Text type="secondary">未记录 Offer ID</Text>}
        </Space> },
        { key: 'signature', label: '产物签名', span: 2, children: ozonSnapshotCode(snapshot.artifact.signature) }
      ]} />
      {!!snapshot.warnings.length && <Alert
        showIcon
        type="warning"
        message={`快照记录了 ${snapshot.warnings.length} 条资料告警`}
        description={<Space direction="vertical" size={2}>{snapshot.warnings.map((warning) => <span key={warning}>• {warning}</span>)}</Space>}
      />}
    </Space>
  </Card>;
}

function OzonFanoutSummaryDetails({ job }: { job: OzonPublishJob }) {
  const summary = ozonJobFanoutSummary(job);
  if (!summary) return null;
  return <Card size="small" className={`ozon-fanout-summary${summary.failureCount ? ' has-failures' : ''}`} title="逐店 fan-out 协调状态">
    <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }} items={[
      { key: 'phase', label: '协调阶段', children: summary.phase },
      { key: 'stores', label: '目标店铺', children: summary.targetStoreCount },
      { key: 'publications', label: '已建 publication', children: summary.publicationCount },
      { key: 'failures', label: '失败店铺', children: <Tag color={summary.failureCount ? 'volcano' : 'green'}>{summary.failureCount}</Tag> },
      { key: 'recovery', label: '恢复方式', children: summary.recoveryMode || '按冻结计划回读' },
      { key: 'capabilities', label: '可用操作', children: <Space wrap>{summary.canRecheck && <Tag color="blue">可重检原任务</Tag>}{summary.canManualTakeover && <Tag>可转手动</Tag>}{summary.canReconcileManualSuccess && <Tag color="green">可按手动成功收口</Tag>}{!summary.canRecheck && !summary.canManualTakeover && !summary.canReconcileManualSuccess && <Text type="secondary">只读审计</Text>}</Space> }
    ]} />
    {summary.blockedReason && <Alert showIcon type="warning" message="协调任务被阻塞" description={summary.blockedReason} />}
  </Card>;
}

function OzonManualSuccessReconcilePlanDetails({ plan }: { plan: OzonPreparationManualSuccessReconcilePlan }) {
  return <Card size="small" title="手动成功收口证据">
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Alert
        showIcon
        type={plan.canReconcileManualSuccess ? 'success' : 'warning'}
        message={plan.canReconcileManualSuccess ? '全部当前参与店铺均已手动发布成功' : '当前证据不足，保持旧自动任务只读'}
        description={plan.canReconcileManualSuccess
          ? '仅可将旧自动准备任务标记为已取消；不会修改任何手动发布结果。'
          : plan.blockedReason || '请完成平台回读后重新检查。'}
      />
      {plan.targetStores.map((target) => <div key={target.storeId}>
        <Space size={6} wrap>
          <Tag color="green">{target.storeDisplayName}</Tag>
          <Text code>{target.storeAlias}</Text>
          <Text type="secondary">{target.offerIds.length} 个 Offer · {target.productLinks.length} 个已回读链接</Text>
        </Space>
      </div>)}
    </Space>
  </Card>;
}

function JobDetail({ job, recovery }: { job: OzonPublishJob; recovery?: OzonJobRecovery }) {
  const consistency = ozonJobPlatformConsistency(job);
  const networkRecovery = ozonJobNetworkRecovery(job);
  const archiveNotice = ozonJobArchiveNotice(job);
  const showPendingReason = !networkRecovery && !archiveNotice
    && (['NEEDS_ATTENTION', 'FAILED'].includes(job.state) || Boolean(job.lastErrorCode || job.lastErrorMessage));
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Descriptions bordered size="small" column={1} items={[
      { key: 'id', label: '任务 ID', children: <code>{job.id}</code> },
      { key: 'sku', label: '产品 SKU', children: <strong className="ozon-mono-small">{job.sku}</strong> },
      { key: 'state', label: '状态', children: <OzonJobStateTags job={job} /> },
      { key: 'import', label: 'OZON task_id', children: job.importTaskId || '—' },
      { key: 'store', label: '店铺标识', children: ozonJobStoreAlias(job) || '—' },
      { key: 'product', label: 'OZON 商品', children: <OzonProductLinksCell links={ozonJobProductLinks(job)} offerIds={ozonJobOfferIds(job)} complete={job.state === 'SUCCEEDED'} /> },
      { key: 'error', label: archiveNotice ? '平台状态' : '最近错误', children: archiveNotice ? '商品已归档并隐藏' : job.lastErrorMessage || '—' }
    ]} />
    {archiveNotice && <Alert
      showIcon
      type="info"
      message={archiveNotice.message}
      description={archiveNotice.description}
    />}
    {networkRecovery && <Alert
      showIcon
      type="info"
      message="网络中断，原上品任务将自动续跑"
      description={<Space direction="vertical" size={2}>
        <span>不会创建新任务、Offer 或 revision；当前保留阶段：{jobStateMeta[networkRecovery.resumeState]?.label || networkRecovery.resumeState}</span>
        <span>恢复阶段 {networkRecovery.phase} · 第 {networkRecovery.attempt} 次等待 · 下次检查 {dayjs(networkRecovery.nextAttemptAt).format('YYYY-MM-DD HH:mm:ss')}</span>
        {networkRecovery.deliveryState === 'UNKNOWN' && <span>上次写入结果未知，恢复后会先回读平台结果再决定是否补写。</span>}
      </Space>}
    />}
    {ozonJobIsMultistorePreparation(job) && <OzonFanoutSummaryDetails job={job} />}
    {showPendingReason && <Alert
      showIcon
      type={job.state === 'FAILED' ? 'error' : 'warning'}
      message={job.lastErrorCode ? `待处理原因 · ${job.lastErrorCode}` : '待处理原因'}
      description={job.lastErrorMessage || '任务已标记为需要处理，请结合任务事件确认原因。'}
    />}
    {(consistency.differenceStages.length > 0 || consistency.warnings.length > 0) && <Alert
      showIcon
      type="warning"
      message="平台一致性告警"
      description={<Space direction="vertical" size={2}>
        {!!consistency.differenceStages.length && <span>阶段差异：{consistency.differenceStages.join('、')}</span>}
        {consistency.warnings.map((warning) => <span key={warning}>• {warning}</span>)}
      </Space>}
    />}
    {ozonJobProductLinks(job).length > 0 && <OzonPlatformStatusLedger
      offerIds={ozonJobOfferIds(job)}
      links={ozonJobProductLinks(job)}
    />}
    <OzonMaterialSnapshotDetails job={job} />
    <div className="ozon-job-progress">{stages.map(([, label, key]) => <div key={key}><span>{label}</span><OzonJobStageState job={job} stage={key} /></div>)}</div>
    {recovery && recovery.offers.length > 0 && <OzonWriteRecoveryDetails recovery={recovery} />}
    <OzonVideoVerificationDetails job={job} />
    <List
      header={<strong>任务事件</strong>}
      dataSource={[...(job.events || [])].reverse()}
      locale={{ emptyText: '暂无事件' }}
      renderItem={(event) => <List.Item><List.Item.Meta title={<Space><Tag>{event.eventType}</Tag><span>{event.message}</span></Space>} description={`${dayjs(event.createdAt).format('YYYY-MM-DD HH:mm:ss')} · ${event.fromState || '—'} → ${event.toState || '—'}`} /></List.Item>}
    />
  </Space>;
}

export function ozonJobPrimaryStateMeta(job: Pick<OzonPublishJob, 'state' | 'ozonProductLinks'> & Partial<Pick<OzonPublishJob, 'offerIds' | 'payload'>>): { label: string; color: string } {
  return ozonAutomaticTaskPrimaryState(job);
}

export function ozonJobArchiveNotice(job: Pick<OzonPublishJob, 'ozonProductLinks'> & Partial<Pick<OzonPublishJob, 'state' | 'offerIds' | 'payload'>>): { message: string; description: string } | undefined {
  const platformState = ozonAutomaticTaskPlatformState({
    state: job.state || 'NEEDS_ATTENTION',
    ozonProductLinks: job.ozonProductLinks,
    offerIds: job.offerIds,
    payload: job.payload
  });
  const archivedLinks = (job.ozonProductLinks || []).filter((link) => link.displayState === 'ARCHIVED');
  if (!archivedLinks.length || !platformState || !['ARCHIVED', 'PARTIAL_ON_SALE'].includes(platformState.state)) return undefined;
  const platformMessages = uniqueStrings(archivedLinks.map((link) => link.platformMessage));
  if (platformState.state === 'PARTIAL_ON_SALE') {
    const archivedOfferIds = archivedLinks.map((link) => link.offerId).join('、');
    const onSaleOfferIds = (job.ozonProductLinks || []).filter((link) => link.displayState === 'ON_SALE').map((link) => link.offerId).join('、');
    return {
      message: 'OZON 商品部分可售',
      description: `平台回读显示 ${onSaleOfferIds} 已可售，${archivedOfferIds} 已经归档。自动流程状态与平台状态分别保留。${platformMessages.length ? ` OZON 原始说明：${platformMessages.join('；')}` : ''}`
    };
  }
  return {
    message: 'OZON 商品已经归档',
    description: `全部变体已经归档，买家端不可售。这是平台归档状态，不是库存写入失败。${platformMessages.length ? ` OZON 原始说明：${platformMessages.join('；')}` : ''}`
  };
}

function OzonJobStateTags({ job }: { job: Pick<OzonPublishJob, 'state' | 'payload' | 'ozonProductLinks'> & Partial<Pick<OzonPublishJob, 'offerIds'>> }) {
  const primaryState = ozonJobPrimaryStateMeta(job);
  const platformState = ozonAutomaticTaskPlatformState(job);
  return <Space size={4} wrap>
    <Tag color={primaryState.color}>{primaryState.label}</Tag>
    {platformState && platformState.label !== primaryState.label && <Tag color={platformState.color}>{platformState.label}</Tag>}
  </Space>;
}

function OzonAutomaticMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`ozon-automation-metric is-${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function OzonAutomaticVersionMode({ job }: { job: Pick<OzonPublishJob, 'revision' | 'payload' | 'publicationMode'> & { taskKind?: string } }) {
  const view = ozonAutomaticTaskVersionMode(job);
  return <div className="ozon-automation-version"><Tag color="blue">公共素材 {view.revisionLabel}</Tag><Text type="secondary">{view.modeLabel}</Text></div>;
}

function OzonFrozenPresetBinding({ binding }: { binding?: OzonPublishJob['presetBinding'] | OzonPublicationTaskSummary['presetBinding'] }) {
  if (!binding) return <Text type="secondary">—</Text>;
  return <div className="ozon-frozen-preset">
    <strong title={binding.presetName || '预设快照'}>{binding.presetName || '预设快照'}</strong>
    <Space size={4} wrap>
      {binding.presetRowVersion ? <Tag>R{binding.presetRowVersion}</Tag> : null}
      <Tag color="blue">已锁定快照</Tag>
      {!binding.sourcePresetExists && <Tag color="default">来源已删除</Tag>}
    </Space>
  </div>;
}

function OzonAutomaticReason({ job }: { job: OzonPublishJob }) {
  const reason = ozonAutomaticTaskReason(job);
  return <div className={`ozon-automation-reason is-${reason.tone}`} title={reason.text}>
    <span>{reason.text}</span>
    {(reason.detail || reason.nextAttemptAt) && <code>{[reason.detail, reason.nextAttemptAt ? `下次检查 ${dayjs(reason.nextAttemptAt).format('MM-DD HH:mm:ss')}` : undefined].filter(Boolean).join(' · ')}</code>}
  </div>;
}

function OzonWriteRecoveryDetails({ recovery }: { recovery: OzonJobRecovery }) {
  const status = (value: string) => {
    const meta = value === 'SUCCEEDED'
      ? { label: '成功', color: 'green' }
      : value === 'PENDING'
        ? { label: '等待重试', color: 'processing' }
        : value === 'FAILED'
          ? { label: '失败', color: 'red' }
          : { label: '待确认', color: 'default' };
    return <Tag color={meta.color}>{meta.label}</Tag>;
  };
  return <Card size="small" className="ozon-write-recovery-card" title="价格与库存恢复进度">
    <Flex gap={8} wrap="wrap" className="ozon-write-recovery-summary">
      <Tag>重试 {recovery.attempt}/{recovery.maxAttempts}</Tag>
      {recovery.nextAttemptAt && <Tag color="blue">下次检查 {dayjs(recovery.nextAttemptAt).format('MM-DD HH:mm:ss')}</Tag>}
      {recovery.deadlineAt && <Tag>恢复窗口至 {dayjs(recovery.deadlineAt).format('MM-DD HH:mm:ss')}</Tag>}
    </Flex>
    <Table
      rowKey="offerId"
      size="small"
      pagination={false}
      dataSource={recovery.offers}
      scroll={{ x: 520 }}
      columns={[
        { title: 'Offer ID', dataIndex: 'offerId', width: 150, render: (value: string) => <code>{value}</code> },
        { title: '价格', dataIndex: 'priceStatus', width: 90, render: status },
        { title: '库存', dataIndex: 'stockStatus', width: 100, render: status },
        { title: '平台结果', render: (_, row) => row.errors?.length
          ? <Space direction="vertical" size={2}>{row.errors.map((error, index) => <Text type="danger" key={`${error.operation}-${error.code}-${index}`}>{error.code} · {error.message}</Text>)}</Space>
          : <Text type="secondary">—</Text> }
      ]}
    />
  </Card>;
}

type OzonPublishJobWithMappings = OzonPublishJob & {
  offerIds?: string[];
  ozonProductLinks?: OzonProductLink[];
  storeAlias?: string;
};

type OzonProductLinkPlatformView = OzonProductLink & {
  displayState?: OzonPlatformOfferDisplayState;
  state?: OzonPlatformOfferDisplayState | string;
  status?: OzonPlatformOfferDisplayState | string;
  businessState?: OzonPlatformBusinessState;
  platformMessage?: string;
  statusName?: string;
  statusDescription?: string;
  moderateStatus?: string;
  validationStatus?: string;
  warnings?: string[];
  lastVerifiedAt?: string;
};

type OzonPlatformOfferView = {
  offerId: string;
  ozonProductId?: string;
  ozonSku?: string;
  url?: string;
  displayState: OzonPlatformOfferDisplayState;
  businessState?: OzonPlatformBusinessState;
  platformMessage?: string;
  warnings: string[];
  lastVerifiedAt?: string;
};

const ozonPlatformStateMeta: Record<OzonPlatformOfferDisplayState, { label: string; color: string; icon: React.ReactNode }> = {
  ON_SALE: { label: '已可售', color: 'green', icon: <CheckCircleOutlined /> },
  MODERATING: { label: '审核中', color: 'processing', icon: <ClockCircleOutlined /> },
  OUT_OF_STOCK: { label: '缺货', color: 'gold', icon: <WarningOutlined /> },
  NOT_FOR_SALE: { label: '商品已下架', color: 'volcano', icon: <LockOutlined /> },
  ERROR: { label: '异常', color: 'red', icon: <WarningOutlined /> },
  HIDDEN: { label: '隐藏', color: 'purple', icon: <LockOutlined /> },
  ARCHIVED: { label: '已经归档', color: 'default', icon: <DatabaseOutlined /> },
  NOT_FOUND: { label: '平台未找到', color: 'red', icon: <WarningOutlined /> },
  UNKNOWN: { label: '待确认', color: 'default', icon: <ClockCircleOutlined /> }
};

const ozonPlatformBusinessMeta: Record<OzonPlatformBusinessState, { label: string; color: string }> = {
  PUBLISHED: { label: '平台已发布', color: 'green' },
  MODERATING: { label: '平台审核中', color: 'processing' },
  NEEDS_ATTENTION: { label: '平台需处理', color: 'red' }
};

function ozonJobOfferIds(job: OzonPublishJob): string[] {
  const extended = job as OzonPublishJobWithMappings;
  const offerIds = Array.isArray(extended.offerIds) ? extended.offerIds : [];
  const payloadOfferIds = Array.isArray(job.payload?.offerIds) ? job.payload.offerIds.map(String) : [];
  return uniqueStrings([...offerIds, ...payloadOfferIds, ...(job.offerId ? [job.offerId] : []), ...ozonJobProductLinks(job).map((link) => link.offerId)]);
}

function ozonJobProductLinks(job: OzonPublishJob): OzonProductLink[] {
  const extended = job as OzonPublishJobWithMappings;
  const links = Array.isArray(extended.ozonProductLinks) ? extended.ozonProductLinks : [];
  return [...new Map(links.filter((link) => link.offerId && link.ozonSku && link.url).map((link) => [link.offerId, link])).values()];
}

function ozonJobStoreAlias(job: OzonPublishJob): string | undefined {
  return (job as OzonPublishJobWithMappings).storeAlias || (typeof job.payload?.storeAlias === 'string' ? job.payload.storeAlias : undefined);
}

function ozonJobStoreId(job: Pick<OzonPublishJob, 'storeId' | 'payload'>): string {
  const payloadStoreId = typeof job.payload?.storeId === 'string' ? job.payload.storeId.trim() : '';
  return String(job.storeId || payloadStoreId || '').trim() || '00000000-0000-4000-8000-000000000002';
}

export function ozonJobIsPublicationManaged(job?: Pick<OzonPublishJob, 'publicationId'>): boolean {
  return Boolean(String(job?.publicationId || '').trim());
}

export function ozonJobIsMultistorePreparation(
  job?: Pick<OzonPublishJob, 'payload' | 'publicationId'> & { taskKind?: string }
): boolean {
  if (job?.taskKind === 'SHARED_PREPARATION') return true;
  if (job?.taskKind === 'STORE_PUBLICATION' || job?.taskKind === 'LEGACY') return false;
  return job?.payload?.multistorePreparation === true && !ozonJobIsPublicationManaged(job);
}

export function ozonJobFanoutSummary(
  job?: Pick<OzonPublishJob, 'payload'> & { fanoutSummary?: OzonFanoutSummary }
): OzonFanoutSummary | undefined {
  const payload = ozonUnknownRecord(job?.payload);
  const source = ozonUnknownRecord(job?.fanoutSummary) || ozonUnknownRecord(payload?.fanoutSummary);
  if (!source) return undefined;
  const targetStoreCount = ozonSnapshotNumber(source.targetStoreCount);
  const publicationCount = ozonSnapshotNumber(source.publicationCount);
  const failureCount = ozonSnapshotNumber(source.failureCount);
  const phase = ozonSnapshotString(source.phase);
  const recoveryMode = ozonSnapshotString(source.recoveryMode);
  if (targetStoreCount === undefined || publicationCount === undefined || failureCount === undefined
    || !phase || !OZON_PREPARATION_FANOUT_PHASES.includes(phase as (typeof OZON_PREPARATION_FANOUT_PHASES)[number])
    || !recoveryMode || !OZON_PREPARATION_RECOVERY_MODES.includes(recoveryMode as (typeof OZON_PREPARATION_RECOVERY_MODES)[number])) return undefined;
  return {
    phase: phase as OzonFanoutSummary['phase'],
    targetStoreCount,
    publicationCount,
    failureCount,
    canRecheck: source.canRecheck === true,
    canManualTakeover: source.canManualTakeover === true,
    ...(source.canReconcileManualSuccess === true ? { canReconcileManualSuccess: true } : {}),
    recoveryMode: recoveryMode as OzonFanoutSummary['recoveryMode'],
    ...(ozonSnapshotString(source.blockedReason) ? { blockedReason: ozonSnapshotString(source.blockedReason) } : {})
  };
}

export function ozonVisibleAutomaticJobList(
  response?: Pick<{ items: OzonPublishJob[]; total: number }, 'items' | 'total'>
): { items: OzonPublishJob[]; total: number } {
  const responseItems = response?.items || [];
  const items = responseItems.filter((job) => job.source === 'AUTO' && !ozonJobIsMultistorePreparation(job));
  return { items, total: items.length };
}

export function ozonVisibleManualJobList(
  response?: Pick<{ items: OzonPublishJob[]; total: number }, 'items' | 'total'>
): { items: OzonPublishJob[]; total: number } {
  const responseItems = response?.items || [];
  const items = responseItems.filter((job) => job.source === 'MANUAL' && !ozonJobIsMultistorePreparation(job));
  const hiddenCount = responseItems.length - items.length;
  const total = Math.max(items.length, Math.max(0, (response?.total || 0) - hiddenCount));
  return { items, total };
}

export function ozonPublicationRemoteReadbackEnabled(settings?: { publicationReadbackEnabled?: boolean }): boolean {
  return settings?.publicationReadbackEnabled === true;
}

export function ozonSharedPreparationRecheckEntryAllowed(
  job: Pick<OzonPublishJob, 'state' | 'payload'>,
  fanoutSummary?: Pick<OzonFanoutSummary, 'canRecheck'>,
  frozenContract?: Record<string, unknown>
): boolean {
  const frozen = frozenContract && Object.keys(frozenContract).length
    ? frozenContract
    : ozonUnknownRecord(job.payload?.fanoutPlan);
  if (frozen && Object.keys(frozen).length) return fanoutSummary?.canRecheck === true;
  // PRE_PLAN has no fan-out contract yet. Its button only starts the read-only
  // recheck-plan proof; the POST endpoint repeats the proof and performs CAS.
  return ['NEEDS_ATTENTION', 'FAILED'].includes(job.state);
}

export function ozonPublicationRecheckInput(
  publication: Pick<OzonPublication, 'rowVersion' | 'planHash' | 'requestId'>,
  frozenContract?: Pick<OzonPublicationTaskDetail['frozenContract'], 'planHash' | 'requestId'>
): { rowVersion: number; planHash: string; requestId: string } | undefined {
  const planHash = String(publication.planHash || frozenContract?.planHash || '').trim();
  const requestId = String(publication.requestId || frozenContract?.requestId || '').trim();
  if (!Number.isInteger(publication.rowVersion) || publication.rowVersion < 1
    || !/^sha256:[a-f0-9]{64}$/.test(planHash)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return undefined;
  return { rowVersion: publication.rowVersion, planHash, requestId };
}

function requireOzonPublicationRecheckInput(
  publication: Pick<OzonPublication, 'rowVersion' | 'planHash' | 'requestId'>,
  frozenContract?: Pick<OzonPublicationTaskDetail['frozenContract'], 'planHash' | 'requestId'>
) {
  const input = ozonPublicationRecheckInput(publication, frozenContract);
  if (!input) throw new Error('publication 冻结合同缺少有效 planHash 或 requestId，已停止重检以避免新建身份或重复写入');
  return input;
}

export type OzonJobActionBinding =
  | { kind: 'PUBLICATION'; publicationId: string }
  | { kind: 'LEGACY'; jobId: string; storeId: string };

export function ozonJobActionBinding(
  job: Pick<OzonPublishJob, 'id' | 'publicationId' | 'storeId' | 'payload'>
): OzonJobActionBinding {
  const publicationId = String(job.publicationId || '').trim();
  return publicationId
    ? { kind: 'PUBLICATION', publicationId }
    : { kind: 'LEGACY', jobId: job.id, storeId: ozonJobStoreId(job) };
}

export type OzonManualJobDetailBinding =
  | { kind: 'PUBLICATION'; publicationId: string }
  | { kind: 'PURE_LEGACY'; jobId: string }
  | { kind: 'UNSUPPORTED'; reason: string };

export function ozonManualJobDetailBinding(
  job?: Pick<OzonPublishJob, 'id' | 'publicationId' | 'credentialBindingMode'>
): OzonManualJobDetailBinding {
  const publicationId = String(job?.publicationId || '').trim();
  if (publicationId) return { kind: 'PUBLICATION', publicationId };
  if (job?.credentialBindingMode === 'PURE_LEGACY') return { kind: 'PURE_LEGACY', jobId: job.id };
  return { kind: 'UNSUPPORTED', reason: '任务没有 publicationId，也未标记为 PURE_LEGACY；已停止调用迁移前详情接口' };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function ozonJobIsActive(job?: Pick<OzonPublishJob, 'state'>): boolean {
  return Boolean(job && !['SUCCEEDED', 'NEEDS_ATTENTION', 'FAILED', 'CANCELLED'].includes(job.state));
}

function ozonListingIsActive(listing?: Pick<OzonListingDraft, 'status'>): boolean {
  return Boolean(listing && ['SUBMITTING', 'IMPORTED', 'MODERATING'].includes(listing.status));
}

export function ozonManualListingDisplayStatus(
  listing: Pick<OzonListingDraft, 'sku' | 'revision' | 'status'>,
  publications: readonly Pick<OzonPublication, 'sku' | 'revision' | 'source' | 'status'>[]
): OzonListingDraft['status'] {
  const current = publications.filter((publication) => (
    publication.source === 'MANUAL'
    && publication.sku === listing.sku
    && publication.revision === listing.revision
  ));
  if (!current.length) return listing.status;
  const statuses = new Set(current.map((publication) => publication.status));
  if (current.every((publication) => publication.status === 'SUCCEEDED')) return 'PUBLISHED';
  if (statuses.has('NEEDS_ATTENTION') || statuses.has('PAUSED')) return 'NEEDS_ATTENTION';
  if (statuses.has('FAILED')) return 'FAILED';
  if (statuses.has('RUNNING')) return 'MODERATING';
  if (['PLANNED', 'MATERIALIZED', 'QUEUED'].some((status) => statuses.has(status as OzonPublication['status']))) return 'SUBMITTING';
  if (current.every((publication) => publication.status === 'CANCELLED')) return 'CANCELLED';
  if (statuses.has('SUCCEEDED')) return 'NEEDS_ATTENTION';
  return listing.status;
}

function normalizeOzonPlatformDisplayState(value: unknown): OzonPlatformOfferDisplayState {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized in ozonPlatformStateMeta) return normalized as OzonPlatformOfferDisplayState;
  if (['SELLING', 'SALE', 'PUBLISHED', 'AVAILABLE'].includes(normalized)) return 'ON_SALE';
  if (normalized.includes('MODERAT') || normalized.includes('PROCESS')) return 'MODERATING';
  if (normalized.includes('STOCK')) return 'OUT_OF_STOCK';
  if (normalized.includes('HIDDEN') || normalized.includes('BLOCK')) return 'HIDDEN';
  if (normalized.includes('ARCHIV')) return 'ARCHIVED';
  if (normalized.includes('NOT_FOUND')) return 'NOT_FOUND';
  if (normalized.includes('ERROR') || normalized.includes('FAIL') || normalized.includes('REJECT')) return 'ERROR';
  return 'UNKNOWN';
}

function ozonPlatformOfferViews({
  offerIds = [],
  links = [],
  statuses = [],
  refreshedAt
}: {
  offerIds?: string[];
  links?: OzonProductLink[];
  statuses?: OzonPlatformOfferStatus[];
  refreshedAt?: string;
}): OzonPlatformOfferView[] {
  const linksByOffer = new Map((links as OzonProductLinkPlatformView[]).map((link) => [link.offerId, link]));
  const statusesByOffer = new Map(statuses.map((status) => [status.offerId, status]));
  return uniqueStrings([...offerIds, ...links.map((link) => link.offerId), ...statuses.map((status) => status.offerId)]).map((offerId) => {
    const link = linksByOffer.get(offerId);
    const status = statusesByOffer.get(offerId);
    const platformMessage = status?.platformMessage
      || status?.statusName
      || status?.statusDescription
      || status?.validationStatus
      || status?.moderateStatus
      || link?.platformMessage
      || link?.statusName
      || link?.statusDescription
      || link?.validationStatus
      || link?.moderateStatus;
    return {
      offerId,
      ...(status?.ozonProductId || link?.ozonProductId ? { ozonProductId: status?.ozonProductId || link?.ozonProductId } : {}),
      ...(status?.ozonSku || link?.ozonSku ? { ozonSku: status?.ozonSku || link?.ozonSku } : {}),
      ...(link?.url ? { url: link.url } : {}),
      displayState: normalizeOzonPlatformDisplayState(status?.displayState || link?.displayState || link?.state || link?.status),
      ...(status?.businessState || link?.businessState ? { businessState: status?.businessState || link?.businessState } : {}),
      ...(platformMessage ? { platformMessage } : {}),
      warnings: uniqueStrings([...(status?.warnings || []), ...(link?.warnings || [])]),
      ...(status?.readAt || link?.lastVerifiedAt || refreshedAt ? { lastVerifiedAt: status?.readAt || link?.lastVerifiedAt || refreshedAt } : {})
    };
  });
}

function OzonPlatformStatusLedger({
  offerIds,
  links,
  compact = false,
  title = 'OZON 平台状态'
}: {
  offerIds?: string[];
  links?: OzonProductLink[];
  compact?: boolean;
  title?: string;
}) {
  const rows = ozonPlatformOfferViews({
    offerIds,
    links
  });
  const fallbackLastVerifiedAt = rows.map((row) => row.lastVerifiedAt).filter(Boolean).sort().at(-1);
  const lastVerifiedAt = fallbackLastVerifiedAt;
  const businessState = rows.find((row) => row.businessState)?.businessState;
  const businessMeta = businessState ? ozonPlatformBusinessMeta[businessState] : undefined;
  const warnings = uniqueStrings(rows.flatMap((row) => row.warnings));
  if (!rows.length) return <Text type="secondary">尚无可读回的 OZON 变体</Text>;
  return <section className={`ozon-platform-ledger${compact ? ' is-compact' : ''}`} aria-label={`${title}，共 ${rows.length} 个变体`}>
    <header>
      <div><ApiOutlined /><span><strong>{title}</strong><small>只读查询，不会重新导入，也不会修改价格、库存或媒体</small></span></div>
      <Space size={5} wrap>
        {businessMeta && <Tag color={businessMeta.color}>{businessMeta.label}</Tag>}
        <Tag>{rows.length} 个变体</Tag>
      </Space>
    </header>
    <div className="ozon-platform-ledger-rows">
      {rows.map((row) => {
        const meta = ozonPlatformStateMeta[row.displayState] || ozonPlatformStateMeta.UNKNOWN;
        return <article key={row.offerId} className={`is-${row.displayState.toLowerCase().replaceAll('_', '-')}`}>
          <div className="ozon-platform-offer-identity">
            <code>{row.offerId}</code>
            {row.url ? <a href={row.url} target="_blank" rel="noreferrer" aria-label={`打开 OZON 商品 ${row.ozonSku || row.ozonProductId || row.offerId}`}><LinkOutlined />{row.ozonSku || row.ozonProductId || '打开商品'}</a> : <small>{row.ozonSku || row.ozonProductId || '商品链接未同步'}</small>}
          </div>
          <Tag color={meta.color} icon={meta.icon}>{meta.label}</Tag>
          <div className="ozon-platform-offer-message">
            <span>{row.platformMessage || 'OZON 未返回补充说明'}</span>
            {!!row.warnings.length && <Tooltip title={row.warnings.join('；')}><Text type="warning"><WarningOutlined /> {row.warnings.length} 条告警</Text></Tooltip>}
          </div>
        </article>;
      })}
    </div>
    <footer>
      <Text type="secondary">共 {rows.length} 个变体 · 最后刷新：{lastVerifiedAt ? dayjs(lastVerifiedAt).format('YYYY-MM-DD HH:mm:ss') : '尚未执行只读刷新'}</Text>
      {!compact && !!warnings.length && <Text type="warning"><WarningOutlined /> {warnings.join('；')}</Text>}
    </footer>
  </section>;
}

function OzonProductLinksCell({ links = [], offerIds = [], complete = false }: { links?: OzonProductLink[]; offerIds?: string[]; complete?: boolean }) {
  const byOfferId = new Map(links.map((link) => [link.offerId, link]));
  const orderedOfferIds = uniqueStrings([...offerIds, ...links.map((link) => link.offerId)]);
  if (!orderedOfferIds.length) return complete ? <Text type="secondary">链接未同步</Text> : <Text type="secondary">—</Text>;
  return <div className="ozon-product-links" onClick={(event) => event.stopPropagation()}>
    <Text type="secondary" className="ozon-product-link-count">共 {orderedOfferIds.length} 个变体</Text>
    <div>
      {orderedOfferIds.map((offerId) => {
        const link = byOfferId.get(offerId);
        return link ? <a key={offerId} href={link.url} target="_blank" rel="noreferrer" aria-label={`打开 OZON 商品 ${link.ozonSku || link.ozonProductId}`}>
          <LinkOutlined /><span>{offerId}</span>
        </a> : <span className="ozon-product-link-missing" key={offerId}><code>{offerId}</code><small>{complete ? '链接未同步' : '等待同步'}</small></span>;
      })}
    </div>
  </div>;
}

function OzonPublicationState({ status }: { status: OzonPublicationTaskSummary['status'] }) {
  const meta = ozonPublicationStatusMeta[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

function OzonManualTaskReason({ summary }: { summary: OzonPublicationTaskSummary }) {
  const currentChanged = Boolean(summary.currentGeneratedVersionId)
    && summary.currentGeneratedVersionId !== summary.generatedVersionId;
  const defaultText: Record<OzonPublicationTaskSummary['status'], string> = {
    PLANNED: '店铺发布计划已冻结，等待生成发布包。',
    MATERIALIZED: '店铺发布包已生成，等待进入队列。',
    QUEUED: '店铺任务已入队，等待执行。',
    RUNNING: '正在向 OZON 提交并核对结果。',
    SUCCEEDED: '该店铺的商品已完成上品。',
    FAILED: '该店铺的上品任务失败。',
    NEEDS_ATTENTION: '该店铺任务需要人工检查。',
    PAUSED: '该店铺任务已暂停。',
    CANCELLED: '该店铺任务已取消。'
  };
  const tone = ['FAILED', 'NEEDS_ATTENTION'].includes(summary.status)
    ? 'attention'
    : summary.status === 'SUCCEEDED' ? 'success'
      : ['CANCELLED', 'PAUSED'].includes(summary.status) ? 'closed' : 'processing';
  return <div className={`ozon-automation-reason is-${tone}`}>
    <span>{summary.errorMessage || defaultText[summary.status]}</span>
    {summary.errorCode && <code>{summary.errorCode}</code>}
    {currentChanged && <small>当前公共素材已更新至 R{summary.currentMaterialRevision || '—'}；本行是上一次发布结果</small>}
    {summary.sourceMediaCleanup?.state === 'CLEANED' && <small>该发布版本的源媒体已清理，历史任务和成功包仍保留</small>}
    {summary.linkWarning && <small>{summary.linkWarning}</small>}
  </div>;
}

function OzonManualTaskLinks({ summary }: { summary: OzonPublicationTaskSummary }) {
  if (summary.productLinks.length) {
    return <OzonProductLinksCell
      links={summary.productLinks}
      offerIds={summary.offerIds}
      complete={summary.status === 'SUCCEEDED'}
    />;
  }
  if (!summary.legacyProductUrls.length) return <Text type="secondary">—</Text>;
  return <div className="ozon-product-links ozon-product-links-legacy" onClick={(event) => event.stopPropagation()}>
    <Text type="secondary" className="ozon-product-link-count">历史链接 · Offer 身份未冻结</Text>
    <div>{summary.legacyProductUrls.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">
      <LinkOutlined /><span>商品 {index + 1}</span>
    </a>)}</div>
  </div>;
}

function ManualListingsPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [query, setQuery] = useState('');
  const [effectiveQuery, setEffectiveQuery] = useState('');
  const [purchaseDatePreset, setPurchaseDatePreset] = useState<OzonPurchaseDatePreset>('ALL');
  const [customPurchaseDateRange, setCustomPurchaseDateRange] = useState<OzonPurchaseDateRange>(null);
  const [editorContext, setEditorContext] = useState<Extract<OzonListingEditorContext, { mode: 'MANUAL_DRAFT' }>>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createSku, setCreateSku] = useState<string>();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!query.trim()) { setEffectiveQuery(''); return; }
    const timeout = window.setTimeout(() => setEffectiveQuery(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);
  const purchaseDateBounds = useMemo(
    () => ozonPurchaseCreatedDateBounds(purchaseDatePreset, customPurchaseDateRange),
    [customPurchaseDateRange, purchaseDatePreset]
  );
  const params = new URLSearchParams();
  params.set('source', 'MANUAL');
  params.set('page', '1');
  params.set('pageSize', '100');
  if (effectiveQuery) params.set('query', effectiveQuery);
  if (purchaseDateBounds.purchaseCreatedFrom) params.set('purchaseCreatedFrom', purchaseDateBounds.purchaseCreatedFrom);
  if (purchaseDateBounds.purchaseCreatedTo) params.set('purchaseCreatedTo', purchaseDateBounds.purchaseCreatedTo);
  const readiness = useQuery({ queryKey: ['ozon-system'], queryFn: api.ozonSystem, retry: false });
  const listings = useQuery({
    queryKey: ['ozon-listings', params.toString()],
    queryFn: () => api.ozonListings(params),
    retry: false,
    refetchInterval: (result) => result.state.data?.items.some(ozonListingIsActive) ? 10_000 : false
  });
  const manualListingPublicationScope = useMemo(
    () => (listings.data?.items || []).map((item) => `${item.sku}:R${item.revision}`).sort().join('|'),
    [listings.data?.items]
  );
  const manualListingSkus = useMemo(
    () => [...new Set((listings.data?.items || []).map((item) => item.sku))],
    [listings.data?.items]
  );
  const publicationStatuses = useQuery({
    queryKey: ['ozon-publication-task-summaries', 'manual-list', manualListingPublicationScope],
    queryFn: () => api.ozonPublicationTaskSummaries(manualListingSkus),
    enabled: manualListingSkus.length > 0,
    retry: false,
    refetchInterval: (result) => result.state.data?.items.some(isOzonPublicationActive) ? 10_000 : false
  });
  const purchases = useQuery({ queryKey: ['ozon-product-options'], queryFn: () => api.purchases(new URLSearchParams({ page: '1', pageSize: '100' })), enabled: createOpen, retry: false });
  const create = useMutation({
    mutationFn: () => api.createOzonListing(createSku!),
    onSuccess: ({ listing, materialRevision, contentPolicyVersion }) => { message.success(`SKU ${listing.sku} 的公共素材 R${materialRevision || listing.revision} 已创建${contentPolicyVersion ? ` · ${contentPolicyVersion}` : ''}`); setCreateOpen(false); setCreateSku(undefined); setEditorContext({ mode: 'MANUAL_DRAFT', sku: listing.sku }); void queryClient.invalidateQueries({ queryKey: ['ozon-listings'] }); },
    onError: showError
  });
  const republish = useMutation({
    mutationFn: (summary: OzonPublicationTaskSummary) => api.republishOzonPublication(summary.publicationId, summary.rowVersion),
    onSuccess: ({ publication }) => {
      message.success(`${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot} 的重新上品任务已按原店铺创建`);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ozon-publication-task-summaries'] }),
        queryClient.invalidateQueries({ queryKey: ['ozon-publications'] }),
        queryClient.invalidateQueries({ queryKey: ['ozon-listings'] })
      ]);
    },
    onError: showError
  });
  const managementEnabled = Boolean(readiness.data?.settings.enabled);
  const localDirectoryReady = Boolean(readiness.data?.databaseReady && readiness.data?.mediaReady);
  const canCreate = managementEnabled && localDirectoryReady;
  const createDisabledReason = !managementEnabled ? '请先启用 OZON 上品管理' : !localDirectoryReady ? '请先完成 OZON 上品根目录配置' : undefined;
  const databaseUnavailable = listings.isError && listings.error.message.startsWith('DATABASE_UNAVAILABLE:');
  const manualListingBySku = new Map((listings.data?.items || []).map((item) => [item.sku, item]));
  const manualTaskRows = publicationStatuses.data?.items || [];
  const openManualTask = (summary: OzonPublicationTaskSummary) => setEditorContext({
    mode: 'MANUAL_DRAFT',
    sku: summary.sku,
    ...(summary.jobId ? { initialManualJobId: summary.jobId } : {})
  });
  return <div className="ozon-panel">
    <Card className="ozon-console ozon-manual-console">
      <Flex className="ozon-workspace-heading" justify="space-between" align="flex-start" gap={14} wrap="wrap">
        <div className="ozon-workspace-title"><span className="ozon-workspace-title-icon"><FileTextOutlined /></span><div><strong>手动上品任务</strong><Text type="secondary">每个店铺 publication 独立成行；公共素材仍通过工作台维护，未发布的素材不会生成任务占位行。</Text></div></div>
        <Tooltip title={createDisabledReason}><Button type="primary" icon={<PlusOutlined />} disabled={!canCreate} onClick={() => setCreateOpen(true)}>新建公共素材</Button></Tooltip>
      </Flex>
      <div className="ozon-workspace-alerts">
        {databaseUnavailable && <Alert showIcon type="warning" message="OZON 上品数据暂不可用" description="请先配置 PostgreSQL DATABASE_URL 并重启 MerchRoute 服务。" action={<Button onClick={() => void listings.refetch()}>重新检测</Button>} />}
        {!readiness.isLoading && !managementEnabled && <Alert showIcon type="warning" message="OZON 上品管理未启用" description="当前禁止新建、扫描媒体和创建店铺 publication；已有共享草稿仍可查看和编辑。" action={<Button onClick={onOpenSettings}>打开OZON上品设置</Button>} />}
        {!readiness.isLoading && managementEnabled && !localDirectoryReady && <Alert showIcon type="warning" message="OZON 产品资料目录尚未就绪" description="请先在“OZON上品设置”中配置并验证可读写的根目录。已有草稿仍可查看。" action={<Button onClick={onOpenSettings}>打开OZON上品设置</Button>} />}
        {publicationStatuses.isError && <Alert showIcon type="warning" message="逐店任务摘要暂不可用" description="为避免把公共素材误显示成店铺任务，摘要读取失败时不展示占位行。" action={<Button onClick={() => void publicationStatuses.refetch()}>重试</Button>} />}
      </div>
      {!databaseUnavailable && <>
        <Flex className="ozon-filter ozon-manual-filter" gap={10} align="center" wrap="wrap">
          <Input.Search aria-label="搜索手动上品资料" allowClear value={query} placeholder="搜索 SKU 或产品名称" onChange={(event) => setQuery(event.target.value)} onSearch={(value) => setEffectiveQuery(value.trim())} className="ozon-search" />
          <OzonPurchaseDateFilterControl preset={purchaseDatePreset} customRange={customPurchaseDateRange} onPresetChange={(value) => { setPurchaseDatePreset(value); if (value !== 'CUSTOM') setCustomPurchaseDateRange(null); }} onCustomRangeChange={setCustomPurchaseDateRange} />
          <Button disabled={!query && purchaseDatePreset === 'ALL'} onClick={() => { setQuery(''); setEffectiveQuery(''); setPurchaseDatePreset('ALL'); setCustomPurchaseDateRange(null); }}>重置</Button>
          <Text type="secondary" className="ozon-workspace-result-count">共 {publicationStatuses.data?.total || 0} 条逐店任务</Text>
        </Flex>
        <Table<OzonPublicationTaskSummary>
          className="ozon-manual-table ozon-manual-task-table"
          rowKey="publicationId"
          size="small"
          loading={listings.isLoading || (manualListingSkus.length > 0 && publicationStatuses.isLoading)}
          dataSource={manualTaskRows}
          pagination={false}
          scroll={{ x: 1690 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无逐店手动上品任务；未发布的公共素材不会显示在这里"><Button type="primary" disabled={!canCreate} onClick={() => setCreateOpen(true)}>新建或打开公共素材</Button></Empty> }}
          onRow={(record) => ({
            tabIndex: 0,
            role: 'button',
            'aria-label': `打开 ${record.storeDisplayName} 店铺的手动上品任务 ${record.publicationId}`,
            onClick: () => openManualTask(record),
            onKeyDown: (event) => {
              if (!['Enter', ' '].includes(event.key)) return;
              event.preventDefault();
              openManualTask(record);
            }
          })}
          columns={[
            { title: '店铺', width: 170, render: (_, record) => <div className="ozon-auto-job-store"><strong title={record.storeDisplayName}>{record.storeDisplayName}</strong><code title={record.storeId}>{record.storeAlias}</code></div> },
            { title: 'SKU', width: 190, render: (_, record) => <div><span className="copy-value-inline"><strong>{record.sku}</strong><CopyValueButton label="SKU" value={record.sku} /></span><Text type="secondary">{manualListingBySku.get(record.sku)?.productName || `${record.offerIds.length} 个 Offer`}</Text></div> },
            { title: '修订 / 方式', width: 170, render: (_, record) => <div className="ozon-automation-version"><Tag color="blue">发布 R{record.revision}</Tag><Text type="secondary">手动发布 · {record.publicationMode === 'COMPATIBLE_UPSERT' ? '兼容更新' : '仅创建'}</Text></div> },
            { title: '上品状态', width: 150, render: (_, record) => <OzonPublicationState status={record.status} /> },
            { title: '绑定预设', width: 190, render: (_, record) => <OzonFrozenPresetBinding binding={record.presetBinding} /> },
            { title: '当前说明', width: 330, render: (_, record) => <OzonManualTaskReason summary={record} /> },
            { title: '更新时间', width: 170, render: (_, record) => <span className="ozon-automation-time">{dayjs(record.updatedAt).format('YYYY-MM-DD HH:mm:ss')}</span> },
            { title: '操作', width: 180, fixed: 'right', render: (_, record) => <Space size={4} onClick={(event) => event.stopPropagation()}>
              <Button size="small" icon={<EyeOutlined />} onClick={() => openManualTask(record)}>打开工作台</Button>
              {record.capabilities.canRepublish ?
                <Popconfirm title={`按 ${record.storeDisplayName} 店铺重新上品？`} description="将绑定当前行的店铺和 publication，不会重新选择店铺。" disabled={!record.capabilities.canRepublish} onConfirm={() => republish.mutate(record)}>
                  <Button size="small" icon={<ReloadOutlined />} loading={republish.isPending && republish.variables?.publicationId === record.publicationId}>重新上品</Button>
                </Popconfirm>
                : <Tooltip title={record.capabilities.blockedReason}><span><Button size="small" icon={<ReloadOutlined />} disabled>重新上品</Button></span></Tooltip>}
            </Space> },
            { title: 'OZON 商品链接', width: 240, fixed: 'right', render: (_, record) => <OzonManualTaskLinks summary={record} /> }
          ]}
        />
      </>}
    </Card>
    <Modal title="选择 MerchRoute 产品" open={createOpen} okText="创建公共素材任务" confirmLoading={create.isPending} okButtonProps={{ disabled: !managementEnabled || !createSku }} onCancel={() => { setCreateOpen(false); setCreateSku(undefined); }} onOk={() => create.mutate()}>
      <Alert showIcon type="info" message="仅创建公共素材" description="SKU、产品变体、可共享详情和媒体作为公共素材保存；类目、标题、属性、价格、VAT、包装、规格、库存及 Offer 在选择店铺后按该店默认预设生成。" />
      <Form layout="vertical" className="ozon-create-form"><Form.Item label="产品 SKU" required><Select aria-label="产品 SKU" showSearch optionFilterProp="label" loading={purchases.isLoading} value={createSku} onChange={setCreateSku} placeholder="选择产品" options={(purchases.data?.items || []).map((item) => ({ value: item.sku, label: `${item.sku} · ${item.productName}` }))} /></Form.Item></Form>
    </Modal>
    <ListingEditor context={editorContext} onClose={() => setEditorContext(undefined)} onChanged={async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ozon-listings'] }),
        queryClient.invalidateQueries({ queryKey: ['ozon-publication-task-summaries'] })
      ]);
    }} />
  </div>;
}

function ListingEditor({ context, onClose, onChanged }: { context?: OzonListingEditorContext; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const sku = context?.sku;
  const editorContextKey = ozonListingEditorContextKey(context);
  const automaticSnapshotMode = context?.mode === 'AUTO_TASK_SNAPSHOT';
  const automaticContext = context?.mode === 'AUTO_TASK_SNAPSHOT' ? context : undefined;
  const initialManualJobId = context?.mode === 'MANUAL_DRAFT' ? context.initialManualJobId : undefined;
  const [form] = Form.useForm();
  const queryClient = useQueryClient();
  const descriptionFileRef = useRef<HTMLInputElement>(null);
  const [dirty, setDirty] = useState(false);
  const [activeOfferId, setActiveOfferId] = useState<string>();
  const [manualJobId, setManualJobId] = useState<string | undefined>(initialManualJobId);
  const [mediaSuggestionReport, setMediaSuggestionReport] = useState<OzonMediaSuggestionReport>();
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [sharedCheckPending, setSharedCheckPending] = useState(false);
  const editorSessionRef = useRef({ contextKey: editorContextKey, sku, sessionId: 0 });
  if (editorSessionRef.current.contextKey !== editorContextKey) {
    editorSessionRef.current = { contextKey: editorContextKey, sku, sessionId: editorSessionRef.current.sessionId + 1 };
  }
  const editorSessionId = editorSessionRef.current.sessionId;
  const dirtyRef = useRef(false);
  const autoInitializationAttempted = useRef<string>();
  const autoInitializationFinished = useRef<string>();
  const autoMediaScanAttempted = useRef<string>();
  const appliedSuggestionKey = useRef<string>();
  const offerIdentityKey = useRef<string>();
  const userTouchedInitializationFields = useRef<Set<string>>(new Set());
  const listing = useQuery({
    queryKey: ['ozon-listing', 'MANUAL_DRAFT', sku],
    queryFn: () => api.ozonListing(sku!),
    enabled: Boolean(sku && !automaticSnapshotMode),
    retry: false,
    refetchInterval: (result) => ozonJobIsActive(result.state.data?.activeJob) ? 10_000 : false
  });
  const automaticSnapshot = useQuery({
    queryKey: ['ozon-listing', 'AUTO_TASK_SNAPSHOT', automaticContext?.storeId, automaticContext?.jobId, sku],
    queryFn: () => api.ozonAutomaticListingSnapshot(automaticContext!.jobId, automaticContext!.storeId),
    enabled: Boolean(automaticSnapshotMode && sku),
    retry: false
  });
  const listingDetail = automaticSnapshotMode
    ? automaticSnapshot.data ? { listing: automaticSnapshot.data.snapshot.listing } : undefined
    : listing.data;
  const publications = useQuery({
    queryKey: ['ozon-publications', 'MANUAL_DRAFT', sku],
    queryFn: () => api.ozonPublications({ sku }),
    enabled: Boolean(sku && !automaticSnapshotMode),
    retry: false,
    refetchInterval: (result) => result.state.data?.items.some(isOzonPublicationActive) ? 10_000 : false
  });
  const purchaseMeasurementProjection = automaticSnapshotMode ? undefined : listing.data?.purchaseMeasurementProjection;
  const purchaseDetail = useQuery({ queryKey: ['purchase', sku], queryFn: () => api.purchase(sku!), enabled: Boolean(sku && !automaticSnapshotMode && listing.isSuccess && !purchaseMeasurementProjection), retry: false });
  const categories = useQuery({ queryKey: ['ozon-categories'], queryFn: api.ozonCategories, enabled: Boolean(sku), retry: false });
  const readiness = useQuery({ queryKey: ['ozon-system'], queryFn: api.ozonSystem, enabled: Boolean(sku), retry: false });
  const storeSettings = useQuery({ queryKey: ['ozon-settings'], queryFn: api.ozonSettings, enabled: Boolean(sku && !automaticSnapshotMode), retry: false });
  const selectedCategoryKey = Form.useWatch('categoryKey', form) as string | undefined;
  const watchedOffers = (Form.useWatch('offers', form) || []) as any[];
  const selectedCategory = categories.data?.items.find((item) => item.categoryKey === selectedCategoryKey);
  const categoryAttributes = selectedCategory?.publishedVersion?.snapshot.attributes || [];
  const purchaseManagedAttributes = categoryAttributes.filter((attribute) => attribute.complexId === 0 && OZON_PURCHASE_ATTRIBUTE_ID_SET.has(attribute.id));
  const sharedAttributes = categoryAttributes.filter((attribute) => attribute.complexId === 0 && attribute.id !== 10097 && ![9048, 4180, 4191].includes(attribute.id) && !OZON_VIDEO_SYSTEM_ATTRIBUTE_IDS.has(attribute.id) && !OZON_PURCHASE_ATTRIBUTE_ID_SET.has(attribute.id));
  const variantAttributes = categoryAttributes.filter((attribute) => (attribute.complexId > 0 || attribute.id === 10097) && !OZON_VIDEO_SYSTEM_ATTRIBUTE_IDS.has(attribute.id));
  const videoCompatibility = ozonVideoCompatibility(categoryAttributes);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  const initializeMissing = useMutation({
    mutationFn: async ({ targetSku, rowVersion, sessionId }: { targetSku: string; rowVersion: number; sessionId: number }) => {
      try {
        return await api.initializeOzonListingMissing(targetSku, rowVersion);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || dirtyRef.current || !ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, sessionId)) throw error;
        const refreshed = await api.ozonListing(targetSku);
        const stillCurrent = ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, sessionId);
        if (stillCurrent || editorSessionRef.current.sku !== targetSku) queryClient.setQueryData(['ozon-listing', 'MANUAL_DRAFT', targetSku], refreshed);
        if (dirtyRef.current || !stillCurrent) throw new ApiError('TASK_LOCKED', '草稿版本已变化，且当前编辑会话已变化；已停止自动重试', 409);
        if (!['DRAFT', 'READY'].includes(refreshed.listing.status)) throw new ApiError('TASK_LOCKED', `当前 OZON 资料状态 ${refreshed.listing.status} 不允许自动补全`, 409);
        return api.initializeOzonListingMissing(targetSku, refreshed.listing.rowVersion);
      }
    },
    onSuccess: async ({ listing: initialized }, variables) => {
      const stillCurrent = ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, variables.sessionId);
      if (stillCurrent || editorSessionRef.current.sku !== variables.targetSku) {
        queryClient.setQueryData(['ozon-listing', 'MANUAL_DRAFT', initialized.sku], (current: any) => ({
          ...(current || {}),
          listing: initialized,
          ...(initialized.data.currency === 'CNY' ? {
            priceProjection: {
              status: 'STORED',
              sourceCurrency: 'CNY',
              targetCurrency: 'CNY',
              pendingSave: false,
              offers: initialized.data.offers.map((offer) => ({
                offerId: offer.offerId,
                price: offer.price,
                ...(offer.oldPrice !== undefined ? { oldPrice: offer.oldPrice } : {}),
                ...(offer.minPrice !== undefined ? { minPrice: offer.minPrice } : {})
              }))
            }
          } : {})
        }));
      }
      if (!stillCurrent) return;
      const preserveUnsavedValues = dirtyRef.current;
      const currentValues = preserveUnsavedValues ? form.getFieldsValue(true) : undefined;
      if (currentValues) form.setFieldsValue(mergeOzonInitializationIntoForm(currentValues, initialized, userTouchedInitializationFields.current));
      setDirty(preserveUnsavedValues);
      dirtyRef.current = preserveUnsavedValues;
      appliedSuggestionKey.current = undefined;
      if (!preserveUnsavedValues) setMediaSuggestionReport(undefined);
      await onChanged();
      const issues = initialized.data.initialization?.issues || [];
      message[issues.length ? 'warning' : 'success'](issues.length ? `自动补齐已完成，仍有 ${issues.length} 项等待来源数据` : '俄文标题和商品详情已自动补齐');
    },
    onError: (error, variables) => {
      if (!ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, variables.sessionId)) return;
      message.warning(`自动补齐暂未完成：${error instanceof ApiError ? error.userMessage : error instanceof Error ? error.message : '未知错误'}；再次打开草稿时会重试`);
    },
    onSettled: (_data, _error, variables) => {
      if (!ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, variables.sessionId)) return;
      autoInitializationFinished.current = variables.targetSku;
    }
  });
  useEffect(() => {
    setDirty(false);
    dirtyRef.current = false;
    setActiveOfferId(undefined);
    setManualJobId(initialManualJobId);
    setMediaSuggestionReport(undefined);
    setPublicationOpen(false);
    autoInitializationAttempted.current = undefined;
    autoInitializationFinished.current = undefined;
    autoMediaScanAttempted.current = undefined;
    appliedSuggestionKey.current = undefined;
    offerIdentityKey.current = undefined;
    userTouchedInitializationFields.current.clear();
    form.resetFields();
  }, [editorContextKey, form, initialManualJobId]);
  useEffect(() => {
    if (!listingDetail?.listing || dirty) return;
    const item = listingDetail.listing;
    const suggestionKey = ozonMediaSuggestionKey(item);
    if (appliedSuggestionKey.current === suggestionKey) return;
    const missingLegacyProjection = !automaticSnapshotMode && !listing.data?.priceProjection && item.data.currency !== 'CNY';
    const projectedOffers = automaticSnapshotMode
      ? mergeOzonListingPricesByOfferId(item.data.offers, automaticSnapshot.data!.snapshot.pricing.offers)
      : projectOptionalOzonListingPrices(
        item.data.offers,
        listing.data?.priceProjection?.offers,
        listing.data?.priceProjection?.status === 'UNAVAILABLE' || missingLegacyProjection
      );
    const nextOffers = projectedOffers.map((offer) => ({ ...offer, modelGroup: item.sku, offerAttributeValues: presetAttributeValues(offer.attributes) }));
    const managedGrossWeight = ozonGrossWeightResolution(item.data.initialization);
    form.setFieldsValue({
      ...item.data,
      dimensions: ozonDimensionsWithManagedGrossWeight(item.data.dimensions, managedGrossWeight),
      sharedAttributeValues: presetAttributeValues(item.data.sharedAttributes),
      offers: nextOffers
    });
    offerIdentityKey.current = ozonOfferIdentityKey(nextOffers);
    appliedSuggestionKey.current = suggestionKey;
    setMediaSuggestionReport(undefined);
    setActiveOfferId(item.data.offers[0]?.variantId);
  }, [automaticSnapshot.data, automaticSnapshotMode, dirty, form, listing.data, listingDetail]);
  const watchedOfferIdentityKey = ozonOfferIdentityKey(watchedOffers);
  useEffect(() => {
    const item = listingDetail?.listing;
    if (!item || !watchedOffers.length || ['SUBMITTING', 'IMPORTED', 'MODERATING'].includes(item.status)) return;
    if (offerIdentityKey.current === undefined) {
      offerIdentityKey.current = watchedOfferIdentityKey;
      return;
    }
    if (offerIdentityKey.current === watchedOfferIdentityKey) return;
    offerIdentityKey.current = watchedOfferIdentityKey;
    const suggested = applyOzonMediaSuggestions(watchedOffers, item.data.mediaAssets || []);
    setMediaSuggestionReport(suggested.report.changed || suggested.report.warnings.length ? suggested.report : undefined);
    if (!suggested.report.changed) return;
    form.setFieldValue('offers', suggested.offers);
    dirtyRef.current = true;
    setDirty(true);
  }, [form, listingDetail?.listing, watchedOfferIdentityKey]);
  const importDescriptionFile = async (file?: File) => {
    if (!file) return;
    try {
      const normalized = decodeDescriptionTxt(file.name, await file.arrayBuffer(), {
        maxLength: OZON_DESCRIPTION_MAX_LENGTH,
        fieldLabel: '俄文商品详情'
      });
      form.setFieldValue('descriptionRu', normalized);
      form.setFieldValue('descriptionSource', { type: 'MANUAL' });
      userTouchedInitializationFields.current.add('descriptionRu');
      dirtyRef.current = true;
      setDirty(true);
      message.success(`已导入 ${file.name}，保存草稿后生效`);
    } catch (error) {
      showError(error instanceof Error ? error : new Error('TXT 导入失败'));
    } finally {
      if (descriptionFileRef.current) descriptionFileRef.current.value = '';
    }
  };
  const save = useMutation({
    mutationFn: async ({ targetSku, sessionId }: { targetSku: string; sessionId: number }) => {
      if (!ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, sessionId)) throw new ApiError('TASK_LOCKED', '当前编辑会话已变化，已停止保存', 409);
      const values = form.getFieldsValue(true);
      const current = listing.data!.listing;
      if (!ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, sessionId) || current.sku !== targetSku) throw new ApiError('TASK_LOCKED', '当前编辑会话已变化，已停止保存', 409);
      const formOffers = (form.getFieldValue('offers') || values.offers || []) as any[];
      if (!formOffers.length) throw new Error('公共素材至少需要一个产品变体');
      const variants = formOffers.map((offer: any, index: number) => ({
        variantId: offer.variantId || crypto.randomUUID(),
        productVariantId: String(offer.productVariantId || offer.variantId || '').trim(),
        productVariantName: String(offer.productVariantName || `产品变体 ${index + 1}`).trim(),
        ...(offer.productVariantColor ? { productVariantColor: offer.productVariantColor } : {}),
        descriptionRu: String(offer.descriptionRu || values.descriptionRu || ''),
        ...(offer.descriptionSource ? { descriptionSource: offer.descriptionSource } : {}),
        media: (offer.media || []).map((media: any, mediaIndex: number) => ({
          assetId: String(media.assetId || media.relativePath).trim(),
          relativePath: String(media.relativePath || '').trim(),
          kind: media.kind || 'image',
          sortOrder: mediaIndex,
          isPrimary: media.kind !== 'video' && (offer.media || []).findIndex((candidate: any) => candidate.kind !== 'video') === mediaIndex
        }))
      }));
      if (variants.some((variant) => !variant.productVariantId)) throw new Error('公共素材缺少稳定的产品变体身份');
      return api.updateOzonSharedMaterial(current.sku, {
        rowVersion: current.rowVersion,
        descriptionRu: String(values.descriptionRu || ''),
        ...(form.getFieldValue('descriptionSource') ? { descriptionSource: form.getFieldValue('descriptionSource') } : {}),
        variants
      });
    },
    onSuccess: async ({ listing: saved, materialRevision, contentPolicyVersion }, variables) => {
      const stillCurrent = ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, variables.sessionId);
      if (stillCurrent || editorSessionRef.current.sku !== variables.targetSku) {
        queryClient.setQueryData(['ozon-listing', 'MANUAL_DRAFT', saved.sku], (current: any) => ({
          ...(current || {}),
          listing: saved,
          priceProjection: {
            status: 'STORED',
            sourceCurrency: 'CNY',
            targetCurrency: 'CNY',
            pendingSave: false,
            offers: saved.data.offers.map((offer) => ({
              offerId: offer.offerId,
              price: offer.price,
              ...(offer.oldPrice !== undefined ? { oldPrice: offer.oldPrice } : {}),
              ...(offer.minPrice !== undefined ? { minPrice: offer.minPrice } : {})
            }))
          }
        }));
      }
      if (!stillCurrent) return;
      setDirty(false);
      dirtyRef.current = false;
      appliedSuggestionKey.current = undefined;
      userTouchedInitializationFields.current.clear();
      setMediaSuggestionReport(undefined);
      await onChanged();
      message.success(`OZON 公共素材 R${materialRevision || saved.revision} 已保存${contentPolicyVersion ? ` · ${contentPolicyVersion}` : ''}`);
    },
    onError: (error, variables) => {
      if (!ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, variables.sessionId)) return;
      showError(error);
    }
  });
  const scanMedia = useMutation({
    mutationFn: async ({ targetSku, rowVersion, sessionId, retryOnConflict }: { targetSku: string; rowVersion: number; sessionId: number; automatic: boolean; retryOnConflict: boolean }) => {
      try {
        return await api.scanOzonListingMedia(targetSku, rowVersion);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || !retryOnConflict || dirtyRef.current || !ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, sessionId)) throw error;
        const refreshed = await api.ozonListing(targetSku);
        const stillCurrent = ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, sessionId);
        if (stillCurrent || editorSessionRef.current.sku !== targetSku) queryClient.setQueryData(['ozon-listing', 'MANUAL_DRAFT', targetSku], refreshed);
        if (dirtyRef.current || !stillCurrent) throw new ApiError('TASK_LOCKED', '草稿版本已变化，且当前编辑会话已变化；已停止自动重试', 409);
        if (!['DRAFT', 'READY'].includes(refreshed.listing.status)) throw new ApiError('TASK_LOCKED', `当前 OZON 资料状态 ${refreshed.listing.status} 不允许扫描媒体`, 409);
        return api.scanOzonListingMedia(targetSku, refreshed.listing.rowVersion);
      }
    },
    onSuccess: async ({ changed, listing: scanned, mediaAssets, removedReferences }, variables) => {
      const stillCurrent = ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, variables.sessionId);
      if (stillCurrent || editorSessionRef.current.sku !== variables.targetSku) {
        queryClient.setQueryData(['ozon-listing', 'MANUAL_DRAFT', scanned.sku], (current: any) => ({ ...(current || {}), listing: scanned }));
      }
      if (!stillCurrent) return;
      const currentValues = form.getFieldsValue(true) as any;
      const preserveUnsavedValues = dirtyRef.current;
      const baseOffers = preserveUnsavedValues
        ? mergeOzonOffersAfterScan(currentValues.offers || [], scanned.data.offers, mediaAssets)
        : scanned.data.offers;
      const suggested = applyOzonMediaSuggestions(baseOffers, mediaAssets);
      const nextOffers = suggested.offers.map((offer) => ({ ...offer, modelGroup: scanned.sku, offerAttributeValues: preserveUnsavedValues
        ? (offer as any).offerAttributeValues || {}
        : presetAttributeValues(offer.attributes) }));
      appliedSuggestionKey.current = ozonMediaSuggestionKey(scanned);
      offerIdentityKey.current = ozonOfferIdentityKey(nextOffers);
      setMediaSuggestionReport(suggested.report.changed || suggested.report.warnings.length ? suggested.report : undefined);
      form.setFieldsValue(preserveUnsavedValues ? { ...currentValues, offers: nextOffers } : {
        ...scanned.data,
        sharedAttributeValues: presetAttributeValues(scanned.data.sharedAttributes),
        offers: nextOffers
      });
      dirtyRef.current = preserveUnsavedValues || suggested.report.changed;
      setDirty(dirtyRef.current);
      if (!changed) return;
      await onChanged();
      if (suggested.report.changed) message.warning(`已扫描 ${mediaAssets.length} 个媒体文件并生成自动匹配建议，保存草稿后生效`);
      else if (removedReferences) message.warning(`已扫描 ${mediaAssets.length} 个媒体文件，并移除 ${removedReferences} 个失效引用`);
      else if (!variables.automatic) message.success(`已扫描到 ${mediaAssets.length} 个媒体文件`);
    },
    onError: (error, variables) => {
      if (!ozonEditorSessionMatches(editorSessionRef.current, editorContextKey, variables.sessionId)) return;
      message.warning(`媒体扫描暂未完成：${error instanceof ApiError ? error.userMessage : error instanceof Error ? error.message : '未知错误'}；可稍后重新打开工作台或手动扫描`);
    }
  });
  const preparationSku = automaticSnapshotMode ? undefined : listing.data?.listing.sku;
  const initializationPendingForCurrentSku = Boolean(initializeMissing.isPending
    && initializeMissing.variables?.targetSku === preparationSku
    && initializeMissing.variables?.sessionId === editorSessionId);
  const mediaScanPendingForCurrentSku = Boolean(scanMedia.isPending
    && scanMedia.variables?.targetSku === preparationSku
    && scanMedia.variables?.sessionId === editorSessionId);
  const automaticPreparationAction = nextOzonAutoPreparationAction({
    sku: automaticSnapshotMode ? undefined : preparationSku,
    status: automaticSnapshotMode ? undefined : listing.data?.listing.status,
    needsInitialization: Boolean(!automaticSnapshotMode && listing.data?.listing && ozonListingNeedsInitialization(listing.data.listing)),
    initializationAttemptedFor: autoInitializationAttempted.current,
    initializationFinishedFor: autoInitializationFinished.current,
    mediaScanAttemptedFor: autoMediaScanAttempted.current,
    initializationPending: initializationPendingForCurrentSku,
    mediaScanPending: mediaScanPendingForCurrentSku
  });
  useEffect(() => {
    const item = automaticSnapshotMode ? undefined : listing.data?.listing;
    if (!item || !automaticPreparationAction) return;
    if (automaticPreparationAction === 'INITIALIZE') {
      autoInitializationAttempted.current = item.sku;
      initializeMissing.mutate({ targetSku: item.sku, rowVersion: item.rowVersion, sessionId: editorSessionId });
      return;
    }
    autoMediaScanAttempted.current = item.sku;
    scanMedia.mutate({ targetSku: item.sku, rowVersion: item.rowVersion, sessionId: editorSessionId, automatic: true, retryOnConflict: true });
  }, [automaticPreparationAction, automaticSnapshotMode, editorSessionId, listing.data?.listing]);
  const refreshPublicationQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['ozon-publications'] }),
      queryClient.invalidateQueries({ queryKey: ['ozon-auto-jobs'] }),
      queryClient.invalidateQueries({ queryKey: ['ozon-auto-job'] }),
      queryClient.invalidateQueries({ queryKey: ['ozon-listing'] }),
      onChanged()
    ]);
  };
  const syncPublication = useMutation({
    mutationFn: (publication: OzonPublication) => api.syncOzonPublication(publication.id, publication.rowVersion),
    onSuccess: async ({ publication }) => {
      message.success(`${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot} 已同步本地任务状态`);
      await refreshPublicationQueries();
    },
    onError: showError
  });
  const republishPublication = useMutation({
    mutationFn: (publication: OzonPublication) => api.republishOzonPublication(publication.id, publication.rowVersion),
    onSuccess: async ({ publication }) => {
      message.success(`${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot} 已创建新的独立上品任务`);
      await refreshPublicationQueries();
    },
    onError: showError
  });
  const cancelPublication = useMutation({
    mutationFn: (publication: OzonPublication) => api.cancelOzonPublication(publication.id, publication.rowVersion),
    onSuccess: async ({ publication }) => {
      message.success(`${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot} 的任务已取消`);
      await refreshPublicationQueries();
    },
    onError: showError
  });
  const recheckPublication = useMutation({
    mutationFn: async (publication: OzonPublication) => {
      const detail = await api.ozonPublicationTaskDetail(publication.id);
      if (!detail.recovery.canRecheck) {
        throw new Error(detail.recovery.blockedReason || '当前 publication 不允许安全重检');
      }
      const frozen = requireOzonPublicationRecheckInput(detail.publication, detail.frozenContract);
      return api.recheckOzonPublication(publication.id, frozen);
    },
    onSuccess: async ({ publication }) => {
      message.success(`${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot} 的 OZON 平台状态已重新检查`);
      await refreshPublicationQueries();
    },
    onError: showError
  });
  const appendPublication = useMutation({
    mutationFn: ({ publication, planHash }: { publication: OzonPublication; planHash: string }) => api.compatibleAppendOzonPublication(publication.id, publication.rowVersion, planHash),
    onSuccess: async ({ publication }) => {
      message.success(`${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot} 已提交兼容追加`);
      await refreshPublicationQueries();
    },
    onError: showError
  });
  const appendPlanPublication = useMutation({
    mutationFn: (publication: OzonPublication) => api.ozonPublicationCompatibleAppendPlan(publication.id),
    onSuccess: ({ plan }, publication) => {
      const storeName = publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot;
      if (!plan.ready) {
        Modal.warning({
          title: `“${storeName}”暂不能兼容追加`,
          content: plan.blockers.length ? plan.blockers.join('；') : '当前 publication 没有可兼容追加的新 Offer。',
          okText: '知道了'
        });
        return;
      }
      Modal.confirm({
        title: `兼容追加到“${storeName}”？`,
        content: `将按当前 publication 冻结合同追加 ${plan.newOfferIds.length} 个新 Offer，不会改写已发布 Offer。`,
        okText: '确认兼容追加',
        cancelText: '取消',
        onOk: () => appendPublication.mutateAsync({ publication, planHash: plan.planHash })
      });
    },
    onError: showError
  });
  if (!sku) return null;
  const item = listingDetail?.listing;
  const listingSourceMediaCleanup = listingDetail && 'sourceMediaCleanup' in listingDetail
    ? listingDetail.sourceMediaCleanup
    : undefined;
  const initialization = item?.data.initialization;
  const initializationIssues = initialization?.issues || [];
  const retryableInitializationIssues = initializationIssues.filter((issue) => issue.retryable);
  const grossWeightResolution = ozonGrossWeightResolution(initialization);
  const grossWeightSource = grossWeightResolution?.source === 'PROCUREMENT'
    ? `采购 V${grossWeightResolution.procurementVersionNo}`
    : grossWeightResolution?.source === 'PRESET_FALLBACK' ? '预设兜底' : undefined;
  const savedPurchaseMeasurements = item?.data.purchaseMeasurements;
  const managementEnabled = Boolean(readiness.data?.settings.enabled);
  const activeJob = automaticSnapshotMode ? undefined : listing.data?.activeJob;
  const canManualTakeover = Boolean(activeJob && !automaticSnapshotMode && listing.data?.canManualTakeover);
  const immutable = automaticSnapshotMode || Boolean(item && ['SUBMITTING', 'IMPORTED', 'MODERATING'].includes(item.status));
  const activeOfferKey = activeOfferId || watchedOffers[0]?.variantId;
  const mediaDirectory = item ? resolveOzonMediaDirectory(readiness.data?.settings.rootDirectory || item.data.mediaSourceRoot, item.sku) : '';
  const generatedProductSummary = automaticSnapshotMode ? undefined : ozonGeneratedProductSummary(listing.data);
  const staleProductJson = Boolean(generatedProductSummary && !generatedProductSummary.isCurrent);
  const legacyProductJson = generatedProductSummary?.schemaVersion === 1 && generatedProductSummary.isCurrent;
  const savePendingForCurrentSession = Boolean(save.isPending && save.variables?.targetSku === item?.sku && save.variables?.sessionId === editorSessionId);
  const automaticPreparationPending = Boolean(automaticPreparationAction) || initializationPendingForCurrentSku || mediaScanPendingForCurrentSku;
  const publicMaterialIssue = !watchedOffers.length
    ? '至少需要一个产品变体'
    : watchedOffers.some((offer) => !String(offer?.productVariantId || offer?.variantId || '').trim())
      ? '产品变体缺少稳定身份'
      : watchedOffers.some((offer) => !(offer?.media || []).some((media: any) => media.kind === 'image'))
        ? '每个产品变体至少需要一张图片'
        : watchedOffers.some((offer) => (offer?.media || []).filter((media: any) => media.kind === 'video').length !== 1)
          ? '每个产品变体需要且只能使用一个产品视频'
          : undefined;
  const effectiveProjectedPrices = automaticSnapshotMode
    ? automaticSnapshot.data?.snapshot.pricing.offers
    : listing.data?.priceProjection?.status === 'UNAVAILABLE' ? undefined : listing.data?.priceProjection?.offers;
  const priceProjectionMismatch = Boolean(item && effectiveProjectedPrices
    && !ozonListingPriceProjectionComplete(item.data.offers, effectiveProjectedPrices));
  const saveDisabledReason = automaticSnapshotMode
    ? '自动任务冻结资料只读'
    : automaticPreparationPending
    ? '正在同步标题、详情和媒体'
    : immutable
      ? `当前状态 ${item?.status || '未知'} 不可编辑`
      : !dirty
        ? '当前公共素材已保存'
        : undefined;
  const sharedCheckDisabledReason = automaticPreparationPending
    ? '正在同步标题、详情和媒体'
    : dirty
      ? '请先保存公共素材'
      : publicMaterialIssue;
  const submitDisabledReason = automaticPreparationPending
    ? '正在同步标题、详情和媒体'
    : !managementEnabled
    ? '请先启用 OZON 上品管理'
    : dirty
        ? '请先保存公共素材'
        : publicMaterialIssue;
  const checkSharedListing = async () => {
    if (!item) return;
    setSharedCheckPending(true);
    try {
      if (publicMaterialIssue) {
        message.warning(`公共素材尚未通过：${publicMaterialIssue}`);
        return;
      }
      message.success('公共素材检查通过；选择店铺后才会生成各店独立发布包');
    } catch {
      message.warning('共享资料存在未完成字段，请按表单提示修正');
    } finally {
      setSharedCheckPending(false);
    }
  };
  const editorError = automaticSnapshotMode ? automaticSnapshot.error : listing.error;
  const editorLoading = automaticSnapshotMode ? automaticSnapshot.isLoading : listing.isLoading;
  const refetchEditor = automaticSnapshotMode ? automaticSnapshot.refetch : listing.refetch;
  const frozenSnapshot = automaticSnapshot.data?.snapshot;
  const priceCurrency = automaticSnapshotMode ? frozenSnapshot?.pricing.currency : 'CNY';
  return <><Drawer className="ozon-drawer ozon-listing-drawer" width="min(1480px, 98vw)" open title={item ? <Space wrap><span className="ozon-mono-badge">{item.sku}</span><strong>{item.productName}</strong><ListingState value={item.status} />{automaticSnapshotMode && <Tag color="blue">自动任务冻结资料</Tag>}{automaticSnapshotMode && <Tag>只读</Tag>}{dirty && <Tag color="orange">有未保存修改</Tag>}</Space> : automaticSnapshotMode ? '加载自动任务冻结资料' : '加载 OZON 上品资料'} onClose={onClose} extra={item && !automaticSnapshotMode && <Space wrap className="ozon-drawer-actions">
    <Tooltip title={saveDisabledReason}><Button icon={<SaveOutlined />} loading={savePendingForCurrentSession} disabled={automaticPreparationPending || immutable || !dirty} onClick={() => save.mutate({ targetSku: item.sku, sessionId: editorSessionId })}>保存公共素材</Button></Tooltip>
    <Tooltip title={sharedCheckDisabledReason}><Button icon={<SafetyCertificateOutlined />} loading={sharedCheckPending} disabled={Boolean(sharedCheckDisabledReason)} onClick={() => void checkSharedListing()}>检查共享资料</Button></Tooltip>
    <Tooltip title={submitDisabledReason}><Button type="primary" icon={<RocketOutlined />} disabled={Boolean(submitDisabledReason)} onClick={() => setPublicationOpen(true)}>选择店铺并提交</Button></Tooltip>
  </Space>}>
    {editorError ? <Alert showIcon type="error" message={automaticSnapshotMode ? '自动任务冻结资料加载失败' : 'OZON 上品资料加载失败'} description={editorError.message} action={<Button onClick={() => void refetchEditor()}>重试</Button>} /> : editorLoading || !item ? <Skeleton active /> : <>
      {automaticSnapshotMode && frozenSnapshot && <Alert
        showIcon
        type="info"
        message={<Space wrap><strong>自动任务冻结资料</strong><Tag>{frozenSnapshot.store.displayName}</Tag><Tag>修订 R{frozenSnapshot.revision}</Tag><Tag color="blue">账户币种 {frozenSnapshot.store.accountCurrency}</Tag><Tag>只读</Tag></Space>}
        description={<Space direction="vertical" size={2}>
          <span>生成版本 {frozenSnapshot.generatedVersionId}；此处核对任务创建时冻结的店铺资料，不会按当前设置改写历史。</span>
          <span>此处为店铺账户上品币种，与 OZON 买家端本地化显示币种无关。</span>
          {frozenSnapshot.store.accountCurrencyChanged && <Text type="warning">当前店铺账户币种已变为 {frozenSnapshot.store.currentAccountCurrency}，本页仍显示任务冻结的 {frozenSnapshot.store.accountCurrency}。</Text>}
        </Space>}
      />}
      {automaticSnapshotMode && priceProjectionMismatch && <Alert showIcon type="error" message="账户币种价格与 Offer 不匹配" description="冻结价格缺失、重复或包含未知 Offer；相关价格已清空。" />}
      {!automaticSnapshotMode && !managementEnabled && <Alert className="ozon-manual-job-detail-warning" showIcon type="warning" message="OZON 上品管理未启用" description="可以继续查看和编辑共享草稿；扫描媒体和创建店铺 publication 已停用。" />}
      {activeJob && <ActiveJobNotice job={activeJob} canManualTakeover={canManualTakeover} onOpenJob={activeJob.source === 'MANUAL' ? setManualJobId : undefined} />}
      {initializationPendingForCurrentSku && <Alert showIcon type="info" message="正在自动补齐俄文标题与商品详情" description="标题由 OZON 专用翻译工作流生成，详情按产品变体读取最新有效 E003 详情 TXT；图片场景结果不影响详情导入。" />}
      {mediaScanPendingForCurrentSku && <Alert showIcon type="info" message="正在同步 variants 媒体目录" description="扫描完成后会按变体生成未保存的图片和视频勾选建议。" />}
      {initialization && !initializationPendingForCurrentSku && <Alert
        showIcon
        type={initializationIssues.length ? 'warning' : 'success'}
        message={initializationIssues.length ? `自动初始化仍有 ${initializationIssues.length} 项待处理` : '俄文标题与商品详情已自动初始化'}
        description={initializationIssues.length
          ? <Space direction="vertical" size={3}>{initializationIssues.map((issue, index) => <span key={`${issue.code}-${issue.field || index}`}><Tag color="gold">{issue.field || issue.code}</Tag>{issue.message}</span>)}</Space>
          : `完成于 ${dayjs(initialization.initializedAt).format('YYYY-MM-DD HH:mm')}`}
        action={retryableInitializationIssues.length && item.status === 'DRAFT' ? <Button size="small" icon={<ReloadOutlined />} loading={initializationPendingForCurrentSku} disabled={dirty || immutable || mediaScanPendingForCurrentSku} onClick={() => initializeMissing.mutate({ targetSku: item.sku, rowVersion: item.rowVersion, sessionId: editorSessionId })}>重试缺失项</Button> : undefined}
      />}
      {!automaticSnapshotMode && <OzonPublicationResults
        publications={publications.data?.items || []}
        loading={publications.isLoading}
        refreshing={publications.isFetching}
        error={publications.error}
        busyAction={syncPublication.isPending && syncPublication.variables
          ? { publicationId: syncPublication.variables.id, action: 'sync' }
          : republishPublication.isPending && republishPublication.variables
            ? { publicationId: republishPublication.variables.id, action: 'republish' }
            : cancelPublication.isPending && cancelPublication.variables
              ? { publicationId: cancelPublication.variables.id, action: 'cancel' }
              : recheckPublication.isPending && recheckPublication.variables
                ? { publicationId: recheckPublication.variables.id, action: 'recheck' }
                : appendPlanPublication.isPending && appendPlanPublication.variables
                  ? { publicationId: appendPlanPublication.variables.id, action: 'compatible-append' }
                  : appendPublication.isPending && appendPublication.variables
                    ? { publicationId: appendPublication.variables.publication.id, action: 'compatible-append' }
                    : undefined}
        onRefresh={() => void publications.refetch()}
        remoteReadbackEnabled={ozonPublicationRemoteReadbackEnabled(storeSettings.data?.settings)}
        onSync={(publication) => syncPublication.mutate(publication)}
        onRecheck={(publication) => recheckPublication.mutate(publication)}
        onCancel={(publication) => Modal.confirm({ title: `取消“${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot}”当前任务？`, content: '只取消这条 publication 绑定的任务；其他店铺不受影响。', okText: '确认取消', okButtonProps: { danger: true }, cancelText: '返回', onOk: () => cancelPublication.mutateAsync(publication) })}
        onCompatibleAppend={(publication) => appendPlanPublication.mutate(publication)}
        onRepublish={(publication) => Modal.confirm({ title: `重新上品到“${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot}”？`, content: '只会为该店铺创建新的独立任务；其他店铺不受影响。', okText: '确认重新上品', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => republishPublication.mutateAsync(publication) })}
      />}
      {!automaticSnapshotMode && !publications.data?.items.length && (item.ozonProductLinks?.length || 0) > 0 && <OzonPlatformStatusLedger offerIds={item.data.offers.map((offer) => offer.offerId)} links={item.ozonProductLinks} title="迁移前默认店铺的 OZON 平台结果" />}
      {!automaticSnapshotMode && <ManualJobHistory listing={item} selectedJobId={manualJobId} onSelectJob={setManualJobId} />}
      <Form form={form} layout="vertical" disabled={immutable} onValuesChange={(changedValues) => {
        if (automaticSnapshotMode) return;
        markOzonDescriptionSourceAfterEdit(form, changedValues);
        dirtyRef.current = true;
        setDirty(true);
      }} initialValues={{ vat: '0.2', offers: [] }}>
      <div className="ozon-editor-layout">
        <main className="ozon-editor-main">
          {item.lastErrorMessage && <Alert showIcon type="warning" message={item.lastErrorCode || 'OZON 任务需要处理'} description={item.lastErrorMessage} />}
          {staleProductJson && generatedProductSummary && <Alert
            className="ozon-product-json-version-alert"
            showIcon
            type="info"
            message="迁移前共享 product.json 已过期"
            description={`磁盘文件为 r${generatedProductSummary.revision}，当前草稿为 r${item.revision}。多店发布不会复用该文件；发布计划会按当前草稿与店铺冻结快照生成独立包。`}
          />}
          {legacyProductJson && <Alert
            className="ozon-product-json-version-alert"
            showIcon
            type="warning"
            message="已检测到迁移前 V1 文件"
            description="该共享文件仅供历史回滚；新店铺 publication 会使用当前草稿重新物化，不会从 V1 文件取店铺、仓库或币种。"
          />}
          {automaticSnapshotMode ? <><Card title={<Space><FormOutlined />产品资料</Space>}>
            <Row gutter={[14, 0]}><Col xs={24} md={12}><Form.Item name="categoryKey" label="OZON 类目模板" rules={[{ required: true, message: '请选择类目模板' }]}><Select aria-label="OZON 类目模板" showSearch optionFilterProp="label" placeholder="选择已发布的类目" onChange={() => form.setFieldsValue({ sharedAttributeValues: {}, offers: watchedOffers.map((offer) => ({ ...offer, offerAttributeValues: {} })) })} options={(categories.data?.items || []).filter((category) => category.publishedVersion).map((category) => ({ value: category.categoryKey, label: `${category.nameZh || category.nameRu}${category.nameZh && category.nameRu ? ` / ${category.nameRu}` : ''} · ${category.descriptionCategoryId}/${category.typeId} · V${category.publishedVersion!.versionNo}` }))} /></Form.Item></Col><Col xs={24} md={12}><Form.Item name="brand" label="品牌（允许留空）"><Input placeholder="留空时不写入品牌文本" /></Form.Item></Col></Row>
            <Form.Item name="titleRu" label="俄文商品标题" rules={[{ required: true, whitespace: true }, { validator: ozonTitleContentValidator }]}><Input maxLength={OZON_TITLE_MAX_LENGTH} showCount onChange={() => userTouchedInitializationFields.current.add('titleRu')} /></Form.Item>
            <Form.Item name="descriptionRu" label={<Flex align="center" justify="space-between" gap={12} wrap="wrap"><span>共享俄文商品详情（兼容兜底）</span><Button size="small" icon={<FileTextOutlined />} disabled={immutable} onClick={() => descriptionFileRef.current?.click()}>导入 UTF-8 TXT</Button><input ref={descriptionFileRef} hidden type="file" accept=".txt,text/plain" onChange={(event) => void importDescriptionFile(event.target.files?.[0])} /></Flex>} rules={[{ required: true, whitespace: true }, { validator: ozonDescriptionContentValidator }]} extra="各变体优先使用自己的俄文详情；未单独填写时继承这里的共享详情。中文、隐形字符、外链、联系方式、广告/价格/仿品词和不合规 HTML 会被拒绝；高密度重复词会提示但不阻断。不会自动删除或改写，提交时仅将换行规范为 <br>。"><Input.TextArea maxLength={OZON_DESCRIPTION_MAX_LENGTH} showCount autoSize={{ minRows: 5, maxRows: 12 }} onChange={() => userTouchedInitializationFields.current.add('descriptionRu')} /></Form.Item>
            <OzonDescriptionWarningAlerts warnings={item.data.descriptionWarnings} />
            {!automaticSnapshotMode && <Alert
              className="ozon-listing-store-migration"
              showIcon
              type="info"
              message="履约、仓库和合同币种已迁移到店铺设置"
              description={<Space size={[6, 4]} wrap><Text type="secondary">该草稿的历史值仅供兼容读取，新 publication 不会使用：</Text><Tag>{item.data.fulfillmentMode || '—'}</Tag><Tag>仓库 {item.data.warehouseId || '—'}</Tag><Tag color="blue">{item.data.currency || '—'}</Tag></Space>}
            />}
            <Row gutter={[14, 0]}><Col xs={12} md={6}><Form.Item name="vat" label="VAT"><Select options={['0', '0.05', '0.07', '0.1', '0.2', '0.22'].map((value) => ({ value, label: Number(value) ? `${Number(value) * 100}%` : '0%' }))} /></Form.Item></Col></Row>
            <Divider orientation="left">商品包装信息</Divider>
            <Row gutter={[12, 0]}>
              <Col xs={12} md={4}><Form.Item name={['dimensions', 'length']} label="长" rules={[{ required: true }]}><InputNumber min={0.01} /></Form.Item></Col>
              <Col xs={12} md={4}><Form.Item name={['dimensions', 'width']} label="宽" rules={[{ required: true }]}><InputNumber min={0.01} /></Form.Item></Col>
              <Col xs={12} md={4}><Form.Item name={['dimensions', 'height']} label="高" rules={[{ required: true }]}><InputNumber min={0.01} /></Form.Item></Col>
              <Col xs={12} md={4}><Form.Item name={['dimensions', 'dimensionUnit']} label="尺寸单位"><Select options={['mm', 'cm', 'in'].map((value) => ({ value }))} /></Form.Item></Col>
              <Col xs={12} md={4}><Form.Item
                name={['dimensions', 'weight']}
                label={grossWeightResolution ? '毛重 (g)' : '毛重'}
                extra={grossWeightSource
                  ? <Space size={4}><Text type="secondary">毛重来源</Text><Tag color={grossWeightResolution?.source === 'PROCUREMENT' ? 'blue' : 'gold'}>{grossWeightSource}</Tag></Space>
                  : <Text type="warning">历史未联动：毛重仍可手动编辑</Text>}
                rules={[{ required: true }]}
              ><InputNumber aria-label={grossWeightResolution ? '毛重 (g)' : '毛重'} min={0.01} readOnly={Boolean(grossWeightResolution)} /></Form.Item></Col>
              <Col xs={12} md={4}><Form.Item name={['dimensions', 'weightUnit']} label="重量单位"><Select aria-label="重量单位" disabled={Boolean(grossWeightResolution)} options={(grossWeightResolution ? ['g'] : ['g', 'kg', 'lb']).map((value) => ({ value }))} /></Form.Item></Col>
            </Row>
          </Card>

          <Card title={<Space><TagsOutlined />OZON 类目字段</Space>} extra={selectedCategory?.publishedVersion && <Tag color="green">模板 V{selectedCategory.publishedVersion.versionNo}</Tag>}>
            {!selectedCategoryKey ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择 OZON 类目模板" /> : categories.isLoading ? <Skeleton active /> : !selectedCategory?.publishedVersion ? <Alert showIcon type="warning" message="所选类目没有已发布版本" /> : <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {!!purchaseManagedAttributes.length && <OzonPurchaseManagedFields
                sku={item.sku}
                attributes={purchaseManagedAttributes}
                projection={purchaseMeasurementProjection}
                latestProcurement={purchaseDetail.data?.purchase.procurementVersions[0]}
                savedSnapshot={savedPurchaseMeasurements}
                loading={purchaseDetail.isLoading}
                error={purchaseDetail.error}
              />}
              <OzonVideoCompatibilityNotice compatibility={videoCompatibility} />
              <OzonListingAttributeFields attributes={sharedAttributes} formPath={['sharedAttributeValues']} dictionarySnapshot={selectedCategory.publishedVersion.snapshot.dictionarySnapshot} categoryType={selectedCategory} />
            </Space>}
          </Card></> : <Card title={<Space><FormOutlined />公共素材</Space>}>
            <Alert showIcon type="info" message="公共素材任务" description="这里只维护 MerchRoute 产品变体、可共享详情、图片、视频及顺序。类目、标题、属性、价格、VAT、包装、规格、库存和 Offer 由所选店铺的默认预设生成，并在发布计划中冻结。" />
            <OzonSourceMediaCleanupStatus summary={listingSourceMediaCleanup} />
            <Form.Item name="descriptionRu" label={<Flex align="center" justify="space-between" gap={12} wrap="wrap"><span>共享俄文商品详情</span><Button size="small" icon={<FileTextOutlined />} disabled={immutable} onClick={() => descriptionFileRef.current?.click()}>导入 UTF-8 TXT</Button><input ref={descriptionFileRef} hidden type="file" accept=".txt,text/plain" onChange={(event) => void importDescriptionFile(event.target.files?.[0])} /></Flex>} rules={[{ validator: ozonOptionalDescriptionContentValidator }]} extra="各产品变体可维护独立详情；留空时继承这里的共享详情。"><Input.TextArea maxLength={OZON_DESCRIPTION_MAX_LENGTH} showCount autoSize={{ minRows: 5, maxRows: 12 }} onChange={() => userTouchedInitializationFields.current.add('descriptionRu')} /></Form.Item>
            <OzonDescriptionWarningAlerts warnings={item.data.descriptionWarnings} />
          </Card>}

          {mediaSuggestionReport && (mediaSuggestionReport.changed || mediaSuggestionReport.warnings.length > 0) && <Alert
            showIcon
            type={mediaSuggestionReport.warnings.length ? 'warning' : 'success'}
            message={mediaSuggestionReport.changed ? '已生成媒体自动匹配建议，尚未保存' : '部分媒体未能自动匹配'}
            description={<Space direction="vertical" size={4}><span>匹配 {mediaSuggestionReport.matchedVariants} 个变体，新增 {mediaSuggestionReport.imagesAdded} 张图片、{mediaSuggestionReport.videosAdded} 个视频。</span>{mediaSuggestionReport.warnings.map((warning) => <span key={warning}>• {warning}</span>)}</Space>}
          />}
          <Card className="ozon-variant-card" title={<Space><AppstoreAddOutlined />{automaticSnapshotMode ? '店铺冻结变体资料' : '产品变体与媒体'}</Space>}>
        {!automaticSnapshotMode && <div className="ozon-media-directory-bar">
          <div className="ozon-media-directory-copy">
            <span className="ozon-media-directory-icon"><FolderOpenOutlined /></span>
            <div><strong>OZON 共享媒体目录</strong><Text copyable={Boolean(mediaDirectory)} code>{mediaDirectory || '尚未配置 OZON 自动上品根目录'}</Text><Text type="secondary">E005 图片与 E004 产品视频只保存一份；同一个 MP4 同时用于产品介绍视频和视频封面，并可分配给多个变体。</Text></div>
          </div>
          <Tooltip title={automaticPreparationPending ? '正在同步标题、详情和媒体' : !managementEnabled ? '请先启用 OZON 上品管理' : dirty ? '请先保存当前修改，再扫描目录' : !mediaDirectory ? '请先完成 OZON 上品配置' : undefined}>
            <Button icon={<SyncOutlined />} loading={mediaScanPendingForCurrentSku} disabled={automaticPreparationPending || !managementEnabled || immutable || dirty || !mediaDirectory} onClick={() => scanMedia.mutate({ targetSku: item.sku, rowVersion: item.rowVersion, sessionId: editorSessionId, automatic: false, retryOnConflict: false })}>扫描 variants 目录</Button>
          </Tooltip>
        </div>}
        <Form.List name="offers">
          {(fields, { add, remove }) => <>
            <Flex className="ozon-variant-toolbar" justify="space-between" align="center" gap={12} wrap="wrap"><Text type="secondary">{automaticSnapshotMode ? '此处显示任务确认时冻结的完整店铺商品资料。' : '每个产品变体只维护稳定身份、可共享详情和媒体顺序。'}</Text>{!automaticSnapshotMode && <Button icon={<PlusOutlined />} disabled={immutable || fields.length >= 99} onClick={() => {
              const variantCode = nextOzonVariantCode((form.getFieldValue('offers') || []).map((offer: any) => String(offer?.variantCode || '')));
              if (!variantCode) return message.error('稳定变体编码 01–99 已全部使用');
              const variantId = crypto.randomUUID();
              add(newOzonManualOffer(item.sku, variantCode, variantId, watchedOffers[0], 0));
              setActiveOfferId(variantId);
            }}>添加变体</Button>}</Flex>
            {!fields.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="至少创建一个 OZON 变体"><Button icon={<PlusOutlined />} onClick={() => {
              const variantCode = nextOzonVariantCode([])!; const variantId = crypto.randomUUID(); add(newOzonManualOffer(item.sku, variantCode, variantId, undefined, 0)); setActiveOfferId(variantId);
            }}>添加第一个变体</Button></Empty> : <Tabs className="ozon-variant-tabs" activeKey={activeOfferKey} onChange={setActiveOfferId} items={fields.map((field, index) => {
              const offerValue = watchedOffers[index] || {};
              const offerKey = String(offerValue.variantId || field.key);
              return { key: offerKey, label: <span>{offerValue.offerId || `变体 ${index + 1}`}<small>{(offerValue.media || []).filter((media: any) => media.kind !== 'video').length} 图</small></span>, children: <div className="ozon-variant-panel">
              <Flex justify="space-between" align="center" gap={12} wrap="wrap"><Space wrap><Tag color="blue">变体 {index + 1}</Tag><Text type="secondary">variantId <span className="ozon-mono-small">{offerValue.variantId}</span></Text></Space><Button danger icon={<DeleteOutlined />} disabled={immutable || fields.length === 1} onClick={() => Modal.confirm({ title: `删除变体 ${offerValue.offerId || index + 1}？`, content: '只会删除当前草稿中的变体与媒体引用，不会删除磁盘文件。', okText: '删除变体', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => { remove(field.name); setActiveOfferId(watchedOffers.find((_: any, candidateIndex: number) => candidateIndex !== index)?.variantId); } })}>删除变体</Button></Flex>
              <Form.Item name={[field.name, 'variantId']} hidden><Input /></Form.Item>
              <Form.Item name={[field.name, 'productVariantId']} hidden><Input /></Form.Item>
              {!automaticSnapshotMode && <Form.Item name={[field.name, 'productVariantName']} label="产品变体名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={256} /></Form.Item>}
              {automaticSnapshotMode && <Row gutter={[12, 0]}>
                <Col xs={12} md={6}><Form.Item name={[field.name, 'variantCode']} label="稳定变体编码" rules={[{ required: true }]} extra="新增变体按 01–99 生成，保存后不可修改。"><Input readOnly /></Form.Item></Col>
                <Col xs={12} md={6}><Form.Item name={[field.name, 'offerId']} label="OZON offer_id" extra="由 SKU 与稳定变体编码生成。"><Input readOnly /></Form.Item></Col>
                <Col xs={12} md={4}><Form.Item name={[field.name, 'price']} label="上架价" rules={[{ required: true }, { type: 'number', min: 0.01 }]}><InputNumber min={0.01} addonAfter={priceCurrency} readOnly={automaticSnapshotMode} disabled={automaticSnapshotMode ? false : undefined} /></Form.Item></Col>
                <Col xs={12} md={4}><Form.Item name={[field.name, 'oldPrice']} label="划线价"><InputNumber min={0.01} addonAfter={priceCurrency} readOnly={automaticSnapshotMode} disabled={automaticSnapshotMode ? false : undefined} /></Form.Item></Col>
                <Col xs={12} md={4}><Form.Item name={[field.name, 'minPrice']} label="最低价"><InputNumber min={0} addonAfter={priceCurrency} readOnly={automaticSnapshotMode} disabled={automaticSnapshotMode ? false : undefined} /></Form.Item></Col>
                <Col xs={12} md={4}><Form.Item name={[field.name, 'stock']} label="默认库存" rules={[{ required: true }, { type: 'number', min: 0 }]}><InputNumber min={0} precision={0} /></Form.Item></Col>
                <Col xs={12} md={4}><Form.Item name={[field.name, 'barcode']} label="条码"><Input placeholder="留空时不主动覆盖" /></Form.Item></Col>
                <Col xs={12} md={4}><Form.Item name={[field.name, 'modelGroup']} label="模型分组" extra="同一 SKU 的所有变体固定使用商品 SKU。"><Input readOnly /></Form.Item></Col>
              </Row>}
               <Form.Item name={[field.name, 'descriptionRu']} label="该变体的俄文商品详情" rules={[{ validator: ozonOptionalDescriptionContentValidator }]} extra={`留空时继承共享详情${offerValue.descriptionSource?.executionId ? `；来源 E003 执行 ${offerValue.descriptionSource.executionId}` : ''}。中文、隐形字符、外链、联系方式、广告/价格/仿品词和不合规 HTML 会被拒绝；高密度重复词会提示但不阻断。不会自动删除或改写，提交时仅将换行规范为 <br>。`}><Input.TextArea maxLength={OZON_DESCRIPTION_MAX_LENGTH} showCount autoSize={{ minRows: 4, maxRows: 10 }} placeholder="留空以继承共享俄文商品详情" onChange={() => userTouchedInitializationFields.current.add(`offer:${String(offerValue.productVariantId || offerValue.variantId || field.key)}:descriptionRu`)} /></Form.Item>
               <OzonDescriptionWarningAlerts warnings={offerValue.descriptionWarnings} />
              {automaticSnapshotMode && <><Divider orientation="left">该变体的 OZON 类目字段</Divider>
              {!variantAttributes.length ? <Text type="secondary">当前类目没有变体级字段</Text> : <OzonListingAttributeFields attributes={variantAttributes} formPath={[field.name, 'offerAttributeValues']} dictionarySnapshot={selectedCategory?.publishedVersion?.snapshot.dictionarySnapshot || {}} />}</>}
              <Divider orientation="left">该变体的媒体</Divider>
              <OzonMediaAssignment
                sku={item.sku}
                offers={watchedOffers}
                offerIndex={index}
                mediaAssets={item.data.mediaAssets || []}
                videoCompatibility={automaticSnapshotMode ? videoCompatibility : OZON_MANUAL_SHARED_VIDEO_COMPATIBILITY}
                immutable={immutable}
                onChange={(offers) => {
                  form.setFieldValue('offers', offers);
                  dirtyRef.current = true;
                  setDirty(true);
                }}
              />
              </div> };
            })} />}
          </>}
        </Form.List>
      </Card>
        </main>
        {!automaticSnapshotMode && <aside className="ozon-readiness-rail"><Card title="公共素材检查" size="small"><Space direction="vertical" size={10} style={{ width: '100%' }}><Tag color={publicMaterialIssue ? 'gold' : 'green'}>{publicMaterialIssue ? '待完善' : '可以选择店铺'}</Tag><Text type={publicMaterialIssue ? 'warning' : 'secondary'}>{publicMaterialIssue || '产品变体身份和媒体顺序完整；店铺商品字段将在发布计划中生成。'}</Text></Space></Card></aside>}
      </div>
      </Form>
    </>}
  </Drawer>{item && !automaticSnapshotMode && <OzonPublicationDialog listing={item} open={publicationOpen} onClose={() => setPublicationOpen(false)} onSubmitted={refreshPublicationQueries} />}</>;
}

function ManualJobHistory({ listing, selectedJobId, onSelectJob }: { listing: OzonListingDraft; selectedJobId?: string; onSelectJob: (jobId?: string) => void }) {
  const sku = listing.sku;
  const params = new URLSearchParams({ page: '1', pageSize: '100' });
  const jobs = useQuery({
    queryKey: ['ozon-manual-jobs', sku],
    queryFn: () => api.ozonManualJobs(sku, params),
    retry: false,
    refetchInterval: (result) => result.state.data?.items.some(ozonJobIsActive) ? 10_000 : false
  });
  const manualJobs = ozonVisibleManualJobList(jobs.data).items;
  const fallbackJob = manualJobs.find((job) => job.id === selectedJobId);
  return <section className="ozon-manual-job-history" aria-label={`${sku} 手动任务历史`}>
    <Flex className="ozon-manual-job-history-heading" justify="space-between" align="center" gap={10} wrap="wrap">
      <div><Space size={7}><ClockCircleOutlined /><strong>手动任务历史</strong><Tag>{manualJobs.length}</Tag></Space><Text type="secondary">仅显示当前 SKU 的 MANUAL 任务；自动任务仍归入“自动上品任务”。</Text></div>
      <Button size="small" icon={<ReloadOutlined />} loading={jobs.isFetching} onClick={() => void jobs.refetch()}>刷新</Button>
    </Flex>
    {jobs.isError ? <Alert showIcon type="warning" message="手动任务历史暂时无法读取" description={jobs.error.message} action={<Button size="small" onClick={() => void jobs.refetch()}>重试</Button>} /> : <Table<OzonPublishJob>
      className="ozon-manual-job-table"
      rowKey="id"
      size="small"
      loading={jobs.isLoading}
      dataSource={manualJobs}
      pagination={false}
      scroll={{ x: 1020, y: 260 }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无手动提交任务；AUTO 任务不会显示在这里。" /> }}
      onRow={(job) => ({
        tabIndex: 0,
        role: 'button',
        'aria-label': `打开手动任务详情 ${job.id}`,
        onClick: () => onSelectJob(job.id),
        onKeyDown: (event) => {
          if (!['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          onSelectJob(job.id);
        }
      })}
      columns={[
        { title: '任务', width: 190, render: (_, job) => <div><code>{job.id}</code><Text type="secondary">{ozonJobStoreAlias(job) || '店铺未标记'}</Text></div> },
        { title: '状态', width: 150, render: (_, job) => <OzonJobStateTags job={job} /> },
        { title: '产品视频/封面', width: 184, render: (_, job) => <OzonJobStageState job={job} stage="video" compact /> },
        { title: 'OZON商品链接', width: 230, render: (_, job) => <OzonProductLinksCell links={ozonJobProductLinks(job)} offerIds={ozonJobOfferIds(job)} complete={job.state === 'SUCCEEDED'} /> },
        { title: '更新时间', width: 150, render: (_, job) => dayjs(job.updatedAt).format('MM-DD HH:mm:ss') },
        { title: '操作', width: 100, render: (_, job) => <Button size="small" onClick={(event) => { event.stopPropagation(); onSelectJob(job.id); }}>查看详情</Button> }
      ]}
    />}
    <ManualJobDetailDrawer listing={listing} jobId={selectedJobId} fallbackJob={fallbackJob} onClose={() => onSelectJob(undefined)} />
  </section>;
}

function ManualJobDetailDrawer({ listing, jobId, fallbackJob, onClose }: { listing: OzonListingDraft; jobId?: string; fallbackJob?: OzonPublishJob; onClose: () => void }) {
  const sku = listing.sku;
  const queryClient = useQueryClient();
  const detailBinding = ozonManualJobDetailBinding(fallbackJob);
  const publicationId = detailBinding.kind === 'PUBLICATION' ? detailBinding.publicationId : undefined;
  const detail = useQuery<OzonManualJobDetail | OzonPublicationTaskDetail>({
    queryKey: ['ozon-manual-job', sku, jobId, publicationId],
    queryFn: () => detailBinding.kind === 'PUBLICATION'
      ? api.ozonPublicationTaskDetail(detailBinding.publicationId)
      : api.ozonManualJob(sku, detailBinding.kind === 'PURE_LEGACY' ? detailBinding.jobId : jobId!),
    enabled: Boolean(jobId && fallbackJob && detailBinding.kind !== 'UNSUPPORTED'),
    retry: false,
    refetchInterval: (result) => ozonJobIsActive(result.state.data?.job) ? 10_000 : false
  });
  const publicationDetail = detail.data && 'publication' in detail.data ? detail.data : undefined;
  const legacyDetail = detail.data && !('publication' in detail.data) ? detail.data : undefined;
  const detailEvents = publicationDetail?.events;
  const job = detail.data?.job ? {
    ...detail.data.job,
    ...(detailEvents ? { events: detailEvents } : {})
  } : fallbackJob;
  const recovery = legacyDetail?.recovery;
  const publicationRecovery = publicationDetail?.recovery;
  const publication = publicationDetail?.publication;
  const networkRecovery = job ? ozonJobNetworkRecovery(job) : undefined;
  const publicationManaged = Boolean(publicationId);
  const publicationCanRecheck = Boolean(publication && publicationRecovery?.canRecheck === true);
  const invalidateDetailQueries = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['ozon-listing', sku] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-listings'] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-publications'] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-manual-jobs', sku] }),
    queryClient.invalidateQueries({ queryKey: ['ozon-manual-job', sku, job?.id] })
  ]);
  const recheck = useMutation({
    mutationFn: async () => {
      if (publication) {
        const current = await api.ozonPublicationTaskDetail(publication.id);
        if (!current.recovery.canRecheck) {
          throw new Error(current.recovery.blockedReason || '当前 publication 不允许安全重检');
        }
        return api.recheckOzonPublication(
          publication.id,
          requireOzonPublicationRecheckInput(current.publication, current.frozenContract)
        );
      }
      return api.recheckOzonManualJob(sku, job!.id, job!.rowVersion);
    },
    onSuccess: async () => {
      message.success(publication ? '原 publication attempt 已重新检查，将继续使用固定任务身份' : '原任务已恢复，将复用现有 OZON 导入任务继续处理');
      await invalidateDetailQueries();
    },
    onError: showError
  });
  const returnToEdit = useMutation({
    mutationFn: () => api.returnOzonManualJobToEdit(sku, job!.id, { jobRowVersion: job!.rowVersion, listingRowVersion: listing.rowVersion }),
    onSuccess: async (result) => {
      message.success(`媒体已通过${result.recovery.mode === 'HARDLINK' ? '硬链接' : '复制'}恢复，任务已返回编辑`);
      await invalidateDetailQueries();
      onClose();
    },
    onError: showError
  });
  const platformFieldError = recovery?.action === 'RETURN_TO_EDIT';
  const frozenContract = publicationDetail?.frozenContract;
  return <Drawer
    className="ozon-drawer ozon-manual-job-drawer"
    width="min(700px, 96vw)"
    open={Boolean(jobId)}
    title={`手动任务详情 · ${sku}`}
    onClose={onClose}
  >
    {detail.isLoading && !job ? <Skeleton active /> : detail.isError && !job ? <Alert showIcon type="error" message="手动任务详情读取失败" description={detail.error.message} action={<Button onClick={() => void detail.refetch()}>重新读取</Button>} /> : job ? <>
      {detail.isError && <Alert className="ozon-manual-job-detail-warning" showIcon type="warning" message="正在显示清单快照" description="完整事件与冻结合同暂时无法读取，可稍后重试。" />}
      {detailBinding.kind === 'UNSUPPORTED' && <Alert className="ozon-manual-job-detail-warning" showIcon type="error" message="任务合同不完整" description={detailBinding.reason} />}
      {publicationManaged && <Alert className="ozon-manual-job-detail-warning" showIcon type="info" message="该任务由店铺 publication 管理" description="本页已按 publicationId 读取完整事件、冻结合同与恢复能力；不会调用迁移前 SKU/job 详情接口。" />}
      {publicationManaged && publicationRecovery?.blockedReason && <Alert className="ozon-manual-job-detail-warning" showIcon type="warning" message="原 attempt 暂不能恢复" description={publicationRecovery.blockedReason} />}
      <OzonSourceMediaCleanupStatus summary={publicationDetail?.sourceMediaCleanup} />
      {!publicationManaged && recovery && !networkRecovery && <Alert className="ozon-manual-job-detail-warning" showIcon type={recovery.retryable ? 'info' : recovery.action === 'NONE' ? 'warning' : 'error'} message={recovery.action === 'RECHECK' ? '可继续处理原任务' : recovery.action === 'RETURN_TO_EDIT' ? '需要返回编辑' : '需要人工处理'} description={recovery.reason} />}
      {publication && <Descriptions size="small" bordered column={1} items={[
        { key: 'publication', label: 'Publication ID', children: <code>{publication.id}</code> },
        { key: 'plan', label: '冻结 planHash', children: <code>{publication.planHash || ozonSnapshotString(frozenContract?.planHash) || '—'}</code> },
        { key: 'material', label: '公共素材哈希', children: <code>{ozonSnapshotString(frozenContract?.materialHash) || '—'}</code> },
        { key: 'policy', label: '内容策略', children: publication.contentPolicyVersion || ozonSnapshotString(frozenContract?.contentPolicyVersion) || '—' },
        { key: 'mode', label: '发布模式', children: publication.publicationMode || ozonSnapshotString(frozenContract?.publicationMode) || '—' }
      ]} />}
      <OzonPlatformStatusLedger offerIds={ozonJobOfferIds(job)} links={ozonJobProductLinks(job)} title={publicationManaged ? '该 publication 的平台结果' : '该任务的迁移前平台结果'} />
      <JobDetail job={job} recovery={recovery} />
      {publicationManaged && publicationCanRecheck && <Popconfirm title="重检原 publication attempt？" description="系统会复用固定 publicationId、jobId、requestId 与冻结合同；不会新建任务或重复平台写入。" okText="重检原任务" cancelText="取消" onConfirm={() => recheck.mutate()}><Button type="primary" icon={<ReloadOutlined />} loading={recheck.isPending}>重检原任务</Button></Popconfirm>}
      {!publicationManaged && recovery?.action === 'RECHECK' && <Popconfirm title="继续处理原任务？" description="系统会复用现有 OZON task_id，仅重试尚未成功的价格或库存，不会重新创建商品。" okText="继续处理" cancelText="取消" onConfirm={() => recheck.mutate()}><Button type="primary" icon={<ReloadOutlined />} loading={recheck.isPending}>继续处理原任务</Button></Popconfirm>}
      {!publicationManaged && platformFieldError && <Popconfirm title="返回编辑并修正该任务？" description="媒体会恢复到 inbox；原失败目录和 product.json 会完整保留。" okText="返回编辑" cancelText="取消" onConfirm={() => returnToEdit.mutate()}><Button type="primary" danger icon={<EditOutlined />} loading={returnToEdit.isPending}>返回编辑并修正</Button></Popconfirm>}
    </> : null}
  </Drawer>;
}

const ozonSourceCleanupStateMeta: Record<OzonSourceMediaCleanupSummary['state'], { label: string; color: string }> = {
  WAITING_TARGETS: { label: '等待全部店铺成功', color: 'default' },
  READY: { label: '等待清理复核', color: 'blue' },
  QUARANTINING: { label: '正在隔离', color: 'processing' },
  QUARANTINED: { label: '已隔离待删除', color: 'processing' },
  CLEANED: { label: '来源媒体已清理', color: 'green' },
  SUPERSEDED: { label: '已被新素材替代', color: 'gold' },
  RETRY_WAIT: { label: '等待安全重试', color: 'orange' },
  BLOCKED: { label: '清理已阻止', color: 'red' }
};

function OzonSourceMediaCleanupStatus({ summary }: { summary?: OzonSourceMediaCleanupSummary }) {
  if (!summary) return null;
  const state = ozonSourceCleanupStateMeta[summary.state];
  const terminal = summary.state === 'CLEANED';
  const blocked = summary.state === 'BLOCKED';
  return <Alert
    className="ozon-source-media-cleanup-alert"
    showIcon
    type={terminal ? 'success' : blocked ? 'error' : ['RETRY_WAIT', 'QUARANTINING', 'QUARANTINED'].includes(summary.state) ? 'warning' : 'info'}
    message={<Space size={7} wrap><strong>来源媒体清理</strong><Tag color={state.color}>{state.label}</Tag><Tag>R{summary.revision}</Tag></Space>}
    description={<div className="ozon-source-media-cleanup-detail">
      <span>稳定版本 <code>{summary.generatedVersionId}</code></span>
      <span>目标店铺 {summary.targetStoreCount} 家 · 已回收 {formatOzonCleanupBytes(summary.reclaimedBytes)}</span>
      <Space size={[6, 4]} wrap>{summary.artifacts.map((artifact) => <Tag key={artifact.kind} color={ozonSourceCleanupStateMeta[artifact.state].color}>{artifact.kind === 'RAW_INBOX' ? '原始 inbox' : '共享版本'}：{ozonSourceCleanupStateMeta[artifact.state].label}</Tag>)}</Space>
      {summary.blockedReason && <span className="ozon-source-media-cleanup-reason">{summary.blockedReason}</span>}
      {terminal && <span>成功包、publication、任务事件及商品链接仍永久保留；该稳定版本已只读，不能再次物化。</span>}
    </div>}
  />;
}

function formatOzonCleanupBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function ActiveJobNotice({ job, canManualTakeover, onOpenJob }: { job: OzonActiveJobSummary; canManualTakeover: boolean; onOpenJob?: (jobId: string) => void }) {
  const state = jobStateMeta[job.state];
  const canResumeManual = job.source === 'MANUAL' && job.recoveryAction === 'RECHECK';
  const waitingNetwork = job.networkRecovery?.status === 'WAITING_NETWORK';
  return <Alert
    className="ozon-active-job-alert"
    showIcon
    type={canManualTakeover ? 'info' : 'warning'}
    message={<Space size={7} wrap><strong>{waitingNetwork ? '网络中断，原 OZON 任务等待自动续跑' : canManualTakeover ? '检测到等待媒体的自动任务' : '该 SKU 已有进行中的 OZON 上品任务'}</strong><Tag>{job.source === 'AUTO' ? '自动' : '手动'}</Tag><Tag color={state?.color}>{state?.label || job.state}</Tag>{waitingNetwork && <Tag color="blue">网络恢复等待</Tag>}</Space>}
    description={<div className="ozon-active-job-description"><span>任务 ID <code>{job.id}</code></span><span>{waitingNetwork ? `系统会继续使用原任务；下次检查 ${dayjs(job.networkRecovery!.nextAttemptAt).format('MM-DD HH:mm:ss')}。` : canManualTakeover ? '该任务尚未进入 n8n 或 OZON；手动提交将自动替代它，并保留旧任务的审计记录。' : canResumeManual ? '该任务已进入 OZON，不能重复创建；可继续处理原任务。' : job.source === 'MANUAL' ? '该任务已进入远程阶段，不能重复创建；请在手动任务详情中查看平台结果。' : '该自动任务已进入远程阶段；请到“自动上品任务”继续处理。'}</span></div>}
    action={onOpenJob ? <Button size="small" onClick={() => onOpenJob(job.id)}>{canResumeManual ? '继续处理' : '查看手动任务'}</Button> : undefined}
  />;
}

export type OzonAutoPreparationAction = 'INITIALIZE' | 'SCAN';

export function ozonListingEditorContextKey(context?: OzonListingEditorContext): string | undefined {
  if (!context) return undefined;
  return context.mode === 'MANUAL_DRAFT'
    ? `MANUAL_DRAFT:${context.sku}:${context.initialManualJobId || ''}`
    : `AUTO_TASK_SNAPSHOT:${context.storeId}:${context.jobId}:${context.sku}`;
}

export function ozonEditorSessionMatches(
  active: { contextKey?: string; sessionId: number },
  targetContextKey: string | undefined,
  sessionId: number
): boolean {
  return Boolean(targetContextKey) && active.contextKey === targetContextKey && active.sessionId === sessionId;
}

export function mergeOzonListingPricesByOfferId<T extends { offerId: string }>(
  offers: T[],
  prices: Array<{ offerId: string; price: number; oldPrice?: number; minPrice?: number }>
): Array<T & { price?: number; oldPrice?: number; minPrice?: number }> {
  const priceByOfferId = new Map<string, Array<(typeof prices)[number]>>();
  for (const price of prices) {
    priceByOfferId.set(price.offerId, [...(priceByOfferId.get(price.offerId) || []), price]);
  }
  return offers.map((offer) => {
    const matches = priceByOfferId.get(offer.offerId) || [];
    if (matches.length !== 1) return { ...offer, price: undefined, oldPrice: undefined, minPrice: undefined };
    const match = matches[0]!;
    return {
      ...offer,
      price: match.price,
      oldPrice: match.oldPrice,
      minPrice: match.minPrice
    };
  });
}

export function projectOptionalOzonListingPrices<T extends { offerId: string }>(
  offers: T[],
  prices: Array<{ offerId: string; price: number; oldPrice?: number; minPrice?: number }> | undefined,
  failClosed: boolean
): Array<T & { price?: number; oldPrice?: number; minPrice?: number }> {
  if (failClosed) return offers.map((offer) => ({ ...offer, price: undefined, oldPrice: undefined, minPrice: undefined }));
  return prices ? mergeOzonListingPricesByOfferId(offers, prices) : offers;
}

export function ozonListingPriceProjectionComplete(
  offers: Array<{ offerId: string }>,
  prices: Array<{ offerId: string }>
): boolean {
  const counts = new Map<string, number>();
  for (const price of prices) counts.set(price.offerId, (counts.get(price.offerId) || 0) + 1);
  return offers.every((offer) => counts.get(offer.offerId) === 1)
    && prices.every((price) => offers.some((offer) => offer.offerId === price.offerId));
}

export function nextOzonAutoPreparationAction(input: {
  sku?: string;
  status?: OzonListingDraft['status'];
  needsInitialization: boolean;
  initializationAttemptedFor?: string;
  initializationFinishedFor?: string;
  mediaScanAttemptedFor?: string;
  initializationPending: boolean;
  mediaScanPending: boolean;
}): OzonAutoPreparationAction | undefined {
  if (!input.sku || !input.status || !['DRAFT', 'READY'].includes(input.status)) return undefined;
  if (input.initializationPending || input.mediaScanPending) return undefined;
  if (input.needsInitialization) {
    if (input.initializationAttemptedFor !== input.sku) return 'INITIALIZE';
    if (input.initializationFinishedFor !== input.sku) return undefined;
  }
  return input.mediaScanAttemptedFor === input.sku ? undefined : 'SCAN';
}

function ozonListingNeedsInitialization(listing: OzonListingDraft): boolean {
  if (!String(listing.data.titleRu || '').trim() || !String(listing.data.descriptionRu || '').trim()) return true;
  if (listing.data.offers.some((offer) => !String(offer.descriptionRu || '').trim())) return true;
  return Boolean(listing.data.initialization?.issues.some((issue) => issue.retryable));
}

function ozonMediaSuggestionKey(listing: OzonListingDraft): string {
  return JSON.stringify({
    sku: listing.sku,
    rowVersion: listing.rowVersion,
    assets: (listing.data.mediaAssets || []).map((asset) => [asset.assetId, asset.sha256, asset.validationStatus, asset.sortOrder, asset.productVariantId, asset.productVariantColor?.colorKey, asset.sourceStageId, asset.sourceSubmissionId, asset.deliveredAt]),
    offers: listing.data.offers.map((offer) => [
      offer.variantId,
      offer.productVariantId,
      offer.productVariantName,
      offer.productVariantColor?.colorKey,
      offer.media.map((reference) => reference.assetId)
    ])
  });
}

function ozonOfferIdentityKey(offers: any[]): string {
  return JSON.stringify((offers || []).map((offer) => [
    String(offer?.variantId || ''),
    String(offer?.productVariantId || ''),
    String(offer?.productVariantName || ''),
    String(offer?.productVariantColor?.colorKey || '')
  ]));
}

export function mergeOzonOffersAfterScan(currentOffers: any[], scannedOffers: OzonListingDraftInput['offers'], mediaAssets: OzonMediaAsset[]): any[] {
  const assets = new Map(mediaAssets.filter((asset) => asset.validationStatus === 'VALID').map((asset) => [asset.assetId, asset]));
  return currentOffers.map((offer) => {
    const scanned = findOzonOfferByIdentity(scannedOffers, offer);
    const media = normalizeOzonMediaReferences((offer.media || []).flatMap((reference: OzonOfferMediaReference) => {
      const asset = assets.get(reference.assetId);
      return asset ? [{ ...reference, relativePath: asset.relativePath, kind: asset.kind }] : [];
    }));
    return { ...(scanned || {}), ...offer, media };
  });
}

export function mergeOzonInitializationIntoForm(currentValues: any, initialized: OzonListingDraft, touchedFields: ReadonlySet<string>): any {
  const currentOffers = Array.isArray(currentValues.offers) ? currentValues.offers : [];
  const offers = currentOffers.map((current: any) => {
    const serverOffer = findOzonOfferByIdentity(initialized.data.offers, current);
    if (!serverOffer) return current;
    const currentIdentity = String(current.productVariantId || current.variantId || '');
    const keepCurrentDescription = touchedFields.has(`offer:${currentIdentity}:descriptionRu`) || Boolean(String(current.descriptionRu || '').trim());
    return {
      ...serverOffer,
      ...current,
      productVariantId: current.productVariantId || serverOffer.productVariantId,
      productVariantName: current.productVariantName || serverOffer.productVariantName,
      productVariantColor: current.productVariantColor || serverOffer.productVariantColor,
      descriptionRu: keepCurrentDescription ? current.descriptionRu : serverOffer.descriptionRu,
      descriptionSource: keepCurrentDescription ? current.descriptionSource : serverOffer.descriptionSource,
      modelGroup: initialized.sku,
      offerAttributeValues: current.offerAttributeValues || presetAttributeValues(serverOffer.attributes)
    };
  });
  const keepCurrentTitle = touchedFields.has('titleRu') || Boolean(String(currentValues.titleRu || '').trim());
  const keepCurrentDescription = touchedFields.has('descriptionRu') || Boolean(String(currentValues.descriptionRu || '').trim());
  return {
    ...initialized.data,
    ...currentValues,
    dimensions: ozonDimensionsWithManagedGrossWeight(
      currentValues.dimensions || initialized.data.dimensions,
      ozonGrossWeightResolution(initialized.data.initialization)
    ),
    titleRu: keepCurrentTitle ? currentValues.titleRu : initialized.data.titleRu,
    descriptionRu: keepCurrentDescription ? currentValues.descriptionRu : initialized.data.descriptionRu,
    descriptionSource: keepCurrentDescription ? currentValues.descriptionSource : initialized.data.descriptionSource,
    offers
  };
}

function findOzonOfferByIdentity<T extends { variantId?: string; productVariantId?: string }>(offers: T[], target: { variantId?: string; productVariantId?: string }): T | undefined {
  const identities = new Set([target.productVariantId, target.variantId].map((value) => String(value || '').trim()).filter(Boolean));
  if (!identities.size) return undefined;
  return offers.find((offer) => [offer.productVariantId, offer.variantId]
    .map((value) => String(value || '').trim())
    .some((identity) => identities.has(identity)));
}

function markOzonDescriptionSourceAfterEdit(form: any, changedValues: any): void {
  if (Object.prototype.hasOwnProperty.call(changedValues || {}, 'descriptionRu')) {
    form.setFieldValue('descriptionSource', { type: 'MANUAL' });
  }
  if (!Array.isArray(changedValues?.offers)) return;
  changedValues.offers.forEach((changedOffer: any, index: number) => {
    if (!changedOffer || !Object.prototype.hasOwnProperty.call(changedOffer, 'descriptionRu')) return;
    const offer = form.getFieldValue(['offers', index]) || {};
    const productVariantId = offer.productVariantId || offer.variantId;
    form.setFieldValue(['offers', index, 'descriptionSource'], {
      type: String(changedOffer.descriptionRu || '').trim() ? 'MANUAL' : 'SHARED',
      ...(productVariantId ? { productVariantId } : {})
    });
  });
}

type OzonOfferMediaReference = OzonListingDraftInput['offers'][number]['media'][number];

function OzonMediaAssignment({
  sku,
  offers,
  offerIndex,
  mediaAssets,
  videoCompatibility,
  immutable,
  onChange
}: {
  sku: string;
  offers: any[];
  offerIndex: number;
  mediaAssets: OzonMediaAsset[];
  videoCompatibility: OzonVideoCompatibility;
  immutable: boolean;
  onChange: (offers: any[]) => void;
}) {
  const [draggedId, setDraggedId] = useState<string>();
  const [sharedAsset, setSharedAsset] = useState<OzonMediaAsset>();
  const [targetVariantIds, setTargetVariantIds] = useState<string[]>([]);
  const offer = offers[offerIndex] || {};
  const references = normalizeOzonMediaReferences(offer.media || []);
  const imageReferences = references.filter((reference) => reference.kind === 'image');
  const videoReference = references.find((reference) => reference.kind === 'video');
  const images = mediaAssets.filter((asset) => asset.kind === 'image');
  const videos = mediaAssets.filter((asset) => asset.kind === 'video');
  const replaceOffers = (nextOffers: any[]) => onChange(nextOffers);
  const replaceCurrentMedia = (media: OzonOfferMediaReference[]) => replaceOffers(offers.map((candidate, index) => index === offerIndex ? { ...candidate, media: normalizeOzonMediaReferences(media) } : candidate));
  const toggleCurrent = (asset: OzonMediaAsset) => {
    if (asset.validationStatus !== 'VALID') return;
    const selected = references.some((reference) => reference.assetId === asset.assetId);
    if (asset.kind === 'image' && !selected && imageReferences.length >= 15) {
      message.error('每个 OZON 变体最多只能使用 15 张图片');
      return;
    }
    replaceCurrentMedia(assignOzonAsset(references, asset, !selected));
  };
  const applyToAll = (asset: OzonMediaAsset) => {
    if (asset.validationStatus !== 'VALID') return;
    let skipped = 0;
    replaceOffers(offers.map((candidate) => {
      const current = normalizeOzonMediaReferences(candidate.media || []);
      if (asset.kind === 'image' && !current.some((reference) => reference.assetId === asset.assetId) && current.filter((reference) => reference.kind === 'image').length >= 15) {
        skipped += 1;
        return candidate;
      }
      return { ...candidate, media: assignOzonAsset(current, asset, true) };
    }));
    if (skipped) message.warning(`${skipped} 个变体已有 15 张图片，未添加该图片`);
  };
  const openVariantAssignment = (asset: OzonMediaAsset) => {
    setSharedAsset(asset);
    setTargetVariantIds(offers.filter((candidate) => normalizeOzonMediaReferences(candidate.media || []).some((reference) => reference.assetId === asset.assetId)).map((candidate) => String(candidate.variantId)));
  };
  const applyToSelectedVariants = () => {
    if (!sharedAsset) return;
    const targets = new Set(targetVariantIds);
    let skipped = 0;
    replaceOffers(offers.map((candidate) => {
      const current = normalizeOzonMediaReferences(candidate.media || []);
      const selected = targets.has(String(candidate.variantId));
      if (selected && sharedAsset.kind === 'image' && !current.some((reference) => reference.assetId === sharedAsset.assetId) && current.filter((reference) => reference.kind === 'image').length >= 15) {
        skipped += 1;
        return candidate;
      }
      return { ...candidate, media: assignOzonAsset(current, sharedAsset, selected) };
    }));
    setSharedAsset(undefined);
    if (skipped) message.warning(`${skipped} 个变体已有 15 张图片，未添加该图片`);
  };
  const moveImage = (assetId: string, direction: -1 | 1) => {
    const index = imageReferences.findIndex((reference) => reference.assetId === assetId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= imageReferences.length) return;
    const nextImages = [...imageReferences];
    [nextImages[index], nextImages[target]] = [nextImages[target]!, nextImages[index]!];
    replaceCurrentMedia([...nextImages, ...(videoReference ? [videoReference] : [])]);
  };
  const reorderImages = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const nextImages = [...imageReferences];
    const from = nextImages.findIndex((reference) => reference.assetId === fromId);
    const to = nextImages.findIndex((reference) => reference.assetId === toId);
    if (from < 0 || to < 0) return;
    const [moved] = nextImages.splice(from, 1);
    if (!moved) return;
    nextImages.splice(to, 0, moved);
    replaceCurrentMedia([...nextImages, ...(videoReference ? [videoReference] : [])]);
  };
  const mediaGroups = [...mediaAssets.reduce((groups, asset) => {
    const key = asset.productVariantName || '未识别变体';
    const items = groups.get(key) || [];
    items.push(asset);
    groups.set(key, items);
    return groups;
  }, new Map<string, OzonMediaAsset[]>())];
  return <><div className="ozon-media-workbench">
    <section className="ozon-media-library">
      <div className="ozon-media-section-title"><div><strong>共享媒体库</strong><Text type="secondary">文件只保存一份，可同时分配给多个 OZON 变体。</Text></div><Space><Tag>{images.length} 图</Tag><Tag>{videos.length} 视频</Tag></Space></div>
      {!mediaAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="variants 目录中还没有媒体。请先从 E004/E005 审核工作台投递，再扫描目录。" /> : <div className="ozon-media-groups">{mediaGroups.map(([groupName, groupAssets]) => <section className={`ozon-media-variant-group${groupName === '未识别变体' ? ' is-unidentified' : ''}`} key={groupName}>
        <div className="ozon-media-variant-heading"><Space wrap><strong>{groupName}</strong>{groupName === '未识别变体' ? <Tag color="warning">未匹配清单</Tag> : <Tag color="blue">产品变体</Tag>}{groupAssets.some((asset) => asset.productVariantId === offer.variantId) && <Tag color="green">当前变体来源</Tag>}</Space><Text type="secondary">{groupAssets.length} 个媒体</Text></div>
        <div className="ozon-media-grid">{groupAssets.map((asset) => {
          const selected = references.some((reference) => reference.assetId === asset.assetId);
          const invalid = asset.validationStatus !== 'VALID';
          return <article className={`ozon-media-tile${selected ? ' is-selected' : ''}${invalid ? ' is-invalid' : ''}`} key={asset.assetId}>
            <div className="ozon-media-preview">{invalid ? <div className="ozon-media-invalid-preview"><SafetyCertificateOutlined /><span>校验失败</span></div> : asset.kind === 'image' ? <Image preview={{ src: api.ozonMediaUrl(sku, asset.assetId) }} src={`${api.ozonMediaUrl(sku, asset.assetId)}?thumbnail=true`} alt={asset.relativePath} /> : <video controls preload="metadata" aria-label={`预览视频 ${mediaFileName(asset.relativePath)}`} src={api.ozonMediaUrl(sku, asset.assetId)} />}</div>
            <Tooltip title={asset.relativePath}><strong>{mediaFileName(asset.relativePath)}</strong></Tooltip>
            <Text type={invalid ? 'danger' : 'secondary'}>{invalid ? asset.validationError : `${formatOzonBytes(asset.sizeBytes)}${asset.sourceStageId ? ` · ${asset.sourceStageId}` : ''}`}</Text>
            {asset.kind === 'video' && <OzonVideoPurposeTags compatibility={videoCompatibility} compact />}
            <Checkbox disabled={immutable || invalid} checked={selected} onChange={() => toggleCurrent(asset)}>{asset.kind === 'image' ? '用于当前变体' : '设为产品视频/封面'}</Checkbox>
            <Space size={6} wrap><Button size="small" disabled={immutable || invalid} onClick={() => openVariantAssignment(asset)}>应用到变体…</Button><Button size="small" disabled={immutable || invalid} onClick={() => applyToAll(asset)}>应用到全部变体</Button></Space>
          </article>;
        })}</div>
      </section>)}</div>}
    </section>
    <section className="ozon-media-selection">
      <div className="ozon-media-section-title"><div><strong>{offer.offerId || `变体 ${offerIndex + 1}`} 的图片顺序</strong><Text type="secondary">拖拽或使用按钮排序；第 1 张是主图。</Text></div><Tag color={imageReferences.length ? 'blue' : 'warning'}>{imageReferences.length} / 15</Tag></div>
      {!imageReferences.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前变体还没有图片" /> : <List className="ozon-selected-media" dataSource={imageReferences} renderItem={(reference, index) => {
        const asset = mediaAssets.find((candidate) => candidate.assetId === reference.assetId);
        if (!asset) return null;
        return <List.Item draggable={!immutable} onDragStart={() => setDraggedId(asset.assetId)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedId) reorderImages(draggedId, asset.assetId); setDraggedId(undefined); }} actions={[
          <Button aria-label={`上移 ${asset.relativePath}`} type="text" icon={<ArrowUpOutlined />} disabled={immutable || index === 0} onClick={() => moveImage(asset.assetId, -1)} />,
          <Button aria-label={`下移 ${asset.relativePath}`} type="text" icon={<ArrowDownOutlined />} disabled={immutable || index === imageReferences.length - 1} onClick={() => moveImage(asset.assetId, 1)} />,
          <Button aria-label={`移除 ${asset.relativePath}`} danger type="text" icon={<DeleteOutlined />} disabled={immutable} onClick={() => toggleCurrent(asset)} />
        ]}><List.Item.Meta avatar={<span className={`ozon-photo-number${index === 0 ? ' is-cover' : ''}`}>{index + 1}</span>} title={mediaFileName(asset.relativePath)} description={index === 0 ? 'OZON 主图' : `图片 ${index + 1}`} /></List.Item>;
      }} />}
      <Divider orientation="left">产品视频/封面</Divider>
      {videoReference ? <div className="ozon-selected-video"><VideoCameraOutlined /><div><strong>{mediaFileName(videoReference.relativePath)}</strong><OzonVideoPurposeTags compatibility={videoCompatibility} /><Text type="secondary">只上传这一个 MP4；支持时同一公网 URL 同时写入两个 OZON 用途，也可被同一 SKU 的其他变体复用。</Text></div><Button danger type="text" disabled={immutable} onClick={() => {
        const asset = mediaAssets.find((candidate) => candidate.assetId === videoReference.assetId);
        if (asset) toggleCurrent(asset);
      }}>移除</Button></div> : <Alert showIcon type="warning" message="当前变体还需要 1 个产品视频/封面 MP4" description="选择一个 MP4 即可；系统不会为两个用途复制媒体文件。" />}
    </section>
  </div>
  <Modal title={`分配媒体：${sharedAsset ? mediaFileName(sharedAsset.relativePath) : ''}`} open={Boolean(sharedAsset)} okText="保存分配" cancelText="取消" okButtonProps={{ disabled: !sharedAsset }} onOk={applyToSelectedVariants} onCancel={() => setSharedAsset(undefined)}>
    <Paragraph type="secondary">同一文件可复用给多个变体；取消勾选只会移除分配关系，不会删除磁盘文件。</Paragraph>
    <Checkbox.Group className="ozon-variant-assignment-options" value={targetVariantIds} onChange={(values) => setTargetVariantIds(values as string[])} options={offers.map((candidate, index) => ({ value: String(candidate.variantId), label: candidate.offerId || `变体 ${index + 1}` }))} />
  </Modal></>;
}

function assignOzonAsset(references: OzonOfferMediaReference[], asset: OzonMediaAsset, selected: boolean): OzonOfferMediaReference[] {
  const withoutAsset = references.filter((reference) => reference.assetId !== asset.assetId);
  if (!selected) return normalizeOzonMediaReferences(withoutAsset);
  const withoutConflictingVideo = asset.kind === 'video' ? withoutAsset.filter((reference) => reference.kind !== 'video') : withoutAsset;
  return normalizeOzonMediaReferences([...withoutConflictingVideo, {
    assetId: asset.assetId,
    relativePath: asset.relativePath,
    kind: asset.kind,
    sortOrder: withoutConflictingVideo.length,
    isPrimary: false
  }]);
}

function normalizeOzonMediaReferences(input: OzonOfferMediaReference[]): OzonOfferMediaReference[] {
  const unique = [...new Map((Array.isArray(input) ? input : []).filter((reference) => reference?.assetId).map((reference) => [reference.assetId, reference])).values()];
  const ordered = [...unique.filter((reference) => reference.kind !== 'video'), ...unique.filter((reference) => reference.kind === 'video').slice(0, 1)];
  const firstImageIndex = ordered.findIndex((reference) => reference.kind !== 'video');
  return ordered.map((reference, index) => ({
    assetId: String(reference.assetId),
    relativePath: String(reference.relativePath),
    kind: reference.kind === 'video' ? 'video' : 'image',
    sortOrder: index,
    isPrimary: index === firstImageIndex && reference.kind !== 'video'
  }));
}

function resolveOzonMediaDirectory(rootOrProductRoot: string, sku: string): string {
  const value = String(rootOrProductRoot || '').replace(/[\\/]+$/, '');
  if (!value) return '';
  const separator = value.includes('\\') ? '\\' : '/';
  const normalized = value.replaceAll('\\', '/').toLocaleLowerCase();
  if (normalized.endsWith(`/inbox/${sku.toLocaleLowerCase()}`)) return `${value}${separator}variants`;
  return `${value}${separator}inbox${separator}${sku}${separator}variants`;
}

function mediaFileName(relativePath: string): string {
  return String(relativePath || '').replaceAll('\\', '/').split('/').pop() || relativePath;
}

function formatOzonBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function OzonPurchaseManagedFields({
  sku,
  attributes,
  projection,
  latestProcurement,
  savedSnapshot,
  loading,
  error
}: {
  sku: string;
  attributes: OzonCategoryAttribute[];
  projection?: OzonPurchaseProjectionView;
  latestProcurement?: ProcurementVersion;
  savedSnapshot?: OzonManualPurchaseMeasurements;
  loading: boolean;
  error: Error | null;
}) {
  const effectiveSnapshot = projection?.snapshot ?? savedSnapshot;
  const versionNo = projection?.snapshot.procurementVersionNo ?? latestProcurement?.versionNo ?? savedSnapshot?.procurementVersionNo;
  const valueFor = (purchaseField: (typeof OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS)[number]['purchaseField']) => {
    const projectedValue = projection?.fields.find((field) => field.purchaseField === purchaseField)?.value;
    const input = projection
      ? projectedValue
      : latestProcurement
      ? latestProcurement[purchaseField]
      : effectiveSnapshot?.[purchaseField];
    if (input === undefined || input === null || String(input).trim() === '') return null;
    const value = Number(input);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 4, useGrouping: false });
  };
  const warning = projection?.warning || (!projection && error ? error.message : '');
  return <section className="ozon-purchase-managed-fields ozon-purchase-managed-workbench">
    <Alert
      showIcon
      icon={<LockOutlined />}
      type={warning || projection?.source === 'SNAPSHOT' ? 'warning' : 'info'}
      message="采购管理自动取值"
      description={warning || projection?.source === 'SNAPSHOT'
        ? `最新采购信息暂时读取失败，页面显示草稿快照；保存和生成时仍由服务端重新读取。${warning}`
        : `以下属性不可在 OZON 工作台覆盖，保存和生成时读取采购管理最新采购版本${versionNo ? ` V${versionNo}` : ''}。`}
      action={<Button type="link" href={`/purchases/url-download?query=${encodeURIComponent(sku)}`}>前往产品URL下载</Button>}
    />
    {loading && !projection ? <Skeleton active paragraph={{ rows: 1 }} /> : <div className="ozon-purchase-managed-grid">
      {attributes.map((attribute) => {
        const binding = OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS.find((item) => item.attributeId === attribute.id)!;
        const projectedField = projection?.fields.find((field) => field.attributeId === attribute.id);
        const value = valueFor(binding.purchaseField);
        const missingRequired = (projectedField?.required ?? attribute.required) && value === null;
        return <div key={ozonAttributeKey(attribute)} className={`ozon-purchase-managed-item${missingRequired ? ' has-error' : ''}`}>
          <LockOutlined aria-hidden="true" />
          <span>
            <strong>{binding.labelZh}{attribute.required && <Text type="danger"> *</Text>}</strong>
            <small>{binding.labelRu} · #{binding.attributeId}</small>
          </span>
          {value === null
            ? <Tag color={missingRequired ? 'red' : 'default'}>{missingRequired ? '采购信息必填，请补充' : '采购信息未填写，本次不上传'} · 采购 V{versionNo || '—'}</Tag>
            : <Tag color="blue">{value} {binding.unit} · 采购 V{versionNo || '—'}</Tag>}
        </div>;
      })}
    </div>}
  </section>;
}

type OzonCategoryTypeDescriptor = Pick<OzonCategoryTemplate, 'typeId' | 'nameZh' | 'nameRu'>;

function OzonCategoryTypeReadOnlyField({ attribute, categoryType }: {
  attribute: OzonCategoryAttribute;
  categoryType?: OzonCategoryTypeDescriptor;
}) {
  const typeNameZh = String(categoryType?.nameZh || '').trim() || '中文类型名缺失';
  const typeNameRu = String(categoryType?.nameRu || '').trim() || '俄文类型名缺失';
  return <Form.Item
    key={ozonAttributeKey(attribute)}
    required={attribute.required}
    label={<span className="ozon-preset-attribute-label"><strong>{ozonAttributeNameZh(attribute) || '类型'}</strong><small>{ozonAttributeNameRu(attribute) || 'Тип'}</small></span>}
    extra="由所选 OZON 类目模板自动确定，保存时写入平台类型。"
  >
    <Input
      aria-label="OZON 类目类型（系统只读）"
      readOnly
      value={`${typeNameZh} / ${typeNameRu}`}
      suffix={<Tag color="blue">系统只读</Tag>}
    />
  </Form.Item>;
}

function OzonListingAttributeFields({ attributes, formPath, dictionarySnapshot, categoryType }: {
  attributes: OzonCategoryAttribute[];
  formPath: Array<string | number>;
  dictionarySnapshot: Record<string, Array<{ id: number; value: string; info?: string }>>;
  categoryType?: OzonCategoryTypeDescriptor;
}) {
  const [showOptional, setShowOptional] = useState(false);
  const required = attributes.filter((attribute) => attribute.required);
  const optional = attributes.filter((attribute) => !attribute.required);
  const visible = showOptional ? [...required, ...optional] : required;
  return <div className="ozon-listing-attribute-group">
    {!visible.length && !optional.length ? <Text type="secondary">当前范围没有可填写的 OZON 字段</Text> : <div className="ozon-attribute-grid">{visible.map((attribute) => attribute.id === 8229 && attribute.complexId === 0
      ? <OzonCategoryTypeReadOnlyField key={ozonAttributeKey(attribute)} attribute={attribute} categoryType={categoryType} />
      : <Form.Item
        key={ozonAttributeKey(attribute)}
        name={[...formPath, ozonAttributeKey(attribute)]}
        label={<Space size={6} align="start"><span className="ozon-preset-attribute-label"><strong>{ozonAttributeNameZh(attribute) || '中文名缺失'}</strong><small>{ozonAttributeNameRu(attribute) || '俄文名缺失'}</small></span>{attribute.required && <Text type="danger">*</Text>}<span className="ozon-mono-small">#{attribute.id}{attribute.complexId ? `:${attribute.complexId}` : ''}</span></Space>}
        rules={attribute.required ? [{ required: true, message: '必填属性不能为空' }] : undefined}
      ><OzonPresetAttributeValueEditor attribute={attribute} dictionarySnapshot={dictionarySnapshot} /></Form.Item>)}</div>}
    {optional.length > 0 && <Flex className="ozon-optional-fields-toggle" justify="space-between" align="center" gap={12} wrap="wrap"><Text type="secondary">OZON 选填字段 {optional.length} 项，默认收起</Text><Button onClick={() => setShowOptional((current) => !current)}>{showOptional ? '收起选填字段' : '显示所有'}</Button></Flex>}
  </div>;
}

export type OzonListingReadinessCheck = { label: string; ok: boolean; detail: string };

export function evaluateOzonListingReadiness(
  listing: OzonListingDraft,
  values: any,
  category?: OzonCategoryTemplate,
  readiness?: OzonReadiness
): OzonListingReadinessCheck[] {
  const offers = Array.isArray(values?.offers) ? values.offers : [];
  const productReady = Boolean(values?.titleRu?.trim() && values?.descriptionRu?.trim()
    && values?.dimensions?.length > 0 && values?.dimensions?.width > 0 && values?.dimensions?.height > 0 && values?.dimensions?.weight > 0);
  const categoryReady = Boolean(category?.publishedVersion);
  const required = category?.publishedVersion?.snapshot.attributes.filter((attribute) => attribute.required && !OZON_VIDEO_SYSTEM_ATTRIBUTE_IDS.has(attribute.id)) || [];
  const attributesReady = categoryReady && required.every((attribute) => {
    if (attribute.id === 8229 && attribute.complexId === 0) return Number(category?.typeId || 0) > 0;
    if ([9048, 4180].includes(attribute.id)) return Boolean(values?.titleRu?.trim());
    if (attribute.id === 4191) return Boolean(values?.descriptionRu?.trim());
    const key = ozonAttributeKey(attribute);
    if (attribute.complexId === 0 && attribute.id !== 10097) return Boolean(values?.sharedAttributeValues?.[key]);
    return offers.length > 0 && offers.every((offer: any) => Boolean(offer?.offerAttributeValues?.[key]));
  });
  const offersReady = offers.length > 0 && offers.every((offer: any) => Number(offer?.price) > 0 && Number(offer?.stock) >= 0 && offer?.offerId);
  const validAssetIds = new Set((listing.data.mediaAssets || []).filter((asset) => asset.validationStatus === 'VALID').map((asset) => asset.assetId));
  const mediaReady = offers.length > 0 && offers.every((offer: any) => {
    const media = Array.isArray(offer?.media) ? offer.media : [];
    const images = media.filter((reference: any) => (reference.kind || 'image') === 'image');
    const videos = media.filter((reference: any) => reference.kind === 'video');
    return images.length >= 1 && images.length <= 15 && videos.length === 1 && media.every((reference: any) => validAssetIds.has(reference.assetId));
  });
  const systemReady = Boolean(readiness?.ready);
  return [
    { label: '产品资料', ok: productReady, detail: productReady ? '标题、详情和包装完整' : '仍有必填商品资料未填写' },
    { label: '类目字段', ok: attributesReady, detail: !categoryReady ? '类目模板未发布' : attributesReady ? '必填字段已补齐' : '共享或变体必填字段不完整' },
    { label: '变体与价格', ok: offersReady, detail: offersReady ? `${offers.length} 个 offer 已配置` : '至少配置一个有效 offer' },
    { label: '媒体', ok: mediaReady, detail: mediaReady ? '每个 Offer 都有图片与 1 个双用途 MP4' : '媒体尚未同步：每个 Offer 至少需要 1 张图片和 1 个产品视频/封面' },
    { label: '运行环境', ok: systemReady, detail: systemReady ? 'OZON 目录、n8n 和凭据已就绪' : readiness?.issues?.[0] || '正在读取运行状态' }
  ];
}

function CategoryTemplatesPanel() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailKey, setDetailKey] = useState<string>();
  const [categoryQuery, setCategoryQuery] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<OzonCatalogEntry>();
  const [attributeOrder, setAttributeOrder] = useState<OzonCategoryAttribute[]>([]);
  const [defaultVideoUploadMode, setDefaultVideoUploadMode] = useState<'ORIGINAL' | 'COMPRESSED_COPY'>('COMPRESSED_COPY');
  const [sizeMode, setSizeMode] = useState<'sized' | 'sizeless'>('sizeless');
  const [categorySizeAttributeKey, setCategorySizeAttributeKey] = useState<string>();
  const [orderDirty, setOrderDirty] = useState(false);
  const debouncedQuery = useDebouncedValue(categoryQuery.trim(), 250);
  const categories = useQuery({ queryKey: ['ozon-categories'], queryFn: api.ozonCategories });
  const catalogStatus = useQuery({
    queryKey: ['ozon-catalog-status'],
    queryFn: api.ozonCatalogStatus,
    retry: false,
    refetchInterval: (query) => query.state.data?.catalog.status === 'SYNCING' ? 2_000 : false
  });
  const catalogSearch = useQuery({
    queryKey: ['ozon-catalog-categories', debouncedQuery],
    queryFn: () => api.ozonCatalogCategories(debouncedQuery, 30),
    enabled: createOpen && /\p{Script=Han}/u.test(debouncedQuery),
    retry: false,
    staleTime: 60_000
  });
  const selected = categories.data?.items.find((item) => item.categoryKey === detailKey);
  const catalog = catalogStatus.data?.catalog;
  const dictionaryCounts = catalog?.dictionaryCounts || { countries: 0, seasons: 0, kinds: 0, colors: 0 };
  const readyDictionaryCount = Object.values(dictionaryCounts).filter((count) => count > 0).length;
  const sizeAttributeCandidates = ozonCategorySizeAttributeCandidates(attributeOrder);
  const selectedCategorySizeAttribute = sizeAttributeCandidates.find((attribute) => ozonAttributeKey(attribute) === categorySizeAttributeKey);
  const preferredSizeAttribute = sizeAttributeCandidates.find((attribute) => attribute.id === 4298) || sizeAttributeCandidates[0];
  const sizingIsValid = sizeMode === 'sizeless' || Boolean(selectedCategorySizeAttribute);
  useEffect(() => {
    const snapshot = selected?.draftVersion?.snapshot || selected?.publishedVersion?.snapshot;
    setAttributeOrder(snapshot ? [...snapshot.attributes] : []);
    setDefaultVideoUploadMode(snapshot?.media?.defaultVideoUploadMode || 'COMPRESSED_COPY');
    setSizeMode(snapshot?.sizing?.sizeMode || 'sizeless');
    setCategorySizeAttributeKey(snapshot?.sizing?.sizeMode === 'sized' ? snapshot.sizing.sizeAttributeKey || undefined : undefined);
    setOrderDirty(false);
  }, [selected?.categoryKey, selected?.rowVersion]);
  useEffect(() => {
    if (!catalog?.lastSuccessfulAt) return;
    void queryClient.invalidateQueries({ queryKey: ['ozon-catalog-categories'] });
  }, [catalog?.lastSuccessfulAt, queryClient]);
  const syncCatalog = useMutation({
    mutationFn: api.syncOzonCatalog,
    onSuccess: async (result) => {
      message[result.accepted ? 'success' : 'info'](result.accepted ? 'OZON 中俄类目同步已启动' : `同步任务 ${result.runId} 已在运行`);
      await queryClient.invalidateQueries({ queryKey: ['ozon-catalog-status'] });
    },
    onError: showError
  });
  const create = useMutation({
    mutationFn: (catalogEntryId: string) => api.createOzonCategory(catalogEntryId),
    onSuccess: async ({ category }) => {
      message.success(`已从本地中文目录创建 ${category.nameZh} 类目草稿`);
      closeCreate();
      setDetailKey(category.categoryKey);
      await queryClient.invalidateQueries({ queryKey: ['ozon-categories'] });
    },
    onError: showError
  });
  const refresh = useMutation({
    mutationFn: api.refreshOzonCategory,
    onSuccess: async ({ category }) => {
      message.success(`${category.nameZh || category.nameRu} 已刷新为新草稿版本`);
      await queryClient.invalidateQueries({ queryKey: ['ozon-categories'] });
    },
    onError: showError
  });
  const saveOrder = useMutation({
    mutationFn: (input: { categoryKey: string; rowVersion: number; attributeKeys: string[]; defaultVideoUploadMode: 'ORIGINAL' | 'COMPRESSED_COPY'; sizing: { sizeMode: 'sized' | 'sizeless'; sizeAttributeKey?: string } }) => api.saveOzonCategoryAttributeOrder(input.categoryKey, {
      rowVersion: input.rowVersion,
      attributeKeys: input.attributeKeys,
      defaultVideoUploadMode: input.defaultVideoUploadMode,
      sizing: input.sizing
    }),
    onSuccess: async ({ category }) => {
      setOrderDirty(false);
      message.success(`${category.nameZh || category.nameRu} 的类目设置已保存到草稿`);
      await queryClient.invalidateQueries({ queryKey: ['ozon-categories'] });
    },
    onError: showError
  });
  const publish = useMutation({ mutationFn: (item: OzonCategoryTemplate) => api.publishOzonCategory(item.categoryKey, 'MerchRoute'), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['ozon-categories'] }); message.success('类目模板版本已发布'); }, onError: showError });
  const remove = useMutation({ mutationFn: api.deleteOzonCategory, onSuccess: () => { setDetailKey(undefined); void queryClient.invalidateQueries({ queryKey: ['ozon-categories'] }); message.success('类目模板已删除'); }, onError: showError });
  const closeCreate = () => { setCreateOpen(false); setCategoryQuery(''); setSelectedEntry(undefined); };
  const candidates = selectedEntry ? [selectedEntry, ...(catalogSearch.data?.items || [])] : (catalogSearch.data?.items || []);
  const seen = new Set<string>();
  const options = candidates.filter((item) => !seen.has(item.catalogEntryId) && seen.add(item.catalogEntryId)).map((item) => ({
    value: item.catalogEntryId,
    label: `${item.displayPathZh} · ${item.descriptionCategoryId}/${item.typeId}`,
    entry: item
  }));
  const statusMeta: Record<OzonCatalogStatus['status'], { label: string; color: string }> = {
    EMPTY: { label: '未初始化', color: 'default' },
    SYNCING: { label: '同步中', color: 'processing' },
    READY: { label: '可用', color: 'success' },
    STALE: { label: '已过期', color: 'warning' },
    FAILED: { label: '同步失败', color: 'error' }
  };
  const currentMeta = statusMeta[catalog?.status || 'EMPTY'];
  const searchFeedback = (() => {
    if (!/\p{Script=Han}/u.test(categoryQuery)) return <span>请输入包含中文字符的类目名称</span>;
    if (categoryQuery.trim() !== debouncedQuery || catalogSearch.isFetching) return <span>正在搜索本地中文目录…</span>;
    if (catalogSearch.isError) {
      const description = catalogSearch.error instanceof ApiError ? catalogSearch.error.userMessage : catalogSearch.error.message;
      return <div className="ozon-catalog-search-state is-error"><strong>本地类目搜索不可用</strong><span>{description}</span></div>;
    }
    if (!catalogSearch.data?.items.length) return <div className="ozon-catalog-search-state"><strong>没有匹配的中文类目</strong><span>请换一个中文类目词，或先同步 OZON 类目目录。</span></div>;
    return null;
  })();
  const detailSnapshot = selected?.draftVersion?.snapshot || selected?.publishedVersion?.snapshot;
  const moveAttributeToTop = (key: string) => {
    setAttributeOrder((current) => {
      const index = current.findIndex((attribute) => ozonAttributeKey(attribute) === key);
      if (index <= 0) return current;
      const next = [...current];
      const [attribute] = next.splice(index, 1);
      if (!attribute) return current;
      next.unshift(attribute);
      setOrderDirty(true);
      return next;
    });
  };
  const moveRequiredAttributesToTop = () => {
    setAttributeOrder((current) => {
      if (requiredOzonAttributesAreFirst(current)) return current;
      setOrderDirty(true);
      return prioritizeRequiredOzonAttributes(current);
    });
  };
  const persistAttributeOrder = () => {
    if (!selected) return;
    if (!sizingIsValid) {
      message.error(sizeAttributeCandidates.length ? '请选择有效的 OZON 尺码属性' : '当前类目没有可用的 OZON 尺码属性，请改为无尺码或先刷新类目');
      return;
    }
    saveOrder.mutate({
      categoryKey: selected.categoryKey,
      rowVersion: selected.rowVersion,
      defaultVideoUploadMode,
      sizing: sizeMode === 'sized'
        ? { sizeMode, sizeAttributeKey: categorySizeAttributeKey }
        : { sizeMode },
      attributeKeys: attributeOrder.map(ozonAttributeKey)
    });
  };
  return <div className="ozon-panel">
    <Card className={`ozon-catalog-status is-${(catalog?.status || 'EMPTY').toLowerCase()}`} aria-live="polite">
      <div className="ozon-catalog-status-main">
        <span className="ozon-catalog-status-icon"><DatabaseOutlined /></span>
        <div><Space size={8} wrap><strong>OZON 中俄双语类目目录</strong><Tag color={currentMeta.color}>{currentMeta.label}</Tag></Space>
          <Text type="secondary">{catalog?.status === 'SYNCING'
            ? `正在同步，已处理 ${catalog.currentRun?.processedEntries || 0}/${catalog.currentRun?.totalEntries || 0} 个叶子类目`
            : catalog?.status === 'FAILED'
              ? `本次同步失败，${catalog.entryCount ? '搜索继续使用上一版成功目录。' : '请完成 OZON 凭据后重试。'}`
              : catalog?.status === 'STALE'
                ? '目录超过 8 天未成功更新；搜索继续使用上一版数据。'
                : catalog?.status === 'READY'
                  ? '中文搜索仅查询本地 PostgreSQL，输入时不会请求 OZON。'
                  : '本地目录为空；完成默认店铺凭据后点击立即同步。'}</Text>
          {catalog?.lastError && <Text className="ozon-catalog-error" type="danger">{catalog.lastError}</Text>}
        </div>
      </div>
      <div className="ozon-catalog-metrics">
        <div><span>可选类目</span><strong>{catalog?.entryCount ?? 0}</strong><small>本地中文叶子类目</small></div>
        <div><span>中文缺失</span><strong>{catalog?.chineseMissingCount ?? 0}</strong><small>不会进入搜索结果</small></div>
        <div><span>字段字典</span><strong>{readyDictionaryCount}/4</strong><small>原产国 {dictionaryCounts.countries} · 季节 {dictionaryCounts.seasons} · 性别 {dictionaryCounts.kinds} · 颜色 {dictionaryCounts.colors}</small></div>
        <div><span>最近成功</span><strong>{formatOzonCatalogTime(catalog?.lastSuccessfulAt)}</strong><small>失败时保留上一版</small></div>
        <div><span><ClockCircleOutlined /> 下次同步</span><strong>{formatOzonCatalogTime(catalog?.nextScheduledAt)}</strong><small>每周一 10:00 · Asia/Shanghai</small></div>
      </div>
      <Button className="ozon-catalog-sync-button" type="primary" icon={<SyncOutlined spin={catalog?.status === 'SYNCING'} />} loading={syncCatalog.isPending} onClick={() => syncCatalog.mutate()}>立即同步</Button>
    </Card>
    <Card className="ozon-console" title={<PanelTitle icon={<DatabaseOutlined />} title="类目模板" description="平台字段来自 OZON 本地目录和只读属性接口，模板按版本发布。" />} extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>手动新建</Button>}>
      <Table rowKey="categoryKey" loading={categories.isLoading} dataSource={categories.data?.items || []} pagination={false} scroll={{ x: 900 }} columns={[
        { title: '模板', render: (_, item) => <div><Space size={6}><strong>{item.nameZh || item.nameRu}</strong>{item.catalogActive === false && <Tag color="warning">目录已停用</Tag>}</Space><Text type="secondary">{item.categoryKey} · {item.nameRu}</Text></div> },
        { title: 'OZON 类目 / 类型', width: 180, render: (_, item) => <code>{item.descriptionCategoryId} / {item.typeId}</code> },
        { title: '草稿', width: 100, render: (_, item) => item.draftVersion ? `v${item.draftVersion.versionNo}` : '—' },
        { title: '已发布', width: 110, render: (_, item) => item.publishedVersion ? <Tag color="green">v{item.publishedVersion.versionNo}</Tag> : <Tag>未发布</Tag> },
        { title: '必填属性', width: 100, render: (_, item) => (item.draftVersion || item.publishedVersion)?.snapshot.attributes.filter((attribute) => attribute.required).length || 0 },
        { title: '操作', width: 300, render: (_, item) => <Space size={4}><Button size="small" icon={<EditOutlined />} onClick={() => setDetailKey(item.categoryKey)}>编辑</Button><Button size="small" icon={<SyncOutlined />} loading={refresh.isPending && refresh.variables === item.categoryKey} disabled={item.catalogActive === false} onClick={() => refresh.mutate(item.categoryKey)}>刷新</Button><Button size="small" disabled={!item.draftVersion} loading={publish.isPending} onClick={() => publish.mutate(item)}>发布</Button><Popconfirm title="确认删除未被引用的模板？" onConfirm={() => remove.mutate(item.categoryKey)}><Button aria-label={`删除 ${item.nameZh || item.nameRu}`} size="small" danger type="text" icon={<DeleteOutlined />} /></Popconfirm></Space> }
      ]} />
    </Card>
    <Modal title="手动新建 OZON 类目模板" open={createOpen} okText="创建草稿" cancelText="取消" okButtonProps={{ disabled: !selectedEntry }} confirmLoading={create.isPending} onCancel={closeCreate} onOk={() => selectedEntry && create.mutate(selectedEntry.catalogEntryId)}>
      <Alert type="info" showIcon message="只需输入并选择中文类目" description="类目 Key、俄文名称、平台 ID 和属性快照由系统从本地目录与 OZON 只读接口自动生成。" />
      <div className="ozon-category-create-search">
        <label htmlFor="ozon-category-search">搜索 OZON 中文类目</label>
        <Select
          id="ozon-category-search"
          aria-label="搜索 OZON 中文类目"
          showSearch
          virtual={false}
          allowClear
          filterOption={false}
          value={selectedEntry?.catalogEntryId}
          searchValue={categoryQuery}
          onSearch={setCategoryQuery}
          onClear={() => { setSelectedEntry(undefined); setCategoryQuery(''); }}
          loading={catalogSearch.isFetching || categoryQuery.trim() !== debouncedQuery}
          options={options}
          placeholder="例如：背包、连衣裙、运动鞋"
          notFoundContent={searchFeedback}
          onSelect={(value) => {
            const option = options.find((item) => item.value === value);
            if (option) { setSelectedEntry(option.entry); setCategoryQuery(option.entry.displayPathZh); }
          }}
        />
        {selectedEntry && <Descriptions size="small" column={1} bordered items={[
          { key: 'path', label: '中文路径', children: selectedEntry.displayPathZh },
          { key: 'ids', label: '平台标识', children: <code>{selectedEntry.descriptionCategoryId} / {selectedEntry.typeId}</code> }
        ]} />}
      </div>
    </Modal>
    <Drawer className="ozon-drawer ozon-category-drawer" width="min(1180px, 98vw)" open={Boolean(detailKey)} onClose={() => setDetailKey(undefined)} title={selected ? <Space wrap><TagsOutlined /><strong>{selected.nameZh || selected.nameRu} / {selected.nameRu}</strong><span className="mono-small">{selected.categoryKey}</span></Space> : 'OZON 类目模板'} extra={<Space wrap><Button icon={<SaveOutlined />} loading={saveOrder.isPending} disabled={!orderDirty || !attributeOrder.length || !sizingIsValid} onClick={persistAttributeOrder}>保存草稿</Button><Button icon={<CheckCircleOutlined />} disabled={!selected?.draftVersion || orderDirty || !sizingIsValid} loading={publish.isPending} onClick={() => selected && publish.mutate(selected)}>发布</Button></Space>}>
      {selected && detailSnapshot ? <div className="ozon-category-detail">
        {selected.catalogIssue && <Alert type="warning" showIcon message="本地目录状态需要复核" description={selected.catalogIssue} />}
        {attributeOrder.some((attribute) => !ozonAttributeNameZh(attribute)) && <Alert type="warning" showIcon message="部分属性尚无中文名称" description="点击“刷新”重新读取 OZON 中俄属性；缺失中文时仍保留俄文原名和平台 ID，不进行机器翻译。" />}
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
          { key: 'zh', label: '中文名称', children: selected.nameZh || '—' },
          { key: 'ru', label: '俄文名称', children: selected.nameRu },
          { key: 'key', label: '稳定 Key', children: <code>{selected.categoryKey}</code> },
          { key: 'ids', label: '平台类目 / 类型', children: <code>{selected.descriptionCategoryId} / {selected.typeId}</code> },
          { key: 'draft', label: '草稿版本', children: selected.draftVersion ? `v${selected.draftVersion.versionNo}` : '—' },
          { key: 'published', label: '已发布版本', children: selected.publishedVersion ? `v${selected.publishedVersion.versionNo}` : '—' }
        ]} />
        <Card size="small" title="媒体、尺码与合规规则">
          <Row gutter={14}>
            <Col xs={24} md={12}>
              <Form.Item label="默认视频上传方式" extra="只影响之后新建的 OZON 共享草稿；已创建 publication 继续使用各店冻结快照。">
                <Select
                  aria-label="默认视频上传方式"
                  value={defaultVideoUploadMode}
                  options={[
                    { value: 'COMPRESSED_COPY', label: '使用压缩副本' },
                    { value: 'ORIGINAL', label: '使用原视频' }
                  ]}
                  onChange={(value) => { setDefaultVideoUploadMode(value); setOrderDirty(true); }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="尺码模式" required>
                <Select
                  aria-label="尺码模式"
                  value={sizeMode}
                  options={[
                    { value: 'sized', label: '有尺码（按尺码生成 Offer）' },
                    { value: 'sizeless', label: '无尺码（单库存行）' }
                  ]}
                  onChange={(value) => {
                    setSizeMode(value);
                    setCategorySizeAttributeKey(value === 'sized' ? preferredSizeAttribute && ozonAttributeKey(preferredSizeAttribute) : undefined);
                    setOrderDirty(true);
                  }}
                />
              </Form.Item>
            </Col>
          </Row>
          {sizeMode === 'sized' && <Form.Item
            label="OZON 尺码属性"
            required
            validateStatus={selectedCategorySizeAttribute ? undefined : 'error'}
            help={!sizeAttributeCandidates.length
              ? '当前类目没有识别到顶层尺码属性；PDF、视频和其他复合属性不能作为尺码。'
              : selectedCategorySizeAttribute ? undefined : '请选择一个有效的 OZON 尺码属性。'}
            extra="仅显示语义属于尺码且 complexId=0 的顶层属性；运动鞋优先使用俄罗斯尺码 #4298。"
          >
            <Select
              aria-label="OZON 尺码属性"
              showSearch
              optionFilterProp="label"
              value={categorySizeAttributeKey}
              placeholder={sizeAttributeCandidates.length ? '选择 OZON 尺码属性' : '没有可用尺码属性'}
              disabled={!sizeAttributeCandidates.length}
              options={sizeAttributeCandidates.map((attribute) => ({
                value: ozonAttributeKey(attribute),
                label: `${bilingualOzonAttributeLabel(attribute)}${attribute.required ? ' · 必填' : ' · 选填'}${attribute.dictionaryId ? ` · 字典 #${attribute.dictionaryId}` : ''}`
              }))}
              onChange={(value) => { setCategorySizeAttributeKey(value); setOrderDirty(true); }}
            />
          </Form.Item>}
          {sizeMode === 'sizeless' && <Alert showIcon type="info" message="当前类目按无尺码商品上品" description="上品预设只保留一行默认库存，不生成额外尺码 Offer。" />}
        </Card>
        <Card size="small" title={`属性顺序 · ${attributeOrder.length} 项`} extra={<Space wrap><Button size="small" icon={<ArrowUpOutlined />} disabled={!attributeOrder.some((attribute) => attribute.required) || requiredOzonAttributesAreFirst(attributeOrder)} onClick={moveRequiredAttributesToTop}>必填置顶</Button>{orderDirty ? <Tag color="gold">设置未保存</Tag> : <Tag color="green">草稿已保存</Tag>}</Space>}>
          <Alert className="ozon-attribute-order-note" type="info" showIcon message="新建和刷新时自动将必填属性置顶" description="需要重新整理时，点击“必填置顶”；也可以点击任一属性左侧的“置顶”调整顺序。同组内保留当前顺序，平台 ID、类型、必填和字典配置只读不可篡改。" />
          {!attributeOrder.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前模板没有可排序的 OZON 属性" /> : <div className="ozon-attribute-order-list">{attributeOrder.map((attribute, index) => {
            const nameZh = ozonAttributeNameZh(attribute);
            const nameRu = ozonAttributeNameRu(attribute);
            return <div className="ozon-attribute-order-row" key={ozonAttributeKey(attribute)}>
              <div className="ozon-attribute-order-index"><span>{String(index + 1).padStart(2, '0')}</span><Button className="ozon-attribute-pin" aria-label={`置顶 ${nameZh || nameRu || attribute.id}`} size="small" type="text" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => moveAttributeToTop(ozonAttributeKey(attribute))}>置顶</Button></div>
              <div className="ozon-attribute-order-main">
                <div className="ozon-attribute-bilingual-name"><strong>{nameZh || '中文名称待刷新'}</strong><Text type="secondary">{nameRu || '俄文名称缺失'}</Text></div>
                <Space size={[5, 5]} wrap><Tag color={attribute.required ? 'red' : 'default'}>{attribute.required ? '必填' : '选填'}</Tag><Tag>{attribute.type}</Tag>{attribute.dictionaryId ? <Tag color="blue">字典 #{attribute.dictionaryId}</Tag> : null}{attribute.isCollection ? <Tag color="purple">集合 · {attribute.maxCount}</Tag> : <Tag>单值 · {attribute.maxCount}</Tag>}{attribute.complexId ? <Tag color="geekblue">complex {attribute.complexId}</Tag> : null}</Space>
                {(attribute.groupName || attribute.groupId) && <Text className="ozon-attribute-group" type="secondary">属性组：{attribute.groupName || `#${attribute.groupId}`}</Text>}
              </div>
              <div className="ozon-attribute-platform-id"><span>OZON ID</span><code>{attribute.id}</code></div>
            </div>;
          })}</div>}
        </Card>
      </div> : <Empty description="类目模板不存在或尚未加载" />}
    </Drawer>
  </div>;
}

function OzonPresetChainNode({ label, value, version, accent }: { label: string; value: string; version?: number; accent?: boolean }) {
  return <span className={accent ? 'is-accent' : ''}>
    <small>{label}</small>
    <strong title={value}>{value}</strong>
    {version !== undefined && <em>V{version}</em>}
  </span>;
}

function OzonPresetChain({ preset, pricingName, pricingVersion, shippingName, shippingVersion }: {
  preset: OzonPreset;
  pricingName: string;
  pricingVersion?: number;
  shippingName: string;
  shippingVersion?: number;
}) {
  return <div className="ozon-preset-chain" aria-label="OZON 预设定价链">
    <OzonPresetChainNode label="定价" value={pricingName} version={pricingVersion} />
    <i>→</i>
    <OzonPresetChainNode label="运费" value={shippingName} version={shippingVersion} />
    <i>→</i>
    <OzonPresetChainNode label="渠道" value={preset.shippingServiceCode || '待设置'} />
    <i>→</i>
    <OzonPresetChainNode accent label="结果" value="上架价 CNY" />
  </div>;
}

function PresetTemplatesPanel() {
  const [editId, setEditId] = useState<string | 'new'>();
  const [form] = Form.useForm();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const presets = useQuery({ queryKey: ['ozon-presets'], queryFn: api.ozonPresets, retry: false });
  const categories = useQuery({ queryKey: ['ozon-categories'], queryFn: api.ozonCategories });
  const pricing = useQuery({ queryKey: ['pricing-templates'], queryFn: api.pricingTemplates });
  const shipping = useQuery({ queryKey: ['shipping-templates'], queryFn: api.shippingTemplates });
  const selected = presets.data?.items.find((item) => item.id === editId);
  const shippingTemplateId = Form.useWatch('shippingTemplateId', form) as string | undefined;
  const shippingServiceCode = Form.useWatch('shippingServiceCode', form) as string | undefined;
  const categoryKey = Form.useWatch('categoryKey', form) as string | undefined;
  const watchedSharedAttributeValues = Form.useWatch('sharedAttributeValues', form) as Record<string, unknown> | undefined;
  const watchedVariantAttributeValues = Form.useWatch('variantAttributeValues', form) as Record<string, unknown> | undefined;
  const watchedPresetSizes = Form.useWatch('sizes', form) as Array<{ sizeId?: string; value?: string; stock?: number }> | undefined;
  const shippingDetail = useQuery({ queryKey: ['shipping-template', shippingTemplateId], queryFn: () => api.shippingTemplate(shippingTemplateId!), enabled: Boolean(editId && shippingTemplateId), retry: false });
  const publishedShippingVersion = useMemo(() => shippingDetail.data?.template.versions.find((version) => version.status === 'PUBLISHED'), [shippingDetail.data]);
  const shippingServices = publishedShippingVersion?.definition.services || [];
  const selectedService = shippingServices.find((service) => service.code === shippingServiceCode);
  const destinationCodes = useMemo(() => [...new Set(selectedService?.rules.flatMap((rule) => rule.destinationCountryCodes || []) || [])], [selectedService]);
  const selectedCategory = categories.data?.items.find((item) => item.categoryKey === categoryKey);
  const categoryAttributes = selectedCategory?.publishedVersion?.snapshot.attributes || [];
  const categorySizing = selectedCategory?.publishedVersion?.snapshot.sizing || { sizeMode: 'sizeless' as const };
  const inheritedSizeAttributeKey = categorySizing.sizeMode === 'sized' ? categorySizing.sizeAttributeKey || undefined : undefined;
  const selectedSizeAttribute = ozonCategorySizeAttributeCandidates(categoryAttributes)
    .find((attribute) => ozonAttributeKey(attribute) === inheritedSizeAttributeKey);
  const sharedCategoryAttributes = categoryAttributes.filter((attribute) => attribute.complexId === 0
    && ozonAttributeKey(attribute) !== inheritedSizeAttributeKey
    && !OZON_AUTOMATED_ATTRIBUTE_IDS.has(attribute.id));
  const variantCategoryAttributes = categoryAttributes.filter((attribute) => attribute.complexId > 0 && !OZON_AUTOMATED_ATTRIBUTE_IDS.has(attribute.id));
  const presetRequiredCoverage = selectedCategory?.publishedVersion
    ? projectOzonPresetRequiredAttributeCoverage(
      { attributes: categoryAttributes, sizing: categorySizing },
      {
        sharedAttributes: presetAttributeInputs(sharedCategoryAttributes, watchedSharedAttributeValues, selectedCategory),
        variantAttributes: presetAttributeInputs(variantCategoryAttributes, watchedVariantAttributeValues),
        sizeAttributeKey: inheritedSizeAttributeKey,
        sizes: (watchedPresetSizes || []).map((size) => ({
          sizeId: size.sizeId,
          value: String(size.value || '').trim(),
          stock: Number(size.stock || 0)
        }))
      }
    )
    : [];
  const presetRequiredCoverageByKey = new Map(presetRequiredCoverage.map((attribute) => [attribute.attributeKey, attribute]));
  const configuredSizeCount = selectedSizeAttribute
    ? (watchedPresetSizes || []).filter((size) => Boolean(String(size.value || '').trim())).length
    : categoryKey ? 1 : 0;
  const presetVideoCompatibility = ozonVideoCompatibility(categoryAttributes);
  useEffect(() => {
    if (!editId) return;
    const defaults = {
      name: '', description: '', shippingServiceCode: '', vat: '0.2', defaultStock: 0, mediaPolicy: 'REPLACE_ALL',
      dimensions: { dimensionUnit: 'cm', weightUnit: 'g' }, variantAttributes: [], sharedAttributes: [],
      titleTranslation: { workflowId: OZON_TITLE_TRANSLATION_WORKFLOW_ID, language: '俄文', maxLength: OZON_TITLE_MAX_LENGTH },
      descriptionSource: 'E003', sizeAttributeKey: undefined,
      sizes: [{ sizeId: crypto.randomUUID(), value: '', stock: 0 }]
    };
    const source = selected || defaults;
    form.setFieldsValue({
      ...defaults,
      ...source,
      dimensions: normalizeOzonPresetDimensionsToGrams(source.dimensions),
      sharedAttributeValues: presetAttributeValues(source.sharedAttributes || []),
      variantAttributeValues: presetAttributeValues(source.variantAttributes || []),
      sizes: (source.sizes?.length ? source.sizes : defaults.sizes).map((size) => ({ ...size, sizeId: size.sizeId || crypto.randomUUID() }))
    });
  }, [editId, form, selected]);
  useEffect(() => {
    if (!editId || !selectedCategory?.publishedVersion) return;
    const currentSizeAttributeKey = form.getFieldValue('sizeAttributeKey') as string | undefined;
    form.setFieldValue('sizeAttributeKey', inheritedSizeAttributeKey);
    if (currentSizeAttributeKey === inheritedSizeAttributeKey) return;
    const currentStock = Number(form.getFieldValue(['sizes', 0, 'stock']) || 0);
    form.setFieldValue('sizes', [{ sizeId: crypto.randomUUID(), value: '', stock: currentStock }]);
  }, [editId, form, inheritedSizeAttributeKey, selectedCategory?.publishedVersion?.id]);
  const save = useMutation({
    mutationFn: (values: any) => {
      const category = categories.data?.items.find((item) => item.categoryKey === values.categoryKey);
      if (!category?.publishedVersion) throw new Error('请选择已发布的 OZON 类目模板');
      const publishedSizing = category.publishedVersion.snapshot.sizing || { sizeMode: 'sizeless' as const };
      const publishedSizeAttributeKey = publishedSizing.sizeMode === 'sized' ? publishedSizing.sizeAttributeKey || undefined : undefined;
      const publishedSizeAttribute = ozonCategorySizeAttributeCandidates(category.publishedVersion.snapshot.attributes)
        .find((attribute) => ozonAttributeKey(attribute) === publishedSizeAttributeKey);
      if (publishedSizing.sizeMode === 'sized' && !publishedSizeAttribute) {
        throw new Error('当前类目的已发布尺码规则已失效，请先刷新并重新发布类目模板');
      }
      const sharedAttributes = category.publishedVersion.snapshot.attributes.filter((attribute) => attribute.complexId === 0
        && ozonAttributeKey(attribute) !== publishedSizeAttributeKey
        && !OZON_AUTOMATED_ATTRIBUTE_IDS.has(attribute.id));
      const variantAttributes = category.publishedVersion.snapshot.attributes.filter((attribute) => attribute.complexId > 0
        && !OZON_AUTOMATED_ATTRIBUTE_IDS.has(attribute.id));
      const input: OzonPresetInput = {
        name: values.name,
        description: values.description || '',
        categoryKey: values.categoryKey,
        pricingTemplateId: values.pricingTemplateId,
        shippingTemplateId: values.shippingTemplateId,
        shippingServiceCode: values.shippingServiceCode,
        destinationCountryCode: values.destinationCountryCode,
        vat: values.vat,
        defaultStock: Number(values.sizes?.[0]?.stock || 0),
        dimensions: normalizeOzonPresetDimensionsToGrams(values.dimensions),
        sharedAttributes: presetAttributeInputs(sharedAttributes, values.sharedAttributeValues, category),
        variantAttributes: presetAttributeInputs(
          variantAttributes,
          values.variantAttributeValues
        ),
        titleTranslation: values.titleTranslation,
        descriptionSource: 'E003',
        sizeAttributeKey: publishedSizeAttributeKey,
        sizes: normalizeOzonPresetSizes(values.sizes, Boolean(publishedSizeAttributeKey)),
        mediaPolicy: values.mediaPolicy
      };
      const uncoveredRequiredAttributes = projectOzonPresetRequiredAttributeCoverage(
        { attributes: category.publishedVersion.snapshot.attributes, sizing: publishedSizing },
        input
      ).filter((attribute) => !attribute.covered);
      if (uncoveredRequiredAttributes.length) {
        throw new Error(uncoveredRequiredAttributes.map((attribute) => attribute.reason
          || `必填目录属性 ${attribute.nameZh || attribute.nameRu || attribute.name} / ${attribute.nameRu || attribute.name} · #${attribute.attributeId} 尚未配置`).join('；'));
      }
      return editId === 'new' ? api.createOzonPreset(input) : api.updateOzonPreset(editId!, { ...input, rowVersion: selected!.rowVersion });
    },
    onSuccess: () => { setEditId(undefined); void Promise.all([queryClient.invalidateQueries({ queryKey: ['ozon-presets'] }), queryClient.invalidateQueries({ queryKey: ['ozon-automation-status'] })]); message.success('OZON 上品预设已保存'); },
    onError: showError
  });
  const clone = useMutation({ mutationFn: (item: OzonPreset) => api.cloneOzonPreset(item.id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['ozon-presets'] }); message.success('预设副本已创建'); }, onError: showError });
  const remove = useMutation({ mutationFn: (item: OzonPreset) => api.deleteOzonPreset(item.id, item.rowVersion), onSuccess: () => { void Promise.all([queryClient.invalidateQueries({ queryKey: ['ozon-presets'] }), queryClient.invalidateQueries({ queryKey: ['ozon-automation-status'] })]); message.success('预设已删除'); }, onError: showError });
  const items = presets.data?.items || [];
  const openStoreSettings = () => {
    const next = new URLSearchParams(searchParams);
    next.set('settings', '1');
    setSearchParams(next, { replace: true });
  };
  const changePresetCategory = (nextCategoryKey: string) => {
    const nextCategory = categories.data?.items.find((item) => item.categoryKey === nextCategoryKey);
    const nextSizing = nextCategory?.publishedVersion?.snapshot.sizing || { sizeMode: 'sizeless' as const };
    const nextSizeAttributeKey = nextSizing.sizeMode === 'sized' ? nextSizing.sizeAttributeKey || undefined : undefined;
    form.setFieldsValue({
      sharedAttributeValues: {},
      variantAttributeValues: {},
      sizeAttributeKey: nextSizeAttributeKey,
      sizes: [{ sizeId: crypto.randomUUID(), value: '', stock: 0 }]
    });
  };
  return <div className="ozon-panel">
    <div className="ozon-preset-registry">
      <Card className="ozon-preset-intro">
        <div className="ozon-preset-intro-copy">
          <span>OZON LISTING BLUEPRINT</span>
          <Title level={4}>一套预设，串起价格、物流与商品资料</Title>
          <Text type="secondary">预设定义商品、定价、包装与媒体蓝图；每家店铺再独立选择默认预设和自动上品策略。</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditId('new')}>新建上品预设</Button>
      </Card>
      <Alert
        className="ozon-preset-migration-alert"
        showIcon
        type="info"
        message="预设按店铺绑定"
        description="上品预设只定义商品生成蓝图。每家店铺使用哪个默认预设、是否自动上品、仓库、履约方式和合同币种，统一在“OZON上品设置 → 店铺管理”中配置；任务确认后冻结快照。"
        action={<Button onClick={openStoreSettings}>前往店铺管理</Button>}
      />
      {presets.isError ? <Alert showIcon type="error" message="上品预设模板暂不可用" description={presets.error.message} action={<Button onClick={() => void presets.refetch()}>重试</Button>} /> : <Card className="ozon-preset-table-shell" styles={{ body: { padding: 0 } }}>
        <Table<OzonPreset>
          rowKey="id"
          loading={presets.isLoading}
          dataSource={items}
          pagination={false}
          scroll={{ x: 1230 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 OZON 上品预设模板"><Button type="primary" onClick={() => setEditId('new')}>创建第一个预设</Button></Empty> }}
          columns={[
            { title: '预设', width: 250, render: (_, item) => <div className="ozon-preset-name-cell"><strong>{item.name}</strong><Text type="secondary">{item.description || '未填写说明'}</Text></div> },
            { title: '定价链', width: 355, render: (_, item) => {
              const pricingTemplate = pricing.data?.items.find((candidate) => candidate.id === item.pricingTemplateId);
              const shippingTemplate = shipping.data?.items.find((candidate) => candidate.id === item.shippingTemplateId);
              return <OzonPresetChain preset={item} pricingName={pricingTemplate?.name || item.pricingTemplateId} pricingVersion={pricingTemplate?.publishedVersion?.versionNo} shippingName={shippingTemplate ? `${shippingTemplate.carrierName} · ${shippingTemplate.name}` : item.shippingTemplateId} shippingVersion={shippingTemplate?.publishedVersion?.versionNo} />;
            } },
            { title: '商品默认值', width: 320, render: (_, item) => {
              const category = categories.data?.items.find((candidate) => candidate.categoryKey === item.categoryKey);
              const categoryName = category ? `${category.nameZh}${category.nameRu ? ` / ${category.nameRu}` : ''}` : item.categoryKey;
              return <div className="ozon-preset-summary-tags"><Tooltip title={categoryName}><Tag color="blue">类目 · {categoryName}</Tag></Tooltip><Tag>VAT · {Number(item.vat) * 100}%</Tag><Tag>库存 · {item.defaultStock}</Tag>{category?.publishedVersion && <Tag>类目 V{category.publishedVersion.versionNo}</Tag>}</div>;
            } },
            { title: '店铺策略', width: 155, render: () => <div className="ozon-preset-auto-status"><Tag color="blue">在店铺设置管理</Tag><Text type="secondary">本页不再修改</Text></div> },
            { title: '更新时间', width: 150, render: (_, item) => <div className="ozon-preset-time"><strong>{dayjs(item.updatedAt).format('YYYY-MM-DD')}</strong><span>{dayjs(item.updatedAt).format('HH:mm')} · R{item.rowVersion}</span></div> },
            { title: '操作', width: 190, fixed: 'right', render: (_, item) => <Space size={4}><Button size="small" icon={<EditOutlined />} onClick={() => setEditId(item.id)}>编辑</Button><Button size="small" icon={<CopyOutlined />} loading={clone.isPending && clone.variables?.id === item.id} onClick={() => clone.mutate(item)}>复制</Button><Popconfirm title="确认删除该预设？" description="被店铺绑定的预设不能删除；请先在店铺设置中重新绑定或停用关联店铺。" okText="删除预设" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => remove.mutateAsync(item)}><Button size="small" danger type="text" icon={<DeleteOutlined />} loading={remove.isPending && remove.variables?.id === item.id}>删除</Button></Popconfirm></Space> }
          ]}
        />
      </Card>}
    </div>
    <Drawer className="ozon-drawer ozon-preset-drawer" width="min(1180px, 98vw)" open={Boolean(editId)} onClose={() => setEditId(undefined)} title={<Space><SettingOutlined /><strong>{editId === 'new' ? '新建 OZON 上品预设模板' : selected?.name || '加载 OZON 上品预设'}</strong></Space>} extra={<Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={() => form.submit()}>{editId === 'new' ? '创建预设' : '保存修改'}</Button>}>
      <Form form={form} layout="vertical" className="ozon-preset-editor" scrollToFirstError={{ behavior: 'smooth', block: 'center' }} onFinish={(values) => save.mutate(values)}>
        <Card title="基础信息">
          <Form.Item name="name" label="预设名称" rules={[{ required: true, whitespace: true, message: '请输入预设名称' }]}><Input placeholder="例如：OZON 家居商品蓝图 V1" /></Form.Item>
          <Alert showIcon type="info" message="店铺绑定及发布策略请在 OZON上品设置中管理" description="本预设只保存商品生成规则，不保存默认店铺、自动发布、发布模式、仓库、履约方式或币种。" action={<Button onClick={openStoreSettings}>管理店铺策略</Button>} />
          <Form.Item name="description" label="使用说明"><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={240} showCount placeholder="说明适用类目、商品资料或运营策略" /></Form.Item>
        </Card>
        <Card className="ozon-preset-price-card" title={<Space><BranchesOutlined />定价链与包装预设</Space>}>
          <Alert showIcon type="info" message="上架价由 OZON 价格查询结果生成" description="系统使用最新采购成本和采购管理最新版本的 SKU 毛重计算物流费用；仅当采购毛重为空、0 或非正数时，才使用下方兜底毛重。" />
          <div className="ozon-preset-chain-editor">
            <Form.Item label="默认定价模板" name="pricingTemplateId" rules={[{ required: true, message: '请选择 OZON 定价模板' }]}><Select showSearch optionFilterProp="label" placeholder="选择 OZON 已发布定价模板" options={(pricing.data?.items || []).filter((item) => item.active && item.publishedVersion && item.platformCode.toUpperCase() === 'OZON').map((item) => ({ value: item.id, label: `${item.platformName} · ${item.name} · V${item.publishedVersion!.versionNo}` }))} /></Form.Item><i>→</i>
            <Form.Item label="默认运费模板" name="shippingTemplateId" rules={[{ required: true, message: '请选择 OZON 运费模板' }]}><Select showSearch optionFilterProp="label" placeholder="选择 OZON 已发布运费模板" options={(shipping.data?.items || []).filter((item) => item.active && item.carrierActive && item.publishedVersion && item.platformCode.toUpperCase() === 'OZON').map((item) => ({ value: item.id, label: `${item.carrierName} · ${item.name} · V${item.publishedVersion!.versionNo}` }))} onChange={() => form.setFieldsValue({ shippingServiceCode: '', destinationCountryCode: undefined })} /></Form.Item><i>→</i>
            <Form.Item label="服务渠道" name="shippingServiceCode" rules={[{ required: true, message: '请选择 OZON 服务渠道' }]}><Select loading={shippingDetail.isLoading} disabled={!shippingTemplateId || shippingDetail.isError} placeholder={shippingTemplateId ? '选择当前 OZON 运费模板的渠道' : '先选择 OZON 运费模板'} options={shippingServices.map((service) => ({ value: service.code, label: `${service.name} · ${service.code}` }))} onChange={() => form.setFieldValue('destinationCountryCode', undefined)} /></Form.Item><i>→</i>
            <div className="ozon-preset-output-node"><small>返回字段</small><strong>上架价</strong><span>CNY</span></div>
          </div>
          {shippingDetail.isError && <Alert showIcon type="error" message="无法读取 OZON 运费模板服务渠道" description={shippingDetail.error.message} />}
          {!!destinationCodes.length && <Form.Item label="目的国" name="destinationCountryCode" rules={[{ required: true, message: '当前服务渠道需要选择目的国' }]}><Select showSearch options={destinationCodes.map((code) => ({ value: code, label: code }))} /></Form.Item>}
          <Divider orientation="left">包装参数</Divider>
          <Alert showIcon type="warning" message="采购毛重优先，预设毛重仅兜底" description="长、宽、高始终使用本预设；采购毛重为空、0 或非正数时，定价和包装才使用兜底毛重。" />
          <Row gutter={10}>
            <Col xs={12} md={4}><Form.Item name={['dimensions', 'length']} label="长" rules={[{ required: true, message: '必填' }]}><InputNumber min={0.01} /></Form.Item></Col>
            <Col xs={12} md={4}><Form.Item name={['dimensions', 'width']} label="宽" rules={[{ required: true, message: '必填' }]}><InputNumber min={0.01} /></Form.Item></Col>
            <Col xs={12} md={4}><Form.Item name={['dimensions', 'height']} label="高" rules={[{ required: true, message: '必填' }]}><InputNumber min={0.01} /></Form.Item></Col>
            <Col xs={12} md={4}><Form.Item name={['dimensions', 'dimensionUnit']} label="尺寸单位"><Select options={['mm', 'cm', 'in'].map((value) => ({ value }))} /></Form.Item></Col>
            <Col xs={12} md={4}><Form.Item name={['dimensions', 'weight']} label="兜底毛重 (g)" extra="采购毛重为空、0 或非正数时才使用此值。" rules={[{ required: true, message: '必填' }]}><InputNumber aria-label="兜底毛重 (g)" min={0.01} /></Form.Item></Col>
            <Col xs={12} md={4}><Form.Item label="重量单位"><Input aria-label="重量单位" value="g" readOnly /></Form.Item></Col>
          </Row>
        </Card>
        <Card title="商品资料默认值">
          <Row gutter={14}><Col xs={24} md={12}><Form.Item name="categoryKey" label="OZON 类目模板" rules={[{ required: true, message: '请选择类目模板' }]}><Select showSearch optionFilterProp="label" placeholder="选择已发布的 OZON 类目" options={(categories.data?.items || []).map((item) => ({ value: item.categoryKey, label: `${item.nameZh || item.nameRu}${item.nameRu && item.nameZh ? ` / ${item.nameRu}` : ''} · V${item.publishedVersion?.versionNo || '-'}`, disabled: !item.publishedVersion }))} onChange={changePresetCategory} /></Form.Item></Col></Row>
          <Alert showIcon type="info" message="履约、仓库和合同币种不属于商品预设" description="这些值在每家 OZON 店铺中单独配置和验证，发布计划按店铺冻结。" action={<Button onClick={openStoreSettings}>打开店铺设置</Button>} />
          <Row gutter={14}><Col xs={12} md={8}><Form.Item name="vat" label="VAT"><Select options={['0', '0.05', '0.07', '0.1', '0.2', '0.22'].map((value) => ({ value, label: Number(value) ? `${Number(value) * 100}%` : '0%' }))} /></Form.Item></Col><Col xs={24} md={8}><Form.Item name="mediaPolicy" label="媒体规则"><Select options={[{ value: 'REPLACE_ALL', label: '全量替换' }, { value: 'KEEP_ORDER', label: '保持顺序' }]} /></Form.Item></Col></Row>
          <div className="ozon-video-policy">
            <div><VideoCameraOutlined /><div><strong>产品视频/封面</strong><Text type="secondary">固定使用一个 E004 MP4；上传一次并复用同一公网 URL，不增加可编辑开关。</Text></div></div>
            <OzonVideoPurposeTags compatibility={categoryKey ? presetVideoCompatibility : undefined} />
          </div>
          {categoryKey && selectedCategory?.publishedVersion && <OzonVideoCompatibilityNotice compatibility={presetVideoCompatibility} />}
        </Card>

        <Card title="俄文标题与商品详情">
          <Row gutter={14}><Col xs={24} md={8}><Form.Item name={['titleTranslation', 'workflowId']} label="翻译工作流 ID" rules={[{ required: true, whitespace: true }]}><Input className="mono-input" /></Form.Item></Col><Col xs={24} md={8}><Form.Item name={['titleTranslation', 'language']} label="目标语言" rules={[{ required: true, whitespace: true }, { max: 64 }]}><Input maxLength={64} placeholder="例如：俄文" /></Form.Item></Col><Col xs={24} md={8}><Form.Item name={['titleTranslation', 'maxLength']} label="标题最大长度" rules={[{ required: true }, { type: 'number', min: 1, max: OZON_TITLE_MAX_LENGTH }]}><InputNumber min={1} max={OZON_TITLE_MAX_LENGTH} precision={0} /></Form.Item></Col></Row>
          <Alert showIcon type="info" message="标题原文固定使用 PostgreSQL 中的产品名" description="自动上品时按本预设的工作流、目标语言和长度生成俄文标题；商品详情自动取最新有效 E003 详情 TXT，图片场景结果不影响详情导入。" />
          <Divider orientation="left">俄文商品详情</Divider>
          <div className="ozon-preset-description-source"><CheckCircleOutlined /><div><strong>自动获取最新有效 E003 详情 TXT</strong><Text type="secondary">详情 TXT 的身份、受控路径、UTF-8 编码、内容与写入稳定性通过校验即可导入；图片场景结果不影响详情导入。TXT 自身不可用时才回退到上一份有效结果。</Text></div><Tag color="blue">E003</Tag></div>
        </Card>

        <Card title={<Space><TagsOutlined />OZON 类目字段{categoryAttributes.length ? <Tag>{categoryAttributes.length} 项</Tag> : null}</Space>}>
          {!categoryKey ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择 OZON 类目模板" /> : !selectedCategory?.publishedVersion ? <Alert showIcon type="warning" message="当前类目没有已发布字段" /> : <>
            <Alert showIcon type="info" message="红星为 OZON 必填目录属性" description="用户填写项必须在预设中补齐；带“系统自动生成”的只读项由发布计划写入。标题、详情、颜色和 offer_id 仍由自动链路生成。" />
            <OzonPresetAttributeFields title="所有变体共享" attributes={sharedCategoryAttributes} formField="sharedAttributeValues" dictionarySnapshot={selectedCategory.publishedVersion.snapshot.dictionarySnapshot} categoryType={selectedCategory} coverageByKey={presetRequiredCoverageByKey} />
            <Divider />
            <OzonPresetAttributeFields title="每个变体的默认值" attributes={variantCategoryAttributes} formField="variantAttributeValues" dictionarySnapshot={selectedCategory.publishedVersion.snapshot.dictionarySnapshot} coverageByKey={presetRequiredCoverageByKey} />
          </>}
        </Card>

        <Card title="尺码与默认库存">
          <Form.Item name="sizeAttributeKey" hidden><Input /></Form.Item>
          <Form.Item
            required={Boolean(selectedSizeAttribute?.required)}
            label={selectedSizeAttribute
              ? <OzonPresetAttributeLabel attribute={selectedSizeAttribute} />
              : '类目尺码规则'}
            extra="尺码规则来自所选类目的已发布版本，不能在上品预设中单独更改。"
          >
            <Input
              aria-label="类目尺码规则"
              readOnly
              value={!categoryKey
                ? '请先选择 OZON 类目模板'
                : selectedSizeAttribute
                  ? bilingualOzonAttributeLabel(selectedSizeAttribute)
                  : categorySizing.sizeMode === 'sized'
                    ? '已发布尺码规则失效，请先修复类目模板'
                    : '无尺码（单库存行）'}
            />
          </Form.Item>
          {!categoryKey
            ? <Alert showIcon type="info" message="请先选择 OZON 类目模板" description="选择类目后将自动继承已发布的尺码规则。" />
            : categorySizing.sizeMode === 'sized' && !selectedSizeAttribute
              ? <Alert showIcon type="error" message="类目尺码规则已失效" description="请先在类目模板中重新选择有效尺码属性并发布，再编辑本预设。" />
              : selectedSizeAttribute
                ? <Alert showIcon type="success" message="当前类目按尺码生成 Offer" description={`系统按产品媒体变体 × ${bilingualOzonAttributeLabel(selectedSizeAttribute)} 生成 Offer，并使用每行默认库存。`} />
                : <Alert showIcon type="info" message="当前类目为无尺码商品" description="保存时只使用第一行默认库存，不生成额外尺码 Offer。" />}
          <Form.List name="sizes">
            {(fields, { add, remove }) => <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {(selectedSizeAttribute ? fields : fields.slice(0, 1)).map((field, index) => <div className="ozon-preset-size-row" key={field.key}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <Form.Item name={[field.name, 'sizeId']} hidden><Input /></Form.Item>
                {selectedSizeAttribute ? <Form.Item
                  name={[field.name, 'value']}
                  label={`尺码值 ${index + 1}`}
                  extra={bilingualOzonAttributeLabel(selectedSizeAttribute)}
                  rules={[
                    { required: true, message: '请选择或填写尺码' },
                    { validator: async (_, value) => {
                      if (!value) return;
                      const sizes = (form.getFieldValue('sizes') || []) as Array<{ value?: string }>;
                      if (sizes.filter((size) => size?.value === value).length > 1) throw new Error(`尺码值不能重复：${value}`);
                    } }
                  ]}
                ><OzonPresetAttributeValueEditor strictDictionary attribute={selectedSizeAttribute} dictionarySnapshot={selectedCategory?.publishedVersion?.snapshot.dictionarySnapshot || {}} /></Form.Item> : <Form.Item label="尺码值"><Input aria-label="尺码值" disabled value="无尺码" /></Form.Item>}
                <Form.Item name={[field.name, 'stock']} label="默认库存" rules={[{ required: true, message: '请输入默认库存' }, { type: 'number', min: 0, message: '默认库存不能小于 0' }]}><InputNumber min={0} precision={0} /></Form.Item>
                {selectedSizeAttribute && <Button danger type="text" disabled={fields.length <= 1} onClick={() => remove(field.name)}>删除</Button>}
              </div>)}
              {selectedSizeAttribute && <Button icon={<PlusOutlined />} disabled={fields.length >= 99} onClick={() => add({ sizeId: crypto.randomUUID(), value: '', stock: 0 })}>添加尺码</Button>}
            </Space>}
          </Form.List>
          {categoryKey && <Alert
            showIcon
            type="info"
            message="Offer 数量预览"
            description={selectedSizeAttribute
              ? <>实际按“产品颜色数 × 尺码数”生成；当前已填写 {configuredSizeCount} 个尺码。例如 {OZON_PRESET_OFFER_EXAMPLE_COLOR_COUNT} 个颜色 × {configuredSizeCount} 个尺码 = <strong>{OZON_PRESET_OFFER_EXAMPLE_COLOR_COUNT * configuredSizeCount} 个 Offer</strong>。</>
              : <>无尺码类目按“产品颜色数 × 1”生成。例如 {OZON_PRESET_OFFER_EXAMPLE_COLOR_COUNT} 个颜色 × 1 = <strong>{OZON_PRESET_OFFER_EXAMPLE_COLOR_COUNT} 个 Offer</strong>。</>}
          />}
        </Card>
      </Form>
    </Drawer>
  </div>;
}

function OzonPresetAttributeLabel({ attribute }: { attribute: OzonCategoryAttribute }) {
  return <span className="ozon-preset-attribute-label">
    <strong>{ozonAttributeNameZh(attribute) || '中文名缺失'}</strong>
    <small>{ozonAttributeNameRu(attribute) || '俄文名缺失'} · #{attribute.id}{attribute.complexId ? ` / complex ${attribute.complexId}` : ''}</small>
  </span>;
}

function ozonRequiredPresetAttributeRule(attribute: OzonCategoryAttribute) {
  return {
    validator: async (_rule: unknown, value: unknown) => {
      const present = Array.isArray(value)
        ? value.some((entry) => Boolean(String(entry ?? '').trim()))
        : Boolean(String(value ?? '').trim());
      if (!present) throw new Error(`${bilingualOzonAttributeLabel(attribute)} 为 OZON 必填目录属性`);
    }
  };
}

function OzonPresetProjectedReadOnlyField({ attribute, coverage }: {
  attribute: OzonCategoryAttribute;
  coverage: OzonPresetRequiredAttributeCoverage;
}) {
  const generatedValue = coverage.systemValue;
  const displayValue = coverage.source === 'COLOR'
    ? '来自 E001 审核颜色 / Цвет из E001'
    : coverage.source === 'SIZE'
      ? '来自尺码与默认库存 / Из настройки размеров'
      : generatedValue ? `${generatedValue.labelZh} / ${generatedValue.labelRu}` : '系统自动生成';
  const detail = coverage.source === 'COLOR'
    ? '发布时读取 E001 已审核的产品颜色并写入每个颜色变体，禁止在预设中手工覆盖。'
    : coverage.source === 'SIZE'
      ? '请在“尺码与默认库存”中逐行配置，目录字段区不重复填写。'
      : generatedValue?.kind === 'NO_BRAND'
        ? '系统按无品牌策略精确解析 OZON 字典值，禁止在预设中手工覆盖。'
        : generatedValue?.kind === 'MAIN_SKU'
          ? '发布时使用商品主 SKU，确保同款颜色和尺码合并至同一张商品卡片。'
          : '发布计划根据商品与类目快照生成，禁止在预设中手工覆盖。';
  return <Form.Item
    key={ozonAttributeKey(attribute)}
    required={attribute.required}
    label={<OzonPresetAttributeLabel attribute={attribute} />}
    extra={detail}
  >
    <Input
      aria-label={`${ozonAttributeNameZh(attribute) || ozonAttributeNameRu(attribute) || attribute.id}${coverage.source === 'SYSTEM' ? '（系统自动生成）' : '（自动取值）'}`}
      readOnly
      value={displayValue}
      suffix={<Tag color="blue">{coverage.source === 'COLOR' ? 'E001 自动取值' : coverage.source === 'SIZE' ? '尺码配置' : '系统自动生成'}</Tag>}
    />
  </Form.Item>;
}

function OzonPresetAttributeFields({ title, attributes, formField, dictionarySnapshot, categoryType, coverageByKey }: {
  title: string;
  attributes: OzonCategoryAttribute[];
  formField: 'sharedAttributeValues' | 'variantAttributeValues';
  dictionarySnapshot: Record<string, Array<{ id: number; value: string; info?: string }>>;
  categoryType?: OzonCategoryTypeDescriptor;
  coverageByKey: ReadonlyMap<string, OzonPresetRequiredAttributeCoverage>;
}) {
  return <section className="ozon-preset-attribute-scope">
    <div className="ozon-preset-scope-heading"><strong>{title}</strong><Tag>{attributes.length} 项</Tag></div>
    {!attributes.length ? <Text type="secondary">当前类目没有该范围的可配置字段</Text> : <div className="ozon-attribute-grid">{attributes.map((attribute) => {
      const coverage = coverageByKey.get(ozonAttributeKey(attribute));
      if (attribute.id === 8229 && attribute.complexId === 0) {
        return <OzonCategoryTypeReadOnlyField key={ozonAttributeKey(attribute)} attribute={attribute} categoryType={categoryType} />;
      }
      if (coverage && coverage.source !== 'PRESET') {
        return <OzonPresetProjectedReadOnlyField key={ozonAttributeKey(attribute)} attribute={attribute} coverage={coverage} />;
      }
      return <Form.Item
        key={ozonAttributeKey(attribute)}
        name={[formField, ozonAttributeKey(attribute)]}
        required={attribute.required}
        label={<OzonPresetAttributeLabel attribute={attribute} />}
        rules={attribute.required ? [ozonRequiredPresetAttributeRule(attribute)] : undefined}
        extra={attribute.required ? 'OZON 必填；必须在本预设中填写。' : undefined}
      ><OzonPresetAttributeValueEditor attribute={attribute} dictionarySnapshot={dictionarySnapshot} /></Form.Item>;
    })}</div>}
  </section>;
}

function OzonPresetAttributeValueEditor({ attribute, dictionarySnapshot, strictDictionary = false, value, onChange }: {
  attribute: OzonCategoryAttribute;
  dictionarySnapshot: Record<string, Array<{ id: number; value: string; info?: string; valueRu?: string; valueZh?: string }>>;
  strictDictionary?: boolean;
  value?: string | string[];
  onChange?: (value: string | string[] | undefined) => void;
}) {
  const binding = OZON_LOCAL_DICTIONARY_BY_ATTRIBUTE[attribute.id];
  const directory = binding?.directory;
  const dictionaryId = binding?.dictionaryId ?? (attribute.dictionaryId || undefined);
  const localDictionary = useQuery({
    queryKey: ['ozon-catalog-dictionary', directory, dictionaryId],
    queryFn: () => api.ozonCatalogDictionary(directory!, dictionaryId, '', 2_000),
    enabled: Boolean(directory),
    staleTime: 10 * 60_000,
    retry: false
  });
  const snapshot = dictionarySnapshot[String(attribute.id)] || [];
  const options = localDictionary.data?.items.length
    ? localDictionary.data.items.map((entry) => ({
      value: binding?.storage === 'textRu' ? entry.nameRu : `dict:${entry.valueId}`,
      label: bilingualDictionaryValue(entry.nameZh, entry.nameRu)
    })).filter((entry) => Boolean(entry.value))
    : snapshot.map((entry) => ({
      value: `dict:${entry.id}`,
      label: bilingualDictionaryValue(entry.valueZh || entry.value, entry.valueRu || '')
    }));
  const dictionaryBacked = Boolean(directory || options.length || (strictDictionary && attribute.dictionaryId));
  if (dictionaryBacked || options.length) return <Select
    value={value}
    onChange={onChange}
    allowClear
    showSearch
    mode={attribute.maxCount > 1 ? 'multiple' : undefined}
    maxCount={attribute.maxCount}
    maxTagCount="responsive"
    loading={localDictionary.isFetching}
    disabled={strictDictionary && Boolean(attribute.dictionaryId) && !options.length && !localDictionary.isFetching}
    status={(localDictionary.isError || (strictDictionary && Boolean(attribute.dictionaryId))) && !options.length ? 'error' : undefined}
    optionFilterProp="label"
    placeholder={strictDictionary && attribute.dictionaryId && !options.length
      ? '尺码字典不可用，请先刷新并发布类目模板'
      : localDictionary.isError && !options.length
        ? '本地字典不可用，请先同步'
        : '输入中文搜索并选择字典值'}
    notFoundContent="没有匹配的 OZON 字典值"
    options={options}
  />;
  if (attribute.type === 'Boolean') return <Select
    value={typeof value === 'string' ? value : undefined}
    onChange={(next) => onChange?.(next)}
    allowClear
    options={[{ value: 'true', label: '是 / Да' }, { value: 'false', label: '否 / Нет' }]}
  />;
  return <Input
    value={typeof value === 'string' ? value : ''}
    onChange={(event) => onChange?.(event.target.value)}
    placeholder={attribute.required ? '可填写中文；提交前请确认 OZON 接受该文本值' : '可填写中文；可留空'}
  />;
}

function bilingualOzonAttributeLabel(attribute: OzonCategoryAttribute): string {
  return `${ozonAttributeNameZh(attribute) || '中文名缺失'} / ${ozonAttributeNameRu(attribute) || '俄文名缺失'} · #${attribute.id}`;
}

function presetAttributeValues(attributes: Array<{ attributeId: number; complexId: number; values: Array<{ dictionaryValueId?: number; value?: string }> }>): Record<string, string | string[]> {
  return Object.fromEntries(attributes.map((attribute) => {
    const values = attribute.values.map(displayAttributeValue).filter(Boolean);
    return [`${attribute.attributeId}:${attribute.complexId}`, values.length > 1 ? values : values[0] || ''];
  }));
}

function presetAttributeInputs(
  attributes: OzonCategoryAttribute[],
  values: Record<string, unknown> | undefined,
  categoryType?: OzonCategoryTypeDescriptor
) {
  return attributes.flatMap((attribute) => {
    if (attribute.id === 8229 && attribute.complexId === 0) {
      const typeId = Number(categoryType?.typeId || 0);
      return Number.isSafeInteger(typeId) && typeId > 0
        ? [{ attributeId: attribute.id, complexId: attribute.complexId, values: [{ dictionaryValueId: typeId }] }]
        : [];
    }
    const value = values?.[ozonAttributeKey(attribute)];
    const present = Array.isArray(value) ? value.some((entry) => String(entry || '').trim()) : Boolean(String(value ?? '').trim());
    return present ? [toAttributeInput(attribute, value)] : [];
  });
}

function normalizeOzonPresetSizes(values: Array<{ sizeId?: string; value?: string; stock?: number }> | undefined, sized: boolean) {
  const source = values?.length ? values : [{ sizeId: crypto.randomUUID(), value: '', stock: 0 }];
  const normalized = (sized ? source : source.slice(0, 1)).map((size) => ({
    sizeId: size.sizeId || crypto.randomUUID(),
    value: sized ? String(size.value || '').trim() : '',
    stock: Number(size.stock || 0)
  }));
  if (sized) {
    const valuesSeen = new Set<string>();
    for (const [index, size] of normalized.entries()) {
      if (!size.value) throw new Error(`尺码第 ${index + 1} 行不能为空`);
      if (valuesSeen.has(size.value)) throw new Error(`尺码值不能重复：${size.value}`);
      valuesSeen.add(size.value);
    }
  }
  return normalized;
}

function PanelTitle({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return <div className="ozon-panel-title"><span>{icon}</span><div><strong>{title}</strong><Text type="secondary">{description}</Text></div></div>;
}

type OzonVideoCompatibility = {
  mode: 'INTRO_AND_COVER' | 'COVER_ONLY' | 'BLOCKED' | 'PENDING_STORE_PRESET';
  productIntroductionSupported: boolean;
  videoCoverSupported: boolean;
  unsupportedRequiredProductSelection: boolean;
};

export const OZON_MANUAL_SHARED_VIDEO_COMPATIBILITY: OzonVideoCompatibility = {
  mode: 'PENDING_STORE_PRESET',
  productIntroductionSupported: false,
  videoCoverSupported: false,
  unsupportedRequiredProductSelection: false
};
export const OZON_MANUAL_SHARED_VIDEO_COMPATIBILITY_MESSAGE = '类目兼容性将在选择店铺后，按该店铺默认预设校验';

type OzonVideoVerificationByOffer = {
  offerId: string;
  mode?: 'INTRO_AND_COVER' | 'COVER_ONLY';
  sourceAssetId?: string;
  sameSource?: boolean;
  coverStatus?: string;
  introductionStatus?: string;
};

function ozonVideoCompatibility(attributes: OzonCategoryAttribute[]): OzonVideoCompatibility {
  const keys = new Set(attributes.map((attribute) => `${attribute.complexId}:${attribute.id}`));
  const videoCoverSupported = keys.has('100002:21845');
  const unsupportedRequiredProductSelection = attributes.some((attribute) => attribute.complexId === 100001 && attribute.id === 22273 && attribute.required);
  const productIntroductionSupported = keys.has('100001:21837') && keys.has('100001:21841') && !unsupportedRequiredProductSelection;
  return {
    mode: !videoCoverSupported ? 'BLOCKED' : productIntroductionSupported ? 'INTRO_AND_COVER' : 'COVER_ONLY',
    productIntroductionSupported,
    videoCoverSupported,
    unsupportedRequiredProductSelection
  };
}

function OzonVideoPurposeTags({ compatibility, compact = false }: { compatibility?: OzonVideoCompatibility; compact?: boolean }) {
  if (compatibility?.mode === 'PENDING_STORE_PRESET') {
    return <div className={`ozon-video-purpose-tags${compact ? ' is-compact' : ''}`} role="group" aria-label="产品视频只读用途">
      <Tag>产品介绍视频</Tag>
      <Tag>视频封面</Tag>
      <Text type="secondary">{OZON_MANUAL_SHARED_VIDEO_COMPATIBILITY_MESSAGE}</Text>
    </div>;
  }
  const introSupported = compatibility?.productIntroductionSupported !== false;
  const coverSupported = compatibility?.videoCoverSupported !== false;
  return <div className={`ozon-video-purpose-tags${compact ? ' is-compact' : ''}`} role="group" aria-label="产品视频只读用途">
    <Tag color={introSupported ? 'geekblue' : 'default'} className={introSupported ? '' : 'is-unavailable'}>产品介绍视频</Tag>
    <Tag color={coverSupported ? 'blue' : 'red'} className={coverSupported ? '' : 'is-unavailable'}>视频封面</Tag>
    {compatibility?.mode === 'COVER_ONLY' && <Text type="warning">类目降级为仅封面</Text>}
    {compatibility?.mode === 'BLOCKED' && <Text type="danger">类目不兼容</Text>}
  </div>;
}

function OzonVideoCompatibilityNotice({ compatibility }: { compatibility: OzonVideoCompatibility }) {
  if (compatibility.mode === 'INTRO_AND_COVER') {
    return <Alert
      className="ozon-video-compatibility"
      showIcon
      type="info"
      message="当前类目支持产品介绍视频与视频封面"
      description="每个变体只选择一个 MP4；系统上传一次，并把同一公网 URL 写入两个 OZON 用途。"
    />;
  }
  if (compatibility.mode === 'COVER_ONLY') {
    return <Alert
      className="ozon-video-compatibility"
      showIcon
      type="warning"
      message="当前类目已降级为仅视频封面"
      description={compatibility.unsupportedRequiredProductSelection
        ? '该类目要求填写“视频中的商品”，首版暂不写入该系统字段。因此仍保留同一个 MP4，但只提交视频封面；无需用户切换。'
        : 'OZON 类目的产品介绍视频字段暂不具备完整可写条件。仍保留同一个 MP4，但只提交视频封面；无需用户切换。'}
    />;
  }
  return <Alert
    className="ozon-video-compatibility"
    showIcon
    type="error"
    message="当前类目不支持视频封面"
    description="缺少上品所需的 OZON 视频封面字段，共享资料检查和店铺提交已阻止。请刷新或更换类目模板。"
  />;
}

function ozonGeneratedProductSummary(value: unknown): {
  schemaVersion: 1 | 2;
  videoMode?: 'INTRO_AND_COVER' | 'COVER_ONLY';
  revision: number;
  generatedAt?: string;
  isCurrent: boolean;
} | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const summary = (value as { generatedProductSummary?: unknown }).generatedProductSummary;
  if (!summary || typeof summary !== 'object') return undefined;
  const schemaVersion = Number((summary as { schemaVersion?: unknown }).schemaVersion);
  if (schemaVersion !== 1 && schemaVersion !== 2) return undefined;
  const revision = Number((summary as { revision?: unknown }).revision);
  if (!Number.isInteger(revision) || revision <= 0) return undefined;
  const videoMode = (summary as { videoMode?: unknown }).videoMode;
  const generatedAt = String((summary as { generatedAt?: unknown }).generatedAt || '').trim();
  return {
    schemaVersion,
    revision,
    isCurrent: (summary as { isCurrent?: unknown }).isCurrent === true,
    ...(generatedAt ? { generatedAt } : {}),
    ...(videoMode === 'INTRO_AND_COVER' || videoMode === 'COVER_ONLY' ? { videoMode } : {})
  };
}

export function ozonJobStageStateValue(job: Pick<OzonPublishJob, 'stageStates' | 'ozonProductLinks'> & Partial<Pick<OzonPublishJob, 'state' | 'offerIds' | 'payload'>>, stage: (typeof stages)[number][2]): string | undefined {
  if (stage === 'moderation') {
    const platformState = ozonAutomaticTaskPlatformState({
      state: job.state || 'NEEDS_ATTENTION',
      ozonProductLinks: job.ozonProductLinks,
      offerIds: job.offerIds,
      payload: job.payload
    });
    if (platformState?.state === 'ARCHIVED') return 'ARCHIVED';
    if (platformState?.state === 'NOT_FOR_SALE') return 'NOT_FOR_SALE';
    if (platformState?.state === 'PARTIAL_ON_SALE') return 'PARTIAL';
  }
  return job.stageStates[stage];
}

function OzonJobStageState({ job, stage, compact = false }: { job: OzonPublishJob; stage: (typeof stages)[number][2]; compact?: boolean }) {
  if (stage !== 'video') return <StageState value={ozonJobStageStateValue(job, stage)} />;
  const states = job.stageStates as OzonPublishJob['stageStates'] & {
    productVideo?: string;
    productIntroductionVideo?: string;
    videoCover?: string;
  };
  return <div className={`ozon-video-stage-state${compact ? ' is-compact' : ''}`} aria-label="产品视频与封面状态">
    <div className="ozon-video-stage-summary"><small>汇总</small><StageState value={states.video} /></div>
    <div><small>产品介绍</small><StageState value={states.productVideo || states.productIntroductionVideo} missingLabel="未回写" /></div>
    <div><small>视频封面</small><StageState value={states.videoCover} missingLabel="未回写" /></div>
  </div>;
}

function OzonVideoVerificationDetails({ job }: { job: OzonPublishJob }) {
  const rows = [...(job.events || [])].reverse().flatMap((event) => {
    const value = event.payload?.videoVerificationByOffer;
    return Array.isArray(value) ? value : [];
  }).filter((value): value is OzonVideoVerificationByOffer => Boolean(value && typeof value === 'object' && String((value as OzonVideoVerificationByOffer).offerId || '').trim()));
  const seenOfferIds = new Set<string>();
  const latestByOffer = rows.filter((row) => {
    const offerId = String(row.offerId);
    if (seenOfferIds.has(offerId)) return false;
    seenOfferIds.add(offerId);
    return true;
  });
  if (!latestByOffer.length) return null;
  return <section className="ozon-video-verification" aria-label="产品视频与封面逐变体验证">
    <div className="ozon-video-verification-heading"><div><VideoCameraOutlined /><div><strong>产品视频/封面读回</strong><Text type="secondary">同一 MP4 的两个平台用途分别验证，汇总状态仍显示在阶段轨道中。</Text></div></div><Tag>{latestByOffer.length} 个变体</Tag></div>
    <div className="ozon-video-verification-list">{latestByOffer.map((row) => <div key={row.offerId}>
      <code>{row.offerId}</code>
      <div><small>产品介绍视频</small><StageState value={row.introductionStatus} missingLabel={row.mode === 'COVER_ONLY' ? 'NOT_REQUIRED' : '未回写'} /></div>
      <div><small>视频封面</small><StageState value={row.coverStatus} missingLabel="未回写" /></div>
      <Tag color={row.sameSource ? 'green' : 'warning'}>{row.sameSource ? '同一 MP4' : '来源待核对'}</Tag>
    </div>)}</div>
  </section>;
}

function StageState({ value, missingLabel = 'PENDING' }: { value?: string; missingLabel?: string }) {
  const normalized = String(value || missingLabel).toUpperCase();
  const color = ['SUCCESS', 'SUCCEEDED', 'VERIFIED', 'ACTIVE'].includes(normalized) ? 'green' : ['FAILED', 'ERROR', 'BLOCKED'].includes(normalized) ? 'red' : ['RUNNING', 'PROCESSING', 'SUBMITTED', 'UPLOADING'].includes(normalized) ? 'blue' : ['PARTIAL', 'NEEDS_ATTENTION'].includes(normalized) ? 'orange' : 'default';
  return <Tag color={color}>{normalized}</Tag>;
}

function ListingState({ value }: { value?: string }) {
  const meta = listingStateMeta[String(value || '')] || { label: String(value || '未知'), color: 'default' };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

function ozonAttributeKey(attribute: OzonCategoryAttribute): string {
  return `${attribute.id}:${attribute.complexId}`;
}

function prioritizeRequiredOzonAttributes(attributes: OzonCategoryAttribute[]): OzonCategoryAttribute[] {
  return [
    ...attributes.filter((attribute) => attribute.required),
    ...attributes.filter((attribute) => !attribute.required)
  ];
}

function requiredOzonAttributesAreFirst(attributes: OzonCategoryAttribute[]): boolean {
  let optionalSeen = false;
  for (const attribute of attributes) {
    if (!attribute.required) optionalSeen = true;
    else if (optionalSeen) return false;
  }
  return true;
}

function ozonAttributeNameZh(attribute: OzonCategoryAttribute): string {
  const localized = String(attribute.nameZh || '').trim();
  if (localized) return localized;
  const legacy = String(attribute.name || '').trim();
  return /\p{Script=Han}/u.test(legacy) ? legacy : '';
}

function ozonAttributeNameRu(attribute: OzonCategoryAttribute): string {
  const localized = String(attribute.nameRu || '').trim();
  if (localized) return localized;
  const legacy = String(attribute.name || '').trim();
  return /\p{Script=Han}/u.test(legacy) ? '' : legacy;
}

function newOzonManualOffer(
  sku: string,
  variantCode: string,
  variantId: string,
  sourceOffer?: Record<string, unknown>,
  presetDefaultStock?: number
) {
  const price = Number(sourceOffer?.price);
  const oldPrice = Number(sourceOffer?.oldPrice);
  const minPrice = Number(sourceOffer?.minPrice);
  const sourceStock = Number(sourceOffer?.stock);
  return {
    variantId,
    productVariantId: variantId,
    productVariantName: `产品变体 ${variantCode}`,
    variantCode,
    offerId: stableOzonOfferId(sku, variantCode),
    modelGroup: sku,
    price: Number.isFinite(price) && price > 0 ? price : 0.01,
    ...(Number.isFinite(oldPrice) && oldPrice > 0 ? { oldPrice } : {}),
    ...(Number.isFinite(minPrice) && minPrice >= 0 ? { minPrice } : {}),
    stock: Number.isInteger(sourceStock) && sourceStock >= 0 ? sourceStock : Math.max(0, Math.trunc(Number(presetDefaultStock) || 0)),
    offerAttributeValues: {},
    media: []
  };
}

function toAttributeInput(attribute: OzonCategoryAttribute, value: unknown) {
  const parsed = (Array.isArray(value) ? value : [value]).map((entry) => String(entry ?? '').trim()).filter(Boolean);
  if (!parsed.length) throw new Error(`必填属性“${attribute.name}”不能为空`);
  return {
    attributeId: attribute.id,
    complexId: attribute.complexId,
    values: parsed.map((entry) => entry.startsWith('dict:') ? { dictionaryValueId: Number(entry.slice(5)) } : { value: entry })
  };
}

function bilingualDictionaryValue(nameZh: string, nameRu: string): string {
  const zh = String(nameZh || '').trim();
  const ru = String(nameRu || '').trim();
  return zh && ru && zh !== ru ? `${zh} / ${ru}` : zh || ru;
}

function displayAttributeValue(value?: { dictionaryValueId?: number; value?: string }) {
  if (!value) return '';
  return value.dictionaryValueId !== undefined ? `dict:${value.dictionaryValueId}` : value.value || '';
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debounced;
}

function formatOzonCatalogTime(value?: string): string {
  return value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
}

function showError(error: Error) {
  message.error(error instanceof ApiError ? error.userMessage : error.message);
}
