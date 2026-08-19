import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShippingRepository } from './shipping.js';
import { PricingRepository } from './pricing.js';
import { PurchaseRepository } from './purchases.js';

const connectionString = process.env.DATABASE_URL;
const schema = `pricing_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let shipping: ShippingRepository;
let pricing: PricingRepository;
let purchases: PurchaseRepository;

describe.runIf(Boolean(connectionString))('pricing repository PostgreSQL integration', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
    shipping = new ShippingRepository(isolatedUrl.toString());
    pricing = new PricingRepository(isolatedUrl.toString());
    purchases = new PurchaseRepository(isolatedUrl.toString());
    await shipping.initialize();
    await pricing.initialize();
    await purchases.initialize({ code: 'E999', displayName: '测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test', parentOutputDir: 'C:\\pricing-test', enabled: true, isDefault: true });
  });

  afterAll(async () => {
    await Promise.all([shipping?.close(), pricing?.close(), purchases?.close()]);
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('seeds catalogs and reproduces the WB workbook through published versions', async () => {
    expect((await pricing.listPlatforms()).some((item) => item.code === 'AMAZON_US')).toBe(true);
    expect((await pricing.listCurrencies()).find((item) => item.code === 'VND')?.decimalPlaces).toBe(0);
    const priceTemplate = (await pricing.listTemplates()).find((item) => item.platformCode === 'WB')!;
    const shippingTemplate = (await shipping.listTemplates()).find((item) => item.platformCode === 'WB')!;
    const workbookSamples = [
      { sku: '0000001', productName: '雪地靴', purchaseCost: '34.6', domesticFreight: '0', actualWeightGrams: '550', serviceCode: 'CEL_WB_ECONOMY', targetCny: '212.72', targetRub: '2339.94' },
      { sku: '0000002', productName: '劳保鞋', purchaseCost: '62', domesticFreight: '5', actualWeightGrams: '250', serviceCode: 'CEL_WB_ECONOMY', targetCny: '265.98', targetRub: '2925.74' },
      { sku: '0000003', productName: '网面休闲鞋', purchaseCost: '37.3', domesticFreight: '0', actualWeightGrams: '350', serviceCode: 'CEL_WB_EXPRESS', targetCny: '204.14', targetRub: '2245.56' }
    ];
    for (const sample of workbookSamples) {
      const result = await pricing.calculate({ pricingTemplateId: priceTemplate.id, shippingTemplateIds: [shippingTemplate.id], item: { ...sample, lengthCm: '10', widthCm: '10', heightCm: '10' } });
      const workbookChannel = result.options.find((option) => option.shipping.serviceCode === sample.serviceCode)!;
      expect(workbookChannel.amounts.targetSale.costCurrency.displayValue).toBe(sample.targetCny);
      expect(workbookChannel.amounts.targetSale.saleCurrency.displayValue).toBe(sample.targetRub);
      expect(result.pricingTemplate.versionNo).toBe(1);
      expect((workbookChannel.shipping.template as any).versionNo).toBe(shippingTemplate.publishedVersion?.versionNo);
    }
  });

  it('按显式定价/运费版本和 optionId 计算，并拒绝错误版本归属', async () => {
    const priceTemplate = (await pricing.listTemplates()).find((item) => item.platformCode === 'WB')!;
    const shippingTemplate = (await shipping.listTemplates()).find((item) => item.platformCode === 'WB')!;
    const pricingDetail = await pricing.getTemplate(priceTemplate.id);
    const shippingDetail = await shipping.getTemplate(shippingTemplate.id);
    const pricingVersion = pricingDetail.versions.find((version) => version.status === 'PUBLISHED')!;
    const shippingVersion = shippingDetail.versions.find((version) => version.status === 'PUBLISHED')!;
    const item = {
      sku: '0000001', productName: '精确版本商品', purchaseCost: '34.6', domesticFreight: '0',
      actualWeightGrams: '550', lengthCm: '10', widthCm: '10', heightCm: '10'
    };
    const current = await pricing.calculate({
      pricingTemplateId: priceTemplate.id,
      shippingTemplateIds: [shippingTemplate.id],
      item
    });
    const option = current.options[0]!;
    const exact = await pricing.calculateAtVersions({
      pricingTemplateId: priceTemplate.id,
      pricingTemplateVersionId: pricingVersion.id,
      pricingTemplateVersionNo: pricingVersion.versionNo,
      shippingTemplateId: shippingTemplate.id,
      shippingTemplateVersionId: shippingVersion.id,
      shippingTemplateVersionNo: shippingVersion.versionNo,
      expectedPlatformCode: 'WB',
      expectedCurrencyCode: 'CNY',
      shippingServiceCode: String(option.shipping.serviceCode),
      expectedOptionId: option.optionId,
      item
    });
    expect(exact.pricingTemplate).toMatchObject({
      templateId: priceTemplate.id,
      versionId: pricingVersion.id,
      versionNo: pricingVersion.versionNo,
      platformCode: 'WB'
    });
    expect(exact.options.find((candidate) => candidate.optionId === option.optionId)?.amounts)
      .toEqual(option.amounts);

    await expect(pricing.calculateAtVersions({
      pricingTemplateId: randomUUID(),
      pricingTemplateVersionId: pricingVersion.id,
      pricingTemplateVersionNo: pricingVersion.versionNo,
      shippingTemplateId: shippingTemplate.id,
      shippingTemplateVersionId: shippingVersion.id,
      shippingTemplateVersionNo: shippingVersion.versionNo,
      expectedPlatformCode: 'WB',
      expectedCurrencyCode: 'CNY',
      shippingServiceCode: String(option.shipping.serviceCode),
      expectedOptionId: option.optionId,
      item
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
  });

  it('adds a new platform and calculates CNY to USD without code changes', async () => {
    const shippingTemplate = await shipping.createTemplate({ carrierCode: 'CEL', platformCode: 'AMAZON_US', scenarioCode: 'STANDARD', name: 'Amazon US 测试运费' });
    await shipping.saveDraft(shippingTemplate.id, { schemaVersion: '1', currency: 'CNY', services: [{ code: 'AMZ_STANDARD', name: '标准渠道', channel: '标准', sortOrder: 10, rules: [{ id: 'AMZ_STANDARD_RULE', productCategory: '标准件', destinationCountryCodes: [], constraints: { actualWeightKg: { max: '20', includeMin: true, includeMax: true } }, chargeableWeight: { mode: 'ACTUAL', roundingStepKg: '0.1' }, pricing: { ratePerKg: '20', fixedFee: '5', currency: 'CNY' } }] }] });
    await shipping.publishTemplate(shippingTemplate.id);
    const priceTemplate = await pricing.createTemplate({ name: 'Amazon US 标准定价', platformCode: 'AMAZON_US', definition: { schemaVersion: '1', costCurrencyCode: 'CNY', saleCurrencyCode: 'USD', saleCurrencyPerCostCurrency: '0.14', storeDiscountRate: '0', strikePriceMultiplier: '1', defaultCommissionRate: '0.15', defaultTargetMarginRate: '0.3', fixedCosts: [], percentageDeductions: [] } });
    await pricing.publishTemplate(priceTemplate.id);
    const result = await pricing.calculate({ pricingTemplateId: priceTemplate.id, shippingTemplateIds: [shippingTemplate.id], item: { sku: 'A1', productName: 'Amazon 商品', purchaseCost: '50', domesticFreight: '5', actualWeightGrams: '500', lengthCm: '10', widthCm: '10', heightCm: '10' } });
    expect(result.pricingTemplate.platformCode).toBe('AMAZON_US');
    expect(result.options[0]?.amounts.targetSale.saleCurrency.currencyCode).toBe('USD');
  });

  it('售价查询只计算所选运费模板中的服务渠道', async () => {
    const priceTemplate = (await pricing.listTemplates()).find((item) => item.platformCode === 'WB')!;
    const shippingTemplate = (await shipping.listTemplates()).find((item) => item.platformCode === 'WB')!;
    const shippingDetail = await shipping.getTemplate(shippingTemplate.id);
    const published = shippingDetail.versions.find((version) => version.status === 'PUBLISHED')!;
    const allServiceCodes = published.definition.services.map((service) => service.code);
    const product = {
      sku: '7000001', productName: '渠道筛选测试商品', updatedAt: new Date().toISOString(),
      procurement: { id: randomUUID(), versionNo: 1, purchasePrice: '34.6', courierFee: '0', currency: 'CNY', grossWeightGrams: '550', lengthCm: '10', widthCm: '10', heightCm: '10', createdAt: new Date().toISOString() }
    };
    const destinationFor = (codes: string[]) => published.definition.services.filter((service) => codes.includes(service.code)).flatMap((service) => service.rules.flatMap((rule) => rule.destinationCountryCodes))[0];
    const calculate = (codes: string[]) => pricing.calculateProductQuery({
      lookup: { kind: 'SKU', sku: product.sku }, pricingTemplateId: priceTemplate.id, shippingTemplateIds: [shippingTemplate.id], shippingServiceCodes: codes,
      ...(destinationFor(codes) ? { destinationCountryCode: destinationFor(codes) } : {})
    }, [product]);

    const all = await calculate(allServiceCodes);
    const eligibleCodes = [...new Set(all.results[0]!.result!.options.map((option) => String(option.shipping.serviceCode)))];
    expect(eligibleCodes.length).toBeGreaterThan(1);
    const single = await calculate([eligibleCodes[0]!]);
    expect(single.results[0]!.result!.options.every((option) => option.shipping.serviceCode === eligibleCodes[0])).toBe(true);
    const multiple = await calculate(eligibleCodes.slice(0, 2));
    expect(new Set(multiple.results[0]!.result!.options.map((option) => option.shipping.serviceCode))).toEqual(new Set(eligibleCodes.slice(0, 2)));
    expect(multiple.results[0]!.result!.options.filter((option) => option.recommended)).toHaveLength(1);
    await expect(calculate(['NOT_IN_TEMPLATE'])).rejects.toMatchObject({ code: 'SHIPPING_SERVICE_NOT_FOUND' });
  });

  it('按 SKU 精确查询、按产品名关键词包含查询，并始终返回最新采购版本', async () => {
    const base = { purchasePrice: '10', courierFee: '2', currency: 'CNY', grossWeightGrams: '500', lengthCm: '20', widthCm: '10', heightCm: '8' };
    const first = await purchases.createPurchase({ ...base, productName: '布鞋', providerUrl: 'https://example.com/product-1' });
    const second = await purchases.createPurchase({ ...base, productName: '老北京布鞋', purchasePrice: '11', providerUrl: 'https://example.com/product-2' });
    await purchases.createPurchase({ ...base, productName: '帆布休闲鞋', purchasePrice: '12', providerUrl: 'https://example.com/product-3' });
    const special = await purchases.createPurchase({ ...base, productName: '折扣%_布鞋', purchasePrice: '13', providerUrl: 'https://example.com/product-4' });
    const english = await purchases.createPurchase({ ...base, productName: 'Canvas Shoe', purchasePrice: '14', providerUrl: 'https://example.com/product-5' });
    await purchases.updatePurchase(first.sku, { ...base, productName: '布鞋', purchasePrice: '19', providerUrl: 'https://example.com/product-1' });

    const bySku = await purchases.findPricingProducts({ kind: 'SKU', sku: first.sku });
    expect(bySku).toHaveLength(1);
    expect(bySku[0]?.procurement).toMatchObject({ versionNo: 2, purchasePrice: '19.0000' });

    const byName = await purchases.findPricingProducts({ kind: 'PRODUCT_NAME', productName: '  布鞋  ' });
    expect(byName.map((item) => item.sku).sort()).toEqual([first.sku, second.sku, special.sku].sort());
    expect(await purchases.findPricingProducts({ kind: 'PRODUCT_NAME', productName: '布鞋休闲' })).toEqual([]);
    expect((await purchases.findPricingProducts({ kind: 'PRODUCT_NAME', productName: 'canvas shoe' })).map((item) => item.sku)).toEqual([english.sku]);
    expect((await purchases.findPricingProducts({ kind: 'PRODUCT_NAME', productName: '%_' })).map((item) => item.sku)).toEqual([special.sku]);

    const indexes = await admin.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname IN ('products_product_name_lower','products_product_name_trgm') ORDER BY indexname", [schema]);
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]).toMatchObject({ indexname: 'products_product_name_trgm' });
    expect(indexes.rows[0].indexdef).toContain('gin_trgm_ops');
    expect((await admin.query(`SELECT e.extname, n.nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_trgm'`)).rows).toEqual([{ extname: 'pg_trgm', schema_name: 'public' }]);
  });

  it('产品名包含查询超过 500 条时要求缩小关键词范围', async () => {
    await admin.query(`INSERT INTO ${schema}.products (sku,product_name)
      SELECT LPAD((9000000+n)::text,7,'0'), '批量模糊上限商品-' || n FROM generate_series(1,501) n`);
    await admin.query(`INSERT INTO ${schema}.procurement_versions
      (id,sku,version_no,purchase_price,courier_fee,currency,gross_weight_g,length_cm,width_cm,height_cm,provider_url)
      SELECT md5('pricing-fuzzy-' || n)::uuid,LPAD((9000000+n)::text,7,'0'),1,10,0,'CNY',500,20,10,8,'https://example.com/bulk/' || n
      FROM generate_series(1,501) n`);
    await expect(purchases.findPricingProducts({ kind: 'PRODUCT_NAME', productName: '批量模糊上限' })).rejects.toMatchObject({
      code: 'TOO_MANY_MATCHES',
      message: '匹配产品超过 500 个，请缩小关键词范围或改用 SKU'
    });
  });
});
