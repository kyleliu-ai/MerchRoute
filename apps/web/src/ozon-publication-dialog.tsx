import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircleOutlined, ShopOutlined, SyncOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Empty, Flex, message, Modal, Skeleton, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import type { OzonListingDraft } from '@n8n-media-review/shared';
import {
  api,
  ApiError,
  type OzonPublicationAttemptResult,
  type OzonPublicationCreateResult,
  type OzonPublicationPlan,
  type OzonStore
} from './api/client';
import { defaultManualOzonStoreIds } from './ozon-store-settings-utils';

const { Text } = Typography;

function storeCanPublish(store: OzonStore) {
  return !store.archivedAt && store.enabled && store.readiness.ready && store.preflight.currencyVerified;
}

type OzonPublicationPlanContract = OzonPublicationPlan & {
  materialHash?: string;
  contentPolicyVersion?: string;
  items: Array<OzonPublicationPlan['items'][number] & {
    presetRowVersion?: number;
    publicationMode?: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
    publicationId?: string;
    jobId?: string;
  }>;
};

function normalizedPublicationResults(result: OzonPublicationCreateResult): OzonPublicationAttemptResult[] {
  if (Array.isArray(result.results)) return result.results;
  return result.publications.map((publication) => ({
    storeId: publication.storeId,
    publicationId: publication.id,
    status: publication.status,
    ...(publication.errorCode ? { errorCode: publication.errorCode } : {}),
    ...(publication.errorMessage ? { errorMessage: publication.errorMessage } : {})
  }));
}

