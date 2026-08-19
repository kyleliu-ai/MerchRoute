import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, type OzonListingDraft } from '@n8n-media-review/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { OzonRepository } from '../../repositories/ozon.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import {
  OzonPublishingService,
  scanOzonMediaDirectory
} from './index.js';
import { OzonAutoPublishingCoordinator } from './auto-publishing.js';

const roots: string[] = [];
const SKU = '0000095';
const PRODUCT_NAME = '黄金对照商品';
const TITLE_RU = 'Сумка для ежедневного использования';
const SHARED_DESCRIPTION_RU = 'Описание кофейного варианта без лишних символов.';
const TYPE_ID = 97001;
const CATEGORY_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const PROCUREMENT_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const VARIANTS = [
  {
    variantId: '11111111-1111-4111-8111-111111111111',
    name: '咖啡色',
    colorKey: '1'.repeat(64),
    nameRu: 'кофейный',
    nameZh: '咖啡色',
    ozonValueId: 61577
  },
  {
    variantId: '22222222-2222-4222-8222-222222222222',
    name: '白色',
    colorKey: '2'.repeat(64),
    nameRu: 'белый',
    nameZh: '白色',
    ozonValueId: 61578
  }
] as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OZON manual and automatic material golden parity', () => {
  it.each([
    { label: '采购毛重优先', procurementGrossWeightGrams: '650.500', presetWeight: 800, presetWeightUnit: 'g', expectedWeight: 650.5, expectedSource: 'PROCUREMENT' },
    { label: '预设 kg 毛重兜底', procurementGrossWeightGrams: null, presetWeight: 1.25, presetWeightUnit: 'kg', expectedWeight: 1_250, expectedSource: 'PRESET_FALLBACK' }
  ])('$label：同一公共素材经同一店铺预设物化为相同 product.json V2', async (weightCase) => {
    const fixture = await createGoldenFixture(weightCase);

    const manualListing = await fixture.prepareManualListing();
    const automaticListing = await fixture.prepareAutomaticListing();

    expect(canonicalSharedMaterial(manualListing)).toEqual(
      canonicalSharedMaterial(automaticListing)
    );
    expect(manualListing.data).not.toHaveProperty('categoryKey');
    expect(manualListing.data).not.toHaveProperty('dimensions');
    expect(automaticListing.data).not.toHaveProperty('categoryKey');
    expect(automaticListing.data).not.toHaveProperty('dimensions');

    const manualGenerated = await fixture.generateManual(manualListing.rowVersion);
    const automaticGenerated = await fixture.generateAutomatic(automaticListing.rowVersion);
    const manualProduct = canonicalProductV2(manualGenerated.productJson);
    const automaticProduct = canonicalProductV2(automaticGenerated.productJson);

    expect(manualProduct).toEqual(automaticProduct);
    expect(manualProduct).toMatchObject({
      schemaVersion: 2,
      productCode: SKU,
      warehouseId: '__STORE_SCOPED__',
      currency: 'RUB',
      brand: 'Нет бренда',
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: weightCase.expectedWeight, weightUnit: 'g' }
    });

    const sharedAttributes = attributeValuesById(manualProduct.sharedAttributes);
    expect(sharedAttributes).toMatchObject({
      85: [{ dictionaryValueId: 126745801 }],
      9024: [{ value: SKU }],
      9048: [{ value: SKU }],
      4180: [{ value: TITLE_RU }],
      4191: [{ value: SHARED_DESCRIPTION_RU }],
      8229: [{ dictionaryValueId: TYPE_ID }],
      5299: [{ value: '16' }],
      6573: [{ value: '11.5' }],
      5355: [{ value: '20' }],
      4383: [{ value: '350' }]
    });

    expect(manualProduct.offers.map((offer: any) => ({
      variantCode: offer.variantCode,
      offerId: offer.offerId,
      modelGroup: offer.modelGroup,
      price: offer.price,
      oldPrice: offer.oldPrice,
      minPrice: offer.minPrice,
      stock: offer.stock,
      size: attributeValuesById(offer.attributes)[20],
      color: attributeValuesById(offer.attributes)[10096],
      colorName: attributeValuesById(offer.attributes)[10097],
      media: offer.media.map((media: any) => ({ kind: media.kind, relativePath: media.relativePath, sortOrder: media.sortOrder, isPrimary: media.isPrimary }))
    }))).toEqual([
      {
        variantCode: '01', offerId: `${SKU}-01`, modelGroup: SKU,
        price: 4_200.5, oldPrice: 5_000, minPrice: 4_000, stock: 6,
        size: [{ dictionaryValueId: 40 }], color: [{ dictionaryValueId: 61577 }], colorName: [{ value: 'кофейный' }],
        media: [
          { kind: 'image', relativePath: 'variants/coffee/images/01.png', sortOrder: 0, isPrimary: true },
          { kind: 'video', relativePath: 'variants/coffee/videos/01.mp4', sortOrder: 1, isPrimary: false }
        ]
      },
      {
        variantCode: '02', offerId: `${SKU}-02`, modelGroup: SKU,
        price: 4_200.5, oldPrice: 5_000, minPrice: 4_000, stock: 6,
        size: [{ dictionaryValueId: 40 }], color: [{ dictionaryValueId: 61578 }], colorName: [{ value: 'белый' }],
        media: [
          { kind: 'image', relativePath: 'variants/white/images/01.png', sortOrder: 0, isPrimary: true },
          { kind: 'video', relativePath: 'variants/white/videos/01.mp4', sortOrder: 1, isPrimary: false }
        ]
      }
    ]);
    expect(manualProduct.mediaAssets.map((asset: any) => ({
      kind: asset.kind,
      relativePath: asset.relativePath,
      sha256: asset.sha256,
      durationSeconds: asset.durationSeconds
    }))).toEqual(automaticProduct.mediaAssets.map((asset: any) => ({
      kind: asset.kind,
      relativePath: asset.relativePath,
      sha256: asset.sha256,
      durationSeconds: asset.durationSeconds
    })));
  });
});

