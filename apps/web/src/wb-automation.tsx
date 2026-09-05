import { useEffect, useMemo, useRef, useState } from 'react';
import { WB_RETRY_EXPLANATION, WB_RETRY_STAGE_LABELS, type WbPublishRetryRequest } from '@n8n-media-review/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ClockCircleOutlined, CopyOutlined, ExclamationCircleOutlined, EyeOutlined, FileTextOutlined, LinkOutlined, ReloadOutlined,
  SafetyCertificateOutlined, StopOutlined, ThunderboltOutlined
} from '@ant-design/icons';
import {
  Alert, Badge, Button, Card, Descriptions, Drawer, Empty, Flex, Input, message, Modal,
  Select, Space, Table, Tag, Timeline, Tooltip, Typography
} from 'antd';
import dayjs from 'dayjs';
import {
  api,
  type WbAutoPublishEvent,
  type WbAutoPublishJob,
  type WbAutoPublishState,
  type WbAutoPublishStatus
} from './api/client';
import {
  sameWbAutoPublishJob, summarizeWbAutoPublishCounts, wbAutoPublishJobKey,
  wbAutoPublishNoticePresentation, wbAutoPublishProductLinks, wbAutoPublishStateMeta, type WbAutoPublishIdentity
} from './wb-automation-utils';
import { WbUpdatedDateFilterControl } from './wb-date-filter-control';
import type { WbUpdatedDatePreset, WbUpdatedDateRange } from './wb-date-filter';

const { Text } = Typography;

function stateMeta(state: string) {
  return wbAutoPublishStateMeta[state] || { label: state || '未知状态', color: 'default', group: 'closed' as const };
}

function stateTag(state: string) {
  const meta = stateMeta(state);
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

function dateTime(value?: string) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—';
}

function jobReason(job: WbAutoPublishJob) {
  const recovery = networkRecovery(job);
  if (job.state === ('WAITING_NETWORK' as WbAutoPublishState)) {
    return `网络或 WB 服务暂不可用，系统会保留原任务自动续跑${recovery?.attempt ? `（第 ${recovery.attempt} 次等待）` : ''}。`;
  }
  if (job.state === 'WAITING_GENERATION_TURN') {
    return '正在等待同一 SKU 的另一店完成共享版本冻结；后续 WB 建卡、媒体、价格和库存仍会按店铺并行执行。';
  }
  if (job.lastErrorMessage) return job.lastErrorMessage;
  if (job.state === 'BLOCKED_EXISTING_CARD') return 'WB 普通商品卡或回收站中存在相同卖家商品编码，系统已停止自动创建。';
  if (job.state === 'WAITING_MEDIA') return '等待对应变体的 E005 图片和 E004 视频完成投递。';
  if (job.state === 'WAITING_STABLE') return '媒体已投递，正在确认目录与文件保持稳定。';
  if (job.state === 'PAUSED') return '自动上品已暂停，请检查任务自身的绑定快照、鉴权或运行配置。';
  if (job.state === 'SUCCEEDED') return '商品资料、媒体、价格、折扣与库存已完成同步。';
  return `当前步骤：${stateMeta(job.state).label}`;
}

function networkRecovery(job: WbAutoPublishJob): { attempt?: number; phase?: string; deliveryState?: string; nextAttemptAt?: string } | undefined {
  return (job as WbAutoPublishJob & { networkRecovery?: { attempt?: number; phase?: string; deliveryState?: string; nextAttemptAt?: string } }).networkRecovery;
}

function productLinks(job: WbAutoPublishJob) {
  if (job.state !== 'SUCCEEDED') return <Text type="secondary">—</Text>;
  const links = wbAutoPublishProductLinks(job);
  if (!links.length) return <Text type="secondary">链接未同步</Text>;
  return <Space size={[2, 2]} wrap>
    {links.map((link, index) => <Button
      key={link.url}
      type="link"
      size="small"
      icon={<LinkOutlined />}
      href={link.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`打开 SKU ${job.sku} 的 WB 商品 ${link.variantCode || index + 1}`}
    >{link.variantCode || `商品 ${index + 1}`}</Button>)}
  </Space>;
}

