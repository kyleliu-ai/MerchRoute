import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BranchesOutlined, CheckCircleOutlined, CopyOutlined, DeleteOutlined, DownOutlined, EditOutlined, PlusOutlined,
  LockOutlined, SaveOutlined, SettingOutlined, TagsOutlined, UpOutlined, WarningOutlined
} from '@ant-design/icons';
import {
  Alert, Badge, Button, Card, Col, Descriptions, Divider, Drawer, Empty, Form, Input,
  InputNumber, message, Modal, Row, Select, Skeleton, Space, Switch, Table, Tag, Tooltip, Typography
} from 'antd';
import dayjs from 'dayjs';
import {
  WB_PURCHASE_CHARACTERISTIC_BINDINGS,
  isWbPurchaseCharacteristicId
} from '@n8n-media-review/shared';
import { countryOptionsForCodes } from './countries';
import {
  api,
  type ShippingTemplateDetail,
  type WbCategory,
  type WbCharacteristic,
  type WbDictionaryName,
  type WbDictionaryValue,
  type WbFormField,
  type WbListingInitializationIssue,
  type WbListingPreset,
  type WbListingPresetDependency,
  type WbListingPresetInput,
  type WbListingPresetSize
} from './api/client';
import { resolveWbTnvedRequired } from './wb-schema-projection';

const { Text, Title } = Typography;
const DEFAULT_TRANSLATION_WORKFLOW_ID = 'W2lSSXE3NUaLW1tD';

type PresetFormValues = Omit<WbListingPresetInput, 'clubDiscount' | 'descriptionSource' | 'sharedCharacteristics' | 'variantCharacteristics' | 'sizes'> & {
  clubDiscountMode: string;
};

const WB_FIELD_DICTIONARY_ALIASES: Record<string, WbDictionaryName> = {
  countries: 'countries', seasons: 'seasons', kinds: 'kinds', genders: 'kinds', colors: 'colors'
};
const WB_FIELD_DICTIONARY_LABELS: Record<WbDictionaryName, string> = {
  countries: '原产国', seasons: '季节', kinds: '性别', colors: '颜色'
};

const readinessMeta = {
  READY: { label: '可以应用', color: 'green', badge: 'success' },
  DRIFT: { label: '依赖已更新', color: 'gold', badge: 'warning' },
  BROKEN: { label: '配置不可用', color: 'red', badge: 'error' }
} as const;

function showError(error: Error) { message.error(error.message); }
function nextCloneName(sourceName: string, existingNames: string[]) {
  const base = `${sourceName} 副本`;
  const names = new Set(existingNames);
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}
function newSizeRow(): WbListingPresetSize {
  return { sizeId: crypto.randomUUID(), techSize: '', wbSize: '', insoleLengthCm: undefined, stock: 0 };
}
function bilingualCategory(category?: WbCategory) {
  if (!category) return '未选择类目';
  const zh = category.publishedVersion?.nameZh || category.nameZh;
  const ru = category.publishedVersion?.nameRu || category.nameRu;
  return zh && ru && zh !== ru ? `${zh} / ${ru}` : zh || ru || category.categoryKey;
}
function issueText(issue: WbListingInitializationIssue | string) {
  return typeof issue === 'string' ? issue : issue.message || issue.code;
}
function highestPublishedShipping(detail?: ShippingTemplateDetail) {
  return detail?.versions.filter((item) => item.status === 'PUBLISHED').sort((a, b) => b.versionNo - a.versionNo)[0];
}
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

