import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  AppError,
  commercePlatformCodeSchema,
  commercePlatformInputSchema,
  currencyCodeSchema,
  currencyInputSchema,
  pricingCalculationItemSchema,
  pricingTemplateDefinitionSchema,
  shippingTemplateDefinitionSchema,
  type CommercePlatformInput,
  type CurrencyInput,
  type PricingCalculationItem,
  type PricingProductQueryInput,
  type PricingProductQueryResult,
  type PricingProductSnapshot,
  type PricingTemplateDefinitionV1
} from '@n8n-media-review/shared';
import { calculateShippingRuleCandidates } from '../services/shipping/calculator.js';
import { calculatePricingOptions } from '../services/pricing/calculator.js';

type SqlRow = Record<string, any>;
export type PricingTemplateInput = { name: string; platformCode: string; definition: PricingTemplateDefinitionV1 };
export type PricingVersionCalculationInput = {
  pricingTemplateId: string;
  pricingTemplateVersionId: string;
  pricingTemplateVersionNo: number;
  shippingTemplateId: string;
  shippingTemplateVersionId: string;
  shippingTemplateVersionNo: number;
  expectedPlatformCode: string;
  expectedCurrencyCode: string;
  shippingServiceCode: string;
  expectedOptionId: string;
  item: PricingCalculationItem;
};

const WB_TEMPLATE_ID = '7c9d6f4a-8f5c-4c3e-9a80-000000000001';
const WB_VERSION_ID = '7c9d6f4a-8f5c-4c3e-9a80-100000000001';
const WB_DEFINITION: PricingTemplateDefinitionV1 = {
  schemaVersion: '1', costCurrencyCode: 'CNY', saleCurrencyCode: 'RUB', saleCurrencyPerCostCurrency: '11',
  exchangeRateAsOf: '2026-07-13', exchangeRateSourceNote: 'WB平台商品售价计算表-V5.0.xlsx / WB平台成本参数',
  storeDiscountRate: '0.5', strikePriceMultiplier: '2', defaultCommissionRate: '0.15', defaultTargetMarginRate: '0.3',
  fixedCosts: [{ code: 'LABEL', name: '代贴单费', amount: '3.5', enabled: true }],
  percentageDeductions: [
    { code: 'ADVERTISING', name: '广告费', rate: '0.1', enabled: true },
    { code: 'REFUND', name: '退款成本', rate: '0.1', enabled: true },
    { code: 'SETTLEMENT', name: '结汇成本', rate: '0.012', enabled: true }
  ]
};

export class PricingRepository {
  private pool?: Pool;
  constructor(private readonly connectionString?: string) {}
  get configured() { return Boolean(this.pool); }

  async initialize() {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      await this.migrate();
      await this.seedCatalogsAndTemplate();
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }
  async close() { await this.pool?.end(); }

