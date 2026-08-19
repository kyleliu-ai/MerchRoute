import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Col, Collapse, Descriptions, Divider, Drawer, Empty, Flex, Form, Input, InputNumber,
  Modal, Radio, Result, Row, Select, Skeleton, Space, Switch, Table, Tag, Typography, message
} from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, RocketOutlined, SaveOutlined } from '@ant-design/icons';
import type { ShippingRule, ShippingService, ShippingTemplateDefinitionV1 } from '@n8n-media-review/shared';
import { api, type ShippingCalculationResult, type ShippingCarrier, type ShippingQuote, type ShippingTemplateSummary } from './api/client';
import { CopyValueButton } from './copy-value';
import { countryOptionsForCodes, countryOptionsWithLegacyCodes } from './countries';

const { Title, Text, Paragraph } = Typography;
const reasonLabels: Record<string, string> = {
  SALE_PRICE_OUT_OF_RANGE: '售价不在适用范围', DESTINATION_UNSUPPORTED: '目的国不支持', WEIGHT_OUT_OF_RANGE: '实重不在适用范围',
  SIDE_SUM_EXCEEDED: '三边和超限', LONGEST_SIDE_EXCEEDED: '最长边超限', DIMENSION_BOX_EXCEEDED: '尺寸盒超限',
  DENSITY_TOO_LOW: '密度不足', CHARGEABLE_WEIGHT_EXCEEDED: '计费重超限'
};

function ShippingPageTitle({ eyebrow, title, description, extra }: { eyebrow: string; title: string; description: string; extra?: React.ReactNode }) {
  return <div className="shipping-page-title"><div><span>{eyebrow}</span><Title level={2}>{title}</Title><Paragraph>{description}</Paragraph></div>{extra}</div>;
}

