import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiOutlined, CheckCircleOutlined, ClockCircleOutlined, ControlOutlined, DatabaseOutlined, DownOutlined, EditOutlined,
  FolderOpenOutlined, KeyOutlined, PauseCircleOutlined, PlusOutlined, ReloadOutlined,
  SafetyCertificateOutlined, SaveOutlined, SettingOutlined, ShopOutlined, StopOutlined, SyncOutlined, UpOutlined
} from '@ant-design/icons';
import {
  Alert, Badge, Button, Card, Checkbox, Col, Descriptions, Divider, Drawer, Empty, Flex, Form, Input, InputNumber,
  message, Modal, Progress, Row, Select, Skeleton, Space, Switch, Tabs, Tag, Tooltip, Typography
} from 'antd';
import dayjs from 'dayjs';
import {
  api,
  type WbListingPreset,
  type WbStore,
  type WbStoreInput,
  type WbStorePublishMode,
  type WbSystemSettings
} from './api/client';
import { summarizeWbStores, wbStoreReadinessSteps } from './wb-store-settings-utils';

const { Text, Title } = Typography;

type WbStoreEditorValues = WbStoreInput & { storeAlias: string };
type StoreEditor = { mode: 'create' } | { mode: 'edit'; store: WbStore };
type WbStorePreflightRequest = { store: WbStore; source: 'manual' | 'auto-after-save' };

function settingsEqual(left?: WbSystemSettings, right?: WbSystemSettings) {
  if (!left || !right) return left === right;
  return left.enabled === right.enabled
    && left.rootDirectory.trim() === right.rootDirectory.trim()
    && left.timezone === right.timezone
    && left.globalConcurrency === right.globalConcurrency;
}

function storeStatus(store: WbStore) {
  if (store.archivedAt) return { color: 'default', label: '已归档' };
  if (!store.enabled) return { color: 'default', label: '已停用' };
  if (store.readiness.ready) return { color: 'green', label: '可上品' };
  if (store.preflight.status === 'FAILED') return { color: 'red', label: '检查失败' };
  return { color: 'gold', label: '尚未就绪' };
}

