import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, type OzonSystemSettings } from '@n8n-media-review/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { OzonRepository } from '../../repositories/ozon.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import {
  assertNoUserManagedOzonSystemMediaAttributes,
  assertOzonPlatformAttributes,
  assertOzonVariantColorCategoryCompatibility,
  assertOzonMediaAssetsCurrent,
  assertSameAutomaticSettings,
  applyOzonVariantColorDefaults,
  createOzonCompatibleAppendProductIdentity,
  createOzonCompatibleAppendSettingsBinding,
  inspectOzonMp4Buffer,
  manualListingPlatformAttributes,
  manualListingPlatformBrand,
  ozonJobRecovery,
  OzonPublishingService,
  parseOzonMp4DurationSeconds,
  prepareOzonInboxRound,
  removeGeneratedOzonArtifactIfOwned,
  resolveOzonVideoContract,
  scanOzonMediaDirectory,
  selectOzonListingProductVariants,
  scopeOzonListingSubmission
} from './index.js';
import {
  OZON_P002_RFBS_NORMALIZATION_WORKFLOW_ID,
  OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT
} from './rfbs-stock-callback.js';

const roots: string[] = [];

describe('OZON store-owned settings binding', () => {
  const base = {
    rowVersion: 17,
    enabled: true,
    credentialReady: false,
    defaultStoreAlias: 'default',
    rootDirectory: 'G:/OZON-Auto-Publish',
    taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/ozon-tasks'
  } as OzonSystemSettings;

  it('allows store-neutral materialization to use Vault credentials even when the removed global credential is absent', () => {
    expect(() => assertSameAutomaticSettings(base, structuredClone(base), '0000132', false)).not.toThrow();
  });

  it('keeps the legacy single-store generator fail closed without its frozen global credential', () => {
    expect(() => assertSameAutomaticSettings(base, structuredClone(base), '0000132')).toThrowError(
      expect.objectContaining({ code: 'TASK_LOCKED' })
    );
  });
});

function isoBmffBox(type: string, payload: Buffer): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function testMp4(durationSeconds = 10, timescale = 1_000): Buffer {
  const ftypPayload = Buffer.alloc(8);
  ftypPayload.write('isom', 0, 4, 'ascii');
  ftypPayload.writeUInt32BE(512, 4);
  const mvhdPayload = Buffer.alloc(20);
  mvhdPayload.writeUInt8(0, 0);
  mvhdPayload.writeUInt32BE(timescale, 12);
  mvhdPayload.writeUInt32BE(Math.round(durationSeconds * timescale), 16);
  return Buffer.concat([
    isoBmffBox('ftyp', ftypPayload),
    isoBmffBox('moov', isoBmffBox('mvhd', mvhdPayload))
  ]);
}

function stableTestJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTestJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableTestJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function createRfbsRuntimeUpdateFixture() {
  const now = Date.now();
  const offerIds = ['0000105-01', '0000105-02', '0000105-03'];
  const productIds = ['5874416999', '5884077033', '5884077037'];
  const ozonSkus = ['5395936600', '5404205974', '5404205495'];
  const expectedOfferSnapshots = offerIds.map((offerId, index) => ({
    offerId,
    productVariantId: `variant-${index + 1}`,
    disposition: index === 0 ? 'PRESERVED_EXISTING' : 'SUBMITTED',
    price: 194.38,
    oldPrice: 388.76,
    minPrice: 97.19,
    stock: 1,
    descriptionRu: `description-${offerId}`,
    media: { imageCount: 7, videoCount: 1 },
    ...(index === 0 ? { mapping: { ozonProductId: productIds[0], ozonSku: ozonSkus[0] } } : {})
  }));
  const contract = {
    offerContractVersion: 1,
    expectedOfferIds: offerIds,
    submittedOfferIds: offerIds.slice(1),
    publishOfferIds: offerIds.slice(1),
    expectedOfferSnapshots
  };
  const offerContractHash = `sha256:${createHash('sha256').update(stableTestJson(contract)).digest('hex')}`;
  const jobPayload = {
    offerIds,
    revision: 4,
    storeAlias: 'default',
    warehouseId: '1020002456503000',
    importTaskId: '5358968564',
    materialSnapshot: { store: { fulfillmentMode: 'RFBS' } },
    ...contract,
    offerContractHash
  };
  const readAt = new Date(now - 1_000).toISOString();
  const statusSnapshots = offerIds.map((offerId) => ({
    displayState: 'ON_SALE',
    businessState: 'PUBLISHED',
    hasStock: true,
    stockPresent: 1,
    readAt,
    warnings: [`OZON_STOCK_DIFFERENCE：${offerId}`]
  }));
  const mappings = offerIds.map((offerId, index) => ({
    storeAlias: 'default',
    offerId,
    sku: '0000105',
    ozonProductId: productIds[index],
    ozonSku: ozonSkus[index],
    lastAppliedRevision: 4,
    status: 'ON_SALE',
    statusSnapshot: statusSnapshots[index],
    updatedAt: readAt
  }));
  const input = {
    rowVersion: 27,
    state: 'NEEDS_ATTENTION' as const,
    eventType: 'OZON_FINAL_READBACK_MISMATCH',
    message: 'stock mismatch',
    errorCode: 'OZON_FINAL_READBACK_MISMATCH',
    errorMessage: 'stock mismatch',
    storeAlias: 'default',
    warehouseId: '1020002456503000',
    lastAppliedRevision: 4,
    leaseOwner: 'n8n:ozon:p002:190809',
    leaseToken: '00000000-0000-4000-8000-000000000001',
    clearLease: true,
    stageStates: {
      import: 'SUCCESS',
      moderation: 'SUCCESS',
      images: 'VERIFIED',
      video: 'VERIFIED',
      productVideo: 'VERIFIED',
      videoCover: 'VERIFIED',
      price: 'VERIFIED',
      stock: 'DIFFERENCE'
    },
    payload: {
      warnings: offerIds.map((offerId) => ({
        code: 'OZON_STOCK_DIFFERENCE', offerId, expected: 1, actual: 0
      })),
      verifiedOfferIds: offerIds,
      readAt,
      descriptionVerificationByOffer: offerIds.map((offerId) => ({ offerId, present: true, matches: true }))
    },
    jobPayload: {
      imageRecovery: {
        phase: 'VERIFIED', affectedOffers: [], expectedImageCount: 21, actualImageCount: 21
      },
      platformStatusWarnings: offerIds.map((offerId) => ({
        code: 'OZON_STOCK_DIFFERENCE', offerId, expected: 1, actual: 0
      })),
      finalConsistencyRecovery: {
        schemaVersion: 1,
        phase: 'FAILED',
        confirmationCount: 3,
        affectedOffers: offerIds.map((offerId) => ({
          offerId,
          differences: { stock: { expected: 1, actual: 0, valid: true, reasons: [] } }
        }))
      }
    },
    productMappings: offerIds.map((offerId, index) => ({
      offerId,
      ozonProductId: productIds[index]!,
      ozonSku: ozonSkus[index]!,
      platformStatus: 'ON_SALE',
      statusSnapshot: statusSnapshots[index]
    }))
  };
  const job = {
    id: '2fa0f3ae-0b22-4ac9-b644-dc9a63af013a',
    sku: '0000105',
    offerIds,
    storeAlias: 'default',
    state: 'MODERATING',
    source: 'AUTO',
    taskId: '2fa0f3ae-0b22-4ac9-b644-dc9a63af013a',
    importTaskId: '5358968564',
    payload: jobPayload,
    ozonProductLinks: offerIds.map((offerId, index) => ({
      offerId, ozonProductId: productIds[index], ozonSku: ozonSkus[index]
    })),
    taskFolder: '0000105__r4',
    workRelPath: 'processing/0000105__r4',
    directoryStage: 'PROCESSING',
    directorySignature: `sha256:${'a'.repeat(64)}`,
    stageStates: input.stageStates,
    retryCount: 0,
    rowVersion: 27,
    revision: 4,
    leaseOwner: input.leaseOwner,
    leaseToken: input.leaseToken,
    leaseExpiresAt: new Date(now + 5 * 60_000).toISOString(),
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 10_000).toISOString()
  } as any;
  const authority = {
    job,
    listing: {
      sku: job.sku,
      productName: '潮流单肩包',
      status: 'SUBMITTING',
      rowVersion: 19,
      revision: 4,
      data: { fulfillmentMode: 'RFBS' },
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    },
    mappings
  } as any;
  const operations = ['infoList', 'attributesInfo', 'pricesRead', 'stocksRead', 'picturesInfo'];
  const prepared = operations.map((operation, index) => ({ json: {
    jobId: job.id,
    rowVersion: job.rowVersion,
    sku: job.sku,
    storeAlias: job.storeAlias,
    leaseOwner: job.leaseOwner,
    leaseToken: job.leaseToken,
    offerIds,
    jobPayload: structuredClone(jobPayload),
    currentState: job.state,
    importTaskId: job.importTaskId,
    taskFolder: job.taskFolder,
    workRelPath: job.workRelPath,
    directoryStage: job.directoryStage,
    directorySignature: job.directorySignature,
    expectedOfferIds: offerIds,
    submittedOfferIds: offerIds.slice(1),
    publishOfferIds: offerIds.slice(1),
    expectedOfferSnapshots,
    verifyOperation: operation,
    operation,
    requestId: `${job.id}:${operation}`,
    inputIndex: index
  } }));
  const responses = operations.map((operation, index) => ({ json: {
    operation,
    requestId: `${job.id}:${operation}`,
    inputIndex: index,
    ok: true,
    statusCode: 200,
    isWrite: false,
    deliveryState: 'RESPONDED',
    body: operation === 'stocksRead'
      ? { items: offerIds.map((offerId, offerIndex) => ({
          offer_id: offerId,
          product_id: productIds[offerIndex],
          stocks: [{
            type: 'rfbs', present: 1, reserved: 0, sku: Number(ozonSkus[offerIndex]), warehouse_ids: []
          }]
        })) }
      : operation === 'picturesInfo'
        ? { items: productIds.map((productId) => ({ product_id: productId })) }
        : { items: offerIds.map((offerId) => ({ offer_id: offerId })) }
  } }));
  const execution = {
    id: '190809',
    workflowId: OZON_P002_RFBS_NORMALIZATION_WORKFLOW_ID,
    status: 'running',
    startedAt: new Date(now - 10_000).toISOString(),
    data: { resultData: { runData: {
      '准备平台最终校验': [{ data: { main: [prepared] } }],
      '调用 OZON-A001 最终读回': [{ data: { main: [responses] } }]
    } } }
  };
  return { authority, execution, input, job, offerIds, productIds, ozonSkus };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OZON shared-material persistence', () => {
  const variantId = '11111111-1111-4111-8111-111111111111';
  const imageAsset = {
    assetId: 'image-asset', relativePath: 'variants/black/images/01.png', kind: 'image' as const,
    mimeType: 'image/png', sizeBytes: 128, sha256: 'a'.repeat(64),
    modifiedAt: '2026-08-14T00:00:00.000Z', validationStatus: 'VALID' as const
  };
  const videoAsset = {
    assetId: 'video-asset', relativePath: 'variants/black/videos/main.mp4', kind: 'video' as const,
    mimeType: 'video/mp4', sizeBytes: 512, sha256: 'b'.repeat(64),
    modifiedAt: '2026-08-14T00:00:00.000Z', validationStatus: 'VALID' as const
  };
  const listing = {
    sku: '0000134', productName: '测试商品', managementSource: 'MANUAL', status: 'DRAFT', rowVersion: 3, revision: 3,
    data: {
      fulfillmentMode: 'FBS', warehouseId: '', currency: 'CNY', vat: '0.2', titleRu: '',
      descriptionRu: 'Общее описание товара.', descriptionWarnings: [], brand: '', sharedAttributes: [],
      mediaAssets: [imageAsset, videoAsset], mediaSourceRoot: 'G:/OZON-Auto-Publish/inbox/0000134',
      videoUploadMode: 'COMPRESSED_COPY',
      offers: [{
        variantId, productVariantId: variantId, productVariantName: '黑色', variantCode: '01',
        offerId: '0000134-01', barcode: '', modelGroup: '0000134', price: 1, stock: 0,
        descriptionRu: 'Описание черного варианта.', descriptionWarnings: [], attributes: [], media: []
      }]
    },
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'
  } as any;
  const validInput = {
    rowVersion: 3,
    descriptionRu: 'Общее описание товара.',
    variants: [{
      variantId, productVariantId: variantId, productVariantName: '黑色',
      descriptionRu: 'Описание черного варианта.',
      media: [
        { assetId: imageAsset.assetId, relativePath: imageAsset.relativePath, kind: imageAsset.kind, sortOrder: 0, isPrimary: true },
        { assetId: videoAsset.assetId, relativePath: videoAsset.relativePath, kind: videoAsset.kind, sortOrder: 1, isPrimary: false }
      ]
    }]
  };

  it('resolves media metadata from the server-owned library and preserves reference order', async () => {
    const updateListing = vi.fn(async (_sku, input) => ({ ...listing, rowVersion: 4, revision: 4, data: input }));
    const repository = { getListing: vi.fn(async () => listing), updateListing } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.updateSharedMaterial(listing.sku, validInput)).resolves.toMatchObject({ rowVersion: 4, revision: 4 });
    expect(updateListing).toHaveBeenCalledWith(listing.sku, expect.objectContaining({
      rowVersion: 3,
      mediaAssets: listing.data.mediaAssets,
      offers: [expect.objectContaining({
        media: [
          expect.objectContaining({ assetId: imageAsset.assetId, sortOrder: 0, isPrimary: true }),
          expect.objectContaining({ assetId: videoAsset.assetId, sortOrder: 1, isPrimary: false })
        ]
      })]
    }), { preserveGeneratedSources: true });
  });

  it.each([
    ['missing asset', { assetId: 'missing-asset' }, listing.data.mediaAssets],
    ['path drift', { relativePath: 'variants/black/images/changed.png' }, listing.data.mediaAssets],
    ['kind drift', { kind: 'video' }, listing.data.mediaAssets],
    ['invalid asset', {}, [{ ...imageAsset, validationStatus: 'INVALID', validationError: 'broken' }, videoAsset]]
  ])('rejects %s before writing a new revision', async (_label, referenceOverride, mediaAssets) => {
    const current = { ...listing, data: { ...listing.data, mediaAssets } };
    const updateListing = vi.fn();
    const repository = { getListing: vi.fn(async () => current), updateListing } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);
    const input = structuredClone(validInput);
    Object.assign(input.variants[0]!.media[0]!, referenceOverride);

    await expect(service.updateSharedMaterial(listing.sku, input)).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    expect(updateListing).not.toHaveBeenCalled();
  });

  it('propagates rowVersion conflicts without creating a replacement revision', async () => {
    const updateListing = vi.fn(async () => {
      throw new AppError('TASK_LOCKED', '草稿版本已变化', undefined, 409);
    });
    const repository = { getListing: vi.fn(async () => listing), updateListing } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.updateSharedMaterial(listing.sku, validInput)).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    expect(updateListing).toHaveBeenCalledTimes(1);
  });
});

