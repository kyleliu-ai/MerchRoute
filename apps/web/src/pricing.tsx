import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Col, Divider, Drawer, Empty, Flex, Form, Input, InputNumber, Modal,
  Popconfirm, Popover, Row, Segmented, Select, Space, Statistic, Switch, Table, Tabs, Tag, Typography, Upload, message
} from 'antd';
import { CopyOutlined, DatabaseOutlined, DeleteOutlined, DownloadOutlined, InfoCircleOutlined, PlusOutlined, RocketOutlined, SaveOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import type { PricingCalculationItem, PricingTemplateDefinitionV1 } from '@n8n-media-review/shared';
import { api, type CommercePlatform, type CurrencyCatalogItem, type PricingBatchResult, type PricingCalculationResult, type PricingOption, type PricingProductQueryInput, type PricingProductQueryResult, type PricingTemplateSummary } from './api/client';
import { CopyValueButton } from './copy-value';
import { allChineseCountryOptions, chineseCountryNameForExport, countryCodeFromChineseNameOrCode, countryOptionsForCodes, type CountrySelectOption } from './countries';

const { Title, Text, Paragraph } = Typography;
type BatchRow = PricingCalculationItem & { key: string };

function PricingPageTitle({ eyebrow, title, description, extra }: { eyebrow: string; title: string; description: string; extra?: React.ReactNode }) {
  return <div className="pricing-page-title"><div><span>{eyebrow}</span><Title level={2}>{title}</Title><Paragraph>{description}</Paragraph></div>{extra}</div>;
}

export function PricingQueryPage() {
  const templates = useQuery({ queryKey: ['pricing-templates'], queryFn: api.pricingTemplates, retry: false });
  const shipping = useQuery({ queryKey: ['shipping-templates'], queryFn: api.shippingTemplates, retry: false });
  const [lookupKind, setLookupKind] = useState<'SKU' | 'PRODUCT_NAME'>('SKU');
  const [lookupValue, setLookupValue] = useState('');
  const [pricingTemplateId, setPricingTemplateId] = useState<string>();
  const [shippingTemplateId, setShippingTemplateId] = useState<string>();
  const [shippingServiceCodes, setShippingServiceCodes] = useState<string[]>([]);
  const [destinationCountryCode, setDestinationCountryCode] = useState<string>();
  const [result, setResult] = useState<PricingProductQueryResult>();
  const appliedShippingVersionId = useRef<string>();
  const selectedPricing = templates.data?.items.find((item) => item.id === pricingTemplateId);
  const availableShipping = useMemo(() => (shipping.data?.items || []).filter((item) => item.active && item.carrierActive && item.publishedVersion && item.platformCode === selectedPricing?.platformCode), [selectedPricing?.platformCode, shipping.data]);
  const shippingDetail = useQuery({ queryKey: ['shipping-template', shippingTemplateId], queryFn: () => api.shippingTemplate(shippingTemplateId!), enabled: Boolean(shippingTemplateId), retry: false });
  const publishedShippingVersion = shippingDetail.data?.template.versions.find((version) => version.status === 'PUBLISHED');
  const shippingServices = useMemo(() => [...(publishedShippingVersion?.definition.services || [])].sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code)), [publishedShippingVersion]);
  const selectedServiceCodeSet = useMemo(() => new Set(shippingServiceCodes), [shippingServiceCodes]);
  const destinationCodeKey = [...new Set(shippingServices.filter((service) => selectedServiceCodeSet.has(service.code)).flatMap((service) => service.rules.flatMap((rule) => rule.destinationCountryCodes)))].sort().join('|');
  const destinationOptions = useMemo(() => countryOptionsForCodes(destinationCodeKey ? destinationCodeKey.split('|') : []), [destinationCodeKey]);
  const destinationLoading = shippingDetail.isLoading;
  const shippingDetailError = shippingDetail.isError ? shippingDetail.error as Error : undefined;
  const queryPricing = useMutation({
    mutationFn: api.queryProductPricing,
    onSuccess: setResult,
    onError: showError
  });

  useEffect(() => {
    const first = templates.data?.items.find((item) => item.active && item.publishedVersion);
    if (!pricingTemplateId && first) setPricingTemplateId(first.id);
  }, [pricingTemplateId, templates.data]);
  useEffect(() => {
    if (shippingTemplateId && !availableShipping.some((item) => item.id === shippingTemplateId)) {
      setShippingTemplateId(undefined);
      setShippingServiceCodes([]);
      setDestinationCountryCode(undefined);
    }
  }, [availableShipping, shippingTemplateId]);
  useEffect(() => {
    if (!publishedShippingVersion || appliedShippingVersionId.current === publishedShippingVersion.id) return;
    setShippingServiceCodes(shippingServices.map((service) => service.code));
    appliedShippingVersionId.current = publishedShippingVersion.id;
    setDestinationCountryCode(undefined);
    setResult(undefined);
  }, [publishedShippingVersion, shippingServices]);
  useEffect(() => {
    if (!destinationOptions.length) setDestinationCountryCode(undefined);
    else if (destinationCountryCode && !destinationOptions.some((option) => option.value === destinationCountryCode)) setDestinationCountryCode(undefined);
  }, [destinationCountryCode, destinationOptions]);
  const criteriaKey = `${lookupKind}|${lookupValue}|${pricingTemplateId || ''}|${shippingTemplateId || ''}|${shippingServiceCodes.join(',')}|${destinationCountryCode || ''}`;
  useEffect(() => setResult(undefined), [criteriaKey]);

  const changeTemplate = (id: string) => {
    setPricingTemplateId(id);
    setShippingTemplateId(undefined);
    setShippingServiceCodes([]);
    appliedShippingVersionId.current = undefined;
    setDestinationCountryCode(undefined);
    setResult(undefined);
  };
  const changeShippingTemplate = (id: string) => {
    setShippingTemplateId(id);
    setShippingServiceCodes([]);
    appliedShippingVersionId.current = undefined;
    setDestinationCountryCode(undefined);
    setResult(undefined);
  };
  const submit = () => {
    const value = lookupValue.trim();
    if (!value) return message.warning(lookupKind === 'SKU' ? '请输入产品 SKU' : '请输入产品名关键词');
    if (lookupKind === 'SKU' && !/^\d{7}$/.test(value)) return message.warning('SKU 必须是完整的 7 位数字');
    if (!pricingTemplateId) return message.warning('请选择已发布的定价模板');
    if (!shippingTemplateId) return message.warning('请选择一个运费模板');
    if (!shippingServiceCodes.length) return message.warning('请至少选择一个服务渠道');
    if (destinationOptions.length && !destinationCountryCode) return message.warning('所选运费模板包含目的国限制，请选择目的国');
    const lookup: PricingProductQueryInput['lookup'] = lookupKind === 'SKU' ? { kind: 'SKU', sku: value } : { kind: 'PRODUCT_NAME', productName: value };
    queryPricing.mutate({ lookup, pricingTemplateId, shippingTemplateIds: [shippingTemplateId], shippingServiceCodes, ...(destinationCountryCode ? { destinationCountryCode } : {}) });
  };

  if (templates.isError || shipping.isError) return <Alert type="error" showIcon message="售价查询暂不可用" description={(templates.error || shipping.error as Error)?.message} />;
  const conditionsReady = Boolean(lookupValue.trim() && pricingTemplateId && shippingTemplateId && shippingServiceCodes.length && publishedShippingVersion && (!destinationOptions.length || destinationCountryCode));
  return <div className="page-stack pricing-query-page">
    <PricingPageTitle eyebrow="LIVE PRODUCT PRICING" title="售价查询" description="按 SKU 精确查询，或输入产品名关键词查找包含该文字的产品；系统会读取最新采购成本并实时计算售价。" />
    <Card className="pricing-query-panel">
      <div className="pricing-query-mode"><span>查询方式</span><Segmented value={lookupKind} onChange={(value) => { setLookupKind(value as typeof lookupKind); setLookupValue(''); }} options={[{ label: '按 SKU', value: 'SKU' }, { label: '按产品名', value: 'PRODUCT_NAME' }]} /></div>
      <div className="pricing-query-grid">
        <Field label={lookupKind === 'SKU' ? '产品 SKU' : '产品名关键词'}><Input aria-label={lookupKind === 'SKU' ? '产品 SKU' : '产品名关键词'} prefix={<SearchOutlined />} value={lookupValue} maxLength={lookupKind === 'SKU' ? 7 : 300} placeholder={lookupKind === 'SKU' ? '输入 7 位 SKU，例如 0000001' : '输入产品名中的关键词，例如：布鞋'} onChange={(event) => setLookupValue(event.target.value)} onPressEnter={submit} /></Field>
        <Field label="定价模板"><Select value={pricingTemplateId} onChange={changeTemplate} loading={templates.isLoading} placeholder="选择已发布定价模板" options={(templates.data?.items || []).filter((item) => item.active && item.publishedVersion).map((item) => ({ value: item.id, label: `${item.platformName} · ${item.name} · V${item.publishedVersion!.versionNo}` }))} /></Field>
        <Field label="运费模板"><Select value={shippingTemplateId} onChange={changeShippingTemplate} placeholder={selectedPricing ? '选择一个同平台运费模板' : '请先选择定价模板'} options={availableShipping.map((item) => ({ value: item.id, label: `${item.carrierName} · ${item.name} · V${item.publishedVersion!.versionNo}` }))} /></Field>
        <Field label="服务渠道"><Select mode="multiple" value={shippingServiceCodes} onChange={setShippingServiceCodes} loading={shippingDetail.isLoading} disabled={!shippingTemplateId || shippingDetail.isError} placeholder={shippingTemplateId ? '选择一种或多种服务渠道' : '请先选择运费模板'} options={shippingServices.map((service) => ({ value: service.code, label: service.name }))} /></Field>
        {!!destinationOptions.length && <Field label="目的国"><Select showSearch optionFilterProp="label" loading={destinationLoading} value={destinationCountryCode} onChange={setDestinationCountryCode} placeholder="输入中文国家名搜索" options={destinationOptions} /></Field>}
      </div>
      {shippingDetailError && <Alert type="error" showIcon message="无法读取运费模板规则" description={shippingDetailError.message} />}
      <Button className="pricing-query-submit" type="primary" size="large" icon={<RocketOutlined />} disabled={!conditionsReady || Boolean(shippingDetailError)} loading={queryPricing.isPending || destinationLoading} onClick={submit}>查询并计算价格</Button>
    </Card>
    {!result && !queryPricing.isPending && <Card className="pricing-query-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="设置查询条件后，这里会直接展示每个产品的全部渠道价格。" /></Card>}
    {queryPricing.isPending && <Card className="pricing-query-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="正在读取最新采购版本并计算渠道售价…" /></Card>}
    {result && <PricingQueryResults result={result} />}
  </div>;
}

function PricingQueryResults({ result }: { result: PricingProductQueryResult }) {
  return <div className="pricing-query-results">
    <Card className="pricing-query-summary"><div><span>匹配产品<strong>{result.total}</strong></span><span>成功<strong>{result.succeeded}</strong></span><span className={result.failed ? 'has-error' : ''}>失败<strong>{result.failed}</strong></span></div><Text type="secondary">定价模板 {result.pricingTemplate.templateName} V{result.pricingTemplate.versionNo}</Text></Card>
    {!result.total && <Card className="pricing-query-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={result.lookup.kind === 'SKU' ? '没有找到该 SKU 对应的产品。' : '没有找到产品名中包含该关键词的产品。'} /></Card>}
    {result.results.map((row) => <PricingQueryProductCard key={row.product.sku} row={row} />)}
  </div>;
}

function PricingQueryProductCard({ row }: { row: PricingProductQueryResult['results'][number] }) {
  const product = row.product;
  const result = row.result;
  const recommended = result?.options[0];
  const dimensions = [product.procurement.lengthCm, product.procurement.widthCm, product.procurement.heightCm];
  const completeDimensions = dimensions.every((value) => Boolean(value));
  const dimensionValue = completeDimensions ? dimensions.join(' × ') : '';
  const shippingVersions = result ? [...new Set(result.options.map((option) => {
    const template = option.shipping.template as { templateName?: string; versionNo?: number } | undefined;
    return template ? `${template.templateName || '运费模板'} V${template.versionNo ?? '-'}` : undefined;
  }).filter(Boolean))] : [];
  return <Card className="pricing-product-result">
    <div className="pricing-product-head"><div><Space wrap><span className="copy-value-inline"><CopyValueButton inverse label="SKU" value={product.sku} /><span className="mono-badge">{product.sku}</span></span><span className="copy-value-inline pricing-product-name"><CopyValueButton inverse label="产品名" value={product.productName} /><Title level={3}>{product.productName}</Title></span>{row.ok ? <Tag color="green">计算成功</Tag> : <Tag color="red">计算失败</Tag>}</Space><Text type="secondary">最新采购版本 V{product.procurement.versionNo}</Text></div>{recommended && <div className="pricing-product-recommend"><small>推荐渠道</small><strong>{recommended.shipping.serviceName}</strong><span>{recommended.shipping.channel}</span></div>}</div>
    <div className="pricing-product-facts">
      <span><small>采购价</small><strong className="copy-value-inline"><CopyValueButton label="采购价" value={product.procurement.purchasePrice} /><span>{product.procurement.purchasePrice} {product.procurement.currency}</span></strong></span>
      <span><small>国内快递费</small><strong className="copy-value-inline"><CopyValueButton label="国内快递费" value={product.procurement.courierFee} /><span>{product.procurement.courierFee} {product.procurement.currency}</span></strong></span>
      <span><small>重量</small>{product.procurement.grossWeightGrams ? <strong className="copy-value-inline"><CopyValueButton label="重量" value={product.procurement.grossWeightGrams} /><span>{product.procurement.grossWeightGrams} g</span></strong> : <strong>-</strong>}</span>
      <span><small>包装尺寸</small>{completeDimensions ? <strong className="copy-value-inline"><CopyValueButton label="包装尺寸" value={dimensionValue} /><span>{dimensionValue} cm</span></strong> : <strong>-</strong>}</span>
    </div>
    <div className="pricing-product-versions"><span>数据链</span><code>采购 V{product.procurement.versionNo}</code><i>→</i><code>定价 V{result?.pricingTemplate.versionNo ?? '-'}</code><i>→</i><code>{shippingVersions.join(' / ') || '运费版本未生成'}</code></div>
    {!row.ok && <Alert type="error" showIcon message={row.error?.message || '产品价格计算失败'} description={row.error?.code} />}
    {result && <div className="pricing-product-options">{result.options.map((option, index) => <PricingOptionCard key={option.optionId} option={option} result={result} rank={index + 1} />)}</div>}
  </Card>;
}

export function PricingCalculatorPage() {
  const templates = useQuery({ queryKey: ['pricing-templates'], queryFn: api.pricingTemplates, retry: false });
  const shipping = useQuery({ queryKey: ['shipping-templates'], queryFn: api.shippingTemplates, retry: false });
  const [pricingTemplateId, setPricingTemplateId] = useState<string>();
  const [shippingTemplateIds, setShippingTemplateIds] = useState<string[]>([]);
  const selectedPricing = templates.data?.items.find((item) => item.id === pricingTemplateId);
  const availableShipping = useMemo(() => (shipping.data?.items || []).filter((item) => item.active && item.carrierActive && item.publishedVersion && item.platformCode === selectedPricing?.platformCode), [selectedPricing?.platformCode, shipping.data]);
  const selectedShippingDetails = useQueries({ queries: shippingTemplateIds.map((id) => ({ queryKey: ['shipping-template', id], queryFn: () => api.shippingTemplate(id), retry: false })) });
  const destinationCodeKey = [...new Set(selectedShippingDetails.flatMap((query) => {
    const published = query.data?.template.versions.find((version) => version.status === 'PUBLISHED');
    return published?.definition.services.flatMap((service) => service.rules.flatMap((rule) => rule.destinationCountryCodes)) || [];
  }))].sort().join('|');
  const destinationOptions = useMemo(() => countryOptionsForCodes(destinationCodeKey ? destinationCodeKey.split('|') : []), [destinationCodeKey]);
  const destinationLoading = selectedShippingDetails.some((query) => query.isLoading);
  useEffect(() => {
    const first = templates.data?.items.find((item) => item.active && item.publishedVersion);
    if (!pricingTemplateId && first) setPricingTemplateId(first.id);
  }, [pricingTemplateId, templates.data]);
  useEffect(() => setShippingTemplateIds((current) => current.filter((id) => availableShipping.some((item) => item.id === id))), [availableShipping]);

  if (templates.isError || shipping.isError) return <Alert type="error" showIcon message="售价计算暂不可用" description={(templates.error || shipping.error as Error)?.message} />;
  const selector = <Card className="pricing-selector"><Row gutter={[12, 12]} align="bottom"><Col xs={24} md={10}><label>定价模板</label><Select value={pricingTemplateId} onChange={setPricingTemplateId} loading={templates.isLoading} placeholder="请选择已发布定价模板" options={(templates.data?.items || []).filter((item) => item.active && item.publishedVersion).map((item) => ({ value: item.id, label: `${item.platformName} · ${item.name} · V${item.publishedVersion!.versionNo}` }))} /></Col><Col xs={24} md={14}><label>参与比较的运费模板</label><Select mode="multiple" value={shippingTemplateIds} onChange={setShippingTemplateIds} placeholder={selectedPricing ? '请选择同平台的已发布运费模板' : '请先选择定价模板'} options={availableShipping.map((item) => ({ value: item.id, label: `${item.carrierName} · ${item.name} · ${item.scenarioCode}` }))} /></Col></Row></Card>;
  return <div className="page-stack pricing-calculator-page">
    <PricingPageTitle eyebrow="GLOBAL PRICE WORKBENCH" title="商品售价计算" description="从采购与物流成本反推目标售价；平台、币种和费用组件均来自已发布模板。" />
    {selector}
    <Tabs className="pricing-mode-tabs" items={[
      { key: 'single', label: '单品试算', children: <SinglePricingCalculator pricingTemplateId={pricingTemplateId} shippingTemplateIds={shippingTemplateIds} destinationOptions={destinationOptions} destinationLoading={destinationLoading} /> },
      { key: 'batch', label: '批量计算', children: <BatchPricingCalculator pricingTemplateId={pricingTemplateId} shippingTemplateIds={shippingTemplateIds} destinationOptions={destinationOptions} destinationLoading={destinationLoading} /> }
    ]} />
  </div>;
}

function SinglePricingCalculator({ pricingTemplateId, shippingTemplateIds, destinationOptions, destinationLoading }: { pricingTemplateId?: string; shippingTemplateIds: string[]; destinationOptions: CountrySelectOption[]; destinationLoading: boolean }) {
  const [form] = Form.useForm();
  const [result, setResult] = useState<PricingCalculationResult>();
  const appliedTemplateVersionId = useRef<string>();
  const templateDetail = useQuery({ queryKey: ['pricing-template', pricingTemplateId], queryFn: () => api.pricingTemplate(pricingTemplateId!), enabled: Boolean(pricingTemplateId), retry: false });
  const publishedVersion = templateDetail.data?.template.versions.find((version) => version.status === 'PUBLISHED');
  const templateDefaultsReady = Boolean(publishedVersion);
  const calculate = useMutation({ mutationFn: api.calculatePricing, onSuccess: setResult, onError: showError });
  useEffect(() => {
    appliedTemplateVersionId.current = undefined;
    setResult(undefined);
  }, [pricingTemplateId]);
  useEffect(() => {
    if (!publishedVersion || appliedTemplateVersionId.current === publishedVersion.id) return;
    form.setFieldsValue({
      commissionRate: publishedVersion.definition.defaultCommissionRate,
      targetMarginRate: publishedVersion.definition.defaultTargetMarginRate
    });
    appliedTemplateVersionId.current = publishedVersion.id;
    setResult(undefined);
  }, [form, publishedVersion]);
  useEffect(() => {
    if (destinationLoading) return;
    const current = form.getFieldValue('destinationCountryCode');
    if (destinationOptions.some((option) => option.value === current)) return;
    form.setFieldValue('destinationCountryCode', destinationOptions[0]?.value);
  }, [destinationLoading, destinationOptions, form]);
  const submit = async () => {
    if (!pricingTemplateId || !shippingTemplateIds.length) return message.warning('请先选择定价模板和至少一个运费模板');
    if (!publishedVersion) return message.warning('定价模板默认费率尚未加载完成');
    const value = await form.validateFields();
    calculate.mutate({ pricingTemplateId, shippingTemplateIds, item: normalizeItem({ ...value, sku: 'SINGLE-QUOTE', productName: '单品试算' }) });
  };
  return <div className="pricing-workbench">
    <Card className="pricing-input-deck">
      <div className="pricing-deck-heading"><span>INPUT</span><div><strong>商品成本与包裹</strong><small>采购价不含模板固定费用</small></div></div>
      <Form form={form} layout="vertical" initialValues={{ purchaseCost: 34.6, domesticFreight: 0, actualWeightGrams: 550, lengthCm: 10, widthCm: 10, heightCm: 10 }}>
        <Row gutter={10}><Col span={12}><MoneyInput label="采购价（不含固定费用）" name="purchaseCost" required /></Col><Col span={12}><MoneyInput label="国内快递费" name="domesticFreight" required /></Col></Row>
        <Divider />
        <MoneyInput label="重量" name="actualWeightGrams" required addon="g" />
        <Row gutter={10}>{(['lengthCm','widthCm','heightCm'] as const).map((name,index) => <Col span={8} key={name}><MoneyInput label={['长','宽','高'][index]!} name={name} required addon="cm" /></Col>)}</Row>
        {!!destinationOptions.length && <Form.Item label="目的国" name="destinationCountryCode" rules={[{ required: true, message: '请选择目的国' }]}><Select showSearch optionFilterProp="label" loading={destinationLoading} placeholder="输入中文国家名搜索" options={destinationOptions} /></Form.Item>}
        {templateDetail.isError && <Alert className="pricing-template-default-alert" type="error" showIcon message="无法读取定价模板默认值" description={(templateDetail.error as Error).message} />}
        {!templateDetail.isLoading && templateDetail.isSuccess && !publishedVersion && <Alert className="pricing-template-default-alert" type="warning" showIcon message="当前定价模板没有已发布版本" />}
        <Row gutter={10}><Col span={12}><RateInput label="佣金率覆盖" name="commissionRate" required disabled={!templateDefaultsReady} /></Col><Col span={12}><RateInput label="目标毛利率覆盖" name="targetMarginRate" required disabled={!templateDefaultsReady} /></Col></Row>
        {publishedVersion && <div className="pricing-template-default-note">已载入 {templateDetail.data?.template.name} V{publishedVersion.versionNo} 默认值，本次修改不会改变模板。</div>}
        <Button type="primary" block size="large" disabled={!templateDefaultsReady || templateDetail.isError} loading={calculate.isPending || templateDetail.isLoading} onClick={() => void submit()}>计算全部可用渠道</Button>
      </Form>
    </Card>
    <div className="pricing-results">
      {!result && <Card className="pricing-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="完成输入后，这里会展示从成本到划线价的价格阶梯。" /></Card>}
      {result && !result.options.length && <Alert type="warning" showIcon message="没有自洽的物流与售价方案" description="检查包裹限制、目的国、运费模板币种以及售价区间。" />}
      {result?.options.map((option, index) => <PricingOptionCard key={option.optionId} option={option} result={result} rank={index + 1} />)}
    </div>
  </div>;
}

function PricingOptionCard({ option, result, rank }: { option: PricingOption; result: PricingCalculationResult; rank: number }) {
  const costCode = option.amounts.targetSale.costCurrency.currencyCode;
  const saleCode = option.amounts.targetSale.saleCurrency.currencyCode;
  const fixedCostRows: BreakdownRow[] = [
    { key: 'purchase', label: '采购价', value: option.costs.purchase.displayValue, unit: option.costs.purchase.currencyCode },
    { key: 'domestic-freight', label: '国内快递费', value: option.costs.domesticFreight.displayValue, unit: option.costs.domesticFreight.currencyCode },
    { key: 'cross-border-freight', label: '跨境运费', value: option.costs.crossBorderFreight.displayValue, unit: option.costs.crossBorderFreight.currencyCode },
    ...option.costs.fixedComponents.map((component) => ({ key: `fixed-${component.code}`, label: component.name, value: component.amount.displayValue, unit: component.amount.currencyCode }))
  ];
  const rateRows: BreakdownRow[] = [
    { key: 'commission-rate', label: '佣金率', value: formatRate(option.rates.commissionRate) },
    { key: 'target-margin-rate', label: '目标毛利率', value: formatRate(option.rates.targetMarginRate) },
    ...option.rates.percentageDeductions.map((component) => ({ key: `rate-${component.code}`, label: component.name, value: formatRate(component.rate) }))
  ];
  return <Card className={`pricing-option ${option.recommended ? 'is-recommended' : ''}`}>
    <div className="pricing-option-head"><span>{String(rank).padStart(2,'0')}</span><div><Space wrap><Title level={4}>{option.shipping.serviceName}</Title>{option.recommended && <Tag color="green">推荐最低售价</Tag>}<Tag>{option.shipping.channel}</Tag></Space><Text type="secondary">{result.pricingTemplate.platformName} · 定价 V{result.pricingTemplate.versionNo} · 计费重 {option.shipping.chargeableWeightKg}kg</Text></div><div className="pricing-primary"><small>目标销售价</small><strong>{option.amounts.targetSale.saleCurrency.displayValue}</strong><em>{saleCode}</em></div></div>
    <div className="price-ladder">
      <PriceStep label={<BreakdownPopover label="固定成本" title="固定成本组成" rows={fixedCostRows} total={{ label: '固定成本合计', value: option.costs.totalFixedCost.displayValue, unit: option.costs.totalFixedCost.currencyCode }} />} copyLabel="固定成本" cost={option.costs.totalFixedCost.displayValue} costCode={costCode} note={{ label: '含运费', value: option.costs.crossBorderFreight.displayValue, unit: costCode === 'CNY' ? '元' : costCode }} />
      <i>→</i><PriceStep label="目标售价" copyLabel="目标售价" cost={option.amounts.targetSale.costCurrency.displayValue} sale={option.amounts.targetSale.saleCurrency.displayValue} costCode={costCode} saleCode={saleCode} accent />
      <i>→</i><PriceStep label="上架价" copyLabel="上架价" cost={option.amounts.listing.costCurrency.displayValue} sale={option.amounts.listing.saleCurrency.displayValue} costCode={costCode} saleCode={saleCode} />
      <i>→</i><PriceStep label="划线价" copyLabel="划线价" cost={option.amounts.strike.costCurrency.displayValue} sale={option.amounts.strike.saleCurrency.displayValue} costCode={costCode} saleCode={saleCode} />
    </div>
    <div className="pricing-option-foot"><BreakdownPopover label={`总比例成本 ${formatRate(option.rates.totalRate)}`} title="总比例成本组成" rows={rateRows} total={{ label: '总比例成本合计', value: formatRate(option.rates.totalRate) }} /><code>{String((option.shipping as any).matchedRuleId)}</code></div>
  </Card>;
}

type BreakdownRow = { key: string; label: string; value: string; unit?: string };

function BreakdownPopover({ label, title, rows, total }: { label: string; title: string; rows: BreakdownRow[]; total: Omit<BreakdownRow, 'key'> }) {
  const content = <div className="pricing-breakdown-list">
    {rows.map((row) => <div className="pricing-breakdown-row" key={row.key}><span>{row.label}</span><strong>{row.value}{row.unit && <em>{row.unit}</em>}</strong></div>)}
    <div className="pricing-breakdown-row is-total"><span>{total.label}</span><strong>{total.value}{total.unit && <em>{total.unit}</em>}</strong></div>
  </div>;
  return <Popover placement="topLeft" trigger={['hover', 'focus', 'click']} classNames={{ root: 'pricing-breakdown-popover' }} title={<span className="pricing-breakdown-title">{title}</span>} content={content}>
    <button type="button" className="pricing-breakdown-trigger" aria-label={`查看${title}`}><span>{label}</span><InfoCircleOutlined aria-hidden="true" /></button>
  </Popover>;
}

function PriceStep({ label, copyLabel, cost, sale, costCode, saleCode, note, accent }: { label: React.ReactNode; copyLabel: string; cost: string; sale?: string; costCode: string; saleCode?: string; note?: { label: string; value: string; unit: string }; accent?: boolean }) {
  return <div className={`price-step ${accent ? 'accent' : ''}`}><small>{label}</small><strong><span className="copy-value-inline"><CopyValueButton label={`${copyLabel} ${costCode}`} value={cost} /><span>{cost}<em>{costCode}</em></span></span></strong>{sale && <b><span className="copy-value-inline"><CopyValueButton label={`${copyLabel} ${saleCode}`} value={sale} /><span>{sale}<em>{saleCode}</em></span></span></b>}{note && <span className="copy-value-inline price-step-note"><CopyValueButton label={`${note.label} ${note.unit}`} value={note.value} /><span>{note.label} {note.value} {note.unit}</span></span>}</div>;
}

function formatRate(value: string) {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(Number(value) * 100)}%`;
}

function BatchPricingCalculator({ pricingTemplateId, shippingTemplateIds, destinationOptions, destinationLoading }: { pricingTemplateId?: string; shippingTemplateIds: string[]; destinationOptions: CountrySelectOption[]; destinationLoading: boolean }) {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [result, setResult] = useState<PricingBatchResult>();
  const calculate = useMutation({ mutationFn: api.calculatePricingBatch, onSuccess: setResult, onError: showError });
  useEffect(() => {
    if (destinationLoading || !shippingTemplateIds.length) return;
    const supportedCodes = new Set(destinationOptions.map((option) => option.value));
    const fallback = destinationOptions[0]?.value;
    setRows((items) => items.map((item) => supportedCodes.has(item.destinationCountryCode || '') ? item : { ...item, destinationCountryCode: fallback }));
  }, [destinationLoading, destinationOptions, shippingTemplateIds.length]);
  const run = () => {
    if (!pricingTemplateId || !shippingTemplateIds.length) return message.warning('请先选择定价模板和运费模板');
    if (!rows.length) return message.warning('请先导入或添加商品');
    if (destinationOptions.length && rows.some((item) => !item.destinationCountryCode)) return message.warning('请为每行商品选择目的国');
    calculate.mutate({ pricingTemplateId, shippingTemplateIds, items: rows.map(({ key: _key, ...item }) => item) });
  };
  const importFile = async (file: File) => {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]!]!;
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      const imported = records.slice(0, 500).map((record, index) => {
        const item = rowFromRecord(record, index);
        return { key: crypto.randomUUID(), ...item, destinationCountryCode: item.destinationCountryCode || destinationOptions[0]?.value };
      });
      if (destinationOptions.length) {
        const supportedCodes = new Set(destinationOptions.map((option) => option.value));
        const unsupportedIndex = imported.findIndex((item) => item.destinationCountryCode && !supportedCodes.has(item.destinationCountryCode));
        if (unsupportedIndex >= 0) throw new Error(`第 ${unsupportedIndex + 2} 行目的国不受当前所选运费模板支持`);
      }
      setRows(imported);
      setResult(undefined);
      message.success(`已导入 ${Math.min(records.length, 500)} 行`);
    } catch (error) { showError(error as Error); }
    return false;
  };
  const columns = [
    { title: 'SKU', dataIndex: 'sku', width: 130 }, { title: '产品名', dataIndex: 'productName', width: 190 },
    ...([['purchaseCost','采购价'],['domesticFreight','国内快递'],['actualWeightGrams','重量g'],['lengthCm','长cm'],['widthCm','宽cm'],['heightCm','高cm']] as const).map(([field,title]) => ({ title, dataIndex: field, width: 110, render: (value: string, row: BatchRow) => <InputNumber stringMode value={value} min="0" onChange={(next) => setRows((items) => items.map((item) => item.key === row.key ? { ...item, [field]: String(next ?? '') } : item))} /> })),
    ...(destinationOptions.length ? [{ title: '目的国', dataIndex: 'destinationCountryCode', width: 170, render: (value: string | undefined, row: BatchRow) => <Select showSearch optionFilterProp="label" loading={destinationLoading} value={value} placeholder="请选择目的国" options={destinationOptions} onChange={(next) => setRows((items) => items.map((item) => item.key === row.key ? { ...item, destinationCountryCode: next } : item))} style={{ width: '100%' }} /> }] : []),
    { title: '', width: 46, fixed: 'right' as const, render: (_: unknown, row: BatchRow) => <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setRows((items) => items.filter((item) => item.key !== row.key))} /> }
  ];
  return <div className="batch-pricing-stack">
    <Card><Flex justify="space-between" gap={12} wrap="wrap"><Space wrap><Upload accept=".xlsx,.xls,.csv" showUploadList={false} beforeUpload={(file) => { void importFile(file); return false; }}><Button icon={<UploadOutlined />}>导入 Excel/CSV</Button></Upload><Button icon={<DownloadOutlined />} onClick={() => void downloadImportTemplate()}>下载导入模板</Button><Button icon={<PlusOutlined />} onClick={() => setRows((items) => [...items, blankRow(destinationOptions[0]?.value)])}>添加一行</Button></Space><Button type="primary" icon={<RocketOutlined />} loading={calculate.isPending} onClick={run}>批量计算</Button></Flex></Card>
    <Card bodyStyle={{ padding: 0 }}><Table rowKey="key" size="small" scroll={{ x: destinationOptions.length ? 1270 : 1100 }} pagination={{ pageSize: 20 }} dataSource={rows} columns={columns} locale={{ emptyText: '导入 Excel/CSV，或手动添加商品行' }} /></Card>
    {result && <Card className="batch-result-summary"><Row gutter={16}><Col span={8}><Statistic title="总行数" value={result.total} /></Col><Col span={8}><Statistic title="成功" value={result.succeeded} valueStyle={{ color: '#24815f' }} /></Col><Col span={8}><Statistic title="失败" value={result.failed} valueStyle={{ color: result.failed ? '#d64545' : undefined }} /></Col></Row><Button icon={<DownloadOutlined />} onClick={() => void exportBatch(result, rows)}>导出计算结果</Button></Card>}
    {result && <Card bodyStyle={{ padding: 0 }}><Table size="small" pagination={{ pageSize: 20 }} rowKey="index" dataSource={result.results} columns={[{ title: '行', dataIndex: 'index', render: (value) => value + 2 },{ title: 'SKU', dataIndex: 'sku' },{ title: '状态', render: (_, item) => item.ok ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag> },{ title: '推荐渠道', render: (_, item) => item.result?.options.find((option) => option.recommended)?.shipping.serviceName || item.error?.message || '无可用渠道' },{ title: '目标售价', render: (_, item) => { const amount = item.result?.options.find((option) => option.recommended)?.amounts.targetSale.saleCurrency; return amount ? `${amount.displayValue} ${amount.currencyCode}` : '-' } }]} /></Card>}
  </div>;
}

export function PricingTemplatesPage() {
  const client = useQueryClient();
  const templates = useQuery({ queryKey: ['pricing-templates'], queryFn: api.pricingTemplates, retry: false });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => api.platforms(true), retry: false });
  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.currencies(true), retry: false });
  const [editingId, setEditingId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<PricingTemplateSummary>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [cloneForm] = Form.useForm();
  const invalidate = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['pricing-templates'] }), client.invalidateQueries({ queryKey: ['platforms'] }), client.invalidateQueries({ queryKey: ['currencies'] })]); };
  const create = useMutation({ mutationFn: api.createPricingTemplate, onSuccess: async ({ template }) => { message.success('定价模板草稿已创建'); setCreateOpen(false); createForm.resetFields(); await invalidate(); setEditingId(template.id); }, onError: showError });
  const clone = useMutation({ mutationFn: ({ id, input }: { id: string; input: { platformCode: string; name: string } }) => api.clonePricingTemplate(id, input), onSuccess: async ({ template }) => { message.success('模板已复制为新草稿'); setCloneSource(undefined); cloneForm.resetFields(); await invalidate(); setEditingId(template.id); }, onError: showError });
  const archive = useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => api.updatePricingTemplate(id, { active }), onSuccess: invalidate, onError: showError });
  const submitCreate = async () => {
    const value = await createForm.validateFields();
    create.mutate({ name: value.name, platformCode: value.platformCode, definition: defaultDefinition(value.costCurrencyCode, value.saleCurrencyCode, String(value.exchangeRate)) });
  };
  const submitClone = async () => {
    if (!cloneSource) return;
    const value = await cloneForm.validateFields();
    clone.mutate({ id: cloneSource.id, input: { platformCode: value.platformCode, name: value.name } });
  };
  return <div className="page-stack pricing-template-page">
    <PricingPageTitle eyebrow="PRICING POLICY REGISTRY" title="定价模板" description="平台、币种、汇率和成本组件都进入可追溯的发布版本。" extra={<Space><Button icon={<DatabaseOutlined />} onClick={() => setCatalogOpen(true)}>平台与币种</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建模板</Button></Space>} />
    <Card bodyStyle={{ padding: 0 }}><Table<PricingTemplateSummary> rowKey="id" pagination={false} dataSource={templates.data?.items || []} loading={templates.isLoading} columns={[{ title: '模板', render: (_, item) => <div className="template-name-cell"><strong>{item.name}</strong><span>{item.platformCode} · {item.platformName}</span></div> },{ title: '线上版本', width: 140, render: (_, item) => item.publishedVersion ? <Tag color="green">V{item.publishedVersion.versionNo} 已发布</Tag> : <Tag>未发布</Tag> },{ title: '草稿', width: 120, render: (_, item) => item.draftVersion ? <Tag color="gold">V{item.draftVersion.versionNo}</Tag> : '-' },{ title: '启用', width: 90, render: (_, item) => <Switch checked={item.active} onChange={(active) => archive.mutate({ id: item.id, active })} /> },{ title: '操作', width: 180, render: (_, item) => <Space><Button onClick={() => setEditingId(item.id)}>编辑</Button><Button icon={<CopyOutlined />} onClick={() => { setCloneSource(item); cloneForm.setFieldsValue({ name: `${item.name} - 副本`, platformCode: item.platformCode }); }}>复制</Button></Space> }]} /></Card>
    <Modal open={createOpen} title="新建定价模板" okText="创建草稿" confirmLoading={create.isPending} onCancel={() => setCreateOpen(false)} onOk={() => void submitCreate()}><Form form={createForm} layout="vertical" initialValues={{ costCurrencyCode: 'CNY', saleCurrencyCode: 'USD', exchangeRate: 0.14 }}><Form.Item label="平台" name="platformCode" rules={[{ required: true }]}><Select options={(platforms.data?.items || []).filter((item) => item.active).map(platformOption)} /></Form.Item><Form.Item label="模板名称" name="name" rules={[{ required: true }]}><Input placeholder="例如 Amazon US 标准定价" /></Form.Item><Row gutter={10}><Col span={8}><Form.Item label="成本币种" name="costCurrencyCode" rules={[{ required: true }]}><Select options={(currencies.data?.items || []).filter((item) => item.active).map(currencyOption)} /></Form.Item></Col><Col span={8}><Form.Item label="销售币种" name="saleCurrencyCode" rules={[{ required: true }]}><Select options={(currencies.data?.items || []).filter((item) => item.active).map(currencyOption)} /></Form.Item></Col><Col span={8}><Form.Item label="换算汇率" name="exchangeRate" rules={[{ required: true }]}><InputNumber stringMode min={0.00000001} /></Form.Item></Col></Row></Form></Modal>
    <Modal open={Boolean(cloneSource)} title={`复制模板 · ${cloneSource?.name || ''}`} okText="复制为草稿" confirmLoading={clone.isPending} onCancel={() => setCloneSource(undefined)} onOk={() => void submitClone()}><Form form={cloneForm} layout="vertical"><Form.Item label="目标平台" name="platformCode" rules={[{ required: true }]}><Select options={(platforms.data?.items || []).filter((item) => item.active).map(platformOption)} /></Form.Item><Form.Item label="新模板名称" name="name" rules={[{ required: true }]}><Input /></Form.Item><Alert type="info" showIcon message="复制将保留当前模板的成本组件与费率，并创建一个独立草稿。" /></Form></Modal>
    <PricingTemplateDrawer id={editingId} currencies={currencies.data?.items || []} onClose={() => setEditingId(undefined)} onSaved={invalidate} />
    <CatalogDrawer open={catalogOpen} platforms={platforms.data?.items || []} currencies={currencies.data?.items || []} onClose={() => setCatalogOpen(false)} onSaved={invalidate} />
  </div>;
}

function PricingTemplateDrawer({ id, currencies, onClose, onSaved }: { id?: string; currencies: CurrencyCatalogItem[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const detail = useQuery({ queryKey: ['pricing-template', id], queryFn: () => api.pricingTemplate(id!), enabled: Boolean(id), retry: false });
  const [definition, setDefinition] = useState<PricingTemplateDefinitionV1>();
  useEffect(() => { const template = detail.data?.template; if (template) setDefinition(structuredClone(template.versions.find((v) => v.status === 'DRAFT')?.definition || template.versions.find((v) => v.status === 'PUBLISHED')?.definition)); }, [detail.data]);
  const save = useMutation({ mutationFn: () => api.savePricingDraft(id!, definition!), onSuccess: async () => { message.success('定价草稿已保存'); await detail.refetch(); await onSaved(); }, onError: showError });
  const publish = useMutation({ mutationFn: () => api.publishPricingTemplate(id!), onSuccess: async () => { message.success('定价模板已发布'); await detail.refetch(); await onSaved(); }, onError: showError });
  const template = detail.data?.template;
  return <Drawer open={Boolean(id)} onClose={onClose} width={760} title={template?.name || '定价模板'} extra={<Space><Button icon={<SaveOutlined />} disabled={!definition} loading={save.isPending} onClick={() => save.mutate()}>保存草稿</Button><Popconfirm title="发布后将归档当前线上版本，确认继续？" onConfirm={() => publish.mutate()}><Button type="primary" icon={<RocketOutlined />} loading={publish.isPending}>发布</Button></Popconfirm></Space>}>
    {definition && <PricingDefinitionEditor value={definition} currencies={currencies} onChange={setDefinition} />}
    {template && <><Divider>版本历史</Divider><Space wrap>{template.versions.map((version) => <Tag color={version.status === 'PUBLISHED' ? 'green' : version.status === 'DRAFT' ? 'gold' : 'default'} key={version.id}>V{version.versionNo} · {version.status}</Tag>)}</Space></>}
  </Drawer>;
}

function PricingDefinitionEditor({ value, currencies, onChange }: { value: PricingTemplateDefinitionV1; currencies: CurrencyCatalogItem[]; onChange: (value: PricingTemplateDefinitionV1) => void }) {
  const patch = (next: Partial<PricingTemplateDefinitionV1>) => onChange({ ...value, ...next });
  return <div className="pricing-definition-editor">
    <Row gutter={10}><Col span={8}><Field label="成本币种"><Select value={value.costCurrencyCode} options={currencies.map(currencyOption)} onChange={(costCurrencyCode) => patch({ costCurrencyCode })} /></Field></Col><Col span={8}><Field label="销售币种"><Select value={value.saleCurrencyCode} options={currencies.map(currencyOption)} onChange={(saleCurrencyCode) => patch({ saleCurrencyCode })} /></Field></Col><Col span={8}><DecimalEditor label="汇率（销售/成本）" value={value.saleCurrencyPerCostCurrency} onChange={(saleCurrencyPerCostCurrency) => patch({ saleCurrencyPerCostCurrency })} /></Col></Row>
    <Row gutter={10}><Col span={8}><RateEditor label="店铺折扣率" value={value.storeDiscountRate} onChange={(storeDiscountRate) => patch({ storeDiscountRate })} /></Col><Col span={8}><DecimalEditor label="划线价倍数" value={value.strikePriceMultiplier} onChange={(strikePriceMultiplier) => patch({ strikePriceMultiplier })} /></Col><Col span={8}><RateEditor label="默认佣金率" value={value.defaultCommissionRate} onChange={(defaultCommissionRate) => patch({ defaultCommissionRate })} /></Col></Row>
    <Row gutter={10}><Col span={8}><RateEditor label="默认目标毛利率" value={value.defaultTargetMarginRate} onChange={(defaultTargetMarginRate) => patch({ defaultTargetMarginRate })} /></Col><Col span={8}><Field label="汇率日期"><Input type="date" value={value.exchangeRateAsOf} onChange={(event) => patch({ exchangeRateAsOf: event.target.value || undefined })} /></Field></Col><Col span={8}><Field label="汇率来源"><Input value={value.exchangeRateSourceNote} onChange={(event) => patch({ exchangeRateSourceNote: event.target.value })} /></Field></Col></Row>
    <ComponentEditor title="每单固定成本（人民币）" kind="fixed" items={value.fixedCosts} onChange={(fixedCosts) => patch({ fixedCosts })} />
    <ComponentEditor title="售价比例成本" kind="rate" items={value.percentageDeductions} onChange={(percentageDeductions) => patch({ percentageDeductions })} />
  </div>;
}

function ComponentEditor({ title, kind, items, onChange }: { title: string; kind: 'fixed'|'rate'; items: any[]; onChange: (items: any[]) => void }) {
  return <Card size="small" title={title} extra={<Button type="text" icon={<PlusOutlined />} onClick={() => onChange([...items, kind === 'fixed' ? { code: `FIXED_${items.length + 1}`, name: '新固定成本', amount: '0', enabled: true } : { code: `RATE_${items.length + 1}`, name: '新比例成本', rate: '0', enabled: true }])}>添加</Button>}><div className="pricing-component-list">{items.map((item, index) => <div className="pricing-component-row" key={`${kind}-${index}`}><Input value={item.code} onChange={(event) => onChange(items.map((entry, i) => i === index ? { ...entry, code: event.target.value.toUpperCase() } : entry))} /><Input value={item.name} onChange={(event) => onChange(items.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry))} />{kind === 'fixed' ? <InputNumber stringMode min={0} value={item.amount} addonAfter="元" onChange={(value) => onChange(items.map((entry, i) => i === index ? { ...entry, amount: String(value ?? '0') } : entry))} /> : <InputNumber stringMode min="0" max="99.9999" value={rateToPercent(item.rate)} addonAfter="%" onChange={(value) => onChange(items.map((entry, i) => i === index ? { ...entry, rate: percentToRate(value) } : entry))} />}<Switch checked={item.enabled} onChange={(enabled) => onChange(items.map((entry, i) => i === index ? { ...entry, enabled } : entry))} /><Button type="text" danger icon={<DeleteOutlined />} onClick={() => onChange(items.filter((_, i) => i !== index))} /></div>)}</div></Card>;
}

function CatalogDrawer({ open, platforms, currencies, onClose, onSaved }: { open: boolean; platforms: CommercePlatform[]; currencies: CurrencyCatalogItem[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [platformForm] = Form.useForm(); const [currencyForm] = Form.useForm();
  const addPlatform = useMutation({ mutationFn: api.createPlatform, onSuccess: async () => { platformForm.resetFields(); message.success('平台已添加'); await onSaved(); }, onError: showError });
  const addCurrency = useMutation({ mutationFn: api.createCurrency, onSuccess: async () => { currencyForm.resetFields(); message.success('币种已添加'); await onSaved(); }, onError: showError });
  const updatePlatform = useMutation({ mutationFn: ({ code, active }: { code: string; active: boolean }) => api.updatePlatform(code, { active }), onSuccess: onSaved, onError: showError });
  const updateCurrency = useMutation({ mutationFn: ({ code, active }: { code: string; active: boolean }) => api.updateCurrency(code, { active }), onSuccess: onSaved, onError: showError });
  return <Drawer open={open} onClose={onClose} width={720} title="平台与币种"><Tabs items={[{ key: 'platforms', label: '平台', children: <><Form form={platformForm} layout="inline" onFinish={(value) => addPlatform.mutate(value)}><Form.Item name="code" rules={[{ required: true }]}><Input placeholder="平台代码" /></Form.Item><Form.Item name="displayName" rules={[{ required: true }]}><Input placeholder="平台名称" /></Form.Item><Button htmlType="submit" type="primary">添加平台</Button></Form><Divider /><Table size="small" pagination={false} rowKey="code" dataSource={platforms} columns={[{ title: '代码', dataIndex: 'code' },{ title: '平台', dataIndex: 'displayName' },{ title: '启用', width: 90, render: (_, item) => <Switch checked={item.active} loading={updatePlatform.isPending} onChange={(active) => updatePlatform.mutate({ code: item.code, active })} /> }]} /></> },{ key: 'currencies', label: '币种', children: <><Form form={currencyForm} layout="inline" onFinish={(value) => addCurrency.mutate({ ...value, decimalPlaces: Number(value.decimalPlaces) })}><Form.Item name="code" rules={[{ required: true }]}><Input placeholder="USD" maxLength={3} /></Form.Item><Form.Item name="displayName" rules={[{ required: true }]}><Input placeholder="币种名称" /></Form.Item><Form.Item name="symbol" rules={[{ required: true }]}><Input placeholder="$" style={{ width: 70 }} /></Form.Item><Form.Item name="decimalPlaces" rules={[{ required: true }]}><InputNumber min={0} max={6} placeholder="小数位" /></Form.Item><Button htmlType="submit" type="primary">添加币种</Button></Form><Divider /><Table size="small" pagination={false} rowKey="code" dataSource={currencies} columns={[{ title: '代码', dataIndex: 'code' },{ title: '币种', dataIndex: 'displayName' },{ title: '符号', dataIndex: 'symbol' },{ title: '小数位', dataIndex: 'decimalPlaces' },{ title: '启用', width: 90, render: (_, item) => <Switch checked={item.active} loading={updateCurrency.isPending} onChange={(active) => updateCurrency.mutate({ code: item.code, active })} /> }]} /></> }]} /></Drawer>;
}

function MoneyInput({ label, name, required, addon }: { label: string; name: string; required?: boolean; addon?: string }) { return <Form.Item label={label} name={name} rules={required ? [{ required: true }] : undefined}><InputNumber stringMode min={0} addonAfter={addon} style={{ width: '100%' }} /></Form.Item>; }
function RateInput({ label, name, required = false, disabled = false }: { label: string; name: string; required?: boolean; disabled?: boolean }) { return <Form.Item label={label} name={name} rules={required ? [{ required: true, message: `请输入${label}` }] : undefined} getValueFromEvent={(value) => value === null ? undefined : String(Number(value) / 100)} getValueProps={(value) => ({ value: value === undefined ? undefined : Number(value) * 100 })}><InputNumber min={0} max={99.999} disabled={disabled} addonAfter="%" style={{ width: '100%' }} /></Form.Item>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="pricing-field"><label>{label}</label>{children}</div>; }
function DecimalEditor({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <Field label={label}><InputNumber stringMode min="0" value={value} onChange={(next) => onChange(String(next ?? '0'))} /></Field>; }
function RateEditor({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <Field label={label}><InputNumber min={0} max={99.999} value={Number(value) * 100} addonAfter="%" onChange={(next) => onChange(String(Number(next || 0) / 100))} /></Field>; }
function rateToPercent(value: string | number | undefined) { return String(Number(value || 0) * 100); }
function percentToRate(value: string | number | null) { return String(Number(value || 0) / 100); }
function normalizeItem(value: Record<string, any>): PricingCalculationItem {
  const rawDestination = value.destinationCountryCode === undefined || value.destinationCountryCode === null ? '' : String(value.destinationCountryCode).trim();
  const destinationCountryCode = rawDestination ? countryCodeFromChineseNameOrCode(rawDestination) : undefined;
  if (rawDestination && !destinationCountryCode) throw new Error(`无法识别目的国“${rawDestination}”，请选择标准中文国家名`);
  const hasCommissionRate = value.commissionRate !== undefined && value.commissionRate !== null && value.commissionRate !== '';
  const hasTargetMarginRate = value.targetMarginRate !== undefined && value.targetMarginRate !== null && value.targetMarginRate !== '';
  return { sku: String(value.sku), productName: String(value.productName), purchaseCost: String(value.purchaseCost), domesticFreight: String(value.domesticFreight ?? 0), actualWeightGrams: String(value.actualWeightGrams), lengthCm: String(value.lengthCm), widthCm: String(value.widthCm), heightCm: String(value.heightCm), ...(destinationCountryCode ? { destinationCountryCode } : {}), ...(hasCommissionRate ? { commissionRate: String(value.commissionRate) } : {}), ...(hasTargetMarginRate ? { targetMarginRate: String(value.targetMarginRate) } : {}) };
}
function defaultDefinition(costCurrencyCode: string, saleCurrencyCode: string, rate: string): PricingTemplateDefinitionV1 { return { schemaVersion: '1', costCurrencyCode, saleCurrencyCode, saleCurrencyPerCostCurrency: costCurrencyCode === saleCurrencyCode ? '1' : rate, storeDiscountRate: '0', strikePriceMultiplier: '1', defaultCommissionRate: '0', defaultTargetMarginRate: '0.3', fixedCosts: [], percentageDeductions: [] }; }
function platformOption(item: CommercePlatform) { return { value: item.code, label: `${item.code} · ${item.displayName}` }; }
function currencyOption(item: CurrencyCatalogItem) { return { value: item.code, label: `${item.code} · ${item.displayName}` }; }
function blankRow(destinationCountryCode?: string): BatchRow { return { key: crypto.randomUUID(), sku: `SKU-${Date.now()}`, productName: '新商品', purchaseCost: '0', domesticFreight: '0', actualWeightGrams: '100', lengthCm: '10', widthCm: '10', heightCm: '10', ...(destinationCountryCode ? { destinationCountryCode } : {}) }; }
function rowFromRecord(record: Record<string, unknown>, index: number): PricingCalculationItem {
  const get = (...keys: string[]) => keys.map((key) => record[key]).find((value) => value !== undefined && value !== '') ?? '';
  try {
    return normalizeItem({ sku: get('SKU','sku') || `ROW-${index + 2}`, productName: get('产品名','productName') || `第${index + 2}行商品`, purchaseCost: get('采购价','purchaseCost'), domesticFreight: get('国内快递费','domesticFreight') || 0, actualWeightGrams: get('重量(g)','重量','actualWeightGrams'), lengthCm: get('长(cm)','长','lengthCm'), widthCm: get('宽(cm)','宽','widthCm'), heightCm: get('高(cm)','高','heightCm'), destinationCountryCode: get('目的国','destinationCountryCode'), commissionRate: percentFromImport(get('佣金率','commissionRate')), targetMarginRate: percentFromImport(get('目标毛利率','targetMarginRate')) });
  } catch (error) {
    throw new Error(`第 ${index + 2} 行：${(error as Error).message}`);
  }
}
function percentFromImport(value: unknown) { if (value === '' || value === undefined) return undefined; const number = Number(String(value).replace('%','')); return String(number > 1 ? number / 100 : number); }
async function downloadImportTemplate() {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.json_to_sheet([{ SKU: '0000001', 产品名: '示例商品', 采购价: 34.6, 国内快递费: 0, '重量(g)': 550, '长(cm)': 10, '宽(cm)': 10, '高(cm)': 10, 目的国: '白俄罗斯', 佣金率: '15%', 目标毛利率: '30%' }]);
  const countries = XLSX.utils.json_to_sheet(allChineseCountryOptions.map((country) => ({ 国家中文名: country.label, 国家代码: country.value })));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '商品输入');
  XLSX.utils.book_append_sheet(book, countries, '国家字典');
  XLSX.writeFile(book, '跨境电商售价计算-导入模板.xlsx');
}
async function exportBatch(result: PricingBatchResult, inputRows: BatchRow[]) {
  const XLSX = await import('xlsx');
  const rows = result.results.map((entry) => {
    const input = inputRows[entry.index];
    const calculation = entry.result;
    const option = calculation?.options.find((item) => item.recommended);
    const definition = calculation?.pricingTemplate.definition;
    const shippingVersion = option?.shipping.template as { versionId?: string; versionNo?: number; templateId?: string; templateName?: string } | undefined;
    return {
      行号: entry.index + 2, SKU: input?.sku || entry.sku || '', 产品名: input?.productName || '', 状态: entry.ok ? '成功' : '失败', 错误代码: entry.error?.code || '', 错误信息: entry.error?.message || '',
      采购价: input?.purchaseCost || '', 国内快递费: input?.domesticFreight || '', '重量(g)': input?.actualWeightGrams || '', '长(cm)': input?.lengthCm || '', '宽(cm)': input?.widthCm || '', '高(cm)': input?.heightCm || '', 目的国: chineseCountryNameForExport(input?.destinationCountryCode), 佣金率覆盖: input?.commissionRate || '', 目标毛利率覆盖: input?.targetMarginRate || '',
      平台代码: calculation?.pricingTemplate.platformCode || '', 平台: calculation?.pricingTemplate.platformName || '', 成本币种: definition?.costCurrencyCode || '', 销售币种: definition?.saleCurrencyCode || '', 汇率: definition?.saleCurrencyPerCostCurrency || '', 汇率日期: definition?.exchangeRateAsOf || '', 汇率来源: definition?.exchangeRateSourceNote || '',
      定价模板ID: calculation?.pricingTemplate.templateId || '', 定价模板版本ID: calculation?.pricingTemplate.versionId || '', 定价模板版本号: calculation?.pricingTemplate.versionNo || '', 运费模板ID: shippingVersion?.templateId || '', 运费模板版本ID: shippingVersion?.versionId || '', 运费模板版本号: shippingVersion?.versionNo || '',
      采用渠道: option?.shipping.serviceName || '', 渠道代码: option?.shipping.serviceCode || '', 规则ID: option?.shipping.matchedRuleId || '', 计费重kg: option?.shipping.chargeableWeightKg || '', 运费: option?.costs.crossBorderFreight.displayValue || '',
      固定成本合计: option?.costs.totalFixedCost.displayValue || '', 固定成本拆解: option ? JSON.stringify({ purchase: option.costs.purchase, domesticFreight: option.costs.domesticFreight, crossBorderFreight: option.costs.crossBorderFreight, components: option.costs.fixedComponents }) : '', 比例成本合计: option?.rates.totalRate || '', 比例成本拆解: option ? JSON.stringify(option.rates) : '',
      目标售价成本币种: option?.amounts.targetSale.costCurrency.displayValue || '', 目标售价销售币种: option?.amounts.targetSale.saleCurrency.displayValue || '', 上架价成本币种: option?.amounts.listing.costCurrency.displayValue || '', 上架价销售币种: option?.amounts.listing.saleCurrency.displayValue || '', 划线价成本币种: option?.amounts.strike.costCurrency.displayValue || '', 划线价销售币种: option?.amounts.strike.saleCurrency.displayValue || ''
    };
  });
  const sheet = XLSX.utils.json_to_sheet(rows); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '售价结果'); XLSX.writeFile(book, `跨境电商售价计算结果-${new Date().toISOString().slice(0,10)}.xlsx`);
}
function showError(error: Error) { message.error(error.message); }