  async listPlatforms(includeInactive = true) {
    const result = await this.query<SqlRow>(`SELECT code, display_name, active, created_at, updated_at FROM commerce_platforms ${includeInactive ? '' : 'WHERE active = true'} ORDER BY active DESC, display_name`);
    return result.rows.map(toPlatform);
  }
  async createPlatform(inputValue: unknown) {
    const input = commercePlatformInputSchema.parse(inputValue);
    try {
      const result = await this.query<SqlRow>('INSERT INTO commerce_platforms (code, display_name, active) VALUES ($1,$2,$3) RETURNING *', [input.code, input.displayName, input.active ?? true]);
      return toPlatform(result.rows[0]!);
    } catch (error: any) {
      if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '平台代码已存在', { code: input.code }, 409);
      throw error;
    }
  }
  async updatePlatform(codeValue: string, input: Partial<CommercePlatformInput>) {
    const code = commercePlatformCodeSchema.parse(codeValue);
    if (input.displayName !== undefined && !input.displayName.trim()) throw new AppError('CONFIG_INVALID', '平台名称不能为空');
    const result = await this.query<SqlRow>('UPDATE commerce_platforms SET display_name=COALESCE($2,display_name), active=COALESCE($3,active), updated_at=NOW() WHERE code=$1 RETURNING *', [code, input.displayName?.trim() || null, input.active ?? null]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', '平台不存在', { code }, 404);
    return toPlatform(result.rows[0]);
  }

  async listCurrencies(includeInactive = true) {
    const result = await this.query<SqlRow>(`SELECT code, display_name, symbol, decimal_places, active, created_at, updated_at FROM currencies ${includeInactive ? '' : 'WHERE active = true'} ORDER BY active DESC, code`);
    return result.rows.map(toCurrency);
  }
  async createCurrency(inputValue: unknown) {
    const input = currencyInputSchema.parse(inputValue);
    try {
      const result = await this.query<SqlRow>('INSERT INTO currencies (code,display_name,symbol,decimal_places,active) VALUES ($1,$2,$3,$4,$5) RETURNING *', [input.code, input.displayName, input.symbol, input.decimalPlaces, input.active ?? true]);
      return toCurrency(result.rows[0]!);
    } catch (error: any) {
      if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '币种代码已存在', { code: input.code }, 409);
      throw error;
    }
  }
  async updateCurrency(codeValue: string, input: Partial<CurrencyInput>) {
    const code = currencyCodeSchema.parse(codeValue);
    const result = await this.query<SqlRow>(`UPDATE currencies SET display_name=COALESCE($2,display_name), symbol=COALESCE($3,symbol), decimal_places=COALESCE($4,decimal_places), active=COALESCE($5,active), updated_at=NOW() WHERE code=$1 RETURNING *`, [code, input.displayName?.trim() || null, input.symbol?.trim() || null, input.decimalPlaces ?? null, input.active ?? null]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', '币种不存在', { code }, 404);
    return toCurrency(result.rows[0]);
  }

  async listTemplates() {
    const result = await this.query<SqlRow>(`SELECT t.*, p.display_name AS platform_name,
      d.id AS draft_version_id,d.version_no AS draft_version_no,d.updated_at AS draft_updated_at,
      v.id AS published_version_id,v.version_no AS published_version_no,v.published_at
      FROM pricing_templates t JOIN commerce_platforms p ON p.code=t.platform_code
      LEFT JOIN LATERAL (SELECT id,version_no,updated_at FROM pricing_template_versions WHERE template_id=t.id AND status='DRAFT' LIMIT 1) d ON true
      LEFT JOIN LATERAL (SELECT id,version_no,published_at FROM pricing_template_versions WHERE template_id=t.id AND status='PUBLISHED' LIMIT 1) v ON true
      ORDER BY t.active DESC,p.display_name,t.name`);
    return result.rows.map(toTemplateSummary);
  }
  async getTemplate(id: string) { return this.getTemplateWith(this.requirePool(), id); }

  async createTemplate(inputValue: PricingTemplateInput) {
    const platformCode = commercePlatformCodeSchema.parse(inputValue.platformCode);
    const definition = pricingTemplateDefinitionSchema.parse(inputValue.definition);
    if (!inputValue.name?.trim()) throw new AppError('CONFIG_INVALID', '模板名称不能为空');
    return this.transaction(async (client) => {
      await requireActivePlatform(client, platformCode);
      await requireActiveCurrencies(client, definition.costCurrencyCode, definition.saleCurrencyCode);
      const id = randomUUID();
      try { await client.query('INSERT INTO pricing_templates (id,platform_code,name) VALUES ($1,$2,$3)', [id, platformCode, inputValue.name.trim()]); }
      catch (error: any) { if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '该平台下已有同名启用模板', undefined, 409); throw error; }
      await client.query("INSERT INTO pricing_template_versions (id,template_id,version_no,status,definition) VALUES ($1,$2,1,'DRAFT',$3::jsonb)", [randomUUID(), id, JSON.stringify(definition)]);
      return this.getTemplateWith(client, id);
    });
  }
  async updateTemplate(id: string, input: { name?: string; active?: boolean }) {
    if (input.name !== undefined && !input.name.trim()) throw new AppError('CONFIG_INVALID', '模板名称不能为空');
    const result = await this.query<SqlRow>('UPDATE pricing_templates SET name=COALESCE($2,name),active=COALESCE($3,active),updated_at=NOW() WHERE id=$1 RETURNING id', [id, input.name?.trim() || null, input.active ?? null]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', '定价模板不存在', { id }, 404);
    return this.getTemplate(id);
  }
  async saveDraft(id: string, definitionInput: unknown) {
    const definition = pricingTemplateDefinitionSchema.parse(definitionInput);
    return this.transaction(async (client) => {
      const template = await client.query<SqlRow>('SELECT id,platform_code FROM pricing_templates WHERE id=$1 FOR UPDATE', [id]);
      if (!template.rows[0]) throw new AppError('NOT_FOUND', '定价模板不存在', { id }, 404);
      await requireActiveCurrencies(client, definition.costCurrencyCode, definition.saleCurrencyCode);
      const draft = await client.query<SqlRow>("SELECT id FROM pricing_template_versions WHERE template_id=$1 AND status='DRAFT' FOR UPDATE", [id]);
      if (draft.rows[0]) await client.query('UPDATE pricing_template_versions SET definition=$2::jsonb,updated_at=NOW() WHERE id=$1', [draft.rows[0].id, JSON.stringify(definition)]);
      else {
        const latest = await client.query<SqlRow>('SELECT COALESCE(MAX(version_no),0) version_no FROM pricing_template_versions WHERE template_id=$1', [id]);
        await client.query("INSERT INTO pricing_template_versions (id,template_id,version_no,status,definition) VALUES ($1,$2,$3,'DRAFT',$4::jsonb)", [randomUUID(), id, Number(latest.rows[0]?.version_no || 0) + 1, JSON.stringify(definition)]);
      }
      return this.getTemplateWith(client, id);
    });
  }
  async publishTemplate(id: string) {
    return this.transaction(async (client) => {
      const template = await client.query<SqlRow>('SELECT id,active FROM pricing_templates WHERE id=$1 FOR UPDATE', [id]);
      if (!template.rows[0]) throw new AppError('NOT_FOUND', '定价模板不存在', { id }, 404);
      if (!template.rows[0].active) throw new AppError('CONFIG_INVALID', '已归档模板不能发布', undefined, 409);
      const draft = await client.query<SqlRow>("SELECT id,definition FROM pricing_template_versions WHERE template_id=$1 AND status='DRAFT' FOR UPDATE", [id]);
      if (!draft.rows[0]) throw new AppError('CONFIG_INVALID', '没有可发布的草稿版本', undefined, 409);
      const definition = pricingTemplateDefinitionSchema.parse(draft.rows[0].definition);
      await requireActiveCurrencies(client, definition.costCurrencyCode, definition.saleCurrencyCode);
      await client.query("UPDATE pricing_template_versions SET status='ARCHIVED',updated_at=NOW() WHERE template_id=$1 AND status='PUBLISHED'", [id]);
      await client.query("UPDATE pricing_template_versions SET status='PUBLISHED',published_at=NOW(),updated_at=NOW() WHERE id=$1", [draft.rows[0].id]);
      return this.getTemplateWith(client, id);
    });
  }
  async cloneTemplate(id: string, input: { platformCode: string; name: string }) {
    const platformCode = commercePlatformCodeSchema.parse(input.platformCode);
    return this.transaction(async (client) => {
      await requireActivePlatform(client, platformCode);
      const source = await client.query<SqlRow>(`SELECT v.definition FROM pricing_template_versions v WHERE v.template_id=$1 AND v.status='PUBLISHED'`, [id]);
      if (!source.rows[0]) throw new AppError('CONFIG_INVALID', '只能复制已有发布版本的模板', undefined, 409);
      const definition = pricingTemplateDefinitionSchema.parse(source.rows[0].definition);
      await requireActiveCurrencies(client, definition.costCurrencyCode, definition.saleCurrencyCode);
      const newId = randomUUID();
      await client.query('INSERT INTO pricing_templates (id,platform_code,name) VALUES ($1,$2,$3)', [newId, platformCode, input.name.trim()]);
      await client.query("INSERT INTO pricing_template_versions (id,template_id,version_no,status,definition,source_reference) VALUES ($1,$2,1,'DRAFT',$3::jsonb,$4::jsonb)", [randomUUID(), newId, JSON.stringify(definition), JSON.stringify({ clonedFromTemplateId: id })]);
      return this.getTemplateWith(client, newId);
    });
  }

  async calculate(input: { pricingTemplateId: string; shippingTemplateIds: string[]; item: PricingCalculationItem }) {
    const context = await this.loadCalculationContext(input.pricingTemplateId, input.shippingTemplateIds);
    return this.calculateWithContext(context, input.item);
  }
  async calculateAtVersions(input: PricingVersionCalculationInput) {
    const context = await this.loadCalculationContextAtVersions(input);
    const result = this.calculateWithContext(context, input.item);
    const serviceCode = String(input.shippingServiceCode || '').trim().toUpperCase();
    const expectedOptionId = String(input.expectedOptionId || '').trim();
    const option = result.options.find((candidate) => (
      String(candidate.shipping.serviceCode || '').trim().toUpperCase() === serviceCode
      && candidate.optionId === expectedOptionId
    ));
    if (!option) {
      throw new AppError('NO_ELIGIBLE_PRICING_OPTION', `冻结运费版本中的定价选项 ${expectedOptionId || '未设置'} 不可用`, {
        shippingTemplateId: input.shippingTemplateId,
        shippingTemplateVersionId: input.shippingTemplateVersionId,
        shippingServiceCode: serviceCode,
        expectedOptionId
      }, 409);
    }
    const optionTemplate = option.shipping.template as Record<string, unknown> | undefined;
    if (String(optionTemplate?.templateId || '') !== input.shippingTemplateId
      || String(optionTemplate?.versionId || '') !== input.shippingTemplateVersionId
      || Number(optionTemplate?.versionNo) !== input.shippingTemplateVersionNo) {
      throw new AppError('VERSION_CONFLICT', '定价结果未使用指定的冻结运费版本', {
        expected: {
          templateId: input.shippingTemplateId,
          versionId: input.shippingTemplateVersionId,
          versionNo: input.shippingTemplateVersionNo
        },
        actual: optionTemplate || null
      }, 409);
    }
    const targetCurrency = currencyCodeSchema.parse(input.expectedCurrencyCode);
    const amounts = [option.amounts.listing, option.amounts.strike, option.amounts.targetSale];
    if (amounts.some((amount) => ![amount.costCurrency, amount.saleCurrency]
      .some((entry) => entry.currencyCode === targetCurrency))) {
      throw new AppError('CURRENCY_MISMATCH', `冻结定价结果未包含目标币种 ${targetCurrency}`, { targetCurrency }, 409);
    }
    return result;
  }
  async calculateBatch(input: { pricingTemplateId: string; shippingTemplateIds: string[]; items: unknown[] }) {
    const context = await this.loadCalculationContext(input.pricingTemplateId, input.shippingTemplateIds);
    const results = [];
    for (let index = 0; index < input.items.length; index += 1) {
      const parsed = pricingCalculationItemSchema.safeParse(input.items[index]);
      if (!parsed.success) {
        results.push({ index, sku: (input.items[index] as any)?.sku || null, ok: false, error: { code: 'CONFIG_INVALID', message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；') } });
        continue;
      }
      try { results.push({ index, sku: parsed.data.sku, ok: true, result: this.calculateWithContext(context, parsed.data) }); }
      catch (error) { const appError = error instanceof AppError ? error : new AppError('CALCULATION_FAILED', error instanceof Error ? error.message : '计算失败'); results.push({ index, sku: parsed.data.sku, ok: false, error: { code: appError.code, message: appError.message } }); }
    }
    return { pricingTemplate: context.pricingContext, total: results.length, succeeded: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length, results, calculatedAt: new Date().toISOString() };
  }

  async calculateProductQuery(input: PricingProductQueryInput, products: PricingProductSnapshot[]): Promise<PricingProductQueryResult> {
    const context = await this.loadCalculationContext(input.pricingTemplateId, input.shippingTemplateIds);
    const selectedServiceCodes = new Set(input.shippingServiceCodes);
    const availableServiceCodes = new Set<string>(context.shipping[0]!.definition.services.map((service: any) => service.code));
    const missingServiceCodes = input.shippingServiceCodes.filter((code) => !availableServiceCodes.has(code));
    if (missingServiceCodes.length) {
      throw new AppError('SHIPPING_SERVICE_NOT_FOUND', '部分服务渠道不属于所选运费模板的已发布版本', { missingServiceCodes }, 400);
    }
    const selectedContext = {
      ...context,
      shipping: context.shipping.map((template) => ({
        ...template,
        definition: { ...template.definition, services: template.definition.services.filter((service: any) => selectedServiceCodes.has(service.code)) }
      }))
    };
    const supportedDestinations = [...new Set(selectedContext.shipping.flatMap((template) => template.definition.services.flatMap((service: any) => service.rules.flatMap((rule: any) => rule.destinationCountryCodes || []))))].sort();
    if (supportedDestinations.length && !input.destinationCountryCode) {
      throw new AppError('DESTINATION_REQUIRED', '所选运费模板包含目的国限制，请选择目的国', { supportedDestinationCountryCodes: supportedDestinations });
    }
    if (input.destinationCountryCode && supportedDestinations.length && !supportedDestinations.includes(input.destinationCountryCode)) {
      throw new AppError('DESTINATION_UNSUPPORTED', '所选运费模板不支持该目的国', { destinationCountryCode: input.destinationCountryCode, supportedDestinationCountryCodes: supportedDestinations });
    }

    const results: PricingProductQueryResult['results'] = products.map((product, index) => {
      try {
        if (product.procurement.currency.toUpperCase() !== context.definition.costCurrencyCode) {
          throw new AppError('PRODUCT_CURRENCY_MISMATCH', `产品采购币种 ${product.procurement.currency} 与定价模板成本币种 ${context.definition.costCurrencyCode} 不一致`, {
            productCurrencyCode: product.procurement.currency,
            pricingCostCurrencyCode: context.definition.costCurrencyCode
          });
        }
        const requiredMeasures = {
          grossWeightGrams: product.procurement.grossWeightGrams,
          lengthCm: product.procurement.lengthCm,
          widthCm: product.procurement.widthCm,
          heightCm: product.procurement.heightCm
        };
        const missingFields = Object.entries(requiredMeasures).filter(([, value]) => !isPositiveDecimal(value)).map(([field]) => field);
        if (missingFields.length) throw new AppError('PRODUCT_COST_INCOMPLETE', '产品缺少有效的重量或包装尺寸，无法计算运费', { missingFields });
        const item: PricingCalculationItem = {
          sku: product.sku,
          productName: product.productName,
          purchaseCost: product.procurement.purchasePrice,
          domesticFreight: product.procurement.courierFee,
          actualWeightGrams: product.procurement.grossWeightGrams!,
          lengthCm: product.procurement.lengthCm!,
          widthCm: product.procurement.widthCm!,
          heightCm: product.procurement.heightCm!,
          ...(input.destinationCountryCode ? { destinationCountryCode: input.destinationCountryCode } : {})
        };
        const result = this.calculateWithContext(selectedContext, item);
        if (!result.options.length) throw new AppError('NO_ELIGIBLE_PRICING_OPTION', '没有符合产品条件、目的国和售价区间的物流渠道');
        return { index, product, ok: true, result };
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError('CALCULATION_FAILED', error instanceof Error ? error.message : '计算失败');
        return { index, product, ok: false, error: { code: appError.code, message: appError.message, details: appError.details } };
      }
    });
    const lookupValue = input.lookup.kind === 'SKU' ? input.lookup.sku : input.lookup.productName;
    return {
      lookup: { kind: input.lookup.kind, value: lookupValue, matchedCount: products.length },
      pricingTemplate: context.pricingContext,
      total: results.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
      calculatedAt: new Date().toISOString()
    };
  }

  private calculateWithContext(context: Awaited<ReturnType<PricingRepository['loadCalculationContext']>>, item: PricingCalculationItem) {
    const freightCandidates = context.shipping.flatMap((template, templateSelectionOrder) => calculateShippingRuleCandidates(template.context, template.definition, item).candidates.map((candidate) => ({ ...candidate, templateSelectionOrder })));
    return calculatePricingOptions(context.pricingContext, context.definition, item, context.currencies, freightCandidates as any);
  }
  private async loadCalculationContext(pricingTemplateId: string, shippingTemplateIds: string[]) {
    const price = await this.query<SqlRow>(`SELECT t.id,t.name,t.platform_code,p.display_name platform_name,v.id version_id,v.version_no,v.definition,
      cc.code cost_code,cc.display_name cost_name,cc.symbol cost_symbol,cc.decimal_places cost_decimals,
      sc.code sale_code,sc.display_name sale_name,sc.symbol sale_symbol,sc.decimal_places sale_decimals
      FROM pricing_templates t JOIN commerce_platforms p ON p.code=t.platform_code
      JOIN pricing_template_versions v ON v.template_id=t.id AND v.status='PUBLISHED'
      JOIN currencies cc ON cc.code=(v.definition->>'costCurrencyCode') JOIN currencies sc ON sc.code=(v.definition->>'saleCurrencyCode')
      WHERE t.id=$1 AND t.active=true`, [pricingTemplateId]);
    const row = price.rows[0];
    if (!row) throw new AppError('NOT_FOUND', '没有找到可用的已发布定价模板', { pricingTemplateId }, 404);
    const definition = pricingTemplateDefinitionSchema.parse(row.definition);
    const shippingRows = await this.query<SqlRow>(`SELECT t.id,t.name,t.platform_code,t.template_type,c.code carrier_code,c.display_name carrier_name,v.id version_id,v.version_no,v.definition
      FROM shipping_templates t JOIN shipping_carriers c ON c.code=t.carrier_code JOIN shipping_template_versions v ON v.template_id=t.id AND v.status='PUBLISHED'
      WHERE t.id=ANY($1::uuid[]) AND t.active=true AND c.active=true`, [shippingTemplateIds]);
    if (shippingRows.rows.length !== new Set(shippingTemplateIds).size) throw new AppError('NOT_FOUND', '部分运费模板不存在、未发布或已停用', undefined, 404);
    for (const shipping of shippingRows.rows) {
      if (shipping.platform_code !== row.platform_code) throw new AppError('PLATFORM_MISMATCH', '定价模板与运费模板所属平台不一致');
      if (shipping.definition.currency !== definition.costCurrencyCode) throw new AppError('CURRENCY_MISMATCH', '运费模板币种必须与定价模板成本币种一致');
      if (shipping.definition.salePriceCurrencyCode && shipping.definition.salePriceCurrencyCode !== definition.saleCurrencyCode) throw new AppError('CURRENCY_MISMATCH', '运费模板售价区间币种必须与定价模板销售币种一致');
    }
    const pricingContext = { templateId: row.id, versionId: row.version_id, versionNo: Number(row.version_no), templateName: row.name, platformCode: row.platform_code, platformName: row.platform_name };
    return {
      pricingContext,
      definition,
      currencies: { cost: { code: row.cost_code, displayName: row.cost_name, symbol: row.cost_symbol, decimalPlaces: Number(row.cost_decimals) }, sale: { code: row.sale_code, displayName: row.sale_name, symbol: row.sale_symbol, decimalPlaces: Number(row.sale_decimals) } },
      shipping: shippingRows.rows.sort((left, right) => shippingTemplateIds.indexOf(left.id) - shippingTemplateIds.indexOf(right.id)).map((shipping) => ({ definition: shipping.definition, context: { templateId: shipping.id, versionId: shipping.version_id, versionNo: Number(shipping.version_no), platformCode: shipping.platform_code, scenarioCode: shipping.template_type, templateType: shipping.template_type, carrierCode: shipping.carrier_code, carrierName: shipping.carrier_name, templateName: shipping.name } }))
    };
  }
  private async loadCalculationContextAtVersions(input: PricingVersionCalculationInput) {
    const platformCode = commercePlatformCodeSchema.parse(input.expectedPlatformCode);
    const targetCurrency = currencyCodeSchema.parse(input.expectedCurrencyCode);
    const serviceCode = String(input.shippingServiceCode || '').trim().toUpperCase();
    const expectedOptionId = String(input.expectedOptionId || '').trim();
    if (!serviceCode || !/^[A-Z0-9_-]+$/.test(serviceCode)) {
      throw new AppError('CONFIG_INVALID', '冻结定价证据的服务渠道代码无效', { shippingServiceCode: input.shippingServiceCode }, 409);
    }
    if (!expectedOptionId) {
      throw new AppError('CONFIG_INVALID', '冻结定价证据缺少 optionId', undefined, 409);
    }
    if (!Number.isInteger(input.pricingTemplateVersionNo) || input.pricingTemplateVersionNo < 1
      || !Number.isInteger(input.shippingTemplateVersionNo) || input.shippingTemplateVersionNo < 1) {
      throw new AppError('CONFIG_INVALID', '冻结定价证据的版本号无效', undefined, 409);
    }
    const price = await this.query<SqlRow>(`SELECT t.id,t.name,t.platform_code,p.display_name platform_name,v.id version_id,v.version_no,v.status,v.definition,
      cc.code cost_code,cc.display_name cost_name,cc.symbol cost_symbol,cc.decimal_places cost_decimals,
      sc.code sale_code,sc.display_name sale_name,sc.symbol sale_symbol,sc.decimal_places sale_decimals
      FROM pricing_templates t JOIN commerce_platforms p ON p.code=t.platform_code
      JOIN pricing_template_versions v ON v.id=$2 AND v.template_id=t.id AND v.status IN ('PUBLISHED','ARCHIVED')
      JOIN currencies cc ON cc.code=(v.definition->>'costCurrencyCode') JOIN currencies sc ON sc.code=(v.definition->>'saleCurrencyCode')
      WHERE t.id=$1`, [input.pricingTemplateId, input.pricingTemplateVersionId]);
    const row = price.rows[0];
    if (!row) {
      throw new AppError('VERSION_CONFLICT', '指定的冻结定价版本不存在、不属于该模板或尚未发布', {
        pricingTemplateId: input.pricingTemplateId,
        pricingTemplateVersionId: input.pricingTemplateVersionId
      }, 409);
    }
    if (Number(row.version_no) !== input.pricingTemplateVersionNo) {
      throw new AppError('VERSION_CONFLICT', '冻结定价版本号与版本 ID 不一致', {
        pricingTemplateVersionId: input.pricingTemplateVersionId,
        expectedVersionNo: input.pricingTemplateVersionNo,
        actualVersionNo: Number(row.version_no)
      }, 409);
    }
    if (String(row.platform_code).toUpperCase() !== platformCode) {
      throw new AppError('PLATFORM_MISMATCH', '冻结定价版本不属于目标平台', {
        expectedPlatformCode: platformCode,
        actualPlatformCode: row.platform_code
      }, 409);
    }
    const definition = pricingTemplateDefinitionSchema.parse(row.definition);
    if (definition.costCurrencyCode !== targetCurrency && definition.saleCurrencyCode !== targetCurrency) {
      throw new AppError('CURRENCY_MISMATCH', '冻结定价版本不支持目标币种', {
        targetCurrency,
        costCurrencyCode: definition.costCurrencyCode,
        saleCurrencyCode: definition.saleCurrencyCode
      }, 409);
    }
    const shippingResult = await this.query<SqlRow>(`SELECT t.id,t.name,t.platform_code,t.template_type,c.code carrier_code,c.display_name carrier_name,
      v.id version_id,v.version_no,v.status,v.definition
      FROM shipping_templates t JOIN shipping_carriers c ON c.code=t.carrier_code
      JOIN shipping_template_versions v ON v.id=$2 AND v.template_id=t.id AND v.status IN ('PUBLISHED','ARCHIVED')
      WHERE t.id=$1`, [input.shippingTemplateId, input.shippingTemplateVersionId]);
    const shipping = shippingResult.rows[0];
    if (!shipping) {
      throw new AppError('VERSION_CONFLICT', '指定的冻结运费版本不存在、不属于该模板或尚未发布', {
        shippingTemplateId: input.shippingTemplateId,
        shippingTemplateVersionId: input.shippingTemplateVersionId
      }, 409);
    }
    if (Number(shipping.version_no) !== input.shippingTemplateVersionNo) {
      throw new AppError('VERSION_CONFLICT', '冻结运费版本号与版本 ID 不一致', {
        shippingTemplateVersionId: input.shippingTemplateVersionId,
        expectedVersionNo: input.shippingTemplateVersionNo,
        actualVersionNo: Number(shipping.version_no)
      }, 409);
    }
    if (String(shipping.platform_code).toUpperCase() !== platformCode
      || String(shipping.platform_code).toUpperCase() !== String(row.platform_code).toUpperCase()) {
      throw new AppError('PLATFORM_MISMATCH', '冻结定价与运费版本必须同属目标平台', {
        expectedPlatformCode: platformCode,
        pricingPlatformCode: row.platform_code,
        shippingPlatformCode: shipping.platform_code
      }, 409);
    }
    const shippingDefinition = shippingTemplateDefinitionSchema.parse(shipping.definition);
    if (shippingDefinition.currency !== definition.costCurrencyCode) {
      throw new AppError('CURRENCY_MISMATCH', '冻结运费版本币种必须与定价版本成本币种一致', {
        shippingCurrencyCode: shippingDefinition.currency,
        pricingCostCurrencyCode: definition.costCurrencyCode
      }, 409);
    }
    if (shippingDefinition.salePriceCurrencyCode
      && shippingDefinition.salePriceCurrencyCode !== definition.saleCurrencyCode) {
      throw new AppError('CURRENCY_MISMATCH', '冻结运费版本售价区间币种必须与定价版本销售币种一致', {
        shippingSalePriceCurrencyCode: shippingDefinition.salePriceCurrencyCode,
        pricingSaleCurrencyCode: definition.saleCurrencyCode
      }, 409);
    }
    if (!shippingDefinition.services.some((service) => service.code === serviceCode)) {
      throw new AppError('SHIPPING_SERVICE_NOT_FOUND', '冻结运费版本不包含指定的服务渠道', {
        shippingTemplateId: input.shippingTemplateId,
        shippingTemplateVersionId: input.shippingTemplateVersionId,
        shippingServiceCode: serviceCode
      }, 409);
    }
    const pricingContext = {
      templateId: row.id,
      versionId: row.version_id,
      versionNo: Number(row.version_no),
      templateName: row.name,
      platformCode: row.platform_code,
      platformName: row.platform_name
    };
    return {
      pricingContext,
      definition,
      currencies: {
        cost: { code: row.cost_code, displayName: row.cost_name, symbol: row.cost_symbol, decimalPlaces: Number(row.cost_decimals) },
        sale: { code: row.sale_code, displayName: row.sale_name, symbol: row.sale_symbol, decimalPlaces: Number(row.sale_decimals) }
      },
      shipping: [{
        definition: shippingDefinition,
        context: {
          templateId: shipping.id,
          versionId: shipping.version_id,
          versionNo: Number(shipping.version_no),
          platformCode: shipping.platform_code,
          scenarioCode: shipping.template_type,
          templateType: shipping.template_type,
          carrierCode: shipping.carrier_code,
          carrierName: shipping.carrier_name,
          templateName: shipping.name
        }
      }]
    };
  }

  private async migrate() {
    await this.query('CREATE TABLE IF NOT EXISTS pricing_schema_migrations (id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const applied = await this.query("SELECT id FROM pricing_schema_migrations WHERE id='001_catalog_pricing'");
    if (applied.rows[0]) return;
    await this.transaction(async (client) => {
      await client.query(`CREATE TABLE IF NOT EXISTS commerce_platforms (code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),display_name TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE TABLE IF NOT EXISTS currencies (code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),display_name TEXT NOT NULL,symbol TEXT NOT NULL,decimal_places INTEGER NOT NULL CHECK (decimal_places BETWEEN 0 AND 6),active BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE TABLE IF NOT EXISTS pricing_templates (id UUID PRIMARY KEY,platform_code TEXT NOT NULL REFERENCES commerce_platforms(code),name TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS pricing_templates_active_name ON pricing_templates (platform_code,LOWER(name)) WHERE active=true');
      await client.query(`CREATE TABLE IF NOT EXISTS pricing_template_versions (id UUID PRIMARY KEY,template_id UUID NOT NULL REFERENCES pricing_templates(id) ON DELETE RESTRICT,version_no INTEGER NOT NULL CHECK(version_no>0),status TEXT NOT NULL CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),definition JSONB NOT NULL,source_reference JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),published_at TIMESTAMPTZ,UNIQUE(template_id,version_no))`);
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS pricing_template_versions_one_draft ON pricing_template_versions(template_id) WHERE status='DRAFT'");
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS pricing_template_versions_one_published ON pricing_template_versions(template_id) WHERE status='PUBLISHED'");
      await client.query('ALTER TABLE shipping_templates DROP CONSTRAINT IF EXISTS shipping_templates_platform_code_check');
      await client.query('ALTER TABLE shipping_templates DROP CONSTRAINT IF EXISTS shipping_templates_template_type_check');
      await client.query("INSERT INTO pricing_schema_migrations(id) VALUES('001_catalog_pricing')");
    });
  }
  private async seedCatalogsAndTemplate() {
    await this.transaction(async (client) => {
      for (const [code, displayName] of [['WB','Wildberries'],['OZON','OZON'],['YANDEX','Yandex Market'],['AMAZON_US','Amazon US'],['SHOPEE','Shopee'],['LAZADA','Lazada']]) await client.query('INSERT INTO commerce_platforms(code,display_name) VALUES($1,$2) ON CONFLICT(code) DO NOTHING', [code, displayName]);
      for (const [code, displayName, symbol, decimals] of [['CNY','人民币','¥',2],['RUB','俄罗斯卢布','₽',2],['USD','美元','$',2],['VND','越南盾','₫',0]]) await client.query('INSERT INTO currencies(code,display_name,symbol,decimal_places) VALUES($1,$2,$3,$4) ON CONFLICT(code) DO NOTHING', [code, displayName, symbol, decimals]);
      await client.query(`UPDATE shipping_template_versions v SET definition=jsonb_set(v.definition,'{salePriceCurrencyCode}','"RUB"'::jsonb,true),updated_at=NOW()
        FROM shipping_templates t WHERE t.id=v.template_id AND t.platform_code='OZON' AND NOT (v.definition ? 'salePriceCurrencyCode')`);
      await client.query("INSERT INTO pricing_templates(id,platform_code,name) VALUES($1,'WB','WB 平台默认定价 V1') ON CONFLICT(id) DO NOTHING", [WB_TEMPLATE_ID]);
      await client.query("INSERT INTO pricing_template_versions(id,template_id,version_no,status,definition,source_reference,published_at) VALUES($1,$2,1,'PUBLISHED',$3::jsonb,$4::jsonb,NOW()) ON CONFLICT(id) DO NOTHING", [WB_VERSION_ID, WB_TEMPLATE_ID, JSON.stringify(WB_DEFINITION), JSON.stringify({ file: 'WB平台商品售价计算表-V5.0.xlsx', sheets: ['WB平台成本参数','WB-上架产品价格表'], version: 'V5.0' })]);
    });
  }
  private async getTemplateWith(client: Pick<Pool,'query'> | PoolClient, id: string) {
    const template = await client.query<SqlRow>('SELECT t.*,p.display_name platform_name FROM pricing_templates t JOIN commerce_platforms p ON p.code=t.platform_code WHERE t.id=$1', [id]);
    if (!template.rows[0]) throw new AppError('NOT_FOUND', '定价模板不存在', { id }, 404);
    const versions = await client.query<SqlRow>('SELECT * FROM pricing_template_versions WHERE template_id=$1 ORDER BY version_no DESC', [id]);
    return { ...toTemplateBase(template.rows[0]), versions: versions.rows.map(toVersion) };
  }
  private query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) { return this.requirePool().query<T>(text, values); }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>) { const client = await this.requirePool().connect(); try { await client.query('BEGIN'); const value = await operation(client); await client.query('COMMIT'); return value; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  private requirePool() { if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', '定价模板尚未配置 PostgreSQL DATABASE_URL', undefined, 503); return this.pool; }
}

async function requireActivePlatform(client: PoolClient, code: string) { const result = await client.query('SELECT code FROM commerce_platforms WHERE code=$1 AND active=true', [code]); if (!result.rows[0]) throw new AppError('CONFIG_INVALID', '平台不存在或已停用', { code }, 404); }
async function requireActiveCurrencies(client: PoolClient, cost: string, sale: string) { const result = await client.query('SELECT code FROM currencies WHERE code=ANY($1::text[]) AND active=true', [[cost,sale]]); if (result.rows.length !== new Set([cost,sale]).size) throw new AppError('CONFIG_INVALID', '成本币种或销售币种不存在或已停用', undefined, 404); }
function toPlatform(row: SqlRow) { return { code: row.code, displayName: row.display_name, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at }; }
function toCurrency(row: SqlRow) { return { code: row.code, displayName: row.display_name, symbol: row.symbol, decimalPlaces: Number(row.decimal_places), active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at }; }
function toTemplateBase(row: SqlRow) { return { id: row.id, name: row.name, platformCode: row.platform_code, platformName: row.platform_name, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at }; }
function toVersion(row: SqlRow) { return { id: row.id, versionNo: Number(row.version_no), status: row.status, definition: row.definition, sourceReference: row.source_reference, createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at }; }
function toTemplateSummary(row: SqlRow) { return { ...toTemplateBase(row), draftVersion: row.draft_version_id ? { id: row.draft_version_id, versionNo: Number(row.draft_version_no), updatedAt: row.draft_updated_at } : undefined, publishedVersion: row.published_version_id ? { id: row.published_version_id, versionNo: Number(row.published_version_no), publishedAt: row.published_at } : undefined }; }
function isPositiveDecimal(value?: string | null) { return Boolean(value && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0); }
