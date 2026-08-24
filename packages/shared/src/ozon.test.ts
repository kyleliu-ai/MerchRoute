import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  findMissingOzonRequiredAttributes,
  cleanupOzonDescription,
  OZON_DESCRIPTION_MAX_LENGTH,
  OZON_DESCRIPTION_MAX_LENGTH_SOURCE,
  OZON_CONTENT_POLICY_VERSION,
  OZON_CONTENT_POLICY_V2,
  OZON_CONTENT_POLICY_V3,
  OZON_SHARED_MATERIAL_HASH_VERSION,
  OZON_TITLE_MAX_LENGTH,
  hasOzonCjk,
  hasOzonInvalidPlatformCharacters,
  isOzonSystemMediaAttributeId,
  inferOzonCategorySizing,
  ozonCategoryAttributeSchema,
  ozonCategoryAttributeOrderInputSchema,
  ozonCategorySizeAttributeCandidates,
  ozonCategorySizingSchema,
  ozonCompatibleAppendInputSchema,
  ozonCompatibleAppendPlanSchema,
  ozonGrossWeightResolutionSchema,
  ozonListingDraftInputSchema,
  ozonListingInitializationSchema,
  ozonOfferSchema,
  ozonPresetInputSchema,
  ozonSharedMaterialDraftInputSchema,
  ozonSharedMaterialProjectionSchema,
  ozonSharedMaterialRevisionMetadataSchema,
  ozonProductSchema,
  ozonProductV1Schema,
  ozonProductV2Schema,
  isOzonSequentialVariantCode,
  nextOzonVariantCode,
  ozonAutoJobCanCancel,
  ozonJobHasActiveLease,
  ozonJobHasLocalGenerationClaim,
  ozonJobHasRemoteProgress,
  ozonProductUrl,
  canonicalOzonSharedMaterialJson,
  findUncoveredOzonPresetRequiredAttributes,
  projectOzonPresetRequiredAttributeCoverage,
  projectOzonSharedMaterialDraft,
  stableOzonOfferId
} from './ozon.js';
import {
  assertExecutableOzonContentPolicyVersion,
  normalizeOzonDescriptionForValidation,
  validateOzonDescription,
  validateOzonTitle
} from './ozon-content-policy.js';
import type { OzonActiveJobSummary, OzonListingDetail, OzonListingDraft, OzonManualSubmissionResult } from './ozon.js';

const media = (count: number) => Array.from({ length: count }, (_, index) => ({
  assetId: `asset-${index}`,
  relativePath: `images/${index + 1}.png`,
  kind: 'image' as const,
  sortOrder: index,
  isPrimary: index === 0
}));
const video = {
  assetId: 'video-1',
  relativePath: 'variants/shared/videos/main.mp4',
  kind: 'video' as const,
  sortOrder: 15,
  isPrimary: false
};

const offer = {
  variantId: randomUUID(),
  variantCode: 'BLACK-40',
  offerId: '0000010-BLACK-40',
  price: 2_990,
  oldPrice: 3_990,
  minPrice: 2_500,
  stock: 10,
  media: media(2)
};