async function createGoldenFixture(weightCase: {
  procurementGrossWeightGrams: string | null;
  presetWeight: number;
  presetWeightUnit: string;
}) {
  const manualMedia = await createMediaRoot('manual');
  const automaticMedia = await createMediaRoot('automatic');
  const categoryAttributes = [
    { id: 85, complexId: 0, dictionaryId: 28732849 },
    { id: 9024, complexId: 0, dictionaryId: 0 },
    { id: 9048, complexId: 0, dictionaryId: 0 },
    { id: 4180, complexId: 0, dictionaryId: 0 },
    { id: 4191, complexId: 0, dictionaryId: 0 },
    { id: 8229, complexId: 0, dictionaryId: 1960 },
    { id: 5299, complexId: 0, dictionaryId: 0, type: 'Decimal', required: false },
    { id: 6573, complexId: 0, dictionaryId: 0, type: 'Decimal', required: false },
    { id: 5355, complexId: 0, dictionaryId: 0, type: 'Decimal', required: false },
    { id: 4383, complexId: 0, dictionaryId: 0, type: 'Decimal', required: false },
    { id: 23249, complexId: 0, dictionaryId: 0, type: 'Decimal', required: false },
    { id: 20, complexId: 100, dictionaryId: 200 },
    { id: 10096, complexId: 100, dictionaryId: 1494, type: 'String' },
    { id: 10097, complexId: 100, dictionaryId: 0, type: 'String' },
    { id: 21845, complexId: 100002 },
    { id: 21837, complexId: 100001 },
    { id: 21841, complexId: 100001 }
  ] as any[];
  const category = {
    categoryKey: 'ozon_17001_97001',
    descriptionCategoryId: 17001,
    typeId: TYPE_ID,
    publishedVersion: {
      id: CATEGORY_VERSION_ID,
      versionNo: 4,
      schemaHash: `sha256:${'a'.repeat(64)}`,
      snapshot: { attributes: categoryAttributes, media: { defaultVideoUploadMode: 'COMPRESSED_COPY' } }
    }
  } as any;
  const preset = {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'OZON 黄金对照预设',
    rowVersion: 8,
    description: '',
    categoryKey: category.categoryKey,
    pricingTemplateId: '66666666-6666-4666-8666-666666666666',
    shippingTemplateId: '77777777-7777-4777-8777-777777777777',
    shippingServiceCode: 'CEL_RFBS_ECONOMY',
    destinationCountryCode: 'RU',
    vat: '0.2',
    defaultStock: 6,
    dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: weightCase.presetWeight, weightUnit: weightCase.presetWeightUnit },
    sharedAttributes: [
      { attributeId: 85, complexId: 0, values: [{ dictionaryValueId: 126745801 }] },
      { attributeId: 9024, complexId: 0, values: [{ value: 'legacy-offer' }] },
      { attributeId: 9048, complexId: 0, values: [{ value: 'legacy-model' }] },
      { attributeId: 4180, complexId: 0, values: [{ value: 'legacy-title' }] },
      { attributeId: 4191, complexId: 0, values: [{ value: 'legacy-description' }] },
      { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: 1 }] },
      { attributeId: 5299, complexId: 0, values: [{ value: '999' }] },
      { attributeId: 23249, complexId: 0, values: [{ value: '6' }] }
    ],
    variantAttributes: [
      { attributeId: 20, complexId: 100, values: [{ dictionaryValueId: 40 }] },
      { attributeId: 10096, complexId: 100, values: [{ dictionaryValueId: 1 }] },
      { attributeId: 10097, complexId: 100, values: [{ value: 'legacy-color' }] }
    ],
    titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 60 },
    descriptionSource: 'E003',
    sizes: [{ value: '', stock: 6 }],
    mediaPolicy: 'REPLACE_ALL'
  } as any;
  const presetDefinition = Object.fromEntries(
    Object.entries(preset).filter(([key]) => !['id', 'rowVersion'].includes(key))
  );
  const procurement = {
    id: PROCUREMENT_VERSION_ID,
    versionNo: 7,
    createdAt: '2026-08-07T03:00:00.000Z',
    purchasePrice: '31.0000',
    courierFee: '2.0000',
    grossWeightGrams: weightCase.procurementGrossWeightGrams,
    productHeightCm: '16.000',
    productDepthCm: '11.500',
    productWidthCm: '20.000',
    netWeightGrams: '350.000'
  };
  const identity = {
    sku: SKU,
    productName: PRODUCT_NAME,
    variants: VARIANTS.map((variant) => ({
      variantId: variant.variantId,
      name: variant.name,
      wbColor: { colorKey: variant.colorKey, nameRu: variant.nameRu, nameZh: variant.nameZh },
      ozonColor: {
        itemKey: `colors:1494:${variant.ozonValueId}`,
        dictionaryId: 1494,
        valueId: variant.ozonValueId,
        nameRu: variant.nameRu,
        nameZh: variant.nameZh,
        source: 'MANUAL_E001'
      }
    }))
  } as any;
  const purchase = { sku: SKU, productName: PRODUCT_NAME, procurementVersions: [procurement] } as any;
  const colors = VARIANTS.map((variant) => ({
    directory: 'colors',
    itemKey: `colors:1494:${variant.ozonValueId}`,
    attributeId: 10096,
    dictionaryId: 1494,
    valueId: variant.ozonValueId,
    nameRu: variant.nameRu,
    nameZh: variant.nameZh
  }));
  const pricingResult = goldenPricingResult(preset.shippingServiceCode);
  const pricing = { configured: true, calculate: vi.fn(async () => structuredClone(pricingResult)) } as any;
  const descriptions = {
    resolveVariants: vi.fn(async () => ({
      status: 'READY',
      content: SHARED_DESCRIPTION_RU,
      source: {
        workflowCode: 'E003', executionId: 88, folderName: 'latest', fileName: 'coffee-detail.txt',
        sha256: '1'.repeat(64), productVariantId: VARIANTS[0].variantId
      },
      variantSources: VARIANTS.map((variant, index) => ({
        status: 'READY',
        productVariantId: variant.variantId,
        productVariantName: variant.name,
        content: index === 0 ? SHARED_DESCRIPTION_RU : 'Описание белого варианта без лишних символов.',
        source: {
          workflowCode: 'E003', executionId: 88, folderName: 'latest', fileName: index === 0 ? 'coffee-detail.txt' : 'white-detail.txt',
          sha256: String(index + 1).repeat(64), productVariantId: variant.variantId
        }
      }))
    }))
  } as any;
  const titleTranslator = {
    configured: true,
    translate: vi.fn(async () => ({ contentTranslate: TITLE_RU, cached: false, model: 'qwen' }))
  } as any;
  const purchases = {
    configured: true,
    getPurchase: vi.fn(async () => structuredClone(purchase)),
    getProductIdentityBySku: vi.fn(async () => structuredClone(identity))
  } as unknown as PurchaseRepository;
  const logger = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  const manualState = createRepositoryState(manualMedia.rootDirectory, preset, category, colors);
  const automaticState = createRepositoryState(automaticMedia.rootDirectory, preset, category, colors);
  const manualService = new OzonPublishingService(manualState.repository, purchases, logger, pricing, descriptions, titleTranslator);
  const automaticService = new OzonPublishingService(automaticState.repository, purchases, logger, pricing, descriptions, titleTranslator);
  const autoPublishingShim = {
    resolveStoreContext: vi.fn(async () => ({ warehouseId: '10001', accountCurrency: 'RUB' })),
    dispatchAutomaticJob: vi.fn(async () => undefined)
  } as unknown as OzonPublishingService;
  const currentJob = createAutomaticJob(preset.id);
  let automaticJob = currentJob;
  (automaticState.repository as any).getJob = vi.fn(async () => automaticJob);
  (automaticState.repository as any).transitionJob = vi.fn(async (_id: string, transition: any) => {
    automaticJob = {
      ...automaticJob,
      state: transition.state,
      rowVersion: automaticJob.rowVersion + 1,
      payload: { ...(automaticJob.payload || {}), ...(transition.payload || {}), ...(transition.jobPayload || {}) },
      stageStates: { ...automaticJob.stageStates, ...(transition.stageStates || {}) },
      ...(transition.errorCode === undefined ? { lastErrorCode: undefined } : { lastErrorCode: transition.errorCode }),
      ...(transition.errorMessage === undefined ? { lastErrorMessage: undefined } : { lastErrorMessage: transition.errorMessage }),
      updatedAt: new Date().toISOString()
    };
    return automaticJob;
  });
  (automaticState.repository as any).persistAutomaticSharedMaterialRevision = vi.fn(async (input: any) => {
    const listing = await automaticState.persistAutomaticData(input.productName, input.data);
    automaticJob = {
      ...automaticJob,
      state: 'READY',
      rowVersion: automaticJob.rowVersion + 1,
      offerIds: input.offerIds,
      payload: {
        ...automaticJob.payload,
        generatedVersionId: listing.generatedVersionId,
        materialHash: listing.materialHash,
        materialHashVersion: listing.materialHashVersion,
        contentPolicyVersion: listing.contentPolicyVersion,
        sharedMaterialPreparation: {
          schemaVersion: 1,
          preparedByJobId: automaticJob.id,
          listingRowVersion: listing.rowVersion,
          listingRevision: listing.revision,
          dataSignature: listing.materialHash,
          mediaSignature: input.mediaSignature
        }
      }
    };
    return { listing, job: automaticJob };
  });
  (automaticState.repository as any).resolveAutomaticMediaDeliveryEvidence = vi.fn(async ({ identities }: any) => (
    identities.map((entry: any) => ({ ...entry, decision: 'ACCEPTED', jobId: automaticJob.id }))
  ));
  const coordinator = new OzonAutoPublishingCoordinator(
    automaticState.repository,
    autoPublishingShim,
    purchases,
    pricing,
    descriptions,
    titleTranslator,
    { read: () => ({ submissionHistory: [] }) } as any,
    logger,
    { stableProbeMs: 0 },
    {
      storeRepository: {
        listEligibleAutoStores: vi.fn(async () => []),
        completeFanoutPreparation: vi.fn(async () => undefined),
        finalizeMediaFanout: vi.fn(async () => true)
      } as any,
      storeService: {} as any
    }
  );

  return {
    categoryAttributes,
    async prepareManualListing() {
      const listing = await manualService.createListing(SKU);
      const mediaAssets = await scanOzonMediaDirectory(manualMedia.productRoot, path.join(manualMedia.productRoot, 'variants'));
      const offers = assignMediaByProductVariant(listing.data.offers, mediaAssets);
      return manualService.updateListing(SKU, {
        ...listing.data,
        rowVersion: listing.rowVersion,
        mediaAssets,
        offers,
        mediaSourceRoot: manualMedia.productRoot
      });
    },
    async prepareAutomaticListing() {
      await (coordinator as any).processJob(automaticJob);
      return automaticState.getListing();
    },
    generateManual(rowVersion: number) {
      return manualService.buildStorePresetProduct(
        SKU,
        rowVersion,
        presetDefinition,
        'RUB',
        { id: preset.id, name: preset.name, rowVersion: preset.rowVersion }
      );
    },
    generateAutomatic(rowVersion: number) {
      return automaticService.buildStorePresetProduct(
        SKU,
        rowVersion,
        presetDefinition,
        'RUB',
        { id: preset.id, name: preset.name, rowVersion: preset.rowVersion }
      );
    }
  };
}