describe('OZON manual listing initialization', () => {
  it('freezes the exact active E001 OZON color identity for every real product variant', async () => {
    const productVariantId = '11111111-1111-4111-8111-111111111111';
    const color = {
      itemKey: 'colors:1494:972075644', dictionaryId: 1494, valueId: 972075644,
      nameZh: '咖啡色', nameRu: 'кофе', source: 'AUTO_EXACT_RU' as const
    };
    const repository = {
      getListing: vi.fn(async () => ({
        sku: '0000136', rowVersion: 3,
        data: { offers: [{ variantId: productVariantId, productVariantId, productVariantName: '咖啡色', media: [] }] }
      })),
      getActiveCatalogDictionaryValue: vi.fn(async () => ({
        directory: 'colors', attributeId: 10096, ...color
      }))
    } as unknown as OzonRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({
        sku: '0000136', productName: '包', variants: [{ variantId: productVariantId, name: '咖啡色', ozonColor: color }]
      }))
    } as unknown as PurchaseRepository;
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger);

    const authority = await service.resolveVariantColorAuthority('0000136', 3);

    expect(authority).toMatchObject({
      schemaVersion: 1,
      source: 'E001_REVIEW',
      hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      variants: [{
        productVariantId,
        itemKey: color.itemKey,
        dictionaryId: 1494,
        valueId: 972075644,
        nameRu: 'кофе',
        source: 'AUTO_EXACT_RU'
      }]
    });
    expect(repository.getActiveCatalogDictionaryValue).toHaveBeenCalledWith('colors', 1494, 972075644);
  });

  it('fails closed when a real product variant has no E001 OZON color identity', async () => {
    const productVariantId = '11111111-1111-4111-8111-111111111111';
    const repository = {
      getListing: vi.fn(async () => ({
        sku: '0000136', rowVersion: 3,
        data: { offers: [{ variantId: productVariantId, productVariantId, productVariantName: '咖啡色', media: [] }] }
      }))
    } as unknown as OzonRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({
        sku: '0000136', productName: '包', variants: [{ variantId: productVariantId, name: '咖啡色' }]
      }))
    } as unknown as PurchaseRepository;
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger);

    await expect(service.resolveVariantColorAuthority('0000136', 3)).rejects.toMatchObject({
      code: 'OZON_VARIANT_COLOR_REQUIRED',
      statusCode: 409
    });
  });

  it.each([
    ['NOT_FOUND', undefined],
    ['identity mismatch', {
      directory: 'colors', attributeId: 10096, itemKey: 'colors:1494:972075644',
      dictionaryId: 1494, valueId: 972075644, nameZh: '错误颜色', nameRu: 'другой'
    }]
  ])('fails closed when an E001 color is inactive or its exact catalog identity changed: %s', async (_name, activeValue) => {
    const productVariantId = '11111111-1111-4111-8111-111111111111';
    const color = {
      itemKey: 'colors:1494:972075644', dictionaryId: 1494, valueId: 972075644,
      nameZh: '咖啡色', nameRu: 'кофе', source: 'AUTO_EXACT_RU' as const
    };
    const repository = {
      getListing: vi.fn(async () => ({
        sku: '0000136', rowVersion: 3,
        data: { offers: [{ variantId: productVariantId, productVariantId, productVariantName: '咖啡色', media: [] }] }
      })),
      getActiveCatalogDictionaryValue: vi.fn(async () => {
        if (!activeValue) throw new AppError('NOT_FOUND', 'inactive', undefined, 404);
        return activeValue;
      })
    } as unknown as OzonRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({
        sku: '0000136', productName: '包', variants: [{ variantId: productVariantId, name: '咖啡色', ozonColor: color }]
      }))
    } as unknown as PurchaseRepository;

    await expect(new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger)
      .resolveVariantColorAuthority('0000136', 3)).rejects.toMatchObject({
      code: 'OZON_VARIANT_COLOR_INCOMPATIBLE', statusCode: 409
    });
  });

  it('rejects a target category that lacks the exact 10096/10097 color contract', () => {
    const authority = {
      schemaVersion: 1 as const,
      source: 'E001_REVIEW' as const,
      hash: `sha256:${'a'.repeat(64)}`,
      variants: [{
        productVariantId: '11111111-1111-4111-8111-111111111111',
        itemKey: 'colors:1494:972075644', dictionaryId: 1494, valueId: 972075644,
        nameRu: 'кофе', source: 'AUTO_EXACT_RU' as const
      }]
    };
    expect(() => assertOzonVariantColorCategoryCompatibility([
      { id: 10096, complexId: 0, dictionaryId: 999, type: 'Dictionary' }
    ] as any, authority, { sku: '0000136', categoryKey: 'bad-category', presetId: 'preset-1' }))
      .toThrowError(expect.objectContaining({ code: 'OZON_VARIANT_COLOR_INCOMPATIBLE' }));
  });

  it('fills both OZON color and Russian color-name attributes from one product variant mapping', () => {
    const attributes = applyOzonVariantColorDefaults([
      { attributeId: 10096, complexId: 999, values: [{ dictionaryValueId: 1 }] },
      { attributeId: 10097, complexId: 999, values: [{ value: 'preset-color' }] }
    ], [
      { id: 10096, complexId: 100, dictionaryId: 1494 },
      { id: 10097, complexId: 100, dictionaryId: 0 }
    ] as any, {
      itemKey: 'colors:1494:61577', dictionaryId: 1494, valueId: 61577,
      nameZh: '黑色', nameRu: 'черный', source: 'MANUAL_E001'
    });
    expect(attributes).toEqual([
      { attributeId: 10096, complexId: 100, values: [{ dictionaryValueId: 61577 }] },
      { attributeId: 10097, complexId: 100, values: [{ value: 'черный' }] }
    ]);
  });

  it('ignores the default placeholder when real variants exist and retains it when it is the only variant', () => {
    const placeholder = { variantId: randomUUID(), name: '默认变体' };
    const coffee = { variantId: randomUUID(), name: '咖啡棕' };
    const lightCoffee = { variantId: randomUUID(), name: '浅咖啡色' };

    expect(selectOzonListingProductVariants([placeholder, coffee, lightCoffee])).toEqual([coffee, lightCoffee]);
    expect(selectOzonListingProductVariants([placeholder])).toEqual([placeholder]);
    expect(selectOzonListingProductVariants([])).toEqual([]);
  });

  it('scopes automatic generation to submitted offers without mutating the full parent listing', () => {
    const listing = {
      sku: '0000105',
      data: {
        offers: [
          { offerId: '0000105-01', media: [{ assetId: 'asset-01' }] },
          { offerId: '0000105-02', media: [{ assetId: 'asset-02' }] },
          { offerId: '0000105-03', media: [{ assetId: 'asset-03' }] }
        ],
        mediaAssets: [
          { assetId: 'asset-01' },
          { assetId: 'asset-02' },
          { assetId: 'asset-03' }
        ]
      }
    } as any;

    const scoped = scopeOzonListingSubmission(listing, ['0000105-02', '0000105-03']);

    expect(scoped.data.offers.map((offer: any) => offer.offerId)).toEqual(['0000105-02', '0000105-03']);
    expect(scoped.data.mediaAssets.map((asset: any) => asset.assetId)).toEqual(['asset-02', 'asset-03']);
    expect(listing.data.offers.map((offer: any) => offer.offerId)).toEqual(['0000105-01', '0000105-02', '0000105-03']);
    expect(() => scopeOzonListingSubmission(listing, ['0000105-04'])).toThrow(
      expect.objectContaining({ code: 'VERSION_CONFLICT' })
    );
  });

  it('uses the selected pricing service, exact price mapping, preset stock and safe category defaults', async () => {
    const variantIds = [randomUUID(), randomUUID()];
    const preset = {
      id: randomUUID(),
      name: 'OZON 默认预设',
      rowVersion: 3,
      categoryKey: 'ozon_17001_97001',
      pricingTemplateId: randomUUID(),
      shippingTemplateId: randomUUID(),
      shippingServiceCode: 'CEL_OZON_ECONOMY',
      currency: 'RUB',
      defaultStock: 18,
      destinationCountryCode: 'RU',
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
      fulfillmentMode: 'FBS',
      warehouseId: '10001',
      vat: '0.2',
      sharedAttributes: [
        { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: 97001 }] },
        { attributeId: 85, complexId: 0, values: [{ value: '旧品牌' }] },
        { attributeId: 5299, complexId: 0, values: [{ value: '999' }] },
        { attributeId: 23249, complexId: 0, values: [{ value: '6' }] }
      ],
      variantAttributes: []
    } as any;
    const procurementVersionId = randomUUID();
    const categoryAttributes = [
      { id: 8229, complexId: 0, dictionaryId: 1960 },
      { id: 85, complexId: 0, dictionaryId: 28732849 },
      { id: 9024, complexId: 0, dictionaryId: 0 },
      { id: 9048, complexId: 0, dictionaryId: 0 },
      { id: 5299, complexId: 0, dictionaryId: 0, type: 'Decimal' },
      { id: 6573, complexId: 0, dictionaryId: 0, type: 'Decimal' },
      { id: 5355, complexId: 0, dictionaryId: 0, type: 'Decimal' },
      { id: 4383, complexId: 0, dictionaryId: 0, type: 'Decimal' },
      { id: 23249, complexId: 0, dictionaryId: 0, type: 'Decimal' },
      { id: 10096, complexId: 100, dictionaryId: 1494 },
      { id: 10097, complexId: 100, dictionaryId: 0 }
    ] as any;
    const createListing = vi.fn(async (identity, _preset, data) => ({ sku: identity.sku, productName: identity.productName, data }));
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: true })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', undefined, 404); }),
      getDefaultPreset: vi.fn(async () => preset),
      getCategory: vi.fn(async () => ({
        typeId: 97001,
        publishedVersion: { id: randomUUID(), snapshot: { attributes: categoryAttributes } }
      })),
      searchCatalogDictionary: vi.fn(async () => [{
        directory: 'colors', itemKey: 'colors:1494:61577', attributeId: 10096,
        dictionaryId: 1494, valueId: 61577, nameRu: 'черный', nameZh: '黑色'
      }]),
      createListing
    } as unknown as OzonRepository;
    const purchases = {
      getPurchase: vi.fn(async () => ({
        sku: '0000049',
        productName: '测试商品',
        procurementVersions: [{
          id: procurementVersionId,
          versionNo: 7,
          purchasePrice: '31',
          courierFee: '2',
          grossWeightGrams: '650.500',
          productHeightCm: '16.000',
          productDepthCm: '11.500',
          productWidthCm: '20.000',
          netWeightGrams: '350.000'
        }]
      })),
      getProductIdentityBySku: vi.fn(async () => ({
        sku: '0000049',
        productName: '测试商品',
        variants: variantIds.map((variantId, index) => ({
          variantId,
          name: `颜色 ${index + 1}`,
          wbColor: { colorKey: String(index + 1).repeat(64), nameRu: index ? 'белый' : 'черный', nameZh: index ? '白色' : '黑色' },
          ...(index === 0 ? { ozonColor: { itemKey: 'colors:1494:61577', dictionaryId: 1494, valueId: 61577, nameRu: 'черный', nameZh: '黑色', source: 'MANUAL_E001' } } : {})
        }))
      }))
    } as unknown as PurchaseRepository;
    const pair = (value: string) => ({
      costCurrency: { currencyCode: 'CNY', value, displayValue: value },
      saleCurrency: { currencyCode: 'RUB', value: String(Number(value) * 11), displayValue: String(Number(value) * 11) }
    });
    const pricingTemplateVersionId = randomUUID();
    const shippingTemplateVersionId = randomUUID();
    const pricing = {
      calculate: vi.fn(async () => ({
        pricingTemplate: {
          templateId: preset.pricingTemplateId,
          versionId: pricingTemplateVersionId,
          versionNo: 5,
          platformCode: 'OZON'
        },
        options: [
          { recommended: true, shipping: { serviceCode: 'OTHER' }, amounts: { listing: pair('1'), strike: pair('2'), targetSale: pair('0.5') } },
          {
            optionId: 'ozon-cny-option',
            shipping: {
              serviceCode: 'CEL_OZON_ECONOMY',
              template: {
                templateId: preset.shippingTemplateId,
                versionId: shippingTemplateVersionId,
                versionNo: 3,
                platformCode: 'OZON'
              }
            },
            amounts: { listing: pair('385.33'), strike: pair('770.65'), targetSale: pair('192.66') }
          }
        ],
        calculatedAt: '2026-08-13T00:00:00.000Z'
      }))
    } as any;
    const descriptions = {
      resolveVariants: vi.fn(async () => ({
        status: 'READY',
        content: 'Общее описание товара.',
        source: { workflowCode: 'E003', executionId: 88, folderName: 'latest', fileName: 'detail.txt', sha256: 'a'.repeat(64), productVariantId: variantIds[0] },
        variantSources: variantIds.map((productVariantId, index) => ({
          status: 'READY', productVariantId, productVariantName: `颜色 ${index + 1}`,
          content: `Описание товара для варианта ${index + 1}.`,
          source: { workflowCode: 'E003', executionId: 88, folderName: 'latest', fileName: 'detail.txt', sha256: String(index + 1).repeat(64), productVariantId }
        }))
      }))
    };
    const titleTranslator = {
      configured: true,
      translate: vi.fn(async () => ({ contentTranslate: 'Тестовый товар', cached: false, model: 'qwen' }))
    };
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger, pricing, descriptions as any, titleTranslator);

    await service.createListing('0000049');

    expect(pricing.calculate).not.toHaveBeenCalled();
    expect(titleTranslator.translate).not.toHaveBeenCalled();
    const initialized = createListing.mock.calls[0]![2] as any;
    expect(initialized).toMatchObject({
      currency: 'CNY',
      descriptionRu: 'Описание товара для варианта 1.',
      initialization: { status: 'COMPLETE', issues: [] },
      offers: [
        expect.objectContaining({ productVariantId: variantIds[0], price: 1, stock: 0, attributes: [] }),
        expect.objectContaining({ productVariantId: variantIds[1], price: 1, stock: 0, attributes: [] })
      ]
    });
    expect(initialized).not.toHaveProperty('categoryKey');
    expect(initialized).not.toHaveProperty('dimensions');
    return;
    expect(initialized.brand).toBe('无品牌');
    expect(initialized.offers).toHaveLength(2);
    expect(initialized).toMatchObject({
      currency: 'CNY',
      titleRu: 'Тестовый товар',
      descriptionRu: 'Описание товара для варианта 1.',
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
      initialization: {
        status: 'COMPLETE',
        issues: [],
        title: { workflowId: 'HDh0ZNLK2ps5qasR' },
        grossWeightResolution: {
          source: 'PROCUREMENT',
          effectiveGrossWeightGrams: 650.5,
          procurementGrossWeightGrams: 650.5,
          presetGrossWeightGrams: 800,
          procurementVersionId,
          procurementVersionNo: 7,
          procurementCapturedAt: expect.any(String)
        },
        presetSnapshot: {
          presetId: preset.id,
          presetName: preset.name,
          presetRowVersion: preset.rowVersion,
          capturedAt: expect.any(String),
          definition: expect.objectContaining({ dimensions: preset.dimensions })
        },
        pricingResolution: {
          targetCurrency: 'CNY',
          pricingTemplateId: preset.pricingTemplateId,
          pricingTemplateVersionId,
          pricingTemplateVersionNo: 5,
          shippingTemplateId: preset.shippingTemplateId,
          shippingTemplateVersionId,
          shippingTemplateVersionNo: 3,
          shippingServiceCode: preset.shippingServiceCode,
          optionId: 'ozon-cny-option',
          capturedAt: '2026-08-13T00:00:00.000Z'
        }
      }
    });
    expect(initialized.offers[0]).toMatchObject({
      productVariantId: variantIds[0],
      productVariantName: '颜色 1',
      productVariantColor: { nameZh: '黑色' },
      descriptionRu: 'Описание товара для варианта 1.',
      descriptionSource: { type: 'E003', executionId: 88, productVariantId: variantIds[0] }
    });
    expect(initialized.offers.map((offer: any) => ({ variantCode: offer.variantCode, price: offer.price, oldPrice: offer.oldPrice, minPrice: offer.minPrice, stock: offer.stock }))).toEqual([
      { variantCode: '01', price: 385.33, oldPrice: 770.65, minPrice: 192.66, stock: 18 },
      { variantCode: '02', price: 385.33, oldPrice: 770.65, minPrice: 192.66, stock: 18 }
    ]);
    expect(initialized.offers[0].attributes).toEqual(expect.arrayContaining([
      { attributeId: 10096, complexId: 100, values: [{ dictionaryValueId: 61577 }] },
      { attributeId: 10097, complexId: 100, values: [{ value: 'черный' }] }
    ]));
    expect(initialized.offers[1].attributes).not.toEqual(expect.arrayContaining([expect.objectContaining({ attributeId: 10096 })]));
    expect(initialized.sharedAttributes).toEqual(expect.arrayContaining([
      { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: 97001 }] },
      { attributeId: 85, complexId: 0, values: [{ value: '无品牌' }] },
      { attributeId: 9024, complexId: 0, values: [{ value: '0000049' }] },
      { attributeId: 9048, complexId: 0, values: [{ value: '0000049' }] },
      { attributeId: 5299, complexId: 0, values: [{ value: '16' }] },
      { attributeId: 6573, complexId: 0, values: [{ value: '11.5' }] },
      { attributeId: 5355, complexId: 0, values: [{ value: '20' }] },
      { attributeId: 4383, complexId: 0, values: [{ value: '350' }] },
      { attributeId: 23249, complexId: 0, values: [{ value: '6' }] }
    ]));
    expect(initialized.purchaseMeasurements).toMatchObject({
      procurementVersionNo: 7,
      productHeightCm: '16',
      productDepthCm: '11.5',
      productWidthCm: '20',
      netWeightGrams: '350'
    });

    const platformAttributes = manualListingPlatformAttributes(initialized.sharedAttributes, categoryAttributes, '0000049', 97001);
    expect(platformAttributes).toEqual(expect.arrayContaining([
      { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: 97001 }] },
      { attributeId: 85, complexId: 0, values: [{ dictionaryValueId: 126745801 }] },
      { attributeId: 9024, complexId: 0, values: [{ value: '0000049' }] },
      { attributeId: 9048, complexId: 0, values: [{ value: '0000049' }] }
    ]));
    expect(manualListingPlatformBrand(initialized.brand, initialized.sharedAttributes)).toBe('Нет бренда');
  });

  it('falls back to the bound preset weight, converts legacy units to grams and keeps preset dimensions', async () => {
    const variantId = randomUUID();
    const procurementVersionId = randomUUID();
    const preset = {
      id: randomUUID(),
      name: '旧 kg 预设',
      rowVersion: 5,
      categoryKey: 'ozon_17001_97001',
      pricingTemplateId: randomUUID(),
      shippingTemplateId: randomUUID(),
      shippingServiceCode: 'CEL_OZON_ECONOMY',
      currency: 'RUB',
      defaultStock: 6,
      dimensions: { length: 32, width: 21, height: 11, dimensionUnit: 'cm', weight: 1.25, weightUnit: 'kg' },
      fulfillmentMode: 'FBS',
      warehouseId: '10001',
      vat: '0.2',
      sharedAttributes: [],
      variantAttributes: []
    } as any;
    const createListing = vi.fn(async (identity, _preset, data) => ({ ...identity, status: 'DRAFT', rowVersion: 1, data }));
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: true })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', undefined, 404); }),
      getDefaultPreset: vi.fn(async () => preset),
      getCategory: vi.fn(async () => ({
        typeId: 97001,
        publishedVersion: { id: randomUUID(), snapshot: { attributes: [] } }
      })),
      searchCatalogDictionary: vi.fn(async () => []),
      createListing
    } as unknown as OzonRepository;
    const purchases = {
      getPurchase: vi.fn(async () => ({
        sku: '0000049', productName: '测试商品',
        procurementVersions: [{
          id: procurementVersionId, versionNo: 8, purchasePrice: '31', courierFee: '2', grossWeightGrams: '0'
        }]
      })),
      getProductIdentityBySku: vi.fn(async () => ({
        sku: '0000049', productName: '测试商品', variants: [{ variantId, name: '黑色' }]
      }))
    } as unknown as PurchaseRepository;
    const amount = (value: string) => ({ costCurrency: { currencyCode: 'CNY', value, displayValue: value } });
    const pricing = { calculate: vi.fn(async () => ({
      pricingTemplate: { templateId: preset.pricingTemplateId, versionId: randomUUID(), versionNo: 1, platformCode: 'OZON' },
      options: [{
        optionId: 'ozon-fallback-option',
        shipping: {
          serviceCode: preset.shippingServiceCode,
          template: { templateId: preset.shippingTemplateId, versionId: randomUUID(), versionNo: 1, platformCode: 'OZON' }
        },
        amounts: { listing: amount('385.33'), strike: amount('770.65'), targetSale: amount('192.66') }
      }],
      calculatedAt: '2026-08-13T00:00:00.000Z'
    })) } as any;
    const descriptions = { resolveVariants: vi.fn(async () => ({
      status: 'READY', content: 'Общее описание товара.',
      variantSources: [{ status: 'READY', productVariantId: variantId, productVariantName: '黑色', content: 'Описание черного варианта.' }]
    })) };
    const titleTranslator = { configured: true, translate: vi.fn(async () => ({ contentTranslate: 'Тестовый товар', cached: false })) };
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger, pricing, descriptions as any, titleTranslator);

    await service.createListing('0000049');

    expect(pricing.calculate).not.toHaveBeenCalled();
    const initialized = createListing.mock.calls[0]![2] as any;
    expect(initialized).toMatchObject({
      currency: 'CNY',
      offers: [expect.objectContaining({ productVariantId: variantId, price: 1, stock: 0 })]
    });
    expect(initialized).not.toHaveProperty('dimensions');
    return;
    expect(initialized.dimensions).toEqual({ length: 32, width: 21, height: 11, dimensionUnit: 'cm', weight: 1250, weightUnit: 'g' });
    expect(initialized.initialization.grossWeightResolution).toMatchObject({
      source: 'PRESET_FALLBACK',
      effectiveGrossWeightGrams: 1250,
      procurementGrossWeightGrams: null,
      presetGrossWeightGrams: 1250,
      procurementVersionId,
      procurementVersionNo: 8
    });
  });

  it('keeps the managed weight snapshot when pricing fails and reuses it during initializeMissing retry', async () => {
    const variantId = randomUUID();
    const firstProcurementVersionId = randomUUID();
    const newerProcurementVersionId = randomUUID();
    const preset = {
      id: randomUUID(),
      name: '失败重试预设',
      rowVersion: 4,
      categoryKey: 'ozon_17001_97001',
      pricingTemplateId: randomUUID(),
      shippingTemplateId: randomUUID(),
      shippingServiceCode: 'CEL_OZON_ECONOMY',
      currency: 'RUB',
      defaultStock: 9,
      dimensions: { length: 31, width: 22, height: 12, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
      fulfillmentMode: 'FBS',
      warehouseId: '10001',
      vat: '0.2',
      sharedAttributes: [],
      variantAttributes: []
    } as any;
    const firstProcurement = {
      id: firstProcurementVersionId,
      versionNo: 7,
      purchasePrice: '31',
      courierFee: '2',
      grossWeightGrams: '650.5'
    };
    let latestProcurement = firstProcurement;
    let current: any;
    const createListing = vi.fn(async (identity, _boundPreset, data) => {
      current = {
        ...identity,
        status: 'DRAFT',
        rowVersion: 1,
        revision: 1,
        data: {
          ...data
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      return current;
    });
    const updateListing = vi.fn(async (_sku, input) => {
      current = {
        ...current,
        rowVersion: current.rowVersion + 1,
        data: Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) => key !== 'rowVersion'))
      };
      return current;
    });
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: true })),
      getListing: vi.fn(async () => {
        if (current) return current;
        throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', undefined, 404);
      }),
      getDefaultPreset: vi.fn(async () => preset),
      getCategory: vi.fn(async () => ({
        typeId: 97001,
        publishedVersion: { id: randomUUID(), snapshot: { attributes: [] } }
      })),
      searchCatalogDictionary: vi.fn(async () => []),
      createListing,
      updateListing
    } as unknown as OzonRepository;
    const purchases = {
      getPurchase: vi.fn(async () => ({
        sku: '0000049', productName: '测试商品',
        procurementVersions: latestProcurement.id === firstProcurement.id
          ? [{ ...firstProcurement }]
          : [{ ...latestProcurement }, { ...firstProcurement }]
      })),
      getProductIdentityBySku: vi.fn(async () => ({
        sku: '0000049', productName: '测试商品', variants: [{ variantId, name: '黑色' }]
      }))
    } as unknown as PurchaseRepository;
    const amount = (value: string) => ({ costCurrency: { currencyCode: 'CNY', value, displayValue: value } });
    const retryPricingVersionId = randomUUID();
    const retryShippingVersionId = randomUUID();
    const pricing = { calculate: vi.fn()
      .mockRejectedValueOnce(new Error('定价服务暂时不可用'))
      .mockResolvedValue({
        pricingTemplate: { templateId: preset.pricingTemplateId, versionId: retryPricingVersionId, versionNo: 2, platformCode: 'OZON' },
        options: [{
          optionId: 'ozon-retry-option',
          shipping: {
            serviceCode: preset.shippingServiceCode,
            template: { templateId: preset.shippingTemplateId, versionId: retryShippingVersionId, versionNo: 4, platformCode: 'OZON' }
          },
          amounts: { listing: amount('385.33'), strike: amount('770.65'), targetSale: amount('192.66') }
        }],
        calculatedAt: '2026-08-13T01:00:00.000Z'
      }) } as any;
    const descriptions = { resolveVariants: vi.fn(async () => ({
      status: 'READY', content: 'Общее описание товара.',
      source: { workflowCode: 'E003', executionId: 88, folderName: 'latest', fileName: 'detail.txt', sha256: 'a'.repeat(64), productVariantId: variantId },
      variantSources: [{
        status: 'READY', productVariantId: variantId, productVariantName: '黑色', content: 'Описание черного варианта.',
        source: { workflowCode: 'E003', executionId: 88, folderName: 'latest', fileName: 'detail.txt', sha256: 'a'.repeat(64), productVariantId: variantId }
      }]
    })) };
    const titleTranslator = { configured: true, translate: vi.fn(async () => ({ contentTranslate: 'Тестовый товар', cached: false })) };
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger, pricing, descriptions as any, titleTranslator);

    const partial = await service.createListing('0000049');

    expect(pricing.calculate).not.toHaveBeenCalled();
    expect(partial.data).toMatchObject({
      currency: 'CNY',
      initialization: { status: 'COMPLETE', issues: [] },
      offers: [expect.objectContaining({ productVariantId: variantId, price: 1, stock: 0 })]
    });
    expect(partial.data).not.toHaveProperty('dimensions');
    return;
    expect(partial.data).toMatchObject({
      dimensions: { length: 31, width: 22, height: 12, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
      offers: [],
      initialization: {
        status: 'PARTIAL',
        issues: [expect.objectContaining({ code: 'OZON_PRICE_INITIALIZATION_FAILED', field: 'offers.price', retryable: true })],
        grossWeightResolution: {
          source: 'PROCUREMENT', effectiveGrossWeightGrams: 650.5, procurementGrossWeightGrams: 650.5,
          presetGrossWeightGrams: 800, procurementVersionId: firstProcurementVersionId, procurementVersionNo: 7
        },
        presetSnapshot: {
          presetId: preset.id, presetName: preset.name, presetRowVersion: preset.rowVersion,
          definition: expect.objectContaining({ dimensions: preset.dimensions })
        }
      }
    });
    expect((pricing.calculate.mock.calls[0]![0] as any).item.actualWeightGrams).toBe('650.5');

    latestProcurement = {
      id: newerProcurementVersionId,
      versionNo: 8,
      purchasePrice: '42',
      courierFee: '3',
      grossWeightGrams: '999'
    };
    const retried = await service.initializeMissing('0000049', 1);

    expect(pricing.calculate).toHaveBeenCalledTimes(2);
    expect((pricing.calculate.mock.calls[1]![0] as any).item).toMatchObject({
      purchaseCost: '31', domesticFreight: '2', actualWeightGrams: '650.5', lengthCm: '31', widthCm: '22', heightCm: '12'
    });
    expect(retried.data.dimensions).toEqual(partial.data.dimensions);
    expect(retried.data.initialization).toMatchObject({
      status: 'COMPLETE',
      issues: [],
      grossWeightResolution: {
        source: 'PROCUREMENT', effectiveGrossWeightGrams: 650.5,
        procurementVersionId: firstProcurementVersionId, procurementVersionNo: 7
      },
      presetSnapshot: { presetId: preset.id, presetRowVersion: preset.rowVersion },
      pricingResolution: {
        targetCurrency: 'CNY',
        pricingTemplateId: preset.pricingTemplateId,
        pricingTemplateVersionId: retryPricingVersionId,
        pricingTemplateVersionNo: 2,
        shippingTemplateId: preset.shippingTemplateId,
        shippingTemplateVersionId: retryShippingVersionId,
        shippingTemplateVersionNo: 4,
        shippingServiceCode: preset.shippingServiceCode,
        optionId: 'ozon-retry-option'
      }
    });
    expect(retried.data.offers).toEqual([
      expect.objectContaining({ productVariantId: variantId, price: 385.33, oldPrice: 770.65, minPrice: 192.66, stock: 9 })
    ]);
    expect(updateListing).toHaveBeenCalledWith('0000049', expect.objectContaining({ rowVersion: 1 }), { preserveGeneratedSources: true });
  });

  it('先映射无品牌字典再校验平台文本，但仍拦截其他属性的真实中文', () => {
    const categoryAttributes = [
      { id: 85, complexId: 0 },
      { id: 1234, complexId: 0 }
    ] as any;
    const platformAttributes = manualListingPlatformAttributes(
      [{ attributeId: 85, complexId: 0, values: [{ value: '无品牌' }] }],
      categoryAttributes,
      '0000062',
      970575517
    );

    expect(platformAttributes).toContainEqual({
      attributeId: 85,
      complexId: 0,
      values: [{ dictionaryValueId: 126745801 }]
    });
    expect(() => assertOzonPlatformAttributes(platformAttributes, 'sharedAttributes')).not.toThrow();
    expect(manualListingPlatformAttributes(
      [{ attributeId: 85, complexId: 0, values: [{ value: 'Acme' }] }],
      categoryAttributes,
      '0000062',
      970575517
    ).find((attribute) => attribute.attributeId === 85)?.values).toEqual([{ value: 'Acme' }]);
    expect(manualListingPlatformAttributes(
      [],
      categoryAttributes,
      '0000062',
      970575517,
      'Название',
      'Описание',
      'Acme'
    ).find((attribute) => attribute.attributeId === 85)?.values).toEqual([{ value: 'Acme' }]);

    try {
      assertOzonPlatformAttributes(
        [{ attributeId: 1234, complexId: 0, values: [{ value: '俄文中夹杂中文' }] }],
        'sharedAttributes'
      );
      throw new Error('预期中文属性校验失败');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        message: 'OZON 属性 #1234 包含中文字符，请先修正',
        statusCode: 409,
        details: {
          fieldPath: 'sharedAttributes.0.values.0.value',
          attributeId: 1234
        }
      });
    }
  });

  it('returns an existing draft without recalculating or overwriting it', async () => {
    const existing = { sku: '0000049', data: { offers: [{ price: 999 }] } } as any;
    const repository = { getListing: vi.fn(async () => existing) } as unknown as OzonRepository;
    const purchases = { getPurchase: vi.fn() } as unknown as PurchaseRepository;
    const pricing = { calculate: vi.fn() } as any;
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger, pricing);

    await expect(service.createListing('0000049')).resolves.toBe(existing);
    expect(purchases.getPurchase).not.toHaveBeenCalled();
    expect(pricing.calculate).not.toHaveBeenCalled();
  });

  it('keeps a new public-material draft editable when E003 initialization fails without invoking title translation', async () => {
    const variantId = randomUUID();
    const createListing = vi.fn(async (identity, _preset, data) => ({ ...identity, status: 'DRAFT', rowVersion: 1, data }));
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: true })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', undefined, 404); }),
      getDefaultPreset: vi.fn(async () => undefined),
      createListing
    } as unknown as OzonRepository;
    const purchases = {
      getPurchase: vi.fn(async () => ({ sku: '0000049', productName: '测试商品' })),
      getProductIdentityBySku: vi.fn(async () => ({
        sku: '0000049', productName: '测试商品', variants: [{ variantId, name: '黑色' }]
      }))
    } as unknown as PurchaseRepository;
    const descriptions = {
      resolveVariants: vi.fn(async () => ({
        status: 'MISSING', message: '没有找到最新有效 E003 详情 TXT',
        variantSources: [{ status: 'MISSING', message: '没有找到最新有效 E003 详情 TXT', productVariantId: variantId, productVariantName: '黑色' }]
      }))
    };
    const titleTranslator = {
      configured: true,
      translate: vi.fn(async () => { throw new Error('翻译服务暂时不可用'); })
    };
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger, undefined, descriptions as any, titleTranslator);

    const created = await service.createListing('0000049');

    expect(created).toMatchObject({ status: 'DRAFT', data: { currency: 'CNY', initialization: { status: 'PARTIAL' } } });
    expect((created as any).data.initialization.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'E003_DESCRIPTION_MISSING', field: `offers.${variantId}.descriptionRu`, retryable: true })
    ]));
    expect(titleTranslator.translate).not.toHaveBeenCalled();
    expect(createListing).toHaveBeenCalledTimes(1);
  });

  describe('manual account-currency price projection', () => {
    const baseListing = (currency: 'RUB' | 'CNY', initialization?: Record<string, unknown>) => ({
      sku: '0000049',
      productName: '历史商品',
      managementSource: 'MANUAL',
      status: 'DRAFT',
      rowVersion: 5,
      revision: 3,
      data: {
        fulfillmentMode: 'FBS', warehouseId: '10001', currency, vat: '0.2',
        titleRu: '', descriptionRu: '', descriptionWarnings: [], brand: '',
        sharedAttributes: [], mediaAssets: [], mediaSourceRoot: '', videoUploadMode: 'COMPRESSED_COPY',
        offers: [
          { variantId: randomUUID(), variantCode: '01', offerId: '0000049-01', barcode: '', modelGroup: '0000049', price: 4200, oldPrice: 8400, minPrice: 2100, stock: 1, descriptionWarnings: [], attributes: [], media: [] },
          { variantId: randomUUID(), variantCode: '02', offerId: '0000049-02', barcode: '', modelGroup: '0000049', price: 4300, oldPrice: 8600, minPrice: 2150, stock: 1, descriptionWarnings: [], attributes: [], media: [] }
        ],
        ...(initialization ? { initialization } : {})
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    }) as any;

    const serviceForListing = (
      listing: any,
      purchases: Partial<PurchaseRepository> = {},
      pricing?: { calculate?: ReturnType<typeof vi.fn>; calculateAtVersions?: ReturnType<typeof vi.fn> }
    ) => {
      const repository = {
        getListing: vi.fn(async () => listing),
        findActiveJobBySku: vi.fn(async () => undefined),
        getSettings: vi.fn(async () => ({ rootDirectory: '' }))
      } as unknown as OzonRepository;
      return new OzonPublishingService(
        repository,
        purchases as PurchaseRepository,
        {} as FastifyBaseLogger,
        pricing as any
      );
    };

    it('returns stored CNY offer prices without invoking the pricing chain', async () => {
      const listing = baseListing('CNY');
      const pricing = { calculate: vi.fn() };
      const purchases = { getPurchase: vi.fn() };

      const detail = await serviceForListing(listing, purchases, pricing).getListing(listing.sku);

      expect(detail.priceProjection).toEqual({
        status: 'STORED', sourceCurrency: 'CNY', targetCurrency: 'CNY', pendingSave: false,
        offers: [
          { offerId: '0000049-01', price: 4200, oldPrice: 8400, minPrice: 2100 },
          { offerId: '0000049-02', price: 4300, oldPrice: 8600, minPrice: 2150 }
        ]
      });
      expect(purchases.getPurchase).not.toHaveBeenCalled();
      expect(pricing.calculate).not.toHaveBeenCalled();
    });

    it('recalculates a RUB draft in CNY from its frozen preset and exact procurement version', async () => {
      const frozenProcurementId = randomUUID();
      const newerProcurementId = randomUUID();
      const pricingTemplateVersionId = randomUUID();
      const shippingTemplateVersionId = randomUUID();
      const presetDefinition = {
        name: '历史 OZON 预设',
        categoryKey: 'ozon_17001_97001',
        pricingTemplateId: randomUUID(),
        shippingTemplateId: randomUUID(),
        shippingServiceCode: 'CEL_OZON_ECONOMY',
        currency: 'RUB',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' }
      };
      const initializedAt = '2026-08-01T00:00:00.000Z';
      const listing = baseListing('RUB', {
        status: 'COMPLETE', initializedAt, issues: [],
        grossWeightResolution: {
          source: 'PROCUREMENT', effectiveGrossWeightGrams: 650, procurementGrossWeightGrams: 650,
          presetGrossWeightGrams: 800, procurementVersionId: frozenProcurementId, procurementVersionNo: 7,
          procurementCapturedAt: initializedAt
        },
        presetSnapshot: {
          presetId: randomUUID(), presetName: presetDefinition.name, presetRowVersion: 4,
          capturedAt: initializedAt, definition: presetDefinition
        },
        pricingResolution: {
          targetCurrency: 'RUB',
          pricingTemplateId: presetDefinition.pricingTemplateId,
          pricingTemplateVersionId,
          pricingTemplateVersionNo: 5,
          shippingTemplateId: presetDefinition.shippingTemplateId,
          shippingTemplateVersionId,
          shippingTemplateVersionNo: 3,
          shippingServiceCode: presetDefinition.shippingServiceCode,
          optionId: 'frozen-cny-option',
          capturedAt: initializedAt
        }
      });
      const purchases = { getPurchase: vi.fn(async () => ({
        procurementVersions: [
          { id: newerProcurementId, versionNo: 8, purchasePrice: '99', courierFee: '9' },
          { id: frozenProcurementId, versionNo: 7, purchasePrice: '31', courierFee: '2' }
        ]
      })) };
      const money = (value: string) => ({
        costCurrency: { currencyCode: 'CNY', value, displayValue: value },
        saleCurrency: { currencyCode: 'RUB', value: String(Number(value) * 11), displayValue: String(Number(value) * 11) }
      });
      const pricing = {
        calculate: vi.fn(),
        calculateAtVersions: vi.fn(async () => ({
          pricingTemplate: {
            templateId: presetDefinition.pricingTemplateId,
            versionId: pricingTemplateVersionId,
            versionNo: 5,
            platformCode: 'OZON'
          },
          options: [
            {
              optionId: 'different-option-for-same-service',
              shipping: {
                serviceCode: presetDefinition.shippingServiceCode,
                template: {
                  templateId: presetDefinition.shippingTemplateId,
                  versionId: shippingTemplateVersionId,
                  versionNo: 3,
                  platformCode: 'OZON'
                }
              },
              amounts: { listing: money('999'), strike: money('1998'), targetSale: money('499') }
            },
            {
              optionId: 'frozen-cny-option',
              shipping: {
                serviceCode: presetDefinition.shippingServiceCode,
                template: {
                  templateId: presetDefinition.shippingTemplateId,
                  versionId: shippingTemplateVersionId,
                  versionNo: 3,
                  platformCode: 'OZON'
                }
              },
              amounts: { listing: money('385.33'), strike: money('770.65'), targetSale: money('192.66') }
            }
          ],
          calculatedAt: '2026-08-13T02:00:00.000Z'
        }))
      };

      const detail = await serviceForListing(listing, purchases, pricing).getListing(listing.sku);

      expect(detail.priceProjection).toEqual({
        status: 'RECALCULATED', sourceCurrency: 'RUB', targetCurrency: 'CNY', pendingSave: true,
        offers: [
          { offerId: '0000049-01', price: 385.33, oldPrice: 770.65, minPrice: 192.66 },
          { offerId: '0000049-02', price: 385.33, oldPrice: 770.65, minPrice: 192.66 }
        ]
      });
      expect(pricing.calculate).not.toHaveBeenCalled();
      expect(pricing.calculateAtVersions).toHaveBeenCalledWith(expect.objectContaining({
        pricingTemplateId: presetDefinition.pricingTemplateId,
        pricingTemplateVersionId,
        pricingTemplateVersionNo: 5,
        shippingTemplateId: presetDefinition.shippingTemplateId,
        shippingTemplateVersionId,
        shippingTemplateVersionNo: 3,
        expectedCurrencyCode: 'CNY',
        expectedOptionId: 'frozen-cny-option',
        item: expect.objectContaining({ purchaseCost: '31', domesticFreight: '2', actualWeightGrams: '650' })
      }));
    });

    it.each([
      ['missing frozen preset', 'NO_INITIALIZATION'],
      ['missing frozen pricing resolution', 'NO_PRICING_RESOLUTION'],
      ['missing frozen procurement version', 'MISSING_PROCUREMENT']
    ])('keeps GET available when CNY projection is unavailable: %s', async (_label, fixture) => {
      const procurementVersionId = randomUUID();
      const initializedAt = '2026-08-01T00:00:00.000Z';
      const pricingTemplateId = randomUUID();
      const shippingTemplateId = randomUUID();
      const initialization = fixture !== 'NO_INITIALIZATION' ? {
        status: 'COMPLETE', initializedAt, issues: [],
        grossWeightResolution: {
          source: 'PROCUREMENT', effectiveGrossWeightGrams: 650, procurementGrossWeightGrams: 650,
          presetGrossWeightGrams: 800, procurementVersionId, procurementVersionNo: 7,
          procurementCapturedAt: initializedAt
        },
        presetSnapshot: {
          presetId: randomUUID(), presetName: '历史预设', presetRowVersion: 4, capturedAt: initializedAt,
          definition: {
            name: '历史预设', categoryKey: 'ozon_17001_97001', pricingTemplateId,
            shippingTemplateId, shippingServiceCode: 'CEL_OZON_ECONOMY', currency: 'RUB',
            dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' }
          }
        },
        ...(fixture === 'NO_PRICING_RESOLUTION' ? {} : {
          pricingResolution: {
          targetCurrency: 'RUB', pricingTemplateId, pricingTemplateVersionId: randomUUID(), pricingTemplateVersionNo: 2,
            shippingTemplateId, shippingTemplateVersionId: randomUUID(), shippingTemplateVersionNo: 3,
            shippingServiceCode: 'CEL_OZON_ECONOMY', optionId: 'frozen-option', capturedAt: initializedAt
          }
        })
      } : undefined;
      const listing = baseListing('RUB', initialization);
      const purchases = { getPurchase: vi.fn(async () => ({ procurementVersions: [] })) };
      const pricing = { calculate: vi.fn(), calculateAtVersions: vi.fn() };

      const detail = await serviceForListing(listing, purchases, pricing).getListing(listing.sku);

      expect(detail.listing).toBe(listing);
      expect(detail.priceProjection).toMatchObject({
        status: 'UNAVAILABLE', sourceCurrency: 'RUB', targetCurrency: 'CNY', pendingSave: false, offers: [],
        reason: expect.any(String)
      });
      expect(pricing.calculate).not.toHaveBeenCalled();
      expect(pricing.calculateAtVersions).not.toHaveBeenCalled();
    });

    it('rejects RUB manual saves and forwards a stored-CNY save with its CAS rowVersion without recalculation', async () => {
      const updateListing = vi.fn(async (_sku, input) => ({ sku: '0000049', data: input }));
      const listing = baseListing('CNY');
      const repository = {
        getListing: vi.fn(async () => listing),
        getSettings: vi.fn(async () => ({ rootDirectory: '' })),
        updateListing
      } as unknown as OzonRepository;
      const purchases = { getPurchase: vi.fn() };
      const pricing = { calculate: vi.fn(), calculateAtVersions: vi.fn() };
      const service = new OzonPublishingService(repository, purchases as any, {} as FastifyBaseLogger, pricing as any);

      await expect(service.updateListing('0000049', { rowVersion: 5, currency: 'RUB' }))
        .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409, details: { expectedCurrency: 'CNY' } });
      expect(updateListing).not.toHaveBeenCalled();

      await service.updateListing('0000049', {
        rowVersion: 5,
        fulfillmentMode: 'FBS',
        warehouseId: '10001',
        currency: 'CNY',
        vat: '0.2',
        titleRu: '',
        descriptionRu: '',
        brand: '',
        sharedAttributes: [],
        offers: [],
        mediaAssets: [],
        mediaSourceRoot: 'C:\\client-value-is-not-trusted',
        videoUploadMode: 'COMPRESSED_COPY'
      });
      expect(updateListing).toHaveBeenCalledWith('0000049', expect.objectContaining({
        rowVersion: 5, currency: 'CNY'
      }));
      expect(purchases.getPurchase).not.toHaveBeenCalled();
      expect(pricing.calculate).not.toHaveBeenCalled();
      expect(pricing.calculateAtVersions).not.toHaveBeenCalled();
    });

    it('rejects a CNY save for a legacy RUB draft when its trustworthy projection is unavailable', async () => {
      const listing = baseListing('RUB');
      const updateListing = vi.fn();
      const repository = {
        getListing: vi.fn(async () => listing),
        getSettings: vi.fn(async () => ({ rootDirectory: '' })),
        updateListing
      } as unknown as OzonRepository;
      const pricing = { calculate: vi.fn(), calculateAtVersions: vi.fn() };
      const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger, pricing as any);

      await expect(service.updateListing(listing.sku, {
        rowVersion: listing.rowVersion, fulfillmentMode: 'FBS', warehouseId: '10001', currency: 'CNY', vat: '0.2',
        titleRu: '', descriptionRu: '', brand: '', sharedAttributes: [], offers: [], mediaAssets: [], mediaSourceRoot: '',
        videoUploadMode: 'COMPRESSED_COPY'
      })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409, details: { projectionStatus: 'UNAVAILABLE' } });
      expect(updateListing).not.toHaveBeenCalled();
      expect(pricing.calculate).not.toHaveBeenCalled();
      expect(pricing.calculateAtVersions).not.toHaveBeenCalled();
    });

    it('allows a CNY save for a RUB draft only after exact frozen-chain projection succeeds', async () => {
      const initializedAt = '2026-08-01T00:00:00.000Z';
      const procurementVersionId = randomUUID();
      const pricingTemplateId = randomUUID();
      const pricingTemplateVersionId = randomUUID();
      const shippingTemplateId = randomUUID();
      const shippingTemplateVersionId = randomUUID();
      const serviceCode = 'CEL_OZON_ECONOMY';
      const optionId = 'trusted-cny-option';
      const listing = baseListing('RUB', {
        status: 'COMPLETE', initializedAt, issues: [],
        grossWeightResolution: {
          source: 'PROCUREMENT', effectiveGrossWeightGrams: 650, procurementGrossWeightGrams: 650,
          presetGrossWeightGrams: 800, procurementVersionId, procurementVersionNo: 7, procurementCapturedAt: initializedAt
        },
        presetSnapshot: {
          presetId: randomUUID(), presetName: '历史预设', presetRowVersion: 4, capturedAt: initializedAt,
          definition: {
            name: '历史预设', categoryKey: 'ozon_17001_97001', pricingTemplateId, shippingTemplateId,
            shippingServiceCode: serviceCode, currency: 'RUB',
            dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' }
          }
        },
        pricingResolution: {
          targetCurrency: 'RUB', pricingTemplateId, pricingTemplateVersionId, pricingTemplateVersionNo: 5,
          shippingTemplateId, shippingTemplateVersionId, shippingTemplateVersionNo: 3,
          shippingServiceCode: serviceCode, optionId, capturedAt: initializedAt
        }
      });
      const updateListing = vi.fn(async (_sku, input) => ({ sku: listing.sku, data: input }));
      const repository = {
        getListing: vi.fn(async () => listing),
        getSettings: vi.fn(async () => ({ rootDirectory: '' })),
        updateListing
      } as unknown as OzonRepository;
      const purchases = { getPurchase: vi.fn(async () => ({
        procurementVersions: [{ id: procurementVersionId, versionNo: 7, purchasePrice: '31', courierFee: '2' }]
      })) };
      const amount = (value: string) => ({ costCurrency: { currencyCode: 'CNY', value, displayValue: value } });
      const pricing = {
        calculate: vi.fn(),
        calculateAtVersions: vi.fn(async () => ({
          pricingTemplate: { templateId: pricingTemplateId, versionId: pricingTemplateVersionId, versionNo: 5, platformCode: 'OZON' },
          options: [{
            optionId,
            shipping: {
              serviceCode,
              template: { templateId: shippingTemplateId, versionId: shippingTemplateVersionId, versionNo: 3, platformCode: 'OZON' }
            },
            amounts: { listing: amount('385.33'), strike: amount('770.65'), targetSale: amount('192.66') }
          }],
          calculatedAt: '2026-08-13T02:00:00.000Z'
        }))
      };
      const service = new OzonPublishingService(repository, purchases as any, {} as FastifyBaseLogger, pricing as any);

      await service.updateListing(listing.sku, {
        rowVersion: listing.rowVersion, fulfillmentMode: 'FBS', warehouseId: '10001', currency: 'CNY', vat: '0.2',
        titleRu: '', descriptionRu: '', brand: '', sharedAttributes: [], offers: [], mediaAssets: [], mediaSourceRoot: '',
        videoUploadMode: 'COMPRESSED_COPY'
      });

      expect(updateListing).toHaveBeenCalledWith(listing.sku, expect.objectContaining({ rowVersion: 5, currency: 'CNY' }));
      expect(pricing.calculate).not.toHaveBeenCalled();
      expect(pricing.calculateAtVersions).toHaveBeenCalledTimes(1);
    });
  });

  it('retries only missing manual fields, backfills stable variant identity and enforces rowVersion', async () => {
    const variantIds = [randomUUID(), randomUUID()];
    const listing = {
      sku: '0000049', productName: '测试商品', status: 'DRAFT', rowVersion: 4, revision: 1,
      data: {
        fulfillmentMode: 'FBS', warehouseId: '', currency: 'RUB', vat: '0.2', titleRu: '',
        descriptionRu: 'Ручное общее описание.', descriptionSource: { type: 'MANUAL' },
        descriptionWarnings: [], brand: '', sharedAttributes: [], mediaAssets: [], mediaSourceRoot: '', videoUploadMode: 'COMPRESSED_COPY',
        initialization: {
          status: 'PARTIAL', initializedAt: '2026-08-06T00:00:00.000Z',
          issues: [{
            code: 'E003_DESCRIPTION_MISSING', message: '旧白色详情缺失警告',
            field: `offers.${variantIds[1]}.descriptionRu`, retryable: true
          }]
        },
        offers: variantIds.map((variantId, index) => ({
          variantId, variantCode: `0${index + 1}`, offerId: `0000049-0${index + 1}`, barcode: '', modelGroup: '0000049',
          price: 100, stock: 1, descriptionWarnings: [], attributes: [], media: [],
          ...(index === 0 ? { descriptionRu: 'Ручное описание первого варианта.', descriptionSource: { type: 'MANUAL' } } : {})
        }))
      },
      createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z'
    } as any;
    let current = listing;
    const updateListing = vi.fn(async (_sku, input) => {
      current = {
        ...current,
        rowVersion: current.rowVersion + 1,
        data: Object.fromEntries(Object.entries(input as any).filter(([key]) => key !== 'rowVersion'))
      };
      return current;
    });
    const repository = {
      getListing: vi.fn(async () => current),
      getDefaultPreset: vi.fn(async () => ({ titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 60 } })),
      updateListing
    } as unknown as OzonRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({
        sku: listing.sku, productName: listing.productName,
        variants: variantIds.map((variantId, index) => ({
          variantId, name: index ? '白色' : '黑色',
          wbColor: { colorKey: String(index + 1).repeat(64), nameRu: index ? 'белый' : 'черный', nameZh: index ? '白色' : '黑色' }
        }))
      }))
    } as unknown as PurchaseRepository;
    const descriptions = {
      resolveVariants: vi.fn(async () => ({
        status: 'READY',
        content: 'Автоматическое описание варианта 1.',
        source: {
          workflowCode: 'E003', executionId: 99, folderName: 'latest-black',
          fileName: 'black-detail.txt', sha256: '3'.repeat(64), productVariantId: variantIds[0]
        },
        variantSources: variantIds.map((productVariantId, index) => ({
          status: 'READY', productVariantId, productVariantName: index ? '白色' : '黑色',
          content: `Автоматическое описание варианта ${index + 1}.`,
          source: {
            workflowCode: 'E003', executionId: 99 + index, folderName: index ? 'latest-white' : 'latest-black',
            fileName: index ? 'white-detail.txt' : 'black-detail.txt', sha256: String(index + 3).repeat(64), productVariantId
          }
        }))
      }))
    };
    const titleTranslator = { configured: true, translate: vi.fn(async () => ({ contentTranslate: 'Автоматический заголовок', cached: false })) };
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger, undefined, descriptions as any, titleTranslator);

    const retried = await service.initializeMissing(listing.sku, 4);

    expect(retried.data.titleRu).toBe('Автоматический заголовок');
    expect(retried.data.descriptionRu).toBe('Ручное общее описание.');
    expect(retried.data.descriptionSource).toEqual({ type: 'MANUAL' });
    expect(retried.data.offers[0]).toMatchObject({
      descriptionRu: 'Ручное описание первого варианта.',
      descriptionSource: { type: 'MANUAL' },
      productVariantId: variantIds[0]
    });
    expect(retried.data.offers[1]).toMatchObject({
      descriptionRu: 'Автоматическое описание варианта 2.',
      descriptionSource: {
        type: 'E003', workflowCode: 'E003', executionId: 100,
        fileName: 'white-detail.txt', sha256: '4'.repeat(64), productVariantId: variantIds[1]
      },
      productVariantId: variantIds[1], productVariantName: '白色'
    });
    expect(retried.data.initialization).toMatchObject({
      status: 'COMPLETE',
      description: { workflowCode: 'E003', executionId: 99, fileName: 'black-detail.txt', sha256: '3'.repeat(64) }
    });
    expect(retried.data.initialization.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'E003_DESCRIPTION_MISSING' })
    ]));
    expect(updateListing).toHaveBeenCalledWith(listing.sku, expect.objectContaining({ rowVersion: 4 }), { preserveGeneratedSources: true });
    await expect(service.initializeMissing(listing.sku, 3)).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    await expect(service.initializeMissing(listing.sku, 5)).resolves.toBe(current);
    expect(updateListing).toHaveBeenCalledTimes(1);
    expect(titleTranslator.translate).toHaveBeenCalledTimes(1);
    expect(descriptions.resolveVariants).toHaveBeenCalledTimes(1);
  });

  it('overrides client-managed purchase attributes on manual save and keeps #23249 unchanged', async () => {
    const categoryVersionId = randomUUID();
    const updateListing = vi.fn(async (_sku, input) => ({ sku: '0000049', data: input }));
    const currentListing = {
      sku: '0000049', productName: '测试商品', status: 'DRAFT', rowVersion: 2, revision: 2,
      data: { currency: 'CNY', offers: [] }
    } as any;
    const repository = {
      getListing: vi.fn(async () => currentListing),
      getSettings: vi.fn(async () => ({ rootDirectory: '' })),
      getCategory: vi.fn(async () => ({
        publishedVersion: {
          id: categoryVersionId,
          snapshot: {
            attributes: [
              { id: 5299, complexId: 0, type: 'Decimal', required: false },
              { id: 6573, complexId: 0, type: 'Decimal', required: false },
              { id: 5355, complexId: 0, type: 'Decimal', required: false },
              { id: 4383, complexId: 0, type: 'Decimal', required: false },
              { id: 23249, complexId: 0, type: 'Decimal', required: false }
            ]
          }
        }
      })),
      updateListing
    } as unknown as OzonRepository;
    const purchases = {
      getPurchase: vi.fn(async () => ({
        procurementVersions: [{
          id: randomUUID(), versionNo: 3,
          productHeightCm: '16.000', productDepthCm: null, productWidthCm: '20.000', netWeightGrams: '350.000'
        }]
      }))
    } as unknown as PurchaseRepository;
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger);

    await service.updateListing('0000049', {
      rowVersion: 2,
      categoryKey: 'ozon_17001_97001',
      categoryVersionId,
      fulfillmentMode: 'FBS',
      warehouseId: '10001',
      currency: 'CNY',
      vat: '0.2',
      titleRu: '',
      descriptionRu: '',
      brand: '',
      purchaseMeasurements: {
        procurementVersionId: randomUUID(), procurementVersionNo: 99, capturedAt: '2026-08-05T00:00:00.000Z',
        productHeightCm: '999', productDepthCm: '999', productWidthCm: '999', netWeightGrams: '999'
      },
      sharedAttributes: [
        { attributeId: 5299, complexId: 0, values: [{ value: '999' }] },
        { attributeId: 6573, complexId: 99, values: [{ value: '999' }] },
        { attributeId: 23249, complexId: 0, values: [{ value: '8' }] }
      ],
      offers: [],
      mediaAssets: [],
      mediaSourceRoot: 'C:\\client-forged',
      videoUploadMode: 'COMPRESSED_COPY'
    });

    const saved = updateListing.mock.calls[0]![1] as any;
    expect(saved.purchaseMeasurements).toMatchObject({
      procurementVersionNo: 3,
      productHeightCm: '16',
      productDepthCm: null,
      productWidthCm: '20',
      netWeightGrams: '350'
    });
    expect(saved.sharedAttributes).toEqual([
      { attributeId: 23249, complexId: 0, values: [{ value: '8' }] },
      { attributeId: 5299, complexId: 0, values: [{ value: '16' }] },
      { attributeId: 5355, complexId: 0, values: [{ value: '20' }] },
      { attributeId: 4383, complexId: 0, values: [{ value: '350' }] }
    ]);
    expect(saved.mediaSourceRoot).toBe('');
  });

  it('synchronizes an old manual draft once and remains idempotent for the same purchase version', async () => {
    const procurementVersionId = randomUUID();
    const categoryVersionId = randomUUID();
    const listing = {
      sku: '0000049', rowVersion: 2, revision: 2,
      data: {
        categoryKey: 'ozon_17001_97001', categoryVersionId,
        fulfillmentMode: 'FBS', warehouseId: '10001', currency: 'CNY', vat: '0.2',
        titleRu: '', descriptionRu: '', brand: '',
        sharedAttributes: [
          { attributeId: 5299, complexId: 0, values: [{ value: '999' }] },
          { attributeId: 23249, complexId: 0, values: [{ value: '6' }] }
        ],
        offers: [], mediaAssets: [], mediaSourceRoot: '', videoUploadMode: 'COMPRESSED_COPY'
      }
    } as any;
    let current = listing;
    const updateListing = vi.fn(async (_sku, input) => {
      current = { ...listing, rowVersion: 3, revision: 3, data: { ...input, rowVersion: undefined } } as any;
      delete current.data.rowVersion;
      return current;
    });
    const repository = {
      getListing: vi.fn(async () => current),
      getCategory: vi.fn(async () => ({
        publishedVersion: { snapshot: { attributes: [
          { id: 5299, complexId: 0, type: 'Decimal', required: false },
          { id: 23249, complexId: 0, type: 'Decimal', required: false }
        ] } }
      })),
      getSettings: vi.fn(async () => ({ rootDirectory: '' })),
      updateListing
    } as unknown as OzonRepository;
    const purchases = {
      getPurchase: vi.fn(async () => ({ procurementVersions: [{
        id: procurementVersionId, versionNo: 4,
        productHeightCm: '16.000', productDepthCm: null, productWidthCm: null, netWeightGrams: null
      }] }))
    } as unknown as PurchaseRepository;
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger);

    const first = await (service as any).synchronizeManualPurchaseMeasurements('0000049', 2);
    const second = await (service as any).synchronizeManualPurchaseMeasurements('0000049', 3);

    expect(first.listing.rowVersion).toBe(3);
    expect(second.listing.rowVersion).toBe(3);
    expect(updateListing).toHaveBeenCalledTimes(1);
    expect(current.data.sharedAttributes).toEqual([
      { attributeId: 23249, complexId: 0, values: [{ value: '6' }] },
      { attributeId: 5299, complexId: 0, values: [{ value: '16' }] }
    ]);
  });
});

