import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Modal, Select, Space, Table, Tooltip, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { OZON_RETRY_EXPLANATION, type OzonPublishJob, type OzonPublishRetryPlan, type OzonPublishRetryRequest, type OzonStore } from '@n8n-media-review/shared';
import { api, ApiError } from './api/client';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};

export function ozonDuplicateCardNotice(plan?: Pick<OzonPublishRetryPlan, 'blockerCode' | 'blockedOffers'>): {
  title: string;
  description: string;
} | undefined {
  if (plan?.blockerCode !== 'OZON_DUPLICATE_PRODUCT_CARD') return undefined;
  const duplicateOffers = (plan.blockedOffers || []).map((offer) => offer.offerId).filter(Boolean).join('、');
  const conflictOffers = [...new Set((plan.blockedOffers || []).flatMap((offer) => offer.conflictOfferIds))].join('、');
  return {
    title: '商品卡重复',
    description: `OZON 判定 ${duplicateOffers || '当前商品'} 与已有商品卡 ${conflictOffers || '平台现有商品'} 类似或重复。请在 OZON 后台处理后同步平台状态，或取消自动任务。`
  };
}

export function OzonPublishRetry({ job, stores, onOpenJob, actionContainer }: {
  job: OzonPublishJob; stores: OzonStore[]; onOpenJob: (id: string, storeId: string) => void; actionContainer?: HTMLElement | null;
}) {
  const payload = record(job.payload);
  const preparation = job.taskKind === 'SHARED_PREPARATION' || (payload.multistorePreparation === true && !job.publicationId);
  const boundStoreId = preparation ? undefined : job.storeId || payload.storeId;
  const storeIds = [...new Set<string>(boundStoreId ? [boundStoreId] : [
    ...(record(payload.fanoutPlan).items || []).map((item: any) => item.storeId),
    ...(record(payload.prePlanRecovery).targetStores || []).map((item: any) => item.id)
  ].filter(Boolean))];
  const [selection, setSelection] = useState<string>();
  const storeId = boundStoreId || selection || (storeIds.length === 1 ? storeIds[0] : undefined);
  const [confirmation, setConfirmation] = useState<OzonPublishRetryPlan>();
  const pending = useRef<{ jobId: string; input: OzonPublishRetryRequest }>();
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: ['ozon-retry-plan', job.id, storeId],
    queryFn: () => api.ozonPublishRetryPlan(job.id, storeId!), enabled: Boolean(storeId), retry: false,
    refetchInterval: query => ['CHECKING', 'RUNNING'].includes(query.state.data?.plan.latest?.status || '') ? 3_000 : false
  });
  const retry = useMutation({
    mutationFn: async (approved: OzonPublishRetryPlan) => {
      // A lost HTTP response is not a failed operation. Reuse the same request
      // identity until its receipt is known, including after a second click.
      pending.current ||= { jobId: job.id, input: { storeId: approved.storeId, planHash: approved.planHash, requestId: crypto.randomUUID(), confirmRebuild: approved.requiresConfirmation } };
      return api.retryOzonPublish(pending.current.jobId, pending.current.input);
    },
    onSuccess: async () => {
      pending.current = undefined;
      setConfirmation(undefined);
      message.info('重试上品已受理，正在检查并接续执行；尚未完成上品');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ozon-retry-plan'] }),
        queryClient.invalidateQueries({ queryKey: ['ozon-auto-jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['ozon-auto-job'] }),
        queryClient.invalidateQueries({ queryKey: ['ozon-preparation-task-detail'] })
      ]);
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) pending.current = undefined;
      message.error(error instanceof ApiError ? error.userMessage : error.message); void plan.refetch();
    }
  });
  const begin = async () => {
    if (pending.current) {
      retry.mutate(plan.data!.plan);
      return;
    }
    const result = await plan.refetch();
    if (!result.data || result.error) { message.error(result.error?.message || '重试计划读取失败'); return; }
    if (!result.data.plan.canRetry) { message.warning(result.data.plan.blockedReason || '当前任务不能重试'); return; }
    if (result.data.plan.requiresConfirmation) setConfirmation(result.data.plan);
    else retry.mutate(result.data.plan);
  };
  const current = plan.data?.plan;
  const latest = current?.latest;
  useEffect(() => {
    if (!latest) return;
    void queryClient.invalidateQueries({ queryKey: ['ozon-auto-jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['ozon-auto-job'] });
    void queryClient.invalidateQueries({ queryKey: ['ozon-preparation-task-detail'] });
  }, [latest?.updatedAt, latest?.status, queryClient]);
  const busy = ['CHECKING', 'RUNNING'].includes(latest?.status || '');
  const reason = !storeId ? '请先选择本次要重试的店铺' : plan.error?.message || current?.blockedReason;
  const duplicateCardNotice = ozonDuplicateCardNotice(current);
  const action = <Tooltip title={reason || OZON_RETRY_EXPLANATION}><span className="ozon-auto-job-action-tooltip"><Button icon={<ReloadOutlined />} aria-label={pending.current ? '确认重试受理结果' : '重试上品'}
    loading={retry.isPending || plan.isFetching} disabled={!storeId || (!pending.current && (!current?.canRetry || busy))}
    onClick={() => void begin()}>{pending.current ? '确认重试受理结果' : '重试上品'}</Button></span></Tooltip>;
  return <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }} aria-label="OZON 重试上品">
    <Space wrap>
      {!boundStoreId && <Select aria-label="重试店铺" placeholder="选择要重试的店铺" value={storeId} style={{ minWidth: 190 }} disabled={retry.isPending || Boolean(pending.current)}
        options={storeIds.map(id => ({ value: id, label: stores.find(store => store.id === id)?.displayName || id }))} onChange={setSelection} />}
      {actionContainer ? createPortal(action, actionContainer) : action}
      {plan.isError && <Button onClick={() => void plan.refetch()}>重新读取重试条件</Button>}
    </Space>
    {duplicateCardNotice && <Alert showIcon type="error" message={duplicateCardNotice.title}
      description={duplicateCardNotice.description} />}
    {!latest && <Typography.Text type="secondary">{reason || OZON_RETRY_EXPLANATION}</Typography.Text>}
    {latest && <Alert showIcon type={latest.status === 'SUCCEEDED' ? 'success' : busy ? 'info' : 'warning'}
      message={latest.message} description={<Space direction="vertical" size={4}>
        {latest.previousError && <span>上次停止原因：{latest.previousError}</span>}
        <span>只处理当前店铺；已成功的其他店铺不受影响。</span>
        {latest.effectiveJobId && latest.effectiveJobId !== job.id && <Button size="small" onClick={() => onOpenJob(latest.effectiveJobId!, latest.storeId)}>打开接续任务</Button>}
        {latest.sourceJobId !== job.id && <Button size="small" onClick={() => onOpenJob(latest.sourceJobId, latest.storeId)}>查看原失败任务</Button>}
      </Space>} />}
    <Modal title="确认重建当前店铺上品资料" open={Boolean(confirmation)} onCancel={() => setConfirmation(undefined)}
      okText="确认并重试上品" cancelText="取消" confirmLoading={retry.isPending}
      onOk={() => confirmation && retry.mutate(confirmation)} destroyOnClose>
      {confirmation && <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message={`仅重试 ${confirmation.storeName} · SKU ${confirmation.sku}`}
          description="原店铺资料不完整，将保留原公共素材，按当前预设重新生成该店铺资料并建立接续任务。其他店铺不变；旧失败任务保留，取消不会创建任务。" />
        <Typography.Text>Offer：{confirmation.offerIds.join('、') || '生成后按原公共素材核验'}</Typography.Text>
        <Table size="small" pagination={false} rowKey="label" dataSource={confirmation.changes} columns={[
          { title: '项目', dataIndex: 'label' }, { title: '原冻结值', dataIndex: 'previous' }, { title: '本次使用', dataIndex: 'current' }
        ]} />
      </Space>}
    </Modal>
  </Space>;
}