export function ShippingCalculatorPage() {
  const [form] = Form.useForm();
  const [weightUnit, setWeightUnit] = useState<'g' | 'kg'>('g');
  const [result, setResult] = useState<ShippingCalculationResult>();
  const templates = useQuery({ queryKey: ['shipping-templates'], queryFn: api.shippingTemplates, retry: false });
  const calculate = useMutation({
    mutationFn: api.calculateShipping,
    onSuccess: (value) => setResult(value),
    onError: (error: Error) => message.error(error.message)
  });
  const shippingTemplateId = Form.useWatch('shippingTemplateId', form) as string | undefined;
  const availableTemplates = useMemo(() => templates.data?.items.filter((item) => item.active && item.carrierActive && item.publishedVersion) || [], [templates.data]);
  const selectedTemplate = useMemo(() => availableTemplates.find((item) => item.id === shippingTemplateId), [availableTemplates, shippingTemplateId]);
  const selectedTemplateDetail = useQuery({
    queryKey: ['shipping-template-destinations', selectedTemplate?.id],
    queryFn: () => api.shippingTemplate(selectedTemplate!.id),
    enabled: Boolean(selectedTemplate?.id),
    retry: false
  });
  const publishedDefinition = selectedTemplateDetail.data?.template.versions.find((version) => version.status === 'PUBLISHED')?.definition;
  const requiresSalePrice = Boolean(publishedDefinition?.services.some((service) => service.rules.some((rule) => Boolean(rule.constraints.salePrice || rule.constraints.salePriceRub))));
  const requiresDestination = Boolean(publishedDefinition?.services.some((service) => service.rules.some((rule) => rule.destinationCountryCodes.length)));
  const destinationOptions = useMemo(() => {
    const published = selectedTemplateDetail.data?.template.versions.find((version) => version.status === 'PUBLISHED');
    const codes = published?.definition.services.flatMap((service) => service.rules.flatMap((rule) => rule.destinationCountryCodes)) || [];
    return countryOptionsForCodes(codes);
  }, [selectedTemplateDetail.data]);

  useEffect(() => { if (availableTemplates.length && !availableTemplates.some((item) => item.id === form.getFieldValue('shippingTemplateId'))) form.setFieldValue('shippingTemplateId', availableTemplates[0]!.id); }, [availableTemplates, form]);

  useEffect(() => {
    if (!requiresDestination || selectedTemplateDetail.isLoading) return;
    const current = form.getFieldValue('destinationCountryCode');
    if (destinationOptions.some((item) => item.value === current)) return;
    form.setFieldValue('destinationCountryCode', destinationOptions[0]?.value);
  }, [destinationOptions, form, requiresDestination, selectedTemplateDetail.isLoading]);

  const submit = async () => {
    const values = await form.validateFields();
    const grams = weightUnit === 'kg' ? String(Number(values.weight) * 1000) : String(values.weight);
    calculate.mutate({
      shippingTemplateId: values.shippingTemplateId,
      actualWeightGrams: grams, lengthCm: String(values.lengthCm), widthCm: String(values.widthCm), heightCm: String(values.heightCm),
      ...(requiresSalePrice ? { salePrice: String(values.salePrice) } : {}),
      ...(requiresDestination ? { destinationCountryCode: values.destinationCountryCode } : { destinationCountryCode: null })
    });
  };

  if (templates.isError) return <DatabaseUnavailable title="运费计算暂不可用" error={templates.error} onRetry={() => void templates.refetch()} />;
  return <div className="page-stack shipping-calculator-page">
    <ShippingPageTitle eyebrow="CROSS-BORDER RATE DESK" title="运费计算" description="输入一次产品参数，同时比较当前承运商的全部可用渠道。" />
    <div className="shipping-workbench">
      <Card className="shipping-input-deck" loading={templates.isLoading}>
        <div className="deck-label"><span>01</span><div><strong>产品与路线</strong><small>系统按已发布模板计算</small></div></div>
        <Form form={form} layout="vertical" initialValues={{ weight: 100, lengthCm: 10, widthCm: 10, heightCm: 10, salePrice: 1500 }}>
          <Form.Item label="已发布运费模板" name="shippingTemplateId" rules={[{ required: true }]}><Select placeholder="暂无可用模板" options={availableTemplates.map((item) => ({ value: item.id, label: `${item.platformCode} · ${item.scenarioCode} · ${item.carrierName}` }))} /></Form.Item>
          {requiresDestination && <Form.Item label="目的国" name="destinationCountryCode" rules={[{ required: true, message: '当前模板需要目的国' }]}><Select showSearch optionFilterProp="label" loading={selectedTemplateDetail.isLoading} placeholder="输入中文国家名搜索" options={destinationOptions} /></Form.Item>}
          {requiresSalePrice && <Form.Item label="商品售价" name="salePrice" rules={[{ required: true, message: '当前模板需要商品售价' }]}><InputNumber min="0.01" stringMode addonAfter={publishedDefinition?.salePriceCurrencyCode} style={{ width: '100%' }} /></Form.Item>}
          <Divider />
          <div className="deck-label"><span>02</span><div><strong>包装参数</strong><small>尺寸统一使用厘米</small></div></div>
          <Form.Item label="包裹实重" required><Space.Compact block><Form.Item name="weight" noStyle rules={[{ required: true, message: '请输入重量' }]}><InputNumber min={0.001} stringMode style={{ width: '100%' }} /></Form.Item><Radio.Group value={weightUnit} onChange={(event) => setWeightUnit(event.target.value)} optionType="button" buttonStyle="solid" options={[{ value: 'g', label: 'g' }, { value: 'kg', label: 'kg' }]} /></Space.Compact></Form.Item>
          <Row gutter={10}>{(['lengthCm', 'widthCm', 'heightCm'] as const).map((name, index) => <Col span={8} key={name}><Form.Item label={['长', '宽', '高'][index]} name={name} rules={[{ required: true }]}><InputNumber min={0.01} stringMode addonAfter="cm" style={{ width: '100%' }} /></Form.Item></Col>)}</Row>
          <Button type="primary" size="large" block onClick={() => void submit()} loading={calculate.isPending} disabled={!availableTemplates.length}>计算全部渠道</Button>
        </Form>
      </Card>
      <div className="shipping-results-deck">
        {!result && <Card className="shipping-empty-state"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>填写左侧参数后，报价会按运费从低到高排列。<br />每条报价都会显示实重、体积重和最终计费重。</span>} /></Card>}
        {result && <>
          <Card className="shipping-result-header">
            <div><span className="result-kicker">{result.template.carrierCode} · V{result.template.versionNo}</span><Title level={3}>{result.summary.eligibleCount ? `找到 ${result.summary.eligibleCount} 条可用渠道` : '没有符合条件的渠道'}</Title><Text type="secondary">计费密度 {Number(result.normalizedInput.densityKgM3).toFixed(1)} kg/m³ · 三边和 {result.normalizedInput.sideSumCm} cm</Text></div>
            {result.summary.cheapestFreightAmount && <div className="cheapest-stamp"><small>最低运费</small><strong className="copy-value-inline"><CopyValueButton inverse label={`最低运费 ${result.summary.currency}`} value={result.summary.cheapestFreightAmount} /><span>{result.summary.cheapestFreightAmount}</span></strong><small>{result.summary.currency}</small></div>}
          </Card>
          {result.quotes.map((quote, index) => <QuoteCard key={quote.serviceCode} quote={quote} rank={index + 1} />)}
          {!result.quotes.length && <Alert type="warning" showIcon message="当前产品不符合任何渠道限制" description="请查看下方排除原因，检查重量、售价、尺寸或目的国。" />}
          {!!result.rejections.length && <Collapse ghost className="shipping-rejections" items={[{ key: 'rejections', label: `查看 ${result.rejections.length} 条未入选渠道`, children: <Space wrap>{result.rejections.map((item) => <Tag key={item.serviceCode}>{item.serviceName}：{item.reasonCodes.map((code) => reasonLabels[code] || code).join('、')}</Tag>)}</Space> }]} />}
        </>}
      </div>
    </div>
  </div>;
}