function createRepositoryState(rootDirectory: string, preset: any, category: any, colors: any[]) {
  let listing: OzonListingDraft | undefined;
  const createListing = vi.fn(async (identity: any, _boundPreset?: any, data: any = {}) => {
    const now = new Date().toISOString();
    listing = {
      sku: identity.sku,
      productName: identity.productName,
      status: 'DRAFT',
      managementSource: 'MANUAL',
      rowVersion: 1,
      revision: 1,
      generatedVersionId: randomUUID(),
      materialHash: `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`,
      materialHashVersion: 'ozon-shared-material-v1',
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      data: {
        videoUploadMode: category.publishedVersion.snapshot.media.defaultVideoUploadMode,
        fulfillmentMode: 'FBS',
        warehouseId: '',
        currency: 'CNY',
        vat: '0.2',
        titleRu: '',
        descriptionRu: '',
        brand: '',
        sharedAttributes: [],
        offers: [],
        mediaAssets: [],
        mediaSourceRoot: path.join(rootDirectory, 'inbox', identity.sku),
        ...structuredClone(data)
      },
      ozonProductLinks: [],
      createdAt: now,
      updatedAt: now
    } as any;
    return listing;
  });
  const updateListing = vi.fn(async (_sku: string, input: any) => {
    if (!listing) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', undefined, 404);
    const next = structuredClone(input);
    delete next.rowVersion;
    const initialization = next.initialization
      ? {
          ...(listing.data.initialization || {}),
          ...next.initialization,
          grossWeightResolution: next.initialization.grossWeightResolution || listing.data.initialization?.grossWeightResolution,
          presetSnapshot: next.initialization.presetSnapshot || listing.data.initialization?.presetSnapshot
        }
      : listing.data.initialization;
    listing = {
      ...listing,
      status: 'READY',
      rowVersion: listing.rowVersion + 1,
      revision: listing.revision + 1,
      generatedVersionId: randomUUID(),
      materialHash: `sha256:${createHash('sha256').update(JSON.stringify(next)).digest('hex')}`,
      materialHashVersion: 'ozon-shared-material-v1',
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      data: { ...listing.data, ...next, ...(initialization ? { initialization } : {}) },
      updatedAt: new Date().toISOString()
    };
    return listing;
  });
  const repository = {
    configured: true,
    getSettings: vi.fn(async () => ({
      enabled: true,
      credentialReady: true,
      rootDirectory,
      defaultStoreAlias: 'default',
      imageUploadConcurrency: 2,
      videoUploadConcurrency: 1
    })),
    getListing: vi.fn(async () => listing || Promise.reject(new AppError('NOT_FOUND', 'OZON 上品草稿不存在', undefined, 404))),
    getDefaultPreset: vi.fn(async () => preset),
    getPreset: vi.fn(async () => preset),
    getCategory: vi.fn(async () => category),
    searchCatalogDictionary: vi.fn(async () => colors),
    getActiveCatalogDictionaryValue: vi.fn(async (_directory: string, dictionaryId: number, valueId: number) => {
      const match = colors.find((color) => color.dictionaryId === dictionaryId && color.valueId === valueId);
      if (!match) throw new AppError('NOT_FOUND', '目录值不存在', undefined, 404);
      return structuredClone(match);
    }),
    listManualJobsForSku: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 1 })),
    hasProductMappingForSku: vi.fn(async () => false),
    createListing,
    createListingIfAbsent: createListing,
    updateListing,
    reserveSubmissionRevision: vi.fn(async () => {
      if (!listing) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', undefined, 404);
      listing = {
        ...listing,
        status: 'SUBMITTING',
        rowVersion: listing.rowVersion + 1,
        revision: listing.revision + 1,
        updatedAt: new Date().toISOString()
      };
      return listing;
    }),
    findInboxRoundJob: vi.fn(async () => undefined),
    recordInboxRoundReleased: vi.fn(async () => undefined)
  } as unknown as OzonRepository;
  return {
    repository,
    async persistAutomaticData(productName: string, data: any) {
      const now = new Date().toISOString();
      listing = {
        ...(listing || {
          sku: SKU,
          productName,
          rowVersion: 0,
          revision: 0,
          ozonProductLinks: [],
          createdAt: now
        } as any),
        productName,
        status: 'READY',
        managementSource: 'AUTO',
        rowVersion: (listing?.rowVersion || 0) + 1,
        revision: (listing?.revision || 0) + 1,
        generatedVersionId: randomUUID(),
        materialHash: `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`,
        materialHashVersion: 'ozon-shared-material-v1',
        contentPolicyVersion: 'merchroute-ozon-content-v3',
        data: structuredClone(data),
        updatedAt: now
      } as any;
      return listing;
    },
    getListing() {
      if (!listing) throw new Error('listing was not prepared');
      return listing;
    }
  };
}

