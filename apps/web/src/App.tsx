import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDownOutlined, ArrowLeftOutlined, ArrowRightOutlined, ArrowUpOutlined, CheckCircleOutlined, ClockCircleOutlined, CloudUploadOutlined,
  ApiOutlined, BellOutlined, CalculatorOutlined, CloudDownloadOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, EyeOutlined, FolderOpenOutlined, HolderOutlined, InfoCircleOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoneyCollectOutlined,
  NotificationOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, SearchOutlined, SettingOutlined, ShopOutlined, VerticalAlignTopOutlined, VideoCameraOutlined
} from '@ant-design/icons';
import {
  Alert, Badge, Breadcrumb, Button, Card, Checkbox, Col, DatePicker, Descriptions, Drawer, Empty, Flex, Form, Image,
  Input, Layout, List, Menu, message, Modal, notification as toastNotification, Pagination, Progress, Radio, Result, Row, Select, Skeleton, Space,
  Statistic, Switch, Table, Tabs, Tag, Tooltip, Tree, Typography, Upload
} from 'antd';
import type { MenuProps } from 'antd';
import type {
  AppConfig, FolderTreeNode, MediaIndexState, MediaIndexStatus, ProductTask, StageConfig, StageSummary, StageView, VariantSelectionGroup, WorkflowGroup, WorkflowParameterOptions, WorkflowParameterType, WorkflowParameterValue, WorkflowParameters
} from '@n8n-media-review/shared';
import { classifyPurchaseProductUrl, DEPRECATED_OUTPUT_ROOT_STAGE_IDS, E001_VARIANT_MAX_IMAGE_COUNT, LOCAL_IMPORT_PRODUCT_NAME_MAX_LENGTH, validateLocalImportProductName, WORKFLOW_RUNTIME_PARAMETER_NAMES } from '@n8n-media-review/shared';
import dayjs, { type Dayjs } from 'dayjs';
import { api, ApiError, type DownloadWorkflow, type LocalImportPreview, type LocalImportRecord, type LocalImportListItem, type PathValidation, type PendingView, type PurchaseDetail, type PurchaseDownloadBatch, type PurchaseInput, type PurchaseSummary, type SubmissionHistoryQuery, type TaskNotification } from './api/client';
import { CopyValueButton } from './copy-value';
import { ShippingCalculatorPage, ShippingTemplatesPage } from './shipping';
import { PricingCalculatorPage, PricingQueryPage, PricingTemplatesPage } from './pricing';
import { WbListingPage } from './wb-listing';
import { OzonListingPage } from './ozon-listing';
import { AboutPage } from './about';
import {
  E001VariantColorPassport,
  E001VariantGroupStatus,
  reconcileVariantOzonColors
} from './e001-variant-colors';
import { isWbMediaTerminalStage, resolveOzonSharedMediaReadiness, resolveReviewDeliveryTargets, resolveStageReviewDeliveryTargets, type ReviewDeliveryTarget } from './review-targets';
import {
  SUBMISSION_HISTORY_DATE_PRESET_OPTIONS,
  submissionHistoryDateBounds,
  submissionHistoryDateLabel,
  type SubmissionHistoryDatePreset,
  type SubmissionHistoryDateRange
} from './submission-history-date-filter';

const { Header, Sider, Content } = Layout;
const { Title, Text, Paragraph } = Typography;

const navigationGroupKeys = ['purchase-menu', 'review-menu', 'listing-menu', 'pricing-menu', 'shipping-menu'];
const navigationItems: MenuProps['items'] = [
  {
    key: 'purchase-menu',
    icon: <DatabaseOutlined />,
    label: '采购管理',
    popupClassName: 'primary-navigation-popup',
    children: [
      { key: '/purchases/local-import', label: '本地导入图片' },
      { key: '/purchases/url-download', label: '产品URL下载' },
      { key: '/purchases/query', label: '采购商品查询' }
    ]
  },
  {
    key: 'review-menu',
    icon: <PictureOutlined />,
    label: '图片审核与投递',
    popupClassName: 'primary-navigation-popup',
    children: [
      { key: '/', label: '审核工作台' },
      { key: '/pending', label: '待投递清单' },
      { key: '/history', label: '投递历史' }
    ]
  },
  {
    key: 'listing-menu',
    icon: <ShopOutlined />,
    label: '上品管理',
    popupClassName: 'primary-navigation-popup',
    children: [
      { key: '/listing/wb', label: 'WB上品' },
      { key: '/listing/ozon', label: 'OZON上品' }
    ]
  },
  {
    key: 'pricing-menu',
    icon: <MoneyCollectOutlined />,
    label: '售价管理',
    popupClassName: 'primary-navigation-popup',
    children: [
      { key: '/pricing/query', label: '售价查询' },
      { key: '/pricing', label: '售价计算' },
      { key: '/pricing/templates', label: '定价模板' }
    ]
  },
  {
    key: 'shipping-menu',
    icon: <CalculatorOutlined />,
    label: '运费管理',
    popupClassName: 'primary-navigation-popup',
    children: [
      { key: '/shipping', label: '运费计算' },
      { key: '/shipping/templates', label: '运费模板' }
    ]
  },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
  { key: '/notifications', icon: <BellOutlined />, label: '消息中心' },
  { key: '/about', icon: <InfoCircleOutlined />, label: '关于 MerchRoute' }
];

function resolveMenuKey(pathname: string): string {
  if (pathname.startsWith('/purchases/local-import')) return '/purchases/local-import';
  if (pathname.startsWith('/purchases/url-download')) return '/purchases/url-download';
  if (pathname.startsWith('/purchases/query')) return '/purchases/query';
  if (pathname.startsWith('/listing/ozon')) return '/listing/ozon';
  if (pathname.startsWith('/listing/wb')) return '/listing/wb';
  if (pathname.startsWith('/pricing/query')) return '/pricing/query';
  if (pathname.startsWith('/pricing/templates')) return '/pricing/templates';
  if (pathname.startsWith('/pricing')) return '/pricing';
  if (pathname.startsWith('/shipping/templates')) return '/shipping/templates';
  if (pathname.startsWith('/shipping')) return '/shipping';
  if (pathname.startsWith('/purchases')) return '/purchases/url-download';
  if (pathname.startsWith('/notifications')) return '/notifications';
  if (pathname.startsWith('/about')) return '/about';
  if (pathname.startsWith('/pending')) return '/pending';
  if (pathname.startsWith('/history')) return '/history';
  if (pathname.startsWith('/settings')) return '/settings';
  return '/';
}

function resolveMenuGroup(menuKey: string): string | undefined {
  if (menuKey.startsWith('/purchases/')) return 'purchase-menu';
  if (['/', '/pending', '/history'].includes(menuKey)) return 'review-menu';
  if (menuKey.startsWith('/listing')) return 'listing-menu';
  if (menuKey.startsWith('/pricing')) return 'pricing-menu';
  if (menuKey.startsWith('/shipping')) return 'shipping-menu';
  return undefined;
}

const statusMeta: Record<string, { label: string; color: string }> = {
  PENDING_REVIEW: { label: '待审核', color: 'default' },
  DRAFT: { label: '草稿', color: 'gold' },
  APPROVED_PENDING_SUBMISSION: { label: '待投递', color: 'cyan' },
  PACKAGING: { label: '打包中', color: 'processing' },
  PARTIALLY_SUBMITTED: { label: '部分完成', color: 'orange' },
  SUBMITTED: { label: '已投递', color: 'green' },
  FAILED: { label: '失败', color: 'red' }
};

const DOWNLOAD_WORKFLOW_GROUP_ID = 'downloads';
const isDownloadReviewStage = (stage?: Pick<StageConfig, 'groupId' | 'reviewEnabled'>): boolean => Boolean(stage?.groupId === DOWNLOAD_WORKFLOW_GROUP_ID && stage.reviewEnabled);
type ReviewFolderSummary = { pending: number; drafts: number; approved: number };
type PipelineStage = StageConfig & { summary?: StageSummary; index?: MediaIndexState };
type StagesResponse = { stages: StageView[] };
type MediaIndexPresentationStatus = MediaIndexStatus | 'BOOTSTRAP';
type MediaIndexPresentation = { status: MediaIndexPresentationStatus; lastSuccessfulAt?: string; error?: string };
const STAGES_QUERY_KEY = ['stages'] as const;

function useStagesQuery() {
  return useQuery<StagesResponse>({ queryKey: STAGES_QUERY_KEY, queryFn: api.stages, staleTime: Infinity, retry: false });
}

function mergeStageViews(configured: StageConfig[] | undefined, live: StageView[] | undefined): PipelineStage[] {
  if (!configured?.length) return live || [];
  const liveById = new Map((live || []).map((stage) => [stage.id, stage]));
  const configuredIds = new Set(configured.map((stage) => stage.id));
  return [
    ...configured.map((stage) => ({ ...stage, ...liveById.get(stage.id) })),
    ...(live || []).filter((stage) => !configuredIds.has(stage.id))
  ];
}

function reviewFolderSummary(stages: PipelineStage[]): ReviewFolderSummary | undefined {
  if (stages.some((stage) => !stage.summary || stage.index?.status === 'WARMING')) return undefined;
  return stages.reduce((summary, stage) => ({
    pending: summary.pending + stage.summary!.pending,
    drafts: summary.drafts + stage.summary!.drafts,
    approved: summary.approved + stage.summary!.approved
  }), { pending: 0, drafts: 0, approved: 0 });
}

function latestSuccessfulIndexTime(stages: PipelineStage[]): string | undefined {
  return stages
    .flatMap((stage) => [stage.index?.lastReconciledAt, stage.index?.lastFullReconciledAt, stage.summary?.lastScannedAt])
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function oldestStageSuccessTime(stages: PipelineStage[]): string | undefined {
  const times = stages.map((stage) => latestSuccessfulIndexTime([stage]));
  if (!times.length || times.some((value) => !value)) return undefined;
  return (times as string[]).sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

function mediaIndexPresentation(stages: PipelineStage[], query: { data?: unknown; isError: boolean; error?: Error | null }): MediaIndexPresentation {
  const activeStages = stages.filter((stage) => stage.enabled && stage.reviewEnabled);
  const indexedStages = activeStages.filter((stage) => stage.index);
  const byPriority: MediaIndexStatus[] = ['ERROR', 'STALE', 'WARMING', 'REFRESHING'];
  for (const status of byPriority) {
    const matches = indexedStages.filter((stage) => stage.index?.status === status);
    if (matches.length) return { status, lastSuccessfulAt: oldestStageSuccessTime(matches), error: matches.find((stage) => stage.index?.error)?.index?.error };
  }
  const degraded = indexedStages.filter((stage) => ['DEGRADED', 'UNAVAILABLE'].includes(stage.index?.watcherStatus || ''));
  if (degraded.length) return { status: 'STALE', lastSuccessfulAt: oldestStageSuccessTime(degraded), error: '目录监听已降级，MerchRoute 将使用定时校准保持结果更新。' };
  if (query.isError) return { status: 'ERROR', lastSuccessfulAt: latestSuccessfulIndexTime(activeStages), error: query.error?.message };
  if (query.data === undefined) return { status: 'BOOTSTRAP' };
  return { status: 'READY', lastSuccessfulAt: latestSuccessfulIndexTime(activeStages) };
}

function formatIndexTime(value?: string | null, compact = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无成功记录';
  return dayjs(value).format(compact ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm:ss');
}

function stageIndexStatus(stage: PipelineStage, fallback?: 'loading' | 'error'): MediaIndexStatus {
  if (!stage.enabled || !stage.reviewEnabled) return 'DISABLED';
  if (stage.index) return stage.index.status;
  if (!stage.summary) return fallback === 'error' ? 'ERROR' : 'READY';
  if (fallback === 'error') return 'STALE';
  return 'READY';
}

function stageMetric(stage: PipelineStage, key: keyof Pick<StageSummary, 'pending' | 'drafts' | 'approved' | 'queue' | 'totalTasks'>): number | string {
  return stage.summary && stageIndexStatus(stage) !== 'WARMING' ? stage.summary[key] : '—';
}

function stageIndexSuffix(stage: PipelineStage, fallback?: 'loading' | 'error'): string {
  const status = stageIndexStatus(stage, fallback);
  if (status === 'WARMING') return '首次建立索引 · —';
  if (status === 'REFRESHING') return '同步中';
  if (status === 'STALE') return `截至 ${formatIndexTime(stage.index?.lastReconciledAt || stage.summary?.lastScannedAt, true)}`;
  if (status === 'ERROR') return `更新异常 · ${formatIndexTime(stage.index?.lastReconciledAt || stage.summary?.lastScannedAt, true)}`;
  return '';
}

function useMediaIndexEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    let connected = false;
    let quickInvalidationTimer: number | undefined;
    let settledIndexTimer: number | undefined;
    const invalidateConsumers = () => {
      void client.invalidateQueries({ queryKey: STAGES_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['tasks'] });
      void client.invalidateQueries({ queryKey: ['task'] });
    };
    const scheduleQuickInvalidation = () => {
      if (settledIndexTimer !== undefined) {
        window.clearTimeout(settledIndexTimer);
        settledIndexTimer = undefined;
      }
      if (quickInvalidationTimer !== undefined) window.clearTimeout(quickInvalidationTimer);
      quickInvalidationTimer = window.setTimeout(() => {
        quickInvalidationTimer = undefined;
        invalidateConsumers();
      }, 100);
    };
    const scheduleSettledIndexInvalidation = (snapshot: StagesResponse | undefined) => {
      if (settledIndexTimer !== undefined) window.clearTimeout(settledIndexTimer);
      settledIndexTimer = undefined;
      if (!snapshot) return;
      const activeStages = snapshot.stages.filter((stage) => stage.enabled && stage.reviewEnabled);
      const settled = activeStages.length > 0 && activeStages.every((stage) => stage.index
        && !['WARMING', 'REFRESHING'].includes(stage.index.status)
        && stage.index.pendingReconciliations === 0);
      if (!settled) return;
      if (quickInvalidationTimer !== undefined) {
        window.clearTimeout(quickInvalidationTimer);
        quickInvalidationTimer = undefined;
      }
      settledIndexTimer = window.setTimeout(() => {
        settledIndexTimer = undefined;
        invalidateConsumers();
      }, 500);
    };
    const disconnect = api.connectMediaIndexEvents({
      onOpen: () => {
        if (connected) return;
        connected = true;
        scheduleQuickInvalidation();
      },
      onError: () => { connected = false; },
      onState: ({ type, stageId, state }) => {
        const updated = client.setQueryData<StagesResponse>(STAGES_QUERY_KEY, (current) => current ? {
          ...current,
          stages: current.stages.map((stage) => stage.id === stageId ? { ...stage, index: state } : stage)
        } : current);
        if (type === 'index-changed') scheduleSettledIndexInvalidation(updated);
        else scheduleQuickInvalidation();
      }
    });
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !connected) scheduleQuickInvalidation();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    const fallbackPoll = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !connected) scheduleQuickInvalidation();
    }, 30_000);
    return () => {
      disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(fallbackPoll);
      if (quickInvalidationTimer !== undefined) window.clearTimeout(quickInvalidationTimer);
      if (settledIndexTimer !== undefined) window.clearTimeout(settledIndexTimer);
    };
  }, [client]);
}

function useGlobalStageRescan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.rescanStages,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: STAGES_QUERY_KEY });
      message.success('已提交后台校准');
    },
    onError: (error: Error) => message.error(error.message)
  });
}

const workflowParameterTypeOptions: Array<{ value: WorkflowParameterType; label: string }> = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'array', label: 'Array' }
];
const workflowRuntimeParameterNames = new Set<string>(WORKFLOW_RUNTIME_PARAMETER_NAMES);
const isWorkflowRuntimeParameter = (name: string): boolean => workflowRuntimeParameterNames.has(name);

type WorkflowParameterDraftRow = {
  id: string;
  name: string;
  type: WorkflowParameterType;
  valueText: string;
  useOptions: boolean;
  optionTexts: string[];
  error?: string;
};

type WorkflowOptionEditorState = {
  rowId: string;
  fieldName: string;
  type: 'string' | 'number';
  values: string[];
  error?: string;
};

type WorkflowParameterTemplateFile = {
  stageId: string;
  parameters: WorkflowParameters;
  parameterOptions: WorkflowParameterOptions;
};

function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function importedWorkflowParameterRows(input: unknown, stageId: string): WorkflowParameterDraftRow[] {
  if (!isJsonRecord(input)) throw new Error('参数模板必须是 JSON 对象');
  const wrapped = typeof input.stageId === 'string' && Object.hasOwn(input, 'parameters');
  if (wrapped && input.stageId !== stageId) throw new Error(`模板属于 ${input.stageId}，不能导入当前阶段 ${stageId}`);
  const parameters = wrapped ? input.parameters : input;
  const parameterOptions = wrapped ? (input.parameterOptions ?? {}) : {};
  if (!isJsonRecord(parameters) || !isJsonRecord(parameterOptions)) throw new Error('参数或下拉选项格式无效');
  for (const options of Object.values(parameterOptions)) {
    if (!Array.isArray(options)) throw new Error('下拉选项必须是 JSON 数组');
  }
  const rows = workflowParameterRows(parameters as WorkflowParameters, parameterOptions as WorkflowParameterOptions, 'placeholder');
  const parsed = parseWorkflowParameterRows(rows);
  if (!parsed.parameters || !parsed.parameterOptions) throw new Error(Object.values(parsed.errors)[0] || '参数模板格式无效');
  for (const [name, options] of Object.entries(parsed.parameterOptions)) {
    if (!Object.is(parsed.parameters[name], options[0])) throw new Error(`${name} 的第一个下拉选项必须与默认值一致`);
  }
  return workflowParameterRows(parsed.parameters, parsed.parameterOptions, 'placeholder');
}

function workflowParameterTypeOf(value: WorkflowParameterValue): WorkflowParameterType {
  if (Array.isArray(value)) return 'array';
  return typeof value as Exclude<WorkflowParameterType, 'array'>;
}

function workflowParameterValueText(value: WorkflowParameterValue): string {
  return Array.isArray(value) ? JSON.stringify(value, null, 2) : String(value);
}

function workflowParameterRows(parameters: WorkflowParameters, parameterOptions: WorkflowParameterOptions = {}, runtimeMode: 'preserve' | 'placeholder' = 'preserve'): WorkflowParameterDraftRow[] {
  const orderedParameters: WorkflowParameters = {
    SKU: runtimeMode === 'placeholder' ? '' : typeof parameters.SKU === 'string' ? parameters.SKU : '',
    productName: runtimeMode === 'placeholder' ? '' : typeof parameters.productName === 'string' ? parameters.productName : '',
    ...(Object.prototype.hasOwnProperty.call(parameters, 'variants') ? { variants: runtimeMode === 'placeholder' ? '' : typeof parameters.variants === 'string' ? parameters.variants : '' } : {}),
    ...Object.fromEntries(Object.entries(parameters).filter(([name]) => !isWorkflowRuntimeParameter(name)))
  };
  return Object.entries(orderedParameters).map(([name, value]) => ({
    id: crypto.randomUUID(), name, type: workflowParameterTypeOf(value), valueText: workflowParameterValueText(value),
    useOptions: !isWorkflowRuntimeParameter(name) && Boolean(parameterOptions[name]), optionTexts: isWorkflowRuntimeParameter(name) ? [] : (parameterOptions[name] || []).map(String)
  }));
}

function parseWorkflowParameterValue(row: WorkflowParameterDraftRow): WorkflowParameterValue {
  if (row.type === 'string') return row.valueText;
  if (row.type === 'number') {
    if (!row.valueText.trim()) throw new Error('Number 不能为空');
    const value = Number(row.valueText);
    if (!Number.isFinite(value)) throw new Error('请输入有效的有限数字');
    return value;
  }
  if (row.type === 'boolean') {
    if (row.valueText !== 'true' && row.valueText !== 'false') throw new Error('请选择 true 或 false');
    return row.valueText === 'true';
  }
  try {
    const value = JSON.parse(row.valueText);
    if (!Array.isArray(value)) throw new Error('请输入 JSON 数组，例如 [".jpg", ".png"]');
    return value;
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? '请输入有效的 JSON 数组' : (error as Error).message);
  }
}

function parseWorkflowParameterRows(rows: WorkflowParameterDraftRow[], requireFirstDefault = false): { parameters?: WorkflowParameters; parameterOptions?: WorkflowParameterOptions; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const parameters: WorkflowParameters = {};
  const parameterOptions: WorkflowParameterOptions = {};
  const names = new Map<string, string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) errors[row.id] = '参数字段名不能为空';
    else if (names.has(name)) {
      errors[row.id] = '参数字段名不能重复';
      errors[names.get(name)!] = '参数字段名不能重复';
    } else names.set(name, row.id);
    try {
      if (name) {
        let value = parseWorkflowParameterValue(row);
        if (row.useOptions) {
          if (row.type !== 'string' && row.type !== 'number') throw new Error('只有 String 和 Number 字段支持下拉选项');
          if (row.optionTexts.length < 2) throw new Error('下拉字段至少需要两个选项');
          const options = row.optionTexts.map((optionText) => {
            if (row.type === 'string') {
              if (!optionText.trim()) throw new Error('String 选项不能为空');
              return optionText.trim();
            }
            if (!optionText.trim() || !Number.isFinite(Number(optionText))) throw new Error('Number 选项必须是有限数字');
            return Number(optionText);
          });
          if (new Set(options.map((option) => `${typeof option}:${String(option)}`)).size !== options.length) throw new Error('下拉选项不能重复');
          if (requireFirstDefault) value = options[0]!;
          else if (!options.some((option) => Object.is(option, value))) throw new Error('任务参数值必须来自冻结的下拉选项');
          parameterOptions[name] = options;
        }
        parameters[name] = value;
      }
    } catch (error) {
      errors[row.id] = (error as Error).message;
    }
  }
  return Object.keys(errors).length ? { errors } : { parameters, parameterOptions, errors };
}

function convertWorkflowParameterType(row: WorkflowParameterDraftRow, type: WorkflowParameterType): WorkflowParameterDraftRow {
  if (row.type === type) return row;
  try {
    const currentValue = parseWorkflowParameterValue(row);
    let nextValue: WorkflowParameterValue;
    if (type === 'string') nextValue = Array.isArray(currentValue) ? JSON.stringify(currentValue) : String(currentValue);
    else if (type === 'number') {
      if (typeof currentValue === 'number') nextValue = currentValue;
      else if (typeof currentValue === 'string' && currentValue.trim() && Number.isFinite(Number(currentValue))) nextValue = Number(currentValue);
      else if (typeof currentValue === 'boolean') nextValue = currentValue ? 1 : 0;
      else throw new Error();
    } else if (type === 'boolean') {
      if (typeof currentValue === 'boolean') nextValue = currentValue;
      else if (typeof currentValue === 'string' && ['true', 'false'].includes(currentValue)) nextValue = currentValue === 'true';
      else if (typeof currentValue === 'number' && [0, 1].includes(currentValue)) nextValue = currentValue === 1;
      else throw new Error();
    } else {
      if (Array.isArray(currentValue)) nextValue = currentValue;
      else if (typeof currentValue === 'string') {
        const parsed = JSON.parse(currentValue);
        if (!Array.isArray(parsed)) throw new Error();
        nextValue = parsed;
      } else throw new Error();
    }
    let optionTexts = row.optionTexts;
    if (row.useOptions && type === 'number') optionTexts = row.optionTexts.map((value) => {
      if (!value.trim() || !Number.isFinite(Number(value))) throw new Error();
      return String(Number(value));
    });
    else if (row.useOptions && type === 'string') optionTexts = row.optionTexts.map((value) => String(value));
    else if (type !== 'string' && type !== 'number') optionTexts = [];
    return { ...row, type, valueText: workflowParameterValueText(nextValue), useOptions: row.useOptions && (type === 'string' || type === 'number'), optionTexts, error: undefined };
  } catch {
    const label = workflowParameterTypeOptions.find((option) => option.value === type)?.label || type;
    return row.useOptions
      ? { ...row, error: `当前值或选项无法转换为 ${label}` }
      : { ...row, type, error: `当前值无法转换为 ${label}，请填写有效值` };
  }
}

function WorkflowParameterValueEditor({ row, onChange, ariaLabel, disabled = false }: { row: WorkflowParameterDraftRow; onChange: (valueText: string) => void; ariaLabel: string; disabled?: boolean }) {
  const commonChange = (valueText: string) => onChange(valueText);
  if (row.useOptions) {
    return <Select aria-label={ariaLabel} disabled={disabled} value={row.valueText} placeholder="请选择参数值" onChange={commonChange} options={row.optionTexts.filter((value) => value.trim()).map((value) => ({ value, label: value }))} />;
  }
  if (row.type === 'boolean') {
    return <Select aria-label={ariaLabel} disabled={disabled} value={row.valueText === 'true' || row.valueText === 'false' ? row.valueText : undefined} placeholder="请选择 true 或 false" onChange={commonChange} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} />;
  }
  if (row.type === 'number') return <Input aria-label={ariaLabel} disabled={disabled} type="number" value={row.valueText} onChange={(event) => commonChange(event.target.value)} />;
  return <Input.TextArea aria-label={ariaLabel} disabled={disabled} placeholder={row.type === 'array' ? 'JSON 数组，例如 [".jpg", ".png"]' : '默认值（允许为空）'} autoSize={{ minRows: 1, maxRows: 6 }} value={row.valueText} onChange={(event) => commonChange(event.target.value)} />;
}

export function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [narrowNavigation, setNarrowNavigation] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useMediaIndexEvents();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: api.config });
  const menuKey = resolveMenuKey(location.pathname);
  const activeMenuGroup = resolveMenuGroup(menuKey);
  const [openMenuKeys, setOpenMenuKeys] = useState<string[]>(activeMenuGroup ? [activeMenuGroup] : []);
  const headerConfigurationStatus: { badge: 'success' | 'warning' | 'processing' | 'error'; label: string } = configQuery.data
    ? configQuery.data.readiness.complete
      ? { badge: 'success', label: '目录已就绪' }
      : { badge: 'warning', label: '需要完成设置' }
    : configQuery.isError
      ? { badge: 'error', label: '配置状态不可用' }
      : { badge: 'processing', label: '读取配置' };

  useEffect(() => {
    if (configQuery.data && !configQuery.data.readiness.complete && !location.pathname.startsWith('/settings')) navigate('/settings', { replace: true });
  }, [configQuery.data, location.pathname, navigate]);

  useEffect(() => {
    setOpenMenuKeys(activeMenuGroup ? [activeMenuGroup] : []);
  }, [activeMenuGroup, location.pathname]);

  const handleMenuOpenChange: MenuProps['onOpenChange'] = (keys) => {
    const latestOpenKey = keys.find((key) => !openMenuKeys.includes(key));
    setOpenMenuKeys(latestOpenKey && navigationGroupKeys.includes(latestOpenKey) ? [latestOpenKey] : []);
  };

  return (
    <Layout className="app-frame">
      <Sider
        collapsible
        collapsed={collapsed}
        collapsedWidth={narrowNavigation ? 0 : 80}
        breakpoint="md"
        onBreakpoint={(broken) => { setNarrowNavigation(broken); setCollapsed(broken); }}
        trigger={null}
        width={236}
        className="app-sider"
      >
        <div className="brand-lockup">
          <div className="brand-mark"><img src="/brand-logo.png" alt="" /></div>
          {!collapsed && <div><strong>MerchRoute</strong><span>From Source to Shelf.</span></div>}
        </div>
        <Menu
          aria-label="主导航"
          className="primary-navigation"
          theme="dark"
          mode="inline"
          selectedKeys={[menuKey]}
          openKeys={openMenuKeys}
          onOpenChange={handleMenuOpenChange}
          onClick={({ key }) => { navigate(key); if (narrowNavigation) setCollapsed(true); }}
          items={navigationItems}
        />
        <div className="sider-foot">{!collapsed && <>本地服务<br />127.0.0.1:4173</>}</div>
      </Sider>
      <Layout>
        <Header className="app-header">
          <Button aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'} type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
          <Space size={18}><div className="header-status"><Badge status={headerConfigurationStatus.badge} /><span>{headerConfigurationStatus.label}</span></div><NotificationHub /></Space>
        </Header>
        <Content className="app-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/review/downloads" element={<DownloadCenter />} />
            <Route path="/review/:stageId" element={<TaskList />} />
            <Route path="/task/:taskId" element={<ReviewDetail />} />
            <Route path="/purchases" element={<LegacyPurchaseRedirect />} />
            <Route path="/purchases/local-import" element={<PurchaseLocalImportPage />} />
            <Route path="/purchases/url-download" element={<PurchasePage />} />
            <Route path="/purchases/query" element={<PurchaseProductQueryPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/listing/wb" element={<WbListingPage />} />
            <Route path="/listing/ozon" element={<OzonListingPage />} />
            <Route path="/shipping" element={<ShippingCalculatorPage />} />
            <Route path="/shipping/templates" element={<ShippingTemplatesPage />} />
            <Route path="/pricing" element={<PricingCalculatorPage />} />
            <Route path="/pricing/query" element={<PricingQueryPage />} />
            <Route path="/pricing/templates" element={<PricingTemplatesPage />} />
            <Route path="/settings/download-workflows" element={<Navigate to="/settings?section=download" replace />} />
            <Route path="/pending" element={<PendingPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

function LegacyPurchaseRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: '/purchases/url-download', search: location.search, hash: location.hash }} replace />;
}

function DisabledStageNotice({ stageId, description, returnTo = '/', returnLabel = '返回流程工作台' }: { stageId?: string; description?: string; returnTo?: string; returnLabel?: string }) {
  const disabled = !description || description.includes('STAGE_DISABLED');
  return <Result
    status={disabled ? 'warning' : 'error'}
    title={disabled ? `${stageId ? `流程 ${stageId} ` : '该流程'}已停用` : '无法打开该任务'}
    subTitle={disabled ? '系统已停止扫描和审核该流程。请在系统设置中重新启用并保存配置后继续。' : description}
    extra={<Space><Link to={returnTo}><Button type="primary">{returnLabel}</Button></Link><Link to="/settings"><Button>打开系统设置</Button></Link></Space>}
  />;
}