export function WbPresetRegistry() {
  const client = useQueryClient();
  const presets = useQuery({ queryKey: ['wb-presets'], queryFn: api.wbPresets, retry: false });
  const items = presets.data?.items || [];
  const [editingId, setEditingId] = useState<string>();
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['wb-presets'] }),
      client.invalidateQueries({ queryKey: ['wb-listings'] })
    ]);
  };
  const clone = useMutation({
    mutationFn: (preset: WbListingPreset) => api.cloneWbPreset(preset.id, nextCloneName(preset.name, items.map((item) => item.name))),
    onSuccess: async ({ preset }) => { message.success(`已复制为“${preset.name}”`); await invalidate(); setEditingId(preset.id); },
    onError: showError
  });
  const remove = useMutation({
    mutationFn: (preset: WbListingPreset) => api.deleteWbPreset(preset.id, preset.rowVersion),
    onSuccess: async ({ deleted }) => { message.success(`已删除“${deleted.name}”`); await invalidate(); },
    onError: showError
  });

  if (presets.isError) return <Alert showIcon type="error" message="上品预设模板暂不可用" description={presets.error.message} action={<Button onClick={() => void presets.refetch()}>重试</Button>} />;
  return <div className="wb-registry wb-preset-registry">
    <Card className="wb-preset-intro">
      <div className="wb-preset-intro-copy"><span>REUSABLE LISTING BLUEPRINT</span><Title level={4}>一套预设，串起价格、物流与商品资料</Title><Text type="secondary">预设只描述商品资料；每家店铺使用哪个预设、是否自动上品和发布策略，统一在 WB上品设置中管理。</Text></div>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditingId('new')}>新建上品预设</Button>
    </Card>
    <Card bodyStyle={{ padding: 0 }}><Table<WbListingPreset> rowKey="id" loading={presets.isLoading} dataSource={items} pagination={false} scroll={{ x: 1530 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有上品预设模板"><Button type="primary" onClick={() => setEditingId('new')}>创建第一个预设</Button></Empty> }} columns={[
      { title: '预设', width: 250, render: (_, item) => <div className="wb-preset-name-cell"><strong>{item.name}</strong><Text type="secondary">{item.description || '未填写说明'}</Text></div> },
      { title: '定价链', width: 330, render: (_, item) => <PresetChain preset={item} /> },
      { title: '商品默认值', width: 300, render: (_, item) => <Space size={[4, 5]} wrap><Tag>{item.categoryKey}</Tag><Tag>商家 {item.discountPercent}%</Tag><Tag>Club {item.clubDiscount === null ? '不管理' : `${item.clubDiscount}%`}</Tag><Tag>{item.brand || '无品牌'}</Tag></Space> },
      { title: '店铺应用', width: 160, render: () => <div className="wb-preset-auto-status"><Tag color="cyan">按店铺绑定</Tag><Text type="secondary">前往 WB上品设置管理</Text></div> },
      { title: '已绑定任务', width: 120, render: (_, item) => <div className="wb-preset-auto-status"><strong>{item.activeBoundJobCount || 0}</strong><Text type="secondary">切换后继续执行</Text></div> },
      { title: '依赖状态', width: 180, render: (_, item) => <PresetReadiness preset={item} /> },
      { title: '更新时间', width: 150, render: (_, item) => <div className="wb-preset-time"><strong>{dayjs(item.updatedAt).format('YYYY-MM-DD')}</strong><span>{dayjs(item.updatedAt).format('HH:mm')} · R{item.rowVersion}</span></div> },
      { title: '操作', width: 215, fixed: 'right', render: (_, item) => <Space size={4}><Button size="small" icon={<EditOutlined />} onClick={() => setEditingId(item.id)}>编辑</Button><Button size="small" icon={<CopyOutlined />} loading={clone.isPending && clone.variables?.id === item.id} onClick={() => clone.mutate(item)}>复制</Button><Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={() => Modal.confirm({ title: `删除预设“${item.name}”？`, content: `${item.activeBoundJobCount ? `已有 ${item.activeBoundJobCount} 个未完成任务会继续使用绑定快照执行。` : '现有草稿与已绑定任务不受影响。'} 被店铺绑定的预设需要先在 WB上品设置中解除绑定。`, okText: '删除预设', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => remove.mutateAsync(item) })}>删除</Button></Space> }
    ]} /></Card>
    <WbPresetEditor key={editingId || 'closed'} presetId={editingId} onClose={() => setEditingId(undefined)} onSaved={invalidate} />
  </div>;
}

function PresetChain({ preset }: { preset: WbListingPreset }) {
  const pricing = preset.resolvedDependencies?.pricing;
  const shipping = preset.resolvedDependencies?.shipping;
  return <div className="wb-preset-chain" aria-label="预设定价链">
    <ChainNode label="定价" value={pricing?.name || preset.pricingTemplateId} version={pricing?.versionNo} />
    <i>→</i><ChainNode label="运费" value={shipping?.name || preset.shippingTemplateId} version={shipping?.versionNo} />
    <i>→</i><ChainNode label="渠道" value={preset.shippingServiceCode} />
    <i>→</i><ChainNode accent label="结果" value="上架价 CNY" />
  </div>;
}

function ChainNode({ label, value, version, accent }: { label: string; value: string; version?: number; accent?: boolean }) {
  return <span className={accent ? 'is-accent' : ''}><small>{label}</small><strong title={value}>{value}</strong>{version !== undefined && <em>V{version}</em>}</span>;
}

function PresetReadiness({ preset }: { preset: WbListingPreset }) {
  const meta = readinessMeta[preset.readiness] || readinessMeta.BROKEN;
  const title = preset.issues.length ? preset.issues.map(issueText).join('\n') : undefined;
  return <Tooltip title={title}><div className="wb-preset-readiness"><Badge status={meta.badge} /><div><Tag color={meta.color}>{meta.label}</Tag><Text type="secondary">{preset.issues.length ? `${preset.issues.length} 个提示` : '依赖已解析'}</Text></div></div></Tooltip>;
}

