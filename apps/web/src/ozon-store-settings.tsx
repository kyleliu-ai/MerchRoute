import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiOutlined, CheckCircleOutlined, ClockCircleOutlined, ControlOutlined, DatabaseOutlined, DownOutlined,
  EditOutlined, FolderOpenOutlined, KeyOutlined, PauseCircleOutlined, PlusOutlined, ReloadOutlined,
  SafetyCertificateOutlined, SaveOutlined, SettingOutlined, ShopOutlined, StopOutlined, UpOutlined
} from '@ant-design/icons';
import {
  Alert, Badge, Button, Card, Checkbox, Col, Descriptions, Divider, Drawer, Empty, Flex, Form, Input,
  InputNumber, message, Modal, Progress, Row, Select, Skeleton, Space, Switch, Tabs, Tag, Tooltip, Typography
} from 'antd';
import dayjs from 'dayjs';
import {
  api,
  type OzonPreset,
  type OzonStore,
  type OzonStoreInput,
  type OzonStorePublishMode,
  type OzonStoreSettings
} from './api/client';
import {
  buildOzonStoreCreateInput,
  buildOzonStoreUpdateInput,
  DEFAULT_OZON_STORE_ACCOUNT_CURRENCY,
  ozonStoreCredentialCanPreflight,
  ozonStoreReadinessSteps,
  summarizeOzonStores
} from './ozon-store-settings-utils';
import './ozon-store-settings.css';

const { Text, Title } = Typography;

type OzonStoreEditorValues = Omit<OzonStoreInput, 'accountCurrency'> & {
  storeAlias: string;
  displayName: string;
  autoPublishMode: OzonStorePublishMode;
  fulfillmentMode: 'FBS' | 'RFBS';
  accountCurrency: OzonStore['accountCurrency'];
};
type StoreEditor = { mode: 'create' } | { mode: 'edit'; store: OzonStore };

function settingsEqual(left?: OzonStoreSettings, right?: OzonStoreSettings) {
  if (!left || !right) return left === right;
  return left.enabled === right.enabled
    && left.rootDirectory.trim() === right.rootDirectory.trim()
    && left.timezone === right.timezone
    && left.globalConcurrency === right.globalConcurrency
    && left.taskApiWebhookUrl.trim() === right.taskApiWebhookUrl.trim()
    && left.adminApiWebhookUrl.trim() === right.adminApiWebhookUrl.trim()
    && left.preflightWebhookUrl.trim() === right.preflightWebhookUrl.trim()
    && left.imageUploaderWorkflowId.trim() === right.imageUploaderWorkflowId.trim()
    && left.storeGatewayWorkflowId.trim() === right.storeGatewayWorkflowId.trim()
    && left.imageUploadConcurrency === right.imageUploadConcurrency
    && left.videoUploadConcurrency === right.videoUploadConcurrency
    && left.videoPrewarmEnabled === right.videoPrewarmEnabled;
}

function storeStatus(store: OzonStore, fullyReady: boolean) {
  if (store.archivedAt) return { color: 'default', label: '已归档' };
  if (!store.enabled) return { color: 'default', label: '已停用' };
  if (fullyReady) return { color: 'green', label: '可上品' };
  if (store.preflight.status === 'FAILED') return { color: 'red', label: '检查失败' };
  return { color: 'gold', label: '尚未就绪' };
}

function ReadinessRail({ store }: { store: OzonStore }) {
  const steps = ozonStoreReadinessSteps(store);
  const percent = Math.round((steps.filter((step) => step.ready).length / steps.length) * 100);
  return <div className="ozon-store-readiness" aria-label={`${store.displayName} 上品准备状态`}>
    <div className="ozon-store-readiness-meter"><span>STORE READINESS</span><Progress aria-label={`${store.displayName} 上品准备度`} percent={percent} size="small" showInfo={false} strokeColor="#16a4b2" /></div>
    <div className="ozon-store-readiness-track">
      {steps.map((step, index) => <div className={`ozon-store-readiness-step${step.ready ? ' is-ready' : ''}`} key={step.key}>
        <i aria-hidden="true">{step.ready ? <CheckCircleOutlined /> : String(index + 1).padStart(2, '0')}</i>
        <div><strong>{step.label}</strong><Text type="secondary" title={step.detail}>{step.detail}</Text></div>
      </div>)}
    </div>
  </div>;
}

