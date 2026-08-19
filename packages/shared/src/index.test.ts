import { describe, expect, expectTypeOf, it } from 'vitest';
import { appConfigSchema, chineseCountryCatalog, chineseCountryNameToCode, classifyPurchaseProductUrl, commercePlatformInputSchema, countryCodeToChineseLabel, countryCodeToChineseName, createDefaultConfig, createDefaultWorkflowParameters, E001_VARIANT_MAX_IMAGE_COUNT, ERROR_CODES, latestWbMediaDeliveryBatch, limitWbDescription, MEDIA_INDEX_STATUSES, normalizeWbComparablePath, normalizeWbDescription, pricingProductQueryInputSchema, pricingTemplateDefinitionSchema, resolveCountryCode, shippingCalculationInputSchema, SUBMISSION_STEPS, WATCHER_STATUSES, WB_DESCRIPTION_MAX_LENGTH, wbFormConfigSchema, wbListingDraftUpdateSchema, wbListingPresetDefinitionSchema, wbMediaMatchesVariant, wbProductV2Schema, withWorkflowProductIdentity, withWorkflowRuntimeParameterPlaceholders, workflowParameterFileName, workflowParameterOptionsFileName } from './index.js';
import type { MediaIndexState, MediaIndexStatus, StageSummary, StageView, WatcherStatus } from './index.js';