async function createMediaRoot(label: string) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), `merchroute-ozon-parity-${label}-`));
  roots.push(rootDirectory);
  const productRoot = path.join(rootDirectory, 'inbox', SKU);
  const imageContent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const videoContent = testMp4(12);
  const assets: any[] = [];
  for (const [index, variant] of VARIANTS.entries()) {
    const directory = index === 0 ? 'coffee' : 'white';
    for (const item of [
      { sourceStageId: 'E005', kind: 'image', relativePath: `variants/${directory}/images/01.png`, content: imageContent },
      { sourceStageId: 'E004', kind: 'video', relativePath: `variants/${directory}/videos/01.mp4`, content: videoContent }
    ] as const) {
      const filePath = path.join(productRoot, ...item.relativePath.split('/'));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, item.content);
      const sha256 = createHash('sha256').update(item.content).digest('hex');
      assets.push({
        assetId: `${variant.variantId}-${item.kind}`,
        submissionId: `${item.sourceStageId.toLocaleLowerCase()}-${variant.variantId}`,
        sourceStageId: item.sourceStageId,
        kind: item.kind,
        variantId: variant.variantId,
        variantName: variant.name,
        variantColor: { colorKey: variant.colorKey, nameRu: variant.nameRu, nameZh: variant.nameZh },
        relativePath: item.relativePath,
        deliveredAt: `2026-08-07T03:0${index}:${item.kind === 'image' ? '00' : '30'}.000Z`,
        sizeBytes: item.content.length,
        sha256
      });
    }
  }
  const manifestPath = path.join(productRoot, 'variants', 'variant-media-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, SKU, productName: PRODUCT_NAME, assets }, null, 2));
  return { rootDirectory, productRoot };
}