export function OzonPublicationDialog({
  listing,
  open,
  onClose,
  onSubmitted
}: {
  listing: OzonListingDraft;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => Promise<unknown>;
}) {
  const stores = useQuery({ queryKey: ['ozon-stores'], queryFn: () => api.ozonStores(true), enabled: open, retry: false });
  const presets = useQuery({ queryKey: ['ozon-presets'], queryFn: api.ozonPresets, enabled: open, retry: false });
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<OzonPublicationPlan>();
  const [requestId, setRequestId] = useState<string>();
  const [submission, setSubmission] = useState<OzonPublicationCreateResult>();
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!open) {
      setSelectedStoreIds([]);
      setPlan(undefined);
      setRequestId(undefined);
      setSubmission(undefined);
      setInitialized(false);
      return;
    }
    if (!initialized && stores.data?.items) {
      setSelectedStoreIds(defaultManualOzonStoreIds(stores.data.items));
      setInitialized(true);
    }
  }, [initialized, open, stores.data?.items]);

  const activeStores = (stores.data?.items || []).filter((store) => !store.archivedAt);
  const selectedReady = selectedStoreIds.length > 0 && selectedStoreIds.every((storeId) => {
    const store = activeStores.find((item) => item.id === storeId);
    return Boolean(store && storeCanPublish(store));
  });
  const planHasBlockers = Boolean(plan?.items.some((item) => !item.ready || item.blockers.length));
  const planContract = plan as OzonPublicationPlanContract | undefined;

  const buildPlan = useMutation({
    mutationFn: () => api.planOzonPublications(listing.sku, listing.rowVersion, selectedStoreIds),
    onSuccess: ({ plan: next }) => {
      setPlan(next);
      setRequestId(crypto.randomUUID());
      setSubmission(undefined);
    },
    onError: (error: Error) => message.error(error instanceof ApiError ? error.userMessage : error.message)
  });
  const publish = useMutation({
    mutationFn: () => api.createOzonPublications(listing.sku, listing.rowVersion, selectedStoreIds, plan!.planHash, requestId!),
    onSuccess: async (result) => {
      const normalized = { ...result, results: normalizedPublicationResults(result) };
      setSubmission(normalized);
      message[normalized.failed ? 'warning' : 'success'](`${normalized.accepted} 家店铺已创建独立 OZON publication${normalized.failed ? `，${normalized.failed} 家需要处理` : ''}`);
      await onSubmitted();
      if (!normalized.failed) onClose();
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status === 409) {
        setPlan(undefined);
        setRequestId(undefined);
        setSubmission(undefined);
        message.warning('上品资料、店铺、凭据、仓库或预设已经变化，请重新检查发布计划');
        return;
      }
      message.error(error.message);
    }
  });
  const recheckAttempt = useMutation({
    mutationFn: async (result: OzonPublicationAttemptResult) => {
      const detail = await api.ozonPublicationTaskDetail(result.publicationId);
      if (!detail.recovery.canRecheck) {
        throw new Error(detail.recovery.blockedReason || '当前 publication 不允许安全重检');
      }
      const publication = detail.publication;
      const frozenPlanHash = String(publication.planHash || detail.frozenContract.planHash || '').trim();
      const frozenRequestId = String(publication.requestId || detail.frozenContract.requestId || '').trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(frozenPlanHash)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(frozenRequestId)) {
        throw new Error('原 publication 缺少有效的冻结 planHash 或 requestId，已停止重检');
      }
      return api.recheckOzonPublication(publication.id, {
        rowVersion: publication.rowVersion,
        planHash: frozenPlanHash,
        requestId: frozenRequestId
      });
    },
    onSuccess: async ({ publication }) => {
      setSubmission((current) => {
        if (!current) return current;
        const results = current.results.map((item) => item.publicationId === publication.id ? {
          storeId: publication.storeId,
          publicationId: publication.id,
          status: publication.status,
          ...(publication.errorCode ? { errorCode: publication.errorCode } : {}),
          ...(publication.errorMessage ? { errorMessage: publication.errorMessage } : {})
        } : item);
        return {
          ...current,
          publications: current.publications.map((item) => item.id === publication.id ? publication : item),
          results,
          accepted: results.filter((item) => !['FAILED', 'NEEDS_ATTENTION'].includes(item.status)).length,
          failed: results.filter((item) => ['FAILED', 'NEEDS_ATTENTION'].includes(item.status)).length
        };
      });
      message.success(`${publication.storeDisplayNameSnapshot || publication.storeAliasSnapshot} 已按原 publication 重新检查`);
      await onSubmitted();
    },
    onError: (error: Error) => message.error(error instanceof ApiError ? error.userMessage : error.message)
  });

  const toggleStore = (storeId: string, checked: boolean) => {
    setSelectedStoreIds((current) => checked ? [...current, storeId] : current.filter((id) => id !== storeId));
    setPlan(undefined);
    setRequestId(undefined);
    setSubmission(undefined);
  };
  const requestClose = () => {
    if (buildPlan.isPending || publish.isPending || recheckAttempt.isPending) return;
    onClose();
  };

  return <Modal
    className="ozon-publication-modal"
    width={920}
    open={open}
    title={<Space><ShopOutlined /><span>选择发布店铺 · {listing.sku}</span></Space>}
    footer={<Flex justify="flex-end" wrap="wrap" gap={8}>
      <Button disabled={buildPlan.isPending || publish.isPending || recheckAttempt.isPending} onClick={requestClose}>返回工作台</Button>
      <Button icon={<SyncOutlined />} loading={buildPlan.isPending} disabled={!selectedReady || publish.isPending || recheckAttempt.isPending} onClick={() => buildPlan.mutate()}>{plan ? '重新检查计划' : '检查发布计划'}</Button>
      <Button type="primary" icon={<CheckCircleOutlined />} loading={publish.isPending} disabled={!plan || !requestId || planHasBlockers || buildPlan.isPending || recheckAttempt.isPending} onClick={() => publish.mutate()}>向 {selectedStoreIds.length} 家店铺提交</Button>
    </Flex>}
    onCancel={requestClose}
  >
    <Alert
      showIcon
      type="info"
      message="每家店铺生成独立 product.json、任务和平台结果"
      description="店铺之间可以并行，同一家店铺仍保持串行。发布计划会冻结店铺、双凭据版本、仓库、预设、Offer 合同、内容策略与当前公共素材版本；任一配置变化后必须重新检查计划。"
    />
    {stores.isLoading ? <Skeleton active /> : stores.isError ? <Alert className="ozon-publication-state" showIcon type="error" message="店铺列表加载失败" description={stores.error.message} action={<Button onClick={() => void stores.refetch()}>重试</Button>} /> : activeStores.length ? <div className="ozon-publication-store-list" role="list" aria-label="可选 OZON 店铺">
      {activeStores.map((store) => {
        const selected = selectedStoreIds.includes(store.id);
        const canPublish = storeCanPublish(store);
        const warehouse = store.warehouseName || store.warehouseId || '未选择';
        const preset = presets.data?.items.find((item) => item.id === store.defaultPresetId);
        return <section className={`ozon-publication-store${selected ? ' is-selected' : ''}${canPublish ? ' is-ready' : ''}`} role="listitem" key={store.id}>
          <div className="ozon-publication-store-check">
            <Checkbox aria-label={`选择店铺 ${store.displayName}`} checked={selected} disabled={!canPublish} onChange={(event) => toggleStore(store.id, event.target.checked)} />
            <div><strong title={store.displayName}>{store.displayName}</strong><code title={store.storeAlias}>{store.storeAlias}</code></div>
            <Tag color={canPublish ? 'green' : store.enabled ? 'gold' : 'default'}>{canPublish ? '可上品' : store.enabled ? '尚未就绪' : '已停用'}</Tag>
          </div>
          <div className="ozon-publication-store-meta"><span>仓库 <b title={warehouse}>{warehouse}</b></span><span>履约 <b>{store.fulfillmentMode}</b></span><span>策略 <b>{store.autoPublishMode === 'COMPATIBLE_UPSERT' ? '兼容更新' : '仅创建'}</b></span></div>
          <div className="ozon-publication-store-preset"><Text type="secondary">店铺默认预设</Text><strong title={preset?.name || store.defaultPresetId}>{preset?.name || store.defaultPresetId || '未配置'}</strong></div>
          {!canPublish && <Text type="secondary">{store.readiness.blockers[0] || '店铺当前不可提交'}</Text>}
        </section>;
      })}
    </div> : <Empty className="ozon-publication-state" image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可选择的 OZON 店铺" />}
    {planContract && <div className={`ozon-publication-plan${planHasBlockers ? ' has-blockers' : ''}`}>
      <div className="ozon-publication-plan-title"><div><span>FROZEN PUBLICATION PLAN</span><strong>发布计划已冻结</strong></div><Text type="secondary">{dayjs(planContract.createdAt).format('YYYY-MM-DD HH:mm:ss')} · R{planContract.revision}</Text></div>
      {planContract.items.map((item) => <div className="ozon-publication-plan-row" key={item.storeId}>
        <span>{item.ready ? <CheckCircleOutlined /> : <WarningOutlined />}</span>
        <div><strong>{item.displayName}</strong><code>{item.publicationId || item.jobId || item.taskId || item.materializationHash || item.storeAlias}</code><small>{item.publicationMode === 'COMPATIBLE_UPSERT' ? '兼容更新' : item.publicationMode === 'CREATE_ONLY' ? '仅创建' : ''}{item.presetRowVersion ? ` · 预设 R${item.presetRowVersion}` : ''}</small></div>
        <Tag color={item.ready ? 'green' : 'red'}>{item.ready ? '可提交' : '已阻塞'}</Tag>
        {item.blockers.length > 0 && <Text type="danger">{item.blockers.join('；')}</Text>}
      </div>)}
      <Text className="ozon-publication-plan-hash" type="secondary">plan {planContract.planHash}{planContract.contentPolicyVersion ? ` · ${planContract.contentPolicyVersion}` : ''}{planContract.materialHash ? ` · material ${planContract.materialHash}` : ''}</Text>
    </div>}
    {submission && <section className="ozon-publication-submit-results" aria-label="逐店提交结果">
      <Alert
        showIcon
        type={submission.failed ? 'warning' : 'success'}
        message={submission.failed ? `${submission.failed} 家店铺需要处理，窗口已保留` : '全部店铺已接受'}
        description={submission.failed ? '成功店铺继续执行；失败店铺已保留原 publication 和固定任务身份，可直接重检原任务。' : '每家店铺均已创建独立 publication。'}
      />
      <div role="list">
        {submission.results.map((result) => {
          const publication = submission.publications.find((item) => item.id === result.publicationId);
          const store = activeStores.find((item) => item.id === result.storeId);
          const failed = ['FAILED', 'NEEDS_ATTENTION'].includes(result.status);
          return <article className={failed ? 'has-error' : 'is-accepted'} role="listitem" key={`${result.storeId}:${result.publicationId}`}>
            <div><strong>{store?.displayName || publication?.storeDisplayNameSnapshot || result.storeId}</strong><code>{result.publicationId}</code></div>
            <Tag color={failed ? 'volcano' : 'green'}>{result.status}</Tag>
            {(result.errorCode || result.errorMessage) && <p><b>{result.errorCode || 'MATERIALIZATION_FAILED'}</b><span>{result.errorMessage || '该店铺需要重新检查原任务'}</span></p>}
            {failed && <Button
              size="small"
              icon={<SyncOutlined />}
              loading={recheckAttempt.isPending && recheckAttempt.variables?.publicationId === result.publicationId}
              onClick={() => recheckAttempt.mutate(result)}
            >重检原任务</Button>}
          </article>;
        })}
      </div>
    </section>}
  </Modal>;
}