describe('shared contracts', () => {
  it('shares backward-compatible stage summaries with media index state', () => {
    expect(MEDIA_INDEX_STATUSES).toEqual(['DISABLED', 'WARMING', 'READY', 'REFRESHING', 'STALE', 'ERROR']);
    expect(WATCHER_STATUSES).toEqual(['ACTIVE', 'STARTING', 'DEGRADED', 'UNAVAILABLE', 'DISABLED']);
    const summary: StageSummary = {
      pending: 3, drafts: 2, approved: 1, queue: 4, totalTasks: 6, lastScannedAt: '2026-08-07T08:00:00.000Z'
    };
    const index: MediaIndexState = {
      stageId: 'E006', revision: 'revision-e006', status: 'REFRESHING', watcherStatus: 'ACTIVE', pendingReconciliations: 1, queueCount: 1,
      lastReconciledAt: '2026-08-07T08:00:00.000Z'
    };
    const stage: StageView = { ...createDefaultConfig('win32').stages[0]!, summary, index };
    expect(stage.summary).toEqual(summary);
    expect(stage.index).toEqual(index);
    expectTypeOf(stage.index?.status).toEqualTypeOf<MediaIndexStatus | undefined>();
    expectTypeOf(stage.index?.watcherStatus).toEqualTypeOf<WatcherStatus | undefined>();
    expectTypeOf(stage.index?.revision).toEqualTypeOf<string | undefined>();
  });

  it.each([
    ['http://yangkeduo.com/goods.html?goods_id=123456', { platform: 'PDD', workflowCode: 'E006', productId: '123456' }],
    ['HTTPS://MOBILE.YANGKEDUO.COM/goods.html?goodsId=000123', { platform: 'PDD', workflowCode: 'E006', productId: '000123' }],
    ['https://detail.1688.com/offer/1.html', { platform: '1688', workflowCode: 'E007', productId: '1' }],
    [`https://detail.1688.com/offer/${'1'.repeat(31)}.html`, { platform: '1688', workflowCode: 'E007', productId: '1'.repeat(31) }],
    ['https://1688.com/product?offerId=1', { platform: '1688', workflowCode: 'E007', productId: '1' }],
    ['https://m.1688.com/product?offer_id=12345678', { platform: '1688', workflowCode: 'E007', productId: '12345678' }],
    [`https://detail.1688.com/product?id=${'9'.repeat(31)}`, { platform: '1688', workflowCode: 'E007', productId: '9'.repeat(31) }]
  ])('classifies supported purchase product URL %s', (url, expected) => {
    expect(classifyPurchaseProductUrl(url)).toEqual(expected);
  });

  it('prefers the 1688 offer path product ID over query parameters', () => {
    expect(classifyPurchaseProductUrl('https://detail.1688.com/offer/123456.html?offerId=999999&id=888888')).toEqual({
      platform: '1688', workflowCode: 'E007', productId: '123456'
    });
  });

  it.each([
    '',
    'not a URL',
    'ftp://yangkeduo.com/goods.html?goods_id=123456',
    'javascript://yangkeduo.com/goods.html?goods_id=123456',
    'https://user@yangkeduo.com/goods.html?goods_id=123456',
    'https://:secret@1688.com/offer/123456.html',
    'https://pinduoduo.com/goods.html?goods_id=123456',
    'https://p.pinduoduo.com/short-code',
    'https://yangkeduo.com.evil.example/goods.html?goods_id=123456',
    'https://notyangkeduo.com/goods.html?goods_id=123456',
    'https://1688.com.evil.example/offer/123456.html',
    'https://not1688.com/offer/123456.html',
    'https://example.com/product?id=123456',
    'https://mobile.yangkeduo.com/goods.html',
    'https://mobile.yangkeduo.com/goods.html#goods_id=123456',
    'https://mobile.yangkeduo.com/goods.html?goods_id=12x',
    'https://mobile.yangkeduo.com/goods.html?goodsId=-123',
    'https://detail.1688.com/offer/12345',
    'https://detail.1688.com/offer/12345/',
    'https://detail.1688.com/catalog/offer/12345.html',
    'https://detail.1688.com/offer/12345.htm',
    'https://detail.1688.com/product?offer_id=12345x',
    'https://detail.1688.com/product?id='
  ])('rejects unsupported or unsafe purchase product URL %s', (url) => {
    expect(classifyPurchaseProductUrl(url)).toBeNull();
  });

  it('exports the purchase URL API error codes', () => {
    expect(ERROR_CODES).toEqual(expect.arrayContaining([
      'PRODUCT_URL_UNSUPPORTED',
      'DOWNLOAD_WORKFLOW_URL_MISMATCH',
      'SOURCE_FILE_CHANGED'
    ]));
  });

  it('uses stable media identity and the latest delivery batch consistently', () => {
    const variant = { variantId: 'variant-a', wbColor: { colorKey: 'black' } };
    expect(wbMediaMatchesVariant({ productVariantId: 'variant-a', productVariantColor: { colorKey: 'white' } }, variant)).toBe(true);
    expect(wbMediaMatchesVariant({ productVariantId: 'variant-b', productVariantColor: { colorKey: 'black' } }, variant)).toBe(false);
    expect(wbMediaMatchesVariant({ productVariantColor: { colorKey: 'black' } }, variant)).toBe(true);
    expect(latestWbMediaDeliveryBatch([
      { assetId: 'old', sourceSubmissionId: 's1', deliveredAt: '2026-07-19T10:00:00Z' },
      { assetId: 'new-1', sourceSubmissionId: 's2', deliveredAt: '2026-07-19T11:00:00Z' },
      { assetId: 'new-2', sourceSubmissionId: 's2', deliveredAt: '2026-07-19T11:00:01Z' }
    ]).map((item) => item.assetId)).toEqual(['new-1', 'new-2']);
  });

  it('creates the default grouped Windows flow', () => {
    expect(E001_VARIANT_MAX_IMAGE_COUNT).toBe(5);
    const config = createDefaultConfig('win32');
    expect(appConfigSchema.parse(config).stages.map((stage) => stage.id)).toEqual(['E006', 'E007', 'E001', 'E002', 'E003', 'E004', 'E005']);
    expect(config.stages.find((stage) => stage.id === 'E003')?.targets.map((target) => target.targetStageId)).toEqual(['E004', 'E005']);
    expect(config.stages[0]?.candidateRoot).toBe('G:\\01_MerchRoute\\03-pddProductMedia');
    expect(config.workflowGroups.map((group) => group.name)).toEqual(['下载组', '抠图组', '生图组', '视频组', 'LOGO组']);
    expect(config.stages[0]).toMatchObject({ alias: 'PDD下载', groupId: 'downloads', download: { isDefault: true, recoveryMode: 'IDEMPOTENT_REPLAY' } });
    expect(config.stages[1]).toMatchObject({
      id: 'E007', alias: '1688下载', groupId: 'downloads', candidateRoot: 'G:\\01_MerchRoute\\03-1688ProductMedia',
      download: { webhookUrl: 'http://localhost:5678/webhook/1688-product-media-download', isDefault: false, recoveryMode: 'IDEMPOTENT_REPLAY' }
    });
    expect(config).toMatchObject({ version: 'v003', wbPublishing: { enabled: false, rootDirectory: '' } });
  });

  it('accepts dynamic workflow counts and validates references', () => {
    const config = createDefaultConfig('darwin');
    expect(appConfigSchema.safeParse({ ...config, stages: [] }).success).toBe(true);
    const eighth = { ...structuredClone(config.stages[2]!), id: 'E008', alias: '测试流程', workflowName: 'E008-测试流程', targets: [] };
    const ninth = { ...structuredClone(eighth), id: 'E009', alias: '测试流程2', workflowName: 'E009-测试流程2' };
    expect(appConfigSchema.safeParse({ ...config, stages: [...config.stages, eighth] }).success).toBe(true);
    expect(appConfigSchema.safeParse({ ...config, stages: [...config.stages, eighth, ninth] }).success).toBe(true);
    const duplicate = { ...config, stages: [...config.stages, structuredClone(config.stages[0]!)] };
    expect(appConfigSchema.safeParse(duplicate).success).toBe(false);
    const invalidGroup = structuredClone(config);
    invalidGroup.stages[0]!.groupId = 'missing-group';
    expect(appConfigSchema.safeParse(invalidGroup).success).toBe(false);
    const invalidTarget = structuredClone(config);
    invalidTarget.stages[0]!.targets[0]!.targetStageId = 'E999';
    expect(appConfigSchema.safeParse(invalidTarget).success).toBe(false);
    const multipleDefaults = structuredClone(config);
    multipleDefaults.stages.push({ ...structuredClone(config.stages[1]!), id: 'E008', workflowName: 'E008-测试下载', download: { ...config.stages[1]!.download!, isDefault: true } });
    expect(appConfigSchema.safeParse(multipleDefaults).success).toBe(false);
  });

  it('keeps READY after verification in the submission sequence', () => {
    expect(SUBMISSION_STEPS.indexOf('写入 READY')).toBeGreaterThan(SUBMISSION_STEPS.indexOf('完整性校验'));
    expect(SUBMISSION_STEPS.at(-1)).toBe('完成');
  });

  it('rejects invalid concurrency', () => {
    const config = createDefaultConfig('darwin');
    expect(appConfigSchema.safeParse({ ...config, submissionConcurrency: 5 }).success).toBe(false);
  });

  it('provides typed E004 defaults while keeping the other workflow defaults as strings', () => {
    const defaults = createDefaultWorkflowParameters();
    expect(Object.keys(defaults)).toEqual(['E006', 'E007', 'E001', 'E002', 'E003', 'E004', 'E005']);
    expect(defaults.E006?.productUrl).toBe('');
    expect(defaults.E007).toMatchObject({ SKU: '', productName: '', productUrl: '', parentOutputDir: 'G:\\01_MerchRoute\\03-1688ProductMedia' });
    expect(defaults.E005).toEqual({
      SKU: '',
      productName: '',
      variants: '',
      outputParentDir: 'G:\\01_MerchRoute\\02_GenerateFolder\\E005-主图加-LOGO-输出',
      maxSidePx: '768',
      logo: 'G:\\01_MerchRoute\\logo\\tek+.png',
      outputSuffix: '-logo'
    });
    expect(Object.entries(defaults).filter(([stageId]) => stageId !== 'E004').flatMap(([, parameters]) => Object.values(parameters)).every((value) => typeof value === 'string')).toBe(true);
    expect(Object.keys(defaults.E004 || {})).toHaveLength(28);
    expect(defaults.E004).toMatchObject({
      targetDuration: 15,
      width: 768,
      enableLogo: true,
      allowedImageExtensions: ['.jpg', '.jpeg', '.png', '.webp']
    });
    expect(workflowParameterFileName('E003')).toBe('E003_n8n_product_image_task.json');
    expect(workflowParameterOptionsFileName('E003')).toBe('E003_n8n_product_image_task.options.json');
  });

  it('derives workflow path defaults from a portable data root without changing child names', () => {
    const defaults = createDefaultWorkflowParameters('/Volumes/Data/01_MerchRoute');
    expect(defaults.E001?.downloadFatherFolder).toBe('/Volumes/Data/01_MerchRoute/02_GenerateFolder/E001-抠图-下载');
    expect(defaults.E004?.musicPath).toBe('/Volumes/Data/01_MerchRoute/99-背景音乐/科技产品宣传.mp3');
    expect(defaults.E006?.parentOutputDir).toBe('/Volumes/Data/01_MerchRoute/03-pddProductMedia');
    expect(defaults.E007?.parentOutputDir).toBe('/Volumes/Data/01_MerchRoute/03-1688ProductMedia');
  });

  it('pins runtime product fields as strings and prevents template values from overriding database identity', () => {
    expect(withWorkflowRuntimeParameterPlaceholders({ SKU: 0, productName: '模板名', custom: '保留' })).toEqual({ SKU: '', productName: '', custom: '保留' });
    expect(withWorkflowProductIdentity({ SKU: '9999999', productName: '客户端篡改', custom: '保留' }, '0000011', '网面跑步鞋')).toEqual({ SKU: '0000011', productName: '网面跑步鞋', custom: '保留' });
  });

  it('accepts user-defined platforms and generic shipping identities', () => {
    expect(commercePlatformInputSchema.parse({ code: 'AMAZON_BR', displayName: 'Amazon Brazil' }).code).toBe('AMAZON_BR');
    expect(shippingCalculationInputSchema.safeParse({ shippingTemplateId: '6d8c5d9a-6ea7-4f28-9ba0-000000000003', actualWeightGrams: '100', lengthCm: '10', widthCm: '10', heightCm: '10' }).success).toBe(true);
  });

  it('validates arbitrary currency pairs without RUB-specific fields', () => {
    const definition = { schemaVersion: '1', costCurrencyCode: 'CNY', saleCurrencyCode: 'USD', saleCurrencyPerCostCurrency: '0.14', storeDiscountRate: '0', strikePriceMultiplier: '1', defaultCommissionRate: '0.15', defaultTargetMarginRate: '0.3', fixedCosts: [], percentageDeductions: [] };
    expect(pricingTemplateDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(pricingTemplateDefinitionSchema.safeParse({ ...definition, saleCurrencyCode: 'CNY', saleCurrencyPerCostCurrency: '0.14' }).success).toBe(false);
  });

  it('售价查询只接受一个运费模板和不重复的服务渠道', () => {
    const base = { lookup: { kind: 'SKU' as const, sku: '0000001' }, pricingTemplateId: '11111111-1111-4111-8111-111111111111' };
    expect(pricingProductQueryInputSchema.safeParse({ ...base, shippingTemplateIds: ['22222222-2222-4222-8222-222222222222'], shippingServiceCodes: ['CEL_EXPRESS', 'CEL_ECONOMY'] }).success).toBe(true);
    expect(pricingProductQueryInputSchema.safeParse({ ...base, shippingTemplateIds: [], shippingServiceCodes: ['CEL_EXPRESS'] }).success).toBe(false);
    expect(pricingProductQueryInputSchema.safeParse({ ...base, shippingTemplateIds: ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'], shippingServiceCodes: ['CEL_EXPRESS'] }).success).toBe(false);
    expect(pricingProductQueryInputSchema.safeParse({ ...base, shippingTemplateIds: ['22222222-2222-4222-8222-222222222222'], shippingServiceCodes: [] }).success).toBe(false);
    expect(pricingProductQueryInputSchema.safeParse({ ...base, shippingTemplateIds: ['22222222-2222-4222-8222-222222222222'], shippingServiceCodes: ['CEL_EXPRESS', 'CEL_EXPRESS'] }).success).toBe(false);
  });

  it('converts standard country codes and Chinese country names in both directions', () => {
    expect(countryCodeToChineseName(' by ')).toBe('白俄罗斯');
    expect(countryCodeToChineseName('KZ')).toBe('哈萨克斯坦');
    expect(chineseCountryNameToCode(' 美国 ')).toBe('US');
    expect(resolveCountryCode('us')).toBe('US');
    expect(resolveCountryCode('白俄罗斯')).toBe('BY');
    expect(resolveCountryCode('不存在国')).toBeUndefined();
    expect(countryCodeToChineseLabel('ZZ')).toBe('未知国家（ZZ）');
    expect(chineseCountryCatalog.some((item) => item.code === 'HK' && item.zhName === '中国香港')).toBe(true);
    expect(new Set(chineseCountryCatalog.map((item) => item.code)).size).toBe(chineseCountryCatalog.length);
    expect(new Set(chineseCountryCatalog.map((item) => item.zhName)).size).toBe(chineseCountryCatalog.length);
  });

  it('normalizes WB descriptions to literal paragraph separators', () => {
    for (const input of ['A\r\n\r\nB', 'A\n\nB', 'A\\n\\nB', 'A\nB']) {
      const result = normalizeWbDescription(input);
      expect(result).toBe('A\\n\\nB');
      expect(result).not.toMatch(/[\r\n]/);
    }
  });

  it('limits WB descriptions to the safe 2000 character default without real newlines', () => {
    for (const length of [1999, 2000]) {
      const result = limitWbDescription('A'.repeat(length));
      expect(result).toMatchObject({ value: 'A'.repeat(length), originalLength: length, finalLength: length, truncated: false, maxLength: WB_DESCRIPTION_MAX_LENGTH });
    }
    for (const length of [2001, 2039, 5000]) {
      const result = limitWbDescription('A'.repeat(length));
      expect(result.value).toHaveLength(WB_DESCRIPTION_MAX_LENGTH);
      expect(result).toMatchObject({ originalLength: length, finalLength: WB_DESCRIPTION_MAX_LENGTH, truncated: true, maxLength: WB_DESCRIPTION_MAX_LENGTH });
      expect(result.value).not.toMatch(/[\r\n]/);
    }
    const paragraph = limitWbDescription(`${'A'.repeat(1000)}\\n\\n${'B'.repeat(1200)}`);
    expect(paragraph.truncated).toBe(true);
    expect(paragraph.value.length).toBeLessThanOrEqual(WB_DESCRIPTION_MAX_LENGTH);
    expect(paragraph.value).not.toMatch(/[\r\n]/);
  });

  it('compares Windows roots case-insensitively while preserving POSIX case', () => {
    expect(normalizeWbComparablePath('C:\\WB\\Publish\\')).toBe(normalizeWbComparablePath('c:/wb/publish'));
    expect(normalizeWbComparablePath('\\\\Server\\Share\\WB')).toBe(normalizeWbComparablePath('//server/share/wb'));
    expect(normalizeWbComparablePath('/Volumes/WB')).not.toBe(normalizeWbComparablePath('/Volumes/wb'));
  });

  it('validates dynamic WB forms and product.json v2 native characteristics', () => {
    const form = wbFormConfigSchema.parse({ fields: [
      { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', scope: 'shared', control: 'select', required: true, order: 1 },
      { fieldId: 'color', characteristicId: 14177449, labelRu: 'Цвет', scope: 'variant', control: 'multi-select', required: true, order: 2 }
    ], media: { minImages: 1, maxImages: 7, videoAllowed: true } });
    expect(form.fields.map((field) => field.characteristicId)).toEqual([204557, 14177449]);
    expect(form.media.defaultVideoUploadMode).toBe('COMPRESSED_COPY');
    expect(form.compliance).toEqual({ tnvedCharacteristicId: null, tnvedRequired: false });
    expect(wbFormConfigSchema.safeParse({ fields: [], compliance: { tnvedCharacteristicId: null, tnvedRequired: true } }).success).toBe(false);
    expect(wbFormConfigSchema.parse({ fields: [], media: { minImages: 1, maxImages: 7, videoAllowed: true, defaultVideoUploadMode: 'ORIGINAL' } }).media.defaultVideoUploadMode).toBe('ORIGINAL');
    expect(wbFormConfigSchema.safeParse({ fields: [], media: { minImages: 1, maxImages: 7, videoAllowed: true, defaultVideoUploadMode: 'INVALID' } }).success).toBe(false);
    const product = {
      schemaVersion: 2, productCode: '0000010', revision: 1,
      category: { key: 'casual_shoes', subjectId: 105, templateVersion: 1, schemaHash: `sha256:${'a'.repeat(64)}` },
      brand: '', titleRu: 'Кроссовки', descriptionRu: 'A\\n\\nB',
      packaging: { lengthCm: 35, widthCm: 20, heightCm: 15, weightKg: 0.7 }, priceCny: 10, discountPercent: 0,
      compliance: { tnved: '6404199000', kizMarked: true },
      variants: [{ variantCode: '0000010-BLACK', vendorCode: '0000010-BLACK', characteristics: [
        { id: 204557, value: ['Женский'] }, { id: 14177449, value: ['Черный'] }, { id: 123, value: 42 }, { id: 124, value: true }
      ], images: ['variants/01.png'], video: 'variants/main.mp4', sizes: [{}] }]
    };
    expect(wbProductV2Schema.parse(product).videoUploadMode).toBe('ORIGINAL');
    expect(wbProductV2Schema.safeParse({ ...product, videoUploadMode: 'COMPRESSED_COPY' }).success).toBe(true);
    expect(wbProductV2Schema.safeParse({ ...product, videoUploadMode: 'INVALID' }).success).toBe(false);
    const withoutCompliance = structuredClone(product) as Partial<typeof product>;
    delete withoutCompliance.compliance;
    expect(wbProductV2Schema.safeParse(withoutCompliance).success).toBe(true);
    expect(wbProductV2Schema.safeParse({ ...product, descriptionRu: 'A\nB' }).success).toBe(false);
    expect(wbProductV2Schema.safeParse({ ...product, titleRu: 'A'.repeat(61) }).success).toBe(false);
    expect(wbProductV2Schema.safeParse({ ...product, descriptionRu: 'A'.repeat(2_001) }).success).toBe(false);
    expect(wbProductV2Schema.safeParse({
      ...product,
      variants: [{ ...product.variants[0], descriptionRu: 'A'.repeat(2_001) }]
    }).success).toBe(false);
    expect(wbProductV2Schema.safeParse({ ...product, priceCny: 0 }).success).toBe(false);
    expect(wbProductV2Schema.safeParse({ ...product, compliance: { tnved: '640419900', kizMarked: false } }).success).toBe(false);
    expect(wbProductV2Schema.safeParse({ ...product, discountPercent: 0.5 }).success).toBe(false);
    expect(wbProductV2Schema.safeParse({ ...product, packaging: { lengthCm: 35, widthCm: 20, heightCm: 15, weightKg: 0 } }).success).toBe(false);
  });

  it('validates optional WB Club discount contracts for drafts and product.json', () => {
    const draft = { draftVersion: 1 };
    expect(wbListingDraftUpdateSchema.safeParse(draft).success).toBe(true);
    expect(wbListingDraftUpdateSchema.safeParse({ ...draft, videoUploadMode: 'ORIGINAL' }).success).toBe(true);
    expect(wbListingDraftUpdateSchema.safeParse({ ...draft, videoUploadMode: 'COMPRESSED_COPY' }).success).toBe(true);
    expect(wbListingDraftUpdateSchema.safeParse({ ...draft, videoUploadMode: 'INVALID' }).success).toBe(false);
    expect(wbListingDraftUpdateSchema.safeParse({ ...draft, clubDiscount: null }).success).toBe(true);
    expect(wbListingDraftUpdateSchema.parse({ ...draft, compliance: { tnved: '', kizMarked: true } }).compliance).toEqual({ tnved: '', kizMarked: false });
    expect(wbListingDraftUpdateSchema.safeParse({ ...draft, compliance: { tnved: '64041A9000', kizMarked: false } }).success).toBe(false);
    for (const clubDiscount of [0, 3, 7, 31]) {
      expect(wbListingDraftUpdateSchema.safeParse({ ...draft, clubDiscount }).success).toBe(true);
    }
    for (const clubDiscount of [1, 2, 32, 3.5]) {
      expect(wbListingDraftUpdateSchema.safeParse({ ...draft, clubDiscount }).success).toBe(false);
    }

    const product = {
      schemaVersion: 2, productCode: '0000010', revision: 1,
      category: { key: 'casual_shoes', subjectId: 105, templateVersion: 1, schemaHash: `sha256:${'a'.repeat(64)}` },
      brand: '', titleRu: 'Кроссовки', descriptionRu: 'A\\n\\nB',
      packaging: { lengthCm: 35, widthCm: 20, heightCm: 15, weightKg: 0.7 }, priceCny: 10, discountPercent: 0,
      variants: [{ variantCode: '0000010-BLACK', vendorCode: '0000010-BLACK', characteristics: [{ id: 14177449, value: ['Черный'] }], images: ['variants/01.png'], sizes: [{}] }]
    };
    const unmanaged = wbProductV2Schema.parse(product);
    expect(unmanaged).not.toHaveProperty('clubDiscount');
    for (const clubDiscount of [0, 3, 7, 31]) {
      expect(wbProductV2Schema.safeParse({ ...product, clubDiscount }).success).toBe(true);
    }
    for (const clubDiscount of [1, 2, 32, 3.5]) {
      expect(wbProductV2Schema.safeParse({ ...product, clubDiscount }).success).toBe(false);
    }
  });

  it('validates WB listing preset boundaries and keeps barcode server-managed', () => {
    const base = {
      name: 'WB 默认预设', pricingTemplateId: '11111111-1111-4111-8111-111111111111', shippingTemplateId: '22222222-2222-4222-8222-222222222222',
      shippingServiceCode: 'CEL_WB_ECONOMY', packaging: { grossWeightGrams: 750, lengthCm: 30, widthCm: 15, heightCm: 10 },
      categoryKey: 'adult_casual_sneakers', discountPercent: 49, clubDiscount: 5, tnved: '6404199000', brand: '',
      sizes: [{ techSize: '40', wbSize: '40', insoleLengthCm: 25.5, stock: 10 }]
    };
    const parsed = wbListingPresetDefinitionSchema.parse(base);
    expect(parsed.autoPublishEnabled).toBe(false);
    expect(wbListingPresetDefinitionSchema.parse({ ...base, autoPublishEnabled: true }).autoPublishEnabled).toBe(true);
    expect(parsed.shippingServiceCode).toBe('CEL_WB_ECONOMY');
    expect(parsed.titleTranslation).toEqual({ workflowId: 'W2lSSXE3NUaLW1tD', language: '俄文', maxLength: 60 });
    expect(parsed).not.toHaveProperty('videoUploadMode');
    expect(parsed.sharedCharacteristics).toEqual([]);
    expect(parsed.variantCharacteristics).toEqual([]);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, tnved: '' }).success).toBe(true);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, tnved: '640419900' }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, tnved: '64041990000' }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, tnved: '64041A9000' }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({
      ...base,
      sharedCharacteristics: [{ id: 204557, value: ['Женский'] }],
      variantCharacteristics: [{ id: 14177449, value: ['Черный'] }]
    }).success).toBe(true);
    expect(wbListingPresetDefinitionSchema.safeParse({
      ...base,
      sharedCharacteristics: [{ id: 204557, value: ['Женский'] }, { id: 204557, value: ['Мужской'] }]
    }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({
      ...base,
      sharedCharacteristics: [{ id: 204557, value: ['Женский'] }],
      variantCharacteristics: [{ id: 204557, value: ['Женский'] }]
    }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({
      ...base,
      sharedCharacteristics: [{ id: 204557, value: [] }]
    }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, clubDiscount: 2 }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, packaging: { ...base.packaging, grossWeightGrams: 0 } }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, sizes: [] }).success).toBe(false);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, titleTranslation: { workflowId: 'W2lSSXE3NUaLW1tD', language: '语'.repeat(64), maxLength: 60 } }).success).toBe(true);
    expect(wbListingPresetDefinitionSchema.safeParse({ ...base, titleTranslation: { workflowId: 'W2lSSXE3NUaLW1tD', language: '语'.repeat(65), maxLength: 60 } }).success).toBe(false);
  });
});