function QuoteCard({ quote, rank }: { quote: ShippingQuote; rank: number }) {
  return <Card className={`shipping-quote-card ${quote.isCheapest ? 'is-cheapest' : ''}`}>
    <div className="quote-heading"><span className="quote-rank">{String(rank).padStart(2, '0')}</span><div><Space wrap><Title level={4}>{quote.serviceName}</Title>{quote.isCheapest && <Tag color="green">最低价</Tag>}<Tag>{quote.productCategory}</Tag></Space><Text type="secondary">{quote.channel}{quote.transitTime ? ` · ${quote.transitTime}` : ''}</Text></div><div className="quote-price"><small>预计运费</small><strong className="copy-value-inline"><CopyValueButton label={`预计运费 ${quote.currency}`} value={quote.freightAmount} /><span>{quote.freightAmount}</span></strong><small>{quote.currency}</small></div></div>
    <div className="weight-rail"><WeightNode label="实重" value={`${quote.actualWeightKg}kg`} /><span>→</span><WeightNode label="体积重" value={quote.volumetricWeightKg ? `${quote.volumetricWeightKg}kg` : '不计抛'} muted={!quote.volumetricWeightKg} /><span>→</span><WeightNode label="计费重" value={`${quote.chargeableWeightKg}kg`} accent /></div>
    <div className="quote-foot"><code>{quote.breakdown.formula} = {quote.freightAmount}</code><span>{quote.deliveryMode}</span></div>
  </Card>;
}