function ReadinessRail({ store }: { store: WbStore }) {
  const steps = wbStoreReadinessSteps(store);
  const percent = Math.round((steps.filter((step) => step.ready).length / steps.length) * 100);
  return <div className="wb-store-readiness" aria-label={`${store.displayName} 上品准备状态`}>
    <div className="wb-store-readiness-meter"><span>STORE READINESS</span><Progress percent={percent} size="small" showInfo={false} strokeColor="#16a4b2" /></div>
    <div className="wb-store-readiness-track">
      {steps.map((step, index) => <div className={`wb-store-readiness-step${step.ready ? ' is-ready' : ''}`} key={step.key}>
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
  store: WbStore;
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
  const status = storeStatus(store);
  const archived = Boolean(store.archivedAt);
  const enableBlocked = !store.enabled && store.readiness.blockers.some((blocker) => blocker !== '店铺未启用');
  const readinessSteps = wbStoreReadinessSteps(store);
  const readyStepCount = readinessSteps.filter((step) => step.ready).length;
  const readinessPercent = Math.round((readyStepCount / readinessSteps.length) * 100);
  const sellerLabel = store.seller.name || store.seller.id || '等待检查';
  const warehouseLabel = store.warehouseName || store.warehouseId || '未选择';
  const presetLabel = presetName || store.defaultPresetId || '未绑定';
  const publishLabel = store.autoPublishEnabled ? '参与自动上品' : '仅手动上品';
  const networkLabel = store.network?.status === 'READY' ? '网络正常' : store.network?.status === 'WAITING' ? '等待恢复' : store.network?.status === 'ERROR' ? '网络异常' : '等待检查';
  const taskLoadLabel = `${store.activeTaskCount} 运行 · ${store.queuedTaskCount} 排队`;
  const headingId = `wb-store-heading-${store.id}`;
  const detailsId = `wb-store-details-${store.id}`;

  return <article className="wb-store-card-item" role="listitem" aria-labelledby={headingId}>
    <Card className={`wb-store-card${store.enabled ? ' is-enabled' : ''}${store.readiness.ready ? ' is-ready' : ''}${archived ? ' is-archived' : ''}${expanded ? ' is-expanded' : ''}`}>
      <div className="wb-store-card-summary">
        <div className="wb-store-card-title">
          <span className="wb-store-monogram" aria-hidden="true">{store.displayName.trim().slice(0, 1).toUpperCase() || 'W'}</span>
          <div><h3 id={headingId} title={store.displayName}>{store.displayName}</h3><code title={store.storeAlias}>{store.storeAlias}</code></div>
          <Tag color={status.color}>{status.label}</Tag>
        </div>
        <div className="wb-store-readiness-summary" aria-label={`${store.displayName} 上品准备度 ${readyStepCount}/${readinessSteps.length}`}>
          <div><span>上品准备度</span><strong>{readyStepCount}/{readinessSteps.length}</strong></div>
          <Progress percent={readinessPercent} size="small" showInfo={false} strokeColor="#16a4b2" />
        </div>
        <div className="wb-store-card-quickfacts" aria-label={`${store.displayName} 关键运行信息`}>
          <div><span>WAREHOUSE</span><strong title={warehouseLabel}>{warehouseLabel}</strong></div>
          <div><span>DEFAULT PRESET</span><strong title={presetLabel}>{presetLabel}</strong></div>
          <div><span>NETWORK</span><strong title={networkLabel}>{networkLabel}</strong></div>
          <div><span>TASK LOAD</span><strong title={taskLoadLabel}>{taskLoadLabel}</strong></div>
        </div>
        <Flex className="wb-store-actions" wrap="wrap" gap={6}>
          <Button icon={<EditOutlined />} disabled={busy || archived} onClick={onEdit}>编辑</Button>
          <Button icon={<KeyOutlined />} disabled={busy || archived} onClick={onCredential}>{store.credential.configured ? '替换 Token' : '设置 Token'}</Button>
          <Button icon={<SafetyCertificateOutlined />} loading={busy && store.preflight.status === 'PENDING'} disabled={busy || archived || !store.credential.configured} onClick={onPreflight}>连接检查</Button>
          <Tooltip title={enableBlocked ? '完成 Token、身份权限、仓库币种和默认预设检查后才能启用' : undefined}>
            <Button icon={store.enabled ? <PauseCircleOutlined /> : <CheckCircleOutlined />} disabled={busy || archived || enableBlocked} onClick={onToggle}>{store.enabled ? '停用' : '启用'}</Button>
          </Tooltip>
          <Button danger type="text" icon={<StopOutlined />} disabled={busy || archived || store.enabled || store.activeTaskCount > 0 || store.queuedTaskCount > 0} onClick={onArchive}>归档</Button>
        </Flex>
        <Button
          className="wb-store-details-toggle"
          type="text"
          icon={expanded ? <UpOutlined /> : <DownOutlined />}
          aria-label={expanded ? '收起详情' : '展开详情'}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggleDetails}
        >{expanded ? '收起详情' : '展开详情'}</Button>
      </div>
      {expanded && <div id={detailsId} className="wb-store-card-details" role="region" aria-labelledby={headingId}>
        <ReadinessRail store={store} />
        <div className="wb-store-card-detail-content">
          <div className="wb-store-facts">
            <div><span>SELLER</span><strong title={sellerLabel}>{sellerLabel}</strong></div>
            <div><span>WAREHOUSE</span><strong title={warehouseLabel}>{warehouseLabel}</strong></div>
            <div><span>DEFAULT PRESET</span><strong title={presetLabel}>{presetLabel}</strong></div>
            <div><span>AUTO PUBLISH</span><strong title={publishLabel}>{publishLabel}</strong></div>
            <div><span>NETWORK</span><strong title={networkLabel}>{networkLabel}</strong></div>
            <div><span>TASK LOAD</span><strong title={taskLoadLabel}>{taskLoadLabel}</strong></div>
          </div>
          <div className="wb-store-verification"><span>权限</span><div>{store.permissions.length ? store.permissions.map((permission) => <Tag key={permission}>{permission}</Tag>) : <Text type="secondary">尚未检查</Text>}</div><small>{store.preflight.checkedAt ? `最近检查 ${dayjs(store.preflight.checkedAt).format('YYYY-MM-DD HH:mm')}` : '尚未执行连接检查'}</small></div>
          {store.readiness.blockers.length > 0 && !archived && <Alert className="wb-store-blockers" type="warning" showIcon message={store.readiness.blockers[0]} description={store.readiness.blockers.length > 1 ? `另有 ${store.readiness.blockers.length - 1} 项需要处理` : undefined} />}
          {store.preflight.errorMessage && <Text className="wb-store-error" type="danger">{store.preflight.errorMessage}</Text>}
        </div>
      </div>}
    </Card>
  </article>;
}

export function WbStoreSettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [activeTab, setActiveTab] = useState('stores');
  const [settingsDraft, setSettingsDraft] = useState<WbSystemSettings>();
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<StoreEditor>();
  const [credentialStore, setCredentialStore] = useState<WbStore>();
  const [credentialToken, setCredentialToken] = useState('');
  const [expandedStoreIds, setExpandedStoreIds] = useState<Set<string>>(() => new Set());
  const initializedStoreIds = useRef<Set<string>>(new Set());
  const [storeForm] = Form.useForm<WbStoreEditorValues>();

  const settings = useQuery({ queryKey: ['wb-settings'], queryFn: api.wbSettings, enabled: open, retry: false });
  const stores = useQuery({
    queryKey: ['wb-stores'],
    queryFn: api.wbStores,
    enabled: open,
    retry: false,
    refetchInterval: (query) => query.state.data?.items.some((store) => store.preflight.status === 'PENDING') ? 2_000 : false
  });
  const presets = useQuery({ queryKey: ['wb-presets'], queryFn: api.wbPresets, enabled: open, retry: false });
  useEffect(() => {
    if (open) {
      void client.invalidateQueries({ queryKey: ['wb-settings'] });
      void client.invalidateQueries({ queryKey: ['wb-stores'] });
    }
  }, [client, open]);
  useEffect(() => {
    if (settings.data?.settings && open) setSettingsDraft(settings.data.settings);
  }, [open, settings.data?.settings]);
  useEffect(() => {
    if (!open) {
      initializedStoreIds.current.clear();
      setExpandedStoreIds(new Set());
      return;
    }
    const newStores = (stores.data?.items || []).filter((store) => !initializedStoreIds.current.has(store.id));
    if (!newStores.length) return;
    newStores.forEach((store) => initializedStoreIds.current.add(store.id));
    const autoExpandedIds = newStores
      .filter((store) => !store.archivedAt && (store.readiness.blockers.length > 0 || Boolean(store.preflight.errorMessage)))
      .map((store) => store.id);
    if (!autoExpandedIds.length) return;
    setExpandedStoreIds((current) => {
      const next = new Set(current);
      autoExpandedIds.forEach((id) => next.add(id));
      return next;
    });
  }, [open, stores.data?.items]);

  const refreshStores = async () => {
    await client.invalidateQueries({ queryKey: ['wb-stores'] });
    await client.invalidateQueries({ queryKey: ['config'] });
  };
  const saveSettings = useMutation({
    mutationFn: () => api.updateWbSettings({
      enabled: Boolean(settingsDraft?.enabled),
      rootDirectory: settingsDraft?.rootDirectory.trim() || '',
      timezone: settingsDraft?.timezone || 'Asia/Shanghai',
      globalConcurrency: settingsDraft?.globalConcurrency || 2,
      rowVersion: settingsDraft?.rowVersion || 0
    }),
    onSuccess: async ({ settings: next }) => { setSettingsDraft(next); message.success('WB 公共设置已保存'); await client.invalidateQueries({ queryKey: ['wb-settings'] }); await client.invalidateQueries({ queryKey: ['config'] }); },
    onError: (error: Error) => message.error(error.message)
  });
  const validateDirectory = useMutation({
    mutationFn: () => api.validatePath(settingsDraft?.rootDirectory.trim() || ''),
    onSuccess: (result) => message[result.exists && result.readable && result.writable ? 'success' : 'warning'](result.exists ? `${result.readable ? '可读' : '不可读'} / ${result.writable ? '可写' : '只读'}` : result.error || '目录不存在'),
    onError: (error: Error) => message.error(error.message)
  });
  const syncDirectory = useMutation({
    mutationFn: api.syncWbPublishing,
    onSuccess: async () => { message.success('WB 运行目录已同步到 n8n'); await client.invalidateQueries({ queryKey: ['config'] }); },
    onError: (error: Error) => message.error(error.message)
  });
  const preflight = useMutation({
    mutationFn: ({ store }: WbStorePreflightRequest) => api.preflightWbStore(store.id),
    retry: false,
    onSuccess: ({ store }) => {
      if (store.preflight.status === 'PENDING') message.info(`${store.displayName} 的连接检查已受理`);
      else message[store.readiness.ready ? 'success' : 'warning'](store.readiness.ready ? `${store.displayName} 已通过连接检查` : `${store.displayName} 仍有未完成配置`);
    },
    onError: (error: Error, request) => {
      if (request.source === 'auto-after-save') message.warning(`店铺设置已保存，但自动连接检查失败：${error.message}`);
      else message.error(error.message);
    },
    onSettled: refreshStores
  });
  const saveStore = useMutation({
    mutationFn: async (values: WbStoreEditorValues) => {
      const targetEditor = editor;
      if (!targetEditor) throw new Error('店铺编辑状态已失效，请重新打开后再试');
      const response = targetEditor.mode === 'edit'
        ? await api.updateWbStore(targetEditor.store.id, {
          displayName: values.displayName.trim(),
          defaultPresetId: values.defaultPresetId || null,
          autoPublishEnabled: values.autoPublishEnabled,
          autoPublishMode: values.autoPublishMode,
          warehouseId: values.warehouseId?.trim() || undefined,
          warehouseName: values.warehouseName?.trim() || undefined,
          accountCurrency: values.accountCurrency?.trim().toUpperCase() || 'CNY',
          maxDailyStyles: values.maxDailyStyles,
          rowVersion: targetEditor.store.rowVersion
        })
        : await api.createWbStore({
          storeAlias: values.storeAlias.trim(),
          displayName: values.displayName.trim(),
          defaultPresetId: values.defaultPresetId || null,
          autoPublishEnabled: values.autoPublishEnabled,
          autoPublishMode: values.autoPublishMode,
          warehouseId: values.warehouseId?.trim() || undefined,
          warehouseName: values.warehouseName?.trim() || undefined,
          accountCurrency: values.accountCurrency?.trim().toUpperCase() || 'CNY',
          maxDailyStyles: values.maxDailyStyles
        });
      return { ...response, editorMode: targetEditor.mode };
    },
    onSuccess: async ({ store, editorMode }) => {
      message.success(editorMode === 'edit' ? '店铺设置已保存' : '店铺已创建，请继续设置 Token 并执行连接检查');
      setEditor(undefined);
      storeForm.resetFields();
      if (editorMode === 'edit' && store.credential.configured) {
        await preflight.mutateAsync({ store, source: 'auto-after-save' }).catch(() => undefined);
      } else {
        await refreshStores();
      }
      if (!store.credential.configured) { setCredentialStore(store); setCredentialToken(''); }
    },
    onError: (error: Error) => message.error(error.message)
  });
  const credential = useMutation({
    mutationFn: () => api.updateWbStoreCredential(credentialStore!.id, credentialToken.trim(), credentialStore!.rowVersion),
    onSuccess: async () => { message.success('Token 已加密保存，明文不会回显'); setCredentialStore(undefined); setCredentialToken(''); await refreshStores(); },
    onError: (error: Error) => message.error(error.message)
  });
  const toggleStore = useMutation({
    mutationFn: (store: WbStore) => api.setWbStoreEnabled(store.id, !store.enabled, store.rowVersion),
    onSuccess: async ({ store }) => { message.success(`${store.displayName} 已${store.enabled ? '启用' : '停用'}`); await refreshStores(); },
    onError: (error: Error) => message.error(error.message)
  });
  const archiveStore = useMutation({
    mutationFn: (store: WbStore) => api.archiveWbStore(store.id, store.rowVersion),
    onSuccess: async ({ store }) => { message.success(`${store.displayName} 已归档，历史记录仍然保留`); await refreshStores(); },
    onError: (error: Error) => message.error(error.message)
  });

  const allStores = stores.data?.items || [];
  const visibleStores = showArchived ? allStores : allStores.filter((store) => !store.archivedAt);
  const summary = useMemo(() => summarizeWbStores(allStores), [allStores]);
  const settingsDirty = !settingsEqual(settingsDraft, settings.data?.settings);
  const requestClose = () => {
    if (!settingsDirty) { onClose(); return; }
    Modal.confirm({ title: '放弃未保存的 WB 公共设置？', content: '店铺中已经单独保存的修改不会撤销。', okText: '放弃修改', okButtonProps: { danger: true }, cancelText: '继续编辑', onOk: onClose });
  };
  const openCreate = () => {
    storeForm.setFieldsValue({ storeAlias: '', displayName: '', autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY', accountCurrency: 'CNY', maxDailyStyles: 100 });
    setEditor({ mode: 'create' });
  };
  const openEdit = (store: WbStore) => {
    storeForm.setFieldsValue({
      storeAlias: store.storeAlias,
      displayName: store.displayName,
      defaultPresetId: store.defaultPresetId,
      autoPublishEnabled: store.autoPublishEnabled,
      autoPublishMode: store.autoPublishMode,
      warehouseId: store.warehouseId,
      warehouseName: store.warehouseName,
      accountCurrency: store.accountCurrency || 'CNY',
      maxDailyStyles: store.maxDailyStyles || 100
    });
    setEditor({ mode: 'edit', store });
  };
  const closeEditor = () => {
    if (!storeForm.isFieldsTouched()) { setEditor(undefined); return; }
    Modal.confirm({ title: '放弃未保存的店铺设置？', okText: '放弃修改', okButtonProps: { danger: true }, cancelText: '继续编辑', onOk: () => { setEditor(undefined); storeForm.resetFields(); } });
  };
  const presetOptions = (presets.data?.items || []).map((preset: WbListingPreset) => ({ value: preset.id, label: `${preset.name}${preset.readiness === 'BROKEN' ? ' · 配置异常' : ''}`, disabled: preset.readiness === 'BROKEN' }));

  const storeTab = <div className="wb-store-settings-tab">
    <div className="wb-store-settings-toolbar">
      <div><Title level={4}>长期运行的 WB 店铺</Title><Text type="secondary">每家店铺独立保存身份、仓库、预设和自动上品策略；一个店铺故障不会阻塞其他店铺。</Text></div>
      <Space wrap><Checkbox checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)}>显示已归档</Checkbox><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建店铺</Button></Space>
    </div>
    <div className="wb-store-summary" aria-label="WB 店铺运行摘要">
      <div><span>STORES</span><strong>{summary.total}</strong><small>{summary.enabled} 家已启用</small></div>
      <div className="is-accent"><span>READY</span><strong>{summary.ready}</strong><small>可以提交任务</small></div>
      <div><span>RUNNING</span><strong>{summary.activeTasks}</strong><small>单店最多 1 个</small></div>
      <div><span>QUEUED</span><strong>{summary.queuedTasks}</strong><small>等待店铺执行槽</small></div>
    </div>
    {stores.isLoading ? <Skeleton active /> : stores.isError ? <Alert type="error" showIcon message="店铺列表加载失败" description={stores.error.message} action={<Button onClick={() => void stores.refetch()}>重试</Button>} /> : visibleStores.length ? <div className="wb-store-grid" role="list" aria-label="WB 店铺列表">
      {visibleStores.map((store) => {
        const busy = store.preflight.status === 'PENDING' || (preflight.isPending && preflight.variables?.store.id === store.id) || (toggleStore.isPending && toggleStore.variables?.id === store.id) || (archiveStore.isPending && archiveStore.variables?.id === store.id);
        return <StoreCard
          key={store.id}
          store={store}
          presetName={presets.data?.items.find((preset) => preset.id === store.defaultPresetId)?.name}
          busy={busy}
          onEdit={() => openEdit(store)}
          onCredential={() => { setCredentialStore(store); setCredentialToken(''); }}
          onPreflight={() => preflight.mutate({ store, source: 'manual' })}
          onToggle={() => Modal.confirm({ title: `${store.enabled ? '停用' : '启用'}“${store.displayName}”？`, content: store.enabled ? '停止接收和领取新任务；已领取任务会完成必要写入与回读，排队任务会保留。' : '启用后可接受手动任务；自动上品是否参与由店铺开关决定。', okText: store.enabled ? '确认停用' : '确认启用', okButtonProps: store.enabled ? { danger: true } : undefined, cancelText: '取消', onOk: () => toggleStore.mutateAsync(store) })}
          onArchive={() => Modal.confirm({ title: `归档“${store.displayName}”？`, content: '店铺历史、任务结果和 WB 商品链接都会保留；归档店铺不再参与上品。', okText: '确认归档', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => archiveStore.mutateAsync(store) })}
          expanded={expandedStoreIds.has(store.id)}
          onToggleDetails={() => setExpandedStoreIds((current) => {
            const next = new Set(current);
            if (next.has(store.id)) next.delete(store.id);
            else next.add(store.id);
            return next;
          })}
        />;
      })}
    </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 WB 店铺"><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建第一个店铺</Button></Empty>}
  </div>;

  const integrationTab = settings.isError ? <Alert type="error" showIcon message="公共设置加载失败" description={settings.error.message} action={<Button onClick={() => void settings.refetch()}>重试</Button>} /> : settings.isLoading || !settingsDraft ? <Skeleton active /> : <div className="wb-store-settings-tab">
    <Card className="wb-settings-section" title={<Space><FolderOpenOutlined />公共目录</Space>}>
      <Flex className="wb-settings-enable" justify="space-between" align="center" gap={16}><div><strong>启用 WB 上品管理</strong><Text type="secondary">这是所有店铺的总开关；关闭后保留配置与历史，但不再创建新任务。</Text></div><Switch aria-label="启用 WB 上品管理" checked={settingsDraft.enabled} onChange={(enabled) => setSettingsDraft({ ...settingsDraft, enabled })} /></Flex>
      <Form layout="vertical">
        <Form.Item label="WB 自动上品根目录" required={settingsDraft.enabled} extra="所有店铺共用一个根目录，店铺发布包由系统隔离到 stores/<店铺别名>。">
          <Input aria-label="WB 自动上品根目录" prefix={<FolderOpenOutlined />} value={settingsDraft.rootDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, rootDirectory: event.target.value })} placeholder="例如 G:\\01_MerchRoute\\WB-Auto-Publish" />
        </Form.Item>
      </Form>
      <div className="wb-settings-path-map"><div><span>共享产品资料</span><code>{settingsDraft.rootDirectory || '<根目录>'}/inbox/&lt;SKU&gt;/variants</code></div><div><span>店铺发布包</span><code>{settingsDraft.rootDirectory || '<根目录>'}/stores/&lt;storeAlias&gt;/...</code></div></div>
      <Flex justify="flex-end" wrap="wrap" gap={8}>
        <Button icon={<ReloadOutlined />} loading={validateDirectory.isPending} disabled={!settingsDraft.rootDirectory.trim()} onClick={() => validateDirectory.mutate()}>验证目录</Button>
        <Tooltip title={settingsDirty ? '请先保存公共设置' : undefined}><Button icon={<SyncOutlined />} loading={syncDirectory.isPending} disabled={settingsDirty || !settingsDraft.enabled || !settingsDraft.rootDirectory.trim()} onClick={() => syncDirectory.mutate()}>同步到 n8n</Button></Tooltip>
        <Button type="primary" icon={<SaveOutlined />} loading={saveSettings.isPending} disabled={!settingsDirty || (settingsDraft.enabled && !settingsDraft.rootDirectory.trim())} onClick={() => saveSettings.mutate()}>保存公共设置</Button>
      </Flex>
    </Card>
    <Card className="wb-settings-section" title={<Space><ApiOutlined />集成边界</Space>}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[
        { key: 'token', label: 'WB Token', children: <Badge status="processing" text="由 MerchRoute 按店铺加密托管" /> },
        { key: 'n8n', label: 'n8n 调用', children: <Badge status="success" text="只传 taskId 与 operation" /> },
        { key: 'root', label: '目录所有者', children: 'WB上品设置（唯一入口）' },
        { key: 'network', label: '网络代理', children: '沿用系统 Clash 域名路由' }
      ]} />
      <Alert showIcon type="info" message="店铺 Token 不会进入 n8n" description="Token 明文不会回显，也不会写入工作流定义、执行数据或普通日志。替换 Token 后需要重新执行连接检查。" />
    </Card>
  </div>;

  const advancedTab = settings.isError ? <Alert type="error" showIcon message="运行参数加载失败" description={settings.error.message} action={<Button onClick={() => void settings.refetch()}>重试</Button>} /> : settings.isLoading || !settingsDraft ? <Skeleton active /> : <div className="wb-store-settings-tab">
    <Card className="wb-settings-section" title={<Space><ControlOutlined />调度与运行参数</Space>}>
      <Alert showIcon type="info" message="店铺内串行，店铺间并行" description="同一家店铺最多一个 WB 写任务；不同店铺可并行执行，第三家店铺会公平排队。" />
      <Form layout="vertical">
        <Row gutter={14}>
          <Col xs={24} md={8}><Form.Item label="全局并行店铺数" extra="第一版上限固定为 2。"><InputNumber aria-label="全局并行店铺数" min={1} max={2} value={settingsDraft.globalConcurrency} onChange={(value) => setSettingsDraft({ ...settingsDraft, globalConcurrency: Number(value || 1) })} /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item label="单店写任务数" extra="防止同一 Seller 账号并发写入。"><InputNumber aria-label="单店写任务数" readOnly value={settingsDraft.perStoreConcurrency} /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item label="运行时区"><Select aria-label="运行时区" value={settingsDraft.timezone} onChange={(timezone) => setSettingsDraft({ ...settingsDraft, timezone })} options={[{ value: 'Asia/Shanghai', label: 'Asia/Shanghai' }, { value: 'Europe/Moscow', label: 'Europe/Moscow' }, { value: 'UTC', label: 'UTC' }]} /></Form.Item></Col>
        </Row>
      </Form>
      <div className="wb-scheduler-lanes" aria-label="WB 多店铺调度示意">
        <div><span>STORE A</span><b>当前任务</b><i>店内等待</i></div>
        <div><span>STORE B</span><b>当前任务</b><i>店内等待</i></div>
        <div className="is-waiting"><span>STORE C</span><b>等待全局槽位</b></div>
      </div>
      <Flex justify="flex-end"><Button type="primary" icon={<SaveOutlined />} loading={saveSettings.isPending} disabled={!settingsDirty} onClick={() => saveSettings.mutate()}>保存运行参数</Button></Flex>
    </Card>
    <Card className="wb-settings-section" title={<Space><ClockCircleOutlined />安全预算</Space>}>
      <div className="wb-runtime-constants"><div><span>图片批次</span><strong>3 张</strong></div><div><span>视频批次</span><strong>1 个</strong></div><div><span>任务预算</span><strong>480 秒</strong></div><div><span>请求间隔</span><strong>650 ms</strong></div></div>
      <Text type="secondary">这些保护值由工作流版本控制，在这里展示但不允许单店绕过。</Text>
    </Card>
  </div>;

  return <>
    <Drawer
      className="wb-store-settings-drawer"
      open={open}
      width="min(1160px, 100vw)"
      title={<div className="wb-store-settings-title"><span><SettingOutlined /></span><div><strong>WB上品设置</strong><Text type="secondary">多店铺身份、目录与调度控制台</Text></div></div>}
      extra={<Space wrap><Badge status={summary.ready > 0 ? 'success' : 'warning'} text={`${summary.ready}/${summary.total} 店铺可用`} />{summary.activeTasks > 0 && <Tag color="processing">{summary.activeTasks} 个运行中</Tag>}</Space>}
      onClose={requestClose}
    >
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        { key: 'stores', label: <Space><ShopOutlined />店铺管理</Space>, children: storeTab },
        { key: 'integration', label: <Space><DatabaseOutlined />公共目录与集成</Space>, children: integrationTab },
        { key: 'advanced', label: <Space><ControlOutlined />高级运行参数</Space>, children: advancedTab }
      ]} />
    </Drawer>
    <Drawer className="wb-store-editor-drawer" open={Boolean(editor)} width="min(640px, 100vw)" title={editor?.mode === 'edit' ? `编辑店铺 · ${editor.store.displayName}` : '新建 WB 店铺'} onClose={closeEditor} extra={<Button type="primary" icon={<SaveOutlined />} loading={saveStore.isPending} onClick={() => void storeForm.validateFields().then((values) => saveStore.mutate(values))}>{editor?.mode === 'edit' ? '保存店铺' : '创建店铺'}</Button>}>
      <Alert showIcon type="info" message={editor?.mode === 'edit' ? '店铺别名不可修改' : '店铺创建后默认保持停用'} description={editor?.mode === 'edit' ? '任务 ID 和目录都依赖该别名；显示名称可以随时调整。' : '创建后继续设置 Token、执行连接检查，再手动启用店铺。'} />
      <Form form={storeForm} layout="vertical" className="wb-store-editor-form">
        <Row gutter={14}><Col xs={24} md={10}><Form.Item label="店铺别名" name="storeAlias" rules={[{ required: true, message: '请输入店铺别名' }, { pattern: /^[a-z0-9][a-z0-9-]{1,31}$/, message: '使用 2–32 位小写字母、数字或连字符' }]}><Input className="mono-input" readOnly={editor?.mode === 'edit'} placeholder="例如 wb-main" /></Form.Item></Col><Col xs={24} md={14}><Form.Item label="店铺显示名称" name="displayName" rules={[{ required: true, message: '请输入店铺显示名称' }]}><Input placeholder="例如 WB 主店铺" /></Form.Item></Col></Row>
        <Row gutter={14}><Col xs={24} md={12}><Form.Item label="默认上品预设" name="defaultPresetId" extra="自动任务会冻结该预设；同一 SKU 同批发布的店铺必须使用生成内容等价的预设。"><Select allowClear showSearch optionFilterProp="label" loading={presets.isLoading} placeholder="选择可用预设" options={presetOptions} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="发布模式" name="autoPublishMode" rules={[{ required: true }]}><Select options={[{ value: 'CREATE_ONLY' satisfies WbStorePublishMode, label: '仅创建新商品' }, { value: 'COMPATIBLE_UPSERT' satisfies WbStorePublishMode, label: '兼容更新既有商品' }]} /></Form.Item></Col></Row>
        <Form.Item label="参与自动上品" name="autoPublishEnabled" valuePropName="checked"><Switch checkedChildren="参与" unCheckedChildren="仅手动" /></Form.Item>
        <Divider orientation="left">仓库与账户</Divider>
        <Row gutter={14}><Col xs={24} md={10}><Form.Item label="仓库 ID" name="warehouseId"><Input className="mono-input" placeholder="1701558" /></Form.Item></Col><Col xs={24} md={14}><Form.Item label="仓库名称" name="warehouseName"><Input placeholder="连接检查后可核验" /></Form.Item></Col></Row>
        <Row gutter={14}><Col xs={24} md={12}><Form.Item label="账户币种" name="accountCurrency" extra="第一版仅允许 CNY 店铺提交。"><Select options={[{ value: 'CNY', label: 'CNY · 人民币' }, { value: 'RUB', label: 'RUB · 仅保存，暂不可上品' }]} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="每日款式上限" name="maxDailyStyles"><InputNumber min={1} max={100000} /></Form.Item></Col></Row>
      </Form>
    </Drawer>
    <Modal open={Boolean(credentialStore)} title={`设置 Token · ${credentialStore?.displayName || ''}`} okText="加密保存 Token" cancelText="取消" confirmLoading={credential.isPending} okButtonProps={{ disabled: credentialToken.trim().length < 20 }} onCancel={() => { if (!credential.isPending) { setCredentialStore(undefined); setCredentialToken(''); } }} onOk={() => credential.mutate()}>
      <Alert showIcon type="warning" message="Token 只写且不会再次显示" description="保存后页面仅显示指纹与更新时间。请确认 Token 属于当前店铺，完成后再执行连接检查。" />
      <Form layout="vertical" className="wb-store-token-form"><Form.Item label="WB Seller API Token" required validateStatus={credentialToken && credentialToken.trim().length < 20 ? 'error' : undefined} help={credentialToken && credentialToken.trim().length < 20 ? 'Token 长度不足，请粘贴完整内容' : undefined}><Input.Password aria-label="WB Seller API Token" autoComplete="new-password" value={credentialToken} onChange={(event) => setCredentialToken(event.target.value)} placeholder="粘贴完整 Token" /></Form.Item></Form>
    </Modal>
  </>;
}