function StoreCard({
  store,
  presetName,
  busy,
  onEdit,
  onCredential,
  onPreflight,
  onToggle,
  onArchive,
  expanded,
  onToggleDetails
}: {
  store: OzonStore;
  presetName?: string;
  busy: boolean;
  onEdit: () => void;
  onCredential: () => void;
  onPreflight: () => void;
  onToggle: () => void;
  onArchive: () => void;
  expanded: boolean;
  onToggleDetails: () => void;
}) {
  const archived = Boolean(store.archivedAt);
  const enableBlocked = !store.enabled && store.readiness.blockers.some((blocker) => blocker !== '店铺未启用');
  const readinessSteps = ozonStoreReadinessSteps(store);
  const identityVerified = readinessSteps.some((step) => step.key === 'identity' && step.ready);
  const readyStepCount = readinessSteps.filter((step) => step.ready).length;
  const fullyReady = readyStepCount === readinessSteps.length;
  const status = storeStatus(store, fullyReady);
  const readinessPercent = Math.round((readyStepCount / readinessSteps.length) * 100);
  const sellerLabel = store.seller.name || store.seller.id || '等待检查';
  const warehouseLabel = store.warehouseName || store.warehouseId || '未选择';
  const presetLabel = presetName || store.defaultPresetId || '未绑定';
  const publishLabel = store.autoPublishEnabled ? '参与自动上品' : '仅手动上品';
  const networkLabel = store.network.status === 'READY' ? '网络正常' : store.network.status === 'WAITING' ? '等待恢复' : '网络异常';
  const taskLoadLabel = `${store.taskLoad.running} 运行 · ${store.taskLoad.queued} 排队`;
  const headingId = `ozon-store-heading-${store.id}`;
  const detailsId = `ozon-store-details-${store.id}`;
  const limitEntries = Object.entries(store.limits || {}).filter(([, value]) => value !== undefined && value !== null);

  return <article className="ozon-store-card-item" role="listitem" aria-labelledby={headingId}>
    <Card className={`ozon-store-card${store.enabled ? ' is-enabled' : ''}${fullyReady ? ' is-ready' : ''}${archived ? ' is-archived' : ''}${expanded ? ' is-expanded' : ''}`}>
      <div className="ozon-store-card-summary">
        <div className="ozon-store-card-title">
          <span className="ozon-store-monogram" aria-hidden="true">{store.displayName.trim().slice(0, 1).toUpperCase() || 'O'}</span>
          <div><h3 id={headingId} title={store.displayName}>{store.displayName}</h3><code title={store.storeAlias}>{store.storeAlias}</code></div>
          <Tag color={status.color}>{status.label}</Tag>
        </div>
        <div className="ozon-store-readiness-summary" aria-label={`${store.displayName} 上品准备度 ${readyStepCount}/${readinessSteps.length}`}>
          <div><span>上品准备度</span><strong>{readyStepCount}/{readinessSteps.length}</strong></div>
          <Progress aria-label={`${store.displayName} 上品准备度`} percent={readinessPercent} size="small" showInfo={false} strokeColor="#16a4b2" />
        </div>
        <div className="ozon-store-card-quickfacts" aria-label={`${store.displayName} 关键运行信息`}>
          <div><span>WAREHOUSE</span><strong title={warehouseLabel}>{warehouseLabel}</strong></div>
          <div><span>DEFAULT PRESET</span><strong title={presetLabel}>{presetLabel}</strong></div>
          <div><span>NETWORK</span><strong title={networkLabel}>{networkLabel}</strong></div>
          <div><span>TASK LOAD</span><strong title={taskLoadLabel}>{taskLoadLabel}</strong></div>
        </div>
        <Flex className="ozon-store-actions" wrap="wrap" gap={6}>
          <Button icon={<EditOutlined />} disabled={busy || archived} onClick={onEdit}>编辑</Button>
          <Button icon={<KeyOutlined />} disabled={busy || archived} onClick={onCredential}>凭据</Button>
          <Button icon={<SafetyCertificateOutlined />} loading={busy && store.preflight.status === 'PENDING'} disabled={busy || archived || !ozonStoreCredentialCanPreflight(store)} onClick={onPreflight}>连接检查</Button>
          <Tooltip title={enableBlocked ? '完成双凭据、Seller 权限、仓库币种和默认预设检查后才能启用' : undefined}>
            <Button icon={store.enabled ? <PauseCircleOutlined /> : <CheckCircleOutlined />} disabled={busy || archived || enableBlocked} onClick={onToggle}>{store.enabled ? '停用' : '启用'}</Button>
          </Tooltip>
          <Button danger type="text" icon={<StopOutlined />} disabled={busy || archived || store.enabled || store.taskLoad.running > 0 || store.taskLoad.queued > 0} onClick={onArchive}>归档</Button>
        </Flex>
        <Button className="ozon-store-details-toggle" type="text" icon={expanded ? <UpOutlined /> : <DownOutlined />} aria-label={expanded ? '收起详情' : '展开详情'} aria-expanded={expanded} aria-controls={detailsId} onClick={onToggleDetails}>{expanded ? '收起详情' : '展开详情'}</Button>
      </div>
      {expanded && <div id={detailsId} className="ozon-store-card-details" role="region" aria-labelledby={headingId}>
        <ReadinessRail store={store} />
        <div className="ozon-store-card-detail-content">
          <div className="ozon-store-facts">
            <div><span>SELLER</span><strong title={sellerLabel}>{sellerLabel}</strong></div>
            <div><span>WAREHOUSE</span><strong title={warehouseLabel}>{warehouseLabel}</strong></div>
            <div><span>FULFILLMENT</span><strong>{store.fulfillmentMode}</strong></div>
            <div><span>DEFAULT PRESET</span><strong title={presetLabel}>{presetLabel}</strong></div>
            <div><span>AUTO PUBLISH</span><strong title={publishLabel}>{publishLabel}</strong></div>
            <div><span>TASK LOAD</span><strong title={taskLoadLabel}>{taskLoadLabel}</strong></div>
          </div>
          <div className="ozon-store-verification"><span>Seller 权限与额度</span><div>{store.permissions.length ? store.permissions.map((permission) => <Tag key={permission}>{permission}</Tag>) : identityVerified ? <Tag color="green">Seller 身份已验证</Tag> : <Text type="secondary">尚未检查</Text>}{limitEntries.map(([key, value]) => <Tag color="blue" key={key}>{key} {String(value)}</Tag>)}</div><small>{store.preflight.checkedAt ? `最近检查 ${dayjs(store.preflight.checkedAt).format('YYYY-MM-DD HH:mm')}` : '尚未执行连接检查'} · {store.preflight.currencyVerification === 'DEFERRED_EMPTY_CATALOG' ? '空店铺币种延后验证' : store.preflight.currencyVerified ? `${store.accountCurrency} 已验证` : '币种尚未验证'}</small></div>
          {store.readiness.blockers.length > 0 && !archived && <Alert className="ozon-store-blockers" type="warning" showIcon message={store.readiness.blockers[0]} description={store.readiness.blockers.length > 1 ? `另有 ${store.readiness.blockers.length - 1} 项需要处理` : undefined} />}
          {store.preflight.errorMessage && <Text className="ozon-store-error" type="danger">{store.preflight.errorMessage}</Text>}
          {store.network.errorMessage && <Text className="ozon-store-error" type="danger">{store.network.errorMessage}</Text>}
        </div>
      </div>}
    </Card>
  </article>;
}