function WeightNode({ label, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) {
  return <div className={`weight-node ${accent ? 'accent' : ''} ${muted ? 'muted' : ''}`}><small>{label}</small><strong>{value}</strong></div>;
}

export function ShippingTemplatesPage() {
  const client = useQueryClient();
  const carriers = useQuery({ queryKey: ['shipping-carriers'], queryFn: () => api.shippingCarriers(true), retry: false });
  const templates = useQuery({ queryKey: ['shipping-templates'], queryFn: api.shippingTemplates, retry: false });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => api.platforms(false), retry: false });
  const [carrierModal, setCarrierModal] = useState(false);
  const [templateModal, setTemplateModal] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [cloneSource, setCloneSource] = useState<ShippingTemplateSummary>();
  const [carrierForm] = Form.useForm();
  const [templateForm] = Form.useForm();
  const [cloneForm] = Form.useForm();
  const invalidate = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['shipping-carriers'] }), client.invalidateQueries({ queryKey: ['shipping-templates'] })]); };
  const createCarrier = useMutation({ mutationFn: api.createShippingCarrier, onSuccess: async () => { message.success('承运商已创建'); setCarrierModal(false); carrierForm.resetFields(); await invalidate(); }, onError: showError });
  const updateCarrier = useMutation({ mutationFn: ({ code, active }: { code: string; active: boolean }) => api.updateShippingCarrier(code, { active }), onSuccess: invalidate, onError: showError });
  const createTemplate = useMutation({ mutationFn: api.createShippingTemplate, onSuccess: async ({ template }) => { message.success('模板草稿已创建'); setTemplateModal(false); templateForm.resetFields(); await invalidate(); setEditingId(template.id); }, onError: showError });
  const cloneTemplate = useMutation({ mutationFn: ({ id, value }: { id: string; value: { carrierCode: string; name: string } }) => api.cloneShippingTemplate(id, value), onSuccess: async ({ template }) => { message.success('模板已复制为新草稿'); setCloneSource(undefined); cloneForm.resetFields(); await invalidate(); setEditingId(template.id); }, onError: showError });
  const archiveTemplate = useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => api.updateShippingTemplate(id, { active }), onSuccess: invalidate, onError: showError });

  if (carriers.isError || templates.isError) return <DatabaseUnavailable title="运费模板暂不可用" error={(carriers.error || templates.error) as Error} onRetry={() => { void carriers.refetch(); void templates.refetch(); }} />;
  const activeCarriers = carriers.data?.items.filter((item) => item.active) || [];
  return <div className="page-stack shipping-template-page">
    <ShippingPageTitle eyebrow="RATE TEMPLATE REGISTRY" title="运费模板" description="将物流规则作为可发布版本管理；历史报价始终能定位到原始版本。" extra={<Space><Button icon={<PlusOutlined />} onClick={() => setCarrierModal(true)}>添加承运商</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setTemplateModal(true)}>新建模板</Button></Space>} />
    <Card className="carrier-strip"><Flex gap={12} wrap="wrap" align="center"><Text type="secondary">承运商</Text>{carriers.data?.items.map((carrier) => <div className={`carrier-chip ${carrier.active ? '' : 'inactive'}`} key={carrier.code}><span><strong>{carrier.code}</strong>{carrier.displayName}</span><Switch size="small" checked={carrier.active} loading={updateCarrier.isPending} onChange={(active) => updateCarrier.mutate({ code: carrier.code, active })} /></div>)}</Flex></Card>
    <Card bodyStyle={{ padding: 0 }}><Table<ShippingTemplateSummary> rowKey="id" loading={templates.isLoading} pagination={false} scroll={{ x: 1040 }} dataSource={templates.data?.items || []} columns={[
      { title: '模板', width: 260, render: (_, item) => <div className="template-name-cell"><strong>{item.name}</strong><span>{item.carrierCode} · {item.carrierName}</span></div> },
      { title: '平台 / 场景', width: 190, render: (_, item) => <Tag color="blue">{item.platformCode} · {item.scenarioCode}</Tag> },
      { title: '线上版本', width: 130, render: (_, item) => item.publishedVersion ? <Tag color="green">V{item.publishedVersion.versionNo} 已发布</Tag> : <Tag>未发布</Tag> },
      { title: '草稿', width: 120, render: (_, item) => item.draftVersion ? <Tag color="gold">V{item.draftVersion.versionNo} 草稿</Tag> : <Text type="secondary">—</Text> },
      { title: '状态', width: 100, render: (_, item) => item.active ? <Tag color="cyan">启用</Tag> : <Tag>已归档</Tag> },
      { title: '操作', width: 280, fixed: 'right', render: (_, item) => <Space><Button size="small" icon={<EditOutlined />} onClick={() => setEditingId(item.id)}>编辑</Button><Button size="small" icon={<CopyOutlined />} disabled={!item.publishedVersion} onClick={() => { setCloneSource(item); cloneForm.setFieldsValue({ name: `${item.name} 副本` }); }}>复制</Button><Button size="small" danger={item.active} onClick={() => archiveTemplate.mutate({ id: item.id, active: !item.active })}>{item.active ? '归档' : '启用'}</Button></Space> }
    ]} /></Card>
    <Modal open={carrierModal} title="添加承运商" okText="创建承运商" confirmLoading={createCarrier.isPending} onCancel={() => setCarrierModal(false)} onOk={() => void carrierForm.validateFields().then((value) => createCarrier.mutate(value))}><Form form={carrierForm} layout="vertical" initialValues={{ active: true }}><Form.Item label="承运商代码" name="code" rules={[{ required: true }, { pattern: /^[A-Za-z0-9_-]{2,32}$/, message: '使用 2-32 位字母、数字、下划线或连字符' }]}><Input placeholder="UNI" /></Form.Item><Form.Item label="显示名称" name="displayName" rules={[{ required: true }]}><Input placeholder="UNI 物流" /></Form.Item></Form></Modal>
    <Modal open={templateModal} title="新建运费模板" okText="创建草稿" confirmLoading={createTemplate.isPending} onCancel={() => setTemplateModal(false)} onOk={() => void templateForm.validateFields().then((value) => createTemplate.mutate(value))}><Form form={templateForm} layout="vertical"><Form.Item label="承运商" name="carrierCode" rules={[{ required: true }]}><Select options={activeCarriers.map(carrierOption)} /></Form.Item><Form.Item label="平台" name="platformCode" rules={[{ required: true }]}><Select options={(platforms.data?.items || []).map((item) => ({ value: item.code, label: `${item.code} · ${item.displayName}` }))} /></Form.Item><Form.Item label="运费场景代码" name="scenarioCode" rules={[{ required: true },{ pattern: /^[A-Za-z0-9_-]{1,64}$/, message: '使用字母、数字、下划线或连字符' }]}><Input placeholder="例如 STANDARD、FBA、RFBS" /></Form.Item><Form.Item label="模板名称" name="name" rules={[{ required: true }]}><Input placeholder="例如 Amazon US 标准物流" /></Form.Item></Form></Modal>
    <Modal open={Boolean(cloneSource)} title="复制已发布模板" okText="复制为草稿" confirmLoading={cloneTemplate.isPending} onCancel={() => setCloneSource(undefined)} onOk={() => void cloneForm.validateFields().then((value) => cloneTemplate.mutate({ id: cloneSource!.id, value }))}><Form form={cloneForm} layout="vertical"><Alert type="info" showIcon message={`复制 ${cloneSource?.name || ''} 的全部规则`} description="新草稿与原模板独立，修改费率不会影响原模板。" /><Form.Item label="目标承运商" name="carrierCode" rules={[{ required: true }]}><Select options={activeCarriers.map(carrierOption)} /></Form.Item><Form.Item label="新模板名称" name="name" rules={[{ required: true }]}><Input /></Form.Item></Form></Modal>
    <TemplateEditorDrawer id={editingId} onClose={() => setEditingId(undefined)} onChanged={invalidate} />
  </div>;
}

