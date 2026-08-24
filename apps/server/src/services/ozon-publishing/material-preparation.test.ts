import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertCompatibleOzonOfferMediaComplete,
  completeOzonAutoMaterialSnapshot,
  createOzonAutoMaterialSnapshot,
  createOzonCompatibleAppendManifestSignature,
  createOzonCompatibleAppendPlan,
  createOzonCompatibleIdentityPlan,
  mergeCompatibleOzonOffers,
  mergeOzonManagedAttributes,
  normalizeOzonNoBrandForPlatform,
  prepareOzonManagedSharedAttributes
} from './material-preparation.js';

const categoryAttributes = [85, 9024, 9048, 4180, 4191, 8229].map((id) => ({
  id,
  complexId: 0,
  type: 'String',
  required: false
}));

describe('OZON shared material preparation', () => {
  it('makes compatible-append signatures sensitive to manifest image order', () => {
    const base = {
      assetId: 'image-1',
      relativePath: 'variants/red/01.png',
      kind: 'image',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      modifiedAt: '2026-08-10T01:00:00.000Z',
      validationStatus: 'VALID',
      productVariantId: randomUUID(),
      sourceStageId: 'E005',
      sourceSubmissionId: 'ordered-images'
    };

    expect(createOzonCompatibleAppendManifestSignature([{ ...base, sortOrder: 0 }] as any))
      .not.toBe(createOzonCompatibleAppendManifestSignature([{ ...base, sortOrder: 1 }] as any));
  });

  it('forces no-brand only for initialization and preserves a manual brand for platform generation', () => {
    const manualBrand = [{ attributeId: 85, complexId: 0, values: [{ value: 'Acme' }] }];
    const preserved = prepareOzonManagedSharedAttributes({
      categoryAttributes,
      attributes: manualBrand,
      sku: '0000051',
      typeId: 97001,
      titleRu: 'Название',
      descriptionRu: 'Описание',
      brandMode: 'PRESERVE_OR_DEFAULT'
    });
    expect(preserved.find((attribute) => attribute.attributeId === 85)?.values).toEqual([{ value: 'Acme' }]);
    expect(normalizeOzonNoBrandForPlatform(preserved, categoryAttributes)
      .find((attribute) => attribute.attributeId === 85)?.values).toEqual([{ value: 'Acme' }]);

    const forced = prepareOzonManagedSharedAttributes({
      categoryAttributes,
      attributes: manualBrand,
      sku: '0000051',
      typeId: 97001,
      brandMode: 'FORCE_NO_BRAND'
    });
    expect(normalizeOzonNoBrandForPlatform(forced, categoryAttributes)
      .find((attribute) => attribute.attributeId === 85)?.values).toEqual([{ dictionaryValueId: 126745801 }]);
    expect(forced).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 9024, values: [{ value: '0000051' }] }),
      expect.objectContaining({ attributeId: 9048, values: [{ value: '0000051' }] }),
      expect.objectContaining({ attributeId: 8229 })
    ]));
  });

  it('materializes footwear no-brand #31 and stable main-SKU grouping #8292', () => {
    const footwearAttributes = [
      { id: 31, complexId: 0, type: 'String', required: true, dictionaryId: 28732849 },
      { id: 8292, complexId: 0, type: 'String', required: true, dictionaryId: 0 }
    ] as any;
    const prepared = prepareOzonManagedSharedAttributes({
      categoryAttributes: footwearAttributes,
      attributes: [
        { attributeId: 31, complexId: 0, values: [{ value: '旧品牌' }] },
        { attributeId: 8292, complexId: 0, values: [{ value: '不稳定分组' }] }
      ],
      sku: '0000152',
      typeId: 91248,
      brandMode: 'PRESERVE_OR_DEFAULT',
      brandValue: '无品牌'
    });
    const platform = normalizeOzonNoBrandForPlatform(prepared, footwearAttributes);

    expect(platform.find((attribute) => attribute.attributeId === 31)?.values)
      .toEqual([{ dictionaryValueId: 126745801 }]);
    expect(platform.find((attribute) => attribute.attributeId === 8292)?.values)
      .toEqual([{ value: '0000152' }]);
    expect(JSON.stringify(platform)).not.toContain('不稳定分组');
  });

  it('refreshes only the explicit shared managed fields', () => {
    const existing = [
      { attributeId: 85, complexId: 0, values: [{ value: '人工品牌' }] },
      { attributeId: 777, complexId: 0, values: [{ value: '人工普通属性' }] },
      { attributeId: 4180, complexId: 0, values: [{ value: '旧标题' }] },
      { attributeId: 5299, complexId: 0, values: [{ value: '99' }] }
    ];
    const planned = [
      { attributeId: 85, complexId: 0, values: [{ value: '无品牌' }] },
      { attributeId: 777, complexId: 0, values: [{ value: '自动值' }] },
      { attributeId: 4180, complexId: 0, values: [{ value: '保留后的人工标题' }] }
    ];
    const merged = mergeOzonManagedAttributes(existing, planned, new Set([4180, 5299]));
    expect(merged.find((attribute) => attribute.attributeId === 85)?.values).toEqual([{ value: '人工品牌' }]);
    expect(merged.find((attribute) => attribute.attributeId === 777)?.values).toEqual([{ value: '人工普通属性' }]);
    expect(merged.find((attribute) => attribute.attributeId === 4180)?.values).toEqual([{ value: '保留后的人工标题' }]);
    expect(merged.find((attribute) => attribute.attributeId === 5299)).toBeUndefined();
  });

  it('shares title validation and normalizes only the outbound description value', () => {
    const description = 'Первая строка\\n<ul><li>Преимущество</li></ul>';
    const prepared = prepareOzonManagedSharedAttributes({
      categoryAttributes,
      attributes: [],
      sku: '0000051',
      typeId: 97001,
      titleRu: 'Универсальная сумка через плечо для повседневного использования',
      descriptionRu: description
    });
    expect(prepared.find((attribute) => attribute.attributeId === 4180)?.values[0]?.value)
      .toBe('Универсальная сумка через плечо для повседневного использования');
    expect(prepared.find((attribute) => attribute.attributeId === 4191)?.values[0]?.value)
      .toBe('Первая строка<br><ul><li>Преимущество</li></ul>');
  });

  it('accepts representative 0000105/0000106 prose with normally dispersed repeated product words', () => {
    const descriptions = [
      [
        'Сумка', 'мягкая', 'фактура', 'золотистого', 'оттенка', 'удобные', 'ручки',
        'сумка', 'прочная', 'молния', 'внутренняя', 'подкладка', 'ровные', 'строчки',
        'сумка', 'регулируемый', 'ремень', 'золотистого', 'цвета', 'надежная', 'застежка',
        'сумка', 'вместительное', 'отделение', 'карман', 'снаружи', 'устойчивое', 'основание',
        'сумка', 'лаконичный', 'дизайн', 'золотистого', 'декора', 'подходит', 'ежедневно'
      ].join(' '),
      [
        'Сумка', 'выполнена', 'аккуратно', 'приятная', 'поверхность', 'сохраняет', 'форму',
        'сумка', 'оснащена', 'ремнем', 'мягкими', 'краями', 'удобной', 'ручкой',
        'сумка', 'имеет', 'основное', 'отделение', 'потайной', 'карман', 'подкладку',
        'сумка', 'подходит', 'деловым', 'образам', 'вечерним', 'встречам', 'прогулкам',
        'сумка', 'сочетается', 'платьями', 'костюмами', 'пальто', 'обувью', 'аксессуарами'
      ].join(' ')
    ];
    descriptions.forEach((description, index) => {
      const prepared = prepareOzonManagedSharedAttributes({
        categoryAttributes,
        attributes: [],
        sku: index === 0 ? '0000105' : '0000106',
        typeId: 97001,
        titleRu: index === 0 ? 'Женская сумка золотистого цвета' : 'Женская сумка через плечо',
        descriptionRu: description
      });
      expect(prepared.find((attribute) => attribute.attributeId === 4191)?.values[0]?.value).toBe(description);
    });
  });

  it('turns content-contract failures into non-retryable configuration errors', () => {
    try {
      prepareOzonManagedSharedAttributes({
        categoryAttributes,
        attributes: [],
        sku: '0000051',
        typeId: 97001,
        titleRu: '中文标题',
        descriptionRu: 'Описание товара'
      });
      throw new Error('expected content policy to reject the title');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        statusCode: 422,
        details: { fieldPath: 'titleRu', retryable: false, issues: expect.arrayContaining(['CJK']) }
      });
    }
  });

  it('preserves every existing offer and its human fields while refreshing managed offer values', () => {
    const existing = [offer('01', 'existing-a', 100), offer('02', 'unmatched-b', 200)];
    existing[0]!.barcode = '460000000001';
    existing[0]!.descriptionRu = 'Ручное описание';
    existing[0]!.attributes = [{ attributeId: 10097, complexId: 0, values: [{ value: 'ручной цвет' }] }];
    const planned = [offer('01', 'planned-new-id', 999)];
    planned[0]!.variantId = existing[0]!.variantId;
    planned[0]!.attributes = [{ attributeId: 10097, complexId: 0, values: [{ value: 'авто цвет' }] }];

    const merged = mergeCompatibleOzonOffers(existing as any, planned as any);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      offerId: '0000051-01',
      barcode: '460000000001',
      descriptionRu: 'Ручное описание',
      price: 999,
      stock: 4,
      attributes: [{ attributeId: 10097, values: [{ value: 'ручной цвет' }] }]
    });
    expect(merged[1]).toMatchObject({ variantId: existing[1]!.variantId, offerId: '0000051-02', price: 200 });
  });

  it('stops compatible updates instead of silently appending a planned-only offer', () => {
    const existing = [offer('01', 'existing-a', 100)];
    const matched = offer('01', 'planned-match', 999);
    matched.variantId = existing[0]!.variantId;
    const newOffer = offer('02', 'planned-new', 999);

    expect(() => mergeCompatibleOzonOffers(existing as any, [matched, newOffer] as any)).toThrow(
      expect.objectContaining({
        code: 'VERSION_CONFLICT',
        details: expect.objectContaining({ reasonCode: 'OZON_COMPATIBLE_NEW_OFFER_NOT_ALLOWED' })
      })
    );
  });

  it('appends a new offer only with the explicit compatible-new-offer capability', () => {
    const existing = [offer('01', 'existing-a', 100)];
    existing[0]!.descriptionRu = 'Сохраненное описание хаки';
    const matched = offer('01', 'planned-match', 999);
    matched.variantId = existing[0]!.variantId;
    matched.descriptionRu = 'Не должно заменить существующее описание';
    const newOffer = offer('02', 'planned-new', 888);
    newOffer.descriptionRu = 'Отдельное описание черного варианта';

    const merged = mergeCompatibleOzonOffers(existing as any, [matched, newOffer] as any, { allowNewOffers: true });

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      offerId: '0000051-01',
      descriptionRu: 'Сохраненное описание хаки',
      price: 999
    });
    expect(merged[1]).toMatchObject({
      offerId: '0000051-02',
      descriptionRu: 'Отдельное описание черного варианта',
      price: 888
    });
  });

  it('classifies incomplete existing media as an immediate version conflict', () => {
    const existing = offer('01', 'existing', 100);
    existing.media = [{ assetId: 'missing', relativePath: 'missing.png', kind: 'image', sortOrder: 0, isPrimary: true }];
    expect(() => assertCompatibleOzonOfferMediaComplete([existing] as any, []))
      .toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  });

  it('creates the exact versioned material snapshot and completes its artifact identity', () => {
    const capturedAt = '2026-08-07T02:03:04.000Z';
    const snapshot = createOzonAutoMaterialSnapshot({
      capturedAt,
      preset: { id: randomUUID(), name: '自动预设', rowVersion: 3, definition: { b: 2, a: 1 } },
      category: { key: 'ozon_17001_97001', versionId: randomUUID(), versionNo: 4, schemaHash: `sha256:${'a'.repeat(64)}` },
      procurement: {
        id: randomUUID(), versionNo: 7, createdAt: capturedAt,
        productHeightCm: '10.5', productDepthCm: '20', productWidthCm: '30', netWeightGrams: '450.25'
      },
      packaging: {
        length: 300, width: 200, height: 100, dimensionUnit: 'mm',
        weight: 0.8, weightUnit: 'kg', grossWeightSource: 'PROCUREMENT'
      },
      pricing: { pricingTemplateId: 'pricing', shippingTemplateId: 'shipping', shippingServiceCode: 'CEL', optionId: 'option-1' },
      store: { storeAlias: 'default', warehouseId: '10001', currency: 'RUB', fulfillmentMode: 'FBS' },
      offerIds: ['0000051-02', '0000051-01', '0000051-01'],
      warnings: []
    });
    expect(snapshot).toEqual({
      schemaVersion: 1,
      capturedAt,
      preset: expect.objectContaining({ name: '自动预设', rowVersion: 3, definitionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }),
      category: expect.objectContaining({ key: 'ozon_17001_97001', versionNo: 4 }),
      procurement: expect.objectContaining({
        versionNo: 7, capturedAt, productHeightCm: 10.5, productDepthCm: 20, productWidthCm: 30, netWeightGrams: 450.25
      }),
      packaging: { lengthCm: 30, widthCm: 20, heightCm: 10, grossWeightGrams: 800, grossWeightSource: 'PROCUREMENT' },
      pricing: { pricingTemplateId: 'pricing', shippingTemplateId: 'shipping', shippingServiceCode: 'CEL', optionId: 'option-1' },
      store: { storeAlias: 'default', warehouseId: '10001', currency: 'RUB', fulfillmentMode: 'FBS' },
      offers: { count: 2, ids: ['0000051-02', '0000051-01'] },
      artifact: { revision: null, signature: null },
      warnings: []
    });
    expect(completeOzonAutoMaterialSnapshot(snapshot, {
      revision: 8,
      signature: `sha256:${'b'.repeat(64)}`,
      offerIds: ['0000051-01']
    })).toMatchObject({
      offers: { count: 1, ids: ['0000051-01'] },
      artifact: { revision: 8, signature: `sha256:${'b'.repeat(64)}` }
    });
  });

  it('plans a scoped compatible append without requiring archived media for preserved offers', () => {
    const preservedVariantId = deterministicUuid('preserved-variant');
    const appendedVariantId = deterministicUuid('appended-variant');
    const preserved: any = offer('01', 'preserved-offer', 100);
    preserved.productVariantId = preservedVariantId;
    preserved.productVariantName = '卡其色';
    const mediaAssets = [
      mediaAsset('new-image-1', appendedVariantId, 'image', 'variants/黑色/images/new/01.png'),
      mediaAsset('new-image-2', appendedVariantId, 'image', 'variants/黑色/images/new/02.png'),
      mediaAsset('new-video', appendedVariantId, 'video', 'variants/黑色/videos/new/video.mp4')
    ];
    const listing = {
      sku: '0000051', productName: '测试商品', status: 'PUBLISHED', rowVersion: 7, revision: 2,
      data: { offers: [preserved], mediaAssets: [], mediaSourceRoot: '', titleRu: '', descriptionRu: '' },
      ozonProductLinks: [{ offerId: '0000051-01', ozonProductId: '123456', ozonSku: '987654', url: 'https://www.ozon.ru/product/987654/' }],
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z'
    } as any;

    const binding = {
      settingsRowVersion: 11,
      rootDirectoryFingerprint: `sha256:${'c'.repeat(64)}`,
      credentialReady: true,
      taskApiWebhookReady: true,
      adminApiWebhookReady: true,
      productIdentityHash: `sha256:${'d'.repeat(64)}`,
      presetId: 'preset-1',
      presetRowVersion: 2
    };
    const plan = createOzonCompatibleAppendPlan({
      listing,
      productVariants: [
        { variantId: preservedVariantId, name: '卡其色' },
        { variantId: appendedVariantId, name: '黑色' }
      ],
      currentMediaAssets: mediaAssets as any,
      binding
    });
    const changedSettingsPlan = createOzonCompatibleAppendPlan({
      listing,
      productVariants: [
        { variantId: preservedVariantId, name: '卡其色' },
        { variantId: appendedVariantId, name: '黑色' }
      ],
      currentMediaAssets: mediaAssets as any,
      binding: { ...binding, settingsRowVersion: 12 }
    });
    const changedIdentityPlan = createOzonCompatibleAppendPlan({
      listing,
      productVariants: [
        { variantId: preservedVariantId, name: '卡其色' },
        { variantId: appendedVariantId, name: '黑色' }
      ],
      currentMediaAssets: mediaAssets as any,
      binding: { ...binding, productIdentityHash: `sha256:${'e'.repeat(64)}` }
    });

    expect(plan).toMatchObject({
      mode: 'COMPATIBLE_APPEND',
      canAppend: true,
      preservedOfferIds: ['0000051-01'],
      submittedOfferIds: ['0000051-02'],
      preservedOffers: [{ offerId: '0000051-01', variantId: preservedVariantId, ozonProductId: '123456', ozonSku: '987654' }],
      newOffers: [{ offerId: '0000051-02', variantId: appendedVariantId, variantName: '黑色', imageCount: 2, hasVideo: true }]
    });
    expect(plan.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(changedSettingsPlan.planHash).not.toBe(plan.planHash);
    expect(changedIdentityPlan.planHash).not.toBe(plan.planHash);
    expect(plan.manifestSignature).toBe(createOzonCompatibleAppendManifestSignature(mediaAssets as any));
  });

  it('shares placeholder exclusion, missing-variant scope, preserved mapping and stable Offer identity', () => {
    const placeholderId = deterministicUuid('placeholder');
    const preservedVariantId = deterministicUuid('preserved-shared');
    const missingVariantId = deterministicUuid('missing-shared');
    const preserved: any = offer('01', 'preserved-offer-shared', 100);
    preserved.variantId = preservedVariantId;
    preserved.productVariantId = preservedVariantId;
    preserved.productVariantName = '卡其色';

    const identityPlan = createOzonCompatibleIdentityPlan({
      sku: '0000051',
      productVariants: [
        { variantId: placeholderId, name: '默认变体' },
        { variantId: preservedVariantId, name: '卡其色' },
        { variantId: missingVariantId, name: '黑色' }
      ],
      existingOffers: [preserved],
      productLinks: [{ offerId: preserved.offerId, ozonProductId: '123456', ozonSku: '987654' }]
    });

    expect(identityPlan.publicationVariants.map((variant) => variant.variantId)).toEqual([
      preservedVariantId,
      missingVariantId
    ]);
    expect(identityPlan.representedVariantIds).toEqual([preservedVariantId]);
    expect(identityPlan.missingVariants.map((variant) => variant.variantId)).toEqual([missingVariantId]);
    expect(identityPlan.incompleteMappingOfferIds).toEqual([]);
    expect(identityPlan.preservedOffers).toEqual([expect.objectContaining({
      offerId: '0000051-01',
      variantId: preservedVariantId,
      ozonProductId: '123456',
      ozonSku: '987654'
    })]);
    expect(identityPlan.offerIdentities).toEqual([{
      variantId: missingVariantId,
      variantCode: '02',
      offerId: '0000051-02',
      reused: false
    }]);

    const explicitIdentityPlan = createOzonCompatibleIdentityPlan({
      sku: '0000051',
      productVariants: [
        { variantId: placeholderId, name: '默认变体' },
        { variantId: preservedVariantId, name: '卡其色' },
        { variantId: missingVariantId, name: '黑色' }
      ],
      existingOffers: [preserved],
      productLinks: [{ offerId: preserved.offerId, ozonProductId: '123456', ozonSku: '987654' }],
      candidateOfferVariantIds: [placeholderId, missingVariantId, preservedVariantId]
    });
    expect(explicitIdentityPlan.offerIdentities).toEqual([
      {
        variantId: missingVariantId,
        variantCode: '02',
        offerId: '0000051-02',
        reused: false
      },
      {
        variantId: preservedVariantId,
        variantCode: '01',
        offerId: '0000051-01',
        reused: true
      }
    ]);
  });

  it('blocks compatible append when a platform mapping or new-variant media contract is incomplete', () => {
    const preservedVariantId = deterministicUuid('preserved-variant');
    const appendedVariantId = deterministicUuid('appended-variant');
    const preserved: any = offer('01', 'preserved-offer', 100);
    preserved.productVariantId = preservedVariantId;
    const listing = {
      sku: '0000051', productName: '测试商品', status: 'PUBLISHED', rowVersion: 7, revision: 2,
      data: { offers: [preserved], mediaAssets: [], mediaSourceRoot: '', titleRu: '', descriptionRu: '' },
      ozonProductLinks: [{ offerId: '0000051-01', ozonProductId: '123456', url: 'https://www.ozon.ru/product/123456/' }],
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z'
    } as any;

    const plan = createOzonCompatibleAppendPlan({
      listing,
      productVariants: [
        { variantId: preservedVariantId, name: '卡其色' },
        { variantId: appendedVariantId, name: '黑色' }
      ],
      currentMediaAssets: [mediaAsset('new-image', appendedVariantId, 'image', 'variants/黑色/images/new/01.png')] as any
    });

    expect(plan.canAppend).toBe(false);
    expect(plan.blockedReason).toContain('缺少完整 productId/ozonSku');
    expect(plan.blockedReason).toContain('必须恰好包含 1 个有效视频');
  });
});