function MediaIndexBanner({ presentation, retrying, onRetry }: { presentation: MediaIndexPresentation; retrying: boolean; onRetry: () => void }) {
  if (presentation.status === 'BOOTSTRAP' || presentation.status === 'READY' || presentation.status === 'REFRESHING' || presentation.status === 'DISABLED') return null;
  const lastSuccess = formatIndexTime(presentation.lastSuccessfulAt);
  const content = presentation.status === 'WARMING'
    ? { type: 'info' as const, message: '首次建立索引', description: 'MerchRoute 正在后台建立媒体索引，页面已可使用，统计将自动更新。' }
    : presentation.status === 'STALE'
      ? { type: 'warning' as const, message: '媒体索引等待校准', description: `${presentation.error ? `${presentation.error} ` : ''}当前显示上次成功于 ${lastSuccess} 的结果。` }
      : { type: 'error' as const, message: '媒体索引更新失败', description: `${presentation.error || '后台校准未成功。'} 当前显示上次成功于 ${lastSuccess} 的结果。` };
  const canRetry = presentation.status === 'STALE' || presentation.status === 'ERROR';
  return <Alert className={`media-index-banner is-${presentation.status.toLowerCase()}`} showIcon type={content.type} message={content.message} description={content.description} action={canRetry ? <Button size="small" loading={retrying} onClick={onRetry}>重新校准</Button> : undefined} />;
}

function MediaIndexCompactState({ presentation, retrying, onRetry }: { presentation: MediaIndexPresentation; retrying: boolean; onRetry: () => void }) {
  if (presentation.status === 'BOOTSTRAP' || presentation.status === 'READY' || presentation.status === 'DISABLED') return null;
  const canRetry = presentation.status === 'STALE' || presentation.status === 'ERROR';
  const label = presentation.status === 'WARMING' ? '首次建立索引'
    : presentation.status === 'REFRESHING' ? '同步中'
      : `${presentation.status === 'ERROR' ? '更新失败' : '数据待校准'} · ${formatIndexTime(presentation.lastSuccessfulAt, true)}`;
  return <span className={`media-index-compact-state is-${presentation.status.toLowerCase()}`}><span>{label}</span>{canRetry && <Button type="link" size="small" loading={retrying} onClick={onRetry}>重试</Button>}</span>;
}

function StageRescanButton({ presentation, submitting, onClick }: { presentation: MediaIndexPresentation; submitting: boolean; onClick: () => void }) {
  const synchronizing = presentation.status === 'WARMING' || presentation.status === 'REFRESHING';
  const label = presentation.status === 'WARMING' ? '建立索引中' : presentation.status === 'REFRESHING' ? '同步中' : '刷新状态';
  return <Button className="stage-rescan-button" aria-busy={submitting || synchronizing} icon={<ReloadOutlined />} loading={submitting || synchronizing} onClick={onClick}>{label}</Button>;
}

function Dashboard() {
  const stagesQuery = useStagesQuery();
  const config = useQuery({ queryKey: ['config'], queryFn: api.config });
  const rescan = useGlobalStageRescan();
  const stages = mergeStageViews(config.data?.config.stages, stagesQuery.data?.stages).filter((stage) => stage.enabled);
  const downloadStages = stages.filter(isDownloadReviewStage);
  const productionStages = stages.filter((stage) => !isDownloadReviewStage(stage));
  const presentation = mediaIndexPresentation(stages, stagesQuery);
  const summaryStatus = stagesQuery.isError ? 'error' as const : undefined;
  const bootstrapping = presentation.status === 'BOOTSTRAP';
  const initialStagesFailure = stagesQuery.isError && stagesQuery.data === undefined;
  return (
    <div className="page-stack">
      <PageTitle eyebrow="PRODUCTION CONTACT SHEET" title="产品图片审核与投递" description="在一个界面完成选图、审批和标准任务包投递。审核不会直接启动任何 n8n 工作流。" extra={<StageRescanButton presentation={presentation} submitting={rescan.isPending} onClick={() => rescan.mutate()} />} />
      {config.data && !config.data.readiness.complete && <Alert showIcon type="warning" message="目录配置尚未就绪" description={<span>请先在 <Link to="/settings">系统设置</Link> 中验证已启用工作流的候选目录。</span>} />}
      <MediaIndexBanner presentation={presentation} retrying={rescan.isPending} onRetry={() => rescan.mutate()} />
      <div className="dashboard-content-region" aria-label="审核工作台内容">
        {bootstrapping ? <div className="dashboard-bootstrap-state" role="status"><Text type="secondary">MerchRoute 正在读取工作流配置…</Text></div> : <>
          {initialStagesFailure ? <div className="dashboard-bootstrap-state is-error" role="alert"><Space direction="vertical"><Text strong>无法读取工作流状态</Text><Text type="secondary">{stagesQuery.error?.message || '请检查本地服务后重试。'}</Text><Button loading={stagesQuery.isFetching} onClick={() => void stagesQuery.refetch()}>重新读取</Button></Space></div> : <>
            {stages.length ? <PipelineRail stages={productionStages} downloadStages={downloadStages} summaryStatus={summaryStatus} /> : <Empty description="还没有已启用的工作流"><Link to="/settings"><Button type="primary">打开系统设置</Button></Link></Empty>}
            {productionStages.length > 0 && <section className="dashboard-workflow-section" aria-labelledby="production-stage-heading">
              <div className="dashboard-section-heading"><div><span>PRODUCTION WORKFLOWS</span><Title id="production-stage-heading" level={3}>生成与处理</Title></div><Text type="secondary">按当前工作流配置继续审核和投递</Text></div>
              <Row gutter={[16, 16]}>{productionStages.map((stage) => <Col xs={24} md={12} xl={8} key={stage.id}><StageCard stage={stage} /></Col>)}</Row>
            </section>}
          </>}
        </>}
      </div>
    </div>
  );
}

function PipelineRail({ stages, downloadStages, compact = false, summaryStatus, ariaLabel = '工作流阶段' }: { stages: PipelineStage[]; downloadStages: PipelineStage[]; compact?: boolean; summaryStatus?: 'loading' | 'error'; ariaLabel?: string }) {
  const downloadSummary = reviewFolderSummary(downloadStages);
  const downloadPresentation = mediaIndexPresentation(downloadStages, { data: true, isError: summaryStatus === 'error' });
  const pendingText = (stage?: PipelineStage) => {
    if (!stage) {
      if (downloadPresentation.status === 'WARMING') return '首次建立索引 · —';
      if (downloadPresentation.status === 'ERROR') return '状态更新失败 · —';
      return '状态更新中';
    }
    const suffix = stageIndexSuffix(stage, summaryStatus);
    if (!stage.summary) return summaryStatus === 'error' ? '状态更新失败 · —' : '状态更新中 · —';
    if (stageIndexStatus(stage, summaryStatus) === 'WARMING') return suffix || '首次建立索引 · —';
    const value = stage.reviewEnabled ? `${stage.summary.pending} 待审核` : `${stage.summary.queue || 0} 队列`;
    return suffix ? `${value} · ${suffix}` : value;
  };
  const downloadText = downloadSummary
    ? `${downloadSummary.pending} 待审核 · ${downloadSummary.drafts} 草稿${downloadPresentation.status === 'REFRESHING' ? ' · 同步中' : downloadPresentation.status === 'STALE' || downloadPresentation.status === 'ERROR' ? ` · 截至 ${formatIndexTime(downloadPresentation.lastSuccessfulAt, true)}` : ''}`
    : pendingText();
  return <section className={`pipeline-rail${compact ? ' is-compact' : ''}`} aria-label={ariaLabel} aria-busy={['WARMING', 'REFRESHING'].includes(downloadPresentation.status)}>
    <div className="rail-line" />
    {downloadStages.length > 0 && <Link className="rail-stop rail-stop-download" to="/review/downloads" aria-label="进入下载中心">
      <span className="rail-index">SOURCE</span>
      <span className="rail-source-count">{downloadStages.length}</span>
      <strong>下载中心</strong>
      <small>{downloadStages.length} 个下载审核来源</small>
      <em>{downloadText}</em>
    </Link>}
    {stages.map((stage, index) => {
      const content = <>
        <span className="rail-index">{String(index + (downloadStages.length ? 2 : 1)).padStart(2, '0')}</span>
        <strong>{workflowLabel(stage)}</strong>
        <small>{stage.displayName}</small>
        <em>{pendingText(stage)}</em>
      </>;
      return stage.reviewEnabled
        ? <Link className="rail-stop rail-stop-stage" to={`/review/${stage.id}`} aria-label={`进入 ${workflowLabel(stage)} 审核`} key={stage.id}>{content}</Link>
        : <div className="rail-stop" key={stage.id}>{content}</div>;
    })}
  </section>;
}

function useWorkflowShortcutData() {
  const stageConfiguration = useQuery({ queryKey: ['config'], queryFn: api.config, retry: false });
  const stageSummaries = useStagesQuery();
  const stageDefinitions = mergeStageViews(stageConfiguration.data?.config.stages, stageSummaries.data?.stages);
  const hasStageMetadata = Boolean(stageSummaries.data || stageConfiguration.data);
  const activeStages = stageDefinitions.filter((stage) => stage.enabled);
  return {
    stageConfiguration,
    stageSummaries,
    stageDefinitions,
    activeStages,
    downloadStages: activeStages.filter(isDownloadReviewStage),
    productionStages: activeStages.filter((stage) => !isDownloadReviewStage(stage)),
    stageMetadataLoading: !hasStageMetadata && (stageSummaries.isLoading || stageConfiguration.isLoading),
    stageMetadataError: !hasStageMetadata && stageSummaries.isError && stageConfiguration.isError,
    stageSummaryStatus: stageSummaries.isError ? 'error' as const : undefined,
    indexPresentation: mediaIndexPresentation(activeStages, stageSummaries)
  };
}

type WorkflowShortcutData = ReturnType<typeof useWorkflowShortcutData>;

function WorkflowShortcuts({ context, data }: { context: 'history' | 'pending'; data: WorkflowShortcutData }) {
  const titleId = `${context}-workflow-shortcuts-title`;
  const rescan = useGlobalStageRescan();
  const { stageConfiguration, stageSummaries, activeStages, downloadStages, productionStages, stageMetadataLoading, stageMetadataError, stageSummaryStatus, indexPresentation } = data;
  return <section className={`workflow-shortcuts ${context}-workflow-shortcuts`} aria-labelledby={titleId}>
    <div className="workflow-shortcuts-heading">
      <Title id={titleId} level={4}>工作流导航</Title>
      <div className="workflow-shortcuts-meta"><Text type="secondary">点击进入对应审核页面</Text>{stageConfiguration.data && stageSummaries.isError ? <><Text type="danger" role="alert">导航状态更新失败</Text><Button type="link" size="small" loading={stageSummaries.isFetching} onClick={() => void stageSummaries.refetch()}>重试状态</Button></> : <MediaIndexCompactState presentation={indexPresentation} retrying={rescan.isPending} onRetry={() => rescan.mutate()} />}</div>
    </div>
    {stageMetadataLoading
      ? <div className="workflow-shortcuts-state workflow-shortcuts-skeleton" aria-label="工作流导航加载中"><Skeleton active title={{ width: '32%' }} paragraph={{ rows: 1, width: ['80%'] }} /></div>
      : stageMetadataError
        ? <Alert className="workflow-shortcuts-state" type="error" showIcon message="工作流导航加载失败" description={stageSummaries.error?.message || stageConfiguration.error?.message || '无法读取工作流配置'} action={<Button size="small" loading={stageSummaries.isFetching || stageConfiguration.isFetching} onClick={() => void Promise.all([stageSummaries.refetch(), stageConfiguration.refetch()])}>重新加载</Button>} />
        : activeStages.length
          ? <PipelineRail compact ariaLabel="工作流导航" stages={productionStages} downloadStages={downloadStages} summaryStatus={stageSummaryStatus} />
          : <div className="workflow-shortcuts-state workflow-shortcuts-empty"><Text type="secondary">暂无已启用的工作流</Text><Link to="/settings"><Button size="small">打开系统设置</Button></Link></div>}
  </section>;
}

function DownloadSummaryStatistic({ status, title, value }: { status: keyof ReviewFolderSummary; title: string; value: number | string }) {
  return <div className="download-summary-stat" data-status={status}><Statistic title={title} value={value} suffix={typeof value === 'number' ? '个' : undefined} /></div>;
}

function DownloadCenter() {
  const stagesQuery = useStagesQuery();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: api.config });
  const rescan = useGlobalStageRescan();
  const allStages = mergeStageViews(configQuery.data?.config.stages, stagesQuery.data?.stages);
  const downloadStages = allStages.filter(isDownloadReviewStage);
  const activeStages = downloadStages.filter((stage) => stage.enabled);
  const disabledStages = downloadStages.filter((stage) => !stage.enabled);
  const summary = reviewFolderSummary(activeStages);
  const deliveryTargets = resolveReviewDeliveryTargets(activeStages, allStages);
  const pathMap = new Map(configQuery.data?.readiness.paths.map((item) => [item.path, item]));
  const presentation = mediaIndexPresentation(activeStages, stagesQuery);
  const bootstrapping = presentation.status === 'BOOTSTRAP';
  const initialStagesFailure = stagesQuery.isError && stagesQuery.data === undefined;
  return <div className="page-stack download-center-page">
    <Breadcrumb items={[{ title: <Link to="/">审核工作台</Link> }, { title: '下载中心' }]} />
    <PageTitle eyebrow="DOWNLOAD REVIEW ROUTER" title="下载中心" description="集中查看各平台下载后的审核文件夹，并选择对应工作流进入审核。" meta={allStages.length ? <DeliveryTargetStrip targets={deliveryTargets} /> : undefined} extra={<StageRescanButton presentation={presentation} submitting={rescan.isPending} onClick={() => rescan.mutate()} />} />
    <MediaIndexBanner presentation={presentation} retrying={rescan.isPending} onRetry={() => rescan.mutate()} />
    <div className="dashboard-content-region" aria-label="下载中心内容">
      {bootstrapping ? <div className="dashboard-bootstrap-state" role="status"><Text type="secondary">MerchRoute 正在读取下载工作流配置…</Text></div> : <>
        {initialStagesFailure ? <div className="dashboard-bootstrap-state is-error" role="alert"><Space direction="vertical"><Text strong>无法读取下载工作流状态</Text><Text type="secondary">{stagesQuery.error?.message || '请检查本地服务后重试。'}</Text><Button loading={stagesQuery.isFetching} onClick={() => void stagesQuery.refetch()}>重新读取</Button></Space></div> : <>
          <Card className="download-center-summary-card">
            <div className="download-center-summary-heading"><div><span>ACTIVE REVIEW FOLDERS</span><Title level={4}>当前审核文件夹</Title></div><Tag color="cyan">{activeStages.length} 个运行中来源</Tag></div>
            <div className="download-center-summary-grid" aria-label="所有下载工作流审核文件夹统计">
              <DownloadSummaryStatistic status="pending" title="待审核" value={summary?.pending ?? '—'} />
              <DownloadSummaryStatistic status="drafts" title="草稿" value={summary?.drafts ?? '—'} />
              <DownloadSummaryStatistic status="approved" title="待投递" value={summary?.approved ?? '—'} />
            </div>
          </Card>
          <section className="download-source-section" aria-labelledby="active-download-source-heading">
            <div className="download-source-section-heading"><div><span>REVIEW SOURCES</span><Title id="active-download-source-heading" level={3}>审核来源</Title></div><Text type="secondary">按系统设置中的下载组顺序显示</Text></div>
            {activeStages.length ? <Row gutter={[16, 16]}>{activeStages.map((stage) => <Col xs={24} md={12} xl={8} key={stage.id}><DownloadSourceCard stage={stage} pathStatus={stage.candidateRoot ? pathMap.get(stage.candidateRoot) : undefined} /></Col>)}</Row> : <Card><Empty description="尚未配置已启用的下载审核来源"><Link to="/settings"><Button type="primary">前往系统设置</Button></Link></Empty></Card>}
          </section>
          {disabledStages.length > 0 && <details className="disabled-download-sources">
            <summary>已停用来源 <span>{disabledStages.length}</span></summary>
            <Row gutter={[16, 16]}>{disabledStages.map((stage) => <Col xs={24} md={12} xl={8} key={stage.id}><DownloadSourceCard stage={stage} /></Col>)}</Row>
          </details>}
        </>}
      </>}
    </div>
  </div>;
}

function DownloadSourceCard({ stage, pathStatus }: { stage: PipelineStage; pathStatus?: PathValidation }) {
  const directoryReady = pathStatus ? pathStatus.exists && pathStatus.readable : undefined;
  const state = !stage.enabled ? { badge: 'default' as const, label: '已停用' } : directoryReady === false ? { badge: 'error' as const, label: '目录不可用' } : directoryReady === undefined ? { badge: 'processing' as const, label: '检查中' } : { badge: 'success' as const, label: '运行中' };
  return <Card className={`download-source-card${stage.enabled ? '' : ' is-disabled'}`}>
    <div className="download-source-card-heading">
      <div><Space size={8}><span className="mono-badge">{stage.id}</span><Title level={4}>{stage.alias}</Title></Space><Text type="secondary">{stage.displayName}</Text></div>
      <Badge status={state.badge} text={state.label} />
    </div>
    <div className="download-source-stat-grid">
      <DownloadSummaryStatistic status="pending" title="待审核" value={stageMetric(stage, 'pending')} />
      <DownloadSummaryStatistic status="drafts" title="草稿" value={stageMetric(stage, 'drafts')} />
      <DownloadSummaryStatistic status="approved" title="待投递" value={stageMetric(stage, 'approved')} />
    </div>
    <StageIndexState stage={stage} />
    <div className="path-strip" title={stage.candidateRoot}>候选目录 · {stage.candidateRoot || '尚未配置'}</div>
    {!stage.enabled ? <Button block disabled>工作流已停用</Button> : directoryReady === false ? <Link to="/settings"><Button block type="primary">检查系统设置</Button></Link> : <Link to={`/review/${stage.id}`}><Button block type="primary">进入 {stage.id} 审核</Button></Link>}
  </Card>;
}

function StageCard({ stage }: { stage: PipelineStage }) {
  return <Card className="stage-card" title={<div><Space><span className="mono-badge">{stage.id}</span>{workflowLabel(stage)}</Space><Text type="secondary" className="stage-card-subtitle">{stage.displayName}</Text></div>} extra={stage.reviewEnabled ? <Tag color="cyan">人工审核</Tag> : <Tag>终端阶段</Tag>}>
    <Paragraph type="secondary" ellipsis={{ rows: 1 }}>{stage.description}</Paragraph>
    <Row gutter={12}>
      <Col span={8}><Statistic title="待审核" value={stageMetric(stage, 'pending')} /></Col>
      <Col span={8}><Statistic title="草稿" value={stageMetric(stage, 'drafts')} /></Col>
      <Col span={8}><Statistic title={stage.reviewEnabled ? '待投递' : '队列'} value={stageMetric(stage, stage.reviewEnabled ? 'approved' : 'queue')} /></Col>
    </Row>
    <StageIndexState stage={stage} />
    <div className="path-strip" title={stage.candidateRoot || stage.inputQueueRoot}>{stage.candidateRoot || stage.inputQueueRoot || stage.outputRoot}</div>
    {stage.reviewEnabled ? <Link to={`/review/${stage.id}`}><Button block type="primary">进入审核</Button></Link> : <Button block disabled>无需人工审核</Button>}
  </Card>;
}

function StageIndexState({ stage }: { stage: PipelineStage }) {
  const suffix = stageIndexSuffix(stage);
  return <div className={`stage-index-state is-${stageIndexStatus(stage).toLowerCase()}${suffix ? '' : ' is-empty'}`} aria-hidden={!suffix}>{suffix || '\u00a0'}</div>;
}

type ReviewListView = 'cards' | 'table';

export function uniqueSelectedRelativePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function toggleSelectedRelativePath(paths: readonly string[], path: string): string[] {
  return paths.includes(path) ? paths.filter((item) => item !== path) : [...paths, path];
}

export function appendSelectedRelativePaths(paths: readonly string[], additions: readonly string[]): string[] {
  return uniqueSelectedRelativePaths([...paths, ...additions]);
}

export function moveSelectedRelativePath(paths: readonly string[], path: string, targetIndex: number): string[] {
  const next = uniqueSelectedRelativePaths(paths);
  const sourceIndex = next.indexOf(path);
  if (sourceIndex < 0 || next.length < 2) return next;
  const [item] = next.splice(sourceIndex, 1);
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, item!);
  return next;
}

const DEFAULT_TABLE_REVIEW_STAGE_IDS = new Set(['E000', 'E001', 'E002', 'E003', 'E005', 'E006', 'E007']);

function defaultReviewListView(stageId: string): ReviewListView {
  return DEFAULT_TABLE_REVIEW_STAGE_IDS.has(stageId) ? 'table' : 'cards';
}

function TaskList() {
  const { stageId = '' } = useParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<ReviewListView>(() => defaultReviewListView(stageId));
  const isFixedTableView = stageId === 'E004';
  const effectiveView = isFixedTableView ? 'table' : view;
  useEffect(() => { setView(defaultReviewListView(stageId)); }, [stageId]);
  const params = new URLSearchParams({ page: String(page), pageSize: '24', sort: 'time', order: 'desc' });
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  const stages = useStagesQuery();
  const stage = stages.data?.stages.find((item) => item.id === stageId);
  const deliveryTargets = stage ? resolveStageReviewDeliveryTargets(stage, stages.data?.stages || []) : [];
  const query = useQuery({ queryKey: ['tasks', stageId, search, status, page], queryFn: () => api.tasks(stageId, params), enabled: stage?.enabled === true });
  const rescan = useMutation({ mutationFn: () => api.rescan(stageId), onSuccess: () => { message.success('扫描完成'); void query.refetch(); } });
  if (stages.isLoading) return <Skeleton active />;
  if (!stage?.enabled) return <DisabledStageNotice stageId={stageId} returnTo={isDownloadReviewStage(stage) ? '/review/downloads' : '/'} returnLabel={isDownloadReviewStage(stage) ? '返回下载中心' : '返回流程工作台'} />;
  const breadcrumbItems = isDownloadReviewStage(stage)
    ? [{ title: <Link to="/">审核工作台</Link> }, { title: <Link to="/review/downloads">下载中心</Link> }, { title: `${workflowLabel(stage)} 待审核` }]
    : [{ title: <Link to="/">审核工作台</Link> }, { title: `${workflowLabel(stage)} 待审核` }];
  return <div className="page-stack">
    <Breadcrumb items={breadcrumbItems} />
    <PageTitle eyebrow={stage?.workflowName || stageId} title={stage ? workflowLabel(stage) : '待审核产品'} description={`${stage?.displayName || ''}${stage?.candidateRoot ? ` · ${stage.candidateRoot}` : ''}`} meta={<DeliveryTargetStrip targets={deliveryTargets} />} extra={<Button icon={<ReloadOutlined />} loading={rescan.isPending} onClick={() => rescan.mutate()}>重新扫描</Button>} />
    <Card className="filter-bar"><Flex gap={12} wrap>
      <Input allowClear prefix={<SearchOutlined />} placeholder="搜索产品文件夹" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="search-input" />
      <Select allowClear placeholder="全部状态" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={Object.entries(statusMeta).map(([value, meta]) => ({ value, label: meta.label }))} />
      {!isFixedTableView && <Radio.Group value={view} onChange={(event) => setView(event.target.value)} optionType="button" options={[{ label: '卡片', value: 'cards' }, { label: '表格', value: 'table' }]} />}
      <Text type="secondary">共 {query.data?.total || 0} 个产品</Text>
    </Flex></Card>
    {query.isLoading ? <Skeleton active /> : !query.data?.items.length ? <Empty description="当前目录没有可审核的产品文件夹" /> : effectiveView === 'cards' ? <Row gutter={[16, 16]}>{query.data.items.map((task) => <Col xs={24} md={12} xl={8} key={task.taskId}><ProductCard task={task} /></Col>)}</Row> : <TaskTable tasks={query.data.items} />}
    <Pagination current={page} pageSize={24} total={query.data?.total || 0} showSizeChanger={false} onChange={setPage} />
  </div>;
}

function ProductCard({ task }: { task: ProductTask }) {
  const meta = statusMeta[task.status] ?? { label: '待审核', color: 'default' };
  const representatives = task.representativeMedia || task.representativeImages.map((relativePath) => ({ relativePath, mediaType: 'image' as const }));
  return <Card className="product-card" cover={<div className="contact-sheet-mini">
    {representatives.map((media) => media.mediaType === 'video' ? <div className="image-placeholder video-placeholder" key={media.relativePath}><VideoCameraOutlined /><small>视频</small></div> : <img key={media.relativePath} loading="lazy" src={api.thumbnailUrl(task.taskId, media.relativePath)} alt={media.relativePath} />)}
    {Array.from({ length: Math.max(0, 4 - representatives.length) }).map((_, index) => <div className="image-placeholder" key={index}><PictureOutlined /></div>)}
  </div>}>
    <Flex justify="space-between" align="start" gap={8}><Title level={5} ellipsis={{ tooltip: task.sourceFolderName }}>{task.sourceFolderName}</Title><Tag color={meta.color}>{meta.label}</Tag></Flex>
    <Space size="large"><Text type="secondary">{task.imageCount} 图{task.videoCount ? ` · ${task.videoCount} 视频` : ''}</Text><Text type="secondary">{task.subfolderCount} 个子目录</Text></Space>
    <Text className="modified-time" type="secondary"><ClockCircleOutlined /> {dayjs(task.lastModifiedAt).format('YYYY-MM-DD HH:mm')}</Text>
    <Link to={`/task/${task.taskId}`}><Button type="primary" block>{task.status === 'DRAFT' ? '继续草稿' : '进入审核'}</Button></Link>
  </Card>;
}