function TemplateEditorDrawer({ id, onClose, onChanged }: { id?: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const detail = useQuery({ queryKey: ['shipping-template', id], queryFn: () => api.shippingTemplate(id!), enabled: Boolean(id), retry: false });
  const [definition, setDefinition] = useState<ShippingTemplateDefinitionV1>();
  useEffect(() => {
    const template = detail.data?.template;
    if (!template) return;
    setDefinition(structuredClone(template.versions.find((version) => version.status === 'DRAFT')?.definition || template.versions.find((version) => version.status === 'PUBLISHED')?.definition || { schemaVersion: '1', currency: 'CNY', services: [] }));
  }, [detail.data]);
  const save = useMutation({ mutationFn: () => api.saveShippingDraft(id!, definition!), onSuccess: async () => { message.success('模板草稿已保存'); await detail.refetch(); await onChanged(); }, onError: showError });
  const publish = useMutation({ mutationFn: async () => { await api.saveShippingDraft(id!, definition!); return api.publishShippingTemplate(id!); }, onSuccess: async () => { message.success('模板已发布'); await detail.refetch(); await onChanged(); }, onError: showError });
  const template = detail.data?.template;
  return <Drawer open={Boolean(id)} width="min(1080px, 96vw)" title={template ? `编辑运费模板 · ${template.name}` : '加载模板'} onClose={onClose} extra={<Space><Button icon={<SaveOutlined />} loading={save.isPending} disabled={!definition} onClick={() => save.mutate()}>保存草稿</Button><Button type="primary" icon={<RocketOutlined />} loading={publish.isPending} disabled={!definition || !template?.active} onClick={() => publish.mutate()}>保存并发布</Button></Space>}>
    {detail.isLoading || !definition || !template ? <Skeleton active /> : <div className="template-editor">
      <Descriptions size="small" column={4} bordered items={[{ key: 'carrier', label: '承运商', children: `${template.carrierCode} · ${template.carrierName}` }, { key: 'type', label: '平台 / 场景', children: `${template.platformCode} · ${template.scenarioCode}` }, { key: 'published', label: '已发布', children: template.versions.find((version) => version.status === 'PUBLISHED') ? `V${template.versions.find((version) => version.status === 'PUBLISHED')!.versionNo}` : '—' }, { key: 'draft', label: '草稿', children: template.versions.find((version) => version.status === 'DRAFT') ? `V${template.versions.find((version) => version.status === 'DRAFT')!.versionNo}` : '保存时创建下一版本' }]} />
      <Field label="运费币种"><Input value={definition.currency} maxLength={3} onChange={(event) => { const currency = event.target.value.toUpperCase(); setDefinition({ ...definition, currency, services: definition.services.map((service) => ({ ...service, rules: service.rules.map((rule) => ({ ...rule, pricing: { ...rule.pricing, currency } })) })) }); }} /></Field>
      <Field label="售价区间币种（仅在规则按售价分档时填写）"><Input value={definition.salePriceCurrencyCode} maxLength={3} placeholder="例如 RUB、USD" onChange={(event) => setDefinition({ ...definition, salePriceCurrencyCode: event.target.value.toUpperCase() || undefined })} /></Field>
      <Alert type="info" showIcon message="结构化规则编辑" description="每个服务渠道可包含多个互斥费率档。发布时系统会检查区间重叠、必填字段和模板场景。" />
      <Flex justify="space-between" align="center"><Title level={4}>服务渠道</Title><Button icon={<PlusOutlined />} onClick={() => setDefinition({ ...definition, services: [...definition.services, newService(definition.services.length, definition.currency)] })}>添加渠道</Button></Flex>
      {!definition.services.length && <Empty description="还没有服务渠道。先添加一个渠道，再配置费率规则。" />}
      <Collapse className="service-editor-list" defaultActiveKey={definition.services.map((_, serviceIndex) => `service-${serviceIndex}`)} items={definition.services.map((service, serviceIndex) => ({ key: `service-${serviceIndex}`, label: <Space><strong>{service.name || '未命名渠道'}</strong><Tag>{service.code}</Tag><Text type="secondary">{service.rules.length} 个规则</Text></Space>, extra: <Button type="text" danger icon={<DeleteOutlined />} onClick={(event) => { event.stopPropagation(); setDefinition({ ...definition, services: definition.services.filter((_, index) => index !== serviceIndex) }); }} />, children: <ServiceEditor currency={definition.currency} salePriceCurrency={definition.salePriceCurrencyCode} service={service} onChange={(next) => setDefinition({ ...definition, services: definition.services.map((value, index) => index === serviceIndex ? next : value) })} /> }))} />
      <Divider />
      <Title level={5}>历史版本</Title><Space wrap>{template.versions.map((version) => <Tag key={version.id} color={version.status === 'PUBLISHED' ? 'green' : version.status === 'DRAFT' ? 'gold' : 'default'}>V{version.versionNo} · {version.status}</Tag>)}</Space>
    </div>}
  </Drawer>;
}

function ServiceEditor({ currency, salePriceCurrency, service, onChange }: { currency: string; salePriceCurrency?: string; service: ShippingService; onChange: (value: ShippingService) => void }) {
  const patch = (value: Partial<ShippingService>) => onChange({ ...service, ...value });
  return <div className="service-editor"><Row gutter={12}><Col span={6}><Field label="渠道代码"><Input value={service.code} onChange={(event) => patch({ code: event.target.value.toUpperCase() })} /></Field></Col><Col span={6}><Field label="渠道名称"><Input value={service.name} onChange={(event) => patch({ name: event.target.value })} /></Field></Col><Col span={6}><Field label="渠道类型"><Input value={service.channel} onChange={(event) => patch({ channel: event.target.value })} /></Field></Col><Col span={6}><Field label="时效"><Input value={service.transitTime} onChange={(event) => patch({ transitTime: event.target.value })} /></Field></Col></Row>
    <Row gutter={12}><Col span={12}><Field label="配送方式"><Input value={service.deliveryMode} onChange={(event) => patch({ deliveryMode: event.target.value })} /></Field></Col><Col span={12}><Field label="备注"><Input value={service.notes} onChange={(event) => patch({ notes: event.target.value })} /></Field></Col></Row>
    <Divider orientation="left">费率规则</Divider>
    {service.rules.map((rule, ruleIndex) => <RuleEditor key={`rule-${ruleIndex}`} currency={currency} salePriceCurrency={salePriceCurrency} rule={rule} onDelete={() => patch({ rules: service.rules.filter((_, index) => index !== ruleIndex) })} onChange={(next) => patch({ rules: service.rules.map((value, index) => index === ruleIndex ? next : value) })} />)}
    <Button type="dashed" block icon={<PlusOutlined />} onClick={() => patch({ rules: [...service.rules, newRule(service.code, service.rules.length, currency)] })}>添加费率规则</Button>
  </div>;
}

function RuleEditor({ currency, salePriceCurrency, rule, onChange, onDelete }: { currency: string; salePriceCurrency?: string; rule: ShippingRule; onChange: (rule: ShippingRule) => void; onDelete: () => void }) {
  const patch = (value: Partial<ShippingRule>) => onChange({ ...rule, ...value });
  const constraints = rule.constraints;
  const patchConstraints = (value: Partial<ShippingRule['constraints']>) => patch({ constraints: { ...constraints, ...value } });
  const charge = rule.chargeableWeight;
  const patchCharge = (value: Partial<ShippingRule['chargeableWeight']>) => patch({ chargeableWeight: { ...charge, ...value } });
  return <Card size="small" className="rule-editor-card" title={<Space><Input className="rule-id-input" value={rule.id} onChange={(event) => patch({ id: event.target.value.toUpperCase() })} /><Tag>{rule.productCategory || '未分类'}</Tag></Space>} extra={<Button type="text" danger icon={<DeleteOutlined />} onClick={onDelete} />}>
    <Row gutter={10}><Col span={8}><Field label="产品分类"><Input value={rule.productCategory} onChange={(event) => patch({ productCategory: event.target.value })} /></Field></Col><Col span={16}><Field label="目的国家（留空表示不限）"><Select mode="multiple" showSearch optionFilterProp="label" value={rule.destinationCountryCodes} placeholder="输入中文国家名搜索并选择" onChange={(value) => patch({ destinationCountryCodes: value })} options={countryOptionsWithLegacyCodes(rule.destinationCountryCodes)} /></Field></Col></Row>
    <div className="rule-grid">
      <RangeEditor label="实重范围 kg" value={constraints.actualWeightKg} onChange={(value) => patchConstraints({ actualWeightKg: value })} />
      <RangeEditor label={`售价范围 ${salePriceCurrency || '未设置币种'}（留空表示不限）`} value={constraints.salePrice || constraints.salePriceRub} onChange={(value) => patchConstraints({ salePrice: value, salePriceRub: undefined })} />
      <DecimalField label="三边和上限 cm" value={constraints.maxSideSumCm} onChange={(value) => patchConstraints({ maxSideSumCm: value })} />
      <DecimalField label="最长边上限 cm" value={constraints.maxLongestSideCm} onChange={(value) => patchConstraints({ maxLongestSideCm: value })} />
      <DimensionBoxEditor value={constraints.maxDimensionBoxCm} onChange={(value) => patchConstraints({ maxDimensionBoxCm: value })} />
      <DecimalField label="最低密度 kg/m³" value={constraints.minDensityKgM3} onChange={(value) => patchConstraints({ minDensityKgM3: value })} />
      <DecimalField label="计费重上限 kg" value={constraints.maxChargeableWeightKg} onChange={(value) => patchConstraints({ maxChargeableWeightKg: value })} />
    </div>
    <Row gutter={10}><Col span={6}><Field label="计费重方式"><Select value={charge.mode} onChange={(value) => patchCharge({ mode: value })} options={[{ value: 'ACTUAL', label: '按实重' }, { value: 'MAX_ACTUAL_VOLUMETRIC', label: '实重与体积重取大' }]} /></Field></Col>{charge.mode === 'MAX_ACTUAL_VOLUMETRIC' && <><Col span={6}><DecimalField label="体积重除数" value={charge.volumetricDivisor} onChange={(value) => patchCharge({ volumetricDivisor: value })} /></Col><Col span={6}><DecimalField label="体积重触发三边和" value={charge.volumetricTriggerSideSumCm} onChange={(value) => patchCharge({ volumetricTriggerSideSumCm: value })} /></Col><Col span={6}><DecimalField label="体积重进位 kg" value={charge.volumetricRoundingStepKg} onChange={(value) => patchCharge({ volumetricRoundingStepKg: value })} /></Col></>}</Row>
    <Row gutter={10}><Col span={6}><DecimalField label="计费重进位 kg" value={charge.roundingStepKg} onChange={(value) => patchCharge({ roundingStepKg: value })} /></Col><Col span={6}><DecimalField label={`每千克费率 ${currency}`} value={rule.pricing.ratePerKg} required onChange={(value) => patch({ pricing: { ...rule.pricing, ratePerKg: value || '0', currency } })} /></Col><Col span={6}><DecimalField label={`每票固定费 ${currency}`} value={rule.pricing.fixedFee} required onChange={(value) => patch({ pricing: { ...rule.pricing, fixedFee: value || '0', currency } })} /></Col></Row>
  </Card>;
}

function RangeEditor({ label, value, onChange }: { label: string; value?: { min?: string; max?: string; includeMin: boolean; includeMax: boolean }; onChange: (value: any) => void }) {
  const current = value || { includeMin: true, includeMax: true };
  return <Field label={label}><Space.Compact block><InputNumber placeholder="最小" stringMode value={current.min} onChange={(next) => onChange({ ...current, min: next === null ? undefined : String(next) })} /><Select value={current.includeMin} onChange={(includeMin) => onChange({ ...current, includeMin })} options={[{ value: true, label: '≤' }, { value: false, label: '<' }]} style={{ width: 58 }} /><InputNumber placeholder="最大" stringMode value={current.max} onChange={(next) => onChange({ ...current, max: next === null ? undefined : String(next) })} /></Space.Compact></Field>;
}

function DecimalField({ label, value, onChange, required }: { label: string; value?: string; onChange: (value?: string) => void; required?: boolean }) {
  return <Field label={label} required={required}><InputNumber min="0" stringMode value={value} onChange={(next) => onChange(next === null ? undefined : String(next))} style={{ width: '100%' }} /></Field>;
}

function DimensionBoxEditor({ value, onChange }: { value?: [string, string, string]; onChange: (value?: [string, string, string]) => void }) {
  const current = value || ['', '', ''];
  const set = (index: number, next: string | null) => {
    const values = [...current] as [string, string, string];
    values[index] = next === null ? '' : String(next);
    onChange(values.some(Boolean) ? values : undefined);
  };
  return <Field label="最大尺寸盒 cm"><Space.Compact block>{current.map((item, index) => <InputNumber key={index} stringMode placeholder={['最长', '次长', '最短'][index]} value={item || undefined} onChange={(next) => set(index, next)} />)}</Space.Compact></Field>;
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) { return <div className="shipping-field"><label>{required && <b>*</b>}{label}</label>{children}</div>; }
function newService(index: number, currency: string): ShippingService { const code = `NEW_SERVICE_${index + 1}`; return { code, name: '新服务渠道', channel: '待配置', sortOrder: (index + 1) * 10, rules: [newRule(code, 0, currency)] }; }
function newRule(serviceCode: string, index: number, currency: string): ShippingRule { return { id: `${serviceCode}_RULE_${index + 1}`, productCategory: '待配置分类', destinationCountryCodes: [], constraints: { actualWeightKg: { includeMin: true, includeMax: true } }, chargeableWeight: { mode: 'ACTUAL' }, pricing: { ratePerKg: '0', fixedFee: '0', currency } }; }
function carrierOption(carrier: ShippingCarrier) { return { value: carrier.code, label: `${carrier.code} · ${carrier.displayName}` }; }
function showError(error: Error) { message.error(error.message); }

function DatabaseUnavailable({ title, error, onRetry }: { title: string; error: Error; onRetry: () => void }) {
  const databaseUnavailable = error.message.startsWith('DATABASE_UNAVAILABLE:');
  return <Result status="warning" title={title} subTitle={databaseUnavailable ? '请在项目根目录的 .env 中配置 DATABASE_URL，重启服务后重试。' : error.message} extra={<Button type="primary" onClick={onRetry}>重新检测</Button>} />;
}
