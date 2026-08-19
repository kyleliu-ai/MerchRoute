import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircleOutlined, ShopOutlined, SyncOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Empty, Flex, message, Modal, Skeleton, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  api,
  ApiError,
  type WbListing,
  type WbPublicationPlan,
  type WbPublicationSelection,
  type WbStore
} from './api/client';
import { defaultManualWbStoreIds } from './wb-store-settings-utils';

const { Text } = Typography;

function storeCanPublish(store: WbStore) {
  return !store.archivedAt && store.enabled && store.readiness.ready;
}

export function WbPublicationDialog({
  listing,
  open,
  onClose,
  onSubmitted
}: {
  listing: WbListing;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => Promise<unknown>;
}) {
  const stores = useQuery({ queryKey: ['wb-stores'], queryFn: api.wbStores, enabled: open, retry: false });
  const presets = useQuery({ queryKey: ['wb-presets'], queryFn: api.wbPresets, enabled: open, retry: false });
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<WbPublicationPlan>();
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedStoreIds([]);
      setPlan(undefined);
      setInitialized(false);
      return;
    }
    if (!initialized && stores.data?.items) {
      setSelectedStoreIds(defaultManualWbStoreIds(stores.data.items));
      setInitialized(true);
    }
  }, [initialized, open, stores.data?.items]);

  const activeStores = (stores.data?.items || []).filter((store) => !store.archivedAt);
  const selections = useMemo<WbPublicationSelection[]>(() => selectedStoreIds.map((storeId) => ({ storeId })), [selectedStoreIds]);
  const selectedReady = selections.length > 0 && selections.every((selection) => {
    const store = activeStores.find((item) => item.id === selection.storeId);
    return Boolean(store && storeCanPublish(store));
  });
  const planHasBlockers = Boolean(plan?.items.some((item) => !item.ready || item.blockers.length));

  const buildPlan = useMutation({
    mutationFn: () => api.planWbPublications(listing.sku, listing.draftVersion, selections),
    onSuccess: ({ plan: next }) => setPlan(next),
    onError: (error: Error) => message.error(error instanceof ApiError ? error.userMessage : error.message)
  });
  const publish = useMutation({
    mutationFn: () => api.createWbPublications(listing.sku, plan!.planHash, listing.draftVersion, selections),
    onSuccess: async ({ accepted, failed, failures }) => {
      message[failed ? 'warning' : 'success'](`${accepted} 家店铺已创建独立发布任务${failed ? `，${failed} 家未接受` : ''}`);
      if (failures.length) message.warning(failures.map((item) => `${item.storeAlias}：${item.message}`).join('；'));
      await onSubmitted();
      onClose();
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status === 409) {
        setPlan(undefined);
        message.warning('公共素材、店铺、凭据、采购版本或预设已变化，请重新检查发布计划');
        return;
      }
      message.error(error.message);
    }
  });
  const toggleStore = (storeId: string, checked: boolean) => {
    setSelectedStoreIds((current) => checked ? [...current, storeId] : current.filter((id) => id !== storeId));
    setPlan(undefined);
  };
  const requestClose = () => {
    if (buildPlan.isPending || publish.isPending) return;
    onClose();
  };

  return <Modal
    className="wb-publication-modal"
    width={900}
    open={open}
    title={<Space><ShopOutlined /><span>选择发布店铺 · {listing.sku}</span></Space>}
    footer={<Flex justify="flex-end" wrap="wrap" gap={8}>
      <Button disabled={buildPlan.isPending || publish.isPending} onClick={requestClose}>返回工作台</Button>
      <Button icon={<SyncOutlined />} loading={buildPlan.isPending} disabled={!selectedReady || publish.isPending} onClick={() => buildPlan.mutate()}>{plan ? '重新检查计划' : '检查发布计划'}</Button>
      <Button type="primary" icon={<CheckCircleOutlined />} loading={publish.isPending} disabled={!plan || planHasBlockers || buildPlan.isPending} onClick={() => publish.mutate()}>向 {selectedStoreIds.length} 家店铺提交</Button>
    </Flex>}
    onCancel={requestClose}
  >
    <Alert
      showIcon
      type="info"
      message="每家店铺按自己的默认预设完整生成"
      description="公共素材中的产品变体、图片、视频和顺序会被复用；每家店铺分别生成价格、折扣、类目、标题、详情、包装、特征与尺码，并创建独立且不可变的 product.json 发布包。"
    />
    {stores.isLoading ? <Skeleton active /> : stores.isError ? <Alert className="wb-publication-state" showIcon type="error" message="店铺列表加载失败" description={stores.error.message} action={<Button onClick={() => void stores.refetch()}>重试</Button>} /> : activeStores.length ? <div className="wb-publication-store-list">
      {activeStores.map((store) => {
        const selected = selectedStoreIds.includes(store.id);
        const canPublish = storeCanPublish(store);
        return <section className={`wb-publication-store${selected ? ' is-selected' : ''}${canPublish ? ' is-ready' : ''}`} key={store.id}>
          <div className="wb-publication-store-check">
            <Checkbox aria-label={`选择店铺 ${store.displayName}`} checked={selected} disabled={!canPublish} onChange={(event) => toggleStore(store.id, event.target.checked)} />
            <div><strong>{store.displayName}</strong><code>{store.storeAlias}</code></div>
            <Tag color={canPublish ? 'green' : store.enabled ? 'gold' : 'default'}>{canPublish ? '可上品' : store.enabled ? '尚未就绪' : '已停用'}</Tag>
          </div>
          <div className="wb-publication-store-meta"><span>仓库 <b>{store.warehouseName || store.warehouseId || '未选择'}</b></span><span>模式 <b>{store.autoPublishMode === 'COMPATIBLE_UPSERT' ? '兼容更新' : '仅创建'}</b></span></div>
          <div className="wb-publication-store-preset">
            <Text type="secondary">店铺默认预设（生成依据）</Text>
            <strong>{presets.data?.items.find((preset) => preset.id === store.defaultPresetId)?.name || store.defaultPresetId || '未配置'}</strong>
          </div>
          {!canPublish && <Text type="secondary">{store.readiness.blockers[0] || '店铺当前不可提交'}</Text>}
        </section>;
      })}
    </div> : <Empty className="wb-publication-state" image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可选择的 WB 店铺" />}
    {plan && <div className={`wb-publication-plan${planHasBlockers ? ' has-blockers' : ''}`}>
      <div className="wb-publication-plan-title"><div><span>FROZEN PUBLICATION PLAN</span><strong>逐店铺发布计划已冻结</strong></div><Text type="secondary">{dayjs(plan.createdAt).format('YYYY-MM-DD HH:mm:ss')}</Text></div>
      {plan.items.map((item) => <div className="wb-publication-plan-row" key={item.storeId}>
        <span>{item.ready ? <CheckCircleOutlined /> : <WarningOutlined />}</span>
        <div><strong>{item.displayName}</strong><Text type="secondary">{item.presetName || item.presetId || '未配置预设'}</Text></div>
        <Space size={[4, 4]} wrap>
          {item.discountPercent !== undefined && <Tag color="blue">折扣 {item.discountPercent}%</Tag>}
          {item.expectedPriceCny !== undefined && <Tag>预计上架价 ¥{item.expectedPriceCny.toFixed(2)}</Tag>}
          {item.categoryKey && <Tag>{item.categoryName || item.categoryKey}</Tag>}
          {item.packaging && <Tag>{item.packaging.lengthCm}×{item.packaging.widthCm}×{item.packaging.heightCm} cm · {item.packaging.grossWeightGrams} g</Tag>}
        </Space>
        <Tag color={item.ready ? 'green' : 'red'}>{item.ready ? '可提交' : '已阻塞'}</Tag>
        {item.blockers.length > 0 && <Text type="danger">{item.blockers.join('；')}</Text>}
      </div>)}
      <Text className="wb-publication-plan-hash" type="secondary">plan {plan.planHash}</Text>
    </div>}
  </Modal>;
}