function TaskTable({ tasks }: { tasks: ProductTask[] }) {
  return <Table className="task-table" rowKey="taskId" pagination={false} dataSource={tasks} scroll={{ x: 760 }} columns={[
    { title: '产品文件夹', dataIndex: 'sourceFolderName', width: 260, render: (value, record) => <Link to={`/task/${record.taskId}`}>{value}</Link> },
    { title: '状态', dataIndex: 'status', width: 110, render: (value) => <Tag color={statusMeta[value]?.color}>{statusMeta[value]?.label || value}</Tag> },
    { title: '媒体', width: 120, render: (_, record) => `${record.imageCount} 图${record.videoCount ? ` / ${record.videoCount} 视频` : ''}` }, { title: '子目录', dataIndex: 'subfolderCount', width: 90 },
    { title: '最后修改', dataIndex: 'lastModifiedAt', width: 150, render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm') },
    { title: '操作', width: 100, render: (_, record) => <Link to={`/task/${record.taskId}`}>{record.status === 'DRAFT' ? '继续草稿' : '进入审核'}</Link> }
  ]} />;
}

function ReviewDetail() {
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId) });
  const stages = useStagesQuery();
  const task = query.data;
  const publishingConfig = useQuery({
    queryKey: ['config'],
    queryFn: api.config,
    enabled: Boolean(task && (task.stageId === 'E004' || task.stageId === 'E005')),
    retry: false
  });
  const wbColors = useQuery({
    queryKey: ['wb-dictionary', 'colors'],
    queryFn: () => api.wbDictionary('colors', '', 1_000),
    enabled: task?.stageId === 'E001',
    retry: false,
    staleTime: 10 * 60_000
  });
  const ozonColors = useQuery({
    queryKey: ['ozon-catalog-dictionary', 'colors', 1494, 'e001'],
    queryFn: () => api.ozonCatalogDictionary('colors', 1494, '', 2_000),
    enabled: task?.stageId === 'E001',
    retry: false,
    staleTime: 10 * 60_000
  });
  const [folder, setFolder] = useState('');
  const [selectedRelativePaths, setSelectedRelativePaths] = useState<string[]>([]);
  const [variantGroups, setVariantGroups] = useState<VariantSelectionGroup[]>([]);
  const [activeVariantGroupId, setActiveVariantGroupId] = useState<string>();
  const [targets, setTargets] = useState<string[]>([]);
  const [approveOpen, setApproveOpen] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [previewSource, setPreviewSource] = useState<'folder' | 'selection'>('folder');
  const [draggedSelectionPath, setDraggedSelectionPath] = useState<string>();
  const [dragOverSelectionPath, setDragOverSelectionPath] = useState<string>();
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductSku, setSelectedProductSku] = useState<string>();
  const initializedTaskId = useRef<string>();
  const productSearchParams = useMemo(() => {
    const params = new URLSearchParams({ page: '1', pageSize: '20' });
    if (productSearch.trim()) params.set('query', productSearch.trim());
    return params;
  }, [productSearch]);
  const productCandidates = useQuery({
    queryKey: ['task-product-candidates', taskId, productSearchParams.toString()],
    queryFn: () => api.purchases(productSearchParams),
    enabled: Boolean(task && ['UNRESOLVED', 'AMBIGUOUS'].includes(task.productIdentity.status)),
    retry: false
  });
  const assignProductIdentity = useMutation({
    mutationFn: (sku: string) => api.assignProductIdentity(taskId, sku),
    onSuccess: async () => { message.success('产品身份已关联'); setSelectedProductSku(undefined); await client.invalidateQueries({ queryKey: ['task', taskId] }); },
    onError: (error) => message.error(error.message)
  });
  useEffect(() => {
    if (task && initializedTaskId.current !== task.taskId) {
      setSelectedRelativePaths(uniqueSelectedRelativePaths(task.selectedRelativePaths));
      const groups = task.stageId === 'E001' ? task.variantSelectionGroups?.length ? task.variantSelectionGroups : [{ groupId: crypto.randomUUID(), variantName: '', selectedRelativePaths: [] }] : [];
      setVariantGroups(groups);
      setActiveVariantGroupId(groups[0]?.groupId);
      setTargets(task.selectedTargetStageIds);
      setFolder(task.tree[0]?.key || '');
      setPreview(undefined);
      setPreviewSource('folder');
      setDraggedSelectionPath(undefined);
      setDragOverSelectionPath(undefined);
      initializedTaskId.current = task.taskId;
    }
  }, [task]);
  useEffect(() => {
    if (task?.stageId !== 'E001' || !ozonColors.data?.items.length) return;
    setVariantGroups((current) => reconcileVariantOzonColors(current, task.productIdentity.variantDetails || [], ozonColors.data.items));
  }, [ozonColors.data?.items, task?.stageId, task?.productIdentity.variantDetails]);
  const images = useMemo(() => task?.images.filter((item) => item.directory === folder) || [], [task, folder]);
  const isVariantSplit = task?.stageId === 'E001';
  const isE003OrderedSelection = task?.stageId === 'E003' || task?.stageId === 'E000';
  const isTerminalDelivery = task?.stageId === 'E004' || task?.stageId === 'E005';
  const activeVariantGroup = variantGroups.find((group) => group.groupId === activeVariantGroupId) || variantGroups[0];
  const activeSelectedRelativePaths = isVariantSplit ? activeVariantGroup?.selectedRelativePaths || [] : selectedRelativePaths;
  const activeSelection = new Set(activeSelectedRelativePaths);
  const allSelectedRelativePaths = isVariantSplit ? uniqueSelectedRelativePaths(variantGroups.flatMap((group) => group.selectedRelativePaths)) : selectedRelativePaths;
  const allSelected = new Set(allSelectedRelativePaths);
  const selectedMediaByPath = new Map(task?.images.map((item) => [item.relativePath, item]) || []);
  const selectedImages = isE003OrderedSelection
    ? activeSelectedRelativePaths.map((relativePath) => selectedMediaByPath.get(relativePath)).filter((item): item is NonNullable<typeof item> => Boolean(item))
    : task?.images.filter((item) => activeSelection.has(item.relativePath)) || [];
  const selectedImageCount = selectedImages.filter((item) => item.mediaType === 'image').length;
  const selectedVideoCount = selectedImages.length - selectedImageCount;
  const stage = stages.data?.stages.find((item) => item.id === task?.stageId);
  const ozonReadiness = publishingConfig.data?.ozonPublishingReadiness;
  const ozonMediaState = resolveOzonSharedMediaReadiness(ozonReadiness);
  const ozonOutputTemplateIssue = stage?.ozonOutputRoot ? validateOzonOutputTemplate(stage.ozonOutputRoot) : undefined;
  const availableTargets = (stage?.targets || []).filter((target) => stages.data?.stages.some((candidate) => candidate.id === target.targetStageId && candidate.enabled));
  const terminalTargetOptions = isTerminalDelivery ? [
    {
      id: 'WB_SHARED_MEDIA',
      label: 'WB 共享媒体库',
      enabled: Boolean(stage?.outputRoot && !validateWbOutputTemplate(stage.outputRoot)),
      reason: stage?.outputRoot ? undefined : '尚未配置 WB 共享媒体输出目录模板'
    },
    {
      id: 'OZON_SHARED_MEDIA',
      label: 'OZON 共享媒体库',
      enabled: Boolean(stage?.ozonOutputRoot && !ozonOutputTemplateIssue && ozonMediaState.ready),
      reason: !stage?.ozonOutputRoot ? '尚未配置 OZON 共享媒体输出目录模板' : ozonOutputTemplateIssue || (publishingConfig.isLoading ? '正在检查 OZON 共享媒体目录' : ozonMediaState.reason)
    }
  ] : [];
  const availableTargetIds = new Set(isTerminalDelivery ? terminalTargetOptions.filter((target) => target.enabled).map((target) => target.id) : availableTargets.map((target) => target.targetStageId));
  const activeTargets = targets.filter((targetStageId) => availableTargetIds.has(targetStageId));
  const identityResolved = task?.productIdentity.status === 'RESOLVED';
  const approveDisabledReason = !identityResolved ? task?.productIdentity.message || '请先关联采购 SKU' : isVariantSplit && wbColors.isError ? '本地 WB 颜色字典不可用，请先同步目录' : isTerminalDelivery && !terminalTargetOptions.some((target) => target.enabled) ? 'WB 和 OZON 均未达到可投递状态' : !isTerminalDelivery && !availableTargets.length ? '没有已启用的目标流程' : undefined;
  const identityOptions = useMemo(() => {
    const options = [...(task?.productIdentity.candidates || []), ...(productCandidates.data?.items || []).map((item) => ({ sku: item.sku, productName: item.productName }))];
    return [...new Map(options.map((item) => [item.sku, item])).values()].map((item) => ({ value: item.sku, label: `${item.sku} · ${item.productName}` }));
  }, [productCandidates.data?.items, task?.productIdentity.candidates]);
  const save = useMutation({ mutationFn: () => api.saveDraft(taskId, allSelectedRelativePaths, activeTargets, isVariantSplit ? variantGroups : undefined), onSuccess: () => { message.success('草稿已保存'); void client.invalidateQueries({ queryKey: ['task', taskId] }); } });
  const approve = useMutation({ mutationFn: () => api.approve(taskId, allSelectedRelativePaths, activeTargets, isVariantSplit ? variantGroups : undefined), onSuccess: (result: any) => { const partial = result?.deliverySummary?.status === 'PARTIAL'; message[partial ? 'warning' : 'success'](isTerminalDelivery ? partial ? '审核通过，部分平台投递失败，可在历史记录中重试' : '已投递到所选共享媒体库' : '已加入待投递清单'); navigate(isTerminalDelivery ? '/history' : '/pending'); }, onError: (error) => message.error(error.message) });
  const updateActiveSelection = (update: (current: string[]) => string[]) => {
    if (!isVariantSplit) return setSelectedRelativePaths((current) => uniqueSelectedRelativePaths(update(current)));
    if (!activeVariantGroup) return;
    setVariantGroups((current) => current.map((group) => group.groupId === activeVariantGroup.groupId ? { ...group, selectedRelativePaths: uniqueSelectedRelativePaths(update(group.selectedRelativePaths)) } : group));
  };
  const toggle = (path: string) => updateActiveSelection((current) => toggleSelectedRelativePath(current, path));
  const selectFolder = () => updateActiveSelection((current) => appendSelectedRelativePaths(current, images.map((item) => item.relativePath)));
  const clearFolder = () => { const folderPaths = new Set(images.map((item) => item.relativePath)); updateActiveSelection((current) => current.filter((item) => !folderPaths.has(item))); };
  const previewItems = previewSource === 'selection' && isE003OrderedSelection ? selectedImages : images;
  const openFolderPreview = (path: string) => { setPreviewSource('folder'); setPreview(path); };
  const openSelectedPreview = (path: string) => { setPreviewSource('selection'); setPreview(path); };
  const moveE003Selection = (path: string, targetIndex: number) => {
    if (!isE003OrderedSelection) return;
    setSelectedRelativePaths((current) => moveSelectedRelativePath(current, path, targetIndex));
  };
  const openApproval = () => {
    if (!allSelected.size) return message.warning('至少选择一个媒体文件');
    const imagePaths = new Set(task?.images.filter((item) => item.mediaType === 'image').map((item) => item.relativePath) || []);
    const groupError = isVariantSplit ? validateVariantGroupsForApproval(variantGroups, imagePaths) : undefined;
    if (groupError) {
      if (groupError.imageLimitExceeded && groupError.groupId) setActiveVariantGroupId(groupError.groupId);
      return groupError.imageLimitExceeded ? message.error(groupError.message) : message.warning(groupError.message);
    }
    if (isTerminalDelivery && !activeTargets.length) setTargets(terminalTargetOptions.filter((target) => target.enabled).map((target) => target.id));
    else if (!isTerminalDelivery && !activeTargets.length && availableTargets.length === 1) setTargets([availableTargets[0]!.targetStageId]);
    setApproveOpen(true);
  };
  const navigatePreview = (direction: -1 | 1) => {
    if (!preview || previewItems.length < 2) return;
    const index = previewItems.findIndex((item) => item.relativePath === preview);
    if (index < 0) return;
    const next = previewItems[(index + direction + previewItems.length) % previewItems.length];
    if (next) setPreview(next.relativePath);
  };
  const togglePreviewSelection = () => {
    if (!preview) return;
    if (previewSource !== 'selection' || !isE003OrderedSelection || !activeSelection.has(preview)) return toggle(preview);
    const index = previewItems.findIndex((item) => item.relativePath === preview);
    const next = previewItems.length > 1 ? previewItems[(index + 1) % previewItems.length]?.relativePath : undefined;
    toggle(preview);
    setPreview(next);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement)?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') { event.preventDefault(); save.mutate(); }
      if (event.key.toLocaleLowerCase() === 'a' && !event.shiftKey) { event.preventDefault(); selectFolder(); }
      if (event.key.toLocaleLowerCase() === 'a' && event.shiftKey) { event.preventDefault(); clearFolder(); }
      if (event.key === 'Escape') setPreview(undefined);
      if (preview && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        navigatePreview(event.key === 'ArrowRight' ? 1 : -1);
      }
      if (preview && event.code === 'Space') { event.preventDefault(); togglePreviewSelection(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  if (query.isError) return <DisabledStageNotice description={query.error.message} />;
  if (query.isLoading || !task) return <Skeleton active />;
  const treeData = toAntTree(task.tree);
  return <div className="review-page">
    <div className="review-toolbar">
      <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/review/${task.stageId}`)}>返回列表</Button>
      <div className="review-title"><strong>{task.sourceFolderName}</strong><span>{allSelected.size} / {task.mediaCount || task.imageCount} 已选择{isVariantSplit ? ` · ${variantGroups.length} 个变体组` : ''}</span></div>
      <Space><Button icon={<SaveOutlined />} loading={save.isPending} onClick={() => save.mutate()}>保存草稿</Button><Tooltip title={approveDisabledReason}><Button disabled={Boolean(approveDisabledReason)} type="primary" icon={<CheckCircleOutlined />} onClick={openApproval}>审核通过</Button></Tooltip></Space>
    </div>
    <section className={`product-identity-strip status-${task.productIdentity.status.toLocaleLowerCase()}`} aria-label="产品身份">
      <div className="product-identity-copy"><span>产品身份</span>{identityResolved ? <><strong><span className="mono-badge">{task.productIdentity.sku}</span>{task.productIdentity.productName}</strong><Text type="secondary">已从 PostgreSQL 校验 · {productIdentitySourceLabel(task.productIdentity.source)}{task.taskContext?.variants ? ` · 当前变体 ${task.taskContext.variants}` : ''}</Text></> : <><strong>{task.productIdentity.status === 'DATABASE_UNAVAILABLE' ? '数据库暂不可用' : task.productIdentity.status === 'AMBIGUOUS' ? '需要确认采购 SKU' : '尚未识别采购 SKU'}</strong><Text type="secondary">{task.productIdentity.message}</Text></>}</div>
      {!identityResolved && task.productIdentity.status !== 'DATABASE_UNAVAILABLE' && <div className="product-identity-picker"><Select showSearch filterOption={false} aria-label="选择采购 SKU" placeholder="搜索 SKU 或数据库产品名" value={selectedProductSku} onSearch={setProductSearch} onChange={setSelectedProductSku} loading={productCandidates.isFetching} options={identityOptions} notFoundContent={productCandidates.isFetching ? '正在查询…' : '没有匹配的采购记录'} /><Button type="primary" loading={assignProductIdentity.isPending} disabled={!selectedProductSku} onClick={() => selectedProductSku && assignProductIdentity.mutate(selectedProductSku)}>确认关联</Button></div>}
    </section>
    <div className={`review-workbench${isVariantSplit ? ' is-variant-split' : ''}`}>
      <aside className="folder-pane"><div className="pane-heading">媒体目录 <Tag>{task.subfolderCount + (task.images.some((item) => !item.directory) ? 1 : 0)}</Tag></div><Tree selectedKeys={[folder]} defaultExpandAll treeData={treeData} onSelect={(keys) => setFolder(String(keys[0] ?? ''))} /></aside>
      <main className="image-pane">
        <Flex justify="space-between" align="center" className="pane-heading"><span>{folder || '根目录'} <Tag>{images.length} 个媒体</Tag></span><Space><Button size="small" onClick={selectFolder}>当前目录全选</Button><Button size="small" onClick={clearFolder}>清空当前目录</Button></Space></Flex>
        {!images.length ? <Empty description="此目录没有可审核媒体" /> : <div className="contact-sheet-grid">{images.map((image) => <button type="button" aria-label={`选择媒体 ${image.fileName}`} key={image.relativePath} className={`contact-cell ${activeSelection.has(image.relativePath) ? 'selected' : ''}`} onClick={() => toggle(image.relativePath)}>
          {image.mediaType === 'video' ? <video muted preload="metadata" src={api.originalUrl(taskId, image.relativePath)} /> : <img loading="lazy" src={api.thumbnailUrl(taskId, image.relativePath)} alt={image.fileName} />}
          <span className="cell-check"><Checkbox checked={activeSelection.has(image.relativePath)} /></span>
          <span className="cell-meta"><b title={image.fileName}>{image.fileName}</b><small>{formatBytes(image.sizeBytes)}</small></span>
          <span className="cell-preview" onClick={(event) => { event.stopPropagation(); openFolderPreview(image.relativePath); }}><EyeOutlined /></span>
        </button>)}</div>}
      </main>
      <aside className={`selection-pane${isVariantSplit ? ' variant-selection-pane' : ''}`}>
        {isVariantSplit && <div className="variant-group-rail"><Flex justify="space-between" align="center"><strong>变体组选图</strong><Button size="small" icon={<PlusOutlined />} onClick={() => { const group = { groupId: crypto.randomUUID(), variantName: '', selectedRelativePaths: [] }; setVariantGroups((current) => [...current, group]); setActiveVariantGroupId(group.groupId); }}>新增</Button></Flex>{variantGroups.map((group, index) => <button type="button" key={group.groupId} className={`variant-group-tab${group.groupId === activeVariantGroup?.groupId ? ' is-active' : ''}`} onClick={() => setActiveVariantGroupId(group.groupId)}><span className="variant-group-tab-main"><span className="variant-group-tab-name">{group.variantName || `未命名变体 ${index + 1}`}</span><E001VariantGroupStatus group={group} /></span><em>{group.selectedRelativePaths.length}图</em></button>)}</div>}
        <Flex justify="space-between" align="center" className="pane-heading"><div className="selection-pane-title"><span>{isVariantSplit ? '当前变体' : '已选媒体'}</span><span className="selected-image-count" aria-live="polite" aria-atomic="true">已选 <strong>{selectedImageCount}</strong> 张{selectedVideoCount ? <small> · {selectedVideoCount} 个视频</small> : null}</span></div><Button danger type="text" size="small" onClick={() => updateActiveSelection(() => [])}>全部清空</Button></Flex>
        {isVariantSplit && activeVariantGroup && <E001VariantColorPassport
          group={activeVariantGroup}
          groups={variantGroups}
          wbItems={wbColors.data?.items || []}
          wbLoading={wbColors.isLoading}
          wbError={wbColors.isError}
          ozonItems={ozonColors.data?.items || []}
          ozonCatalog={{ loading: ozonColors.isLoading, error: ozonColors.isError, stale: Boolean(ozonColors.data?.catalog.isStale) }}
          onChange={setVariantGroups}
          canDelete={variantGroups.length > 1}
          onDelete={() => { const next = variantGroups.filter((group) => group.groupId !== activeVariantGroup.groupId); setVariantGroups(next); setActiveVariantGroupId(next[0]?.groupId); }}
        />}
        <div className={`selection-list${isE003OrderedSelection ? ' is-ordered' : ''}`}>{selectedImages.map((image, index) => <div
          className={`selected-row${isE003OrderedSelection ? ' is-sortable' : ''}${draggedSelectionPath === image.relativePath ? ' is-dragging' : ''}${dragOverSelectionPath === image.relativePath && draggedSelectionPath !== image.relativePath ? ' is-drag-over' : ''}`}
          key={image.relativePath}
          onClick={isE003OrderedSelection ? () => openSelectedPreview(image.relativePath) : undefined}
          onDragStart={isE003OrderedSelection ? (event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', image.relativePath);
            setDraggedSelectionPath(image.relativePath);
          } : undefined}
          onDragOver={isE003OrderedSelection ? (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDragOverSelectionPath(image.relativePath);
          } : undefined}
          onDrop={isE003OrderedSelection ? (event) => {
            event.preventDefault();
            const sourcePath = event.dataTransfer.getData('text/plain') || draggedSelectionPath;
            if (sourcePath) moveE003Selection(sourcePath, index);
            setDraggedSelectionPath(undefined);
            setDragOverSelectionPath(undefined);
          } : undefined}
          onDragEnd={isE003OrderedSelection ? () => { setDraggedSelectionPath(undefined); setDragOverSelectionPath(undefined); } : undefined}
        >
          {isE003OrderedSelection && <span className="selected-row-sequence" aria-hidden="true">{index + 1}</span>}
          {isE003OrderedSelection ? <button type="button" className="selected-media-preview" aria-label={`预览已选媒体 ${index + 1}：${image.fileName}`} onClick={(event) => { event.stopPropagation(); openSelectedPreview(image.relativePath); }}>
            {image.mediaType === 'video' ? <span className="selected-video-icon"><VideoCameraOutlined /></span> : <img draggable={false} src={api.thumbnailUrl(taskId, image.relativePath)} alt={image.fileName} />}
          </button> : image.mediaType === 'video' ? <span className="selected-video-icon"><VideoCameraOutlined /></span> : <img src={api.thumbnailUrl(taskId, image.relativePath)} alt="" />}
          <div className="selected-row-main">
            <span className="selected-row-path" title={image.relativePath}>{image.relativePath}</span>
            {isE003OrderedSelection && <div className="selected-row-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              <span className="selected-drag-handle" draggable title="拖拽调整顺序" aria-hidden="true"><HolderOutlined /></span>
              <Button type="text" size="small" disabled={index === 0} icon={<VerticalAlignTopOutlined />} aria-label={`将第 ${index + 1} 项置顶`} onClick={() => moveE003Selection(image.relativePath, 0)}>置顶</Button>
              <Button type="text" size="small" disabled={index === 0} icon={<ArrowUpOutlined />} aria-label={`将第 ${index + 1} 项上移`} onClick={() => moveE003Selection(image.relativePath, index - 1)} />
              <Button type="text" size="small" disabled={index === selectedImages.length - 1} icon={<ArrowDownOutlined />} aria-label={`将第 ${index + 1} 项下移`} onClick={() => moveE003Selection(image.relativePath, index + 1)} />
              <Button type="text" danger size="small" icon={<DeleteOutlined />} aria-label={`移除第 ${index + 1} 项`} onClick={() => toggle(image.relativePath)} />
            </div>}
          </div>
          {!isE003OrderedSelection && <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => toggle(image.relativePath)} />}
        </div>)}</div>
      </aside>
    </div>
    <Modal open={approveOpen} title="确认审核通过" okText={isTerminalDelivery ? '审核并投递' : '加入待投递清单'} cancelText="继续检查" confirmLoading={approve.isPending} onCancel={() => setApproveOpen(false)} onOk={() => { if (!activeTargets.length) return message.warning(isTerminalDelivery ? '至少选择一个可用平台' : '至少选择一个目标阶段'); approve.mutate(); }}>
      <Alert type="info" showIcon message={`已选择 ${allSelected.size} 个媒体${isVariantSplit ? `，分为 ${variantGroups.length} 个变体组` : ''}`} description={isTerminalDelivery ? '审核通过后将立即投递到下方选中的平台目录；各平台独立记录结果。' : '此操作只加入待投递清单，不会立即启动 n8n。'} />
      <Descriptions size="small" column={1} items={[{ key: 'sku', label: '产品 SKU', children: task.productIdentity.sku }, { key: 'name', label: '数据库产品名', children: task.productIdentity.productName }]} />
      {isVariantSplit && <div className="variant-approval-list">{variantGroups.map((group) => <div className="variant-approval-row" key={group.groupId}>
        <strong>{group.variantName || '未命名变体'}</strong>
        <span><b>WB</b>{group.wbColor ? `${group.wbColor.nameZh} / ${group.wbColor.nameRu}` : '未设置'}<em>{group.wbColor ? '已设置' : '必填'}</em></span>
        <span><b>OZON</b>{group.ozonColor ? `${group.ozonColor.nameZh} / ${group.ozonColor.nameRu}` : '未设置'}<em>{group.ozonColor ? group.ozonColor.source === 'AUTO_EXACT_RU' ? '自动匹配' : '人工选择' : '选填'}</em></span>
        <small>{group.selectedRelativePaths.length} 个媒体</small>
      </div>)}</div>}
      {isTerminalDelivery ? <><Title level={5}>投递平台</Title><Space direction="vertical">{terminalTargetOptions.map((target) => <div key={target.id}><Checkbox disabled={!target.enabled} checked={targets.includes(target.id)} onChange={(event) => setTargets((current) => event.target.checked ? [...new Set([...current, target.id])] : current.filter((item) => item !== target.id))}>{target.label}</Checkbox>{!target.enabled && <Text type="secondary"> · {target.reason}</Text>}</div>)}</Space></> : <><Title level={5}>投递目标</Title><Space direction="vertical">{availableTargets.map((target) => { const targetStage = stages.data?.stages.find((item) => item.id === target.targetStageId); return <Checkbox key={target.targetStageId} checked={targets.includes(target.targetStageId)} onChange={(event) => setTargets((current) => event.target.checked ? [...new Set([...current, target.targetStageId])] : current.filter((item) => item !== target.targetStageId))}>{workflowLabel(targetStage)} · {targetStage?.displayName}</Checkbox>; })}</Space></>}
    </Modal>
    <Modal className="preview-modal" width="min(94vw, 1400px)" open={Boolean(preview)} footer={null} onCancel={() => setPreview(undefined)} title={preview}>
      {preview && <div className="preview-stage">
        <div className="preview-media">
          <button
            type="button"
            className="preview-nav preview-nav-previous"
            aria-label="上一张图片"
            disabled={previewItems.length < 2}
            onKeyDown={(event) => { if (event.code === 'Space') event.preventDefault(); }}
            onClick={(event) => { event.stopPropagation(); navigatePreview(-1); }}
          >
            <span className="preview-nav-icon" aria-hidden="true"><ArrowLeftOutlined /></span>
          </button>
          {task.images.find((item) => item.relativePath === preview)?.mediaType === 'video' ? <video className="preview-video" controls autoPlay src={api.originalUrl(taskId, preview)} /> : <Image preview={false} src={api.originalUrl(taskId, preview)} />}
          <button
            type="button"
            className="preview-nav preview-nav-next"
            aria-label="下一张图片"
            disabled={previewItems.length < 2}
            onKeyDown={(event) => { if (event.code === 'Space') event.preventDefault(); }}
            onClick={(event) => { event.stopPropagation(); navigatePreview(1); }}
          >
            <span className="preview-nav-icon" aria-hidden="true"><ArrowRightOutlined /></span>
          </button>
        </div>
        <div className="preview-actions"><Text className="preview-shortcuts" type="secondary">← / → 切换 · Space 选择 · Esc 关闭</Text><Button className="preview-select-action" onClick={togglePreviewSelection}>{activeSelection.has(preview) ? '取消选择' : '选择此图'}</Button></div>
      </div>}
    </Modal>
  </div>;
}

function PendingPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['pending'], queryFn: api.pending });
  const workflowShortcuts = useWorkflowShortcutData();
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [policy, setPolicy] = useState<'skip' | 'new-revision'>('new-revision');
  const [parameterRecord, setParameterRecord] = useState<PendingView>();
  const [parameterDraftRows, setParameterDraftRows] = useState<WorkflowParameterDraftRow[]>([]);
  const submit = useMutation({
    mutationFn: () => api.submitBatch(`BATCH-${crypto.randomUUID()}`, selected.map(String), policy),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['pending'] }); void client.invalidateQueries({ queryKey: ['history'] }); }
  });
  const remove = useMutation({ mutationFn: api.deletePending, onSuccess: () => void client.invalidateQueries({ queryKey: ['pending'] }) });
  const parameterDefaults = useQuery({ queryKey: ['workflow-parameters', parameterRecord?.targetStageId], queryFn: () => api.workflowParameters(parameterRecord!.targetStageId), enabled: Boolean(parameterRecord) });
  const saveParameters = useMutation({
    mutationFn: ({ parameters, parameterOptions }: { parameters: WorkflowParameters; parameterOptions: WorkflowParameterOptions }) => api.updatePending(parameterRecord!.id, { n8nTaskParameters: parameters, n8nTaskParameterOptions: parameterOptions }),
    onSuccess: () => { message.success('n8n 任务配置已保存'); setParameterRecord(undefined); void client.invalidateQueries({ queryKey: ['pending'] }); },
    onError: (error) => message.error(error.message)
  });
  const savePendingParameters = () => {
    const parsed = parseWorkflowParameterRows(parameterDraftRows);
    if (!parsed.parameters || !parsed.parameterOptions) {
      setParameterDraftRows((current) => current.map((row) => ({ ...row, error: parsed.errors[row.id] })));
      message.error('请修正任务参数中的类型或格式错误');
      return;
    }
    saveParameters.mutate({ parameters: parsed.parameters, parameterOptions: parsed.parameterOptions });
  };
  const items = query.data?.items || [];
  const enabledItems = items.filter((item) => !item.disabledReason && item.status !== 'PACKAGING');
  useEffect(() => {
    const enabledIds = new Set(enabledItems.map((item) => item.id));
    setSelected((current) => current.filter((key) => enabledIds.has(String(key))));
  }, [query.data]);
  const targetStage = workflowShortcuts.stageDefinitions.find((stage) => stage.id === parameterRecord?.targetStageId);
  const columns = [
    { title: '产品身份', dataIndex: 'sourceFolderName', render: (value: string, record: PendingView) => <Space direction="vertical" size={1}><strong>{record.productNameSnapshot || '未关联数据库产品'}</strong><Space size={6}>{record.productSku && <span className="mono-badge">{record.productSku}</span>}<Text type="secondary" className="mono-small">原目录：{value}</Text></Space></Space> },
    { title: '产品变体', dataIndex: 'variantName', render: (value?: string) => value ? <Tag color="geekblue">{value}</Tag> : <Tag>默认变体</Tag> },
    { title: '流向', render: (_: unknown, record: PendingView) => <Space wrap><Tag>{workflowLabel(workflowShortcuts.stageDefinitions.find((stage) => stage.id === record.sourceStageId), record.sourceStageId)}</Tag><span>→</span><Tag color="cyan">{workflowLabel(workflowShortcuts.stageDefinitions.find((stage) => stage.id === record.targetStageId), record.targetStageId)}</Tag>{record.disabledReason && <Tooltip title={record.disabledReason}><Tag color="red">不可投递</Tag></Tooltip>}</Space> },
    { title: '已选', dataIndex: 'selectedRelativePaths', render: (value: string[]) => `${value.length} 张` },
    { title: '审核时间', dataIndex: 'approvedAt', render: (value?: string) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—' },
    { title: '冲突策略', dataIndex: 'conflictPolicy', render: (value: string) => value === 'skip' ? '跳过' : '创建修订版本' },
    { title: '状态', dataIndex: 'status', render: (value: string, record: PendingView) => <Tooltip title={record.lastError}><Tag color={value === 'FAILED' ? 'red' : value === 'PACKAGING' ? 'processing' : 'default'}>{value}</Tag></Tooltip> },
    { title: '操作', render: (_: unknown, record: PendingView) => <Space wrap><Button type="link" icon={<SettingOutlined />} disabled={record.status === 'PACKAGING'} onClick={() => { setParameterRecord(record); setParameterDraftRows(workflowParameterRows(structuredClone(record.n8nTaskParameters), structuredClone(record.n8nTaskParameterOptions || {}))); }}>n8n任务配置</Button>{record.sourceStageEnabled ? <Link to={`/task/${record.taskId}`}>返回修改</Link> : <Tooltip title={record.disabledReason}><Button type="link" disabled>返回修改</Button></Tooltip>}<Button danger type="link" onClick={() => remove.mutate(record.id)}>移出</Button></Space> }
  ];
  return <div className="page-stack">
    <div className="workflow-navigation-intro">
      <PageTitle eyebrow="DELIVERY QUEUE" title="待投递清单" description="审批结果在此集中等待。只有点击批量投递后，系统才会向下一阶段监听目录写入完整任务包。" />
      <WorkflowShortcuts context="pending" data={workflowShortcuts} />
    </div>
    <Card className="batch-toolbar"><Flex justify="space-between" align="center" wrap gap={12}><Space><Text strong>已选择 {selected.length} 项</Text><Select value={policy} onChange={setPolicy} options={[{ value: 'skip', label: '目标重名：跳过' }, { value: 'new-revision', label: '目标重名：创建修订版本' }]} /></Space><Button type="primary" icon={<CloudUploadOutlined />} disabled={!selected.length || submit.isPending} loading={submit.isPending} onClick={() => submit.mutate()}>批量投递</Button></Flex></Card>
    <Table rowKey="id" loading={query.isLoading} dataSource={items} columns={columns} rowClassName={(record) => record.disabledReason ? 'pending-stage-disabled' : ''} rowSelection={{ selectedRowKeys: selected, onChange: setSelected, getCheckboxProps: (record) => ({ disabled: Boolean(record.disabledReason) || record.status === 'PACKAGING', title: record.disabledReason }) }} scroll={{ x: 1180 }} />
    <Modal
      className="task-parameter-modal"
      width={760}
      open={Boolean(parameterRecord)}
      title={`n8n任务配置 · ${targetStage ? workflowLabel(targetStage) : parameterRecord?.targetStageId || ''}`}
      okText="保存任务配置"
      cancelText="取消"
      confirmLoading={saveParameters.isPending}
      onOk={savePendingParameters}
      onCancel={() => setParameterRecord(undefined)}
    >
      {parameterRecord && <div className="pending-parameter-editor">
        <Alert showIcon type="info" message={`参数将投递给目标工作流 ${parameterRecord.targetStageId}`} description={`当前配置与本条记录的 ${parameterRecord.selectedRelativePaths.length} 张选中图片绑定，不影响其他投递记录。`} />
        <Flex justify="space-between" align="center" gap={12} wrap>
          <Text type="secondary">字段名和类型来自系统设置；SKU、产品名与变体由系统写入，其余字段可修改。</Text>
          <Button disabled={!parameterDefaults.data} loading={parameterDefaults.isFetching} onClick={() => { if (parameterDefaults.data) setParameterDraftRows(workflowParameterRows({ ...structuredClone(parameterDefaults.data.parameters), SKU: parameterRecord.productSku || '', productName: parameterRecord.productNameSnapshot || '', ...(parameterRecord.variantName ? { variants: parameterRecord.variantName } : {}) }, structuredClone(parameterDefaults.data.parameterOptions))); }}>重置为当前默认值</Button>
        </Flex>
        {!parameterDraftRows.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="目标工作流尚未定义参数字段" /> : <div className="pending-parameter-grid">
          {parameterDraftRows.map((row) => { const runtime = isWorkflowRuntimeParameter(row.name); return <div key={row.id} className={`pending-parameter-row${runtime ? ' is-system' : ''}${row.error ? ' has-error' : ''}`}><div className="pending-parameter-name"><span>{row.name}</span><Tag className="parameter-type-tag">{workflowParameterTypeOptions.find((option) => option.value === row.type)?.label}</Tag>{runtime && <Tag color="cyan">系统写入</Tag>}</div><div className="parameter-value-cell"><WorkflowParameterValueEditor row={row} disabled={runtime} ariaLabel={`${row.name} 参数值`} onChange={(valueText) => setParameterDraftRows((current) => current.map((item) => item.id === row.id ? { ...item, valueText, error: undefined } : item))} />{row.error && <Text type="danger" className="parameter-field-error">{row.error}</Text>}</div></div>; })}
        </div>}
      </div>}
    </Modal>
  </div>;
}

function HistoryPage() {
  const client = useQueryClient();
  const [skuDraft, setSkuDraft] = useState('');
  const [datePresetDraft, setDatePresetDraft] = useState<SubmissionHistoryDatePreset>('ALL');
  const [customDateRangeDraft, setCustomDateRangeDraft] = useState<SubmissionHistoryDateRange>(null);
  const [appliedFilters, setAppliedFilters] = useState<SubmissionHistoryQuery>({});
  const [appliedDateLabel, setAppliedDateLabel] = useState<string>();
  const [queryRevision, setQueryRevision] = useState(0);
  const [filterError, setFilterError] = useState<string>();
  const query = useQuery({ queryKey: ['history', appliedFilters, queryRevision], queryFn: () => api.history(appliedFilters), retry: false });
  const workflowShortcuts = useWorkflowShortcutData();
  const retry = useMutation({ mutationFn: api.retry, onSuccess: () => { message.success('重试完成'); void client.invalidateQueries({ queryKey: ['history'] }); void client.invalidateQueries({ queryKey: ['pending'] }); }, onError: (error) => message.error(error.message) });
  const applyHistoryFilters = () => {
    const sku = skuDraft.trim();
    if (sku && !/^\d{7}$/.test(sku)) {
      setFilterError('SKU 必须是完整的 7 位数字');
      return;
    }
    if (datePresetDraft === 'CUSTOM' && !customDateRangeDraft) {
      setFilterError('请选择完整的投递日期开始时间和结束时间');
      return;
    }
    const dateBounds = submissionHistoryDateBounds(datePresetDraft, customDateRangeDraft);
    setSkuDraft(sku);
    setFilterError(undefined);
    setAppliedFilters({ ...(sku ? { sku } : {}), ...dateBounds });
    setAppliedDateLabel(submissionHistoryDateLabel(datePresetDraft, customDateRangeDraft));
    setQueryRevision((current) => current + 1);
  };
  const clearHistoryFilters = () => {
    setSkuDraft('');
    setDatePresetDraft('ALL');
    setCustomDateRangeDraft(null);
    setFilterError(undefined);
    setAppliedFilters({});
    setAppliedDateLabel(undefined);
    setQueryRevision((current) => current + 1);
  };
  const hasAppliedFilters = Boolean(appliedFilters.sku || appliedFilters.completedFrom || appliedFilters.completedTo);
  const canClearFilters = Boolean(hasAppliedFilters || skuDraft || datePresetDraft !== 'ALL' || customDateRangeDraft);
  const retryDisabledReason = (sourceStageId: string, targetStageId: string) => {
    if (!workflowShortcuts.stageDefinitions.find((stage) => stage.id === sourceStageId)?.enabled) return `来源流程 ${sourceStageId} 已停用`;
    if (targetStageId !== 'WB_SHARED_MEDIA' && !workflowShortcuts.stageDefinitions.find((stage) => stage.id === targetStageId)?.enabled) return `目标流程 ${targetStageId} 已停用`;
    return undefined;
  };
  return <div className="page-stack"><div className="workflow-navigation-intro">
    <PageTitle eyebrow="AUDIT TRAIL" title="投递历史" description="每个产品和目标阶段各自保留一条记录，部分成功不会掩盖失败环节。" />
    <WorkflowShortcuts context="history" data={workflowShortcuts} />
  </div>
    <Card className="filter-bar history-filter-bar"><Flex gap={12} align="center" wrap>
      <Input
        aria-label="按 SKU 筛选投递历史"
        aria-invalid={Boolean(filterError)}
        className="history-sku-input"
        inputMode="numeric"
        maxLength={7}
        prefix={<SearchOutlined />}
        placeholder="输入 7 位 SKU，例如 0000017"
        status={filterError ? 'error' : undefined}
        value={skuDraft}
        onChange={(event) => { setSkuDraft(event.target.value); setFilterError(undefined); }}
        onPressEnter={applyHistoryFilters}
      />
      <Select<SubmissionHistoryDatePreset>
        aria-label="投递日期"
        className="history-date-preset"
        options={SUBMISSION_HISTORY_DATE_PRESET_OPTIONS}
        status={filterError && datePresetDraft === 'CUSTOM' ? 'error' : undefined}
        value={datePresetDraft}
        onChange={(value) => { setDatePresetDraft(value); if (value !== 'CUSTOM') setCustomDateRangeDraft(null); setFilterError(undefined); }}
      />
      {datePresetDraft === 'CUSTOM' && <DatePicker.RangePicker
        aria-label="投递日期时间段"
        className="history-date-range"
        placeholder={['开始日期', '结束日期']}
        status={filterError ? 'error' : undefined}
        value={customDateRangeDraft}
        onChange={(value) => { setCustomDateRangeDraft(value as SubmissionHistoryDateRange); setFilterError(undefined); }}
      />}
      <Button aria-label="查询" type="primary" onClick={applyHistoryFilters}>查询</Button>
      <Button disabled={!canClearFilters} onClick={clearHistoryFilters}>清除筛选</Button>
      <Text className="history-filter-summary" type={filterError ? 'danger' : 'secondary'} role={filterError ? 'alert' : undefined}>
        {filterError || <>{appliedFilters.sku && <>SKU <span className="mono-badge">{appliedFilters.sku}</span> · </>}{appliedDateLabel && <>完成日期 {appliedDateLabel} · </>}共 {query.data?.items.length || 0} 条记录</>}
      </Text>
    </Flex></Card>
    {query.isError && <Alert type="error" showIcon message="投递历史加载失败" description={query.error.message} action={<Button size="small" onClick={() => void query.refetch()}>重新加载</Button>} />}
    <Table rowKey="submissionId" loading={query.isFetching} dataSource={query.data?.items || []} locale={{ emptyText: hasAppliedFilters ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={appliedFilters.sku && !appliedDateLabel ? `SKU ${appliedFilters.sku} 暂无投递记录` : '当前筛选条件暂无投递记录'} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无投递记录" /> }} expandable={{ expandedRowRender: (record) => <Descriptions bordered size="small" column={1} items={[
      { key: 'identity', label: '最终产品身份', children: record.productSku ? `${record.productSku} · ${record.productNameSnapshot || '历史名称缺失'}${record.variantName ? ` · ${record.variantName}` : ''}` : '旧记录未保存' }, { key: 'source', label: '来源目录', children: record.sourceFolder }, { key: 'target', label: '目标目录', children: record.targetFolder || '未生成' }, { key: 'archive', label: '审核归档', children: record.archiveFolder || '未生成' },
      { key: 'error', label: '失败信息', children: record.errorCode ? `${record.errorCode}: ${record.errorMessage}` : '无' }
    ]} /> }} columns={[
      { title: '投递编号', dataIndex: 'submissionId', render: (value) => <Text className="mono-small">{value}</Text> },
      { title: '产品身份', dataIndex: 'sourceFolder', render: (value, record) => <Space direction="vertical" size={0}><strong>{record.productNameSnapshot || pathName(value)}</strong>{record.productSku && <span className="copy-value-inline"><span className="mono-badge">{record.productSku}</span><CopyValueButton label="SKU" value={record.productSku} /></span>}</Space> },
      { title: '流向', render: (_, record) => <Space><Tag>{workflowLabel(workflowShortcuts.stageDefinitions.find((stage) => stage.id === record.sourceStageId), record.sourceStageId)}</Tag>→<Tag color="cyan">{record.targetStageId === 'WB_SHARED_MEDIA' ? 'WB 共享媒体' : workflowLabel(workflowShortcuts.stageDefinitions.find((stage) => stage.id === record.targetStageId), record.targetStageId)}</Tag></Space> },
      { title: '图片', dataIndex: 'selectedImageCount' },
      { title: '状态', dataIndex: 'status', render: (value) => <Tag color={value === 'SUCCESS' ? 'green' : value === 'PARTIAL_SUCCESS' ? 'orange' : 'red'}>{value}</Tag> },
      { title: '完成时间', dataIndex: 'completedAt', render: (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—' },
      { title: '操作', render: (_, record) => { const disabledReason = retryDisabledReason(record.sourceStageId, record.targetStageId); return record.status !== 'SUCCESS' ? <Tooltip title={disabledReason}><Button type="link" disabled={Boolean(disabledReason)} loading={retry.isPending} onClick={() => retry.mutate(record.submissionId)}>重试失败项</Button></Tooltip> : null; } }
    ]} scroll={{ x: 1000 }} />
  </div>;
}

type StageSettingsSection = 'general' | 'parameters' | 'download';

function SettingsPage() {
  const client = useQueryClient();
  const location = useLocation();
  const query = useQuery({ queryKey: ['config'], queryFn: api.config });
  const [draft, setDraft] = useState<AppConfig>();
  const [selectedStageId, setSelectedStageId] = useState<string>();
  const [activeSettingsSection, setActiveSettingsSection] = useState<StageSettingsSection>(() => new URLSearchParams(location.search).get('section') === 'download' ? 'download' : 'general');
  const [createOpen, setCreateOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupDrafts, setGroupDrafts] = useState<WorkflowGroup[]>([]);
  const [groupAssignments, setGroupAssignments] = useState<Record<string, string>>({});
  const [createForm] = Form.useForm<{ mode: 'blank' | 'copy'; copyFromStageId?: string; id: string; alias: string; groupId: string; displayName: string; workflowName: string; description: string }>();
  const initialSelectionDone = useRef(false);
  useEffect(() => { if (query.data?.config) setDraft(structuredClone(query.data.config)); }, [query.data?.config]);
  useEffect(() => {
    if (!draft || initialSelectionDone.current) return;
    const params = new URLSearchParams(location.search);
    const requestedStageId = params.get('stage');
    const downloadRequested = params.get('section') === 'download';
    setSelectedStageId(draft.stages.find((stage) => stage.id === requestedStageId)?.id || (downloadRequested ? draft.stages.find((stage) => stage.download)?.id : undefined) || draft.stages[0]?.id);
    initialSelectionDone.current = true;
  }, [draft, location.search]);
  useEffect(() => { if (draft && selectedStageId && !draft.stages.some((stage) => stage.id === selectedStageId)) setSelectedStageId(draft.stages[0]?.id); }, [draft, selectedStageId]);
  useEffect(() => {
    if (activeSettingsSection !== 'download' || !draft || !selectedStageId) return;
    const selectedStage = draft.stages.find((stage) => stage.id === selectedStageId);
    if (selectedStage && !selectedStage.download) setActiveSettingsSection('general');
  }, [activeSettingsSection, draft, selectedStageId]);
  const refresh = (config: AppConfig) => { setDraft(structuredClone(config)); void client.invalidateQueries({ queryKey: ['config'] }); void client.invalidateQueries({ queryKey: ['stages'] }); void client.invalidateQueries({ queryKey: ['download-workflows'] }); };
  const saveConfig = useMutation({ mutationFn: (config: AppConfig) => api.saveConfig(config), onSuccess: (result) => { message.success('配置已保存'); refresh(result.config); }, onError: (error: Error) => message.error(error.message) });
  const saveWorkflow = useMutation({ mutationFn: (stage: StageConfig) => api.updateWorkflow(stage.id, stage), onSuccess: (result) => { message.success(`${workflowLabel(result.workflow)} 已保存`); refresh(result.config); }, onError: (error: Error) => message.error(error.message) });
  const createWorkflow = useMutation({ mutationFn: ({ stage, copyFromStageId }: { stage: StageConfig; copyFromStageId?: string }) => api.createWorkflow(stage, copyFromStageId), onSuccess: (result) => { message.success(`${workflowLabel(result.workflow)} 已创建`); setCreateOpen(false); createForm.resetFields(); setSelectedStageId(result.workflow.id); refresh(result.config); }, onError: (error: Error) => message.error(error.message) });
  const deleteWorkflow = useMutation({ mutationFn: (stageId: string) => api.deleteWorkflow(stageId), onSuccess: (result) => { message.success(`工作流 ${result.deletedStageId} 配置已删除，参数文件已归档`); setSelectedStageId(result.config.stages[0]?.id); refresh(result.config); }, onError: (error: Error) => message.error(error.message) });
  const saveGroups = useMutation({ mutationFn: () => api.saveWorkflowGroups(groupDrafts, groupAssignments), onSuccess: (result) => { message.success('工作流分组已保存'); setGroupOpen(false); refresh(result.config); }, onError: (error: Error) => message.error(error.message) });
  const cache = useQuery({ queryKey: ['thumbnail-cache'], queryFn: api.thumbnailCache });
  const staging = useQuery({ queryKey: ['staging'], queryFn: api.staging });
  const pathMap = new Map(query.data?.readiness.paths.map((item) => [item.path, item]));
  if (query.isError) return <Result status="error" title="系统设置加载失败" subTitle={query.error.message} extra={<Button type="primary" onClick={() => void query.refetch()}>重新加载</Button>} />;
  const serverConfigVersion = (query.data?.config as { version?: string } | undefined)?.version;
  if (serverConfigVersion && !['v002', 'v003'].includes(serverConfigVersion)) {
    return <Result status="warning" title="前后端版本不一致" subTitle={`当前后端仍为 ${serverConfigVersion}，请重启 MerchRoute 服务后重新加载设置页面。`} extra={<Button type="primary" onClick={() => void query.refetch()}>重新检测</Button>} />;
  }
  if (!draft) return <Skeleton active />;
  const selectedStage = draft.stages.find((stage) => stage.id === selectedStageId);
  const showMaintenance = draft.stages.length === 0 || activeSettingsSection === 'general';
  const updateStage = (stageId: string, patch: Partial<StageConfig>) => setDraft((current) => {
    const next = structuredClone(current!);
    const stage = next.stages.find((item) => item.id === stageId);
    if (stage) Object.assign(stage, patch);
    if ((stageId === 'E004' || stageId === 'E005') && typeof patch.ozonOutputRoot === 'string') {
      for (const linkedStage of next.stages.filter((item) => item.id === 'E004' || item.id === 'E005')) linkedStage.ozonOutputRoot = patch.ozonOutputRoot;
    }
    return next;
  });
  const saveSelectedWorkflow = async () => {
    if (!selectedStage) return;
    if (selectedStage.id !== 'E004' && selectedStage.id !== 'E005') { saveWorkflow.mutate(selectedStage); return; }
    const ozonValidation = validateOzonOutputTemplate(selectedStage.ozonOutputRoot || '');
    if (ozonValidation) { message.error(ozonValidation); return; }
    const previousOzonRoot = query.data?.ozonPublishingReadiness?.settings.rootDirectory || '';
    const nextOzonRoot = outputRootFromTemplate(selectedStage.ozonOutputRoot || '') || '';
    const save = () => saveConfig.mutate(draft);
    if (normalizeUiPath(previousOzonRoot) === normalizeUiPath(nextOzonRoot)) { save(); return; }
    Modal.confirm({
      title: '切换共享媒体根目录？',
      content: <Space direction="vertical" size={4}><Text>不会自动移动旧文件；新任务将写入新目录。</Text><Text type="secondary">OZON 根目录：{nextOzonRoot}</Text></Space>,
      okText: '确认切换并保存', cancelText: '取消', onOk: save
    });
  };
  const configActions = selectedStage ? <Space wrap className="subpage-actions"><Button danger icon={<DeleteOutlined />} loading={deleteWorkflow.isPending} onClick={() => Modal.confirm({ title: `删除 ${workflowLabel(selectedStage)}？`, content: '系统会先检查投递目标、待处理任务和下载历史。业务目录与历史记录不会删除。', okText: '检查并删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => deleteWorkflow.mutateAsync(selectedStage.id) })}>删除工作流</Button><Button type="primary" icon={<SaveOutlined />} loading={saveWorkflow.isPending || saveConfig.isPending} onClick={() => void saveSelectedWorkflow()}>保存工作流</Button></Space> : null;
  const maintenancePanels = <Row className="settings-maintenance" gutter={[16, 16]}>
    <Col xs={24} lg={12}><Card title="投递与缩略图"><Form layout="vertical"><Form.Item label="批量投递并发数"><Select value={draft.submissionConcurrency} onChange={(value) => setDraft({ ...draft, submissionConcurrency: value })} options={[1, 2, 3, 4].map((value) => ({ value, label: value }))} /></Form.Item><Row gutter={12}><Col span={8}><Form.Item label="缩略图宽"><Input type="number" value={draft.thumbnail.maxWidth} onChange={(event) => setDraft({ ...draft, thumbnail: { ...draft.thumbnail, maxWidth: Number(event.target.value) } })} /></Form.Item></Col><Col span={8}><Form.Item label="缩略图高"><Input type="number" value={draft.thumbnail.maxHeight} onChange={(event) => setDraft({ ...draft, thumbnail: { ...draft.thumbnail, maxHeight: Number(event.target.value) } })} /></Form.Item></Col><Col span={8}><Form.Item label="WebP 质量"><Input type="number" value={draft.thumbnail.quality} onChange={(event) => setDraft({ ...draft, thumbnail: { ...draft.thumbnail, quality: Number(event.target.value) } })} /></Form.Item></Col></Row><Flex justify="space-between"><Text>缓存：{cache.data?.count || 0} 个 / {formatBytes(cache.data?.bytes || 0)}</Text><Button danger onClick={async () => { const result = await api.clearThumbnailCache(); message.success(`已清理 ${result.removed} 个缩略图`); void cache.refetch(); }}>清理缓存</Button></Flex></Form></Card></Col>
    <Col xs={24} lg={12}><Card title="残留暂存目录"><List locale={{ emptyText: '没有发现 .staging 残留' }} dataSource={staging.data?.items || []} renderItem={(item) => <List.Item actions={item.stale ? [<Button danger size="small" onClick={async () => { await api.clearStaging(item.path); void staging.refetch(); }}>安全清理</Button>] : []}><List.Item.Meta title={item.path} description={`${dayjs(item.modifiedAt).format('YYYY-MM-DD HH:mm')} · ${item.stale ? '超过 24 小时' : '暂不允许清理'}`} /></List.Item>} /></Card></Col>
  </Row>;
  const openGroups = () => { setGroupDrafts(structuredClone(draft.workflowGroups)); setGroupAssignments(Object.fromEntries(draft.stages.map((stage) => [stage.id, stage.groupId]))); setGroupOpen(true); };
  const openCreate = () => { createForm.setFieldsValue({ mode: 'blank', id: '', alias: '', groupId: draft.workflowGroups[0]?.id, displayName: '', workflowName: '', description: '' }); setCreateOpen(true); };
  const submitCreate = async () => {
    const values = await createForm.validateFields();
    const id = values.id.trim().toUpperCase();
    const source = values.mode === 'copy' ? draft.stages.find((stage) => stage.id === values.copyFromStageId) : undefined;
    const stage: StageConfig = source ? structuredClone(source) : { id, alias: values.alias.trim(), groupId: values.groupId, displayName: values.displayName.trim(), workflowName: values.workflowName.trim(), description: values.description.trim(), enabled: false, reviewEnabled: true, mediaTypes: ['image'], targets: [] };
    Object.assign(stage, { id, alias: values.alias.trim(), groupId: values.groupId, displayName: values.displayName.trim(), workflowName: values.workflowName.trim(), description: values.description.trim(), enabled: false });
    if (stage.download) stage.download.isDefault = false;
    createWorkflow.mutate({ stage, copyFromStageId: source?.id });
  };
  const moveWorkflow = (direction: -1 | 1) => {
    if (!selectedStage) return;
    const sameGroupIndexes = draft.stages.map((stage, index) => stage.groupId === selectedStage.groupId ? index : -1).filter((index) => index >= 0);
    const currentIndex = draft.stages.findIndex((stage) => stage.id === selectedStage.id);
    const position = sameGroupIndexes.indexOf(currentIndex);
    const targetIndex = sameGroupIndexes[position + direction];
    if (targetIndex === undefined) return;
    const next = structuredClone(draft);
    [next.stages[currentIndex], next.stages[targetIndex]] = [next.stages[targetIndex]!, next.stages[currentIndex]!];
    setDraft(next);
    saveConfig.mutate(next);
  };
  return <div className="page-stack settings-page"><PageTitle eyebrow="LOCAL SYSTEM CONTROL" title={query.data?.readiness.complete ? '系统设置' : '首次启动设置'} description="统一管理工作流分组、图片审核与投递、任务参数和下载调用。" extra={<Space wrap><Button onClick={() => downloadJson('n8n-media-review-config-v003.json', draft)}>导出配置</Button><Upload showUploadList={false} accept="application/json" beforeUpload={async (file) => { try { saveConfig.mutate(JSON.parse(await file.text())); } catch { message.error('配置文件不是有效 JSON'); } return false; }}><Button>导入配置</Button></Upload><Button onClick={openGroups}>管理分组</Button><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建工作流</Button></Space>} />
    {!query.data?.readiness.complete && <Alert type="warning" showIcon message="部分候选目录尚未就绪" description="请检查已启用且需要人工审核的工作流目录；未启用流程不会阻止系统使用。" />}
    {query.data?.downloadSync?.status === 'pending' && <Alert type="warning" showIcon message="下载配置待同步" description={query.data.downloadSync.message} />}
    <div className="workflow-settings-shell">
      <div className="workflow-settings-mobile-picker">
        <Text strong>选择工作流</Text>
        <Select
          aria-label="移动端工作流选择"
          value={selectedStageId}
          placeholder="新建或选择工作流"
          onChange={setSelectedStageId}
          options={draft.workflowGroups.map((group) => ({
            label: group.name,
            options: draft.stages.filter((stage) => stage.groupId === group.id).map((stage) => ({ value: stage.id, label: workflowLabel(stage) }))
          }))}
        />
      </div>
      <aside className="workflow-settings-nav" aria-label="工作流设置菜单">
        <div className="workflow-settings-nav-summary"><strong>{draft.stages.length}</strong><span>个工作流 · {draft.workflowGroups.length} 个分组</span></div>
        {draft.workflowGroups.map((group) => { const stages = draft.stages.filter((stage) => stage.groupId === group.id); return <section className="workflow-settings-group" key={group.id}><div className="workflow-settings-group-title"><span>{group.name}</span><Tag>{stages.length}</Tag></div>{stages.map((stage) => <button type="button" className={`workflow-settings-item${stage.id === selectedStageId ? ' is-active' : ''}`} key={stage.id} onClick={() => setSelectedStageId(stage.id)}><span>{workflowLabel(stage)}</span><small>{stage.workflowName}</small><em className={stage.enabled ? 'is-enabled' : ''}>{stage.enabled ? '运行中' : '已停用'}</em></button>)}{!stages.length && <Text className="workflow-settings-empty-group" type="secondary">暂无工作流</Text>}</section>; })}
      </aside>
      <main className="workflow-settings-detail">
        {selectedStage ? <><div className="workflow-settings-detail-toolbar"><div><Space><span className="mono-badge">{selectedStage.id}</span><Title level={3}>{workflowLabel(selectedStage)}</Title></Space><Text type="secondary">{selectedStage.displayName} · {selectedStage.workflowName}</Text></div><Space><Tooltip title="在当前分组中上移"><Button aria-label="上移工作流" icon={<ArrowUpOutlined />} onClick={() => moveWorkflow(-1)} /></Tooltip><Tooltip title="在当前分组中下移"><Button aria-label="下移工作流" icon={<ArrowDownOutlined />} onClick={() => moveWorkflow(1)} /></Tooltip>{configActions}</Space></div><StageSettings stage={selectedStage} allStages={draft.stages} groups={draft.workflowGroups} pathMap={pathMap} update={(patch) => updateStage(selectedStage.id, patch)} activeSection={activeSettingsSection} onSectionChange={setActiveSettingsSection} /></> : <Empty description="还没有工作流" image={Empty.PRESENTED_IMAGE_SIMPLE}><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建第一个工作流</Button></Empty>}
      </main>
    </div>
    {showMaintenance && <Card className="system-maintenance-card" title="系统维护" extra={<Button icon={<SaveOutlined />} loading={saveConfig.isPending} onClick={() => saveConfig.mutate(draft)}>保存全局设置</Button>}>{maintenancePanels}</Card>}
    <Drawer open={createOpen} width={620} title="新建工作流" onClose={() => setCreateOpen(false)} extra={<Space><Button onClick={() => setCreateOpen(false)}>取消</Button><Button type="primary" loading={createWorkflow.isPending} onClick={() => void submitCreate()}>创建工作流</Button></Space>}><Form form={createForm} layout="vertical"><Form.Item label="起始方式" name="mode" rules={[{ required: true }]}><Radio.Group optionType="button" buttonStyle="solid" options={[{ value: 'blank', label: '空白模板' }, { value: 'copy', label: '复制现有工作流' }]} /></Form.Item><Form.Item noStyle shouldUpdate={(before, after) => before.mode !== after.mode}>{({ getFieldValue }) => getFieldValue('mode') === 'copy' ? <Form.Item label="复制来源" name="copyFromStageId" rules={[{ required: true, message: '请选择复制来源' }]}><Select options={draft.stages.map((stage) => ({ value: stage.id, label: workflowLabel(stage) }))} /></Form.Item> : null}</Form.Item><Row gutter={14}><Col span={10}><Form.Item label="工作流编号" name="id" rules={[{ required: true, message: '请输入编号' }, { pattern: /^E\d{3}$/i, message: '格式为 E 加三位数字' }]}><Input placeholder="E008" onInput={(event) => { event.currentTarget.value = event.currentTarget.value.toUpperCase(); }} /></Form.Item></Col><Col span={14}><Form.Item label="显示别名" name="alias" rules={[{ required: true, message: '请输入别名' }]}><Input placeholder="例如：淘宝下载" /></Form.Item></Col></Row><Form.Item label="所属分组" name="groupId" rules={[{ required: true, message: '请选择分组' }]}><Select options={draft.workflowGroups.map((group) => ({ value: group.id, label: group.name }))} /></Form.Item><Form.Item label="完整名称" name="displayName" rules={[{ required: true, message: '请输入完整名称' }]}><Input placeholder="例如：淘宝商品媒体下载" /></Form.Item><Form.Item label="n8n 工作流名称" name="workflowName" rules={[{ required: true, message: '请输入工作流名称' }]}><Input placeholder="E008-淘宝商品媒体下载" /></Form.Item><Form.Item label="功能说明" name="description"><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item><Alert showIcon type="info" message="新工作流默认停用" description="完成目录、投递目标和参数检查后，再在详情页启用。复制模式会同时复制参数模板，但不会复制默认下载身份。" /></Form></Drawer>
    <WorkflowGroupDrawer open={groupOpen} groups={groupDrafts} assignments={groupAssignments} stages={draft.stages} saving={saveGroups.isPending} onGroupsChange={setGroupDrafts} onAssignmentsChange={setGroupAssignments} onClose={() => setGroupOpen(false)} onSave={() => saveGroups.mutate()} />
  </div>;
}

function StageSettings({ stage, allStages, groups, pathMap, update, activeSection, onSectionChange }: { stage: StageConfig; allStages: StageConfig[]; groups: WorkflowGroup[]; pathMap: Map<string, any>; update: (patch: Partial<StageConfig>) => void; activeSection: StageSettingsSection; onSectionChange: (section: StageSettingsSection) => void }) {
  const isWbMediaTerminal = isWbMediaTerminalStage(stage);
  const hidesDeprecatedOutputRoot = stage.id === 'E000' || DEPRECATED_OUTPUT_ROOT_STAGE_IDS.includes(stage.id);
  const pathField = (label: string, key: 'candidateRoot' | 'approvedArchiveRoot' | 'inputQueueRoot' | 'outputRoot' | 'ozonOutputRoot') => {
    const value = stage[key] || '';
    if (isWbMediaTerminal && key === 'outputRoot') {
      const example = value ? value.replace('<SKU>', '0000001') : '';
      return <Form.Item help={<span>由 <Link to="/listing/wb?settings=1">WB上品设置</Link> 统一管理{example ? `；示例 SKU 解析结果：${example}` : ''}</span>} label="WB 共享媒体输出目录模板"><Input aria-label={`${stage.id} WB 共享媒体输出目录模板（只读）`} readOnly value={value} placeholder="请前往 WB上品设置配置" suffix={<Link to="/listing/wb?settings=1"><Button type="link" size="small">打开设置</Button></Link>} /></Form.Item>;
    }
    if (isWbMediaTerminal && key === 'ozonOutputRoot') {
      const error = validateOzonOutputTemplate(value);
      const example = value ? value.replace('<SKU>', '0000001') : '';
      return <Form.Item validateStatus={error ? 'error' : undefined} help={error || (example ? `示例 SKU 解析结果：${example}` : undefined)} label="OZON 共享媒体输出目录模板"><Input aria-label={`${stage.id} OZON 共享媒体输出目录模板`} status={error ? 'error' : undefined} value={value} placeholder="G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\<SKU>\\variants" onChange={(event) => update({ ozonOutputRoot: event.target.value })} suffix={<Tag color="blue">E004 / E005 同步</Tag>} /></Form.Item>;
    }
    const state = pathMap.get(value);
    const localImportRole = stage.id === 'E000' && key === 'inputQueueRoot' ? 'source' : stage.id === 'E000' && key === 'candidateRoot' ? 'candidate' : undefined;
    return <Form.Item label={<Space>{label}{state && <Badge status={state.exists && state.readable ? (state.writable ? 'success' : 'warning') : 'error'} text={state.exists ? `${state.readable ? '可读' : '不可读'} / ${state.writable ? '可写' : '只读'}` : '不存在'} />}</Space>} help={localImportRole === 'source' ? '必须是当前系统的真实绝对目录；只要求可读，不能是卷根、符号链接或 reparse point。' : undefined}><Input value={value} onChange={(event) => update({ [key]: event.target.value })} suffix={<Button type="text" size="small" disabled={!value} onClick={async () => { try { const result = await api.validatePath(value, localImportRole); message.success(localImportRole === 'source' && !result.writable ? '只读来源目录验证通过' : '路径验证通过'); } catch (error) { message.error(error instanceof ApiError ? error.userMessage : '路径验证失败'); } }}>验证</Button>} /></Form.Item>;
  };
  const setTargets = (targets: StageConfig['targets']) => update({ targets });
  const generalSettings = <div className="settings-subpage"><Card className="settings-stage" title="工作流身份与审核投递" extra={<Space>启用 <Switch aria-label={`${stage.id} 启用流程`} checked={stage.enabled} onChange={(value) => update({ enabled: value })} /></Space>}>
    <Form layout="vertical">
      <Row gutter={14}><Col xs={24} md={8}><Form.Item label="显示别名"><Input aria-label="显示别名" value={stage.alias} onChange={(event) => update({ alias: event.target.value })} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="完整名称"><Input aria-label="完整名称" value={stage.displayName} onChange={(event) => update({ displayName: event.target.value })} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="所属分组"><Select aria-label="所属分组" value={stage.groupId} options={groups.map((group) => ({ value: group.id, label: group.name }))} onChange={(groupId) => update({ groupId })} /></Form.Item></Col></Row>
      <Form.Item label="n8n 工作流名称"><Input aria-label="n8n 工作流名称" value={stage.workflowName} onChange={(event) => update({ workflowName: event.target.value })} /></Form.Item>
      <Form.Item label="功能说明"><Input aria-label="功能说明" value={stage.description} onChange={(event) => update({ description: event.target.value })} /></Form.Item>
      <Row gutter={14}><Col xs={24} md={8}><Form.Item label="人工审核"><Switch checked={stage.reviewEnabled} onChange={(reviewEnabled) => update({ reviewEnabled })} checkedChildren="需要审核" unCheckedChildren="终端流程" /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="媒体类型"><Checkbox.Group value={stage.mediaTypes} options={[{ value: 'image', label: '图片' }, { value: 'video', label: '视频' }]} onChange={(values) => values.length && update({ mediaTypes: values as StageConfig['mediaTypes'] })} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="下载调用"><Switch checked={Boolean(stage.download)} onChange={(checked) => update({ download: checked ? { webhookUrl: 'http://localhost:5678/webhook/', timeoutMs: 900000, isDefault: !allStages.some((item) => item.enabled && item.download?.isDefault), recoveryMode: 'MANUAL' } : undefined })} checkedChildren="已配置" unCheckedChildren="未配置" /></Form.Item></Col></Row>
      {pathField(stage.id === 'E000' ? '本地导入来源根目录' : '输入监听目录', 'inputQueueRoot')}
      {pathField(stage.download ? '下载与候选图片目录' : '候选图片目录', 'candidateRoot')}
      {pathField('已审核归档目录', 'approvedArchiveRoot')}
      {!hidesDeprecatedOutputRoot && pathField(isWbMediaTerminal ? 'WB 共享媒体输出目录模板' : '输出目录', 'outputRoot')}
      {isWbMediaTerminal && pathField('OZON 共享媒体输出目录模板', 'ozonOutputRoot')}
      {isWbMediaTerminal ? <Alert type="info" showIcon message="审核时选择 WB、OZON 或同时投递" description={`${stage.id === 'E004' ? '视频' : '图片'}将分别写入所选平台的 <变体名>/${stage.id === 'E004' ? 'videos' : 'images'}/<投递ID>；两个平台互不串线，E004 和 E005 分别共享各平台模板。`} /> : <><Flex justify="space-between" align="center" className="settings-section-heading"><div><Title level={5}>投递目标</Title><Text type="secondary">审核通过后可投递到一个或多个已配置工作流。</Text></div><Button type="dashed" icon={<PlusOutlined />} disabled={allStages.length < 2} onClick={() => { const targetStage = allStages.find((item) => item.id !== stage.id && !stage.targets.some((target) => target.targetStageId === item.id)); if (targetStage) setTargets([...stage.targets, { targetStageId: targetStage.id, targetQueueRoot: targetStage.inputQueueRoot || '', folderNameTemplate: '{sourceName}-已经审核', packageMode: 'preserve-relative', copyRootMetadata: true }]); else message.warning('没有可添加的目标工作流'); }}>添加投递目标</Button></Flex>
      {stage.targets.map((target, targetIndex) => <Card size="small" key={`${stage.id}-target-${targetIndex}`} title={`投递目标 ${targetIndex + 1}`} extra={<Button danger type="text" icon={<DeleteOutlined />} aria-label={`删除投递目标 ${targetIndex + 1}`} onClick={() => setTargets(stage.targets.filter((_, index) => index !== targetIndex))} />}>
        <Row gutter={12}><Col xs={24} md={8}><Form.Item label="目标工作流"><Select value={target.targetStageId} options={allStages.filter((item) => item.id !== stage.id).map((item) => ({ value: item.id, label: workflowLabel(item), disabled: stage.targets.some((candidate, index) => index !== targetIndex && candidate.targetStageId === item.id) }))} onChange={(targetStageId) => { const targets = structuredClone(stage.targets); targets[targetIndex]!.targetStageId = targetStageId; const targetStage = allStages.find((item) => item.id === targetStageId); if (!targets[targetIndex]!.targetQueueRoot) targets[targetIndex]!.targetQueueRoot = targetStage?.inputQueueRoot || ''; setTargets(targets); }} /></Form.Item></Col><Col xs={24} md={16}><Form.Item label="目标监听目录"><Input value={target.targetQueueRoot} onChange={(event) => { const targets = structuredClone(stage.targets); targets[targetIndex]!.targetQueueRoot = event.target.value; setTargets(targets); }} /></Form.Item></Col></Row>
        <Row gutter={12}>
          <Col xs={24} md={12}><Form.Item label="文件夹名称模板"><Input value={target.folderNameTemplate} onChange={(event) => { const targets = structuredClone(stage.targets); targets[targetIndex]!.folderNameTemplate = event.target.value; setTargets(targets); }} /></Form.Item></Col>
          <Col xs={16} md={8}><Form.Item label="打包模式"><Select value={target.packageMode} onChange={(value) => { const targets = structuredClone(stage.targets); targets[targetIndex]!.packageMode = value; setTargets(targets); }} options={[{ value: 'preserve-relative', label: '保留目录结构' }, { value: 'flatten', label: '扁平化' }]} /></Form.Item></Col>
          <Col xs={8} md={4}><Form.Item label="复制元数据"><Switch checked={target.copyRootMetadata} onChange={(value) => { const targets = structuredClone(stage.targets); targets[targetIndex]!.copyRootMetadata = value; setTargets(targets); }} /></Form.Item></Col>
        </Row>
      </Card>)}</>}
    </Form>
  </Card></div>;
  const downloadSettings = stage.download ? <Card className="workflow-download-card" title={<Space><ApiOutlined />下载调用</Space>}><Alert type="info" showIcon message="配置由系统设置统一管理" description="采购管理调用时会自动传入 downloadJobId、productName、SKU、productUrl 和当前候选图片目录。" /><Form layout="vertical"><Form.Item label="Webhook 完整地址" required><Input aria-label="Webhook 完整地址" value={stage.download.webhookUrl} onChange={(event) => update({ download: { ...stage.download!, webhookUrl: event.target.value } })} /></Form.Item><Row gutter={14}><Col xs={24} md={8}><Form.Item label="超时（毫秒）"><Input aria-label="超时（毫秒）" type="number" min={5000} max={3600000} value={stage.download.timeoutMs} onChange={(event) => update({ download: { ...stage.download!, timeoutMs: Number(event.target.value) } })} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="默认下载工作流"><Switch aria-label="默认下载工作流" checked={stage.download.isDefault} onChange={(isDefault) => update({ download: { ...stage.download!, isDefault } })} checkedChildren="默认" unCheckedChildren="普通" /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="重启恢复模式"><Select aria-label="重启恢复模式" value={stage.download.recoveryMode} onChange={(recoveryMode) => update({ download: { ...stage.download!, recoveryMode } })} options={[{ value: 'IDEMPOTENT_REPLAY', label: '幂等重放' }, { value: 'MANUAL', label: '仅人工恢复' }]} /></Form.Item></Col></Row>{stage.download.recoveryMode === 'MANUAL' && <Alert type="warning" showIcon message="重启后不会自动重放" description="运行中的下载若被服务重启打断，将停止并要求人工核验后重试。" />}<Descriptions size="small" bordered column={1} items={[{ key: 'output', label: 'parentOutputDir', children: stage.candidateRoot || '请先配置候选图片目录' }]} /></Form></Card> : <Empty description="当前工作流未启用下载调用" />;
  return <Tabs className="stage-subtabs" items={[
    { key: 'general', label: '图片审核与投递', children: generalSettings },
    { key: 'parameters', label: '工作流参数', children: <WorkflowParameterSettings stage={stage} /> },
    ...(stage.download ? [{ key: 'download', label: '下载调用', children: downloadSettings }] : [])
  ]} activeKey={activeSection} onChange={(section) => onSectionChange(section as StageSettingsSection)} />;
}

function WorkflowGroupDrawer({ open, groups, assignments, stages, saving, onGroupsChange, onAssignmentsChange, onClose, onSave }: { open: boolean; groups: WorkflowGroup[]; assignments: Record<string, string>; stages: StageConfig[]; saving: boolean; onGroupsChange: (groups: WorkflowGroup[]) => void; onAssignmentsChange: (assignments: Record<string, string>) => void; onClose: () => void; onSave: () => void }) {
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= groups.length) return;
    const next = [...groups];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onGroupsChange(next);
  };
  const remove = (group: WorkflowGroup) => {
    const count = Object.values(assignments).filter((groupId) => groupId === group.id).length;
    if (count) { message.warning(`请先将 ${count} 个工作流移出“${group.name}”`); return; }
    onGroupsChange(groups.filter((item) => item.id !== group.id));
  };
  const valid = (!stages.length || groups.length > 0) && groups.every((group) => group.name.trim()) && stages.every((stage) => groups.some((group) => group.id === assignments[stage.id]));
  return <Drawer open={open} width={680} title="管理工作流分组" onClose={onClose} extra={<Space><Button onClick={onClose}>取消</Button><Button type="primary" disabled={!valid} loading={saving} onClick={onSave}>保存分组</Button></Space>}>
    <Alert type="info" showIcon message="分组顺序就是设置菜单顺序" description="删除分组前需先把组内工作流移动到其他分组。工作流在组内的顺序可在详情页调整。" />
    <div className="workflow-group-editor">{groups.map((group, index) => <div className="workflow-group-editor-row" key={group.id}><Input aria-label={`分组名称 ${index + 1}`} value={group.name} onChange={(event) => onGroupsChange(groups.map((item) => item.id === group.id ? { ...item, name: event.target.value } : item))} /><Space size={2}><Button type="text" aria-label={`上移分组 ${group.name}`} icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => move(index, -1)} /><Button type="text" aria-label={`下移分组 ${group.name}`} icon={<ArrowDownOutlined />} disabled={index === groups.length - 1} onClick={() => move(index, 1)} /><Button danger type="text" aria-label={`删除分组 ${group.name}`} icon={<DeleteOutlined />} onClick={() => remove(group)} /></Space></div>)}</div>
    <Button block type="dashed" icon={<PlusOutlined />} onClick={() => onGroupsChange([...groups, { id: `group-${crypto.randomUUID().slice(0, 8)}`, name: '新分组' }])}>添加分组</Button>
    <Title level={5} className="workflow-assignment-title">工作流归属</Title>
    <div className="workflow-assignment-list">{stages.map((stage) => <div className="workflow-assignment-row" key={stage.id}><div><strong>{workflowLabel(stage)}</strong><small>{stage.displayName}</small></div><Select aria-label={`${stage.id} 所属分组`} value={assignments[stage.id]} options={groups.map((group) => ({ value: group.id, label: group.name }))} onChange={(groupId) => onAssignmentsChange({ ...assignments, [stage.id]: groupId })} /></div>)}</div>
  </Drawer>;
}

function WorkflowParameterSettings({ stage }: { stage: AppConfig['stages'][number] }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['workflow-parameters', stage.id], queryFn: () => api.workflowParameters(stage.id) });
  const [rows, setRows] = useState<WorkflowParameterDraftRow[]>([]);
  const [optionEditor, setOptionEditor] = useState<WorkflowOptionEditorState>();
  useEffect(() => {
    if (query.data) setRows(workflowParameterRows(query.data.parameters, query.data.parameterOptions, 'placeholder'));
  }, [query.data]);
  const save = useMutation({
    mutationFn: ({ parameters, parameterOptions }: { parameters: WorkflowParameters; parameterOptions: WorkflowParameterOptions }) => api.saveWorkflowParameters(stage.id, parameters, parameterOptions),
    onSuccess: () => { message.success(`${stage.id} 参数模板已保存`); void client.invalidateQueries({ queryKey: ['workflow-parameters', stage.id] }); },
    onError: (error) => message.error(error.message)
  });
  const saveRows = () => {
    const parsed = parseWorkflowParameterRows(rows, true);
    if (!parsed.parameters || !parsed.parameterOptions) {
      setRows((current) => current.map((row) => ({ ...row, error: parsed.errors[row.id] })));
      message.error('请修正参数字段或类型错误');
      return;
    }
    save.mutate({ parameters: parsed.parameters, parameterOptions: parsed.parameterOptions });
  };
  const exportRows = () => {
    const parsed = parseWorkflowParameterRows(rows, true);
    if (!parsed.parameters || !parsed.parameterOptions) {
      setRows((current) => current.map((row) => ({ ...row, error: parsed.errors[row.id] })));
      message.error('请修正参数字段或类型错误后再导出');
      return;
    }
    const template: WorkflowParameterTemplateFile = { stageId: stage.id, parameters: parsed.parameters, parameterOptions: parsed.parameterOptions };
    downloadJson(`${stage.id}_n8n_product_image_task.template.json`, template);
  };
  const importRows = async (file: File) => {
    try {
      const importedRows = importedWorkflowParameterRows(JSON.parse(await file.text()), stage.id);
      setRows(importedRows);
      message.success(`${stage.id} 参数模板已导入，保存后生效`);
    } catch (error) {
      message.error(`参数模板导入失败：${(error as Error).message}`);
    }
  };
  const changeRowType = (row: WorkflowParameterDraftRow, type: WorkflowParameterType) => {
    const apply = () => setRows((current) => current.map((item) => item.id === row.id ? convertWorkflowParameterType(item, type) : item));
    if (row.useOptions && type !== 'string' && type !== 'number') {
      Modal.confirm({ title: '切换类型将清除下拉选项', content: `${row.name || '当前字段'} 的候选选项只支持 String 和 Number。`, okText: '清除并切换', cancelText: '取消', onOk: apply });
    } else apply();
  };
  const toggleRowOptions = (rowId: string, checked: boolean) => setRows((current) => current.map((row) => row.id === rowId ? {
    ...row, useOptions: checked, optionTexts: checked ? (row.optionTexts.length ? row.optionTexts : [row.valueText, '']) : [], error: undefined
  } : row));
  const openOptionEditor = (row: WorkflowParameterDraftRow) => setOptionEditor({
    rowId: row.id, fieldName: row.name || '未命名参数', type: row.type as 'string' | 'number', values: row.optionTexts.length ? [...row.optionTexts] : [row.valueText, '']
  });
  const saveOptionEditor = () => {
    if (!optionEditor) return;
    try {
      if (optionEditor.values.length < 2) throw new Error('下拉字段至少需要两个选项');
      const normalized = optionEditor.values.map((value) => {
        if (optionEditor.type === 'string') {
          if (!value.trim()) throw new Error('String 选项不能为空');
          return value.trim();
        }
        if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('Number 选项必须是有限数字');
        return String(Number(value));
      });
      if (new Set(normalized).size !== normalized.length) throw new Error('下拉选项不能重复');
      setRows((current) => current.map((row) => row.id === optionEditor.rowId ? { ...row, useOptions: true, optionTexts: normalized, valueText: normalized[0]!, error: undefined } : row));
      setOptionEditor(undefined);
    } catch (error) {
      setOptionEditor((current) => current ? { ...current, error: (error as Error).message } : current);
    }
  };
  const moveOption = (index: number, direction: -1 | 1) => setOptionEditor((current) => {
    if (!current) return current;
    const target = index + direction;
    if (target < 0 || target >= current.values.length) return current;
    const values = [...current.values];
    [values[index], values[target]] = [values[target]!, values[index]!];
    return { ...current, values, error: undefined };
  });
  if (query.isLoading) return <Card><Skeleton active /></Card>;
  if (query.isError) return <Card><Alert type="error" showIcon message={`${stage.id} 参数模板加载失败`} description={query.error.message} action={<Button onClick={() => void query.refetch()}>重新加载</Button>} /></Card>;
  const parameterActions = <Space wrap className="subpage-actions"><Button onClick={exportRows}>导出参数模板</Button><Upload showUploadList={false} accept="application/json" beforeUpload={async (file) => { await importRows(file); return false; }}><Button>导入参数模板</Button></Upload><Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={saveRows}>保存参数模板</Button></Space>;
  return <><Card className="workflow-parameter-card" title={<div className="workflow-parameter-heading"><Space><SettingOutlined />{workflowLabel(stage)}</Space><div className="parameter-file-names"><Text className="mono-small" type="secondary">{query.data?.fileName}</Text><Text className="mono-small" type="secondary">{query.data?.optionsFileName}</Text></div></div>} extra={parameterActions}>
    <Alert type="info" showIcon message="定义 n8n 任务字段、类型、默认值和可选项" description="SKU 与 productName 是置顶的系统保留字段，由 PostgreSQL 在运行时自动写入；其余 String 和 Number 字段可启用下拉选项。" />
    <div className="parameter-template-list">
      {rows.map((row, rowIndex) => { const runtime = isWorkflowRuntimeParameter(row.name); return <div className={`parameter-template-row${runtime ? ' is-system' : ''}${row.error ? ' has-error' : ''}`} key={row.id}>
        <div className="parameter-name-cell"><Input aria-label={`参数字段名 ${rowIndex + 1}`} disabled={runtime} placeholder="字段名" value={row.name} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, name: event.target.value, error: undefined } : item))} />{runtime && <Tag color="cyan">运行时自动写入</Tag>}</div>
        <Select aria-label={`${row.name || `参数 ${rowIndex + 1}`} 类型`} disabled={runtime} className="parameter-type-select" value={row.type} options={workflowParameterTypeOptions} onChange={(type: WorkflowParameterType) => changeRowType(row, type)} />
        <div className="parameter-value-cell">{!runtime && (row.type === 'string' || row.type === 'number') && <div className="parameter-option-toolbar"><Space size={6}><Switch size="small" aria-label={`${row.name || `参数 ${rowIndex + 1}`} 启用下拉选项`} checked={row.useOptions} onChange={(checked) => toggleRowOptions(row.id, checked)} /><Text type="secondary">下拉选项</Text></Space>{row.useOptions && <Button size="small" onClick={() => openOptionEditor(row)}>管理选项 ({row.optionTexts.length})</Button>}</div>}<WorkflowParameterValueEditor row={row} disabled={runtime} ariaLabel={`${row.name || `参数 ${rowIndex + 1}`} 默认值`} onChange={(valueText) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, valueText, optionTexts: item.useOptions ? [valueText, ...item.optionTexts.filter((option) => option !== valueText)] : item.optionTexts, error: undefined } : item))} />{row.error && <Text type="danger" className="parameter-field-error">{row.error}</Text>}</div>
        <Tooltip title={runtime ? '系统保留字段不能删除' : undefined}><Button aria-label={`删除参数 ${row.name || rowIndex + 1}`} disabled={runtime} danger type="text" icon={<DeleteOutlined />} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))} /></Tooltip>
      </div>; })}
      {!rows.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有参数字段" />}
    </div>
    <Button type="dashed" icon={<PlusOutlined />} onClick={() => setRows((current) => [...current, { id: crypto.randomUUID(), name: '', type: 'string', valueText: '', useOptions: false, optionTexts: [] }])}>添加参数字段</Button>
  </Card><Modal className="parameter-options-modal" open={Boolean(optionEditor)} title={`管理下拉选项 · ${optionEditor?.fieldName || ''}`} okText="应用选项" cancelText="取消" onOk={saveOptionEditor} onCancel={() => setOptionEditor(undefined)}>
    <div className="parameter-options-editor">
      <Alert showIcon type="info" message="第一个选项作为默认值" description="可使用上下箭头调整顺序；待投递任务只能选择这里定义的值。" />
      {optionEditor?.error && <Alert showIcon type="error" message={optionEditor.error} />}
      <div className="parameter-options-list">{optionEditor?.values.map((value, index) => <div className="parameter-option-row" key={`${index}-${optionEditor.rowId}`}>
        <div className="parameter-option-index">{index === 0 ? <Tag color="cyan">默认</Tag> : <Text type="secondary">{index + 1}</Text>}</div>
        <Input aria-label={`选项 ${index + 1}`} type={optionEditor.type === 'number' ? 'number' : 'text'} value={value} onChange={(event) => setOptionEditor((current) => current ? { ...current, values: current.values.map((item, itemIndex) => itemIndex === index ? event.target.value : item), error: undefined } : current)} />
        <Space size={2}><Button aria-label={`上移选项 ${index + 1}`} type="text" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => moveOption(index, -1)} /><Button aria-label={`下移选项 ${index + 1}`} type="text" icon={<ArrowDownOutlined />} disabled={index === optionEditor.values.length - 1} onClick={() => moveOption(index, 1)} /><Button aria-label={`删除选项 ${index + 1}`} danger type="text" icon={<DeleteOutlined />} disabled={optionEditor.values.length <= 2} onClick={() => setOptionEditor((current) => current ? { ...current, values: current.values.filter((_, itemIndex) => itemIndex !== index), error: undefined } : current)} /></Space>
      </div>)}</div>
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => setOptionEditor((current) => current ? { ...current, values: [...current.values, ''], error: undefined } : current)}>添加选项</Button>
    </div>
  </Modal></>;
}

function DeliveryTargetStrip({ targets }: { targets: ReviewDeliveryTarget[] }) {
  return <div className={`delivery-target-strip${targets.length ? '' : ' is-empty'}`} role="group" aria-label="投递目标">
    <span className="delivery-target-label">投递目标</span>
    <ArrowRightOutlined className="delivery-target-arrow" aria-hidden="true" />
    <div className="delivery-target-items">
      {targets.length ? targets.map((target, index) => <span
        className={`delivery-target-item is-${target.status}`}
        aria-label={`${target.alias}${target.id ? ` ${target.id}` : ''}${target.status === 'disabled' ? ' 已停用' : ''}`}
        key={`${target.id || target.alias}-${index}`}
      >
        <strong>{target.alias}</strong>
        {target.id && <span className="delivery-target-code">{target.id}</span>}
        {target.status === 'disabled' && <em>已停用</em>}
      </span>) : <span className="delivery-target-empty">未配置投递目标</span>}
    </div>
  </div>;
}

function PageTitle({ eyebrow, title, description, extra, meta }: { eyebrow: string; title: string; description: string; extra?: React.ReactNode; meta?: React.ReactNode }) {
  return <div className="page-title"><div className="page-title-copy"><span className="eyebrow">{eyebrow}</span><Title level={1}>{title}</Title><Paragraph>{description}</Paragraph>{meta && <div className="page-title-meta">{meta}</div>}</div>{extra && <div className="page-actions">{extra}</div>}</div>;
}

function toAntTree(nodes: FolderTreeNode[]): any[] { return nodes.map((node) => ({ key: node.key, title: <Flex justify="space-between" gap={12}><span><FolderOpenOutlined /> {node.title}</span><span className="tree-count">{node.imageCount}</span></Flex>, children: toAntTree(node.children) })); }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function productIdentitySourceLabel(source?: string): string {
  return ({ USER_CONFIRMED: '用户确认', TASK_CONTEXT: '任务上下文', DOWNLOAD_OUTPUT_DIR: '下载任务目录', SKU_PREFIX: '目录 SKU 前缀', PRODUCT_NAME_PREFIX: '数据库产品名匹配' } as Record<string, string>)[source || ''] || '自动识别';
}

function validateVariantGroupsForApproval(groups: VariantSelectionGroup[], imagePaths: Set<string>): { message: string; groupId?: string; imageLimitExceeded?: boolean } | undefined {
  if (!groups.length) return { message: '至少创建一个变体组选图' };
  const names = new Set<string>();
  const colorKeys = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const name = group.variantName.trim().normalize('NFC');
    const variantLabel = name || group.wbColor?.nameZh || `未命名变体 ${index + 1}`;
    const selectedImageCount = new Set(group.selectedRelativePaths.filter((relativePath) => imagePaths.has(relativePath))).size;
    if (selectedImageCount > E001_VARIANT_MAX_IMAGE_COUNT) return {
      message: `产品变体“${variantLabel}”已选择 ${selectedImageCount} 张图片，每个变体最多 ${E001_VARIANT_MAX_IMAGE_COUNT} 张，请修改图片数量后再审核。`,
      groupId: group.groupId,
      imageLimitExceeded: true
    };
    if (!group.wbColor) return { message: group.variantName ? `历史变体“${group.variantName}”需要重新选择 WB 颜色` : '请为每组选图选择 WB 颜色' };
    if (colorKeys.has(group.wbColor.colorKey)) return { message: `WB 颜色“${group.wbColor.nameZh}”重复` };
    colorKeys.add(group.wbColor.colorKey);
    if (!name) return { message: '请填写每组选图对应的变体名' };
    const containsControlCharacter = [...name].some((character) => character.charCodeAt(0) <= 31);
    if (name.length > 64 || name === '.' || name === '..' || /[<>:"/\\|?*]/.test(name) || containsControlCharacter || /[ .]$/.test(name)) return { message: `变体名“${name}”包含无效字符或格式` };
    const key = name.toLocaleLowerCase('zh-CN');
    if (names.has(key)) return { message: `变体名“${name}”重复` };
    names.add(key);
    if (!group.selectedRelativePaths.length) return { message: `变体“${name}”尚未选择媒体` };
  }
  return undefined;
}
function pathName(value: string): string { return value.split(/[\\/]/).filter(Boolean).at(-1) || value; }
function workflowLabel(stage?: Pick<StageConfig, 'id' | 'alias'>, fallback = '未知工作流'): string { return stage ? `${stage.alias}-${stage.id}` : fallback; }

const notificationMeta: Record<TaskNotification['severity'], { color: string; label: string }> = {
  INFO: { color: 'blue', label: '信息' }, SUCCESS: { color: 'green', label: '成功' },
  WARNING: { color: 'orange', label: '警告' }, ERROR: { color: 'red', label: '失败' }
};

const notificationSourceOptions = [
  { value: 'DOWNLOAD_JOB', label: '单条下载任务' },
  { value: 'DOWNLOAD_BATCH', label: '批量下载' },
  { value: 'WB_LISTING', label: 'WB上品' },
  { value: 'WB_AUTO_PUBLISH_JOB', label: 'WB自动上品' }
];
const notificationEventOptions = [
  { value: 'DOWNLOAD_JOB_FAILED', label: '下载失败' },
  { value: 'DOWNLOAD_BATCH_COMPLETED', label: '批次完成' },
  { value: 'WB_LISTING_SUCCEEDED', label: 'WB上品完成' },
  { value: 'WB_LISTING_FAILED', label: 'WB上品失败' },
  { value: 'WB_AUTO_PUBLISH_FAILED', label: 'WB自动上品失败' }
];
const notificationSourceMeta: Record<string, { color: string; label: string }> = {
  DOWNLOAD_JOB: { color: 'blue', label: '采购下载' },
  DOWNLOAD_BATCH: { color: 'geekblue', label: '批量下载' },
  WB_LISTING: { color: 'purple', label: 'WB上品' },
  WB_AUTO_PUBLISH_JOB: { color: 'magenta', label: 'WB自动上品' }
};
const notificationEventMeta: Record<string, { color: string; label: string }> = {
  DOWNLOAD_JOB_FAILED: { color: 'red', label: '下载失败' },
  DOWNLOAD_BATCH_COMPLETED: { color: 'green', label: '批次完成' },
  WB_LISTING_SUCCEEDED: { color: 'green', label: '上品完成' },
  WB_LISTING_FAILED: { color: 'red', label: '上品失败' },
  WB_AUTO_PUBLISH_FAILED: { color: 'red', label: '自动上品失败' }
};

function isWbNotification(item: TaskNotification): boolean {
  return item.category.startsWith('WB_') || item.sourceType.startsWith('WB_') || item.eventType.startsWith('WB_');
}

function notificationSourceLabel(item: TaskNotification): { color: string; label: string } {
  return notificationSourceMeta[item.sourceType] || { color: 'default', label: item.sourceType };
}

function notificationEventLabel(item: TaskNotification): { color: string; label: string } {
  return notificationEventMeta[item.eventType] || { color: 'default', label: item.eventType };
}

function notificationTarget(item: TaskNotification): string {
  if (isWbNotification(item)) return '/listing/wb';
  return item.sku ? `/purchases/url-download?query=${encodeURIComponent(item.sku)}` : '/notifications';
}

function NotificationHub() {
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const initialized = useRef(false);
  const previousErrors = useRef(0);
  const isNotificationsPage = location.pathname.startsWith('/notifications');
  const summary = useQuery({ queryKey: ['notifications', 'summary'], queryFn: api.notificationSummary, retry: false, refetchInterval: 5000 });
  const recentParams = useMemo(() => new URLSearchParams({ page: '1', pageSize: '10' }), []);
  const recent = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => api.notifications(recentParams), enabled: open, retry: false, refetchInterval: open ? 5000 : false });
  useEffect(() => {
    if (!summary.data) return;
    const count = summary.data?.unresolvedErrorCount || 0;
    if (!initialized.current) { initialized.current = true; previousErrors.current = count; return; }
    if (isNotificationsPage && count > previousErrors.current) toastNotification.error({ message: '任务失败', description: '消息中心收到新的失败消息，请打开通知栏查看详情。', placement: 'topRight' });
    previousErrors.current = count;
  }, [isNotificationsPage, summary.data?.unresolvedErrorCount]);
  const markAll = useMutation({ mutationFn: api.markAllNotificationsRead, onSuccess: () => { void client.invalidateQueries({ queryKey: ['notifications'] }); } });
  const openNotification = async (item: TaskNotification) => {
    if (!item.readAt) await api.updateNotification(item.id, { read: true }).catch(() => undefined);
    void client.invalidateQueries({ queryKey: ['notifications'] });
    navigate(notificationTarget(item));
    setOpen(false);
  };
  return <>
    <Tooltip title="消息通知中心"><Badge count={summary.data?.unreadCount || 0} size="small" overflowCount={99}><Button className="notification-bell" type="text" icon={<BellOutlined />} onClick={() => setOpen(true)} aria-label="打开消息通知中心" /></Badge></Tooltip>
    <Drawer className="notification-drawer" open={open} width={430} onClose={() => setOpen(false)} title={<Space><NotificationOutlined />任务通知</Space>} extra={<Button type="link" size="small" loading={markAll.isPending} onClick={() => markAll.mutate()}>全部已读</Button>}>
      <div className="notification-drawer-summary"><span><strong>{summary.data?.unresolvedErrorCount || 0}</strong> 个失败待处理</span><Button size="small" onClick={() => { navigate('/notifications'); setOpen(false); }}>打开消息中心</Button></div>
      <List loading={recent.isLoading} locale={{ emptyText: '暂无任务通知' }} dataSource={recent.data?.items || []} renderItem={(item) => <List.Item className={`notification-list-item ${item.readAt ? '' : 'is-unread'}`} onClick={() => void openNotification(item)}>
        <List.Item.Meta title={<Flex justify="space-between" gap={12}><span>{item.title}</span><Tag color={notificationMeta[item.severity].color}>{notificationMeta[item.severity].label}</Tag></Flex>} description={<><Text>{item.message}</Text><Space wrap size={4} className="notification-drawer-meta"><Tag color={notificationSourceLabel(item).color}>{notificationSourceLabel(item).label}</Tag><Tag color={notificationEventLabel(item).color}>{notificationEventLabel(item).label}</Tag>{item.sku && <span className="mono-badge">{item.sku}</span>}</Space><small>{dayjs(item.createdAt).format('MM-DD HH:mm')}</small></>} />
      </List.Item>} />
    </Drawer>
  </>;
}

function NotificationsPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [state, setState] = useState<'ALL' | 'UNREAD' | 'UNRESOLVED'>('ALL');
  const [severity, setSeverity] = useState<TaskNotification['severity']>();
  const [sourceType, setSourceType] = useState<string>();
  const [eventType, setEventType] = useState<string>();
  const [createdRange, setCreatedRange] = useState<[Dayjs, Dayjs] | null>(null);
  const params = useMemo(() => {
    const value = new URLSearchParams({ page: String(page), pageSize: '20', state });
    if (severity) value.set('severity', severity);
    if (sourceType) value.set('sourceType', sourceType);
    if (eventType) value.set('eventType', eventType);
    if (createdRange) {
      value.set('createdFrom', createdRange[0].startOf('day').toISOString());
      value.set('createdTo', createdRange[1].endOf('day').toISOString());
    }
    return value;
  }, [createdRange, eventType, page, severity, sourceType, state]);
  const notifications = useQuery({ queryKey: ['notifications', params.toString()], queryFn: () => api.notifications(params), retry: false, refetchInterval: 5000 });
  const update = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: { read?: boolean; resolved?: boolean } }) => api.updateNotification(id, patch), onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }), onError: (error: Error) => message.error(error.message) });
  const retry = useMutation({ mutationFn: api.retryNotification, onSuccess: () => { message.success('失败任务已重新加入下载队列'); void client.invalidateQueries({ queryKey: ['notifications'] }); void client.invalidateQueries({ queryKey: ['purchases'] }); }, onError: (error: Error) => message.error(error.message) });
  return <div className="page-stack notifications-page">
    <PageTitle eyebrow="TASK INBOX" title="消息中心" description="集中查看下载与 WB 上品结果，优先处理失败任务并跟踪业务状态。" />
    <Card className="notification-focus-card"><Flex justify="space-between" align="center" wrap gap={16}><div><Text type="secondary">当前视图</Text><Title level={3}>{state === 'UNRESOLVED' ? '待处理失败' : state === 'UNREAD' ? '未读消息' : '全部任务消息'}</Title></div><Space wrap><Select value={state} onChange={(value) => { setPage(1); setState(value); }} style={{ width: 150 }} options={[{ value: 'ALL', label: '全部消息' }, { value: 'UNREAD', label: '未读消息' }, { value: 'UNRESOLVED', label: '待处理失败' }]} /><Select allowClear value={severity} placeholder="消息级别" onChange={(value) => { setPage(1); setSeverity(value); }} style={{ width: 130 }} options={Object.entries(notificationMeta).map(([value, item]) => ({ value, label: item.label }))} /><Select allowClear value={sourceType} placeholder="任务来源" onChange={(value) => { setPage(1); setSourceType(value); }} style={{ width: 140 }} options={notificationSourceOptions} /><Select allowClear value={eventType} placeholder="消息类型" onChange={(value) => { setPage(1); setEventType(value); }} style={{ width: 150 }} options={notificationEventOptions} /><DatePicker.RangePicker value={createdRange} onChange={(value) => { setPage(1); setCreatedRange(value as [Dayjs, Dayjs] | null); }} allowClear placeholder={['开始日期', '结束日期']} /></Space></Flex></Card>
    <Card className="notification-center-card" bodyStyle={{ padding: 0 }}><List loading={notifications.isLoading} locale={{ emptyText: <Empty description="没有符合条件的任务消息" /> }} dataSource={notifications.data?.items || []} renderItem={(item) => <List.Item className={`notification-center-item ${item.readAt ? '' : 'is-unread'}`} actions={[
      item.sku ? <Button key="business" size="small" onClick={() => navigate(notificationTarget(item))}>{isWbNotification(item) ? '查看WB上品' : '查看采购'}</Button> : null,
      item.eventType === 'DOWNLOAD_JOB_FAILED' && !item.resolvedAt ? <Button key="retry" type="primary" size="small" loading={retry.isPending} onClick={() => retry.mutate(item.id)}>重新入队</Button> : null,
      item.severity === 'ERROR' && !item.resolvedAt ? <Button key="resolve" size="small" onClick={() => update.mutate({ id: item.id, patch: { read: true, resolved: true } })}>标记已处理</Button> : null,
      !item.readAt ? <Button key="read" type="link" size="small" onClick={() => update.mutate({ id: item.id, patch: { read: true } })}>标记已读</Button> : null
    ].filter(Boolean)}>
      <List.Item.Meta avatar={<div className={`notification-severity-dot severity-${item.severity.toLowerCase()}`} />} title={<Space wrap><span>{item.title}</span><Tag color={notificationMeta[item.severity].color}>{notificationMeta[item.severity].label}</Tag><Tag color={notificationSourceLabel(item).color}>{notificationSourceLabel(item).label}</Tag><Tag color={notificationEventLabel(item).color}>{notificationEventLabel(item).label}</Tag>{item.resolvedAt && <Tag>已处理</Tag>}</Space>} description={<div className="notification-message"><Text>{item.message}</Text><Space wrap size={6}>{item.sku && <span className="mono-badge">{item.sku}</span>}{item.workflowCode && <Tag>{item.workflowCode}</Tag>}<Text type="secondary">{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss')}</Text></Space>{item.severity === 'ERROR' && typeof item.details.n8nExecutionId === 'string' && item.details.n8nExecutionId && <Text type="secondary">n8n 执行 ID：{item.details.n8nExecutionId}</Text>}</div>} />
    </List.Item>} /></Card>
    <Pagination current={page} pageSize={20} total={notifications.data?.total || 0} showSizeChanger={false} onChange={setPage} />
  </div>;
}

const purchaseJobMeta: Record<string, { color: string; label: string }> = {
  QUEUED: { color: 'gold', label: '等待下载' }, WAITING_RESOURCE: { color: 'orange', label: '等待下载浏览器释放' }, RUNNING: { color: 'processing', label: '下载中' },
  SUCCEEDED: { color: 'green', label: '已完成' }, FAILED: { color: 'red', label: '失败' }
};
const activePurchaseDownloadStatuses = new Set(['QUEUED', 'WAITING_RESOURCE', 'RUNNING']);

type PurchaseBatchDraftItem = { sku: string; productName: string; workflowCode: string; selectedAt: number };
type PurchaseDatePreset = 'ALL' | 'TODAY' | 'YESTERDAY' | 'LAST_7_DAYS' | 'CUSTOM';
const PURCHASE_BATCH_DRAFT_KEY = 'pixroute.purchase-download-batch-draft.v1';
const PURCHASE_BATCH_ACTIVE_KEY = 'pixroute.purchase-download-active-batch.v1';

function readPurchaseBatchDraft(): PurchaseBatchDraftItem[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PURCHASE_BATCH_DRAFT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => /^\d{7}$/.test(item?.sku) && /^E\d{3}$/.test(item?.workflowCode)) : [];
  } catch { return []; }
}

const localImportStatusMeta: Record<LocalImportRecord['status'], { label: string; color: string }> = {
  COPYING: { label: '复制中', color: 'processing' },
  IMPORTED: { label: '已导入', color: 'green' },
  SKIPPED_DUPLICATE: { label: 'URL 重复已跳过', color: 'gold' },
  COPY_FAILED_RETRYABLE: { label: '复制失败可重试', color: 'red' }
};

function formatLocalImportDirectoryDate(value: string): string {
  const date = dayjs(value);
  return date.isValid() ? date.format('YYYY-MM-DD HH:mm') : '—';
}

function PurchaseLocalImportPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const view = new URLSearchParams(location.search).get('view') === 'history' ? 'history' : 'import';
  const setView = (nextView: string, sku?: string) => {
    const params = new URLSearchParams(location.search);
    params.set('view', nextView);
    if (nextView === 'history') {
      if (sku) params.set('query', sku);
      params.set('page', '1');
    } else {
      for (const key of ['query', 'platform', 'status', 'datePreset', 'createdFrom', 'createdTo', 'page']) params.delete(key);
    }
    navigate({ pathname: location.pathname, search: `?${params.toString()}` });
  };
  return <div className="page-stack purchase-local-import-page">
    <div className="page-title local-import-title">
      <div className="page-title-copy"><Title level={1}>本地导入图片</Title><Paragraph>登记本地产品媒体与采购信息，查询导入结果并送入 E000 审核。</Paragraph></div>
      <div className="local-import-contract"><span>来源目录</span><ArrowRightOutlined /><strong>内部 SKU</strong><ArrowRightOutlined /><span>E000 审核</span></div>
    </div>
    <Tabs className="local-import-view-tabs" activeKey={view} onChange={setView} items={[
      { key: 'import', label: '导入产品', children: <LocalImportCreateView onViewImported={(sku) => setView('history', sku)} /> },
      { key: 'history', label: '已导入产品清单', children: <LocalImportHistoryView active={view === 'history'} /> }
    ]} />
  </div>;
}

function LocalImportCreateView({ onViewImported }: { onViewImported: (sku: string) => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [currentPath, setCurrentPath] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [primary, setPrimary] = useState('');
  const [preview, setPreview] = useState<LocalImportPreview>();
  const [fields, setFields] = useState<LocalImportPreview['fields']>();
  const [result, setResult] = useState<LocalImportRecord>();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const directories = useQuery({ queryKey: ['local-import-directories', currentPath], queryFn: () => api.localImportDirectories(currentPath), retry: false });
  const previewMutation = useMutation({
    mutationFn: () => api.previewLocalImport(selected, primary),
    onSuccess: (value) => { setPreview(value); setFields(value.fields); setResult(undefined); },
    onError: (error: Error) => message.error(error instanceof ApiError ? error.userMessage : error.message)
  });
  const importMutation = useMutation({
    mutationFn: () => api.createLocalImport(preview!.token, idempotencyKey, fields!),
    onSuccess: ({ import: value }) => {
      setResult(value);
      void client.invalidateQueries({ queryKey: ['local-import-history'] });
      if (value.status === 'IMPORTED') message.success(`内部 SKU ${value.sku} 已导入 E000 候选目录`);
      else if (value.status === 'SKIPPED_DUPLICATE') message.warning(`商品 URL 已归属 SKU ${value.duplicateSku}，整次导入已跳过`);
      else if (value.status === 'COPY_FAILED_RETRYABLE') message.error('采购信息已登记，但媒体复制失败，可安全重试');
    },
    onError: (error: Error) => message.error(error instanceof ApiError ? error.userMessage : error.message)
  });
  const retryMutation = useMutation({
    mutationFn: () => api.retryLocalImport(result!.id),
    onSuccess: ({ import: value }) => { setResult(value); void client.invalidateQueries({ queryKey: ['local-import-history'] }); if (value.status === 'IMPORTED') message.success(`SKU ${value.sku} 的媒体复制已恢复`); },
    onError: (error: Error) => message.error(error instanceof ApiError ? error.userMessage : error.message)
  });
  const resetPreview = () => { setPreview(undefined); setFields(undefined); setResult(undefined); setIdempotencyKey(crypto.randomUUID()); };
  const toggleDirectory = (relativePath: string, checked: boolean) => {
    const platform = relativePath.split('/')[0]!.toLocaleLowerCase('en-US');
    if (checked && selected.some((item) => item.split('/')[0]!.toLocaleLowerCase('en-US') !== platform)) return void message.warning('一次导入只能选择同一平台的媒体目录');
    const next = checked ? [...selected, relativePath] : selected.filter((item) => item !== relativePath);
    setSelected(next);
    setPrimary(next.includes(primary) ? primary : next[0] || '');
    resetPreview();
  };
  const pathParts = currentPath ? currentPath.split('/') : [];
  const isSourceRoot = pathParts.length === 0;
  const isPlatformDirectory = pathParts.length === 1;
  const error = directories.error instanceof ApiError ? directories.error : undefined;
  const productNameValidation = validateLocalImportProductName(fields?.productName);
  return <div className="page-stack local-import-create-view">
    {error ? <Alert className="local-import-blocker" type="error" showIcon message="本地导入当前不可用" description={error.userMessage} action={<Button onClick={() => navigate('/settings/workflows?stage=E000')}>前往系统设置</Button>} /> : <>
      <div className="local-import-steps" aria-label="本地导入步骤"><span className={!preview ? 'active' : 'done'}>01 选择媒体目录</span><span className={preview && !result ? 'active' : preview ? 'done' : ''}>02 预览编辑</span><span className={result ? 'active' : ''}>03 确认导入</span></div>
      <Card className="local-import-card" title="选择媒体目录" extra={<Tag color="cyan">最多 20 个 · 同一平台</Tag>}>
        <div className="local-import-browser-layout">
          <div className="local-import-browser">
            <Breadcrumb items={[{ title: <button className="path-crumb" onClick={() => setCurrentPath('')}>来源根目录</button> }, ...pathParts.map((part, index) => ({ title: <button className="path-crumb" onClick={() => setCurrentPath(pathParts.slice(0, index + 1).join('/'))}>{part}</button> }))]} />
            <div className={`local-directory-list${isSourceRoot ? ' is-platform-root-list' : ''}${isPlatformDirectory ? ' is-product-media-list' : ''}`}>
              {isSourceRoot && !directories.isLoading && Boolean(directories.data?.directories.length) && <div className="local-directory-header is-platform-root-header" aria-hidden="true">
                <span>平台文件夹</span><span>子目录数</span><span className="modified-date-heading">最后修改时间 <ArrowDownOutlined /></span><span>操作</span>
              </div>}
              {isPlatformDirectory && !directories.isLoading && Boolean(directories.data?.directories.length) && <div className="local-directory-header is-product-media-header" aria-hidden="true">
                <span /><span>变体目录</span><span className="creation-date-heading">创建日期 <ArrowDownOutlined /></span><span>平台来源</span><span>操作</span>
              </div>}
              {directories.isLoading ? <Skeleton active paragraph={{ rows: 3 }} /> : directories.data?.directories.length ? directories.data.directories.map((directory) => <div className={`local-directory-row${isSourceRoot ? ' is-platform-root-row' : ''}${isPlatformDirectory ? ' is-product-media-row' : ''}`} key={directory.relativePath}>
                {!isSourceRoot && <Checkbox checked={selected.includes(directory.relativePath)} onChange={(event) => toggleDirectory(directory.relativePath, event.target.checked)} aria-label={`选择 ${directory.relativePath}`} />}
                <div className="local-directory-identity"><FolderOpenOutlined /><button className="directory-name" onClick={() => directory.hasChildren ? setCurrentPath(directory.relativePath) : undefined}>{directory.name}</button></div>
                {isSourceRoot && <span className="local-directory-child-count" data-label="子目录数">{directory.childDirectoryCount}</span>}
                {isSourceRoot && <time className="local-directory-modified-at" dateTime={directory.modifiedAt} data-label="最后修改时间">{formatLocalImportDirectoryDate(directory.modifiedAt)}</time>}
                {isPlatformDirectory && <time className="local-directory-created-at" dateTime={directory.createdAt} data-label="创建日期">{formatLocalImportDirectoryDate(directory.createdAt)}</time>}
                {!isSourceRoot && <div className="local-directory-platform" data-label="平台来源"><Tag>{directory.platform}</Tag></div>}
                <div className="local-directory-action" data-label="操作">{directory.hasChildren && <Button type="link" size="small" onClick={() => setCurrentPath(directory.relativePath)}>{isSourceRoot ? '导入产品媒体' : '打开'}</Button>}</div>
              </div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前目录没有可选子目录" />}
            </div>
          </div>
          <aside className="local-import-selection-panel">
            <div><Text strong>已选 {selected.length} 个目录</Text><Paragraph type="secondary">同一产品的多个颜色媒体目录可一起导入。</Paragraph></div>
            <div className="selection-tags">{selected.length ? selected.map((item) => <Tag closable key={item} onClose={(event) => { event.preventDefault(); toggleDirectory(item, false); }}>{item}</Tag>) : <Text type="secondary">尚未选择媒体目录</Text>}</div>
            <div className="primary-directory"><Text>采购信息主目录</Text><Select aria-label="采购信息主目录" value={primary || undefined} placeholder="请选择主目录" options={selected.map((value) => ({ value, label: value }))} onChange={(value) => { setPrimary(value); resetPreview(); }} /></div>
            <Button block type="primary" disabled={!selected.length || !primary} loading={previewMutation.isPending} onClick={() => previewMutation.mutate()}>预览并编辑</Button>
          </aside>
        </div>
      </Card>
      {preview && fields && <Card className="local-import-card" title="预览采购与媒体信息" extra={<Space><Tag color="blue">{preview.sources.length} 个目录</Tag><Tag color="geekblue">{preview.imageCount} 张图片</Tag><Tag>{preview.fileCount} 个业务文件</Tag></Space>}>
        <div className="local-source-summary">{preview.sources.map((source) => <div key={source.relativePath}><strong>{source.directoryName}</strong><span>{source.platform}</span>{source.isPrimary && <Tag color="cyan">主目录</Tag>}<small>{source.informationFileRelativePath || '无产品信息文件'} · {source.files.length} 个文件</small></div>)}</div>
        <div className="local-import-workflow-label"><Text>本次下载工作流</Text><Tooltip title="仅表示本地导入来源，不会启动 n8n"><Tag color="cyan">{preview.importWorkflowLabel}</Tag></Tooltip><Text type="secondary">来源标签 · 不创建下载任务</Text></div>
        <Form layout="vertical" className="local-import-form">
          <Form.Item
            label="产品名称"
            required
            validateStatus={productNameValidation.valid ? undefined : 'error'}
            help={productNameValidation.valid ? undefined : productNameValidation.message}
            extra="允许汉字、数字 0-9 及中文常用标点；保存时去除首尾空白。"
          >
            <Input
              aria-label="产品名称"
              aria-invalid={!productNameValidation.valid}
              value={fields.productName}
              suffix={<span className={`local-import-product-name-count${productNameValidation.valid ? '' : ' is-invalid'}`} aria-live="polite">{productNameValidation.length} / {LOCAL_IMPORT_PRODUCT_NAME_MAX_LENGTH}</span>}
              onChange={(event) => setFields({ ...fields, productName: event.target.value })}
            />
          </Form.Item>
          <div className={`local-import-price-flow is-${preview.priceConversion.status.toLowerCase()}`}>
            <Form.Item label="零售价格(RUB)" extra={preview.priceConversion.sourceCurrency === 'RUB' ? '来自产品信息文件，首次导入不可修改' : 'CNY 来源没有 RUB 零售价'}><Input aria-label="零售价格(RUB)" value={fields.retailPrice ?? ''} placeholder="—" addonAfter="RUB" readOnly /></Form.Item>
            <Form.Item label="汇率" extra="产品信息文件中的 Exchange"><Input aria-label="汇率" value={preview.priceConversion.exchangeRate ? `1 CNY = ${preview.priceConversion.exchangeRate} RUB` : '不适用或未提供'} readOnly /></Form.Item>
            <Form.Item label="国内采购价(CNY)" required extra={preview.priceConversion.status === 'CALCULATED' ? `自动计算值 ${preview.priceConversion.calculatedPurchasePrice}，可手动覆盖` : preview.priceConversion.status === 'NOT_REQUIRED' ? '直接使用来源 CNY 价格' : '请手动填写后再确认导入'}><Input aria-label="国内采购价(CNY)" value={fields.purchasePrice} addonAfter="CNY" status={isValidPurchasePrice(fields.purchasePrice) ? undefined : 'error'} onChange={(event) => setFields({ ...fields, purchasePrice: event.target.value })} /></Form.Item>
          </div>
          {preview.priceConversion.status === 'MANUAL_REQUIRED' && <Alert className="local-import-exchange-alert" type="warning" showIcon message={preview.priceConversion.issue === 'INVALID' ? 'Exchange 无效，无法自动换算' : '缺少 Exchange，无法自动换算'} description="系统不会使用默认汇率。请手动填写国内采购价(CNY)，有效后才能确认导入。" />}
          <Form.Item label="商品 URL" required><Input aria-label="商品 URL" value={fields.providerUrl} onChange={(event) => setFields({ ...fields, providerUrl: event.target.value })} /></Form.Item>
          <Row gutter={12}>{([['courierFee','快递费'],['productHeightCm','产品高(cm)'],['productDepthCm','产品深(cm)'],['productWidthCm','产品宽(cm)'],['netWeightGrams','净重(g)'],['grossWeightGrams','毛重(g)'],['lengthCm','包装长(cm)'],['widthCm','包装宽(cm)'],['heightCm','包装高(cm)']] as const).map(([key, label]) => <Col xs={12} md={8} lg={4} key={key}><Form.Item label={label}><Input value={fields[key] ?? ''} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} /></Form.Item></Col>)}</Row>
        </Form>
        <Alert type="info" showIcon message="外部 SKU 仅留作来源记录" description="系统将在确认时自动生成新的 7 位内部 SKU；本期不会创建下载任务，也不会关联 WB/OZON 上品流程。" />
        <Flex justify="end" gap={10} className="local-import-confirm"><Button onClick={() => { setPreview(undefined); setFields(undefined); }}>返回选择</Button><Button type="primary" loading={importMutation.isPending} disabled={Boolean(result) || !productNameValidation.valid || !isValidPurchasePrice(fields.purchasePrice)} onClick={() => importMutation.mutate()}>确认导入</Button></Flex>
      </Card>}
      {result && <Result className="local-import-result" status={result.status === 'IMPORTED' ? 'success' : result.status === 'SKIPPED_DUPLICATE' ? 'warning' : 'error'} title={localImportStatusMeta[result.status].label} subTitle={result.status === 'SKIPPED_DUPLICATE' ? `该商品 URL 已归属内部 SKU ${result.duplicateSku}，未创建新记录或复制媒体。` : result.status === 'IMPORTED' ? `内部 SKU ${result.sku} 已进入 E000 审核候选目录。` : result.errorMessage} extra={<Space wrap>{result.status === 'COPY_FAILED_RETRYABLE' && <Button type="primary" loading={retryMutation.isPending} onClick={() => retryMutation.mutate()}>重试媒体复制</Button>}{result.sku && <Button onClick={() => onViewImported(result.sku!)}>查看该产品</Button>}{result.status === 'IMPORTED' && <Button type="primary" onClick={() => navigate('/review/E000')}>前往 E000 审核</Button>}<Button onClick={() => { setSelected([]); setPrimary(''); resetPreview(); }}>开始下一次导入</Button></Space>} />}
    </>}
  </div>;
}

function LocalImportHistoryView({ active }: { active: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const page = Math.max(1, Number(params.get('page') || 1));
  const search = params.get('query') || '';
  const platform = params.get('platform') || undefined;
  const status = params.get('status') || undefined;
  const datePreset = (params.get('datePreset') || 'ALL') as PurchaseDatePreset;
  const createdFrom = params.get('createdFrom') || '';
  const createdTo = params.get('createdTo') || '';
  const [detailId, setDetailId] = useState<string>();
  const [editor, setEditor] = useState<LocalImportListItem>();
  const updateParams = (patch: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(location.search);
    next.set('view', 'history');
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (resetPage) next.set('page', '1');
    navigate({ pathname: location.pathname, search: `?${next.toString()}` }, { replace: true });
  };
  const queryParams = useMemo(() => {
    const value = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (search.trim()) value.set('query', search.trim());
    if (platform) value.set('platform', platform);
    if (status) value.set('status', status);
    if (createdFrom) value.set('createdFrom', createdFrom);
    if (createdTo) value.set('createdTo', createdTo);
    return value;
  }, [createdFrom, createdTo, page, platform, search, status]);
  const imports = useQuery({
    queryKey: ['local-import-history', queryParams.toString()], queryFn: () => api.localImports(queryParams), enabled: active, retry: false,
    refetchInterval: (query) => query.state.data?.items.some((item) => item.status === 'COPYING') ? 3000 : false
  });
  const detail = useQuery({ queryKey: ['local-import-detail', detailId], queryFn: () => api.localImport(detailId!), enabled: Boolean(detailId), retry: false });
  const retry = useMutation({
    mutationFn: (id: string) => api.retryLocalImport(id),
    onSuccess: ({ import: value }) => { message.success(value.status === 'IMPORTED' ? `SKU ${value.sku} 的媒体复制已恢复` : '已提交重试'); void client.invalidateQueries({ queryKey: ['local-import-history'] }); void client.invalidateQueries({ queryKey: ['local-import-detail', value.id] }); },
    onError: (error: Error) => message.error(error instanceof ApiError ? error.userMessage : error.message)
  });
  const setDatePreset = (value: PurchaseDatePreset) => {
    const today = dayjs().startOf('day');
    if (value === 'ALL') return updateParams({ datePreset: undefined, createdFrom: undefined, createdTo: undefined });
    if (value === 'CUSTOM') return updateParams({ datePreset: value, createdFrom: undefined, createdTo: undefined });
    const range = value === 'TODAY' ? [today, today.add(1, 'day')] : value === 'YESTERDAY' ? [today.subtract(1, 'day'), today] : [today.subtract(6, 'day'), today.add(1, 'day')];
    updateParams({ datePreset: value, createdFrom: range[0]!.toISOString(), createdTo: range[1]!.toISOString() });
  };
  const customRange: [Dayjs, Dayjs] | null = createdFrom && createdTo ? [dayjs(createdFrom), dayjs(createdTo).subtract(1, 'day')] : null;
  const reset = () => updateParams({ query: undefined, platform: undefined, status: undefined, datePreset: undefined, createdFrom: undefined, createdTo: undefined });
  if (imports.isError) return <Result status="warning" title="已导入产品清单暂不可用" subTitle={imports.error instanceof ApiError ? imports.error.userMessage : imports.error.message} extra={<Button type="primary" onClick={() => void imports.refetch()}>重新检测</Button>} />;
  const data = imports.data;
  return <div className="page-stack local-import-history-view">
    <Card className="filter-bar"><Flex wrap gap={10} align="center">
      <Input className="search-input" prefix={<SearchOutlined />} value={search} placeholder="搜索 SKU 或产品名" onChange={(event) => updateParams({ query: event.target.value || undefined })} allowClear />
      <Select value={datePreset} aria-label="导入日期" onChange={setDatePreset} style={{ width: 140 }} options={[{ value: 'ALL', label: '全部日期' }, { value: 'TODAY', label: '当天' }, { value: 'YESTERDAY', label: '昨天' }, { value: 'LAST_7_DAYS', label: '近 7 天' }, { value: 'CUSTOM', label: '时间段查询' }]} />
      {datePreset === 'CUSTOM' && <DatePicker.RangePicker value={customRange} onChange={(value) => updateParams({ createdFrom: value?.[0]?.startOf('day').toISOString(), createdTo: value?.[1]?.add(1, 'day').startOf('day').toISOString() })} allowClear placeholder={['开始日期', '结束日期']} />}
      <Select allowClear aria-label="来源平台" placeholder="来源平台" value={platform} onChange={(value) => updateParams({ platform: value })} style={{ width: 150 }} options={(data?.facets.platforms || []).map((item) => ({ value: item.value, label: `${item.value} · ${item.count}` }))} />
      <Select allowClear aria-label="导入状态" placeholder="导入状态" value={status} onChange={(value) => updateParams({ status: value })} style={{ width: 170 }} options={Object.entries(localImportStatusMeta).map(([value, item]) => ({ value, label: item.label }))} />
      <Button onClick={reset}>重置</Button><Text type="secondary">共 {data?.total || 0} 条导入记录</Text>
    </Flex></Card>
    <Card className="purchase-table-card local-import-history-card" bodyStyle={{ padding: 0 }}>
      <Table<LocalImportListItem> rowKey="id" loading={imports.isLoading} pagination={false} scroll={{ x: 1420 }} dataSource={data?.items || []} columns={[
        { title: 'SKU', width: 125, render: (_: unknown, item) => { const sku = item.sku || item.duplicateSku; return sku ? <span className="copy-value-inline"><span className="mono-badge">{sku}</span><CopyValueButton label="SKU" value={sku} /></span> : <Text type="secondary">未创建</Text>; } },
        { title: '产品与采购摘要', width: 350, render: (_: unknown, item) => item.purchase ? <div className="purchase-product-cell"><strong>{item.purchase.productName}</strong><LocalImportPriceSummary procurement={item.purchase.procurement} />{formatProductMeasurements(item.purchase.procurement) && <small>产品：{formatProductMeasurements(item.purchase.procurement)}</small>}<small>包装：{formatPackagingMeasurements(item.purchase.procurement)}</small></div> : <Text type="secondary">未创建采购产品</Text> },
        { title: '本次下载工作流', width: 190, render: (_: unknown, item) => <Tooltip title="仅表示本地导入来源，不会启动 n8n"><Tag color="cyan">{item.importWorkflowLabel || '来源平台未知'}</Tag></Tooltip> },
        { title: '来源目录', width: 170, render: (_: unknown, item) => <div className="local-import-source-cell"><Tag>{item.sourcePlatform || '未知平台'}</Tag><Text type="secondary">{item.sourceDirectoryCount} 个目录</Text></div> },
        { title: '商品 URL', width: 205, render: (_: unknown, item) => item.purchase?.procurement.providerUrl ? <a className="provider-url" href={item.purchase.procurement.providerUrl} target="_blank" rel="noreferrer">{urlLabel(item.purchase.procurement.providerUrl)}</a> : <Text type="secondary">—</Text> },
        { title: '导入状态', width: 165, render: (_: unknown, item) => <div className="local-import-status-cell"><Tag color={localImportStatusMeta[item.status].color}>{localImportStatusMeta[item.status].label}</Tag>{item.retryCount > 0 && <Text type="secondary">重试 {item.retryCount} 次</Text>}</div> },
        { title: '导入日期', width: 165, render: (_: unknown, item) => <Text>{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}</Text> },
        { title: '操作', width: 250, fixed: 'right', render: (_: unknown, item) => <Space wrap size={4}><Button size="small" icon={<EyeOutlined />} onClick={() => setDetailId(item.id)}>详情</Button>{item.sku && <Button size="small" icon={<EditOutlined />} onClick={() => setEditor(item)}>编辑</Button>}{item.status === 'COPY_FAILED_RETRYABLE' && <Button size="small" type="primary" loading={retry.isPending && retry.variables === item.id} onClick={() => retry.mutate(item.id)}>重试</Button>}{item.status === 'IMPORTED' && <Link to="/review/E000"><Button size="small">E000 审核</Button></Link>}{item.status === 'SKIPPED_DUPLICATE' && item.duplicateSku && <Link to={`/purchases/url-download?query=${encodeURIComponent(item.duplicateSku)}`}><Button size="small">查看原 SKU</Button></Link>}</Space> }
      ]} />
      <div className="purchase-pagination"><Pagination current={page} pageSize={50} total={data?.total || 0} showSizeChanger={false} onChange={(value) => updateParams({ page: String(value) }, false)} /></div>
    </Card>
    <Drawer open={Boolean(detailId)} width={760} onClose={() => setDetailId(undefined)} title={detail.data?.import ? `本地导入详情 · ${detail.data.import.sku || detail.data.import.duplicateSku || detail.data.import.id}` : '本地导入详情'}>{detail.isLoading ? <Skeleton active /> : detail.data?.import && <LocalImportDetailView record={detail.data.import} onRetry={(id) => retry.mutate(id)} onEdit={() => { const item = data?.items.find((candidate) => candidate.id === detail.data?.import.id); if (item?.sku) setEditor(item); }} />}</Drawer>
    <LocalImportPurchaseEditor record={editor} onClose={() => setEditor(undefined)} onSaved={(value) => { setEditor(undefined); void client.invalidateQueries({ queryKey: ['local-import-history'] }); void client.invalidateQueries({ queryKey: ['local-import-detail', value.id] }); }} />
  </div>;
}

function isLegacyLocalImportProcurement(procurement: PurchaseSummary['procurement']) {
  return procurement.currency.trim().toUpperCase() !== 'CNY';
}

function LocalImportPriceSummary({ procurement }: { procurement: PurchaseSummary['procurement'] }) {
  const legacy = isLegacyLocalImportProcurement(procurement);
  return <>
    <span>{legacy ? '历史采购价' : '国内采购价'} {formatPurchaseMoney(procurement.purchasePrice, procurement.currency)} · 快递 {formatPurchaseMoney(procurement.courierFee, procurement.currency)}</span>
    {procurement.retailPrice != null && procurement.retailPrice !== '' && <small className="local-import-retail-price">零售价格 RUB {Number(procurement.retailPrice).toFixed(2)}</small>}
    {legacy && <small className="local-import-legacy-price">旧版本保留原币种；编辑时需登记 CNY 国内采购价</small>}
  </>;
}

function LocalImportDetailView({ record, onRetry, onEdit }: { record: LocalImportRecord; onRetry?: (id: string) => void; onEdit: () => void }) {
  const purchase = record.purchase;
  const legacy = Boolean(purchase && isLegacyLocalImportProcurement(purchase.procurement));
  return <div className="page-stack local-import-detail">
    {legacy && <Alert type="warning" showIcon message="这是旧版 RUB 采购数据" description="历史采购版本不会被自动改写。编辑时系统会把旧采购价带入零售价格，并要求填写新的国内采购价(CNY)。" />}
    <Descriptions title="当前采购信息" bordered size="small" column={2} items={purchase ? [
      { key: 'sku', label: '内部 SKU', children: <span className="copy-value-inline"><span className="mono-badge">{purchase.sku}</span><CopyValueButton label="SKU" value={purchase.sku} /></span> },
      { key: 'name', label: '产品名', children: purchase.productName },
      { key: 'price', label: legacy ? '历史采购价' : '国内采购价(CNY)', children: formatPurchaseMoney(purchase.procurement.purchasePrice, purchase.procurement.currency) },
      { key: 'retail', label: '零售价格(RUB)', children: purchase.procurement.retailPrice != null && purchase.procurement.retailPrice !== '' ? `RUB ${Number(purchase.procurement.retailPrice).toFixed(2)}` : '—' },
      { key: 'courier', label: '快递费', children: formatPurchaseMoney(purchase.procurement.courierFee, purchase.procurement.currency) },
      { key: 'product', label: '产品尺寸/净重', children: formatProductMeasurements(purchase.procurement) || '—' },
      { key: 'package', label: '包装尺寸/毛重', children: formatPackagingMeasurements(purchase.procurement) || '—' },
      { key: 'url', label: '当前商品 URL', span: 2, children: <a href={purchase.procurement.providerUrl} target="_blank" rel="noreferrer">{purchase.procurement.providerUrl}</a> }
    ] : [{ key: 'none', label: '采购产品', span: 2, children: '本次 URL 重复已跳过，未创建新产品' }]} />
    <Descriptions title="导入来源信息" bordered size="small" column={2} items={[
      { key: 'workflow', label: '本次下载工作流', children: <Tooltip title="仅表示本地导入来源，不会启动 n8n"><Tag color="cyan">{record.importWorkflowLabel || '来源平台未知'}</Tag></Tooltip> },
      { key: 'platform', label: '来源平台', children: record.sourcePlatform || '未知平台' },
      { key: 'status', label: '导入状态', children: <Tag color={localImportStatusMeta[record.status].color}>{localImportStatusMeta[record.status].label}</Tag> },
      { key: 'date', label: '导入日期', children: dayjs(record.createdAt).format('YYYY-MM-DD HH:mm:ss') },
      { key: 'target', label: '目标目录', span: 2, children: record.targetFolder ? <span className="copy-value-inline"><Text>{record.targetFolder}</Text><CopyValueButton label="目标目录" value={record.targetFolder} /></span> : '—' },
      ...(record.errorMessage ? [{ key: 'error', label: '错误信息', span: 2, children: <Text type="danger">{record.errorMessage}</Text> }] : [])
    ]} />
    <Card size="small" title={`来源目录 · ${record.sources.length}`}><List dataSource={record.sources} locale={{ emptyText: record.status === 'SKIPPED_DUPLICATE' ? '重复跳过记录未登记新的媒体来源' : '没有来源目录' }} renderItem={(source) => <List.Item><div className="local-import-source-detail"><Space wrap><strong>{source.relativePath}</strong>{source.isPrimary && <Tag color="cyan">主目录</Tag>}<Tag>{source.platform}</Tag></Space><Text type="secondary">外部 SKU：{source.externalSku || '—'} · 信息文件：{source.informationFileRelativePath || '—'}</Text>{source.informationFileSha256 && <Text className="mono-text" type="secondary">SHA-256：{source.informationFileSha256}</Text>}{source.providerUrl && <a href={source.providerUrl} target="_blank" rel="noreferrer">{source.providerUrl}</a>}<Text type="secondary">目标子目录：{source.targetSubdirectory}</Text></div></List.Item>} /></Card>
    <Flex justify="end" gap={8}>{record.status === 'COPY_FAILED_RETRYABLE' && onRetry && <Button type="primary" onClick={() => onRetry(record.id)}>重试媒体复制</Button>}{record.sku && <Button icon={<EditOutlined />} onClick={onEdit}>编辑采购信息</Button>}</Flex>
  </div>;
}

type LocalImportPurchaseEditorRecord = Pick<LocalImportRecord, 'id' | 'importWorkflowLabel' | 'purchase'>;

function LocalImportPurchaseEditor({ record, onClose, onSaved }: { record?: LocalImportPurchaseEditorRecord; onClose: () => void; onSaved: (value: LocalImportRecord) => void }) {
  const [form] = Form.useForm<Omit<PurchaseInput, 'downloadWorkflowCode'>>();
  useEffect(() => {
    if (!record?.purchase) return;
    const procurement = record.purchase.procurement;
    const legacy = isLegacyLocalImportProcurement(procurement);
    form.resetFields();
    form.setFieldsValue({
      productName: record.purchase.productName, purchasePrice: legacy ? '' : procurement.purchasePrice,
      retailPrice: legacy ? procurement.purchasePrice : procurement.retailPrice, courierFee: procurement.courierFee,
      currency: 'CNY', providerUrl: procurement.providerUrl, grossWeightGrams: procurement.grossWeightGrams,
      lengthCm: procurement.lengthCm, widthCm: procurement.widthCm, heightCm: procurement.heightCm,
      netWeightGrams: procurement.netWeightGrams, productHeightCm: procurement.productHeightCm,
      productDepthCm: procurement.productDepthCm, productWidthCm: procurement.productWidthCm
    });
  }, [form, record]);
  const save = useMutation({
    mutationFn: (input: Omit<PurchaseInput, 'downloadWorkflowCode'>) => api.updateLocalImportPurchase(record!.id, { ...input, currency: 'CNY' }),
    onSuccess: ({ import: value }) => { message.success('采购信息已保存，新版本已创建'); onSaved(value); },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'PRODUCT_URL_ALREADY_EXISTS') {
        const sku = typeof error.details === 'object' && error.details && 'sku' in error.details ? String(error.details.sku) : '';
        form.setFields([{ name: 'providerUrl', errors: [sku ? `产品 URL 已归属 SKU ${sku}` : '产品 URL 已被使用'] }]);
      }
      message.error(error instanceof ApiError ? error.userMessage : error.message);
    }
  });
  const legacy = Boolean(record?.purchase && isLegacyLocalImportProcurement(record.purchase.procurement));
  return <Drawer open={Boolean(record)} width={720} onClose={onClose} title={record?.purchase ? `编辑采购信息 · ${record.purchase.sku}` : '编辑采购信息'} destroyOnHidden>
    {record?.purchase && <Form form={form} layout="vertical" onFinish={(value) => save.mutate(value)}>
      <Alert type="info" showIcon message={`本次下载工作流：${record.importWorkflowLabel || '来源平台未知'}`} description="该值是不可变的本地导入来源标签；保存采购信息不会重新复制媒体或启动 n8n。" />
      {legacy && <Alert className="local-import-legacy-editor-alert" type="warning" showIcon message="旧 RUB 版本将转换为新的 CNY 采购版本" description="零售价格已从旧采购价带入；请填写国内采购价后保存。旧版本不会被修改。" />}
      <Form.Item label="产品名称" name="productName" rules={[{ required: true, message: '请输入产品名称' }]}><Input /></Form.Item>
      <div className="local-import-editor-price-grid">
        <Form.Item label="零售价格(RUB)" name="retailPrice" rules={[{ pattern: /^\d+(?:\.\d+)?$/, message: '请输入非负数字' }]}><Input addonAfter="RUB" /></Form.Item>
        <Form.Item label="国内采购价(CNY)" name="purchasePrice" rules={[{ required: true, message: '请输入国内采购价' }, { pattern: /^\d+(?:\.\d+)?$/, message: '请输入非负数字' }]}><Input addonAfter="CNY" /></Form.Item>
      </div>
      <Form.Item name="currency" hidden><Input /></Form.Item>
      <Form.Item label="商品 URL" name="providerUrl" rules={[{ required: true, message: '请输入商品 URL' }, { type: 'url', message: '请输入有效 URL' }]}><Input /></Form.Item>
      <Row gutter={12}>{([['courierFee','快递费'],['productHeightCm','产品高(cm)'],['productDepthCm','产品深(cm)'],['productWidthCm','产品宽(cm)'],['netWeightGrams','净重(g)'],['grossWeightGrams','毛重(g)'],['lengthCm','包装长(cm)'],['widthCm','包装宽(cm)'],['heightCm','包装高(cm)']] as const).map(([key, label]) => <Col xs={12} md={8} lg={4} key={key}><Form.Item label={label} name={key}><Input /></Form.Item></Col>)}</Row>
      <Flex justify="end" gap={8}><Button onClick={onClose}>取消</Button><Button type="primary" htmlType="submit" loading={save.isPending}>保存采购信息</Button></Flex>
    </Form>}
  </Drawer>;
}

function PurchaseProductQueryPage() {
  const client = useQueryClient();
  const location = useLocation();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(() => new URLSearchParams(location.search).get('query') || '');
  const [entryMethodKey, setEntryMethodKey] = useState<string>();
  const [datePreset, setDatePreset] = useState<PurchaseDatePreset>('ALL');
  const [customCreatedRange, setCustomCreatedRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [detailItem, setDetailItem] = useState<PurchaseSummary>();
  const [editor, setEditor] = useState<PurchaseSummary>();
  const params = useMemo(() => {
    const value = new URLSearchParams({ page: String(page), pageSize: '50', sort: 'RECORDED_DESC' });
    if (search.trim()) value.set('query', search.trim());
    if (entryMethodKey) value.set('entryMethodKey', entryMethodKey);
    let createdRange: [Dayjs, Dayjs] | undefined;
    const today = dayjs().startOf('day');
    if (datePreset === 'TODAY') createdRange = [today, today.add(1, 'day')];
    if (datePreset === 'YESTERDAY') createdRange = [today.subtract(1, 'day'), today];
    if (datePreset === 'LAST_7_DAYS') createdRange = [today.subtract(6, 'day'), today.add(1, 'day')];
    if (datePreset === 'CUSTOM' && customCreatedRange) createdRange = [customCreatedRange[0].startOf('day'), customCreatedRange[1].add(1, 'day').startOf('day')];
    if (createdRange) {
      value.set('createdFrom', createdRange[0].toISOString());
      value.set('createdTo', createdRange[1].toISOString());
    }
    return value;
  }, [customCreatedRange, datePreset, entryMethodKey, page, search]);
  const purchases = useQuery({ queryKey: ['purchases', 'query', params.toString()], queryFn: () => api.purchases(params), retry: false });
  const workflowConfig = useQuery({ queryKey: ['config'], queryFn: api.config });
  const workflows = useQuery({ queryKey: ['download-workflows', 'all'], queryFn: () => api.downloadWorkflows(true), enabled: purchases.isSuccess, retry: false });
  const purchaseDetail = useQuery({
    queryKey: ['purchase-query-detail', detailItem?.sku], queryFn: () => api.purchase(detailItem!.sku),
    enabled: Boolean(detailItem && detailItem.entryOrigin.sourceType !== 'LOCAL_IMPORT'), retry: false
  });
  const localImportDetail = useQuery({
    queryKey: ['purchase-query-local-import-detail', detailItem?.entryOrigin.sourceId],
    queryFn: () => api.localImport(detailItem!.entryOrigin.sourceId!),
    enabled: Boolean(detailItem?.entryOrigin.sourceType === 'LOCAL_IMPORT' && detailItem.entryOrigin.sourceId), retry: false
  });
  const reset = () => {
    setPage(1); setSearch(''); setEntryMethodKey(undefined); setDatePreset('ALL'); setCustomCreatedRange(null);
  };
  if (purchases.isError) {
    const databaseUnavailable = purchases.error.message.startsWith('DATABASE_UNAVAILABLE:');
    return <Result status="warning" title={databaseUnavailable ? 'PostgreSQL 尚未连接' : '采购商品查询暂不可用'} subTitle={databaseUnavailable ? '请检查本地服务的 DATABASE_URL 配置，重启服务后再重新检测。' : purchases.error.message} extra={<Button type="primary" onClick={() => void purchases.refetch()}>重新检测</Button>} />;
  }
  const configuredStages = workflowConfig.data?.config.stages || [];
  const workflowLabelByCode = new Map((workflows.data?.items || []).map((item) => {
    const stage = configuredStages.find((candidate) => candidate.id === item.code);
    return [item.code, `${workflowLabel(stage, item.code)} · ${stage?.displayName || item.displayName}`] as const;
  }));
  configuredStages.filter((stage) => stage.download).forEach((stage) => {
    if (!workflowLabelByCode.has(stage.id)) workflowLabelByCode.set(stage.id, `${workflowLabel(stage)} · ${stage.displayName}`);
  });
  const localEditorRecord: LocalImportPurchaseEditorRecord | undefined = editor?.entryOrigin.sourceType === 'LOCAL_IMPORT' && editor.entryOrigin.sourceId ? {
    id: editor.entryOrigin.sourceId,
    importWorkflowLabel: editor.entryOrigin.label,
    purchase: {
      sku: editor.sku, productName: editor.productName, variants: editor.variants,
      createdAt: editor.createdAt, updatedAt: editor.updatedAt, procurement: editor.procurement
    }
  } : undefined;
  const methodOptions = (purchases.data?.facets.entryMethods || []).map((item) => ({ value: item.value, label: `${item.label} · ${item.count}` }));
  return <div className="page-stack purchase-page purchase-product-query-page">
    <PageTitle eyebrow="PROCUREMENT CATALOG" title="采购商品查询" description="查询所有已录入本地数据库的采购产品、录入来源和本地媒体目录。" />
    <Card className="filter-bar"><Flex wrap gap={10} align="center">
      <Input className="search-input" prefix={<SearchOutlined />} value={search} placeholder="搜索 SKU 或产品名" onChange={(event) => { setPage(1); setSearch(event.target.value); }} allowClear />
      <Select value={datePreset} aria-label="录入日期" onChange={(value) => { setPage(1); setDatePreset(value); if (value !== 'CUSTOM') setCustomCreatedRange(null); }} style={{ width: 140 }} options={[{ value: 'ALL', label: '全部日期' }, { value: 'TODAY', label: '当天' }, { value: 'YESTERDAY', label: '昨天' }, { value: 'LAST_7_DAYS', label: '最近7天' }, { value: 'CUSTOM', label: '时间段查询' }]} />
      {datePreset === 'CUSTOM' && <DatePicker.RangePicker value={customCreatedRange} onChange={(value) => { setPage(1); setCustomCreatedRange(value as [Dayjs, Dayjs] | null); }} allowClear placeholder={['开始日期', '结束日期']} />}
      <Select allowClear aria-label="录入方式" placeholder="录入方式" value={entryMethodKey} onChange={(value) => { setPage(1); setEntryMethodKey(value); }} style={{ width: 220 }} options={methodOptions} />
      <Button onClick={reset}>重置</Button><Text type="secondary">共 {purchases.data?.total || 0} 条采购商品</Text>
    </Flex></Card>
    <Card className="purchase-table-card" bodyStyle={{ padding: 0 }}>
      <Table<PurchaseSummary> rowKey="sku" loading={purchases.isLoading} pagination={false} scroll={{ x: 1780 }} dataSource={purchases.data?.items || []} columns={[
        { title: 'SKU', dataIndex: 'sku', width: 118, render: (value: string) => <span className="copy-value-inline"><span className="mono-badge">{value}</span><CopyValueButton label="SKU" value={value} /></span> },
        { title: '产品与采购摘要', width: 330, render: (_: unknown, item) => { const productMeasurements = formatProductMeasurements(item.procurement); return <div className="purchase-product-cell"><strong className="copy-value-inline"><span>{item.productName}</span><CopyValueButton label="产品名" value={item.productName} /></strong><span>{formatPurchaseMoney(item.procurement.purchasePrice, item.procurement.currency)} · 快递 {formatPurchaseMoney(item.procurement.courierFee, item.procurement.currency)}</span>{productMeasurements && <small>产品：{productMeasurements}</small>}<small>包装：{formatPackagingMeasurements(item.procurement)}</small><small>{item.variants?.length || 1} 个产品变体</small></div>; } },
        { title: '录入方式', width: 190, render: (_: unknown, item) => <Tag color={item.entryOrigin.sourceType === 'OTHER' ? 'default' : 'cyan'}>{item.entryOrigin.label}</Tag> },
        { title: '导入平台', width: 120, render: (_: unknown, item) => item.entryOrigin.platform ? <Tag>{item.entryOrigin.platform}</Tag> : <Text type="secondary">未标记</Text> },
        { title: '产品URL', width: 230, render: (_: unknown, item) => <a className="provider-url" href={item.procurement.providerUrl} target="_blank" rel="noreferrer">{urlLabel(item.procurement.providerUrl)}</a> },
        { title: '本地媒体文件夹', width: 320, render: (_: unknown, item) => item.localMediaFolder ? <span className="copy-value-inline purchase-query-folder"><Text ellipsis={{ tooltip: item.localMediaFolder }}>{item.localMediaFolder}</Text><CopyValueButton label="本地媒体文件夹" value={item.localMediaFolder} /></span> : <Text type="secondary">尚未生成</Text> },
        { title: '录入日期', width: 165, render: (_: unknown, item) => dayjs(item.entryOrigin.recordedAt).format('YYYY-MM-DD HH:mm') },
        { title: '操作', width: 150, fixed: 'right', render: (_: unknown, item) => { const editable = item.entryOrigin.sourceType !== 'OTHER'; return <Space size={4}><Button size="small" icon={<EyeOutlined />} onClick={() => setDetailItem(item)}>详情</Button><Tooltip title={editable ? undefined : '该录入方式暂未注册编辑入口'}><span><Button size="small" icon={<EditOutlined />} disabled={!editable} onClick={() => setEditor(item)}>编辑</Button></span></Tooltip></Space>; } }
      ]} />
      <div className="purchase-pagination"><Pagination current={page} pageSize={50} total={purchases.data?.total || 0} showSizeChanger={false} onChange={setPage} /></div>
    </Card>
    <Drawer open={Boolean(detailItem)} width={760} onClose={() => setDetailItem(undefined)} title={detailItem ? `采购商品详情 · ${detailItem.sku}` : '采购商品详情'}>
      {detailItem?.entryOrigin.sourceType === 'LOCAL_IMPORT' ? localImportDetail.isLoading ? <Skeleton active /> : localImportDetail.data?.import ? <LocalImportDetailView record={{ ...localImportDetail.data.import, importWorkflowLabel: detailItem.entryOrigin.label }} onEdit={() => setEditor(detailItem)} /> : <Result status="warning" title="本地导入详情不可用" /> : purchaseDetail.isLoading ? <Skeleton active /> : purchaseDetail.data?.purchase && <div className="page-stack"><PurchaseQueryOriginSummary item={detailItem!} /><PurchaseDetailView purchase={purchaseDetail.data.purchase} /></div>}
    </Drawer>
    <LocalImportPurchaseEditor record={localEditorRecord} onClose={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); void client.invalidateQueries({ queryKey: ['purchases'] }); }} />
    {editor?.entryOrigin.sourceType === 'URL_DOWNLOAD' && <PurchaseEditorDrawer open purchase={editor} workflows={workflows.data?.items || []} workflowsLoading={workflows.isLoading} workflowLabels={workflowLabelByCode} onClose={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); void client.invalidateQueries({ queryKey: ['purchases'] }); }} />}
  </div>;
}

function PurchaseQueryOriginSummary({ item }: { item: PurchaseSummary }) {
  return <Descriptions title="录入来源" bordered size="small" column={2} items={[
    { key: 'method', label: '录入方式', children: <Tag color={item.entryOrigin.sourceType === 'OTHER' ? 'default' : 'cyan'}>{item.entryOrigin.label}</Tag> },
    { key: 'platform', label: '导入平台', children: item.entryOrigin.platform || '未标记' },
    { key: 'date', label: '录入日期', children: dayjs(item.entryOrigin.recordedAt).format('YYYY-MM-DD HH:mm:ss') },
    { key: 'workflow', label: '工作流', children: item.entryOrigin.workflowCode || '不适用' },
    { key: 'folder', label: '本地媒体文件夹', span: 2, children: item.localMediaFolder ? <span className="copy-value-inline"><Text>{item.localMediaFolder}</Text><CopyValueButton label="本地媒体文件夹" value={item.localMediaFolder} /></span> : '尚未生成' }
  ]} />;
}

function PurchasePage() {
  const client = useQueryClient();
  const location = useLocation();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(() => new URLSearchParams(location.search).get('query') || '');
  const [status, setStatus] = useState<string>();
  const [workflowCode, setWorkflowCode] = useState<string>();
  const [datePreset, setDatePreset] = useState<PurchaseDatePreset>('ALL');
  const [customCreatedRange, setCustomCreatedRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [editor, setEditor] = useState<PurchaseSummary>();
  const [detailSku, setDetailSku] = useState<string>();
  const [draft, setDraft] = useState<PurchaseBatchDraftItem[]>(readPurchaseBatchDraft);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bulkWorkflow, setBulkWorkflow] = useState<string>();
  const [activeBatchId, setActiveBatchId] = useState(() => sessionStorage.getItem(PURCHASE_BATCH_ACTIVE_KEY) || '');
  const params = useMemo(() => {
    const value = new URLSearchParams({ page: String(page), pageSize: '50', source: 'URL_DOWNLOAD' });
    if (search.trim()) value.set('query', search.trim());
    if (status) value.set('status', status);
    if (workflowCode) value.set('workflowCode', workflowCode);
    let createdRange: [Dayjs, Dayjs] | undefined;
    const today = dayjs().startOf('day');
    if (datePreset === 'TODAY') createdRange = [today, today.add(1, 'day')];
    if (datePreset === 'YESTERDAY') createdRange = [today.subtract(1, 'day'), today];
    if (datePreset === 'LAST_7_DAYS') createdRange = [today.subtract(6, 'day'), today.add(1, 'day')];
    if (datePreset === 'CUSTOM' && customCreatedRange) createdRange = [customCreatedRange[0].startOf('day'), customCreatedRange[1].add(1, 'day').startOf('day')];
    if (createdRange) {
      value.set('createdFrom', createdRange[0].toISOString());
      value.set('createdTo', createdRange[1].toISOString());
    }
    return value;
  }, [customCreatedRange, datePreset, page, search, status, workflowCode]);
  const purchases = useQuery({
    queryKey: ['purchases', params.toString()], queryFn: () => api.purchases(params), retry: false,
    refetchInterval: (query) => query.state.data?.items.some((item) => activePurchaseDownloadStatuses.has(item.latestDownloadJob?.status || '')) || Boolean(activeBatchId) ? 3000 : false
  });
  const workflowConfig = useQuery({ queryKey: ['config'], queryFn: api.config });
  const workflows = useQuery({ queryKey: ['download-workflows', 'all'], queryFn: () => api.downloadWorkflows(true), enabled: purchases.isSuccess, retry: false });
  const detail = useQuery({ queryKey: ['purchase', detailSku], queryFn: () => api.purchase(detailSku!), enabled: purchases.isSuccess && Boolean(detailSku), retry: false });
  const batch = useQuery({ queryKey: ['purchase-download-batch', activeBatchId], queryFn: () => api.purchaseDownloadBatch(activeBatchId), enabled: Boolean(activeBatchId), retry: false, refetchInterval: (query) => query.state.data?.batch.status === 'COMPLETED' ? false : 3000 });
  const activeWorkflows = (workflows.data?.items || []).filter((item) => item.enabled);
  const activeWorkflowCodes = new Set(activeWorkflows.map((item) => item.code));
  useEffect(() => { sessionStorage.setItem(PURCHASE_BATCH_DRAFT_KEY, JSON.stringify(draft)); }, [draft]);
  useEffect(() => {
    const query = new URLSearchParams(location.search).get('query');
    if (query !== null) { setPage(1); setSearch(query); }
  }, [location.search]);
  useEffect(() => {
    if (batch.data?.batch.status === 'COMPLETED') void client.invalidateQueries({ queryKey: ['purchases'] });
  }, [batch.data?.batch.status, client]);
  const reset = () => { setPage(1); setSearch(''); setStatus(undefined); setWorkflowCode(undefined); setDatePreset('ALL'); setCustomCreatedRange(null); };
  const assign = (item: PurchaseSummary, selected: boolean) => {
    setDraft((current) => selected
      ? current.some((entry) => entry.sku === item.sku) ? current : [...current, { sku: item.sku, productName: item.productName, workflowCode: item.procurement.downloadWorkflowCode || '', selectedAt: Date.now() }]
      : current.filter((entry) => entry.sku !== item.sku));
  };
  const updateDraftWorkflow = (sku: string, code: string) => setDraft((current) => current.map((item) => item.sku === sku ? { ...item, workflowCode: code } : item));
  const queueBatch = useMutation({
    mutationFn: () => api.enqueuePurchaseDownloadBatch(draft.map(({ sku, workflowCode: code }) => ({ sku, workflowCode: code }))),
    onSuccess: (result) => {
      setConfirmOpen(false); setDraft([]); setActiveBatchId(result.batchId); sessionStorage.setItem(PURCHASE_BATCH_ACTIVE_KEY, result.batchId);
      message.success(`${result.queued.length} 条下载任务已进入串行队列${result.skipped.length ? `，${result.skipped.length} 条已跳过` : ''}`);
      void client.invalidateQueries({ queryKey: ['purchases'] }); void client.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error: Error) => message.error(error.message)
  });

  if (purchases.isError) {
    const databaseUnavailable = purchases.error.message.startsWith('DATABASE_UNAVAILABLE:');
    return <Result status="warning" title={databaseUnavailable ? 'PostgreSQL 尚未连接' : '产品URL下载暂不可用'} subTitle={databaseUnavailable ? '请在项目根目录的 .env 中配置 DATABASE_URL，重启服务后再重新检测。页面已停止自动重试。' : purchases.error.message} extra={<Button type="primary" onClick={() => void purchases.refetch()}>重新检测</Button>} />;
  }
  const configuredStages = workflowConfig.data?.config.stages || [];
  const workflowLabelByCode = new Map((workflows.data?.items || []).map((item) => {
    const stage = configuredStages.find((candidate) => candidate.id === item.code);
    return [item.code, `${workflowLabel(stage, item.code)} · ${stage?.displayName || item.displayName}`] as const;
  }));
  configuredStages.filter((stage) => stage.download).forEach((stage) => {
    if (!workflowLabelByCode.has(stage.id)) workflowLabelByCode.set(stage.id, `${workflowLabel(stage)} · ${stage.displayName}`);
  });
  const workflowOptions = activeWorkflows.map((item) => ({ value: item.code, label: workflowLabelByCode.get(item.code) || item.code }));
  const invalidDraftCount = draft.filter((item) => !activeWorkflowCodes.has(item.workflowCode)).length;
  return <div className="page-stack purchase-page">
    <PageTitle eyebrow="PROCUREMENT LEDGER" title="产品URL下载" description="管理采购信息，通过产品 URL 调用工作流下载产品图片到本地。" extra={<Space wrap><Link to="/settings?section=download"><Button icon={<ApiOutlined />}>下载工作流配置</Button></Link><Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor({} as PurchaseSummary)}>新建采购产品</Button></Space>} />
    {batch.data?.batch && <BatchProgressCard batch={batch.data.batch} onDismiss={() => { setActiveBatchId(''); sessionStorage.removeItem(PURCHASE_BATCH_ACTIVE_KEY); }} />}
    <Card className="filter-bar"><Flex wrap gap={10} align="center"><Input className="search-input" prefix={<SearchOutlined />} value={search} placeholder="搜索 SKU 或产品名" onChange={(event) => { setPage(1); setSearch(event.target.value); }} allowClear /><Select value={datePreset} aria-label="新建日期" onChange={(value) => { setPage(1); setDatePreset(value); if (value !== 'CUSTOM') setCustomCreatedRange(null); }} style={{ width: 140 }} options={[{ value: 'ALL', label: '全部日期' }, { value: 'TODAY', label: '当天' }, { value: 'YESTERDAY', label: '昨天' }, { value: 'LAST_7_DAYS', label: '近 7 天' }, { value: 'CUSTOM', label: '时间段查询' }]} />{datePreset === 'CUSTOM' && <DatePicker.RangePicker value={customCreatedRange} onChange={(value) => { setPage(1); setCustomCreatedRange(value as [Dayjs, Dayjs] | null); }} allowClear placeholder={['开始日期', '结束日期']} />}<Select allowClear placeholder="下载状态" value={status} onChange={(value) => { setPage(1); setStatus(value); }} style={{ width: 130 }} options={Object.entries(purchaseJobMeta).map(([value, item]) => ({ value, label: item.label }))} /><Select allowClear placeholder="下载工作流" value={workflowCode} onChange={(value) => { setPage(1); setWorkflowCode(value); }} style={{ width: 180 }} options={workflowOptions} /><Button onClick={reset}>重置</Button><Text type="secondary">共 {purchases.data?.total || 0} 条采购记录</Text></Flex></Card>
    {draft.length > 0 && <Card className="batch-action-bar"><Flex align="center" justify="space-between" wrap gap={14}><div><span className="batch-count">{draft.length}</span><Text> 条采购信息已加入本次下载</Text><Text type="secondary"> · 按勾选顺序串行执行</Text>{invalidDraftCount > 0 && <div><Text type="danger">{invalidDraftCount} 条任务的工作流已停用，请重新选择</Text></div>}</div><Space wrap><Select placeholder="批量修改工作流" value={bulkWorkflow} onChange={(value) => { setBulkWorkflow(value); setDraft((items) => items.map((item) => ({ ...item, workflowCode: value }))); }} style={{ width: 210 }} options={workflowOptions} /><Button onClick={() => setDraft([])}>清空选择</Button><Button type="primary" icon={<CloudDownloadOutlined />} disabled={invalidDraftCount > 0} onClick={() => setConfirmOpen(true)}>批量执行下载</Button></Space></Flex></Card>}
    <Card className="purchase-table-card" bodyStyle={{ padding: 0 }}>
      <Table<PurchaseSummary> rowKey="sku" loading={purchases.isLoading} pagination={false} scroll={{ x: 1260 }} dataSource={purchases.data?.items || []} rowSelection={{
        selectedRowKeys: draft.map((item) => item.sku), preserveSelectedRowKeys: true,
        getCheckboxProps: (item) => { const workflowAvailable = Boolean(item.procurement.downloadWorkflowCode && activeWorkflowCodes.has(item.procurement.downloadWorkflowCode)); const activeJob = activePurchaseDownloadStatuses.has(item.latestDownloadJob?.status || ''); return { disabled: !workflowAvailable || activeJob, title: !workflowAvailable ? '工作流不可用，请先编辑采购产品' : activeJob ? '该产品已有正在执行或等待资源的下载任务' : undefined }; },
        onSelect: (item, selected) => assign(item, selected),
        onSelectAll: (selected, _rows, changedRows) => changedRows.forEach((item) => assign(item, selected))
      }} columns={[
        { title: 'SKU', dataIndex: 'sku', width: 118, render: (value: string) => <span className="copy-value-inline"><span className="mono-badge">{value}</span><CopyValueButton label="SKU" value={value} /></span> },
        { title: '产品与采购摘要', width: 310, render: (_: unknown, item) => { const productMeasurements = formatProductMeasurements(item.procurement); return <div className="purchase-product-cell"><strong className="copy-value-inline"><span>{item.productName}</span><CopyValueButton label="产品名" value={item.productName} /></strong><span>{formatPurchaseMoney(item.procurement.purchasePrice, item.procurement.currency)} · 快递 {formatPurchaseMoney(item.procurement.courierFee, item.procurement.currency)}</span>{productMeasurements && <small>产品：{productMeasurements}</small>}<small>包装：{formatPackagingMeasurements(item.procurement)}</small><small>{item.variants?.length || 1} 个产品变体</small></div>; } },
        { title: '本次下载工作流', width: 235, render: (_: unknown, item) => { const selected = draft.find((entry) => entry.sku === item.sku); const savedCode = item.procurement.downloadWorkflowCode; const available = Boolean(savedCode && activeWorkflowCodes.has(savedCode)); return selected ? <Select aria-label={`${item.sku} 本次下载工作流`} size="small" value={selected.workflowCode} onChange={(value) => updateDraftWorkflow(item.sku, value)} style={{ width: '100%' }} options={workflowOptions} status={activeWorkflowCodes.has(selected.workflowCode) ? undefined : 'error'} /> : available ? <div className="purchase-workflow-cell"><Tag color="cyan">{savedCode}</Tag><Text title={workflowLabelByCode.get(savedCode!)}>{workflowLabelByCode.get(savedCode!)}</Text></div> : <Tooltip title="工作流不可用，请先编辑采购产品"><Tag color="error">{savedCode || '未配置'} · 不可用</Tag></Tooltip>; } },
        { title: '产品 URL', width: 200, render: (_: unknown, item) => <a className="provider-url" href={item.procurement.providerUrl} target="_blank" rel="noreferrer">{urlLabel(item.procurement.providerUrl)}</a> },
        { title: '最近下载任务', width: 270, render: (_: unknown, item) => <LatestDownloadJob job={item.latestDownloadJob} /> },
        { title: '操作', width: 145, fixed: 'right', render: (_: unknown, item) => <Space><Button size="small" icon={<EyeOutlined />} onClick={() => setDetailSku(item.sku)}>详情</Button><Button size="small" icon={<EditOutlined />} onClick={() => setEditor(item)}>编辑</Button></Space> }
      ]} />
      <div className="purchase-pagination"><Pagination current={page} pageSize={50} total={purchases.data?.total || 0} showSizeChanger={false} onChange={setPage} /></div>
    </Card>
    <Modal open={confirmOpen} width={720} title={`确认批量下载 · ${draft.length} 条`} okText="加入串行队列" cancelText="返回调整" okButtonProps={{ loading: queueBatch.isPending }} onOk={() => queueBatch.mutate()} onCancel={() => setConfirmOpen(false)}>
      <Alert type="info" showIcon message="任务将按下列顺序逐条执行" description="正常下载不会弹出浏览器；遇到登录或验证码时会打开可见浏览器并最多等待 5 分钟。" />
      <List className="batch-confirm-list" dataSource={draft} renderItem={(item, index) => <List.Item><Space><span className="batch-order">{String(index + 1).padStart(2, '0')}</span><span className="mono-badge">{item.sku}</span><Text>{item.productName}</Text><Tag color="cyan">{item.workflowCode}</Tag></Space></List.Item>} />
    </Modal>
    <PurchaseEditorDrawer open={Boolean(editor)} purchase={editor?.sku ? editor : undefined} workflows={workflows.data?.items || []} workflowsLoading={workflows.isLoading} workflowLabels={workflowLabelByCode} onClose={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); void client.invalidateQueries({ queryKey: ['purchases'] }); }} />
    <Drawer open={Boolean(detailSku)} width={680} onClose={() => setDetailSku(undefined)} title={detail.data?.purchase ? `采购详情 · ${detail.data.purchase.sku}` : '采购详情'}>{detail.isLoading ? <Skeleton active /> : detail.data?.purchase && <PurchaseDetailView purchase={detail.data.purchase} />}</Drawer>
  </div>;
}

function BatchProgressCard({ batch, onDismiss }: { batch: PurchaseDownloadBatch; onDismiss: () => void }) {
  const isComplete = batch.status === 'COMPLETED';
  const completed = batch.counts.SUCCEEDED + batch.counts.FAILED;
  const percent = batch.queuedCount ? Math.round((completed / batch.queuedCount) * 100) : 100;
  return <Card className={`batch-progress-card ${isComplete ? 'is-complete' : ''}`}><Flex justify="space-between" align="center" wrap gap={isComplete ? 10 : 18}><div className="batch-progress-copy"><Text className="batch-progress-eyebrow" type="secondary">当前批次</Text><Title level={4}>{isComplete ? '批量下载已结束' : '正在后台串行下载'}</Title><Space wrap size={isComplete ? [6, 4] : undefined}><Tag color="gold">等待 {batch.counts.QUEUED}</Tag><Tag color="orange">等待浏览器 {batch.counts.WAITING_RESOURCE}</Tag><Tag color="processing">运行 {batch.counts.RUNNING}</Tag><Tag color="green">成功 {batch.counts.SUCCEEDED}</Tag><Tag color="red">失败 {batch.counts.FAILED}</Tag>{batch.skippedCount > 0 && <Tag>跳过 {batch.skippedCount}</Tag>}</Space></div><div className="batch-progress-meter"><Progress type="circle" percent={percent} size={isComplete ? 52 : 76} status={batch.counts.FAILED ? 'exception' : isComplete ? 'success' : 'active'} />{isComplete && <Button type="link" size="small" onClick={onDismiss}>收起</Button>}</div></Flex></Card>;
}

function LatestDownloadJob({ job }: { job?: PurchaseSummary['latestDownloadJob'] }) {
  if (!job) return <Text type="secondary">尚未下载</Text>;
  const meta = purchaseJobMeta[job.status] || { color: 'default', label: job.status };
  if (job.status === 'RUNNING' && job.retryReason === 'restart_recovery') return <div className="latest-download-job"><Tag color="processing">重启恢复核验中 · {job.workflowCode}</Tag><Text type="secondary">正在使用原 downloadJobId 核验，不会新建下载任务</Text></div>;
  if (job.status === 'WAITING_RESOURCE') return <div className="latest-download-job"><Tag color={meta.color}>{meta.label} · {job.workflowCode}</Tag><Text type="warning">第 {job.resourceRetryCount || 1} 次等待{job.nextAttemptAt ? ` · ${dayjs(job.nextAttemptAt).format('HH:mm:ss')} 重试` : ''}</Text></div>;
  return <div className="latest-download-job"><Tag color={meta.color}>{meta.label} · {job.workflowCode}</Tag>{job.outputDir ? <Text className="job-output-dir" title={job.outputDir}>{job.outputDir}</Text> : job.errorMessage ? <Text type="danger" ellipsis={{ tooltip: job.errorMessage }}>{job.errorMessage}</Text> : <Text type="secondary">{dayjs(job.createdAt).format('YYYY-MM-DD HH:mm')}</Text>}</div>;
}

function PurchaseEditorDrawer({ open, purchase, workflows, workflowsLoading, workflowLabels, onClose, onSaved }: { open: boolean; purchase?: PurchaseSummary; workflows: DownloadWorkflow[]; workflowsLoading: boolean; workflowLabels: Map<string, string>; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm<PurchaseInput>();
  const [duplicateSku, setDuplicateSku] = useState<string>();
  const [providerUrlValue, setProviderUrlValue] = useState('');
  const [urlClassification, setUrlClassification] = useState<ReturnType<typeof classifyPurchaseProductUrl>>(null);
  const classifiedWorkflow = urlClassification ? workflows.find((item) => item.code === urlClassification.workflowCode) : undefined;
  const workflowUnavailable = Boolean(urlClassification && (!classifiedWorkflow || !classifiedWorkflow.enabled));
  const workflowOptions = workflows.map((item) => ({ value: item.code, label: `${workflowLabels.get(item.code) || item.code}${item.enabled ? '' : '（已停用）'}`, disabled: !item.enabled }));
  if (urlClassification && !workflowOptions.some((item) => item.value === urlClassification.workflowCode)) {
    workflowOptions.push({ value: urlClassification.workflowCode, label: `${workflowLabels.get(urlClassification.workflowCode) || urlClassification.workflowCode}（未配置）`, disabled: true });
  }
  const save = useMutation({
    mutationFn: (input: PurchaseInput) => purchase ? api.updatePurchase(purchase.sku, input) : api.createPurchase(input),
    onSuccess: () => { message.success(purchase ? '采购信息已保存，新版本已创建' : '采购产品已创建'); onSaved(); },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'PRODUCT_URL_ALREADY_EXISTS') {
        const sku = typeof error.details === 'object' && error.details && 'sku' in error.details ? String(error.details.sku) : '';
        setDuplicateSku(sku || undefined);
        form.setFields([{ name: 'providerUrl', errors: [sku ? `产品已经录入，SKU：${sku}` : '产品已经录入'] }]);
        message.warning(sku ? `产品已经录入，SKU：${sku}` : '产品已经录入');
        return;
      }
      if (error instanceof ApiError && error.code === 'PRODUCT_URL_UNSUPPORTED') {
        setDuplicateSku(undefined);
        setUrlClassification(null);
        form.setFieldValue('downloadWorkflowCode', undefined);
        form.setFields([{ name: 'providerUrl', errors: ['无法下载'] }]);
        message.warning('无法下载');
        return;
      }
      if (error instanceof ApiError && error.code === 'DOWNLOAD_WORKFLOW_URL_MISMATCH') {
        const providerUrl = String(form.getFieldValue('providerUrl') || '');
        const classification = classifyPurchaseProductUrl(providerUrl);
        setProviderUrlValue(providerUrl);
        setUrlClassification(classification);
        form.setFieldValue('downloadWorkflowCode', classification?.workflowCode);
        form.setFields([{ name: 'downloadWorkflowCode', errors: [error.userMessage || '产品 URL 与下载工作流不匹配'] }]);
        message.warning(error.userMessage || '产品 URL 与下载工作流不匹配');
        return;
      }
      message.error(error instanceof ApiError ? error.userMessage : error.message);
    }
  });
  useEffect(() => {
    if (!open) return;
    setDuplicateSku(undefined);
    form.resetFields();
    const source = purchase?.procurement;
    const providerUrl = source?.providerUrl || '';
    const classification = classifyPurchaseProductUrl(providerUrl);
    setProviderUrlValue(providerUrl);
    setUrlClassification(classification);
    form.setFieldsValue(source ? {
      productName: purchase.productName, downloadWorkflowCode: classification?.workflowCode, purchasePrice: source.purchasePrice,
      courierFee: source.courierFee, currency: source.currency, netWeightGrams: source.netWeightGrams,
      productHeightCm: source.productHeightCm, productDepthCm: source.productDepthCm, productWidthCm: source.productWidthCm,
      grossWeightGrams: source.grossWeightGrams, lengthCm: source.lengthCm, widthCm: source.widthCm,
      heightCm: source.heightCm, providerUrl: source.providerUrl
    } : { downloadWorkflowCode: undefined, currency: 'CNY', courierFee: '0', lengthCm: '30', widthCm: '15', heightCm: '10' });
    const providerUrlError = purchaseProductUrlError(providerUrl);
    form.setFields([{ name: 'providerUrl', errors: providerUrlError ? [providerUrlError] : [] }]);
  }, [form, open, purchase]);
  const handleValuesChange = (changed: Partial<PurchaseInput>) => {
    if (!Object.prototype.hasOwnProperty.call(changed, 'providerUrl')) return;
    const providerUrl = String(changed.providerUrl || '');
    const classification = classifyPurchaseProductUrl(providerUrl);
    setProviderUrlValue(providerUrl);
    setUrlClassification(classification);
    form.setFieldValue('downloadWorkflowCode', classification?.workflowCode);
    form.setFields([{ name: 'downloadWorkflowCode', errors: [] }]);
    if (duplicateSku) setDuplicateSku(undefined);
  };
  const submit = async () => {
    let values: PurchaseInput;
    try { values = await form.validateFields(); } catch { return; }
    const classification = classifyPurchaseProductUrl(values.providerUrl);
    if (!classification) {
      form.setFieldValue('downloadWorkflowCode', undefined);
      form.setFields([{ name: 'providerUrl', errors: [purchaseProductUrlError(values.providerUrl) || '无法下载'] }]);
      return;
    }
    const targetWorkflow = workflows.find((item) => item.code === classification.workflowCode);
    if (!targetWorkflow?.enabled) return;
    save.mutate({ ...values, downloadWorkflowCode: classification.workflowCode });
  };
  return <Drawer open={open} width={680} title={purchase ? `编辑采购产品 · ${purchase.sku}` : '新建采购产品'} onClose={onClose} extra={<Space><Button onClick={onClose}>取消</Button><Button type="primary" loading={save.isPending} disabled={Boolean(urlClassification && (workflowsLoading || workflowUnavailable))} onClick={() => void submit()}>保存采购信息</Button></Space>}>
    <Form form={form} layout="vertical" requiredMark="optional" onValuesChange={handleValuesChange}>
      <div className="purchase-form-section"><span>产品身份</span>{purchase ? <Form.Item label="SKU"><Input value={purchase.sku} disabled /></Form.Item> : <Alert type="info" showIcon message="SKU 将在保存时自动生成" />}<Form.Item label="产品名称" name="productName" rules={[{ required: true, message: '请输入产品名称' }]}><Input placeholder="例如：女士挎包" /></Form.Item></div>
      <div className="purchase-form-section"><span>采购信息</span><Row gutter={12}><Col span={12}><Form.Item label="采购价" name="purchasePrice" rules={[{ required: true, message: '请输入采购价' }]}><Input type="number" min="0" addonAfter="CNY" /></Form.Item></Col><Col span={12}><Form.Item label="快递费" name="courierFee"><Input type="number" min="0" addonAfter="CNY" /></Form.Item></Col></Row><Form.Item name="currency" hidden><Input /></Form.Item>
        <Text className="purchase-measurement-example" type="secondary">水桶包示例：高 30 × 深 15 × 宽 39 cm；净重 550 g</Text>
        <Row className="purchase-measurement-row" gutter={[12, 0]}>
          <Col xs={12} sm={6}><Form.Item label="净重 (g)" name="netWeightGrams" rules={[{ validator: (_, value) => validatePositivePurchaseMeasurement('净重', value) }]}><Input type="number" min="0.001" step="any" addonAfter="g" /></Form.Item></Col>
          <Col xs={12} sm={6}><Form.Item label="产品高度 (cm)" name="productHeightCm" rules={[{ validator: (_, value) => validatePositivePurchaseMeasurement('产品高度', value) }]}><Input type="number" min="0.001" step="any" addonAfter="cm" /></Form.Item></Col>
          <Col xs={12} sm={6}><Form.Item label="产品深度 (cm)" name="productDepthCm" rules={[{ validator: (_, value) => validatePositivePurchaseMeasurement('产品深度', value) }]}><Input type="number" min="0.001" step="any" addonAfter="cm" /></Form.Item></Col>
          <Col xs={12} sm={6}><Form.Item label="产品宽度 (cm)" name="productWidthCm" rules={[{ validator: (_, value) => validatePositivePurchaseMeasurement('产品宽度', value) }]}><Input type="number" min="0.001" step="any" addonAfter="cm" /></Form.Item></Col>
        </Row>
        <Row className="purchase-measurement-row" gutter={[12, 0]}>
          <Col xs={12} sm={6}><Form.Item label="毛重 (g)" name="grossWeightGrams"><Input type="number" min="0" addonAfter="g" /></Form.Item></Col>
          <Col xs={12} sm={6}><Form.Item label="包装长度 (cm)" name="lengthCm"><Input type="number" min="0" addonAfter="cm" /></Form.Item></Col>
          <Col xs={12} sm={6}><Form.Item label="包装宽度 (cm)" name="widthCm"><Input type="number" min="0" addonAfter="cm" /></Form.Item></Col>
          <Col xs={12} sm={6}><Form.Item label="包装高度 (cm)" name="heightCm"><Input type="number" min="0" addonAfter="cm" /></Form.Item></Col>
        </Row>
      </div>
      <div className="purchase-form-section"><span>下载设置</span><Form.Item label="本次下载工作流" name="downloadWorkflowCode" extra={providerUrlValue.trim() ? '工作流由产品 URL 自动选择，采购表单中不可修改。' : '粘贴产品 URL 后自动选择'}><Select aria-label="本次下载工作流" disabled placeholder="粘贴产品 URL 后自动选择" options={workflowOptions} status={urlClassification && workflowUnavailable && !workflowsLoading ? 'error' : undefined} /></Form.Item>{urlClassification && workflowsLoading && <Alert type="info" showIcon message="正在读取下载工作流配置" />}{urlClassification && !workflowsLoading && !classifiedWorkflow && <Alert type="warning" showIcon message={`${urlClassification.workflowCode} 下载工作流未配置`} description={`请先在系统设置中配置并启用 ${urlClassification.workflowCode}，采购表单不会回退到其他工作流。`} action={<Link to="/settings?section=download">前往设置</Link>} />}{urlClassification && !workflowsLoading && classifiedWorkflow && !classifiedWorkflow.enabled && <Alert type="warning" showIcon message={`${urlClassification.workflowCode} 下载工作流已停用`} description={`请先在系统设置中启用 ${urlClassification.workflowCode}，采购表单不会回退到其他工作流。`} action={<Link to="/settings?section=download">前往设置</Link>} />}</div>
      <div className="purchase-form-section"><span>商品来源</span><Form.Item label="产品 URL" name="providerUrl" validateFirst rules={[{ required: true, whitespace: true, message: '请输入产品 URL' }, { validator: (_, value) => validatePurchaseProductUrl(value) }]}><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="粘贴拼多多或 1688 完整商品链接" /></Form.Item>{duplicateSku && <Alert type="warning" showIcon message="产品已经录入" description={<>已录入产品的 SKU 编码：<Text copyable strong>{duplicateSku}</Text></>} />}</div>
    </Form>
  </Drawer>;
}

function PurchaseDetailView({ purchase }: { purchase: PurchaseDetail }) {
  return <div className="purchase-detail"><Descriptions column={1} size="small" bordered items={[{ key: 'sku', label: 'SKU', children: <span className="mono-badge">{purchase.sku}</span> }, { key: 'name', label: '产品名称', children: purchase.productName }, { key: 'variants', label: '产品变体', children: <Space wrap>{(purchase.variants || ['默认变体']).map((name) => <Tag key={name}>{name}</Tag>)}</Space> }]} /><Title level={5}>采购版本</Title><Table pagination={false} rowKey="id" size="small" dataSource={purchase.procurementVersions} columns={[{ title: '版本', dataIndex: 'versionNo', width: 70, render: (value: number) => `V${value}` }, { title: '采购信息', render: (_: unknown, item) => { const productMeasurements = formatProductMeasurements(item); return <div className="purchase-version-summary"><strong>{formatPurchaseMoney(item.purchasePrice, item.currency)}</strong><Text type="secondary">快递费 {formatPurchaseMoney(item.courierFee, item.currency)}</Text>{productMeasurements && <Text type="secondary">产品：{productMeasurements}</Text>}<Text type="secondary">包装：{formatPackagingMeasurements(item)}</Text></div>; } }, { title: '下载工作流', dataIndex: 'downloadWorkflowCode', width: 105, render: (value?: string) => value ? <Tag color="cyan">{value}</Tag> : '—' }, { title: '保存时间', dataIndex: 'createdAt', width: 140, render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm') }]} />
    <Title level={5}>图片下载历史</Title><Table pagination={false} rowKey="id" size="small" dataSource={purchase.downloadJobs} columns={[{ title: '状态', dataIndex: 'status', render: (value: string) => <Tag color={purchaseJobMeta[value]?.color}>{purchaseJobMeta[value]?.label || value}</Tag> }, { title: '工作流', dataIndex: 'workflowCode' }, { title: '保存目录', dataIndex: 'outputDir', render: (value?: string) => value ? <Text ellipsis={{ tooltip: value }}>{value}</Text> : '—' }, { title: '时间', dataIndex: 'createdAt', render: (value: string) => dayjs(value).format('MM-DD HH:mm') }]} />
  </div>;
}

function purchaseProductUrlError(value: unknown): string | undefined {
  const providerUrl = typeof value === 'string' ? value.trim() : '';
  if (!providerUrl) return undefined;
  try { new URL(providerUrl); } catch { return '请输入有效 URL'; }
  return classifyPurchaseProductUrl(providerUrl) ? undefined : '无法下载';
}
function validatePurchaseProductUrl(value: unknown): Promise<void> {
  const error = purchaseProductUrlError(value);
  return error ? Promise.reject(new Error(error)) : Promise.resolve();
}
function formatPurchaseMoney(value?: string, currency = 'CNY') { return `${currency === 'CNY' ? '¥' : `${currency} `}${Number(value || 0).toFixed(2)}`; }
function isValidPurchasePrice(value?: string | null) { const number = Number(value); return Boolean(value?.trim()) && Number.isFinite(number) && number >= 0; }
function validatePositivePurchaseMeasurement(label: string, value: unknown): Promise<void> {
  if (value === undefined || value === null || value === '') return Promise.resolve();
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Promise.resolve() : Promise.reject(new Error(`${label}必须大于 0`));
}
function formatMeasurementNumber(value?: string | null) {
  if (!value) return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
}
function formatProductMeasurements(value: { netWeightGrams?: string | null; productHeightCm?: string | null; productDepthCm?: string | null; productWidthCm?: string | null }) {
  const height = formatMeasurementNumber(value.productHeightCm);
  const depth = formatMeasurementNumber(value.productDepthCm);
  const width = formatMeasurementNumber(value.productWidthCm);
  const dimensions = [
    height ? `高 ${height}` : '',
    depth ? `深 ${depth}` : '',
    width ? `宽 ${width}` : ''
  ].filter(Boolean);
  const size = dimensions.length ? `${dimensions.join(' × ')} cm` : '';
  const weight = value.netWeightGrams ? `净重 ${formatMeasurementNumber(value.netWeightGrams)} g` : '';
  return [size, weight].filter(Boolean).join(' · ') || undefined;
}
function formatPackagingMeasurements(value: { grossWeightGrams?: string | null; lengthCm?: string | null; widthCm?: string | null; heightCm?: string | null }) {
  const length = formatMeasurementNumber(value.lengthCm);
  const width = formatMeasurementNumber(value.widthCm);
  const height = formatMeasurementNumber(value.heightCm);
  const size = length && width && height ? `长 ${length} × 宽 ${width} × 高 ${height} cm` : '';
  const weight = value.grossWeightGrams ? `毛重 ${formatMeasurementNumber(value.grossWeightGrams)} g` : '';
  return [size, weight].filter(Boolean).join(' · ') || '未填写';
}
function urlLabel(value: string) { try { const url = new URL(value); return `${url.hostname}${url.pathname.length > 20 ? `${url.pathname.slice(0, 20)}…` : url.pathname}`; } catch { return value; } }

function normalizeUiPath(value: string) { return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase('en-US'); }
function validateWbOutputTemplate(value: string): string | undefined {
  return validateMediaOutputTemplate(value, 'WB');
}
function validateOzonOutputTemplate(value: string): string | undefined {
  return validateMediaOutputTemplate(value, 'OZON');
}
function validateMediaOutputTemplate(value: string, platform: 'WB' | 'OZON'): string | undefined {
  const trimmed = value.trim();
  const prefix = platform === 'WB' ? '' : 'OZON ';
  const placeholders = [...trimmed.matchAll(/<[^>]+>/g)].map((match) => match[0]);
  if (placeholders.filter((item) => item === '<SKU>').length !== 1) return `${prefix}目录模板必须包含且只能包含一个 <SKU>`;
  if (placeholders.some((item) => item !== '<SKU>')) return `${prefix}不支持占位符：${placeholders.find((item) => item !== '<SKU>')}`;
  if (!/[/\\]inbox[/\\]<SKU>[/\\]variants[/\\]?$/.test(trimmed)) return `${prefix}目录模板必须以 inbox\\<SKU>\\variants 结尾`;
  return undefined;
}
function outputRootFromTemplate(value: string): string | undefined {
  if (!/[/\\]inbox[/\\]<SKU>[/\\]variants[/\\]?$/.test(value.trim())) return undefined;
  return value.trim().replace(/[/\\]inbox[/\\]<SKU>[/\\]variants[/\\]?$/, '');
}