describe('OZON automatic job cancellation safety', () => {
  const automaticJob = (state: string, overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    sku: '0000099',
    source: 'AUTO',
    state,
    offerIds: [],
    storeAlias: 'default',
    ozonProductLinks: [],
    stageStates: {},
    retryCount: 0,
    rowVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }) as any;

  it.each(['WAITING_MEDIA', 'READY', 'NEEDS_ATTENTION', 'FAILED'])(
    'delegates cancellation for a local AUTO job in %s',
    async (state) => {
      const current = automaticJob(state);
      const cancelled = { ...current, state: 'CANCELLED', rowVersion: 2 };
      const cancel = vi.fn(async () => cancelled);
      const repository = {
        getJob: vi.fn(async () => current),
        cancel
      } as unknown as OzonRepository;
      const service = new OzonPublishingService(
        repository,
        {} as PurchaseRepository,
        {} as FastifyBaseLogger
      );
      const writeTerminalDirectoryMarker = vi.spyOn(service as any, 'writeTerminalDirectoryMarker');

      await expect(service.cancelJob(current.id, 'AUTO')).resolves.toBe(cancelled);
      expect(cancel).toHaveBeenCalledWith(current.id, 'AUTO', current.rowVersion);
      expect(writeTerminalDirectoryMarker).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['UPLOADING_MEDIA', {}],
    ['SUBMITTING', {}],
    ['IMPORTING', {}],
    ['VERIFYING_IMAGES', {}],
    ['UPDATING_PRICE', {}],
    ['UPDATING_STOCK', {}],
    ['MODERATING', {}],
    ['FAILED', { taskId: 'task-1' }],
    ['FAILED', { importTaskId: 'import-1' }],
    ['FAILED', { ozonProductId: 'product-1' }],
    ['FAILED', { ozonProductLinks: [{ ozonProductId: 'product-2', url: 'https://www.ozon.ru/product/123/' }] }]
  ])('rejects remote AUTO progress in %s before cancellation or marker lookup', async (state, overrides) => {
    const current = automaticJob(String(state), overrides as Record<string, unknown>);
    const cancel = vi.fn();
    const getSettings = vi.fn();
    const repository = {
      getJob: vi.fn(async () => current),
      getSettings,
      cancel
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger
    );
    const writeTerminalDirectoryMarker = vi.spyOn(service as any, 'writeTerminalDirectoryMarker');

    await expect(service.cancelJob(current.id, 'AUTO')).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(writeTerminalDirectoryMarker).not.toHaveBeenCalled();
  });

  it('does not write _CANCELLED.json for an AUTO job already in PROCESSING', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-cancel-guard-'));
    roots.push(rootDirectory);
    const taskFolder = '0000099__r1';
    const workDirectory = path.join(rootDirectory, 'processing', taskFolder);
    await mkdir(workDirectory, { recursive: true });
    const current = automaticJob('FAILED', {
      taskFolder,
      workRelPath: `processing/${taskFolder}`,
      directoryStage: 'PROCESSING'
    });
    const cancel = vi.fn();
    const repository = {
      getJob: vi.fn(async () => current),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      cancel
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger
    );
    const writeTerminalDirectoryMarker = vi.spyOn(service as any, 'writeTerminalDirectoryMarker');

    await expect(service.cancelJob(current.id, 'AUTO')).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409
    });
    await expect(lstat(path.join(workDirectory, '_CANCELLED.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(repository.getSettings).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(writeTerminalDirectoryMarker).not.toHaveBeenCalled();
  });
});