export function OzonStoreSettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [activeTab, setActiveTab] = useState('stores');
  const [settingsDraft, setSettingsDraft] = useState<OzonStoreSettings>();
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<StoreEditor>();
  const [credentialStore, setCredentialStore] = useState<OzonStore>();
  const [credentialClientId, setCredentialClientId] = useState('');
  const [credentialApiKey, setCredentialApiKey] = useState('');
  const [videoProbePath, setVideoProbePath] = useState('');
  const [expandedStoreIds, setExpandedStoreIds] = useState<Set<string>>(() => new Set());
  const initializedStoreIds = useRef<Set<string>>(new Set());
  const [storeForm] = Form.useForm<OzonStoreEditorValues>();

  const settings = useQuery({ queryKey: ['ozon-settings'], queryFn: api.ozonSettings, enabled: open, retry: false });
  const stores = useQuery({
    queryKey: ['ozon-stores'], queryFn: () => api.ozonStores(true), enabled: open, retry: false,
    refetchInterval: (query) => query.state.data?.items.some((store) => store.preflight.status === 'PENDING') ? 2_000 : false
  });
  const presets = useQuery({ queryKey: ['ozon-presets'], queryFn: api.ozonPresets, enabled: open, retry: false });

  useEffect(() => {
    if (!open) return;
    void Promise.all([
      client.invalidateQueries({ queryKey: ['ozon-settings'] }),
      client.invalidateQueries({ queryKey: ['ozon-stores'] })
    ]);
  }, [client, open]);
  useEffect(() => { if (settings.data?.settings && open) setSettingsDraft(settings.data.settings); }, [open, settings.data?.settings]);
  useEffect(() => {
    if (!open) {
      initializedStoreIds.current.clear();
      setExpandedStoreIds(new Set());
      return;
    }
    const newStores = (stores.data?.items || []).filter((store) => !initializedStoreIds.current.has(store.id));
    if (!newStores.length) return;
    newStores.forEach((store) => initializedStoreIds.current.add(store.id));
    const autoExpandedIds = newStores.filter((store) => !store.archivedAt && (!store.readiness.ready || store.readiness.blockers.length > 0 || Boolean(store.preflight.errorMessage) || store.network.status !== 'READY')).map((store) => store.id);
    if (!autoExpandedIds.length) return;
    setExpandedStoreIds((current) => new Set([...current, ...autoExpandedIds]));
  }, [open, stores.data?.items]);

  const refreshStores = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['ozon-stores'] }),
      client.invalidateQueries({ queryKey: ['ozon-settings'] }),
      client.invalidateQueries({ queryKey: ['ozon-system'] }),
      client.invalidateQueries({ queryKey: ['ozon-automation-status'] })
    ]);
  };
  const saveSettings = useMutation({
    mutationFn: () => api.updateOzonSettings({
      rowVersion: settingsDraft!.rowVersion,
      enabled: settingsDraft!.enabled,
      rootDirectory: settingsDraft!.rootDirectory.trim(),
      timezone: settingsDraft!.timezone,
      globalConcurrency: settingsDraft!.globalConcurrency,
      taskApiWebhookUrl: settingsDraft!.taskApiWebhookUrl.trim(),
      adminApiWebhookUrl: settingsDraft!.adminApiWebhookUrl.trim(),
      preflightWebhookUrl: settingsDraft!.preflightWebhookUrl.trim(),
      imageUploaderWorkflowId: settingsDraft!.imageUploaderWorkflowId.trim(),
      storeGatewayWorkflowId: settingsDraft!.storeGatewayWorkflowId.trim(),
      imageUploadConcurrency: settingsDraft!.imageUploadConcurrency,
      videoUploadConcurrency: settingsDraft!.videoUploadConcurrency,
      videoPrewarmEnabled: settingsDraft!.videoPrewarmEnabled
    }),
    onSuccess: async ({ settings: saved }) => {
      setSettingsDraft(saved);
      message.success('OZON 公共与运行设置已保存');
      await Promise.all([client.invalidateQueries({ queryKey: ['ozon-settings'] }), client.invalidateQueries({ queryKey: ['ozon-system'] }), client.invalidateQueries({ queryKey: ['ozon-automation-status'] })]);
    },
    onError: (error: Error) => message.error(error.message)
  });
  const validateDirectory = useMutation({
    mutationFn: () => api.validatePath(settingsDraft?.rootDirectory.trim() || ''),
    onSuccess: (result) => message[result.exists && result.readable && result.writable ? 'success' : 'warning'](result.exists ? `${result.readable ? '可读' : '不可读'} / ${result.writable ? '可写' : '只读'}` : result.error || '目录不存在'),
    onError: (error: Error) => message.error(error.message)
  });
  const videoProbe = useMutation({
    mutationFn: () => api.probeOzonVideoUpload(videoProbePath.trim()),
    onSuccess: async (result) => { message[result.ready ? 'success' : 'warning'](result.message); await Promise.all([client.invalidateQueries({ queryKey: ['ozon-settings'] }), client.invalidateQueries({ queryKey: ['ozon-system'] })]); },
    onError: (error: Error) => message.error(error.message)
  });
  const credential = useMutation({
    mutationFn: () => api.updateOzonStoreCredentials(credentialStore!.id, credentialClientId.trim(), credentialApiKey.trim(), credentialStore!.rowVersion),
    onSuccess: async () => { message.success('Client-Id 与 Api-Key 已作为同一版本加密保存，明文不会回显'); setCredentialStore(undefined); setCredentialClientId(''); setCredentialApiKey(''); await refreshStores(); },
    onError: (error: Error) => message.error(error.message)
  });
  const preflight = useMutation({
    mutationFn: (store: OzonStore) => api.preflightOzonStore(store.id, store.rowVersion),
    onSuccess: async ({ store }) => { message[store.readiness.ready ? 'success' : 'warning'](store.readiness.ready ? `${store.displayName} 连接检查通过` : `${store.displayName} 仍有 ${store.readiness.blockers.length} 项需要处理`); await refreshStores(); },
    onError: async (error: Error) => { message.error(error.message); await refreshStores(); },
    retry: false
  });
  const saveStore = useMutation({
    mutationFn: async (values: OzonStoreEditorValues) => {
      const activeEditor = editor;
      if (!activeEditor) throw new Error('店铺编辑器已关闭，请重新打开后保存');
      if (activeEditor.mode === 'edit') {
        const result = await api.updateOzonStore(activeEditor.store.id, buildOzonStoreUpdateInput(values, activeEditor.store.rowVersion));
        return { ...result, mode: 'edit' as const };
      }
      const result = await api.createOzonStore(buildOzonStoreCreateInput(values));
      return { ...result, mode: 'create' as const };
    },
    onSuccess: async ({ store, mode }) => {
      message.success(mode === 'edit' ? '店铺设置已保存' : '店铺已创建，请继续录入双凭据并执行连接检查');
      setEditor(undefined);
      storeForm.resetFields();
      if (mode === 'edit' && ozonStoreCredentialCanPreflight(store)) {
        try {
          await preflight.mutateAsync(store);
        } catch {
          // The store update is already committed. The preflight mutation owns
          // error feedback and refreshing the saved store state.
        }
        return;
      }
      await refreshStores();
      if (!ozonStoreCredentialCanPreflight(store)) { setCredentialStore(store); setCredentialClientId(''); setCredentialApiKey(''); }
    },
    onError: (error: Error) => message.error(error.message)
  });
  const toggleStore = useMutation({
    mutationFn: (store: OzonStore) => api.setOzonStoreEnabled(store.id, !store.enabled, store.rowVersion),
    onSuccess: async ({ store }) => { message.success(`${store.displayName} 已${store.enabled ? '启用' : '停用'}`); await refreshStores(); },
    onError: (error: Error) => message.error(error.message)
  });
  const archiveStore = useMutation({
    mutationFn: (store: OzonStore) => api.archiveOzonStore(store.id, store.rowVersion),
    onSuccess: async ({ store }) => { message.success(`${store.displayName} 已归档，历史 publication 与 OZON 商品身份仍然保留`); await refreshStores(); },
    onError: (error: Error) => message.error(error.message)
  });

  const allStores = stores.data?.items || [];
  const visibleStores = allStores.filter((store) => showArchived || !store.archivedAt);
  const summary = useMemo(() => summarizeOzonStores(allStores), [allStores]);
  const settingsDirty = !settingsEqual(settingsDraft, settings.data?.settings);
  const requestClose = () => {
    if (!settingsDirty) { onClose(); return; }
    Modal.confirm({ title: '放弃未保存的 OZON 设置？', content: '店铺中已经单独保存的修改不会撤销。', okText: '放弃修改', okButtonProps: { danger: true }, cancelText: '继续编辑', onOk: onClose });
  };
  const openCreate = () => {
    setEditor({ mode: 'create' });
    storeForm.setFieldsValue({ storeAlias: '', displayName: '', defaultPresetId: undefined, autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY', warehouseId: '', fulfillmentMode: 'FBS', accountCurrency: DEFAULT_OZON_STORE_ACCOUNT_CURRENCY, maxDailyStyles: 100 });
  };
  const openEdit = (store: OzonStore) => {
    setEditor({ mode: 'edit', store });
    storeForm.setFieldsValue({ storeAlias: store.storeAlias, displayName: store.displayName, defaultPresetId: store.defaultPresetId, autoPublishEnabled: store.autoPublishEnabled, autoPublishMode: store.autoPublishMode, warehouseId: store.warehouseId, fulfillmentMode: store.fulfillmentMode, accountCurrency: store.accountCurrency, maxDailyStyles: store.maxDailyStyles });
  };
  const closeEditor = () => {
    if (!storeForm.isFieldsTouched()) { setEditor(undefined); storeForm.resetFields(); return; }
    Modal.confirm({ title: '放弃未保存的店铺设置？', okText: '放弃修改', okButtonProps: { danger: true }, cancelText: '继续编辑', onOk: () => { setEditor(undefined); storeForm.resetFields(); } });
  };
  const presetOptions = (presets.data?.items || []).map((preset: OzonPreset) => ({ value: preset.id, label: preset.name }));
  const editorStore = editor?.mode === 'edit' ? allStores.find((store) => store.id === editor.store.id) || editor.store : undefined;
  const warehouseOptions = (editorStore?.warehouses || []).filter((warehouse) => !['DISABLED', 'ARCHIVED'].includes(String(warehouse.status || '').toUpperCase())).map((warehouse) => ({ value: warehouse.id, label: `${warehouse.name} · ${warehouse.id}` }));
  if (editorStore?.warehouseId && !warehouseOptions.some((option) => option.value === editorStore.warehouseId)) warehouseOptions.push({ value: editorStore.warehouseId, label: `${editorStore.warehouseName || '当前仓库'} · ${editorStore.warehouseId}` });

  const storeTab = <div className="ozon-store-settings-tab">
    <div className="ozon-store-settings-toolbar">
      <div><Title level={4}>长期运行的 OZON 店铺</Title><Text type="secondary">每家店铺独立保存 Seller 身份、双凭据、仓库、默认预设和自动上品策略；一家店铺故障不会阻塞其他店铺。</Text></div>
      <Space wrap><Checkbox checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)}>显示已归档</Checkbox><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建店铺</Button></Space>
    </div>
    <div className="ozon-store-summary" aria-label="OZON 店铺运行摘要">
      <div><span>STORES</span><strong>{summary.total}</strong><small>长期店铺</small></div>
      <div><span>ENABLED</span><strong>{summary.enabled}</strong><small>允许接收任务</small></div>
      <div className="is-accent"><span>READY</span><strong>{summary.ready}</strong><small>可以提交任务</small></div>
      <div><span>LOAD</span><strong>{summary.runningTasks + summary.queuedTasks}</strong><small>{summary.runningTasks} 运行 · {summary.queuedTasks} 排队</small></div>
    </div>
    {stores.isLoading ? <Skeleton active /> : stores.isError ? <Alert type="error" showIcon message="店铺列表加载失败" description={stores.error.message} action={<Button onClick={() => void stores.refetch()}>重试</Button>} /> : visibleStores.length ? <div className="ozon-store-grid" role="list" aria-label="OZON 店铺列表">
      {visibleStores.map((store) => <StoreCard
        key={store.id} store={store} presetName={presets.data?.items.find((preset) => preset.id === store.defaultPresetId)?.name}
        busy={saveStore.isPending || credential.isPending || preflight.isPending || toggleStore.isPending || archiveStore.isPending}
        onEdit={() => openEdit(store)} onCredential={() => { setCredentialStore(store); setCredentialClientId(''); setCredentialApiKey(''); }} onPreflight={() => preflight.mutate(store)}
        onToggle={() => Modal.confirm({ title: `${store.enabled ? '停用' : '启用'}“${store.displayName}”？`, content: store.enabled ? '停止领取新任务；历史 UNKNOWN 和远端未终态任务仍会只读回查并安全收尾。' : '启用后可接受手动任务；自动上品是否参与由本店铺开关决定。', okText: store.enabled ? '确认停用' : '确认启用', okButtonProps: store.enabled ? { danger: true } : undefined, cancelText: '取消', onOk: () => toggleStore.mutateAsync(store) })}
        onArchive={() => Modal.confirm({ title: `归档“${store.displayName}”？`, content: '店铺历史、publication、Offer 映射和 OZON 商品链接都会保留；归档店铺不再参与上品。', okText: '确认归档', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => archiveStore.mutateAsync(store) })}
        expanded={expandedStoreIds.has(store.id)} onToggleDetails={() => setExpandedStoreIds((current) => { const next = new Set(current); if (next.has(store.id)) next.delete(store.id); else next.add(store.id); return next; })}
      />)}
    </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 OZON 店铺"><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建第一个店铺</Button></Empty>}
  </div>;

  const integrationTab = settings.isError ? <Alert type="error" showIcon message="公共设置加载失败" description={settings.error.message} action={<Button onClick={() => void settings.refetch()}>重试</Button>} /> : settings.isLoading || !settingsDraft ? <Skeleton active /> : <div className="ozon-store-settings-tab">
    <Alert type="info" showIcon message="MerchRoute 只保存加密、版本化且不可回读的 OZON 双凭据" description="Client-Id 与 Api-Key 只在具体店铺的“凭据”操作中成对写入。n8n 工作流只接收短时认证上下文，不保存多店明文凭据。" />
    <Card className="ozon-settings-section" title={<Space><FolderOpenOutlined />公共目录</Space>}>
      <Flex className="ozon-settings-enable" justify="space-between" align="center" gap={16}><div><strong>启用 OZON 上品管理</strong><Text type="secondary">这是所有店铺的总开关；关闭后不创建新任务，历史 UNKNOWN 和远端任务仍可安全收尾。</Text></div><Switch aria-label="启用 OZON 上品管理" checked={settingsDraft.enabled} onChange={(enabled) => setSettingsDraft({ ...settingsDraft, enabled })} /></Flex>
      <Form layout="vertical"><Form.Item label="OZON 自动上品根目录" extra="使用绝对路径；各店素材入口位于 stores/<storeAlias>/inbox，执行目录统一进入 processing/<taskId>，成功后归档到 success/<日期>/<taskId>，可迁移到 macOS。"><Input aria-label="OZON 自动上品根目录" prefix={<FolderOpenOutlined />} value={settingsDraft.rootDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, rootDirectory: event.target.value })} /></Form.Item></Form>
      <div className="ozon-settings-path-map"><div><span>共享产品资料</span><code>{settingsDraft.rootDirectory || '<根目录>'}/inbox/&lt;SKU&gt;/variants</code></div><div><span>店铺发布包</span><code>{settingsDraft.rootDirectory || '<根目录>'}/stores/&lt;storeAlias&gt;/...</code></div></div>
      <Flex justify="flex-end" gap={8} wrap><Button icon={<ReloadOutlined />} loading={validateDirectory.isPending} disabled={!settingsDraft.rootDirectory.trim()} onClick={() => validateDirectory.mutate()}>验证目录</Button><Button type="primary" icon={<SaveOutlined />} loading={saveSettings.isPending} disabled={!settingsDirty || (settingsDraft.enabled && !settingsDraft.rootDirectory.trim())} onClick={() => saveSettings.mutate()}>保存公共设置</Button></Flex>
    </Card>
    <Card className="ozon-settings-section" title={<Space><DatabaseOutlined />n8n 集成边界</Space>}>
      <Form layout="vertical">
        <Row gutter={12}><Col xs={24} md={12}><Form.Item label="OZON-P001 任务 Webhook"><Input value={settingsDraft.taskApiWebhookUrl} onChange={(event) => setSettingsDraft({ ...settingsDraft, taskApiWebhookUrl: event.target.value })} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="OZON-P003 管理 Webhook"><Input value={settingsDraft.adminApiWebhookUrl} onChange={(event) => setSettingsDraft({ ...settingsDraft, adminApiWebhookUrl: event.target.value })} /></Form.Item></Col></Row>
        <Form.Item label="OZON-C001 每店只读预检 Webhook"><Input value={settingsDraft.preflightWebhookUrl} onChange={(event) => setSettingsDraft({ ...settingsDraft, preflightWebhookUrl: event.target.value })} /></Form.Item>
        <Row gutter={12}><Col xs={24} md={12}><Form.Item label="图片上传工作流 ID"><Input value={settingsDraft.imageUploaderWorkflowId} onChange={(event) => setSettingsDraft({ ...settingsDraft, imageUploaderWorkflowId: event.target.value })} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="多店铺安全网关工作流 ID"><Input value={settingsDraft.storeGatewayWorkflowId} onChange={(event) => setSettingsDraft({ ...settingsDraft, storeGatewayWorkflowId: event.target.value })} /></Form.Item></Col></Row>
      </Form>
      <Divider orientation="left">共享 MP4 能力</Divider>
      <Flex gap={8} wrap><Input aria-label="E004 MP4 能力探测文件" value={videoProbePath} onChange={(event) => setVideoProbePath(event.target.value)} placeholder="E004 候选视频目录中的 .mp4 绝对路径" style={{ flex: '1 1 360px' }} /><Button icon={<ApiOutlined />} loading={videoProbe.isPending} disabled={!videoProbePath.trim()} onClick={() => videoProbe.mutate()}>验证 MP4 公网读取</Button></Flex>
      {settingsDraft.videoUploadCheckedAt && <Alert type={settingsDraft.videoUploadReady ? 'success' : 'warning'} showIcon message={settingsDraft.videoUploadReady ? 'MP4 上传能力已验证' : 'MP4 上传能力未通过'} description={`${settingsDraft.videoUploadMessage || '未返回说明'} · ${dayjs(settingsDraft.videoUploadCheckedAt).format('YYYY-MM-DD HH:mm:ss')}`} />}
    </Card>
  </div>;

  const advancedTab = settings.isError ? <Alert type="error" showIcon message="运行参数加载失败" description={settings.error.message} action={<Button onClick={() => void settings.refetch()}>重试</Button>} /> : settings.isLoading || !settingsDraft ? <Skeleton active /> : <div className="ozon-store-settings-tab">
    <Card className="ozon-settings-section" title={<Space><ControlOutlined />调度与运行参数</Space>}>
      <Form layout="vertical"><Row gutter={14}>
        <Col xs={24} md={8}><Form.Item label="全局并行店铺数" extra="第一版上限固定为 2。"><InputNumber aria-label="全局并行店铺数" min={1} max={2} value={settingsDraft.globalConcurrency} onChange={(value) => setSettingsDraft({ ...settingsDraft, globalConcurrency: Number(value || 1) })} /></Form.Item></Col>
        <Col xs={24} md={8}><Form.Item label="单店写任务数" extra="同一 Seller 账号始终串行写入。"><InputNumber aria-label="单店写任务数" readOnly value={settingsDraft.perStoreConcurrency} /></Form.Item></Col>
        <Col xs={24} md={8}><Form.Item label="运行时区"><Select aria-label="运行时区" value={settingsDraft.timezone} onChange={(timezone) => setSettingsDraft({ ...settingsDraft, timezone })} options={[{ value: 'Asia/Shanghai' }, { value: 'Europe/Moscow' }, { value: 'UTC' }]} /></Form.Item></Col>
        <Col xs={24} md={8}><Form.Item label="图片上传并发"><InputNumber min={1} max={7} value={settingsDraft.imageUploadConcurrency} onChange={(value) => setSettingsDraft({ ...settingsDraft, imageUploadConcurrency: Number(value || 1) })} /></Form.Item></Col>
        <Col xs={24} md={8}><Form.Item label="视频上传并发"><InputNumber min={1} max={2} value={settingsDraft.videoUploadConcurrency} onChange={(value) => setSettingsDraft({ ...settingsDraft, videoUploadConcurrency: Number(value || 1) })} /></Form.Item></Col>
        <Col xs={24} md={8}><Form.Item label="视频预热"><Switch checked={settingsDraft.videoPrewarmEnabled} onChange={(videoPrewarmEnabled) => setSettingsDraft({ ...settingsDraft, videoPrewarmEnabled })} /></Form.Item></Col>
      </Row></Form>
      <div className="ozon-scheduler-lanes" aria-label="OZON 多店铺调度示意"><div className="is-active"><span>STORE A</span><b>写槽 1</b></div><div className="is-active"><span>STORE B</span><b>写槽 2</b></div><div className="is-waiting"><span>STORE C</span><b>等待全局槽位</b></div></div>
      <Flex justify="flex-end"><Button type="primary" icon={<SaveOutlined />} loading={saveSettings.isPending} disabled={!settingsDirty} onClick={() => saveSettings.mutate()}>保存运行参数</Button></Flex>
    </Card>
    <Card className="ozon-settings-section" title={<Space><ClockCircleOutlined />安全边界</Space>}><Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[{ key: 'global', label: '全局并发', children: '最多 2 家店铺' }, { key: 'store', label: '单店写并发', children: '固定 1' }, { key: 'unknown', label: 'UNKNOWN', children: '只读回查，不盲目重试' }, { key: 'credential', label: '历史任务', children: '固定原凭据版本' }]} /></Card>
  </div>;

  return <>
    <Drawer className="ozon-store-settings-drawer" open={open} width="min(1160px, 100vw)" title={<div className="ozon-store-settings-title"><span><SettingOutlined /></span><div><strong>OZON上品设置</strong><Text type="secondary">多店铺身份、双凭据、目录与调度控制台</Text></div></div>} extra={<Space wrap><Badge status={summary.ready > 0 ? 'success' : 'warning'} text={`${summary.ready}/${summary.total} 店铺可用`} />{summary.runningTasks > 0 && <Tag color="processing">{summary.runningTasks} 个运行中</Tag>}</Space>} onClose={requestClose}>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[{ key: 'stores', label: <Space><ShopOutlined />店铺管理</Space>, children: storeTab }, { key: 'integration', label: <Space><DatabaseOutlined />公共设置</Space>, children: integrationTab }, { key: 'advanced', label: <Space><ControlOutlined />运行参数</Space>, children: advancedTab }]} />
    </Drawer>
    <Drawer className="ozon-store-editor-drawer" open={Boolean(editor)} width="min(680px, 100vw)" title={editor?.mode === 'edit' ? `编辑店铺 · ${editor.store.displayName}` : '新建 OZON 店铺'} onClose={closeEditor} extra={<Button type="primary" icon={<SaveOutlined />} loading={saveStore.isPending} onClick={() => void storeForm.validateFields().then((values) => saveStore.mutate(values))}>{editor?.mode === 'edit' ? '保存店铺' : '创建店铺'}</Button>}>
      <Alert showIcon type="info" message={editor?.mode === 'edit' ? '店铺别名不可修改' : '店铺创建后默认保持停用'} description={editor?.mode === 'edit' ? '目录、publication 和任务身份都依赖该别名；显示名称可以调整。' : '创建后继续录入 Client-Id + Api-Key、执行连接检查、选择实际仓库，再手动启用。'} />
      <Form form={storeForm} layout="vertical" className="ozon-store-editor-form">
        <Row gutter={14}><Col xs={24} md={10}><Form.Item label="店铺别名" name="storeAlias" rules={[{ required: true, message: '请输入店铺别名' }, { pattern: /^[a-z0-9][a-z0-9-]{1,31}$/, message: '使用 2–32 位小写字母、数字或连字符' }]}><Input className="mono-input" readOnly={editor?.mode === 'edit'} placeholder="例如 ozon-main" /></Form.Item></Col><Col xs={24} md={14}><Form.Item label="店铺显示名称" name="displayName" rules={[{ required: true, message: '请输入店铺显示名称' }]}><Input placeholder="例如 OZON 俄罗斯主店" /></Form.Item></Col></Row>
        <Row gutter={14}><Col xs={24} md={12}><Form.Item label="默认上品预设" name="defaultPresetId" extra="创建时可暂不选择，可在连接检查后补齐；启用和上品前由店铺准备度校验。"><Select allowClear showSearch optionFilterProp="label" loading={presets.isLoading} placeholder="可稍后选择" options={presetOptions} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="发布模式" name="autoPublishMode" rules={[{ required: true }]}><Select options={[{ value: 'CREATE_ONLY' satisfies OzonStorePublishMode, label: '仅创建新商品' }, { value: 'COMPATIBLE_UPSERT' satisfies OzonStorePublishMode, label: '兼容更新既有商品' }]} /></Form.Item></Col></Row>
        <Form.Item label="参与自动上品" name="autoPublishEnabled" valuePropName="checked"><Switch checkedChildren="参与" unCheckedChildren="仅手动" /></Form.Item>
        <Divider orientation="left">OZON 仓库与履约</Divider>
        <Row gutter={14}><Col xs={24} md={16}><Form.Item label="默认仓库" name="warehouseId" rules={editor?.mode === 'edit' ? [{ required: true, message: '连接检查后请选择实际仓库' }] : undefined} extra={warehouseOptions.length ? '列表来自当前店铺最近一次只读连接检查。' : '录入凭据并完成连接检查后才能选择实际仓库。'}><Select showSearch optionFilterProp="label" disabled={!warehouseOptions.length} placeholder="等待连接检查返回仓库" options={warehouseOptions} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="履约模式" name="fulfillmentMode" rules={[{ required: true }]}><Select options={[{ value: 'FBS' }, { value: 'RFBS', label: 'rFBS' }]} /></Form.Item></Col></Row>
        <Row gutter={14}><Col xs={24} md={12}><Form.Item label="账户币种" name="accountCurrency" rules={[{ required: true, message: '请选择 OZON 账户币种' }]} extra="必须与 OZON Seller 账户实际结算币种一致；修改后需重新执行连接检查。"><Select options={[{ value: 'CNY', label: 'CNY · 人民币' }, { value: 'RUB', label: 'RUB · 俄罗斯卢布' }]} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="每日任务上限" name="maxDailyStyles"><InputNumber min={1} max={100000} /></Form.Item></Col></Row>
      </Form>
    </Drawer>
    <Modal open={Boolean(credentialStore)} title={`凭据 · ${credentialStore?.displayName || ''}`} okText="加密保存双凭据" cancelText="取消" confirmLoading={credential.isPending} okButtonProps={{ disabled: !credentialClientId.trim() || credentialApiKey.trim().length < 20 }} onCancel={() => { if (!credential.isPending) { setCredentialStore(undefined); setCredentialClientId(''); setCredentialApiKey(''); } }} onOk={() => credential.mutate()}>
      <Alert showIcon type="warning" message="Client-Id 与 Api-Key 必须成对写入且不会再次显示" description="保存后页面只显示同一凭据版本的指纹和更新时间。请确认两个值属于同一个 Seller 账号，再执行连接检查。" />
      {credentialStore?.credential.state === 'LEGACY_EXTERNAL' && <Alert showIcon type="info" message="当前店铺仍使用旧 n8n Credential" description="重新录入后切换到 Vault；历史任务仍固定使用创建时的凭据绑定模式。" />}
      <Form layout="vertical" className="ozon-store-credential-form"><Form.Item label="OZON Client-Id" required><Input.Password aria-label="OZON Client-Id" autoComplete="new-password" value={credentialClientId} onChange={(event) => setCredentialClientId(event.target.value)} placeholder="粘贴完整 Client-Id" /></Form.Item><Form.Item label="OZON Api-Key" required validateStatus={credentialApiKey && credentialApiKey.trim().length < 20 ? 'error' : undefined} help={credentialApiKey && credentialApiKey.trim().length < 20 ? 'Api-Key 长度不足，请粘贴完整内容' : undefined}><Input.Password aria-label="OZON Api-Key" autoComplete="new-password" value={credentialApiKey} onChange={(event) => setCredentialApiKey(event.target.value)} placeholder="粘贴完整 Api-Key" /></Form.Item></Form>
    </Modal>
  </>;
}