function WbPresetEditor({ presetId, onClose, onSaved }: { presetId?: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const isNew = presetId === 'new';
  const open = Boolean(presetId);
  const [form] = Form.useForm<PresetFormValues>();
  const [sizes, setSizes] = useState<WbListingPresetSize[]>([newSizeRow()]);
  const [sharedCharacteristics, setSharedCharacteristics] = useState<WbCharacteristic[]>([]);
  const [variantCharacteristics, setVariantCharacteristics] = useState<WbCharacteristic[]>([]);
  const [characteristicsOpen, setCharacteristicsOpen] = useState(true);
  const [sizesOpen, setSizesOpen] = useState(true);
  const detail = useQuery({ queryKey: ['wb-preset', presetId], queryFn: () => api.wbPreset(presetId!), enabled: open && !isNew, retry: false });
  const pricingTemplates = useQuery({ queryKey: ['pricing-templates'], queryFn: api.pricingTemplates, enabled: open, retry: false });
  const shippingTemplates = useQuery({ queryKey: ['shipping-templates'], queryFn: api.shippingTemplates, enabled: open, retry: false });
  const categories = useQuery({ queryKey: ['wb-categories'], queryFn: api.wbCategories, enabled: open, retry: false });
  const shippingTemplateId = Form.useWatch('shippingTemplateId', form);
  const shippingServiceCode = Form.useWatch('shippingServiceCode', form);
  const categoryKey = Form.useWatch('categoryKey', form);
  const tnved = Form.useWatch('tnved', form) || '';
  const shippingDetail = useQuery({ queryKey: ['shipping-template', shippingTemplateId], queryFn: () => api.shippingTemplate(shippingTemplateId!), enabled: open && Boolean(shippingTemplateId), retry: false });
  const categoryDetail = useQuery({ queryKey: ['wb-category', categoryKey], queryFn: () => api.wbCategory(categoryKey!), enabled: open && Boolean(categoryKey), retry: false });
  const publishedShipping = highestPublishedShipping(shippingDetail.data?.template);
  const services = publishedShipping?.definition.services || [];
  const selectedService = services.find((service) => service.code === shippingServiceCode);
  const destinationCodes = useMemo(() => [...new Set(selectedService?.rules.flatMap((rule) => rule.destinationCountryCodes) || [])], [selectedService]);
  const destinationOptions = useMemo(() => countryOptionsForCodes(destinationCodes), [destinationCodes]);
  const publishedCategoryVersion = categoryDetail.data?.category.versions?.filter((version) => version.status === 'PUBLISHED').sort((a, b) => b.versionNo - a.versionNo)[0];
  const subjectId = publishedCategoryVersion?.subjectId || categoryDetail.data?.category.subjectId;
  const sizeMode = publishedCategoryVersion?.formConfig.sizeMode || 'sized';
  const tnvedCharacteristicId = publishedCategoryVersion?.formConfig.compliance?.tnvedCharacteristicId;
  const tnvedSupported = Number.isInteger(tnvedCharacteristicId) && Number(tnvedCharacteristicId) > 0;
  const tnvedRequired = tnvedSupported && Boolean(publishedCategoryVersion && resolveWbTnvedRequired(
    publishedCategoryVersion.formConfig,
    publishedCategoryVersion.liveSchema,
    publishedCategoryVersion.subjectId || subjectId
  ));
  const allCharacteristicFields = [...(publishedCategoryVersion?.formConfig.fields || [])]
    .filter((field) => field.characteristicId !== tnvedCharacteristicId)
    .sort((a, b) => a.order - b.order);
  const systemManagedFields = allCharacteristicFields.filter((field) => isWbPurchaseCharacteristicId(field.characteristicId));
  const characteristicFields = allCharacteristicFields.filter((field) => !isWbPurchaseCharacteristicId(field.characteristicId));
  const sharedFields = characteristicFields.filter((field) => field.scope === 'shared');
  const variantFields = characteristicFields.filter((field) => field.scope === 'variant');
  const normalizedTnved = tnved.trim();
  const tnvedDirectory = useQuery({
    queryKey: ['wb-preset-tnved', subjectId, normalizedTnved],
    queryFn: () => api.wbTnvedDirectory(Number(subjectId), normalizedTnved),
    enabled: open && tnvedSupported && Boolean(subjectId) && /^\d{10}$/.test(normalizedTnved),
    retry: false,
    staleTime: 5 * 60_000
  });
  const exactTnved = tnvedDirectory.data?.find((item) => String(item.tnved).replace(/\D/g, '') === normalizedTnved);
  const kizMarked = wbBoolean(exactTnved?.isKiz);
  const tnvedLookupAttempted = tnvedSupported && /^\d{10}$/.test(normalizedTnved);
  const tnvedLookupError = tnvedLookupAttempted && tnvedDirectory.isError
    ? tnvedDirectory.error.message
    : tnvedLookupAttempted && !tnvedDirectory.isFetching && tnvedDirectory.isSuccess && !exactTnved
      ? `WB TNVED 目录中未找到编码 ${normalizedTnved}`
      : undefined;

  useEffect(() => {
    if (!open) return;
    if (isNew) {
      form.setFieldsValue({
        name: '', description: '', autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY', pricingTemplateId: '', shippingTemplateId: '', shippingServiceCode: '', destinationCountryCode: undefined,
        packaging: { grossWeightGrams: 500, lengthCm: 30, widthCm: 20, heightCm: 10 }, categoryKey: '', discountPercent: 0,
        clubDiscountMode: 'UNMANAGED', tnved: '', brand: '', titleTranslation: { workflowId: DEFAULT_TRANSLATION_WORKFLOW_ID, language: '俄文', maxLength: 60 }
      });
      setSizes([newSizeRow()]);
      setSharedCharacteristics([]);
      setVariantCharacteristics([]);
      setCharacteristicsOpen(true);
      setSizesOpen(true);
      return;
    }
    const preset = detail.data?.preset;
    if (!preset) return;
    form.setFieldsValue({
      ...preset,
      autoPublishEnabled: Boolean(preset.autoPublishEnabled),
      clubDiscountMode: preset.clubDiscount === null ? 'UNMANAGED' : String(preset.clubDiscount)
    });
    setSizes(preset.sizes.length ? preset.sizes.map((item) => ({ ...item, sizeId: item.sizeId || crypto.randomUUID() })) : [newSizeRow()]);
    setSharedCharacteristics(structuredClone(preset.sharedCharacteristics || []));
    setVariantCharacteristics(structuredClone(preset.variantCharacteristics || []));
    setCharacteristicsOpen(true);
    setSizesOpen(true);
  }, [detail.data?.preset, form, isNew, open]);

  useEffect(() => {
    if (open && categoryKey && categoryDetail.isSuccess && !tnvedSupported) form.setFieldValue('tnved', '');
  }, [categoryDetail.isSuccess, categoryKey, form, open, tnvedSupported]);

  const prepareSave = async () => {
    const values = await form.validateFields();
    if (destinationCodes.length && !values.destinationCountryCode) throw new Error('当前服务渠道需要选择目的国');
    const normalizedSizes = sizeMode === 'sizeless'
      ? [{ ...sizes[0], sizeId: sizes[0]?.sizeId || crypto.randomUUID(), techSize: '', wbSize: '', insoleLengthCm: undefined, stock: Number(sizes[0]?.stock || 0) }]
      : sizes.map((item) => ({ ...item, techSize: item.techSize?.trim(), wbSize: item.wbSize?.trim(), stock: Number(item.stock || 0) }));
    if (!normalizedSizes.length) throw new Error('请至少添加一行尺码和库存');
    if (sizeMode !== 'sizeless') {
      const missingTechSize = normalizedSizes.findIndex((item) => !item.techSize);
      if (missingTechSize >= 0) throw new Error(`请填写第 ${missingTechSize + 1} 行 techSize`);
    }
    if (tnvedLookupError) throw new Error(tnvedLookupError);
    if (tnvedLookupAttempted && !exactTnved) throw new Error('正在核对 WB TNVED 目录，请稍后再试');
    const input: WbListingPresetInput = {
      ...values,
      name: values.name.trim(),
      description: values.description?.trim() || undefined,
      brand: values.brand.trim(),
      tnved: tnvedSupported ? normalizedTnved : '',
      destinationCountryCode: destinationCodes.length ? values.destinationCountryCode : undefined,
      clubDiscount: values.clubDiscountMode === 'UNMANAGED' ? null : Number(values.clubDiscountMode),
      titleTranslation: { ...values.titleTranslation, workflowId: values.titleTranslation.workflowId.trim(), language: values.titleTranslation.language.trim() },
      descriptionSource: 'E003',
      sharedCharacteristics: sharedCharacteristics.filter((item) => !isWbPurchaseCharacteristicId(item.id)),
      variantCharacteristics: variantCharacteristics.filter((item) => !isWbPurchaseCharacteristicId(item.id)),
      sizes: normalizedSizes
    };
    return { input, rowVersion: isNew ? undefined : detail.data!.preset.rowVersion };
  };
  const save = useMutation({
    mutationFn: async ({ input, rowVersion }: { input: WbListingPresetInput; rowVersion?: number }) => {
      if (isNew) return api.createWbPreset(input);
      return api.updateWbPreset(presetId!, { ...input, rowVersion: rowVersion! });
    },
    onSuccess: async ({ preset }) => { message.success(isNew ? `预设“${preset.name}”已创建` : `预设“${preset.name}”已保存`); await onSaved(); onClose(); },
    onError: showError
  });
  const requestSave = async () => {
    try {
      const prepared = await prepareSave();
      save.mutate(prepared);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'errorFields' in error) return;
      showError(error instanceof Error ? error : new Error('上品预设校验失败'));
    }
  };
  const loading = !isNew && detail.isLoading;
  const loadError = detail.error || pricingTemplates.error || shippingTemplates.error || categories.error;
  const preset = detail.data?.preset;
  return <Drawer className="wb-preset-drawer" open={open} width="min(1180px, 98vw)" title={<Space><SettingOutlined /><strong>{isNew ? '新建上品预设模板' : preset?.name || '加载上品预设'}</strong></Space>} onClose={onClose} extra={<Button type="primary" icon={<SaveOutlined />} loading={save.isPending} disabled={loading || Boolean(loadError) || tnvedDirectory.isFetching} onClick={() => void requestSave()}>{isNew ? '创建预设' : '保存修改'}</Button>}>
    {loading ? <Skeleton active /> : loadError ? <Alert showIcon type="error" message="预设依赖加载失败" description={loadError.message} /> : <Form form={form} layout="vertical" className="wb-preset-editor">
      {preset && <PresetDependencyBanner preset={preset} />}
      <Card title="基础信息"><Form.Item label="预设名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入预设名称' }, { max: 80 }]}><Input placeholder="例如：WB 鞋类上品 V1" /></Form.Item><Form.Item label="使用说明" name="description"><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={240} showCount placeholder="说明适用场景、类目或运营策略" /></Form.Item><Form.Item name="autoPublishEnabled" hidden valuePropName="checked"><Switch /></Form.Item><Form.Item name="autoPublishMode" hidden><Input /></Form.Item><Alert showIcon type="info" message="预设按店铺绑定" description="每家店铺使用哪个默认预设、是否自动上品和发布策略，统一在 WB上品设置中管理。手动资料仅维护公共变体与媒体。" /></Card>

      <Card className="wb-preset-price-card" title={<Space><BranchesOutlined />定价链与包装预设</Space>}>
        <Alert showIcon type="info" message="上架价由价格查询结果生成" description="采购管理最新采购版本的毛重优先用于定价和包装；仅当采购毛重为空、0 或非正数时，使用下方兜底毛重。包装长、宽、高始终使用本预设。" />
        <div className="wb-preset-chain-editor">
          <Form.Item label="默认定价模板" name="pricingTemplateId" rules={[{ required: true, message: '请选择定价模板' }]}><Select showSearch optionFilterProp="label" placeholder="选择 WB 已发布定价模板" options={(pricingTemplates.data?.items || []).filter((item) => item.active && item.publishedVersion && item.platformCode.toUpperCase() === 'WB').map((item) => ({ value: item.id, label: `${item.platformName} · ${item.name} · V${item.publishedVersion!.versionNo}` }))} /></Form.Item><i>→</i>
          <Form.Item label="默认运费模板" name="shippingTemplateId" rules={[{ required: true, message: '请选择运费模板' }]}><Select showSearch optionFilterProp="label" placeholder="选择 WB 已发布运费模板" options={(shippingTemplates.data?.items || []).filter((item) => item.active && item.carrierActive && item.publishedVersion && item.platformCode.toUpperCase() === 'WB').map((item) => ({ value: item.id, label: `${item.carrierName} · ${item.name} · V${item.publishedVersion!.versionNo}` }))} onChange={() => form.setFieldsValue({ shippingServiceCode: '', destinationCountryCode: undefined })} /></Form.Item><i>→</i>
          <Form.Item label="服务渠道" name="shippingServiceCode" rules={[{ required: true, message: '请选择服务渠道' }]}><Select loading={shippingDetail.isLoading} disabled={!shippingTemplateId || shippingDetail.isError} placeholder={shippingTemplateId ? '选择一个服务渠道' : '先选择运费模板'} options={services.map((service) => ({ value: service.code, label: `${service.name} · ${service.code}` }))} onChange={() => form.setFieldValue('destinationCountryCode', undefined)} /></Form.Item><i>→</i>
          <div className="wb-preset-output-node"><small>返回字段</small><strong>上架价</strong><span>CNY</span></div>
        </div>
        {shippingDetail.isError && <Alert showIcon type="error" message="无法读取运费模板服务渠道" description={shippingDetail.error.message} />}
        {!!destinationCodes.length && <Form.Item label="目的国" name="destinationCountryCode" rules={[{ required: true, message: '当前服务渠道需要选择目的国' }]}><Select showSearch optionFilterProp="label" placeholder="选择渠道适用的目的国" options={destinationOptions} /></Form.Item>}
        <Divider orientation="left">包装参数</Divider>
        <Row gutter={12}>{(['grossWeightGrams', 'lengthCm', 'widthCm', 'heightCm'] as const).map((key) => <Col xs={12} md={6} key={key}><Form.Item label={{ grossWeightGrams: '兜底毛重 (g)', lengthCm: '长 cm', widthCm: '宽 cm', heightCm: '高 cm' }[key]} name={['packaging', key]} extra={key === 'grossWeightGrams' ? '采购毛重为空、0 或非正数时才使用此值。' : undefined} rules={[{ required: true, message: '必填' }, { type: 'number', min: key === 'grossWeightGrams' ? 1 : 0.01, message: '必须大于 0' }]}><InputNumber aria-label={{ grossWeightGrams: '兜底毛重 (g)', lengthCm: '长 cm', widthCm: '宽 cm', heightCm: '高 cm' }[key]} min={key === 'grossWeightGrams' ? 1 : 0.01} precision={key === 'grossWeightGrams' ? 0 : 2} /></Form.Item></Col>)}</Row>
      </Card>

      <Card title="商品资料默认值"><Row gutter={14}><Col xs={24} md={12}><Form.Item label="WB 类目模板" name="categoryKey" rules={[{ required: true, message: '请选择类目模板' }]}><Select showSearch optionFilterProp="label" placeholder="选择已发布并同步的类目" options={(categories.data?.items || []).filter((item) => item.active && item.publishedVersion).map((item) => ({ value: item.categoryKey, label: `${bilingualCategory(item)} · V${item.publishedVersion!.versionNo}`, disabled: item.projection.status !== 'SYNCED' }))} onChange={(nextCategoryKey) => { if (nextCategoryKey !== categoryKey) { setSharedCharacteristics([]); setVariantCharacteristics([]); } }} /></Form.Item></Col><Col xs={24} md={12}><Form.Item label="品牌（允许留空）" name="brand"><Input placeholder="留空时不填写品牌" /></Form.Item></Col></Row>
        <Row gutter={14}><Col xs={24} md={8}><Form.Item label="商家折扣 %" name="discountPercent" rules={[{ required: true }, { type: 'number', min: 0, max: 99 }]}><InputNumber min={0} max={99} precision={0} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="WB Club 专享折扣" name="clubDiscountMode" rules={[{ required: true }]}><Select options={[{ value: 'UNMANAGED', label: '不管理' }, { value: '0', label: '0% · 关闭 Club 折扣' }, ...Array.from({ length: 29 }, (_, index) => ({ value: String(index + 3), label: `${index + 3}%` }))]} /></Form.Item></Col><Col xs={24} md={8}><Form.Item label={tnvedRequired ? 'TNVED' : tnvedSupported ? 'TNVED（非必填，可留空）' : 'TNVED'} required={tnvedRequired} name="tnved" validateStatus={tnvedLookupError ? 'error' : tnvedDirectory.isFetching ? 'validating' : exactTnved ? 'success' : undefined} help={tnvedLookupError} extra={!categoryKey || categoryDetail.isLoading ? undefined : !tnvedSupported ? '当前类目不使用 TNVED' : tnvedRequired ? '当前类目要求填写 10 位 TNVED；填写后自动核对 KIZ。' : '可留空；填写后自动核对 KIZ。'} rules={tnvedRequired ? [{ required: true, whitespace: true, message: 'TNVED为必填项目' }, { pattern: /^\d{10}$/, message: 'TNVED 必须填写 10 位数字' }] : [{ pattern: /^(?:|\d{10})$/, message: 'TNVED 留空或填写 10 位数字' }]}><Input aria-label={tnvedRequired ? 'TNVED' : tnvedSupported ? 'TNVED（非必填，可留空）' : 'TNVED'} inputMode="numeric" maxLength={10} disabled={!tnvedSupported} placeholder={!tnvedSupported ? '当前类目不使用 TNVED' : tnvedRequired ? '填写 10 位 TNVED' : '可留空；或填写 10 位 TNVED'} /></Form.Item></Col></Row>
        <Descriptions size="small" bordered column={{ xs: 1, md: 3 }} items={[
          { key: 'category', label: '类目', children: bilingualCategory(categoryDetail.data?.category) },
          { key: 'size', label: '尺码模式', children: sizeMode === 'sizeless' ? '无尺码商品' : '多尺码商品' },
          { key: 'kiz', label: 'KIZ（自动派生）', children: !tnvedSupported ? <Text type="secondary">当前类目无需设置</Text> : tnvedDirectory.isFetching ? '正在核对…' : kizMarked === undefined ? <Text type="secondary">未设置 TNVED</Text> : <Tag color={kizMarked ? 'volcano' : 'green'}>{kizMarked ? '需要 KIZ' : '无需 KIZ'}</Tag> }
        ]} />
      </Card>

      <Card title="俄文标题与商品详情"><Row gutter={14}><Col xs={24} md={8}><Form.Item label="翻译工作流 ID" name={['titleTranslation', 'workflowId']} rules={[{ required: true, whitespace: true }]}><Input className="mono-input" /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="目标语言" name={['titleTranslation', 'language']} rules={[{ required: true, whitespace: true }, { max: 64, message: '目标语言最多 64 个字符' }]}><Input maxLength={64} placeholder="例如：俄文、乌兹别克斯坦语" /></Form.Item></Col><Col xs={24} md={8}><Form.Item label="标题最大长度" name={['titleTranslation', 'maxLength']} rules={[{ required: true }, { type: 'number', min: 1, max: 60 }]}><InputNumber min={1} max={60} precision={0} /></Form.Item></Col></Row>
        <Alert showIcon type="info" message="翻译原文固定使用受保护的产品名" description="创建草稿时由服务端读取 PostgreSQL 产品身份，不接受浏览器覆盖 SKU 或产品名。翻译工作流暂时不可用时仍可保存预设，但会显示警告。" />
        <Divider orientation="left">俄文产品详情</Divider>
        <div className="wb-preset-description-source"><CheckCircleOutlined /><div><strong>自动获取最新有效 E003 详情 TXT</strong><Text type="secondary">详情 TXT 的身份、受控路径、UTF-8 编码、内容与写入稳定性通过校验即可导入；图片场景结果不影响详情导入。只填充空白详情，TXT 自身不可用时才回退到上一份有效结果；工作台仍可手工导入 UTF-8 TXT。</Text></div><Tag color="cyan">E003</Tag></div>
      </Card>

      <Card className={`wb-preset-collapsible${characteristicsOpen ? '' : ' is-collapsed'}`} title={<Space wrap><TagsOutlined />WB 类目字段{!!allCharacteristicFields.length && <><Tag>共享 {sharedFields.length}</Tag><Tag>变体 {variantFields.length}</Tag>{!!systemManagedFields.length && <Tag color="cyan">采购自动取值 {systemManagedFields.length}</Tag>}</>}</Space>} extra={<Button type="text" icon={characteristicsOpen ? <UpOutlined /> : <DownOutlined />} aria-expanded={characteristicsOpen} aria-controls="wb-preset-characteristics" onClick={() => setCharacteristicsOpen((current) => !current)}>{characteristicsOpen ? '收起' : '展开'}</Button>}>
        {characteristicsOpen && <div id="wb-preset-characteristics">
          {!categoryKey ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择 WB 类目模板" /> : categoryDetail.isLoading ? <Skeleton active /> : categoryDetail.isError ? <Alert showIcon type="error" message="类目字段加载失败" description={categoryDetail.error.message} /> : !allCharacteristicFields.length ? <Alert showIcon type="warning" message="该类目未发布可配置字段" description="请先在“类目模板”发布 formConfig；TNVED 字段已由上方合规配置统一管理。" /> : <>
            {!!systemManagedFields.length && <PurchaseManagedPresetFields fields={systemManagedFields} />}
            {!!characteristicFields.length && <>
              <Alert showIcon type="info" message="这些是新建草稿的默认值" description="预设允许留空，包括 WB 标记为必填的字段；创建草稿后可在上品工作台补充。TNVED 在上方单独维护，不在此重复显示。" />
              <PresetCharacteristicScope title="所有变体共享" description="创建草稿时写入商品的共享 characteristic。" fields={sharedFields} value={sharedCharacteristics} onChange={setSharedCharacteristics} />
              <Divider />
              <PresetCharacteristicScope title="每个变体的默认值" description="会复制到每个新建变体；颜色等产品差异字段可留空，再到工作台分别填写。" fields={variantFields} value={variantCharacteristics} onChange={setVariantCharacteristics} />
            </>}
          </>}
        </div>}
      </Card>

      <Card className={`wb-preset-collapsible${sizesOpen ? '' : ' is-collapsed'}`} title="尺码与默认库存" extra={<Space>{sizesOpen && <Button icon={<PlusOutlined />} disabled={sizeMode === 'sizeless'} onClick={() => setSizes((current) => [...current, newSizeRow()])}>添加尺码</Button>}<Button type="text" icon={sizesOpen ? <UpOutlined /> : <DownOutlined />} aria-expanded={sizesOpen} aria-controls="wb-preset-sizes" onClick={() => setSizesOpen((current) => !current)}>{sizesOpen ? '收起' : '展开'}</Button></Space>}>
        {sizesOpen && <div id="wb-preset-sizes">
          {sizeMode === 'sizeless' && <Alert showIcon type="info" message="当前类目为无尺码商品" description="保存时只使用第一行库存，并清空 techSize、wbSize 和鞋垫长度。" />}
          <PresetSizeEditor sizes={sizes} sizeless={sizeMode === 'sizeless'} onChange={setSizes} />
        </div>}
      </Card>
    </Form>}
  </Drawer>;
}