describe('OZON shared contracts', () => {
  it('keeps the 63-character Russian title and enforces the independent OZON title ceiling', () => {
    const title = 'Универсальная сумка через плечо для повседневного использования';
    expect(Array.from(title)).toHaveLength(63);
    expect(validateOzonTitle(title)).toMatchObject({ valid: true, length: 63, issues: [] });
    const title200 = (() => {
      let value = 'Товар';
      while (Array.from(value).length + 3 <= OZON_TITLE_MAX_LENGTH - 1) value += ' А1';
      return `${value} ${'а'.repeat(OZON_TITLE_MAX_LENGTH - Array.from(value).length - 1)}`;
    })();
    expect(Array.from(title200)).toHaveLength(OZON_TITLE_MAX_LENGTH);
    expect(validateOzonTitle(title200)).toMatchObject({ valid: true, length: OZON_TITLE_MAX_LENGTH, issues: [] });
    expect(validateOzonTitle(`${title200}а`).issues).toContain('TOO_LONG');
    expect(validateOzonTitle('中文标题').issues).toContain('CJK');
  });

  it('rejects OZON title characters and commercial claims instead of rewriting them', () => {
    expect(validateOzonTitle('Сумка 2.0 / Model-X & "Plus"!').valid).toBe(true);
    expect(validateOzonTitle(`Товар ${'а'.repeat(28)}`).issues).toContain('TITLE_WORD_TOO_LONG');
    expect(validateOzonTitle('товар').issues).toContain('TITLE_INITIAL_NOT_UPPERCASE');
    expect(validateOzonTitle('Товар™').issues).toContain('FORBIDDEN_SYMBOL');
    expect(validateOzonTitle('Товар\u00A0').issues).toContain('HIDDEN_CHARACTER');
    expect(validateOzonTitle('Товар <br>').issues).toContain('UNSUPPORTED_HTML');
    expect(validateOzonTitle('Товар https://example.ru').issues).toContain('EXTERNAL_LINK');
    expect(validateOzonTitle('Товар со скидкой').issues).toContain('ADVERTISING');
    expect(validateOzonTitle('Товар 1 000 ₽').issues).toContain('PRICE_INFORMATION');
    expect(validateOzonTitle('Товар реплика').issues).toContain('IMITATION_CLAIM');
    expect(validateOzonTitle('Сумка сумка сумка').issues).toContain('KEYWORD_STUFFING');
    expect(validateOzonTitle('Лучшее сцепление').valid).toBe(true);
  });

  it('marks the description cap as a MerchRoute safe default and validates markup without rewriting the source', () => {
    const source = 'Первая строка\\n<ul><li>Преимущество</li></ul>\r\nВторая строка';
    const result = validateOzonDescription(source);
    expect(OZON_DESCRIPTION_MAX_LENGTH).toBe(6_000);
    expect(OZON_DESCRIPTION_MAX_LENGTH_SOURCE).toBe('MERCHROUTE_SAFE_DEFAULT');
    expect(OZON_CONTENT_POLICY_VERSION).toBe('merchroute-ozon-content-v3');
    expect(result).toMatchObject({ valid: true, normalizedForSubmission: 'Первая строка<br><ul><li>Преимущество</li></ul><br>Вторая строка' });
    expect(normalizeOzonDescriptionForValidation(source)).not.toBe(source);
    expect(validateOzonDescription('Описание<BR/><UL><LI>Пункт</LI></UL>')).toMatchObject({
      valid: true,
      normalizedForSubmission: 'Описание<br><ul><li>Пункт</li></ul>'
    });
    expect(validateOzonDescription('<br class="bad">').issues).toContain('UNSUPPORTED_HTML');
    expect(validateOzonDescription('А'.repeat(OZON_DESCRIPTION_MAX_LENGTH)).valid).toBe(true);
    expect(validateOzonDescription('А'.repeat(OZON_DESCRIPTION_MAX_LENGTH + 1)).issues).toContain('TOO_LONG');
  });

  it('executes frozen v2/v3 imitation rules and fails closed for unknown policy versions', () => {
    for (const adjective of ['аналогичный', 'аналогичного', 'аналогичным']) {
      const phrase = `Описание с ${adjective} тисненым рисунком`;
      expect(validateOzonDescription(phrase, OZON_CONTENT_POLICY_V3)).toMatchObject({
        valid: true,
        policyVersion: OZON_CONTENT_POLICY_V3
      });
      expect(validateOzonDescription(phrase, OZON_CONTENT_POLICY_V2).issues).toContain('IMITATION_CLAIM');
    }
    for (const noun of ['аналог', 'аналога', 'аналогу', 'аналогом', 'аналоге', 'аналоги', 'аналогов', 'аналогам', 'аналогами', 'аналогах']) {
      expect(validateOzonDescription(`Описание ${noun}`, OZON_CONTENT_POLICY_V3).issues, noun)
        .toContain('IMITATION_CLAIM');
    }
    for (const prohibited of ['реплика', 'копия', 'подделка', 'имитация', '1:1', 'replica', 'imitation', 'counterfeit']) {
      expect(validateOzonDescription(`Описание ${prohibited}`, OZON_CONTENT_POLICY_V3).issues, prohibited)
        .toContain('IMITATION_CLAIM');
    }
    expect(validateOzonTitle('Товар', 'LEGACY_UNKNOWN')).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['UNSUPPORTED_CONTENT_POLICY_VERSION'])
    });
    expect(() => assertExecutableOzonContentPolicyVersion('LEGACY_UNKNOWN')).toThrow(/не исполним|不可执行/u);
  });

  it('accepts only balanced attribute-free br/ul/li descriptions and rejects prohibited content', () => {
    const valid = 'Описание<ul><li>Первый<br>пункт</li><li>Второй<ul><li>Вложенный</li></ul></li></ul>';
    expect(validateOzonDescription(valid)).toMatchObject({ valid: true, normalizedForSubmission: valid });
    expect(validateOzonDescription('<ul><li>Описание</ul>').issues).toContain('UNBALANCED_HTML');
    expect(validateOzonDescription('<li class="x">Описание</li>').issues).toContain('UNSUPPORTED_HTML');
    expect(validateOzonDescription('Описание < без тега').issues).toContain('UNSUPPORTED_HTML');
    expect(validateOzonDescription('Описание https://example.ru').issues).toContain('EXTERNAL_LINK');
    expect(validateOzonDescription('Описание help@example.ru').issues).toContain('CONTACT_INFORMATION');
    expect(validateOzonDescription('Описание со скидкой').issues).toContain('ADVERTISING');
    expect(validateOzonDescription('Описание 1 000 ₽').issues).toContain('PRICE_INFORMATION');
    expect(validateOzonDescription('Описание реплика').issues).toContain('IMITATION_CLAIM');
    expect(validateOzonDescription('Описание\u00A0товара').issues).toContain('HIDDEN_CHARACTER');
    expect(validateOzonDescription('Описание 中文').issues).toContain('CJK');
    expect(validateOzonDescription('сумка сумка сумка').issues).toContain('KEYWORD_STUFFING');
    expect(validateOzonDescription('Размеры 20 x 30 x 10 мм').valid).toBe(true);
  });

  it('detects dense search mirrors inside a 12-word window without rejecting dispersed normal prose', () => {
    expect(validateOzonDescription('Сумка сумка сумка').issues).toContain('KEYWORD_STUFFING');
    expect(validateOzonDescription('Сумка женская через плечо сумка повседневная кожаная сумка').issues)
      .toContain('KEYWORD_STUFFING');

    const dispersed = [
      'Сумка', 'мягкая', 'фактура', 'золотистого', 'оттенка', 'удобные', 'ручки',
      'сумка', 'прочная', 'молния', 'внутренняя', 'подкладка', 'ровные', 'строчки',
      'сумка', 'регулируемый', 'ремень', 'золотистого', 'цвета', 'надежная', 'застежка',
      'сумка', 'вместительное', 'отделение', 'карман', 'снаружи', 'устойчивое', 'основание',
      'сумка', 'лаконичный', 'дизайн', 'золотистого', 'декора', 'подходит', 'ежедневно'
    ].join(' ');
    expect(validateOzonDescription(dispersed)).toMatchObject({ valid: true, issues: [] });
    expect(validateOzonTitle('Сумка мягкая фактура удобные ручки сумка прочная молния ровные строчки сумка')).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['KEYWORD_STUFFING'])
    });
  });

  it('deterministically removes CJK fragments and their dangling Russian connector', () => {
    const exact = cleanupOzonDescription('с выраженной фактурой под荔枝纹.');
    expect(exact.value).toBe('с выраженной фактурой.');
    expect(exact.removedFragments).toEqual(['под荔枝纹']);
    expect(cleanupOzonDescription('中文 Текст').value).toBe('Текст');
    expect(cleanupOzonDescription('Текст（中文）.').value).toBe('Текст.');
    expect(cleanupOzonDescription('Текст 中文 в конце').value).toBe('Текст в конце');
    expect(cleanupOzonDescription('Текст заканчивается 中文').value).toBe('Текст заканчивается');
    expect(cleanupOzonDescription('Текст для中文 вставки.').value).toBe('Текст вставки.');
    expect(hasOzonCjk(exact.value)).toBe(false);
    expect(hasOzonInvalidPlatformCharacters('Описание 😀')).toBe(true);
  });
  it('exposes manual-takeover listing and submission response contracts', () => {
    const activeJob = {
      id: randomUUID(),
      source: 'AUTO',
      state: 'WAITING_MEDIA',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } satisfies OzonActiveJobSummary;
    const listing = { sku: '0000049' } as any;
    const detail = { listing, activeJob, canManualTakeover: true } satisfies OzonListingDetail;
    const submission = {
      listing,
      job: {
        ...activeJob,
        sku: '0000049',
        stageStates: { import: 'PENDING', moderation: 'PENDING', images: 'PENDING', video: 'PENDING', price: 'PENDING', stock: 'PENDING' },
        retryCount: 0,
        rowVersion: 1
      },
      productJsonPath: 'inbox/0000049/product.json',
      dispatched: true,
      supersededJobId: randomUUID()
    } satisfies OzonManualSubmissionResult;

    expect(detail.canManualTakeover).toBe(true);
    expect(submission.supersededJobId).toBeTruthy();
  });

  it.each(['WAITING_MEDIA', 'READY', 'NEEDS_ATTENTION', 'FAILED'] as const)(
    'allows a local AUTO job in %s to be cancelled',
    (state) => {
      const job = { source: 'AUTO' as const, state };
      expect(ozonJobHasRemoteProgress(job)).toBe(false);
      expect(ozonAutoJobCanCancel(job)).toBe(true);
    }
  );

  it.each([
    'UPLOADING_MEDIA',
    'SUBMITTING',
    'IMPORTING',
    'VERIFYING_IMAGES',
    'UPDATING_PRICE',
    'UPDATING_STOCK',
    'MODERATING'
  ] as const)('treats %s as remote progress and refuses AUTO cancellation', (state) => {
    const job = { source: 'AUTO' as const, state };
    expect(ozonJobHasRemoteProgress(job)).toBe(true);
    expect(ozonAutoJobCanCancel(job)).toBe(false);
  });

  it.each([
    ['taskId', 'task-1'],
    ['importTaskId', 'import-1'],
    ['ozonProductId', 'product-1'],
    ['directoryStage', 'PROCESSING']
  ] as const)('refuses AUTO cancellation when %s proves remote progress', (field, value) => {
    const job = { source: 'AUTO' as const, state: 'FAILED' as const, [field]: value };
    expect(ozonJobHasRemoteProgress(job)).toBe(true);
    expect(ozonAutoJobCanCancel(job)).toBe(false);
  });

  it('does not mistake a schema-v4 publication fixed task identity for a platform write', () => {
    const job = {
      source: 'AUTO' as const,
      state: 'NEEDS_ATTENTION' as const,
      taskId: 'store-a__0000132__r2',
      payload: {
        schemaVersion: 4,
        mode: 'MULTISTORE_PUBLICATION',
        attemptPhase: 'PLANNED',
        publicationId: randomUUID(),
        planHash: `sha256:${'a'.repeat(64)}`
      }
    };
    expect(ozonJobHasRemoteProgress(job)).toBe(false);
    expect(ozonJobHasRemoteProgress({ ...job, importTaskId: 'remote-import' })).toBe(true);
    expect(ozonJobHasRemoteProgress({ ...job, directoryStage: 'PROCESSING' })).toBe(true);
  });

  it.each([
    { ozonProductLinks: [{ ozonProductId: 'product-1' }] },
    { ozonProductLinks: [{ ozonSku: '123456789' }] },
    { ozonProductLinks: [{ url: 'https://www.ozon.ru/product/123456789/' }] }
  ])('treats persisted product links as remote progress: %j', (evidence) => {
    const job = { source: 'AUTO' as const, state: 'FAILED' as const, ...evidence };
    expect(ozonJobHasRemoteProgress(job)).toBe(true);
    expect(ozonAutoJobCanCancel(job)).toBe(false);
  });

  it('ignores empty optional product-link evidence', () => {
    const job = {
      source: 'AUTO' as const,
      state: 'FAILED' as const,
      ozonProductLinks: [{ ozonProductId: ' ', ozonSku: '', url: '' }]
    };
    expect(ozonJobHasRemoteProgress(job)).toBe(false);
    expect(ozonAutoJobCanCancel(job)).toBe(true);
  });

  it('does not apply the AUTO cancellation policy to MANUAL jobs', () => {
    expect(ozonAutoJobCanCancel({ source: 'MANUAL', state: 'READY' })).toBe(false);
  });

  it('refuses AUTO cancellation while a runtime lease is active and allows an expired lease', () => {
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const active = {
      source: 'AUTO' as const,
      state: 'FAILED' as const,
      leaseOwner: 'worker-1',
      leaseToken: 'token-1',
      leaseExpiresAt: '2026-08-09T12:00:01.000Z'
    };
    expect(ozonJobHasActiveLease(active, now)).toBe(true);
    expect(ozonAutoJobCanCancel(active, now)).toBe(false);
    expect(ozonJobHasActiveLease({ leaseExpiresAt: '2026-08-09T11:59:59.000Z' }, now)).toBe(false);
    expect(ozonAutoJobCanCancel({ ...active, leaseExpiresAt: '2026-08-09T11:59:59.000Z' }, now)).toBe(true);
  });

  it.each([
    { revision: 2 },
    { offerIds: ['0000105-02'] },
    { payload: { autoPreparedByJobId: randomUUID() } },
    { payload: { autoPreparedListingRevision: 3 } },
    { payload: { expectedOfferIds: ['0000105-02'], offerContractHash: `sha256:${'a'.repeat(64)}` } }
  ])('refuses AUTO cancellation after the local generation claim is frozen: %j', (evidence) => {
    const job = { source: 'AUTO' as const, state: 'READY' as const, ...evidence };
    expect(ozonJobHasLocalGenerationClaim(job)).toBe(true);
    expect(ozonAutoJobCanCancel(job)).toBe(false);
  });

  it('accepts bilingual attribute names and validates a unique complete-order payload shape', () => {
    expect(ozonCategoryAttributeOrderInputSchema.safeParse({ rowVersion: 2, attributeKeys: ['10:0', '20:100'] }).success).toBe(true);
    expect(ozonCategoryAttributeOrderInputSchema.safeParse({ rowVersion: 2, attributeKeys: ['10:0', '10:0'] }).success).toBe(false);
    expect(ozonCategoryAttributeOrderInputSchema.safeParse({ rowVersion: 2, attributeKeys: ['invalid'] }).success).toBe(false);
  });

  it('identifies only real top-level OZON size attributes and preserves URL attachment types', () => {
    const attributes = [
      { id: 4298, name: 'Российский размер', nameRu: 'Российский размер', nameZh: '俄罗斯尺码', type: 'String', required: true, dictionaryId: 361, complexId: 0 },
      { id: 9533, name: 'Размер производителя', nameRu: 'Размер производителя', nameZh: '制造商尺码', type: 'String', required: false, dictionaryId: 0, complexId: 0 },
      { id: 8789, name: 'Название файла PDF', nameRu: 'Название файла PDF', nameZh: 'PDF文件名称', type: 'String', required: false, dictionaryId: 0, complexId: 8788 },
      { id: 8790, name: 'Документ PDF', nameRu: 'Документ PDF', nameZh: 'PDF 文件', type: 'URL', required: false, dictionaryId: 0, complexId: 8788 },
      { id: 22273, name: 'Размер видео', nameRu: 'Размер видео', nameZh: '视频尺码', type: 'String', required: true, dictionaryId: 0, complexId: 0 }
    ] as const;
    expect(ozonCategorySizeAttributeCandidates(attributes).map((attribute) => attribute.id)).toEqual([4298, 9533]);
    expect(inferOzonCategorySizing(attributes as any)).toEqual({ sizeMode: 'sized', sizeAttributeKey: '4298:0' });
    expect(ozonCategoryAttributeSchema.parse({
      id: 8790, name: 'Документ PDF', type: 'URL', complexId: 8788
    }).type).toBe('URL');
    expect(ozonCategorySizingSchema.safeParse({ sizeMode: 'sized' }).success).toBe(false);
    expect(ozonCategorySizingSchema.safeParse({ sizeMode: 'sizeless', sizeAttributeKey: '4298:0' }).success).toBe(false);
  });

  it('accepts FBS and rFBS drafts while enforcing immutable ASCII offer IDs', () => {
    const base = { rowVersion: 1, fulfillmentMode: 'FBS', offers: [offer] };
    expect(ozonListingDraftInputSchema.safeParse(base).success).toBe(true);
    expect(ozonListingDraftInputSchema.safeParse({ ...base, fulfillmentMode: 'RFBS' }).success).toBe(true);
    expect(ozonListingDraftInputSchema.safeParse({
      ...base,
      offers: [{ ...offer, offerId: '中文货号' }]
    }).success).toBe(false);
    const generated = stableOzonOfferId('0000010', '红色 / 40');
    expect(generated).toMatch(/^0000010-40-[a-f0-9]{8}$/);
    expect(generated).toBe(stableOzonOfferId('0000010', '红色 / 40'));
    expect(generated).not.toBe(stableOzonOfferId('0000010', '白色 / 40'));
  });

  it('generates two-digit positive variant codes and canonical OZON product links', () => {
    expect(nextOzonVariantCode([])).toBe('01');
    expect(nextOzonVariantCode(['01', '03'])).toBe('02');
    expect(nextOzonVariantCode(Array.from({ length: 99 }, (_, index) => String(index + 1).padStart(2, '0')))).toBeUndefined();
    expect(isOzonSequentialVariantCode('01')).toBe(true);
    expect(isOzonSequentialVariantCode('99')).toBe(true);
    expect(isOzonSequentialVariantCode('00')).toBe(false);
    expect(isOzonSequentialVariantCode('1')).toBe(false);
    expect(stableOzonOfferId('0000052', '01')).toBe('0000052-01');
    expect(ozonProductUrl('5686268830')).toBe('https://www.ozon.ru/product/5686268830/');
    expect(ozonProductUrl(
      '5260188556',
      'https://www.ozon.ru/product/sumka-5260188556/?sh=l0T-JVlVog'
    )).toBe('https://www.ozon.ru/product/sumka-5260188556/?sh=l0T-JVlVog');
    expect(ozonProductUrl(
      '5260188556',
      'https://www.ozon.ru/product/5715226284/'
    )).toBe('https://www.ozon.ru/product/5260188556/');
    expect(ozonProductUrl('invalid')).toBeUndefined();
  });

  it('keeps presets as strict product blueprints and rejects store-owned policy fields', () => {
    const input = {
      name: 'OZON 商品蓝图', categoryKey: 'ozon_1_2',
      pricingTemplateId: randomUUID(), shippingTemplateId: randomUUID(), shippingServiceCode: 'CEL_RFBS_ECONOMY',
      vat: '0.2', defaultStock: 1,
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' }
    };
    const parsed = ozonPresetInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({
      shippingServiceCode: 'CEL_RFBS_ECONOMY',
      titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 200 },
      descriptionSource: 'E003',
      sizes: [{ value: '', stock: 0 }]
    });
    for (const [field, value] of Object.entries({
      isDefault: true,
      autoPublishEnabled: true,
      autoPublishMode: 'CREATE_ONLY',
      autoPublishActivatedAt: '2026-08-13T00:00:00.000Z',
      warehouseId: '10001',
      fulfillmentMode: 'RFBS',
      currency: 'CNY'
    })) {
      expect(ozonPresetInputSchema.safeParse({ ...input, [field]: value }).success).toBe(false);
    }
    expect(ozonPresetInputSchema.safeParse({ ...input, shippingServiceCode: '' }).success).toBe(false);
    expect(ozonPresetInputSchema.safeParse({ ...input, sizeAttributeKey: '20:100', sizes: [{ value: 'dict:40', stock: 8 }] }).success).toBe(true);
    expect(ozonPresetInputSchema.safeParse({ ...input, sizes: [{ value: '', stock: 1 }, { value: '', stock: 2 }] }).success).toBe(false);
    expect(ozonPresetInputSchema.safeParse({ ...input, sizeAttributeKey: '4298:0', sizes: [{ value: 'dict:40', stock: 8 }, { value: 'dict:40', stock: 5 }] }).success).toBe(false);
    const repeatedSizeId = randomUUID();
    expect(ozonPresetInputSchema.safeParse({
      ...input,
      sizeAttributeKey: '4298:0',
      sizes: [
        { sizeId: repeatedSizeId, value: 'dict:40', stock: 8 },
        { sizeId: repeatedSizeId, value: 'dict:41', stock: 5 }
      ]
    }).success).toBe(false);
  });

  it('accepts only shared material fields before a store publication is materialized', () => {
    const variantId = randomUUID();
    const media = Array.from({ length: 8 }, (_, index) => ({
      assetId: `asset-${index}`,
      relativePath: index === 7 ? 'variants/black/videos/main.mp4' : `variants/black/images/${index + 1}.png`,
      kind: index === 7 ? 'video' as const : 'image' as const,
      sortOrder: index,
      isPrimary: index === 0
    }));
    const input = {
      rowVersion: 3,
      descriptionRu: 'Общее описание товара.',
      variants: [{
        variantId,
        productVariantId: variantId,
        productVariantName: '黑色',
        descriptionRu: 'Описание черного варианта.',
        media
      }]
    };
    expect(ozonSharedMaterialDraftInputSchema.safeParse(input).success).toBe(true);
    expect(ozonSharedMaterialDraftInputSchema.safeParse({ ...input, mediaAssets: [] }).success).toBe(false);
    expect(ozonSharedMaterialDraftInputSchema.safeParse({ ...input, categoryKey: 'ozon_1_2' }).success).toBe(false);
    expect(ozonSharedMaterialDraftInputSchema.safeParse({ ...input, currency: 'RUB' }).success).toBe(false);
    expect(ozonSharedMaterialDraftInputSchema.safeParse({ ...input, stock: 10 }).success).toBe(false);
  });

  it('projects and canonicalizes only stable shared material fields', () => {
    const variantId = randomUUID();
    const productVariantId = randomUUID();
    const assetId = 'e005-image-1';
    const listing = {
      sku: '0000132',
      productName: '测试公共素材',
      managementSource: 'AUTO',
      status: 'DRAFT',
      rowVersion: 2,
      revision: 2,
      data: {
        categoryKey: 'ozon_1_2',
        warehouseId: 'warehouse-a',
        currency: 'RUB',
        vat: '0.2',
        descriptionRu: 'Описание с аналогичным тисненым рисунком',
        sharedAttributes: [{ attributeId: 1, complexId: 0, values: [{ value: 'market-only' }] }],
        mediaSourceRoot: 'G:/01_MerchRoute/OZON-Auto-Publish/inbox/0000132',
        mediaAssets: [{
          assetId,
          relativePath: 'variants/black/images/01.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: 128,
          sha256: 'a'.repeat(64),
          modifiedAt: '2026-08-13T00:00:00.000Z',
          validationStatus: 'VALID',
          productVariantId,
          productVariantName: '黑色',
          sourceStageId: 'E005',
          sourceSubmissionId: 'submission-e005'
        }],
        offers: [{
          variantId,
          productVariantId,
          productVariantName: '黑色',
          variantCode: '01',
          offerId: '0000132-01',
          price: 2_990,
          stock: 8,
          attributes: [{ attributeId: 2, complexId: 0, values: [{ value: 'market-only' }] }],
          descriptionRu: 'Описание с аналогичным тисненым рисунком',
          media: [{ assetId, relativePath: 'variants/black/images/01.png', kind: 'image', sortOrder: 0, isPrimary: true }]
        }],
        initialization: {
          status: 'PARTIAL',
          initializedAt: '2026-08-13T00:00:00.000Z',
          issues: [{ code: 'MEDIA_PENDING', message: '等待视频', retryable: true }],
          presetSnapshot: { shouldNeverHash: true }
        }
      },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    } as unknown as OzonListingDraft;

    const projected = projectOzonSharedMaterialDraft(listing, OZON_CONTENT_POLICY_V3);
    expect(projected).toMatchObject({
      schemaVersion: 1,
      hashVersion: OZON_SHARED_MATERIAL_HASH_VERSION,
      contentPolicyVersion: OZON_CONTENT_POLICY_V3,
      sku: '0000132',
      materialRevision: 2,
      variants: [{ variantId, productVariantId, media: [{ sortOrder: 0 }] }],
      initializationIssues: [{ code: 'MEDIA_PENDING' }]
    });
    expect(projected.mediaAssets).toEqual([expect.objectContaining({ assetId, sha256: 'a'.repeat(64) })]);
    expect(projected.variants[0]?.media.map((item) => item.assetId)).toEqual([assetId]);
    expect(projected).not.toHaveProperty('categoryKey');
    expect(projected).not.toHaveProperty('warehouseId');
    expect(projected.variants[0]).not.toHaveProperty('price');
    expect(projected.variants[0]).not.toHaveProperty('stock');
    expect(projected.variants[0]).not.toHaveProperty('attributes');

    const changedMarketplaceOnly = {
      ...listing,
      data: {
        ...listing.data,
        categoryKey: 'ozon_9_9',
        warehouseId: 'warehouse-b',
        currency: 'CNY',
        offers: listing.data.offers.map((item) => ({ ...item, price: 9_999, stock: 99 }))
      }
    };
    expect(canonicalOzonSharedMaterialJson(projectOzonSharedMaterialDraft(changedMarketplaceOnly, OZON_CONTENT_POLICY_V3)))
      .toBe(canonicalOzonSharedMaterialJson(projected));

    expect(ozonSharedMaterialProjectionSchema.safeParse({ ...projected, currency: 'RUB' }).success).toBe(false);
    expect(ozonSharedMaterialProjectionSchema.safeParse({ ...projected, contentPolicyVersion: 'LEGACY_UNKNOWN' }).success).toBe(false);
    expect(ozonSharedMaterialRevisionMetadataSchema.safeParse({
      generatedVersionId: randomUUID(),
      materialRevision: 2,
      rowVersion: 2,
      materialHash: `sha256:${'b'.repeat(64)}`,
      materialHashVersion: OZON_SHARED_MATERIAL_HASH_VERSION,
      dataSignature: `sha256:${'c'.repeat(64)}`,
      contentPolicyVersion: OZON_CONTENT_POLICY_V3
    }).success).toBe(true);
  });

  it('keeps historical initialization compatible and validates gross-weight audit semantics', () => {
    const initializedAt = '2026-08-07T02:00:00.000Z';
    const historical = ozonListingInitializationSchema.parse({
      status: 'COMPLETE',
      initializedAt,
      issues: []
    });
    expect(historical).not.toHaveProperty('grossWeightResolution');
    expect(historical).not.toHaveProperty('presetSnapshot');

    const procurement = {
      source: 'PROCUREMENT' as const,
      effectiveGrossWeightGrams: 650.5,
      procurementGrossWeightGrams: 650.5,
      presetGrossWeightGrams: 800,
      procurementVersionId: randomUUID(),
      procurementVersionNo: 3,
      procurementCapturedAt: initializedAt
    };
    const presetDefinition = {
      name: 'OZON 默认预设',
      categoryKey: 'ozon_1_2',
      pricingTemplateId: randomUUID(),
      shippingTemplateId: randomUUID(),
      shippingServiceCode: 'CEL_RFBS_ECONOMY',
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm' as const, weight: 0.8, weightUnit: 'kg' as const }
    };
    const managed = ozonListingInitializationSchema.safeParse({
      status: 'COMPLETE',
      initializedAt,
      issues: [],
      grossWeightResolution: procurement,
      presetSnapshot: {
        presetId: randomUUID(),
        presetName: presetDefinition.name,
        presetRowVersion: 5,
        capturedAt: initializedAt,
        definition: presetDefinition
      }
    });
    expect(managed.success).toBe(true);

    expect(ozonGrossWeightResolutionSchema.safeParse({
      ...procurement,
      effectiveGrossWeightGrams: 649
    }).success).toBe(false);
    expect(ozonGrossWeightResolutionSchema.safeParse({
      ...procurement,
      source: 'PRESET_FALLBACK',
      effectiveGrossWeightGrams: 800
    }).success).toBe(false);
    expect(ozonGrossWeightResolutionSchema.safeParse({
      ...procurement,
      source: 'PRESET_FALLBACK',
      procurementGrossWeightGrams: null,
      effectiveGrossWeightGrams: 799
    }).success).toBe(false);
    expect(ozonGrossWeightResolutionSchema.safeParse({
      ...procurement,
      source: 'PRESET_FALLBACK',
      procurementGrossWeightGrams: null,
      effectiveGrossWeightGrams: 800
    }).success).toBe(true);
  });

  it('enforces OZON media, price and primary-image boundaries', () => {
    expect(ozonOfferSchema.safeParse({ ...offer, media: [] }).success).toBe(true);
    expect(ozonOfferSchema.safeParse({ ...offer, media: media(15) }).success).toBe(true);
    expect(ozonOfferSchema.safeParse({ ...offer, media: media(16) }).success).toBe(false);
    expect(ozonOfferSchema.safeParse({ ...offer, media: [...media(1), video, { ...video, assetId: 'video-2', relativePath: 'variants/shared/videos/second.mp4' }] }).success).toBe(false);
    expect(ozonOfferSchema.safeParse({ ...offer, oldPrice: 2_000 }).success).toBe(false);
    expect(ozonOfferSchema.safeParse({ ...offer, minPrice: 3_500 }).success).toBe(false);
    expect(ozonOfferSchema.safeParse({
      ...offer,
      media: [
        { ...media(2)[0], isPrimary: true },
        { ...media(2)[1], isPrimary: true }
      ]
    }).success).toBe(false);
  });

  it('validates the portable product.json v1 contract', () => {
    const product = {
      schemaVersion: 1,
      storeAlias: 'default',
      productCode: '0000010',
      productName: '测试商品',
      revision: 1,
      fulfillmentMode: 'FBS',
      warehouseId: '10001',
      category: {
        categoryKey: 'adult_sneakers',
        descriptionCategoryId: 17028922,
        typeId: 970642857,
        templateVersion: 1,
        schemaHash: `sha256:${'a'.repeat(64)}`
      },
      currency: 'RUB',
      vat: '0.2',
      titleRu: 'Тестовый товар',
      descriptionRu: 'Описание товара',
      brand: '',
      dimensions: {
        length: 300,
        width: 200,
        height: 120,
        dimensionUnit: 'mm',
        weight: 700,
        weightUnit: 'g'
      },
      sharedAttributes: [],
      offers: [{ ...offer, media: [...media(2), video] }]
    };
    expect(ozonProductV1Schema.safeParse(product).success).toBe(true);
    expect(ozonProductV1Schema.safeParse({
      ...product,
      offers: [
        product.offers[0],
        {
          ...product.offers[0],
          variantId: randomUUID(),
          variantCode: '02',
          offerId: '0000010-02'
        }
      ]
    }).success).toBe(true);
    expect(ozonProductV1Schema.safeParse({
      ...product,
      offers: [{ ...offer, media: [] }]
    }).success).toBe(false);
    expect(ozonProductV1Schema.safeParse({
      ...product,
      offers: [{ ...offer, media: media(2) }]
    }).success).toBe(false);
    expect(ozonProductV1Schema.safeParse({
      ...product,
      category: { ...product.category, schemaHash: 'not-a-hash' }
    }).success).toBe(false);
  });

  it('accepts compatible v1/v2 product contracts and enforces the v2 same-MP4 policy', () => {
    const base = {
      storeAlias: 'default',
      productCode: '0000010',
      productName: '测试商品',
      revision: 2,
      fulfillmentMode: 'FBS',
      warehouseId: '10001',
      category: {
        categoryKey: 'adult_sneakers',
        descriptionCategoryId: 17028922,
        typeId: 970642857,
        templateVersion: 2,
        schemaHash: `sha256:${'a'.repeat(64)}`
      },
      currency: 'RUB',
      vat: '0.2',
      titleRu: 'Тестовый товар',
      descriptionRu: 'Описание товара',
      brand: '',
      dimensions: {
        length: 300,
        width: 200,
        height: 120,
        dimensionUnit: 'mm',
        weight: 700,
        weightUnit: 'g'
      },
      sharedAttributes: [],
      mediaAssets: [
        {
          assetId: 'asset-0',
          relativePath: 'images/1.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: 100,
          sha256: '1'.repeat(64)
        },
        {
          assetId: 'asset-1',
          relativePath: 'images/2.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: 101,
          sha256: '2'.repeat(64)
        },
        {
          assetId: 'video-1',
          relativePath: 'variants/shared/videos/main.mp4',
          kind: 'video',
          mimeType: 'video/mp4',
          sizeBytes: 102,
          sha256: '3'.repeat(64),
          durationSeconds: 10
        }
      ],
      offers: [{ ...offer, titleRu: 'Тестовый товар', media: [...media(2), video] }]
    };
    const v2 = {
      ...base,
      schemaVersion: 2,
      mediaCapabilities: {
        videoCover: { complexId: 100002, attributeId: 21845 },
        productIntroductionVideo: {
          complexId: 100001,
          linkAttributeId: 21841,
          titleAttributeId: 21837
        }
      },
      videoPolicy: {
        source: 'SAME_MP4',
        titleSource: 'OFFER_TITLE_RU',
        mode: 'INTRO_AND_COVER'
      }
    };
    expect(ozonProductV2Schema.safeParse(v2).success).toBe(true);
    expect(ozonProductSchema.safeParse(v2).success).toBe(true);
    const withLocalIdentity = ozonProductV2Schema.parse({
      ...v2,
      offers: [{
        ...v2.offers[0],
        productVariantId: randomUUID(),
        productVariantName: '黑色',
        productVariantColor: { colorKey: 'f'.repeat(64), nameRu: 'черный', nameZh: '黑色' }
      }]
    });
    expect(withLocalIdentity.offers[0]).not.toHaveProperty('productVariantId');
    expect(withLocalIdentity.offers[0]).not.toHaveProperty('productVariantName');
    expect(withLocalIdentity.offers[0]).not.toHaveProperty('productVariantColor');
    expect(ozonProductV2Schema.safeParse({
      ...v2,
      mediaCapabilities: { videoCover: v2.mediaCapabilities.videoCover }
    }).success).toBe(false);
    expect(ozonProductV2Schema.safeParse({
      ...v2,
      videoPolicy: { ...v2.videoPolicy, mode: 'COVER_ONLY' }
    }).success).toBe(false);
    expect(ozonProductV2Schema.safeParse({
      ...v2,
      videoPolicy: { ...v2.videoPolicy, mode: 'COVER_ONLY' },
      mediaCapabilities: { videoCover: v2.mediaCapabilities.videoCover }
    }).success).toBe(true);
    expect(ozonProductV2Schema.safeParse({
      ...v2,
      offers: [{ ...base.offers[0], titleRu: '' }]
    }).success).toBe(false);
    expect(ozonProductV2Schema.safeParse({
      ...v2,
      mediaAssets: v2.mediaAssets.filter((asset) => asset.assetId !== 'video-1')
    }).success).toBe(false);
  });

  it('checks every offer against category-level dynamic required attributes', () => {
    const attributes = [
      { id: 10, name: '品牌', type: 'String' as const, required: true, complexId: 0 },
      { id: 20, name: '尺码', type: 'Dictionary' as const, required: true, complexId: 100 },
      { id: 30, name: '说明', type: 'String' as const, required: false, complexId: 0 }
    ];
    const sharedAttributes = [{ attributeId: 10, complexId: 0, values: [{ value: 'MerchRoute' }] }];
    const offers = [
      { offerId: '0000010-BLACK-40', attributes: [{ attributeId: 20, complexId: 100, values: [{ dictionaryValueId: 40 }] }] },
      { offerId: '0000010-WHITE-41', attributes: [] }
    ];
    expect(findMissingOzonRequiredAttributes(attributes, sharedAttributes, offers)).toEqual([
      { offerId: '0000010-WHITE-41', attributeIds: [20] }
    ]);
  });

  it('projects required preset attributes to PRESET, SIZE, COLOR and SYSTEM sources', () => {
    const category = {
      sizing: { sizeMode: 'sized' as const, sizeAttributeKey: '4298:0' },
      attributes: [
        { id: 31, complexId: 0, name: 'Бренд в одежде и обуви', nameRu: 'Бренд в одежде и обуви', nameZh: '服装和鞋类品牌', required: true },
        { id: 9163, complexId: 0, name: 'Пол', nameRu: 'Пол', nameZh: '性别', required: true },
        { id: 8292, complexId: 0, name: 'Объединить на одной карточке', nameRu: 'Объединить на одной карточке', nameZh: '合并至一张卡片', required: true },
        { id: 4298, complexId: 0, name: 'Российский размер', nameRu: 'Российский размер', nameZh: '俄罗斯尺码', required: true },
        { id: 10096, complexId: 0, name: 'Цвет товара', nameRu: 'Цвет товара', nameZh: '商品颜色', required: true },
        { id: 9999, complexId: 0, name: '可选', required: false }
      ] as any
    };
    const preset = {
      sharedAttributes: [{ attributeId: 9163, complexId: 0, values: [{ dictionaryValueId: 22880 }] }],
      variantAttributes: [],
      sizeAttributeKey: '4298:0',
      sizes: [{ value: 'dict:23539', stock: 1 }]
    };

    const coverage = projectOzonPresetRequiredAttributeCoverage(category, preset);
    expect(coverage.map((attribute) => [attribute.attributeId, attribute.source, attribute.covered])).toEqual([
      [31, 'SYSTEM', true],
      [9163, 'PRESET', true],
      [8292, 'SYSTEM', true],
      [4298, 'SIZE', true],
      [10096, 'COLOR', true]
    ]);
    expect(coverage.find((attribute) => attribute.attributeId === 31)?.systemValue).toMatchObject({
      kind: 'NO_BRAND', labelRu: 'Нет бренда'
    });
    expect(coverage.find((attribute) => attribute.attributeId === 8292)?.systemValue?.kind).toBe('MAIN_SKU');
  });

  it('reports an uncovered required preset value with its bilingual name and id', () => {
    const missing = findUncoveredOzonPresetRequiredAttributes({
      sizing: { sizeMode: 'sizeless' },
      attributes: [{ id: 9163, complexId: 0, name: 'Пол', nameRu: 'Пол', nameZh: '性别', required: true }] as any
    }, {
      sharedAttributes: [], variantAttributes: [], sizeAttributeKey: null, sizes: [{ value: '', stock: 1 }]
    });
    expect(missing).toMatchObject([{
      attributeId: 9163,
      source: 'PRESET',
      covered: false,
      nameRu: 'Пол',
      nameZh: '性别'
    }]);
    expect(missing[0]?.reason).toContain('性别 / Пол · #9163');
  });

  it('reserves OZON video attributes for system-generated complex media payloads', () => {
    expect([21837, 21841, 21845, 22273].every(isOzonSystemMediaAttributeId)).toBe(true);
    expect(isOzonSystemMediaAttributeId(10097)).toBe(false);
    expect(findMissingOzonRequiredAttributes(
      [
        { id: 21845, name: 'Ozon.Video cover', type: 'String', required: true, complexId: 100002 },
        { id: 21841, name: 'Ozon.Video link', type: 'String', required: true, complexId: 100001 }
      ] as any,
      [],
      [{ offerId: '0000010-01', attributes: [] }]
    )).toEqual([]);
  });

  it('validates the explicit compatible-append plan and confirmation hashes', () => {
    const variantId = randomUUID();
    const hash = `sha256:${'a'.repeat(64)}`;
    const plan = {
      mode: 'COMPATIBLE_APPEND',
      sku: '0000105',
      rowVersion: 17,
      planHash: hash,
      manifestSignature: `sha256:${'b'.repeat(64)}`,
      canAppend: true,
      preservedOffers: [{ offerId: '0000105-01', variantId, variantName: '卡其色', ozonProductId: '123', ozonSku: '456' }],
      newOffers: [{ offerId: '0000105-02', variantId: randomUUID(), variantName: '黑色', imageCount: 7, hasVideo: true }],
      preservedOfferIds: ['0000105-01'],
      submittedOfferIds: ['0000105-02']
    };
    expect(ozonCompatibleAppendPlanSchema.safeParse(plan).success).toBe(true);
    expect(ozonCompatibleAppendInputSchema.safeParse({ rowVersion: 17, planHash: hash }).success).toBe(true);
    expect(ozonCompatibleAppendInputSchema.safeParse({ rowVersion: 17, planHash: 'stale' }).success).toBe(false);
  });
});