function offer(code: string, variantSeed: string, price: number) {
  return {
    variantId: deterministicUuid(variantSeed),
    variantCode: code,
    offerId: `0000051-${code}`,
    barcode: '',
    modelGroup: '0000051',
    price,
    oldPrice: price * 2,
    minPrice: price / 2,
    stock: 4,
    descriptionWarnings: [],
    attributes: [],
    media: [
      { assetId: `image-${code}`, relativePath: `variants/a/${code}.png`, kind: 'image' as const, sortOrder: 0, isPrimary: true },
      { assetId: `video-${code}`, relativePath: `variants/a/${code}.mp4`, kind: 'video' as const, sortOrder: 1, isPrimary: false }
    ]
  };
}

function mediaAsset(assetId: string, productVariantId: string, kind: 'image' | 'video', relativePath: string) {
  return {
    assetId,
    relativePath,
    kind,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    sizeBytes: 100,
    sha256: kind === 'image' ? 'a'.repeat(64) : 'b'.repeat(64),
    modifiedAt: '2026-08-08T00:00:00.000Z',
    validationStatus: 'VALID' as const,
    productVariantId
  };
}

function deterministicUuid(seed: string): string {
  const hash = createHashLike(seed);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function createHashLike(seed: string): string {
  return Buffer.from(seed.padEnd(32, '0')).toString('hex').slice(0, 32).padEnd(32, '0');
}