function eventText(event: WbAutoPublishEvent) {
  if (event.message) return event.message;
  if (event.fromState && event.toState) return `${stateMeta(event.fromState).label} → ${stateMeta(event.toState).label}`;
  if (event.toState) return `进入 ${stateMeta(event.toState).label}`;
  return event.eventType;
}

function jobReasonCell(job: WbAutoPublishJob) {
  const presentation = wbAutoPublishNoticePresentation(job.state);
  const hasNotice = Boolean(job.lastErrorCode || job.lastErrorMessage);
  const succeeded = job.state === 'SUCCEEDED';
  return <div className={`wb-current-reason wb-automation-reason${hasNotice ? ` has-${presentation.tone}` : ''}`}>
    <span>{succeeded ? '该店铺上品已完成' : jobReason(job)}</span>
    {succeeded && <small>公共媒体已在成功上品后清理</small>}
    {job.lastErrorCode && <code>{presentation.codeLabel}：{job.lastErrorCode}</code>}
  </div>;
}

export function WbAutoPublishPanel({
  queryText,
  onQueryTextChange,
  stateFilter,
  onStateFilterChange,
  updatedDatePreset,
  customUpdatedDateRange,
  updatedDateBounds,
  onUpdatedDatePresetChange,
  onCustomUpdatedDateRangeChange,
  onUpdatedDateReset,
  onOpenListing
}: {
  queryText: string;
  onQueryTextChange: (value: string) => void;
  stateFilter?: string;
  onStateFilterChange: (value?: string) => void;
  updatedDatePreset: WbUpdatedDatePreset;
  customUpdatedDateRange: WbUpdatedDateRange;
  updatedDateBounds: { updatedFrom?: string; updatedTo?: string };
  onUpdatedDatePresetChange: (value: WbUpdatedDatePreset) => void;
  onCustomUpdatedDateRangeChange: (value: WbUpdatedDateRange) => void;
  onUpdatedDateReset: () => void;
  onOpenListing: (sku: string) => void;
}) {
  const [effectiveQueryText, setEffectiveQueryText] = useState(queryText);
  const [selectedJob, setSelectedJob] = useState<WbAutoPublishIdentity>();
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
    pageSize: '20',
    ...(effectiveQueryText.trim() ? { query: effectiveQueryText.trim() } : {}),
    ...(stateFilter ? { state: stateFilter } : {}),
    ...updatedDateBounds
  }), [effectiveQueryText, stateFilter, updatedDateBounds]);
  const status = useQuery({
    queryKey: ['wb-automation', 'status'],
    queryFn: api.wbAutoPublishStatus,
    retry: false,
    refetchInterval: (query) => {
      const current = query.state.data as WbAutoPublishStatus | undefined;
      return current?.acceptingNewJobs || current?.continuingBoundJobs ? 10_000 : 60_000;
    }
  });
  const stores = useQuery({ queryKey: ['wb-stores'], queryFn: api.wbStores, retry: false });
  const storesById = useMemo(() => new Map((stores.data?.items || []).map((store) => [store.id, store])), [stores.data?.items]);
  const jobs = useQuery({
    queryKey: ['wb-automation', 'jobs', params.toString()],
    queryFn: () => api.wbAutoPublishJobs(params),
    retry: false,
    refetchInterval: status.data?.acceptingNewJobs || status.data?.continuingBoundJobs ? 10_000 : false
  });
  const counts = summarizeWbAutoPublishCounts(status.data?.counts || {});
  const enabled = Boolean(status.data?.acceptingNewJobs ?? status.data?.enabled);
  const activePreset = status.data?.activePreset;
  const resetFilters = () => {
    onQueryTextChange('');
    setEffectiveQueryText('');
    onStateFilterChange(undefined);
    onUpdatedDateReset();
  };

  return <Card className={`wb-workspace-console wb-automation-console${enabled ? ' is-enabled' : ''}`}>
    <Flex className="wb-automation-heading" justify="space-between" align="flex-start" gap={14} wrap="wrap">
      <div className="wb-automation-title"><span className="wb-automation-icon"><ThunderboltOutlined /></span><div><Space size={7} wrap><strong>自动上品任务</strong><Tag color={enabled ? 'green' : 'default'}>{enabled ? '正在接收新任务' : '停止接收新任务'}</Tag>{status.data?.worker?.running && <Badge status="processing" text="协调器运行中" />}</Space><Text type="secondary">{enabled && activePreset ? `默认预设“${activePreset.name}”接收 ${activePreset.activatedAt ? dateTime(activePreset.activatedAt) : '开关启用'}后首次投递的新 SKU；已有任务继续使用各自的绑定快照。` : enabled ? '已按各店铺启用状态和默认预设接收新 SKU；每个店铺使用独立任务与绑定快照。' : `当前不接收新 SKU；${status.data?.continuingBoundJobs || 0} 个已绑定任务仍会继续推进。`}</Text></div></div>
      <Button className="wb-workspace-refresh" icon={<ReloadOutlined />} loading={status.isFetching || jobs.isFetching} onClick={() => void Promise.all([status.refetch(), jobs.refetch()])}>刷新</Button>
    </Flex>

    {(status.isError || jobs.isError) && <Alert className="wb-automation-error" showIcon type="error" message="自动上品状态暂时无法读取" description={(status.error || jobs.error)?.message} action={<Button onClick={() => void Promise.all([status.refetch(), jobs.refetch()])}>重新读取</Button>} />}

    <div className="wb-automation-metrics" aria-label="自动上品任务统计">
      <Metric label="等待条件" value={counts.waiting} tone="waiting" />
      <Metric label="处理中" value={counts.processing} tone="processing" />
      <Metric label="需人工处理" value={counts.attention} tone="attention" />
      <Metric label="成功任务" value={counts.success} tone="success" />
    </div>

    <Flex className="wb-workspace-filter wb-automation-filter" gap={10} align="center" wrap="wrap">
      <Input.Search aria-label="搜索自动任务 SKU" allowClear value={queryText} onChange={(event) => onQueryTextChange(event.target.value)} onSearch={(value) => setEffectiveQueryText(value)} placeholder="搜索自动任务 SKU" className="wb-automation-search" />
      <WbUpdatedDateFilterControl
        preset={updatedDatePreset}
        customRange={customUpdatedDateRange}
        onPresetChange={onUpdatedDatePresetChange}
        onCustomRangeChange={onCustomUpdatedDateRangeChange}
      />
      <Select aria-label="筛选自动上品状态" allowClear value={stateFilter} onChange={onStateFilterChange} placeholder="全部状态" options={Object.entries(wbAutoPublishStateMeta).map(([value, meta]) => ({ value, label: meta.label }))} />
      <Button disabled={!queryText && !stateFilter && updatedDatePreset === 'ALL'} onClick={resetFilters}>重置</Button>
      <Text type="secondary" className="wb-workspace-result-count">共 {jobs.data?.total || 0} 个任务</Text>
    </Flex>

    <Table<WbAutoPublishJob>
      className="wb-automation-table"
      rowKey={wbAutoPublishJobKey}
      size="small"
      loading={jobs.isLoading}
      dataSource={jobs.data?.items || []}
      pagination={false}
      scroll={{ x: 1420 }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={enabled ? '暂无自动上品任务，等待新的 E004/E005 媒体投递。' : '自动上品未开启；历史媒体不会自动加入。'} /> }}
      columns={[
        { title: '店铺', width: 160, render: (_, job) => { const store = storesById.get(job.storeId); return <div><strong>{store?.displayName || store?.storeAlias || '未知店铺'}</strong><Text type="secondary" className="mono-small">{store?.storeAlias || job.storeId}</Text></div>; } },
        { title: 'SKU', width: 150, render: (_, job) => <Space size={4}><strong className="mono-small">{job.sku}</strong><Tooltip title="复制 SKU"><Button aria-label={`复制 SKU ${job.sku}`} type="text" size="small" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(job.sku).then(() => message.success(`已复制 SKU ${job.sku}`))} /></Tooltip></Space> },
        { title: '轮次 / 方式', width: 190, render: (_, job) => <div><Space size={4}><Tag color="blue">第 {job.runNo} 轮</Tag>{job.operationMode === 'COMPATIBLE_UPSERT' ? <Tag color="purple">兼容更新</Tag> : <Tag>自动创建</Tag>}</Space><Text type="secondary">R{job.baseRevision} → R{job.targetRevision}</Text>{job.variantSummary && <Text type="secondary">新增 {job.variantSummary.created} · 更新 {job.variantSummary.updated} · 保留 {job.variantSummary.preserved}</Text>}</div> },
        { title: '自动状态', width: 160, render: (_, job) => stateTag(job.state) },
        { title: '绑定预设', width: 190, render: (_, job) => job.presetName || job.presetId ? <div className="wb-current-preset wb-automation-preset"><Space size={4} wrap><strong>{job.presetName || '预设快照'}</strong>{job.sourcePresetExists === false && <Tag color="default">来源已删除</Tag>}</Space><Text type="secondary">R{job.presetRowVersion || '—'} · 已锁定快照</Text></div> : <Text type="secondary">—</Text> },
        { title: '当前说明', width: 320, render: (_, job) => jobReasonCell(job) },
        { title: '更新时间', width: 155, render: (_, job) => <span className="mono-small">{dateTime(job.updatedAt)}</span> },
        { title: '操作', width: 100, fixed: 'right', render: (_, job) => <Button size="small" icon={<EyeOutlined />} onClick={() => setSelectedJob({ storeId: job.storeId, sku: job.sku })}>查看详情</Button> },
        { title: 'WB 商品链接', width: 190, fixed: 'right', render: (_, job) => productLinks(job) }
      ]}
    />
    <WbAutoPublishJobDrawer
      identity={selectedJob}
      store={selectedJob ? storesById.get(selectedJob.storeId) : undefined}
      fallbackJob={(jobs.data?.items || []).find((job) => sameWbAutoPublishJob(job, selectedJob))}
      onClose={() => setSelectedJob(undefined)}
      onOpenListing={onOpenListing}
    />
  </Card>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`wb-automation-metric is-${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function WbAutoPublishJobDrawer({ identity, store, fallbackJob, onClose, onOpenListing }: {
  identity?: WbAutoPublishIdentity;
  store?: { displayName: string; storeAlias: string };
  fallbackJob?: WbAutoPublishJob;
  onClose: () => void;
  onOpenListing: (sku: string) => void;
}) {
  const sku = identity?.sku;
  const storeId = identity?.storeId;
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ['wb-automation', 'job', storeId, sku], queryFn: () => api.wbAutoPublishJob(sku!, storeId!), enabled: Boolean(sku && storeId), retry: false, refetchInterval: (query) => {
    const state = (query.state.data as WbAutoPublishJob | undefined)?.state || '';
    if (state === ('WAITING_NETWORK' as WbAutoPublishState)) return 30_000;
    return ['WAITING_GENERATION_TURN', 'CHECKING', 'INITIALIZING', 'GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING'].includes(state) ? 5_000 : false;
  } });
  const job = detail.data || fallbackJob;
  const refresh = () => client.invalidateQueries({ queryKey: ['wb-automation'] });
  const retryRequest = useRef<{ key: string; input: WbPublishRetryRequest }>();
  const recheck = useMutation({
    mutationFn: () => {
      if (!job?.retry) throw new Error('请刷新详情后重试');
      const key = [storeId, sku, job.runId, job.retry.expectedStateToken].join(':');
      if (retryRequest.current?.key !== key) retryRequest.current = { key, input: {
        storeId: storeId!, runId: job.runId, requestId: crypto.randomUUID(), expectedStateToken: job.retry.expectedStateToken
      } };
      return api.retryWbAutoPublishJob(sku!, retryRequest.current.input);
    },
    onSuccess: async (result) => {
      retryRequest.current = undefined;
      client.setQueryData(['wb-automation', 'job', storeId, sku], result.job);
      if (result.retry.status === 'SUCCEEDED') message.success('已确认上品完成');
      else if (['FAILED', 'BLOCKED'].includes(result.retry.status)) message.warning(`暂不能重试：${result.retry.message}`);
      else message.info(result.retry.message);
      await refresh();
    },
    onError: async (error: Error) => { message.error(error.message); await refresh(); }
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelWbAutoPublishJob(sku!, storeId!),
    onSuccess: async () => { message.success(`SKU ${sku} 的自动推进已取消`); await refresh(); },
    onError: (error: Error) => message.error(error.message)
  });
  const confirmCancel = () => Modal.confirm({
    title: `取消 SKU ${sku} 的自动上品？`,
    icon: <ExclamationCircleOutlined />,
    content: '只停止尚未提交的自动推进，并保留已经生成的草稿。已经提交到 WB 的任务不能撤回。',
    okText: '停止自动推进',
    okButtonProps: { danger: true },
    cancelText: '继续保留',
    onOk: () => cancel.mutateAsync()
  });
  const events = [...(job?.events || [])].sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf());
  const noticePresentation = job ? wbAutoPublishNoticePresentation(job.state) : undefined;

  const activeRetry = Boolean(job?.retry?.latest && ['CHECKING', 'RUNNING'].includes(job.retry.latest.status));
  return <Drawer className="wb-automation-drawer" open={Boolean(identity)} width="min(720px, 96vw)" title={<Space wrap><SafetyCertificateOutlined /><strong>自动上品详情</strong>{store && <Tag color="cyan">{store.displayName}</Tag>}{job && stateTag(job.state)}</Space>} onClose={onClose} extra={job && <Space wrap>
    <Button icon={<FileTextOutlined />} disabled={!job.hasListing} onClick={() => { onClose(); onOpenListing(job.sku); }}>打开上品资料</Button>
    <Tooltip title={job.retry?.canRetry ? WB_RETRY_EXPLANATION : job.retry?.reason || '正在读取重试条件'}><span><Button icon={<ReloadOutlined />} disabled={!job.retry?.canRetry || activeRetry} loading={recheck.isPending} onClick={() => recheck.mutate()}>重试上品</Button></span></Tooltip>
    <Tooltip title={job.canCancel && !activeRetry ? undefined : activeRetry ? '重试正在执行' : '已经提交到 WB 或任务已结束，不能取消'}><span><Button danger icon={<StopOutlined />} disabled={!job.canCancel || activeRetry} loading={cancel.isPending} onClick={confirmCancel}>取消自动任务</Button></span></Tooltip>
  </Space>}>
    {detail.isLoading && !job ? <Card loading /> : detail.isError ? <Alert showIcon type="error" message="无法读取自动上品详情" description={detail.error.message} action={<Button onClick={() => void detail.refetch()}>重试</Button>} /> : job ? <div className="wb-automation-detail">
      <Text type="secondary">{WB_RETRY_EXPLANATION}</Text>
      {recheck.isPending && <Alert showIcon type="info" message="正在检查重试条件" />}
      {job.retry?.latest && <Alert showIcon
        type={job.retry.latest.status === 'SUCCEEDED' ? 'success' : ['FAILED', 'BLOCKED'].includes(job.retry.latest.status) ? 'warning' : 'info'}
        message={job.retry.latest.message}
        description={<Space direction="vertical" size={2}>
          <span>本次重试开始：{dateTime(job.retry.latest.createdAt)} · 第 {job.retry.latest.retryNo || 1} 次 · {WB_RETRY_STAGE_LABELS[job.retry.latest.stage] || '核对原任务'}</span>
          <span>状态：{({ CHECKING: '检查中', RUNNING: '执行中', SUCCEEDED: '已完成', FAILED: '失败', BLOCKED: '条件不满足' })[job.retry.latest.status]} · 最近结果：{dateTime(job.retry.latest.updatedAt)}</span>
          {job.retry.latest.errorCode && <span>本次错误：{job.retry.latest.errorCode}</span>}
          {job.retry.latest.previousErrorMessage && <span>原错误：{job.retry.latest.previousErrorMessage}（{job.retry.latest.previousErrorCode}）</span>}
        </Space>} />}
      {!job.retry?.canRetry && !activeRetry && job.retry?.reason && <Text type="secondary">暂不能重试：{job.retry.reason}</Text>}
      <Alert showIcon type={noticePresentation!.alertType} message={jobReason(job)} description={job.state === ('WAITING_NETWORK' as WbAutoPublishState)
        ? `原任务身份保持不变；下次自动检查：${dateTime(job.nextAttemptAt)}`
        : job.state === 'WAITING_GENERATION_TURN'
          ? `每 5 秒安全检查生成轮次；下次检查：${dateTime(job.nextAttemptAt)}`
          : job.lastErrorCode ? `${noticePresentation!.codeLabel}：${job.lastErrorCode}` : undefined} />
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }} items={[
        { key: 'store', label: '目标店铺', children: <span>{store?.displayName || '未知店铺'}{store?.storeAlias ? ` · ${store.storeAlias}` : ''}</span> },
        { key: 'sku', label: '产品 SKU', children: <strong className="mono-small">{job.sku}</strong> },
        { key: 'run', label: '运行轮次', children: <Space size={4}><Tag color="blue">第 {job.runNo} 轮</Tag><Tag color={job.operationMode === 'COMPATIBLE_UPSERT' ? 'purple' : 'default'}>{job.operationMode === 'COMPATIBLE_UPSERT' ? '兼容重新上品' : '自动创建'}</Tag></Space> },
        { key: 'revision', label: '修订', children: `R${job.baseRevision} → R${job.targetRevision}` },
        { key: 'preset', label: '绑定预设', children: <Space size={4} wrap><span>{job.presetName || job.presetId || '—'}{job.presetRowVersion ? ` · R${job.presetRowVersion}` : ''}</span>{job.sourcePresetExists === false && <Tag>来源已删除</Tag>}</Space> },
        { key: 'bound', label: '绑定时间', children: dateTime(job.presetBoundAt || job.presetBinding?.boundAt) },
        { key: 'hash', label: '配置摘要', span: 2, children: job.presetDefinitionHash || job.presetBinding?.definitionHash ? <code>{job.presetDefinitionHash || job.presetBinding?.definitionHash}</code> : '历史任务快照' },
        { key: 'vendors', label: '预期卖家编码', span: 2, children: job.expectedVendorCodes?.length ? <Space size={[4, 4]} wrap>{job.expectedVendorCodes.map((code) => <Tag key={code}>{code}</Tag>)}</Space> : '—' },
        { key: 'mediaTargets', label: '本轮媒体目标', span: 2, children: job.mediaTargetVendorCodes?.length ? <Space size={[4, 4]} wrap>{job.mediaTargetVendorCodes.map((code) => <Tag color="purple" key={code}>{code}</Tag>)}</Space> : '—' },
        { key: 'variants', label: '变体处理结果', span: 2, children: <Space size={[4, 4]} wrap><Tag color="green">新增 {job.variantSummary?.created || 0}</Tag><Tag color="blue">更新 {job.variantSummary?.updated || 0}</Tag><Tag color="gold">保留未管理 {job.variantSummary?.preserved || 0}</Tag></Space> },
        { key: 'attempts', label: '检查次数', children: job.attemptCount ?? 0 },
        ...(networkRecovery(job) ? [{ key: 'network', label: '网络恢复', children: `第 ${networkRecovery(job)?.attempt || 0} 次 · ${networkRecovery(job)?.phase || '当前阶段'} · ${networkRecovery(job)?.deliveryState || 'UNKNOWN'}` }] : []),
        { key: 'next', label: '下次检查', children: dateTime(job.nextAttemptAt) },
        { key: 'task', label: 'n8n taskId', children: job.n8nTaskId ? <code>{job.n8nTaskId}</code> : '—' },
        { key: 'listing', label: '本地上品资料', children: job.hasListing ? <Badge status="success" text="已创建草稿" /> : <Badge status="default" text="尚未创建" /> },
        { key: 'created', label: '任务创建', children: dateTime(job.createdAt) },
        { key: 'updated', label: '最近更新', children: dateTime(job.updatedAt) }
      ]} />
      {!!job.warnings?.length && <Alert showIcon type="warning" message="兼容更新保留项" description={<div>{job.warnings.map((warning, index) => <div key={`${String(warning.code || 'warning')}-${index}`}>{String(warning.message || warning.code || '存在需要关注的保留项')}</div>)}</div>} />}
      <div className="wb-automation-timeline-head"><div><ClockCircleOutlined /><strong>任务时间线</strong></div><Text type="secondary">只记录状态、校验结果和执行编号，不保存 Token 或媒体内容。</Text></div>
      {events.length ? <Timeline className="wb-automation-timeline" items={events.map((event) => ({ color: event.toState ? stateMeta(event.toState).color : 'gray', children: <div><Space size={6} wrap><strong>{eventText(event)}</strong><Tag>{event.eventType}</Tag></Space><Text type="secondary">{dateTime(event.createdAt)}</Text>{event.details && Object.keys(event.details).length > 0 && <details><summary>查看校验明细</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>}</div> }))} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有审计事件" />}
    </div> : null}
  </Drawer>;
}