function PurchaseManagedPresetFields({ fields }: { fields: WbFormField[] }) {
  return <section className="wb-purchase-managed-fields">
    <Alert
      showIcon
      icon={<LockOutlined />}
      type="info"
      message="采购管理自动取值"
      description="该字段按 SKU 从采购管理最新采购版本获取，不保存预设默认值。"
    />
    <div className="wb-purchase-managed-grid">
      {fields.map((field) => {
        const binding = WB_PURCHASE_CHARACTERISTIC_BINDINGS.find((item) => item.characteristicId === field.characteristicId)!;
        return <div key={field.fieldId} className="wb-purchase-managed-item">
          <LockOutlined />
          <span><strong>{binding.labelZh}</strong><small>{binding.labelRu} · #{binding.characteristicId}</small></span>
          <Tag>{binding.purchaseField} · {binding.unit}</Tag>
        </div>;
      })}
    </div>
  </section>;
}

function PresetCharacteristicScope({ title, description, fields, value, onChange }: {
  title: string;
  description: string;
  fields: WbFormField[];
  value: WbCharacteristic[];
  onChange: (value: WbCharacteristic[]) => void;
}) {
  const filled = fields.filter((field) => characteristicToStrings(value.find((item) => item.id === field.characteristicId)?.value).length > 0).length;
  return <section className="wb-preset-characteristic-scope">
    <div className="wb-preset-scope-heading"><div><strong>{title}</strong><Text type="secondary">{description}</Text></div><Tag color={filled ? 'cyan' : undefined}>已填 {filled}/{fields.length}</Tag></div>
    {!fields.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前类目没有此范围的字段" /> : <div className="wb-characteristic-grid">{fields.map((field) => <PresetCharacteristicField key={field.fieldId} field={field} value={characteristicToStrings(value.find((item) => item.id === field.characteristicId)?.value)} onChange={(next) => onChange(setCharacteristic(value, field.characteristicId, next))} />)}</div>}
  </section>;
}

function PresetCharacteristicField({ field, value, onChange }: { field: WbFormField; value: string[]; onChange: (value: string[]) => void }) {
  const directory = WB_FIELD_DICTIONARY_ALIASES[field.directory || ''] || (field.characteristicId === 14177449 ? 'colors' : undefined);
  const dictionary = useQuery({
    queryKey: ['wb-field-dictionary', directory],
    queryFn: () => api.wbDictionary(directory!, '', 1_000),
    enabled: Boolean(directory),
    staleTime: 30 * 60 * 1_000,
    retry: false
  });
  const ariaLabel = `${field.labelZh?.trim() || field.labelRu} characteristic ${field.characteristicId}`;
  const label = <Space size={6} align="start"><span className="wb-characteristic-label"><strong>{field.labelZh?.trim() || field.labelRu}</strong>{field.labelZh?.trim() && <small>{field.labelRu}</small>}</span>{field.required && <Tooltip title="WB 必填；预设中可先留空"><Text type="danger">*</Text></Tooltip>}<span className="mono-small">#{field.characteristicId}</span></Space>;
  if (field.control === 'boolean') return <Form.Item label={label}><Select aria-label={ariaLabel} allowClear value={value[0]} onChange={(next) => onChange(next ? [next] : [])} options={[{ value: 'Да', label: '是 / Да' }, { value: 'Нет', label: '否 / Нет' }]} /></Form.Item>;
  if (field.control === 'number') return <Form.Item label={label}><InputNumber aria-label={ariaLabel} value={value[0]} onChange={(next) => onChange(next === null ? [] : [String(next)])} /></Form.Item>;
  if (field.control === 'select' || field.control === 'multi-select') {
    if (directory) return <Form.Item label={label} extra={dictionary.isError ? `本地中俄${WB_FIELD_DICTIONARY_LABELS[directory]}字典不可用，请在类目模板页立即同步。` : `从本地 WB 中俄${WB_FIELD_DICTIONARY_LABELS[directory]}字典选择；默认值保存俄文。`}><Select aria-label={ariaLabel} showSearch allowClear loading={dictionary.isLoading} mode={field.control === 'multi-select' ? 'multiple' : undefined} value={field.control === 'multi-select' ? value : value[0]} onChange={(next) => onChange(Array.isArray(next) ? next : next ? [next] : [])} optionFilterProp="label" placeholder={`搜索中文或俄文${WB_FIELD_DICTIONARY_LABELS[directory]}`} options={(dictionary.data?.items || []).map((item) => ({ value: item.nameRu, label: wbDictionaryOptionLabel(directory, item) }))} /></Form.Item>;
    return <Form.Item label={label} extra={field.directory ? `WB 字典：${field.directory}` : '请输入 WB 接受的俄文值'}><Select aria-label={ariaLabel} mode="tags" maxCount={field.control === 'select' ? 1 : undefined} value={value} onChange={onChange} tokenSeparators={[',']} /></Form.Item>;
  }
  return <Form.Item label={label}><Input aria-label={ariaLabel} value={value[0] || ''} onChange={(event) => onChange(event.target.value ? [event.target.value] : [])} /></Form.Item>;
}

function wbDictionaryOptionLabel(directory: WbDictionaryName, item: WbDictionaryValue): string {
  const bilingual = (zh?: string, ru?: string) => zh?.trim() && ru?.trim() && zh.trim() !== ru.trim() ? `${zh.trim()} / ${ru.trim()}` : zh?.trim() || ru?.trim() || '';
  const name = bilingual(item.nameZh, item.nameRu);
  if (directory === 'colors' && (item.parentNameRu || item.parentNameZh)) return `${name} · ${bilingual(item.parentNameZh, item.parentNameRu)}`;
  if (directory === 'countries' && item.wbId) return `${name} · WB #${item.wbId}`;
  return name;
}

function setCharacteristic(items: WbCharacteristic[], id: number, value: string[]): WbCharacteristic[] {
  const rest = items.filter((item) => item.id !== id);
  return value.length ? [...rest, { id, value }] : rest;
}

function characteristicToStrings(value: WbCharacteristic['value'] | undefined): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function PresetDependencyBanner({ preset }: { preset: WbListingPreset }) {
  if (preset.readiness === 'READY' && !preset.issues.length) return null;
  const meta = readinessMeta[preset.readiness];
  return <Alert showIcon type={preset.readiness === 'BROKEN' ? 'error' : 'warning'} icon={preset.readiness === 'BROKEN' ? <WarningOutlined /> : undefined} message={meta.label} description={<div>{preset.issues.map((issue, index) => <div key={`${typeof issue === 'string' ? issue : issue.code}-${index}`}>{issueText(issue)}</div>)}<DependencyVersion name="定价" value={preset.resolvedDependencies?.pricing} /><DependencyVersion name="运费" value={preset.resolvedDependencies?.shipping} /><DependencyVersion name="类目" value={preset.resolvedDependencies?.category} /></div>} />;
}

function DependencyVersion({ name, value }: { name: string; value?: WbListingPresetDependency }) {
  if (!value?.versionNo && !value?.snapshotVersionNo) return null;
  return <Text type="secondary" className="wb-preset-version-line">{name}：保存时 V{value.snapshotVersionNo ?? '—'}，当前 V{value.versionNo ?? '—'}</Text>;
}

function PresetSizeEditor({ sizes, sizeless, onChange }: { sizes: WbListingPresetSize[]; sizeless: boolean; onChange: (sizes: WbListingPresetSize[]) => void }) {
  const visibleSizes = sizeless ? sizes.slice(0, 1) : sizes;
  const patch = (sizeId: string, values: Partial<WbListingPresetSize>) => onChange(sizes.map((item) => item.sizeId === sizeId ? { ...item, ...values } : item));
  if (!visibleSizes.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="至少添加一行尺码和库存" />;
  return <div className={`wb-preset-size-list${sizeless ? ' is-sizeless' : ''}`}>{visibleSizes.map((size, index) => <div className="wb-preset-size-row" key={size.sizeId}><span>{String(index + 1).padStart(2, '0')}</span>{!sizeless && <><Input aria-label={`预设 techSize ${index + 1}`} aria-invalid={!String(size.techSize || '').trim()} className={!String(size.techSize || '').trim() ? 'wb-required-empty' : undefined} title={!String(size.techSize || '').trim() ? 'techSize 必填' : undefined} value={size.techSize || ''} placeholder="techSize（必填）" onChange={(event) => patch(size.sizeId, { techSize: event.target.value })} /><Input aria-label={`预设 wbSize ${index + 1}`} value={size.wbSize || ''} placeholder="wbSize（俄码）" onChange={(event) => patch(size.sizeId, { wbSize: event.target.value })} /><InputNumber aria-label={`预设鞋垫长度 ${index + 1}`} min={0.01} value={size.insoleLengthCm} placeholder="鞋垫 cm" onChange={(value) => patch(size.sizeId, { insoleLengthCm: value ?? undefined })} /></>}<div className="wb-auto-barcode"><small>条码</small><strong>WB 自动分配</strong></div><InputNumber aria-label={`预设库存 ${index + 1}`} min={0} precision={0} value={size.stock} placeholder="库存" onChange={(value) => patch(size.sizeId, { stock: Number(value || 0) })} /><Button aria-label={`删除预设尺码 ${index + 1}`} danger type="text" icon={<DeleteOutlined />} disabled={sizeless || sizes.length === 1} onClick={() => onChange(sizes.filter((item) => item.sizeId !== size.sizeId))} /></div>)}</div>;
}