function assignMediaByProductVariant(offers: OzonListingDraft['data']['offers'], mediaAssets: OzonListingDraft['data']['mediaAssets']) {
  return offers.map((offer) => ({
    ...offer,
    media: mediaAssets
      .filter((asset) => asset.productVariantId === (offer.productVariantId || offer.variantId))
      .sort((left, right) => Number(left.kind === 'video') - Number(right.kind === 'video') || left.relativePath.localeCompare(right.relativePath))
      .map((asset, index) => ({
        assetId: asset.assetId,
        relativePath: asset.relativePath,
        kind: asset.kind,
        sortOrder: index,
        isPrimary: asset.kind === 'image' && index === 0
      }))
  }));
}

function canonicalSharedMaterial(listing: OzonListingDraft) {
  return {
    sku: listing.sku,
    productName: listing.productName,
    descriptionRu: listing.data.descriptionRu,
    descriptionSource: listing.data.descriptionSource,
    offers: listing.data.offers
      .map((offer) => ({
        productVariantId: offer.productVariantId,
        productVariantName: offer.productVariantName,
        productVariantColor: offer.productVariantColor,
        variantCode: offer.variantCode,
        offerId: offer.offerId,
        descriptionRu: offer.descriptionRu,
        descriptionSource: offer.descriptionSource,
        media: offer.media.map((media) => ({
          relativePath: media.relativePath,
          kind: media.kind,
          sortOrder: media.sortOrder,
          isPrimary: media.isPrimary
        }))
      }))
      .sort((left, right) => String(left.productVariantId).localeCompare(String(right.productVariantId))),
    mediaAssets: listing.data.mediaAssets.map((asset) => ({
      relativePath: asset.relativePath,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      productVariantId: asset.productVariantId,
      productVariantName: asset.productVariantName,
      productVariantColor: asset.productVariantColor
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  };
}

function canonicalProductV2(product: any) {
  return {
    ...structuredClone(product),
    revision: '<material-revision>',
    sharedAttributes: sortAttributes(product.sharedAttributes),
    offers: product.offers.map((offer: any) => ({ ...structuredClone(offer), attributes: sortAttributes(offer.attributes) }))
  };
}

function sortAttributes(attributes: any[]) {
  return structuredClone(attributes).sort((left: any, right: any) => (
    left.attributeId - right.attributeId || left.complexId - right.complexId
  ));
}

function attributeValuesById(attributes: any[]) {
  return Object.fromEntries(attributes.map((attribute: any) => [attribute.attributeId, attribute.values]));
}

function goldenPricingResult(serviceCode: string) {
  const money = (cost: string, sale: string) => ({
    costCurrency: { currencyCode: 'CNY', value: cost, displayValue: cost },
    saleCurrency: { currencyCode: 'RUB', value: sale, displayValue: sale }
  });
  return {
    calculatedAt: '2026-08-07T03:05:00.000Z',
    pricingTemplate: {
      platformCode: 'OZON',
      templateId: '66666666-6666-4666-8666-666666666666',
      versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      versionNo: 3
    },
    options: [{
      optionId: 'ozon-golden-option',
      recommended: true,
      shipping: {
        serviceCode,
        template: {
          platformCode: 'OZON',
          templateId: '77777777-7777-4777-8777-777777777777',
          versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          versionNo: 4
        }
      },
      amounts: {
        listing: money('385.33', '4200.5'),
        strike: money('770.65', '5000'),
        targetSale: money('192.66', '4000')
      }
    }]
  };
}

function createAutomaticJob(presetId: string) {
  const now = '2026-08-07T03:00:00.000Z';
  return {
    id: '88888888-8888-4888-8888-888888888888',
    sku: SKU,
    offerIds: [],
    storeAlias: 'default',
    state: 'WAITING_MEDIA',
    source: 'AUTO',
    payload: {
      multistorePreparation: true,
      multistoreAdmission: {
        storeId: '99999999-9999-4999-8999-999999999999',
        presetId,
        activatedAt: '2026-08-07T02:00:00.000Z',
        autoPublishMode: 'CREATE_ONLY'
      },
      mediaDeliveries: VARIANTS.flatMap((variant) => ([
        {
          sourceStageId: 'E005',
          submissionId: `e005-${variant.variantId}`,
          variantId: variant.variantId,
          deliveredAt: '2026-08-07T03:00:00.000Z'
        },
        {
          sourceStageId: 'E004',
          submissionId: `e004-${variant.variantId}`,
          variantId: variant.variantId,
          deliveredAt: '2026-08-07T03:00:30.000Z'
        }
      ]))
    },
    stageStates: { import: 'PENDING', moderation: 'PENDING', images: 'WAITING_LOCAL', video: 'WAITING_LOCAL', price: 'PENDING', stock: 'PENDING' },
    retryCount: 0,
    rowVersion: 1,
    ozonProductLinks: [],
    createdAt: now,
    updatedAt: now
  } as any;
}

function isoBmffBox(type: string, payload: Buffer): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function testMp4(durationSeconds = 12, timescale = 1_000): Buffer {
  const ftypPayload = Buffer.alloc(8);
  ftypPayload.write('isom', 0, 4, 'ascii');
  ftypPayload.writeUInt32BE(512, 4);
  const mvhdPayload = Buffer.alloc(20);
  mvhdPayload.writeUInt8(0, 0);
  mvhdPayload.writeUInt32BE(timescale, 12);
  mvhdPayload.writeUInt32BE(Math.round(durationSeconds * timescale), 16);
  return Buffer.concat([isoBmffBox('ftyp', ftypPayload), isoBmffBox('moov', isoBmffBox('mvhd', mvhdPayload))]);
}