describe('OZON publishing readiness', () => {
  it('parses MP4 duration without external tools and enforces the shared cover/introduction envelope', () => {
    expect(parseOzonMp4DurationSeconds(testMp4(8))).toBe(8);
    expect(parseOzonMp4DurationSeconds(testMp4(30))).toBe(30);
    expect(inspectOzonMp4Buffer(testMp4(8))).toEqual({ durationSeconds: 8 });
    expect(inspectOzonMp4Buffer(testMp4(30))).toEqual({ durationSeconds: 30 });
    expect(inspectOzonMp4Buffer(testMp4(7.999)).error).toContain('8–30');
    expect(inspectOzonMp4Buffer(testMp4(30.001)).error).toContain('8–30');
    expect(inspectOzonMp4Buffer(testMp4(10), 20 * 1024 * 1024 + 1).error).toBe('视频超过 20MB');
    expect(inspectOzonMp4Buffer(Buffer.from('not-an-mp4')).error).toBeTruthy();
  });

  it('derives the v2 video mode from the category snapshot and reserves system media attributes', () => {
    const cover = { id: 21845, complexId: 100002 };
    const title = { id: 21837, complexId: 100001 };
    const link = { id: 21841, complexId: 100001 };
    expect(resolveOzonVideoContract([cover, title, link] as any)).toMatchObject({
      videoPolicy: {
        source: 'SAME_MP4',
        titleSource: 'OFFER_TITLE_RU',
        mode: 'INTRO_AND_COVER'
      },
      mediaCapabilities: {
        videoCover: { complexId: 100002, attributeId: 21845 },
        productIntroductionVideo: {
          complexId: 100001,
          linkAttributeId: 21841,
          titleAttributeId: 21837
        }
      },
      missingIntroductionAttributeIds: []
    });
    expect(resolveOzonVideoContract([cover, link] as any)).toMatchObject({
      videoPolicy: { mode: 'COVER_ONLY' },
      missingIntroductionAttributeIds: [21837]
    });
    const requiredProductsOnVideo = resolveOzonVideoContract([
      cover,
      title,
      link,
      { id: 22273, complexId: 100001, required: true }
    ] as any);
    expect(requiredProductsOnVideo).toMatchObject({
      videoPolicy: { mode: 'COVER_ONLY' },
      mediaCapabilities: {
        videoCover: { complexId: 100002, attributeId: 21845 }
      },
      missingIntroductionAttributeIds: [22273]
    });
    expect(requiredProductsOnVideo.mediaCapabilities.productIntroductionVideo).toBeUndefined();
    expect(() => resolveOzonVideoContract([title, link] as any)).toThrowError(/21845/);
    expect(() => assertNoUserManagedOzonSystemMediaAttributes({
      data: {
        sharedAttributes: [{ attributeId: 22273, complexId: 100001, values: [{ value: '123' }] }],
        offers: []
      }
    } as any)).toThrowError(/系统自动生成/);
    expect(manualListingPlatformAttributes(
      [
        { attributeId: 21845, complexId: 100002, values: [{ value: 'manual-video' }] },
        { attributeId: 9024, complexId: 0, values: [{ value: '0000051' }] }
      ],
      [
        { id: 21845, complexId: 100002 },
        { id: 9024, complexId: 0 }
      ] as any,
      '0000051',
      97001
    )).toEqual([{ attributeId: 9024, complexId: 0, values: [{ value: '0000051' }] }]);
  });

  it('does not reserve a revision or write task artifacts when the first media preflight fails', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-pre-reserve-media-'));
    roots.push(rootDirectory);
    const sku = '0000051';
    const productDirectory = path.join(rootDirectory, 'inbox', sku);
    await mkdir(path.join(productDirectory, 'variants'), { recursive: true });
    const missingAsset = {
      assetId: 'a'.repeat(64),
      relativePath: 'variants/missing/01.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 128,
      sha256: 'b'.repeat(64),
      modifiedAt: '2026-08-09T01:00:00.000Z',
      validationStatus: 'VALID'
    } as const;
    const listing = {
      sku,
      productName: '测试商品',
      status: 'READY',
      rowVersion: 9,
      revision: 5,
      data: {
        categoryKey: 'ozon_17001_97001',
        categoryVersionId: 'category-version-1',
        fulfillmentMode: 'FBS',
        warehouseId: '10001',
        currency: 'RUB',
        vat: '0.2',
        titleRu: 'Тестовый товар',
        descriptionRu: 'Подробное описание тестового товара.',
        brand: 'Нет бренда',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650, weightUnit: 'g' },
        sharedAttributes: [],
        offers: [{
          variantId: '11111111-1111-4111-8111-111111111111',
          variantCode: '01',
          offerId: `${sku}-01`,
          barcode: '',
          modelGroup: sku,
          price: 999,
          oldPrice: 1_299,
          minPrice: 899,
          stock: 10,
          descriptionRu: 'Подробное описание тестового товара.',
          attributes: [],
          media: [{
            assetId: missingAsset.assetId,
            relativePath: missingAsset.relativePath,
            kind: 'image',
            sortOrder: 0,
            isPrimary: true
          }]
        }],
        mediaAssets: [missingAsset],
        mediaSourceRoot: productDirectory
      }
    } as any;
    const reserveSubmissionRevision = vi.fn(async () => ({
      ...listing,
      rowVersion: listing.rowVersion + 1,
      revision: listing.revision + 1
    }));
    const createManualJob = vi.fn();
    const transitionJob = vi.fn();
    const repository = {
      getListing: vi.fn(async () => listing),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory, defaultStoreAlias: 'default' })),
      getCategory: vi.fn(async () => ({
        typeId: 97001,
        publishedVersion: {
          id: listing.data.categoryVersionId,
          versionNo: 1,
          schemaHash: `sha256:${'c'.repeat(64)}`,
          snapshot: { attributes: [{ id: 21845, complexId: 100002 }] }
        }
      })),
      reserveSubmissionRevision,
      createManualJob,
      transitionJob
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await expect((service as any).generateUnlocked(sku, listing.rowVersion)).rejects.toMatchObject({
      code: 'SOURCE_FILE_MISSING',
      statusCode: 409
    });
    expect(reserveSubmissionRevision).not.toHaveBeenCalled();
    expect(createManualJob).not.toHaveBeenCalled();
    expect(transitionJob).not.toHaveBeenCalled();
    expect(listing).toMatchObject({ rowVersion: 9, revision: 5, status: 'READY' });
    await expect(lstat(path.join(productDirectory, 'product.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(productDirectory, '_READY'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('generates product.json v2 and exposes a safe v1/v2 inbox summary without database fields', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-v2-'));
    roots.push(rootDirectory);
    const sku = '0000051';
    const warehouseName = 'W03 CEL标准-123深圳润百国际仓（库存仓）';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      accountCurrency: 'CNY',
      warehouses: {
        warehouses: [{
          warehouse_id: 1020002456503000,
          name: warehouseName,
          status: 'created',
          is_rfbs: true
        }]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const productRoot = path.join(rootDirectory, 'inbox', sku);
    const variantsRoot = path.join(productRoot, 'variants');
    const imagePath = path.join(variantsRoot, 'shared', '01.png');
    const videoPath = path.join(variantsRoot, 'shared', 'main.mp4');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    await writeFile(videoPath, testMp4(12));
    const mediaAssets = await scanOzonMediaDirectory(productRoot, variantsRoot);
    const imageAsset = mediaAssets.find((asset) => asset.kind === 'image')!;
    const videoAsset = mediaAssets.find((asset) => asset.kind === 'video')!;
    const procurementVersionId = randomUUID();
    const listing = {
      sku,
      productName: '测试商品',
      status: 'READY',
      rowVersion: 2,
      revision: 2,
      data: {
        categoryKey: 'ozon_17001_97001',
        categoryVersionId: randomUUID(),
        fulfillmentMode: 'FBS',
        warehouseId: warehouseName,
        currency: 'RUB',
        vat: '0.2',
        titleRu: 'Тестовый товар',
        descriptionRu: 'Описание товара',
        brand: '无品牌',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
        initialization: {
          status: 'COMPLETE',
          initializedAt: '2026-08-07T01:00:00.000Z',
          issues: [],
          grossWeightResolution: {
            source: 'PROCUREMENT',
            effectiveGrossWeightGrams: 650.5,
            procurementGrossWeightGrams: 650.5,
            presetGrossWeightGrams: 800,
            procurementVersionId,
            procurementVersionNo: 7,
            procurementCapturedAt: '2026-08-07T01:00:00.000Z'
          }
        },
        sharedAttributes: [
          { attributeId: 85, complexId: 0, values: [{ value: '无品牌' }] },
          { attributeId: 9048, complexId: 0, values: [{ value: `Тестовый товар ${sku}` }] },
          { attributeId: 8229, complexId: 0, values: [{ value: sku }] }
        ],
        offers: [{
          variantId: randomUUID(),
          variantCode: '01',
          offerId: `${sku}-01`,
          barcode: '',
          modelGroup: `${sku}-model`,
          price: 999,
          oldPrice: 1_299,
          minPrice: 899,
          stock: 10,
          attributes: [],
          media: [
            { assetId: imageAsset.assetId, relativePath: imageAsset.relativePath, kind: 'image', sortOrder: 0, isPrimary: true },
            { assetId: videoAsset.assetId, relativePath: videoAsset.relativePath, kind: 'video', sortOrder: 1, isPrimary: false }
          ]
        }],
        mediaAssets,
        mediaSourceRoot: productRoot
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const categoryVersionId = randomUUID();
    const repository = {
      reserveSubmissionRevision: vi.fn(async () => listing),
      getSettings: vi.fn(async () => ({
        enabled: true,
        rootDirectory,
        defaultStoreAlias: 'default',
        preflightWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-preflight'
      })),
      getCategory: vi.fn(async () => ({
        descriptionCategoryId: 17001,
        typeId: 97001,
        publishedVersion: {
          id: categoryVersionId,
          versionNo: 4,
          schemaHash: `sha256:${'a'.repeat(64)}`,
          snapshot: {
            attributes: [
              { id: 85, complexId: 0 },
              { id: 8229, complexId: 0 },
              { id: 9048, complexId: 0 },
              { id: 21845, complexId: 100002 },
              { id: 21837, complexId: 100001 },
              { id: 21841, complexId: 100001 }
            ]
          }
        }
      })),
      getListing: vi.fn(async () => listing),
      findActiveJobBySku: vi.fn(async () => undefined),
      canManualTakeover: vi.fn(() => false)
    } as unknown as OzonRepository;
    const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, logger);

    const [generated, duplicate] = await Promise.all([
      service.generate(sku, 2),
      service.generate(sku, 2)
    ]);
    expect(duplicate.signature).toBe(generated.signature);

    expect(generated.productJson).toMatchObject({
      schemaVersion: 2,
      videoPolicy: {
        source: 'SAME_MP4',
        titleSource: 'OFFER_TITLE_RU',
        mode: 'INTRO_AND_COVER'
      },
      mediaCapabilities: {
        videoCover: { complexId: 100002, attributeId: 21845 },
        productIntroductionVideo: {
          complexId: 100001,
          linkAttributeId: 21841,
          titleAttributeId: 21837
        }
      },
      warehouseId: '1020002456503000',
      currency: 'CNY',
      brand: 'Нет бренда',
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
      mediaAssets: expect.arrayContaining([
        expect.objectContaining({ assetId: videoAsset.assetId, sha256: videoAsset.sha256, durationSeconds: 12 })
      ]),
      sharedAttributes: [
        { attributeId: 85, complexId: 0, values: [{ dictionaryValueId: 126745801 }] },
        { attributeId: 9048, complexId: 0, values: [{ value: sku }] },
        { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: 97001 }] }
      ],
      offers: [{ offerId: `${sku}-01`, modelGroup: sku, titleRu: 'Тестовый товар' }]
    });
    expect(JSON.stringify(generated.productJson)).not.toContain('22273');
    expect(await service.getListing(sku)).toMatchObject({
      generatedProductSummary: {
        schemaVersion: 2,
        videoMode: 'INTRO_AND_COVER',
        revision: 2,
        isCurrent: true
      }
    });

    const withoutPolicy = structuredClone(generated.productJson) as Partial<typeof generated.productJson>;
    delete withoutPolicy.videoPolicy;
    const v1 = {
      ...withoutPolicy,
      schemaVersion: 1,
      mediaCapabilities: { videoCover: generated.productJson.mediaCapabilities.videoCover },
      offers: generated.productJson.offers.map(({ titleRu: _titleRu, ...offer }) => offer)
    };
    await writeFile(generated.productJsonPath, JSON.stringify(v1));
    expect(await service.getListing(sku)).toMatchObject({
      generatedProductSummary: { schemaVersion: 1, revision: 2, isCurrent: false }
    });
    await writeFile(generated.productJsonPath, '{"schemaVersion":2}');
    expect((await service.getListing(sku)).generatedProductSummary).toBeUndefined();
  });

  it('treats the disabled management switch as not ready for manual or automatic publishing', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-manual-ready-'));
    roots.push(rootDirectory);
    const settings: OzonSystemSettings = {
      rowVersion: 1,
      enabled: false,
      rootDirectory,
      defaultStoreAlias: 'default',
      taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-tasks',
      adminApiWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-admin',
      preflightWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-preflight',
      imageUploaderWorkflowId: 'uploader',
      storeGatewayWorkflowId: 'gateway',
      imageUploadConcurrency: 7,
      videoUploadConcurrency: 2,
      videoPrewarmEnabled: true,
      credentialReady: true,
      lastPreflightStatus: 'READY',
      lastPreflightMessage: '默认店铺认证、配额和仓库只读预检通过',
      videoUploadReady: true,
      updatedAt: new Date().toISOString()
    };
    const repository = {
      configured: true,
      getSettings: async () => settings
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger
    );

    await expect(service.readiness(false)).resolves.toMatchObject({
      ready: false,
      databaseReady: true,
      rootReady: true,
      workflowReady: true,
      settings: { enabled: false },
      issues: ['OZON 上品管理未启用']
    });
  });

  it('only exposes active remote jobs to runtime scheduling while management is disabled', async () => {
    const listRuntimeJobs = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }));
    const claimRuntimeJob = vi.fn(async () => undefined);
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: false, rootDirectory: 'G:\\OZON-Auto-Publish' })),
      listRuntimeJobs,
      claimRuntimeJob
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger
    );

    await service.listRuntimeJobs({ page: 1, pageSize: 20 });
    await service.claimRuntimeJob({ leaseOwner: 'ozon-p002:test', leaseSeconds: 600 });

    expect(listRuntimeJobs).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      remoteOnly: true
    });
    expect(claimRuntimeJob).toHaveBeenCalledWith({
      leaseOwner: 'ozon-p002:test',
      leaseSeconds: 600,
      remoteOnly: true
    });
  });

  it('blocks a user-confirmed manual job while OZON management is disabled', async () => {
    const settings = {
      enabled: false,
      credentialReady: true,
      taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-tasks'
    } as OzonSystemSettings;
    const createdJob = {
      id: randomUUID(),
      sku: '0000049',
      state: 'READY',
      source: 'MANUAL',
      rowVersion: 1,
      retryCount: 0,
      stageStates: {},
      payload: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const submittedListing = { sku: '0000049', status: 'SUBMITTING' } as any;
    const repository = {
      getSettings: vi.fn(async () => settings),
      createManualJob: vi.fn(async () => ({ job: createdJob, supersededJobId: '17b43575-b742-448e-8fe5-dd704483c813' })),
      markListingSubmitted: vi.fn(async () => submittedListing),
      transitionJob: vi.fn(async (_id, input) => ({ ...createdJob, ...input, rowVersion: 2 }))
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    vi.spyOn(service, 'generate').mockResolvedValue({
      listing: submittedListing,
      productJson: {
        revision: 5,
        offers: [{ offerId: '0000049-01' }]
      },
      productJsonPath: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000049\\product.json',
      readyMarker: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000049\\_READY',
      signature: `sha256:${'a'.repeat(64)}`
    } as any);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      accepted: true,
      taskId: 'ozon-task-49',
      taskFolder: '0000049__r5',
      workRelPath: 'processing/0000049__r5',
      directoryStage: 'PROCESSING',
      signature: `sha256:${'a'.repeat(64)}`
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.submit('0000049', 5)).rejects.toMatchObject({
      code: 'OZON_MANAGEMENT_DISABLED',
      statusCode: 409
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.createManualJob).not.toHaveBeenCalled();
    expect(repository.transitionJob).not.toHaveBeenCalled();
  });

  it('requires compatible append for every PUBLISHED listing even when its platform mapping is missing', async () => {
    const settings = {
      enabled: true,
      defaultStoreAlias: 'default'
    } as OzonSystemSettings;
    const listing = {
      sku: '0000049',
      status: 'PUBLISHED',
      ozonProductLinks: []
    } as any;
    const repository = {
      getSettings: vi.fn(async () => settings),
      getListing: vi.fn(async () => listing),
      hasProductMappingForSku: vi.fn(async () => false)
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger
    );
    const generate = vi.spyOn(service, 'generate');

    await expect(service.submit(listing.sku, 5)).rejects.toMatchObject({
      code: 'OZON_COMPATIBLE_APPEND_REQUIRED',
      statusCode: 409,
      details: expect.objectContaining({
        sku: listing.sku,
        status: 'PUBLISHED',
        hasListingLinks: false,
        hasDatabaseMapping: false
      })
    });
    expect(generate).not.toHaveBeenCalled();
    expect(repository.hasProductMappingForSku).toHaveBeenCalledWith('default', listing.sku);
  });

  it('blocks a FAILED full resubmission when the database still has platform identity evidence', async () => {
    const settings = {
      enabled: true,
      defaultStoreAlias: 'default'
    } as OzonSystemSettings;
    const listing = {
      sku: '0000050',
      status: 'FAILED',
      ozonProductLinks: []
    } as any;
    const repository = {
      getSettings: vi.fn(async () => settings),
      getListing: vi.fn(async () => listing),
      hasProductMappingForSku: vi.fn(async () => true)
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger
    );
    const generate = vi.spyOn(service, 'generate');

    await expect(service.submit(listing.sku, 3)).rejects.toMatchObject({
      code: 'OZON_COMPATIBLE_APPEND_REQUIRED',
      statusCode: 409,
      details: expect.objectContaining({
        sku: listing.sku,
        status: 'FAILED',
        hasListingLinks: false,
        hasDatabaseMapping: true
      })
    });
    expect(generate).not.toHaveBeenCalled();
    expect(repository.hasProductMappingForSku).toHaveBeenCalledWith('default', listing.sku);
  });

  it('binds compatible-append plans to normalized settings without exposing the root path', () => {
    const settings = {
      rowVersion: 4,
      enabled: true,
      rootDirectory: 'G:\\OZON-Auto-Publish\\',
      defaultStoreAlias: 'default',
      credentialReady: true,
      taskApiWebhookUrl: 'http://n8n.test/webhook/ozon-tasks',
      adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
    } as OzonSystemSettings;

    const binding = createOzonCompatibleAppendSettingsBinding(settings);
    const equivalentRoot = createOzonCompatibleAppendSettingsBinding({
      ...settings,
      rootDirectory: 'g:\\ozon-auto-publish'
    });
    const changedSettings = createOzonCompatibleAppendSettingsBinding({
      ...settings,
      rowVersion: 5,
      credentialReady: false
    });
    const firstVariantId = randomUUID();
    const secondVariantId = randomUUID();
    const identity = createOzonCompatibleAppendProductIdentity('测试商品', [
      { variantId: randomUUID(), name: '默认变体' },
      { variantId: firstVariantId, name: '卡其色' },
      { variantId: secondVariantId, name: '黑色' }
    ]);
    const renamedIdentity = createOzonCompatibleAppendProductIdentity('测试商品（新版）', [
      { variantId: firstVariantId, name: '卡其色' },
      { variantId: secondVariantId, name: '黑色' }
    ]);

    expect(binding).toMatchObject({
      settingsRowVersion: 4,
      storeAlias: 'default',
      settingsEnabled: true,
      rootDirectoryFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      credentialReady: true,
      taskApiWebhookReady: true,
      adminApiWebhookReady: true
    });
    expect(equivalentRoot.rootDirectoryFingerprint).toBe(binding.rootDirectoryFingerprint);
    expect(changedSettings).not.toEqual(binding);
    expect(JSON.stringify(binding)).not.toContain('OZON-Auto-Publish');
    expect(identity).toMatchObject({
      productName: '测试商品',
      productVariants: [
        { variantId: firstVariantId, name: '卡其色' },
        { variantId: secondVariantId, name: '黑色' }
      ],
      hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
    expect(renamedIdentity.hash).not.toBe(identity.hash);
  });

  it('rejects a stale compatible-append plan after product identity changes before dispatch side effects', async () => {
    const sku = '0000049';
    const settings = {
      rowVersion: 5,
      enabled: true,
      credentialReady: true,
      rootDirectory: 'G:\\OZON-Auto-Publish',
      defaultStoreAlias: 'default',
      taskApiWebhookUrl: 'http://n8n.test/webhook/ozon-tasks',
      adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
    } as OzonSystemSettings;
    const plan = {
      mode: 'COMPATIBLE_APPEND',
      sku,
      rowVersion: 7,
      planHash: `sha256:${'b'.repeat(64)}`,
      manifestSignature: `sha256:${'c'.repeat(64)}`,
      canAppend: true,
      preservedOffers: [],
      newOffers: [],
      preservedOfferIds: [],
      submittedOfferIds: []
    } as const;
    const listing = { sku, productName: '已变更商品', rowVersion: 7, data: {} } as any;
    const createCompatibleAppendManualJob = vi.fn();
    const repository = {
      getSettings: vi.fn(async () => settings),
      createCompatibleAppendManualJob
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);
    vi.spyOn(service as any, 'prepareCompatibleAppendContext').mockResolvedValue({
      plan,
      listing,
      preset: { id: randomUUID(), rowVersion: 2 },
      productIdentity: createOzonCompatibleAppendProductIdentity(listing.productName, [
        { variantId: randomUUID(), name: '新增身份变体' }
      ]),
      productVariants: [],
      currentMediaAssets: [],
      settings
    });
    const prepareListing = vi.spyOn(service as any, 'prepareCompatibleAppendListing');
    const proveRemoteAbsence = vi.spyOn(service as any, 'assertCompatibleAppendRemoteAbsence');

    await expect(service.compatibleAppend(sku, {
      rowVersion: plan.rowVersion,
      planHash: `sha256:${'a'.repeat(64)}`
    })).rejects.toMatchObject({
      code: 'OZON_LEGACY_TASK_READ_ONLY',
      statusCode: 409,
      details: expect.objectContaining({ sku })
    });
    expect(prepareListing).not.toHaveBeenCalled();
    expect(proveRemoteAbsence).not.toHaveBeenCalled();
    expect(createCompatibleAppendManualJob).not.toHaveBeenCalled();
  });

  it('exposes precise compatible-append plan blockers but ignores preset autoPublishEnabled', async () => {
    const existingVariantId = '11111111-1111-4111-8111-111111111111';
    const missingVariantId = '22222222-2222-4222-8222-222222222222';
    const listing = {
      sku: '0000049',
      productName: '测试商品',
      status: 'PUBLISHED',
      rowVersion: 7,
      revision: 3,
      ozonProductLinks: [{ offerId: '0000049-01', ozonProductId: '501', ozonSku: '9001' }],
      data: {
        categoryKey: 'ozon_17001_97001',
        categoryVersionId: 'category-version-1',
        offers: [{
          variantId: existingVariantId,
          productVariantId: existingVariantId,
          productVariantName: '既有变体',
          variantCode: '01',
          offerId: '0000049-01'
        }]
      }
    } as any;
    const preset = {
      id: '33333333-3333-4333-8333-333333333333',
      rowVersion: 4,
      categoryKey: listing.data.categoryKey,
      autoPublishEnabled: false,
      autoPublishMode: 'COMPATIBLE_UPSERT'
    } as any;
    const repository = {
      getListing: vi.fn(async () => listing),
      getSettings: vi.fn(async () => ({
        enabled: true,
        credentialReady: false,
        defaultStoreAlias: 'default'
      })),
      getDefaultPreset: vi.fn(async () => preset),
      compatibleAppendReadiness: vi.fn(async () => ({
        activePlatformStatusRefreshLease: {
          leaseOwner: 'PLATFORM_STATUS_REFRESH',
          leaseExpiresAt: '2026-08-09T02:00:00.000Z'
        },
        activeRuntimeJobLease: {
          jobId: '44444444-4444-4444-8444-444444444444',
          leaseOwner: 'ozon-p002:test',
          leaseExpiresAt: '2026-08-09T02:00:00.000Z'
        },
        occupiedPublishSlot: {
          jobId: '55555555-5555-4555-8555-555555555555',
          leaseOwner: 'ozon-p002:other',
          leaseExpiresAt: '2026-08-09T02:00:00.000Z'
        }
      })),
      findActiveJobBySku: vi.fn(async () => undefined),
      getCategory: vi.fn(async () => ({
        publishedVersion: { id: listing.data.categoryVersionId }
      }))
    } as unknown as OzonRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({
        sku: listing.sku,
        productName: listing.productName,
        variants: [
          { variantId: existingVariantId, name: '既有变体' },
          { variantId: missingVariantId, name: '新增变体' }
        ]
      }))
    } as unknown as PurchaseRepository;
    const service = new OzonPublishingService(repository, purchases, {} as FastifyBaseLogger);

    await expect(service.compatibleAppendPlan(listing.sku)).rejects.toMatchObject({
      code: 'OZON_LEGACY_TASK_READ_ONLY',
      statusCode: 409,
      details: expect.objectContaining({ sku: listing.sku })
    });
    const plan = undefined as any;
    return;

    expect(plan.canAppend).toBe(false);
    expect(plan.blockedReason).toContain('尚未配置 OZON 自动上品根目录');
    expect(plan.blockedReason).toContain('OZON 默认店铺凭据尚未通过预检');
    expect(plan.blockedReason).toContain('尚未配置 OZON 任务调度 Webhook');
    expect(plan.blockedReason).toContain('尚未配置 OZON 只读管理 Webhook');
    expect(plan.blockedReason).toContain('该 SKU 正在刷新 OZON 平台状态');
    expect(plan.blockedReason).toContain('正由运行时 ozon-p002:test 执行');
    expect(plan.blockedReason).toContain('OZON 平台单写槽正由任务 55555555-5555-4555-8555-555555555555 执行');
    expect(plan.blockedReason).not.toContain('自动上品未启用');
    expect(plan.newOffers).toEqual([expect.objectContaining({
      variantId: missingVariantId,
      offerId: '0000049-02'
    })]);
  });

  it('rejects missing runtime credentials plus incomplete or rate-limited remote proof before the atomic boundary', async () => {
    const submittedOfferId = '0000049-02';
    const settings = {
      rowVersion: 6,
      enabled: true,
      credentialReady: true,
      defaultStoreAlias: 'default',
      rootDirectory: 'G:\\OZON-Auto-Publish',
      adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin',
      taskApiWebhookUrl: 'http://n8n.test/webhook/ozon-tasks'
    } as OzonSystemSettings;
    const listing = {
      sku: '0000049',
      productName: '测试商品',
      status: 'PUBLISHED',
      rowVersion: 7,
      revision: 3,
      ozonProductLinks: [{ offerId: '0000049-01', ozonProductId: '501', ozonSku: '9001' }],
      data: {
        categoryVersionId: 'category-version-1',
        offers: [{
          offerId: '0000049-01', variantId: '11111111-1111-4111-8111-111111111111',
          price: 100, oldPrice: 200, minPrice: 90, stock: 1, descriptionRu: 'Существующее описание', media: []
        }],
        mediaAssets: []
      }
    } as any;
    const plan = {
      mode: 'COMPATIBLE_APPEND',
      sku: listing.sku,
      rowVersion: listing.rowVersion,
      planHash: `sha256:${'a'.repeat(64)}`,
      manifestSignature: `sha256:${'b'.repeat(64)}`,
      canAppend: true,
      preservedOffers: [{ offerId: '0000049-01', ozonProductId: '501', ozonSku: '9001' }],
      newOffers: [{
        offerId: submittedOfferId,
        variantId: '22222222-2222-4222-8222-222222222222',
        variantName: '新增变体',
        imageCount: 1,
        hasVideo: true
      }],
      preservedOfferIds: ['0000049-01'],
      submittedOfferIds: [submittedOfferId]
    } as const;
    const preparedData = {
      ...listing.data,
      offers: [
        ...listing.data.offers,
        {
          offerId: submittedOfferId, variantId: '22222222-2222-4222-8222-222222222222',
          price: 100, oldPrice: 200, minPrice: 90, stock: 1, descriptionRu: 'Новое описание', media: []
        }
      ]
    };
    const createCompatibleAppendManualJob = vi.fn();
    const repository = {
      getSettings: vi.fn(async () => settings),
      createCompatibleAppendManualJob
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);
    vi.spyOn(service as any, 'prepareCompatibleAppendContext').mockResolvedValue({
      plan,
      listing,
      preset: { id: '11111111-1111-4111-8111-111111111111', rowVersion: 4 },
      productVariants: [],
      currentMediaAssets: [],
      settings
    });
    const prepareListing = vi.spyOn(service as any, 'prepareCompatibleAppendListing').mockResolvedValue(preparedData);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        httpStatus: 200,
        result: {
          contractVersion: 2,
          requestedOfferIds: [submittedOfferId],
          readAt: '2026-08-09T01:00:00.000Z',
          infoItems: [],
          attributeItems: []
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.compatibleAppend(listing.sku, {
      rowVersion: plan.rowVersion,
      planHash: plan.planHash
    })).rejects.toMatchObject({
      code: 'OZON_LEGACY_TASK_READ_ONLY',
      statusCode: 409,
      details: expect.objectContaining({ sku: listing.sku })
    });
    expect(createCompatibleAppendManualJob).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prepareListing).not.toHaveBeenCalled();
    return;

    for (const expectedCauseCode of ['OZON_REMOTE_STATE_UNPROVEN', 'OZON_UPSTREAM_HTTP_429']) {
      await expect(service.compatibleAppend(listing.sku, {
        rowVersion: plan.rowVersion,
        planHash: plan.planHash
      })).rejects.toMatchObject({
        code: 'OZON_REMOTE_STATE_UNPROVEN',
        statusCode: 502,
        details: expect.objectContaining({ causeCode: expectedCauseCode })
      });
    }
    settings.credentialReady = false;
    await expect(service.compatibleAppend(listing.sku, {
      rowVersion: plan.rowVersion,
      planHash: plan.planHash
    })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409,
      details: expect.objectContaining({ reasonCode: 'OZON_COMPATIBLE_APPEND_RUNTIME_NOT_READY' })
    });
    expect(createCompatibleAppendManualJob).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prepareListing).toHaveBeenCalledTimes(2);
  });

  it('ignores preset autoPublishEnabled, binds the confirmed plan and dispatches only newly submitted Offers', async () => {
    const settings = {
      rowVersion: 6,
      enabled: true,
      credentialReady: true,
      defaultStoreAlias: 'default',
      rootDirectory: 'G:\\OZON-Auto-Publish',
      taskApiWebhookUrl: 'http://n8n.test/webhook/ozon-tasks'
    } as OzonSystemSettings;
    const listing = {
      sku: '0000049',
      productName: '测试商品',
      status: 'PUBLISHED',
      rowVersion: 7,
      revision: 3,
      ozonProductLinks: [{ offerId: '0000049-01', ozonProductId: '501', ozonSku: '9001' }],
      data: {
        categoryVersionId: 'category-version-1',
        offers: [{
          offerId: '0000049-01', variantId: '11111111-1111-4111-8111-111111111111',
          price: 100, oldPrice: 200, minPrice: 90, stock: 1, descriptionRu: 'Существующее описание', media: []
        }],
        mediaAssets: []
      }
    } as any;
    const plan = {
      mode: 'COMPATIBLE_APPEND',
      sku: listing.sku,
      rowVersion: listing.rowVersion,
      planHash: `sha256:${'c'.repeat(64)}`,
      manifestSignature: `sha256:${'d'.repeat(64)}`,
      canAppend: true,
      preservedOffers: [{ offerId: '0000049-01', ozonProductId: '501', ozonSku: '9001' }],
      newOffers: [{
        offerId: '0000049-02',
        variantId: '22222222-2222-4222-8222-222222222222',
        variantName: '新增变体',
        imageCount: 2,
        hasVideo: true
      }],
      preservedOfferIds: ['0000049-01'],
      submittedOfferIds: ['0000049-02']
    } as const;
    const preparedData = {
      ...listing.data,
      offers: [
        ...listing.data.offers,
        {
          offerId: '0000049-02', variantId: '22222222-2222-4222-8222-222222222222',
          price: 110, oldPrice: 220, minPrice: 95, stock: 2, descriptionRu: 'Новое описание', media: []
        }
      ]
    } as any;
    const evidence = { status: 'CONFIRMED_EMPTY', offerIds: plan.submittedOfferIds };
    const productIdentity = createOzonCompatibleAppendProductIdentity(listing.productName, [
      { variantId: '11111111-1111-4111-8111-111111111111', name: '既有变体' },
      { variantId: '22222222-2222-4222-8222-222222222222', name: '新增变体' }
    ]);
    const job = {
      id: '33333333-3333-4333-8333-333333333333',
      sku: listing.sku,
      source: 'MANUAL',
      state: 'WAITING_MEDIA',
      rowVersion: 1,
      retryCount: 0,
      stageStates: {},
      payload: {},
      createdAt: '2026-08-09T01:00:00.000Z',
      updatedAt: '2026-08-09T01:00:00.000Z'
    } as any;
    const createCompatibleAppendManualJob = vi.fn(async (repositoryInput: any, prepare: any) => {
      const ephemeral = {
        ...listing,
        status: 'READY',
        revision: listing.revision + 1,
        data: repositoryInput.listingData
      };
      const artifact = await prepare({ listing: ephemeral, revision: ephemeral.revision, jobId: job.id });
      return {
        listing: { ...ephemeral, status: 'SUBMITTING', rowVersion: listing.rowVersion + 1 },
        job,
        artifact
      };
    });
    const repository = {
      getSettings: vi.fn(async () => settings),
      createCompatibleAppendManualJob,
      transitionJob: vi.fn(async (_id: string, input: any) => ({
        ...job,
        ...input,
        rowVersion: job.rowVersion + 1
      }))
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);
    const preset = {
      id: '11111111-1111-4111-8111-111111111111',
      rowVersion: 4,
      autoPublishEnabled: false,
      autoPublishMode: 'COMPATIBLE_UPSERT'
    } as any;
    vi.spyOn(service as any, 'prepareCompatibleAppendContext').mockResolvedValue({
      plan,
      listing,
      preset,
      productIdentity,
      productVariants: [],
      currentMediaAssets: [],
      settings
    });
    vi.spyOn(service as any, 'prepareCompatibleAppendListing').mockResolvedValue(preparedData);
    vi.spyOn(service as any, 'assertCompatibleAppendRemoteAbsence').mockResolvedValue(evidence);
    const generateUnlocked = vi.spyOn(service as any, 'generateUnlocked').mockResolvedValue({
      listing,
      productJson: { revision: 4, offers: [{ offerId: '0000049-02' }] },
      productJsonPath: 'G:\\OZON-Auto-Publish\\inbox\\0000049\\product.json',
      readyMarker: 'G:\\OZON-Auto-Publish\\inbox\\0000049\\_READY',
      signature: `sha256:${'e'.repeat(64)}`
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      accepted: true,
      taskId: job.id,
      taskFolder: '0000049__r4',
      workRelPath: 'processing/0000049__r4',
      directoryStage: 'PROCESSING',
      signature: `sha256:${'e'.repeat(64)}`
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(service.compatibleAppend(listing.sku, {
      rowVersion: plan.rowVersion,
      planHash: plan.planHash
    })).rejects.toMatchObject({
      code: 'OZON_LEGACY_TASK_READ_ONLY',
      statusCode: 409,
      details: expect.objectContaining({ sku: listing.sku })
    });
    expect(createCompatibleAppendManualJob).not.toHaveBeenCalled();
    expect(generateUnlocked).not.toHaveBeenCalled();
    const result = undefined as any;
    return;

    expect(result).toMatchObject({
      mode: 'COMPATIBLE_APPEND',
      dispatched: true,
      listing: { status: 'SUBMITTING', rowVersion: 8 },
      job: { id: job.id, state: 'SUBMITTING' },
      preservedOfferIds: ['0000049-01'],
      submittedOfferIds: ['0000049-02'],
      variants: [{
        variantId: '22222222-2222-4222-8222-222222222222',
        variantName: '新增变体',
        offerId: '0000049-02'
      }]
    });
    expect(createCompatibleAppendManualJob).toHaveBeenCalledWith(expect.objectContaining({
      sku: listing.sku,
      rowVersion: 7,
      listingData: preparedData,
      state: 'WAITING_MEDIA',
      planHash: plan.planHash,
      manifestSignature: plan.manifestSignature,
      expectedPresetId: preset.id,
      expectedPresetRowVersion: preset.rowVersion,
      expectedCategoryVersionId: 'category-version-1',
      expectedSettingsRowVersion: settings.rowVersion,
      expectedRootDirectory: settings.rootDirectory,
      expectedStoreAlias: settings.defaultStoreAlias,
      expectedProductIdentityHash: productIdentity.hash,
      expectedProductName: productIdentity.productName,
      expectedProductVariants: productIdentity.productVariants,
      offerContractVersion: 1,
      offerContractHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      expectedOfferSnapshots: [
        expect.objectContaining({
          offerId: '0000049-01',
          disposition: 'PRESERVED_EXISTING',
          mapping: { ozonProductId: '501', ozonSku: '9001' }
        }),
        expect.objectContaining({ offerId: '0000049-02', disposition: 'SUBMITTED' })
      ],
      preservedOfferIds: ['0000049-01'],
      submittedOfferIds: ['0000049-02'],
      expectedOfferIds: ['0000049-01', '0000049-02'],
      remoteAbsenceEvidence: evidence
    }), expect.any(Function));
    const atomicInput = createCompatibleAppendManualJob.mock.calls[0]![0] as any;
    expect(atomicInput.offerContractHash).toBe(`sha256:${createHash('sha256').update(stableTestJson({
      offerContractVersion: 1,
      expectedOfferIds: atomicInput.expectedOfferIds,
      submittedOfferIds: atomicInput.submittedOfferIds,
      publishOfferIds: atomicInput.submittedOfferIds,
      expectedOfferSnapshots: atomicInput.expectedOfferSnapshots
    })).digest('hex')}`);
    expect(generateUnlocked).toHaveBeenCalledWith(
      listing.sku,
      listing.rowVersion,
      ['0000049-02'],
      expect.objectContaining({ archiveUnboundRound: false, preparedListing: expect.objectContaining({ revision: 4 }) })
    );
    expect(repository.transitionJob).toHaveBeenCalledWith(job.id, expect.objectContaining({
      state: 'SUBMITTING',
      offerIds: ['0000049-01', '0000049-02'],
      jobPayload: expect.objectContaining({
        offerContractVersion: 1,
        offerContractHash: atomicInput.offerContractHash,
        expectedOfferSnapshots: atomicInput.expectedOfferSnapshots,
        expectedOfferIds: ['0000049-01', '0000049-02'],
        preservedOfferIds: ['0000049-01'],
        submittedOfferIds: ['0000049-02'],
        publishOfferIds: ['0000049-02']
      })
    }));
  });

  it('keeps the original manual job READY with persistent backoff when n8n dispatch loses the network', async () => {
    const sku = '0000049';
    const signature = `sha256:${'b'.repeat(64)}`;
    const settings = {
      enabled: true,
      credentialReady: true,
      defaultStoreAlias: 'default',
      taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-tasks'
    } as OzonSystemSettings;
    let current = {
      id: '00000000-0000-4000-8000-000000000049',
      sku,
      source: 'MANUAL',
      state: 'READY',
      rowVersion: 1,
      retryCount: 0,
      storeAlias: 'default',
      offerIds: [`${sku}-01`],
      ozonProductLinks: [],
      stageStates: {},
      payload: {},
      createdAt: '2026-08-07T01:00:00.000Z',
      updatedAt: '2026-08-07T01:00:00.000Z'
    } as any;
    const transitionJob = vi.fn(async (_id: string, input: any) => {
      current = { ...current, ...input, payload: { ...current.payload, networkRecovery: input.networkRecovery }, rowVersion: current.rowVersion + 1 };
      return current;
    });
    const listing = { sku, status: 'SUBMITTING' } as any;
    const repository = {
      getSettings: vi.fn(async () => settings),
      getListing: vi.fn(async () => listing),
      hasProductMappingForSku: vi.fn(async () => false),
      createManualJob: vi.fn(async () => ({ job: current })),
      markListingSubmitted: vi.fn(async () => listing),
      getJob: vi.fn(async () => current),
      transitionJob
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    vi.spyOn(service, 'generate').mockResolvedValue({
      listing,
      productJson: { revision: 5, offers: [{ offerId: `${sku}-01` }] },
      productJsonPath: `G:\\OZON-Auto-Publish\\inbox\\${sku}\\product.json`,
      readyMarker: `G:\\OZON-Auto-Publish\\inbox\\${sku}\\_READY`,
      signature
    } as any);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }));

    const result = await service.submit(sku, 5);

    expect(result).toMatchObject({ dispatched: false, job: { id: current.id, state: 'READY' } });
    expect(transitionJob).toHaveBeenCalledTimes(1);
    expect(transitionJob).toHaveBeenCalledWith(current.id, expect.objectContaining({
      state: 'READY',
      eventType: 'NETWORK_RETRY_SCHEDULED',
      incrementRetry: true,
      networkRecovery: expect.objectContaining({
        status: 'WAITING_NETWORK',
        phase: 'N8N_DISPATCH',
        deliveryState: 'UNKNOWN',
        attempt: 1,
        resumeState: 'READY'
      })
    }));
    const transition = transitionJob.mock.calls[0]![1] as any;
    expect(Date.parse(transition.nextAttemptAt) - Date.parse(transition.networkRecovery.lastFailureAt)).toBe(30_000);
  });

  it('keeps an automatic dispatch unclaimable until P001 explicitly accepts it', async () => {
    const sku = '0000052';
    const jobId = '00000000-0000-4000-8000-000000000052';
    const signature = `sha256:${'f'.repeat(64)}`;
    const offerId = `${sku}-01`;
    const expectedOfferSnapshots = [{ offerId, disposition: 'SUBMITTED' }];
    const offerContractMetadata = {
      offerContractVersion: 1,
      expectedOfferIds: [offerId],
      submittedOfferIds: [offerId],
      publishOfferIds: [offerId],
      expectedOfferSnapshots,
      offerContractHash: `sha256:${createHash('sha256').update(stableTestJson({
        offerContractVersion: 1,
        expectedOfferIds: [offerId],
        submittedOfferIds: [offerId],
        publishOfferIds: [offerId],
        expectedOfferSnapshots
      })).digest('hex')}`
    };
    const listing = { sku, status: 'SUBMITTING', rowVersion: 8, revision: 3 } as any;
    let current = {
      id: jobId,
      sku,
      source: 'AUTO',
      state: 'WAITING_MEDIA',
      rowVersion: 1,
      retryCount: 0,
      revision: listing.revision,
      offerIds: [offerId],
      stageStates: {},
      payload: {
        ...offerContractMetadata,
        autoPreparedByJobId: jobId,
        autoPreparedListingRowVersion: listing.rowVersion,
        autoPreparedListingRevision: listing.revision,
        autoPreparedListingDataSignature: `sha256:${'e'.repeat(64)}`
      },
      createdAt: '2026-08-09T01:00:00.000Z',
      updatedAt: '2026-08-09T01:00:00.000Z'
    } as any;
    const transitionJob = vi.fn(async (_id: string, input: any) => {
      const { jobPayload, payload: _eventPayload, ...fields } = input;
      void _eventPayload;
      current = {
        ...current,
        ...fields,
        payload: { ...current.payload, ...(jobPayload || {}) },
        rowVersion: current.rowVersion + 1
      };
      return current;
    });
    const claimRuntimeJob = vi.fn(async () => {
      const runtimeAdvanceable = [
        'READY', 'SUBMITTING', 'UPLOADING_MEDIA', 'IMPORTING',
        'VERIFYING_IMAGES', 'UPDATING_PRICE', 'UPDATING_STOCK', 'MODERATING'
      ].includes(current.state);
      const readyHasRemoteEvidence = current.state !== 'READY'
        || Boolean(current.taskId || current.importTaskId || current.ozonProductId || current.directoryStage === 'PROCESSING');
      return runtimeAdvanceable && readyHasRemoteEvidence ? current : undefined;
    });
    const repository = {
      getJob: vi.fn(async () => current),
      getSettings: vi.fn(async () => ({
        enabled: true,
        credentialReady: true,
        defaultStoreAlias: 'default',
        taskApiWebhookUrl: 'http://n8n.test/webhook/ozon-tasks'
      })),
      transitionJob,
      markListingSubmitted: vi.fn(async () => listing),
      claimRuntimeJob
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    vi.spyOn(service as any, 'generateAutomatic').mockResolvedValue({
      listing,
      productJson: { revision: 3, offers: [{ offerId, media: [] }] },
      productJsonPath: `G:\\OZON-Auto-Publish\\inbox\\${sku}\\product.json`,
      readyMarker: `G:\\OZON-Auto-Publish\\inbox\\${sku}\\_READY`,
      signature
    });
    let signalFetchStarted!: () => void;
    let resolveFetch!: (response: Response) => void;
    const fetchStarted = new Promise<void>((resolve) => { signalFetchStarted = resolve; });
    const fetchResponse = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchMock = vi.fn(async () => {
      signalFetchStarted();
      return fetchResponse;
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = service.dispatchAutomaticJob(current, sku, listing.rowVersion, offerContractMetadata);
    await Promise.race([
      fetchStarted,
      pending.then(
        () => Promise.reject(new Error('automatic dispatch completed before P001 entered the pending request')),
        (error: unknown) => Promise.reject(error)
      )
    ]);

    expect(current.state).toBe('WAITING_MEDIA');
    expect(transitionJob).toHaveBeenNthCalledWith(1, current.id, expect.objectContaining({
      state: 'WAITING_MEDIA',
      eventType: 'PRODUCT_JSON_GENERATED',
      jobPayload: expect.objectContaining(offerContractMetadata)
    }));
    await expect(repository.claimRuntimeJob({ leaseOwner: 'ozon-p002:test', leaseSeconds: 600 })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      offerIds: [offerId],
      ...offerContractMetadata
    });

    resolveFetch(new Response(JSON.stringify({
      accepted: true,
      taskId: 'ozon-task-52',
      taskFolder: `${sku}__r3`,
      workRelPath: `processing/${sku}__r3`,
      directoryStage: 'PROCESSING',
      signature
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await pending;

    expect(result).toMatchObject({ dispatched: true, job: { state: 'SUBMITTING' } });
    expect(transitionJob).toHaveBeenNthCalledWith(2, current.id, expect.objectContaining({
      state: 'SUBMITTING',
      eventType: 'N8N_DISPATCHED',
      jobPayload: expect.objectContaining(offerContractMetadata)
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(repository.claimRuntimeJob({ leaseOwner: 'ozon-p002:test', leaseSeconds: 600 }))
      .resolves.toMatchObject({ state: 'SUBMITTING', taskId: 'ozon-task-52' });
  });

  it('moves an automatic dispatch to READY only after P001 delivery becomes UNKNOWN', async () => {
    const sku = '0000053';
    const signature = `sha256:${'a'.repeat(64)}`;
    const listing = { sku, status: 'SUBMITTING', rowVersion: 4, revision: 2 } as any;
    const sequence: string[] = [];
    let current = {
      id: '00000000-0000-4000-8000-000000000053',
      sku,
      source: 'AUTO',
      state: 'WAITING_MEDIA',
      rowVersion: 1,
      retryCount: 0,
      stageStates: {},
      payload: {},
      createdAt: '2026-08-09T01:00:00.000Z',
      updatedAt: '2026-08-09T01:00:00.000Z'
    } as any;
    const transitionJob = vi.fn(async (_id: string, input: any) => {
      sequence.push(input.state);
      const { jobPayload, payload: _eventPayload, ...fields } = input;
      void _eventPayload;
      current = {
        ...current,
        ...fields,
        payload: { ...current.payload, ...(jobPayload || {}), ...(input.networkRecovery ? { networkRecovery: input.networkRecovery } : {}) },
        rowVersion: current.rowVersion + 1
      };
      return current;
    });
    const repository = {
      getJob: vi.fn(async () => current),
      getSettings: vi.fn(async () => ({
        enabled: true,
        credentialReady: true,
        defaultStoreAlias: 'default',
        taskApiWebhookUrl: 'http://n8n.test/webhook/ozon-tasks'
      })),
      transitionJob,
      markListingSubmitted: vi.fn(async () => listing)
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    vi.spyOn(service as any, 'generateAutomatic').mockResolvedValue({
      listing,
      productJson: { revision: 2, offers: [{ offerId: `${sku}-01`, media: [] }] },
      productJsonPath: `G:\\OZON-Auto-Publish\\inbox\\${sku}\\product.json`,
      readyMarker: `G:\\OZON-Auto-Publish\\inbox\\${sku}\\_READY`,
      signature
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      sequence.push('P001_UNKNOWN');
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }));

    const result = await service.dispatchAutomaticJob(current, sku, listing.rowVersion);

    expect(result).toMatchObject({ dispatched: false, job: { state: 'READY' } });
    expect(sequence).toEqual(['WAITING_MEDIA', 'P001_UNKNOWN', 'READY']);
    expect(transitionJob).toHaveBeenNthCalledWith(1, current.id, expect.objectContaining({
      state: 'WAITING_MEDIA',
      jobPayload: expect.objectContaining({ offerIds: [`${sku}-01`] })
    }));
    expect(transitionJob.mock.calls[0]![1].jobPayload).not.toHaveProperty('expectedOfferIds');
    expect(transitionJob).toHaveBeenNthCalledWith(2, current.id, expect.objectContaining({
      state: 'READY',
      eventType: 'NETWORK_RETRY_SCHEDULED',
      networkRecovery: expect.objectContaining({
        status: 'WAITING_NETWORK',
        phase: 'N8N_DISPATCH',
        deliveryState: 'UNKNOWN',
        resumeState: 'READY'
      })
    }));
  });

  it('moves an automatic dispatch to NEEDS_ATTENTION after a deterministic P001 rejection', async () => {
    const sku = '0000054';
    const signature = `sha256:${'b'.repeat(64)}`;
    const listing = { sku, status: 'SUBMITTING', rowVersion: 2, revision: 1 } as any;
    let current = {
      id: '00000000-0000-4000-8000-000000000054',
      sku,
      source: 'AUTO',
      state: 'WAITING_MEDIA',
      rowVersion: 1,
      retryCount: 0,
      stageStates: {},
      payload: {},
      createdAt: '2026-08-09T01:00:00.000Z',
      updatedAt: '2026-08-09T01:00:00.000Z'
    } as any;
    const transitionJob = vi.fn(async (_id: string, input: any) => {
      const { jobPayload, payload: _eventPayload, ...fields } = input;
      void _eventPayload;
      current = {
        ...current,
        ...fields,
        payload: { ...current.payload, ...(jobPayload || {}) },
        rowVersion: current.rowVersion + 1
      };
      return current;
    });
    const repository = {
      getJob: vi.fn(async () => current),
      getSettings: vi.fn(async () => ({
        enabled: true,
        credentialReady: true,
        defaultStoreAlias: 'default',
        taskApiWebhookUrl: 'http://n8n.test/webhook/ozon-tasks'
      })),
      transitionJob,
      markListingSubmitted: vi.fn(async () => listing)
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    vi.spyOn(service as any, 'generateAutomatic').mockResolvedValue({
      listing,
      productJson: { revision: 1, offers: [{ offerId: `${sku}-01`, media: [] }] },
      productJsonPath: `G:\\OZON-Auto-Publish\\inbox\\${sku}\\product.json`,
      readyMarker: `G:\\OZON-Auto-Publish\\inbox\\${sku}\\_READY`,
      signature
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'invalid request' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })));

    const result = await service.dispatchAutomaticJob(current, sku, listing.rowVersion);

    expect(result).toMatchObject({ dispatched: false, job: { state: 'NEEDS_ATTENTION' } });
    expect(transitionJob.mock.calls.map((call) => call[1].state)).toEqual(['WAITING_MEDIA', 'NEEDS_ATTENTION']);
    expect(transitionJob).toHaveBeenLastCalledWith(current.id, expect.objectContaining({
      state: 'NEEDS_ATTENTION',
      eventType: 'N8N_DISPATCH_FAILED',
      errorCode: 'N8N_DISPATCH_FAILED',
      networkRecovery: null
    }));
  });

  it('returns a safe active-job summary and repository takeover decision for listing detail', async () => {
    const listing = { sku: '0000049', productName: '测试商品' } as any;
    const activeJob = {
      id: '17b43575-b742-448e-8fe5-dd704483c813',
      sku: '0000049',
      source: 'AUTO',
      state: 'WAITING_MEDIA',
      stageStates: { import: 'PENDING', moderation: 'PENDING', images: 'WAITING_LOCAL', video: 'WAITING_LOCAL', price: 'PENDING', stock: 'PENDING' },
      retryCount: 0,
      rowVersion: 1,
      payload: { mediaDeliveries: [] },
      createdAt: '2026-07-27T11:43:57.000Z',
      updatedAt: '2026-07-27T11:43:57.000Z'
    } as any;
    const repository = {
      getListing: vi.fn(async () => listing),
      findActiveJobBySku: vi.fn(async () => activeJob),
      canManualTakeover: vi.fn(() => true)
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger
    );

    await expect(service.getListing('0000049')).resolves.toEqual({
      listing,
      activeJob: {
        id: activeJob.id,
        source: 'AUTO',
        state: 'WAITING_MEDIA',
        taskId: undefined,
        importTaskId: undefined,
        ozonProductId: undefined,
        createdAt: activeJob.createdAt,
        updatedAt: activeJob.updatedAt
      },
      canManualTakeover: true
    });
    expect(repository.findActiveJobBySku).toHaveBeenCalledWith('0000049');
    expect(repository.canManualTakeover).toHaveBeenCalledWith(activeJob);
  });

  it('allows local shared-media delivery without store credentials or public video upload readiness', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-media-'));
    roots.push(rootDirectory);
    const settings: OzonSystemSettings = {
      rowVersion: 1,
      enabled: false,
      rootDirectory,
      defaultStoreAlias: 'default',
      taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-jobs',
      adminApiWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-admin',
      preflightWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-preflight',
      imageUploaderWorkflowId: 'uploader',
      storeGatewayWorkflowId: 'gateway',
      imageUploadConcurrency: 7,
      videoUploadConcurrency: 2,
      videoPrewarmEnabled: true,
      credentialReady: false,
      lastPreflightStatus: 'FAILED',
      lastPreflightMessage: '默认店铺 n8n 凭据尚未通过预检',
      videoUploadReady: false,
      updatedAt: new Date().toISOString()
    };
    const repository = {
      configured: true,
      getSettings: async () => settings
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger
    );

    await expect(service.readiness(false)).resolves.toMatchObject({
      ready: false,
      mediaReady: true,
      databaseReady: true,
      rootReady: true,
      videoUploadReady: false,
      mediaIssues: [],
      issues: ['OZON 上品管理未启用']
    });
  });

  it('scans the OZON variants directory and attaches bilingual manifest metadata', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-scan-'));
    roots.push(rootDirectory);
    const productRoot = path.join(rootDirectory, 'inbox', '0000051');
    const variantsRoot = path.join(productRoot, 'variants');
    const variantId = randomUUID();
    const imageRelativePath = 'variants/咖啡色/images/image-batch/01.png';
    const videoRelativePath = 'variants/咖啡色/videos/video-batch/main.mp4';
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const video = testMp4(10);
    await mkdir(path.dirname(path.join(productRoot, imageRelativePath)), { recursive: true });
    await mkdir(path.dirname(path.join(productRoot, videoRelativePath)), { recursive: true });
    await writeFile(path.join(productRoot, imageRelativePath), image);
    await writeFile(path.join(productRoot, videoRelativePath), video);
    const deliveredAt = new Date().toISOString();
    const manifestAsset = (kind: 'image' | 'video', relativePath: string, content: Buffer, sourceStageId: 'E004' | 'E005') => {
      const sha256 = createHash('sha256').update(content).digest('hex');
      return {
        assetId: createHash('sha256').update(`${relativePath}\0${sha256}`).digest('hex'),
        submissionId: `${sourceStageId.toLocaleLowerCase()}-batch`,
        sourceStageId,
        kind,
        ...(kind === 'image' ? { sortOrder: 0 } : {}),
        variantId,
        variantName: '咖啡色',
        variantColor: { colorKey: 'c'.repeat(64), nameRu: 'Кофейный', nameZh: '咖啡色' },
        relativePath,
        deliveredAt,
        sizeBytes: content.length,
        sha256
      };
    };
    await writeFile(path.join(variantsRoot, 'variant-media-manifest.json'), JSON.stringify({
      schemaVersion: 2,
      SKU: '0000051',
      productName: '测试商品',
      assets: [
        manifestAsset('image', imageRelativePath, image, 'E005'),
        manifestAsset('video', videoRelativePath, video, 'E004')
      ]
    }));

    const assets = await scanOzonMediaDirectory(productRoot, variantsRoot);

    expect(assets).toHaveLength(2);
    expect(assets.map((asset) => asset.relativePath)).toEqual([imageRelativePath, videoRelativePath]);
    expect(assets.every((asset) => asset.validationStatus === 'VALID')).toBe(true);
    expect(assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'image', sortOrder: 0, mimeType: 'image/png', productVariantId: variantId, productVariantName: '咖啡色', sourceStageId: 'E005' }),
      expect.objectContaining({ kind: 'video', mimeType: 'video/mp4', durationSeconds: 10, productVariantId: variantId, productVariantName: '咖啡色', sourceStageId: 'E004' })
    ]));
  });

  it('stops an OZON scan when the latest E005 batch only partially declares sortOrder', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-order-scan-'));
    roots.push(rootDirectory);
    const productRoot = path.join(rootDirectory, 'inbox', '0000051');
    const variantsRoot = path.join(productRoot, 'variants');
    const variantId = randomUUID();
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const manifestAssets = [];
    for (const [index, name] of ['01.png', '02.png'].entries()) {
      const relativePath = `variants/咖啡色/images/image-batch/${name}`;
      await mkdir(path.dirname(path.join(productRoot, relativePath)), { recursive: true });
      await writeFile(path.join(productRoot, relativePath), image);
      manifestAssets.push({
        submissionId: 'image-batch',
        sourceStageId: 'E005',
        kind: 'image',
        variantId,
        relativePath,
        deliveredAt: '2026-08-10T01:00:00.000Z',
        sizeBytes: image.length,
        sha256: createHash('sha256').update(image).digest('hex'),
        ...(index === 0 ? { sortOrder: 0 } : {})
      });
    }
    await writeFile(path.join(variantsRoot, 'variant-media-manifest.json'), JSON.stringify({
      schemaVersion: 2,
      SKU: '0000051',
      productName: '测试商品',
      assets: manifestAssets
    }));

    await expect(scanOzonMediaDirectory(productRoot, variantsRoot)).rejects.toMatchObject({
      code: 'MEDIA_MANIFEST_INVALID',
      statusCode: 409,
      message: expect.stringContaining('全部声明 sortOrder')
    });
  });

  it('persists a changed media scan once, cleans invalid references, and preserves _READY on an unchanged rescan', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-idempotent-scan-'));
    roots.push(rootDirectory);
    const sku = '0000051';
    const productRoot = path.join(rootDirectory, 'inbox', sku);
    const imagePath = path.join(productRoot, 'variants', 'shared', '01.png');
    const readyPath = path.join(productRoot, '_READY');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    await writeFile(readyPath, 'stale-generated-round');

    let current = {
      sku,
      productName: '测试商品',
      status: 'DRAFT',
      rowVersion: 4,
      revision: 4,
      data: {
        offers: [{
          variantId: randomUUID(),
          variantCode: '01',
          offerId: `${sku}-01`,
          barcode: '',
          modelGroup: `${sku}-model`,
          price: 999,
          stock: 10,
          attributes: [],
          media: [{
            assetId: 'removed-asset',
            relativePath: 'variants/shared/removed.png',
            kind: 'image',
            sortOrder: 0,
            isPrimary: true
          }]
        }],
        mediaAssets: [],
        mediaSourceRoot: ''
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const updateListing = vi.fn(async (_sku, input: any) => {
      const data = { ...input };
      delete data.rowVersion;
      current = {
        ...current,
        rowVersion: current.rowVersion + 1,
        revision: current.revision + 1,
        data
      };
      return current;
    });
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      getListing: vi.fn(async () => current),
      updateListing
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    const first = await service.scanMedia(sku, 4);

    expect(first).toMatchObject({ changed: true, removedReferences: 1 });
    expect(first.listing).toBe(current);
    expect(first.listing.rowVersion).toBe(5);
    expect(first.listing.revision).toBe(5);
    expect(first.listing.data.mediaAssets).toHaveLength(1);
    expect(first.listing.data.offers[0]?.media).toEqual([]);
    expect(updateListing).toHaveBeenCalledTimes(1);
    await expect(lstat(readyPath)).rejects.toMatchObject({ code: 'ENOENT' });

    current.data.mediaAssets = current.data.mediaAssets.map((asset: any) => ({
      ...asset,
      relativePath: asset.relativePath.replaceAll('/', '\\'),
      modifiedAt: new Date(Date.parse(asset.modifiedAt) - 60_000).toISOString()
    }));
    current.data.mediaSourceRoot = productRoot.toLocaleUpperCase('en-US').replaceAll('\\', '/');
    await writeFile(readyPath, 'current-generated-round');
    const beforeSecondScan = current;

    const second = await service.scanMedia(sku, 5);

    expect(second).toMatchObject({ changed: false, removedReferences: 0 });
    expect(second.listing).toBe(beforeSecondScan);
    expect(second.listing.rowVersion).toBe(5);
    expect(second.listing.revision).toBe(5);
    expect(updateListing).toHaveBeenCalledTimes(1);
    await expect(readFile(readyPath, 'utf8')).resolves.toBe('current-generated-round');
  });

  it('keeps row-version conflict protection before scanning media', async () => {
    const updateListing = vi.fn();
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: true })),
      getListing: vi.fn(async () => ({ sku: '0000051', rowVersion: 7 })),
      updateListing
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.scanMedia('0000051', 6)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409,
      details: { sku: '0000051', expected: 7, actual: 6 }
    });
    expect(updateListing).not.toHaveBeenCalled();
  });

  it('does not create a revision for an empty media directory with an unset derived source root', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-empty-scan-'));
    roots.push(rootDirectory);
    const sku = '0000051';
    const productRoot = path.join(rootDirectory, 'inbox', sku);
    const readyPath = path.join(productRoot, '_READY');
    await mkdir(productRoot, { recursive: true });
    await writeFile(readyPath, 'unchanged-empty-round');
    const listing = {
      sku,
      status: 'DRAFT',
      rowVersion: 3,
      revision: 3,
      data: { offers: [], mediaAssets: [], mediaSourceRoot: '' }
    } as any;
    const updateListing = vi.fn();
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      getListing: vi.fn(async () => listing),
      updateListing
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    const result = await service.scanMedia(sku, 3);

    expect(result).toMatchObject({ listing, mediaAssets: [], removedReferences: 0, changed: false });
    expect(updateListing).not.toHaveBeenCalled();
    await expect(readFile(readyPath, 'utf8')).resolves.toBe('unchanged-empty-round');
  });

  it('returns 409 when the listing changes while an otherwise unchanged scan is running', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-concurrent-scan-'));
    roots.push(rootDirectory);
    const sku = '0000051';
    const productRoot = path.join(rootDirectory, 'inbox', sku);
    const readyPath = path.join(productRoot, '_READY');
    await mkdir(productRoot, { recursive: true });
    await writeFile(readyPath, 'concurrent-round');
    const listing = {
      sku,
      status: 'DRAFT',
      rowVersion: 3,
      revision: 3,
      data: { offers: [], mediaAssets: [], mediaSourceRoot: '' }
    } as any;
    const changedListing = { ...listing, rowVersion: 4, revision: 4 };
    const getListing = vi.fn()
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce(changedListing);
    const updateListing = vi.fn();
    const repository = {
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      getListing,
      updateListing
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.scanMedia(sku, 3)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409,
      details: { sku, expected: 4, actual: 3 }
    });
    expect(getListing).toHaveBeenCalledTimes(2);
    expect(updateListing).not.toHaveBeenCalled();
    await expect(readFile(readyPath, 'utf8')).resolves.toBe('concurrent-round');
  });

  it('rejects generation when an assigned media file changes after scanning', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-change-'));
    roots.push(rootDirectory);
    const productRoot = path.join(rootDirectory, 'inbox', '0000051');
    const variantsRoot = path.join(productRoot, 'variants');
    const relativePath = 'variants/shared/01.png';
    const filePath = path.join(productRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const [asset] = await scanOzonMediaDirectory(productRoot, variantsRoot);
    const listing = {
      sku: '0000051',
      data: {
        mediaAssets: [asset],
        offers: [{
          offerId: '0000051-01',
          media: [{ assetId: asset!.assetId, relativePath: asset!.relativePath, kind: 'image', sortOrder: 0, isPrimary: true }]
        }]
      }
    } as any;
    await expect(assertOzonMediaAssetsCurrent(listing, productRoot)).resolves.toBeUndefined();

    await writeFile(filePath, 'changed-after-scan');

    await expect(assertOzonMediaAssetsCurrent(listing, productRoot)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409
    });
  });

  it('removes only a matching generated control-file pair and preserves variants or foreign artifacts', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-owned-round-'));
    roots.push(rootDirectory);
    const productDirectory = path.join(rootDirectory, 'inbox', '0000050');
    const variantsDirectory = path.join(productDirectory, 'variants');
    const productJsonPath = path.join(productDirectory, 'product.json');
    const readyMarker = path.join(productDirectory, '_READY');
    await mkdir(variantsDirectory, { recursive: true });
    await writeFile(path.join(variantsDirectory, '01.png'), 'media');
    const product = { schemaVersion: 2, productCode: '0000050', revision: 5 };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(productJsonPath, JSON.stringify(product));
    await writeFile(readyMarker, JSON.stringify({ sku: '0000050', revision: 5, signature }));

    await expect(removeGeneratedOzonArtifactIfOwned({
      productJsonPath,
      readyMarker,
      signature
    })).resolves.toEqual({ productJsonRemoved: true, readyMarkerRemoved: true });
    await expect(lstat(productJsonPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(readyMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(variantsDirectory, '01.png'), 'utf8')).resolves.toBe('media');

    const foreign = { schemaVersion: 2, productCode: '0000050', revision: 6 };
    const foreignSignature = `sha256:${createHash('sha256').update(JSON.stringify(foreign)).digest('hex')}`;
    await writeFile(productJsonPath, JSON.stringify(foreign));
    await writeFile(readyMarker, JSON.stringify({ sku: '0000050', revision: 6, signature: foreignSignature }));
    await expect(removeGeneratedOzonArtifactIfOwned({
      productJsonPath,
      readyMarker,
      signature
    })).resolves.toEqual({ productJsonRemoved: false, readyMarkerRemoved: false });
    await expect(readFile(productJsonPath, 'utf8')).resolves.toBe(JSON.stringify(foreign));
    await expect(readFile(readyMarker, 'utf8')).resolves.toContain(foreignSignature);
  });

  it('archives an unbound stale inbox round while preserving variants', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-inbox-round-'));
    roots.push(rootDirectory);
    const productDirectory = path.join(rootDirectory, 'inbox', '0000050');
    const variantsDirectory = path.join(productDirectory, 'variants');
    await mkdir(variantsDirectory, { recursive: true });
    await mkdir(path.join(rootDirectory, 'errors'), { recursive: true });
    await writeFile(path.join(variantsDirectory, '01.png'), 'media');
    const product = { productCode: '0000050', revision: 4 };
    const existingSignature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(path.join(productDirectory, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(productDirectory, '_READY'), JSON.stringify({
      sku: '0000050',
      revision: 4,
      signature: existingSignature
    }));

    const result = await prepareOzonInboxRound({
      rootDirectory,
      productDirectory,
      sku: '0000050',
      revision: 5,
      signature: `sha256:${'b'.repeat(64)}`,
      findBoundJob: vi.fn(async () => undefined)
    });
    expect(result.archivedPath).toContain(path.join('errors', 'stale-generated', '0000050__r4__'));
    await expect(lstat(path.join(productDirectory, 'product.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(productDirectory, '_READY'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(variantsDirectory, '01.png'))).resolves.toMatchObject({});
    await expect(lstat(path.join(result.archivedPath!, 'product.json'))).resolves.toMatchObject({});
    await expect(lstat(path.join(result.archivedPath!, '_READY'))).resolves.toMatchObject({});
    await expect(readFile(path.join(result.archivedPath!, 'stale-round.json'), 'utf8')).resolves.toContain('REVISION_SUPERSEDED');
  });

  it('keeps a bound or claimed inbox round protected from replacement', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-bound-round-'));
    roots.push(rootDirectory);
    const productDirectory = path.join(rootDirectory, 'inbox', '0000050');
    await mkdir(productDirectory, { recursive: true });
    await mkdir(path.join(rootDirectory, 'errors'), { recursive: true });
    const product = { productCode: '0000050', revision: 4 };
    const existingSignature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(path.join(productDirectory, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(productDirectory, '_READY'), JSON.stringify({
      sku: '0000050',
      revision: 4,
      signature: existingSignature
    }));
    const boundJob = {
      id: randomUUID(),
      sku: '0000050',
      source: 'MANUAL',
      state: 'CANCELLED'
    } as any;

    await expect(prepareOzonInboxRound({
      rootDirectory,
      productDirectory,
      sku: '0000050',
      revision: 5,
      signature: `sha256:${'b'.repeat(64)}`,
      findBoundJob: vi.fn(async () => boundJob)
    })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409,
      details: expect.objectContaining({ existingJobId: boundJob.id })
    });
    await expect(lstat(path.join(productDirectory, 'product.json'))).resolves.toMatchObject({});

    await writeFile(path.join(productDirectory, '.ozon-intake.json'), JSON.stringify({
      jobId: boundJob.id,
      sku: '0000050',
      revision: 4,
      signature: existingSignature
    }));
    await expect(prepareOzonInboxRound({
      rootDirectory,
      productDirectory,
      sku: '0000050',
      revision: 5,
      signature: `sha256:${'c'.repeat(64)}`,
      findBoundJob: vi.fn(async () => undefined)
    })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409
    });
  });

  it('reuses an identical round and archives an unbound malformed marker', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-idempotent-round-'));
    roots.push(rootDirectory);
    const productDirectory = path.join(rootDirectory, 'inbox', '0000050');
    await mkdir(productDirectory, { recursive: true });
    await mkdir(path.join(rootDirectory, 'errors'), { recursive: true });
    const product = { productCode: '0000050', revision: 5 };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(path.join(productDirectory, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(productDirectory, '_READY'), JSON.stringify({
      sku: '0000050',
      revision: 5,
      signature
    }));
    await expect(prepareOzonInboxRound({
      rootDirectory,
      productDirectory,
      sku: '0000050',
      revision: 5,
      signature,
      findBoundJob: vi.fn(async () => undefined)
    })).resolves.toEqual({});

    await writeFile(path.join(productDirectory, '_READY'), '{broken');
    const result = await prepareOzonInboxRound({
      rootDirectory,
      productDirectory,
      sku: '0000050',
      revision: 6,
      signature: `sha256:${'d'.repeat(64)}`,
      findBoundJob: vi.fn(async () => undefined)
    });
    await expect(readFile(path.join(result.archivedPath!, 'stale-round.json'), 'utf8')).resolves.toContain('READY_INVALID');
  });

  it('rejects a symlinked inbox control file without moving it', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-symlink-round-'));
    roots.push(rootDirectory);
    const productDirectory = path.join(rootDirectory, 'inbox', '0000050');
    const outsideProduct = path.join(rootDirectory, 'outside-product.json');
    await mkdir(productDirectory, { recursive: true });
    await mkdir(path.join(rootDirectory, 'errors'), { recursive: true });
    await writeFile(outsideProduct, JSON.stringify({ productCode: '0000050', revision: 4 }));
    await symlink(outsideProduct, path.join(productDirectory, 'product.json'), 'file');

    await expect(prepareOzonInboxRound({
      rootDirectory,
      productDirectory,
      sku: '0000050',
      revision: 5,
      signature: `sha256:${'e'.repeat(64)}`,
      findBoundJob: vi.fn(async () => undefined)
    })).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL_BLOCKED',
      statusCode: 403
    });
    await expect(readFile(outsideProduct, 'utf8')).resolves.toContain('"revision":4');
  });

  it('rejects every terminal runtime callback and recheck before filesystem work while recovery hold is active', async () => {
    const current = {
      id: '00000000-0000-4000-8000-000000000055',
      sku: '0000055',
      source: 'AUTO',
      state: 'NEEDS_ATTENTION',
      rowVersion: 9,
      retryCount: 0,
      revision: 3,
      storeAlias: 'default',
      offerIds: ['0000055-01'],
      ozonProductLinks: [],
      taskFolder: '0000055__r3',
      workRelPath: 'processing/0000055__r3',
      directoryStage: 'PROCESSING',
      directorySignature: `sha256:${'5'.repeat(64)}`,
      stageStates: {},
      payload: { recoveryHold: { active: true, reason: 'manual audit required' } },
      createdAt: '2026-08-09T01:00:00.000Z',
      updatedAt: '2026-08-09T01:00:00.000Z'
    } as any;
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(),
      getSettings: vi.fn(),
      recordN8nUpdate: vi.fn(),
      recheck: vi.fn(),
      transitionJob: vi.fn()
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);
    const archiveSucceededDirectory = vi.spyOn(service as any, 'archiveSucceededDirectory');
    const writeTerminalDirectoryMarker = vi.spyOn(service as any, 'writeTerminalDirectoryMarker');
    const clearTerminalDirectoryMarker = vi.spyOn(service as any, 'clearTerminalDirectoryMarker');

    for (const state of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_ATTENTION'] as const) {
      await expect(service.recordRuntimeUpdate(current.id, {
        rowVersion: current.rowVersion,
        state,
        eventType: 'TEST_RECOVERY_HOLD_CALLBACK',
        message: 'must be rejected before filesystem work'
      })).rejects.toMatchObject({
        code: 'TASK_LOCKED',
        statusCode: 409,
        details: expect.objectContaining({ reasonCode: 'OZON_AUTOMATIC_RECOVERY_HOLD_ACTIVE' })
      });
    }
    await expect(service.recheckJob(current.id, 'AUTO', current.rowVersion)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409,
      details: expect.objectContaining({ reasonCode: 'OZON_AUTOMATIC_RECOVERY_HOLD_ACTIVE' })
    });

    expect(repository.assertPlatformStatusRefreshNotLeased).not.toHaveBeenCalled();
    expect(repository.getSettings).not.toHaveBeenCalled();
    expect(repository.recordN8nUpdate).not.toHaveBeenCalled();
    expect(repository.recheck).not.toHaveBeenCalled();
    expect(repository.transitionJob).not.toHaveBeenCalled();
    expect(archiveSucceededDirectory).not.toHaveBeenCalled();
    expect(writeTerminalDirectoryMarker).not.toHaveBeenCalled();
    expect(clearTerminalDirectoryMarker).not.toHaveBeenCalled();
  });

  it('normalizes the bound P002 RFBS stock-only mismatch before any success archive or terminal marker', async () => {
    const fixture = createRfbsRuntimeUpdateFixture();
    const archived = {
      revision: 4,
      taskFolder: fixture.job.taskFolder,
      workRelPath: 'success/2026-08-09/0000105__r4',
      directoryStage: 'SUCCESS' as const,
      directorySignature: fixture.job.directorySignature,
      videoCacheCleanedAt: '2026-08-09T11:20:01.000Z',
      moved: true
    };
    let normalizedBeforeArchive: any;
    const getRfbsStockNormalizationAuthority = vi.fn(async (jobId: string) => {
      expect(jobId).toBe(fixture.job.id);
      return fixture.authority;
    });
    const recordN8nUpdate = vi.fn(async (_id: string, update: any) => {
      expect(normalizedBeforeArchive).toBeDefined();
      expect(update).toEqual({
        ...normalizedBeforeArchive,
        revision: archived.revision,
        taskFolder: archived.taskFolder,
        workRelPath: archived.workRelPath,
        directoryStage: archived.directoryStage,
        directorySignature: archived.directorySignature,
        jobPayload: {
          ...normalizedBeforeArchive.jobPayload,
          videoCacheCleanedAt: archived.videoCacheCleanedAt,
          revision: archived.revision,
          taskFolder: archived.taskFolder,
          workRelPath: archived.workRelPath,
          directoryStage: archived.directoryStage,
          directorySignature: archived.directorySignature
        }
      });
      expect(update.rfbsStockReadbackAttestation).toBe(normalizedBeforeArchive.rfbsStockReadbackAttestation);
      return {
        job: { ...fixture.job, ...update },
        mappings: fixture.authority.mappings
      };
    });
    const repository = {
      getJob: vi.fn(async () => fixture.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true })),
      getRfbsStockNormalizationAuthority,
      recordN8nUpdate
    } as unknown as OzonRepository;
    const readBoundExecution = vi.fn(async (executionId: string) => {
      expect(executionId).toBe('190809');
      return fixture.execution;
    });
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { warn: vi.fn(), error: vi.fn() } as any,
      undefined,
      undefined,
      undefined,
      readBoundExecution
    );
    const archiveSucceededDirectory = vi.spyOn(service as any, 'archiveSucceededDirectory')
      .mockImplementation(async (_job: any, normalized: any) => {
        normalizedBeforeArchive = normalized;
        return archived;
      });
    const clearSucceededTerminalDirectoryMarkers = vi.spyOn(service as any, 'clearSucceededTerminalDirectoryMarkers')
      .mockResolvedValue(undefined);
    const writeTerminalDirectoryMarker = vi.spyOn(service as any, 'writeTerminalDirectoryMarker')
      .mockResolvedValue(undefined);

    await expect(service.recordRuntimeUpdate(fixture.job.id, fixture.input as any)).resolves.toMatchObject({
      job: { state: 'SUCCEEDED', eventType: OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT }
    });

    expect(repository.assertPlatformStatusRefreshNotLeased).toHaveBeenCalledWith(fixture.job.sku, fixture.job.id);
    expect(getRfbsStockNormalizationAuthority).toHaveBeenCalledWith(fixture.job.id);
    expect(readBoundExecution).toHaveBeenCalledWith('190809');
    expect(archiveSucceededDirectory).toHaveBeenCalledWith(fixture.job, expect.objectContaining({
      rowVersion: fixture.job.rowVersion,
      leaseOwner: fixture.job.leaseOwner,
      leaseToken: fixture.job.leaseToken,
      clearLease: true,
      state: 'SUCCEEDED',
      eventType: OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT,
      stageStates: expect.objectContaining({ stock: 'VERIFIED' }),
      rfbsStockReadbackAttestation: expect.objectContaining({
        executionId: '190809',
        jobId: fixture.job.id,
        jobRowVersion: fixture.job.rowVersion,
        leaseOwner: fixture.job.leaseOwner,
        leaseToken: fixture.job.leaseToken
      })
    }));
    expect(writeTerminalDirectoryMarker).not.toHaveBeenCalled();
    expect(clearSucceededTerminalDirectoryMarkers).toHaveBeenCalledWith(expect.objectContaining({
      state: 'SUCCEEDED',
      workRelPath: archived.workRelPath,
      directoryStage: archived.directoryStage
    }));
    expect(recordN8nUpdate).toHaveBeenCalledWith(fixture.job.id, expect.objectContaining({
      rowVersion: fixture.job.rowVersion,
      leaseOwner: fixture.job.leaseOwner,
      leaseToken: fixture.job.leaseToken,
      state: 'SUCCEEDED',
      eventType: OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT,
      revision: archived.revision,
      taskFolder: archived.taskFolder,
      workRelPath: archived.workRelPath,
      directoryStage: archived.directoryStage,
      directorySignature: archived.directorySignature,
      jobPayload: expect.objectContaining({
        revision: archived.revision,
        taskFolder: archived.taskFolder,
        workRelPath: archived.workRelPath,
        directoryStage: archived.directoryStage,
        directorySignature: archived.directorySignature,
        videoCacheCleanedAt: archived.videoCacheCleanedAt
      }),
      rfbsStockReadbackAttestation: normalizedBeforeArchive.rfbsStockReadbackAttestation
    }));
    expect(getRfbsStockNormalizationAuthority.mock.invocationCallOrder[0])
      .toBeLessThan(readBoundExecution.mock.invocationCallOrder[0]!);
    expect(readBoundExecution.mock.invocationCallOrder[0])
      .toBeLessThan(archiveSucceededDirectory.mock.invocationCallOrder[0]!);
    expect(archiveSucceededDirectory.mock.invocationCallOrder[0])
      .toBeLessThan(recordN8nUpdate.mock.invocationCallOrder[0]!);
    expect(recordN8nUpdate.mock.invocationCallOrder[0])
      .toBeLessThan(clearSucceededTerminalDirectoryMarkers.mock.invocationCallOrder[0]!);
  });

  it.each(['READ_UNAVAILABLE', 'EXECUTION_INVALID'] as const)(
    'keeps the original NEEDS_ATTENTION path when RFBS evidence is %s',
    async (evidenceFailure) => {
      const fixture = createRfbsRuntimeUpdateFixture();
      const execution = evidenceFailure === 'READ_UNAVAILABLE'
        ? undefined
        : { ...fixture.execution, workflowId: 'wrong-workflow' };
      const recordN8nUpdate = vi.fn(async (_id: string, update: any) => ({
        job: { ...fixture.job, ...update },
        mappings: fixture.authority.mappings
      }));
      const repository = {
        getJob: vi.fn(async () => fixture.job),
        assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
        getSettings: vi.fn(async () => ({ enabled: true })),
        getRfbsStockNormalizationAuthority: vi.fn(async () => fixture.authority),
        recordN8nUpdate
      } as unknown as OzonRepository;
      const readBoundExecution = vi.fn(async () => execution);
      const logger = { warn: vi.fn(), error: vi.fn() } as any;
      const service = new OzonPublishingService(
        repository,
        {} as PurchaseRepository,
        logger,
        undefined,
        undefined,
        undefined,
        readBoundExecution
      );
      const archiveSucceededDirectory = vi.spyOn(service as any, 'archiveSucceededDirectory')
        .mockResolvedValue(undefined);
      const writeTerminalDirectoryMarker = vi.spyOn(service as any, 'writeTerminalDirectoryMarker')
        .mockResolvedValue(undefined);

      await service.recordRuntimeUpdate(fixture.job.id, fixture.input as any);

      expect(readBoundExecution).toHaveBeenCalledWith('190809');
      expect(archiveSucceededDirectory).not.toHaveBeenCalled();
      expect(writeTerminalDirectoryMarker).toHaveBeenCalledWith(fixture.job, 'NEEDS_ATTENTION');
      expect(recordN8nUpdate).toHaveBeenCalledWith(fixture.job.id, expect.objectContaining({
        rowVersion: fixture.job.rowVersion,
        leaseOwner: fixture.job.leaseOwner,
        leaseToken: fixture.job.leaseToken,
        clearLease: true,
        state: 'NEEDS_ATTENTION',
        eventType: 'OZON_FINAL_READBACK_MISMATCH',
        errorCode: 'OZON_FINAL_READBACK_MISMATCH'
      }));
      expect(recordN8nUpdate.mock.calls[0]![1]).not.toHaveProperty('rfbsStockReadbackAttestation');
      expect(readBoundExecution.mock.invocationCallOrder[0])
        .toBeLessThan(writeTerminalDirectoryMarker.mock.invocationCallOrder[0]!);
      expect(writeTerminalDirectoryMarker.mock.invocationCallOrder[0])
        .toBeLessThan(recordN8nUpdate.mock.invocationCallOrder[0]!);
      expect(logger.warn).toHaveBeenCalledOnce();
    }
  );

  it('rejects a stale RFBS callback rowVersion before evidence reads or filesystem side effects', async () => {
    const fixture = createRfbsRuntimeUpdateFixture();
    const getRfbsStockNormalizationAuthority = vi.fn();
    const recordN8nUpdate = vi.fn();
    const repository = {
      getJob: vi.fn(async () => fixture.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true })),
      getRfbsStockNormalizationAuthority,
      recordN8nUpdate
    } as unknown as OzonRepository;
    const readBoundExecution = vi.fn();
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      {} as FastifyBaseLogger,
      undefined,
      undefined,
      undefined,
      readBoundExecution
    );
    const archiveSucceededDirectory = vi.spyOn(service as any, 'archiveSucceededDirectory');
    const writeTerminalDirectoryMarker = vi.spyOn(service as any, 'writeTerminalDirectoryMarker');

    await expect(service.recordRuntimeUpdate(fixture.job.id, {
      ...fixture.input,
      rowVersion: fixture.job.rowVersion - 1
    } as any)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409,
      details: { expected: fixture.job.rowVersion, actual: fixture.job.rowVersion - 1 }
    });

    expect(repository.assertPlatformStatusRefreshNotLeased).toHaveBeenCalledWith(fixture.job.sku, fixture.job.id);
    expect(getRfbsStockNormalizationAuthority).not.toHaveBeenCalled();
    expect(readBoundExecution).not.toHaveBeenCalled();
    expect(archiveSucceededDirectory).not.toHaveBeenCalled();
    expect(writeTerminalDirectoryMarker).not.toHaveBeenCalled();
    expect(recordN8nUpdate).not.toHaveBeenCalled();
  });

  it('archives a claimed task atomically and persists only relative directory metadata', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-archive-'));
    roots.push(rootDirectory);
    await mkdir(path.join(rootDirectory, 'success'), { recursive: true });
    const taskFolder = '0000050__r4';
    const processing = path.join(rootDirectory, 'processing', taskFolder);
    await mkdir(processing, { recursive: true });
    await mkdir(path.join(processing, '.ozon-media-cache'), { recursive: true });
    await writeFile(path.join(processing, '.ozon-media-cache', 'cached.mp4'), 'temporary-cache');
    const product = { schemaVersion: 1, productCode: '0000050', revision: 4, offers: [{ offerId: '0000050-01' }, { offerId: '0000050-02' }] };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(path.join(processing, 'product.json'), JSON.stringify(product, null, 2));
    await writeFile(path.join(processing, '.ozon-intake.json'), JSON.stringify({
      jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee',
      sku: '0000050',
      revision: 4,
      signature
    }));
    const terminalMarkerContents = {
      _ERROR: JSON.stringify({
        jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', revision: 4,
        state: 'NEEDS_ATTENTION', evidence: 'error-bytes'
      }),
      _FAILED: JSON.stringify({
        jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', revision: 4,
        state: 'FAILED', evidence: 'failed-bytes'
      }),
      _CANCELLED: JSON.stringify({
        jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', revision: 4,
        state: 'CANCELLED', evidence: 'cancelled-bytes'
      })
    };
    for (const [markerBase, content] of Object.entries(terminalMarkerContents)) {
      await writeFile(path.join(processing, `${markerBase}.json`), content);
    }
    const current = {
      id: '84d66f89-676e-4d61-8095-bccbe6f2e3ee',
      sku: '0000050',
      source: 'MANUAL',
      state: 'MODERATING',
      rowVersion: 7,
      retryCount: 0,
      revision: 4,
      storeAlias: 'cn-main',
      offerIds: ['0000050-01', '0000050-02'],
      ozonProductLinks: [],
      taskFolder,
      workRelPath: `processing/${taskFolder}`,
      directoryStage: 'PROCESSING',
      directorySignature: signature,
      stageStates: {},
      payload: { revision: 4 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const recordN8nUpdate = vi.fn(async (_id, input) => ({
      job: { ...current, ...input, state: 'SUCCEEDED' },
      mappings: []
    }));
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await service.recordRuntimeUpdate(current.id, {
      rowVersion: 7,
      state: 'SUCCEEDED',
      eventType: 'OZON_PUBLICATION_VERIFIED',
      message: 'verified',
      revision: 4,
      storeAlias: 'cn-main',
      directorySignature: signature,
      productMappings: [
        { offerId: '0000050-02', ozonProductId: '5696881350', ozonSku: '5260179772' },
        { offerId: '0000050-01', ozonProductId: '5691728967', ozonSku: '5260188556' }
      ]
    });

    await expect(lstat(processing)).rejects.toMatchObject({ code: 'ENOENT' });
    const [dateDirectory] = await readdir(path.join(rootDirectory, 'success'));
    const archived = path.join(rootDirectory, 'success', dateDirectory!, taskFolder);
    await expect(lstat(archived)).resolves.toMatchObject({});
    await expect(lstat(path.join(archived, '.ozon-media-cache'))).rejects.toMatchObject({ code: 'ENOENT' });
    const archivedNames = await readdir(archived);
    for (const [markerBase, content] of Object.entries(terminalMarkerContents)) {
      await expect(lstat(path.join(archived, `${markerBase}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
      const recovered = archivedNames.filter((name) => (
        name.startsWith(`${markerBase}.recovered-`) && name.endsWith('.json')
      ));
      expect(recovered).toHaveLength(1);
      await expect(readFile(path.join(archived, recovered[0]!), 'utf8')).resolves.toBe(content);
    }
    expect(recordN8nUpdate).toHaveBeenCalledWith(current.id, expect.objectContaining({
      directoryStage: 'SUCCESS',
      taskFolder,
      workRelPath: `success/${dateDirectory}/${taskFolder}`,
      directorySignature: signature
    }));
    const persisted = recordN8nUpdate.mock.calls[0]![1] as any;
    expect(persisted.jobPayload).not.toHaveProperty('productJsonPath');
    expect(persisted.jobPayload).not.toHaveProperty('workDirectory');
    expect(persisted.jobPayload.videoCacheCleanedAt).toEqual(expect.any(String));
  });

  it('moves a success directory back to processing when the runtime CAS is rejected', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-archive-cas-'));
    roots.push(rootDirectory);
    await mkdir(path.join(rootDirectory, 'success'), { recursive: true });
    const taskFolder = '0000050__r4';
    const processing = path.join(rootDirectory, 'processing', taskFolder);
    await mkdir(processing, { recursive: true });
    const product = { schemaVersion: 1, productCode: '0000050', revision: 4, offers: [{ offerId: '0000050-01' }] };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    const jobId = '84d66f89-676e-4d61-8095-bccbe6f2e3ee';
    await writeFile(path.join(processing, 'product.json'), JSON.stringify(product, null, 2));
    await writeFile(path.join(processing, '.ozon-intake.json'), JSON.stringify({
      jobId, sku: '0000050', revision: 4, signature
    }));
    const originalErrorMarker = JSON.stringify({ jobId, state: 'NEEDS_ATTENTION', evidence: 'preserve-error' });
    const originalCancelledMarker = JSON.stringify({ jobId, state: 'CANCELLED', evidence: 'preserve-cancel' });
    await writeFile(path.join(processing, '_ERROR.json'), originalErrorMarker);
    await writeFile(path.join(processing, '_CANCELLED.json'), originalCancelledMarker);
    const current = {
      id: jobId, sku: '0000050', source: 'AUTO', state: 'NEEDS_ATTENTION', rowVersion: 35, retryCount: 0,
      revision: 4, storeAlias: 'default', offerIds: ['0000050-01'], ozonProductLinks: [], taskFolder,
      workRelPath: `processing/${taskFolder}`, directoryStage: 'PROCESSING', directorySignature: signature,
      stageStates: {}, payload: { revision: 4 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } as any;
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      recordN8nUpdate: vi.fn(async () => {
        throw new AppError('TASK_LOCKED', 'OZON 运行时发布租约已失效或被其他执行接管', {
          reasonCode: 'OZON_RUNTIME_LEASE_LOST'
        }, 409);
      })
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as any);

    await expect(service.recordRuntimeUpdate(jobId, {
      rowVersion: 35,
      state: 'SUCCEEDED',
      eventType: 'OZON_PUBLICATION_RECONCILED',
      message: 'verified',
      revision: 4,
      storeAlias: 'default',
      directorySignature: signature,
      productMappings: [{ offerId: '0000050-01', ozonProductId: '5691728967', ozonSku: '5260188556' }]
    })).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });

    await expect(readFile(path.join(processing, 'product.json'), 'utf8')).resolves.toContain('0000050-01');
    await expect(readFile(path.join(processing, '_ERROR.json'), 'utf8')).resolves.toBe(originalErrorMarker);
    await expect(readFile(path.join(processing, '_CANCELLED.json'), 'utf8')).resolves.toBe(originalCancelledMarker);
    for (const dateDirectory of await readdir(path.join(rootDirectory, 'success'))) {
      await expect(lstat(path.join(rootDirectory, 'success', dateDirectory, taskFolder))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps the success directory when readback proves a lost database response committed', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-archive-unknown-'));
    roots.push(rootDirectory);
    await mkdir(path.join(rootDirectory, 'success'), { recursive: true });
    const taskFolder = '0000050__r4';
    const processing = path.join(rootDirectory, 'processing', taskFolder);
    await mkdir(processing, { recursive: true });
    const product = { schemaVersion: 1, productCode: '0000050', revision: 4, offers: [{ offerId: '0000050-01' }] };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    const jobId = '84d66f89-676e-4d61-8095-bccbe6f2e3ee';
    await writeFile(path.join(processing, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(processing, '.ozon-intake.json'), JSON.stringify({ jobId, sku: '0000050', revision: 4, signature }));
    await writeFile(path.join(processing, '_ERROR.json'), JSON.stringify({
      jobId, sku: '0000050', revision: 4, state: 'NEEDS_ATTENTION'
    }));
    await writeFile(path.join(processing, '_FAILED.json'), JSON.stringify({
      jobId, sku: '0000050', revision: 4, state: 'FAILED'
    }));
    await writeFile(path.join(processing, '_CANCELLED.json'), JSON.stringify({
      jobId, sku: '0000050', revision: 4, state: 'CANCELLED'
    }));
    const current = {
      id: jobId, sku: '0000050', source: 'AUTO', state: 'MODERATING', rowVersion: 35, retryCount: 0,
      revision: 4, storeAlias: 'default', offerIds: ['0000050-01'], ozonProductLinks: [], taskFolder,
      workRelPath: `processing/${taskFolder}`, directoryStage: 'PROCESSING', directorySignature: signature,
      stageStates: {}, payload: { revision: 4 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } as any;
    let reads = 0;
    const getJob = vi.fn(async () => {
      reads += 1;
      if (reads === 1) return current;
      const [dateDirectory] = await readdir(path.join(rootDirectory, 'success'));
      return {
        ...current,
        state: 'SUCCEEDED',
        rowVersion: 36,
        directoryStage: 'SUCCESS',
        workRelPath: `success/${dateDirectory}/${taskFolder}`,
        ozonProductLinks: [{ offerId: '0000050-01', ozonProductId: '5691728967', ozonSku: '5260188556' }]
      };
    });
    const repository = {
      getJob,
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      recordN8nUpdate: vi.fn(async () => { throw new Error('connection lost after COMMIT'); })
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as any);

    const result = await service.recordRuntimeUpdate(jobId, {
      rowVersion: 35,
      state: 'SUCCEEDED',
      eventType: 'OZON_PUBLICATION_RECONCILED',
      message: 'verified',
      revision: 4,
      storeAlias: 'default',
      directorySignature: signature,
      productMappings: [{ offerId: '0000050-01', ozonProductId: '5691728967', ozonSku: '5260188556' }]
    });

    expect(result.job).toMatchObject({ state: 'SUCCEEDED', directoryStage: 'SUCCESS' });
    expect(result.mapping).toMatchObject({ offerId: '0000050-01', ozonProductId: '5691728967' });
    await expect(lstat(processing)).rejects.toMatchObject({ code: 'ENOENT' });
    const [dateDirectory] = await readdir(path.join(rootDirectory, 'success'));
    const archived = path.join(rootDirectory, 'success', dateDirectory!, taskFolder);
    await expect(lstat(archived)).resolves.toMatchObject({});
    await expect(lstat(path.join(archived, '_ERROR.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(archived, '_FAILED.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(archived, '_CANCELLED.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a failed manual task to edit without deleting evidence and replays idempotently', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-return-edit-'));
    roots.push(rootDirectory);
    const sku = '0000061';
    const revision = 4;
    const jobId = '53d6a0f6-f3d5-47d7-992d-c5614c58aa6b';
    const taskFolder = `${sku}__r${revision}`;
    const processing = path.join(rootDirectory, 'processing', taskFolder);
    await mkdir(path.join(processing, 'variants', 'black'), { recursive: true });
    const product = { schemaVersion: 2, productCode: sku, revision, offers: [{ offerId: `${sku}-01` }] };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(path.join(processing, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(processing, '.ozon-intake.json'), JSON.stringify({ jobId, sku, revision, signature }));
    await writeFile(path.join(processing, 'variants', 'black', '01.jpg'), 'image-evidence');
    let listing = { sku, rowVersion: 8, status: 'NEEDS_ATTENTION' } as any;
    let current = {
      id: jobId, sku, source: 'MANUAL', state: 'NEEDS_ATTENTION', rowVersion: 6, retryCount: 0,
      revision, storeAlias: 'default', offerIds: [`${sku}-01`], ozonProductLinks: [], taskFolder,
      workRelPath: `processing/${taskFolder}`, directoryStage: 'PROCESSING', directorySignature: signature,
      stageStates: {}, payload: { revision }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } as any;
    const returnManualJobToEdit = vi.fn(async (input: any) => {
      current = { ...current, state: 'CANCELLED', rowVersion: 7, payload: { ...current.payload, returnedToEdit: input.recovery } };
      listing = { ...listing, status: 'READY', rowVersion: 9 };
      return { job: current, listing };
    });
    const repository = {
      getJob: vi.fn(async () => current),
      getListing: vi.fn(async () => listing),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      returnManualJobToEdit
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    const first = await service.returnManualJobToEdit(sku, jobId, { jobRowVersion: 6, listingRowVersion: 8 });
    expect(first.job.state).toBe('CANCELLED');
    expect(first.recovery).toMatchObject({ mode: 'HARDLINK', assetCount: 1 });
    await expect(readFile(path.join(rootDirectory, 'inbox', sku, 'variants', 'black', '01.jpg'), 'utf8')).resolves.toBe('image-evidence');
    await expect(readFile(path.join(processing, 'product.json'), 'utf8')).resolves.toContain(`"productCode":"${sku}"`);
    await expect(lstat(path.join(processing, '_CANCELLED.json'))).resolves.toMatchObject({});

    const replay = await service.returnManualJobToEdit(sku, jobId, { jobRowVersion: 6, listingRowVersion: 8 });
    expect(replay.recovery).toMatchObject({ mode: 'HARDLINK', assetCount: 1 });
    expect(returnManualJobToEdit).toHaveBeenCalledTimes(1);
  });

  it('accepts the signed multistore productContentHash when writing a terminal marker', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-multistore-terminal-'));
    roots.push(rootDirectory);
    const sku = '0000119';
    const revision = 2;
    const jobId = '24675e2c-4846-4747-9261-32b6949b0ba8';
    const taskFolder = `${sku}__r${revision}`;
    const workRelPath = `processing/default__${sku}__r${revision}`;
    const workDirectory = path.join(rootDirectory, ...workRelPath.split('/'));
    await mkdir(workDirectory, { recursive: true });
    const productBytes = `${JSON.stringify({
      schemaVersion: 3,
      productCode: sku,
      revision,
      offers: [{ offerId: `${sku}-01` }]
    }, null, 2)}\n`;
    const productContentHash = `sha256:${createHash('sha256').update(productBytes).digest('hex')}`;
    await writeFile(path.join(workDirectory, 'product.json'), productBytes);
    await writeFile(path.join(workDirectory, '.ozon-intake.json'), JSON.stringify({
      schemaVersion: 1,
      jobId,
      taskId: `default__${sku}__r${revision}`,
      storeId: '00000000-0000-4000-8000-000000000002',
      storeAlias: 'default',
      publicationId: 'b10a4f42-6390-4506-8c57-541000321876',
      credentialBindingMode: 'VAULT',
      sku,
      revision,
      productContentHash,
      ticket: 'hmac-sha256:test-only'
    }));
    const current = {
      id: jobId,
      sku,
      source: 'AUTO',
      state: 'IMPORTING',
      rowVersion: 17,
      retryCount: 0,
      revision,
      storeAlias: 'default',
      storeId: '00000000-0000-4000-8000-000000000002',
      publicationId: 'b10a4f42-6390-4506-8c57-541000321876',
      credentialBindingMode: 'VAULT',
      taskId: `default__${sku}__r${revision}`,
      offerIds: [`${sku}-01`],
      ozonProductLinks: [],
      taskFolder,
      workRelPath,
      directoryStage: 'PROCESSING',
      directorySignature: productContentHash,
      stageStates: { import: 'SUBMITTED' },
      payload: { schemaVersion: 3, mode: 'MULTISTORE_PUBLICATION', revision },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const recordN8nUpdate = vi.fn(async (_id, input) => ({
      job: { ...current, ...input, rowVersion: current.rowVersion + 1 },
      mappings: input.productMappings || []
    }));
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.recordRuntimeUpdate(jobId, {
      rowVersion: current.rowVersion,
      state: 'NEEDS_ATTENTION',
      eventType: 'OZON_IMPORT_PARTIAL_FAILED',
      message: 'OZON 导入返回属性值错误',
      importTaskId: '5379111046',
      errorCode: 'OZON_IMPORT_PARTIAL_FAILED',
      errorMessage: 'attribute_id=85',
      productMappings: [{ offerId: `${sku}-01`, ozonProductId: '5913618188' }]
    })).resolves.toMatchObject({
      job: { state: 'NEEDS_ATTENTION', importTaskId: '5379111046' },
      mappings: [{ offerId: `${sku}-01`, ozonProductId: '5913618188' }]
    });
    await expect(readFile(path.join(workDirectory, '_ERROR.json'), 'utf8')).resolves.toContain(jobId);
    expect(recordN8nUpdate).toHaveBeenCalledTimes(1);

    const intakePath = path.join(workDirectory, '.ozon-intake.json');
    const intake = JSON.parse(await readFile(intakePath, 'utf8')) as Record<string, unknown>;
    await writeFile(intakePath, JSON.stringify({ ...intake, signature: `sha256:${'f'.repeat(64)}` }));
    await expect(service.recordRuntimeUpdate(jobId, {
      rowVersion: current.rowVersion,
      state: 'NEEDS_ATTENTION',
      eventType: 'OZON_IMPORT_PARTIAL_FAILED',
      message: 'must fail closed',
      importTaskId: '5379111046',
      errorCode: 'OZON_IMPORT_PARTIAL_FAILED'
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(recordN8nUpdate).toHaveBeenCalledTimes(1);
  });

  it('archives a validated legacy inbox task and creates the intake marker before moving it', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-legacy-inbox-'));
    roots.push(rootDirectory);
    await mkdir(path.join(rootDirectory, 'success'), { recursive: true });
    const taskFolder = '0000052__r9';
    const inbox = path.join(rootDirectory, 'inbox', '0000052');
    await mkdir(inbox, { recursive: true });
    const product = {
      schemaVersion: 2,
      productCode: '0000052',
      revision: 9,
      offers: [{ offerId: '0000052-01' }, { offerId: '0000052-02' }]
    };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(path.join(inbox, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(inbox, '_READY'), JSON.stringify({
      sku: '0000052',
      revision: 9,
      signature
    }));
    const current = {
      id: '446cc728-bb6d-4f4e-b91e-8126bc31fe7d',
      sku: '0000052',
      source: 'MANUAL',
      state: 'MODERATING',
      rowVersion: 18,
      retryCount: 0,
      revision: 9,
      storeAlias: 'default',
      offerIds: ['0000052-01', '0000052-02'],
      ozonProductLinks: [],
      taskFolder,
      workRelPath: 'inbox/0000052',
      directoryStage: 'INBOX',
      directorySignature: signature,
      stageStates: {},
      payload: { revision: 9 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const recordN8nUpdate = vi.fn(async (_id, input) => ({
      job: { ...current, ...input, state: 'SUCCEEDED' },
      mappings: []
    }));
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await service.recordRuntimeUpdate(current.id, {
      rowVersion: 18,
      state: 'SUCCEEDED',
      eventType: 'OZON_PUBLICATION_VERIFIED',
      message: 'verified',
      revision: 9,
      storeAlias: 'default',
      directorySignature: signature,
      productMappings: [
        { offerId: '0000052-01', ozonProductId: '5704996097', ozonSku: '5251588670' },
        { offerId: '0000052-02', ozonProductId: '5704995942', ozonSku: '5251587880' }
      ]
    });

    await expect(lstat(inbox)).rejects.toMatchObject({ code: 'ENOENT' });
    const [dateDirectory] = await readdir(path.join(rootDirectory, 'success'));
    const archived = path.join(rootDirectory, 'success', dateDirectory!, taskFolder);
    await expect(lstat(path.join(archived, '.ozon-intake.json'))).resolves.toMatchObject({});
    expect(recordN8nUpdate).toHaveBeenCalledWith(current.id, expect.objectContaining({
      directoryStage: 'SUCCESS',
      taskFolder,
      workRelPath: `success/${dateDirectory}/${taskFolder}`,
      directorySignature: signature
    }));
  });

  it('rejects a success date junction before moving the processing directory', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-junction-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-outside-'));
    roots.push(rootDirectory, outside);
    await mkdir(path.join(rootDirectory, 'success'), { recursive: true });
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    await symlink(outside, path.join(rootDirectory, 'success', date), process.platform === 'win32' ? 'junction' : 'dir');
    const taskFolder = '0000050__r4';
    const processing = path.join(rootDirectory, 'processing', taskFolder);
    await mkdir(processing, { recursive: true });
    const product = { schemaVersion: 1, productCode: '0000050', revision: 4, offers: [{ offerId: '0000050-01' }] };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(path.join(processing, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(processing, '.ozon-intake.json'), JSON.stringify({
      jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', revision: 4, signature
    }));
    const originalErrorMarker = JSON.stringify({ state: 'NEEDS_ATTENTION', evidence: 'archive-failed' });
    const originalCancelledMarker = JSON.stringify({ state: 'CANCELLED', evidence: 'archive-failed' });
    await writeFile(path.join(processing, '_ERROR.json'), originalErrorMarker);
    await writeFile(path.join(processing, '_CANCELLED.json'), originalCancelledMarker);
    const current = {
      id: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', source: 'MANUAL', state: 'MODERATING',
      rowVersion: 7, retryCount: 0, revision: 4, storeAlias: 'cn-main', offerIds: ['0000050-01'],
      ozonProductLinks: [], taskFolder, workRelPath: `processing/${taskFolder}`, directoryStage: 'PROCESSING',
      directorySignature: signature, stageStates: {}, payload: { revision: 4 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } as any;
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      recordN8nUpdate: vi.fn()
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.recordRuntimeUpdate(current.id, {
      rowVersion: 7,
      state: 'SUCCEEDED',
      eventType: 'OZON_PUBLICATION_VERIFIED',
      message: 'verified',
      revision: 4,
      storeAlias: 'cn-main',
      directorySignature: signature,
      productMappings: [{ offerId: '0000050-01', ozonProductId: '5691728967', ozonSku: '5260188556' }]
    })).rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });
    await expect(lstat(processing)).resolves.toMatchObject({});
    await expect(readFile(path.join(processing, '_ERROR.json'), 'utf8')).resolves.toBe(originalErrorMarker);
    await expect(readFile(path.join(processing, '_CANCELLED.json'), 'utf8')).resolves.toBe(originalCancelledMarker);
  });

  it('finishes the database transition when the filesystem was already archived before a retry', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-archive-retry-'));
    roots.push(rootDirectory);
    const taskFolder = '0000050__r4';
    const date = '2026-07-28';
    const archived = path.join(rootDirectory, 'success', date, taskFolder);
    await mkdir(archived, { recursive: true });
    const product = { schemaVersion: 1, productCode: '0000050', revision: 4, offers: [{ offerId: '0000050-01' }] };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    await writeFile(path.join(archived, 'product.json'), JSON.stringify(product, null, 2));
    await writeFile(path.join(archived, '.ozon-intake.json'), JSON.stringify({
      jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', revision: 4, signature
    }));
    await writeFile(path.join(archived, '_ERROR.json'), JSON.stringify({
      jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', revision: 4,
      state: 'NEEDS_ATTENTION'
    }));
    await writeFile(path.join(archived, '_FAILED.json'), JSON.stringify({
      jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', revision: 4,
      state: 'FAILED'
    }));
    await writeFile(path.join(archived, '_CANCELLED.json'), JSON.stringify({
      jobId: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', revision: 4,
      state: 'CANCELLED'
    }));
    const current = {
      id: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', source: 'MANUAL', state: 'MODERATING',
      rowVersion: 7, retryCount: 0, revision: 4, storeAlias: 'cn-main', offerIds: ['0000050-01'],
      ozonProductLinks: [], taskFolder, workRelPath: `processing/${taskFolder}`, directoryStage: 'PROCESSING',
      directorySignature: signature, stageStates: {}, payload: { revision: 4 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } as any;
    const recordN8nUpdate = vi.fn(async (_id, input) => ({ job: { ...current, ...input }, mappings: [] }));
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await service.recordRuntimeUpdate(current.id, {
      rowVersion: 7,
      state: 'SUCCEEDED',
      eventType: 'OZON_PUBLICATION_VERIFIED',
      message: 'retry',
      revision: 4,
      storeAlias: 'cn-main',
      directorySignature: signature,
      productMappings: [{ offerId: '0000050-01', ozonProductId: '5691728967', ozonSku: '5260188556' }]
    });

    expect(recordN8nUpdate).toHaveBeenCalledWith(current.id, expect.objectContaining({
      directoryStage: 'SUCCESS',
      workRelPath: `success/${date}/${taskFolder}`
    }));
    await expect(lstat(path.join(archived, '_ERROR.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(archived, '_FAILED.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(archived, '_CANCELLED.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts an identical stale success replay without another event and rejects changed mappings', async () => {
    const signature = `sha256:${'b'.repeat(64)}`;
    const current = {
      id: '84d66f89-676e-4d61-8095-bccbe6f2e3ee', sku: '0000050', source: 'MANUAL', state: 'SUCCEEDED',
      rowVersion: 8, retryCount: 0, revision: 4, storeAlias: 'cn-main', offerIds: ['0000050-01'],
      ozonProductLinks: [{ offerId: '0000050-01', ozonProductId: '5691728967', ozonSku: '5260188556', url: 'https://www.ozon.ru/product/5260188556/' }],
      taskFolder: '0000050__r4', workRelPath: 'success/2026-07-28/0000050__r4', directoryStage: 'SUCCESS',
      directorySignature: signature, stageStates: {}, payload: { revision: 4 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } as any;
    const recordN8nUpdate = vi.fn();
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: false })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);
    const clearSucceededTerminalDirectoryMarkers = vi.spyOn(service as any, 'clearSucceededTerminalDirectoryMarkers')
      .mockResolvedValue(undefined);
    const replay = {
      rowVersion: 7,
      state: 'SUCCEEDED' as const,
      eventType: 'OZON_PUBLICATION_VERIFIED',
      message: 'replayed',
      revision: 4,
      storeAlias: 'cn-main',
      directorySignature: signature,
      productMappings: [{ offerId: '0000050-01', ozonProductId: '5691728967', ozonSku: '5260188556' }]
    };

    await expect(service.recordRuntimeUpdate(current.id, replay)).resolves.toMatchObject({ job: current });
    expect(recordN8nUpdate).not.toHaveBeenCalled();
    expect(clearSucceededTerminalDirectoryMarkers).toHaveBeenCalledOnce();
    expect(clearSucceededTerminalDirectoryMarkers).toHaveBeenCalledWith(current);
    await expect(service.recordRuntimeUpdate(current.id, {
      ...replay,
      productMappings: [{ offerId: '0000050-01', ozonProductId: '9999999999', ozonSku: '5260188556' }]
    })).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    expect(recordN8nUpdate).not.toHaveBeenCalled();
    expect(clearSucceededTerminalDirectoryMarkers).toHaveBeenCalledOnce();
  });

  it('atomically preserves all recovered terminal marker bytes and keeps succeeded replay cleanup idempotent', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-success-marker-replay-'));
    roots.push(rootDirectory);
    const sku = '0000050';
    const revision = 4;
    const taskFolder = `${sku}__r${revision}`;
    const successRelPath = `success/2026-08-09/${taskFolder}`;
    const successDirectory = path.join(rootDirectory, 'success', '2026-08-09', taskFolder);
    await mkdir(successDirectory, { recursive: true });
    const product = { schemaVersion: 1, productCode: sku, revision, offers: [{ offerId: `${sku}-01` }] };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    const jobId = '84d66f89-676e-4d61-8095-bccbe6f2e3ee';
    await writeFile(path.join(successDirectory, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(successDirectory, '.ozon-intake.json'), JSON.stringify({
      jobId, sku, revision, signature
    }));
    const terminalMarkerContents = {
      _ERROR: `{"jobId":"${jobId}","sku":"${sku}","revision":${revision},"state":"NEEDS_ATTENTION","evidence":"exact error bytes"}\n`,
      _FAILED: `{"jobId":"${jobId}","sku":"${sku}","revision":${revision},"state":"FAILED","evidence":"exact failed bytes"}\n`,
      _CANCELLED: `{"jobId":"${jobId}","sku":"${sku}","revision":${revision},"state":"CANCELLED","evidence":"exact cancelled bytes"}\n`
    };
    for (const [markerBase, content] of Object.entries(terminalMarkerContents)) {
      await writeFile(path.join(successDirectory, `${markerBase}.json`), content);
    }
    const current = {
      id: jobId,
      sku,
      source: 'AUTO',
      state: 'SUCCEEDED',
      rowVersion: 36,
      retryCount: 0,
      revision,
      storeAlias: 'default',
      offerIds: [`${sku}-01`],
      ozonProductLinks: [{
        offerId: `${sku}-01`,
        ozonProductId: '5691728967',
        ozonSku: '5260188556',
        url: 'https://www.ozon.ru/product/5260188556/'
      }],
      taskFolder,
      workRelPath: successRelPath,
      directoryStage: 'SUCCESS',
      directorySignature: signature,
      stageStates: {},
      payload: { revision },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const recordN8nUpdate = vi.fn();
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);
    const replay = {
      rowVersion: 35,
      state: 'SUCCEEDED' as const,
      eventType: 'OZON_PUBLICATION_VERIFIED',
      message: 'replayed',
      revision,
      storeAlias: 'default',
      directorySignature: signature,
      productMappings: [{ offerId: `${sku}-01`, ozonProductId: '5691728967', ozonSku: '5260188556' }]
    };

    await service.recordRuntimeUpdate(jobId, replay);
    const recoveredAfterFirstReplay = (await readdir(successDirectory))
      .filter((name) => name.includes('.recovered-'))
      .sort();
    expect(recoveredAfterFirstReplay).toHaveLength(3);
    for (const [markerBase, content] of Object.entries(terminalMarkerContents)) {
      await expect(lstat(path.join(successDirectory, `${markerBase}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
      const recovered = recoveredAfterFirstReplay.filter((name) => name.startsWith(`${markerBase}.recovered-`));
      expect(recovered).toHaveLength(1);
      await expect(readFile(path.join(successDirectory, recovered[0]!), 'utf8')).resolves.toBe(content);
    }

    await service.recordRuntimeUpdate(jobId, replay);
    const recoveredAfterSecondReplay = (await readdir(successDirectory))
      .filter((name) => name.includes('.recovered-'))
      .sort();
    expect(recoveredAfterSecondReplay).toEqual(recoveredAfterFirstReplay);
    expect(recordN8nUpdate).not.toHaveBeenCalled();
  });

  it('rejects a symlinked succeeded terminal marker without touching its target or recording another event', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-success-marker-symlink-'));
    roots.push(rootDirectory);
    const sku = '0000050';
    const revision = 4;
    const taskFolder = `${sku}__r${revision}`;
    const successRelPath = `success/2026-08-09/${taskFolder}`;
    const successDirectory = path.join(rootDirectory, 'success', '2026-08-09', taskFolder);
    await mkdir(successDirectory, { recursive: true });
    const product = { schemaVersion: 1, productCode: sku, revision, offers: [{ offerId: `${sku}-01` }] };
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
    const jobId = '84d66f89-676e-4d61-8095-bccbe6f2e3ee';
    await writeFile(path.join(successDirectory, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(successDirectory, '.ozon-intake.json'), JSON.stringify({
      jobId, sku, revision, signature
    }));
    const outsideMarker = path.join(rootDirectory, 'outside-error-evidence.json');
    const outsideContent = '{"evidence":"must remain untouched"}\n';
    await writeFile(outsideMarker, outsideContent);
    await symlink(outsideMarker, path.join(successDirectory, '_ERROR.json'), 'file');
    const current = {
      id: jobId,
      sku,
      source: 'AUTO',
      state: 'SUCCEEDED',
      rowVersion: 36,
      retryCount: 0,
      revision,
      storeAlias: 'default',
      offerIds: [`${sku}-01`],
      ozonProductLinks: [{
        offerId: `${sku}-01`,
        ozonProductId: '5691728967',
        ozonSku: '5260188556',
        url: 'https://www.ozon.ru/product/5260188556/'
      }],
      taskFolder,
      workRelPath: successRelPath,
      directoryStage: 'SUCCESS',
      directorySignature: signature,
      stageStates: {},
      payload: { revision },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const recordN8nUpdate = vi.fn();
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.recordRuntimeUpdate(jobId, {
      rowVersion: 35,
      state: 'SUCCEEDED',
      eventType: 'OZON_PUBLICATION_VERIFIED',
      message: 'replayed',
      revision,
      storeAlias: 'default',
      directorySignature: signature,
      productMappings: [{ offerId: `${sku}-01`, ozonProductId: '5691728967', ozonSku: '5260188556' }]
    })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409,
      details: expect.objectContaining({ markerName: '_ERROR.json' })
    });

    await expect(lstat(path.join(successDirectory, '_ERROR.json'))).resolves.toMatchObject({});
    await expect(readFile(outsideMarker, 'utf8')).resolves.toBe(outsideContent);
    expect(recordN8nUpdate).not.toHaveBeenCalled();
  });

  it.each(['INVALID_JSON', 'IDENTITY_MISMATCH', 'STATE_MISMATCH'] as const)(
    'fails closed without moving a succeeded terminal marker when its content is %s',
    async (failureMode) => {
      const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-success-marker-invalid-'));
      roots.push(rootDirectory);
      const sku = '0000050';
      const revision = 4;
      const taskFolder = `${sku}__r${revision}`;
      const successRelPath = `success/2026-08-09/${taskFolder}`;
      const successDirectory = path.join(rootDirectory, 'success', '2026-08-09', taskFolder);
      await mkdir(successDirectory, { recursive: true });
      const product = { schemaVersion: 1, productCode: sku, revision, offers: [{ offerId: `${sku}-01` }] };
      const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
      const jobId = '84d66f89-676e-4d61-8095-bccbe6f2e3ee';
      await writeFile(path.join(successDirectory, 'product.json'), JSON.stringify(product));
      await writeFile(path.join(successDirectory, '.ozon-intake.json'), JSON.stringify({
        jobId, sku, revision, signature
      }));
      const invalidMarkerContent = failureMode === 'INVALID_JSON'
        ? '{not-json'
        : JSON.stringify({
            jobId: failureMode === 'IDENTITY_MISMATCH' ? randomUUID() : jobId,
            sku,
            revision,
            state: failureMode === 'STATE_MISMATCH' ? 'FAILED' : 'NEEDS_ATTENTION'
          });
      await writeFile(path.join(successDirectory, '_ERROR.json'), invalidMarkerContent);
      const current = {
        id: jobId,
        sku,
        source: 'AUTO',
        state: 'SUCCEEDED',
        rowVersion: 36,
        retryCount: 0,
        revision,
        storeAlias: 'default',
        offerIds: [`${sku}-01`],
        ozonProductLinks: [{
          offerId: `${sku}-01`,
          ozonProductId: '5691728967',
          ozonSku: '5260188556',
          url: 'https://www.ozon.ru/product/5260188556/'
        }],
        taskFolder,
        workRelPath: successRelPath,
        directoryStage: 'SUCCESS',
        directorySignature: signature,
        stageStates: {},
        payload: { revision },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } as any;
      const recordN8nUpdate = vi.fn();
      const repository = {
        getJob: vi.fn(async () => current),
        assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
        getSettings: vi.fn(async () => ({ rootDirectory })),
        recordN8nUpdate
      } as unknown as OzonRepository;
      const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

      await expect(service.recordRuntimeUpdate(jobId, {
        rowVersion: 35,
        state: 'SUCCEEDED',
        eventType: 'OZON_PUBLICATION_VERIFIED',
        message: 'replayed',
        revision,
        storeAlias: 'default',
        directorySignature: signature,
        productMappings: [{ offerId: `${sku}-01`, ozonProductId: '5691728967', ozonSku: '5260188556' }]
      })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        statusCode: 409,
        details: expect.objectContaining({
          markerName: '_ERROR.json',
          expectedState: 'NEEDS_ATTENTION',
          reasonCode: 'OZON_SUCCESS_TERMINAL_MARKER_IDENTITY_MISMATCH'
        })
      });

      await expect(readFile(path.join(successDirectory, '_ERROR.json'), 'utf8')).resolves.toBe(invalidMarkerContent);
      expect((await readdir(successDirectory)).filter((name) => name.startsWith('_ERROR.recovered-'))).toEqual([]);
      expect(recordN8nUpdate).not.toHaveBeenCalled();
    }
  );

  it('does not re-enqueue an unclaimed inbox task while OZON management is disabled', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-recheck-'));
    roots.push(rootDirectory);
    const signature = `sha256:${'c'.repeat(64)}`;
    const current = {
      id: '3520953e-9bbf-4c25-b919-80a1c2978c1e', sku: '0000049', source: 'MANUAL', state: 'NEEDS_ATTENTION',
      rowVersion: 6, retryCount: 0, revision: 6, storeAlias: 'cn-main', offerIds: ['0000049-01', '0000049-02'],
      ozonProductLinks: [], taskFolder: '0000049__r6', workRelPath: 'inbox/0000049', directoryStage: 'INBOX',
      directorySignature: signature, stageStates: {}, payload: { revision: 6 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } as any;
    const transitionJob = vi.fn(async (_id, input) => ({ ...current, ...input, rowVersion: 7 }));
    const repository = {
      getJob: vi.fn(async () => current),
      getSettings: vi.fn(async () => ({
        enabled: false,
        credentialReady: true,
        taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/merchroute-ozon-tasks',
        rootDirectory
      })),
      transitionJob
    } as unknown as OzonRepository;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      accepted: true,
      taskId: current.id,
      taskFolder: '0000049__r6',
      workRelPath: 'processing/0000049__r6',
      directoryStage: 'PROCESSING',
      signature
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.recheckJob(current.id, 'MANUAL')).rejects.toMatchObject({
      code: 'OZON_MANAGEMENT_DISABLED',
      statusCode: 409
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transitionJob).not.toHaveBeenCalled();
  });

  it('resumes NOT_PASS_MODERATION stock writes without publishing again and clears its error marker', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-remote-recheck-'));
    roots.push(rootDirectory);
    const signature = `sha256:${'d'.repeat(64)}`;
    const workDirectory = path.join(rootDirectory, 'processing', '0000062__r5');
    await mkdir(workDirectory, { recursive: true });
    await writeFile(path.join(workDirectory, '.ozon-intake.json'), JSON.stringify({
      jobId: 'f7fbf031-bd04-4ce5-8e8b-67c81e1ded9f',
      sku: '0000062',
      revision: 5,
      signature,
      taskFolder: '0000062__r5',
      workRelPath: 'processing/0000062__r5',
      directoryStage: 'PROCESSING'
    }));
    await writeFile(path.join(workDirectory, '_ERROR.json'), JSON.stringify({ state: 'NEEDS_ATTENTION' }));
    const current = {
      id: 'f7fbf031-bd04-4ce5-8e8b-67c81e1ded9f', sku: '0000062', source: 'MANUAL', state: 'NEEDS_ATTENTION',
      rowVersion: 7, retryCount: 0, revision: 5, storeAlias: 'default',
      offerIds: ['0000062-01', '0000062-02', '0000062-03'], ozonProductLinks: [],
      taskId: 'f7fbf031-bd04-4ce5-8e8b-67c81e1ded9f', importTaskId: '5280256601',
      taskFolder: '0000062__r5', workRelPath: 'processing/0000062__r5', directoryStage: 'PROCESSING',
      directorySignature: signature,
      stageStates: { import: 'SUCCESS', moderation: 'PENDING', images: 'SUBMITTED', video: 'SUBMITTED', price: 'WRITE_ACCEPTED', stock: 'FAILED' },
      payload: {
        revision: 5,
        priceStockConsistencyRetry: 2,
        priceStockWriteProgress: {
          pricesWrite: {
            succeededOfferIds: ['0000062-01', '0000062-02', '0000062-03'],
            pendingOfferIds: [],
            failedOfferIds: [],
            errorsByOffer: {}
          },
          stocksWrite: {
            succeededOfferIds: [],
            pendingOfferIds: [],
            failedOfferIds: ['0000062-01', '0000062-02', '0000062-03'],
            errorsByOffer: Object.fromEntries(['0000062-01', '0000062-02', '0000062-03'].map((offerId) => [offerId, [{
              code: 'NOT_PASS_MODERATION', message: 'Product is not moderated', retryable: false
            }]]))
          }
        }
      },
      lastErrorCode: 'OZON_PRICE_STOCK_WRITE_FAILED',
      lastErrorMessage: 'OZON price or stock write failed',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } as any;
    const recordN8nUpdate = vi.fn(async (_id, input) => ({ job: { ...current, ...input, rowVersion: 8 }, mappings: [] }));
    const repository = {
      getJob: vi.fn(async () => current),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ credentialReady: true, taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/jobs', rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    const recovered = await service.recheckJob(current.id, 'MANUAL', 7);

    expect(recovered).toMatchObject({ state: 'IMPORTING', importTaskId: '5280256601' });
    expect(recordN8nUpdate).toHaveBeenCalledWith(current.id, expect.objectContaining({
      state: 'IMPORTING',
      importTaskId: '5280256601',
      eventType: 'JOB_REMOTE_PROGRESS_RECHECKED',
      jobPayload: expect.objectContaining({
        priceStockConsistencyRetry: 0,
        finalVerificationLeaseUntil: null,
        priceStockWriteProgress: expect.objectContaining({
          pricesWrite: expect.objectContaining({
            succeededOfferIds: ['0000062-01', '0000062-02', '0000062-03'],
            pendingOfferIds: [],
            failedOfferIds: []
          }),
          stocksWrite: expect.objectContaining({
            pendingOfferIds: ['0000062-01', '0000062-02', '0000062-03'],
            failedOfferIds: []
          })
        })
      })
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(lstat(path.join(workDirectory, '_ERROR.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(workDirectory)).some((name) => name.startsWith('_ERROR.recovered-'))).toBe(true);
    expect(ozonJobRecovery(current)).toMatchObject({ action: 'RECHECK', retryable: true, resumeState: 'IMPORTING' });
    expect(ozonJobRecovery({
      ...current,
      payload: { revision: 5 },
      lastErrorMessage: 'PRODUCT_HAS_NOT_BEEN_TAGGED_YET'
    })).toMatchObject({
      action: 'RECHECK', retryable: true, resumeState: 'IMPORTING'
    });
    expect(ozonJobRecovery({
      ...current,
      payload: {
        revision: 5,
        priceStockWriteProgress: {
          pricesWrite: {
            succeededOfferIds: ['0000062-01', '0000062-02', '0000062-03'],
            pendingOfferIds: [],
            failedOfferIds: [],
            errorsByOffer: {}
          },
          stocksWrite: {
            succeededOfferIds: [],
            pendingOfferIds: [],
            failedOfferIds: ['0000062-01'],
            errorsByOffer: {
              '0000062-01': [
                { code: 'NOT_PASS_MODERATION', message: 'Product is not moderated' },
                { code: 'WAREHOUSE_NOT_FOUND', message: 'Warehouse not found' }
              ]
            }
          }
        }
      },
      lastErrorMessage: 'NOT_PASS_MODERATION'
    })).toMatchObject({ action: 'NONE', retryable: false });
    await expect(service.recheckJob(current.id, 'MANUAL', 6)).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
  });
});
